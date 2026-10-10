import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";

/** Mirrors `DemoInfo` in src-tauri/src/lib.rs. */
type DemoInfo = {
  productName: string;
  version: string;
  updaterTarget: string | null;
  bundleType: string | null;
  canInstall: boolean;
  endpoints: string[];
  autoUpdate: boolean;
  debugBuild: boolean;
  logFile: string | null;
};

type Phase =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "downloaded"
  | "installing"
  | "installed"
  | "error";

type Tone = "muted" | "busy" | "ok" | "error";

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`#${id} is missing from index.html`);
  return node as T;
}

const ui = {
  version: byId("version"),
  productName: byId("product-name"),
  installWarning: byId("install-warning"),
  autoBanner: byId("auto-banner"),
  status: byId("status"),
  check: byId<HTMLButtonElement>("btn-check"),
  download: byId<HTMLButtonElement>("btn-download"),
  install: byId<HTMLButtonElement>("btn-install"),
  restart: byId<HTMLButtonElement>("btn-restart"),
  progress: byId("progress"),
  progressBar: byId("progress-bar"),
  progressLabel: byId("progress-label"),
  details: byId("update-details"),
  newVersion: byId("new-version"),
  newDate: byId("new-date"),
  notes: byId("notes"),
  factTarget: byId("fact-target"),
  factBundle: byId("fact-bundle"),
  factProfile: byId("fact-profile"),
  factEndpoints: byId("fact-endpoints"),
  factLog: byId("fact-log"),
  log: byId<HTMLOListElement>("log"),
  clear: byId<HTMLButtonElement>("btn-clear"),
};

let info: DemoInfo | null = null;
/** The update returned by `check()`; it holds a Rust-side resource until closed or installed. */
let pending: Update | null = null;

// ---------------------------------------------------------------------------
// Logging: shown in the UI and appended to a file via the `append_log` command
// ---------------------------------------------------------------------------

function log(message: string, level: "info" | "ok" | "error" = "info") {
  const now = new Date();
  const item = document.createElement("li");
  item.dataset.level = level;
  const time = document.createElement("time");
  time.textContent = now.toLocaleTimeString();
  const text = document.createElement("span");
  text.textContent = message;
  item.append(time, text);
  ui.log.append(item);
  ui.log.scrollTop = ui.log.scrollHeight;

  const line = `${now.toISOString()} [v${info?.version ?? "?"}] ${level.toUpperCase()} ${message}`;
  invoke("append_log", { line }).catch(() => {
    /* logging must never break the update flow */
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// UI state
// ---------------------------------------------------------------------------

function setPhase(next: Phase, message?: string) {
  const defaults: Record<Phase, [string, Tone]> = {
    idle: ["Idle. Click Check to query the update endpoint.", "muted"],
    checking: ["Checking for updates…", "busy"],
    "up-to-date": [`You are on the latest version (${info?.version}).`, "ok"],
    available: [
      info?.canInstall
        ? `Version ${pending?.version} is available.`
        : `Version ${pending?.version} is available (install is disabled for unbundled builds).`,
      "ok",
    ],
    downloading: ["Downloading…", "busy"],
    downloaded: ["Downloaded and signature verified. Ready to install.", "ok"],
    installing: ["Installing…", "busy"],
    installed: ["Installed. Restart to run the new version.", "ok"],
    error: ["Something went wrong.", "error"],
  };
  const [text, tone] = defaults[next];
  ui.status.textContent = message ?? text;
  ui.status.dataset.tone = tone;

  const busy = next === "checking" || next === "downloading" || next === "installing";
  ui.check.disabled = busy || next === "installed";
  ui.download.disabled = !(next === "available" && info?.canInstall);
  ui.install.disabled = next !== "downloaded";
  ui.restart.disabled = next !== "installed";
}

function fail(prefix: string, err: unknown) {
  const message = `${prefix}: ${errorMessage(err)}`;
  setPhase("error", message);
  log(message, "error");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function showProgress(received: number, total?: number) {
  ui.progress.hidden = false;
  const pct = total ? Math.min(100, (received / total) * 100) : 0;
  ui.progressBar.style.width = total ? `${pct.toFixed(1)}%` : "100%";
  ui.progressBar.classList.toggle("indeterminate", !total);
  ui.progressLabel.textContent = total
    ? `${formatBytes(received)} / ${formatBytes(total)} (${pct.toFixed(0)}%)`
    : formatBytes(received);
}

function showUpdateDetails(update: Update | null) {
  ui.details.hidden = !update;
  if (!update) return;
  ui.newVersion.textContent = update.version;
  const date = update.date ? new Date(update.date) : null;
  ui.newDate.textContent = date && !Number.isNaN(date.getTime()) ? date.toLocaleString() : (update.date ?? "");
  ui.notes.textContent = update.body?.trim() || "(no release notes)";
}

/** Give every version a distinct accent color so an update is obvious at a glance. */
function applyVersionColor(version: string) {
  const n = version
    .split(/[.+-]/)
    .map((part) => Number.parseInt(part, 10) || 0)
    .reduce((acc, part) => acc * 31 + part, 0);
  const hue = (n * 137.508) % 360; // golden angle: neighbouring versions get far-apart hues
  document.documentElement.style.setProperty("--accent-h", hue.toFixed(0));
}

// ---------------------------------------------------------------------------
// Updater flow: check -> download -> install -> relaunch
// ---------------------------------------------------------------------------

async function checkForUpdate(): Promise<Update | null> {
  setPhase("checking");
  ui.progress.hidden = true;
  log(`Checking ${info?.endpoints.join(", ") || "(no endpoints configured)"}`);
  try {
    if (pending) {
      await pending.close();
      pending = null;
    }
    const update = await check({ timeout: 30_000 });
    pending = update;
    showUpdateDetails(update);
    if (!update) {
      setPhase("up-to-date");
      log(`No update available; ${info?.version} is current`, "ok");
      return null;
    }
    setPhase("available");
    log(`Update available: ${update.currentVersion} -> ${update.version}`, "ok");
    return update;
  } catch (err) {
    // reqwest reports "error sending request for url (...)" without the underlying cause
    // (usually "connection refused"), so say what it most likely means.
    const unreachable = errorMessage(err).includes("error sending request");
    const local = info?.endpoints.some((endpoint) => endpoint.includes("localhost"));
    const hint = !unreachable
      ? ""
      : local
        ? " (could not connect: is the local update server running? Start it with `npm run local:serve`)"
        : " (could not connect to the update endpoint)";
    fail("Check failed", `${errorMessage(err)}${hint}`);
    return null;
  }
}

async function downloadUpdate(): Promise<boolean> {
  const update = pending;
  if (!update) return false;
  setPhase("downloading");
  showProgress(0);

  let total: number | undefined;
  let received = 0;
  let nextMilestone = 25;
  try {
    // The plugin verifies the signature (and, with `requireSignedVersion`, the signed
    // version) once all bytes have arrived, so a resolved promise means it passed.
    await update.download((event: DownloadEvent) => {
      switch (event.event) {
        case "Started":
          total = event.data.contentLength;
          log(`Download started (${total ? formatBytes(total) : "unknown size"})`);
          break;
        case "Progress":
          received += event.data.chunkLength;
          showProgress(received, total);
          if (total) {
            while (nextMilestone < 100 && (received / total) * 100 >= nextMilestone) {
              log(`Downloaded ${nextMilestone}%`);
              nextMilestone += 25;
            }
          }
          break;
        case "Finished":
          log(`Download finished (${formatBytes(received)}), verifying signature`);
          break;
      }
    });
    setPhase("downloaded");
    log("Signature verified with the configured public key", "ok");
    return true;
  } catch (err) {
    fail("Download failed", err);
    return false;
  }
}

async function installUpdate(): Promise<boolean> {
  const update = pending;
  if (!update) return false;
  setPhase("installing");
  if (info?.updaterTarget?.startsWith("windows")) {
    log("Installing: Windows closes the app now and the installer restarts it");
  } else {
    log("Installing: replacing the installed bundle");
  }
  try {
    await update.install();
    pending = null;
    setPhase("installed");
    log(`Installed ${update.version}`, "ok");
    return true;
  } catch (err) {
    fail("Install failed", err);
    return false;
  }
}

async function restartApp() {
  log("Relaunching");
  try {
    await relaunch();
  } catch (err) {
    fail("Relaunch failed", err);
  }
}

async function runAutoUpdate() {
  log("Auto-update mode: check -> download -> install -> relaunch");
  const update = await checkForUpdate();
  if (!update) return;
  if (!info?.canInstall) {
    log("Not running from an installed bundle; stopping before download", "error");
    return;
  }
  if (!(await downloadUpdate())) return;
  if (!(await installUpdate())) return;
  await new Promise((resolve) => setTimeout(resolve, 500));
  await restartApp();
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

function renderInfo(demo: DemoInfo) {
  document.title = `${demo.productName} ${demo.version}`;
  ui.version.textContent = `v${demo.version}`;
  ui.productName.textContent = demo.productName;
  applyVersionColor(demo.version);

  ui.factTarget.textContent = demo.updaterTarget ?? "unsupported platform";
  ui.factBundle.textContent = demo.bundleType
    ? `${demo.bundleType}${demo.canInstall ? "" : " (not installed)"}`
    : "none (unbundled binary)";
  ui.factProfile.textContent = demo.debugBuild ? "debug" : "release";
  ui.factEndpoints.replaceChildren(
    ...demo.endpoints.map((endpoint) => {
      const code = document.createElement("code");
      code.textContent = endpoint;
      return code;
    }),
  );
  if (demo.endpoints.length === 0) ui.factEndpoints.textContent = "(none)";
  ui.factLog.textContent = demo.logFile ?? "(unavailable)";

  ui.installWarning.hidden = demo.canInstall;
  ui.autoBanner.hidden = !demo.autoUpdate;
}

async function init() {
  ui.check.addEventListener("click", () => void checkForUpdate());
  ui.download.addEventListener("click", () => void downloadUpdate());
  ui.install.addEventListener("click", () => void installUpdate());
  ui.restart.addEventListener("click", () => void restartApp());
  ui.clear.addEventListener("click", () => ui.log.replaceChildren());

  info = await invoke<DemoInfo>("demo_info");
  renderInfo(info);
  setPhase("idle");
  log(
    `Started ${info.productName} v${info.version} ` +
      `(target ${info.updaterTarget ?? "?"}, bundle ${info.bundleType ?? "none"}, ` +
      `${info.debugBuild ? "debug" : "release"}, ` +
      `${info.canInstall ? "installable" : "not installable: running outside an installed bundle"})`,
  );

  if (info.autoUpdate) await runAutoUpdate();
}

window.addEventListener("DOMContentLoaded", () => {
  init().catch((err) => fail("Startup failed", err));
});

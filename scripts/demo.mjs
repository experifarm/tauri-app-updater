#!/usr/bin/env node
/**
 * Helper commands for the Tauri updater demo.
 *
 *   node scripts/demo.mjs <command> [options]     (or the npm scripts in package.json)
 *
 * Run `node scripts/demo.mjs help` for the list of commands. No dependencies beyond Node 18+.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TAURI_DIR = path.join(ROOT, "src-tauri");
const CONF_PATH = path.join(TAURI_DIR, "tauri.conf.json");
const LOCAL_CONF_PATH = path.join(TAURI_DIR, "tauri.local.conf.json");
const CARGO_TOML = path.join(TAURI_DIR, "Cargo.toml");
const PACKAGE_JSON = path.join(ROOT, "package.json");
const PACKAGE_LOCK = path.join(ROOT, "package-lock.json");
const BUNDLE_DIR = path.join(TAURI_DIR, "target", "release", "bundle");
const TAURI_CLI = path.join(ROOT, "node_modules", "@tauri-apps", "cli", "tauri.js");

const LOCAL_DIR = path.join(ROOT, ".local");
const SERVER_DIR = path.join(LOCAL_DIR, "update-server");
const INSTALL_DIR = path.join(LOCAL_DIR, "installed");
const E2E_DIR = path.join(LOCAL_DIR, "e2e");

const DEFAULT_KEY = path.join(os.homedir(), ".tauri", "tauri-app-updater.key");
/** Must match the endpoint in src-tauri/tauri.local.conf.json. */
const PORT = 8787;
const PUBKEY_PLACEHOLDER = "REPLACE_ME";

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

const color = (code) => (text) => (process.stdout.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text);
const bold = color("1");
const green = color("32");
const red = color("31");
const yellow = color("33");
const dim = color("2");

const step = (msg) => console.log(`\n${bold("==>")} ${bold(msg)}`);
const note = (msg) => console.log(`    ${msg}`);
const warn = (msg) => console.log(`${yellow("warning:")} ${msg}`);

function die(msg) {
  console.error(`${red("error:")} ${msg}`);
  process.exit(1);
}

const rel = (p) => path.relative(process.cwd(), p) || ".";
const tilde = (p) => (p.startsWith(os.homedir() + path.sep) ? `~${p.slice(os.homedir().length)}` : p);
const expandHome = (p) => (p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p);
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const writeJson = (file, data) => fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
const readConf = () => readJson(CONF_PATH);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const [key, inline] = arg.slice(2).split("=", 2);
    if (inline !== undefined) options[key] = inline;
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) options[key] = argv[++i];
    else options[key] = true;
  }
  return { positional, options };
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit", ...opts });
  if (result.error) die(`failed to run ${cmd}: ${result.error.message}`);
  if (result.status !== 0) die(`${cmd} ${args.join(" ")} exited with code ${result.status}`);
  return result;
}

function tauri(args, env = process.env) {
  if (!fs.existsSync(TAURI_CLI)) die("Tauri CLI not found. Run `npm install` first.");
  return run(process.execPath, [TAURI_CLI, ...args], { env });
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function assertSemver(version) {
  if (!version || !SEMVER.test(version)) die(`"${version ?? ""}" is not a valid semver version (e.g. 0.2.0)`);
}

function bumpPatch(version) {
  const [major, minor, patch] = version.split(/[.+-]/).map((n) => Number.parseInt(n, 10));
  return `${major}.${minor}.${patch + 1}`;
}

/** The `{os}` part of the updater target: linux, darwin or windows. */
function updaterOs() {
  return { darwin: "darwin", win32: "windows", linux: "linux" }[process.platform] ?? die(`unsupported OS ${process.platform}`);
}

/** The `{arch}` part of the updater target. */
function updaterArch() {
  return { x64: "x86_64", arm64: "aarch64", ia32: "i686", arm: "armv7" }[process.arch] ?? die(`unsupported arch ${process.arch}`);
}

/** Bundle to build locally, and how the updater calls that installer. */
function localBundle() {
  switch (process.platform) {
    case "darwin":
      return { bundle: "app", dir: "macos", suffix: ".app.tar.gz", installer: "app" };
    case "win32":
      return { bundle: "nsis", dir: "nsis", suffix: "-setup.exe", installer: "nsis" };
    default:
      return { bundle: "appimage", dir: "appimage", suffix: ".AppImage", installer: "appimage" };
  }
}

/**
 * Reads the version that the Tauri CLI records in a signature's trusted comment
 * (`timestamp:...\tfile:...\tversion:1.2.3`). `requireSignedVersion` compares it
 * with the version announced in latest.json.
 */
function signedVersion(signatureBase64) {
  const text = Buffer.from(signatureBase64.trim(), "base64").toString("utf8");
  const trusted = text.split("\n").find((line) => line.startsWith("trusted comment:"));
  if (!trusted) return undefined;
  return trusted
    .slice("trusted comment:".length)
    .trim()
    .split("\t")
    .find((field) => field.startsWith("version:"))
    ?.slice("version:".length);
}

function plistVersion(plistPath) {
  if (!fs.existsSync(plistPath)) return undefined;
  const result = spawnSync("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", plistPath], {
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

// ---------------------------------------------------------------------------
// Keys and configuration
// ---------------------------------------------------------------------------

function setPubkey(pubFile) {
  if (!fs.existsSync(pubFile)) die(`public key not found: ${pubFile}`);
  const pubkey = fs.readFileSync(pubFile, "utf8").trim();
  const conf = readConf();
  conf.plugins ??= {};
  conf.plugins.updater ??= {};
  const changed = conf.plugins.updater.pubkey !== pubkey;
  conf.plugins.updater.pubkey = pubkey;
  writeJson(CONF_PATH, conf);
  note(`${changed ? "Wrote" : "Kept"} plugins.updater.pubkey in ${rel(CONF_PATH)} (from ${pubFile})`);
}

function cmdKeys({ options }) {
  const keyPath = path.resolve(expandHome(String(options.path ?? DEFAULT_KEY)));
  step("Signing key pair");
  if (fs.existsSync(keyPath) && !options.force) {
    note(`Private key already exists at ${keyPath}; reusing it (pass --force to replace it).`);
  } else {
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    const args = ["signer", "generate", "--write-keys", keyPath];
    if (options.force) args.push("--force");
    if (options["no-password"]) args.push("--ci");
    tauri(args);
  }

  step("Public key -> tauri.conf.json");
  setPubkey(`${keyPath}.pub`);

  step("Next steps");
  console.log(`
  ${bold("Back up")} ${keyPath} (and its password) somewhere safe. Without it you can never
  ship another update to installed copies of the app.

  Local builds pick up ${tilde(DEFAULT_KEY)} automatically. Otherwise export:

    export TAURI_SIGNING_PRIVATE_KEY="${keyPath}"     # path or key content
    export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="..."   # empty if no password

  For GitHub Actions, store the key as repository secrets:

    gh secret set TAURI_SIGNING_PRIVATE_KEY < "${keyPath}"
    gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD   # prompts; skip if no password

  Commit the updated src-tauri/tauri.conf.json (the public key is safe to share).`);
}

function cmdPubkey({ positional }) {
  step("Public key -> tauri.conf.json");
  setPubkey(path.resolve(expandHome(positional[0] ?? `${DEFAULT_KEY}.pub`)));
}

function cmdSetVersion({ positional }) {
  const version = positional[0];
  assertSemver(version);
  step(`Set app version to ${version}`);

  const conf = readConf();
  conf.version = version;
  writeJson(CONF_PATH, conf);
  note(rel(CONF_PATH));

  const pkg = readJson(PACKAGE_JSON);
  pkg.version = version;
  writeJson(PACKAGE_JSON, pkg);
  note(rel(PACKAGE_JSON));

  if (fs.existsSync(PACKAGE_LOCK)) {
    const lock = readJson(PACKAGE_LOCK);
    lock.version = version;
    if (lock.packages?.[""]) lock.packages[""].version = version;
    writeJson(PACKAGE_LOCK, lock);
    note(rel(PACKAGE_LOCK));
  }

  // Only the first `version = ...` line, which belongs to [package].
  const toml = fs.readFileSync(CARGO_TOML, "utf8");
  fs.writeFileSync(CARGO_TOML, toml.replace(/^version = "[^"]*"/m, `version = "${version}"`));
  note(rel(CARGO_TOML));
}

function cmdSetRepo({ positional }) {
  const repo = positional[0];
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) die("usage: set-repo <owner>/<repo>");
  const endpoint = `https://github.com/${repo}/releases/latest/download/latest.json`;
  const conf = readConf();
  conf.plugins.updater.endpoints = [endpoint];
  writeJson(CONF_PATH, conf);
  step("Production update endpoint");
  note(`${endpoint}\n    written to ${rel(CONF_PATH)}`);
}

/** Environment for `tauri build`, falling back to the default key file. */
function signingEnv() {
  const env = { ...process.env };
  if (!env.TAURI_SIGNING_PRIVATE_KEY) {
    if (!fs.existsSync(DEFAULT_KEY)) {
      die(`No signing key. Run \`npm run keys\` first, or export TAURI_SIGNING_PRIVATE_KEY.`);
    }
    env.TAURI_SIGNING_PRIVATE_KEY = DEFAULT_KEY;
    note(dim(`TAURI_SIGNING_PRIVATE_KEY not set; using ${DEFAULT_KEY}`));
  }
  if (env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD === undefined) {
    // `tauri signer sign` was observed to assume an empty password here (no prompt) and to
    // fail with "incorrect updater private key password" when the key has one.
    note(dim("TAURI_SIGNING_PRIVATE_KEY_PASSWORD not set; assuming the key has no password"));
  }
  return env;
}

/** Fails early on the two most common updater misconfigurations. */
function checkPubkey(env) {
  const pubkey = readConf().plugins?.updater?.pubkey ?? "";
  if (!pubkey || pubkey.startsWith(PUBKEY_PLACEHOLDER)) {
    die(`plugins.updater.pubkey in ${rel(CONF_PATH)} is not set. Run \`npm run keys\` first.`);
  }
  const keyFile = env.TAURI_SIGNING_PRIVATE_KEY;
  const pubFile = keyFile && fs.existsSync(`${keyFile}.pub`) ? `${keyFile}.pub` : undefined;
  if (pubFile && fs.readFileSync(pubFile, "utf8").trim() !== pubkey) {
    die(
      `the public key in ${rel(CONF_PATH)} does not belong to ${keyFile}.\n` +
        `       Updates signed with it would be rejected. Run \`npm run keys\` to sync it.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Local update server workflow
// ---------------------------------------------------------------------------

/**
 * Cargo caches build-script output that contains absolute paths (Tauri records where its
 * permission files live), and does not rerun those scripts when the project moves. A
 * `src-tauri/target` carried over from another location then fails with
 * "failed to read plugin permissions ... No such file or directory".
 */
function checkTargetDir() {
  for (const profile of ["release", "debug"]) {
    const buildDir = path.join(TAURI_DIR, "target", profile, "build");
    if (!fs.existsSync(buildDir)) continue;
    const outputs = fs
      .readdirSync(buildDir)
      .filter((name) => name === "tauri" || name.startsWith("tauri-"))
      .flatMap((name) => {
        const dir = path.join(buildDir, name);
        // build/tauri-<hash>/output (stable Cargo) or build/tauri/<hash>/run/stdout (newer layout)
        return [path.join(dir, "output"), ...fs.readdirSync(dir).map((hash) => path.join(dir, hash, "run", "stdout"))];
      })
      .filter((file) => fs.existsSync(file));

    for (const file of outputs) {
      const recorded = fs.readFileSync(file, "utf8").match(/=(\/\S+?)\/target\/(?:debug|release)\/build\//)?.[1];
      if (!recorded) continue;
      const stale = !fs.existsSync(recorded) || fs.realpathSync(recorded) !== fs.realpathSync(TAURI_DIR);
      if (stale) {
        die(
          `src-tauri/target was built when the project lived at ${path.dirname(recorded)}.\n` +
            `       Cargo caches absolute paths there, so this build would fail. Clear it once:\n\n` +
            `         (cd src-tauri && cargo clean)`,
        );
      }
    }
  }
}

function build({ version, env }) {
  checkTargetDir();
  const { bundle } = localBundle();
  const args = ["build", "--bundles", bundle, "--config", LOCAL_CONF_PATH];
  // An inline JSON config overrides the version without editing any file.
  if (version) args.push("--config", JSON.stringify({ version }));
  tauri(args, env);
}

function cmdBuild({ options }) {
  if (options.version) assertSemver(options.version);
  const env = signingEnv();
  checkPubkey(env);
  const version = options.version ?? readConf().version;
  step(`Build ${version} against the local update server (${localBundle().bundle} bundle)`);
  build({ version: options.version, env });
  step("Built");
  note(`Updater artifacts are in ${rel(path.join(BUNDLE_DIR, localBundle().dir))}`);
}

function builtAppBundle() {
  const app = path.join(BUNDLE_DIR, "macos", `${readConf().productName}.app`);
  if (!fs.existsSync(app)) die(`${rel(app)} not found. Run \`npm run local:build\` first.`);
  return app;
}

function installTo(destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  if (process.platform === "darwin") {
    const src = builtAppBundle();
    const dest = path.join(destDir, path.basename(src));
    fs.rmSync(dest, { recursive: true, force: true });
    run("/usr/bin/ditto", [src, dest]); // preserves the code signature and permissions
    return dest;
  }
  if (process.platform === "linux") {
    const { file } = findUpdaterArtifact();
    const dest = path.join(destDir, path.basename(file));
    fs.copyFileSync(file, dest);
    fs.chmodSync(dest, 0o755);
    return dest;
  }
  return undefined;
}

function cmdInstall() {
  step("Install the built app into .local/installed");
  if (process.platform === "win32") {
    const { file } = findUpdaterArtifact();
    note(`On Windows, run the installer instead:\n\n      "${file}"\n`);
    note("Install it before building the newer version, which overwrites this file.");
    return;
  }
  const dest = installTo(INSTALL_DIR);
  const version = process.platform === "darwin" ? plistVersion(path.join(dest, "Contents", "Info.plist")) : undefined;
  note(`Installed ${version ? `v${version} ` : ""}at ${rel(dest)}`);
  note(`Launch it with:  ${process.platform === "darwin" ? `open "${rel(dest)}"` : `"${rel(dest)}"`}`);
}

/** Newest updater artifact that has a signature next to it. */
function findUpdaterArtifact() {
  const { dir, suffix, installer } = localBundle();
  const bundleDir = path.join(BUNDLE_DIR, dir);
  const candidates = fs.existsSync(bundleDir)
    ? fs
        .readdirSync(bundleDir)
        .filter((name) => name.endsWith(suffix) && fs.existsSync(path.join(bundleDir, `${name}.sig`)))
        .map((name) => path.join(bundleDir, name))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
    : [];
  if (candidates.length === 0) {
    die(`no signed *${suffix} in ${rel(bundleDir)}. Run \`npm run local:build\` first.`);
  }
  return { file: candidates[0], sig: `${candidates[0]}.sig`, installer };
}

function publish({ notes } = {}) {
  const { file, sig, installer } = findUpdaterArtifact();
  const signature = fs.readFileSync(sig, "utf8").trim();
  const version = signedVersion(signature) ?? readConf().version;

  const fileName = path.basename(file);
  const destDir = path.join(SERVER_DIR, `v${version}`);
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(file, path.join(destDir, fileName));

  const url = `http://localhost:${PORT}/v${version}/${encodeURIComponent(fileName)}`;
  const target = `${updaterOs()}-${updaterArch()}`;
  const manifestPath = path.join(SERVER_DIR, "latest.json");
  const previous = fs.existsSync(manifestPath) ? readJson(manifestPath) : undefined;

  // Same shape that tauri-action uploads to GitHub Releases.
  const manifest = {
    version,
    notes: notes ?? `Local test release ${version}`,
    pub_date: new Date().toISOString(),
    platforms: previous?.version === version ? previous.platforms : {},
  };
  manifest.platforms[target] = { signature, url };
  manifest.platforms[`${target}-${installer}`] = { signature, url };
  writeJson(manifestPath, manifest);
  return { version, url, manifestPath, target };
}

function cmdPublish({ options }) {
  step("Publish the built update to the local update server");
  const { version, url, manifestPath, target } = publish({ notes: options.notes });
  note(`version   ${version}`);
  note(`platform  ${target}`);
  note(`artifact  ${url}`);
  note(`manifest  ${rel(manifestPath)}`);
  note(`\nServe it with:  npm run local:serve`);
}

const CONTENT_TYPES = { ".json": "application/json", ".gz": "application/gzip" };

/**
 * Static file server for .local/update-server. Answers `204 No Content` when no
 * latest.json has been published yet, the way a dynamic update server signals
 * "no update".
 */
function startServer({ onRequest, quiet = false } = {}) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    const pathname = decodeURIComponent(url.pathname);
    const file = path.resolve(SERVER_DIR, `.${pathname}`);
    const query = Object.fromEntries(url.searchParams);
    let status = 200;
    let bytes = 0;

    if (!file.startsWith(SERVER_DIR + path.sep)) {
      status = 403;
    } else if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      status = pathname === "/latest.json" ? 204 : 404;
    }

    if (status === 200) {
      bytes = fs.statSync(file).size;
      res.writeHead(200, {
        "Content-Type": CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream",
        "Content-Length": bytes,
        "Cache-Control": "no-store",
      });
      fs.createReadStream(file).pipe(res);
    } else {
      res.writeHead(status).end();
    }

    if (!quiet) {
      const who = query.current_version ? dim(`  <- app v${query.current_version} (${query.target}-${query.arch})`) : "";
      const tone = status < 300 ? green : red;
      console.log(
        `${dim(new Date().toLocaleTimeString())} ${req.method} ${pathname}${who}  ${tone(String(status))}` +
          (bytes ? dim(` ${bytes} bytes`) : ""),
      );
    }
    onRequest?.({ method: req.method, path: pathname, query, status });
  });

  return new Promise((resolve, reject) => {
    server.once("error", (err) =>
      reject(err.code === "EADDRINUSE" ? new Error(`port ${PORT} is already in use (is local:serve running?)`) : err),
    );
    server.listen(PORT, "127.0.0.1", () => resolve(server));
  });
}

async function cmdServe() {
  fs.mkdirSync(SERVER_DIR, { recursive: true });
  const manifestPath = path.join(SERVER_DIR, "latest.json");
  const server = await startServer().catch((err) => die(err.message));
  step(`Update server on http://localhost:${PORT}  (Ctrl+C to stop)`);
  note(`serving ${rel(SERVER_DIR)}`);
  if (fs.existsSync(manifestPath)) {
    const manifest = readJson(manifestPath);
    note(`latest.json announces v${manifest.version} for ${Object.keys(manifest.platforms).join(", ")}`);
  } else {
    note("no latest.json yet: answering 204 No Content (no update)");
  }
  console.log();
  process.on("SIGINT", () => server.close(() => process.exit(0)));
}

// ---------------------------------------------------------------------------
// End-to-end verification (macOS)
// ---------------------------------------------------------------------------

async function cmdE2E({ options }) {
  if (process.platform !== "darwin") {
    die("e2e is automated for macOS only. Use the manual steps in README.md on other platforms.");
  }
  const conf = readConf();
  const from = String(options.from ?? conf.version);
  const to = String(options.to ?? bumpPatch(from));
  const timeoutSec = Number(options.timeout ?? 120);
  assertSemver(from);
  assertSemver(to);

  const env = signingEnv();
  checkPubkey(env);

  const app = path.join(E2E_DIR, `${conf.productName}.app`);
  const plist = path.join(app, "Contents", "Info.plist");
  const appProcess = `${app}/Contents/MacOS/`;
  const logFile = path.join(os.homedir(), "Library", "Logs", conf.identifier, "updater-demo.log");

  console.log(bold(`Updater end-to-end test: ${from} -> ${to}`));

  step(`1/5 Build v${from} (the "installed" version)`);
  build({ version: from, env });

  step(`2/5 Install v${from} to ${rel(app)}`);
  spawnSync("/usr/bin/pkill", ["-f", appProcess]);
  installTo(E2E_DIR);
  if (plistVersion(plist) !== from) die(`installed bundle does not report v${from}`);
  note(`installed bundle reports v${plistVersion(plist)}`);

  step(`3/5 Build v${to} (the update)`);
  build({ version: to, env });

  step(`4/5 Publish v${to} to the local update server`);
  const published = publish({ notes: `End-to-end test release ${to}` });
  note(`latest.json -> v${published.version} (${published.target})`);
  if (published.version !== to) die(`published v${published.version}, expected v${to}`);

  step(`5/5 Launch v${from} with --auto-update and watch the update happen`);
  const requests = [];
  const server = await startServer({ onRequest: (r) => requests.push(r) }).catch((err) => die(err.message));
  const logOffset = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0;

  const checks = [
    {
      label: `v${from} requested latest.json`,
      done: () => requests.some((r) => r.path === "/latest.json" && r.query.current_version === from),
    },
    {
      label: `v${from} downloaded the v${to} bundle`,
      done: () => requests.some((r) => r.path.startsWith(`/v${to}/`) && r.status === 200),
    },
    {
      label: `bundle on disk now reports v${to}`,
      done: () => plistVersion(plist) === to,
    },
    {
      label: `relaunched app (v${to}) checked again and found no newer version`,
      done: () => requests.some((r) => r.path === "/latest.json" && r.query.current_version === to),
    },
  ];

  run("/usr/bin/open", ["-n", app, "--args", "--auto-update"]);

  const passed = new Set();
  const deadline = Date.now() + timeoutSec * 1000;
  while (passed.size < checks.length && Date.now() < deadline) {
    for (const [i, check] of checks.entries()) {
      if (!passed.has(i) && check.done()) {
        passed.add(i);
        console.log(`    ${green("✓")} ${check.label}`);
      }
    }
    await sleep(500);
  }
  // Give the relaunched app a moment to write its log lines.
  await sleep(1500);

  spawnSync("/usr/bin/pkill", ["-f", appProcess]);
  await new Promise((resolve) => server.close(resolve));

  for (const [i, check] of checks.entries()) {
    if (!passed.has(i)) console.log(`    ${red("✗")} ${check.label}`);
  }

  if (fs.existsSync(logFile)) {
    const appLog = fs.readFileSync(logFile, "utf8").slice(logOffset).trim();
    step(`App log (${logFile})`);
    console.log(appLog ? appLog.replace(/^/gm, "    ") : "    (empty)");
  }

  if (passed.size === checks.length) {
    console.log(`\n${green(bold("PASS"))} the updater moved ${rel(app)} from v${from} to v${to} and relaunched it.`);
  } else {
    console.log(`\n${red(bold("FAIL"))} ${checks.length - passed.size} check(s) did not pass within ${timeoutSec}s.`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------

const HELP = `Tauri updater demo helpers

Keys and configuration
  keys [--path FILE] [--force] [--no-password]
                         Generate the updater key pair (default ${tilde(DEFAULT_KEY)})
                         and write the public key into tauri.conf.json.
  pubkey [FILE.pub]      Write an existing public key into tauri.conf.json.
  set-version X.Y.Z      Set the version in tauri.conf.json, package.json and Cargo.toml.
  set-repo OWNER/REPO    Point the production endpoint at GitHub Releases of OWNER/REPO.

Local update server (endpoint http://localhost:${PORT}, see src-tauri/tauri.local.conf.json)
  build [--version X]    Build a signed bundle that checks the local server.
  install                Copy the built app into .local/installed (macOS/Linux).
  publish [--notes TXT]  Copy the built update + write latest.json into .local/update-server.
  serve                  Serve .local/update-server on port ${PORT}.
  e2e [--from X] [--to Y] [--timeout SEC]
                         macOS: build, install, publish, launch and verify an update end to end.
`;

const commands = {
  keys: cmdKeys,
  pubkey: cmdPubkey,
  "set-version": cmdSetVersion,
  "set-repo": cmdSetRepo,
  build: cmdBuild,
  install: cmdInstall,
  publish: cmdPublish,
  serve: cmdServe,
  e2e: cmdE2E,
};

const [command, ...rest] = process.argv.slice(2);
const handler = commands[command];
if (!handler) {
  console.log(HELP);
  process.exit(command && command !== "help" ? 1 : 0);
}
await handler(parseArgs(rest));

use std::io::Write;

use serde::Serialize;
use tauri::{AppHandle, Manager};

/// What the demo UI shows about the running build, so you can tell at a glance
/// which version is running and which update endpoint it was compiled with.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DemoInfo {
    product_name: String,
    version: String,
    /// `{os}-{arch}` key the updater looks up in `latest.json`, e.g. `darwin-aarch64`.
    updater_target: Option<String>,
    /// Bundle the running binary was packaged as (`app`, `nsis`, `msi`, `appimage`, ...).
    bundle_type: Option<String>,
    /// `true` when the binary runs from an installed bundle the updater can replace.
    can_install: bool,
    /// Update endpoints compiled into this build (tauri.conf.json + any `--config` overrides).
    endpoints: Vec<String>,
    /// Launched with `--auto-update`: check, download, install and relaunch without clicks.
    /// The flag survives the relaunch, which the scripted end-to-end test relies on.
    auto_update: bool,
    debug_build: bool,
    /// File that `append_log` writes to.
    log_file: Option<String>,
}

#[tauri::command]
fn demo_info(app: AppHandle) -> DemoInfo {
    let endpoints = app
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|updater| updater.get("endpoints"))
        .and_then(|endpoints| endpoints.as_array())
        .map(|endpoints| {
            endpoints
                .iter()
                .filter_map(|e| e.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();

    #[cfg(desktop)]
    let updater_target = tauri_plugin_updater::target();
    #[cfg(not(desktop))]
    let updater_target = None;

    DemoInfo {
        product_name: app.package_info().name.clone(),
        version: app.package_info().version.to_string(),
        updater_target,
        bundle_type: tauri::utils::platform::bundle_type().map(|b| b.to_string()),
        can_install: can_install(),
        endpoints,
        auto_update: std::env::args().any(|arg| arg == "--auto-update"),
        debug_build: cfg!(debug_assertions),
        log_file: log_file(&app).map(|p| p.display().to_string()),
    }
}

/// Whether installing an update is safe for the running binary.
///
/// Under `tauri dev` the binary lives in `src-tauri/target/debug/`. On macOS the
/// updater derives the install location from the executable path, so installing
/// from there would swap out the whole `target/debug` directory. `bundle_type()`
/// cannot detect this on macOS (it always reports `app`), so check the path.
fn can_install() -> bool {
    #[cfg(target_os = "macos")]
    {
        std::env::current_exe()
            .map(|exe| exe.to_string_lossy().contains(".app/Contents/MacOS/"))
            .unwrap_or(false)
    }
    #[cfg(not(target_os = "macos"))]
    {
        tauri::utils::platform::bundle_type().is_some()
    }
}

fn log_file(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_log_dir()
        .ok()
        .map(|dir| dir.join("updater-demo.log"))
}

/// Persists a UI log line so update runs can be inspected after a relaunch
/// (or by the end-to-end script, which cannot see the window).
#[tauri::command]
fn append_log(app: AppHandle, line: String) -> Result<(), String> {
    eprintln!("{line}");
    let path = log_file(&app).ok_or("no log directory")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    writeln!(file, "{line}").map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Provides `relaunch()` to the frontend, used after installing an update.
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // Endpoints, pubkey and Windows install mode come from `plugins.updater`
            // in tauri.conf.json.
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![demo_info, append_log])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

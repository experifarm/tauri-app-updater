# Manual verification: update v0.1.0 → v0.2.0 locally

A step-by-step check that the Tauri updater can take an installed copy of the app from v0.1.0 to
v0.2.0 through the UI, using the local update server on `http://localhost:8787`. The commands are
for macOS. Run them from the project root, after `npm install` and `npm run keys`.

You need two terminals: **A** for builds, **B** for the update server.

## 1. Run the steps

### Step 1: Signing password (terminal A)

```sh
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD='...'
```

Skip this step when using the demo key committed in `.tauri/`. That is the default when
`~/.tauri/tauri-app-updater.key` doesn't exist, and the scripts read its password from
`.tauri/tauri-app-updater.key.pass`. With your own key, export its password: the CLI doesn't
prompt for it.

### Step 2: Build the old version (terminal A)

```sh
npm run local:build -- --version 0.1.0
```

Expected: the output ends with `==> Built` and `Updater artifacts are in src-tauri/target/release/bundle/macos`.

### Step 3: Install the old version (terminal A)

```sh
npm run local:install                    # copies it to .local/installed/
```

Expected: `Installed v0.1.0 at .local/installed/Tauri Updater Demo.app`.

Do this before step 4. The next build overwrites the bundle under `src-tauri/target/`.

### Step 4: Build the new version (terminal A)

```sh
npm run local:build -- --version 0.2.0
```

Expected: `==> Built` again. `--version` only applies to this build, and no files change.

### Step 5: Publish the new version to the local server (terminal A)

```sh
npm run local:publish
```

Expected:

```text
    version   0.2.0
    platform  darwin-aarch64
    artifact  http://localhost:8787/v0.2.0/Tauri%20Updater%20Demo.app.tar.gz
    manifest  .local/update-server/latest.json
```

### Step 6: Start the update server (terminal B)

```sh
npm run local:serve                      # leave running in a second terminal
```

Expected: `latest.json announces v0.2.0 for darwin-aarch64, darwin-aarch64-app`. Keep it running.
Every request the app makes is logged here.

### Step 7: Open the installed old version (terminal A)

```sh
open ".local/installed/Tauri Updater Demo.app"   # then Check → Download → Install → Restart
```

Expected: the window header shows **v0.1.0**, and the Build card lists the
`http://localhost:8787/...` endpoint.

## 2. Click through the update

| # | Action | Expected in the app | Expected in terminal B |
|---|---|---|---|
| 1 | Click **1. Check** | Status `Version 0.2.0 is available.`, with notes `Local test release 0.2.0` | `GET /latest.json  <- app v0.1.0 (darwin-aarch64)  200` |
| 2 | Click **2. Download** | Progress bar reaches 100%, then status `Downloaded and signature verified. Ready to install.` | `GET /v0.2.0/Tauri Updater Demo.app.tar.gz  200 ... bytes` |
| 3 | Click **3. Install** | Status `Installed. Restart to run the new version.` | — |
| 4 | Click **4. Restart** | The app relaunches, the header shows **v0.2.0** and changes color | — |
| 5 | Click **1. Check** again | Status `You are on the latest version (0.2.0).` | `GET /latest.json  <- app v0.2.0 (darwin-aarch64)  200` |

Confirm the bundle on disk was replaced:

```sh
plutil -extract CFBundleShortVersionString raw ".local/installed/Tauri Updater Demo.app/Contents/Info.plist"
# 0.2.0
```

The app's log has the whole run, from both versions:

```sh
tail -n 30 ~/Library/Logs/com.lifuzu.tauri-app-updater/updater-demo.log
```

**The test passes when** rows 1 to 5 match and `plutil` prints `0.2.0`.

## 3. Optional: the security checks reject tampering

Run these after the test above, with terminal B still serving and the v0.2.0 app open. Each one
announces a fake `0.2.1`, so the app offers an "update" and then must refuse it.

**Version mismatch.** `latest.json` claims a version the bundle wasn't signed for:

```sh
node -e 'const fs=require("fs"),f=".local/update-server/latest.json",m=JSON.parse(fs.readFileSync(f));m.version="0.2.1";fs.writeFileSync(f,JSON.stringify(m,null,2))'
```

Click **Check**, then **Download**. Expected:
`Download failed: The update was signed for version 0.2.0 but the update endpoint announced version 0.2.1. ...`

**Corrupted bundle.** Keep the 0.2.1 manifest and change the downloaded file:

```sh
printf 'X' >> ".local/update-server/v0.2.0/Tauri Updater Demo.app.tar.gz"
```

Click **Check**, then **Download**. Expected: `Download failed: The signature verification failed`.

In both cases the installed app stays at 0.2.0, which you can confirm with the `plutil` command
above. Then restore the good bundle and manifest:

```sh
npm run local:publish
```

## Run it again

Repeat from step 2. `local:install` overwrites `.local/installed/`, and `local:publish` rewrites
`latest.json`. Stop the server with Ctrl+C in terminal B.

## If something fails

| Symptom | Fix |
|---|---|
| `incorrect updater private key password` during a build | Step 1: export the right password |
| `Check failed: error sending request for url (http://localhost:8787/...)` | The server isn't running. Do step 6 |
| Check says `You are on the latest version (0.1.0)` | `latest.json` still announces an old version. Redo steps 4 and 5 |
| Download and Install stay disabled, with a "not running from an installed bundle" banner | You opened a `tauri dev` build. Open the copy in `.local/installed/` instead |
| `src-tauri/target was built when the project lived at ...` | The project was moved. Run `(cd src-tauri && cargo clean)` once |

More causes are listed in the troubleshooting table in [README.md](README.md#troubleshooting).
On Windows, run the `-setup.exe` that `local:install` prints instead of `open`. On Linux, run the
AppImage that `local:install` copies.

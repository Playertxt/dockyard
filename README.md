# Lookout

A task manager for **Windows 10/11** and **Linux** that does what the built-in one doesn't: it tells you *why* your PC is slow, remembers the last hour, finds lost windows and locked files, and handles things for you with rules.

![icon](build/icon.png)

## Download

Get the latest version from [**Releases**](https://github.com/Playertxt/dockyard/releases/latest):

- **Windows:** `Lookout-Setup-1.0.0.exe` is the installer. `Lookout-1.0.0-portable.exe` runs without installing.
- **Linux:** unpack `lookout-1.0.0.tar.gz` and run `./lookout`.

The Windows build isn't code-signed, so SmartScreen may warn you. Click **More info → Run anyway**.

## What it does that Task Manager doesn't

| Feature | What you get |
| --- | --- |
| **Why is it slow?** | A plain-English check-up. For example: "Chrome is using 4.2 GB of memory", "Teams has used 30% CPU for 12 minutes", "Drive C: is almost full". Each finding has a fix button. |
| **History** | Scroll back through the last hour. See which app spiked CPU, memory, disk or network, and click any moment to see every app at that time. |
| **Rules** | "When an app uses over 2 GB, tell me." "Always run my game at High priority." "Lower Discord while OBS is open, then put it back." |
| **Pause and resume** | Freeze any app completely, so it uses no CPU, and carry on later exactly where it was. |
| **Undo end task** | Ended the wrong thing? Start it again with the same program and command line, from the toast or from *Recently ended*. |
| **Leak detector** | Flags apps whose memory keeps growing and never comes back down. |
| **Who's using this file or port?** | Find what's locking a file or a USB drive, or what's sitting on port 3000, and end it. |
| **Network per app** | Every app's connections, with host names. Run as administrator to also see each app's download and upload speed. |
| **Focus mode** | One click gives a game or work app High priority and turns down background hogs. Optionally pause apps like OneDrive. Everything goes back when you stop. |
| **Lost windows** | Finds windows that are off-screen, fully transparent, tiny or hidden, and brings them back to the middle of your screen. You can also keep any window on top, make it see-through, or hide it. |
| **What is this process?** | Explanations for common system processes, a tree view, and grouping by app. |

Lookout won't end or pause core system processes, and it asks before ending services. If Lookout closes or crashes, anything it paused is resumed and any priorities it changed are put back.

## Run from source

You need [Node.js](https://nodejs.org) 18 or newer.

```bash
git clone https://github.com/Playertxt/dockyard.git lookout
cd lookout
npm install
npm start
```

Closing the window keeps Lookout in the tray so rules keep working. To quit, right-click the tray icon and choose **Quit**.

## Build an installer

```bash
npm run dist:win     # Windows installer + portable .exe in dist/
npm run dist:linux   # AppImage, .deb and .tar.gz (run this on Linux)
```

Pushing a `v*` tag also builds both versions on GitHub Actions.

## Linux notes

- Processes, connections and open files come from `/proc`. Without `sudo` you only see your own processes' files and sockets.
- For the Windows page, install `wmctrl`, `xdotool` and `x11-utils`, and use an X11 session.
- Per-app network speed and "not responding" detection are Windows-only for now.
- The Linux version hasn't been tested on a real Linux machine yet. Please open an issue if something breaks.

## Develop

```bash
npm test       # unit tests (monitor, rules, diagnosis, Linux parsing)
npm run dev    # run with DevTools
```

| Path | What's there |
| --- | --- |
| `src/main/main.js` | Window, tray, sampling loop, actions, focus mode, IPC |
| `src/main/monitor.js` | Live rates, one hour of history, events, leak detection |
| `src/main/diagnose.js` | The "Why is it slow?" findings |
| `src/main/rules.js` | The rules engine |
| `src/main/platform/` | `helper.cs` (Windows native helper) and `linux.js` |
| `src/renderer/` | The interface |

Settings live in `%APPDATA%\Lookout\lookout.json` on Windows and `~/.config/Lookout/lookout.json` on Linux.

## License

MIT

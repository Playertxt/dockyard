'use strict';
// Safety lists and plain-English explanations for well-known processes.

// Never ended or paused: the OS stops working (or bluescreens) without them.
const BLOCKED = {
  win32: ['system', 'secure system', 'registry', 'memory compression', 'smss.exe', 'csrss.exe', 'wininit.exe', 'winlogon.exe',
    'services.exe', 'lsass.exe', 'lsaiso.exe', 'system idle process', 'fontdrvhost.exe'],
  linux: ['systemd', 'init', 'kthreadd', 'Xorg', 'Xwayland', 'gnome-shell', 'kwin_x11', 'kwin_wayland', 'mutter', 'gdm', 'sddm', 'lightdm']
};

// Can be ended, but only after an extra warning.
const RISKY = {
  win32: ['explorer.exe', 'svchost.exe', 'dwm.exe', 'audiodg.exe', 'spoolsv.exe', 'searchindexer.exe', 'msmpeng.exe', 'ctfmon.exe',
    'sihost.exe', 'taskhostw.exe', 'runtimebroker.exe', 'shellexperiencehost.exe', 'startmenuexperiencehost.exe', 'textinputhost.exe',
    'lsm.exe', 'wudfhost.exe', 'dashost.exe', 'nvcontainer.exe', 'conhost.exe'],
  linux: ['dbus-daemon', 'dbus-broker', 'pipewire', 'pulseaudio', 'wireplumber', 'NetworkManager', 'plasmashell', 'xfwm4', 'xfce4-panel',
    'polkitd', 'udisksd', 'gvfsd', 'Xorg', 'sshd']
};

// Pausing these would freeze the screen, input or the shell.
const NO_PAUSE = {
  win32: ['dwm.exe', 'explorer.exe', 'svchost.exe', 'sihost.exe', 'ctfmon.exe', 'textinputhost.exe', 'shellexperiencehost.exe',
    'startmenuexperiencehost.exe', 'audiodg.exe', 'conhost.exe', 'searchhost.exe', 'lockapp.exe', 'logonui.exe', 'taskhostw.exe'],
  linux: ['dbus-daemon', 'dbus-broker', 'pipewire', 'pulseaudio', 'wireplumber', 'plasmashell', 'xfwm4', 'Xorg', 'Xwayland', 'gnome-shell']
};

const ABOUT = {
  'system': 'The Windows kernel itself. Drivers and disk/network work show up here.',
  'system idle process': 'Not a real program. Its "CPU" is simply how much of the processor is free.',
  'registry': 'Holds the Windows registry in memory.',
  'memory compression': 'Windows squeezes rarely used memory here so it doesn\'t have to go to disk. Large numbers are normal.',
  'smss.exe': 'Session Manager: starts Windows sessions during boot.',
  'csrss.exe': 'Client/Server Runtime: a core part of Windows that handles console windows and shutdown.',
  'wininit.exe': 'Starts Windows services and the login system during boot.',
  'winlogon.exe': 'Handles signing in, locking and Ctrl+Alt+Del.',
  'services.exe': 'The Service Control Manager. Starts and stops Windows services.',
  'lsass.exe': 'Local Security Authority: checks passwords and issues security tokens.',
  'svchost.exe': 'Service Host: runs Windows services in groups. There are always many of these.',
  'dwm.exe': 'Desktop Window Manager: draws everything you see on screen. High GPU/CPU usually means a busy app is redrawing a lot.',
  'explorer.exe': 'Windows Explorer: the taskbar, Start menu, desktop and File Explorer windows. Ending it restarts the taskbar.',
  'runtimebroker.exe': 'Checks permissions for Store apps (camera, location…). Usually small.',
  'searchindexer.exe': 'Builds the search index for files and email. Busy right after you add lots of files.',
  'searchhost.exe': 'The Windows search box and its results.',
  'msmpeng.exe': 'Microsoft Defender Antivirus scanning engine. Busy during scans and after installs.',
  'nissrv.exe': 'Microsoft Defender network inspection.',
  'audiodg.exe': 'Windows Audio Device Graph: mixes and applies effects to all sound.',
  'ctfmon.exe': 'Text input: keyboard layouts, IME and handwriting.',
  'sihost.exe': 'Shell Infrastructure Host: parts of the Start menu, notifications and window snapping.',
  'taskhostw.exe': 'Runs background tasks for Windows and apps.',
  'spoolsv.exe': 'Print Spooler: sends documents to printers.',
  'fontdrvhost.exe': 'Font driver host: draws fonts safely in a sandbox.',
  'conhost.exe': 'Console Window Host: one per command-line window or background console tool.',
  'dllhost.exe': 'COM Surrogate: runs plug-ins like thumbnail makers outside Explorer.',
  'wmiprvse.exe': 'WMI Provider Host: answers system-information queries from apps and scripts.',
  'smartscreen.exe': 'Microsoft Defender SmartScreen: checks downloads and apps.',
  'securityhealthservice.exe': 'Windows Security health reports.',
  'shellexperiencehost.exe': 'Draws the Start menu, Action Center and clock flyouts.',
  'startmenuexperiencehost.exe': 'The Start menu.',
  'textinputhost.exe': 'Touch keyboard, emoji panel and text suggestions.',
  'lockapp.exe': 'The lock screen.',
  'applicationframehost.exe': 'Draws the frame around Store (UWP) apps.',
  'widgets.exe': 'The Windows Widgets board.',
  'phoneexperiencehost.exe': 'Phone Link.',
  'onedrive.exe': 'OneDrive: syncs your files with the cloud. Busy while uploading or downloading.',
  'msedgewebview2.exe': 'Edge WebView2: shows web content inside other apps (Teams, Widgets, Office…).',
  'msedge.exe': 'Microsoft Edge. Each tab and extension can be its own process.',
  'chrome.exe': 'Google Chrome. Each tab, extension and helper is its own process, so you\'ll see many.',
  'firefox.exe': 'Mozilla Firefox. Tabs run in several content processes.',
  'discord.exe': 'Discord. Runs a few helper processes for voice, GPU and updates.',
  'steamwebhelper.exe': 'Steam\'s built-in browser that draws the store and library.',
  'nvcontainer.exe': 'NVIDIA container for driver services and the GeForce overlay.',
  'nvdisplay.container.exe': 'NVIDIA display driver helper (control panel, tray).',
  'powershell.exe': 'Windows PowerShell, a command line. Scripts and tools run inside it.',
  'cmd.exe': 'Command Prompt.',
  'code.exe': 'Visual Studio Code. Extensions and the terminal run as extra processes.',
  'node.exe': 'Node.js: runs JavaScript programs such as dev servers and build tools.',
  'python.exe': 'Python program.',
  'java.exe': 'Java program (for example Minecraft or a dev tool).',
  'javaw.exe': 'Java program without a console window.',
  'wudfhost.exe': 'Windows driver host for devices such as fingerprint readers and sensors.',
  'dashost.exe': 'Device Association Framework: pairs Bluetooth and network devices.',
  'lsm.exe': 'Local Session Manager.',
  'robloxplayerbeta.exe': 'Roblox game client.',
  // Linux
  'systemd': 'The first process: starts and supervises everything else.',
  'kthreadd': 'Parent of all kernel threads.',
  'xorg': 'The X display server: draws the screen and handles input.',
  'xwayland': 'Runs X11 apps on a Wayland desktop.',
  'gnome-shell': 'The GNOME desktop itself: panels, windows and animations.',
  'plasmashell': 'KDE Plasma desktop: panels, widgets and wallpaper.',
  'pipewire': 'Audio and screen-sharing server.',
  'pulseaudio': 'Sound server.',
  'dbus-daemon': 'Message bus that desktop apps use to talk to each other.',
  'networkmanager': 'Manages Wi-Fi and wired connections.',
  'tracker-miner-fs-3': 'GNOME file indexer for search.',
  'baloo_file': 'KDE file indexer for search.'
};

function lower(s) { return String(s || '').toLowerCase(); }

function makeSets(platform) {
  const pick = (o) => new Set((o[platform] || []).map(lower));
  return { blocked: pick(BLOCKED), risky: pick(RISKY), noPause: pick(NO_PAUSE) };
}

function about(name) { return ABOUT[lower(name)] || null; }

module.exports = { makeSets, about, ABOUT };

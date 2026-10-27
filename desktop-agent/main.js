const { app, BrowserWindow, ipcMain, globalShortcut, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const axios = require('axios');
const { exec } = require('child_process');
const QRCode = require('qrcode');

// ── HARDWARE FINGERPRINT ──────────────────────────────────────────────────
// MAC + CPU model + hostname → SHA-256 (32 chars). Anti-piracy: if a competitor
// copies an install and the hardware fingerprint doesn't match, the server rejects it.
function getHardwareId() {
  try {
    const nets = os.networkInterfaces();
    const allMacs = [];
    const stableMacs = [];
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] || []) {
        if (!net.internal && net.mac && net.mac !== '00:00:00:00:00:00') {
          allMacs.push(net.mac);
          // Locally-administered MACs (macOS virtual/random interfaces: awdl0,
          // ap1, llw0, en0 private-addr) change on every boot — skip them.
          // Universally administered: second bit of first octet is 0.
          const firstOctet = parseInt(net.mac.split(':')[0], 16);
          if ((firstOctet & 2) === 0) stableMacs.push(net.mac);
        }
      }
    }
    const pool = stableMacs.length > 0 ? stableMacs : allMacs;
    // Use only one MAC — so the ID doesn't change when a new interface appears
    const primaryMac = pool.sort()[0] || 'nomac';
    const cpus = os.cpus();
    const cpuModel = cpus.length > 0 ? cpus[0].model : 'unknown';
    const raw = primaryMac + '|' + cpuModel + '|' + os.hostname();
    return crypto.createHash('sha256').update(raw).digest('hex').substring(0, 32);
  } catch (e) {
    return 'unknown';
  }
}

// ── CONFIG ─────────────────────────────────────────────────────────────────
let agentConfig;
function getConfigPath() {
  if (!app.isPackaged) return path.join(__dirname, 'config.json');
  // config.json next to the exe — allows separate settings per PC
  const sidecar = path.join(path.dirname(process.execPath), 'config.json');
  if (fs.existsSync(sidecar)) return sidecar;
  // Fallback: the default config inside the exe
  return path.join(process.resourcesPath, 'config.json');
}
try {
  agentConfig = JSON.parse(fs.readFileSync(getConfigPath(), 'utf8'));
} catch {
  agentConfig = { lab_id: 0, computer_id: 0, computer_number: '01', api_url: 'http://localhost:3000/api' };
}
// Can be overridden via env for the simulator/testing (a different PC id for each of 10 windows)
if (process.env.CB_LAB_ID) agentConfig.lab_id = Number(process.env.CB_LAB_ID);
if (process.env.CB_COMPUTER_ID) agentConfig.computer_id = Number(process.env.CB_COMPUTER_ID);
if (process.env.CB_COMPUTER_NUMBER) agentConfig.computer_number = String(process.env.CB_COMPUTER_NUMBER);
if (process.env.CB_API_URL) agentConfig.api_url = process.env.CB_API_URL;
if (process.env.CB_THEME) agentConfig.theme = process.env.CB_THEME; // theme override for testing
const API = agentConfig.api_url || 'http://localhost:3000/api';

// X-CB-PC-ID header on every axios request, so rate limits are counted per PC
axios.defaults.headers.common['X-CB-PC-ID'] = String(agentConfig.computer_id || '');
// Agent secret — required by the middleware in sessions.js
if (process.env.CB_AGENT_SECRET) agentConfig.agent_secret = process.env.CB_AGENT_SECRET;
if (agentConfig.agent_secret) {
  axios.defaults.headers.common['X-Agent-Secret'] = String(agentConfig.agent_secret);
}

// ── HUB AUTO-REGISTRATION ─────────────────────────────────────────────────
function getLocalNetworkInfo() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return { ip: net.address, mac: net.mac };
    }
  }
  return { ip: null, mac: null };
}

async function registerWithHub() {
  if (!agentConfig.computer_number) return;
  try {
    const { ip, mac } = getLocalNetworkInfo();
    const r = await axios.post(`${API}/agent/register`, {
      computer_number: agentConfig.computer_number,
      lab_id: agentConfig.lab_id,
      mac, ip,
    }, { timeout: 5000 });
    if (r.data?.computer_id) {
      agentConfig.computer_id = r.data.computer_id;
      axios.defaults.headers.common['X-CB-PC-ID'] = String(agentConfig.computer_id);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('computer-id-updated', agentConfig.computer_id);
      }
      try {
        const configPath = getConfigPath();
        const existing = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        existing.computer_id = agentConfig.computer_id;
        const tmpPath = configPath + '.tmp';
        fs.writeFileSync(tmpPath, JSON.stringify(existing, null, 2), 'utf8');
        fs.renameSync(tmpPath, configPath);
      } catch {}
    }
    console.log(`[register] PC #${agentConfig.computer_number} → id:${r.data?.computer_id} ip:${ip}`);
  } catch (e) {
    console.warn('[register] Hub ga ulanishda xato:', e.message);
  }
}

// ── LICENSE VERIFICATION (Anti-piracy) ─────────────────────────────────────
// Checks with the server on startup. If the server is offline, the cached
// license is allowed to run within a grace period (24 hours).
const LICENSE_CACHE_FILE = () => path.join(app.getPath('userData'), 'license.json');
const OFFLINE_GRACE_MS = 24 * 60 * 60 * 1000; // 24 hours

function readLicenseCache() {
  try {
    return JSON.parse(fs.readFileSync(LICENSE_CACHE_FILE(), 'utf8'));
  } catch { return null; }
}

function writeLicenseCache(data) {
  try {
    fs.writeFileSync(LICENSE_CACHE_FILE(), JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('[license] cache yozishda xato:', e.message);
  }
}

async function showLicenseErrorAndQuit(msg) {
  try {
    await dialog.showMessageBox({
      type: 'error',
      title: 'CyberNet — Litsenziya xatosi',
      message: msg,
      detail: 'Yordam uchun: t.me/cybernet_support',
      buttons: ['OK'],
    });
  } catch {}
  allowQuit = true;
  try { app.exit(1); } catch { process.exit(1); }
}

async function verifyLicense() {
  const hardwareId = getHardwareId();
  const messages = {
    lab_inactive: 'Game klub faol emas. Admin bilan bog\'laning.',
    subscription_expired: 'Obuna muddati tugagan. CyberNet bilan bog\'laning.',
    invalid_secret: 'Litsenziya kaliti noto\'g\'ri. Dasturni qayta o\'rnating.',
    not_found: 'Bu kompyuter server ro\'yxatida yo\'q. Admin bilan bog\'laning.',
    hardware_mismatch: 'Litsenziya boshqa kompyuterga bog\'langan. Ruxsatsiz nusxa aniqlandi.',
    missing_fields: 'Sozlamalar to\'liq emas. config.json ni tekshiring.',
    server_error: 'Server xatoligi. Keyinroq qayta urinib ko\'ring.',
  };

  const appVersion = app.getVersion();

  try {
    const r = await axios.post(`${API}/agent/verify-license`, {
      computer_id: agentConfig.computer_id,
      lab_id: agentConfig.lab_id,
      hardware_id: hardwareId,
      app_version: appVersion,
    }, { timeout: 8000 });

    if (r.data?.valid) {
      // Success — write the cache (for the offline grace period)
      writeLicenseCache({
        ok: true,
        checked_at: Date.now(),
        computer_id: r.data.computer_id,
        lab_id: r.data.lab_id,
        expires_at: r.data.expires_at || null,
        hardware_id: hardwareId,
      });
      console.log('[license] Tekshiruv muvaffaqiyatli');
      return true;
    }

    const reason = r.data?.reason || 'unknown';
    const msg = messages[reason] || `Litsenziya xatosi: ${reason}`;
    console.warn(`[license] Rad etildi: ${reason}`);
    // hard fail — invalid_secret, hardware_mismatch, not_found — delete the cache
    if (['invalid_secret', 'hardware_mismatch', 'not_found'].includes(reason)) {
      try { fs.unlinkSync(LICENSE_CACHE_FILE()); } catch {}
    }
    await showLicenseErrorAndQuit(msg);
    return false;
  } catch (e) {
    // No server — grace period with the cached license
    console.warn('[license] Server tekshiruvi o\'tmadi:', e.message);
    const cached = readLicenseCache();
    if (cached && cached.ok && cached.hardware_id === hardwareId) {
      const age = Date.now() - (cached.checked_at || 0);
      if (age < OFFLINE_GRACE_MS) {
        console.log(`[license] Offline rejim (cached, ${Math.round(age/3600000)} soat)`);
        return true;
      }
      console.warn('[license] Offline grace tugagan');
      await showLicenseErrorAndQuit(
        'Server bilan aloqa 24 soatdan ortiq yo\'q. Internetni tekshiring.'
      );
      return false;
    }
    // No cache and no server — the first startup must be online
    if (!cached) {
      await showLicenseErrorAndQuit(
        'Birinchi ishga tushirish uchun internet ulanish kerak. Server bilan aloqa yo\'q.'
      );
      return false;
    }
    // Cache exists but the hardware doesn't match (cloned)
    await showLicenseErrorAndQuit(
      'Litsenziya boshqa kompyuterga bog\'langan (offline). Ruxsatsiz nusxa aniqlandi.'
    );
    return false;
  }
}

// ── SESSION FILE (for offline use) ─────────────────────────────────────────
const sessionFile = path.join(app.getPath('userData'), 'cybernet_session.json');

function readLocalSession() {
  try {
    const data = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    const endsAt = new Date(data.ends_at);
    const now = new Date();
    const remainingMs = endsAt - now;
    if (remainingMs > 0) return { ...data, remainingMs };
    // Time has expired — delete the file
    fs.unlinkSync(sessionFile);
    return null;
  } catch {
    return null;
  }
}

function saveLocalSession(data) {
  try {
    fs.writeFileSync(sessionFile, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('Session fayl yozishda xatolik:', e.message);
  }
}

function clearLocalSession() {
  try { fs.unlinkSync(sessionFile); } catch {}
  // Clean up user files when the session ends
  if (typeof cleanupUserFiles === 'function') cleanupUserFiles();
}

// ── MAIN WINDOW ────────────────────────────────────────────────────────────
const isWindows = process.platform === 'win32';

// ── WINDOWS STARTUP ENVIRONMENT (black background, hidden icons, fast start) ───
function setupWindowsStartupEnv() {
  if (!isWindows) return;

  // Hide desktop icons (we don't touch the background color)
  exec('reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced" /v HideIcons /t REG_DWORD /d 1 /f', { windowsHide: true });

  // 3. Task Scheduler — starts faster than the Registry Run key
  const exePath = process.execPath;
  exec(
    `schtasks /Create /TN "CyberNetAgent" /TR "\\"${exePath}\\"" /SC ONLOGON /RL HIGHEST /F`,
    { windowsHide: true },
    (err) => {
      if (err) console.warn('[autostart] Task Scheduler xato:', err.message);
      else console.log('[autostart] Task Scheduler ro\'yxatga olindi');
    }
  );
}

// ── HIDE WINDOWS TASKBAR (SW_HIDE + Watch) ────────────────────────────────
let taskbarWatcherProc = null;

function getPs1Path(name) {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'lockdown', name)
    : path.join(__dirname, 'windows-lockdown', name);
}

function hideWindowsTaskbar() {
  if (!isWindows) return;
  // SW_HIDE once
  exec(
    `powershell -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${getPs1Path('taskbar-toggle.ps1')}" -Mode hide`,
    { windowsHide: true },
    (err) => {
      if (err) console.warn('[taskbar] yashirish xatosi:', err.message);
      else console.log('[taskbar] Windows taskbar yashirildi');
    }
  );
  // Persistent Watch process (checks every 250ms)
  if (!taskbarWatcherProc) {
    taskbarWatcherProc = exec(
      `powershell -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${getPs1Path('taskbar-toggle.ps1')}" -Mode watch`,
      { windowsHide: true },
      () => { taskbarWatcherProc = null; }
    );
    console.log('[taskbar] Watcher started');
  }
}

function restoreDesktopEnv() {
  if (!isWindows) return;
  // Show desktop icons again
  exec('reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced" /v HideIcons /t REG_DWORD /d 0 /f', { windowsHide: true });
  // Restart Explorer (icons appear immediately)
  exec('taskkill /F /IM explorer.exe & start explorer.exe', { windowsHide: true, shell: true });
}

function restoreWindowsTaskbar() {
  if (!isWindows) return;
  // Stop the Watch process
  if (taskbarWatcherProc) { try { taskbarWatcherProc.kill(); } catch {} taskbarWatcherProc = null; }
  // Bring the taskbar back with SW_SHOW
  exec(
    `powershell -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${getPs1Path('taskbar-toggle.ps1')}" -Mode show`,
    { windowsHide: true }
  );
}

// ── LAB APPS (fetched from the backend) ───────────────────────────────────
let labApps = [];

async function fetchLabApps() {
  if (!agentConfig.computer_id) return;
  try {
    const { data } = await axios.get(`${API}/apps?computer_id=${agentConfig.computer_id}`, { timeout: 5000 });
    if (Array.isArray(data)) {
      labApps = data;
      console.log(`[apps] ${labApps.length} ta ilova yuklandi`);
    }
  } catch (e) {
    console.warn('[apps] Ilovalar yuklanmadi:', e.message);
    if (!labApps.length && agentConfig.apps?.length) {
      labApps = agentConfig.apps.map(a => ({ name: a.name, icon_url: a.icon, exe_path: a.path }));
    }
  }
}

// ── APP LAUNCHER ──────────────────────────────────────────────────────────
let launchedApps = []; // { name, exeName, launchedAt }
const launchingExes = new Set(); // rapid-click guard

function focusWindowByName(exeName, mode = 'once') {
  if (!isWindows) return;
  const timeout = mode === 'wait' ? '-TimeoutSec 30' : '';
  exec(
    `powershell -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${getPs1Path('focus-window.ps1')}" -ProcessName "${exeName}" -Mode ${mode} ${timeout}`,
    { windowsHide: true }
  );
}

// Map Steam game IDs to exe names (needed for kill)
const STEAM_GAME_EXE = {
  '730': 'cs2.exe',          // CS2
  '570': 'dota2.exe',        // Dota 2
  '578080': 'PUBG.exe',      // PUBG
  '1172470': 'Fortnite.exe', // Fortnite (Epic, but has a Steam ID)
  '252490': 'rust.exe',      // Rust
  '1091500': 'Cyberpunk2077.exe',
  '1938090': 'cs2.exe',      // CS2 new ID
};

function launchApp(appPath, args, appName) {
  if (!appPath) return;
  const expanded = appPath.replace(/%([^%]+)%/g, (_, k) => process.env[k] || `%${k}%`);
  const argStr = args ? ` ${args}` : '';
  if (isWindows) {
    // URL protocols (steam://, epic://, ...) — the exe name is resolved differently
    const isUrl = /^[a-z][a-z0-9+\-.]*:\/\//i.test(expanded);
    // Detect a Steam game: steam:// URL or "steamapps" in the path
    const isSteamGame = isUrl
      ? /^steam:\/\//i.test(expanded)
      : /[\\/]steamapps[\\/]/i.test(expanded);
    let exeName, name;
    if (isUrl) {
      // steam://rungameid/730 → gameId=730 → cs2.exe (or steam.exe fallback)
      const steamId = expanded.match(/steam:\/\/rungameid\/(\d+)/i)?.[1];
      exeName = (steamId && STEAM_GAME_EXE[steamId]) || 'steam.exe';
      name = appName || exeName.replace('.exe', '');
    } else {
      exeName = path.basename(expanded);
      name = appName || path.basename(expanded, path.extname(expanded));
    }
    const exeKey = exeName.toLowerCase();

    // If already launched — just focus it
    const already = launchedApps.find(a => a.exeName.toLowerCase() === exeKey);
    if (already) {
      focusWindowByName(exeName, 'once');
      return;
    }
    // Rapid-click guard: don't relaunch the same game within 10s
    if (launchingExes.has(exeKey)) return;
    launchingExes.add(exeKey);
    setTimeout(() => launchingExes.delete(exeKey), 15000);

    // Game launch function (once Steam is ready, or in the normal case)
    const doLaunch = () => {
      const launchCmd = isUrl
        ? `cmd /c start "" "${expanded}"`
        : `cmd /c start "" "${expanded}"${argStr}`;
      exec(launchCmd, { windowsHide: true }, (err) => {
        if (err) console.warn('[launcher] xato:', err.message);
      });
      launchedApps.push({ name, exeName, launchedAt: Date.now() });
      launchedApps = launchedApps.filter(a => Date.now() - a.launchedAt < 4 * 3600000);

      // Turn off kiosk mode and hide the window — the OS gives focus to the game itself
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setKiosk(false);
        mainWindow.setFullScreen(false);
        mainWindow.setAlwaysOnTop(false);
        mainWindow.hide(); // hide(), not minimize() — the OS hands focus to the game
      }
      // Turn off the Alt+Tab blocker — native Windows Alt+Tab works while gaming
      stopAltTabBlocker();
    };

    // For Steam games — check that Steam is running.
    // If Steam isn't running, start it first and wait 7 seconds until the IPC pipe
    // is ready, then launch the game.
    // Otherwise the "Failed to connect with local Steam Client process" error appears.
    if (isSteamGame) {
      exec('tasklist /FI "IMAGENAME eq steam.exe" /NH', { windowsHide: true }, (err, stdout) => {
        const steamRunning = !err && /steam\.exe/i.test(stdout || '');
        if (steamRunning) {
          doLaunch();
          return;
        }
        // Start Steam in the background. The -silent flag doesn't show the Steam
        // window (it goes to the tray), so the user goes straight into the game.
        // Find the Steam path via the registry; if not found, call "steam" via PATH.
        const steamPathCmd = 'reg query "HKCU\\Software\\Valve\\Steam" /v SteamExe';
        exec(steamPathCmd, { windowsHide: true }, (regErr, regOut) => {
          let steamExe = 'steam';
          const m = regOut && regOut.match(/SteamExe\s+REG_SZ\s+(.+)/i);
          if (m && m[1]) steamExe = m[1].trim();
          const startSteamCmd = `cmd /c start "" "${steamExe}" -silent`;
          exec(startSteamCmd, { windowsHide: true }, (sErr) => {
            if (sErr) console.warn('[launcher] Steam ishga tushmadi:', sErr.message);
            // Wait 7 seconds for the Steam IPC pipe to be ready
            console.log('[launcher] Steam ishga tushirildi, IPC tayyor bo\'lishi uchun 7s kutamiz...');
            setTimeout(doLaunch, 7000);
          });
        });
      });
      return;
    }

    // Plain exe or non-Steam URL (e.g. epic://) — launch directly
    doLaunch();
  }
}

// ── ALT+TAB BLOCKER + CUSTOM APP SWITCHER ─────────────────────────────────
let altTabBlockerProc = null;
let altTabSignalFile = '';
let lastAltTabSig = '';
let appSwitcherWin = null;

function createAppSwitcherWin() {
  appSwitcherWin = new BrowserWindow({
    fullscreen: true,          // fully hides the taskbar (standard Windows behavior)
    frame: false, transparent: true,
    alwaysOnTop: true, focusable: true,
    skipTaskbar: true, resizable: false, movable: false,
    show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  appSwitcherWin.loadFile('renderer/app-switcher.html');
  appSwitcherWin.setAlwaysOnTop(true, 'screen-saver');
  appSwitcherWin.on('closed', () => { appSwitcherWin = null; });
}

function showAppSwitcher() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!appSwitcherWin || appSwitcherWin.isDestroyed()) createAppSwitcherWin();
  const list = [
    { name: 'CyberNet Launcher', icon: '🎮' },
    ...launchedApps.map(a => ({ name: a.name, icon: '🕹️', exeName: a.exeName })),
  ];
  const send = () => appSwitcherWin.webContents.send('show-switcher', list);
  if (appSwitcherWin.webContents.isLoading()) {
    appSwitcherWin.webContents.once('did-finish-load', send);
  } else { send(); }
  appSwitcherWin.showInactive();
  appSwitcherWin.focus();
}

function stopAltTabBlocker() {
  if (altTabBlockerProc) {
    try { altTabBlockerProc.kill(); } catch {}
    altTabBlockerProc = null;
  }
  if (isWindows) exec('taskkill /F /IM powershell.exe /FI "WINDOWTITLE eq cybernet_alttab*"', { windowsHide: true });
}

function startAltTabBlocker() {
  if (!isWindows) return;
  altTabSignalFile = path.join(os.tmpdir(), 'cybernet_alttab.signal');
  const altUpSignalFile = path.join(os.tmpdir(), 'cybernet_altup.signal');
  let lastAltUpSig = '';

  const ps1 = getPs1Path('block-alttab.ps1');
  altTabBlockerProc = exec(
    `powershell -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${ps1}" -SignalFile "${altTabSignalFile}" -AltUpFile "${altUpSignalFile}"`,
    { windowsHide: true },
    (err) => { if (err?.code) console.warn('[alttab] blocker xato:', err.message); }
  );

  // Tab pressed — show the switcher
  setInterval(() => {
    try {
      const sig = fs.readFileSync(altTabSignalFile, 'utf8').trim();
      if (sig && sig !== lastAltTabSig) { lastAltTabSig = sig; showAppSwitcher(); }
    } catch {}
  }, 80);

  // Alt released — if the switcher is open, select in the main process
  setInterval(() => {
    try {
      const sig = fs.readFileSync(altUpSignalFile, 'utf8').trim();
      if (sig && sig !== lastAltUpSig) {
        lastAltUpSig = sig;
        if (appSwitcherWin && !appSwitcherWin.isDestroyed() && appSwitcherWin.isVisible()) {
          selectFromSwitcher(switcherCurrentIndex);
        }
      }
    } catch {}
  }, 80);

  console.log('[alttab] Blocker started');
}

let switcherCurrentIndex = 0;

function selectFromSwitcher(index) {
  if (appSwitcherWin && !appSwitcherWin.isDestroyed()) appSwitcherWin.hide();
  if (index === 0) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setOpacity(1);
      mainWindow.restore();
      if (isWindows) {
        mainWindow.setFullScreen(true);
        mainWindow.setKiosk(true);
        hideWindowsTaskbar();
      }
      mainWindow.setAlwaysOnTop(true);
      mainWindow.focus();
    }
    return;
  }
  const a = launchedApps[index - 1];
  if (!a) return;
  focusWindowByName(a.exeName, 'once');
}

ipcMain.on('app-switcher-select', (_, index) => selectFromSwitcher(index));

ipcMain.on('app-switcher-cur', (_, index) => {
  switcherCurrentIndex = index;
});

ipcMain.on('app-switcher-hide', () => {
  if (appSwitcherWin && !appSwitcherWin.isDestroyed()) appSwitcherWin.hide();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.focus();
});

let mainWindow;
let syncInterval;

function createWindow() {
  // No env — on Mac, get the real screen size and maximize
  // (small windows for the 10-PC simulator are given via CB_WIN_W/H)
  const { screen } = require('electron');
  const primary = screen.getPrimaryDisplay();
  // On Windows use bounds (full screen, including the taskbar), on Mac workAreaSize
  const defaultW = isWindows ? primary.bounds.width  : primary.workAreaSize.width;
  const defaultH = isWindows ? primary.bounds.height : primary.workAreaSize.height;
  const winW = Number(process.env.CB_WIN_W) || defaultW;
  const winH = Number(process.env.CB_WIN_H) || defaultH;
  const winX = process.env.CB_WIN_X != null ? Number(process.env.CB_WIN_X) : undefined;
  const winY = process.env.CB_WIN_Y != null ? Number(process.env.CB_WIN_Y) : undefined;
  // On Mac too, fullscreen kiosk if no env is given (pass CB_WIN_W for the test simulator)
  const forceFullscreen = !isWindows && !process.env.CB_WIN_W;
  mainWindow = new BrowserWindow({
    width: winW, height: winH,
    x: winX, y: winY,
    fullscreen: isWindows || forceFullscreen,
    simpleFullscreen: forceFullscreen,
    frame: !(isWindows || forceFullscreen),
    kiosk: isWindows,
    alwaysOnTop: isWindows,
    skipTaskbar: isWindows,
    resizable: !isWindows,
    movable: !isWindows,
    minimizable: !isWindows,
    closable: true,
    title: process.env.CB_WIN_TITLE || undefined,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false,
      devTools: !isWindows,
      zoomFactor: Number(process.env.CB_ZOOM) || 1,
    },
  });

  console.log(`[window] Ekran: ${defaultW}x${defaultH}, scale=${primary.scaleFactor}, fullscreen=${isWindows || forceFullscreen}`);
  mainWindow.webContents.on('did-finish-load', async () => {
    await mainWindow.webContents.insertCSS('*{outline:none!important;box-shadow:none!important;} *:focus,*:focus-visible,*:focus-within{outline:none!important;box-shadow:none!important;-webkit-tap-highlight-color:transparent!important;border-color:inherit!important;}');
    await mainWindow.webContents.executeJavaScript(`
      (function(){
        function killRing(e){
          e.target.style.setProperty('outline','none','important');
          e.target.style.setProperty('box-shadow','none','important');
        }
        document.addEventListener('focus', killRing, true);
        document.addEventListener('focusin', killRing, true);
      })();
    `);
    const [w, h] = mainWindow.getSize();
    // Zoom factor and viewport diagnostics + force 1.0
    try {
      mainWindow.webContents.setZoomFactor(1);
      const info = await mainWindow.webContents.executeJavaScript(`
        JSON.stringify({
          innerW: window.innerWidth, innerH: window.innerHeight,
          docH: document.documentElement.clientHeight,
          bodyH: document.body.clientHeight,
          stageH: (document.getElementById('stage')||{clientHeight:0}).clientHeight,
          activeScreen: (document.querySelector('.screen.on')||{id:''}).id,
        })
      `);
      console.log(`[window] Yuklangan oyna: ${w}x${h}, viewport: ${info}`);
    } catch (e) {
      console.log(`[window] Yuklangan oyna: ${w}x${h} (viewport read xato: ${e.message})`);
    }
  });
  mainWindow.on('close', (e) => {
    if (isWindows && !allowQuit) e.preventDefault();
  });

  // When GL regains focus after Settings or a game closes, kiosk mode is restored
  mainWindow.on('focus', () => {
    if (isWindows && !mainWindow.isKiosk()) {
      mainWindow.setFullScreen(true);
      mainWindow.setKiosk(true);
      mainWindow.setAlwaysOnTop(true);
      hideWindowsTaskbar();
    }
  });

  loadActiveTheme();
  // Capture renderer logs/errors — print them all to stdout
  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    // Electron 42: the first arg is the event, then level/message/line/source
    // In some versions: an (event) object
    if (typeof event === 'object' && event !== null && 'message' in event) {
      console.log(`[renderer L${event.level}] ${event.message}`);
    } else {
      console.log(`[renderer L${level}] ${message}`);
    }
  });
  // Open DevTools automatically on Mac for debugging (Windows is kiosk)
  // With CB_NO_DEVTOOLS=1, DevTools don't open (for test/simulator)
  if (!isWindows && !process.env.CB_NO_DEVTOOLS) {
    mainWindow.webContents.once('did-finish-load', () => {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    });
  }
  mainWindow.webContents.on('did-finish-load', () => {
    // Force kiosk/fullscreen on Windows (fixes DPI scaling issues)
    if (isWindows) {
      mainWindow.setFullScreen(true);
      mainWindow.setKiosk(true);
      mainWindow.focus();
      hideWindowsTaskbar();
      // After the taskbar is hidden, the window should fill the full display bounds
      // (if the taskbar is on the right, kiosk ignores it and leaves a gap on the right)
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          const { screen: s } = require('electron');
          const b = s.getPrimaryDisplay().bounds;
          mainWindow.setPosition(b.x, b.y);
          mainWindow.setSize(b.width, b.height);
          mainWindow.setFullScreen(true);
          mainWindow.setKiosk(true);
        }
      }, 600);
    }
    // Run the full backend logic in all themes.
    // HUD → renderer/index.html works with IPC internally.
    // design1..design10 → via renderer/themes/_bridge.js with the same IPC.
    setTimeout(() => checkSession(), 600);
    startBackgroundSync();
    startHeartbeat();
    startCommandPoll();
    startSessionWatcher();
    startQrLoop();
    // Check the theme immediately on boot (don't wait 60s)
    setTimeout(() => syncThemeFromServer(), 1500);
    // Theme HTML auto-update: immediately on boot + every 5 min
    setTimeout(() => syncThemesManifest(), 3000);
    startThemesAutoUpdate();
    // Fetch the app list from the backend + refresh every 5 minutes
    fetchLabApps();
    setInterval(() => fetchLabApps(), 5 * 60 * 1000);
    // Anti-cheat: process monitoring + downloads folder cleanup
    startAntiCheat();
    // Monitor free disk space
    startDiskMonitor();
  });

  registerSecurityShortcuts();
}

// ── THEME LOADING ──────────────────────────────────────────────────────────
// Priority: userData/themes-cache (new version) → renderer/themes (installed) → HUD
function ensureBridgeInCache() {
  // Before every cache load, copy bridge.js from the installed renderer/themes/
  // into themes-cache/. New theme HTML files reference _bridge.js
  // relatively, so it must exist there.
  try {
    const src = path.join(__dirname, 'renderer', 'themes', '_bridge.js');
    const dstDir = path.join(app.getPath('userData'), 'themes-cache');
    const dst = path.join(dstDir, '_bridge.js');
    if (!fs.existsSync(src)) return;
    if (!fs.existsSync(dstDir)) fs.mkdirSync(dstDir, { recursive: true });
    // Update only if changed
    let needCopy = true;
    if (fs.existsSync(dst)) {
      const s = fs.statSync(src);
      const d = fs.statSync(dst);
      needCopy = s.size !== d.size || s.mtimeMs > d.mtimeMs;
    }
    if (needCopy) fs.copyFileSync(src, dst);
  } catch (e) {
    console.warn('[theme] bridge nusxalashda xato:', e.message);
  }
}

function loadActiveTheme() {
  const theme = agentConfig.theme || 'hud';
  if (!theme || theme === 'hud') {
    return mainWindow.loadFile('renderer/index.html');
  }
  ensureBridgeInCache();
  // Check the auto-updated version first
  const cachedPath = path.join(app.getPath('userData'), 'themes-cache', `${theme}.html`);
  if (fs.existsSync(cachedPath)) {
    return mainWindow.loadFile(cachedPath);
  }
  // Fallback: the original version installed with the app
  const bundledPath = path.join(__dirname, 'renderer', 'themes', `${theme}.html`);
  if (fs.existsSync(bundledPath)) {
    return mainWindow.loadFile(`renderer/themes/${theme}.html`);
  }
  console.warn(`[theme] Tema topilmadi: ${theme}, HUD ga qaytish`);
  return mainWindow.loadFile('renderer/index.html');
}

function setTheme(themeName) {
  const prev = agentConfig.theme;
  agentConfig.theme = themeName;
  try {
    fs.writeFileSync(
      path.join(__dirname, 'config.json'),
      JSON.stringify(agentConfig, null, 2),
      'utf8'
    );
  } catch (e) {
    console.error('config.json yozishda xato:', e.message);
  }
  if (prev !== themeName) loadActiveTheme();
}

// startThemeSyncOnly() is no longer used — startBackgroundSync covers theme checks
// in all themes. themeOnlyInterval is only for legacy cleanup.
let themeOnlyInterval;

// ── THEME HTML AUTO-UPDATE (every 5 minutes) ───────────────────────────────
// When the club owner uploads a new design HTML, all PCs download it automatically
let themeManifestInterval;
const THEMES_CACHE_DIR = () => path.join(app.getPath('userData'), 'themes-cache');
const LOCAL_MANIFEST_FILE = () => path.join(THEMES_CACHE_DIR(), 'manifest.json');
const DESIGN_KEYS = ['design1','design1-v2','design2','design3','design4','design5','design6','design7','design8','design9','design10'];

function readLocalManifest() {
  try {
    return JSON.parse(fs.readFileSync(LOCAL_MANIFEST_FILE(), 'utf8'));
  } catch {
    return { themes: {} };
  }
}

function writeLocalManifest(manifest) {
  try {
    if (!fs.existsSync(THEMES_CACHE_DIR())) fs.mkdirSync(THEMES_CACHE_DIR(), { recursive: true });
    fs.writeFileSync(LOCAL_MANIFEST_FILE(), JSON.stringify(manifest, null, 2), 'utf8');
  } catch (e) {
    console.error('[themes-cache] manifest yozishda xato:', e.message);
  }
}

async function downloadThemeHtml(key) {
  // Backend static: http://.../themes/{key}.html
  const base = API.replace(/\/api\/?$/, '');
  const url = `${base}/themes/${key}.html`;
  const { data } = await axios.get(url, { timeout: 15000, responseType: 'text' });
  if (typeof data !== 'string' || !/<!DOCTYPE html/i.test(data.substring(0, 200))) {
    throw new Error('Yaroqsiz HTML javob');
  }
  const dir = THEMES_CACHE_DIR();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${key}.html`), data, 'utf8');
  return data.length;
}

async function syncThemesManifest() {
  try {
    const { data: serverManifest } = await axios.get(`${API}/themes/manifest`, { timeout: 5000 });
    if (!serverManifest?.themes) return;

    const localManifest = readLocalManifest();
    const activeTheme = agentConfig.theme || 'hud';
    let activeThemeUpdated = false;
    let anyUpdated = false;

    for (const key of DESIGN_KEYS) {
      const serverEntry = serverManifest.themes[key];
      if (!serverEntry?.sha256) continue;
      const localEntry = localManifest.themes[key];
      if (localEntry?.sha256 === serverEntry.sha256) continue;

      try {
        const size = await downloadThemeHtml(key);
        console.log(`[themes-cache] Yuklab olindi: ${key} (${size} bayt)`);
        localManifest.themes[key] = { sha256: serverEntry.sha256, size, updated_at: serverEntry.updated_at };
        anyUpdated = true;
        if (key === activeTheme) activeThemeUpdated = true;
      } catch (e) {
        console.warn(`[themes-cache] ${key} yuklab bo'lmadi:`, e.message);
      }
    }

    if (anyUpdated) {
      localManifest.version = serverManifest.version;
      writeLocalManifest(localManifest);
    }

    // If the active theme was updated, reload the window
    if (activeThemeUpdated && activeTheme !== 'hud') {
      console.log('[themes-cache] Aktiv tema yangilandi, qayta yuklanmoqda');
      loadActiveTheme();
    }
  } catch {
    // No connection to the server — skip silently
  }
}

function startThemesAutoUpdate() {
  clearInterval(themeManifestInterval);
  themeManifestInterval = setInterval(() => syncThemesManifest(), 5 * 60 * 1000); // 5 minutes
}

// ── THEME SYNC FROM THE SERVER ─────────────────────────────────────────────
// When the club owner changes the theme in the admin panel, all PCs pick it up automatically
async function syncThemeFromServer() {
  if (!agentConfig.lab_id) return;
  if (process.env.CB_THEME) return; // env override — ignore the server theme
  try {
    const { data } = await axios.get(
      `${API}/labs/${agentConfig.lab_id}/theme`,
      { timeout: 5000 }
    );
    const serverTheme = data.theme || 'hud';
    if (serverTheme !== agentConfig.theme) {
      console.log(`[theme-sync] Server tema o'zgardi: ${agentConfig.theme} → ${serverTheme}`);
      setTheme(serverTheme);
    }
  } catch (e) {
    // No connection to the server — skip silently (offline)
  }
}

function openThemePicker() {
  if (!mainWindow) return;
  mainWindow.loadFile('renderer/theme-picker.html');
}

// ── OVERLAY (remaining time — Ctrl+Tab) ───────────────────────────────────
let overlayWindow = null;
let overlayHideTimer = null;
let lastSessionData = null;

function createOverlay() {
  overlayWindow = new BrowserWindow({
    width: 280, height: 100,
    x: undefined, // top-right of the screen
    y: 12,
    frame: false, transparent: true,
    alwaysOnTop: true,
    focusable: false,        // the user can't focus it
    skipTaskbar: true,       // not shown in the taskbar
    resizable: false, movable: false, minimizable: false, closable: false,
    show: false,
    hasShadow: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  overlayWindow.loadFile('renderer/overlay.html');
  overlayWindow.setIgnoreMouseEvents(true, { forward: false }); // the mouse passes through
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Position at the top-right of the screen
  const { screen } = require('electron');
  const display = screen.getPrimaryDisplay();
  overlayWindow.setBounds({
    x: display.workArea.x + display.workArea.width - 290,
    y: display.workArea.y + 10,
    width: 280, height: 100,
  });
}

function showOverlay() {
  if (!overlayWindow || overlayWindow.isDestroyed()) createOverlay();
  // Send the local session
  const local = readLocalSession();
  const data = local ? { endsAt: local.ends_at, packageName: local.package_name } : null;
  if (overlayWindow.webContents.isLoading()) {
    overlayWindow.webContents.once('did-finish-load', () => {
      overlayWindow.webContents.send('overlay-update', data);
    });
  } else {
    overlayWindow.webContents.send('overlay-update', data);
  }
  overlayWindow.showInactive(); // no focus stealing
  clearTimeout(overlayHideTimer);
  overlayHideTimer = setTimeout(() => {
    if (overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()) {
      overlayWindow.hide();
    }
  }, 3000);
}

function toggleOverlay() {
  if (overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()) {
    overlayWindow.hide();
    clearTimeout(overlayHideTimer);
  } else {
    showOverlay();
  }
}

// ── TIME OVERLAY (Alt+Tab) ────────────────────────────────────────────────
let timeOverlayWin = null;

function createTimeOverlay() {
  const { screen } = require('electron');
  const { bounds } = screen.getPrimaryDisplay();
  timeOverlayWin = new BrowserWindow({
    width: 520, height: 300,
    x: Math.round(bounds.x + bounds.width  / 2 - 260),
    y: Math.round(bounds.y + bounds.height / 2 - 150),
    frame: false, transparent: true,
    alwaysOnTop: true,
    focusable: false,
    skipTaskbar: true,
    resizable: false, movable: false, minimizable: false, closable: false,
    show: false,
    hasShadow: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  timeOverlayWin.loadFile('renderer/time-overlay.html');
  timeOverlayWin.setAlwaysOnTop(true, 'screen-saver');
  timeOverlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
}

function showTimeOverlay() {
  if (!timeOverlayWin || timeOverlayWin.isDestroyed()) createTimeOverlay();
  const local = readLocalSession();
  if (!local) return; // No session — don't show
  const remainingMs = local.ends_at
    ? Math.max(0, new Date(local.ends_at) - Date.now())
    : 0;
  const send = () => timeOverlayWin.webContents.send('time-overlay-data', {
    remainingMs,
    userName: local.user_name || local.user?.name || '',
  });
  if (timeOverlayWin.webContents.isLoading()) {
    timeOverlayWin.webContents.once('did-finish-load', send);
  } else {
    send();
  }
  timeOverlayWin.showInactive();
}

function hideTimeOverlay() {
  if (timeOverlayWin && !timeOverlayWin.isDestroyed()) timeOverlayWin.hide();
}

function toggleTimeOverlay() {
  if (timeOverlayWin && !timeOverlayWin.isDestroyed() && timeOverlayWin.isVisible()) {
    hideTimeOverlay();
  } else {
    showTimeOverlay();
  }
}

ipcMain.on('hide-time-overlay', hideTimeOverlay);

// ── SECURITY SHORTCUTS ─────────────────────────────────────────────────────
function registerSecurityShortcuts() {
  const toBlock = [
    'Alt+F4',         // Close window
    'Ctrl+Escape',    // Start menu
    'Super+D',        // Show desktop
    'Super+L',        // Lock screen
    'Super+Tab',      // Task view
    'Super+E',        // Explorer
    'Super+R',        // Run dialog
    'Super+F',        // Search
    'Super+I',        // Settings
    'Super+P',        // Projector
    'Ctrl+Shift+Esc', // Task Manager (direct)
    'F11',            // Fullscreen toggle
    'F12',            // DevTools
    'Ctrl+Shift+I',   // DevTools (Chrome style)
    'Ctrl+Shift+J',   // Console
    'Super',          // Windows key (Start menu)
  ];

  toBlock.forEach(sc => {
    try { globalShortcut.register(sc, () => {}); } catch (_) {}
  });

  // Alt+Tab → handled by the WH_KEYBOARD_LL blocker (startAltTabBlocker)
  // globalShortcut.register('Alt+Tab') doesn't work on Windows — it's a system hotkey

  // Ctrl+Tab → app switcher (fallback hotkey)
  try {
    globalShortcut.register('Control+Tab', () => showAppSwitcher());
  } catch (_) {}

  // Theme picker (for the club owner) — Ctrl+Shift+Alt+T
  try {
    globalShortcut.register('Control+Shift+Alt+T', () => openThemePicker());
  } catch (_) {}

  // Admin exit — Ctrl+Shift+Alt+X → asks for a password
  try {
    globalShortcut.register('Control+Shift+Alt+X', () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.webContents.send('admin-exit-prompt');
    });
  } catch (_) {}
}

// ── SESSION CHECK ──────────────────────────────────────────────────────────
async function checkSession() {
  const local = readLocalSession();

  if (local) {
    // A local session exists — resume immediately (even offline)
    mainWindow.webContents.send('session-resume', {
      session: local,
      remainingMs: local.remainingMs,
    });

    // Check the backend in the background
    verifyWithBackend(local).catch(() => {});
    return;
  }

  // No local session — ask the backend
  try {
    const { data: session } = await axios.get(
      `${API}/sessions/computer/${agentConfig.computer_id}/active`,
      { timeout: 5000 }
    );
    if (session && session.id) {
      const endsAt = new Date(session.ends_at);
      const remainingMs = endsAt - new Date();
      if (remainingMs > 0) {
        saveLocalSession({ ...session, session_id: session.id });
        mainWindow.webContents.send('session-resume', { session, remainingMs });
        return;
      }
      // Time has run out
      await axios.post(`${API}/sessions/${session.id}/force-end`).catch(() => {});
    }
  } catch {
    // Backend unavailable — show the lock screen
  }

  mainWindow.webContents.send('session-none');
}

// Sync with the backend (in the background)
async function verifyWithBackend(local) {
  const { data: apiSession } = await axios.get(
    `${API}/sessions/computer/${agentConfig.computer_id}/active`,
    { timeout: 5000 }
  );

  // If the admin stopped the session
  if (!apiSession || apiSession.id !== local.session_id) {
    clearLocalSession();
    // "Admin ended it" message only for real user sessions
    if (local.user_id) {
      mainWindow.webContents.send('session-ended-remotely');
    } else {
      mainWindow.webContents.send('session-none');
    }
  } else {
    // Session still active — update the local cache with the new data
    const remainingMs = Math.max(0, new Date(apiSession.ends_at) - new Date());
    saveLocalSession({ ...apiSession, session_id: apiSession.id, remainingMs });
    // Update the balance (wallet + lab_balance)
    mainWindow.webContents.send('balance-update', {
      user_balance: apiSession.user_balance,
      lab_balance: apiSession.lab_balance,
    });
  }

  // Check admin messages
  try {
    const { data: messages } = await axios.get(
      `${API}/sessions/computer/${agentConfig.computer_id}/messages`,
      { timeout: 3000 }
    );
    for (const msg of messages) {
      mainWindow.webContents.send('admin-message', msg);
    }
  } catch {}
}

// ── BACKGROUND SYNC (60s) ──────────────────────────────────────────────────
function startBackgroundSync() {
  clearInterval(syncInterval);
  syncInterval = setInterval(async () => {
    // Theme sync — always, with or without a session (on the lock screen too)
    syncThemeFromServer();

    const local = readLocalSession();
    if (!local) {
      // No session — a new session may have been started from mobile
      checkSession();
      return;
    }

    try {
      await verifyWithBackend(local);
      mainWindow.webContents.send('network-status', { online: true });
    } catch {
      mainWindow.webContents.send('network-status', { online: false });
    }
  }, 60000);
}

// ── AGENT HEARTBEAT (every 30s) ───────────────────────────────────────────
let heartbeatInterval;

function startHeartbeat() {
  clearInterval(heartbeatInterval);
  heartbeatInterval = setInterval(async () => {
    const local = readLocalSession();
    const body = {
      session_id: local?.session_id || null,
      remaining_ms: local ? Math.max(0, new Date(local.ends_at) - new Date()) : null,
    };
    try {
      await axios.post(
        `${API}/sessions/computer/${agentConfig.computer_id}/heartbeat`,
        body,
        { timeout: 3000 }
      );
    } catch {}
  }, 30000);
}

// ── EXECUTE COMMANDS ──────────────────────────────────────────────────────
let commandInterval;

async function executeCommand(cmd) {
  const { id, command, payload } = cmd;
  try {
    switch (command) {
      case 'lock':
        exec('rundll32 user32.dll,LockWorkStation');
        mainWindow.webContents.send('remote-lock');
        break;
      case 'unlock':
        mainWindow.webContents.send('remote-unlock');
        break;
      case 'shutdown':
        exec('shutdown /s /t 5');
        mainWindow.webContents.send('remote-shutdown', { seconds: 5 });
        break;
      case 'restart':
        exec('shutdown /r /t 5');
        mainWindow.webContents.send('remote-shutdown', { seconds: 5, restart: true });
        break;
      case 'message':
        mainWindow.webContents.send('admin-message', { message: payload?.text || '', sender_name: payload?.sender || 'Admin' });
        break;
      case 'end_session': {
        const local = readLocalSession();
        if (local?.session_id) {
          await axios.post(`${API}/sessions/${local.session_id}/force-end`, {}, { timeout: 5000 }).catch(() => {});
          clearLocalSession();
          mainWindow.webContents.send('session-ended-remotely');
        }
        break;
      }
      case 'session_start':
        checkSession();
        break;
      case 'force_update': {
        relaunchUpdate(payload?.url);
        break;
      }
    } // switch end
    await axios.post(
      `${API}/sessions/computer/${agentConfig.computer_id}/commands/${id}/ack`,
      {},
      { timeout: 3000 }
    ).catch(() => {});
  } catch (e) {
    console.error(`[cmd] ${command} xatolik:`, e.message);
  }
}

// ── SESSION WATCHER (10s) — detect sessions started from mobile ────────────
let sessionWatcherInterval;
function startSessionWatcher() {
  clearInterval(sessionWatcherInterval);
  sessionWatcherInterval = setInterval(() => {
    if (!readLocalSession()) checkSession();
  }, 10000);
}

function startCommandPoll() {
  clearInterval(commandInterval);
  commandInterval = setInterval(async () => {
    try {
      const { data: cmds } = await axios.get(
        `${API}/sessions/computer/${agentConfig.computer_id}/commands`,
        { timeout: 3000 }
      );
      for (const cmd of cmds) {
        await executeCommand(cmd);
      }
    } catch {}
  }, 15000);
}

// ── QR LOGIN ────────────────────────────────────────────────────────────────
let qrTokenInterval = null;
let qrPollInterval = null;

function startQrLoop() {
  const labId = agentConfig.lab_id;
  const computerId = agentConfig.computer_id;
  const secret = agentConfig.agent_secret || process.env.AGENT_SECRET || '';
  const headers = { 'x-agent-secret': secret };

  async function refreshQrToken() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      const { data } = await axios.get(
        `${API}/checkin/generate?lab_id=${labId}&computer_id=${computerId}`,
        { headers, timeout: 5000 }
      );
      const dataUrl = await QRCode.toDataURL(data.qr_token, {
        width: 148, margin: 1,
        color: { dark: '#ffffff', light: '#0B0E14' },
      });
      console.log('[QR] Token yangilandi, rasm yuborildi');
      mainWindow.webContents.send('qr-image', { dataUrl });
    } catch (e) {
      console.log('[QR] Token olishda xato:', e.message);
    }
  }

  async function pollPending() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (readLocalSession()) return;
    try {
      const { data } = await axios.get(
        `${API}/checkin/computer/${computerId}/pending`,
        { headers, timeout: 3000 }
      );
      if (data.pending) {
        console.log('[QR] Foydalanuvchi aniqlandi:', data.user_data?.name);
        mainWindow.webContents.send('qr-user-ready', data);
      }
    } catch {}
  }

  clearInterval(qrTokenInterval);
  clearInterval(qrPollInterval);
  refreshQrToken();
  qrTokenInterval = setInterval(refreshQrToken, 28000);
  qrPollInterval = setInterval(pollPending, 5000);
}

// ── IPC HANDLERS ───────────────────────────────────────────────────────────
ipcMain.handle('get-config', () => agentConfig);

// System volume — get
ipcMain.handle('get-volume', () => new Promise(resolve => {
  if (!isWindows) return resolve(50);
  exec(
    `powershell -NoProfile -NonInteractive -Command "` +
    `Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class V { [DllImport(""winmm.dll"")] public static extern int waveOutGetVolume(IntPtr h, out uint v); public static int G() { uint v; waveOutGetVolume(IntPtr.Zero, out v); return (int)((v & 0xffff) * 100 / 65535); } }'; [V]::G()"`,
    { windowsHide: true },
    (err, out) => { const n = parseInt(out); resolve(!err && !isNaN(n) ? Math.max(0, Math.min(100, n)) : 50); }
  );
}));

// System volume — set (0-100)
ipcMain.handle('set-volume', (_, pct) => {
  if (!isWindows) return;
  const v = Math.max(0, Math.min(100, parseInt(pct) || 0));
  exec(
    `powershell -NoProfile -NonInteractive -Command "` +
    `Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class V { [DllImport(""winmm.dll"")] public static extern int waveOutSetVolume(IntPtr h, uint v); public static void S(int p) { uint v=(uint)(p*65535/100); waveOutSetVolume(IntPtr.Zero,v|(v<<16)); } }'; [V]::S(${v})"`,
    { windowsHide: true }
  );
});

// Open mouse settings (mouse only — safe)
ipcMain.handle('open-os-settings', (_, kind) => {
  try {
    if (process.platform === 'win32' && kind === 'mouse') {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setKiosk(false);
        mainWindow.setAlwaysOnTop(false);
      }
      exec(`cmd /c start "" "ms-settings:mousetouchpad"`, { windowsHide: false });
    } else if (process.platform === 'darwin') {
      const pane = kind === 'mouse' ? 'com.apple.preference.mouse' : 'com.apple.preference.sound';
      exec(`open "x-apple.systempreferences:${pane}"`);
    }
    return true;
  } catch (e) {
    console.error('open-os-settings:', e.message);
    return false;
  }
});

ipcMain.handle('restore-kiosk', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.restore();
  if (isWindows) {
    mainWindow.setFullScreen(true);
    mainWindow.setKiosk(true);
    hideWindowsTaskbar();
  }
  mainWindow.setAlwaysOnTop(true);
  mainWindow.focus();
});

ipcMain.on('save-session', (_, data) => {
  saveLocalSession(data);
});

ipcMain.on('clear-session', () => {
  clearLocalSession();
});

ipcMain.on('check-session', () => checkSession());

ipcMain.on('force-end-session', async (_, sessionId) => {
  try {
    const r = await axios.post(`${API}/sessions/${sessionId}/force-end`, {}, { timeout: 5000 });
    const debt = parseFloat(r.data?.debt || 0);
    if (debt > 0 && mainWindow) {
      mainWindow.webContents.send('show-debt-warning', debt);
    }
  } catch {}
  clearLocalSession();
});

// Theme selection (called from theme-picker.html)
ipcMain.handle('set-theme', (_, themeName) => {
  setTheme(themeName);
  return true;
});

ipcMain.handle('get-theme', () => agentConfig.theme || 'hud');

ipcMain.on('open-theme-picker', () => openThemePicker());

// ── TRAILER LOCAL CACHE ───────────────────────────────────────────────────
// Trailers of games the user selected are downloaded from the server on the first run
// and saved to userData/trailers-cache/. All subsequent
// hovers play from file:// — no server requests.

let _trailerCacheDir = null;
function getTrailerCacheDir() {
  if (!_trailerCacheDir) {
    _trailerCacheDir = path.join(app.getPath('userData'), 'trailers-cache');
    fs.mkdirSync(_trailerCacheDir, { recursive: true });
    // Clean up half-downloaded .tmp files
    try {
      fs.readdirSync(_trailerCacheDir)
        .filter(f => f.endsWith('.tmp'))
        .forEach(f => fs.unlinkSync(path.join(_trailerCacheDir, f)));
    } catch {}
  }
  return _trailerCacheDir;
}

function downloadTrailerFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const tmpPath = destPath + '.tmp';
    const out = fs.createWriteStream(tmpPath);
    const lib = url.startsWith('https') ? require('https') : require('http');
    const req = lib.get(url, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        out.close();
        fs.unlink(tmpPath, () => {});
        return downloadTrailerFile(res.headers.location, destPath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        out.close();
        fs.unlink(tmpPath, () => {});
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      res.pipe(out);
      out.on('finish', () => {
        out.close();
        fs.rename(tmpPath, destPath, err => err ? reject(err) : resolve());
      });
    });
    req.on('error', err => {
      out.close();
      fs.unlink(tmpPath, () => {});
      reject(err);
    });
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// Cached trailers: { 'cs2.mp4': 'file:///...', ... }
ipcMain.handle('get-cached-trailers', () => {
  const dir = getTrailerCacheDir();
  const cached = {};
  try {
    fs.readdirSync(dir)
      .filter(f => f.endsWith('.mp4'))
      .forEach(f => {
        cached[f] = 'file:///' + path.join(dir, f).replace(/\\/g, '/');
      });
  } catch {}
  return cached;
});

// Downloads and saves in the background (3 in parallel)
ipcMain.handle('cache-trailers', async (event, trailers) => {
  const dir = getTrailerCacheDir();
  const pending = trailers.filter(({ filename }) => !fs.existsSync(path.join(dir, filename)));
  if (!pending.length) return { ok: true, downloaded: 0 };
  console.log(`[trailer-cache] Yuklanishi kerak: ${pending.length} ta`);
  const BATCH = 3;
  for (let i = 0; i < pending.length; i += BATCH) {
    await Promise.all(pending.slice(i, i + BATCH).map(async ({ filename, url }) => {
      try {
        await downloadTrailerFile(url, path.join(dir, filename));
        console.log(`[trailer-cache] ✓ ${filename}`);
      } catch (e) {
        console.warn(`[trailer-cache] ✗ ${filename}: ${e.message}`);
      }
    }));
  }
  return { ok: true, downloaded: pending.length };
});

// Admin exit (with password check)
ipcMain.handle('admin-verify', (_, password) => {
  return password === agentConfig.exit_password;
});

ipcMain.handle('admin-exit', (_, password) => {
  if (password === agentConfig.exit_password) {
    allowQuit = true;
    globalShortcut.unregisterAll();
    clearInterval(syncInterval);
    clearInterval(heartbeatInterval);
    clearInterval(commandInterval);
    clearInterval(themeOnlyInterval);
    clearInterval(themeManifestInterval);
    if (mainWindow) {
      mainWindow.setKiosk(false);
      mainWindow.setClosable(true);
    }
    setTimeout(() => app.quit(), 300);
    return true;
  }
  return false;
});

// Chromium-level switch to disable the focus ring
app.commandLine.appendSwitch('disable-features', 'CSSFocusVisible');
app.commandLine.appendSwitch('blink-settings', 'focusRingWidth=0');

// ── APP LIFECYCLE ──────────────────────────────────────────────────────────
let allowQuit = false;
let sessionEndedForQuit = false;

// ── RELAUNCH UPDATE ──────────────────────────────────────────────────────────
// Downloads the installer to C:\Windows\Temp, creates a SYSTEM ONSTART task,
// reboots the PC. On boot it installs without the NSIS lock.
let _updateInProgress = false;
function relaunchUpdate(customUrl) {
  if (_updateInProgress) { console.log('[update] Yangilanish allaqachon davom etmoqda, o\'tkazib yuborildi'); return; }
  if (!isWindows) return;
  _updateInProgress = true;
  const setupUrl = customUrl || 'https://example.com/downloads/CyberNet-Agent-Setup-latest.exe';
  const uid = Date.now();
  // C:\Windows\Temp — not deleted even after a reboot
  const sysTemp = 'C:\\Windows\\Temp';
  const tmp = path.join(sysTemp, `cybernet-setup-${uid}.exe`);
  const launcherPs = path.join(sysTemp, `cybernet-launcher-${uid}.ps1`);
  const triggerPs = path.join(os.tmpdir(), `cybernet-trigger-${uid}.ps1`);

  console.log('[update] Yuklab olinmoqda:', setupUrl);

  const writer = fs.createWriteStream(tmp);
  axios({ method: 'get', url: setupUrl, responseType: 'stream', timeout: 600000 })
    .then(res => {
      res.data.pipe(writer);
      return new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
      });
    })
    .then(() => {
      console.log('[update] Yuklandi. Reboot orqali o\'rnatish rejalashtirildi...');
      const currentPid = process.pid;
      const tmpEsc = tmp.replace(/'/g, "''");
      const launcherEsc = launcherPs.replace(/'/g, "''");
      const triggerEsc = triggerPs.replace(/'/g, "''");

      // Script that runs as SYSTEM on boot — no exe lock
      const launcherScript = [
        '$ErrorActionPreference = "SilentlyContinue"',
        `Start-Process -FilePath '${tmpEsc}' -ArgumentList '/S /allusers' -Wait`,
        'Unregister-ScheduledTask -TaskName "CyberNetUpdate" -Confirm:$false -ErrorAction SilentlyContinue',
        `Remove-Item '${tmpEsc}' -Force -ErrorAction SilentlyContinue`,
        `Remove-Item '${launcherEsc}' -Force -ErrorAction SilentlyContinue`,
      ].join('\r\n');
      fs.writeFileSync(launcherPs, launcherScript, 'utf8');

      // Current trigger: creates the task and reboots
      const launcherArg = `-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File '${launcherEsc.replace(/'/g, "''")}'`;
      const triggerScript = [
        '$ErrorActionPreference = "SilentlyContinue"',
        'Unregister-ScheduledTask -TaskName "CyberNetUpdate" -Confirm:$false -ErrorAction SilentlyContinue',
        `$a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '${launcherArg.replace(/'/g, "''")}'`,
        '$t = New-ScheduledTaskTrigger -AtStartup',
        '$p = New-ScheduledTaskPrincipal -UserId "SYSTEM" -RunLevel Highest',
        'Register-ScheduledTask -TaskName "CyberNetUpdate" -Action $a -Trigger $t -Principal $p -Force | Out-Null',
        `taskkill /F /PID ${currentPid} /T 2>$null`,
        'taskkill /F /IM "CyberNet Agent.exe" /T 2>$null',
        'taskkill /F /IM electron.exe /T 2>$null',
        'Start-Sleep -Seconds 2',
        'shutdown /r /t 10 /f /c "CyberNet yangilanmoqda..."',
        `Remove-Item '${triggerEsc}' -Force -ErrorAction SilentlyContinue`,
      ].join('\r\n');
      fs.writeFileSync(triggerPs, triggerScript, 'utf8');

      const child = require('child_process').spawn(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', triggerPs],
        { detached: true, stdio: 'ignore', windowsHide: true }
      );
      child.unref();

      setTimeout(() => process.exit(0), 500);
    })
    .catch(err => {
      console.error('[update] Yuklash xatosi:', err.message);
      _updateInProgress = false;
    });
}

// ── AUTO-UPDATER ────────────────────────────────────────────────────────────
// Updates start only via a force_update command from the server.
// PCs don't check on their own — the server pushes when it releases a new version.
function setupAutoUpdater() {
  // Polling disabled — relaunchUpdate() is called via the force_update command
}

app.whenReady().then(async () => {
  // ── LICENSE CHECK ──────────────────────────────────────────────────────
  if (agentConfig.computer_id && agentConfig.lab_id) {
    try {
      const r = await axios.post(`${API}/agent/verify-license`, {
        computer_id: agentConfig.computer_id,
        lab_id: agentConfig.lab_id,
        hardware_id: getHardwareId(),
      }, { timeout: 8000 });
      if (!r.data.valid) {
        const msgs = {
          lab_inactive: 'Game klub faol emas. Admin bilan bog\'laning.',
          subscription_expired: 'Obuna muddati tugagan. CyberNet: +998 XX XXX XX XX',
          invalid_secret: 'Litsenziya xatosi. Qayta o\'rnating.',
          not_found: 'Bu kompyuter ro\'yxatdan o\'tmagan. Admin bilan bog\'laning.',
        };
        await dialog.showMessageBox({
          type: 'error',
          title: 'CyberNet — Litsenziya xatosi',
          message: msgs[r.data.reason] || `Xato: ${r.data.reason}`,
          buttons: ['OK'],
        });
        app.quit();
        return;
      }
      console.log('[license] ✓ Litsenziya tasdiqlandi');
    } catch (e) {
      console.warn('[license] Server yo\'q — offline rejim:', e.message);
    }
  }
  // ──────────────────────────────────────────────────────────────────────

  if (isWindows) {
    setupWindowsStartupEnv();
    // Electron built-in (for the packaged app)
    app.setLoginItemSettings({
      openAtLogin: true,
      openAsHidden: false,
      name: 'CyberNet Agent',
      path: process.execPath,
    });
    // Registry backup (works in both dev and packaged)
    const exePath = process.execPath.replace(/\\/g, '\\\\');
    exec(
      `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "CyberNetAgent" /t REG_SZ /d "\\"${exePath}\\"" /f`,
      { windowsHide: true },
      (err) => {
        if (err) console.warn('[autostart] Registry yozishda xato:', err.message);
        else console.log('[autostart] Registry ga yozildi');
      }
    );
  }
  createWindow();
  startAltTabBlocker();
  setupAutoUpdater();
  setTimeout(registerWithHub, 4000);
  // Scan all games (Steam + local) within 30 seconds and send them to the server
  setTimeout(async () => {
    try {
      const steam = discoverSteamGames();
      const local = discoverNonSteamGames();
      const steamNames = new Set(steam.map(g => g.name.toLowerCase()));
      const found = [...steam, ...local.filter(g => !steamNames.has(g.name.toLowerCase()))];
      if (!found.length) return;
      await axios.post(`${API}/games/steam-report`, {
        lab_id: agentConfig.lab_id,
        computer_id: agentConfig.computer_id,
        games: found,
      }, { timeout: 10000 });
      console.log(`[steam] ${found.length} ta o'yin topildi va serverga yuborildi`);
    } catch (e) {
      console.warn('[steam] Skan yuklanmadi:', e.message);
    }
  }, 30000);
});

// Verify via tasklist that the process is really gone (after waiting 600ms)
function isProcessRunning(exeName) {
  return new Promise((resolve) => {
    exec(
      `tasklist /FI "IMAGENAME eq ${exeName}" /NH /FO CSV`,
      { windowsHide: true, timeout: 5000 },
      (err, stdout) => {
        if (err || !stdout) { resolve(false); return; }
        resolve(stdout.toLowerCase().includes(exeName.toLowerCase()));
      }
    );
  });
}

// Restore the launcher when an app closes — also handles Chrome single-instance correctly
async function monitorAndRestoreLauncher(exeName) {
  if (!isWindows) return;
  // Wait a little for the app to start
  await new Promise(r => setTimeout(r, 2000));
  // Watch the process every 1.5s
  const poll = async () => {
    const running = await isProcessRunning(exeName);
    if (!running) {
      // Wait 600ms — for the single-instance handoff to finish
      await new Promise(r => setTimeout(r, 600));
      // Check again
      const stillRunning = await isProcessRunning(exeName);
      if (!stillRunning) {
        // The process is really gone — remove it from launchedApps
        launchedApps = launchedApps.filter(
          a => a.exeName.toLowerCase() !== exeName.toLowerCase()
        );
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('app-exited', exeName);
        }
        return;
      }
    }
    setTimeout(poll, 1500);
  };
  poll();
}

ipcMain.handle('launch-app', (_, appPath, args, appName) => {
  launchApp(appPath, args, appName);
  if (isWindows && appPath) {
    const exeName = path.basename(appPath);
    monitorAndRestoreLauncher(exeName);
  }
  return { ok: true };
});

ipcMain.handle('restart-pc', () => {
  if (isWindows) exec('shutdown /r /t 0', { windowsHide: true });
  return { ok: true };
});

ipcMain.handle('shutdown-pc', () => {
  if (isWindows) exec('shutdown /s /t 0', { windowsHide: true });
  return { ok: true };
});

ipcMain.handle('kill-process-by-name', (_, exeName) => {
  if (!isWindows) return;
  exec(`taskkill /F /IM "${exeName}" /T`, { windowsHide: true });
});

ipcMain.handle('kill-launched-apps', () => {
  // Restore kiosk mode immediately — so the game doesn't stay in the background
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
    mainWindow.setKiosk(true);
    mainWindow.setFullScreen(true);
    mainWindow.focus();
    mainWindow.moveTop();
  }
  // Restart the Alt+Tab blocker (the game has ended)
  startAltTabBlocker();
  if (!isWindows) return;
  const toKill = [...launchedApps];
  launchedApps = [];
  // Kill tracked apps (together with child processes, /T)
  for (const app of toKill) {
    exec(`taskkill /F /IM "${app.exeName}" /T`, { windowsHide: true });
  }
  // Also kill Steam, Epic and their child games
  const knownLaunchers = [
    'steam.exe', 'epicgameslauncher.exe', 'epicwebhelper.exe',
    'gameoverlayui.exe', 'steamwebhelper.exe', 'steamservice.exe',
    'battle.net.exe', 'agent.exe', 'upc.exe', 'ubisoft connect.exe',
    'origin.exe', 'eadesktop.exe',
  ];
  for (const exe of knownLaunchers) {
    exec(`taskkill /F /IM "${exe}" /T`, { windowsHide: true });
  }
});

// ── ANTI-CHEAT ────────────────────────────────────────────────────────────
const CHEAT_PROCS = [
  'cheatengine','cheatengine-x86_64','processhacker','processhacker2',
  'artmoney','artmoney64','xenos','xenos64','extremeinjector','extreme_injector',
  'winject','dllinjector','skidded','hwidspoofer','hwid_spoofer',
  'aimware','aimbot','triggerbot','bhoptool','spinbot','bhopper',
  'multihack','norecoil','wallhack','glowhack','esp_tool',
  'weaponentchanger','cheatclient','hackpro',
];
const CHEAT_WORDS = [
  'cheat','aimbot','wallhack','triggerbot','bhop','spinbot',
  'injector','bypass','hwid','spoofer','norecoil','aimhack',
  'glowhack','hackpro','cheatengine','processhacker',
];

function isCheatName(name) {
  const n = name.toLowerCase().replace(/[\s_\-.()\[\]]/g, '');
  return CHEAT_PROCS.some(c => n.includes(c.replace(/[\s_\-]/g, '')))
      || CHEAT_WORDS.some(w => n.includes(w));
}

function notifyCheat(type, name) {
  console.warn(`[anti-cheat] Topildi (${type}): ${name}`);
  if (mainWindow && !mainWindow.isDestroyed())
    mainWindow.webContents.send('cheat-detected', { type, name });
  axios.post(
    `${API}/sessions/computer/${agentConfig.computer_id}/anticheat`,
    { type, name }, { timeout: 3000 }
  ).catch(() => {});
}

function checkCheatProcesses() {
  if (!isWindows) return;
  exec('tasklist /FO CSV /NH', { windowsHide: true, timeout: 8000 }, (_, stdout) => {
    if (!stdout) return;
    for (const line of stdout.trim().split(/\r?\n/)) {
      const cols = line.match(/"([^"]*)"/g)?.map(s => s.slice(1, -1)) || [];
      if (cols.length < 2) continue;
      const procName = cols[0]; const pid = cols[1];
      if (!isCheatName(procName.replace(/\.exe$/i, ''))) continue;
      exec(`taskkill /F /PID ${pid}`, { windowsHide: true });
      notifyCheat('process', procName);
    }
  });
}

const BLOCKED_EXT = /\.(exe|dll|bat|cmd|ps1|scr|vbs|com|pif|msi|msp)$/i;

function cleanDir(dir) {
  try {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      if (!BLOCKED_EXT.test(f)) continue;
      const full = path.join(dir, f);
      try {
        const stat = fs.statSync(full);
        if (!stat.isFile()) continue;
        fs.unlinkSync(full);
        notifyCheat('file', f);
      } catch {}
    }
  } catch {}
}

function watchDownloads() {
  if (!isWindows) return;
  const profile = process.env.USERPROFILE || process.env.HOMEPATH || '';
  const watchDirs = [
    path.join(profile, 'Downloads'),
    path.join(profile, 'Desktop'),
  ];
  watchDirs.forEach(dir => {
    // Clean up existing files on startup
    cleanDir(dir);
    try {
      if (!fs.existsSync(dir)) return;
      fs.watch(dir, (_, filename) => {
        if (!filename || !BLOCKED_EXT.test(filename)) return;
        setTimeout(() => {
          const full = path.join(dir, filename);
          try { if (fs.existsSync(full) && fs.statSync(full).isFile()) { fs.unlinkSync(full); notifyCheat('file', filename); } } catch {}
        }, 800);
      });
    } catch {}
  });
}

function startAntiCheat() {
  watchDownloads();
  checkCheatProcesses();
  setInterval(() => checkCheatProcesses(), 30 * 1000);
  // Also clean the folders every 5 minutes (fs.watch sometimes misses events)
  const profile = process.env.USERPROFILE || process.env.HOMEPATH || '';
  setInterval(() => {
    cleanDir(path.join(profile, 'Downloads'));
    cleanDir(path.join(profile, 'Desktop'));
  }, 5 * 60 * 1000);
}

// ── CLEAN UP USER FILES WHEN THE SESSION ENDS ─────────────────────────────
function deleteDirContents(dir, maxAgeMs) {
  try {
    if (!fs.existsSync(dir)) return 0;
    let deleted = 0;
    const cutoff = maxAgeMs ? Date.now() - maxAgeMs : null;
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      try {
        const stat = fs.statSync(full);
        if (cutoff && stat.mtimeMs < cutoff) continue; // Don't touch old files (games)
        if (stat.isDirectory()) {
          deleteDirContents(full);
          try { fs.rmdirSync(full); } catch {}
        } else {
          fs.unlinkSync(full);
          deleted++;
        }
      } catch {}
    }
    return deleted;
  } catch { return 0; }
}

// Desktop cleanup: only executable files; shortcuts (.lnk) stay
function cleanDesktop(dir) {
  try {
    if (!fs.existsSync(dir)) return 0;
    let deleted = 0;
    for (const f of fs.readdirSync(dir)) {
      if (/\.lnk$/i.test(f)) continue; // Don't touch shortcuts
      const full = path.join(dir, f);
      try {
        const stat = fs.statSync(full);
        if (stat.isDirectory()) continue; // Don't touch folders
        if (!BLOCKED_EXT.test(f)) continue; // Only exe/dll/bat...
        fs.unlinkSync(full);
        deleted++;
      } catch {}
    }
    return deleted;
  } catch { return 0; }
}

function cleanupUserFiles() {
  if (!isWindows) return;
  const profile = process.env.USERPROFILE || process.env.HOMEPATH || '';
  const temp = process.env.TEMP || path.join(profile, 'AppData', 'Local', 'Temp');
  let total = 0;
  // Downloads: all files are deleted (user downloads)
  total += deleteDirContents(path.join(profile, 'Downloads'), null);
  // Desktop: only exe/dll/bat — shortcuts (.lnk) stay
  total += cleanDesktop(path.join(profile, 'Desktop'));
  // Temp: files older than 24 hours (doesn't touch games' active temp files)
  total += deleteDirContents(temp, 24 * 60 * 60 * 1000);
  if (total > 0) console.log(`[cleanup] Sessiya tugadi: ${total} ta fayl o'chirildi`);
  reportDiskSpace();
}

// ── FREE DISK SPACE MONITORING ────────────────────────────────────────────
function getDiskFreeGB() {
  return new Promise((resolve) => {
    if (!isWindows) { resolve(null); return; }
    exec('wmic logicaldisk where "DeviceID=\'C:\'" get FreeSpace /value', { windowsHide: true }, (_, out) => {
      const m = (out || '').match(/FreeSpace=(\d+)/);
      resolve(m ? parseInt(m[1]) / 1e9 : null);
    });
  });
}

async function reportDiskSpace() {
  const gb = await getDiskFreeGB();
  if (gb === null) return;
  console.log(`[disk] Bo'sh joy: ${gb.toFixed(1)} GB`);
  if (mainWindow && !mainWindow.isDestroyed())
    mainWindow.webContents.send('disk-status', { freeGb: parseFloat(gb.toFixed(1)) });
  if (gb < 5) {
    axios.post(
      `${API}/sessions/computer/${agentConfig.computer_id}/anticheat`,
      { type: 'disk_low', name: `${gb.toFixed(1)} GB qoldi` },
      { timeout: 3000 }
    ).catch(() => {});
  }
}

function startDiskMonitor() {
  reportDiskSpace();
  setInterval(() => reportDiskSpace(), 15 * 60 * 1000); // every 15 minutes
}

ipcMain.handle('get-apps', async () => {
  if (!labApps.length) await fetchLabApps();
  return labApps;
});

// List of running windowed processes on Windows
ipcMain.handle('get-running-processes', () => new Promise((resolve) => {
  if (!isWindows) { resolve([]); return; }
  exec('tasklist /v /FO CSV /NH', { timeout: 5000, windowsHide: true }, (err, stdout) => {
    if (err || !stdout) { resolve([]); return; }
    const procs = [];
    for (const line of stdout.trim().split(/\r?\n/)) {
      try {
        const cols = line.match(/"([^"]*)"/g)?.map(s => s.slice(1, -1)) || [];
        if (cols.length < 9) continue;
        const title = cols[8];
        if (!title || title === 'N/A') continue;
        procs.push({ name: cols[0], title });
      } catch {}
    }
    resolve(procs);
  });
}));

app.on('before-quit', async (e) => {
  if (isWindows && !allowQuit) { e.preventDefault(); return; }
  try { if (altTabBlockerProc) altTabBlockerProc.kill(); } catch {}
  restoreWindowsTaskbar();
  if (!sessionEndedForQuit) {
    const sess = readLocalSession();
    if (sess?.token && sess?.session_id) {
      e.preventDefault();
      sessionEndedForQuit = true;
      try {
        await axios.post(`${API}/sessions/${sess.session_id}/end`, {}, {
          headers: { Authorization: `Bearer ${sess.token}` },
          timeout: 5000,
        });
      } catch {}
      clearLocalSession();
      app.quit();
    }
  }
});

app.on('window-all-closed', () => {
  if (!allowQuit) return;
  globalShortcut.unregisterAll();
  clearInterval(syncInterval);
  clearInterval(heartbeatInterval);
  clearInterval(commandInterval);
  clearInterval(themeOnlyInterval);
  clearInterval(themeManifestInterval);
  if (process.platform !== 'darwin') app.quit();
});

// Allow admin exit
ipcMain.handle('allow-quit', () => {
  allowQuit = true;
});

// Ctrl+Shift+Alt+X → password dialog → exit
let exitDialogWin = null;
ipcMain.on('admin-exit-prompt', () => {
  if (exitDialogWin && !exitDialogWin.isDestroyed()) { exitDialogWin.focus(); return; }
  exitDialogWin = new BrowserWindow({
    width: 340, height: 180,
    frame: false, resizable: false, movable: true,
    alwaysOnTop: true, skipTaskbar: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  exitDialogWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`
    <!DOCTYPE html><html><head><meta charset="UTF-8">
    <style>
      *{margin:0;padding:0;box-sizing:border-box;font-family:'Segoe UI',sans-serif}
      body{background:#0f0f1a;display:flex;align-items:center;justify-content:center;height:100vh}
      .box{background:#1a1a2e;border:1px solid #333;border-radius:12px;padding:24px;width:300px}
      h3{color:#fff;font-size:14px;margin-bottom:14px;text-align:center}
      input{width:100%;padding:10px 12px;background:#0d0d1a;border:1px solid #444;border-radius:8px;color:#fff;font-size:14px;outline:none;margin-bottom:12px}
      input:focus{border-color:#27e0ff}
      .btns{display:flex;gap:8px}
      button{flex:1;padding:9px;border-radius:8px;border:none;cursor:pointer;font-size:13px;font-weight:600}
      .ok{background:#27e0ff22;color:#27e0ff;border:1px solid #27e0ff44}
      .cancel{background:#ffffff11;color:#666;border:1px solid #333}
      .err{color:#ef4444;font-size:12px;text-align:center;margin-bottom:8px;display:none}
    </style></head><body>
    <div class="box">
      <h3>🔐 Admin chiqish</h3>
      <div class="err" id="err">Noto'g'ri parol</div>
      <input type="password" id="p" placeholder="Parol..." autofocus>
      <div class="btns">
        <button class="cancel" onclick="close()">Bekor</button>
        <button class="ok" onclick="check()">Chiqish</button>
      </div>
    </div>
    <script>
      const {ipcRenderer}=require('electron');
      document.getElementById('p').addEventListener('keydown',e=>{if(e.key==='Enter')check();if(e.key==='Escape')close();});
      function check(){ipcRenderer.send('admin-exit-check',document.getElementById('p').value);}
      function close(){ipcRenderer.send('admin-exit-cancel');}
      ipcRenderer.on('admin-exit-wrong',()=>{
        const e=document.getElementById('err');e.style.display='block';
        document.getElementById('p').value='';document.getElementById('p').focus();
      });
    </script></body></html>
  `));
});
ipcMain.on('admin-exit-check', (_, password) => {
  if (password === agentConfig.exit_password) {
    if (exitDialogWin && !exitDialogWin.isDestroyed()) exitDialogWin.close();
    allowQuit = true;
    globalShortcut.unregisterAll();
    clearInterval(syncInterval); clearInterval(heartbeatInterval);
    clearInterval(commandInterval); clearInterval(themeOnlyInterval);
    clearInterval(themeManifestInterval);
    restoreWindowsTaskbar();
    restoreDesktopEnv();
    if (mainWindow) { mainWindow.setKiosk(false); mainWindow.setClosable(true); }
    setTimeout(() => app.quit(), 300);
  } else {
    if (exitDialogWin && !exitDialogWin.isDestroyed())
      exitDialogWin.webContents.send('admin-exit-wrong');
  }
});
ipcMain.on('admin-exit-cancel', () => {
  if (exitDialogWin && !exitDialogWin.isDestroyed()) exitDialogWin.close();
});

// ── GAMES: LOCAL SCAN ─────────────────────────────────────────────────────
const GAME_CACHE_FILE = path.join(app.getPath('userData'), 'games_cache.json');

function loadGameCache() {
  try { return JSON.parse(fs.readFileSync(GAME_CACHE_FILE, 'utf8')); }
  catch { return {}; }
}

function saveGameCache(cache) {
  try { fs.writeFileSync(GAME_CACHE_FILE, JSON.stringify(cache, null, 2)); } catch {}
}

function getSteamRoot() {
  if (process.platform !== 'win32') return null;
  try {
    const { execSync } = require('child_process');
    const out = execSync('reg query "HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam" /v InstallPath 2>nul', { encoding: 'utf8' });
    return out.match(/InstallPath\s+REG_SZ\s+(.+)/)?.[1]?.trim() || null;
  } catch { return null; }
}

function getSteamLibraries() {
  const steamPath = getSteamRoot();
  if (!steamPath) return [];
  const libs = [path.join(steamPath, 'steamapps', 'common')];
  const vdfPath = path.join(steamPath, 'steamapps', 'libraryfolders.vdf');
  try {
    if (fs.existsSync(vdfPath)) {
      const vdf = fs.readFileSync(vdfPath, 'utf8');
      for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) {
        libs.push(path.join(m[1].replace(/\\\\/g, '\\'), 'steamapps', 'common'));
      }
    }
  } catch {}
  return libs;
}

// Finds all installed Steam games from the ACF manifests
function discoverSteamGames() {
  const steamPath = getSteamRoot();
  if (!steamPath) return [];
  const results = [];

  // Find all steamapps folders
  const steamappsDirs = [path.join(steamPath, 'steamapps')];
  const vdfPath = path.join(steamPath, 'steamapps', 'libraryfolders.vdf');
  try {
    if (fs.existsSync(vdfPath)) {
      const vdf = fs.readFileSync(vdfPath, 'utf8');
      for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) {
        steamappsDirs.push(path.join(m[1].replace(/\\\\/g, '\\'), 'steamapps'));
      }
    }
  } catch {}

  for (const steamappsDir of steamappsDirs) {
    if (!fs.existsSync(steamappsDir)) continue;
    let files;
    try { files = fs.readdirSync(steamappsDir); } catch { continue; }

    for (const f of files) {
      if (!f.startsWith('appmanifest_') || !f.endsWith('.acf')) continue;
      try {
        const acf = fs.readFileSync(path.join(steamappsDir, f), 'utf8');
        const appId = acf.match(/"appid"\s+"(\d+)"/)?.[1];
        const name  = acf.match(/"name"\s+"([^"]+)"/)?.[1];
        const installDir = acf.match(/"installdir"\s+"([^"]+)"/)?.[1];
        if (!name || !installDir) continue;

        const gameDir = path.join(steamappsDir, 'common', installDir);
        if (!fs.existsSync(gameDir)) continue;

        // Find the main exe (the largest exe — usually the launcher)
        let mainExe = null;
        let maxSize = 0;
        try {
          const scanDir = (dir, depth = 0) => {
            if (depth > 3) return;
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
              if (entry.isDirectory() && depth < 3) {
                scanDir(path.join(dir, entry.name), depth + 1);
              } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.exe')) {
                const fullPath = path.join(dir, entry.name);
                const size = fs.statSync(fullPath).size;
                if (size > maxSize && size > 1024 * 1024) { // > 1MB
                  maxSize = size;
                  mainExe = fullPath;
                }
              }
            }
          };
          scanDir(gameDir);
        } catch {}

        results.push({
          steam_app_id: appId,
          name,
          install_dir: gameDir,
          exe_path: mainExe || '',
          exe_size_mb: mainExe ? Math.round(maxSize / 1024 / 1024) : 0,
        });
      } catch {}
    }
  }

  return results.sort((a, b) => a.name.localeCompare(b.name));
}

// Finds non-Steam games in common folders
function discoverNonSteamGames() {
  const SKIP_FOLDERS = new Set([
    'windows', 'system32', 'syswow64', 'program files', 'program files (x86)',
    'programdata', 'users', 'temp', 'tmp', 'appdata', 'microsoft',
    'common files', 'internet explorer', 'windows defender', 'windows nt',
    'node_modules', '.git', 'steam', 'steamapps',
  ]);

  const SCAN_ROOTS = [
    'C:\\Games', 'D:\\Games', 'E:\\Games', 'F:\\Games',
    'C:\\O\'yinlar', 'D:\\O\'yinlar',
    'C:\\Program Files (x86)', 'C:\\Program Files',
    'D:\\Program Files (x86)', 'D:\\Program Files',
    'C:\\Games Files', 'D:\\GameFiles',
    'C:\\Epic Games', 'D:\\Epic Games',
    'C:\\Riot Games', 'D:\\Riot Games',
    'C:\\GOG Games', 'D:\\GOG Games',
    'C:\\Battle.net', 'D:\\Battle.net',
  ];

  // Also check the "Games" folder on each drive
  for (const drive of ['C', 'D', 'E', 'F', 'G']) {
    const p = `${drive}:\\Games`;
    if (!SCAN_ROOTS.includes(p)) SCAN_ROOTS.push(p);
  }

  const results = [];
  const seen = new Set(); // to avoid duplicate names

  const findMainExe = (dir) => {
    let best = null, bestSize = 0;
    try {
      const scan = (d, depth) => {
        if (depth > 4) return;
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          if (e.isDirectory() && depth < 4) {
            scan(path.join(d, e.name), depth + 1);
          } else if (e.isFile() && e.name.toLowerCase().endsWith('.exe')) {
            try {
              const size = fs.statSync(path.join(d, e.name)).size;
              if (size > bestSize && size > 512 * 1024) { // > 512KB
                bestSize = size;
                best = path.join(d, e.name);
              }
            } catch {}
          }
        }
      };
      scan(dir, 0);
    } catch {}
    return best;
  };

  for (const root of SCAN_ROOTS) {
    if (!fs.existsSync(root)) continue;
    let entries;
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const nameLower = entry.name.toLowerCase();
      if (SKIP_FOLDERS.has(nameLower)) continue;
      if (nameLower.startsWith('.')) continue;
      if (seen.has(nameLower)) continue;

      const gameDir = path.join(root, entry.name);
      const mainExe = findMainExe(gameDir);
      if (!mainExe) continue; // no exe — not a game

      seen.add(nameLower);
      results.push({
        steam_app_id: null,
        name: entry.name,
        install_dir: gameDir,
        exe_path: mainExe,
        exe_size_mb: Math.round(fs.statSync(mainExe).size / 1024 / 1024),
        source: 'local',
      });
    }
  }

  return results.sort((a, b) => a.name.localeCompare(b.name));
}

ipcMain.handle('games:steam-discover', async () => {
  return discoverSteamGames();
});

ipcMain.handle('games:all-discover', async () => {
  const steam = discoverSteamGames();
  const local = discoverNonSteamGames();
  // Remove duplicate names (if it's in the Steam list, remove it from local)
  const steamNames = new Set(steam.map(g => g.name.toLowerCase()));
  const unique = local.filter(g => !steamNames.has(g.name.toLowerCase()));
  return [...steam, ...unique];
});

// All directories to search
function getAllSearchDirs() {
  return [
    ...getSteamLibraries(),
    'C:\\Games', 'D:\\Games', 'E:\\Games', 'F:\\Games',
    'C:\\O\'yinlar', 'D:\\O\'yinlar',
    'C:\\Program Files (x86)', 'C:\\Program Files',
    'D:\\Program Files (x86)', 'D:\\Program Files',
    'C:\\Epic Games', 'D:\\Epic Games',
    'C:\\GOG Games', 'D:\\GOG Games',
    'C:\\Riot Games', 'D:\\Riot Games',
    'C:\\Battle.net', 'D:\\Battle.net',
  ].filter(d => fs.existsSync(d));
}

// Finds a folder by game name (fuzzy match)
function findGameByName(gameName, searchDirs) {
  const nameNorm = gameName.toLowerCase().replace(/[^a-z0-9]/g, '');
  let best = null, bestScore = 0;

  for (const dir of searchDirs) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const entryNorm = entry.name.toLowerCase().replace(/[^a-z0-9]/g, '');

      // Calculate the match score
      let score = 0;
      if (entryNorm === nameNorm) score = 100;
      else if (entryNorm.includes(nameNorm) || nameNorm.includes(entryNorm)) score = 70;
      else {
        // If the first 4 letters match
        const minLen = Math.min(nameNorm.length, entryNorm.length);
        let common = 0;
        for (let i = 0; i < minLen; i++) {
          if (nameNorm[i] === entryNorm[i]) common++;
          else break;
        }
        if (common >= 4) score = 40 + common;
      }

      if (score > bestScore) {
        bestScore = score;
        best = { dir: path.join(dir, entry.name), score };
      }
    }
  }

  if (!best || best.score < 40) return null;

  // Find the largest exe in the found folder
  let mainExe = null, maxSize = 0;
  try {
    const scan = (d, depth) => {
      if (depth > 3) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory() && depth < 3) scan(path.join(d, e.name), depth + 1);
        else if (e.isFile() && e.name.toLowerCase().endsWith('.exe')) {
          try {
            const sz = fs.statSync(path.join(d, e.name)).size;
            if (sz > maxSize && sz > 512 * 1024) { maxSize = sz; mainExe = path.join(d, e.name); }
          } catch {}
        }
      }
    };
    scan(best.dir, 0);
  } catch {}

  return mainExe;
}

ipcMain.handle('games:scan', async (_, games) => {
  const cache = loadGameCache();
  const searchDirs = getAllSearchDirs();
  const toReport = []; // to send to the server

  for (const game of games) {
    if (cache[game.id]?.manual) continue;

    let foundPath = null;

    // 1. Full path given and it exists (try even without the .exe extension)
    if (game.exe_path) {
      const p = game.exe_path.trim();
      if (fs.existsSync(p)) {
        foundPath = p;
      } else if (!p.toLowerCase().endsWith('.exe') && fs.existsSync(p + '.exe')) {
        foundPath = p + '.exe';
      }
    }

    // 2. Search by exe name (exe_path given but not a full path)
    if (!foundPath && game.exe_path) {
      let exeName = path.basename(game.exe_path.trim());
      if (!exeName.toLowerCase().endsWith('.exe')) exeName += '.exe';
      for (const dir of searchDirs) {
        try {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const candidate = path.join(dir, entry.name, exeName);
            if (fs.existsSync(candidate)) { foundPath = candidate; break; }
          }
        } catch {}
        if (foundPath) break;
      }
    }

    // 3. exe_path empty — search for a folder by game name
    if (!foundPath && game.name) {
      foundPath = findGameByName(game.name, searchDirs);
    }

    const prev = cache[game.id];
    cache[game.id] = { exe_path: foundPath, verified: !!foundPath, manual: false };

    // Newly found — notify the server
    if (foundPath && foundPath !== prev?.exe_path && game.id) {
      toReport.push({ id: game.id, exe_path: path.basename(foundPath) });
    }
  }

  saveGameCache(cache);

  // Send the found exe paths to the server (with agentAuth)
  if (toReport.length) {
    const agentSecret = process.env.AGENT_SECRET || '';
    for (const g of toReport) {
      axios.patch(`${API}/games/${g.id}/exe-path`,
        { exe_path: g.exe_path },
        { headers: { 'X-Agent-Secret': agentSecret }, timeout: 5000 }
      ).catch(() => {});
    }
    console.log(`[games] ${toReport.length} ta o'yin exe topildi, serverga yuborildi`);
  }

  return cache;
});

ipcMain.handle('games:get-cache', () => loadGameCache());

ipcMain.handle('games:browse', async () => {
  const { dialog } = require('electron');
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'O\'yin exe faylini tanlang',
    filters: [{ name: 'Executable', extensions: ['exe'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

ipcMain.handle('games:set-path', async (_, gameId, exePath) => {
  const cache = loadGameCache();
  if (exePath) {
    cache[gameId] = { exe_path: exePath, verified: true, manual: true };
  } else {
    delete cache[gameId];
  }
  saveGameCache(cache);
  return { ok: true };
});

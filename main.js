const { app, BrowserWindow, desktopCapturer, ipcMain, session, systemPreferences, shell, dialog, Tray, Menu, nativeImage, screen, globalShortcut } = require('electron');
const { autoUpdater } = require('electron-updater');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Prevent multiple instances from fighting over the audio session
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }

// Prevent Chromium from throttling background/occluded windows (critical for wallpaper mode)
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

let mainWindow;
let audioProcess = null;
let nowPlayingProcess = null;
let tray = null;
let wallpaperMode = false;
let wallpaperWindow = null; // separate desktop-level window
let mousePoller = null; // interval for polling cursor in wallpaper mode

// In packaged app, extraResources land under process.resourcesPath
function getNativeBinaryPath() {
    const packaged = path.join(process.resourcesPath, 'native', 'capture-audio');
    const dev = path.join(__dirname, 'native', 'capture-audio');
    return app.isPackaged ? packaged : dev;
}

function killAudioProcess() {
    if (audioProcess) {
        audioProcess.kill();
    }
}

function createWindow() {
    mainWindow = new BrowserWindow({
        title: 'Grid Visualizer',
        width: 1280,
        height: 800,
        backgroundColor: '#000',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    mainWindow.loadFile('index.html');
    // On Windows/Linux, hide the default menu bar (macOS menu bar is always global)
    if (process.platform !== 'darwin') mainWindow.setMenuBarVisibility(false);

    mainWindow.webContents.on('before-input-event', (event, input) => {
        if (input.key === 'F11') mainWindow.setFullScreen(!mainWindow.isFullScreen());
        if (input.key === 'F12') mainWindow.webContents.toggleDevTools();
    });
}

// Focus existing window if a second instance launches
app.on('second-instance', () => {
    if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
    }
});

// Auto-grant media permissions (mic, screen capture)
app.whenReady().then(async () => {
    // Don't prompt for mic at startup — let the user trigger it via Space key.
    // The permission dialog will appear naturally when they first activate audio.

    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
        const allowed = ['media', 'display-capture', 'mediaKeySystem'].includes(permission);
        callback(allowed);
    });

    createWindow();
    setupTray();
    setupAppMenu();

    // Global shortcut to toggle wallpaper mode from anywhere
    globalShortcut.register('CommandOrControl+Shift+W', () => {
        toggleWallpaperMode();
    });

    // ── Auto-update (GitHub Releases) ──────────────────────
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('update-available', (info) => {
        const win = getActiveWindow();
        if (win) win.webContents.send('update-status', { status: 'available', version: info.version });
    });

    autoUpdater.on('update-downloaded', (info) => {
        const win = getActiveWindow();
        if (win) {
            win.webContents.send('update-status', { status: 'ready', version: info.version });
            dialog.showMessageBox(win, {
                type: 'info',
                title: 'Update Ready',
                message: `Version ${info.version} has been downloaded.`,
                detail: 'It will be installed when you quit the app.\nRestart now to update.',
                buttons: ['Restart Now', 'Later'],
                defaultId: 0
            }).then(({ response }) => {
                if (response === 0) autoUpdater.quitAndInstall();
            });
        }
    });

    autoUpdater.on('error', (err) => {
        console.log('Auto-update error:', err.message);
    });

    // Check for updates (silently — no dialog if no update)
    autoUpdater.checkForUpdatesAndNotify().catch(() => {});
});

// ── Manual update check from renderer ─────────────────────────

ipcMain.handle('check-for-update', async () => {
    try {
        const result = await autoUpdater.checkForUpdates();
        return { version: result?.updateInfo?.version || null };
    } catch (e) {
        return { error: e.message };
    }
});

ipcMain.handle('get-app-version', () => app.getVersion());

// ── Permission dialogs ─────────────────────────────────────

ipcMain.handle('check-permissions', () => {
    if (process.platform !== 'darwin') return { microphone: 'granted', screen: 'granted' };
    return {
        microphone: systemPreferences.getMediaAccessStatus('microphone'),
        screen: systemPreferences.getMediaAccessStatus('screen')
    };
});

ipcMain.handle('show-permission-dialog', async (event, type) => {
    const isMic = type === 'microphone';
    const result = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: isMic ? 'Microphone Access Required' : 'Screen Recording Required',
        message: isMic
            ? 'Grid Visualizer needs microphone access to visualize audio.'
            : 'Grid Visualizer needs Screen Recording permission to capture system audio.',
        detail: isMic
            ? 'Click "Open Settings" and enable Electron under Microphone.\nThen click "Try Again".'
            : 'Click "Open Settings" and enable Electron under Screen Recording.\nYou may need to restart the app after enabling.',
        buttons: ['Open Settings', 'Try Again', 'Cancel'],
        defaultId: 0
    });

    if (result.response === 0) {
        shell.openExternal(isMic
            ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
            : 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
        );
    }

    // 0 = opened settings, 1 = try again, 2 = cancel
    return result.response;
});

// ── Native system audio via ScreenCaptureKit ───────────────

ipcMain.handle('has-native-audio', () => {
    return process.platform === 'darwin' && fs.existsSync(getNativeBinaryPath());
});

ipcMain.handle('start-system-audio', () => {
    if (audioProcess) return { ok: true };

    audioProcess = spawn(getNativeBinaryPath());

    audioProcess.on('error', (err) => {
        console.error('capture-audio spawn error:', err.message);
        audioProcess = null;
        const win = getActiveWindow();
        if (win) win.webContents.send('system-audio-error', err.message);
    });

    audioProcess.stdout.on('data', (chunk) => {
        const win = getActiveWindow();
        if (win) win.webContents.send('system-audio-data', chunk);
    });

    audioProcess.stderr.on('data', (data) => {
        const msg = data.toString().trim();
        console.log('capture-audio:', msg);
        if (msg.includes('declined TCCs') || msg.includes('-3801')) {
            const win = getActiveWindow();
            if (win) win.webContents.send('system-audio-permission-denied');
        }
    });

    audioProcess.on('exit', () => {
        audioProcess = null;
        const win = getActiveWindow();
        if (win) win.webContents.send('system-audio-stopped');
    });

    return { ok: true };
});

ipcMain.handle('stop-system-audio', () => {
    killAudioProcess();
    return { ok: true };
});

// ── Fullscreen toggle ────────────────────────────────────────

ipcMain.handle('toggle-fullscreen', () => {
    if (wallpaperMode) return false; // no fullscreen in wallpaper mode
    mainWindow.setFullScreen(!mainWindow.isFullScreen());
    return mainWindow.isFullScreen();
});

// ── Window transparency ──────────────────────────────────────

ipcMain.handle('set-transparency', (event, enabled) => {
    if (wallpaperMode) return; // ignore in wallpaper mode
    mainWindow.setOpacity(enabled ? 0.65 : 1.0);
    mainWindow.setAlwaysOnTop(enabled, 'floating');
});

// ── Now Playing (MediaRemote private framework) ─────────────

function getNowPlayingBinaryPath() {
    const packaged = path.join(process.resourcesPath, 'native', 'now-playing');
    const dev = path.join(__dirname, 'native', 'now-playing');
    return app.isPackaged ? packaged : dev;
}

function killNowPlayingProcess() {
    if (nowPlayingProcess) {
        nowPlayingProcess.kill();
        nowPlayingProcess = null;
    }
}

ipcMain.handle('has-now-playing', () => {
    return process.platform === 'darwin' && fs.existsSync(getNowPlayingBinaryPath());
});

ipcMain.handle('start-now-playing', () => {
    if (nowPlayingProcess) return { ok: true };

    const binPath = getNowPlayingBinaryPath();
    if (!fs.existsSync(binPath)) return { ok: false };

    nowPlayingProcess = spawn(binPath);

    let buffer = '';
    nowPlayingProcess.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
            const win = getActiveWindow();
            if (line.trim() && win) {
                try {
                    const data = JSON.parse(line);
                    win.webContents.send('now-playing-data', data);
                } catch (e) { /* malformed JSON line */ }
            }
        }
    });

    nowPlayingProcess.on('error', () => { nowPlayingProcess = null; });
    nowPlayingProcess.on('exit', () => { nowPlayingProcess = null; });

    return { ok: true };
});

ipcMain.handle('stop-now-playing', () => {
    killNowPlayingProcess();
    return { ok: true };
});

// ── Desktop capturer fallback (Windows/Linux) ──────────────

ipcMain.handle('get-desktop-sources', async () => {
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    return sources.map(s => ({ id: s.id, name: s.name }));
});

// ── Wallpaper Mode ─────────────────────────────────────────

function enterWallpaperMode() {
    if (wallpaperMode) return;
    wallpaperMode = true;

    const display = screen.getPrimaryDisplay();
    const { bounds } = display;

    // Create a desktop-level window (type: 'desktop' places it behind icons)
    wallpaperWindow = new BrowserWindow({
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        type: 'desktop',
        frame: false,
        titleBarStyle: 'hidden',
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        skipTaskbar: true,
        enableLargerThanScreen: true,
        backgroundColor: '#000',
        hasShadow: false,
        roundedCorners: false,
        webPreferences: {
            backgroundThrottling: false,
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    wallpaperWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });

    // Use simpleFullScreen to cover the entire display including menu bar area
    wallpaperWindow.setSimpleFullScreen(true);

    wallpaperWindow.loadFile('index.html');

    wallpaperWindow.webContents.on('did-finish-load', () => {
        wallpaperWindow.webContents.send('wallpaper-mode-changed', true);
    });

    wallpaperWindow.on('closed', () => {
        wallpaperWindow = null;
    });

    // Hide the main window (don't destroy — we restore it later)
    mainWindow.hide();

    // Poll mouse position since desktop windows don't receive mouse events
    mousePoller = setInterval(() => {
        if (wallpaperWindow && !wallpaperWindow.isDestroyed()) {
            const point = screen.getCursorScreenPoint();
            wallpaperWindow.webContents.send('mouse-position', point.x, point.y);
        }
    }, 16); // ~60fps

    updateAudioTarget();
    updateTrayMenu();
}

function exitWallpaperMode() {
    if (!wallpaperMode) return;
    wallpaperMode = false;

    // Stop mouse polling
    if (mousePoller) {
        clearInterval(mousePoller);
        mousePoller = null;
    }

    // Destroy the desktop-level window
    if (wallpaperWindow && !wallpaperWindow.isDestroyed()) {
        wallpaperWindow.close();
        wallpaperWindow = null;
    }

    // Show the main window again
    mainWindow.show();
    mainWindow.focus();

    updateAudioTarget();
    mainWindow.webContents.send('wallpaper-mode-changed', false);
    updateTrayMenu();
}

// Route IPC data to whichever window is currently active
function getActiveWindow() {
    if (wallpaperMode && wallpaperWindow && !wallpaperWindow.isDestroyed()) {
        return wallpaperWindow;
    }
    return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

function updateAudioTarget() {
    // Audio and now-playing data handlers already use getActiveWindow() via send helpers
    // No re-wiring needed — the send calls in stdout handlers check getActiveWindow()
}

function toggleWallpaperMode() {
    if (wallpaperMode) exitWallpaperMode();
    else enterWallpaperMode();
}

ipcMain.handle('toggle-wallpaper', () => {
    toggleWallpaperMode();
    return wallpaperMode;
});

ipcMain.handle('get-wallpaper-state', () => wallpaperMode);

// ── Tray Icon ──────────────────────────────────────────────

function createTrayIcon() {
    // macOS auto-selects @2x for Retina. "Template" suffix tells macOS to tint for dark/light.
    const iconPath = path.join(__dirname, 'build', 'trayTemplate.png');
    const img = nativeImage.createFromPath(iconPath);
    img.setTemplateImage(true);
    return img;
}

function sendTrayAction(action, value) {
    const w = getActiveWindow();
    if (w) w.webContents.send('tray-action', action, value);
}

function updateTrayMenu() {
    if (!tray) return;
    const contextMenu = Menu.buildFromTemplate([
        {
            label: wallpaperMode ? '✓ Wallpaper Mode' : 'Wallpaper Mode',
            click: () => toggleWallpaperMode()
        },
        { type: 'separator' },
        {
            label: 'Wave Mode',
            submenu: [
                { label: 'Ripple',       click: () => sendTrayAction('mode', 1) },
                { label: 'Spiral',       click: () => sendTrayAction('mode', 2) },
                { label: 'Vortex',       click: () => sendTrayAction('mode', 3) },
                { label: 'Interference', click: () => sendTrayAction('mode', 4) },
                { label: 'Dipole',       click: () => sendTrayAction('mode', 5) },
                { label: 'Drift',        click: () => sendTrayAction('mode', 6) },
                { label: 'Gravity',      click: () => sendTrayAction('mode', 7) },
                { label: 'Rain',         click: () => sendTrayAction('mode', 8) },
                { label: 'Noise Field',  click: () => sendTrayAction('mode', 9) },
            ]
        },
        {
            label: 'Color Theme',
            submenu: [
                { label: 'Aurora',  click: () => sendTrayAction('theme', 0) },
                { label: 'Ocean',   click: () => sendTrayAction('theme', 1) },
                { label: 'Fire',    click: () => sendTrayAction('theme', 2) },
                { label: 'Neon',    click: () => sendTrayAction('theme', 3) },
                { label: 'Mono',    click: () => sendTrayAction('theme', 4) },
                { label: 'Pastel',  click: () => sendTrayAction('theme', 5) },
                { label: 'Sunset',  click: () => sendTrayAction('theme', 6) },
                { label: 'Matrix',  click: () => sendTrayAction('theme', 7) },
            ]
        },
        {
            label: 'Audio',
            submenu: [
                { label: 'Cycle Source (Off → Mic → System)', click: () => sendTrayAction('audio-cycle') },
                { label: 'Now Playing',  click: () => sendTrayAction('now-playing') },
            ]
        },
        {
            label: 'Effects',
            submenu: [
                { label: 'Color FX',        click: () => sendTrayAction('toggle', 'color') },
                { label: 'Size FX',         click: () => sendTrayAction('toggle', 'size') },
                { label: 'Color Band',      click: () => sendTrayAction('toggle', 'colorband') },
                { label: 'Freq Band Mode',  click: () => sendTrayAction('toggle', 'freqband') },
                { type: 'separator' },
                { label: 'Pause Physics',   click: () => sendTrayAction('toggle', 'physics') },
                { label: 'Clock Mode',      click: () => sendTrayAction('toggle', 'clock') },
            ]
        },
        { type: 'separator' },
        {
            label: 'Show Window',
            click: () => {
                if (wallpaperMode) exitWallpaperMode();
                mainWindow.show();
                mainWindow.focus();
            }
        },
        { label: 'Quit', click: () => app.quit() }
    ]);
    tray.setContextMenu(contextMenu);
}

function setupTray() {
    tray = new Tray(createTrayIcon());
    tray.setToolTip('Grid Visualizer');
    updateTrayMenu();
}

// ── macOS Application Menu ────────────────────────────────────

function setupAppMenu() {
    const isMac = process.platform === 'darwin';
    if (!isMac) return; // Windows/Linux use tray only

    const template = [
        {
            label: app.name,
            submenu: [
                { role: 'about' },
                { type: 'separator' },
                { role: 'hide' },
                { role: 'hideOthers' },
                { role: 'unhide' },
                { type: 'separator' },
                { role: 'quit' }
            ]
        },
        {
            label: 'View',
            submenu: [
                {
                    label: 'Wallpaper Mode',
                    accelerator: 'CmdOrCtrl+Shift+W',
                    click: () => toggleWallpaperMode()
                },
                { type: 'separator' },
                {
                    label: 'Fullscreen',
                    accelerator: 'F',
                    click: () => { if (mainWindow) mainWindow.setFullScreen(!mainWindow.isFullScreen()); }
                },
                { type: 'separator' },
                { role: 'toggleDevTools' }
            ]
        },
        {
            label: 'Wave Mode',
            submenu: [
                { label: 'Ripple',       accelerator: '1', click: () => sendTrayAction('mode', 1) },
                { label: 'Spiral',       accelerator: '2', click: () => sendTrayAction('mode', 2) },
                { label: 'Vortex',       accelerator: '3', click: () => sendTrayAction('mode', 3) },
                { label: 'Interference', accelerator: '4', click: () => sendTrayAction('mode', 4) },
                { label: 'Dipole',       accelerator: '5', click: () => sendTrayAction('mode', 5) },
                { label: 'Drift',        accelerator: '6', click: () => sendTrayAction('mode', 6) },
                { label: 'Gravity',      accelerator: '7', click: () => sendTrayAction('mode', 7) },
                { label: 'Rain',         accelerator: '8', click: () => sendTrayAction('mode', 8) },
                { label: 'Noise Field',  accelerator: '9', click: () => sendTrayAction('mode', 9) },
            ]
        },
        {
            label: 'Theme',
            submenu: [
                { label: 'Aurora',  click: () => sendTrayAction('theme', 0) },
                { label: 'Ocean',   click: () => sendTrayAction('theme', 1) },
                { label: 'Fire',    click: () => sendTrayAction('theme', 2) },
                { label: 'Neon',    click: () => sendTrayAction('theme', 3) },
                { label: 'Mono',    click: () => sendTrayAction('theme', 4) },
                { label: 'Pastel',  click: () => sendTrayAction('theme', 5) },
                { label: 'Sunset',  click: () => sendTrayAction('theme', 6) },
                { label: 'Matrix',  click: () => sendTrayAction('theme', 7) },
            ]
        },
        {
            label: 'Audio',
            submenu: [
                { label: 'Cycle Source (Off → Mic → System)', accelerator: 'Space', click: () => sendTrayAction('audio-cycle') },
                { label: 'Now Playing', accelerator: 'N', click: () => sendTrayAction('now-playing') },
            ]
        },
        {
            label: 'Effects',
            submenu: [
                { label: 'Color FX',       click: () => sendTrayAction('toggle', 'color') },
                { label: 'Size FX',        click: () => sendTrayAction('toggle', 'size') },
                { label: 'Color Band',     click: () => sendTrayAction('toggle', 'colorband') },
                { label: 'Freq Band Mode', click: () => sendTrayAction('toggle', 'freqband') },
                { type: 'separator' },
                { label: 'Pause Physics', accelerator: 'P', click: () => sendTrayAction('toggle', 'physics') },
                { label: 'Clock Mode',   accelerator: 'K', click: () => sendTrayAction('toggle', 'clock') },
            ]
        },
        {
            label: 'Window',
            submenu: [
                { role: 'minimize' },
                { role: 'zoom' },
                { type: 'separator' },
                { role: 'front' }
            ]
        }
    ];

    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── Lifecycle ──────────────────────────────────────────────

app.on('before-quit', () => {
    killAudioProcess();
    killNowPlayingProcess();
    globalShortcut.unregisterAll();
    if (tray) { tray.destroy(); tray = null; }
});
process.on('exit', () => { killAudioProcess(); killNowPlayingProcess(); });

app.on('window-all-closed', () => {
    if (!wallpaperMode) app.quit();
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

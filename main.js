const { app, BrowserWindow, desktopCapturer, ipcMain, session, systemPreferences, shell, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Prevent multiple instances from fighting over the audio session
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }

let mainWindow;
let audioProcess = null;
let nowPlayingProcess = null;

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
    mainWindow.setMenuBarVisibility(false);

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
    if (process.platform === 'darwin') {
        const micStatus = systemPreferences.getMediaAccessStatus('microphone');
        if (micStatus !== 'granted') {
            await systemPreferences.askForMediaAccess('microphone');
        }
    }

    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
        const allowed = ['media', 'display-capture', 'mediaKeySystem'].includes(permission);
        callback(allowed);
    });

    createWindow();

    // ── Auto-update (GitHub Releases) ──────────────────────
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('update-available', (info) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('update-status', { status: 'available', version: info.version });
        }
    });

    autoUpdater.on('update-downloaded', (info) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('update-status', { status: 'ready', version: info.version });
            dialog.showMessageBox(mainWindow, {
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
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('system-audio-error', err.message);
        }
    });

    audioProcess.stdout.on('data', (chunk) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('system-audio-data', chunk);
        }
    });

    audioProcess.stderr.on('data', (data) => {
        const msg = data.toString().trim();
        console.log('capture-audio:', msg);
        // Detect macOS TCC permission denial
        if (msg.includes('declined TCCs') || msg.includes('-3801')) {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('system-audio-permission-denied');
            }
        }
    });

    audioProcess.on('exit', () => {
        audioProcess = null;
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('system-audio-stopped');
        }
    });

    return { ok: true };
});

ipcMain.handle('stop-system-audio', () => {
    killAudioProcess();
    return { ok: true };
});

// ── Fullscreen toggle ────────────────────────────────────────

ipcMain.handle('toggle-fullscreen', () => {
    mainWindow.setFullScreen(!mainWindow.isFullScreen());
    return mainWindow.isFullScreen();
});

// ── Window transparency ──────────────────────────────────────

ipcMain.handle('set-transparency', (event, enabled) => {
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
        buffer = lines.pop(); // keep incomplete last line in buffer
        for (const line of lines) {
            if (line.trim() && mainWindow && !mainWindow.isDestroyed()) {
                try {
                    const data = JSON.parse(line);
                    mainWindow.webContents.send('now-playing-data', data);
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

// ── Lifecycle ──────────────────────────────────────────────

app.on('before-quit', () => { killAudioProcess(); killNowPlayingProcess(); });
process.on('exit', () => { killAudioProcess(); killNowPlayingProcess(); });

app.on('window-all-closed', () => app.quit());

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

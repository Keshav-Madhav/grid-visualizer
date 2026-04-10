const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    isElectron: true,
    platform: process.platform,

    // Updates
    checkForUpdate: () => ipcRenderer.invoke('check-for-update'),
    getAppVersion: () => ipcRenderer.invoke('get-app-version'),
    onUpdateStatus: (callback) => {
        ipcRenderer.removeAllListeners('update-status');
        ipcRenderer.on('update-status', (event, data) => callback(data));
    },

    // Permissions
    checkPermissions: () => ipcRenderer.invoke('check-permissions'),
    showPermissionDialog: (type) => ipcRenderer.invoke('show-permission-dialog', type),

    // Native ScreenCaptureKit audio (macOS)
    hasNativeAudio: () => ipcRenderer.invoke('has-native-audio'),
    startSystemAudio: () => ipcRenderer.invoke('start-system-audio'),
    stopSystemAudio: () => ipcRenderer.invoke('stop-system-audio'),
    onAudioData: (callback) => {
        ipcRenderer.removeAllListeners('system-audio-data');
        ipcRenderer.on('system-audio-data', (event, data) => {
            const float32 = new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4);
            callback(float32);
        });
    },
    onAudioStopped: (callback) => {
        ipcRenderer.removeAllListeners('system-audio-stopped');
        ipcRenderer.on('system-audio-stopped', callback);
    },
    onAudioPermissionDenied: (callback) => {
        ipcRenderer.removeAllListeners('system-audio-permission-denied');
        ipcRenderer.on('system-audio-permission-denied', callback);
    },
    onAudioError: (callback) => {
        ipcRenderer.removeAllListeners('system-audio-error');
        ipcRenderer.on('system-audio-error', (event, msg) => callback(msg));
    },
    removeAudioListeners: () => {
        ipcRenderer.removeAllListeners('system-audio-data');
        ipcRenderer.removeAllListeners('system-audio-stopped');
        ipcRenderer.removeAllListeners('system-audio-permission-denied');
        ipcRenderer.removeAllListeners('system-audio-error');
    },

    // Fullscreen / transparency
    toggleFullscreen: () => ipcRenderer.invoke('toggle-fullscreen'),
    setTransparency: (enabled) => ipcRenderer.invoke('set-transparency', enabled),

    // Now Playing (MediaRemote)
    hasNowPlaying: () => ipcRenderer.invoke('has-now-playing'),
    startNowPlaying: () => ipcRenderer.invoke('start-now-playing'),
    stopNowPlaying: () => ipcRenderer.invoke('stop-now-playing'),
    onNowPlaying: (callback) => {
        ipcRenderer.removeAllListeners('now-playing-data');
        ipcRenderer.on('now-playing-data', (event, data) => callback(data));
    },
    removeNowPlayingListener: () => {
        ipcRenderer.removeAllListeners('now-playing-data');
    },

    // Desktop capturer fallback (Windows/Linux)
    getDesktopSources: () => ipcRenderer.invoke('get-desktop-sources'),

    // Wallpaper mode
    toggleWallpaper: () => ipcRenderer.invoke('toggle-wallpaper'),
    getWallpaperState: () => ipcRenderer.invoke('get-wallpaper-state'),
    onWallpaperModeChanged: (callback) => {
        ipcRenderer.removeAllListeners('wallpaper-mode-changed');
        ipcRenderer.on('wallpaper-mode-changed', (event, enabled) => callback(enabled));
    },
    onMousePosition: (callback) => {
        ipcRenderer.removeAllListeners('mouse-position');
        ipcRenderer.on('mouse-position', (event, x, y) => callback(x, y));
    },
    onSetMode: (callback) => {
        ipcRenderer.removeAllListeners('set-mode');
        ipcRenderer.on('set-mode', (event, mode) => callback(mode));
    },
    onTrayAction: (callback) => {
        ipcRenderer.removeAllListeners('tray-action');
        ipcRenderer.on('tray-action', (event, action, value) => callback(action, value));
    }
});

// ── Canvas Setup (WebGL + 2D Overlay) ──────────────────
const glCanvas = document.getElementById('glCanvas');
const gl = glCanvas.getContext('webgl', { antialias: false, alpha: false })
        || glCanvas.getContext('experimental-webgl', { antialias: false, alpha: false });
const canvas = document.getElementById('overlayCanvas'); // events + cursor/debug
const ctx = canvas.getContext('2d');

// Logical (CSS) dimensions — used everywhere instead of canvas.width/height
let logicalW = window.innerWidth;
let logicalH = window.innerHeight;

// Camera
const camera = {
    x: 0,
    y: 0,
    lastMouseX: 0,
    lastMouseY: 0,
    clientX: 0,
    clientY: 0
};

let zoomFactor = 0.5;
let zoomSpeed = 0.04;
let camSpeed = 5;
let isDragging = false;
let isShiftHeld = false;
let isAltHeld = false;

// Input
const keys = {
    ArrowUp: false,
    ArrowDown: false,
    ArrowLeft: false,
    ArrowRight: false
};

// Delta time
let lastTime = performance.now();

// Grid
let gridSpacing = 25;
let gridOriginX = 0;
let gridOriginY = 0;
const gridSpacingStep = 5;
const gridSpacingMin = 5;
const gridSpacingMax = 200;
const dotRadius = 2.5;
const dotColor = '#ffffff';

// Active dots
const activeDots = new Map();
let activeKeySet = new Set(); // pre-built each frame for O(1) draw-loop checks

// Spring physics — underdamped, snappy
const springK = 28;
const springDamp = 4.2;

// Sleep thresholds
const sleepPosThr = 0.25;
const sleepVelThr = 0.3;

// Mouse force — radius tied to cursor size
let mouseForceRadius = 120;
const mouseForceStrength = 12000;
let mouseWorld = { x: 0, y: 0 };
let mouseHasEntered = false;

// Neighbor interactions
const NEIGHBORS = [-1,-1, -1,0, -1,1, 0,-1, 0,1, 1,-1, 1,0, 1,1];
const repelRadius = 0.65;
const repelStrength = 800;

// Cursor circle — scalable via alt+scroll
const cursor = {
    x: -100,
    y: -100,
    radius: 30,
    targetRadius: 30,
    baseRadius: 30,
    expandedRadius: 100,
    minBase: 10,
    maxBase: 400,
    sizeStep: 8,
    lineWidth: 1.5,
    color: 'rgba(255, 255, 255, 0.7)',
    isPressed: false
};

// Wave modes
let waveActive = true;
let waveOrigin = { x: 0, y: 0 };
let waveTime = 0;
let waveMode = 9;
let ringRadii = [];

const MODE_NAMES = {
    1: 'RIPPLE',
    2: 'SPIRAL',
    3: 'VORTEX',
    4: 'INTERFERENCE',
    5: 'DIPOLE',
    6: 'DRIFT',
    7: 'GRAVITY',
    8: 'RAIN',
    9: 'NOISE FIELD',
    0: 'TYPE'
};

// Type mode (mode 0)
let typeMode = false;
let typeText = '';

// Simple noise (seeded hash for noise field mode)
function hashNoise(x, y) {
    let n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return n - Math.floor(n);
}
function smoothNoise(x, y) {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = x - ix, fy = y - iy;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = hashNoise(ix, iy), b = hashNoise(ix + 1, iy);
    const c = hashNoise(ix, iy + 1), d = hashNoise(ix + 1, iy + 1);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

// Mode label overlay
let modeLabel = '';
let modeLabelAlpha = 0;

// Constants
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const TWO_PI = Math.PI * 2;

// Distance-based spring falloff
const waveFalloffRate = 0.003;
const waveFalloffFloor = 0.08;

// LOD
let lodStep = 1;
const LOD_MIN_SCREEN_GAP = 4;

// Visual FX toggles (type "color" / "size" to toggle)
let fxColor = true;
let fxSize = false;

// Mic input (type "mic" to toggle)
let micActive = false;
let micAutoStartPending = true;
let audioSwitching = false; // guard against concurrent toggles
let audioSource = 'off'; // 'off', 'mic', 'sys'
let activeAudioCtx = null;  // stored so stopAudio can close it
let activeStream = null;    // stored so stopAudio can stop tracks
let micAnalyser = null;
let micData = null;      // raw frequency data (Uint8Array)
let micSmoothed = null;  // smoothed frequency data (Float32Array)
let micPeak = 0;         // overall peak for debug

// Mic propagation — ring buffer of recent peak values for outward-traveling waves
const MIC_PROP_SIZE = 180;
const micPropBuf = new Float32Array(MIC_PROP_SIZE);
let micPropHead = 0;

// ── Color Themes ────────────────────────────────────────
const COLOR_THEMES = {
    AURORA: [
        { t: 0.00, r: 255, g: 255, b: 255 },
        { t: 0.20, r: 100, g: 220, b: 255 },
        { t: 0.40, r: 30,  g: 120, b: 255 },
        { t: 0.55, r: 120, g: 40,  b: 255 },
        { t: 0.70, r: 220, g: 30,  b: 220 },
        { t: 0.85, r: 255, g: 30,  b: 80  },
        { t: 0.95, r: 255, g: 120, b: 20  },
        { t: 1.00, r: 255, g: 220, b: 50  },
    ],
    OCEAN: [
        { t: 0.00, r: 220, g: 240, b: 255 },
        { t: 0.25, r: 80,  g: 200, b: 230 },
        { t: 0.50, r: 20,  g: 130, b: 200 },
        { t: 0.70, r: 10,  g: 70,  b: 160 },
        { t: 0.85, r: 5,   g: 40,  b: 120 },
        { t: 1.00, r: 0,   g: 15,  b: 60  },
    ],
    FIRE: [
        { t: 0.00, r: 255, g: 255, b: 200 },
        { t: 0.20, r: 255, g: 220, b: 50  },
        { t: 0.40, r: 255, g: 150, b: 20  },
        { t: 0.60, r: 255, g: 60,  b: 10  },
        { t: 0.80, r: 180, g: 20,  b: 5   },
        { t: 1.00, r: 80,  g: 5,   b: 0   },
    ],
    NEON: [
        { t: 0.00, r: 255, g: 255, b: 255 },
        { t: 0.20, r: 0,   g: 255, b: 150 },
        { t: 0.40, r: 0,   g: 255, b: 255 },
        { t: 0.55, r: 255, g: 0,   b: 255 },
        { t: 0.70, r: 255, g: 255, b: 0   },
        { t: 0.85, r: 255, g: 0,   b: 100 },
        { t: 1.00, r: 0,   g: 100, b: 255 },
    ],
    MONO: [
        { t: 0.00, r: 255, g: 255, b: 255 },
        { t: 1.00, r: 40,  g: 40,  b: 40  },
    ],
    PASTEL: [
        { t: 0.00, r: 255, g: 230, b: 240 },
        { t: 0.25, r: 200, g: 180, b: 255 },
        { t: 0.50, r: 180, g: 230, b: 200 },
        { t: 0.75, r: 255, g: 220, b: 180 },
        { t: 1.00, r: 180, g: 220, b: 255 },
    ],
    SUNSET: [
        { t: 0.00, r: 255, g: 250, b: 220 },
        { t: 0.20, r: 255, g: 200, b: 100 },
        { t: 0.40, r: 255, g: 120, b: 60  },
        { t: 0.55, r: 230, g: 50,  b: 80  },
        { t: 0.70, r: 160, g: 30,  b: 120 },
        { t: 0.85, r: 80,  g: 20,  b: 140 },
        { t: 1.00, r: 30,  g: 10,  b: 80  },
    ],
    MATRIX: [
        { t: 0.00, r: 200, g: 255, b: 200 },
        { t: 0.30, r: 0,   g: 255, b: 65  },
        { t: 0.60, r: 0,   g: 180, b: 30  },
        { t: 0.80, r: 0,   g: 100, b: 15  },
        { t: 1.00, r: 0,   g: 40,  b: 5   },
    ],
};

const THEME_NAMES = Object.keys(COLOR_THEMES);
let currentThemeIdx = 0;
let COLOR_STOPS = COLOR_THEMES[THEME_NAMES[0]];

// Pre-baked 256-entry color LUT — eliminates per-dot string allocation
const COLOR_LUT = new Array(256);

// Numeric RGB LUT for WebGL (257 entries: 256 theme + 1 white)
const COLOR_LUT_RGB = new Float32Array(257 * 3);

function rebuildColorLUT() {
    for (let idx = 0; idx < 256; idx++) {
        const t = idx / 255;
        let i = 0;
        while (i < COLOR_STOPS.length - 2 && COLOR_STOPS[i + 1].t < t) i++;
        const a = COLOR_STOPS[i], b = COLOR_STOPS[i + 1];
        const local = (t - a.t) / (b.t - a.t);
        const s = local * local * (3 - 2 * local);
        const r = Math.round(a.r + (b.r - a.r) * s);
        const g = Math.round(a.g + (b.g - a.g) * s);
        const bl = Math.round(a.b + (b.b - a.b) * s);
        COLOR_LUT[idx] = `rgb(${r},${g},${bl})`;
        const i3 = idx * 3;
        COLOR_LUT_RGB[i3]     = r / 255;
        COLOR_LUT_RGB[i3 + 1] = g / 255;
        COLOR_LUT_RGB[i3 + 2] = bl / 255;
    }
    // White at index 256
    COLOR_LUT_RGB[768] = 1;
    COLOR_LUT_RGB[769] = 1;
    COLOR_LUT_RGB[770] = 1;
}
rebuildColorLUT();

function cycleTheme() {
    currentThemeIdx = (currentThemeIdx + 1) % THEME_NAMES.length;
    COLOR_STOPS = COLOR_THEMES[THEME_NAMES[currentThemeIdx]];
    rebuildColorLUT();
}

function speedToColor(speed) {
    return COLOR_LUT[Math.min((speed * 0.004 * 255) | 0, 255)];
}

// ── Beat Detection ──────────────────────────────────────
let beatEnergy = 0;
let beatAvg = 0;
let beatDecay = 0;       // 0-1 decaying pulse for visual effects
const BEAT_THRESHOLD = 1.4;  // energy must be this × average to trigger
const BEAT_COOLDOWN = 0.18;  // seconds between beats
let beatCooldownTimer = 0;
let beatCount = 0;

// ── Frequency Band Mapping ──────────────────────────────
// 0 = radial (default), 1 = left-to-right, 2 = top-to-bottom
let freqBandMode = 0;
const FREQ_BAND_NAMES = ['RADIAL', 'LEFT-RIGHT', 'TOP-BOTTOM'];

// ── Multi-band Color (bass=R, mids=G, treble=B) ────────
let fxColorBand = false;

// Colorband RGB output (set by computeColorbandRGB, read by drawDots)
let _cbR = 0, _cbG = 0, _cbB = 0;

// ── Cursor auto-hide ────────────────────────────────────
let cursorIdleTime = 0;
let cursorVisible = true;
const CURSOR_HIDE_DELAY = 3; // seconds

// ── Native system audio (Electron + ScreenCaptureKit) ──────
const NATIVE_BUF_SIZE = 4096;
let nativeAudioBuf = null;    // Float32Array ring buffer for PCM samples
let nativeAudioWrite = 0;

// FFT workspace (pre-allocated, matches fftSize=1024)
const FFT_N = 1024;
const _fftRe = new Float32Array(FFT_N);
const _fftIm = new Float32Array(FFT_N);
const _fftWin = new Float32Array(FFT_N);
for (let i = 0; i < FFT_N; i++) _fftWin[i] = 0.5 * (1 - Math.cos(TWO_PI * i / (FFT_N - 1)));

function fftInPlace(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            let tmp = re[i]; re[i] = re[j]; re[j] = tmp;
            tmp = im[i]; im[i] = im[j]; im[j] = tmp;
        }
    }
    for (let len = 2; len <= n; len <<= 1) {
        const half = len >> 1;
        const angle = -TWO_PI / len;
        const wRe = Math.cos(angle), wIm = Math.sin(angle);
        for (let i = 0; i < n; i += len) {
            let cRe = 1, cIm = 0;
            for (let j = 0; j < half; j++) {
                const uRe = re[i + j], uIm = im[i + j];
                const vRe = re[i + j + half] * cRe - im[i + j + half] * cIm;
                const vIm = re[i + j + half] * cIm + im[i + j + half] * cRe;
                re[i + j] = uRe + vRe;  im[i + j] = uIm + vIm;
                re[i + j + half] = uRe - vRe;  im[i + j + half] = uIm - vIm;
                const nr = cRe * wRe - cIm * wIm;
                cIm = cRe * wIm + cIm * wRe;
                cRe = nr;
            }
        }
    }
}

// Compute frequency magnitudes from the native PCM ring buffer → fills micData
function computeNativeFrequencyData() {
    const half = FFT_N / 2;
    // Copy latest FFT_N samples from ring buffer, apply Hann window
    for (let i = 0; i < FFT_N; i++) {
        const idx = (nativeAudioWrite - FFT_N + i + NATIVE_BUF_SIZE) % NATIVE_BUF_SIZE;
        _fftRe[i] = (nativeAudioBuf[idx] || 0) * _fftWin[i];
        _fftIm[i] = 0;
    }
    fftInPlace(_fftRe, _fftIm);
    // Magnitude → 0-255 byte
    // Range: [-80dB, 0dB] → [0, 255] — wider ceiling than AnalyserNode defaults
    // to prevent system audio (ScreenCaptureKit) from constantly saturating
    for (let i = 0; i < half; i++) {
        const mag = Math.sqrt(_fftRe[i] * _fftRe[i] + _fftIm[i] * _fftIm[i]);
        const db = 20 * Math.log10(mag / half + 1e-10);
        const norm = (db + 80) / 80;
        micData[i] = Math.max(0, Math.min(255, (norm * 255) | 0));
    }
}

// ── Text Dot Effect ─────────────────────────────────────
const textOffscreen = document.createElement('canvas');
const textOffscreenCtx = textOffscreen.getContext('2d', { willReadFrequently: true });
// Pre-allocated buffers — sized for up to 4K display at textFieldScale
const TEXT_BUF_MAX = Math.ceil(3840 * 0.5) * Math.ceil(2160 * 0.5); // ~2M entries
let textDistField = new Float32Array(TEXT_BUF_MAX);
let textGradX = new Float32Array(TEXT_BUF_MAX);
let textGradY = new Float32Array(TEXT_BUF_MAX);
let textFieldW = 0;
let textFieldH = 0;
const textFieldScale = 0.5;
const textInvScale = 2;     // 1 / textFieldScale
let textEffectActive = false;
let textEffectStrength = 0;
let textEffectTimer = 0;
const TEXT_FADE_IN = 0.4;
const TEXT_HOLD = 2.0;
const TEXT_FADE_OUT = 1.0;
let textSizeBoost = 1;      // multiplier for startup splash etc.
let textHoldOverride = 0;   // if > 0, overrides TEXT_HOLD for one cycle
const TEXT_PUSH_MARGIN = 6; // extra screen pixels beyond boundary — tight for crisp edges

// ── Window Transparency ─────────────────────────────────
let windowTransparent = false;

// ── Now Playing ─────────────────────────────────────────
let nowPlayingActive = false;

// ── Clock Mode ──────────────────────────────────────────
let clockMode = false;
let lastClockText = '';

// Debug
let debugMode = false;
let typedBuffer = '';
let fps = 0;
let frameCount = 0;
let fpsAccum = 0;
let debugDotTotal = 0;
let debugDotActive = 0;
let debugDotDrawn = 0;
let debugMicAffected = 0;

// ── Settings Persistence ────────────────────────────────
const SETTINGS_KEY = 'gridVisualizer';

function saveSettings() {
    try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify({
            zoomFactor,
            waveMode,
            currentThemeIdx,
            gridSpacing,
            fxColor,
            fxSize,
            fxColorBand,
            freqBandMode,
            cursorBaseRadius: cursor.baseRadius,
            windowTransparent,
        }));
    } catch (e) { /* quota exceeded or private mode */ }
}

function loadSettings() {
    try {
        const raw = localStorage.getItem(SETTINGS_KEY);
        if (!raw) return;
        const s = JSON.parse(raw);
        if (s.zoomFactor != null) zoomFactor = s.zoomFactor;
        if (s.waveMode != null && s.waveMode >= 1 && s.waveMode <= 9) waveMode = s.waveMode;
        if (s.currentThemeIdx != null && s.currentThemeIdx < THEME_NAMES.length) {
            currentThemeIdx = s.currentThemeIdx;
            COLOR_STOPS = COLOR_THEMES[THEME_NAMES[currentThemeIdx]];
            rebuildColorLUT();
        }
        if (s.gridSpacing != null) gridSpacing = Math.max(gridSpacingMin, Math.min(gridSpacingMax, s.gridSpacing));
        if (s.fxColor != null) fxColor = s.fxColor;
        if (s.fxSize != null) fxSize = s.fxSize;
        if (s.fxColorBand != null) fxColorBand = s.fxColorBand;
        if (s.freqBandMode != null) freqBandMode = s.freqBandMode;
        if (s.cursorBaseRadius != null) {
            cursor.baseRadius = s.cursorBaseRadius;
            cursor.targetRadius = s.cursorBaseRadius;
            cursor.radius = s.cursorBaseRadius;
            cursor.expandedRadius = s.cursorBaseRadius * 3;
        }
        if (s.windowTransparent != null) windowTransparent = s.windowTransparent;
    } catch (e) { /* corrupted data */ }
}
loadSettings();

// ── Delta Time ──────────────────────────────────────────

function getDeltaTime(now) {
    if (now === undefined) now = performance.now();
    const dt = (now - lastTime) / 1000;
    lastTime = now;
    return Math.min(dt, 0.05);
}

// ── Resize ──────────────────────────────────────────────

function resize() {
    const dpr = window.devicePixelRatio || 1;
    logicalW = window.innerWidth;
    logicalH = window.innerHeight;

    // WebGL canvas
    glCanvas.width = logicalW * dpr;
    glCanvas.height = logicalH * dpr;
    glCanvas.style.width = logicalW + 'px';
    glCanvas.style.height = logicalH + 'px';
    resizeGL(gl, logicalW, logicalH, dpr);

    // 2D overlay canvas (cursor + debug)
    canvas.width = logicalW * dpr;
    canvas.height = logicalH * dpr;
    canvas.style.width = logicalW + 'px';
    canvas.style.height = logicalH + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Invalidate cached text field so it recomputes at new resolution
    lastTextKey = '';
    if (textEffectActive && (typeMode ? typeText : modeLabel)) {
        computeTextField(typeMode ? typeText : modeLabel);
    }
}

// ── Coordinate Transforms ───────────────────────────────

function screenToWorld(sx, sy) {
    return {
        x: (sx - logicalW / 2) / zoomFactor + camera.x + logicalW / 2,
        y: (sy - logicalH / 2) / zoomFactor + camera.y + logicalH / 2
    };
}

function worldToScreen(wx, wy) {
    return {
        x: ((wx - logicalW / 2 - camera.x) * zoomFactor) + logicalW / 2,
        y: ((wy - logicalH / 2 - camera.y) * zoomFactor) + logicalH / 2
    };
}

// ── LOD ─────────────────────────────────────────────────

function updateLOD() {
    const screenGap = gridSpacing * zoomFactor;
    lodStep = 1;
    while (screenGap * lodStep < LOD_MIN_SCREEN_GAP) lodStep++;
}

// ── Cursor → Force Radius Sync ──────────────────────────

function syncForceRadius() {
    mouseForceRadius = cursor.baseRadius / zoomFactor;
}

// ── Zoom / Scroll ───────────────────────────────────────

function zoom(direction) {
    const mx = camera.clientX;
    const my = camera.clientY;
    const before = screenToWorld(mx, my);

    if (isAltHeld) {
        if (direction > 0) {
            cursor.baseRadius = Math.min(cursor.maxBase, cursor.baseRadius + cursor.sizeStep);
        } else {
            cursor.baseRadius = Math.max(cursor.minBase, cursor.baseRadius - cursor.sizeStep);
        }
        cursor.expandedRadius = cursor.baseRadius * 3;
        if (!cursor.isPressed) cursor.targetRadius = cursor.baseRadius;
        saveSettings();
        return;
    }

    if (isShiftHeld) {
        const oldSpacing = gridSpacing;
        if (direction > 0) {
            gridSpacing = Math.max(gridSpacingMin, gridSpacing - gridSpacingStep);
        } else {
            gridSpacing = Math.min(gridSpacingMax, gridSpacing + gridSpacingStep);
        }
        const ratio = gridSpacing / oldSpacing;
        gridOriginX = mouseWorld.x - (mouseWorld.x - gridOriginX) * ratio;
        gridOriginY = mouseWorld.y - (mouseWorld.y - gridOriginY) * ratio;
        wakeVisibleDots();
        return;
    }

    if (direction > 0) {
        zoomFactor = Math.min(zoomFactor * (1 + zoomSpeed), 20);
    } else {
        zoomFactor = Math.max(zoomFactor * (1 - zoomSpeed), 0.01);
    }
    zoomFactor = parseFloat(zoomFactor.toFixed(4));

    const after = worldToScreen(before.x, before.y);
    camera.x += (after.x - mx) / zoomFactor;
    camera.y += (after.y - my) / zoomFactor;
}

// ── Wave Ring Precomputation (mode 1) ───────────────────

function computeRingRadii() {
    ringRadii = [];
    let r = 15;
    const growthRate = 0.04;
    for (let band = 0; band < 80; band++) {
        const scale = 1 + band * growthRate;
        const ringsInBand = Math.round(3 + band * 0.15);
        const tightGap = (3 + band * 0.3) * scale;
        for (let n = 0; n < ringsInBand; n++) {
            ringRadii.push(r);
            r += Math.max(tightGap, 2);
        }
        r += (25 + band * 2.5) * scale;
    }
}

function nearestRingRadius(dist) {
    // Binary search — ringRadii is monotonically increasing
    let lo = 0, hi = ringRadii.length - 1;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (ringRadii[mid] < dist) lo = mid + 1; else hi = mid;
    }
    if (lo > 0 && Math.abs(ringRadii[lo - 1] - dist) < Math.abs(ringRadii[lo] - dist)) return ringRadii[lo - 1];
    return ringRadii[lo];
}

// ── Dot Key ─────────────────────────────────────────────
// Safe key: multiply by a prime larger than the max j range to avoid collisions.
// Supports i,j in [-200000, 200000] without 32-bit overflow issues.

const KEY_OFFSET = 200000;
const KEY_MULTIPLIER = 400001; // > 2 * KEY_OFFSET, guarantees unique mapping

function dotKey(i, j) {
    return (i + KEY_OFFSET) * KEY_MULTIPLIER + (j + KEY_OFFSET);
}

// ── Text Dot Effect — EDT + Distance Field ─────────────

let _tdx = 0, _tdy = 0;
let lastTextKey = '';
// Pre-allocated EDT scratch buffers (grow if needed)
let _edtF = new Float32Array(2048);
let _edtD = new Float32Array(2048);
let _edtV = new Int32Array(2048);
let _edtZ = new Float32Array(2049);

function edt1dPass(f, d, v, z, n) {
    v[0] = 0; z[0] = -1e10; z[1] = 1e10;
    let k = 0;
    for (let q = 1; q < n; q++) {
        while (k >= 0) {
            const s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
            if (s > z[k]) { k++; v[k] = q; z[k] = s; z[k + 1] = 1e10; break; }
            k--;
        }
        if (k < 0) { k = 0; v[0] = q; z[0] = -1e10; z[1] = 1e10; }
    }
    k = 0;
    for (let q = 0; q < n; q++) {
        while (z[k + 1] < q) k++;
        const dx = q - v[k];
        d[q] = dx * dx + f[v[k]];
    }
}

function computeTextField(text) {
    if (!text) { textEffectActive = false; return; }

    const scale = textFieldScale;
    const sw = Math.floor(logicalW * scale);
    const sh = Math.floor(logicalH * scale);
    if (sw < 10 || sh < 10) return;

    textOffscreen.width = sw;
    textOffscreen.height = sh;
    textOffscreenCtx.clearRect(0, 0, sw, sh);

    // Split into lines for multiline support
    const lines = text.split('\n');
    const numLines = lines.length;

    // Big bold centered text — scale down for line count, apply boost
    let fontSize = Math.floor(sh * 0.35 * textSizeBoost / Math.max(numLines, 1));
    const fontFace = '"Arial Black", "Impact", "Helvetica Neue", sans-serif';
    textOffscreenCtx.font = `900 ${fontSize}px ${fontFace}`;
    textOffscreenCtx.textAlign = 'center';
    textOffscreenCtx.textBaseline = 'middle';
    textOffscreenCtx.letterSpacing = `${Math.max(2, Math.round(fontSize * 0.04))}px`;

    // Fit widest line
    const maxW = sw * 0.85;
    let widest = 0;
    for (let i = 0; i < numLines; i++) {
        const w = textOffscreenCtx.measureText(lines[i]).width;
        if (w > widest) widest = w;
    }
    if (widest > maxW) {
        fontSize = Math.floor(fontSize * maxW / widest);
        textOffscreenCtx.font = `900 ${fontSize}px ${fontFace}`;
        textOffscreenCtx.letterSpacing = `${Math.max(2, Math.round(fontSize * 0.04))}px`;
    }

    // Stroke + fill for thick glyphs, per line
    textOffscreenCtx.lineWidth = Math.max(4, fontSize * 0.05);
    textOffscreenCtx.lineJoin = 'round';
    textOffscreenCtx.strokeStyle = '#fff';
    textOffscreenCtx.fillStyle = '#fff';
    const lineHeight = fontSize * 1.25;
    const totalH = numLines * lineHeight;
    const startY = sh / 2 - totalH / 2 + lineHeight / 2;
    for (let i = 0; i < numLines; i++) {
        const y = startY + i * lineHeight;
        textOffscreenCtx.strokeText(lines[i], sw / 2, y);
        textOffscreenCtx.fillText(lines[i], sw / 2, y);
    }

    // Extract bitmap
    const pixels = textOffscreenCtx.getImageData(0, 0, sw, sh).data;
    const size = sw * sh;

    // Reuse pre-allocated buffers (zero the regions we'll use)
    const grid = textDistField;
    const INF = 1e10;
    for (let i = 0; i < size; i++) grid[i] = pixels[i * 4 + 3] > 100 ? INF : 0;

    const maxDim = Math.max(sw, sh);
    const f = _edtF.length >= maxDim ? _edtF : (_edtF = new Float32Array(maxDim));
    const d = _edtD.length >= maxDim ? _edtD : (_edtD = new Float32Array(maxDim));
    const v = _edtV.length >= maxDim ? _edtV : (_edtV = new Int32Array(maxDim));
    const z = _edtZ.length > maxDim ? _edtZ : (_edtZ = new Float32Array(maxDim + 1));

    // Rows
    for (let y = 0; y < sh; y++) {
        const off = y * sw;
        for (let x = 0; x < sw; x++) f[x] = grid[off + x];
        edt1dPass(f, d, v, z, sw);
        for (let x = 0; x < sw; x++) grid[off + x] = d[x];
    }
    // Columns
    for (let x = 0; x < sw; x++) {
        for (let y = 0; y < sh; y++) f[y] = grid[y * sw + x];
        edt1dPass(f, d, v, z, sh);
        for (let y = 0; y < sh; y++) grid[y * sw + x] = d[y];
    }
    // Sqrt for Euclidean distance
    for (let i = 0; i < size; i++) grid[i] = Math.sqrt(grid[i]);

    // Gradient: reuse pre-allocated arrays, zero first
    for (let i = 0; i < size; i++) { textGradX[i] = 0; textGradY[i] = 0; }
    for (let y = 1; y < sh - 1; y++) {
        for (let x = 1; x < sw - 1; x++) {
            const idx = y * sw + x;
            if (grid[idx] < 0.5) continue;
            const gx = grid[idx + 1] - grid[idx - 1];
            const gy = grid[idx + sw] - grid[idx - sw];
            const len = Math.sqrt(gx * gx + gy * gy);
            if (len > 0.001) {
                textGradX[idx] = -gx / len;
                textGradY[idx] = -gy / len;
            }
        }
    }

    textFieldW = sw;
    textFieldH = sh;
    textEffectActive = true;
}

function showLabel(text) {
    modeLabel = text;
    modeLabelAlpha = 1;
    textEffectTimer = 0;
    textEffectStrength = 0;
    nowPlayingTextActive = false; // label is not now-playing text
    if (text) {
        const key = `${logicalW}:${logicalH}:${text}`;
        if (key !== lastTextKey) {
            lastTextKey = key;
            computeTextField(text);
        } else {
            textEffectActive = true;
        }
    } else {
        textEffectActive = false;
    }
}

function showTypeText() {
    if (!typeText) {
        textEffectActive = false;
        textEffectStrength = 0;
        return;
    }
    const key = `${logicalW}:${logicalH}:${typeText}`;
    if (key !== lastTextKey) {
        lastTextKey = key;
        computeTextField(typeText);
    } else {
        textEffectActive = true;
    }
    // Snap to full strength immediately for responsive typing
    textEffectStrength = 1;
    textEffectTimer = TEXT_FADE_IN; // skip fade-in, sit in hold
    modeLabelAlpha = 1;
}

function updateTextEffect(dt) {
    if (!textEffectActive) { textEffectStrength = 0; return; }

    // Type / clock / now-playing: text stays indefinitely — no fade-out
    if (typeMode || clockMode || (nowPlayingActive && nowPlayingInfo && nowPlayingTextActive)) {
        textEffectStrength = 1;
        modeLabelAlpha = 1;
        return;
    }

    const hold = textHoldOverride > 0 ? textHoldOverride : TEXT_HOLD;
    textEffectTimer += dt;
    if (textEffectTimer < TEXT_FADE_IN) {
        const t = textEffectTimer / TEXT_FADE_IN;
        textEffectStrength = t * t * (3 - 2 * t); // smoothstep
        modeLabelAlpha = 1;
    } else if (textEffectTimer < TEXT_FADE_IN + hold) {
        textEffectStrength = 1;
        modeLabelAlpha = 1;
    } else {
        const fade = (textEffectTimer - TEXT_FADE_IN - hold) / TEXT_FADE_OUT;
        if (fade >= 1) {
            textSizeBoost = 1;
            textHoldOverride = 0;
            // If now-playing has active track info, restore its dot text
            if (nowPlayingActive && nowPlayingInfo && nowPlayingInfo.title && !typeMode && !clockMode) {
                const text = nowPlayingInfo.artist
                    ? `${nowPlayingInfo.artist.toUpperCase()}\n${nowPlayingInfo.title.toUpperCase()}`
                    : nowPlayingInfo.title.toUpperCase();
                const key = `${logicalW}:${logicalH}:${text}`;
                if (key !== lastTextKey) { lastTextKey = key; computeTextField(text); }
                else { textEffectActive = true; }
                nowPlayingTextActive = true;
                textEffectStrength = 1;
                modeLabelAlpha = 1;
                return;
            }
            textEffectStrength = 0;
            textEffectActive = false;
            modeLabelAlpha = 0;
        } else {
            textEffectStrength = 1 - fade * fade;
            modeLabelAlpha = textEffectStrength;
        }
    }
}

// Returns true if dot at (sx,sy) is inside text; sets _tdx,_tdy displacement
function textDisp(sx, sy) {
    const dfx = (sx * textFieldScale) | 0;
    const dfy = (sy * textFieldScale) | 0;
    if (dfx < 0 || dfx >= textFieldW || dfy < 0 || dfy >= textFieldH) return false;
    const idx = dfy * textFieldW + dfx;
    const dist = textDistField[idx];
    if (dist < 0.5) return false;
    const push = (dist * textInvScale + TEXT_PUSH_MARGIN) * textEffectStrength;
    _tdx = textGradX[idx] * push;
    _tdy = textGradY[idx] * push;
    return true;
}

// ── Input ───────────────────────────────────────────────

window.addEventListener('keydown', (e) => {
    if (e.key in keys) keys[e.key] = true;
    if (!typeMode) {
        if (e.key === 'w') keys.ArrowUp = true;
        if (e.key === 's') keys.ArrowDown = true;
        if (e.key === 'a') keys.ArrowLeft = true;
        if (e.key === 'd') keys.ArrowRight = true;
    }
    if (e.key === 'Shift') { camSpeed = 20; isShiftHeld = true; }
    if (e.key === 'Control') camSpeed = 1;
    if (e.key === 'Alt') { isAltHeld = true; e.preventDefault(); }
    if (e.key === ' ' && !typeMode) { e.preventDefault(); cycleAudioSource(); }

    // Mode switch — selecting a preset activates it immediately
    if (e.key >= '0' && e.key <= '9') {
        const newMode = parseInt(e.key);
        // Exit clock mode on any number key
        if (clockMode) { clockMode = false; lastClockText = ''; }
        // Number keys 1-9 always exit type mode and switch
        if (typeMode && newMode !== 0) {
            typeMode = false;
            typeText = '';
        }
        if (!typeMode) {
            waveMode = newMode;
            if (waveMode === 0) {
                typeMode = true;
                typeText = '';
                showLabel('TYPE');
            } else {
                showLabel(MODE_NAMES[waveMode] || '');
            }
            if (!waveActive) {
                waveOrigin.x = mouseWorld.x;
                waveOrigin.y = mouseWorld.y;
                waveTime = 0;
                computeRingRadii();
                waveActive = true;
                wakeVisibleDots();
            }
            saveSettings();
        }
    }

    // Type mode: route keys to typeText
    if (typeMode) {
        if (e.key === 'Backspace') {
            typeText = typeText.slice(0, -1);
            showTypeText();
            e.preventDefault();
        } else if (e.key === 'Escape') {
            typeMode = false;
            typeText = '';
            clockMode = false;
            lastClockText = '';
            // Restore now-playing text if active, otherwise clear
            if (nowPlayingActive && nowPlayingInfo && nowPlayingInfo.title) {
                const npText = nowPlayingInfo.artist
                    ? `${nowPlayingInfo.artist.toUpperCase()}\n${nowPlayingInfo.title.toUpperCase()}`
                    : nowPlayingInfo.title.toUpperCase();
                const key = `${logicalW}:${logicalH}:${npText}`;
                if (key !== lastTextKey) { lastTextKey = key; computeTextField(npText); }
                else { textEffectActive = true; }
                nowPlayingTextActive = true;
                textEffectStrength = 1;
                modeLabelAlpha = 1;
            } else {
                textEffectActive = false;
                textEffectStrength = 0;
            }
        } else if (e.key === 'Enter') {
            typeText += '\n';
            showTypeText();
            e.preventDefault();
        } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !(e.key >= '0' && e.key <= '9')) {
            typeText += e.key.toUpperCase();
            showTypeText();
        }
    } else if (e.key.length === 1) {
        typedBuffer += e.key.toLowerCase();
        if (typedBuffer.length > 15) typedBuffer = typedBuffer.slice(-15);
        if (typedBuffer.endsWith('bug')) {
            debugMode = !debugMode;
            typedBuffer = '';
        }
        if (typedBuffer.endsWith('color')) {
            fxColor = !fxColor;
            showLabel(fxColor ? 'COLOR ON' : 'COLOR OFF');
            typedBuffer = '';
            saveSettings();
        }
        if (typedBuffer.endsWith('size')) {
            fxSize = !fxSize;
            showLabel(fxSize ? 'SIZE ON' : 'SIZE OFF');
            typedBuffer = '';
            saveSettings();
        }
        if (typedBuffer.endsWith('mic')) {
            toggleMic();
            typedBuffer = '';
        }
        if (typedBuffer.endsWith('sys')) {
            toggleSystemAudio();
            typedBuffer = '';
        }
        // Instant key shortcuts (not typed words)
        if (e.key === 'k') {
            toggleClockMode();
        }
        if (e.key === 'c') {
            cycleTheme();
            showLabel(THEME_NAMES[currentThemeIdx]);
            saveSettings();
        }
        if (e.key === 'b') {
            freqBandMode = (freqBandMode + 1) % FREQ_BAND_NAMES.length;
            showLabel(FREQ_BAND_NAMES[freqBandMode]);
            saveSettings();
        }
        if (e.key === 'v') {
            fxColorBand = !fxColorBand;
            showLabel(fxColorBand ? 'COLOR BAND ON' : 'COLOR BAND OFF');
            saveSettings();
        }
        if (e.key === 'f') {
            toggleFullscreen();
        }
        if (e.key === 't') {
            toggleTransparency();
        }
        if (e.key === 'n') {
            toggleNowPlaying();
        }
    }
});

window.addEventListener('keyup', (e) => {
    if (e.key in keys) keys[e.key] = false;
    if (e.key === 'w') keys.ArrowUp = false;
    if (e.key === 's') keys.ArrowDown = false;
    if (e.key === 'a') keys.ArrowLeft = false;
    if (e.key === 'd') keys.ArrowRight = false;
    if (e.key === 'Shift') { camSpeed = 5; isShiftHeld = false; }
    if (e.key === 'Control') camSpeed = 5;
    if (e.key === 'Alt') isAltHeld = false;
});

canvas.addEventListener('mousemove', (e) => {
    mouseHasEntered = true;
    cursorIdleTime = 0;
    cursorVisible = true;
    camera.clientX = e.clientX;
    camera.clientY = e.clientY;
    cursor.x = e.clientX;
    cursor.y = e.clientY;
    mouseWorld = screenToWorld(e.clientX, e.clientY);

    if (isDragging) {
        const dx = e.clientX - camera.lastMouseX;
        const dy = e.clientY - camera.lastMouseY;
        camera.x -= dx / zoomFactor;
        camera.y -= dy / zoomFactor;
        camera.lastMouseX = e.clientX;
        camera.lastMouseY = e.clientY;
    }
});

canvas.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;

    if (e.ctrlKey || e.metaKey) {
        isDragging = true;
        camera.lastMouseX = e.clientX;
        camera.lastMouseY = e.clientY;
    } else {
        if (waveActive) {
            waveActive = false;
            cursor.isPressed = false;
            cursor.targetRadius = cursor.baseRadius;
        } else {
            cursor.isPressed = true;
            cursor.targetRadius = cursor.expandedRadius;
            waveOrigin.x = mouseWorld.x;
            waveOrigin.y = mouseWorld.y;
            waveTime = 0;
            computeRingRadii();
            waveActive = true;
            wakeVisibleDots();
        }
    }
});

window.addEventListener('mouseup', () => {
    isDragging = false;
    if (cursor.isPressed) {
        cursor.isPressed = false;
        cursor.targetRadius = cursor.baseRadius;
    }
});

canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoom(e.deltaY < 0 ? 1 : -1);
}, { passive: false });

// ── Dot Management ──────────────────────────────────────

function getVisibleRange(padding) {
    const tl = screenToWorld(0, 0);
    const br = screenToWorld(logicalW, logicalH);
    const p = gridSpacing * padding;
    return {
        iMin: Math.floor((tl.x - p - gridOriginX) / gridSpacing),
        iMax: Math.ceil((br.x + p - gridOriginX) / gridSpacing),
        jMin: Math.floor((tl.y - p - gridOriginY) / gridSpacing),
        jMax: Math.ceil((br.y + p - gridOriginY) / gridSpacing)
    };
}

function wakeDot(i, j) {
    const key = dotKey(i, j);
    if (activeDots.has(key)) return;
    activeDots.set(key, {
        i, j,
        x: i * gridSpacing + gridOriginX,
        y: j * gridSpacing + gridOriginY,
        vx: 0, vy: 0
    });
}

function wakeVisibleDots() {
    const { iMin, iMax, jMin, jMax } = getVisibleRange(2);
    for (let i = iMin; i <= iMax; i++) {
        for (let j = jMin; j <= jMax; j++) {
            wakeDot(i, j);
        }
    }
}

function wakeNearMouse() {
    const rad = Math.ceil(mouseForceRadius / gridSpacing) + 1;
    const ci = Math.round((mouseWorld.x - gridOriginX) / gridSpacing);
    const cj = Math.round((mouseWorld.y - gridOriginY) / gridSpacing);
    for (let di = -rad; di <= rad; di++) {
        for (let dj = -rad; dj <= rad; dj++) {
            wakeDot(ci + di, cj + dj);
        }
    }
}

function sleepSettledDots() {
    if (waveActive) return;
    const pt2 = sleepPosThr * sleepPosThr;
    const vt2 = sleepVelThr * sleepVelThr;
    const gs = gridSpacing;
    const gox = gridOriginX;
    const goy = gridOriginY;
    for (const [key, dot] of activeDots) {
        const hx = dot.i * gs + gox;
        const hy = dot.j * gs + goy;
        const dx = dot.x - hx;
        const dy = dot.y - hy;
        if (dx * dx + dy * dy < pt2 && dot.vx * dot.vx + dot.vy * dot.vy < vt2) {
            activeDots.delete(key);
        }
    }
}

function pruneOffscreen() {
    const { iMin, iMax, jMin, jMax } = getVisibleRange(6);
    for (const [key, dot] of activeDots) {
        if (dot.i < iMin || dot.i > iMax || dot.j < jMin || dot.j > jMax) {
            activeDots.delete(key);
        }
    }
}

// ── Physics ─────────────────────────────────────────────

function updateDots(dt) {
    const mfr = mouseForceRadius;
    const mfr2 = mfr * mfr;
    const mwx = mouseWorld.x;
    const mwy = mouseWorld.y;
    const sk = springK;
    const sd = springDamp;
    const mfs = mouseForceStrength;
    const wa = waveActive;
    const woX = waveOrigin.x;
    const woY = waveOrigin.y;
    const gs = gridSpacing;
    const gox = gridOriginX;
    const goy = gridOriginY;
    const rr = repelRadius * gs;
    const rr2 = rr * rr;
    const rs = repelStrength;
    const wfr = waveFalloffRate;
    const wff = waveFalloffFloor;
    const mode = waveMode;
    const wt = waveTime;

    // Viewport center in world space (for dipole mirror)
    const vcX = camera.x + logicalW / 2;
    const vcY = camera.y + logicalH / 2;

    for (const [, dot] of activeDots) {
        const hx = dot.i * gs + gox;
        const hy = dot.j * gs + goy;

        let tx, ty;
        let springMod = 1;

        if (wa) {
            const dx = hx - woX;
            const dy = hy - woY;
            const dist2 = dx * dx + dy * dy;
            // Pre-compute dist for modes that need it (1-5 use it)
            const dist = mode <= 5 ? Math.sqrt(dist2) : 0;

            switch (mode) {
                case 1: { // ── RIPPLE ────────────────────────
                    springMod = Math.max(wff, Math.exp(-dist * wfr));
                    if (dist < 1) { tx = woX; ty = woY; }
                    else {
                        const r = nearestRingRadius(dist);
                        tx = woX + (dx / dist) * r;
                        ty = woY + (dy / dist) * r;
                    }
                    break;
                }
                case 2: { // ── SPIRAL ────────────────────────
                    const angle = Math.atan2(dy, dx);
                    springMod = Math.max(wff, Math.exp(-dist * wfr));
                    const numArms = 5;
                    const baseGap = gs * 1.2;
                    const growRate = 0.0015;
                    const armGap = baseGap + dist * growRate * baseGap;
                    const b = armGap * numArms / TWO_PI;
                    let aNorm = ((angle % TWO_PI) + TWO_PI) % TWO_PI;
                    const rBase = b * aNorm;
                    const n = Math.round((dist - rBase) / armGap);
                    const armCenter = Math.max(rBase + n * armGap, 0);
                    const armWidth = armGap * 0.35 * (1 + dist * 0.003);
                    const offset = dist - armCenter;
                    const snapR = armCenter + offset * Math.min(armWidth / (Math.abs(offset) + armWidth), 1);
                    tx = woX + Math.cos(angle) * snapR;
                    ty = woY + Math.sin(angle) * snapR;
                    break;
                }
                case 3: { // ── VORTEX ────────────────────────
                    const angle = Math.atan2(dy, dx);
                    springMod = Math.max(wff, Math.exp(-dist * wfr));
                    const vortexR = Math.min(logicalW, logicalH) / (2 * zoomFactor) * 0.85;
                    const vFade = dist < vortexR ? 1 : Math.exp(-(dist - vortexR) / (vortexR * 0.12));
                    const twist = (3.5 / (1 + dist * 0.006) + wt * 1.2) * vFade;
                    tx = woX + Math.cos(angle + twist) * dist;
                    ty = woY + Math.sin(angle + twist) * dist;
                    break;
                }
                case 4: { // ── INTERFERENCE ──────────────────
                    const sep = mfr * 2;
                    const s1x = woX - sep, s1y = woY;
                    const s2x = woX + sep, s2y = woY;
                    const d1x = hx - s1x, d1y = hy - s1y;
                    const d2x = hx - s2x, d2y = hy - s2y;
                    const d1 = Math.sqrt(d1x * d1x + d1y * d1y);
                    const d2 = Math.sqrt(d2x * d2x + d2y * d2y);
                    const freq = 0.04;
                    const wave1 = Math.sin(d1 * freq - wt * 3);
                    const wave2 = Math.sin(d2 * freq - wt * 3);
                    const combined = (wave1 + wave2) * 18;
                    tx = hx;
                    ty = hy + combined;
                    springMod = Math.max(0.15, Math.exp(-dist * 0.001));
                    break;
                }
                case 5: { // ── DIPOLE ─────────────────────────
                    const p2x = 2 * vcX - woX;
                    const p2y = 2 * vcY - woY;
                    const midX = (woX + p2x) * 0.5;
                    const midY = (woY + p2y) * 0.5;
                    const sepX = p2x - woX;
                    const sepY = p2y - woY;
                    const poleDist = Math.sqrt(sepX * sepX + sepY * sepY) + 0.01;
                    const halfSep = poleDist * 0.5;
                    const axX = sepX / poleDist, axY = sepY / poleDist;
                    const prX = -axY, prY = axX;
                    const relX = hx - midX, relY = hy - midY;
                    const dotAlong = relX * axX + relY * axY;
                    const dotPerp = relX * prX + relY * prY;
                    const lineHeight = Math.abs(dotPerp) + gs * 0.3;
                    const side = dotPerp >= 0 ? 1 : -1;
                    const totalSpan = poleDist + lineHeight * 2;
                    let t5 = 0.5 - dotAlong / (totalSpan + 1);
                    t5 = Math.max(0.01, Math.min(0.99, t5));
                    let param = t5 * Math.PI;
                    param += wt * 0.3;
                    param = ((param % Math.PI) + Math.PI) % Math.PI;
                    const arcAlong = -Math.cos(param) * halfSep;
                    const arcPerp = side * Math.sin(param) * lineHeight;
                    tx = midX + arcAlong * axX + arcPerp * prX;
                    ty = midY + arcAlong * axY + arcPerp * prY;
                    springMod = 0.4;
                    break;
                }
                case 6: { // ── DRIFT ──────────────────────────
                    const driftScale1 = 0.005, driftScale2 = 0.012;
                    const driftAmp = gs * 4;
                    const t6 = wt * 0.25;
                    const windAngle = wt * 0.15;
                    const windCos = Math.cos(windAngle), windSin = Math.sin(windAngle);
                    const rx = hx * windCos - hy * windSin;
                    const ry = hx * windSin + hy * windCos;
                    const n1x = smoothNoise(rx * driftScale1 + t6, ry * driftScale1) * 2 - 1;
                    const n1y = smoothNoise(rx * driftScale1, ry * driftScale1 + t6 + 50) * 2 - 1;
                    const n2x = smoothNoise(hx * driftScale2 + t6 * 1.5 + 200, hy * driftScale2) * 2 - 1;
                    const n2y = smoothNoise(hx * driftScale2, hy * driftScale2 + t6 * 1.5 + 300) * 2 - 1;
                    tx = hx + (n1x * 0.7 + n2x * 0.3) * driftAmp;
                    ty = hy + (n1y * 0.7 + n2y * 0.3) * driftAmp;
                    springMod = 0.5;
                    break;
                }
                case 7: { // ── GRAVITY ────────────────────────
                    const viewR = Math.min(logicalW, logicalH) / (2 * zoomFactor);
                    const soft = gs * 1.5;
                    const NUM_WELLS = 5;
                    // Per-well pseudo-random seeds (deterministic but chaotic-looking)
                    const _s = [3.17, 7.31, 1.93, 5.67, 0.41];
                    const _m = [45, 35, 28, 22, 30]; // mass multipliers
                    const _sp = [0.15, 0.35, 0.22, 0.45, 0.28]; // orbit speeds
                    const _or = [1.1, 0.6, 0.85, 0.4, 1.3]; // orbit radius multipliers
                    const _fy = [1.3, 0.7, 1.8, 0.5, 1.1]; // y-freq for lissajous
                    let pullX = 0, pullY = 0;
                    for (let a = 0; a < NUM_WELLS; a++) {
                        const orb = viewR * _or[a];
                        const mass = viewR * _m[a];
                        const aAngle = wt * _sp[a] + _s[a] * TWO_PI;
                        const ax = woX + Math.cos(aAngle) * orb;
                        const ay = woY + Math.sin(aAngle * _fy[a] + _s[a] * 10) * orb * 0.8;
                        const adx = ax - hx, ady = ay - hy;
                        const aDist = Math.sqrt(adx * adx + ady * ady) + soft;
                        const invD = 1 / aDist;
                        const pull = mass * invD;
                        const nx = adx * invD, ny = ady * invD;
                        const swirl = 0.5 + 0.4 * Math.sin(wt * 0.4 + _s[a] * 5);
                        pullX += nx * pull + (-ny) * pull * swirl;
                        pullY += ny * pull + nx * pull * swirl;
                    }
                    tx = hx + pullX;
                    ty = hy + pullY;
                    springMod = 0.35;
                    break;
                }
                case 8: { // ── RAIN ───────────────────────────
                    const rainAmp = gs * 2.5;
                    const colPhase = smoothNoise(hx * 0.01, 0) * 50;
                    const colSpeed = 0.7 + smoothNoise(hx * 0.015, 100) * 0.6;
                    const rawPhase = (hy * 0.03 - wt * 3 * colSpeed + colPhase) / TWO_PI;
                    const frac = rawPhase - Math.floor(rawPhase);
                    const drop = Math.exp(-frac * 6);
                    const sway = Math.sin(wt * 0.8 + hy * 0.005) * gs * 0.5;
                    tx = hx + sway;
                    ty = hy + drop * rainAmp;
                    springMod = 0.6;
                    break;
                }
                case 0: // ── TYPE (noise field background) ────
                case 9: { // ── NOISE FIELD ───────────────────
                    const noiseScale = 0.008;
                    const noiseAmp = gs * 3;
                    const t9 = wt * 0.4;
                    const nx = smoothNoise(hx * noiseScale + t9, hy * noiseScale) * 2 - 1;
                    const ny = smoothNoise(hx * noiseScale, hy * noiseScale + t9 + 100) * 2 - 1;
                    tx = hx + nx * noiseAmp;
                    ty = hy + ny * noiseAmp;
                    springMod = 0.6;
                    break;
                }
                default:
                    tx = hx; ty = hy;
            }

            // Dampen wave while text is showing — keeps 30% of wave amplitude
            if (textEffectStrength > 0) {
                const dampen = 1 - textEffectStrength * 0.7;
                tx = hx + (tx - hx) * dampen;
                ty = hy + (ty - hy) * dampen;
            }

        } else {
            tx = hx;
            ty = hy;
        }

        // Spring + damping
        let fx = -sk * springMod * (dot.x - tx) - sd * dot.vx;
        let fy = -sk * springMod * (dot.y - ty) - sd * dot.vy;

        // Mouse repulsion (combined division)
        const mdx = dot.x - mwx;
        const mdy = dot.y - mwy;
        const md2 = mdx * mdx + mdy * mdy;
        if (md2 < mfr2 && md2 > 0.01) {
            const md = Math.sqrt(md2);
            const t = 1 - md / mfr;
            const scale = mfs * t * t / md;
            fx += mdx * scale;
            fy += mdy * scale;
        }

        // Neighbor repulsion (combined division for fewer ops)
        for (let n = 0; n < 16; n += 2) {
            const nk = dotKey(dot.i + NEIGHBORS[n], dot.j + NEIGHBORS[n + 1]);
            const nd = activeDots.get(nk);
            if (!nd) continue;
            const ndx = dot.x - nd.x;
            const ndy = dot.y - nd.y;
            const nd2 = ndx * ndx + ndy * ndy;
            if (nd2 < rr2 && nd2 > 0.01) {
                const ndist = Math.sqrt(nd2);
                const scale = rs * (1 - ndist / rr) / ndist;
                fx += ndx * scale;
                fy += ndy * scale;
            }
        }

        dot.vx += fx * dt;
        dot.vy += fy * dt;
        dot.x += dot.vx * dt;
        dot.y += dot.vy * dt;
    }

}

// ── Mic Input ───────────────────────────────────────────

async function toggleMic() {
    if (audioSwitching) return;
    if (micActive) {
        stopAudio();
        audioSource = 'off';
        showLabel('MIC OFF');
        return;
    }
    audioSwitching = true;
    showLabel('CONNECTING MIC...');
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        startAudioAnalyser(stream, 'MIC ON');
        audioSource = 'mic';
    } catch (e) {
        showLabel('MIC DENIED');
        // Show native permission dialog with "Open Settings" button
        if (window.electronAPI) {
            const action = await window.electronAPI.showPermissionDialog('microphone');
            if (action === 1) { // "Try Again"
                audioSwitching = false;
                return toggleMic();
            }
        }
    } finally {
        audioSwitching = false;
    }
}

function startAudioAnalyser(stream, label) {
    // Close prior context/stream if any
    if (activeAudioCtx) { activeAudioCtx.close().catch(() => {}); }
    if (activeStream) { activeStream.getTracks().forEach(t => t.stop()); }

    activeAudioCtx = new AudioContext();
    activeStream = stream;
    const source = activeAudioCtx.createMediaStreamSource(stream);
    micAnalyser = activeAudioCtx.createAnalyser();
    micAnalyser.fftSize = 1024;
    micAnalyser.smoothingTimeConstant = 0.3;
    source.connect(micAnalyser);
    const binCount = micAnalyser.frequencyBinCount;
    micData = new Uint8Array(binCount);
    micSmoothed = new Float32Array(binCount);
    micActive = true;
    showLabel(label);
}

function stopAudio() {
    micActive = false;
    // Close Web Audio context and stop media stream tracks
    if (activeAudioCtx) { activeAudioCtx.close().catch(() => {}); activeAudioCtx = null; }
    if (activeStream) { activeStream.getTracks().forEach(t => t.stop()); activeStream = null; }
    micAnalyser = null;
    micData = null;
    micSmoothed = null;
    // Kill native audio process and clean up IPC listeners
    nativeAudioBuf = null;
    nativeAudioWrite = 0;
    if (window.electronAPI) {
        window.electronAPI.stopSystemAudio();
        window.electronAPI.removeAudioListeners();
    }
}

async function toggleSystemAudio() {
    if (audioSwitching) return;
    if (micActive) {
        stopAudio();
        audioSource = 'off';
        showLabel('AUDIO OFF');
        return;
    }

    audioSwitching = true;
    showLabel('CONNECTING...');
    try {
        // ── Electron + macOS: native ScreenCaptureKit (no dialog, no BlackHole) ──
        if (window.electronAPI && await window.electronAPI.hasNativeAudio()) {
            // Init FFT-based analyser (no Web Audio needed)
            const binCount = FFT_N / 2;
            micData = new Uint8Array(binCount);
            micSmoothed = new Float32Array(binCount);
            nativeAudioBuf = new Float32Array(NATIVE_BUF_SIZE);
            nativeAudioWrite = 0;

            // Receive PCM chunks from main process → fill ring buffer
            window.electronAPI.onAudioData((samples) => {
                if (!nativeAudioBuf) return; // guard: stopAudio may have nulled it
                for (let i = 0; i < samples.length; i++) {
                    nativeAudioBuf[nativeAudioWrite % NATIVE_BUF_SIZE] = samples[i];
                    nativeAudioWrite++;
                }
            });

            window.electronAPI.onAudioStopped(() => {
                if (audioSource === 'sys') {
                    stopAudio();
                    audioSource = 'off';
                    showLabel('AUDIO STOPPED');
                }
            });

            window.electronAPI.onAudioError(() => {
                stopAudio();
                audioSource = 'off';
                showLabel('AUDIO ERROR');
            });

            // Show permission dialog if Screen Recording is denied
            window.electronAPI.onAudioPermissionDenied(async () => {
                stopAudio();
                audioSource = 'off';
                showLabel('SCREEN RECORDING DENIED');
                const action = await window.electronAPI.showPermissionDialog('screen');
                if (action === 1) { // "Try Again"
                    audioSwitching = false;
                    toggleSystemAudio();
                }
            });

            await window.electronAPI.startSystemAudio();
            micActive = true;
            showLabel('SYSTEM AUDIO');
            audioSource = 'sys';
            return;
        }

        // ── Electron fallback: desktopCapturer (Windows/Linux, no dialog) ──
        if (window.electronAPI) {
            const sources = await window.electronAPI.getDesktopSources();
            if (sources.length === 0) {
                showLabel('NO SOURCES');
                return;
            }

            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    mandatory: {
                        chromeMediaSource: 'desktop',
                        chromeMediaSourceId: sources[0].id
                    }
                },
                video: {
                    mandatory: {
                        chromeMediaSource: 'desktop',
                        chromeMediaSourceId: sources[0].id
                    }
                }
            });

            stream.getVideoTracks().forEach(t => t.stop());
            const audioTracks = stream.getAudioTracks();
            if (audioTracks.length === 0) {
                showLabel('NO AUDIO');
                return;
            }

            startAudioAnalyser(new MediaStream(audioTracks), 'SYSTEM AUDIO');
            audioSource = 'sys';
            return;
        }

        // ── Browser fallback: getDisplayMedia (shows picker) ──
        const stream = await navigator.mediaDevices.getDisplayMedia({
            video: true,
            audio: true,
            systemAudio: 'include'
        });
        const audioTracks = stream.getAudioTracks();
        if (audioTracks.length === 0) {
            stream.getTracks().forEach(t => t.stop());
            showLabel('NO AUDIO');
            return;
        }
        const audioStream = new MediaStream(audioTracks);
        stream.getVideoTracks().forEach(t => t.stop());
        startAudioAnalyser(audioStream, 'SYSTEM AUDIO');
        audioSource = 'sys';
    } catch (e) {
        showLabel('AUDIO FAILED');
    } finally {
        audioSwitching = false;
    }
}

function cycleAudioSource() {
    if (audioSwitching) return;
    if (audioSource === 'off') {
        toggleMic();
    } else if (audioSource === 'mic') {
        stopAudio();
        audioSource = 'off';
        toggleSystemAudio(); // toggleSystemAudio manages its own audioSwitching guard
    } else {
        stopAudio();
        audioSource = 'off';
        showLabel('AUDIO OFF');
    }
}

function updateMic() {
    if (!micActive) { micPeak = 0; return; }

    if (micAnalyser) {
        // Web Audio path (mic / desktopCapturer)
        micAnalyser.getByteFrequencyData(micData);
    } else if (nativeAudioBuf && nativeAudioWrite >= FFT_N) {
        // Native ScreenCaptureKit path — compute FFT from PCM ring buffer
        computeNativeFrequencyData();
    } else {
        micPeak = 0;
        return;
    }
    // Smooth: fast attack, medium decay
    let peak = 0;
    for (let i = 0; i < micData.length; i++) {
        const raw = micData[i] / 255;
        if (raw > micSmoothed[i]) {
            micSmoothed[i] = raw; // instant attack
        } else {
            micSmoothed[i] += (raw - micSmoothed[i]) * 0.15; // smooth decay
        }
        if (micSmoothed[i] > peak) peak = micSmoothed[i];
    }
    micPeak = peak;
    micPropBuf[micPropHead % MIC_PROP_SIZE] = peak;
    micPropHead++;

    // ── Beat detection ──────────────────────────────────
    // Compute instantaneous energy from low-frequency bins (bass-heavy)
    const bassEnd = Math.min(Math.floor(micData.length * 0.15), micData.length);
    let bassEnergy = 0;
    for (let i = 0; i < bassEnd; i++) bassEnergy += micSmoothed[i] * micSmoothed[i];
    bassEnergy /= bassEnd;
    // Exponential moving average of energy
    beatAvg += (bassEnergy - beatAvg) * 0.05;
    beatEnergy = bassEnergy;
}

function updateBeat(dt) {
    if (beatCooldownTimer > 0) beatCooldownTimer -= dt;
    // Detect beat: energy spike above running average
    if (micActive && beatEnergy > beatAvg * BEAT_THRESHOLD && beatEnergy > 0.01 && beatCooldownTimer <= 0) {
        beatDecay = 1;
        beatCooldownTimer = BEAT_COOLDOWN;
        beatCount++;
    }
    // Decay the visual pulse
    if (beatDecay > 0) {
        beatDecay = Math.max(0, beatDecay - dt * 4); // ~0.25s decay
    }
}

// Map a screen-space position to a frequency bin index based on current mapping mode
function posToFreqBin(sx, sy, cw, ch, binCount) {
    let t;
    switch (freqBandMode) {
        case 1: // left-to-right
            t = Math.min(Math.max(sx / cw, 0), 1);
            break;
        case 2: // top-to-bottom
            t = Math.min(Math.max(sy / ch, 0), 1);
            break;
        default: { // radial (0)
            const dx = sx - cw * 0.5, dy = sy - ch * 0.5;
            const maxR = Math.sqrt(cw * cw + ch * ch) * 0.25;
            t = Math.min(Math.sqrt(dx * dx + dy * dy) / maxR, 1);
            break;
        }
    }
    const mapped = Math.pow(t, 0.6);
    return Math.min(Math.floor(mapped * binCount), binCount - 1);
}

// ── Multi-band color: bass=R, mids=G, treble=B ─────────
// Computes RGB floats (0-1) and stores in _cbR, _cbG, _cbB
function computeColorbandRGB(sx, sy, cw, ch, smoothed) {
    const count = smoothed.length;
    const third = Math.floor(count / 3);
    let bass = 0, mids = 0, treb = 0;
    const step = Math.max(1, Math.floor(third / 8));
    let bassN = 0, midsN = 0, trebN = 0;
    for (let i = 0; i < third; i += step) { bass += smoothed[i]; bassN++; }
    for (let i = third; i < third * 2; i += step) { mids += smoothed[i]; midsN++; }
    for (let i = third * 2; i < count; i += step) { treb += smoothed[i]; trebN++; }
    bass /= bassN; mids /= midsN; treb /= trebN;
    const bin = posToFreqBin(sx, sy, cw, ch, count);
    const localE = smoothed[bin];
    const boost = 0.3 + localE * 2.5;
    _cbR = Math.min(1, bass * boost * 1.57);
    _cbG = Math.min(1, mids * boost * 1.57);
    _cbB = Math.min(1, treb * boost * 1.57);
}

// ── Fullscreen Toggle ──────────────────────────────────

function toggleFullscreen() {
    if (window.electronAPI) {
        window.electronAPI.toggleFullscreen();
        showLabel('FULLSCREEN');
    } else {
        if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen().catch(() => {});
            showLabel('FULLSCREEN');
        } else {
            document.exitFullscreen().catch(() => {});
            showLabel('WINDOWED');
        }
    }
}

// ── Window Transparency ────────────────────────────────

function toggleTransparency() {
    if (!window.electronAPI) {
        showLabel('ELECTRON ONLY');
        return;
    }
    windowTransparent = !windowTransparent;
    window.electronAPI.setTransparency(windowTransparent);
    showLabel(windowTransparent ? 'TRANSPARENT' : 'OPAQUE');
    saveSettings();
}

// ── Now Playing ────────────────────────────────────────

async function startNowPlaying() {
    if (!window.electronAPI || nowPlayingActive) return;
    const hasIt = await window.electronAPI.hasNowPlaying();
    if (!hasIt) return;
    nowPlayingActive = true;
    window.electronAPI.onNowPlaying((data) => {
        if (!nowPlayingActive) return;
        if (!data.title && !data.artist) {
            nowPlayingInfo = null;
            return;
        }
        nowPlayingInfo = data;
        // Don't interrupt type/clock mode
        if (typeMode || clockMode) return;
        // If a mode label is currently fading, let it finish — the restore
        // logic in updateTextEffect will pick up the new nowPlayingInfo
        if (textEffectActive && !nowPlayingTextActive) return;
        const text = data.artist
            ? `${data.artist.toUpperCase()}\n${data.title.toUpperCase()}`
            : data.title.toUpperCase();
        const key = `${logicalW}:${logicalH}:${text}`;
        if (key !== lastTextKey) {
            lastTextKey = key;
            computeTextField(text);
        } else {
            textEffectActive = true;
        }
        nowPlayingTextActive = true;
        textEffectStrength = 1;
        modeLabelAlpha = 1;
    });
    await window.electronAPI.startNowPlaying();
}

function stopNowPlaying() {
    if (!nowPlayingActive) return;
    nowPlayingActive = false;
    nowPlayingInfo = null;
    nowPlayingTextActive = false;
    if (window.electronAPI) {
        window.electronAPI.stopNowPlaying();
        window.electronAPI.removeNowPlayingListener();
    }
    // Clear dot text if now-playing was driving it
    if (!typeMode && !clockMode) {
        textEffectActive = false;
        textEffectStrength = 0;
    }
}

async function toggleNowPlaying() {
    if (!window.electronAPI) {
        showLabel('ELECTRON ONLY');
        return;
    }
    if (nowPlayingActive) {
        stopNowPlaying();
        showLabel('NOW PLAYING OFF');
    } else {
        await startNowPlaying();
        showLabel('NOW PLAYING');
    }
}

// ── Clock Mode ─────────────────────────────────────────

function toggleClockMode() {
    if (clockMode) {
        clockMode = false;
        lastClockText = '';
        textEffectActive = false;
        textEffectStrength = 0;
        showLabel('CLOCK OFF');
        return;
    }
    clockMode = true;
    typeMode = false;
    typeText = '';
    if (!waveActive) {
        waveOrigin.x = mouseWorld.x;
        waveOrigin.y = mouseWorld.y;
        waveTime = 0;
        waveActive = true;
        wakeVisibleDots();
    }
    updateClockText();
}

function updateClockText() {
    const now = new Date();
    const h = String(now.getHours()).padStart(2, '0');
    const m = String(now.getMinutes()).padStart(2, '0');
    const s = String(now.getSeconds()).padStart(2, '0');
    const text = `${h}:${m}:${s}`;
    if (text === lastClockText) return;
    lastClockText = text;
    const key = `${logicalW}:${logicalH}:${text}`;
    if (key !== lastTextKey) {
        lastTextKey = key;
        computeTextField(text);
    } else {
        textEffectActive = true;
    }
    textEffectStrength = 1;
    modeLabelAlpha = 1;
}

// ── Drawing (WebGL) ────────────────────────────────────

function drawDots() {
    glDotCount = 0;

    const zf = zoomFactor;
    const hw = logicalW / 2;
    const hh = logicalH / 2;
    const offX = hw - (hw + camera.x) * zf;
    const offY = hh - (hh + camera.y) * zf;
    const cw = logicalW;
    const ch = logicalH;
    const gs = gridSpacing;
    const gox = gridOriginX;
    const goy = gridOriginY;
    const step = lodStep;
    const baseR = Math.max(dotRadius * zf, 0.8);

    // Mic draw-time state
    const micDraw = micActive && micSmoothed;
    const micBins = micDraw ? micSmoothed.length : 0;
    const micCx = cw * 0.5, micCy = ch * 0.5;
    const micVolScale = micDraw ? (0.3 + micPeak * 5) : 0;
    const micPropFps = Math.max(fps, 30);
    const micPropSpd = 450;

    // Text dot effect state
    const textDraw = textEffectActive && textEffectStrength > 0;
    const txtMarg = textDraw ? 200 : 0;
    const margin = 10;

    // Colorband mode flag
    const cbDraw = fxColorBand && micDraw;

    // Beat visual: pulse the base radius
    const beatR = beatDecay > 0 ? baseR * (1 + beatDecay * 0.4) : baseR;

    const { iMin, iMax, jMin, jMax } = getVisibleRange(0);
    debugDotTotal = (iMax - iMin + 1) * (jMax - jMin + 1);
    debugDotActive = activeDots.size;

    let drawn = 0;
    let micAffected = 0;
    const iStart = Math.ceil(iMin / step) * step;
    const jStart = Math.ceil(jMin / step) * step;

    // ── 1) Resting dots ─────────────────────────────────
    for (let i = iStart; i <= iMax; i += step) {
        const wx = i * gs + gox;
        const colSx = wx * zf + offX;
        if (colSx < -margin - txtMarg || colSx > cw + margin + txtMarg) continue;
        for (let j = jStart; j <= jMax; j += step) {
            if (activeKeySet.has(dotKey(i, j))) continue;
            const rowSy = (j * gs + goy) * zf + offY;
            if (rowSy < -margin - txtMarg || rowSy > ch + margin + txtMarg) continue;

            let sx = colSx, sy = rowSy;
            let cr = 1, cg = 1, cb = 1; // white default

            if (micDraw) {
                const mdx = colSx - micCx, mdy = rowSy - micCy;
                const mDist = Math.sqrt(mdx * mdx + mdy * mdy);
                if (mDist > 0.1) {
                    const bin = posToFreqBin(sx, sy, cw, ch, micBins);
                    const energy = micSmoothed[bin];
                    const disp = energy * gs * zf * 2 * micVolScale;

                    const delayFrames = Math.min(Math.round(mDist / micPropSpd * micPropFps), MIC_PROP_SIZE - 1);
                    const propIdx = ((micPropHead - 1 - delayFrames) % MIC_PROP_SIZE + MIC_PROP_SIZE) % MIC_PROP_SIZE;
                    const propEnergy = micPropBuf[propIdx];
                    const propDecay = 1 / (1 + mDist * 0.002);
                    const propDisp = propEnergy * gs * zf * 2 * propDecay;

                    const totalDisp = disp + propDisp;
                    sx += (mdx / mDist) * totalDisp;
                    sy += (mdy / mDist) * totalDisp;
                    if (totalDisp > 0.5) micAffected++;

                    if (!cbDraw) {
                        const visualEnergy = Math.max(energy, propEnergy * propDecay);
                        if (visualEnergy > 0.02) {
                            const ci = Math.min((visualEnergy * 357) | 0, 255);
                            const ci3 = ci * 3;
                            cr = COLOR_LUT_RGB[ci3];
                            cg = COLOR_LUT_RGB[ci3 + 1];
                            cb = COLOR_LUT_RGB[ci3 + 2];
                        }
                    }
                }
            }

            if (textDraw && textDisp(sx, sy)) { sx += _tdx; sy += _tdy; }

            if (cbDraw) {
                computeColorbandRGB(sx, sy, cw, ch, micSmoothed);
                cr = _cbR; cg = _cbG; cb = _cbB;
            }

            pushDot(sx, sy, beatR, cr, cg, cb);
            drawn++;
        }
    }

    // ── 2) Active dots ──────────────────────────────────
    for (const [, dot] of activeDots) {
        let sx = dot.x * zf + offX;
        let sy = dot.y * zf + offY;
        if (sx < -margin - 20 - txtMarg || sx > cw + margin + 20 + txtMarg ||
            sy < -margin - 20 - txtMarg || sy > ch + margin + 20 + txtMarg) continue;

        const speed = Math.sqrt(dot.vx * dot.vx + dot.vy * dot.vy);

        // Mic displacement for active dots
        if (micDraw) {
            const mdx = sx - micCx, mdy = sy - micCy;
            const mDist = Math.sqrt(mdx * mdx + mdy * mdy);
            if (mDist > 0.1) {
                const bin = posToFreqBin(sx, sy, cw, ch, micBins);
                const energy = micSmoothed[bin];
                const disp = energy * gs * zf * 2 * micVolScale;

                const delayFrames = Math.min(Math.round(mDist / micPropSpd * micPropFps), MIC_PROP_SIZE - 1);
                const propIdx = ((micPropHead - 1 - delayFrames) % MIC_PROP_SIZE + MIC_PROP_SIZE) % MIC_PROP_SIZE;
                const propEnergy = micPropBuf[propIdx];
                const propDecay = 1 / (1 + mDist * 0.002);
                const propDisp = propEnergy * gs * zf * 2 * propDecay;

                const totalDisp = disp + propDisp;
                sx += (mdx / mDist) * totalDisp;
                sy += (mdy / mDist) * totalDisp;
            }
        }

        if (textDraw && textDisp(sx, sy)) { sx += _tdx; sy += _tdy; }

        let r = beatR;
        if (fxSize) r = beatR * (1 + Math.min(speed * 0.0008, 0.3));

        let cr, cg, cb;
        if (cbDraw) {
            computeColorbandRGB(sx, sy, cw, ch, micSmoothed);
            cr = _cbR; cg = _cbG; cb = _cbB;
        } else if (micDraw) {
            cr = 1; cg = 1; cb = 1;
            const mdx = sx - micCx, mdy = sy - micCy;
            const mDist = Math.sqrt(mdx * mdx + mdy * mdy);
            const bin = posToFreqBin(sx, sy, cw, ch, micBins);
            const energy = micSmoothed[bin];
            const delayF = Math.min(Math.round(mDist / micPropSpd * micPropFps), MIC_PROP_SIZE - 1);
            const pIdx = ((micPropHead - 1 - delayF) % MIC_PROP_SIZE + MIC_PROP_SIZE) % MIC_PROP_SIZE;
            const pE = micPropBuf[pIdx] / (1 + mDist * 0.002);
            const visE = Math.max(energy, pE);
            if (visE > 0.02) {
                const ci = Math.min((visE * 357) | 0, 255);
                const ci3 = ci * 3;
                cr = COLOR_LUT_RGB[ci3];
                cg = COLOR_LUT_RGB[ci3 + 1];
                cb = COLOR_LUT_RGB[ci3 + 2];
            }
        } else if (fxColor) {
            const ci = Math.min((speed * 1.02) | 0, 255);
            const ci3 = ci * 3;
            cr = COLOR_LUT_RGB[ci3];
            cg = COLOR_LUT_RGB[ci3 + 1];
            cb = COLOR_LUT_RGB[ci3 + 2];
        } else {
            cr = 1; cg = 1; cb = 1;
        }

        pushDot(sx, sy, r, cr, cg, cb);
        drawn++;
    }

    debugDotDrawn = drawn;
    debugMicAffected = micAffected;

    // Upload + draw all dots in one GPU call
    drawDotsGL(gl);
}

function drawCursor() {
    if (!mouseHasEntered || !cursorVisible) return;
    ctx.beginPath();
    ctx.arc(cursor.x, cursor.y, cursor.radius, 0, Math.PI * 2);
    ctx.strokeStyle = cursor.color;
    ctx.lineWidth = cursor.lineWidth;
    ctx.stroke();
}

function drawNowPlaying() {
    if (!nowPlayingActive || !nowPlayingInfo) return;
    if (!nowPlayingInfo.title && !nowPlayingInfo.artist) return;

    const title = nowPlayingInfo.title || '';
    const artist = nowPlayingInfo.artist || '';
    const paused = nowPlayingInfo.rate === 0;

    const pad = 12;
    const x = pad + 6;
    const y = logicalH - pad;

    ctx.font = '600 13px -apple-system, "Helvetica Neue", sans-serif';
    ctx.textBaseline = 'bottom';
    ctx.textAlign = 'left';

    // Title
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillText(title, x, y - 16);

    // Artist (dimmer)
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = '400 11px -apple-system, "Helvetica Neue", sans-serif';
    ctx.fillText(artist + (paused ? '  ⏸' : ''), x, y);
}

function drawSpectrum() {
    if (!micActive || !micSmoothed) return;

    const bins = micSmoothed.length;
    const displayBins = Math.min(bins, 200);
    const totalW = logicalW * 0.7;
    const barW = totalW / displayBins;
    const maxH = 32;
    const x0 = (logicalW - totalW) / 2;
    const y0 = logicalH - maxH - 8;

    for (let i = 0; i < displayBins; i++) {
        const energy = micSmoothed[i];
        const h = Math.max(0.5, energy * maxH);
        const ci = Math.min(Math.floor((i / displayBins) * 255), 255);
        const ci3 = ci * 3;
        const r = Math.round(COLOR_LUT_RGB[ci3] * 255);
        const g = Math.round(COLOR_LUT_RGB[ci3 + 1] * 255);
        const b = Math.round(COLOR_LUT_RGB[ci3 + 2] * 255);
        ctx.fillStyle = `rgba(${r},${g},${b},0.35)`;
        ctx.fillRect(x0 + i * barW, y0 + maxH - h, Math.max(barW - 0.5, 0.5), h);
    }
}

function drawDebug() {
    if (!debugMode) return;

    const lines = [
        `FPS: ${fps}`,
        `DOTS: ${debugDotTotal.toLocaleString()}  DRAWN: ${debugDotDrawn.toLocaleString()}  ACTIVE: ${debugDotActive.toLocaleString()}${debugMicAffected ? `  MIC: ${debugMicAffected.toLocaleString()}` : ''}`,
        `GRID: ${gridSpacing}px  LOD: ${lodStep}x`,
        `ZOOM: ${zoomFactor.toFixed(2)}x`,
        `CAM: (${camera.x.toFixed(0)}, ${camera.y.toFixed(0)})`,
        `CURSOR: base=${cursor.baseRadius}  force=${mouseForceRadius.toFixed(0)}`,
        `MODE: [${waveMode}] ${MODE_NAMES[waveMode] || '?'}  WAVE: ${waveActive ? 'ON' : 'OFF'}  t=${waveTime.toFixed(1)}`,
        `FX: color=${fxColor ? 'ON' : 'OFF'}  size=${fxSize ? 'ON' : 'OFF'}  colorband=${fxColorBand ? 'ON' : 'OFF'}  mic=${micActive ? 'ON' : 'OFF'}${micActive ? `  peak=${micPeak.toFixed(2)}  bins=${micSmoothed ? micSmoothed.length : 0}` : ''}`,
        `THEME: ${THEME_NAMES[currentThemeIdx]}  FREQ: ${FREQ_BAND_NAMES[freqBandMode]}${micActive ? `  BEAT: ${beatCount}  decay=${beatDecay.toFixed(2)}` : ''}`,
        `SPRING: k=${springK} d=${springDamp} ζ≈${(springDamp / (2 * Math.sqrt(springK))).toFixed(2)}`,
        `RENDERER: WebGL  BUFFER: ${glDotCount.toLocaleString()} / ${GL_MAX_DOTS.toLocaleString()}`
    ];

    const x = 14;
    let y = 16;
    const lh = 18;

    ctx.font = '12px monospace';
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.fillRect(6, 6, 540, lines.length * lh + 12);
    ctx.fillStyle = '#0f0';
    for (let l = 0; l < lines.length; l++) {
        y += lh;
        ctx.fillText(lines[l], x, y);
    }
}

// ── Game Loop ───────────────────────────────────────────

function update(dt) {
    const speed = camSpeed / Math.sqrt(zoomFactor);
    if (keys.ArrowUp)    camera.y -= speed;
    if (keys.ArrowDown)  camera.y += speed;
    if (keys.ArrowLeft)  camera.x -= speed;
    if (keys.ArrowRight) camera.x += speed;

    mouseWorld = screenToWorld(cursor.x, cursor.y);

    if (waveActive) {
        waveOrigin.x = mouseWorld.x;
        waveOrigin.y = mouseWorld.y;
        waveTime += dt;
    }
    // Mic needs time to animate even without click
    if (micActive && !waveActive) {
        waveTime += dt;
    }

    cursor.radius += (cursor.targetRadius - cursor.radius) * 0.12;
    syncForceRadius();

    // Clock mode: update time display every second
    if (clockMode) updateClockText();

    // Text dot effect timing (replaces old mode label fade)
    updateTextEffect(dt);

    updateMic();
    updateBeat(dt);
    updateLOD();
    wakeNearMouse();

    // Cursor auto-hide
    cursorIdleTime += dt;
    if (cursorIdleTime > CURSOR_HIDE_DELAY) cursorVisible = false;

    updateDots(dt);
    sleepSettledDots();

    // Pre-build key set once per frame — O(activeDots.size) here saves
    // O(drawnDots) dotKey() + Map.has() calls in the inner draw loop
    activeKeySet = new Set(activeDots.keys());

    frameCount++;
    fpsAccum += dt;
    if (fpsAccum >= 0.5) {
        fps = Math.round(frameCount / fpsAccum);
        frameCount = 0;
        fpsAccum = 0;
    }
}

let pruneTimer = 0;

function loop(timestamp) {
    const dt = getDeltaTime(timestamp);
    update(dt);

    pruneTimer += dt;
    if (pruneTimer > 1) {
        pruneOffscreen();
        pruneTimer = 0;
    }

    // WebGL: draw dots (clears + renders in one call)
    drawDots();

    // 2D overlay (transparent background)
    ctx.clearRect(0, 0, logicalW, logicalH);
    drawCursor();
    drawNowPlaying();
    drawSpectrum();
    drawDebug();
    requestAnimationFrame(loop);
}

// ── Init ────────────────────────────────────────────────

// Initialize WebGL renderer
initWebGL(gl);

function tryAutoMic() {
    if (!micActive && micAutoStartPending) {
        micAutoStartPending = false;
        toggleMic();
    }
}

// Delay mic start until after the startup splash (fade-in + hold + fade-out)
const SPLASH_DURATION = TEXT_FADE_IN + 2.0 + TEXT_FADE_OUT + 0.1;

if (window.electronAPI) {
    setTimeout(() => toggleMic(), SPLASH_DURATION * 1000);
} else {
    function onFirstInteraction() {
        tryAutoMic();
        window.removeEventListener('click', onFirstInteraction);
        window.removeEventListener('keydown', onFirstInteraction);
    }
    window.addEventListener('click', onFirstInteraction);
    window.addEventListener('keydown', onFirstInteraction);
}

window.addEventListener('resize', resize);
window.addEventListener('beforeunload', saveSettings);
resize();
computeRingRadii();
wakeVisibleDots();

// Restore transparency state from saved settings
if (windowTransparent && window.electronAPI) {
    window.electronAPI.setTransparency(true);
}

// Auto-start now-playing (works for all sources: Spotify, browsers, Apple Music, etc.)
startNowPlaying();

// Startup splash — big "Hi" with the dotted i
textSizeBoost = 1.8;
textHoldOverride = 2.0;
showLabel('Hi');

loop();

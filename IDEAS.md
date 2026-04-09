# Grid Visualizer — Feature Ideas

## Done

### Bug Fixes
- [x] Fix `dotKey` integer overflow (bit-shift → safe multiplication)
- [x] Fix `cycleAudioSource` race condition (guard before async call)
- [x] Remove dead `drawModeLabel` function
- [x] Fix `cursor.isPressed` not reset on mouseup
- [x] Fix `hasOwnProperty` → `in` operator
- [x] Fix stale text field on resize (invalidate cache)

### Code Quality
- [x] HiDPI / Retina canvas support (`devicePixelRatio`)
- [x] Single instance lock (prevent multiple Electron instances)
- [x] Remove unused `key` destructuring in for...of loops
- [x] Use `requestAnimationFrame` timestamp instead of `performance.now()`
- [x] Build macOS DMG for both arm64 + x64
- [x] Audio process crash recovery (new `system-audio-error` IPC event)

### Performance
- [x] Pre-compute `activeKeySet` once per frame for O(1) draw-loop checks
- [x] Reduce `Math.sqrt` in physics (hoist dist, combine divisions)
- [x] Optimized gravity well inner loop (single `1/aDist` multiply)

### Features
- [x] Color themes — 8 palettes (Aurora, Ocean, Fire, Neon, Mono, Pastel, Sunset, Matrix), cycle with `C` key
- [x] Beat detection — bass energy spike detection, visual pulse on dots
- [x] Frequency band mapping — radial / left-to-right / top-to-bottom, toggle by typing `band`
- [x] Multi-band color — bass=R, mids=G, treble=B, toggle by typing `colorband`
- [x] Auto-hide cursor — hides after 3s idle, reappears on mouse move

---

## To Do

### UX / Discoverability
- [ ] Help overlay (H or ? key) — show all controls, modes, typed commands
- [ ] On-screen hint on first launch ("Press H for controls")
- [ ] Settings panel (Tab key) — sliders for grid spacing, spring stiffness, cursor size, wave speed, etc.
- [ ] Command palette (/ key) — searchable command input like VS Code
- [ ] Undo last action (Ctrl+Z)

### Visual / Aesthetic
- [ ] Background color picker — not just black (dark blue, purple, gradient)
- [ ] Trail / afterglow effect — semi-transparent clear for light-painting trails
- [ ] Dot shape variants — circle, square, diamond, star, cross
- [ ] Glow / bloom effect — radial gradient dots or post-process blur
- [ ] Connection lines — thin lines between displaced neighboring dots (mesh effect)
- [ ] Particle trails — fading particles along fast-moving dot paths
- [ ] Gradient dots — radial gradient per dot (bright center, soft edge)
- [ ] Day/night cycle — background slowly shifts over minutes

### Audio / Music
- [ ] Audio gain / sensitivity slider
- [ ] Multi-band color with custom band ranges
- [ ] BPM sync — auto-detect tempo from audio, sync wave animations
- [ ] MIDI input — Web MIDI API, map knobs to parameters, notes to mode switches
- [ ] Audio file playback — drag-and-drop MP3/WAV
- [x] Spotify / system now-playing integration — auto-show track name in Type mode
- [x] Audio frequency visualization overlay — small spectrum bar when audio is active

### Interaction / Physics
- [ ] Multiple wave origins — Shift+click to place additional sources
- [ ] Gravity wells — click to place persistent attractors
- [ ] Repulsion zones — Alt+click to place repulsion points
- [ ] Physics presets — Jelly, Snappy, Bouncy, Liquid, Rigid
- [ ] Explosion effect — double-click for radial burst
- [ ] Magnetic cursor modes — Repel (current), Attract, Swirl, Freeze
- [ ] Wind force — global directional push following mouse movement
- [ ] Elastic boundaries — dots bounce off screen edges

### Export / Sharing
- [ ] Screenshot (P key) — save canvas as high-res PNG
- [ ] Video recording (R key) — MediaRecorder to WebM
- [ ] GIF export — last N seconds as animated GIF
- [ ] Wallpaper mode — borderless transparent window behind all others
- [ ] Shareable presets — export/import settings as JSON
- [ ] OBS virtual camera — expose canvas as camera source

### New Wave Modes
- [ ] Fractal mode — Sierpinski, Koch, Mandelbrot boundaries
- [ ] Voronoi mode — dots form cell boundaries around seed points
- [ ] Lissajous mode — dots trace Lissajous curves from audio
- [ ] Particle swarm / Boids — alignment, cohesion, separation
- [ ] Waveform mode — oscilloscope-style raw audio waveform
- [ ] Galaxy mode — spiral arms with density waves
- [ ] DNA helix — intertwined 3D spirals projected to 2D
- [ ] Terrain mode — heightmap from audio (brightness/size = Z)
- [x] Clock mode — dots form current time, smooth transitions

### Technical / Performance
- [x] WebGL renderer — point-sprite shader for 500K+ dots at 60fps
- [ ] Web Workers for physics — offload `updateDots` to worker thread
- [ ] Adaptive quality — auto-adjust LOD/density based on FPS
- [ ] GPU-accelerated FFT — WebGL compute or WASM SIMD
- [ ] Frame interpolation — fixed physics tick, interpolated rendering
- [ ] ES modules — replace global script tags with proper imports

### Quality of Life
- [x] Persist settings — localStorage / electron-store for zoom, mode, theme, etc.
- [ ] Keyboard shortcut customization
- [x] Fullscreen toggle (F key) — `canvas.requestFullscreen()` for browser mode
- [x] Window transparency — Electron transparent window option
- [ ] Multi-monitor audio source selection
- [x] Startup mode selection — remember last active mode

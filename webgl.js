// ── WebGL Point-Sprite Dot Renderer ────────────────────
// Replaces Canvas 2D batched rendering with a single GPU draw call.
// All dots are rendered as GL_POINTS with circular fragment shader.

const GL_MAX_DOTS = 50000;

// CPU-side interleaved buffer: [x, y, radius, r, g, b] per dot (6 floats)
const glDotBuf = new Float32Array(GL_MAX_DOTS * 6);
let glDotCount = 0;

let _glProgram = null;
let _glVBO = null;
let _uResolution = null;
let _uDpr = null;
let _aPos = -1;
let _aRadius = -1;
let _aColor = -1;

// ── Shaders ────────────────────────────────────────────

const _VS_SRC = `
attribute vec2 a_position;
attribute float a_radius;
attribute vec3 a_color;

uniform vec2 u_resolution;
uniform float u_dpr;

varying vec3 v_color;

void main() {
    vec2 clip = (a_position / u_resolution) * 2.0 - 1.0;
    clip.y = -clip.y;
    gl_Position = vec4(clip, 0.0, 1.0);
    gl_PointSize = max(a_radius * 2.0 * u_dpr, 1.0);
    v_color = a_color;
}
`;

const _FS_SRC = `
precision mediump float;
varying vec3 v_color;

void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d2 = dot(c, c);
    if (d2 > 0.25) discard;
    // Soft anti-aliased edge (1px feather at point boundary)
    float alpha = 1.0 - smoothstep(0.22, 0.25, d2);
    gl_FragColor = vec4(v_color * alpha, alpha);
}
`;

// ── Helpers ────────────────────────────────────────────

function _compileShader(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        console.error('Shader compile error:', gl.getShaderInfoLog(s));
        gl.deleteShader(s);
        return null;
    }
    return s;
}

// ── Public API ─────────────────────────────────────────

function initWebGL(gl) {
    const vs = _compileShader(gl, gl.VERTEX_SHADER, _VS_SRC);
    const fs = _compileShader(gl, gl.FRAGMENT_SHADER, _FS_SRC);
    if (!vs || !fs) return;

    _glProgram = gl.createProgram();
    gl.attachShader(_glProgram, vs);
    gl.attachShader(_glProgram, fs);
    gl.linkProgram(_glProgram);
    if (!gl.getProgramParameter(_glProgram, gl.LINK_STATUS)) {
        console.error('Program link error:', gl.getProgramInfoLog(_glProgram));
        return;
    }
    gl.useProgram(_glProgram);

    // Attribute locations
    _aPos = gl.getAttribLocation(_glProgram, 'a_position');
    _aRadius = gl.getAttribLocation(_glProgram, 'a_radius');
    _aColor = gl.getAttribLocation(_glProgram, 'a_color');

    // Uniform locations
    _uResolution = gl.getUniformLocation(_glProgram, 'u_resolution');
    _uDpr = gl.getUniformLocation(_glProgram, 'u_dpr');

    // Interleaved VBO — pre-allocate for max dots (1.2MB at 50K)
    _glVBO = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, _glVBO);
    gl.bufferData(gl.ARRAY_BUFFER, GL_MAX_DOTS * 24, gl.DYNAMIC_DRAW);

    // Attribute pointers (stride = 6 floats = 24 bytes)
    const stride = 24;
    gl.enableVertexAttribArray(_aPos);
    gl.vertexAttribPointer(_aPos, 2, gl.FLOAT, false, stride, 0);    // offset 0
    gl.enableVertexAttribArray(_aRadius);
    gl.vertexAttribPointer(_aRadius, 1, gl.FLOAT, false, stride, 8);  // offset 8
    gl.enableVertexAttribArray(_aColor);
    gl.vertexAttribPointer(_aColor, 3, gl.FLOAT, false, stride, 12);  // offset 12

    // Blending for soft edges
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    // Black background
    gl.clearColor(0, 0, 0, 1);
}

function resizeGL(gl, w, h, dpr) {
    gl.viewport(0, 0, w * dpr, h * dpr);
    if (_uResolution) gl.uniform2f(_uResolution, w, h);
    if (_uDpr) gl.uniform1f(_uDpr, dpr);
}

function pushDot(x, y, radius, r, g, b) {
    if (glDotCount >= GL_MAX_DOTS) return;
    const off = glDotCount * 6;
    glDotBuf[off] = x;
    glDotBuf[off + 1] = y;
    glDotBuf[off + 2] = radius;
    glDotBuf[off + 3] = r;
    glDotBuf[off + 4] = g;
    glDotBuf[off + 5] = b;
    glDotCount++;
}

function drawDotsGL(gl) {
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (glDotCount === 0) return;

    gl.bindBuffer(gl.ARRAY_BUFFER, _glVBO);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, glDotBuf.subarray(0, glDotCount * 6));
    gl.drawArrays(gl.POINTS, 0, glDotCount);
}

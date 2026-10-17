/* ==========================================================================
   swarm.js — SwarmCursor, vanilla port
   --------------------------------------------------------------------------
   A dependency-free port of the React Bits <SwarmCursor />. The whole engine
   — WebGL2 program, the semi-Lagrangian fluid solve with vorticity
   confinement and a Jacobi pressure projection, and the particle update —
   is the original; React's useRef/useEffect shell is replaced by a plain
   factory that mounts one fixed, full-viewport canvas.

   Why a port: the official Track 3 workflow runs no build step, it uploads
   site/ verbatim, so an npm dependency can never reach Azure.

   It is strictly decorative and strictly optional:
     • needs WebGL2 — falls back to the CSS ring cursor if absent
     • off for touch / coarse pointers and for prefers-reduced-motion
     • pointer-events:none, aria-hidden, never captures input
     • parks its rAF loop when the tab is hidden
   ========================================================================== */
(function (global) {
  'use strict';

  var MAX_PARTICLES = 2000;
  var INTRO_SECONDS = 1.4;
  var SHAPES = { dot: 0, square: 1, streak: 2 };
  var CELL = 16;
  var MAX_COLS = 72;
  var MAX_ROWS = 48;
  var PRESSURE_STEPS = 12;

  var VERTEX = '#version 300 es\n' +
    'layout(location = 0) in vec2 aCorner;\n' +
    'layout(location = 1) in vec4 aAgent;\n' +
    'layout(location = 2) in vec4 aLook;\n' +
    'layout(location = 3) in vec2 aExtra;\n' +
    'uniform vec2 uView;\n' +
    'out vec2 vLocal; out vec2 vHalf; out float vAlpha; out float vTint;\n' +
    'out float vSoft; out float vShape;\n' +
    'void main() {\n' +
    '  vec2 dir = aAgent.zw;\n' +
    '  vec2 side = vec2(-dir.y, dir.x);\n' +
    '  vec2 extent = aLook.xy * 0.5;\n' +
    '  vec2 pad = extent + 1.0 + aExtra.x * 1.5;\n' +
    '  vec2 local = aCorner * pad;\n' +
    '  vec2 center = aAgent.xy - dir * (extent.x - extent.y);\n' +
    '  vec2 pos = center + dir * local.x + side * local.y;\n' +
    '  vLocal = local; vHalf = extent; vAlpha = aLook.z; vTint = aLook.w;\n' +
    '  vSoft = aExtra.x; vShape = aExtra.y;\n' +
    '  vec2 clip = pos / uView * 2.0 - 1.0;\n' +
    '  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);\n' +
    '}';

  var FRAGMENT = '#version 300 es\n' +
    'precision highp float;\n' +
    'uniform vec3 uColor; uniform vec3 uAccent; uniform float uRatio;\n' +
    'in vec2 vLocal; in vec2 vHalf; in float vAlpha; in float vTint;\n' +
    'in float vSoft; in float vShape;\n' +
    'out vec4 outColor;\n' +
    'void main() {\n' +
    '  float d;\n' +
    '  if (vShape > 0.5 && vShape < 1.5) {\n' +
    '    float corner = vHalf.y * 0.3;\n' +
    '    vec2 q = abs(vLocal) - vHalf + corner;\n' +
    '    d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - corner;\n' +
    '  } else {\n' +
    '    vec2 q = vLocal;\n' +
    '    q.x = max(abs(q.x) - (vHalf.x - vHalf.y), 0.0);\n' +
    '    d = length(q) - vHalf.y;\n' +
    '  }\n' +
    '  float edge = 0.6 / uRatio + vSoft;\n' +
    '  float cover = 1.0 - smoothstep(-edge, edge, d);\n' +
    '  float stretch = clamp(1.0 - vHalf.y / max(vHalf.x, 0.001), 0.0, 1.0);\n' +
    '  float head = clamp((vLocal.x + vHalf.x) / max(2.0 * vHalf.x, 0.001), 0.0, 1.0);\n' +
    '  cover *= mix(1.0, 0.12 + 0.88 * head * head, stretch);\n' +
    '  float alpha = cover * vAlpha;\n' +
    '  outColor = vec4(mix(uColor, uAccent, vTint) * alpha, alpha);\n' +
    '}';

  var clamp = function (v, lo, hi) { return Math.min(hi, Math.max(lo, v)); };

  function compile(gl, type, src) {
    var sh = gl.createShader(type);
    if (!sh) return null;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (gl.getShaderParameter(sh, gl.COMPILE_STATUS)) return sh;
    gl.deleteShader(sh);
    return null;
  }

  function link(gl) {
    var v = compile(gl, gl.VERTEX_SHADER, VERTEX);
    var f = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
    var p = gl.createProgram();
    if (!v || !f || !p) return null;
    gl.attachShader(p, v); gl.attachShader(p, f); gl.linkProgram(p);
    gl.deleteShader(v); gl.deleteShader(f);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) { gl.deleteProgram(p); return null; }
    var u = {}, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (var i = 0; i < n; i++) {
      var info = gl.getActiveUniform(p, i);
      if (info) u[info.name] = gl.getUniformLocation(p, info.name);
    }
    return { program: p, uniforms: u };
  }

  function random(seed) {
    var s = seed >>> 0 || 1;
    return function () {
      s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
      return (s >>> 0) / 4294967296;
    };
  }

  function rectField(x, y, hx, hy, r, out) {
    var sx = x < 0 ? -1 : 1, sy = y < 0 ? -1 : 1;
    var qx = Math.abs(x) - (hx - r), qy = Math.abs(y) - (hy - r);
    if (qx > 0 && qy > 0) {
      var l = Math.hypot(qx, qy) || 1;
      out[0] = l - r; out[1] = (qx / l) * sx; out[2] = (qy / l) * sy;
    } else if (qx > qy) { out[0] = qx - r; out[1] = sx; out[2] = 0; }
    else { out[0] = qy - r; out[1] = 0; out[2] = sy; }
    return out;
  }

  /* ====================================================== mount ========= */
  function mount(opts) {
    opts = opts || {};

    var reduce = global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var fine = global.matchMedia && global.matchMedia('(hover:hover) and (pointer:fine)').matches;
    if (reduce || !fine) return null;

    var canvas = document.createElement('canvas');
    canvas.className = 'swarm';
    canvas.setAttribute('aria-hidden', 'true');
    var gl = canvas.getContext('webgl2', {
      alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false
    });
    if (!gl) return null;
    var shader = link(gl);
    if (!shader) return null;
    document.body.appendChild(canvas);
    var u = shader.uniforms;

    var s = {
      count: Math.round(clamp(opts.count || 420, 1, MAX_PARTICLES)),
      size: clamp(opts.size || 2.4, 0.5, 16),
      shape: SHAPES[opts.shape] != null ? SHAPES[opts.shape] : 0,
      color: opts.color || '#ffffff',
      accentColor: opts.accentColor || opts.color || '#ffffff',
      spread: clamp(opts.spread || 100, 20, 400),
      speed: clamp(opts.speed == null ? 1 : opts.speed, 0, 4),
      swirl: clamp(opts.swirl == null ? 0.6 : opts.swirl, 0, 1),
      tail: clamp(opts.tail == null ? 0.5 : opts.tail, 0, 1),
      trail: clamp(opts.trail == null ? 0.6 : opts.trail, 0, 3),
      wander: clamp(opts.wander == null ? 0.5 : opts.wander, 0, 2),
      depth: clamp(opts.depth == null ? 0.7 : opts.depth, 0, 1),
      targets: opts.targets == null ? 'a, button, [role="button"]' : opts.targets,
      idle: opts.idle || 'hide',
      clickEffect: opts.clickEffect || 'burst',
      intro: opts.intro !== false,
      enabled: true,
      lightMode: !!opts.lightMode,
      dpr: opts.dpr || 1.5
    };

    /* colour parsing via a 1x1 canvas, cached */
    var probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    var colorCache = {};
    function parse(value) {
      var key = String(value);
      if (colorCache[key]) return colorCache[key];
      var rgb = [1, 1, 1];
      if (probe) {
        probe.clearRect(0, 0, 1, 1);
        probe.fillStyle = '#000000';
        probe.fillStyle = key;
        probe.fillRect(0, 0, 1, 1);
        var d = probe.getImageData(0, 0, 1, 1).data;
        rgb = [d[0] / 255, d[1] / 255, d[2] / 255];
      }
      colorCache[key] = rgb;
      return rgb;
    }

    /* ---- GL buffers ---- */
    var slots = MAX_PARTICLES + 1;
    var vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    var cornerBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    var agentData = new Float32Array(slots * 4);
    var lookData = new Float32Array(slots * 4);
    var extraData = new Float32Array(slots * 2);
    function instanced(loc, width, data) {
      var b = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, data.byteLength, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, width, gl.FLOAT, false, 0, 0);
      gl.vertexAttribDivisor(loc, 1);
      return b;
    }
    var agentBuffer = instanced(1, 4, agentData);
    var lookBuffer = instanced(2, 4, lookData);
    var extraBuffer = instanced(3, 2, extraData);
    gl.bindVertexArray(null);

    /* ---- state ---- */
    var view = { width: 1, height: 1, ratio: 1 };
    var px = new Float32Array(MAX_PARTICLES), py = new Float32Array(MAX_PARTICLES);
    var pz = new Float32Array(MAX_PARTICLES);
    var vx = new Float32Array(MAX_PARTICLES), vy = new Float32Array(MAX_PARTICLES);
    var vz = new Float32Array(MAX_PARTICLES);
    var home = new Float32Array(MAX_PARTICLES), heft = new Float32Array(MAX_PARTICLES);
    var bob = new Float32Array(MAX_PARTICLES), bobRate = new Float32Array(MAX_PARTICLES);
    var grain = new Float32Array(MAX_PARTICLES), glint = new Float32Array(MAX_PARTICLES);
    var order = new Int32Array(MAX_PARTICLES);
    var field = [0, 0, 0];
    var cols = 1, rows = 1, cell = CELL;
    var flowX = new Float32Array(1), flowY = new Float32Array(1);
    var lastX = new Float32Array(1), lastY = new Float32Array(1);
    var pressure = new Float32Array(1), divergence = new Float32Array(1), curl = new Float32Array(1);
    var pointer = { x: 0, y: 0, inside: false };
    var anchor = { x: 0, y: 0, lastX: 0, lastY: 0, moveX: 0, moveY: 0 };
    var ring = { active: false, x: 0, y: 0, hx: 0, hy: 0, corner: 0, spin: 1 };
    var burst = { age: 10 };
    var ping = { age: 10, x: 0, y: 0 };
    var hovered = null, time = 0, presence = 1;
    var introClock = s.intro ? 0 : 1;
    var raf = 0, last = 0, seeded = false, sorted = 0;
    var IDLE_PARK_MS = 3500;
    var lastMoveAt = (global.performance && performance.now()) || 0;

    function allocate() {
      var nc = clamp(Math.round(view.width / CELL), 8, MAX_COLS);
      var nr = clamp(Math.round(view.height / CELL), 8, MAX_ROWS);
      cell = Math.max(view.width / nc, view.height / nr);
      if (nc === cols && nr === rows) return;
      cols = nc; rows = nr;
      var t = cols * rows;
      flowX = new Float32Array(t); flowY = new Float32Array(t);
      lastX = new Float32Array(t); lastY = new Float32Array(t);
      pressure = new Float32Array(t); divergence = new Float32Array(t); curl = new Float32Array(t);
    }

    function sample(values, x, y) {
      var gx = x / cell - 0.5, gy = y / cell - 0.5;
      if (gx < 0) gx = 0; else if (gx > cols - 1.001) gx = cols - 1.001;
      if (gy < 0) gy = 0; else if (gy > rows - 1.001) gy = rows - 1.001;
      var i = gx | 0, j = gy | 0, fx = gx - i, fy = gy - j, k = i + j * cols;
      return (values[k] * (1 - fx) + values[k + 1] * fx) * (1 - fy) +
             (values[k + cols] * (1 - fx) + values[k + cols + 1] * fx) * fy;
    }

    function walls(values, axis) {
      var i, j;
      for (j = 1; j < rows - 1; j++) {
        var l = j * cols, r = l + cols - 1;
        values[l] = axis === 1 ? -values[l + 1] : values[l + 1];
        values[r] = axis === 1 ? -values[r - 1] : values[r - 1];
      }
      for (i = 1; i < cols - 1; i++) {
        var b = i + (rows - 1) * cols;
        values[i] = axis === 2 ? -values[i + cols] : values[i + cols];
        values[b] = axis === 2 ? -values[b - cols] : values[b - cols];
      }
      values[0] = 0.5 * (values[1] + values[cols]);
      values[cols - 1] = 0.5 * (values[cols - 2] + values[2 * cols - 1]);
      values[(rows - 1) * cols] = 0.5 * (values[(rows - 2) * cols] + values[(rows - 1) * cols + 1]);
      values[rows * cols - 1] = 0.5 * (values[rows * cols - 2] + values[(rows - 1) * cols - 1]);
    }

    function stir(dt, ease) {
      var radius = s.spread, reach = radius * 2.2;
      var i0 = Math.max(1, Math.floor((anchor.x - reach) / cell));
      var i1 = Math.min(cols - 2, Math.ceil((anchor.x + reach) / cell));
      var j0 = Math.max(1, Math.floor((anchor.y - reach) / cell));
      var j1 = Math.min(rows - 2, Math.ceil((anchor.y + reach) / cell));
      var inv = 1 / (radius * radius * 0.55);
      var moving = Math.hypot(anchor.moveX, anchor.moveY);
      var grab = (1 - Math.exp(-dt * 20)) * clamp(moving / 240, 0, 1) * presence;
      var whirl = ring.active ? 0 : radius * (0.5 + 4 * (1 - ease)) * (0.35 + 0.65 * s.speed);
      var churn = s.wander * radius * 14 * (0.4 + 0.6 * s.speed);
      var fk = 1.4 / radius, ft = time * 0.75 * (0.4 + 0.6 * s.speed);
      for (var j = j0; j <= j1; j++) {
        for (var i = i0; i <= i1; i++) {
          var k = i + j * cols;
          var x = (i + 0.5) * cell, y = (j + 0.5) * cell;
          var rx = x - anchor.x, ry = y - anchor.y;
          var d2 = rx * rx + ry * ry;
          var w = Math.exp(-d2 * inv);
          if (w < 0.003) continue;
          var d = Math.sqrt(d2) + 0.001;
          flowX[k] += (anchor.moveX - flowX[k]) * w * grab;
          flowY[k] += (anchor.moveY - flowY[k]) * w * grab;
          var reachOut = Math.min(1, d / (radius * 0.45));
          flowX[k] += (-ry / d) * whirl * reachOut * w * dt;
          flowY[k] += (rx / d) * whirl * reachOut * w * dt;
          var a1 = x * fk + ft, b1 = y * fk * 1.1 - ft * 0.8;
          var a2 = y * fk * 1.7 + ft * 1.2 + 1.3, b2 = x * fk * 1.3 - 0.7;
          var cX = -Math.sin(a1) * Math.sin(b1) * 1.1 + 1.02 * Math.cos(a2) * Math.cos(b2);
          var cY = -(Math.cos(a1) * Math.cos(b1) - 0.78 * Math.sin(a2) * Math.sin(b2));
          flowX[k] += cX * churn * w * dt;
          flowY[k] += cY * churn * w * dt;
        }
      }
      if (!ring.active) return;
      var band = Math.max(4, radius * 0.16), margin = band + 24;
      var circulate = 230 * (0.4 + 0.6 * s.speed) * ring.spin;
      var r0 = Math.max(1, Math.floor((ring.x - ring.hx - margin) / cell));
      var r1 = Math.min(cols - 2, Math.ceil((ring.x + ring.hx + margin) / cell));
      var c0 = Math.max(1, Math.floor((ring.y - ring.hy - margin) / cell));
      var c1 = Math.min(rows - 2, Math.ceil((ring.y + ring.hy + margin) / cell));
      var rate = 1 - Math.exp(-dt * 6);
      for (var jj = c0; jj <= c1; jj++) {
        for (var ii = r0; ii <= r1; ii++) {
          var kk = ii + jj * cols;
          rectField((ii + 0.5) * cell - ring.x, (jj + 0.5) * cell - ring.y, ring.hx, ring.hy, ring.corner, field);
          var off = field[0] - (5 + band * 0.5);
          var ww = Math.exp(-(off * off) / (margin * margin * 0.35));
          if (ww < 0.01) continue;
          flowX[kk] += (-field[2] * circulate - flowX[kk]) * ww * rate;
          flowY[kk] += (field[1] * circulate - flowY[kk]) * ww * rate;
        }
      }
    }

    function flow(dt) {
      var total = cols * rows, i, j, k;
      for (j = 1; j < rows - 1; j++)
        for (i = 1; i < cols - 1; i++) {
          k = i + j * cols;
          curl[k] = (flowY[k + 1] - flowY[k - 1] - flowX[k + cols] + flowX[k - cols]) * (0.5 / cell);
        }
      var confine = s.swirl * cell * 9;
      for (j = 2; j < rows - 2; j++)
        for (i = 2; i < cols - 2; i++) {
          k = i + j * cols;
          var gx = Math.abs(curl[k + 1]) - Math.abs(curl[k - 1]);
          var gy = Math.abs(curl[k + cols]) - Math.abs(curl[k - cols]);
          var len = Math.hypot(gx, gy) + 1e-5;
          flowX[k] += (gy / len) * curl[k] * confine * dt;
          flowY[k] -= (gx / len) * curl[k] * confine * dt;
        }
      lastX.set(flowX); lastY.set(flowY);
      var back = dt / cell, fade = Math.exp(-dt / (0.35 + 1.5 * s.swirl));
      for (j = 1; j < rows - 1; j++)
        for (i = 1; i < cols - 1; i++) {
          k = i + j * cols;
          var x = i - back * lastX[k], y = j - back * lastY[k];
          if (x < 0.5) x = 0.5; else if (x > cols - 1.5) x = cols - 1.5;
          if (y < 0.5) y = 0.5; else if (y > rows - 1.5) y = rows - 1.5;
          var i0 = x | 0, j0 = y | 0, fx = x - i0, fy = y - j0, a = i0 + j0 * cols;
          flowX[k] = ((lastX[a] * (1 - fx) + lastX[a + 1] * fx) * (1 - fy) +
                      (lastX[a + cols] * (1 - fx) + lastX[a + cols + 1] * fx) * fy) * fade;
          flowY[k] = ((lastY[a] * (1 - fx) + lastY[a + 1] * fx) * (1 - fy) +
                      (lastY[a + cols] * (1 - fx) + lastY[a + cols + 1] * fx) * fy) * fade;
        }
      walls(flowX, 1); walls(flowY, 2);
      var h2 = cell * cell;
      for (j = 1; j < rows - 1; j++)
        for (i = 1; i < cols - 1; i++) {
          k = i + j * cols;
          divergence[k] = (flowX[k + 1] - flowX[k - 1] + flowY[k + cols] - flowY[k - cols]) * (0.5 / cell);
        }
      pressure.fill(0, 0, total);
      walls(divergence, 0);
      for (var step = 0; step < PRESSURE_STEPS; step++) {
        for (j = 1; j < rows - 1; j++)
          for (i = 1; i < cols - 1; i++) {
            k = i + j * cols;
            pressure[k] = (pressure[k - 1] + pressure[k + 1] + pressure[k - cols] +
                           pressure[k + cols] - h2 * divergence[k]) * 0.25;
          }
        walls(pressure, 0);
      }
      for (j = 1; j < rows - 1; j++)
        for (i = 1; i < cols - 1; i++) {
          k = i + j * cols;
          flowX[k] -= (pressure[k + 1] - pressure[k - 1]) * (0.5 / cell);
          flowY[k] -= (pressure[k + cols] - pressure[k - cols]) * (0.5 / cell);
        }
      walls(flowX, 1); walls(flowY, 2);
    }

    var crowd = new Int32Array(MAX_PARTICLES);
    var crowdHeads = new Int32Array(1);
    var crowdRows = 1;
    function push(n, h) {
      var gc = Math.max(1, Math.ceil(view.width / h) + 2);
      var gr = Math.max(1, Math.ceil(view.height / h) + 2);
      if (crowdHeads.length < gc * gr) crowdHeads = new Int32Array(gc * gr);
      crowdHeads.fill(-1, 0, gc * gr);
      crowdRows = gr;
      for (var i = 0; i < n; i++) {
        var cx = clamp(Math.floor(px[i] / h) + 1, 0, gc - 1);
        var cy = clamp(Math.floor(py[i] / h) + 1, 0, gr - 1);
        var key = cy * gc + cx;
        crowd[i] = crowdHeads[key];
        crowdHeads[key] = i;
      }
      return gc;
    }

    function move(dt, ease) {
      var n = s.count, radius = s.spread;
      var loose = 1 - 0.6 * s.tail;
      var gather = 12 * loose * (0.2 + 0.8 * ease);
      var pull = 30 * loose * (0.2 + 0.8 * ease);
      var band = Math.max(4, radius * 0.16);
      var w = view.width, h = view.height;
      var gap = radius * Math.sqrt(Math.PI / Math.max(n, 1)) * 1.6;
      var repel = 4000;
      var gc = push(n, gap);
      for (var i = 0; i < n; i++) {
        var x = px[i], y = py[i];
        var k = 10 * (1 - 0.6 * s.tail * heft[i]);
        var ax = (sample(flowX, x, y) - vx[i]) * k;
        var ay = (sample(flowY, x, y) - vy[i]) * k;
        var cx = clamp(Math.floor(x / gap) + 1, 0, gc - 1);
        var cy = clamp(Math.floor(y / gap) + 1, 0, crowdRows - 1);
        for (var oy = -1; oy <= 1; oy++) {
          var row = cy + oy;
          if (row < 0 || row >= crowdRows) continue;
          for (var ox = -1; ox <= 1; ox++) {
            var col = cx + ox;
            if (col < 0 || col >= gc) continue;
            for (var jd = crowdHeads[row * gc + col]; jd !== -1; jd = crowd[jd]) {
              if (jd === i) continue;
              var dx = x - px[jd], dy = y - py[jd];
              var d2 = dx * dx + dy * dy;
              if (d2 >= gap * gap || d2 < 1e-6) continue;
              var dd = Math.sqrt(d2), q = 1 - dd / gap;
              ax += (dx / dd) * q * q * repel;
              ay += (dy / dd) * q * q * repel;
            }
          }
        }
        if (ring.active) {
          rectField(x - ring.x, y - ring.y, ring.hx, ring.hy, ring.corner, field);
          var e = field[0] - (5 + band * home[i] * home[i]);
          var hold = e > 0 ? 70 : 140;
          ax -= field[1] * e * hold;
          ay -= field[2] * e * hold;
        } else {
          var ddx = anchor.x - x, ddy = anchor.y - y;
          var d = Math.hypot(ddx, ddy) + 0.001;
          var over = Math.max(0, d - radius);
          ax += (ddx / d) * (d * gather + over * pull);
          ay += (ddy / d) * (d * gather + over * pull);
        }
        if (introClock >= 1) {
          if (x < 8) ax += (8 - x) * 30; else if (x > w - 8) ax -= (x - w + 8) * 30;
          if (y < 8) ay += (8 - y) * 30; else if (y > h - 8) ay -= (y - h + 8) * 30;
        }
        var lift = Math.sin(time * bobRate[i] + bob[i]) * radius * (ring.active ? 0.15 : 0.55);
        var az = (lift - pz[i]) * 36 - vz[i] * 9;
        vx[i] += ax * dt; vy[i] += ay * dt; vz[i] += az * dt;
        px[i] += vx[i] * dt; py[i] += vy[i] * dt; pz[i] += vz[i] * dt;
      }
    }

    function seed() {
      var rand = random(7);
      for (var i = 0; i < MAX_PARTICLES; i++) {
        home[i] = 0.08 + 0.92 * Math.sqrt(rand());
        heft[i] = rand() * rand();
        bob[i] = rand() * Math.PI * 2;
        bobRate[i] = 0.5 + rand() * 1.1;
        grain[i] = 0.55 + rand() * 0.9;
        glint[i] = rand() * 100;
      }
      seeded = true;
    }

    function place(gathered) {
      var rand = random(11);
      var reachOut = Math.hypot(view.width, view.height) * 0.5;
      for (var i = 0; i < MAX_PARTICLES; i++) {
        var a = rand() * Math.PI * 2;
        var r = gathered ? home[i] * s.spread : (0.35 + 0.65 * Math.sqrt(rand())) * reachOut;
        px[i] = anchor.x + Math.cos(a) * r;
        py[i] = anchor.y + Math.sin(a) * r;
        pz[i] = Math.sin(bob[i]) * s.spread * 0.55;
        vx[i] = 0; vy[i] = 0; vz[i] = 0;
      }
    }

    function findTarget() {
      if (!s.targets || !pointer.inside) return null;
      var el = document.elementFromPoint(pointer.x, pointer.y);
      if (!el) return null;
      try { return el.closest(s.targets); } catch (e) { return null; }
    }

    function updateAnchor(dt) {
      var w = view.width, h = view.height;
      if (hovered && hovered.isConnected) {
        var box = hovered.getBoundingClientRect();
        var radius = parseFloat(getComputedStyle(hovered).borderTopLeftRadius) || 0;
        ring.x = box.left + box.width / 2;
        ring.y = box.top + box.height / 2;
        ring.hx = box.width / 2;
        ring.hy = box.height / 2;
        ring.corner = Math.min(radius, ring.hx, ring.hy);
        if (!ring.active) {
          var turning = 0;
          for (var i = 0; i < s.count; i++) turning += (px[i] - ring.x) * vy[i] - (py[i] - ring.y) * vx[i];
          ring.spin = turning < 0 ? -1 : 1;
        }
        ring.active = true;
      } else ring.active = false;

      var goal = 1;
      if (pointer.inside) { anchor.x = pointer.x; anchor.y = pointer.y; }
      else if (s.idle === 'gather') { anchor.x = w * 0.5; anchor.y = h * 0.5; }
      else if (s.idle === 'hide') goal = 0;
      else {
        anchor.x = w * (0.5 + 0.3 * Math.sin(time * 0.21) + 0.06 * Math.sin(time * 0.53 + 1.7));
        anchor.y = h * (0.5 + 0.24 * Math.sin(time * 0.29 + 0.8) + 0.05 * Math.sin(time * 0.71));
      }
      if (dt > 0) {
        var mX = clamp((anchor.x - anchor.lastX) / dt, -4000, 4000);
        var mY = clamp((anchor.y - anchor.lastY) / dt, -4000, 4000);
        var blend = 1 - Math.exp(-dt * 30);
        anchor.moveX += (mX - anchor.moveX) * blend;
        anchor.moveY += (mY - anchor.moveY) * blend;
      }
      anchor.lastX = anchor.x; anchor.lastY = anchor.y;
      presence += (goal - presence) * (1 - Math.exp(-dt / 0.25));
    }

    function draw() {
      var n = s.count;
      var fade = introClock * introClock * (3 - 2 * introClock) * presence;
      var zr = Math.max(s.spread * 0.55, 10);
      var a, b;
      if (sorted !== n) { for (a = 0; a < n; a++) order[a] = a; sorted = n; }
      for (a = 1; a < n; a++) {
        var value = order[a], key = pz[value];
        b = a - 1;
        while (b >= 0 && pz[order[b]] > key) { order[b + 1] = order[b]; b--; }
        order[b + 1] = value;
      }
      var flash = burst.age < 1.2 ? Math.exp(-burst.age / 0.3) : 0;
      var front = ping.age * 520;
      var written = 0;
      for (a = 0; a < n; a++) {
        var i = order[a];
        var near = clamp(pz[i] / zr, -1, 1);
        var scale = 1 + s.depth * 0.6 * near;
        var body = s.size * grain[i] * scale;
        var soft = s.depth * s.size * (s.lightMode ? 0.35 : 1.4) * Math.pow(Math.abs(near), 1.6);
        var flat = Math.hypot(vx[i], vy[i]);
        var dx = flat > 0.001 ? vx[i] / flat : 1;
        var dy = flat > 0.001 ? vy[i] / flat : 0;
        var wave = 0;
        if (ping.age < 1.6) {
          var offset = (Math.hypot(px[i] - ping.x, py[i] - ping.y) - front) / 40;
          wave = Math.exp(-offset * offset) * (1 - ping.age / 1.6);
        }
        var tint = Math.max(clamp((flat - 380) / 900, 0, 1), flash, wave);
        var width = body * (1 + wave * 0.8);
        var length = width + Math.min(flat * s.trail * 0.02, body * 14);
        if (s.shape === 2) length = width * 2.6 + Math.min(flat * s.trail * 0.03, body * 18);
        var twinkle = 0.86 + 0.14 * Math.sin(time * 3.1 + glint[i]);
        var dim = 1 - s.depth * 0.45 * Math.max(0, -near);
        var o = written * 4;
        agentData[o] = px[i]; agentData[o + 1] = py[i];
        agentData[o + 2] = dx; agentData[o + 3] = dy;
        lookData[o] = length; lookData[o + 1] = width;
        lookData[o + 2] = clamp(0.95 * dim * (body / (body + soft)) * twinkle * (1 + wave * 0.4), 0, 1) * fade;
        lookData[o + 3] = tint;
        extraData[written * 2] = soft;
        extraData[written * 2 + 1] = s.shape;
        written++;
      }
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (!s.enabled || !written) return;
      gl.useProgram(shader.program);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, agentBuffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, agentData, 0, written * 4);
      gl.bindBuffer(gl.ARRAY_BUFFER, lookBuffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, lookData, 0, written * 4);
      gl.bindBuffer(gl.ARRAY_BUFFER, extraBuffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, extraData, 0, written * 2);
      gl.uniform2f(u.uView, view.width, view.height);
      gl.uniform3fv(u.uColor, parse(s.color));
      gl.uniform3fv(u.uAccent, parse(s.accentColor));
      gl.uniform1f(u.uRatio, view.ratio);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, written);
      gl.bindVertexArray(null);
    }

    function resize() {
      view.width = Math.max(1, global.innerWidth);
      view.height = Math.max(1, global.innerHeight);
      view.ratio = Math.min(s.dpr || global.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(view.width * view.ratio));
      canvas.height = Math.max(1, Math.round(view.height * view.ratio));
      allocate();
      if (!seeded) {
        seed();
        updateAnchor(0);
        anchor.lastX = anchor.x; anchor.lastY = anchor.y;
        place(introClock >= 1);
      }
      draw();
      wake();
    }

    function frame(now) {
      raf = 0;
      if (document.hidden) return;
      var dt = last ? clamp((now - last) / 1000, 0.001, 1 / 30) : 1 / 60;
      last = now;
      time += dt; burst.age += dt; ping.age += dt;
      if (introClock < 1) introClock = Math.min(1, introClock + dt / INTRO_SECONDS);
      var ease = introClock * introClock * (3 - 2 * introClock);
      hovered = findTarget();
      updateAnchor(dt);
      stir(dt, ease);
      flow(dt);
      move(dt / 2, ease);
      move(dt / 2, ease);
      draw();
      /* Park the loop. Two ways out: the swarm has faded away with the
         pointer gone, or the pointer has simply been still long enough for
         the swarm to settle. Without the second case a resting cursor would
         churn the fluid solve for ever — a few percent of a core and a warm
         laptop for an animation nobody is watching. Any movement wakes it. */
      var settled = now - lastMoveAt > IDLE_PARK_MS;
      var faded = presence < 0.002 && !pointer.inside;
      if ((faded || settled) && burst.age > 2 && ping.age > 2) return;
      raf = requestAnimationFrame(frame);
    }

    function wake() { if (!raf && !document.hidden) raf = requestAnimationFrame(frame); }

    function onMove(e) {
      if (e.pointerType === 'touch') return;
      pointer.x = e.clientX; pointer.y = e.clientY; pointer.inside = true;
      lastMoveAt = performance.now();
      if (opts.onMove) opts.onMove(e, s);
      wake();
    }
    function onDown(e) {
      if (!pointer.inside || s.clickEffect === 'none') return;
      var x = e.clientX, y = e.clientY;
      var reachOut = s.spread * 2.2;
      if (s.clickEffect === 'pulse') { ping.x = x; ping.y = y; ping.age = 0; }
      else burst.age = 0;
      var kick = s.clickEffect === 'pulse' ? 160 : 780;
      for (var i = 0; i < s.count; i++) {
        var dx = px[i] - x, dy = py[i] - y;
        var d = Math.hypot(dx, dy) || 1;
        if (d > reachOut) continue;
        var k = (1 - d / reachOut) * kick * (0.6 + 0.4 * grain[i]);
        vx[i] += (dx / d) * k; vy[i] += (dy / d) * k;
      }
      if (s.clickEffect !== 'pulse') {
        var twist = 520 * (time % 2 < 1 ? 1 : -1);
        var inv = 1 / (s.spread * s.spread);
        for (var j = 1; j < rows - 1; j++)
          for (var ii = 1; ii < cols - 1; ii++) {
            var kk = ii + j * cols;
            var rx = (ii + 0.5) * cell - x, ry = (j + 0.5) * cell - y;
            var d2 = rx * rx + ry * ry;
            var w = (Math.sqrt(d2) / s.spread) * Math.exp(-d2 * inv);
            if (w < 0.003) continue;
            var dd = Math.sqrt(d2) + 0.001;
            flowX[kk] += (-ry / dd) * twist * w;
            flowY[kk] += (rx / dd) * twist * w;
          }
      }
      wake();
    }
    function onLeave() { pointer.inside = false; wake(); }

    var rt;
    global.addEventListener('resize', function () {
      clearTimeout(rt); rt = setTimeout(resize, 120);
    }, { passive: true });
    global.addEventListener('pointermove', onMove, { passive: true });
    global.addEventListener('pointerdown', onDown, { passive: true });
    document.documentElement.addEventListener('pointerleave', onLeave);
    document.addEventListener('visibilitychange', function () { last = 0; wake(); });

    resize();
    return {
      settings: s,
      setColors: function (color, accent) { s.color = color; s.accentColor = accent || color; },
      destroy: function () {
        cancelAnimationFrame(raf);
        canvas.remove();
        gl.getExtension('WEBGL_lose_context') && gl.getExtension('WEBGL_lose_context').loseContext();
      }
    };
  }

  global.SwarmCursor = { mount: mount };
})(window);

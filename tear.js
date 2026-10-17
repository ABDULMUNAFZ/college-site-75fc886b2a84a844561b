/* ==========================================================================
   tear.js — perforated tear-off ticket, vanilla port
   --------------------------------------------------------------------------
   A dependency-free port of the React Bits <TearTicket /> idea. The geometry
   (perforation holes, notches, paper bridges) and the bridge-snapping physics
   follow the original; React, framer-motion and the JSX layer are replaced by
   direct DOM + a single shared requestAnimationFrame loop.

   Why a port instead of the React component: the official Track 3 workflow
   runs no build step — it uploads site/ verbatim — so npm dependencies cannot
   reach Azure. This file ships as-is.

   Driving model:
     • scroll      tickets tear themselves when the rail scrolls into view
     • pointer     drag the stub to tear it by hand (touch + mouse)
     • keyboard    Enter / Space on the stub
   ========================================================================== */
(function (global) {
  'use strict';

  var GRAVITY  = 2400;
  var RETRACT  = 0.17;
  var clamp = function (v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; };
  var rad   = function (d) { return (d * Math.PI) / 180; };
  var wrap  = function (a) { return Math.atan2(Math.sin(a), Math.cos(a)); };
  var f     = function (n) { return n.toFixed(2); };
  var SVG   = 'http://www.w3.org/2000/svg';

  function noise(seed) {
    var s = seed | 0;
    return function () {
      s = (s + 0x6d2b79f5) | 0;
      var t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ----------------------------------------------------------- geometry -- */
  /* Builds the two clip paths (body + stub), the list of paper bridges that
     span the perforation, and the hairline outlines of each cut edge.        */
  function buildGeometry(W, H, S, R, holes, hole, notch, rough, vertical) {
    var main = vertical ? H : W;
    var cross = vertical ? W : H;
    var x = main - S;
    var hr = hole / 2;
    var n = Math.max(1, Math.round(holes));
    var span = cross - 2 * notch;
    var bridge = Math.max(2, (span - n * hole) / (n + 1));
    var random = noise(n * 7919 + Math.round(cross));

    var at = function (u, v) { return vertical ? { x: v, y: u } : { x: u, y: v }; };
    var pt = function (u, v) { return vertical ? f(v) + ',' + f(u) : f(u) + ',' + f(v); };
    var arc = function (r, sweep, u, v) {
      return 'A' + f(r) + ',' + f(r) + ' 0 0 ' + (vertical ? 1 - sweep : sweep) + ' ' + pt(u, v);
    };

    var bridges = [];
    for (var i = 0; i <= n; i++) {
      var y0 = notch + i * (bridge + hole);
      var y1 = y0 + bridge;
      var steps = Math.max(2, Math.round(bridge / 2.2));
      var pts = [];
      for (var k = 1; k < steps; k++) {
        pts.push([x + (random() - 0.5) * 2 * rough, y0 + (bridge * k) / steps]);
      }
      var mid = (y0 + y1) / 2;
      var p = at(x, mid);
      bridges.push({ y0: y0, y1: y1, mid: mid, pts: pts, x: p.x, y: p.y });
    }

    var body = 'M' + pt(R, 0) + 'L' + pt(x - notch, 0) + arc(notch, 0, x, notch);
    bridges.forEach(function (b, i) {
      b.pts.forEach(function (q) { body += 'L' + pt(q[0], q[1]); });
      body += 'L' + pt(x, b.y1);
      if (i < n) body += arc(hr, 0, x, b.y1 + hole);
    });
    body += arc(notch, 0, x - notch, cross) + 'L' + pt(R, cross) +
            arc(R, 1, 0, cross - R) + 'L' + pt(0, R) + arc(R, 1, R, 0) + 'Z';

    var stub = 'M' + pt(x + notch, 0) + 'L' + pt(main - R, 0) + arc(R, 1, main, R) +
               'L' + pt(main, cross - R) + arc(R, 1, main - R, cross) +
               'L' + pt(x + notch, cross) + arc(notch, 0, x, cross - notch);
    for (var j = n; j >= 0; j--) {
      var b2 = bridges[j];
      for (var m = b2.pts.length - 1; m >= 0; m--) stub += 'L' + pt(b2.pts[m][0], b2.pts[m][1]);
      stub += 'L' + pt(x, b2.y0);
      if (j > 0) stub += arc(hr, 0, x, b2.y0 - hole);
    }
    stub += arc(notch, 0, x + notch, 0) + 'Z';

    var e0 = at(x, notch), e1 = at(x, cross - notch);
    return {
      vertical: vertical, cross: cross, body: body, stub: stub, bridges: bridges,
      ends: [{ x: e0.x, y: e0.y, v: notch }, { x: e1.x, y: e1.y, v: cross - notch }],
      bodyOutline: 'M' + pt(x, cross - notch) + arc(notch, 0, x - notch, cross) + 'L' + pt(R, cross) +
                   arc(R, 1, 0, cross - R) + 'L' + pt(0, R) + arc(R, 1, R, 0) +
                   'L' + pt(x - notch, 0) + arc(notch, 0, x, notch),
      stubOutline: 'M' + pt(x, notch) + arc(notch, 0, x + notch, 0) + 'L' + pt(main - R, 0) +
                   arc(R, 1, main, R) + 'L' + pt(main, cross - R) + arc(R, 1, main - R, cross) +
                   'L' + pt(x + notch, cross) + arc(notch, 0, x, cross - notch)
    };
  }

  /* ---------------------------------------------- one shared rAF driver -- */
  /* Every ticket on the page is stepped from a single loop. The loop parks
     itself the moment nothing is moving, so an idle page costs zero frames. */
  var live = [];
  var raf = 0;
  var last = 0;

  function frame(now) {
    var dt = clamp((now - last) / 1000, 0.001, 0.034);
    last = now;
    var busy = false;
    for (var i = live.length - 1; i >= 0; i--) {
      if (live[i].step(dt, now)) busy = true;
      else live.splice(i, 1);
    }
    raf = busy || live.length ? requestAnimationFrame(frame) : 0;
  }
  function join(t) {
    if (live.indexOf(t) === -1) live.push(t);
    if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); }
  }

  /* ================================================================ class = */
  function TearTicket(host, o) {
    o = o || {};
    this.o = {
      width: o.width || 420, height: o.height || 190, stubSize: o.stubSize || 118,
      radius: o.radius || 18, holes: o.holes || 13, holeSize: o.holeSize || 6,
      notch: o.notch || 3, roughness: o.roughness || 0, tearAngle: o.tearAngle || 30,
      stretch: o.stretch || 30, resistance: o.resistance == null ? 0.45 : o.resistance,
      rotate: o.rotate || 0, tilt: o.tilt !== false, tiltMax: o.tiltMax || 8,
      tiltReach: o.tiltReach || 240, perspective: o.perspective || 1000,
      background: o.background || '#141414', stubBackground: o.stubBackground || '',
      color: o.color || '#F7F7F7', border: o.border !== false,
      borderColor: o.borderColor || '', borderWidth: o.borderWidth || 1,
      recenter: o.recenter !== false, ariaLabel: o.ariaLabel || 'Tear off the stub',
      onTear: o.onTear || null
    };
    this.reduce = global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.geo = buildGeometry(this.o.width, this.o.height, this.o.stubSize, this.o.radius,
      this.o.holes, this.o.holeSize, this.o.notch, this.o.roughness, false);
    this.used = false;
    this.fit = 1;
    this.tiltX = 0; this.tiltY = 0; this.tTx = 0; this.tTy = 0;
    this.s = {
      phase: 'idle', id: null, sign: 1, hinge: { x: 0, y: 0 }, hingeV: 0,
      grab: { x: 0, y: 0 }, start: { x: 0, y: 0 }, point: { x: 0, y: 0 },
      a0: 0, theta: 0, thetaV: 0, sx: 0, sy: 0, vx: 0, vy: 0, spin: 0,
      pvx: 0, pvy: 0, pt: 0, fade: 1, age: 0, bx: 0, bv: 0, auto: 0, autoT0: 0, scrubP: undefined,
      snapped: [], snapAt: [], span: []
    };
    this._build(host);
    this._bind();
  }

  TearTicket.prototype._build = function (host) {
    var o = this.o, g = this.geo, self = this;
    host.className += ' tt';
    host.style.cssText +=
      ';--tt-w:' + o.width + 'px;--tt-h:' + o.height + 'px;--tt-stub:' + o.stubSize +
      'px;--tt-bg:' + o.background + ';--tt-stub-bg:' + (o.stubBackground || o.background) +
      ';--tt-ink:' + o.color + ';--tt-edge:' + (o.borderColor || 'rgba(255,255,255,.16)') +
      ';--tt-edge-w:' + o.borderWidth + ';--tt-body-w:' + (o.width - o.stubSize) + 'px' +
      ';height:' + o.height + 'px';
    this.host = host;

    var stage = document.createElement('div'); stage.className = 'tt__stage';
    var plane = document.createElement('div'); plane.className = 'tt__plane';

    var body = document.createElement('div'); body.className = 'tt__piece';
    if (o.border) body.appendChild(this._edge(g.bodyOutline));
    var paper = document.createElement('div');
    paper.className = 'tt__paper';
    paper.style.clipPath = "path('" + g.body + "')";
    paper.style.webkitClipPath = "path('" + g.body + "')";
    var content = document.createElement('div'); content.className = 'tt__content';
    paper.appendChild(content); body.appendChild(paper);

    var fib = document.createElementNS(SVG, 'svg');
    fib.setAttribute('class', 'tt__fibres'); fib.setAttribute('aria-hidden', 'true');
    this.fibres = [];
    for (var i = 0; i < g.bridges.length; i++) {
      var a = document.createElementNS(SVG, 'path');
      var b = document.createElementNS(SVG, 'path');
      fib.appendChild(a); fib.appendChild(b);
      this.fibres.push(a, b);
    }

    var stubEl = document.createElement('div');
    stubEl.className = 'tt__piece tt__piece--stub';
    stubEl.setAttribute('role', 'button');
    stubEl.setAttribute('tabindex', '0');
    stubEl.setAttribute('aria-label', o.ariaLabel);
    if (o.border) stubEl.appendChild(this._edge(g.stubOutline));
    var sp = document.createElement('div');
    sp.className = 'tt__paper tt__paper--stub';
    sp.style.clipPath = "path('" + g.stub + "')";
    sp.style.webkitClipPath = "path('" + g.stub + "')";
    var sIn = document.createElement('div'); sIn.className = 'tt__stub';
    sp.appendChild(sIn); stubEl.appendChild(sp);

    plane.appendChild(body); plane.appendChild(fib); plane.appendChild(stubEl);
    stage.appendChild(plane); host.appendChild(stage);

    this.stage = stage; this.plane = plane; this.bodyEl = body;
    this.stubEl = stubEl; this.content = content; this.stubIn = sIn;
    host.__tt = this;            /* handle for inspection / debugging */

    this._ro = new ResizeObserver(function () { self._fit(); });
    this._ro.observe(host);
    this._fit();
  };

  TearTicket.prototype._edge = function (d) {
    var svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('class', 'tt__edge');
    svg.setAttribute('viewBox', '0 0 ' + this.o.width + ' ' + this.o.height);
    svg.setAttribute('aria-hidden', 'true');
    var p = document.createElementNS(SVG, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
    return svg;
  };

  TearTicket.prototype._fit = function () {
    var w = this.host.clientWidth;
    if (!w) return;
    var k = Math.min(1, w / this.o.width) || 1;
    if (Math.abs(k - this.fit) < 0.002) return;
    this.fit = k;
    this.host.style.height = this.o.height * k + 'px';
    this._placeStage();
  };

  TearTicket.prototype._placeStage = function () {
    var shift = this.used && this.o.recenter ? (this.o.stubSize * this.fit) / 2 : 0;
    this.stage.style.transform = 'translateX(' + shift.toFixed(2) + 'px) scale(' + this.fit + ')';
  };

  /* content setters -------------------------------------------------------- */
  TearTicket.prototype.setBody = function (node) { this.content.replaceChildren(node); };
  TearTicket.prototype.setStub = function (node) { this.stubIn.replaceChildren(node); };

  /* ------------------------------------------------------------- painting - */
  TearTicket.prototype.paint = function (now) {
    var s = this.s, g = this.geo, o = this.o;
    this.stubEl.style.transform =
      'translate(' + s.sx.toFixed(2) + 'px,' + s.sy.toFixed(2) + 'px) rotate(' +
      ((s.theta * s.sign * 180) / Math.PI).toFixed(3) + 'deg)';
    this.stubEl.style.opacity = s.fade.toFixed(3);
    this.bodyEl.style.transform = 'translateX(' + s.bx.toFixed(2) + 'px)';

    var cos = Math.cos(s.theta * s.sign), sin = Math.sin(s.theta * s.sign);
    var busy = false, live = s.phase !== 'idle' && !this.reduce;

    for (var i = 0; i < g.bridges.length; i++) {
      var b = g.bridges[i];
      var near = this.fibres[i * 2], far = this.fibres[i * 2 + 1];
      if (!near || !far) continue;
      var dx = b.x - s.hinge.x, dy = b.y - s.hinge.y;
      var tx = s.hinge.x + dx * cos - dy * sin + s.sx;
      var ty = s.hinge.y + dx * sin + dy * cos + s.sy;
      var ox = b.x + s.bx, oy = b.y;
      var gx = tx - ox, gy = ty - oy;
      var gap = Math.hypot(gx, gy);

      if (!s.snapped[i]) {
        if (!live || gap < 0.35) { near.style.opacity = '0'; far.style.opacity = '0'; continue; }
        var kk = clamp(gap / o.stretch, 0, 1);
        var sag = gap * 0.18;
        var w = (1.7 - 1.15 * kk).toFixed(2);
        var mx = gx / 2, my = sag + gy / 2;
        near.setAttribute('d', 'M' + f(ox) + ',' + f(oy - 1.6) + 'Q' + f(ox + mx) + ',' + f(oy - 1.6 + my) + ' ' + f(tx) + ',' + f(ty - 1.6));
        far.setAttribute('d', 'M' + f(ox) + ',' + f(oy + 1.6) + 'Q' + f(ox + gx - mx) + ',' + f(oy + 1.6 + gy - my) + ' ' + f(tx) + ',' + f(ty + 1.6));
        near.style.strokeWidth = w; far.style.strokeWidth = w;
        near.style.opacity = '1'; far.style.opacity = '1';
        s.span[i] = gap;
        continue;
      }
      var t = (now - s.snapAt[i]) / 1000 / RETRACT;
      if (!live || t >= 1 || !s.snapAt[i]) { near.style.opacity = '0'; far.style.opacity = '0'; continue; }
      busy = true;
      var leftv = (1 - t) * (1 - t);
      var len = (s.span[i] || o.stretch) * 0.5 * leftv;
      var ux = gap > 0.01 ? gx / gap : 1, uy = gap > 0.01 ? gy / gap : 0;
      near.setAttribute('d', 'M' + f(ox) + ',' + f(oy) + 'L' + f(ox + ux * len) + ',' + f(oy + uy * len));
      far.setAttribute('d', 'M' + f(tx) + ',' + f(ty) + 'L' + f(tx - ux * len) + ',' + f(ty - uy * len));
      near.style.strokeWidth = '0.9'; far.style.strokeWidth = '0.9';
      near.style.opacity = leftv.toFixed(2); far.style.opacity = leftv.toFixed(2);
    }
    return busy;
  };

  TearTicket.prototype._finish = function () {
    this.stubEl.style.visibility = 'hidden';
    this.stubEl.setAttribute('aria-hidden', 'true');
    this.stubEl.setAttribute('tabindex', '-1');
    this.used = true;
    this.host.setAttribute('data-used', '');
    this._placeStage();
    if (this.o.onTear) this.o.onTear(this);
  };

  /* --------------------------------------------------------------- step --- */
  TearTicket.prototype.step = function (dt, now) {
    var s = this.s, o = this.o, g = this.geo;
    var limit = rad(o.tearAngle);

    /* Failsafe. If the tab was backgrounded mid-tear, rAF is throttled to a
       few frames per second and the flight would crawl. Past a generous
       budget, finish the tear outright rather than leave a stub hanging. */
    if (s.autoT0 && (s.phase === 'auto' || s.phase === 'drop') && now - s.autoT0 > 4000) {
      s.phase = 'idle';
      this._finish();
      return false;
    }

    /* While the scroll owns the tear, this loop must not also paint it.
       setProgress/paintScrub write the geometry; here we only ease the tilt,
       then park. Without this the ticket would sit in the shared loop for
       ever (phase is never 'idle') repainting over the scrubbed state. */
    if (s.phase === 'scrub') {
      var tks = 1 - Math.exp(-dt / 0.09);
      this.tiltX += (this.tTx - this.tiltX) * tks;
      this.tiltY += (this.tTy - this.tiltY) * tks;
      this.plane.style.transform =
        'perspective(' + o.perspective + 'px) rotate(' + o.rotate + 'deg) rotateX(' +
        this.tiltX.toFixed(2) + 'deg) rotateY(' + this.tiltY.toFixed(2) + 'deg)';
      return Math.abs(this.tTx - this.tiltX) > 0.02 || Math.abs(this.tTy - this.tiltY) > 0.02;
    }

    if (s.phase === 'auto') {
      /* Scripted tear: the pull ramps in, bridges give way from the far end
         inward, exactly as the pointer-driven version does.
         Driven by wall clock rather than accumulated dt, so the tear always
         takes the same real time — a throttled or backgrounded tab resumes
         at the right point instead of crawling through it in slow motion. */
      if (!s.autoT0) s.autoT0 = now;
      s.auto = (now - s.autoT0) / 1000;
      var p = clamp(s.auto / 0.52, 0, 1);
      var e = 1 - Math.pow(1 - p, 3);
      s.theta = e * limit * 1.18;
      s.sx = e * 13; s.sy = e * 3;
      var slackA = Math.hypot(s.sx, s.sy), leftA = 0;
      for (var a = 0; a < g.bridges.length; a++) {
        if (s.snapped[a]) continue;
        var dA = Math.abs(g.bridges[a].mid - s.hingeV);
        if (2 * dA * Math.sin(s.theta / 2) + slackA > o.stretch || s.theta >= limit) {
          s.snapped[a] = true; s.snapAt[a] = now; s.bv -= 560 / g.bridges.length;
        } else leftA++;
      }
      if (leftA === 0) {
        s.phase = 'drop'; s.age = 0;
        s.vx = 300 + Math.random() * 110;
        s.vy = -210 - Math.random() * 70;
        s.spin = 2.1 * s.sign + Math.random() * 0.8;
        s.bv -= 150;
      }
    } else if (s.phase === 'held') {
      var count = g.bridges.length, intact = 0;
      for (var c = 0; c < count; c++) if (!s.snapped[c]) intact++;
      var follow = 0.92 * (1 - clamp(o.resistance, 0, 0.95) * (count ? intact / count : 0));
      var ang = Math.atan2(s.point.y - s.hinge.y, s.point.x - s.hinge.x);
      var want = clamp(wrap(ang - s.a0) * s.sign * follow, 0, limit + 0.1);
      s.theta += (want - s.theta) * (1 - Math.exp(-dt / 0.035));
      var away = clamp((s.point.x - s.start.x) * 0.05, -2, 4);
      var side = clamp((s.point.y - s.start.y) * 0.05, -3, 3);
      s.sx += (away - s.sx) * (1 - Math.exp(-dt / 0.05));
      s.sy += (side - s.sy) * (1 - Math.exp(-dt / 0.05));
      var slack = Math.hypot(s.sx, s.sy), left = 0;
      for (var i2 = 0; i2 < g.bridges.length; i2++) {
        if (s.snapped[i2]) continue;
        var d2 = Math.abs(g.bridges[i2].mid - s.hingeV);
        if (2 * d2 * Math.sin(s.theta / 2) + slack > o.stretch || s.theta >= limit) {
          s.snapped[i2] = true; s.snapAt[i2] = now; s.bv -= 560 / g.bridges.length;
        } else left++;
      }
      if (left === 0) { s.phase = 'free'; s.bv -= 150; }
    } else if (s.phase === 'free') {
      var cos2 = Math.cos(s.theta * s.sign), sin2 = Math.sin(s.theta * s.sign);
      var gx2 = s.grab.x - s.hinge.x, gy2 = s.grab.y - s.hinge.y;
      var wx = s.point.x - s.hinge.x - (gx2 * cos2 - gy2 * sin2);
      var wy = s.point.y - s.hinge.y - (gx2 * sin2 + gy2 * cos2);
      s.sx += (wx - s.sx) * (1 - Math.exp(-dt / 0.045));
      s.sy += (wy - s.sy) * (1 - Math.exp(-dt / 0.045));
      var hang = limit * 0.55 + clamp(s.pvx * 0.0009 * s.sign, -0.3, 0.3);
      s.theta += (hang - s.theta) * (1 - Math.exp(-dt / 0.12));
    } else if (s.phase === 'drop') {
      s.age += dt;
      s.vy += GRAVITY * dt;
      s.sx += s.vx * dt; s.sy += s.vy * dt;
      s.theta += s.spin * dt;
      if (s.age > 0.16) s.fade = clamp(1 - (s.age - 0.16) / 0.42, 0, 1);
      if (s.fade <= 0) { s.phase = 'idle'; this._finish(); }
    } else if (s.phase === 'return') {
      s.thetaV += (-300 * s.theta - 24 * s.thetaV) * dt;
      s.theta += s.thetaV * dt;
      s.sx += (0 - s.sx) * (1 - Math.exp(-dt / 0.07));
      s.sy += (0 - s.sy) * (1 - Math.exp(-dt / 0.07));
      if (Math.abs(s.theta) < 0.0008 && Math.abs(s.thetaV) < 0.01 && Math.hypot(s.sx, s.sy) < 0.05) {
        s.theta = 0; s.thetaV = 0; s.sx = 0; s.sy = 0; s.phase = 'idle';
      }
    }

    s.bv += (-520 * s.bx - 30 * s.bv) * dt;
    s.bx += s.bv * dt;

    /* tilt easing, folded into the same loop */
    var tk = 1 - Math.exp(-dt / 0.09);
    this.tiltX += (this.tTx - this.tiltX) * tk;
    this.tiltY += (this.tTy - this.tiltY) * tk;
    var tilting = Math.abs(this.tTx - this.tiltX) > 0.02 || Math.abs(this.tTy - this.tiltY) > 0.02;
    this.plane.style.transform =
      'perspective(' + this.o.perspective + 'px) rotate(' + this.o.rotate + 'deg) rotateX(' +
      this.tiltX.toFixed(2) + 'deg) rotateY(' + this.tiltY.toFixed(2) + 'deg)';

    var busy = this.paint(now);
    var moving = Math.abs(s.bx) > 0.02 || Math.abs(s.bv) > 0.5;
    if (s.phase === 'idle' && !moving && !busy && !tilting) {
      s.bx = 0; s.bv = 0; this.paint(now);
      return false;
    }
    return true;
  };

  /* ------------------------------------------------- scroll-scrubbed tear -
     setProgress(p) maps scroll position directly onto the tear, 0 = whole,
     1 = stub gone. It is a PURE FUNCTION of p: which bridges have given way
     is recomputed from the pull angle every call rather than remembered.

     That is what makes it reversible — scroll back up and the paper bridges
     re-form, the stub swings closed and the ticket is whole again, with no
     undo history to keep in sync. */
  var smooth = function (t) { return t * t * (3 - 2 * t); };

  TearTicket.prototype.setProgress = function (p) {
    var s = this.s, o = this.o, g = this.geo;
    if (s.id !== null || s.phase === 'held' || s.phase === 'free' || s.phase === 'drop') return;

    p = clamp(p, 0, 1);
    if (s.scrubP !== undefined && Math.abs(p - s.scrubP) < 0.0008) return;
    s.scrubP = p;
    s.phase = 'scrub';

    if (!s.hinge || (s.hinge.x === 0 && s.hinge.y === 0)) this._hingeTop();

    var limit = rad(o.tearAngle);
    var pull = smooth(clamp(p / 0.80, 0, 1));          // bridges give way
    var fly  = smooth(clamp((p - 0.74) / 0.26, 0, 1)); // stub leaves

    s.theta = pull * limit * 1.12 + fly * 0.55;
    s.sx = pull * 12 + fly * 300;
    s.sy = pull * 3 + fly * 210;
    s.fade = 1 - fly;
    s.bx = -pull * 4 * (1 - fly);

    /* recompute which bridges are broken, from the angle alone */
    var slack = Math.hypot(pull * 12, pull * 3);
    var snappedNow = 0;
    for (var i = 0; i < g.bridges.length; i++) {
      var d = Math.abs(g.bridges[i].mid - s.hingeV);
      var broken = (2 * d * Math.sin(s.theta / 2) + slack > o.stretch) || s.theta >= limit;
      s.snapped[i] = broken;
      if (broken) snappedNow++;
    }

    var gone = p >= 0.995;
    if (gone !== this.used) {
      this.used = gone;
      if (gone) this.host.setAttribute('data-used', '');
      else this.host.removeAttribute('data-used');
      this.stubEl.setAttribute('tabindex', gone ? '-1' : '0');
      if (gone) this.stubEl.setAttribute('aria-hidden', 'true');
      else this.stubEl.removeAttribute('aria-hidden');
      this._placeStage();
    }
    this.stubEl.style.visibility = s.fade <= 0.001 ? 'hidden' : '';

    this.paintScrub();
  };

  /* Paint for the scrub path: no retract timers, everything derived from
     the current angle so a reverse scroll simply reverses the picture. */
  TearTicket.prototype.paintScrub = function () {
    var s = this.s, g = this.geo, o = this.o;
    this.stubEl.style.transform =
      'translate(' + s.sx.toFixed(2) + 'px,' + s.sy.toFixed(2) + 'px) rotate(' +
      ((s.theta * s.sign * 180) / Math.PI).toFixed(3) + 'deg)';
    this.stubEl.style.opacity = s.fade.toFixed(3);
    this.bodyEl.style.transform = 'translateX(' + s.bx.toFixed(2) + 'px)';

    var cos = Math.cos(s.theta * s.sign), sin = Math.sin(s.theta * s.sign);
    for (var i = 0; i < g.bridges.length; i++) {
      var near = this.fibres[i * 2], far = this.fibres[i * 2 + 1];
      if (!near || !far) continue;
      if (s.snapped[i] || s.fade < 0.02) { near.style.opacity = '0'; far.style.opacity = '0'; continue; }

      var b = g.bridges[i];
      var dx = b.x - s.hinge.x, dy = b.y - s.hinge.y;
      var tx = s.hinge.x + dx * cos - dy * sin + s.sx;
      var ty = s.hinge.y + dx * sin + dy * cos + s.sy;
      var ox = b.x + s.bx, oy = b.y;
      var gx = tx - ox, gy = ty - oy;
      var gap = Math.hypot(gx, gy);
      if (gap < 0.35) { near.style.opacity = '0'; far.style.opacity = '0'; continue; }

      var k = clamp(gap / o.stretch, 0, 1);
      var sag = gap * 0.18;
      var w = (1.7 - 1.15 * k).toFixed(2);
      var mx = gx / 2, my = sag + gy / 2;
      near.setAttribute('d', 'M' + f(ox) + ',' + f(oy - 1.6) + 'Q' + f(ox + mx) + ',' + f(oy - 1.6 + my) + ' ' + f(tx) + ',' + f(ty - 1.6));
      far.setAttribute('d', 'M' + f(ox) + ',' + f(oy + 1.6) + 'Q' + f(ox + gx - mx) + ',' + f(oy + 1.6 + gy - my) + ' ' + f(tx) + ',' + f(ty + 1.6));
      near.style.strokeWidth = w; far.style.strokeWidth = w;
      near.style.opacity = '1'; far.style.opacity = '1';
    }
  };

  /* ------------------------------------------------------------- actions -- */
  TearTicket.prototype._hingeTop = function () {
    var s = this.s, end = this.geo.ends[1];
    s.sign = 1;
    s.hinge = { x: end.x, y: end.y };
    s.hingeV = end.v;
    this.stubEl.style.transformOrigin = s.hinge.x + 'px ' + s.hinge.y + 'px';
  };

  /* Scroll-driven tear. Returns false if it is already gone. */
  TearTicket.prototype.tear = function (delay) {
    var self = this, s = this.s;
    if (this.used || s.phase !== 'idle') return false;
    if (this.reduce) {                       // honour reduced motion: no flight
      this._hingeTop();
      window.setTimeout(function () {
        if (!self.used) { self.host.setAttribute('data-instant', ''); self._finish(); }
      }, delay || 0);
      return true;
    }
    window.setTimeout(function () {
      if (self.used || self.s.phase !== 'idle') return;
      self._hingeTop();
      self.s.auto = 0;
      self.s.autoT0 = 0;
      self.s.phase = 'auto';
      join(self);
    }, delay || 0);
    return true;
  };

  TearTicket.prototype.reset = function () {
    var s = this.s;
    s.phase = 'idle'; s.id = null; s.theta = 0; s.thetaV = 0;
    s.sx = 0; s.sy = 0; s.fade = 1; s.age = 0; s.bx = 0; s.bv = 0; s.auto = 0; s.autoT0 = 0;
    s.snapped = []; s.snapAt = []; s.span = [];
    this.used = false;
    this.host.removeAttribute('data-used');
    this.host.removeAttribute('data-instant');
    this.stubEl.style.visibility = '';
    this.stubEl.removeAttribute('aria-hidden');
    this.stubEl.setAttribute('tabindex', '0');
    this._placeStage();
    this.paint(performance.now());
  };

  /* ------------------------------------------------------------- pointer -- */
  TearTicket.prototype._local = function (e) {
    var r = this.stage.getBoundingClientRect();
    var k = r.width / this.o.width || 1;
    return { x: (e.clientX - r.left) / k, y: (e.clientY - r.top) / k };
  };

  TearTicket.prototype._bind = function () {
    var self = this, s = this.s, el = this.stubEl;

    el.addEventListener('pointerdown', function (e) {
      if (self.used || e.button !== 0 || s.id !== null || s.phase === 'drop' || s.phase === 'auto') return;
      try { el.setPointerCapture(e.pointerId); } catch (x) {}
      var p = self._local(e);
      s.id = e.pointerId; s.start = p; s.point = p;
      s.pt = performance.now(); s.pvx = 0; s.pvy = 0;
      if (s.theta < 0.01) {
        var far = p.y < self.geo.cross / 2;
        var end = self.geo.ends[far ? 1 : 0];
        s.sign = far ? 1 : -1;
        s.hinge = { x: end.x, y: end.y }; s.hingeV = end.v;
        el.style.transformOrigin = s.hinge.x + 'px ' + s.hinge.y + 'px';
      }
      var cos = Math.cos(-s.theta * s.sign), sin = Math.sin(-s.theta * s.sign);
      var ux = p.x - s.sx - s.hinge.x, uy = p.y - s.sy - s.hinge.y;
      s.grab = { x: s.hinge.x + ux * cos - uy * sin, y: s.hinge.y + ux * sin + uy * cos };
      s.a0 = Math.atan2(s.grab.y - s.hinge.y, s.grab.x - s.hinge.x) - (s.theta * s.sign) / 0.92;
      s.phase = 'held'; s.thetaV = 0;
      self.tTx = 0; self.tTy = 0;
      self.host.setAttribute('data-grab', '');
      join(self);
    });

    el.addEventListener('pointermove', function (e) {
      if (s.id !== e.pointerId) return;
      var p = self._local(e), now = performance.now();
      var dt = Math.max(0.004, (now - s.pt) / 1000);
      s.pvx += ((p.x - s.point.x) / dt - s.pvx) * 0.35;
      s.pvy += ((p.y - s.point.y) / dt - s.pvy) * 0.35;
      s.pt = now; s.point = p;
      if (self.reduce && Math.hypot(p.x - s.start.x, p.y - s.start.y) > 28) {
        s.id = null; self.host.removeAttribute('data-grab');
        self.host.setAttribute('data-instant', ''); self._finish();
      }
    });

    var up = function (e) {
      if (s.id !== e.pointerId) return;
      s.id = null;
      try { if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId); } catch (x) {}
      self.host.removeAttribute('data-grab');
      s.scrubP = undefined;            /* let the scroll scrub take over again */
      if (s.phase === 'free') {
        var still = performance.now() - s.pt > 80;
        s.vx = still ? 0 : clamp(s.pvx, -1600, 1600);
        s.vy = still ? 0 : clamp(s.pvy, -1600, 1200);
        s.spin = clamp(s.vx * 0.004, -6, 6) + 1.2 * s.sign;
        s.age = 0; s.phase = 'drop';
      } else if (s.phase === 'held') s.phase = 'return';
      join(self);
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('lostpointercapture', up);
    el.addEventListener('dragstart', function (e) { e.preventDefault(); });
    el.addEventListener('keydown', function (e) {
      if (self.used || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      if (!e.repeat) self.tear(0);
    });
  };

  /* Tilt is steered from outside (one shared pointermove for the whole rail). */
  TearTicket.prototype.aim = function (nx, ny) {
    if (!this.o.tilt || this.reduce || this.s.id !== null) return;
    this.tTy = nx * this.o.tiltMax;
    this.tTx = -ny * this.o.tiltMax;
    join(this);
  };

  TearTicket.prototype.destroy = function () {
    if (this._ro) this._ro.disconnect();
    var i = live.indexOf(this);
    if (i !== -1) live.splice(i, 1);
  };

  global.TearTicket = TearTicket;
})(window);

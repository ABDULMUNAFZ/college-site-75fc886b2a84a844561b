/* ==========================================================================
   scroll.js — the motion layer
   --------------------------------------------------------------------------
   Everything on this page is driven by scroll position, never by a click.

   Three pieces:
     1. Smooth scroll   wheel input is lerped into real window scroll, so
                        position:sticky, anchors and the scrollbar all keep
                        working. Disabled for touch and reduced motion.
     2. Reveals         IntersectionObserver adds .in — no per-frame cost.
     3. Scrubbers       registered callbacks get a 0..1 progress for their
                        element, computed in ONE rAF pass with reads and
                        writes kept apart so the layout is never thrashed.
   ========================================================================== */
(function (global) {
  'use strict';

  var reduce = global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var coarse = global.matchMedia && global.matchMedia('(pointer: coarse)').matches;
  var clamp = function (v, a, b) { return v < a ? a : v > b ? b : v; };

  var S = {
    y: global.scrollY || 0,
    items: [],      // scrubbers: { el, cb, mode }
    raf: 0,
    dirty: true,
    idle: 0,
    vh: global.innerHeight
  };

  /* ------------------------------------------------------ scrolling model -
     Deliberately NOT hijacking the wheel.

     An inertial scroll-jacker (Lenis-style) looks nice in a showreel, but it
     fights every other way of moving the page — anchor jumps, keyboard paging,
     dragging the scrollbar, find-in-page, and a screen reader moving focus —
     and it has to re-implement each of them to stay correct. The animation
     here is driven BY the scroll position, so it reads identically on native
     scrolling, while keeping all of that behaviour correct for free.

     The rAF loop below only runs while the page is actually moving. */
  var maxY = function () {
    return Math.max(0, document.documentElement.scrollHeight - global.innerHeight);
  };

  /* ---------------------------------------------------------- scrubbers -- */
  /* progress 0 → 1 as the element travels through the viewport.
     mode 'through' : 0 when the top enters the bottom, 1 when the bottom leaves the top
     mode 'pin'     : 0 at the moment it sticks, 1 when its track runs out      */
  function measure() {
    for (var i = 0; i < S.items.length; i++) {
      var it = S.items[i];
      var r = it.el.getBoundingClientRect();
      it.top = r.top + global.scrollY;
      it.h = r.height;
    }
    S.vh = global.innerHeight;
  }

  function tick() {
    S.raf = 0;
    var prev = S.y;
    S.y = global.scrollY;
    var moving = Math.abs(S.y - prev) > 0.5;

    /* ---- read phase is already done (cached in measure) ---- */
    var y = S.y, vh = S.vh;
    for (var i = 0; i < S.items.length; i++) {
      var it = S.items[i];
      var p;
      if (it.mode === 'pin') {
        p = (y - it.top) / Math.max(1, it.h - vh);
      } else {
        p = (y + vh - it.top) / Math.max(1, it.h + vh);
      }
      p = clamp(p, 0, 1);
      if (it.last === undefined || Math.abs(p - it.last) > 0.0004) {
        it.last = p;
        it.cb(p);                      /* ---- write phase ---- */
      }
    }

    /* Keep spinning for a few frames after the last movement so momentum
       scrolling settles exactly, then park the loop. */
    if (moving) S.idle = 0; else S.idle++;
    S.dirty = false;
    if (moving || S.idle < 6) kick();
  }

  function kick() { if (!S.raf) S.raf = requestAnimationFrame(tick); }

  /* ------------------------------------------------------------- public -- */
  var API = {
    reduce: reduce,
    coarse: coarse,

    /* register a scroll-scrubbed element */
    scrub: function (el, cb, mode) {
      if (!el) return;
      S.items.push({ el: el, cb: cb, mode: mode || 'through' });
      measure();
      S.dirty = true;
      kick();
    },

    /* reveal-on-enter, one observer for the whole page */
    reveals: function (sel) {
      var nodes = document.querySelectorAll(sel || '[data-reveal]');
      if (!nodes.length) return;
      for (var i = 0; i < nodes.length; i++) {
        var d = nodes[i].getAttribute('data-reveal-delay');
        if (d) nodes[i].style.setProperty('--rd', d);
      }
      if (reduce || !('IntersectionObserver' in global)) {
        for (var j = 0; j < nodes.length; j++) nodes[j].classList.add('in');
        return;
      }
      var io = new IntersectionObserver(function (es) {
        for (var k = 0; k < es.length; k++) {
          if (es[k].isIntersecting) { es[k].target.classList.add('in'); io.unobserve(es[k].target); }
        }
      }, { rootMargin: '0px 0px -10% 0px', threshold: 0.1 });
      for (var n = 0; n < nodes.length; n++) io.observe(nodes[n]);

      /* safety net — never leave content invisible */
      setTimeout(function () {
        for (var q = 0; q < nodes.length; q++) nodes[q].classList.add('in');
      }, 3000);
    },

    /* fire once when an element crosses into view */
    once: function (el, cb, margin) {
      if (!el) return;
      if (reduce || !('IntersectionObserver' in global)) { cb(); return; }
      var io = new IntersectionObserver(function (es) {
        if (es[0].isIntersecting) { io.disconnect(); cb(); }
      }, { rootMargin: margin || '0px 0px -25% 0px', threshold: 0.01 });
      io.observe(el);
    },

    to: function (el) {
      if (!el) return;
      var top = clamp(el.getBoundingClientRect().top + global.scrollY - 70, 0, maxY());
      global.scrollTo({ top: top, behavior: reduce ? 'auto' : 'smooth' });
      S.idle = 0; kick();
    },

    refresh: function () { measure(); S.idle = 0; kick(); },
    get y() { return S.y; }
  };

  /* --------------------------------------------------------------- wire -- */
  global.addEventListener('scroll', function () { S.idle = 0; kick(); }, { passive: true });

  var rt;
  global.addEventListener('resize', function () {
    clearTimeout(rt);
    rt = setTimeout(function () { measure(); S.idle = 0; kick(); }, 120);
  }, { passive: true });

  /* Offsets are cached so the per-frame path never reads layout. That cache
     has to be rebuilt whenever the page grows or shrinks — content arriving
     from fetch, tickets sizing themselves, a font swapping in. Without this
     a scrubber registered before layout settled keeps scoring against stale
     offsets and simply never reaches its end. A ResizeObserver catches every
     one of those cases; measure() only reads, so it cannot loop. */
  if ('ResizeObserver' in global) {
    var ro = new ResizeObserver(function () {
      clearTimeout(rt);
      rt = setTimeout(function () { measure(); S.idle = 0; kick(); }, 60);
    });
    ro.observe(document.documentElement);
  }

  document.addEventListener('DOMContentLoaded', function () { measure(); kick(); });
  global.addEventListener('load', function () { measure(); S.idle = 0; kick(); });
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(function () { measure(); S.idle = 0; kick(); });
  }

  global.SX = API;
})(window);

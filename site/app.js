/* ==========================================================================
   app.js — SKASC LabFlow
   --------------------------------------------------------------------------
   Reads two files at run time and invents nothing:
     data.json    college, participant code, labs[]      (official schema)
     build.json   deployed_by, sha, run, redeployed      (written by Actions)

   Optionally enriches the deployment panel with the real commit author,
   avatar and timestamp from the public GitHub API, keyed by the SHA already
   inside build.json. Best-effort: if the meta tag is empty, the repo is
   private or the API is rate-limited, the panel shows exactly what
   build.json records and claims nothing more.

   Every value is written with textContent. No innerHTML, anywhere.
   ========================================================================== */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var SX = window.SX;
  document.documentElement.classList.add('js');
  var reduce = SX ? SX.reduce : false;
  var clamp = function (v, a, b) { return v < a ? a : v > b ? b : v; };

  function el(tag, cls, txt) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt !== undefined && txt !== null) n.textContent = String(txt);
    return n;
  }
  function setText(id, txt) { var n = $(id); if (n) n.textContent = txt; }

  /* ========================================================== fetch ===== */
  /* Both JSON files must always be the freshest copy. `cache: 'no-store'`
     alone is not enough — with no Cache-Control header a browser may still
     apply heuristic freshness and serve a memory-cached copy, which is the
     "run is green but the page shows old content" symptom in the official
     troubleshooting table. A unique query string makes that impossible.
     Azure Blob Storage ignores unknown query parameters. */
  function loadJSON(path) {
    var url = path + (path.indexOf('?') === -1 ? '?' : '&') + '_=' + Date.now();
    return fetch(url, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) { var e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
      return r.text().then(function (body) {
        try { return JSON.parse(body); }
        catch (x) { var e2 = new Error('bad json'); e2.parse = true; throw e2; }
      });
    });
  }

  /* ======================================================= formatting === */
  function parseTime(v) {
    if (typeof v !== 'string') return null;
    var m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(v);
    if (!m) return null;
    var h = +m[1], mi = +m[2];
    if (h > 23 || mi > 59) return null;
    var h12 = h % 12 === 0 ? 12 : h % 12;
    return { minutes: h * 60 + mi, label: h12 + ':' + m[2],
             ampm: h < 12 ? 'AM' : 'PM', raw: (h < 10 ? '0' + h : '' + h) + ':' + m[2] };
  }
  function dur(mins) {
    var h = Math.floor(mins / 60), m = mins % 60;
    if (h && m) return h + 'h ' + m + 'm';
    if (h) return h + (h === 1 ? ' hour' : ' hours');
    return m + ' min';
  }
  function ago(iso) {
    var t = Date.parse(iso); if (isNaN(t)) return null;
    var s = Math.floor((Date.now() - t) / 1000);
    if (s < 0) return 'just now';
    if (s < 60) return s + 's ago';
    var m = Math.floor(s / 60);  if (m < 60) return m + ' minute' + (m > 1 ? 's' : '') + ' ago';
    var h = Math.floor(m / 60);  if (h < 24) return h + ' hour' + (h > 1 ? 's' : '') + ' ago';
    var d = Math.floor(h / 24);  if (d < 30) return d + ' day' + (d > 1 ? 's' : '') + ' ago';
    var mo = Math.floor(d / 30); if (mo < 12) return mo + ' month' + (mo > 1 ? 's' : '') + ' ago';
    var y = Math.floor(mo / 12); return y + ' year' + (y > 1 ? 's' : '') + ' ago';
  }
  function absTime(iso) {
    var t = new Date(iso); if (isNaN(t.getTime())) return null;
    try {
      return t.toLocaleString(undefined, { day: '2-digit', month: 'short', year: 'numeric',
                                           hour: '2-digit', minute: '2-digit' });
    } catch (e) { return t.toISOString().slice(0, 16).replace('T', ' '); }
  }

  /* ============================================================ icons === */
  var ICON = {
    computer: 'M4 6h16v10H4zM4 9.5h16M9 20h6M12 16v4',
    physics:  'M12 12m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0M12 12c6-4.5 9-4 9.5-2.5S18 15 12 12M12 12c-6 4.5-9 4-9.5 2.5S6 9 12 12',
    chem:     'M9 3.5h6M10.5 3.5v5L5.5 17a2.5 2.5 0 0 0 2.2 3.5h8.6a2.5 2.5 0 0 0 2.2-3.5L13.5 8.5v-5M7.5 14h9',
    bio:      'M7 3.5c0 7 10 6 10 13a4 4 0 0 1-8 .5M17 3.5c0 7-10 6-10 13M8.5 8.5h7M7.5 13h8',
    lang:     'M4 6.5h16M12 4v2.5M9.5 6.5c0 5-2 8-5 10M14 6.5c0 4 1.5 7 5 9M9 13.5c1.5 2 3.5 3.5 6 4.5',
    lib:      'M5 4.5h5.5A1.5 1.5 0 0 1 12 6v13a1.5 1.5 0 0 0-1.5-1.5H5zM19 4.5h-5.5A1.5 1.5 0 0 0 12 6v13a1.5 1.5 0 0 1 1.5-1.5H19z',
    research: 'M11 4.5a6 6 0 1 0 0 12a6 6 0 0 0 0-12M15.5 15.5L20 20',
    def:      'M12 3.5v4M12 16.5v4M3.5 12h4M16.5 12h4M6.2 6.2l2.8 2.8M15 15l2.8 2.8M17.8 6.2L15 9M9 15l-2.8 2.8'
  };
  function iconFor(name) {
    var n = String(name || '').toLowerCase();
    if (/comput|software|program|coding|\bit\b|\bcs\b|network/.test(n)) return ICON.computer;
    if (/physic|electron|mechan/.test(n)) return ICON.physics;
    if (/chem/.test(n)) return ICON.chem;
    if (/bio|botan|zoolog|micro|life ?science/.test(n)) return ICON.bio;
    if (/lang|english|communicat|tamil/.test(n)) return ICON.lang;
    if (/librar|read/.test(n)) return ICON.lib;
    if (/research|project|innovat|update/.test(n)) return ICON.research;
    return ICON.def;
  }
  function svgIcon(d, size, stroke) {
    var NS = 'http://www.w3.org/2000/svg';
    var s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('width', size); s.setAttribute('height', size);
    s.setAttribute('aria-hidden', 'true'); s.setAttribute('focusable', 'false');
    var p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d); p.setAttribute('fill', 'none');
    p.setAttribute('stroke', stroke || 'currentColor');
    p.setAttribute('stroke-width', '1.7');
    p.setAttribute('stroke-linecap', 'round'); p.setAttribute('stroke-linejoin', 'round');
    s.appendChild(p); return s;
  }

  /* ====================================================== tear tickets == */
  var tickets = [];

  function ticketBody(name, i, opens, closes) {
    var box = el('div', 'tk');
    var head = el('div', 'tk__hd');
    var ico = el('span', 'tk__ico');
    ico.appendChild(svgIcon(iconFor(name), 19, '#DFF55C'));
    head.appendChild(ico);
    head.appendChild(el('span', 'tk__tag', 'LAB'));
    box.appendChild(head);
    box.appendChild(el('h3', 'tk__name', name));

    var times = el('div', 'tk__times');
    var o = el('div', 'tk__t');
    o.appendChild(el('span', 'tk__tl', 'Opens'));
    var ov = el('span', 'tk__tv', opens ? opens.label : '—');
    if (opens) ov.appendChild(el('em', null, opens.ampm));
    o.appendChild(ov); times.appendChild(o);

    var ar = el('span', 'tk__ar', '→'); ar.setAttribute('aria-hidden', 'true');
    times.appendChild(ar);

    var c = el('div', 'tk__t');
    c.appendChild(el('span', 'tk__tl', 'Closes'));
    var cv = el('span', 'tk__tv', closes ? closes.label : '—');
    if (closes) cv.appendChild(el('em', null, closes.ampm));
    c.appendChild(cv); times.appendChild(c);
    box.appendChild(times);

    var foot = el('div', 'tk__ft');
    if (opens && closes && closes.minutes - opens.minutes > 0) {
      foot.appendChild(el('span', 'tk__dur', dur(closes.minutes - opens.minutes)));
      foot.appendChild(el('span', 'tk__win', opens.raw + '–' + closes.raw));
    } else {
      foot.appendChild(el('span', 'tk__warn', 'Timing not set in data.json'));
    }
    box.appendChild(foot);
    return box;
  }

  function ticketStub(i) {
    var s = el('div', 'tkS');
    s.appendChild(el('span', 'tkS__k', 'SLOT'));
    s.appendChild(el('span', 'tkS__n', (i + 1 < 10 ? '0' : '') + (i + 1)));
    var b = el('span', 'tkS__bar'); b.setAttribute('aria-hidden', 'true');
    for (var k = 0; k < 7; k++) b.appendChild(el('i'));
    s.appendChild(b);
    s.appendChild(el('span', 'tkS__p', 'ADMIT'));
    return s;
  }

  function renderTickets(labs) {
    var rail = $('tickets'), sk = $('ticketsSk');
    if (sk) sk.hidden = true;
    rail.setAttribute('aria-busy', 'false');

    if (!Array.isArray(labs) || labs.length === 0) { $('labsEmpty').hidden = false; return 0; }

    tickets.forEach(function (t) { t.destroy(); });
    tickets = [];
    rail.replaceChildren();

    labs.forEach(function (lab, i) {
      var name = (lab && typeof lab.name === 'string' && lab.name.trim()) ? lab.name.trim() : 'Unnamed lab';
      var host = document.createElement('div');
      host.className = 'tkw';
      host.setAttribute('role', 'listitem');
      rail.appendChild(host);

      var t = new TearTicket(host, {
        width: 430, height: 196, stubSize: 116, radius: 20,
        holes: 13, holeSize: 6, notch: 3, roughness: 0,
        tearAngle: 30, stretch: 30, resistance: 0.45,
        rotate: (i % 2 ? 1 : -1) * 0.7,
        tilt: true, tiltMax: 6, tiltReach: 240,
        background: '#16355C', stubBackground: '#0E2440',
        color: '#F2F8FE', borderColor: 'rgba(223,245,92,.2)',
        ariaLabel: 'Tear off the stub for ' + name
      });
      t.setBody(ticketBody(name, i, parseTime(lab && lab.opens), parseTime(lab && lab.closes)));
      t.setStub(ticketStub(i));
      tickets.push(t);
    });

    /* shared pointermove drives tilt for every ticket */
    if (!reduce && !(SX && SX.coarse)) {
      window.addEventListener('pointermove', function (e) {
        if (e.pointerType === 'touch') return;
        for (var i = 0; i < tickets.length; i++) {
          var t = tickets[i], r = t.host.getBoundingClientRect();
          if (r.bottom < -200 || r.top > window.innerHeight + 200) continue;
          t.aim(clamp((e.clientX - (r.left + r.width / 2)) / (r.width / 2 + t.o.tiltReach), -1, 1),
                clamp((e.clientY - (r.top + r.height / 2)) / (r.height / 2 + t.o.tiltReach), -1, 1));
        }
      }, { passive: true });
    }

    /* ---- scroll scrubs the tear, in BOTH directions ----
       Progress through the schedule section is remapped onto a tear window,
       with a small per-ticket offset so the stubs come away as one wave.
       Scroll back up and setProgress runs in reverse: the paper bridges
       re-form and the stubs rejoin. */
    var track = $('tearTrack');
    var hint = $('tearHintTxt');
    if (SX && track && !reduce) {
      var n = tickets.length;
      var step = 0.07;                      /* small offset so they go as a wave */
      var span = 1 - (n - 1) * step;
      SX.scrub(track, function (p) {
        /* a beat of stillness at each end, the tear in the middle */
        var tp = clamp((p - 0.18) / 0.52, 0, 1);
        for (var i = 0; i < tickets.length; i++) {
          tickets[i].setProgress(clamp((tp - i * step) / span, 0, 1));
        }
        if (hint) {
          hint.textContent = tp > 0.97
            ? 'Stubs torn. Scroll back up and they rejoin.'
            : tp < 0.03
              ? 'Keep scrolling — the stubs tear away. Scroll back up and they rejoin.'
              : 'Tearing… scroll up to put them back.';
        }
      }, 'pin');
    }

    if (SX) SX.refresh();
    return labs.length;
  }

  /* =================================================== small list views = */
  function fillRows(box, labs, max, cls) {
    if (!box) return;
    box.replaceChildren();
    labs.slice(0, max).forEach(function (lab, i) {
      var o = parseTime(lab.opens), c = parseTime(lab.closes);
      var row = el('div', cls === 'w' ? 'wrow' : 'mrow');
      if (cls === 'w') {
        row.appendChild(el('b', null, lab.name || 'Unnamed lab'));
        row.appendChild(el('span', null, o && c ? o.raw + ' – ' + c.raw : 'not set'));
      } else {
        var l = el('div', 'mrow__l');
        l.appendChild(el('b', null, lab.name || 'Unnamed lab'));
        l.appendChild(el('span', null, o && c ? o.raw + ' – ' + c.raw : 'Timing not set'));
        row.appendChild(l);
        row.appendChild(el('span', 'mrow__n', (i + 1 < 10 ? '0' : '') + (i + 1)));
      }
      box.appendChild(row);
    });
  }

  function showDataError(msg) {
    var sk = $('ticketsSk'); if (sk) sk.hidden = true;
    $('labsErrorText').textContent = msg;
    $('labsError').hidden = false;
    $('tickets').setAttribute('aria-busy', 'false');
    var hint = $('tearHint'); if (hint) hint.textContent = '';
    setText('statLabs', '—'); setText('bxLabs', '—'); setText('orbLabs', '—');
    setText('winCollege', 'Unavailable');
    setText('bxCollege', 'Unavailable'); setText('bxCode', '—');
  }

  /* ====================================================== data.json ===== */
  loadJSON('data.json').then(function (d) {
    if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error('not an object');

    var college = (typeof d.college === 'string' && d.college.trim()) ? d.college.trim() : null;
    var code = (typeof d.code === 'string' && d.code.trim()) ? d.code.trim() : null;
    var labs = Array.isArray(d.labs) ? d.labs : [];

    setText('winCollege', college || 'Not set in data.json');
    setText('bxCollege', college || 'Not set in data.json');
    setText('bxCode', code || 'not set');
    setText('scnCollege', college || 'Today');
    if (college) document.title = college + ' · Lab Timings | SKASC LabFlow';

    var n = renderTickets(labs);
    fillRows($('winList'), labs, 3, 'w');
    fillRows($('mlist'), labs, 4, 'm');

    setText('statLabs', n ? String(n) : '0');
    setText('bxLabs', n ? String(n) : '0');
    setText('orbLabs', n ? String(n) : '0');
  })['catch'](function (err) {
    var m;
    if (err && err.parse) {
      m = 'The file loaded but is not valid JSON — check for a missing comma, quote or bracket in site/data.json.';
    } else if (err && err.status === 404) {
      m = 'data.json was not found next to this page (HTTP 404). It must be deployed alongside index.html in the site container.';
    } else if (err && err.status) {
      m = 'The request for data.json failed with HTTP ' + err.status + '.';
    } else if (location.protocol === 'file:') {
      m = 'Browsers block fetch() on file:// URLs. Serve the folder over HTTP — see the README.';
    } else {
      m = 'The request for data.json could not be completed. Check your connection and reload.';
    }
    showDataError(m);
  });

  /* ====================================================== build.json ==== */
  var LOCAL = ['localhost', '127.0.0.1', '[::1]', '::1', ''];
  var isLocal = location.protocol === 'file:' || LOCAL.indexOf(location.hostname) !== -1;
  var isSha = function (v) { return typeof v === 'string' && /^[0-9a-f]{7,40}$/i.test(v); };

  function setState(state, pill) {
    var p = $('dep'); if (p) p.setAttribute('data-state', state);
    setText('depPillTxt', pill);
    setText('bxState', pill);
  }

  function enrich(sha) {
    var meta = document.querySelector('meta[name="labflow:repo"]');
    var repo = meta ? (meta.getAttribute('content') || '').trim() : '';
    if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo) || !sha) return;

    fetch('https://api.github.com/repos/' + repo + '/commits/' + sha,
          { headers: { 'Accept': 'application/vnd.github+json' }, cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (c) {
        if (!c || !c.commit) return;
        var who = c.author || {}, ca = c.commit.author || {};
        setText('depName', ca.name || who.login || 'Unknown author');

        var lg = $('depLogin');
        if (who.login) {
          lg.textContent = '@' + who.login;
          lg.href = 'https://github.com/' + encodeURIComponent(who.login);
          lg.hidden = false;
        } else lg.hidden = true;

        setText('depMsg', (c.commit.message || '').split('\n')[0] || '(no commit message)');
        setText('depWhen', ago(ca.date) || 'time unknown');
        setText('depAbs', absTime(ca.date) || '');

        var av = $('depAvatar');
        if (who.avatar_url) {
          av.onerror = function () { av.style.display = 'none'; };
          av.src = who.avatar_url + '&s=104';
          av.alt = 'Avatar of ' + (who.login || ca.name || 'the commit author');
        } else av.style.display = 'none';

        $('depAuthor').hidden = false;
      })['catch'](function () {
        /* Silent: the panel already shows everything build.json records.
           We never claim author details we could not read. */
      });
  }

  loadJSON('build.json').then(function (b) {
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw new Error('not an object');

    var by = (typeof b.deployed_by === 'string' && b.deployed_by.trim()) ? b.deployed_by.trim() : null;
    var sha = isSha(b.sha) ? b.sha : null;
    var run = (typeof b.run === 'number' && isFinite(b.run)) ? b.run : null;
    var re = typeof b.redeployed === 'boolean' ? b.redeployed : null;

    setText('deployedBy', by ? 'Deployed by ' + by : 'Deployed by (not recorded)');

    var shaN = $('metaSha');
    if (sha) {
      var short = sha.length > 7 ? sha.slice(0, 7) : sha;
      shaN.textContent = short; shaN.title = sha;
      setText('winSha', short); setText('mSha', short); setText('orbSha', short);
      setText('sFootSha', short);
      var cb = $('copySha');
      if (cb && navigator.clipboard && navigator.clipboard.writeText) {
        cb.hidden = false;
        cb.setAttribute('aria-label', 'Copy full commit SHA ' + sha);
        cb.addEventListener('click', function () {
          navigator.clipboard.writeText(sha).then(function () {
            cb.classList.add('ok'); setText('copyShaTxt', 'Copied');
            setTimeout(function () { cb.classList.remove('ok'); setText('copyShaTxt', 'Copy'); }, 1800);
          })['catch'](function () { setText('copyShaTxt', 'Press Ctrl+C'); });
        });
      }
    } else { shaN.textContent = 'Not recorded'; shaN.className = 'mut'; }

    setText('metaRun', run !== null ? '#' + run : 'Not recorded');
    setText('statRun', run !== null ? '#' + run : '—');
    setText('mRun', run !== null ? '#' + run : '—');
    setText('chipRun', run !== null ? 'run #' + run + ' passed' : 'no run yet');

    var rn = $('metaRe');
    if (re === null) { rn.textContent = 'Not recorded'; rn.className = 'mut'; }
    else { rn.textContent = re ? 'Yes' : 'No — first run'; rn.className = re ? 'yes' : 'no'; }
    setText('mRe', re === null ? '—' : (re ? 'Yes' : 'No'));

    if (location.protocol === 'http:' || location.protocol === 'https:') {
      $('metaLink').hidden = false; $('metaLinkNo').hidden = true;
    }

    if (isLocal) {
      setState('pending', 'Local preview');
      setText('mOk', 'Local preview');
      setText('depNote',
        'This build.json is being served from a local preview, not from Azure Blob Storage. ' +
        'The values above are the real contents of the file, but they do not confirm a live deployment.');
      setText('footStatus', 'Local preview · build.json read from the local server, not from Azure.');
    } else {
      setState('live', 'Published');
      setText('mOk', 'Published');
      var bits = [];
      if (run !== null) bits.push('run #' + run);
      if (sha) bits.push('commit ' + sha.slice(0, 7));
      setText('depNote', bits.length
        ? 'Published by ' + (by || 'the workflow') + ' from ' + bits.join(', ') +
          '. Compare this SHA with the latest commit on main to verify the deploy.'
        : 'build.json loaded, but it recorded no run number or commit SHA.');
      setText('footStatus', 'Published by GitHub Actions' +
        (sha ? ' · commit ' + sha.slice(0, 7) : '') + (run !== null ? ' · run #' + run : ''));
    }

    if (sha) enrich(sha);
  })['catch'](function (err) {
    var note;
    if (err && err.status === 404) {
      setState('pending', 'Not deployed yet');
      setText('deployedBy', 'Not deployed yet');
      setText('mOk', 'Not deployed yet');
      setText('chipRun', 'no run yet');
      note = 'build.json does not exist here. The GitHub Actions workflow creates it during a deploy, ' +
             'so this is the expected state before the first run (and during local preview).';
      setText('footStatus', 'Not deployed yet · build.json is written by the deploy workflow.');
    } else if (err && err.parse) {
      setState('error', 'Metadata unreadable');
      setText('deployedBy', 'Deployment status unknown');
      note = 'build.json was served but is not valid JSON, so no deployment metadata can be trusted.';
      setText('footStatus', 'Deployment metadata unreadable.');
    } else if (location.protocol === 'file:') {
      setState('pending', 'Not available');
      setText('deployedBy', 'Deployment status unknown');
      note = 'Opened from the file system, so build.json cannot be fetched. Serve the folder over HTTP.';
      setText('footStatus', 'Opened from the file system · deployment metadata unavailable.');
    } else {
      setState('error', 'Check failed');
      setText('deployedBy', 'Deployment status unknown');
      note = 'build.json could not be loaded' + (err && err.status ? ' (HTTP ' + err.status + ')' : '') +
             '. The deployment state of this page cannot be confirmed.';
      setText('footStatus', 'Deployment status could not be confirmed.');
    }
    setText('depNote', note);
    ['metaSha', 'metaRun', 'metaRe'].forEach(function (id) {
      var n = $(id); if (n) { n.textContent = 'Unknown'; n.className = 'mut'; }
    });
  });

  /* ============================================================= nav ==== */
  (function () {
    var b = $('burger'), m = $('navLinks');
    if (b && m) {
      var close = function () { m.classList.remove('open'); b.setAttribute('aria-expanded', 'false'); };
      b.addEventListener('click', function () {
        var o = m.classList.toggle('open');
        b.setAttribute('aria-expanded', o ? 'true' : 'false');
      });
      m.addEventListener('click', function (e) { if (e.target.tagName === 'A') close(); });
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && m.classList.contains('open')) { close(); b.focus(); }
      });
      window.addEventListener('resize', function () { if (innerWidth > 980) close(); }, { passive: true });
    }

    /* Solid bar as soon as anything scrolls under it. A sentinel keeps this
       off the scroll path entirely — no listener, no per-frame work. */
    var nav = document.querySelector('.nav');
    var sent = document.createElement('div');
    sent.style.cssText = 'position:absolute;top:0;left:0;width:1px;height:40px;pointer-events:none';
    document.body.prepend(sent);
    new IntersectionObserver(function (es) {
      nav.classList.toggle('solid', !es[0].isIntersecting);
    }, { threshold: 0 }).observe(sent);
  })();

  document.querySelectorAll('a[data-scroll]').forEach(function (a) {
    a.addEventListener('click', function (e) {
      var id = this.getAttribute('href').slice(1);
      var t = document.getElementById(id);
      if (!t) return;
      e.preventDefault();
      if (SX) SX.to(t); else t.scrollIntoView({ behavior: 'smooth' });
      if (!t.hasAttribute('tabindex')) t.setAttribute('tabindex', '-1');
      t.focus({ preventScroll: true });
      if (history.replaceState) history.replaceState(null, '', '#' + id);
    });
  });

  /* ========================================================== cursor ==== */
  /* Preferred: the WebGL swarm. It needs WebGL2, a fine pointer and no
     reduced-motion preference; when any of those is missing we fall back to
     the lightweight CSS ring below. Either way the system cursor stays
     visible and neither one ever captures input. */
  var swarm = null;
  if (window.SwarmCursor) {
    swarm = window.SwarmCursor.mount({
      count: 420,
      size: 2.4,
      spread: 105,
      swirl: 0.62,
      tail: 0.5,
      trail: 0.6,
      wander: 0.45,
      depth: 0.7,
      idle: 'hide',
      clickEffect: 'burst',
      targets: 'a, button, [role="button"], .tt__paper--stub',
      color: '#FFFFFF',
      accentColor: '#DFF55C',
      dpr: 1.5,
      /* Our palette, chosen from whatever the swarm is actually flying over:
         navy particles on pale surfaces, white on the deep blue and navy
         ones, lime as the accent everywhere. Driven by the real background
         luminance rather than a list of selectors, so a white card sitting
         on a blue section still gets dark particles. Only recomputed when
         the element under the pointer changes, so it costs nothing to move. */
      onMove: (function () {
        var lastEl = null, lastLight = null;
        function litSurface(el) {
          /* nodeType 1 guard: a pointermove dispatched on window or document
             has a non-Element target, and getComputedStyle would throw. */
          for (var n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
            var m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?/
              .exec(getComputedStyle(n).backgroundColor);
            if (m && (m[4] === undefined || parseFloat(m[4]) > 0.5)) {
              return (0.2126 * +m[1] + 0.7152 * +m[2] + 0.0722 * +m[3]) / 255 > 0.55;
            }
          }
          return true;
        }
        return function (e, cfg) {
          var el = e.target;
          if (!el || el === lastEl) return;
          lastEl = el;
          var light = litSurface(el);
          if (light === lastLight) return;
          lastLight = light;
          cfg.color = light ? '#0E2440' : '#FFFFFF';
          cfg.lightMode = light;
        };
      })()
    });
  }

  (function () {
    var cur = $('cur');
    if (swarm) { if (cur) cur.remove(); return; }   /* swarm took over */
    if (!cur || reduce) return;
    if (!window.matchMedia || !window.matchMedia('(hover:hover) and (pointer:fine)').matches) return;

    var tx = 0, ty = 0, x = 0, y = 0, raf = 0, shown = false;
    var HOT = 'a,button,[role="button"],.tt__paper--stub,input,summary';

    function run() {
      raf = 0;
      x += (tx - x) * 0.18;
      y += (ty - y) * 0.18;
      cur.style.transform = 'translate3d(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px,0)';
      if (Math.abs(tx - x) > 0.3 || Math.abs(ty - y) > 0.3) raf = requestAnimationFrame(run);
    }

    window.addEventListener('pointermove', function (e) {
      if (e.pointerType === 'touch') return;
      tx = e.clientX; ty = e.clientY;
      if (!shown) {
        shown = true; x = tx; y = ty;
        cur.classList.add('on');
      }
      /* dark ring on light sections so it stays visible on both */
      var light = e.target.closest && e.target.closest('.sec--sched,.stage,#pipeline,.bx,.win');
      cur.classList.toggle('dark', !!light);
      cur.classList.toggle('hot', !!(e.target.closest && e.target.closest(HOT)));
      if (!raf) raf = requestAnimationFrame(run);
    }, { passive: true });

    window.addEventListener('pointerdown', function () { cur.classList.add('press'); }, { passive: true });
    window.addEventListener('pointerup', function () { cur.classList.remove('press'); }, { passive: true });
    document.addEventListener('mouseleave', function () { cur.classList.remove('on'); });
    document.addEventListener('mouseenter', function () { if (shown) cur.classList.add('on'); });
  })();

  /* ========================================================= marquee ==== */
  (function () {
    var m = $('marquee'); if (!m) return;
    var words = ['PUSH TO MAIN', 'ACTIONS RUNS', 'BLOB UPDATED', 'ZERO MANUAL UPLOAD',
                 'NO-CACHE', 'SHA VERIFIED', 'CENTRAL INDIA'];
    var line = document.createElement('span');
    for (var r = 0; r < 2; r++) {
      words.forEach(function (w) {
        line.appendChild(el('b', null, w));
        var s = el('i', null, '✦'); s.setAttribute('aria-hidden', 'true');
        line.appendChild(s);
      });
    }
    m.appendChild(line);
    m.appendChild(line.cloneNode(true));
  })();

  /* ================================================= scroll choreography = */
  if (SX) {
    SX.reveals('[data-reveal]');

    /* bento progress bar fills once its card is revealed */
    var leadCard = document.querySelector('.bx--lead');
    if (leadCard) {
      SX.once(leadCard, function () {
        var bar = $('bxBar');
        if (bar) setTimeout(function () { bar.style.width = '100%'; }, 220);
        document.querySelectorAll('.bx--road').forEach(function (c) { c.classList.add('in'); });
      }, '0px 0px -15% 0px');
    }

    /* hero: chips drift against the scroll */
    var hero = document.querySelector('.hero');
    var floats = [].slice.call(document.querySelectorAll('[data-float]'));
    if (hero && floats.length && !reduce) {
      SX.scrub(hero, function (p) {
        var t = p * 2 - 1;
        for (var i = 0; i < floats.length; i++) {
          var k = parseFloat(floats[i].getAttribute('data-float')) || 0;
          floats[i].style.transform = 'translate3d(0,' + (t * k * 46).toFixed(1) + 'px,0)';
        }
      }, 'through');
    }

    /* ---- the phone stage ----
       The phone is the subject: it zooms in as you enter the section, the
       chips break away from behind it, and the screen advances through the
       journey a real visitor takes. All of it reverses on the way back up. */
    var track = $('stageTrack');
    var phone = $('phone');
    var scenes = [].slice.call(document.querySelectorAll('.scn'));
    var orbs = [].slice.call(document.querySelectorAll('[data-orb]'));
    var dots = [].slice.call(document.querySelectorAll('.stage__dots i'));
    var copy = $('stageCopy');

    var DIR = { 1: [-1, -0.45], 2: [1, -0.35], 3: [-1, 0.05], 4: [1, 0.5], 5: [-1, 0.6], 6: [1, -0.1] };

    if (track && phone && scenes.length) {
      /* start state so nothing flashes at full size before the first frame */
      if (!reduce) {
        phone.style.transform = 'scale(.82)';
        orbs.forEach(function (o) { o.style.opacity = '0'; });
      }
      SX.scrub(track, function (p) {
        var idx = p < 0.34 ? 0 : p < 0.68 ? 1 : 2;
        for (var i = 0; i < scenes.length; i++) scenes[i].classList.toggle('on', i === idx);
        for (var j = 0; j < dots.length; j++) dots[j].classList.toggle('on', j === idx);

        if (reduce) return;

        var zoom = 0.82 + Math.min(p / 0.3, 1) * 0.2;         /* 0.82 → 1.02 */
        phone.style.transform = 'scale(' + zoom.toFixed(3) + ')';

        var spread = Math.min(p / 0.34, 1);
        for (var k = 0; k < orbs.length; k++) {
          var d = DIR[orbs[k].getAttribute('data-orb')] || [0, 0];
          orbs[k].style.opacity = clamp((spread - 0.08) / 0.3, 0, 1).toFixed(2);
          orbs[k].style.transform =
            'translate3d(' + (d[0] * spread * 46).toFixed(1) + 'px,' +
            (d[1] * spread * 46).toFixed(1) + 'px,0)';
        }

        /* The copy stays readable — the phone already dominates by scale, so
           dimming the heading only made it look broken. It just lifts away. */
        if (copy) copy.style.transform = 'translateY(' + (-spread * 18).toFixed(1) + 'px)';
      }, 'pin');
    }
  }
})();

/* Topology page: a movable canvas (drag to pan, wheel or pinch to zoom, inertia), draggable
   nodes, one-click link states, host editing, the Brazil map background (switches pinned to
   the UF in their dp-desc) and .py import/export.
   Positions live in world units; everything is drawn in screen space so nodes keep their size
   at any zoom. Wires are updated in place, so animations on them survive redraws. */
(() => {
  'use strict';
  const R = window.REIN, M = R.model, $ = R.$, $$ = R.$$;
  const NS = 'http://www.w3.org/2000/svg';
  const stage = $('[data-stage]');
  const world = $('[data-world]');
  const MAPK = 1.45;
  let mapMode = false, view = { s: 1, tx: 0, ty: 0 }, openKey = null, moved = false;
  const shown = new Map();
  let mapPos = new Map();

  // ------------------------------------------------------------ geometry (world units)
  const hash = s => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7);
  const bend = id => (hash(id) & 1 ? 1 : -1);
  const pos = id => shown.get(id) || [0, 0];
  const sc = p => [view.tx + p[0] * view.s, view.ty + p[1] * view.s];
  // Links leave and reach their nodes along the dominant axis.
  // On the map they become gentle arcs, closer to how long-haul links are drawn.
  function curve(aId, bId, id, straight = false) {
    const a = pos(aId), b = pos(bId);
    const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1;
    let c1, c2;
    if (straight) { c1 = [a[0] + dx / 3, a[1] + dy / 3]; c2 = [a[0] + 2 * dx / 3, a[1] + 2 * dy / 3]; }
    else if (mapMode) {
      const s = bend(id) * Math.min(len * .14, 40), nx = -dy / len * s, ny = dx / len * s;
      c1 = [a[0] + dx / 3 + nx, a[1] + dy / 3 + ny]; c2 = [a[0] + 2 * dx / 3 + nx, a[1] + 2 * dy / 3 + ny];
    } else if (Math.abs(dx) >= Math.abs(dy)) { c1 = [a[0] + dx * .5, a[1]]; c2 = [b[0] - dx * .5, b[1]]; }
    else { c1 = [a[0], a[1] + dy * .5]; c2 = [b[0], b[1] - dy * .5]; }
    return { a, b, c1, c2, mid: [(a[0] + 3 * c1[0] + 3 * c2[0] + b[0]) / 8, (a[1] + 3 * c1[1] + 3 * c2[1] + b[1]) / 8] };
  }
  const f1 = v => v.toFixed(1);
  const cSeg = c => { const [c1, c2, b] = [sc(c.c1), sc(c.c2), sc(c.b)]; return `C${f1(c1[0])} ${f1(c1[1])} ${f1(c2[0])} ${f1(c2[1])} ${f1(b[0])} ${f1(b[1])}`; };
  const dOf = c => { const a = sc(c.a); return `M${f1(a[0])} ${f1(a[1])}${cSeg(c)}`; };
  function segment(p, q) {
    const l = R.between(p, q);
    if (l) {
      const c = curve(l.a, l.b, l.id);
      return l.a === p ? c : { a: c.b, b: c.a, c1: c.c2, c2: c.c1 };
    }
    return curve(p, q, `${p}${q}`, true);
  }
  const routeD = path => path.slice(1).reduce((d, q, i) => { const c = segment(path[i], q); const a = sc(c.a); return d + (i ? '' : `M${f1(a[0])} ${f1(a[1])}`) + cSeg(c); }, '');

  function computeMap() {
    mapPos = new Map();
    const A = window.REIN_BR.anchors;
    const groups = {};
    R.switches().forEach(s => { const k = s.anchor || s.uf; (groups[k] ||= []).push(s); });
    Object.entries(groups).forEach(([k, list]) => {
      const base = A[k] ? [A[k][0] * MAPK, A[k][1] * MAPK] : null;
      list.forEach((s, i) => {
        if (!base) { mapPos.set(s.id, [1380, 1150 + i * 40]); return; }
        if (list.length === 1) { mapPos.set(s.id, base); return; }
        // Two or more switches in one state sit on a small ring so they never overlap
        const a = (i / list.length) * Math.PI * 2 - Math.PI / 2, r = 16 + list.length * 4;
        mapPos.set(s.id, [base[0] + Math.cos(a) * r, base[1] + Math.sin(a) * r]);
      });
    });
    const cx = 560 * MAPK, cy = 560 * MAPK;
    R.switches().forEach(sw => {
      const hs = R.hosts().filter(h => h.sw === sw.id);
      const p = mapPos.get(sw.id);
      const base = Math.atan2(p[1] - cy, p[0] - cx);
      hs.forEach((h, i) => { const a = base + (i - (hs.length - 1) / 2) * .8; mapPos.set(h.id, [p[0] + Math.cos(a) * 64, p[1] + Math.sin(a) * 64]); });
    });
  }
  const target = n => mapMode ? (mapPos.get(n.id) || [n.x, n.y]) : [n.x, n.y];

  // ------------------------------------------------------------ render
  // Host glyphs are drawn inline so their parts can move while the host is operating:
  // a server's LEDs blink and its bays stream, a client's screen shows the bitrate bars
  const SERVER = '<svg class="hg" viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><rect x="4" y="4" width="16" height="7" rx="2"/><rect x="4" y="13" width="16" height="7" rx="2"/></g><circle class="led" cx="7.6" cy="7.5" r="1.3" fill="currentColor"/><circle class="led" cx="7.6" cy="16.5" r="1.3" fill="currentColor"/><path class="io" d="M11 7.5h5.6M11 16.5h5.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-dasharray=".1 2.4"/></svg>';
  const CLIENT = '<svg class="hg" viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="5" width="14" height="10" rx="1.8"/><path d="M3 18.5h18"/></g><g class="eq" fill="currentColor"><rect x="8.7" y="7.9" width="1.6" height="4.9" rx=".8"/><rect x="11.2" y="7.9" width="1.6" height="4.9" rx=".8"/><rect x="13.7" y="7.9" width="1.6" height="4.9" rx=".8"/></g></svg>';
  const glyph = n => n.kind === 'switch' ? '<span class="core"></span>' : n.role === 'Servidor' ? SERVER : CLIENT;
  const sub = n => n.kind === 'switch' ? (n.uf || n.pop?.replace(/^PoP-/, '') || 'Switch') : n.ip;
  const els = new Map();
  let gen = 0, layers = null;
  function render() {
    computeMap();
    M.nodes.forEach(n => { if (!shown.has(n.id)) shown.set(n.id, target(n)); });
    [...shown.keys()].forEach(id => { if (!R.node(id)) shown.delete(id); });
    const used = new Set(R.switches().map(s => s.uf).filter(Boolean));
    const BR = window.REIN_BR;
    const map = `<svg class="map-layer" data-map width="${BR.w * MAPK}" height="${BR.h * MAPK}" viewBox="0 0 ${BR.w} ${BR.h}" aria-hidden="true">${Object.entries(BR.states).map(([uf, d]) => `<path class="${used.has(uf) ? 'is-used' : ''}" d="${d}"/>`).join('')}</svg>`;
    const nodes = M.nodes.map(n => `<button type="button" class="node ${n.kind}${n.kind === 'host' ? (n.role === 'Servidor' ? ' server' : ' client') : ''}${n.isNew ? ' is-new' : ''}${openKey === `n:${n.id}` ? ' is-open' : ''}${mapMode && n.kind === 'switch' ? ' is-pinned' : ''}${n.pending ? ' is-provisioning' : ''}" data-node="${n.id}" aria-label="${n.kind === 'switch' ? 'Switch' : n.role} ${n.id}, ${sub(n)}. Arraste para mover, Enter para detalhes.">${glyph(n)}<span class="n-label"><b><i>${R.icon('i-check')}</i>${n.id}</b><span>${R.esc(sub(n))}</span></span></button>`).join('');
    const pills = M.links.map(l => `<button type="button" class="pill" data-link="${l.id}" data-keep-pop><span class="pl-t"></span><i class="pl-bar"><b></b></i></button>`).join('');
    world.innerHTML = `${map}<svg class="wires" data-wires aria-hidden="true"><g data-l="pipes"></g><g data-l="access"></g><g data-l="links"></g><g data-l="beads"></g><g data-l="flow"></g><g data-l="hits"></g></svg>${pills}${nodes}`;
    const svg = $('[data-wires]', world);
    layers = Object.fromEntries($$('g', svg).map(g => [g.dataset.l, g]));
    els.clear();
    M.nodes.forEach(n => delete n.isNew);
    stage.classList.toggle('is-dense', M.nodes.length > 14);
    paint();
    status();
  }

  function paint() {
    const m = $('[data-map]', world);
    if (m) m.style.transform = `translate(${view.tx}px, ${view.ty}px) scale(${view.s})`;
    // Short links on screen switch to smaller nodes and quieter pills
    const dense = M.nodes.length > 14;
    const shortest = Math.min(Infinity, ...M.links.map(l => Math.hypot(...[0, 1].map(k => (pos(l.a)[k] - pos(l.b)[k]) * view.s))));
    stage.classList.toggle('is-compact', !dense && shortest < 150);
    // The dot grid under the canvas follows the camera, in steps so its spacing stays calm
    let g = 28 * view.s;
    while (g < 20) g *= 2;
    while (g > 44) g /= 2;
    stage.style.setProperty('--gs', `${g}px`);
    stage.style.setProperty('--gx', `${view.tx}px`);
    stage.style.setProperty('--gy', `${view.ty}px`);
    draw();
  }

  function path(key, layer, cls, d, extra) {
    let e = els.get(key);
    if (!e) { e = document.createElementNS(NS, 'path'); layers[layer].append(e); els.set(key, e); }
    if (e.getAttribute('class') !== cls) e.setAttribute('class', cls);
    e.setAttribute('d', d);
    if (extra) for (const k in extra) e.setAttribute(k, extra[k]);
    e.__gen = gen;
    return e;
  }
  // Capacity reads as the width of a soft pipe; traffic as beads that flow through it, denser as
  // the link fills up, in the direction the video travels (server to client)
  const pipeW = cap => cap > 0 ? Math.min(16, 4 + 2.4 * Math.log2(1 + cap / 2)) : 0;
  let loads = new Map();
  const shownVal = new Map();
  function flowDir() {
    const dir = new Map();
    Object.values(M.routes).forEach(r => { if (!r.path) return; r.path.slice(1).forEach((q, i) => { const l = R.between(r.path[i], q); if (l && !dir.has(l.id)) dir.set(l.id, l.a === r.path[i] ? 1 : -1); }); });
    return dir;
  }
  function draw() {
    if (!layers) return;
    gen++;
    const onRoute = new Set(), accessOn = new Set(), nodeOn = new Set();
    // Hosts with a traffic session starting or running are operating too
    const busy = new Set(R.traffic.sessions.filter(x => x.status === 'running' || x.status === 'starting').flatMap(x => [x.client, x.server]));
    Object.values(M.routes).forEach(r => { if (!r.path) return; R.pathLinks(r.path).forEach(l => onRoute.add(l.id)); accessOn.add(r.path[0]); accessOn.add(r.path.at(-1)); r.path.forEach(id => nodeOn.add(id)); });
    const dir = flowDir(), scale = M.nodes.length > 14 ? .55 : stage.classList.contains('is-compact') ? .75 : 1;
    R.hosts().forEach(h => { if (R.node(h.sw)) path(`a:${h.id}`, 'access', `wire access${accessOn.has(h.id) ? ' on-route' : ''}`, dOf(curve(h.sw, h.id, h.id, true))); });
    M.links.forEach(l => {
      const st = R.linkState(l), d = dOf(curve(l.a, l.b, l.id));
      const cap = l.now.down ? 0 : l.now.rate, load = loads.get(l.id) || 0, u = cap ? Math.min(1, load / cap) : 0;
      if (cap) path(`p:${l.id}`, 'pipes', `pipe${onRoute.has(l.id) ? ' on-route' : ''}${st !== 'ok' ? ` ${st}` : ''}`, d, { 'stroke-width': (pipeW(cap) * scale).toFixed(1) });
      path(`l:${l.id}`, 'links', `wire${onRoute.has(l.id) ? ' on-route' : ''}${st !== 'ok' ? ` ${st}` : ''}${openKey === `l:${l.id}` ? ' is-hot' : ''}${R.node(l.a)?.pending || R.node(l.b)?.pending ? ' pending' : ''}`, d);
      if (load > .3 && dir.has(l.id)) {
        // Quantised so the animation only restarts when the traffic really changes
        const q = Math.round(u * 20) / 20, gap = Math.round(34 - 22 * q);
        const b = path(`b:${l.id}`, 'beads', 'beads', d);
        const sig = `${gap}:${dir.get(l.id)}`;
        if (b.__sig !== sig) { b.__sig = sig; b.style.setProperty('--g', `${gap}px`); b.style.animationDuration = `${(gap / 40).toFixed(2)}s`; b.style.animationDirection = dir.get(l.id) > 0 ? 'normal' : 'reverse'; }
      }
      path(`h:${l.id}`, 'hits', 'wire-hit', d, { 'data-link': l.id, 'data-keep-pop': '' });
    });
    els.forEach((e, k) => { if (e.__gen !== gen && !k.startsWith('x:')) { e.remove(); els.delete(k); } });
    M.nodes.forEach(n => {
      const el = world.querySelector(`[data-node="${n.id}"]`);
      if (!el) return;
      const [x, y] = sc(pos(n.id));
      el.style.left = `${x}px`; el.style.top = `${y}px`;
      el.classList.toggle('on-route', nodeOn.has(n.id));
      if (n.kind === 'switch') el.classList.toggle('is-off', !!n.off);
      if (n.kind === 'host') { el.classList.toggle('is-live', !n.paused && (nodeOn.has(n.id) || busy.has(n.id))); el.classList.toggle('is-paused', !!n.paused); }
    });
    M.links.forEach(l => {
      const el = world.querySelector(`.pill[data-link="${l.id}"]`);
      if (!el) return;
      const st = R.linkState(l), [x, y] = sc(curve(l.a, l.b, l.id).mid);
      el.style.left = `${x}px`; el.style.top = `${y}px`;
      const mode = l.now.down ? 'down' : look.metric;
      const cls = `pill m-${mode}${st !== 'ok' ? ` ${st}` : ''}${openKey === `l:${l.id}` ? ' is-open' : ''}${el.classList.contains('is-hover') ? ' is-hover' : ''}`;
      if (el.className !== cls) el.className = cls;
      if (mode !== 'use') { const t = mode === 'down' ? 'Fora' : mode === 'latency' ? `${R.fmt(l.now.delay)} ms` : `${R.fmt(l.now.rate)} Mb/s`; const tEl = el.firstChild; if (tEl.textContent !== t) tEl.textContent = t; }
      el.setAttribute('aria-label', `Link ${l.a}–${l.b}: ${R.stateWord[st]}, capacidade ${R.fmt(l.now.rate)} Mb/s, tráfego ${R.fmt1(loads.get(l.id) || 0)} Mb/s, atraso ${R.fmt(l.now.delay)} ms. Enter para editar.`);
    });
    tickNumbers();
    if (hoverKey) drawDots();
  }
  // Numbers glide to their new value instead of jumping
  let numRaf = 0;
  function tickNumbers() {
    if (numRaf) return;
    numRaf = requestAnimationFrame(function step() {
      numRaf = 0;
      let busy = false;
      M.links.forEach(l => {
        const el = world.querySelector(`.pill[data-link="${l.id}"]`);
        if (!el || look.metric !== 'use' || l.now.down) return;
        const want = loads.get(l.id) || 0, cap = l.now.rate;
        let cur = shownVal.get(l.id);
        cur = cur === undefined ? want : cur + (want - cur) * (R.reduced.matches ? 1 : .14);
        if (Math.abs(want - cur) > .01) busy = true; else cur = want;
        shownVal.set(l.id, cur);
        const t = `${cur < 10 ? R.fmt1(cur) : R.fmt(cur)}<small> / ${R.fmt(cap)} Mb/s</small>`;
        if (el.firstChild.innerHTML !== t) el.firstChild.innerHTML = t;
        el.lastChild.firstChild.style.width = `${Math.min(100, cur / cap * 100).toFixed(1)}%`;
      });
      if (busy) tickNumbers();
    });
  }
  function updateLoads() { loads = R.linkLoad(); draw(); if (openKey?.startsWith('l:')) liveVals(); }

  // Small physical reactions: a link that changes state pulses, one that falls shakes, a new route lights up
  function react(d) {
    if (R.reduced.matches || R.page !== 'topologia') return;
    if (d.link) {
      const l = R.link(d.link), st = R.linkState(l), pill = world.querySelector(`.pill[data-link="${d.link}"]`), wire = els.get(`l:${d.link}`);
      pill?.animate(st === 'down' ? [{ transform: 'translateX(0)' }, { transform: 'translateX(-5px)' }, { transform: 'translateX(4px)' }, { transform: 'translateX(-2px)' }, { transform: 'none' }] : [{ transform: 'scale(1)' }, { transform: 'scale(1.22)' }, { transform: 'scale(1)' }], { duration: st === 'down' ? 420 : 560, easing: 'cubic-bezier(.32,.72,0,1)' });
      wire?.animate([{ strokeWidth: 7, opacity: .5 }, { strokeWidth: getComputedStyle(wire).strokeWidth, opacity: 1 }], { duration: 700, easing: 'ease-out' });
    }
    if (d.reroute) {
      const r = M.routes[d.reroute];
      if (!r?.path || R.pathBroken(r.path)) return;
      const e = document.createElementNS(NS, 'path');
      e.setAttribute('class', 'sweep'); e.setAttribute('d', routeD(r.path)); e.setAttribute('pathLength', '100');
      layers.flow.append(e);
      e.animate([{ strokeDashoffset: 30 }, { strokeDashoffset: -100 }], { duration: 1300, easing: 'cubic-bezier(.45,0,.2,1)' }).finished.then(() => e.remove());
    }
  }

  // The view that frames every node, leaving room for the title and the composer
  function fitView() {
    const W = stage.clientWidth, H = stage.clientHeight;
    if (!W || !H || !M.nodes.length) return view;
    const pts = M.nodes.map(n => target(n));
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    let x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    if (mapMode) {
      // Show the region around the network, not only its bounding box
      const minSpan = 420, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      if (x1 - x0 < minSpan) { x0 = cx - minSpan / 2; x1 = cx + minSpan / 2; }
      if (y1 - y0 < minSpan * .7) { y0 = cy - minSpan * .35; y1 = cy + minSpan * .35; }
    }
    const narrow = innerWidth < 900;
    const top = narrow ? 118 : 150, bottom = narrow ? 120 : 150, side = narrow ? 56 : 120;
    const aw = Math.max(80, W - side * 2), ah = Math.max(80, H - top - bottom);
    let s = Math.min(aw / Math.max(1, x1 - x0), ah / Math.max(1, y1 - y0), mapMode ? 2 : 1.15);
    const tx = side + (aw - (x1 - x0) * s) / 2 - x0 * s;
    if (!room) return { s, tx, ty: top + (ah - (y1 - y0) * s) / 2 - y0 * s };
    // With the review card open: shrink a little at most, and rise toward the title
    s = Math.min(s, Math.max(s * .85, (ah - room) / Math.max(1, y1 - y0)));
    return { s, tx: side + (aw - (x1 - x0) * s) / 2 - x0 * s, ty: Math.max(top - 30 - y0 * s, top + (ah - room - (y1 - y0) * s) / 2 - y0 * s) };
  }
  // The review card floats above the composer; the network moves up to stay clear of it
  let room = 0;
  function makeRoom(px) {
    const next = px && innerWidth >= 900 ? Math.max(0, px - 40) : 0;
    if (next === room) return;
    room = next;
    if (!moved) glide({ dur: 700 });
  }
  const toScreen = p => { const r = stage.getBoundingClientRect(), [x, y] = sc(p); return [r.left + x, r.top + y]; };

  // ------------------------------------------------------------ camera
  // glide(): one eased move of the camera and, when the layout changes, of the nodes; it always lands.
  let anim = null, landing = null;
  function glide({ positions = false, dur = 900 } = {}) {
    stop();
    const fromPos = new Map([...shown].map(([k, v]) => [k, [...v]]));
    const from = { ...view }, to = fitView();
    if (R.reduced.matches || document.hidden) dur = 0;
    const apply = k => {
      if (positions) M.nodes.forEach(n => { const a = fromPos.get(n.id) || target(n), b = target(n); shown.set(n.id, [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k]); });
      view = { s: from.s + (to.s - from.s) * k, tx: from.tx + (to.tx - from.tx) * k, ty: from.ty + (to.ty - from.ty) * k };
      paint();
    };
    if (!dur) { apply(1); return; }
    const t0 = performance.now(), ease = t => 1 - Math.pow(1 - t, 4);
    const step = now => { const t = Math.min(1, (now - t0) / dur); apply(ease(t)); if (t < 1) anim = requestAnimationFrame(step); };
    anim = requestAnimationFrame(step);
    landing = setTimeout(() => { cancelAnimationFrame(anim); apply(1); }, dur + 80);
  }
  const fit = (animate = true) => { moved = false; if (animate) glide(); else { stop(); view = fitView(); paint(); } };

  // Free movement: the camera eases toward a goal (zoom) or coasts with the pointer's speed (pan)
  let goal = null, vel = null, raf = 0, last = 0, idle;
  function stop() { cancelAnimationFrame(anim); clearTimeout(landing); goal = null; vel = null; }
  function run() { if (!raf) { last = performance.now(); raf = requestAnimationFrame(tick); } }
  function tick(now) {
    raf = 0;
    const dt = Math.min(48, now - last);
    last = now;
    let busy = false;
    if (goal) {
      const a = 1 - Math.exp(-dt / 70);
      view = { s: view.s + (goal.s - view.s) * a, tx: view.tx + (goal.tx - view.tx) * a, ty: view.ty + (goal.ty - view.ty) * a };
      if (Math.abs(goal.s - view.s) < goal.s * 1e-3 && Math.abs(goal.tx - view.tx) < .3 && Math.abs(goal.ty - view.ty) < .3) { view = goal; goal = null; } else busy = true;
    }
    if (vel) {
      view = { ...view, tx: view.tx + vel[0] * dt, ty: view.ty + vel[1] * dt };
      const f = Math.exp(-dt / 260);
      vel = [vel[0] * f, vel[1] * f];
      if (Math.hypot(vel[0], vel[1]) < .015) vel = null; else busy = true;
    }
    paint();
    if (busy) raf = requestAnimationFrame(tick);
  }
  function moving() {
    stage.classList.add('is-moving');
    clearTimeout(idle);
    idle = setTimeout(() => stage.classList.remove('is-moving'), 700);
  }
  const limits = () => { const f = fitView().s; return [f * .35, Math.max(f * 5, mapMode ? 8 : 2.4)]; };
  function zoomAt(k, cx, cy, animate = true) {
    const base = goal || view, [lo, hi] = limits();
    const s = Math.min(hi, Math.max(lo, base.s * k)), kk = s / base.s;
    const next = { s, tx: cx - (cx - base.tx) * kk, ty: cy - (cy - base.ty) * kk };
    moved = true; vel = null; moving();
    cancelAnimationFrame(anim); clearTimeout(landing);
    if (!animate || R.reduced.matches) { goal = null; view = next; paint(); return; }
    goal = next; run();
  }
  const center = () => [stage.clientWidth / 2, stage.clientHeight / 2];
  const local = e => { const r = stage.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const onCanvas = t => !t.closest('[data-node], .pill, .wire-hit, .zoom, .topo-head h1');

  const pointers = new Map();
  let pan = null, pinch = null;
  stage.addEventListener('pointerdown', e => {
    if (e.button !== 0 || !onCanvas(e.target)) return;
    if (e.isPrimary) pointers.clear(); // a new gesture: forget pointers that never reported their release
    pointers.set(e.pointerId, local(e));
    try { stage.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    stop();
    if (pointers.size === 2) {
      const [p, q] = [...pointers.values()];
      pinch = { d: Math.hypot(p[0] - q[0], p[1] - q[1]), c: [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2] };
      pan = null;
      return;
    }
    pan = { p: local(e), samples: [[performance.now(), ...local(e)]], moved: false };
  });
  stage.addEventListener('pointermove', e => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, local(e));
    if (pinch && pointers.size === 2) {
      const [p, q] = [...pointers.values()];
      const d = Math.hypot(p[0] - q[0], p[1] - q[1]), c = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
      view = { ...view, tx: view.tx + c[0] - pinch.c[0], ty: view.ty + c[1] - pinch.c[1] };
      zoomAt(d / pinch.d, c[0], c[1], false);
      pinch = { d, c };
      return;
    }
    if (!pan) return;
    const p = local(e), dx = p[0] - pan.p[0], dy = p[1] - pan.p[1];
    if (!pan.moved && Math.hypot(dx, dy) < 3) return;
    if (!pan.moved) { pan.moved = true; stage.classList.add('is-panning'); R.pop.close(true); }
    pan.p = p;
    pan.samples.push([performance.now(), ...p]);
    if (pan.samples.length > 6) pan.samples.shift();
    view = { ...view, tx: view.tx + dx, ty: view.ty + dy };
    moved = true; moving(); paint();
  });
  const endPan = e => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (!pan) return;
    stage.classList.remove('is-panning');
    const s = pan.samples, a = s[0], b = s.at(-1), dt = b[0] - a[0];
    if (pan.moved && dt > 0 && performance.now() - b[0] < 80 && !R.reduced.matches) { vel = [(b[1] - a[1]) / dt, (b[2] - a[2]) / dt]; if (Math.hypot(...vel) > .08) run(); else vel = null; }
    pan = null;
  };
  stage.addEventListener('pointerup', endPan);
  stage.addEventListener('pointercancel', endPan);
  stage.addEventListener('wheel', e => {
    e.preventDefault();
    const [x, y] = local(e), unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
    if (e.ctrlKey) { zoomAt(Math.exp(-e.deltaY * unit * .01), x, y, false); return; }
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) { stop(); view = { ...view, tx: view.tx - e.deltaX * unit }; moved = true; moving(); paint(); return; }
    zoomAt(Math.exp(-e.deltaY * unit * .0022), x, y);
  }, { passive: false });
  stage.addEventListener('dblclick', e => { if (onCanvas(e.target)) { const [x, y] = local(e); zoomAt(e.shiftKey ? 1 / 1.8 : 1.8, x, y); } });
  $('[data-zoom-bar]').addEventListener('click', e => {
    const b = e.target.closest('[data-zoom]');
    if (!b) return;
    const [x, y] = center();
    if (b.dataset.zoom === 'in') zoomAt(1.5, x, y);
    if (b.dataset.zoom === 'out') zoomAt(1 / 1.5, x, y);
    if (b.dataset.zoom === 'fit') fit();
  });
  document.addEventListener('keydown', e => {
    const a = document.activeElement;
    if (R.page !== 'topologia' || e.ctrlKey || e.metaKey || e.altKey || (a && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable)) || document.querySelector('dialog[open]')) return;
    const [x, y] = center();
    if (e.key === '+' || e.key === '=') zoomAt(1.4, x, y);
    else if (e.key === '-') zoomAt(1 / 1.4, x, y);
    else if (e.key === '0') fit();
  });

  function status() {
    const up = M.nodes.filter(n => !n.off).length, off = M.nodes.filter(n => n.off).length;
    const warn = M.links.filter(l => R.linkState(l) === 'warn').length, down = M.links.filter(l => R.linkState(l) === 'down').length;
    $('[data-net-status]').innerHTML = `<span class="status"><span class="dot"></span>${up} nós UP</span>${off ? `<span class="status down"><span class="dot down"></span>${off} desligado${off > 1 ? 's' : ''}</span>` : ''}${down ? `<span class="status down"><span class="dot down"></span>${down} link${down > 1 ? 's' : ''} fora</span>` : ''}${warn ? `<span class="status warn"><span class="dot warn"></span>${warn} link${warn > 1 ? 's' : ''} degradado${warn > 1 ? 's' : ''}</span>` : ''}`;
  }

  // ------------------------------------------------------------ opening: the network assembles from the server outwards
  function intro(delay = 0) {
    const start = R.hosts().find(h => h.role === 'Servidor') || M.nodes[0];
    if (!start || R.reduced.matches) return [];
    const adj = new Map(M.nodes.map(n => [n.id, []]));
    M.links.forEach(l => { adj.get(l.a)?.push(l.b); adj.get(l.b)?.push(l.a); });
    R.hosts().forEach(h => { adj.get(h.id)?.push(h.sw); adj.get(h.sw)?.push(h.id); });
    const depth = new Map([[start.id, 0]]), queue = [start.id];
    while (queue.length) { const id = queue.shift(); adj.get(id).forEach(nb => { if (!depth.has(nb)) { depth.set(nb, depth.get(id) + 1); queue.push(nb); } }); }
    const far = Math.max(...depth.values());
    M.nodes.forEach(n => { if (!depth.has(n.id)) depth.set(n.id, far + 1); });
    const dense = M.nodes.length > 14, step = dense ? 55 : 150;
    const spring = 'cubic-bezier(.32,.72,0,1)', out = [];
    const at = id => delay + depth.get(id) * step + (dense ? (hash(id) & 7) * 12 : 0);
    // The map settles first: states fade in from the network outwards, the ones in use glow once
    const mapEl = mapMode && world.querySelector('[data-map]');
    if (mapEl) {
      const cx = M.nodes.reduce((t, n) => t + pos(n.id)[0], 0) / M.nodes.length / MAPK, cy = M.nodes.reduce((t, n) => t + pos(n.id)[1], 0) / M.nodes.length / MAPK;
      const A = window.REIN_BR.anchors;
      mapEl.querySelectorAll('path').forEach((p, i) => {
        const uf = Object.keys(window.REIN_BR.states)[i], a = A[uf] || [cx, cy], dist = Math.hypot(a[0] - cx, a[1] - cy);
        out.push(p.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 700, delay: Math.max(0, delay - 500) + Math.min(900, dist * 1.4), easing: 'ease-out', fill: 'backwards' }));
        if (p.classList.contains('is-used')) out.push(p.animate([{ fill: 'rgba(0,113,227,.28)' }, { fill: 'rgba(0,113,227,.07)' }], { duration: 1400, delay: delay + 900, easing: 'ease-out', fill: 'backwards' }));
      });
    }
    M.nodes.forEach(n => {
      const e = world.querySelector(`[data-node="${n.id}"]`);
      if (!e) return;
      const d = at(n.id);
      out.push(e.animate([{ opacity: 0, transform: 'scale(.35)' }, { opacity: 1, transform: 'scale(1.08)', offset: .6 }, { opacity: 1, transform: 'scale(1)' }], { duration: 760, delay: d, easing: spring, fill: 'backwards' }));
      const lab = $('.n-label', e);
      if (lab) out.push(lab.animate([{ opacity: 0, transform: 'translateY(-5px)' }, { opacity: 1, transform: 'none' }], { duration: 520, delay: d + 260, easing: 'ease-out', fill: 'backwards' }));
    });
    const drawIn = (e, a, b) => {
      const da = at(a), db = at(b), d = Math.min(da, db) + step * .35, len = e.getTotalLength();
      if (getComputedStyle(e).strokeDasharray !== 'none') { out.push(e.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 600, delay: d + 80, fill: 'backwards' })); return; }
      const from = da <= db ? len : -len;
      out.push(e.animate([{ strokeDasharray: `${len} ${len}`, strokeDashoffset: from }, { strokeDasharray: `${len} ${len}`, strokeDashoffset: 0 }], { duration: dense ? 420 : 620, delay: d, easing: 'cubic-bezier(.65,0,.35,1)', fill: 'backwards' }));
    };
    M.links.forEach(l => { const e = els.get(`l:${l.id}`); if (e) drawIn(e, l.a, l.b); const p = world.querySelector(`.pill[data-link="${l.id}"]`); if (p) out.push(p.animate([{ opacity: 0, transform: 'scale(.8)' }, { opacity: 1, transform: 'none' }], { duration: 420, delay: Math.max(at(l.a), at(l.b)) + 200, easing: spring, fill: 'backwards' })); });
    R.hosts().forEach(h => { const e = els.get(`a:${h.id}`); if (e) drawIn(e, h.sw, h.id); });
    const end = delay + (far + 1) * step + 700;
    stage.classList.remove('is-live');
    const live = setTimeout(() => stage.classList.add('is-live'), end);
    out.push({ finish: () => { clearTimeout(live); stage.classList.add('is-live'); }, cancel() {}, finished: new Promise(r => setTimeout(r, end)) });
    return out;
  }

  // ------------------------------------------------------------ dragging (nodes follow the pointer; a spring settles them)
  let drag = null;
  world.addEventListener('pointerdown', e => {
    const el = e.target.closest('[data-node]');
    if (!el || e.button !== 0) return;
    const n = R.node(el.dataset.node);
    stop();
    if (mapMode && n.kind === 'switch') { drag = { el, n, still: true, pinned: true, x: e.clientX, y: e.clientY }; return; }
    drag = { el, n, x: e.clientX, y: e.clientY, still: true, start: [...pos(n.id)] };
    el.setPointerCapture(e.pointerId);
  });
  world.addEventListener('pointermove', e => {
    if (!drag || drag.pinned) return;
    const dx = (e.clientX - drag.x) / view.s, dy = (e.clientY - drag.y) / view.s;
    if (drag.still && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 4) return;
    if (drag.still) { drag.still = false; drag.el.classList.add('is-dragging'); R.pop.close(true); openKey = null; }
    const p = [drag.start[0] + dx, drag.start[1] + dy];
    shown.set(drag.n.id, p);
    if (mapMode) mapPos.set(drag.n.id, p); else { drag.n.x = p[0]; drag.n.y = p[1]; }
    draw();
  });
  const endDrag = () => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.still) { openNode(d.n.id); return; }
    d.el.classList.remove('is-dragging');
    if (!R.reduced.matches) d.el.animate([{ transform: 'scale(1.1)' }, { transform: 'scale(.97)', offset: .55 }, { transform: 'scale(1)' }], { duration: 520, easing: 'cubic-bezier(.32,.72,0,1)' });
    if (!mapMode) R.save();
  };
  world.addEventListener('pointerup', endDrag);
  world.addEventListener('pointercancel', endDrag);
  world.addEventListener('keydown', e => {
    const el = e.target.closest('[data-node]');
    if (!el) return;
    const n = R.node(el.dataset.node);
    const step = e.shiftKey ? 40 : 12, k = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (k && !mapMode) { e.preventDefault(); n.x += k[0]; n.y += k[1]; shown.set(n.id, [n.x, n.y]); draw(); R.save(); }
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openNode(n.id); }
  });

  // ------------------------------------------------------------ link popover
  const popLink = $('[data-pop="link"]');
  let draft = null;
  const sliders = { rate: [0.1, 100, 0.1, 'Mb/s', 'Capacidade'], delay: [0, 500, 1, 'ms', 'Atraso'], jitter: [0, 100, 1, 'ms', 'Jitter'], loss: [0, 20, 0.5, '%', 'Perda'] };
  function openLink(id) {
    const l = R.link(id);
    draft = { ...l.now };
    openKey = `l:${id}`;
    const maxRate = Math.max(100, l.base.rate * 1.2);
    popLink.innerHTML = `
      <div class="pop-head"><div><h2>${l.a}–${l.b}</h2><p class="pop-sub" data-lp-sub></p></div><button class="close" type="button" data-close aria-label="Fechar">${R.icon('i-x')}</button></div>
      <div class="seg" role="group" aria-label="Estado do link">
        <button type="button" data-quick="normal">Normal</button><button type="button" data-quick="degraded" data-tone="warn">Degradado</button><button type="button" data-quick="down" data-tone="down">Fora</button>
      </div>
      <div class="vals"><div><span class="l">Capacidade</span><span class="v"><output data-o="rate"></output><small>Mb/s</small></span></div><div><span class="l">Tráfego</span><span class="v"><output data-o="load"></output><small>Mb/s</small></span><i class="util"><b data-o="util"></b></i></div><div><span class="l">Atraso</span><span class="v"><output data-o="delay"></output><small>ms</small></span></div></div>
      <div class="sliders">
        ${Object.entries(sliders).map(([k, [min, max, step, unit, label]]) => `<label class="slider-row"><span>${label}</span><input type="range" min="${min}" max="${k === 'rate' ? maxRate : max}" step="${step}" data-k="${k}"><span class="sv"><output data-o2="${k}"></output> ${unit}</span></label>`).join('')}
      </div>
      <label class="slider-row" style="margin-bottom:14px"><span>Preset</span><select class="popup" data-preset style="grid-column: 2 / 4"><option value="">Personalizado</option>${Object.entries(R.presets).map(([k, [label]]) => `<option value="${k}">${label}</option>`).join('')}</select></label>
      <p class="pop-note">Base ${R.fmt(l.base.rate)} Mb/s, ${R.fmt(l.base.delay)} ms. Interfaces ${l.a}${l.b} e ${l.b}${l.a}.</p>
      <div class="pop-actions"><button class="btn" type="button" data-restore>Restaurar</button><button class="btn btn-blue" type="button" data-apply>Aplicar</button></div>`;
    sync();
    const c = curve(l.a, l.b, l.id), [x, y] = toScreen(c.mid);
    R.pop.open(popLink, x, y, { prefer: y > innerHeight * .55 ? 'above' : 'below', trigger: $(`.pill[data-link="${id}"]`, world), key: openKey, onClose: () => { openKey = null; draw(); } });
    draw();
  }
  function sync() {
    const l = R.link(openKey.slice(2)), st = R.linkState(l, draft);
    popLink.dataset.state = st;
    $('[data-lp-sub]', popLink).innerHTML = `<span class="dot ${st === 'ok' ? '' : st}"></span>${R.stateWord[st]}`;
    $('[data-o="rate"]', popLink).textContent = draft.down ? '0' : R.fmt(draft.rate);
    $('[data-o="delay"]', popLink).textContent = draft.down ? '–' : R.fmt(draft.delay);
    $$('[data-k]', popLink).forEach(inp => { inp.value = draft[inp.dataset.k]; inp.disabled = draft.down; R.paintRange(inp); });
    $$('[data-o2]', popLink).forEach(o => { o.textContent = R.fmt(draft[o.dataset.o2]); });
    liveVals();
    const cur = R.linkState(l);
    $$('[data-quick]', popLink).forEach(b => b.setAttribute('aria-pressed', String({ normal: 'ok', degraded: 'warn', down: 'down' }[b.dataset.quick] === cur)));
  }
  function liveVals() {
    const o = $('[data-o="load"]', popLink);
    if (!o || !openKey?.startsWith('l:')) return;
    const l = R.link(openKey.slice(2)), load = loads.get(l.id) || 0, cap = l.now.down ? 0 : l.now.rate;
    o.textContent = R.fmt1(load);
    $('[data-o="util"]', popLink).style.width = `${cap ? Math.min(100, load / cap * 100) : 0}%`;
  }
  popLink.addEventListener('input', e => { const inp = e.target.closest('[data-k]'); if (!inp) return; draft[inp.dataset.k] = +inp.value; $('[data-preset]', popLink).value = ''; sync(); });
  popLink.addEventListener('change', e => { const s = e.target.closest('[data-preset]'); if (s?.value) { draft = R.presets[s.value][1](R.link(openKey.slice(2)).base); sync(); } });
  popLink.addEventListener('click', e => {
    if (e.target.closest('[data-close]')) { R.pop.close(); return; }
    const id = openKey?.slice(2);
    if (!id) return;
    const l = R.link(id);
    const q = e.target.closest('[data-quick]');
    // Changes go through tc on both ends of the veth pair, visibly
    const commit = (v, label) => {
      const cmd = (ns, dev) => v.down ? `sudo ip -n ${ns} link set ${dev} down` : `sudo ip netns exec ${ns} tc qdisc change dev ${dev} parent 1:1 netem delay ${R.fmt(v.delay)}ms ${R.fmt(v.jitter || 0)}ms${v.loss ? ` loss ${v.loss}%` : ''} && sudo ip netns exec ${ns} tc qdisc change dev ${dev} root tbf rate ${R.rateStr(v.rate)} burst 32kbit latency 400ms`;
      R.job({ title: `${label} ${l.a}–${l.b}`, steps: [[`${l.a}${l.b} em ${l.a}`, cmd(l.a, `${l.a}${l.b}`), 280], [`${l.b}${l.a} em ${l.b}`, cmd(l.b, `${l.b}${l.a}`), 280]] }).then(() => { R.apply(id, v); sync(); R.toast('', `PUT /api/testbed/links/${id}`); });
    };
    if (q) { draft = R.presets[q.dataset.quick][1](l.base); commit(draft, q.textContent.trim()); sync(); return; }
    if (e.target.closest('[data-apply]')) commit(draft, 'Aplicando');
    if (e.target.closest('[data-restore]')) { draft = { ...l.base, down: false }; commit(draft, 'Restaurando'); }
  });

  // ------------------------------------------------------------ node popover: summary, interfaces, CLI
  const popNode = $('[data-pop="node"]');
  let unmountVideo = null, nodeTab = 'sum', swConfirm = null;
  const kvRows = rows => `<dl class="kv">${rows.filter(Boolean).map(([k, v, mono]) => `<div><dt>${k}</dt><dd${mono ? ' class="mono"' : ''}>${v}</dd></div>`).join('')}</dl>`;
  function nodeBody(n) {
    const tabs = `<div class="seg ptabs" role="tablist" aria-label="Seções">${[['sum', 'Resumo'], ['if', 'Interfaces'], ['cli', 'CLI']].map(([k, t]) => `<button type="button" role="tab" data-ntab="${k}" aria-pressed="${nodeTab === k}">${t}</button>`).join('')}</div>`;
    const ifs = R.ifaces(n.id);
    const ifList = `<div class="iflist">${ifs.map(i => { const l = i.link ? R.link(i.link) : null; const ld = l ? loads.get(l.id) || 0 : 0; return `<button type="button" class="ifrow" data-open-if="${i.name}"><span class="ifname mono">${i.name}</span><span class="ifpeer">par ${i.peer} em ${i.peerNode}</span><span class="ifq">${R.esc(R.ifaceQdisc(i))}</span>${l ? `<span class="ifload">${R.fmt1(ld)} Mb/s</span>` : ''}${R.icon('i-chevron-right', 'chev')}</button>`; }).join('') || '<p class="pop-note">Sem interfaces.</p>'}</div>`;
    const cli = `${R.cliList(R.nodeCli(n.id))}<p class="pop-note">Os namespaces ficam em /var/run/netns/${n.id}; o LFT cria o link ao instanciar o container.</p>`;
    let sum;
    if (n.kind === 'switch') {
      const hs = R.hosts().filter(h => h.sw === n.id).map(h => h.id);
      sum = kvRows([['Container', `${n.id} · Open vSwitch`, true], ['Datapath', n.dpid, true], ['dp-desc', R.esc(n.uf || '–')], ['Controlador', `${R.env.onos.controller} · OpenFlow 1.3`, true], ['Portas', `${ifs.length}, ${ifs.map(i => i.name).join(', ')}`, true], ['Hosts', hs.join(', ') || 'nenhum']])
        + (swConfirm === n.id
          ? `<div class="pop-confirm" role="alertdialog" aria-label="Confirmar remoção"><p><b>Remover ${n.id}?</b> O container e ${((k) => `${k} link${k === 1 ? '' : 's'}`)(M.links.filter(l => l.a === n.id || l.b === n.id).length)} deixam de existir${hs.length ? `; ${hs.join(', ')} ${hs.length > 1 ? 'saem' : 'sai'} junto` : ''}.</p><div><button class="btn" type="button" data-act="sw-cancel">Cancelar</button><button class="btn btn-destroy" type="button" data-act="sw-remove-yes">Remover</button></div></div>`
          : `<div class="pop-actions"><button class="btn btn-danger" type="button" data-act="sw-remove">Remover</button><button class="btn" type="button" data-act="sw-power">${n.off ? 'Ligar' : 'Desligar'}</button><button class="btn btn-blue" type="button" data-act="add-here"${n.off ? ' disabled' : ''}>Adicionar host aqui</button></div>`);
    } else {
      const route = R.routeOf(n.id)?.[1] || Object.values(M.routes).find(r => r.server === n.id);
      const video = R.hasVideo(n), q = video ? R.qoe(n.id) : null, i = ifs[0];
      const sess = R.traffic.sessions.filter(x => x.status === 'running' && (x.client === n.id || x.server === n.id));
      sum = `${video ? `<div class="video-box"><canvas data-canvas aria-label="Vídeo que ${n.id} está recebendo"></canvas></div>` : ''}`
        + kvRows([['Container', `${n.id} · ${R.esc(n.image)}`, true], ['Interface', i ? `${i.name} ↔ ${i.peer}` : '–', true], ['Endereço', `${n.ip}/24 · ${i?.mac || ''}`, true], ['Switch', n.sw], route?.path && ['Caminho', route.path.slice(1, -1).join(', ')], q && ['Vídeo', `${q.stalled ? 'parado' : q.res}, ${R.fmt1(q.thr)} Mb/s`], sess.length && ['Tráfego', sess.map(x => `${x.tool} ${R.fmt1(x.rateNow)} Mb/s`).join(', ')]])
        + `<div class="pop-actions"><button class="btn btn-danger" type="button" data-act="remove">Remover</button><button class="btn" type="button" data-act="edit">Editar</button><button class="btn" type="button" data-act="traffic-here">Tráfego</button>${video ? '<button class="btn btn-blue" type="button" data-act="watch">Vídeo</button>' : ''}</div>`;
    }
    const sub = n.kind === 'switch' ? `${n.off ? 'DESLIGADO' : 'UP'} · ${R.esc(n.pop || 'switch')}` : `${n.role} · ${n.ip}`;
    return `<div class="pop-head"><div><h2>${n.id}</h2><p class="pop-sub"><span class="dot${n.off ? ' down' : ''}"></span>${sub}</p></div><button class="close" type="button" data-close aria-label="Fechar">${R.icon('i-x')}</button></div>${tabs}<div class="ptab-body">${nodeTab === 'sum' ? sum : nodeTab === 'if' ? ifList : cli}</div>`;
  }
  function openNode(id, keepTab = false) {
    const n = R.node(id);
    if (!n) return;
    if (!keepTab) nodeTab = 'sum';
    if (swConfirm !== id) swConfirm = null;
    openKey = `n:${id}`;
    unmountVideo?.(); unmountVideo = null;
    popNode.innerHTML = nodeBody(n);
    popNode.classList.add('pop-node');
    const cv = $('[data-canvas]', popNode);
    if (cv) unmountVideo = R.video.mount(cv, id);
    const [x, y] = toScreen(pos(id));
    const prefer = y > innerHeight * .55 ? 'above' : 'below';
    R.pop.open(popNode, x, prefer === 'above' ? y - 40 : y + 40, { prefer, trigger: $(`[data-node="${id}"]`, world), key: openKey, onClose: () => { openKey = null; unmountVideo?.(); unmountVideo = null; $$('.node.is-open', world).forEach(el => el.classList.remove('is-open')); } });
    $$('.node', world).forEach(el => el.classList.toggle('is-open', el.dataset.node === id));
  }
  popNode.addEventListener('click', e => {
    if (e.target.closest('[data-close]')) { R.pop.close(); return; }
    const id = openKey?.slice(2);
    if (!id) return;
    const tab = e.target.closest('[data-ntab]');
    if (tab) { nodeTab = tab.dataset.ntab; unmountVideo?.(); unmountVideo = null; popNode.innerHTML = nodeBody(R.node(id)); const cv = $('[data-canvas]', popNode); if (cv) unmountVideo = R.video.mount(cv, id); return; }
    const oi = e.target.closest('[data-open-if]');
    if (oi) { const r = oi.getBoundingClientRect(); R.pop.close(true); openIface(oi.dataset.openIf, r.left + r.width / 2, r.top); return; }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'add-here') { R.pop.close(true); openHostSheet(null, id); }
    if (act === 'edit') { R.pop.close(true); openHostSheet(id); }
    if (act === 'watch') { R.pop.close(true); R.openVideo(id); }
    if (act === 'traffic-here') { R.pop.close(true); openTraffic(id); }
    const sw = R.node(id);
    if (act === 'sw-remove') { swConfirm = id; popNode.innerHTML = nodeBody(sw); $('[data-act="sw-cancel"]', popNode)?.focus(); return; }
    if (act === 'sw-cancel') { swConfirm = null; popNode.innerHTML = nodeBody(sw); return; }
    if (act === 'sw-remove-yes') {
      swConfirm = null;
      R.pop.close(true);
      const hs = R.hosts().filter(h => h.sw === id).map(h => h.id);
      R.job({ title: `Removendo ${id}`, nodes: [id, ...hs], steps: [[`Removendo o container ${id}${hs.length ? ` e ${hs.join(', ')}` : ''}`, `sudo docker rm -f ${[id, ...hs].join(' ')}`, 800], ['Os pares veth somem com os namespaces', `sudo ip -br link | grep -cE '${id}s[0-9]+|s[0-9]+${id}'`, 400], ['O ONOS esquece o device', `curl -s -u onos:rocks -X DELETE ${R.env.onos.rest}/devices/${sw.dpid}`, 500]] })
        .then(() => { R.removeSwitch(id); R.toast('', `DELETE /api/testbed/switches/${id}`); });
    }
    if (act === 'sw-power') {
      R.pop.close(true);
      const ls = M.links.filter(l => l.a === id || l.b === id), far = l => (l.a === id ? l.b : l.a), hs = R.hosts().filter(h => h.sw === id);
      if (!sw.off) {
        R.job({ title: `Desligando ${id}`, nodes: [id], steps: [[`Parando o container ${id}`, `sudo docker stop ${id}`, 800], [`${ls.length} links caem com o namespace`, ls.map(l => `${far(l)}${id}`).join(', ') + ' somem nos vizinhos', 400], ['O ONOS marca o device como indisponível', `curl -s -u onos:rocks ${R.env.onos.rest}/devices/${sw.dpid} | jq .available`, 500]] })
          .then(() => { R.setSwitchPower(id, false); R.toast('', `POST /api/testbed/switches/${id}/stop`); });
      } else {
        R.job({ title: `Ligando ${id}`, nodes: [id], steps: [[`Iniciando o container ${id}`, `sudo docker start ${id}`, 700], ['Refazendo os pares veth', ls.map(l => `ip link add ${id}${far(l)} type veth peer name ${far(l)}${id}`).join('; ') || 'nenhum link', 700], ['Filas tc em cada ponta', ls.map(l => `tc qdisc add dev ${id}${far(l)} root netem delay ${R.fmt(l.base.delay)}ms rate ${R.rateStr(l.base.rate)}`).join('; ') || '-', 500], hs.length ? ['Religando os hosts', hs.map(h => `ip link add ${h.id}${id} type veth peer name ${id}${h.id}`).join('; '), 500] : null, ['Controlador', `docker exec ${id} ovs-vsctl set-controller ${id} ${R.env.onos.controller}`, 500]].filter(Boolean) })
          .then(() => { R.setSwitchPower(id, true); R.toast('', `POST /api/testbed/switches/${id}/start`); });
      }
    }
    if (act === 'remove') {
      R.pop.close(true);
      R.job({ title: `Removendo ${id}`, nodes: [id], steps: [[`Parando o container ${id}`, `sudo docker rm -f ${id}`, 700], ['Removendo o par veth', `sudo ip link del ${R.ifaces(id)[0]?.peer || id}`, 400]] }).then(() => { R.removeHost(id); R.toast('', `DELETE /api/testbed/hosts/${id}`); });
    }
  });

  // ------------------------------------------------------------ interfaces: a dot at each veth end
  let hoverKey = null, hoverTimer = null;
  const bez = (c, t) => { const u = 1 - t; return [0, 1].map(k => u * u * u * c.a[k] + 3 * u * u * t * c.c1[k] + 3 * u * t * t * c.c2[k] + t * t * t * c.b[k]); };
  function ifPoints() {
    if (!hoverKey) return [];
    const kind = hoverKey[0], id = hoverKey.slice(2), out = [];
    const radius = nid => { const el = world.querySelector(`[data-node="${nid}"]`); return (el ? el.offsetWidth / 2 : 26) + 12; };
    const at = (c, fromA, r) => { const a = sc(fromA ? c.a : c.b); for (let k = 1; k <= 48; k++) { const p = sc(bez(c, fromA ? k / 48 : 1 - k / 48)); if (Math.hypot(p[0] - a[0], p[1] - a[1]) >= r) return p; } return sc(bez(c, .5)); };
    const add = (i, c, fromA) => out.push({ i, p: at(c, fromA, radius(i.node)) });
    const ofNode = nid => R.ifaces(nid).forEach(i => {
      if (i.link) { const l = R.link(i.link); add(i, curve(l.a, l.b, l.id), l.a === nid); return; }
      const h = R.node(nid).kind === 'host' ? R.node(nid) : R.node(i.peerNode);
      if (h && R.node(h.sw)) add(i, curve(h.sw, h.id, h.id, true), i.node === h.sw);
    });
    if (kind === 'n' && R.node(id)) ofNode(id);
    if (kind === 'l' && R.link(id)) { const l = R.link(id), c = curve(l.a, l.b, l.id); R.ifaces(l.a).filter(i => i.link === id).forEach(i => add(i, c, true)); R.ifaces(l.b).filter(i => i.link === id).forEach(i => add(i, c, false)); }
    return out;
  }
  function drawDots() {
    let box = world.querySelector('[data-ifdots]');
    if (!box) { box = document.createElement('div'); box.className = 'ifdots'; box.dataset.ifdots = ''; world.append(box); }
    const pts = drag || pan ? [] : ifPoints(), keep = new Set();
    pts.forEach(({ i, p }) => {
      keep.add(i.name);
      let d = box.querySelector(`[data-if="${i.name}"]`);
      if (!d) { d = document.createElement('button'); d.type = 'button'; d.className = 'ifdot'; d.dataset.if = i.name; d.dataset.keepPop = ''; d.setAttribute('aria-label', `Interface ${i.name} em ${i.node}. Clique para ver como capturar o tráfego.`); d.innerHTML = `<span>${i.name}</span>`; box.append(d); }
      d.style.left = `${p[0]}px`; d.style.top = `${p[1]}px`;
    });
    [...box.children].forEach(d => { if (!keep.has(d.dataset.if)) { d.classList.add('is-leaving'); setTimeout(() => d.remove(), 180); } });
  }
  function setHover(k) { clearTimeout(hoverTimer); if (hoverKey !== k) { hoverKey = k; drawDots(); } }
  function dropHover() { clearTimeout(hoverTimer); hoverTimer = setTimeout(() => { hoverKey = null; drawDots(); }, 900); }
  world.addEventListener('pointerover', e => {
    if (e.target.closest('.ifdot')) { clearTimeout(hoverTimer); return; }
    const n = e.target.closest('[data-node]'), l = e.target.closest('.wire-hit, .pill');
    if (n) setHover(`n:${n.dataset.node}`); else if (l) setHover(`l:${l.dataset.link}`);
  });
  world.addEventListener('pointerout', e => { if (e.target.closest('[data-node], .wire-hit, .pill, .ifdot') && !e.relatedTarget?.closest?.('.ifdot, [data-node], .wire-hit, .pill')) dropHover(); });

  const popIf = $('[data-pop="iface"]');
  let ifTab = 'tcpdump', ifOpen = null;
  function ifBody(name) {
    const i = R.iface(name);
    if (!i) return '';
    const l = i.link ? R.link(i.link) : null, ld = l ? loads.get(l.id) || 0 : 0;
    const client = R.hosts().find(h => h.role === 'Cliente');
    const cmds = R.ifaceCmds(i, client?.ip || '');
    const labels = { tcpdump: 'tcpdump', tshark: 'tshark', pcap: 'Wireshark', tc: 'tc', ip: 'ip' };
    const notes = { tcpdump: 'Pacotes em tempo real, sem gravar. Ctrl+C encerra.', tshark: `Campos por pacote, filtrados para ${client?.ip || 'um host'}.`, pcap: 'Captura crua pelo docker exec e abre direto no Wireshark local.', tc: 'Filas e contadores: tbf limita a banda, netem aplica atraso, jitter e perda.', ip: 'Estado, MAC e contadores de bytes e pacotes da interface.' };
    return `<div class="pop-head"><div><h2 class="mono">${i.name}</h2><p class="pop-sub"><span class="dot${l?.now.down ? ' down' : ''}"></span>veth em ${i.node} · par ${i.peer} em ${i.peerNode}</p></div><button class="close" type="button" data-close aria-label="Fechar">${R.icon('i-x')}</button></div>
      ${kvRows([['MAC', i.mac, true], i.ip && ['Endereço', i.ip, true], ['Fila', R.esc(R.ifaceQdisc(i))], l && ['Tráfego agora', `${R.fmt1(ld)} Mb/s de ${R.fmt(l.now.rate)} Mb/s`], ['Namespace', `/var/run/netns/${i.node}`, true]])}
      <div class="seg ptabs" role="tablist" aria-label="Ferramenta">${Object.entries(labels).map(([k, t]) => `<button type="button" role="tab" data-iftab="${k}" aria-pressed="${ifTab === k}">${t}</button>`).join('')}</div>
      <div class="cmdbox"><code>${R.esc(cmds[ifTab])}</code><button type="button" class="ico" data-copy-text="${R.esc(cmds[ifTab])}" aria-label="Copiar comando">${R.icon('i-copy')}</button></div>
      <p class="pop-note">${notes[ifTab]}</p>`;
  }
  function openIface(name, x, y) {
    ifOpen = name;
    popIf.innerHTML = ifBody(name);
    R.pop.open(popIf, x, y, { prefer: y > innerHeight * .55 ? 'above' : 'below', key: `if:${name}`, onClose: () => { ifOpen = null; } });
  }
  world.addEventListener('click', e => { const d = e.target.closest('.ifdot'); if (d) { e.stopPropagation(); const r = d.getBoundingClientRect(); openIface(d.dataset.if, r.left + r.width / 2, r.top + r.height / 2); } }, true);
  popIf.addEventListener('click', e => {
    if (e.target.closest('[data-close]')) { R.pop.close(); return; }
    const t = e.target.closest('[data-iftab]');
    if (t && ifOpen) { ifTab = t.dataset.iftab; popIf.innerHTML = ifBody(ifOpen); }
  });

  world.addEventListener('click', e => {
    const l = e.target.closest('[data-link]');
    if (l) { openKey === `l:${l.dataset.link}` ? R.pop.close() : openLink(l.dataset.link); }
  });
  // Hovering a wire lights its pill, and the other way round
  world.addEventListener('pointerover', e => {
    const t = e.target.closest('.wire-hit, .pill');
    if (!t) return;
    const id = t.dataset.link;
    els.get(`l:${id}`)?.classList.add('is-hover');
    world.querySelector(`.pill[data-link="${id}"]`)?.classList.add('is-hover');
    t.addEventListener('pointerleave', () => { els.get(`l:${id}`)?.classList.remove('is-hover'); world.querySelector(`.pill[data-link="${id}"]`)?.classList.remove('is-hover'); }, { once: true });
  });
  // Nodes that are still being brought up show it
  R.on((type, d) => { if (type === 'provision') world.querySelector(`[data-node="${d.id}"]`)?.classList.toggle('is-provisioning', d.on); });

  // ------------------------------------------------------------ host sheet (create and edit)
  const sheet = $('[data-sheet="host"]'), form = $('[data-host-form]');
  const hostCli = () => {
    const f = form.elements, img = f.image.value === '__other' ? (f.custom.value.trim() || 'ubuntu:22.04') : f.image.value, id = f.name.value.trim() || 'cl?', sw = f.sw.value;
    return [`docker run -d --name=${id} --network=none --cap-add=NET_ADMIN --entrypoint sleep ${img} infinity`, `ip link add ${id}${sw} type veth peer name ${sw}${id}`, `ip link set ${id}${sw} netns ${id}; ip link set ${sw}${id} netns ${sw}`, `ip -n ${id} addr add ${f.ip.value.trim() || '192.168.0.x'}/24 dev ${id}${sw}`, `docker exec ${sw} ovs-vsctl add-port ${sw} ${sw}${id}`, `# no REPL do LFT: create ${f.role.value === 'Servidor' ? 'server' : 'host'} ${id} ${f.ip.value.trim()} · connect ${id} ${sw}`];
  };
  const paintHostCli = () => { $('[data-host-cli]').textContent = hostCli().map(c => (c.startsWith('#') ? c : `$ ${c}`)).join('\n'); };
  function openHostSheet(id = null, sw = null) {
    const n = id ? R.node(id) : null;
    form.dataset.edit = id || '';
    $('[data-host-title]').textContent = n ? `Editar ${n.id}` : 'Adicionar host';
    $('[data-host-remove]').hidden = !n;
    form.querySelector('[type="submit"]').textContent = n ? 'Aplicar' : 'Criar host';
    const f = form.elements;
    f.sw.innerHTML = R.switches().map(s => `<option value="${s.id}">${s.id}${s.uf ? ` · ${s.uf}` : ''}</option>`).join('');
    const role = n?.role || 'Cliente';
    $$('[data-role]', form).forEach(b => b.setAttribute('aria-pressed', String(b.dataset.role === role)));
    f.role.value = role;
    f.name.value = n?.id || R.nextName(role);
    f.sw.value = n?.sw || sw || R.switches().at(-1)?.id;
    f.ip.value = n?.ip || R.nextIp();
    const known = [...f.image.options].some(o => o.value === n?.image);
    f.image.value = n ? (known ? n.image : '__other') : (role === 'Servidor' ? 'rein-dash-video' : 'rein-dash-client');
    f.custom.value = known ? '' : (n?.image || '');
    $('[data-custom-image]').hidden = f.image.value !== '__other';
    hint(); paintHostCli();
    sheet.showModal();
  }
  R.openHostSheet = openHostSheet;
  const hint = () => { const img = form.elements.image.value; $('[data-image-hint]').textContent = img === 'lft-iperf:latest' ? 'Imagem iperf3 do LFT (docker/iperf)' : R.IMAGES.find(([k]) => k === img)?.[1] || 'Qualquer imagem presente em docker images.'; };
  form.addEventListener('input', paintHostCli);
  form.addEventListener('click', e => {
    const b = e.target.closest('[data-role]');
    if (b) {
      $$('[data-role]', form).forEach(x => x.setAttribute('aria-pressed', String(x === b)));
      form.elements.role.value = b.dataset.role;
      if (!form.dataset.edit) { form.elements.name.value = R.nextName(b.dataset.role); form.elements.image.value = b.dataset.role === 'Servidor' ? 'rein-dash-video' : 'rein-dash-client'; hint(); }
      paintHostCli();
    }
    if (e.target.closest('[data-host-remove]')) { const id = form.dataset.edit; sheet.close(); R.job({ title: `Removendo ${id}`, nodes: [id], steps: [[`Parando o container ${id}`, `sudo docker rm -f ${id}`, 700]] }).then(() => R.removeHost(id)); }
    if (e.target.closest('[data-close-sheet]')) sheet.close();
  });
  form.elements.image.addEventListener('change', () => { $('[data-custom-image]').hidden = form.elements.image.value !== '__other'; hint(); paintHostCli(); });
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const f = form.elements, id = f.name.value.trim(), edit = form.dataset.edit;
    if (R.node(id) && id !== edit) { f.name.setCustomValidity('Esse nome já existe na topologia.'); f.name.reportValidity(); f.name.setCustomValidity(''); return; }
    if (!form.reportValidity()) return;
    const image = f.image.value === '__other' ? (f.custom.value.trim() || 'ubuntu:22.04') : f.image.value;
    const data = { id, role: f.role.value, sw: f.sw.value, ip: f.ip.value.trim() || R.nextIp(), image };
    const steps = hostCli().filter(c => !c.startsWith('#')).map((c, k) => [['Criando o container', 'Criando o par veth', 'Movendo as pontas para os namespaces', 'Endereçando a interface', 'Porta no Open vSwitch'][k], c, [1300, 500, 500, 400, 600][k]]);
    sheet.close();
    if (edit) { await R.job({ title: `Atualizando ${edit}`, nodes: [edit], steps: [[`Recriando ${edit}`, `sudo docker rm -f ${edit}`, 600], ...steps] }); R.updateHost(edit, data); R.toast('', `PUT /api/testbed/hosts/${edit}`); return; }
    const n = R.addHost({ ...data, pending: true });
    requestAnimationFrame(() => world.querySelector(`[data-node="${n.id}"]`)?.classList.add('is-provisioning'));
    await R.job({ title: `Criando ${id}`, nodes: [id], steps: [...steps, ['Esperando o ONOS ver o host (ARP)', `curl -s ${R.env.onos.rest}/hosts | jq '.hosts[] | select(.ipAddresses[]=="${data.ip}")'`, 1100]], doneText: `${id} disponível em ${data.sw}` });
    delete n.pending; R.save(); render(); draw();
    R.toast('', 'POST /api/testbed/hosts');
  });
  sheet.addEventListener('click', e => { if (e.target === sheet) sheet.close(); });

  // ------------------------------------------------------------ switch sheet
  const swSheet = $('[data-sheet="switch"]'), swForm = $('[data-switch-form]');
  const UFS = [['AC', 'Acre'], ['AL', 'Alagoas'], ['AM', 'Amazonas'], ['AP', 'Amapá'], ['BA', 'Bahia'], ['CE', 'Ceará'], ['DF', 'Distrito Federal'], ['ES', 'Espírito Santo'], ['GO', 'Goiás'], ['MA', 'Maranhão'], ['MG', 'Minas Gerais'], ['MS', 'Mato Grosso do Sul'], ['MT', 'Mato Grosso'], ['PA', 'Pará'], ['PB', 'Paraíba'], ['PE', 'Pernambuco'], ['PI', 'Piauí'], ['PR', 'Paraná'], ['RJ', 'Rio de Janeiro'], ['RN', 'Rio Grande do Norte'], ['RO', 'Rondônia'], ['RR', 'Roraima'], ['RS', 'Rio Grande do Sul'], ['SC', 'Santa Catarina'], ['SE', 'Sergipe'], ['SP', 'São Paulo'], ['TO', 'Tocantins']];
  let conns = [];
  function connRow(c, k) {
    const opts = R.switches().map(s => `<option value="${s.id}"${s.id === c.to ? ' selected' : ''}>${s.id}${s.uf ? ` · ${s.uf}` : ''}</option>`).join('');
    return `<div class="conn-row" data-k="${k}"><select aria-label="Switch vizinho" data-c="to">${opts}</select><label class="unitf"><input type="number" min="0.1" step="0.1" value="${c.rate}" data-c="rate" aria-label="Capacidade"><em>Mb/s</em></label><label class="unitf"><input type="number" min="0" step="1" value="${c.delay}" data-c="delay" aria-label="Atraso"><em>ms</em></label><label class="unitf"><input type="number" min="0" max="100" step="0.5" value="${c.loss}" data-c="loss" aria-label="Perda"><em>%</em></label><button type="button" class="ico" data-del-conn="${k}" aria-label="Remover link">${R.icon('i-minus')}</button></div>`;
  }
  const swCli = () => {
    const f = swForm.elements, id = f.name.value.trim() || 's?', uf = f.uf.value, idx = +id.slice(1) || 0, dp = (idx + 1).toString(16).padStart(16, '0');
    return [`docker run -d --name=${id} --network=bridge --privileged ${R.env.ovsImage}`, `docker exec ${id} ovs-vsctl add-br ${id} -- set bridge ${id} other-config:datapath-id=${dp} other-config:dp-desc=${uf} protocols=OpenFlow13`, `docker exec ${id} ovs-vsctl set-controller ${id} ${R.env.onos.controller}`,
      ...conns.flatMap(c => [`ip link add ${id}${c.to} type veth peer name ${c.to}${id}`, `tc qdisc add dev ${id}${c.to} root handle 1: tbf rate ${R.rateStr(+c.rate)} burst 32kbit latency 400ms; tc qdisc add dev ${id}${c.to} parent 1:1 netem delay ${c.delay}ms${+c.loss ? ` loss ${c.loss}%` : ''}`])];
  };
  function paintSw() {
    $('[data-conns]', swForm).innerHTML = conns.map(connRow).join('') || '<p class="conn-empty">Sem links. Um switch isolado não recebe fluxos.</p>';
    const f = swForm.elements, idx = +f.name.value.slice(1) || 0;
    $('[data-dpid]', swForm).textContent = `datapath of:${(idx + 1).toString(16).padStart(16, '0')}`;
    $('[data-sw-cli]', swForm).textContent = swCli().map(c => `$ ${c}`).join('\n');
  }
  function openSwitchSheet() {
    const f = swForm.elements;
    f.name.value = R.nextSwitch();
    f.uf.innerHTML = UFS.map(([uf, name]) => `<option value="${uf}">${uf} · ${name}</option>`).join('');
    const used = new Set(R.switches().map(s => s.uf));
    f.uf.value = UFS.find(([uf]) => !used.has(uf))?.[0] || 'DF';
    const last = R.switches().at(-1);
    conns = last ? [{ to: last.id, rate: M.defaults.rate, delay: M.defaults.delay, loss: 0 }] : [];
    paintSw();
    swSheet.showModal();
  }
  swForm.addEventListener('input', e => { const row = e.target.closest('[data-k]'); if (row && e.target.dataset.c) conns[+row.dataset.k][e.target.dataset.c] = e.target.value; $('[data-sw-cli]', swForm).textContent = swCli().map(c => `$ ${c}`).join('\n'); if (e.target.name === 'name') paintSw(); });
  swForm.addEventListener('change', e => { const row = e.target.closest('[data-k]'); if (row && e.target.dataset.c) { conns[+row.dataset.k][e.target.dataset.c] = e.target.value; } $('[data-sw-cli]', swForm).textContent = swCli().map(c => `$ ${c}`).join('\n'); });
  swForm.addEventListener('click', e => {
    if (e.target.closest('[data-close-sheet]')) { swSheet.close(); return; }
    if (e.target.closest('[data-add-conn]')) { const free = R.switches().find(s => !conns.some(c => c.to === s.id)); conns.push({ to: (free || R.switches()[0])?.id, rate: M.defaults.rate, delay: M.defaults.delay, loss: 0 }); paintSw(); return; }
    const d = e.target.closest('[data-del-conn]');
    if (d) { conns.splice(+d.dataset.delConn, 1); paintSw(); }
  });
  swForm.addEventListener('submit', async e => {
    e.preventDefault();
    const f = swForm.elements, id = f.name.value.trim();
    if (R.node(id)) { f.name.setCustomValidity('Esse nome já existe.'); f.name.reportValidity(); f.name.setCustomValidity(''); return; }
    if (!swForm.reportValidity()) return;
    const uniq = [...new Map(conns.filter(c => c.to).map(c => [c.to, c])).values()];
    swSheet.close();
    const n = R.addSwitch({ id, uf: f.uf.value, links: uniq });
    n.pending = true; render(); draw();
    const cmds = swCli();
    await R.job({ title: `Criando ${id}`, nodes: [id], steps: [['Subindo o container Open vSwitch', cmds[0], 1500], ['Criando a bridge e o datapath', cmds[1], 700], ['Ligando ao controlador ONOS', cmds[2], 800], ...uniq.map((c, k) => [`Link ${id}–${c.to}: veth e filas tc`, cmds[3 + k * 2] + ' && ' + cmds[4 + k * 2], 700]), ['Esperando o ONOS (device AVAILABLE, LLDP)', `curl -s ${R.env.onos.rest}/devices/of:${(+id.slice(1) + 1).toString(16).padStart(16, '0')}`, 1400]], doneText: `${id} AVAILABLE no ONOS` });
    delete n.pending; R.save(); render(); draw();
    R.toast('', 'POST /api/testbed/switches');
  });
  swSheet.addEventListener('click', e => { if (e.target === swSheet) swSheet.close(); });

  // ------------------------------------------------------------ services the deployer can install
  const svcSheet = $('[data-sheet="services"]'), svcList = $('[data-svc-list]'), svcForm = $('[data-svc-form]');
  let svc = 'cdn-qoe', svcVals = {}, svcIntent = null;
  const hostOpts = (sel, clientsOnly) => (clientsOnly ? R.clientsList() : R.hosts()).map(h => `<option value="${h.ip}"${h.ip === sel ? ' selected' : ''}>${h.id} · ${h.ip}</option>`).join('');
  function paintSvc() {
    svcList.innerHTML = R.SERVICES.map(s => { const live = M.intents.filter(i => i.state === 'deployed' && (R.nileInfo(i.nile).kind === s.id || (s.id === 'acl' && R.nileInfo(i.nile).kind === 'acl'))).length; return `<button type="button" class="svc-item" data-svc="${s.id}" aria-current="${s.id === svc}"><span class="sq ${s.tone}">${R.icon(s.ic)}</span><span><b>${s.name}</b><em>${s.status === 'warn' ? 'Requer middlebox' : live ? `${live} ativa${live > 1 ? 's' : ''}` : 'Disponível'}</em></span></button>`; }).join('');
    const s = R.SERVICES.find(x => x.id === svc), v = svcVals;
    const clients = R.clientsList();
    v.ip ||= clients[0]?.ip || R.hosts()[0]?.ip || '';
    v.mbps ||= 10; v.action ||= 'block'; v.proto ||= 'udp'; v.box ||= 'dpi';
    const target = (label = 'Cliente', clientsOnly = true) => `<label class="frow"><span class="flabel">${label}</span><span class="fctl"><select data-v="ip" aria-label="${label}">${hostOpts(v.ip, clientsOnly)}</select></span></label>`;
    const seg = (key, opts, label) => `<div class="frow"><span class="flabel">${label}</span><div class="seg" role="group" aria-label="${label}">${opts.map(([val, t]) => `<button type="button" data-sv="${key}" data-val="${val}" aria-pressed="${v[key] === val}">${t}</button>`).join('')}</div></div>`;
    let fields = '';
    if (svc === 'cdn-qoe' || svc === 'llm') fields = target();
    if (svc === 'bandwidth') fields = target('Alvo', false) + `<label class="frow"><span class="flabel">Limite máximo</span><span class="fctl unitf"><input type="number" min="1" step="1" value="${v.mbps}" data-v="mbps" aria-label="Limite em Mb/s"><em>Mb/s</em></span></label>`;
    if (svc === 'acl') fields = target('Alvo', false) + seg('action', [['block', 'Bloquear'], ['allow', 'Liberar']], 'Ação') + seg('proto', [['tcp', 'TCP'], ['udp', 'UDP'], ['icmp', 'ICMP']], 'Protocolo');
    if (svc === 'middlebox') fields = target('Alvo', false) + seg('box', [['dpi', 'DPI'], ['honeypot', 'Honeypot'], ['quarantine', 'Quarentena']], 'Função');
    const nile = R.serviceNile(svc, v, `q${M.intents.length + 1}`);
    const live = M.intents.filter(i => ['deployed', 'checking'].includes(i.state) && R.nileInfo(i.nile).kind === (svc === 'acl' ? 'acl' : svc));
    const it = svcIntent && M.intents.find(i => i.id === svcIntent);
    const warn = svc === 'middlebox' && !R.hosts().some(h => h.ip === '192.168.1.4');
    svcForm.innerHTML = `<header class="svc-head"><span class="sq lg ${s.tone}">${R.icon(s.ic)}</span><div><h3>${s.name}</h3><p>${s.what}</p></div></header>
      ${warn ? `<p class="banner warn">${R.icon('i-help')}Nenhum host usa 192.168.1.4 nesta topologia; o deployer vai recusar. Crie um host com esse endereço antes.</p>` : ''}
      <div class="fgrid">${fields}</div>
      <div class="code"><div class="code-head"><span>Nile gerada</span><button type="button" class="code-copy" data-copy-text="${R.esc(nile)}">${R.icon('i-copy')}<span>Copiar</span></button></div><pre class="nile">${R.highlight(nile)}</pre></div>
      ${it ? `<div class="svc-status st-${it.state}">${it.state === 'checking' ? '<i class="spinner"></i>Verificando no deployer' : it.state === 'deployed' ? `${R.icon('i-check')}${it.id} implantada às ${it.when}: ${R.esc(it.effect || '')}` : it.state === 'rejected' ? `${R.icon('i-x')}Recusada (${it.code || 422}): ${R.esc(it.error)}` : ''}</div>` : ''}
      ${live.length ? `<div class="svc-live"><span class="flabel">Em vigor</span>${live.map(i => `<div class="svc-live-row"><code>${R.highlight(i.nile)}</code><button type="button" class="btn btn-danger" data-revoke="${i.id}">Revogar</button></div>`).join('')}</div>` : ''}
      <div class="sheet-foot"><button type="button" class="btn" data-close-sheet>Fechar</button><button type="submit" class="btn btn-blue">Implantar</button></div>`;
  }
  function openServices(id) { if (id) svc = id; svcIntent = null; paintSvc(); svcSheet.showModal(); }
  svcSheet.addEventListener('click', e => {
    if (e.target === svcSheet || e.target.closest('[data-close-sheet]')) { svcSheet.close(); return; }
    const it = e.target.closest('[data-svc]'); if (it) { svc = it.dataset.svc; svcIntent = null; paintSvc(); return; }
    const sv = e.target.closest('[data-sv]'); if (sv) { svcVals[sv.dataset.sv] = sv.dataset.val; paintSvc(); return; }
    const rv = e.target.closest('[data-revoke]'); if (rv) { R.intentAct(rv.dataset.revoke, 'revoke').then(paintSvc); }
  });
  svcForm.addEventListener('change', e => { const k = e.target.dataset.v; if (k) { svcVals[k] = e.target.value; paintSvc(); } });
  svcForm.addEventListener('submit', async e => {
    e.preventDefault();
    const h = R.hosts().find(x => x.ip === svcVals.ip);
    const s = R.SERVICES.find(x => x.id === svc);
    const it = R.proposeIntent({ nile: R.serviceNile(svc, svcVals, 'q0'), client: h?.id, ask: `${s.name} em ${h?.id || svcVals.ip}, pelo painel de serviços` });
    svcIntent = it.id;
    paintSvc();
    const p = R.intentAct(it.id, 'approve');
    paintSvc();
    await p;
    paintSvc();
  });
  R.on(type => { if (type === 'intent' && svcSheet.open) paintSvc(); });

  // ------------------------------------------------------------ traffic between hosts
  const trSheet = $('[data-sheet="traffic"]'), trForm = $('[data-traffic-form]');
  let tr = {};
  const trCli = () => {
    const c = R.node(tr.client), s = R.node(tr.server);
    if (!c || !s) return '';
    const file = tr.tool === 'iperf3' ? `${tr.out}/${c.id}-${s.id}.json` : `${tr.out}/${c.id}.jsonl`;
    return tr.tool === 'iperf3'
      ? [`# servidor, em segundo plano, log em /tmp/iperf3-${tr.port}.log`, `sudo docker exec -d ${s.id} bash -lc "iperf3 -s -p ${tr.port} --idle-timeout 5 </dev/null >/tmp/iperf3-${tr.port}.log 2>&1"`, '# cliente, JSON no diretório de resultados', `mkdir -p ${tr.out} && sudo docker exec ${c.id} iperf3 -c ${s.ip} -p ${tr.port} ${tr.dir === 'down' ? '-R ' : ''}${tr.proto === 'udp' ? '-u ' : ''}-t ${tr.duration || 86400} -i 1 -b ${tr.rate}M --fq-rate ${tr.rate}M --forceflush -J > ${file}`, `# acompanhar: sudo docker exec ${s.id} tail -f /tmp/iperf3-${tr.port}.log`].join('\n')
      : [`# cliente DASH (neubot dash-client) contra o servidor ${s.id}`, `mkdir -p ${tr.out} && sudo docker exec ${c.id} /usr/local/bin/dash-client -y -hostname ${s.ip} -scheme http > ${file}`, `# acesso no servidor: sudo docker exec ${s.id} tail -f /var/log/nginx/access.log`].join('\n');
  };
  function paintTr() {
    const hosts = R.hosts().map(h => `<option value="${h.id}">${h.id} · ${h.ip}</option>`).join('');
    const iperf = tr.tool === 'iperf3';
    $('[data-traffic-fields]', trForm).innerHTML = `
      <div class="frow"><span class="flabel">Ferramenta</span><div class="seg" role="group" aria-label="Ferramenta"><button type="button" data-tv="tool" data-val="iperf3" aria-pressed="${iperf}">iperf3</button><button type="button" data-tv="tool" data-val="dash" aria-pressed="${!iperf}">DASH</button></div></div>
      <label class="frow"><span class="flabel">${iperf ? 'Servidor (iperf3 -s)' : 'Servidor DASH'}</span><span class="fctl"><select data-t="server" aria-label="Servidor">${hosts}</select></span></label>
      <label class="frow"><span class="flabel">${iperf ? 'Cliente (iperf3 -c)' : 'Cliente DASH'}</span><span class="fctl"><select data-t="client" aria-label="Cliente">${hosts}</select></span></label>
      ${iperf ? `<div class="frow"><span class="flabel">Sentido</span><div class="seg" role="group" aria-label="Sentido"><button type="button" data-tv="dir" data-val="down" aria-pressed="${tr.dir === 'down'}">Servidor → cliente</button><button type="button" data-tv="dir" data-val="up" aria-pressed="${tr.dir === 'up'}">Cliente → servidor</button></div></div>
      <div class="frow"><span class="flabel">Protocolo</span><div class="seg" role="group" aria-label="Protocolo"><button type="button" data-tv="proto" data-val="tcp" aria-pressed="${tr.proto === 'tcp'}">TCP</button><button type="button" data-tv="proto" data-val="udp" aria-pressed="${tr.proto === 'udp'}">UDP</button></div></div>
      <label class="frow"><span class="flabel">Taxa alvo</span><span class="fctl unitf"><input type="number" min="0.1" step="0.1" value="${tr.rate}" data-t="rate" aria-label="Taxa em Mb/s"><em>Mb/s</em></span></label>
      <label class="frow"><span class="flabel">Porta</span><span class="fctl unitf"><input type="number" min="1024" max="65535" value="${tr.port}" data-t="port" aria-label="Porta"><em>TCP/UDP no servidor</em></span></label>` : ''}
      <label class="frow"><span class="flabel">Duração</span><span class="fctl unitf"><input type="number" min="0" step="10" value="${tr.duration}" data-t="duration" aria-label="Duração em segundos"><em>s, 0 até parar</em></span></label>
      <label class="frow"><span class="flabel">Salvar em</span><span class="fctl"><input type="text" value="${R.esc(tr.out)}" data-t="out" spellcheck="false" aria-label="Diretório de resultados"><small data-tr-file></small></span></label>`;
    $('[data-t="server"]', trForm).value = tr.server; $('[data-t="client"]', trForm).value = tr.client;
    paintTrCli();
  }
  function paintTrCli() {
    $('[data-traffic-cli]', trForm).textContent = trCli();
    const f = $('[data-tr-file]', trForm);
    if (f) f.textContent = `Arquivo: ${tr.tool === 'iperf3' ? `${tr.out}/${tr.client}-${tr.server}.json` : `${tr.out}/${tr.client}.jsonl`}`;
  }
  function openTraffic(nodeId) {
    const n = nodeId && R.node(nodeId);
    const server = n?.role === 'Servidor' ? n.id : R.hosts().find(h => h.role === 'Servidor')?.id;
    const client = n?.role === 'Cliente' ? n.id : R.hosts().find(h => h.role === 'Cliente' && h.id !== server)?.id || R.hosts().find(h => h.id !== server)?.id;
    tr = { tool: 'iperf3', server, client, dir: 'down', proto: 'tcp', rate: 35, port: 5201, duration: 60, out: R.traffic.defaults('iperf3') };
    paintTr();
    trSheet.showModal();
  }
  R.openTraffic = openTraffic;
  trForm.addEventListener('click', e => {
    if (e.target.closest('[data-close-sheet]')) { trSheet.close(); return; }
    const b = e.target.closest('[data-tv]');
    if (b) { tr[b.dataset.tv] = b.dataset.val; if (b.dataset.tv === 'tool') tr.out = R.traffic.defaults(tr.tool); paintTr(); }
  });
  trForm.addEventListener('input', e => { const k = e.target.dataset.t; if (k) { tr[k] = e.target.type === 'number' ? +e.target.value : e.target.value; paintTrCli(); } });
  trForm.addEventListener('change', e => { const k = e.target.dataset.t; if (k) { tr[k] = e.target.type === 'number' ? +e.target.value : e.target.value; paintTrCli(); } });
  trForm.addEventListener('submit', e => {
    e.preventDefault();
    if (!tr.client || !tr.server || tr.client === tr.server) { R.toast('Escolha um cliente e um servidor diferentes.'); return; }
    trSheet.close();
    R.traffic.start({ tool: tr.tool, client: tr.client, server: tr.server, reverse: tr.dir === 'down', proto: tr.tool === 'dash' ? 'tcp' : tr.proto, rate: +tr.rate || 35, port: +tr.port || 5201, duration: +tr.duration || 0, out: tr.out.trim() || R.traffic.defaults(tr.tool) });
  });
  trSheet.addEventListener('click', e => { if (e.target === trSheet) trSheet.close(); });

  // The sessions, on the canvas; each opens its tools' output
  const tpanel = $('[data-tpanel]');
  const mmss = s => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  function paintPanel() {
    const list = R.traffic.sessions.slice(0, 5);
    tpanel.hidden = !list.length;
    if (!list.length) return;
    tpanel.innerHTML = `<header><b>Tráfego</b><span>${R.traffic.sessions.filter(x => x.status === 'running').length} em curso</span><button type="button" class="ico" data-tp-new aria-label="Iniciar tráfego">${R.icon('i-plus')}</button></header>${list.map(x => {
      const on = x.status === 'running', t = x.t0 ? (Date.now() - x.t0) / 1000 : 0;
      const from = x.tool === 'dash' || x.reverse ? x.server : x.client, to = x.tool === 'dash' || x.reverse ? x.client : x.server;
      return `<div class="tp-row st-${x.status}"><span class="tp-ic">${x.status === 'starting' ? '<i class="spinner"></i>' : R.icon(x.tool === 'dash' ? 'i-play' : 'i-traffic')}</span><span class="tp-main"><b>${from} → ${to}</b><em>${x.tool}${x.tool === 'iperf3' ? ` ${x.proto.toUpperCase()}` : ''} · ${on ? `${R.fmt1(x.rateNow)} Mb/s · ${mmss(t)}` : x.status === 'starting' ? 'iniciando' : `salvo em ${x.file}`}</em></span><button type="button" class="ico" data-tp-log="${x.id}" aria-label="Ver log">${R.icon('i-terminal')}</button>${on || x.status === 'starting' ? `<button type="button" class="ico" data-tp-stop="${x.id}" aria-label="Parar">${R.icon('i-stop')}</button>` : `<button type="button" class="ico" data-tp-drop="${x.id}" aria-label="Remover da lista">${R.icon('i-x')}</button>`}</div>`;
    }).join('')}`;
  }
  tpanel.addEventListener('click', e => {
    if (e.target.closest('[data-tp-new]')) { openTraffic(); return; }
    const lg = e.target.closest('[data-tp-log]'); if (lg) { openLog(lg.dataset.tpLog); return; }
    const st = e.target.closest('[data-tp-stop]'); if (st) { R.traffic.stop(st.dataset.tpStop); return; }
    const dr = e.target.closest('[data-tp-drop]'); if (dr) { const k = R.traffic.sessions.findIndex(x => x.id === dr.dataset.tpDrop); if (k >= 0) R.traffic.sessions.splice(k, 1); paintPanel(); }
  });
  const logSheet = $('[data-sheet="tlog"]');
  let logId = null, logSide = 'client';
  function paintLog() {
    const x = R.traffic.sessions.find(s => s.id === logId);
    if (!x) return;
    const c = R.node(x.client), s = R.node(x.server);
    $('[data-tl-title]').textContent = `${x.tool} · ${x.client} e ${x.server}`;
    $('[data-tl-sub]').textContent = logSide === 'client' ? `Saída do cliente em ${x.client} (${c?.ip}). ${x.clientCmd}` : `Saída do servidor em ${x.server} (${s?.ip}), arquivo ${x.serverLog} dentro do container.`;
    $('[data-tl-file]').innerHTML = `${R.icon('i-export')}<code>${R.esc(logSide === 'client' ? x.file : `${x.server}:${x.serverLog}`)}</code>`;
    const pre = $('[data-tl-log]'), atEnd = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
    pre.textContent = x.lines[logSide].join('\n');
    if (atEnd) pre.scrollTop = pre.scrollHeight;
    $('[data-tl-stop]').hidden = x.status !== 'running';
    $$('[data-tl-side]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.tlSide === logSide)));
  }
  function openLog(id) { logId = id; logSide = 'client'; paintLog(); logSheet.showModal(); }
  logSheet.addEventListener('click', e => {
    if (e.target === logSheet || e.target.closest('[data-close-sheet]')) { logSheet.close(); return; }
    const sd = e.target.closest('[data-tl-side]'); if (sd) { logSide = sd.dataset.tlSide; paintLog(); }
    if (e.target.closest('[data-tl-copy]')) { const x = R.traffic.sessions.find(s => s.id === logId); navigator.clipboard?.writeText(x?.file || '').catch(() => {}); R.toast('Caminho copiado.'); }
    if (e.target.closest('[data-tl-stop]')) R.traffic.stop(logId);
  });
  R.on(type => { if (type === 'traffic') { paintPanel(); if (logSheet.open) paintLog(); updateLoads(); } });

  // ------------------------------------------------------------ toolbar: map, add, services, traffic, ONOS, appearance, import, export
  const mapBtn = $('[data-tool="map"]');
  // Every switch names a Brazilian state (dp-desc) or a known city: the map is the natural view
  const geoReady = () => R.switches().length > 0 && R.switches().every(s => window.REIN_BR.anchors[s.anchor || s.uf]);
  function setMap(on, animate = true) {
    mapMode = on;
    mapBtn.setAttribute('aria-pressed', String(mapMode));
    stage.classList.toggle('is-map', mapMode);
    R.pop.close(true);
    moved = false;
    render();
    if (animate) glide({ positions: true, dur: 1100 }); else { M.nodes.forEach(n => shown.set(n.id, target(n))); view = fitView(); paint(); }
  }
  mapBtn.addEventListener('click', () => setMap(!mapMode));
  const popAdd = $('[data-pop="add"]'), addBtn = $('[data-tool="add"]');
  addBtn.addEventListener('click', () => {
    if (R.pop.current?.key === 'add') { R.pop.close(); return; }
    popAdd.innerHTML = `<div class="mlist">${[['switch', 'i-switch', 'Switch…', 'Open vSwitch com links'], ['host', 'i-laptop', 'Host…', 'Container ligado a um switch'], ['traffic', 'i-traffic', 'Tráfego…', 'iperf3 ou DASH entre hosts']].map(([k, ic, t, d]) => `<button type="button" role="menuitem" data-add="${k}"><span class="mi-ic">${R.icon(ic)}</span><span><b>${t}</b><em>${d}</em></span></button>`).join('')}</div>`;
    const r = addBtn.getBoundingClientRect();
    R.pop.open(popAdd, r.left + r.width / 2, r.bottom - 6, { trigger: addBtn, key: 'add' });
  });
  popAdd.addEventListener('click', e => { const b = e.target.closest('[data-add]'); if (!b) return; R.pop.close(true); ({ switch: openSwitchSheet, host: () => openHostSheet(), traffic: () => openTraffic() })[b.dataset.add](); });
  $('[data-tool="services"]').addEventListener('click', () => openServices());
  $('[data-tool="traffic"]').addEventListener('click', () => openTraffic());
  $('[data-tool="onos"]').href = R.env.onos.gui;
  R.openServices = openServices;

  // Appearance: node names and link labels (the window glass is fixed)
  const popLook = $('[data-pop="look"]'), lookBtn = $('[data-tool="look"]');
  const LOOK = 'rein-look';
  let look = { labels: true, latency: true, metric: 'use' };
  try { const saved = JSON.parse(localStorage.getItem(LOOK) || '{}'); look = { ...look, labels: saved.labels ?? true, latency: saved.latency ?? true, metric: saved.metric || 'use' }; } catch { /* private mode */ }
  function applyLook() {
    document.documentElement.style.removeProperty('--glass-a');
    stage.classList.toggle('no-names', !look.labels);
    stage.classList.toggle('no-labels', !look.latency);
    try { localStorage.setItem(LOOK, JSON.stringify(look)); } catch { /* ignore */ }
  }
  applyLook();
  lookBtn.addEventListener('click', () => {
    if (R.pop.current?.key === 'look') { R.pop.close(); return; }
    popLook.innerHTML = `
      <div class="pop-head"><h2>Aparência</h2><button class="close" type="button" data-close aria-label="Fechar">${R.icon('i-x')}</button></div>
      <div class="look-row"><span>Nomes dos nós</span><button class="toggle" type="button" role="switch" aria-checked="${look.labels}" data-look="labels" aria-label="Nomes dos nós"></button></div>
      <div class="look-row look-metric"><span>Rótulo dos links</span><div class="seg" role="group" aria-label="Rótulo dos links">${[['use', 'Uso'], ['latency', 'Latência'], ['capacity', 'Capacidade']].map(([v, t]) => `<button type="button" data-metric="${v}" aria-pressed="${look.metric === v}">${t}</button>`).join('')}</div></div>
      <div class="look-row"><span>Mostrar rótulos</span><button class="toggle" type="button" role="switch" aria-checked="${look.latency}" data-look="latency" aria-label="Mostrar rótulos dos links"></button></div>
      <button class="btn btn-plain look-fit" type="button" data-look-fit>Enquadrar a rede</button>`;
    const r = lookBtn.getBoundingClientRect();
    R.pop.open(popLook, r.left + r.width / 2, r.bottom - 6, { trigger: lookBtn, key: 'look' });
  });
  popLook.addEventListener('click', e => {
    if (e.target.closest('[data-close]')) { R.pop.close(); return; }
    if (e.target.closest('[data-look-fit]')) { R.pop.close(); fit(); return; }
    const mb = e.target.closest('[data-metric]');
    if (mb) { look.metric = mb.dataset.metric; $$('[data-metric]', popLook).forEach(b => b.setAttribute('aria-pressed', String(b === mb))); shownVal.clear(); applyLook(); draw(); return; }
    const t = e.target.closest('.toggle[data-look]');
    if (!t) return;
    look[t.dataset.look] = !look[t.dataset.look];
    t.setAttribute('aria-checked', String(look[t.dataset.look]));
    applyLook();
  });

  // The testbed this console talks to
  const popConn = $('[data-pop="conn"]'), connBtn = $('[data-conn]');
  connBtn.addEventListener('click', () => {
    if (R.pop.current?.key === 'conn') { R.pop.close(); return; }
    const running = R.traffic.sessions.filter(x => x.status === 'running').length;
    popConn.innerHTML = `<div class="pop-head"><div><h2>Testbed ${R.env.testbed}</h2><p class="pop-sub"><span class="dot"></span>LFT, ${R.switches().length} switches, ${R.hosts().length} hosts, ${running} fluxo${running === 1 ? '' : 's'} de teste</p></div><button class="close" type="button" data-close aria-label="Fechar">${R.icon('i-x')}</button></div>
      ${kvRows([['ONOS', `${location.hostname}:8181 · OpenFlow 6653`, true], ['Deployer', `${location.hostname}:5000`, true], ['Supervisor', `${location.hostname}:5151`, true], ['Intent profiler', `${location.hostname}:5300`, true], ['Console API', `${location.hostname}:4180`, true], ['Resultados', `${R.env.results}/iperf, ${R.env.results}/dash`, true]])}
      ${R.cliList([['Containers', 'sudo docker ps --format "{{.Names}}\\t{{.Image}}\\t{{.Status}}"'], ['Karaf do ONOS', R.env.onos.karaf], ['Túnel para esta máquina', `ssh -p 13508 -L 4180:127.0.0.1:4180 -L 8181:127.0.0.1:8181 ${R.env.testbed}.mfcaetano.cc`]])}
      <div class="pop-actions"><a class="btn" href="${R.env.onos.gui}" target="_blank" rel="noreferrer">${R.icon('i-external')}GUI2 do ONOS</a></div>`;
    const r = connBtn.getBoundingClientRect();
    R.pop.open(popConn, r.left + r.width / 2, r.bottom - 6, { trigger: connBtn, key: 'conn' });
  });
  popConn.addEventListener('click', e => { if (e.target.closest('[data-close]')) R.pop.close(); });

  const file = $('[data-import]');
  $('[data-tool="import"]').addEventListener('click', () => file.click());
  file.addEventListener('change', async () => {
    const f = file.files[0];
    if (!f) return;
    try {
      const s = R.importPy(await f.text(), f.name);
      const parts = [s.throughput && 'vazão', s.rtt && 'RTT', s.loss && 'perda'].filter(Boolean);
      R.notify({ source: 'Topologia importada', text: `${s.switches} switches, ${s.hosts} hosts, ${s.links} links. ${parts.length ? `Por link: ${parts.join(', ')}.` : 'Links com os valores padrão do CONFIG.'}`, tone: 'ok' });
      if (s.geo === s.switches && !mapMode) setMap(true);
      else if (s.geo < s.switches && mapMode) setMap(false);
    } catch (err) {
      R.notify({ source: 'Não foi possível importar', text: err.message, tone: 'down' });
    }
    file.value = '';
  });
  $('[data-tool="export"]').addEventListener('click', () => {
    const blob = new Blob([R.exportPy()], { type: 'text/x-python' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${M.name || 'rein'}_topology.py`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    R.notify({ source: 'Topologia exportada', text: `${a.download}. Carregue com sudo lft topology create --path ${a.download}`, tone: 'ok' });
  });

  // ------------------------------------------------------------ reactions
  R.on((type, d) => {
    if (type === 'change') { loads = R.linkLoad(); draw(); status(); if (openKey?.startsWith('l:')) sync(); react(d); }
    if (type === 'topology') { if (d.imported || d.reset) shown.clear(); render(); if (d.imported || d.reset || !moved) { moved = false; glide(); } else draw(); }
  });
  let rt;
  addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { R.pop.close(true); if (!moved) fit(false); else paint(); }, 80); });
  setInterval(() => { if (R.page === 'topologia' && !document.hidden) updateLoads(); }, 1000);
  loads = R.linkLoad();
  if (geoReady()) setMap(true, false);
  R.topology = { render, fit, intro, openLink, openNode, zoomAt, makeRoom, setMap, get mapMode() { return mapMode; }, get view() { return { ...view }; } };
})();

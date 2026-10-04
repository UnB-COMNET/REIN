/* Monitoramento (what the collector module measured) and Sobre.
   Experiments and Modules live in experiments.js and studio.js. */
(() => {
  'use strict';
  const R = window.REIN, M = R.model, $ = R.$, $$ = R.$$;

  // ============================================================ Monitoramento
  const mon = $('[data-page="monitor"] .page-scroll');
  const series = [], marks = [];
  // Network wide, in the range shown: the collector's requests to ONOS, the packets dropped, its last sample
  const stats = { requests: 1842, drops: 0, last: Date.now(), down: false };
  let range = 15 * 60, clientId = null;
  const routeOf = id => Object.entries(M.routes).find(([, r]) => r.client === id) || [];
  // The clients; the one shown is kept while it exists, else the first with an intent
  function pick() {
    const clients = R.clientsList();
    if (!clients.some(c => c.id === clientId)) clientId = (clients.find(c => routeOf(c.id)[1]) || clients[0])?.id || null;
    return clients;
  }

  // A plausible past for the diamond story: normal, degradation at -6 min, reroute through s2 at -5 min
  (function seedHistory() {
    const now = Date.now();
    for (let t = 3600; t > 0; t--) {
      const ts = now - t * 1000;
      let thr = 33.6, lat = 20;
      if (t < 360 && t >= 300) { thr = 2.9; lat = 140; } else if (t < 300) { thr = 4.8; lat = 20; }
      series.push({ ts, thr: thr * (1 + (Math.sin(t / 7) + Math.sin(t / 3.1)) * .018), lat: lat * (1 + Math.sin(t / 5.3) * .03) });
    }
    marks.push({ ts: now - 360000, label: L`s0–s1 degraded`, tone: 'warn' }, { ts: now - 358000, label: L`Drift`, tone: 'warn' }, { ts: now - 300000, label: L`Route through s2`, tone: '' });
  })();

  R.monitor = { series, marks, stats };
  // The emulation's sample; online the series are the collector's (collect)
  function sample() {
    if (R.api?.online) return;
    pick();
    const r = routeOf(clientId)[1];
    const rate = r ? Math.min(R.pathRate(r.path), 1000) : 0;
    const lat = r && !R.pathBroken(r.path) ? R.pathDelay(r.path.slice(1, -1).length ? r.path : []) * 2 : 0;
    const wob = 1 + (Math.random() - .5) * .04;
    series.push({ ts: Date.now(), thr: rate * .96 * wob, lat: lat * (1 + (Math.random() - .5) * .05) });
    if (series.length > 7200) series.shift();
    Object.assign(stats, { requests: stats.requests + 2, last: Date.now() });
  }
  // Online: what the collector module stored for the client (GET /api/monitor), asked at its 5 s pace
  // while the page is open
  let asked = 0;
  async function collect(now = false) {
    if (!R.api?.online || R.page !== 'monitor' || document.hidden || (!now && Date.now() - asked < 5000)) return;
    asked = Date.now();
    const want = `${clientId}/${range}`, r = routeOf(clientId)[1];
    try {
      const d = await R.api.monitor(R.node(clientId)?.ip, (r?.path || []).map(R.node).filter(n => n?.kind === 'switch').map(n => n.dpid), range);
      if (want !== `${clientId}/${range}`) return;   // the choice changed meanwhile
      const at = new Map(d.thr.map(([t, v]) => [t, { ts: t * 1000, thr: v, lat: 0 }]));
      d.lat.forEach(([t, v]) => { if (!at.has(t)) at.set(t, { ts: t * 1000, thr: 0, lat: 0 }); at.get(t).lat = v; });
      series.splice(0, series.length, ...[...at.values()].sort((a, b) => a.ts - b.ts));
      Object.assign(stats, { requests: d.requests, drops: d.drops, last: d.last && d.last * 1000, down: false });
    } catch { stats.down = true; }
    renderMonitor();
  }

  const fmtT = ts => { const d = new Date(ts); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  function chartSvg(key, opts) {
    // Drawn at the container's real width so labels keep their size and shape
    const W = Math.max(280, Math.round($(`[data-chart="${key}"]`, mon)?.clientWidth || 1000)), H = opts.h, P = { l: 44, r: 12, t: 10, b: 22 };
    const now = Date.now(), from = now - range * 1000;
    const pts = series.filter(p => p.ts >= from);
    const max = Math.max(opts.min, ...pts.map(p => p[key])) * 1.15;
    const x = ts => P.l + (ts - from) / (range * 1000) * (W - P.l - P.r);
    const y = v => P.t + (1 - v / max) * (H - P.t - P.b);
    const step = Math.max(1, Math.floor(pts.length / 400));
    const line = pts.filter((_, i) => i % step === 0 || i === pts.length - 1).map((p, i) => `${i ? 'L' : 'M'}${x(p.ts).toFixed(1)} ${y(p[key]).toFixed(1)}`).join('');
    const area = line ? `${line}L${x(pts.at(-1).ts).toFixed(1)} ${H - P.b}L${x(pts[0].ts).toFixed(1)} ${H - P.b}Z` : '';
    const ticks = [0, .5, 1].map(f => max / 1.15 * f);
    const grid = ticks.map(v => `<line x1="${P.l}" x2="${W - P.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${P.l - 8}" y="${y(v) + 4}" text-anchor="end">${R.fmt(v, v < 10 ? 1 : 0)}</text>`).join('')
      + (W < 600 ? [0, .5, 1] : [0, .25, .5, .75, 1]).map(f => `<text x="${P.l + f * (W - P.l - P.r)}" y="${H - 4}" text-anchor="${f === 0 ? 'start' : f === 1 ? 'end' : 'middle'}">${fmtT(from + f * range * 1000)}</text>`).join('');
    let lastX = -1e9, row = 0;
    const ms = marks.filter(m => m.ts >= from).sort((a, b) => a.ts - b.ts).map(m => {
      const mx = x(m.ts);
      row = mx - lastX < 110 ? row + 1 : 0;
      lastX = mx;
      return `<g class="mark ${m.tone}"><line x1="${mx}" x2="${mx}" y1="${P.t}" y2="${H - P.b}"/>${opts.labels ? `<text x="${mx + 5}" y="${P.t + 11 + row * 14}">${m.label}</text>` : ''}</g>`;
    }).join('');
    const req = opts.req && opts.req <= max ? `<line class="req" x1="${P.l}" x2="${W - P.r}" y1="${y(opts.req)}" y2="${y(opts.req)}"/>` : '';
    return { svg: `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="height:${H}px"><defs><linearGradient id="area-grad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0071E3" stop-opacity=".18"/><stop offset="1" stop-color="#0071E3" stop-opacity="0"/></linearGradient></defs><g class="grid">${grid}</g>${key === 'thr' ? `<path class="area" d="${area}"/>` : ''}${req}${ms}<path class="line ${key === 'lat' ? 'lat' : ''}" d="${line}"/><line class="cursor" data-cursor x1="-10" x2="-10" y1="${P.t}" y2="${H - P.b}"/><circle class="hover-dot" data-hdot r="4" cx="-10" cy="-10"/></svg>`, x, y, from, P, W };
  }

  let charts = {}, holdUntil = 0;
  // Numbers count up from zero when the page opens
  function countUp(el, to, fmt, unit) {
    if (!el) return;
    if (R.reduced.matches) { el.innerHTML = `${fmt(to)}${unit}`; return; }
    const t0 = performance.now(), dur = 900;
    const step = now => { const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3); el.innerHTML = `${fmt(to * e)}${unit}`; if (k < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }
  function renderMonitor(full = false, entering = false) {
    if (!full && performance.now() < holdUntil) return;
    const clients = pick();
    const [intent, route] = routeOf(clientId);
    const last = series.at(-1) || { thr: 0, lat: 0 };
    if (full || !$('[data-mon-root]', mon)) {
      mon.innerHTML = `<div data-mon-root>
        <div class="mon-top">
          <label class="source"><span class="dot" data-src-dot></span><span data-src></span> <select class="popup" data-client aria-label="${L`Client`}">${clients.map(c => `<option value="${c.id}"${c.id === clientId ? ' selected' : ''}>${c.id}${routeOf(c.id)[0] ? ` · ${routeOf(c.id)[0]}` : ''}</option>`).join('') || `<option>${L`No client`}</option>`}</select></label>
          <div class="seg" role="group" aria-label="${L`Period`}">${[[300, '5 min'], [900, '15 min'], [3600, '1 h']].map(([s, l]) => `<button type="button" data-range="${s}" aria-pressed="${s === range}">${l}</button>`).join('')}</div>
        </div>
        <div class="chart-card reveal" style="--d:1"><div class="chart-head"><h3>${L`Throughput`}<small>${L`Delivered to ${R.esc(clientId || L`client`)}`}</small></h3><span class="now" data-now-thr></span></div><div class="chart" data-chart="thr"></div></div>
        <div class="chart-card reveal" style="--d:2"><div class="chart-head"><h3>${L`Path RTT`}<small>${route ? L`${R.esc(route.path.slice(1, -1).join(' · '))}, limit of ${R.esc(intent)}: 200 ms` : L`No intent for this client`}</small></h3><span class="now" data-now-lat></span></div><div class="chart" data-chart="lat"></div></div>
        <dl class="obs reveal" style="--d:3" data-obs></dl>
        <h2 class="section-title reveal" style="--d:4">${L`Events`}</h2>
        <ol class="group ev-list reveal" style="--d:4" data-ev></ol>
      </div>`;
      mon.querySelectorAll('.reveal').forEach(e => e.classList.add('is-in'));
    }
    $('[data-now-thr]', mon).innerHTML = `${R.fmt1(last.thr)}<small>Mb/s</small>`;
    $('[data-now-lat]', mon).innerHTML = `${R.fmt(last.lat, 0)}<small>ms</small>`;
    charts.thr = chartSvg('thr', { h: 200, min: 5, labels: true });
    charts.lat = chartSvg('lat', { h: 120, min: 40, req: route ? 200 : 0 });
    $('[data-chart="thr"]', mon).innerHTML = charts.thr.svg;
    $('[data-chart="lat"]', mon).innerHTML = charts.lat.svg;
    const age = stats.last ? Math.max(0, Math.round((Date.now() - stats.last) / 1000)) : null, live = !stats.down && age !== null && age < 30;
    $('[data-src]', mon).textContent = stats.down ? L`Collector down` : live ? 'Collector' : L`Collector without samples`;
    $('[data-src-dot]', mon).style.setProperty('--tc', `var(--${live ? 'green' : stats.down ? 'red' : 'orange'})`);
    const drifts = marks.filter(m => m.label === L`Drift` && m.ts >= Date.now() - range * 1000);
    $('[data-obs]', mon).innerHTML = `
      <div><dt>${L`Requests to ONOS`}</dt><dd>${stats.requests.toLocaleString(L.locale)}</dd></div>
      <div><dt>${L`Packets dropped`}</dt><dd>${stats.drops.toLocaleString(L.locale)}</dd></div>
      <div><dt>${L`Drifts`}</dt><dd>${drifts.length}${drifts.length ? `<small>${L`last ${fmtT(drifts.at(-1).ts)}`}</small>` : ''}</dd></div>
      <div><dt>${L`Last sample`}</dt><dd>${age === null ? L`never` : `${age}<small>s</small>`}</dd></div>`;
    const ic = { Deployer: 'i-deployer', Supervisor: 'i-eye', Testbed: 'i-bolt' };
    if (entering) {
      // Opening the page: the lines draw themselves and the numbers count up
      holdUntil = performance.now() + 1300;
      if (!R.reduced.matches) $$('.chart .line', mon).forEach((ln, i) => { const len = ln.getTotalLength(); ln.animate([{ strokeDasharray: `${len} ${len}`, strokeDashoffset: len }, { strokeDasharray: `${len} ${len}`, strokeDashoffset: 0 }], { duration: 1100, delay: 150 + i * 120, easing: 'cubic-bezier(.65,0,.35,1)', fill: 'backwards' }); });
      if (!R.reduced.matches) $$('.chart .area', mon).forEach(a => a.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 900, delay: 700, fill: 'backwards' }));
      countUp($('[data-now-thr]', mon), last.thr, R.fmt1, '<small>Mb/s</small>');
      countUp($('[data-now-lat]', mon), last.lat, v => R.fmt(v, 0), '<small>ms</small>');
      countUp($('[data-obs] dd', mon), stats.requests, v => Math.round(v).toLocaleString(L.locale), '');
    }
    $('[data-ev]', mon).innerHTML = M.events.slice(-8).reverse().map(e => `<li class="act ${e.tone || ''}"><span class="act-ic">${R.icon(ic[e.source] || 'i-bolt')}</span><span class="act-text"><b>${R.esc(e.source)}</b> ${R.esc(e.text)}</span><time>${e.time}</time></li>`).join('');
  }
  mon.addEventListener('click', e => { const b = e.target.closest('[data-range]'); if (b) { range = +b.dataset.range; $$('[data-range]', mon).forEach(x => x.setAttribute('aria-pressed', String(x === b))); renderMonitor(); collect(true); } });
  mon.addEventListener('change', e => { if (e.target.matches('[data-client]')) { clientId = e.target.value; renderMonitor(true); collect(true); } });
  mon.addEventListener('pointermove', e => {
    const box = e.target.closest('[data-chart]');
    if (!box) return;
    const key = box.dataset.chart, c = charts[key], svg = $('svg', box), r = svg.getBoundingClientRect();
    const vx = (e.clientX - r.left) / r.width * c.W;
    const ts = c.from + (vx - c.P.l) / (c.W - c.P.l - c.P.r) * range * 1000;
    let best = null;
    for (const p of series) if (p.ts >= c.from && (!best || Math.abs(p.ts - ts) < Math.abs(best.ts - ts))) best = p;
    if (!best) return;
    const cx = c.x(best.ts), cy = c.y(best[key]);
    $('[data-cursor]', svg).setAttribute('x1', cx); $('[data-cursor]', svg).setAttribute('x2', cx);
    const d = $('[data-hdot]', svg); d.setAttribute('cx', cx); d.setAttribute('cy', cy);
    let tip = $('.chart-tip', box);
    if (!tip) { tip = document.createElement('div'); tip.className = 'chart-tip'; box.append(tip); }
    tip.style.left = `${cx / c.W * 100}%`; tip.style.top = `${cy / svg.viewBox.baseVal.height * r.height}px`;
    tip.textContent = `${R.hms(new Date(best.ts))}  ${key === 'thr' ? `${R.fmt1(best.thr)} Mb/s` : `${R.fmt(best.lat, 0)} ms`}`;
  });
  mon.addEventListener('pointerleave', () => $$('.chart-tip', mon).forEach(t => t.remove()), true);

  R.on((type, d) => {
    if (type === 'log') {
      if (d.source === 'Testbed' && /degrad|derrub|taken down|(em|at) .* Mb\/s/i.test(d.text)) marks.push({ ts: Date.now(), label: d.text.split(' ')[0] + (/derrub|taken down/.test(d.text) ? ` ${L`down`}` : ` ${L`changed`}`), tone: 'warn' });
      if (d.source === 'Supervisor' && !R.api?.online) marks.push({ ts: Date.now(), label: L`Drift`, tone: 'warn' });   // online: the deployer's events (api.js)
      if (d.source === 'Deployer' && /Rota|Route/.test(d.text)) marks.push({ ts: Date.now(), label: L`New route`, tone: '' });
      if (R.page === 'monitor') renderMonitor();
    }
    if (type === 'change' && R.page === 'monitor') renderMonitor(true);
    if (type === 'page' && d.page === 'monitor') { renderMonitor(true, true); collect(true); }
  });
  setInterval(() => { sample(); collect(); if (R.page === 'monitor' && !document.hidden) renderMonitor(); }, 1000);


  // ============================================================ Sobre
  // A small product page: the promise, then figures drawn like those of the Lumi paper
  // (Jacobs et al., IEEE TNSM 2025), then the components.
  const about = $('[data-page="about"] .page-scroll');
  const COMPONENTS = [
    ['Console', L`This interface: topology, intents, experiments.`, ':3000', 'i-topo', 'graphite', 'https://github.com/UnB-COMNET/REIN'],
    ['Intent profiler', L`Chat, grounding in the inventory and translation to Nile.`, ':5300', 'i-chat', 'orange', 'https://github.com/UnB-COMNET/REIN'],
    ['Deployer', L`Validates the Nile, picks the path and installs the flows.`, ':5000', 'i-deployer', 'blue', 'https://github.com/UnB-COMNET/deployer'],
    ['Supervisor', L`Measures throughput and latency and detects drifts.`, ':5151', 'i-eye', 'green', 'https://github.com/UnB-COMNET/supervisor'],
    ['ONOS', L`SDN controller that programs the switches.`, ':8181', 'i-modules', 'teal', 'https://opennetworking.org/onos/'],
    ['LFT', L`Emulates the network and runs the experiments.`, 'testbed', 'i-flask', 'ink', 'https://github.com/UnB-COMNET/lft'],
  ];
  about.innerHTML = `<div class="ab">
    <section class="ab-hero">
      <div class="ab-copy reveal">
        <p class="eyebrow">${L`REIN · Intent network`}</p>
        <h2 class="ab-title">${L`Say what the network must guarantee.`}<span>${L`REIN translates, deploys and watches.`}</span></h2>
        <p class="ab-lead">${L`You write the request in plain language. REIN translates it to`} <b>Nile</b>${L`, asks for your approval, installs the flows in`} <b>ONOS</b> ${L`and follows the result, recalculating the route when the intent is no longer met.`}</p>
        <div class="ab-cta"><a class="btn btn-blue btn-lg" href="#topology">${L`Open the topology`}</a><a class="btn btn-plain btn-lg" href="https://github.com/UnB-COMNET/REIN" target="_blank" rel="noreferrer">${L`Code on GitHub ↗`}</a></div>
      </div>
      <figure class="ab-art reveal" style="--d:2" data-art><img src="assets/img/about-glass-network.webp" srcset="assets/img/about-glass-network-720.webp 640w, assets/img/about-glass-network.webp 1040w" sizes="(max-width: 899px) 90vw, 560px" width="1040" height="780" alt="${L`Glass spheres linked by filaments of light. A brighter blue path crosses three of them.`}" decoding="async"></figure>
    </section>

    <section class="ab-sec">
      <header class="ab-sec-head reveal"><h3>${L`From the request to the installed flow.`}</h3><p>${L`Five stages, three requests. From left to right, what each stage produces.`}</p></header>
      <figure class="pfig reveal" style="--d:1">${R.figures.fig1()}<figcaption><span class="fig-n">Fig. 1.</span> ${L`The pipeline of`} <span class="sc">REIN</span>${L`, at a glance.`}</figcaption></figure>
    </section>

    <section class="ab-sec">
      <header class="ab-sec-head reveal"><h3>${L`When the network changes.`}</h3><p>${L`The intent keeps holding after it is deployed: the supervisor measures and the deployer corrects.`}</p></header>
      <figure class="pfig reveal" style="--d:1">${R.figures.fig2()}<figcaption><span class="fig-n">Fig. 2.</span> ${L`Assurance of intent q1: the first route through MG (left), the supervisor detects the 130 ms latency in s0–s1 as a drift (middle), and the deployer installs the new route through RJ (right).`}</figcaption></figure>
    </section>

    <section class="ab-sec">
      <header class="ab-sec-head reveal"><h3>${L`Architecture.`}</h3><p>${L`Each service runs in the testbed and talks to the next over HTTP, and ONOS programs the switches over OpenFlow.`}</p></header>
      <figure class="pfig reveal" style="--d:1">${R.figures.fig3()}<figcaption><span class="fig-n">Fig. 3.</span> ${L`The services of`} <span class="sc">REIN</span> ${L`and the ports they listen on.`}</figcaption></figure>
    </section>

    <section class="ab-sec">
      <header class="ab-sec-head reveal"><h3>${L`Components.`}</h3><p>${L`Each piece runs as a service and can be used on its own.`}</p></header>
      <div class="bento">${COMPONENTS.map(([name, desc, port, ic, tone, href], i) => `<a class="tile reveal" style="--d:${i}" href="${href}" target="_blank" rel="noreferrer" data-tilt><span class="sq ${tone}">${R.icon(ic)}</span><b>${name}</b><span class="tile-d">${desc}</span><span class="tile-f"><code>${port}</code><em>${L`Open ↗`}</em></span></a>`).join('')}</div>
    </section>
    <p class="fine reveal">${L`Figures in the style of Jacobs et al., “Establishing Trust for Using Natural Language for Intent-Based Networking”, IEEE TNSM 22(5), 2025. IBN cycle after Leivadeas and Falkner (IEEE COMST, 2023).`}</p>
  </div>`;

  // Tiles tilt a little toward the pointer and catch a light where it rests
  about.addEventListener('pointermove', e => {
    const t = e.target.closest('[data-tilt]');
    if (!t || R.reduced.matches) return;
    const r = t.getBoundingClientRect(), x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
    t.style.setProperty('--mx', `${x * 100}%`); t.style.setProperty('--my', `${y * 100}%`);
    t.style.setProperty('--rx', `${(0.5 - y) * 6}deg`); t.style.setProperty('--ry', `${(x - 0.5) * 8}deg`);
  });
  about.addEventListener('pointerout', e => { const t = e.target.closest('[data-tilt]'); if (t && !t.contains(e.relatedTarget)) { t.style.setProperty('--rx', '0deg'); t.style.setProperty('--ry', '0deg'); } });
  // The glass sculpture drifts with the pointer
  const art = $('[data-art]', about);
  about.addEventListener('pointermove', e => {
    if (R.reduced.matches || !art) return;
    const r = art.getBoundingClientRect(), x = (e.clientX - (r.left + r.width / 2)) / innerWidth, y = (e.clientY - (r.top + r.height / 2)) / innerHeight;
    art.style.setProperty('--px', `${(x * -18).toFixed(1)}px`); art.style.setProperty('--py', `${(y * -14).toFixed(1)}px`);
  });
})();

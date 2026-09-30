/* Monitoramento (reads the observer and supervisor) and Sobre.
   Experimentos and Módulos live in studio.js. */
(() => {
  'use strict';
  const R = window.REIN, M = R.model, $ = R.$, $$ = R.$$;

  // ============================================================ Monitoramento
  const mon = $('[data-page="monitor"] .page-scroll');
  const series = [];
  const observer = { onosToObserver: 1842, observerToDeployer: 3, lastDrift: '14:31', detection: 1.8, drift: true };
  let range = 15 * 60, flowId = 'q1';
  const marks = [];

  // A plausible past for the diamond story: normal, degradation at -6 min, reroute through s2 at -5 min
  (function seedHistory() {
    const now = Date.now();
    for (let t = 3600; t > 0; t--) {
      const ts = now - t * 1000;
      let thr = 33.6, lat = 20;
      if (t < 360 && t >= 300) { thr = 2.9; lat = 140; } else if (t < 300) { thr = 4.8; lat = 20; }
      series.push({ ts, thr: thr * (1 + (Math.sin(t / 7) + Math.sin(t / 3.1)) * .018), lat: lat * (1 + Math.sin(t / 5.3) * .03) });
    }
    marks.push({ ts: now - 360000, label: 's0–s1 degradado', tone: 'warn' }, { ts: now - 358000, label: 'Desvio', tone: 'warn' }, { ts: now - 300000, label: 'Rota por s2', tone: '' });
  })();

  R.monitor = { series, marks, observer };
  function sample() {
    if (R.api?.online) { R.api.sample(series, observer, flowId); return; }
    const r = M.routes[flowId] || Object.values(M.routes)[0];
    const rate = r ? Math.min(R.pathRate(r.path), 1000) : 0;
    const lat = r && !R.pathBroken(r.path) ? R.pathDelay(r.path.slice(1, -1).length ? r.path : []) * 2 : 0;
    const wob = 1 + (Math.random() - .5) * .04;
    series.push({ ts: Date.now(), thr: rate * .96 * wob, lat: lat * (1 + (Math.random() - .5) * .05) });
    if (series.length > 7200) series.shift();
    observer.onosToObserver += 1;
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
    const req = opts.req ? `<line class="req" x1="${P.l}" x2="${W - P.r}" y1="${y(opts.req)}" y2="${y(opts.req)}"/>` : '';
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
    const routes = Object.entries(M.routes);
    if (!M.routes[flowId] && routes.length) flowId = routes[0][0];
    const last = series.at(-1) || { thr: 0, lat: 0 };
    if (full || !$('[data-mon-root]', mon)) {
      mon.innerHTML = `<div data-mon-root>
        <div class="mon-top">
          <label class="source"><span class="dot"></span>Observer, supervisor em 127.0.0.1:5151 <select class="popup" data-flow aria-label="Fluxo">${routes.map(([id, r]) => `<option value="${id}"${id === flowId ? ' selected' : ''}>${id}: ${r.server} para ${r.client}</option>`).join('') || '<option>Nenhum fluxo</option>'}</select></label>
          <div class="seg" role="group" aria-label="Período">${[[300, '5 min'], [900, '15 min'], [3600, '1 h']].map(([s, l]) => `<button type="button" data-range="${s}" aria-pressed="${s === range}">${l}</button>`).join('')}</div>
        </div>
        <div class="chart-card reveal" style="--d:1"><div class="chart-head"><h3>Vazão<small>Medida pelo observer no cliente</small></h3><span class="now" data-now-thr></span></div><div class="chart" data-chart="thr"></div></div>
        <div class="chart-card reveal" style="--d:2"><div class="chart-head"><h3>RTT do caminho<small>Limite da intent: 200 ms</small></h3><span class="now" data-now-lat></span></div><div class="chart" data-chart="lat"></div></div>
        <dl class="obs reveal" style="--d:3" data-obs></dl>
        <h2 class="section-title reveal" style="--d:4">Eventos</h2>
        <ol class="group ev-list reveal" style="--d:4" data-ev></ol>
      </div>`;
      mon.querySelectorAll('.reveal').forEach(e => e.classList.add('is-in'));
    }
    $('[data-now-thr]', mon).innerHTML = `${R.fmt1(last.thr)}<small>Mb/s</small>`;
    $('[data-now-lat]', mon).innerHTML = `${R.fmt(last.lat, 0)}<small>ms</small>`;
    charts.thr = chartSvg('thr', { h: 200, min: 5, labels: true });
    charts.lat = chartSvg('lat', { h: 120, min: 40, req: 200 });
    $('[data-chart="thr"]', mon).innerHTML = charts.thr.svg;
    $('[data-chart="lat"]', mon).innerHTML = charts.lat.svg;
    $('[data-obs]', mon).innerHTML = `
      <div><dt>ONOS para o observer</dt><dd>${observer.onosToObserver.toLocaleString('pt-BR')}<small>mensagens</small></dd></div>
      <div><dt>Observer para o deployer</dt><dd>${observer.observerToDeployer}<small>pedidos</small></dd></div>
      <div><dt>Último desvio</dt><dd>${observer.lastDrift || 'nenhum'}</dd></div>
      <div><dt>Tempo de detecção</dt><dd>${R.fmt1(observer.detection)}<small>s</small></dd></div>`;
    const ic = { Deployer: 'i-deployer', Supervisor: 'i-eye', Testbed: 'i-bolt' };
    if (entering) {
      // Opening the page: the lines draw themselves and the numbers count up
      holdUntil = performance.now() + 1300;
      if (!R.reduced.matches) $$('.chart .line', mon).forEach((ln, i) => { const len = ln.getTotalLength(); ln.animate([{ strokeDasharray: `${len} ${len}`, strokeDashoffset: len }, { strokeDasharray: `${len} ${len}`, strokeDashoffset: 0 }], { duration: 1100, delay: 150 + i * 120, easing: 'cubic-bezier(.65,0,.35,1)', fill: 'backwards' }); });
      if (!R.reduced.matches) $$('.chart .area', mon).forEach(a => a.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 900, delay: 700, fill: 'backwards' }));
      countUp($('[data-now-thr]', mon), last.thr, R.fmt1, '<small>Mb/s</small>');
      countUp($('[data-now-lat]', mon), last.lat, v => R.fmt(v, 0), '<small>ms</small>');
      countUp($('[data-obs] dd', mon), observer.onosToObserver, v => Math.round(v).toLocaleString('pt-BR'), '<small>mensagens</small>');
    }
    $('[data-ev]', mon).innerHTML = M.events.slice(-8).reverse().map(e => `<li class="act ${e.tone || ''}"><span class="act-ic">${R.icon(ic[e.source] || 'i-bolt')}</span><span class="act-text"><b>${R.esc(e.source)}</b> ${R.esc(e.text)}</span><time>${e.time}</time></li>`).join('');
  }
  mon.addEventListener('click', e => { const b = e.target.closest('[data-range]'); if (b) { range = +b.dataset.range; $$('[data-range]', mon).forEach(x => x.setAttribute('aria-pressed', String(x === b))); renderMonitor(); } });
  mon.addEventListener('change', e => { if (e.target.matches('[data-flow]')) { flowId = e.target.value; renderMonitor(); } });
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
      if (d.source === 'Testbed' && /degrad|derrub|em .* Mb\/s/i.test(d.text)) marks.push({ ts: Date.now(), label: d.text.split(' ')[0] + (/derrub/.test(d.text) ? ' fora' : ' alterado'), tone: 'warn' });
      if (d.source === 'Supervisor') { observer.lastDrift = R.hhmm(); observer.detection = 0.9 + Math.random() * 1.2; marks.push({ ts: Date.now(), label: 'Desvio', tone: 'warn' }); }
      if (d.source === 'Deployer' && /Rota/.test(d.text)) { observer.observerToDeployer += 1; marks.push({ ts: Date.now(), label: 'Nova rota', tone: '' }); }
      if (R.page === 'monitor') renderMonitor();
    }
    if (type === 'change' && R.page === 'monitor') renderMonitor(true);
    if (type === 'page' && d.page === 'monitor') renderMonitor(true, true);
  });
  setInterval(() => { sample(); if (R.page === 'monitor' && !document.hidden) renderMonitor(); }, 1000);


  // ============================================================ Sobre
  // A small product page: the promise, then figures drawn like those of the Lumi paper
  // (Jacobs et al., IEEE TNSM 2025), then the components.
  const about = $('[data-page="sobre"] .page-scroll');
  const COMPONENTS = [
    ['Console', 'Esta interface: topologia, intents, experimentos.', ':3000', 'i-topo', 'graphite', 'https://github.com/UnB-COMNET/REIN'],
    ['Intent profiler', 'Conversa, grounding no inventário e tradução para Nile.', ':5300', 'i-chat', 'orange', 'https://github.com/UnB-COMNET/REIN'],
    ['Deployer', 'Valida a Nile, escolhe o caminho e instala os fluxos.', ':5000', 'i-deployer', 'blue', 'https://github.com/UnB-COMNET/deployer'],
    ['Supervisor', 'Mede vazão e latência e detecta desvios.', ':5151', 'i-eye', 'green', 'https://github.com/UnB-COMNET/supervisor'],
    ['ONOS', 'Controlador SDN que programa os switches.', ':8181', 'i-modules', 'teal', 'https://opennetworking.org/onos/'],
    ['LFT', 'Emula a rede e roda os experimentos.', 'testbed', 'i-flask', 'ink', 'https://github.com/UnB-COMNET/lft'],
  ];
  about.innerHTML = `<div class="ab">
    <section class="ab-hero">
      <div class="ab-copy reveal">
        <p class="eyebrow">REIN · Rede de intenções</p>
        <h2 class="ab-title">Diga o que a rede precisa garantir.<span>O REIN traduz, implanta e vigia.</span></h2>
        <p class="ab-lead">Você escreve o pedido em português. O REIN o traduz para <b>Nile</b>, pede sua aprovação, instala os fluxos no <b>ONOS</b> e acompanha o resultado, recalculando a rota quando a intent deixa de ser cumprida.</p>
        <div class="ab-cta"><a class="btn btn-blue btn-lg" href="#topologia">Abrir a topologia</a><a class="btn btn-plain btn-lg" href="https://github.com/UnB-COMNET/REIN" target="_blank" rel="noreferrer">Código no GitHub ↗</a></div>
      </div>
      <figure class="ab-art reveal" style="--d:2" data-art><img src="assets/img/about-glass-network.webp" srcset="assets/img/about-glass-network-720.webp 640w, assets/img/about-glass-network.webp 1040w" sizes="(max-width: 899px) 90vw, 560px" width="1040" height="780" alt="Esferas de vidro ligadas por filamentos de luz; um caminho azul mais intenso atravessa três delas." decoding="async"></figure>
    </section>

    <section class="ab-sec">
      <header class="ab-sec-head reveal"><h3>Do pedido ao fluxo instalado.</h3><p>Cinco etapas, três pedidos. Da esquerda para a direita, o que cada etapa produz.</p></header>
      <figure class="pfig reveal" style="--d:1">${R.figures.fig1()}<figcaption><span class="fig-n">Fig. 1.</span> O pipeline do <span class="sc">REIN</span>, de relance.</figcaption></figure>
    </section>

    <section class="ab-sec">
      <header class="ab-sec-head reveal"><h3>Quando a rede muda.</h3><p>A intent continua valendo depois de implantada: o supervisor mede e o deployer corrige.</p></header>
      <figure class="pfig reveal" style="--d:1">${R.figures.fig2()}<figcaption><span class="fig-n">Fig. 2.</span> Garantia da intent q1: a rota inicial por MG (esquerda); o supervisor detecta a latência de 130 ms em s0–s1 como desvio (meio); o deployer instala a nova rota por RJ (direita).</figcaption></figure>
    </section>

    <section class="ab-sec">
      <header class="ab-sec-head reveal"><h3>Arquitetura.</h3><p>Cada serviço roda no testbed e fala com o seguinte por HTTP; o ONOS programa os switches por OpenFlow.</p></header>
      <figure class="pfig reveal" style="--d:1">${R.figures.fig3()}<figcaption><span class="fig-n">Fig. 3.</span> Os serviços do <span class="sc">REIN</span> e as portas em que escutam.</figcaption></figure>
    </section>

    <section class="ab-sec">
      <header class="ab-sec-head reveal"><h3>Componentes.</h3><p>Cada peça roda como um serviço e pode ser usada sozinha.</p></header>
      <div class="bento">${COMPONENTS.map(([name, desc, port, ic, tone, href], i) => `<a class="tile reveal" style="--d:${i}" href="${href}" target="_blank" rel="noreferrer" data-tilt><span class="sq ${tone}">${R.icon(ic)}</span><b>${name}</b><span class="tile-d">${desc}</span><span class="tile-f"><code>${port}</code><em>Abrir ↗</em></span></a>`).join('')}</div>
    </section>
    <p class="fine reveal">Figuras no estilo de Jacobs et al., “Establishing Trust for Using Natural Language for Intent-Based Networking”, IEEE TNSM 22(5), 2025. Ciclo de IBN segundo Leivadeas e Falkner (IEEE COMST, 2023).</p>
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

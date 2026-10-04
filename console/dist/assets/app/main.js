/* Navigation between the window's pages, the video sheet and start-up. */
(() => {
  'use strict';
  const R = window.REIN, $ = R.$, $$ = R.$$;
  const PAGES = ['topology', 'intents', 'monitor', 'experiments', 'modules', 'about'];
  const TITLES = { topology: L`Topology`, intents: 'Intents', monitor: L`Monitoring`, experiments: L`Experiments`, modules: L`Modules`, about: L`About` };
  const composer = $('[data-composer]');

  function go(page, focus = false) {
    if (!PAGES.includes(page)) page = 'topology';
    const changed = R.page !== page;
    R.page = page;
    $$('.page').forEach(p => { const active = p.dataset.page === page; p.classList.toggle('is-on', active); p.inert = !active; });
    $$('.nav a').forEach(a => { if (a.dataset.nav === page) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    placeIndicator();
    $$('.w-tools[data-for]').forEach(t => { const active = t.dataset.for === page; t.classList.toggle('is-on', active); t.inert = !active; });
    composer.hidden = !(page === 'topology' || page === 'intents');
    // On the Intents page the composer becomes the chat field: centred on the column, round send button
    composer.dataset.page = page;
    $('[data-send]', composer).setAttribute('aria-label', page === 'intents' ? L`Send` : L`Review`);
    document.title = page === 'topology' ? 'REIN' : `${TITLES[page]} · REIN`;
    R.pop.close(true);
    if (changed) R.emit('page', { page });
    if (changed) {
      const pg = $(`.page[data-page="${page}"]`);
      R.replay(pg);
      // The chosen tab's icon answers with a small spring
      const ic = $('.nav a[aria-current] svg');
      if (ic && !R.reduced.matches && R.booted) ic.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.22) translateY(-2px)' }, { transform: 'scale(.94)' }, { transform: 'none' }], { duration: 560, easing: 'cubic-bezier(.32,.72,0,1)' });
    }
    if (page === 'topology') requestAnimationFrame(() => R.topology.fit(false));
    if (focus) $(`.page[data-page="${page}"] h1, .page[data-page="${page}"] [tabindex="-1"]`)?.focus({ preventScroll: true });
  }
  addEventListener('hashchange', () => go(location.hash.slice(1), true));

  // One selection plate slides between the navigation items
  const ind = $('[data-nav-ind]');
  function placeIndicator() {
    const a = $('.nav a[aria-current="page"]');
    if (!a || !ind) return;
    ind.style.width = `${a.offsetWidth}px`; ind.style.height = `${a.offsetHeight}px`;
    ind.style.transform = `translate(${a.offsetLeft}px, ${a.offsetTop}px)`;
  }
  addEventListener('resize', placeIndicator);
  document.fonts?.ready.then(placeIndicator);

  // A quiet light pass follows the existing mark; the wordmark remains legible throughout.
  const brand = $('.brand'), brandSvg = $('svg', brand);
  const glint = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  glint.setAttribute('aria-hidden', 'true');
  glint.innerHTML = `<defs><mask id="brand-light-mask"><use href="#rein-logo" fill="white" style="color:white"/></mask><linearGradient id="brand-light-gradient"><stop stop-color="#79a6ce" stop-opacity="0"/><stop offset=".45" stop-color="#4889bf" stop-opacity=".8"/><stop offset=".58" stop-color="#b6d8ed"/><stop offset="1" stop-color="#79a6ce" stop-opacity="0"/></linearGradient></defs><g mask="url(#brand-light-mask)"><rect class="brand-light" x="0" y="0" width="480" height="400" fill="url(#brand-light-gradient)"/></g>`;
  brandSvg.append(glint);
  let logoMotion;
  function animateBrand(hover = false) {
    logoMotion?.kill();
    const light = $('.brand-light', brand);
    if (!window.gsap || R.reduced.matches) { light.style.opacity = '0'; return; }
    logoMotion = gsap.fromTo(light, { x:-500, opacity:1 }, {
      x:1650, duration:hover?1.1:2.1, ease:'sine.inOut', repeat:-1, repeatDelay:8,
      delay:hover?0:document.documentElement.classList.contains('is-opening')?8:1.5
    });
    if (document.hidden) logoMotion.pause();
  }
  brand.addEventListener('pointerenter', () => animateBrand(true));
  brand.addEventListener('focus', () => animateBrand(true));
  R.reduced.addEventListener('change', () => animateBrand());
  document.addEventListener('visibilitychange', () => { if(logoMotion)document.hidden?logoMotion.pause():logoMotion.resume(); });
  animateBrand();

  // Video sheet
  const sheet = $('[data-sheet="video"]');
  let unmount = null;
  R.openVideo = id => {
    const n = R.node(id);
    $('[data-video-title]').textContent = L`Video on ${id}`;
    const route = R.routeOf(id)?.[1];
    $('[data-video-sub]').textContent = route ? L`Served by ${route.server}, path ${route.path.slice(1, -1).join(', ')}. ${n.image}.` : L`No video intent for this client.`;
    unmount?.();
    unmount = R.video.mount($('[data-video-canvas]'), id);
    sheet.dataset.client = id;
    meta();
    sheet.showModal();
  };
  function meta() {
    const id = sheet.dataset.client;
    if (!id || !sheet.open) return;
    const q = R.qoe(id);
    sheet.dataset.tone = q.tone;
    $('[data-video-meta]').innerHTML = `
      <div><dt>${L`Resolution`}</dt><dd data-res>${q.stalled ? L`Stopped` : q.res}</dd></div>
      <div><dt>Throughput</dt><dd>${R.fmt1(q.thr)}<small>Mb/s</small></dd></div>
      <div><dt>Buffer</dt><dd>${R.fmt1(q.buffer)}<small>s</small></dd></div>
      <div><dt>${L`Stalls`}</dt><dd>${q.stalls}</dd></div>`;
  }
  sheet.addEventListener('close', () => { unmount?.(); unmount = null; });
  sheet.addEventListener('click', e => { if (e.target === sheet || e.target.closest('[data-close-sheet]')) sheet.close(); });
  $('[data-video-play]').addEventListener('click', () => R.toast(L`The dash.js player plays:`, `/video/${sheet.dataset.client}/manifest.mpd`));
  R.on(type => { if (type === 'change') meta(); });
  setInterval(meta, 1000);

  $('[data-skip]').addEventListener('click', e => { e.preventDefault(); $('[data-composer] textarea').focus(); });
  document.addEventListener('keydown', e => {
    const a = document.activeElement;
    const typing = a && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable);
    if (e.key === '/' && !typing && !composer.hidden) { e.preventDefault(); $('textarea', composer).focus(); }
  });

  // Opening. The REIN mark draws itself; the letters R E I N arrive and open into what they stand
  // for, REde de INtenções, then close again into the logotype, which flies to the title bar while
  // the window unfolds out of it. The navigation and the network follow. Any click or key skips.
  function opening() {
    const root = document.documentElement, ov = $('[data-intro]');
    const stage = $('[data-stage]');
    if (!root.classList.contains('is-opening') || !ov) { ov?.remove(); root.classList.remove('is-opening'); stage.classList.add('is-live'); return; }
    const reduced = R.reduced.matches, spring = 'cubic-bezier(.32,.72,0,1)', smooth = 'cubic-bezier(.65,0,.35,1)';
    const brand = $('.brand svg');
    const split = s => [...s].map((c, i) => `<i class="ri-c" style="--k:${i}">${c === ' ' ? '&nbsp;' : c}</i>`).join('');
    // The row is cut from the logotype itself: mark | R | E | … | I | N | …. Closed, it IS the
    // logo, so the same element that wrote itself is the one that lands in the title bar.
    const LOGO = $('#rein-logo').innerHTML;
    const slice = (x0, x1, cls) => `<svg class="ri-p ${cls}" viewBox="${x0} 0 ${x1 - x0} 400" style="--w:${x1 - x0}" aria-hidden="true">${LOGO}</svg>`;
    ov.innerHTML = `<div class="ri" data-ri>${slice(0, 565, 'ri-mark')}${slice(565, 899.5, 'ri-l')}${slice(899.5, 1181.5, 'ri-l')}<span class="ri-x" data-x>${split('DE DE ')}</span>${slice(1181.5, 1306, 'ri-l')}${slice(1306, 1614, 'ri-l')}<span class="ri-x" data-x>${split('TENÇÕES')}</span></div>
      <p class="ri-tag" data-ri-tag>${L`Console for intent-based networks`}</p>`;
    const ri = $('[data-ri]', ov), markSvg = $('.ri-mark', ov), mark = $('.ri-mark path', ov), xs = $$('[data-x]', ov), letters = $$('.ri-l', ov), tag = $('[data-ri-tag]', ov);
    const anims = [], t0 = performance.now();
    const A = (el, kf, opt) => { if (!el) return; const a = el.animate(kf, { fill: 'both', ...opt }); a.off = performance.now() - t0; anims.push(a); return a; };
    const win = $('.window'), nav = $('.nav'), comp = $('[data-composer]'), head = $('.page.is-on .page-head');
    const tools = $$('.w-head .tool, .w-head .tool-sep, .conn');
    A($('[data-backdrop]'), reduced ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: 'scale(1.16)' }, { opacity: 1, transform: 'scale(1)' }], { duration: reduced ? 500 : 3600, easing: 'cubic-bezier(.2,.7,.1,1)' });

    // The hidden parts start closed; their open width is measured once the typeface is in
    xs.forEach(x => { x.style.width = '0px'; });
    // Where the closed row sits now, and where the title-bar logo sits: measured before anything moves
    const pieces = $$('.ri-p', ov), r0 = ri.getBoundingClientRect(), p0 = pieces[0].getBoundingClientRect(), pN = pieces.at(-1).getBoundingClientRect(), b = brand.getBoundingClientRect();
    const k = b.width / (pN.right - p0.left);
    const fly = `translate(${(b.left - r0.left - (p0.left - r0.left) * k).toFixed(1)}px, ${(b.top - r0.top - (p0.top - r0.top) * k).toFixed(1)}px) scale(${k.toFixed(4)})`;
    let flyAt;
    if (reduced) {
      A(ri, [{ opacity: 0 }, { opacity: 1 }], { duration: 500 });
      flyAt = 900;
      setTimeout(() => A(ri, [{ transform: 'none' }, { transform: fly }], { duration: 10 }), flyAt - 20);
    } else {
      const len = mark.getTotalLength();
      mark.style.strokeDasharray = `${len} ${len}`;
      A(mark, [{ strokeDashoffset: len, fillOpacity: 0, strokeWidth: 9 }, { strokeDashoffset: 0, fillOpacity: 0, strokeWidth: 9, offset: .7 }, { strokeDashoffset: 0, fillOpacity: 1, strokeWidth: 0 }], { duration: 1400, delay: 100, easing: smooth });
      A(markSvg, [{ transform: 'scale(.92)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }], { duration: 700, easing: spring });
      letters.forEach((l, i) => A(l, [{ opacity: 0, transform: 'translateX(-12px)', filter: 'blur(8px)' }, { opacity: 1, transform: 'none', filter: 'blur(0)' }], { duration: 700, delay: 950 + i * 110, easing: spring }));
      // Open: RE·de de·IN·tenções, the acronym letters turn blue while the rest writes in
      const widths = () => {
        const open = xs.map(x => { x.style.width = 'auto'; const w = x.getBoundingClientRect().width; x.style.width = '0px'; return w; });
        const late = performance.now() - t0;
        xs.forEach((x, i) => A(x, [{ width: '0px', easing: smooth }, { width: `${open[i]}px`, offset: .35 }, { width: `${open[i]}px`, offset: .78, easing: smooth }, { width: '0px' }], { duration: 2600, delay: Math.max(0, 1650 - late) }));
      };
      (document.fonts?.load('300 68px Inter') || Promise.resolve()).then(widths, widths);
      $$('.ri-c', ov).forEach(c => { const n = +c.style.getPropertyValue('--k'); A(c, [{ opacity: 0, transform: 'translateY(10px)', filter: 'blur(6px)', easing: 'cubic-bezier(.2,.7,.2,1)' }, { opacity: 1, transform: 'none', filter: 'blur(0)', offset: .3 }, { opacity: 1, transform: 'none', filter: 'blur(0)', offset: .74, easing: 'ease-in' }, { opacity: 0, transform: 'translateY(-6px)', filter: 'blur(4px)' }], { duration: 2500, delay: 1720 + n * 45 }); });
      letters.forEach(l => A(l, [{ color: 'var(--label)', easing: 'ease-in-out' }, { color: 'var(--accent)', offset: .3 }, { color: 'var(--accent)', offset: .74, easing: 'ease-in-out' }, { color: 'var(--label)' }], { duration: 2600, delay: 1650 }));
      A(tag, [{ opacity: 0, transform: 'translateY(8px)', easing: 'ease-out' }, { opacity: 1, transform: 'none', offset: .3 }, { opacity: 1, transform: 'none', offset: .75, easing: 'ease-in' }, { opacity: 0, transform: 'translateY(-4px)' }], { duration: 2400, delay: 1900 });
      // Closed again, the row is the logotype; it flies to the title bar as it is
      flyAt = 4500;
      setTimeout(() => A(ri, [{ transform: 'none' }, { transform: fly }], { duration: 900, easing: spring }), flyAt - 20);
      // The window unfolds out of it
      const w = win.getBoundingClientRect(), cx = r0.left + r0.width / 2 - w.left, cy = r0.top + r0.height / 2 - w.top;
      const clip = `inset(${Math.max(0, cy - 40)}px ${Math.max(0, w.width - cx - 160)}px ${Math.max(0, w.height - cy - 40)}px ${Math.max(0, cx - 160)}px round 40px)`;
      A(win, [{ clipPath: clip, opacity: 0, transform: 'scale(.985)', easing: 'ease-out' }, { clipPath: clip, opacity: 1, transform: 'scale(.99)', offset: .12, easing: spring }, { clipPath: 'inset(0px 0px 0px 0px round 36px)', opacity: 1, transform: 'none' }], { duration: 1300, delay: flyAt - 80 });
    }
    // Hand-off: the moment the row lands, the title-bar logo takes its place, pixel for pixel
    const land = flyAt + (reduced ? 20 : 920);
    A(ov, [{ opacity: 1 }, { opacity: 1, offset: .999 }, { opacity: 0 }], { duration: land });
    A(brand, [{ opacity: 0 }, { opacity: 0, offset: .999 }, { opacity: 1 }], { duration: land });
    const w0 = flyAt - (reduced ? 200 : 60);
    if (reduced) A(win, [{ opacity: 0 }, { opacity: 1 }], { duration: 500, delay: w0 });
    A(nav, reduced ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: 'translateX(-30px) scale(.96)' }, { opacity: 1, transform: 'none' }], { duration: reduced ? 500 : 1000, delay: w0 + 380, easing: spring });
    if (!reduced) {
      $$('.nav a').forEach((a, i) => A(a, [{ opacity: 0, transform: 'translateY(10px) scale(.9)' }, { opacity: 1, transform: 'none' }], { duration: 650, delay: w0 + 480 + i * 60, easing: spring }));
      A($('[data-nav-ind]'), [{ opacity: 0, scale: '.7' }, { opacity: 1, scale: '1' }], { duration: 760, delay: w0 + 620, easing: spring });
      A(head, [{ opacity: 0, transform: 'translateY(12px)', filter: 'blur(6px)' }, { opacity: 1, transform: 'none', filter: 'blur(0)' }], { duration: 900, delay: w0 + 420, easing: spring });
      tools.forEach((t, i) => A(t, [{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'none' }], { duration: 500, delay: w0 + 800 + i * 45, easing: 'ease-out' }));
    }
    if (!comp.hidden) A(comp, reduced ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: 'translateY(50px) scale(.97)' }, { opacity: 1, transform: 'none' }], { duration: reduced ? 500 : 1100, delay: w0 + (reduced ? 0 : 1500), easing: spring });
    if (R.page === 'topology') anims.push(...R.topology.intro(w0 + 600));
    else stage.classList.add('is-live');
    root.classList.remove('is-opening');
    const skip = () => anims.forEach(a => a.finish());
    addEventListener('pointerdown', skip, { once: true });
    addEventListener('keydown', skip, { once: true });
    // If the animation clock never starts (some embedded or headless views), land in the final state
    let guard;
    const arm = () => { clearTimeout(guard); if (!document.hidden) guard = setTimeout(() => { if (anims.some(a => a.playState === 'running' && (a.currentTime || 0) < 100)) skip(); }, 8200); };
    arm();
    document.addEventListener('visibilitychange', arm);
    // Design review: ?introAt=2600 freezes the opening at that moment
    const at = +new URLSearchParams(location.search).get('introAt');
    if (at) setTimeout(() => { clearTimeout(guard); anims.forEach(a => { a.pause?.(); if ('currentTime' in a) a.currentTime = Math.max(0, at - (a.off || 0)); }); }, flyAt + 60);
    Promise.all(anims.map(a => a.finished)).catch(() => {}).then(() => {
      removeEventListener('pointerdown', skip); removeEventListener('keydown', skip);
      clearTimeout(guard); document.removeEventListener('visibilitychange', arm);
      anims.forEach(a => a.cancel?.());
      ov.remove();
    });
  }

  // Start
  R.page = null;
  go(location.hash.slice(1) || 'topology');
  R.topology.render();
  R.topology.fit(false);
  R.intents.render();
  opening();
  R.booted = true;

  // ?demo=map|link|node|video|host|card|ask opens one state directly, for design review
  const demo = new URLSearchParams(location.search).get('demo');
  if (demo) setTimeout(() => ({
    map: () => $('[data-tool="map"]').click(),
    link: () => R.topology.openLink(R.model.links[0].id),
    node: () => R.topology.openNode('cl0'),
    video: () => R.openVideo('cl0'),
    host: () => R.openHostSheet(),
    card: () => R.profile(L`Block SSH for the client in SP`),
    chat: () => { location.hash = 'intents'; setTimeout(() => R.profile(L`Block SSH for the client in SP`, 'Intents'), 300); },
    chatask: () => { location.hash = 'intents'; setTimeout(() => R.profile(L`Improve the video`, 'Intents'), 300); },
    ask: () => R.profile(L`Improve the video`),
    switch: () => { $('[data-tool="add"]').click(); setTimeout(() => $('[data-pop="add"] [data-add="switch"]').click(), 100); },
    services: () => R.openServices('acl'),
    traffic: () => R.openTraffic('cl0'),
    tlog: async () => { const s = await R.traffic.start({ tool: 'iperf3', client: 'cl0', server: 'ds0', reverse: true, proto: 'tcp', rate: 35, port: 5201, duration: 0, out: R.traffic.defaults('iperf3') }); setTimeout(() => $(`[data-tp-log="${s.id}"]`)?.click(), 3000); },
    iface: () => { $('[data-node="s0"]').dispatchEvent(new PointerEvent('pointerover', { bubbles: true })); setTimeout(() => $('.ifdot[data-if="s0s2"]')?.click(), 200); },
    nodecli: () => { R.topology.openNode('cl0'); setTimeout(() => $('[data-pop="node"] [data-ntab="cli"]')?.click(), 100); },
    help: () => { location.hash = 'intents'; setTimeout(() => { $('[data-help]').click(); $('[data-hsec="bnf"]').click(); }, 300); },
    helpex: () => { location.hash = 'intents'; setTimeout(() => { $('[data-help]').click(); $('[data-hsec="ex"]').click(); }, 300); },
    applied: () => { location.hash = 'intents'; setTimeout(() => $('[data-imode="applied"]').click(), 300); },
    xcfg: () => { location.hash = 'experiments'; setTimeout(() => $('[data-x-config="diamond"]').click(), 300); },
    xnew: () => { location.hash = 'experiments'; setTimeout(() => { $('[data-x-new]').click(); setTimeout(() => $('.xtl-col[data-b-snap="1"]')?.click(), 100); }, 300); },
    // builder with a plan client on s2, a second flow to it and a capture event
    xplan: () => { location.hash = 'experiments'; setTimeout(() => { $('[data-x-new]').click(); const q = s => $(`[data-slot="experiments"] ${s}`); setTimeout(() => { q('[data-b-mode="client"]').click(); q('[data-b-sw="s2"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })); q('[data-b-sel=""]')?.click(); q('[data-b-add="flow"]').click(); q('[data-b-add="event"]').click(); q('[data-fs="kind"][data-v="capture"]')?.click(); q('.xtl-bar:not(.is-sel)')?.closest('.xtl-row')?.querySelector('.xtl-lab')?.click(); q('.xtl-col[data-b-snap="2"]')?.click(); }, 150); }, 300); },
    xrun: () => { location.hash = 'experiments'; setTimeout(() => { $('[data-x-config="diamond"]').click(); setTimeout(() => $('[data-x-start]').click(), 100); }, 300); },
    rnp: async () => { R.importPy(await (await fetch('samples/rnp.py')).text(), 'rnp.py'); if (!R.topology.mapMode) $('[data-tool="map"]').click(); },
  }[demo] || (() => {}))(), 900);
})();

/* Liquid glass under the pointer. There is no separate lens: the navigation bar itself bulges,
   its icons and labels swell and bend where the pointer rests, and the main window does the same,
   more faintly. Where the effect acts, the glass brightens from the pointer outwards and fades
   to nothing at the edge of the radius; there is no outline. Built from an SVG displacement
   filter whose map follows the pointer; pointer, focus and hit areas never move. */
(() => {
  'use strict';
  const R = window.REIN, $ = R.$;
  const fine = matchMedia('(hover: hover) and (pointer: fine)');
  const NS = 'http://www.w3.org/2000/svg';

  // A bulge: every pixel samples a little closer to the centre (magnifies), fading to nothing at
  // the rim so the edge of the effect is invisible
  function bulgeMap(size) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d'), img = g.createImageData(size, size), d = img.data, K = 3.38;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const nx = (x + .5) / size * 2 - 1, ny = (y + .5) / size * 2 - 1, r = Math.hypot(nx, ny);
      const f = r < 1 ? (1 - r) * (1 - r) * K : 0, i = (y * size + x) * 4;
      d[i] = 128 - nx * f * 127; d[i + 1] = 128 - ny * f * 127; d[i + 2] = 128; d[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    return c.toDataURL();
  }
  const MAP = bulgeMap(96);

  const defs = document.createElementNS(NS, 'svg');
  defs.setAttribute('width', '0'); defs.setAttribute('height', '0'); defs.setAttribute('aria-hidden', 'true');
  defs.style.position = 'absolute';
  const filter = id => `<filter id="${id}" filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse" color-interpolation-filters="sRGB" x="0" y="0" width="100" height="100">
      <feFlood flood-color="rgb(128,128,128)" result="n"/>
      <feImage href="${MAP}" x="-999" y="-999" width="10" height="10" preserveAspectRatio="none" result="m"/>
      <feComposite in="m" in2="n" operator="over" result="map"/>
      <feDisplacementMap in="SourceGraphic" in2="map" scale="0" xChannelSelector="R" yChannelSelector="G"/>
    </filter>`;
  defs.innerHTML = filter('lens-nav') + filter('lens-main');
  document.body.prepend(defs);

  // glow: an element that brightens what is behind it, masked to fade from the pointer outwards
  function lens(id, el, { radius, strength, glow, host, stretch = 0 }) {
    const f = defs.querySelector(`#${id}`), img = f.querySelector('feImage'), disp = f.querySelector('feDisplacementMap');
    const st = { x: 0, y: 0, tx: 0, ty: 0, s: 0, ts: 0, raf: 0, on: false, box: null, hbox: null };
    glow.style.setProperty('--r', `${radius}px`);
    const size = () => { st.box = el.getBoundingClientRect(); st.hbox = host.getBoundingClientRect(); f.setAttribute('width', Math.ceil(st.box.width)); f.setAttribute('height', Math.ceil(st.box.height)); };
    function frame() {
      st.raf = 0;
      // Close follow: the bulge trails the pointer by a hair, never visibly
      const k = R.reduced.matches ? 1 : .55;
      st.x += (st.tx - st.x) * k; st.y += (st.ty - st.y) * k; st.s += (st.ts - st.s) * (R.reduced.matches ? 1 : .3);
      img.setAttribute('x', (st.x - radius).toFixed(1)); img.setAttribute('y', (st.y - radius).toFixed(1));
      img.setAttribute('width', radius * 2); img.setAttribute('height', radius * 2);
      disp.setAttribute('scale', (st.s * strength).toFixed(2));
      glow.style.opacity = st.s.toFixed(3);
      if (stretch) host.style.setProperty('--ls', (st.s * stretch).toFixed(4));
      const moving = Math.abs(st.tx - st.x) + Math.abs(st.ty - st.y) > .3 || Math.abs(st.ts - st.s) > .004;
      if (moving) st.raf = requestAnimationFrame(frame);
      else if (st.ts === 0) { el.classList.remove('is-lensing'); st.on = false; }
    }
    const kick = () => { if (!st.raf) st.raf = requestAnimationFrame(frame); };
    return {
      move(cx, cy, s = 1) {
        if (!st.on) { size(); el.classList.add('is-lensing'); st.on = true; st.x = cx - st.box.left; st.y = cy - st.box.top; }
        st.tx = cx - st.box.left; st.ty = cy - st.box.top; st.ts = s;
        // The light sits exactly under the pointer, with no lag
        glow.style.transform = `translate(${(cx - st.hbox.left - radius).toFixed(1)}px, ${(cy - st.hbox.top - radius).toFixed(1)}px)`;
        host.style.setProperty('--lx', `${cx - st.hbox.left}px`); host.style.setProperty('--ly', `${cy - st.hbox.top}px`);
        kick();
      },
      rest(s) { st.ts = s; kick(); },
      resize: size,
    };
  }
  const glowIn = host => { const g = document.createElement('i'); g.className = 'lens-glow'; g.setAttribute('aria-hidden', 'true'); host.append(g); return g; };

  // ---------------------------------------------------------------- the navigation bar
  const nav = $('.nav');
  const inner = document.createElement('div');
  inner.className = 'nav-in';
  while (nav.firstChild) inner.append(nav.firstChild);
  nav.append(inner);
  const navLens = lens('lens-nav', inner, { radius: 40, strength: 12, stretch: 1, glow: glowIn(nav), host: nav });
  let navIdle;
  nav.addEventListener('pointermove', e => {
    if (!fine.matches || e.pointerType === 'touch') return;
    navLens.move(e.clientX, e.clientY, 1);
    clearTimeout(navIdle);
    navIdle = setTimeout(() => navLens.rest(.6), 400);
  });
  nav.addEventListener('pointerleave', () => { clearTimeout(navIdle); navLens.rest(0); });

  // ---------------------------------------------------------------- the main window, fainter
  const pages = $('.pages');
  const win = $('.window');
  const mainLens = lens('lens-main', pages, { radius: 72, strength: 5, glow: glowIn(win), host: win });
  let mainIdle;
  const quiet = t => t.closest('input, textarea, select, [contenteditable="true"], .pmenu, .code, .log, .cmd, pre, .composer');
  pages.addEventListener('pointermove', e => {
    if (!fine.matches || e.pointerType === 'touch') return;
    // Never while dragging, panning, typing or reading code
    if (e.buttons || quiet(e.target)) { mainLens.rest(0); return; }
    mainLens.move(e.clientX, e.clientY, 1);
    clearTimeout(mainIdle);
    // When the pointer rests the console settles back to plain glass, so nothing renders twice
    mainIdle = setTimeout(() => mainLens.rest(0), 500);
  });
  pages.addEventListener('pointerleave', () => { clearTimeout(mainIdle); mainLens.rest(0); });
  pages.addEventListener('pointerdown', () => mainLens.rest(0));
  addEventListener('resize', () => { navLens.resize(); mainLens.resize(); });
  R.on(type => { if (type === 'page') mainLens.rest(0); });
})();

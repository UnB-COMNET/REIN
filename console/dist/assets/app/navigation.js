/* A single optical lens travels over the original navigation. Its enlarged copy is
   visual only: links, hit areas, focus and the selected page remain in the original DOM. */
(() => {
  'use strict';
  const R = window.REIN, nav = R.$('.nav');
  if (!nav || !window.gsap) return;
  const links = R.$$('a[data-nav]', nav);
  const fine = matchMedia('(hover:hover) and (pointer:fine)');
  const lens = document.createElement('div');
  lens.className = 'nav-lens';
  lens.setAttribute('aria-hidden', 'true');
  const content = document.createElement('div');
  content.className = 'nav-lens-content';
  const copies = links.map(a => {
    const copy = document.createElement('div');
    copy.className = 'nav-refraction';
    copy.innerHTML = a.innerHTML;
    content.append(copy);
    return copy;
  });
  lens.append(content);
  nav.append(lens);
  nav.classList.add('has-lens');

  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const state = { x:0, y:0, reveal:0, magnify:1 };
  let target = { x:0, y:0 }, boxes = [], bounds, horizontal, width, height;
  let motion, pointerInside = false, frame = 0, lastPointer;

  function selection() {
    copies.forEach((copy, i) => copy.classList.toggle('is-current', links[i].hasAttribute('aria-current')));
  }
  function measure() {
    bounds = nav.getBoundingClientRect();
    horizontal = getComputedStyle(nav).gridAutoFlow === 'column';
    boxes = links.map((a, i) => {
      const box = { x:a.offsetLeft, y:a.offsetTop, w:a.offsetWidth, h:a.offsetHeight };
      Object.assign(copies[i].style, { left:`${box.x}px`, top:`${box.y}px`, width:`${box.w}px`, height:`${box.h}px` });
      return box;
    });
    width = horizontal ? Math.max(...boxes.map(b => b.w)) + 16 : nav.offsetWidth + 10;
    height = horizontal ? nav.offsetHeight + 8 : boxes[0].h + 14;
    lens.style.width = `${width}px`;
    lens.style.height = `${height}px`;
    content.style.width = `${nav.offsetWidth}px`;
    content.style.height = `${nav.offsetHeight}px`;
    selection();
  }

  function paint() {
    // Lag stretches the glass along its travel; a stopped pointer restores its shape.
    const dx = target.x - state.x, dy = target.y - state.y;
    const stretch = Math.min(.24, Math.abs(horizontal ? dx : dy) / 190) * state.reveal;
    const sx = horizontal ? 1 + stretch : 1 - stretch * .22;
    const sy = horizontal ? 1 - stretch * .22 : 1 + stretch;
    const bend = clamp((horizontal ? dx : dy) / 5, -9, 9);
    lens.style.transform = `translate3d(${state.x-width/2}px,${state.y-height/2}px,0) scale(${sx},${sy})`;
    lens.style.opacity = state.reveal;
    lens.style.borderRadius = `${38-bend}% ${42+bend}% ${38-bend}% ${42+bend}% / ${42+bend}% ${38-bend}% ${42+bend}% ${38-bend}%`;
    // Counter-scale the copy so only the glass stretches, never the lettering.
    const mx = state.magnify / sx, my = state.magnify / sy;
    content.style.transform = `translate3d(${width/2-state.x*mx}px,${height/2-state.y*my}px,0) scale(${mx},${my})`;
  }

  function move(x, y, index) {
    const b = boxes[index], cx = b.x + b.w/2, cy = b.y + b.h/2;
    target = {
      x:horizontal ? cx + (x-cx)*.38 : cx + clamp(x-cx,-38,38)*.17,
      y:horizontal ? cy + clamp(y-cy,-26,26)*.17 : cy + (y-cy)*.38
    };
    lens.style.setProperty('--lens-light-x', `${clamp(50+(x-cx)*1.2,12,88)}%`);
    lens.style.setProperty('--lens-light-y', `${clamp(38+(y-cy)*.8,12,88)}%`);
    if (state.reveal < .02) { state.x = target.x; state.y = target.y; }
    motion?.kill();
    if (R.reduced.matches) {
      Object.assign(state, target, { reveal:1, magnify:1 });
      paint();
      return;
    }
    motion = gsap.to(state, { ...target, reveal:1, magnify:1.19, duration:.55, ease:'power3.out', onUpdate:paint });
  }

  function hide(immediate = false) {
    cancelAnimationFrame(frame); frame = 0;
    motion?.kill();
    if (immediate || R.reduced.matches) { state.reveal = 0; paint(); return; }
    motion = gsap.to(state, { reveal:0, magnify:1.04, duration:.28, ease:'power2.out', onUpdate:paint });
  }
  function follow() {
    frame = 0;
    const x = lastPointer.x-bounds.left, y = lastPointer.y-bounds.top;
    let nearest = 0, distance = Infinity;
    boxes.forEach((b,i) => {
      const d = Math.abs(horizontal ? x-b.x-b.w/2 : y-b.y-b.h/2);
      if (d < distance) { distance = d; nearest = i; }
    });
    move(x, y, nearest);
  }
  nav.addEventListener('pointerenter', e => {
    if (!fine.matches || e.pointerType === 'touch') return;
    pointerInside = true; measure();
  });
  nav.addEventListener('pointermove', e => {
    if (!fine.matches || e.pointerType === 'touch') return;
    lastPointer = { x:e.clientX, y:e.clientY };
    if (!frame) frame = requestAnimationFrame(follow);
  });
  nav.addEventListener('pointerleave', () => { pointerInside = false; hide(); });
  nav.addEventListener('pointercancel', () => { pointerInside = false; hide(); });
  nav.addEventListener('focusin', e => {
    if (pointerInside) return;
    const index = links.indexOf(e.target);
    if (index < 0) return;
    measure();
    const b = boxes[index];
    move(b.x+b.w/2,b.y+b.h/2,index);
  });
  nav.addEventListener('focusout', e => { if (!nav.contains(e.relatedTarget) && !pointerInside) hide(); });
  nav.addEventListener('keydown', e => { if (e.key === 'Escape') hide(); });
  R.on(type => { if (type === 'page') selection(); });
  R.reduced.addEventListener('change', () => hide(true));
  fine.addEventListener('change', () => hide(true));
  addEventListener('blur', () => { pointerInside = false; hide(true); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) hide(true); });
  new ResizeObserver(() => { measure(); hide(true); }).observe(nav);
  document.fonts?.ready.then(measure);
  measure();
})();

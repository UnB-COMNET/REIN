/* Shared interface pieces: anchored popovers, notifications, Nile highlighting, small helpers. */
(() => {
  'use strict';
  const R = window.REIN;
  R.$ = (s, r = document) => r.querySelector(s);
  R.$$ = (s, r = document) => [...r.querySelectorAll(s)];
  R.icon = (id, cls = '') => `<svg class="${cls}" aria-hidden="true"><use href="#${id}"/></svg>`;

  // Nile syntax highlight: keywords, functions, strings
  R.highlight = nile => R.esc(nile)
    .replace(/(&#39;[^&]*?&#39;)/g, '<span class="str">$1</span>')
    .replace(/\b(define intent|from|for|to|add|remove|block|allow|set|unset|start|end)\b/g, '<span class="k">$1</span>')
    .replace(/\b(endpoint|service|protocol|group|traffic|middlebox|bandwidth|quota|hour|date|datetime|timestamp)(?=\()/g, '<span class="fn">$1</span>');

  // ------------------------------------------------------------ popovers
  let open = null;
  R.pop = {
    get current() { return open; },
    open(el, x, y, { prefer = 'below', trigger = null, key = null, onClose = null } = {}) {
      R.pop.close(true);
      el.hidden = false;
      if (innerWidth >= 900) {
        const w = el.offsetWidth, h = el.offsetHeight, m = 12, gap = 18, head = 96;
        const fitsBelow = y + gap + h <= innerHeight - m, fitsAbove = y - gap - h >= head;
        let top, left, side;
        if ((prefer === 'above' && fitsAbove) || (prefer !== 'above' && !fitsBelow && fitsAbove)) { top = y - h - gap; side = 'above'; }
        else if (fitsBelow) { top = y + gap; side = 'below'; }
        if (top === undefined) {
          // Neither above nor below: sit beside the anchor, vertically centred on it
          side = x + gap + w <= innerWidth - m ? 'right' : 'left';
          left = side === 'right' ? x + gap : x - gap - w;
          top = Math.max(head, Math.min(y - h / 2, innerHeight - h - m));
        } else left = Math.max(m, Math.min(x - w / 2, innerWidth - w - m));
        el.style.left = `${left}px`; el.style.top = `${top}px`;
        el.dataset.side = side;
        el.style.setProperty('--ox', `${Math.max(0, Math.min(w, x - left))}px`); el.style.setProperty('--oy', `${Math.max(0, Math.min(h, y - top))}px`);
      }
      else delete el.dataset.side;
      el.tabIndex = -1;
      open = { el, trigger, key, onClose };
      trigger?.setAttribute('aria-expanded', 'true');
      requestAnimationFrame(() => el.focus({ preventScroll: true }));
    },
    close(immediate = false) {
      if (!open) return;
      const { el, trigger, onClose } = open;
      open = null;
      trigger?.setAttribute('aria-expanded', 'false');
      onClose?.();
      if (immediate || R.reduced.matches) { el.hidden = true; return; }
      el.classList.add('is-leaving');
      setTimeout(() => { el.hidden = true; el.classList.remove('is-leaving'); }, 160);
      if (trigger?.isConnected && el.contains(document.activeElement)) trigger.focus({ preventScroll: true });
    },
  };
  document.addEventListener('pointerdown', e => {
    if (open && !open.el.contains(e.target) && !e.target.closest('[data-keep-pop]')) R.pop.close();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && open) { e.stopPropagation(); R.pop.close(); } }, true);

  // ------------------------------------------------------------ notifications (assurance events and results)
  R.notify = ({ source, text, tone = '' }) => {
    const box = R.$('[data-notices]');
    if (!box) return;
    const el = document.createElement('div');
    el.className = `notice${tone ? ` ${tone}` : ''}`;
    el.innerHTML = `<span class="ic">${tone === 'ok' ? R.icon('i-check') : '<svg viewBox="0 0 534 400" aria-hidden="true"><use href="#rein-mark"/></svg>'}</span><b>${R.esc(source)}</b><time>agora</time><p>${R.esc(text)}</p>`;
    box.prepend(el);
    [...box.children].slice(3).forEach(n => n.remove());
    setTimeout(() => { el.classList.add('is-leaving'); setTimeout(() => el.remove(), 350); }, 6000);
  };

  // Blocks marked .reveal rise into place when they scroll into view; replayed each time a page opens
  let io = null;
  R.revealIn = root => {
    const items = [...root.querySelectorAll('.reveal:not(.is-in)')];
    if (!items.length) return;
    if (R.reduced.matches || !('IntersectionObserver' in window)) { items.forEach(e => e.classList.add('is-in')); return; }
    io ||= new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target); } }), { threshold: 0.12 });
    items.forEach(e => io.observe(e));
    // Some embedded views never report intersections: nothing stays hidden for long
    setTimeout(() => items.forEach(e => { if (!e.classList.contains('is-in') && e.getBoundingClientRect().top < innerHeight) e.classList.add('is-in'); }), 1400);
  };
  R.replay = root => { root.querySelectorAll('.reveal.is-in').forEach(e => e.classList.remove('is-in')); requestAnimationFrame(() => R.revealIn(root)); };

  // Range inputs paint their filled track through --p
  R.paintRange = inp => { const min = +inp.min, max = +inp.max; inp.style.setProperty('--p', `${((+inp.value - min) / (max - min)) * 100}%`); };
  document.addEventListener('input', e => { if (e.target.matches?.('input[type="range"]')) R.paintRange(e.target); });
})();

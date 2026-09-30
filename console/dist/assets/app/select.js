/* Pop-up buttons in the macOS manner. Every <select> in the console is paired with a button that
   opens a native-looking menu: the chosen item opens over the button, the highlight is the accent
   blue, arrows, Return, Escape and type-ahead work. The <select> stays in the form and keeps
   firing its usual change events, so the rest of the code keeps reading it as before. */
(() => {
  'use strict';
  const R = window.REIN;
  const proto = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  const protoIdx = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex');
  let menu = null, owner = null, active = -1, typed = '', typedAt = 0;

  const label = sel => sel.options[sel.selectedIndex]?.textContent.trim() || '';
  function sync(sel) {
    const b = sel.__btn;
    if (!b) return;
    b.querySelector('.pb-t').textContent = label(sel);
    b.disabled = sel.disabled;
  }

  function enhance(sel) {
    if (sel.__btn || sel.closest('[data-native-select]')) return;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `pbtn${sel.classList.contains('popup') ? '' : ' is-field'}`;
    b.setAttribute('aria-haspopup', 'listbox');
    b.setAttribute('aria-expanded', 'false');
    const name = sel.getAttribute('aria-label') || sel.closest('label')?.querySelector('span')?.textContent || '';
    if (name) b.setAttribute('aria-label', `${name}: ${label(sel)}`);
    b.innerHTML = '<span class="pb-t"></span><i class="pb-w" aria-hidden="true"><svg viewBox="0 0 10 14"><path d="M2 5l3-3 3 3M2 9l3 3 3-3"/></svg></i>';
    if (sel.style.gridColumn) b.style.gridColumn = sel.style.gridColumn;
    sel.after(b);
    sel.classList.add('sel-native');
    sel.tabIndex = -1;
    sel.__btn = b;
    // Programmatic changes (select.value = …) keep the button in step
    Object.defineProperty(sel, 'value', { configurable: true, get() { return proto.get.call(this); }, set(v) { proto.set.call(this, v); sync(this); } });
    Object.defineProperty(sel, 'selectedIndex', { configurable: true, get() { return protoIdx.get.call(this); }, set(v) { protoIdx.set.call(this, v); sync(this); } });
    new MutationObserver(() => sync(sel)).observe(sel, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
    sel.addEventListener('change', () => sync(sel));
    sel.addEventListener('focus', () => b.focus());
    b.addEventListener('click', () => (owner === sel ? close() : open(sel)));
    b.addEventListener('keydown', e => { if (['ArrowDown', 'ArrowUp', ' ', 'Enter'].includes(e.key)) { e.preventDefault(); open(sel); } });
    sync(sel);
  }

  function open(sel) {
    close(true);
    owner = sel;
    const b = sel.__btn;
    menu = document.createElement('div');
    menu.className = 'pmenu';
    menu.setAttribute('role', 'listbox');
    menu.tabIndex = -1;
    const opts = [...sel.options];
    menu.innerHTML = opts.map((o, i) => {
      const group = o.parentElement.tagName === 'OPTGROUP' && o.parentElement.firstElementChild === o ? `<p class="pm-g">${R.esc(o.parentElement.label)}</p>` : '';
      return `${group}<div class="pm-i${o.disabled ? ' is-off' : ''}" role="option" data-i="${i}" aria-selected="${o.selected}" aria-disabled="${o.disabled}"><i class="pm-c">${o.selected ? '<svg viewBox="0 0 24 24"><path d="m5.5 12.5 4 4 9-9.5"/></svg>' : ''}</i><span>${R.esc(o.textContent.trim())}</span>${o.dataset.hint ? `<em>${R.esc(o.dataset.hint)}</em>` : ''}</div>`;
    }).join('');
    document.body.append(menu);
    const r = b.getBoundingClientRect();
    menu.style.minWidth = `${Math.max(r.width + 24, 160)}px`;
    const item = menu.querySelector(`[data-i="${sel.selectedIndex}"]`);
    const itemTop = item ? item.offsetTop : 6;
    // The chosen item opens exactly over the button, as a macOS pop-up does
    let top = r.top + r.height / 2 - (itemTop + (item?.offsetHeight || 26) / 2);
    const h = menu.offsetHeight;
    top = Math.max(8, Math.min(top, innerHeight - h - 8));
    let left = r.left - 8;
    left = Math.max(8, Math.min(left, innerWidth - menu.offsetWidth - 8));
    menu.style.top = `${top}px`; menu.style.left = `${left}px`;
    menu.style.transformOrigin = `${r.left + r.width / 2 - left}px ${r.top + r.height / 2 - top}px`;
    b.setAttribute('aria-expanded', 'true');
    b.classList.add('is-open');
    setActive(sel.selectedIndex);
    menu.focus({ preventScroll: true });
    menu.addEventListener('pointermove', e => { const it = e.target.closest('.pm-i:not(.is-off)'); if (it) setActive(+it.dataset.i); });
    menu.addEventListener('pointerleave', () => setActive(-1));
    menu.addEventListener('click', e => { const it = e.target.closest('.pm-i:not(.is-off)'); if (it) choose(+it.dataset.i); });
    menu.addEventListener('keydown', onKey);
  }
  function setActive(i) {
    active = i;
    menu?.querySelectorAll('.pm-i').forEach(el => el.classList.toggle('is-active', +el.dataset.i === i));
    menu?.querySelector('.pm-i.is-active')?.scrollIntoView({ block: 'nearest' });
  }
  function step(d) {
    const opts = [...owner.options];
    let i = active < 0 ? owner.selectedIndex : active;
    for (let k = 0; k < opts.length; k++) { i = (i + d + opts.length) % opts.length; if (!opts[i].disabled) break; }
    setActive(i);
  }
  function onKey(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); step(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); step(-1); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (active >= 0) choose(active); }
    else if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key.length === 1) {
      const now = Date.now();
      typed = now - typedAt < 700 ? typed + e.key.toLowerCase() : e.key.toLowerCase();
      typedAt = now;
      const i = [...owner.options].findIndex(o => !o.disabled && o.textContent.trim().toLowerCase().startsWith(typed));
      if (i >= 0) setActive(i);
    }
  }
  function choose(i) {
    const sel = owner;
    const changed = sel.selectedIndex !== i;
    // A short blink on the chosen item, then the menu goes, as on the Mac
    const it = menu.querySelector(`[data-i="${i}"]`);
    it?.classList.add('is-blink');
    setTimeout(() => {
      close();
      if (changed) {
        protoIdx.set.call(sel, i);
        sync(sel);
        sel.dispatchEvent(new Event('input', { bubbles: true }));
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, R.reduced.matches ? 0 : 110);
  }
  function close(immediate = false) {
    if (!menu) return;
    const m = menu, b = owner?.__btn;
    menu = null;
    b?.setAttribute('aria-expanded', 'false');
    b?.classList.remove('is-open');
    if (b && !immediate) b.focus({ preventScroll: true });
    owner = null; active = -1;
    if (immediate || R.reduced.matches) { m.remove(); return; }
    m.classList.add('is-leaving');
    setTimeout(() => m.remove(), 140);
  }
  document.addEventListener('pointerdown', e => { if (menu && !menu.contains(e.target) && !e.target.closest('.pbtn.is-open')) close(true); }, true);
  addEventListener('resize', () => close(true));
  document.addEventListener('scroll', e => { if (menu && !menu.contains(e.target)) close(true); }, true);

  R.enhanceSelects = (root = document) => root.querySelectorAll('select').forEach(enhance);
  // Forms are rendered from templates; new selects are paired as soon as they appear
  new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => { if (n.nodeType !== 1) return; if (n.tagName === 'SELECT') enhance(n); else n.querySelectorAll?.('select').forEach(enhance); }))).observe(document.documentElement, { childList: true, subtree: true });
  R.enhanceSelects();
})();

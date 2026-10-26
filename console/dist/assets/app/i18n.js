/* The console's language. English is what the scripts write; Portuguese (pt.js) is an option kept in
   this browser (localStorage rein.lang = 'pt').
     L`Route of ${id}: ${path}.`   text with values
     L(role)                      a value known only when it runs */
(() => {
  'use strict';
  let lang = 'en';
  try { if (localStorage.getItem('rein.lang') === 'pt') lang = 'pt'; } catch { /* private mode */ }
  const pt = lang === 'pt' ? window.REIN_PT : null;
  const L = window.L = (strings, ...values) => {
    if (typeof strings === 'string') return pt?.text[strings] ?? strings;
    const text = pt?.text[strings.join('{}')];
    if (!text) return strings.reduce((out, part, i) => out + values[i - 1] + part);
    let next = 0;
    return text.replace(/\{(\d*)\}/g, (_, i) => values[i === '' ? next++ : +i] ?? '');
  };
  L.lang = lang;
  L.locale = lang === 'pt' ? 'pt-BR' : 'en-US';
  // A progress line of lft or rein, in the console's language
  L.step = line => { for (const [re, say] of pt?.steps || []) { const m = line.match(re); if (m) return say(m); } return line; };
  L.set = to => { try { localStorage.setItem('rein.lang', to); } catch { /* private mode */ } location.reload(); };

  // index.html is written in English: in Portuguese, its text and labels are swapped once, before the
  // other scripts run
  if (pt) {
    document.documentElement.lang = 'pt-BR';
    const say = text => { const to = pt.text[text.replace(/\s*\n\s*/g, ' ').trim()]; return to === undefined ? null : text.replace(text.trim(), to); };
    const nodes = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node; (node = nodes.nextNode());) { const to = say(node.nodeValue); if (to !== null) node.nodeValue = to; }
    for (const name of ['aria-label', 'placeholder', 'title', 'data-tip', 'alt'])
      for (const el of document.querySelectorAll(`[${name}]`)) { const to = say(el.getAttribute(name)); if (to !== null) el.setAttribute(name, to); }
  }
  // The header's button shows the language in use and switches to the other
  const button = document.querySelector('[data-lang]');
  if (button) {
    button.textContent = lang.toUpperCase();
    button.dataset.tip = lang === 'pt' ? 'English' : 'Português';
    button.setAttribute('aria-label', lang === 'pt' ? 'Switch to English' : 'Mudar para português');
    button.addEventListener('click', () => L.set(lang === 'pt' ? 'en' : 'pt'));
  }
})();

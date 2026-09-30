/* Figures for Sobre, drawn in the visual language of Jacobs et al., "Establishing Trust for Using
   Natural Language for Intent-Based Networking" (IEEE TNSM 22(5), 2025), Figs. 1 and 2: chevron
   pipeline with icon badges, a thick ink arrow into a dark core, light cells with thin borders,
   chat bubbles, and network glyphs (switch squares, router circles, hexagons, a cloud).
   Colours were sampled from the paper's figure. */
(() => {
  'use strict';
  const R = window.REIN;
  const INK = '#333F3E', GRAY = '#8E91A1', BLUE = '#93B0D9', CELL = '#FFFAFF', LINE = '#A2A4A7', SQ = '#DBDEDB', SAL = '#DE9A8F', LAP = '#50595A';
  const T = (x, y, s, { size = 24, w = 300, anchor = 'middle', fill = INK, italic = false, cls = '' } = {}) => `<text x="${x}" y="${y}" font-size="${size}" font-weight="${w}" text-anchor="${anchor}" fill="${fill}"${italic ? ' font-style="italic"' : ''}${cls ? ` class="${cls}"` : ''}>${s}</text>`;
  const B = s => `<tspan font-weight="700">${s}</tspan>`;
  const lines = (x, y, arr, o = {}) => arr.map((s, i) => T(x, y + i * (o.lh || 29), s, o)).join('');

  // ---------------------------------------------------------------- glyphs
  const arrow = (x1, y, x2, w = 13, cls = 'pf-draw') => `<g class="pf-arrow"><path d="M${x1} ${y}H${x2 - 30}" stroke="${INK}" stroke-width="${w}" class="${cls}" pathLength="1"/><path d="M${x2 - 36} ${y - 21}L${x2} ${y}L${x2 - 36} ${y + 21}Z" fill="${INK}" class="pf-head"/></g>`;
  const doc = (x, y, label) => `<g class="pf-pop"><path d="M${x - 19} ${y}h30l9 9v44h-39z" fill="#fff" stroke="${INK}" stroke-width="2.4" stroke-linejoin="round"/><path d="M${x + 11} ${y}v9h9" fill="none" stroke="${INK}" stroke-width="2"/>${[0, 1, 2, 3, 4, 5, 6].map(k => `<path d="M${x - 12} ${y + 14 + k * 4.6}h24" stroke="${INK}" stroke-width="1.7"/>`).join('')}${T(x, y + 82, label, { size: 25 })}</g>`;
  const laptop = (x, y, label) => `<g class="pf-pop"><rect x="${x - 72}" y="${y - 50}" width="144" height="96" rx="9" fill="${LAP}"/><rect x="${x - 61}" y="${y - 40}" width="122" height="74" rx="3" fill="#fff"/><circle cx="${x - 16}" cy="${y - 7}" r="15" fill="#2096F2"/><circle cx="${x + 8}" cy="${y - 19}" r="5.5" fill="#F44336"/><circle cx="${x + 9}" cy="${y + 3}" r="6.5" fill="#FFEB3A"/><circle cx="${x + 21}" cy="${y - 8}" r="4" fill="#4CAF50"/><rect x="${x - 82}" y="${y + 46}" width="164" height="14" rx="7" fill="${LAP}"/><path d="M${x - 18} ${y + 53}h36" stroke="#fff" stroke-width="3" stroke-linecap="round"/><circle cx="${x + 50}" cy="${y + 53}" r="3.2" fill="#fff"/><circle cx="${x + 62}" cy="${y + 53}" r="3.2" fill="#fff"/>${label ? T(x, y + 98, label, { size: 25 }) : ''}</g>`;
  const swArrows = (x, y, k = 1) => `<path d="M${x - 14 * k} ${y - 6 * k}h24M${x + 4 * k} ${y - 12 * k}l7 ${6 * k} -7 ${6 * k}M${x + 14 * k} ${y + 7 * k}h-24M${x - 4 * k} ${y + 1 * k}l-7 ${6 * k} 7 ${6 * k}" fill="none" stroke="${INK}" stroke-width="${4.4 * k}" stroke-linecap="butt" stroke-linejoin="miter"/>`;
  const square = (x, y, s, fill, label, lx, ly, o = {}) => `<g class="pf-pop"><rect x="${x - s / 2}" y="${y - s / 2}" width="${s}" height="${s}" fill="${fill}"/>${swArrows(x, y, s / 46)}${label ? T(lx ?? x, ly ?? y + s / 2 + 28, label, { size: o.size || 24, ...o }) : ''}</g>`;
  const router = (x, y, r, fill, label, lx, ly) => `<g class="pf-pop"><circle cx="${x}" cy="${y}" r="${r}" fill="${fill}"/>${[[0, -1], [0, 1], [-1, 0], [1, 0]].map(([dx, dy]) => { const a = r * .22, b = r * .62; return `<path d="M${x + dx * a} ${y + dy * a}L${x + dx * b} ${y + dy * b}" stroke="${INK}" stroke-width="${r * .15}"/><path d="M${x + dx * (b + r * .12) - dy * r * .16} ${y + dy * (b + r * .12) - dx * r * .16}L${x + dx * (b + r * .3)} ${y + dy * (b + r * .3)}L${x + dx * (b + r * .12) + dy * r * .16} ${y + dy * (b + r * .12) + dx * r * .16}Z" fill="${INK}"/>`; }).join('')}${label ? T(lx ?? x, ly ?? y + r + 28, label, { size: 24 }) : ''}</g>`;
  const hex = (x, y, r, fill, label, o = {}) => `<g class="pf-pop"><path d="M${[0, 1, 2, 3, 4, 5].map(k => { const a = Math.PI / 3 * k + Math.PI / 6; return `${(x + r * Math.cos(a)).toFixed(1)} ${(y + r * Math.sin(a)).toFixed(1)}`; }).join('L')}Z" fill="${fill}"/>${T(x, y + (o.size || 22) * .36, label, { size: o.size || 22, w: 700 })}</g>`;
  const cloud = (x, y, label) => `<g class="pf-pop"><path d="M${x - 52} ${y + 24}h104a22 22 0 0 0 2-44a30 30 0 0 0-50-18a24 24 0 0 0-42 12a24 24 0 0 0-14 50z" fill="#fff" stroke="${INK}" stroke-width="2.6" stroke-linejoin="round"/>${T(x + 2, y + 13, label, { size: 25 })}</g>`;
  const check = (x, y, k = 1) => `<path d="M${x - 20 * k} ${y}l14 ${14 * k} 26 ${-28 * k}" fill="none" stroke="${INK}" stroke-width="${8 * k}" stroke-linecap="butt" stroke-linejoin="miter" class="pf-check"/>`;
  const bubble = (x, y, w, h, fill, tail, content) => `<g class="pf-bubble"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="11" fill="${fill}"/>${tail === 'l' ? `<path d="M${x + 22} ${y + h - 1}l0 14 16-14z" fill="${fill}"/>` : `<path d="M${x + w - 22} ${y + h - 1}l0 14-16-14z" fill="${fill}"/>`}${content}</g>`;
  const chevron = (x, y, w, h, t, fill, label, icon, i) => `<g class="pf-chev" style="--i:${i}"><path d="M${x} ${y}H${x + w - t}L${x + w} ${y + h / 2}L${x + w - t} ${y + h}H${x}L${x + t} ${y + h / 2}Z" fill="${fill}"/>${lines(x + w / 2 + t / 3, y + 40, label, { size: 26, fill: '#fff', lh: 28 })}<circle cx="${x + w / 2 + t / 3}" cy="${y}" r="25" fill="#fff" stroke="${fill}" stroke-width="2.4"/><g transform="translate(${x + w / 2 + t / 3 - 14} ${y - 14}) scale(1.17)">${icon}</g></g>`;
  const IC = {
    funnel: `<path d="M1 3h22l-8.5 10v8l-5 2.5V13z" fill="${INK}"/>`,
    tools: `<path d="M3 20.5 13.5 10M5.5 3.5a4 4 0 0 0 5 5l1.5 1.5M17 4l3.5 3.5-9.5 9.5-3.5-3.5zM2.5 21.5l2-5 3 3z" fill="none" stroke="${INK}" stroke-width="2.2" stroke-linejoin="round"/>`,
    question: `<path d="M8 8.5a4.3 4.3 0 1 1 6 3.9c-1.2.6-2 1.4-2 2.8v1" fill="none" stroke="${INK}" stroke-width="3.4" stroke-linecap="round"/><circle cx="12" cy="20.5" r="2.1" fill="${INK}"/>`,
    rocket: `<path d="M14 3c4 0 7 3 7 7-3 5-8 8-8 8l-7-7s3-5 8-8zM6 11l-3 1 3 3M13 18l-1 3-3-3" fill="${INK}"/><circle cx="15" cy="9" r="2" fill="#fff"/>`,
    eye: `<path d="M1.5 12S5.5 5 12 5s10.5 7 10.5 7-4 7-10.5 7S1.5 12 1.5 12z" fill="${INK}"/><circle cx="12" cy="12" r="4" fill="#fff"/><circle cx="12" cy="12" r="2" fill="${INK}"/>`,
  };

  // ---------------------------------------------------------------- Fig. 1: the pipeline at a glance
  function fig1() {
    const t = 36, w = 278, h = 88, y = 286, step = w - t + 8, X = k => 262 + k * step;
    const stages = [[['Extração de', 'informação'], IC.funnel, GRAY], [['Montagem', 'da intent'], IC.tools, BLUE], [['Confirmação', 'da intent'], IC.question, GRAY], [['Implantação', 'da intent'], IC.rocket, BLUE], [['Garantia', 'da intent'], IC.eye, GRAY]];
    const cw = w - t - 2, ch = 128, cy0 = y + h + 8;
    const cell = (k, r, inner) => `<g class="pf-cell" style="--r:${r};--c:${k}"><rect x="${X(k) + 3}" y="${cy0 + r * (ch + 4)}" width="${cw}" height="${ch}" fill="${CELL}" stroke="${LINE}" stroke-width="1.1"/>${inner(X(k) + 3, cy0 + r * (ch + 4))}</g>`;
    const brace = (x, y0, rows) => `${T(x + 6, y0 + 88, '{', { size: 104, w: 200, anchor: 'start' })}${T(x + cw - 18, y0 + 88, '}', { size: 104, w: 200, anchor: 'start' })}${lines(x + 32, y0 + 42 + (3 - rows.length) * 13, rows, { size: 20, anchor: 'start', lh: 28 })}`;
    const nile = (x, y0, rows) => lines(x + 9, y0 + 38, rows, { size: 19.5, anchor: 'start', lh: 31 });
    const confirm = (x, y0, id, reply) => bubble(x + 10, y0 + 10, 158, 62, BLUE, 'l', `${T(x + 22, y0 + 33, '“Está certo?”', { size: 19, fill: '#fff', anchor: 'start', italic: true })}${T(x + 22, y0 + 56, `${B('define intent')} ${id}:`, { size: 19, fill: '#fff', anchor: 'start' })}`) + bubble(x + cw - 12 - reply.w, y0 + ch - 44, reply.w, 32, GRAY, 'r', T(x + cw - 12 - reply.w / 2, y0 + ch - 22, reply.t, { size: 19, fill: '#fff', italic: true }));
    const rows = [
      ['“Quero vídeo sem', 'travar para o', 'cliente de SP.”'],
      ['“Limite o cl0', 'a 10 Mb/s.”'],
      ['“Bloqueie SSH', 'no cliente de SP.”'],
    ];
    const body = [
      [x => brace(x, cy0, [`cliente: ['${B('cl0')}'],`, `serviço: ['${B('cdn-qoe')}']`]), x => nile(x, cy0, [`${B('define intent')} q1:`, `${B('from')} endpoint('${B('192.168.0.2')}')`, `${B('add')} service('${B('cdn-qoe')}')`]), x => confirm(x, cy0, 'q1', { t: '“Sim.”', w: 66 }), x => lines(x + 10, cy0 + 38, [`[ x : (ipDst = ${B('192.168.0.2')})`, `  -&gt; s0 . s2 . ${B('s3')}`, ']'], { size: 19.5, anchor: 'start', lh: 30 }), x => lines(x + cw / 2, cy0 + 40, ['Latência dentro', 'do limite!'], { size: 23, lh: 30 }) + check(x + cw / 2 + 3, cy0 + 100)],
      [x => brace(x, cy0 + ch + 4, [`alvo: ['${B('cl0')}'],`, `banda: ['${B('max')}', '${B('10')}'],`, `operação: ['${B('set')}']`]), x => nile(x, cy0 + ch + 4, [`${B('define intent')} q2:`, `${B('for')} endpoint('${B('192.168.0.2')}')`, `${B('set')} bandwidth('max','${B('10')}',…)`]), x => confirm(x, cy0 + ch + 4, 'q2', { t: '“É o máximo.”', w: 118 }), x => lines(x + 10, cy0 + ch + 42, [`[ meter ${B('DROP')}`, `  rate = ${B('10000')} kbps`, '  em s0 … s3 ]'], { size: 19.5, anchor: 'start', lh: 30 }), x => lines(x + cw / 2, cy0 + ch + 44, ['Limite em', 'vigor!'], { size: 23, lh: 30 }) + check(x + cw / 2 + 3, cy0 + ch + 104)],
      [x => brace(x, cy0 + 2 * (ch + 4), [`operação: ['${B('block')}'],`, `protocolo: ['${B('ssh')}'],`, `alvo: ['${B('cl0')}']`]), x => nile(x, cy0 + 2 * (ch + 4), [`${B('define intent')} q3:`, `${B('for')} endpoint('${B('192.168.0.2')}')`, `${B('block')} protocol('${B('ssh')}')`]), x => confirm(x, cy0 + 2 * (ch + 4), 'q3', { t: '“Sim.”', w: 66 }), x => lines(x + cw / 2, cy0 + 2 * (ch + 4) + 54, ["'ssh' não é ipProto:", 'nada instalado'], { size: 21, lh: 30 }), x => lines(x + cw / 2, cy0 + 2 * (ch + 4) + 68, ['Nada a vigiar'], { size: 23 })],
    ];
    const cells = body.map((row, r) => row.map((fn, k) => cell(k, r, xx => fn(xx))).join('')).join('');
    const labels = rows.map((ls, r) => `<g class="pf-cell" style="--r:${r};--c:-1">${T(8, cy0 + r * (ch + 4) + ch / 2 + 8, `(${r + 1})`, { size: 23, anchor: 'start' })}${lines(154, cy0 + r * (ch + 4) + ch / 2 - (ls.length - 1) * 14 + 8, ls, { size: 24, italic: true, lh: 28 })}</g>`).join('');
    return `<svg viewBox="0 0 1560 ${cy0 + 3 * (ch + 4) + 6}" class="pfig-svg" role="img" aria-label="O pipeline do REIN: o operador escreve o pedido, o REIN extrai as informações, monta a intent em Nile, pede confirmação, implanta os fluxos no ONOS e garante o resultado; três exemplos mostram cada etapa.">
      ${laptop(168, 118, 'Operador')}
      ${doc(505, 40, 'Pedido')}
      ${arrow(270, 148, 760)}
      <g class="pf-pop"><circle cx="880" cy="148" r="104" fill="${INK}"/><svg x="796" y="128" width="168" height="42" viewBox="0 0 1614 400" style="color:#fff"><use href="#rein-logo"/></svg></g>
      ${doc(1082, 40, 'Fluxos')}
      ${arrow(1000, 148, 1142)}
      ${T(1236, 34, '(172.17.0.2:6653)', { size: 24 })}
      <path d="M1236 82L1318 136M1236 186L1318 136M1348 136H1374M1142 186H1212" stroke="${INK}" stroke-width="2.4"/>
      ${square(1236, 82, 50, SQ, 'ES', 1236, 134)}${square(1236, 186, 50, SQ, 'SP', 1236, 240)}
      ${hex(1146, 186, 30, BLUE, 'cl0')}
      ${router(1318, 136, 31, SQ, 'RJ', 1366, 186)}
      ${cloud(1440, 138, 'LFT')}
      <path d="M786 212C690 262 430 250 318 280" fill="none" stroke="${INK}" stroke-width="2.2" stroke-dasharray="11 8" class="pf-dash"/><path d="M976 212C1070 262 1350 252 1480 284" fill="none" stroke="${INK}" stroke-width="2.2" stroke-dasharray="11 8" class="pf-dash"/>
      ${stages.map(([l, ic, f], k) => chevron(X(k), y, w, h, t, f, l, ic, k)).join('')}
      ${labels}${cells}
    </svg>`;
  }

  // ---------------------------------------------------------------- Fig. 2: assurance in three panels
  function fig2() {
    const panel = (cx, mode) => {
      const s0 = [cx, 70], s1 = [cx - 92, 170], s2 = [cx + 92, 170], s3 = [cx, 262];
      const edge = (a, b) => `<path d="M${a[0]} ${a[1]}L${b[0]} ${b[1]}" stroke="${INK}" stroke-width="2.4"/>`;
      const route = (a, b, off) => { const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy), nx = -dy / L * off, ny = dx / L * off, ax = a[0] + dx * .28 + nx, ay = a[1] + dy * .28 + ny, bx = a[0] + dx * .72 + nx, by = a[1] + dy * .72 + ny; return `<path d="M${ax} ${ay}L${bx} ${by}" stroke="${BLUE}" stroke-width="3.2" stroke-dasharray="7 6" class="pf-flow"/><path d="M${bx - dx / L * 11 - dy / L * 7} ${by - dy / L * 11 + dx / L * 7}L${bx + dx / L * 3} ${by + dy / L * 3}L${bx - dx / L * 11 + dy / L * 7} ${by - dy / L * 11 - dx / L * 7}" fill="none" stroke="${BLUE}" stroke-width="3.2"/>`; };
      const ban = (p, q) => { const m = [(p[0] + q[0]) / 2 - 10, (p[1] + q[1]) / 2 - 18]; return `<g class="pf-pop"><circle cx="${m[0]}" cy="${m[1]}" r="12" fill="#fff" stroke="${SAL}" stroke-width="3.4"/><path d="M${m[0] - 8} ${m[1] - 8}L${m[0] + 8} ${m[1] + 8}" stroke="${SAL}" stroke-width="3.4"/></g>`; };
      const cfg = (x, y, lbl) => `<g class="pf-pop">${T(x, y, lbl, { size: 21 })}<path d="M${x - 16} ${y + 8}l-14 20" stroke="${INK}" stroke-width="2.6"/><path d="M${x - 34} ${y + 22}l3 10 8-6" fill="none" stroke="${INK}" stroke-width="2.6"/></g>`;
      let r = '';
      if (mode === 'a') r = route(s0, s1, 14) + route(s1, s3, 14);
      if (mode === 'b') r = route(s0, s1, 14) + ban(s0, s1) + T(s1[0] - 50, 118, '130 ms', { size: 20, italic: true }) + cfg(cx - 64, 34, 'Desvio');
      if (mode === 'c') r = route(s0, s2, -14) + route(s2, s3, -14) + cfg(cx + 76, 30, 'Config');
      return `<g class="pf-panel" style="--i:${{ a: 0, b: 1, c: 2 }[mode]}">
        <path d="M${cx} 8V36" stroke="${INK}" stroke-width="2" stroke-dasharray="4 4"/><path d="M${cx - 6} 30l6 7 6-7" fill="none" stroke="${INK}" stroke-width="2"/>${T(cx + 8, 20, 'ds0', { size: 19, anchor: 'start' })}
        ${edge(s0, s1)}${edge(s0, s2)}${edge(s1, s3)}${edge(s2, s3)}<path d="M${s3[0]} ${s3[1] + 24}V${s3[1] + 44}" stroke="${INK}" stroke-width="2.4"/>
        ${router(s0[0], s0[1], 29, BLUE, '', 0, 0)}
        ${square(s1[0], s1[1], 46, mode === 'a' ? BLUE : mode === 'b' ? SAL : SQ, '')}${`<text x="${s1[0] - 34}" y="${s1[1]}" font-size="20" font-weight="300" fill="${INK}" text-anchor="middle" transform="rotate(-90 ${s1[0] - 34} ${s1[1]})">MG</text>`}
        ${square(s2[0], s2[1], 46, mode === 'c' ? BLUE : SQ, '')}${`<text x="${s2[0] + 40}" y="${s2[1]}" font-size="20" font-weight="300" fill="${INK}" text-anchor="middle" transform="rotate(90 ${s2[0] + 40} ${s2[1]})">RJ</text>`}
        ${router(s3[0], s3[1], 24, SQ, '', 0, 0)}
        ${hex(s3[0], s3[1] + 70, 26, SQ, 'cl0', { size: 19 })}
        ${r}</g>`;
    };
    return `<svg viewBox="0 0 1000 370" class="pfig-svg" role="img" aria-label="Três painéis: a rota inicial por MG; a degradação em s0–s1, que o supervisor detecta como desvio; a nova rota por RJ instalada pelo deployer.">${panel(170, 'a')}${panel(500, 'b')}${panel(830, 'c')}</svg>`;
  }

  // ---------------------------------------------------------------- Fig. 3: the architecture
  function fig3() {
    const y = 136;
    return `<svg viewBox="0 0 1560 460" class="pfig-svg" role="img" aria-label="Arquitetura: o console envia o pedido ao profiler, que usa o vLLM e entrega a Nile ao deployer; o deployer instala os fluxos no ONOS, que controla a rede emulada no LFT; o supervisor lê métricas do ONOS e pede nova rota ao deployer; a testbed-api liga o console à rede.">
      ${laptop(110, y, 'Console :3000')}
      ${arrow(200, y, 390)}${doc(292, 16, 'Pedido')}
      <g class="pf-pop"><circle cx="478" cy="${y}" r="82" fill="${INK}"/>${T(478, y - 4, 'Profiler', { size: 28, fill: '#fff' })}${T(478, y + 26, ':5300', { size: 21, fill: '#fff' })}</g>
      ${arrow(566, y, 736)}${doc(648, 16, 'Nile')}
      ${hex(822, y, 74, BLUE, 'Deployer', { size: 25 })}${T(822, y + 104, ':5000', { size: 22 })}
      ${arrow(902, y, 1046)}${doc(972, 16, 'Fluxos')}
      ${router(1098, y, 46, BLUE, '', 0, 0)}${T(1098, y + 76, 'ONOS :8181', { size: 22 })}
      <path d="M1144 ${y}H1190" stroke="${INK}" stroke-width="2.4"/>
      <g class="pf-pop"><path d="M1196 ${y + 78}h262a46 46 0 0 0 6-92a60 60 0 0 0-104-38a50 50 0 0 0-88 16a48 48 0 0 0-76 114z" fill="#fff" stroke="${INK}" stroke-width="2.6"/>${T(1344, y + 66, 'LFT', { size: 25 })}</g>
      <path d="M1262 ${y - 22}L1320 ${y + 6}M1262 ${y + 32}L1320 ${y + 6}M1320 ${y + 6}L1392 ${y - 22}M1320 ${y + 6}L1392 ${y + 32}" stroke="${INK}" stroke-width="2.2"/>
      ${square(1262, y - 22, 32, SQ, '')}${square(1262, y + 32, 32, SQ, '')}${router(1320, y + 6, 19, SQ, '', 0, 0)}${square(1392, y - 22, 32, SQ, '')}${square(1392, y + 32, 32, SQ, '')}
      ${hex(478, y + 178, 50, SQ, 'vLLM', { size: 23 })}${T(478, y + 250, 'GPU :8000', { size: 21 })}
      <path d="M478 ${y + 84}V${y + 126}" stroke="${INK}" stroke-width="2.4"/><path d="M470 ${y + 116}l8 12 8-12M470 ${y + 96}l8-12 8 12" fill="none" stroke="${INK}" stroke-width="2.4"/>
      ${hex(960, y + 196, 56, GRAY, 'Supervisor', { size: 21 })}${T(960, y + 278, ':5151', { size: 21 })}
      <path d="M1098 ${y + 88}C1094 ${y + 170} 1060 ${y + 186} 1018 ${y + 192}" fill="none" stroke="${INK}" stroke-width="2.2" stroke-dasharray="9 7" class="pf-dash"/><path d="M1030 ${y + 181}l-13 12 16 5" fill="none" stroke="${INK}" stroke-width="2.2"/>${T(1104, y + 160, 'métricas', { size: 21, anchor: 'start', italic: true })}
      <path d="M904 ${y + 192}C862 ${y + 180} 832 ${y + 150} 826 ${y + 86}" fill="none" stroke="${INK}" stroke-width="2.2" stroke-dasharray="9 7" class="pf-dash"/><path d="M818 ${y + 98}l8-14 8 14" fill="none" stroke="${INK}" stroke-width="2.2"/>${T(804, y + 176, 'desvio', { size: 21, anchor: 'end', italic: true })}
      <path d="M110 ${y + 124}V${y + 292}H1330V${y + 90}" fill="none" stroke="${INK}" stroke-width="2.2" stroke-dasharray="9 7" class="pf-dash"/><path d="M1322 ${y + 102}l8-12 8 12" fill="none" stroke="${INK}" stroke-width="2.2"/>
      ${T(720, y + 318, 'testbed-api :5400 · links, hosts, tráfego e vídeo', { size: 21, italic: true })}
    </svg>`;
  }

  R.figures = { fig1, fig2, fig3 };
})();

/* Intent profiling: the footer composer, the floating review card on the topology page and the
   full conversation on the Intents page, laid out like a chat assistant: history on the left,
   one centred column, the answer streamed in, Nile in a code block and the approval inline.
   Both views read the same conversation and intents. */
(() => {
  'use strict';
  const R = window.REIN, M = R.model, $ = R.$, $$ = R.$$;
  const composer = $('[data-composer]'), ta = $('textarea', composer), send = $('[data-send]', composer);
  const card = $('[data-card]');
  const list = $('[data-i-list]'), thread = $('[data-thread]'), suggest = $('[data-suggest]'), search = $('[data-i-search]');

  // ------------------------------------------------------------ composer
  const sync = () => { ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`; const has = !!ta.value.trim(); send.disabled = !has; composer.classList.toggle('has-text', has); renderSuggest(); };
  ta.addEventListener('input', sync);
  ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); composer.requestSubmit(); } });
  $('[data-clear]', composer).addEventListener('click', () => { ta.value = ''; sync(); ta.focus(); });
  composer.addEventListener('submit', e => {
    e.preventDefault();
    const text = ta.value.trim();
    if (!text) return;
    ta.value = ''; sync();
    R.profile(text, R.page === 'intents' ? 'Intents' : 'Topology');
  });

  // Model menu
  const popModels = $('[data-pop="models"]'), modelBtn = $('[data-models]');
  function syncModel() {
    $('[data-model-label]').textContent = R.api?.switching ? `${R.api.switching}…` : R.state.model || L`Direct Nile`;
    ta.placeholder = R.state.model ? L`Describe what the network must guarantee` : L`Write the intent in Nile`;
    suggest.innerHTML = '';
    renderSuggest();
  }
  function modelsMenu() {
    const live = R.api?.models; // rein's models (GET /api/models) when the testbed is online
    const free = live ? live.gpu.free_gb : 32 - 25 - (R.state.llamaAwake ? 4 : 0);
    // what a model that runs here can count on: the free VRAM plus what the ones running here give back
    const room = free + (live ? live.models.filter(m => m.local && m.state === 'awake').reduce((t, m) => t + m.budget_gb, 0) : 0);
    const current = R.api?.switching || R.state.model || 'nile', gb = v => `${R.fmt(v, 2)} GB`;
    const use = (id, where) => `${id === current ? L`In use` : L`Ready`} · ${where}`;
    const why = m => m.id === R.api?.switching ? L`Starting`
      : m.state === 'awake' ? use(m.id, m.local ? gb(m.budget_gb) : L`remote`)
      : m.fits ? L`${gb(m.budget_gb)} · starts when chosen`
      : !m.local ? L`Server down`
      : !live.gpu.total_gb ? L`Needs a GPU with ${gb(m.budget_gb)}`
      : L`Needs ${gb(m.budget_gb)} · ${gb(room)} available`;
    const rows = live ? live.models.map(m => [m.id, `${m.id} · ${m.label}`, why(m), !m.fits])
      : [['qwen3.6', 'qwen3.6 · Qwen3.6 35B-A3B', use('qwen3.6', L`remote`), false],
         ['llama', 'llama · Llama 3.2 3B Instruct', R.state.llamaAwake ? use('llama', '4 GB') : L`4 GB · starts when chosen`, false],
         ['lite', 'lite · Qwen2.5 1.5B Instruct', L`3 GB · starts when chosen`, false]];
    rows.push(['nile', L`Direct Nile`, L`No model`, false]);
    const gpu = live && !live.gpu.total_gb ? L`No GPU on this machine` : L`GPU ${gb(live ? live.gpu.total_gb : 32)} · ${gb(free)} free`;
    popModels.innerHTML = `<div class="pop-head"><div><h2>${L`Translation model`}</h2><p class="pop-sub">${gpu}</p></div></div>
      <fieldset class="menu"><legend class="sr-only">${L`Model`}</legend>
        ${rows
          .map(([v, t, s, off]) => `<label${v === 'nile' ? ' class="m-apart"' : ''}><input type="radio" name="model" value="${v}"${current === v ? ' checked' : ''}${off ? ' disabled' : ''}><span class="m-title">${R.esc(t)}</span><span class="m-sub">${s}</span><span class="m-check">${R.icon('i-check')}</span></label>`).join('')}
      </fieldset>`;
  }
  modelBtn.addEventListener('click', () => {
    if (R.pop.current?.el === popModels) { R.pop.close(); return; }
    modelsMenu();
    const r = modelBtn.getBoundingClientRect();
    R.pop.open(popModels, r.left + r.width / 2, r.top - 6, { prefer: 'above', trigger: modelBtn });
  });
  popModels.addEventListener('change', e => {
    const v = e.target.value;
    if (R.api?.models) R.api.useModel(v);
    else {   // the emulation: the choice is the model, and llama "starts" at once
      R.setNile(v === 'nile');
      R.state.model = v === 'nile' ? null : v;
      if (v === 'llama' && !R.state.llamaAwake) { R.state.llamaAwake = true; R.toast(L`Starting the model:`, 'POST /api/models/llama'); R.emit('gpu', {}); }
    }
    syncModel();
    setTimeout(() => R.pop.close(), 200);
  });

  // ------------------------------------------------------------ shared bits
  const stateText = { pending: L`Waiting for approval`, checking: L`Checking`, deployed: L`Deployed`, rejected: L`Refused`, cancelled: L`Cancelled`, revoked: L`Revoked` };
  const summary = it => it.kind === 'block' ? L`SSH blocked for ${it.client}` : it.kind === 'bandwidth' ? L`Bandwidth limit for ${it.client}` : L`Video quality prioritized for ${it.client}`;
  const lastInFlight = () => [...M.chat].reverse().find(m => m.role === 'rein' && (m.kind === 'thinking' || m.kind === 'ask' || m.kind === 'proposal'));
  const secs = steps => R.fmt((steps || []).reduce((t, s) => t + s[1], 0), 1);

  // ------------------------------------------------------------ floating card (topology page)
  let hideTimer, cardFor = null;
  function renderCard() {
    const m = lastInFlight();
    clearTimeout(hideTimer);
    if (!m || R.page !== 'topology') { hideCard(); return; }
    const it = m.intent ? M.intents.find(i => i.id === m.intent) : null;
    if (it && (it.state === 'cancelled' || (it.state === 'deployed' && cardFor !== it.id + ':live'))) { hideCard(); return; }
    let html;
    const closeBtn = `<button class="close" type="button" data-card-close aria-label="${L`Close`}">${R.icon('i-x')}</button>`;
    if (m.kind === 'thinking') {
      const u = [...M.chat].reverse().find(x => x.role === 'user');
      html = `<div class="card-head"><span class="card-ic spin"></span><b>${m.direct ? L`Reading the Nile` : L`Translating`}</b><span>“${R.esc(u?.text || '')}”</span>${closeBtn}</div>
        <ol class="card-steps">${m.steps.map(([t, s, done]) => `<li class="${done ? 'is-done' : ''}"><span>${t}</span><span>${done ? `${R.fmt(s)} s` : ''}</span></li>`).join('')}</ol>`;
    } else if (m.kind === 'ask') {
      html = `<div class="card-head"><span class="card-ic ask">${R.icon('i-question')}</span><b>${L`For which client?`}</b><span>“${R.esc(m.ask)}”</span>${closeBtn}</div>
        <div class="card-actions">${m.options.map(o => `<button class="btn" type="button" data-answer="${R.esc(o.value)}">${R.esc(o.label)}</button>`).join('') || `<p class="card-error">${L`No client in the topology. Add a host.`}</p>`}</div>`;
    } else if (it) {
      const nile = `<details><summary>${L`See the intent in Nile`}</summary><pre class="nile" data-nile-for="${it.id}">${R.highlight(it.nile)}</pre></details>`;
      if (it.state === 'pending') html = `<div class="card-head"><span class="card-ic">${R.icon('i-check')}</span><b>${L`Intent ready`}</b><span>${summary(it)}</span>${closeBtn}</div><p class="card-value">${R.node(it.client)?.ip || ''}</p>${nile}
        <div class="card-actions"><button class="btn btn-blue" type="button" data-i-act="approve" data-id="${it.id}">${L`Approve intent`}</button><div class="card-links"><button class="btn btn-plain" type="button" data-i-act="edit" data-id="${it.id}">${L`Edit`}</button><button class="btn btn-plain" type="button" data-i-act="cancel" data-id="${it.id}">${L`Cancel`}</button></div></div>`;
      else if (it.state === 'checking') html = `<div class="card-head"><span class="card-ic spin"></span><b>${L`Checking`}</b><span>${L`The deployer checks the syntax and the capability.`}</span>${closeBtn}</div>`;
      else if (it.state === 'deployed') html = `<div class="card-head"><span class="card-ic">${R.icon('i-check')}</span><b>${L`Intent deployed`}</b><span>${L`${it.flows} flows, server ${M.routes[it.id]?.server || '–'}`}</span>${closeBtn}</div>`;
      else if (it.state === 'rejected') html = `<div class="card-head"><span class="card-ic err">${R.icon('i-x')}</span><b>${L`Refused by the deployer`}</b><span>${summary(it)}</span>${closeBtn}</div><p class="card-error">${R.esc(it.error)}</p>${nile}
        <div class="card-actions">${R.state.model ? `<button class="btn btn-blue" type="button" data-i-act="regenerate" data-id="${it.id}">${L`Regenerate`}</button>` : ''}<div class="card-links"><button class="btn btn-plain" type="button" data-i-act="edit" data-id="${it.id}">${L`Edit`}</button><button class="btn btn-plain" type="button" data-i-act="cancel" data-id="${it.id}">${L`Cancel`}</button></div></div>`;
    } else { hideCard(); return; }
    card.innerHTML = html;
    if (card.hidden) { card.hidden = false; card.classList.remove('is-leaving'); }
    R.topology.makeRoom(card.offsetHeight);
    if (it?.state === 'deployed') hideTimer = setTimeout(hideCard, 2800);
  }
  function hideCard() {
    if (card.hidden) return;
    R.topology.makeRoom(0);
    if (R.reduced.matches) { card.hidden = true; return; }
    card.classList.add('is-leaving');
    setTimeout(() => { card.hidden = true; card.classList.remove('is-leaving'); }, 250);
  }
  card.addEventListener('click', e => {
    if (e.target.closest('[data-card-close]')) { cardFor = null; hideCard(); return; }
    const ans = e.target.closest('[data-answer]');
    if (ans) { const idx = M.chat.lastIndexOf(lastInFlight()); R.answer(idx, ans.dataset.answer, 'Topology'); }
  });

  // ------------------------------------------------------------ intent actions (card and thread)
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-i-act]');
    if (!b) return;
    const id = b.dataset.id, act = b.dataset.iAct;
    if (act === 'approve') cardFor = `${id}:live`;
    if (act === 'edit') {
      const pre = b.closest('[data-card], .msg')?.querySelector(`[data-nile-for="${id}"]`);
      if (!pre) return;
      pre.closest('details')?.setAttribute('open', '');
      if (pre.isContentEditable) { pre.contentEditable = 'false'; b.textContent = L`Edit`; R.intentAct(id, 'edit', pre.textContent.trim()); return; }
      pre.contentEditable = 'true'; pre.focus(); getSelection().selectAllChildren(pre); b.textContent = L`Finish`;
      return;
    }
    R.intentAct(id, act);
  });
  document.addEventListener('click', e => {
    const ans = e.target.closest('[data-thread-answer]');
    if (ans) R.answer(+ans.dataset.msg, ans.dataset.threadAnswer);
    const cp = e.target.closest('[data-copy]');
    if (cp) {
      const it = M.intents.find(i => i.id === cp.dataset.copy);
      navigator.clipboard?.writeText(it?.nile || '').catch(() => {});
      const label = $('span', cp);
      if (label) { label.textContent = L`Copied`; setTimeout(() => { label.textContent = L`Copy`; }, 1400); }
      cp.classList.add('is-done'); setTimeout(() => cp.classList.remove('is-done'), 1400);
    }
    if (e.target.closest('[data-show-topo]')) location.hash = 'topology';
  });

  // ------------------------------------------------------------ Intents page: history
  let selected = null;
  const GROUPS = [[L`Under review`, ['pending', 'checking']], [L`Active`, ['deployed']], [L`Ended`, ['rejected', 'cancelled', 'revoked']]];
  function renderList() {
    const q = (search.value || '').trim().toLowerCase();
    const items = M.intents.slice().reverse().filter(it => !q || `${it.id} ${it.ask} ${it.client}`.toLowerCase().includes(q));
    const html = GROUPS.map(([title, states]) => {
      const g = items.filter(it => states.includes(it.state));
      if (!g.length) return '';
      return `<h2>${title}</h2>${g.map(it => `<button type="button" class="i-item" data-i-sel="${it.id}" aria-current="${selected === it.id}"><b>${R.esc(it.ask)}</b><span><i class="st st-${it.state}"></i>${it.id} · ${stateText[it.state]}${it.when ? `, ${it.when}` : ''}</span></button>`).join('')}`;
    }).join('');
    list.innerHTML = html || `<p class="i-empty">${q ? L`Nothing found.` : L`No intent yet.`}</p>`;
  }
  search.addEventListener('input', renderList);
  list.addEventListener('click', e => {
    const b = e.target.closest('[data-i-sel]');
    if (!b) return;
    selected = b.dataset.iSel;
    renderList();
    const a = $(`[data-i-anchor="${selected}"]`, thread);
    if (!a) return;
    a.scrollIntoView({ behavior: R.reduced.matches ? 'auto' : 'smooth', block: 'center' });
    a.classList.remove('is-flash'); void a.offsetWidth; a.classList.add('is-flash');
  });
  $('[data-new-intent]').addEventListener('click', () => {
    selected = null; renderList();
    thread.scrollTo({ top: thread.scrollHeight, behavior: R.reduced.matches ? 'auto' : 'smooth' });
    ta.focus();
  });

  // ------------------------------------------------------------ Intents page: suggestions above the composer
  const IDEAS = [[L`Video without stalls`, L`for the client in SP`, L`I want video without stalls for the client in SP`], [L`Block UDP`, L`on client cl0`, L`Block UDP on client cl0`], [L`Limit bandwidth`, L`of cl0 to 10 Mb/s`, L`Limit the bandwidth of client cl0 to 10 Mb/s`]];
  const IDEAS_NILE = [[L`Video without stalls`, "add service('cdn-qoe')", "add service('cdn-qoe')"], [L`Block UDP`, "block protocol('udp')", "block protocol('udp')"], [L`Limit bandwidth`, "set bandwidth('max', '10', 'mbps')", "set bandwidth('max', '10', 'mbps')"]];
  function renderSuggest() {
    const busy = lastInFlight();
    const flowing = busy && (busy.kind === 'thinking' || busy.kind === 'ask' || M.intents.find(i => i.id === busy.intent)?.state === 'pending');
    const show = R.page === 'intents' && !ta.value.trim() && !flowing && (typeof imode === 'undefined' || imode === 'chat');
    suggest.classList.toggle('is-on', show);
    if (suggest.children.length) return;
    const ip = R.clientsList()[0]?.ip || '192.168.0.2';
    const ideas = R.state.model ? IDEAS : IDEAS_NILE.map(([t, s, action]) => [t, s, `define intent q${M.intents.length + 1}: for endpoint('${ip}') ${action}`]);
    suggest.innerHTML = (R.state.model ? '' : `<p class="suggest-note">${R.icon('i-info')}<span>${R.esc(R.whyNoModel())}</span></p>`)
      + ideas.map(([t, s, full]) => `<button type="button" data-idea="${R.esc(full)}"><b>${t}</b><span>${s}</span></button>`).join('');
  }
  R.on(type => { if (type === 'models' || type === 'topology') syncModel(); });
  suggest.addEventListener('click', e => {
    const b = e.target.closest('[data-idea]');
    if (!b) return;
    ta.value = b.dataset.idea; sync(); ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  });

  // ------------------------------------------------------------ Intents page: the conversation
  const MARK = '<svg viewBox="0 0 534 400" aria-hidden="true"><use href="#rein-mark"/></svg>';
  const STREAM_WORD = 24;
  // Prose the profiler writes around the Nile line
  function prose(it) {
    if (it.direct) return L`I received the intent in Nile, as you wrote it. No model translated it. The deployer checks the syntax and the capability when deploying:`;
    const n = R.node(it.client), who = `${it.client} (${n?.ip || '–'})`;
    if (it.kind === 'block') { const pr = (R.nileInfo(it.nile).value || '').toUpperCase(); return L`Understood: block ${pr} for ${who}. In Nile, this is the intent, which the deployer applies at this client's switch:`; }
    if (it.kind === 'bandwidth') { const mb = (it.nile.match(/'(\d+)', 'mbps'/) || [, '10'])[1]; return L`Understood: limit the bandwidth of ${who} to ${mb} Mb/s. In Nile, this is the intent:`; }
    return L`Understood: video without stalls for ${who}. In Nile that is the cdn-qoe service from this endpoint. The deployer picks the server and the path of highest throughput.`;
  }
  const words = (text, from = 0) => text.split(/(\s+)/).map(w => (/^\s+$/.test(w) ? w : `<span class="w" style="--i:${from++}">${R.esc(w)}</span>`)).join('');
  const countWords = text => text.split(/\s+/).filter(Boolean).length;

  function approval(it) {
    const route = M.routes[it.id];
    if (it.state === 'pending') return `<div class="approve"><span class="ap-ic">${R.icon('i-shield')}</span><div class="ap-text"><b>${L`Deploy ${it.id} in the network?`}</b><span>${L`The deployer checks the syntax and the capability before installing the flows in ONOS.`}</span></div><div class="ap-acts"><button class="btn btn-plain" type="button" data-i-act="cancel" data-id="${it.id}">${L`Cancel`}</button><button class="btn" type="button" data-i-act="edit" data-id="${it.id}">${L`Edit`}</button><button class="btn btn-blue" type="button" data-i-act="approve" data-id="${it.id}">${L`Approve`}</button></div></div>`;
    if (it.state === 'checking') return `<div class="approve is-busy"><span class="ap-ic"><i class="spinner"></i></span><div class="ap-text"><b class="shimmer">${L`Checking with the deployer`}</b><span>${L`Syntax, capability and path.`}</span></div></div>`;
    if (it.state === 'deployed') return `<div class="approve is-ok"><span class="ap-ic">${R.icon('i-check')}</span><div class="ap-text"><b>${L`Deployed at ${it.when}`}</b><span>${route?.path ? L`${it.flows} flows · server ${route.server} · path ${route.path.slice(1, -1).join(', ')}` : R.esc(it.effect || L`${it.flows} flows`)}</span></div><button type="button" class="btn btn-plain" data-i-act="revoke" data-id="${it.id}">${L`Revoke`}</button></div>`;
    if (it.state === 'revoked') return `<div class="approve is-off"><div class="ap-text"><span>${L`Revoked at ${it.revokedAt || '–'}: flows and rules removed from ONOS.`}</span></div></div>`;
    if (it.state === 'rejected') return `<div class="approve is-err"><span class="ap-ic">${R.icon('i-x')}</span><div class="ap-text"><b>${L`Refused by the deployer (${it.code || 422})`}</b><span>${R.esc(it.error)}</span></div><div class="ap-acts"><button class="btn" type="button" data-i-act="edit" data-id="${it.id}">${L`Edit`}</button>${R.state.model ? `<button class="btn btn-blue" type="button" data-i-act="regenerate" data-id="${it.id}">${L`Regenerate`}</button>` : ''}</div></div>`;
    return `<div class="approve is-off"><div class="ap-text"><span>${L`Cancelled. Nothing was sent to the deployer.`}</span></div></div>`;
  }
  const thought = steps => `<details class="thought"><summary>${L`Thought for ${secs(steps)} s${R.icon('i-chevron-right', 'chev')}`}</summary><ol>${steps.map(([t, s]) => `<li><span>${t}</span><span>${R.fmt(s)} s</span></li>`).join('')}</ol></details>`;
  const ICON = { Deployer: 'i-deployer', Supervisor: 'i-eye', Profiler: 'i-chat' };

  function msgHtml(m, i) {
    const prev = M.chat[i - 1];
    const first = !prev || prev.role === 'user';
    if (m.role === 'user') {
      const it = M.intents.find(x => x.ask === m.text);
      return { cls: 'msg user', html: `<div class="bubble">${R.esc(m.text)}</div><div class="meta">${m.time}${m.source === 'Topology' ? ` ${L`· ${R.icon('i-topo')} from the topology's footer`}` : ''}${it ? ` · ${it.id}` : ''}</div>` };
    }
    const av = first ? `<span class="av">${MARK}</span>` : '<span class="av-gap"></span>';
    // the model's name only on what a model translated: not on an intent sent in Nile, nor without a model
    const head = first ? `<div class="who"><b>REIN</b>${R.state.model && !m.direct && m.kind !== 'text' ? `<span>${R.esc(R.state.model)}</span>` : ''}</div>` : '';
    if (m.role === 'event') {
      return { cls: `msg rein activity${first ? ' first' : ''}`, html: `${av}<div class="body">${head}<div class="act ${m.tone || ''}"><span class="act-ic">${R.icon(ICON[m.source] || 'i-bolt')}</span><span class="act-text"><b>${R.esc(m.source)}</b> ${R.esc(m.text)}</span><time>${m.time}</time></div></div>` };
    }
    let body = '';
    if (m.kind === 'thinking') {
      body = `<div class="thinking"><span class="shimmer">${m.direct ? L`Reading the Nile` : L`Translating to Nile`}</span><ol>${m.steps.map(([t, s, done]) => `<li class="${done ? 'is-done' : ''}">${done ? R.icon('i-check') : '<i></i>'}<span>${t}</span>${done ? `<em>${R.fmt(s)} s</em>` : ''}</li>`).join('')}</ol></div>`;
    } else if (m.kind === 'ask') {
      const n = m.options.length;
      body = `<p class="prose">${n > 1 ? L`I found ${n} clients that can serve the request. Which one?` : n ? L`I found one client that serves the request. Is it this one?` : L`There are no clients in the topology. Add a host first.`}</p>
        <div class="choices">${m.options.map(o => `<button type="button" class="choice${m.answered === o.value ? ' is-picked' : ''}" data-thread-answer="${R.esc(o.value)}" data-msg="${i}"${m.answered ? ' disabled' : ''}>${R.icon('i-laptop')}<span>${R.esc(o.label)}</span></button>`).join('')}</div>`;
    } else if (m.kind === 'text') {
      body = `<p class="prose">${R.esc(m.text)}</p>`;
    } else if (m.kind === 'proposal') {
      const it = M.intents.find(x => x.id === m.intent);
      if (!it) return { cls: 'msg rein', html: '' };
      const text = prose(it), streaming = m.streamUntil && Date.now() < m.streamUntil;
      const nWords = countWords(text);
      body = `${m.steps?.length ? thought(m.steps) : ''}
        <p class="prose">${streaming ? words(text) : R.esc(text)}</p>
        <div class="after" style="--after:${nWords}">
          <div class="code"><div class="code-head"><span>Nile</span><button type="button" class="code-copy" data-copy="${it.id}">${R.icon('i-copy')}<span>${L`Copy`}</span></button></div><pre class="nile" data-nile-for="${it.id}">${R.highlight(it.nile)}</pre></div>
          ${approval(it)}
          <div class="acts"><button type="button" class="ico" data-copy="${it.id}" data-tip="${L`Copy Nile`}" aria-label="${L`Copy Nile`}">${R.icon('i-copy')}</button><button type="button" class="ico" data-show-topo data-tip="${L`See in the topology`}" aria-label="${L`See in the topology`}">${R.icon('i-topo')}</button></div>
        </div>`;
      return { cls: `msg rein${first ? ' first' : ''}${streaming ? ' is-streaming' : ''}`, html: `${av}<div class="body" data-i-anchor="${it.id}">${head}${body}</div>` };
    }
    return { cls: `msg rein${first ? ' first' : ''}`, html: `${av}<div class="body">${head}${body}</div>` };
  }

  const cache = [];
  let col = null, booted = false;
  function renderThread() {
    if (!col || !col.isConnected) { thread.innerHTML = '<div class="t-col"></div>'; col = thread.firstChild; cache.length = 0; }
    const atBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 120;
    let streamEnds = 0;
    M.chat.forEach((m, i) => {
      // A proposal is streamed once, when it first appears in this session
      if (m.role === 'rein' && m.kind === 'proposal' && booted && !m.streamed) {
        m.streamed = true;
        const it = M.intents.find(x => x.id === m.intent);
        m.streamUntil = R.reduced.matches || !it ? 0 : Date.now() + countWords(prose(it)) * STREAM_WORD + 900;
      }
      if (m.streamUntil && Date.now() < m.streamUntil) streamEnds = Math.max(streamEnds, m.streamUntil);
      const { cls, html } = msgHtml(m, i);
      let el = col.children[i];
      if (!el) { el = document.createElement('div'); col.append(el); if (booted) el.classList.add('is-new'); }
      if (cache[i] !== html) { el.innerHTML = html; cache[i] = html; }
      const want = `${cls}${el.classList.contains('is-new') ? ' is-new' : ''}${el.classList.contains('is-flash') ? ' is-flash' : ''}`;
      if (el.className !== want) el.className = want;
    });
    while (col.children.length > M.chat.length) { col.lastChild.remove(); cache.pop(); }
    if (streamEnds) setTimeout(renderThread, streamEnds - Date.now() + 30);
    if (atBottom || !booted) thread.scrollTop = thread.scrollHeight;
    booted = true;
  }


  // ------------------------------------------------------------ Intents page: applied Nile history
  const side = $('.chat-side'), sideHead = $('.side-head', side), chatMain = $('.chat-main');
  const helpBtn = document.createElement('button');
  helpBtn.className = 'tool'; helpBtn.type = 'button'; helpBtn.dataset.help = ''; helpBtn.dataset.tip = L`Intents guide`; helpBtn.setAttribute('aria-label', L`Intents guide: examples, Nile syntax and capabilities`);
  helpBtn.innerHTML = R.icon('i-help');
  sideHead.querySelector('[data-new-intent]').before(helpBtn);
  const modeSeg = document.createElement('div');
  modeSeg.className = 'seg side-seg'; modeSeg.setAttribute('role', 'tablist'); modeSeg.setAttribute('aria-label', L`View`);
  modeSeg.innerHTML = `<button type="button" role="tab" data-imode="chat" aria-pressed="true">${L`Chat`}</button><button type="button" role="tab" data-imode="applied" aria-pressed="false">${L`Applied`}</button>`;
  sideHead.after(modeSeg);
  const applied = document.createElement('section');
  applied.className = 'applied'; applied.hidden = true; applied.setAttribute('aria-label', L`Applied intents`);
  chatMain.append(applied);
  let imode = 'chat', aFilter = 'active';
  const srcText = { Topology: L`from the topology's footer`, Intents: L`in the chat`, Services: L`from the services panel` };
  function renderApplied() {
    const all = M.intents.filter(i => i.state === 'deployed' || i.state === 'revoked');
    const shown = all.filter(i => aFilter === 'all' || i.state === 'deployed').slice().reverse();
    applied.innerHTML = `<div class="ap-col">
      <header class="ap-head"><div><h2>${L`Applied intents`}</h2><p>${L`${all.filter(i => i.state === 'deployed').length} in force in ONOS, ${all.filter(i => i.state === 'revoked').length} revoked. Each line is exactly what the deployer received.`}</p></div>
        <div class="ap-tools"><div class="seg" role="group" aria-label="${L`Filter`}"><button type="button" data-afilter="active" aria-pressed="${aFilter === 'active'}">${L`In force`}</button><button type="button" data-afilter="all" aria-pressed="${aFilter === 'all'}">${L`All`}</button></div><button class="btn" type="button" data-export-nile>${L`${R.icon('i-export')}Export .nile`}</button></div></header>
      ${shown.length ? `<ol class="ap-list">${shown.map(it => { const u = M.chat.find(m => m.role === 'user' && (m.intent === it.id || m.text === it.ask)); return `<li class="ap-item st-${it.state}"><div class="ap-meta"><b class="mono">${it.id}</b><span class="ap-state"><i class="st st-${it.state === 'deployed' ? 'deployed' : 'cancelled'}"></i>${it.state === 'deployed' ? L`In force since ${it.when}` : L`Revoked at ${it.revokedAt || '–'}`}</span><span class="ap-src">${R.esc(srcText[u?.source] || L`in the chat`)}</span></div>
          <pre class="nile">${R.highlight(it.nile)}</pre>
          <p class="ap-effect">${R.esc(it.effect || (it.flows ? L`${it.flows} flows` : ''))}${it.ask ? ` · “${R.esc(it.ask)}”` : ''}</p>
          <div class="ap-acts"><button type="button" class="btn btn-plain" data-copy="${it.id}">${R.icon('i-copy')}<span>${L`Copy`}</span></button>${it.state === 'deployed' ? `<button type="button" class="btn btn-danger" data-i-act="revoke" data-id="${it.id}">${L`Revoke`}</button>` : ''}</div></li>`; }).join('')}</ol>` : `<p class="ap-empty">${L`No intent in force. The approved ones appear here.`}</p>`}</div>`;
  }
  function setMode(m) {
    imode = m;
    $$('[data-imode]', modeSeg).forEach(b => b.setAttribute('aria-pressed', String(b.dataset.imode === m)));
    applied.hidden = m !== 'applied';
    thread.hidden = m === 'applied';
    chatMain.classList.toggle('is-applied', m === 'applied');
    if (m === 'applied') renderApplied();
    renderSuggest();
  }
  modeSeg.addEventListener('click', e => { const b = e.target.closest('[data-imode]'); if (b) setMode(b.dataset.imode); });
  applied.addEventListener('click', e => {
    const f = e.target.closest('[data-afilter]'); if (f) { aFilter = f.dataset.afilter; renderApplied(); return; }
    if (e.target.closest('[data-export-nile]')) {
      const body = M.intents.filter(i => i.state === 'deployed').map(i => L`# ${i.id}, in force since ${i.when}${i.effect ? `: ${i.effect}` : ''}\n${i.nile}`).join('\n\n') + '\n';
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([body], { type: 'text/plain' })); a.download = `intents-${R.env?.testbed || 'rein'}.nile`; a.click();
    }
  });
  R.on(type => { if ((type === 'intent' || type === 'chat') && imode === 'applied') renderApplied(); });

  // ------------------------------------------------------------ help: a guide to asking, Nile and the deployer
  const helpSheet = $('[data-sheet="help"]'), toc = $('[data-help-toc]'), doc = $('[data-help-doc]');
  const EX = [
    [L`I want video without stalls for the client in SP`, "define intent q1: for endpoint('192.168.0.2') add service('cdn-qoe')", L`The deployer picks the DASH server of lowest RTT and the path of highest throughput. The supervisor measures the latency and asks for another path when it goes above 200 ms.`, 'ok'],
    [L`Limit cl0 to 10 Mb/s`, "define intent q2: for endpoint('192.168.0.2') set bandwidth('max', '10', 'mbps')", L`An OpenFlow meter with a DROP band of 10,000 kbps at cl0's switch, on what reaches it. A new limit replaces this one.`, 'ok'],
    [L`Block UDP on client cl0`, "define intent q3: for endpoint('192.168.0.2') block protocol('udp')", L`Drops UDP to and from cl0, at its switch. That client's iperf3 -u stops receiving, and TCP goes on.`, 'ok'],
    [L`Block SSH on the client in SP`, "define intent q4: for endpoint('192.168.0.2') block protocol('ssh')", L`Drops TCP on port 22 to and from the client. allow protocol('ssh') undoes it.`, 'ok'],
    [L`Inspect the students' traffic`, "define intent q5: for group('students') add middlebox('dpi')", L`Valid syntax, but refused: there is no middlebox in this testbed.`, 'no'],
  ];
  const BNF = `<intent>    ::= "define" "intent" <name> ":" <scope> <action> [ <window> ]

<scope>     ::= "from" <target> "to" <target>
              | "for" <target>

<target>    ::= <target-fn> "(" <str> ")"
<target-fn> ::= "endpoint" | "group" | "service" | "traffic"

<action>    ::= <set-op> <qos> { "," <qos> }
              | <acl-op> <acl> { "," <acl> }
              | <chain-op> <chain> { "," <chain> }

<set-op>    ::= "set" | "unset"
<qos>       ::= "bandwidth" "(" <str> "," <str> "," <str> ")"
              | "quota" "(" <str> "," <str> "," <str> ")"

<acl-op>    ::= "allow" | "block"
<acl>       ::= <acl-fn> "(" <str> ")"
<acl-fn>    ::= "traffic" | "service" | "protocol"

<chain-op>  ::= "add" | "remove"
<chain>     ::= <chain-fn> "(" <str> ")"
<chain-fn>  ${L`::= "middlebox" | "service"         ; service(...) is a REIN extension`}

<window>    ::= "start" <time> "end" <time>
<time>      ::= <time-fn> "(" <str> ")"
<time-fn>   ::= "hour" | "date" | "datetime" | "timestamp"

<name>      ${L`::= a letter or "_", followed by letters, digits or "_"`}
<str>       ${L`::= "'" any text without single quotes "'"`}`;
  const CAPS = [
    ["add | remove service('cdn-qoe')", L`Executes`, L`Server of lowest RTT, path of highest throughput, and the supervisor recalculates. remove deletes the path.`, 'yes'],
    [L`set | unset bandwidth('max', N, unit)`, L`Executes`, L`DROP meter at the client's switch: bps, kbps, mbps or gbps.`, 'yes'],
    ["set bandwidth('min', …)", L`Refuses`, L`422: a minimum needs queues, only the maximum is applied.`, 'no'],
    ["block | allow protocol('tcp'|'udp'|'icmp'|'ssh'|'http'|'https')", L`Executes`, L`Dropped both ways, at the client's switch. allow undoes it.`, 'yes'],
    ["block | allow service(…), traffic(…)", L`Refuses`, L`422: service and traffic names need DPI.`, 'no'],
    ["add | remove middlebox(…)", L`Refuses`, L`422: there is no middlebox in this testbed.`, 'no'],
    ["set quota(…), start … end …", L`Refuses`, L`422: not implemented.`, 'no'],
  ];
  const SECTIONS = [
    ['start', L`How to ask`, `<p class="hd-lead">${L`Say what the network must guarantee and for whom. REIN finds the client by its address (192.168.0.2), by its name (cl0) or by the state of its switch (“client in SP”), writes the intent in Nile and waits for your approval. Nothing reaches ONOS before that.`}</p>
      <ul class="hd-steps"><li><b>1</b><span>${L`Write in the field at the bottom, in Topology or here. Enter sends, Shift+Enter breaks the line, / goes to the field.`}</span></li><li><b>2</b><span>${L`If something is missing, REIN asks. Answer by choosing an option.`}</span></li><li><b>3</b><span>${L`Check the Nile. Edit the text if needed and approve.`}</span></li><li><b>4</b><span>${L`The deployer checks the syntax and whether the operation can be executed. If it refuses, the reason appears and you can regenerate.`}</span></li></ul>
      <p>${L`Those who know Nile can write it directly in the same field: a request that starts with`} <code>define intent</code> ${L`goes to approval as it is, without the model. The menu next to the field changes the model or turns on`} <b>${L`Direct Nile`}</b>${L`, with no model.`}</p>`],
    ['ex', L`Examples`, `<div class="hd-ex">${EX.map(([nl, nile, what, ok]) => `<article class="${ok}"><p class="hd-nl">“${R.esc(nl)}”</p><pre class="nile">${R.highlight(nile)}</pre><p class="hd-what">${ok === 'no' ? R.icon('i-x') : R.icon('i-check')}${R.esc(what)}</p></article>`).join('')}</div>`],
    ['bnf', L`Nile syntax`, `<p>${L`REIN's grammar, in BNF. Spaces do not matter and values go between single quotes. It accepts the 256,913 lines of NEAT and REIN's requests, and only validates the form: what runs depends on the deployer.`}</p><pre class="bnf">${R.esc(BNF).replace(/(&lt;[\w-]+&gt;)/g, '<span class="nt">$1</span>').replace(/(&quot;[^&]*?&quot;)/g, '<span class="t">$1</span>').replace(/(\s; [^\n]*)/g, '<span class="c">$1</span>')}</pre><p class="hd-src">${L`Source: deployer/nile.lark (Lark, LALR).`}</p>`],
    ['caps', L`What the deployer executes`, `<table class="hd-caps"><thead><tr><th>${L`Operation`}</th><th>${L`State`}</th><th>${L`How`}</th></tr></thead><tbody>${CAPS.map(([op, st, how, k]) => `<tr><td><code>${R.esc(op)}</code></td><td><span class="cap ${k}">${st}</span></td><td>${R.esc(how)}</td></tr>`).join('')}</tbody></table><p class="hd-src">${L`All of them need for endpoint('&lt;ip&gt;'). From deployer/nile.py (GET /capabilities) and deployer/edge.py, and also through the Services panel in Topology.`}</p>`],
  ];
  let helpAt = 'start';
  function paintHelp() {
    toc.innerHTML = SECTIONS.map(([k, t]) => `<button type="button" data-hsec="${k}" aria-current="${k === helpAt}">${t}</button>`).join('');
    const s = SECTIONS.find(x => x[0] === helpAt);
    doc.innerHTML = `<h3>${s[1]}</h3>${s[2]}`;
    doc.scrollTop = 0;
  }
  helpBtn.addEventListener('click', () => { paintHelp(); helpSheet.showModal(); });
  helpSheet.addEventListener('click', e => {
    if (e.target === helpSheet || e.target.closest('[data-close-sheet]')) { helpSheet.close(); return; }
    const b = e.target.closest('[data-hsec]'); if (b) { helpAt = b.dataset.hsec; paintHelp(); }
  });
  R.openHelp = sec => { if (sec) helpAt = sec; paintHelp(); helpSheet.showModal(); };

  const all = () => { renderCard(); renderList(); renderThread(); renderSuggest(); };
  R.on((type, d) => {
    if (type === 'chat' || type === 'intent') { if (type === 'chat' && !d.progress) cardFor = null; all(); if (type === 'chat' && !d.progress) thread.scrollTo({ top: thread.scrollHeight, behavior: R.reduced.matches ? 'auto' : 'smooth' }); }
    if (type === 'log') { renderThread(); if (d.source !== 'Testbed') R.notify(d); }
    if (type === 'page') { renderCard(); renderSuggest(); if (d.page === 'intents') { renderThread(); thread.scrollTop = thread.scrollHeight; } }
  });
  R.intents = { render: all };
  M.chat.forEach(m => { if (m.kind === 'proposal') m.streamed = true; });
  sync();
  all();
})();

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
    R.profile(text, R.page === 'intents' ? 'Intents' : 'Topologia');
  });

  // Model menu
  const popModels = $('[data-pop="models"]'), modelBtn = $('[data-models]');
  function modelsMenu() {
    const live = R.api?.models; // the profiler's /models when the testbed is online
    const free = live ? live.gpu.free_gb : 32 - 25 - (R.state.llamaAwake ? 2.25 : 0);
    const rows = live ? live.models.map(m => [m.id, m.state === 'awake' ? `Acordado${m.pinned ? ', fixado' : ''}, ${R.fmt(m.budget_gb, 2)} GB` : m.fits ? 'Dormindo, cabe na memória livre' : `Não cabe: precisa de ${R.fmt(m.budget_gb, 2)} GB, há ${R.fmt(free, 2)} GB livres`, m.state !== 'awake' && !m.fits])
      : [['qwen3.6', 'Acordado, fixado, 23,4 GB', false], ['llama 3.2 3b', R.state.llamaAwake ? 'Acordado, 2,25 GB' : 'Dormindo, cabe na memória livre', false], ['gemma 4 12b', `Não cabe: precisa de 10,3 GB, há ${R.fmt(free, 2)} GB livres`, true]];
    popModels.innerHTML = `<div class="pop-head"><div><h2>Modelo de tradução</h2><p class="pop-sub">GPU de ${live ? live.gpu.total_gb : 32} GB, ${R.fmt(free, 2)} GB livres</p></div></div>
      <fieldset class="menu"><legend class="sr-only">Modelo</legend>
        ${rows
          .map(([v, s, off]) => `<label><input type="radio" name="model" value="${v}"${R.state.model === v ? ' checked' : ''}${off ? ' disabled' : ''}><span class="m-title">${v}</span><span class="m-sub">${s}</span><span class="m-check">${R.icon('i-check')}</span></label>`).join('')}
      </fieldset>
      <p class="pop-note" style="margin:12px 0 0">Nenhum modelo é descarregado sem sua ação.</p>`;
  }
  modelBtn.addEventListener('click', () => {
    if (R.pop.current?.el === popModels) { R.pop.close(); return; }
    modelsMenu();
    const r = modelBtn.getBoundingClientRect();
    R.pop.open(popModels, r.left + r.width / 2, r.top - 6, { prefer: 'above', trigger: modelBtn });
  });
  popModels.addEventListener('change', e => {
    const v = e.target.value;
    R.state.model = v;
    $('[data-model-label]').textContent = v;
    if (R.api?.models) R.api.loadModel(v);
    else if (v.startsWith('llama') && !R.state.llamaAwake) { R.state.llamaAwake = true; R.toast('Acordando o modelo:', 'POST /api/profiler/models/llama/load'); R.emit('gpu', {}); }
    setTimeout(() => R.pop.close(), 200);
  });

  // ------------------------------------------------------------ shared bits
  const stateText = { pending: 'Aguardando aprovação', checking: 'Verificando', deployed: 'Implantada', rejected: 'Recusada', cancelled: 'Cancelada', revoked: 'Revogada' };
  const summary = it => it.kind === 'block' ? `Bloqueio de SSH em ${it.client}` : it.kind === 'bandwidth' ? `Limite de banda em ${it.client}` : `Qualidade de vídeo priorizada para ${it.client}`;
  const lastInFlight = () => [...M.chat].reverse().find(m => m.role === 'rein' && (m.kind === 'thinking' || m.kind === 'ask' || m.kind === 'proposal'));
  const secs = steps => R.fmt((steps || []).reduce((t, s) => t + s[1], 0), 1);

  // ------------------------------------------------------------ floating card (topology page)
  let hideTimer, cardFor = null;
  function renderCard() {
    const m = lastInFlight();
    clearTimeout(hideTimer);
    if (!m || R.page !== 'topologia') { hideCard(); return; }
    const it = m.intent ? M.intents.find(i => i.id === m.intent) : null;
    if (it && (it.state === 'cancelled' || (it.state === 'deployed' && cardFor !== it.id + ':live'))) { hideCard(); return; }
    let html;
    const closeBtn = `<button class="close" type="button" data-card-close aria-label="Fechar">${R.icon('i-x')}</button>`;
    if (m.kind === 'thinking') {
      const u = [...M.chat].reverse().find(x => x.role === 'user');
      html = `<div class="card-head"><span class="card-ic spin"></span><b>Traduzindo</b><span>“${R.esc(u?.text || '')}”</span>${closeBtn}</div>
        <ol class="card-steps">${m.steps.map(([t, s, done]) => `<li class="${done ? 'is-done' : ''}"><span>${t}</span><span>${done ? `${R.fmt(s)} s` : ''}</span></li>`).join('')}</ol>`;
    } else if (m.kind === 'ask') {
      html = `<div class="card-head"><span class="card-ic ask">${R.icon('i-question')}</span><b>Para qual cliente?</b><span>“${R.esc(m.ask)}”</span>${closeBtn}</div>
        <div class="card-actions">${m.options.map(o => `<button class="btn" type="button" data-answer="${R.esc(o.value)}">${R.esc(o.label)}</button>`).join('') || '<p class="card-error">Nenhum cliente na topologia. Adicione um host.</p>'}</div>`;
    } else if (it) {
      const nile = `<details><summary>Ver intent em Nile</summary><pre class="nile" data-nile-for="${it.id}">${R.highlight(it.nile)}</pre></details>`;
      if (it.state === 'pending') html = `<div class="card-head"><span class="card-ic">${R.icon('i-check')}</span><b>Intent pronta</b><span>${summary(it)}</span>${closeBtn}</div><p class="card-value">${R.node(it.client)?.ip || ''}</p>${nile}
        <div class="card-actions"><button class="btn btn-blue" type="button" data-i-act="approve" data-id="${it.id}">Aprovar intent</button><div class="card-links"><button class="btn btn-plain" type="button" data-i-act="edit" data-id="${it.id}">Editar</button><button class="btn btn-plain" type="button" data-i-act="cancel" data-id="${it.id}">Cancelar</button></div></div>`;
      else if (it.state === 'checking') html = `<div class="card-head"><span class="card-ic spin"></span><b>Verificando</b><span>O deployer confere a sintaxe e a capacidade.</span>${closeBtn}</div>`;
      else if (it.state === 'deployed') html = `<div class="card-head"><span class="card-ic">${R.icon('i-check')}</span><b>Intent implantada</b><span>${it.flows} fluxos, servidor ${M.routes[it.id]?.server || '–'}</span>${closeBtn}</div>`;
      else if (it.state === 'rejected') html = `<div class="card-head"><span class="card-ic err">${R.icon('i-x')}</span><b>Recusada pelo deployer</b><span>${summary(it)}</span>${closeBtn}</div><p class="card-error">${R.esc(it.error)}</p>${nile}
        <div class="card-actions"><button class="btn btn-blue" type="button" data-i-act="regenerate" data-id="${it.id}">Regenerar</button><div class="card-links"><button class="btn btn-plain" type="button" data-i-act="edit" data-id="${it.id}">Editar</button><button class="btn btn-plain" type="button" data-i-act="cancel" data-id="${it.id}">Cancelar</button></div></div>`;
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
    if (ans) { const idx = M.chat.lastIndexOf(lastInFlight()); R.answer(idx, ans.dataset.answer, 'Topologia'); }
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
      if (pre.isContentEditable) { pre.contentEditable = 'false'; b.textContent = 'Editar'; R.intentAct(id, 'edit', pre.textContent.trim()); return; }
      pre.contentEditable = 'true'; pre.focus(); getSelection().selectAllChildren(pre); b.textContent = 'Concluir';
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
      if (label) { label.textContent = 'Copiado'; setTimeout(() => { label.textContent = 'Copiar'; }, 1400); }
      cp.classList.add('is-done'); setTimeout(() => cp.classList.remove('is-done'), 1400);
    }
    if (e.target.closest('[data-show-topo]')) location.hash = 'topologia';
  });

  // ------------------------------------------------------------ Intents page: history
  let selected = null;
  const GROUPS = [['Em revisão', ['pending', 'checking']], ['Ativas', ['deployed']], ['Encerradas', ['rejected', 'cancelled', 'revoked']]];
  function renderList() {
    const q = (search.value || '').trim().toLowerCase();
    const items = M.intents.slice().reverse().filter(it => !q || `${it.id} ${it.ask} ${it.client}`.toLowerCase().includes(q));
    const html = GROUPS.map(([title, states]) => {
      const g = items.filter(it => states.includes(it.state));
      if (!g.length) return '';
      return `<h2>${title}</h2>${g.map(it => `<button type="button" class="i-item" data-i-sel="${it.id}" aria-current="${selected === it.id}"><b>${R.esc(it.ask)}</b><span><i class="st st-${it.state}"></i>${it.id} · ${stateText[it.state]}${it.when ? `, ${it.when}` : ''}</span></button>`).join('')}`;
    }).join('');
    list.innerHTML = html || `<p class="i-empty">${q ? 'Nada encontrado.' : 'Nenhuma intent ainda.'}</p>`;
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
  const IDEAS = [['Vídeo sem travar', 'para o cliente de SP', 'Quero vídeo sem travar para o cliente de SP'], ['Bloquear UDP', 'no cliente cl0', 'Bloqueie UDP no cliente cl0'], ['Limitar banda', 'de cl0 a 10 Mb/s', 'Limite a banda do cliente cl0 a 10 Mb/s']];
  function renderSuggest() {
    const busy = lastInFlight();
    const flowing = busy && (busy.kind === 'thinking' || busy.kind === 'ask' || M.intents.find(i => i.id === busy.intent)?.state === 'pending');
    const show = R.page === 'intents' && !ta.value.trim() && !flowing && (typeof imode === 'undefined' || imode === 'chat');
    suggest.classList.toggle('is-on', show);
    if (!suggest.children.length) suggest.innerHTML = IDEAS.map(([t, s, full]) => `<button type="button" data-idea="${R.esc(full)}"><b>${t}</b><span>${s}</span></button>`).join('');
  }
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
    const n = R.node(it.client), who = `${it.client} (${n?.ip || '–'})`;
    if (it.kind === 'block') { const pr = (R.nileInfo(it.nile).value || '').toUpperCase(); return `Entendi: bloquear ${pr} para ${who}. Em Nile, esta é a intent; o deployer a leva ao app ACL do ONOS:`; }
    if (it.kind === 'bandwidth') { const mb = (it.nile.match(/'(\d+)', 'mbps'/) || [, '10'])[1]; return `Entendi: limitar a banda de ${who} a ${mb} Mb/s. Em Nile, esta é a intent:`; }
    return `Entendi: vídeo sem travar para ${who}. Em Nile isso é o serviço cdn-qoe a partir desse endpoint; o deployer escolhe o servidor e o caminho de maior vazão.`;
  }
  const words = (text, from = 0) => text.split(/(\s+)/).map(w => (/^\s+$/.test(w) ? w : `<span class="w" style="--i:${from++}">${R.esc(w)}</span>`)).join('');
  const countWords = text => text.split(/\s+/).filter(Boolean).length;

  function approval(it) {
    const route = M.routes[it.id];
    if (it.state === 'pending') return `<div class="approve"><span class="ap-ic">${R.icon('i-shield')}</span><div class="ap-text"><b>Implantar ${it.id} na rede?</b><span>O deployer confere a sintaxe e a capacidade antes de instalar os fluxos no ONOS.</span></div><div class="ap-acts"><button class="btn btn-plain" type="button" data-i-act="cancel" data-id="${it.id}">Cancelar</button><button class="btn" type="button" data-i-act="edit" data-id="${it.id}">Editar</button><button class="btn btn-blue" type="button" data-i-act="approve" data-id="${it.id}">Aprovar</button></div></div>`;
    if (it.state === 'checking') return `<div class="approve is-busy"><span class="ap-ic"><i class="spinner"></i></span><div class="ap-text"><b class="shimmer">Verificando no deployer</b><span>Sintaxe, capacidade e caminho.</span></div></div>`;
    if (it.state === 'deployed') return `<div class="approve is-ok"><span class="ap-ic">${R.icon('i-check')}</span><div class="ap-text"><b>Implantada às ${it.when}</b><span>${route?.path ? `${it.flows} fluxos · servidor ${route.server} · caminho ${route.path.slice(1, -1).join(', ')}` : R.esc(it.effect || `${it.flows} fluxos`)}</span></div><button type="button" class="btn btn-plain" data-i-act="revoke" data-id="${it.id}">Revogar</button></div>`;
    if (it.state === 'revoked') return `<div class="approve is-off"><div class="ap-text"><span>Revogada às ${it.revokedAt || '–'}: fluxos e regras removidos do ONOS.</span></div></div>`;
    if (it.state === 'rejected') return `<div class="approve is-err"><span class="ap-ic">${R.icon('i-x')}</span><div class="ap-text"><b>Recusada pelo deployer (${it.code || 422})</b><span>${R.esc(it.error)}</span></div><div class="ap-acts"><button class="btn" type="button" data-i-act="edit" data-id="${it.id}">Editar</button><button class="btn btn-blue" type="button" data-i-act="regenerate" data-id="${it.id}">Regenerar</button></div></div>`;
    return `<div class="approve is-off"><div class="ap-text"><span>Cancelada. Nada foi enviado ao deployer.</span></div></div>`;
  }
  const thought = steps => `<details class="thought"><summary>Pensou por ${secs(steps)} s${R.icon('i-chevron-right', 'chev')}</summary><ol>${steps.map(([t, s]) => `<li><span>${t}</span><span>${R.fmt(s)} s</span></li>`).join('')}</ol></details>`;
  const ICON = { Deployer: 'i-deployer', Supervisor: 'i-eye', Profiler: 'i-chat' };

  function msgHtml(m, i) {
    const prev = M.chat[i - 1];
    const first = !prev || prev.role === 'user';
    if (m.role === 'user') {
      const it = M.intents.find(x => x.ask === m.text);
      return { cls: 'msg user', html: `<div class="bubble">${R.esc(m.text)}</div><div class="meta">${m.time}${m.source === 'Topologia' ? ` · ${R.icon('i-topo')} pelo rodapé da topologia` : ''}${it ? ` · ${it.id}` : ''}</div>` };
    }
    const av = first ? `<span class="av">${MARK}</span>` : '<span class="av-gap"></span>';
    const head = first ? `<div class="who"><b>REIN</b><span>${R.esc(R.state.model)}</span></div>` : '';
    if (m.role === 'event') {
      return { cls: `msg rein activity${first ? ' first' : ''}`, html: `${av}<div class="body">${head}<div class="act ${m.tone || ''}"><span class="act-ic">${R.icon(ICON[m.source] || 'i-bolt')}</span><span class="act-text"><b>${R.esc(m.source)}</b> ${R.esc(m.text)}</span><time>${m.time}</time></div></div>` };
    }
    let body = '';
    if (m.kind === 'thinking') {
      body = `<div class="thinking"><span class="shimmer">Traduzindo para Nile</span><ol>${m.steps.map(([t, s, done]) => `<li class="${done ? 'is-done' : ''}">${done ? R.icon('i-check') : '<i></i>'}<span>${t}</span>${done ? `<em>${R.fmt(s)} s</em>` : ''}</li>`).join('')}</ol></div>`;
    } else if (m.kind === 'ask') {
      const n = m.options.length;
      body = `<p class="prose">${n > 1 ? `Encontrei ${n} clientes que podem atender ao pedido. Para qual deles?` : n ? 'Encontrei um cliente que atende ao pedido. É este?' : 'Não há clientes na topologia. Adicione um host antes.'}</p>
        <div class="choices">${m.options.map(o => `<button type="button" class="choice${m.answered === o.value ? ' is-picked' : ''}" data-thread-answer="${R.esc(o.value)}" data-msg="${i}"${m.answered ? ' disabled' : ''}>${R.icon('i-laptop')}<span>${R.esc(o.label)}</span></button>`).join('')}</div>`;
    } else if (m.kind === 'text') {
      body = `<p class="prose">${R.esc(m.text)}</p>`;
    } else if (m.kind === 'proposal') {
      const it = M.intents.find(x => x.id === m.intent);
      if (!it) return { cls: 'msg rein', html: '' };
      const text = prose(it), streaming = m.streamUntil && Date.now() < m.streamUntil;
      const nWords = countWords(text);
      body = `${thought(m.steps || [])}
        <p class="prose">${streaming ? words(text) : R.esc(text)}</p>
        <div class="after" style="--after:${nWords}">
          <div class="code"><div class="code-head"><span>Nile</span><button type="button" class="code-copy" data-copy="${it.id}">${R.icon('i-copy')}<span>Copiar</span></button></div><pre class="nile" data-nile-for="${it.id}">${R.highlight(it.nile)}</pre></div>
          ${approval(it)}
          <div class="acts"><button type="button" class="ico" data-copy="${it.id}" data-tip="Copiar Nile" aria-label="Copiar Nile">${R.icon('i-copy')}</button><button type="button" class="ico" data-show-topo data-tip="Ver na topologia" aria-label="Ver na topologia">${R.icon('i-topo')}</button></div>
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
  helpBtn.className = 'tool'; helpBtn.type = 'button'; helpBtn.dataset.help = ''; helpBtn.dataset.tip = 'Guia das intents'; helpBtn.setAttribute('aria-label', 'Guia das intents: exemplos, sintaxe Nile e capacidades');
  helpBtn.innerHTML = R.icon('i-help');
  sideHead.querySelector('[data-new-intent]').before(helpBtn);
  const modeSeg = document.createElement('div');
  modeSeg.className = 'seg side-seg'; modeSeg.setAttribute('role', 'tablist'); modeSeg.setAttribute('aria-label', 'Visão');
  modeSeg.innerHTML = '<button type="button" role="tab" data-imode="chat" aria-pressed="true">Conversa</button><button type="button" role="tab" data-imode="applied" aria-pressed="false">Aplicadas</button>';
  sideHead.after(modeSeg);
  const applied = document.createElement('section');
  applied.className = 'applied'; applied.hidden = true; applied.setAttribute('aria-label', 'Intents aplicadas');
  chatMain.append(applied);
  let imode = 'chat', aFilter = 'active';
  const srcText = { Topologia: 'pelo rodapé da topologia', Intents: 'na conversa', 'Serviços': 'pelo painel de serviços' };
  function renderApplied() {
    const all = M.intents.filter(i => i.state === 'deployed' || i.state === 'revoked');
    const shown = all.filter(i => aFilter === 'all' || i.state === 'deployed').slice().reverse();
    applied.innerHTML = `<div class="ap-col">
      <header class="ap-head"><div><h2>Intents aplicadas</h2><p>${all.filter(i => i.state === 'deployed').length} em vigor no ONOS, ${all.filter(i => i.state === 'revoked').length} revogada${all.filter(i => i.state === 'revoked').length === 1 ? '' : 's'}. Cada linha é exatamente o que o deployer recebeu.</p></div>
        <div class="ap-tools"><div class="seg" role="group" aria-label="Filtro"><button type="button" data-afilter="active" aria-pressed="${aFilter === 'active'}">Em vigor</button><button type="button" data-afilter="all" aria-pressed="${aFilter === 'all'}">Todas</button></div><button class="btn" type="button" data-export-nile>${R.icon('i-export')}Exportar .nile</button></div></header>
      ${shown.length ? `<ol class="ap-list">${shown.map(it => { const u = M.chat.find(m => m.role === 'user' && (m.intent === it.id || m.text === it.ask)); return `<li class="ap-item st-${it.state}"><div class="ap-meta"><b class="mono">${it.id}</b><span class="ap-state"><i class="st st-${it.state === 'deployed' ? 'deployed' : 'cancelled'}"></i>${it.state === 'deployed' ? `Em vigor desde ${it.when}` : `Revogada às ${it.revokedAt || '–'}`}</span><span class="ap-src">${R.esc(srcText[u?.source] || 'na conversa')}</span></div>
          <pre class="nile">${R.highlight(it.nile)}</pre>
          <p class="ap-effect">${R.esc(it.effect || (it.flows ? `${it.flows} fluxos` : ''))}${it.ask ? ` · “${R.esc(it.ask)}”` : ''}</p>
          <div class="ap-acts"><button type="button" class="btn btn-plain" data-copy="${it.id}">${R.icon('i-copy')}<span>Copiar</span></button>${it.state === 'deployed' ? `<button type="button" class="btn btn-danger" data-i-act="revoke" data-id="${it.id}">Revogar</button>` : ''}</div></li>`; }).join('')}</ol>` : '<p class="ap-empty">Nenhuma intent em vigor. As aprovadas aparecem aqui.</p>'}</div>`;
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
      const body = M.intents.filter(i => i.state === 'deployed').map(i => `# ${i.id}, em vigor desde ${i.when}${i.effect ? `: ${i.effect}` : ''}\n${i.nile}`).join('\n\n') + '\n';
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([body], { type: 'text/plain' })); a.download = `intents-${R.env?.testbed || 'rein'}.nile`; a.click();
    }
  });
  R.on(type => { if ((type === 'intent' || type === 'chat') && imode === 'applied') renderApplied(); });

  // ------------------------------------------------------------ help: a guide to asking, Nile and the deployer
  const helpSheet = $('[data-sheet="help"]'), toc = $('[data-help-toc]'), doc = $('[data-help-doc]');
  const EX = [
    ['Quero vídeo sem travar para o cliente de SP', "define intent q1: for endpoint('192.168.0.2') add service('cdn-qoe')", 'O deployer escolhe o servidor DASH de menor RTT e o caminho de maior vazão. O supervisor mede a latência e pede outro caminho quando passa de 200 ms.', 'ok'],
    ['Use o roteamento por LLM para o cl0', "define intent q2: for endpoint('192.168.0.2') add service('llm')", 'Mesmo resultado, com o servidor e o caminho decididos pelo modelo em gpu.mfcaetano.lan:8000.', 'ok'],
    ['Limite o cl0 a 10 Mb/s', "define intent q3: for endpoint('192.168.0.2') set bandwidth('max', '10', 'mbps')", 'Um meter OpenFlow com banda DROP de 10.000 kbps em cada switch, aplicado ao tráfego do endereço.', 'ok'],
    ['Bloqueie UDP no cliente cl0', "define intent q4: for endpoint('192.168.0.2') block protocol('udp')", 'Regra deny no app ACL do ONOS para ipProto UDP a partir do endereço. O iperf3 -u desse cliente para de receber.', 'ok'],
    ['Bloqueie SSH no cliente de SP', "define intent q5: for endpoint('192.168.0.2') block protocol('ssh')", "Sintaxe válida, mas recusada: o ACL do ONOS só filtra por ipProto (TCP, UDP, ICMP), e SSH é uma porta.", 'no'],
    ['Inspecione o tráfego dos estudantes', "define intent q6: for group('students') add middlebox('dpi')", 'Recusada nesta rede: o deployer desvia para 192.168.1.4, que não existe na topologia do LFT.', 'no'],
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
<chain-fn>  ::= "middlebox" | "service"         ; service(...) é extensão do REIN

<window>    ::= "start" <time> "end" <time>
<time>      ::= <time-fn> "(" <str> ")"
<time-fn>   ::= "hour" | "date" | "datetime" | "timestamp"

<name>      ::= letra ou "_", seguida de letras, dígitos ou "_"
<str>       ::= "'" qualquer texto sem aspas simples "'"`;
  const CAPS = [
    ["add service('cdn-qoe')", 'Executa', 'Servidor de menor RTT, caminho de maior vazão; o supervisor recalcula.', 'yes'],
    ["add service('llm')", 'Executa', 'Servidor e caminho escolhidos pelo modelo.', 'yes'],
    ["set bandwidth('max', N, 'mbps')", 'Executa', 'Meter DROP em cada switch para o alvo.', 'yes'],
    ["set bandwidth('min', …)", 'Recusa', '422: só o limite máximo está implementado.', 'no'],
    ["allow | block protocol('tcp'|'udp'|'icmp')", 'Executa', 'App ACL do ONOS, por ipProto.', 'yes'],
    ["allow | block service('netflix')", 'Executa', 'ACL para 192.168.1.4/32, do mapa de serviços.', 'yes'],
    ["allow | block protocol('ssh'), outros", 'Recusa', '422: não é um ipProto.', 'no'],
    ["add | remove middlebox('dpi'|'honeypot'|'quarantine')", 'Depende', 'Precisa de um host em 192.168.1.4.', 'maybe'],
    ["set quota(…), start … end …", 'Sem efeito', 'A sintaxe passa; o deployer não aplica.', 'no'],
  ];
  const SECTIONS = [
    ['start', 'Como pedir', `<p class="hd-lead">Diga o que a rede precisa garantir e para quem. O REIN encontra o cliente pelo endereço (192.168.0.2), pelo nome (cl0) ou pelo estado do switch (“cliente de SP”), escreve a intent em Nile e espera a sua aprovação. Nada chega ao ONOS antes disso.</p>
      <ul class="hd-steps"><li><b>1</b><span>Escreva no campo do rodapé, na Topologia ou aqui. Enter envia, Shift+Enter quebra a linha, / leva ao campo.</span></li><li><b>2</b><span>Se faltar um dado, o REIN pergunta. Responda escolhendo uma opção.</span></li><li><b>3</b><span>Confira a Nile. Edite o texto se precisar e aprove.</span></li><li><b>4</b><span>O deployer confere a sintaxe e se a operação é executável. Se recusar, o motivo aparece e você pode regenerar.</span></li></ul>`],
    ['ex', 'Exemplos', `<div class="hd-ex">${EX.map(([nl, nile, what, ok]) => `<article class="${ok}"><p class="hd-nl">“${R.esc(nl)}”</p><pre class="nile">${R.highlight(nile)}</pre><p class="hd-what">${ok === 'no' ? R.icon('i-x') : R.icon('i-check')}${R.esc(what)}</p></article>`).join('')}</div>`],
    ['bnf', 'Sintaxe da Nile', `<p>A gramática do REIN, em BNF. Espaços não importam; valores vão entre aspas simples. Ela aceita as 256.913 linhas do NEAT e os pedidos do REIN, e só valida a forma: o que roda depende do deployer.</p><pre class="bnf">${R.esc(BNF).replace(/(&lt;[\w-]+&gt;)/g, '<span class="nt">$1</span>').replace(/(&quot;[^&]*?&quot;)/g, '<span class="t">$1</span>').replace(/(\s; [^\n]*)/g, '<span class="c">$1</span>')}</pre><p class="hd-src">Fonte: REIN/docs/intent-profiling/nile.lark (Lark, LALR).</p>`],
    ['caps', 'O que o deployer executa', `<table class="hd-caps"><thead><tr><th>Operação</th><th>Estado</th><th>Como</th></tr></thead><tbody>${CAPS.map(([op, st, how, k]) => `<tr><td><code>${R.esc(op)}</code></td><td><span class="cap ${k}">${st}</span></td><td>${R.esc(how)}</td></tr>`).join('')}</tbody></table><p class="hd-src">De deployer/classes/onos.py e target.py. Serviços configuráveis também pelo painel Serviços da Topologia.</p>`],
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

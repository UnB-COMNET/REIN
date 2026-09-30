/* The console against the real testbed. At load it asks the console API (GET /api/testbed, served by
   console/api/app.py on 127.0.0.1:4180). When it answers, the functions below take the place of the
   in-browser emulation in model.js, ops.js and experiments.js: every change runs `lft` on the VM as a
   job whose steps and commands come from lft itself, the topology is the one lft keeps, links carry the
   counters of `ip -s link`, traffic and captures are real sessions, experiments are the LFT runners,
   and intents go through the profiler and the deployer. Without the API (or with ?demo=) nothing
   changes: the emulation stays, and the testbed indicator says it is offline. */
(() => {
  'use strict';
  const R = window.REIN, M = R.model, esc = R.esc;
  const api = R.api = { online: false, busy: 0, load: new Map(), ifaces: new Map(), models: null };
  const orig = {
    job: R.job, apply: R.apply, addHost: R.addHost, updateHost: R.updateHost, removeHost: R.removeHost, addSwitch: R.addSwitch,
    setSwitchPower: R.setSwitchPower, removeSwitch: R.removeSwitch, importPy: R.importPy, exportPy: R.exportPy, profile: R.profile,
    answer: R.answer, proposeIntent: R.proposeIntent, intentAct: R.intentAct, ifaces: R.ifaces, linkLoad: R.linkLoad,
    start: R.traffic.start, stop: R.traffic.stop, loadOn: R.traffic.loadOn,
  };
  const when = f => (...a) => (api.online ? f : orig[f.orig])(...a);
  const online = (name, f) => { f.orig = name; return when(f); };

  // ---------------------------------------------------------------- HTTP and Server-Sent Events
  async function req(method, url, body, raw = false) {
    const r = await fetch(url, { method, headers: body !== undefined && !raw ? { 'Content-Type': 'application/json' } : {}, body: raw ? body : body === undefined ? undefined : JSON.stringify(body) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || data.detail || `HTTP ${r.status}`);
    return data;
  }
  // Reads an SSE response (GET or POST) and calls on(event, data) per message; on() returning false stops
  async function stream(url, init, on) {
    const r = await fetch(url, init);
    if (!r.ok) { const d = await r.json().catch(() => ({})); throw Object.assign(new Error(d.error || d.detail || `HTTP ${r.status}`), { status: r.status, data: d }); }
    const reader = r.body.getReader(), dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += dec.decode(value, { stream: true });
      let k;
      while ((k = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, k);
        buf = buf.slice(k + 2);
        let ev = 'message', data = '';
        block.split('\n').forEach(line => { if (line.startsWith('event: ')) ev = line.slice(7); else if (line.startsWith('data: ')) data += line.slice(6); });
        if (data && on(ev, JSON.parse(data)) === false) { reader.cancel(); return; }
      }
    }
  }
  const post = (url, body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  // ---------------------------------------------------------------- the testbed lft keeps
  const shortPath = p => String(p || '').replace(/^.*?\/(results\/)/, '$1');
  // Replaces the model's nodes and links with lft's state; positions stay where the console had them
  function loadState(s) {
    const old = new Map(M.nodes.map(n => [n.id, n]));
    const nodes = s.nodes.map(n => { const o = old.get(n.id); const pos = n.x != null ? { x: n.x, y: n.y } : o ? { x: o.x, y: o.y } : {}; return { ...n, ...pos, ...(o ? {} : { isNew: true }) }; });
    M.name = s.name || M.name;
    M.defaults = { ...M.defaults, ...s.defaults };
    M.nodes = nodes;
    M.links = s.links.map(l => ({ id: l.id, a: l.a, b: l.b, base: { ...l.base }, now: { ...l.now } }));
    place(nodes.filter(n => n.x == null));
    api.sig = JSON.stringify([s.nodes, s.links]);
    R.save();
    R.emit('topology', {});
    R.emit('change', {});
  }
  // Positions for nodes the console has not seen: switches on the map (their UF) or near their
  // neighbours, hosts around their switch, as the console places them
  function place(fresh) {
    if (!fresh.length) return;
    const B = window.REIN_BR;
    fresh.filter(n => n.kind === 'switch').forEach((n, i) => {
      const anchor = B?.anchors[n.uf];
      if (anchor) { n.x = anchor[0] * 1.4; n.y = anchor[1] * 1.4; return; }
      const near = M.links.filter(l => l.a === n.id || l.b === n.id).map(l => R.node(l.a === n.id ? l.b : l.a)).filter(v => v && v.x != null);
      n.x = near.length ? near.reduce((t, v) => t + v.x, 0) / near.length + 120 : i * 180;
      n.y = near.length ? near.reduce((t, v) => t + v.y, 0) / near.length - 150 : 0;
    });
    fresh.filter(n => n.kind === 'host').forEach(n => {
      const sw = R.node(n.sw) || { x: 0, y: 0 }, k = R.hosts().filter(h => h.sw === n.sw && h.x != null).length, a = k * 0.9 + Math.PI / 2;
      n.x = sw.x + Math.cos(a) * 150; n.y = sw.y + Math.sin(a) * 150;
    });
  }

  // ---------------------------------------------------------------- jobs: what lft runs, step by step
  // lft's step titles, as the console words them
  const STEP_PT = [
    [/^Shape the access link/, () => 'Filas tc no link de acesso'],
    [/^Shape (\S+) in (\S+)/, m => `Filas tc de ${m[1]} em ${m[2]}`],
    [/^Set (\S+) (up|down) in (\S+)/, m => `${m[1]} ${m[2]} em ${m[3]}`],
    [/^Start the Open vSwitch container (\S+)/, m => `Subindo o container Open vSwitch ${m[1]}`],
    [/^Start (\S+) from (\S+)/, m => `Criando o container ${m[1]} (${m[2]})`],
    [/^Start the REIN services/, () => 'Subindo os serviços do REIN'],
    [/^Start (\S+)$/, m => `Iniciando o container ${m[1]}`],
    [/^Stop the REIN services/, () => 'Parando os serviços do REIN'],
    [/^Stop (\S+)$/, m => `Parando o container ${m[1]}`],
    [/^Remove (\S+) from (\S+)/, m => `Tirando ${m[1]} do Open vSwitch de ${m[2]}`],
    [/^Remove (\S+)$/, m => `Removendo o container ${m[1]}`],
    [/^Expose the (\S+) namespace/, m => `Namespace de ${m[1]} em /var/run/netns`],
    [/^Link (\S+) to (\S+) again/, m => `Refazendo o link ${m[1]}–${m[2]}`],
    [/^Link (\S+) to (\S+)/, m => `Par veth ${m[1]}–${m[2]} e filas tc`],
    [/^Address (\S+) on (\S+)/, m => `Endereço ${m[1]} em ${m[2]}`],
    [/^ARP from (\S+)/, m => `ARP de ${m[1]} para o ONOS`],
    [/^ONOS sees (\S+)/, m => `Esperando o ONOS ver ${m[1]}`],
    [/^ONOS marks (\S+) unavailable/, m => `O ONOS marca ${m[1]} como indisponível`],
    [/^ONOS forgets (\S+)/, m => `O ONOS esquece ${m[1]}`],
    [/^Bridge (\S+), datapath (\S+), (\S+)/, m => `Bridge ${m[1]}, datapath ${m[2]}, ${m[3]}`],
    [/^Point it to ONOS/, () => 'Ligando ao controlador ONOS'],
    [/^Pin the OpenFlow port numbers/, () => 'Fixando os números das portas OpenFlow'],
    [/^Its veth pairs go/, () => 'Os pares veth somem com o namespace'],
    [/^Reconnect (\S+)/, m => `Religando ${m[1]}`],
    [/^(Pause|Unpause) (\S+)/, m => `${m[1] === 'Pause' ? 'Pausando' : 'Retomando'} ${m[2]}`],
    [/^Results directory/, () => 'Diretório de resultados'],
    [/^Capture (\S+) in (\S+)/, m => `tcpdump em ${m[1]} (${m[2]})`],
    [/^iperf3 server in (\S+)/, m => `Servidor iperf3 em ${m[1]}`],
    [/^(\S+) client in (\S+)/, m => `Cliente ${m[1]} em ${m[2]}`],
    [/^Wait for deployer/, () => 'Esperando deployer, supervisor e profiler'],
  ];
  const stepText = t => { for (const [re, f] of STEP_PT) { const m = t.match(re); if (m) return f(m); } return t; };

  let hud = null;
  function ensureHud() {
    if (hud) return hud;
    hud = document.createElement('section');
    hud.className = 'activity';
    hud.setAttribute('aria-live', 'polite');
    hud.setAttribute('aria-label', 'Atividade');
    document.body.append(hud);
    hud.addEventListener('click', e => { const j = e.target.closest('[data-job]'); if (j) j.classList.toggle('is-open'); });
    return hud;
  }
  // Same card as ops.js draws for a job, filled with lft's steps, commands and output
  function paintJob(j) {
    let el = hud.querySelector(`[data-job="${j.id}"]`);
    if (!el) { el = document.createElement('div'); el.className = 'job'; el.dataset.job = j.id; hud.prepend(el); }
    const done = j.status !== 'running', total = Math.max(j.total, j.steps.length, 1), cur = j.steps.at(-1);
    const out = [...j.log].reverse().find(([k]) => k === 'out')?.[1]; // before lft's first step (a topology build), its latest line
    el.classList.toggle('is-done', done);
    el.classList.toggle('is-err', !!j.error);
    el.innerHTML = `<div class="job-h"><span class="job-ic">${done ? (j.error ? R.icon('i-x') : R.icon('i-check')) : '<i class="spinner"></i>'}</span><b>${esc(j.title)}</b><em>${done ? (j.error ? 'falhou' : 'pronto') : j.steps.length ? `${j.steps.length}/${total}` : ''}</em></div>
      <p class="job-s">${esc(done ? (j.error || j.doneText || 'Concluído.') : cur ? cur.text : out || 'Enviando ao testbed')}</p>
      <div class="job-bar"><i style="width:${(done ? 100 : Math.max(0, j.steps.length - 1) / total * 100).toFixed(1)}%"></i></div>
      <pre class="job-log">${j.log.slice(-60).map(([k, t]) => (k === 'cmd' ? `<span>$ ${esc(t)}</span>` : esc(t))).join('\n')}</pre>`;
    const pre = el.querySelector('.job-log');
    pre.scrollTop = pre.scrollHeight;
  }
  // Runs one API call that answers {job} and follows its events; the promise gets lft's result
  function realJob({ title, nodes = [], doneText = '' }, method, url, body, raw = false) {
    ensureHud();
    const j = { id: `j${Date.now()}${Math.random().toString(36).slice(2, 5)}`, title, doneText, steps: [], total: 0, log: [], status: 'running' };
    nodes.forEach(id => R.emit('provision', { id, on: true }));
    paintJob(j);
    api.busy++;
    const promise = (async () => {
      let final = null;
      try {
        const { job } = await req(method, url, body, raw);
        await stream(`/api/jobs/${job}/events`, {}, (ev, d) => {
          if (ev === 'step') { if (d.step === 1) j.total += d.of; j.steps.push({ text: stepText(d.title) }); d.cmds.forEach(c => j.log.push(['cmd', c])); }
          else if (ev === 'stdout' && d.line) j.log.push(['out', d.line]);
          else if (ev === 'status') final = d;
          paintJob(j);
        });
        if (final?.status !== 'done') throw new Error(final?.error || 'o testbed não concluiu a tarefa');
        j.status = 'done';
        if (final.result?.state) loadState(final.result.state);
        refreshIfaces();
        return final.result;
      } catch (err) {
        j.status = 'failed'; j.error = err.message;
        R.notify({ source: title, text: err.message, tone: 'down' });
        api.poll?.();
        throw err;
      } finally {
        api.busy--;
        paintJob(j);
        nodes.forEach(id => R.emit('provision', { id, on: false }));
        setTimeout(() => { const el = hud.querySelector(`[data-job="${j.id}"]`); el?.classList.add('is-leaving'); setTimeout(() => el?.remove(), 400); }, j.error ? 9000 : 3200);
      }
    })();
    promise.job = j;
    promise.catch(() => {});
    return promise;
  }

  // R.job: the console announces a job before the change it names; the change itself (R.addHost,
  // R.apply...) runs it for real under that title. A node already being created is awaited instead.
  let stash = null;
  const creating = new Map();
  R.job = online('job', opts => {
    const p = creating.get(opts.nodes?.[0]);
    if (p) { creating.delete(opts.nodes[0]); p.job.title = opts.title; p.job.doneText = opts.doneText || ''; return p.then(() => ({}), () => ({})); }
    stash = { title: opts.title, nodes: opts.nodes || [], doneText: opts.doneText };
    return Promise.resolve({});
  });
  const titled = (title, nodes) => { const s = stash || { title, nodes }; stash = null; return s; };

  // ---------------------------------------------------------------- changes to the topology
  R.apply = online('apply', (id, v) => {
    const l = R.link(id);
    const body = v.down ? { down: true } : { rate: v.rate, delay: v.delay, jitter: v.jitter ?? l.now.jitter, loss: v.loss ?? 0, down: false };
    return realJob(titled(`Link ${l.a}–${l.b}`, [l.a, l.b]), 'PUT', `/api/testbed/links/${id}`, body)
      .then(() => { const n = R.link(id); R.log('Testbed', v.down ? `${n.a}–${n.b} derrubado.` : `${n.a}–${n.b} em ${R.fmt(n.now.rate)} Mb/s e ${R.fmt(n.now.delay)} ms${n.now.loss ? `, perda ${R.fmt(n.now.loss)}%` : ''}.`, R.linkState(n) === 'ok' ? '' : R.linkState(n)); }, () => {});
  });
  R.addHost = online('addHost', h => {
    const sw = R.node(h.sw), k = R.hosts().filter(x => x.sw === h.sw).length, a = k * 0.9 + Math.PI / 2;
    const n = { kind: 'host', ...h, x: sw.x + Math.cos(a) * 150, y: sw.y + Math.sin(a) * 150, isNew: true, pending: true };
    M.nodes.push(n);
    R.emit('topology', { added: n.id });
    const p = realJob({ title: `Criando ${h.id}`, nodes: [h.id] }, 'POST', '/api/testbed/hosts', { id: h.id, role: h.role, sw: h.sw, ip: h.ip, image: h.image });
    creating.set(h.id, p);
    p.then(() => R.log('Testbed', `Host ${h.id} criado em ${h.sw} com a imagem ${h.image}.`),
      () => { M.nodes = M.nodes.filter(x => x !== n); R.emit('topology', {}); });
    return n;
  });
  R.updateHost = online('updateHost', (id, patch) => realJob(titled(`Atualizando ${id}`, [id]), 'PUT', `/api/testbed/hosts/${id}`, { id: patch.id, sw: patch.sw, ip: patch.ip, image: patch.image })
    .then(() => R.log('Testbed', `Host ${patch.id || id} atualizado: ${patch.image}, ${patch.ip}, em ${patch.sw}.`), () => {}));
  R.removeHost = online('removeHost', id => realJob(titled(`Removendo ${id}`, [id]), 'DELETE', `/api/testbed/hosts/${id}`)
    .then(() => R.log('Testbed', `Host ${id} removido.`), () => {}));
  R.addSwitch = online('addSwitch', ({ id, uf, links = [] }) => {
    const near = links.map(l => R.node(l.to)).filter(Boolean);
    const cx = near.length ? near.reduce((t, v) => t + v.x, 0) / near.length : 0, cy = near.length ? near.reduce((t, v) => t + v.y, 0) / near.length : 0;
    const n = { id, kind: 'switch', pop: `PoP-${uf}`, uf, dpid: `of:${(+id.slice(1) + 1).toString(16).padStart(16, '0')}`, x: cx + 120, y: cy - 150, isNew: true };
    M.nodes.push(n);
    R.emit('topology', { added: id });
    const p = realJob({ title: `Criando ${id}`, nodes: [id] }, 'POST', '/api/testbed/switches', { id, uf, links: links.map(l => ({ to: l.to, rate: +l.rate || M.defaults.rate, delay: +l.delay || M.defaults.delay, loss: +l.loss || 0 })) });
    creating.set(id, p);
    p.then(() => R.log('Testbed', `Switch ${id} criado (${uf}) com ${links.length} link${links.length === 1 ? '' : 's'}.`),
      () => { M.nodes = M.nodes.filter(x => x !== n); R.emit('topology', {}); });
    return n;
  });
  R.setSwitchPower = online('setSwitchPower', (id, on) => realJob(titled(`${on ? 'Ligando' : 'Desligando'} ${id}`, [id]), 'POST', `/api/testbed/switches/${id}/${on ? 'start' : 'stop'}`)
    .then(() => R.log('Testbed', on ? `Switch ${id} ligado.` : `Switch ${id} desligado.`, on ? '' : 'down'), () => {}));
  R.removeSwitch = online('removeSwitch', id => realJob(titled(`Removendo ${id}`, [id]), 'DELETE', `/api/testbed/switches/${id}`)
    .then(() => R.log('Testbed', `Switch ${id} removido.`), () => {}));
  // Import: the console reads the file (its summary, its hosts) and the testbed is rebuilt from the
  // console's own export of it, so what comes up is what the console shows
  R.importPy = online('importPy', (text, filename = 'topologia.py') => {
    const summary = orig.importPy(text, filename);
    const ids = M.nodes.map(n => n.id);
    M.nodes.forEach(n => { n.pending = true; });
    realJob({ title: `Importando ${M.name}`, nodes: ids, doneText: `${summary.switches} switches e ${summary.hosts} hosts no testbed` }, 'POST', `/api/testbed/import?name=${encodeURIComponent(M.name)}`, orig.exportPy(), true)
      .then(() => { R.log('Testbed', `Topologia ${M.name} criada no testbed.`); refreshIntents(); }, () => api.poll());
    return summary;
  });

  // ---------------------------------------------------------------- interfaces and link load
  async function refreshIfaces() {
    try {
      const rows = await req('GET', '/api/ifaces');
      api.ifaces = new Map();
      rows.forEach(i => { if (!api.ifaces.has(i.node)) api.ifaces.set(i.node, []); api.ifaces.get(i.node).push({ ...i, ip: i.ip || undefined }); });
    } catch { /* keep the last ones */ }
  }
  R.ifaces = online('ifaces', id => api.ifaces.get(id) || orig.ifaces(id));
  // What crosses each link, from the counters of both ends (lft link stats)
  R.linkLoad = online('linkLoad', () => new Map(M.links.map(l => [l.id, l.now.down ? 0 : api.load.get(l.id) || 0])));
  async function refreshStats() {
    try {
      const st = await req('GET', '/api/stats');
      api.stats = st;
      api.load = new Map(Object.entries(st.links).map(([id, s]) => [id, Math.max(s.ab || 0, s.ba || 0)]));
    } catch { /* next second */ }
  }

  // ---------------------------------------------------------------- traffic sessions
  const sessions = [];
  let seq = 0;
  R.traffic.start = online('start', async o => {
    const c = R.node(o.client), s = R.node(o.server);
    if (!c || !s) return null;
    const sess = { id: `n${++seq}`, ...o, status: 'starting', t0: 0, lines: { client: [], server: [] }, rateNow: 0, bytes: 0, file: '', serverLog: '', clientCmd: '', serverCmd: '' };
    sessions.unshift(sess);
    R.emit('traffic', { id: sess.id });
    const iperf = o.tool === 'iperf3';
    try {
      const m = await realJob({ title: `${iperf ? 'iperf3' : o.tool === 'dash' ? 'DASH' : 'ping'} ${o.reverse || o.tool === 'dash' ? `${s.id} → ${c.id}` : `${c.id} → ${s.id}`}`, nodes: [c.id, s.id] },
        'POST', '/api/traffic', { tool: o.tool, client: c.id, server: s.id, port: o.port, reverse: o.reverse, proto: o.proto, rate: o.rate, duration: o.duration, out: o.out });
      Object.assign(sess, { id: m.id, port: m.port || o.port, file: shortPath(m.file), serverLog: shortPath(m.server_file) || 'access log do servidor', clientCmd: m.cmd, serverCmd: m.server_cmd || '', status: 'running', t0: m.started * 1000 });
      if (sess.stopAsked) R.traffic.stop(sess.id);
      follow(sess);
      R.log('Testbed', `Tráfego ${o.tool} ${c.id}↔${s.id} iniciado. Saída em ${sess.file}.`);
    } catch { sess.status = 'stopped'; }
    R.emit('traffic', { id: sess.id });
    return sess;
  });
  // The tools print many lines a second; the panel and the log repaint once a second, as they do offline
  let repaint = null;
  const repaintSoon = () => { repaint ||= setTimeout(() => { repaint = null; R.emit('traffic', {}); }, 1000); };
  function follow(sess) {
    stream(`/api/traffic/${sess.id}/logs`, {}, (ev, d) => {
      if (ev === 'line') { const lines = sess.lines[d.side]; lines.push(d.line); if (lines.length > 400) lines.splice(0, 100); repaintSoon(); }
    }).catch(() => {});
  }
  R.traffic.stop = online('stop', async id => {
    const sess = sessions.find(x => x.id === id);
    if (!sess || sess.status === 'done' || sess.status === 'stopped') return;
    if (sess.status === 'starting') { sess.stopAsked = true; return; }
    try { await req('DELETE', `/api/traffic/${id}`); } catch (err) { R.notify({ source: 'Tráfego', text: err.message, tone: 'down' }); }
    sess.status = 'stopped';
    R.log('Testbed', `Tráfego ${sess.client}↔${sess.server} parado. Resultado em ${sess.file}.`);
    R.emit('traffic', { id });
  });
  R.traffic.loadOn = online('loadOn', () => new Map()); // the link counters already carry every session
  // Sessions already running on the VM (started from another tab, the terminal or before a reload)
  async function adoptSessions() {
    try {
      (await req('GET', '/api/traffic')).filter(r => r.status === 'running' && !sessions.some(x => x.id === r.id)).forEach(r => {
        const sess = { id: r.id, tool: r.tool, client: r.client, server: r.server, port: r.port, reverse: r.reverse, proto: r.proto, rate: r.rate, duration: r.duration, out: r.out,
          status: 'running', t0: r.started * 1000, lines: { client: [], server: [] }, rateNow: r.rate_mbps || 0, bytes: 0,
          file: shortPath(r.file), serverLog: shortPath(r.server_file) || 'access log do servidor', clientCmd: r.cmd, serverCmd: r.server_cmd || '' };
        sessions.push(sess);
        follow(sess);
      });
      R.emit('traffic', {});
    } catch { /* none */ }
  }
  async function refreshTraffic() {
    if (!sessions.some(x => x.status === 'running')) return;
    try {
      const rows = await req('GET', '/api/traffic');
      rows.forEach(r => {
        const sess = sessions.find(x => x.id === r.id);
        if (!sess || sess.status === 'stopped') return;
        sess.rateNow = r.rate_mbps || 0;
        if (r.status !== 'running') { sess.status = r.status === 'stopped' ? 'stopped' : 'done'; R.log('Testbed', `Tráfego ${sess.client}↔${sess.server} terminou. Resultado em ${sess.file}.`); }
      });
      R.emit('traffic', {});
    } catch { /* next time */ }
  }

  // ---------------------------------------------------------------- intents: the profiler and the deployer
  const byIp = ip => R.hosts().find(h => h.ip === ip);
  const routeOf = i => {
    const server = byIp(i.server_ip), client = byIp(i.client_ip);
    const sws = (i.path || []).map(uf => R.switches().find(s => s.uf === uf)?.id).filter(Boolean).reverse();
    return server && client ? { client: client.id, server: server.id, path: [server.id, ...sws, client.id] } : null;
  };
  // The deployer's intents become the console's routes and deployed intents
  async function refreshIntents() {
    try {
      const { intents = [] } = await req('GET', '/api/deployer/intents');
      M.routes = {};
      intents.forEach(i => {
        const r = routeOf(i);
        let it = M.intents.find(x => x.nile === i.intent && x.state === 'deployed');
        if (!it) {
          const named = (i.intent.match(/define intent (\w+):/) || [])[1];
          it = { id: named && !M.intents.some(x => x.id === named) ? named : nileId(), ask: i.intent, nile: i.intent, state: 'deployed', when: R.hhmm(), client: r?.client, kind: R.nileInfo(i.intent).kind };
          M.intents.push(it);
        }
        if (r) M.routes[it.id] = r;
      });
      R.emit('change', { reroute: true });
      R.emit('intent', {});
    } catch { /* the deployer may be down */ }
  }
  // Drift and reroutes from the supervisor and the deployer (the profiler relays the deployer's events)
  function watchAssurance() {
    stream('/api/profiler/events', {}, (ev, e) => {
      if (ev !== 'assurance') return;
      const c = byIp(e.client_ip)?.id || e.client_ip, path = (e.path || []).join(', ');
      if (e.type === 'recalculate') {
        R.log('Supervisor', `Desvio para ${c}: ${String(e.reason || '').replace(/^\W+/, '')}`, 'warn');
        api.lastDrift = R.hhmm();
        R.monitor?.marks.push({ ts: e.ts * 1000, label: 'Desvio', tone: 'warn' });
      }
      R.log('Deployer', e.status === 200 ? `Rota de ${c} ${e.type === 'recalculate' ? 'recalculada' : 'implantada'}: ${path}.` : `Falhou (${e.status}) para ${c}.`, e.status === 200 ? '' : 'down');
      refreshIntents();
    }).catch(() => setTimeout(watchAssurance, 5000));
  }
  const nileId = () => `q${M.intents.length + 1}`;
  const secs = t0 => (performance.now() - t0) / 1000;
  // Sends the request to the profiler and shows its stages; stops at confirm (proposal or question)
  async function profileStream(msg, url, body, it) {
    const t0 = performance.now();
    let mark = 0;
    const done = k => { for (; mark <= k && mark < msg.steps.length; mark++) { msg.steps[mark][1] = secs(t0); msg.steps[mark][2] = true; } R.emit('chat', { progress: true }); };
    await stream(url, post(url, body), (ev, d) => {
      if (ev === 'thread') msg.thread = d.thread_id;
      if (ev === 'ground') done(0);
      if (ev === 'retrieve') done(1);
      if (ev === 'generate') done(2);
      if (ev === 'confirm') {
        done(2);
        if (d.error) { it.state = 'rejected'; it.code = d.error.status; it.error = d.error.detail || d.error.error || JSON.stringify(d.error); R.log('Deployer', `Recusou ${it.id} (${it.code}): ${it.error}`, 'down', it.id); R.emit('intent', { id: it.id }); return false; }
        if (String(d.nile).startsWith('ASK:')) {
          const video = /v[ií]deo|trav|qoe|stream|dash/i.test(msg.ask || '') ? R.clientsList().filter(R.hasVideo) : [];
          Object.assign(msg, { kind: 'ask', text: d.nile.slice(4).trim(), options: (video.length ? video : R.clientsList()).map(c => ({ label: `${c.id}, ${c.ip}`, value: c.ip })) });
          R.emit('chat', { ask: true });
          return false;
        }
        const info = R.nileInfo(d.nile);
        Object.assign(it, { nile: d.nile.replace(/define intent \w+:/, `define intent ${it.id}:`), state: 'pending', thread: msg.thread, client: byIp(info.ip)?.id || it.client, kind: info.kind, error: null });
        if (!M.intents.includes(it)) M.intents.push(it);
        Object.assign(msg, { kind: 'proposal', intent: it.id });
        R.emit('chat', { proposal: it.id });
        R.emit('intent', { id: it.id });
        return false;
      }
      if (ev === 'done') { const r = d.result || {}; Object.assign(it, { state: d.status === 'deployed' ? 'deployed' : d.status, when: R.hhmm(), flows: r.flows, effect: r.server_ip ? `servidor ${byIp(r.server_ip)?.id || r.server_ip}, caminho ${(r.path || []).join(', ')}` : '' }); R.log('Deployer', `${it.id} implantada. ${r.flows} fluxos${r.server_ip ? `, servidor ${byIp(r.server_ip)?.id || r.server_ip}` : ''}.`, 'ok', it.id); refreshIntents(); R.emit('intent', { id: it.id }); return false; }
      if (ev === 'error') { Object.assign(msg, { kind: 'text', text: `O profiler falhou: ${d.detail}` }); R.emit('chat', {}); return false; }
    });
  }
  R.profile = online('profile', async (text, source = 'Topologia') => {
    const time = R.hhmm();
    M.chat.push({ role: 'user', text, time, source });
    const msg = { role: 'rein', kind: 'thinking', time, ask: text, steps: [['Contexto', 0, false], ['Exemplos', 0, false], [`Tradução com ${R.state.model}`, 0, false]] };
    M.chat.push(msg);
    R.emit('chat', { text, source });
    const it = { id: nileId(), ask: text, nile: '', state: 'pending', when: null, client: null, kind: 'other' };
    try { await profileStream(msg, '/api/profiler/profile', { text, model: R.state.model }, it); }
    catch (err) { Object.assign(msg, { kind: 'text', text: err.status === 409 ? `O modelo ${R.state.model} não está carregado. Escolha outro ou carregue-o no menu de modelos.` : `O profiler não respondeu: ${err.message}` }); R.emit('chat', {}); }
  });
  R.answer = online('answer', async (msgIndex, value, source = 'Intents') => {
    const m = M.chat[msgIndex];
    if (!m?.thread) return orig.answer(msgIndex, value, source);
    m.answered = value;
    M.chat.push({ role: 'user', text: value, time: R.hhmm(), source });
    const msg = { role: 'rein', kind: 'thinking', time: R.hhmm(), ask: m.ask, thread: m.thread, steps: [['Contexto', 0, false], ['Exemplos', 0, false], [`Tradução com ${R.state.model}`, 0, false]] };
    M.chat.push(msg);
    R.emit('chat', {});
    const it = { id: nileId(), ask: m.ask, nile: '', state: 'pending', when: null, client: byIp(value)?.id, kind: 'other' };
    try { await profileStream(msg, `/api/profiler/profile/${m.thread}/resume`, { action: 'answer', text: value }, it); }
    catch (err) { Object.assign(msg, { kind: 'text', text: `O profiler não respondeu: ${err.message}` }); R.emit('chat', {}); }
  });
  // Approval: through the profiler thread the intent came from; an intent the console wrote itself
  // (services, plans: R.proposeIntent) goes straight to the deployer
  R.intentAct = online('intentAct', async (id, act, nileText) => {
    const it = M.intents.find(i => i.id === id);
    if (!it) return;
    if (act === 'edit') { if (nileText) it.nile = nileText; R.emit('intent', { id }); return; }
    if (act === 'revoke') {
      await req('DELETE', '/api/deployer/delete_all').catch(err => R.notify({ source: 'Deployer', text: err.message, tone: 'down' }));
      M.intents.filter(i => i.state === 'deployed').forEach(i => { i.state = 'revoked'; i.revokedAt = R.hhmm(); });
      M.routes = {};
      R.log('Deployer', 'Intents revogadas: o deployer remove todos os fluxos de uma vez.', '', id);
      R.emit('change', { policy: id }); R.emit('intent', { id });
      return;
    }
    const msg = [...M.chat].reverse().find(m => m.intent === id) || {};
    if (act === 'cancel') {
      it.state = 'cancelled';
      if (it.thread) req('POST', `/api/profiler/profile/${it.thread}/resume`, { action: 'cancel' }).catch(() => {});
      R.emit('intent', { id }); R.toast('Intent cancelada. Nada foi enviado ao deployer.');
      return;
    }
    if (act === 'regenerate' && !it.thread) return orig.intentAct(id, act);
    it.state = 'checking';
    R.emit('intent', { id });
    try {
      if (it.thread) await profileStream({ ...msg, steps: [] }, `/api/profiler/profile/${it.thread}/resume`, act === 'regenerate' ? { action: 'regenerate' } : { action: 'deploy', nile: it.nile }, it);
      else {
        const r = await fetch('/api/deployer/deploy', post('/api/deployer/deploy', { intent: it.nile }));
        const d = await r.json().catch(() => ({}));
        if (r.ok) {
          const flows = Object.values(d.controller_responses || {}).reduce((t, c) => t + (c.output?.responses?.length || 0), 0);
          Object.assign(it, { state: 'deployed', when: R.hhmm(), flows, effect: d.server_ip ? `servidor ${byIp(d.server_ip)?.id || d.server_ip}` : '' });
          R.log('Deployer', `${it.id} implantada. ${flows} fluxos.`, 'ok', it.id);
          refreshIntents();
        } else Object.assign(it, { state: 'rejected', code: r.status, error: d.detail || d.error || `HTTP ${r.status}` });
      }
    } catch (err) { Object.assign(it, { state: 'rejected', code: err.status || 503, error: err.message }); }
    if (it.state === 'rejected') R.log('Deployer', `Recusou ${id} (${it.code}): ${it.error}`, 'down', id);
    R.emit('intent', { id }); R.emit('change', { policy: id });
  });

  // ---------------------------------------------------------------- models and monitoring
  async function refreshModels() {
    try { api.models = await req('GET', '/api/profiler/models'); R.state.model = api.models.models.find(m => m.id === R.state.model && m.state === 'awake')?.id || api.models.models.find(m => m.state === 'awake')?.id || R.state.model; } catch { /* keep */ }
  }
  api.loadModel = async id => {
    const m = api.models?.models.find(x => x.id === id);
    if (!m || m.state === 'awake') return;
    R.toast('Acordando o modelo:', `POST /api/profiler/models/${id}/load`);
    try { await req('POST', `/api/profiler/models/${id}/load`); } catch (err) { R.notify({ source: `Modelo ${id}`, text: err.message, tone: 'down' }); }
    refreshModels().then(() => R.emit('gpu', {}));
  };
  // One monitoring sample: throughput at the client's access link (lft link stats), RTT of the route
  // (its links' delay, from tc), the observer's counters (supervisor /metrics)
  api.sample = (series, observer, flowId) => {
    const r = M.routes[flowId] || Object.values(M.routes)[0];
    const h = r && api.stats?.hosts?.[r.client];
    const lat = r && !R.pathBroken(r.path) ? R.pathDelay(r.path) * 2 : 0;
    series.push({ ts: Date.now(), thr: h ? Math.max(h.rx || 0, h.tx || 0) : 0, lat });
    if (series.length > 7200) series.shift();
    const m = api.supervisor;
    if (m) Object.assign(observer, { onosToObserver: m.msgs_onos_to_observer, observerToDeployer: m.msgs_observer_to_deployer, detection: m.detection_time_s || 0, lastDrift: api.lastDrift || null });
  };
  // The services' own logs for Módulos, as [time, text, tone]
  async function refreshLogs() {
    const tone = t => (/error|critical|✖|traceback/i.test(t) ? 'down' : /warn|⚠/i.test(t) ? 'warn' : '');
    await Promise.all(['profiler', 'deployer', 'supervisor'].map(async id => {
      try { (api.logs ||= {})[id] = (await req('GET', `/api/rein/logs/${id}`)).map(r => [new Date(r.ts).toTimeString().slice(0, 8), r.text, tone(r.text)]); } catch { /* keep */ }
    }));
  }
  async function refreshSupervisor() { try { api.supervisor = await req('GET', '/api/supervisor/metrics'); } catch { /* down */ } }
  // The drifts the deployer already acted on: the last one's time, and marks on the charts
  async function pastDrifts() {
    try {
      const drifts = (await req('GET', '/api/deployer/events?after=0')).events.filter(e => e.type === 'recalculate');
      if (drifts.length) api.lastDrift = R.hhmm(new Date(drifts.at(-1).ts * 1000));
      drifts.filter(e => e.ts * 1000 > Date.now() - 3600e3).forEach(e => R.monitor?.marks.push({ ts: e.ts * 1000, label: 'Desvio', tone: 'warn' }));
    } catch { /* the deployer may be down */ }
  }

  // ---------------------------------------------------------------- experiments: the LFT runners
  const PHASES = [['Limpando', 'cleanup'], ['Subindo o ONOS', 'onos'], ['Ativando apps', 'apps'], ['Criando a topologia', 'topology'], ['Hosts do plano', 'hosts'], ['Descoberta', 'discovery'], ['Subindo deployer', 'rein'], ['Estabiliza', 'stabilize']];
  const STATE_OF = { normal: 'ok', degrade: 'warn', 'take down': 'down' };
  api.startRun = async run => {
    const hms = () => new Date().toTimeString().slice(0, 8);
    const log = t => { run.log.push(`[${hms()}] ${t}`); if (run.log.length > 300) run.log.splice(0, 60); };
    const keys = run.phases.map(p => PHASES.find(([label]) => p[0].startsWith(label))?.[1]);
    try {
      const info = (api.experiments || []).find(e => e.name === run.runner);
      if (info?.windows) run.windows = info.windows;
      if (info?.window_s) run.winLen = info.window_s;
      const { run: rid } = run.flows
        ? await req('POST', '/api/experiments/plan', run.py, true)
        : await req('POST', `/api/experiments/${run.runner}/run`, { mode: run.mode, hindering: run.hindering, seed: +(String(run.dir).match(/seed(\d+)$/) || [, 1])[1], run_name: run.name, auto_start: run.auto });
      run.rid = rid;
      log(`console-api · run ${rid} · sudo lft experiment ${run.flows ? `plan --path ${run.name}.py` : run.runner}`);
      await stream(`/api/runs/${rid}/events`, {}, (ev, e) => {
        if (ev === 'phase') { const k = keys.indexOf(e.name); if (k >= 0 && k + 1 > run.phaseAt) run.phaseAt = k + 1; log(`${e.name} · ${e.text}`); }
        else if (ev === 'window') {
          if (e.state === 'start') {
            // each window's clock starts when the runner opens it (its windows also hold setup waits)
            run.pre = (Date.now() - run.t0) / 1000 - (e.index - 1) * run.winLen;
            run.win = e.index - 1;
            if (!run.flows && run.target) run.states = { [run.target]: run.hit?.includes(e.index) ? (run.hindering === 'take down' ? 'down' : 'warn') : 'ok' };
            log(`snapshot ${e.index}/${run.windows || '∞'} start`);
          } else { run.files.push(...(e.files || []).map(f => f.replace(/^snapshots\//, ''))); log(`snapshot ${e.index} closed`); }
        } else if (ev === 'links') run.states = Object.fromEntries(Object.entries(e.states).map(([id, st]) => [id, STATE_OF[st] || 'ok']));
        else if (ev === 'flow') { const f = run.flows?.[+e.id.slice(1) - 1]; if (f) f.state = e.state === 'start' ? 'on' : 'off'; if (e.file && !run.files.includes(e.file)) run.files.push(e.file); log(`flow ${e.id} ${e.tool || ''} ${e.state}${e.file ? ` · ${e.file}` : ''}`); }
        else if (ev === 'event') { const x = run.events?.[+e.id.slice(1) - 1]; if (x) x.state = e.state === 'start' ? 'on' : 'off'; if (e.file) run.files.push(e.file); log(`event ${e.kind} ${e.state}`); }
        else if (ev === 'files') e.files.forEach(f => { if (!run.files.includes(f)) run.files.push(f); });
        else if (ev === 'log') log(e.text);
        else if (ev === 'run') log(`run ${e.state}`);
        else if (ev === 'exit') { run.exited = true; run.finish(e.status === 'done'); return false; }
        run.paint();
      });
    } catch (err) {
      log(`erro: ${err.message}`);
      run.exited = true;
      run.finish(false);
      R.notify({ source: 'Experimento', text: err.message, tone: 'down' });
    }
  };
  api.stopRun = run => { if (run.rid) req('POST', `/api/runs/${run.rid}/stop`).catch(() => {}); run.log.push('SIGINT enviado ao runner; ele limpa e guarda o que mediu.'); };

  // ---------------------------------------------------------------- online, offline
  const net = document.querySelector('[data-net-status]');
  function markOffline() {
    if (!net || net.querySelector('[data-offline]')) return;
    net.insertAdjacentHTML('beforeend', '<span class="status warn" data-offline><span class="dot warn"></span>testbed offline</span>');
  }
  async function connect() {
    let state;
    try { state = await req('GET', '/api/testbed'); } catch {
      if (net) { markOffline(); new MutationObserver(markOffline).observe(net, { childList: true }); }
      return;
    }
    api.online = true;
    Object.assign(M, { chat: [], events: [], intents: [], routes: {}, stalls: {} });
    if (R.monitor) { R.monitor.series.length = 0; R.monitor.marks.length = 0; }
    R.traffic.sessions = sessions;
    loadState(state);
    R.emit('chat', {}); R.emit('intent', {}); R.emit('traffic', {});
    try {
      api.experiments = await req('GET', '/api/experiments');
      (R.xRunners || []).forEach(r => { const e = api.experiments.find(x => x.name === r.id); if (e) Object.assign(r, { windows: e.windows ?? r.windows, win: e.window_s ?? r.win, modes: e.modes.length ? e.modes : r.modes }); });
    } catch { /* keep the catalog */ }
    await Promise.all([refreshIntents(), refreshIfaces(), refreshModels(), refreshSupervisor(), refreshStats(), adoptSessions(), pastDrifts(), refreshLogs()]);
    watchAssurance();
    api.poll = async () => {
      if (api.busy) return; // a job is changing the testbed: its result brings the new state
      try { const s = await req('GET', '/api/testbed?sync=1'); if (!api.busy && JSON.stringify([s.nodes, s.links]) !== api.sig) loadState(s); } catch { /* next time */ }
    };
    setInterval(() => { if (!document.hidden && (R.page === 'topologia' || R.page === 'monitor')) refreshStats(); }, 1000);
    setInterval(() => { if (!document.hidden) refreshTraffic(); }, 2000);
    setInterval(() => { if (!document.hidden) { api.poll(); refreshSupervisor(); } }, 5000);
    setInterval(() => { if (!document.hidden) { refreshIntents(); refreshIfaces(); refreshModels(); } }, 15000);
    setInterval(() => { if (!document.hidden && R.page === 'modulos') refreshLogs(); }, 5000);
  }
  if (!new URLSearchParams(location.search).has('demo')) connect();
})();

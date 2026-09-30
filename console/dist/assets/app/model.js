/* REIN Console model: the network graph, routing, video QoE, intents, conversation, event log,
   and LFT topology import/export (a CONFIG .py in the shape of onos_topologies constants.py).
   Every value is illustrative until the real services are wired in. */
(() => {
  'use strict';
  const R = window.REIN = window.REIN || {};

  // ------------------------------------------------------------ utilities
  const pad2 = n => String(n).padStart(2, '0');
  R.hhmm = (d = new Date()) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  R.hms = (d = new Date()) => `${R.hhmm(d)}:${pad2(d.getSeconds())}`;
  R.fmt = (n, d = 1) => Number(n).toLocaleString('pt-BR', { maximumFractionDigits: d });
  R.fmt1 = n => Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  R.esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  R.reduced = matchMedia('(prefers-reduced-motion: reduce)');
  R.wait = ms => new Promise(r => setTimeout(r, R.reduced.matches ? 0 : ms));

  const subs = [];
  R.on = fn => subs.push(fn);
  R.emit = (type, detail = {}) => subs.forEach(fn => fn(type, detail));

  // Units used by LFT configs: "35mbit", "1gbit", "500kbit", "10ms", "1%"
  R.parseRate = v => {
    if (v === null || v === undefined || v === 0 || v === '0') return null;
    if (typeof v === 'number') return v;
    const m = String(v).trim().toLowerCase().match(/^([\d.]+)\s*(g|m|k)?(bit|bps|b)?/);
    if (!m) return null;
    return parseFloat(m[1]) * ({ g: 1000, m: 1, k: 0.001 }[m[2] || 'm']);
  };
  R.rateStr = mbps => mbps >= 1000 && mbps % 1000 === 0 ? `${mbps / 1000}gbit` : mbps < 1 ? `${Math.round(mbps * 1000)}kbit` : `${+mbps.toFixed(2)}mbit`;
  R.parseTime = v => {
    if (v === null || v === undefined || v === 0 || v === '0') return null;
    if (typeof v === 'number') return v;
    const m = String(v).trim().toLowerCase().match(/^([\d.]+)\s*(ms|us|s)?/);
    if (!m) return null;
    return parseFloat(m[1]) * ({ ms: 1, us: 0.001, s: 1000 }[m[2] || 'ms']);
  };
  R.parseLoss = v => {
    if (v === null || v === undefined || v === 0 || v === '0') return null;
    const m = String(v).match(/([\d.]+)/);
    return m ? parseFloat(m[1]) : null;
  };

  // ------------------------------------------------------------ network model
  const IMAGES = [
    ['rein-dash-video', 'Servidor DASH, conteúdo gerado com ffmpeg'],
    ['rein-dash-client', 'Cliente DASH, player dash.js'],
    ['pydash', 'Cliente DASH, algoritmo ABR em Python'],
    ['networkstatic/iperf3', 'Servidor ou cliente iperf3'],
    ['nginx:alpine', 'Servidor HTTP'],
    ['ubuntu:22.04', 'Imagem base'],
  ];
  R.IMAGES = IMAGES;
  const DASH_CLIENTS = new Set(['rein-dash-client', 'pydash']);
  const DASH_SERVERS = new Set(['rein-dash-video']);

  const M = R.model = {
    name: 'diamond',
    nodes: [],
    links: [],
    defaults: { rate: 35, delay: 10, jitter: 1, loss: 0 },
    routes: {},
    intents: [],
    chat: [],
    events: [],
    revision: 2,
    stalls: {},
  };

  const node = id => M.nodes.find(n => n.id === id);
  const link = id => M.links.find(l => l.id === id);
  const linkId = (a, b) => { const [x, y] = [a, b].sort((p, q) => +p.slice(1) - +q.slice(1)); return `${x}-${y}`; };
  const between = (a, b) => M.links.find(l => (l.a === a && l.b === b) || (l.a === b && l.b === a));
  R.node = node; R.link = link; R.between = between;
  R.switches = () => M.nodes.filter(n => n.kind === 'switch');
  R.hosts = () => M.nodes.filter(n => n.kind === 'host');

  R.linkState = (l, v = l.now) => v.down ? 'down' : (v.rate < l.base.rate - 1e-9 || v.delay > l.base.delay * 2 || v.loss > 0) ? 'warn' : 'ok';
  R.stateWord = { ok: 'Normal', warn: 'Degradado', down: 'Fora' };
  R.metric = l => l.now.down ? 'fora' : `${R.fmt(l.now.rate)} Mb/s, ${R.fmt(l.now.delay, 1)} ms`;

  // Presets from the diamond, rnp (HARD_DEGRADE) and demo experiments
  R.presets = {
    normal: ['Normal', b => ({ ...b, down: false })],
    degraded: ['Degradado', b => ({ ...b, rate: +(b.rate * 0.1).toFixed(2), delay: b.delay * 10, down: false })],
    bottleneck: ['Gargalo 1080p', b => ({ ...b, rate: 5, delay: 30, down: false })],
    video720: ['Degradado 720p', b => ({ ...b, rate: 3, delay: 130, down: false })],
    stall: ['Travamento', b => ({ ...b, rate: 0.2, down: false })],
    down: ['Fora', b => ({ ...b, down: true })],
  };

  function seedDiamond() {
    M.name = 'diamond';
    M.defaults = { rate: 35, delay: 10, jitter: 1, loss: 0 };
    M.nodes = [
      { id: 's0', kind: 'switch', pop: 'PoP-ES', uf: 'ES', dpid: 'of:0000000000000001', x: 200, y: 30 },
      { id: 's1', kind: 'switch', pop: 'PoP-MG', uf: 'MG', dpid: 'of:0000000000000002', x: 410, y: -125 },
      { id: 's2', kind: 'switch', pop: 'PoP-RJ', uf: 'RJ', dpid: 'of:0000000000000003', x: 455, y: 150 },
      { id: 's3', kind: 'switch', pop: 'PoP-SP', uf: 'SP', dpid: 'of:0000000000000004', x: 670, y: 20 },
      { id: 'ds0', kind: 'host', role: 'Servidor', ip: '192.168.0.1', sw: 's0', image: 'rein-dash-video', x: 30, y: 70 },
      { id: 'cl0', kind: 'host', role: 'Cliente', ip: '192.168.0.2', sw: 's3', image: 'rein-dash-client', x: 840, y: -15 },
    ];
    const mk = (a, b, rate, delay = 10) => ({ id: linkId(a, b), a, b, base: { rate, delay, jitter: 1, loss: 0 }, now: { rate, delay, jitter: 1, loss: 0, down: false } });
    // QoS tiers from the diamond experiment: MG-ES 35 Mbit (4K), RJ-ES 5 Mbit (1080p)
    M.links = [mk('s0', 's1', 35), mk('s0', 's2', 5), mk('s1', 's3', 35), mk('s2', 's3', 35)];
    Object.assign(link('s0-s1').now, { rate: 3, delay: 130 });
    M.routes = { q1: { client: 'cl0', server: 'ds0', path: ['ds0', 's0', 's2', 's3', 'cl0'] } };
    M.revision = 2;
    M.stalls = { cl0: 1 };
  }

  // ------------------------------------------------------------ routing: widest path, ties by delay
  function widest(fromSw, toSw) {
    const sw = R.switches().map(n => n.id);
    const best = Object.fromEntries(sw.map(id => [id, { bw: -1, d: Infinity, prev: null }]));
    if (!best[fromSw] || !best[toSw] || node(fromSw).off || node(toSw).off) return null;
    best[fromSw] = { bw: Infinity, d: 0, prev: null };
    const seen = new Set();
    while (seen.size < sw.length) {
      let u = null;
      for (const id of sw) if (!seen.has(id) && best[id].bw >= 0 && (u === null || best[id].bw > best[u].bw || (best[id].bw === best[u].bw && best[id].d < best[u].d))) u = id;
      if (u === null) break;
      seen.add(u);
      for (const l of M.links) {
        if (l.now.down || (l.a !== u && l.b !== u)) continue;
        const v = l.a === u ? l.b : l.a;
        if (seen.has(v)) continue;
        const bw = Math.min(best[u].bw, l.now.rate), d = best[u].d + l.now.delay;
        if (bw > best[v].bw || (bw === best[v].bw && d < best[v].d)) best[v] = { bw, d, prev: u };
      }
    }
    if (best[toSw].bw < 0) return null;
    const path = [];
    for (let v = toSw; v; v = best[v].prev) path.unshift(v);
    return { path, bw: best[toSw].bw, d: best[toSw].d };
  }
  function routeFor(client) {
    const c = node(client);
    if (!c) return null;
    let pick = null;
    for (const s of R.hosts().filter(h => h.role === 'Servidor')) {
      const w = widest(s.sw, c.sw);
      if (w && (!pick || w.bw > pick.bw || (w.bw === pick.bw && w.d < pick.d))) pick = { ...w, server: s.id };
    }
    return pick ? { server: pick.server, path: [pick.server, ...pick.path, client] } : null;
  }
  R.pathLinks = path => {
    const out = [];
    for (let i = 0; i < (path?.length || 0) - 1; i++) { const l = between(path[i], path[i + 1]); if (l) out.push(l); }
    return out;
  };
  R.pathBroken = path => !path || R.pathLinks(path).some(l => l.now.down);
  R.pathRate = path => { const ls = R.pathLinks(path); return !path ? 0 : ls.some(l => l.now.down) ? 0 : ls.length ? Math.min(...ls.map(l => l.now.rate)) : Infinity; };
  R.pathDelay = path => R.pathLinks(path).reduce((s, l) => s + l.now.delay, 0);

  // The supervisor notices drift, the deployer installs the new path: routes lag behind best paths
  let reconcileTimers = [];
  function reconcile() {
    if (R.api?.online) return; // the real supervisor and deployer reroute; api.js follows their events
    reconcileTimers.forEach(clearTimeout);
    reconcileTimers = [];
    Object.entries(M.routes).forEach(([id, r]) => {
      const best = routeFor(r.client);
      const same = best && r.path && best.path.join() === r.path.join();
      if (same) return;
      const curRate = R.pathRate(r.path), bestRate = best ? R.pathRate(best.path) : 0;
      if (best && !R.pathBroken(r.path) && bestRate <= curRate + 1e-9 && R.pathDelay(best.path) >= R.pathDelay(r.path)) return;
      reconcileTimers.push(setTimeout(() => {
        R.log('Supervisor', best ? `Desvio em ${id}: ${R.pathBroken(r.path) ? 'caminho interrompido' : 'caminho abaixo do melhor disponível'}.` : `${id} ficou sem caminho disponível.`, best ? 'warn' : 'down', id);
        R.emit('observer', { drift: true, intent: id });
      }, 900));
      reconcileTimers.push(setTimeout(() => {
        r.path = best ? best.path : null;
        if (best) r.server = best.server;
        M.revision++;
        if (best) R.log('Deployer', `Rota de ${id} recalculada: ${best.path.slice(1, -1).join(', ')}.`, '', id);
        R.emit('change', { reroute: id });
      }, 1800));
    });
  }

  R.apply = (id, values, { quiet = false } = {}) => {
    const l = link(id);
    l.now = { ...l.now, ...values };
    const st = R.linkState(l);
    if (!quiet) R.log('Testbed', values.down ? `${l.a}–${l.b} derrubado.` : `${l.a}–${l.b} em ${R.fmt(l.now.rate)} Mb/s e ${R.fmt(l.now.delay)} ms${l.now.loss ? `, perda ${R.fmt(l.now.loss)}%` : ''}.`, st === 'ok' ? '' : st);
    save();
    R.emit('change', { link: id });
    reconcile();
  };

  // Rendition ladder of the rein-dash-video server, Mb/s
  R.ladder = [['2160p', 16], ['1440p', 9], ['1080p', 4.5], ['720p', 2.5], ['480p', 1.2], ['360p', 0.7], ['240p', 0.3]];
  R.routeOf = clientId => Object.entries(M.routes).find(([, r]) => r.client === clientId);
  R.qoe = clientId => {
    const entry = R.routeOf(clientId);
    const path = entry?.[1].path;
    const rate = entry ? R.pathRate(path) : 0;
    const r = Math.min(rate, 1000);
    const rung = R.ladder.find(([, br]) => br <= r * 0.9);
    const stalled = !rung;
    const key = clientId;
    M.stalls[key] ??= 0;
    if (stalled && !M.stalls[`_${key}`]) M.stalls[key]++;
    M.stalls[`_${key}`] = stalled;
    const degraded = !stalled && R.pathLinks(path).some(l => R.linkState(l) !== 'ok');
    return {
      path, rate: r, stalled, degraded, intent: entry?.[0],
      res: stalled ? null : rung[0], bitrate: stalled ? 0 : rung[1],
      thr: r * 0.96, buffer: stalled ? 0 : 7.6, stalls: M.stalls[key], tone: stalled ? 'down' : degraded ? 'warn' : 'ok',
    };
  };
  // Traffic crossing each link now, Mb/s: every intent flow fills its path's bottleneck, as the
  // DASH client and iperf do in the testbed. Links outside any path carry only control traffic.
  R.linkLoad = () => {
    const load = new Map(M.links.map(l => [l.id, 0]));
    const seen = new Set();
    Object.values(M.routes).forEach(r => {
      if (!r.path || R.pathBroken(r.path) || seen.has(r.client)) return;
      seen.add(r.client);
      const pol = R.policyFor(R.node(r.client)?.ip, 'tcp');
      const flow = pol.blocked ? 0 : Math.min(R.pathRate(r.path), 1000, pol.cap || Infinity) * 0.96;
      R.pathLinks(r.path).forEach(l => load.set(l.id, load.get(l.id) + flow));
    });
    R.traffic?.loadOn().forEach((v, id) => load.set(id, (load.get(id) || 0) + v));
    const t = Date.now() / 1000;
    M.links.forEach((l, i) => {
      const cap = l.now.down ? 0 : l.now.rate;
      const wob = 1 + Math.sin(t / 2.3 + i * 1.7) * 0.012 + Math.sin(t / 0.9 + i) * 0.006;
      load.set(l.id, cap ? Math.min(cap * 0.985, load.get(l.id) * wob || 0.04 + (i % 3) * 0.02) : 0);
    });
    return load;
  };
  R.hostPath = (a, b) => {
    const x = node(a), y = node(b);
    if (!x || !y) return null;
    if (x.sw === y.sw) return node(x.sw)?.off ? null : [a, x.sw, b];
    const w = widest(x.sw, y.sw);
    return w ? [a, ...w.path, b] : null;
  };
  // Nile as the deployer reads it (deployer/classes/target.py): what kind of operation, on whom
  R.nileInfo = nile => {
    const t = String(nile || '');
    const ip = (t.match(/endpoint\('([^']+)'\)/) || [])[1] || null;
    let m;
    if ((m = t.match(/add\s+service\('([^']+)'\)/))) return { kind: m[1] === 'llm' ? 'llm' : m[1] === 'cdn-qoe' ? 'cdn-qoe' : 'service', value: m[1], ip };
    if ((m = t.match(/(set|unset)\s+bandwidth\('(min|max)',\s*'([\d.]+)',\s*'(\w+)'\)/))) return { kind: 'bandwidth', op: m[1], dir: m[2], value: +m[3], unit: m[4], ip };
    if ((m = t.match(/(allow|block)\s+(protocol|service|traffic)\('([^']+)'\)/))) return { kind: 'acl', op: m[1], fn: m[2], value: m[3], ip };
    if ((m = t.match(/(add|remove)\s+middlebox\('([^']+)'\)/))) return { kind: 'middlebox', op: m[1], value: m[2], ip };
    if (/set\s+quota/.test(t)) return { kind: 'quota', ip };
    return { kind: 'other', ip };
  };
  R.policyFor = (ip, proto = 'tcp') => {
    const out = { blocked: false, cap: 0 };
    if (!ip) return out;
    M.intents.filter(i => i.state === 'deployed').forEach(i => {
      const n = R.nileInfo(i.nile);
      if (n.ip !== ip) return;
      if (n.kind === 'bandwidth' && n.op === 'set' && n.dir === 'max') out.cap = out.cap ? Math.min(out.cap, n.value) : n.value;
      if (n.kind === 'acl' && n.op === 'block' && n.fn === 'protocol' && n.value.toLowerCase() === proto) out.blocked = true;
    });
    return out;
  };
  R.hasVideo = h => h && h.kind === 'host' && h.role === 'Cliente' && DASH_CLIENTS.has(h.image) && R.hosts().some(s => s.role === 'Servidor' && DASH_SERVERS.has(s.image));

  // ------------------------------------------------------------ hosts
  R.nextName = role => {
    const p = role === 'Servidor' ? 'ds' : 'cl';
    let n = 0;
    while (node(`${p}${n}`)) n++;
    return `${p}${n}`;
  };
  R.nextIp = () => {
    const used = new Set(R.hosts().map(h => h.ip));
    for (let i = 1; i < 254; i++) if (!used.has(`192.168.0.${i}`)) return `192.168.0.${i}`;
    return '192.168.0.254';
  };
  R.addHost = h => {
    const sw = node(h.sw);
    const siblings = R.hosts().filter(x => x.sw === h.sw).length;
    const ang = (siblings * 0.9) + Math.PI / 2;
    const n = { kind: 'host', ...h, x: sw.x + Math.cos(ang) * 150, y: sw.y + Math.sin(ang) * 150, isNew: true };
    M.nodes.push(n);
    R.log('Testbed', `Host ${n.id} criado em ${n.sw} com a imagem ${n.image}.`);
    save();
    R.emit('topology', { added: n.id });
    return n;
  };
  R.updateHost = (id, patch) => {
    const n = node(id);
    const oldId = n.id;
    Object.assign(n, patch);
    if (patch.id && patch.id !== oldId) {
      Object.values(M.routes).forEach(r => { if (r.client === oldId) r.client = patch.id; if (r.server === oldId) r.server = patch.id; if (r.path) r.path = r.path.map(p => p === oldId ? patch.id : p); });
    }
    if (patch.sw) Object.values(M.routes).forEach(r => { if (r.client === n.id || r.server === n.id) r.path = routeFor(r.client)?.path || null; });
    R.log('Testbed', `Host ${n.id} atualizado: ${n.image}, ${n.ip}, em ${n.sw}.`);
    save();
    R.emit('topology', {});
  };
  R.nextSwitch = () => { let n = 0; while (node(`s${n}`)) n++; return `s${n}`; };
  R.addSwitch = ({ id, uf, links = [] }) => {
    const idx = +id.slice(1);
    const near = links.map(l => node(l.to)).filter(Boolean);
    const cx = near.length ? near.reduce((t, n) => t + n.x, 0) / near.length : 0, cy = near.length ? near.reduce((t, n) => t + n.y, 0) / near.length : 0;
    const n = { id, kind: 'switch', pop: `PoP-${uf}`, uf, dpid: `of:${(idx + 1).toString(16).padStart(16, '0')}`, x: cx + 120, y: cy - 150, isNew: true };
    M.nodes.push(n);
    links.forEach(l => {
      const rate = +l.rate || M.defaults.rate, delay = +l.delay || M.defaults.delay, loss = +l.loss || 0;
      M.links.push({ id: linkId(id, l.to), a: id, b: l.to, base: { rate, delay, jitter: M.defaults.jitter, loss }, now: { rate, delay, jitter: M.defaults.jitter, loss, down: false } });
    });
    R.log('Testbed', `Switch ${id} criado (${uf}) com ${links.length} link${links.length === 1 ? '' : 's'}.`);
    save();
    R.emit('topology', { added: id });
    return n;
  };
  // A switch that is off takes its links down with it (its container and veth pairs are gone);
  // turned back on, it brings back only the links it took, and only where the far end is on
  R.setSwitchPower = (id, on) => {
    const n = node(id);
    if (!n || n.kind !== 'switch' || !n.off === on) return;
    n.off = !on;
    let k = 0;
    M.links.filter(l => l.a === id || l.b === id).forEach(l => {
      if (!on) { if (!l.now.down) { l.offBySw = true; l.now.down = true; k++; } }
      else if (l.offBySw && !node(l.a === id ? l.b : l.a)?.off) { delete l.offBySw; l.now.down = false; k++; }
    });
    R.log('Testbed', on ? `Switch ${id} ligado; ${k} link${k === 1 ? '' : 's'} refeito${k === 1 ? '' : 's'}.` : `Switch ${id} desligado; ${k} link${k === 1 ? '' : 's'} fora.`, on ? '' : 'down');
    save();
    R.emit('change', { switch: id });
    R.emit('topology', {});
    reconcile();
  };
  // Removing a switch removes its links and the hosts hanging from it
  R.removeSwitch = id => {
    const hs = R.hosts().filter(h => h.sw === id).map(h => h.id);
    M.nodes = M.nodes.filter(n => n.id !== id && !hs.includes(n.id));
    M.links = M.links.filter(l => l.a !== id && l.b !== id);
    Object.entries(M.routes).forEach(([k, r]) => { if (hs.includes(r.client)) delete M.routes[k]; });
    R.log('Testbed', `Switch ${id} removido${hs.length ? `, com ${hs.join(', ')}` : ''}.`);
    save();
    R.emit('topology', {});
    reconcile();
  };
  R.removeHost = id => {
    M.nodes = M.nodes.filter(n => n.id !== id);
    Object.entries(M.routes).forEach(([k, r]) => { if (r.client === id) delete M.routes[k]; else if (r.server === id) { const b = routeFor(r.client); r.path = b?.path || null; r.server = b?.server; } });
    R.log('Testbed', `Host ${id} removido.`);
    save();
    R.emit('topology', {});
  };

  // ------------------------------------------------------------ events and conversation
  R.log = (source, text, tone = '', intent = null) => {
    const e = { time: R.hhmm(), stamp: Date.now(), source, text, tone, intent };
    M.events.push(e);
    if (source !== 'Testbed') M.chat.push({ role: 'event', ...e });
    R.emit('log', e);
    return e;
  };

  function seedConversation() {
    M.intents = [{ id: 'q1', ask: 'Quero vídeo sem travar para o cliente 192.168.0.2', nile: "define intent q1: from endpoint('192.168.0.2') add service('cdn-qoe')", state: 'deployed', when: '14:28', client: 'cl0', kind: 'cdn-qoe', flows: 6 }];
    M.chat = [
      { role: 'user', text: 'Quero vídeo sem travar para o cliente 192.168.0.2', time: '14:26', source: 'Topologia', intent: 'q1' },
      { role: 'rein', kind: 'proposal', intent: 'q1', time: '14:26', steps: [['Contexto', 0.2], ['Exemplos', 0.1], ['Tradução com qwen3.6', 1.4]] },
      { role: 'event', source: 'Deployer', text: 'q1 implantada. 6 fluxos, servidor ds0.', tone: 'ok', time: '14:28', intent: 'q1' },
      { role: 'event', source: 'Supervisor', text: 'Latência em s0–s1 chegou a 132 ms, acima do limite de q1.', tone: 'warn', time: '14:31', intent: 'q1' },
      { role: 'event', source: 'Deployer', text: 'Rota de q1 recalculada: s0, s2, s3.', tone: '', time: '14:32', intent: 'q1' },
    ];
    M.events = M.chat.filter(m => m.role === 'event').map(m => ({ ...m, stamp: Date.now() - 60000 }));
  }

  // Grounding: find the client a sentence talks about
  function groundClient(text) {
    const clients = R.hosts().filter(h => h.role === 'Cliente');
    const ip = (text.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/) || [])[0];
    if (ip) return clients.find(c => c.ip === ip) || { id: null, ip };
    const byName = clients.find(c => new RegExp(`\\b${c.id}\\b`, 'i').test(text));
    if (byName) return byName;
    const uf = (text.toUpperCase().match(/\b(?:DE|EM|NO|NA|DO|DA)\s+([A-Z]{2})\b/) || [])[1];
    if (uf) { const hit = clients.find(c => node(c.sw)?.uf === uf); if (hit) return hit; }
    if (/cliente/i.test(text) && clients.length === 1) return clients[0];
    return null;
  }
  R.clientsList = () => R.hosts().filter(h => h.role === 'Cliente');

  let flowSeq = 0;
  R.profile = async (text, source = 'Topologia') => {
    const run = ++flowSeq;
    const time = R.hhmm();
    M.chat.push({ role: 'user', text, time, source });
    const msg = { role: 'rein', kind: 'thinking', time, steps: [['Contexto', 0.2, false], ['Exemplos', 0.1, false], [`Tradução com ${R.state.model}`, 1.4, false]] };
    M.chat.push(msg);
    R.emit('chat', { text, source });
    R.toast('O stream do profiler entra aqui:', 'POST /api/profiler/profile');
    for (let i = 0; i < msg.steps.length; i++) {
      await R.wait(420 + i * 220);
      if (run !== flowSeq && msg.kind !== 'thinking') return;
      msg.steps[i][2] = true;
      R.emit('chat', { progress: true });
    }
    await R.wait(200);
    const client = groundClient(text);
    if (!client) {
      msg.kind = 'ask';
      msg.text = 'Para qual cliente?';
      // A video request only offers clients that can play video
      const video = /v[ií]deo|trav|qoe|stream|dash/i.test(text) ? R.clientsList().filter(R.hasVideo) : [];
      msg.options = (video.length ? video : R.clientsList()).map(c => ({ label: `${c.id}, ${c.ip}`, value: c.ip }));
      msg.ask = text;
      R.emit('chat', { ask: true });
      return;
    }
    const id = `q${M.intents.length + 1}`;
    const target = client.ip;
    let nile, kind;
    if (/ssh|bloque|block/i.test(text)) { const pr = (text.match(/\b(tcp|udp|icmp)\b/i) || [, /ssh/i.test(text) ? 'ssh' : 'tcp'])[1].toLowerCase(); nile = `define intent ${id}: for endpoint('${target}') block protocol('${pr}')`; kind = 'block'; }
    else if (/limit|banda|mbps|mb\/s/i.test(text)) { const n = (text.match(/(\d+)\s*(?:mbps|mb\/s|mbit)/i) || [, '10'])[1]; nile = `define intent ${id}: for endpoint('${target}') set bandwidth('max', '${n}', 'mbps')`; kind = 'bandwidth'; }
    else { nile = `define intent ${id}: from endpoint('${target}') add service('cdn-qoe')`; kind = 'cdn-qoe'; }
    const intent = { id, ask: text, nile, state: 'pending', when: null, client: client.id, kind };
    M.intents.push(intent);
    msg.kind = 'proposal';
    msg.intent = id;
    R.emit('chat', { proposal: id });
    R.emit('intent', { id });
  };
  R.proposeIntent = ({ nile, client, ask, source = 'Serviços' }) => {
    const id = `q${M.intents.length + 1}`;
    nile = nile.replace(/define intent \w+:/, `define intent ${id}:`);
    const time = R.hhmm();
    M.chat.push({ role: 'user', text: ask, time, source });
    const it = { id, ask, nile, state: 'pending', when: null, client, kind: R.nileInfo(nile).kind };
    M.intents.push(it);
    M.chat.push({ role: 'rein', kind: 'proposal', intent: id, time, steps: [['Formulário', 0], ['Validação local', 0.1]], streamed: true });
    R.emit('chat', { proposal: id }); R.emit('intent', { id });
    return it;
  };
  R.answer = (msgIndex, value, source = 'Intents') => {
    const m = M.chat[msgIndex];
    if (m) m.answered = value;
    return R.profile(`${m?.ask || ''} para o cliente ${value}`.trim(), source);
  };

  R.intentAct = async (id, act, nileText) => {
    const it = M.intents.find(i => i.id === id);
    if (!it) return;
    if (act === 'cancel') { it.state = 'cancelled'; R.emit('intent', { id }); R.toast('Intent cancelada. Nada foi enviado ao deployer.'); return; }
    if (act === 'edit') { if (nileText) it.nile = nileText; R.emit('intent', { id }); return; }
    if (act === 'regenerate') {
      it.state = 'cancelled';
      M.chat.push({ role: 'rein', kind: 'text', time: R.hhmm(), text: `O deployer recusou ${id}: ${it.error} Reformule com uma operação executável, por exemplo block protocol('tcp'), set bandwidth('max', '10', 'mbps') ou add service('cdn-qoe').` });
      R.toast('Regenerar com o erro no contexto:', `POST /api/profiler/profile/${id}/resume`);
      R.emit('intent', { id }); R.emit('chat', {});
      return;
    }
    if (act === 'revoke') {
      it.state = 'revoked'; it.revokedAt = R.hhmm();
      delete M.routes[id];
      R.log('Deployer', `${id} revogada: fluxos e regras removidos.`, '', id);
      save(); R.emit('change', { policy: id }); R.emit('intent', { id });
      return;
    }
    if (act === 'approve') {
      it.state = 'checking';
      R.emit('intent', { id });
      R.toast('Aprovação enviada. Na versão real:', `POST /api/profiler/profile/${id}/resume`);
      await R.wait(1000);
      const n = R.nileInfo(it.nile), sws = R.switches().length;
      const reject = (code, msg) => { it.state = 'rejected'; it.code = code; it.error = msg; R.log('Deployer', `Recusou ${id} (${code}): ${msg}`, 'down', id); };
      if (n.kind === 'cdn-qoe' || n.kind === 'llm') {
        const route = routeFor(it.client);
        if (!route) reject(500, 'nenhum servidor alcançável a partir do cliente.');
        else {
          it.state = 'deployed'; it.when = R.hhmm(); it.flows = route.path.length + 2; it.effect = `servidor ${route.server}, caminho ${route.path.slice(1, -1).join(', ')}`;
          M.routes[id] = { client: it.client, server: route.server, path: route.path };
          R.log('Deployer', `${id} implantada${n.kind === 'llm' ? ' pelo modo LLM' : ''}. ${it.flows} fluxos, servidor ${route.server}.`, 'ok', id);
          save();
          R.emit('change', { reroute: id });
        }
      } else if (n.kind === 'bandwidth') {
        if (n.dir !== 'max' || n.op !== 'set') reject(422, `bandwidth('${n.dir}') ainda não é implementado; só o limite máximo.`);
        else { it.state = 'deployed'; it.when = R.hhmm(); it.flows = sws * 2; it.effect = `meter DROP ${R.fmt(n.value)} Mb/s em ${sws} switches`; R.log('Deployer', `${id} implantada: ${sws} meters de ${R.fmt(n.value)} Mb/s.`, 'ok', id); save(); R.emit('change', { policy: id }); }
      } else if (n.kind === 'acl') {
        const ok = n.fn === 'protocol' ? ['tcp', 'udp', 'icmp'].includes(n.value.toLowerCase()) : n.fn === 'service' ? n.value === 'netflix' : false;
        if (!ok) reject(422, n.fn === 'protocol' ? `protocol('${n.value}') não corresponde a um ipProto do ACL do ONOS (TCP, UDP, ICMP).` : `${n.fn}('${n.value}') não está no mapa de serviços do deployer.`);
        else { it.state = 'deployed'; it.when = R.hhmm(); it.flows = 1; it.effect = `regra ${n.op === 'block' ? 'deny' : 'allow'} ${n.value.toUpperCase()} no app ACL`; R.log('Deployer', `${id} implantada: POST /acl/rules, ${n.op === 'block' ? 'deny' : 'allow'} ${n.value.toUpperCase()} para ${n.ip}.`, 'ok', id); save(); R.emit('change', { policy: id }); }
      } else if (n.kind === 'middlebox') {
        if (R.hosts().some(h => h.ip === '192.168.1.4')) { it.state = 'deployed'; it.when = R.hhmm(); it.flows = 4; it.effect = `desvio por ${n.value} em 192.168.1.4`; R.log('Deployer', `${id} implantada via middlebox ${n.value}.`, 'ok', id); save(); }
        else reject(500, `middlebox('${n.value}') aponta para 192.168.1.4, que não existe nesta topologia.`);
      } else reject(422, 'operação sem tradução para o ONOS no deployer atual.');
      R.emit('intent', { id });
    }
  };

  // ------------------------------------------------------------ layout helpers
  R.forceLayout = (nodes, links) => {
    const n = nodes.length;
    nodes.forEach((v, i) => { v.x = Math.cos((i / n) * Math.PI * 2) * 300; v.y = Math.sin((i / n) * Math.PI * 2) * 300; });
    const k = 170;
    for (let it = 0; it < 400; it++) {
      const t = 30 * (1 - it / 400) + 1;
      const disp = nodes.map(() => [0, 0]);
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
        let dx = nodes[i].x - nodes[j].x, dy = nodes[i].y - nodes[j].y; const d = Math.hypot(dx, dy) || .01;
        const f = (k * k) / d; dx /= d; dy /= d;
        disp[i][0] += dx * f; disp[i][1] += dy * f; disp[j][0] -= dx * f; disp[j][1] -= dy * f;
      }
      links.forEach(l => {
        const a = nodes.findIndex(v => v.id === l.a), b = nodes.findIndex(v => v.id === l.b);
        if (a < 0 || b < 0) return;
        let dx = nodes[a].x - nodes[b].x, dy = nodes[a].y - nodes[b].y; const d = Math.hypot(dx, dy) || .01;
        const f = (d * d) / k; dx /= d; dy /= d;
        disp[a][0] -= dx * f; disp[a][1] -= dy * f; disp[b][0] += dx * f; disp[b][1] += dy * f;
      });
      nodes.forEach((v, i) => { const d = Math.hypot(...disp[i]) || .01; v.x += disp[i][0] / d * Math.min(d, t); v.y += disp[i][1] / d * Math.min(d, t); });
    }
  };
  R.placeHosts = () => {
    const sws = R.switches();
    const cx = sws.reduce((s, v) => s + v.x, 0) / (sws.length || 1), cy = sws.reduce((s, v) => s + v.y, 0) / (sws.length || 1);
    sws.forEach(sw => {
      const hs = R.hosts().filter(h => h.sw === sw.id);
      const base = Math.atan2(sw.y - cy, sw.x - cx) || Math.PI / 2;
      hs.forEach((h, i) => { const a = base + (i - (hs.length - 1) / 2) * 0.55; h.x = sw.x + Math.cos(a) * 170; h.y = sw.y + Math.sin(a) * 170; });
    });
  };

  // ------------------------------------------------------------ export: LFT CONFIG .py
  R.exportPy = () => {
    const sws = R.switches();
    const hosts = R.hosts();
    const idx = Object.fromEntries(sws.map((s, i) => [s.id, i]));
    const d = M.defaults;
    const pops = sws.map(s => {
      const hs = hosts.filter(h => h.sw === s.id);
      return [s.pop || `PoP-${s.uf || s.id.toUpperCase()}`, hs.filter(h => h.role === 'Cliente').length, hs.filter(h => h.role === 'Servidor').length];
    });
    const n = sws.length;
    const mat = fill => Array.from({ length: n }, () => Array.from({ length: n }, () => fill));
    const adj = mat(0), thr = mat(0), rtt = mat(0), loss = mat(0);
    let hasThr = false, hasRtt = false, hasLoss = false;
    const down = [];
    M.links.forEach(l => {
      const i = idx[l.a], j = idx[l.b];
      if (i === undefined || j === undefined) return;
      adj[i][j] = adj[j][i] = 1;
      const v = l.now.down ? l.base : l.now;
      if (l.now.down) down.push(`${l.a}-${l.b}`);
      if (Math.abs(v.rate - d.rate) > 1e-9) { thr[i][j] = thr[j][i] = R.rateStr(v.rate); hasThr = true; }
      if (Math.abs(v.delay - d.delay) > 1e-9) { rtt[i][j] = rtt[j][i] = `${+(v.delay * 2).toFixed(2)}ms`; hasRtt = true; }
      if (v.loss > 0) { loss[i][j] = loss[j][i] = `${+v.loss.toFixed(2)}%`; hasLoss = true; }
    });
    const short = s => (s.pop || s.id).replace(/^PoP-/i, '');
    const header = sws.map(short).join(' ');
    const cell = v => typeof v === 'string' ? `"${v}"` : String(v);
    const width = Math.max(1, ...[thr, rtt, loss].flat(2).map(v => cell(v).length));
    const block = (name, m, comment) => {
      const rows = m.map((row, i) => `    ( ${row.map(v => cell(v).padEnd(name === 'ADJACENCY_MATRIX' ? 1 : width)).join(', ')} ),  # ${sws[i].pop || sws[i].id}`);
      return `${comment ? `# ${comment}\n` : ''}${name} = (\n    # ${header}\n${rows.join('\n')}\n)\n`;
    };
    const popsLines = [];
    for (let i = 0; i < pops.length; i += 4) popsLines.push('    ' + pops.slice(i, i + 4).map(p => `("${p[0]}", ${p[1]}, ${p[2]})`).join(', ') + ',');
    const now = new Date();
    let py = `# REIN topology export, ${now.toLocaleDateString('pt-BR')} ${R.hhmm(now)}\n`;
    py += `# Same shape as onos_topologies constants.py. Load it with:\n#   sudo lft topology create --path ${M.name || 'rein'}_topology.py\n\n`;
    py += `# Topology settings: ("PoP-Name", num_clients, num_servers)\nPOPS = (\n${popsLines.join('\n')}\n)\n\n`;
    py += block('ADJACENCY_MATRIX', adj) + '\n';
    if (hasThr) py += block('THROUGHPUT_MATRIX', thr, 'Per-link throughput; 0 falls back to CONFIG["throughput"]') + '\n';
    if (hasRtt) py += block('RTT_MATRIX', rtt, 'Per-link RTT; LFT applies half of it as one-way delay; 0 falls back to CONFIG["delay"]') + '\n';
    if (hasLoss) py += block('LOSS_MATRIX', loss, 'REIN extension: per-link packet loss, not read by LFT yet') + '\n';
    py += `CONFIG = {\n    "adjacency_matrix": ADJACENCY_MATRIX,\n`;
    if (hasThr) py += `    "throughput_matrix": THROUGHPUT_MATRIX,\n`;
    if (hasRtt) py += `    "rtt_matrix": RTT_MATRIX,\n`;
    if (hasLoss) py += `    "loss_matrix": LOSS_MATRIX,\n`;
    py += `    "pops": POPS,\n    "apply_link_properties": True,\n    "randomize_link_properties": False,\n`;
    py += `    "throughput": "${R.rateStr(d.rate)}",\n    "delay": "${+d.delay.toFixed(2)}ms",\n    "jitter": "${+d.jitter.toFixed(2)}ms"\n}\n\n`;
    py += `# REIN extensions, ignored by LFT: host images and addresses, links that were down, console layout\n`;
    py += `HOSTS = (\n${hosts.map(h => `    ("${h.id}", "${node(h.sw)?.pop || h.sw}", "${h.role === 'Servidor' ? 'server' : 'client'}", "${h.image}", "${h.ip}"),`).join('\n')}\n)\n`;
    if (down.length) py += `DOWN_LINKS = (${down.map(x => `"${x}"`).join(', ')},)\n`;
    py += `LAYOUT = {\n${M.nodes.map(v => `    "${v.id}": (${Math.round(v.x)}, ${Math.round(v.y)}),`).join('\n')}\n}\n`;
    return py;
  };

  // ------------------------------------------------------------ import: a small Python-literal parser
  function parsePython(src) {
    let i = 0;
    const env = {};
    const ws = (inBrackets) => {
      for (;;) {
        const c = src[i];
        if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
        if (c === ' ' || c === '\t' || c === '\r' || c === '\\' || (inBrackets && c === '\n')) { i++; continue; }
        break;
      }
    };
    const value = (inB) => {
      ws(inB);
      const c = src[i];
      if (c === '(' || c === '[') return seq(c === '(' ? ')' : ']');
      if (c === '{') return dict();
      if (/[rbuf]?['"]/i.test(src.slice(i, i + 2)) && (c === "'" || c === '"' || src[i + 1] === "'" || src[i + 1] === '"')) return str();
      const num = src.slice(i).match(/^-?\d+(?:\.\d+)?(?:e-?\d+)?/i);
      if (num) { i += num[0].length; return parseFloat(num[0]); }
      const name = src.slice(i).match(/^[A-Za-z_][A-Za-z0-9_.]*/);
      if (name) {
        i += name[0].length;
        ws(inB);
        if (src[i] === '(') { seq(')'); return null; }
        if (name[0] === 'True') return true;
        if (name[0] === 'False') return false;
        if (name[0] === 'None') return null;
        return { ref: name[0] };
      }
      throw new Error(`Valor inesperado perto de "${src.slice(i, i + 20)}"`);
    };
    const str = () => {
      while (/[rbuf]/i.test(src[i])) i++;
      const q = src[i];
      const triple = src.slice(i, i + 3) === q.repeat(3);
      const end = triple ? q.repeat(3) : q;
      i += end.length;
      let out = '';
      while (i < src.length && src.slice(i, i + end.length) !== end) { if (src[i] === '\\') { out += src[i + 1]; i += 2; } else out += src[i++]; }
      i += end.length;
      return out;
    };
    const seq = close => {
      i++;
      const items = [];
      let comma = false;
      for (;;) {
        ws(true);
        if (src[i] === close) { i++; break; }
        items.push(value(true));
        ws(true);
        if (src[i] === ',') { i++; comma = true; }
      }
      return close === ')' && items.length === 1 && !comma ? items[0] : items;
    };
    const dict = () => {
      i++;
      const out = {};
      for (;;) {
        ws(true);
        if (src[i] === '}') { i++; break; }
        const k = value(true); ws(true);
        if (src[i] !== ':') throw new Error('Dicionário malformado');
        i++;
        out[typeof k === 'object' ? k.ref : k] = value(true); ws(true);
        if (src[i] === ',') i++;
      }
      return out;
    };
    const lines = /^([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)/gm;
    let m;
    while ((m = lines.exec(src))) {
      i = m.index + m[0].length;
      try { env[m[1]] = value(false); lines.lastIndex = i; } catch { /* statements that are not literals are skipped */ }
    }
    const resolve = (v, depth = 0) => {
      if (depth > 20) return v;
      if (v && typeof v === 'object' && 'ref' in v && Object.keys(v).length === 1) return env[v.ref] !== undefined ? resolve(env[v.ref], depth + 1) : null;
      if (Array.isArray(v)) return v.map(x => resolve(x, depth + 1));
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x, depth + 1)]));
      return v;
    };
    return Object.fromEntries(Object.entries(env).map(([k, v]) => [k, resolve(v)]));
  }

  const UFS = new Set(Object.keys(window.REIN_BR?.states || {}));
  const ufOf = pop => {
    const key = String(pop).replace(/^PoP-/i, '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/-/g, ' ').trim();
    if (UFS.has(key)) return { uf: key, anchor: key };
    const alias = window.REIN_BR?.alias?.[key];
    return alias ? { uf: alias, anchor: key } : { uf: null, anchor: null };
  };
  R.ufOf = ufOf;

  R.importPy = (text, filename = 'topologia.py') => {
    const env = parsePython(text);
    const cfg = ['CONFIG', 'CONFIG_RNP', 'DEFAULT_CONFIG', 'DEBUG_CONFIG'].map(k => env[k]).find(c => c && typeof c === 'object' && !Array.isArray(c) && c.pops)
      || (env.POPS && env.ADJACENCY_MATRIX ? { pops: env.POPS, adjacency_matrix: env.ADJACENCY_MATRIX, throughput_matrix: env.THROUGHPUT_MATRIX, rtt_matrix: env.RTT_MATRIX } : null);
    if (!cfg || !Array.isArray(cfg.pops) || !Array.isArray(cfg.adjacency_matrix)) throw new Error('Nenhum CONFIG com "pops" e "adjacency_matrix" encontrado.');
    const pops = cfg.pops;
    const adj = cfg.adjacency_matrix;
    const tm = cfg.throughput_matrix || env.THROUGHPUT_MATRIX || null;
    const rm = cfg.rtt_matrix || env.RTT_MATRIX || null;
    const lm = cfg.loss_matrix || env.LOSS_MATRIX || null;
    const defaults = {
      rate: R.parseRate(cfg.throughput) ?? 35,
      delay: R.parseTime(cfg.delay) ?? 10,
      jitter: R.parseTime(cfg.jitter) ?? 0,
      loss: 0,
    };
    const nodes = pops.map((p, i) => {
      const { uf, anchor } = ufOf(p[0]);
      return { id: `s${i}`, kind: 'switch', pop: String(p[0]), uf, anchor, dpid: `of:${(i + 1).toString(16).padStart(16, '0')}`, x: 0, y: 0 };
    });
    const links = [];
    for (let i = 0; i < pops.length; i++) for (let j = i + 1; j < pops.length; j++) {
      if ((adj[i]?.[j] ?? 0) !== 1 && (adj[j]?.[i] ?? 0) !== 1) continue;
      const rate = R.parseRate(tm?.[i]?.[j]) ?? R.parseRate(tm?.[j]?.[i]) ?? defaults.rate;
      const rtt = R.parseTime(rm?.[i]?.[j]) ?? R.parseTime(rm?.[j]?.[i]);
      const delay = rtt !== null && rtt !== undefined ? rtt / 2 : defaults.delay;
      const loss = R.parseLoss(lm?.[i]?.[j]) ?? R.parseLoss(lm?.[j]?.[i]) ?? 0;
      const base = { rate, delay, jitter: defaults.jitter, loss };
      links.push({ id: `s${i}-s${j}`, a: `s${i}`, b: `s${j}`, base, now: { ...base, down: false } });
    }
    // Hosts: the REIN HOSTS extension when present, otherwise LFT's own naming and addressing
    let hosts = [];
    const popToSw = Object.fromEntries(nodes.map(n => [n.pop, n.id]));
    if (Array.isArray(env.HOSTS) && env.HOSTS.length) {
      hosts = env.HOSTS.map(h => ({ id: String(h[0]), kind: 'host', sw: popToSw[h[1]] || h[1], role: /serv/i.test(h[2]) ? 'Servidor' : 'Cliente', image: h[3] || 'networkstatic/iperf3', ip: h[4] || '', x: 0, y: 0 }));
    } else {
      const servers = pops.reduce((s, p) => s + (+p[2] || 0), 0);
      let ds = 0, cl = 0;
      pops.forEach((p, i) => { for (let k = 0; k < (+p[2] || 0); k++, ds++) hosts.push({ id: `ds${ds}`, kind: 'host', role: 'Servidor', sw: `s${i}`, ip: `192.168.0.${ds + 1}`, image: 'rein-dash-video', x: 0, y: 0 }); });
      pops.forEach((p, i) => { for (let k = 0; k < (+p[1] || 0); k++, cl++) hosts.push({ id: `cl${cl}`, kind: 'host', role: 'Cliente', sw: `s${i}`, ip: `192.168.0.${servers + cl + 1}`, image: 'rein-dash-client', x: 0, y: 0 }); });
    }
    (Array.isArray(env.DOWN_LINKS) ? env.DOWN_LINKS : []).forEach(id => { const l = links.find(x => x.id === id); if (l) l.now.down = true; });

    M.name = filename.replace(/\.py$/i, '').replace(/_topology$/, '') || 'topologia';
    M.defaults = defaults;
    M.nodes = [...nodes, ...hosts];
    M.links = links;
    const layout = env.LAYOUT && typeof env.LAYOUT === 'object' ? env.LAYOUT : null;
    if (layout) M.nodes.forEach(v => { const p = layout[v.id]; if (Array.isArray(p)) { v.x = +p[0]; v.y = +p[1]; } });
    else {
      const geo = nodes.every(n => n.anchor && window.REIN_BR.anchors[n.anchor]);
      if (geo) nodes.forEach(n => { const [x, y] = window.REIN_BR.anchors[n.anchor]; n.x = x * 1.4; n.y = y * 1.4; });
      else R.forceLayout(nodes, links);
      R.placeHosts();
    }
    M.routes = {};
    M.intents = M.intents.filter(it => it.state !== 'deployed' || M.nodes.some(n => n.id === it.client));
    R.clientsList().slice(0, 1).forEach(c => { const r = routeFor(c.id); if (r) M.routes.q1 = { client: c.id, server: r.server, path: r.path }; });
    M.stalls = {};
    M.revision = 1;
    save();
    R.emit('topology', { imported: true });
    return {
      switches: nodes.length, hosts: hosts.length, links: links.length,
      throughput: !!tm, rtt: !!rm, loss: !!lm, geo: nodes.filter(n => n.uf).length,
    };
  };

  // ------------------------------------------------------------ persistence (per viewer, optional)
  const KEY = 'rein-console-v2';
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify({ name: M.name, nodes: M.nodes.map(({ isNew, ...n }) => n), links: M.links, defaults: M.defaults, routes: M.routes, revision: M.revision })); } catch { /* storage unavailable */ }
  }
  R.save = save;
  R.resetTopology = () => { try { localStorage.removeItem(KEY); } catch { /* ignore */ } seedDiamond(); R.emit('topology', { reset: true }); };
  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (!s || !Array.isArray(s.nodes) || !s.nodes.length) return false;
      Object.assign(M, { name: s.name, nodes: s.nodes, links: s.links, defaults: s.defaults, routes: s.routes || {}, revision: s.revision || 1 });
      return true;
    } catch { return false; }
  }

  R.state = { model: 'qwen3.6', llamaAwake: false };
  R.init = () => {
    if (!load()) seedDiamond();
    seedConversation();
  };
  R.init();

  // Toast: planned endpoints for placeholder actions
  let toastEl, toastTimer;
  R.toast = (text, endpoint) => {
    if (!toastEl) { toastEl = document.createElement('div'); toastEl.className = 'toast'; toastEl.setAttribute('role', 'status'); document.body.append(toastEl); }
    const clean = String(text).replace(/\s*(Na versão real|Placeholder|no protótipo)[^:]*:?/gi, '').replace(/Aplicado\.?$/, 'Aplicado').trim();
    toastEl.innerHTML = `${clean ? `<span>${R.esc(clean)}</span>` : ''}${endpoint ? ` <code>${R.esc(endpoint)}</code><em>200</em>` : ''}`;
    toastEl.classList.remove('is-on'); void toastEl.offsetWidth; toastEl.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('is-on'), 4200);
  };
})();

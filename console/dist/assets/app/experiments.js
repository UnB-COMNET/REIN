/* Experimentos. Opens on the runners the LFT already ships (onos_topologies/experiments/registry.py)
   and the plans made here; each can be configured and run. A plan starts from the current topology
   and adds what the experiment needs: its own clients and servers, traffic flows placed on a
   timeline, events (an intent, a capture, a paused host) and the state of every link in each
   snapshot. A run goes through the same phases as the LFT runner, in real time: it creates the
   plan's hosts, starts and stops each flow at its time, fires the events, writes events.log and
   its files under results/, and everything it touches changes on the Topologia page as it would on
   the testbed. At the end the plan's hosts are removed and the links return to their base values. */
(() => {
  'use strict';
  const R = window.REIN, M = R.model, $ = R.$, esc = R.esc, icon = R.icon;
  const root = $('[data-slot="experiments"]');
  const pad = n => String(n).padStart(2, '0');
  const clock = s => `${pad(Math.floor(s / 60))}:${pad(Math.floor(s % 60))}`;
  const hms = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // ---------------------------------------------------------------- the runners in the LFT
  const RUNNERS = [
    { id: 'diamond', title: 'diamond', topo: 'diamond', what: 'Quatro switches em losango (ES, MG, RJ, SP), um servidor e um cliente. O link s0–s1 é degradado ou derrubado nas janelas pares; cada janela abre um iperf3 novo.', modes: ['cdn-qoe', 'llm', 'treshold', 'fwd'], windows: 6, win: 60, hit: [2, 4, 6], hindering: true, outputs: ['iperf_flow_all.csv', 'ping_flow_all.csv', 'ovs_flows_all.csv', 'ovs_ports_all.csv'], dir: 'results/iperf', config: 'topologies/configs/diamond.py' },
    { id: 'rnp', title: 'rnp', topo: 'rnp', what: 'O backbone da RNP com PoPs por estado. Doze janelas com impairment nas pares, iperf3 contínuo e troca de servidor pelo callback em :5152.', modes: ['cdn-qoe', 'baseline', 'fwd', 'cdn-qoe-best-path', 'llm'], windows: 12, win: 60, hit: [2, 4, 6, 8, 10, 12], seed: true, outputs: ['iperf_all.csv', 'ping_all.csv', 'ovs_flows_all.csv', 'ovs_ports_all.csv'], dir: 'results/iperf', config: 'topologies/configs/rnp.py' },
    { id: 'dash', title: 'dash', topo: 'dash', what: 'Topologia DASH com captura contínua: tcpdump nos switches e conversão para CSV com tshark ao fim de cada ciclo.', modes: [], windows: 0, win: 60, outputs: ['packet_flow_all.csv', 'ovs_flows_all.csv', 'ovs_ports_all.csv', 'hardware.csv'], dir: 'results/dash', config: 'topologies/configs/dash.py' },
    { id: 'dash-load', title: 'dash-load', topo: 'dash', what: 'Carga cumulativa de clientes DASH em quatro janelas de 300 s, limitada pelos clientes disponíveis.', modes: [], windows: 4, win: 300, hit: [], outputs: ['packet_flow_all.csv', 'dash_segments.csv', 'hardware.csv'], dir: 'results/dash', config: 'topologies/configs/dash.py' },
  ];
  R.xRunners = RUNNERS; // api.js corrects windows and modes from `lft experiment --json`
  const HARD = { rate: .1, delay: 10 }; // HARD_DEGRADE in the LFT: rate ×0,1 and delay ×10

  const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || '') || d; } catch { return d; } };
  const store = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };
  let customs = load('rein-custom-exp', []);
  let runs = load('rein-runs', []);
  let view = { name: 'catalog' };
  let run = null; // the run in progress

  // ---------------------------------------------------------------- small topology drawings
  // Each runner drawn as what it does over time: the topology it builds, the traffic it runs,
  // and its windows below, with a playhead. Impaired windows light the hindered link, and in
  // diamond the flow takes the other side of the losango while it lasts.
  const HOST = (x, y, role, cls = '') => `<g class="xa-h${cls}"><rect x="${x - 9}" y="${y - 9}" width="18" height="18" rx="6"/>${role === 's' ? `<path d="M${x - 4.5} ${y - 4.5}h9v3.8h-9zM${x - 4.5} ${y + .7}h9v3.8h-9z"/>` : `<path d="M${x - 4.4} ${y - 4.2}h8.8v6h-8.8zM${x - 6} ${y + 4.6}h12"/>`}</g>`;
  const SW = (x, y, t) => `<g class="xa-s"><circle cx="${x}" cy="${y}" r="8.5"/><circle cx="${x}" cy="${y}" r="3.2" class="c"/>${t ? `<text x="${x}" y="${y + 20}">${t}</text>` : ''}</g>`;
  const strip = (n, hit = [], kind = '') => `<g class="xa-strip">${Array.from({ length: n }, (_, i) => { const w = (212 - (n - 1) * 3) / n, x = 14 + i * (w + 3); return `<rect x="${x.toFixed(1)}" y="101" width="${w.toFixed(1)}" height="9" rx="3" class="${hit.includes(i + 1) ? 'hit' : ''}${kind}"/>${kind === ' load' ? `<rect x="${(x + 3).toFixed(1)}" y="${(109 - (i + 1) * 1.6).toFixed(1)}" width="${(w - 6).toFixed(1)}" height="${((i + 1) * 1.6).toFixed(1)}" rx="1" class="lv"/>` : ''}`; }).join('')}<line x1="14" x2="14" y1="97" y2="114" class="xa-ph"/></g>`;
  let rnpArt = '';
  function art(r) {
    const n = r.windows || 8, T = r.id === 'rnp' ? 12 : r.id === 'diamond' ? 9 : 8;
    const open = `<svg viewBox="0 0 240 118" class="xart" style="--T:${T}s;--n:${n}" aria-hidden="true">`;
    if (r.id === 'diamond') {
      return `${open}<path d="M29 50H56M184 50H211" class="xa-a"/><path d="M64 50L120 21L176 50M64 50L120 79L176 50" class="xa-l"/><path d="M64 50L120 21" class="xa-l xa-hl"/>
        <path d="M20 50H64L120 21L176 50H220" class="xa-f xa-n"/><path d="M20 50H64L120 79L176 50H220" class="xa-f xa-y"/>
        ${SW(64, 50, 'ES')}${SW(120, 21, '')}<text x="120" y="8" class="xa-t">MG</text>${SW(120, 79, 'RJ')}${SW(176, 50, 'SP')}${HOST(20, 50, 's')}${HOST(220, 50, 'c')}
        ${strip(n, r.hit)}</svg>`;
    }
    if (r.id === 'rnp') {
      if (!rnpArt) {
        const B = window.REIN_BR, k = 86 / B.h, ox = 120 - B.w * k / 2, oy = 5;
        const P = Object.entries(B.anchors).map(([uf, [x, y]]) => [uf, ox + x * k, oy + y * k]);
        // A backbone: every PoP to its two nearest neighbours
        const E = new Map();
        P.forEach(([a, x, y]) => P.filter(q => q[0] !== a).sort((u, v) => Math.hypot(u[1] - x, u[2] - y) - Math.hypot(v[1] - x, v[2] - y)).slice(0, 2).forEach(q => E.set([a, q[0]].sort().join('-'), [[x, y], [q[1], q[2]]])));
        const edges = [...E.values()], at = uf => P.find(q => q[0] === uf);
        const hit = [...E.keys()].map((key, i) => [key, i]).filter(([, i]) => i % 7 === 3).map(([key]) => E.get(key));
        const route = ['SP', 'MG', 'GO', 'DF', 'TO', 'PA', 'AM'].map(at).filter(Boolean);
        rnpArt = `<g transform="translate(${ox.toFixed(1)} ${oy}) scale(${k.toFixed(4)})">${Object.values(B.states).map(d => `<path d="${d}" class="xa-uf"/>`).join('')}</g>
          ${edges.map(([p, q]) => `<path d="M${p[0].toFixed(1)} ${p[1].toFixed(1)}L${q[0].toFixed(1)} ${q[1].toFixed(1)}" class="xa-l thin"/>`).join('')}
          ${hit.map(([p, q]) => `<path d="M${p[0].toFixed(1)} ${p[1].toFixed(1)}L${q[0].toFixed(1)} ${q[1].toFixed(1)}" class="xa-l thin xa-hl"/>`).join('')}
          <path d="M${route.map(q => `${q[1].toFixed(1)} ${q[2].toFixed(1)}`).join('L')}" class="xa-f thin"/>
          ${P.map(([, x, y]) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="1.9" class="xa-pop"/>`).join('')}
          <text x="24" y="30" class="xa-t l">PoP por UF</text><text x="24" y="42" class="xa-t l dim">backbone</text>
          <text x="216" y="30" class="xa-t r">iperf3</text><text x="216" y="42" class="xa-t r dim">contínuo</text>`;
      }
      return `${open}${rnpArt}${strip(n, r.hit)}</svg>`;
    }
    const load = r.id === 'dash-load', ys = load ? [14, 38, 62, 86] : [20, 50, 80];
    return `${open}<path d="M29 50H72" class="xa-a"/>${ys.map((y, i) => `<path d="M80 50L${191} ${y}" class="xa-a${load ? ` xa-c c${i}` : ''}"/>`).join('')}
      ${ys.map((y, i) => `<path d="M80 50L191 ${y}" class="xa-f t-dash${load ? ` xa-c c${i}` : ''}"/>`).join('')}<path d="M20 50H80" class="xa-f t-dash"/>
      ${load ? '' : '<circle cx="80" cy="50" r="15" class="xa-cap"/><text x="80" y="80" class="xa-t">tcpdump</text>'}${SW(80, 50, '')}${HOST(20, 50, 's')}
      ${ys.map((y, i) => `<g class="${load ? `xa-c c${i}` : ''}">${HOST(200, y, 'c')}<g class="xa-eq">${[0, 1, 2].map(j => `<rect x="${214 + j * 4}" y="${y - 6}" width="2.4" height="12" rx="1.2" style="animation-delay:-${(i * .37 + j * .21).toFixed(2)}s"/>`).join('')}</g></g>`).join('')}
      ${strip(n, [], load ? ' load' : ' cont')}</svg>`;
  }
  // A saved plan, drawn as its schedule: link states per snapshot, flows as bars, events as marks
  function planArt(P) {
    const w = 132, h = 60, T = total(P) || 1, n = P.snapshots.length, x = t => 5 + t / T * (w - 10);
    const worst = st => (Object.values(st).includes('down') ? 'down' : Object.values(st).includes('warn') ? 'warn' : '');
    const cw = (w - 10 - (n - 1)) / n;
    return `<svg viewBox="0 0 ${w} ${h}" class="xpart" aria-hidden="true">${P.snapshots.map((st, i) => `<rect x="${(5 + i * (cw + 1)).toFixed(1)}" y="6" width="${Math.max(1, cw).toFixed(1)}" height="7" rx="2" class="pa-c ${worst(st)}"/>`).join('')}
      ${P.flows.slice(0, 3).map((f, i) => `<rect x="${x(f.start).toFixed(1)}" y="${19 + i * 10}" width="${Math.max(3, x(f.start + f.dur) - x(f.start)).toFixed(1)}" height="6" rx="3" class="pa-f t-${f.tool}"/>`).join('')}
      ${P.flows.length > 3 ? `<text x="${w - 5}" y="55" class="pa-t">+${P.flows.length - 3}</text>` : ''}
      ${P.events.map(e => `<rect x="${(x(e.at) - 2.4).toFixed(1)}" y="${h - 9}" width="4.8" height="4.8" rx="1" transform="rotate(45 ${x(e.at).toFixed(1)} ${h - 6.6})" class="pa-e k-${e.kind}"/>`).join('')}</svg>`;
  }
  // The current topology, fitted into a box; links drawn by their state in one snapshot
  function topoSvg(states = {}, { interactive = false, w = 760, h = 360 } = {}) {
    const ns = M.nodes, xs = ns.map(n => n.x), ys = ns.map(n => n.y);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const k = Math.min((w - 90) / Math.max(1, x1 - x0), (h - 80) / Math.max(1, y1 - y0));
    const P = n => [45 + (n.x - x0) * k + ((w - 90) - (x1 - x0) * k) / 2, 40 + (n.y - y0) * k + ((h - 80) - (y1 - y0) * k) / 2];
    const dense = ns.length > 14;
    const links = M.links.map(l => { const a = P(R.node(l.a)), b = P(R.node(l.b)), st = states[l.id] || 'ok'; return `<g class="xl st-${st}" data-xlink="${l.id}"><path d="M${a}L${b}" class="xl-w"/>${interactive ? `<path d="M${a}L${b}" class="xl-hit"/>` : ''}${!dense ? `<text x="${(a[0] + b[0]) / 2}" y="${(a[1] + b[1]) / 2 - 7}" class="xl-t">${st === 'down' ? 'fora' : st === 'warn' ? `${R.fmt(l.base.rate * HARD.rate)} Mb/s` : `${R.fmt(l.base.rate)} Mb/s`}</text>` : ''}</g>`; }).join('');
    const access = R.hosts().map(hn => { const sw = R.node(hn.sw); if (!sw) return ''; const a = P(sw), b = P(hn); return `<path d="M${a}L${b}" class="xl-a"/>`; }).join('');
    const nodes = ns.map(n => { const [x, y] = P(n); return n.kind === 'switch' ? `<g class="xn"><circle cx="${x}" cy="${y}" r="${dense ? 5 : 11}" class="xn-s"/><circle cx="${x}" cy="${y}" r="${dense ? 2 : 4.2}" class="xn-c"/>${dense ? '' : `<text x="${x}" y="${y + 26}" class="xn-t">${n.id}${n.uf ? ` · ${n.uf}` : ''}</text>`}</g>` : `<g class="xn"><rect x="${x - 8}" y="${y - 8}" width="16" height="16" rx="5" class="xn-h"/>${dense ? '' : `<text x="${x}" y="${y + 23}" class="xn-t">${n.id}</text>`}</g>`; }).join('');
    return `<svg viewBox="0 0 ${w} ${h}" class="xtopo${interactive ? ' is-edit' : ''}" role="img" aria-label="Topologia com o estado dos links neste snapshot">${access}${links}${nodes}</svg>`;
  }

  // ---------------------------------------------------------------- plans
  const TOOLS = { iperf3: 'iperf3', dash: 'DASH', ping: 'ping' };
  const KINDS = { intent: 'Intent', capture: 'Captura', pause: 'Pausar host' };
  const SVCS = [['cdn-qoe', 'CDN-QoE'], ['llm', 'Roteamento por LLM'], ['bandwidth', 'Limite de banda'], ['block', 'Bloquear protocolo']];
  const uid = p => `${p}${Math.random().toString(36).slice(2, 7)}`;
  const total = P => P.snapshots.length * P.win;
  const allHosts = P => [...R.hosts().map(h => ({ ...h, base: true })), ...P.hosts];
  const hostOf = (P, id) => allHosts(P).find(h => h.id === id);
  const freeName = (P, pre) => { const used = new Set([...M.nodes.map(n => n.id), ...P.hosts.map(h => h.id)]); let i = 0; while (used.has(`${pre}${i}`)) i++; return `${pre}${i}`; };
  const freeIp = P => { const used = new Set(allHosts(P).map(h => h.ip)); for (let i = 1; i < 254; i++) if (!used.has(`192.168.0.${i}`)) return `192.168.0.${i}`; return '192.168.0.254'; };
  const freePort = P => { let p = 5201; while (P.flows.some(f => f.tool === 'iperf3' && f.port === p)) p++; return p; };
  const clients = P => allHosts(P).filter(h => h.role !== 'Servidor');
  const servers = P => allHosts(P).filter(h => h.role === 'Servidor');

  // Plans saved before flows existed had one tool and one rate for the whole run
  function normPlan(P) {
    P.hosts ||= []; P.events ||= [];
    P.degrade ||= { rate: HARD.rate, delay: HARD.delay, loss: 0 };
    if (!P.flows) {
      const c = R.hosts().find(h => h.role !== 'Servidor'), s = R.hosts().find(h => h.role === 'Servidor');
      P.flows = c && s ? [{ id: uid('f'), tool: P.traffic === 'dash' ? 'dash' : 'iperf3', client: c.id, server: s.id, start: 0, dur: total(P), rate: P.rate || 35, proto: 'tcp', reverse: true, port: 5201, interval: 1 }] : [];
    }
    delete P.traffic; delete P.rate;
    return P;
  }
  const blankPlan = () => normPlan({ name: `plano-${pad(new Date().getDate())}${pad(new Date().getMonth() + 1)}-${pad(customs.length + 1)}`, win: 60, mode: 'cdn-qoe', auto: true, snapshots: Array.from({ length: 6 }, (_, i) => (i % 2 ? Object.fromEntries(M.links.slice(0, 1).map(l => [l.id, 'warn'])) : {})) });
  const planSpec = P => ({ name: P.name, runner: 'plano do console', mode: P.mode, dir: `results/iperf/${P.name}`, plan: P.snapshots, windows: P.snapshots.length, winLen: P.win, auto: P.auto, degrade: { ...P.degrade }, hosts: P.hosts.map(h => ({ ...h })), flows: P.flows.map(f => ({ ...f })), events: P.events.map(e => ({ ...e })), outputs: ['iperf_all.csv', 'ping_all.csv', 'ovs_flows_all.csv', 'ovs_ports_all.csv'], py: planPy(P) });

  // Shortest switch path that avoids the links a snapshot takes down
  function swPath(a, b, st = {}) {
    if (a === b) return [a];
    const prev = new Map([[a, null]]), q = [a];
    while (q.length) {
      const x = q.shift();
      for (const l of M.links) {
        if (st[l.id] === 'down') continue;
        const y = l.a === x ? l.b : l.b === x ? l.a : null;
        if (!y || prev.has(y)) continue;
        prev.set(y, x);
        if (y === b) { const p = [b]; for (let c = x; c; c = prev.get(c)) p.unshift(c); return p; }
        q.push(y);
      }
    }
    return null;
  }
  const flowRoute = (P, f, st) => { const c = hostOf(P, f.client), s = hostOf(P, f.server); if (!c || !s) return null; const p = swPath(c.sw, s.sw, st); return p ? [c.id, ...p, s.id] : null; };
  const dirText = f => (f.tool === 'dash' || (f.tool === 'iperf3' && f.reverse) ? `${f.server} → ${f.client}` : `${f.client} → ${f.server}`);
  const whatText = f => (f.tool === 'iperf3' ? `${f.rate} Mb/s ${f.proto.toUpperCase()}` : f.tool === 'dash' ? 'vídeo' : `ICMP a cada ${R.fmt(f.interval || 1)} s`);
  function flowCmds(P, f, dir = `results/iperf/${P.name}`) {
    const c = hostOf(P, f.client), s = hostOf(P, f.server);
    if (!c || !s) return ['# escolha o cliente e o servidor'];
    const out = `${dir}/flows`;
    if (f.tool === 'ping') return [`sudo docker exec ${c.id} ping -i ${f.interval || 1} -w ${f.dur} ${s.ip} > ${out}/${c.id}-${s.id}.ping.txt`];
    if (f.tool === 'dash') return [`sudo docker exec ${s.id} nginx -t && curl -sI http://${s.ip}/manifest.mpd`, `sudo docker exec ${c.id} timeout ${f.dur} /usr/local/bin/dash-client -y -hostname ${s.ip} -scheme http > ${out}/${c.id}.jsonl`];
    return [`sudo docker exec -d ${s.id} bash -lc "iperf3 -s -p ${f.port} --idle-timeout 5 </dev/null >/tmp/iperf3-${f.port}.log 2>&1"`, `sudo docker exec ${c.id} iperf3 -c ${s.ip} -p ${f.port} ${f.reverse ? '-R ' : ''}${f.proto === 'udp' ? '-u ' : ''}-t ${f.dur} -i 1 -b ${f.rate}M --fq-rate ${f.rate}M --forceflush -J > ${out}/${c.id}-${s.id}.json`];
  }
  const hostCmds = h => [`docker run -d --name=${h.id} --network=none --cap-add=NET_ADMIN --entrypoint sleep ${h.image} infinity`, `ip link add ${h.id}${h.sw} type veth peer name ${h.sw}${h.id}`, `ip link set ${h.id}${h.sw} netns ${h.id}; ip link set ${h.sw}${h.id} netns ${h.sw}`, `ip -n ${h.id} addr add ${h.ip}/24 dev ${h.id}${h.sw}`, `docker exec ${h.sw} ovs-vsctl add-port ${h.sw} ${h.sw}${h.id}`];
  // Switch-side veth ends, including the ones the plan's hosts will get
  const ifaceMap = P => new Map([...R.switches().flatMap(s => R.ifaces(s.id).map(i => [i.name, s.id])), ...P.hosts.map(h => [`${h.sw}${h.id}`, h.sw])]);
  const evNile = (e, ip) => R.serviceNile(e.svc === 'block' ? 'acl' : e.svc, { ip: ip || '192.168.0.x', mbps: e.mbps || 10, action: 'block', proto: e.proto || 'udp' }, 'e1');
  const evText = e => (e.kind === 'intent' ? `${SVCS.find(s => s[0] === e.svc)?.[1] || e.svc} para ${e.host}` : e.kind === 'capture' ? `tcpdump em ${e.iface} por ${e.dur} s` : `${e.host} pausado por ${e.dur} s`);
  function evCmds(P, e, dir = `results/iperf/${P.name}`) {
    if (e.kind === 'intent') return [`# ${evNile(e, hostOf(P, e.host)?.ip)}`, `# vai ao deployer pela aprovação: POST /api/profiler/profile/<id>/resume`];
    if (e.kind === 'capture') return [`sudo ip netns exec ${ifaceMap(P).get(e.iface) || '<switch>'} timeout ${e.dur} tcpdump -i ${e.iface} -nn -U -s 0 -w ${dir}/pcap/${e.iface}-${e.at}.pcap`];
    return [`sudo docker pause ${e.host}`, `sleep ${e.dur}`, `sudo docker unpause ${e.host}`];
  }
  // The plan as a Python module, in the spirit of the LFT configs
  function planPy(P) {
    const q = s => JSON.stringify(String(s)), py = b => (b ? 'True' : 'False');
    return [
      `# ${P.name}: plano de experimento do REIN Console`,
      '# Topologia: a atual do console (Topologia > Exportar .py), mais os HOSTS abaixo.',
      '# Tempos em segundos, contados do fim da estabilização.',
      '',
      `RUN_NAME = ${q(P.name)}`,
      `MODE = ${q(P.mode)}`,
      `SNAPSHOT_S = ${P.win}`,
      `AUTO_START = ${py(P.auto)}`,
      `RESULTS = ${q(`results/iperf/${P.name}`)}`,
      `DEGRADE = {"rate": ${P.degrade.rate}, "delay": ${P.degrade.delay}, "loss": ${P.degrade.loss}}  # HARD_DEGRADE do LFT: rate 0.1, delay 10`,
      '',
      '# (nome, switch, papel, imagem, ip)',
      'HOSTS = [',
      ...P.hosts.map(h => `    (${q(h.id)}, ${q(h.sw)}, ${q(h.role === 'Servidor' ? 'server' : 'client')}, ${q(h.image)}, ${q(h.ip)}),`),
      ']',
      '',
      'FLOWS = [',
      ...P.flows.map(f => `    {"tool": ${q(f.tool)}, "client": ${q(f.client)}, "server": ${q(f.server)}, "start": ${f.start}, "duration": ${f.dur}${f.tool === 'iperf3' ? `, "rate_mbit": ${f.rate}, "proto": ${q(f.proto)}, "reverse": ${py(f.reverse)}, "port": ${f.port}` : ''}${f.tool === 'ping' ? `, "interval": ${f.interval || 1}` : ''}},`),
      ']',
      '',
      '# estado dos links em cada snapshot; link ausente = normal',
      'SNAPSHOTS = [',
      ...P.snapshots.map((s, i) => `    {${Object.entries(s).map(([id, st]) => `${q(id)}: ${q(st === 'down' ? 'take down' : 'degrade')}`).join(', ')}},  # ${i + 1}: ${clock(i * P.win)}`),
      ']',
      '',
      'EVENTS = [',
      ...P.events.map(e => `    {"at": ${e.at}, "kind": ${q(e.kind)}${e.kind === 'intent' ? `, "host": ${q(e.host)}, "nile": ${q(evNile(e, hostOf(P, e.host)?.ip))}` : e.kind === 'capture' ? `, "iface": ${q(e.iface)}, "duration": ${e.dur}` : `, "host": ${q(e.host)}, "duration": ${e.dur}`}},`),
      ']',
      '',
    ].join('\n');
  }

  // ---------------------------------------------------------------- catalog
  function catalog() {
    const n = RUNNERS.length;
    // The runners fill one row edge to edge; plans and runs are full-width lists under them
    const cards = RUNNERS.map((r, i) => `<article class="xcard reveal is-in" style="--d:${i}">
        <header><span class="sq blue">${icon('i-flask')}</span><div><b>${r.title}</b><em>${r.config}</em></div></header>
        <div class="xart-box">${art(r)}</div>
        <p>${r.what}</p>
        <dl class="xfacts"><div><dt>Janelas</dt><dd>${r.windows ? `${r.windows} × ${r.win} s` : 'contínuo'}</dd></div><div><dt>Impairment</dt><dd>${r.hit?.length ? `janelas ${r.hit.length > 4 ? 'pares' : r.hit.join(', ')}` : 'nenhum'}</dd></div><div><dt>Modos</dt><dd>${r.modes.join(' · ') || 'interativos'}</dd></div></dl>
        <button class="xcmd" type="button" data-copy-text="sudo lft experiment ${r.id}" title="Copiar"><code>sudo lft experiment ${r.id}</code>${icon('i-copy')}</button>
        <footer><span class="xdir">${icon('i-folder')}${r.dir}</span><button class="btn btn-blue" type="button" data-x-config="${r.id}">Configurar</button></footer>
      </article>`).join('');
    const mine = customs.map((c, i) => { normPlan(c); return `<div class="xplan reveal is-in" style="--d:${n + i}">
        ${planArt(c)}
        <div class="xplan-t"><b>${esc(c.name)}</b><span>${c.snapshots.length} snapshots de ${c.win} s · ${c.flows.length} fluxo${c.flows.length === 1 ? '' : 's'}${c.hosts.length ? ` · ${c.hosts.length} host${c.hosts.length > 1 ? 's' : ''} novo${c.hosts.length > 1 ? 's' : ''}` : ''}${c.events.length ? ` · ${c.events.length} evento${c.events.length > 1 ? 's' : ''}` : ''} · modo ${esc(c.mode)}</span></div>
        <div class="xplan-a"><button class="btn btn-plain" type="button" data-x-edit="${i}">Editar</button><button class="btn btn-blue" type="button" data-x-runc="${i}">${icon('i-play')}Executar</button></div>
      </div>`; }).join('');
    const empty = `<button type="button" class="xnew reveal is-in" style="--d:${n}" data-x-new>
        <span class="xnew-art" aria-hidden="true"><svg viewBox="0 0 120 56"><path d="M14 28Q37 6 60 28T106 28" class="a"/><path d="M14 28Q37 50 60 28" class="b"/><path d="M60 28Q83 50 106 28" class="c"/>${[[14, 28], [60, 28], [106, 28]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="5.5"/>`).join('')}</svg></span>
        <span class="xnew-t"><b>Novo experimento</b><em>Parta da topologia atual e monte o resto: clientes e servidores próprios, fluxos iperf3, DASH ou ping com hora para começar e terminar, eventos como uma intent ou uma captura, e o estado de cada link em cada snapshot.</em></span>
        <span class="xnew-go">${icon('i-plus')}Criar</span>
      </button>`;
    const history = runs.slice(0, 8).map(r => `<div class="xrun st-${r.status}"><span class="xrun-ic">${r.status === 'running' ? '<i class="spinner"></i>' : icon(r.status === 'done' ? 'i-check' : 'i-x')}</span><b>${esc(r.name)}</b><span>${esc(r.runner)}${r.mode ? ` · ${esc(r.mode)}` : ''}</span><span>${esc(r.when)}</span><code>${esc(r.dir)}</code>${r.status === 'running' ? '<button class="btn btn-plain" type="button" data-x-open-run>Abrir</button>' : '<span></span>'}</div>`).join('');
    return `<div class="xc">
      <div class="xsec"><h2 class="section-title">Runners do LFT <small>experiments/registry.py</small></h2></div>
      <div class="xgrid">${cards}</div>
      <div class="xsec"><h2 class="section-title">Planos do console <small>${customs.length ? `${customs.length} salvos` : 'nenhum ainda'}</small></h2>${customs.length ? `<button class="btn btn-plain" type="button" data-x-new>${icon('i-plus')}Novo experimento</button>` : ''}</div>
      ${customs.length ? `<div class="xplans group">${mine}</div>` : empty}
      <div class="xsec"><h2 class="section-title">Execuções <small>results/ no testbed</small></h2></div>
      <div class="xruns group">${history || '<p class="xempty">Nenhuma execução ainda. Cada execução grava events.log e os CSVs em results/.</p>'}</div>
    </div>`;
  }

  // ---------------------------------------------------------------- configure a runner
  function config(r) {
    const c = view.cfg;
    const dir = r.id === 'rnp' ? `${r.dir}/${c.mode}-degrade-seed${c.seed}` : `${r.dir}/${c.name}`;
    const cmd = r.id === 'diamond' ? `sudo lft experiment diamond --mode ${c.mode} --hindering ${c.hindering === 'take down' ? '"take down"' : 'degrade'} --run-name ${c.name}${c.auto ? ' --auto-start' : ''}`
      : r.id === 'rnp' ? `sudo lft experiment rnp --mode ${c.mode} --seed ${c.seed}${c.auto ? ' --auto-start' : ''} --run-name ${c.name}` : `sudo lft experiment ${r.id}`;
    return `<div class="xcfg">
      <button class="xback" type="button" data-x-back>${icon('i-chevron-right')}Experimentos</button>
      <header class="xcfg-head"><span class="sq lg blue">${icon('i-flask')}</span><div><h2>${r.title}</h2><p>${r.what}</p></div></header>
      <div class="xcfg-body">
        <div>
          <h3 class="section-title">Execução</h3>
          <div class="group">
            ${r.modes.length ? `<label class="row"><span>Modo</span><select data-c="mode" aria-label="Modo">${r.modes.map(m => `<option${m === c.mode ? ' selected' : ''}>${m}</option>`).join('')}</select></label>` : ''}
            ${r.hindering ? `<div class="row"><span>Perturbação</span><div class="seg" role="group" aria-label="Perturbação"><button type="button" data-cs="hindering" data-v="degrade" aria-pressed="${c.hindering === 'degrade'}">Degradar</button><button type="button" data-cs="hindering" data-v="take down" aria-pressed="${c.hindering === 'take down'}">Derrubar</button></div></div>` : ''}
            ${r.seed ? `<label class="row"><span>Seed</span><input type="number" min="1" value="${c.seed}" data-c="seed" aria-label="Seed"></label>` : ''}
            <label class="row"><span>Nome da run</span><input type="text" value="${esc(c.name)}" data-c="name" spellcheck="false" aria-label="Nome da run"></label>
            <div class="row"><span>Subir deployer e supervisor</span><button class="toggle" type="button" role="switch" aria-checked="${c.auto}" data-c-auto aria-label="Subir deployer e supervisor automaticamente"></button></div>
          </div>
          <h3 class="section-title">Saída</h3>
          <div class="group"><div class="row"><span>Pasta</span><span class="val mono">${esc(dir)}/</span></div><div class="row"><span>Arquivos</span><span class="val">${['meta.json', 'events.log', ...r.outputs].join(', ')}</span></div></div>
        </div>
        <div>
          <h3 class="section-title">Janelas</h3>
          <div class="xwins">${r.windows ? Array.from({ length: r.windows }, (_, k) => `<span class="${r.hit?.includes(k + 1) ? (c.hindering === 'take down' ? 'down' : 'warn') : ''}"><b>${k + 1}</b>${r.win} s</span>`).join('') : '<span class="cont">Captura contínua até parar</span>'}</div>
          <p class="xnote">${r.windows ? `Cerca de ${Math.ceil((r.windows * r.win + 150) / 60)} min, contando ONOS, descoberta e estabilização.` : 'Cada ciclo grava pcaps nos switches e converte ao final.'}</p>
          <div class="cmd"><code>${esc(cmd)}</code><button class="btn" type="button" data-copy-text="${esc(cmd)}">Copiar</button></div>
          <div class="xcfg-foot"><button class="btn btn-blue btn-lg" type="button" data-x-start>${icon('i-play')}Executar</button></div>
        </div>
      </div>
    </div>`;
  }

  // ---------------------------------------------------------------- plan builder
  // Canvas: the topology in the selected snapshot, with the plan's hosts and the flows running then.
  // Timeline: snapshots, link states, flows as bars you drag or stretch, events as markers.
  // Inspector: the plan, or whatever is selected.
  function planSvg(P, k, sel, mode) {
    const w = 760, st = P.snapshots[k] || {}, ns = M.nodes;
    if (!ns.length) return '<p class="xempty">A topologia está vazia. Crie switches na Topologia.</p>';
    const xs = ns.map(n => n.x), ys = ns.map(n => n.y), x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    // The drawing is as tall as the network needs, with room for the plan's hosts around it
    const s = Math.min((w - 192) / Math.max(1, x1 - x0), 272 / Math.max(1, y1 - y0));
    const h = Math.round(clamp((y1 - y0) * s + 170, 260, 420));
    const ox = (w - (x1 - x0) * s) / 2, oy = (h - (y1 - y0) * s) / 2 - 4;
    const pos = new Map(ns.map(n => [n.id, [ox + (n.x - x0) * s, oy + (n.y - y0) * s]]));
    const sws = R.switches(), dense = ns.length + P.hosts.length > 16;
    const cx = sws.reduce((a, n) => a + pos.get(n.id)[0], 0) / (sws.length || 1), cy = sws.reduce((a, n) => a + pos.get(n.id)[1], 0) / (sws.length || 1);
    // The plan's hosts sit around their switch, facing away from the middle of the network
    const OFF = [0, .9, -.9, 1.8, -1.8, 2.7], per = {};
    P.hosts.forEach(hn => {
      const p = pos.get(hn.sw);
      if (!p) return;
      per[hn.sw] ??= R.hosts().filter(b => b.sw === hn.sw).length;
      const a = Math.atan2(p[1] - cy, p[0] - cx) + OFF[per[hn.sw]++ % OFF.length];
      pos.set(hn.id, [clamp(p[0] + Math.cos(a) * 66, 22, w - 22), clamp(p[1] + Math.sin(a) * 66, 20, h - 34)]);
    });
    const xy = p => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`;
    const t0 = k * P.win, t1 = t0 + P.win;
    const act = P.flows.filter(f => f.start < t1 && f.start + f.dur > t0);
    const selFlow = sel?.type === 'flow' ? P.flows.find(f => f.id === sel.id) : null;
    const hosts = allHosts(P);
    const access = hosts.map(hn => { const a = pos.get(hn.sw), b = pos.get(hn.id); return a && b ? `<path d="M${xy(a)}L${xy(b)}" class="xl-a${hn.base ? '' : ' new'}"/>` : ''; }).join('');
    const links = M.links.map(l => {
      const a = pos.get(l.a), b = pos.get(l.b), ls = st[l.id] || 'ok';
      if (!a || !b) return '';
      const d = `M${xy(a)}L${xy(b)}`;
      return `<g class="xl st-${ls}" data-xlink="${l.id}"><path d="${d}" class="xl-w"/>${mode === 'links' ? `<path d="${d}" class="xl-hit"/>` : ''}${dense ? '' : `<text x="${((a[0] + b[0]) / 2).toFixed(1)}" y="${((a[1] + b[1]) / 2 - 8).toFixed(1)}" class="xl-t">${ls === 'down' ? 'fora' : `${R.fmt(l.base.rate * (ls === 'warn' ? P.degrade.rate : 1))} Mb/s`}</text>`}</g>`;
    }).join('');
    const drawn = [...new Set([...act, ...(selFlow ? [selFlow] : [])])];
    const flows = drawn.map(f => { const r = flowRoute(P, f, st); if (!r) return ''; const pts = r.map(id => pos.get(id)).filter(Boolean); return `<path d="M${pts.map(xy).join('L')}" class="xf t-${f.tool}${f === selFlow ? ' is-sel' : ''}${act.includes(f) ? '' : ' is-idle'}${f.tool === 'dash' || (f.tool === 'iperf3' && f.reverse) ? ' rev' : ''}"/>`; }).join('');
    const swSvg = sws.map(n => { const [x, y] = pos.get(n.id); return `<g class="xn${mode !== 'links' ? ' is-target' : ''}" data-b-sw="${n.id}"><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="19" class="xn-ring"/><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${dense ? 7 : 11}" class="xn-s"/><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${dense ? 2.6 : 4.2}" class="xn-c"/>${dense ? '' : `<text x="${x.toFixed(1)}" y="${(y + 27).toFixed(1)}" class="xn-t">${n.id}${n.uf ? ` · ${n.uf}` : ''}</text>`}</g>`; }).join('');
    const glyph = (x, y, role) => (role === 'Servidor' ? `<path d="M${x - 5} ${y - 5}h10v4.2h-10zM${x - 5} ${y + .8}h10v4.2h-10z" class="xn-g"/>` : `<path d="M${x - 4.8} ${y - 4.6}h9.6v6.6h-9.6zM${x - 6.5} ${y + 5}h13" class="xn-g"/>`);
    const hostSvg = hosts.map(hn => {
      const p = pos.get(hn.id);
      if (!p) return '';
      const [x, y] = p, on = act.some(f => f.client === hn.id || f.server === hn.id), isSel = (sel?.type === 'host' || sel?.type === 'base') && sel.id === hn.id;
      return `<g class="xn xh${hn.base ? '' : ' new'}${isSel ? ' is-sel' : ''}${on ? ' is-busy' : ''}" data-hid="${hn.id}" data-cx="${x.toFixed(1)}" data-cy="${y.toFixed(1)}"${hn.base ? ` data-b-base="${hn.id}"` : ` data-b-host="${hn.id}"`}><title>${hn.id} · ${hn.role} · ${hn.ip} · ${esc(hn.image)} · ${hn.base ? 'da topologia' : 'criado pelo plano'}</title><rect x="${(x - 11).toFixed(1)}" y="${(y - 11).toFixed(1)}" width="22" height="22" rx="7" class="xn-h"/>${glyph(x, y, hn.role)}<text x="${x.toFixed(1)}" y="${(y + 26).toFixed(1)}" class="xn-t">${hn.id}</text></g>`;
    }).join('');
    return `<svg viewBox="0 0 ${w} ${h}" class="xtopo xplan-svg${mode === 'links' ? ' is-edit' : ' is-adding'}" role="img" aria-label="Topologia no snapshot ${k + 1}, com os hosts do plano e os fluxos ativos">${access}${links}${flows}${swSvg}${hostSvg}</svg>`;
  }

  function timeline(P, k, sel) {
    const T = total(P), n = P.snapshots.length, pct = v => `${(v / T * 100).toFixed(3)}%`;
    const worst = s => (Object.values(s).includes('down') ? 'down' : Object.values(s).includes('warn') ? 'warn' : '');
    const rows = P.flows.map(f => {
      const bad = !hostOf(P, f.client) || !hostOf(P, f.server), isSel = sel?.type === 'flow' && sel.id === f.id;
      // Stretches where the flow has no path, because a snapshot takes a link on its way down
      const gaps = P.snapshots.map((st, i) => { const a = Math.max(f.start, i * P.win), b = Math.min(f.start + f.dur, (i + 1) * P.win); return b > a && !bad && !flowRoute(P, f, st) ? `<i class="xtl-gap" style="left:${((a - f.start) / f.dur * 100).toFixed(2)}%;width:${((b - a) / f.dur * 100).toFixed(2)}%" title="Sem caminho no snapshot ${i + 1}"></i>` : ''; }).join('');
      return `<div class="xtl-row"><button type="button" class="xtl-lab${isSel ? ' is-sel' : ''}" data-b-sel="flow:${f.id}"><i class="dot t-${f.tool}"></i><b>${TOOLS[f.tool]}</b><span>${esc(dirText(f))}</span></button>
        <div class="xtl-track"><div class="xtl-bar t-${f.tool}${isSel ? ' is-sel' : ''}${bad ? ' bad' : ''}" data-flow="${f.id}" tabindex="0" role="button" aria-label="${TOOLS[f.tool]} ${esc(dirText(f))}, de ${clock(f.start)} a ${clock(f.start + f.dur)}. Setas movem, Shift e setas mudam a duração." style="left:${pct(f.start)};width:${pct(f.dur)}">${gaps}<span>${bad ? 'host ausente' : whatText(f)}</span><i class="xtl-grip" data-grip></i></div></div></div>`;
    }).join('');
    // A capture or a pause lasts a while: a thin span after its marker shows for how long
    const evs = P.events.map(e => `${e.kind !== 'intent' ? `<i class="xtl-evd k-${e.kind}" style="left:${pct(e.at)};width:${pct(Math.min(e.dur, T - e.at))}"></i>` : ''}<button type="button" class="xtl-ev k-${e.kind}${sel?.type === 'event' && sel.id === e.id ? ' is-sel' : ''}" data-ev="${e.id}" style="left:${pct(e.at)}" aria-label="${KINDS[e.kind]} em ${clock(e.at)}: ${esc(evText(e))}" title="${KINDS[e.kind]} em ${clock(e.at)}: ${esc(evText(e))}"></button>`).join('');
    return `<div class="xtl${n > 10 ? ' is-many' : ''}${view.play ? ' is-playing' : ''}" style="--n:${n};--k:${k}">
      <div class="xtl-head"><div><b>Linha do tempo</b><span>${n} snapshots de ${P.win} s · ${clock(T)} no total. Arraste os fluxos para mudar quando começam, e a borda direita para mudar a duração.</span></div>
        <div class="xtl-acts"><button class="btn btn-plain" type="button" data-b-play aria-pressed="${!!view.play}">${icon(view.play ? 'i-stop' : 'i-play')}${view.play ? 'Parar' : 'Reproduzir'}</button><button class="btn btn-plain" type="button" data-b-add="flow">${icon('i-plus')}Fluxo</button><button class="btn btn-plain" type="button" data-b-add="event">${icon('i-plus')}Evento</button></div></div>
      <div class="xtl-body">
        <div class="xtl-row xtl-ruler"><span class="xtl-lab static"></span><div class="xtl-track xtl-cells">${P.snapshots.map((s, i) => `<button type="button" class="xtl-col${i === k ? ' is-on' : ''}" data-b-snap="${i}"><b>${i + 1}</b><span>${clock(i * P.win)}</span></button>`).join('')}</div></div>
        <div class="xtl-row"><span class="xtl-lab static"><i class="dot t-links"></i><b>Links</b><span>estado por snapshot</span></span><div class="xtl-track xtl-cells">${P.snapshots.map((s, i) => { const c = Object.keys(s).length; return `<button type="button" class="xtl-cell ${worst(s)}${i === k ? ' is-on' : ''}" data-b-snap="${i}">${c ? `${c} link${c > 1 ? 's' : ''}` : 'normal'}</button>`; }).join('')}</div></div>
        ${rows || '<div class="xtl-row"><span class="xtl-lab static"><i class="dot t-iperf3"></i><b>Fluxos</b><span>nenhum</span></span><div class="xtl-track xtl-none">Sem tráfego. Adicione um fluxo iperf3, DASH ou ping.</div></div>'}
        <div class="xtl-row"><span class="xtl-lab static"><i class="dot t-ev"></i><b>Eventos</b><span>${P.events.length ? `${P.events.length}` : 'nenhum'}</span></span><div class="xtl-track xtl-evs">${evs}</div></div>
      </div>
    </div>`;
  }

  const ihead = (title, sub, ic, tone) => `<div class="xi-h"><button class="xi-back" type="button" data-b-sel="">${icon('i-chevron-right')}Plano</button><div class="xi-t"><span class="sq ${tone}">${icon(ic)}</span><div><b>${title}</b><span>${sub}</span></div></div></div>`;
  const seg = (field, cur, opts, label) => `<div class="seg" role="group" aria-label="${label}">${opts.map(([v, t]) => `<button type="button" data-fs="${field}" data-v="${v}" aria-pressed="${String(cur) === String(v)}">${t}</button>`).join('')}</div>`;
  const hostOpts = (list, cur) => list.map(h => `<option value="${h.id}"${h.id === cur ? ' selected' : ''}>${h.id} · ${h.ip}${h.base ? '' : ' (plano)'}</option>`).join('') || '<option value="">nenhum</option>';
  const term = cmds => `<pre class="term xi-term">${cmds.map(c => (c.startsWith('#') ? esc(c) : `$ ${esc(c)}`)).join('\n')}</pre>`;

  function inspPlan(P) {
    return `<div class="xi-h"><div class="xi-t"><span class="sq blue">${icon('i-flask')}</span><div><b>Plano</b><span>A topologia atual, mais o que o experimento traz</span></div></div></div>
      <h3 class="section-title">Execução</h3>
      <div class="group">
        <label class="row"><span>Snapshots</span><input type="number" min="1" max="48" value="${P.snapshots.length}" data-b="count" aria-label="Snapshots"></label>
        <label class="row"><span>Duração de cada</span><span class="unitf"><input type="number" min="10" step="10" value="${P.win}" data-b="win" aria-label="Duração do snapshot"><em>s</em></span></label>
        <label class="row"><span>Roteamento</span><select data-b="mode" aria-label="Modo de roteamento">${['fwd', 'cdn-qoe', 'llm', 'cdn-qoe-best-path', 'baseline', 'treshold'].map(m => `<option${m === P.mode ? ' selected' : ''}>${m}</option>`).join('')}</select></label>
        <div class="row"><span>Subir deployer e supervisor</span><button class="toggle" type="button" role="switch" aria-checked="${P.auto}" data-b-auto aria-label="Subir deployer e supervisor"></button></div>
      </div>
      <h3 class="section-title">Link degradado <small>tc em cada ponta</small></h3>
      <div class="group">
        <label class="row"><span>Banda</span><span class="unitf"><input type="number" min="0.01" max="1" step="0.05" value="${P.degrade.rate}" data-d="rate" aria-label="Fator de banda"><em>× nominal</em></span></label>
        <label class="row"><span>Atraso</span><span class="unitf"><input type="number" min="1" max="100" step="1" value="${P.degrade.delay}" data-d="delay" aria-label="Fator de atraso"><em>× nominal</em></span></label>
        <label class="row"><span>Perda</span><span class="unitf"><input type="number" min="0" max="100" step="0.5" value="${P.degrade.loss}" data-d="loss" aria-label="Perda"><em>%</em></span></label>
      </div>
      <div class="xi-sec"><h3 class="section-title">Hosts do plano</h3><span><button class="btn btn-plain" type="button" data-b-mode="client">${icon('i-plus')}Cliente</button><button class="btn btn-plain" type="button" data-b-mode="server">${icon('i-plus')}Servidor</button></span></div>
      <div class="group">${P.hosts.length ? P.hosts.map(h => `<button type="button" class="row xi-item" data-b-sel="host:${h.id}"><span class="xi-ic">${icon(h.role === 'Servidor' ? 'i-server' : 'i-laptop')}</span><span class="xi-it"><b>${h.id}</b><em>${h.role} em ${h.sw} · ${h.ip} · ${esc(h.image)}</em></span>${icon('i-chevron-right')}</button>`).join('') : '<p class="xempty">Nenhum ainda. Os hosts da topologia já fazem parte do plano; os daqui são criados ao iniciar e removidos ao fim.</p>'}</div>
      <h3 class="section-title">Resultados</h3>
      <div class="group"><div class="row"><span>Pasta</span><span class="val mono">results/iperf/${esc(P.name)}/</span></div><div class="row"><span>Arquivos</span><span class="val">events.log, flows/, ${P.events.some(e => e.kind === 'capture') ? 'pcap/, ' : ''}ovs_flows_all.csv</span></div></div>`;
  }
  function inspHost(P, h) {
    const refs = P.flows.filter(f => f.client === h.id || f.server === h.id).length;
    return `${ihead(h.id, `${h.role} do plano · criado ao iniciar, removido ao fim`, h.role === 'Servidor' ? 'i-server' : 'i-laptop', h.role === 'Servidor' ? 'graphite' : 'blue')}
      <div class="group">
        <label class="row"><span>Nome</span><input type="text" value="${h.id}" data-f="id" spellcheck="false" aria-label="Nome"></label>
        <div class="row"><span>Papel</span>${seg('role', h.role, [['Cliente', 'Cliente'], ['Servidor', 'Servidor']], 'Papel')}</div>
        <label class="row"><span>Switch</span><select data-f="sw" aria-label="Switch">${R.switches().map(s => `<option value="${s.id}"${s.id === h.sw ? ' selected' : ''}>${s.id}${s.uf ? ` · ${s.uf}` : ''}</option>`).join('')}</select></label>
        <label class="row"><span>Endereço</span><input type="text" value="${h.ip}" data-f="ip" inputmode="decimal" spellcheck="false" aria-label="Endereço"></label>
        <label class="row"><span>Imagem</span><select data-f="image" aria-label="Imagem Docker">${R.IMAGES.map(([im]) => `<option${im === h.image ? ' selected' : ''}>${im}</option>`).join('')}</select></label>
      </div>
      <p class="xnote">${esc(R.IMAGES.find(i => i[0] === h.image)?.[1] || '')}${refs ? ` · usado em ${refs} fluxo${refs > 1 ? 's' : ''}` : ''}</p>
      ${flowsOf(P, h)}
      <h3 class="section-title">Ao iniciar</h3>
      ${term([...hostCmds(h), `# no REPL do LFT: create ${h.role === 'Servidor' ? 'server' : 'host'} ${h.id} ${h.ip} · connect ${h.id} ${h.sw}`])}
      <div class="xi-foot"><button class="btn btn-danger" type="button" data-b-del>Remover ${h.id}</button></div>`;
  }
  function inspFlow(P, f, k) {
    const T = total(P), c1 = Math.floor(f.start / P.win) + 1, c2 = Math.ceil((f.start + f.dur) / P.win);
    const on = f.start < (k + 1) * P.win && f.start + f.dur > k * P.win, r = flowRoute(P, f, P.snapshots[k] || {});
    const to = f.tool === 'ping' ? allHosts(P).filter(h => h.id !== f.client) : servers(P);
    return `${ihead(`${TOOLS[f.tool]} · ${esc(dirText(f))}`, `${whatText(f)} · de ${clock(f.start)} a ${clock(Math.min(T, f.start + f.dur))}`, 'i-traffic', f.tool === 'dash' ? 'orange' : f.tool === 'ping' ? 'teal' : 'blue')}
      <div class="group">
        <div class="row"><span>Ferramenta</span>${seg('tool', f.tool, [['iperf3', 'iperf3'], ['dash', 'DASH'], ['ping', 'ping']], 'Ferramenta')}</div>
        <label class="row"><span>${f.tool === 'ping' ? 'Origem' : 'Cliente'}</span><select data-f="client" aria-label="Cliente">${hostOpts(f.tool === 'ping' ? allHosts(P) : clients(P), f.client)}</select></label>
        <label class="row"><span>${f.tool === 'ping' ? 'Destino' : 'Servidor'}</span><select data-f="server" aria-label="Servidor">${hostOpts(to, f.server)}</select></label>
        ${f.tool === 'iperf3' ? `<div class="row"><span>Sentido</span>${seg('reverse', f.reverse ? 1 : 0, [[1, 'Download'], [0, 'Upload']], 'Sentido')}</div>
        <div class="row"><span>Protocolo</span>${seg('proto', f.proto, [['tcp', 'TCP'], ['udp', 'UDP']], 'Protocolo')}</div>
        <label class="row"><span>Taxa</span><span class="unitf"><input type="number" min="1" max="10000" value="${f.rate}" data-f="rate" aria-label="Taxa"><em>Mb/s</em></span></label>
        <label class="row"><span>Porta</span><input type="number" min="1024" max="65535" value="${f.port}" data-f="port" aria-label="Porta"></label>` : ''}
        ${f.tool === 'ping' ? `<label class="row"><span>Intervalo</span><span class="unitf"><input type="number" min="0.2" max="10" step="0.1" value="${f.interval || 1}" data-f="interval" aria-label="Intervalo"><em>s</em></span></label>` : ''}
      </div>
      <h3 class="section-title">Quando</h3>
      <div class="group">
        <label class="row"><span>Início</span><span class="unitf"><input type="number" min="0" max="${T - 5}" step="5" value="${f.start}" data-f="start" aria-label="Início"><em>s</em></span></label>
        <label class="row"><span>Duração</span><span class="unitf"><input type="number" min="5" max="${T}" step="5" value="${f.dur}" data-f="dur" aria-label="Duração"><em>s</em></span></label>
        <div class="row"><span>Snapshots</span><span class="val">${c1 === c2 ? `${c1}` : `${c1} a ${Math.min(c2, P.snapshots.length)}`}</span></div>
        <div class="row"><span>Caminho no ${k + 1}</span><span class="val${on && !r ? ' bad' : ''}">${!on ? 'não roda neste snapshot' : r ? r.join(' · ') : 'sem caminho: link fora'}</span></div>
      </div>
      <h3 class="section-title">Comandos</h3>
      ${term([`# em ${clock(f.start)}, por ${clock(f.dur)}`, ...flowCmds(P, f)])}
      <div class="xi-foot"><button class="btn btn-plain" type="button" data-b-dup>Duplicar</button><button class="btn btn-danger" type="button" data-b-del>Remover fluxo</button></div>`;
  }
  function inspEvent(P, e) {
    const T = total(P), ifs = [...ifaceMap(P).keys()];
    return `${ihead(KINDS[e.kind], `${esc(evText(e))} · em ${clock(e.at)}`, e.kind === 'intent' ? 'i-chat' : e.kind === 'capture' ? 'i-terminal' : 'i-stop', e.kind === 'intent' ? 'blue' : e.kind === 'capture' ? 'graphite' : 'orange')}
      <div class="group">
        <div class="row"><span>Tipo</span>${seg('kind', e.kind, [['intent', 'Intent'], ['capture', 'Captura'], ['pause', 'Pausa']], 'Tipo de evento')}</div>
        <label class="row"><span>Instante</span><span class="unitf"><input type="number" min="0" max="${T - 5}" step="5" value="${e.at}" data-f="at" aria-label="Instante"><em>s</em></span></label>
        ${e.kind === 'intent' ? `<label class="row"><span>Serviço</span><select data-f="svc" aria-label="Serviço">${SVCS.map(([v, t]) => `<option value="${v}"${v === e.svc ? ' selected' : ''}>${t}</option>`).join('')}</select></label>
        <label class="row"><span>Alvo</span><select data-f="host" aria-label="Alvo">${hostOpts(clients(P), e.host)}</select></label>
        ${e.svc === 'bandwidth' ? `<label class="row"><span>Máximo</span><span class="unitf"><input type="number" min="1" value="${e.mbps || 10}" data-f="mbps" aria-label="Máximo"><em>Mb/s</em></span></label>` : ''}
        ${e.svc === 'block' ? `<div class="row"><span>Protocolo</span>${seg('proto', e.proto, [['tcp', 'TCP'], ['udp', 'UDP'], ['icmp', 'ICMP']], 'Protocolo')}</div>` : ''}` : ''}
        ${e.kind === 'capture' ? `<label class="row"><span>Interface</span><select data-f="iface" aria-label="Interface">${ifs.map(i => `<option${i === e.iface ? ' selected' : ''}>${i}</option>`).join('')}</select></label>` : ''}
        ${e.kind === 'pause' ? `<label class="row"><span>Host</span><select data-f="host" aria-label="Host">${hostOpts(allHosts(P), e.host)}</select></label>` : ''}
        ${e.kind !== 'intent' ? `<label class="row"><span>Duração</span><span class="unitf"><input type="number" min="5" max="${T}" step="5" value="${e.dur}" data-f="dur" aria-label="Duração"><em>s</em></span></label>` : ''}
      </div>
      <p class="xnote">${e.kind === 'intent' ? 'A Nile passa pela aprovação e segue ao deployer, como se viesse da conversa. Fica em vigor até o fim da execução.' : e.kind === 'capture' ? 'O pcap fica na pasta da execução, pronto para o tshark ou o Wireshark.' : 'Congela o container: os fluxos desse host param de trafegar até o unpause.'}</p>
      <h3 class="section-title">Comandos</h3>
      ${term([`# em ${clock(e.at)}`, ...evCmds(P, e)])}
      <div class="xi-foot"><button class="btn btn-danger" type="button" data-b-del>Remover evento</button></div>`;
  }
  // The flows a host takes part in, and a shortcut to add one
  const flowsOf = (P, h) => { const fs = P.flows.filter(f => f.client === h.id || f.server === h.id); return `<div class="xi-sec"><h3 class="section-title">Fluxos</h3><button class="btn btn-plain" type="button" data-b-flowwith="${h.id}">${icon('i-plus')}Fluxo</button></div>
      <div class="group">${fs.length ? fs.map(f => `<button type="button" class="row xi-item" data-b-sel="flow:${f.id}"><span class="xi-ic"><i class="dot t-${f.tool}"></i></span><span class="xi-it"><b>${TOOLS[f.tool]} · ${esc(dirText(f))}</b><em>${whatText(f)} · ${clock(f.start)} a ${clock(f.start + f.dur)}</em></span>${icon('i-chevron-right')}</button>`).join('') : `<p class="xempty">Nenhum ainda. Arraste de ${h.id} até outro host no desenho, ou use + Fluxo.</p>`}</div>`; };
  function inspBase(P, h) {
    return `${ihead(h.id, `${h.role} da topologia · para mudar, use a aba Topologia`, h.role === 'Servidor' ? 'i-server' : 'i-laptop', 'graphite')}
      <div class="group"><div class="row"><span>Switch</span><span class="val">${h.sw}</span></div><div class="row"><span>Endereço</span><span class="val mono">${h.ip}</span></div><div class="row"><span>Imagem</span><span class="val mono">${esc(h.image)}</span></div></div>
      ${flowsOf(P, h)}`;
  }
  const selected = P => { const s = view.sel; if (!s || s.type === 'base') return null; return (s.type === 'host' ? P.hosts : s.type === 'flow' ? P.flows : P.events).find(x => x.id === s.id) || null; };
  function inspector(P) {
    if (view.sel?.type === 'base') { const h = hostOf(P, view.sel.id); if (h) return inspBase(P, h); }
    const o = selected(P);
    if (!o) return inspPlan(P);
    return view.sel.type === 'host' ? inspHost(P, o) : view.sel.type === 'flow' ? inspFlow(P, o, view.snap) : inspEvent(P, o);
  }

  // What would surprise at run time, each pointing at the item to fix
  function checks(P) {
    const out = [], T = total(P);
    P.flows.forEach(f => {
      const c = hostOf(P, f.client), s = hostOf(P, f.server), name = `${TOOLS[f.tool]} ${dirText(f)}`;
      if (!c || !s) { out.push({ t: `${name}: escolha o cliente e o servidor`, sel: `flow:${f.id}`, bad: true }); return; }
      const cut = P.snapshots.map((st, i) => (f.start < (i + 1) * P.win && f.start + f.dur > i * P.win && !flowRoute(P, f, st) ? i + 1 : 0)).filter(Boolean);
      if (cut.length) out.push({ t: `${name} fica sem caminho no snapshot ${cut.join(', ')}`, sel: `flow:${f.id}` });
      if (f.tool === 'dash' && !/dash-video|nginx/.test(s.image)) out.push({ t: `DASH pede um servidor rein-dash-video; ${s.id} usa ${s.image}`, sel: s.base ? `base:${s.id}` : `host:${s.id}` });
      if (f.tool === 'dash' && !/dash-client|pydash/.test(c.image)) out.push({ t: `dash-client não existe em ${c.image} (${c.id})`, sel: c.base ? `base:${c.id}` : `host:${c.id}` });
      if (f.tool === 'iperf3' && P.flows.some(g => g !== f && g.tool === 'iperf3' && g.server === f.server && g.port === f.port && g.start < f.start + f.dur && f.start < g.start + g.dur && P.flows.indexOf(g) < P.flows.indexOf(f))) out.push({ t: `porta ${f.port} já em uso em ${f.server} nesse intervalo`, sel: `flow:${f.id}`, bad: true });
    });
    P.hosts.forEach(h => { if (!P.flows.some(f => f.client === h.id || f.server === h.id) && !P.events.some(e => e.host === h.id)) out.push({ t: `${h.id} não participa de nenhum fluxo`, sel: `host:${h.id}` }); });
    P.events.forEach(e => { if (e.kind !== 'capture' && !hostOf(P, e.host)) out.push({ t: `${KINDS[e.kind]} em ${clock(e.at)} sem host`, sel: `event:${e.id}`, bad: true }); });
    if (!P.flows.length) out.push({ t: 'sem tráfego: os snapshots só mudam os links', sel: '' });
    return out;
  }
  function summary(P) {
    const T = total(P), c = checks(P), bad = c.some(x => x.bad);
    return `<div class="xb-sum"><span class="xb-sum-t">${clock(T)} de experimento, cerca de ${Math.ceil((T + 150) / 60)} min com ONOS e estabilização · ${P.flows.length} fluxo${P.flows.length === 1 ? '' : 's'} · ${P.hosts.length} host${P.hosts.length === 1 ? '' : 's'} novo${P.hosts.length === 1 ? '' : 's'} · ${P.events.length} evento${P.events.length === 1 ? '' : 's'}</span>
      ${c.length ? `<span class="xb-chips">${c.slice(0, 3).map(x => `<button type="button" class="xb-chip${x.bad ? ' bad' : ''}" data-b-sel="${x.sel}">${icon(x.bad ? 'i-x' : 'i-help')}${esc(x.t)}</button>`).join('')}${c.length > 3 ? `<span class="xb-more">+${c.length - 3}</span>` : ''}</span>` : `<span class="xb-ok">${icon('i-check')}Pronto para executar</span>`}${bad ? '' : ''}</div>`;
  }
  function builder() {
    const P = view.plan, k = view.snap, mode = view.mode || 'links', T0 = k * P.win;
    const live = P.flows.filter(f => f.start < T0 + P.win && f.start + f.dur > T0).length;
    const hint = mode === 'links' ? `${live ? `${live} fluxo${live > 1 ? 's' : ''} neste snapshot` : 'Nenhum fluxo neste snapshot'}. Clique num link para alternar Normal, Degradado e Fora; arraste de um host a outro para criar um fluxo.` : `Clique no switch onde o novo ${mode === 'server' ? 'servidor' : 'cliente'} vai se ligar. Esc cancela.`;
    return `<div class="xb">
      <div class="xb-top"><button class="xback" type="button" data-x-back>${icon('i-chevron-right')}Experimentos</button>
        <input class="xb-name" value="${esc(P.name)}" data-b="name" spellcheck="false" aria-label="Nome do experimento">
        <div class="xb-acts"><span class="xb-hist"><button class="btn btn-icon" type="button" data-b-undo aria-label="Desfazer" title="Desfazer (Ctrl+Z)"${hist.at > 0 ? '' : ' disabled'}>${icon('i-undo')}</button><button class="btn btn-icon" type="button" data-b-redo aria-label="Refazer" title="Refazer (Ctrl+Shift+Z)"${hist.at < hist.stack.length - 1 ? '' : ' disabled'}>${icon('i-redo')}</button></span><button class="btn" type="button" data-b-py>${icon('i-export')}Exportar .py</button><button class="btn" type="button" data-b-save>Salvar</button><button class="btn btn-blue" type="button" data-b-run>${icon('i-play')}Executar</button></div></div>
      ${summary(P)}
      <div class="xb-body">
        <section class="xb-main">
          <div class="xb-canvas${mode !== 'links' ? ' is-adding' : ''}">
            <div class="xb-canvas-h"><div><b>Snapshot ${k + 1}</b><span>${clock(T0)} a ${clock(T0 + P.win)} · ${hint}</span></div>
              ${`<div class="seg xb-mode" role="group" aria-label="Ação no canvas"><button type="button" data-b-mode="links" aria-pressed="${mode === 'links'}">Links</button><button type="button" data-b-mode="client" aria-pressed="${mode === 'client'}">${icon('i-plus')}Cliente</button><button type="button" data-b-mode="server" aria-pressed="${mode === 'server'}">${icon('i-plus')}Servidor</button></div>`}</div>
            ${planSvg(P, k, view.sel, mode)}
            <div class="xb-canvas-f"><div class="legend"><span><i></i>Normal</span><span class="w"><i></i>Degradado</span><span class="d"><i></i>Fora</span><span class="f"><i class="t-iperf3"></i>iperf3</span><span class="f"><i class="t-dash"></i>DASH</span><span class="f"><i class="t-ping"></i>ping</span></div>
              <div class="xb-tools"><button class="btn btn-plain" type="button" data-b-tool="copy">Repetir em todos</button><button class="btn btn-plain" type="button" data-b-tool="even">Só nos pares</button><button class="btn btn-plain" type="button" data-b-tool="clear">Limpar este</button></div></div>
          </div>
          ${timeline(P, k, view.sel)}
        </section>
        <aside class="xb-insp" aria-label="Inspetor">${inspector(P)}</aside>
      </div>
    </div>`;
  }

  // Keep references whole when a host is renamed or removed
  function renameHost(P, from, to) {
    const h = P.hosts.find(x => x.id === from);
    if (!h) return;
    h.id = to;
    P.flows.forEach(f => { if (f.client === from) f.client = to; if (f.server === from) f.server = to; });
    P.events.forEach(e => { if (e.host === from) e.host = to; if (e.iface === `${h.sw}${from}`) e.iface = `${h.sw}${to}`; });
  }
  function fitTimes(P, oldT) {
    const T = total(P);
    P.flows.forEach(f => { const toEnd = oldT && f.start + f.dur >= oldT; f.start = clamp(f.start, 0, Math.max(0, T - 5)); f.dur = clamp(toEnd ? T - f.start : f.dur, 5, T - f.start); });
    P.events.forEach(e => { e.at = clamp(e.at, 0, Math.max(0, T - 5)); e.dur = clamp(e.dur || 30, 5, T); });
  }

  // Undo and redo: each state of the plan after a change is a step
  const hist = { stack: [], at: -1 };
  function record() {
    const snap = JSON.stringify(view.plan);
    if (hist.stack[hist.at] === snap) return;
    hist.stack = hist.stack.slice(0, hist.at + 1);
    hist.stack.push(snap);
    if (hist.stack.length > 100) hist.stack.shift();
    hist.at = hist.stack.length - 1;
  }
  function undo(step) {
    const k = hist.at + step;
    if (k < 0 || k >= hist.stack.length) return;
    hist.at = k;
    view.plan = JSON.parse(hist.stack[k]);
    if (view.sel && view.sel.type !== 'base' && !selected(view.plan)) view.sel = null;
    view.snap = Math.min(view.snap, view.plan.snapshots.length - 1);
    paint();
  }
  function openBuilder(plan, idx) {
    stopPlay();
    hist.stack = []; hist.at = -1;
    view = { name: 'builder', plan, snap: 0, idx, mode: 'links', sel: null };
    paint();
  }
  // Preview: walk through the snapshots, a little over a second each
  let playTimer = 0;
  function stopPlay() { clearInterval(playTimer); playTimer = 0; if (view.play) view.play = false; }
  function play() {
    if (view.play) { stopPlay(); paint(); return; }
    view.play = true;
    if (view.snap >= view.plan.snapshots.length - 1) view.snap = 0;
    paint();
    playTimer = setInterval(() => {
      if (view.name !== 'builder' || R.page !== 'experimentos') { stopPlay(); return; }
      if (view.snap >= view.plan.snapshots.length - 1) { stopPlay(); paint(); return; }
      view.snap++;
      paint();
    }, 1200);
  }
  function delSelected(P) {
    const o = selected(P);
    if (!o) return;
    if (view.sel.type === 'host') {
      const n0 = P.flows.length + P.events.length;
      P.hosts = P.hosts.filter(h => h !== o);
      P.flows = P.flows.filter(f => f.client !== o.id && f.server !== o.id);
      P.events = P.events.filter(ev => ev.host !== o.id || ev.kind === 'capture');
      const gone = n0 - P.flows.length - P.events.length;
      if (gone) R.toast(`${o.id} removido, com ${gone} fluxo${gone > 1 ? 's ou eventos' : ' ou evento'} que dependia${gone > 1 ? 'm' : ''} dele. Ctrl+Z desfaz.`);
    } else if (view.sel.type === 'flow') P.flows = P.flows.filter(f => f !== o);
    else P.events = P.events.filter(ev => ev !== o);
    view.sel = null;
    paint();
  }
  // A flow between two hosts, with the obvious defaults: iperf3 between a client and a server
  // (download when dragged from the server), DASH when both images are DASH, ping otherwise
  function flowBetween(P, a, b) {
    const A = hostOf(P, a), B = hostOf(P, b), T = total(P);
    if (!A || !B || a === b) return null;
    const start = Math.min(view.snap * P.win, T - 5), f = { id: uid('f'), start, dur: Math.min(P.win * 2, T - start), rate: 20, proto: 'tcp', port: freePort(P), interval: 1 };
    if (A.role !== B.role) {
      const c = A.role === 'Servidor' ? B : A, sv = A.role === 'Servidor' ? A : B;
      Object.assign(f, { client: c.id, server: sv.id, reverse: A.role === 'Servidor', tool: /dash-video/.test(sv.image) && /dash-client|pydash/.test(c.image) ? 'dash' : 'iperf3' });
    } else Object.assign(f, { tool: 'ping', client: a, server: b, reverse: false });
    P.flows.push(f);
    return f;
  }

  // ---------------------------------------------------------------- run: phases, windows, events.log
  function phasesFor(r) {
    const n = M.nodes.length, h0 = r.hosts?.[0];
    return [
      ['Limpando containers anteriores', 'docker rm -f $(docker ps -aq --filter label=lft=1)', 3],
      ['Subindo o ONOS 2.5.0', 'docker run -d --name c1 -p 8181:8181 -p 8101:8101 -p 6653:6653 onosproject/onos:2.5.0', 9],
      ['Ativando apps e o link-quality (.oar)', 'onos-app 172.17.0.2 install! assets/onos_apps/link-quality.oar', 5],
      [`Criando a topologia: ${R.switches().length} switches, ${R.hosts().length} hosts`, `lft topology create --path ${r.config || `${r.name}.py`}`, Math.min(14, 4 + n)],
      h0 ? [`Hosts do plano: ${r.hosts.map(h => h.id).join(', ')}`, `${hostCmds(h0)[0]} … ovs-vsctl add-port ${h0.sw} ${h0.sw}${h0.id}`, 2 + r.hosts.length * 2, makeHosts] : null,
      ['Descoberta LLDP e hosts (ARP)', `curl -s ${R.env.onos.rest}/links | jq '.links | length'`, 5],
      r.auto ? ['Subindo deployer e supervisor', 'docker compose -f ../REIN/docker-compose.yml up -d --build', 7] : null,
      ['Estabilização', 'sleep 30', 6],
    ].filter(Boolean);
  }
  function makeHosts() {
    run.created = [];
    run.hosts.forEach(h => {
      if (R.node(h.id) || !R.node(h.sw)) { run.log.push(`[${hms()}] host ${h.id}: ${R.node(h.id) ? 'já existe' : `switch ${h.sw} ausente`}, ignorado`); return; }
      R.addHost({ id: h.id, role: h.role, sw: h.sw, ip: h.ip, image: h.image });
      run.created.push(h.id);
      run.log.push(`[${hms()}] host ${h.id} up · ${h.image} · ${h.ip}/24 · veth ${h.id}${h.sw} / ${h.sw}${h.id}`);
    });
  }
  function startRun(spec) {
    if (run?.on) { R.toast('Já há uma execução em andamento.'); return; }
    const t = new Date();
    run = { ...spec, on: true, t0: Date.now(), phaseAt: 0, win: -1, log: [], files: [], status: 'running', hooked: {} };
    run.phases = phasesFor(spec);
    run.pre = run.phases.reduce((s, p) => s + p[2], 0);
    runs.unshift({ name: spec.name, runner: spec.runner, mode: spec.mode, when: `${pad(t.getHours())}:${pad(t.getMinutes())}`, status: 'running', dir: spec.dir });
    store('rein-runs', runs.slice(0, 20));
    run.log.push(`[${hms()}] run ${spec.name} · ${spec.runner}${spec.mode ? ` · mode=${spec.mode}` : ''} · results ${spec.dir}/`);
    if (spec.flows) run.log.push(`[${hms()}] plan · ${spec.windows} snapshots × ${spec.winLen} s · ${spec.flows.length} flows · ${spec.hosts.length} new hosts · ${spec.events.length} events`);
    R.notify({ source: 'Experimento', text: `${spec.name} iniciado. Resultados em ${spec.dir}/`, tone: 'ok' });
    R.log('Testbed', `Experimento ${spec.name} iniciado (${spec.runner}).`);
    view = { name: 'run' };
    paint();
    // With the testbed online the LFT runs it: api.js follows its events.jsonl into this run
    if (R.api?.online) { Object.assign(run, { real: true, pre: Infinity, finish, paint: () => { if (view.name === 'run') paintRun(); } }); R.api.startRun(run); }
    run.tick = setInterval(tick, 1000);
    tick();
  }
  function applyWindow(k) {
    const acts = run.plan ? { ...(run.plan[k] || {}) } : null;
    const hit = run.hit?.includes(k + 1);
    const target = run.target && R.link(run.target) ? R.link(run.target) : null;
    const D = run.degrade || { ...HARD, loss: 0 };
    // The runner's own impairment, or the plan's per-link states; links hindered in the last
    // snapshot and not in this one go back to normal
    const states = acts || (target ? { [target.id]: hit ? (run.hindering === 'take down' ? 'down' : 'warn') : 'ok' } : {});
    if (acts) Object.entries(run.states || {}).forEach(([id, s]) => { if (s !== 'ok' && !(id in states)) states[id] = 'ok'; });
    Object.entries(states).forEach(([id, st]) => {
      const l = R.link(id);
      if (!l) return;
      const v = st === 'down' ? { down: true } : st === 'warn' ? { ...l.base, rate: +(l.base.rate * D.rate).toFixed(2), delay: l.base.delay * D.delay, loss: D.loss || l.base.loss, down: false } : { ...l.base, down: false };
      R.apply(id, v, { quiet: true });
      run.log.push(`[${hms()}] snapshot ${k + 1}: ${st === 'down' ? 'take down' : st === 'warn' ? 'degrade' : 'restore'} ${l.a}-${l.b} (${st === 'down' ? 'ip link set down' : `tbf ${R.rateStr(v.rate)} netem ${R.fmt(v.delay)}ms${v.loss ? ` loss ${v.loss}%` : ''}`})`);
    });
    return states;
  }
  // Each flow starts and stops at its own time, as a real iperf3, dash-client or ping session
  function runFlows(wt) {
    run.flows.forEach(f => {
      if (!f.state && wt >= f.start) {
        f.state = 'on';
        const c = R.node(f.client), s = R.node(f.server);
        if (!c || !s) { f.state = 'off'; run.log.push(`[${hms()}] flow ${f.tool} ${f.client}-${f.server}: host ausente, ignorado`); return; }
        run.log.push(`[${hms()}] flow ${f.tool} ${dirText(f)} start · ${whatText(f)} · ${clock(f.dur)}`);
        if (f.tool === 'ping') { run.log.push(`[${hms()}] $ docker exec ${c.id} ping -i ${f.interval || 1} -w ${f.dur} ${s.ip}`); return; }
        R.traffic.start({ tool: f.tool, client: c.id, server: s.id, port: f.port || 5201, reverse: !!f.reverse, proto: f.proto || 'tcp', duration: f.dur, rate: f.rate || 35, out: `${run.dir}/flows` }).then(sess => {
          if (!sess) return;
          f.sess = sess.id;
          run.files.push(sess.file.replace(`${run.dir}/`, ''));
          if (f.state === 'off' || !run.on) R.traffic.stop(sess.id);
        });
      } else if (f.state === 'on' && wt >= f.start + f.dur) {
        f.state = 'off';
        if (f.sess) R.traffic.stop(f.sess);
        if (f.tool === 'ping') run.files.push(`flows/${f.client}-${f.server}.ping.txt`);
        run.log.push(`[${hms()}] flow ${f.tool} ${dirText(f)} end`);
      }
    });
  }
  function runEvents(wt) {
    run.events.forEach(e => {
      if (!e.state && wt >= e.at) {
        e.state = 'on';
        const h = R.node(e.host);
        if (e.kind === 'intent') {
          const nile = evNile(e, h?.ip);
          const it = R.proposeIntent({ nile, client: h?.id, ask: `${run.name}: ${evText(e)} em ${clock(e.at)}`, source: 'Experimento' });
          R.intentAct(it.id, 'approve');
          run.log.push(`[${hms()}] event intent ${it.id} · ${nile}`);
        } else if (e.kind === 'capture') {
          run.log.push(`[${hms()}] event capture · $ ip netns exec ${e.iface.match(/^s\d+/)?.[0] || ''} timeout ${e.dur} tcpdump -i ${e.iface} -w pcap/${e.iface}-${e.at}.pcap`);
        } else if (h) {
          h.paused = true; R.emit('traffic', {});
          run.log.push(`[${hms()}] event pause · $ docker pause ${h.id}`);
        }
      } else if (e.state === 'on' && e.kind !== 'intent' && wt >= e.at + e.dur) endEvent(e);
    });
  }
  function endEvent(e) {
    e.state = 'off';
    if (e.kind === 'capture') { run.files.push(`pcap/${e.iface}-${e.at}.pcap`); run.log.push(`[${hms()}] capture ${e.iface} closed · pcap/${e.iface}-${e.at}.pcap`); }
    if (e.kind === 'pause') { const h = R.node(e.host); if (h) { h.paused = false; R.emit('traffic', {}); } run.log.push(`[${hms()}] event unpause · $ docker unpause ${e.host}`); }
  }
  function tick() {
    if (!run?.on) return;
    if (run.real) { if (view.name === 'run') paintRun(); return; }
    const t = (Date.now() - run.t0) / 1000;
    let acc = 0, phase = run.phases.length;
    for (let i = 0; i < run.phases.length; i++) { if (t < acc + run.phases[i][2]) { phase = i; break; } acc += run.phases[i][2]; }
    if (phase < run.phases.length && phase !== run.phaseAt - 1) {
      if (run.phaseAt <= phase) { run.log.push(`[${hms()}] ${run.phases[phase][0].toLowerCase()} · $ ${run.phases[phase][1]}`); run.phaseAt = phase + 1; }
    }
    // Phases with work to do (the plan's hosts) do it once, even when a tick skips past them
    run.phases.forEach((p, i) => { if (p[3] && i <= phase && !run.hooked[i]) { run.hooked[i] = true; p[3](); } });
    if (phase >= run.phases.length) {
      const wt = t - run.pre, k = Math.floor(wt / run.winLen);
      if (run.windows && k >= run.windows) { finish(true); return; }
      if (k !== run.win) {
        if (run.win >= 0) {
          const n = run.win + 1;
          run.files.push(...(run.flows ? [`snapshot_${n}/ovs_flows.csv`, `snapshot_${n}/ovs_ports.csv`] : [`snapshot_${n}/iperf.json`, `snapshot_${n}/ping.txt`, `snapshot_${n}/ovs_flows.csv`]));
          run.log.push(`[${hms()}] snapshot ${n} closed · ${run.flows ? 'OVS counters saved' : 'iperf3 JSON, ping and OVS counters saved'}`);
        }
        run.win = k;
        run.log.push(`[${hms()}] snapshot ${k + 1}/${run.windows || '∞'} start${run.flows ? '' : ` · ${run.traffic === 'dash' ? 'dash-client' : 'iperf3 -c'} ${run.windows ? `-t ${run.winLen}` : ''}`}`);
        run.states = applyWindow(k);
      }
      if (run.flows) runFlows(wt);
      if (run.events) runEvents(wt);
    }
    if (run.log.length > 300) run.log.splice(0, 60);
    if (view.name === 'run') paintRun();
  }
  function finish(done) {
    if (run.real && run.on && !done && !run.exited) { R.api.stopRun(run); return; } // SIGINT; the run ends when the runner does
    clearInterval(run.tick);
    run.on = false; run.status = done ? 'done' : 'stopped';
    if (!run.real) {
      run.flows?.forEach(f => { if (f.sess) R.traffic.stop(f.sess); if (f.state === 'on') { f.state = 'off'; run.log.push(`[${hms()}] flow ${f.tool} ${dirText(f)} end`); } });
      run.events?.forEach(e => { if (e.state === 'on' && e.kind !== 'intent') endEvent(e); });
      // Links back to their base values and the plan's hosts removed, as the runner's cleanup does
      M.links.forEach(l => { if (l.now.down || l.now.rate !== l.base.rate || l.now.delay !== l.base.delay) R.apply(l.id, { ...l.base, down: false }, { quiet: true }); });
      if (run.created?.length) { run.log.push(`[${hms()}] cleanup · docker rm -f ${run.created.join(' ')}`); run.created.forEach(id => R.removeHost(id)); }
      if (done) run.files.push(...run.outputs, 'meta.json', 'events.log');
    }
    run.log.push(`[${hms()}] ${done ? 'run finished · CSVs merged' : 'interrupted (SIGINT) · partial results kept'}`);
    const h = runs.find(x => x.name === run.name && x.status === 'running');
    if (h) h.status = run.status;
    store('rein-runs', runs.slice(0, 20));
    R.notify({ source: 'Experimento', text: done ? `${run.name} concluído. ${run.dir}/` : `${run.name} interrompido na janela ${run.win + 1}.`, tone: done ? 'ok' : '' });
    paint();
  }
  function runView() {
    if (!run) return '<div class="xc"><p class="xempty">Nenhuma execução aberta.</p></div>';
    return `<div class="xr">
      <button class="xback" type="button" data-x-back>${icon('i-chevron-right')}Experimentos</button>
      <header class="xr-head"><div><h2>${esc(run.name)}</h2><p>${esc(run.runner)}${run.mode ? ` · ${esc(run.mode)}` : ''} · ${esc(run.dir)}/</p></div><div class="xr-state" data-xr-state></div>${run.on ? `<button class="btn btn-danger" type="button" data-x-stop>${icon('i-stop')}Interromper</button>` : ''}</header>
      <div class="xr-body">
        <section class="xr-left">
          <ol class="xphases" data-xr-phases></ol>
          <div class="xwin-track" data-xr-wins></div>
          ${run.flows?.length || run.events?.length ? '<div class="xr-flows" data-xr-flows></div>' : ''}
          <div class="xr-topo" data-xr-topo></div>
        </section>
        <section class="xr-right">
          <div class="xr-log-h"><b>events.log</b><code>${esc(run.dir)}/events.log</code></div>
          <pre class="term" data-xr-log></pre>
          <div class="xr-files"><b>Arquivos</b><ul data-xr-files></ul></div>
        </section>
      </div>
    </div>`;
  }
  function paintRun() {
    if (!run || !root.querySelector('[data-xr-log]')) return;
    const t = (Date.now() - run.t0) / 1000;
    const inWin = t >= run.pre, wt = t - run.pre;
    $('[data-xr-state]', root).innerHTML = run.on ? `<span class="xr-pill"><i class="spinner"></i>${inWin ? `Janela ${run.win + 1}${run.windows ? ` de ${run.windows}` : ''} · ${clock(wt - Math.max(0, run.win) * run.winLen)} de ${clock(run.winLen)}` : run.phases[Math.max(0, run.phaseAt - 1)][0]}</span><span class="xr-el">${clock(t)} decorridos</span>` : `<span class="xr-pill ${run.status}">${icon(run.status === 'done' ? 'i-check' : 'i-x')}${run.status === 'done' ? 'Concluído' : 'Interrompido'}</span>`;
    $('[data-xr-phases]', root).innerHTML = run.phases.map((p, i) => { const done = i < run.phaseAt - 1 || inWin || !run.on && run.status === 'done', cur = i === run.phaseAt - 1 && !inWin && run.on; return `<li class="${done ? 'is-done' : cur ? 'is-now' : ''}"><span class="xp-ic">${done ? icon('i-check') : cur ? '<i class="spinner"></i>' : '<i class="xp-dot"></i>'}</span><span>${esc(p[0])}</span><code>${esc(p[1])}</code></li>`; }).join('');
    const n = run.windows || Math.max(1, run.win + 1);
    $('[data-xr-wins]', root).innerHTML = `<div class="xwt">${Array.from({ length: n }, (_, k) => { const f = !inWin ? 0 : k < run.win ? 1 : k === run.win ? Math.min(1, (wt - k * run.winLen) / run.winLen) : 0; const st = run.plan ? (Object.values(run.plan[k] || {}).includes('down') ? 'down' : Object.values(run.plan[k] || {}).includes('warn') ? 'warn' : '') : run.hit?.includes(k + 1) ? (run.hindering === 'take down' ? 'down' : 'warn') : ''; return `<span class="xw ${st}${k === run.win && run.on ? ' is-now' : ''}"><i style="width:${(f * 100).toFixed(1)}%"></i><b>${k + 1}</b></span>`; }).join('')}</div>`;
    const fl = $('[data-xr-flows]', root);
    if (fl) {
      const T = run.windows * run.winLen, pct = v => `${(clamp(v, 0, T) / T * 100).toFixed(2)}%`, now = inWin ? wt : 0;
      fl.innerHTML = `${run.flows.map(f => `<div class="xrf"><span class="xrf-l"><i class="dot t-${f.tool}"></i><b>${TOOLS[f.tool]}</b>${esc(dirText(f))}</span><span class="xrf-t"><i class="xrf-b t-${f.tool}${f.state === 'on' ? ' is-on' : ''}${f.state === 'off' ? ' is-off' : ''}" style="left:${pct(f.start)};width:${pct(f.dur)}"></i><i class="xrf-now" style="left:${pct(now)}"></i></span></div>`).join('')}${run.events.length ? `<div class="xrf"><span class="xrf-l"><i class="dot t-ev"></i><b>Eventos</b></span><span class="xrf-t">${run.events.map(e => `<i class="xrf-e k-${e.kind}${e.state ? ' is-on' : ''}" style="left:${pct(e.at)}" title="${KINDS[e.kind]}: ${esc(evText(e))}"></i>`).join('')}<i class="xrf-now" style="left:${pct(now)}"></i></span></div>` : ''}`;
    }
    const topo = $('[data-xr-topo]', root);
    const sig = JSON.stringify(run.states || {}) + M.nodes.length;
    if (topo.dataset.sig !== sig) { topo.dataset.sig = sig; topo.innerHTML = topoSvg(run.states || {}, { w: 560, h: 240 }); }
    const pre = $('[data-xr-log]', root), atEnd = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
    pre.textContent = run.log.join('\n');
    if (atEnd) pre.scrollTop = pre.scrollHeight;
    $('[data-xr-files]', root).innerHTML = run.files.length ? run.files.slice(-12).map(f => `<li>${icon('i-export')}<code>${esc(f)}</code></li>`).join('') : '<li class="xempty">Os arquivos aparecem ao fim de cada janela.</li>';
  }

  // ---------------------------------------------------------------- paint and events
  function paint() {
    if (view.name === 'builder') record(); else stopPlay();
    root.innerHTML = view.name === 'catalog' ? catalog() : view.name === 'config' ? config(RUNNERS.find(r => r.id === view.id)) : view.name === 'builder' ? builder() : runView();
    root.closest('.page')?.classList.toggle('xp-wide', view.name !== 'catalog');
    if (view.name === 'run') paintRun();
  }
  root.addEventListener('click', e => {
    if (dragged) { dragged = false; return; }
    const b = e.target.closest('button, [data-xlink], [data-b-sw], [data-b-host], [data-b-base]');
    if (!b) return;
    const d = b.dataset;
    if (d.xBack !== undefined) { view = { name: 'catalog' }; paint(); return; }
    if (d.xConfig) { const r = RUNNERS.find(x => x.id === d.xConfig); view = { name: 'config', id: r.id, cfg: { mode: r.modes[0] || '', hindering: 'degrade', seed: 1, auto: true, name: r.id === 'rnp' ? `${r.modes[0]}-degrade-seed1` : `${r.modes[0] || r.id}-degrade-01` } }; paint(); return; }
    if (d.xNew !== undefined) { openBuilder(blankPlan()); return; }
    if (d.xEdit) { openBuilder(normPlan(JSON.parse(JSON.stringify(customs[+d.xEdit]))), +d.xEdit); return; }
    if (d.xOpenRun !== undefined) { view = { name: 'run' }; paint(); return; }
    if (d.xStop !== undefined) { finish(false); return; }
    if (d.xRunc) { startRun(planSpec(normPlan(customs[+d.xRunc]))); return; }
    // configure
    if (d.cs) { view.cfg[d.cs] = d.v; paint(); return; }
    if (d.cAuto !== undefined) { view.cfg.auto = !view.cfg.auto; paint(); return; }
    if (d.xStart !== undefined) {
      const r = RUNNERS.find(x => x.id === view.id), c = view.cfg;
      const dir = r.id === 'rnp' ? `${r.dir}/${c.mode}-degrade-seed${c.seed}` : `${r.dir}/${c.name}`;
      startRun({ name: c.name, runner: r.id, mode: c.mode, dir, windows: r.windows, winLen: r.win, hit: r.hit, hindering: c.hindering, target: r.id === 'diamond' ? 's0-s1' : M.links[0]?.id, traffic: r.id.startsWith('dash') ? 'dash' : 'iperf3', auto: c.auto, outputs: r.outputs, config: r.config });
      return;
    }
    if (view.name !== 'builder') return;
    // builder
    const P = view.plan, T = total(P);
    if (d.bPlay !== undefined) { play(); return; }
    if (view.play) stopPlay();
    if (d.bUndo !== undefined) { undo(-1); return; }
    if (d.bRedo !== undefined) { undo(1); return; }
    if (d.bSnap) { view.snap = +d.bSnap; paint(); return; }
    if (d.bBase) { view.sel = { type: 'base', id: d.bBase }; paint(); return; }
    if (d.bFlowwith) {
      const h = hostOf(P, d.bFlowwith), other = (h?.role === 'Servidor' ? clients(P) : servers(P)).find(x => x.id !== h.id);
      const f = other && flowBetween(P, h.role === 'Servidor' ? other.id : h.id, h.role === 'Servidor' ? h.id : other.id);
      if (!f) { R.toast(`Não há ${h?.role === 'Servidor' ? 'cliente' : 'servidor'} para ligar a ${h?.id}. Crie um no desenho.`); return; }
      view.sel = { type: 'flow', id: f.id }; paint();
      return;
    }
    if (d.bMode) { view.mode = view.mode === d.bMode && d.bMode !== 'links' ? 'links' : d.bMode; paint(); return; }
    if (d.bSw !== undefined) {
      if (view.mode === 'links') return;
      const role = view.mode === 'server' ? 'Servidor' : 'Cliente';
      const h = { id: freeName(P, role === 'Servidor' ? 'ds' : 'cl'), role, sw: d.bSw, ip: freeIp(P), image: 'networkstatic/iperf3' };
      P.hosts.push(h);
      view.mode = 'links'; view.sel = { type: 'host', id: h.id };
      paint();
      return;
    }
    if (d.bHost) { view.sel = { type: 'host', id: d.bHost }; paint(); return; }
    if (d.bSel !== undefined) { const [type, id] = d.bSel.split(':'); view.sel = type ? { type, id } : null; paint(); return; }
    if (d.bAdd === 'flow') {
      const c = clients(P)[0], s = servers(P)[0], start = view.snap * P.win;
      const f = { id: uid('f'), tool: 'iperf3', client: c?.id || '', server: s?.id || '', start, dur: Math.min(P.win * 2, T - start), rate: 20, proto: 'tcp', reverse: true, port: freePort(P), interval: 1 };
      P.flows.push(f); view.sel = { type: 'flow', id: f.id }; paint();
      return;
    }
    if (d.bAdd === 'event') {
      const c = clients(P)[0], ev = { id: uid('e'), kind: 'intent', at: Math.min(T - 5, view.snap * P.win + Math.round(P.win / 2)), svc: 'bandwidth', host: c?.id || '', mbps: 10, proto: 'udp', iface: [...ifaceMap(P).keys()][0] || '', dur: 30 };
      P.events.push(ev); view.sel = { type: 'event', id: ev.id }; paint();
      return;
    }
    if (d.fs) {
      const o = selected(P);
      if (!o) return;
      if (d.fs === 'role' && o.role !== d.v) { o.role = d.v; renameHost(P, o.id, freeName(P, d.v === 'Servidor' ? 'ds' : 'cl')); view.sel.id = o.id; }
      else if (d.fs === 'tool') { o.tool = d.v; if (d.v !== 'ping' && !servers(P).some(h => h.id === o.server)) o.server = servers(P)[0]?.id || ''; }
      else o[d.fs] = d.fs === 'reverse' ? d.v === '1' : d.v;
      paint();
      return;
    }
    if (d.bDel !== undefined) { delSelected(P); return; }
    if (d.bDup !== undefined) {
      const o = selected(P);
      if (!o) return;
      const c = { ...o, id: uid('f'), start: clamp(o.start + o.dur, 0, T - 5), port: o.tool === 'iperf3' ? freePort(P) : o.port };
      c.dur = clamp(o.dur, 5, T - c.start);
      P.flows.push(c); view.sel = { type: 'flow', id: c.id }; paint();
      return;
    }
    if (d.bAuto !== undefined) { P.auto = !P.auto; paint(); return; }
    if (d.bTool) {
      const cur = P.snapshots[view.snap];
      if (d.bTool === 'copy') P.snapshots = P.snapshots.map(() => ({ ...cur }));
      if (d.bTool === 'even') P.snapshots = P.snapshots.map((s, i) => (i % 2 ? { ...cur } : {}));
      if (d.bTool === 'clear') P.snapshots[view.snap] = {};
      paint(); return;
    }
    if (d.xlink) {
      if ((view.mode || 'links') !== 'links') return;
      const s = P.snapshots[view.snap], order = ['ok', 'warn', 'down'];
      const next = order[(order.indexOf(s[d.xlink] || 'ok') + 1) % 3];
      if (next === 'ok') delete s[d.xlink]; else s[d.xlink] = next;
      paint();
      root.querySelector(`[data-xlink="${d.xlink}"]`)?.animate?.([{ opacity: .4 }, { opacity: 1 }], { duration: 300 });
      return;
    }
    if (d.bSave !== undefined || d.bRun !== undefined) {
      const bad = P.flows.filter(f => !hostOf(P, f.client) || !hostOf(P, f.server)).length;
      if (bad) { R.toast(`${bad} fluxo${bad > 1 ? 's' : ''} sem cliente ou servidor. Escolha os hosts ou remova o fluxo.`); return; }
      if (view.idx !== undefined) customs[view.idx] = P; else { customs.unshift(P); view.idx = 0; }
      store('rein-custom-exp', customs.slice(0, 12));
      if (d.bRun !== undefined) startRun(planSpec(P));
      else R.notify({ source: 'Plano salvo', text: `${P.name}: ${P.snapshots.length} snapshots, ${P.flows.length} fluxos, ${P.hosts.length} hosts novos.`, tone: 'ok' });
      return;
    }
    if (d.bPy !== undefined) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([planPy(P)], { type: 'text/x-python' }));
      a.download = `${P.name}.py`; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }
  });
  root.addEventListener('change', e => {
    const t = e.target;
    if (t.dataset.c) { view.cfg[t.dataset.c] = t.type === 'number' ? +t.value : t.value; if (t.dataset.c !== 'name') paint(); return; }
    if (view.name !== 'builder') return;
    const P = view.plan, T = total(P);
    if (t.dataset.b && t.dataset.b !== 'name') {
      const k = t.dataset.b;
      if (k === 'count') { const n = clamp(+t.value || 1, 1, 48); P.snapshots = Array.from({ length: n }, (_, i) => P.snapshots[i] || {}); view.snap = Math.min(view.snap, n - 1); }
      else if (k === 'win') P.win = clamp(+t.value || 60, 10, 3600);
      else P[k] = t.value;
      if (k === 'count' || k === 'win') fitTimes(P, T);
      paint();
      return;
    }
    if (t.dataset.d) { const k = t.dataset.d, v = +t.value; P.degrade[k] = k === 'rate' ? clamp(v || .1, .01, 1) : k === 'delay' ? clamp(v || 1, 1, 100) : clamp(v || 0, 0, 100); paint(); return; }
    if (t.dataset.f) {
      const o = selected(P), k = t.dataset.f;
      if (!o) return;
      const v = t.type === 'number' ? +t.value : t.value.trim();
      if (k === 'id') {
        const id = v.toLowerCase();
        if (id !== o.id && (!/^(cl|ds)\d+$/.test(id) || R.node(id) || P.hosts.some(h => h.id === id))) R.toast('Nome inválido ou em uso: cl ou ds seguido de um número.');
        else { renameHost(P, o.id, id); view.sel.id = id; }
      } else if (k === 'ip') {
        if (/^192\.168\.0\.([1-9]|[1-9]\d|1\d\d|2[0-4]\d|25[0-4])$/.test(v) && !allHosts(P).some(h => h !== o && h.ip === v)) o.ip = v;
        else R.toast('Endereço inválido ou em uso na rede 192.168.0.0/24.');
      } else if (k === 'sw') {
        const old = `${o.sw}${o.id}`;
        o.sw = v;
        P.events.forEach(ev => { if (ev.iface === old) ev.iface = `${o.sw}${o.id}`; });
      } else if (k === 'start') o.start = clamp(Math.round(v) || 0, 0, T - 5);
      else if (k === 'dur') o.dur = clamp(Math.round(v) || 5, 5, view.sel.type === 'flow' ? T - o.start : T);
      else if (k === 'at') o.at = clamp(Math.round(v) || 0, 0, T - 5);
      else if (k === 'port') o.port = clamp(Math.round(v) || 5201, 1024, 65535);
      else if (k === 'rate' || k === 'mbps') o[k] = clamp(v || 1, 1, 10000);
      else if (k === 'interval') o.interval = clamp(v || 1, .2, 10);
      else o[k] = v;
      if (view.sel.type === 'flow' && k === 'start') o.dur = Math.min(o.dur, T - o.start);
      paint();
    }
  });
  root.addEventListener('input', e => { const t = e.target; if (t.dataset.b === 'name') view.plan.name = t.value.trim().toLowerCase().replace(/\s+/g, '-'); if (t.dataset.c === 'name') view.cfg.name = t.value.trim(); });

  // Canvas: drag from one host to another to create a flow between them
  let dragged = false;
  root.addEventListener('pointerdown', e => {
    const g = e.target.closest('.xplan-svg [data-hid]');
    if (!g || view.name !== 'builder' || (view.mode || 'links') !== 'links' || e.button !== 0) return;
    const svg = g.ownerSVGElement, from = g.dataset.hid, x0 = e.clientX, y0 = e.clientY;
    const at = ev => new DOMPoint(ev.clientX, ev.clientY).matrixTransform(svg.getScreenCTM().inverse());
    let line = null, hot = null;
    const move = ev => {
      if (!line && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
      if (!line) {
        line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('class', 'xdrag');
        line.setAttribute('x1', g.dataset.cx); line.setAttribute('y1', g.dataset.cy);
        svg.append(line); svg.classList.add('is-linking'); g.classList.add('is-from');
      }
      const p = at(ev);
      line.setAttribute('x2', p.x.toFixed(1)); line.setAttribute('y2', p.y.toFixed(1));
      const t = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.xplan-svg [data-hid]');
      if (hot !== t) { hot?.classList.remove('is-hot'); hot = t && t !== g ? t : null; hot?.classList.add('is-hot'); }
    };
    const up = () => {
      removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', up);
      if (!line) return;
      dragged = true;
      setTimeout(() => { dragged = false; }, 0);
      line.remove();
      const f = hot && flowBetween(view.plan, from, hot.dataset.hid);
      if (f) view.sel = { type: 'flow', id: f.id };
      paint();
    };
    addEventListener('pointermove', move); addEventListener('pointerup', up); addEventListener('pointercancel', up);
  });
  // Timeline: drag a flow to move it, its right edge to stretch it, an event marker to move it
  root.addEventListener('pointerdown', e => {
    const bar = e.target.closest('.xtl-bar, .xtl-ev');
    if (!bar || view.name !== 'builder' || e.button !== 0) return;
    const P = view.plan, T = total(P), isEv = bar.classList.contains('xtl-ev'), resize = !!e.target.closest('[data-grip]');
    const o = isEv ? P.events.find(x => x.id === bar.dataset.ev) : P.flows.find(x => x.id === bar.dataset.flow);
    if (!o) return;
    e.preventDefault();
    const W = bar.parentElement.getBoundingClientRect().width, x0 = e.clientX, s0 = isEv ? o.at : o.start, d0 = o.dur;
    const snap = v => Math.round(v / 5) * 5, pct = v => `${(v / T * 100).toFixed(3)}%`;
    let moved = false;
    bar.classList.add('is-drag');
    const move = ev => {
      if (!moved && Math.abs(ev.clientX - x0) < 3) return;
      moved = true;
      const dt = (ev.clientX - x0) / W * T;
      if (isEv) { o.at = clamp(snap(s0 + dt), 0, T - 5); bar.style.left = pct(o.at); bar.dataset.tip = clock(o.at); }
      else if (resize) { o.dur = clamp(snap(d0 + dt), 5, T - o.start); bar.style.width = pct(o.dur); bar.dataset.tip = `${clock(o.start)} a ${clock(o.start + o.dur)}`; }
      else { o.start = clamp(snap(s0 + dt), 0, T - o.dur); bar.style.left = pct(o.start); bar.dataset.tip = `${clock(o.start)} a ${clock(o.start + o.dur)}`; }
    };
    const up = () => {
      removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', up);
      view.sel = { type: isEv ? 'event' : 'flow', id: o.id };
      paint();
    };
    addEventListener('pointermove', move); addEventListener('pointerup', up); addEventListener('pointercancel', up);
  });
  root.addEventListener('keydown', e => {
    const bar = e.target.closest?.('.xtl-bar, .xtl-ev');
    if (!bar || view.name !== 'builder' || !['ArrowLeft', 'ArrowRight', 'Enter', ' '].includes(e.key)) return;
    e.preventDefault();
    const P = view.plan, T = total(P), isEv = bar.classList.contains('xtl-ev'), step = e.key === 'ArrowLeft' ? -5 : e.key === 'ArrowRight' ? 5 : 0;
    const o = isEv ? P.events.find(x => x.id === bar.dataset.ev) : P.flows.find(x => x.id === bar.dataset.flow);
    if (!o) return;
    if (isEv) o.at = clamp(o.at + step, 0, T - 5);
    else if (e.shiftKey) o.dur = clamp(o.dur + step, 5, T - o.start);
    else o.start = clamp(o.start + step, 0, T - o.dur);
    view.sel = { type: isEv ? 'event' : 'flow', id: o.id };
    paint();
    root.querySelector(isEv ? `[data-ev="${o.id}"]` : `[data-flow="${o.id}"]`)?.focus();
  });
  // Shortcuts while editing a plan: undo, redo, delete the selection, Esc to back out
  document.addEventListener('keydown', e => {
    if (view.name !== 'builder' || R.page !== 'experimentos' || e.defaultPrevented) return;
    const typing = e.target.closest?.('input, textarea, select, [contenteditable="true"]');
    const mod = e.metaKey || e.ctrlKey;
    if (mod && !typing && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(e.shiftKey ? 1 : -1); return; }
    if (mod && !typing && e.key.toLowerCase() === 'y') { e.preventDefault(); undo(1); return; }
    if (typing || document.querySelector('dialog[open], .pop.is-open')) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && view.sel && view.sel.type !== 'base') { e.preventDefault(); delSelected(view.plan); return; }
    if (e.key === 'Escape') {
      if (view.play) { stopPlay(); paint(); }
      else if ((view.mode || 'links') !== 'links') { view.mode = 'links'; paint(); }
      else if (view.sel) { view.sel = null; paint(); }
    }
  });
  R.on((type, d) => { if (type === 'page' && d.page === 'experimentos') { if (run?.on && view.name !== 'run') view = { name: 'run' }; paint(); } });
})();

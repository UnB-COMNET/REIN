/* Operations on the emulated network. LFT runs every node as a Docker container joined by veth
   pairs, OVS bridges on the switches and tc qdiscs on each interface; this module keeps the
   console's picture of that: jobs that take time (with the commands they run), traffic sessions
   with the tools' own output, interface names and the commands to watch them. */
(() => {
  'use strict';
  const R = window.REIN, M = R.model;
  const esc = R.esc;
  const pad = n => String(n).padStart(2, '0');
  const stamp = (d = new Date()) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

  // ---------------------------------------------------------------- environment
  R.env = {
    testbed: 'cdn-qoe',
    onos: { rest: `http://${location.hostname}:8181/onos/v1`, gui: `http://${location.hostname}:8181/onos/ui/#/topo2`, controller: 'tcp:172.17.0.2:6653', karaf: 'ssh -p 8101 karaf@localhost' },
    ovsImage: 'alexandremitsurukaihara/lst2.0:openvswitch',
    iperfImage: 'lft-iperf:latest',
    results: 'results',
  };

  // ---------------------------------------------------------------- interfaces (veth pairs)
  // LFT names each end after the two nodes it joins: s0s1 lives in s0 and pairs with s1s0 in s1;
  // a host's end is cl0s3, its switch's end s3cl0.
  const hash = s => [...s].reduce((h, c) => (h * 33 + c.charCodeAt(0)) >>> 0, 5381);
  const mac = name => { const h = hash(name); return `02:${[h >>> 24, h >>> 16, h >>> 8, h].map(v => (v & 255).toString(16).padStart(2, '0')).join(':')}:${(hash(name + '*') & 255).toString(16).padStart(2, '0')}`; };
  R.ifaces = id => {
    const n = R.node(id);
    if (!n) return [];
    if (n.kind === 'host') return R.node(n.sw) ? [{ name: `${n.id}${n.sw}`, node: n.id, peer: `${n.sw}${n.id}`, peerNode: n.sw, ip: `${n.ip}/24`, mac: mac(`${n.id}${n.sw}`), access: true }] : [];
    const out = M.links.filter(l => l.a === id || l.b === id).map(l => { const o = l.a === id ? l.b : l.a; return { name: `${id}${o}`, node: id, peer: `${o}${id}`, peerNode: o, link: l.id, mac: mac(`${id}${o}`) }; });
    R.hosts().filter(h => h.sw === id).forEach(h => out.push({ name: `${id}${h.id}`, node: id, peer: `${h.id}${id}`, peerNode: h.id, mac: mac(`${id}${h.id}`), access: true }));
    return out;
  };
  R.iface = name => M.nodes.flatMap(n => R.ifaces(n.id)).find(i => i.name === name);
  R.ifaceCmds = (i, filterIp = '') => {
    const f = filterIp ? ` host ${filterIp}` : '';
    return {
      tcpdump: `sudo ip netns exec ${i.node} tcpdump -i ${i.name} -nn -U${f ? ` '${f.trim()}'` : ''}`,
      pcap: `sudo docker exec ${i.node} tcpdump -Z root -i ${i.name} -nn -U -s 0 -w - | wireshark -k -i -`,
      tshark: `sudo ip netns exec ${i.node} tshark -i ${i.name} -f 'ip${f}' -T fields -e frame.time_relative -e ip.src -e ip.dst -e frame.len`,
      tc: `sudo ip netns exec ${i.node} tc -s qdisc show dev ${i.name}`,
      ip: `sudo ip netns exec ${i.node} ip -s link show ${i.name}`,
    };
  };
  // What tc applies on this interface, as LFT's setInterfaceProperties writes it
  R.ifaceQdisc = i => {
    const l = i.link ? R.link(i.link) : null;
    if (!l) return L`no shaping (access)`;
    if (l.now.down) return L`link taken down: ip link set down`;
    return `tbf rate ${R.rateStr(l.now.rate)} · netem delay ${R.fmt(l.now.delay)}ms ${R.fmt(l.now.jitter || 0)}ms${l.now.loss ? ` loss ${R.fmt(l.now.loss)}%` : ''}`;
  };

  // ---------------------------------------------------------------- CLI for nodes
  R.nodeCli = id => {
    const n = R.node(id);
    if (!n) return [];
    if (n.kind === 'switch') return [
      [L`Switch shell`, `sudo docker exec -it ${n.id} bash`],
      [L`Bridge and ports`, `sudo docker exec ${n.id} ovs-vsctl show`],
      [L`OpenFlow flows`, `sudo docker exec ${n.id} ovs-ofctl -O OpenFlow13 dump-flows ${n.id}`],
      [L`Port counters`, `sudo docker exec ${n.id} ovs-ofctl -O OpenFlow13 dump-ports ${n.id}`],
      [L`Controller`, `sudo docker exec ${n.id} ovs-vsctl get-controller ${n.id}`],
      [L`In ONOS`, `curl -u onos:rocks ${R.env.onos.rest}/devices/${encodeURIComponent(n.dpid)}`],
    ];
    const server = n.role === 'Server';
    const peer = server ? R.hosts().find(h => h.role === 'Client') : R.hosts().find(h => h.role === 'Server');
    const rows = [
      [L`Host shell`, `sudo docker exec -it ${n.id} bash`],
      [L`Addresses and routes`, `sudo ip netns exec ${n.id} ip -br addr; sudo ip netns exec ${n.id} ip route`],
      ['Ping', `sudo docker exec ${n.id} ping -c 4 ${peer?.ip || '192.168.0.1'}`],
    ];
    if (server) rows.push([L`iperf3 server`, `sudo docker exec -d ${n.id} bash -lc "iperf3 -s -p 5201 --idle-timeout 5 </dev/null >/tmp/iperf3-5201.log 2>&1"`], [L`Server log`, `sudo docker exec ${n.id} tail -f /tmp/iperf3-5201.log`]);
    else rows.push([L`iperf3 client`, `sudo docker exec ${n.id} iperf3 -c ${peer?.ip || '192.168.0.1'} -p 5201 -t 60 -i 1 -b 35M --fq-rate 35M --forceflush -J > results/iperf/manual/${n.id}.json`]);
    if (R.hasVideo(n)) rows.push([L`DASH client`, `sudo docker exec ${n.id} ${n.image === 'lft-pydash-client' ? 'pydash-play' : 'dash-play'} ${peer?.ip || '192.168.0.1'} 60`]);
    rows.push([L`Through LFT`, server ? `sudo lft traffic start --tool ping --client ${peer?.id || 'cl0'} --server ${n.id} --duration 30` : `sudo lft traffic start --client ${n.id} --server ${peer?.id || 'ds0'} --duration 30 --rate 35M`]);
    return rows;
  };
  R.cliList = rows => `<div class="cli">${rows.map(([t, c]) => `<div class="cli-row"><span>${esc(t)}</span><code>${esc(c)}</code><button type="button" class="ico cli-copy" data-copy-text="${esc(c)}" aria-label="${L`Copy command`}">${R.icon('i-copy')}</button></div>`).join('')}</div>`;
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-copy-text]');
    if (!b) return;
    navigator.clipboard?.writeText(b.dataset.copyText).catch(() => {});
    b.classList.add('is-done');
    setTimeout(() => b.classList.remove('is-done'), 1200);
  });

  // ---------------------------------------------------------------- jobs: work that takes time
  // Each job shows its current step and the command behind it; nodes it touches wait visibly.
  const jobs = [];
  let hud = null;
  function ensureHud() {
    if (hud) return hud;
    hud = document.createElement('section');
    hud.className = 'activity';
    hud.setAttribute('aria-live', 'polite');
    hud.setAttribute('aria-label', L`Activity`);
    document.body.append(hud);
    hud.addEventListener('click', e => { const j = e.target.closest('[data-job]'); if (j) j.classList.toggle('is-open'); });
    return hud;
  }
  function paintJob(j) {
    let el = hud.querySelector(`[data-job="${j.id}"]`);
    if (!el) { el = document.createElement('div'); el.className = 'job'; el.dataset.job = j.id; hud.prepend(el); }
    const done = j.i >= j.steps.length, cur = j.steps[Math.min(j.i, j.steps.length - 1)];
    el.classList.toggle('is-done', done);
    el.classList.toggle('is-err', !!j.error);
    el.innerHTML = `<div class="job-h"><span class="job-ic">${done ? (j.error ? R.icon('i-x') : R.icon('i-check')) : '<i class="spinner"></i>'}</span><b>${esc(j.title)}</b><em>${done ? (j.error ? L`failed` : L`done`) : `${j.i + 1}/${j.steps.length}`}</em></div>
      <p class="job-s">${esc(done ? (j.error || j.doneText || L`Done.`) : cur[0])}</p>
      <div class="job-bar"><i style="width:${(Math.min(j.i, j.steps.length) / j.steps.length * 100).toFixed(1)}%"></i></div>
      <pre class="job-log">${j.steps.slice(0, Math.min(j.i + 1, j.steps.length)).map(s => `<span>$ ${esc(s[1])}</span>`).join('\n')}</pre>`;
  }
  R.job = ({ title, steps, nodes = [], doneText = '' }) => new Promise(resolve => {
    ensureHud();
    const j = { id: `j${Date.now()}${Math.random().toString(36).slice(2, 5)}`, title, steps, i: 0, doneText };
    jobs.push(j);
    nodes.forEach(id => R.emit('provision', { id, on: true }));
    paintJob(j);
    const next = () => {
      j.i++;
      paintJob(j);
      if (j.i < steps.length) { setTimeout(next, R.reduced.matches ? 60 : steps[j.i][2] || 700); return; }
      nodes.forEach(id => R.emit('provision', { id, on: false }));
      setTimeout(() => { const el = hud.querySelector(`[data-job="${j.id}"]`); el?.classList.add('is-leaving'); setTimeout(() => el?.remove(), 400); }, 3200);
      resolve(j);
    };
    setTimeout(next, R.reduced.matches ? 60 : steps[0][2] || 700);
  });

  // ---------------------------------------------------------------- traffic sessions
  let seq = 0;
  const sessions = [];
  R.traffic = {
    sessions,
    defaults(kind) {
      const t = stamp();
      return kind === 'dash' ? `${R.env.results}/dash/manual/${t}` : `${R.env.results}/iperf/manual/${t}`;
    },
    async start(o) {
      const id = `t${++seq}`;
      const c = R.node(o.client), s = R.node(o.server);
      if (!c || !s) return null;
      const iperf = o.tool === 'iperf3';
      const file = iperf ? `${o.out}/${c.id}-${s.id}.json` : `${o.out}/${c.id}.jsonl`;
      const serverLog = iperf ? `/tmp/iperf3-${o.port}.log` : '/var/log/nginx/access.log';
      const clientCmd = iperf
        ? `sudo docker exec ${c.id} iperf3 -c ${s.ip} -p ${o.port} ${o.reverse ? '-R ' : ''}${o.proto === 'udp' ? '-u ' : ''}-t ${o.duration || 86400} -i 1 -b ${o.rate}M --fq-rate ${o.rate}M --forceflush -J > ${file}`
        : `sudo docker exec ${c.id} /usr/local/bin/dash-client -y -hostname ${s.ip} -scheme http > ${file}`;
      const serverCmd = iperf ? `sudo docker exec -d ${s.id} bash -lc "iperf3 -s -p ${o.port} --idle-timeout 5 </dev/null >${serverLog} 2>&1"` : `sudo docker exec ${s.id} nginx -t && curl -sI http://${s.ip}/manifest.mpd`;
      const sess = { id, ...o, file, serverLog, clientCmd, serverCmd, status: 'starting', t0: 0, lines: { client: [], server: [] }, rateNow: 0, bytes: 0 };
      sessions.unshift(sess);
      R.emit('traffic', { id });
      await R.job({
        title: `${iperf ? 'iperf3' : 'DASH'} ${o.reverse || !iperf ? `${s.id} → ${c.id}` : `${c.id} → ${s.id}`}`,
        nodes: [c.id, s.id],
        steps: iperf
          ? [[L`iperf3 server on ${s.id}:${o.port}`, serverCmd, 700], [L`Results directory`, `mkdir -p ${o.out}`, 300], [L`iperf3 client on ${c.id}`, clientCmd, 900]]
          : [[L`DASH manifest at ${s.id}`, serverCmd, 700], [L`Results directory`, `mkdir -p ${o.out}`, 300], [L`dash-client on ${c.id}`, clientCmd, 900]],
        doneText: L`Writing to ${file}`,
      });
      if (sess.status === 'stopped') return sess;
      sess.status = 'running'; sess.t0 = Date.now();
      const iperfHead = [`Connecting to host ${s.ip}, port ${o.port}`, o.reverse ? `Reverse mode, remote host ${s.ip} is sending` : '', `[  5] local ${c.ip} port ${43500 + seq} connected to ${s.ip} port ${o.port}`, o.proto === 'udp' ? '[ ID] Interval           Transfer     Bitrate         Total Datagrams' : '[ ID] Interval           Transfer     Bitrate         Retr  Cwnd'].filter(Boolean);
      sess.lines.client.push(...(iperf ? iperfHead : [`dash-client: negotiate http://${s.ip}/negotiate/dash`, 'dash-client: start collecting']));
      sess.lines.server.push(...(iperf ? ['-----------------------------------------------------------', `Server listening on ${o.port} (test #1)`, '-----------------------------------------------------------', `Accepted connection from ${c.ip}, port ${43499 + seq}`, `[  5] local ${s.ip} port ${o.port} connected to ${c.ip} port ${43500 + seq}`] : [`${s.ip} nginx: ready, root /usr/share/nginx/html`]));
      R.log('Testbed', L`${iperf ? 'iperf3' : 'DASH'} traffic ${c.id}↔${s.id} started. Output in ${file}.`);
      R.emit('traffic', { id });
      return sess;
    },
    stop(id) {
      const sess = sessions.find(x => x.id === id);
      if (!sess || sess.status === 'done' || sess.status === 'stopped') return;
      sess.status = 'stopped';
      const secs = sess.t0 ? (Date.now() - sess.t0) / 1000 : 0;
      if (sess.tool === 'iperf3') {
        sess.lines.client.push('- - - - - - - - - - - - - - - - - - - - - - - - -', `[  5]   0.00-${secs.toFixed(2)}  sec  ${(sess.bytes / 1048576).toFixed(1)} MBytes  ${R.fmt1(sess.bytes * 8 / 1e6 / Math.max(1, secs))} Mbits/sec                  sender`, 'iperf3: interrupt - the client has terminated', L`JSON written to ${sess.file}`);
        sess.lines.server.push('-----------------------------------------------------------', `Server listening on ${sess.port} (test #2)`, '-----------------------------------------------------------');
      } else sess.lines.client.push(L`dash-client: stopped, ${sess.lines.client.length - 2} segments, result in ${sess.file}`);
      R.log('Testbed', L`Traffic ${sess.client}↔${sess.server} stopped. Result in ${sess.file}.`);
      R.emit('traffic', { id });
    },
    // Current rate on each link from the running sessions (Mb/s)
    loadOn() {
      const load = new Map();
      sessions.forEach(x => { if (x.status !== 'running' || !x.path) return; R.pathLinks(x.path).forEach(l => load.set(l.id, (load.get(l.id) || 0) + x.rateNow)); });
      return load;
    },
  };
  // One tick per second: every running session reports an interval, like the tools do
  setInterval(() => {
    let any = false;
    sessions.forEach(x => {
      if (x.status !== 'running') return;
      any = true;
      const c = R.node(x.client), s = R.node(x.server);
      if (!c || !s) { x.status = 'stopped'; return; }
      x.path = R.hostPath(c.id, s.id);
      const pol = R.policyFor?.(c.ip, x.proto) || {};
      const cap = x.path && !R.pathBroken(x.path) && !c.paused && !s.paused ? R.pathRate(x.path) * 0.96 : 0;
      const want = x.tool === 'dash' ? 16 : x.rate;
      const t = (Date.now() - x.t0) / 1000;
      x.rateNow = pol.blocked ? 0 : Math.max(0, Math.min(want, cap, pol.cap || Infinity) * (1 + (Math.random() - .5) * .04));
      x.bytes += x.rateNow * 1e6 / 8;
      x.n = (x.n || 0) + 1;
      const a = x.n - 1, b = x.n;
      const iv = `${String(a.toFixed(2)).padStart(6)}-${b.toFixed(2).padEnd(6)}`;
      if (x.tool === 'iperf3') {
        if (pol.blocked) x.lines.client.push(L`[  5] ${iv} sec  0.00 Bytes  0.00 bits/sec    3   1.41 KBytes   (${x.proto.toUpperCase()} blocked at the client's switch)`);
        else x.lines.client.push(`[  5] ${iv} sec  ${(x.rateNow / 8).toFixed(2)} MBytes  ${x.rateNow.toFixed(1)} Mbits/sec    ${x.proto === 'udp' ? Math.round(x.rateNow * 86) : Math.random() < .08 ? 1 : 0}    ${Math.round(160 + x.rateNow * 4)} KBytes`);
        x.lines.server.push(`[  5] ${iv} sec  ${(x.rateNow / 8).toFixed(2)} MBytes  ${x.rateNow.toFixed(1)} Mbits/sec`);
      } else {
        const rung = R.ladder.find(([, br]) => br <= x.rateNow * 0.9);
        x.lines.client.push(rung ? `{"iteration": ${Math.floor(t)}, "rate": ${rung[1] * 1000}, "elapsed": ${(rung[1] * 2 / Math.max(.2, x.rateNow)).toFixed(3)}, "speed_kbps": ${Math.round(x.rateNow * 1000)}, "resolution": "${rung[0]}"}` : `{"iteration": ${Math.floor(t)}, "error": "buffer underrun, rebuffering"}`);
        x.lines.server.push(`${s.ip} - - [${new Date().toLocaleTimeString('en-GB')}] "GET /dash/${rung ? rung[0] : '240p'}/seg-${Math.floor(t)}.m4s HTTP/1.1" 200 ${Math.round((rung?.[1] || .3) * 250000)}`);
      }
      if (x.lines.client.length > 400) x.lines.client.splice(0, 100);
      if (x.lines.server.length > 400) x.lines.server.splice(0, 100);
      if (x.duration && t >= x.duration) R.traffic.stop(x.id);
    });
    if (any) R.emit('traffic', { tick: true });
  }, 1000);

  // ---------------------------------------------------------------- deployer services (what it executes)
  // From deployer/nile.py (GET /capabilities): cdn-qoe picks server and path; set bandwidth('max') and
  // block/allow protocol are rules at the target's own switch (deployer/edge.py).
  R.SERVICES = [
    { id: 'cdn-qoe', name: 'CDN-QoE', ic: 'i-play', tone: 'blue', what: L`Picks the DASH server of lowest RTT and the path of highest throughput to the client. The supervisor asks for a new path when the latency goes above the limit.`, status: 'ok' },
    { id: 'bandwidth', name: L`Bandwidth limit`, ic: 'i-bolt', tone: 'teal', what: L`An OpenFlow meter with a DROP band at the target's switch limits what reaches it. A new limit replaces the previous one.`, status: 'ok' },
    { id: 'acl', name: L`Block and allow`, ic: 'i-shield', tone: 'graphite', what: L`Drops the protocol both ways, at the target's switch: TCP, UDP, ICMP, or SSH, HTTP and HTTPS by the TCP port. Allow undoes the block.`, status: 'ok' },
  ];
  R.serviceNile = (sid, v, id) => {
    const ep = `endpoint('${v.ip}')`;
    if (sid === 'cdn-qoe') return `define intent ${id}: for ${ep} add service('${sid}')`;
    if (sid === 'bandwidth') return `define intent ${id}: for ${ep} set bandwidth('max', '${v.mbps}', 'mbps')`;
    if (sid === 'acl') return `define intent ${id}: for ${ep} ${v.action} protocol('${v.proto}')`;
    return '';
  };
})();

# Brief: REIN console API (Flask, 127.0.0.1:4180). Serves the console (../dist) and /api, a thin layer
# over the LFT CLI: it validates each request, runs `sudo lft ... --json` (argv, never a shell), streams
# the command's progress as a job (Server-Sent Events) and returns the JSON lft prints, in the console's
# model (ui_state). The REIN services keep their own HTTP APIs and are proxied under /api/profiler,
# /api/deployer and /api/supervisor. The testbed state is LFT's (/var/lib/lft); the console keeps only
# where its nodes are drawn (~/.rein-console/layout.json).
#   GET  /api/testbed[?sync=1] /api/testbed/export.py /api/ifaces[?node=] /api/stats
#   POST /api/testbed/import (body: topology .py)   POST /api/testbed/clean                -> {job}
#   GET|PUT /api/onos/fwd {active}: ONOS reactive forwarding
#   POST /api/testbed/switches {id?, uf, links: [{to, rate, delay, jitter, loss}]}     -> {job}
#   POST /api/testbed/switches/<id>/stop|start   DELETE /api/testbed/switches/<id>    -> {job}
#   PUT  /api/testbed/links/<a-b> {rate?, delay?, jitter?, loss?, down?, reset?}       -> {job}
#   POST /api/testbed/hosts {id?, role, sw, ip?, image}   PUT|DELETE /api/testbed/hosts/<id>
#   POST /api/testbed/hosts/<id>/pause|unpause                                        -> {job}
#   GET  /api/jobs/<id>   GET /api/jobs/<id>/events (SSE: step, stdout, status)
#   GET|POST /api/capture   DELETE /api/capture/<id>
#   GET|POST /api/traffic   DELETE /api/traffic/<id>   GET /api/traffic/<id>/logs (SSE)
#   GET  /api/experiments   POST /api/experiments/<runner>/run   POST /api/experiments/plan (body: timeline .py)
#   GET  /api/runs   GET /api/runs/<id>/events (SSE)   POST /api/runs/<id>/stop   GET /api/results/<path>
#   GET  /api/rein/logs/<service>[?requests=0]
#   GET  /api/models   POST /api/models/<id> (rein model: the one in use)                 -> {job}
#   GET  /api/monitor?ip=&path=&range= (the collector module's measurements, from ClickHouse)
#   *    /api/profiler/<path>  /api/deployer/<path>  /api/supervisor/<path>

import ast
import ipaddress
import itertools
import json
import os
import re
import signal
import subprocess
import threading
import time
from pathlib import Path

import requests
from flask import Flask, Response, abort, jsonify, request, send_from_directory, stream_with_context

DIST = Path(__file__).resolve().parents[1] / "dist"
HOME = Path(os.environ.get("CONSOLE_HOME", Path.home() / ".rein-console"))   # imported topologies, plans, run logs
REIN = Path(__file__).resolve().parents[2]
SUDO = [] if os.geteuid() == 0 else ["sudo", "-n"]
LFT = [*SUDO, os.environ.get("LFT_BIN", "/usr/local/bin/lft")]
REIN_CLI = [str(REIN / "rein")]   # the models are rein's: it measures the VRAM and starts the one chosen
ONOS = os.environ.get("ONOS_URL", "http://127.0.0.1:8181/onos/v1")
ONOS_AUTH = (os.environ.get("ONOSUSER", "onos"), os.environ.get("ONOSPASS", "rocks"))
CLICKHOUSE = os.environ.get("CLICKHOUSE_URL", "http://127.0.0.1:8123")   # the collector module's database
SERVICES = {"profiler": os.environ.get("PROFILER_URL", "http://127.0.0.1:5300"),
            "deployer": os.environ.get("DEPLOYER_URL", "http://127.0.0.1:5000"),
            "supervisor": os.environ.get("SUPERVISOR_URL", "http://127.0.0.1:5151")}
# Images hosts may run: the ones LFT builds locally, plus CONSOLE_IMAGES (comma separated)
IMAGES = ["lft-dash-video", "lft-dash-live", "lft-pydash-server", "lft-dash-client", "lft-pydash-client", "lft-iperf",
          "neubot/dash", "neubot/dash-client",
          *filter(None, os.environ.get("CONSOLE_IMAGES", "").split(","))]
RUNNERS = ("diamond", "rnp", "dash", "dash-load")

HOST, SWITCH, IFACE = re.compile(r"^(cl|ds)\d+$"), re.compile(r"^s\d+$"), re.compile(r"^[a-z0-9]+$")
MODEL = re.compile(r"^[\w.-]+$")
DPID = re.compile(r"^of:[0-9a-f]{16}$")
ACCESS = re.compile(r'"(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS) \S+ HTTP/[\d.]+" \d{3}')   # a request, as Flask's server logs it
SUBNET = ipaddress.ip_network("192.168.0.0/24")

app = Flask(__name__, static_folder=None)
topology_lock = threading.Lock()   # topology changes run one at a time; traffic and reads do not wait
model_lock = threading.Lock()      # and so do model changes
jobs, runs, ids = {}, {}, itertools.count(1)


# ---------------------------------------------------------------- lft

# Brief: Runs lft with --json and returns what it printed
# Return:
#   (exit code, parsed stdout or None, stderr)
def lft(*args, timeout: float = 120) -> tuple:
    out = subprocess.run([*LFT, *args, "--json"], capture_output=True, text=True, timeout=timeout)
    try:
        return out.returncode, json.loads(out.stdout), out.stderr
    except ValueError:
        return out.returncode, None, out.stderr


def lft_json(*args):
    code, data, err = lft(*args)
    if data is None:
        abort(502, (err or "lft failed").strip()[-500:])
    return (jsonify(data), 200) if code == 0 else (jsonify(data), 422)


# ---------------------------------------------------------------- jobs

class Job:
    """One or more commands of lft (or of `command`) run in the background, their progress kept as
    events for the UI: step {step, of, key, title, cmds}, stdout {line}, status {status, result, error}"""

    def __init__(self, title: str, calls: list, lock=None, command: list = None):
        self.id, self.title, self.calls, self.lock, self.command = f"j{next(ids)}", title, calls, lock, command
        self.events, self.status, self.cond = [], "queued", threading.Condition()
        jobs[self.id] = self
        threading.Thread(target=self.run, daemon=True).start()

    def emit(self, kind: str, **data) -> None:
        with self.cond:
            self.events.append((kind, data))
            self.cond.notify_all()

    def run(self) -> None:
        result, error = None, None
        with self.lock or threading.Lock():
            self.status = "running"
            command = self.command or LFT
            for args in self.calls:
                proc = subprocess.Popen([*command, *args, "--json"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                out = []
                reader = threading.Thread(target=lambda: out.append(proc.stdout.read()))
                reader.start()
                for line in proc.stderr:
                    try:
                        e = json.loads(line)
                    except ValueError:
                        e = {"out": line.rstrip("\n")}
                    if "step" in e:
                        self.emit("step", **e)
                    else:
                        self.emit("stdout", line=e.get("out", ""))
                proc.wait()
                reader.join()
                try:
                    result = json.loads(out[0] or "null")
                except ValueError:
                    result = None
                if isinstance(result, dict) and "state" in result:
                    result["state"] = ui_state(result["state"])
                if proc.returncode:
                    error = (result or {}).get("error") or f"{Path(command[-1]).name} {' '.join(args)} exited with {proc.returncode}"
                    break
        self.status = "failed" if error else "done"
        self.emit("status", status=self.status, result=result, error=error)

    # Brief: The job's events as SSE, from the first one, until it ends
    def stream(self):
        i = 0
        while True:
            with self.cond:
                while i >= len(self.events):
                    self.cond.wait(15)
                    if i >= len(self.events):
                        yield ": keep-alive\n\n"
                batch, i = self.events[i:], len(self.events)
            for kind, data in batch:
                yield sse(kind, data)
                if kind == "status":
                    return


def sse(kind: str, data) -> str:
    return f"event: {kind}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def job(title: str, *calls, lock=topology_lock, command: list = None):
    return jsonify(job=Job(title, list(calls), lock, command).id), 202


@app.route("/api/jobs/<jid>")
def get_job(jid):
    j = jobs.get(jid) or abort(404)
    return jsonify(id=j.id, title=j.title, status=j.status, events=[{"type": k, **d} for k, d in j.events])


@app.route("/api/jobs/<jid>/events")
def job_events(jid):
    j = jobs.get(jid) or abort(404)
    return Response(stream_with_context(j.stream()), mimetype="text/event-stream", headers={"Cache-Control": "no-cache"})


# ---------------------------------------------------------------- validation

def body() -> dict:
    return request.get_json(silent=True) or {}


def need(ok, message: str):
    if not ok:
        abort(400, message)


def name(value, pattern=HOST, what="host") -> str:
    need(isinstance(value, str) and pattern.match(value), f"invalid {what} name: {value!r}")
    return value


def number(value, low: float, high: float, what: str) -> str:
    try:
        v = float(value)
    except (TypeError, ValueError):
        abort(400, f"{what} must be a number")
    need(low <= v <= high, f"{what} must be between {low:g} and {high:g}")
    return f"{v:g}"


def ip(value) -> str:
    try:
        need(ipaddress.ip_address(value) in SUBNET, f"{value} is not in {SUBNET}")
    except ValueError:
        abort(400, f"invalid address {value!r}")
    return value


def image(value) -> str:
    need(value in IMAGES, f"image {value!r} is not allowed ({', '.join(IMAGES)})")
    return value


def results_path(value) -> str:
    p = Path(str(value))
    need(not p.is_absolute() and ".." not in p.parts and p.parts[:1] == ("results",), "paths must be inside results/")
    return str(p)


def shaping(b: dict) -> list:
    args = []
    for key, low, high, unit in (("rate", 0.001, 10000, ""), ("delay", 0, 10000, "ms"), ("jitter", 0, 10000, "ms"), ("loss", 0, 100, "")):
        if b.get(key) is not None:
            args += [f"--{key}", number(b[key], low, high, key) + unit]
    return args


# ---------------------------------------------------------------- testbed

LAYOUT = HOME / "layout.json"   # where the console draws each node: {id: {x, y}}


def layout() -> dict:
    return json.loads(LAYOUT.read_text()) if LAYOUT.exists() else {}


# Brief: LFT's testbed state in the console's model: a switch's UF and PoP come from its dp-desc, hosts
# get the console's role names (a ds<n> host LFT did not label serves), nodes get their saved position
# and the controller becomes onos.ip
def ui_state(state: dict) -> dict:
    where = layout()
    nodes = []
    for n in state["nodes"]:
        if n["kind"] == "switch":
            n = {**n, "uf": n["desc"], "pop": f"PoP-{n['desc']}" if n["desc"] else None}
        else:
            server = n["role"] == "server" or (n["role"] is None and n["id"].startswith("ds"))
            n = {**n, "role": "Servidor" if server else "Cliente"}
        nodes.append({**n, **where.get(n["id"], {})})
    controller = state.get("controller") or ""
    return {**state, "nodes": nodes, "onos": {"ip": controller.split(":")[1] if controller.count(":") == 2 else None}}


def lft_state() -> dict:
    code, data, err = lft("topology", "show")
    if data is None:
        abort(502, (err or "lft failed").strip()[-500:])
    return data


@app.route("/api/testbed")
def testbed():
    code, data, err = lft("topology", "sync" if request.args.get("sync") else "show")
    if data is None:
        abort(502, (err or "lft failed").strip()[-500:])
    return jsonify(ui_state(data))


# Brief: The testbed as a topology file (lft topology export), plus the console's LAYOUT
@app.route("/api/testbed/export.py")
def export_py():
    out = subprocess.run([*LFT, "topology", "export"], capture_output=True, text=True, timeout=60)
    if out.returncode:
        abort(502, out.stderr[-500:])
    where = {k: (round(v["x"]), round(v["y"])) for k, v in layout().items()}
    return Response(out.stdout + (f"LAYOUT = {where!r}\n" if where else ""), mimetype="text/x-python")


# Brief: Builds a topology file (POPS, CONFIG, HOSTS...) as the new testbed; its LAYOUT, which LFT
# ignores, becomes the console's layout
@app.route("/api/testbed/import", methods=["POST"])
def import_py():
    text = request.get_data(as_text=True)
    need("pops" in text.lower() and len(text) < 1_000_000, "expected a topology .py with POPS / CONFIG")
    stem = re.sub(r"[^a-z0-9_-]", "", request.args.get("name", "console").lower()) or "console"
    path = HOME / "imports" / f"{stem}_topology.py"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    where = {}
    for statement in ast.parse(text).body:
        if isinstance(statement, ast.Assign) and [t.id for t in statement.targets if isinstance(t, ast.Name)] == ["LAYOUT"]:
            where = {k: {"x": v[0], "y": v[1]} for k, v in ast.literal_eval(statement.value).items()}
    LAYOUT.write_text(json.dumps(where))
    return job(f"Importing {stem}", ["topology", "create", "--path", str(path), "--detach", "--disable-fwd"])


# Brief: Removes the testbed's containers, ONOS included (lft utils clean)
@app.route("/api/testbed/clean", methods=["POST"])
def clean_testbed():
    return job("Removing the testbed", ["utils", "clean"])


# Brief: ONOS reactive forwarding (org.onosproject.fwd): without it only the paths the deployer installs
# carry traffic; with it any two hosts reach each other
@app.route("/api/onos/fwd", methods=["GET", "PUT"])
def onos_fwd():
    url = f"{ONOS}/applications/org.onosproject.fwd"
    try:
        if request.method == "PUT":
            active = bool(body().get("active"))
            requests.request("POST" if active else "DELETE", f"{url}/active", auth=ONOS_AUTH, timeout=15).raise_for_status()
        state = requests.get(url, auth=ONOS_AUTH, timeout=5).json().get("state")
    except requests.RequestException as error:
        return jsonify(error="ONOS unreachable", detail=str(error)), 503
    return jsonify(active=state == "ACTIVE")


# Brief: A new switch: the next free s<n> unless given, with datapath n+1 and its UF as dp-desc (how
# the deployer finds the PoP)
@app.route("/api/testbed/switches", methods=["POST"])
def add_switch():
    b = body()
    used = {n["id"] for n in lft_state()["nodes"]}
    sid = name(b.get("id") or next(f"s{i}" for i in range(1000) if f"s{i}" not in used), SWITCH, "switch")
    uf = str(b.get("uf", "")).upper()
    need(re.fullmatch(r"[A-Z]{2}", uf), "uf must be two letters")
    args = ["switch", "add", sid, "--desc", uf, "--dpid", f"{int(sid[1:]) + 1:016x}"]
    for l in b.get("links") or []:
        opts = [f"{k}={number(l[k], 0, 10000, k)}{'mbit' if k == 'rate' else 'ms' if k in ('delay', 'jitter') else ''}"
                for k in ("rate", "delay", "jitter", "loss") if l.get(k) not in (None, "")]
        args += ["--link", ":".join([name(l.get("to"), SWITCH, "switch"), ",".join(opts)]).rstrip(":")]
    return job(f"Creating switch {sid}", args)


@app.route("/api/testbed/switches/<sid>/<action>", methods=["POST"])
def switch_power(sid, action):
    need(action in ("stop", "start"), "action is stop or start")
    return job(f"{action.capitalize()} {sid}", ["switch", action, name(sid, SWITCH, "switch")])


@app.route("/api/testbed/switches/<sid>", methods=["DELETE"])
def remove_switch(sid):
    return job(f"Removing {sid}", ["switch", "rm", name(sid, SWITCH, "switch"), "--with-hosts"])


@app.route("/api/testbed/links/<lid>", methods=["PUT"])
def put_link(lid):
    need(re.fullmatch(r"s\d+-s\d+", lid), "link ids are s<a>-s<b>")
    a, b_ = lid.split("-")
    b = body()
    if b.get("reset"):
        return job(f"Resetting {lid}", ["link", "reset", a, b_])
    calls = [["link", "set", a, b_, *shaping(b)]] if shaping(b) else []
    if b.get("down") is not None:
        calls.append(["link", "down" if b["down"] else "up", a, b_])
    need(calls, "nothing to change")
    return job(f"Link {lid}", *calls)


# Brief: A new host: a ds<n> server (runs its image) or a cl<n> client, the next free name and address
# unless given
@app.route("/api/testbed/hosts", methods=["POST"])
def add_host():
    b = body()
    current = lft_state()
    server = b.get("role") == "Servidor"
    prefix, used = ("ds" if server else "cl"), {n["id"] for n in current["nodes"]}
    taken = {n.get("ip") for n in current["nodes"]}
    hid = name(b.get("id") or next(f"{prefix}{i}" for i in range(1000) if f"{prefix}{i}" not in used))
    hip = ip(b.get("ip") or next(str(a) for a in SUBNET.hosts() if str(a) not in taken and a != SUBNET[-2]))
    args = ["host", "add", hid, "--switch", name(b.get("sw"), SWITCH, "switch"), "--ip", hip, "--image", image(b.get("image"))]
    return job(f"Creating {hid}", args + (["--server"] if server else []))


@app.route("/api/testbed/hosts/<hid>", methods=["PUT", "DELETE"])
def change_host(hid):
    name(hid)
    if request.method == "DELETE":
        return job(f"Removing {hid}", ["host", "rm", hid])
    b = body()
    args = ["host", "set", hid]
    if b.get("id") and b["id"] != hid:
        args += ["--name", name(b["id"])]
    if b.get("sw"):
        args += ["--switch", name(b["sw"], SWITCH, "switch")]
    if b.get("ip"):
        args += ["--ip", ip(b["ip"])]
    if b.get("image"):
        args += ["--image", image(b["image"])]
    return job(f"Updating {hid}", args)


@app.route("/api/testbed/hosts/<hid>/<action>", methods=["POST"])
def pause_host(hid, action):
    need(action in ("pause", "unpause"), "action is pause or unpause")
    return job(f"{action.capitalize()} {hid}", ["host", action, name(hid)])


@app.route("/api/ifaces")
def ifaces():
    return lft_json("iface", "ls", *(["--node", name(request.args["node"], re.compile(r"^(s|cl|ds)\d+$"), "node")]
                                      if request.args.get("node") else []))


_stats = {"at": 0.0, "data": None}


# Brief: Link counters and rates (lft link stats), shared by every viewer for a second
@app.route("/api/stats")
def stats():
    if time.time() - _stats["at"] > 1 or _stats["data"] is None:
        code, data, err = lft("link", "stats")
        if data is None:
            abort(502, err[-500:])
        _stats.update(at=time.time(), data=data)
    return jsonify(_stats["data"])


# ---------------------------------------------------------------- monitoring

# The collector module's metrics (collector/README.md), per `step` seconds of the last `span`.
# Throughput: what a switch port sends, in Mb/s. Latency: the sum over a path's links, both ways, in ms.
# Totals: how much each counter grew (they are cumulative), and when the last sample came
BUCKET = "toUnixTimestamp(toStartOfInterval(TimeUnix, INTERVAL {step:UInt32} SECOND))"
SINCE = "TimeUnix >= now() - INTERVAL {span:UInt32} SECOND"
THROUGHPUT = f"""SELECT {BUCKET} AS t, avg(Value) / 1e6 FROM otel_metrics_gauge
    WHERE MetricName = 'sdn.port.throughput' AND Attributes['device_id'] = {{device:String}}
    AND Attributes['port'] = {{port:String}} AND Attributes['direction'] = 'sent' AND {SINCE} GROUP BY t ORDER BY t"""
LATENCY = f"""SELECT t, sum(v) FROM (SELECT {BUCKET} AS t, avg(Value) AS v FROM otel_metrics_gauge
    WHERE MetricName = 'sdn.link.latency' AND {SINCE}
    AND (Attributes['src_device'], Attributes['dst_device']) IN {{links:Array(Tuple(String, String))}}
    GROUP BY t, Attributes['src_device'], Attributes['dst_device']) GROUP BY t ORDER BY t"""
TOTALS = f"""SELECT MetricName, sum(grown), toUnixTimestamp(max(last)) FROM (
    SELECT MetricName, max(Value) - min(Value) AS grown, max(TimeUnix) AS last FROM otel_metrics_sum
    WHERE MetricName IN ('sdn.onos.requests', 'sdn.port.drops') AND {SINCE} GROUP BY MetricName, Attributes)
    GROUP BY MetricName"""
_hosts = {"at": 0.0, "data": {}}


# Brief: One query to the collector module's database (ClickHouse, database otel)
# Params:
#   String sql: The query, its values as {name:Type}
#   params: Those values
# Return:
#   list of the rows, each a list
def clickhouse(sql: str, **params) -> list:
    r = requests.post(CLICKHOUSE, params={"database": "otel", **{f"param_{k}": v for k, v in params.items()}},
                      data=f"{sql} FORMAT JSONCompact", timeout=10)
    r.raise_for_status()
    return r.json()["data"]


# Brief: Where ONOS sees each host, by IP: (switch dpid, port). Kept for 30 s
def onos_hosts() -> dict:
    if time.time() - _hosts["at"] > 30:
        hosts = requests.get(f"{ONOS}/hosts", auth=ONOS_AUTH, timeout=5).json()["hosts"]
        _hosts.update(at=time.time(), data={address: (h["locations"][0]["elementId"], h["locations"][0]["port"])
                                             for h in hosts if h.get("locations") for address in h["ipAddresses"]})
    return _hosts["data"]


# Brief: What the collector module measured for a client: the throughput its switch sends it, the RTT of
# its path and, network wide, the collector's requests to ONOS and the packets dropped
#   GET /api/monitor?ip=<client>&path=<dpid,dpid,...>&range=<seconds>
# Return:
#   JSON {step, thr: [[unix time, Mb/s]], lat: [[unix time, ms]], requests, drops, last: unix time or None}
@app.route("/api/monitor")
def monitor():
    span = int(float(number(request.args.get("range", 900), 60, 86400, "range")))
    path = [name(d, DPID, "switch") for d in request.args.get("path", "").split(",") if d]
    client = ip(request.args["ip"]) if request.args.get("ip") else None
    links = ",".join(f"('{a}','{b}'),('{b}','{a}')" for a, b in zip(path, path[1:]))
    window = {"step": max(5, span // 180 // 5 * 5), "span": span}
    try:
        device, port = onos_hosts().get(client, (None, None))
        thr = clickhouse(THROUGHPUT, device=device, port=port, **window) if device else []
        lat = clickhouse(LATENCY, links=f"[{links}]", **window) if links else []
        totals = {metric: (grown, last) for metric, grown, last in clickhouse(TOTALS, span=span)}
    except (requests.RequestException, ValueError, KeyError) as error:
        return jsonify(error="the collector's database does not answer", detail=str(error)), 503
    return jsonify(step=window["step"], thr=thr, lat=lat, last=max((last for _, last in totals.values()), default=None),
                   requests=round(totals.get("sdn.onos.requests", (0, 0))[0]), drops=round(totals.get("sdn.port.drops", (0, 0))[0]))


# ---------------------------------------------------------------- captures and traffic

@app.route("/api/capture", methods=["GET", "POST"])
def capture():
    if request.method == "GET":
        return lft_json("capture", "ls")
    b = body()
    args = ["capture", "start", "--iface", name(b.get("iface"), IFACE, "interface"),
            "--duration", number(b.get("duration", 30), 0, 86400, "duration").split(".")[0]]
    if b.get("out"):
        args += ["--out", results_path(b["out"])]
    if b.get("filter"):
        need(re.fullmatch(r"[\w .:/()-]*", b["filter"]), "invalid filter")
        args += ["--filter", b["filter"]]
    return job(f"Capture on {b['iface']}", args, lock=None)


@app.route("/api/capture/<cid>", methods=["DELETE"])
def capture_stop(cid):
    need(re.fullmatch(r"c\d+", cid), "invalid capture id")
    return lft_json("capture", "stop", cid)


@app.route("/api/traffic", methods=["GET", "POST"])
def traffic():
    if request.method == "GET":
        return lft_json("traffic", "ls")
    b = body()
    need(b.get("tool") in ("iperf3", "dash", "ping"), "tool is iperf3, dash or ping")
    args = ["traffic", "start", "--tool", b["tool"], "--client", name(b.get("client")), "--server", name(b.get("server")),
            "--port", number(b.get("port", 5201), 1024, 65535, "port").split(".")[0], "--proto", "udp" if b.get("proto") == "udp" else "tcp",
            "--rate", number(b.get("rate", 35), 0.001, 10000, "rate"), "--duration", number(b.get("duration", 0), 0, 86400, "duration").split(".")[0]]
    if b.get("reverse"):
        args.append("--reverse")
    if b.get("out"):
        args += ["--out", results_path(b["out"])]
    return job(f"{b['tool']} {b['client']} - {b['server']}", args, lock=None)


@app.route("/api/traffic/<tid>", methods=["DELETE"])
def traffic_stop(tid):
    need(re.fullmatch(r"t\d+", tid), "invalid session id")
    return lft_json("traffic", "stop", tid)


# Brief: The session's client and server output as SSE ({side, line}), until it ends
@app.route("/api/traffic/<tid>/logs")
def traffic_logs(tid):
    need(re.fullmatch(r"t\d+", tid), "invalid session id")
    proc = subprocess.Popen([*LFT, "traffic", "logs", tid, "--follow", "--json"], stdout=subprocess.PIPE, text=True)

    def gen():
        try:
            for line in proc.stdout:
                yield f"event: line\ndata: {line.strip()}\n\n"
            yield sse("end", {"status": proc.wait()})
        finally:
            proc.kill()
    return Response(stream_with_context(gen()), mimetype="text/event-stream", headers={"Cache-Control": "no-cache"})


# ---------------------------------------------------------------- experiments and runs

@app.route("/api/experiments")
def experiments():
    return lft_json("experiment")


class Run:
    """A run started from the console (`lft experiment ...` or `lft timeline run ...`) in the background,
    its output in a log file; its results directory is the one it creates under results/ (found by its
    start time)"""

    def __init__(self, args: list, title: str):
        self.id, self.title, self.args, self.t0, self.dir = f"r{next(ids)}", title, args, time.time(), None
        self.log = HOME / "runs" / f"{self.id}.log"
        self.log.parent.mkdir(parents=True, exist_ok=True)
        with open(self.log, "w") as out:
            self.proc = subprocess.Popen([*LFT, *args], stdout=out, stderr=subprocess.STDOUT,
                                         stdin=subprocess.DEVNULL, start_new_session=True)
        runs[self.id] = self

    def results(self):
        if self.dir is None:
            code, rows, _ = lft("results", "ls")
            self.dir = next((r["dir"] for r in reversed(rows or []) if r["started"] >= self.t0 - 2), None)
        return self.dir

    def info(self) -> dict:
        code = self.proc.poll()
        return {"id": self.id, "title": self.title, "args": self.args, "started": self.t0, "dir": self.results(),
                "status": "running" if code is None else "done" if code == 0 else f"exited {code}"}


@app.route("/api/experiments/<runner>/run", methods=["POST"])
def run_experiment(runner):
    need(runner in RUNNERS, f"runner is one of {', '.join(RUNNERS)}")
    need(not any(r.proc.poll() is None for r in runs.values()), "an experiment is already running")
    b, args = body(), ["experiment", runner]
    if runner in ("diamond", "rnp"):
        need(re.fullmatch(r"[\w-]+", str(b.get("mode", ""))), "mode is required")
        args += ["--mode", b["mode"], "--run-name", re.sub(r"[^\w-]", "", b.get("run_name") or f"console-{time.strftime('%Y%m%d-%H%M%S')}"),
                 "--auto-start" if b.get("auto_start") else "--no-auto-start"]
        if runner == "diamond":
            need(b.get("hindering") in ("degrade", "take down"), "hindering is degrade or take down")
            args += ["--hindering", b["hindering"]]
        else:
            args += ["--seed", number(b.get("seed", 1), 0, 1e9, "seed").split(".")[0]]
    else:
        args += ["--yes", *(["--duration", number(b["duration"], 1, 86400, "duration").split(".")[0]] if b.get("duration") else []),
                 *(["--clients", number(b["clients"], 1, 1000, "clients").split(".")[0]] if b.get("clients") and runner == "dash-load" else [])]
    return jsonify(run=Run(args, runner).id), 202


# Brief: Runs a plan made in Experimentos as an LFT timeline. AUTO_START = True, which LFT ignores,
# asks for the REIN services: they start before the warm-up and stop at the end
@app.route("/api/experiments/plan", methods=["POST"])
def run_plan():
    text = request.get_data(as_text=True)
    m = re.search(r'^NAME\s*=\s*"([\w-]+)"', text, re.M)
    need(m and "WINDOWS" in text, "expected a timeline .py with NAME and WINDOWS")
    need(not any(r.proc.poll() is None for r in runs.values()), "an experiment is already running")
    if re.search(r"^AUTO_START\s*=\s*True", text, re.M):
        compose = f"docker compose -f {REIN / 'docker-compose.yml'}"
        ready = " && ".join(f"curl -sf -o /dev/null {url}" for url in (SERVICES["deployer"] + "/", SERVICES["supervisor"] + "/metrics"))
        text += (f"\nBEFORE = [{compose + ' up -d --build'!r}, "
                 f"{'for i in $(seq 90); do ' + ready + ' && exit 0; sleep 2; done; exit 1'!r}]\n"
                 f"AFTER = [{compose + ' down'!r}]\n")
    path = HOME / "plans" / f"{m.group(1)}.py"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    return jsonify(run=Run(["timeline", "run", str(path)], m.group(1)).id), 202


@app.route("/api/runs")
def list_runs():
    code, rows, _ = lft("results", "ls")
    return jsonify(active=[r.info() for r in runs.values()], results=rows or [])


def run_dir(rid: str):
    if rid in runs:
        return runs[rid].results()
    need(re.fullmatch(r"[\w-]+/[\w.-]+", rid), "invalid run id")
    code, rows, _ = lft("results", "ls")
    return next((r["dir"] for r in rows or [] if r["id"] == rid), None) or abort(404)


# Brief: The run's events.jsonl as SSE (event name = its type), then "exit" when its process ends
@app.route("/api/runs/<path:rid>/events")
def run_events(rid):
    active = runs.get(rid)

    def gen():
        sent, deadline = 0, time.time() + 120
        while True:
            directory = run_dir(rid) if active is None or active.results() else None
            path = Path(directory) / "events.jsonl" if directory else None
            if path and path.exists():
                lines = path.read_text().splitlines()
                for line in lines[sent:]:
                    yield f"event: {json.loads(line).get('type', 'log')}\ndata: {line}\n\n"
                sent = len(lines)
            if active is None or active.proc.poll() is not None:
                if active is not None:
                    yield sse("exit", active.info())
                return
            if not path and time.time() > deadline:
                yield sse("exit", {"error": "the run did not create its results directory"})
                return
            yield ": keep-alive\n\n"
            time.sleep(1)
    return Response(stream_with_context(gen()), mimetype="text/event-stream", headers={"Cache-Control": "no-cache"})


# Brief: Stops a run with SIGINT (to sudo, which relays it to lft): the runner cleans up and keeps what
# it measured
@app.route("/api/runs/<rid>/stop", methods=["POST"])
def stop_run(rid):
    r = runs.get(rid) or abort(404)
    if r.proc.poll() is None:
        r.proc.send_signal(signal.SIGINT)
    return jsonify(r.info())


@app.route("/api/runs/<rid>/log")
def run_log(rid):
    r = runs.get(rid) or abort(404)
    return Response(r.log.read_text(errors="replace")[-200_000:], mimetype="text/plain")


@app.route("/api/results/<path:path>")
def results_file(path):
    root = Path(os.environ.get("LFT_RESULTS_ROOT", REIN.parent / "lft" / "results"))   # LFT cloned next to REIN
    need(".." not in Path(path).parts, "invalid path")
    return send_from_directory(root, path)


# ---------------------------------------------------------------- REIN services

# Brief: The last 200 lines a REIN service printed (docker logs), without terminal colors. ?requests=0
# leaves out the requests it answered, which the polling between the services fills the log with
@app.route("/api/rein/logs/<service>")
def rein_logs(service):
    need(service in SERVICES, f"service is one of {', '.join(SERVICES)}")
    quiet = request.args.get("requests") == "0"
    out = subprocess.run([*SUDO, "docker", "logs", "--timestamps", "--tail", "5000" if quiet else "200", service],
                         capture_output=True, text=True, timeout=10)
    rows = []
    for line in (out.stdout + out.stderr).splitlines():
        ts, _, text = line.partition(" ")
        text = re.sub(r"\x1b\[[0-9;]*m", "", text).strip()
        if text and not (quiet and ACCESS.search(text)):
            rows.append({"ts": ts, "text": text})
    return jsonify(sorted(rows, key=lambda r: r["ts"])[-200:])


# Brief: The models that translate the requests, which of them fit this machine's VRAM and the one in
# use ("chosen"), as `rein model --json` tells them
@app.route("/api/models")
def models():
    out = subprocess.run([*REIN_CLI, "model", "--json"], capture_output=True, text=True, timeout=30)
    try:
        return jsonify(json.loads(out.stdout)), 200 if out.returncode == 0 else 503
    except ValueError:
        abort(502, (out.stderr or "rein model failed").strip()[-500:])


# Brief: Puts a model in use (rein model <id>): one that runs on this machine is started, the others stopped
@app.route("/api/models/<mid>", methods=["POST"])
def use_model(mid):
    return job(f"Model {mid}", ["model", name(mid, MODEL, "model")], lock=model_lock, command=REIN_CLI)


@app.route("/api/<service>/<path:path>", methods=["GET", "POST", "PUT", "DELETE"])
def proxy(service, path):
    if service not in SERVICES:
        abort(404)
    try:
        r = requests.request(request.method, f"{SERVICES[service]}/{path}", params=request.args, data=request.get_data(),
                             headers={k: v for k, v in request.headers if k.lower() in ("content-type", "accept", "last-event-id")},
                             stream=True, timeout=(5, 600))
    except requests.RequestException as error:
        return jsonify(error=f"{service} unreachable", detail=str(error)), 503
    headers = {"Cache-Control": "no-cache"} if "event-stream" in r.headers.get("content-type", "") else {}
    return Response(stream_with_context(r.iter_content(chunk_size=None)), r.status_code,
                    content_type=r.headers.get("content-type"), headers=headers)


@app.errorhandler(400)
@app.errorhandler(404)
@app.errorhandler(422)
@app.errorhandler(502)
def error(e):
    return jsonify(error=getattr(e, "description", str(e))), e.code


# ---------------------------------------------------------------- the console

@app.route("/")
def index():
    return send_from_directory(DIST, "index.html")


@app.route("/<path:path>")
def static_files(path):
    return send_from_directory(DIST, path)


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", 4180)), threaded=True)

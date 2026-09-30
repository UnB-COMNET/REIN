# Brief: REIN console API (Flask, 127.0.0.1:4180). Serves the console (../dist) and /api, a thin layer
# over the LFT CLI: it validates each request, runs `sudo lft ... --json` (argv, never a shell), streams
# the command's progress as a job (Server-Sent Events) and returns the JSON lft prints. The REIN
# services keep their own HTTP APIs and are proxied under /api/profiler, /api/deployer and
# /api/supervisor. Nothing here keeps testbed state: lft does (/var/lib/lft).
#   GET  /api/testbed[?sync=1] /api/status /api/testbed/export.py /api/ifaces[?node=] /api/stats /api/images
#   POST /api/testbed/import (body: topology .py)                                    -> {job}
#   POST /api/testbed/switches {id?, uf, links: [{to, rate, delay, jitter, loss}]}     -> {job}
#   POST /api/testbed/switches/<id>/stop|start   DELETE /api/testbed/switches/<id>    -> {job}
#   PUT  /api/testbed/links/<a-b> {rate?, delay?, jitter?, loss?, down?, reset?}       -> {job}
#   POST /api/testbed/hosts {id?, role, sw, ip?, image}   PUT|DELETE /api/testbed/hosts/<id>
#   POST /api/testbed/hosts/<id>/pause|unpause                                        -> {job}
#   GET  /api/jobs/<id>   GET /api/jobs/<id>/events (SSE: step, stdout, status)
#   GET|POST /api/capture   DELETE /api/capture/<id>
#   GET|POST /api/traffic   DELETE /api/traffic/<id>   GET /api/traffic/<id>/logs (SSE)
#   GET  /api/experiments   POST /api/experiments/<runner>/run   POST /api/experiments/plan (body: plan .py)
#   GET  /api/runs   GET /api/runs/<id>/events (SSE)   POST /api/runs/<id>/stop   GET /api/results/<path>
#   GET  /api/rein/logs/<service>
#   *    /api/profiler/<path>  /api/deployer/<path>  /api/supervisor/<path>

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
LFT = [*([] if os.geteuid() == 0 else ["sudo", "-n"]), os.environ.get("LFT_BIN", "/usr/local/bin/lft")]
SERVICES = {"profiler": os.environ.get("PROFILER_URL", "http://127.0.0.1:5300"),
            "deployer": os.environ.get("DEPLOYER_URL", "http://127.0.0.1:5000"),
            "supervisor": os.environ.get("SUPERVISOR_URL", "http://127.0.0.1:5151")}
# Images hosts may run: the ones the LFT and REIN build locally, plus CONSOLE_IMAGES (comma separated)
IMAGES = ["rein-dash-video", "rein-dash-client", "lft-iperf", "neubot/dash", "neubot/dash-client",
          *filter(None, os.environ.get("CONSOLE_IMAGES", "").split(","))]
RUNNERS = ("diamond", "rnp", "dash", "dash-load")

HOST, SWITCH, IFACE = re.compile(r"^(cl|ds)\d+$"), re.compile(r"^s\d+$"), re.compile(r"^[a-z0-9]+$")
SUBNET = ipaddress.ip_network("192.168.0.0/24")

app = Flask(__name__, static_folder=None)
topology_lock = threading.Lock()   # topology changes run one at a time; traffic and reads do not wait
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
    """One or more lft commands run in the background, their progress kept as events for the UI:
    step {step, of, key, title, cmds}, stdout {line}, status {status, result, error}"""

    def __init__(self, title: str, calls: list, lock=None):
        self.id, self.title, self.calls, self.lock = f"j{next(ids)}", title, calls, lock
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
            for args in self.calls:
                proc = subprocess.Popen([*LFT, *args, "--json"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
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
                if proc.returncode:
                    error = (result or {}).get("error") or f"lft {' '.join(args)} exited with {proc.returncode}"
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


def job(title: str, *calls, lock=topology_lock):
    return jsonify(job=Job(title, list(calls), lock).id), 202


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

@app.route("/api/testbed")
def testbed():
    return lft_json("testbed", "sync" if request.args.get("sync") else "show")


@app.route("/api/status")
def status():
    return lft_json("testbed", "status")


@app.route("/api/testbed/export.py")
def export_py():
    code, data, err = lft("topology", "export")
    return Response((data or {}).get("py", ""), mimetype="text/x-python") if code == 0 else abort(502, err)


@app.route("/api/testbed/import", methods=["POST"])
def import_py():
    text = request.get_data(as_text=True)
    need("pops" in text.lower() and len(text) < 1_000_000, "expected a topology .py with POPS / CONFIG")
    stem = re.sub(r"[^a-z0-9_-]", "", request.args.get("name", "console").lower()) or "console"
    path = HOME / "imports" / f"{stem}_topology.py"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    return job(f"Importing {stem}", ["topology", "create", "--path", str(path), "--detach", "--disable-fwd"])


@app.route("/api/testbed/switches", methods=["POST"])
def add_switch():
    b = body()
    args = ["switch", "add", *([name(b["id"], SWITCH, "switch")] if b.get("id") else [])]
    uf = str(b.get("uf", "")).upper()
    need(re.fullmatch(r"[A-Z]{2}", uf), "uf must be two letters")
    args += ["--uf", uf]
    for l in b.get("links") or []:
        opts = [f"{k}={number(l[k], 0, 10000, k)}{'mbit' if k == 'rate' else 'ms' if k in ('delay', 'jitter') else ''}"
                for k in ("rate", "delay", "jitter", "loss") if l.get(k) not in (None, "")]
        args += ["--link", ":".join([name(l.get("to"), SWITCH, "switch"), ",".join(opts)]).rstrip(":")]
    return job(f"Creating switch {b.get('id') or uf}", args)


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


@app.route("/api/testbed/hosts", methods=["POST"])
def add_host():
    b = body()
    args = ["host", "add", *([name(b["id"])] if b.get("id") else []), "--switch", name(b.get("sw"), SWITCH, "switch"),
            "--image", image(b.get("image")), *(["--ip", ip(b["ip"])] if b.get("ip") else [])]
    if b.get("role") == "Servidor":
        args.append("--server")
    return job(f"Creating {b.get('id') or 'host'}", args)


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


# Brief: The images a host may use, and whether each one is already on the VM (the others need a pull)
@app.route("/api/images")
def images():
    code, data, err = lft("testbed", "status")
    local = set((data or {}).get("images", []))
    return jsonify([{"image": i, "local": i in local} for i in IMAGES])


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
    """An experiment runner started from the console: `lft experiment ...` in the background, its output
    in a log file; its results directory is the one it creates under results/ (found by its start time)"""

    def __init__(self, args: list, title: str):
        self.id, self.title, self.args, self.t0, self.dir = f"r{next(ids)}", title, args, time.time(), None
        self.log = HOME / "runs" / f"{self.id}.log"
        self.log.parent.mkdir(parents=True, exist_ok=True)
        with open(self.log, "w") as out:
            self.proc = subprocess.Popen([*LFT, "experiment", *args], stdout=out, stderr=subprocess.STDOUT,
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
    b, args = body(), [runner]
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


@app.route("/api/experiments/plan", methods=["POST"])
def run_plan():
    text = request.get_data(as_text=True)
    m = re.search(r'^RUN_NAME\s*=\s*"([\w-]+)"', text, re.M)
    need(m and "SNAPSHOTS" in text, "expected a plan .py with RUN_NAME and SNAPSHOTS")
    need(not any(r.proc.poll() is None for r in runs.values()), "an experiment is already running")
    path = HOME / "plans" / f"{m.group(1)}.py"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    return jsonify(run=Run(["plan", "--path", str(path)], m.group(1)).id), 202


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
    root = Path(os.environ.get("LFT_RESULTS_ROOT", "/home/artdelpi/lft/results"))
    need(".." not in Path(path).parts, "invalid path")
    return send_from_directory(root, path)


# ---------------------------------------------------------------- REIN services

@app.route("/api/rein/logs/<service>")
def rein_logs(service):
    need(service in SERVICES, f"service is one of {', '.join(SERVICES)}")
    return lft_json("rein", "logs", service, "--tail", "200")



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

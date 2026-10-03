# Run: cd REIN/console/api && python3 -m pytest -q test_app.py
import json
import sys
import textwrap

import pytest

import app as api

# Stands in for `sudo lft`: `topology show` and `sync` print LFT's state; any other command prints one step on stderr
# (as lft --json does) and its result, with the args it got, on stdout
FAKE_LFT = textwrap.dedent('''
    import json, sys
    args = sys.argv[1:-1]
    state = {"name": "t", "controller": "tcp:172.17.0.2:6653", "defaults": {}, "links": [], "updated": 0, "nodes": [
        {"id": "s0", "kind": "switch", "dpid": "of:0000000000000001", "desc": "SP", "off": False},
        {"id": "s1", "kind": "switch", "dpid": "of:0000000000000002", "desc": None, "off": False},
        {"id": "ds0", "kind": "host", "role": None, "sw": "s0", "ip": "192.168.0.1", "image": "lft-dash-video"},
        {"id": "cl0", "kind": "host", "role": "client", "sw": "s1", "ip": "192.168.0.2", "image": "lft-dash-client"}]}
    if args[:2] in (["topology", "show"], ["topology", "sync"]):
        print(json.dumps(state))
        sys.exit(0)
    print(json.dumps({"step": 1, "of": 1, "title": "Shaping s0s1 in s0"}), file=sys.stderr)
    print("plain output", file=sys.stderr)
    ok = "fail" not in args
    print(json.dumps({"ok": ok, "args": args, "state": state} if ok else {"ok": False, "error": "boom"}))
    sys.exit(0 if ok else 1)
''')


# Stands in for `rein model [ID] --json`: the models on stdout, what it does on stderr; llama does not fit
FAKE_REIN = textwrap.dedent('''
    import json, sys
    chosen = sys.argv[2] if len(sys.argv) > 3 else "qwen3.6"
    if chosen == "llama":
        print(json.dumps({"ok": False, "error": "llama cannot be used on this machine: needs 4 GB, 3 GB free"}))
        sys.exit(1)
    if len(sys.argv) > 3:
        print(f"starting {chosen}", file=sys.stderr)
    print(json.dumps({"gpu": {"total_gb": 4, "free_gb": 3}, "selected": "qwen3.6", "chosen": chosen,
                      "models": [{"id": "qwen3.6", "fits": True}, {"id": "llama", "fits": False}, {"id": "lite", "fits": True}]}))
''')


@pytest.fixture
def client(tmp_path, monkeypatch):
    fake = tmp_path / "lft.py"
    fake.write_text(FAKE_LFT)
    monkeypatch.setattr(api, "LFT", [sys.executable, str(fake)])
    (tmp_path / "rein.py").write_text(FAKE_REIN)
    monkeypatch.setattr(api, "REIN_CLI", [sys.executable, str(tmp_path / "rein.py")])
    monkeypatch.setattr(api, "HOME", tmp_path)
    monkeypatch.setattr(api, "LAYOUT", tmp_path / "layout.json")
    return api.app.test_client()


def events(client, job_id):
    text = client.get(f"/api/jobs/{job_id}/events").get_data(as_text=True)
    return [(block.split("\n")[0][7:], json.loads(block.split("\n")[1][6:])) for block in text.strip().split("\n\n")]


def result(client, response):
    assert response.status_code == 202, response.get_json()
    return events(client, response.get_json()["job"])[-1][1]["result"]


@pytest.mark.parametrize("method, url, body, error", [
    ("put", "/api/testbed/links/s0-x1", {}, "link ids"),
    ("put", "/api/testbed/links/s0-s1", {"rate": 99999}, "rate must be between"),
    ("post", "/api/testbed/hosts", {"sw": "s1", "image": "evil/image"}, "not allowed"),
    ("post", "/api/testbed/hosts", {"id": "h1", "sw": "s1", "image": "lft-iperf"}, "invalid host name"),
    ("post", "/api/testbed/hosts", {"sw": "s1", "image": "lft-iperf", "ip": "10.0.0.1"}, "not in 192.168.0.0/24"),
    ("post", "/api/testbed/switches", {"uf": "Bahia"}, "two letters"),
    ("post", "/api/traffic", {"tool": "iperf3", "client": "cl0", "server": "ds0", "out": "../etc"}, "inside results/"),
    ("post", "/api/capture", {"iface": "s0s1; rm -rf /"}, "invalid interface"),
])
def test_requests_are_validated_before_lft_runs(client, method, url, body, error):
    r = getattr(client, method)(url, json=body)
    assert r.status_code == 400 and error in r.get_json()["error"]


def test_the_state_reaches_the_console_in_its_model(client):
    api.LAYOUT.write_text(json.dumps({"s0": {"x": 10, "y": 20}}))
    s = client.get("/api/testbed").get_json()
    nodes = {n["id"]: n for n in s["nodes"]}
    assert (nodes["s0"]["uf"], nodes["s0"]["pop"], nodes["s0"]["x"]) == ("SP", "PoP-SP", 10)
    assert nodes["s1"]["pop"] is None and "x" not in nodes["s1"]
    assert (nodes["ds0"]["role"], nodes["cl0"]["role"]) == ("Servidor", "Cliente")
    assert s["onos"] == {"ip": "172.17.0.2"}


def test_a_link_change_is_a_job_streaming_steps_and_the_result(client):
    r = client.put("/api/testbed/links/s0-s1", json={"rate": 10, "delay": 20, "down": True})
    got = events(client, r.get_json()["job"])
    assert [kind for kind, _ in got] == ["step", "stdout", "step", "stdout", "status"]
    assert got[0][1]["title"] == "Shaping s0s1 in s0" and got[1][1] == {"line": "plain output"}
    status = got[-1][1]
    assert status["status"] == "done" and status["result"]["args"] == ["link", "down", "s0", "s1"]
    assert status["result"]["state"]["onos"] == {"ip": "172.17.0.2"}   # in the console's model
    first = client.get(f"/api/jobs/{r.get_json()['job']}").get_json()
    assert first["status"] == "done" and first["events"][-1]["type"] == "status"


def test_new_hosts_and_switches_get_the_next_free_name(client):
    host = result(client, client.post("/api/testbed/hosts", json={"role": "Servidor", "sw": "s1", "image": "lft-dash-video"}))
    assert host["args"] == ["host", "add", "ds1", "--switch", "s1", "--ip", "192.168.0.3", "--image", "lft-dash-video", "--server"]
    switch = result(client, client.post("/api/testbed/switches", json={"uf": "ba", "links": [{"to": "s0", "rate": 50}]}))
    assert switch["args"] == ["switch", "add", "s2", "--desc", "BA", "--dpid", "0000000000000003", "--link", "s0:rate=50mbit"]


def test_an_import_keeps_its_layout_for_the_console(client):
    text = 'POPS = (("PoP-SP", 0, 0),)\nCONFIG = {"pops": POPS}\nLAYOUT = {"s0": (5, 6)}\n'
    r = client.post("/api/testbed/import?name=lab", data=text)
    assert result(client, r)["args"][:2] == ["topology", "create"]
    assert json.loads(api.LAYOUT.read_text()) == {"s0": {"x": 5, "y": 6}}


def test_a_plan_with_auto_start_brings_the_rein_services(client, tmp_path):
    r = client.post("/api/experiments/plan", data='NAME = "p1"\nWINDOWS = [{}]\nAUTO_START = True\n')
    assert r.status_code == 202
    plan = (tmp_path / "plans" / "p1.py").read_text()
    assert "docker-compose.yml up -d --build" in plan.split("BEFORE = ")[1] and "down" in plan.split("AFTER = ")[1]
    api.runs[r.get_json()["run"]].proc.wait()


def test_a_failing_command_fails_the_job_with_the_lft_error(client, monkeypatch):
    monkeypatch.setattr(api, "LFT", api.LFT + ["fail"])
    r = client.post("/api/testbed/switches/s1/start")
    status = events(client, r.get_json()["job"])[-1][1]
    assert status == {"status": "failed", "result": {"ok": False, "error": "boom"}, "error": "boom"}


def test_the_models_are_reins_and_choosing_one_is_a_job(client):
    assert client.get("/api/models").get_json()["chosen"] == "qwen3.6"
    got = events(client, client.post("/api/models/lite").get_json()["job"])
    assert got[0] == ("stdout", {"line": "starting lite"})
    assert got[-1][1]["status"] == "done" and got[-1][1]["result"]["chosen"] == "lite"
    refused = events(client, client.post("/api/models/llama").get_json()["job"])[-1][1]
    assert refused["status"] == "failed" and "needs 4 GB" in refused["error"]
    assert client.post("/api/models/a;b").status_code == 400


def test_a_service_log_can_leave_out_the_requests(client, monkeypatch):
    printed = ('2026-10-03T21:52:30.1Z 127.0.0.1 - - [03/Oct/2026 21:52:30] "GET /events?after=0 HTTP/1.1" 200 -\n'
               '2026-10-03T21:52:30.2Z INFO:werkzeug:127.0.0.1 - - [03/Oct/2026 21:52:30] "POST /deploy HTTP/1.1" 200 -\n'
               '2026-10-03T21:52:30.3Z [CDN-QoE] Best path: SP -> MG -> ES\n')
    monkeypatch.setattr(api.subprocess, "run", lambda *a, **k: type("Out", (), {"stdout": printed, "stderr": ""}))
    assert len(client.get("/api/rein/logs/deployer").get_json()) == 3
    assert [r["text"] for r in client.get("/api/rein/logs/deployer?requests=0").get_json()] == ["[CDN-QoE] Best path: SP -> MG -> ES"]


def test_monitoring_is_what_the_collector_stored(client, monkeypatch):
    asked = []

    def stored(sql, **params):
        asked.append(params)
        return ([[100, 4.2]] if "throughput" in sql else [[100, 40.0]] if "latency" in sql
                else [["sdn.onos.requests", 55.0, 120], ["sdn.port.drops", 3.0, 118]])
    a, b = "of:0000000000000004", "of:0000000000000002"
    monkeypatch.setattr(api, "clickhouse", stored)
    monkeypatch.setattr(api, "onos_hosts", lambda: {"192.168.0.2": (a, "3")})
    got = client.get(f"/api/monitor?ip=192.168.0.2&path={a},{b}&range=3600").get_json()
    assert got == {"step": 20, "thr": [[100, 4.2]], "lat": [[100, 40.0]], "requests": 55, "drops": 3, "last": 120}
    assert (asked[0]["device"], asked[0]["port"]) == (a, "3")   # the port ONOS sees the client at
    assert asked[1]["links"] == f"[('{a}','{b}'),('{b}','{a}')]"   # each link, both ways
    assert client.get("/api/monitor?path=s0;drop").status_code == 400
    monkeypatch.setattr(api, "clickhouse", mock_down)
    assert client.get("/api/monitor?range=300").status_code == 503


def mock_down(sql, **params):
    raise api.requests.ConnectionError("refused")


def test_the_console_is_served(client):
    assert b"<html" in client.get("/").get_data().lower()

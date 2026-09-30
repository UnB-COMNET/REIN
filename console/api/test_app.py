# Run: cd REIN/console/api && python3 -m pytest -q test_app.py
import json
import sys
import textwrap

import pytest

import app as api

# Stands in for `sudo lft`: `testbed ...` prints LFT's state; any other command prints one step on stderr
# (as lft --json does) and its result, with the args it got, on stdout
FAKE_LFT = textwrap.dedent('''
    import json, sys
    args = sys.argv[1:-1]
    state = {"name": "t", "controller": "tcp:172.17.0.2:6653", "defaults": {}, "links": [], "updated": 0, "nodes": [
        {"id": "s0", "kind": "switch", "dpid": "of:0000000000000001", "desc": "SP", "off": False},
        {"id": "s1", "kind": "switch", "dpid": "of:0000000000000002", "desc": None, "off": False},
        {"id": "ds0", "kind": "host", "role": None, "sw": "s0", "ip": "192.168.0.1", "image": "lft-dash-video"},
        {"id": "cl0", "kind": "host", "role": "client", "sw": "s1", "ip": "192.168.0.2", "image": "lft-dash-client"}]}
    if args[:1] == ["testbed"]:
        print(json.dumps(state))
        sys.exit(0)
    print(json.dumps({"step": 1, "of": 1, "title": "Shaping s0s1 in s0"}), file=sys.stderr)
    print("plain output", file=sys.stderr)
    ok = "fail" not in args
    print(json.dumps({"ok": ok, "args": args, "state": state} if ok else {"ok": False, "error": "boom"}))
    sys.exit(0 if ok else 1)
''')


@pytest.fixture
def client(tmp_path, monkeypatch):
    fake = tmp_path / "lft.py"
    fake.write_text(FAKE_LFT)
    monkeypatch.setattr(api, "LFT", [sys.executable, str(fake)])
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


def test_the_console_is_served(client):
    assert b"<html" in client.get("/").get_data().lower()

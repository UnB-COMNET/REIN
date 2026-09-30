# Run: cd REIN/console/api && python3 -m pytest -q test_app.py
import json
import sys
import textwrap

import pytest

import app as api

# Stands in for `sudo lft`: prints one step on stderr (as lft --json does) and the result on stdout
FAKE_LFT = textwrap.dedent('''
    import json, sys
    args = sys.argv[1:-1]
    print(json.dumps({"step": 1, "of": 1, "key": "shape", "title": "Shape s0s1 in s0", "cmds": ["tc ..."]}), file=sys.stderr)
    print("plain output", file=sys.stderr)
    ok = "fail" not in args
    print(json.dumps({"ok": ok, "args": args} if ok else {"ok": False, "error": "boom"}))
    sys.exit(0 if ok else 1)
''')


@pytest.fixture
def client(tmp_path, monkeypatch):
    fake = tmp_path / "lft.py"
    fake.write_text(FAKE_LFT)
    monkeypatch.setattr(api, "LFT", [sys.executable, str(fake)])
    monkeypatch.setattr(api, "HOME", tmp_path)
    return api.app.test_client()


def events(client, job_id):
    text = client.get(f"/api/jobs/{job_id}/events").get_data(as_text=True)
    return [(block.split("\n")[0][7:], json.loads(block.split("\n")[1][6:])) for block in text.strip().split("\n\n")]


@pytest.mark.parametrize("method, url, body, error", [
    ("put", "/api/testbed/links/s0-x1", {}, "link ids"),
    ("put", "/api/testbed/links/s0-s1", {"rate": 99999}, "rate must be between"),
    ("post", "/api/testbed/hosts", {"sw": "s1", "image": "evil/image"}, "not allowed"),
    ("post", "/api/testbed/hosts", {"id": "h1", "sw": "s1", "image": "lft-iperf"}, "invalid host name"),
    ("post", "/api/testbed/hosts", {"sw": "s1", "image": "lft-iperf", "ip": "10.0.0.1"}, "not in 192.168.0.0/24"),
    ("post", "/api/traffic", {"tool": "iperf3", "client": "cl0", "server": "ds0", "out": "../etc"}, "inside results/"),
    ("post", "/api/capture", {"iface": "s0s1; rm -rf /"}, "invalid interface"),
])
def test_requests_are_validated_before_lft_runs(client, method, url, body, error):
    r = getattr(client, method)(url, json=body)
    assert r.status_code == 400 and error in r.get_json()["error"]


def test_a_link_change_is_a_job_streaming_steps_and_the_result(client):
    r = client.put("/api/testbed/links/s0-s1", json={"rate": 10, "delay": 20, "down": True})
    assert r.status_code == 202
    got = events(client, r.get_json()["job"])
    assert [kind for kind, _ in got] == ["step", "stdout", "step", "stdout", "status"]
    assert got[0][1]["title"] == "Shape s0s1 in s0" and got[1][1] == {"line": "plain output"}
    status = got[-1][1]
    assert status["status"] == "done" and status["result"]["args"] == ["link", "down", "s0", "s1"]
    first = client.get(f"/api/jobs/{r.get_json()['job']}").get_json()
    assert first["status"] == "done" and first["events"][-1]["type"] == "status"


def test_a_failing_command_fails_the_job_with_the_lft_error(client, monkeypatch):
    r = client.post("/api/testbed/switches/s1/stop")
    monkeypatch.setattr(api, "LFT", api.LFT + ["fail"])
    r = client.post("/api/testbed/switches/s1/start")
    status = events(client, r.get_json()["job"])[-1][1]
    assert status == {"status": "failed", "result": {"ok": False, "error": "boom"}, "error": "boom"}


def test_the_console_is_served(client):
    assert b"<html" in client.get("/").get_data().lower()

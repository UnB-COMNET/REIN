""" Deployer API server for Lumi """

from __future__ import print_function

import argparse
import collections
import itertools
import json
import os
import re
import time
import threading
import traceback

import requests
from flask import Flask, make_response, request
from flask_cors import CORS
from future.standard_library import install_aliases

# Parse --verbose before importing classes.onos, which reads DEPLOYER_VERBOSE at import time
_parser = argparse.ArgumentParser(add_help=False)
_parser.add_argument("--verbose", action="store_true", help="Print verbose deploy/debug logs")
_args, _ = _parser.parse_known_args()
os.environ["DEPLOYER_VERBOSE"] = "1" if _args.verbose else "0"
VERBOSE = _args.verbose

import metrics as _metrics
import nile
from classes.onos import Onos
from classes.topology import Topology
from services import cdn_qoe

install_aliases()

# Flask app should start in global layout
app = Flask(__name__)
CORS(app)

_deploy_lock = threading.Lock()
topo = Topology()

onos = Onos(base_url="http://127.0.0.1:8181/onos/v1", ip="172.17.0.2", is_main=True)
topo.add_controller(onos)

_intents_by_client: dict = {}  # {client_ip: intent_request}
_server_by_client: dict = {}  # {client_ip: server_ip}, updated on every (re)deploy
_path_by_client: dict = {}  # {client_ip: [UF, ...]}, client to server
_events = collections.deque(maxlen=500)  # deploy/recalculate history served by GET /events
_event_ids = itertools.count(1)


def _extract_client_ip(intent: str):
    m = re.search(r"endpoint\('([^']+)'\)", intent or "")
    return m.group(1) if m else None


# Brief: Best-effort push to the iperf experiment script (rnp_topology/main.py) so it
# can restart a client's iperf3 against its newly (re)calculated server, instead of
# polling /deploy/server_for. No-ops silently if that listener isn't running.
IPERF_NOTIFY_URL = os.environ.get("IPERF_NOTIFY_URL", "http://127.0.0.1:5152/server_changed")


# Brief: Re-reads the ONOS graph and deploys under the lock. The graph is rebuilt on every
# (re)deploy because hosts can be created at runtime
# Params:
#   dict intent_req: {"intent": "<Nile>"}
# Return:
#   dict response with "status": 503 if ONOS is down, 422 for an endpoint ONOS has not
#   discovered (instead of failing inside compile()), else the controllers' answer
def _deploy(intent_req):
    with _deploy_lock:
        try:
            topo.make_network_graph()
        except Exception as e:
            return {"status": 503, "error": "onos", "detail": str(e)}
        client_ip = _extract_client_ip(intent_req.get("intent"))
        if client_ip and client_ip not in topo.nodes["hosts"]:
            return {"status": 422, "error": "unsupported", "operation": "endpoint('{}')".format(client_ip),
                    "reason": "{} is not a host known to ONOS".format(client_ip)}
        return topo.notify(intent_req)


# Brief: Keeps the client's server and path and appends a deploy/recalculate event
# Params:
#   String kind: "deploy" or "recalculate"
#   String client_ip: Client of the intent
#   dict res: Response of _deploy()
#   extra: More event fields, e.g. the supervisor's drift reason
# Return:
#   None
def _record(kind, client_ip, res, **extra):
    previous = _server_by_client.get(client_ip)
    if res.get("server_ip"):
        _server_by_client[client_ip] = res["server_ip"]
        _path_by_client[client_ip] = res.get("path")
        _notify_iperf_server_change(client_ip, res["server_ip"])
    _events.append({"id": next(_event_ids), "ts": time.time(), "type": kind, "client_ip": client_ip,
                    "status": res["status"], "server_ip": res.get("server_ip"), "previous_server_ip": previous,
                    "path": res.get("path"), **extra})


def _notify_iperf_server_change(client_ip, server_ip):
    if not client_ip or not server_ip:
        return
    try:
        requests.post(IPERF_NOTIFY_URL, json={"client_ip": client_ip, "server_ip": server_ip}, timeout=3)
    except Exception:
        if VERBOSE:
            print("Could not notify iperf experiment of server change for {}".format(client_ip))


@app.route("/", methods=["GET"])
def home():
    """ Blank page to check if APIs are running """
    return "Lumi Deployer APIs"


@app.route("/deploy", methods=["POST"])
def deploy():
    """ Endpoint to compile given Nile intent into Merlin, and deploy it to Mininet """
    global _intents_by_client

    req = request.get_json(silent=True, force=True) or {}

    # Syntax (400) and executability (422) are checked before parse_nile ever runs
    rejected = nile.validate(str(req.get("intent") or ""))
    if rejected:
        return make_response(rejected[1], rejected[0])

    if VERBOSE:
        print("Request: {}".format(json.dumps(req, indent=4)))
    res = _deploy(req)

    # Extract client IP from intent string for per-client recalculation
    client_ip = _extract_client_ip(req.get("intent", ""))
    if client_ip and res["status"] == 200:
        _intents_by_client[client_ip] = req
    if client_ip:
        _record("deploy", client_ip, res)

    r = make_response(res, res["status"])
    r.headers["Content-Type"] = "application/json"

    if VERBOSE:
        print(r.status)
    if r.status == "200 OK":
        if VERBOSE:
            print("ENTROU AQUI!")
            print(r.json)
        if not "remove" in r.json["intent"]: topo.add_intent(r.json["intent"], r.json["controller_responses"])

    if VERBOSE:
        print("DICIONARIO DEPOIS")
        print(topo.installed_intents)

    return r


@app.route("/deploy/recalculate", methods=["POST"])
def recalculate():
    """ Re-deploys the intent for a specific client (or the most recent as fallback) """
    global _intents_by_client

    body       = request.get_json(silent=True, force=True) or {}
    client_ip  = body.get("client_ip")
    intent_req = _intents_by_client.get(client_ip) if client_ip else None

    if intent_req is None:
        intent_req = next(reversed(_intents_by_client.values()), None)  # fallback: most recent

    if intent_req is None:
        return make_response({"error": "no intent deployed yet"}, 400)

    if not client_ip:
        client_ip = _extract_client_ip(intent_req.get("intent", ""))

    _metrics.increment("msgs_observer_to_deployer")

    label = client_ip or "last"
    print("Recalculating intent for [{}]: {}".format(label, json.dumps(intent_req, indent=4)))
    t_start = time.time()
    res = _deploy(intent_req)
    _metrics.set_value("total_recalculate_time_s", time.time() - t_start)

    if client_ip:
        _record("recalculate", client_ip, res, reason=body.get("reason"))

    r = make_response(res, res["status"])
    r.headers["Content-Type"] = "application/json"

    return r


@app.route("/deploy/server_for/<client_ip>", methods=["GET"])
def server_for(client_ip):
    """ Returns the server currently assigned to a client (may change after a recalculate) """
    server_ip = _server_by_client.get(client_ip)
    if server_ip is None:
        return make_response({"error": "no server assigned"}, 404)
    return make_response({"client_ip": client_ip, "server_ip": server_ip}, 200)


# Brief: The Lark grammar /deploy validates intents against (text/plain)
@app.route("/nile/grammar", methods=["GET"])
def nile_grammar():
    r = make_response(nile.GRAMMAR, 200)
    r.headers["Content-Type"] = "text/plain; charset=utf-8"
    return r


# Brief: Which Nile operations this deployer executes, and why not when it can't
@app.route("/capabilities", methods=["GET"])
def capabilities():
    return make_response({"capabilities": [{"operation": k, **v} for k, v in nile.CAPABILITIES.items()]}, 200)


# Brief: The intent deployed for each client and the server currently assigned to it
@app.route("/intents", methods=["GET"])
def intents():
    return make_response({"intents": [
        {"client_ip": ip, "intent": req["intent"], "server_ip": _server_by_client.get(ip), "path": _path_by_client.get(ip)}
        for ip, req in _intents_by_client.items()]}, 200)


# Brief: Deploy/recalculate events newer than ?after=<id>, oldest first (the profiler polls it)
@app.route("/events", methods=["GET"])
def events():
    after = request.args.get("after", 0, type=int)
    return make_response({"events": [e for e in list(_events) if e["id"] > after]}, 200)


# Brief: The PoPs (UF -> device) and the clients/servers (IP -> UF) the cdn-qoe service sees
@app.route("/inventory", methods=["GET"])
def inventory():
    try:
        pops = cdn_qoe._discover_device_map()
        clients, servers = cdn_qoe._discover_host_pop_maps({v: k for k, v in pops.items()})
    except Exception as e:
        return make_response({"error": "onos", "detail": str(e)}, 503)
    return make_response({"pops": pops, "clients": clients, "servers": servers}, 200)


@app.route("/metrics", methods=["GET"])
def get_metrics():
    """ Returns current metrics counters and timings """
    return make_response(_metrics.snapshot(), 200)


@app.route("/metrics/reset", methods=["POST"])
def reset_metrics():
    """ Returns the current metrics and resets them atomically """
    previous = _metrics.reset()
    return make_response({"status": "ok", **previous}, 200)


@app.route("/delete_all", methods=["DELETE"])
def delete_all():
    """ Deletes all flow rules. Useful for a quick reset when running different experiments """
    print("PRINTING INSTALLED INTENTS")
    print(topo.installed_intents)
    intent = "define intent stnIntent: for group('students') add middlebox('dpi')"

    controller_responses = topo.get_intent(intent)
    print("CONTROLLER RESPONSES")
    print(controller_responses)
    for controller_response in controller_responses:
        onos.revoke_policies(controller_response["output"]["responses"])

    return {"message": "Deleted all installed flow rules!"}, 200


if __name__ == "__main__":
    port = int(os.getenv("PORT", 5000))

    print("Starting app on port %d" % port)

    app.run(debug=True, port=port, host="0.0.0.0")

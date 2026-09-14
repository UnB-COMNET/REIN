""" Deployer API server for Lumi """

from __future__ import print_function

import argparse
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
from classes.onos import Onos
from classes.topology import Topology

install_aliases()

# Flask app should start in global layout
app = Flask(__name__)
CORS(app)

_deploy_lock = threading.Lock()
topo = Topology()

onos = Onos(base_url="http://127.0.0.1:8181/onos/v1", ip="172.17.0.2", is_main=True)
topo.add_controller(onos)
topo.make_network_graph()

_intents_by_client: dict = {}  # {client_ip: intent_request}
_server_by_client: dict = {}  # {client_ip: server_ip}, updated on every (re)deploy


def _extract_client_ip(intent: str):
    m = re.search(r"endpoint\('([^']+)'\)", intent or "")
    return m.group(1) if m else None


# Brief: Best-effort push to the iperf experiment script (rnp_topology/main.py) so it
# can restart a client's iperf3 against its newly (re)calculated server, instead of
# polling /deploy/server_for. No-ops silently if that listener isn't running.
IPERF_NOTIFY_URL = os.environ.get("IPERF_NOTIFY_URL", "http://127.0.0.1:5152/server_changed")


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

    req = request.get_json(silent=True, force=True)

    # Extract client IP from intent string for per-client recalculation
    client_ip = _extract_client_ip(req.get("intent", ""))
    if client_ip:
        _intents_by_client[client_ip] = req

    if VERBOSE:
        print("Request: {}".format(json.dumps(req, indent=4)))
    with _deploy_lock:
        res = topo.notify(req) # notify observers

    if client_ip and res.get("server_ip"):
        _server_by_client[client_ip] = res["server_ip"]
        _notify_iperf_server_change(client_ip, res["server_ip"])

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
    with _deploy_lock:
        res = topo.notify(intent_req)
    _metrics.set_value("total_recalculate_time_s", time.time() - t_start)

    if client_ip and res.get("server_ip"):
        _server_by_client[client_ip] = res["server_ip"]
        _notify_iperf_server_change(client_ip, res["server_ip"])

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

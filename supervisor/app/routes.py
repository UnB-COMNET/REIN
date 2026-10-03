""" Supervisor API server """

import logging
import os
import time

from flask import Flask, make_response, request
from flask_cors import CORS

from app.services import SupervisorService
import app.metrics as _metrics

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(message)s",
    datefmt="%H:%M:%S",
)

app = Flask(__name__)
CORS(app)

ONOS_BASE_URL = "http://127.0.0.1:8181/onos/v1"
DEPLOYER_BASE_URL = "http://127.0.0.1:5000/deploy"
DRIFT_MODE = os.environ.get("SUPERVISOR_MODE", "threshold").strip().lower()

supervisor = SupervisorService(ONOS_BASE_URL, DEPLOYER_BASE_URL, DRIFT_MODE)

# Which drift rule is live decides how the whole run behaves
logging.getLogger(__name__).warning("[SUPERVISOR] drift mode: %s", DRIFT_MODE)


# Brief: Health check endpoint
@app.route("/", methods=["GET"])
def home():
    return "Lumi Supervisor APIs"

# Brief: Receives the path calculated by the deployer
@app.route("/supervise", methods=["POST"])
def supervise():
    """
    Expected JSON body:
    {
        "client_ip":       "192.168.0.11",
        "path":            [[i, j], ...],
        "estados":         ["AM", "BA", ...],
        "source_uf":       "AM",
        "target_ufs":      ["BA"],
        "tx":              [500.0],
        "access_delay_ms": 0.0
    }
    """
    data = request.get_json(silent=True, force=True)
    if not data:
        return make_response({"error": "invalid or missing JSON body"}, 400)

    if "path" not in data:
        return make_response({"error": "missing field: path"}, 400)

    client_ip = data.get("client_ip")
    if not client_ip:
        return make_response({"error": "missing field: client_ip"}, 400)

    supervisor.update(
        client_ip=client_ip,
        path=data["path"],
        estados=data.get("estados"),
        access_delay_ms=float(data.get("access_delay_ms", 0.0)),
        target_ufs=data.get("target_ufs"),
        source_uf=data.get("source_uf"),
        tx=data.get("tx"),
    )

    return make_response({"status": "ok", "message": "Path received, monitoring started"}, 200)


# Brief: Stops monitoring a client, when the deployer removes its intent
@app.route("/supervise/<client_ip>", methods=["DELETE"])
def unsupervise(client_ip):
    if not supervisor.forget(client_ip):
        return make_response({"error": "not monitored"}, 404)
    return make_response({"status": "ok"}, 200)


# Brief: Returns deduplicated (PoP_A, PoP_B) edges from all clients' currently active paths
@app.route("/active_links", methods=["GET"])
def get_active_links():
    return make_response({"links": supervisor.get_active_links()}, 200)


# Brief: Returns each client's own first-hop (access) link, keyed by client_ip
@app.route("/access_links", methods=["GET"])
def get_access_links():
    return make_response({"access_links": supervisor.get_access_links()}, 200)


# Brief: Returns the current snapshot of all metrics (counters and timings) for monitoring
@app.route("/metrics", methods=["GET"])
def get_metrics():
    return make_response(_metrics.snapshot(), 200)


# Brief: Returns the current metrics and resets them atomically
@app.route("/metrics/reset", methods=["POST"])
def reset_metrics():
    previous = _metrics.reset()
    return make_response({"status": "ok", **previous}, 200)


# Brief: Sets the timestamp when the link was degraded
@app.route("/metrics/degrade", methods=["POST"])
def set_degrade_ts():
    data = request.get_json(silent=True) or {}
    ts = float(data.get("ts", time.time()))
    _metrics.set_value("degrade_ts", ts)
    return make_response({"status": "ok"}, 200)


if __name__ == "__main__":
    port = int(os.getenv("PORT", 5151))
    logging.info("Starting supervisor on port %d", port)
    app.run(debug=True, port=port, host="0.0.0.0")

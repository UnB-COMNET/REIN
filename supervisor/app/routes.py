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
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)

app = Flask(__name__)
CORS(app)

ONOS_BASE_URL = "http://127.0.0.1:8181/onos/v1"
DEPLOYER_BASE_URL = "http://127.0.0.1:5000/deploy"

supervisor = SupervisorService(ONOS_BASE_URL, DEPLOYER_BASE_URL)


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
        "path": [[i, j], ...],
        "access_delay_ms": 0.0          
    }
    """
    data = request.get_json(silent=True, force=True)
    if not data:
        return make_response({"error": "invalid or missing JSON body"}, 400)

    if "path" not in data:
        return make_response({"error": "missing field: path"}, 400)

    supervisor.update(
        path=data["path"],
        access_delay_ms=float(data.get("access_delay_ms", 0.0)),
        estados=data.get("estados"),
        target_ufs=data.get("target_ufs"),
    )

    return make_response({"status": "ok", "message": "Path received, monitoring started"}, 200)


# Brief: Returns the current snapshot of all metrics (counters and timings) for monitoring
@app.route("/metrics", methods=["GET"])
def get_metrics():
    return make_response(_metrics.snapshot(), 200)


# Brief: Resets all metrics counters to zero (call at the start of each snapshot)
@app.route("/metrics/reset", methods=["POST"])
def reset_metrics():
    _metrics.reset()
    return make_response({"status": "ok"}, 200)


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

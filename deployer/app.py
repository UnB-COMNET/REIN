""" Deployer API server for Lumi """

from __future__ import print_function

import json
import os
import time
import traceback

from flask import Flask, make_response, request
from flask_cors import CORS
from future.standard_library import install_aliases

import metrics as _metrics
from classes.onos import Onos
from classes.topology import Topology

install_aliases()

# Flask app should start in global layout
app = Flask(__name__)
CORS(app)

topo = Topology()

onos = Onos(base_url="http://127.0.0.1:8181/onos/v1", ip="172.17.0.2", is_main=True)
topo.add_controller(onos)
topo.make_network_graph()

_last_intent_req = None


@app.route("/", methods=["GET"])
def home():
    """ Blank page to check if APIs are running """
    return "Lumi Deployer APIs"


@app.route("/deploy", methods=["POST"])
def deploy():
    """ Endpoint to compile given Nile intent into Merlin, and deploy it to Mininet """
    global _last_intent_req

    req = request.get_json(silent=True, force=True)
    _last_intent_req = req

    print("Request: {}".format(json.dumps(req, indent=4)))
    res = topo.notify(req)  # Notify observers

    r = make_response(res, res["status"])
    r.headers["Content-Type"] = "application/json"

    print(r.status)
    if r.status == "200 OK":
        print("ENTROU AQUI!")
        print(r.json)
        if not "remove" in r.json["intent"]: topo.add_intent(r.json["intent"], r.json["controller_responses"])

    print("DICIONARIO DEPOIS")
    print(topo.installed_intents)

    return r


@app.route("/deploy/recalculate", methods=["POST"])
def recalculate():
    """ Re-deploys the last intent, triggered by the supervisor when the optimal path changes """
    if _last_intent_req is None:
        return make_response({"error": "no intent deployed yet"}, 400)

    _metrics.increment("msgs_observer_to_deployer")

    print("Recalculating last intent: {}".format(json.dumps(_last_intent_req, indent=4)))
    t_start = time.time()
    res = topo.notify(_last_intent_req)
    _metrics.set_value("total_recalculate_time_s", time.time() - t_start)

    r = make_response(res, res["status"])
    r.headers["Content-Type"] = "application/json"

    return r


@app.route("/metrics", methods=["GET"])
def get_metrics():
    """ Returns current metrics counters and timings """
    return make_response(_metrics.snapshot(), 200)


@app.route("/metrics/reset", methods=["POST"])
def reset_metrics():
    """ Resets all metrics counters to zero (call at the start of each snapshot) """
    _metrics.reset()
    return make_response({"status": "ok"}, 200)


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

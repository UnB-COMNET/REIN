# Brief: Profiler HTTP API (Flask). Chat steps and assurance events stream as Server-Sent Events.
#   POST /profile                  {text, model?, thread_id?}          -> SSE until the operator must decide
#   POST /profile/<thread>/resume  {action, nile?, text?}              -> SSE (see graph._confirm_node)
#   GET  /models, POST /models/<id>/load|unload                        -> llm-status (or its stub)
#   GET  /events                                                       -> SSE of deploy/recalculate events
#   GET  /intents, GET /health                                         -> deployed intents; live state of the IBN chain

import json
import os
import sqlite3
import time
import uuid

import requests
from flask import Flask, Response, jsonify, request, stream_with_context
from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.types import Command

from app import graph, inventory, llm

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.environ.get("PROFILER_DB", os.path.join(ROOT, "state", "profiler.sqlite"))
HEARTBEAT_S = 15
SUPERVISOR_URL = os.environ.get("SUPERVISOR_URL", "http://127.0.0.1:5151")
ONOS_URL = os.environ.get("ONOS_URL", "http://127.0.0.1:8181/onos/v1")

os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
GRAPH = graph.build(SqliteSaver(sqlite3.connect(DB_PATH, check_same_thread=False)))
app = Flask(__name__)


# Brief: Starts a thread (or a new request in an existing one) and streams its steps
@app.route("/profile", methods=["POST"])
def profile():
    body = request.get_json(silent=True) or {}
    model = body.get("model") or llm.CONFIG["models"][0]["id"]
    if not body.get("text"):
        return jsonify(error="text is required"), 400
    state = llm.status()["models"].get(model, {}).get("state")
    if state != "awake":
        return jsonify(error="model not loaded", model=model, state=state), 409
    thread = body.get("thread_id") or uuid.uuid4().hex
    return _stream({"text": body["text"], "model": model, "error": None, "result": None, "status": None}, thread)


# Brief: Delivers the operator's decision to a thread waiting at confirm
@app.route("/profile/<thread>/resume", methods=["POST"])
def resume(thread):
    if not GRAPH.get_state(_config(thread)).next:
        return jsonify(error="nothing to resume", thread_id=thread), 409
    return _stream(Command(resume=request.get_json(silent=True) or {}), thread)


# Brief: GPU and per-model state for the model cards
@app.route("/models", methods=["GET"])
def models():
    status = llm.status()
    keys = ("id", "label", "quantization", "budget_gb", "pinned")
    return jsonify(gpu=status["gpu"], models=[{**{k: m.get(k) for k in keys}, **status["models"].get(m["id"], {"state": "down"})}
                                             for m in llm.CONFIG["models"]])


# Brief: Wakes or sleeps a model through llm-status (409 with its reason when refused)
@app.route("/models/<model_id>/<action>", methods=["POST"])
def model_action(model_id, action):
    if action not in ("load", "unload"):
        return jsonify(error="unknown action"), 404
    if not llm.CONFIG.get("llm_status_url"):
        return jsonify(error="llm-status is not deployed yet; the stub is read-only"), 409
    r = requests.post(f"{llm.CONFIG['llm_status_url']}/models/{model_id}/{action}", timeout=120)
    return Response(r.content, r.status_code, mimetype="application/json")


# Brief: The intent deployed for each client, with its server and path (the deployer's /intents)
@app.route("/intents", methods=["GET"])
def intents():
    try:
        return jsonify(requests.get(inventory.DEPLOYER_URL + "/intents", timeout=3).json())
    except (requests.RequestException, ValueError) as e:
        return jsonify(error="deployer unreachable", detail=str(e)), 503


# Brief: Whether each stage of the IBN chain answers, and how fast (ms), for the console's hub
# Return:
#   JSON {profiler, llm, deployer, onos, supervisor: {ok, ms}}
@app.route("/health", methods=["GET"])
def health():
    def probe(url, **kwargs):
        start = time.time()
        try:
            ok = requests.get(url, timeout=2, **kwargs).ok
        except requests.RequestException:
            ok = False
        return {"ok": ok, "ms": round(1000 * (time.time() - start))}

    model = llm.CONFIG["models"][0]
    return jsonify(profiler={"ok": True, "ms": 0},
                   llm=probe(model["base_url"] + "/models"),
                   deployer=probe(inventory.DEPLOYER_URL + "/"),
                   onos=probe(ONOS_URL + "/devices", auth=(os.environ.get("ONOSUSER", "onos"), os.environ.get("ONOSPASS", "rocks"))),
                   supervisor=probe(SUPERVISOR_URL + "/metrics"))


# Brief: Assurance events (drift -> recalculate, server changes) polled from the deployer.
# Starts after ?after=<id> or Last-Event-ID; by default only events newer than the connection
@app.route("/events", methods=["GET"])
def events():
    after = request.args.get("after", type=int)
    if after is None:
        after = request.headers.get("Last-Event-ID", type=int)

    def gen():
        last, beat = after, time.time()
        while True:
            try:
                batch = requests.get(inventory.DEPLOYER_URL + "/events", params={"after": last or 0}, timeout=5).json()["events"]
            except (requests.RequestException, ValueError, KeyError):
                batch = []
            if last is None:  # first poll only positions the cursor
                last = batch[-1]["id"] if batch else 0
                batch = []
            for e in batch:
                last = e["id"]
                yield f"id: {e['id']}\n" + _sse("assurance", e)
            if time.time() - beat >= HEARTBEAT_S:
                beat = time.time()
                yield ": heartbeat\n\n"
            time.sleep(1)

    return Response(stream_with_context(gen()), mimetype="text/event-stream", headers={"Cache-Control": "no-cache"})


def _config(thread: str) -> dict:
    return {"configurable": {"thread_id": thread}}


def _sse(event: str, data) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


# Brief: Runs the graph and streams one SSE event per step: thread, ground, retrieve, generate,
# deploy, then confirm (waiting for the operator) or done
def _stream(inp, thread: str) -> Response:
    def gen():
        yield _sse("thread", {"thread_id": thread})
        try:
            for update in GRAPH.stream(inp, _config(thread), stream_mode="updates"):
                for node, value in update.items():
                    if node == "__interrupt__":
                        yield _sse("confirm", value[0].value)
                    elif node == "ground":
                        yield _sse(node, {k: v for k, v in (value["grounding"] or {}).items() if k != "capabilities"})
                    elif node == "retrieve":
                        yield _sse(node, [{k: e[k] for k in ("text", "nile", "score", "source")} for e in value["examples"]])
                    elif value and node != "confirm":  # confirm speaks only through its interrupt
                        yield _sse(node, value)
            values = GRAPH.get_state(_config(thread)).values
            if values.get("status"):
                yield _sse("done", {"status": values["status"], "result": values.get("result")})
        except Exception as e:  # the stream is already open: report instead of a 500
            yield _sse("error", {"detail": str(e)})

    return Response(stream_with_context(gen()), mimetype="text/event-stream", headers={"Cache-Control": "no-cache"})


if __name__ == "__main__":
    app.run(host=os.environ.get("HOST", "127.0.0.1"), port=int(os.environ.get("PORT", 5300)), threaded=True)

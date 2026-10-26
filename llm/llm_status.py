# Brief: llm-status (runs on the GPU VM): GPU memory and per-model state for the REIN console, and
# wake/sleep of the vLLM servers on the operator's request. One model is awake at a time besides the
# pinned ones: loading one sleeps the others, so their memory counts as free for it.
#   GET  /status                 -> {gpu: {total_gb, used_gb, free_gb}, models: {id: {state, budget_gb, fits, reason, kv_cache_pct, pinned}}}
#   POST /models/<id>/load       -> sleep the others and wake it up (409 with the reason when it does not
#                                   fit or is not running)
#   POST /models/<id>/unload     -> sleep level 1 (409 for pinned models)

import os
import re

import pynvml
import requests
import yaml
from flask import Flask, jsonify

with open(os.environ.get("MODELS_CONFIG", "models.yaml")) as f:
    MODELS = {m["id"]: m for m in yaml.safe_load(f)["models"]}
GIB = 2 ** 30

app = Flask(__name__)


# Brief: Memory of the GPU in GiB
def gpu() -> dict:
    pynvml.nvmlInit()
    mem = pynvml.nvmlDeviceGetMemoryInfo(pynvml.nvmlDeviceGetHandleByIndex(int(os.environ.get("GPU_INDEX", 0))))
    return {"total_gb": round(mem.total / GIB, 1), "used_gb": round(mem.used / GIB, 1), "free_gb": round(mem.free / GIB, 1)}


def _root(model: dict) -> str:
    return model["base_url"].rsplit("/v1", 1)[0]


# Brief: "awake", "sleeping" or "down" (servers without dev mode, like the shared Qwen, read as awake)
def state(model: dict) -> str:
    try:
        if not requests.get(_root(model) + "/health", timeout=2).ok:
            return "down"
        r = requests.get(_root(model) + "/is_sleeping", timeout=2)
        return "sleeping" if r.ok and r.json().get("is_sleeping") else "awake"
    except (requests.RequestException, ValueError):
        return "down"


# Brief: KV cache usage in percent, from vLLM's Prometheus metrics
def kv_cache_pct(model: dict):
    try:
        text = requests.get(_root(model) + "/metrics", timeout=2).text
    except requests.RequestException:
        return None
    m = re.search(r"^vllm:(?:kv|gpu)_cache_usage_perc\{[^}]*\} (\S+)", text, re.M)
    return round(100 * float(m.group(1)), 1) if m else None


# Brief: The awake models that loading `mid` sleeps: every other one that is not pinned
def _others(mid: str) -> list:
    return [m for other, m in MODELS.items() if other != mid and not m.get("pinned") and state(m) == "awake"]


@app.route("/status")
def status():
    g, models = gpu(), {}
    for mid, m in MODELS.items():
        st = state(m)
        room = g["free_gb"] + sum(o["budget_gb"] for o in _others(mid))
        fits = st == "awake" or (st == "sleeping" and m["budget_gb"] <= room)
        reason = None if fits else "not running on the GPU VM" if st == "down" else f"needs {m['budget_gb']} GB, {room:g} GB free"
        models[mid] = {"state": st, "budget_gb": m["budget_gb"], "fits": fits, "reason": reason,
                       "kv_cache_pct": kv_cache_pct(m) if st == "awake" else None, "pinned": bool(m.get("pinned"))}
    return jsonify(gpu=g, models=models)


@app.route("/models/<mid>/load", methods=["POST"])
def load(mid):
    if mid not in MODELS:
        return jsonify(error=f"unknown model {mid}"), 404
    m, st = MODELS[mid], state(MODELS[mid])
    if st == "down":
        return jsonify(error=f"{mid} is not running on the GPU VM"), 409
    if st == "sleeping":
        others = _others(mid)
        room = gpu()["free_gb"] + sum(o["budget_gb"] for o in others)
        if m["budget_gb"] > room:
            return jsonify(error=f"{mid} needs {m['budget_gb']} GB and {room:g} GB are free"), 409
        for o in others:
            requests.post(_root(o) + "/sleep", params={"level": 1}, timeout=120).raise_for_status()
        requests.post(_root(m) + "/wake_up", timeout=120).raise_for_status()
    return jsonify(id=mid, state="awake")


@app.route("/models/<mid>/unload", methods=["POST"])
def unload(mid):
    if mid not in MODELS:
        return jsonify(error=f"unknown model {mid}"), 404
    m = MODELS[mid]
    if m.get("pinned"):
        return jsonify(error=f"{mid} is pinned (shared with the supervisor)"), 409
    if state(m) == "awake":
        requests.post(_root(m) + "/sleep", params={"level": 1}, timeout=120).raise_for_status()
    return jsonify(id=mid, state="sleeping")


if __name__ == "__main__":
    app.run(host=os.environ.get("HOST", "0.0.0.0"), port=int(os.environ.get("PORT", 5500)), threaded=True)

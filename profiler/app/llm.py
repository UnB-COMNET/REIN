# Brief: OpenAI-compatible clients for the vLLM models in models.yaml, and which of them can be used on
# this machine: the ones whose server answers, and the ones REIN can start here that fit its VRAM. The
# VRAM is told by whoever asks (rein, on the host), measured at that moment.

import os
import time

import requests
import yaml
from openai import OpenAI

# One file for the profiler and llm-status: REIN/llm/models.yaml (mounted into the container)
CONFIG_PATH = os.environ.get("MODELS_CONFIG",
                             os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "llm", "models.yaml"))
with open(CONFIG_PATH) as f:
    CONFIG = yaml.safe_load(f)
MODELS = {m["id"]: m for m in CONFIG["models"]}

_clients = {}
CACHE_S = 5
_status = {}


# Brief: One chat completion at temperature 0
# Params:
#   String model_id: Model id from models.yaml
#   String system: System prompt
#   String user: The operator's request
#   String grammar: GBNF for vLLM constrained decoding; refused for shared models
#   int max_tokens: Completion limit
# Return:
#   tuple (String answer, float seconds)
def complete(model_id: str, system: str, user: str, grammar: str = None, max_tokens: int = 160):
    model = MODELS[model_id]
    if model_id not in _clients:
        _clients[model_id] = OpenAI(base_url=model["base_url"], api_key=os.environ.get("VLLM_API_KEY", "EMPTY"),
                                    timeout=120, max_retries=0)
    extra = dict(model.get("extra_body") or {})
    if grammar:
        if model.get("shared"):
            raise ValueError(f"{model_id} is shared: constrained decoding is never sent to it")
        extra["structured_outputs"] = {"grammar": grammar}
    start = time.time()
    reply = _clients[model_id].chat.completions.create(
        model=model["model"], temperature=0, max_tokens=max_tokens, extra_body=extra,
        messages=[{"role": "system", "content": system}, {"role": "user", "content": user}])
    return reply.choices[0].message.content or "", time.time() - start


# Brief: Whether a model's server answers
def awake(model: dict) -> bool:
    try:
        return requests.get(model["base_url"] + "/models", timeout=2).ok
    except requests.RequestException:
        return False


# Brief: GPU and per-model state: from llm-status when the models run on a separate GPU machine, else
# from this machine's VRAM and from asking each model's server. A model REIN starts here fits when its
# budget fits the free VRAM plus what the local models now running would give back, since switching
# stops them. Kept for CACHE_S per VRAM reading, so polling does not ask the servers every time
# Params:
#   float total_gb, free_gb: This machine's VRAM, measured by the caller (0: no GPU, or not told)
# Return:
#   dict {gpu: {total_gb, used_gb, free_gb}, models: {id: {state, budget_gb, fits, reason, kv_cache_pct,
#   pinned}}, selected: the id of the model used by default (None: no model, the chat takes Nile)}
def status(total_gb: float = 0, free_gb: float = 0) -> dict:
    cached = _status.get((total_gb, free_gb))
    if cached and time.time() - cached["at"] < CACHE_S:
        return cached["value"]
    value = None
    if CONFIG.get("llm_status_url"):
        try:
            value = requests.get(CONFIG["llm_status_url"] + "/status", timeout=3).json()
        except (requests.RequestException, ValueError):   # it does not answer: what each server tells
            pass
    if value is None:
        up = {m["id"]: awake(m) for m in CONFIG["models"]}
        room = free_gb + sum(m["budget_gb"] for m in CONFIG["models"] if m.get("local") and up[m["id"]])
        value = {"gpu": {"total_gb": total_gb, "used_gb": round(total_gb - free_gb, 1), "free_gb": free_gb}, "models": {}}
        for m in CONFIG["models"]:
            fits = up[m["id"]] or (bool(m.get("local")) and m["budget_gb"] <= room)
            reason = (None if fits else "its server does not answer" if not m.get("local")
                      else f"needs {m['budget_gb']} GB, {room:g} GB free" if total_gb else f"needs a GPU with {m['budget_gb']} GB")
            value["models"][m["id"]] = {"state": "awake" if up[m["id"]] else "down", "budget_gb": m["budget_gb"], "fits": fits,
                                        "reason": reason, "kv_cache_pct": None, "pinned": bool(m.get("pinned"))}
    value["selected"] = select(value["models"])
    _status[(total_gb, free_gb)] = {"at": time.time(), "value": value}
    return value


# Brief: The model the application uses, in models.yaml's order: the first awake, else the first that
# fits and can be started here
# Params:
#   dict models: status()["models"]
# Return:
#   String model id, or None when no model can run on this machine
def select(models: dict):
    ids = [m["id"] for m in CONFIG["models"] if m["id"] in models]
    return (next((i for i in ids if models[i]["state"] == "awake"), None)
            or next((i for i in ids if models[i]["fits"] and MODELS[i].get("local")), None))

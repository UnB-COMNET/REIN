# Brief: OpenAI-compatible clients for the vLLM models in models.yaml, and the llm-status proxy (or stub)

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


# Brief: GPU and per-model state from llm-status on the GPU VM, or the fixed stub
# Return:
#   dict {gpu: {total_gb, used_gb, free_gb}, models: {id: {state, budget_gb, fits, reason, kv_cache_pct, pinned}}}
def status() -> dict:
    if CONFIG.get("llm_status_url"):
        return requests.get(CONFIG["llm_status_url"] + "/status", timeout=3).json()
    return CONFIG["llm_status_stub"]

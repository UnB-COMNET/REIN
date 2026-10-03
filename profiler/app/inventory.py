# Brief: Network inventory for grounding: PoPs, clients and servers, executable services and installed intents

import json
import os
import time

import requests

DEPLOYER_URL = os.environ.get("DEPLOYER_URL", "http://127.0.0.1:5000")
TTL_S = 10

_cache = {"at": 0.0, "value": None}


# Brief: Live inventory from the deployer (it maps ONOS devices to UFs via dp-desc), cached 10 s.
# INVENTORY_FILE pins a fixed snapshot instead, for offline runs and the evaluation
# Return:
#   dict {pops: [UF], clients: {ip: UF}, servers: {ip: UF}, capabilities: [dict], intents: [dict]}
def get() -> dict:
    if os.environ.get("INVENTORY_FILE"):
        return load(os.environ["INVENTORY_FILE"])
    if _cache["value"] is None or time.time() - _cache["at"] > TTL_S:
        topo = _get("/inventory")
        _cache["value"] = {
            "pops": sorted(topo["pops"]),
            "clients": topo["clients"],
            "servers": topo["servers"],
            "capabilities": _get("/capabilities")["capabilities"],
            "intents": _get("/intents")["intents"],
        }
        _cache["at"] = time.time()
    return _cache["value"]


# Brief: Reads an inventory snapshot
# Params:
#   String path: JSON file with the same keys get() returns
# Return:
#   dict inventory
def load(path: str) -> dict:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _get(path: str) -> dict:
    r = requests.get(DEPLOYER_URL + path, timeout=5)
    r.raise_for_status()
    return r.json()

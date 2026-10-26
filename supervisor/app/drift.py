""" Drift rules — one per SUPERVISOR_MODE """

import collections
import json
import logging
import os

import requests

from app import cdn_qoe, quantization, topology

logger = logging.getLogger(__name__)

DEFAULT_SERVER_TX = 500.0

# level is the P3 health (1 Normal, 0 Warning, -1 Critical)
Verdict = collections.namedtuple("Verdict", "drift level detail", defaults=(False, 1, ""))


# Brief: Quantize the measured KPIs, react on Critical
# Ex: kpis = {"RTT_ms": 43.8, "Vazao_Mbps": 24.84}
def by_threshold(client_ip, path, kpis: dict, source_uf: str, server_tx: float) -> Verdict:
    overall, details = quantization.evaluate_service_health(kpis)
    if overall == 1:
        return Verdict()

    drifted = ", ".join(f"{n}={r.value:.2f}(P9={r.p9:+d})"
                         for n, r in details.items() if r.p3 < 1)
    status = "✖ CRITICAL — recalculate" if overall == -1 else "⚠ WARNING"
    detail = f"  {status} — {drifted}"

    thr = details.get("Vazao_Mbps")
    if overall == 0 and thr is not None and thr.p3 < 1:
        detail += f"  ({thr.value - quantization.critical_below('Vazao_Mbps'):.1f} Mbit/s above Critical)"
    return Verdict(overall == -1, overall, detail)


# Brief: Ignore the measured levels; re-run the cdn-qoe solver against the
# topology as it looks now and react when its answer is a cheaper path.
#   installed, best_edges = [(1, 2), (2, 0)]   both indexed into ESTADOS *now*
def by_best_path(client_ip, path, kpis: dict, source_uf: str, server_tx: float) -> Verdict:
    targets = sorted(set(cdn_qoe.IP_TO_ESTADO_SERVIDOR.values()) & set(cdn_qoe.ESTADOS))
    if not source_uf or source_uf not in cdn_qoe.ESTADOS or not targets:
        return Verdict(detail="  (topology not resolved yet)")

    _, _, _, best_edges, _ = cdn_qoe.solve_shortest_path_with_constraints(
        source_uf, targets, [server_tx] * len(targets))
    if best_edges is None:
        return Verdict(detail="  (no route found)")

    installed = set(path.remapped())
    route = " -> ".join(cdn_qoe.path_indices_to_names(best_edges, cdn_qoe.ESTADOS))
    if installed == set(best_edges):
        return Verdict(detail=f"  optimal ({route})")

    # A different path is only drift if it is genuinely cheaper
    installed_ms = topology.edges_latency_ms(installed)
    best_ms = topology.edges_latency_ms(best_edges)
    if best_ms >= installed_ms:
        return Verdict(detail=f"  optimal (tied with {route} at {best_ms:.1f}ms)")

    here = " -> ".join(cdn_qoe.path_indices_to_names(sorted(installed), cdn_qoe.ESTADOS))
    return Verdict(True, -1, f"  ✖ SUBOPTIMAL — recalculate — on {here} ({installed_ms:.1f}ms), "
                             f"best is {route} ({best_ms:.1f}ms)")


LLM_WINDOW = 5 # measurements gathered before asking the model
LLM_MODEL = "nvidia/Qwen3.6-35B-A3B-NVFP4" # as /v1/models reports it
_history = collections.defaultdict(list) # client_ip -> the window being filled


# Brief: Gather measurements and ask LLM if the path should be rerouted
#   samples = [{"RTT_ms": 43.8, "Vazao_Mbps": 35.0},
#              {"RTT_ms": 44.1, "Vazao_Mbps": 29.9}, ...]   oldest first
def by_llm(client_ip, path, kpis: dict, source_uf: str, server_tx: float) -> Verdict:
    window = _history[client_ip]
    window.append(kpis)
    if len(window) < LLM_WINDOW:
        return Verdict(detail=f"  (llm {len(window)}/{LLM_WINDOW})")

    samples = list(window)
    # Cleared on drift too: those samples measured the path being replaced.
    window.clear()

    route = " -> ".join(cdn_qoe.path_indices_to_names(path.edges, path.estados))
    lines = "\n".join(f"  {i}. " + ", ".join(f"{k}={v:.2f}" for k, v in s.items())
                      for i, s in enumerate(samples, 1))
    # Give the model the same inputs the solver in
    # by_best_path gets live per-link one-way delays and where the servers are
    topo = "\n".join(f"- {a} -> {b}: {cdn_qoe.RTT_MATRIX[i][j]:.1f}ms"
                     for i, a in enumerate(cdn_qoe.ESTADOS)
                     for j, b in enumerate(cdn_qoe.ESTADOS)
                     if cdn_qoe.ADJ_MATRIX[i][j])
    servers = ", ".join(sorted(set(cdn_qoe.IP_TO_ESTADO_SERVIDOR.values()) & set(cdn_qoe.ESTADOS)))
    prompt = f"""You monitor one client's CDN path in an SDN testbed. Decide whether
                it should be rerouted -- NOT merely whether it degraded. A degraded path that is
                still the cheapest route to a CDN server must not be rerouted.

                Client is at: {source_uf}
                Installed path: {route}
                CDN servers are at: {servers}

                Topology, current per-link ONE-WAY delay in ms. RTT_ms below is
                round-trip: compare it with the sum of forward AND reverse links.
                Only these links exist. These are live
                probe measurements and jitter by a few ms per link, so treat an
                alternative as cheaper only if it wins by a clear margin -- rerouting
                for a couple of ms churns the network without improving anything:
                {topo}

                Measured end-to-end on the installed path, oldest first:
                {lines}

                Answer only: {{"drift": true|false, "reason": "<short>"}}"""

    resp = requests.post(
        os.getenv("LLM_URL") + "/v1/chat/completions",
        json={
            "model": LLM_MODEL,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0,
            "response_format": {"type": "json_object"},
        },
        timeout=120,
    )
    resp.raise_for_status()
    message = resp.json()["choices"][0]["message"]
    print(message)
    if message.get("reasoning_content"):
        logger.info("[%s] llm thinking: %s", client_ip, message["reasoning_content"])

    answer = json.loads(message["content"])
    drift = answer["drift"]
    if type(drift) is not bool:
        raise ValueError("LLM drift must be a JSON boolean")
    status = "✖ DRIFT — recalculate" if drift else "no drift"
    return Verdict(drift, -1 if drift else 1, f"  llm: {status} — {answer.get('reason', '')}")


RULES = {"threshold": by_threshold, "best-path": by_best_path, "llm": by_llm}

# Brief: Resolves SUPERVISOR_MODE to its rule. An unknown mode raises here, at
# startup, instead of silently falling back to threshold for a whole run
def rule_for(mode: str):
    if mode not in RULES:
        raise ValueError(f"unknown SUPERVISOR_MODE '{mode}' (expected one of {sorted(RULES)})")
    return RULES[mode]

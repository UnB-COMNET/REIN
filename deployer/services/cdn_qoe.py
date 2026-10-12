import os
from typing import Optional
import requests as _req
import numpy as np
import networkx as nx
import matplotlib.pyplot as plt
from ortools.linear_solver import pywraplp
import subprocess

import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import clickhouse_client

IP_TO_ESTADO_CLIENTE = {"192.168.0.2": "SP"}
IP_TO_ESTADO_SERVIDOR = {"192.168.0.1": "ES"}

ESTADOS    = []
DEVICE_MAP = {}
RTT_MATRIX = []
ADJ_MATRIX = []


# Brief: Converts a management IP to its corresponding Docker container name
def _mgmt_ip_to_container(mgmt_ip: str) -> Optional[str]:
    try:
        out = subprocess.check_output(
            "docker inspect --format '{{.Name}} {{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' $(docker ps -q)",
            shell=True, stderr=subprocess.DEVNULL
        ).decode()
        for line in out.strip().splitlines():
            parts = line.strip().split()
            name = parts[0].lstrip("/")
            if mgmt_ip in parts[1:]:
                return name
    except Exception:
        pass
    return None


# Brief: Queries ONOS for devices, extracts their management IPs, maps to container names and retrieves dp_desc to build {dp_desc: dpid}
def _discover_device_map() -> tuple[dict, dict]:
    url  = os.environ.get("ONOS_BASE_URL", "http://localhost:8181")
    auth = (os.environ.get("ONOSUSER", "karaf"), os.environ.get("ONOSPASS", "karaf"))
    resp = _req.get(f"{url}/onos/v1/devices", auth=auth, timeout=5)
    resp.raise_for_status()
    device_map = {}
    mgmt_ip_map = {}
    for dev in resp.json().get("devices", []):
        dpid = dev["id"]
        ann      = dev.get("annotations", {})
        mgmt_ip  = ann.get("managementAddress", "")
        if mgmt_ip:
            mgmt_ip_map[mgmt_ip] = dpid
        container = _mgmt_ip_to_container(mgmt_ip)
        if not container:
            continue
        try:
            desc = subprocess.check_output(
                f"docker exec {container} ovs-vsctl get bridge {container} other-config:dp-desc",
                shell=True, stderr=subprocess.DEVNULL
            ).decode().strip()
            if desc:
                device_map[desc] = dpid
                print(f" [CDN-QoE] {container} ({mgmt_ip}) -> {desc} = {dpid}")
        except Exception:
            pass
    return device_map, mgmt_ip_map


def normalizar_matriz_min_max(matriz):
    matriz = np.asarray(matriz)
    min_val = np.min(matriz); max_val = np.max(matriz)
    if max_val == min_val: return np.zeros(matriz.shape)
    return (matriz - min_val) / (max_val - min_val)


def normalizar_vetor(vetor):
    vetor = np.asarray(vetor, dtype=float)
    norma = np.linalg.norm(vetor)
    return vetor / norma if norma != 0 else vetor


def create_aij(a, nrttm, num_nodes):
    aij = [[0.0 for _ in range(num_nodes)] for _ in range(num_nodes)]
    for i in range(num_nodes):
        for j in range(num_nodes):
            aij[i][j] = float(a * nrttm[i][j])
    return aij


def get_dynamic_latencies():
    global ESTADOS, DEVICE_MAP, RTT_MATRIX, ADJ_MATRIX

    device_map, mgmt_ip_map = _discover_device_map()
    if not device_map:
        raise RuntimeError("ONOS returned no devices - topology unavailable")
    estados = list(device_map.keys())
    print(f" [CDN-QoE] Discovered {len(estados)} PoPs from ONOS: {estados}")

    n = len(estados)
    rtt_matrix = [[0.0 for _ in range(n)] for _ in range(n)]
    adj_matrix = [[0   for _ in range(n)] for _ in range(n)]

    rev_map = {v: k for k, v in device_map.items()}

    # Build adjacency from ONOS REST /links (topology, not telemetry)
    onos_url = os.environ.get("ONOS_BASE_URL", "http://localhost:8181")
    onos_auth = (os.environ.get("ONOSUSER", "karaf"), os.environ.get("ONOSPASS", "karaf"))
    try:
        resp = _req.get(f"{onos_url}/onos/v1/links", auth=onos_auth, timeout=5)
        resp.raise_for_status()
        for lnk in resp.json().get("links", []):
            if lnk.get("state") != "ACTIVE":
                continue
            src_dpid = lnk.get("src", {}).get("device", "")
            dst_dpid = lnk.get("dst", {}).get("device", "")
            src_st = rev_map.get(src_dpid)
            dst_st = rev_map.get(dst_dpid)
            if src_st and dst_st:
                adj_matrix[estados.index(src_st)][estados.index(dst_st)] = 1
    except Exception as e:
        print(f" [CDN-QoE] Failed to read links from ONOS REST: {e}")

    # Read link latencies from ClickHouse (collected by the collector)
    latencies = clickhouse_client.get_link_latencies()
    for (src, dst), latency_ms in latencies.items():
        src_st = rev_map.get(src)
        dst_st = rev_map.get(dst)
        if not dst_st and dst in mgmt_ip_map:
            dst_st = rev_map.get(mgmt_ip_map[dst])
        if src_st and dst_st:
            rtt_matrix[estados.index(src_st)][estados.index(dst_st)] = latency_ms

    ESTADOS    = estados
    DEVICE_MAP = device_map
    RTT_MATRIX = rtt_matrix
    ADJ_MATRIX = adj_matrix
    return estados, device_map, rtt_matrix, adj_matrix


def solve_shortest_path_with_constraints(source_uf: str, target_ufs: list[str], tx: list[float]):
    estados, _, rtt_matrix, adj_matrix = get_dynamic_latencies()
    print(f" [DEBUG SOLVER] Matriz de RTT usada: {rtt_matrix}")

    solver = pywraplp.Solver.CreateSolver("SCIP")
    num_nodes = len(rtt_matrix)
    source  = estados.index(source_uf)
    targets = [estados.index(uf) for uf in target_ufs]

    nrttm = normalizar_matriz_min_max(rtt_matrix)
    ntx   = normalizar_vetor(tx)
    a, b  = 0.75, 0.25

    best_qoe = float("inf")
    best_path, best_target = None, None
    all_edges = set()

    for t in range(len(targets)):
        x = {}
        for i in range(num_nodes):
            for j in range(num_nodes):
                if adj_matrix[i][j]:  # link exists (from ONOS topology, independent of RTT)
                    x[i, j] = solver.IntVar(0, 1, f"x_{i}_{j}")

        for v in range(num_nodes):
            if v == source:        constraint = solver.Constraint(-1, -1)
            elif v == targets[t]:  constraint = solver.Constraint(1, 1)
            else:                  constraint = solver.Constraint(0, 0)
            for i in range(num_nodes):
                if (i, v) in x: constraint.SetCoefficient(x[i, v], 1)
            for j in range(num_nodes):
                if (v, j) in x: constraint.SetCoefficient(x[v, j], -1)

        aij = create_aij(a, nrttm, num_nodes)
        obj = solver.Objective()
        for (i, j), var in x.items():
            obj.SetCoefficient(var, aij[i][j])
        obj.SetOffset(-b * ntx[t])
        obj.SetMinimization()

        if solver.Solve() == pywraplp.Solver.OPTIMAL:
            qoe  = solver.Objective().Value()
            path = [(i, j) for (i, j), var in x.items() if var.solution_value() > 0]
            all_edges.update(path)
            if qoe < best_qoe:
                best_qoe, best_target, best_path = qoe, targets[t], path
        solver.Clear()

    return source, best_target, best_qoe, best_path, list(all_edges)

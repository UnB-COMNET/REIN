import os
from typing import Optional
import requests as _req
import metrics as _metrics
import numpy as np
import networkx as nx
import matplotlib.pyplot as plt
from ortools.linear_solver import pywraplp
import subprocess
import re

IP_TO_ESTADO_CLIENTE: dict = {}
IP_TO_ESTADO_SERVIDOR: dict = {}

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
def _discover_device_map() -> dict:
    url  = os.environ.get("ONOS_BASE_URL", "http://localhost:8181")
    auth = (os.environ.get("ONOSUSER", "karaf"), os.environ.get("ONOSPASS", "karaf"))
    _metrics.increment("msgs_deployer_to_controller")
    resp = _req.get(f"{url}/onos/v1/devices", auth=auth, timeout=5)
    resp.raise_for_status()
    device_map = {}
    for dev in resp.json().get("devices", []):
        ann = dev.get("annotations", {})
        mgmt_ip = ann.get("managementAddress", "")
        container = _mgmt_ip_to_container(mgmt_ip)
        if not container:
            continue
        try:
            desc = subprocess.check_output(
                f"docker exec {container} ovs-vsctl get bridge {container} other-config:dp-desc",
                shell=True, stderr=subprocess.DEVNULL
            ).decode().strip()
            if desc:
                device_map[desc] = dev["id"]
        except Exception:
            pass
    return device_map


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


def _get_container_topology_ip(container_name: str) -> Optional[str]:
    try:
        out = subprocess.check_output(
            f"docker exec {container_name} ip -4 addr show"
            f" | grep 'inet 192\\.168\\.' | awk '{{print $2}}' | cut -d/ -f1",
            shell=True, stderr=subprocess.DEVNULL
        ).decode().strip().splitlines()
        return out[0] if out else None
    except Exception:
        return None


def _discover_host_pop_maps(rev_map: dict) -> tuple[dict, dict]:
    """Cross ONOS /hosts with Docker container names to build IP→PoP maps."""
    url  = os.environ.get("ONOS_BASE_URL", "http://localhost:8181")
    auth = (os.environ.get("ONOSUSER", "karaf"), os.environ.get("ONOSPASS", "karaf"))

    _metrics.increment("msgs_deployer_to_controller")
    resp = _req.get(f"{url}/onos/v1/hosts", auth=auth, timeout=5)
    resp.raise_for_status()

    ip_to_uf: dict = {}
    for host in resp.json().get("hosts", []):
        locations = host.get("locations", [])
        if not locations:
            continue
        dpid = locations[0].get("elementId", "")
        uf   = rev_map.get(dpid)
        if uf:
            for ip in host.get("ipAddresses", []):
                ip_to_uf[ip] = uf

    try:
        container_names = subprocess.check_output(
            "docker ps --format '{{.Names}}'",
            shell=True, stderr=subprocess.DEVNULL
        ).decode().strip().splitlines()
    except Exception:
        container_names = []

    clients: dict = {}
    servers: dict = {}
    for cname in container_names:
        if not re.match(r'^(cl|ds)\d+$', cname):
            continue
        ip = _get_container_topology_ip(cname)
        if not ip or ip not in ip_to_uf:
            continue
        uf = ip_to_uf[ip]
        if cname.startswith("cl"):
            clients[ip] = uf
        else:
            servers[ip] = uf

    return clients, servers


def get_dynamic_latencies():
    global ESTADOS, DEVICE_MAP, RTT_MATRIX, ADJ_MATRIX, IP_TO_ESTADO_CLIENTE, IP_TO_ESTADO_SERVIDOR

    device_map = _discover_device_map()
    if not device_map:
        raise RuntimeError("ONOS returned no devices - topology unavailable")
    estados = list(device_map.keys())

    n = len(estados)
    rtt_matrix = [[0.0 for _ in range(n)] for _ in range(n)]
    adj_matrix = [[0   for _ in range(n)] for _ in range(n)]

    karaf = os.environ.get(
        "ONOS_KARAF",
        "docker exec -t c1 /root/onos/apache-karaf-4.2.9/bin/client -u karaf -p karaf"
    )
    cmd_lat   = f"{karaf} 'link-latencies'"
    cmd_links = f"{karaf} 'links'"
    output_lat   = subprocess.check_output(cmd_lat,   shell=True, stderr=subprocess.STDOUT).decode("utf-8")
    output_links = subprocess.check_output(cmd_links, shell=True, stderr=subprocess.STDOUT).decode("utf-8")

    active_links = set()
    for line in output_links.splitlines():
        if "state=ACTIVE" in line:
            m = re.search(r"src=(of:[a-f0-9]+)/\d+, dst=(of:[a-f0-9]+)/\d+", line)
            if m:
                active_links.add((m.group(1), m.group(2)))

    rev_map = {v: k for k, v in device_map.items()}

    # Build adjacency from active links
    for src_dpid, dst_dpid in active_links:
        src_st = rev_map.get(src_dpid)
        dst_st = rev_map.get(dst_dpid)
        if src_st and dst_st:
            adj_matrix[estados.index(src_st)][estados.index(dst_st)] = 1

    # Fractional ms must be accepted: "--- 4.38ms" fails a \d+ match entirely,
    # so the link silently keeps 0.0 and the solver treats it as a free hop.
    pattern = r"src=(of:[a-f0-9]+)/\d+, dst=(of:[a-f0-9]+)/\d+.*--- (\d+(?:\.\d+)?)ms"
    for m in re.finditer(pattern, output_lat):
        src_dpid, dst_dpid = m.group(1), m.group(2)
        if (src_dpid, dst_dpid) not in active_links:
            continue
        src_st = rev_map.get(src_dpid)
        dst_st = rev_map.get(dst_dpid)
        if src_st and dst_st:
            rtt_matrix[estados.index(src_st)][estados.index(dst_st)] = float(m.group(3))

    ESTADOS    = estados
    DEVICE_MAP = device_map
    RTT_MATRIX = rtt_matrix
    ADJ_MATRIX = adj_matrix

    IP_TO_ESTADO_CLIENTE, IP_TO_ESTADO_SERVIDOR = _discover_host_pop_maps(rev_map)

    _log_topology_summary(estados, rtt_matrix, IP_TO_ESTADO_CLIENTE, IP_TO_ESTADO_SERVIDOR)

    return estados, device_map, rtt_matrix, adj_matrix


def _log_topology_summary(estados, rtt_matrix, clients, servers):
    print(f"[CDN-QoE] Topology: {len(estados)} PoPs | {len(servers)} server(s) | {len(clients)} client(s)")


def solve_shortest_path_with_constraints(source_uf: str, target_ufs: list[str], tx: list[float]):
    estados, rtt_matrix, adj_matrix = ESTADOS, RTT_MATRIX, ADJ_MATRIX

    solver = pywraplp.Solver.CreateSolver("SCIP")
    num_nodes = len(rtt_matrix)
    source  = estados.index(source_uf)
    targets = [estados.index(uf) for uf in target_ufs]

    nrttm = normalizar_matriz_min_max(rtt_matrix)
    ntx   = normalizar_vetor(tx)
    a, b  = 0.5, 0.5

    best_qoe = float("inf")
    best_path, best_target = None, None
    all_edges = set()

    for t in range(len(targets)):
        x = {}
        for i in range(num_nodes):
            for j in range(num_nodes):
                if adj_matrix[i][j]:
                    x[i, j] = solver.IntVar(0, 1, f"x_{i}_{j}")

        for v in range(num_nodes):
            balance = int(v == targets[t]) - int(v == source)
            constraint = solver.Constraint(balance, balance)
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

    if best_path is not None:
        hops = _path_indices_to_names(best_path, estados)
        print(f"[CDN-QoE] Best path: {' -> '.join(hops)}  |  server: {estados[best_target]}  |  QoE index: {best_qoe:.5f}")

    return source, best_target, best_qoe, best_path, list(all_edges)


def _path_indices_to_names(path: list[tuple], estados: list[str]) -> list[str]:
    if not path:
        return []
    ordered = []
    adj = {i: j for i, j in path}
    starts = {i for i, _ in path} - {j for _, j in path}
    cur = next(iter(starts)) if starts else path[0][0]
    while cur in adj:
        ordered.append(cur)
        cur = adj[cur]
    ordered.append(cur)
    return [estados[i] for i in ordered]

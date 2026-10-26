""" CdN-QoE latency discovery for the supervisor """

import logging
import os
import re
import subprocess
from typing import Optional

import numpy as np
import requests as _req
import app.metrics as _metrics
from ortools.linear_solver import pywraplp

logger = logging.getLogger(__name__)

ESTADOS: list = []
DEVICE_MAP: dict = {}
RTT_MATRIX: list = []
# Separate from RTT_MATRIX because `link-latencies` reports whole milliseconds:
# a sub-1ms link reads 0.0, indistinguishable from "no link".
ADJ_MATRIX: list = []
IP_TO_ESTADO_SERVIDOR: dict = {} # {server_ip: uf}


def _mgmt_ip_to_container(mgmt_ip: str) -> Optional[str]:
    try:
        out = subprocess.check_output(
            "docker inspect --format '{{.Name}} {{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' $(docker ps -q)",
            shell=True, stderr=subprocess.STDOUT,
        ).decode()
        for line in out.strip().splitlines():
            parts = line.strip().split()
            name = parts[0].lstrip("/")
            if mgmt_ip in parts[1:]:
                return name
        logger.debug("_mgmt_ip_to_container: IP %s not found among running containers", mgmt_ip)
    except subprocess.CalledProcessError as e:
        logger.error(
            "_mgmt_ip_to_container: docker command failed (is /var/run/docker.sock mounted?)\n  cmd output: %s",
            e.output.decode(errors="replace").strip(),
        )
    except Exception as e:
        logger.error("_mgmt_ip_to_container: unexpected error: %s", e)
    return None


def _discover_device_map() -> dict:
    onos_url = os.environ.get("ONOS_BASE_URL", "http://localhost:8181")
    auth = (os.environ.get("ONOSUSER", "karaf"), os.environ.get("ONOSPASS", "karaf"))
    _metrics.increment("msgs_onos_to_observer")
    resp = _req.get(f"{onos_url}/onos/v1/devices", auth=auth, timeout=5)
    resp.raise_for_status()

    devices = resp.json().get("devices", [])
    logger.debug("_discover_device_map: ONOS returned %d device(s)", len(devices))

    device_map = {}
    for dev in devices:
        dev_id  = dev["id"]
        mgmt_ip = dev.get("annotations", {}).get("managementAddress", "")
        container = _mgmt_ip_to_container(mgmt_ip)
        if not container:
            logger.warning("_discover_device_map: skipping %s (mgmt_ip=%s) — no matching container found", dev_id, mgmt_ip)
            continue
        try:
            desc = subprocess.check_output(
                f"docker exec {container} ovs-vsctl get bridge {container} other-config:dp-desc",
                shell=True, stderr=subprocess.STDOUT,
            ).decode().strip()
            if desc:
                device_map[desc] = dev_id
                logger.debug("_discover_device_map: mapped %s -> %s (container=%s)", desc, dev_id, container)
            else:
                logger.warning("_discover_device_map: container %s returned empty dp-desc for %s", container, dev_id)
        except subprocess.CalledProcessError as e:
            logger.error(
                "_discover_device_map: ovs-vsctl failed on container %s for device %s\n  cmd output: %s",
                container, dev_id, e.output.decode(errors="replace").strip(),
            )
        except Exception as e:
            logger.error("_discover_device_map: unexpected error for device %s: %s", dev_id, e)

    logger.debug("_discover_device_map: built map with %d entry(ies)", len(device_map))
    return device_map


def _get_container_topology_ip(container_name: str) -> Optional[str]:
    try:
        out = subprocess.check_output(
            f"docker exec {container_name} ip -4 addr show"
            f" | grep 'inet 192\\.168\\.' | awk '{{print $2}}' | cut -d/ -f1",
            shell=True, stderr=subprocess.DEVNULL,
        ).decode().strip().splitlines()
        return out[0] if out else None
    except Exception:
        return None


def _discover_server_pop_map(rev_map: dict) -> dict:
    onos_url = os.environ.get("ONOS_BASE_URL", "http://localhost:8181")
    auth = (os.environ.get("ONOSUSER", "karaf"), os.environ.get("ONOSPASS", "karaf"))
    try:
        _metrics.increment("msgs_onos_to_observer")
        hosts = _req.get(f"{onos_url}/onos/v1/hosts", auth=auth, timeout=5).json().get("hosts", [])
    except Exception as e:
        logger.error("_discover_server_pop_map: failed to query /hosts: %s", e)
        return {}

    ip_to_uf: dict = {}
    for host in hosts:
        locs = host.get("locations", [])
        if not locs:
            continue
        uf = rev_map.get(locs[0].get("elementId", ""))
        if uf:
            for ip in host.get("ipAddresses", []):
                ip_to_uf[ip] = uf

    servers: dict = {}
    try:
        container_names = subprocess.check_output(
            "docker ps --format '{{.Names}}'", shell=True, stderr=subprocess.DEVNULL,
        ).decode().strip().splitlines()
    except Exception:
        container_names = []

    for cname in container_names:
        if not re.match(r'^ds\d+$', cname):
            continue
        ip = _get_container_topology_ip(cname)
        if ip and ip in ip_to_uf:
            servers[ip] = ip_to_uf[ip]

    logger.debug("_discover_server_pop_map: %d server(s) found", len(servers))
    return servers


# Brief: Discovers ESTADOS and DEVICE_MAP from ONOS at runtime, then reads link-latencies to populate RTT_MATRIX
def get_dynamic_latencies():
    global ESTADOS, DEVICE_MAP, RTT_MATRIX, ADJ_MATRIX, IP_TO_ESTADO_SERVIDOR

    device_map = _discover_device_map()
    if not device_map:
        raise RuntimeError("[CdN-QoE] ONOS returned no devices - topology unavailable")

    estados   = list(device_map.keys())
    rtt_matrix = [[0.0 for _ in estados] for _ in estados]
    adj_matrix = [[0 for _ in estados] for _ in estados]

    karaf = os.environ.get(
        "ONOS_KARAF",
        "docker exec -t c1 /root/onos/apache-karaf-4.2.9/bin/client -u karaf -p karaf",
    )
    try:
        output_lat   = subprocess.check_output(f"{karaf} 'link-latencies'", shell=True, stderr=subprocess.STDOUT).decode()
        output_links = subprocess.check_output(f"{karaf} 'links'",          shell=True, stderr=subprocess.STDOUT).decode()

        rev_map = {v: k for k, v in device_map.items()}

        active_links = set()
        for line in output_links.splitlines():
            if "state=ACTIVE" in line:
                m = re.search(r"src=(of:[a-f0-9]+)/\d+, dst=(of:[a-f0-9]+)/\d+", line)
                if m:
                    active_links.add((m.group(1), m.group(2)))
                    src_st, dst_st = rev_map.get(m.group(1)), rev_map.get(m.group(2))
                    if src_st and dst_st:
                        adj_matrix[estados.index(src_st)][estados.index(dst_st)] = 1

        # Fractional ms must be accepted: "--- 4.38ms" fails a \d+ match entirely,
        # so the link silently keeps the 0.0 it was initialised with and the
        # solver treats it as a free hop.
        pattern = r"src=(of:[a-f0-9]+)/\d+, dst=(of:[a-f0-9]+)/\d+.*--- (\d+(?:\.\d+)?)ms"
        for m in re.finditer(pattern, output_lat):
            src_dpid, dst_dpid = m.group(1), m.group(2)
            if (src_dpid, dst_dpid) not in active_links:
                continue
            src_st = rev_map.get(src_dpid)
            dst_st = rev_map.get(dst_dpid)
            if src_st and dst_st:
                rtt_matrix[estados.index(src_st)][estados.index(dst_st)] = float(m.group(3))

    except Exception as e:
        logger.error("get_dynamic_latencies: failed to read link latencies: %s", e)

    ESTADOS    = estados
    DEVICE_MAP = device_map
    RTT_MATRIX = rtt_matrix
    ADJ_MATRIX = adj_matrix

    rev_map = {v: k for k, v in device_map.items()}
    IP_TO_ESTADO_SERVIDOR.clear()
    IP_TO_ESTADO_SERVIDOR.update(_discover_server_pop_map(rev_map))


# The deployer's solver, copied verbatim from deployer/services/cdn_qoe.py: the
# best-path mode has to ask what the deployer would pick right now, so it needs
# the same objective, not an approximation of it.

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


def solve_shortest_path_with_constraints(source_uf: str, target_ufs: list, tx: list):
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

    return source, best_target, best_qoe, best_path, list(all_edges)


def path_indices_to_names(path: list, estados: list) -> list:
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

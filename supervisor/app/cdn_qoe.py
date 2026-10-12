""" CdN-QoE latency discovery for the supervisor

Reads link latencies from ClickHouse (collected by the collector) instead of
querying ONOS Karaf CLI directly. Topology discovery still uses ONOS REST
"""

import os
import subprocess
from typing import Optional

import requests as _req

from app import clickhouse_client

ESTADOS: list    = []
DEVICE_MAP: dict = {}
RTT_MATRIX: list = []


def _mgmt_ip_to_container(mgmt_ip: str) -> Optional[str]:
    try:
        out = subprocess.check_output(
            "docker inspect --format '{{.Name}} {{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' $(docker ps -q)",
            shell=True, stderr=subprocess.DEVNULL,
        ).decode()
        for line in out.strip().splitlines():
            parts = line.strip().split()
            name = parts[0].lstrip("/")
            if mgmt_ip in parts[1:]:
                return name
    except Exception:
        pass
    return None


def _discover_device_map() -> tuple[dict, dict]:
    """Discover device map from ONOS REST

    Returns (device_map: {dp_desc: dpid}, mgmt_ip_map: {mgmt_ip: dpid})
    """
    onos_url = os.environ.get("ONOS_BASE_URL", "http://localhost:8181")
    auth = (os.environ.get("ONOSUSER", "karaf"), os.environ.get("ONOSPASS", "karaf"))
    resp = _req.get(f"{onos_url}/onos/v1/devices", auth=auth, timeout=5)
    resp.raise_for_status()
    device_map = {}
    mgmt_ip_map = {}
    for dev in resp.json().get("devices", []):
        dpid = dev["id"]
        mgmt_ip = dev.get("annotations", {}).get("managementAddress", "")
        if mgmt_ip:
            mgmt_ip_map[mgmt_ip] = dpid
        container = _mgmt_ip_to_container(mgmt_ip)
        if not container:
            continue
        try:
            desc = subprocess.check_output(
                f"docker exec {container} ovs-vsctl get bridge {container} other-config:dp-desc",
                shell=True, stderr=subprocess.DEVNULL,
            ).decode().strip()
            if desc:
                device_map[desc] = dpid
        except Exception:
            pass
    return device_map, mgmt_ip_map


def get_dynamic_latencies():
    """Discover topology from ONOS, read latencies from ClickHouse"""
    global ESTADOS, DEVICE_MAP, RTT_MATRIX

    device_map, mgmt_ip_map = _discover_device_map()
    if not device_map:
        raise RuntimeError("[CdN-QoE] ONOS returned no devices — topology unavailable")

    estados = list(device_map.keys())
    rtt_matrix = [[0.0 for _ in estados] for _ in estados]

    rev_map = {v: k for k, v in device_map.items()}

    # Read link latencies from ClickHouse (collected by the collector)
    latencies = clickhouse_client.get_link_latencies()

    for (src, dst), latency_ms in latencies.items():
        src_st = rev_map.get(src)
        dst_st = rev_map.get(dst)
        if not dst_st and dst in mgmt_ip_map:
            dst_st = rev_map.get(mgmt_ip_map[dst])
        if src_st and dst_st:
            i, j = estados.index(src_st), estados.index(dst_st)
            rtt_matrix[i][j] = latency_ms

    ESTADOS = estados
    DEVICE_MAP = device_map
    RTT_MATRIX = rtt_matrix

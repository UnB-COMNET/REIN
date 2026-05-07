""" CdN-QoE latency discovery for the supervisor """

import os
import re
import subprocess
from typing import Optional

import requests as _req

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


def _discover_device_map() -> dict:
    onos_url = os.environ.get("ONOS_BASE_URL", "http://localhost:8181")
    auth = (os.environ.get("ONOSUSER", "karaf"), os.environ.get("ONOSPASS", "karaf"))
    resp = _req.get(f"{onos_url}/onos/v1/devices", auth=auth, timeout=5)
    resp.raise_for_status()
    device_map = {}
    for dev in resp.json().get("devices", []):
        mgmt_ip  = dev.get("annotations", {}).get("managementAddress", "")
        container = _mgmt_ip_to_container(mgmt_ip)
        if not container:
            continue
        try:
            desc = subprocess.check_output(
                f"docker exec {container} ovs-vsctl get bridge {container} other-config:dp-desc",
                shell=True, stderr=subprocess.DEVNULL,
            ).decode().strip()
            if desc:
                device_map[desc] = dev["id"]
        except Exception:
            pass
    return device_map


# Brief: Discovers ESTADOS and DEVICE_MAP from ONOS at runtime, then reads link-latencies to populate RTT_MATRIX
def get_dynamic_latencies():
    global ESTADOS, DEVICE_MAP, RTT_MATRIX

    device_map = _discover_device_map()
    if not device_map:
        raise RuntimeError("[CdN-QoE] ONOS returned no devices — topology unavailable")

    estados   = list(device_map.keys())
    rtt_matrix = [[0.0 for _ in estados] for _ in estados]

    karaf = os.environ.get(
        "ONOS_KARAF",
        "docker exec -t c1 /root/onos/apache-karaf-4.2.9/bin/client -u karaf -p karaf",
    )
    try:
        output_lat   = subprocess.check_output(f"{karaf} 'link-latencies'", shell=True, stderr=subprocess.STDOUT).decode()
        output_links = subprocess.check_output(f"{karaf} 'links'",          shell=True, stderr=subprocess.STDOUT).decode()

        active_links = set()
        for line in output_links.splitlines():
            if "state=ACTIVE" in line:
                m = re.search(r"src=(of:[a-f0-9]+)/\d+, dst=(of:[a-f0-9]+)/\d+", line)
                if m:
                    active_links.add((m.group(1), m.group(2)))

        rev_map = {v: k for k, v in device_map.items()}
        pattern = r"src=(of:[a-f0-9]+)/\d+, dst=(of:[a-f0-9]+)/\d+.*--- (\d+)ms"
        for m in re.finditer(pattern, output_lat):
            src_dpid, dst_dpid = m.group(1), m.group(2)
            if (src_dpid, dst_dpid) not in active_links:
                continue
            src_st = rev_map.get(src_dpid)
            dst_st = rev_map.get(dst_dpid)
            if src_st and dst_st:
                rtt_matrix[estados.index(src_st)][estados.index(dst_st)] = float(m.group(3))

    except Exception as e:
        print(f"[CdN-QoE] Failed to read link latencies: {e}")

    ESTADOS    = estados
    DEVICE_MAP = device_map
    RTT_MATRIX = rtt_matrix

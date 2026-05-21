import logging
import re
import subprocess
from dataclasses import dataclass, field
from typing import Optional

import requests as _req

from collector import config
from collector import metrics

logger = logging.getLogger(__name__)


@dataclass
class TopologyState:
    estados: list = field(default_factory=list)
    device_map: dict = field(default_factory=dict)
    rtt_matrix: list = field(default_factory=list)


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
    auth = (config.ONOS_USER, config.ONOS_PASS)
    metrics.increment("msgs_onos_to_observer")
    resp = _req.get(f"{config.ONOS_BASE_URL}/onos/v1/devices", auth=auth, timeout=5)
    resp.raise_for_status()
    device_map = {}
    for dev in resp.json().get("devices", []):
        mgmt_ip = dev.get("annotations", {}).get("managementAddress", "")
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


def get_dynamic_latencies() -> TopologyState:
    device_map = _discover_device_map()
    if not device_map:
        raise RuntimeError("[Collector] ONOS returned no devices — topology unavailable")

    estados = list(device_map.keys())
    rtt_matrix = [[0.0 for _ in estados] for _ in estados]

    try:
        metrics.increment("msgs_onos_to_observer", 2)
        output_lat = subprocess.check_output(
            f"{config.ONOS_KARAF} 'link-latencies'", shell=True, stderr=subprocess.STDOUT,
        ).decode()
        output_links = subprocess.check_output(
            f"{config.ONOS_KARAF} 'links'", shell=True, stderr=subprocess.STDOUT,
        ).decode()

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
        logger.error("Failed to read link latencies: %s", e)

    return TopologyState(estados=estados, device_map=device_map, rtt_matrix=rtt_matrix)

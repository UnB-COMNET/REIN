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
class DeviceInfo:
    id: str
    type: str
    available: bool
    annotations: dict = field(default_factory=dict)


@dataclass
class LinkInfo:
    src_device: str
    src_port: int
    dst_device: str
    dst_port: int
    state: str
    type: str
    latency_ms: Optional[float] = None


def _onos_auth():
    return (config.ONOS_USER, config.ONOS_PASS)


def fetch_devices() -> dict[str, DeviceInfo]:
    metrics.increment("msgs_onos_to_observer")
    resp = _req.get(f"{config.ONOS_BASE_URL}/onos/v1/devices", auth=_onos_auth(), timeout=5)
    resp.raise_for_status()
    devices = {}
    for dev in resp.json().get("devices", []):
        dev_id = dev["id"]
        devices[dev_id] = DeviceInfo(
            id=dev_id,
            type=dev.get("type", "UNKNOWN"),
            available=dev.get("available", False),
            annotations=dev.get("annotations", {}),
        )
    logger.debug("Fetched %d devices", len(devices))
    return devices


def fetch_links() -> list[LinkInfo]:
    metrics.increment("msgs_onos_to_observer")
    resp = _req.get(f"{config.ONOS_BASE_URL}/onos/v1/links", auth=_onos_auth(), timeout=5)
    resp.raise_for_status()
    links = []
    for lnk in resp.json().get("links", []):
        src = lnk.get("src", {})
        dst = lnk.get("dst", {})
        link = LinkInfo(
            src_device=src.get("device", ""),
            src_port=int(src.get("port", 0)),
            dst_device=dst.get("device", ""),
            dst_port=int(dst.get("port", 0)),
            state=lnk.get("state", "UNKNOWN"),
            type=lnk.get("type", "UNKNOWN"),
        )
        latency_str = lnk.get("annotations", {}).get("latency")
        if latency_str is not None:
            try:
                link.latency_ms = float(latency_str)
            except ValueError:
                pass
        links.append(link)
    active = [l for l in links if l.state == "ACTIVE"]
    logger.debug("Fetched %d links (%d active)", len(links), len(active))
    return active


def fetch_link_latencies_cli(active_links: list[LinkInfo]) -> dict[tuple[str, str], float]:
    metrics.increment("msgs_onos_to_observer")
    try:
        output = subprocess.check_output(
            f"{config.ONOS_KARAF} 'link-latencies'", shell=True, stderr=subprocess.PIPE,
        ).decode()
    except subprocess.CalledProcessError as e:
        logger.error("link-latencies CLI failed (rc=%d): %s", e.returncode, e.stderr.decode(errors="replace") if e.stderr else "")
        return {}
    except Exception as e:
        logger.error("link-latencies CLI unexpected error: %s", e)
        return {}

    active_set = {(l.src_device, l.dst_device) for l in active_links}
    latencies: dict[tuple[str, str], float] = {}
    pattern = r"src=(of:[a-f0-9]+)/\d+, dst=(of:[a-f0-9]+)/\d+.*--- (\d+)ms"
    for m in re.finditer(pattern, output):
        src_dpid, dst_dpid = m.group(1), m.group(2)
        if (src_dpid, dst_dpid) in active_set:
            latencies[(src_dpid, dst_dpid)] = float(m.group(3))
    logger.debug("CLI latencies resolved for %d links", len(latencies))
    return latencies


def build_topology() -> tuple[dict[str, DeviceInfo], list[LinkInfo]]:
    devices = fetch_devices()
    if not devices:
        raise RuntimeError("[Collector] ONOS returned no devices — topology unavailable")

    links = fetch_links()
    cli_latencies = fetch_link_latencies_cli(links)

    for link in links:
        if link.latency_ms is not None:
            continue
        key = (link.src_device, link.dst_device)
        if key in cli_latencies:
            link.latency_ms = cli_latencies[key]

    resolved = sum(1 for l in links if l.latency_ms is not None)
    logger.info("Topology: %d devices, %d active links (%d with latency)", len(devices), len(links), resolved)
    return devices, links

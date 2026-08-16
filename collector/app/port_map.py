"""Interface-name -> port-number mapping for gNMI-sourced metrics

gNMI paths key on interface names (e.g. ``eth0``); ONOS / ClickHouse use
integer port numbers.  This module bridges the two by querying ONOS
``/devices/{id}/ports`` for the ``portName`` annotation, so ``sdn.port.*``
attributes stay consistent with existing data
"""
import logging
import threading

import requests

from collector import config
from collector import metrics

logger = logging.getLogger(__name__)


def fetch_port_map(device_id: str) -> dict[str, int]:
    """Query ONOS for a device's ports and build {interface_name: port_number}

    Returns an empty dict on error (the caller skips gNMI updates for unmapped
    interfaces)
    """
    auth = (config.ONOS_USER, config.ONOS_PASS)
    metrics.increment("msgs_onos_to_collector")
    url = f"{config.ONOS_BASE_URL}/onos/v1/devices/{device_id}/ports"
    try:
        resp = requests.get(url, auth=auth, timeout=5)
        resp.raise_for_status()
    except Exception as e:
        logger.error("Port map fetch failed for %s: %s", device_id, e)
        return {}

    mapping: dict[str, int] = {}
    for p in resp.json().get("ports", []):
        try:
            port_num = int(p.get("port", 0))
        except (TypeError, ValueError):
            continue
        if port_num == 0:
            continue
        port_name = (p.get("annotations") or {}).get("portName")
        if not port_name:
            # Convention fallback: OVS port N -> {prefix}{N-1} (e.g. 1 -> eth0)
            port_name = f"{config.GNMI_IFACE_PREFIX}{port_num - 1}"
        mapping[port_name] = port_num

    logger.debug("Port map for %s: %s", device_id, mapping)
    return mapping


class PortMapCache:
    """Thread-safe {device_id: {iface_name: port_number}} cache

    The main ONOS poll thread writes (refresh); gNMI background threads read
    """

    def __init__(self):
        self._lock = threading.Lock()
        self._maps: dict[str, dict[str, int]] = {}

    def update(self, device_id: str, mapping: dict[str, int]) -> None:
        with self._lock:
            self._maps[device_id] = mapping

    def get(self, device_id: str) -> dict[str, int]:
        with self._lock:
            return dict(self._maps.get(device_id, {}))

    def remove(self, device_id: str) -> None:
        with self._lock:
            self._maps.pop(device_id, None)

    def clear(self) -> None:
        with self._lock:
            self._maps.clear()

import logging
from dataclasses import dataclass
from typing import Optional

import requests

from collector import config
from collector import metrics

logger = logging.getLogger(__name__)


@dataclass
class FlowInfo:
    device_id: str
    flow_id: str
    app_id: str
    table_id: int
    priority: int
    state: str
    life: int
    packets: int
    bytes: int
    selector_summary: str
    output_port: Optional[int] = None


def _summarize_selector(criteria: list[dict]) -> str:
    parts = []
    for c in criteria:
        ctype = c.get("type", "")
        if ctype == "IN_PORT":
            parts.append(f"IN_PORT:{c.get('port', '?')}")
        elif ctype == "ETH_TYPE":
            parts.append(f"ETH_TYPE:{c.get('ethType', '?')}")
        elif ctype == "ETH_DST":
            parts.append(f"ETH_DST:{c.get('mac', '?')}")
        elif ctype == "IPV4_DST":
            parts.append(f"IPV4_DST:{c.get('ip', '?')}")
        elif ctype == "IPV4_SRC":
            parts.append(f"IPV4_SRC:{c.get('ip', '?')}")
        elif ctype == "UDP_DST":
            parts.append(f"UDP_DST:{c.get('port', '?')}")
        elif ctype == "TCP_DST":
            parts.append(f"TCP_DST:{c.get('port', '?')}")
        else:
            parts.append(ctype)
    return ",".join(parts)


def _extract_output_port(treatment: dict) -> Optional[int]:
    for instr in treatment.get("instructions", []):
        if instr.get("type") == "OUTPUT":
            try:
                return int(instr.get("port", -1))
            except (ValueError, TypeError):
                return None
    return None


def fetch_flows(device_ids: list[str]) -> dict[str, list[FlowInfo]]:
    auth = (config.ONOS_USER, config.ONOS_PASS)
    result: dict[str, list[FlowInfo]] = {}

    for device_id in device_ids:
        try:
            metrics.increment("msgs_onos_to_collector")
            url = f"{config.ONOS_BASE_URL}/onos/v1/flows/{device_id}"
            resp = requests.get(url, auth=auth, timeout=5)
            resp.raise_for_status()
            flows_data = resp.json().get("flows", [])
            flow_list = []
            for f in flows_data:
                if f.get("state") != "ADDED":
                    continue
                criteria = f.get("selector", {}).get("criteria", [])
                treatment = f.get("treatment", {})
                flow_list.append(FlowInfo(
                    device_id=device_id,
                    flow_id=f.get("id", ""),
                    app_id=f.get("appId", ""),
                    table_id=f.get("tableId", 0),
                    priority=f.get("priority", 0),
                    state=f.get("state", "UNKNOWN"),
                    life=f.get("life", 0),
                    packets=f.get("packets", 0),
                    bytes=f.get("bytes", 0),
                    selector_summary=_summarize_selector(criteria),
                    output_port=_extract_output_port(treatment),
                ))
            result[device_id] = flow_list
            logger.debug("Fetched %d active flows for %s", len(flow_list), device_id)
        except Exception as e:
            logger.error("Flow fetch failed for %s: %s", device_id, e)
            result[device_id] = []

    return result

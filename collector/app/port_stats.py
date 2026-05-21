import collections
import logging
import time
from dataclasses import dataclass

import requests

from collector import config
from collector import metrics

logger = logging.getLogger(__name__)


@dataclass
class PortStats:
    port: int
    packets_received: int
    packets_sent: int
    bytes_received: int
    bytes_sent: int
    packets_rx_dropped: int
    packets_tx_dropped: int
    packets_rx_errors: int
    packets_tx_errors: int
    duration_sec: int


@dataclass
class PortThroughput:
    bps_sent: float
    bps_received: float
    window_size: int


@dataclass
class _PortState:
    last_bytes_sent: int | None = None
    last_bytes_received: int | None = None
    last_time: float | None = None
    samples_sent: collections.deque = None
    samples_received: collections.deque = None

    def __post_init__(self):
        if self.samples_sent is None:
            self.samples_sent = collections.deque(maxlen=config.STATS_WINDOW)
        if self.samples_received is None:
            self.samples_received = collections.deque(maxlen=config.STATS_WINDOW)


class ThroughputTracker:
    def __init__(self):
        self._states: dict[str, dict[int, _PortState]] = {}

    def _get_state(self, device_id: str, port: int) -> _PortState:
        device_ports = self._states.setdefault(device_id, {})
        if port not in device_ports:
            device_ports[port] = _PortState()
        return device_ports[port]

    def update(self, device_id: str, stats: PortStats) -> PortThroughput:
        state = self._get_state(device_id, stats.port)
        now = time.time()

        bps_sent = 0.0
        bps_received = 0.0

        if state.last_time is not None and state.last_bytes_sent is not None:
            dt = now - state.last_time
            if dt > 0:
                if stats.bytes_sent != state.last_bytes_sent:
                    bps_sent = (stats.bytes_sent - state.last_bytes_sent) * 8 / dt
                if stats.bytes_received != state.last_bytes_received:
                    bps_received = (stats.bytes_received - state.last_bytes_received) * 8 / dt

        state.last_bytes_sent = stats.bytes_sent
        state.last_bytes_received = stats.bytes_received
        state.last_time = now

        state.samples_sent.append(bps_sent)
        state.samples_received.append(bps_received)

        avg_sent = sum(state.samples_sent) / len(state.samples_sent)
        avg_received = sum(state.samples_received) / len(state.samples_received)

        return PortThroughput(
            bps_sent=avg_sent,
            bps_received=avg_received,
            window_size=len(state.samples_sent),
        )


def fetch_port_stats(device_ids: list[str]) -> dict[str, list[PortStats]]:
    auth = (config.ONOS_USER, config.ONOS_PASS)
    result: dict[str, list[PortStats]] = {}

    for device_id in device_ids:
        try:
            metrics.increment("msgs_onos_to_observer")
            url = f"{config.ONOS_BASE_URL}/statistics/ports/{device_id}"
            resp = requests.get(url, auth=auth, timeout=5)
            resp.raise_for_status()
            ports_data = resp.json()["statistics"][0]["ports"]
            stats_list = []
            for p in ports_data:
                stats_list.append(PortStats(
                    port=p["port"],
                    packets_received=p.get("packetsReceived", 0),
                    packets_sent=p.get("packetsSent", 0),
                    bytes_received=p.get("bytesReceived", 0),
                    bytes_sent=p.get("bytesSent", 0),
                    packets_rx_dropped=p.get("packetsRxDropped", 0),
                    packets_tx_dropped=p.get("packetsTxDropped", 0),
                    packets_rx_errors=p.get("packetsRxErrors", 0),
                    packets_tx_errors=p.get("packetsTxErrors", 0),
                    duration_sec=p.get("durationSec", 0),
                ))
            result[device_id] = stats_list
        except Exception as e:
            logger.error("Port stats fetch failed for %s: %s", device_id, e)
            result[device_id] = []

    return result

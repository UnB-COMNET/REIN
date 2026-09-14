""" Per-flow throughput measurement """

import collections
import logging
import time

import requests

from app import cdn_qoe
import app.metrics as _metrics

logger = logging.getLogger(__name__)

WINDOW = 5 # sliding-window size for throughput average
MAX_STALE_READS = 3 # tolerate this many unchanged flow-byte reads (ONOS's own
                     # stats poller lagging) before accepting one as a real 0


class ThroughputProbe:
    """
    Byte-counter state for ONE client flow on ONE server. The monitor REPLACES
    this object when a new path arrives instead of clearing it, so a cycle still
    in flight keeps writing to the old window and can never fold a sample
    measured against the previous server into the new one.
    """

    __slots__ = ("client_ip", "server_uf", "onos_base_url", "tag",
                 "_last_bytes", "_last_time", "_stale_reads", "_samples")

    def __init__(self, client_ip: str, server_uf: str, onos_base_url: str, tag: str = ""):
        self.client_ip = client_ip
        self.server_uf = server_uf
        self.onos_base_url = onos_base_url
        self.tag = tag
        self._last_bytes = None
        self._last_time = None
        self._stale_reads = 0
        self._samples = collections.deque(maxlen=WINDOW)

    @property
    def window(self) -> int:
        return len(self._samples)

    # Brief: True once the window is full. Until then the average is not
    # representative and the caller must not quantize it.
    @property
    def warm(self) -> bool:
        return self.window == WINDOW

    # Brief: Moving-average throughput in bit/s, read from this client's own flow
    # rule on the server's access switch -- not the port's aggregate counter, so
    # co-tenants on that link don't dilute it.
    def read_bps(self) -> float:
        if self.server_uf not in cdn_qoe.DEVICE_MAP:
            logger.warning("%s server_uf '%s' not in DEVICE_MAP — skipping", self.tag, self.server_uf)
            return 0.0

        server_ip = next((ip for ip, uf in cdn_qoe.IP_TO_ESTADO_SERVIDOR.items()
                          if uf == self.server_uf), None)
        device_id = cdn_qoe.DEVICE_MAP[self.server_uf]
        try:
            _metrics.increment("msgs_onos_to_observer")
            url = f"{self.onos_base_url}/flows/{device_id}"
            flows = requests.get(url, auth=("onos", "rocks"), timeout=5).json().get("flows", [])
            flow = next((f for f in flows if self._is_own_flow(f, server_ip)), None)

            if flow is None:
                logger.warning("%s no A->B flow rule found on device %s (%s)",
                               self.tag, device_id, self.server_uf)
                return 0.0

            return self._fold(flow["bytes"], time.time())

        except Exception as e:
            logger.error("%s throughput error: %s", self.tag, e)
            return 0.0

    # Brief: Folds one byte-counter read into the window and returns its average
    def _fold(self, b2: int, t2: float) -> float:
        if self._last_bytes is None:
            self._last_bytes, self._last_time = b2, t2
            return 0.0

        if b2 == self._last_bytes and self._stale_reads < MAX_STALE_READS:
            # ONOS's flow-stats poller lags the monitor interval, so an unchanged
            # counter usually means it hasn't re-read the switch, not that traffic
            # stopped. Skip without touching the clock, but only for a few cycles,
            # or a real 0 would read as "warming up" forever.
            self._stale_reads += 1
            return self._average()

        self._stale_reads = 0
        bps = (b2 - self._last_bytes) * 8 / (t2 - self._last_time)
        self._last_bytes, self._last_time = b2, t2
        self._samples.append(bps)
        return self._average()

    def _average(self) -> float:
        return sum(self._samples) / len(self._samples) if self._samples else 0.0

    # Brief: True if this flow's selector is exactly this client's forward rule.
    #   criteria = [{"type": "IPV4_SRC", "ip": "192.168.0.11/32"},
    #               {"type": "IPV4_DST", "ip": "192.168.0.21/32"}]
    def _is_own_flow(self, flow: dict, server_ip: str) -> bool:
        criteria = flow.get("selector", {}).get("criteria", [])
        ips = {c["type"]: c["ip"].split("/")[0] for c in criteria if "ip" in c}
        return ips.get("IPV4_SRC") == self.client_ip and ips.get("IPV4_DST") == server_ip

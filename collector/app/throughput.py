import collections
import logging
import time

import requests

from collector import config
from collector import metrics

logger = logging.getLogger(__name__)


class ThroughputMeasurer:
    def __init__(self):
        self._last_bytes = None
        self._last_bytes_time = None
        self._samples = collections.deque(maxlen=config.THROUGHPUT_WINDOW)

    def measure(self, device_id: str) -> float:
        url = f"{config.ONOS_BASE_URL}/statistics/ports/{device_id}"
        auth = ("onos", "rocks")

        try:
            metrics.increment("msgs_onos_to_observer")
            ports = requests.get(url, auth=auth, timeout=5).json()["statistics"][0]["ports"]
            port = next((p for p in ports if p["port"] == config.THROUGHPUT_PORT), None)

            if port is None:
                logger.warning("Port %d not found on device statistics", config.THROUGHPUT_PORT)
                return 0.0

            b2 = port["bytesSent"]
            t2 = time.time()

            if self._last_bytes is None:
                self._last_bytes = b2
                self._last_bytes_time = t2
                return 0.0

            if b2 == self._last_bytes:
                bps = 0.0
            else:
                bps = (b2 - self._last_bytes) * 8 / (t2 - self._last_bytes_time)

            self._last_bytes = b2
            self._last_bytes_time = t2

            self._samples.append(bps)
            return sum(self._samples) / len(self._samples)

        except Exception as e:
            logger.error("Throughput measure error: %s", e)
            return 0.0

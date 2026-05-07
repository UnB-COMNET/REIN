""" Supervisor monitoring service """

import collections
import logging
import threading
import time

import requests

from app import cdn_qoe, quantization
import app.metrics as _metrics

logger = logging.getLogger(__name__)

MONITOR_INTERVAL = 5 # seconds
THROUGHPUT_WINDOW = 5 # number of samples for the moving average

class SupervisorService:
    def __init__(self, onos_base_url: str, deployer_base_url: str):
        self.onos_base_url = onos_base_url
        self.deployer_base_url = deployer_base_url

        self._last_bytes = None
        self._last_bytes_time = None
        self._throughput_samples = collections.deque(maxlen=THROUGHPUT_WINDOW)
        self._path = None
        self._path_estados = None # used to resolve path indices
        self._server_uf = None # target UF 
        self._access_delay_ms = 0.0

        self._timer = None
        self._lock = threading.Lock()

    # Brief: Stores the current path sent by the deployer and starts the monitor loop
    def update(self, path: list, access_delay_ms: float = 0.0, estados: list = None, target_ufs: list = None):
        with self._lock:
            self._path = path
            self._path_estados = estados
            self._server_uf = target_ufs[0] if target_ufs else None
            self._access_delay_ms = access_delay_ms
            self._throughput_samples.clear()
            self._last_bytes = None
            self._last_bytes_time = None

        logger.info("New path received: %s  estados=%s  (access_delay=%.1f ms)", path, estados, access_delay_ms)
        self._restart_monitor()

    # Brief: Cancels any running timer and schedules a fresh monitor cycle
    def _restart_monitor(self):
        if self._timer is not None:
            self._timer.cancel()
        self._schedule_next()

    # Brief: Schedules the next monitor cycle after MONITOR_INTERVAL seconds
    def _schedule_next(self):
        self._timer = threading.Timer(MONITOR_INTERVAL, self._monitor_cycle)
        self._timer.daemon = True
        self._timer.start()

    # Brief: Every MONITOR_INTERVAL seconds: measures delay and throughput (moving avg),
    # quantizes each KPI (P9 → P3) and triggers recalculate when overall health is Critical.
    def _monitor_cycle(self):
        with self._lock:
            if self._path is None:
                return
            current_path = list(self._path)
            access_delay_ms = self._access_delay_ms
            path_estados = self._path_estados
            server_uf    = self._server_uf

        try:
            delay_ms = self._measure_path_delay(current_path, access_delay_ms, path_estados)
            throughput_avg_bps = self._measure_path_throughput(server_uf)

            throughput_mbps = throughput_avg_bps / 1e6
            logger.info(
                "delay=%.1f ms | throughput_avg=%.2f Mbit/s (window=%d)",
                delay_ms, throughput_mbps, len(self._throughput_samples),
            )

            kpis = {"RTT_ms": delay_ms}
            if len(self._throughput_samples) == THROUGHPUT_WINDOW:
                kpis["Vazao_Mbps"] = throughput_mbps

            overall, details = quantization.evaluate_service_health(kpis)

            for kpi_name, r in details.items():
                logger.info(
                    "KPI %-12s = %7.2f %s  →  P9=%+d (%s)  →  P3=%+d (%s)",
                    kpi_name, r.value,
                    quantization.POLICIES[kpi_name]["unit"],
                    r.p9, r.p9_label, r.p3, r.p3_label,
                )

            drifted = [
                f"{n}={r.value:.2f} P9={r.p9:+d} ({r.p9_label})"
                for n, r in details.items() if r.p3 < 1
            ]

            if overall == 0:
                logger.warning("Service health WARNING - drift: %s", ", ".join(drifted))

            if overall == -1:
                logger.warning("*** Service health CRITICAL - drift: %s → recalculate ***", ", ".join(drifted))
                degrade_ts = _metrics.get_value("degrade_ts")
                if degrade_ts is not None and _metrics.get_value("detection_time_s") is None:
                    _metrics.set_value("detection_time_s", time.time() - degrade_ts)
                _metrics.increment("drift_detected")
                self._notify_deployer_recalculate()
                return # deployer will call /supervise again with the new path

            self._schedule_next()

        except Exception as e:
            logger.error("Monitor cycle error: %s", e)
            self._schedule_next()

    # Brief: Refreshes RTT_MATRIX via ONOS CLI and computes the end-to-end path delay
    def _measure_path_delay(self, path: list, access_delay_ms: float, path_estados: list = None) -> float:
        cdn_qoe.get_dynamic_latencies()
        _metrics.increment("msgs_onos_to_observer", 2) # link-latencies + links CLI calls
        core_ms = 0.0
        for edge in path:
            raw_i, raw_j = int(edge[0]), int(edge[1])
            if path_estados:
                src_name = path_estados[raw_i]
                dst_name = path_estados[raw_j]
                try:
                    i = cdn_qoe.ESTADOS.index(src_name)
                    j = cdn_qoe.ESTADOS.index(dst_name)
                except ValueError:
                    logger.warning("State %s or %s not found in local ESTADOS", src_name, dst_name)
                    continue
            else:
                i, j = raw_i, raw_j
                src_name, dst_name = str(i), str(j)
            link_delay = cdn_qoe.RTT_MATRIX[i][j]
            logger.debug("[delay] Edge %s -> %s  delay=%.1f ms", src_name, dst_name, link_delay)
            core_ms += link_delay

        total_ms = core_ms + 2 * access_delay_ms
        logger.debug("[delay] Core=%.1f ms  Access=2x%.1f ms  Total=%.1f ms", core_ms, access_delay_ms, total_ms)
        return total_ms

    # Brief: Queries ONOS REST API port stats on ES (of:0000000000000001), port 3 (ES->ds0)
    #   - Port 3 is the server-facing port: bytesSent here equals all data delivered to ds0
    #     regardless of which upstream path (MG or RJ) was used
    #   - Computes instantaneous throughput, appends to a sliding window, returns the window average
    def _measure_path_throughput(self, server_uf: str = None) -> float:
        if not server_uf or server_uf not in cdn_qoe.DEVICE_MAP:
            logger.warning("server_uf '%s' not in DEVICE_MAP - skipping throughput", server_uf)
            return 0.0
        device_id = cdn_qoe.DEVICE_MAP[server_uf]
        url  = f"{self.onos_base_url}/statistics/ports/{device_id}"
        auth = ("onos", "rocks")

        try:
            _metrics.increment("msgs_onos_to_observer") # GET /statistics/ports
            ports = requests.get(url, auth=auth, timeout=5).json()["statistics"][0]["ports"]
            port = next((p for p in ports if p["port"] == 3), None)

            if port is None:
                logger.warning("Port 3 not found on ES statistics")
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

            self._throughput_samples.append(bps)
            return sum(self._throughput_samples) / len(self._throughput_samples)

        except Exception as e:
            logger.error("Throughput measure error: %s", e)
            return 0.0

    # Brief: POSTs to /deploy/recalculate on the deployer, signalling that the path should be recomputed.
    # Timeout is 30s to account for the deployer's flow installation wait
    def _notify_deployer_recalculate(self):
        _metrics.increment("msgs_observer_to_deployer")
        resp = requests.post(
            self.deployer_base_url + "/recalculate",
            timeout=30,
        )
        resp.raise_for_status()
        time.sleep(2)
        logger.info("Deployer notified - recalculate requested.")

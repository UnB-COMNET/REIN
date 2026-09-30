""" One monitored client intent """

import logging
import threading
import time

from app import drift, throughput
import app.metrics as _metrics

logger = logging.getLogger(__name__)

MONITOR_INTERVAL = 10 # seconds between each measurement cycle

# ANSI colors cycled per client
COLORS = [
    "\033[96m", # bright cyan
    "\033[92m", # bright green
    "\033[93m", # bright yellow
    "\033[95m", # bright magenta
    "\033[94m", # bright blue
    "\033[91m", # bright red
]
_BOLD  = "\033[1m"
_RESET = "\033[0m"


class IntentMonitor:
    """
    Owns one client's timer and throughput probe. Everything shared: the drift
    rule, the ONOS latency cache, the deployer call and lives on the supervisor
    passed in, so this class only schedules and reports
    """

    def __init__(self, client_ip: str, supervisor, color: str = ""):
        self.client_ip = client_ip
        self._sup = supervisor
        short = client_ip.split(".")[-1] # "11" from "192.168.0.11"
        self._tag = f"{_BOLD}{color}[cl:{short}]{_RESET}"

        self._path = None
        self._source_uf = None
        self._server_tx = drift.DEFAULT_SERVER_TX
        self._access_delay_ms = 0.0
        self._probe = None

        self._timer = None
        self._lock = threading.Lock()

    def update(self, path, access_delay_ms: float, server_uf: str,
               source_uf: str, server_tx: float) -> None:
        # Grab the path's throughput probe 
        probe = throughput.ThroughputProbe(self.client_ip, server_uf, self._sup.onos_base_url, self._tag)
        with self._lock:
            self._path = path
            self._source_uf = source_uf
            self._server_tx = server_tx
            self._access_delay_ms = access_delay_ms
            self._probe = probe

        logger.info("%s path updated → server=%s  hops=%s  access=%.1f ms",
                    self._tag, server_uf, path.edges, access_delay_ms)
        self.stop()
        self._schedule_next()

    def stop(self) -> None:
        if self._timer is not None:
            self._timer.cancel()
            self._timer = None

    # Brief: The path being monitored, or None. Public so the supervisor can read
    # it without reaching into this monitor's lock.
    def path(self):
        with self._lock:
            return self._path

    def _schedule_next(self) -> None:
        self._timer = threading.Timer(MONITOR_INTERVAL, self._cycle)
        self._timer.daemon = True
        self._timer.start()

    def _cycle(self) -> None:
        with self._lock:
            if self._path is None:
                return
            path, probe = self._path, self._probe
            access_delay_ms, source_uf, server_tx = (
                self._access_delay_ms, self._source_uf, self._server_tx)

        try:
            delay_ms = self._sup.path_delay_ms(path, access_delay_ms)
            mbps = probe.read_bps() / 1e6

            kpis = {"RTT_ms": delay_ms}
            # A path with no traffic reads 0 Mbit/s: that is idleness, not drift
            if probe.warm and mbps > 0:
                kpis["Vazao_Mbps"] = mbps
            thr = (f"{mbps:.2f} Mbit/s ({probe.window}/{throughput.WINDOW})"
                   if probe.window else "-- (warming up)")

            verdict = self._sup.drift_rule(self.client_ip, path, kpis, source_uf, server_tx)

            # One logger call per cycle: only a call is atomic, and each client
            # ticks on its own thread, so split calls interleave.
            line = f"{self._tag}  delay={delay_ms:5.1f} ms  |  throughput={thr}{verdict.detail}"
            (logger.info if verdict.level == 1 else logger.warning)(line)

            if verdict.drift:
                degrade_ts = _metrics.get_value("degrade_ts")
                if degrade_ts is not None and _metrics.get_value("detection_time_s") is None:
                    _metrics.set_value("detection_time_s", time.time() - degrade_ts)
                _metrics.increment("drift_detected")
                # Only pause on a request that landed; a deployer down for one
                # cycle would otherwise leave this client unmonitored for the
                # rest of the run.
                if self._sup.notify_recalculate(self.client_ip):
                    return # deployer will call /supervise again with the new path

            self._schedule_next()

        except Exception as e:
            logger.error("%s cycle error: %s", self._tag, e)
            self._schedule_next()

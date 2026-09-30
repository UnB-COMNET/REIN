""" Supervisor monitoring service """

import logging
import threading
import time

import requests

from app import cdn_qoe, drift, monitor
from app.topology import DeployedPath
import app.metrics as _metrics

logger = logging.getLogger(__name__)

LATENCY_TTL = 8 # seconds before refreshing the shared topology cache


class SupervisorService:
    """
    One IntentMonitor per client_ip, plus everything they share: the drift rule,
    the ONOS latency cache and the deployer notification.
    """

    def __init__(self, onos_base_url: str, deployer_base_url: str, drift_mode: str):
        self.onos_base_url     = onos_base_url
        self.deployer_base_url = deployer_base_url
        self.drift_mode        = drift_mode
        self.drift_rule        = drift.rule_for(drift_mode)
        self._monitors: dict[str, monitor.IntentMonitor] = {}
        self._lock = threading.Lock()
        self._latency_lock = threading.Lock()
        self._last_latency_refresh = 0.0

    # Brief: Start or restart monitoring for one client, as routes.py received it
    #   path       = [[0, 1], [1, 2]]        indices into estados
    #   estados    = ["AM", "BA", "CE"]      ONOS's device order at deploy time
    #   target_ufs = ["CE"]                  the chosen server's PoP
    #   tx         = [500.0]                 Mbit/s the deployer assumed per server
    def update(self, client_ip: str, path: list, estados: list, access_delay_ms: float,
               target_ufs: list, source_uf: str, tx: list) -> None:
        with self._lock:
            if client_ip not in self._monitors:
                color = monitor.COLORS[len(self._monitors) % len(monitor.COLORS)]
                self._monitors[client_ip] = monitor.IntentMonitor(client_ip, self, color)
                logger.info("[SUPERVISOR] New monitor for %s  (total: %d)",
                            client_ip, len(self._monitors))
            m = self._monitors[client_ip]

        m.update(DeployedPath(path, estados), access_delay_ms,
                 target_ufs[0] if target_ufs else None, source_uf,
                 float(tx[0]) if tx else drift.DEFAULT_SERVER_TX)

    # Brief: Deduplicated edges across all clients' active paths, as name pairs:
    #   [["AM", "BA"], ["BA", "CE"]]
    def get_active_links(self) -> list:
        edges = {tuple(sorted(pair)) for p in self._paths().values() for pair in p.names()}
        return [list(edge) for edge in sorted(edges)]

    # Brief: Each client's own first-hop edge -- unlike get_active_links it keeps
    # per-client attribution, so a caller can degrade one link per client:
    #   {"192.168.0.11": ["AM", "BA"]}
    def get_access_links(self) -> dict:
        return {ip: list(p.names()[0]) for ip, p in self._paths().items() if p.edges}

    # Brief: Sums hop delays along the path, refreshing RTT_MATRIX at most once per TTL
    def path_delay_ms(self, path: DeployedPath, access_delay_ms: float) -> float:
        with self._latency_lock:
            if time.time() - self._last_latency_refresh >= LATENCY_TTL:
                cdn_qoe.get_dynamic_latencies()
                self._last_latency_refresh = time.time()
            return sum(cdn_qoe.RTT_MATRIX[i][j] + cdn_qoe.RTT_MATRIX[j][i]
                       for i, j in path.remapped()) + 2 * access_delay_ms

    # Brief: POSTs to /deploy/recalculate so the deployer redeploys this client's
    # intent; reason is the drift verdict, shown to the operator. Returns whether it succeeded.
    def notify_recalculate(self, client_ip: str, reason: str = "") -> bool:
        _metrics.increment("msgs_observer_to_deployer")
        try:
            resp = requests.post(self.deployer_base_url + "/recalculate",
                                 json={"client_ip": client_ip, "reason": reason}, timeout=300)
            resp.raise_for_status()
            time.sleep(2)
            logger.info("[%s] Deployer notified — recalculate requested.", client_ip)
            return True
        except Exception as e:
            logger.error("[%s] Failed to notify deployer: %s — still monitoring", client_ip, e)
            return False

    def _paths(self) -> dict:
        with self._lock:
            monitors = list(self._monitors.items())
        return {ip: p for ip, m in monitors if (p := m.path()) is not None}

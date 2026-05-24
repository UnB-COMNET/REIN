import json
import logging
import signal
import time
from dataclasses import asdict

from collector import config
from collector import metrics
from collector import onos_discovery
from collector.onos_discovery import DeviceInfo, LinkInfo
from collector.otel import setup_telemetry, Telemetry
from collector.port_stats import ThroughputTracker, fetch_port_stats, PortStats, PortThroughput

logger = logging.getLogger(__name__)

_running = True


def _shutdown(signum, frame):
    global _running
    logger.info("Received signal %d — shutting down", signum)
    _running = False


def _log_devices(devices: dict[str, DeviceInfo]):
    out = {did: asdict(d) for did, d in devices.items()}
    logger.info("devices  %s", json.dumps(out, indent=None))


def _log_links(links: list[LinkInfo]):
    out = [asdict(l) for l in links]
    logger.info("links  %s", json.dumps(out, indent=None))


def _log_port_stats(stats: dict[str, list[PortStats]]):
    out = {did: [asdict(s) for s in ports] for did, ports in stats.items()}
    logger.info("port_stats  %s", json.dumps(out, indent=None))


def _log_throughput(throughput: dict[str, dict[int, PortThroughput]]):
    out = {
        did: {str(port): asdict(t) for port, t in ports.items()}
        for did, ports in throughput.items()
    }
    logger.info("throughput  %s", json.dumps(out, indent=None))


def main():
    global _running

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S",
    )

    signal.signal(signal.SIGINT, _shutdown)
    signal.signal(signal.SIGTERM, _shutdown)

    telemetry = setup_telemetry()
    tracker = ThroughputTracker()
    prev_onos_requests = 0
    cycle = 0

    logger.info("Collector started  interval=%.1fs", config.COLLECTOR_INTERVAL)

    while _running:
        cycle += 1
        logger.info("--- cycle %d ---", cycle)

        try:
            devices, links = onos_discovery.build_topology()
            _log_devices(devices)
            _log_links(links)
            for link in links:
                telemetry.record_link_latency(link)
        except Exception as e:
            logger.error("Topology collection failed: %s", e)
            time.sleep(config.COLLECTOR_INTERVAL)
            continue

        device_ids = list(devices.keys())

        try:
            stats = fetch_port_stats(device_ids)
            _log_port_stats(stats)
            for did, port_list in stats.items():
                for ps in port_list:
                    telemetry.record_port_counters(did, ps)
        except Exception as e:
            logger.error("Port stats collection failed: %s", e)
            stats = {}

        try:
            throughput: dict[str, dict[int, PortThroughput]] = {}
            for did, port_list in stats.items():
                for ps in port_list:
                    t = tracker.update(did, ps)
                    if t.window_size >= 2:
                        throughput.setdefault(did, {})[ps.port] = t
                        telemetry.record_port_throughput(did, ps.port, t)
            if throughput:
                _log_throughput(throughput)
        except Exception as e:
            logger.error("Throughput computation failed: %s", e)

        try:
            snap = metrics.snapshot()
            logger.info("metrics  %s", json.dumps(snap))
            current_onos_requests = snap.get("msgs_onos_to_collector", 0)
            delta = current_onos_requests - prev_onos_requests
            telemetry.record_onos_requests(delta)
            prev_onos_requests = current_onos_requests
        except Exception as e:
            logger.error("Metrics snapshot failed: %s", e)

        time.sleep(config.COLLECTOR_INTERVAL)

    telemetry.shutdown()
    logger.info("Collector stopped after %d cycles", cycle)


if __name__ == "__main__":
    main()

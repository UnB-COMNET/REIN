import json
import logging
import signal
import sys
import time

from collector import config
from collector import metrics
from collector import onos_discovery
from collector.throughput import ThroughputMeasurer

logger = logging.getLogger(__name__)

_running = True


def _shutdown(signum, frame):
    global _running
    logger.info("Received signal %d — shutting down", signum)
    _running = False


def main():
    global _running

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S",
    )

    signal.signal(signal.SIGINT, _shutdown)
    signal.signal(signal.SIGTERM, _shutdown)

    throughput_measurer = ThroughputMeasurer()
    cycle = 0

    logger.info(
        "Collector started  interval=%.1fs  server_uf=%s",
        config.COLLECTOR_INTERVAL, config.SERVER_UF or "(not set)",
    )

    while _running:
        cycle += 1
        logger.info("--- cycle %d ---", cycle)

        try:
            topo = onos_discovery.get_dynamic_latencies()
            logger.info(
                "topology  estados=%s  device_map=%s  rtt_matrix=%s",
                json.dumps(topo.estados),
                json.dumps(topo.device_map),
                json.dumps(topo.rtt_matrix),
            )
        except Exception as e:
            logger.error("Topology collection failed: %s", e)

        try:
            if config.SERVER_UF and config.SERVER_UF in topo.device_map:
                device_id = topo.device_map[config.SERVER_UF]
                bps = throughput_measurer.measure(device_id)
                mbps = bps / 1e6
                logger.info("throughput  bps=%.2f  mbps=%.2f  window=%d", bps, mbps, len(throughput_measurer._samples))
            elif config.SERVER_UF:
                logger.warning("server_uf '%s' not in device_map — skipping throughput", config.SERVER_UF)
            else:
                logger.debug("SERVER_UF not configured — skipping throughput")
        except Exception as e:
            logger.error("Throughput collection failed: %s", e)

        try:
            snap = metrics.snapshot()
            logger.info("metrics  %s", json.dumps(snap))
        except Exception as e:
            logger.error("Metrics snapshot failed: %s", e)

        time.sleep(config.COLLECTOR_INTERVAL)

    logger.info("Collector stopped after %d cycles", cycle)


if __name__ == "__main__":
    main()

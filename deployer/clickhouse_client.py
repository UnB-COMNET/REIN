"""ClickHouse HTTP client for the deployer

Queries link latencies from ClickHouse (collected by the collector) instead of
querying ONOS Karaf CLI directly
"""
import logging
import os

import requests

logger = logging.getLogger(__name__)

CH_URL = os.environ.get("CLICKHOUSE_URL", "http://localhost:8123")
CH_DB = os.environ.get("CLICKHOUSE_DB", "otel")


def query(sql: str) -> list[dict]:
    """Execute a ClickHouse query and return rows as dicts"""
    fmt_sql = sql.rstrip().rstrip(";") + " FORMAT JSON"
    try:
        r = requests.post(
            f"{CH_URL}/",
            params={"database": CH_DB, "query": fmt_sql},
            timeout=10,
        )
        r.raise_for_status()
        return r.json().get("data", [])
    except Exception as e:
        logger.error("ClickHouse query failed: %s", e)
        return []


def get_link_latencies() -> dict[tuple[str, str], float]:
    """Get the latest per-link RTT latency from ClickHouse

    Returns {(src_device, dst_device): latency_ms}
    """
    rows = query(
        "SELECT Attributes['src_device'] as src, "
        "Attributes['dst_device'] as dst, "
        "argMax(Value, TimeUnix) as latency_ms "
        "FROM otel_metrics_gauge "
        "WHERE MetricName = 'sdn.link.latency' "
        "GROUP BY src, dst"
    )
    return {(r["src"], r["dst"]): float(r["latency_ms"]) for r in rows}

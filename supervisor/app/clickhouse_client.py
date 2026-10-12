"""ClickHouse HTTP client for the supervisor

Queries telemetry from ClickHouse instead of collecting directly from ONOS
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


def get_port_throughput(device_id: str, port: str, direction: str = "sent") -> float:
    """Get the latest throughput for a specific port from ClickHouse

    Returns bps (bits per second), or 0.0 if no data
    """
    rows = query(
        f"SELECT argMax(Value, TimeUnix) as bps "
        f"FROM otel_metrics_gauge "
        f"WHERE MetricName = 'sdn.port.throughput' "
        f"AND Attributes['device_id'] = '{device_id}' "
        f"AND Attributes['port'] = '{port}' "
        f"AND Attributes['direction'] = '{direction}'"
    )
    if rows and rows[0].get("bps") is not None:
        return float(rows[0]["bps"])
    return 0.0

"""Pure functions translating gNMI update paths/values into collector metric terms

No network I/O — easily unit-testable.  Maps OpenConfig interface counters,
custom rate paths, and latency paths to the existing metric vocabulary
"""
import logging

logger = logging.getLogger(__name__)

# Update categories
COUNTER = "counter"
RATE = "rate"
LATENCY = "latency"
STATUS = "status"
UNKNOWN = "unknown"

# OpenConfig counter leaf → logical field name (mirrors PortStats fields)
COUNTER_FIELDS = {
    "in-octets": "bytes_received",
    "out-octets": "bytes_sent",
    "in-unicast-pkts": "packets_received",
    "out-unicast-pkts": "packets_sent",
    "in-discards": "packets_rx_dropped",
    "out-discards": "packets_tx_dropped",
    "in-errors": "packets_rx_errors",
    "out-errors": "packets_tx_errors",
    "in-fcs-errors": "packets_rx_fcs_errors",
}

# Rate leaf → direction.  Only octets (bytes/s) map to throughput (bits/s)
RATE_DIRECTIONS = {
    "in-octets": "received",
    "out-octets": "sent",
}

# Latency leaf → stat label
LATENCY_STATS = {
    "rtt-ns": "rtt",
    "rtt-avg-ns": "rtt-avg",
    "rtt-max-ns": "rtt-max",
    "rtt-min-ns": "rtt-min",
}

UINT64_MAX = 2 ** 64


def leaf_from_path(path_str: str) -> str | None:
    """Extract the leaf name (last path segment) from a canonical path string"""
    if not path_str:
        return None
    return path_str.rstrip("/").rsplit("/", 1)[-1] or None


def classify(path_str: str) -> str:
    """Classify a gNMI path into COUNTER / RATE / LATENCY / STATUS / UNKNOWN"""
    if "/state/counters/" in path_str:
        return COUNTER
    if "/state/rate/" in path_str:
        return RATE
    if "/latency/target" in path_str:
        return LATENCY
    leaf = leaf_from_path(path_str)
    if leaf in ("oper-status", "admin-status"):
        return STATUS
    return UNKNOWN


def translate_counter(path_str: str, value):
    """Map a counter update to (field_name, value) or None if unrecognised"""
    leaf = leaf_from_path(path_str)
    field = COUNTER_FIELDS.get(leaf)
    if field is None or value is None:
        return None
    return (field, int(value))


def translate_rate(path_str: str, value):
    """Map a rate update to (direction, bps) or None

    gNMI rate is bytes/s; the collector throughput metric is bits/s -> x8
    """
    leaf = leaf_from_path(path_str)
    direction = RATE_DIRECTIONS.get(leaf)
    if direction is None or value is None:
        return None
    return (direction, float(value) * 8.0)


def translate_latency(path_str: str, value):
    """Map a latency update to (stat, rtt_ms) or None

    gNMI latency is in nanoseconds; the collector metric is milliseconds
    """
    leaf = leaf_from_path(path_str)
    stat = LATENCY_STATS.get(leaf)
    if stat is None or value is None:
        return None
    return (stat, ns_to_ms(int(value)))


def ns_to_ms(ns: int) -> float:
    """Convert nanoseconds to milliseconds"""
    return ns / 1_000_000.0


def wraparound_delta(new: int, prev: int) -> int:
    """Compute a uint64 wraparound-aware delta

    Counters are cumulative uint64 since OVS start; on wraparound (new < prev)
    assume a single rollover
    """
    if new >= prev:
        return new - prev
    return (UINT64_MAX - prev) + new

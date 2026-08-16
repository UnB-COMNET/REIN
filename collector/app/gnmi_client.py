"""gNMI client wrapper for streaming telemetry from OVS switches.

Isolates all pygnmi API specifics so the rest of the collector never imports
pygnmi directly.
"""
import json
import logging
import threading

from pygnmi.client import gNMIclient

from collector import config

logger = logging.getLogger(__name__)

# Subscribe paths (wildcard: omit keys to stream all interfaces/targets)
_SAMPLE_PATHS = [
    "interfaces/interface/state/counters",
    "org-lft/interfaces/interface/state/rate",
    "org-lft/latency/target/state/rtt-ns",
    "org-lft/latency/target/state/rtt-avg-ns",
    "org-lft/latency/target/state/rtt-max-ns",
    "org-lft/latency/target/state/rtt-min-ns",
]
_ON_CHANGE_PATHS = [
    "interfaces/interface/state/oper-status",
    "interfaces/interface/state/admin-status",
]


# ---------------------------------------------------------------------------
# Connection & request building
# ---------------------------------------------------------------------------

def gnmi_connect(host, port=None, timeout=None):
    """Create a gNMIclient (TLS + skip-verify)

    Returns an *unentered* gNMIclient — the caller is responsible for entering
    it (``with gnmi_connect(...) as gc:`` or ``gc.__enter__()`` / ``gc.__exit__()``)
    so that long-lived streams in background threads can control the lifecycle.
    """
    port = port or config.GNMI_PORT
    timeout = timeout or config.GNMI_CONNECT_TIMEOUT
    kwargs = {
        "target": (host, port),
        "skip_verify": config.GNMI_SKIP_VERIFY,
        "timeout": timeout,
    }
    if config.GNMI_TLS_CERT:
        kwargs["tls_cert"] = config.GNMI_TLS_CERT
    if config.GNMI_TLS_KEY:
        kwargs["tls_key"] = config.GNMI_TLS_KEY
    if config.GNMI_TLS_CA:
        kwargs["tls_ca"] = config.GNMI_TLS_CA
    return gNMIclient(**kwargs)


def build_subscribe_request(sample_interval_ns=None):
    """Build the pygnmi subscribe dict for STREAM mode (SAMPLE + ON_CHANGE)"""
    sample_interval_ns = sample_interval_ns or config.GNMI_SAMPLE_INTERVAL_NS
    subscriptions = [
        {"path": p, "mode": "sample", "sample_interval": sample_interval_ns}
        for p in _SAMPLE_PATHS
    ]
    subscriptions += [
        {"path": p, "mode": "on_change"}
        for p in _ON_CHANGE_PATHS
    ]
    return {"subscription": subscriptions, "mode": "stream", "encoding": "json"}


# ---------------------------------------------------------------------------
# Path / value parsing helpers (operate on gnmi_pb2 Path / TypedValue)
# ---------------------------------------------------------------------------

def path_to_str(path) -> str:
    """Reconstruct a canonical path string from a gnmi Path proto"""
    if not path:
        return ""
    parts = []
    for elem in path.elem:
        s = elem.name
        if elem.key:
            keys = ",".join(f"{k}={v}" for k, v in elem.key.items())
            s += f"[{keys}]"
        parts.append(s)
    return "/" + "/".join(parts)


def extract_interface_name(path):
    """Return the interface name from a path like .../interface[name=eth0]/..."""
    if not path:
        return None
    for elem in path.elem:
        if elem.name == "interface" and elem.key.get("name"):
            return elem.key["name"]
    return None


def extract_target_ip(path):
    """Return the target IP from a path like .../target[ip=10.0.0.1]/..."""
    if not path:
        return None
    for elem in path.elem:
        if elem.name == "target" and elem.key.get("ip"):
            return elem.key["ip"]
    return None


def extract_leaf_name(path):
    """Return the last path element name (the leaf, e.g. 'in-octets')"""
    if not path or not path.elem:
        return None
    return path.elem[-1].name


def extract_value(typed_val):
    """Extract a Python value from a gnmi TypedValue proto.

    Primary path is JSON encoding (we request encoding=json).  Falls back to
    typed scalar fields for PROTO encoding
    """
    if not typed_val:
        return None
    if getattr(typed_val, "json_ival", b""):
        try:
            return json.loads(typed_val.json_ival)
        except (ValueError, TypeError):
            return typed_val.json_ival
    if getattr(typed_val, "json_val", b""):
        try:
            return json.loads(typed_val.json_val)
        except (ValueError, TypeError):
            return typed_val.json_val
    try:
        kind = typed_val.WhichOneof("value")
    except (ValueError, AttributeError):
        kind = None
    if kind and kind not in ("json_ival", "json_val", "leaflist_val"):
        return getattr(typed_val, kind)
    return None


# ---------------------------------------------------------------------------
# Stream loop
# ---------------------------------------------------------------------------

def run_stream(client, subscribe_req, on_update, on_sync, stop_event: threading.Event):
    """Run a blocking gNMI Subscribe STREAM on an already-connected client

    ``on_update(path_str, value, timestamp, iface_name, target_ip)`` is called
    for every Update; ``on_sync()`` when the initial sync completes.  Returns
    when *stop_event* is set or the stream ends/errors.  To unblock a blocked
    generator, the caller should close the gRPC channel (exit the client) from
    another thread in addition to setting *stop_event*
    """
    try:
        for response in client.subscribe(subscribe_req):
            if stop_event.is_set():
                break
            _dispatch_response(response, on_update, on_sync)
    except Exception as e:
        if not stop_event.is_set():
            logger.error("gNMI subscribe stream error: %s", e)


def _dispatch_response(response, on_update, on_sync):
    """Parse one SubscribeResponse and dispatch to callbacks"""
    # SubscribeResponse is a oneof: sync_response (bool) | update (Notification)
    try:
        kind = response.WhichOneof("response")
    except (ValueError, AttributeError):
        # Fallback for non-oneof / dict shapes.
        kind = "update" if getattr(response, "update", None) else None

    if kind == "sync_response":
        on_sync()
        return
    if kind != "update":
        return

    notif = response.update
    timestamp = getattr(notif, "timestamp", 0)

    for upd in notif.update:
        path_str = path_to_str(upd.path)
        value = extract_value(upd.val)
        on_update(
            path_str,
            value,
            timestamp,
            extract_interface_name(upd.path),
            extract_target_ip(upd.path),
        )

    # Deletes: emit a None value so consumers can clear state if needed.
    for dpath in getattr(notif, "delete", []) or []:
        on_update(
            path_to_str(dpath),
            None,
            timestamp,
            extract_interface_name(dpath),
            extract_target_ip(dpath),
        )


# ---------------------------------------------------------------------------
# Standalone probe — empirically confirm pygnmi's response shape.
# Usage: python3 -m collector.gnmi_client <host> [port]
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import sys

    host = sys.argv[1] if len(sys.argv) > 1 else "localhost"
    port = int(sys.argv[2]) if len(sys.argv) > 2 else config.GNMI_PORT
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    _stop = threading.Event()

    def _on_update(path_str, value, ts, iface, target):
        logger.info("UPDATE  path=%s  value=%r  iface=%s  target=%s  ts=%d",
                    path_str, value, iface, target, ts)

    def _on_sync():
        logger.info("SYNC received — initial dump complete")

    logger.info("Connecting to %s:%d ...", host, port)
    _client = gnmi_connect(host, port)
    _client.__enter__()
    _timer = threading.Timer(
        15.0, lambda: (_stop.set(), _client.__exit__(None, None, None))
    )
    _timer.start()
    try:
        logger.info("Connected. Streaming for 15s (or Ctrl-C) ...")
        run_stream(_client, build_subscribe_request(), _on_update, _on_sync, _stop)
    except KeyboardInterrupt:
        pass
    finally:
        _timer.cancel()
        try:
            _client.__exit__(None, None, None)
        except Exception:
            pass
    logger.info("Probe finished.")

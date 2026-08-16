"""gNMI stream manager — orchestrates per-switch Subscribe STREAM threads

The main ONOS poll thread calls reconcile(devices) each cycle; the manager starts
background threads for new switches, stops threads for removed ones, and restarts
dead streams.  Each thread holds a long-lived gNMI Subscribe STREAM and routes
updates through the translator + port map into the Telemetry recorder
"""
import json
import logging
import threading

from collector import config
from collector.gnmi_client import gnmi_connect, build_subscribe_request, run_stream
from collector.gnmi_translator import (
    classify, translate_counter, translate_rate, translate_latency,
    COUNTER, RATE, LATENCY, STATUS,
)
from collector.onos_discovery import DeviceInfo

logger = logging.getLogger(__name__)


def resolve_gnmi_host(device_id: str, device_info: DeviceInfo) -> str | None:
    """Resolve a device to its gNMI host IP, or None if unresolvable

    Tries: (1) GNMI_HOST_MAP override, (2) managementAddress annotation,
    (3) GNMI_SUBNET + DPID derivation
    """
    # 1. Explicit override map
    if config.GNMI_HOST_MAP:
        try:
            host_map = json.loads(config.GNMI_HOST_MAP)
            if device_id in host_map:
                return host_map[device_id]
        except (json.JSONDecodeError, TypeError):
            pass
    # 2. managementAddress annotation
    mgmt = (device_info.annotations or {}).get("managementAddress", "")
    if mgmt:
        host = mgmt.split("://")[-1].split(":")[0]
        if host:
            return host
    # 3. GNMI_SUBNET + last octet of DPID
    if config.GNMI_SUBNET and device_id.startswith("of:"):
        try:
            last_octet = int(device_id[3:][-2:], 16) % 256
            return f"{config.GNMI_SUBNET}{last_octet}"
        except ValueError:
            pass
    return None


class _StreamHandle:
    __slots__ = ("thread", "stop_event", "client")

    def __init__(self, thread, stop_event, client):
        self.thread = thread
        self.stop_event = stop_event
        self.client = client


class GnmiStreamManager:
    """Manages one gNMI Subscribe STREAM background thread per switch"""

    def __init__(self, telemetry, port_map_cache):
        self._telemetry = telemetry
        self._port_map_cache = port_map_cache
        self._streams: dict[str, _StreamHandle] = {}
        self._lock = threading.Lock()
        self._subscribe_req = build_subscribe_request()

    def reconcile(self, devices: dict[str, DeviceInfo]) -> None:
        """Start streams for new devices, stop for removed, restart dead"""
        with self._lock:
            current_ids = set(devices.keys())
            active_ids = set(self._streams.keys())

            for did in active_ids - current_ids:
                self._stop_stream_locked(did)

            for did, dev in devices.items():
                handle = self._streams.get(did)
                if handle is not None and handle.thread.is_alive():
                    continue
                if handle is not None:
                    self._stop_stream_locked(did)
                if not dev.available:
                    logger.debug("Device %s not available — skipping gNMI stream", did)
                    continue
                host = resolve_gnmi_host(did, dev)
                if host is None:
                    logger.warning("Cannot resolve gNMI host for %s — skipping", did)
                    continue
                self._start_stream_locked(did, host)

    def _start_stream_locked(self, device_id: str, host: str) -> None:
        stop_event = threading.Event()
        try:
            client = gnmi_connect(host)
            client.__enter__()
        except Exception as e:
            logger.error("gNMI connect failed for %s (%s:%d): %s",
                         device_id, host, config.GNMI_PORT, e)
            return
        thread = threading.Thread(
            target=self._stream_loop,
            args=(device_id, client, stop_event),
            daemon=True,
            name=f"gnmi-{device_id}",
        )
        self._streams[device_id] = _StreamHandle(thread, stop_event, client)
        thread.start()
        logger.info("gNMI stream started for %s -> %s:%d", device_id, host, config.GNMI_PORT)

    def _stop_stream_locked(self, device_id: str) -> None:
        handle = self._streams.pop(device_id, None)
        if handle is None:
            return
        handle.stop_event.set()
        try:
            handle.client.__exit__(None, None, None)
        except Exception:
            pass
        handle.thread.join(timeout=5)
        logger.info("gNMI stream stopped for %s", device_id)

    def _stream_loop(self, device_id: str, client, stop_event: threading.Event) -> None:
        def on_update(path_str, value, ts, iface, target):
            self._handle_update(device_id, path_str, value, iface, target)

        def on_sync():
            logger.info("gNMI initial sync received for %s", device_id)

        run_stream(client, self._subscribe_req, on_update, on_sync, stop_event)
        logger.debug("gNMI stream loop ended for %s", device_id)

    def _handle_update(self, device_id: str, path_str: str, value, iface, target) -> None:
        kind = classify(path_str)
        if kind == COUNTER:
            result = translate_counter(path_str, value)
            if result is None:
                return
            field, val = result
            port = self._lookup_port(device_id, iface)
            if port is None:
                return
            self._telemetry.record_gnmi_counter(device_id, port, field, val)
        elif kind == RATE:
            result = translate_rate(path_str, value)
            if result is None:
                return
            direction, bps = result
            port = self._lookup_port(device_id, iface)
            if port is None:
                return
            self._telemetry.record_gnmi_throughput(device_id, port, direction, bps)
        elif kind == LATENCY:
            result = translate_latency(path_str, value)
            if result is None or target is None:
                return
            _stat, rtt_ms = result
            self._telemetry.record_gnmi_latency(device_id, target, rtt_ms)
        elif kind == STATUS:
            logger.debug("gNMI status %s iface=%s value=%r", device_id, iface, value)

    def _lookup_port(self, device_id: str, iface: str | None) -> int | None:
        if iface is None:
            return None
        port = self._port_map_cache.get(device_id).get(iface)
        if port is None:
            logger.debug("No port mapping for %s iface=%s", device_id, iface)
        return port

    def stop_all(self) -> None:
        with self._lock:
            for did in list(self._streams.keys()):
                self._stop_stream_locked(did)

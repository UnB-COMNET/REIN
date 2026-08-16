import logging
import threading

from opentelemetry import metrics
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import (
    MetricExportResult,
    PeriodicExportingMetricReader,
)
from opentelemetry.sdk.resources import Resource
from opentelemetry.exporter.otlp.proto.grpc.metric_exporter import OTLPMetricExporter

from collector import config
from collector.gnmi_translator import wraparound_delta
from collector.flow_stats import FlowInfo
from collector.onos_discovery import LinkInfo
from collector.port_stats import PortStats, PortThroughput

logger = logging.getLogger(__name__)


class _ResilientOTLPExporter:
    def __init__(self, inner: OTLPMetricExporter):
        self._inner = inner
        self._endpoint_ok = True
        logging.getLogger("opentelemetry.exporter.otlp.proto.grpc.exporter").setLevel(
            logging.CRITICAL
        )

    def export(self, metrics_data, timeout_millis=10_000, **kwargs):
        result = self._inner.export(metrics_data, timeout_millis=timeout_millis, **kwargs)
        if result is MetricExportResult.FAILURE:
            if self._endpoint_ok:
                logger.warning(
                    "OTLP export endpoint unreachable — metrics will be dropped until it recovers  endpoint=%s",
                    config.OTEL_EXPORTER_OTLP_ENDPOINT,
                )
                self._endpoint_ok = False
        else:
            if not self._endpoint_ok:
                logger.info("OTLP export endpoint recovered  endpoint=%s", config.OTEL_EXPORTER_OTLP_ENDPOINT)
                self._endpoint_ok = True
        return result

    def force_flush(self, timeout_millis=10_000):
        return self._inner.force_flush(timeout_millis=timeout_millis)

    def shutdown(self, timeout_millis=30_000, **kwargs):
        return self._inner.shutdown(timeout_millis=timeout_millis, **kwargs)

    @property
    def _preferred_temporality(self):
        return self._inner._preferred_temporality

    @property
    def _preferred_aggregation(self):
        return self._inner._preferred_aggregation


class Telemetry:
    def __init__(self, meter: metrics.Meter, meter_provider: MeterProvider):
        self._meter_provider = meter_provider
        self._prev_counters: dict[tuple[str, int], PortStats] = {}
        self._prev_flow_counters: dict[tuple[str, str], tuple[int, int]] = {}
        self._counter_lock = threading.Lock()
        self._prev_gnmi_counters: dict[tuple[str, int, str], int] = {}

        self.link_latency = meter.create_gauge(
            "sdn.link.latency",
            description="RTT latency of an active SDN link",
            unit="ms",
        )
        self.port_throughput = meter.create_gauge(
            "sdn.port.throughput",
            description="Moving-average throughput on a device port",
            unit="bps",
        )
        self.port_bytes = meter.create_counter(
            "sdn.port.bytes",
            description="Cumulative bytes transferred on a device port",
            unit="By",
        )
        self.port_packets = meter.create_counter(
            "sdn.port.packets",
            description="Cumulative packets transferred on a device port",
            unit="1",
        )
        self.port_drops = meter.create_counter(
            "sdn.port.drops",
            description="Cumulative dropped packets on a device port",
            unit="1",
        )
        self.port_errors = meter.create_counter(
            "sdn.port.errors",
            description="Cumulative errored packets on a device port",
            unit="1",
        )
        self.onos_requests = meter.create_counter(
            "sdn.onos.requests",
            description="Number of API/CLI requests made to the ONOS controller",
            unit="1",
        )
        self.flow_bytes = meter.create_counter(
            "sdn.flow.bytes",
            description="Cumulative bytes matched by a flow rule",
            unit="By",
        )
        self.flow_packets = meter.create_counter(
            "sdn.flow.packets",
            description="Cumulative packets matched by a flow rule",
            unit="1",
        )

    def record_link_latency(self, link: LinkInfo):
        if link.latency_ms is None:
            return
        attrs = {
            "src_device": link.src_device,
            "src_port": link.src_port,
            "dst_device": link.dst_device,
            "dst_port": link.dst_port,
            "link_type": link.type,
        }
        self.link_latency.set(link.latency_ms, attributes=attrs)

    def record_port_throughput(self, device_id: str, port: int, tp: PortThroughput):
        base = {"device_id": device_id, "port": port}
        self.port_throughput.set(tp.bps_sent, attributes={**base, "direction": "sent"})
        self.port_throughput.set(tp.bps_received, attributes={**base, "direction": "received"})

    def record_port_counters(self, device_id: str, stats: PortStats):
        key = (device_id, stats.port)
        prev = self._prev_counters.get(key)

        if prev is not None:
            base = {"device_id": device_id, "port": stats.port}

            d_bytes_sent = stats.bytes_sent - prev.bytes_sent
            d_bytes_recv = stats.bytes_received - prev.bytes_received
            if d_bytes_sent >= 0:
                self.port_bytes.add(d_bytes_sent, attributes={**base, "direction": "sent"})
            if d_bytes_recv >= 0:
                self.port_bytes.add(d_bytes_recv, attributes={**base, "direction": "received"})

            d_pkts_sent = stats.packets_sent - prev.packets_sent
            d_pkts_recv = stats.packets_received - prev.packets_received
            if d_pkts_sent >= 0:
                self.port_packets.add(d_pkts_sent, attributes={**base, "direction": "sent"})
            if d_pkts_recv >= 0:
                self.port_packets.add(d_pkts_recv, attributes={**base, "direction": "received"})

            d_rx_drop = stats.packets_rx_dropped - prev.packets_rx_dropped
            d_tx_drop = stats.packets_tx_dropped - prev.packets_tx_dropped
            if d_rx_drop >= 0:
                self.port_drops.add(d_rx_drop, attributes={**base, "direction": "rx"})
            if d_tx_drop >= 0:
                self.port_drops.add(d_tx_drop, attributes={**base, "direction": "tx"})

            d_rx_err = stats.packets_rx_errors - prev.packets_rx_errors
            d_tx_err = stats.packets_tx_errors - prev.packets_tx_errors
            if d_rx_err >= 0:
                self.port_errors.add(d_rx_err, attributes={**base, "direction": "rx"})
            if d_tx_err >= 0:
                self.port_errors.add(d_tx_err, attributes={**base, "direction": "tx"})

        self._prev_counters[key] = stats

    def record_flow_counters(self, device_id: str, flow: FlowInfo):
        key = (device_id, flow.flow_id)
        prev = self._prev_flow_counters.get(key)

        if prev is not None:
            attrs = {
                "device_id": device_id,
                "flow_id": flow.flow_id,
                "app_id": flow.app_id,
                "table_id": flow.table_id,
                "priority": flow.priority,
                "output_port": flow.output_port or 0,
            }

            d_bytes = flow.bytes - prev[1]
            d_packets = flow.packets - prev[0]
            if d_bytes >= 0:
                self.flow_bytes.add(d_bytes, attributes=attrs)
            if d_packets >= 0:
                self.flow_packets.add(d_packets, attributes=attrs)

        self._prev_flow_counters[key] = (flow.packets, flow.bytes)

    def record_onos_requests(self, delta: int):
        if delta > 0:
            self.onos_requests.add(delta)

    # -- gNMI streaming sources ----------------------------------------------
    # Per-leaf counter field -> (instrument attr, direction)
    _FIELD_TO_COUNTER = {
        "bytes_received": ("port_bytes", "received"),
        "bytes_sent": ("port_bytes", "sent"),
        "packets_received": ("port_packets", "received"),
        "packets_sent": ("port_packets", "sent"),
        "packets_rx_dropped": ("port_drops", "rx"),
        "packets_tx_dropped": ("port_drops", "tx"),
        "packets_rx_errors": ("port_errors", "rx"),
        "packets_tx_errors": ("port_errors", "tx"),
        "packets_rx_fcs_errors": ("port_errors", "rx"),
    }

    def record_gnmi_counter(self, device_id: str, port: int, field: str, value: int):
        """Record a single gNMI counter leaf as a wraparound-aware delta"""
        mapping = self._FIELD_TO_COUNTER.get(field)
        if mapping is None:
            return
        instrument_attr, direction = mapping
        key = (device_id, port, field)
        with self._counter_lock:
            prev = self._prev_gnmi_counters.get(key)
            self._prev_gnmi_counters[key] = value
        if prev is not None:
            delta = wraparound_delta(value, prev)
            if delta > 0:
                instrument = getattr(self, instrument_attr)
                instrument.add(
                    delta,
                    attributes={"device_id": device_id, "port": port, "direction": direction},
                )

    def record_gnmi_throughput(self, device_id: str, port: int, direction: str, bps: float):
        """Set the throughput gauge directly from a gNMI rate path (bits/s)"""
        self.port_throughput.set(
            bps,
            attributes={"device_id": device_id, "port": port, "direction": direction},
        )

    def record_gnmi_latency(self, device_id: str, target_ip: str, rtt_ms: float):
        """Set the link latency gauge from a gNMI RTT sample (milliseconds)"""
        self.link_latency.set(
            rtt_ms,
            attributes={
                "src_device": device_id,
                "src_port": 0,
                "dst_device": target_ip,
                "dst_port": 0,
                "link_type": "gnmi-rtt",
            },
        )

    def shutdown(self):
        self._meter_provider.shutdown()


def setup_telemetry() -> Telemetry:
    resource = Resource.create({
        "service.name": "collector",
        "service.version": "1.0.0",
    })

    exporter = _ResilientOTLPExporter(
        OTLPMetricExporter(
            endpoint=config.OTEL_EXPORTER_OTLP_ENDPOINT,
            insecure=True,
        )
    )
    reader = PeriodicExportingMetricReader(
        exporter,
        export_interval_millis=int(config.OTEL_EXPORT_INTERVAL * 1000),
    )
    provider = MeterProvider(metric_readers=[reader], resource=resource)
    meter = provider.get_meter("collector", "1.0.0")

    logger.info(
        "OTel initialized  endpoint=%s  export_interval=%.1fs",
        config.OTEL_EXPORTER_OTLP_ENDPOINT, config.OTEL_EXPORT_INTERVAL,
    )
    return Telemetry(meter, provider)

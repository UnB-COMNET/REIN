"""Kafka-based metric exporter for the collector (JSONEachRow)

Replaces the OTLP/gRPC transport with a Kafka producer. Metrics are serialized
as JSONEachRow (one JSON object per data point) to two Kafka topics: gauge
metrics and sum metrics. ClickHouse's Kafka table engine consumes directly
"""
import json
import logging
from datetime import datetime, timezone

from kafka import KafkaProducer
from opentelemetry.sdk.metrics.export import (
    Gauge,
    MetricExporter,
    MetricExportResult,
    MetricsData,
    Sum,
)

from collector import config

logger = logging.getLogger(__name__)


def _stringify_attributes(attrs) -> dict[str, str]:
    """Convert OTel attributes (possibly non-string values) to {str: str}"""
    if not attrs:
        return {}
    return {str(k): str(v) for k, v in attrs.items()}


def _nano_to_datetime_str(ns: int) -> str:
    """Convert unix nanoseconds to a ClickHouse-compatible datetime string"""
    if not ns:
        return "1970-01-01 00:00:00.000000000"
    return datetime.fromtimestamp(ns / 1e9, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S.%f")


class KafkaMetricExporter(MetricExporter):
    """Export metrics to Kafka as JSONEachRow (gauge + sum topics)"""

    def __init__(self, brokers: str | None = None, client_id: str | None = None):
        self._brokers = brokers or config.KAFKA_BROKERS
        self._topic_gauge = config.KAFKA_TOPIC_GAUGE
        self._topic_sum = config.KAFKA_TOPIC_SUM
        self._producer = KafkaProducer(
            bootstrap_servers=self._brokers,
            client_id=client_id or config.KAFKA_CLIENT_ID,
            acks=1,
            value_serializer=lambda v: json.dumps(v).encode("utf-8"),
            max_block_ms=5000,
        )
        logger.info(
            "Kafka metric exporter initialized  brokers=%s  gauge=%s  sum=%s",
            self._brokers, self._topic_gauge, self._topic_sum,
        )

    def export(
        self,
        metrics_data: MetricsData,
        timeout_millis: float = 10_000,
        **kwargs,
    ) -> MetricExportResult:
        try:
            for rm in metrics_data.resource_metrics:
                resource_attrs = _stringify_attributes(getattr(rm.resource, "attributes", {}))
                service_name = resource_attrs.get("service.name", "collector")
                for sm in rm.scope_metrics:
                    scope = sm.scope
                    scope_name = scope.name if scope else ""
                    scope_attrs = _stringify_attributes(getattr(scope, "attributes", {}) if scope else {})
                    for metric in sm.metrics:
                        is_gauge = isinstance(metric.data, Gauge)
                        is_sum = isinstance(metric.data, Sum)
                        if not (is_gauge or is_sum):
                            continue
                        for dp in metric.data.data_points:
                            record = {
                                "ResourceAttributes": resource_attrs,
                                "ScopeName": scope_name,
                                "ScopeAttributes": scope_attrs,
                                "ServiceName": service_name,
                                "MetricName": metric.name,
                                "MetricDescription": metric.description or "",
                                "MetricUnit": metric.unit or "",
                                "Attributes": _stringify_attributes(dp.attributes),
                                "StartTimeUnix": _nano_to_datetime_str(dp.start_time_unix_nano),
                                "TimeUnix": _nano_to_datetime_str(dp.time_unix_nano),
                                "Value": dp.value,
                            }
                            if is_sum:
                                record["AggregationTemporality"] = metric.data.aggregation_temporality.value
                                record["IsMonotonic"] = metric.data.is_monotonic
                                topic = self._topic_sum
                            else:
                                topic = self._topic_gauge
                            self._producer.send(topic, value=record)
            return MetricExportResult.SUCCESS
        except Exception as e:
            logger.error("Kafka produce failed: %s", e)
            return MetricExportResult.FAILURE

    def force_flush(self, timeout_millis: float = 10_000) -> bool:
        try:
            self._producer.flush(timeout=timeout_millis / 1000)
            return True
        except Exception as e:
            logger.error("Kafka flush failed: %s", e)
            return False

    def shutdown(self, timeout_millis: float = 30_000, **kwargs) -> bool:
        try:
            self._producer.flush(timeout=timeout_millis / 1000)
            self._producer.close(timeout=timeout_millis / 1000)
            return True
        except Exception as e:
            logger.error("Kafka shutdown failed: %s", e)
            return False

    @property
    def _preferred_temporality(self):
        return None

    @property
    def _preferred_aggregation(self):
        return None


class _ResilientKafkaExporter:
    """Wrapper that logs transient Kafka failures without crashing the collector"""

    def __init__(self, inner: KafkaMetricExporter):
        self._inner = inner
        self._endpoint_ok = True

    def export(self, metrics_data, timeout_millis=10_000, **kwargs):
        result = self._inner.export(metrics_data, timeout_millis=timeout_millis, **kwargs)
        if result is MetricExportResult.FAILURE:
            if self._endpoint_ok:
                logger.warning(
                    "Kafka export failed — metrics will be dropped until it recovers  brokers=%s",
                    config.KAFKA_BROKERS,
                )
                self._endpoint_ok = False
        else:
            if not self._endpoint_ok:
                logger.info("Kafka export recovered  brokers=%s", config.KAFKA_BROKERS)
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

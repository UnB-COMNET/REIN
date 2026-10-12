"""Kafka-based OTLP metric exporter for the collector

Replaces the OTLP/gRPC transport with a Kafka producer. Metrics are serialized
to OTLP protobuf (ExportMetricsServiceRequest) via the same encoder the gRPC
exporter uses, then produced to a Kafka topic. The otel-collector's
kafkametricsreceiver consumes them and writes to ClickHouse
"""
import logging

from kafka import KafkaProducer
from opentelemetry.exporter.otlp.proto.common.metrics_encoder import encode_metrics
from opentelemetry.sdk.metrics.export import (
    MetricExporter,
    MetricExportResult,
    MetricsData,
)

from collector import config

logger = logging.getLogger(__name__)


class KafkaMetricExporter(MetricExporter):
    """Export OTLP metrics to a Kafka topic as protobuf bytes"""

    def __init__(
        self,
        brokers: str | None = None,
        topic: str | None = None,
        client_id: str | None = None,
    ):
        self._brokers = brokers or config.KAFKA_BROKERS
        self._topic = topic or config.KAFKA_TOPIC
        self._producer = KafkaProducer(
            bootstrap_servers=self._brokers,
            client_id=client_id or config.KAFKA_CLIENT_ID,
            acks=1,
            value_serializer=None,
            max_block_ms=5000,
        )
        logger.info(
            "Kafka metric exporter initialized  brokers=%s  topic=%s",
            self._brokers, self._topic,
        )

    def export(
        self,
        metrics_data: MetricsData,
        timeout_millis: float = 10_000,
        **kwargs,
    ) -> MetricExportResult:
        try:
            payload = encode_metrics(metrics_data).SerializeToString()
            self._producer.produce(self._topic, value=payload)
            self._producer.poll(0)
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

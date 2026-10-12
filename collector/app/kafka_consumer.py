"""Kafka → OTLP/gRPC bridge consumer

Reads OTLP protobuf metrics from a Kafka topic and forwards them to the
otel-collector via gRPC. This bridges the durable Kafka buffer back to the
otel-collector → ClickHouse pipeline

Usage: python3 -m collector.kafka_consumer
"""
import logging
import signal

import grpc
from kafka import KafkaConsumer
from opentelemetry.proto.collector.metrics.v1 import metrics_service_pb2
from opentelemetry.proto.collector.metrics.v1 import metrics_service_pb2_grpc

from collector import config

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

    consumer = KafkaConsumer(
        config.KAFKA_TOPIC,
        bootstrap_servers=config.KAFKA_BROKERS,
        group_id="otel-kafka-consumer",
        auto_offset_reset="earliest",
        enable_auto_commit=True,
    )
    channel = grpc.insecure_channel(config.OTEL_EXPORTER_OTLP_ENDPOINT)
    stub = metrics_service_pb2_grpc.MetricsServiceStub(channel)

    logger.info(
        "Kafka consumer started  brokers=%s  topic=%s  → otel=%s",
        config.KAFKA_BROKERS, config.KAFKA_TOPIC, config.OTEL_EXPORTER_OTLP_ENDPOINT,
    )

    while _running:
        for msg in consumer:
            if not _running:
                break
            try:
                request = metrics_service_pb2.ExportMetricsServiceRequest()
                request.ParseFromString(msg.value)
                stub.Export(request, timeout=10)
            except Exception as e:
                logger.error("Failed to forward metric batch: %s", e)

    consumer.close()
    channel.close()
    logger.info("Kafka consumer stopped")


if __name__ == "__main__":
    main()

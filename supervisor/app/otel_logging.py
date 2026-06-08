import logging
import os

from opentelemetry import _logs as logs  # noqa: F401
from opentelemetry.sdk._logs import LoggerProvider, LoggingHandler
from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
from opentelemetry.sdk.resources import Resource
from opentelemetry.exporter.otlp.proto.grpc._log_exporter import OTLPLogExporter

SERVICE_NAME = "supervisor"


def setup_otel_logging() -> LoggerProvider:
    endpoint = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4317")

    resource = Resource.create({
        "service.name": SERVICE_NAME,
        "service.version": "1.0.0",
    })

    provider = LoggerProvider(resource=resource)
    provider.add_log_record_processor(
        BatchLogRecordProcessor(
            OTLPLogExporter(endpoint=endpoint, insecure=True),
        )
    )
    logs.set_logger_provider(provider)

    handler = LoggingHandler(logger_provider=provider)
    logging.getLogger().addHandler(handler)

    logging.getLogger(__name__).info(
        "OTel logging initialized  service=%s  endpoint=%s", SERVICE_NAME, endpoint,
    )
    return provider

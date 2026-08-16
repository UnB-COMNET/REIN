import os

ONOS_BASE_URL = os.environ.get("ONOS_BASE_URL", "http://localhost:8181")
ONOS_USER = os.environ.get("ONOSUSER", "onos")
ONOS_PASS = os.environ.get("ONOSPASS", "rocks")
ONOS_KARAF = os.environ.get(
    "ONOS_KARAF",
    "docker exec -t c1 /root/onos/apache-karaf-4.2.9/bin/client -u karaf -p karaf",
)

COLLECTOR_INTERVAL = float(os.environ.get("COLLECTOR_INTERVAL", "5"))
STATS_WINDOW = int(os.environ.get("STATS_WINDOW", "5"))

OTEL_EXPORTER_OTLP_ENDPOINT = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4317")
OTEL_EXPORT_INTERVAL = float(os.environ.get("OTEL_EXPORT_INTERVAL", "5"))

# --- gNMI streaming telemetry -------------------------------------------------
GNMI_STREAM_ENABLED = os.environ.get("GNMI_STREAM_ENABLED", "true").lower() in ("1", "true", "yes")
GNMI_PORT = int(os.environ.get("GNMI_PORT", "9339"))
GNMI_SAMPLE_INTERVAL_NS = int(os.environ.get("GNMI_SAMPLE_INTERVAL_NS", "5000000000"))
GNMI_SKIP_VERIFY = os.environ.get("GNMI_SKIP_VERIFY", "true").lower() in ("1", "true", "yes")
GNMI_CONNECT_TIMEOUT = float(os.environ.get("GNMI_CONNECT_TIMEOUT", "10"))
GNMI_HOST_MAP = os.environ.get("GNMI_HOST_MAP", "")
GNMI_SUBNET = os.environ.get("GNMI_SUBNET", "")
GNMI_IFACE_PREFIX = os.environ.get("GNMI_IFACE_PREFIX", "eth")
# TLS cert paths
GNMI_TLS_CERT = os.environ.get("GNMI_TLS_CERT", "")
GNMI_TLS_KEY = os.environ.get("GNMI_TLS_KEY", "")
GNMI_TLS_CA = os.environ.get("GNMI_TLS_CA", "")

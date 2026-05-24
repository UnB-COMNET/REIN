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

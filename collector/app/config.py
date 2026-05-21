import os

ONOS_BASE_URL = os.environ.get("ONOS_BASE_URL", "http://localhost:8181")
ONOS_USER = os.environ.get("ONOSUSER", "onos")
ONOS_PASS = os.environ.get("ONOSPASS", "rocks")
ONOS_KARAF = os.environ.get(
    "ONOS_KARAF",
    "docker exec -t c1 /root/onos/apache-karaf-4.2.9/bin/client -u karaf -p karaf",
)

COLLECTOR_INTERVAL = float(os.environ.get("COLLECTOR_INTERVAL", "5"))
THROUGHPUT_WINDOW = int(os.environ.get("THROUGHPUT_WINDOW", "5"))
THROUGHPUT_PORT = int(os.environ.get("THROUGHPUT_PORT", "3"))
SERVER_UF = os.environ.get("SERVER_UF", "")

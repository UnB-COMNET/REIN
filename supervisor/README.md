# Supervisor

Monitors QoS KPIs from path deployed by the deployer and requests recalculation when a drift occurs.

## Behavior

1. The deployer POSTs the calculated path and access delay to `/supervise`
2. The supervisor stores the path as the current baseline and starts a 5-second monitor loop
3. Every 5s, the supervisor reads link RTT latencies and port throughput from ClickHouse (collected by the collector) and computes end-to-end delay by summing per-edge RTTs along the deployed path (plus `2 × access_delay_ms` for client/server access links) and a moving-average throughput from the server-facing port on ES
4. After a recalculate request, the loop pauses until the deployer sends a new path via `/supervise`

## Data Sources

- **Link latencies** — read from ClickHouse `otel_metrics_gauge` (`sdn.link.latency`), collected by the collector via gNMI streaming
- **Port throughput** — read from ClickHouse `otel_metrics_gauge` (`sdn.port.throughput`), collected by the collector via gNMI rate paths
- **Topology** — ONOS REST `/onos/v1/devices` (device discovery, still needed for path awareness)

The supervisor no longer queries ONOS Karaf CLI or ONOS REST `/statistics/ports` directly — all telemetry comes from ClickHouse


## Where to add new drift rules?

Drift criteria are defined inside `/app/services.py`, within the private method `_monitor_cycle`.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Health check |
| POST | `/supervise` | Receive calculated path from deployer |

### POST `/supervise` body

```json
{
    "path":            [[0, 2], [2, 3]],
    "access_delay_ms": 0.0
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `path` | `list[list[int, int]]` | Yes | Ordered list of edges `[i, j]` representing the deployed path (node indices into `ESTADOS`) |
| `access_delay_ms` | `float` | No | One-way access-link delay in ms (default `0.0`). Added twice to the total delay to account for client-side and server-side access links |

## Running

**Local**
```bash
pip install -e .
pip install -r requirements.txt
python -m flask --app app.routes run --port 5151
```

**Docker** 
```bash
sudo docker build -t supervisor .
sudo docker run --rm -it --network host -v /var/run/docker.sock:/var/run/docker.sock --name supervisor supervisor
```

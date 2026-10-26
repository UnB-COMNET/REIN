# Supervisor

Monitors QoS KPIs from path deployed by the deployer and requests recalculation when a drift occurs.

## Behavior

1. The deployer POSTs the calculated path and access delay to `/supervise`
2. The supervisor stores the path as the current baseline and starts a 10-second monitor loop (one timer per client)
3. Every 10s, the supervisor measures end-to-end delay by summing per-edge RTTs from the ONOS link-latencies app (plus `2 × access_delay_ms` for client/server access links) and computes a moving-average throughput from the byte counter of this client's own flow rule (matched by `IPV4_SRC`/`IPV4_DST`) on the server's access switch — not the switch port's aggregate counter, so co-tenants sharing that link don't dilute the measurement
4. The measurements go to the drift rule selected by `SUPERVISOR_MODE`
5. After a recalculate request, the loop pauses until the deployer sends a new path via `/supervise`. If the deployer cannot be reached the loop keeps ticking, so a deployer that is down for one cycle does not leave the client unmonitored
6. When the client's intent is removed (`remove service('cdn-qoe')`), the deployer calls `DELETE /supervise/<client_ip>` and the client's loop stops

## Layout

| Module | Responsibility |
|--------|----------------|
| `app/routes.py` | HTTP surface; reads `SUPERVISOR_MODE` and builds the service |
| `app/services.py` | `SupervisorService` — one monitor per client, plus what they share: drift rule, ONOS latency cache, deployer call |
| `app/monitor.py` | `IntentMonitor` — one client's timer and measurement cycle |
| `app/drift.py` | `Verdict` plus the drift rules, one per mode, and the `RULES` registry |
| `app/throughput.py` | `ThroughputProbe` — byte-counter state for one client flow on one server |
| `app/topology.py` | `DeployedPath` — edges ↔ state names ↔ link latency |
| `app/quantization.py` | 9-ary / 3-ary KPI quantization |
| `app/cdn_qoe.py` | ONOS topology discovery and the cdn-qoe solver |

## Where to add new drift rules?

Add a function to `app/drift.py` with the signature `(client_ip, path, kpis, source_uf, server_tx) -> Verdict`, then register it in `RULES`. Its key becomes a valid `SUPERVISOR_MODE` — an unregistered mode raises at startup instead of silently falling back.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Health check |
| POST | `/supervise` | Receive calculated path from deployer |
| DELETE | `/supervise/<client_ip>` | Stop monitoring a client (404 if it was not monitored) |
| GET | `/active_links` | Deduplicated `(PoP_A, PoP_B)` edges across all clients' active paths |
| GET | `/access_links` | Each client's own first-hop edge, keyed by `client_ip` |
| GET | `/metrics` | Snapshot of counters and timings |
| POST | `/metrics/reset` | Zero the counters (call at the start of each snapshot) |
| POST | `/metrics/degrade` | Record the timestamp a link was degraded, for the detection-time metric |

### POST `/supervise` body

```json
{
    "client_ip":       "192.168.0.11",
    "path":            [[0, 2], [2, 3]],
    "estados":         ["AM", "BA", "CE"],
    "source_uf":       "AM",
    "target_ufs":      ["CE"],
    "tx":              [500.0],
    "access_delay_ms": 0.0
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `client_ip` | `str` | Yes | Which intent this path belongs to. One monitor is kept per value |
| `path` | `list[list[int, int]]` | Yes | Ordered list of edges `[i, j]` representing the deployed path (node indices into `estados`) |
| `estados` | `list[str]` | No | The node order the indices in `path` refer to. ONOS can reorder its device list after the deploy, so the supervisor resolves every index through its state name |
| `source_uf` | `str` | No | The client's PoP. Required by the `best-path` rule, which re-solves from it |
| `target_ufs` | `list[str]` | No | The chosen server's PoP; the first entry is the one monitored for throughput |
| `tx` | `list[float]` | No | Available throughput per server (default `[500.0]`), so the supervisor solves the same problem the deployer did |
| `access_delay_ms` | `float` | No | One-way access-link delay in ms (default `0.0`). Added twice to the total delay to account for client-side and server-side access links |

## Running

**Local**
```bash
pip install -e .
pip install -r requirements.txt
SUPERVISOR_MODE=threshold python -m flask --app app.routes run --port 5151
```

**Docker** 
```bash
sudo docker build -t supervisor .
sudo docker run --rm -it --network host -v /var/run/docker.sock:/var/run/docker.sock \
  -e SUPERVISOR_MODE=threshold --name supervisor supervisor
```

### Drift mode

`SUPERVISOR_MODE` picks the drift rule. It is read once at startup, so changing it means restarting the container. The active mode is logged on boot as `[SUPERVISOR] drift mode: <value>`.

| Value | Behavior |
|-------|----------|
| `threshold` (default) | Quantizes the measured KPIs and reacts on Critical. Blind to a degradation that hurts without crossing a band |
| `best-path` | Ignores the measured levels; re-runs the cdn-qoe solver against the topology as it looks now and reacts when its answer is a genuinely cheaper path than the installed one |
| `llm` | Buffers 5 measurements, then asks the model at `$LLM_URL` (vLLM, OpenAI-compatible) whether the path should be rerouted, giving it the live link RTTs so it can tell "degraded" from "degraded but still cheapest". Blocking: that client's cycle stretches by the inference time |

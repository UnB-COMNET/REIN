# REIN Observability Database — Query Reference

> **Database:** `otel` on ClickHouse 24.8.6
> **HTTP API:** `POST http://localhost:8123/?database=otel` — always append `FORMAT JSON` to queries
> **Native TCP:** `clickhouse-client -d otel` on port 9000
> **TTL:** 7 days on all tables

---

## 1. Connection

### HTTP API (recommended for applications)

```
POST http://localhost:8123/?database=otel
Content-Type: text/plain

SELECT ... FORMAT JSON
```

Response format:
```json
{
  "meta": [{"name": "col", "type": "Type"}],
  "data": [{"col": "value"}],
  "rows": 1,
  "statistics": {"elapsed": 0.001, "rows_read": 1, "bytes_read": 1}
}
```

> **Important:** ClickHouse 24.8.6 ignores the `Accept: application/json` header. You MUST append `FORMAT JSON` to the query text. Without it, the response defaults to TSV.

### Native TCP (for CLI / admin)

```bash
clickhouse-client -d otel -q "SELECT ..."
```

---

## 2. Table Reference

### 2.1 `otel_logs`

Structured log records from the `deployer` and `supervisor` services.

| Column | Type | Description |
|---|---|---|
| `Timestamp` | DateTime64(9) | Log event timestamp (nanosecond precision) |
| `TraceId` | String | OTel trace ID (hex, 32 chars) |
| `SpanId` | String | OTel span ID (hex, 16 chars) |
| `TraceFlags` | UInt8 | W3C trace flags (bit 0 = sampled) |
| `SeverityText` | LowCardinality(String) | Severity level: `INFO`, `WARN`, `ERROR` |
| `SeverityNumber` | UInt8 | Numeric severity (INFO=9, WARN=13, ERROR=17) |
| `ServiceName` | LowCardinality(String) | Emitting service: `deployer`, `supervisor` |
| `Body` | String | Log message text |
| `EventName` | String | OTel event name (empty for standard logs) |
| `ResourceAttributes` | Map(String, String) | Process attributes (see below) |
| `ScopeName` | String | Instrumentation scope (logger name) |
| `ScopeAttributes` | Map(String, String) | Scope attributes |
| `LogAttributes` | Map(String, String) | Per-log attributes (see §3) |

**ResourceAttributes keys:** `service.name`, `service.version`, `telemetry.sdk.language`, `telemetry.sdk.name`, `telemetry.sdk.version`

**Engine:** MergeTree | **Partition:** `toDate(Timestamp)` | **Order:** `(toStartOf5min(Timestamp), ServiceName, Timestamp)` | **TTL:** 7 days

---

### 2.2 `otel_metrics_gauge`

Point-in-time gauge measurements from the `collector` service.

| Column | Type | Description |
|---|---|---|
| `ServiceName` | LowCardinality(String) | Always `collector` |
| `MetricName` | String | Metric identifier (see §4.1) |
| `MetricDescription` | String | Human-readable description |
| `MetricUnit` | String | `ms` or `bps` |
| `Attributes` | Map(String, String) | Per-data-point attributes (see §4.1) |
| `TimeUnix` | DateTime64(9) | Data point timestamp |
| `Value` | Float64 | Gauge value |
| `StartTimeUnix` | DateTime64(9) | Gauge start timestamp |

**Engine:** MergeTree | **Partition:** `toDate(TimeUnix)` | **Order:** `(ServiceName, MetricName, Attributes, TimeUnix)` | **TTL:** 7 days

---

### 2.3 `otel_metrics_sum`

Cumulative counter deltas from the `collector` service.

| Column | Type | Description |
|---|---|---|
| `ServiceName` | LowCardinality(String) | Always `collector` |
| `MetricName` | String | Metric identifier (see §4.2) |
| `MetricDescription` | String | Human-readable description |
| `MetricUnit` | String | `By` (bytes) or `1` (dimensionless) |
| `Attributes` | Map(String, String) | Per-data-point attributes (see §4.2) |
| `TimeUnix` | DateTime64(9) | Data point timestamp |
| `Value` | Float64 | Delta value since last export |
| `StartTimeUnix` | DateTime64(9) | Counter start timestamp |
| `AggregationTemporality` | Int32 | `1` = DELTA, `2` = CUMULATIVE |
| `IsMonotonic` | Bool | `true` for counters that only increase |

**Engine:** MergeTree | **Partition:** `toDate(TimeUnix)` | **Order:** `(ServiceName, MetricName, Attributes, TimeUnix)` | **TTL:** 7 days

---

## 3. Log Event Catalog

Structured events stored in `LogAttributes`. Access via `LogAttributes['key']`.

### 3.1 `intent_deploy`

Emitted by the **deployer** when a new intent is deployed via `POST /deploy`.

| Attribute | Type | Description | Example |
|---|---|---|---|
| `event_type` | String | Always `"intent_deploy"` | `"intent_deploy"` |
| `intent` | String | Nile intent text | `"from endpoint('192.168.0.2') add service('cdn-qoe')"` |
| `deploy_status` | String | HTTP status code | `"200"`, `"500"` |
| `controller_count` | String | Number of controllers that responded | `"1"` |

Also includes standard attributes: `code.file.path`, `code.function.name`, `code.line.number`.

### 3.2 `intent_recalculate`

Emitted by the **deployer** when the supervisor triggers a recalculation via `POST /deploy/recalculate`.

| Attribute | Type | Description | Example |
|---|---|---|---|
| `event_type` | String | Always `"intent_recalculate"` | `"intent_recalculate"` |
| `intent` | String | Nile intent text | `"from endpoint('192.168.0.2') add service('cdn-qoe')"` |
| `deploy_status` | String | HTTP status code | `"200"`, `"500"` |
| `recalculate_time_s` | String | Recalculation duration in seconds | `"0.0432"` |

### 3.3 `intent_delete_all`

Emitted by the **deployer** when all intents are deleted via `DELETE /delete_all`.

| Attribute | Type | Description | Example |
|---|---|---|---|
| `event_type` | String | Always `"intent_delete_all"` | `"intent_delete_all"` |
| `intent_count` | String | Number of intents before deletion | `"2"` |

---

## 4. SDN Metrics Catalog

### 4.1 Gauge Metrics (`otel_metrics_gauge`)

#### `sdn.link.latency`

RTT latency of an active SDN link.

| Property | Value |
|---|---|
| **Unit** | `ms` (milliseconds) |
| **Description** | RTT latency of an active SDN link |
| **Service** | `collector` |

**Attributes:**

| Key | Type | Description | Example |
|---|---|---|---|
| `src_device` | String | Source switch DPID | `"of:0000000000000001"` |
| `src_port` | String | Source port number | `"1"` |
| `dst_device` | String | Destination switch DPID | `"of:0000000000000002"` |
| `dst_port` | String | Destination port number | `"1"` |
| `link_type` | String | Link type | `"DIRECT"` |

---

#### `sdn.port.throughput`

Moving-average throughput on a device port (5-sample sliding window).

| Property | Value |
|---|---|
| **Unit** | `bps` (bits per second) |
| **Description** | Moving-average throughput on a device port |
| **Service** | `collector` |

**Attributes:**

| Key | Type | Description | Example |
|---|---|---|---|
| `device_id` | String | Switch DPID | `"of:0000000000000001"` |
| `port` | String | Port number | `"1"` |
| `direction` | String | Traffic direction | `"sent"`, `"received"` |

---

### 4.2 Sum Metrics (`otel_metrics_sum`)

#### `sdn.flow.bytes`

Cumulative bytes matched by a flow rule.

| Property | Value |
|---|---|
| **Unit** | `By` (bytes) |
| **Description** | Cumulative bytes matched by a flow rule |
| **Service** | `collector` |

**Attributes:**

| Key | Type | Description | Example |
|---|---|---|---|
| `device_id` | String | Switch DPID | `"of:0000000000000003"` |
| `flow_id` | String | Flow rule ID (decimal) | `"281478772850701"` |
| `app_id` | String | ONOS application ID | `"org.onosproject.core"` |
| `table_id` | String | Flow table ID | `"0"` |
| `priority` | String | Flow rule priority | `"40000"` |
| `output_port` | String | Output port (empty if none) | `"2"`, `""` |

---

#### `sdn.flow.packets`

Cumulative packets matched by a flow rule. Same attributes as `sdn.flow.bytes`.

| Property | Value |
|---|---|
| **Unit** | `1` (count) |
| **Description** | Cumulative packets matched by a flow rule |

---

#### `sdn.onos.requests`

Total API/CLI requests made by the collector to the ONOS controller.

| Property | Value |
|---|---|
| **Unit** | `1` (count) |
| **Description** | Number of API/CLI requests made to the ONOS controller |
| **Attributes** | None (global counter) |

---

#### `sdn.port.bytes`

Cumulative bytes transferred on a device port.

| Property | Value |
|---|---|
| **Unit** | `By` (bytes) |
| **Description** | Cumulative bytes transferred on a device port |

**Attributes:**

| Key | Type | Description | Example |
|---|---|---|---|
| `device_id` | String | Switch DPID | `"of:0000000000000001"` |
| `port` | String | Port number | `"1"` |
| `direction` | String | Traffic direction | `"sent"`, `"received"` |

---

#### `sdn.port.packets`

Cumulative packets transferred on a device port. Same attributes as `sdn.port.bytes`.

| Property | Value |
|---|---|
| **Unit** | `1` (count) |
| **Description** | Cumulative packets transferred on a device port |

---

#### `sdn.port.drops`

Cumulative dropped packets on a device port. Same attributes as `sdn.port.bytes`.

| Property | Value |
|---|---|
| **Unit** | `1` (count) |
| **Description** | Cumulative dropped packets on a device port |

---

#### `sdn.port.errors`

Cumulative errored packets on a device port. Same attributes as `sdn.port.bytes`.

| Property | Value |
|---|---|
| **Unit** | `1` (count) |
| **Description** | Cumulative errored packets on a device port |

---

## 5. Query Patterns

### 5.1 Component Health

Check if a service is healthy based on recent logs.

```sql
SELECT
    max(Timestamp)  as last_ts,
    countIf(SeverityText = 'ERROR') as err_count,
    countIf(SeverityText = 'WARN')  as warn_count
FROM otel_logs
WHERE ServiceName = 'deployer'
  AND Timestamp >= now() - INTERVAL 60 SECOND
```

**Returns:**

| Column | Type | Description |
|---|---|---|
| `last_ts` | DateTime64(9) | Most recent log timestamp (epoch zero if no logs) |
| `err_count` | UInt64 | Error log count in window |
| `warn_count` | UInt64 | Warning log count in window |

**Logic:** `last_ts` = epoch zero → OFFLINE | `err_count > 0` → UNHEALTHY | `warn_count > 0` → DEGRADED | else → HEALTHY

---

### 5.2 Link Latency — Latest per Link

```sql
SELECT
    Attributes['src_device'] as src_device,
    Attributes['src_port']   as src_port,
    Attributes['dst_device'] as dst_device,
    Attributes['dst_port']   as dst_port,
    argMax(Value, TimeUnix)  as latency_ms,
    max(TimeUnix)            as last_ts
FROM otel_metrics_gauge
WHERE MetricName = 'sdn.link.latency'
GROUP BY src_device, src_port, dst_device, dst_port
ORDER BY src_device, dst_device
```

**Returns:**

| Column | Type | Description |
|---|---|---|
| `src_device` | String | Source switch DPID |
| `src_port` | String | Source port |
| `dst_device` | String | Destination switch DPID |
| `dst_port` | String | Destination port |
| `latency_ms` | Float64 | Latest latency in milliseconds |
| `last_ts` | DateTime64(9) | Timestamp of latest measurement |

---

### 5.3 Link Latency — Time Series for a Link

```sql
SELECT TimeUnix, Value as latency_ms
FROM otel_metrics_gauge
WHERE MetricName = 'sdn.link.latency'
  AND Attributes['src_device'] = 'of:0000000000000001'
  AND Attributes['dst_device'] = 'of:0000000000000002'
ORDER BY TimeUnix DESC
LIMIT 100
```

**Returns:** `(TimeUnix DateTime64(9), latency_ms Float64)` — recent latency readings for one link.

---

### 5.4 Port Throughput — Latest per Port

```sql
SELECT
    Attributes['device_id'] as device_id,
    Attributes['port']      as port,
    Attributes['direction'] as direction,
    argMax(Value, TimeUnix) as bps,
    max(TimeUnix)           as last_ts
FROM otel_metrics_gauge
WHERE MetricName = 'sdn.port.throughput'
GROUP BY device_id, port, direction
ORDER BY device_id, port, direction
```

**Returns:**

| Column | Type | Description |
|---|---|---|
| `device_id` | String | Switch DPID |
| `port` | String | Port number |
| `direction` | String | `sent` or `received` |
| `bps` | Float64 | Latest throughput in bits per second |
| `last_ts` | DateTime64(9) | Timestamp of latest measurement |

---

### 5.5 Port Throughput — Top N Busiest Ports

```sql
SELECT
    Attributes['device_id'] as device_id,
    Attributes['port']      as port,
    argMax(Value, TimeUnix) as bps
FROM otel_metrics_gauge
WHERE MetricName = 'sdn.port.throughput'
  AND Attributes['direction'] = 'sent'
GROUP BY device_id, port
ORDER BY bps DESC
LIMIT 10
```

**Returns:** `(device_id String, port String, bps Float64)` — top 10 ports by sent throughput.

---

### 5.6 Port Counters — Bytes/Packets/Drops/Errors per Device+Port

```sql
SELECT
    Attributes['device_id'] as device_id,
    Attributes['port']      as port,
    Attributes['direction'] as direction,
    sum(Value)              as total
FROM otel_metrics_sum
WHERE MetricName = 'sdn.port.bytes'
GROUP BY device_id, port, direction
ORDER BY total DESC
```

**Returns:** `(device_id String, port String, direction String, total Float64)` — cumulative bytes per port. Replace `sdn.port.bytes` with `sdn.port.packets`, `sdn.port.drops`, or `sdn.port.errors` for other counters.

---

### 5.7 Flow Metrics — Bytes/Packets per Flow Rule

```sql
SELECT
    Attributes['device_id'] as device_id,
    Attributes['flow_id']   as flow_id,
    Attributes['app_id']    as app_id,
    sum(Value)              as total_bytes
FROM otel_metrics_sum
WHERE MetricName = 'sdn.flow.bytes'
GROUP BY device_id, flow_id, app_id
ORDER BY total_bytes DESC
LIMIT 20
```

**Returns:** `(device_id String, flow_id String, app_id String, total_bytes Float64)` — top 20 flows by byte count. Replace `sdn.flow.bytes` with `sdn.flow.packets` for packet counts.

---

### 5.8 ONOS Request Count

```sql
SELECT sum(Value) as total_requests
FROM otel_metrics_sum
WHERE MetricName = 'sdn.onos.requests'
```

**Returns:** `(total_requests Float64)` — total API/CLI requests made by the collector to ONOS.

---

### 5.9 Intent Deploy History

```sql
SELECT
    Timestamp,
    LogAttributes['intent']       as intent,
    LogAttributes['deploy_status'] as deploy_status,
    LogAttributes['controller_count'] as controller_count
FROM otel_logs
WHERE LogAttributes['event_type'] = 'intent_deploy'
ORDER BY Timestamp DESC
LIMIT 20
```

**Returns:**

| Column | Type | Description |
|---|---|---|
| `Timestamp` | DateTime64(9) | Deploy timestamp |
| `intent` | String | Nile intent text |
| `deploy_status` | String | HTTP status code |
| `controller_count` | String | Number of controllers that responded |

---

### 5.10 Intent Recalculate History

```sql
SELECT
    Timestamp,
    LogAttributes['intent']            as intent,
    LogAttributes['deploy_status']     as deploy_status,
    LogAttributes['recalculate_time_s'] as recalculate_time_s
FROM otel_logs
WHERE LogAttributes['event_type'] = 'intent_recalculate'
ORDER BY Timestamp DESC
LIMIT 20
```

**Returns:**

| Column | Type | Description |
|---|---|---|
| `Timestamp` | DateTime64(9) | Recalculation timestamp |
| `intent` | String | Nile intent text |
| `deploy_status` | String | HTTP status code |
| `recalculate_time_s` | String | Duration in seconds |

---

### 5.11 Failed Deployments

```sql
SELECT Timestamp, Body, LogAttributes['intent'] as intent
FROM otel_logs
WHERE LogAttributes['event_type'] LIKE 'intent_%'
  AND LogAttributes['deploy_status'] != '200'
ORDER BY Timestamp DESC
LIMIT 20
```

**Returns:** `(Timestamp DateTime64(9), Body String, intent String)` — all intent events with non-200 status.

---

### 5.12 Error Logs by Service

```sql
SELECT Timestamp, ServiceName, Body
FROM otel_logs
WHERE SeverityText = 'ERROR'
ORDER BY Timestamp DESC
LIMIT 50
```

**Returns:** `(Timestamp DateTime64(9), ServiceName String, Body String)` — recent error logs across all services.

---

### 5.13 Error Rate by Service (last 5 minutes)

```sql
SELECT
    ServiceName,
    count() as total,
    countIf(SeverityText = 'ERROR') as errors,
    round(errors / total * 100, 2) as error_rate_pct
FROM otel_logs
WHERE Timestamp >= now() - INTERVAL 300 SECOND
GROUP BY ServiceName
```

**Returns:** `(ServiceName String, total UInt64, errors UInt64, error_rate_pct Float64)` — log volume and error percentage per service.

---

## 6. Performance Notes

### Bloom Filter Indexes

All three tables have bloom filter indexes on Map column keys and values. These speed up queries that filter on specific attribute keys:

```sql
-- Fast: bloom filter on mapKeys(LogAttributes) prunes granules
WHERE LogAttributes['event_type'] = 'intent_deploy'

-- Fast: bloom filter on mapKeys(Attributes) prunes granules
WHERE Attributes['device_id'] = 'of:0000000000000001'

-- Slow: full scan (no index on map key+value combination)
WHERE LogAttributes['intent'] LIKE '%cdn%'
```

The `otel_logs` table also has a **token bloom filter** on `lower(Body)` for fast text search in log messages.

### Partition Pruning

All tables are partitioned by date (`toDate(Timestamp)` or `toDate(TimeUnix)`). Queries with date filters prune entire partitions:

```sql
-- Fast: only scans partitions for the last hour
WHERE Timestamp >= now() - INTERVAL 1 HOUR

-- Slow: scans all partitions (7 days of data)
WHERE SeverityText = 'ERROR'
```

### TTL

All tables have a 7-day TTL. Data older than 7 days is automatically dropped. Adjust in `collector/otel-collector-config.yaml` under `exporters.clickhouse.ttl`.

### Map Column Access

Map columns (`Attributes`, `LogAttributes`, `ResourceAttributes`) are accessed with bracket syntax:

```sql
SELECT Attributes['device_id']    -- single key lookup
SELECT mapKeys(Attributes)        -- all keys
SELECT mapValues(Attributes)      -- all values
```

Map key lookups are efficient due to bloom filter indexes. However, they return `String` type — cast numeric values explicitly:

```sql
SELECT toFloat64(LogAttributes['recalculate_time_s']) as time_s
```

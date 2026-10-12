CREATE DATABASE IF NOT EXISTS otel;

-- MergeTree tables (same schema the otel-collector would create with create_schema: true)
-- Captured from schema.dbml + SHOW CREATE TABLE on a running instance

CREATE TABLE IF NOT EXISTS otel.otel_metrics_gauge
(
    ResourceAttributes Map(LowCardinality(String), String),
    ScopeName String,
    ScopeAttributes Map(LowCardinality(String), String),
    ServiceName LowCardinality(String),
    MetricName String,
    MetricDescription String,
    MetricUnit LowCardinality(String),
    Attributes Map(LowCardinality(String), String),
    StartTimeUnix DateTime64(9),
    TimeUnix DateTime64(9),
    Value Float64
)
ENGINE = MergeTree
PARTITION BY toDate(TimeUnix)
ORDER BY (ServiceName, MetricName, Attributes, TimeUnix)
TTL TimeUnix + INTERVAL 7 DAY;

CREATE TABLE IF NOT EXISTS otel.otel_metrics_sum
(
    ResourceAttributes Map(LowCardinality(String), String),
    ScopeName String,
    ScopeAttributes Map(LowCardinality(String), String),
    ServiceName LowCardinality(String),
    MetricName String,
    MetricDescription String,
    MetricUnit LowCardinality(String),
    Attributes Map(LowCardinality(String), String),
    StartTimeUnix DateTime64(9),
    TimeUnix DateTime64(9),
    Value Float64,
    AggregationTemporality Int32,
    IsMonotonic Bool
)
ENGINE = MergeTree
PARTITION BY toDate(TimeUnix)
ORDER BY (ServiceName, MetricName, Attributes, TimeUnix)
TTL TimeUnix + INTERVAL 7 DAY;

CREATE TABLE IF NOT EXISTS otel.otel_logs
(
    Timestamp DateTime64(9),
    TraceId String,
    SpanId String,
    TraceFlags UInt8,
    SeverityText LowCardinality(String),
    SeverityNumber UInt8,
    ServiceName LowCardinality(String),
    Body String,
    ResourceSchemaUrl LowCardinality(String),
    ResourceAttributes Map(LowCardinality(String), String),
    ScopeSchemaUrl LowCardinality(String),
    ScopeName String,
    ScopeVersion LowCardinality(String),
    ScopeAttributes Map(LowCardinality(String), String),
    LogAttributes Map(LowCardinality(String), String),
    EventName String
)
ENGINE = MergeTree
PARTITION BY toDate(Timestamp)
ORDER BY (toStartOf5min(Timestamp), ServiceName, Timestamp)
TTL Timestamp + INTERVAL 7 DAY;

-- Kafka engine tables (consume JSONEachRow from Kafka topics)

CREATE TABLE IF NOT EXISTS otel.kafka_metrics_gauge
(
    ResourceAttributes Map(LowCardinality(String), String),
    ScopeName String,
    ScopeAttributes Map(LowCardinality(String), String),
    ServiceName LowCardinality(String),
    MetricName String,
    MetricDescription String,
    MetricUnit LowCardinality(String),
    Attributes Map(LowCardinality(String), String),
    StartTimeUnix DateTime64(9),
    TimeUnix DateTime64(9),
    Value Float64
)
ENGINE = Kafka()
SETTINGS
    kafka_broker_list = 'localhost:9092',
    kafka_topic_list = 'otel-metrics-gauge',
    kafka_group_name = 'clickhouse-gauge',
    kafka_format = 'JSONEachRow',
    kafka_skip_broken_messages = 100;

CREATE TABLE IF NOT EXISTS otel.kafka_metrics_sum
(
    ResourceAttributes Map(LowCardinality(String), String),
    ScopeName String,
    ScopeAttributes Map(LowCardinality(String), String),
    ServiceName LowCardinality(String),
    MetricName String,
    MetricDescription String,
    MetricUnit LowCardinality(String),
    Attributes Map(LowCardinality(String), String),
    StartTimeUnix DateTime64(9),
    TimeUnix DateTime64(9),
    Value Float64,
    AggregationTemporality Int32,
    IsMonotonic Bool
)
ENGINE = Kafka()
SETTINGS
    kafka_broker_list = 'localhost:9092',
    kafka_topic_list = 'otel-metrics-sum',
    kafka_group_name = 'clickhouse-sum',
    kafka_format = 'JSONEachRow',
    kafka_skip_broken_messages = 100;

-- Materialized views (Kafka engine → MergeTree)

CREATE MATERIALIZED VIEW IF NOT EXISTS otel.mv_metrics_gauge
TO otel.otel_metrics_gauge
AS SELECT * FROM otel.kafka_metrics_gauge;

CREATE MATERIALIZED VIEW IF NOT EXISTS otel.mv_metrics_sum
TO otel.otel_metrics_sum
AS SELECT * FROM otel.kafka_metrics_sum;

import json
import os

import requests
from flask import Flask, jsonify, render_template, request

app = Flask(__name__)

CH_URL = os.environ.get("CLICKHOUSE_URL", "http://localhost:8123")
DEPLOYER_URL = os.environ.get("DEPLOYER_URL", "http://localhost:5000")
CH_DB = "otel"


def _ch_query(sql):
    r = requests.post(
        f"{CH_URL}/",
        params={"database": CH_DB, "query": sql},
        headers={"Accept": "application/json"},
        timeout=10,
    )
    r.raise_for_status()
    return r.json().get("data", [])


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/health")
def api_health():
    services = ["collector", "supervisor", "deployer"]
    health = {}
    for svc in services:
        try:
            rows = _ch_query(
                f"SELECT max(TimeUnix) as last_ts, "
                f"countIf(severity_text='ERROR') as err_count, "
                f"countIf(severity_text='WARN') as warn_count "
                f"FROM otel_logs "
                f"WHERE service_name = '{svc}' "
                f"AND TimeUnix >= now() - INTERVAL 60 SECOND"
            )
            if not rows:
                health[svc] = {"status": "OFFLINE", "last_ts": None}
                continue
            row = rows[0]
            last_ts = row.get("last_ts")
            err_count = int(row.get("err_count", 0))
            warn_count = int(row.get("warn_count", 0))
            if not last_ts:
                health[svc] = {"status": "OFFLINE", "last_ts": None}
            elif err_count > 0:
                health[svc] = {"status": "UNHEALTHY", "last_ts": last_ts}
            elif warn_count > 0:
                health[svc] = {"status": "DEGRADED", "last_ts": last_ts}
            else:
                health[svc] = {"status": "HEALTHY", "last_ts": last_ts}
        except Exception:
            health[svc] = {"status": "OFFLINE", "last_ts": None}
    return jsonify(health)


@app.route("/api/metrics")
def api_metrics():
    result = {"gauge": [], "sum": []}
    try:
        result["gauge"] = _ch_query(
            "SELECT metric_name, argMax(value, TimeUnix) as latest_value, "
            "max(TimeUnix) as last_ts "
            "FROM otel_metrics_gauge "
            "GROUP BY metric_name "
            "ORDER BY metric_name"
        )
    except Exception:
        pass
    try:
        result["sum"] = _ch_query(
            "SELECT metric_name, sum(value) as total_value, "
            "max(TimeUnix) as last_ts "
            "FROM otel_metrics_sum "
            "GROUP BY metric_name "
            "ORDER BY metric_name"
        )
    except Exception:
        pass
    return jsonify(result)


@app.route("/api/intents")
def api_intents():
    try:
        rows = _ch_query(
            "SELECT Timestamp, Body, "
            "LogAttributes['event_type'] as event_type, "
            "LogAttributes['intent'] as intent, "
            "LogAttributes['deploy_status'] as deploy_status, "
            "LogAttributes['recalculate_time_s'] as recalculate_time_s, "
            "LogAttributes['intent_count'] as intent_count "
            "FROM otel_logs "
            "WHERE LogAttributes['event_type'] LIKE 'intent_%' "
            "ORDER BY Timestamp DESC LIMIT 20"
        )
        return jsonify(rows)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/deploy", methods=["POST"])
def api_deploy():
    data = request.get_json(silent=True, force=True)
    intent_text = data.get("intent", "") if data else ""
    if not intent_text:
        return jsonify({"error": "intent text is required"}), 400
    try:
        r = requests.post(
            f"{DEPLOYER_URL}/deploy",
            json={"intent": intent_text},
            headers={"Content-Type": "application/json"},
            timeout=30,
        )
        return jsonify(r.json()), r.status_code
    except Exception as e:
        return jsonify({"error": str(e)}), 502


@app.route("/api/query", methods=["POST"])
def api_query():
    data = request.get_json(silent=True, force=True)
    sql = data.get("sql", "") if data else ""
    if not sql:
        return jsonify({"error": "sql is required"}), 400
    try:
        rows = _ch_query(sql)
        return jsonify(rows)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    port = int(os.environ.get("GUI_PORT", 8080))
    app.run(host="0.0.0.0", port=port)

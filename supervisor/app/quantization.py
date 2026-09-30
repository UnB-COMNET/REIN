from typing import Dict, Tuple

P9_LABELS = {
     0: "Normal",
     1: "Slightly > Normal",  2: "Slightly High",  3: "High",  4: "Very High",
    -1: "Slightly < Normal", -2: "Slightly Low",  -3: "Low",  -4: "Very Low",
}

P3_LABELS = {1: "Normal", 0: "Warning", -1: "Critical"}

POLICIES = {
    "RTT_ms": {
        "target": (0.0, 50.0),
        "above_steps": [70.0, 90.0, 110.0],
        "below_steps": [], # negative latency is impossible
        "unit": "ms",
    },
    "Vazao_Mbps": {
        "target": (25.0, 35.0), # 4K streaming band
        "above_steps": [55.0, 75.0, 95.0],
        "below_steps": [20.0, 15.0, 10.0],
        "unit": "Mbps",
    },
}


# Brief: Value a KPI must drop below for P9 to reach -3, which is where p9_to_p3
# turns Critical and a recalculation is requested. Reported alongside a Warning
# so "how close did it get" is visible, instead of only "it was not Critical".
def critical_below(kpi_name: str) -> float:
    steps = POLICIES[kpi_name]["below_steps"]
    return steps[1] if len(steps) > 1 else float("-inf")


# Brief: Walks the step thresholds outward from the target band, incrementing the
# deviation level for each crossed boundary
def _walk_steps(value: float, steps: list, direction: int) -> int:
    level = direction # direction = +1 for above, -1 for below
    for threshold in steps: # ex: steps = [70.0, 90.0, 110.0] for RTT_ms above the target band
        crossed = value > threshold if direction == 1 else value < threshold
        if not crossed:
            break
        level += direction
    return max(-4, min(4, level))


# Brief: Maps a continuous KPI value to its 9-ary deviation level (−4 … +4) and description
def quantize_9ary(kpi_name: str, value: float) -> Tuple[int, str]:
    policy = POLICIES[kpi_name]
    low, high = policy["target"]

    if low <= value <= high:
        return 0, P9_LABELS[0]

    if value > high:
        level = _walk_steps(value, policy["above_steps"], +1)
        return level, P9_LABELS[level]

    if not policy["below_steps"]:
        return 0, P9_LABELS[0]
    level = _walk_steps(value, policy["below_steps"], -1)
    return level, P9_LABELS[level]


# Brief: Collapses a P9 level to P3 (0→Normal, ±1,±2→Warning, ±3,±4→Critical)
def p9_to_p3(p9: int) -> Tuple[int, str]:
    if p9 == 0:
        return 1, P3_LABELS[1]
    if p9 in (-1, -2, 1, 2):
        return 0, P3_LABELS[0]
    return -1, P3_LABELS[-1]


class KpiResult:
    __slots__ = ("value", "p9", "p9_label", "p3", "p3_label")

    def __init__(self, value: float, p9: int, p9_label: str, p3: int, p3_label: str):
        self.value = value
        self.p9 = p9
        self.p9_label = p9_label
        self.p3 = p3
        self.p3_label = p3_label

    def __repr__(self) -> str:
        return (
            f"KpiResult(value={self.value}, "
            f"P9={self.p9} '{self.p9_label}', "
            f"P3={self.p3} '{self.p3_label}')"
        )


# Brief: Quantizes all KPIs and returns the overall P3 health and per-KPI details
def evaluate_service_health(kpis: Dict[str, float]) -> Tuple[int, Dict[str, KpiResult]]:
    details: Dict[str, KpiResult] = {}
    p3_values = []

    for name, value in kpis.items(): # ex: kpis = {"RTT_ms": 43.8, "Vazao_Mbps": 24.84}
        p9, p9_label = quantize_9ary(name, value)
        p3, p3_label = p9_to_p3(p9)
        details[name] = KpiResult(value, p9, p9_label, p3, p3_label)
        p3_values.append(p3)

    overall = min(p3_values) if p3_values else 1
    return overall, details

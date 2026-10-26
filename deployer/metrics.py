import threading

_COUNTER_KEYS = {
    "msgs_deployer_to_controller",
    "msgs_controller_to_network",
    "msgs_observer_to_deployer",
    "msgs_deployer_to_observer",
}

_TIMING_KEYS = ("solve_time_s", "deploy_time_s", "total_recalculate_time_s")
_COUNTER_KEYS.update(f"{key}_{suffix}" for key in _TIMING_KEYS for suffix in ("count", "sum"))

_lock = threading.Lock()
_state: dict = {
    "msgs_deployer_to_controller": 0,
    "msgs_controller_to_network":  0,
    "msgs_observer_to_deployer":   0,
    "msgs_deployer_to_observer":   0,
    "solve_time_s":                None,
    "deploy_time_s":               None,
    "total_recalculate_time_s":    None,
}

_state.update({key: 0 for key in _COUNTER_KEYS})


def increment(key: str, n: int = 1) -> None:
    with _lock:
        _state[key] = (_state.get(key) or 0) + n


def set_value(key: str, value) -> None:
    with _lock:
        _state[key] = value
        if key in _TIMING_KEYS and value is not None:
            _state[f"{key}_count"] += 1
            _state[f"{key}_sum"] += value


def snapshot() -> dict:
    with _lock:
        return dict(_state)


def reset() -> dict:
    with _lock:
        previous = dict(_state)
        for k in list(_state):
            _state[k] = 0 if k in _COUNTER_KEYS else None
        return previous

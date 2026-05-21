import threading

_COUNTER_KEYS = {
    "msgs_onos_to_observer",
    "msgs_observer_to_deployer",
    "drift_detected",
}

_lock = threading.Lock()
_state: dict = {
    "msgs_onos_to_observer":    0,
    "msgs_observer_to_deployer": 0,
    "drift_detected":            0,
    "detection_time_s":          None,
    "degrade_ts":                None,
}


def increment(key: str, n: int = 1) -> None:
    with _lock:
        _state[key] = (_state.get(key) or 0) + n


def set_value(key: str, value) -> None:
    with _lock:
        _state[key] = value


def get_value(key: str):
    with _lock:
        return _state.get(key)


def snapshot() -> dict:
    with _lock:
        return dict(_state)


def reset() -> None:
    with _lock:
        for k in list(_state):
            _state[k] = 0 if k in _COUNTER_KEYS else None

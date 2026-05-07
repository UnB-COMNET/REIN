import threading

_COUNTER_KEYS = {
    "msgs_deployer_to_controller",
    "msgs_controller_to_network",
    "msgs_observer_to_deployer",
    "msgs_deployer_to_observer",
}

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


def increment(key: str, n: int = 1) -> None:
    with _lock:
        _state[key] = (_state.get(key) or 0) + n


def set_value(key: str, value) -> None:
    with _lock:
        _state[key] = value


def snapshot() -> dict:
    with _lock:
        return dict(_state)


def reset() -> None:
    with _lock:
        for k in list(_state):
            _state[k] = 0 if k in _COUNTER_KEYS else None

from __future__ import annotations

from threading import RLock

from backend.app.core.contracts import TwinState


class DigitalTwinStore:
    """Thread-safe in-memory state store for the single-process hackathon demo."""

    def __init__(self, initial_state: TwinState):
        self._lock = RLock()
        self._state = initial_state

    def get(self) -> TwinState:
        with self._lock:
            return self._state

    def replace(self, state: TwinState) -> TwinState:
        with self._lock:
            self._state = state
            return self._state

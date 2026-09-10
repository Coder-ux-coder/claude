"""Circuit breakers.

The failure this prevents is specific and expensive. Suppose a key is wrong, or
a plan has run out of credits. Every row then hits the same provider, gets the
same 401 or 402, and the pipeline dutifully moves on -- two thousand times. That
wastes an hour of wall clock, floods the audit log with identical errors, and on
providers that bill failed authentication it can cost money.

A breaker watches consecutive *permanent* failures for one provider. After a
threshold it opens, and the pipeline skips that provider for the rest of the run
with a clear reason attached to every affected row.

Transient failures never trip it: a provider having a bad minute is exactly what
the retry layer is for, and tripping on that would disable a healthy provider.
"""
from __future__ import annotations

import threading
from dataclasses import dataclass, field


@dataclass
class BreakerState:
    consecutive_failures: int = 0
    opened: bool = False
    reason: str = ""
    trips: int = 0


class CircuitBreaker:
    """Tracks one breaker per provider."""

    def __init__(self, threshold: int = 5):
        self.threshold = max(1, threshold)
        self._states: dict[str, BreakerState] = {}
        self._lock = threading.Lock()

    def _state(self, provider: str) -> BreakerState:
        if provider not in self._states:
            self._states[provider] = BreakerState()
        return self._states[provider]

    def is_open(self, provider: str) -> bool:
        with self._lock:
            return self._state(provider).opened

    def reason(self, provider: str) -> str:
        with self._lock:
            return self._state(provider).reason

    def record_success(self, provider: str) -> None:
        """A clean answer -- including a clean no-match -- clears the count."""
        with self._lock:
            st = self._state(provider)
            st.consecutive_failures = 0

    def record_permanent_failure(self, provider: str, detail: str) -> bool:
        """Returns True if this failure opened the breaker."""
        with self._lock:
            st = self._state(provider)
            st.consecutive_failures += 1
            if not st.opened and st.consecutive_failures >= self.threshold:
                st.opened = True
                st.trips += 1
                st.reason = (
                    f"{st.consecutive_failures} consecutive permanent failures; "
                    f"last: {detail[:160]}")
                return True
            return False

    def open_now(self, provider: str, reason: str) -> None:
        """Trip immediately, for failures that can never resolve mid-run.

        A 401 is not worth five attempts: the key will not become correct.
        """
        with self._lock:
            st = self._state(provider)
            if not st.opened:
                st.opened = True
                st.trips += 1
                st.reason = reason[:200]

    def reset(self, provider: str) -> None:
        with self._lock:
            self._states[provider] = BreakerState()

    def summary(self) -> dict:
        with self._lock:
            return {n: {"open": s.opened, "reason": s.reason}
                    for n, s in self._states.items() if s.opened}


#: HTTP statuses that will not fix themselves by retrying or by trying the next
#: row. Anything here trips the breaker on first sight.
FATAL_STATUSES = {
    401: "authentication failed -- check the API key",
    402: "payment required -- the plan is out of credits",
    403: "forbidden -- the key lacks permission for this endpoint, "
         "or the plan does not include it",
}

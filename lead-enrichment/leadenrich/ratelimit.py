"""Per-provider rate limiting.

This is the single most important difference between a demo that works on eight
rows and a run that survives two thousand. Every provider here publishes a
limit; exceed it and you get 429s, which cost latency, burn retry budget, and on
some providers still consume a credit. The waterfall makes it worse, because a
row that misses at three providers fires three times as fast as one that hits
immediately.

A token bucket handles both shapes of limit a provider might publish -- Hunter
documents 15 requests/second *and* 500/minute, and both must hold -- by running
one bucket per window and waiting for whichever is tighter.

Buckets are shared across worker threads, so the limit is global to the run
rather than per thread.
"""
from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Callable


#: Refilling a bucket by exactly the amount owed can land at 0.9999999999
#: instead of 1.0, and a strict `>= 1.0` then loops forever in tiny sleeps.
#: One nanotoken of slack costs nothing and makes the arithmetic terminate.
EPSILON = 1e-9


@dataclass
class Bucket:
    """A single token bucket: ``capacity`` tokens, refilled over ``per`` seconds.

    The clock is injected rather than read from ``time`` directly. That is not
    only for tests: a bucket seeded from a different clock than the one it is
    later measured against computes a negative elapsed time and silently never
    refills, which looks exactly like a provider that has stopped responding.
    """

    capacity: float
    per: float
    clock: Callable[[], float] = time.monotonic
    tokens: float = field(init=False)
    updated: float = field(init=False)

    def __post_init__(self) -> None:
        self.tokens = float(self.capacity)
        self.updated = self.clock()

    def _refill(self, now: float) -> None:
        elapsed = now - self.updated
        if elapsed <= 0:
            return
        self.tokens = min(self.capacity,
                          self.tokens + elapsed * (self.capacity / self.per))
        self.updated = now

    def wait_time(self, now: float) -> float:
        """Seconds until a token is available. 0 when one is free now."""
        self._refill(now)
        if self.tokens >= 1.0 - EPSILON:
            return 0.0
        deficit = 1.0 - self.tokens
        return deficit * (self.per / self.capacity)

    def consume(self) -> None:
        self.tokens = max(0.0, self.tokens - 1.0)


class RateLimiter:
    """Enforces a provider's published limits before each call.

    ``acquire`` blocks until the call is allowed. It is deliberately blocking
    rather than raising: a rate limit is not an error, it is the pace the
    provider has asked for, and waiting is the correct response.
    """

    def __init__(self, name: str, *, per_second: float | None = None,
                 per_minute: float | None = None,
                 sleep=time.sleep, clock=time.monotonic):
        self.name = name
        self._sleep = sleep
        self._clock = clock
        self._buckets: list[Bucket] = []
        if per_second:
            self._buckets.append(Bucket(capacity=per_second, per=1.0, clock=clock))
        if per_minute:
            self._buckets.append(Bucket(capacity=per_minute, per=60.0, clock=clock))
        self._lock = threading.Lock()
        self._sleep = sleep
        self._clock = clock
        self.waited_seconds = 0.0
        self.waits = 0

    @property
    def unlimited(self) -> bool:
        return not self._buckets

    def acquire(self, timeout: float = 120.0) -> float:
        """Block until a call may proceed. Returns how long it waited."""
        if self.unlimited:
            return 0.0
        total = 0.0
        while True:
            with self._lock:
                now = self._clock()
                wait = max((b.wait_time(now) for b in self._buckets), default=0.0)
                if wait <= 0.0:
                    for b in self._buckets:
                        b.consume()
                    if total:
                        self.waited_seconds += total
                        self.waits += 1
                    return total
            # A pathological wait means the configured limit cannot be met;
            # surface it rather than hanging the run forever.
            if total + wait > timeout:
                raise TimeoutError(
                    f"{self.name}: rate limit wait exceeded {timeout}s")
            # Never sleep zero: a rounding artefact must not become a spin loop.
            self._sleep(max(wait, 0.001))
            total += max(wait, 0.001)

    def stats(self) -> dict:
        return {"waits": self.waits, "waited_seconds": round(self.waited_seconds, 2)}


class LimiterRegistry:
    """One limiter per provider, built from config."""

    def __init__(self, sleep=time.sleep, clock=time.monotonic):
        self._limiters: dict[str, RateLimiter] = {}
        self._sleep, self._clock = sleep, clock
        self._lock = threading.Lock()

    def for_provider(self, name: str, options: dict) -> RateLimiter:
        with self._lock:
            if name not in self._limiters:
                self._limiters[name] = RateLimiter(
                    name,
                    per_second=options.get("rate_per_second"),
                    per_minute=options.get("rate_per_minute"),
                    sleep=self._sleep, clock=self._clock)
            return self._limiters[name]

    def summary(self) -> dict:
        return {n: l.stats() for n, l in self._limiters.items()
                if l.waits}

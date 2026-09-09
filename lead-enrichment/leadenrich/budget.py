"""Spend controls.

A cap that trips must *skip* the provider, never fail the row -- the waterfall
should still be free to try the next, cheaper source.
"""
from __future__ import annotations

import threading
from dataclasses import dataclass, field


class BudgetExceeded(Exception):
    """Raised only by :meth:`Budget.charge` when a hard cap is hit."""


@dataclass
class Budget:
    max_total_requests: int | None = None
    max_estimated_credits: float | None = None
    per_provider: dict[str, int] = field(default_factory=dict)

    total_requests: int = 0
    total_credits: float = 0.0
    provider_requests: dict[str, int] = field(default_factory=dict)
    provider_credits: dict[str, float] = field(default_factory=dict)
    skips: dict[str, int] = field(default_factory=dict)
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def allows(self, provider: str) -> bool:
        """Check without consuming. Cheap enough to call before every call."""
        with self._lock:
            if (self.max_total_requests is not None
                    and self.total_requests >= self.max_total_requests):
                return False
            if (self.max_estimated_credits is not None
                    and self.total_credits >= self.max_estimated_credits):
                return False
            cap = self.per_provider.get(provider)
            if cap is not None and self.provider_requests.get(provider, 0) >= cap:
                return False
            return True

    def charge(self, provider: str, credits: float = 1.0) -> None:
        """Record one request. Raises :class:`BudgetExceeded` if it would breach."""
        with self._lock:
            if (self.max_total_requests is not None
                    and self.total_requests + 1 > self.max_total_requests):
                raise BudgetExceeded(
                    f"total request cap {self.max_total_requests} reached")
            if (self.max_estimated_credits is not None
                    and self.total_credits + credits > self.max_estimated_credits):
                raise BudgetExceeded(
                    f"estimated credit cap {self.max_estimated_credits} reached")
            cap = self.per_provider.get(provider)
            if cap is not None and self.provider_requests.get(provider, 0) + 1 > cap:
                raise BudgetExceeded(f"{provider} request cap {cap} reached")

            self.total_requests += 1
            self.total_credits += credits
            self.provider_requests[provider] = self.provider_requests.get(provider, 0) + 1
            self.provider_credits[provider] = (
                self.provider_credits.get(provider, 0.0) + credits)

    def note_skip(self, provider: str) -> None:
        with self._lock:
            self.skips[provider] = self.skips.get(provider, 0) + 1

    def summary(self) -> dict[str, object]:
        return {
            "total_requests": self.total_requests,
            "total_estimated_credits": round(self.total_credits, 3),
            "per_provider_requests": dict(self.provider_requests),
            "per_provider_credits": {k: round(v, 3)
                                     for k, v in self.provider_credits.items()},
            "budget_skips": dict(self.skips),
        }

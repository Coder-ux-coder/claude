"""HTTP transport with the one distinction that decides whether a waterfall works:

*transient failure* (retry, then move on) versus *clean no-match* (do not retry,
advance immediately). Conflating them either burns paid credits re-asking a
provider that has already said "I don't know", or gives up on a provider that
was merely rate-limited.
"""
from __future__ import annotations

import json
import random
import time
from dataclasses import dataclass
from typing import Any, Callable

import requests

#: Status codes worth trying again. 408 request-timeout and 425 too-early are
#: included because providers under load return them interchangeably with 429.
TRANSIENT_STATUS = frozenset({408, 425, 429, 500, 502, 503, 504, 522, 524})


class TransientError(Exception):
    """Retryable. The provider may still have the answer."""

    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


class PermanentError(Exception):
    """Not retryable: bad key, bad request, forbidden. Advance the waterfall."""

    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


@dataclass
class HttpResponse:
    status: int
    json_body: Any
    text: str
    headers: dict[str, str]

    def get(self, *path: str, default: Any = None) -> Any:
        """Safe nested lookup: ``resp.get('data', 'email')``."""
        cur: Any = self.json_body
        for key in path:
            if isinstance(cur, dict) and key in cur:
                cur = cur[key]
            else:
                return default
        return cur if cur is not None else default


class HttpClient:
    """Thin requests wrapper: retry/backoff, jitter, and Retry-After respect."""

    def __init__(
        self,
        *,
        max_attempts: int = 4,
        base_delay: float = 1.0,
        max_delay: float = 30.0,
        jitter: float = 0.25,
        timeout: float = 30.0,
        session: Any = None,
        sleep: Callable[[float], None] = time.sleep,
    ):
        self.max_attempts = max_attempts
        self.base_delay = base_delay
        self.max_delay = max_delay
        self.jitter = jitter
        self.timeout = timeout
        self.session = session or requests.Session()
        self._sleep = sleep
        self.attempt_log: list[dict[str, Any]] = []

    # ------------------------------------------------------------------
    def _backoff(self, attempt: int, retry_after: float | None = None) -> float:
        if retry_after is not None:
            return min(retry_after, self.max_delay)
        delay = min(self.base_delay * (2 ** (attempt - 1)), self.max_delay)
        return delay * (1.0 + random.uniform(-self.jitter, self.jitter))

    @staticmethod
    def _retry_after(headers: dict[str, str]) -> float | None:
        raw = headers.get("Retry-After") or headers.get("retry-after")
        if not raw:
            return None
        try:
            return float(raw)
        except ValueError:
            return None

    def request(
        self,
        method: str,
        url: str,
        *,
        headers: dict[str, str] | None = None,
        params: dict[str, Any] | None = None,
        json_body: Any = None,
        data: Any = None,
        timeout: float | None = None,
        ok_statuses: frozenset[int] | set[int] = frozenset({200, 201, 202}),
    ) -> HttpResponse:
        """Perform a request, retrying only genuinely transient failures.

        Raises :class:`TransientError` when retries are exhausted and
        :class:`PermanentError` for 4xx that retrying cannot fix. A ``404`` is
        *not* an error here -- many finders use it for "no match" -- so it is
        returned to the adapter to interpret.
        """
        last_exc: Exception | None = None
        for attempt in range(1, self.max_attempts + 1):
            started = time.time()
            try:
                resp = self.session.request(
                    method.upper(), url,
                    headers=headers, params=params, json=json_body, data=data,
                    timeout=timeout or self.timeout,
                )
            except Exception as exc:  # connection reset, DNS, read timeout
                last_exc = TransientError(f"transport failure: {exc}")
                self.attempt_log.append(
                    {"url": url, "attempt": attempt, "error": str(exc)})
                if attempt < self.max_attempts:
                    self._sleep(self._backoff(attempt))
                    continue
                raise last_exc

            status = getattr(resp, "status_code", 0)
            hdrs = dict(getattr(resp, "headers", {}) or {})
            self.attempt_log.append({
                "url": url, "attempt": attempt, "status": status,
                "ms": int((time.time() - started) * 1000),
            })

            if status in TRANSIENT_STATUS:
                last_exc = TransientError(f"HTTP {status} from {url}", status)
                if attempt < self.max_attempts:
                    self._sleep(self._backoff(attempt, self._retry_after(hdrs)))
                    continue
                raise last_exc

            body_text = getattr(resp, "text", "") or ""
            parsed: Any = None
            try:
                parsed = resp.json()
            except Exception:
                try:
                    parsed = json.loads(body_text) if body_text else None
                except Exception:
                    parsed = None

            if status in ok_statuses or status == 404:
                return HttpResponse(status, parsed, body_text, hdrs)

            # Everything else (401/403/400/422...) is the caller's problem to fix.
            raise PermanentError(
                f"HTTP {status} from {url}: {body_text[:300]}", status)

        raise last_exc or TransientError("request failed")

    def get(self, url: str, **kw: Any) -> HttpResponse:
        return self.request("GET", url, **kw)

    def post(self, url: str, **kw: Any) -> HttpResponse:
        return self.request("POST", url, **kw)

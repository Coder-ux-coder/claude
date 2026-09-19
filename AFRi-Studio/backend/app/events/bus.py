"""In-process pub/sub fanned out to SSE clients.

Every event published here corresponds to something that actually happened: a
pipeline stage transition, a log line, or a sample count parsed out of Cycles'
own output. Nothing is emitted on a timer.
"""
from __future__ import annotations

import json
import queue
import threading
import time
from typing import Iterator

_MAX_QUEUE = 2000


class EventBus:
    def __init__(self):
        self._subs: list[queue.Queue] = []
        self._lock = threading.Lock()
        self._seq = 0
        self._history: list[dict] = []

    def publish(self, type_: str, payload: dict, job_id: str | None = None):
        with self._lock:
            self._seq += 1
            event = {
                "seq": self._seq,
                "ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) +
                      f".{int(time.time() * 1000) % 1000:03d}Z",
                "type": type_,
                "job_id": job_id,
                "payload": payload,
            }
            self._history.append(event)
            if len(self._history) > 400:
                self._history.pop(0)
            dead = []
            for q in self._subs:
                try:
                    q.put_nowait(event)
                except queue.Full:
                    dead.append(q)
            for q in dead:
                self._subs.remove(q)
        return event

    def subscribe(self) -> queue.Queue:
        q: queue.Queue = queue.Queue(maxsize=_MAX_QUEUE)
        with self._lock:
            self._subs.append(q)
        return q

    def unsubscribe(self, q: queue.Queue):
        with self._lock:
            if q in self._subs:
                self._subs.remove(q)

    def history(self, limit: int = 100) -> list[dict]:
        with self._lock:
            return self._history[-limit:]

    def stream(self) -> Iterator[str]:
        q = self.subscribe()
        try:
            yield "retry: 2000\n\n"
            for ev in self.history(40):
                yield f"data: {json.dumps(ev)}\n\n"
            while True:
                try:
                    ev = q.get(timeout=15)
                    yield f"data: {json.dumps(ev)}\n\n"
                except queue.Empty:
                    yield ": keepalive\n\n"
        finally:
            self.unsubscribe(q)


bus = EventBus()

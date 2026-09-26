"""A tiny publish/subscribe hub for Server-Sent Events (live updates to the app)."""

from __future__ import annotations

import json
import queue
import threading


class Hub:
    def __init__(self):
        self._subs: dict[str, list[queue.Queue]] = {}
        self._lock = threading.Lock()

    def subscribe(self, topic: str) -> queue.Queue:
        q: queue.Queue = queue.Queue(maxsize=200)
        with self._lock:
            self._subs.setdefault(topic, []).append(q)
        return q

    def unsubscribe(self, topic: str, q: queue.Queue) -> None:
        with self._lock:
            subs = self._subs.get(topic, [])
            if q in subs:
                subs.remove(q)

    def count(self, topic: str) -> int:
        with self._lock:
            return len(self._subs.get(topic, []))

    def publish(self, topic: str, event: str, data) -> None:
        payload = f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"
        with self._lock:
            subs = list(self._subs.get(topic, []))
        for q in subs:
            try:
                q.put_nowait(payload)
            except queue.Full:  # a slow viewer drops frames rather than stalling everyone
                try:
                    q.get_nowait()
                    q.put_nowait(payload)
                except (queue.Empty, queue.Full):
                    pass


hub = Hub()

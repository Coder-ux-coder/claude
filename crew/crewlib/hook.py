"""Claude Code hook: push urgent team messages into a working agent's context.

Registered for PostToolUse. After each tool call it checks the team store for
unread messages that are urgent (a decision, a blocker, the human) or that
mention this seat, and hands them to the model as additionalContext. Cheap
(one SQLite query) and silent when there is nothing to say.
"""

from __future__ import annotations

import json
import os
import sys


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except ValueError:
        payload = {}
    db, seat = os.environ.get("CREW_DB"), os.environ.get("CREW_SEAT")
    if not db or not seat:
        return
    from .store import Store
    from .tools import _fmt_msg, _mentions

    store = Store(db)
    try:
        seen = int(store.get(f"hook_seen:{seat}", 0) or 0)
        cursor = int((store.seat(seat) or {}).get("chat_cursor") or 0)
        fresh = [m for m in store.messages_after(max(seen, cursor), 200)
                 if m["sender"] != seat and (m["urgent"] or _mentions(m["text"], seat))]
        if not fresh:
            return
        store.set(f"hook_seen:{seat}", fresh[-1]["id"])
        lines = "\n".join(_fmt_msg(m, 600) for m in fresh[-5:])
        context = ("Urgent team chat messages arrived while you were working (read them now; decisions are binding):\n"
                   + lines)
        event = payload.get("hook_event_name") or "PostToolUse"
        print(json.dumps({"hookSpecificOutput": {"hookEventName": event, "additionalContext": context}}))
    finally:
        store.close()


if __name__ == "__main__":
    main()

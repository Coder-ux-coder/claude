"""AI provider adapters.

Three implementations, tried in order. Every one is optional: the design engine
has no dependency on any of them, and every operation the assistant can perform
is also reachable directly from the UI. The application is fully functional with
no AI at all.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
from dataclasses import dataclass, field


@dataclass
class ProviderStatus:
    name: str
    available: bool
    detail: str
    kind: str
    supports_vision: bool = False
    extra: dict = field(default_factory=dict)


class ProviderError(RuntimeError):
    pass


# ---------------------------------------------------------------------------
class ClaudeCodeCLIProvider:
    """Uses the locally installed Claude Code CLI in non-interactive mode.

    This is the CLI's officially supported headless entry point
    (``claude -p --output-format json``). It consumes the user's existing
    Claude Code access -- the application never asks for an API key and never
    provisions a paid service of its own.
    """
    name = "claude_code_cli"
    kind = "cli"

    def __init__(self, timeout: int = 180):
        self.timeout = timeout
        self._exe = os.environ.get("AFRI_CLAUDE_BIN") or shutil.which("claude")
        self._probe: ProviderStatus | None = None

    def available(self, recheck: bool = False) -> ProviderStatus:
        if self._probe is not None and not recheck:
            return self._probe
        if not self._exe:
            self._probe = ProviderStatus(
                self.name, False,
                "The 'claude' CLI is not on PATH. Install Claude Code, or set "
                "AFRI_CLAUDE_BIN to its location.", self.kind)
            return self._probe
        try:
            out = subprocess.run([self._exe, "--version"], capture_output=True,
                                 text=True, timeout=30)
            if out.returncode != 0:
                raise ProviderError(out.stderr.strip()[:200])
            self._probe = ProviderStatus(
                self.name, True, f"Claude Code CLI {out.stdout.strip()}",
                self.kind, supports_vision=False,
                extra={"path": self._exe})
        except Exception as exc:
            self._probe = ProviderStatus(self.name, False,
                                         f"probe failed: {exc!r}", self.kind)
        return self._probe

    def complete(self, system: str, user: str) -> str:
        st = self.available()
        if not st.available:
            raise ProviderError(st.detail)
        cmd = [self._exe, "-p", user, "--output-format", "json",
               "--append-system-prompt", system]
        try:
            out = subprocess.run(cmd, capture_output=True, text=True,
                                 timeout=self.timeout, cwd="/tmp")
        except subprocess.TimeoutExpired:
            raise ProviderError(f"Claude Code CLI timed out after {self.timeout}s")
        if out.returncode != 0:
            raise ProviderError(
                f"Claude Code CLI exited {out.returncode}: "
                f"{(out.stderr or out.stdout)[-400:]}")
        try:
            payload = json.loads(out.stdout)
        except json.JSONDecodeError:
            raise ProviderError("Claude Code CLI returned unparseable output")
        if payload.get("is_error"):
            raise ProviderError(f"Claude Code CLI reported an error: "
                                f"{payload.get('result', '')[:300]}")
        return payload.get("result", "")


# ---------------------------------------------------------------------------
class LocalOpenAICompatProvider:
    """Any OpenAI-compatible local server (Ollama, llama.cpp, LM Studio).

    Off unless AFRI_LOCAL_AI_URL is set. The application never downloads model
    weights on its own -- a multi-gigabyte download is the user's decision, and
    on a machine with no GPU it is usually the wrong one.
    """
    name = "local_openai_compatible"
    kind = "local"

    def __init__(self):
        self.base = os.environ.get("AFRI_LOCAL_AI_URL", "").rstrip("/")
        self.model = os.environ.get("AFRI_LOCAL_AI_MODEL", "llama3.1")

    def available(self, recheck: bool = False) -> ProviderStatus:
        if not self.base:
            return ProviderStatus(
                self.name, False,
                "Not configured. Set AFRI_LOCAL_AI_URL to a local "
                "OpenAI-compatible endpoint (for example http://localhost:11434/v1).",
                self.kind)
        try:
            import httpx
            r = httpx.get(f"{self.base}/models", timeout=5)
            ok = r.status_code < 400
            return ProviderStatus(self.name, ok,
                                  f"{self.base} responded {r.status_code}", self.kind,
                                  extra={"model": self.model})
        except Exception as exc:
            return ProviderStatus(self.name, False, f"unreachable: {exc!r}", self.kind)

    def complete(self, system: str, user: str) -> str:
        import httpx
        r = httpx.post(f"{self.base}/chat/completions", timeout=180, json={
            "model": self.model, "temperature": 0.2,
            "messages": [{"role": "system", "content": system},
                         {"role": "user", "content": user}]})
        r.raise_for_status()
        return r.json()["choices"][0]["message"]["content"]


# ---------------------------------------------------------------------------
class ManualHandoffProvider:
    """Always available. Never fails. Never pretends.

    Rather than silently doing nothing when no AI is reachable, this renders the
    exact prompt for the user to paste into any assistant they already have, and
    accepts the JSON command plan back through the UI. The command still goes
    through the same schema validation and the same pipeline.
    """
    name = "manual_handoff"
    kind = "manual"

    def available(self, recheck: bool = False) -> ProviderStatus:
        return ProviderStatus(
            self.name, True,
            "Manual handoff: AFRi Studio shows you the prompt, you paste the "
            "reply back. Always works, no AI service required.", self.kind)

    def complete(self, system: str, user: str) -> str:
        raise ProviderError(
            "manual handoff cannot complete automatically; use the prompt shown "
            "in the assistant panel")


# ---------------------------------------------------------------------------
_PROVIDERS = None


def get_providers():
    global _PROVIDERS
    if _PROVIDERS is None:
        _PROVIDERS = [ClaudeCodeCLIProvider(), LocalOpenAICompatProvider(),
                      ManualHandoffProvider()]
    return _PROVIDERS


def active_provider():
    """First provider that reports itself genuinely available."""
    for p in get_providers():
        if p.available().available:
            return p
    return get_providers()[-1]


def provider_report() -> list[dict]:
    out = []
    for p in get_providers():
        st = p.available()
        out.append({"name": st.name, "kind": st.kind, "available": st.available,
                    "detail": st.detail, "supports_vision": st.supports_vision,
                    "extra": st.extra})
    return out

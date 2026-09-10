"""Configuration loading.

Secrets never live in the config file. The file names an *environment variable*
per provider; the value is read from the process environment (or a ``.env`` file
loaded at startup). Nothing here ever prompts for a key.
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

DEFAULT_CONFIG_PATH = Path(__file__).resolve().parent.parent / "config" / "pipeline.yml"


def _parse_env_value(raw: str) -> str:
    """Read one .env value, honouring quotes and trailing comments.

    ``KEY=   # what this is for`` must yield an empty value, not the comment.
    Without this a blank template file makes every provider look configured,
    the readiness display says so, and each one then dies on a 401 mid-run --
    which is a far more expensive way to learn that no key was ever set.

    A ``#`` is only a comment when whitespace precedes it: keys and passwords
    contain hashes, and stripping those would silently corrupt a working
    credential, which is worse than the bug being fixed.
    """
    raw = raw.strip()
    if raw.startswith("#"):
        return ""
    if raw[:1] in ('"', "'"):
        quote = raw[0]
        end = raw.find(quote, 1)
        return raw[1:end] if end != -1 else raw[1:]
    cut = re.search(r"\s#", raw)
    if cut:
        raw = raw[:cut.start()]
    return raw.strip()


def load_dotenv(path: str | Path = ".env") -> int:
    """Minimal .env loader. Existing environment variables always win."""
    p = Path(path)
    if not p.exists():
        return 0
    loaded = 0
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        key, val = key.strip(), _parse_env_value(val)
        if key.startswith("export "):
            key = key[len("export "):].strip()
        if key and key not in os.environ:
            os.environ[key] = val
            loaded += 1
    return loaded


@dataclass
class ProviderConfig:
    name: str
    enabled: bool = True
    api_key_env: str = ""
    extra_env: dict[str, str] = field(default_factory=dict)
    max_requests: int | None = None
    credits_per_call: float = 1.0
    timeout: float = 30.0
    options: dict[str, Any] = field(default_factory=dict)

    def api_key(self) -> str | None:
        if not self.api_key_env:
            return None
        return os.environ.get(self.api_key_env) or None

    def env(self, logical_name: str) -> str | None:
        var = self.extra_env.get(logical_name)
        return os.environ.get(var) if var else None

    def has_credentials(self) -> bool:
        """True when every environment variable this provider needs is present."""
        if self.api_key_env and not self.api_key():
            return False
        return all(os.environ.get(v) for v in self.extra_env.values())


@dataclass
class PhonePolicy:
    require_public_evidence: bool = True
    allow_provider_personal_mobile: bool = False
    default_region: str = "IN"
    accept_landline: bool = True
    export_contact_type_label: bool = True


@dataclass
class EmailPolicy:
    require_validation: bool = True
    accept_deliverability: list[str] = field(
        default_factory=lambda: ["deliverable"])
    accept_ownership: list[str] = field(
        default_factory=lambda: ["provider_asserted", "published_on_company_site"])
    export_risky: bool = False
    reject_role_accounts: bool = True
    reject_free_webmail: bool = False
    min_finder_score: int = 0


@dataclass
class RetryPolicy:
    max_attempts: int = 4
    base_delay: float = 1.0
    max_delay: float = 30.0
    jitter: float = 0.25


@dataclass
class BudgetConfig:
    max_total_requests: int | None = None
    max_estimated_credits: float | None = None
    per_provider: dict[str, int] = field(default_factory=dict)


@dataclass
class Config:
    providers: dict[str, ProviderConfig] = field(default_factory=dict)
    waterfalls: dict[str, list[str]] = field(default_factory=dict)
    phone_policy: PhonePolicy = field(default_factory=PhonePolicy)
    email_policy: EmailPolicy = field(default_factory=EmailPolicy)
    retry: RetryPolicy = field(default_factory=RetryPolicy)
    budget: BudgetConfig = field(default_factory=BudgetConfig)
    concurrency: int = 4
    #: Consecutive permanent failures before a provider is dropped from the run.
    breaker_threshold: int = 5
    #: When true, every identity provider is called even after one answers
    #: fully, so their answers can be cross-checked. Doubles identity cost;
    #: worth it on a pilot or a sample audit, rarely on a full run.
    identity_corroboration: bool = False
    demo_mode: bool = False
    output_dir: str = "out"
    raw: dict[str, Any] = field(default_factory=dict)

    def waterfall(self, stage: str) -> list[str]:
        return list(self.waterfalls.get(stage, []))

    def provider(self, name: str) -> ProviderConfig | None:
        return self.providers.get(name)

    def enabled_in(self, stage: str) -> list[str]:
        """Waterfall for a stage, filtered to providers marked enabled."""
        out = []
        for n in self.waterfall(stage):
            pc = self.providers.get(n)
            if pc and pc.enabled:
                out.append(n)
        return out


def load_config(path: str | Path | None = None, *, demo: bool = False) -> Config:
    p = Path(path) if path else DEFAULT_CONFIG_PATH
    data: dict[str, Any] = yaml.safe_load(p.read_text(encoding="utf-8")) or {}

    providers: dict[str, ProviderConfig] = {}
    for name, pd in (data.get("providers") or {}).items():
        pd = pd or {}
        providers[name] = ProviderConfig(
            name=name,
            enabled=bool(pd.get("enabled", True)),
            api_key_env=pd.get("api_key_env", "") or "",
            extra_env=dict(pd.get("extra_env") or {}),
            max_requests=pd.get("max_requests"),
            credits_per_call=float(pd.get("credits_per_call", 1.0)),
            timeout=float(pd.get("timeout", 30.0)),
            options=dict(pd.get("options") or {}),
        )

    cfg = Config(
        providers=providers,
        waterfalls={k: list(v or []) for k, v in (data.get("waterfalls") or {}).items()},
        phone_policy=PhonePolicy(**(data.get("phone_policy") or {})),
        email_policy=EmailPolicy(**(data.get("email_policy") or {})),
        retry=RetryPolicy(**(data.get("retry") or {})),
        budget=BudgetConfig(**(data.get("budget") or {})),
        concurrency=int(data.get("concurrency", 4)),
        breaker_threshold=int(data.get("breaker_threshold", 5)),
        identity_corroboration=bool(data.get("identity_corroboration", False)),
        demo_mode=bool(data.get("demo_mode", False)) or demo,
        output_dir=data.get("output_dir", "out"),
        raw=data,
    )

    if cfg.demo_mode:
        # Demo runs use fixture adapters only -- no network, no credentials, and
        # visibly fictional data. Every stage is rewritten to its demo provider.
        # The demo mirrors the shipped waterfall position for position, so a
        # demo trace reads exactly like a live one -- same provider names in the
        # same order -- with fixtures behind them instead of paid APIs.
        cfg.waterfalls = {
            "identity": ["demo:apollo", "linkedin_slug"],
            "email": ["demo:prospeo", "demo:findymail", "demo:hunter"],
            "validation": ["demo:zerobounce"],
            "phone": ["demo:google_places", "demo:website"],
        }
        for n in ("demo:apollo", "demo:prospeo", "demo:findymail", "demo:hunter",
                  "demo:zerobounce", "demo:google_places", "demo:website",
                  "linkedin_slug"):
            cfg.providers.setdefault(n, ProviderConfig(name=n, credits_per_call=0.0))
            cfg.providers[n].enabled = True
    return cfg

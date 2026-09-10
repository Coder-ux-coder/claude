"""Reading a .env file.

The bug these exist for: `.env.example` carried its documentation on the same
line as each assignment, so a freshly-copied template set every key to the text
of its own comment. Every paid provider then reported itself configured, the
readiness banner agreed, and each one died on a 401 partway through a real run
-- an expensive way to discover no key was ever entered.
"""
from __future__ import annotations

import os
from pathlib import Path

import pytest

from leadenrich.config import ProviderConfig, _parse_env_value, load_config, load_dotenv

REPO = Path(__file__).resolve().parents[1]


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    for var in list(os.environ):
        if var.endswith(("_API_KEY", "_CLIENT_ID", "_CLIENT_SECRET")):
            monkeypatch.delenv(var, raising=False)


# ------------------------------------------------------------- the parser ---

@pytest.mark.parametrize("raw,expected", [
    ("", ""),
    ("   ", ""),
    ("   # https://hunter.io/api-documentation/v2 -- also the verifier", ""),
    ("#nospace-before-hash-is-still-a-comment-at-the-start", ""),
    ("abc123", "abc123"),
    ("abc123   # my key", "abc123"),
    ("abc123\t# my key", "abc123"),
    ('"abc123"', "abc123"),
    ("'abc123'", "abc123"),
    ('"abc 123"  # quoted, spaces kept', "abc 123"),
])
def test_values_are_read_the_way_every_other_env_reader_reads_them(raw, expected):
    assert _parse_env_value(raw) == expected


def test_a_hash_inside_a_key_is_not_treated_as_a_comment():
    """Worse than the bug being fixed: silently truncating a working credential."""
    assert _parse_env_value("sk-live#not-a-comment") == "sk-live#not-a-comment"
    assert _parse_env_value("p@ssw#rd") == "p@ssw#rd"


# ---------------------------------------------------------------- loading ---

def test_documented_but_empty_keys_stay_empty(tmp_path, monkeypatch):
    env = tmp_path / ".env"
    env.write_text(
        "HUNTER_API_KEY=           # https://hunter.io -- also the verifier\n"
        "PROSPEO_API_KEY=\n"
        "ZEROBOUNCE_API_KEY=real-key-here   # paid\n",
        encoding="utf-8")
    load_dotenv(env)

    assert os.environ["HUNTER_API_KEY"] == ""
    assert os.environ["PROSPEO_API_KEY"] == ""
    assert os.environ["ZEROBOUNCE_API_KEY"] == "real-key-here"


def test_an_empty_value_never_makes_a_provider_look_configured(tmp_path):
    env = tmp_path / ".env"
    env.write_text("HUNTER_API_KEY=   # paste yours here\n", encoding="utf-8")
    load_dotenv(env)

    pc = ProviderConfig(name="hunter", api_key_env="HUNTER_API_KEY")
    assert not pc.has_credentials()
    assert pc.api_key() is None


def test_the_real_environment_still_wins_over_the_file(tmp_path, monkeypatch):
    monkeypatch.setenv("HUNTER_API_KEY", "from-the-shell")
    (tmp_path / ".env").write_text("HUNTER_API_KEY=from-the-file\n", encoding="utf-8")
    load_dotenv(tmp_path / ".env")
    assert os.environ["HUNTER_API_KEY"] == "from-the-shell"


def test_export_prefixed_lines_are_understood(tmp_path):
    """People paste these straight out of a shell profile."""
    (tmp_path / ".env").write_text("export HUNTER_API_KEY=abc123\n", encoding="utf-8")
    load_dotenv(tmp_path / ".env")
    assert os.environ["HUNTER_API_KEY"] == "abc123"


# ----------------------------------------------- the shipped template file ---

def test_the_shipped_template_produces_a_completely_unconfigured_app(tmp_path):
    """A copied .env.example must leave every paid provider switched off.

    This is the assertion that would have caught it: not that the file looks
    tidy, but that copying it produces the state the operator expects.
    """
    env = tmp_path / ".env"
    env.write_text((REPO / ".env.example").read_text(encoding="utf-8"),
                   encoding="utf-8")
    load_dotenv(env)

    cfg = load_config(str(REPO / "config" / "pipeline.yml"))
    configured = [name for name, pc in cfg.providers.items()
                  if (pc.api_key_env or pc.extra_env) and pc.has_credentials()]
    assert configured == [], f"these look configured with an empty template: {configured}"


def test_the_keyless_providers_are_still_available(tmp_path):
    """The other half: with no keys at all, the free path must remain usable."""
    env = tmp_path / ".env"
    env.write_text((REPO / ".env.example").read_text(encoding="utf-8"),
                   encoding="utf-8")
    load_dotenv(env)

    cfg = load_config(str(REPO / "config" / "pipeline.yml"))
    for name in ("linkedin_slug", "website"):
        pc = cfg.provider(name)
        assert pc is not None and pc.has_credentials(), \
            f"{name} needs no key and must work out of the box"

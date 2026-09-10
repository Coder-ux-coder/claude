"""Provider adapter package.

Importing this module registers every adapter. ``registry`` is the single lookup
used by the pipeline, so adding a provider means adding one file and one
``@registry.register`` decorator -- nothing else changes.
"""
from .base import (IdentityResult, Provider, ProviderResult, ProviderRegistry,
                   ValidationResult, registry)
from . import identity, email, validators, phone_sources, demo  # noqa: F401

__all__ = ["registry", "Provider", "ProviderResult", "IdentityResult",
           "ValidationResult", "ProviderRegistry"]

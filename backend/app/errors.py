"""Backend-specific exceptions and safe error helpers."""

from __future__ import annotations


class StartupValidationError(RuntimeError):
    """Raised when a data package is unsafe or incompatible with this runtime."""


class QueryContractError(ValueError):
    """Raised when a request violates the explicit API coordinate contract."""


"""FastAPI runtime for the Local Transcript Browser."""

from typing import Any


def create_app(*args: Any, **kwargs: Any) -> Any:
    """Import FastAPI lazily so builder-side validation stays dependency-light."""

    from .main import create_app as factory

    return factory(*args, **kwargs)


__all__ = ["create_app"]

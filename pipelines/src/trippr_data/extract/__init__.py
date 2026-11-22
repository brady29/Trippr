"""One extract module per source."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from . import foursquare, overture

EXTRACTORS: dict[str, Callable[..., dict[str, Any]]] = {
    overture.SOURCE: overture.extract,
    foursquare.SOURCE: foursquare.extract,
}

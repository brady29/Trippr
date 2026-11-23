"""One extract module per source, in the order they run (Wikidata last: it also fetches the QIDs that
OpenStreetMap and Wikivoyage name, so their raw files must exist first)."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from . import foursquare, osm, overture, wikidata, wikivoyage

EXTRACTORS: dict[str, Callable[..., dict[str, Any]]] = {
    overture.SOURCE: overture.extract,
    foursquare.SOURCE: foursquare.extract,
    osm.SOURCE: osm.extract,
    wikivoyage.SOURCE: wikivoyage.extract,
    wikidata.SOURCE: wikidata.extract,
}

"""Bank of Canada exchange rates (Valet API): daily average CAD per unit of each currency.

Docs checked 2026-11-23: https://www.bankofcanada.ca/valet/docs and https://www.bankofcanada.ca/terms/.
One request covers every currency and date a run needs; the response is stored as received.
"""

from __future__ import annotations

import json
import logging
from datetime import date as date_cls
from datetime import timedelta
from pathlib import Path
from typing import Any

from ..layout import raw_dir, write_json
from ..registry import Registry
from ..settings import utc_now
from .common import sha256_file
from .polite_http import PoliteClient

log = logging.getLogger(__name__)

SOURCE = "boc_fx"
VALET = "https://www.bankofcanada.ca/valet/observations"
LOOKBACK_DAYS = 10  # a snapshot on a weekend or holiday uses the last business day before it


def series_id(currency: str) -> str:
    return f"FX{currency.upper()}CAD"


def extract(
    currencies: list[str],
    first: str,
    last: str,
    *,
    out: Path,
    date: str,
    registry: Registry,
    client: PoliteClient | None = None,
) -> dict[str, Any]:
    """Fetch the daily rates of `currencies` from LOOKBACK_DAYS before `first` through `last`."""
    entry = registry.require(SOURCE)
    client = client or PoliteClient()
    start = (date_cls.fromisoformat(first) - timedelta(days=LOOKBACK_DAYS)).isoformat()
    series = ",".join(series_id(c) for c in sorted(set(currencies)))
    url = f"{VALET}/{series}/json?start_date={start}&end_date={last}"
    log.info("bank of canada rates %s..%s for %s", start, last, series)
    body = client.get_bytes(url, accept="application/json")
    directory = raw_dir(out, SOURCE, date)
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / "rates.json"
    target.write_bytes(body)
    observations = json.loads(body).get("observations", [])
    fetched = utc_now().isoformat()
    meta = {
        "source": SOURCE,
        "source_name": entry.name,
        "licence": entry.licence,
        "attribution": entry.attribution.strip(),
        "terms_checked_on": entry.terms_checked_on.isoformat(),
        "version": last,
        "dataset_path": VALET,
        "query_template": url,
        "run_date": date,
        "fetched_at": fetched,
        "row_count": len(observations),
        "currencies": sorted(set(currencies)),
        "files": {
            "rates.json": {
                "city": None,
                "rows": len(observations),
                "bytes": target.stat().st_size,
                "sha256": sha256_file(target),
                "fetched_at": fetched,
            }
        },
    }
    write_json(directory / "_meta.json", meta)
    return meta


def load_rates(path: Path) -> dict[str, dict[str, float]]:
    """{currency: {YYYY-MM-DD: CAD per unit}} from a stored Valet response."""
    out: dict[str, dict[str, float]] = {}
    for obs in json.loads(path.read_text(encoding="utf-8")).get("observations", []):
        for key, cell in obs.items():
            if key.startswith("FX") and key.endswith("CAD") and isinstance(cell, dict) and "v" in cell:
                out.setdefault(key[2:-3], {})[obs["d"]] = float(cell["v"])
    return out


def rate_on(rates: dict[str, dict[str, float]], currency: str, day: str) -> tuple[float, str] | None:
    """(CAD per unit, the date the rate is from): the rate on `day`, else the latest before it (within
    LOOKBACK_DAYS). None when the currency or a recent enough rate is missing."""
    if currency == "CAD":
        return 1.0, day
    by_day = rates.get(currency)
    if not by_day:
        return None
    limit = (date_cls.fromisoformat(day) - timedelta(days=LOOKBACK_DAYS)).isoformat()
    candidates = [d for d in by_day if limit <= d <= day]
    if not candidates:
        return None
    best = max(candidates)
    return by_day[best], best

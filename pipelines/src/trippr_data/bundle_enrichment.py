"""The enrichment part of a bundle (docs/data-platform-spec.md, Feature 3).

When the enrich stage has written `enriched/<date>/enrichment.parquet`, the bundle carries it next to the
places, keyed by the same id:

    enrichment.jsonl.gz   one enriched place per line (BundleEnrichment), in the order of places.jsonl.gz
    enrichment.parquet    the same rows for DuckDB and BigQuery

The places file itself is unchanged (so the embeddings, the golden places and the loader's place contract are
not touched); the load job joins the two files by id. A bundle without enrichment is still valid. The manifest
gets an `enrichment` section (counts, model, date) and `evals.enrich` (the model's eval scores, when
`eval-enrich` has been run for it). Mirrored by zod schemas in packages/contracts/src/catalogue.ts.
"""

from __future__ import annotations

import gzip
from collections import Counter
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from .checks import CheckResult
from .duck import connect, rows, run, sql_str
from .enrich.settings import enriched_file, eval_root
from .layout import dated_dirs, read_json

ENRICHMENT_FILE = "enrichment.jsonl.gz"
ENRICHMENT_PARQUET_FILE = "enrichment.parquet"

# The numbers from an eval report that the Data page shows (the rest stay in the report).
EVAL_METRICS = (
    "n",
    "valid_rate",
    "tag_f1",
    "duration_within_tolerance",
    "best_time_accuracy",
    "indoor_accuracy",
    "summary_rule_unsupported_rate",
    "summary_judge_unsupported_rate",
    "display_name_match",
)


class BundleEnrichmentProvenance(BaseModel):
    """Where the AI-written fields came from. `summary_ai` is what the app's label hangs on."""

    model_config = ConfigDict(extra="forbid")

    summary_ai: bool
    model: str
    prompt_version: str
    enriched_at: str
    batch_id: str | None
    input_sources: list[str]


class BundleEnrichment(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    tags: list[str]
    summary: str
    duration_min: int | None = Field(ge=5, le=1440)
    best_time: Literal["morning", "afternoon", "evening", "night", "any"] | None
    indoor: bool | None
    price_level: Literal["free", "$", "$$", "$$$"] | None
    good_for: list[Literal["rain", "families", "nightlife", "views"]]
    # Suggestions: the app shows display_name as a subtitle only, and only when is_generic_name is set.
    display_name: str | None
    is_generic_name: bool
    ai: bool
    ai_label: str | None
    provenance: BundleEnrichmentProvenance


class BundleEnrichmentSummary(BaseModel):
    """The manifest's `enrichment` section."""

    model_config = ConfigDict(extra="forbid")

    places: int
    with_summary: int
    models: list[str]
    prompt_versions: list[str]
    # The newest enriched_at among the places, and the enriched/<date> folder the rows came from.
    enriched_at: str | None
    source_date: str


@dataclass
class EnrichmentData:
    rows: list[BundleEnrichment]
    source_date: str
    source: Path
    dropped: int  # enriched places that are not in the bundle (curation moved on)


def _utc(value: datetime | str | None) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        value = datetime.fromisoformat(value)
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def find_enrichment(out: Path, date: str) -> tuple[Path, str] | None:
    """The enrichment for the bundle's date, else the newest one before it (enrichment is cached across
    runs, so a bundle built a day later still uses the last enriched answers)."""
    for d in [date, *reversed([d for d in dated_dirs(out / "enriched") if d < date])]:
        path = enriched_file(out, d)
        if path.is_file():
            return path, d
    return None


def load_enrichment(out: Path, date: str, place_ids: Iterable[str]) -> EnrichmentData | None:
    """The enrichment rows for the bundle's places, in the order of `place_ids`; None when there is none."""
    found = find_enrichment(out, date)
    if found is None:
        return None
    path, source_date = found
    con = connect()
    by_id: dict[str, BundleEnrichment] = {}
    for r in rows(con, f"SELECT * FROM read_parquet({sql_str(path.as_posix())}) ORDER BY place_id"):
        p = r["provenance"]
        by_id[r["place_id"]] = BundleEnrichment(
            id=r["place_id"],
            tags=list(r["tags"] or []),
            summary=r["summary"] or "",
            duration_min=r["duration_min"],
            best_time=r["best_time"],
            indoor=r["indoor"],
            price_level=r["price_level"],
            good_for=list(r["good_for"] or []),
            display_name=r["display_name"],
            is_generic_name=bool(r["is_generic_name"]),
            ai=bool(r["ai"]),
            ai_label=r["ai_label"],
            provenance=BundleEnrichmentProvenance(
                summary_ai=bool(p["summary_ai"]),
                model=p["model"],
                prompt_version=p["prompt_version"],
                enriched_at=_utc(p["enriched_at"]) or "",
                batch_id=p["batch_id"],
                input_sources=list(p["input_sources"] or []),
            ),
        )
    con.close()
    ordered = [e for pid in place_ids if (e := by_id.get(pid)) is not None]
    return EnrichmentData(ordered, source_date, path, dropped=len(by_id) - len(ordered))


def write_enrichment_jsonl(path: Path, items: Iterable[BundleEnrichment]) -> int:
    """Gzipped JSON Lines; mtime 0 so the same rows always give the same bytes."""
    n = 0
    with open(path, "wb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", mtime=0, filename="") as gz:
        for item in items:
            gz.write((item.model_dump_json() + "\n").encode("utf-8"))
            n += 1
    return n


def read_enrichment(path: Path) -> list[BundleEnrichment]:
    with gzip.open(path, "rt", encoding="utf-8") as fh:
        return [BundleEnrichment.model_validate_json(line) for line in fh if line.strip()]


def write_enrichment_parquet(target: Path, data: EnrichmentData) -> None:
    """The enrich stage's Parquet, narrowed to the bundle's places."""
    con = connect()
    ids = ", ".join(sql_str(e.id) for e in data.rows) or "NULL"
    run(
        con,
        f"COPY (SELECT * FROM read_parquet({sql_str(data.source.as_posix())}) WHERE place_id IN ({ids}) "
        f"ORDER BY place_id) TO {sql_str(target.as_posix())} (FORMAT parquet, COMPRESSION zstd)",
    )
    con.close()


def summarise(data: EnrichmentData) -> BundleEnrichmentSummary:
    stamps = [e.provenance.enriched_at for e in data.rows if e.provenance.enriched_at]
    return BundleEnrichmentSummary(
        places=len(data.rows),
        with_summary=sum(1 for e in data.rows if e.summary),
        models=sorted({e.provenance.model for e in data.rows}),
        prompt_versions=sorted({e.provenance.prompt_version for e in data.rows}),
        enriched_at=max(stamps) if stamps else None,
        source_date=data.source_date,
    )


def eval_scores(out: Path, models: list[str]) -> dict[str, Any] | None:
    """The newest-model eval report (out/enrich-eval/<model>/report.json) for the model that enriched the
    most places; None when `eval-enrich` has not been run for it."""
    for model in models:
        report = eval_root(out, model) / "report.json"
        if not report.is_file():
            continue
        data = read_json(report)
        metrics = data.get("metrics", {})
        return {
            "model": data.get("model", model),
            "judge_model": data.get("judge_model"),
            "metrics": {k: metrics[k] for k in EVAL_METRICS if k in metrics},
            "targets": data.get("targets", {}),
        }
    return None


def models_by_use(data: EnrichmentData) -> list[str]:
    return [m for m, _ in Counter(e.provenance.model for e in data.rows).most_common()]


def check_enrichment(items: list[BundleEnrichment], n_places: int, dropped: int = 0) -> list[CheckResult]:
    """Every AI-written summary says so: the app's "Summary written by AI" label needs the provenance."""
    unlabelled = sorted(
        e.id
        for e in items
        if e.summary
        and not (
            e.ai
            and e.ai_label
            and e.provenance.summary_ai
            and e.provenance.model
            and e.provenance.prompt_version
            and e.provenance.enriched_at
        )
    )
    claimed = sorted(e.id for e in items if not e.summary and e.provenance.summary_ai)
    results = [
        CheckResult(
            "enrichment.summary_provenance",
            "fail",
            f"{len(unlabelled)} places have a summary without summary_ai provenance, an AI label, a model "
            f"or a date; {len(claimed)} claim an AI summary they do not have",
            {"examples": (unlabelled + claimed)[:5]},
        )
        if unlabelled or claimed
        else CheckResult(
            "enrichment.summary_provenance",
            "pass",
            f"all {sum(1 for e in items if e.summary):,} summaries carry summary_ai provenance and an AI label",
        )
    ]
    note = f"{len(items):,} of {n_places:,} places enriched"
    if dropped:
        note += f"; {dropped:,} enriched places are no longer in the bundle"
    results.append(CheckResult("enrichment.coverage", "info", note))
    return results

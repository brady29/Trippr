"""Trippr's place taxonomy and each source's category mapping (checked-in CSVs)."""

from __future__ import annotations

import csv
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from .settings import CONFIG_DIR

TAGS = ("sport", "tech", "nature", "culture", "food", "other")
EXCLUDE = "exclude"

Status = Literal["mapped", "excluded", "unmapped", "uncategorised"]


@dataclass(frozen=True)
class Category:
    category: str
    tag: str
    label: str


def _read_csv(path: Path) -> list[dict[str, str]]:
    with open(path, encoding="utf-8", newline="") as fh:
        return list(csv.DictReader(line for line in fh if line.strip() and not line.startswith("#")))


def load_taxonomy(config_dir: Path = CONFIG_DIR) -> dict[str, Category]:
    out: dict[str, Category] = {}
    for row in _read_csv(config_dir / "taxonomy.csv"):
        cat = Category(row["category"].strip(), row["tag"].strip(), row["label"].strip())
        if cat.tag not in TAGS:
            raise ValueError(f"taxonomy.csv: {cat.category} has unknown tag {cat.tag!r}")
        if cat.category in out or cat.category == EXCLUDE:
            raise ValueError(f"taxonomy.csv: duplicate or reserved category {cat.category!r}")
        out[cat.category] = cat
    return out


@dataclass(frozen=True)
class CategoryMap:
    """Maps a source's categories onto Trippr categories.

    style="label": Overture. Rules are keyed by single taxonomy labels; a place takes the rule for
    its primary label, else the nearest ancestor in its hierarchy.
    style="path": Foursquare. Rules are keyed by label paths ("A > B > C"); a place takes the rule
    for the longest matching prefix of its label.
    style="tags": OpenStreetMap. A rule is one tag ("tourism=museum") or several joined with "+" that
    must all be present; a place takes the FIRST rule, in file order, its tags satisfy. The place's
    category key is its relevant tags joined with "|" (see tag_key).
    style="exact": Wikidata classes and Wikivoyage listing types, one key each.
    """

    source: str
    style: Literal["label", "path", "tags", "exact"]
    rules: dict[str, str]

    def _resolve_tags(self, tag_key: str | None) -> tuple[str | None, Status]:
        tags = {t for t in (tag_key or "").split("|") if t}
        if not tags:
            return None, "uncategorised"
        for rule, target in self.rules.items():
            if all(cond in tags for cond in rule.split("+")):
                return (None, "excluded") if target == EXCLUDE else (target, "mapped")
        return None, "unmapped"

    def candidates(self, primary: str | None, hierarchy: Sequence[str] | None) -> list[str]:
        if self.style == "label":
            keys = [primary] if primary else []
            keys += list(reversed(hierarchy or []))
            return [k for k in keys if k]
        if not primary:
            return []
        parts = [p.strip() for p in primary.split(">")]
        return [" > ".join(parts[:i]) for i in range(len(parts), 0, -1)]

    def resolve(
        self, primary: str | None, hierarchy: Sequence[str] | None = None
    ) -> tuple[str | None, Status]:
        """A place the source gave no category at all is "uncategorised": dropped, and reported apart
        from "unmapped" (a category with no rule yet), so the unmapped share points at missing rules."""
        if self.style in ("tags", "exact"):
            return self._resolve_tags(primary)
        keys = self.candidates(primary, hierarchy)
        if not keys:
            return None, "uncategorised"
        for key in keys:
            target = self.rules.get(key)
            if target == EXCLUDE:
                return None, "excluded"
            if target:
                return target, "mapped"
        return None, "unmapped"


MAP_STYLES: dict[str, Literal["label", "path", "tags", "exact"]] = {
    "overture": "label",
    "foursquare": "path",
    "osm": "tags",
    "wikidata": "exact",
    "wikivoyage": "exact",
}


def osm_fetch_tags(rules: dict[str, str]) -> dict[str, list[str]]:
    """key -> values to fetch from OSM: the first tag of every rule that is not "exclude"."""
    wanted: dict[str, list[str]] = {}
    for rule, target in rules.items():
        if target == EXCLUDE:
            continue
        key, _, value = rule.split("+")[0].partition("=")
        values = wanted.setdefault(key, [])
        if value not in values:
            values.append(value)
    return wanted


def osm_relevant_tags(rules: dict[str, str]) -> list[str]:
    """Every "key=value" that appears in any rule condition (what the category key is built from)."""
    seen: dict[str, None] = {}
    for rule in rules:
        for cond in rule.split("+"):
            seen[cond] = None
    return list(seen)


def load_category_map(
    source: str, taxonomy: dict[str, Category], config_dir: Path = CONFIG_DIR
) -> CategoryMap:
    path = config_dir / f"category_map_{source}.csv"
    rules: dict[str, str] = {}
    for row in _read_csv(path):
        key, target = row["source_category"].strip(), row["category"].strip()
        if key in rules:
            raise ValueError(f"{path.name}: duplicate rule for {key!r}")
        if target != EXCLUDE and target not in taxonomy:
            raise ValueError(f"{path.name}: {key!r} maps to unknown category {target!r}")
        rules[key] = target
    return CategoryMap(source=source, style=MAP_STYLES[source], rules=rules)

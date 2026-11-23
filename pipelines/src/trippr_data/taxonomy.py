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
    """

    source: str
    style: Literal["label", "path"]
    rules: dict[str, str]

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


MAP_STYLES: dict[str, Literal["label", "path"]] = {"overture": "label", "foursquare": "path"}


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

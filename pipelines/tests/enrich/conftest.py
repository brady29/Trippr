from __future__ import annotations

import shutil
from pathlib import Path

import pytest

from trippr_data.curation import curate
from trippr_data.enrich.inputs import EnrichInput
from trippr_data.match import match

from ..conftest import FIXTURE_DATE

CURATED_DATE = FIXTURE_DATE


@pytest.fixture(scope="session")
def curated_out(tmp_path_factory: pytest.TempPathFactory, staged_out: Path, registry) -> Path:
    """The two-city fixtures taken through match and curate, as a real run would leave them."""
    out = tmp_path_factory.mktemp("curated_out")
    shutil.copytree(staged_out, out, dirs_exist_ok=True)
    match(out, FIXTURE_DATE, registry=registry)
    curate(out, FIXTURE_DATE)
    return out


@pytest.fixture(autouse=True)
def _never_spend(monkeypatch: pytest.MonkeyPatch) -> None:
    """No key, no budget override, and constructing a real Anthropic client fails the test."""
    for name in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ENRICH_BUDGET_USD", "ENRICH_MODEL"):
        monkeypatch.delenv(name, raising=False)
    import anthropic

    def refuse(*args, **kwargs):
        raise AssertionError("a test tried to construct the real Anthropic client")

    monkeypatch.setattr(anthropic, "Anthropic", refuse)


def make_place(
    place_id: str, name: str, category: str = "temple_shrine", city: str = "TYO", **kw
) -> EnrichInput:
    return EnrichInput(place_id=place_id, name=name, category=category, city_code=city, **kw)


@pytest.fixture
def places() -> list[EnrichInput]:
    return [
        make_place(
            "p1",
            "浅草寺",
            name_en="Senso-ji",
            name_local="浅草寺",
            description="Buddhist temple in Asakusa.",
            sources=["osm", "wikivoyage"],
        ),
        make_place("p2", "วัดโพธิ์", "temple_shrine", "BKK", name_en="Wat Pho"),
        make_place("p3", "Shibuya Sky", "viewpoint", "TYO", sources=["overture"]),
        make_place("p4", "경복궁", "castle_palace", "SEL", name_en="Gyeongbokgung"),
        make_place("p5", "Hồ Hoàn Kiếm", "nature_spot", "HAN"),
    ]

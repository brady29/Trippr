from __future__ import annotations

import pytest

from trippr_data.enrich.inputs import EnrichInput


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
            descriptions=[{"source": "wikivoyage", "text": "Buddhist temple in Asakusa."}],
            sources=["osm", "wikivoyage"],
        ),
        make_place("p2", "วัดโพธิ์", "temple_shrine", "BKK", name_en="Wat Pho"),
        make_place("p3", "Shibuya Sky", "viewpoint", "TYO", sources=["overture"]),
        make_place("p4", "경복궁", "castle_palace", "SEL", name_en="Gyeongbokgung"),
        make_place("p5", "Hồ Hoàn Kiếm", "nature_spot", "HAN"),
    ]

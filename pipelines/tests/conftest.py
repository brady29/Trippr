from __future__ import annotations

import shutil
from pathlib import Path

import pytest

from trippr_data.registry import Registry, load_registry
from trippr_data.stage import StageContext, stage

FIXTURES = Path(__file__).parent / "fixtures"
FIXTURE_DATA = FIXTURES / "data"
FIXTURE_DATE = "2026-11-18"


@pytest.fixture(autouse=True)
def _isolated_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Tests never touch a bucket or the CI step summary."""
    for name in ("DATA_BUCKET", "GITHUB_STEP_SUMMARY", "CITY_RADIUS_DEFAULT_KM", "TRIPPR_DATA_OUT"):
        monkeypatch.delenv(name, raising=False)


@pytest.fixture(scope="session")
def registry() -> Registry:
    """The real registry, with Foursquare switched on so its fixture can be staged."""
    real = load_registry()
    sources = dict(real.sources)
    sources["foursquare"] = sources["foursquare"].model_copy(update={"enabled": True})
    return Registry(sources=sources)


@pytest.fixture(scope="session")
def ctx() -> StageContext:
    return StageContext.load()


@pytest.fixture(scope="session")
def staged_out(tmp_path_factory: pytest.TempPathFactory, registry: Registry, ctx: StageContext) -> Path:
    """A copy of the fixture raw data, staged once for the whole session."""
    out = tmp_path_factory.mktemp("out")
    shutil.copytree(FIXTURE_DATA, out, dirs_exist_ok=True)
    stage(out, FIXTURE_DATE, registry=registry, ctx=ctx)
    return out


STAY_FIXTURES = FIXTURES / "stay"


@pytest.fixture(scope="session")
def stay_out(tmp_path_factory: pytest.TempPathFactory, registry: Registry) -> Path:
    """The stay fixtures (hotels, Inside Airbnb for Tokyo and Singapore, FX) staged and analysed once."""
    from trippr_data.stay.airbnb import stage_airbnb
    from trippr_data.stay.analytics import analyse
    from trippr_data.stay.hotels import stage_hotels

    out = tmp_path_factory.mktemp("stay_out")
    shutil.copytree(STAY_FIXTURES / "raw", out / "raw")
    stage_hotels(out, FIXTURE_DATE, registry=registry)
    stage_airbnb(out, FIXTURE_DATE, registry=registry)
    analyse(out, FIXTURE_DATE, places=STAY_FIXTURES / "places")
    return out

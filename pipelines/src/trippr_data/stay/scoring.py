"""The stay score formulas. Pure functions, no I/O: every number the app shows can be recomputed from the
facts in stay_unit.parquet with these, and tests/test_stay_scoring.py pins them.

A unit is a Trippr Area (a circle around its centre), an Inside Airbnb neighbourhood or an H3 cell. Each
part is 0..100, higher is better for a traveller:

value        how cheap the unit is for what you get. The share of the city's bookable listings whose price
             per person-night is higher than the unit's median (ties count half): 70 means "cheaper than
             70% of the city's listings".
reviews      the unit's median review rating, shrunk toward the city's median by `prior_weight` extra rated
             listings (so 3 listings with a 5.0 do not beat 200 with a 4.8), then mapped linearly from
             [floor, ceiling] (4.0..5.0) to 0..100.
centrality   how central the unit is: 100 at the city centre falling linearly to 0 at `centre_far_km` (15 km),
             and the same for the distance to the nearest hub station (0 at `station_far_km`, 10 km), blended
             `centre_share` (60%) to the centre and the rest to the station (all centre when the city has no
             station). Without it the cheap, quiet edge of a big city outranks its middle.
walkability  a proxy: how many staged places (restaurants, sights, cafés, ...) lie within `radius_km`
             (600 m) of the centre, on a log scale that reaches 100 at `saturation_places`.
quiet        a proxy: 100 minus the same log scale for bars and nightlife venues within `radius_km` (300 m).

stay score   the weighted mean of the parts a unit has data for, with the weights rescaled to those parts. It is
             only given when the parts present carry at least `min_weight_coverage` of the total weight, and
             always travels with its parts and a sentence that explains them.
"""

from __future__ import annotations

import math
from bisect import bisect_left, bisect_right
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from .config import CentralityRules, QuietRules, ReviewRules, StayConfig, WalkRules, Weights

PART_NAMES = ("value", "reviews", "centrality", "walkability", "quiet")


def clamp(x: float, low: float = 0.0, high: float = 100.0) -> float:
    return max(low, min(high, x))


def saturate(count: float | None, saturation: float) -> float:
    """0 at no places, 1 at `saturation` places or more, log-shaped in between."""
    if not count or count <= 0:
        return 0.0
    return min(1.0, math.log1p(count) / math.log1p(saturation))


def cheaper_than_share(price: float | None, city_prices_sorted: Sequence[float]) -> float | None:
    """Share of the city's prices that are higher than `price` (ties count half). None without data."""
    if price is None or not city_prices_sorted:
        return None
    n = len(city_prices_sorted)
    higher = n - bisect_right(city_prices_sorted, price)
    equal = bisect_right(city_prices_sorted, price) - bisect_left(city_prices_sorted, price)
    return (higher + 0.5 * equal) / n


def value_score(price: float | None, city_prices_sorted: Sequence[float]) -> float | None:
    share = cheaper_than_share(price, city_prices_sorted)
    return None if share is None else 100.0 * share


def shrunk_rating(
    rating: float | None, n_rated: int, city_rating: float | None, prior_weight: float
) -> float | None:
    if rating is None or n_rated <= 0:
        return None
    if city_rating is None or prior_weight <= 0:
        return rating
    return (n_rated * rating + prior_weight * city_rating) / (n_rated + prior_weight)


def reviews_score(
    rating: float | None, n_rated: int, city_rating: float | None, rules: ReviewRules
) -> float | None:
    adjusted = shrunk_rating(rating, n_rated, city_rating, rules.prior_weight)
    if adjusted is None:
        return None
    return clamp(100.0 * (adjusted - rules.floor) / (rules.ceiling - rules.floor))


def proximity(distance_km: float | None, far_km: float) -> float | None:
    """100 at distance 0, falling linearly to 0 at `far_km` and beyond. None without a distance."""
    if distance_km is None:
        return None
    return clamp(100.0 * (1.0 - max(0.0, distance_km) / far_km))


def centrality_score(
    centre_km: float | None, station_km: float | None, rules: CentralityRules
) -> float | None:
    """How central a unit is, from its distance to the city centre and to the nearest hub station."""
    centre = proximity(centre_km, rules.centre_far_km)
    station = proximity(station_km, rules.station_far_km)
    if centre is None:
        return None
    if station is None:
        return centre
    return rules.centre_share * centre + (1.0 - rules.centre_share) * station


def walkability_score(n_places: float | None, rules: WalkRules) -> float | None:
    if n_places is None:
        return None
    return 100.0 * saturate(n_places, rules.saturation_places)


def quiet_score(n_nightlife: float | None, rules: QuietRules) -> float | None:
    if n_nightlife is None:
        return None
    return 100.0 * (1.0 - saturate(n_nightlife, rules.saturation_nightlife))


@dataclass(frozen=True)
class Blend:
    score: float | None
    used: tuple[str, ...]
    weight_coverage: float


def blend(parts: Mapping[str, float | None], weights: Weights, min_weight_coverage: float) -> Blend:
    """Weighted mean over the parts that are present; None below the coverage floor."""
    w = weights.model_dump()
    present = {name: value for name, value in parts.items() if value is not None and w.get(name, 0) > 0}
    coverage = sum(w[name] for name in present)
    if not present or coverage + 1e-12 < min_weight_coverage:
        return Blend(None, tuple(sorted(present)), round(coverage, 4))
    score = sum(w[name] * value for name, value in present.items()) / coverage  # type: ignore[operator]
    used = tuple(name for name in PART_NAMES if name in present)
    return Blend(round(clamp(score), 1), used, round(coverage, 4))


@dataclass(frozen=True)
class UnitFacts:
    city_name: str
    cheaper_share: float | None = None
    median_price_cad: float | None = None
    median_price_pp_cad: float | None = None
    median_rating: float | None = None
    n_rated: int = 0
    n_priced: int = 0
    centre_km: float | None = None
    station_km: float | None = None
    n_places: int | None = None
    n_nightlife: int | None = None
    walk_m: int = 600
    quiet_m: int = 300


def explain(f: UnitFacts) -> str:
    """One sentence per part, for the Area card: facts first, never just the score."""
    bits: list[str] = []
    if f.cheaper_share is not None and f.median_price_cad is not None:
        pp = f" ({_cad(f.median_price_pp_cad)} a person)" if f.median_price_pp_cad is not None else ""
        bits.append(
            f"Cheaper than {round(100 * f.cheaper_share)}% of {f.city_name} listings: "
            f"median {_cad(f.median_price_cad)} a night{pp}, from {f.n_priced} listings"
        )
    if f.median_rating is not None:
        bits.append(f"reviews {f.median_rating:.2f} median across {f.n_rated} rated listings")
    if f.centre_km is not None:
        where = f"{f.centre_km:.1f} km from the city centre"
        if f.station_km is not None:
            where += f", {f.station_km:.1f} km to the nearest hub station"
        bits.append(where)
    if f.n_places is not None:
        bits.append(f"{f.n_places} places within {f.walk_m} m")
    if f.n_nightlife is not None:
        noun = "bar or nightlife venue" if f.n_nightlife == 1 else "bars and nightlife venues"
        bits.append(f"{f.n_nightlife} {noun} within {f.quiet_m} m")
    return "; ".join(bits) + "." if bits else "Not enough data for this unit."


def _cad(x: float | None) -> str:
    return "n/a" if x is None else f"CAD {x:,.0f}"


def parts_for(
    *,
    price_pp: float | None,
    city_prices_sorted: Sequence[float],
    n_priced: int,
    rating: float | None,
    n_rated: int,
    city_rating: float | None,
    n_places: float | None,
    n_nightlife: float | None,
    cfg: StayConfig,
    centre_km: float | None = None,
    station_km: float | None = None,
) -> dict[str, float | None]:
    """All five parts for one unit. Value and reviews need `min_priced_listings` priced / rated listings."""
    enough_price = n_priced >= cfg.min_priced_listings
    enough_rated = n_rated >= cfg.min_priced_listings
    return {
        "value": value_score(price_pp, city_prices_sorted) if enough_price else None,
        "reviews": reviews_score(rating, n_rated, city_rating, cfg.reviews) if enough_rated else None,
        "centrality": centrality_score(centre_km, station_km, cfg.centrality),
        "walkability": walkability_score(n_places, cfg.walkability),
        "quiet": quiet_score(n_nightlife, cfg.quiet),
    }

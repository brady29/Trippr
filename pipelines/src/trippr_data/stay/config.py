"""Stay analytics settings (config/stay_score.yaml) and the paths the stay stages use."""

from __future__ import annotations

from pathlib import Path

import yaml
from pydantic import BaseModel, ConfigDict, Field, model_validator

from ..settings import CONFIG_DIR


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Weights(_Strict):
    value: float = Field(ge=0)
    centrality: float = Field(ge=0)
    walkability: float = Field(ge=0)
    quiet: float = Field(ge=0)
    reviews: float = Field(ge=0)

    @model_validator(mode="after")
    def _sums_to_one(self) -> Weights:
        total = self.value + self.centrality + self.walkability + self.quiet + self.reviews
        if abs(total - 1.0) > 1e-9:
            raise ValueError(f"stay_score.yaml: weights sum to {total}, not 1")
        return self


class PriceRules(_Strict):
    floor_cad: float = Field(gt=0)
    outlier_percentile: float = Field(gt=0, lt=1)
    max_min_nights: int = Field(ge=1)


class ReviewRules(_Strict):
    floor: float
    ceiling: float
    prior_weight: float = Field(ge=0)

    @model_validator(mode="after")
    def _ordered(self) -> ReviewRules:
        if not self.floor < self.ceiling:
            raise ValueError("stay_score.yaml: reviews.floor must be below reviews.ceiling")
        return self


class CentralityRules(_Strict):
    centre_far_km: float = Field(gt=0)
    station_far_km: float = Field(gt=0)
    centre_share: float = Field(ge=0, le=1)


class WalkRules(_Strict):
    radius_km: float = Field(gt=0)
    saturation_places: float = Field(gt=0)


class QuietRules(_Strict):
    radius_km: float = Field(gt=0)
    saturation_nightlife: float = Field(gt=0)
    nightlife_categories: list[str] = Field(min_length=1)


class HostRules(_Strict):
    multi_listing_min: int = Field(ge=2)
    top_hosts: int = Field(ge=1)


class AreaRules(_Strict):
    default_radius_km: float = Field(gt=0)


class PrivacyRules(_Strict):
    min_listings: int = Field(ge=1)


class MergeRules(_Strict):
    cross_source_km: float
    cross_source_name_similarity: float
    same_source_km: float
    same_source_name_similarity: float
    max_cluster_km: float


class HotelRules(_Strict):
    merge: MergeRules
    source_precedence: list[str] = Field(min_length=1)
    bundle_per_area: int = Field(ge=1)


class StayConfig(_Strict):
    version: int
    weights: Weights
    min_weight_coverage: float = Field(gt=0, le=1)
    price: PriceRules
    min_priced_listings: int = Field(ge=1)
    reviews: ReviewRules
    centrality: CentralityRules
    walkability: WalkRules
    quiet: QuietRules
    hosts: HostRules
    areas: AreaRules
    privacy: PrivacyRules
    h3_resolution: int = Field(ge=0, le=15)
    hotels: HotelRules


def load_stay_config(config_dir: Path = CONFIG_DIR) -> StayConfig:
    with open(config_dir / "stay_score.yaml", encoding="utf-8") as fh:
        return StayConfig.model_validate(yaml.safe_load(fh))

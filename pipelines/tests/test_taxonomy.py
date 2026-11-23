from pathlib import Path

import pytest

from trippr_data.settings import CONFIG_DIR
from trippr_data.taxonomy import TAGS, CategoryMap, load_category_map, load_taxonomy


@pytest.fixture(scope="module")
def taxonomy():
    return load_taxonomy()


def test_taxonomy_is_about_thirty_categories_on_known_tags(taxonomy):
    assert 25 <= len(taxonomy) <= 40
    assert {c.tag for c in taxonomy.values()} <= set(TAGS)
    # every colour tag the app uses has at least one category
    assert {"sport", "tech", "nature", "culture", "food", "other"} <= {c.tag for c in taxonomy.values()}


@pytest.mark.parametrize("source", ["overture", "foursquare"])
def test_mapping_csvs_load_and_only_target_taxonomy(source, taxonomy):
    cmap = load_category_map(source, taxonomy)
    assert cmap.rules
    assert {t for t in cmap.rules.values() if t != "exclude"} <= set(taxonomy)


@pytest.mark.parametrize(
    ("primary", "hierarchy", "expected"),
    [
        (
            "japanese_restaurant",
            [
                "food_and_drink",
                "restaurant",
                "asian_restaurant",
                "east_asian_restaurant",
                "japanese_restaurant",
            ],
            ("restaurant", "mapped"),
        ),
        # the deepest rule wins: garden beats built_feature (exclude)
        (
            "botanical_garden",
            ["geographic_entities", "built_feature", "garden", "botanical_garden"],
            ("park_garden", "mapped"),
        ),
        ("shrine", ["cultural_and_historic", "religious_landmark", "shrine"], ("temple_shrine", "mapped")),
        (
            "science_museum",
            ["arts_and_entertainment", "museum", "science_museum"],
            ("science_tech", "mapped"),
        ),
        (
            "onsen",
            ["lifestyle_services", "wellness_service", "public_bath_house", "onsen"],
            ("onsen_spa", "mapped"),
        ),
        ("ski_resort", ["lodging", "resort", "ski_resort"], ("sport_activity", "mapped")),
        ("atm", ["services_and_business", "financial_service", "atm"], (None, "excluded")),
        ("hotel", ["lodging", "hotel"], (None, "excluded")),
        ("shopping", ["shopping"], (None, "excluded")),  # top level only: dropped on purpose
        ("rodeo", ["arts_and_entertainment", "rodeo"], (None, "excluded")),  # falls back to its top level
        (None, None, (None, "uncategorised")),
    ],
)
def test_overture_mapping(primary, hierarchy, expected, taxonomy):
    assert load_category_map("overture", taxonomy).resolve(primary, hierarchy) == expected


@pytest.mark.parametrize(
    ("label", "expected"),
    [
        (
            "Dining and Drinking > Restaurant > Asian Restaurant > Japanese Restaurant",
            ("restaurant", "mapped"),
        ),
        ("Dining and Drinking > Cafe, Coffee, and Tea House > Coffee Shop", ("cafe", "mapped")),
        ("Dining and Drinking > Bar > Karaoke Bar", ("nightlife", "mapped")),  # longer prefix beats "Bar"
        ("Community and Government > Spiritual Center > Buddhist Temple", ("temple_shrine", "mapped")),
        ("Community and Government > Spiritual Center > Church", ("place_of_worship", "mapped")),
        ("Community and Government > Post Office", (None, "excluded")),
        ("Landmarks and Outdoors > Scenic Lookout", ("viewpoint", "mapped")),
        ("Landmarks and Outdoors > Structure", (None, "excluded")),
        ("Dining and Drinking > Snack Place", ("street_food", "mapped")),
        ("Landmarks and Outdoors > Other Great Outdoors", ("park_garden", "mapped")),
        ("Arts and Entertainment > Internet Cafe", ("arcade_gaming", "mapped")),
        ("Arts and Entertainment > Museum", ("museum", "mapped")),  # a rule beats its excluded parent
        ("Unknown Category > Thing", (None, "unmapped")),
        (None, (None, "uncategorised")),
    ],
)
def test_foursquare_mapping(label, expected, taxonomy):
    assert load_category_map("foursquare", taxonomy).resolve(label) == expected


def test_mapping_rejects_unknown_targets(tmp_path: Path, taxonomy):
    (tmp_path / "taxonomy.csv").write_text(
        (CONFIG_DIR / "taxonomy.csv").read_text(encoding="utf-8"), encoding="utf-8"
    )
    (tmp_path / "category_map_overture.csv").write_text(
        "source_category,category\n# comment\nmuseum,museums\n", encoding="utf-8"
    )
    with pytest.raises(ValueError, match="unknown category 'museums'"):
        load_category_map("overture", taxonomy, tmp_path)


def test_mapping_rejects_duplicate_rules(tmp_path: Path, taxonomy):
    (tmp_path / "category_map_overture.csv").write_text(
        "source_category,category\nmuseum,museum\nmuseum,gallery\n", encoding="utf-8"
    )
    with pytest.raises(ValueError, match="duplicate rule"):
        load_category_map("overture", taxonomy, tmp_path)


def test_path_candidates_run_longest_first():
    cmap = CategoryMap("foursquare", "path", {})
    assert cmap.candidates("A > B > C", None) == ["A > B > C", "A > B", "A"]

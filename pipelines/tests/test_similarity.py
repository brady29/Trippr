import pytest

from trippr_data.similarity import (
    address_key,
    key_similarity,
    name_key,
    name_similarity,
    name_tokens,
    phone_key,
    website_key,
)


def test_keys_ignore_case_accents_and_punctuation_in_latin_names():
    assert name_key("Hà Nội  Café!") == "ha noi cafe"
    assert name_key("SHIBUYA SKY") == name_key("Shibuya  Sky")
    assert name_key("Sensō-ji") == "senso ji"
    assert name_key("Đà Lạt") == "da lat"
    assert name_key("  ") is None and name_key(None) is None


def test_keys_keep_marks_that_change_cjk_and_thai_words():
    assert name_key("ガイド") != name_key("カイト")  # voicing marks are not accents
    assert name_key("が") != name_key("か")
    assert name_key("วัดพระแก้ว") == "วัดพระแก้ว"  # Thai vowel signs stay
    assert name_key("ＡＢＣ　ＤＥＦ") == "abc def"  # full-width Latin, ideographic space


def test_cjk_names_are_bigrams_and_latin_names_are_words():
    assert name_tokens(name_key("浅草寺本堂")) == ["浅草", "草寺", "寺本", "本堂"]
    assert name_tokens(name_key("The Tokyo Tower")) == ["tokyo", "tower"]  # the article is dropped
    assert name_tokens(name_key("東京 Tower")) == ["東京", "tower"]
    assert name_tokens(name_key("寺")) == ["寺"]
    assert name_tokens(None) == []


@pytest.mark.parametrize(
    ("a", "b", "minimum"),
    [
        ("Shibuya Sky", "SHIBUYA SKY", 1.0),
        ("Sensoji", "Sensoji Temple", 0.65),
        ("渋谷スカイ", "渋谷スカイ展望台", 0.7),
        ("景福宮", "景福宮", 1.0),
        ("Wat Phra Kaew", "Wat Phra Kaeo", 0.85),
        ("Bún Đậu Cường Tun", "Bun Dau Cuong Tun", 1.0),
    ],
)
def test_same_place_names_score_high(a, b, minimum):
    assert name_similarity(a, b) >= minimum


@pytest.mark.parametrize(
    ("a", "b", "maximum"),
    [
        ("浅草寺", "東京タワー", 0.1),
        ("Hải sản Mắt Biển", "Quán Sam Biển", 0.7),
        ("稲荷神社", "八幡神社", 0.5),
        ("Shibuya Sky", "渋谷スカイ", 0.1),  # different scripts are compared through the other variants
    ],
)
def test_different_names_score_low(a, b, maximum):
    assert name_similarity(a, b) <= maximum


def test_two_character_names_only_match_exactly_or_as_a_prefix():
    assert key_similarity("天坛", "天坛") == 1.0
    assert key_similarity("天坛", "天坛公园") == 0.8
    assert key_similarity("天坛", "地坛") == 0.0


def test_website_key_uses_the_host_and_the_page_on_shared_hosts():
    assert website_key("https://www.example.com/en/about?x=1") == "example.com"
    assert website_key("http://EXAMPLE.com") == "example.com"
    assert website_key("https://www.facebook.com/SomeShop/posts") == "facebook.com/someshop"
    assert website_key("https://www.facebook.com/") is None
    assert website_key("not a url") is None and website_key(None) is None


def test_phone_and_address_keys():
    assert phone_key("+81 3-1234-5678") == phone_key("03 (1234) 5678") == "12345678"
    assert phone_key("123") is None
    assert address_key("1-2-3 Asakusa, Taito") == address_key("1-2-3 ASAKUSA TAITO")
    assert address_key("Tokyo") is None  # too short to be an identity

import pytest

from trippr_data.names import is_latin, normalize_name, pick_names


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("  Tokyo Tower  ", "Tokyo Tower"),
        ("ＴＯＫＹＯ　ＴＯＷＥＲ", "TOKYO TOWER"),  # full-width Latin and ideographic space
        ("ｽﾀｰﾊﾞｯｸｽ", "スターバックス"),  # half-width katakana -> full-width
        ("牛角　高田馬場　さかえ通り店", "牛角 高田馬場 さかえ通り店"),
        ("浅草寺", "浅草寺"),  # kanji unchanged
        ("서울타워", "서울타워"),  # hangul unchanged
        ("故宫博物院", "故宫博物院"),  # simplified Chinese unchanged
        ("・東京駅・", "東京駅"),  # separator punctuation trimmed from the ends
        ("Café   Lumière -", "Café Lumière"),
        ("Yahoo!", "Yahoo!"),  # meaningful punctuation kept
        ("(株)ローソン", "(株)ローソン"),  # NFKC turns the full-width parentheses ASCII, kept
        ("１２３ Ramen", "123 Ramen"),
        ("line​break\x00", "linebreak"),  # zero-width and control characters dropped
        ("   ", None),
        ("", None),
        (None, None),
    ],
)
def test_normalize_name(raw, expected):
    assert normalize_name(raw) == expected


def test_normalize_is_idempotent():
    for raw in ("ＴＯＫＹＯ", "ｽﾀｰﾊﾞｯｸｽ", "牛角　高田馬場", "Café"):
        once = normalize_name(raw)
        assert normalize_name(once) == once


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("Tokyo Tower", True),
        ("Café Lumière", True),
        ("Phở Hà Nội", True),  # Vietnamese is Latin script
        ("東京タワー", False),
        ("Starbucks 渋谷店", False),  # mixed script is not Latin-only
        ("서울", False),
        ("123", False),  # no letters
    ],
)
def test_is_latin(text, expected):
    assert is_latin(text) is expected


def test_pick_names_prefers_language_rules():
    name, local, english = pick_names(
        "セブンティーンアイス", [("en", "Seventeen Ice"), ("ja", "セブンティーンアイス")], ["ja"]
    )
    assert (name, local, english) == ("セブンティーンアイス", "セブンティーンアイス", "Seventeen Ice")


def test_pick_names_falls_back_on_script():
    assert pick_names("浅草寺", [], ["ja"]) == ("浅草寺", "浅草寺", None)
    assert pick_names("Blue Bottle Coffee", [], ["ja"]) == ("Blue Bottle Coffee", None, "Blue Bottle Coffee")
    assert pick_names("ＢＬＵＥ", [("en-GB", "Blue")], ["ja"]) == ("BLUE", None, "Blue")

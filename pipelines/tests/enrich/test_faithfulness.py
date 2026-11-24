import pytest

from trippr_data.enrich.faithfulness import format_problems, unsupported_terms

from .conftest import make_place

SENSOJI = make_place(
    "a",
    "浅草寺",
    name_en="Senso-ji",
    name_local="浅草寺",
    descriptions=[
        {
            "source": "wikivoyage",
            "text": "Buddhist temple in Asakusa, founded in 645, with the Kaminarimon gate.",
        }
    ],
)


@pytest.mark.parametrize(
    "summary",
    [
        "",
        "Buddhist temple in Asakusa with the Kaminarimon gate.",
        "Senso-ji is a temple or shrine in Tokyo.",
        "浅草寺 is a temple in Tokyo, founded in 645.",
        "Sensō-ji, a temple in Tokyo.",  # accents are not a different name
    ],
)
def test_supported_summaries_are_not_flagged(summary):
    assert unsupported_terms(summary, SENSOJI) == []


@pytest.mark.parametrize(
    ("summary", "flagged"),
    [
        ("Temple in Asakusa founded in 628.", ["628"]),
        ("A UNESCO World Heritage temple in Tokyo.", ["UNESCO", "World", "Heritage"]),
        ("Buddhist temple near Ueno Park.", ["Ueno", "Park"]),
        ("浅草神社 is a temple in Tokyo.", ["浅草神社"]),  # a garbled or invented CJK name
        ("Senso-ji is the home of the Hozomon gate.", ["Hozomon"]),
    ],
)
def test_invented_facts_and_names_are_flagged(summary, flagged):
    assert unsupported_terms(summary, SENSOJI) == flagged


def test_thai_hangul_khmer_names_must_be_copied_exactly():
    wat = make_place("b", "วัดโพธิ์", name_en="Wat Pho", city="BKK")
    assert unsupported_terms("วัดโพธิ์ is a temple in Bangkok.", wat) == []
    assert unsupported_terms("วัดพระแก้ว is a temple in Bangkok.", wat) == ["วัดพระแก้ว"]
    palace = make_place("c", "경복궁", "castle_palace", "SEL", name_en="Gyeongbokgung")
    assert unsupported_terms("경복궁 is a palace in Seoul.", palace) == []
    assert unsupported_terms("창덕궁 is a palace in Seoul.", palace) == ["창덕궁"]


def test_vietnamese_diacritics_do_not_cause_false_flags():
    lake = make_place("d", "Hồ Hoàn Kiếm", "nature_spot", "HAN", name_en="Hoan Kiem Lake")
    assert unsupported_terms("Hồ Hoàn Kiếm is a lake in Hanoi.", lake) == []
    assert unsupported_terms("Hoan Kiem Lake is a nature spot in Hanoi, Vietnam.", lake) == []


def test_format_problems():
    assert format_problems("A fine sentence.") == []
    assert format_problems("x" * 141) == ["too long"]
    assert format_problems("See https://example.com now.") == ["url"]
    assert "line break" in format_problems("one" + chr(10) + "two")
    assert format_problems("bad � text") == ["garbled text"]

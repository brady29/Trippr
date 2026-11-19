import { describe, expect, it } from "vitest";
import {
  ACTIVITY_TAGS,
  activityRadius,
  BACKGROUND,
  contrastRatio,
  deltaE,
  DEFICIENCIES,
  FIXED_DATE,
  hexToLab,
  ICON_PATHS,
  LABEL,
  linearToLab,
  primaryTag,
  simulate,
  TAG_COLOR,
} from "./graph-palette";

describe("graph palette", () => {
  it("keeps label text at 4.5:1 or better on both backgrounds", () => {
    expect(contrastRatio(LABEL.paper, BACKGROUND.paper)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(LABEL.globe, BACKGROUND.globe)).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps the fixed-date ring visible against each background (3:1 for graphics)", () => {
    expect(contrastRatio(FIXED_DATE.paper, BACKGROUND.paper)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(FIXED_DATE.globe, BACKGROUND.globe)).toBeGreaterThanOrEqual(3);
  });

  it("keeps every pair of tag colours more than ΔE 20 apart with normal vision", () => {
    const tags = [...ACTIVITY_TAGS];
    for (const [i, a] of tags.entries())
      for (const b of tags.slice(i + 1)) expect(deltaE(hexToLab(TAG_COLOR[a]), hexToLab(TAG_COLOR[b])), `${a} vs ${b}`).toBeGreaterThan(20);
  });

  /**
   * The spec's Okabe–Ito palette misses ΔE 20 (CIE76) for four pairs under
   * full-severity Machado simulation: sport/food 18.3 and nature/culture 17.9
   * under deuteranopia; tech/nature 17.0 and culture/food 17.2 under
   * tritanopia. Colour is never the only channel: these pairs keep distinct
   * icons and must stay above ΔE 15. Any other pair below 20 fails.
   */
  const KNOWN_CLOSE: Record<string, string> = {
    "deuteranopia:sport/food": "icons ball vs bowl",
    "deuteranopia:nature/culture": "icons leaf vs columns",
    "tritanopia:tech/nature": "icons chip vs leaf",
    "tritanopia:culture/food": "icons columns vs bowl",
  };

  it.each(DEFICIENCIES)("keeps tag colours apart under %s (ΔE > 20, or > 15 with distinct icons)", (kind) => {
    const tags = [...ACTIVITY_TAGS];
    for (const [i, a] of tags.entries())
      for (const b of tags.slice(i + 1)) {
        const d = deltaE(linearToLab(simulate(TAG_COLOR[a], kind)), linearToLab(simulate(TAG_COLOR[b], kind)));
        const exception = KNOWN_CLOSE[`${kind}:${a}/${b}`];
        if (exception) {
          expect(d, `${a} vs ${b} under ${kind} (${exception})`).toBeGreaterThan(15);
          expect(ICON_PATHS[a]).not.toBe(ICON_PATHS[b]);
        } else {
          expect(d, `${a} vs ${b} under ${kind}`).toBeGreaterThan(20);
        }
      }
  });

  it("sizes activities by votes, clamped to 10–30px", () => {
    expect(activityRadius(0)).toBe(14);
    expect(activityRadius(2)).toBe(20);
    expect(activityRadius(-3)).toBe(10);
    expect(activityRadius(50)).toBe(30);
  });

  it("picks the primary tag in spec order", () => {
    expect(primaryTag(["food", "tech"])).toBe("tech");
    expect(primaryTag([])).toBe("other");
    expect(primaryTag(undefined, "nature")).toBe("nature");
  });
});

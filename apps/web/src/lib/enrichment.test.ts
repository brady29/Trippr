import type { ActivityEnrichment } from "@trippr/contracts";
import { describe, expect, it } from "vitest";
import { aiLabelFor, coverage, durationLabel, durationMaxLabel, enrichmentBadges, evalRows, genericSubtitle, provenanceNote } from "./enrichment";

const base: ActivityEnrichment = {
  tags: ["museum"],
  summary: "A quiet museum.",
  summaryAi: true,
  aiLabel: "Summary written by AI from Wikidata and Wikivoyage",
  durationMin: 90,
  bestTime: "morning",
  indoor: true,
  priceLevel: "$$",
  goodFor: ["rain"],
  displayName: null,
  isGenericName: false,
  model: "claude-haiku-5-5",
  enrichedAt: "2026-11-18T09:30:00Z",
};

describe("durationLabel", () => {
  it("reads naturally", () => {
    expect(durationLabel(45)).toBe("45 min");
    expect(durationLabel(60)).toBe("1 h");
    expect(durationLabel(90)).toBe("1 h 30 min");
    expect(durationLabel(240)).toBe("4 h");
    expect(durationLabel(1440)).toBe("1 day");
    expect(durationMaxLabel(120)).toBe("Up to 2 h");
  });
});

describe("the AI label", () => {
  it("uses the pipeline's sentence", () => {
    expect(aiLabelFor(base)).toBe("Summary written by AI from Wikidata and Wikivoyage");
  });

  it("falls back to the plain label, and never labels text that is not AI-written", () => {
    expect(aiLabelFor({ ...base, aiLabel: null })).toBe("Summary written by AI");
    expect(aiLabelFor({ ...base, summaryAi: false })).toBeNull(); // the group's own text
    expect(aiLabelFor({ ...base, summary: null })).toBeNull();
    expect(aiLabelFor(undefined)).toBeNull();
  });

  it("explains who wrote it", () => {
    expect(provenanceNote(base)).toContain("claude-haiku-5-5 on 2026-11-18");
  });
});

describe("genericSubtitle", () => {
  it("shows the suggested name only for a generic one, and never repeats the title", () => {
    const generic = { ...base, isGenericName: true, displayName: "Tokyo National Museum" };
    expect(genericSubtitle("Independent Administrative Institution National Museum", generic)).toBe("Tokyo National Museum");
    expect(genericSubtitle("tokyo national museum", generic)).toBeNull();
    expect(genericSubtitle("Whatever", { ...generic, isGenericName: false })).toBeNull();
    expect(genericSubtitle("Whatever", { ...generic, displayName: null })).toBeNull();
    expect(genericSubtitle("Whatever", undefined)).toBeNull();
  });
});

describe("enrichmentBadges", () => {
  it("lists duration, best time, indoor, price and what it is good for", () => {
    expect(enrichmentBadges(base).map((b) => b.label)).toEqual(["1 h 30 min", "Best: morning", "Indoor", "$$", "Good for rain"]);
    expect(enrichmentBadges({ ...base, bestTime: "any", indoor: false }).map((b) => b.label)).toContain("Any time of day");
    expect(enrichmentBadges({ ...base, indoor: false }).map((b) => b.label)).toContain("Outdoor");
  });

  it("leaves out what the model could not tell", () => {
    expect(enrichmentBadges({ ...base, durationMin: null, bestTime: null, indoor: null, priceLevel: null, goodFor: [] })).toEqual([]);
    expect(enrichmentBadges(undefined)).toEqual([]);
  });
});

describe("evalRows", () => {
  const evals = {
    enrich: {
      model: "claude-haiku-5-5",
      judge_model: "claude-haiku-5-5",
      metrics: { n: 174, tag_f1: 0.8123, valid_rate: 1, summary_judge_unsupported_rate: 0.02, summary_rule_unsupported_rate: 0.05, best_time_accuracy: null },
      targets: { tag_f1: true, valid_answers: true, unsupported_summaries: false },
    },
  };

  it("turns the manifest's scores into labelled percentages with their targets", () => {
    const r = evalRows(evals)!;
    expect(r.eval.model).toBe("claude-haiku-5-5");
    expect(r.rows.map((x) => [x.key, x.value, x.met])).toEqual([
      ["tag_f1", "81.2%", true],
      ["valid_rate", "100%", true],
      ["summary_judge_unsupported_rate", "2.0%", false],
    ]);
  });

  it("uses the rule check when the judge did not run", () => {
    const r = evalRows({ enrich: { ...evals.enrich, metrics: { tag_f1: 0.7, summary_rule_unsupported_rate: 0.1 } } })!;
    expect(r.rows.map((x) => x.key)).toEqual(["tag_f1", "summary_rule_unsupported_rate"]);
  });

  it("is null when there are no scores", () => {
    expect(evalRows({})).toBeNull();
    expect(evalRows(undefined)).toBeNull();
    expect(evalRows({ enrich: "nope" })).toBeNull();
  });
});

describe("coverage", () => {
  it("says how much of the catalogue was enriched", () => {
    const e = { places: 40, withSummary: 39, models: [], promptVersions: [], enrichedAt: null, sourceDate: "2026-11-18" };
    expect(coverage(e, 80)).toBe("40 of 80 places (50%)");
    expect(coverage(e, 0)).toBe("40 of 0 places");
  });
});

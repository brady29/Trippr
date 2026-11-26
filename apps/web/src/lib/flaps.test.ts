import { describe, expect, it } from "vitest";
import { alignBoard, DRUM, flapSequence, MAX_STEPS } from "./flaps";

describe("flapSequence", () => {
  it("turns forwards through the drum and lands on the letter", () => {
    expect(flapSequence("A", "D")).toEqual(["B", "C", "D"]);
  });

  it("goes all the way round to reach an earlier letter, skipping evenly", () => {
    const seq = flapSequence("C", "A");
    expect(seq).toHaveLength(MAX_STEPS);
    expect(seq.at(-1)).toBe("A");
    // Every step moves forwards on the drum.
    const at = (c: string) => DRUM.indexOf(c);
    for (let i = 1; i < seq.length - 1; i++) expect((at(seq[i]!) - at(seq[i - 1]!) + DRUM.length) % DRUM.length).toBeGreaterThan(0);
  });

  it("starts from a blank tile and drops in characters the drum doesn't have", () => {
    expect(flapSequence(" ", "B")).toEqual(["A", "B"]);
    expect(flapSequence("A", "→")).toEqual(["→"]);
    expect(flapSequence("K", "K")).toEqual(["K"]);
  });
});

describe("alignBoard", () => {
  it("pads the shorter text with blanks", () => {
    expect(alignBoard("MAIN", "ASIA 27")).toEqual(["MAIN   ", "ASIA 27"]);
  });
});

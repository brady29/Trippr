/**
 * Split-flap boards: each tile holds a drum of characters and can only turn
 * forwards, so going from "C" to "A" means turning all the way round. These
 * are the characters a tile shows on its way, in drum order.
 */
export const DRUM = " ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,:/-+&'!?·";

/** At most this many characters between two letters; longer trips skip evenly, like a fast board. */
export const MAX_STEPS = 10;

export function flapSequence(from: string, to: string, maxSteps = MAX_STEPS): string[] {
  const a = DRUM.indexOf(from.toUpperCase());
  const b = DRUM.indexOf(to.toUpperCase());
  if (from === to) return [to];
  // A character that isn't on the drum (é, →) just drops into place.
  if (b < 0) return [to];
  const startAt = a < 0 ? 0 : a;
  const distance = (b - startAt + DRUM.length) % DRUM.length || DRUM.length;
  const steps = Math.min(distance, maxSteps);
  const out: string[] = [];
  for (let k = 1; k <= steps; k++) {
    const i = (startAt + Math.round((k * distance) / steps)) % DRUM.length;
    out.push(DRUM[i]!);
  }
  out[out.length - 1] = to;
  return out;
}

/** Pads two strings to the same length with blanks, so a board can change between texts of any length. */
export function alignBoard(from: string, to: string): [string, string] {
  const n = Math.max(from.length, to.length);
  return [from.padEnd(n, " "), to.padEnd(n, " ")];
}

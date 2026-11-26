import { addDays } from "./dates";

/**
 * Busy holiday periods: when domestic travel peaks and trains, flights and
 * rooms fill up and get dearer. A small curated table for the countries on
 * Trippr's routes, with typical dates. Lunar New Year moves each year, so its
 * dates are listed per year; the others repeat on the same days.
 */
export interface BusyPeriod {
  name: string;
  /** Countries where it's busy (China's holidays also fill Hong Kong and Macau). */
  countries: string[];
  from: string;
  to: string;
  note: string;
}

const EVERY_YEAR: { name: string; countries: string[]; from: string; to: string; note: string }[] = [
  { name: "Golden Week", countries: ["JP"], from: "04-29", to: "05-05", note: "Japan's longest holiday run: trains and hotels book out." },
  { name: "Obon", countries: ["JP"], from: "08-13", to: "08-16", note: "Families travel home; shinkansen are packed." },
  { name: "Japanese New Year", countries: ["JP"], from: "12-29", to: "01-03", note: "Many shops and sights close; trains are full." },
  { name: "Labour Day holiday", countries: ["CN", "HK", "MO"], from: "05-01", to: "05-05", note: "Five days off across China: sights and rail are at their busiest." },
  { name: "National Day Golden Week", countries: ["CN", "HK", "MO"], from: "10-01", to: "10-07", note: "China's biggest travel week." },
  { name: "Songkran", countries: ["TH"], from: "04-13", to: "04-15", note: "Thai New Year: water fights, and buses and trains fill up." },
];

/** Lunar New Year (Spring Festival, Tết, Seollal) by year: the day itself; the busy stretch runs from the day before to six days after. */
const LUNAR_NEW_YEAR: Record<number, string> = {
  2026: "2026-02-17",
  2027: "2027-02-06",
  2028: "2028-01-26",
  2029: "2029-02-13",
};

/** The busy periods that overlap from..to (YYYY-MM-DD) in the given countries. */
export function busyPeriods(from: string, to: string, countries: readonly string[]): BusyPeriod[] {
  const wanted = new Set(countries);
  const out: BusyPeriod[] = [];
  const firstYear = Number(from.slice(0, 4)) - 1;
  const lastYear = Number(to.slice(0, 4));
  for (let y = firstYear; y <= lastYear; y++) {
    for (const h of EVERY_YEAR) {
      const start = `${y}-${h.from}`;
      // A period that runs over New Year ends in the next year.
      const end = h.to < h.from ? `${y + 1}-${h.to}` : `${y}-${h.to}`;
      out.push({ name: h.name, countries: h.countries, from: start, to: end, note: h.note });
    }
    const lny = LUNAR_NEW_YEAR[y];
    if (lny) {
      out.push({
        name: "Lunar New Year",
        countries: ["CN", "HK", "MO", "TW", "VN", "KR", "SG", "MY"],
        from: addDays(lny, -1),
        to: addDays(lny, 6),
        note: "Spring Festival, Tết and Seollal: the busiest travel of the year, and many places close.",
      });
    }
  }
  return out
    .filter((p) => p.from <= to && p.to >= from && p.countries.some((c) => wanted.has(c)))
    .sort((a, b) => a.from.localeCompare(b.from));
}

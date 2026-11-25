"use client";

import type { CheckStatus, DataStayView } from "@trippr/contracts";
import { STAY_PART_KEYS, STAY_PART_LABELS } from "@trippr/contracts";
import { Panel } from "./ui";

const STATUS_STYLE: Record<CheckStatus, string> = {
  pass: "bg-ok/10 text-ok",
  fail: "bg-err/10 text-err",
  warn: "bg-warn/10 text-warn",
  info: "bg-info/10 text-info",
};

const cad = (n: number | null) => (n == null ? "n/a" : `CAD ${Math.round(n).toLocaleString("en-CA")}`);

/**
 * The Data page's stay section: how far Inside Airbnb reaches, which snapshot each city's numbers come from, the
 * attribution its licence asks for, how the score is weighted and the pipeline's stay checks.
 */
export function DataStay({ stay }: { stay: DataStayView | null | undefined }) {
  if (!stay) {
    return (
      <Panel title="Stay analytics">
        <p className="text-sm text-ink-soft" data-testid="stay-none">
          No stay data has been loaded yet. Area cards show &quot;No stay data&quot; and the &quot;Stay prices&quot; map layer stays empty until a bundle with Inside
          Airbnb aggregates and open-data hotels is loaded.
        </p>
      </Panel>
    );
  }
  const failed = stay.checks && !stay.checks.passed;
  return (
    <Panel
      title="Stay analytics"
      action={
        stay.checks ? (
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${failed ? STATUS_STYLE.fail : STATUS_STYLE.pass}`} data-testid="stay-checks-status">
            {failed ? "A stay check failed" : "Stay checks passed"}
          </span>
        ) : null
      }
    >
      <div className="space-y-4" data-testid="data-stay" data-bundle={stay.bundleDate}>
        <p className="text-sm" data-testid="stay-coverage-note">
          <strong className="font-semibold">{stay.coverage.note}.</strong>{" "}
          <span className="text-ink-soft">
            For every other city the Area cards say there is no stay data and score from location and nearby places only. Bundle {stay.bundleDate}, from the data run of {stay.runDate}.
          </span>
        </p>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[32rem] text-left text-sm" data-testid="stay-cities">
            <caption className="sr-only">Inside Airbnb snapshots by city</caption>
            <thead className="text-xs uppercase tracking-wide text-ink-faint">
              <tr>
                <th className="py-1 pr-3 font-medium">City</th>
                <th className="py-1 pr-3 font-medium">Snapshot</th>
                <th className="py-1 pr-3 text-right font-medium">Listings</th>
                <th className="py-1 pr-3 text-right font-medium">With a usable price</th>
                <th className="py-1 text-right font-medium">Median a night</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {stay.cities.map((c) => (
                <tr key={c.cityCode} data-testid="stay-city" data-city={c.cityCode}>
                  <td className="py-1.5 pr-3">
                    {c.name} <span className="font-mono text-xs text-ink-faint">{c.cityCode}</span>
                  </td>
                  <td className="py-1.5 pr-3 font-mono text-xs">{c.snapshotDate ?? "unknown"}</td>
                  <td className="py-1.5 pr-3 text-right">{c.listings.toLocaleString("en-CA")}</td>
                  <td className="py-1.5 pr-3 text-right">{c.pricedListings.toLocaleString("en-CA")}</td>
                  <td className="py-1.5 text-right">{cad(c.medianPriceCad)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs uppercase tracking-wide text-ink-faint">Units</dt>
            <dd data-testid="stay-units">
              {Object.entries(stay.units)
                .map(([kind, n]) => `${n.toLocaleString("en-CA")} ${kind === "h3" ? "map cells" : kind === "neighbourhood" ? "neighbourhoods" : kind === "area" ? "areas" : "cities"}`)
                .join(" · ")}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-ink-faint">Open-data hotels</dt>
            <dd data-testid="stay-hotels">
              {stay.hotels.inGraph.toLocaleString("en-CA")} in the graph
              <span className="block text-xs text-ink-faint">At most {stay.hotels.perAreaCap} per area; {stay.hotels.inAreas.toLocaleString("en-CA")} fall inside an area.</span>
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-ink-faint">Score weights</dt>
            <dd data-testid="stay-weights">
              {STAY_PART_KEYS.filter((k) => stay.weights[k] != null)
                .map((k) => `${STAY_PART_LABELS[k]} ${Math.round(stay.weights[k]! * 100)}%`)
                .join(" · ")}
            </dd>
          </div>
        </dl>

        <p className="rounded-lg border border-line bg-paper px-3 py-2 text-sm" data-testid="stay-attribution">
          {stay.attribution} <span className="text-ink-faint">Licence: {stay.licence}. Only aggregates are shown: no listing, host or name from Inside Airbnb is ever displayed or stored here.</span>
        </p>

        {stay.checks ? (
          <details className="text-sm" open={Boolean(failed)}>
            <summary className="cursor-pointer text-ink-soft">
              Stay check results ({stay.checks.results.filter((r) => r.status === "pass").length} of {stay.checks.results.length} passed)
            </summary>
            <ul className="mt-2 divide-y divide-line" data-testid="stay-checks-list">
              {stay.checks.results.map((r) => (
                <li key={r.name} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-1.5">
                  <span className={`w-12 shrink-0 rounded px-1.5 py-0.5 text-center text-[11px] font-semibold ${STATUS_STYLE[r.status]}`}>{r.status === "fail" ? "FAIL" : r.status}</span>
                  <code className="font-mono text-xs">{r.name}</code>
                  <span className="min-w-0 flex-1 text-ink-soft">{r.detail}</span>
                </li>
              ))}
            </ul>
          </details>
        ) : (
          <p className="text-sm text-ink-soft">No stay check results were recorded for this bundle.</p>
        )}
      </div>
    </Panel>
  );
}

import type { DataLoadView, DataSourcesResponse, DataSourceView, DataStayView } from "@trippr/contracts";
import type { GraphClient } from "../db/graph";
import { cypher } from "./queries";
import { num, optNum, parseJson } from "./util";

type SourceRow = {
  source: {
    id: string;
    name: string;
    url: string;
    licence: string;
    licenceDetail?: string | null;
    licenceUrls?: string[] | null;
    attribution: string;
    termsCheckedOn: string;
    allowedUses?: string[] | null;
    enabled?: boolean | null;
    version?: string | null;
    fetchedAt?: string | null;
    stagedRows?: unknown;
  };
  activities: unknown;
};

type LoadRow = {
  load: {
    bundleDate: string;
    loadedAt: string;
    input: "golden";
    pipelineVersion: string;
    counts: unknown;
    checks: unknown;
    evals: unknown;
  };
};

/** What the Data page shows: the sources behind the catalogue, the latest load and its quality results. */
export function dataRepository(db: GraphClient) {
  const q = (name: string) => cypher(name, db.dialect);
  const read = { readOnly: true };

  return {
    async sources(): Promise<Omit<DataSourcesResponse, "notes">> {
      const [sources, loads, totals, stayLoads, hotelCounts] = await Promise.all([
        db.query<SourceRow>(q("data/sources"), {}, read),
        db.query<LoadRow>(q("data/latest-load"), {}, read),
        db.query<{ catalogue: unknown; listed: unknown; unlisted: unknown; handWritten: unknown; enriched: unknown }>(q("data/totals"), {}, read),
        db.query<{ load: { stay?: unknown } }>(cypher("stay-data/load-get", db.dialect), {}, read),
        db.query<{ source: string; hotels: unknown }>(cypher("stay-data/hotels-sources-count", db.dialect), {}, read),
      ]);
      const hotelsBySource = new Map(hotelCounts.map((r) => [r.source, num(r.hotels)]));
      const views: DataSourceView[] = sources.map(({ source: s, activities }) => ({
        id: s.id,
        name: s.name,
        url: s.url,
        licence: s.licence,
        licenceDetail: s.licenceDetail ?? null,
        licenceUrls: s.licenceUrls ?? [],
        attribution: s.attribution,
        termsCheckedOn: s.termsCheckedOn,
        allowedUses: s.allowedUses ?? [],
        enabled: s.enabled !== false,
        version: s.version ?? null,
        fetchedAt: s.fetchedAt ?? null,
        stagedRows: optNum(s.stagedRows),
        activities: num(activities),
        ...(hotelsBySource.has(s.id) ? { hotels: hotelsBySource.get(s.id)! } : {}),
      }));
      const row = loads[0]?.load;
      // The enrichment section travels inside the stored counts JSON (older loads have none).
      const stored = parseJson<DataLoadView["counts"] & { enrichment?: DataLoadView["enrichment"] }>(row?.counts) ?? null;
      const { enrichment, ...counts } = stored ?? ({} as NonNullable<typeof stored>);
      const checks = parseJson<DataLoadView["checks"]>(row?.checks) ?? null;
      const latestLoad: DataLoadView | null =
        row && stored && checks
          ? {
              bundleDate: row.bundleDate,
              loadedAt: row.loadedAt,
              input: row.input,
              pipelineVersion: row.pipelineVersion,
              counts,
              checks,
              evals: parseJson<Record<string, unknown>>(row.evals) ?? {},
              enrichment: enrichment ?? null,
            }
          : null;
      const t = totals[0];
      return {
        sources: views,
        latestLoad,
        totals: { catalogue: num(t?.catalogue), listed: num(t?.listed), unlisted: num(t?.unlisted), handWritten: num(t?.handWritten), enriched: num(t?.enriched) },
        stay: parseJson<DataStayView>(stayLoads[0]?.load?.stay) ?? null,
      };
    },
  };
}

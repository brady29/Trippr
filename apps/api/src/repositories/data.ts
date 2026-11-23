import type { DataLoadView, DataSourcesResponse, DataSourceView } from "@trippr/contracts";
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
    input: "golden" | "staged";
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
      const [sources, loads, totals] = await Promise.all([
        db.query<SourceRow>(q("data/sources"), {}, read),
        db.query<LoadRow>(q("data/latest-load"), {}, read),
        db.query<{ catalogue: unknown; listed: unknown; unlisted: unknown; handWritten: unknown }>(q("data/totals"), {}, read),
      ]);
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
      }));
      const row = loads[0]?.load;
      const counts = parseJson<DataLoadView["counts"]>(row?.counts) ?? null;
      const checks = parseJson<DataLoadView["checks"]>(row?.checks) ?? null;
      const latestLoad: DataLoadView | null =
        row && counts && checks
          ? {
              bundleDate: row.bundleDate,
              loadedAt: row.loadedAt,
              input: row.input,
              pipelineVersion: row.pipelineVersion,
              counts,
              checks,
              evals: parseJson<Record<string, unknown>>(row.evals) ?? {},
            }
          : null;
      const t = totals[0];
      return {
        sources: views,
        latestLoad,
        totals: { catalogue: num(t?.catalogue), listed: num(t?.listed), unlisted: num(t?.unlisted), handWritten: num(t?.handWritten) },
      };
    },
  };
}

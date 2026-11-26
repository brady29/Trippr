"use client";

import type { CheckStatus, DataCheckView, DataLoadView, DataSourceView } from "@trippr/contracts";
import Link from "next/link";
import { EnrichmentStats } from "@/components/data-enrichment";
import { DataStay } from "@/components/data-stay";
import { BoardHeader, BoardStat } from "@/components/shell";
import { ErrorNote, Panel, Spinner, Tag } from "@/components/ui";
import { useAuth } from "@/lib/auth";
import { useDataSources } from "@/lib/queries";

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "unknown");

/** "3 days ago", from an ISO timestamp. */
function ago(iso: string | null): string {
  if (!iso) return "never";
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  if (!Number.isFinite(days)) return "unknown";
  if (days <= 0) return "today";
  return days === 1 ? "yesterday" : `${days} days ago`;
}

const STATUS_STYLE: Record<CheckStatus, string> = {
  pass: "bg-ok/10 text-ok",
  fail: "bg-err/10 text-err",
  warn: "bg-warn/10 text-warn",
  info: "bg-info/10 text-info",
};
const STATUS_LABEL: Record<CheckStatus, string> = { pass: "pass", fail: "FAIL", warn: "warn", info: "info" };

const STAGES = [
  { name: "Extract", note: "five open datasets", built: true },
  { name: "Stage", note: "one schema, one taxonomy", built: true },
  { name: "Match", note: "entity resolution", built: true },
  { name: "Curate", note: "rank, budget, mix", built: true },
  { name: "Enrich", note: "AI summaries", built: true },
  { name: "Embed", note: "search vectors", built: true },
  { name: "Bundle", note: "checked seed bundle", built: true },
  { name: "Load", note: "idempotent job into the graph", built: true },
] as const;

function Pipeline() {
  return (
    <ol className="flex flex-wrap items-stretch gap-2" aria-label="Pipeline stages" data-testid="pipeline">
      {STAGES.map((s, i) => (
        <li key={s.name} className="flex items-center gap-2">
          <div className={`rounded-lg border px-3 py-2 ${s.built ? "border-line bg-card" : "border-dashed border-line bg-paper text-ink-faint"}`}>
            <div className="text-sm font-medium">{s.name}</div>
            <div className="text-[11px] text-ink-soft">{s.built ? s.note : `${s.note} (not built yet)`}</div>
          </div>
          {i < STAGES.length - 1 ? <span aria-hidden className="text-ink-faint">→</span> : null}
        </li>
      ))}
    </ol>
  );
}

function SourceCard({ source }: { source: DataSourceView }) {
  return (
    <article className="rounded-xl border border-line bg-card p-4" data-testid="source-card" data-source={source.id}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-base font-semibold">
          <a href={source.url} target="_blank" rel="noreferrer" className="hover:underline">
            {source.name}
          </a>
        </h3>
        <div className="flex items-center gap-1.5 text-xs">
          {!source.enabled ? <Tag>off</Tag> : null}
          <Tag tone="amber">{source.licence}</Tag>
        </div>
      </div>
      <p className="mt-2 text-sm text-ink-soft" data-testid="source-attribution">
        {source.attribution}
      </p>
      <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs uppercase tracking-wide text-ink-faint">In the graph</dt>
          <dd data-testid="source-activities">
            {source.activities.toLocaleString("en-CA")} activities
            {source.hotels ? <span data-testid="source-hotels"> · {source.hotels.toLocaleString("en-CA")} hotels</span> : null}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-ink-faint">Rows after staging</dt>
          <dd>{source.stagedRows != null ? source.stagedRows.toLocaleString("en-CA") : "not recorded"}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-ink-faint">Data fetched</dt>
          <dd>
            {day(source.fetchedAt)} <span className="text-ink-faint">({ago(source.fetchedAt)})</span>
            {source.version ? <span className="text-ink-faint"> · release {source.version}</span> : null}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-ink-faint">Terms checked</dt>
          <dd>{source.termsCheckedOn}</dd>
        </div>
      </dl>
      <details className="mt-3 text-sm">
        <summary className="cursor-pointer text-ink-soft">Licence and allowed uses</summary>
        {source.licenceDetail ? <p className="mt-2 text-ink-soft">{source.licenceDetail}</p> : null}
        <ul className="mt-2 list-disc space-y-1 pl-5 text-ink-soft">
          {source.allowedUses.map((u) => (
            <li key={u}>{u}</li>
          ))}
        </ul>
        <div className="mt-2 flex flex-wrap gap-3">
          {source.licenceUrls.map((u) => (
            <a key={u} href={u} target="_blank" rel="noreferrer" className="text-sky hover:underline">
              {new URL(u).hostname}
            </a>
          ))}
        </div>
      </details>
    </article>
  );
}

function Checks({ load }: { load: DataLoadView }) {
  const results: DataCheckView[] = load.checks.results;
  const important = results.filter((r) => r.status !== "info");
  return (
    <Panel
      title="Quality checks"
      action={
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${load.checks.passed ? STATUS_STYLE.pass : STATUS_STYLE.fail}`} data-testid="checks-status">
          {load.checks.passed ? "All checks passed" : "A check failed"}
        </span>
      }
    >
      <p className="mb-3 text-sm text-ink-soft">
        Every bundle runs these before it can be loaded. A failure stops the bundle, so the app keeps its last good data.
      </p>
      <ul className="divide-y divide-line text-sm" data-testid="checks-list">
        {(important.length ? important : results).map((r) => (
          <li key={r.name} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2">
            <span className={`w-12 shrink-0 rounded px-1.5 py-0.5 text-center text-[11px] font-semibold ${STATUS_STYLE[r.status]}`}>{STATUS_LABEL[r.status]}</span>
            <code className="font-mono text-xs">{r.name}</code>
            <span className="min-w-0 flex-1 text-ink-soft">{r.detail}</span>
          </li>
        ))}
      </ul>
      {results.length > important.length && important.length ? (
        <details className="mt-2 text-sm">
          <summary className="cursor-pointer text-ink-soft">{results.length - important.length} informational results</summary>
          <ul className="mt-2 space-y-1 text-ink-soft">
            {results
              .filter((r) => r.status === "info")
              .map((r) => (
                <li key={r.name}>
                  <code className="font-mono text-xs">{r.name}</code> {r.detail}
                </li>
              ))}
          </ul>
        </details>
      ) : null}
    </Panel>
  );
}

function Evals({ load }: { load: DataLoadView }) {
  // The enrichment scores have their own panel above.
  const entries = Object.entries(load.evals).filter(([name]) => name !== "enrich");
  if (!entries.length && "enrich" in load.evals) return null;
  return (
    <Panel title="Evaluation results">
      {entries.length ? (
        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          {entries.map(([name, value]) => (
            <div key={name}>
              <dt className="text-xs uppercase tracking-wide text-ink-faint">{name.replace(/_/g, " ")}</dt>
              <dd>
                <code className="font-mono text-xs">{JSON.stringify(value)}</code>
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-sm text-ink-soft">
          No evaluation scores yet. Entity-matching precision and recall, enrichment accuracy and search relevance are reported here as those
          stages arrive.
        </p>
      )}
    </Panel>
  );
}

export default function DataPage() {
  const { status } = useAuth();
  const data = useDataSources();
  const load = data.data?.latestLoad ?? null;
  return (
    <>
      <BoardHeader
        eyebrow="Open data behind the activity catalogue"
        title="Data"
        meta={
          load ? (
            <>
              <BoardStat label="Last load" value={`${load.bundleDate} (${ago(load.loadedAt)})`} />
              <BoardStat label="Catalogue places" value={(data.data?.totals.listed ?? 0).toLocaleString("en-CA")} />
              <BoardStat label="Cities" value={load.counts.cities} />
              <BoardStat label="Checks" value={load.checks.passed ? "passed" : "FAILED"} />
            </>
          ) : null
        }
      />
      <main className="mx-auto max-w-6xl space-y-6 px-4 py-6" data-testid="data-page">
        {data.isPending ? <Spinner label="Loading the data sources" /> : null}
        {data.error ? <ErrorNote error={data.error} /> : null}
        {data.data ? (
          <>
            <Panel title="How the places get here">
              <Pipeline />
              <p className="mt-3 text-sm text-ink-soft">
                A scheduled pipeline reads open datasets, cleans and ranks the places for each city, checks the result and writes a bundle. A
                load job puts the newest bundle that passed its checks into the graph without touching votes, plans or anything the group
                edited.
              </p>
            </Panel>

            {!load ? (
              <p className="rounded-xl border border-dashed border-line p-4 text-sm text-ink-soft" data-testid="no-load">
                No catalogue has been loaded yet. The Activities page shows only the group&apos;s own ideas until the first bundle is loaded.
              </p>
            ) : (
              <Panel title="Latest load">
                <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-5" data-testid="latest-load">
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-ink-faint">Bundle</dt>
                    <dd>{load.bundleDate}</dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-ink-faint">Places in the bundle</dt>
                    <dd>{load.counts.places.toLocaleString("en-CA")}</dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-ink-faint">Matching</dt>
                    <dd>entity-matched records</dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-ink-faint">Last run: added / updated</dt>
                    <dd>
                      {load.counts.created} / {load.counts.updated}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-ink-faint">Last run: matched to our ideas</dt>
                    <dd>{load.counts.adopted}</dd>
                  </div>
                </dl>
                <div className="mt-4 flex flex-wrap gap-2" aria-label="Places by colour tag">
                  {Object.entries(load.counts.byTag)
                    .sort((a, b) => b[1] - a[1])
                    .map(([tag, n]) => (
                      <Tag key={tag}>
                        {tag} {n}
                      </Tag>
                    ))}
                </div>
              </Panel>
            )}

            <section aria-labelledby="sources-heading" className="space-y-3">
              <h2 id="sources-heading" className="text-xs font-semibold uppercase tracking-[0.14em] text-ink-soft">
                Sources and licences
              </h2>
              {data.data.sources.length ? (
                <div className="grid gap-3 lg:grid-cols-2">
                  {data.data.sources.map((s) => (
                    <SourceCard key={s.id} source={s} />
                  ))}
                </div>
              ) : (
                <p className="text-sm text-ink-soft">No sources recorded yet.</p>
              )}
            </section>

            {load ? <EnrichmentStats load={load} /> : null}
            {load ? <Checks load={load} /> : null}
            {load ? <Evals load={load} /> : null}
            <DataStay stay={data.data.stay} />

            <Panel title="Licences and attribution">
              <ul className="list-disc space-y-1.5 pl-5 text-sm text-ink-soft" data-testid="licence-notes">
                {data.data.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
              <p className="mt-3 text-sm text-ink-soft">
                {status === "signedIn" ? (
                  <>
                    Back to <Link href="/" className="text-sky hover:underline">your trips</Link>.
                  </>
                ) : (
                  <>This page is public; the trip itself needs a sign-in.</>
                )}
              </p>
            </Panel>
          </>
        ) : null}
      </main>
    </>
  );
}

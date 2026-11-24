import type { SearchRepository } from "../../repositories/search";
import { haversineKm } from "./ranking";

/**
 * The exact path: every place's vector in one Float32Array, scanned with a dot product. Exact (no approximation),
 * filters apply before ranking, and it needs nothing from the database's vector index.
 *
 * Memory: places x dims x 4 bytes (8,000 x 1,024 = 32.8 MB) plus a few arrays of ids and metadata. The pages
 * that fill it hold at most PAGE x dims numbers as plain JavaScript arrays (8 bytes each: 2 MB for PAGE 250) at
 * a time. That fits the 512 MiB API instance; `MAX_BYTES` stops a far larger catalogue from taking it over.
 */
export const PAGE = 250;
export const MAX_BYTES = 160 * 1024 * 1024;

export interface MatrixFilter {
  cityCode?: string | undefined;
  category?: string | undefined;
  tag?: string | undefined;
  near?: { lat: number; lon: number; km: number } | undefined;
}

export class VectorMatrix {
  readonly size: number;
  constructor(
    readonly dims: number,
    readonly ids: string[],
    private readonly cityCodes: string[],
    private readonly categories: (string | null)[],
    private readonly tags: string[][],
    private readonly pins: (readonly [number, number] | null)[],
    private readonly data: Float32Array,
    /** 1 / the vector's length, so cosine stays right even for vectors that were not normalised. */
    private readonly inverseNorms: Float32Array,
  ) {
    this.size = ids.length;
  }

  get bytes(): number {
    return this.data.byteLength + this.inverseNorms.byteLength;
  }

  indexOf(id: string): number {
    return this.byId().get(id) ?? -1;
  }

  private index?: Map<string, number>;
  private byId(): Map<string, number> {
    return (this.index ??= new Map(this.ids.map((id, i) => [id, i])));
  }

  /** Cosine similarity of `query` to one place's vector; null when the place has no vector. */
  similarity(query: Float32Array, id: string): number | null {
    const row = this.byId().get(id);
    if (row === undefined) return null;
    return this.dot(query, row) * this.inverseNorms[row]! * inverseNorm(query);
  }

  private dot(query: Float32Array, row: number): number {
    const { dims, data } = this;
    const base = row * dims;
    let sum = 0;
    for (let j = 0; j < dims; j++) sum += query[j]! * data[base + j]!;
    return sum;
  }

  /** The k most similar places that pass the filter, best first (ties by id), as cosine similarity. */
  nearest(query: Float32Array, k: number, filter: MatrixFilter = {}): { id: string; similarity: number }[] {
    if (query.length !== this.dims) throw new Error(`The query has ${query.length} values, the loaded vectors have ${this.dims}`);
    const qScale = inverseNorm(query);
    const hits: { row: number; similarity: number }[] = [];
    for (let row = 0; row < this.size; row++) {
      if (filter.cityCode && this.cityCodes[row] !== filter.cityCode) continue;
      if (filter.category && this.categories[row] !== filter.category) continue;
      if (filter.tag && !this.tags[row]!.includes(filter.tag)) continue;
      if (filter.near) {
        const pin = this.pins[row];
        if (!pin || haversineKm(filter.near, { lat: pin[0], lon: pin[1] }) > filter.near.km) continue;
      }
      hits.push({ row, similarity: this.dot(query, row) * this.inverseNorms[row]! * qScale });
    }
    hits.sort((a, b) => b.similarity - a.similarity || (this.ids[a.row]! < this.ids[b.row]! ? -1 : 1));
    return hits.slice(0, k).map((h) => ({ id: this.ids[h.row]!, similarity: h.similarity }));
  }
}

function inverseNorm(v: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i]! * v[i]!;
  return sum === 0 ? 0 : 1 / Math.sqrt(sum);
}

/** Build a matrix from rows (tests, and the loader below). */
export function buildMatrix(
  dims: number,
  rows: { id: string; cityCode: string; category: string | null; lat: number | null; lon: number | null; tags: string[]; vector: ArrayLike<number> }[],
): VectorMatrix {
  const data = new Float32Array(rows.length * dims);
  const inverse = new Float32Array(rows.length);
  rows.forEach((row, i) => {
    if (row.vector.length !== dims) throw new Error(`${row.id} has a vector of ${row.vector.length} values, expected ${dims}`);
    for (let j = 0; j < dims; j++) data[i * dims + j] = row.vector[j]!;
    inverse[i] = inverseNorm(row.vector);
  });
  return new VectorMatrix(
    dims,
    rows.map((r) => r.id),
    rows.map((r) => r.cityCode),
    rows.map((r) => r.category),
    rows.map((r) => [...r.tags]),
    rows.map((r) => (r.lat != null && r.lon != null ? ([r.lat, r.lon] as const) : null)),
    data,
    inverse,
  );
}

/** Read every vector out of the graph, page by page (the only place besides the loader that touches them). */
export async function loadMatrix(repo: Pick<SearchRepository, "vectorsPage">, dims: number, expected: number): Promise<VectorMatrix> {
  if (expected * dims * 4 > MAX_BYTES) {
    throw new Error(`${expected} vectors of ${dims} values would take ${Math.round((expected * dims * 4) / 1e6)} MB; the exact search stops at ${MAX_BYTES / 1e6} MB`);
  }
  const rows: Parameters<typeof buildMatrix>[1] = [];
  let after = "";
  for (;;) {
    const page = await repo.vectorsPage(after, PAGE);
    for (const row of page) {
      // Store as float32 now: the page's plain arrays are garbage as soon as the next page arrives.
      rows.push({ ...row, vector: Float32Array.from(row.vector) });
    }
    if (page.length < PAGE) break;
    after = page[page.length - 1]!.id;
  }
  return buildMatrix(dims, rows);
}

/**
 * The matrix, loaded on first use and again when the load job writes new vectors (the revision changes).
 * One load at a time; a failed load is not cached.
 */
export class MatrixCache {
  private current: { revision: string; matrix: VectorMatrix } | null = null;
  private loading: { revision: string; promise: Promise<VectorMatrix> } | null = null;

  constructor(private readonly repo: Pick<SearchRepository, "vectorsPage">) {}

  async get(state: { revision: string; dims: number; count: number }): Promise<VectorMatrix> {
    if (this.current?.revision === state.revision) return this.current.matrix;
    if (this.loading?.revision === state.revision) return this.loading.promise;
    const promise = loadMatrix(this.repo, state.dims, state.count).then((matrix) => {
      this.current = { revision: state.revision, matrix };
      return matrix;
    });
    const entry = { revision: state.revision, promise };
    this.loading = entry;
    try {
      return await promise;
    } finally {
      if (this.loading === entry) this.loading = null;
    }
  }

  /** Drop the cache (tests; or after the index is rebuilt in this process). */
  clear() {
    this.current = null;
  }

  get bytes(): number {
    return this.current?.matrix.bytes ?? 0;
  }
}

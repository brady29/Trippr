import type { GraphClient } from "../db/graph";
import { cypher } from "./queries";
import { num, optNum, parseJson, str } from "./util";

/** Stay analytics in the graph: Area stay cards, one StayMarket per Inside Airbnb city, open-data hotels, the latest load. */

export interface StayAreaRow {
  areaId: string;
  /** The stored card as JSON (services/catalogue/stay.ts: StoredAreaStay). */
  stay: string;
  score: number | null;
  medianPriceCad: number | null;
  snapshotDate: string | null;
  bundleDate: string;
  hotelCount: number;
  hash: string;
}

export interface StayMarketRow {
  cityCode: string;
  name: string;
  snapshotDate: string | null;
  bundleDate: string;
  /** JSON: the city's summary. */
  city: string;
  /** JSON: [[h3, lat, lon, price, pricePerPerson, listings, score], ...]. */
  cells: string;
  /** JSON: the same rows plus the neighbourhood's name. */
  neighbourhoods: string;
  cellCount: number;
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
  hash: string;
}

export interface StayHotelRow {
  id: string;
  areaId: string;
  cityCode: string;
  name: string;
  nameLocal: string | null;
  nameEn: string | null;
  kind: string;
  lat: number;
  lon: number;
  address: string | null;
  website: string | null;
  phone: string | null;
  stars: number | null;
  wikidataQid: string | null;
  confidence: number | null;
  nSources: number;
  areaDistKm: number | null;
  /** JSON: [{ source, sourceId, licence }]. */
  sources: string;
  sourceIds: string[];
  contentHash: string;
  bundleDate: string;
  now: string;
}

export interface StayHotelSourceLink {
  hotelId: string;
  source: string;
  sourceId: string;
  fetchedAt: string;
  licence: string;
}

export interface StayLoadRecord {
  bundleDate: string;
  now: string;
  runDate: string;
  coverageCities: number;
  trippCities: number;
  /** JSON: DataStayView. */
  stay: string;
}

export interface StayLoadView {
  bundleDate: string;
  loadedAt: string;
  runDate: string;
  coverageCities: number;
  trippCities: number;
  stay: unknown;
}

export interface StoredHotel {
  id: string;
  name: string;
  nameLocal: string | null;
  kind: string;
  lat: number;
  lon: number;
  address: string | null;
  website: string | null;
  stars: number | null;
  nSources: number;
  areaDistKm: number | null;
  sources: { source: string; sourceId: string; licence: string }[];
}

export interface StoredMarket {
  cityCode: string;
  name: string;
  snapshotDate: string | null;
  bundleDate: string;
  city: Record<string, unknown> | null;
  /** Compact rows; see StayMarketRow. Only set by `markets`. */
  rows: unknown[][];
}

/** One StayMarket row from the database: JSON properties come back as strings (or already parsed), nulls as null. */
export function shapeMarket(m: Record<string, unknown>, rows: unknown): StoredMarket {
  return {
    cityCode: String(m.cityCode),
    name: String(m.name),
    snapshotDate: str(m.snapshotDate),
    bundleDate: String(m.bundleDate),
    city: parseJson<Record<string, unknown>>(m.city),
    rows: parseJson<unknown[][]>(rows) ?? [],
  };
}

const BATCH = 300;

async function inBatches<T>(rows: T[], run: (batch: T[]) => Promise<unknown>, size = BATCH) {
  for (let i = 0; i < rows.length; i += size) await run(rows.slice(i, i + size));
}

export function stayRepository(db: GraphClient) {
  const q = (name: string) => cypher(`stay-data/${name}`, db.dialect);
  const read = { readOnly: true };

  return {
    // --- the load job -----------------------------------------------------------------------------------

    /** Every Area in the graph with the hash of its stay data (null: none yet). */
    async existingAreas(): Promise<Map<string, string | null>> {
      const rows = await db.query<{ id: string; hash: string | null }>(q("area-existing"), {}, read);
      return new Map(rows.map((r) => [r.id, r.hash ?? null]));
    },

    async existingHotels(): Promise<Map<string, string>> {
      const rows = await db.query<{ id: string; hash: string | null }>(q("hotels-existing"), {}, read);
      return new Map(rows.map((r) => [r.id, r.hash ?? ""]));
    },

    async setAreas(rows: StayAreaRow[]) {
      await inBatches(rows, (batch) => db.query(q("area-set"), { rows: batch }), 50);
    },

    async clearAreas(keep: string[]) {
      await db.query(q("area-clear"), { keep });
    },

    async upsertMarkets(rows: StayMarketRow[], now: string) {
      await inBatches(rows, (batch) => db.query(q("market-upsert"), { rows: batch, now }), 1);
    },

    async pruneMarkets(keep: string[]) {
      await db.query(q("market-prune"), { keep });
    },

    async unlinkHotelAreas(ids: string[]) {
      await inBatches(ids, (batch) => db.query(q("hotels-unlink-area"), { ids: batch }));
    },

    async upsertHotels(rows: StayHotelRow[]) {
      await inBatches(rows, (batch) => db.query(q("hotels-upsert"), { rows: batch }));
    },

    async replaceHotelSources(hotelIds: string[], links: StayHotelSourceLink[]) {
      await inBatches(hotelIds, (batch) => db.query(q("hotels-unlink-sources"), { ids: batch }));
      await inBatches(links, (batch) => db.query(q("hotels-link-sources"), { links: batch }));
    },

    async removeHotels(ids: string[]) {
      await inBatches(ids, (batch) => db.query(q("hotels-remove"), { ids: batch }));
    },

    async recordLoad(record: StayLoadRecord) {
      await db.query(q("load-record"), { ...record });
    },

    // --- the API ----------------------------------------------------------------------------------------

    async latestLoad(): Promise<StayLoadView | null> {
      const rows = await db.query<{ load: Record<string, unknown> }>(q("load-get"), {}, read);
      const l = rows[0]?.load;
      if (!l || l.bundleDate == null) return null;
      return {
        bundleDate: String(l.bundleDate),
        loadedAt: String(l.loadedAt),
        runDate: String(l.runDate),
        coverageCities: num(l.coverageCities),
        trippCities: num(l.trippCities),
        stay: parseJson<unknown>(l.stay),
      };
    },

    /** The Area with its stored stay card; null when the Area does not exist. */
    async areaCard(areaId: string) {
      const rows = await db.query<{ area: Record<string, unknown>; cityCode: string; cityName: string }>(q("area-get"), { areaId }, read);
      const r = rows[0];
      if (!r) return null;
      return {
        id: String(r.area.id),
        name: String(r.area.name),
        radiusKm: optNum(r.area.radiusKm),
        cityCode: r.cityCode,
        cityName: r.cityName,
        stay: parseJson<Record<string, unknown>>(r.area.stay),
        bundleDate: str(r.area.stayBundleDate),
        snapshotDate: str(r.area.staySnapshotDate),
        hotelSuggestions: num(r.area.stayHotelCount),
      };
    },

    /** The city's summary when Inside Airbnb covers it, else null. */
    async cityMarket(cityCode: string) {
      const rows = await db.query<{ market: Record<string, unknown> }>(q("market-city"), { cityCode }, read);
      const m = rows[0]?.market;
      if (!m || m.cityCode == null) return null;
      return {
        cityCode: String(m.cityCode),
        name: String(m.name),
        snapshotDate: str(m.snapshotDate),
        city: parseJson<Record<string, unknown>>(m.city),
      };
    },

    /** Markets (with their compact cell rows) for one city and/or a viewport. */
    async markets(filter: { city?: string; bbox?: { minLon: number; minLat: number; maxLon: number; maxLat: number }; layer: "h3" | "neighbourhood" }): Promise<StoredMarket[]> {
      const rows = await db.query<{ market: Record<string, unknown>; rows: unknown }>(
        q("markets-cells"),
        {
          city: filter.city ?? null,
          layer: filter.layer,
          minLat: filter.bbox?.minLat ?? null,
          maxLat: filter.bbox?.maxLat ?? null,
          minLon: filter.bbox?.minLon ?? null,
          maxLon: filter.bbox?.maxLon ?? null,
        },
        read,
      );
      return rows.map((r) => shapeMarket(r.market, r.rows));
    },

    async hotelsForArea(areaId: string): Promise<StoredHotel[]> {
      const rows = await db.query<{ hotel: Record<string, unknown> }>(q("hotels-for-area"), { areaId }, read);
      return rows.map(({ hotel: h }) => ({
        id: String(h.id),
        name: String(h.name),
        nameLocal: str(h.nameLocal),
        kind: String(h.kind ?? "other"),
        lat: num(h.lat),
        lon: num(h.lon),
        address: str(h.address),
        website: str(h.url),
        stars: optNum(h.stars),
        nSources: num(h.nSources, 1),
        areaDistKm: optNum(h.areaDistKm),
        sources: parseJson<StoredHotel["sources"]>(h.sources) ?? [],
      }));
    },

    async sourceAttributions(ids: string[]): Promise<{ id: string; name: string; attribution: string; licence: string }[]> {
      if (!ids.length) return [];
      const rows = await db.query<{ id: string; name: string; attribution: string | null; licence: string | null }>(q("sources-attribution"), { ids }, read);
      return rows.map((r) => ({ id: r.id, name: r.name, attribution: r.attribution ?? r.name, licence: r.licence ?? "" }));
    },

    /** Open-data hotels per source id, for the Data page. */
    async hotelCountsBySource(): Promise<Map<string, number>> {
      const rows = await db.query<{ source: string; hotels: unknown }>(q("hotels-sources-count"), {}, read);
      return new Map(rows.map((r) => [r.source, num(r.hotels)]));
    },
  };
}

export type StayRepository = ReturnType<typeof stayRepository>;

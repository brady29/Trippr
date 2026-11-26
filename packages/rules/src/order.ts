import { distanceKm } from "./travel";

/**
 * Suggest a better order: the order of stops with the least travel, keeping
 * the first stop first (that's where the trip starts) and skipping any order
 * the caller rules out (one that would move a booking).
 */
export interface OrderStop {
  id: string;
  lat: number;
  lon: number;
}

export interface OrderResult {
  ids: string[];
  km: number;
  /** The current order's travel, for "saves about …". */
  currentKm: number;
}

export function routeKm(stops: readonly OrderStop[]): number {
  let km = 0;
  for (let i = 1; i < stops.length; i++) km += distanceKm(stops[i - 1]!, stops[i]!);
  return km;
}

function* permutations<T>(items: T[]): Generator<T[]> {
  if (items.length <= 1) {
    yield items;
    return;
  }
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const p of permutations(rest)) yield [items[i]!, ...p];
  }
}

/**
 * Exact for up to 8 stops; above that, 2-opt (reverse any stretch that
 * shortens the trip) until nothing improves. `allowed` decides whether an
 * order may be suggested at all; the current order is always allowed.
 */
export function bestOrder(stops: readonly OrderStop[], allowed: (ids: string[]) => boolean = () => true): OrderResult {
  const currentKm = routeKm(stops);
  if (stops.length < 3) return { ids: stops.map((s) => s.id), km: currentKm, currentKm };
  const [first, ...rest] = stops;
  let best = { ids: stops.map((s) => s.id), km: currentKm };

  if (stops.length <= 8) {
    for (const p of permutations(rest)) {
      const order = [first!, ...p];
      const km = routeKm(order);
      if (km < best.km - 1e-6) {
        const ids = order.map((s) => s.id);
        if (allowed(ids)) best = { ids, km };
      }
    }
    return { ...best, currentKm };
  }

  let order = [...stops];
  let improved = true;
  for (let pass = 0; improved && pass < 50; pass++) {
    improved = false;
    for (let i = 1; i < order.length - 1; i++) {
      for (let j = i + 1; j < order.length; j++) {
        const next = [...order.slice(0, i), ...order.slice(i, j + 1).reverse(), ...order.slice(j + 1)];
        const km = routeKm(next);
        if (km < routeKm(order) - 1e-6 && allowed(next.map((s) => s.id))) {
          order = next;
          improved = true;
        }
      }
    }
  }
  return { ids: order.map((s) => s.id), km: routeKm(order), currentKm };
}

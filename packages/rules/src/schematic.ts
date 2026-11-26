/**
 * A schematic line map of a route, like a rail network diagram: stations sit
 * on a grid near where they really are, and the line between two stations
 * only runs straight or at 45°. The same city always lands on the same spot,
 * so two routes drawn together share their stations.
 */
export interface GeoPoint {
  id: string;
  lat: number;
  lon: number;
  /** The label, so it can be placed where it doesn't collide. */
  name?: string;
}

export interface Station {
  id: string;
  x: number;
  y: number;
  /** Which side of the station its label goes. */
  label: "right" | "left" | "above" | "below";
}

export interface LayoutOptions {
  width: number;
  height: number;
  /** Grid spacing in px: stations snap to it. */
  grid?: number;
  /** Room around the edge for labels. */
  margin?: number;
  /**
   * 0 keeps true geography; 1 spaces stations evenly by their east-west and
   * north-south order. Somewhere between keeps the shape but pulls tight
   * clusters (Guangzhou, Shenzhen, Hong Kong) apart, as rail maps do.
   */
  spread?: number;
}

/** Equirectangular projection around the points' mean latitude (good enough at trip scale). */
function project(points: readonly GeoPoint[]) {
  const lat0 = (points.reduce((s, p) => s + p.lat, 0) / Math.max(points.length, 1)) * (Math.PI / 180);
  return points.map((p) => ({ id: p.id, x: p.lon * Math.cos(lat0), y: -p.lat }));
}

/**
 * Places each distinct id on the grid, keeping the shape of the real map:
 * scaled to fit, snapped to the nearest free grid point. Ids that repeat
 * (a city visited twice) get one station.
 */
export function schematicLayout(points: readonly GeoPoint[], { width, height, grid = 24, margin = 56, spread = 0.55 }: LayoutOptions): Station[] {
  const unique = [...new Map(points.map((p) => [p.id, p])).values()];
  if (!unique.length) return [];
  const geo = project(unique);
  // Blend each coordinate with its rank, so order is kept but crowding eases.
  const blend = (vals: number[]) => {
    const min = Math.min(...vals);
    const span = Math.max(...vals) - min || 1;
    const order = [...vals].map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v || a.i - b.i);
    const rank = new Array<number>(vals.length);
    order.forEach((o, r) => (rank[o.i] = vals.length > 1 ? r / (vals.length - 1) : 0.5));
    return vals.map((v, i) => (1 - spread) * ((v - min) / span) + spread * rank[i]!);
  };
  const bx = blend(geo.map((p) => p.x));
  const by = blend(geo.map((p) => p.y));
  const aspect = (Math.max(...geo.map((p) => p.x)) - Math.min(...geo.map((p) => p.x)) || 1) / (Math.max(...geo.map((p) => p.y)) - Math.min(...geo.map((p) => p.y)) || 1);
  const raw = geo.map((p, i) => ({ id: p.id, x: bx[i]! * Math.min(Math.max(aspect, 0.5), 2), y: by[i]! }));
  const xs = raw.map((p) => p.x);
  const ys = raw.map((p) => p.y);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  const innerW = Math.max(grid, width - margin * 2);
  const innerH = Math.max(grid, height - margin * 2);
  const scale = Math.min(innerW / spanX, innerH / spanY);
  // Centre the drawing in the box.
  const offX = margin + (innerW - spanX * scale) / 2;
  const offY = margin + (innerH - spanY * scale) / 2;
  const taken = new Set<string>();
  const key = (gx: number, gy: number) => `${gx},${gy}`;
  const maxGx = Math.floor((width - margin) / grid);
  const maxGy = Math.floor((height - margin) / grid);
  const minG = Math.ceil(margin / grid / 2);

  const out: Station[] = raw.map((p) => {
    const tx = offX + (p.x - minX) * scale;
    const ty = offY + (p.y - minY) * scale;
    let gx = Math.round(tx / grid);
    let gy = Math.round(ty / grid);
    // Nearest free grid point, searching outward ring by ring.
    for (let r = 0; taken.has(key(gx, gy)) && r < 12; r++) {
      let best: [number, number] | null = null;
      let bestD = Infinity;
      for (let dx = -r - 1; dx <= r + 1; dx++) {
        for (let dy = -r - 1; dy <= r + 1; dy++) {
          const cx = Math.round(tx / grid) + dx;
          const cy = Math.round(ty / grid) + dy;
          if (taken.has(key(cx, cy)) || cx < minG || cy < minG || cx > maxGx || cy > maxGy) continue;
          const d = (cx * grid - tx) ** 2 + (cy * grid - ty) ** 2;
          if (d < bestD) {
            bestD = d;
            best = [cx, cy];
          }
        }
      }
      if (best) [gx, gy] = best;
    }
    taken.add(key(gx, gy));
    return { id: p.id, x: gx * grid, y: gy * grid, label: "right" as const };
  });
  placeLabels(out, unique, width, height);
  return out;
}

/** Rough label size for 11px text. */
const labelBox = (st: Station, side: Station["label"], name: string) => {
  const w = name.length * 6.3 + 22;
  const h = 14;
  if (side === "right") return { x: st.x + 10, y: st.y - h / 2, w, h };
  if (side === "left") return { x: st.x - 10 - w, y: st.y - h / 2, w, h };
  if (side === "above") return { x: st.x - w / 2, y: st.y - 10 - h, w, h };
  return { x: st.x - w / 2, y: st.y + 10, w, h };
};
const overlaps = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Puts each label on the first side that stays inside the box and clear of other stations and labels. */
function placeLabels(stations: Station[], points: readonly GeoPoint[], width: number, height: number) {
  const names = new Map(points.map((p) => [p.id, p.name ?? p.id]));
  const placed: { x: number; y: number; w: number; h: number }[] = [];
  const dots = stations.map((s) => ({ x: s.x - 7, y: s.y - 7, w: 14, h: 14 }));
  for (const st of stations) {
    const name = names.get(st.id)!;
    const sides: Station["label"][] = st.x > width * 0.6 ? ["left", "right", "above", "below"] : ["right", "left", "above", "below"];
    let best = sides[0]!;
    let bestScore = Infinity;
    for (const side of sides) {
      const box = labelBox(st, side, name);
      const outside = box.x < 0 || box.y < 0 || box.x + box.w > width || box.y + box.h > height ? 1 : 0;
      const hits = placed.filter((p) => overlaps(p, box)).length + dots.filter((d, i) => stations[i] !== st && overlaps(d, box)).length;
      const score = outside * 10 + hits * 3 + sides.indexOf(side) * 0.1;
      if (score < bestScore) {
        bestScore = score;
        best = side;
      }
    }
    st.label = best;
    placed.push(labelBox(st, best, name));
  }
}

/**
 * The line from a to b in at most two straight pieces at 0°, 45° or 90°:
 * a diagonal for the shorter distance, then straight on. Returns the points
 * to draw through (2 or 3).
 */
export function octilinearPath(a: { x: number; y: number }, b: { x: number; y: number }): { x: number; y: number }[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const diag = Math.min(Math.abs(dx), Math.abs(dy));
  if (diag === 0 || Math.abs(dx) === Math.abs(dy)) return [a, b];
  const corner = { x: a.x + Math.sign(dx) * diag, y: a.y + Math.sign(dy) * diag };
  return [a, corner, b];
}

/** An SVG path through some points with rounded corners (radius r), as rail maps draw them. */
export function roundedPath(points: readonly { x: number; y: number }[], r = 10): string {
  if (points.length < 2) return "";
  let d = `M${points[0]!.x},${points[0]!.y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i - 1]!;
    const c = points[i]!;
    const n = points[i + 1]!;
    const inLen = Math.hypot(c.x - p.x, c.y - p.y);
    const outLen = Math.hypot(n.x - c.x, n.y - c.y);
    const rr = Math.min(r, inLen / 2, outLen / 2);
    const a = { x: c.x - ((c.x - p.x) / inLen) * rr, y: c.y - ((c.y - p.y) / inLen) * rr };
    const b = { x: c.x + ((n.x - c.x) / outLen) * rr, y: c.y + ((n.y - c.y) / outLen) * rr };
    d += ` L${a.x.toFixed(1)},${a.y.toFixed(1)} Q${c.x},${c.y} ${b.x.toFixed(1)},${b.y.toFixed(1)}`;
  }
  const last = points[points.length - 1]!;
  return `${d} L${last.x},${last.y}`;
}

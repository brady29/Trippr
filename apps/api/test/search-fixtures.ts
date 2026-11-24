import { place } from "./bundle-kit";

/**
 * The places search.test.ts loads. Their names are chosen so the load job's adoption rule (same city, same name,
 * within 500 m of a pinned idea) never matches one of the seed's hand-written activities: an adopted place keeps
 * the idea's id, so its `cat-...` id would not exist in the graph. search-unit.test.ts runs the real plan over
 * the real seed to prove it, so a seed change that collides fails there with the names, not here with wrong ids.
 * (The seed has "Osaka Castle" as act-osa-castle, which is why the castle below is not called that.)
 */
export const P = {
  ramen: place({ name: "Ichiran Ramen", city_code: "TYO", category: "restaurant", tag: "food", rank: 1, lat: 35.659, lon: 139.7 }),
  shrine: place({ name: "Meiji Shrine", city_code: "TYO", category: "temple_shrine", tag: "culture", rank: 2, lat: 35.676, lon: 139.699 }),
  tower: place({ name: "Sky Tower Observation Deck", city_code: "TYO", category: "viewpoint", tag: "nature", rank: 3, lat: 35.71, lon: 139.81 }),
  garden: place({ name: "Quiet Moss Garden", city_code: "OSA", category: "park", tag: "nature", rank: 1, lat: 34.69, lon: 135.52 }),
  fortress: place({ name: "Sakura Fortress Keep", city_code: "OSA", category: "castle_palace", tag: "culture", rank: 2, lat: 34.687, lon: 135.526 }),
  // Has no vector: found by its words only.
  alley: place({ name: "Hidden Ramen Alley", city_code: "TYO", category: "restaurant", tag: "food", rank: 9, lat: 35.66, lon: 139.71 }),
};
export const PLACES = Object.values(P);

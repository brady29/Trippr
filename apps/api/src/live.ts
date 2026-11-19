import { randomUUID } from "node:crypto";

/** What a write changed, so open clients refetch only what they need. */
export type LiveChange =
  | { kind: "route"; routeId: string }
  | { kind: "trip" }
  | { kind: "activities" }
  | { kind: "members" }
  | { kind: "inbox" };

export interface LivePresence {
  id: string;
  name: string;
}

interface Client {
  id: string;
  user: LivePresence;
  send(event: string, data: unknown): void;
  close(): void;
}

/**
 * In-memory fan-out of trip changes to connected browsers (server-sent
 * events). Cloud Run runs a single instance (max-instances 1), so one
 * process sees every write; a multi-instance deploy would need Redis
 * pub/sub (FalkorDB already speaks it) behind the same interface.
 */
export class LiveHub {
  private readonly trips = new Map<string, Set<Client>>();

  connect(tripId: string, user: LivePresence, sink: { write(chunk: string): void; end(): void }) {
    const client: Client = {
      id: randomUUID(),
      user,
      send: (event, data) => sink.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
      close: () => sink.end(),
    };
    const set = this.trips.get(tripId) ?? new Set<Client>();
    set.add(client);
    this.trips.set(tripId, set);
    this.broadcastPresence(tripId);
    return () => {
      set.delete(client);
      if (set.size === 0) this.trips.delete(tripId);
      else this.broadcastPresence(tripId);
    };
  }

  /** Everyone currently connected to the trip, one entry per person. */
  presence(tripId: string): LivePresence[] {
    const seen = new Map<string, LivePresence>();
    for (const c of this.trips.get(tripId) ?? []) seen.set(c.user.id, c.user);
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  publish(tripId: string, change: LiveChange, by: string) {
    for (const c of this.trips.get(tripId) ?? []) c.send("change", { ...change, by });
  }

  connections(tripId: string) {
    return this.trips.get(tripId)?.size ?? 0;
  }

  closeAll() {
    for (const set of this.trips.values()) for (const c of set) c.close();
    this.trips.clear();
  }

  private broadcastPresence(tripId: string) {
    const people = this.presence(tripId);
    for (const c of this.trips.get(tripId) ?? []) c.send("presence", people);
  }
}

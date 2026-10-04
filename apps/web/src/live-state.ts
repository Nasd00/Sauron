import type { Camera, Incident, Observation, Watch } from "@tempmhacks/shared";

export class LiveState {
  readonly cameras = new Map<string, Camera>();
  readonly incidents = new Map<string, Incident>();
  readonly observations = new Map<string, Observation>();
  readonly watches = new Map<string, Watch>();
  #listeners = new Set<() => void>();
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }
  update(table: "cameras", row: Camera, deleted?: boolean): void;
  update(table: "incidents", row: Incident, deleted?: boolean): void;
  update(table: "observations", row: Observation, deleted?: boolean): void;
  update(table: "watches", row: Watch, deleted?: boolean): void;
  update(table: "cameras" | "incidents" | "observations" | "watches", row: Camera | Incident | Observation | Watch, deleted = false): void {
    const rows = this[table] as Map<string, typeof row>;
    if (deleted) rows.delete(row.id);
    else rows.set(row.id, row);
    for (const listener of this.#listeners) listener();
  }
  activeWatches(): Watch[] {
    return [...this.watches.values()]
      .filter(row => row.active)
      .sort((a, b) => b.createdAt - a.createdAt);
  }
  activeIncidents(): Incident[] {
    return [...this.incidents.values()]
      .filter(row => row.status === "candidate" || row.status === "confirmed")
      .sort((a, b) => Number(b.status === "confirmed") - Number(a.status === "confirmed") || b.lastSeenAt - a.lastSeenAt);
  }
  latestEvidence(cameraId: string): Observation | undefined {
    return [...this.observations.values()].filter(row => row.cameraId === cameraId && row.evidenceUrl)
      .sort((a, b) => b.timestamp - a.timestamp)[0];
  }
}

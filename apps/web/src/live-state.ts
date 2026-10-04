import type { Camera, Incident, IncidentReport, IncidentView, Observation, UserAlertProfile, Watch } from "@tempmhacks/shared";

type Row = Camera | Incident | Observation | Watch | IncidentReport | UserAlertProfile;
const keyOf = (row: Row): string =>
  "incidentId" in row && !("id" in row) ? row.incidentId : "userId" in row ? row.userId : (row as { id: string }).id;

export class LiveState {
  readonly cameras = new Map<string, Camera>();
  readonly incidents = new Map<string, Incident>();
  readonly observations = new Map<string, Observation>();
  readonly watches = new Map<string, Watch>();
  /** Operator reports for manual incidents, keyed by incidentId. */
  readonly reports = new Map<string, IncidentReport>();
  /** Current-location profiles, keyed by userId; used to estimate who a report will reach. */
  readonly profiles = new Map<string, UserAlertProfile>();
  #listeners = new Set<() => void>();
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }
  update(table: "cameras", row: Camera, deleted?: boolean): void;
  update(table: "incidents", row: Incident, deleted?: boolean): void;
  update(table: "observations", row: Observation, deleted?: boolean): void;
  update(table: "watches", row: Watch, deleted?: boolean): void;
  update(table: "reports", row: IncidentReport, deleted?: boolean): void;
  update(table: "profiles", row: UserAlertProfile, deleted?: boolean): void;
  update(table: "cameras" | "incidents" | "observations" | "watches" | "reports" | "profiles", row: Row, deleted = false): void {
    const rows = this[table] as Map<string, Row>;
    if (deleted) rows.delete(keyOf(row));
    else rows.set(keyOf(row), row);
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
  /** The incident with its operator report, if it was reported by hand. */
  view(id: string): IncidentView | undefined {
    const incident = this.incidents.get(id);
    if (!incident) return undefined;
    const report = this.reports.get(id);
    return report ? { ...incident, report } : incident;
  }
  /** Confirmed incidents with reports attached: what people are being warned about right now. */
  confirmedViews(): IncidentView[] {
    return this.activeIncidents().filter(row => row.status === "confirmed").map(row => this.view(row.id)!);
  }
  latestEvidence(cameraId: string): Observation | undefined {
    return [...this.observations.values()].filter(row => row.cameraId === cameraId && row.evidenceUrl)
      .sort((a, b) => b.timestamp - a.timestamp)[0];
  }
}

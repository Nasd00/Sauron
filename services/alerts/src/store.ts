import type { Alert, Incident, Watch } from "@tempmhacks/shared";
import type { Db } from "@tempmhacks/shared/db";
import type { AlertMatcherStore } from "./matcher.js";
import type { PendingAlertStore } from "./sender.js";

export type AlertServiceStore = AlertMatcherStore & PendingAlertStore & {
  listPending(): Alert[];
};

export function createAlertServiceStore(db: Db): AlertServiceStore {
  return {
    listActiveWatches: async () => db.watches.listActive(),
    createAlert: async (incidentId, watchId) => {
      try {
        await db.alerts.create(incidentId, watchId);
        return true;
      } catch (error) {
        if (error instanceof Error && error.message.includes("already exists")) return false;
        throw error;
      }
    },
    claimAlert: async alertId => {
      try {
        await db.alerts.claim(alertId);
        return true;
      } catch (error) {
        if (error instanceof Error && /Cannot claim (sending|sent|failed)/.test(error.message)) return false;
        throw error;
      }
    },
    getIncident: async incidentId => db.incidents.get(incidentId),
    getWatch: async watchId => db.watches.get(watchId),
    markSent: (alertId, providerMessageId, sentAt) => db.alerts.markSent(alertId, providerMessageId, sentAt),
    markFailed: (alertId, error) => db.alerts.markFailed(alertId, error),
    listPending: () => db.alerts.listPending(),
  };
}

export class MemoryAlertStore implements AlertServiceStore {
  readonly watches = new Map<string, Watch>();
  readonly incidents = new Map<string, Incident>();
  readonly alerts = new Map<string, Alert>();

  async listActiveWatches(): Promise<Watch[]> {
    return Array.from(this.watches.values()).filter(watch => watch.active);
  }

  async createAlert(incidentId: string, watchId: string): Promise<boolean> {
    const id = `${incidentId}:${watchId}`;
    if (this.alerts.has(id)) return false;
    this.alerts.set(id, { id, incidentId, watchId, status: "pending", createdAt: 1000 });
    return true;
  }

  async claimAlert(alertId: string): Promise<boolean> {
    const alert = this.alerts.get(alertId);
    if (!alert || alert.status !== "pending") return false;
    alert.status = "sending";
    return true;
  }

  async getIncident(incidentId: string): Promise<Incident | undefined> {
    return this.incidents.get(incidentId);
  }

  async getWatch(watchId: string): Promise<Watch | undefined> {
    return this.watches.get(watchId);
  }

  async markSent(alertId: string, providerMessageId: string, sentAt: number): Promise<void> {
    const alert = this.alerts.get(alertId);
    if (!alert || alert.status !== "sending") throw new Error("Alert is not claimed");
    Object.assign(alert, { status: "sent", providerMessageId, sentAt });
  }

  async markFailed(alertId: string, error: string): Promise<void> {
    const alert = this.alerts.get(alertId);
    if (!alert || alert.status !== "sending") throw new Error("Alert is not claimed");
    Object.assign(alert, { status: "failed", error });
  }

  listPending(): Alert[] {
    return Array.from(this.alerts.values()).filter(alert => alert.status === "pending");
  }
}

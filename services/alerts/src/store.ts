import type { Alert, Incident, MobileDevice, UserAlertProfile, Watch } from "@tempmhacks/shared";
import type { Db } from "@tempmhacks/shared/db";
import type { AlertMatcherStore, ProfileAlertMatcherStore } from "./matcher.js";
import type { PendingAlertStore } from "./sender.js";

export type AlertServiceStore = AlertMatcherStore & ProfileAlertMatcherStore & PendingAlertStore & {
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
    listProfiles: async () => db.profiles.list(),
    listMobileDevices: async () => db.mobile.listDevices(),
    createProfileAlert: async (incidentId, userId) => {
      try {
        await db.alerts.createForProfile(incidentId, userId);
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
    getTarget: async targetId => {
      const profileId = parseProfileTarget(targetId);
      if (profileId !== undefined) {
        const profile = db.profiles.get(profileId);
        return profile ? profileTarget(profile) : undefined;
      }
      const watch = db.watches.get(targetId);
      return watch ? watchTarget(watch) : undefined;
    },
    markSent: (alertId, providerMessageId, sentAt) => db.alerts.markSent(alertId, providerMessageId, sentAt),
    markFailed: (alertId, error) => db.alerts.markFailed(alertId, error),
    recordAlertContext: (spaceId, incidentId, alertedAt) => db.conversationContexts.upsert({
      spaceId, activeIncidentId: incidentId, alertedAt, updatedAt: alertedAt,
    }),
    listPending: () => db.alerts.listPending(),
  };
}

/** Returns the userId when `targetId` is a profile target, else undefined. */
export function parseProfileTarget(targetId: string): string | undefined {
  return targetId.startsWith("profile:") ? targetId.slice("profile:".length) : undefined;
}

/** Resolved delivery target shared by watch- and profile-sourced alerts. */
export type AlertTarget = {
  spaceId: string;
  latitude: number;
  longitude: number;
  /** Human-readable place label ("Ann Arbor") or undefined for raw-location profiles. */
  placeLabel?: string;
  radiusKm: number;
  /** For profiles: freshness anchor. Undefined for place-based watches. */
  locationUpdatedAt?: number;
};

export function watchTarget(watch: Watch): AlertTarget {
  return {
    spaceId: watch.spaceId, latitude: watch.latitude, longitude: watch.longitude,
    placeLabel: watch.placeLabel, radiusKm: watch.radiusKm,
  };
}

export function profileTarget(profile: UserAlertProfile): AlertTarget {
  return {
    spaceId: profile.spaceId, latitude: profile.latitude, longitude: profile.longitude,
    radiusKm: profile.radiusKm, locationUpdatedAt: profile.locationUpdatedAt,
  };
}

export class MemoryAlertStore implements AlertServiceStore {
  readonly watches = new Map<string, Watch>();
  readonly profiles = new Map<string, UserAlertProfile>();
  readonly devices: MobileDevice[] = [];
  readonly incidents = new Map<string, Incident>();
  readonly alerts = new Map<string, Alert>();
  readonly contexts = new Map<string, { spaceId: string; activeIncidentId: string; alertedAt: number }>();

  async listActiveWatches(): Promise<Watch[]> {
    return Array.from(this.watches.values()).filter(watch => watch.active);
  }

  async createAlert(incidentId: string, watchId: string): Promise<boolean> {
    const id = `${incidentId}:${watchId}`;
    if (this.alerts.has(id)) return false;
    this.alerts.set(id, { id, incidentId, watchId, status: "pending", createdAt: 1000 });
    return true;
  }

  async listProfiles(): Promise<UserAlertProfile[]> {
    return Array.from(this.profiles.values());
  }

  async listMobileDevices(): Promise<MobileDevice[]> {
    return this.devices;
  }

  async createProfileAlert(incidentId: string, userId: string): Promise<boolean> {
    const targetId = `profile:${userId}`;
    const id = `${incidentId}:${targetId}`;
    if (this.alerts.has(id)) return false;
    this.alerts.set(id, { id, incidentId, watchId: targetId, status: "pending", createdAt: 1000 });
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

  async getTarget(targetId: string): Promise<AlertTarget | undefined> {
    const profileId = parseProfileTarget(targetId);
    if (profileId !== undefined) {
      const profile = this.profiles.get(profileId);
      return profile ? profileTarget(profile) : undefined;
    }
    const watch = this.watches.get(targetId);
    return watch ? watchTarget(watch) : undefined;
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

  async recordAlertContext(spaceId: string, incidentId: string, alertedAt: number): Promise<void> {
    this.contexts.set(spaceId, { spaceId, activeIncidentId: incidentId, alertedAt });
  }

  listPending(): Alert[] {
    return Array.from(this.alerts.values()).filter(alert => alert.status === "pending");
  }
}

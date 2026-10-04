import type { Db } from "@tempmhacks/shared/db";
import type {
  Camera, ConversationContext, Incident, InboundReceipt, MobileDevice, Observation, UserAlertProfile, Watch,
} from "@tempmhacks/shared";
import { haversineDistanceKm } from "@tempmhacks/shared/geo";
import type { InboundMessage, MessagingStore } from "./types.js";

function receiptOf(message: InboundMessage): InboundReceipt {
  const receivedAt = Date.parse(message.receivedAt);
  if (!Number.isSafeInteger(receivedAt) || receivedAt < 0) {
    throw new Error(`Invalid inbound timestamp: ${message.receivedAt}`);
  }
  return {
    messageId: message.messageId,
    spaceId: message.spaceId,
    senderId: message.senderId,
    receivedAt,
    contentType: message.content.type,
  };
}

export function createMessagingStore(db: Db): MessagingStore {
  return {
    claimInbound: message => db.inbound.claim(receiptOf(message)),
    getActiveWatch: async senderId => db.watches.getActiveForSender(senderId),
    replaceWatch: watch => db.watches.create(watch),
    deactivateWatches: senderId => db.watches.stopForSender(senderId),

    getProfileForSender: async senderId => db.profiles.getForSender(senderId),
    upsertProfile: profile => db.profiles.upsert(profile),
    setAlertsEnabled: (userId, alertsEnabled) => db.profiles.setAlertsEnabled(userId, alertsEnabled),

    getConversationContext: async spaceId => db.conversationContexts.get(spaceId),
    upsertConversationContext: context => db.conversationContexts.upsert(context),
    clearConversationContext: async spaceId => {
      const existing = db.conversationContexts.get(spaceId);
      await db.conversationContexts.upsert({
        spaceId,
        activeIncidentId: undefined,
        lastCameraId: undefined,
        lastIntent: undefined,
        alertedAt: existing?.alertedAt,
        updatedAt: Date.now(),
      });
    },
    getIncident: async incidentId => db.incidents.get(incidentId),
    getCamera: async cameraId => db.cameras.get(cameraId),
    getLatestObservation: async cameraId => db.observations.latestForCamera(cameraId),
    countOtherNearbyCameras: async (cameraId, latitude, longitude, radiusKm) =>
      db.cameras.list().filter(camera =>
        camera.id !== cameraId &&
        camera.status === "online" &&
        haversineDistanceKm(latitude, longitude, camera.latitude, camera.longitude) <= radiusKm,
      ).length,
    getMobileDevice: async senderId => db.mobile.getActiveDeviceForSender(senderId),
    createMobilePairing: input => db.mobile.createPairing(input),
    setMobileTracking: (senderId, active) => db.mobile.setTrackingForSender(senderId, active),
  };
}

export class MemoryMessagingStore implements MessagingStore {
  readonly messageIds = new Set<string>();
  readonly watches: Watch[] = [];
  readonly profiles: UserAlertProfile[] = [];
  readonly contexts = new Map<string, ConversationContext>();
  readonly incidents = new Map<string, Incident>();
  readonly cameras = new Map<string, Camera>();
  readonly observations: Observation[] = [];
  readonly devices: MobileDevice[] = [];
  readonly pairings: { tokenHash: string; userId: string; spaceId: string; senderId: string }[] = [];

  async getMobileDevice(senderId: string): Promise<MobileDevice | undefined> {
    return this.devices.find(device => device.senderId === senderId && !device.revoked);
  }

  async createMobilePairing(input: { tokenHash: string; userId: string; spaceId: string; senderId: string }): Promise<void> {
    this.pairings.push(input);
  }

  async setMobileTracking(senderId: string, active: boolean): Promise<void> {
    for (const device of this.devices) {
      if (device.senderId === senderId && !device.revoked) device.trackingActive = active;
    }
  }

  async claimInbound(message: InboundMessage): Promise<boolean> {
    if (this.messageIds.has(message.messageId)) return false;
    this.messageIds.add(message.messageId);
    return true;
  }

  async getActiveWatch(senderId: string): Promise<Watch | undefined> {
    return this.watches.find(watch => watch.senderId === senderId && watch.active);
  }

  async replaceWatch(watch: Watch): Promise<void> {
    for (const existing of this.watches) {
      if (existing.senderId === watch.senderId) existing.active = false;
    }
    this.watches.push({ ...watch, active: true });
  }

  async deactivateWatches(senderId: string): Promise<void> {
    for (const watch of this.watches) if (watch.senderId === senderId) watch.active = false;
  }

  async getProfileForSender(senderId: string): Promise<UserAlertProfile | undefined> {
    return this.profiles.find(profile => profile.senderId === senderId);
  }

  async upsertProfile(profile: UserAlertProfile): Promise<void> {
    const index = this.profiles.findIndex(existing => existing.userId === profile.userId);
    if (index >= 0) this.profiles[index] = profile;
    else this.profiles.push(profile);
  }

  async setAlertsEnabled(userId: string, alertsEnabled: boolean): Promise<void> {
    const profile = this.profiles.find(existing => existing.userId === userId);
    if (profile) profile.alertsEnabled = alertsEnabled;
  }

  async getConversationContext(spaceId: string): Promise<ConversationContext | undefined> {
    return this.contexts.get(spaceId);
  }

  async upsertConversationContext(context: ConversationContext): Promise<void> {
    this.contexts.set(context.spaceId, context);
  }

  async clearConversationContext(spaceId: string): Promise<void> {
    const existing = this.contexts.get(spaceId);
    this.contexts.set(spaceId, {
      spaceId,
      activeIncidentId: undefined,
      lastCameraId: undefined,
      lastIntent: undefined,
      alertedAt: existing?.alertedAt,
      updatedAt: Date.now(),
    });
  }

  async getIncident(incidentId: string): Promise<Incident | undefined> {
    return this.incidents.get(incidentId);
  }

  async getCamera(cameraId: string): Promise<Camera | undefined> {
    return this.cameras.get(cameraId);
  }

  async getLatestObservation(cameraId: string): Promise<Observation | undefined> {
    return this.observations
      .filter(observation => observation.cameraId === cameraId)
      .sort((a, b) => b.timestamp - a.timestamp)[0];
  }

  async countOtherNearbyCameras(
    cameraId: string, latitude: number, longitude: number, radiusKm: number,
  ): Promise<number> {
    return Array.from(this.cameras.values()).filter(camera =>
      camera.id !== cameraId &&
      camera.status === "online" &&
      haversineDistanceKm(latitude, longitude, camera.latitude, camera.longitude) <= radiusKm,
    ).length;
  }
}

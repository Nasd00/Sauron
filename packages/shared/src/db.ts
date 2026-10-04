import type {
  AlertRow, CameraRow, GeneratedDbConnection, IncidentRow, ObservationRow, RowCallback,
  WatchRow, UserAlertProfileRow, ConversationContextRow, MobileDeviceRow, IncidentReportRow,
} from "@tempmhacks/db-generated";
import { DbConnection } from "@tempmhacks/db-generated";
import type {
  Alert, Camera, Incident, InboundReceipt, Observation, Watch,
  UserAlertProfile, ConversationContext, MobileDevice, IncidentReport, IncidentView,
} from "./types.js";

/** Body of an operator's manual report; the reducer confirms it on insert. */
export type ReportIncidentInput = {
  id: string; type: string; latitude: number; longitude: number; radiusKm: number;
  title: string; description: string; reportedBy: string;
};

export type Subscription<Row> = (callback: RowCallback<Row>) => () => void;

function subscribe<Row>(table: {
  onInsert(callback: (context: unknown, row: Row) => void): void;
  removeOnInsert(callback: (context: unknown, row: Row) => void): void;
  onUpdate(callback: (context: unknown, oldRow: Row, newRow: Row) => void): void;
  removeOnUpdate(callback: (context: unknown, oldRow: Row, newRow: Row) => void): void;
  onDelete(callback: (context: unknown, row: Row) => void): void;
  removeOnDelete(callback: (context: unknown, row: Row) => void): void;
}): Subscription<Row> {
  return callback => {
    const onInsert = (_context: unknown, row: Row) => callback(row);
    const onUpdate = (_context: unknown, _oldRow: Row, newRow: Row) => callback(newRow);
    const onDelete = (_context: unknown, row: Row) => callback(row);
    table.onInsert(onInsert);
    table.onUpdate(onUpdate);
    table.onDelete(onDelete);
    return () => {
      table.removeOnInsert(onInsert);
      table.removeOnUpdate(onUpdate);
      table.removeOnDelete(onDelete);
    };
  };
}

function toCamera(row: CameraRow): Camera {
  return { ...row, sourceType: row.sourceType as Camera["sourceType"], status: row.status as Camera["status"] };
}

function toObservation(row: ObservationRow): Observation {
  return { ...row, type: row.type as Observation["type"] };
}

function toIncident(row: IncidentRow): Incident {
  return { ...row, type: row.type as Incident["type"], status: row.status as Incident["status"] };
}

function toWatch(row: WatchRow): Watch {
  return { ...row } as Watch;
}

function toAlert(row: AlertRow): Alert {
  return { ...row, status: row.status as Alert["status"] };
}

function toUserAlertProfile(row: UserAlertProfileRow): UserAlertProfile {
  return { ...row };
}

function toConversationContext(row: ConversationContextRow): ConversationContext {
  return { ...row };
}

function toMobileDevice(row: MobileDeviceRow): MobileDevice {
  return { ...row };
}

function toIncidentReport(row: IncidentReportRow): IncidentReport {
  return { ...row };
}

export type Db = {
  cameras: {
    subscribe(callback: RowCallback<Camera>): () => void;
    get(id: string): Camera | undefined;
    list(): Camera[];
    register(camera: Camera): Promise<void>;
    setStatus(id: string, status: Camera["status"], lastSeenAt: number): Promise<void>;
  };
  observations: {
    subscribe(callback: RowCallback<Observation>): () => void;
    latestForCamera(cameraId: string): Observation | undefined;
    publish(observation: Observation): Promise<void>;
  };
  incidents: {
    subscribe(callback: RowCallback<Incident>): () => void;
    get(id: string): Incident | undefined;
    list(): Incident[];
    listConfirmed(): Incident[];
    create(incident: Incident): Promise<void>;
    updateDetection(id: string, confidence: number, lastSeenAt: number): Promise<void>;
    confirm(id: string): Promise<void>;
    dismiss(id: string): Promise<void>;
    resolve(id: string, resolvedAt?: number): Promise<void>;
    /** Operator-only: create a confirmed, manually reported incident. */
    report(input: ReportIncidentInput): Promise<void>;
    /** The incident with its manual report, if any. */
    view(id: string): IncidentView | undefined;
  };
  reports: {
    subscribe(callback: RowCallback<IncidentReport>): () => void;
    get(incidentId: string): IncidentReport | undefined;
    list(): IncidentReport[];
  };
  alerts: {
    subscribe(callback: RowCallback<Alert>): () => void;
    listPending(): Alert[];
    /** Every alert for one incident, any status. */
    listForIncident(incidentId: string): Alert[];
    create(incidentId: string, watchId: string): Promise<void>;
    createForProfile(incidentId: string, userId: string): Promise<void>;
    claim(id: string): Promise<void>;
    markSent(id: string, providerMessageId: string, sentAt?: number): Promise<void>;
    markFailed(id: string, error: string): Promise<void>;
  };
  watches: {
    subscribe(callback: RowCallback<Watch>): () => void;
    listActive(): Watch[];
    get(id: string): Watch | undefined;
    getActiveForSender(senderId: string): Watch | undefined;
    create(watch: Watch): Promise<void>;
    stopForSender(senderId: string): Promise<void>;
  };
  inbound: {
    claim(receipt: InboundReceipt): Promise<boolean>;
  };
  profiles: {
    list(): UserAlertProfile[];
    get(userId: string): UserAlertProfile | undefined;
    getForSender(senderId: string): UserAlertProfile | undefined;
    upsert(profile: UserAlertProfile): Promise<void>;
    setAlertsEnabled(userId: string, alertsEnabled: boolean, updatedAt?: number): Promise<void>;
  };
  conversationContexts: {
    get(spaceId: string): ConversationContext | undefined;
    upsert(context: ConversationContext): Promise<void>;
  };
  /** Sauron iPhone companion app. Token arguments are SHA-256 hex hashes, never raw tokens. */
  mobile: {
    listDevices(): MobileDevice[];
    getDevice(deviceId: string): MobileDevice | undefined;
    /** The sender's current (non-revoked) paired device, if any. */
    getActiveDeviceForSender(senderId: string): MobileDevice | undefined;
    createPairing(input: { tokenHash: string; userId: string; spaceId: string; senderId: string }): Promise<void>;
    redeemPairing(input: { pairingTokenHash: string; credentialTokenHash: string; deviceId: string }): Promise<void>;
    updateLocation(input: {
      credentialTokenHash: string; latitude: number; longitude: number;
      accuracyMeters: number; capturedAt: number; defaultRadiusKm: number;
    }): Promise<void>;
    setSharing(credentialTokenHash: string, enabled: boolean): Promise<void>;
    /** Throws device_unauthorized unless the credential belongs to this device. */
    checkCredential(credentialTokenHash: string, deviceId: string): Promise<void>;
    setTrackingForSender(senderId: string, active: boolean): Promise<void>;
    revokeDevice(deviceId: string): Promise<void>;
  };
};

export function createDb(connection: GeneratedDbConnection): Db {
  const getIncident = (id: string): Incident | undefined => {
    for (const row of connection.db.incident.iter()) if (row.id === id) return toIncident(row);
    return undefined;
  };
  const getReport = (incidentId: string): IncidentReport | undefined => {
    // Older deployments may not have the table yet.
    const table = connection.db.incident_report;
    if (!table) return undefined;
    for (const row of table.iter()) if (row.incidentId === incidentId) return toIncidentReport(row);
    return undefined;
  };
  return {
    cameras: {
      subscribe: callback => subscribe(connection.db.camera)(row => callback(toCamera(row))),
      get: id => {
        for (const row of connection.db.camera.iter()) if (row.id === id) return toCamera(row);
        return undefined;
      },
      list: () => Array.from(connection.db.camera.iter(), toCamera),
      register: camera => connection.reducers.registerCamera({ camera }),
      setStatus: (id, status, lastSeenAt) => connection.reducers.setCameraStatus({
        cameraId: id, status, lastSeenAt,
      }),
    },
    observations: {
      subscribe: callback => subscribe(connection.db.observation)(row => callback(toObservation(row))),
      latestForCamera: cameraId => {
        let latest: Observation | undefined;
        for (const row of connection.db.observation.iter()) {
          if (row.cameraId !== cameraId) continue;
          const observation = toObservation(row);
          if (!latest || observation.timestamp > latest.timestamp) latest = observation;
        }
        return latest;
      },
      publish: observation => connection.reducers.publishObservation({ observation }),
    },
    incidents: {
      subscribe: callback => subscribe(connection.db.incident)(row => callback(toIncident(row))),
      get: getIncident,
      list: () => Array.from(connection.db.incident.iter(), toIncident),
      listConfirmed: () => Array.from(connection.db.incident.iter(), toIncident)
        .filter(incident => incident.status === "confirmed"),
      create: incident => connection.reducers.createIncident({ input: incident }),
      updateDetection: (id, confidence, lastSeenAt) =>
        connection.reducers.updateIncidentDetection({ id, confidence, lastSeenAt }),
      confirm: id => connection.reducers.confirmIncident({ id, confirmedAt: Date.now() }),
      dismiss: id => connection.reducers.dismissIncident({ id }),
      resolve: (id, resolvedAt = Date.now()) => connection.reducers.resolveIncident({ id, resolvedAt }),
      report: input => connection.reducers.reportIncident(input),
      view: id => {
        const incident = getIncident(id);
        if (!incident) return undefined;
        const report = getReport(id);
        return report ? { ...incident, report } : incident;
      },
    },
    reports: {
      subscribe: callback => connection.db.incident_report
        ? subscribe(connection.db.incident_report)(row => callback(toIncidentReport(row)))
        : () => undefined,
      get: getReport,
      list: () => connection.db.incident_report ? Array.from(connection.db.incident_report.iter(), toIncidentReport) : [],
    },
    alerts: {
      subscribe: callback => subscribe(connection.db.alert)(row => callback(toAlert(row))),
      listPending: () => Array.from(connection.db.alert.iter(), toAlert).filter(alert => alert.status === "pending"),
      listForIncident: incidentId => Array.from(connection.db.alert.iter(), toAlert).filter(alert => alert.incidentId === incidentId),
      create: (incidentId, watchId) => connection.reducers.createAlert({ incidentId, watchId }),
      createForProfile: (incidentId, userId) =>
        connection.reducers.createAlertForProfile({ incidentId, userId }),
      claim: alertId => connection.reducers.claimAlert({ alertId }),
      markSent: (alertId, providerMessageId, sentAt = Date.now()) =>
        connection.reducers.markAlertSent({ alertId, providerMessageId, sentAt }),
      markFailed: (alertId, error) => connection.reducers.markAlertFailed({ alertId, error }),
    },
    watches: {
      subscribe: callback => subscribe(connection.db.watch)(row => callback(toWatch(row))),
      listActive: () => Array.from(connection.db.watch.iter(), toWatch).filter(watch => watch.active),
      get: id => {
        for (const row of connection.db.watch.iter()) if (row.id === id) return toWatch(row);
        return undefined;
      },
      getActiveForSender: senderId => Array.from(connection.db.watch.iter(), toWatch)
        .find(watch => watch.active && watch.senderId === senderId),
      create: watch => connection.reducers.createWatch({ input: { ...watch, active: true } }),
      stopForSender: senderId => connection.reducers.deactivateWatchesForSender({ senderId }),
    },
    inbound: {
      claim: async receipt => {
        try {
          await connection.reducers.claimInboundMessage({ receipt });
          return true;
        } catch (error) {
          if (error instanceof Error && error.message.includes("already claimed")) return false;
          throw error;
        }
      },
    },
    profiles: {
      list: () => Array.from(connection.db.user_alert_profile.iter(), toUserAlertProfile),
      get: userId => {
        for (const row of connection.db.user_alert_profile.iter()) {
          if (row.userId === userId) return toUserAlertProfile(row);
        }
        return undefined;
      },
      getForSender: senderId => {
        for (const row of connection.db.user_alert_profile.iter()) {
          if (row.senderId === senderId) return toUserAlertProfile(row);
        }
        return undefined;
      },
      upsert: profile => connection.reducers.upsertUserAlertProfile({ input: profile }),
      setAlertsEnabled: (userId, alertsEnabled, updatedAt = Date.now()) =>
        connection.reducers.setAlertsEnabled({ userId, alertsEnabled, updatedAt }),
    },
    conversationContexts: {
      get: spaceId => {
        for (const row of connection.db.conversation_context.iter()) {
          if (row.spaceId === spaceId) return toConversationContext(row);
        }
        return undefined;
      },
      upsert: context => connection.reducers.upsertConversationContext({ input: context }),
    },
    mobile: {
      listDevices: () => Array.from(connection.db.mobile_device.iter(), toMobileDevice),
      getDevice: deviceId => {
        for (const row of connection.db.mobile_device.iter()) {
          if (row.deviceId === deviceId) return toMobileDevice(row);
        }
        return undefined;
      },
      getActiveDeviceForSender: senderId => {
        for (const row of connection.db.mobile_device.iter()) {
          if (row.senderId === senderId && !row.revoked) return toMobileDevice(row);
        }
        return undefined;
      },
      createPairing: input => connection.reducers.createMobilePairing(input),
      redeemPairing: input => connection.reducers.redeemMobilePairing(input),
      updateLocation: input => connection.reducers.mobileUpdateLocation(input),
      setSharing: (credentialTokenHash, enabled) =>
        connection.reducers.mobileSetSharing({ credentialTokenHash, enabled }),
      checkCredential: (credentialTokenHash, deviceId) =>
        connection.reducers.mobileCheckCredential({ credentialTokenHash, deviceId }),
      setTrackingForSender: (senderId, active) =>
        connection.reducers.setMobileTrackingForSender({ senderId, active }),
      revokeDevice: deviceId => connection.reducers.revokeMobileDevice({ deviceId }),
    },
  };
}

export type ConnectDbOptions = { uri: string; database: string; token?: string };

/** Connect and populate the client cache before exposing repository operations. */
export async function connectDb(options: ConnectDbOptions): Promise<{
  connection: GeneratedDbConnection;
  db: Db;
  disconnect(): void;
}> {
  const connection = await new Promise<GeneratedDbConnection>((resolve, reject) => {
    const builder = DbConnection.builder()
      .withUri(options.uri)
      .withDatabaseName(options.database)
      .onConnect(connection => resolve(connection))
      .onConnectError((_context, error) => reject(error));
    if (options.token) builder.withToken(options.token);
    builder.build();
  });
  await new Promise<void>((resolve, reject) => {
    connection.subscriptionBuilder()
      .onApplied(() => resolve())
      .onError(context => reject(new Error(`SpacetimeDB subscription failed: ${String(context)}`)))
      .subscribeToAllTables();
  });
  return { connection, db: createDb(connection), disconnect: () => connection.disconnect() };
}

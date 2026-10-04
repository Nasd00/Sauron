import type {
  AlertRow, CameraRow, GeneratedDbConnection, IncidentRow, ObservationRow, RowCallback,
  WatchRow,
} from "@tempmhacks/db-generated";
import { DbConnection } from "@tempmhacks/db-generated";
import type { Alert, Camera, Incident, InboundReceipt, Observation, Watch } from "./types.js";

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

export type Db = {
  cameras: {
    subscribe(callback: RowCallback<Camera>): () => void;
    register(camera: Camera): Promise<void>;
    setStatus(id: string, status: Camera["status"], lastSeenAt: number): Promise<void>;
  };
  observations: {
    subscribe(callback: RowCallback<Observation>): () => void;
    publish(observation: Observation): Promise<void>;
  };
  incidents: {
    subscribe(callback: RowCallback<Incident>): () => void;
    get(id: string): Incident | undefined;
    listConfirmed(): Incident[];
    create(incident: Incident): Promise<void>;
    confirm(id: string): Promise<void>;
    dismiss(id: string): Promise<void>;
    resolve(id: string, resolvedAt?: number): Promise<void>;
  };
  alerts: {
    subscribe(callback: RowCallback<Alert>): () => void;
    listPending(): Alert[];
    create(incidentId: string, watchId: string): Promise<void>;
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
};

export function createDb(connection: GeneratedDbConnection): Db {
  return {
    cameras: {
      subscribe: callback => subscribe(connection.db.camera)(row => callback(toCamera(row))),
      register: camera => connection.reducers.registerCamera({ camera }),
      setStatus: (id, status, lastSeenAt) => connection.reducers.setCameraStatus({
        cameraId: id, status, lastSeenAt,
      }),
    },
    observations: {
      subscribe: callback => subscribe(connection.db.observation)(row => callback(toObservation(row))),
      publish: observation => connection.reducers.publishObservation({ observation }),
    },
    incidents: {
      subscribe: callback => subscribe(connection.db.incident)(row => callback(toIncident(row))),
      get: id => {
        for (const row of connection.db.incident.iter()) if (row.id === id) return toIncident(row);
        return undefined;
      },
      listConfirmed: () => Array.from(connection.db.incident.iter(), toIncident)
        .filter(incident => incident.status === "confirmed"),
      create: incident => connection.reducers.createIncident({ input: incident }),
      confirm: id => connection.reducers.confirmIncident({ id, confirmedAt: Date.now() }),
      dismiss: id => connection.reducers.dismissIncident({ id }),
      resolve: (id, resolvedAt = Date.now()) => connection.reducers.resolveIncident({ id, resolvedAt }),
    },
    alerts: {
      subscribe: callback => subscribe(connection.db.alert)(row => callback(toAlert(row))),
      listPending: () => Array.from(connection.db.alert.iter(), toAlert).filter(alert => alert.status === "pending"),
      create: (incidentId, watchId) => connection.reducers.createAlert({ incidentId, watchId }),
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

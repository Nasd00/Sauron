import type {
  AlertRow, CameraRow, GeneratedDbConnection, IncidentRow, ObservationRow, RowCallback,
  WatchRow,
} from "@tempmhacks/db-generated";
import type { Alert, Camera, Incident, Observation, Watch } from "./types.js";

export type Subscription<Row> = (callback: RowCallback<Row>) => () => void;

function subscribe<Row>(table: {
  onInsert(callback: RowCallback<Row>): void;
  removeOnInsert(callback: RowCallback<Row>): void;
  onUpdate(callback: (oldRow: Row, newRow: Row) => void): void;
  removeOnUpdate(callback: (oldRow: Row, newRow: Row) => void): void;
  onDelete(callback: RowCallback<Row>): void;
  removeOnDelete(callback: RowCallback<Row>): void;
}): Subscription<Row> {
  return callback => {
    const onUpdate = (_oldRow: Row, newRow: Row) => callback(newRow);
    table.onInsert(callback);
    table.onUpdate(onUpdate);
    table.onDelete(callback);
    return () => {
      table.removeOnInsert(callback);
      table.removeOnUpdate(onUpdate);
      table.removeOnDelete(callback);
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
  return { ...row };
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
    confirm(id: string): Promise<void>;
    dismiss(id: string): Promise<void>;
    resolve(id: string, resolvedAt?: number): Promise<void>;
  };
  alerts: {
    subscribe(callback: RowCallback<Alert>): () => void;
  };
  watches: {
    create(watch: Watch): Promise<void>;
    stopForUser(userHandle: string): Promise<void>;
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
      confirm: id => connection.reducers.confirmIncident({ id, confirmedAt: Date.now() }),
      dismiss: id => connection.reducers.dismissIncident({ id }),
      resolve: (id, resolvedAt = Date.now()) => connection.reducers.resolveIncident({ id, resolvedAt }),
    },
    alerts: {
      subscribe: callback => subscribe(connection.db.alert)(row => callback(toAlert(row))),
    },
    watches: {
      create: watch => connection.reducers.createWatch({ input: { ...watch, active: true } }),
      stopForUser: userHandle => connection.reducers.deactivateWatchesForUser({ userHandle }),
    },
  };
}

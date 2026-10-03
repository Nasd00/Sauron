// Generated contract boundary. Regenerate this package with `npm run db:generate`.
export type CameraRow = {
  id: string; name: string; latitude: number; longitude: number;
  sourceType: string; streamUrl?: string; status: string; lastSeenAt?: number;
};
export type ObservationRow = {
  id: string; cameraId: string; type: string; confidence: number; timestamp: number;
  evidenceUrl?: string; bbox?: { x: number; y: number; width: number; height: number };
};
export type IncidentRow = {
  id: string; cameraId: string; type: string; status: string; confidence: number;
  latitude: number; longitude: number; firstSeenAt: number; lastSeenAt: number;
  confirmedAt?: number; resolvedAt?: number;
};
export type WatchRow = {
  id: string; userHandle: string; placeLabel: string; latitude: number; longitude: number;
  radiusKm: number; active: boolean; createdAt: number;
};
export type AlertRow = {
  id: string; incidentId: string; watchId: string; status: string; createdAt: number;
  sentAt?: number; providerMessageId?: string; error?: string;
};

export type RowCallback<Row> = (row: Row) => void;
export type RowTable<Row> = {
  onInsert(callback: RowCallback<Row>): void;
  removeOnInsert(callback: RowCallback<Row>): void;
  onUpdate(callback: (oldRow: Row, newRow: Row) => void): void;
  removeOnUpdate(callback: (oldRow: Row, newRow: Row) => void): void;
  onDelete(callback: RowCallback<Row>): void;
  removeOnDelete(callback: RowCallback<Row>): void;
};

export type GeneratedDbConnection = {
  db: {
    camera: RowTable<CameraRow>;
    observation: RowTable<ObservationRow>;
    incident: RowTable<IncidentRow>;
    alert: RowTable<AlertRow>;
  };
  reducers: {
    registerCamera(args: { camera: CameraRow }): Promise<void>;
    setCameraStatus(args: { cameraId: string; status: string; lastSeenAt: number }): Promise<void>;
    publishObservation(args: { observation: ObservationRow }): Promise<void>;
    confirmIncident(args: { id: string; confirmedAt: number }): Promise<void>;
    dismissIncident(args: { id: string }): Promise<void>;
    resolveIncident(args: { id: string; resolvedAt: number }): Promise<void>;
    createWatch(args: { input: WatchRow }): Promise<void>;
    deactivateWatchesForUser(args: { userHandle: string }): Promise<void>;
    createAlert(args: { incidentId: string; watchId: string }): Promise<void>;
  };
};

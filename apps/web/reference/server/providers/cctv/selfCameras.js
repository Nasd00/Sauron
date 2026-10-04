/**
 * In-memory registry of browser/phone-broadcast CCTV cameras.
 *
 * A phone opens /broadcast, registers a camera (metadata + pose), then POSTs
 * JPEG frames on an interval. Those frames are stored here keyed by camera id
 * and re-served through the existing /api/cctv/frame/:id path, so the camera
 * renders through the normal CCTV layer (marker, projection plane, health)
 * with no media server and no rendering changes.
 *
 * This store is intentionally memory-only and dev/preview scoped: it holds the
 * single latest JPEG per camera (not a buffer/history) and prunes cameras that
 * stop sending frames. Frames are keyed by the registered id and never fetched
 * from a client-supplied URL, preserving the proxy's no-SSRF boundary.
 */

/** A self-camera is considered live if it sent a frame within this window. */
export const SELF_CAMERA_ONLINE_MS = 20000;

/** Cameras idle longer than this are dropped from the catalog entirely. */
export const SELF_CAMERA_EXPIRE_MS = 120000;

/** Hard cap on concurrent self-cameras to bound memory. */
export const SELF_CAMERA_MAX = 32;

/** Largest accepted single JPEG frame (bytes). ~2.5 MB covers 1080p JPEG. */
export const SELF_CAMERA_MAX_FRAME_BYTES = 2_500_000;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const safeNumber = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const normalizeHeading = (deg) => {
  let v = safeNumber(deg, 0) % 360;
  if (v < 0) v += 360;
  return v;
};

/** Build the normalized, clamped pose/metadata record from raw register input. */
function normalizeMetadata(id, input = {}) {
  const lat = safeNumber(input.lat ?? input.latitude, NaN);
  const lon = safeNumber(input.lon ?? input.longitude, NaN);
  return {
    id,
    name: String(input.name || `Phone camera ${id.slice(0, 6)}`).slice(0, 80),
    city: String(input.city || 'Live broadcast').slice(0, 80),
    provider: 'Phone broadcast',
    sourceKind: 'self',
    feedType: 'webcam-frame',
    lat,
    lon,
    headingDeg: normalizeHeading(input.headingDeg ?? input.heading),
    headingConfidence: 'high',
    fovDeg: clamp(safeNumber(input.fovDeg ?? input.fov, 70), 20, 120),
    rangeM: clamp(safeNumber(input.rangeM, 420), 120, 2200),
    mountHeightM: clamp(safeNumber(input.mountHeightM, 18), 6, 120),
    pitchDeg: clamp(safeNumber(input.pitchDeg, -12), -55, -2),
    groundElevationM: safeNumber(input.groundElevationM, 0),
    poseSource: 'curated',
  };
}

export function createSelfCameraStore({ now = () => Date.now() } = {}) {
  /** @type {Map<string, { metadata: object, frame: Buffer|null, contentType: string, lastFrameAt: number, lastSeenAt: number, registeredAt: number }>} */
  const cameras = new Map();

  /** Drop cameras that have gone silent past the expiry window. */
  const prune = () => {
    const cutoff = now() - SELF_CAMERA_EXPIRE_MS;
    for (const [id, entry] of cameras) {
      if (entry.lastSeenAt < cutoff) cameras.delete(id);
    }
  };

  /** Register (or re-register) a camera's metadata/pose. Returns the record. */
  const register = (id, input) => {
    prune();
    const camId = String(id || '').trim();
    if (!camId) throw new Error('camera id required');
    const existing = cameras.get(camId);
    if (!existing && cameras.size >= SELF_CAMERA_MAX) {
      throw new Error('self-camera capacity reached');
    }
    const metadata = normalizeMetadata(camId, input);
    const t = now();
    cameras.set(camId, {
      metadata,
      frame: existing?.frame ?? null,
      contentType: existing?.contentType ?? 'image/jpeg',
      lastFrameAt: existing?.lastFrameAt ?? 0,
      lastSeenAt: t,
      registeredAt: existing?.registeredAt ?? t,
    });
    return metadata;
  };

  /** Store the latest JPEG frame for a camera. Returns false if unknown/too big. */
  const putFrame = (id, body, contentType = 'image/jpeg') => {
    const camId = String(id || '').trim();
    const entry = cameras.get(camId);
    if (!entry) return false;
    if (!body || body.length === 0 || body.length > SELF_CAMERA_MAX_FRAME_BYTES)
      return false;
    entry.frame = body;
    entry.contentType = contentType.startsWith('image/')
      ? contentType
      : 'image/jpeg';
    const t = now();
    entry.lastFrameAt = t;
    entry.lastSeenAt = t;
    return true;
  };

  /** Explicitly mark a camera offline/remove it (broadcast stopped). */
  const remove = (id) => cameras.delete(String(id || '').trim());

  /** True when the id belongs to a known self-camera. */
  const has = (id) => cameras.has(String(id || '').trim());

  /** Latest stored frame for a camera, or null. */
  const getFrame = (id) => {
    const entry = cameras.get(String(id || '').trim());
    if (!entry || !entry.frame) return null;
    return { body: entry.frame, contentType: entry.contentType };
  };

  /** Catalog-shaped source records for all live/known self-cameras. */
  const listSources = () => {
    prune();
    return [...cameras.values()].map((entry) => ({
      ...entry.metadata,
      pack: 'self',
    }));
  };

  /** Health records derived from frame freshness. */
  const listHealth = () => {
    prune();
    const t = now();
    return [...cameras.values()].map((entry) => {
      const fresh = t - entry.lastFrameAt <= SELF_CAMERA_ONLINE_MS;
      const everSent = entry.lastFrameAt > 0;
      return {
        id: entry.metadata.id,
        status: fresh ? 'ok' : everSent ? 'degraded' : 'unknown',
        sourceKind: 'self',
        label: entry.metadata.name,
        message: fresh
          ? 'Live phone broadcast'
          : everSent
            ? 'Broadcast paused'
            : 'Waiting for first frame',
        updatedAt: entry.lastSeenAt,
      };
    });
  };

  return {
    register,
    putFrame,
    remove,
    has,
    getFrame,
    listSources,
    listHealth,
  };
}

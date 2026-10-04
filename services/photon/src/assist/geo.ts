export type LatLng = { latitude: number; longitude: number };
/** A closed ring; the first point is not repeated at the end. */
export type Polygon = LatLng[];

const EARTH_RADIUS_KM = 6371;
const toRadians = (degrees: number) => degrees * Math.PI / 180;

export function distanceKm(a: LatLng, b: LatLng): number {
  const dLat = toRadians(b.latitude - a.latitude);
  const dLon = toRadians(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(toRadians(a.latitude)) * Math.cos(toRadians(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

/** Ray-casting point-in-polygon on lon/lat; accurate enough for neighborhood-scale areas. */
export function pointInPolygon(point: LatLng, polygon: Polygon): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    const crosses = (a.latitude > point.latitude) !== (b.latitude > point.latitude)
      && point.longitude < (b.longitude - a.longitude) * (point.latitude - a.latitude)
        / (b.latitude - a.latitude) + a.longitude;
    if (crosses) inside = !inside;
  }
  return inside;
}

function orientation(p: LatLng, q: LatLng, r: LatLng): number {
  return (q.longitude - p.longitude) * (r.latitude - p.latitude)
    - (q.latitude - p.latitude) * (r.longitude - p.longitude);
}

function segmentsIntersect(a1: LatLng, a2: LatLng, b1: LatLng, b2: LatLng): boolean {
  const d1 = orientation(b1, b2, a1);
  const d2 = orientation(b1, b2, a2);
  const d3 = orientation(a1, a2, b1);
  const d4 = orientation(a1, a2, b2);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** True when any vertex of the path lies in the polygon or any path segment crosses its boundary. */
export function pathIntersectsPolygon(path: LatLng[], polygon: Polygon): boolean {
  if (polygon.length < 3 || path.length === 0) return false;
  if (path.some(point => pointInPolygon(point, polygon))) return true;
  for (let i = 1; i < path.length; i++) {
    for (let j = 0; j < polygon.length; j++) {
      if (segmentsIntersect(path[i - 1]!, path[i]!, polygon[j]!, polygon[(j + 1) % polygon.length]!)) return true;
    }
  }
  return false;
}

/** Decode a Google-style encoded polyline (Valhalla uses precision 6). */
export function decodePolyline(encoded: string, precision = 6): LatLng[] {
  const factor = 10 ** precision;
  const points: LatLng[] = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  while (index < encoded.length) {
    for (const axis of [0, 1]) {
      let shift = 0;
      let result = 0;
      let byte: number;
      do {
        byte = encoded.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 0) lat += delta; else lon += delta;
    }
    points.push({ latitude: lat / factor, longitude: lon / factor });
  }
  return points;
}

/** Keep every Nth point (always including the last) to bound payload sizes. */
export function simplifyPath(path: LatLng[], maxPoints = 400): LatLng[] {
  if (path.length <= maxPoints) return path;
  const step = Math.ceil(path.length / maxPoints);
  const kept = path.filter((_, index) => index % step === 0);
  const last = path[path.length - 1]!;
  if (kept[kept.length - 1] !== last) kept.push(last);
  return kept;
}

export function circlePolygon(center: LatLng, radiusMeters: number, sides = 20): Polygon {
  const metersPerDegLat = 111_320;
  const metersPerDegLon = metersPerDegLat * Math.cos(toRadians(center.latitude));
  return Array.from({ length: sides }, (_, index) => {
    const angle = (index / sides) * 2 * Math.PI;
    return {
      latitude: center.latitude + Math.sin(angle) * radiusMeters / metersPerDegLat,
      longitude: center.longitude + Math.cos(angle) * radiusMeters / metersPerDegLon,
    };
  });
}

/** Shortest distance from a point to any vertex of a path, in km (paths are densely sampled). */
export function distanceToPathKm(point: LatLng, path: LatLng[]): number {
  return path.reduce((best, vertex) => Math.min(best, distanceKm(point, vertex)), Number.POSITIVE_INFINITY);
}

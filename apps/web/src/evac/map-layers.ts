import {
  CallbackPositionProperty,
  Cartesian2,
  Cartesian3,
  Color,
  CustomDataSource,
  HorizontalOrigin,
  LabelStyle,
  Math as CesiumMath,
  NearFarScalar,
  PolylineDashMaterialProperty,
  PolylineGlowMaterialProperty,
  VerticalOrigin,
  type Viewer,
} from "cesium";
import type { Arrangement, EvacSnapshot, LatLng, RouteSummary } from "@tempmhacks/shared/evac";

const COLORS = {
  warning: "#ff4d3d",
  route: "#3ee0ff",
  pickup: "#ffc24b",
  superseded: "#ff8a7a",
  closure: "#ff2d55",
  shelter: "#5be3a5",
  shelterMuted: "#7b8a94",
  helper: "#ffc24b",
  helperMuted: "#7b8a94",
  home: "#ffffff",
  camera: "#ff8a3d",
};

const GLYPHS = {
  home: "M12 5 4 11.5V19h5v-4.5h6V19h5v-7.5z",
  shelter: "M10 5h4v5h5v4h-5v5h-4v-5H5v-4h5z",
  van: "M3 8h11l3 3h3v6h-2a2 2 0 0 1-4 0H9a2 2 0 0 1-4 0H3zM6 10v2h3v-2zm5 0v2h4l-2-2z",
  camera: "M8 7l1.5-2h5L16 7h3v11H5V7zm4 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
};

/** A round map pin with a white glyph, as an SVG data URI. */
function pin(color: string, glyph: keyof typeof GLYPHS, ring = "#071018"): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="44" height="44" viewBox="0 0 44 44">
    <circle cx="22" cy="22" r="19" fill="${color}" stroke="${ring}" stroke-width="3"/>
    <g transform="translate(10 10)"><path d="${GLYPHS[glyph]}" fill="${ring === "#071018" ? "#071018" : "#fff"}"/></g></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const toPositions = (points: LatLng[], height = 0) =>
  Cartesian3.fromDegreesArrayHeights(points.flatMap(p => [p.longitude, p.latitude, height]));
const ring = (points: LatLng[]) => [...points, points[0]!];

const label = (text: string, color = "#eef5f7", offsetY = -30) => ({
  text,
  font: "600 12px Inter, system-ui, sans-serif",
  fillColor: Color.fromCssColorString(color),
  outlineColor: Color.fromCssColorString("#071018"),
  outlineWidth: 3,
  style: LabelStyle.FILL_AND_OUTLINE,
  showBackground: true,
  backgroundColor: Color.fromCssColorString("#071018").withAlpha(0.78),
  backgroundPadding: new Cartesian2(7, 4),
  pixelOffset: new Cartesian2(0, offsetY),
  verticalOrigin: VerticalOrigin.BOTTOM,
  horizontalOrigin: HorizontalOrigin.CENTER,
  disableDepthTestDistance: Number.POSITIVE_INFINITY,
  scaleByDistance: new NearFarScalar(2_000, 1.05, 40_000, 0.75),
});

/** Position a fraction of the way along a path, by distance. */
function along(path: LatLng[], fraction: number): LatLng {
  if (path.length < 2) return path[0]!;
  const lengths = [0];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!; const b = path[i]!;
    lengths.push(lengths[i - 1]! + Math.hypot(b.latitude - a.latitude, (b.longitude - a.longitude) * Math.cos(a.latitude * Math.PI / 180)));
  }
  const target = Math.min(1, Math.max(0, fraction)) * lengths[lengths.length - 1]!;
  const index = Math.max(1, lengths.findIndex(length => length >= target));
  const a = path[index - 1]!; const b = path[index]!;
  const span = lengths[index]! - lengths[index - 1]! || 1;
  const t = (target - lengths[index - 1]!) / span;
  return { latitude: a.latitude + (b.latitude - a.latitude) * t, longitude: a.longitude + (b.longitude - a.longitude) * t };
}

const historyAt = (arrangement: Arrangement, status: Arrangement["status"]) =>
  arrangement.history.find(entry => entry.status === status)?.at;

/**
 * Renders the evacuation picture on the Cesium globe: the official warning area, shelters,
 * helpers, closures, God's Eye incidents, and the live/superseded routes.
 */
export class EvacMapLayers {
  readonly #static = new CustomDataSource("evac-static");
  readonly #dynamic = new CustomDataSource("evac-dynamic");
  #staticKey = "";
  #dynamicKey = "";
  #previousTrip?: RouteSummary;
  #superseded?: RouteSummary;
  #snapshot?: EvacSnapshot;

  constructor(readonly viewer: Viewer) {
    void viewer.dataSources.add(this.#static);
    void viewer.dataSources.add(this.#dynamic);
  }

  /** A tilted view looking north over the scenario area. */
  frame(center: LatLng, duration = 1.6): void {
    const altitude = 12_500;
    const pitch = CesiumMath.toRadians(-52);
    const northOffsetDeg = altitude / Math.tan(-pitch) / 111_320;
    this.viewer.camera.flyTo({
      destination: Cartesian3.fromDegrees(center.longitude + 0.012, center.latitude - northOffsetDeg - 0.012, altitude),
      orientation: { heading: CesiumMath.toRadians(0), pitch, roll: 0 },
      duration,
    });
  }

  update(snapshot: EvacSnapshot): void {
    this.#snapshot = snapshot;
    const household = snapshot.households[0];
    const arrangement = [...snapshot.arrangements].reverse().find(a => a.householdId === household?.id);
    const trip = household?.activeRoute ?? (arrangement && arrangement.status !== "cancelled" ? arrangement.tripRoute : undefined);

    // Remember the route a closure replaced, so the map shows what changed.
    if (trip && this.#previousTrip && trip.id !== this.#previousTrip.id && trip.avoidedClosureIds.length > this.#previousTrip.avoidedClosureIds.length) {
      this.#superseded = this.#previousTrip;
    }
    if (!trip) this.#superseded = undefined;
    this.#previousTrip = trip;

    const offered = new Set(household?.offeredShelterIds ?? []);
    const staticKey = JSON.stringify([
      snapshot.warnings.map(w => w.id), snapshot.closures.map(c => c.id + c.status),
      snapshot.shelters.map(s => [s.id, s.occupied, s.status]), [...offered], household?.selectedShelterId,
      snapshot.helpers.map(h => [h.id, h.status]), snapshot.incidents.map(i => i.id),
    ]);
    if (staticKey !== this.#staticKey) {
      this.#staticKey = staticKey;
      this.#renderStatic(snapshot, offered, household?.selectedShelterId, arrangement);
    }
    const dynamicKey = JSON.stringify([trip?.id, this.#superseded?.id, arrangement?.pickupRoute?.id, arrangement?.status, arrangement?.helperId]);
    if (dynamicKey !== this.#dynamicKey) {
      this.#dynamicKey = dynamicKey;
      this.#renderDynamic(snapshot, trip, arrangement);
    }
  }

  #renderStatic(snapshot: EvacSnapshot, offered: Set<string>, selectedId: string | undefined, arrangement: Arrangement | undefined): void {
    const entities = this.#static.entities;
    entities.removeAll();

    for (const warning of snapshot.warnings) {
      if (warning.area.length < 3) continue;
      entities.add({
        polygon: { hierarchy: toPositions(warning.area), material: Color.fromCssColorString(COLORS.warning).withAlpha(0.13), height: 0 },
      });
      entities.add({
        polyline: {
          positions: toPositions(ring(warning.area), 2), width: 2.5,
          material: new PolylineDashMaterialProperty({ color: Color.fromCssColorString(COLORS.warning), dashLength: 18 }),
        },
      });
      const north = warning.area.reduce((best, p) => p.latitude > best.latitude ? p : best, warning.area[0]!);
      entities.add({ position: Cartesian3.fromDegrees(north.longitude, north.latitude), label: { ...label(warning.event.toUpperCase(), "#ff9b8f", 0), font: "800 11px Inter, system-ui, sans-serif" } });
    }

    for (const closure of snapshot.closures.filter(c => c.status === "active")) {
      entities.add({ polygon: { hierarchy: toPositions(closure.area), material: Color.fromCssColorString(COLORS.closure).withAlpha(0.35), height: 0 } });
      if (closure.line?.length) {
        entities.add({ polyline: { positions: toPositions(closure.line, 4), width: 9, material: Color.fromCssColorString(COLORS.closure) } });
      }
      const mid = closure.line?.[Math.floor(closure.line.length / 2)] ?? closure.area[0]!;
      entities.add({ position: Cartesian3.fromDegrees(mid.longitude, mid.latitude), label: label(`ROAD CLOSED · ${closure.road}`, "#ff8fa3", -8) });
    }

    for (const shelter of snapshot.shelters) {
      const isOffered = offered.has(shelter.id);
      const selected = shelter.id === selectedId;
      const color = selected ? COLORS.route : isOffered || !offered.size ? COLORS.shelter : COLORS.shelterMuted;
      entities.add({
        position: Cartesian3.fromDegrees(shelter.location.longitude, shelter.location.latitude),
        billboard: { image: pin(color, "shelter"), width: selected ? 34 : 28, height: selected ? 34 : 28, disableDepthTestDistance: Number.POSITIVE_INFINITY },
        label: label(`${shelter.name} · ${shelter.capacity - shelter.occupied} open`, selected ? "#9ff1ff" : isOffered || !offered.size ? "#c6f7df" : "#93a3ad"),
      });
    }

    for (const helper of snapshot.helpers) {
      // An assigned helper is drawn moving along the route in the dynamic layer.
      if (arrangement?.helperId === helper.id && ["confirmed", "en_route", "picked_up"].includes(arrangement.status)) continue;
      const active = helper.status === "requested";
      entities.add({
        position: Cartesian3.fromDegrees(helper.home.longitude, helper.home.latitude),
        billboard: { image: pin(helper.vehicle.wheelchairAccessible ? COLORS.helper : COLORS.helperMuted, "van"), width: active ? 32 : 24, height: active ? 32 : 24, disableDepthTestDistance: Number.POSITIVE_INFINITY },
        label: label(`${helper.name.split(" ")[0]} · ${helper.vehicle.wheelchairAccessible ? "accessible" : helper.vehicle.description}${helper.status === "available" ? "" : ` · ${helper.status}`}`, helper.vehicle.wheelchairAccessible ? "#ffe0a3" : "#93a3ad"),
      });
    }

    for (const incident of snapshot.incidents) {
      entities.add({
        position: Cartesian3.fromDegrees(incident.location.longitude, incident.location.latitude),
        billboard: { image: pin(COLORS.camera, "camera"), width: 28, height: 28, disableDepthTestDistance: Number.POSITIVE_INFINITY },
        label: label(`God's Eye · ${Math.round(incident.confidence * 100)}% smoke/fire`, "#ffc29a"),
      });
    }

    for (const household of snapshot.households) {
      entities.add({
        position: Cartesian3.fromDegrees(household.location.longitude, household.location.latitude),
        billboard: { image: pin(COLORS.home, "home"), width: 34, height: 34, disableDepthTestDistance: Number.POSITIVE_INFINITY },
        label: label(household.label, "#ffffff", -34),
      });
    }
  }

  #renderDynamic(snapshot: EvacSnapshot, trip: RouteSummary | undefined, arrangement: Arrangement | undefined): void {
    const entities = this.#dynamic.entities;
    entities.removeAll();
    if (this.#superseded) {
      entities.add({
        polyline: {
          positions: toPositions(this.#superseded.geometry, 1), width: 4,
          material: new PolylineDashMaterialProperty({ color: Color.fromCssColorString(COLORS.superseded).withAlpha(0.75), dashLength: 12 }),
        },
      });
    }
    const pickupActive = arrangement?.pickupRoute && ["requested", "confirmed", "en_route"].includes(arrangement.status);
    if (pickupActive) {
      entities.add({
        polyline: {
          positions: toPositions(arrangement.pickupRoute!.geometry, 2), width: 4,
          material: new PolylineDashMaterialProperty({ color: Color.fromCssColorString(COLORS.pickup), dashLength: 14 }),
        },
      });
    }
    if (trip) {
      entities.add({
        polyline: {
          positions: toPositions(trip.geometry, 3), width: 10,
          material: new PolylineGlowMaterialProperty({ color: Color.fromCssColorString(COLORS.route), glowPower: 0.22, taperPower: 1 }),
        },
      });
    }

    const helper = snapshot.helpers.find(h => h.id === arrangement?.helperId);
    if (helper && arrangement && ["confirmed", "en_route", "picked_up"].includes(arrangement.status)) {
      // Animate the van along its route using the agent's ETAs (real time).
      const position = new CallbackPositionProperty(() => {
        const latest = this.#snapshot?.arrangements.find(a => a.id === arrangement.id) ?? arrangement;
        const now = Date.now();
        let point: LatLng;
        if (latest.status === "picked_up" && latest.arrivalEta) {
          const start = historyAt(latest, "picked_up") ?? now;
          point = along(latest.tripRoute.geometry, (now - start) / Math.max(1, latest.arrivalEta - start));
        } else if (latest.pickupRoute && latest.pickupEta) {
          const start = historyAt(latest, "confirmed") ?? now;
          point = along(latest.pickupRoute.geometry, (now - start) / Math.max(1, latest.pickupEta - start));
        } else {
          point = helper.home;
        }
        return Cartesian3.fromDegrees(point.longitude, point.latitude, 6);
      }, false);
      entities.add({
        position,
        billboard: { image: pin(COLORS.helper, "van", "#ffffff"), width: 36, height: 36, disableDepthTestDistance: Number.POSITIVE_INFINITY },
        label: label(`${helper.name.split(" ")[0]} · ${arrangement.status === "picked_up" ? "en route to shelter" : "en route to pickup"}`, "#ffe0a3", -34),
      });
    }
    this.viewer.scene.requestRender();
  }
}

import * as Cesium from "cesium";
import type { IncidentView } from "@tempmhacks/shared";
import { escapePlan, summarizeDangers, type DangerSummary, type Point } from "./danger";
import { LiveState } from "./live-state";

type PositionSource = "spoken" | "device" | "map view" | "unknown";

/** What the IRIS voice tools in reference/src/tools/queries/safety.js read. */
export type SafetyBridge = {
  dangers(from?: Point): DangerSummary[];
  escape(from: Point): (ReturnType<typeof escapePlan> & { drawn?: boolean }) | undefined;
  position(spoken?: Point): Promise<{ position?: Point; source: PositionSource }>;
};

type VoiceSession = { isActive(): boolean; sendMapEvent(event: unknown, options?: { respond?: boolean }): unknown };
const voiceSession = () =>
  (window as unknown as { __irisVoiceCommands?: { session?: VoiceSession } }).__irisVoiceCommands?.session;

/** Browser location, if the person allows it; never blocks a voice answer for long. */
function devicePosition(timeoutMs = 4000): Promise<Point | undefined> {
  if (!("geolocation" in navigator)) return Promise.resolve(undefined);
  return new Promise(resolve => {
    navigator.geolocation.getCurrentPosition(
      fix => resolve({ latitude: fix.coords.latitude, longitude: fix.coords.longitude }),
      () => resolve(undefined),
      { enableHighAccuracy: false, timeout: timeoutMs, maximumAge: 5 * 60_000 },
    );
  });
}

function viewCenter(viewer: Cesium.Viewer): Point | undefined {
  const canvas = viewer.scene.canvas;
  const center = viewer.camera.pickEllipsoid(new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2));
  if (!center) return undefined;
  const carto = Cesium.Cartographic.fromCartesian(center);
  return { latitude: Cesium.Math.toDegrees(carto.latitude), longitude: Cesium.Math.toDegrees(carto.longitude) };
}

/**
 * Gives the IRIS voice assistant live incident awareness: it can list dangers and lead someone out
 * of a danger zone (drawing the way out on the globe), and when a new danger is confirmed while
 * voice is on, IRIS is told right away and speaks up.
 */
export function mountIrisSafety(viewer: Cesium.Viewer, state: LiveState): () => void {
  const source = new Cesium.CustomDataSource("sauron-escape-route");
  void viewer.dataSources.add(source);
  let lastDevice: Point | undefined;

  function drawEscape(from: Point, plan: NonNullable<ReturnType<typeof escapePlan>>) {
    source.entities.removeAll();
    const color = Cesium.Color.fromCssColorString("#30d158");
    source.entities.add({
      id: "escape:line",
      polyline: new Cesium.PolylineGraphics({
        positions: Cesium.Cartesian3.fromDegreesArray([from.longitude, from.latitude, plan.safePoint.longitude, plan.safePoint.latitude]),
        width: 5, clampToGround: true,
        material: new Cesium.PolylineArrowMaterialProperty(color),
      }),
    });
    source.entities.add({
      id: "escape:safe",
      position: Cesium.Cartesian3.fromDegrees(plan.safePoint.longitude, plan.safePoint.latitude),
      point: new Cesium.PointGraphics({
        pixelSize: 12, color, outlineColor: Cesium.Color.BLACK, outlineWidth: 2,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY,
      }),
      label: new Cesium.LabelGraphics({
        text: `SAFE POINT · head ${plan.head}`, font: "600 13px 'JetBrains Mono', monospace",
        fillColor: Cesium.Color.WHITE, showBackground: true,
        backgroundColor: Cesium.Color.fromCssColorString("#071018").withAlpha(0.85),
        pixelOffset: new Cesium.Cartesian2(0, -20), verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      }),
    });
    const box = Cesium.Rectangle.fromCartographicArray([
      Cesium.Cartographic.fromDegrees(from.longitude, from.latitude),
      Cesium.Cartographic.fromDegrees(plan.safePoint.longitude, plan.safePoint.latitude),
      Cesium.Cartographic.fromDegrees(plan.danger.longitude, plan.danger.latitude),
    ]);
    viewer.camera.flyTo({ destination: Cesium.Rectangle.fromRadians(
      box.west - 0.0004, box.south - 0.0004, box.east + 0.0004, box.north + 0.0004), duration: 1.4 });
    viewer.scene.requestRender();
  }

  const bridge: SafetyBridge = {
    dangers: from => summarizeDangers(state.confirmedViews(), from),
    escape: from => {
      const plan = escapePlan(state.confirmedViews(), from);
      if (!plan) return undefined;
      drawEscape(from, plan);
      return { ...plan, drawn: true };
    },
    position: async spoken => {
      if (spoken) return { position: spoken, source: "spoken" };
      const device = await devicePosition();
      if (device) { lastDevice = device; return { position: device, source: "device" }; }
      const view = viewCenter(viewer);
      return view ? { position: view, source: "map view" } : { source: "unknown" };
    },
  };
  (globalThis as { __sauronSafety?: SafetyBridge }).__sauronSafety = bridge;

  // Incidents confirmed while the page is open. Ones already confirmed at load are known to the
  // tools but not announced.
  const announced = new Set<string>();
  let primed = false;
  const announce = (incident: IncidentView) => {
    const session = voiceSession();
    if (!session?.isActive()) return;
    const [danger] = summarizeDangers([incident], lastDevice);
    // JSON data, not prose: titles are operator-written text.
    session.sendMapEvent({
      type: "danger_reported",
      instruction_for_assistant: "A new dangerous event was confirmed. Tell the user briefly what and where it is. If they may be near it, offer to get them out (call get_escape_route).",
      danger,
    }, { respond: true });
  };
  const onChange = () => {
    const confirmed = state.confirmedViews();
    if (!primed) {
      // The first snapshot is history, not news.
      if (state.incidents.size) { for (const incident of confirmed) announced.add(incident.id); primed = true; }
      return;
    }
    for (const incident of confirmed) {
      if (announced.has(incident.id)) continue;
      // Wait for the operator report row so the announcement carries the title and zone.
      if (incident.cameraId === "manual" && !incident.report) continue;
      announced.add(incident.id);
      announce(incident);
    }
    // A resolved danger leaves no stale escape arrow behind.
    if (!confirmed.length && source.entities.values.length) { source.entities.removeAll(); viewer.scene.requestRender(); }
  };
  const unsubscribe = state.subscribe(onChange);
  // An empty database never sends a first row; treat a quiet start as primed.
  const primeTimer = window.setTimeout(() => { primed = true; }, 8000);

  return () => {
    unsubscribe();
    window.clearTimeout(primeTimer);
    viewer.dataSources.remove(source, true);
    const global = globalThis as { __sauronSafety?: SafetyBridge };
    if (global.__sauronSafety === bridge) delete global.__sauronSafety;
  };
}

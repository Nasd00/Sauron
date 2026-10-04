import * as Cesium from "cesium";
import type { Camera, Incident } from "@tempmhacks/shared";
import { hazardLabel } from "@tempmhacks/shared";
import { dangerRadiusKm } from "./danger";
import { mountReportEvent } from "./report-event";
import { mountIrisSafety } from "./iris-safety";
import { LiveState } from "./live-state";
import { connectSpacetime } from "./spacetime";
import { mountBroadcastUi } from "./broadcast-ui";
import { mountWatchAreas } from "./watch-areas";
import { forgetOperatorSecret, operatorSecret, resolveIncidentViaPhoton, transitionIncidentViaPhoton } from "./photon-client";
import "./integration.css";

type Navigation = { runImmediateNavigation(noun: string, navigate: () => void): void };
type Components = { scene: { viewer: Cesium.Viewer }; controls: Record<string, unknown> };

export function mountSauron(components: Components): () => void {
  const { viewer } = components.scene;
  const navigation = Object.values(components.controls).find(value =>
    value && typeof (value as Navigation).runImmediateNavigation === "function") as Navigation | undefined;
  const state = new LiveState();
  const source = new Cesium.CustomDataSource("sauron-spacetimedb");
  void viewer.dataSources.add(source);
  let selected: { kind: "camera" | "incident"; id: string } | undefined;
  let alive = true;
  let camerasVisible = true;
  let incidentsVisible = true;
  let pending = false;
  let restoredDeepLink = false;
  const panel = document.createElement("section");
  panel.className = "sauron-panel";
  panel.setAttribute("aria-label", "Iris monitored cameras and incidents");
  panel.innerHTML = `<header><strong>IRIS</strong><span class="sauron-status" role="status"></span></header>
    <div class="sauron-layers"><label><input type="checkbox" data-layer="cameras" checked> Monitored cameras</label><label><input type="checkbox" data-layer="incidents" checked> Incidents</label></div>
    <div class="sauron-feed"></div><div class="sauron-detail"></div><p class="sauron-error" role="alert"></p>`;
  document.body.append(panel);
  const element = <T extends HTMLElement>(selector: string) => panel.querySelector<T>(selector)!;
  const errorView = element(".sauron-error");
  const connection = connectSpacetime(state, message => { if (alive) element(".sauron-status").textContent = message; });
  const safeUrl = (value: string | undefined): string | undefined => {
    if (!value) return;
    try { const url = new URL(value, location.origin); return ["http:", "https:"].includes(url.protocol) ? url.href : undefined; } catch { return; }
  };

  function focus(row: Camera | Incident) {
    const fly = () => {
      viewer.trackedEntity = undefined;
      viewer.camera.cancelFlight();
      viewer.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(row.longitude, row.latitude, 1800),
        orientation: { heading: 0, pitch: Cesium.Math.toRadians(-50), roll: 0 }, duration: 1.6 });
    };
    if (navigation) navigation.runImmediateNavigation("incident", fly);
    else fly();
  }
  function select(kind: "camera" | "incident", id: string, fly = true) {
    const row = kind === "camera" ? state.cameras.get(id) : state.incidents.get(id);
    if (!row) return;
    selected = { kind, id };
    if (kind === "incident") history.replaceState(null, "", `/incident/${encodeURIComponent(id)}${location.search}${location.hash}`);
    if (fly) focus(row);
    renderDetail();
  }
  function renderDetail() {
    const detail = element(".sauron-detail");
    detail.replaceChildren();
    if (!selected) return;
    const row = selected.kind === "camera" ? state.cameras.get(selected.id) : state.incidents.get(selected.id);
    if (!row) { selected = undefined; return; }
    const report = "cameraId" in row ? state.reports.get(row.id) : undefined;
    const heading = document.createElement("h3");
    if (report) {
      const badge = document.createElement("span"); badge.className = "sauron-badge"; badge.textContent = "MANUAL";
      heading.append(badge, report.title);
    } else heading.textContent = "name" in row ? row.name : hazardLabel(row.type);
    const meta = document.createElement("p");
    meta.textContent = `${row.status.toUpperCase()} · ${row.latitude.toFixed(4)}, ${row.longitude.toFixed(4)}`;
    const close = document.createElement("button"); close.textContent = "Close";
    close.onclick = () => { selected = undefined; renderDetail(); };
    detail.append(heading, meta, close);
    if (report) {
      const what = document.createElement("p");
      what.textContent = `${hazardLabel((row as Incident).type)} · danger zone ${report.radiusKm} km · reported by ${report.reportedBy} ${new Date(report.reportedAt).toLocaleString()}`;
      detail.append(what);
      if (report.description) {
        const details = document.createElement("p"); details.className = "sauron-report-details"; details.textContent = report.description;
        detail.append(details);
      }
    }
    const camera = "cameraId" in row ? (report ? undefined : state.cameras.get(row.cameraId)) : row;
    const observation = report ? undefined : state.latestEvidence(camera?.id ?? ("cameraId" in row ? row.cameraId : row.id));
    if (observation) {
      const url = safeUrl(observation.evidenceUrl);
      if (url) { const image = document.createElement("img"); image.src = url; image.alt = `Latest evidence from ${camera?.name ?? "camera"}`; detail.append(image); }
      const caption = document.createElement("p"); caption.textContent = `Evidence captured ${new Date(observation.timestamp).toLocaleString()}`; detail.append(caption);
    }
    if (camera?.sourceType === "live" && camera.status === "online") {
      const url = safeUrl(camera.streamUrl);
      if (url) { const link = document.createElement("a"); link.href = url; link.target = "_blank"; link.rel = "noopener noreferrer"; link.textContent = "Open registered camera source"; detail.append(link); }
    }
    if ("confidence" in row) {
      if (!report) { const confidence = document.createElement("p"); confidence.textContent = `${Math.round(row.confidence * 100)}% confidence · ${camera?.name ?? row.cameraId}`; detail.append(confidence); }
      const actions = row.status === "candidate" ? ["confirm", "dismiss"] as const : row.status === "confirmed" ? ["resolve"] as const : [];
      for (const action of actions) {
        const button = document.createElement("button"); button.textContent = action.toUpperCase(); button.disabled = pending;
        button.onclick = async () => {
          const photonUrl = import.meta.env.VITE_PHOTON_URL?.trim();
          if (!photonUrl) { errorView.textContent = "Set VITE_PHOTON_URL to manage incidents."; return; }
          const secret = operatorSecret();
          if (!secret) { errorView.textContent = "An operator key is needed to manage incidents."; return; }
          pending = true; errorView.textContent = ""; renderDetail();
          try {
            const result = action === "resolve"
              ? await resolveIncidentViaPhoton(photonUrl, secret, row.id)
              : await transitionIncidentViaPhoton(photonUrl, secret, row.id, action);
            if (!result.ok) {
              if (result.reason === "unauthorized") forgetOperatorSecret();
              if (alive) errorView.textContent = result.message;
            }
          }
          catch (error) { if (alive) errorView.textContent = error instanceof Error ? error.message : "Action failed"; }
          finally { pending = false; if (alive) renderDetail(); }
        };
        detail.append(button);
      }
    }
  }
  function reconcile() {
    const desired = new Set<string>();
    function marker(kind: "camera" | "incident", row: Camera | Incident, color: string, show: boolean) {
      const id = `sauron:${kind}:${row.id}`; desired.add(id);
      const entity = source.entities.getById(id) ?? source.entities.add({ id, properties: { sauronKind: kind, sauronId: row.id } });
      entity.position = new Cesium.ConstantPositionProperty(Cesium.Cartesian3.fromDegrees(row.longitude, row.latitude));
      entity.point = new Cesium.PointGraphics({ pixelSize: kind === "incident" ? 13 : 9,
        color: Cesium.Color.fromCssColorString(color), outlineColor: Cesium.Color.BLACK, outlineWidth: 2,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY });
      entity.name = "name" in row ? row.name : `Smoke / Fire · ${row.status}`;
      entity.show = show;
    }
    for (const row of state.cameras.values()) marker("camera", row, row.status === "online" ? "#f2f1ec" : "#687480", camerasVisible);
    for (const row of state.activeIncidents()) {
      const report = state.reports.get(row.id);
      marker("incident", row, report ? "#ff2d55" : row.status === "confirmed" ? "#ff635d" : "#ffc56a", incidentsVisible);
      if (report) source.entities.getById(`sauron:incident:${row.id}`)!.name = `${report.title} · ${row.status}`;
      // Danger zones: operator reports draw their own radius, so people can see what to avoid.
      if (row.status !== "confirmed" || !report) continue;
      const id = `sauron:zone:${row.id}`; desired.add(id);
      const zone = source.entities.getById(id) ?? source.entities.add({ id, properties: { sauronKind: "incident", sauronId: row.id } });
      const meters = dangerRadiusKm({ ...row, report }) * 1000;
      zone.position = new Cesium.ConstantPositionProperty(Cesium.Cartesian3.fromDegrees(row.longitude, row.latitude));
      zone.ellipse = new Cesium.EllipseGraphics({ semiMajorAxis: meters, semiMinorAxis: meters,
        material: Cesium.Color.fromCssColorString("#ff2d55").withAlpha(0.16), outline: true,
        outlineColor: Cesium.Color.fromCssColorString("#ff2d55").withAlpha(0.95), outlineWidth: 2,
        height: 0, heightReference: Cesium.HeightReference.CLAMP_TO_GROUND });
      zone.show = incidentsVisible;
    }
    for (const entity of [...source.entities.values]) if (!desired.has(entity.id)) source.entities.remove(entity);
    const feed = element(".sauron-feed"); feed.replaceChildren();
    for (const row of state.activeIncidents()) {
      const report = state.reports.get(row.id);
      const button = document.createElement("button");
      button.textContent = report
        ? `MANUAL · ${row.status.toUpperCase()} · ${report.title}`
        : `${row.status.toUpperCase()} · ${state.cameras.get(row.cameraId)?.name ?? row.cameraId}`;
      button.onclick = () => select("incident", row.id); feed.append(button);
    }
    if (!feed.childElementCount) feed.textContent = "No active incidents detected.";
    const deepLink = /^\/incident\/([^/]+)$/.exec(location.pathname);
    if (!restoredDeepLink && deepLink) {
      try {
        const id = decodeURIComponent(deepLink[1]);
        if (state.incidents.has(id)) { restoredDeepLink = true; select("incident", id); }
      } catch { restoredDeepLink = true; }
    }
    renderDetail(); viewer.scene.requestRender();
  }
  panel.addEventListener("change", event => {
    const input = event.target as HTMLInputElement;
    if (input.dataset.layer === "cameras") camerasVisible = input.checked;
    if (input.dataset.layer === "incidents") incidentsVisible = input.checked;
    reconcile();
  });
  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  handler.setInputAction((event: { position: Cesium.Cartesian2 }) => {
    const picked = viewer.scene.pick(event.position);
    if (!(picked?.id instanceof Cesium.Entity)) return;
    const kind = picked.id.properties?.sauronKind?.getValue(viewer.clock.currentTime);
    const id = picked.id.properties?.sauronId?.getValue(viewer.clock.currentTime);
    if (kind && id) select(kind, id);
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  const unsubscribe = state.subscribe(reconcile);
  reconcile();
  const disposeBroadcastUi = mountBroadcastUi();
  const disposeWatchAreas = mountWatchAreas(viewer, state, connection.db, navigation);
  const disposeReportEvent = mountReportEvent(viewer, state);
  const disposeIrisSafety = mountIrisSafety(viewer, state);
  return () => { alive = false; unsubscribe(); connection.disconnect(); handler.destroy();
    viewer.dataSources.remove(source, true); panel.remove(); disposeBroadcastUi(); disposeWatchAreas(); disposeReportEvent(); disposeIrisSafety(); };
}

import * as Cesium from "cesium";
import { HAZARD_LABELS, REPORTABLE_HAZARDS } from "@tempmhacks/shared";
import { estimateReach } from "./danger";
import { pickLonLat } from "./globe-pick";
import { LiveState } from "./live-state";
import { forgetOperatorSecret, operatorSecret, reportIncident } from "./photon-client";
import "./report-event.css";

const DEFAULT_RADIUS_KM = 1;
const MIN_RADIUS_KM = 0.1;
const MAX_RADIUS_KM = 25;

type Draft = { longitude: number; latitude: number; radiusKm: number; type: string; title: string; description: string };

/**
 * Manual "dangerous event" reporting, for when no camera has seen it (or the detector isn't
 * trusted). Toggle "Report event", click the globe, set the danger zone and describe it, then send.
 * Photon turns it into a confirmed incident: phones in or near the zone get an iMessage alert and
 * the help agent offers a way out. Saved reports render through the Activity layer, not here.
 */
export function mountReportEvent(viewer: Cesium.Viewer, state: LiveState): () => void {
  let alive = true;
  let placing = false;
  let sending = false;
  let draft: Draft | undefined;

  const source = new Cesium.CustomDataSource("sauron-report-draft");
  void viewer.dataSources.add(source);

  const root = document.createElement("div");
  root.className = "report-ui";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "report-toggle";
  toggle.textContent = "Report event";
  toggle.setAttribute("aria-pressed", "false");
  toggle.title = "Mark a dangerous area and alert phones inside it";
  const form = document.createElement("div");
  form.className = "watch-form report-form";
  form.hidden = true;
  form.setAttribute("role", "dialog");
  form.setAttribute("aria-label", "Report a dangerous event");
  root.append(toggle, form);
  document.body.append(root);

  function setPlacing(next: boolean) {
    placing = next;
    toggle.setAttribute("aria-pressed", String(placing));
    toggle.classList.toggle("active", placing);
    viewer.canvas.style.cursor = placing ? "crosshair" : "";
    if (!placing) { draft = undefined; form.hidden = true; renderDraft(); }
  }

  function renderDraft() {
    source.entities.removeAll();
    if (draft) {
      source.entities.add({
        id: "report:__draft__",
        position: Cesium.Cartesian3.fromDegrees(draft.longitude, draft.latitude),
        ellipse: new Cesium.EllipseGraphics({
          semiMajorAxis: draft.radiusKm * 1000, semiMinorAxis: draft.radiusKm * 1000,
          material: Cesium.Color.fromCssColorString("#ff2d55").withAlpha(0.25),
          outline: true, outlineColor: Cesium.Color.fromCssColorString("#ff2d55"), outlineWidth: 2,
          height: 0, heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        }),
        point: new Cesium.PointGraphics({
          pixelSize: 10, color: Cesium.Color.fromCssColorString("#ff2d55"),
          outlineColor: Cesium.Color.BLACK, outlineWidth: 2,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY,
        }),
      });
    }
    viewer.scene.requestRender();
  }

  const reach = () => draft ? estimateReach(draft, draft.radiusKm, state.watches.values(), state.profiles.values()) : 0;
  const reachText = () => {
    const n = reach();
    return n === 0 ? "No enrolled phones are in range yet." : `Up to ${n} enrolled phone${n === 1 ? "" : "s"} in range will be alerted.`;
  };

  function renderForm() {
    if (!draft) { form.hidden = true; return; }
    form.hidden = false;
    form.innerHTML = `
      <header class="watch-form-head">
        <strong>REPORT DANGEROUS EVENT</strong>
        <button type="button" class="watch-close" aria-label="Cancel">✕</button>
      </header>
      <p class="watch-coords">${draft.latitude.toFixed(4)}, ${draft.longitude.toFixed(4)}</p>
      <label class="watch-label" for="report-type">What is happening</label>
      <select id="report-type" class="watch-input">
        ${REPORTABLE_HAZARDS.map(type => `<option value="${type}"${type === draft!.type ? " selected" : ""}>${escapeHtml(HAZARD_LABELS[type])}</option>`).join("")}
      </select>
      <label class="watch-label" for="report-title">Headline</label>
      <input id="report-title" class="watch-input" type="text" maxlength="120" placeholder="e.g. House fire on Elm St" value="${escapeHtml(draft.title)}" />
      <label class="watch-label" for="report-description">Details (optional)</label>
      <textarea id="report-description" class="watch-input report-textarea" maxlength="1000" rows="3" placeholder="What people nearby should know">${escapeHtml(draft.description)}</textarea>
      <label class="watch-label" for="report-radius">Danger zone: <span class="watch-radius-val">${draft.radiusKm} km</span></label>
      <input id="report-radius" class="watch-range" type="range" min="${MIN_RADIUS_KM}" max="${MAX_RADIUS_KM}" step="0.1" value="${draft.radiusKm}" />
      <p class="report-reach" aria-live="polite">${reachText()}</p>
      <div class="watch-actions">
        <button type="button" class="watch-save report-send">Send alert</button>
        <button type="button" class="watch-cancel">Cancel</button>
      </div>
      <p class="watch-error" role="alert"></p>
      <p class="watch-note">Phones in or near the zone get an iMessage alert, and the assistant offers each person a way out. This is not an official emergency warning; call 911 for emergencies.</p>`;
    const typeInput = form.querySelector<HTMLSelectElement>("#report-type")!;
    const titleInput = form.querySelector<HTMLInputElement>("#report-title")!;
    const descriptionInput = form.querySelector<HTMLTextAreaElement>("#report-description")!;
    const radiusInput = form.querySelector<HTMLInputElement>("#report-radius")!;
    typeInput.onchange = () => {
      if (!draft) return;
      // Offer the hazard as a starting headline until the operator writes their own.
      const wasDefault = !draft.title || draft.title === HAZARD_LABELS[draft.type as keyof typeof HAZARD_LABELS];
      draft.type = typeInput.value;
      if (wasDefault) { draft.title = HAZARD_LABELS[draft.type as keyof typeof HAZARD_LABELS]; titleInput.value = draft.title; }
    };
    titleInput.oninput = () => { if (draft) draft.title = titleInput.value; };
    descriptionInput.oninput = () => { if (draft) draft.description = descriptionInput.value; };
    radiusInput.oninput = () => {
      if (!draft) return;
      draft.radiusKm = Number(radiusInput.value);
      form.querySelector<HTMLElement>(".watch-radius-val")!.textContent = `${draft.radiusKm} km`;
      form.querySelector<HTMLElement>(".report-reach")!.textContent = reachText();
      renderDraft();
    };
    form.querySelector<HTMLButtonElement>(".watch-close")!.onclick = () => setPlacing(false);
    form.querySelector<HTMLButtonElement>(".watch-cancel")!.onclick = () => setPlacing(false);
    form.querySelector<HTMLButtonElement>(".report-send")!.onclick = send;
    titleInput.focus();
  }

  async function send() {
    if (!draft || sending) return;
    const err = form.querySelector<HTMLElement>(".watch-error")!;
    const title = draft.title.trim();
    if (!title) { err.textContent = "Add a headline so people know what is happening."; return; }
    const photonUrl = import.meta.env.VITE_PHOTON_URL?.trim();
    if (!photonUrl) { err.textContent = "Set VITE_PHOTON_URL to send alerts from the map."; return; }
    if (!window.confirm(`Send a danger alert for "${title}"?\n${reachText()}`)) return;
    const secret = operatorSecret();
    if (!secret) { err.textContent = "An operator key is needed to send alerts."; return; }
    sending = true;
    err.textContent = "";
    const button = form.querySelector<HTMLButtonElement>(".report-send")!;
    button.disabled = true;
    button.textContent = "Sending…";
    try {
      const result = await reportIncident(photonUrl, secret, {
        type: draft.type, latitude: draft.latitude, longitude: draft.longitude,
        radiusKm: draft.radiusKm, title, description: draft.description.trim(),
      });
      if (!alive) return;
      if (!result.ok) {
        if (result.reason === "unauthorized") forgetOperatorSecret();
        err.textContent = result.message;
        return;
      }
      // The incident streams back through the subscription and appears in Activity with its zone.
      setPlacing(false);
    } finally {
      sending = false;
      if (alive) { button.disabled = false; button.textContent = "Send alert"; }
    }
  }

  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  handler.setInputAction((event: { position: Cesium.Cartesian2 }) => {
    if (!placing || sending) return;
    const point = pickLonLat(viewer, event.position);
    if (!point) return;
    draft = {
      longitude: point.lon, latitude: point.lat,
      radiusKm: draft?.radiusKm ?? DEFAULT_RADIUS_KM,
      type: draft?.type ?? "fire",
      title: draft?.title ?? HAZARD_LABELS.fire,
      description: draft?.description ?? "",
    };
    renderDraft();
    renderForm();
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  toggle.onclick = () => setPlacing(!placing);
  // Switching to another header tool (e.g. Watch area) exits report mode, so only one mode places.
  const onHeaderClick = (event: MouseEvent) => {
    if (!placing || !(event.target instanceof Element)) return;
    const button = event.target.closest(".minimal-header button");
    if (button && button !== toggle) setPlacing(false);
  };
  document.addEventListener("click", onHeaderClick, true);
  const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape" && placing) setPlacing(false); };
  document.addEventListener("keydown", onKeyDown);

  return () => {
    alive = false;
    document.removeEventListener("click", onHeaderClick, true);
    document.removeEventListener("keydown", onKeyDown);
    handler.destroy();
    viewer.dataSources.remove(source, true);
    viewer.canvas.style.cursor = "";
    toggle.remove();
    root.remove();
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, ch =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] as string));
}

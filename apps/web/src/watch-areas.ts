import * as Cesium from "cesium";
import type { Watch } from "@tempmhacks/shared";
import type { Db } from "@tempmhacks/shared/db";
import { LiveState } from "./live-state";
import "./watch-areas.css";

type Navigation = { runImmediateNavigation(noun: string, navigate: () => void): void };

const DEFAULT_RADIUS_KM = 5;
const MIN_RADIUS_KM = 0.5;
const MAX_RADIUS_KM = 100;

/**
 * Click-to-select watch areas.
 *
 * Toggle "Watch area" mode, then click the globe to drop a highlighted circle.
 * Adjust its radius, label it, and save — this creates a Watch (via the
 * existing create_watch reducer) that the alert matcher uses to message phones
 * inside the circle when a confirmed incident lands within radius.
 *
 * Existing active watches render as circles too, so saved areas persist across
 * reloads. The scene interaction and rendering are self-contained; nothing in
 * the camera/incident logic changes.
 */
export function mountWatchAreas(
  viewer: Cesium.Viewer,
  state: LiveState,
  db: Db,
  navigation?: Navigation,
): () => void {
  let alive = true;
  let placing = false;
  let draft: { longitude: number; latitude: number; radiusKm: number; label: string; handle: string } | undefined;
  let saving = false;

  const source = new Cesium.CustomDataSource("sauron-watch-areas");
  void viewer.dataSources.add(source);

  // ---- UI: toggle button + draft form -------------------------------------
  const root = document.createElement("div");
  root.className = "watch-ui";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "watch-toggle";
  toggle.innerHTML = `Watch area`;
  toggle.setAttribute("aria-pressed", "false");
  const form = document.createElement("div");
  form.className = "watch-form";
  form.hidden = true;
  root.append(toggle, form);
  document.body.append(root);

  const errorText = () => form.querySelector<HTMLElement>(".watch-error");

  function setPlacing(next: boolean) {
    placing = next;
    toggle.setAttribute("aria-pressed", String(placing));
    toggle.classList.toggle("active", placing);
    viewer.canvas.style.cursor = placing ? "crosshair" : "";
    if (!placing) clearDraft();
  }

  function clearDraft() {
    draft = undefined;
    form.hidden = true;
    renderCircles();
  }

  // ---- Rendering -----------------------------------------------------------
  function circleEntity(id: string, lon: number, lat: number, radiusKm: number, label: string, isDraft: boolean) {
    const existing = source.entities.getById(id);
    const entity = existing ?? source.entities.add({ id });
    entity.position = new Cesium.ConstantPositionProperty(Cesium.Cartesian3.fromDegrees(lon, lat));
    entity.ellipse = new Cesium.EllipseGraphics({
      semiMajorAxis: radiusKm * 1000,
      semiMinorAxis: radiusKm * 1000,
      material: Cesium.Color.fromCssColorString(isDraft ? "#ff8a7a" : "#ff3b30").withAlpha(isDraft ? 0.22 : 0.18),
      outline: true,
      outlineColor: Cesium.Color.fromCssColorString(isDraft ? "#ff9d90" : "#ff3b30").withAlpha(0.95),
      outlineWidth: 2,
      height: 0,
      heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
    });
    entity.point = new Cesium.PointGraphics({
      pixelSize: 7,
      color: Cesium.Color.fromCssColorString(isDraft ? "#ff9d90" : "#ff3b30"),
      outlineColor: Cesium.Color.BLACK,
      outlineWidth: 2,
      heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    });
    entity.label = new Cesium.LabelGraphics({
      text: label,
      font: "600 13px 'JetBrains Mono', monospace",
      fillColor: Cesium.Color.WHITE,
      showBackground: true,
      backgroundColor: Cesium.Color.fromCssColorString("#071018").withAlpha(0.82),
      pixelOffset: new Cesium.Cartesian2(0, -18),
      verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      outlineColor: Cesium.Color.BLACK,
      outlineWidth: 2,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    });
    return entity;
  }

  function renderCircles() {
    const keep = new Set<string>();
    for (const watch of state.activeWatches()) {
      const id = `watch:${watch.id}`;
      keep.add(id);
      circleEntity(id, watch.longitude, watch.latitude, watch.radiusKm,
        `${watch.placeLabel} · ${watch.radiusKm}km`, false);
    }
    if (draft) {
      const id = "watch:__draft__";
      keep.add(id);
      circleEntity(id, draft.longitude, draft.latitude, draft.radiusKm,
        `${draft.label || "New area"} · ${draft.radiusKm}km`, true);
    }
    for (const entity of [...source.entities.values]) {
      if (!keep.has(entity.id)) source.entities.remove(entity);
    }
    viewer.scene.requestRender();
  }

  // ---- Draft form ----------------------------------------------------------
  function renderForm() {
    if (!draft) { form.hidden = true; return; }
    form.hidden = false;
    form.innerHTML = `
      <header class="watch-form-head">
        <strong>NEW WATCH AREA</strong>
        <button type="button" class="watch-close" aria-label="Cancel">✕</button>
      </header>
      <p class="watch-coords">${draft.latitude.toFixed(4)}, ${draft.longitude.toFixed(4)}</p>
      <label class="watch-label" for="watch-place">Area label</label>
      <input id="watch-place" class="watch-input" type="text" placeholder="e.g. Downtown" value="${escapeHtml(draft.label)}" />
      <label class="watch-label" for="watch-handle">Notify (enrolled recipient ID)</label>
      <input id="watch-handle" class="watch-input" type="text" placeholder="Recipient ID from alert enrollment" value="${escapeHtml(draft.handle)}" />
      <label class="watch-label" for="watch-radius">Radius: <span class="watch-radius-val">${draft.radiusKm} km</span></label>
      <input id="watch-radius" class="watch-range" type="range" min="${MIN_RADIUS_KM}" max="${MAX_RADIUS_KM}" step="0.5" value="${draft.radiusKm}" />
      <div class="watch-actions">
        <button type="button" class="watch-save">Save area</button>
        <button type="button" class="watch-cancel">Cancel</button>
      </div>
      <p class="watch-error" role="alert"></p>
      <p class="watch-note">Phones reported inside this circle receive a message when a confirmed incident lands within range.</p>`;

    const placeInput = form.querySelector<HTMLInputElement>("#watch-place")!;
    const handleInput = form.querySelector<HTMLInputElement>("#watch-handle")!;
    const radiusInput = form.querySelector<HTMLInputElement>("#watch-radius")!;
    const radiusVal = form.querySelector<HTMLElement>(".watch-radius-val")!;

    placeInput.oninput = () => { if (draft) { draft.label = placeInput.value; } };
    handleInput.oninput = () => { if (draft) { draft.handle = handleInput.value; } };
    radiusInput.oninput = () => {
      if (!draft) return;
      draft.radiusKm = Number(radiusInput.value);
      radiusVal.textContent = `${draft.radiusKm} km`;
      renderCircles();
    };
    form.querySelector<HTMLButtonElement>(".watch-close")!.onclick = () => setPlacing(false);
    form.querySelector<HTMLButtonElement>(".watch-cancel")!.onclick = () => setPlacing(false);
    form.querySelector<HTMLButtonElement>(".watch-save")!.onclick = save;
  }

  async function save() {
    if (!draft || saving) return;
    const label = draft.label.trim();
    const handle = draft.handle.trim();
    const err = errorText();
    if (!label) { if (err) err.textContent = "Add an area label."; return; }
    if (!handle) { if (err) err.textContent = "Add an enrolled recipient ID to notify."; return; }
    const profile = db.profiles.getForSender(handle) ?? db.profiles.get(handle);
    if (!profile) {
      if (err) err.textContent = "Recipient not found. Enroll in alerts first, then use your recipient ID.";
      return;
    }
    saving = true;
    if (err) err.textContent = "";
    const saveBtn = form.querySelector<HTMLButtonElement>(".watch-save");
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = "Saving…"; }
    const watch: Watch = {
      id: `watch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      spaceId: profile.spaceId,
      senderId: profile.senderId,
      placeLabel: label,
      latitude: draft.latitude,
      longitude: draft.longitude,
      radiusKm: draft.radiusKm,
      active: true,
      createdAt: Date.now(),
    };
    try {
      await db.watches.create(watch);
      // The subscription will stream the row back and renderCircles() picks it
      // up; drop the draft and leave placing mode on for rapid multi-add.
      draft = undefined;
      form.hidden = true;
      renderCircles();
    } catch (error) {
      if (alive && err) err.textContent = error instanceof Error ? error.message : "Could not save area";
    } finally {
      saving = false;
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = "Save area"; }
    }
  }

  // ---- Map click to place --------------------------------------------------
  function pickLonLat(position: Cesium.Cartesian2): { lon: number; lat: number } | undefined {
    const scene = viewer.scene;
    let cartesian: Cesium.Cartesian3 | undefined;
    // 1) Terrain/globe surface under the cursor (most accurate with a depth buffer).
    const ray = viewer.camera.getPickRay(position);
    if (ray) cartesian = scene.globe.pick(ray, scene) ?? undefined;
    // 2) Scene depth (works over 3D tiles / photorealistic buildings).
    if (!cartesian && scene.pickPositionSupported) {
      cartesian = scene.pickPosition(position) ?? undefined;
    }
    // 3) Ellipsoid intersection — always available, needs no depth buffer, so it
    //    is the reliable fallback (empty-space clicks, headless, globe hidden).
    if (!cartesian) {
      cartesian = viewer.camera.pickEllipsoid(position, scene.globe.ellipsoid) ?? undefined;
    }
    if (!cartesian) return;
    const carto = Cesium.Cartographic.fromCartesian(cartesian);
    if (!carto) return;
    return {
      lon: Cesium.Math.toDegrees(carto.longitude),
      lat: Cesium.Math.toDegrees(carto.latitude),
    };
  }

  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  handler.setInputAction((event: { position: Cesium.Cartesian2 }) => {
    if (!placing) return;
    const point = pickLonLat(event.position);
    if (!point) return;
    draft = {
      longitude: point.lon,
      latitude: point.lat,
      radiusKm: draft?.radiusKm ?? DEFAULT_RADIUS_KM,
      label: draft?.label ?? "",
      handle: draft?.handle ?? "",
    };
    renderCircles();
    renderForm();
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  toggle.onclick = () => setPlacing(!placing);
  // The toggle is moved into the header after this module mounts. Delegate
  // clicks so switching header tools also exits placement and clears the draft.
  const onHeaderClick = (event: MouseEvent) => {
    if (!placing || !(event.target instanceof Element)) return;
    const button = event.target.closest(".minimal-header button");
    if (button && button !== toggle) setPlacing(false);
  };
  document.addEventListener("click", onHeaderClick, true);
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && placing) setPlacing(false);
  };
  document.addEventListener("keydown", onKeyDown);

  const unsubscribe = state.subscribe(renderCircles);
  renderCircles();

  return () => {
    alive = false;
    unsubscribe();
    document.removeEventListener("click", onHeaderClick, true);
    document.removeEventListener("keydown", onKeyDown);
    handler.destroy();
    viewer.dataSources.remove(source, true);
    viewer.canvas.style.cursor = "";
    // The toggle may have been relocated into the header by minimal-ui; remove
    // it explicitly so it does not outlive this layer, then drop the wrapper.
    toggle.remove();
    root.remove();
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, ch =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] as string));
}

import "cesium/Build/Cesium/Widgets/widgets.css";
import "./evac/styles.css";
import type { Viewer } from "cesium";
import type { EvacSnapshot } from "@tempmhacks/shared/evac";
import { createGlobe } from "./evac/globe.js";
import { api, subscribe, type Catalog } from "./evac/api.js";
import { clockSeconds, escapeHtml } from "./evac/format.js";
import { EvacMapLayers } from "./evac/map-layers.js";
import { renderArrangement, renderHousehold, renderSources, renderTimeline } from "./evac/mission.js";
import { PhoneView } from "./evac/phone.js";

const root = document.querySelector<HTMLDivElement>("#app");
if (!root) throw new Error("App root is missing");

root.innerHTML = `
  <div class="shell">
    <header class="topbar">
      <a class="brand" href="/" aria-label="God's Eye Evacuation Assist home">
        <span class="brand-mark" aria-hidden="true"></span>
        <span class="brand-text"><strong>GOD'S EYE</strong><span>Evacuation Assist</span></span>
      </a>
      <div class="scenario">
        <p class="eyebrow">Scenario</p>
        <p id="scenario-title">Connecting to agent…</p>
      </div>
      <nav class="controls" aria-label="Demo controls">
        <button id="btn-warning" type="button" class="control control-warning"><span class="control-step">1</span>Issue official warning</button>
        <button id="btn-closure" type="button" class="control control-closure" disabled><span class="control-step">2</span>Verified road closure</button>
        <button id="btn-reset" type="button" class="control control-ghost">Reset</button>
      </nav>
      <div class="status-cluster">
        <span id="conn" class="conn conn-off" role="status">Offline</span>
        <time id="clock" class="clock"></time>
      </div>
    </header>

    <aside class="rail rail-left" id="resident-rail" aria-label="Resident conversation"></aside>

    <main class="stage">
      <section class="map-wrap" aria-label="Evacuation map">
        <div id="cesium-container" class="cesium-container"></div>
        <div id="globe-status" class="globe-status" role="status" aria-live="polite"><div class="loader" aria-hidden="true"></div><p>Initializing map</p></div>
        <div id="globe-error" class="globe-error" role="alert" hidden>
          <p class="eyebrow">Map unavailable</p>
          <h1>We couldn’t initialize the map.</h1>
          <p id="globe-error-message">Check your connection and try again.</p>
          <button id="retry-globe" type="button">Retry</button>
        </div>
        <div class="legend" aria-label="Map legend">
          <span><i class="lg lg-warning"></i>Official warning area</span>
          <span><i class="lg lg-route"></i>Active route</span>
          <span><i class="lg lg-pickup"></i>Driver to pickup</span>
          <span><i class="lg lg-old"></i>Replaced route</span>
          <span><i class="lg lg-closure"></i>Verified closure</span>
        </div>
        <button id="btn-frame" class="map-button" type="button" aria-label="Recenter map">Recenter</button>
        <div id="banner" class="banner" role="status" aria-live="polite" hidden></div>
        <article id="household" class="map-card household-card" aria-label="Household"></article>
        <details class="map-card sources-card">
          <summary><span class="eyebrow">Evidence &amp; channels</span><span id="sources-summary" class="muted"></span></summary>
          <div id="sources"></div>
        </details>
      </section>
      <section class="mission" aria-label="Arrangement status">
        <article id="arrangement" class="card card-arrangement"></article>
        <article class="card card-timeline">
          <div class="card-head"><div><p class="eyebrow">Agent activity</p><h2>Timeline</h2></div></div>
          <div id="timeline" class="timeline-wrap"></div>
        </article>
      </section>
    </main>

    <aside class="rail rail-right" id="helper-rail" aria-label="Helper conversation"></aside>
  </div>
`;

function element<T extends Element>(selector: string): T {
  const match = document.querySelector<T>(selector);
  if (!match) throw new Error(`Missing application element: ${selector}`);
  return match;
}

const ui = {
  scenario: element<HTMLElement>("#scenario-title"),
  warning: element<HTMLButtonElement>("#btn-warning"),
  closure: element<HTMLButtonElement>("#btn-closure"),
  reset: element<HTMLButtonElement>("#btn-reset"),
  frame: element<HTMLButtonElement>("#btn-frame"),
  conn: element<HTMLElement>("#conn"),
  clock: element<HTMLElement>("#clock"),
  household: element<HTMLElement>("#household"),
  arrangement: element<HTMLElement>("#arrangement"),
  timeline: element<HTMLElement>("#timeline"),
  sources: element<HTMLElement>("#sources"),
  sourcesSummary: element<HTMLElement>("#sources-summary"),
  banner: element<HTMLElement>("#banner"),
  status: element<HTMLElement>("#globe-status"),
  error: element<HTMLElement>("#globe-error"),
  errorMessage: element<HTMLElement>("#globe-error-message"),
  retry: element<HTMLButtonElement>("#retry-globe"),
  globe: element<HTMLElement>("#cesium-container"),
};

const sendMessage = (participantId: string, text: string) => api.sendMessage(participantId, text);
const resident = new PhoneView({ label: "Resident phone", role: "resident", send: sendMessage });
const helper = new PhoneView({ label: "Volunteer driver phone", role: "helper", send: sendMessage });
element<HTMLElement>("#resident-rail").append(railTitle("Resident", "Person who got the warning"), resident.element);
element<HTMLElement>("#helper-rail").append(railTitle("Enrolled helpers", "Volunteer drivers who opted in"), helper.element);

function railTitle(title: string, subtitle: string): HTMLElement {
  const header = document.createElement("div");
  header.className = "rail-title";
  header.innerHTML = `<p class="eyebrow">${escapeHtml(title)}</p><p class="muted">${escapeHtml(subtitle)}</p>`;
  return header;
}

let viewer: Viewer | undefined;
let layers: EvacMapLayers | undefined;
let snapshot: EvacSnapshot | undefined;
let catalog: Catalog | undefined;
let framed = false;

function initializeMap(): void {
  ui.status.hidden = false;
  ui.error.hidden = true;
  viewer?.destroy();
  ui.globe.replaceChildren();
  try {
    viewer = createGlobe(ui.globe);
    layers = new EvacMapLayers(viewer);
    framed = false;
    if (snapshot) render(snapshot);
    requestAnimationFrame(() => { ui.status.hidden = true; });
  } catch (error) {
    ui.status.hidden = true;
    ui.error.hidden = false;
    ui.errorMessage.textContent = error instanceof Error ? error.message : "Unknown map error";
  }
}

function render(next: EvacSnapshot): void {
  const previous = snapshot;
  snapshot = next;
  ui.scenario.textContent = next.scenario.title;
  const warned = next.warnings.length > 0;
  const closed = new Set(next.closures.map(c => c.id));
  ui.warning.disabled = warned;
  ui.warning.classList.toggle("done", warned);
  const closure = catalog?.closures[0];
  ui.closure.disabled = !warned || !closure || closed.has(closure.id);
  ui.closure.classList.toggle("done", Boolean(closure && closed.has(closure.id)));
  ui.closure.title = closure ? closure.description : "";

  ui.household.innerHTML = renderHousehold(next);
  ui.arrangement.innerHTML = renderArrangement(next);
  ui.timeline.innerHTML = renderTimeline(next);
  ui.sources.innerHTML = renderSources(next);
  const healthy = next.sourceHealth.filter(s => s.ok).length + next.channels.filter(c => c.connected).length;
  ui.sourcesSummary.textContent = `${healthy}/${next.sourceHealth.length + next.channels.length} connected`;
  resident.update(next);
  helper.update(next);

  if (layers) {
    layers.update(next);
    if (!framed) { layers.frame(next.scenario.areaCenter, 0); framed = true; }
  }
  showBanner(previous, next);
}

/** Brief on-map callouts for the moments that matter in the demo. */
function showBanner(previous: EvacSnapshot | undefined, next: EvacSnapshot): void {
  if (!previous) return;
  const newest = next.timeline.at(-1);
  if (!newest || previous.timeline.some(event => event.id === newest.id)) return;
  const important: Partial<Record<typeof newest.kind, string>> = {
    warning: "banner-warning", closure: "banner-closure", reroute: "banner-route", confirmed: "banner-ok", checkin: "banner-ok",
  };
  const tone = important[newest.kind];
  if (!tone) return;
  ui.banner.className = `banner ${tone}`;
  ui.banner.innerHTML = `<strong>${escapeHtml(newest.title)}</strong>${newest.detail ? `<span>${escapeHtml(newest.detail)}</span>` : ""}`;
  ui.banner.hidden = false;
  window.clearTimeout(bannerTimer);
  bannerTimer = window.setTimeout(() => { ui.banner.hidden = true; }, 6000);
}
let bannerTimer = 0;

async function act(button: HTMLButtonElement, action: () => Promise<void>): Promise<void> {
  button.disabled = true;
  button.classList.add("busy");
  try { await action(); }
  catch (error) { alert(error instanceof Error ? error.message : String(error)); }
  finally { button.classList.remove("busy"); if (snapshot) render(snapshot); }
}

ui.warning.addEventListener("click", () => void act(ui.warning, () => api.issueWarning()));
ui.closure.addEventListener("click", () => void act(ui.closure, async () => {
  const closure = catalog?.closures[0];
  if (closure) await api.injectClosure(closure.id);
}));
ui.reset.addEventListener("click", () => void act(ui.reset, async () => {
  await api.reset();
  framed = false;
}));
ui.frame.addEventListener("click", () => { if (snapshot) layers?.frame(snapshot.scenario.areaCenter); });
ui.retry.addEventListener("click", initializeMap);

setInterval(() => {
  if (snapshot) ui.clock.textContent = clockSeconds(Date.now(), snapshot.scenario.timeZone);
}, 1000);

subscribe({
  onSnapshot: render,
  onTyping: (participantId, typing) => { resident.setTyping(participantId, typing); helper.setTyping(participantId, typing); },
  onConnection: connected => {
    ui.conn.textContent = connected ? "Agent live" : "Reconnecting…";
    ui.conn.className = `conn ${connected ? "conn-on" : "conn-off"}`;
    if (connected) api.catalog().then(value => { catalog = value; if (snapshot) render(snapshot); }).catch(() => undefined);
  },
});

window.addEventListener("beforeunload", () => viewer?.destroy(), { once: true });
initializeMap();

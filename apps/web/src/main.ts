import "cesium/Build/Cesium/Widgets/widgets.css";
import "./styles.css";
import type { Viewer } from "cesium";
import { connectDb } from "@tempmhacks/shared/db";
import type { Incident } from "@tempmhacks/shared";
import { createGlobe, demoCamera, focusIncident } from "./globe.js";
import { incidentIdFromPathname } from "./incident-route.js";

const root = document.querySelector<HTMLDivElement>("#app");
if (!root) throw new Error("App root is missing");

root.innerHTML = `
  <main class="app-shell">
    <header class="topbar">
      <a class="brand" href="/" aria-label="Firewatch home">
        <span class="brand-mark" aria-hidden="true"></span>
        <span>FIREWATCH</span>
      </a>
      <div class="system-state"><span></span> Demo environment</div>
    </header>

    <section class="globe-stage" aria-label="Interactive incident globe">
      <div id="cesium-container" class="cesium-container"></div>
      <div id="globe-status" class="globe-status" role="status" aria-live="polite">
        <div class="loader" aria-hidden="true"></div>
        <p>Initializing globe</p>
      </div>
      <div id="globe-error" class="globe-error" role="alert" hidden>
        <p class="eyebrow">Globe unavailable</p>
        <h1>We couldn’t initialize the map.</h1>
        <p id="globe-error-message">Check your connection and try again.</p>
        <button id="retry-globe" type="button">Retry</button>
      </div>

      <div class="coordinates" aria-hidden="true">
        ${demoCamera.latitude.toFixed(4)}° N&nbsp;&nbsp;${Math.abs(demoCamera.longitude).toFixed(4)}° W
      </div>
    </section>

    <button
      id="panel-toggle"
      class="panel-toggle"
      type="button"
      aria-controls="details-panel"
      aria-expanded="true"
    >
      <span class="toggle-open">Hide details</span>
      <span class="toggle-closed">Show details</span>
    </button>

    <aside id="details-panel" class="details-panel" aria-label="Camera or incident details">
      <div class="panel-heading">
        <div>
          <p id="detail-eyebrow" class="eyebrow">Demo camera</p>
          <h1 id="detail-title">${demoCamera.name}</h1>
        </div>
        <span id="detail-status" class="status-pill"><span></span> Online</span>
      </div>

      <dl class="detail-grid">
        <div><dt id="detail-id-label">Camera ID</dt><dd id="detail-id">${demoCamera.id}</dd></div>
        <div><dt id="detail-kind-label">Source</dt><dd id="detail-kind">Replay</dd></div>
        <div><dt>Latitude</dt><dd id="detail-latitude">${demoCamera.latitude.toFixed(4)}</dd></div>
        <div><dt>Longitude</dt><dd id="detail-longitude">${demoCamera.longitude.toFixed(4)}</dd></div>
      </dl>

      <div class="feed-placeholder">
        <span class="scan-line" aria-hidden="true"></span>
        <p id="detail-feed-title">Camera evidence feed</p>
        <small id="detail-feed-copy">Realtime video arrives in a later workstream</small>
      </div>

      <div class="panel-note">
        <span>01</span>
        <p id="detail-note">This marker is temporary and proves the globe shell, navigation, and panel interaction.</p>
      </div>
      <button id="retry-incident" class="incident-retry" type="button" hidden>Retry incident</button>
    </aside>
  </main>
`;

function element<T extends Element>(selector: string): T {
  const match = document.querySelector<T>(selector);
  if (!match) throw new Error(`Missing application element: ${selector}`);
  return match;
}

const panelToggle = element<HTMLButtonElement>("#panel-toggle");
const status = element<HTMLElement>("#globe-status");
const errorView = element<HTMLElement>("#globe-error");
const errorMessage = element<HTMLElement>("#globe-error-message");
const retryButton = element<HTMLButtonElement>("#retry-globe");
const globeContainer = element<HTMLElement>("#cesium-container");
const coordinates = element<HTMLElement>(".coordinates");
const detailEyebrow = element<HTMLElement>("#detail-eyebrow");
const detailTitle = element<HTMLElement>("#detail-title");
const detailStatus = element<HTMLElement>("#detail-status");
const detailIdLabel = element<HTMLElement>("#detail-id-label");
const detailId = element<HTMLElement>("#detail-id");
const detailKindLabel = element<HTMLElement>("#detail-kind-label");
const detailKind = element<HTMLElement>("#detail-kind");
const detailLatitude = element<HTMLElement>("#detail-latitude");
const detailLongitude = element<HTMLElement>("#detail-longitude");
const detailFeedTitle = element<HTMLElement>("#detail-feed-title");
const detailFeedCopy = element<HTMLElement>("#detail-feed-copy");
const detailNote = element<HTMLElement>("#detail-note");
const retryIncident = element<HTMLButtonElement>("#retry-incident");
const deepLinkedIncidentId = incidentIdFromPathname(window.location.pathname);

panelToggle.addEventListener("click", () => {
  const collapsed = document.body.classList.toggle("panel-collapsed");
  panelToggle.setAttribute("aria-expanded", String(!collapsed));
});

let viewer: Viewer | undefined;
let disconnectDatabase: (() => void) | undefined;

function showIncidentError(title: string, detail: string, retryable: boolean): void {
  detailEyebrow.textContent = "Incident";
  detailTitle.textContent = title;
  detailStatus.innerHTML = "<span></span> Unavailable";
  detailIdLabel.textContent = "Incident ID";
  detailId.textContent = deepLinkedIncidentId ?? "Invalid route";
  detailKindLabel.textContent = "State";
  detailKind.textContent = "Unavailable";
  detailFeedTitle.textContent = "Incident data unavailable";
  detailFeedCopy.textContent = detail;
  detailNote.textContent = "The map remains available while the incident data is retried.";
  retryIncident.hidden = !retryable;
}

function showIncident(incident: Incident): void {
  detailEyebrow.textContent = "Verified incident";
  detailTitle.textContent = incident.type;
  detailStatus.innerHTML = `<span></span> ${incident.status}`;
  detailIdLabel.textContent = "Incident ID";
  detailId.textContent = incident.id;
  detailKindLabel.textContent = "Type";
  detailKind.textContent = incident.type;
  detailLatitude.textContent = incident.latitude.toFixed(4);
  detailLongitude.textContent = incident.longitude.toFixed(4);
  detailFeedTitle.textContent = incident.status === "resolved" ? "Resolved incident" : "Live incident context";
  detailFeedCopy.textContent = `First detected ${new Date(incident.firstSeenAt).toLocaleString()}`;
  detailNote.textContent = incident.status === "resolved"
    ? "This incident has been resolved; its historical detail remains available."
    : `Last observed ${new Date(incident.lastSeenAt).toLocaleString()}.`;
  coordinates.textContent = `${Math.abs(incident.latitude).toFixed(4)}° ${incident.latitude < 0 ? "S" : "N"}  ${Math.abs(incident.longitude).toFixed(4)}° ${incident.longitude < 0 ? "W" : "E"}`;
  retryIncident.hidden = true;
}

async function loadDeepLinkedIncident(activeViewer: Viewer): Promise<void> {
  if (!deepLinkedIncidentId) return;
  detailEyebrow.textContent = "Incident";
  detailTitle.textContent = "Loading incident…";
  retryIncident.hidden = true;
  const uri = import.meta.env.VITE_SPACETIMEDB_URI?.trim();
  const databaseName = import.meta.env.VITE_SPACETIMEDB_DATABASE?.trim();
  if (!uri || !databaseName) {
    showIncidentError("Incident unavailable", "Web database settings are not configured.", true);
    return;
  }
  try {
    disconnectDatabase?.();
    const database = await connectDb({ uri, database: databaseName });
    disconnectDatabase = database.disconnect;
    const incident = database.db.incidents.get(deepLinkedIncidentId);
    if (!incident) {
      showIncidentError("Incident not found", "No incident exists for this link.", false);
      return;
    }
    showIncident(incident);
    focusIncident(activeViewer, incident);
  } catch (error) {
    showIncidentError("Incident unavailable", error instanceof Error ? error.message : "Database unavailable.", true);
  }
}

function initialize(): void {
  status.hidden = false;
  errorView.hidden = true;
  viewer?.destroy();
  globeContainer.replaceChildren();

  try {
    viewer = createGlobe(globeContainer);
    void loadDeepLinkedIncident(viewer);
    requestAnimationFrame(() => {
      status.hidden = true;
    });
  } catch (error) {
    status.hidden = true;
    errorView.hidden = false;
    errorMessage.textContent = error instanceof Error ? error.message : "Unknown globe error";
  }
}

retryButton.addEventListener("click", initialize);
retryIncident.addEventListener("click", () => { if (viewer) void loadDeepLinkedIncident(viewer); });
window.addEventListener("beforeunload", () => {
  disconnectDatabase?.();
  viewer?.destroy();
}, { once: true });
initialize();

import "cesium/Build/Cesium/Widgets/widgets.css";
import "./styles.css";
import type { Viewer } from "cesium";
import { createGlobe, demoCamera } from "./globe.js";

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

    <aside id="details-panel" class="details-panel" aria-label="Camera details">
      <div class="panel-heading">
        <div>
          <p class="eyebrow">Demo camera</p>
          <h1>${demoCamera.name}</h1>
        </div>
        <span class="status-pill"><span></span> Online</span>
      </div>

      <dl class="detail-grid">
        <div><dt>Camera ID</dt><dd>${demoCamera.id}</dd></div>
        <div><dt>Source</dt><dd>Replay</dd></div>
        <div><dt>Latitude</dt><dd>${demoCamera.latitude.toFixed(4)}</dd></div>
        <div><dt>Longitude</dt><dd>${demoCamera.longitude.toFixed(4)}</dd></div>
      </dl>

      <div class="feed-placeholder">
        <span class="scan-line" aria-hidden="true"></span>
        <p>Camera evidence feed</p>
        <small>Realtime video arrives in a later workstream</small>
      </div>

      <div class="panel-note">
        <span>01</span>
        <p>This marker is temporary and proves the globe shell, navigation, and panel interaction.</p>
      </div>
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

panelToggle.addEventListener("click", () => {
  const collapsed = document.body.classList.toggle("panel-collapsed");
  panelToggle.setAttribute("aria-expanded", String(!collapsed));
});

let viewer: Viewer | undefined;

function initialize(): void {
  status.hidden = false;
  errorView.hidden = true;
  viewer?.destroy();
  globeContainer.replaceChildren();

  try {
    viewer = createGlobe(globeContainer);
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
window.addEventListener("beforeunload", () => viewer?.destroy(), { once: true });
initialize();

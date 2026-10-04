import { createStandaloneApplication } from './standalone/application.js';
import { describeError } from './standalone/errors.js';
import { mountSauron } from '../../src/integration.ts';
import { mountMinimalUi } from '../../src/minimal-ui.ts';

// Select the simplified shell before optional tools initialize.
document.body.dataset.interface = 'minimal';

const application = createStandaloneApplication({
  googleApiKey: import.meta.env.GOOGLE_MAPS_API_KEY,
  cesiumToken: import.meta.env.CESIUM_ION_TOKEN,
  allowQaRegistration: import.meta.env.DEV,
});

let disposeSauron;
let disposeMinimalUi;
application.start().then(async (components) => {
  await components.controls.styleManager.initialRestorePromise;
  disposeSauron = mountSauron(components);
  disposeMinimalUi = mountMinimalUi();
  // Keep camera layers available; park the other overlays for this phase.
  const manager = window.__iris.dataManager;
  await Promise.all([...manager.layers.keys()]
    .filter(id => id !== "cctv")
    .map(id => manager.setEnabled(id, false)));
}).catch((error) => {
  console.error("Iris initialization failed:", error);
  const loaderStatus = document.querySelector('#loading-screen .loader-status');
  loaderStatus.textContent = `Error: ${describeError(error)}`;
  loaderStatus.style.color = '#ff4444';
});

window.addEventListener('pagehide', () => {
  disposeMinimalUi?.();
  disposeSauron?.();
  void application.destroy();
}, { once: true });

export { application };

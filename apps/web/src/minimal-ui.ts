import './minimal-ui.css';

/** The slice of the reference app's layer manager this UI uses. */
interface TrafficLayerManager {
  isEffectivelyEnabled(id: string): boolean;
  setEnabled(id: string, enabled: boolean, options?: { origin?: string }): Promise<unknown>;
  subscribe(callback: () => void): () => void;
}

/** Presentation only: reuse the existing controls without changing scene state. */
export function mountMinimalUi(): () => void {
  const root = document.createElement('div');
  root.className = 'minimal-ui';
  root.innerHTML = `
    <header class="minimal-header">
      <span class="spy-corner spy-corner-tl" aria-hidden="true"></span><span class="spy-corner spy-corner-tr" aria-hidden="true"></span>
      <span class="spy-corner spy-corner-bl" aria-hidden="true"></span><span class="spy-corner spy-corner-br" aria-hidden="true"></span>
      <a class="minimal-brand" href="/" aria-label="Iris home">
        <span class="brand-mark" aria-hidden="true"><img src="/iris-logo.png" alt="" width="36" height="36" /></span>
        <span class="brand-text"><span class="brand-name">IRIS</span></span>
      </a>
      <div class="minimal-search"><span class="search-prompt" aria-hidden="true">&gt; LOCATE:</span></div>
      <nav class="minimal-actions" aria-label="Workspace">
        <button type="button" data-cameras aria-pressed="false">Cameras</button>
        <button type="button" data-activity aria-pressed="false">Activity</button>
      </nav>
      <span class="minimal-uplink" data-state="sync" role="status" aria-label="Database link status"><span aria-hidden="true">░▒▓</span></span>
    </header>
    <div class="minimal-loading-status"></div>
    <aside class="minimal-camera-host" aria-label="Camera viewer" hidden></aside>
    <aside class="minimal-activity-host" aria-label="Monitored cameras and incidents" hidden></aside>
    <footer class="minimal-footer">
      <span class="minimal-caption"><span aria-hidden="true">░▒▓</span> EXPLORE THE WORLD <small>Drag to move · Scroll to zoom</small></span>
      <div class="minimal-voice"></div>
    </footer>`;
  document.body.append(root);
  document.body.classList.add('minimal-ui-enabled');
  const disposers: (() => void)[] = [];
  const moved: { element: HTMLElement; placeholder: Comment }[] = [];
  function move(selector: string, host: string) {
    const element = document.querySelector<HTMLElement>(selector);
    const destination = root.querySelector(host);
    if (!element || !destination) return;
    const placeholder = document.createComment(`Original position: ${selector}`);
    element.before(placeholder);
    destination.append(element);
    moved.push({ element, placeholder });
  }
  move('.location-search-wrap', '.minimal-search');
  move('#cctv-panel', '.minimal-camera-host');
  move('.sauron-panel', '.minimal-activity-host');
  move('#iris-voice-control', '.minimal-voice');
  for (const selector of ['#global-loading-status', '#traffic-sync-chip', '#cctv-sync-chip'])
    move(selector, '.minimal-loading-status');
  const header = root.querySelector<HTMLElement>('.minimal-header')!;
  const loadingStatus = root.querySelector<HTMLElement>('.minimal-loading-status')!;
  const alignLoadingStatus = () => {
    loadingStatus.style.top = `${header.getBoundingClientRect().bottom + 12}px`;
    document.body.style.setProperty('--minimal-loading-bottom', `${loadingStatus.getBoundingClientRect().bottom + 12}px`);
  };
  alignLoadingStatus();
  const headerObserver = new ResizeObserver(alignLoadingStatus);
  headerObserver.observe(header);
  headerObserver.observe(loadingStatus);
  disposers.push(() => {
    headerObserver.disconnect();
    document.body.style.removeProperty('--minimal-loading-bottom');
  });
  // Keep camera creation beside the viewer controls inside the Cameras panel.
  const addCamera = document.querySelector<HTMLButtonElement>('.broadcast-add-btn');
  if (addCamera) {
    const cameraActions = document.createElement('div');
    cameraActions.className = 'minimal-camera-actions';
    root.querySelector('.minimal-camera-host')!.prepend(cameraActions);
    move('.broadcast-add-btn', '.minimal-camera-actions');
  }
  // "Watch area" is the third evenly aligned workspace action.
  const watchToggle = document.querySelector<HTMLButtonElement>('.watch-toggle');
  const workspaceActions = root.querySelector<HTMLElement>('.minimal-actions');
  if (watchToggle && workspaceActions) {
    const placeholder = document.createComment('Original position: .watch-toggle');
    watchToggle.before(placeholder);
    workspaceActions.append(watchToggle);
    moved.push({ element: watchToggle, placeholder });
  }
  // Left toolbar: wipe every drawing on the globe (voice annotations and
  // hand-drawn marks share one board, so one clear covers both).
  const drawingsToolbar = document.getElementById('top-center-actions');
  if (drawingsToolbar) {
    const clearDrawings = document.createElement('button');
    clearDrawings.id = 'clear-drawings';
    clearDrawings.type = 'button';
    clearDrawings.title = 'Clear all drawings on the map';
    clearDrawings.setAttribute('aria-label', 'Clear all drawings on the map');
    clearDrawings.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16.2 3.8 20.2 7.8a1.5 1.5 0 0 1 0 2.1L11 19.1H6.6l-2.8-2.8a1.5 1.5 0 0 1 0-2.1L14.1 3.8a1.5 1.5 0 0 1 2.1 0Z"/><path d="m9 8.9 6.1 6.1"/><path d="M11 19.1h9"/></svg>`;
    clearDrawings.onclick = () => {
      const iris = window as unknown as {
        __irisDrawTool?: { clearAll?: () => void };
        __irisAnnotations?: { clear?: () => void };
      };
      // The draw tool's clear also resets a shape still being drawn.
      if (iris.__irisDrawTool?.clearAll) iris.__irisDrawTool.clearAll();
      else iris.__irisAnnotations?.clear?.();
    };
    drawingsToolbar.append(clearDrawings);
    disposers.push(() => clearDrawings.remove());
  }
  const search = root.querySelector<HTMLInputElement>('#location-search');
  if (search) search.placeholder = 'city, address, or lat,lon';
  // Mirror the database link state from the Activity panel's status text.
  const uplink = root.querySelector<HTMLElement>('.minimal-uplink')!;
  const linkStatus = document.querySelector<HTMLElement>('.sauron-status');
  const syncUplink = () => {
    const text = linkStatus?.textContent?.toLowerCase() ?? '';
    const state = text.includes('live') ? 'secure' : text.includes('connecting') || !text ? 'sync' : 'offline';
    uplink.dataset.state = state;
    uplink.setAttribute('aria-label', linkStatus?.textContent || 'Database link status');
  };
  syncUplink();
  if (linkStatus) {
    const observer = new MutationObserver(syncUplink);
    observer.observe(linkStatus, { childList: true, characterData: true, subtree: true });
    disposers.push(() => observer.disconnect());
  }
  // Live traffic (TomTom flow) toggle, stacked under the existing globe actions.
  const leftToolbar = document.getElementById('top-center-actions');
  const layers = (window as unknown as { __iris?: { dataManager?: TrafficLayerManager } }).__iris?.dataManager;
  if (leftToolbar && layers) {
    const traffic = document.createElement('button');
    traffic.type = 'button';
    traffic.id = 'traffic-toggle-btn';
    traffic.title = 'Toggle live traffic';
    traffic.setAttribute('aria-label', 'Live traffic');
    traffic.innerHTML = `<svg class="traffic-toggle-icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M18.92 6.01C18.72 5.42 18.16 5 17.5 5h-11c-.66 0-1.21.42-1.42 1.01L3 12v8c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1h12v1c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-8l-2.08-5.99zM6.5 16c-.83 0-1.5-.67-1.5-1.5S5.67 13 6.5 13s1.5.67 1.5 1.5S7.33 16 6.5 16zm11 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zM5 11l1.5-4.5h11L19 11H5z"/></svg>`;
    const sync = () => traffic.setAttribute('aria-pressed', String(layers.isEffectivelyEnabled('traffic')));
    traffic.onclick = () => {
      const next = !layers.isEffectivelyEnabled('traffic');
      traffic.setAttribute('aria-pressed', String(next));
      void layers.setEnabled('traffic', next, { origin: 'user' }).finally(sync);
    };
    leftToolbar.append(traffic);
    sync();
    const unsubscribe = layers.subscribe(sync);
    disposers.push(() => { unsubscribe(); traffic.remove(); });
  }
  // Reuse the compact radio control so playback, station selection, and errors
  // follow the existing player without opening the old radio panel.
  const radioTrigger = document.getElementById('context-radio-mini-enable-btn');
  if (leftToolbar && radioTrigger instanceof HTMLButtonElement) {
    const radio = document.createElement('button');
    radio.type = 'button';
    radio.id = 'fm-radio-toggle-btn';
    radio.textContent = 'FM';
    const syncRadio = () => {
      const enabled = radioTrigger.getAttribute('aria-pressed') === 'true';
      const busy = radioTrigger.getAttribute('aria-busy') === 'true';
      radio.setAttribute('aria-pressed', String(enabled));
      radio.setAttribute('aria-busy', String(busy));
      radio.disabled = busy || radioTrigger.disabled || radioTrigger.getAttribute('aria-disabled') === 'true';
      radio.title = enabled ? 'Turn off FM radio' : 'Turn on FM radio';
      radio.setAttribute('aria-label', radio.title);
    };
    radio.onclick = () => {
      if (radio.disabled) return;
      radioTrigger.click();
      syncRadio();
    };
    leftToolbar.append(radio);
    syncRadio();
    const observer = new MutationObserver(syncRadio);
    observer.observe(radioTrigger, { attributes: true, attributeFilter: ['aria-pressed', 'aria-busy', 'aria-disabled', 'disabled'] });
    disposers.push(() => { observer.disconnect(); radio.remove(); });
  }
  for (const name of ['cameras', 'activity']) {
    const button = root.querySelector<HTMLButtonElement>(`[data-${name}]`)!;
    const host = root.querySelector<HTMLElement>(name === 'cameras' ? '.minimal-camera-host' : '.minimal-activity-host')!;
    button.onclick = (event) => {
      host.hidden = !host.hidden;
      button.setAttribute('aria-pressed', String(!host.hidden));
      if (!host.hidden) {
        const other = name === 'cameras' ? 'activity' : 'cameras';
        root.querySelector<HTMLElement>(other === 'cameras' ? '.minimal-camera-host' : '.minimal-activity-host')!.hidden = true;
        root.querySelector(`[data-${other}]`)!.setAttribute('aria-pressed', 'false');
      }
      if (name === 'cameras' && !host.hidden) {
        const panel = document.getElementById('cctv-panel');
        if (panel?.classList.contains('collapsed')) panel.querySelector<HTMLButtonElement>('.panel-collapse-btn')?.click();
      }
      // Pointer clicks can retain a focus-visible ring from an earlier keyboard
      // interaction. Keyboard activation has detail 0 and keeps its focus.
      if (event.detail > 0) button.blur();
    };
  }
  return () => {
    for (const dispose of disposers) dispose();
    for (const { element, placeholder } of moved.reverse()) placeholder.replaceWith(element);
    root.remove();
    document.body.classList.remove('minimal-ui-enabled');
  };
}

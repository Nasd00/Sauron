/** Build the voice control independently of its connection backend. */
export function createVoiceControl({ reset = false } = {}) {
  let root = document.getElementById('iris-voice-control');
  if (root && reset) {
    root.remove();
    root = null;
  }
  if (!root) {
    root = document.createElement('div');
    root.id = 'iris-voice-control';
    root.dataset.status = 'idle';
    root.dataset.speaker = 'idle';
    root.innerHTML = `
      <div class="iris-voice-heading">
        <div class="iris-voice-kicker">AI AGENT</div>
        <div id="iris-voice-status">OFF</div>
        <div class="iris-voice-cost">
          <button id="iris-voice-tier" class="iris-voice-tier-btn" type="button" aria-pressed="false" title="Voice model tier — applies next session">STD</button>
          <span id="iris-voice-cost-value" class="iris-voice-cost-value" data-level="ok" title="Estimated session cost">~$0.00</span>
        </div>
      </div>
      <button id="iris-voice-button" type="button" aria-label="Voice control — activate to toggle voice; hold Space to speak" aria-describedby="iris-voice-help">
        <span class="iris-mic-orbit"><img src="/mic.svg" alt="" /></span>
        <span class="iris-mic-label">ON/OFF</span>
      </button>
      <div class="iris-voice-visualizer" aria-hidden="true">
        ${Array.from({ length: 15 }, (_, index) => `<span style="--bar:${index}"></span>`).join('')}
      </div>
      <div class="iris-voice-readout">
        <div id="iris-voice-detail">VOICE STANDBY</div>
      </div>
      <div id="iris-voice-help" class="iris-voice-help-tray" role="tooltip">
        <span class="iris-voice-help-kicker">VOICE CONTROL</span>
        <span class="iris-voice-help-detail">Hold Space to speak · tap Space to activate focused controls</span>
      </div>
      <div class="iris-voice-error-tray" role="alert" aria-live="assertive">
        <div class="iris-voice-error-header">
          <span>VOICE SYSTEM ERROR</span>
          <button class="iris-voice-error-dismiss" type="button">DISMISS</button>
        </div>
        <div id="iris-voice-error-detail"></div>
        <div class="iris-voice-error-hint">Check microphone permission and network access, then try again.</div>
      </div>
    `;
    const commandDock = document.getElementById('command-dock');
    if (commandDock) {
      const locationBar = document.getElementById('location-bar');
      const controlPanel = document.getElementById('control-panel');
      commandDock.appendChild(root);
      if (locationBar) commandDock.insertBefore(locationBar, root);
      if (controlPanel) commandDock.appendChild(controlPanel);
    } else {
      document.body.appendChild(root);
    }
    root
      .querySelector('.iris-voice-error-dismiss')
      ?.addEventListener('click', () => {
        root.classList.add('error-dismissed');
      });
  }
  return {
    root,
    button: root.querySelector('#iris-voice-button'),
    buttonLabel: root.querySelector('.iris-mic-label'),
    status: root.querySelector('#iris-voice-status'),
    detail: root.querySelector('#iris-voice-detail'),
    helpDetail: root.querySelector('.iris-voice-help-detail'),
    errorDetail: root.querySelector('#iris-voice-error-detail'),
    tierButton: root.querySelector('#iris-voice-tier'),
    costValue: root.querySelector('#iris-voice-cost-value'),
  };
}

import QRCode from "qrcode";
import "./broadcast-ui.css";

/**
 * "Add camera" affordance: a floating button that opens a dialog with a link
 * and QR code to the /broadcast page. Scanning it on a phone (or opening the
 * link) turns that phone's camera into a live CCTV camera on the globe.
 *
 * Self-contained and independent of the Sauron panel so it can mount/unmount
 * without touching the camera/incident logic.
 */
export function mountBroadcastUi(): () => void {
  const root = document.createElement("div");
  root.className = "broadcast-ui";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "broadcast-add-btn";
  button.innerHTML = `<span class="broadcast-add-icon" aria-hidden="true">＋</span>Add camera`;
  button.setAttribute("aria-haspopup", "dialog");

  const dialog = document.createElement("dialog");
  dialog.className = "broadcast-dialog";
  dialog.setAttribute("aria-label", "Broadcast a phone camera");

  root.append(button, dialog);
  document.body.append(root);

  const newId = () => `phone-${Math.random().toString(36).slice(2, 10)}`;
  let currentId = newId();

  const isLocalHost = (h: string) =>
    h === "localhost" || h === "127.0.0.1" || h === "::1" || h.endsWith(".localhost");

  // The broadcast link must be reachable FROM THE PHONE. If the desktop app is
  // open on localhost, a localhost link is useless on another device, so let
  // the user supply the computer's LAN host:port. Default to the current host
  // when it is already a network address.
  let hostOverride = isLocalHost(location.hostname) ? "" : location.host;

  const broadcastUrl = (id: string) => {
    const host = hostOverride.trim() || location.host;
    const url = new URL(`${location.protocol}//${host}/broadcast`);
    url.searchParams.set("id", id);
    return url.href;
  };

  async function render() {
    const url = broadcastUrl(currentId);
    const localWarning = isLocalHost(new URL(url).hostname)
      ? `<p class="broadcast-warn">⚠ This link points at <b>localhost</b>, which your phone can't reach.
          Enter this computer's network address (e.g. <code>192.168.0.19:4173</code>) below.</p>`
      : "";
    let qr = "";
    try {
      qr = await QRCode.toString(url, {
        type: "svg",
        margin: 2,
        width: 240,
        color: { dark: "#0a0a0a", light: "#f2f1ec" },
        errorCorrectionLevel: "M",
      });
    } catch {
      qr = `<p class="broadcast-qr-fail">QR unavailable — use the link below.</p>`;
    }
    dialog.innerHTML = `
      <header class="broadcast-dialog-head">
        <strong>ADD A LIVE CAMERA</strong>
        <button type="button" class="broadcast-close" aria-label="Close">✕</button>
      </header>
      <p class="broadcast-hint">On your phone, scan this code or open the link. Allow
        camera + location, then press start — it appears here as a live CCTV camera.</p>
      ${localWarning}
      <label class="broadcast-url-label" for="broadcast-host">Computer address (host:port)</label>
      <div class="broadcast-url-row">
        <input id="broadcast-host" class="broadcast-url" type="text"
          placeholder="192.168.0.19:4173" value="${hostOverride}" />
        <button type="button" class="broadcast-apply">Set</button>
      </div>
      <div class="broadcast-qr">${qr}</div>
      <label class="broadcast-url-label" for="broadcast-url">Broadcast link</label>
      <div class="broadcast-url-row">
        <input id="broadcast-url" class="broadcast-url" type="text" readonly value="${url}" />
        <button type="button" class="broadcast-copy">Copy</button>
      </div>
      <div class="broadcast-actions">
        <button type="button" class="broadcast-open">Open here</button>
        <button type="button" class="broadcast-regen">New camera ID</button>
      </div>
      <p class="broadcast-note">Camera access needs HTTPS or localhost. On a phone,
        reach this computer over your network address (not localhost).</p>`;

    dialog.querySelector<HTMLButtonElement>(".broadcast-close")!.onclick = () => dialog.close();
    const applyHost = () => {
      hostOverride = dialog.querySelector<HTMLInputElement>("#broadcast-host")!.value.trim();
      void render();
    };
    dialog.querySelector<HTMLButtonElement>(".broadcast-apply")!.onclick = applyHost;
    dialog.querySelector<HTMLInputElement>("#broadcast-host")!.addEventListener("keydown", e => {
      if (e.key === "Enter") applyHost();
    });
    dialog.querySelector<HTMLButtonElement>(".broadcast-copy")!.onclick = async () => {
      try {
        await navigator.clipboard.writeText(url);
        const b = dialog.querySelector<HTMLButtonElement>(".broadcast-copy")!;
        b.textContent = "Copied";
        setTimeout(() => (b.textContent = "Copy"), 1500);
      } catch {
        dialog.querySelector<HTMLInputElement>(".broadcast-url")!.select();
      }
    };
    dialog.querySelector<HTMLButtonElement>(".broadcast-open")!.onclick = () => {
      window.open(url, "_blank", "noopener");
    };
    dialog.querySelector<HTMLButtonElement>(".broadcast-regen")!.onclick = () => {
      currentId = newId();
      void render();
    };
  }

  button.onclick = async () => {
    await render();
    if (!dialog.open) dialog.showModal();
  };
  dialog.addEventListener("click", event => {
    if (event.target === dialog) dialog.close();
  });

  return () => {
    if (dialog.open) dialog.close();
    root.remove();
  };
}

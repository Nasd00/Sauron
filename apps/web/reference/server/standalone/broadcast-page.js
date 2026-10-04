/**
 * Serves the standalone phone/browser broadcast page at /broadcast.
 *
 * The page is intentionally self-contained (no Cesium, no app bundle): a phone
 * opens the address, grants camera + location permission, and the page captures
 * frames and POSTs them to /api/cctv/ingest/:id/frame. The camera then appears
 * in the CCTV catalog and renders on the globe through the normal CCTV layer.
 *
 * Served as a tiny HTML+inline-JS document so it loads instantly on a phone and
 * works without the main application being initialized.
 */

const BROADCAST_HTML = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
  <meta name="color-scheme" content="dark" />
  <title>Broadcast — Iris CCTV</title>
  <style>
    :root { --bg:#05080c; --panel:#0d141c; --line:rgba(120,220,255,0.18);
            --accent:#50d9e8; --ok:#38d39f; --warn:#ffc56a; --err:#ff635d;
            --text:#e8f4f8; --muted:#8aa0ad; }
    * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
    html, body { margin:0; height:100%; background:var(--bg); color:var(--text);
      font-family: "JetBrains Mono", ui-monospace, Menlo, monospace; }
    body { display:flex; flex-direction:column; min-height:100dvh; padding:16px;
      gap:14px; padding-bottom: max(16px, env(safe-area-inset-bottom)); }
    header { display:flex; align-items:center; gap:10px; }
    header .mark { width:12px; height:12px; border-radius:50%; background:var(--accent);
      box-shadow:0 0 14px var(--accent); }
    header h1 { font-size:15px; letter-spacing:.14em; margin:0; font-weight:600; }
    header small { color:var(--muted); font-size:11px; letter-spacing:.1em; }
    .video-wrap { position:relative; width:100%; aspect-ratio:16/9; background:#01060a;
      border:1px solid var(--line); border-radius:12px; overflow:hidden; }
    video { width:100%; height:100%; object-fit:cover; display:block; background:#000; }
    .badge { position:absolute; top:10px; left:10px; display:flex; align-items:center;
      gap:7px; padding:5px 10px; border-radius:999px; font-size:11px; letter-spacing:.1em;
      background:rgba(0,0,0,.55); border:1px solid var(--line); }
    .badge .dot { width:8px; height:8px; border-radius:50%; background:var(--muted); }
    .badge.live .dot { background:var(--err); animation:pulse 1.4s infinite; }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.25} }
    .fields { display:grid; gap:10px; }
    label { display:block; font-size:11px; letter-spacing:.1em; color:var(--muted);
      margin-bottom:5px; text-transform:uppercase; }
    input { width:100%; padding:11px 12px; background:var(--panel); color:var(--text);
      border:1px solid var(--line); border-radius:9px; font:inherit; font-size:14px; }
    .row { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
    button { width:100%; padding:15px; border:none; border-radius:11px; font:inherit;
      font-size:15px; font-weight:600; letter-spacing:.08em; color:#02121a;
      background:var(--accent); cursor:pointer; }
    button.stop { background:var(--err); color:#1a0606; }
    button:disabled { opacity:.5; }
    .status { font-size:12px; color:var(--muted); min-height:18px; letter-spacing:.04em; }
    .status.ok { color:var(--ok); } .status.err { color:var(--err); }
    .hint { font-size:11px; color:var(--muted); line-height:1.5; }
    .spacer { flex:1; }
  </style>
</head>
<body>
  <header>
    <span class="mark"></span>
    <div>
      <h1>IRIS · BROADCAST</h1>
      <small>Turn this phone into a live CCTV camera</small>
    </div>
  </header>

  <div class="video-wrap">
    <video id="preview" playsinline autoplay muted></video>
    <div class="badge" id="badge"><span class="dot"></span><span id="badge-text">STANDBY</span></div>
  </div>

  <div class="fields">
    <div>
      <label for="name">Camera name</label>
      <input id="name" type="text" placeholder="e.g. North entrance" autocomplete="off" />
    </div>
    <div class="row">
      <div>
        <label for="heading">Heading °</label>
        <input id="heading" type="number" inputmode="numeric" value="0" min="0" max="359" />
      </div>
      <div>
        <label for="fov">Field of view °</label>
        <input id="fov" type="number" inputmode="numeric" value="70" min="20" max="120" />
      </div>
    </div>
    <div class="row">
      <div>
        <label for="lat">Latitude</label>
        <input id="lat" type="text" inputmode="decimal" placeholder="auto (GPS)" />
      </div>
      <div>
        <label for="lon">Longitude</label>
        <input id="lon" type="text" inputmode="decimal" placeholder="auto (GPS)" />
      </div>
    </div>
  </div>

  <div class="status" id="status">Grant camera access to begin.</div>
  <button id="toggle">START BROADCAST</button>
  <p class="hint">Keep this screen on while broadcasting. Camera access needs HTTPS
    (or localhost). The camera disappears from the map shortly after you stop.</p>

  <div class="spacer"></div>

  <script type="module">
    const qp = new URLSearchParams(location.search);
    const cameraId = (qp.get('id') || 'phone-' + Math.random().toString(36).slice(2, 10)).trim();
    const FRAME_INTERVAL_MS = 500;
    const JPEG_QUALITY = 0.6;

    const els = {
      video: document.getElementById('preview'),
      badge: document.getElementById('badge'),
      badgeText: document.getElementById('badge-text'),
      name: document.getElementById('name'),
      heading: document.getElementById('heading'),
      fov: document.getElementById('fov'),
      lat: document.getElementById('lat'),
      lon: document.getElementById('lon'),
      status: document.getElementById('status'),
      toggle: document.getElementById('toggle'),
    };
    els.name.value = qp.get('name') || 'Phone camera';

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    let stream = null;
    let timer = null;
    let sending = false;
    let broadcasting = false;

    function setStatus(msg, kind) {
      els.status.textContent = msg;
      els.status.className = 'status' + (kind ? ' ' + kind : '');
    }
    function setBadge(text, live) {
      els.badgeText.textContent = text;
      els.badge.classList.toggle('live', !!live);
    }

    async function startCamera() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
        els.video.srcObject = stream;
        await els.video.play().catch(() => {});
        setStatus('Camera ready. Press start to broadcast.', 'ok');
        return true;
      } catch (err) {
        setStatus('Camera access denied or unavailable: ' + (err && err.name || err), 'err');
        return false;
      }
    }

    function fillGeolocation() {
      if (!navigator.geolocation) return;
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          if (!els.lat.value) els.lat.value = pos.coords.latitude.toFixed(6);
          if (!els.lon.value) els.lon.value = pos.coords.longitude.toFixed(6);
        },
        () => {},
        { enableHighAccuracy: true, timeout: 8000 },
      );
    }

    function metadata() {
      return {
        name: els.name.value || 'Phone camera',
        lat: parseFloat(els.lat.value),
        lon: parseFloat(els.lon.value),
        headingDeg: parseFloat(els.heading.value) || 0,
        fovDeg: parseFloat(els.fov.value) || 70,
      };
    }

    async function register() {
      const meta = metadata();
      if (!Number.isFinite(meta.lat) || !Number.isFinite(meta.lon)) {
        setStatus('Need a latitude and longitude (allow location or type them).', 'err');
        return false;
      }
      const res = await fetch('/api/cctv/ingest/' + encodeURIComponent(cameraId) + '/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(meta),
      });
      if (!res.ok) { setStatus('Registration failed (HTTP ' + res.status + ')', 'err'); return false; }
      return true;
    }

    async function sendFrame() {
      if (sending || !broadcasting) return;
      const v = els.video;
      if (!v.videoWidth || !v.videoHeight) return;
      sending = true;
      try {
        canvas.width = v.videoWidth;
        canvas.height = v.videoHeight;
        ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', JPEG_QUALITY));
        if (!blob || !broadcasting) return;
        const res = await fetch('/api/cctv/ingest/' + encodeURIComponent(cameraId) + '/frame', {
          method: 'POST',
          headers: { 'Content-Type': 'image/jpeg' },
          body: blob,
        });
        if (res.ok) setStatus('LIVE · streaming as "' + cameraId + '"', 'ok');
        else if (res.status === 404) { await register(); }
      } catch (err) {
        setStatus('Frame send failed: ' + (err && err.message || err), 'err');
      } finally {
        sending = false;
      }
    }

    async function start() {
      if (!stream && !(await startCamera())) return;
      if (!(await register())) return;
      broadcasting = true;
      setBadge('LIVE', true);
      els.toggle.textContent = 'STOP BROADCAST';
      els.toggle.classList.add('stop');
      timer = setInterval(sendFrame, FRAME_INTERVAL_MS);
      sendFrame();
    }

    async function stop() {
      broadcasting = false;
      clearInterval(timer); timer = null;
      setBadge('STANDBY', false);
      els.toggle.textContent = 'START BROADCAST';
      els.toggle.classList.remove('stop');
      setStatus('Broadcast stopped.', '');
      try {
        await fetch('/api/cctv/ingest/' + encodeURIComponent(cameraId) + '/offline', {
          method: 'POST', keepalive: true,
        });
      } catch {}
    }

    els.toggle.addEventListener('click', () => (broadcasting ? stop() : start()));
    window.addEventListener('pagehide', () => {
      if (!broadcasting) return;
      navigator.sendBeacon?.('/api/cctv/ingest/' + encodeURIComponent(cameraId) + '/offline');
    });

    setBadge('STANDBY', false);
    startCamera().then((ok) => { if (ok) fillGeolocation(); });
  </script>
</body>
</html>`;

/** Vite plugin: serve the standalone broadcast page at /broadcast. */
export function broadcastPagePlugin() {
  const install = (server) => {
    server.middlewares.use((req, res, next) => {
      const path = (req.url || '').split('?')[0];
      if (path !== '/broadcast' && path !== '/broadcast/') {
        next();
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(BROADCAST_HTML);
    });
  };
  return {
    name: 'cctv-broadcast-page',
    configureServer: install,
    configurePreviewServer: install,
  };
}

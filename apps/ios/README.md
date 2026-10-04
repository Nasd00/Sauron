# Sauron iOS

The app has two native tabs:

- **Iris** hosts the existing web client, including its CCTV/Google Street View
  fallback, realtime voice assistant, shared tool actions, and original styling.
- **Location** keeps the background location-sharing and phone-pairing flow.

## Location pairing

An enrolled user can enter their registered phone number in the Location tab and
pair immediately. Photon rejects phone numbers without an active watch or alert
profile, so new users still need to register in Iris first. Texting `PAIR` and
opening the returned link remains available as a reset flow; either pairing
method replaces the previously paired device.

Debug builds use the shared Iris/Photon tunnel. For an archive or deployed build,
set the app target's `PHOTON_API_URL` build setting to the public HTTPS URL for
`services/photon`. A `PHOTON_API_URL` process environment variable can override
the build setting during local development or tests.

## Iris server URL

Debug builds on the simulator and physical iPhone use
`https://starfish-revolving-footman.ngrok-free.dev`. Start the full stack before
opening the app:

```sh
npm run dev:stack
```

The tunnel forwards to Iris on port 4173. Iris proxies `/api/mobile/`, `/pair/`,
`/admin/`, `/spectrum/webhook`, `/health`, and the Apple association file to
Photon on port 3001. This keeps map, voice, registration, pairing, and iMessage
webhooks on one public HTTPS origin. The iPhone can use Wi-Fi or cellular.

The stack builds and serves the bundled web client, avoiding a large unbundled
module graph over the phone connection. For web hot reload instead, use
`IRIS_WEB_MODE=dev npm run dev:stack`.

To start services in separate terminals, first run `npm run build:web`, then run
`npm run dev:photon`, `npm run preview --workspace @tempmhacks/web -- --port 4173`,
and `npm run dev:ngrok`. Existing tunnels pointing to port
3001 must be restarted so they forward to port 4173. Check
`npm run dev:stack:health` to confirm the public tunnel can also reach Photon.

For simulator-only development, `IRIS_WEB_APP_URL=http://127.0.0.1:4173` can
override the URL in the scheme environment. Loopback URLs do not work on a
physical iPhone.

For an archive or deployed build, set the app target's `IRIS_WEB_APP_URL` build
setting to the public HTTPS URL serving `apps/web`. The optional
`IRIS_WEB_APP_URL` process environment variable takes precedence, which is useful
for UI tests and local schemes.

The native host grants web microphone capture only to that configured origin.
The first time the voice control is turned on, iOS asks the user for microphone
permission using the app's privacy description.

The black Iris logo intro remains visible for 1.6 seconds on each app launch
while the web client starts loading underneath it.

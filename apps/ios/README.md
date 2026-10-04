# Sauron iOS

The app has two native tabs:

- **Iris** hosts the existing web client, including its CCTV/Google Street View
  fallback, realtime voice assistant, shared tool actions, and original styling.
- **Location** keeps the background location-sharing and phone-pairing flow.

## Location pairing

Text `WATCH ME` and open the one-time pairing link on this iPhone. Text `PAIR`
for a replacement phone; the new link replaces the previously paired device.
Entering a phone number alone cannot claim someone else's location profile.

## Iris server URL

Debug builds on the simulator and physical iPhone use
`https://starfish-revolving-footman.ngrok-free.dev`. Start the full stack before
opening the app:

```sh
npm run dev:stack
```

The tunnel forwards to Iris on port 4173. Iris proxies `/api/mobile/`, `/pair/`,
`/admin/`, `/spectrum/webhook`, `/health`, and the Apple association file to
Photon on port 3001. The stack also starts the alerts worker so a reported
incident reaches enrolled phones. The iPhone can use Wi-Fi or cellular.

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

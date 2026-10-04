# tempMhacks

## Local setup

Install Node.js and npm, then run from the repository root:

```sh
npm install
cp .env.example .env
```

Fill in `.env` as integrations become available. Keep credentials in `.env`,
which is ignored by Git; `.env.example` contains placeholders only.

## Workstream folders

| Folder | Ownership |
| --- | --- |
| `apps/web/` | Web application |
| `services/cv/` | Computer vision service |
| `services/incident/` | Incident service |
| `services/photon/` | Photon integration service |
| `services/alerts/` | Alerts service |
| `spacetimedb/` | SpacetimeDB module and schema |
| `packages/shared/` | Shared types and utilities |
| `scripts/demo/` | Demo startup and reset tooling |

## Commands

Run commands from the repository root:

```sh
npm run dev:web
npm run dev:cv
npm run dev:incident
npm run dev:photon
npm run dev:alerts
npm run demo:start
npm run demo:reset
```

The incident and CV-process commands remain safe placeholders until those
workstreams supply their long-running processes. `demo:reset` is implemented
(see the iMessage runbook below).

## Photon iMessage and alerts

The Photon service uses Spectrum's managed iMessage provider only. It accepts
native Spectrum webhooks at `POST /spectrum/webhook`, passes the exact request
bytes to Spectrum for HMAC verification, durably claims each Photon message ID,
and then runs the deterministic command router. The SDK acknowledges webhooks
before the command callback runs.

Set these values in the ignored `.env` file:

```sh
SPECTRUM_PROJECT_ID=
SPECTRUM_PROJECT_SECRET=
SPECTRUM_WEBHOOK_SECRET=
SPACETIMEDB_URI=http://127.0.0.1:3000
SPACETIMEDB_DATABASE=tempmhacks-local
VITE_SPACETIMEDB_URI=http://127.0.0.1:3000
VITE_SPACETIMEDB_DATABASE=tempmhacks-local
WATCH_RADIUS_KM=10
PUBLIC_APP_URL=https://your-public-web-app.example
GEOCODER_USER_AGENT=Downwind/0.1 (contact: you@example.com)
```

Publish the current SpacetimeDB module, start the Photon service, and expose its
port over public HTTPS. Configure the resulting URL in Photon as
`https://your-service.example/spectrum/webhook`:

```sh
npm run db:publish
npm run dev:photon
npm run dev:alerts
```

Supported iMessage commands are `WATCH <place>`, `STATUS`, `STOP`, and `HELP`.
The alert service matches confirmed incidents to active watches with Haversine
distance, claims each pending alert before sending, and records either the
Spectrum message ID or a terminal failure.

Alert links use `/incident/:incidentId`. The web app connects with the two
`VITE_SPACETIMEDB_*` values, selects and focuses that exact incident, retains
resolved incident details, and shows explicit not-found or retryable database
errors.

The default geocoder is the public OpenStreetMap Nominatim service. Queries are
end-user initiated, serialized to at most one request per second, and cached in
process. Provide an identifying `GEOCODER_USER_AGENT`, retain OpenStreetMap
attribution in product surfaces, and review the Nominatim usage policy before
deployment. `GEOCODER_BASE_URL` can switch to another compatible or self-hosted
endpoint without a code change. Geocoding data © OpenStreetMap contributors.

### Runbook: run the iMessage flow end to end

This is the verified path for bringing the inbound command flow and proactive
alerts online, including against a hosted SpacetimeDB (maincloud) database.

1. **Configure `.env`.** For a hosted database, set `SPACETIMEDB_URI`,
   `SPACETIMEDB_DATABASE`, and `SPACETIMEDB_TOKEN` (maincloud requires the
   token). Also set `SPECTRUM_PROJECT_ID`/`SPECTRUM_PROJECT_SECRET` (or the
   legacy `PHOTON_PROJECT_ID`/`PHOTON_SECRET`), `SPECTRUM_WEBHOOK_SECRET`,
   `GEOCODER_USER_AGENT`, and `PUBLIC_APP_URL`.

2. **Publish the module** so the deployed schema matches the code. Local:
   `npm run db:publish`. Hosted: log in once with
   `spacetime login --token "$SPACETIMEDB_TOKEN"`, then
   `npm run db:publish:maincloud` (reads `$SPACETIMEDB_DATABASE`). A schema
   change on an existing database may require `--delete-data`; see the migration
   note below.

3. **Seed the demo camera.** Hosted (no local CLI server needed):
   `npm run demo:seed:cameras:sdk`. Local CLI: `npm run demo:seed:cameras`.
   Both are idempotent and leave an existing camera unchanged.

4. **Start the services:** `npm run dev:photon` (webhook on `PHOTON_PORT`,
   default 3001) and `npm run dev:alerts`.

5. **Expose the webhook over public HTTPS.** For example
   `cloudflared tunnel --url http://localhost:3001`. The quick-tunnel URL
   changes on each restart.

6. **Point Photon at the tunnel.** In the Photon dashboard, set the webhook to
   `https://<tunnel>/spectrum/webhook` and make the dashboard signing secret
   match `SPECTRUM_WEBHOOK_SECRET` in `.env`. Restart `dev:photon` after any
   secret change.

7. **Drive the flow.** From an added phone, text the project's line:
   `HELP`, `WATCH Ann Arbor`, `STATUS`, `STOP`. Then seed a confirmed incident
   with `npm run demo:seed:incident`; the alert service matches it against
   active watches and sends a proactive alert into the existing conversation.

8. **Reset between runs.** `npm run demo:reset` deactivates watches and moves
   incidents to terminal states (resolved/dismissed) while keeping cameras.

Diagnostics: `npm run photon:send-test -- +15551234567` opens a DM and sends one
message to confirm credentials. On a shared-pool (free) line, cold
outbound-first sends are rejected with `Target not allowed for this project`;
sending into a conversation the user started first is on the allowed path, which
is why alerts land once the user has texted the line.

Shared-tier notes: a shared line only replies to phones added to the project,
and new-conversation limits apply. A dedicated (Business) line removes the
outbound-first restriction. SpacetimeDB has no row-delete reducer here, so
`demo:reset` transitions rows to terminal states rather than deleting them; a
schema-incompatible republish to an existing database requires `--delete-data`,
which destroys all rows (re-seed the camera afterward with
`demo:seed:cameras:sdk`).

## Web globe

The web app is a Vite + TypeScript Cesium shell. It uses OpenStreetMap imagery
and ellipsoid terrain, so a Cesium Ion token is not required. To use one for
future Ion-hosted assets, set `VITE_CESIUM_ION_TOKEN` in `.env`.

```sh
npm run dev:web
npm run build:web
```

The current marker for `demo-camera-001` is intentionally hard-coded. Realtime
camera data is added by a later workstream.

## Demo cameras and replay fixture

The deterministic replay camera is `demo-camera-001` at `42.2808, -83.7430`.
Its sample is an 11-second, public-domain USGS video of lava falls and a steam
cloud. Downloading is explicit so a missing fixture never prevents installing,
building, or seeding the project:

```sh
npm run demo:download-fixture
npm run demo:seed:cameras
```

The optional live source is the USGS Hawaiian Volcano Observatory K2 camera at
Uēkahuna bluff (`19.4202, -155.2881`). Its current JPEG is public domain and the
camera can be unavailable because of darkness, weather, maintenance, or volcanic
conditions. Register both the replay and live camera in one idempotent command:

```sh
ENABLE_LIVE_CAMERA=1 npm run demo:seed:cameras
```

The seed command treats an existing camera ID as success and leaves that row
unchanged. It uses `SPACETIME_BIN`, `SPACETIMEDB_URI`, and
`SPACETIMEDB_DATABASE` when set; otherwise it targets `tempmhacks-local` at
`http://127.0.0.1:3000`. The live source is operated by USGS HVO; see the
[official K2 camera page](https://www.usgs.gov/media/webcams/k2cam-live-image-kaluapele-kilauea-caldera-uekahuna-bluff)
and the [USGS webcam disclaimer](https://www.usgs.gov/volcanoes/kilauea/webcams).

## Frame sources

`services/cv/src/sources/` exports the model-free `FrameSource` interface plus:

- `ReplayFrameSource`, which invokes FFmpeg without a shell, samples a local
  video at a configurable interval (2,000 ms by default), emits frames in order,
  terminates cleanly at EOF, and can be started again.
- `LiveFrameSource`, which polls a public snapshot URL at the same configurable
  cadence and aborts in-flight HTTP work when stopped.

Install FFmpeg and ensure `ffmpeg` is on `PATH`, or set `FFMPEG_PATH`, before
running replay ingestion. The frame-source module contains no model or inference
imports; consumers receive timestamped JPEG bytes and decide what to do next.

## Shared contracts

`packages/shared/src/types.ts` is the canonical source for Camera, Observation,
Incident, Watch, and Alert. Import types from `@tempmhacks/shared`; do not create
service-local copies. Web and CV include example imports in their `src/contracts.ts`.

IDs are strings. Every timestamp is Unix milliseconds stored as a JavaScript
number (a nonnegative safe integer). Confidence is a finite number in `0..1`,
inclusive. The only MVP hazard is `smoke_fire`. Update the shared package first
when changing any contract; database schema parity is checked during compilation.

```sh
npm run build:shared
npm test
```

## Database bindings

Regenerate the module bindings into `packages/db-generated/src/generated/` with:

```sh
mkdir -p packages/db-generated/src/generated
spacetime generate --lang typescript --out-dir packages/db-generated/src/generated --module-path spacetimedb
```

Application code imports `createDb` and `Db` from `@tempmhacks/shared/db`; it does
not import generated bindings or the SpacetimeDB SDK directly. The adapter maps
generated rows to the shared contracts and exposes the typed camera, observation,
incident, alert, and watch operations.

The shared package builds independently with
`npm run build --workspace @tempmhacks/shared`. `npm test` compiles the shared
package, web/CV imports, database module, and tests, then tests the lifecycle rules.

## Local database

Install the [SpacetimeDB CLI](https://spacetimedb.com/install) version 2.10.2,
matching the pinned server SDK. In a separate terminal:

```sh
spacetime start --listen-addr 127.0.0.1:3000
```

From the repository root:

```sh
npm run db:build
npm run db:publish
SPACETIMEDB_URI=http://127.0.0.1:3000 SPACETIMEDB_DATABASE=tempmhacks-local npm run test:integration
```

The integration script writes uniquely named fixtures to all five core tables
and checks reducers, duplicate prevention, queries, and live subscription events.
It uses the publishing identity from the CLI, requires a local server, and leaves
its fixture rows in place. `SPACETIME_BIN` can select a CLI executable. Commands
do not automatically load `.env`; export its database values when overriding the
defaults. See [the database guide](spacetimedb/README.md) for reducers and queries.

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

The incident, CV-process, and demo-reset commands remain safe placeholders until
those workstreams supply their long-running processes.

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

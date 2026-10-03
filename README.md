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

These commands currently print placeholder messages and exit successfully.
Each workstream should replace its corresponding command when implemented.
The demo reset placeholder does not modify any data.

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

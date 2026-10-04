# Evacuation assist

Someone gets an official evacuation warning and needs help working out how their household
can leave. The agent checks the warning and finds shelters that fit the household. With the
resident's permission, it asks an enrolled volunteer driver for a pickup. It then follows
the arrangement until arrival and reroutes everyone when a verified closure blocks the route.

## Run the demo

```sh
source .tools/env.sh          # repo-local Node, if you use it
npm run dev:evac              # agent + API on http://127.0.0.1:8787
npm run dev:web               # then open http://127.0.0.1:5173/evac.html
```

Demo script: **Issue official warning** → in the resident phone, tap the suggested
"We're three people…" message → **Yes** → in the helper phone, **Accept** → **Verified road
closure** → **Picked up** → **Arrived**. To print the same conversation without a browser, run
`npx tsx services/evac/scripts/print-demo-transcript.ts`.

## How it fits together

| Path | Role |
| --- | --- |
| `src/agent/agent.ts` | `EvacAgent`: conversation state machine, consent, helper escalation, reroutes, check-ins. All mutations run through one queue. |
| `src/agent/messages.ts` | Every outbound text. Short and SMS-friendly, and it names the source of each claim. |
| `src/domain/` | Pure logic with unit tests: needs parsing, shelter ranking, helper fit, arrangement lifecycle, geometry. |
| `src/sources/` | Valhalla routing (closures passed as `exclude_polygons`), NWS alerts, FEMA open shelters, God's Eye incident polling. |
| `src/channels/` | Photon Spectrum. `web_sim` is a custom Spectrum platform behind the dashboard phones; iMessage turns on when credentials are set. |
| `src/server.ts` | Loopback-only JSON API + SSE stream for `apps/web/evac.html`. **No auth: local demo use only.** |
| `src/scenario/ann-arbor.ts` | Demo scenario. Coordinates come from OpenStreetMap; the warning, shelters, helpers, and closure are labeled fixtures. |
| `fixtures/route-cache.json` | Real Valhalla routes for the scenario, so tests and offline demos are deterministic. Regenerate with `npm run warm-cache -w @tempmhacks/evac`. |

## Real data vs supplied data

- **Live at startup:** NWS active alerts and FEMA National Shelter System open shelters for
  the household's location. Results show in the dashboard's Sources panel. Real alerts and
  shelters are added alongside the scenario.
- **Live when reachable:** Valhalla routing. Without it, the agent uses the seeded cache and
  then a straight-line estimate, and says so in the messages it sends.
- **God's Eye:** when `SPACETIMEDB_URI`/`SPACETIMEDB_DATABASE` are set, confirmed camera
  incidents within 300 m of an active route become camera-verified closures.
- **Supplied:** the evacuation order, shelter list, enrolled helpers, and Huron Pkwy
  closure. Everything is labeled "demo fixture" wherever it appears.

## Known gaps / next steps

- Needs parsing is rule-based (`src/domain/intake.ts`), not an LLM. It handles the demo
  phrasing and common variants, and asks again when people or vehicle are missing.
- State lives in memory and resets on restart. Persisting arrangements to SpacetimeDB would
  let `services/alerts` and `services/photon` share them.
- `services/photon` (on `main`) also runs a Spectrum ingress. If both run against the same
  Photon project, decide which service owns inbound iMessage, or route evacuation
  conversations from photon's router into `EvacAgent.handleInbound`.
- Helper enrollment and consent are scenario data, not a real opt-in flow.

# SpacetimeDB module

The five public core tables (`camera`, `observation`, `incident`, `watch`, `alert`)
mirror `@tempmhacks/shared`. Every ID is a string primary key. Optional fields use
SpacetimeDB options. String unions stay strings and are validated by reducers.
JavaScript/SDK field names are camelCase; SpacetimeDB 2.x canonical SQL and CLI
field names are snake_case. Timestamps use `f64` to retain JavaScript numbers and
are checked as safe integer Unix milliseconds rather than native microsecond
`Timestamp` values.

## Lookup paths

| Table | Index | Use |
| --- | --- | --- |
| `observation` | `(camera_id, timestamp)` | Recent observations, sorted index iteration/range filtering |
| `incident` | `(camera_id, type, status)` | Candidates and confirmed incidents for a camera/hazard |
| `watch` | `(active)` | Active watches |
| `alert` | `(incident_id, watch_id)` | One alert per incident/watch pair |

Example local queries:

```sh
spacetime sql --server local tempmhacks-local "SELECT * FROM observation WHERE camera_id = 'demo-camera-001' AND timestamp >= 1700000000000"
spacetime sql --server local tempmhacks-local "SELECT * FROM incident WHERE camera_id = 'demo-camera-001' AND type = 'smoke_fire' AND status = 'candidate'"
spacetime sql --server local tempmhacks-local "SELECT * FROM incident WHERE camera_id = 'demo-camera-001' AND type = 'smoke_fire' AND status = 'confirmed'"
spacetime sql --server local tempmhacks-local "SELECT * FROM watch WHERE active = true"
```

## Write API

| Reducer | Behavior |
| --- | --- |
| `register_camera(camera)` | Insert once; reject an existing ID |
| `set_camera_status(cameraId, status, lastSeenAt)` | Change only status and last-seen time; require a camera |
| `publish_observation(observation)` | Require a camera, `smoke_fire`, and confidence `0..1`; insert one observation |
| `create_incident(input)` | Require a camera and a candidate with no confirmation/resolution timestamps |
| `update_incident_detection(id, confidence, lastSeenAt)` | Change detection fields on candidate/confirmed incidents |
| `confirm_incident(id, confirmedAt)` | Candidate to confirmed; write confirmation time once |
| `dismiss_incident(id)` | Candidate to dismissed |
| `resolve_incident(id, resolvedAt)` | Confirmed to resolved; write resolution time once |

All other transitions fail. Dismissed/resolved incidents cannot reopen.
Observation writes never create incidents. Lifecycle writes never create alerts
or send messages. Public tables expose committed changes through subscriptions.

`insert_watch(watch)` and `insert_alert(alert)` provide owner-only schema fixture
inserts until the watch and messaging workstreams implement their APIs. A private
`module_config` table captures the publisher identity in `init`; it is not a
shared application entity. Alert inserts check referenced rows and use the
compound index to reject duplicate incident/watch pairs in the same transaction.
They perform no delivery or watch matching.

The CLI expects snake_case fields and explicit option values, for example:

```sh
spacetime call --server local tempmhacks-local register_camera '{"id":"demo-camera-001","name":"Demo","latitude":42.28,"longitude":-83.74,"source_type":"replay","stream_url":null,"status":"online","last_seen_at":{"some":1700000000000}}'
```

## iPhone companion app

`mobile_device` (public, no credentials) records each paired iPhone.
`mobile_pairing` and `mobile_credential` are private and store only SHA-256
token hashes. Photon hashes tokens before calling these reducers.

| Reducer | Behavior |
| --- | --- |
| `create_mobile_pairing(tokenHash, userId, spaceId, senderId)` | Single-use link that expires in 10 minutes |
| `redeem_mobile_pairing(pairingTokenHash, credentialTokenHash, deviceId)` | Marks the link used and creates the device and credential. Revokes the sender's earlier devices |
| `mobile_update_location(credentialTokenHash, lat, lng, accuracyMeters, capturedAt, defaultRadiusKm)` | Moves the user's one `user_alert_profile`. Rejects stopped tracking, accuracy worse than 500 m, and bad timestamps. Ignores out-of-order fixes |
| `mobile_set_sharing(credentialTokenHash, enabled)` | The in-app Start/Stop toggle |
| `mobile_check_credential(credentialTokenHash, deviceId)` | Read-only credential check |
| `set_mobile_tracking_for_sender(senderId, active)` | `STOP` (false) / `WATCH ME` (true) |
| `revoke_mobile_device(deviceId)` | Permanently revokes a device and its credentials |

Errors start with a stable code (`pairing_invalid`, `pairing_used`,
`pairing_expired`, `device_unauthorized`, `tracking_stopped`,
`location_invalid`, `token_invalid`) that Photon maps to HTTP statuses.

## Verification

From the repository root, `npm test` checks compilation and all lifecycle guards.
After starting and publishing a local module, `npm run test:integration` checks
real database constraints and subscriptions. The test includes a row in every
core table, failed duplicate IDs and alert pairs, unknown-camera rejection,
invalid confidence/hazard rejection, updates preserving unrelated fields, all
required transitions, timestamps that cannot be overwritten, and live
observation/status events. It also verifies non-owner fixture writes fail and
that incident/observation reducers do not create alerts automatically.

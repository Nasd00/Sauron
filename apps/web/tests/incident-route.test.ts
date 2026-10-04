import assert from "node:assert/strict";
import { test } from "node:test";
import { incidentIdFromPathname } from "../src/incident-route.js";

test("incident route extracts and decodes exactly one incident ID", () => {
  assert.equal(incidentIdFromPathname("/incident/incident-1"), "incident-1");
  assert.equal(incidentIdFromPathname("/incident/fire%2Fcamera%201/"), "fire/camera 1");
  assert.equal(incidentIdFromPathname("/"), undefined);
  assert.equal(incidentIdFromPathname("/incident/one/more"), undefined);
  assert.equal(incidentIdFromPathname("/incident/%ZZ"), undefined);
});

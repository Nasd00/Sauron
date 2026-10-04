import type { Arrangement, EvacSnapshot, Household, TimelineEvent } from "@tempmhacks/shared/evac";
import { clock, clockSeconds, escapeHtml, sourceBadge } from "./format.js";

const STAGE_LABEL: Record<Household["stage"], string> = {
  idle: "Monitoring",
  warned: "Warned · awaiting reply",
  intake: "Understanding needs",
  choosing_destination: "Choosing destination",
  awaiting_consent: "Awaiting permission",
  awaiting_helper: "Finding a driver",
  arranged: "Pickup arranged",
  self_evacuating: "Driving to shelter",
  complete: "Arrived safely",
};

type Step = { label: string; at?: number; done: boolean; detail?: string };

function steps(snapshot: EvacSnapshot, household: Household, arrangement: Arrangement | undefined): Step[] {
  const tz = snapshot.scenario.timeZone;
  const firstAt = (kind: TimelineEvent["kind"], match?: RegExp) =>
    snapshot.timeline.find(event => event.kind === kind && (!match || match.test(event.title)))?.at;
  const history = (status: Arrangement["status"]) => arrangement?.history.find(entry => entry.status === status)?.at;
  const helper = snapshot.helpers.find(h => h.id === arrangement?.helperId);
  return [
    { label: "Official warning", at: firstAt("warning"), done: snapshot.warnings.length > 0 },
    { label: "Needs understood", at: firstAt("destination"), done: household.needs.people !== undefined && household.needs.hasVehicle !== undefined },
    { label: "Permission to share", at: firstAt("consent", /gave permission/), done: Boolean(history("requested")) },
    {
      label: "Driver confirmed", at: history("confirmed"), done: Boolean(history("confirmed")),
      detail: helper && history("confirmed") ? helper.name.split(" ")[0] : undefined,
    },
    { label: "Picked up", at: history("picked_up"), done: Boolean(history("picked_up")), detail: arrangement?.pickupEta && !history("picked_up") ? `ETA ${clock(arrangement.pickupEta, tz)}` : undefined },
    { label: "Arrived", at: history("arrived") ?? (household.stage === "complete" ? firstAt("checkin", /Arrived/) : undefined), done: household.stage === "complete", detail: arrangement?.arrivalEta && household.stage !== "complete" ? `ETA ${clock(arrangement.arrivalEta, tz)}` : undefined },
  ];
}

export function renderHousehold(snapshot: EvacSnapshot): string {
  const household = snapshot.households[0];
  if (!household) return "";
  const { needs } = household;
  const chips = [
    needs.people !== undefined ? `${needs.people} ${needs.people === 1 ? "person" : "people"}` : undefined,
    ...needs.notes,
    ...needs.medical.map(m => `needs ${m}`),
    needs.pets ? `${needs.pets} pet${needs.pets === 1 ? "" : "s"}` : undefined,
    needs.hasVehicle === false ? "no vehicle" : needs.hasVehicle ? "has a vehicle" : undefined,
  ].filter(Boolean) as string[];
  const inWarning = snapshot.warnings.length > 0 && household.stage !== "idle";
  return `
    <div class="card-head">
      <div><p class="eyebrow">Household</p><h2>${escapeHtml(household.label)}</h2><p class="muted">${escapeHtml(household.address)}</p></div>
      <span class="stage-pill stage-${household.stage}">${STAGE_LABEL[household.stage]}</span>
    </div>
    ${inWarning ? `<p class="alert-line"><span aria-hidden="true">●</span> Inside ${escapeHtml(snapshot.warnings[0]!.event)} area</p>` : ""}
    <ul class="chips" aria-label="Known needs">${chips.length ? chips.map(c => `<li>${escapeHtml(c)}</li>`).join("") : `<li class="chip-empty">Needs not shared yet</li>`}</ul>`;
}

export function renderArrangement(snapshot: EvacSnapshot): string {
  const household = snapshot.households[0];
  if (!household) return "";
  const arrangement = [...snapshot.arrangements].reverse().find(a => a.householdId === household.id);
  const tz = snapshot.scenario.timeZone;
  const helper = snapshot.helpers.find(h => h.id === arrangement?.helperId);
  const shelter = snapshot.shelters.find(s => s.id === (arrangement?.shelterId ?? household.selectedShelterId));
  const route = household.activeRoute ?? arrangement?.tripRoute;
  const reroutes = snapshot.timeline.filter(e => e.kind === "reroute").length;
  const list = steps(snapshot, household, arrangement);
  const current = list.findIndex(step => !step.done);

  const stepper = `<ol class="stepper">${list.map((step, index) => `
    <li class="${step.done ? "done" : index === current ? "current" : ""}">
      <span class="step-dot" aria-hidden="true"></span>
      <span class="step-label">${step.label}</span>
      <span class="step-time">${step.done && step.at ? clock(step.at, tz) : step.detail ?? ""}</span>
    </li>`).join("")}</ol>`;

  const facts = [
    ["Driver", helper ? `${escapeHtml(helper.name)}<small>${escapeHtml(helper.vehicle.description)}</small>` : arrangement?.status === "unfilled" ? "No driver available" : "—"],
    ["Destination", shelter ? `${escapeHtml(shelter.name)}<small>${shelter.capacity - shelter.occupied} spaces · ${shelter.wheelchairAccessible ? "accessible" : "not accessible"}</small>` : "—"],
    ["Pickup", arrangement?.pickupEta ? clock(arrangement.pickupEta, tz) : "—"],
    ["Arrival", arrangement?.arrivalEta ? clock(arrangement.arrivalEta, tz) : "—"],
  ];
  const routeLine = route
    ? `<div class="route-line">
        <span class="route-swatch" aria-hidden="true"></span>
        <div><strong>${route.distanceKm.toFixed(1)} km · ${Math.round(route.durationMin)} min</strong>
        <small>${escapeHtml(route.via.join(" → ") || "Direct estimate")}</small></div>
        <div class="route-meta">${sourceBadge(route.source)}${reroutes ? `<span class="reroute-count">${reroutes} reroute${reroutes > 1 ? "s" : ""}</span>` : ""}</div>
      </div>`
    : `<p class="muted route-empty">No route yet. Destinations are routed once the household's needs are known.</p>`;

  return `
    <div class="card-head"><div><p class="eyebrow">Arrangement</p><h2>${arrangement ? statusTitle(arrangement) : household.stage === "self_evacuating" ? "Self-evacuating" : "Not started"}</h2></div></div>
    ${stepper}
    <dl class="facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl>
    ${routeLine}`;
}

function statusTitle(arrangement: Arrangement): string {
  return {
    awaiting_consent: "Waiting for permission",
    requested: "Request sent to driver",
    confirmed: "Driver on the way",
    en_route: "Driver on the way",
    picked_up: "Heading to shelter",
    arrived: "Completed",
    unfilled: "No driver available",
    cancelled: "Cancelled",
  }[arrangement.status];
}

export function renderTimeline(snapshot: EvacSnapshot): string {
  const tz = snapshot.scenario.timeZone;
  const events = [...snapshot.timeline].reverse();
  if (!events.length) return `<p class="muted">Waiting for the first official warning. Use <strong>Issue warning</strong> to start the demo.</p>`;
  return `<ol class="timeline">${events.map(event => `
    <li class="tl-${event.kind}">
      <span class="tl-dot" aria-hidden="true"></span>
      <div class="tl-body">
        <div class="tl-row"><strong>${escapeHtml(event.title)}</strong><time>${clockSeconds(event.at, tz)}</time></div>
        ${event.detail ? `<p>${escapeHtml(event.detail)}</p>` : ""}
        ${event.source ? sourceBadge(event.source) : ""}
      </div>
    </li>`).join("")}</ol>`;
}

export function renderSources(snapshot: EvacSnapshot): string {
  const rows = [
    ...snapshot.channels.map(c => ({ name: c.label, ok: c.connected, detail: c.platform })),
    ...snapshot.sourceHealth.map(s => ({ name: s.name, ok: s.ok, detail: s.detail })),
  ];
  return `<ul class="sources">${rows.map(row => `
    <li><span class="health ${row.ok ? "ok" : "off"}" aria-label="${row.ok ? "ok" : "unavailable"}"></span>
    <div><strong>${escapeHtml(row.name)}</strong><small>${escapeHtml(row.detail)}</small></div></li>`).join("")}</ul>`;
}

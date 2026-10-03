import type {
  Closure, Helper, Household, OfficialWarning, Participant, Shelter, SourceRef,
} from "@tempmhacks/shared/evac";
import { bufferLine } from "../domain/geo.js";

/**
 * Deterministic demo scenario for Ann Arbor, MI. Coordinates were geocoded from
 * OpenStreetMap (Nominatim). The warning, shelters, helpers, and closure are
 * supplied demo data: they are labeled as fixtures everywhere they surface and
 * do not describe real operating shelters or real road closures.
 */
export type Scenario = {
  id: string;
  title: string;
  areaCenter: { latitude: number; longitude: number };
  timeZone: string;
  warnings: OfficialWarning[];
  households: Household[];
  shelters: Shelter[];
  helpers: Helper[];
  participants: Participant[];
  /** Closures that the demo can inject, keyed by id. Not active until injected. */
  closureLibrary: Closure[];
};

const fixture = (name: string, at: number): SourceRef => ({ name, kind: "demo_fixture", live: false, retrievedAt: at });

/** Huron Parkway centerline between Hubbard Rd and Glazier Way, sampled from the Valhalla route geometry. */
const HURON_PARKWAY_SEGMENT: [number, number][] = [
  [42.293275, -83.705369], [42.292895, -83.705517], [42.29248, -83.705556], [42.292077, -83.705486],
  [42.291685, -83.705302], [42.291282, -83.705002], [42.290966, -83.704779], [42.290567, -83.70456],
  [42.290188, -83.704405], [42.289516, -83.704206], [42.288466, -83.703904], [42.287817, -83.703707],
  [42.287248, -83.703544], [42.286806, -83.703415], [42.286565, -83.70332],
];

export function annArborScenario(now = Date.now()): Scenario {
  const warningArea = [
    [42.3185, -83.7850], [42.3195, -83.7480], [42.3120, -83.7230], [42.2985, -83.7215],
    [42.2915, -83.7330], [42.2905, -83.7620], [42.2950, -83.7860],
  ].map(([latitude, longitude]) => ({ latitude: latitude!, longitude: longitude! }));

  const shelterSource = fixture("Demo shelter list (fixture, not an operating shelter)", now);
  const shelters: Shelter[] = [
    {
      id: "shelter-huron-hs", name: "Huron High School", address: "2727 Fuller Rd, Ann Arbor",
      location: { latitude: 42.2806964, longitude: -83.7029278 },
      capacity: 300, occupied: 112, wheelchairAccessible: true, petFriendly: true, medicalSupport: true,
      status: "open", source: shelterSource,
    },
    {
      id: "shelter-pioneer-hs", name: "Pioneer High School", address: "601 W Stadium Blvd, Ann Arbor",
      location: { latitude: 42.2603039, longitude: -83.7538782 },
      capacity: 250, occupied: 204, wheelchairAccessible: true, petFriendly: false, medicalSupport: false,
      status: "open", source: shelterSource,
    },
    {
      id: "shelter-wcc", name: "Washtenaw Community College", address: "4800 E Huron River Dr, Ann Arbor",
      location: { latitude: 42.2631875, longitude: -83.6650462 },
      capacity: 400, occupied: 61, wheelchairAccessible: true, petFriendly: true, medicalSupport: false,
      status: "open", source: shelterSource,
    },
    {
      id: "shelter-skyline-hs", name: "Skyline High School", address: "2552 N Maple Rd, Ann Arbor",
      location: { latitude: 42.3052254, longitude: -83.77713 },
      capacity: 300, occupied: 0, wheelchairAccessible: true, petFriendly: true, medicalSupport: false,
      status: "open", source: shelterSource,
    },
  ];

  const participants: Participant[] = [
    { id: "resident-alex", role: "resident", name: "Alex Rivera", channel: { platform: "web_sim" } },
    { id: "helper-maya", role: "helper", name: "Maya Chen", channel: { platform: "web_sim" } },
    { id: "helper-jordan", role: "helper", name: "Jordan Patel", channel: { platform: "web_sim" } },
    { id: "helper-luis", role: "helper", name: "Luis Ortega", channel: { platform: "web_sim" } },
  ];

  const helpers: Helper[] = [
    {
      id: "maya", name: "Maya Chen", participantId: "helper-maya",
      home: { latitude: 42.3091, longitude: -83.7069 },
      vehicle: { description: "wheelchair-accessible van with ramp", seats: 5, wheelchairAccessible: true },
      enrolled: true, status: "available",
    },
    {
      id: "jordan", name: "Jordan Patel", participantId: "helper-jordan",
      home: { latitude: 42.2808, longitude: -83.743 },
      vehicle: { description: "sedan", seats: 4, wheelchairAccessible: false },
      enrolled: true, status: "available",
    },
    {
      id: "luis", name: "Luis Ortega", participantId: "helper-luis",
      home: { latitude: 42.2575, longitude: -83.71 },
      vehicle: { description: "minivan with fold-out ramp", seats: 6, wheelchairAccessible: true },
      enrolled: true, status: "available",
    },
  ];

  const closureSource = fixture("Demo road-closure feed (fixture)", now);
  const huronLine = HURON_PARKWAY_SEGMENT.map(([latitude, longitude]) => ({ latitude, longitude }));

  return {
    id: "ann-arbor-barton-fire",
    title: "Barton Hills brush fire — Ann Arbor, MI",
    areaCenter: { latitude: 42.2985, longitude: -83.7350 },
    timeZone: "America/Detroit",
    warnings: [{
      id: "warning-evi-barton",
      event: "Evacuation Immediate",
      severity: "Extreme",
      headline: "Evacuation order: north of the Huron River between N Maple Rd and Pontiac Trail",
      instruction: "Leave now. Travel south or east, away from the Barton and Bird Hills nature areas. "
        + "Do not return until officials say it is safe.",
      areaLabel: "Barton Hills / Bird Hills / Northside",
      area: warningArea,
      issuedAt: now,
      expiresAt: now + 6 * 60 * 60 * 1000,
      source: fixture("Washtenaw County Emergency Management (demo fixture)", now),
    }],
    households: [{
      id: "household-rivera",
      label: "Rivera household",
      address: "Barton Dr near Pontiac Trail",
      location: { latitude: 42.3, longitude: -83.733 },
      residentId: "resident-alex",
      needs: { mobility: [], medical: [], pets: 0, notes: [] },
      stage: "idle",
      offeredShelterIds: [],
    }],
    shelters,
    helpers,
    participants,
    closureLibrary: [{
      id: "closure-huron-pkwy",
      road: "Huron Parkway",
      description: "Huron Pkwy closed both directions between Hubbard Rd and Glazier Way (downed lines, fire crews)",
      area: bufferLine(huronLine, 40),
      line: huronLine,
      reportedAt: now,
      status: "active",
      verifiedBy: [closureSource],
    }],
  };
}

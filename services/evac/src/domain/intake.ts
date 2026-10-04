import type { HouseholdNeeds, MobilityNeed } from "@tempmhacks/shared/evac";

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  a: 1, an: 1, single: 1, couple: 2, pair: 2,
};
const NUMBER = "(\\d+|one|two|three|four|five|six|seven|eight|nine|ten)";
const toNumber = (token: string): number | undefined =>
  /^\d+$/.test(token) ? Number(token) : NUMBER_WORDS[token.toLowerCase()];

const RELATIVES = [
  "dad", "father", "mom", "mother", "wife", "husband", "partner", "son", "daughter", "grandma",
  "grandmother", "grandpa", "grandfather", "brother", "sister", "aunt", "uncle", "roommate", "friend",
  "baby", "kid", "child", "neighbor",
];
const RELATIVE_PATTERN = RELATIVES.join("|");

export type IntakeResult = {
  needs: HouseholdNeeds;
  /** Short phrases describing what was understood from this message, for confirmation. */
  understood: string[];
};

/**
 * Deterministic household-needs extraction. It is intentionally conservative: it only
 * records facts the person stated, and merges them into what is already known.
 */
export function parseHouseholdMessage(text: string, prior: HouseholdNeeds): IntakeResult {
  const lower = ` ${text.toLowerCase().replace(/[’']/g, "'")} `;
  const needs: HouseholdNeeds = {
    ...prior, mobility: [...prior.mobility], medical: [...prior.medical], notes: [...prior.notes],
  };
  const understood: string[] = [];

  const people = parsePeople(lower);
  if (people !== undefined) {
    needs.people = people;
    understood.push(`${people} ${people === 1 ? "person" : "people"}`);
  }

  for (const [need, pattern, label] of [
    ["wheelchair", /wheel ?chair|power chair|mobility scooter/, "uses a wheelchair"],
    ["walker", /\bwalker\b|\bcane\b|crutches/, "uses a walker or cane"],
    ["limited_walking", /can't walk (far|much|well)|cannot walk|trouble walking|limited mobility|bed ?ridden|bedbound/, "has limited mobility"],
  ] as [MobilityNeed, RegExp, string][]) {
    if (!pattern.test(lower)) continue;
    if (!needs.mobility.includes(need)) needs.mobility.push(need);
    const who = lower.match(new RegExp(`\\bmy (${RELATIVE_PATTERN})\\b[^.,;!?]*?(${pattern.source})`));
    const note = who ? `${who[1]} (${label.replace(/^uses an? /, "").replace(/^has /, "")})` : label;
    if (!needs.notes.includes(note)) needs.notes.push(note);
    understood.push(who ? `your ${who[1]} ${label}` : `someone ${label}`);
  }

  for (const [label, pattern] of [
    ["oxygen", /oxygen|\bo2\b/], ["dialysis", /dialysis/], ["insulin", /insulin|diabet/],
    ["ventilator", /ventilator/], ["CPAP", /cpap/], ["refrigerated medication", /medication (that needs|in the) (fridge|refrigerat)/],
  ] as [string, RegExp][]) {
    if (pattern.test(lower) && !needs.medical.includes(label)) {
      needs.medical.push(label);
      understood.push(`needs ${label}`);
    }
  }

  const pets = parsePets(lower);
  if (pets !== undefined) {
    needs.pets = pets;
    understood.push(pets === 0 ? "no pets" : `${pets} pet${pets === 1 ? "" : "s"}`);
  }

  if (/(don't|do not|dont|doesn't|no longer) (have|own) a (car|vehicle)|\bno (car|vehicle|ride|transportation)\b|without a (car|vehicle)|(can't|cannot|can not) drive|car (is|got) (broken|in the shop)/.test(lower)) {
    needs.hasVehicle = false;
    understood.push("no car");
  } else if (/\b(we|i) (have|own|got) (a|our|my) (car|vehicle|truck|van)\b|\b(we|i) can drive\b|\b(i'll|we'll|i will|we will) drive\b/.test(lower)) {
    needs.hasVehicle = true;
    understood.push("you have a vehicle");
  }

  return { needs, understood };
}

function parsePeople(lower: string): number | undefined {
  const explicit = [
    new RegExp(`\\b(?:we're|we are|there are|there's|theres|it's|its)\\s+${NUMBER}(?:\\s+(?:of us|people|persons|adults))?\\b`),
    new RegExp(`\\b${NUMBER}\\s+(?:of us|people|persons|adults)\\b`),
    new RegExp(`\\bfamily of\\s+${NUMBER}\\b`),
    new RegExp(`\\bparty of\\s+${NUMBER}\\b`),
  ];
  for (const pattern of explicit) {
    const match = lower.match(pattern);
    const value = match?.[1] ? toNumber(match[1]) : undefined;
    if (value && value > 0 && value < 30) return value;
  }
  if (/\b(just me|only me|i'm alone|i am alone|by myself|live alone)\b/.test(lower)) return 1;
  // "me, my wife and two kids" style: count self plus named relatives.
  if (!/\b(me|i|my)\b/.test(lower)) return undefined;
  let count = 0;
  for (const match of lower.matchAll(new RegExp(`\\b(?:(?:my|our)\\s+)?(?:${NUMBER}\\s+)?(${RELATIVE_PATTERN})(?:s|ren)?\\b`, "g"))) {
    count += match[1] ? toNumber(match[1]) ?? 1 : 1;
  }
  const isListing = /\b(me and|me,|myself and|with my|i live with)/.test(lower);
  return count > 0 && isListing ? count + 1 : undefined;
}

function parsePets(lower: string): number | undefined {
  if (/\bno (pets|animals)\b|\bdon't have (any )?pets\b/.test(lower)) return 0;
  let total = 0;
  for (const match of lower.matchAll(new RegExp(`\\b${NUMBER}?\\s*(dog|cat|puppy|kitten|bird|rabbit|pet)s?\\b`, "g"))) {
    const before = lower.slice(Math.max(0, (match.index ?? 0) - 4), match.index ?? 0);
    if (/\bno\s*$/.test(before)) continue;
    total += match[1] ? toNumber(match[1]) ?? 1 : 1;
  }
  return total > 0 ? total : undefined;
}

/** Which details still need asking before destinations can be suggested. */
export function missingDetails(needs: HouseholdNeeds): ("people" | "vehicle")[] {
  const missing: ("people" | "vehicle")[] = [];
  if (needs.people === undefined) missing.push("people");
  if (needs.hasVehicle === undefined) missing.push("vehicle");
  return missing;
}

export function describeNeeds(needs: HouseholdNeeds): string {
  const parts: string[] = [];
  if (needs.people !== undefined) parts.push(`${needs.people} ${needs.people === 1 ? "person" : "people"}`);
  parts.push(...needs.notes);
  if (needs.medical.length) parts.push(`medical: ${needs.medical.join(", ")}`);
  if (needs.pets) parts.push(`${needs.pets} pet${needs.pets === 1 ? "" : "s"}`);
  if (needs.hasVehicle === false) parts.push("no vehicle");
  if (needs.hasVehicle === true) parts.push("has a vehicle");
  return parts.join(" · ");
}

import type { Arrangement, ArrangementStatus } from "@tempmhacks/shared/evac";

/** Allowed lifecycle moves. A request can be re-issued to the next helper (requested → requested). */
const TRANSITIONS: Record<ArrangementStatus, ArrangementStatus[]> = {
  awaiting_consent: ["requested", "cancelled"],
  requested: ["requested", "confirmed", "unfilled", "cancelled"],
  confirmed: ["en_route", "picked_up", "cancelled", "requested"],
  en_route: ["picked_up", "cancelled", "requested"],
  picked_up: ["arrived"],
  arrived: [],
  unfilled: ["requested", "cancelled"],
  cancelled: [],
};

export function canTransition(from: ArrangementStatus, to: ArrangementStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function transition(
  arrangement: Arrangement,
  to: ArrangementStatus,
  at: number,
  note: string,
  patch: Partial<Omit<Arrangement, "id" | "status" | "history">> = {},
): Arrangement {
  if (!canTransition(arrangement.status, to)) {
    throw new Error(`Arrangement ${arrangement.id} cannot move from ${arrangement.status} to ${to}`);
  }
  return { ...arrangement, ...patch, status: to, history: [...arrangement.history, { status: to, at, note }] };
}

/** Arrangements that still need monitoring for route changes. */
export function isActive(arrangement: Arrangement): boolean {
  return ["awaiting_consent", "requested", "confirmed", "en_route", "picked_up"].includes(arrangement.status);
}

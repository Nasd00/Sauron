import { randomUUID } from "node:crypto";
import { REPORTABLE_HAZARDS, type IncidentHazard, type IncidentView } from "@tempmhacks/shared";
import type { ReportIncidentInput } from "@tempmhacks/shared/db";

/** Bad input from the caller; the server maps this to a 400. */
export class IncidentReportError extends Error {}

export const MIN_DANGER_RADIUS_KM = 0.1;
export const MAX_DANGER_RADIUS_KM = 100;

/** Validate a POST /admin/incidents body. Throws IncidentReportError for anything malformed. */
export function parseIncidentReport(body: unknown, id: () => string = () => `manual-${randomUUID()}`): ReportIncidentInput {
  if (!body || typeof body !== "object") throw new IncidentReportError("body must be a JSON object");
  const { type, latitude, longitude, radiusKm, title, description, reportedBy } = body as Record<string, unknown>;
  const hazard = type ?? "other";
  if (typeof hazard !== "string" || !(REPORTABLE_HAZARDS as readonly string[]).includes(hazard)) {
    throw new IncidentReportError(`type must be one of ${REPORTABLE_HAZARDS.join(", ")}`);
  }
  if (typeof latitude !== "number" || !Number.isFinite(latitude) || latitude < -90 || latitude > 90
    || typeof longitude !== "number" || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new IncidentReportError("latitude and longitude must be valid coordinates");
  }
  if (typeof radiusKm !== "number" || !Number.isFinite(radiusKm) || radiusKm < MIN_DANGER_RADIUS_KM || radiusKm > MAX_DANGER_RADIUS_KM) {
    throw new IncidentReportError(`radiusKm must be between ${MIN_DANGER_RADIUS_KM} and ${MAX_DANGER_RADIUS_KM}`);
  }
  if (typeof title !== "string" || !title.trim() || title.trim().length > 120) {
    throw new IncidentReportError("title is required (at most 120 characters)");
  }
  if (description !== undefined && (typeof description !== "string" || description.length > 1000)) {
    throw new IncidentReportError("description must be text of at most 1000 characters");
  }
  if (reportedBy !== undefined && typeof reportedBy !== "string") throw new IncidentReportError("reportedBy must be text");
  return {
    id: id(), type: hazard as IncidentHazard, latitude, longitude, radiusKm,
    title: title.trim(), description: (description as string | undefined)?.trim() ?? "",
    reportedBy: (reportedBy as string | undefined)?.trim() || "web operator",
  };
}

export type IncidentAdminDb = {
  report(input: ReportIncidentInput): Promise<void>;
  resolve(id: string): Promise<void>;
  view(id: string): IncidentView | undefined;
};

/** Turns a reducer rejection into an operator-actionable message. */
export function describeReportFailure(error: unknown, identity?: string): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.includes("operator_required")) return message;
  return `Photon's database identity is not allowed to report incidents. As the database owner run: `
    + `spacetime call <database> grant_operator '"${identity ?? "<photon identity from startup log>"}"'`;
}

/**
 * POST /admin/incidents creates a confirmed manual incident; POST /admin/incidents/resolve ends it.
 * Both require the operator key (checked by the server before this runs).
 */
export async function handleIncidentAdmin(
  path: string, body: unknown, db: IncidentAdminDb, identity?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  try {
    if (path === "/admin/incidents") {
      const input = parseIncidentReport(body);
      await db.report(input);
      return { status: 201, body: { incident: db.view(input.id) ?? { id: input.id } } };
    }
    if (path === "/admin/incidents/resolve") {
      const id = (body as { id?: unknown } | null)?.id;
      if (typeof id !== "string" || !id.trim()) throw new IncidentReportError("id is required");
      await db.resolve(id);
      return { status: 200, body: { incident: db.view(id) ?? { id } } };
    }
    return { status: 404, body: { error: "not found" } };
  } catch (error) {
    if (error instanceof IncidentReportError) return { status: 400, body: { error: error.message } };
    const message = describeReportFailure(error, identity);
    return { status: message.includes("grant_operator") ? 403 : 502, body: { error: message } };
  }
}

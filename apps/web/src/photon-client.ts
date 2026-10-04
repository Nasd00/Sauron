/**
 * Enrolls a phone for alerts through the Photon service, which opens the iMessage conversation,
 * creates the watch at the picked point, and texts the person a confirmation. Only Photon can open
 * that conversation, which is why the web app can't write this watch to the database itself.
 */

export const E164 = /^\+[1-9]\d{6,14}$/;

/**
 * Headers sent on every admin request. `ngrok-skip-browser-warning` tells a free ngrok tunnel to
 * forward the request to Photon instead of returning its HTML interstitial (ERR_NGROK_6024), which
 * carries no CORS headers and otherwise makes the browser fetch fail. Harmless on non-ngrok hosts.
 */
const ADMIN_HEADERS = { "content-type": "application/json", "ngrok-skip-browser-warning": "true" } as const;

export type EnrollRequest = { phone: string; latitude: number; longitude: number; label: string; radiusKm: number };

export type EnrollResult =
  | { ok: true; phone: string }
  | { ok: false; reason: "unauthorized" | "rejected" | "unreachable"; message: string };

export async function enrollPhone(
  baseUrl: string, secret: string, request: EnrollRequest, doFetch: typeof fetch = fetch,
): Promise<EnrollResult> {
  let response: Response;
  try {
    response = await doFetch(new URL("/admin/users", baseUrl), {
      method: "POST",
      headers: { ...ADMIN_HEADERS, authorization: `Bearer ${secret}` },
      body: JSON.stringify(request),
    });
  } catch {
    return { ok: false, reason: "unreachable", message: "Couldn't reach the alert service. Check VITE_PHOTON_URL and that Photon is running." };
  }
  if (response.status === 401) return { ok: false, reason: "unauthorized", message: "That operator key was rejected." };
  const body = await response.json().catch(() => ({})) as { phone?: string; error?: string };
  if (!response.ok) return { ok: false, reason: "rejected", message: body.error ?? `Enrollment failed (HTTP ${response.status}).` };
  return { ok: true, phone: body.phone ?? request.phone };
}

export type ReportRequest = {
  type: string; latitude: number; longitude: number; radiusKm: number; title: string; description: string;
};

export type ReportResult =
  | { ok: true; incidentId: string }
  | { ok: false; reason: "unauthorized" | "rejected" | "unreachable"; message: string };

async function postAdmin(
  baseUrl: string, secret: string, path: string, body: unknown, doFetch: typeof fetch,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; reason: "unauthorized" | "rejected" | "unreachable"; message: string }> {
  let response: Response;
  try {
    response = await doFetch(new URL(path, baseUrl), {
      method: "POST",
      headers: { ...ADMIN_HEADERS, authorization: `Bearer ${secret}` },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, reason: "unreachable", message: "Couldn't reach the alert service. Check VITE_PHOTON_URL and that Photon is running." };
  }
  if (response.status === 401) return { ok: false, reason: "unauthorized", message: "That operator key was rejected." };
  const parsed = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) return { ok: false, reason: "rejected", message: typeof parsed.error === "string" ? parsed.error : `Request failed (HTTP ${response.status}).` };
  return { ok: true, body: parsed };
}

/**
 * Reports a dangerous event at a point. Photon creates a confirmed incident with this danger zone,
 * which alerts every phone in or near it and has the help agent offer a way out.
 */
export async function reportIncident(
  baseUrl: string, secret: string, request: ReportRequest, doFetch: typeof fetch = fetch,
): Promise<ReportResult> {
  const result = await postAdmin(baseUrl, secret, "/admin/incidents", { ...request, reportedBy: "web operator" }, doFetch);
  if (!result.ok) return result;
  const incident = result.body.incident as { id?: string } | undefined;
  return { ok: true, incidentId: incident?.id ?? "" };
}

/** Ends an incident; everyone who was alerted gets an all-clear text. */
export async function resolveIncidentViaPhoton(
  baseUrl: string, secret: string, incidentId: string, doFetch: typeof fetch = fetch,
): Promise<{ ok: true } | { ok: false; reason: "unauthorized" | "rejected" | "unreachable"; message: string }> {
  const result = await postAdmin(baseUrl, secret, "/admin/incidents/resolve", { id: incidentId }, doFetch);
  return result.ok ? { ok: true } : result;
}

/** Changes a camera incident through Photon's operator-key endpoint. */
export async function transitionIncidentViaPhoton(
  baseUrl: string, secret: string, incidentId: string, action: "confirm" | "dismiss", doFetch: typeof fetch = fetch,
): Promise<{ ok: true } | { ok: false; reason: "unauthorized" | "rejected" | "unreachable"; message: string }> {
  const result = await postAdmin(baseUrl, secret, `/admin/incidents/${action}`, { id: incidentId }, doFetch);
  return result.ok ? { ok: true } : result;
}

const SECRET_KEY = "photon-admin-secret";

/** The operator key is entered once per tab and never compiled into the public site. */
export function operatorSecret(ask: () => string | null = () => window.prompt("Operator key (PHOTON_ADMIN_SECRET):")): string | undefined {
  try {
    const stored = sessionStorage.getItem(SECRET_KEY)?.trim();
    if (stored) return stored;
  } catch { /* storage unavailable: ask every time */ }
  const entered = ask()?.trim();
  if (!entered) return undefined;
  try { sessionStorage.setItem(SECRET_KEY, entered); } catch { /* keep going without storing */ }
  return entered;
}

export function forgetOperatorSecret(): void {
  try { sessionStorage.removeItem(SECRET_KEY); } catch { /* nothing stored */ }
}

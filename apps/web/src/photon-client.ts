/**
 * Enrolls a phone for alerts through the Photon service, which opens the iMessage conversation,
 * creates the watch at the picked point, and texts the person a confirmation. Only Photon can open
 * that conversation, which is why the web app can't write this watch to the database itself.
 */

export const E164 = /^\+[1-9]\d{6,14}$/;

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
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
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

const SECRET_KEY = "photon-admin-secret";

/** The operator's Photon admin key for this browser tab. Never bundled into the app. */
export function operatorSecret(ask: () => string | null = () => window.prompt("Operator key (PHOTON_ADMIN_SECRET) to enroll phones:")): string | undefined {
  try {
    const stored = sessionStorage.getItem(SECRET_KEY);
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

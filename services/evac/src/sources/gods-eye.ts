import type { GodsEyeIncident } from "@tempmhacks/shared/evac";

type SqlType = { Sum?: { variants: { name: { some: string }; algebraic_type: SqlType }[] }; Product?: { elements: SqlColumn[] } };
type SqlColumn = { name: { some: string }; algebraic_type: SqlType };
type SqlResult = { schema: { elements: SqlColumn[] }; rows: unknown[][] };

const camel = (key: string) => key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());

function decode(value: unknown, type: SqlType): unknown {
  if (type.Sum) {
    const [tag, payload] = value as [number, unknown];
    const variant = type.Sum.variants[tag];
    return !variant || variant.name.some === "none" ? undefined : decode(payload, variant.algebraic_type);
  }
  if (type.Product) {
    return Object.fromEntries(type.Product.elements.map((column, index) =>
      [camel(column.name.some), decode((value as unknown[])[index], column.algebraic_type)]));
  }
  return value;
}

export function decodeSqlRows(results: SqlResult[]): Record<string, unknown>[] {
  return results.flatMap(result => result.rows.map(row =>
    decode(row, { Product: { elements: result.schema.elements } }) as Record<string, unknown>));
}

export type GodsEyeOptions = {
  uri: string;
  database: string;
  intervalMs?: number;
  fetch?: typeof fetch;
  onIncidents: (incidents: GodsEyeIncident[]) => void;
  onHealth?: (ok: boolean, detail: string) => void;
};

/**
 * Polls confirmed camera incidents from the God's Eye SpacetimeDB module over its HTTP SQL API.
 * Polling keeps this service decoupled from the generated client bindings.
 */
export function startGodsEyePoller(options: GodsEyeOptions): () => void {
  const doFetch = options.fetch ?? fetch;
  let token: string | undefined;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  async function identity(): Promise<string> {
    if (token) return token;
    const response = await doFetch(`${options.uri}/v1/identity`, { method: "POST", signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`identity ${response.status}`);
    token = (await response.json() as { token: string }).token;
    return token;
  }

  async function poll(): Promise<void> {
    try {
      const response = await doFetch(`${options.uri}/v1/database/${options.database}/sql`, {
        method: "POST",
        headers: { authorization: `Bearer ${await identity()}`, "content-type": "text/plain" },
        body: "SELECT * FROM incident WHERE status = 'confirmed'",
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error(`sql ${response.status}: ${(await response.text()).slice(0, 120)}`);
      const rows = decodeSqlRows(await response.json() as SqlResult[]);
      options.onIncidents(rows.map(row => ({
        id: String(row.id),
        cameraId: String(row.cameraId),
        location: { latitude: Number(row.latitude), longitude: Number(row.longitude) },
        confidence: Number(row.confidence),
        confirmedAt: row.confirmedAt === undefined ? undefined : Number(row.confirmedAt),
        status: String(row.status),
      })));
      options.onHealth?.(true, `${rows.length} confirmed incident(s)`);
    } catch (error) {
      options.onHealth?.(false, error instanceof Error ? error.message : String(error));
    } finally {
      if (!stopped) timer = setTimeout(() => void poll(), options.intervalMs ?? 5000);
    }
  }

  void poll();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

import type { SourceRef } from "@tempmhacks/shared/evac";

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

/** Escape, then turn http(s) URLs into safe links. Newlines are preserved by CSS (pre-wrap). */
export function linkify(text: string): string {
  return escapeHtml(text).replace(/https?:\/\/[^\s<]+/g, url => {
    const label = url.includes("openstreetmap.org/directions") ? "Open directions ↗" : url.replace(/^https?:\/\//, "").slice(0, 40);
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
}

export function clock(at: number | undefined, timeZone: string): string {
  if (!at) return "—";
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone }).format(at);
}

export function clockSeconds(at: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", timeZone }).format(at);
}

export function sourceBadge(source: SourceRef | undefined): string {
  if (!source) return "";
  const label = { official: "Official", gods_eye: "God's Eye", routing: "Routing", demo_fixture: "Demo data" }[source.kind];
  const live = source.live ? `<span class="live-dot" aria-hidden="true"></span>` : "";
  return `<span class="source-badge source-${source.kind}" title="${escapeHtml(source.name)}">${live}${label}</span>`;
}

export function initials(name: string): string {
  return name.split(/\s+/).map(part => part[0]).join("").slice(0, 2).toUpperCase();
}

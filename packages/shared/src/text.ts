/**
 * Splits a long outbound text into a few shorter iMessages for readability.
 * Paragraphs (blank-line separated) are the preferred break points; a paragraph
 * that is itself too long is broken at line boundaries. Lines are never cut mid-way
 * (so URLs stay intact), and short adjacent pieces are packed together, so a text
 * at or under `maxLength` is always sent as a single message. Pure and deterministic.
 */

export const DEFAULT_MAX_MESSAGE_LENGTH = 200;

export function splitMessage(text: string, maxLength: number = DEFAULT_MAX_MESSAGE_LENGTH): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= maxLength) return [trimmed];

  type Unit = { text: string; separator: string };
  const units: Unit[] = [];
  for (const paragraph of trimmed.split(/\n[ \t]*\n/)) {
    const body = paragraph.trim();
    if (!body) continue;
    if (body.length <= maxLength) {
      units.push({ text: body, separator: "\n\n" });
      continue;
    }
    body.split("\n").map(line => line.trim()).filter(Boolean).forEach((line, index) => {
      units.push({ text: line, separator: index === 0 ? "\n\n" : "\n" });
    });
  }

  const chunks: string[] = [];
  let current = "";
  for (const unit of units) {
    const candidate = current ? `${current}${unit.separator}${unit.text}` : unit.text;
    if (!current || candidate.length <= maxLength) {
      current = candidate;
    } else {
      chunks.push(current);
      current = unit.text;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

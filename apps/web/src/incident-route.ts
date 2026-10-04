export function incidentIdFromPathname(pathname: string): string | undefined {
  const match = /^\/incident\/([^/]+)\/?$/.exec(pathname);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return undefined;
  }
}

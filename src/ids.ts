export function nextId(prefix: string, existingIds: string[]): string {
  const max = existingIds.reduce((highest, id) => {
    const match = new RegExp(`^${prefix}-(\\d+)$`).exec(id);
    if (!match) return highest;
    const value = Number.parseInt(match[1] ?? "0", 10);
    return Number.isFinite(value) ? Math.max(highest, value) : highest;
  }, 0);
  return `${prefix}-${String(max + 1).padStart(3, "0")}`;
}

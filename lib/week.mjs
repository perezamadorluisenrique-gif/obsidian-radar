// Time helpers. Everything is UTC. RADAR_NOW pins the clock for tests and dry runs.
export const now = () => (process.env.RADAR_NOW ? new Date(process.env.RADAR_NOW) : new Date());

export const DAY = 86_400_000;
export const dayStr = (d) => new Date(d).toISOString().slice(0, 10);
export const parseDay = (s) => (s ? Date.parse(`${s}T00:00:00Z`) : NaN);
export const daysBetween = (a, b) => (new Date(b) - new Date(a)) / DAY;

/** ISO-8601 week id such as "2026-W43". */
export function weekId(date = now()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7)); // Thursday of this ISO week decides the year
  const week = Math.ceil(((d - Date.UTC(d.getUTCFullYear(), 0, 1)) / DAY + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export const isWeekId = (s) => /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/.test(s);

/** Monday 00:00 UTC of an ISO week id. */
export function weekStart(id) {
  const [, y, w] = /^(\d{4})-W(\d{2})$/.exec(id) ?? [];
  if (!y) throw new Error(`bad week id: ${id}`);
  const jan4 = new Date(Date.UTC(+y, 0, 4));
  const monday = new Date(jan4 - ((jan4.getUTCDay() || 7) - 1) * DAY);
  return new Date(+monday + (+w - 1) * 7 * DAY);
}

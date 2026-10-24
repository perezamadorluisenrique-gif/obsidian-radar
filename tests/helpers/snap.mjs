// Tiny in-memory snapshot builder for analysis tests.
import { dayStr, weekStart } from '../../lib/week.mjs';

/** snap('2026-W43', { a: { dl: 5 } }) -> a schema-shaped snapshot captured on that Monday at 05:41 UTC. */
export function snap(week, data, capturedAt) {
  const at = capturedAt ?? `${dayStr(weekStart(week))}T05:41:00Z`;
  const n = Object.keys(data).length;
  return { schema: 1, week, capturedAt: at, plugins: n, refresh: { state: 'rolling', transport: 'none', withMeta: 0, pending: n, refreshed: 0, limited: false }, data };
}

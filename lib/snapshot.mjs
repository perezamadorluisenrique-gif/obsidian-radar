import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { isWeekId } from './week.mjs';

export const SNAPSHOT_RE = /^(\d{4}-W\d{2})\.json\.gz$/;

export const snapshotFile = (dir, week) => path.join(dir, `${week}.json.gz`);

/** Snapshot files in a directory, oldest first. */
export function listSnapshots(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .map((f) => SNAPSHOT_RE.exec(f))
    .filter((m) => m && isWeekId(m[1]))
    .map((m) => ({ week: m[1], file: path.join(dir, m[0]) }))
    .sort((a, b) => a.week.localeCompare(b.week));
}

export const readSnapshot = (file) => JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));

/** Record keys in a fixed order (stats, then GitHub metadata) so the bytes never depend on the order they were filled in. */
const KEY_ORDER = ['dl', 'rel', 'push', 'crt', 'arch', 'stars', 'iss', 'fr', 'gone', 'chk', 'src'];
const canonical = (rec) => {
  const out = {};
  for (const k of KEY_ORDER) if (k in rec) out[k] = rec[k];
  for (const k of Object.keys(rec).sort()) if (!(k in out)) out[k] = rec[k]; // keys added later keep a stable place too
  return out;
};

/** Plugin ids and record keys are written in a fixed order so a re-run with the same inputs gives identical bytes. */
export function serializeSnapshot(snap) {
  const data = {};
  for (const id of Object.keys(snap.data).sort()) data[id] = canonical(snap.data[id]);
  return zlib.gzipSync(Buffer.from(JSON.stringify({ ...snap, data })), { level: 9 });
}

/** Atomic write (temp file + rename) so an interrupted run never leaves a half-written snapshot. */
export function writeSnapshot(dir, snap) {
  fs.mkdirSync(dir, { recursive: true });
  const file = snapshotFile(dir, snap.week);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, serializeSnapshot(snap));
  fs.renameSync(tmp, file);
  return file;
}

/** GitHub metadata present on a plugin record? (`chk` is the day it was last checked.) */
export const hasMeta = (rec) => Boolean(rec && rec.chk);

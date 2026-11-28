// Builds Delhi's platform numbers from the checked sheet.
//   node scripts/build-platforms.ts [path/to/DMRC.csv]     (from Server/; default ../Docs/platforms/DMRC.csv)
// Out: seed/delhi/platforms.json, one document per station per line:
//   { _id: 'delhi:blue@delhi:yamuna-bank', line, station, directions: [{ towards, next: [stationId], platforms: [2, 4] }] }
// `next` is the station the train calls at next, so a ride from A to B on a line finds its platform by B (or by
// the next stop on the way to B). Two platforms (2/4) mean trains that way leave from either, depending on branch.
// Fails (exit 1) if a row names an unknown line or station, or a next station that isn't beside it on that line.
import { readFileSync, writeFileSync } from 'node:fs';

const csvPath = process.argv[2] ?? new URL('../../Docs/platforms/DMRC.csv', import.meta.url).pathname;
const dir = new URL('../seed/delhi/', import.meta.url);
const lines: { _id: string; name: string; stations: string[] }[] = JSON.parse(readFileSync(new URL('lines.json', dir), 'utf8'));
const stations: { _id: string; name: string }[] = JSON.parse(readFileSync(new URL('stations.json', dir), 'utf8'));

// RFC 4180 CSV: quoted fields may hold commas, quotes ("") and line breaks.
function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (c === '"') quoted = false; else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows.filter((r) => r.some(Boolean));
  return body.map((r) => Object.fromEntries(head.map((k, i) => [k, r[i] ?? ''])));
}

const lineByName = new Map(lines.map((l) => [l.name, l]));
const idByName = new Map(stations.map((s) => [s.name, s._id]));
// nextStop: a loop line has no end to head towards, so `towards` names the next station instead.
type Direction = { towards: string; next: string[]; platforms: number[]; nextStop?: true };
type Doc = { _id: string; cityId: string; line: string; station: string; directions: Direction[]; source?: string; checkedOn?: string };
const errors: string[] = [];
const docs: Doc[] = [];

for (const row of parseCsv(readFileSync(csvPath, 'utf8'))) {
  const line = lineByName.get(row.line);
  if (!line) { errors.push(`unknown line "${row.line}"`); continue; }
  const at = `${row.station} (${line._id})`;
  if (!line.stations.includes(row.station_id)) { errors.push(`${at}: ${row.station_id} is not on this line`); continue; }
  // Stations either side on this line (a loop lists its first station again at the end, and Rapid's Phase-2 twice).
  const beside = new Set(line.stations.flatMap((s, i) => (s === row.station_id ? [line.stations[i - 1], line.stations[i + 1]] : [])));

  const directions: Direction[] = [];
  for (const d of ['dir1', 'dir2']) {
    const plat = row[`${d}_platform`].trim();
    if (!plat) continue; // end of the line, or not known yet
    // Trains running on past where this line ends (Kirti Nagar branch at Ashok Park Main): the other line's row has it.
    if (!row[`${d}_next`].trim()) continue;
    const platforms = plat.split('/').map(Number);
    if (platforms.some((n) => !Number.isInteger(n) || n < 1)) { errors.push(`${at}: bad platform "${plat}"`); continue; }
    const next = row[`${d}_next`].split(' or ').map((n) => idByName.get(n.trim()));
    if (next.some((id) => !id || !beside.has(id))) { errors.push(`${at}: next "${row[`${d}_next`]}" isn't beside it on the line`); continue; }
    // Loop lines (Pink ring, Rapid Metro) have "Clockwise", "Loop" and the like here: name the next station instead.
    const loopWord = /^(anti)?clockwise$|loop$/i.test(row[`${d}_towards`].trim());
    const nextNames = (next as string[]).map((id) => stations.find((x) => x._id === id)!.name).join(' or ');
    directions.push(loopWord ? { towards: nextNames, next: next as string[], platforms, nextStop: true } : { towards: row[`${d}_towards`], next: next as string[], platforms });
  }
  if (!directions.length) continue; // nothing known here (e.g. Soorghat, not open yet)
  docs.push({
    _id: `${line._id}@${row.station_id}`, cityId: 'delhi', line: line._id, station: row.station_id, directions,
    ...(row.source && { source: row.source }), ...(row.checked_on && { checkedOn: row.checked_on }),
  });
}

if (errors.length) { console.error('PLATFORMS FAILED\n' + errors.join('\n')); process.exit(1); }
writeFileSync(new URL('platforms.json', dir), JSON.stringify(docs, null, 1) + '\n');

// Worth checking in DMRC's planner (warnings, not errors): along a line the lower platform nearly always faces the
// same way, so a station that flips it is a likely swap (Rajiv Chowk Blue was one); and two directions at one
// station rarely share a number. Real exceptions exist (shared island platforms, Rapid Metro's own numbering).
const suspects: string[] = [];
for (const line of lines) {
  // (one platform both ways, like Rapid Metro's Belvedere Towers, has no direction to compare)
  const two = docs.filter((d) => d.line === line._id && d.directions.length === 2 && d.directions[0].platforms.join() !== d.directions[1].platforms.join());
  const lowFirst = (d: Doc) => Math.min(...d.directions[0].platforms) < Math.min(...d.directions[1].platforms);
  const usual = two.filter(lowFirst).length * 2 >= two.length;
  for (const d of two) if (lowFirst(d) !== usual) suspects.push(`${d._id}: lower platform faces the other way from the rest of the line`);
}
const used = new Map<string, string[]>();
for (const d of docs) for (const x of d.directions) for (const n of x.platforms) used.set(`${d.station} PF ${n}`, [...(used.get(`${d.station} PF ${n}`) ?? []), `${d.line} towards ${x.towards}`]);
for (const [k, v] of used) if (new Set(v).size > 1) suspects.push(`${k} is used by ${v.join(' and ')}`);
if (suspects.length) console.warn(`check in DMRC's planner (${suspects.length}):\n  ` + suspects.join('\n  '));
const dirs = docs.flatMap((d) => d.directions);
console.log(`platforms: ${docs.length} station-lines · ${dirs.length} directions (${dirs.filter((d) => d.platforms.length > 1).length} with two platforms)`);

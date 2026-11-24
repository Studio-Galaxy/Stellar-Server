// Builds Stellar's Delhi seed collections from the hand-transcribed official map.
//   node scripts/build-delhi.ts            (from Server/)
// In:  seed/delhi/network.source.json
// Out: seed/delhi/{lines,stations,segments,interchanges}.json + seed/delhi/REPORT.md
// Fails (exit 1) if any line disagrees with the official station counts it can be checked against.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { haversineKm, slug } from './lib.ts';

type StationRef = string | { name: string; open: boolean };
type SourceLine = {
  id: string; name: string; ref: string; color: string; operator: string;
  official: { stations: number; km: number; note?: string } | null;
  stations: StationRef[]; loop?: string;
};
type Source = { source: Record<string, string>; lines: SourceLine[]; walkways: { a: string; b: string; note: string }[] };

const dir = new URL('../seed/delhi/', import.meta.url);
const src: Source = JSON.parse(readFileSync(new URL('network.source.json', dir), 'utf8'));

const nameOf = (s: StationRef) => (typeof s === 'string' ? s : s.name);
const isOpen = (s: StationRef) => typeof s === 'string' || s.open;

// Lines that share one official figure (two branches/sections counted together).
const GROUPS: Record<string, string[]> = {
  'delhi:green': ['delhi:green', 'delhi:green-kirti'],
  'delhi:pink': ['delhi:pink', 'delhi:pink-north'],
  'delhi:magenta': ['delhi:magenta', 'delhi:magenta-north'],
};
// How each official count is defined (see the notes in network.source.json).
const COUNT_RULE: Record<string, 'union' | 'sum'> = { 'delhi:magenta': 'sum' };
// Ponytail: walk times are estimates until measured; same-station changes 4 min, walkways 8 min.
const WALK_SAME = 4, WALK_WALKWAY = 8;
// Average speed incl. dwell, used until DMRC run times are added (km/h).
const SPEED: Record<string, number> = { DMRC: 33, NMRC: 33, RMGL: 30, 'delhi:airport': 55 };

const problems: string[] = [];
const report: string[] = [];
const byId = new Map(src.lines.map((l) => [l.id, l]));

// ---------- stations ----------
const stations = new Map<string, { _id: string; cityId: string; name: string; lines: string[]; open: boolean; aliases: string[]; geo?: object; geoSource?: string }>();
for (const l of src.lines) {
  const seen = new Set<string>();
  l.stations.forEach((s, i) => {
    const name = nameOf(s), id = slug(name);
    const loopClose = l.loop && i === l.stations.length - 1 && name === nameOf(l.stations[0]) || (l.loop && seen.has(id) && i === l.stations.length - 1);
    if (seen.has(id) && !loopClose) problems.push(`${l.id}: "${name}" listed twice`);
    seen.add(id);
    const st = stations.get(id) ?? { _id: id, cityId: 'delhi', name, lines: [], open: true, aliases: [] };
    if (st.name !== name) problems.push(`${id}: spelled "${st.name}" and "${name}"`);
    if (!st.lines.includes(l.id)) st.lines.push(l.id);
    if (!isOpen(s)) st.open = false;
    stations.set(id, st);
  });
}
for (const w of src.walkways) for (const n of [w.a, w.b]) if (!stations.has(slug(n))) problems.push(`walkway: unknown station "${n}"`);

// ---------- official count checks ----------
report.push('| Line | Stations (ours) | Official | Result |', '|---|---|---|---|');
for (const l of src.lines) {
  if (!l.official) continue;
  const members = (GROUPS[l.id] ?? [l.id]).map((id) => byId.get(id)!);
  const lists = members.map((m) => [...new Set(m.stations.filter(isOpen).map((s) => slug(nameOf(s))))]);
  const ours = COUNT_RULE[l.id] === 'sum' ? lists.reduce((a, x) => a + x.length, 0) : new Set(lists.flat()).size;
  const ok = ours === l.official.stations;
  if (!ok) problems.push(`${l.id}: ${ours} open stations, official ${l.official.stations}`);
  report.push(`| ${l.name}${members.length > 1 ? ' (all sections)' : ''} | ${ours} | ${l.official.stations} | ${ok ? '✅' : '❌'}${l.official.note ? ' ' + l.official.note : ''} |`);
}

// ---------- station positions (seed/delhi/coords.json, made by scripts/match-coords.ts) ----------
const coordsFile = new URL('coords.json', dir);
const coords: Record<string, { lat: number; lon: number; source: string }> = existsSync(coordsFile) ? JSON.parse(readFileSync(coordsFile, 'utf8')) : {};
for (const st of stations.values()) {
  const c = coords[st._id];
  if (c) Object.assign(st, { geo: { type: 'Point', coordinates: [c.lon, c.lat] }, geoSource: c.source });
  else problems.push(`${st._id}: no coordinates`);
}

// ---------- segments (between consecutive OPEN stations; closed ones are passed through) ----------
// Distance = straight-line distance between neighbouring stations, scaled per line (or line group) so the
// total equals DMRC's official length — tracks curve, so straight lines always fall a little short.
const segments: { cityId: string; line: string; from: string; to: string; km: number; minutes: number; kmSource: string }[] = [];
const straight = (a: string, b: string) => (coords[a] && coords[b] ? haversineKm(coords[a], coords[b]) : NaN);
const lineStraightKm = (l: SourceLine) =>
  l.stations.slice(1).reduce((a, s, i) => a + straight(slug(nameOf(l.stations[i])), slug(nameOf(s))), 0);
const scaleOf = new Map<string, number>();
report.push('', '## Distance scaling (official length ÷ straight-line length)', '', '| Line | Straight-line km | Official km | Factor |', '|---|---|---|---|');
for (const l of src.lines) {
  if (!l.official) continue;
  const members = (GROUPS[l.id] ?? [l.id]).map((id) => byId.get(id)!);
  const raw = members.reduce((a, m) => a + lineStraightKm(m), 0);
  const factor = l.official.km / raw;
  for (const m of members) scaleOf.set(m.id, factor);
  // Real track is never shorter than the straight line, and rarely more than ~35% longer.
  const plausible = factor >= 1 && factor <= 1.35;
  if (!plausible) problems.push(`${l.id}: distance factor ${factor.toFixed(3)} is implausible — check coordinates`);
  report.push(`| ${l.name}${members.length > 1 ? ' (all sections)' : ''} | ${raw.toFixed(2)} | ${l.official.km} | ${factor.toFixed(3)}${plausible ? '' : ' ❌'} |`);
}
for (const l of src.lines) {
  const factor = scaleOf.get(l.id) ?? 1;
  const speed = SPEED[l.id] ?? SPEED[l.operator] ?? 33;
  let prev = 0, acc = 0;
  for (let i = 1; i < l.stations.length; i++) {
    acc += straight(slug(nameOf(l.stations[i - 1])), slug(nameOf(l.stations[i])));
    if (!isOpen(l.stations[i])) continue; // pass through closed stations, keep adding distance
    const km = Math.round(acc * factor * 1000) / 1000;
    const from = slug(nameOf(l.stations[prev])), to = slug(nameOf(l.stations[i]));
    const maxGap = l.id === 'delhi:airport' ? 10 : 4.5; // the Airport Express has long gaps by design
    if (!(km >= 0.4 && km <= maxGap)) problems.push(`${l.id}: ${from} → ${to} is ${km} km — check`);
    segments.push({
      cityId: 'delhi', line: l.id, from, to, km,
      minutes: Math.round((km / speed) * 60 * 10) / 10,
      kmSource: 'coords-scaled-to-official-length',
    });
    prev = i; acc = 0;
  }
}

// ---------- interchanges ----------
const interchanges: { cityId: string; station: string; toStation: string; fromLine: string; toLine: string; walkMin: number; kind: string }[] = [];
for (const st of stations.values()) {
  for (const a of st.lines) for (const b of st.lines) if (a < b)
    interchanges.push({ cityId: 'delhi', station: st._id, toStation: st._id, fromLine: a, toLine: b, walkMin: WALK_SAME, kind: 'same-station' });
}
for (const w of src.walkways) {
  const A = stations.get(slug(w.a)), B = stations.get(slug(w.b));
  if (!A || !B) continue;
  for (const a of A.lines) for (const b of B.lines)
    interchanges.push({ cityId: 'delhi', station: A._id, toStation: B._id, fromLine: a, toLine: b, walkMin: WALK_WALKWAY, kind: 'walkway' });
}

// ---------- lines ----------
const lines = src.lines.map((l) => ({
  _id: l.id, cityId: 'delhi', name: l.name, ref: l.ref, color: l.color, operator: l.operator,
  stations: l.stations.map((s) => slug(nameOf(s))),
  ...(l.loop ? { loop: true } : {}),
}));

// ---------- write ----------
const write = (f: string, data: unknown) => writeFileSync(new URL(f, dir), JSON.stringify(data, null, 1) + '\n');
write('lines.json', lines);
write('stations.json', [...stations.values()]);
write('segments.json', segments);
write('interchanges.json', interchanges);

const unique = stations.size, open = [...stations.values()].filter((s) => s.open).length;
const ix = [...stations.values()].filter((s) => s.lines.length > 1).length;
writeFileSync(new URL('REPORT.md', dir), [
  '# Delhi network build report', '',
  `Source: ${src.source.title}, as on ${src.source.asOf} — transcribed ${src.source.transcribed}.`, '',
  `- Lines/sections: ${lines.length}`, `- Unique stations: ${unique} (${open} open, ${unique - open} built but not open)`,
  `- Interchange stations: ${ix} (+ ${src.walkways.length} walkway links)`, `- Segments: ${segments.length}`, '',
  '## Official station counts', '', ...report, '',
  '## Known estimates (not yet exact)', '',
  '- Distance between stations: straight-line distance between real station positions (OpenStreetMap), scaled so each line totals its official DMRC length. Accurate to well under a kilometre per gap; confirm with the journey spot-checks.',
  '- Travel time: distance ÷ average speed. To be replaced with DMRC run times.',
  `- Interchange walk times: ${WALK_SAME} min same station, ${WALK_WALKWAY} min walkway (estimates).`,
  '- Rapid Metro loop direction not stated on the map.', '',
  problems.length ? '## ❌ Problems\n\n' + problems.map((p) => `- ${p}`).join('\n') : '## ✅ No problems found', '',
].join('\n'));

console.log(`lines ${lines.length} · stations ${unique} (${open} open) · interchanges ${ix} · segments ${segments.length}`);
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log('all official counts match');

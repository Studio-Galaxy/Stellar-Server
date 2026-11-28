// Loads the built Delhi seed into MongoDB, creates indexes, then validates what is in the database.
//   npm run import:delhi        (from Server/, reads MONGODB_URI / MONGODB_DB from .env)
// Safe to re-run: Delhi documents are replaced, other cities are untouched.
import { readFileSync } from 'node:fs';
import { MongoClient } from 'mongodb';

const { MONGODB_URI, MONGODB_DB = 'metro' } = process.env;
if (!MONGODB_URI) throw new Error('MONGODB_URI is not set');

const read = (p: string) => JSON.parse(readFileSync(new URL(`../seed/${p}`, import.meta.url), 'utf8'));
const seed = {
  cities: read('cities.json'),
  settings: read('settings.json'),
  lines: read('delhi/lines.json'),
  stations: read('delhi/stations.json'),
  segments: read('delhi/segments.json'),
  interchanges: read('delhi/interchanges.json'),
  fares: read('delhi/fares.json'),
  platforms: read('delhi/platforms.json'), // scripts/build-platforms.ts
};

const client = new MongoClient(MONGODB_URI);
await client.connect();
const db = client.db(MONGODB_DB);
try {
  // ---------- load ----------
  // The live version belongs to publish: re-importing must never take a city offline (seed has null).
  for (const { liveVersion, ...c } of seed.cities)
    await db.collection('cities').updateOne({ _id: c._id }, { $set: c, $setOnInsert: { liveVersion: liveVersion ?? null } }, { upsert: true });
  await db.collection('settings').replaceOne({ _id: seed.settings._id }, seed.settings, { upsert: true });
  for (const name of ['lines', 'stations', 'segments', 'interchanges', 'fares', 'platforms'] as const) {
    const col = db.collection(name);
    await col.deleteMany({ cityId: 'delhi' });
    await col.insertMany(seed[name]);
  }

  // ---------- indexes ----------
  await db.collection('cities').createIndex({ status: 1, order: 1 });
  await db.collection('lines').createIndex({ cityId: 1 });
  await db.collection('stations').createIndex({ cityId: 1 });
  await db.collection('stations').createIndex({ geo: '2dsphere' }); // "nearest station" queries
  await db.collection('segments').createIndex({ cityId: 1, line: 1 });
  await db.collection('interchanges').createIndex({ cityId: 1, station: 1 });
  await db.collection('platforms').createIndex({ cityId: 1, station: 1 });
  await db.collection('fares').createIndex({ cityId: 1, operator: 1, effectiveFrom: -1 });
  await db.collection('networkSnapshots').createIndex({ cityId: 1, version: 1 }, { unique: true });

  // ---------- validate what the database now holds ----------
  const q = { cityId: 'delhi' };
  const [lines, stations, segments, interchanges, platforms] = await Promise.all(
    ['lines', 'stations', 'segments', 'interchanges', 'platforms'].map((c) => db.collection<{ _id: string } & Record<string, any>>(c).find(q).toArray()));
  const stationIds = new Set(stations.map((s) => s._id));
  const lineIds = new Set(lines.map((l) => l._id));
  const errors: string[] = [];
  const expect = (name: string, got: number, want: number) => got !== want && errors.push(`${name}: ${got} in DB, ${want} in seed`);
  expect('lines', lines.length, seed.lines.length);
  expect('stations', stations.length, seed.stations.length);
  expect('segments', segments.length, seed.segments.length);
  expect('interchanges', interchanges.length, seed.interchanges.length);
  expect('platforms', platforms.length, seed.platforms.length);
  for (const l of lines) for (const s of l.stations) if (!stationIds.has(s)) errors.push(`line ${l._id}: unknown station ${s}`);
  for (const s of segments) for (const id of [s.from, s.to]) if (!stationIds.has(id)) errors.push(`segment ${s.line}: unknown station ${id}`);
  for (const s of segments) if (!lineIds.has(s.line)) errors.push(`segment: unknown line ${s.line}`);
  for (const i of interchanges) {
    for (const id of [i.station, i.toStation]) if (!stationIds.has(id)) errors.push(`interchange: unknown station ${id}`);
    for (const id of [i.fromLine, i.toLine]) if (!lineIds.has(id)) errors.push(`interchange: unknown line ${id}`);
  }
  for (const p of platforms) {
    if (!lineIds.has(p.line)) errors.push(`platforms: unknown line ${p.line}`);
    for (const id of [p.station, ...p.directions.flatMap((d: { next: string[] }) => d.next)]) if (!stationIds.has(id)) errors.push(`platforms ${p._id}: unknown station ${id}`);
  }
  for (const s of stations) if (!s.geo) errors.push(`station without position: ${s._id}`);
  // the geo index really answers: nearest station to Rajiv Chowk's own position must be Rajiv Chowk
  const rc = stations.find((s) => s._id === 'delhi:rajiv-chowk');
  const nearest = rc && await db.collection<{ _id: string }>('stations').findOne({ geo: { $near: { $geometry: rc.geo } } });
  if (nearest?._id !== 'delhi:rajiv-chowk') errors.push(`geo index check failed (got ${nearest?._id})`);
  const onALine = new Set(lines.flatMap((l) => l.stations));
  for (const s of stations) if (!onALine.has(s._id)) errors.push(`orphan station ${s._id}`);
  // every open station must be reachable from every other (one connected network)
  const adj = new Map<string, string[]>();
  const link = (a: string, b: string) => { adj.set(a, [...(adj.get(a) ?? []), b]); adj.set(b, [...(adj.get(b) ?? []), a]); };
  for (const s of segments) link(s.from, s.to);
  for (const i of interchanges) if (i.station !== i.toStation) link(i.station, i.toStation);
  const open = stations.filter((s) => s.open).map((s) => s._id);
  const seen = new Set([open[0]]), stack = [open[0]];
  while (stack.length) for (const n of adj.get(stack.pop()!) ?? []) if (!seen.has(n)) { seen.add(n); stack.push(n); }
  for (const id of open) if (!seen.has(id)) errors.push(`not connected to the network: ${id}`);

  console.log(`imported: ${lines.length} lines · ${stations.length} stations · ${segments.length} segments · ${interchanges.length} interchanges · ${platforms.length} platform entries · ${seed.fares.length} fare tables`);
  if (errors.length) { console.error('VALIDATION FAILED\n' + errors.join('\n')); process.exitCode = 1; }
  else console.log('validation passed: references intact, no orphans, network fully connected');
} finally {
  await client.close();
}

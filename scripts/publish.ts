// Freezes a city's current data into one versioned snapshot — the only thing the app downloads.
//   npm run publish -- delhi              publish a new version (skipped if nothing changed)
//   npm run publish -- delhi --rollback 3 point the app back at version 3
// The app never sees half-edited data: it switches only when cities.liveVersion changes.
import { createHash } from 'node:crypto';
import { MongoClient } from 'mongodb';

const [cityId, flag, arg] = process.argv.slice(2);
if (!cityId) throw new Error('usage: publish <cityId> [--rollback <version>]');
const { MONGODB_URI, MONGODB_DB = 'metro' } = process.env;
if (!MONGODB_URI) throw new Error('MONGODB_URI is not set');

type Doc = Record<string, unknown> & { _id?: unknown };
const client = new MongoClient(MONGODB_URI);
await client.connect();
const db = client.db(MONGODB_DB);
const cities = db.collection<{ _id: string; status: string; liveVersion?: number | null }>('cities');
const snapshots = db.collection('networkSnapshots');

try {
  const city = await cities.findOne({ _id: cityId });
  if (!city) throw new Error(`unknown city "${cityId}"`);

  if (flag === '--rollback') {
    const version = Number(arg);
    if (!(await snapshots.findOne({ cityId, version }))) throw new Error(`no snapshot ${cityId} v${version}`);
    await cities.updateOne({ _id: cityId }, { $set: { liveVersion: version } });
    console.log(`${cityId}: live version is now v${version}`);
  } else {
    const load = (name: string) => db.collection<Doc>(name).find({ cityId }).toArray();
    const [lines, stations, segments, interchanges, fares, platforms] = await Promise.all(
      ['lines', 'stations', 'segments', 'interchanges', 'fares', 'platforms'].map(load));
    if (!lines.length || !stations.length || !segments.length) throw new Error(`${cityId} has no network data — run the import first`);

    // Shape for the app: no database internals, positions as plain lat/lon.
    const strip = ({ _id, cityId: _c, ...rest }: Doc) => rest;
    const data = {
      lines: lines.map(({ _id, cityId: _c, ...l }) => ({ id: _id, ...l })),
      stations: stations.map(({ _id, cityId: _c, geo, geoSource: _g, ...s }) => {
        const [lon, lat] = (geo as { coordinates: [number, number] }).coordinates;
        return { id: _id, ...s, lat, lon };
      }),
      segments: segments.map((s) => { const { kmSource: _k, ...rest } = strip(s); return rest; }),
      interchanges: interchanges.map(strip),
      fares: fares.map(strip),
      platforms: platforms.map(strip), // { line, station, directions: [{ towards, next, platforms }] }
    };
    const checksum = createHash('sha256').update(JSON.stringify(data)).digest('hex');
    const latest = await snapshots.find({ cityId }).sort({ version: -1 }).limit(1).next();

    if (latest?.checksum === checksum && city.liveVersion === latest.version) {
      console.log(`${cityId}: nothing changed — still v${latest.version}`);
    } else {
      const version = (latest?.version ?? 0) + 1;
      const settings = await db.collection<{ _id: string; attribution?: string }>('settings').findOne({ _id: 'app' });
      await snapshots.insertOne({
        cityId, version, publishedAt: new Date(), checksum,
        attribution: settings?.attribution ?? null,
        counts: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v.length])),
        data,
      });
      await cities.updateOne({ _id: cityId }, { $set: { liveVersion: version } });
      const kb = (Buffer.byteLength(JSON.stringify(data)) / 1024).toFixed(0);
      console.log(`${cityId}: published v${version} (${kb} KB) — ${Object.entries(data).map(([k, v]) => `${v.length} ${k}`).join(', ')}`);
    }
  }
} finally {
  await client.close();
}

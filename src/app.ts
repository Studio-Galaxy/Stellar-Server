// The Stellar API: read-only, three endpoints. Separate from index.ts so tests can pass in a fake db.
import compress from '@fastify/compress';
import Fastify, { type FastifyServerOptions } from 'fastify';
import type { Db } from 'mongodb';

type City = { _id: string; name: string; status: 'live' | 'coming_soon'; order: number; subtitle?: string; cardColor?: string; liveVersion?: number | null };

// Browser/app caches for a minute; Vercel's CDN keeps responses 5 min and serves a stale copy while it
// refreshes — most requests never reach the function or the database. A newly published snapshot
// therefore reaches everyone within ~5 minutes.
const CACHE = 'public, max-age=60, s-maxage=300, stale-while-revalidate=600';

export async function buildApp(db: Db, opts: FastifyServerOptions = { logger: true }) {
  const app = Fastify(opts);
  await app.register(compress); // gzip/brotli when the client asks for it

  app.get('/health', async () => {
    await db.command({ ping: 1 });
    return { ok: true };
  });

  // App-wide controls: minimum app version, maintenance switch, credits.
  app.get('/settings', async (_req, reply) => {
    const s = await db.collection<{ _id: string }>('settings').findOne({ _id: 'app' });
    if (!s) return reply.code(404).send({ error: 'settings not found' });
    const { _id, ...settings } = s;
    reply.header('cache-control', CACHE);
    return settings;
  });

  // Home screen cards.
  app.get('/cities', async (_req, reply) => {
    const cities = await db.collection<City>('cities').find({}).sort({ order: 1 }).toArray();
    reply.header('cache-control', CACHE);
    return cities.map((c) => ({
      id: c._id, name: c.name, status: c.status, order: c.order,
      subtitle: c.subtitle ?? null, cardColor: c.cardColor ?? null, version: c.liveVersion ?? null,
    }));
  });

  // A city's whole network in one download. If the app already holds the live version (?v=N or
  // If-None-Match), answer 304 with no body so nothing is downloaded twice.
  app.get<{ Params: { id: string }; Querystring: { v?: number } }>('/cities/:id/network', {
    schema: {
      params: { type: 'object', properties: { id: { type: 'string', pattern: '^[a-z0-9-]{1,40}$' } } },
      querystring: { type: 'object', properties: { v: { type: 'integer', minimum: 1 } } },
    },
  }, async (req, reply) => {
    const city = await db.collection<City>('cities').findOne({ _id: req.params.id });
    if (!city) return reply.code(404).send({ error: 'unknown city' });
    if (city.status !== 'live' || !city.liveVersion) return reply.code(404).send({ error: 'city is not live yet' });

    const etag = `"${city._id}-v${city.liveVersion}"`;
    reply.header('etag', etag).header('cache-control', CACHE);
    if (req.query.v === city.liveVersion || req.headers['if-none-match'] === etag) return reply.code(304).send();

    const snap = await db.collection('networkSnapshots')
      .findOne({ cityId: city._id, version: city.liveVersion }, { projection: { _id: 0, checksum: 0 } });
    if (!snap) return reply.code(503).send({ error: 'snapshot missing — republish this city' });
    return snap;
  });

  return app;
}

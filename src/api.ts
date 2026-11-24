// The Stellar API routes: read-only. Kept apart from index.ts so tests can run them against a fake db.
// Not named app.ts on purpose: Vercel treats src/app.* as the server entry, and this file never listens.
import { readFileSync } from 'node:fs';

import compress from '@fastify/compress';
import type { FastifyInstance } from 'fastify';
import type { Db } from 'mongodb';

type City = { _id: string; name: string; status: 'live' | 'coming_soon'; order: number; subtitle?: string; cardColor?: string; liveVersion?: number | null };

// Browser/app caches for a minute; Vercel's CDN keeps responses 5 min and serves a stale copy while it
// refreshes — most requests never reach the function or the database. A newly published snapshot
// therefore reaches everyone within ~5 minutes.
const CACHE = 'public, max-age=60, s-maxage=300, stale-while-revalidate=600';

// The human-facing home page and its files live in public/ (city backgrounds + moving trains are exported
// from the design board, Docs/design/build-design-board.mjs). Vercel's Fastify setup does not publish
// public/ to its CDN, so this API serves them — with stale-while-revalidate, so the CDN keeps showing its
// last good copy even if the function fails, and the page itself then reports the API as unavailable.
const PAGE_CACHE = 'public, max-age=300, s-maxage=3600, stale-while-revalidate=31536000';
const BG_CACHE = 'public, max-age=86400, s-maxage=604800, stale-while-revalidate=31536000';
const read = (f: string) => readFileSync(new URL(`../public/${f}`, import.meta.url));
const landing = read('index.html');
const backgrounds = { 'map-light': read('bg/map-light.svg'), 'map-dark': read('bg/map-dark.svg'), traffic: read('bg/traffic.svg') };

export async function registerApi(app: FastifyInstance, db: Db) {
  await app.register(compress); // gzip/brotli when the client asks for it

  app.get('/', (_req, reply) => {
    reply.type('text/html; charset=utf-8').header('cache-control', PAGE_CACHE);
    return reply.send(landing);
  });
  for (const [name, svg] of Object.entries(backgrounds)) {
    app.get(`/bg/${name}.svg`, (_req, reply) => {
      reply.type('image/svg+xml').header('cache-control', BG_CACHE);
      return reply.send(svg);
    });
  }

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

}

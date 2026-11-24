// Endpoint tests against a tiny in-memory stand-in for MongoDB — no network, no real data touched.
//   npm test
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { test } from 'node:test';
import type { Db } from 'mongodb';

import Fastify from 'fastify';

import { registerApi } from '../src/api.ts';

type Row = Record<string, unknown>;
const data: Record<string, Row[]> = {
  settings: [{ _id: 'app', minAppVersion: '1.0.0', maintenance: false }],
  cities: [
    { _id: 'mumbai', name: 'Mumbai', status: 'coming_soon', order: 2 },
    { _id: 'delhi', name: 'Delhi NCR', status: 'live', order: 1, liveVersion: 2, subtitle: 'DMRC · Noida · Gurugram' },
  ],
  networkSnapshots: [
    { _id: 'x1', cityId: 'delhi', version: 1, checksum: 'a', data: { stations: [] } },
    { _id: 'x2', cityId: 'delhi', version: 2, checksum: 'b', data: { stations: Array.from({ length: 300 }, (_, i) => ({ id: `s${i}`, name: `Station ${i}` })) } },
  ],
};
const matches = (row: Row, q: Row) => Object.entries(q).every(([k, v]) => row[k] === v);
const project = (row: Row, p?: Record<string, 0>) => p ? Object.fromEntries(Object.entries(row).filter(([k]) => p[k] !== 0)) : row;
const fakeDb = {
  command: async () => ({ ok: 1 }),
  collection: (name: string) => ({
    findOne: async (q: Row, o?: { projection?: Record<string, 0> }) => {
      const row = (data[name] ?? []).find((r) => matches(r, q));
      return row ? project(row, o?.projection) : null;
    },
    find: (q: Row) => {
      const rows = (data[name] ?? []).filter((r) => matches(r, q));
      return { sort: (s: Record<string, 1 | -1>) => {
        const [[k, dir]] = Object.entries(s);
        return { toArray: async () => [...rows].sort((a, b) => ((a[k] as number) - (b[k] as number)) * dir) };
      } };
    },
  }),
} as unknown as Db;

const app = Fastify({ logger: false });
await registerApi(app, fakeDb);

test('GET /cities lists cities in card order with the live version', async () => {
  const res = await app.inject({ url: '/cities' });
  assert.equal(res.statusCode, 200);
  const cities = res.json();
  assert.deepEqual(cities.map((c: Row) => c.id), ['delhi', 'mumbai']);
  assert.equal(cities[0].version, 2);
  assert.equal(cities[1].version, null);
});

test('GET /cities/delhi/network returns the live snapshot, not an older one', async () => {
  const res = await app.inject({ url: '/cities/delhi/network' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.version, 2);
  assert.equal(body.data.stations.length, 300);
  assert.equal(body.checksum, undefined, 'internal fields are not sent');
  assert.equal(res.headers.etag, '"delhi-v2"');
});

test('network answers 304 with no body when the app already has the live version', async () => {
  for (const req of [{ url: '/cities/delhi/network?v=2' }, { url: '/cities/delhi/network', headers: { 'if-none-match': '"delhi-v2"' } }]) {
    const res = await app.inject(req);
    assert.equal(res.statusCode, 304);
    assert.equal(res.body, '');
  }
  const stale = await app.inject({ url: '/cities/delhi/network?v=1' });
  assert.equal(stale.statusCode, 200, 'an older version gets the new data');
});

test('network is compressed when the app accepts gzip', async () => {
  const res = await app.inject({ url: '/cities/delhi/network', headers: { 'accept-encoding': 'gzip' } });
  assert.equal(res.headers['content-encoding'], 'gzip');
  assert.equal(JSON.parse(gunzipSync(res.rawPayload).toString()).version, 2);
});

test('unknown, not-yet-live and malformed cities are rejected', async () => {
  assert.equal((await app.inject({ url: '/cities/atlantis/network' })).statusCode, 404);
  assert.equal((await app.inject({ url: '/cities/mumbai/network' })).statusCode, 404);
  assert.equal((await app.inject({ url: '/cities/DELHI;drop/network' })).statusCode, 400);
  assert.equal((await app.inject({ url: '/cities/delhi/network?v=abc' })).statusCode, 400);
});

test('GET /settings hides the database id', async () => {
  const res = await app.inject({ url: '/settings' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { minAppVersion: '1.0.0', maintenance: false });
});


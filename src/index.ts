// Server entry (Vercel detects this file: it must import fastify and call listen).
import Fastify from 'fastify';
import { MongoClient } from 'mongodb';

import { registerApi } from './api.ts';

const { MONGODB_URI, MONGODB_DB = 'metro', PORT = '3000' } = process.env;
if (!MONGODB_URI) throw new Error('MONGODB_URI is not set — copy .env.example to .env and fill it in');

// No connect() before listening: the driver connects on the first query, so the server starts at once
// (important for serverless cold starts). If Atlas is unreachable, queries fail after 5 s with a clear
// "server selection" error instead of hanging until the platform kills the request.
const mongo = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 5000 });

const app = Fastify({ logger: true });
await registerApi(app, mongo.db(MONGODB_DB));
app.addHook('onClose', () => mongo.close());
// Not awaited on purpose: Vercel replaces listen() to capture the server and never reports "listening",
// so awaiting it would hang module loading and every request would fail.
app.listen({ port: Number(PORT), host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});

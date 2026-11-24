import { MongoClient } from 'mongodb';

import { buildApp } from './app.ts';

const { MONGODB_URI, MONGODB_DB = 'metro', PORT = '3000' } = process.env;
if (!MONGODB_URI) throw new Error('MONGODB_URI is not set — copy .env.example to .env and fill it in');

const mongo = new MongoClient(MONGODB_URI);
await mongo.connect();

const app = await buildApp(mongo.db(MONGODB_DB));
app.addHook('onClose', () => mongo.close());
await app.listen({ port: Number(PORT), host: '0.0.0.0' });

# Stellar Server

Read-only API that serves the metro network to the Stellar app (the app is a separate, private repository). Fastify + MongoDB Atlas, deployed on Vercel.

| Endpoint | Returns |
|---|---|
| `GET /cities` | Home-screen city cards (live / coming soon) with each city's live data version |
| `GET /cities/:id/network?v=N` | The city's whole network (one snapshot, ~15 KB gzipped). `304` if the app already has version N |
| `GET /settings` | App-wide settings and credits |
| `GET /health` | `{ ok: true }` when the database is reachable |

Responses are cached by Vercel's CDN for 5 minutes, so repeat requests never reach the function or the database. No rate limiting in the code yet (optional Firewall rule below).

## Scripts

```bash
npm run dev                         # local server on :3000 (needs .env)
npm test                            # API tests (no database needed)
npm run typecheck                   # TypeScript check (Vercel compiles with the same tsconfig)
npm run coords:delhi                # match stations to positions (Server/data/osm-metro-*.json)
npm run build:delhi                 # build seed/delhi/*.json + REPORT.md from network.source.json
npm run import:delhi                # load into MongoDB, create indexes, validate
npm run publish -- delhi            # freeze a new snapshot version; the app picks it up
npm run publish -- delhi --rollback 1
```

Data change → `build` → `import` → `publish`. Nothing reaches the app until `publish`.

## Deploy on Vercel (Hobby)

1. **Push** this repository (the server only — the app lives in its own private repository) to GitHub.
2. On **vercel.com**, sign in with GitHub → **Add New… → Project** → import this repository.
3. Leave **Root Directory** as is. Framework is detected as **Fastify** (entry `src/index.ts`) — no build command needed.
4. **Environment Variables**: `MONGODB_URI` = your Atlas connection string, `MONGODB_DB` = `Stellar`.
5. **Deploy.** Then open `https://<your-project>.vercel.app/health` — expect `{"ok":true}`.
6. **MongoDB Atlas → Security → Network Access → Add IP Address → `0.0.0.0/0`.** Vercel has no fixed IPs on Hobby; the database password still protects it.

### Optional: Firewall rate-limit rule (dashboard only, no code)
Vercel dashboard → project → **Firewall → Configure → + New Rule**:
- Name: `API rate limit`
- If: **Request Path** · **Starts with** · `/`
- Then: **Rate Limit** · **Fixed Window** · Time Window **60s** · Request Limit **120** · Key **IP**
- Action: **Too Many Requests (429)** → Save → **Review Changes → Publish**

Tip: start the action as **Log** for a day to see normal traffic, then switch to 429.

> Vercel Hobby is for personal, non-commercial use. Move to Pro before Stellar is published commercially.

## Data licence note
`seed/delhi/coords.json` (station positions) is derived from OpenStreetMap. If this repository is public, that data is shared under the [ODbL](https://opendatacommons.org/licenses/odbl/): keep the "© OpenStreetMap contributors" credit. The raw downloads in `data/` are never committed.

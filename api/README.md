# Document API

The optional server behind signed-in mode. It stores documents in one SQLite file
(`node:sqlite`, Node 24+), checks Clerk sign-ins, and serves the public read-only pages.
Without it, the app stays local-only (IndexedDB), as before.

## Run locally

`.env` at the repository root:

```
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_…
CLERK_SECRET_KEY=sk_test_…
VITE_OPENFLOWKIT_API_URL=/api
```

```
npm run api:dev   # http://127.0.0.1:8787, database in .data/openflowkit.db
npm run dev       # Vite proxies /api/ to it
```

## Environment

| Variable | Default | |
| --- | --- | --- |
| `CLERK_SECRET_KEY` | — (required) | Fetches the keys that verify session tokens. Server-side only. |
| `CLERK_AUTHORIZED_PARTIES` | any | Comma-separated app origins a token's `azp` must match. Set it in production. |
| `OPENFLOWKIT_DB_PATH` | `/data/openflowkit.db` | The SQLite file; its folder is created. |
| `OPENFLOWKIT_APP_URL` | request origin | Base of the public links it returns. |
| `OPENFLOWKIT_TRUST_PROXY` | off | `1` behind nginx: use `X-Forwarded-*` / `X-Real-IP`. |
| `OPENFLOWKIT_PUBLIC_RATE_LIMIT` | `60` | Public page reads per minute per address. |
| `PORT`, `HOST` | `8787`, `127.0.0.1` | |

## Deploy

`docker-compose.yml` runs the app (nginx) and this API, with the database on the host
at `/srv/openflowkit-data`. The web image takes `VITE_OPENFLOWKIT_API_URL` and
`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` as build args; at runtime `OPENFLOWKIT_API_UPSTREAM`
turns on the `/api/` proxy and `OPENFLOWKIT_CLERK_ORIGIN` (your Clerk Frontend API) is
added to the CSP. Back up the data folder; WAL mode keeps a `-wal` file beside the
database while it runs.

Schema changes are numbered migrations in `database.ts`, applied at start-up.

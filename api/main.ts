import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname } from 'node:path';
import { clerkJwks, createJwtVerifier } from './auth';
import { openDatabase } from './database';
import { createDocumentStore } from './documentStore';
import { createRateLimiter } from './rateLimit';
import { createApiHandler } from './server';
import { mintPublicSlug } from './slug';

const env = process.env;
const secretKey = env.CLERK_SECRET_KEY;
if (!secretKey) {
  console.error('openflowkit-api: CLERK_SECRET_KEY is required (it fetches the keys that verify sign-ins).');
  process.exit(1);
}
const dbPath = env.OPENFLOWKIT_DB_PATH ?? '/data/openflowkit.db';
mkdirSync(dirname(dbPath), { recursive: true });
const db = openDatabase(dbPath);
const list = (value: string | undefined) => (value ?? '').split(',').map((item) => item.trim()).filter(Boolean);

const log = (event: string, fields: Record<string, unknown>) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));

const handler = createApiHandler({
  store: createDocumentStore(db),
  verify: createJwtVerifier({ jwks: clerkJwks(secretKey), authorizedParties: list(env.CLERK_AUTHORIZED_PARTIES) }),
  mintSlug: mintPublicSlug,
  allowPublicRead: createRateLimiter(Number(env.OPENFLOWKIT_PUBLIC_RATE_LIMIT ?? 60), 60_000),
  ...(env.OPENFLOWKIT_APP_URL ? { appUrl: env.OPENFLOWKIT_APP_URL } : {}),
  trustProxy: env.OPENFLOWKIT_TRUST_PROXY === '1',
  log,
});

const port = Number(env.PORT ?? 8787);
const host = env.HOST ?? '127.0.0.1';
const server = createServer((request, response) => { void handler(request, response); });
server.listen(port, host, () => log('listening', { host, port, db: dbPath }));

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}

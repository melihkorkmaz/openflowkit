import { createHttpV2Repository, createPublishingClient, type HttpApiOptions } from './httpV2Repository';
import { createV2Repository, type V2DocumentRepository } from './v2Repository';

/**
 * Where documents live, fixed at build time. Both `VITE_OPENFLOWKIT_API_URL` and the Clerk publishable key set →
 * the document server, behind sign-in; otherwise this browser's IndexedDB (the default build, as before).
 */
export const serverStorage: { readonly apiUrl: string; readonly clerkPublishableKey: string } | null = (() => {
  const env = import.meta.env as Record<string, string | undefined>;
  const apiUrl = env.VITE_OPENFLOWKIT_API_URL?.trim();
  const clerkPublishableKey = env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.trim();
  // Unit tests run against the browser store whatever a developer's .env holds.
  if (env.MODE === 'test' || !apiUrl || !clerkPublishableKey) return null;
  return { apiUrl: apiUrl.replace(/\/+$/, ''), clerkPublishableKey };
})();

interface ServerSession {
  readonly getToken: () => Promise<string | null>;
  readonly signOut: () => Promise<void>;
}

let session: ServerSession | null = null;

/** The sign-in gate hands over Clerk's session once someone is signed in; screens never import Clerk themselves. */
export function setServerSession(next: ServerSession | null): void {
  session = next;
}

export async function signOutOfServer(): Promise<void> {
  await session?.signOut();
}

function apiOptions(apiUrl: string): HttpApiOptions {
  return { baseUrl: apiUrl, getToken: async () => (session ? session.getToken() : null) };
}

/** The repository every screen uses: the server's when configured, else IndexedDB. */
export function openV2Repository(): V2DocumentRepository {
  if (serverStorage) return createHttpV2Repository(apiOptions(serverStorage.apiUrl));
  return createV2Repository(typeof window === 'undefined' ? null : window.indexedDB);
}

/** Public read-only links exist only with the document server. */
export function openPublishingClient(): ReturnType<typeof createPublishingClient> | null {
  return serverStorage ? createPublishingClient(apiOptions(serverStorage.apiUrl)) : null;
}

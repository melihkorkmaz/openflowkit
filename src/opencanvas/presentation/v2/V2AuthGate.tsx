import { useEffect, type ReactNode } from 'react';
import { ClerkProvider, SignIn, useAuth, useClerk } from '@clerk/clerk-react';
import { serverStorage, setServerSession } from '../../../services/storage/v2/serverStorage';
import { BrandLoader } from './BrandLoader';
import { V2StateShell } from './V2StateShell';

/** Signed in before any owner screen mounts: their first request already carries the session token. */
function Gate({ children }: { readonly children: ReactNode }): React.JSX.Element {
  const { isLoaded, isSignedIn, getToken } = useAuth();
  const { signOut } = useClerk();
  // Set while rendering, not in an effect: children's effects run first, and their first request needs the token.
  setServerSession(isSignedIn ? { getToken: () => getToken(), signOut: () => signOut() } : null);
  useEffect(() => () => setServerSession(null), []);

  if (!isLoaded) return <BrandLoader screen label="Checking your sign-in" />;
  if (!isSignedIn) {
    return (
      <V2StateShell testId="v2-sign-in">
        {/* Virtual routing: the app's hash routes stay its own. */}
        <SignIn routing="virtual" />
      </V2StateShell>
    );
  }
  return <>{children}</>;
}

/** Owner screens with the document server: Clerk sign-in first. Loaded only in that build, so the default app never fetches Clerk. */
export function V2AuthGate({ children }: { readonly children: ReactNode }): React.JSX.Element {
  return (
    <ClerkProvider publishableKey={serverStorage!.clerkPublishableKey} afterSignOutUrl={window.location.pathname}>
      <Gate>{children}</Gate>
    </ClerkProvider>
  );
}

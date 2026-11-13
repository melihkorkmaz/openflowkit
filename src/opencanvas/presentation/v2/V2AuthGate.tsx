import { useEffect, type ReactNode } from 'react';
import { ClerkProvider, useAuth, useClerk } from '@clerk/react';
import { Button } from '../design-system';
import { serverStorage, setServerSession } from '../../../services/storage/v2/serverStorage';
import { BrandLoader } from './BrandLoader';
import { V2StateShell } from './V2StateShell';

/** Signed in before any owner screen mounts: their first request already carries the session token. */
function Gate({ children }: { readonly children: ReactNode }): React.JSX.Element {
  const { isLoaded, isSignedIn, getToken } = useAuth();
  const clerk = useClerk();
  const { signOut } = clerk;
  // Set while rendering, not in an effect: children's effects run first, and their first request needs the token.
  setServerSession(isSignedIn ? { getToken: () => getToken(), signOut: () => signOut() } : null);
  useEffect(() => () => setServerSession(null), []);
  // Clerk 6 (Core 3) keeps virtual routing for its modals only: the modal leaves the app's hash routes alone, as
  // <SignIn routing="virtual" /> did. Opened once loaded; the button brings it back after a dismiss.
  const showSignIn = isLoaded && !isSignedIn;
  useEffect(() => { if (showSignIn) clerk.openSignIn(); }, [showSignIn, clerk]);

  if (!isLoaded) return <BrandLoader screen label="Checking your sign-in" />;
  if (!isSignedIn) {
    return (
      <V2StateShell testId="v2-sign-in">
        <Button variant="primary" onClick={() => clerk.openSignIn()}>Sign in</Button>
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

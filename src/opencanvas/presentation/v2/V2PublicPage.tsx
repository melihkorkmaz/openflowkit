import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ErrorState } from '../design-system';
import { fetchPublishedDocument, type PublishedDocument } from '../../../services/storage/v2/httpV2Repository';
import { serverStorage } from '../../../services/storage/v2/serverStorage';
import { BrandLoader } from './BrandLoader';
import { V2StateHero } from './V2StateHero';
import { V2StateShell } from './V2StateShell';
import './v2EditorPage.css';

const Editor = lazy(async () => ({ default: (await import('./V2EditorPage')).V2EditorPage }));

const NOT_SET_UP: PublishedDocument = { status: 'error', retry: false, message: 'Public links are not set up on this site.' };

/**
 * `#/p/:slug`: a published snapshot in the read-only viewer a share link opens — pages, Map mode with its
 * click-to-open layers, no write path. No "Edit a copy": the reader may not be signed in.
 */
export function V2PublicPage(): React.JSX.Element {
  const { slug = '' } = useParams();
  const [attempt, setAttempt] = useState(0);
  const request = `${slug}/${attempt}`;
  const [answer, setAnswer] = useState<{ request: string; result: PublishedDocument } | null>(null);
  useEffect(() => {
    let live = true;
    const load = serverStorage ? fetchPublishedDocument(serverStorage.apiUrl, slug) : Promise.resolve(NOT_SET_UP);
    void load.then((result) => { if (live) setAnswer({ request, result }); });
    return () => { live = false; };
  }, [slug, request]);
  const state = answer?.request === request ? answer.result : null;
  const document = state?.status === 'ok' ? state.document : null;
  const shared = useMemo(() => (document ? { document } : undefined), [document]);

  if (shared) return <Suspense fallback={<BrandLoader screen label="Opening diagram" />}><Editor shared={shared} /></Suspense>;
  return (
    <V2StateShell testId="v2-public-state">
      {state === null ? (
        <div className="ofk-empty"><BrandLoader /><p className="ofk-caption" role="status">Opening diagram…</p></div>
      ) : state.status === 'missing' ? (
        <ErrorState hero={<V2StateHero kind="lost-link" />} title="This link doesn’t open a diagram"
          description="It may have been unpublished, or the link is incomplete." />
      ) : state.status === 'error' ? (
        <ErrorState hero={<V2StateHero kind={state.retry ? 'torn-page' : 'lost-link'} />} title="Couldn’t open this diagram"
          description={state.message} {...(state.retry ? { onRetry: () => setAttempt((count) => count + 1) } : {})} />
      ) : null}
    </V2StateShell>
  );
}

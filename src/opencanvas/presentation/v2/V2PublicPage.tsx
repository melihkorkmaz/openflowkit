import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ErrorState, SystemRoot } from '../design-system';
import { fetchPublishedDocument, type PublishedDocument } from '../../../services/storage/v2/httpV2Repository';
import { serverStorage } from '../../../services/storage/v2/serverStorage';
import { exportCanonicalSvg } from '../../infrastructure/export/canonicalSvg';
import type { SceneDocumentV1 } from '../../domain/document/types';
import { BrandLoader } from './BrandLoader';
import { loadIconArt } from './v2IconArt';
import { V2StateHero } from './V2StateHero';
import { V2StateShell } from './V2StateShell';
import { useV2Appearance } from './useV2Appearance';
import { useV2Preferences } from './useV2Preferences';
import './v2PublicPage.css';

const NOT_SET_UP: PublishedDocument = { status: 'error', retry: false, message: 'Public links are not set up on this site.' };

/**
 * `#/p/:slug`: a published snapshot, read-only. Pages are drawn as images (the SVG export), so there is no editor,
 * no menu and no write path here at all, and nothing in the document can run as script.
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

  if (state?.status === 'ok') return <PublishedView document={state.document} publishedAt={state.publishedAt} />;
  return (
    <V2StateShell testId="v2-public-state">
      {state === null ? (
        <div className="ofk-empty"><BrandLoader /><p className="ofk-caption" role="status">Opening diagram…</p></div>
      ) : state.status === 'missing' ? (
        <ErrorState hero={<V2StateHero kind="lost-link" />} title="This link doesn’t open a diagram"
          description="It may have been unpublished, or the link is incomplete." />
      ) : (
        <ErrorState hero={<V2StateHero kind={state.retry ? 'torn-page' : 'lost-link'} />} title="Couldn’t open this diagram"
          description={state.message} {...(state.retry ? { onRetry: () => setAttempt((count) => count + 1) } : {})} />
      )}
    </V2StateShell>
  );
}

function PublishedView({ document, publishedAt }: { readonly document: SceneDocumentV1; readonly publishedAt: string }): React.JSX.Element {
  const { preferences } = useV2Preferences();
  const appearance = useV2Appearance(preferences.theme);
  const [pageId, setPageId] = useState(document.pages[0]?.id);
  const [iconArt, setIconArt] = useState<Record<string, string> | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void loadIconArt(document).then((art) => { if (live) setIconArt(art); }, () => undefined);
    return () => { live = false; };
  }, [document]);
  const page = document.pages.find((candidate) => candidate.id === pageId) ?? document.pages[0];
  const image = useMemo(() => {
    if (!page || page.nodes.length + page.connectors.length === 0) return null;
    const svg = exportCanonicalSvg(document, { pageId: page.id, theme: appearance === 'dark' ? 'dark' : 'light', ...(iconArt ? { iconArt } : {}) });
    return svg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` : null;
  }, [document, page, appearance, iconArt]);
  const name = typeof document.name === 'string' && document.name ? document.name : 'Untitled diagram';

  return (
    <SystemRoot appearance={appearance} density={preferences.density}>
      <main className="ofk-public" data-testid="v2-public-view">
        <header className="ofk-public-head">
          <h1>{name}</h1>
          <p className="ofk-caption">Read-only · published {new Date(publishedAt).toLocaleDateString()}</p>
        </header>
        {document.pages.length > 1 ? (
          <nav className="ofk-public-pages" aria-label="Pages">
            {document.pages.map((candidate) => (
              <button key={candidate.id} type="button" aria-current={candidate.id === page?.id ? 'page' : undefined}
                onClick={() => setPageId(candidate.id)}>{candidate.name || 'Untitled page'}</button>
            ))}
          </nav>
        ) : null}
        <figure className="ofk-public-canvas">
          {image ? <img src={image} alt={`${name}${page?.name ? ` — ${page.name}` : ''}`} /> : <p className="ofk-caption">This page is empty.</p>}
        </figure>
        <footer className="ofk-public-foot ofk-caption">
          Made with <a href="https://openflowkit.com" target="_blank" rel="noreferrer">OpenFlowKit</a>
        </footer>
      </main>
    </SystemRoot>
  );
}

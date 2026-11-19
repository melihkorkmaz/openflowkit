import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { reloadOnStaleChunk } from './opencanvas/presentation/v2/V2ErrorBoundary';
import { startFeedbackSession } from './services/feedback/feedbackSession';
import { withoutV1Params } from './services/storage/v2/v1Import';
import { entryOf, isViewerRoute, startUsage } from './services/usage/usage';
import './index.css';

// v1 shared `/view?flow=…` without a hash too; move it under the hash router (v1 did the same).
const { pathname, search, hash } = window.location;
if (!hash && pathname.endsWith('/view') && new URLSearchParams(search).has('flow')) {
  window.history.replaceState(null, '', `${pathname.slice(0, -'view'.length)}#/view${search}`);
}

const cleanSearch = withoutV1Params(window.location.search);
if (cleanSearch !== null) window.history.replaceState(null, '', `${window.location.pathname}${cleanSearch}${window.location.hash}`);

// A deploy replaced the hashed chunks under this tab; one reload fetches the new build.
window.addEventListener('vite:preloadError', () => { reloadOnStaleChunk(); });

const viewer = isViewerRoute(window.location.pathname) || isViewerRoute(window.location.hash);
startUsage({ entry: viewer ? 'shared' : entryOf(window.location.hash) });
startFeedbackSession(Date.now(), viewer);

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Could not find root element to mount to');

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

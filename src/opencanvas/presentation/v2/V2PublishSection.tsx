import { useEffect, useMemo, useState } from 'react';
import { IconCopy, IconRefresh, IconWorld, IconWorldOff } from '@tabler/icons-react';
import { Button, Icon, type ToastItem } from '../design-system';
import type { PublishedLink } from '../../../services/storage/v2/httpV2Repository';
import { openPublishingClient } from '../../../services/storage/v2/serverStorage';

interface V2PublishSectionProps {
  readonly documentId: string;
  readonly onToast: (title: string, tone: 'info' | 'success' | 'danger', extra?: Pick<ToastItem, 'description' | 'persistent'>) => void;
}

const message = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback);

/** Share's public page (document server only): a read-only snapshot of the last save behind an unguessable link. */
export function V2PublishSection({ documentId, onToast }: V2PublishSectionProps): React.JSX.Element | null {
  const client = useMemo(openPublishingClient, []);
  // undefined while the status loads.
  const [link, setLink] = useState<PublishedLink | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!client) return undefined;
    let live = true;
    client.status(documentId).then((status) => { if (live) setLink(status); }, () => { if (live) setLink(null); });
    return () => { live = false; };
  }, [client, documentId]);
  if (!client) return null;

  async function copy(url: string, title: string): Promise<void> {
    const copied = await navigator.clipboard.writeText(url).then(() => true, () => false);
    onToast(copied ? `${title} — link copied` : title, 'success', copied
      ? { description: 'Anyone with the link can view it. They can’t edit, and later edits stay private until you update it.' }
      : { description: url, persistent: true });
  }

  async function publish(): Promise<void> {
    if (!client) return;
    setBusy(true);
    try {
      const published = await client.publish(documentId);
      const updated = Boolean(link);
      setLink(published);
      await copy(published.publicUrl, updated ? 'Public page updated' : 'Published');
    } catch (error) {
      onToast(message(error, 'Couldn’t publish'), 'danger');
    } finally {
      setBusy(false);
    }
  }

  async function unpublish(): Promise<void> {
    if (!client) return;
    setBusy(true);
    try {
      await client.unpublish(documentId);
      setLink(null);
      onToast('Unpublished', 'success', { description: 'The public link no longer opens.' });
    } catch (error) {
      onToast(message(error, 'Couldn’t unpublish'), 'danger');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="ofk-v2-publish" aria-label="Public page">
      <p className="ofk-v2-share-title"><Icon icon={IconWorld} /> Public page</p>
      <p className="ofk-v2-share-effect" aria-live="polite">
        {link === undefined ? 'Checking…'
          : link ? `Live: the version saved ${new Date(link.publishedAt).toLocaleString()}. Read-only for anyone with the link.`
            : 'A read-only page of the last save, for anyone with the link. No sign-in needed to view.'}
      </p>
      {link ? (
        <div className="ofk-v2-publish-actions">
          <Button variant="secondary" disabled={busy} onClick={() => { void copy(link.publicUrl, 'Public page'); }}>
            <Icon icon={IconCopy} /> Copy link
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => { void publish(); }}>
            <Icon icon={IconRefresh} /> Update
          </Button>
          <Button variant="quiet" disabled={busy} onClick={() => { void unpublish(); }}>
            <Icon icon={IconWorldOff} /> Unpublish
          </Button>
        </div>
      ) : (
        <Button variant="secondary" className="ofk-v2-share-copy" disabled={busy || link === undefined} onClick={() => { void publish(); }}>
          <Icon icon={IconWorld} /> {busy ? 'Working…' : 'Publish'}
        </Button>
      )}
    </section>
  );
}

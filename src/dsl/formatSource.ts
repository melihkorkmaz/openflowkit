import { compileWorkspace } from './compile';
import { format } from './serialize';

export type FormatSourceResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: string };

/**
 * The code panel's Format source: canonical text, or a reason and the text untouched. A warning or error means some
 * line would be skipped or reread, so formatting would drop what the author wrote; it refuses instead.
 */
export async function formatSource(text: string): Promise<FormatSourceResult> {
  if (!text.trim()) return { ok: false, reason: 'Nothing to format.' };
  try {
    const workspace = await compileWorkspace(text);
    const blocking = workspace.views[0]?.result.diagnostics.find((item) => item.severity !== 'info');
    if (blocking) return { ok: false, reason: `Fix line ${blocking.line} before formatting: ${blocking.message}` };
    const formatted = await format(text);
    if ((await format(formatted)) !== formatted) return { ok: false, reason: 'This source does not format stably yet; left as written.' };
    return { ok: true, text: formatted };
  } catch (error) {
    return { ok: false, reason: `Format failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

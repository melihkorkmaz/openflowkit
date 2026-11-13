import { EditorView } from '@codemirror/view';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { V2CodePanel } from './V2CodePanel';

type PanelProps = Parameters<typeof V2CodePanel>[0];
const panel = (overrides: Partial<PanelProps> & { code: string }) => render(
  <V2CodePanel diagnostics={[]} generating={false} canvasEdited={false} palette="pastel"
    onPaletteChange={vi.fn()} onCodeChange={vi.fn()} onGenerate={vi.fn()} onClose={vi.fn()} {...overrides} />,
);
const source = () => screen.getByRole('textbox', { name: 'Diagram source' });
const view = () => EditorView.findFromDOM(source())!;
const selected = () => { const { from, to } = view().state.selection.main; return view().state.sliceDoc(from, to); };
const caret = (position: number) => act(() => view().dispatch({ selection: { anchor: position } }));

describe('V2CodePanel', () => {
  it('renders a line-number gutter, one number per line', () => {
    const { container } = panel({ code: 'flowchart\nA -> B\nB -> C' });
    const numbers = [...container.querySelectorAll('.cm-lineNumbers .cm-gutterElement')].map((cell) => cell.textContent).filter(Boolean);
    expect(numbers).toEqual(expect.arrayContaining(['1', '2', '3']));
  });

  it('colours tokens from the DSL tokenizer', () => {
    const { container } = panel({ code: 'flowchart\nA -> "Ship it" // done' });
    expect(container.querySelector('[data-token="arrow"]')?.textContent).toBe('->');
    expect(container.querySelector('[data-token="string"]')?.textContent).toBe('"Ship it"');
    expect(container.querySelector('[data-token="comment"]')?.textContent).toBe('// done');
  });

  it('jumps to a diagnostic on its own line when the source has CRLF', () => {
    panel({ code: 'flowchart\r\nA -> B\r\nBroken [oops', diagnostics: [{ code: 'W101', severity: 'warning', line: 3, col: 8, endCol: 13, message: 'bad', source: 'parse' }] });
    fireEvent.click(screen.getByText('Line 3'));
    expect(selected()).toBe('[oops');
    expect(source()).toHaveFocus();
  });

  it('marks the diagnostic lines in the editor', () => {
    const { container } = panel({ code: 'flowchart\nA -> B\nBroken [oops', diagnostics: [{ code: 'E101', severity: 'error', line: 3, col: 8, endCol: 13, message: 'bad', source: 'parse' }] });
    expect(container.querySelector('.cm-line[data-tone="error"]')?.textContent).toBe('Broken [oops');
  });

  it('leaves Enter to the input method while it is composing: no suggestion accepted, nothing generated', () => {
    const onCodeChange = vi.fn();
    const onGenerate = vi.fn();
    panel({ code: 'flowchart\nA', onCodeChange, onGenerate });
    fireEvent.keyDown(source(), { key: ' ', ctrlKey: true });
    expect(screen.getByRole('listbox')).toBeTruthy();
    fireEvent.keyDown(source(), { key: 'Enter', isComposing: true });
    fireEvent.keyDown(source(), { key: 'Enter', metaKey: true, isComposing: true });
    expect(onCodeChange).not.toHaveBeenCalled();
    expect(onGenerate).not.toHaveBeenCalled();
    expect(screen.getByRole('listbox')).toBeTruthy();
  });

  it('is no keyboard trap: Esc leaves the editor for Close; Tab indents, Shift+Tab outdents (WCAG 2.1.2)', () => {
    const onClose = vi.fn();
    const onCodeChange = vi.fn();
    panel({ code: 'flowchart', onClose, onCodeChange });
    expect(source()).toHaveAccessibleDescription(/Esc leaves the editor/);
    caret(0);
    fireEvent.keyDown(source(), { key: 'Tab' });
    expect(onCodeChange).toHaveBeenLastCalledWith('  flowchart');
    fireEvent.keyDown(source(), { key: 'Tab', shiftKey: true });
    expect(onCodeChange).toHaveBeenLastCalledWith('flowchart');
    fireEvent.keyDown(source(), { key: 'Escape' });
    expect(screen.getByRole('button', { name: 'Close panel' })).toHaveFocus();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Close panel' }), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('keeps IME Enter out of icon completion, then accepts an icon without generating', async () => {
    const onCodeChange = vi.fn();
    const onGenerate = vi.fn();
    panel({ code: 'architecture\nperson Checker [icon: user check]', onCodeChange, onGenerate });
    caret(view().state.doc.length - 1);
    fireEvent.keyDown(source(), { key: ' ', ctrlKey: true });
    await screen.findByText('tabler/user-check');
    fireEvent.keyDown(source(), { key: 'Enter', isComposing: true });
    expect(onCodeChange).not.toHaveBeenCalled();
    fireEvent.keyDown(source(), { key: 'Enter', metaKey: true });
    expect(onCodeChange).toHaveBeenLastCalledWith('architecture\nperson Checker [icon: tabler/user-check]');
    expect(onGenerate).not.toHaveBeenCalled();
  });

  it('opens ready to paste over: the source is focused and selected; a template opening leaves focus alone (U1-02)', () => {
    const { unmount } = panel({ code: 'flowchart\nA -> B', selectAll: true });
    expect(source()).toHaveFocus();
    expect(selected()).toBe('flowchart\nA -> B');
    unmount();
    panel({ code: 'flowchart', autoFocus: false });
    expect(source()).not.toHaveFocus();
  });

  // Review 2026-10-11: ⌥C on an existing diagram selected its whole source, so the first keystroke wiped it.
  it('an existing diagram source opens with the caret at the end, nothing selected', () => {
    panel({ code: 'flowchart\nA -> B' });
    expect(source()).toHaveFocus();
    expect(view().state.selection.main.empty).toBe(true);
    expect(view().state.selection.main.head).toBe('flowchart\nA -> B'.length);
  });

  it('⌘↵ generates from anywhere in the panel, once', () => {
    const onGenerate = vi.fn();
    panel({ code: 'flowchart', onGenerate });
    fireEvent.keyDown(source(), { key: 'Enter', metaKey: true });
    expect(onGenerate).toHaveBeenCalledOnce();
    expect(view().state.doc.toString()).toBe('flowchart');
    fireEvent.keyDown(screen.getByRole('button', { name: 'Close panel' }), { key: 'Enter', ctrlKey: true });
    expect(onGenerate).toHaveBeenCalledTimes(2);
  });

  it('⌘↵ that accepts a suggestion does not also generate', () => {
    const onGenerate = vi.fn();
    const onCodeChange = vi.fn();
    panel({ code: 'flowchart\nA', onGenerate, onCodeChange });
    fireEvent.keyDown(source(), { key: ' ', ctrlKey: true });
    fireEvent.keyDown(source(), { key: 'Enter', metaKey: true });
    expect(onGenerate).not.toHaveBeenCalled();
    expect(onCodeChange).toHaveBeenCalledWith('flowchart\nAarchitecture');
  });

  it('a value from outside replaces the text without echoing back as an edit', () => {
    const onCodeChange = vi.fn();
    const { rerender } = panel({ code: 'flowchart\nA', onCodeChange });
    rerender(<V2CodePanel code={'flowchart\nB'} diagnostics={[]} generating={false} canvasEdited={false} palette="pastel"
      onPaletteChange={vi.fn()} onCodeChange={onCodeChange} onGenerate={vi.fn()} onClose={vi.fn()} />);
    expect(view().state.doc.toString()).toBe('flowchart\nB');
    expect(onCodeChange).not.toHaveBeenCalled();
  });

  it('Format source rewrites messy source to canonical text', async () => {
    const onCodeChange = vi.fn();
    panel({ code: 'flowchart\n  A   ->B\n\n\nB->C', onCodeChange });
    fireEvent.click(screen.getByRole('button', { name: /Format/ }));
    await waitFor(() => expect(onCodeChange).toHaveBeenCalledWith('%% ofk 1\nflowchart\n\nA -> B\nB -> C\n'));
  });

  it('⇧⌥F formats from the source', async () => {
    const onCodeChange = vi.fn();
    panel({ code: 'flowchart\nA->B', onCodeChange });
    fireEvent.keyDown(source(), { key: 'Ï', code: 'KeyF', shiftKey: true, altKey: true });
    await waitFor(() => expect(onCodeChange).toHaveBeenCalledWith('%% ofk 1\nflowchart\n\nA -> B\n'));
  });

  it('a failed format keeps the text and says why', async () => {
    const onCodeChange = vi.fn();
    panel({ code: 'flowchart\nA -> B\nBroken [oops', onCodeChange });
    fireEvent.click(screen.getByRole('button', { name: /Format/ }));
    expect(await screen.findByText(/Fix line 3 before formatting/)).toBeInTheDocument();
    expect(onCodeChange).not.toHaveBeenCalled();
    expect(view().state.doc.toString()).toBe('flowchart\nA -> B\nBroken [oops');
  });

  // The workspace drops OpenFlowKit's parse diagnostics for foreign text (U1-07, U2-12); what reaches the panel then
  // is the conversion's own report, and a failed Convert must say why (e2e mermaid-import: reserved family).
  it('foreign syntax keeps the banner and still shows a conversion error', () => {
    const diagnostics = [{ code: 'E003' as const, severity: 'error' as const, line: 1, col: 1, endCol: 1, message: 'journey diagrams are not supported yet', source: 'parse' as const }];
    panel({ code: 'journey\n  title My day', diagnostics, convertFrom: { label: 'Mermaid', convert: vi.fn() } });
    expect(screen.getByText(/Mermaid detected/).textContent).toMatch(/Generate converts it/);
    expect(screen.getByText('journey diagrams are not supported yet')).toBeInTheDocument();
  });
});

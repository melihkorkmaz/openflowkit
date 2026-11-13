import { CompletionContext } from '@codemirror/autocomplete';
import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { completeSourceIcon, iconValueAt } from './sourceIconCompletion';

describe('source icon completion', () => {
  it('searches by readable words and inserts the canonical id', () => {
    const text = 'architecture\nperson KID checker [icon: user check, desc: Verifies students, tags: tbc]';
    const pos = text.indexOf(', desc');
    const result = completeSourceIcon(new CompletionContext(EditorState.create({ doc: text }), pos, false))!;
    expect(result.options[0]?.label).toBe('tabler/user-check');
    expect(text.slice(0, result.from) + result.options[0]!.label + text.slice(result.to!))
      .toBe('architecture\nperson KID checker [icon: tabler/user-check, desc: Verifies students, tags: tbc]');
  });

  it('replaces the whole existing value when completing from its middle', () => {
    const text = 'A [icon: tabler/user-check, tags: tbc]';
    const value = iconValueAt(text, text.indexOf('user') + 2)!;
    expect(text.slice(value.from, value.to)).toBe('tabler/user-check');
  });

  it('offers the catalog for an empty value and scopes a provider search', () => {
    for (const query of ['', 'aws/lambda']) {
      const text = `A [blue, icon: ${query}]`;
      const result = completeSourceIcon(new CompletionContext(EditorState.create({ doc: text }), text.length - 1, true))!;
      expect(result.options.length).toBeGreaterThan(0);
      if (query) expect(result.options.every((option) => option.label.startsWith('aws/'))).toBe(true);
    }
  });

  it.each([
    'A icon: user', 'A [desc: icon: user', 'A [icon: user, desc: test',
    'A [icon: user] // icon: user', '// A [icon: user', '"A [icon: user"',
    'A [desc: "icon: user', 'A [icon: "user',
  ])('does not suggest icons outside an unquoted icon attribute: %s', (text) => {
    expect(iconValueAt(text, text.length)).toBeNull();
  });
});

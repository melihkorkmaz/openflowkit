import { describe, expect, it } from 'vitest';
import { highlightLine } from './highlight';

const roles = (line: string) => highlightLine(line).map(({ kind, from, to }) => [line.slice(from, to), kind]);

describe('highlightLine', () => {
  it('marks a family head and its direction', () => {
    expect(roles('flowchart right')).toEqual([['flowchart', 'keyword'], ['right', 'value']]);
  });

  it('splits an edge into names, arrow, label and attribute keys and values', () => {
    expect(roles('API -> DB : reads [dashed, color: #ff0000, width: 120]')).toEqual([
      ['API', 'name'], ['->', 'arrow'], ['DB', 'name'], [':', 'punctuation'], ['reads', 'label'],
      ['[', 'bracket'], ['dashed', 'value'], [',', 'punctuation'], ['color', 'key'], [':', 'punctuation'],
      ['#ff0000', 'color'], [',', 'punctuation'], ['width', 'key'], [':', 'punctuation'], ['120', 'number'], [']', 'bracket'],
    ]);
  });

  it('treats a keyword as a keyword only at statement start', () => {
    expect(roles('group db = Data {')).toEqual([['group', 'keyword'], ['db', 'id'], ['=', 'punctuation'], ['Data', 'name'], ['{', 'brace']]);
    expect(roles('A -> group')).toEqual([['A', 'name'], ['->', 'arrow'], ['group', 'name']]);
    expect(roles('title: Upload service')).toEqual([['title', 'keyword'], [':', 'punctuation'], ['Upload', 'label'], ['service', 'label']]);
  });

  it('keeps the pragma, strings and comments whole', () => {
    expect(roles('  %% ofk 1')).toEqual([['%% ofk 1', 'meta']]);
    expect(roles('"Cache: L2" // hot')).toEqual([['"Cache: L2"', 'string'], ['// hot', 'comment']]);
  });
});

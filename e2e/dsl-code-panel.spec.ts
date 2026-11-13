import { rect, sourceText, state } from './helpers';
import { expect, test } from './test';

type V2Api = { getState(): { nodes: string[] } };
const count = (page: import('@playwright/test').Page) => page.evaluate(() =>
  (window as unknown as { __V2__?: V2Api }).__V2__?.getState().nodes.length ?? 0);

test('diagram source generates and regenerates as one undo step', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('[data-testid="v2-canvas"]');
  await page.getByRole('toolbar', { name: 'Workspace', exact: true }).getByRole('button', { name: 'Diagram as code' }).click();
  const source = page.getByRole('textbox', { name: 'Diagram source' });
  await expect(source).toBeVisible();
  await source.fill('%% ofk 1\nflowchart\nStart -> Build -> Ship');
  await source.press('ControlOrMeta+Enter');
  await expect.poll(() => count(page)).toBe(4);
  await source.fill('%% ofk 1\nflowchart\nStart -> Test -> Build -> Ship');
  await source.press('ControlOrMeta+Enter');
  await expect.poll(() => count(page)).toBe(5);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => count(page)).toBe(4);
  await expect(page.locator('#v2-code-diagnostics')).toBeHidden();
});

test('code panel reports bad lines and offers attribute completion', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('[data-testid="v2-canvas"]');
  await page.getByRole('toolbar', { name: 'Workspace', exact: true }).getByRole('button', { name: 'Diagram as code' }).click();
  const source = page.getByRole('textbox', { name: 'Diagram source' });
  await source.fill('flowchart\nCache [');
  await expect(page.getByRole('listbox')).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect.poll(() => sourceText(page)).not.toBe('flowchart\nCache [');
  await source.fill('flowchart\nBroken [oops');
  await expect(page.getByText('W101', { exact: true })).toBeVisible();
});

test('a generated diagram fits the canvas the open panel leaves free @gate', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.waitForSelector('[data-testid="v2-canvas"]');
  await page.getByRole('toolbar', { name: 'Workspace', exact: true }).getByRole('button', { name: 'Diagram as code' }).click();
  const source = page.getByRole('textbox', { name: 'Diagram source' });
  // Short enough to fit readably beside the panel: a longer one lands readable on its start and runs under it (readable-views).
  await source.fill('flowchart right\nA -> B -> C -> D -> E -> F');
  await source.press('ControlOrMeta+Enter');
  await expect.poll(() => count(page)).toBeGreaterThan(5);
  const panelLeft = (await page.getByRole('textbox', { name: 'Diagram source' }).boundingBox())!.x;
  await expect.poll(async () => {
    const [frame] = (await state(page)).selectedNodes;
    const frameRect = frame ? await rect(page, frame) : null;
    return frameRect ? Math.round(frameRect.x + frameRect.width) : Infinity;
  }).toBeLessThanOrEqual(panelLeft);
});

test('a long edge label wraps instead of running over the nodes it joins @gate', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('[data-testid="v2-canvas"]');
  await page.getByRole('toolbar', { name: 'Workspace', exact: true }).getByRole('button', { name: 'Diagram as code' }).click();
  const source = page.getByRole('textbox', { name: 'Diagram source' });
  await source.fill('flowchart right\nA -> B : email the customer a receipt once the order has shipped');
  await source.press('ControlOrMeta+Enter');
  await expect.poll(() => count(page)).toBeGreaterThan(2);
  await expect.poll(async () => page.evaluate(() => (window as unknown as {
    __V2__: { getConnectorDebugSnapshot(): { labels: number; widestLabel: number } };
  }).__V2__.getConnectorDebugSnapshot())).toMatchObject({ labels: 1, widestLabel: expect.any(Number) });
  const widest = await page.evaluate(() => (window as unknown as {
    __V2__: { getConnectorDebugSnapshot(): { widestLabel: number } };
  }).__V2__.getConnectorDebugSnapshot().widestLabel);
  expect(widest).toBeGreaterThan(0);
  expect(widest).toBeLessThanOrEqual(150);
});

test('the code editor numbers and wraps long lines, and ⌘Z undoes a Tab or a completion, not the text @gate', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('[data-testid="v2-canvas"]');
  await page.getByRole('toolbar', { name: 'Workspace', exact: true }).getByRole('button', { name: 'Diagram as code' }).click();
  const source = page.getByRole('textbox', { name: 'Diagram source' });
  await source.fill('');
  await page.keyboard.type('flowchart\nA -> B');
  await page.keyboard.press('Tab');
  await expect.poll(() => sourceText(page)).toBe('flowchart\nA -> B  ');
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => sourceText(page)).toBe('flowchart\nA -> B');
  // `[` closes itself and offers attributes; the pick lands between the brackets.
  await page.keyboard.type(' [');
  await expect(page.getByRole('listbox')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect.poll(() => sourceText(page)).toMatch(/^flowchart\nA -> B \[\w+\]$/);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => sourceText(page)).toBe('flowchart\nA -> B []');

  // A long AI-written line wraps inside the panel, never sideways; every line has its number.
  const long = `flowchart\n${Array.from({ length: 12 }, (_, index) => `Step${index}`).join(' -> ')} -> ${'x'.repeat(120)}\nEmoji 🚀 -> Tab\tEnd`;
  await source.fill(long);
  await expect.poll(() => sourceText(page)).toBe(long);
  const metrics = await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>('.ofk-v2-code-editor .cm-scroller')!;
    return {
      sideways: scroller.scrollWidth > scroller.clientWidth + 1,
      numbers: [...document.querySelectorAll('.ofk-v2-code-editor .cm-lineNumbers .cm-gutterElement')].map((cell) => cell.textContent).filter(Boolean),
    };
  });
  expect(metrics.sideways).toBe(false);
  expect(metrics.numbers).toEqual(expect.arrayContaining(['1', '2', '3']));
});

test('Format source tidies a messy source, which then generates @gate', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('[data-testid="v2-canvas"]');
  await page.getByRole('toolbar', { name: 'Workspace', exact: true }).getByRole('button', { name: 'Diagram as code' }).click();
  const source = page.getByRole('textbox', { name: 'Diagram source' });
  await source.fill('flowchart\n   Start->Build   \n\n\nBuild ->Ship');
  await source.press('Shift+Alt+KeyF');
  await expect.poll(() => sourceText(page)).toBe('%% ofk 1\nflowchart\n\nStart -> Build\nBuild -> Ship\n');
  await source.press('ControlOrMeta+Enter');
  await expect.poll(() => count(page)).toBe(4);
  // A source with a skipped line is left as written, with the reason beside it.
  await source.fill('flowchart\nBroken [oops');
  await page.getByRole('button', { name: /Format/ }).click();
  await expect(page.getByText(/Fix line 2 before formatting/)).toBeVisible();
  await expect.poll(() => sourceText(page)).toBe('flowchart\nBroken [oops');
});

test('the workspace panel resizes from its left edge and keeps the width after a reload @gate', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.waitForSelector('[data-testid="v2-canvas"]');
  const openCode = () => page.getByRole('toolbar', { name: 'Workspace', exact: true }).getByRole('button', { name: 'Diagram as code' }).click();
  await openCode();
  const panel = page.locator('.ofk-v2-code-panel');
  await expect.poll(async () => Math.round((await panel.boundingBox())!.width)).toBe(440);
  const handle = page.getByRole('separator', { name: 'Resize panel' });
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x - 100, box.y + box.height / 2, { steps: 5 });
  await expect.poll(async () => Math.round((await panel.boundingBox())!.width)).toBe(540);
  await page.mouse.up();
  await handle.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(handle).toHaveAttribute('aria-valuenow', '556');
  await page.reload();
  await page.waitForSelector('[data-testid="v2-canvas"]');
  await openCode();
  await expect.poll(async () => Math.round((await panel.boundingBox())!.width)).toBe(556);
});

test('a narrow screen keeps the full-width panel and no resize handle @gate', async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 900 });
  await page.goto('/');
  await page.waitForSelector('[data-testid="v2-canvas"]');
  await page.getByRole('toolbar', { name: 'Workspace', exact: true }).getByRole('button', { name: 'Diagram as code' }).click();
  await expect(page.getByRole('textbox', { name: 'Diagram source' })).toBeVisible();
  await expect(page.locator('.ofk-v2-panel-resize')).toBeHidden();
  expect(Math.round((await page.locator('.ofk-v2-code-panel').boundingBox())!.width)).toBe(600 - 64);
});

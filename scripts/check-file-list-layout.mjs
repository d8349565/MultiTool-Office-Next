import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

// Use an installed Playwright, or set PLAYWRIGHT_MODULE to its module URL.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baseline = process.argv.includes('--baseline');
const output = resolve(root, 'test-results/file-list-layout', baseline ? 'before' : 'after');
mkdirSync(output, { recursive: true });
const names = [
  '2026年度项目交付验收与附件清单'.repeat(10) + '.xlsx',
  'AnnualProjectDeliveryAndAcceptanceRecords'.repeat(5) + '.pdf',
  'Review meeting notes and attachment index '.repeat(5) + '.docx',
  '简短名称.txt',
];
const paths = Array.from({ length: 96 }, (_, index) =>
  '项目文件/' + '归档资料与历史版本/'.repeat(index % 3 ? 1 : 8) +
  String(index).padStart(3, '0') + '_' + names[index % names.length]);
const failures = [], measurements = [], errors = [];
const check = (condition, message) => { if (!condition) failures.push(message); };
const server = await createServer({ root, server: { host: '127.0.0.1', port: 0, strictPort: false }, logLevel: 'error' });
let browser;
try {
  await server.listen();
  const url = `http://127.0.0.1:${server.httpServer.address().port}/?demo=1`;
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage();
  page.on('pageerror', error => errors.push(error.message));
  // Replace only the demo file names; use the real App, styles and virtualizer.
  await page.route('**/src/api.ts', async route => {
    const response = await route.fetch();
    const source = await response.text();
    const declaration = /const filePaths = \[[\s\S]*?\];/;
    assert.match(source, declaration, 'Demo file fixture seam changed');
    await route.fulfill({ response, body: source.replace(declaration, () => `const filePaths = ${JSON.stringify(paths)};`) });
  });
  await page.goto(url);
  await page.locator('.file-row').first().waitFor();
  await page.evaluate(() => document.fonts.ready);
  const settle = async () => {
    // ResizeObserver updates the virtualizer asynchronously after a breakpoint change.
    await page.waitForFunction(() => {
      const rows = [...document.querySelectorAll('.file-row')];
      return rows.length > 0 && rows.every((row, index) => !index || rows[index - 1].getBoundingClientRect().bottom <= row.getBoundingClientRect().top + 1);
    }, null, { timeout: 2000 });
  };
  for (const width of [900, 1240, 1600, 768, 640]) {
    await page.setViewportSize({ width, height: 840 });
    for (const end of [false, true]) {
      await page.locator('.file-list').evaluate((element, end) => { element.scrollTop = end ? element.scrollHeight : 0; }, end);
      await settle();
      const measured = await page.evaluate(() => {
        const list = document.querySelector('.file-list'), panel = document.querySelector('.file-panel');
        const rect = element => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
        return {
          width: innerWidth, list: { ...rect(list), clientWidth: list.clientWidth, scrollWidth: list.scrollWidth }, panel: rect(panel),
          rows: [...document.querySelectorAll('.file-row')].map(row => {
            const name = row.querySelector('.file-description strong'), meta = row.querySelector('.file-meta');
            return { index: Number(row.dataset.index), ...rect(row), name: { ...rect(name), lineHeight: parseFloat(getComputedStyle(name).lineHeight), title: name.title, text: name.textContent }, meta: rect(meta), label: row.getAttribute('aria-label') };
          }),
        };
      });
      measurements.push({ width, end, ...measured });
      const label = `${width}px ${end ? 'bottom' : 'top'}`;
      check(measured.list.scrollWidth <= measured.list.clientWidth + 1, `${label}: list overflows horizontally`);
      check(measured.panel.left >= -1 && measured.panel.right <= width + 1, `${label}: panel exceeds viewport`);
      for (const [index, row] of measured.rows.entries()) {
        check(row.name.height <= row.name.lineHeight + 1, `${label}: filename wraps at row ${row.index}`);
        check(row.right <= measured.list.right + 1 && row.meta.right <= row.right + 1, `${label}: row ${row.index} exceeds its container`);
        check(row.label === row.name.text, `${label}: full filename missing from accessible label`);
        check(row.name.title === row.name.text, `${label}: full filename tooltip missing`);
        if (width >= 768) check(row.height <= 41, `${label}: row ${row.index} is taller than one line`);
        if (index) {
          check(measured.rows[index - 1].bottom <= row.top + 1, `${label}: virtual rows overlap`);
          check(Math.abs(measured.rows[index - 1].meta.right - row.meta.right) < 1, `${label}: metadata columns are misaligned`);
        }
      }
      if (end) check(measured.rows.some(row => row.index === paths.length - 1), `${label}: final file is unreachable`);
      else if ([900, 1240].includes(width)) await page.screenshot({ path: resolve(output, `files-${width}.png`), fullPage: true });
    }
  }
  await page.setViewportSize({ width: 900, height: 840 });
  await page.locator('.file-list').evaluate(element => { element.scrollTop = 0; });
  await settle();
  await page.locator('.file-row[data-index="0"]').click();
  await page.locator('.file-row[data-index="1"]').click({ modifiers: ['Control'] });
  check(await page.locator('.file-row[aria-pressed="true"]').count() === 2, 'Ctrl+click must still select two files');
  check(await page.locator('.file-preview').count() === 0, 'Multi-selection must not open a preview');
  check(errors.length === 0, `Browser errors: ${errors.join('; ')}`);
  writeFileSync(resolve(output, 'results.json'), JSON.stringify({ failures, measurements, errors }, null, 2));
  console.log(JSON.stringify({ cases: measurements.length, failedChecks: failures.length, failures: failures.slice(0, 12), output }, null, 2));
  assert.equal(failures.length, 0, 'File-list layout regression checks failed; see results.json');
} finally {
  await browser?.close();
  await server.close();
}

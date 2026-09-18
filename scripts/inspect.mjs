/**
 * Inspect a rating page and dump everything we need to write accurate selectors:
 * a full-page screenshot, the rendered HTML, and a list of interactive controls.
 *
 * Run this first. Read the artifacts. Then configure the submit script.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { launch, requireEnv, settle, describeControls } from './lib.mjs';

const OUT = 'out';

async function main() {
  const url = requireEnv('REVIEW_URL');
  console.log(`URL  : ${url}`);
  console.log('Mode : INSPECT — the page is only read. Nothing is clicked, and no');
  console.log('       review is submitted. Re-run with mode "submit" to send one.\n');

  await mkdir(OUT, { recursive: true });
  const { browser, page } = await launch();

  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    console.log(`HTTP ${response?.status()} ${response?.statusText() ?? ''}`);
    await settle(page);

    console.log(`Title: ${await page.title()}`);

    await page.screenshot({ path: `${OUT}/page.png`, fullPage: true });
    await writeFile(`${OUT}/page.html`, await page.content(), 'utf8');

    const controls = await describeControls(page);
    await writeFile(`${OUT}/controls.json`, JSON.stringify(controls, null, 2), 'utf8');

    const visible = controls.filter((c) => c.visible);
    console.log(`\nFound ${controls.length} candidate controls (${visible.length} visible):\n`);
    for (const c of visible) {
      const id = c.attrs.id ? `#${c.attrs.id}` : '';
      const name = c.attrs.name ? `[name=${c.attrs.name}]` : '';
      const aria = c.attrs['aria-label'] ? ` aria-label="${c.attrs['aria-label']}"` : '';
      const cls = c.attrs.class ? ` class="${c.attrs.class.slice(0, 70)}"` : '';
      const txt = c.text ? ` text="${c.text}"` : '';
      console.log(`  <${c.tag}${c.type ? ` type=${c.type}` : ''}>${id}${name}${aria}${cls}${txt}`);
    }

    console.log(`\nWrote ${OUT}/page.png, ${OUT}/page.html, ${OUT}/controls.json`);
    console.log('\nNo review was submitted — this was an inspect run.');
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(`\nInspection failed: ${err.message}`);
  process.exit(1);
});

/**
 * Submit ONE review to a rating page.
 *
 * This script performs a single submission per run. There is no loop, no retry
 * after a successful submit, and no batching. If you need to correct a review,
 * fix the text and run it again deliberately.
 *
 * Defaults to a dry run: it fills the form and screenshots the result without
 * clicking submit, so you can confirm it targeted the right controls. Set
 * SUBMIT=true to actually send it.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { launch, requireEnv, settle, describeControls } from './lib.mjs';

const OUT = 'out';

function log(step, msg) {
  console.log(`[${step}] ${msg}`);
}

/** Return the first locator in the list that resolves to exactly one visible element. */
async function firstVisible(page, candidates) {
  for (const { label, locator } of candidates) {
    try {
      const count = await locator.count();
      for (let i = 0; i < count; i++) {
        const nth = locator.nth(i);
        if (await nth.isVisible()) return { label, locator: nth };
      }
    } catch {
      // A malformed or unsupported selector shouldn't abort the whole search.
    }
  }
  return null;
}

async function selectRating(page, rating) {
  const n = String(rating);
  const override = process.env.RATING_SELECTOR?.trim();

  const candidates = [];
  if (override) {
    candidates.push({ label: `RATING_SELECTOR override (${override})`, locator: page.locator(override) });
  }
  candidates.push(
    { label: `input[type=radio][value="${n}"]`, locator: page.locator(`input[type="radio"][value="${n}"]`) },
    { label: `[data-value="${n}"]`, locator: page.locator(`[data-value="${n}"]`) },
    { label: `[data-rating="${n}"]`, locator: page.locator(`[data-rating="${n}"]`) },
    { label: `[data-score="${n}"]`, locator: page.locator(`[data-score="${n}"]`) },
    { label: `aria-label containing "${n} star"`, locator: page.locator(`[aria-label*="${n} star" i]`) },
    { label: `aria-label containing "rate ${n}"`, locator: page.locator(`[aria-label*="rate ${n}" i]`) },
    { label: `[role=radio][aria-posinset="${n}"]`, locator: page.locator(`[role="radio"][aria-posinset="${n}"]`) },
    { label: `title containing "${n} star"`, locator: page.locator(`[title*="${n} star" i]`) },
    { label: `button with exact text "${n}"`, locator: page.getByRole('button', { name: new RegExp(`^\\s*${n}\\s*$`) }) },
  );

  const found = await firstVisible(page, candidates);
  if (found) {
    log('rating', `matched via ${found.label}`);
    await found.locator.click({ timeout: 10000 });
    return found.label;
  }

  // Fallback: star widgets are often N sibling elements with no useful attributes.
  // Pick the nth child of a rating-ish container, counting from the left.
  const starGroup = page.locator('[class*="star" i], [class*="rating" i]').locator('visible=true');
  const groupCount = await starGroup.count();
  if (groupCount >= Number(rating)) {
    log('rating', `falling back to positional star widget (element ${rating} of ${groupCount})`);
    await starGroup.nth(Number(rating) - 1).click({ timeout: 10000 });
    return `positional star ${rating}/${groupCount}`;
  }

  throw new Error(
    'Could not find the rating control. Run the inspect job, look at out/controls.json, ' +
    'then set RATING_SELECTOR to a CSS selector for the star/score you want.'
  );
}

async function fillComment(page, comment) {
  const override = process.env.COMMENT_SELECTOR?.trim();

  const candidates = [];
  if (override) {
    candidates.push({ label: `COMMENT_SELECTOR override (${override})`, locator: page.locator(override) });
  }
  candidates.push(
    { label: 'textarea', locator: page.locator('textarea') },
    { label: 'input[name*=comment]', locator: page.locator('input[name*="comment" i]') },
    { label: 'input[name*=feedback]', locator: page.locator('input[name*="feedback" i]') },
    { label: 'input[name*=review]', locator: page.locator('input[name*="review" i]') },
    { label: 'input[placeholder*=comment]', locator: page.locator('input[placeholder*="comment" i]') },
    { label: 'input[placeholder*=feedback]', locator: page.locator('input[placeholder*="feedback" i]') },
    { label: 'input[placeholder*=tell us]', locator: page.locator('input[placeholder*="tell us" i]') },
  );

  const found = await firstVisible(page, candidates);
  if (!found) {
    log('comment', 'no comment field found — submitting the rating on its own');
    return null;
  }

  log('comment', `matched via ${found.label}`);
  await found.locator.fill(comment, { timeout: 10000 });
  return found.label;
}

async function clickSubmit(page) {
  const override = process.env.SUBMIT_SELECTOR?.trim();

  const candidates = [];
  if (override) {
    candidates.push({ label: `SUBMIT_SELECTOR override (${override})`, locator: page.locator(override) });
  }
  candidates.push(
    { label: 'button[type=submit]', locator: page.locator('button[type="submit"]') },
    { label: 'input[type=submit]', locator: page.locator('input[type="submit"]') },
    { label: 'button named submit/send/rate/done', locator: page.getByRole('button', { name: /submit|send|rate|finish|done|continue/i }) },
  );

  const found = await firstVisible(page, candidates);
  if (!found) {
    throw new Error(
      'Could not find the submit button. Run the inspect job and set SUBMIT_SELECTOR ' +
      'to a CSS selector for it.'
    );
  }

  log('submit', `matched via ${found.label}`);
  await found.locator.click({ timeout: 15000 });
  return found.label;
}

async function main() {
  const url = requireEnv('REVIEW_URL');
  const comment = process.env.REVIEW_COMMENT?.trim() ?? '';
  const rating = Number(process.env.REVIEW_RATING ?? '1');
  const reallySubmit = process.env.SUBMIT === 'true';

  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new Error(`REVIEW_RATING must be an integer from 1 to 5, got: ${process.env.REVIEW_RATING}`);
  }

  console.log(`URL      : ${url}`);
  console.log(`Rating   : ${rating}`);
  console.log(`Comment  : ${comment ? `${comment.length} chars` : '(none)'}`);
  console.log(`Mode     : ${reallySubmit ? 'SUBMIT (one review will be sent)' : 'DRY RUN (nothing will be sent)'}\n`);

  await mkdir(OUT, { recursive: true });
  const { browser, page } = await launch();

  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    log('load', `HTTP ${response?.status()}`);
    await settle(page);
    await page.screenshot({ path: `${OUT}/1-loaded.png`, fullPage: true });

    await selectRating(page, rating);
    await page.waitForTimeout(500);

    if (comment) await fillComment(page, comment);
    await page.screenshot({ path: `${OUT}/2-filled.png`, fullPage: true });

    if (!reallySubmit) {
      console.log('\nDry run complete — the form is filled but nothing was submitted.');
      console.log('Check out/2-filled.png. If it looks right, re-run with submit: true.');
      return;
    }

    await clickSubmit(page);
    await settle(page, 8000);
    await page.screenshot({ path: `${OUT}/3-submitted.png`, fullPage: true });
    await writeFile(`${OUT}/after-submit.html`, await page.content(), 'utf8');
    await writeFile(`${OUT}/after-submit-controls.json`, JSON.stringify(await describeControls(page), null, 2), 'utf8');

    console.log('\nSubmitted one review. Confirm it landed by checking out/3-submitted.png.');
  } finally {
    await browser.close();
  }
}

main().catch(async (err) => {
  console.error(`\nFailed: ${err.message}`);
  process.exit(1);
});

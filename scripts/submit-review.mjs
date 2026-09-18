/**
 * Submit ONE review to the KwikRate rating page.
 *
 * The real form (confirmed by scripts/inspect.mjs) is a multi-step flow. Step one
 * is four labelled buttons:
 *
 *   Very Satisfied | Satisfied | Unsatisfied | Very Unsatisfied
 *
 * There is no comment box or submit button on that first screen, so anything
 * further only appears after a choice is made. This script clicks the choice,
 * waits for whatever comes next, fills a comment if the next step offers one,
 * and submits if there is something to submit.
 *
 * One run performs one submission. No loop, no batching, no retry after success.
 *
 * Dry runs abort every non-GET request, so the flow can be walked end to end
 * without anything being recorded — necessary here, because clicking a sentiment
 * button may itself be the submission.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { launch, requireEnv, settle, describeControls, blockMutations, recordMutations, isTelemetry, replayableHeaders } from './lib.mjs';

const OUT = 'out';

const CHOICES = ['Very Satisfied', 'Satisfied', 'Unsatisfied', 'Very Unsatisfied'];

function log(step, msg) {
  console.log(`[${step}] ${msg}`);
}

/**
 * Capture the page state. Tolerant of navigation: if the page is mid-flight the
 * execution context can be torn down under us, and losing a screenshot is not a
 * reason to abandon a submission that already happened.
 */
async function dump(page, name) {
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 10000 });
  } catch {
    // Carry on and capture whatever is there.
  }
  try {
    await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  } catch (err) {
    log('dump', `screenshot ${name} failed: ${err.message.split('\n')[0]}`);
  }
  try {
    await writeFile(`${OUT}/${name}.html`, await page.content(), 'utf8');
    await writeFile(`${OUT}/${name}-controls.json`, JSON.stringify(await describeControls(page), null, 2), 'utf8');
  } catch (err) {
    log('dump', `page dump ${name} failed: ${err.message.split('\n')[0]}`);
  }
}

async function firstVisible(page, candidates) {
  for (const { label, locator } of candidates) {
    try {
      const count = await locator.count();
      for (let i = 0; i < count; i++) {
        const nth = locator.nth(i);
        if (await nth.isVisible()) return { label, locator: nth };
      }
    } catch {
      // An unsupported selector shouldn't abort the whole search.
    }
  }
  return null;
}

/**
 * Click the sentiment button. Matched on exact accessible name — substring
 * matching would let "Unsatisfied" select the "Very Unsatisfied" button.
 */
async function chooseSentiment(page, choice) {
  const override = process.env.RATING_SELECTOR?.trim();

  const candidates = [];
  if (override) {
    candidates.push({ label: `RATING_SELECTOR override (${override})`, locator: page.locator(override) });
  }
  candidates.push(
    { label: `button named exactly "${choice}"`, locator: page.getByRole('button', { name: choice, exact: true }) },
    { label: `any element named exactly "${choice}"`, locator: page.getByText(choice, { exact: true }) },
  );

  const found = await firstVisible(page, candidates);
  if (!found) {
    throw new Error(
      `Could not find a "${choice}" button. Re-run the inspect job — the page's ` +
      `wording may have changed. Current expected options: ${CHOICES.join(', ')}.`
    );
  }

  log('choice', `matched via ${found.label}`);
  await found.locator.click({ timeout: 15000 });
  return found.label;
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
    { label: 'input[placeholder*=tell us]', locator: page.locator('input[placeholder*="tell us" i]') },
    { label: 'contenteditable', locator: page.locator('[contenteditable="true"]') },
  );

  const found = await firstVisible(page, candidates);
  if (!found) return null;

  log('comment', `matched via ${found.label}`);
  await found.locator.fill(comment, { timeout: 10000 });
  return found.label;
}

async function findSubmit(page) {
  const override = process.env.SUBMIT_SELECTOR?.trim();

  const candidates = [];
  if (override) {
    candidates.push({ label: `SUBMIT_SELECTOR override (${override})`, locator: page.locator(override) });
  }
  candidates.push(
    { label: 'button[type=submit]', locator: page.locator('button[type="submit"]') },
    { label: 'input[type=submit]', locator: page.locator('input[type="submit"]') },
    { label: 'button named submit/send/done', locator: page.getByRole('button', { name: /^(submit|send|done|finish|continue|next)$/i }) },
    { label: 'button containing submit/send', locator: page.getByRole('button', { name: /submit|send feedback|send review/i }) },
  );

  return firstVisible(page, candidates);
}

/**
 * Accepting a review redirects the page. Show that trail explicitly — it is the
 * application's own confirmation that the submission was taken, independent of
 * any HTTP status.
 */
function reportNavigation(navigations, finalUrl, startUrl) {
  console.log('\n--- Where the page ended up ---');
  if (navigations.length <= 1 && finalUrl === startUrl) {
    console.log(`  No redirect — still on ${finalUrl}`);
    return;
  }
  for (const [i, url] of navigations.entries()) {
    console.log(`  ${i === 0 ? '   ' : '-> '}${url}`);
  }
  if (navigations[navigations.length - 1] !== finalUrl) console.log(`  -> ${finalUrl}`);
  console.log(`\n  Final URL: ${finalUrl}`);
  if (finalUrl !== startUrl) console.log('  The page redirected after submitting, which is the site confirming it.');
}

/**
 * Re-fetch the record that was just written, so the stored review can be read
 * back rather than inferred from a status code. A PATCH that returns 204 proves
 * the server accepted the change but shows nothing of what it kept.
 *
 * Only URLs that address a single record are re-fetched. A collection endpoint
 * would return everyone else's feedback, which is none of our business.
 */
function addressesOneRecord(url) {
  return /[?&]id=eq\.[^&]+/i.test(url)
    || /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\?|$)/i.test(url);
}

async function readBack(page, recorder) {
  const targets = recorder.replay.filter((r) => r.method !== 'GET' && addressesOneRecord(r.url));

  console.log('\n--- Read-back check ---');
  if (targets.length === 0) {
    console.log('Skipped: no request addressed a single record, so there is nothing');
    console.log('safe to re-read (a collection endpoint would return other people\'s data).');
    return null;
  }

  const results = [];
  for (const target of targets) {
    try {
      const res = await page.request.get(target.url, { headers: replayableHeaders(target.headers) });
      const body = (await res.text()).replace(/\s+/g, ' ').trim();
      console.log(`  GET ${target.url} -> HTTP ${res.status()}`);
      console.log(`      stored: ${body.slice(0, 600)}${body.length > 600 ? ' […]' : ''}`);
      results.push({ url: target.url, status: res.status(), body: body.slice(0, 2000) });
    } catch (err) {
      console.log(`  GET ${target.url} -> failed: ${err.message.split('\n')[0]}`);
      results.push({ url: target.url, error: err.message.split('\n')[0] });
    }
  }
  return results;
}

/**
 * Say plainly whether anything actually reached the server. A page that looks
 * like it accepted the review proves nothing on its own.
 */
function reportOutcome(all, navigations = []) {
  console.log('\n--- Did it post? ---');

  // Analytics beacons are not evidence of a submission; count them separately.
  const sent = all.filter((r) => !isTelemetry(r.url));
  const beacons = all.filter((r) => isTelemetry(r.url));
  if (beacons.length > 0) {
    console.log(`(ignoring ${beacons.length} analytics beacon(s): ${beacons.map((b) => new URL(b.url).host).join(', ')})`);
  }

  if (sent.length === 0) {
    const extra = beacons.length > 0 ? ' (only analytics beacons)' : '';
    console.log(`INCONCLUSIVE: the page sent no state-changing request at all${extra}.`);
    if (navigations.length > 1) {
      console.log('The page did navigate, so something happened:');
      for (const url of navigations) console.log(`  -> ${url}`);
      console.log('If the last URL looks like a confirmation page, it probably went through.');
    } else {
      console.log('The page never navigated either, so most likely nothing was sent.');
    }
    console.log('Check out/4-final.png to see what the page is showing.');
    return;
  }

  const succeeded = sent.filter((r) => r.ok);
  const failed = sent.filter((r) => !r.ok);

  for (const r of sent) {
    const verdict = r.ok ? `HTTP ${r.status}` : r.failure ? `FAILED (${r.failure})` : `HTTP ${r.status}`;
    console.log(`  ${r.method} ${r.url} -> ${verdict}`);
    // Print what the server sent back. A status code says it was accepted; the
    // body is what shows the review as the server actually stored it.
    if (r.responseBody) {
      const body = r.responseBody.replace(/\s+/g, ' ').trim();
      console.log(`      server replied: ${body.slice(0, 500)}${body.length > 500 ? ' […]' : ''}`);
    } else if (r.ok && r.status === 204) {
      console.log('      server replied: (204 No Content — accepted, nothing returned)');
    }
  }

  if (succeeded.length > 0 && failed.length === 0) {
    const navPosts = succeeded.filter((r) => r.isNavigation).length;
    const via = navPosts > 0 ? ` (${navPosts} as a page navigation)` : '';
    console.log(`\nPOSTED: ${succeeded.length} request(s) accepted by the server${via}.`);
  } else if (succeeded.length > 0) {
    console.log(`\nPARTIAL: ${succeeded.length} accepted, ${failed.length} failed. Check the list above.`);
  } else {
    console.log('\nNOT POSTED: every state-changing request failed or was rejected.');
  }

  console.log('Full detail, including request and response bodies: out/sent-requests.json');
}

async function main() {
  const url = requireEnv('REVIEW_URL');
  const choice = (process.env.REVIEW_CHOICE || 'Very Unsatisfied').trim();
  const comment = process.env.REVIEW_COMMENT?.trim() ?? '';
  const reallySubmit = process.env.SUBMIT === 'true';

  if (!CHOICES.includes(choice)) {
    throw new Error(`REVIEW_CHOICE must be one of: ${CHOICES.join(' | ')} — got "${choice}"`);
  }

  console.log(`URL     : ${url}`);
  console.log(`Choice  : ${choice}`);
  console.log(`Comment : ${comment ? `${comment.length} chars` : '(none)'}`);
  console.log(`Mode    : ${reallySubmit ? 'SUBMIT — one review will be sent' : 'DRY RUN — all non-GET requests will be blocked'}\n`);

  await mkdir(OUT, { recursive: true });
  const { browser, page } = await launch();
  let blocked = [];
  let recorder = null;

  try {
    if (reallySubmit) recorder = recordMutations(page);
    else blocked = await blockMutations(page);

    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    log('load', `HTTP ${response?.status()}`);
    const startUrl = page.url();
    await settle(page);
    await dump(page, '1-loaded');

    await chooseSentiment(page, choice);
    await settle(page, 6000);
    await dump(page, '2-after-choice');
    log('choice', `page title is now "${await page.title()}"`);

    const commentField = comment ? await fillComment(page, comment) : null;
    if (comment && !commentField) {
      log('comment', 'no comment field on this step — see out/2-after-choice-controls.json');
    }
    if (commentField) await dump(page, '3-filled');

    const submit = await findSubmit(page);
    if (!submit) {
      log('submit', 'no submit button found — the sentiment click is likely the submission itself');
    } else if (!reallySubmit) {
      log('submit', `found submit via ${submit.label} (not clicking — dry run)`);
    } else {
      log('submit', `matched via ${submit.label}`);
      const urlBeforeSubmit = page.url();
      await submit.locator.click({ timeout: 15000 });
      // The redirect can arrive after the network goes quiet, so wait for the
      // URL to change rather than assuming settle() outlasts it.
      await page
        .waitForURL((u) => u.toString() !== urlBeforeSubmit, { timeout: 15000 })
        .then(() => log('submit', `redirected to ${page.url()}`))
        .catch(() => log('submit', 'no redirect within 15s'));
      await settle(page, 8000);
    }

    await dump(page, '4-final');

    if (!reallySubmit) {
      await writeFile(`${OUT}/blocked-requests.json`, JSON.stringify(blocked, null, 2), 'utf8');
      console.log(`\nDry run complete. ${blocked.length} state-changing request(s) were blocked.`);
      console.log('Check out/blocked-requests.json to see exactly what a real run would send,');
      console.log('and out/4-final.png for how far the flow got. Nothing was recorded.');
    } else {
      await recorder.settled();
      await writeFile(`${OUT}/sent-requests.json`, JSON.stringify(recorder.sent, null, 2), 'utf8');
      reportOutcome(recorder.sent, recorder.navigations);

      reportNavigation(recorder.navigations, page.url(), startUrl);

      const stored = await readBack(page, recorder);
      if (stored) await writeFile(`${OUT}/read-back.json`, JSON.stringify(stored, null, 2), 'utf8');
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(`\nFailed: ${err.message}`);
  process.exit(1);
});

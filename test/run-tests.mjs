/**
 * End-to-end checks against the mock server. These assert the behaviours that
 * were each found the hard way on a live run, so a regression is caught here
 * rather than by submitting a wrong review to a real form.
 *
 *   npm test
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { isTelemetry, replayableHeaders } from '../scripts/lib.mjs';

const PORT = 8899;
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
let checks = 0;

function check(name, condition, detail = '') {
  checks++;
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`);
  }
}

function section(name) {
  console.log(`\n${name}`);
}

/** Run the submit script and return its combined output. */
function runSubmit(env) {
  return new Promise((resolve) => {
    const child = spawn('node', ['scripts/submit-review.mjs'], {
      env: { ...process.env, NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ out, code }));
  });
}

async function main() {
  const server = spawn('node', ['test/serve-mock.mjs', String(PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const seen = [];
  server.stdout.on('data', (d) => {
    for (const line of String(d).split('\n')) {
      if (/^(POST|PATCH|GET) /.test(line)) seen.push(line.trim());
    }
  });
  await once(server.stdout, 'data');

  try {
    section('Unit: header replay');
    const stripped = replayableHeaders({
      ':authority': 'example.test',
      ':method': 'PATCH',
      apikey: 'key-value',
      'content-length': '9',
    });
    check('HTTP/2 pseudo-headers are stripped', !Object.keys(stripped).some((k) => k.startsWith(':')));
    check('auth headers survive', stripped.apikey === 'key-value');
    check('body headers are dropped for a GET', !('content-length' in stripped));

    section('Unit: telemetry classification');
    check('Cloudflare RUM is telemetry', isTelemetry('https://kwikrate.com/cdn-cgi/rum?'));
    check('Sentry is telemetry', isTelemetry('https://o1.ingest.sentry.io/api/1/envelope/'));
    check('the ratings endpoint is NOT telemetry',
      !isTelemetry('https://x.supabase.co/rest/v1/ratings?select=*'));
    check('a ratings record is NOT telemetry',
      !isTelemetry('https://x.supabase.co/rest/v1/ratings?id=eq.abc'));

    section('Dry run sends nothing');
    seen.length = 0;
    const dry = await runSubmit({
      REVIEW_URL: `${BASE}/`, REVIEW_CHOICE: 'Very Unsatisfied', REVIEW_COMMENT: 'x', SUBMIT: 'false',
    });
    check('exits cleanly', dry.code === 0, `exit ${dry.code}`);
    check('server received nothing', seen.length === 0, `server saw: ${seen.join(' | ')}`);
    check('reports the block', /state-changing request\(s\) were blocked/.test(dry.out));

    section('Submit posts, redirects and reads back');
    seen.length = 0;
    const comment = 'The food is consistently bland and unimaginative.';
    const run = await runSubmit({
      REVIEW_URL: `${BASE}/`, REVIEW_CHOICE: 'Very Unsatisfied', REVIEW_COMMENT: comment, SUBMIT: 'true',
    });
    check('exits cleanly', run.code === 0, `exit ${run.code}`);
    check('reports POSTED', /POSTED: \d+ request\(s\) accepted/.test(run.out));
    check('excludes the analytics beacon', /ignoring 1 analytics beacon/.test(run.out));
    check('beacon is not counted as a submission', /POSTED: 2 request/.test(run.out));
    check('reports the redirect', /redirected to .*\/thanks/.test(run.out));
    check('prints the final URL', /Final URL: .*\/thanks/.test(run.out));
    check('reads the record back', /Read-back check/.test(run.out));
    check('stored record contains the comment', run.out.includes(comment),
      'read-back did not echo the submitted comment');
    check('no phantom failure from the 204', !/PARTIAL|NOT POSTED/.test(run.out));

    const stored = JSON.parse(await readFile('out/read-back.json', 'utf8'));
    check('read-back.json written with the comment',
      JSON.stringify(stored).includes(comment));

    section('Exact-name matching picks the intended button');
    // "Satisfied" is the case that actually breaks under substring matching: it
    // matches "Very Satisfied" too, and that one comes first in the DOM, so a
    // non-exact locator silently selects the opposite sentiment. Testing
    // "Unsatisfied" instead would pass either way and prove nothing.
    for (const [choice, wrong] of [['Satisfied', 'Very Satisfied'], ['Unsatisfied', 'Very Unsatisfied']]) {
      seen.length = 0;
      await runSubmit({
        REVIEW_URL: `${BASE}/`, REVIEW_CHOICE: choice, REVIEW_COMMENT: 'y', SUBMIT: 'true',
      });
      const created = seen.find((l) => l.startsWith('POST') && l.includes('/rest/v1/ratings'));
      check(`"${choice}" does not select "${wrong}"`,
        created?.includes(`"choice":"${choice}"`) === true,
        `server saw: ${created}`);
    }

    section('Navigation-style form');
    const nav = await runSubmit({
      REVIEW_URL: `${BASE}/form`, REVIEW_CHOICE: 'Very Unsatisfied', REVIEW_COMMENT: 'z', SUBMIT: 'true',
    });
    check('exits cleanly', nav.code === 0, `exit ${nav.code}`);
    check('records the navigation posts', /as a page navigation/.test(nav.out));
    check('skips read-back with a reason', /Skipped: no request addressed a single record/.test(nav.out));
  } finally {
    server.kill();
  }

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures > 0) {
    console.log(`${failures} FAILED`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

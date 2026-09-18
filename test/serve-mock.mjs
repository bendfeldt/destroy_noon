/**
 * Serves the mock rating forms and accepts their submissions, so the submit
 * script can be exercised against a real HTTP server — including the response
 * codes that prove a submission was accepted.
 *
 *   node test/serve-mock.mjs [port]
 *
 * Two flows are served, because rating pages do this both ways:
 *
 *   GET /      the fetch/XHR flow (test/mock-form.html)
 *   GET /form  a no-JavaScript flow where each step is a form POST that
 *              navigates the whole page
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] ?? 8787);

const CHOICES = ['Very Satisfied', 'Satisfied', 'Unsatisfied', 'Very Unsatisfied'];

/** In-memory store standing in for the ratings table. */
const records = new Map();

const page = (body) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Kwikrate</title><style>
body{font-family:system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem}
button{border:2px solid #d1d5db;border-radius:.5rem;padding:1rem 1.25rem;font:inherit;background:#fff;cursor:pointer}
textarea{width:100%;height:7rem;font:inherit;padding:.5rem}
</style></head><body>${body}</body></html>`;

const step1 = page(`<h1>How was your experience?</h1>
<form method="POST" action="/form/step2">
  ${CHOICES.map((c) => `<button type="submit" name="choice" value="${c}">${c}</button>`).join('\n  ')}
</form>`);

const step2 = (choice) => page(`<h1>Tell us more</h1>
<form method="POST" action="/form/done">
  <input type="hidden" name="choice" value="${choice}">
  <textarea name="comment" placeholder="What went wrong?"></textarea>
  <p><button type="submit">Submit</button></p>
</form>`);

const done = page('<h1>Thanks for your feedback!</h1><p>Your response has been recorded.</p>');

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

const html = (res, body) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  const json = (status, payload) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(payload === undefined ? '' : JSON.stringify(payload));
  };

  if (req.method === 'POST' || req.method === 'PATCH') {
    const body = await readBody(req);
    console.log(`${req.method} ${url.pathname}${url.search} ${body}`);

    if (url.pathname === '/form/step2') {
      return html(res, step2(new URLSearchParams(body).get('choice') ?? ''));
    }
    if (url.pathname === '/form/done') return html(res, done);

    // Minimal PostgREST stand-in: POST creates and returns the row, PATCH
    // merges into it and returns 204, matching what the live backend does.
    if (url.pathname === '/rest/v1/ratings') {
      const payload = JSON.parse(body || '{}');
      const idFilter = url.searchParams.get('id');

      if (req.method === 'POST') {
        const id = randomUUID();
        records.set(id, { id, ...payload, comment: null });
        return json(201, [records.get(id)]);
      }

      const id = (idFilter ?? '').replace(/^eq\./, '');
      const existing = records.get(id);
      if (!existing) return json(404, { message: 'not found' });
      records.set(id, { ...existing, ...payload });
      return json(204);
    }

    return json(200, { ok: true, received: JSON.parse(body || '{}') });
  }

  if (url.pathname === '/rest/v1/ratings') {
    const id = (url.searchParams.get('id') ?? '').replace(/^eq\./, '');
    console.log(`GET ${url.pathname}${url.search}`);
    const found = records.get(id);
    return json(200, found ? [found] : []);
  }

  if (url.pathname === '/thanks') return html(res, done);

  if (url.pathname === '/form') return html(res, step1);

  try {
    html(res, await readFile(join(here, 'mock-form.html'), 'utf8'));
  } catch (err) {
    res.writeHead(500);
    res.end(err.message);
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`mock server on http://127.0.0.1:${port}/       (fetch/XHR flow)`);
  console.log(`                http://127.0.0.1:${port}/form  (navigation flow)`);
});

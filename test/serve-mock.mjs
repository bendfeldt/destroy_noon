/**
 * Serves test/mock-form.html and accepts the form's POSTs, so the submit script
 * can be exercised against a real HTTP server — including the response codes
 * that prove a submission was accepted.
 *
 *   node test/serve-mock.mjs [port]
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] ?? 8787);

const server = createServer(async (req, res) => {
  if (req.method === 'POST') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    console.log(`POST ${req.url} ${body}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, received: JSON.parse(body || '{}') }));
    return;
  }

  try {
    const html = await readFile(join(here, 'mock-form.html'), 'utf8');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  } catch (err) {
    res.writeHead(500);
    res.end(err.message);
  }
});

server.listen(port, '127.0.0.1', () => console.log(`mock server on http://127.0.0.1:${port}/`));

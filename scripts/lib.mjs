import { chromium } from 'playwright';

/**
 * Launch a browser. Set CHROMIUM_PATH to use a Chromium that is already on the
 * machine (useful when the provisioned build doesn't match what this Playwright
 * version would download); otherwise Playwright resolves its own.
 */
export async function launch() {
  const executablePath = process.env.CHROMIUM_PATH?.trim() || undefined;
  if (executablePath) console.log(`Using Chromium at ${executablePath}`);
  const browser = await chromium.launch({ headless: true, executablePath });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 1600 },
    locale: 'en-US',
  });
  const page = await context.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log(`  [page console error] ${msg.text()}`);
  });
  return { browser, context, page };
}

export function requireEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

/**
 * Wait for the page to settle. Rating pages are usually SPAs, so "load" alone
 * fires before the form exists.
 */
export async function settle(page, ms = 3000) {
  try {
    await page.waitForLoadState('networkidle', { timeout: ms });
  } catch {
    // networkidle never arriving is common with polling/analytics; not fatal.
  }
  await page.waitForTimeout(750);
}

/**
 * Describe every interactive element on the page. Used by the inspect script so
 * we can write accurate selectors without guessing at the DOM.
 */
export async function describeControls(page) {
  return page.evaluate(() => {
    const selector = 'input, textarea, select, button, [role="radio"], [role="button"], [role="slider"], a[href="#"], svg[class*="star" i], [class*="star" i], [class*="rating" i]';
    const seen = new Set();
    const out = [];
    for (const el of document.querySelectorAll(selector)) {
      if (seen.has(el)) continue;
      seen.add(el);
      const rect = el.getBoundingClientRect();
      const attrs = {};
      for (const a of el.attributes) {
        if (a.value.length <= 160) attrs[a.name] = a.value;
      }
      out.push({
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type') || undefined,
        text: (el.innerText || el.textContent || '').trim().slice(0, 120) || undefined,
        visible: rect.width > 0 && rect.height > 0,
        box: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
        attrs,
      });
    }
    return out;
  });
}

/**
 * Block every state-changing request (anything that isn't a GET/HEAD) and record
 * what would have been sent. This is what makes a dry run genuinely dry on a
 * form that may submit the moment you click something, and it shows us the real
 * submission endpoint and payload.
 */
export async function blockMutations(page) {
  const blocked = [];
  await page.route('**/*', async (route) => {
    const request = route.request();
    const method = request.method();
    if (method === 'GET' || method === 'HEAD') return route.continue();

    let body;
    try {
      body = request.postData() ?? undefined;
    } catch {
      body = '(unreadable)';
    }
    blocked.push({ method, url: request.url(), body });
    console.log(`  [blocked] ${method} ${request.url()}${body ? ` body=${body.slice(0, 400)}` : ''}`);
    await route.abort();
  });
  return blocked;
}

/**
 * Record every state-changing request and the server's response to it. This is
 * the actual evidence a submission landed — a screenshot only proves the page
 * changed, not that anything was persisted.
 *
 * Handles submissions that are full-page navigations as well as XHR/fetch: a
 * classic form POST shows up as a document request, and the navigation itself is
 * recorded separately as corroborating evidence.
 *
 * Reading a response body is async, so the returned object exposes settled(),
 * which resolves once every in-flight read has finished. Call it before writing
 * results out, otherwise a late-arriving response can be missed entirely.
 */
const SENSITIVE_HEADERS = ['authorization', 'apikey', 'api-key', 'cookie', 'x-api-key', 'x-supabase-auth'];

function redactHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SENSITIVE_HEADERS.includes(k.toLowerCase()) ? '[redacted]' : v;
  }
  return out;
}

export function recordMutations(page) {
  const sent = [];
  const navigations = [];
  const replay = [];
  const pending = new Set();
  // A request that already produced a response can still fire 'requestfailed'
  // — a 204 has no body, so the browser cancels the stream and reports
  // ERR_ABORTED. Counting both made a clean submission read as PARTIAL.
  const responded = new Set();

  page.on('response', (response) => {
    const request = response.request();
    const method = request.method();
    if (method === 'GET' || method === 'HEAD') return;

    const entry = {
      method,
      url: request.url(),
      status: response.status(),
      ok: response.ok(),
      isNavigation: request.isNavigationRequest(),
    };
    try {
      entry.requestBody = request.postData() ?? undefined;
    } catch {
      // Not always readable; the status is the part that matters.
    }
    responded.add(request);
    sent.push(entry);
    console.log(`  [sent] ${method} ${request.url()} -> HTTP ${response.status()}${entry.isNavigation ? ' (navigation)' : ''}`);

    // Keep the real headers in memory so the record can be read back, but never
    // let credentials reach the artifact — it is downloadable and kept for days.
    const headerRead = request.allHeaders()
      .then((headers) => {
        replay.push({ url: request.url(), method, headers });
        entry.headers = redactHeaders(headers);
      })
      .catch(() => {})
      .finally(() => pending.delete(headerRead));
    pending.add(headerRead);

    // Body reads race with navigation, so track them and tolerate failure.
    const read = response.text()
      .then((text) => { if (text) entry.responseBody = text.slice(0, 1000); })
      .catch(() => { entry.responseBody = '(body unavailable — page navigated away)'; })
      .finally(() => pending.delete(read));
    pending.add(read);
  });

  page.on('requestfailed', (request) => {
    const method = request.method();
    if (method === 'GET' || method === 'HEAD') return;
    if (responded.has(request)) return;
    const failure = request.failure()?.errorText ?? 'unknown error';
    sent.push({ method, url: request.url(), status: null, ok: false, failure });
    console.log(`  [FAILED] ${method} ${request.url()} -> ${failure}`);
  });

  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) return;
    const url = frame.url();
    // A single load can fire several times with the same URL; only note changes.
    if (navigations[navigations.length - 1] === url) return;
    navigations.push(url);
    console.log(`  [navigated] ${url}`);
  });

  return {
    sent,
    navigations,
    replay,
    settled: () => Promise.all([...pending]),
  };
}

/**
 * Analytics and error-reporting beacons fire alongside real traffic and are not
 * evidence of anything. The live run counted a Cloudflare RUM beacon among its
 * "3 requests accepted", which inflates the number and could let a genuinely
 * failed submission read as a partial success.
 */
const TELEMETRY_PATTERNS = [
  /\/cdn-cgi\/(rum|beacon|challenge-platform)/i,
  /google-analytics\.com/i,
  /googletagmanager\.com/i,
  /doubleclick\.net/i,
  /\.sentry\.io|sentry_key=|\/envelope\//i,
  /segment\.(io|com)/i,
  /plausible\.io/i,
  /posthog\.com/i,
  /mixpanel\.com/i,
  /hotjar\.(com|io)/i,
  /clarity\.ms/i,
  /datadoghq\.com/i,
  /newrelic\.com|nr-data\.net/i,
];

export function isTelemetry(url) {
  return TELEMETRY_PATTERNS.some((re) => re.test(url));
}

/**
 * Strip headers that cannot be replayed on a new request. An HTTP/2 capture
 * carries pseudo-headers (":authority", ":method", ":path", ":scheme") which are
 * not valid header names to send, and the body headers of the original request
 * do not apply to a GET. The live site is HTTP/2, so a naive replay fails with
 * `Header name must be a valid HTTP token [":authority"]`.
 */
export function replayableHeaders(headers) {
  const skip = ['content-length', 'content-type', 'accept-encoding'];
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.startsWith(':')) continue;
    if (skip.includes(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

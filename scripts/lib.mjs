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

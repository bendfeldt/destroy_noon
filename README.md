# Cafeteria review submitter

Submits **one** honest review to the KwikRate rating page, from a GitHub Action.

One run = one review. No loop, no batching, no retry after a successful submit.
To change what you said, edit the text and run it again on purpose.

## What the form actually is

An `inspect` run against the live page found this on step one:

```
<button> "Very Satisfied"
<button> "Satisfied"
<button> "Unsatisfied"
<button> "Very Unsatisfied"
```

Four labelled buttons — no stars, no radio inputs, and **no comment box or submit
button on the first screen**. Anything further only appears after a choice is
made, so this is a multi-step flow. The script clicks your chosen button, waits
for the next step, fills a comment if one is offered, and submits if there is
something to submit.

Because the first click may itself be what registers the rating, `dry-run` does
not rely on "don't click the submit button" for safety. It aborts every non-GET
request outright, so the flow can be walked end to end with nothing recorded, and
logs what each blocked request *would* have sent.

## Usage

**Actions → Submit review → Run workflow**, then pick a mode:

| Mode | What it does |
|---|---|
| `inspect` | Loads the page, screenshots it, dumps every control to `controls.json`. Clicks nothing. |
| `dry-run` | Walks the whole flow with all non-GET requests blocked. Records what would have been sent. Nothing lands. |
| `submit` | Walks the flow for real, once. |

Run `dry-run` before `submit`. Download the artifact and check:

- `2-after-choice.png` — what the second step looks like
- `3-filled.png` — your comment in the box
- `blocked-requests.json` — the exact endpoint and payload a real run would send

Every run uploads its screenshots and page dumps as an artifact, kept 7 days.

## How to verify it actually posted

A screenshot only proves the page changed. The evidence is the HTTP exchange, so
a `submit` run records every state-changing request and the server's response to
it, then prints a verdict:

```
--- Did it post? ---
  POST https://.../api/review -> HTTP 200

POSTED: 1 request(s) accepted by the server.
```

Three outcomes:

- **POSTED** — the server accepted it. `out/sent-requests.json` has the exact
  request body sent and the response body returned, so you can read back the
  comment text the server received.
- **NOT POSTED** — everything failed or was rejected. Nothing landed; the reason
  is in the log and the JSON.
- **INCONCLUSIVE** — the page issued no state-changing request at all. Either the
  submission happens some way this didn't catch, or the click didn't do what we
  assumed. Check `out/4-final.png`.

Both submission styles are handled: a `fetch`/XHR call, and a classic form POST
that navigates the whole page. Navigation posts are marked `isNavigation` in the
JSON, and the confirmation page's own HTML is captured as the response body — so
"Thanks for your feedback" ends up in the evidence file, not just in a screenshot.

**A limitation of dry runs on navigation-style forms.** Blocking the first POST
means the page never advances, so a dry run can only ever show you step one. If
the live form turns out to work that way, the dry run will show a single blocked
request and stop there — that is expected, not a failure. You will not get a
preview of the comment box before committing to a real run.

Cross-check it two further ways:

1. `out/4-final.png` should show whatever confirmation the page gives.
2. Reload the rating URL in your own browser afterwards. Many rating pages show
   an "already rated" or thank-you state once they have your response.

### If the page changes

The scripts match the sentiment button on its **exact** accessible name — substring
matching would let `Unsatisfied` select the `Very Unsatisfied` button. If the
wording changes, `inspect` will show you the new labels. You can pin any step
precisely with these env vars in `.github/workflows/review.yml`:

- `RATING_SELECTOR` — CSS selector for the sentiment button
- `COMMENT_SELECTOR` — CSS selector for the text field
- `SUBMIT_SELECTOR` — CSS selector for the submit button

## Running locally

```bash
npm install
npx playwright install chromium

REVIEW_URL="https://kwikrate.com/rate/<id>" \
REVIEW_CHOICE="Very Unsatisfied" \
REVIEW_COMMENT="..." \
SUBMIT=false \
npm run submit
```

`SUBMIT=false` blocks all mutations. Set it to `true` to actually send.

If Chromium is already installed and Playwright wants a different build, point at
the existing one with `CHROMIUM_PATH=/path/to/chrome`.

### Testing without touching the live site

`test/mock-form.html` mirrors the real two-step structure — four sentiment
buttons, then a comment box and submit button — and fires a POST on the choice
click, so the dry-run blocking can be verified:

```bash
node test/serve-mock.mjs 8787 &

REVIEW_URL="http://127.0.0.1:8787/" \
REVIEW_CHOICE="Very Unsatisfied" REVIEW_COMMENT="test" SUBMIT=true npm run submit
```

`test/serve-mock.mjs` serves both shapes and returns 200, so this exercises the
full verification path end to end — the run should report `POSTED`, and the
server log echoes the payload it received.

- `http://127.0.0.1:8787/` — the fetch/XHR flow
- `http://127.0.0.1:8787/form` — a no-JavaScript flow where every step is a form
  POST that navigates the page

Run against both when changing the recording logic; they exercise different paths.

## Notes

- The review text is a workflow input, so it appears in the Actions run log and
  run history. Don't write anything there you wouldn't want a colleague to read.
- Be specific — a date, a dish, what was wrong with it. Specific feedback gets
  escalated; "food bad" gets filed.

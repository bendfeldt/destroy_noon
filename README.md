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
REVIEW_URL="file://$PWD/test/mock-form.html" \
REVIEW_CHOICE="Very Unsatisfied" REVIEW_COMMENT="test" SUBMIT=false npm run submit
```

## Notes

- The review text is a workflow input, so it appears in the Actions run log and
  run history. Don't write anything there you wouldn't want a colleague to read.
- Be specific — a date, a dish, what was wrong with it. Specific feedback gets
  escalated; "food bad" gets filed.

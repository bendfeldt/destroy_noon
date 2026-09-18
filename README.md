# Cafeteria review submitter

Submits **one** honest review to a KwikRate rating page, from a GitHub Action.

One run = one review. There is no loop, no batching, and no retry after a
successful submit. If you want to change what you said, edit the text and run it
again on purpose.

## Why this exists

The rating form is a browser widget — clicking stars and typing into a box. This
just drives that with a headless browser so you can fire it from the Actions tab
instead of doing it by hand, and so you get a screenshot proving what was sent.

## Usage

Go to **Actions → Submit review → Run workflow**, then pick a mode:

| Mode | What it does |
|---|---|
| `inspect` | Loads the page, screenshots it, dumps every form control to `controls.json`. Submits nothing. |
| `dry-run` | Picks the rating and fills the comment, screenshots the filled form. Submits nothing. |
| `submit` | Same, then clicks submit once. |

**Run `inspect` first.** The selector heuristics are written blind — this repo was
built without network access to the live page. Download the run's artifact and
look at `page.png` and `controls.json` to see the real form. Then run `dry-run`
and check `2-filled.png` shows the rating you meant. Only then run `submit`.

Every run uploads its screenshots and page dumps as a workflow artifact, kept for
7 days.

### If the heuristics miss

The scripts try a list of common patterns for star widgets, comment boxes, and
submit buttons. If the real page uses something unusual, `inspect` will show you
what it is, and you can pin it exactly by setting these env vars in
`.github/workflows/review.yml`:

- `RATING_SELECTOR` — CSS selector for the star/score you want to click
- `COMMENT_SELECTOR` — CSS selector for the text field
- `SUBMIT_SELECTOR` — CSS selector for the submit button

## Running locally

```bash
npm install
npx playwright install chromium

REVIEW_URL="https://kwikrate.com/rate/<id>" \
REVIEW_RATING=1 \
REVIEW_COMMENT="..." \
SUBMIT=false \
npm run submit
```

`SUBMIT=false` is a dry run. Set it to `true` to actually send.

If Chromium is already on the machine and Playwright wants to download a
different build, point at the existing one with `CHROMIUM_PATH=/path/to/chrome`.

### Testing without touching the live site

`test/mock-form.html` is a stand-in rating page with the same shape (star widget,
comment box, submit button). Use it to check the scripts work before aiming them
anywhere real:

```bash
REVIEW_URL="file://$PWD/test/mock-form.html" REVIEW_RATING=1 \
REVIEW_COMMENT="test" SUBMIT=true npm run submit
```

## Notes

- The review text is passed as a workflow input, so it shows up in the Actions run
  log and in the repo's run history. Don't put anything in there you wouldn't want
  a colleague to read.
- Write something specific — a date, a dish, what was actually wrong. Specific
  feedback gets escalated; "food bad" gets filed.

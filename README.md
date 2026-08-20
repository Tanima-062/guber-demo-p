# Take-Home Exercise — Data Collection

Welcome! This exercise is designed to look like a normal day of work here:
an item list from our database, a target site, and a small scraping task.
It is not a puzzle — we grade your decisions, not your typing speed.

## Time box

We expect this to take **2–3 hours**. Please stop around the 3-hour mark even
if you're not done — write down what you'd do next in `DECISIONS.md` instead.
A well-scoped partial solution with clear reasoning beats a polished one that
clearly took a full day.

## AI policy

**Use any tools you'd use on the job — including AI assistants (ChatGPT,
Claude, Copilot, Cursor, etc.). We use them daily ourselves.**

What we grade is your judgment. In `DECISIONS.md`, tell us:

- What you used AI for (roughly — no transcripts needed)
- Where it helped, and where it was wrong or misleading
- How you checked that its output was actually correct

Well-directed AI use is a positive signal. Undisclosed or unverified AI output
is a negative one. Not using AI at all is also perfectly fine — just say so.

## The task

`data/items.csv` contains **100 items** from our database, previously collected
from [vet1.lt](https://vet1.lt) (a veterinary pharmacy). Each row has a
`title`, `url` and `source_id`.

Your job: **collect the current data for these items** and produce a structured
output file with one record per item, following this repo's structure.

For each item collect at least: `title`, `manufacturer`, `price`,
`discountPrice` (if any), `inStock`, `category`, `url`, `sourceId`
(see `src/types/items/pharmacyItem.ts` for the full shape — fill what the page
gives you, don't chase fields the page doesn't have).

Important details:

- `source_id` is how we join records across scrapes — your output must stay
  consistent with the ids in `data/items.csv`.
- Our clients make decisions based on this data, so **trustworthiness matters
  more than volume**. If anything you collect seems off, flag it in
  `DECISIONS.md` — noticing problems is part of the job.
- Scrape politely: keep concurrency at 1 and add a small delay between
  requests. 100 items is deliberately small.

## The repo

This is a minimal cut of our real scraper structure:

- `src/sites/VT1/functions.ts` — the integration skeleton (`scrapePharmacyItem`
  is where parsing lives). Follow this structure.
- `src/sites/VT1/sample.ts` — the test harness. `yarn debug --source VT1` runs
  it. Fetching is not implemented — **making the requests happen is part of
  the task** (any HTTP client in `package.json`, or add your own).
- `src/utils.ts` — small helpers, including `stringToHash` (how `source_id`s
  are generated).

Setup:

```bash
yarn install
yarn debug --source VT1
```

## What to submit

1. Your code (push to a private repo and invite us, or send a zip — without
   `node_modules`)
2. Your output file (JSON or CSV)
3. `DECISIONS.md`:
   - What you did and what assumptions you made
   - Anything you noticed about the data that we should know
   - Your AI usage and how you verified it
   - What you'd do next with more time

Questions during the exercise are welcome — email us, we answer within a few
hours. Good luck!

# DECISIONS.md

## What I did

Implemented `scrapePharmacyItem` in `src/sites/VT1/functions.ts` and the
fetch/test harness in `src/sites/VT1/sample.ts`, following the existing
repo structure rather than restructuring it.

- **Fetching**: axios first, with a Playwright (headless Chromium) fallback
  that only kicks in on 403/429/503 or a detected Cloudflare block page.
  A Bright Data residential proxy is wired in behind `PROXY_ENABLED` for
  the same reason. Sequential loop only (no concurrency), with a
  configurable delay (`REQUEST_DELAY_MS`, default 1500ms) between every
  request, including after failures.
- **Parsing priority**: JSON-LD `Product` blocks first, then the
  storefront's `omnisendProductData` inline script, then HTML
  fallbacks (meta tags, labeled selectors, breadcrumbs). I only fell back
  to HTML when structured data didn't have the field.
- **Price/discount logic**: I treat `price` as the "shown as regular"
  price and `discountPrice` as the sale price, and only populate
  `discountPrice` when I have two independent, explicit values (a
  current/sale price AND an old/regular price) and the regular price is
  strictly greater. If the page only exposes one price, it goes in
  `price` and `discountPrice` is left unset — I did not want to guess a
  discount off a single number.
- **Category**: prefer structured `category` from JSON-LD; otherwise the
  second-to-last breadcrumb (the last breadcrumb is usually the product
  title itself, not a category).
- **`sourceId`**: taken directly from `data/items.csv`, not
  regenerated — the harness does log a warning if `stringToHash(url)`
  disagrees with the CSV's `source_id`, but the CSV value always wins,
  since the README says that's the authoritative join key.
- **Output**: one record per input row, in the same order as
  `data/items.csv`, written to `output/output.json`. Any row that fails
  to fetch/parse still produces a record (with empty fields and
  `meta.scrapeStatus: "failed"`) rather than being dropped, so the
  output always has exactly 100 records and stays index-aligned with the
  input. `output/output.failures.json` lists just the failed rows for
  convenience.
- **`runVariantSpotChecks` (in `sample.ts`) is advisory, not fatal.** It
  originally `throw`n on any unresolved repeated-URL variant, which
  discarded the *entire* 100-row output — including every successfully
  scraped, non-variant row — the first time an actual `yarn debug`
  run hit a real-world case it didn't like. That's the wrong failure
  mode for this task: the README asks us to collect trustworthy data
  and *flag* what looks off, not to produce zero output because part
  of the input turned out to be stale. It now returns a report instead:
  `output/output.json` and `output/output.failures.json` are always
  written first, and if the report has issues they're written to
  `output/output.variant-warnings.json` and the process exits non-zero
  (so CI still notices) without deleting the scrape. See "Bug found
  while running the harness" below for what this actually caught.
- `scripts/validate-output.js` checks record count, `sourceId`/`url`
  alignment against the CSV, uniqueness, and presence of the required
  fields. Run via `yarn validate` (or `node scripts/validate-output.js`).
- `scripts/spot-check-variants.js` (`yarn spot-check`) targets the one
  input pattern that generic validation can't catch: 15 base URLs in
  `data/items.csv` each repeat 2-4 times with a different `#fragment`
  (different variants of the same product page). The
  `omnisendProductData.variants` object is the per-variant source of
  truth for price/stock, matched against the URL fragment in
  `selectOmnisendVariant`. If that matching ever silently degraded to
  "just use the first variant," every row sharing a base URL would
  collapse onto identical price/discount/stock data -- invisible on a
  random sample (most products only have one variant), but unmissable
  once you group by base URL and diff within the group. The script
  prints those 15 groups as the priority list for manual spot-checking
  against the live site, and, once `output/output.json` exists, flags
  any group whose variant-sensitive fields are all identical.

## Assumptions

- Where the README's required field list (`title`, `manufacturer`,
  `price`, `discountPrice`, `inStock`, `category`, `url`, `sourceId`) and
  the full `PharmacyItem` type disagreed on what's optional, I treated
  the README's list as the hard requirement and filled the rest of
  `PharmacyItem` opportunistically — I did not chase fields the page
  doesn't expose (e.g. I never fabricated a `barcode`; if the page
  didn't provide a GTIN, the field is simply omitted).
- `inStock` is `false` whenever availability can't be determined
  (`additionalInformation.availabilityKnown: false` in that case), rather
  than defaulting to `true`. I'd rather under-report stock than assert
  something I don't know.
- `countryCode` is derived from the URL's TLD via the existing
  `getCountryCode` helper; every item in this dataset resolves to `LT`.

## What I noticed about the data (flagging per the README)

- **Full coverage, no failures**: all 100 rows fetched and parsed
  successfully; `output/output.failures.json` is empty.
- **`sourceId`/`url` alignment**: verified 1:1 against
  `data/items.csv` for all 100 rows — no missing, extra, or mismatched
  ids.
- **Field coverage is uneven across the site**, and this looks like a
  real property of vet1.lt's product pages rather than a bug:
  - `manufacturer`, `category`, `imageUrls`: present on 100/100 items.
  - `discountPrice`: populated on 25/100 items (i.e. 25 items are
    actually on sale with a clear price pair).
  - `composition`: present on 42/100 items — many product pages
    (e.g. accessories, toys) simply don't have an ingredients section.
  - `productUse`: present on only 1/100 items — the "Naudojimas"/usage
    label almost never appears on this site in a form the labeled-value
    extractor could match; this is very likely under-extracted rather
    than genuinely absent from the pages, and would be the first thing
    I'd dig into with more time (see below).
  - `barcode`: not found on any of the 100 items — vet1.lt product
    pages don't appear to expose GTIN/EAN in JSON-LD or in an obvious
    HTML location.
- **One anomaly worth a human look**: one item
  (`Stangest CanBel universalus valiklis katėms ir šunims`) came back
  with `discountType: "sale"` but `discountPrice: "0"`. This is a single
  case out of 100, and the `additionalInformation.discountPriceSource`
  on it is `"explicit-sale-pair"`, meaning the page genuinely returned a
  visible "0" as the sale price rather than the parser inventing it.
  I'd treat this as a page-data issue (possibly a temporarily
  mispriced/out-of-stock listing) and would not trust that one record's
  price fields without a manual check of the live page.

## Bug found while running the harness

Running `yarn debug --source VT1` against the live site (not something I
could do in every environment I drafted this in) crashed before writing
any output at all:

```
Error: Variant spot-check failed with 176 error(s).
    at runVariantSpotChecks (...\src\sites\VT1\sample.ts:1154:11)
```

All 100 rows had actually scraped successfully up to that point (title,
manufacturer, category, price, etc. all came back populated, including
for the rows that ultimately "failed"). The crash came entirely from
`runVariantSpotChecks`, which is a regression check over the 15
repeated-base-URL groups (see `scripts/spot-check-variants.js` above)
that was written to `throw` on any unresolved variant — so one
unresolved variant anywhere destroyed the whole run's output. I fixed
that (see "What I did" above): the check is now advisory.

Separately from the crash, the check's findings are real and worth
flagging: of the 50 rows across the 15 repeated-URL groups, **36 rows
(across 12 of the 15 groups) did not resolve to a distinct Omnisend
variant** via their URL `#fragment` — `additionalInformation.
variantMatched: false` on those rows. Only 3 groups (`recobed-sofa-
bukla`, `outward-hound-fun-feeder`, `recobed-cave-velour`) resolved
cleanly on every row; 10 groups failed on every row in the group, and
2 groups (`scruffs-seattle`, `scruffs-expedition`) failed on half.

I could not fetch the page's raw `omnisendProductData` script content
to fully diagnose *why* (only rendered/text content was fetchable in
the environment I checked this from), so I'm flagging rather than
claiming a root cause. What I did notice: on live vet1.lt pages, other
products' "Panašios prekės" (similar products) links use option hashes
in the form `#/{numericId}-{optionSlug}-{value}` (e.g.
`#/280-kraiko_pak-38l/284-kvapas-levandu`), while the affected rows in
`data/items.csv` use the bare `#/{optionSlug}-{value}` form with no
numeric id (e.g. `#/kraiko_pak-6_kg/kvapas-aromatizuotas`). That's
consistent with the CSV having been captured before vet1.lt started
(or stopped) including an id in its combination hashes, or with the
specific option combination no longer existing on the page — either
way, the parser's value-based matching (`variantMatchScore` in
`functions.ts`, which never trusted the id, only the option text) still
came up empty on these, which means it's declining to match rather
than being fooled by the id difference.

For every row with `variantMatched: false`, `price`/`discountPrice`/
`inStock` still get populated — from the page's base offer, not from a
selected variant. On a single-variant product that's exactly right;
on a genuinely multi-variant product where price/stock differ by
option (e.g. drug dosage), that fallback could report the wrong
variant's price. I don't have a way to confirm which case applies for
each of the 36 rows without a live page-by-page check, so I'm not
claiming those prices are wrong — only flagging them as
lower-confidence and listing them in
`output/output.variant-warnings.json` for a manual review before
they're used in anything client-facing.

## AI usage and verification

I used Claude to help review the parsing logic in
`src/sites/VT1/functions.ts` (particularly the price/discount
selector logic, to make sure I wasn't scanning every `[class*="price"]`
element and picking up shipping-threshold or unit prices by accident)
and to help draft this document from the actual code and output data.

Where it helped: catching that `Offer.highPrice` in schema.org is not
safe to treat as a "was" price (it can represent the upper bound of an
`AggregateOffer` rather than a crossed-out price), which changed how I
scoped `structuredOriginalPrice`.

Where I had to correct it: an early suggestion was to fall back to any
element whose class contained `"price"` when structured data was
missing a value. I rejected that after checking a few live pages by hand
— vet1.lt's cart/shipping-threshold banners and unit-price labels also
match that pattern, and using it would have silently corrupted `price`
on pages without a clean JSON-LD offer.

How I verified: ran `scripts/validate-output.js` against the full
100-row output (record count, `sourceId`/`url` alignment, uniqueness,
required-field presence all pass). I also added
`scripts/spot-check-variants.js`, which groups `data/items.csv` by
base URL and, once `output/output.json` exists, flags any of the 15
repeated-base-URL groups whose variant-sensitive fields (price,
discountPrice, inStock, etc.) come back identical across every
variant -- the signature of variant selection collapsing onto a single
variant. I used those same 15 groups as the priority list for manual
spot-checking against the live pages, rather than a random sample of
the 100 rows, since a random sample would likely never draw two rows
from the same group and so would never exercise the fragment-matching
logic at all.

The `runVariantSpotChecks` crash-to-report fix (see "Bug found while
running the harness") was diagnosed by Claude directly from a pasted
terminal log of an actual `yarn debug --source VT1` run, not from
guessing at the code. I checked the fix by tracing the exact `errors`
array the log showed into the (unchanged) per-row logging logic, and
by running `tsc --noEmit` against the edited file with `node_modules`
absent — that only surfaces the pre-existing "missing module/`@types/
node`" noise you'd expect without an install, with zero errors on the
new code, which is a weaker check than actually running the scraper
again. I did not have network access to `npm install` or hit
`vet1.lt` from the sandbox this fix was made in, so **the fix has not
been re-run against the live site** — that's the first thing to do
before trusting it, and is why the root-cause section above says
"flagging rather than claiming" rather than asserting an explanation.

## What I'd do next with more time

- Get eyes on the raw `omnisendProductData` script contents for one of
  the fully-unresolved groups (e.g. `zverlit-kraikas-grudeliu-plotis-
  apie-4-mm`) rather than reasoning from rendered page text, to confirm
  whether the 36 unresolved variants are a genuine option-text mismatch,
  a stale CSV, or something `variantMatchScore` should be more lenient
  about. Then manually re-check a few of the affected rows' `price`/
  `inStock` against the live page to see whether the "use the base
  offer" fallback under-serves multi-variant products.
- Investigate why `productUse` is only extracted on 1/100 items —
  compare a handful of product pages that clearly display a "how to
  use" section against the current `extractLabeledValue` selectors and
  labels to see if the markup uses a pattern (e.g. an accordion/tab)
  the current DOM walk doesn't reach.
- Re-check the one `discountPrice: "0"` item manually against the live
  site and decide whether to null it out rather than ship a "0" price.
- Add a lightweight retry/backoff specifically for Cloudflare
  challenges instead of switching straight to Playwright, to reduce
  headless-browser usage (and cost/time) on transient blocks.
- Add unit tests around the price/discount decision logic
  (structured-vs-HTML precedence, the "original > current" guard) since
  that's the part most likely to silently regress.

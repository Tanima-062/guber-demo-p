/**
 * Spot-check the 15 base URLs in data/items.csv that repeat with different
 * #fragments (different variants of the same product page).
 *
 * Why this set, specifically: random sampling across 100 rows mostly tests
 * "did we parse a page at all". It won't reliably catch the one failure mode
 * that matters most here -- the omnisendProductData `variants` object is the
 * per-variant source of truth (price, stock, etc. differ per variant), and
 * if selectOmnisendVariant() ever falls back to "just take the first
 * variant" instead of matching the URL's #fragment, every row that shares a
 * base URL will silently collapse onto the *same* variant's data.
 *
 * That failure is invisible on a single-variant product (nothing to compare
 * against) and invisible on a random sample (you'd need to happen to draw
 * two rows from the same group). It is unmissable once you group by base
 * URL: rows in the same group have different titles/fragments but, if the
 * bug exists, identical price/discount/stock -- because they were fetched
 * from the same HTML page and only variant-selection should have told them
 * apart.
 *
 * This script:
 *   1. Groups data/items.csv by base URL (strips the #fragment).
 *   2. Prints the 15 multi-row groups as the priority manual-check list
 *      (open the live page once per group, not once per row).
 *   3. If output/output.json exists, cross-checks each group's records and
 *      flags any group where every variant-sensitive field is identical --
 *      i.e. the corruption pattern described above.
 */

const fs = require("fs");
const path = require("path");
const csvtojson = require("csvtojson");

const inputPath = process.env.INPUT_FILE || "data/items.csv";
const outputPath = process.env.OUTPUT_FILE || "output/output.json";

// Fields we expect a real variant to plausibly differ on. Not every field
// has to differ (e.g. two variants can legitimately share a price), but if
// ALL of them are identical across every row in a group, that's the
// signature of "same variant object reused for every fragment" rather than
// "coincidentally identical variants".
const VARIANT_SENSITIVE_FIELDS = [
  "price",
  "discountPrice",
  "inStock",
  "amountInPackage",
  "quantity",
  "form",
];

function baseUrl(url) {
  return String(url || "").split("#")[0];
}

function fieldSignature(item) {
  return VARIANT_SENSITIVE_FIELDS.map((f) => JSON.stringify(item?.[f] ?? null)).join(
    "|"
  );
}

async function main() {
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input file not found: ${inputPath}`);
  }

  const input = await csvtojson({
    delimiter: ";",
    trim: true,
    ignoreEmpty: true,
  }).fromFile(inputPath);

  const groups = new Map();
  for (const row of input) {
    const key = baseUrl(row.url);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const multiGroups = [...groups.entries()].filter(([, rows]) => rows.length > 1);

  console.log("==============================");
  console.log("VARIANT SPOT-CHECK -- repeated base URLs");
  console.log("==============================");
  console.log(
    `${multiGroups.length} base URLs repeat across ${multiGroups.reduce(
      (n, [, rows]) => n + rows.length,
      0
    )} rows (out of ${input.length} total rows).\n`
  );

  console.log("Priority manual-check list (one live-page visit per group):\n");
  for (const [url, rows] of multiGroups) {
    console.log(`- ${url}  (${rows.length} variants)`);
    for (const row of rows) {
      const fragment = row.url.includes("#") ? row.url.split("#")[1] : "(no fragment)";
      console.log(`    · ${fragment}  ->  ${row.title}  [${row.source_id}]`);
    }
  }

  if (!fs.existsSync(outputPath)) {
    console.log(
      `\nNo ${outputPath} yet -- run the scraper first, then re-run this ` +
        `script to cross-check the scraped data for the collapsed-variant bug.`
    );
    return;
  }

  const output = JSON.parse(fs.readFileSync(outputPath, "utf8"));
  const bySourceId = new Map(output.map((item) => [item.sourceId, item]));

  console.log("\n==============================");
  console.log("CROSS-CHECK against output");
  console.log("==============================\n");

  let suspect = 0;
  for (const [url, rows] of multiGroups) {
    const items = rows.map((r) => bySourceId.get(r.source_id));
    const missing = rows.filter((r) => !bySourceId.get(r.source_id));

    if (missing.length > 0) {
      console.log(
        `? ${url}: ${missing.length}/${rows.length} rows missing from output -- skipping`
      );
      continue;
    }

    const signatures = new Set(items.map(fieldSignature));

    if (signatures.size === 1 && rows.length > 1) {
      suspect += 1;
      console.log(
        `!! ${url}: all ${rows.length} variants have identical ` +
          `${VARIANT_SENSITIVE_FIELDS.join("/")} -- looks like variant ` +
          `selection collapsed onto one variant. Verify against the live page.`
      );
      for (const item of items) {
        console.log(
          `     [${item.sourceId}] price=${item.price} discountPrice=${item.discountPrice} inStock=${item.inStock}`
        );
      }
    } else {
      console.log(`ok ${url}: ${signatures.size} distinct variant signature(s) across ${rows.length} rows`);
    }
  }

  console.log(
    `\n${suspect} of ${multiGroups.length} groups flagged as suspect.` +
      (suspect > 0
        ? " Manually re-check these against the live site before trusting the output."
        : "")
  );
}

main().catch((error) => {
  console.error("\nSPOT-CHECK FAILED");
  console.error(error.message || String(error));
  process.exitCode = 1;
});

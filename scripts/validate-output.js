const fs = require("fs");
const path = require("path");
const csvtojson = require("csvtojson");

const inputPath = process.env.INPUT_FILE || "data/items.csv";
const outputPath = process.env.OUTPUT_FILE || "output/output.json";

async function main() {
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input file not found: ${inputPath}`);
  }
  if (!fs.existsSync(outputPath)) {
    throw new Error(`Output file not found: ${outputPath}`);
  }

  const input = await csvtojson({
    delimiter: ";",
    trim: true,
    ignoreEmpty: true,
  }).fromFile(inputPath);

  const output = JSON.parse(fs.readFileSync(outputPath, "utf8"));

  if (!Array.isArray(output)) {
    throw new Error("Output JSON must be an array");
  }

  if (input.length !== 100) {
    throw new Error(`Expected 100 input records, found ${input.length}`);
  }

  if (output.length !== input.length) {
    throw new Error(
      `Expected ${input.length} output records, found ${output.length}`
    );
  }

  const sourceIds = new Set();
  let successful = 0;
  let failed = 0;

  for (let i = 0; i < input.length; i++) {
    const row = input[i];
    const item = output[i];

    if (!item || typeof item !== "object") {
      throw new Error(`Output record ${i + 1} is not an object`);
    }

    if (item.sourceId !== row.source_id) {
      throw new Error(
        `sourceId mismatch at row ${i + 1}: expected ${row.source_id}, got ${item.sourceId}`
      );
    }

    if (item.url !== row.url) {
      throw new Error(
        `URL mismatch at row ${i + 1}: expected ${row.url}, got ${item.url}`
      );
    }

    if (sourceIds.has(item.sourceId)) {
      throw new Error(`Duplicate sourceId at row ${i + 1}: ${item.sourceId}`);
    }
    sourceIds.add(item.sourceId);

    const required = [
      "title",
      "manufacturer",
      "price",
      "inStock",
      "category",
      "url",
      "sourceId",
    ];

    for (const field of required) {
      if (!(field in item)) {
        throw new Error(`Missing required field '${field}' at row ${i + 1}`);
      }
    }

    const status = item.meta?.scrapeStatus;
    if (status === "success") successful++;
    else if (status === "failed") failed++;
    else throw new Error(`Invalid scrapeStatus at row ${i + 1}`);
  }

  console.log("\n==============================");
  console.log("OUTPUT VALIDATION");
  console.log("==============================");
  console.log(`VALID: ${output.length} records`);
  console.log(`Successful scrapes: ${successful}`);
  console.log(`Failed scrapes: ${failed}`);
  console.log("sourceId/url alignment verified.");
  console.log("Unique sourceIds verified.");
}

main().catch((error) => {
  console.error("\nVALIDATION FAILED");
  console.error(error.message || String(error));
  process.exitCode = 1;
});

import "dotenv/config";

import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import { functions } from "./sites";
import { CommonInterface } from "./sites/interfaces";
import { warningMessage } from "./utils";

function getSourceFunction(source: string): CommonInterface {
  const SourceClass = (functions as any)[source];

  if (!SourceClass) {
    throw new Error(`No functions for source ${source}`);
  }

  return new SourceClass();
}

async function main(): Promise<void> {
  const argv = await yargs(hideBin(process.argv))
    .option("source", {
      type: "string",
      default: "VT1",
      describe: "Source to scrape",
    })
    .option("activity", {
      type: "string",
      default: "testing",
      describe: "Activity to execute",
    })
    .strict(false)
    .parse();

  const source = String(argv.source);
  const activity = String(argv.activity);

  console.log("");
  console.log("================================");
  console.log("GUBER SCRAPER");
  console.log("================================");

  console.log(`Source: ${source}`);
  console.log(`Activity: ${activity}`);

  console.log(
    `Proxy enabled: ${
      String(process.env.PROXY_ENABLED || "false").toLowerCase() ===
      "true"
    }`
  );

  if (
    String(process.env.PROXY_ENABLED || "false").toLowerCase() === "true"
  ) {
    console.log(
      `Proxy: ${process.env.PROXY_HOST || "brd.superproxy.io"}:${
        process.env.PROXY_PORT || "44445"
      }`
    );
  }

  console.log("================================");
  console.log("");

  if (activity !== "testing") {
    warningMessage("Only 'testing' activity is supported");
    process.exitCode = 1;
    return;
  }

  const sourceFunctions = getSourceFunction(source);

  if (!sourceFunctions.testing) {
    warningMessage(
      `Source ${source} does not have a testing function.`
    );

    process.exitCode = 1;
    return;
  }

  await sourceFunctions.testing();
}

main().catch((error: unknown) => {
  console.error("");
  console.error("SCRAPER ERROR");

  if (error instanceof Error) {
    console.error(error.message);

    if (error.stack) {
      console.error(error.stack);
    }
  } else {
    console.error(String(error));
  }

  process.exitCode = 1;
});
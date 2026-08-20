import axios, {
  AxiosProxyConfig,
} from "axios";

import csvtojson from "csvtojson";

import {
  chromium,
  Browser,
} from "playwright";

import { VT1Functions } from "./functions";

import {
  jsonToFile,
  sleep,
  stringToHash,
} from "../../utils";

import fs from "fs";

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

const REQUEST_DELAY_MS = Number(
  process.env.REQUEST_DELAY_MS || 1500
);

const REQUEST_TIMEOUT_MS = Number(
  process.env.REQUEST_TIMEOUT_MS || 30000
);

const MAX_RETRIES = Number(
  process.env.MAX_RETRIES || 2
);

const USE_BROWSER_ON_403 =
  String(
    process.env.USE_BROWSER_ON_403 ||
      "true"
  ).toLowerCase() === "true";

const EXPECTED_INPUT_COUNT =
  Number(
    process.env.EXPECTED_INPUT_COUNT ||
      100
  );

/*
 * Number of repeated-base-url groups to use for
 * the variant regression suite.
 *
 * The CSV is expected to contain around 15 repeated
 * product URLs. We test those groups rather than
 * randomly sampling arbitrary rows.
 */
const VARIANT_SPOT_CHECK_GROUPS =
  Number(
    process.env.VARIANT_SPOT_CHECK_GROUPS ||
      15
  );

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

type InputItem = {
  title: string;
  url: string;
  source_id: string;
};

type FetchResult = {
  html: string;
  method:
    | "axios"
    | "playwright";
  status: number;
};

type VariantInformation = {
  variantIdentity?: string;
  variantMatched?: boolean;
  variantCount?: number;
  variantMatchScore?: number;
  variantHash?: string;
  variantRequested?: boolean;
  omnisendVariantObject?: unknown;

  [key: string]: unknown;
};

/* -------------------------------------------------------------------------- */
/* Environment                                                                */
/* -------------------------------------------------------------------------- */

function envBool(
  name: string,
  fallback = false
): boolean {
  const value =
    process.env[name];

  if (value === undefined) {
    return fallback;
  }

  return [
    "1",
    "true",
    "yes",
    "on",
  ].includes(
    value.toLowerCase()
  );
}

/* -------------------------------------------------------------------------- */
/* Proxy                                                                      */
/* -------------------------------------------------------------------------- */

function getProxy():
  | AxiosProxyConfig
  | undefined {
  if (
    !envBool(
      "PROXY_ENABLED",
      false
    )
  ) {
    return undefined;
  }

  const host =
    process.env.PROXY_HOST;

  const port = Number(
    process.env.PROXY_PORT || 0
  );

  const username =
    process.env.PROXY_USERNAME;

  const password =
    process.env.PROXY_PASSWORD;

  if (
    !host ||
    !port ||
    !username ||
    !password
  ) {
    throw new Error(
      "PROXY_ENABLED=true but PROXY_HOST, PROXY_PORT, PROXY_USERNAME and PROXY_PASSWORD are not configured"
    );
  }

  return {
    protocol: "http",
    host,
    port,

    auth: {
      username,
      password,
    },
  };
}

function getPlaywrightProxy():
  | {
      server: string;
      username: string;
      password: string;
    }
  | undefined {
  if (
    !envBool(
      "PROXY_ENABLED",
      false
    )
  ) {
    return undefined;
  }

  const host =
    process.env.PROXY_HOST;

  const port = Number(
    process.env.PROXY_PORT || 0
  );

  const username =
    process.env.PROXY_USERNAME;

  const password =
    process.env.PROXY_PASSWORD;

  if (
    !host ||
    !port ||
    !username ||
    !password
  ) {
    throw new Error(
      "PROXY_ENABLED=true but proxy configuration is incomplete"
    );
  }

  return {
    server:
      `http://${host}:${port}`,

    username,
    password,
  };
}

/* -------------------------------------------------------------------------- */
/* HTTP helpers                                                               */
/* -------------------------------------------------------------------------- */

function isBlockedStatus(
  status?: number
): boolean {
  return (
    status === 403 ||
    status === 429 ||
    status === 503
  );
}

function isCloudflareBlockPage(
  html: string
): boolean {
  const lower =
    html.toLowerCase();

  return (
    lower.includes(
      "attention required! | cloudflare"
    ) ||
    lower.includes(
      "you are unable to access"
    ) ||
    lower.includes(
      "sorry, you have been blocked"
    ) ||
    lower.includes(
      "cf-error-details"
    )
  );
}

/* -------------------------------------------------------------------------- */
/* CSV normalization                                                          */
/* -------------------------------------------------------------------------- */

function normalizeKey(
  key: string
): string {
  return String(key || "")
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function normalizeInputRow(
  row: Record<string, any>
): InputItem {
  const normalized: Record<
    string,
    any
  > = {};

  for (const [
    key,
    value,
  ] of Object.entries(row)) {
    normalized[
      normalizeKey(key)
    ] = value;
  }

  return {
    title: String(
      normalized.title ??
        normalized.name ??
        ""
    ).trim(),

    url: String(
      normalized.url ??
        normalized.product_url ??
        normalized.producturl ??
        ""
    ).trim(),

    source_id: String(
      normalized.source_id ??
        normalized.sourceid ??
        normalized.id ??
        ""
    ).trim(),
  };
}

/* -------------------------------------------------------------------------- */
/* Axios                                                                      */
/* -------------------------------------------------------------------------- */

async function fetchWithAxios(
  url: string,
  headers: Record<string, string>
): Promise<FetchResult> {
  let lastError: any;

  const proxy =
    getProxy();

  for (
    let attempt = 1;
    attempt <= MAX_RETRIES;
    attempt++
  ) {
    try {
      console.log(
        `  Axios attempt ${attempt}/${MAX_RETRIES}`
      );

      const response =
        await axios.get<string>(
          url,
          {
            headers,

            timeout:
              REQUEST_TIMEOUT_MS,

            maxRedirects: 5,

            responseType:
              "text",

            validateStatus:
              () => true,

            proxy,
          }
        );

      console.log(
        `  Axios HTTP ${response.status}`
      );

      if (
        response.status >= 200 &&
        response.status < 400 &&
        typeof response.data ===
          "string" &&
        response.data.trim()
      ) {
        if (
          isCloudflareBlockPage(
            response.data
          )
        ) {
          const error: any =
            new Error(
              `Cloudflare block page returned with HTTP ${response.status}`
            );

          error.status =
            response.status;

          lastError = error;
        } else {
          return {
            html: response.data,

            method:
              "axios",

            status:
              response.status,
          };
        }
      } else {
        const error: any =
          new Error(
            `HTTP ${response.status}`
          );

        error.status =
          response.status;

        lastError = error;
      }
    } catch (error: any) {
      lastError = error;

      console.log(
        `  Axios error: ${
          error?.message ||
          String(error)
        }`
      );
    }

    if (
      attempt <
      MAX_RETRIES
    ) {
      await sleep(
        1000 * attempt
      );
    }
  }

  throw (
    lastError ||
    new Error(
      "Axios request failed"
    )
  );
}

/* -------------------------------------------------------------------------- */
/* Playwright                                                                 */
/* -------------------------------------------------------------------------- */

async function fetchWithPlaywright(
  url: string,
  headers: Record<string, string>,
  browser: Browser
): Promise<FetchResult> {
  const proxy =
    getPlaywrightProxy();

  const context =
    await browser.newContext({
      viewport: {
        width: 1366,
        height: 768,
      },

      userAgent:
        headers["User-Agent"],

      locale: "lt-LT",

      extraHTTPHeaders: {
        Accept:
          headers.Accept,

        "Accept-Language":
          headers[
            "Accept-Language"
          ],

        Referer:
          headers.Referer,
      },
    });

  const page =
    await context.newPage();

  try {
    console.log(
      "  Opening with Playwright..."
    );

    const response =
      await page.goto(
        url,
        {
          waitUntil:
            "domcontentloaded",

          timeout:
            REQUEST_TIMEOUT_MS,
        }
      );

    const status =
      response?.status() ?? 0;

    console.log(
      `  Playwright HTTP ${status}`
    );

    await page
      .waitForLoadState(
        "networkidle",
        {
          timeout: 10000,
        }
      )
      .catch(
        () => undefined
      );

    const html =
      await page.content();

    if (status >= 400) {
      const error: any =
        new Error(
          `Playwright HTTP ${status}`
        );

      error.status =
        status;

      throw error;
    }

    if (
      isCloudflareBlockPage(
        html
      )
    ) {
      const error: any =
        new Error(
          "Playwright received a Cloudflare block page"
        );

      error.status =
        status;

      throw error;
    }

    if (!html.trim()) {
      throw new Error(
        "Empty HTML returned by Playwright"
      );
    }

    return {
      html,

      method:
        "playwright",

      status,
    };
  } finally {
    await context.close();
  }
}

/* -------------------------------------------------------------------------- */
/* Fetch strategy                                                             */
/* -------------------------------------------------------------------------- */

async function fetchHtml(
  url: string,
  headers: Record<string, string>,
  browser: Browser
): Promise<FetchResult> {
  try {
    return await fetchWithAxios(
      url,
      headers
    );
  } catch (error: any) {
    const status =
      error?.status ||
      error?.response?.status;

    if (
      !USE_BROWSER_ON_403 ||
      !isBlockedStatus(status)
    ) {
      throw error;
    }

    console.log(
      `  HTTP ${status}; switching to Playwright`
    );

    return fetchWithPlaywright(
      url,
      headers,
      browser
    );
  }
}

/* -------------------------------------------------------------------------- */
/* URL helpers                                                                */
/* -------------------------------------------------------------------------- */

function getBaseProductUrl(
  url: string
): string {
  try {
    const parsed =
      new URL(url);

    parsed.hash = "";

    return parsed.toString();
  } catch {
    return String(url || "")
      .split("#")[0];
  }
}

function getVariantHash(
  url: string
): string {
  try {
    return decodeURIComponent(
      new URL(url).hash.replace(
        /^#/,
        ""
      )
    ).trim();
  } catch {
    try {
      return decodeURIComponent(
        String(url || "")
          .split("#")[1] ||
          ""
      ).trim();
    } catch {
      return (
        String(url || "")
          .split("#")[1] ||
        ""
      ).trim();
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Result helpers                                                             */
/* -------------------------------------------------------------------------- */

function getVariantInformation(
  additionalInformation: unknown
): VariantInformation {
  if (
    additionalInformation &&
    typeof additionalInformation ===
      "object"
  ) {
    return additionalInformation as VariantInformation;
  }

  return {};
}

function createFailedResult(
  input: InputItem,
  errorMessage: string
): any {
  const now =
    new Date().toISOString();

  return {
    added: now,

    title:
      input.title,

    manufacturer: "",

    price: "",

    discountPrice:
      undefined,

    discountType: "",

    productUse: "",

    composition: "",

    description: "",

    inStock: false,

    category: "",

    url:
      input.url,

    sourceId:
      input.source_id,

    countryCode: "LT",

    quantityLeft: {},

    imageUrls: [],

    barcode:
      undefined,

    source:
      "vet1.lt",

    additionalInformation: {
      source:
        "vet1.lt",

      parser:
        "omnisend-variant-first",

      scrapeStatus:
        "failed",

      inStockKnown:
        false,

      variantRequested:
        Boolean(
          getVariantHash(
            input.url
          )
        ),

      variantMatched:
        false,

      variantCount:
        0,

      error:
        errorMessage,
    },

    meta: {
      inputTitle:
        input.title,

      scrapedAt:
        now,

      scrapeStatus:
        "failed",

      inStockKnown:
        false,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Variant regression suite                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Find repeated base URLs.
 *
 * Example:
 *
 * https://vet1.lt/product-a#red
 * https://vet1.lt/product-a#blue
 * https://vet1.lt/product-a#large
 *
 * These rows represent one product with multiple variant selections.
 */
function buildRepeatedUrlGroups(
  items: InputItem[]
): Map<string, number[]> {
  const groups =
    new Map<
      string,
      number[]
    >();

  items.forEach(
    (item, index) => {
      const base =
        getBaseProductUrl(
          item.url
        );

      const indexes =
        groups.get(base) ||
        [];

      indexes.push(index);

      groups.set(
        base,
        indexes
      );
    }
  );

  return groups;
}

/**
 * Select the first N repeated groups.
 *
 * This is deterministic and structure-aware.
 *
 * We deliberately do NOT use random sampling because random rows
 * could select multiple unrelated products and miss the actual
 * variant regression structure.
 */
function selectVariantSpotCheckGroups(
  items: InputItem[]
): Array<
  [string, number[]]
> {
  const groups =
    buildRepeatedUrlGroups(
      items
    );

  return [
    ...groups.entries(),
  ]
    .filter(
      ([, indexes]) =>
        indexes.length > 1
    )
    .sort(
      (a, b) =>
        a[1][0] -
        b[1][0]
    )
    .slice(
      0,
      VARIANT_SPOT_CHECK_GROUPS
    );
}

type VariantSpotCheckReport = {
  groups: number;
  errors: string[];
};

/**
 * Run the variant regression checks and return a report.
 *
 * IMPORTANT: this used to `throw` on any error, which discarded the
 * entire 100-row output (including successfully-scraped rows with no
 * variant issue at all) whenever even a single repeated-base-URL group
 * didn't cleanly resolve. That is the wrong failure mode for this task:
 * per the README, the job is to collect trustworthy data and *flag*
 * anything that looks off, not to produce zero output because part of
 * the input turned out to be stale (a URL #fragment from when
 * data/items.csv was captured that no longer matches a live Omnisend
 * variant, because vet1.lt's own option combinations changed since).
 *
 * This function now always returns a report instead of throwing. The
 * caller persists output/output.json unconditionally and writes any
 * variant warnings to a separate file for a human to review, rather
 * than silently corrupting data OR discarding a good scrape over a
 * small number of unresolved variants.
 */
function runVariantSpotChecks(
  items: InputItem[],
  results: any[]
): VariantSpotCheckReport {
  const repeatedGroups =
    selectVariantSpotCheckGroups(
      items
    );

  console.log(
    "\n================================"
  );

  console.log(
    "VARIANT SPOT-CHECKS"
  );

  console.log(
    `Expected groups: ${VARIANT_SPOT_CHECK_GROUPS}`
  );

  console.log(
    `Selected repeated groups: ${repeatedGroups.length}`
  );

  console.log(
    "================================"
  );

  const errors: string[] =
    [];

  if (repeatedGroups.length < VARIANT_SPOT_CHECK_GROUPS) {
    errors.push(
      `expected at least ${VARIANT_SPOT_CHECK_GROUPS} repeated base-URL groups, found ${repeatedGroups.length}`
    );
  }

  for (
    const [
      baseUrl,
      indexes,
    ] of repeatedGroups
  ) {
    console.log(
      `\nProduct group: ${baseUrl}`
    );

    const requestedHashes: string[] =
      [];

    const identities: string[] =
      [];

    const scores: number[] =
      [];

    let groupHasVariantData =
      false;

    for (
      const index of indexes
    ) {
      const input =
        items[index];

      const result =
        results[index];

      const expectedHash =
        getVariantHash(
          input.url
        );

      const info =
        getVariantInformation(
          result?.additionalInformation
        );

      const matched =
        Boolean(
          info.variantMatched
        );

      const identity =
        String(
          info.variantIdentity ||
            ""
        ).trim();

      const variantCount =
        Number(
          info.variantCount ||
            0
        );

      const score =
        Number(
          info.variantMatchScore ||
            0
        );

      const failed =
        result?.meta
          ?.scrapeStatus ===
        "failed";

      console.log(
        `  row ${index + 1}: ` +
          `${input.title} | ` +
          `hash=#${expectedHash || "(none)"} | ` +
          `matched=${matched} | ` +
          `identity=${identity || "(none)"} | ` +
          `variants=${variantCount} | ` +
          `score=${score}`
      );

      /* -------------------------------------------------------------- */
      /* Input must actually request a variant.                        */
      /* -------------------------------------------------------------- */

      if (!expectedHash) {
        errors.push(
          `row ${index + 1}: repeated product row has no #variant hash`
        );

        continue;
      }

      requestedHashes.push(
        expectedHash.toLowerCase()
      );

      /* -------------------------------------------------------------- */
      /* Scrape itself must have succeeded.                             */
      /* -------------------------------------------------------------- */

      if (failed) {
        errors.push(
          `row ${index + 1}: scrape failed; variant result cannot be trusted`
        );

        continue;
      }

      /* -------------------------------------------------------------- */
      /* Must expose Omnisend variants.                                 */
      /* -------------------------------------------------------------- */

      if (variantCount < 2) {
        errors.push(
          `row ${index + 1}: expected multiple Omnisend variants, got ${variantCount}`
        );
      } else {
        groupHasVariantData =
          true;
      }

      /* -------------------------------------------------------------- */
      /* The URL-specific variant must have matched.                    */
      /* -------------------------------------------------------------- */

      if (!matched) {
        errors.push(
          `row ${index + 1}: "${input.title}" did not resolve its #${expectedHash} URL to an Omnisend variant`
        );
      }

      /* -------------------------------------------------------------- */
      /* Selected variant needs an identity.                            */
      /* -------------------------------------------------------------- */

      if (!identity) {
        errors.push(
          `row ${index + 1}: "${input.title}" has no selected variant identity`
        );
      } else {
        identities.push(
          identity
        );
      }

      /* -------------------------------------------------------------- */
      /* A valid match should have a positive score.                    */
      /* -------------------------------------------------------------- */

      if (
        matched &&
        score <= 0
      ) {
        errors.push(
          `row ${index + 1}: variantMatched=true but variantMatchScore=${score}`
        );
      }

      scores.push(score);
    }

    /* ---------------------------------------------------------------- */
    /* Group-level regression checks                                    */
    /* ---------------------------------------------------------------- */

    const uniqueHashes =
      new Set(
        requestedHashes
      );

    const uniqueIdentities =
      new Set(
        identities.map(
          (value) =>
            value.toLowerCase()
        )
      );

    /*
     * A repeated-base-url group is intentionally constructed from rows
     * that point at the same product but request different URL variants.
     *
     * Therefore, when the source exposes multiple variants, every
     * distinct requested hash must resolve to the exact requested
     * variant. We fail closed here: partial token matches, duplicate
     * identities, or missing variant hashes are not acceptable.
     */
    if (uniqueHashes.size > 1) {
      if (identities.length !== requestedHashes.length) {
        errors.push(
          `${baseUrl}: only ${identities.length}/${requestedHashes.length} requested variants produced a selected identity`
        );
      }

      if (uniqueIdentities.size !== uniqueHashes.size) {
        errors.push(
          `${baseUrl}: ${uniqueHashes.size} distinct variant hashes resolved to ${uniqueIdentities.size} distinct variant identities`
        );
      }
    }

    /*
     * Every successful row must have a variant identity that is tied
     * to the requested URL hash. The parser must never silently select
     * another variant and report it as a successful match.
     */
    for (const index of indexes) {
      const input = items[index];
      const result = results[index];
      const expectedHash = getVariantHash(input.url);
      const info = getVariantInformation(
        result?.additionalInformation
      );

      if (
        expectedHash &&
        result?.meta?.scrapeStatus === "success" &&
        !info.variantMatched
      ) {
        errors.push(
          `row ${index + 1}: requested #${expectedHash} but variantMatched=false`
        );
      }

      if (
        expectedHash &&
        result?.meta?.scrapeStatus === "success" &&
        !info.variantIdentity
      ) {
        errors.push(
          `row ${index + 1}: requested #${expectedHash} but no variantIdentity was returned`
        );
      }
    }

    /*
     * We should not accept a group where every row silently failed.
     */
    if (
      indexes.length > 0 &&
      !groupHasVariantData
    ) {
      errors.push(
        `${baseUrl}: no row exposed usable Omnisend variant data`
      );
    }

    /*
     * A repeated group with multiple different hashes should normally
     * have more than one selected identity.
     *
     * We don't require a 1:1 hash-to-identity mapping because some
     * ecommerce sites can expose aliases, but complete collapse is
     * definitely suspicious.
     */
    if (
      uniqueHashes.size >= 3 &&
      uniqueIdentities.size < 2
    ) {
      errors.push(
        `${baseUrl}: ${uniqueHashes.size} variant selections produced fewer than 2 identities`
      );
    }
  }

  if (errors.length) {
    console.error(
      "\nVARIANT SPOT-CHECK: ISSUES FOUND (see output/output.variant-warnings.json)"
    );

    for (
      const error of errors
    ) {
      console.error(
        `  - ${error}`
      );
    }
  } else {
    console.log(
      `\nPASS: ${repeatedGroups.length} repeated-base-URL groups passed the variant regression suite.`
    );
  }

  return {
    groups: repeatedGroups.length,
    errors,
  };
}

/* -------------------------------------------------------------------------- */
/* Test runner                                                                */
/* -------------------------------------------------------------------------- */

export class VT1Testing {
  sourceFunctions:
    VT1Functions;

  constructor(
    autoLaunch = true
  ) {
    this.sourceFunctions =
      new VT1Functions();

    if (autoLaunch) {
      void this.startTests();
    }
  }

  async startTests() {
    await this.scrapeItems();
  }

  async scrapeItems() {
    const inputPath =
      process.env.INPUT_FILE ||
      "data/items.csv";

    const outputPath =
      process.env.OUTPUT_FILE ||
      "output/output.json";

    const failurePath =
      process.env.FAILURE_FILE ||
      "output/output.failures.json";

    console.log(
      "\n================================"
    );

    console.log(
      "VT1 SCRAPER"
    );

    console.log(
      `Input: ${inputPath}`
    );

    console.log(
      `Delay: ${REQUEST_DELAY_MS}ms`
    );

    console.log(
      `Timeout: ${REQUEST_TIMEOUT_MS}ms`
    );

    console.log(
      `Retries: ${MAX_RETRIES}`
    );

    console.log(
      `Proxy enabled: ${envBool(
        "PROXY_ENABLED",
        false
      )}`
    );

    console.log(
      `Expected input: ${EXPECTED_INPUT_COUNT}`
    );

    console.log(
      `Variant spot-check groups: ${VARIANT_SPOT_CHECK_GROUPS}`
    );

    console.log(
      "================================"
    );

    /* -------------------------------------------------------------------- */
    /* Input                                                                 */
    /* -------------------------------------------------------------------- */

    if (
      !fs.existsSync(
        inputPath
      )
    ) {
      throw new Error(
        `Input file not found: ${inputPath}`
      );
    }

    const rawItems =
      await csvtojson({
        delimiter: ";",

        trim: true,

        ignoreEmpty: true,
      }).fromFile(
        inputPath
      );

    console.log(
      `CSV rows read: ${rawItems.length}`
    );

    const items =
      rawItems.map(
        (row) =>
          normalizeInputRow(
            row as Record<
              string,
              any
            >
          )
      );

    if (
      items.length !==
      EXPECTED_INPUT_COUNT
    ) {
      throw new Error(
        `Expected ${EXPECTED_INPUT_COUNT} items, found ${items.length}`
      );
    }

    console.log(
      "\nFirst normalized row:"
    );

    console.log(
      JSON.stringify(
        items[0],
        null,
        2
      )
    );

    /* -------------------------------------------------------------------- */
    /* Input structure diagnostics                                          */
    /* -------------------------------------------------------------------- */

    const allGroups =
      buildRepeatedUrlGroups(
        items
      );

    const repeatedGroups =
      [
        ...allGroups.entries(),
      ].filter(
        ([, indexes]) =>
          indexes.length > 1
      );

    console.log(
      "\n================================"
    );

    console.log(
      "INPUT STRUCTURE"
    );

    console.log(
      `Total rows: ${items.length}`
    );

    console.log(
      `Unique base URLs: ${allGroups.size}`
    );

    console.log(
      `Repeated base URLs: ${repeatedGroups.length}`
    );

    console.log(
      "================================"
    );

    for (
      const [
        base,
        indexes,
      ] of repeatedGroups
    ) {
      const hashes =
        indexes.map(
          (index) =>
            getVariantHash(
              items[index].url
            )
        );

      console.log(
        `  ${base}`
      );

      console.log(
        `    rows=${indexes.length}`
      );

      console.log(
        `    variants=${hashes.join(
          ", "
        )}`
      );
    }

    if (
      repeatedGroups.length ===
      0
    ) {
      throw new Error(
        "Input structure check failed: no repeated base URLs were found."
      );
    }

    /* -------------------------------------------------------------------- */
    /* Scraping                                                              */
    /* -------------------------------------------------------------------- */

    const results: any[] =
      [];

    const failures: any[] =
      [];

    const browser =
      await chromium.launch({
        headless: true,

        proxy:
          getPlaywrightProxy(),
      });

    try {
      for (
        let index = 0;
        index < items.length;
        index++
      ) {
        const input =
          items[index];

        console.log(
          "\n================================"
        );

        console.log(
          `[${index + 1}/${items.length}] ${input.title}`
        );

        console.log(
          input.url
        );

        /* -------------------------------------------------------------- */
        /* Validate input                                                  */
        /* -------------------------------------------------------------- */

        if (
          !input.title ||
          !input.url ||
          !input.source_id
        ) {
          const errorMessage =
            "Invalid CSV row: title, url and source_id are required";

          console.error(
            `  FAILED: ${errorMessage}`
          );

          const failed =
            createFailedResult(
              input,
              errorMessage
            );

          failed.meta = {
            ...failed.meta,

            inputIndex:
              index + 1,

            expectedVariantHash:
              getVariantHash(
                input.url
              ),
          };

          results.push(
            failed
          );

          failures.push({
            index:
              index + 1,

            title:
              input.title,

            url:
              input.url,

            sourceId:
              input.source_id,

            error:
              errorMessage,
          });

          if (
            index <
            items.length - 1
          ) {
            await sleep(
              REQUEST_DELAY_MS
            );
          }

          continue;
        }

        /* -------------------------------------------------------------- */
        /* Source ID                                                        */
        /* -------------------------------------------------------------- */

        const generatedId =
          stringToHash(
            input.url
          );

        if (
          generatedId !==
          input.source_id
        ) {
          console.warn(
            "  WARNING: source_id does not match URL hash"
          );

          console.warn(
            `  CSV source_id: ${input.source_id}`
          );

          console.warn(
            `  Generated ID: ${generatedId}`
          );
        }

        /* -------------------------------------------------------------- */
        /* Fetch + scrape                                                   */
        /* -------------------------------------------------------------- */

        try {
          const fetched =
            await fetchHtml(
              input.url,

              this.sourceFunctions
                .headers,

              browser
            );

          const cheerio =
            await import(
              "cheerio"
            );

          const $ =
            cheerio.load(
              fetched.html
            );

          const result =
            this.sourceFunctions
              .scrapePharmacyItem(
                $,

                input.url,

                {
                  title:
                    input.title,

                  source_id:
                    input.source_id,
                }
              );

          /*
           * CSV/database identity is authoritative.
           */
          result.sourceId =
            input.source_id;

          result.url =
            input.url;

          const variantInfo =
            getVariantInformation(
              result.additionalInformation
            );

          result.meta = {
            ...(
              typeof result.meta ===
                "object"
                ? result.meta
                : {}
            ),

            inputTitle:
              input.title,

            inputIndex:
              index + 1,

            expectedVariantHash:
              getVariantHash(
                input.url
              ),

            scrapedAt:
              new Date().toISOString(),

            scrapeStatus:
              "success",

            fetchMethod:
              fetched.method,

            httpStatus:
              fetched.status,

            variantIdentity:
              variantInfo.variantIdentity,

            variantMatched:
              variantInfo.variantMatched,

            variantCount:
              variantInfo.variantCount,

            variantMatchScore:
              variantInfo.variantMatchScore,
          };

          results.push(
            result
          );

          console.log(
            `  SUCCESS: ${fetched.method}`
          );

          console.log(
            `  title: ${
              result.title ||
              "(empty)"
            }`
          );

          console.log(
            `  manufacturer: ${
              result.manufacturer ||
              "(empty)"
            }`
          );

          console.log(
            `  category: ${
              result.category ||
              "(empty)"
            }`
          );

          console.log(
            `  price: ${
              result.price ||
              "(empty)"
            }`
          );

          console.log(
            `  discountPrice: ${
              result.discountPrice ||
              "(none)"
            }`
          );

          console.log(
            `  inStock: ${
              result.inStock
            }`
          );

          console.log(
            `  variant: ${
              variantInfo.variantIdentity ||
              "(none)"
            }`
          );

          console.log(
            `  variantMatched: ${
              Boolean(
                variantInfo.variantMatched
              )
            }`
          );

          console.log(
            `  variantCount: ${
              variantInfo.variantCount ??
              0
            }`
          );

          console.log(
            `  variantScore: ${
              variantInfo.variantMatchScore ??
              0
            }`
          );

          console.log(
            `  variantHash: ${
              variantInfo.variantHash ||
              "(none)"
            }`
          );
        } catch (error: any) {
          const errorMessage =
            error?.message ||
            String(error);

          console.error(
            `  FAILED: ${errorMessage}`
          );

          failures.push({
            index:
              index + 1,

            title:
              input.title,

            url:
              input.url,

            sourceId:
              input.source_id,

            error:
              errorMessage,
          });

          results.push(
            createFailedResult(
              input,
              errorMessage
            )
          );
        }

        /* -------------------------------------------------------------- */
        /* Delay                                                            */
        /* -------------------------------------------------------------- */

        if (
          index <
          items.length - 1
        ) {
          console.log(
            `  Waiting ${REQUEST_DELAY_MS}ms...`
          );

          await sleep(
            REQUEST_DELAY_MS
          );
        }
      }
    } finally {
      await browser.close();
    }

    /* -------------------------------------------------------------------- */
    /* Persist outputs                                                       */
    /* -------------------------------------------------------------------- */

    // Persist the scrape unconditionally. A row's own scrapeStatus/
    // additionalInformation already say whether ITS variant matched;
    // that is the per-row signal to trust, not a pass/fail gate on the
    // whole batch (see runVariantSpotChecks below).
    jsonToFile(
      results,
      outputPath,
      true
    );

    jsonToFile(
      failures,
      failurePath,
      true
    );

    /* -------------------------------------------------------------------- */
    /* Regression suite (advisory, non-fatal)                               */
    /* -------------------------------------------------------------------- */

    const variantWarningsPath =
      process.env.VARIANT_WARNINGS_FILE ||
      "output/output.variant-warnings.json";

    const variantReport =
      runVariantSpotChecks(
        items,
        results
      );

    if (variantReport.errors.length) {
      jsonToFile(
        variantReport,
        variantWarningsPath,
        true
      );

      console.log(
        `\n${variantReport.errors.length} variant warning(s) written to ${variantWarningsPath}. ` +
          `Output was still written to ${outputPath} -- affected rows are the ones with ` +
          `additionalInformation.variantMatched: false and should be manually checked against ` +
          `the live page before trusting their price/stock.`
      );

      // Signal that this run needs a human look without discarding the
      // 100-row output: a non-zero exit code still fails a CI step, but
      // (unlike the old `throw`) it does so *after* output/output.json
      // and output/output.failures.json have already been written.
      process.exitCode = 1;
    }

    /* -------------------------------------------------------------------- */
    /* Summary                                                               */
    /* -------------------------------------------------------------------- */

    const successful =
      results.filter(
        (item) =>
          item.meta
            ?.scrapeStatus ===
          "success"
      ).length;

    const failed =
      results.filter(
        (item) =>
          item.meta
            ?.scrapeStatus ===
          "failed"
      ).length;

    console.log(
      "\n================================"
    );

    console.log(
      "SCRAPE COMPLETE"
    );

    console.log(
      `Input records: ${items.length}`
    );

    console.log(
      `Output records: ${results.length}`
    );

    console.log(
      `Successful: ${successful}`
    );

    console.log(
      `Failed: ${failed}`
    );

    console.log(
      `Output: ${outputPath}`
    );

    console.log(
      `Failures: ${failurePath}`
    );

    console.log(
      "================================"
    );
  }
}
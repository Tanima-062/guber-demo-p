import { CheerioAPI } from "cheerio";

import { countryCodes } from "../../config/enums";
import { PharmacyInterface } from "../interfaces";

import {
  getCountryCode,
  removeExtraWhitespace,
  stringToHash,
} from "../../utils";

import { PharmacyItem } from "../../types/items/pharmacyItem";
import { VT1Testing } from "./sample";

type JsonRecord = Record<string, any>;

function textOf($: CheerioAPI, selectors: string[]): string {
  for (const selector of selectors) {
    const value = removeExtraWhitespace(
      $(selector).first().text()
    );

    if (value) {
      return value;
    }
  }

  return "";
}

function attrOf(
  $: CheerioAPI,
  selectors: string[],
  attr: string
): string {
  for (const selector of selectors) {
    const value = $(selector).first().attr(attr);

    if (value) {
      const cleaned = removeExtraWhitespace(value);

      if (cleaned) {
        return cleaned;
      }
    }
  }

  return "";
}

function firstNonEmpty(...values: any[]): string {
  for (const value of values) {
    if (typeof value === "string") {
      const cleaned = removeExtraWhitespace(value);

      if (cleaned) {
        return cleaned;
      }
    }

    if (
      typeof value === "number" &&
      Number.isFinite(value)
    ) {
      return String(value);
    }
  }

  return "";
}

function parseJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/* -------------------------------------------------------------------------- */
/* JSON-LD                                                                     */
/* -------------------------------------------------------------------------- */

function collectProducts(
  value: any,
  output: JsonRecord[] = []
): JsonRecord[] {
  if (!value || typeof value !== "object") {
    return output;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectProducts(item, output);
    }

    return output;
  }

  const type = value["@type"];

  const types = Array.isArray(type)
    ? type
    : [type];

  if (
    types.some(
      (item) =>
        String(item || "").toLowerCase() ===
        "product"
    )
  ) {
    output.push(value);
  }

  if (value["@graph"]) {
    collectProducts(value["@graph"], output);
  }

  /*
   * Some structured-data objects contain nested objects
   * that may themselves contain Product entities.
   */
  for (const [key, child] of Object.entries(value)) {
    if (
      key !== "@graph" &&
      child &&
      typeof child === "object"
    ) {
      collectProducts(child, output);
    }
  }

  return output;
}

function extractJsonLdProducts(
  $: CheerioAPI
): JsonRecord[] {
  const products: JsonRecord[] = [];

  $('script[type="application/ld+json"]').each(
    (_, element) => {
      const raw = $(element)
        .contents()
        .text()
        .trim();

      if (!raw) {
        return;
      }

      const parsed = parseJson(raw);

      if (parsed) {
        collectProducts(parsed, products);
      }
    }
  );

  return products;
}

/* -------------------------------------------------------------------------- */
/* Omnisend                                                                   */
/* -------------------------------------------------------------------------- */

function extractBalancedObject(
  raw: string,
  startIndex: number
): string | undefined {
  const open = raw.indexOf("{", startIndex);

  if (open < 0) {
    return undefined;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = open; i < raw.length; i += 1) {
    const char = raw[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }

      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;

      if (depth === 0) {
        return raw.slice(open, i + 1);
      }
    }
  }

  return undefined;
}

function extractOmnisendProductData(
  $: CheerioAPI
): JsonRecord[] {
  const found: JsonRecord[] = [];

  $("script").each((_, element) => {
    const raw = $(element).html() || "";

    /*
     * Typical form:
     *
     * omnisendProductData = {...}
     *
     * Do NOT depend on whitespace or exact formatting.
     */
    const marker = raw.search(
      /omnisendProductData\s*=/i
    );

    if (marker < 0) {
      return;
    }

    const objectText = extractBalancedObject(
      raw,
      marker
    );

    if (!objectText) {
      return;
    }

    const parsed = parseJson(objectText);

    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    ) {
      found.push(parsed);
    }
  });

  return found;
}

/* -------------------------------------------------------------------------- */
/* Generic object helpers                                                     */
/* -------------------------------------------------------------------------- */

function normalizeText(value: any): string {
  return removeExtraWhitespace(
    String(value ?? "")
  )
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/%20/g, " ")
    .replace(/[+#]/g, " ")
    .replace(/[_-]+/g, " ")
    .replace(/[|/,;:=]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function variantTokens(value: any): string[] {
  const normalized = normalizeText(value);

  if (!normalized) {
    return [];
  }

  // Keep one-character values such as S, M and L.
  return normalized
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function flattenScalarValues(
  value: any,
  output: string[] = []
): string[] {
  if (
    value === null ||
    value === undefined
  ) {
    return output;
  }

  if (
    typeof value === "string" ||
    typeof value === "number"
  ) {
    const normalized = normalizeText(value);

    if (normalized) {
      output.push(normalized);
    }

    return output;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      flattenScalarValues(item, output);
    }

    return output;
  }

  if (typeof value === "object") {
    for (const child of Object.values(value)) {
      flattenScalarValues(child, output);
    }
  }

  return output;
}

/**
 * Extract every scalar value from the variant.
 *
 * This is intentionally broader than a hard-coded list such as
 * id/title/sku/option1/etc.
 *
 * The actual Omnisend object is the source of truth.
 */
function getAllVariantValues(
  variant: JsonRecord
): string[] {
  const values: string[] = [];

  flattenScalarValues(variant, values);

  return [
    ...new Set(values),
  ];
}

/**
 * The URL hash can contain both option names and values.
 *
 * Example:
 *
 * #dydziai-m/guoliu_spalvos-pilkas
 *
 * Useful values are:
 *
 * dydziai-m
 * guoliu_spalvos-pilkas
 * m
 * pilkas
 */
function getHashParts(
  hash: string
): string[] {
  const normalized = normalizeText(
    hash
  );

  if (!normalized) {
    return [];
  }

  const values = new Set<string>();

  values.add(normalized);

  /*
   * Preserve slash-separated components from the
   * original hash before generic normalization.
   */
  const rawParts = String(hash)
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);

  for (const part of rawParts) {
    const normalizedPart =
      normalizeText(part);

    if (!normalizedPart) {
      continue;
    }

    values.add(normalizedPart);

    const tokens =
      variantTokens(normalizedPart);

    for (const token of tokens) {
      values.add(token);
    }

    /*
     * For "dydziai-m", the final value "m" is especially
     * important.
     */
    if (tokens.length > 1) {
      values.add(
        tokens[tokens.length - 1]
      );
    }
  }

  return [...values];
}

function getUrlVariantHash(
  url: string
): string {
  try {
    return decodeURIComponent(
      new URL(url).hash.replace(/^#/, "")
    ).trim();
  } catch {
    const hashIndex =
      String(url || "").indexOf("#");

    if (hashIndex < 0) {
      return "";
    }

    try {
      return decodeURIComponent(
        String(url).slice(hashIndex + 1)
      ).trim();
    } catch {
      return String(url)
        .slice(hashIndex + 1)
        .trim();
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Omnisend variants                                                          */
/* -------------------------------------------------------------------------- */

function getOmnisendVariants(
  omni: JsonRecord | JsonRecord[]
): JsonRecord[] {
  const products = Array.isArray(omni) ? omni : [omni];
  const variants: JsonRecord[] = [];

  /*
   * Inspect every Omnisend product-data object. The variants object is
   * the per-variant source of truth, so do not silently use only
   * omnisendProducts[0].
   */
  for (const product of products) {
    const rawVariants = product?.variants;

    if (!rawVariants) {
      continue;
    }

    if (Array.isArray(rawVariants)) {
      for (const variant of rawVariants) {
        if (variant && typeof variant === "object") {
          variants.push({ ...(variant as JsonRecord) });
        }
      }
      continue;
    }

    if (typeof rawVariants === "object") {
      for (const [key, variant] of Object.entries(rawVariants)) {
        if (variant && typeof variant === "object") {
          variants.push({
            ...(variant as JsonRecord),
            __variantKey: key,
          });
        }
      }
    }
  }

  /*
   * Multiple sources can repeat the same variant. Keep one copy by
   * identity while retaining every distinct variant.
   */
  const seen = new Set<string>();

  return variants.filter((variant) => {
    const identity = getVariantIdentity(variant);
    if (!identity) {
      return true;
    }

    const normalized = normalizeText(identity);
    if (seen.has(normalized)) {
      return false;
    }

    seen.add(normalized);
    return true;
  });
}


function getVariantIdentity(
  variant: JsonRecord
): string {
  /*
   * Variant object key gets first priority because the
   * Omnisend variants object itself is the per-variant truth.
   */
  return firstNonEmpty(
    variant.__variantKey,
    variant.id,
    variant.variantId,
    variant.variant_id,
    variant.sku,
    variant.variantIdValue,
    variant.variant_id_value
  );
}

function getVariantField(
  variant: JsonRecord,
  keys: string[]
): any {
  for (const key of keys) {
    if (
      variant &&
      variant[key] !== undefined &&
      variant[key] !== null &&
      variant[key] !== ""
    ) {
      return variant[key];
    }
  }

  return undefined;
}

/**
 * Score the variant against the URL hash.
 *
 * Important:
 * - Exact variant key is strongest.
 * - Exact scalar field value is strong.
 * - Exact token matches are useful.
 * - We do NOT let arbitrary substring matches dominate.
 */
/**
 * Return the values requested by a variant hash.
 *
 * Vet1 hashes are option/value pairs such as:
 *   dydziai-m/guoliu_spalvos-pilkas
 *
 * The option-name portion is not variant truth. The value portion is.
 * Therefore the requested values become:
 *   m, pilkas
 *
 * For compound values such as "2-5-kg", the whole normalized segment
 * after the option name is retained, so "2 5 kg" must match the actual
 * variant value "2-5 kg".
 */
function getRequestedVariantValues(
  hash: string
): string[] {
  const rawParts = String(hash || "")
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);

  const requested: string[] = [];

  for (const rawPart of rawParts) {
    const normalizedPart = normalizeText(rawPart);
    if (!normalizedPart) {
      continue;
    }

    const tokens = variantTokens(normalizedPart);

    if (!tokens.length) {
      continue;
    }

    /*
     * Most Vet1 hashes use "option-value". Remove the option-name
     * tokens and retain the value. For a one-token hash, retain it.
     */
    let value = normalizedPart;

    // Vet1 uses the first hyphen as the option/value boundary.
    // The value itself may contain hyphens or underscores, e.g.
    //   gyvuno_svoris-nuo_10_iki_20_kg
    //   pakuote_vaistai-10_tableciu_20_mg
    // Using lastIndexOf("-") would reduce these to only "kg"/"mg"
    // and makes every such variant fail.
    const separatorIndex = rawPart.indexOf("-");
    if (separatorIndex >= 0) {
      const rawValue = rawPart
        .slice(separatorIndex + 1)
        .trim();

      if (rawValue) {
        value = normalizeText(rawValue);
      }
    } else if (tokens.length > 1) {
      value = tokens[tokens.length - 1];
    }

    if (value) {
      requested.push(value);
    }
  }

  return [...new Set(requested)];
}

function variantHasRequestedValue(
  variant: JsonRecord,
  requestedValue: string
): boolean {
  const requested = normalizeText(requestedValue);
  if (!requested) {
    return false;
  }

  /*
   * Use every scalar value found anywhere on the variant object, not
   * just values reached through a key that looks like "option" or
   * "attribute". The real Omnisend shape is typically a flat map of
   * option-name -> option-value (e.g. { "Dydžiai": "M" }), so the
   * leaf's own key is the option NAME, not a generic label -- filtering
   * candidates by the leaf key text (as an earlier version of this
   * function did) discarded every legitimate value and made every
   * variant score 0.
   */
  const candidates = getAllVariantValues(variant);

  // Exact option value is the strongest signal.
  if (candidates.includes(requested)) {
    return true;
  }

  const requestedTokens = variantTokens(requested);
  if (!requestedTokens.length) {
    return false;
  }

  return candidates.some((candidate) => {
    const candidateTokens = variantTokens(candidate);

    // Exact sequence handles compound values such as 2-5 kg.
    if (
      candidateTokens.length === requestedTokens.length &&
      candidateTokens.every(
        (token, index) => token === requestedTokens[index]
      )
    ) {
      return true;
    }

    // A one-token option value may be represented as "Dydžiai M".
    if (requestedTokens.length === 1) {
      return candidateTokens[candidateTokens.length - 1] === requestedTokens[0];
    }

    return false;
  });
}

/**
 * Match a variant against the URL hash.
 *
 * IMPORTANT:
 * A partial token overlap is NOT sufficient. If the URL explicitly
 * requests two option values, the candidate must contain both values.
 * This prevents several distinct CSV rows from collapsing onto the
 * first/most-similar variant.
 */
function variantMatchScore(
  variant: JsonRecord,
  hash: string
): number {
  if (!hash) {
    return 0;
  }

  const hashNormalized =
    normalizeText(hash);

  const hashParts =
    getHashParts(hash);

  if (!hashParts.length) {
    return 0;
  }

  const variantKey =
    normalizeText(
      variant.__variantKey
    );

  /*
   * Exact object-key match is authoritative.
   */
  if (
    variantKey &&
    (
      variantKey === hashNormalized ||
      hashParts.includes(variantKey)
    )
  ) {
    return 10000;
  }

  const requestedValues =
    getRequestedVariantValues(hash);

  if (!requestedValues.length) {
    return 0;
  }

  /*
   * Every requested URL value must be represented by the candidate
   * variant. No partial-match fallback is allowed.
   */
  const matchedValues =
    requestedValues.filter((requestedValue) =>
      variantHasRequestedValue(
        variant,
        requestedValue
      )
    );

  if (
    matchedValues.length !== requestedValues.length
  ) {
    return 0;
  }

  /*
   * Strong deterministic score after the complete option combination
   * has matched. More exact values get a higher score, but a candidate
   * can never win unless ALL requested values match.
   */
  let score = 2000;

  score += matchedValues.length * 500;

  /*
   * Prefer an exact option-field match when available.
   */
  const optionKeys = [
    "option1",
    "option2",
    "option3",
    "option4",
    "option",
    "options",
    "values",
    "attributes",
    "properties",
  ];

  for (const key of optionKeys) {
    const value = variant[key];

    if (value === undefined) {
      continue;
    }

    const optionValues =
      flattenScalarValues(value);

    for (const optionValue of optionValues) {
      if (
        requestedValues.includes(optionValue)
      ) {
        score += 250;
      }
    }
  }

  return score;
}

function selectOmnisendVariant(
  omni: JsonRecord | JsonRecord[],
  url: string
): {
  variant: JsonRecord;
  matched: boolean;
  score: number;
  hash: string;
  count: number;
} {
  const variants =
    getOmnisendVariants(omni);

  const hash =
    getUrlVariantHash(url);

  if (!variants.length) {
    return {
      variant: {},
      matched: false,
      score: 0,
      hash,
      count: 0,
    };
  }

  /*
   * A URL without a variant hash has no basis for selecting one
   * variant. Never silently choose variants[0].
   */
  if (!hash) {
    return {
      variant: {},
      matched: false,
      score: 0,
      hash: "",
      count: variants.length,
    };
  }

  let bestVariant: JsonRecord = {};
  let bestScore = 0;
  let tied = false;

  for (const variant of variants) {
    const score =
      variantMatchScore(
        variant,
        hash
      );

    if (score > bestScore) {
      bestScore = score;
      bestVariant = variant;
      tied = false;
    } else if (
      score > 0 &&
      score === bestScore
    ) {
      tied = true;
    }
  }

  /*
   * Ambiguous matches are not safe to call a variant match. Returning
   * unmatched is preferable to corrupting the output with an arbitrary
   * variant.
   */
  if (tied) {
    return {
      variant: {},
      matched: false,
      score: 0,
      hash,
      count: variants.length,
    };
  }

  return {
    variant:
      bestScore > 0
        ? bestVariant
        : {},
    matched: bestScore > 0,
    score: bestScore,
    hash,
    count: variants.length,
  };
}


/* -------------------------------------------------------------------------- */
/* Product data                                                               */
/* -------------------------------------------------------------------------- */

function getOffer(
  product: JsonRecord
): JsonRecord {
  const offers = product?.offers;

  if (Array.isArray(offers)) {
    return offers[0] || {};
  }

  if (
    offers &&
    typeof offers === "object"
  ) {
    return offers;
  }

  return {};
}

function getBrand(
  product: JsonRecord
): string {
  const brand = product?.brand;

  if (typeof brand === "string") {
    return removeExtraWhitespace(
      brand
    );
  }

  if (
    brand &&
    typeof brand === "object"
  ) {
    return firstNonEmpty(
      brand.name,
      brand.title
    );
  }

  return "";
}

function parsePrice(
  value: any
): string {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return "";
  }

  if (typeof value === "number") {
    return Number.isFinite(value)
      ? String(value)
      : "";
  }

  const cleaned = String(value)
    .replace(/\s/g, "")
    .replace(/€/g, "")
    .replace(/EUR/gi, "")
    .replace(",", ".");

  const match =
    cleaned.match(
      /-?\d+(?:\.\d+)?/
    );

  return match
    ? match[0]
    : "";
}

/* -------------------------------------------------------------------------- */
/* Availability                                                               */
/* -------------------------------------------------------------------------- */

function availabilityToStock(
  value: any
): {
  value: boolean;
  known: boolean;
} {
  const text = String(
    value || ""
  )
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

  if (!text) {
    return {
      value: false,
      known: false,
    };
  }

  /*
   * Negative states MUST be checked first.
   */
  if (
    text.includes("outofstock") ||
    text.includes("out of stock") ||
    text.includes("unavailable") ||
    text.includes("soldout") ||
    text.includes("sold out") ||
    text.includes("not available") ||
    text.includes("currently unavailable")
  ) {
    return {
      value: false,
      known: true,
    };
  }

  if (
    text.includes("instock") ||
    text.includes("in stock") ||
    text.includes("available") ||
    text.includes("in-stock")
  ) {
    return {
      value: true,
      known: true,
    };
  }

  return {
    value: false,
    known: false,
  };
}

/* -------------------------------------------------------------------------- */
/* Category                                                                   */
/* -------------------------------------------------------------------------- */

function extractCategory(
  $: CheerioAPI,
  product: JsonRecord
): string {
  const structured =
    firstNonEmpty(
      product.category
    );

  if (structured) {
    return structured;
  }

  const breadcrumbs: string[] =
    [];

  $(
    '[aria-label="breadcrumb"] a,' +
      ' .breadcrumb a,' +
      ' .breadcrumbs a,' +
      ' nav.breadcrumb a'
  ).each((_, el) => {
    const value =
      removeExtraWhitespace(
        $(el).text()
      );

    if (
      value &&
      !breadcrumbs.includes(value)
    ) {
      breadcrumbs.push(value);
    }
  });

  if (breadcrumbs.length >= 2) {
    return breadcrumbs[
      breadcrumbs.length - 2
    ];
  }

  if (breadcrumbs.length === 1) {
    return breadcrumbs[0];
  }

  return attrOf(
    $,
    [
      'meta[itemprop="category"]',
      'meta[name="category"]',
    ],
    "content"
  );
}

/* -------------------------------------------------------------------------- */
/* Images                                                                     */
/* -------------------------------------------------------------------------- */

function extractImageUrls(
  $: CheerioAPI,
  product: JsonRecord
): string[] {
  const values: string[] = [];

  const image =
    product?.image;

  if (typeof image === "string") {
    values.push(image);
  }

  if (Array.isArray(image)) {
    values.push(
      ...image.filter(
        (value) =>
          typeof value === "string"
      )
    );
  }

  $(
    'meta[property="og:image"]'
  ).each((_, el) => {
    const value =
      $(el).attr("content");

    if (value) {
      values.push(value);
    }
  });

  return [
    ...new Set(
      values
        .map((value) =>
          value.trim()
        )
        .filter(Boolean)
    ),
  ];
}

/* -------------------------------------------------------------------------- */
/* Labeled HTML fields                                                        */
/* -------------------------------------------------------------------------- */

function extractLabeledValue(
  $: CheerioAPI,
  labels: string[]
): string {
  let result = "";

  $(
    ".product-information," +
      " .product-details," +
      " .product-description," +
      " main"
  )
    .find("tr, li, p, div")
    .each((_, el) => {
      if (result) {
        return;
      }

      const value =
        removeExtraWhitespace(
          $(el).text()
        );

      if (!value) {
        return;
      }

      const lower =
        value.toLowerCase();

      for (const label of labels) {
        const normalizedLabel =
          label.toLowerCase();

        if (
          lower.startsWith(
            normalizedLabel
          )
        ) {
          const after =
            value
              .slice(label.length)
              .replace(
                /^[:\-\s]+/,
                ""
              )
              .trim();

          if (after) {
            result = after;
            return;
          }
        }
      }
    });

  return result;
}

/* -------------------------------------------------------------------------- */
/* VT1                                                                         */
/* -------------------------------------------------------------------------- */

export class VT1Functions
  implements PharmacyInterface
{
  public baseUrl =
    "https://vet1.lt";

  public headers: Record<
    string,
    string
  > = {
    "User-Agent":
      process.env.USER_AGENT ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",

    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",

    "Accept-Language":
      "lt-LT,lt;q=0.9,en-US;q=0.8,en;q=0.7",

    "Cache-Control": "no-cache",

    Pragma: "no-cache",

    Referer:
      "https://vet1.lt/",
  };

  public useHeadless(
    _source: string,
    _jobType: string
  ): boolean {
    return true;
  }

  public scrapePharmacyItem(
    $: CheerioAPI,
    url: string,
    adLinkMeta?: {
      title?: string;
      source_id?: string;
    }
  ): PharmacyItem<string> {
    /* -------------------------------------------------------------------- */
    /* Discover ALL available structured sources                            */
    /* -------------------------------------------------------------------- */

    const jsonLdProducts =
      extractJsonLdProducts($);

    const omnisendProducts =
      extractOmnisendProductData($);

    const product =
      jsonLdProducts[0] || {};

    const offer =
      getOffer(product);

    // Keep the complete array for variant resolution, but use one
    // product object for product-level fallback fields.
    const omni =
      omnisendProducts[0] || {};

    /* -------------------------------------------------------------------- */
    /* Omnisend variant is the URL-specific source of truth                */
    /* -------------------------------------------------------------------- */

    // Pass the complete array, not just omnisendProducts[0] -- a page
    // can carry more than one omnisendProductData block, and
    // getOmnisendVariants() is written to scan every one of them.
    // Narrowing to a single product here would silently drop variants
    // that only exist on a later block.
    const variantSelection =
      selectOmnisendVariant(
        omnisendProducts,
        url
      );

    const selectedVariant =
      variantSelection.variant;

    const hasSelectedVariant =
      variantSelection.matched;

    const variantIdentity =
      getVariantIdentity(
        selectedVariant
      );

    /*
     * If a URL explicitly contains a variant hash but we could not match it,
     * we intentionally do NOT pretend that the first variant is correct.
     */
    const variantRequested =
      Boolean(
        variantSelection.hash
      );

    /* -------------------------------------------------------------------- */
    /* TITLE                                                                 */
    /* -------------------------------------------------------------------- */

    const title =
      firstNonEmpty(
        hasSelectedVariant
          ? getVariantField(
              selectedVariant,
              [
                "title",
                "name",
                "label",
              ]
            )
          : "",

        product.name,

        omni.title,

        textOf($, [
          "h1.product-title",
          "h1.product_name",
          "h1",
          '[itemprop="name"]',
        ]),

        attrOf(
          $,
          [
            'meta[property="og:title"]',
          ],
          "content"
        ),

        adLinkMeta?.title
      );

    /* -------------------------------------------------------------------- */
    /* MANUFACTURER                                                          */
    /* -------------------------------------------------------------------- */

    const manufacturer =
      firstNonEmpty(
        getBrand(product),

        omni.vendor,

        omni.brand,

        hasSelectedVariant
          ? getVariantField(
              selectedVariant,
              [
                "vendor",
                "brand",
                "manufacturer",
              ]
            )
          : "",

        attrOf(
          $,
          [
            'meta[itemprop="brand"]',
            'meta[name="brand"]',
          ],
          "content"
        ),

        textOf($, [
          '[itemprop="brand"]',
          ".manufacturer",
          ".product-manufacturer",
          ".brand",
          '[class*="manufacturer"]',
        ]),

        extractLabeledValue(
          $,
          [
            "Manufacturer",
            "Gamintojas",
          ]
        )
      );

    /* -------------------------------------------------------------------- */
    /* CATEGORY                                                              */
    /* -------------------------------------------------------------------- */

    const category =
      extractCategory(
        $,
        product
      );

    /* -------------------------------------------------------------------- */
    /* PRICE                                                                 */
    /* -------------------------------------------------------------------- */

    /*
     * Critical rule:
     *
     * If a variant was selected, use the variant's price first.
     *
     * Do not overwrite a valid selected-variant price with the
     * product-level JSON-LD price.
     */
    const variantCurrentPrice =
      hasSelectedVariant
        ? parsePrice(
            firstNonEmpty(
              getVariantField(
                selectedVariant,
                [
                  "price",
                  "current_price",
                  "currentPrice",
                  "sale_price",
                  "salePrice",
                ]
              )
            )
          )
        : "";

    const productCurrentPrice =
      parsePrice(
        firstNonEmpty(
          offer.price,
          omni.price,
          omni.current_price,
          omni.sale_price
        )
      );

    function collectSpecificPrices(
      selectors: string[]
    ): string[] {
      const values: string[] = [];

      $(selectors.join(", ")).each(
        (_, el) => {
          const value =
            $(el).attr("content") ||
            $(el).attr("data-price") ||
            $(el).text();

          const parsed =
            parsePrice(value);

          if (
            parsed &&
            !values.includes(parsed)
          ) {
            values.push(parsed);
          }
        }
      );

      return values;
    }

    const currentVisiblePrices =
      collectSpecificPrices([
        '[itemprop="price"]',
        'meta[property="product:price:amount"]',
        ".current-price",
        ".sale-price",
        ".special-price",
        ".discount-price",
        ".product-sale-price",
        ".price--sale",
        ".price--current",
        "ins.price",
        "ins .price",
        ".price ins",
      ]);

    const originalVisiblePrices =
      collectSpecificPrices([
        ".old-price",
        ".original-price",
        ".regular-price",
        ".compare-at-price",
        ".compare-price",
        ".was-price",
        ".previous-price",
        ".price--old",
        ".price--regular",
        "del.price",
        "del .price",
        ".price del",
        "s.price",
        "s .price",
        ".price s",
      ]);

    const genericProductPrices =
      collectSpecificPrices([
        ".product-price",
        ".product__price",
        ".product-price-current",
      ]);

    const currentPrice =
      firstNonEmpty(
        variantCurrentPrice,
        productCurrentPrice,
        currentVisiblePrices[0],
        genericProductPrices[0]
      );

    const variantOriginalPrice =
      hasSelectedVariant
        ? parsePrice(
            firstNonEmpty(
              getVariantField(
                selectedVariant,
                [
                  "compareAtPrice",
                  "compare_at_price",
                  "comparePrice",
                  "compare_price",
                  "originalPrice",
                  "original_price",
                  "oldPrice",
                  "old_price",
                ]
              )
            )
          )
        : "";

    const structuredOriginalPrice =
      firstNonEmpty(
        variantOriginalPrice,

        parsePrice(
          firstNonEmpty(
            offer.compareAtPrice,
            offer.compare_at_price,
            offer.originalPrice,
            offer.original_price,
            offer.oldPrice,
            offer.old_price,
            omni.compare_at_price,
            omni.compareAtPrice,
            omni.original_price,
            omni.old_price
          )
        ),

        originalVisiblePrices[0]
      );

    let price =
      currentPrice;

    let discountPrice:
      | string
      | undefined;

    if (
      currentPrice &&
      structuredOriginalPrice
    ) {
      const current =
        Number(currentPrice);

      const original =
        Number(
          structuredOriginalPrice
        );

      if (
        Number.isFinite(current) &&
        Number.isFinite(original) &&
        original > current
      ) {
        price =
          structuredOriginalPrice;

        discountPrice =
          currentPrice;
      }
    }

    /*
     * Explicit HTML sale pair fallback.
     */
    if (
      !discountPrice &&
      currentVisiblePrices.length > 0 &&
      originalVisiblePrices.length > 0
    ) {
      const current =
        Number(
          currentVisiblePrices[0]
        );

      const original =
        Number(
          originalVisiblePrices[0]
        );

      if (
        Number.isFinite(current) &&
        Number.isFinite(original) &&
        original > current
      ) {
        price =
          originalVisiblePrices[0];

        discountPrice =
          currentVisiblePrices[0];
      }
    }

    /* -------------------------------------------------------------------- */
    /* AVAILABILITY                                                          */
    /* -------------------------------------------------------------------- */

    const availabilityRaw =
      firstNonEmpty(
        /*
         * Selected variant first.
         */
        hasSelectedVariant
          ? getVariantField(
              selectedVariant,
              [
                "availability",
                "available",
                "inStock",
                "in_stock",
                "stock",
                "inventory",
                "inventoryQuantity",
              ]
            )
          : "",

        offer.availability,

        omni.availability,

        attrOf(
          $,
          [
            '[itemprop="availability"]',
          ],
          "href"
        ),

        attrOf(
          $,
          [
            '[itemprop="availability"]',
          ],
          "content"
        ),

        textOf($, [
          ".stock",
          ".availability",
          ".product-availability",
          '[class*="stock"]',
          '[class*="availability"]',
        ])
      );

    const availability =
      availabilityToStock(
        availabilityRaw
      );

    /* -------------------------------------------------------------------- */
    /* DESCRIPTION                                                           */
    /* -------------------------------------------------------------------- */

    const description =
      firstNonEmpty(
        hasSelectedVariant
          ? getVariantField(
              selectedVariant,
              [
                "description",
              ]
            )
          : "",

        product.description,

        omni.description,

        attrOf(
          $,
          [
            'meta[name="description"]',
          ],
          "content"
        ),

        textOf($, [
          '[itemprop="description"]',
          ".product-description",
          ".description",
          ".product-information",
        ])
      );

    /* -------------------------------------------------------------------- */
    /* COMPOSITION / USE                                                     */
    /* -------------------------------------------------------------------- */

    const composition =
      extractLabeledValue(
        $,
        [
          "Composition",
          "Sudėtis",
          "Ingredients",
          "Sudedamosios dalys",
        ]
      );

    const productUse =
      extractLabeledValue(
        $,
        [
          "Product use",
          "Naudojimas",
          "Usage",
          "Vartojimas",
        ]
      );

    /* -------------------------------------------------------------------- */
    /* BARCODE                                                               */
    /* -------------------------------------------------------------------- */

    const barcode =
      firstNonEmpty(
        hasSelectedVariant
          ? getVariantField(
              selectedVariant,
              [
                "barcode",
                "gtin",
                "gtin13",
                "gtin8",
                "ean",
              ]
            )
          : "",

        product.gtin,
        product.gtin13,
        product.gtin8,

        omni.barcode,
        omni.gtin,

        attrOf(
          $,
          [
            'meta[itemprop="gtin13"]',
            'meta[itemprop="gtin"]',
          ],
          "content"
        )
      );

    /* -------------------------------------------------------------------- */
    /* IMAGES                                                                */
    /* -------------------------------------------------------------------- */

    const imageUrls =
      extractImageUrls(
        $,
        product
      );

    /* -------------------------------------------------------------------- */
    /* RESULT                                                                */
    /* -------------------------------------------------------------------- */

    const now =
      new Date().toISOString();

    const item:
      PharmacyItem<string> = {
      added: now,

      title,

      manufacturer,

      price,

      discountPrice,

      discountType:
        discountPrice
          ? "sale"
          : "",

      productUse,

      composition,

      description,

      inStock:
        availability.value,

      category,

      url,

      sourceId:
        adLinkMeta?.source_id ||
        stringToHash(url),

      countryCode:
        getCountryCode(
          countryCodes,
          url
        ) as "LT" | "LV" | "EE",

      quantityLeft: {},

      imageUrls,

      barcode:
        barcode || undefined,

      source:
        "vet1.lt",

      additionalInformation: {
        source: "vet1.lt",

        parser:
          "omnisend-variant-first",

        availabilityKnown:
          availability.known,

        variantRequested,

        variantMatched:
          variantSelection.matched,

        variantCount:
          variantSelection.count,

        variantMatchScore:
          variantSelection.score,

        variantHash:
          variantSelection.hash,

        variantIdentity:
          variantIdentity || "",

        /*
         * Explicitly expose which source supplied the
         * selected price.
         */
        priceSource:
          variantCurrentPrice
            ? "omnisend-variant"
            : productCurrentPrice
            ? "structured-data"
            : currentVisiblePrices.length
            ? "html-current"
            : "html-fallback",

        discountPriceSource:
          discountPrice
            ? variantOriginalPrice
              ? "omnisend-variant"
              : structuredOriginalPrice
              ? "structured-data"
              : "html-sale-pair"
            : "",

        /*
         * Useful for debugging and regression analysis.
         */
        omnisendProductFound:
          omnisendProducts.length > 0,

        jsonLdProductFound:
          jsonLdProducts.length > 0,

        omnisendVariantObject:
          hasSelectedVariant
            ? selectedVariant
            : undefined,
      },
    };

    return item;
  }

  public getNextPageUrl(
    _$: CheerioAPI,
    _url?: string
  ): string | undefined {
    return undefined;
  }

  public addItems(
    _$: CheerioAPI,
    _idUrls: any,
    _url?: string
  ): void {
    return;
  }

  public isAdModified(
    _currentItem: any,
    _previousItem: any
  ): string {
    return "";
  }

  public isAdRemoved(
    _$: CheerioAPI
  ): boolean {
    return false;
  }

  public testing(
    autoLaunch = true
  ) {
    return new VT1Testing(
      autoLaunch
    );
  }
}
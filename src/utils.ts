import fs from "fs";
import path from "path";
import { v5 as uuidv5 } from "uuid";
import he from "he";

export function getCountryCode(countryCodes: Record<string, string>, url: string) {
  try {
    const hostname = new URL(url).hostname;
    const suffix = hostname.split(".").pop()?.toLowerCase() || "";
    return countryCodes[suffix] || "LT";
  } catch {
    return "LT";
  }
}

export function removeExtraWhitespace(text: string): string {
  return String(text || "").replace(/\r?\n|\r/g, " ").replace(/\s+/g, " ").trim();
}

export function decodeHtml(encodedStr: string): string {
  return he.decode(String(encodedStr || ""));
}

export function stringToHash(value: string, useLegacyUnlowercased = false) {
  const namespace = "26167fe1-6463-4c97-b958-255f901cb179";
  const normalized = useLegacyUnlowercased ? value : value.toLowerCase();
  return uuidv5(normalized, namespace);
}

export function jsonToFile(json: unknown, filename: string, pretty = true) {
  const dir = path.dirname(filename);
  if (dir && dir !== ".") fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filename, JSON.stringify(json, null, pretty ? 2 : 0), "utf8");
}

export function jsonFromFile<T = unknown>(filename: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(filename, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export function warningMessage(message: string) {
  console.log(`\x1b[33m${message}\x1b[0m`);
}

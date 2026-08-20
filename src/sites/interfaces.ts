import { CheerioAPI } from "cheerio";
import { IdUrlsType } from "../types/common";

export interface CommonInterface {
  headers: Record<string, string>;
  useHeadless(source: string, jobType: string, url?: string): boolean;
  isXmlMode?: boolean;
  cookies?: any;
  getNextPageUrl($: CheerioAPI, url?: string): string | undefined;
  addItems($: CheerioAPI, idUrls: IdUrlsType, url?: string, adLinkMeta?: any): void;
  isAdModified(currentItem: any, previousItem: any): string;
  isAdRemoved($: CheerioAPI): boolean;
  testing(autoLaunch?: boolean): any;
}

export interface PharmacyInterface extends CommonInterface {
  scrapePharmacyItem($: CheerioAPI, url: string, adLinkMeta?: any): any;
}

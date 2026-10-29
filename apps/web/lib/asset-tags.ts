import { assetTagSheet } from "labels/zpl";
import { MAX_TAG_RANGE, maxTagNumber } from "rules";
import { fetchAllPages, type Page } from "./locations";

/**
 * Admin → Asset tags "Create range": null when `first`–`last` is a range the org can create in
 * one admin_asset_tags call (numbers 0–10^digits − 1, at most MAX_TAG_RANGE tags), else the
 * message for the form.
 */
export function tagRangeProblem(first: number, last: number, digits: number): string | null {
  const max = maxTagNumber(digits);
  if (
    !Number.isInteger(first) ||
    !Number.isInteger(last) ||
    first < 0 ||
    last > max ||
    last < first
  )
    return `Enter a range from 0 to ${max}.`;
  if (last - first + 1 > MAX_TAG_RANGE)
    return `Create at most ${MAX_TAG_RANGE.toLocaleString("en-US")} tags at a time.`;
  return null;
}

/** Tags per page of the Admin → Asset tags list (one request, under the PostgREST row cap). */
export const TAG_LIST_PAGE_SIZE = 500;

/** The 1-based list page `raw` names, clamped to the pages `total` tags fill, and its rows. */
export function tagListPage(raw: string | undefined, total: number) {
  const pages = Math.max(1, Math.ceil(total / TAG_LIST_PAGE_SIZE));
  const n = Number(raw);
  const page = Number.isInteger(n) && n >= 1 ? Math.min(n, pages) : 1;
  const from = (page - 1) * TAG_LIST_PAGE_SIZE;
  return { page, pages, from, to: from + TAG_LIST_PAGE_SIZE - 1 };
}

/**
 * The asset tag sheet for every non-retired tag. `page` reads them ordered by code, one range
 * at a time: a pool can exceed the PostgREST row cap (one range may create 10,000 tags).
 */
export async function activeTagSheet(
  page: (from: number, to: number) => Page<{ code: string }>,
  orgSlug: string,
  tagDigits: number,
): Promise<string> {
  const codes = (await fetchAllPages(page)).map((t) => t.code);
  if (!codes.length) throw new Error("Create tags first.");
  return assetTagSheet({ orgSlug, codes, tagDigits });
}

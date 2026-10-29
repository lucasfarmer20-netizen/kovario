import { MAX_TAG_RANGE, maxTagNumber } from "rules";

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

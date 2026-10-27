import { describe, expect, it } from "vitest";
import { addressGaps, addressLine, boxParcel, cleanAddress, walkinParcel } from "./parcels.ts";
import { scrub } from "./scrub.ts";
import { shippoFixtures } from "./fixtures.ts";
import {
  isCarrierException,
  isInCarrierHands,
  parseTrackingEvent,
  tokensMatch,
} from "./tracking.ts";

describe("cold chain parcel weight", () => {
  const dims = { length_in: 20, width_in: 14, height_in: 12, packaging_lb: 2.5, dry_ice_lb: 10 };

  it("gross = fish + packaging + dry ice, per box size", () => {
    expect(boxParcel({ weight_lb: 40, dims })).toEqual({
      length_in: 20,
      width_in: 14,
      height_in: 12,
      weight_lb: 52.5,
      dry_ice_lb: 10,
    });
  });

  it("a size without packaging / dry ice ships at fish weight", () => {
    expect(
      boxParcel({ weight_lb: 40, dims: { length_in: 20, width_in: 14, height_in: 12 } })?.weight_lb,
    ).toBe(40);
  });

  it("no full dims or no weight → cannot be quoted", () => {
    expect(boxParcel({ weight_lb: 40, dims: { length_in: 20, width_in: 14 } })).toBeNull();
    expect(boxParcel({ weight_lb: 0, dims })).toBeNull();
    expect(boxParcel({ weight_lb: 40, dims: null })).toBeNull();
  });

  it("walk-in parcels are entered gross", () => {
    expect(walkinParcel({ length_in: 10, width_in: 10, height_in: 10, weight_lb: 22.456 })).toEqual(
      {
        length_in: 10,
        width_in: 10,
        height_in: 10,
        weight_lb: 22.46,
        dry_ice_lb: 0,
      },
    );
    expect(walkinParcel({ length_in: 10, width_in: 0, height_in: 10, weight_lb: 5 })).toBeNull();
  });
});

describe("addresses", () => {
  it("cleans, defaults the country, lists gaps", () => {
    expect(
      cleanAddress({
        name: " Pat ",
        street1: "1 Main",
        city: "Kenai",
        state: "ak",
        zip: "99611",
        street2: " ",
      }),
    ).toEqual({
      name: "Pat",
      street1: "1 Main",
      city: "Kenai",
      state: "AK",
      zip: "99611",
      country: "US",
    });
    expect(addressGaps({ name: "Pat" })).toEqual(["street1", "city", "state", "zip"]);
    expect(addressGaps(null)).toEqual(["name", "street1", "city", "state", "zip"]);
    expect(
      addressLine({ name: "Pat", street1: "1 Main", city: "Kenai", state: "AK", zip: "99611" }),
    ).toBe("Pat, 1 Main, Kenai AK 99611");
  });
});

/** A mutable copy of the recorded track_updated (TRANSIT) event. */
const fixtureTracking = () => structuredClone(shippoFixtures.trackUpdatedTransit);

describe("tracking webhook", () => {
  it("parses track_updated and maps the status", () => {
    const u = parseTrackingEvent(fixtureTracking());
    expect(u).toMatchObject({
      carrier: "ups",
      trackingNumber: "1Z999AA10123456784",
      transactionId: "txn_2e1d0000000000000000000000000001",
      status: "TRANSIT",
      test: false,
    });
    expect(isInCarrierHands("TRANSIT") && isInCarrierHands("DELIVERED")).toBe(true);
    expect(isInCarrierHands("PRE_TRANSIT") || isInCarrierHands("UNKNOWN")).toBe(false);
    expect(isCarrierException("RETURNED") && isCarrierException("FAILURE")).toBe(true);
  });

  it("ignores other events and malformed bodies; unknown statuses read UNKNOWN", () => {
    expect(parseTrackingEvent({ event: "transaction_created", data: {} })).toBeNull();
    expect(parseTrackingEvent(null)).toBeNull();
    expect(
      parseTrackingEvent({ event: "track_updated", data: { tracking_number: "" } }),
    ).toBeNull();
    const odd = fixtureTracking();
    odd.data.tracking_status.status = "SOMETHING_NEW";
    expect(parseTrackingEvent(odd)?.status).toBe("UNKNOWN");
  });

  it("webhook token compare", () => {
    expect(tokensMatch("abc123", "abc123")).toBe(true);
    expect(tokensMatch("abc124", "abc123")).toBe(false);
    expect(tokensMatch("abc12", "abc123")).toBe(false);
    expect(tokensMatch("", "")).toBe(false);
    expect(tokensMatch(null, "abc")).toBe(false);
  });
});

describe("scrub", () => {
  it("redacts keys and token text", () => {
    expect(
      scrub({
        Authorization: "ShippoToken shippo_test_abc",
        nested: [{ msg: "used shippo_live_XYZ123" }],
        ok: 1,
      }),
    ).toEqual({
      Authorization: "[redacted]",
      nested: [{ msg: "used shippo_live_[redacted]" }],
      ok: 1,
    });
  });
});

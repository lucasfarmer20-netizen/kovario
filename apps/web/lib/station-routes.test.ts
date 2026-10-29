import { expect, it } from "vitest";
import { Constants } from "db";
import { STATION_ROUTES } from "./station-routes";

it("station-routes-complete", () => {
  expect(Object.keys(STATION_ROUTES).sort()).toEqual(
    [...Constants.public.Enums.device_station].sort(),
  );
  expect(Object.values(STATION_ROUTES).map((station) => station.href)).toEqual([
    "/intake",
    "/storage",
    "/wave",
    "/rollstock",
    "/reconcile",
    "/freezer/blast",
    "/freezer/locate",
    "/allocate",
    "/boxing",
    "/register",
    "/shipping",
  ]);
});

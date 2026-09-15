import test from "node:test";
import assert from "node:assert/strict";
import { isVehicleCurrentlyBooked } from "./tripUtils.js";

const now = Date.parse("2026-09-13T12:00:00Z");
const trip = {
  trip_start: "2026-09-13T10:00:00Z",
  trip_end: "2026-09-13T14:00:00Z",
};

test("returned trips awaiting expenses release the car even with stale started status", () => {
  assert.equal(isVehicleCurrentlyBooked({ ...trip, workflow_stage: "awaiting_expenses", status: "started" }, now), false);
});

test("future reservations do not occupy a car now", () => {
  assert.equal(isVehicleCurrentlyBooked({ ...trip, trip_start: "2026-09-14T10:00:00Z", trip_end: "2026-09-14T14:00:00Z" }, now), false);
  assert.equal(isVehicleCurrentlyBooked(trip, now), true);
});

test("in-progress trips remain booked after their scheduled return", () => {
  assert.equal(isVehicleCurrentlyBooked({ ...trip, workflow_stage: "in_progress", trip_end: "2026-09-13T11:00:00Z" }, now), true);
});

test("closed and canceled trips do not occupy the car", () => {
  assert.equal(isVehicleCurrentlyBooked({ ...trip, closed_out: true }, now), false);
  assert.equal(isVehicleCurrentlyBooked({ ...trip, status: "canceled" }, now), false);
});

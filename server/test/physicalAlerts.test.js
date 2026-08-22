const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createAlertService } = require("../services/physicalAlerts/alertService");
const { createCriticalBookingRule } = require("../services/physicalAlerts/bookingRule");
const { reconcileBookingAlerts } = require("../services/physicalAlerts/bookingAlertReconciler");
const { isBookingAlertEligible } = require("../services/physicalAlerts/bookingAlertSettings");
const { isTripWithinCriticalWindow, isWithinQuietHours } = require("../services/physicalAlerts/config");
const { createHealthService } = require("../services/physicalAlerts/healthService");
const { MQTTTransport } = require("../services/physicalAlerts/mqttTransport");
const { publishHeartbeats, startPhysicalAlertRuntime } = require("../services/physicalAlerts/runtime");
const { getMatchedTripReturnGeoLocation } = require("../services/alerts/fleetAlerts");

function fakeRepository() {
  const alerts = [];
  return {
    alerts,
    unconfirmedTrips: [],
    async ensureSchema() {},
    async registerDevice(deviceId, displayName) { return { device_id: deviceId, display_name: displayName, enabled: true }; },
    async listDevices() { return [{ device_id: "bedroom", enabled: true }]; },
    async createAlert(input) {
      const existing = alerts.find((item) => input.dedupeKey && item.dedupe_key === input.dedupeKey);
      if (existing) return { ...existing, inserted: false };
      const alert = { id: `alert-${alerts.length + 1}`, created_at: new Date().toISOString(),
        type: input.type, severity: input.severity, title: input.title, message: input.message,
        trip_id: input.tripId, device_id: input.deviceId, dedupe_key: input.dedupeKey,
        published_at: null, acknowledged_at: null, resolved_at: null, inserted: true };
      alerts.push(alert); return alert;
    },
    async markPublished(id) { const alert = alerts.find((item) => item.id === id); alert.published_at = new Date(); return alert; },
    async acknowledge(id, by, at) { const alert = alerts.find((item) => item.id === id); if (!alert) return null;
      alert.acknowledged_at ||= at || new Date(); alert.acknowledged_by ||= by; return alert; },
    async resolve(id, at) { const alert = alerts.find((item) => item.id === id); if (!alert) return null; alert.resolved_at ||= at || new Date(); return alert; },
    async reopenBookingAlert(tripId) { const alert = alerts.find((item) => item.type === "new_critical_booking" && item.trip_id === tripId && item.resolved_at);
      if (!alert) return null; alert.resolved_at = null; alert.acknowledged_at = null; alert.acknowledged_by = null; alert.published_at = null; return alert; },
    async listAlerts({ active, deviceId } = {}) { return alerts.filter((item) => (!active || !item.resolved_at) && (!deviceId || item.device_id === deviceId)); },
    async listUnconfirmedTrips() { return this.unconfirmedTrips; },
    async getBookingAlertSettings() { return { enabled: true, startTime: "21:00", endTime: "07:00", pickupLeadHours: 10 }; },
  };
}

function fakeTransport(result = { ok: true }) {
  return { published: [], isHealthy: () => result.ok, async publish(topic, payload, options) {
    this.published.push({ topic, payload, options }); return result;
  } };
}

test("quiet hours span midnight", () => {
  const options = { start: "21:00", end: "07:00", timeZone: "America/Chicago" };
  assert.equal(isWithinQuietHours("2026-08-16T03:30:00-05:00", options), true);
  assert.equal(isWithinQuietHours("2026-08-16T22:30:00-05:00", options), true);
  assert.equal(isWithinQuietHours("2026-08-16T12:00:00-05:00", options), false);
});

test("critical booking window only accepts future trips inside window", () => {
  const discovered = "2026-08-16T22:00:00-05:00";
  assert.equal(isTripWithinCriticalWindow(discovered, "2026-08-17T05:30:00-05:00", 10), true);
  assert.equal(isTripWithinCriticalWindow(discovered, "2026-08-17T09:30:00-05:00", 10), false);
  assert.equal(isTripWithinCriticalWindow(discovered, "2026-08-16T21:30:00-05:00", 10), false);
});

test("booking rule creates and deduplicates the MQTT payload", async () => {
  const repository = fakeRepository(); const transport = fakeTransport();
  const alertService = createAlertService({ repository, transport });
  const rule = createCriticalBookingRule({ alertService,
    config: { businessTimeZone: "America/Chicago", defaultDeviceId: "bedroom" } });
  const trip = { id: 1234, reservation_id: 60213620, vehicle_name: "Winnie",
    workflow_stage: "booked", trip_start: "2026-09-17T12:30:00-05:00" };
  await rule(trip); await rule(trip);
  assert.equal(repository.alerts.length, 1);
  assert.equal(transport.published.filter((item) => item.topic.endsWith("/alert")).length, 1);
});

test("booking alert policy requires both sleep hours and pickup lead window", () => {
  const settings = { enabled: true, startTime: "21:00", endTime: "07:00", pickupLeadHours: 10 };
  const trip = { trip_start: "2026-08-17T05:30:00-05:00" };
  assert.equal(isBookingAlertEligible(trip, settings, new Date("2026-08-16T22:00:00-05:00")), true);
  assert.equal(isBookingAlertEligible(trip, settings, new Date("2026-08-16T12:00:00-05:00")), false);
  assert.equal(isBookingAlertEligible(trip, settings, new Date("2026-08-16T18:00:00-05:00")), false);
});

test("strict return geofence does not substitute primary parking for another address", () => {
  const parking = [{ id: "park-my-share", label: "Park My Share", kind: "parking",
    isPrimaryParking: true, latitude: 30.22236, longitude: -97.74532, radiusMiles: 0.15 }];
  const row = { return_location: "135 Fletcher Bend, Buda, TX", address: "Austin, TX",
    latitude: 30.22236, longitude: -97.74532 };
  assert.equal(getMatchedTripReturnGeoLocation(row, parking, { strictReturnLocation: true }), null);
  assert.ok(getMatchedTripReturnGeoLocation(row, parking));
});

test("booking reconciliation clears the alarm after confirmation", async () => {
  const repository = fakeRepository(); const transport = fakeTransport();
  const alertService = createAlertService({ repository, transport });
  repository.unconfirmedTrips = [{ id: 1234, reservation_id: 60213620, vehicle_name: "Winnie",
    workflow_stage: "booked", trip_start: "2026-08-17T05:30:00-05:00" }];
  const current = { repository, transport, alertService,
    config: { businessTimeZone: "America/Chicago", defaultDeviceId: "bedroom" } };
  await reconcileBookingAlerts(current, { now: "2026-08-16T22:00:00-05:00" });
  assert.equal(repository.alerts.filter((alert) => !alert.resolved_at).length, 1);
  repository.unconfirmedTrips = [];
  await reconcileBookingAlerts(current, { now: "2026-08-16T22:00:00-05:00" });
  assert.equal(repository.alerts.filter((alert) => !alert.resolved_at).length, 0);
  const desired = transport.published.filter((item) => item.topic.endsWith("/desired-state")).at(-1);
  assert.equal(desired.payload.alert, false);
});

test("MQTT disabled skips publication without losing persisted alert", async () => {
  const repository = fakeRepository();
  const transport = new MQTTTransport({ enabled: false });
  const service = createAlertService({ repository, transport });
  const alert = await service.createAlert({ type: "test", severity: "critical", title: "Test", message: "Wake", deviceId: "bedroom" });
  assert.equal(repository.alerts.length, 1); assert.equal(alert.published_at, null);
});

test("publish failure preserves alert for unresolved recovery", async () => {
  const repository = fakeRepository(); const transport = fakeTransport({ ok: false, reason: "offline" });
  const service = createAlertService({ repository, transport });
  await service.createAlert({ type: "test", severity: "critical", title: "Test", message: "Wake", deviceId: "bedroom" });
  assert.equal(repository.alerts[0].published_at, null);
  transport.publish = async function(topic, payload, options) { this.published.push({ topic, payload, options }); return { ok: true }; };
  assert.equal(await service.republishActiveAlerts(), 1);
  assert.ok(repository.alerts[0].published_at);
});

test("retained recovery state exposes unresolved critical alarm", async () => {
  const repository = fakeRepository(); const transport = fakeTransport();
  const service = createAlertService({ repository, transport });
  await service.createAlert({ type: "test", severity: "critical", title: "Wake", message: "New booking", deviceId: "bedroom" });
  await service.publishDeviceState("bedroom", "ready");
  const retained = transport.published.filter((item) => item.topic === "denmark/devices/bedroom/status").at(-1);
  assert.equal(retained.options.retain, true);
  assert.equal(retained.payload.state, "alarm");
  assert.equal(retained.payload.currentAlert.title, "Wake");
  const desired = transport.published.filter((item) => item.topic === "denmark/devices/bedroom/desired-state").at(-1);
  assert.equal(desired.options.retain, true);
  assert.equal(desired.payload.alert, true);
  assert.equal(desired.payload.alertId, repository.alerts[0].id);
  assert.equal(desired.payload.reason, "test");
});

test("retained desired state clears after the active alert is resolved", async () => {
  const repository = fakeRepository(); const transport = fakeTransport();
  const service = createAlertService({ repository, transport });
  const alert = await service.createAlert({ type: "test", severity: "critical", title: "Wake", message: "New booking", deviceId: "bedroom" });
  await service.resolveAlert(alert.id);
  await service.publishDeviceState("bedroom", "ready");
  const desired = transport.published.filter((item) => item.topic === "denmark/devices/bedroom/desired-state").at(-1);
  assert.equal(desired.options.retain, true);
  assert.deepEqual({ alert: desired.payload.alert, alertId: desired.payload.alertId, reason: desired.payload.reason,
    tripId: desired.payload.tripId }, { alert: false, alertId: null, reason: null, tripId: null });
});

test("ACK handling is idempotent", async () => {
  const repository = fakeRepository(); const service = createAlertService({ repository, transport: fakeTransport() });
  const alert = await service.createAlert({ type: "test", severity: "critical", title: "Test", message: "Wake", deviceId: "bedroom" });
  const first = await service.acknowledgeAlert(alert.id, "device:bedroom", new Date("2026-08-16T06:00:00Z"));
  const duplicate = await service.acknowledgeAlert(alert.id, "device:bedroom", new Date("2026-08-16T06:01:00Z"));
  assert.equal(new Date(duplicate.acknowledged_at).toISOString(), new Date(first.acknowledged_at).toISOString());
});

test("health computation reports ready, degraded, and critical", async () => {
  const ready = createHealthService({ db: { query: async () => ({}) }, transport: { isHealthy: () => true } });
  const degraded = createHealthService({ db: { query: async () => ({}) }, transport: { isHealthy: () => false } });
  const critical = createHealthService({ db: { query: async () => { throw new Error("down"); } }, transport: { isHealthy: () => true } });
  assert.equal((await ready.computeHealth()).health, "ready");
  assert.equal((await degraded.computeHealth()).health, "degraded");
  assert.equal((await critical.computeHealth()).health, "critical");
});

test("malformed MQTT payload is ignored", async () => {
  let acknowledgements = 0;
  const transport = new MQTTTransport({ enabled: true }, { onAck: async () => { acknowledgements += 1; } });
  assert.equal(await transport.handleMessage("denmark/devices/bedroom/ack", Buffer.from("not-json")), false);
  assert.equal(await transport.handleMessage("denmark/devices/bedroom/ack", Buffer.from('{"type":"ack"}')), false);
  assert.equal(acknowledgements, 0);
});

test("valid inbound device status is delegated without creating a device", async () => {
  let received = null;
  const transport = new MQTTTransport({ enabled: true }, { onStatus: async (payload) => { received = payload; } });
  const accepted = await transport.handleMessage("denmark/devices/bedroom/status", Buffer.from(
    '{"device":"bedroom","state":"ready","firmware":"0.1.0","timestamp":"2026-08-16T06:00:00Z"}'
  ));
  assert.equal(accepted, true);
  assert.equal(received.device, "bedroom");
  assert.equal(received.firmware, "0.1.0");
});

test("valid MQTT ACK is still delegated", async () => {
  let received = null;
  const transport = new MQTTTransport({ enabled: true }, { onAck: async (payload) => { received = payload; } });
  const accepted = await transport.handleMessage("denmark/devices/bedroom/ack", Buffer.from(
    '{"type":"ack","device":"bedroom","alertId":"alert-1","timestamp":"2026-08-16T06:00:00Z"}'
  ));
  assert.equal(accepted, true);
  assert.equal(received.alertId, "alert-1");
  assert.equal(received.device, "bedroom");
});

test("runtime startup ensures schema, registers the device, and starts enabled MQTT", async () => {
  const calls = [];
  const repository = fakeRepository();
  repository.ensureSchema = async () => { calls.push("schema"); };
  repository.registerDevice = async (deviceId) => { calls.push(`device:${deviceId}`); };
  const transport = fakeTransport();
  transport.start = () => { calls.push("transport"); };
  const current = {
    config: { defaultDeviceId: "bedroom", heartbeatIntervalMs: 60_000, mqtt: { enabled: true } },
    repository,
    transport,
    alertService: createAlertService({ repository, transport }),
    heartbeatHandle: null,
  };
  await startPhysicalAlertRuntime(current);
  assert.deepEqual(calls, ["schema", "device:bedroom", "transport"]);
});

test("heartbeat remains non-retained and republishes retained device state", async () => {
  const repository = fakeRepository(); const transport = fakeTransport();
  const alertService = createAlertService({ repository, transport });
  await alertService.createAlert({ type: "test", severity: "critical", title: "Wake", message: "Booking", deviceId: "bedroom" });
  transport.published.length = 0;
  const current = {
    config: { defaultDeviceId: "bedroom" }, repository, transport, alertService,
    healthService: { async computeHealth() { return { health: "ready", timestamp: "2026-08-16T06:00:00.000Z" }; } },
  };
  await publishHeartbeats(current);
  const heartbeat = transport.published.find((item) => item.topic === "denmark/devices/bedroom/heartbeat");
  assert.ok(heartbeat);
  assert.notEqual(heartbeat.options?.retain, true);
  const desired = transport.published.find((item) => item.topic === "denmark/devices/bedroom/desired-state");
  assert.equal(desired.payload.alert, true);
  assert.equal(desired.options.retain, true);
});

test("MQTT connect recovery republishes active retained desired state", async () => {
  const repository = fakeRepository(); const published = [];
  const client = new EventEmitter();
  client.subscribe = (_topics, _options, callback) => callback(null);
  client.publish = (topic, payload, options, callback) => { published.push({ topic, payload: JSON.parse(payload), options }); callback(null); };
  const current = {
    config: { defaultDeviceId: "bedroom" }, repository,
    healthService: { async computeHealth() { return { health: "ready", timestamp: "2026-08-16T06:00:00.000Z" }; } },
  };
  current.transport = new MQTTTransport({ enabled: true, url: "mqtt://test", clientId: "test" }, {
    onConnect: async () => publishHeartbeats(current),
  }, () => client);
  current.alertService = createAlertService({ repository, transport: current.transport });
  await repository.createAlert({ type: "test", severity: "critical", title: "Wake", message: "Booking", deviceId: "bedroom" });
  current.transport.start();
  client.emit("connect");
  await new Promise((resolve) => setImmediate(resolve));
  const desired = published.find((item) => item.topic === "denmark/devices/bedroom/desired-state");
  assert.equal(desired.payload.alert, true);
  assert.equal(desired.options.retain, true);
});

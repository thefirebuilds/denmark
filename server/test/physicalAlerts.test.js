const test = require("node:test");
const assert = require("node:assert/strict");
const { createAlertService } = require("../services/physicalAlerts/alertService");
const { createCriticalBookingRule } = require("../services/physicalAlerts/bookingRule");
const { isTripWithinCriticalWindow, isWithinQuietHours } = require("../services/physicalAlerts/config");
const { createHealthService } = require("../services/physicalAlerts/healthService");
const { MQTTTransport } = require("../services/physicalAlerts/mqttTransport");

function fakeRepository() {
  const alerts = [];
  return {
    alerts,
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
    async listAlerts({ active, deviceId } = {}) { return alerts.filter((item) => (!active || !item.resolved_at) && (!deviceId || item.device_id === deviceId)); },
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

test("qualifying booking creates and publishes exactly one alert", async () => {
  const repository = fakeRepository(); const transport = fakeTransport();
  const alertService = createAlertService({ repository, transport });
  const rule = createCriticalBookingRule({ alertService, now: () => new Date("2026-08-16T22:00:00-05:00"),
    config: { quietHoursStart: "21:00", quietHoursEnd: "07:00", businessTimeZone: "America/Chicago",
      criticalTripWindowHours: 10, defaultDeviceId: "bedroom" } });
  const trip = { id: 1234, reservation_id: 60213620, vehicle_name: "Winnie", trip_start: "2026-08-17T05:30:00-05:00" };
  await rule(trip); await rule(trip);
  assert.equal(repository.alerts.length, 1);
  assert.equal(transport.published.filter((item) => item.topic.endsWith("/alert")).length, 1);
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

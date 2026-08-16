const pool = require("../../db");
const { createAlertRepository } = require("./alertRepository");
const { createAlertService } = require("./alertService");
const { getPhysicalAlertConfig } = require("./config");
const { createHealthService } = require("./healthService");
const { MQTTTransport } = require("./mqttTransport");

let runtime = null;

function buildRuntime() {
  if (runtime) return runtime;
  const config = getPhysicalAlertConfig();
  const repository = createAlertRepository(pool);
  let alertService;
  const transport = new MQTTTransport(config.mqtt, {
    onConnect: async () => {
      try {
        await alertService.republishActiveAlerts();
        await publishHeartbeats();
      } catch (error) {
        console.warn(`[physical-alerts] reconnect recovery failed | error=${error.message}`);
      }
    },
    onAck: async (payload) => {
      const alert = await repository.getById(payload.alertId);
      if (!alert || alert.device_id !== payload.device) throw new Error("unknown alert/device");
      await alertService.acknowledgeAlert(payload.alertId, `device:${payload.device}`, payload.timestamp || new Date());
      await alertService.publishDeviceState(payload.device, (await healthService.computeHealth()).health);
    },
    onStatus: async (payload) => {
      const timestamp = payload.timestamp && !Number.isNaN(new Date(payload.timestamp).getTime()) ? new Date(payload.timestamp) : new Date();
      const device = await repository.updateDeviceStatus(payload.device, { ...payload, timestamp });
      if (!device) throw new Error("unregistered or disabled device");
      console.log(`[physical-alerts] device status received | device=${payload.device} state=${payload.state}`);
    },
  });
  alertService = createAlertService({ repository, transport });
  const healthService = createHealthService({
    db: pool,
    transport,
    getWorkerState: () => require("../../startup/startupState").getStartupState(),
  });
  runtime = { config, repository, transport, alertService, healthService, heartbeatHandle: null };
  return runtime;
}

async function publishHeartbeats(current = buildRuntime()) {
  const health = await current.healthService.computeHealth();
  let devices;
  try {
    devices = await current.repository.listDevices();
  } catch (error) {
    const result = await current.transport.publish(
      `denmark/devices/${current.config.defaultDeviceId}/heartbeat`,
      { type: "heartbeat", timestamp: health.timestamp, health: "critical", activeAlerts: null }
    );
    if (!result.ok && !result.skipped) {
      console.warn(`[physical-alerts] heartbeat publish failure | device=${current.config.defaultDeviceId} reason=${result.error || result.reason}`);
    }
    // Preserve the last retained alarm state when PostgreSQL is unavailable;
    // Denmark cannot safely assert that no unresolved critical alert exists.
    return health;
  }
  for (const device of devices.filter((item) => item.enabled)) {
    const active = await current.alertService.getActiveAlerts(device.device_id);
    const heartbeat = await current.transport.publish(`denmark/devices/${device.device_id}/heartbeat`, {
      type: "heartbeat", timestamp: health.timestamp, health: health.health, activeAlerts: active.length,
    });
    if (!heartbeat.ok && !heartbeat.skipped) {
      console.warn(`[physical-alerts] heartbeat publish failure | device=${device.device_id} reason=${heartbeat.error || heartbeat.reason}`);
    }
    await current.alertService.publishDeviceState(device.device_id, health.health);
  }
  return health;
}

async function startPhysicalAlertRuntime(current = buildRuntime()) {
  await current.repository.ensureSchema();
  await current.repository.registerDevice(current.config.defaultDeviceId, "Bedroom alert");
  try {
    current.transport.start();
  } catch (error) {
    console.warn(`[physical-alerts] MQTT startup failed; reconnect remains available | error=${error.message}`);
  }
  if (!current.heartbeatHandle) {
    current.heartbeatHandle = setInterval(() => void publishHeartbeats(current).catch((error) =>
      console.warn(`[physical-alerts] heartbeat publish failure | error=${error.message}`)), current.config.heartbeatIntervalMs);
    current.heartbeatHandle.unref?.();
  }
  if (!current.config.mqtt.enabled) await publishHeartbeats(current);
  return current;
}

module.exports = { buildRuntime, publishHeartbeats, startPhysicalAlertRuntime };

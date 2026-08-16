const SEVERITY_RANK = { critical: 4, urgent: 3, warning: 2, info: 1 };

function toAlertPayload(alert) {
  return {
    type: "alert",
    id: alert.id,
    severity: alert.severity,
    title: alert.title,
    message: alert.message,
    tripId: alert.trip_id || null,
    createdAt: new Date(alert.created_at).toISOString(),
  };
}

function createAlertService({ repository, transport }) {
  async function publishAlert(alert) {
    if (!alert?.device_id) return { ok: false, skipped: true, reason: "no_device" };
    const result = await transport.publish(`denmark/devices/${alert.device_id}/alert`, toAlertPayload(alert));
    if (result.ok) {
      await repository.markPublished(alert.id);
      console.log(`[physical-alerts] alert published | id=${alert.id} device=${alert.device_id}`);
    } else if (!result.skipped) {
      console.warn(`[physical-alerts] alert publication failed | id=${alert.id} device=${alert.device_id} reason=${result.error || result.reason}`);
    }
    return result;
  }

  const service = {
    async createAlert(input) {
      const alert = await repository.createAlert(input);
      if (alert.inserted) console.log(`[physical-alerts] alert created | id=${alert.id} type=${alert.type} device=${alert.device_id || "none"}`);
      if (alert.inserted || !alert.published_at) await publishAlert(alert);
      if (alert.device_id) await service.publishDeviceState(alert.device_id);
      return alert;
    },
    publishAlert,
    async acknowledgeAlert(id, by, at) {
      const alert = await repository.acknowledge(id, by, at);
      if (alert) console.log(`[physical-alerts] alert acknowledged | id=${id} by=${by}`);
      return alert;
    },
    async resolveAlert(id, at) {
      const alert = await repository.resolve(id, at);
      if (alert) console.log(`[physical-alerts] alert resolved | id=${id}`);
      return alert;
    },
    getActiveAlerts: (deviceId) => repository.listAlerts({ active: true, deviceId }),
    async republishActiveAlerts(deviceId = null) {
      const alerts = await repository.listAlerts({ active: true, deviceId });
      for (const alert of alerts) await publishAlert(alert);
      return alerts.length;
    },
    async publishDeviceState(deviceId, health = "ready") {
      const active = await repository.listAlerts({ active: true, deviceId });
      const current = [...active].sort((a, b) =>
        (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0) || new Date(a.created_at) - new Date(b.created_at))[0] || null;
      const state = current?.severity === "critical" ? "alarm" : health === "critical" ? "offline" : health;
      return transport.publish(`denmark/devices/${deviceId}/status`, {
        type: "device_state", device: deviceId, state, health,
        activeAlerts: active.length,
        currentAlert: current ? toAlertPayload(current) : null,
        timestamp: new Date().toISOString(),
      }, { retain: true });
    },
  };
  return service;
}

module.exports = { createAlertService, toAlertPayload };

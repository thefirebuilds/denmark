const mqtt = require("mqtt");

function parseJsonPayload(buffer) {
  try {
    const value = JSON.parse(buffer.toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch (_) {
    return null;
  }
}

class MQTTTransport {
  constructor(config, handlers = {}) {
    this.config = config;
    this.handlers = handlers;
    this.client = null;
    this.connected = false;
  }

  isEnabled() { return this.config.enabled === true; }
  isHealthy() { return !this.isEnabled() || this.connected; }

  start() {
    if (!this.isEnabled()) {
      console.log("[physical-alerts] MQTT disabled");
      return;
    }
    if (!this.config.url) {
      console.warn("[physical-alerts] MQTT enabled but MQTT_URL is empty");
      return;
    }
    this.client = mqtt.connect(this.config.url, {
      username: this.config.username,
      password: this.config.password,
      clientId: this.config.clientId,
      reconnectPeriod: 5000,
      connectTimeout: 10000,
      clean: true,
    });
    this.client.on("connect", () => {
      this.connected = true;
      console.log("[physical-alerts] MQTT connected");
      this.client.subscribe(["denmark/devices/+/ack", "denmark/devices/+/status"], { qos: 1 }, (error) => {
        if (error) console.warn(`[physical-alerts] MQTT subscribe failed | error=${error.message}`);
      });
      void this.handlers.onConnect?.();
    });
    this.client.on("reconnect", () => console.log("[physical-alerts] MQTT reconnect"));
    this.client.on("close", () => {
      if (this.connected) console.warn("[physical-alerts] MQTT disconnected");
      this.connected = false;
    });
    this.client.on("offline", () => { this.connected = false; });
    this.client.on("error", (error) => console.warn(`[physical-alerts] MQTT error | error=${error.message}`));
    this.client.on("message", (topic, payload) => void this.handleMessage(topic, payload));
  }

  async handleMessage(topic, payloadBuffer) {
    const match = String(topic).match(/^denmark\/devices\/([^/]+)\/(ack|status)$/);
    const payload = parseJsonPayload(payloadBuffer);
    if (!match || !payload) {
      console.warn(`[physical-alerts] malformed device message | topic=${topic}`);
      return false;
    }
    const [, topicDeviceId, kind] = match;
    try {
      if (kind === "ack") {
        if (payload.type !== "ack" || typeof payload.alertId !== "string" || !payload.alertId.trim() ||
          (payload.device && payload.device !== topicDeviceId) ||
          (payload.timestamp && Number.isNaN(new Date(payload.timestamp).getTime()))) {
          throw new Error("invalid ACK payload");
        }
        await this.handlers.onAck?.({ ...payload, device: topicDeviceId });
      } else {
        if (payload.type === "device_state") return true;
        if (!["ready", "degraded", "offline", "alarm"].includes(payload.state) ||
          (payload.device && payload.device !== topicDeviceId) ||
          (payload.timestamp && Number.isNaN(new Date(payload.timestamp).getTime()))) {
          throw new Error("invalid status payload");
        }
        await this.handlers.onStatus?.({ ...payload, device: topicDeviceId });
      }
      return true;
    } catch (error) {
      console.warn(`[physical-alerts] malformed device message | topic=${topic} error=${error.message}`);
      return false;
    }
  }

  publish(topic, payload, options = {}) {
    if (!this.isEnabled()) return Promise.resolve({ ok: false, skipped: true, reason: "mqtt_disabled" });
    if (!this.client || !this.connected) return Promise.resolve({ ok: false, reason: "mqtt_unavailable" });
    return new Promise((resolve) => {
      this.client.publish(topic, JSON.stringify(payload), { qos: 1, retain: options.retain === true }, (error) => {
        if (error) resolve({ ok: false, error: error.message });
        else resolve({ ok: true });
      });
    });
  }

  stop() {
    if (this.client) this.client.end(true);
    this.client = null;
    this.connected = false;
  }
}

module.exports = { MQTTTransport, parseJsonPayload };

# Physical alert devices

Denmark's physical-alert subsystem keeps alert lifecycle state in PostgreSQL and uses MQTT only as a delivery adapter. Trip ingestion calls the critical-booking rule, the alert service persists first, and the MQTT transport publishes afterward. A broker failure therefore cannot discard an alert.

## Configuration

Set `MQTT_ENABLED=true`, `MQTT_URL`, and, when required, `MQTT_USERNAME` and `MQTT_PASSWORD`. `MQTT_CLIENT_ID` defaults to `denmark`. Booking behavior is controlled by `ALERT_DEFAULT_DEVICE_ID` (`bedroom`), `ALERT_QUIET_HOURS_START` (`21:00`), `ALERT_QUIET_HOURS_END` (`07:00`), `ALERT_CRITICAL_TRIP_WINDOW_HOURS` (`10`), and `BUSINESS_TIMEZONE` (`America/Chicago`). Credentials are never logged.

MQTT may remain disabled; alerts are still persisted. The startup schema registers the configured default device. Device status does not create unknown devices.

## Topics and messages

- `denmark/devices/{deviceId}/alert`: one alert publication, QoS 1.
- `denmark/devices/{deviceId}/heartbeat`: Denmark health every 30 seconds.
- `denmark/devices/{deviceId}/status`: retained current state from Denmark; devices may also publish their online status here.
- `denmark/devices/{deviceId}/ack`: device acknowledgement inbound.

Alert messages contain `type`, stable `id`, `severity`, `title`, `message`, optional `tripId`, and `createdAt`. ACK messages use `{"type":"ack","alertId":"...","device":"bedroom","timestamp":"..."}`. Device status uses `{"device":"bedroom","state":"ready","firmware":"0.1.0","timestamp":"..."}`. Invalid JSON, mismatched device IDs, unknown alerts, and unknown devices are logged and ignored.

The retained status state is `ready`, `degraded`, `offline`, or `alarm`. Any unresolved critical alert assigned to the device forces `alarm` and includes the current highest-priority alert. Acknowledgement is idempotent and retained for audit; resolution is a separate action.

Health is `ready`, `degraded`, or `critical`. It currently verifies PostgreSQL, the MQTT connection when enabled, and reports startup/background-worker state. It does not claim health checks that Denmark cannot measure reliably.

## Recovery

On MQTT reconnect, Denmark republishes all unresolved alerts and retained current device state. The same happens after a Denmark restart once startup schema checks finish and MQTT reconnects. Rebooting a device does not acknowledge or resolve anything.

## Local broker and manual testing

The Compose file includes Mosquitto bound to localhost with anonymous access for local development only. Production should use a secured broker and environment-provided credentials.

```sh
docker compose up -d mosquitto
mosquitto_sub -h localhost -t 'denmark/devices/bedroom/#' -v
```

Create a test alert through Denmark's authenticated API:

```sh
curl -X POST http://localhost:5000/api/alerts -H 'Content-Type: application/json' \
  -d '{"severity":"critical","title":"Device test","message":"Wake test","deviceId":"bedroom"}'
```

Publish a fake acknowledgement using the returned alert ID:

```sh
mosquitto_pub -h localhost -t denmark/devices/bedroom/ack \
  -m '{"type":"ack","alertId":"ALERT_ID","device":"bedroom","timestamp":"2026-08-16T06:00:00Z"}'
```

Debug APIs are `GET /api/alerts`, `GET /api/alerts/active`, `GET /api/devices`, `GET /api/devices/:deviceId`, `POST /api/alerts/:id/ack`, and `POST /api/alerts/:id/resolve`. They use Denmark's existing settings read/write permissions.

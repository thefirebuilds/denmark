const https = require("https");
const { getEffectiveSmsAlertSettings } = require("./smsAlertSettings");

async function getTwilioConfig() {
  const settings = await getEffectiveSmsAlertSettings();

  return {
    accountSid: settings.accountSid,
    authToken: settings.authToken,
    from: settings.senderNumber,
    to: settings.receiverNumber,
    enabled: settings.enabled !== false && settings.configured,
    alertsEnabled: settings.enabled !== false,
    configured: settings.configured,
    source: settings.source,
  };
}

async function sendSms(body, options = {}) {
  const config = await getTwilioConfig();
  if (!config.alertsEnabled) {
    return {
      ok: false,
      skipped: true,
      reason: "sms_alerts_disabled",
    };
  }

  if (!config.configured) {
    return {
      ok: false,
      skipped: true,
      reason: "missing_twilio_config",
    };
  }

  const payload = new URLSearchParams({
    From: config.from,
    To: options.to || config.to,
    Body: String(body || "").slice(0, 1500),
  }).toString();

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.twilio.com",
        path: `/2010-04-01/Accounts/${encodeURIComponent(
          config.accountSid
        )}/Messages.json`,
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(
            `${config.accountSid}:${config.authToken}`
          ).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          let parsed = {};
          try {
            parsed = JSON.parse(data);
          } catch {
            parsed = {};
          }

          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({
              ok: true,
              sid: parsed.sid,
              status: parsed.status,
            });
            return;
          }

          const error = new Error(parsed.message || `Twilio HTTP ${res.statusCode}`);
          error.statusCode = res.statusCode;
          error.code = parsed.code;
          error.moreInfo = parsed.more_info;
          reject(error);
        });
      }
    );

    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

module.exports = {
  getTwilioConfig,
  sendSms,
};

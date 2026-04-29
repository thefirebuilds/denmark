const express = require("express");
const crypto = require("crypto");
const { google } = require("googleapis");
const {
  getOAuthClient,
  getAuthUrl,
  exchangeCodeForTokens,
} = require("../services/googleCalendar/googleCalendarAuth");
const {
  upsertGoogleCalendarConnection,
  getGoogleCalendarConnection,
  saveSelectedCalendar,
} = require("../services/googleCalendar/googleCalendarStore");
const {
  syncTripToGoogle,
  reconcileTripsToGoogle,
} = require("../services/googleCalendar/googleTripSync");

const router = express.Router();

function getRouteUserId(req) {
  return req?.auth?.kind === "user" ? req.auth.userId : null;
}

router.post("/sync-trip/:tripId", async (req, res, next) => {
  try {
    const tripId = Number(req.params.tripId);

    if (!Number.isInteger(tripId) || tripId <= 0) {
      return res.status(400).json({ error: "Invalid tripId" });
    }

    const result = await syncTripToGoogle(tripId, getRouteUserId(req));
    return res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});

router.post("/reconcile-trips", async (req, res, next) => {
  try {
    const limit = Number(req.body?.limit || 500);
    const result = await reconcileTripsToGoogle({ userId: getRouteUserId(req), limit });
    return res.json(result);
  } catch (err) {
    next(err);
  }
});

router.get("/ping", (req, res) => {
  res.send("pong from googleCalendar");
});

router.post("/test-event", async (req, res, next) => {
  try {
    const userId = getRouteUserId(req);
    const connection = await getGoogleCalendarConnection(userId);

    if (!connection) {
      return res.status(404).json({ error: "No Google Calendar connection found" });
    }

    if (!connection.calendar_id) {
      return res.status(400).json({ error: "No selected calendar_id saved" });
    }

    const oauth2Client = getOAuthClient();
    oauth2Client.setCredentials({
      refresh_token: connection.refresh_token,
    });

    const calendar = google.calendar({ version: "v3", auth: oauth2Client });

    const event = await calendar.events.insert({
      calendarId: connection.calendar_id,
      requestBody: {
        summary: "Denmark test event",
        description: "Smoke test from Denmark Google Calendar integration",
        start: {
          dateTime: "2026-04-23T10:00:00-05:00",
          timeZone: "America/Chicago",
        },
        end: {
          dateTime: "2026-04-23T10:30:00-05:00",
          timeZone: "America/Chicago",
        },
      },
    });

    return res.json({
      ok: true,
      calendarId: connection.calendar_id,
      eventId: event.data.id,
      htmlLink: event.data.htmlLink,
    });
  } catch (err) {
    next(err);
  }
});

router.get("/connect", (req, res) => {
  const state = crypto.randomBytes(24).toString("hex");
  req.session.googleCalendarState = state;

  const authUrl = getAuthUrl(state);
  return res.redirect(authUrl);
});

router.get("/callback", async (req, res, next) => {
  try {
    const { code, state } = req.query;

    if (!code) {
      return res.status(400).json({ error: "Missing code" });
    }

    if (!state || state !== req.session.googleCalendarState) {
      return res.status(400).json({ error: "Invalid state" });
    }

    const tokens = await exchangeCodeForTokens(code);
    delete req.session.googleCalendarState;

    if (!tokens.refresh_token) {
      return res.status(400).json({
        error:
          "No refresh token returned by Google. Re-consent may be required.",
      });
    }

    const oauth2Client = getOAuthClient();
    oauth2Client.setCredentials(tokens);

    const calendar = google.calendar({ version: "v3", auth: oauth2Client });
    const response = await calendar.calendarList.list();

    const calendars = (response.data.items || []).map((c) => ({
      id: c.id,
      summary: c.summary,
      accessRole: c.accessRole,
      primary: !!c.primary,
    }));

    const userId = getRouteUserId(req);

    await upsertGoogleCalendarConnection({
      userId,
      googleEmail: null,
      refreshToken: tokens.refresh_token,
      scopeString: tokens.scope || null,
    });

    console.log("Google Calendar auth succeeded");
    console.log("Available calendars:", calendars);

    const frontendBaseUrl = process.env.FRONTEND_BASE_URL || "http://localhost:5173";
        return res.redirect(
        `${frontendBaseUrl}/settings?googleCalendar=connected`
        );
  } catch (err) {
    next(err);
  }
});

router.get("/calendars", async (req, res, next) => {
  try {
    const userId = getRouteUserId(req);
    const connection = await getGoogleCalendarConnection(userId);

    if (!connection) {
      return res.status(404).json({ error: "No Google Calendar connection found" });
    }

    const oauth2Client = getOAuthClient();
    oauth2Client.setCredentials({
      refresh_token: connection.refresh_token,
    });

    const calendar = google.calendar({ version: "v3", auth: oauth2Client });
    const response = await calendar.calendarList.list();

    const calendars = (response.data.items || []).map((c) => ({
      id: c.id,
      summary: c.summary,
      accessRole: c.accessRole,
      primary: !!c.primary,
      selected: connection.calendar_id === c.id,
    }));

    return res.json(calendars);
  } catch (err) {
    next(err);
  }
});

router.post("/select-calendar", async (req, res, next) => {
  try {
    const { calendarId, calendarSummary } = req.body;

    if (!calendarId) {
      return res.status(400).json({ error: "calendarId is required" });
    }

    const userId = getRouteUserId(req);

    const updated = await saveSelectedCalendar({
      userId,
      calendarId,
      calendarSummary: calendarSummary || null,
    });

    if (!updated) {
      return res.status(404).json({ error: "No Google Calendar connection found" });
    }

    return res.json({
      ok: true,
      calendarId: updated.calendar_id,
      calendarSummary: updated.calendar_summary,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

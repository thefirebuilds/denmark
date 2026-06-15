const express = require("express");
const crypto = require("crypto");
const { google } = require("googleapis");
const pool = require("../db");
const {
  getOAuthClient,
  getAuthUrl,
  exchangeCodeForTokens,
} = require("../services/googleCalendar/googleCalendarAuth");
const {
  upsertGoogleCalendarConnection,
  getGoogleCalendarConnection,
  markGoogleCalendarConnectionHealth,
  saveSelectedCalendar,
} = require("../services/googleCalendar/googleCalendarStore");
const {
  syncTripToGoogle,
  reconcileTripsToGoogle,
} = require("../services/googleCalendar/googleTripSync");
const { logRequestActivity } = require("../services/systemActivityLog");
const {
  resolveAuthPublicUrlSettings,
  computeGoogleRedirectUri,
} = require("../services/authPublicUrlSettings");

const router = express.Router();
const GOOGLE_CALENDAR_CALLBACK_PATH = "/api/integrations/google-calendar/callback";

function getRouteUserId(req) {
  return req?.auth?.kind === "user" ? req.auth.userId : null;
}

function getGoogleApiErrorCode(err) {
  return (
    err?.response?.data?.error ||
    err?.errors?.[0]?.reason ||
    err?.code ||
    err?.message ||
    "unknown_error"
  );
}

function buildGoogleCalendarRedirectUri(publicUrlSettings) {
  return computeGoogleRedirectUri(
    publicUrlSettings.effectivePublicBaseUrl || publicUrlSettings.publicBaseUrl,
    GOOGLE_CALENDAR_CALLBACK_PATH
  );
}

async function getGoogleCalendarSyncStats(connectionId) {
  if (!connectionId) {
    return {
      syncedEvents: 0,
      syncedTrips: 0,
      lastSyncedAt: null,
    };
  }

  const { rows } = await pool.query(
    `
      SELECT
        COUNT(*) FILTER (WHERE sync_status = 'synced')::int AS synced_events,
        COUNT(DISTINCT trip_id) FILTER (WHERE sync_status = 'synced')::int AS synced_trips,
        MAX(last_synced_at) AS last_synced_at
      FROM trip_google_sync
      WHERE google_calendar_connection_id = $1
    `,
    [connectionId]
  );

  return {
    syncedEvents: rows[0]?.synced_events || 0,
    syncedTrips: rows[0]?.synced_trips || 0,
    lastSyncedAt: rows[0]?.last_synced_at || null,
  };
}

router.post("/sync-trip/:tripId", async (req, res, next) => {
  try {
    const tripId = Number(req.params.tripId);

    if (!Number.isInteger(tripId) || tripId <= 0) {
      return res.status(400).json({ error: "Invalid tripId" });
    }

    const result = await syncTripToGoogle(tripId, getRouteUserId(req));
    await logRequestActivity(req, {
      category: "integration",
      eventType: "google_calendar_trip_sync_requested",
      subjectType: "trip",
      subjectId: String(tripId),
      source: "google-calendar",
      details: {
        result,
      },
    }).catch(() => null);
    return res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});

router.post("/reconcile-trips", async (req, res, next) => {
  try {
    const limit = Number(req.body?.limit || 500);
    const result = await reconcileTripsToGoogle({ userId: getRouteUserId(req), limit });
    await logRequestActivity(req, {
      category: "integration",
      eventType: "google_calendar_reconcile_requested",
      source: "google-calendar",
      details: {
        limit,
        processed: result?.processed ?? null,
      },
    }).catch(() => null);
    return res.json(result);
  } catch (err) {
    next(err);
  }
});

router.get("/ping", (req, res) => {
  res.send("pong from googleCalendar");
});

router.get("/status", async (req, res, next) => {
  try {
    const userId = getRouteUserId(req);
    const connection = await getGoogleCalendarConnection(userId);

    if (!connection) {
      return res.json({
        configured: false,
        connected: false,
        tokenStatus: "missing",
        selectedCalendar: null,
        sync: await getGoogleCalendarSyncStats(null),
      });
    }

    const selectedCalendar = connection.calendar_id
      ? {
          id: connection.calendar_id,
          summary: connection.calendar_summary,
        }
      : null;

    const payload = {
      configured: true,
      connected: false,
      tokenStatus: "unknown",
      tokenError: null,
      selectedCalendar,
      connection: {
        id: connection.id,
        userId: connection.user_id,
        updatedAt: connection.updated_at,
      },
      sync: await getGoogleCalendarSyncStats(connection.id),
    };

    if (!connection.calendar_id) {
      return res.json({
        ...payload,
        tokenStatus: "no_calendar_selected",
      });
    }

    const oauth2Client = getOAuthClient();
    oauth2Client.setCredentials({
      refresh_token: connection.refresh_token,
    });

    const calendar = google.calendar({ version: "v3", auth: oauth2Client });

    try {
      await calendar.calendarList.get({
        calendarId: connection.calendar_id,
      });
      await markGoogleCalendarConnectionHealth({
        connectionId: connection.id,
        tokenStatus: "valid",
        tokenError: null,
      });

      return res.json({
        ...payload,
        connected: true,
        tokenStatus: "valid",
      });
    } catch (err) {
      const tokenError = getGoogleApiErrorCode(err);
      await markGoogleCalendarConnectionHealth({
        connectionId: connection.id,
        tokenStatus: "invalid",
        tokenError,
      });

      return res.json({
        ...payload,
        connected: false,
        tokenStatus: "invalid",
        tokenError,
      });
    }
  } catch (err) {
    next(err);
  }
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

    await logRequestActivity(req, {
      category: "integration",
      eventType: "google_calendar_test_event_created",
      subjectType: "google_calendar",
      subjectId: connection.calendar_id,
      subjectLabel: connection.calendar_summary || connection.calendar_id,
      source: "google-calendar",
      details: {
        eventId: event.data.id,
        htmlLink: event.data.htmlLink,
      },
    }).catch(() => null);

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

router.get("/connect", async (req, res, next) => {
  try {
    const state = crypto.randomBytes(24).toString("hex");
    const publicUrl = await resolveAuthPublicUrlSettings(req);
    const redirectUri = buildGoogleCalendarRedirectUri(publicUrl);
    req.session.googleCalendarState = state;
    req.session.googleCalendarRedirectUri = redirectUri;

    void logRequestActivity(req, {
      category: "integration",
      eventType: "google_calendar_connect_started",
      subjectType: "integration",
      subjectId: "google-calendar",
      subjectLabel: "Google Calendar",
      source: "google-calendar",
    }).catch(() => null);

    console.log(`[google-calendar] oauth redirect uri: ${redirectUri}`);
    const authUrl = getAuthUrl(state, redirectUri);
    return res.redirect(authUrl);
  } catch (err) {
    next(err);
  }
});

router.get("/callback", async (req, res, next) => {
  try {
    const { code, state } = req.query;

    if (!code) {
      await logRequestActivity(req, {
        category: "integration",
        eventType: "google_calendar_connect_failed",
        severity: "warning",
        outcome: "failure",
        subjectType: "integration",
        subjectId: "google-calendar",
        source: "google-calendar",
        details: { reason: "missing_code" },
      }).catch(() => null);
      return res.status(400).json({ error: "Missing code" });
    }

    if (!state || state !== req.session.googleCalendarState) {
      await logRequestActivity(req, {
        category: "integration",
        eventType: "google_calendar_connect_failed",
        severity: "warning",
        outcome: "failure",
        subjectType: "integration",
        subjectId: "google-calendar",
        source: "google-calendar",
        details: { reason: "invalid_state" },
      }).catch(() => null);
      return res.status(400).json({ error: "Invalid state" });
    }

    const publicUrl = await resolveAuthPublicUrlSettings(req);
    const redirectUri =
      req.session.googleCalendarRedirectUri ||
      buildGoogleCalendarRedirectUri(publicUrl);
    console.log(`[google-calendar] oauth redirect uri: ${redirectUri}`);
    const tokens = await exchangeCodeForTokens(code, redirectUri);
    delete req.session.googleCalendarState;
    delete req.session.googleCalendarRedirectUri;

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

    await logRequestActivity(req, {
      category: "integration",
      eventType: "google_calendar_connected",
      severity: "notice",
      subjectType: "integration",
      subjectId: "google-calendar",
      subjectLabel: "Google Calendar",
      source: "google-calendar",
      details: {
        calendarCount: calendars.length,
        scopes: tokens.scope || null,
      },
    }).catch(() => null);

    console.log("Google Calendar auth succeeded");
    console.log("Available calendars:", calendars);

    void reconcileTripsToGoogle({ userId, limit: 500 }).catch((err) => {
      console.warn(
        "[google-calendar] reconcile after reconnect failed:",
        err.message || err
      );
    });

    return res.redirect(
      `${publicUrl.effectivePublicBaseUrl || ""}/settings?googleCalendar=connected`
    );
  } catch (err) {
    await logRequestActivity(req, {
      category: "integration",
      eventType: "google_calendar_connect_failed",
      severity: "error",
      outcome: "failure",
      subjectType: "integration",
      subjectId: "google-calendar",
      source: "google-calendar",
      details: {
        error: err.message || String(err),
      },
    }).catch(() => null);
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

    await logRequestActivity(req, {
      category: "integration",
      eventType: "google_calendar_selected_calendar_changed",
      severity: "notice",
      subjectType: "google_calendar",
      subjectId: updated.calendar_id,
      subjectLabel: updated.calendar_summary || updated.calendar_id,
      source: "google-calendar",
      details: {
        connectionId: updated.id,
      },
    }).catch(() => null);

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

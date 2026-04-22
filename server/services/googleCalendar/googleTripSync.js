const { google } = require("googleapis");
const { getOAuthClient } = require("./googleCalendarAuth");
const { getGoogleCalendarConnection } = require("./googleCalendarStore");
const { getTripById, getTripsForGoogleCalendarReconcile } = require("./tripStore");
const {
  getAllTripGoogleSync,
  upsertTripGoogleSync,
  markTripGoogleSyncDeleted,
} = require("./tripGoogleSyncStore");
const { getDesiredGoogleEventsForTrip } = require("./googleTripEventBuilder");

function buildSyncMap(rows) {
  const map = new Map();
  for (const row of rows) {
    map.set(row.event_type, row);
  }
  return map;
}

async function deleteGoogleEventIfPresent(calendar, calendarId, syncRow) {
  if (!syncRow?.google_event_id) return;

  try {
    await calendar.events.delete({
      calendarId,
      eventId: syncRow.google_event_id,
    });
  } catch (err) {
    const status = err?.code || err?.response?.status;
    if (status !== 404 && status !== 410) {
      throw err;
    }
  }
}

async function upsertGoogleEvent({
  calendar,
  calendarId,
  existingSync,
  eventPayload,
}) {
  if (!existingSync || !existingSync.google_event_id || existingSync.sync_status === "deleted") {
    const created = await calendar.events.insert({
      calendarId,
      requestBody: eventPayload,
    });
    return created.data;
  }

  const updated = await calendar.events.patch({
    calendarId,
    eventId: existingSync.google_event_id,
    requestBody: eventPayload,
  });

  return updated.data;
}

async function syncTripToGoogle(tripId, userId = null) {
  const trip = await getTripById(tripId);
  if (!trip) {
    throw new Error(`Trip ${tripId} not found`);
  }

  const connection = await getGoogleCalendarConnection(userId);
  if (!connection) {
    throw new Error("No Google Calendar connection found");
  }

  if (!connection.calendar_id) {
    throw new Error("No Google calendar selected");
  }

  const oauth2Client = getOAuthClient();
  oauth2Client.setCredentials({
    refresh_token: connection.refresh_token,
  });

  const calendar = google.calendar({ version: "v3", auth: oauth2Client });

  const desiredEvents = getDesiredGoogleEventsForTrip(trip);
  const existingSyncRows = await getAllTripGoogleSync(trip.id, connection.id);
  const existingSyncMap = buildSyncMap(existingSyncRows);

  const results = [];

  for (const desired of desiredEvents) {
    const existingSync = existingSyncMap.get(desired.eventType) || null;

    const event = await upsertGoogleEvent({
      calendar,
      calendarId: connection.calendar_id,
      existingSync,
      eventPayload: desired.payload,
    });

    await upsertTripGoogleSync({
      tripId: trip.id,
      googleCalendarConnectionId: connection.id,
      eventType: desired.eventType,
      googleEventId: event.id,
      syncStatus: "synced",
    });

    results.push({
      eventType: desired.eventType,
      eventId: event.id,
      htmlLink: event.htmlLink,
      summary: event.summary,
    });
  }

  const desiredTypes = new Set(desiredEvents.map((e) => e.eventType));

  for (const existingSync of existingSyncRows) {
    if (!desiredTypes.has(existingSync.event_type) && existingSync.sync_status !== "deleted") {
      await deleteGoogleEventIfPresent(calendar, connection.calendar_id, existingSync);
      await markTripGoogleSyncDeleted(trip.id, connection.id, existingSync.event_type);
    }
  }

  return {
    tripId: trip.id,
    calendarId: connection.calendar_id,
    syncedEvents: results,
    desiredEventTypes: [...desiredTypes],
  };
}

async function reconcileTripsToGoogle({ userId = null, limit = 500 } = {}) {
  const trips = await getTripsForGoogleCalendarReconcile(limit);
  const results = [];

  for (const trip of trips) {
    try {
      const result = await syncTripToGoogle(trip.id, userId);
      results.push({
        tripId: trip.id,
        ok: true,
        desiredEventTypes: result.desiredEventTypes,
      });
    } catch (err) {
      results.push({
        tripId: trip.id,
        ok: false,
        error: err.message,
      });
    }
  }

  return {
    ok: true,
    processed: results.length,
    results,
  };
}

module.exports = {
  syncTripToGoogle,
  reconcileTripsToGoogle,
};
const express = require("express");
const router = express.Router();
const db = require("../db");

function parseSubject(subject) {
  if (!subject) return { type: "unknown" };

  let m;

  m = subject.match(/^(.+?) has sent you a message about your (.+)$/i);
  if (m) {
    return {
      type: "guest_message",
      guest: m[1],
      vehicle: m[2],
    };
  }

  m = subject.match(/^(.+?) has changed their trip with your (.+?) \((\d+)\)$/i);
  if (m) {
    return {
      type: "trip_changed",
      guest: m[1],
      vehicle: m[2],
      tripId: m[3],
    };
  }

  m = subject.match(/^Your (.+?) has been relisted/i);
  if (m) {
    return {
      type: "vehicle_relisted",
      vehicle: m[1],
    };
  }

  return { type: "unknown" };
}

router.get("/stats", async (req, res) => {
  try {
    const sql = `
      SELECT
        COUNT(*) FILTER (WHERE status = 'unread') AS unread_count,
        COUNT(*) FILTER (WHERE status = 'read') AS read_count,
        COUNT(*) FILTER (WHERE message_type = 'guest_message') AS guest_message_count,
        COUNT(*) FILTER (WHERE message_type = 'trip_booked') AS trip_booked_count,
        COUNT(*) FILTER (WHERE message_type = 'trip_changed') AS trip_changed_count,
        COUNT(*) FILTER (WHERE message_type = 'payment_notice') AS payment_notice_count,
        COUNT(*) FILTER (WHERE message_type = 'trip_rated') AS trip_rated_count,
        COUNT(*) FILTER (WHERE message_type IS NULL OR message_type = 'unknown') AS unknown_count,
        COUNT(*) AS total_count,
        MAX(message_timestamp) AS last_received
      FROM messages
    `;

    const result = await db.query(sql);
    const row = result.rows[0];

    res.json({
      unread: Number(row.unread_count || 0),
      read: Number(row.read_count || 0),
      guestMessages: Number(row.guest_message_count || 0),
      tripsBooked: Number(row.trip_booked_count || 0),
      tripsChanged: Number(row.trip_changed_count || 0),
      paymentNotices: Number(row.payment_notice_count || 0),
      tripsRated: Number(row.trip_rated_count || 0),
      unknown: Number(row.unknown_count || 0),
      total: Number(row.total_count || 0),
      lastReceived: row.last_received,
    });
  } catch (err) {
    console.error("message stats endpoint failed:", err);
    res.status(500).json({ error: "failed to load message stats" });
  }
});

router.get("/", async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 100;

    const sql = `
      SELECT
        id,
        message_id,
        subject,
        recipients,
        mailbox,
        message_timestamp,
        status,
        amount,
        guest_message,
        message_type,
        guest_name,
        vehicle_name,
        trip_start,
        trip_end,
        reservation_id,
        reply_url,
        trip_details_url
        FROM messages
        WHERE status = 'unread'
        ORDER BY message_timestamp DESC NULLS LAST, id DESC
        LIMIT $1
    `;

    const result = await db.query(sql, [limit]);

    const messages = result.rows.map((row) => ({
      id: row.id,
      messageId: row.message_id,
      subject: row.subject,
      sender: row.sender,
      status: row.status,
      timestamp: row.message_timestamp,
      amount: row.amount,
      type: row.message_type,
      guest_message: row.guest_message,
      guest_name: row.guest_name,
      vehicle_name: row.vehicle_name,
      trip_start: row.trip_start,
      trip_end: row.trip_end,
      new_trip_end: row.trip_end,
      reservation_id: row.reservation_id,
      reply_url: row.reply_url,
      trip_details_url: row.trip_details_url,
      parsed: parseSubject(row.subject),
    }));

    res.json(messages);
  } catch (err) {
    console.error("messages endpoint failed:", err);
    res.status(500).json({ error: "failed to load messages" });
  }
});

router.patch("/:id/read", async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: "invalid message id" });
    }

    const sql = `
      UPDATE messages
      SET status = 'read'
      WHERE id = $1
      RETURNING id, status
    `;

    const result = await db.query(sql, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "message not found" });
    }

    res.json({
      success: true,
      id: result.rows[0].id,
      status: result.rows[0].status,
    });
  } catch (err) {
    console.error("mark as read failed:", err);
    res.status(500).json({ error: "failed to mark message as read" });
  }
});

router.get("/:id", async (req, res) => {
  try {

    const id = Number(req.params.id);

    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: "invalid message id" });
    }

const sql = `
  SELECT
    id,
    message_id,
    subject,
    sender,
    body,
    received_at,
    created_at,
    status,
    mailbox,
    imap_uid,
    from_header,
    to_header,
    cc_header,
    bcc_header,
    reply_to_header,
    date_header,
    message_timestamp,
    in_reply_to,
    references_header,
    content_type_header,
    flags,
    ingested_at,
    amount,
    normalized_text_body,
    html_body,
    guest_name,
    guest_phone,
    guest_profile_url,
    vehicle_name,
    vehicle_year,
    reservation_id,
    trip_start,
    trip_end,
    mileage_included,
    guest_message,
    reply_url,
    trip_details_url,
    message_type,
    vehicle_listing_id
  FROM messages
  WHERE id = $1
  LIMIT 1
`;

    const result = await db.query(sql, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "message not found" });
    }

    res.json(result.rows[0]);

  } catch (err) {
    console.error("message detail endpoint failed:", err);
    res.status(500).json({ error: "failed to load message" });
  }
});


module.exports = router;
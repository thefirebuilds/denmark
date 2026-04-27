// -----------------------------------------
// /server/services/saveMessage.js
// Service function to save an incoming message from the Turo inbox, 
// extract structured data from it, and persist it to the database
// -----------------------------------------

const pool = require("../db");
const { DateTime } = require("luxon");
const upsertTripFromMessage = require("./upsertTripFromMessage");


function clean(value) {
  if (value == null) return "";
  return String(value).trim();
}

function extractSecondaryDriverFields(
  normalizedTextBody,
  subject = "",
  htmlBody = ""
) {
  return baseExtractFields(normalizedTextBody, subject, htmlBody);
}

function extractReimbursementFields(
  normalizedTextBody,
  subject = "",
  htmlBody = ""
) {
  return baseExtractFields(normalizedTextBody, subject, htmlBody);
}

function classifyMessageType(subject) {
  const s = clean(subject);

  if (!s) return "turo_notification";

  if (/^.+ has sent you a message about your .+$/i.test(s)) {
    return "guest_message";
  }

  if (/^.+ has added another driver to their trip with your .+$/i.test(s)) {
    return "secondary_driver_added";
  }

  if (/^.+ has cancelled their trip with your .+$/i.test(s)) {
    return "trip_canceled";
  }

  if (/^.+ has changed their trip with your .+ \(\d+\)$/i.test(s)) {
    return "trip_changed";
  }

  if (/^.+[’']s trip with your .+ is booked!$/i.test(s)) {
    return "trip_booked";
  }

  if (/^.+ has just rated their trip$/i.test(s)) {
    return "trip_rated";
  }

  if (
    /^reimbursement invoice$/i.test(s) ||
    /^.+ has been charged for your reimbursement invoice$/i.test(s)
  ) {
    return "reimbursement_invoice";
  }

  if (/^your earnings are on the way!?$/i.test(s)) {
    return "payment_notice";
  }

  return "turo_notification";
}

function normalizeTextBodyForAnalysis(value) {
  if (value == null) return null;

  let text = String(value);

  text = text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\u00A0/g, " ")
    .replace(/\u202F/g, " ")
    .replace(/\u2007/g, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const junkPatterns = [
    /^download the turo app$/i,
    /^available on ios and android$/i,
    /^have a question\?$/i,
    /^visit the turo help center/i,
    /^turo inc\./i,
    /^notice: do not respond to requests to schedule or pay for transactions outside of turo\./i,
  ];

  const cleanedLines = lines.filter((line) => {
    return !junkPatterns.some((re) => re.test(line));
  });

  return cleanedLines.join("\n") || null;
}

function normalizeNewlines(value) {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function normalizeUnicodeSpaces(value) {
  return value
    .replace(/\u00A0/g, " ")
    .replace(/\u202F/g, " ")
    .replace(/\u2007/g, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "");
}

function cleanTextBody(value) {
  if (value == null) return null;

  let text = String(value);
  text = normalizeNewlines(text);
  text = normalizeUnicodeSpaces(text);
  text = text.replace(/[ \t]+$/gm, "");
  text = text.replace(/\n{4,}/g, "\n\n\n");
  text = text.replace(/[ \t]{2,}/g, " ");
  text = text.trim();

  return text || null;
}

function cleanHtmlBody(value) {
  if (value == null) return null;

  let html = String(value);
  html = normalizeNewlines(html);
  html = normalizeUnicodeSpaces(html);
  html = html.trim();

  return html || null;
}

function cleanHeaders(value) {
  if (value == null) return null;

  let text = String(value);
  text = normalizeNewlines(text);
  text = normalizeUnicodeSpaces(text);
  text = text.replace(/[ \t]+$/gm, "").trim();

  return text || null;
}

function stripHtml(html) {
  if (!html) return "";
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractAmount({ subject, textBody, htmlBody, rawHeaders }) {
  const haystack = [
    subject || "",
    textBody || "",
    stripHtml(htmlBody || ""),
    rawHeaders || "",
  ].join("\n");

  const patterns = [
    /you earn:\s*\$([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})?)/i,
    /earnings?:\s*\$([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})?)/i,
    /trip total:\s*\$([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})?)/i,
    /\$([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2}))/,
  ];

  for (const pattern of patterns) {
    const match = haystack.match(pattern);
    if (match) {
      const normalized = match[1].replace(/,/g, "");
      const amount = Number(normalized);
      if (!Number.isNaN(amount)) return amount;
    }
  }

  return null;
}

function extractMatch(text, regex, group = 1) {
  const match = String(text || "").match(regex);
  return match ? (match[group] || "").trim() || null : null;
}

function parseInteger(value) {
  if (!value) return null;
  const n = Number(String(value).replace(/,/g, ""));
  return Number.isNaN(n) ? null : n;
}

function parseTuroDateTime(value) {
  if (!value) return null;

  const raw = String(value).trim();
  if (!raw) return null;

  let dt = DateTime.fromFormat(raw, "M/d/yyyy h:mm a", {
    zone: "America/Chicago",
  });

  if (!dt.isValid) {
    dt = DateTime.fromFormat(raw, "M/d/yy h:mm a", {
      zone: "America/Chicago",
    });
  }

  if (!dt.isValid) {
    return null;
  }

  return dt.toUTC().toISO();
}

function extractVehicleListingUrlFromHtml(html) {
  if (!html) {
    return { url: null, id: null };
  }

  const vehicleImageMatch = String(html).match(
    /<img\b(?=[^>]*\bclass=(["'])[^"']*\bvehicle-image\b[^"']*\1)[^>]*>/i
  );

  if (vehicleImageMatch) {
    const start = Math.max(0, vehicleImageMatch.index - 1500);
    const end = Math.min(
      String(html).length,
      vehicleImageMatch.index + vehicleImageMatch[0].length + 1500
    );
    const vehicleImageBlock = String(html).slice(start, end);
    const blockMatch = vehicleImageBlock.match(
      /(https?:\/\/turo\.com\/us\/en\/car-rental\/[^"'<>\s]+\/(\d+))/i
    );

    if (blockMatch) {
      return {
        url: blockMatch[1],
        id: blockMatch[2] ? Number(blockMatch[2]) : null,
      };
    }
  }

  const patterns = [
    /<a[^>]+href="(https?:\/\/turo\.com\/us\/en\/car-rental\/[^"]+\/(\d+))"[^>]*>\s*[\s\S]*?<img[^>]+class="vehicle-image"/i,
    /<a[^>]+href="(https?:\/\/turo\.com\/us\/en\/car-rental\/[^"]+\/(\d+))"[^>]*>\s*[\s\S]*?<\/a>/i,
  ];

  for (const pattern of patterns) {
    const match = String(html).match(pattern);
    if (match) {
      return {
        url: match[1],
        id: match[2] ? Number(match[2]) : null,
      };
    }
  }

  return { url: null, id: null };
}

function extractVehicleImageUrlFromHtml(html) {
  if (!html) return null;

  const match = String(html).match(
    /<img\b(?=[^>]*\bclass=(["'])[^"']*\bvehicle-image\b[^"']*\1)[^>]*\bsrc=(["'])(https?:\/\/[^"']+)\2/i
  );

  return match ? match[3] : null;
}

function baseExtractFields(normalizedTextBody, subject = "", htmlBody = "") {
  const text = normalizedTextBody || "";
  const lines = text.split("\n").map((s) => s.trim()).filter(Boolean);

  const reservationId =
    extractMatch(text, /Reservation ID\s*#\s*(\d+)/i) ||
    extractMatch(text, /https?:\/\/turo\.com\/reservation\/(\d+)(?:\/[^\s)]*)?/i) ||
    extractMatch(htmlBody, /https?:\/\/turo\.com\/(?:us\/en\/)?reservation\/(\d+)(?:\/[^"]*)?/i);

  const tripStartRaw = extractMatch(text, /Trip start:\s*(.+)/i);
  const tripEndRaw = extractMatch(text, /Trip end:\s*(.+)/i);
  const mileageIncluded = extractMatch(
    text,
    /Mileage included:\s*([\d,]+)\s*miles/i
  );
  const guestProfileUrl = extractMatch(
    text,
    /View .+? profile:\s*(https?:\/\/\S+)/i
  );

  const replyUrl =
    extractMatch(text, /^Reply\s+(https?:\/\/\S+)/im) ||
    extractMatch(
      htmlBody,
      /href="(https?:\/\/turo\.com\/(?:us\/en\/)?reservation\/\d+\/messages)"/i
    );

  const tripDetailsUrl =
    extractMatch(text, /Send .+? a message:\s*(https?:\/\/\S+)/i) ||
    extractMatch(text, /View trip details at\s+(https?:\/\/\S+)/i) ||
    extractMatch(text, /View Invoice\s+\((https?:\/\/\S+)\)/i) ||
    extractMatch(text, /View receipt\s+\((https?:\/\/\S+)\)/i) ||
    extractMatch(
      htmlBody,
      /href="(https?:\/\/turo\.com\/(?:us\/en\/)?reservation\/\d+(?:\/[^"]*)?)"/i
    );

  const vehicleListing = extractVehicleListingUrlFromHtml(htmlBody);
  const vehicleImageUrl = extractVehicleImageUrlFromHtml(htmlBody);

  const phone =
    extractMatch(text, /(?:^|\n)(\(\d{3}\)\s*\d{3}-\d{4})(?:\n|$)/m) ||
    extractMatch(text, /(?:^|\n)(\d{3}[-. ]\d{3}[-. ]\d{4})(?:\n|$)/m);

  let vehicleName = null;
  let vehicleYear = null;

  for (const line of lines) {
    const m = line.match(/^(.+?)\s+(\d{4})$/);
    if (!m) continue;

    const candidateName = m[1].trim();
    const candidateYear = Number(m[2]);

    if (
      !/^Trip start:/i.test(line) &&
      !/^Trip end:/i.test(line) &&
      !/^Reservation ID/i.test(line) &&
      candidateYear >= 1990 &&
      candidateYear <= 2100
    ) {
      vehicleName = candidateName;
      vehicleYear = candidateYear;
      break;
    }
  }

  const guestName =
    extractMatch(text, /booked by\s+(.+)/i) ||
    extractMatch(text, /requested by\s+(.+)/i) ||
    extractMatch(text, /Your guest,\s+(.+?),\s+has accepted the reimbursement invoice\./i) ||
    extractMatch(text, /The reimbursement invoice has been sent to\s+(.+?),\s+who has until/i) ||
    extractMatch(subject, /^(.+?) has sent you a message about your /i) ||
    extractMatch(subject, /^(.+?) has added another driver to their trip with your /i) ||
    extractMatch(subject, /^(.+?) has changed their trip with your /i) ||
    extractMatch(subject, /^(.+?) has cancelled their trip with your /i) ||
    extractMatch(subject, /^(.+?)[’']s trip with your /i) ||
    extractMatch(subject, /^(.+?) has just rated their trip/i) ||
    extractMatch(subject, /^(.+?) has been charged for your reimbursement invoice/i);

  return {
    guestName: guestName || null,
    guestPhone: phone || null,
    guestProfileUrl: guestProfileUrl || null,
    vehicleName: vehicleName || null,
    vehicleYear: vehicleYear || null,
    vehicleListingUrl: vehicleListing.url || null,
    vehicleListingId: vehicleListing.id || null,
    vehicleImageUrl: vehicleImageUrl || null,
    reservationId: reservationId ? Number(reservationId) : null,
    tripStart: parseTuroDateTime(tripStartRaw),
    tripEnd: parseTuroDateTime(tripEndRaw),
    mileageIncluded: parseInteger(mileageIncluded),
    guestMessage: null,
    replyUrl: replyUrl || null,
    tripDetailsUrl: tripDetailsUrl || null,
  };
}

function extractGuestMessageFields(normalizedTextBody, subject = "", htmlBody = "") {
  const base = baseExtractFields(normalizedTextBody, subject, htmlBody);
  const lines = (normalizedTextBody || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  let guestMessage = null;

  if (lines.length >= 2 && /has sent you a message about your/i.test(lines[0])) {
    const candidate = lines[1];
    if (
      candidate &&
      !/^Reply\s+https?:\/\//i.test(candidate) &&
      !/^booked by\b/i.test(candidate) &&
      !/^Trip start:/i.test(candidate) &&
      !/^Trip end:/i.test(candidate) &&
      !/^Reservation ID/i.test(candidate)
    ) {
      guestMessage = candidate;
    }
  }

  return {
    ...base,
    guestMessage,
  };
}

function parseMoney(value) {
  if (!value) return null;
  const n = Number(String(value).replace(/,/g, ""));
  return Number.isNaN(n) ? null : n;
}

function extractTollAmountFromText(normalizedTextBody) {
  const text = String(normalizedTextBody || "");
  const match = text.match(/tolls?\s*-\s*\$([0-9,]+(?:\.\d{2})?)/i);
  return match ? parseMoney(match[1]) : null;
}

function reimbursementLooksLikeTollInvoice(normalizedTextBody) {
  return /tolls?\s*-\s*\$[0-9]/i.test(String(normalizedTextBody || ""));
}

async function applyTripCloseoutSignalsFromMessage({
  tripId,
  messageType,
  normalizedTextBody,
}) {
  if (!tripId) {
    return;
  }

  if (messageType !== "reimbursement_invoice") {
    return;
  }

  const tollAmount = extractTollAmountFromText(normalizedTextBody);
  const tollInvoice = reimbursementLooksLikeTollInvoice(normalizedTextBody);

  await pool.query(
    `
      UPDATE trips
      SET
        expense_status = CASE
          WHEN COALESCE(expense_status, '') IN ('', 'pending', 'needs_review')
            THEN 'resolved'
          ELSE expense_status
        END,
        has_tolls = CASE
          WHEN $2::boolean THEN TRUE
          ELSE has_tolls
        END,
        toll_total = CASE
          WHEN $2::boolean AND $3::numeric IS NOT NULL
            THEN COALESCE($3::numeric, toll_total)
          ELSE toll_total
        END,
        toll_review_status = CASE
          WHEN $2::boolean OR COALESCE(has_tolls, false) = TRUE THEN 'billed'
          ELSE toll_review_status
        END,
        updated_at = NOW()
      WHERE id = $1
    `,
    [tripId, tollInvoice, tollAmount]
  );
}

function extractTripChangedFields(normalizedTextBody, subject = "", htmlBody = "") {
  const base = baseExtractFields(normalizedTextBody, subject, htmlBody);
  const text = normalizedTextBody || "";
  const lines = text.split("\n").map((s) => s.trim()).filter(Boolean);

  const changeSummary =
    extractMatch(text, /New trip end on (.+)/i, 0) ||
    extractMatch(text, /New trip start on (.+)/i, 0) ||
    extractMatch(text, /Here’s what .+ changed:\n(.+)/i);

  const newTotalEarningsRaw = extractMatch(
    text,
    /Your new total earnings will be \$([0-9,]+(?:\.\d{2})?)/i
  );

  let changeType = null;
  for (const line of lines) {
    if (/^Extending$/i.test(line)) {
      changeType = "extending";
      break;
    }
    if (/^Shortening$/i.test(line)) {
      changeType = "shortening";
      break;
    }
    if (/^Changing pickup$/i.test(line)) {
      changeType = "changing_pickup";
      break;
    }
    if (/^Changing return$/i.test(line)) {
      changeType = "changing_return";
      break;
    }
  }

  return {
    ...base,
    changeType,
    changeSummary: changeSummary || null,
    newTotalEarnings: parseMoney(newTotalEarningsRaw),
  };
}

function extractTripBookedFields(normalizedTextBody, subject = "", htmlBody = "") {
  return baseExtractFields(normalizedTextBody, subject, htmlBody);
}

function extractTripCanceledFields(normalizedTextBody, subject = "", htmlBody = "") {
  const base = baseExtractFields(normalizedTextBody, subject, htmlBody);
  const text = String(normalizedTextBody || "");

  const cancellationReason =
    extractMatch(
      normalizedTextBody,
      /We’re sorry things didn’t work out\.(.+?)Reply\s+https?:\/\//is,
      1
    ) ||
    extractMatch(
      normalizedTextBody,
      /We'?re sorry things didn’t work out\.(.+?)Reply\s+https?:\/\//is,
      1
    ) ||
    extractMatch(normalizedTextBody, /because .+/i, 0);

  let cancellationPayoutAmount;

  if (
    /you won['’`]?t receive any payment/i.test(text) ||
    /won['’`]?t be charged,\s*and you won['’`]?t receive any payment/i.test(text)
  ) {
    cancellationPayoutAmount = 0;
  } else {
    const payoutRaw =
      extractMatch(text, /you['’`]?ll receive payment of \$([0-9,]+(?:\.\d{2})?)/i) ||
      extractMatch(text, /you['’`]?ll receive \$([0-9,]+(?:\.\d{2})?)/i) ||
      extractMatch(text, /updated earnings[:\s]+\$([0-9,]+(?:\.\d{2})?)/i) ||
      extractMatch(text, /new earnings[:\s]+\$([0-9,]+(?:\.\d{2})?)/i);

    if (payoutRaw) {
      cancellationPayoutAmount = parseMoney(payoutRaw);
    }
  }

  return {
    ...base,
    cancellationReason: cancellationReason ? cancellationReason.trim() : null,
    cancellationPayoutAmount,
  };
}

function extractPaymentFields(normalizedTextBody, subject = "", htmlBody = "") {
  return baseExtractFields(normalizedTextBody, subject, htmlBody);
}

function extractTripRatedFields(normalizedTextBody, subject = "", htmlBody = "") {
  return baseExtractFields(normalizedTextBody, subject, htmlBody);
}

function extractGenericFields(normalizedTextBody, subject = "", htmlBody = "") {
  return baseExtractFields(normalizedTextBody, subject, htmlBody);
}

function extractStructuredFieldsByType(
  messageType,
  normalizedTextBody,
  subject = "",
  htmlBody = ""
) {
  switch (messageType) {
    case "guest_message":
      return extractGuestMessageFields(normalizedTextBody, subject, htmlBody);
    case "secondary_driver_added":
      return extractSecondaryDriverFields(normalizedTextBody, subject, htmlBody);
    case "trip_changed":
      return extractTripChangedFields(normalizedTextBody, subject, htmlBody);
    case "trip_canceled":
      return extractTripCanceledFields(normalizedTextBody, subject, htmlBody);
    case "trip_booked":
      return extractTripBookedFields(normalizedTextBody, subject, htmlBody);
    case "payment_notice":
      return extractPaymentFields(normalizedTextBody, subject, htmlBody);
    case "reimbursement_invoice":
      return extractReimbursementFields(normalizedTextBody, subject, htmlBody);
    case "trip_rated":
      return extractTripRatedFields(normalizedTextBody, subject, htmlBody);
    default:
      return extractGenericFields(normalizedTextBody, subject, htmlBody);
  }
}

function shouldCreateTripStub({
  messageType,
  subject = "",
  normalizedTextBody = "",
  extracted = {},
}) {
  if (!extracted?.reservationId) {
    return false;
  }

  if (messageType !== "turo_notification") {
    return true;
  }

  const subjectText = String(subject || "").trim();
  const bodyText = String(normalizedTextBody || "");
  const vehicleName = String(extracted?.vehicleName || "").trim();
  const guestName = String(extracted?.guestName || "").trim();

  const renterSideSignals = [
    /^you[â€™']re booked!/i,
    /\babout their\b/i,
    /\byour trip with\b/i,
    /\bowned by:\b/i,
    /\bsend .+ a message:\s*https?:\/\/turo\.com\/reservation\//i,
  ];

  const combined = `${subjectText}\n${bodyText}`;
  if (renterSideSignals.some((pattern) => pattern.test(combined))) {
    return false;
  }

  if (!guestName && vehicleName) {
    return false;
  }

  return Boolean(
    guestName ||
      extracted?.tripStart ||
      extracted?.tripEnd ||
      extracted?.tripDetailsUrl
  );
}

async function saveMessage(message) {
  const cleanedTextBody = cleanTextBody(message.textBody);
  const cleanedHtmlBody = cleanHtmlBody(message.htmlBody);
  const cleanedRawHeaders = cleanHeaders(message.rawHeaders);
  const normalizedTextBody = normalizeTextBodyForAnalysis(cleanedTextBody);
  const messageType = classifyMessageType(message.subject);

  const amount = extractAmount({
    subject: message.subject,
    textBody: cleanedTextBody,
    htmlBody: cleanedHtmlBody,
    rawHeaders: cleanedRawHeaders,
  });

  const extracted = extractStructuredFieldsByType(
    messageType,
    normalizedTextBody,
    message.subject,
    cleanedHtmlBody
  );

  const effectiveAmount =
    extracted?.cancellationPayoutAmount !== undefined
      ? extracted.cancellationPayoutAmount
      : amount;

  const query = `
    INSERT INTO messages (
      message_id,
      mailbox,
      imap_uid,
      subject,
      from_header,
      to_header,
      date_header,
      message_timestamp,
      content_type_header,
      flags,
      text_body,
      html_body,
      normalized_text_body,
      raw_headers,
      raw_source,
      status,
      amount,
      message_type,
      guest_name,
      guest_phone,
      guest_profile_url,
      vehicle_name,
      vehicle_year,
      vehicle_listing_url,
      vehicle_listing_id,
      vehicle_image_url,
      reservation_id,
      trip_start,
      trip_end,
      mileage_included,
      guest_message,
      reply_url,
      trip_details_url
    )
    VALUES (
      $1,  $2,  $3,  $4,  $5,
      $6,  $7,  $8,  $9,  $10,
      $11, $12, $13, $14, $15,
      $16, $17, $18, $19, $20,
      $21, $22, $23, $24, $25,
      $26, $27, $28, $29, $30,
      $31, $32, $33
    )
    ON CONFLICT (message_id) DO NOTHING
    RETURNING
      id,
      message_id,
      amount,
      message_type,
      guest_name,
      guest_profile_url,
      vehicle_name,
      vehicle_year,
      vehicle_listing_url,
      vehicle_listing_id,
      vehicle_image_url,
      reservation_id,
      trip_start,
      trip_end,
      mileage_included,
      trip_details_url;
  `;

  const values = [
    clean(message.messageId) || null,
    clean(message.mailbox) || null,
    message.uid || null,
    clean(message.subject) || null,
    clean(message.fromHeader) || null,
    clean(message.toHeader) || null,
    clean(message.dateHeader) || null,
    message.messageTimestamp || null,
    clean(message.contentTypeHeader) || null,
    message.flags?.length ? message.flags : null,
    cleanedTextBody,
    cleanedHtmlBody,
    normalizedTextBody,
    cleanedRawHeaders,
    message.rawSource || null,
    "unread",
    effectiveAmount,
    messageType,
    extracted.guestName,
    extracted.guestPhone,
    extracted.guestProfileUrl,
    extracted.vehicleName,
    extracted.vehicleYear,
    extracted.vehicleListingUrl,
    extracted.vehicleListingId,
    extracted.vehicleImageUrl,
    extracted.reservationId,
    extracted.tripStart,
    extracted.tripEnd,
    extracted.mileageIncluded,
    extracted.guestMessage,
    extracted.replyUrl,
    extracted.tripDetailsUrl,
  ];

  const result = await pool.query(query, values);
  const savedMessage = result.rows[0] || null;

  if (!savedMessage) {
    return null;
  }

  let trip = await upsertTripFromMessage(savedMessage);

  if (!trip?.id && savedMessage.reservation_id) {
    const existingTrip = await pool.query(
      `
        SELECT id
        FROM trips
        WHERE reservation_id = $1
        LIMIT 1
      `,
      [savedMessage.reservation_id]
    );

    trip = existingTrip.rows[0] || null;
  }

  if (
    !trip?.id &&
    shouldCreateTripStub({
      messageType,
      subject: message.subject,
      normalizedTextBody,
      extracted,
    })
  ) {
    const stubTrip = await pool.query(
      `
        INSERT INTO trips (
          reservation_id,
          vehicle_name,
          guest_name,
          status,
          created_from_message_id,
          last_message_id,
          turo_vehicle_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (reservation_id)
        DO UPDATE SET
          turo_vehicle_id = COALESCE(EXCLUDED.turo_vehicle_id, trips.turo_vehicle_id),
          last_message_id = EXCLUDED.last_message_id,
          updated_at = now()
        RETURNING id
      `,
      [
        savedMessage.reservation_id,
        savedMessage.vehicle_name || null,
        savedMessage.guest_name || null,
        "message_only_stub",
        savedMessage.message_id,
        savedMessage.message_id,
        savedMessage.vehicle_listing_id || null,
      ]
    );

    trip = stubTrip.rows[0] || null;
  }

  if (trip?.id) {
    await pool.query(
      `UPDATE messages SET trip_id = $1 WHERE id = $2`,
      [trip.id, savedMessage.id]
    );

    await applyTripCloseoutSignalsFromMessage({
      tripId: trip.id,
      messageType,
      normalizedTextBody,
    });
  }

  return savedMessage;
}

module.exports = saveMessage;

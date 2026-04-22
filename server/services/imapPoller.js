const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");
const saveMessage = require("./saveMessage");

const TARGET_MAILBOXES = (
  process.env.IMAP_TARGET_MAILBOXES ||
  "INBOX"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function clean(value) {
  if (value == null) return "";
  return String(value).trim();
}

function oneLine(value) {
  return clean(value).replace(/\s+/g, " ");
}

function formatDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function buildRawHeaders(headers) {
  return Array.from(headers.entries())
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join("\n");
}

function hoursAgoDate(hours) {
  return new Date(Date.now() - hours * 60 * 60 * 1000);
}

async function pollImap() {
  const client = new ImapFlow({
    host: process.env.IMAP_HOST,
    port: Number(process.env.IMAP_PORT || 993),
    secure: true,
    auth: {
      user: process.env.IMAP_USER,
      pass: process.env.IMAP_PASS,
    },
    logger: false,
    connectionTimeout: Number(process.env.IMAP_CONNECTION_TIMEOUT || 90000),
    greetingTimeout: Number(process.env.IMAP_GREETING_TIMEOUT || 30000),
    socketTimeout: Number(process.env.IMAP_SOCKET_TIMEOUT || 600000),
  });

  client.on("error", (err) => {
    console.error("IMAP client error:", err?.code || "", err?.message || err);
  });

  client.on("close", () => {
    console.warn("IMAP connection closed");
  });

  const seenMessageIds = new Set();

  let mailboxCount = 0;
  let matchedCount = 0;
  let insertedCount = 0;
  let duplicateCount = 0;
  let errorCount = 0;

  const recentSamples = [];
  const SAMPLE_LIMIT = 5;

  try {
    const LOOKBACK_HOURS = Number(process.env.IMAP_LOOKBACK_HOURS || 72);
    const INGEST_LIMIT = Number(process.env.IMAP_INGEST_LIMIT || 100);

    console.log(
      `[imap] poll start | mailboxes=${TARGET_MAILBOXES.join(",")} lookbackHours=${LOOKBACK_HOURS}`
    );

    await client.connect();

    for (const mailbox of TARGET_MAILBOXES) {
      let lock;

      try {
        lock = await client.getMailboxLock(mailbox);
        mailboxCount += 1;

        const results = await client.search({
          from: "noreply@mail.turo.com",
          since: hoursAgoDate(LOOKBACK_HOURS),
        });

        if (!results.length) {
          console.log(`[imap] ${mailbox} | matches=0`);
          continue;
        }

        const limitedResults = results.slice(-INGEST_LIMIT);
        console.log(
          `[imap] ${mailbox} | matches=${results.length} fetching=${limitedResults.length}`
        );

        for await (const msg of client.fetch(limitedResults, {
          uid: true,
          envelope: true,
          flags: true,
          internalDate: true,
          source: true,
        })) {
          matchedCount += 1;

          const parsed = await simpleParser(msg.source);

          const messageId = clean(parsed.messageId);
          if (messageId && seenMessageIds.has(messageId)) {
            duplicateCount += 1;
            continue;
          }

          if (messageId) {
            seenMessageIds.add(messageId);
          }

          const dateHeader = clean(parsed.headers.get("date") || "");
          const messageTimestamp = parsed.date || msg.internalDate || null;

          const textBody = clean(parsed.text || "");
          const htmlBody = typeof parsed.html === "string" ? parsed.html : null;

          const record = {
            messageId: messageId || null,
            mailbox,
            uid: msg.uid,
            subject: clean(parsed.subject) || null,
            fromHeader: clean(parsed.from?.text || "") || null,
            toHeader: clean(parsed.to?.text || "") || null,
            ccHeader: clean(parsed.cc?.text || "") || null,
            bccHeader: clean(parsed.bcc?.text || "") || null,
            replyToHeader: clean(parsed.replyTo?.text || "") || null,
            dateHeader: dateHeader || null,
            messageTimestamp: messageTimestamp || null,
            inReplyTo: clean(parsed.inReplyTo || "") || null,
            referencesHeader: Array.isArray(parsed.references)
              ? parsed.references.join(" ")
              : clean(parsed.references || "") || null,
            contentTypeHeader:
              clean(parsed.headers.get("content-type") || "") || null,
            flags: Array.from(msg.flags || []),
            textBody: textBody || null,
            htmlBody,
            rawHeaders: buildRawHeaders(parsed.headers),
            rawSource: msg.source,
          };

          const saved = await saveMessage(record);

          if (saved) {
            insertedCount += 1;

            recentSamples.push({
              mailbox,
              uid: msg.uid,
              messageId: record.messageId,
              subject: record.subject || "",
              from: record.fromHeader || "",
              to: record.toHeader || "",
              date: formatDate(record.messageTimestamp),
              preview: oneLine(record.textBody || "").slice(0, 220),
            });

            if (recentSamples.length > SAMPLE_LIMIT) {
              recentSamples.shift();
            }
          } else {
            duplicateCount += 1;
          }
        }
      } catch (err) {
        errorCount += 1;
        console.error(`[imap] ${mailbox} failed | ${err.message}`);
      } finally {
        if (lock) lock.release();
      }
    }

    console.log(
      `[imap] poll done | mailboxes=${mailboxCount} matched=${matchedCount} inserted=${insertedCount} duplicates=${duplicateCount} errors=${errorCount}`
    );

    if (recentSamples.length) {
      console.log(`[imap] inserted recent=${recentSamples.length}`);
    }
    } catch (err) {
        console.error(
          `[imap] poll failed | code=${err?.code || "unknown"} message=${
            err?.message || err
          }`
        );
      } finally {
    try {
      if (client.usable) {
        await client.logout();
      }
    } catch (err) {
      console.warn(`[imap] logout failed | ${err?.message || err}`);
    }
  }
}

module.exports = pollImap;

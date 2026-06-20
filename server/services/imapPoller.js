const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");
const saveMessage = require("./saveMessage");
const {
  getEffectiveImapSettings,
  splitMailboxes,
} = require("./integrations/imapSettings");

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
  const settings = await getEffectiveImapSettings();

  if (settings.enabled === false) {
    console.log("[imap] poll skipped | enabled=false");
    return {
      skipped: true,
      reason: "disabled",
    };
  }

  if (!settings.configured) {
    console.log("[imap] poll skipped | configured=false");
    return {
      skipped: true,
      reason: "not_configured",
    };
  }

  const targetMailboxes = splitMailboxes(settings.targetMailboxes);
  const client = new ImapFlow({
    host: settings.host,
    port: Number(settings.port || 993),
    secure: settings.secure !== false,
    auth: {
      user: settings.user,
      pass: settings.pass,
    },
    logger: false,
    connectionTimeout: Number(settings.connectionTimeout || 90000),
    greetingTimeout: Number(settings.greetingTimeout || 30000),
    socketTimeout: Number(settings.socketTimeout || 600000),
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
    const LOOKBACK_HOURS = Number(settings.lookbackHours || 72);
    const INGEST_LIMIT = Number(settings.ingestLimit || 100);

    console.log(
      `[imap] poll start | mailboxes=${targetMailboxes.join(",")} lookbackHours=${LOOKBACK_HOURS} source=${settings.source || "settings"}`
    );

    await client.connect();

    for (const mailbox of targetMailboxes.length ? targetMailboxes : ["INBOX"]) {
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

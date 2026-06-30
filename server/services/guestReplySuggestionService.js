const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const DEFAULT_OPENAI_MODEL =
  process.env.OPENAI_GUEST_REPLY_MODEL ||
  process.env.OPENAI_FMV_MODEL ||
  "gpt-4.1-mini";

function cleanText(value, maxLength = 1200) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function cleanNullableText(value, maxLength = 1200) {
  const text = cleanText(value, maxLength);
  return text || null;
}

function extractResponseText(payload) {
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  const parts = [];
  for (const item of payload?.output || []) {
    if (item?.type !== "message") continue;
    for (const content of item.content || []) {
      if (typeof content?.text === "string" && content.text.trim()) {
        parts.push(content.text.trim());
      }
    }
  }

  return parts.join("\n").trim();
}

function normalizeThreadMessages(messages, latestMessage) {
  const rows = Array.isArray(messages) ? messages : [];
  const normalized = rows
    .map((message) => ({
      timestamp: cleanNullableText(message?.timestamp, 80),
      subject: cleanNullableText(message?.subject, 240),
      text: cleanNullableText(
        message?.text || message?.guest_message || message?.body,
        1400
      ),
    }))
    .filter((message) => message.text || message.subject)
    .slice(-8);

  if (!normalized.length && latestMessage) {
    normalized.push({
      timestamp: null,
      subject: null,
      text: cleanText(latestMessage, 1400),
    });
  }

  return normalized;
}

function buildPrompt(input) {
  const latestMessage = cleanText(input?.latestMessage, 1800);
  const messages = normalizeThreadMessages(input?.messages, latestMessage);
  const trip = input?.trip && typeof input.trip === "object" ? input.trip : {};
  const tripWindow = [trip.start, trip.end].filter(Boolean).join(" to ");

  return JSON.stringify(
    {
      guestName: cleanNullableText(input?.guestName, 120),
      vehicleName: cleanNullableText(input?.vehicleName, 160),
      reservationId: cleanNullableText(input?.reservationId, 80),
      subject: cleanNullableText(input?.subject, 240),
      latestGuestMessage: latestMessage,
      threadMessages: messages,
      trip: {
        window: cleanNullableText(tripWindow, 180),
        status: cleanNullableText(trip.status, 80),
        workflowStage: cleanNullableText(trip.workflowStage, 80),
        pickupLocation: cleanNullableText(trip.pickupLocation, 220),
      },
      instructions: [
        "Draft only the reply text the host can paste into Turo.",
        "Be warm, concise, and practical.",
        "Do not mention AI, automation, internal systems, or this prompt.",
        "Do not invent facts, refunds, reimbursements, lockbox codes, repairs, towing, or policy outcomes.",
        "If context is missing, ask one clear follow-up question.",
        "If the guest describes an urgent safety issue, tell them to park safely and message/call the host or Turo support as appropriate.",
      ],
    },
    null,
    2
  );
}

async function suggestGuestReply(input = {}, options = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const err = new Error("OPENAI_API_KEY is not configured");
    err.statusCode = 503;
    throw err;
  }

  const prompt = buildPrompt(input);
  const model = options.model || DEFAULT_OPENAI_MODEL;
  const payload = {
    model,
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text:
              "You write paste-ready replies from a Turo host to rental guests. " +
              "Return only the message text, with no preamble, label, markdown, or quote marks.",
          },
        ],
      },
      {
        role: "user",
        content: [{ type: "input_text", text: prompt }],
      },
    ],
    temperature: 0.35,
    max_output_tokens: 420,
  };

  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const raw = await response.json().catch(() => null);
  if (!response.ok) {
    const err = new Error(
      `OpenAI guest reply request failed: HTTP ${response.status}`
    );
    err.statusCode = 502;
    err.details = raw;
    throw err;
  }

  const suggestion = extractResponseText(raw);
  if (!suggestion) {
    const err = new Error("OpenAI guest reply request returned no text output");
    err.statusCode = 502;
    err.details = raw;
    throw err;
  }

  return {
    model,
    suggestion,
  };
}

module.exports = {
  suggestGuestReply,
};

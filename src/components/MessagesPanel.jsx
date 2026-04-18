// --------------------------------------------------------------------------
// ./src/components/MessagesPanel.jsx
// This component displays incoming messages related to trips, including guest messages,
// system notifications, and other updates. It supports both a live feed of recent messages
// and a focused view for messages related to a selected trip. Users can mark messages as read
// and reply to guest messages directly from the panel.
// --------------------------------------------------------------------------


import { useEffect, useRef, useState } from "react";

function notifyMessageStatsUpdated() {
  window.dispatchEvent(new CustomEvent("messages:stats-updated"));
}

function buildReplyUrl(message) {
  if (message?.reply_url) {
    return message.reply_url;
  }

  if (message?.trip_details_url) {
    return `${message.trip_details_url.replace(/\/$/, "")}/messages`;
  }

  if (message?.reservation_id) {
    return `https://turo.com/reservation/${message.reservation_id}/messages`;
  }

  return "";
}

function formatTripTime(value) {
  if (!value) return "";

  const d = new Date(value);

  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatMoney(value) {
  if (value == null) return "";

  const n = Number(value);
  if (Number.isNaN(n)) return "";

  return `$${n.toFixed(2)}`;
}

function buildMessageBody(message) {
  const type = message?.type || message?.message_type;
  if (type === "guest_message" && message?.guest_message) {
    return message.guest_message;
  }

  if (type === "trip_changed") {
    if (message?.new_trip_end) {
      return `New trip end: ${formatTripTime(message.new_trip_end)}`;
    }

    if (message?.change_summary) {
      return message.change_summary;
    }
  }

  if (type === "trip_booked") {
    const start = formatTripTime(message.trip_start);
    const end = formatTripTime(message.trip_end);
    const revenue = formatMoney(message.amount);

    if (start && end && revenue) {
      return `${start} → ${end} • ${revenue}`;
    }

    if (start && end) {
      return `${start} → ${end}`;
    }

    if (revenue) {
      return revenue;
    }
  }

  const amount = formatMoney(message?.amount);
  if (amount) {
    if (message?.subject) {
      return amount;
    }

    return amount;
  }

  return message?.guest_message || message?.subject || "";
}

function formatTimeAgo(timestamp) {
  if (!timestamp) return "";

  const now = new Date();
  const then = new Date(timestamp);
  const diffMs = now - then;

  const minutes = Math.floor(diffMs / 60000);
  const hours = Math.floor(diffMs / 3600000);
  const days = Math.floor(diffMs / 86400000);

  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (hours < 24) return `${hours} hr${hours === 1 ? "" : "s"} ago`;
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function buildMessageTitle(message) {
  const guest = message?.guest_name || message?.parsed?.guest;
  const vehicle = message?.vehicle_name || message?.parsed?.vehicle;

  if (vehicle && guest) return `${guest} • ${vehicle}`;
  if (vehicle) return vehicle;
  if (guest) return guest;
  return "Incoming message";
}

function buildMessageSub(message) {
  const type = message?.type || message?.message_type || message?.parsed?.type;

  if (type === "guest_message") return "Guest message";
  if (type === "trip_booked") return "Trip booked";
  if (type === "trip_changed") return "Trip changed";
  if (type === "payment_notice") return "Payment notice";
  if (type === "trip_rated") return "Trip rated";

  if (message?.subject) return message.subject;
  return "Message";
}

  function getMessageTimestamp(message) {
    return (
      message?.display_at ||
      message?.timestamp ||
      message?.message_timestamp ||
      message?.received_at ||
      message?.created_at ||
      ""
    );
  }

export default function MessagesPanel({ selectedTrip, onClearSelectedTrip }) {
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [newMessageIds, setNewMessageIds] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);

  const seenIdsRef = useRef(new Set());
  const audioRef = useRef(null);
  const highlightTimeoutRef = useRef(null);

  async function loadMessageStats() {
    try {
      const res = await fetch("http://localhost:5000/api/messages/stats");

      if (!res.ok) {
        throw new Error(`Failed to load message stats (${res.status})`);
      }

      const stats = await res.json();

      setUnreadCount(Number(stats.unread || 0));
    } catch (err) {
      console.error("Failed loading message stats:", err);
    }
  }

async function handleMarkAsRead(messageId) {
  try {
    const res = await fetch(`http://localhost:5000/api/messages/${messageId}/read`, {
      method: "PATCH",
    });

    if (!res.ok) {
      throw new Error(`Failed to mark message as read (${res.status})`);
    }

    setMessages((prev) => prev.filter((msg) => msg.id !== messageId));
    setNewMessageIds((prev) => prev.filter((id) => id !== messageId));
    setUnreadCount((prev) => Math.max(0, prev - 1));
    seenIdsRef.current.delete(messageId);

    notifyMessageStatsUpdated();
  } catch (err) {
    setError(err.message || "Failed to mark message as read");
  }
}

  function handleReply(message) {
    const url = buildReplyUrl(message);

    if (!url) {
      setError("No reply URL found for this message");
      return;
    }

    window.open(url, "_blank", "noopener,noreferrer");
  }

  async function loadMessages(isInitialLoad = false) {
    try {
      if (isInitialLoad) {
        setLoading(true);
      }

      const endpoint = selectedTrip?.id
        ? `http://localhost:5000/api/trips/${selectedTrip.id}/messages`
        : "http://localhost:5000/api/messages";

      const res = await fetch(endpoint);

      if (!res.ok) {
        throw new Error(`Failed to load messages (${res.status})`);
      }

      const data = await res.json();
      const nextMessages = Array.isArray(data)
        ? selectedTrip?.id
          ? data
          : data.slice(0, 5)
        : [];

      const nextIds = nextMessages.map((msg) => msg.id);
      const seenIds = seenIdsRef.current;

      if (isInitialLoad) {
        seenIds.clear();
        nextIds.forEach((id) => seenIds.add(id));
      } else {
        const freshIds = nextIds.filter((id) => !seenIds.has(id));

        if (freshIds.length > 0) {
          setNewMessageIds(freshIds);

          if (highlightTimeoutRef.current) {
            clearTimeout(highlightTimeoutRef.current);
          }

          highlightTimeoutRef.current = setTimeout(() => {
            setNewMessageIds([]);
          }, 6000);

          if (audioRef.current) {
            audioRef.current.currentTime = 0;
            audioRef.current.play().catch(() => {
              // Browser may block autoplay until user interacts with the page.
            });
          }
        }

        seenIds.clear();
        nextIds.forEach((id) => seenIds.add(id));
      }

      setMessages(nextMessages);
      setError("");
    } catch (err) {
      setError(err.message || "Failed to load messages");
    } finally {
      if (isInitialLoad) {
        setLoading(false);
      }
    }
  }

  useEffect(() => {
    audioRef.current = new Audio("/boop.mp3");
    audioRef.current.preload = "auto";

    setMessages([]);
    setNewMessageIds([]);
    seenIdsRef.current.clear();

    loadMessages(true);
    loadMessageStats();

    const intervalId = setInterval(() => {
      loadMessages(false);
      loadMessageStats();
    }, 15000);

    return () => {
      clearInterval(intervalId);

      if (highlightTimeoutRef.current) {
        clearTimeout(highlightTimeoutRef.current);
      }
    };
  }, [selectedTrip?.id]);

  return (
    <section className="panel messages-panel">
      <div className="panel-header">
        <h2>{selectedTrip ? "Trip Messages" : "Incoming Messages"}</h2>
        <span>{selectedTrip ? "selected trip feed" : "live message queue"}</span>
      </div>

      <div className="panel-subbar">
        <div className="chip search">
          {selectedTrip
            ? `Trip #${selectedTrip.reservation_id}`
            : "Showing latest 5"}
        </div>

        <div className="chip">{unreadCount} unread</div>

        {selectedTrip && (
          <button
            type="button"
            className="message-action"
            onClick={onClearSelectedTrip}
          >
            Back to live queue
          </button>
        )}
      </div>

      <div className="message-list">
        {loading && <div className="message-empty">Loading messages…</div>}

        {!loading && error && <div className="message-empty">{error}</div>}

        {!loading && !error && messages.length === 0 && (
          <div className="message-empty">No messages found.</div>
        )}

        {!loading &&
          !error &&
          messages.map((message) => {
            const isUnread = message.status === "unread";
            const isNew = newMessageIds.includes(message.id);
            const canReply = !!buildReplyUrl(message);
            const canMarkAsRead = isUnread;

            return (
              <article
                key={message.id}
                className={`message ${isUnread ? "unread" : ""} ${
                  isNew ? "message-new" : ""
                }`}
              >
                <div className="message-head">
                  <div>
                    <div className="message-title">{buildMessageTitle(message)}</div>
                    <div className="message-sub">{buildMessageSub(message)}</div>
                  </div>

                  <div className="message-time">
                    {isNew ? "just in" : formatTimeAgo(getMessageTimestamp(message))}
                  </div>
                </div>

                <div className="message-body">{buildMessageBody(message)}</div>

                {(canReply || canMarkAsRead) && (
                  <div className="message-actions">
                    {canReply && (
                      <button
                        type="button"
                        className="message-action"
                        onClick={() => handleReply(message)}
                      >
                        Reply
                      </button>
                    )}

                    {canMarkAsRead && (
                      <button
                        type="button"
                        className="message-action"
                        onClick={() => handleMarkAsRead(message.id)}
                      >
                        Mark as read
                      </button>
                    )}
                  </div>
                )}
              </article>
            );
          })}
      </div>
    </section>
  );
}
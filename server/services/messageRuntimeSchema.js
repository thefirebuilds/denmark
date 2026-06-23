const pool = require("../db");

let ensureMessageRuntimeSchemaPromise = null;

async function ensureMessageRuntimeSchema(client = pool) {
  if (!ensureMessageRuntimeSchemaPromise) {
    ensureMessageRuntimeSchemaPromise = client
      .query(`
        ALTER TABLE IF EXISTS public.messages
          ADD COLUMN IF NOT EXISTS trip_id integer,
          ADD COLUMN IF NOT EXISTS reservation_id bigint,
          ADD COLUMN IF NOT EXISTS message_id text,
          ADD COLUMN IF NOT EXISTS subject text,
          ADD COLUMN IF NOT EXISTS status text DEFAULT 'unread',
          ADD COLUMN IF NOT EXISTS message_type text,
          ADD COLUMN IF NOT EXISTS amount numeric(10,2),
          ADD COLUMN IF NOT EXISTS guest_name text,
          ADD COLUMN IF NOT EXISTS vehicle_name text,
          ADD COLUMN IF NOT EXISTS trip_start timestamptz,
          ADD COLUMN IF NOT EXISTS trip_end timestamptz,
          ADD COLUMN IF NOT EXISTS message_timestamp timestamptz,
          ADD COLUMN IF NOT EXISTS text_body text,
          ADD COLUMN IF NOT EXISTS normalized_text_body text,
          ADD COLUMN IF NOT EXISTS guest_message text,
          ADD COLUMN IF NOT EXISTS reply_url text,
          ADD COLUMN IF NOT EXISTS trip_details_url text,
          ADD COLUMN IF NOT EXISTS created_at timestamp DEFAULT CURRENT_TIMESTAMP;

        CREATE INDEX IF NOT EXISTS idx_messages_trip_id
          ON public.messages (trip_id);

        CREATE INDEX IF NOT EXISTS idx_messages_reservation_id
          ON public.messages (reservation_id);
      `)
      .catch((err) => {
        ensureMessageRuntimeSchemaPromise = null;
        throw err;
      });
  }

  return ensureMessageRuntimeSchemaPromise;
}

module.exports = {
  ensureMessageRuntimeSchema,
};

const pool = require("../../db");

async function ensureIncomeTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.income_transactions (
      id bigserial PRIMARY KEY,
      teller_transaction_row_id bigint UNIQUE REFERENCES public.teller_transactions(id) ON DELETE SET NULL,
      trip_id integer REFERENCES public.trips(id) ON DELETE SET NULL,
      source text DEFAULT 'bank_import' NOT NULL,
      income_type text DEFAULT 'turo_payout' NOT NULL,
      payer text,
      amount numeric(12,2) NOT NULL,
      income_date date NOT NULL,
      expected_trip_amount numeric(12,2),
      variance numeric(12,2),
      notes text,
      raw_json jsonb DEFAULT '{}'::jsonb NOT NULL,
      created_at timestamp without time zone DEFAULT now() NOT NULL,
      updated_at timestamp without time zone DEFAULT now() NOT NULL
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_income_transactions_trip_id
      ON public.income_transactions(trip_id)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_income_transactions_income_date
      ON public.income_transactions(income_date)
  `);
}

module.exports = {
  ensureIncomeTables,
};

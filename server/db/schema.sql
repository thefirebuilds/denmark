-- Denmark2.0 first-install / repave schema
--
-- This file is intentionally schema-only: it creates the database structure
-- needed by the app, but it does not include private fleet, guest, bank,
-- telemetry, token, or marketplace data.
--
-- Usage from a PostgreSQL admin shell:
--
--   psql -U postgres -d postgres -f server/db/schema.sql
--
-- The default database name is "denmark". If your .env uses a different
-- PGDATABASE, edit the dbname value below before running.

\set dbname denmark

SELECT format('CREATE DATABASE %I', :'dbname')
WHERE NOT EXISTS (
  SELECT 1 FROM pg_database WHERE datname = :'dbname'
)\gexec

\connect :dbname

-- Dumped from database version 18.0 (Debian 18.0-1.pgdg13+3)
-- Dumped by pg_dump version 18.0

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

ALTER TABLE IF EXISTS ONLY public.vehicle_telemetry_signal_values DROP CONSTRAINT IF EXISTS vehicle_telemetry_signal_values_snapshot_id_fkey;
ALTER TABLE IF EXISTS ONLY public.vehicle_odometer_history DROP CONSTRAINT IF EXISTS vehicle_odometer_history_vehicle_id_fkey;
ALTER TABLE IF EXISTS ONLY public.vehicle_condition_notes DROP CONSTRAINT IF EXISTS vehicle_condition_notes_vehicle_vin_fkey;
ALTER TABLE IF EXISTS ONLY public.trip_stage_history DROP CONSTRAINT IF EXISTS trip_stage_history_trip_id_fkey;
ALTER TABLE IF EXISTS ONLY public.messages DROP CONSTRAINT IF EXISTS messages_trip_id_fkey;
ALTER TABLE IF EXISTS ONLY public.maintenance_tasks DROP CONSTRAINT IF EXISTS maintenance_tasks_vehicle_vin_fkey;
ALTER TABLE IF EXISTS ONLY public.maintenance_tasks DROP CONSTRAINT IF EXISTS maintenance_tasks_rule_id_fkey;
ALTER TABLE IF EXISTS ONLY public.maintenance_rules DROP CONSTRAINT IF EXISTS maintenance_rules_vehicle_vin_fkey;
ALTER TABLE IF EXISTS ONLY public.maintenance_events DROP CONSTRAINT IF EXISTS maintenance_events_vehicle_vin_fkey;
ALTER TABLE IF EXISTS ONLY public.maintenance_events DROP CONSTRAINT IF EXISTS maintenance_events_rule_id_fkey;
ALTER TABLE IF EXISTS ONLY public.teller_transactions DROP CONSTRAINT IF EXISTS fk_teller_transactions_matched_expense;
ALTER TABLE IF EXISTS ONLY public.messages DROP CONSTRAINT IF EXISTS fk_messages_trip;
ALTER TABLE IF EXISTS ONLY public.expenses DROP CONSTRAINT IF EXISTS expenses_vehicle_id_fkey;
DROP TRIGGER IF EXISTS trg_vehicles_updated_at ON public.vehicles;
DROP TRIGGER IF EXISTS trg_vehicle_condition_notes_updated_at ON public.vehicle_condition_notes;
DROP TRIGGER IF EXISTS trg_maintenance_tasks_updated_at ON public.maintenance_tasks;
DROP TRIGGER IF EXISTS trg_maintenance_rules_updated_at ON public.maintenance_rules;
DROP TRIGGER IF EXISTS trg_maintenance_events_updated_at ON public.maintenance_events;
CREATE OR REPLACE VIEW public.trip_intelligence AS
SELECT
    NULL::integer AS id,
    NULL::bigint AS reservation_id,
    NULL::text AS vehicle_name,
    NULL::text AS guest_name,
    NULL::timestamp with time zone AS trip_start,
    NULL::timestamp with time zone AS trip_end,
    NULL::text AS status,
    NULL::numeric(10,2) AS amount,
    NULL::boolean AS needs_review,
    NULL::timestamp with time zone AS created_at,
    NULL::timestamp with time zone AS updated_at,
    NULL::bigint AS message_count,
    NULL::bigint AS unread_messages,
    NULL::timestamp with time zone AS last_message_at,
    NULL::timestamp with time zone AS last_unread_at;
DROP INDEX IF EXISTS public.vehicles_vin_unique_idx;
DROP INDEX IF EXISTS public.vehicles_nickname_unique_idx;
DROP INDEX IF EXISTS public.ux_maintenance_tasks_source_key;
DROP INDEX IF EXISTS public.idx_vehicles_license_plate;
DROP INDEX IF EXISTS public.idx_vehicles_external_vehicle_key;
DROP INDEX IF EXISTS public.idx_vehicles_dimo_token_id;
DROP INDEX IF EXISTS public.idx_vehicle_telemetry_snapshots_vin_captured_at;
DROP INDEX IF EXISTS public.idx_vehicle_telemetry_snapshots_service_vin_captured;
DROP INDEX IF EXISTS public.idx_vehicle_telemetry_snapshots_service_token_captured;
DROP INDEX IF EXISTS public.idx_vehicle_telemetry_snapshots_external_key;
DROP INDEX IF EXISTS public.idx_vehicle_telemetry_snapshots_dimo_token_captured;
DROP INDEX IF EXISTS public.idx_vehicle_telemetry_signal_values_token_signal_time;
DROP INDEX IF EXISTS public.idx_vehicle_telemetry_signal_values_snapshot;
DROP INDEX IF EXISTS public.idx_vehicle_telemetry_signal_values_signal_timestamp;
DROP INDEX IF EXISTS public.idx_vehicle_odometer_history_vehicle_time;
DROP INDEX IF EXISTS public.idx_vehicle_condition_notes_vehicle_vin;
DROP INDEX IF EXISTS public.idx_vehicle_condition_notes_active_guest_visible;
DROP INDEX IF EXISTS public.idx_trips_workflow_stage;
DROP INDEX IF EXISTS public.idx_trips_turo_vehicle_id;
DROP INDEX IF EXISTS public.idx_trips_toll_review_status;
DROP INDEX IF EXISTS public.idx_trips_stage_trip_start;
DROP INDEX IF EXISTS public.idx_trips_stage_trip_end;
DROP INDEX IF EXISTS public.idx_trips_has_tolls;
DROP INDEX IF EXISTS public.idx_trip_stage_history_trip_id;
DROP INDEX IF EXISTS public.idx_toll_charges_trxn_at;
DROP INDEX IF EXISTS public.idx_toll_charges_matched_vehicle_id;
DROP INDEX IF EXISTS public.idx_toll_charges_matched_trip_id;
DROP INDEX IF EXISTS public.idx_toll_charges_license_plate_normalized;
DROP INDEX IF EXISTS public.idx_teller_transactions_ignored;
DROP INDEX IF EXISTS public.idx_teller_transactions_description;
DROP INDEX IF EXISTS public.idx_teller_transactions_date;
DROP INDEX IF EXISTS public.idx_teller_transactions_account_id;
DROP INDEX IF EXISTS public.idx_messages_trip_id;
DROP INDEX IF EXISTS public.idx_messages_status;
DROP INDEX IF EXISTS public.idx_messages_reservation_id;
DROP INDEX IF EXISTS public.idx_messages_message_timestamp;
DROP INDEX IF EXISTS public.idx_messages_mailbox_uid;
DROP INDEX IF EXISTS public.idx_marketplace_listings_vin;
DROP INDEX IF EXISTS public.idx_marketplace_listings_price_numeric;
DROP INDEX IF EXISTS public.idx_marketplace_listings_last_seen_at;
DROP INDEX IF EXISTS public.idx_marketplace_listings_keywords_gin;
DROP INDEX IF EXISTS public.idx_marketplace_listings_hidden;
DROP INDEX IF EXISTS public.idx_marketplace_listings_driven_miles;
DROP INDEX IF EXISTS public.idx_maintenance_tasks_vehicle_vin;
DROP INDEX IF EXISTS public.idx_maintenance_tasks_vehicle_status_priority;
DROP INDEX IF EXISTS public.idx_maintenance_tasks_rule_id;
DROP INDEX IF EXISTS public.idx_maintenance_tasks_blockers;
DROP INDEX IF EXISTS public.idx_maintenance_rules_vehicle_vin;
DROP INDEX IF EXISTS public.idx_maintenance_rules_vehicle_rule_code;
DROP INDEX IF EXISTS public.idx_maintenance_rules_vehicle_active;
DROP INDEX IF EXISTS public.idx_maintenance_rule_templates_active_category;
DROP INDEX IF EXISTS public.idx_maintenance_events_vehicle_vin;
DROP INDEX IF EXISTS public.idx_maintenance_events_vehicle_rule;
DROP INDEX IF EXISTS public.idx_maintenance_events_vehicle_performed_at_desc;
DROP INDEX IF EXISTS public.idx_maintenance_events_rule_id_performed_at_desc;
DROP INDEX IF EXISTS public.idx_maintenance_events_result;
DROP INDEX IF EXISTS public.idx_maintenance_events_data_gin;
DROP INDEX IF EXISTS public.idx_expenses_date_category;
ALTER TABLE IF EXISTS ONLY public.vehicles DROP CONSTRAINT IF EXISTS vehicles_pkey;
ALTER TABLE IF EXISTS ONLY public.vehicles DROP CONSTRAINT IF EXISTS vehicles_id_key;
ALTER TABLE IF EXISTS ONLY public.vehicle_telemetry_snapshots DROP CONSTRAINT IF EXISTS vehicle_telemetry_snapshots_pkey;
ALTER TABLE IF EXISTS ONLY public.vehicle_telemetry_signal_values DROP CONSTRAINT IF EXISTS vehicle_telemetry_signal_values_pkey;
ALTER TABLE IF EXISTS ONLY public.vehicle_odometer_history DROP CONSTRAINT IF EXISTS vehicle_odometer_history_pkey;
ALTER TABLE IF EXISTS ONLY public.vehicle_condition_notes DROP CONSTRAINT IF EXISTS vehicle_condition_notes_pkey;
ALTER TABLE IF EXISTS ONLY public.trips DROP CONSTRAINT IF EXISTS trips_reservation_id_key;
ALTER TABLE IF EXISTS ONLY public.trips DROP CONSTRAINT IF EXISTS trips_pkey;
ALTER TABLE IF EXISTS ONLY public.trip_stage_history DROP CONSTRAINT IF EXISTS trip_stage_history_pkey;
ALTER TABLE IF EXISTS ONLY public.toll_sync_runs DROP CONSTRAINT IF EXISTS toll_sync_runs_pkey;
ALTER TABLE IF EXISTS ONLY public.toll_charges DROP CONSTRAINT IF EXISTS toll_charges_source_fingerprint_key;
ALTER TABLE IF EXISTS ONLY public.toll_charges DROP CONSTRAINT IF EXISTS toll_charges_pkey;
ALTER TABLE IF EXISTS ONLY public.teller_transactions DROP CONSTRAINT IF EXISTS teller_transactions_teller_transaction_id_key;
ALTER TABLE IF EXISTS ONLY public.teller_transactions DROP CONSTRAINT IF EXISTS teller_transactions_pkey;
ALTER TABLE IF EXISTS ONLY public.teller_tokens DROP CONSTRAINT IF EXISTS teller_tokens_pkey;
ALTER TABLE IF EXISTS ONLY public.teller_ignore_rules DROP CONSTRAINT IF EXISTS teller_ignore_rules_pkey;
ALTER TABLE IF EXISTS ONLY public.messages DROP CONSTRAINT IF EXISTS messages_pkey;
ALTER TABLE IF EXISTS ONLY public.messages DROP CONSTRAINT IF EXISTS messages_message_id_key;
ALTER TABLE IF EXISTS ONLY public.marketplace_preferences DROP CONSTRAINT IF EXISTS marketplace_preferences_pkey;
ALTER TABLE IF EXISTS ONLY public.marketplace_listings DROP CONSTRAINT IF EXISTS marketplace_listings_url_key;
ALTER TABLE IF EXISTS ONLY public.marketplace_listings DROP CONSTRAINT IF EXISTS marketplace_listings_pkey;
ALTER TABLE IF EXISTS ONLY public.maintenance_tasks DROP CONSTRAINT IF EXISTS maintenance_tasks_source_key_key;
ALTER TABLE IF EXISTS ONLY public.maintenance_tasks DROP CONSTRAINT IF EXISTS maintenance_tasks_pkey;
ALTER TABLE IF EXISTS ONLY public.maintenance_rules DROP CONSTRAINT IF EXISTS maintenance_rules_pkey;
ALTER TABLE IF EXISTS ONLY public.maintenance_rule_templates DROP CONSTRAINT IF EXISTS maintenance_rule_templates_rule_code_key;
ALTER TABLE IF EXISTS ONLY public.maintenance_rule_templates DROP CONSTRAINT IF EXISTS maintenance_rule_templates_pkey;
ALTER TABLE IF EXISTS ONLY public.maintenance_events DROP CONSTRAINT IF EXISTS maintenance_events_pkey;
ALTER TABLE IF EXISTS ONLY public.expenses DROP CONSTRAINT IF EXISTS expenses_pkey;
ALTER TABLE IF EXISTS ONLY public.app_settings DROP CONSTRAINT IF EXISTS app_settings_pkey;
ALTER TABLE IF EXISTS ONLY public.api_auth_tokens DROP CONSTRAINT IF EXISTS api_auth_tokens_service_name_key;
ALTER TABLE IF EXISTS ONLY public.api_auth_tokens DROP CONSTRAINT IF EXISTS api_auth_tokens_pkey;
ALTER TABLE IF EXISTS public.vehicles ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.vehicle_telemetry_snapshots ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.vehicle_telemetry_signal_values ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.vehicle_odometer_history ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.vehicle_condition_notes ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.trips ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.trip_stage_history ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.toll_sync_runs ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.toll_charges ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.teller_transactions ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.teller_tokens ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.teller_ignore_rules ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.messages ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.marketplace_listings ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.maintenance_tasks ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.maintenance_rules ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.maintenance_rule_templates ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.maintenance_events ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.trip_google_sync ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.google_calendar_connections ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.expenses ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.api_auth_tokens ALTER COLUMN id DROP DEFAULT;
DROP SEQUENCE IF EXISTS public.trip_google_sync_id_seq;
DROP TABLE IF EXISTS public.trip_google_sync;
DROP SEQUENCE IF EXISTS public.vehicles_id_seq;
DROP TABLE IF EXISTS public.vehicles;
DROP SEQUENCE IF EXISTS public.vehicle_telemetry_snapshots_id_seq;
DROP TABLE IF EXISTS public.vehicle_telemetry_snapshots;
DROP SEQUENCE IF EXISTS public.vehicle_telemetry_signal_values_id_seq;
DROP TABLE IF EXISTS public.vehicle_telemetry_signal_values;
DROP SEQUENCE IF EXISTS public.vehicle_odometer_history_id_seq;
DROP TABLE IF EXISTS public.vehicle_odometer_history;
DROP SEQUENCE IF EXISTS public.vehicle_condition_notes_id_seq;
DROP TABLE IF EXISTS public.vehicle_condition_notes;
DROP SEQUENCE IF EXISTS public.trips_id_seq;
DROP TABLE IF EXISTS public.trips;
DROP SEQUENCE IF EXISTS public.trip_stage_history_id_seq;
DROP TABLE IF EXISTS public.trip_stage_history;
DROP VIEW IF EXISTS public.trip_intelligence;
DROP SEQUENCE IF EXISTS public.toll_sync_runs_id_seq;
DROP TABLE IF EXISTS public.toll_sync_runs;
DROP SEQUENCE IF EXISTS public.toll_charges_id_seq;
DROP TABLE IF EXISTS public.toll_charges;
DROP SEQUENCE IF EXISTS public.teller_transactions_id_seq;
DROP TABLE IF EXISTS public.teller_transactions;
DROP SEQUENCE IF EXISTS public.teller_tokens_id_seq;
DROP TABLE IF EXISTS public.teller_tokens;
DROP SEQUENCE IF EXISTS public.teller_ignore_rules_id_seq;
DROP TABLE IF EXISTS public.teller_ignore_rules;
DROP SEQUENCE IF EXISTS public.messages_id_seq;
DROP TABLE IF EXISTS public.messages;
DROP TABLE IF EXISTS public.marketplace_preferences;
DROP SEQUENCE IF EXISTS public.marketplace_listings_id_seq;
DROP TABLE IF EXISTS public.marketplace_listings;
DROP SEQUENCE IF EXISTS public.maintenance_tasks_id_seq;
DROP TABLE IF EXISTS public.maintenance_tasks;
DROP SEQUENCE IF EXISTS public.maintenance_rules_id_seq;
DROP TABLE IF EXISTS public.maintenance_rules;
DROP SEQUENCE IF EXISTS public.maintenance_rule_templates_id_seq;
DROP TABLE IF EXISTS public.maintenance_rule_templates;
DROP SEQUENCE IF EXISTS public.maintenance_events_id_seq;
DROP TABLE IF EXISTS public.maintenance_events;
DROP SEQUENCE IF EXISTS public.google_calendar_connections_id_seq;
DROP TABLE IF EXISTS public.google_calendar_connections;
DROP SEQUENCE IF EXISTS public.expenses_id_seq;
DROP TABLE IF EXISTS public.expenses;
DROP TABLE IF EXISTS public.app_settings;
DROP SEQUENCE IF EXISTS public.api_auth_tokens_id_seq;
DROP TABLE IF EXISTS public.api_auth_tokens;
DROP FUNCTION IF EXISTS public.set_updated_at();
DROP SCHEMA IF EXISTS public;
--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: set_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: api_auth_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.api_auth_tokens (
    id integer NOT NULL,
    service_name text NOT NULL,
    access_token text,
    refresh_token text,
    token_type text DEFAULT 'Bearer'::text,
    expires_at timestamp without time zone,
    raw_token jsonb,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: api_auth_tokens_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.api_auth_tokens_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: api_auth_tokens_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.api_auth_tokens_id_seq OWNED BY public.api_auth_tokens.id;


--
-- Name: app_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_settings (
    key text NOT NULL,
    value jsonb NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: expenses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.expenses (
    id integer NOT NULL,
    vehicle_id integer,
    vendor character varying(100),
    price numeric(10,2) NOT NULL,
    tax numeric(10,2) DEFAULT 0,
    is_capitalized boolean DEFAULT false,
    category character varying(50),
    notes text,
    date date NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    expense_scope character varying(20) DEFAULT 'direct'::character varying,
    trip_id integer,
    legacy_vehicle_id integer,
    CONSTRAINT expenses_expense_scope_check CHECK (((expense_scope)::text = ANY (ARRAY[('direct'::character varying)::text, ('general'::character varying)::text, ('apportioned'::character varying)::text])))
);


--
-- Name: expenses_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.expenses_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: expenses_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.expenses_id_seq OWNED BY public.expenses.id;


--
-- Name: google_calendar_connections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.google_calendar_connections (
    id integer NOT NULL,
    user_id integer,
    google_email text,
    calendar_id text,
    calendar_summary text,
    refresh_token_encrypted text NOT NULL,
    scope_string text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: google_calendar_connections_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.google_calendar_connections_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: google_calendar_connections_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.google_calendar_connections_id_seq OWNED BY public.google_calendar_connections.id;


--
-- Name: maintenance_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.maintenance_events (
    id bigint NOT NULL,
    vehicle_vin text NOT NULL,
    rule_id bigint,
    event_type text NOT NULL,
    title text NOT NULL,
    performed_at timestamp without time zone NOT NULL,
    odometer_miles integer,
    result text NOT NULL,
    notes text,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    performed_by text,
    source text DEFAULT 'manual'::text NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT maintenance_events_odometer_miles_check CHECK (((odometer_miles IS NULL) OR (odometer_miles >= 0))),
    CONSTRAINT maintenance_events_result_check CHECK ((result = ANY (ARRAY['pass'::text, 'fail'::text, 'attention'::text, 'performed'::text, 'measured'::text, 'not_applicable'::text]))),
    CONSTRAINT maintenance_events_source_check CHECK ((source = ANY (ARRAY['manual'::text, 'shop'::text, 'inspection'::text, 'system'::text, 'guest_report_followup'::text])))
);


--
-- Name: maintenance_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.maintenance_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: maintenance_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.maintenance_events_id_seq OWNED BY public.maintenance_events.id;


--
-- Name: maintenance_rule_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.maintenance_rule_templates (
    id bigint NOT NULL,
    rule_code text NOT NULL,
    title text NOT NULL,
    description text,
    category text NOT NULL,
    interval_miles integer,
    interval_days integer,
    due_soon_miles integer DEFAULT 500 NOT NULL,
    due_soon_days integer DEFAULT 14 NOT NULL,
    blocks_rental_when_overdue boolean DEFAULT false NOT NULL,
    blocks_guest_export_when_overdue boolean DEFAULT false CONSTRAINT maintenance_rule_templates_blocks_guest_export_when_ov_not_null NOT NULL,
    requires_pass_result boolean DEFAULT false NOT NULL,
    rule_config jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT maintenance_rule_templates_category_check CHECK ((category = ANY (ARRAY['inspection'::text, 'service'::text, 'safety'::text, 'compliance'::text, 'other'::text]))),
    CONSTRAINT maintenance_rule_templates_check CHECK (((interval_miles IS NOT NULL) OR (interval_days IS NOT NULL))),
    CONSTRAINT maintenance_rule_templates_due_soon_days_check CHECK ((due_soon_days >= 0)),
    CONSTRAINT maintenance_rule_templates_due_soon_miles_check CHECK ((due_soon_miles >= 0)),
    CONSTRAINT maintenance_rule_templates_interval_days_check CHECK (((interval_days IS NULL) OR (interval_days > 0))),
    CONSTRAINT maintenance_rule_templates_interval_miles_check CHECK (((interval_miles IS NULL) OR (interval_miles > 0)))
);


--
-- Name: maintenance_rule_templates_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.maintenance_rule_templates_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: maintenance_rule_templates_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.maintenance_rule_templates_id_seq OWNED BY public.maintenance_rule_templates.id;


--
-- Name: maintenance_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.maintenance_rules (
    id bigint NOT NULL,
    vehicle_vin text NOT NULL,
    rule_code text NOT NULL,
    title text NOT NULL,
    description text,
    category text NOT NULL,
    interval_miles integer,
    interval_days integer,
    due_soon_miles integer DEFAULT 500 NOT NULL,
    due_soon_days integer DEFAULT 14 NOT NULL,
    blocks_rental_when_overdue boolean DEFAULT false NOT NULL,
    blocks_guest_export_when_overdue boolean DEFAULT false NOT NULL,
    requires_pass_result boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    rule_config jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT maintenance_rules_category_check CHECK ((category = ANY (ARRAY['inspection'::text, 'service'::text, 'safety'::text, 'compliance'::text, 'other'::text]))),
    CONSTRAINT maintenance_rules_due_soon_days_check CHECK ((due_soon_days >= 0)),
    CONSTRAINT maintenance_rules_due_soon_miles_check CHECK ((due_soon_miles >= 0)),
    CONSTRAINT maintenance_rules_interval_days_check CHECK (((interval_days IS NULL) OR (interval_days > 0))),
    CONSTRAINT maintenance_rules_interval_miles_check CHECK (((interval_miles IS NULL) OR (interval_miles > 0))),
    CONSTRAINT maintenance_rules_interval_required CHECK (((interval_miles IS NOT NULL) OR (interval_days IS NOT NULL)))
);


--
-- Name: maintenance_rules_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.maintenance_rules_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: maintenance_rules_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.maintenance_rules_id_seq OWNED BY public.maintenance_rules.id;


--
-- Name: maintenance_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.maintenance_tasks (
    id bigint NOT NULL,
    vehicle_vin text NOT NULL,
    rule_id bigint,
    task_type text NOT NULL,
    title text NOT NULL,
    description text,
    priority text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    blocks_rental boolean DEFAULT false NOT NULL,
    blocks_guest_export boolean DEFAULT false NOT NULL,
    needs_review boolean DEFAULT false NOT NULL,
    source text DEFAULT 'manual'::text NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    trigger_type text,
    trigger_context jsonb DEFAULT '{}'::jsonb NOT NULL,
    related_trip_id bigint,
    source_key text,
    CONSTRAINT maintenance_tasks_priority_check CHECK ((priority = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text, 'urgent'::text]))),
    CONSTRAINT maintenance_tasks_source_check CHECK ((source = ANY (ARRAY['manual'::text, 'rule_engine'::text, 'guest_report'::text, 'inspection'::text, 'system'::text]))),
    CONSTRAINT maintenance_tasks_status_check CHECK ((status = ANY (ARRAY['open'::text, 'scheduled'::text, 'in_progress'::text, 'deferred'::text, 'resolved'::text, 'canceled'::text])))
);


--
-- Name: maintenance_tasks_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.maintenance_tasks_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: maintenance_tasks_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.maintenance_tasks_id_seq OWNED BY public.maintenance_tasks.id;


--
-- Name: marketplace_listings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.marketplace_listings (
    id bigint NOT NULL,
    url text NOT NULL,
    normalized_url text GENERATED ALWAYS AS (url) STORED,
    title text,
    price_text text,
    price_numeric numeric(12,2),
    listed_ago text,
    listed_location text,
    vin character varying(17),
    driven_miles integer,
    transmission text,
    exterior_color text,
    interior_color text,
    fuel_type text,
    owners integer,
    paid_off boolean,
    nhtsa_rating_overall integer,
    seller_name text,
    seller_joined_year integer,
    seller_description text,
    raw_text_sample text,
    keywords jsonb DEFAULT '[]'::jsonb,
    hidden boolean DEFAULT false NOT NULL,
    ignored_at timestamp with time zone,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    scraped_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    decision_status text,
    decision_score integer,
    decision_notes text,
    decision_tags jsonb DEFAULT '[]'::jsonb NOT NULL,
    reviewed_at timestamp with time zone,
    title_flags jsonb DEFAULT '[]'::jsonb NOT NULL,
    suspicious_flags jsonb DEFAULT '[]'::jsonb NOT NULL,
    open_count integer DEFAULT 0 NOT NULL,
    last_opened_at timestamp with time zone,
    enriched_at timestamp with time zone
);


--
-- Name: marketplace_listings_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.marketplace_listings_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: marketplace_listings_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.marketplace_listings_id_seq OWNED BY public.marketplace_listings.id;


--
-- Name: marketplace_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.marketplace_preferences (
    preference_key text NOT NULL,
    preference_value jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.messages (
    id integer NOT NULL,
    message_id text,
    subject text,
    raw_headers text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    status text DEFAULT 'unread'::text,
    mailbox text,
    imap_uid bigint,
    from_header text,
    to_header text,
    date_header text,
    message_timestamp timestamp with time zone,
    content_type_header text,
    flags text[],
    text_body text,
    html_body text,
    raw_source bytea,
    ingested_at timestamp with time zone DEFAULT now(),
    amount numeric(10,2),
    normalized_text_body text,
    guest_name text,
    guest_phone text,
    guest_profile_url text,
    vehicle_name text,
    vehicle_year integer,
    reservation_id bigint,
    trip_start timestamp with time zone,
    trip_end timestamp with time zone,
    mileage_included integer,
    guest_message text,
    reply_url text,
    trip_details_url text,
    message_type text,
    vehicle_listing_url text,
    vehicle_listing_id bigint,
    vehicle_image_url text,
    trip_id integer
);


--
-- Name: messages_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.messages_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: messages_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.messages_id_seq OWNED BY public.messages.id;


--
-- Name: teller_ignore_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.teller_ignore_rules (
    id bigint NOT NULL,
    match_type text NOT NULL,
    match_value text NOT NULL,
    reason text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT teller_ignore_rules_match_type_check CHECK ((match_type = ANY (ARRAY['exact'::text, 'contains'::text])))
);


--
-- Name: teller_ignore_rules_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.teller_ignore_rules_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: teller_ignore_rules_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.teller_ignore_rules_id_seq OWNED BY public.teller_ignore_rules.id;


--
-- Name: teller_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.teller_tokens (
    id integer NOT NULL,
    access_token text NOT NULL,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: teller_tokens_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.teller_tokens_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: teller_tokens_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.teller_tokens_id_seq OWNED BY public.teller_tokens.id;


--
-- Name: teller_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.teller_transactions (
    id bigint NOT NULL,
    teller_transaction_id text NOT NULL,
    teller_account_id text NOT NULL,
    transaction_date date NOT NULL,
    description text,
    amount numeric(12,2) NOT NULL,
    transaction_type text,
    status text,
    running_balance numeric(12,2),
    processing_status text,
    counterparty_name text,
    category text,
    account_link text,
    self_link text,
    raw_json jsonb NOT NULL,
    ignored boolean DEFAULT false NOT NULL,
    ignore_reason text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    review_status text DEFAULT 'pending'::text NOT NULL,
    matched_expense_id integer,
    match_confidence numeric(5,2),
    match_method text,
    reviewed_at timestamp without time zone,
    review_notes text,
    CONSTRAINT teller_transactions_review_status_check CHECK ((review_status = ANY (ARRAY['pending'::text, 'matched'::text, 'created'::text, 'ignored'::text, 'dismissed'::text])))
);


--
-- Name: teller_transactions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.teller_transactions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: teller_transactions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.teller_transactions_id_seq OWNED BY public.teller_transactions.id;


--
-- Name: toll_charges; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.toll_charges (
    id bigint NOT NULL,
    source text DEFAULT 'hctra_eztag'::text NOT NULL,
    external_fingerprint text NOT NULL,
    trxn_at timestamp with time zone NOT NULL,
    posted_at timestamp with time zone,
    license_plate text,
    license_state text,
    license_plate_normalized text,
    vehicle_nickname text,
    amount numeric(10,2) NOT NULL,
    agency_name text,
    facility_name text,
    plaza_name text,
    lane_name text,
    direction text,
    trans_type text,
    matched_vehicle_id bigint,
    matched_trip_id bigint,
    match_status text DEFAULT 'unmatched'::text NOT NULL,
    review_status text DEFAULT 'pending'::text NOT NULL,
    raw_payload jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: toll_charges_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.toll_charges_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: toll_charges_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.toll_charges_id_seq OWNED BY public.toll_charges.id;


--
-- Name: toll_sync_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.toll_sync_runs (
    id bigint NOT NULL,
    source text DEFAULT 'hctra_eztag'::text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    status text DEFAULT 'running'::text NOT NULL,
    records_seen integer DEFAULT 0 NOT NULL,
    records_imported integer DEFAULT 0 NOT NULL,
    records_skipped integer DEFAULT 0 NOT NULL,
    records_matched_vehicle integer DEFAULT 0 NOT NULL,
    records_matched_trip integer DEFAULT 0 NOT NULL,
    error_text text,
    meta jsonb
);


--
-- Name: toll_sync_runs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.toll_sync_runs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: toll_sync_runs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.toll_sync_runs_id_seq OWNED BY public.toll_sync_runs.id;


--
-- Name: trip_intelligence; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.trip_intelligence AS
SELECT
    NULL::integer AS id,
    NULL::bigint AS reservation_id,
    NULL::text AS vehicle_name,
    NULL::text AS guest_name,
    NULL::timestamp with time zone AS trip_start,
    NULL::timestamp with time zone AS trip_end,
    NULL::text AS status,
    NULL::numeric(10,2) AS amount,
    NULL::boolean AS needs_review,
    NULL::timestamp with time zone AS created_at,
    NULL::timestamp with time zone AS updated_at,
    NULL::bigint AS message_count,
    NULL::bigint AS unread_messages,
    NULL::timestamp with time zone AS last_message_at,
    NULL::timestamp with time zone AS last_unread_at;


--
-- Name: trip_stage_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trip_stage_history (
    id bigint NOT NULL,
    trip_id integer NOT NULL,
    previous_stage text,
    next_stage text NOT NULL,
    changed_at timestamp with time zone DEFAULT now() NOT NULL,
    changed_by text,
    reason text
);


--
-- Name: trip_stage_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.trip_stage_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: trip_stage_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.trip_stage_history_id_seq OWNED BY public.trip_stage_history.id;


--
-- Name: trips; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trips (
    id integer NOT NULL,
    reservation_id bigint NOT NULL,
    vehicle_name text,
    guest_name text,
    trip_start timestamp with time zone,
    trip_end timestamp with time zone,
    status text,
    amount numeric(10,2),
    trip_details_url text,
    guest_profile_url text,
    created_from_message_id text,
    last_message_id text,
    needs_review boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    closed_out boolean DEFAULT false NOT NULL,
    closed_out_at timestamp with time zone,
    turo_vehicle_id text,
    workflow_stage text DEFAULT 'booked'::text NOT NULL,
    stage_updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    expense_status text,
    completed_at timestamp without time zone,
    canceled_at timestamp without time zone,
    mileage_included integer,
    starting_odometer integer,
    has_tolls boolean DEFAULT false NOT NULL,
    toll_count integer DEFAULT 0 NOT NULL,
    toll_total numeric(10,2) DEFAULT 0.00 NOT NULL,
    toll_review_status text DEFAULT 'none'::text NOT NULL,
    ending_odometer integer,
    fuel_reimbursement_total numeric(10,2),
    max_engine_rpm numeric,
    notes text,
    deleted_at timestamp with time zone,
    CONSTRAINT trips_expense_status_check CHECK (((expense_status IS NULL) OR (expense_status = ANY (ARRAY['none'::text, 'pending'::text, 'submitted'::text, 'resolved'::text, 'waived'::text])))),
    CONSTRAINT trips_toll_review_status_check CHECK ((toll_review_status = ANY (ARRAY['none'::text, 'pending'::text, 'reviewed'::text, 'billed'::text, 'waived'::text]))),
    CONSTRAINT trips_workflow_stage_check CHECK ((workflow_stage = ANY (ARRAY['booked'::text, 'confirmed'::text, 'ready_for_handoff'::text, 'in_progress'::text, 'turnaround'::text, 'awaiting_expenses'::text, 'complete'::text, 'canceled'::text])))
);


--
-- Name: trips_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.trips_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: trips_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.trips_id_seq OWNED BY public.trips.id;


--
-- Name: trip_google_sync; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trip_google_sync (
    id integer NOT NULL,
    trip_id integer NOT NULL,
    google_calendar_connection_id integer NOT NULL,
    event_type text NOT NULL,
    google_event_id text NOT NULL,
    sync_status text DEFAULT 'synced'::text NOT NULL,
    last_synced_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: trip_google_sync_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.trip_google_sync_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: trip_google_sync_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.trip_google_sync_id_seq OWNED BY public.trip_google_sync.id;


--
-- Name: vehicle_condition_notes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vehicle_condition_notes (
    id bigint NOT NULL,
    vehicle_vin text NOT NULL,
    note_type text NOT NULL,
    area text NOT NULL,
    title text NOT NULL,
    description text NOT NULL,
    severity text DEFAULT 'minor'::text NOT NULL,
    guest_visible boolean DEFAULT true NOT NULL,
    active boolean DEFAULT true NOT NULL,
    recorded_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    resolved_at timestamp without time zone,
    photo_url text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT vehicle_condition_notes_note_type_check CHECK ((note_type = ANY (ARRAY['scratch'::text, 'ding'::text, 'chip'::text, 'scuff'::text, 'crack'::text, 'stain'::text, 'other'::text]))),
    CONSTRAINT vehicle_condition_notes_resolved_consistency CHECK ((((active = true) AND (resolved_at IS NULL)) OR (active = false))),
    CONSTRAINT vehicle_condition_notes_severity_check CHECK ((severity = ANY (ARRAY['minor'::text, 'moderate'::text, 'major'::text])))
);


--
-- Name: vehicle_condition_notes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.vehicle_condition_notes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: vehicle_condition_notes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.vehicle_condition_notes_id_seq OWNED BY public.vehicle_condition_notes.id;


--
-- Name: vehicle_odometer_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vehicle_odometer_history (
    id bigint NOT NULL,
    vehicle_id bigint NOT NULL,
    odometer_miles integer NOT NULL,
    recorded_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    source text DEFAULT 'system'::text NOT NULL
);


--
-- Name: vehicle_odometer_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.vehicle_odometer_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: vehicle_odometer_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.vehicle_odometer_history_id_seq OWNED BY public.vehicle_odometer_history.id;


--
-- Name: vehicle_telemetry_signal_values; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vehicle_telemetry_signal_values (
    id bigint NOT NULL,
    snapshot_id bigint,
    captured_at timestamp without time zone DEFAULT now() NOT NULL,
    service_name text NOT NULL,
    dimo_token_id bigint NOT NULL,
    vin text,
    signal_name text NOT NULL,
    value_json jsonb,
    value_numeric numeric,
    value_text text,
    value_boolean boolean,
    signal_timestamp timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: vehicle_telemetry_signal_values_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.vehicle_telemetry_signal_values_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: vehicle_telemetry_signal_values_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.vehicle_telemetry_signal_values_id_seq OWNED BY public.vehicle_telemetry_signal_values.id;


--
-- Name: vehicle_telemetry_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vehicle_telemetry_snapshots (
    id bigint NOT NULL,
    service_name text DEFAULT 'bouncie'::text NOT NULL,
    vin text,
    imei text,
    nickname text,
    make text,
    model text,
    year integer,
    standard_engine text,
    odometer numeric,
    fuel_level numeric,
    is_running boolean,
    speed numeric,
    latitude numeric,
    longitude numeric,
    heading numeric,
    address text,
    mil_on boolean,
    mil_last_updated timestamp without time zone,
    battery_status text,
    battery_last_updated timestamp without time zone,
    vehicle_last_updated timestamp without time zone,
    captured_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    raw_payload jsonb,
    local_time_zone text,
    qualified_dtc_list jsonb,
    dimo_token_id bigint,
    provider_vehicle_id text,
    fuel_level_last_updated timestamp without time zone,
    odometer_last_updated timestamp without time zone,
    speed_last_updated timestamp without time zone,
    location_last_updated timestamp without time zone,
    heading_last_updated timestamp without time zone,
    ignition_last_updated timestamp without time zone,
    battery_voltage numeric,
    battery_voltage_last_updated timestamp without time zone,
    obd_plugged_in boolean,
    obd_plugged_in_last_updated timestamp without time zone,
    dtc_count integer,
    distance_with_mil numeric,
    coolant_temp numeric,
    engine_rpm numeric,
    throttle_position numeric,
    runtime_minutes numeric,
    def_level numeric,
    external_vehicle_key text
);


--
-- Name: vehicle_telemetry_snapshots_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.vehicle_telemetry_snapshots_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: vehicle_telemetry_snapshots_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.vehicle_telemetry_snapshots_id_seq OWNED BY public.vehicle_telemetry_snapshots.id;


--
-- Name: vehicles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vehicles (
    vin text NOT NULL,
    imei text,
    nickname text,
    make text,
    model text,
    year integer,
    bouncie_vehicle_id text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    standard_engine text,
    turo_vehicle_name text,
    turo_vehicle_id text,
    service_due boolean DEFAULT false,
    is_active boolean DEFAULT true NOT NULL,
    id bigint NOT NULL,
    current_odometer_miles integer,
    license_plate text,
    license_state text,
    registration_month integer,
    registration_year integer,
    oil_type text,
    oil_capacity_quarts numeric(4,2),
    oil_capacity_liters numeric(4,2),
    onboarding_date date,
    acquisition_cost numeric(10,2),
    retired_at date,
    in_service boolean DEFAULT true NOT NULL,
    dimo_token_id bigint,
    external_vehicle_key text,
    provider_vehicle_id text,
    rockauto_url text
);


--
-- Name: vehicles_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.vehicles_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: vehicles_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.vehicles_id_seq OWNED BY public.vehicles.id;


--
-- Name: api_auth_tokens id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_auth_tokens ALTER COLUMN id SET DEFAULT nextval('public.api_auth_tokens_id_seq'::regclass);


--
-- Name: expenses id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses ALTER COLUMN id SET DEFAULT nextval('public.expenses_id_seq'::regclass);


--
-- Name: google_calendar_connections id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.google_calendar_connections ALTER COLUMN id SET DEFAULT nextval('public.google_calendar_connections_id_seq'::regclass);


--
-- Name: maintenance_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maintenance_events ALTER COLUMN id SET DEFAULT nextval('public.maintenance_events_id_seq'::regclass);


--
-- Name: maintenance_rule_templates id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maintenance_rule_templates ALTER COLUMN id SET DEFAULT nextval('public.maintenance_rule_templates_id_seq'::regclass);


--
-- Name: maintenance_rules id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maintenance_rules ALTER COLUMN id SET DEFAULT nextval('public.maintenance_rules_id_seq'::regclass);


--
-- Name: maintenance_tasks id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maintenance_tasks ALTER COLUMN id SET DEFAULT nextval('public.maintenance_tasks_id_seq'::regclass);


--
-- Name: marketplace_listings id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketplace_listings ALTER COLUMN id SET DEFAULT nextval('public.marketplace_listings_id_seq'::regclass);


--
-- Name: messages id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages ALTER COLUMN id SET DEFAULT nextval('public.messages_id_seq'::regclass);


--
-- Name: teller_ignore_rules id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teller_ignore_rules ALTER COLUMN id SET DEFAULT nextval('public.teller_ignore_rules_id_seq'::regclass);


--
-- Name: teller_tokens id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teller_tokens ALTER COLUMN id SET DEFAULT nextval('public.teller_tokens_id_seq'::regclass);


--
-- Name: teller_transactions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teller_transactions ALTER COLUMN id SET DEFAULT nextval('public.teller_transactions_id_seq'::regclass);


--
-- Name: toll_charges id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.toll_charges ALTER COLUMN id SET DEFAULT nextval('public.toll_charges_id_seq'::regclass);


--
-- Name: toll_sync_runs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.toll_sync_runs ALTER COLUMN id SET DEFAULT nextval('public.toll_sync_runs_id_seq'::regclass);


--
-- Name: trip_stage_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trip_stage_history ALTER COLUMN id SET DEFAULT nextval('public.trip_stage_history_id_seq'::regclass);


--
-- Name: trips id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trips ALTER COLUMN id SET DEFAULT nextval('public.trips_id_seq'::regclass);


--
-- Name: trip_google_sync id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trip_google_sync ALTER COLUMN id SET DEFAULT nextval('public.trip_google_sync_id_seq'::regclass);


--
-- Name: vehicle_condition_notes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicle_condition_notes ALTER COLUMN id SET DEFAULT nextval('public.vehicle_condition_notes_id_seq'::regclass);


--
-- Name: vehicle_odometer_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicle_odometer_history ALTER COLUMN id SET DEFAULT nextval('public.vehicle_odometer_history_id_seq'::regclass);


--
-- Name: vehicle_telemetry_signal_values id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicle_telemetry_signal_values ALTER COLUMN id SET DEFAULT nextval('public.vehicle_telemetry_signal_values_id_seq'::regclass);


--
-- Name: vehicle_telemetry_snapshots id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicle_telemetry_snapshots ALTER COLUMN id SET DEFAULT nextval('public.vehicle_telemetry_snapshots_id_seq'::regclass);


--
-- Name: vehicles id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicles ALTER COLUMN id SET DEFAULT nextval('public.vehicles_id_seq'::regclass);


--
-- Name: api_auth_tokens api_auth_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_auth_tokens
    ADD CONSTRAINT api_auth_tokens_pkey PRIMARY KEY (id);


--
-- Name: api_auth_tokens api_auth_tokens_service_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_auth_tokens
    ADD CONSTRAINT api_auth_tokens_service_name_key UNIQUE (service_name);


--
-- Name: app_settings app_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_settings
    ADD CONSTRAINT app_settings_pkey PRIMARY KEY (key);


--
-- Name: expenses expenses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_pkey PRIMARY KEY (id);


--
-- Name: google_calendar_connections google_calendar_connections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.google_calendar_connections
    ADD CONSTRAINT google_calendar_connections_pkey PRIMARY KEY (id);


--
-- Name: maintenance_events maintenance_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maintenance_events
    ADD CONSTRAINT maintenance_events_pkey PRIMARY KEY (id);


--
-- Name: maintenance_rule_templates maintenance_rule_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maintenance_rule_templates
    ADD CONSTRAINT maintenance_rule_templates_pkey PRIMARY KEY (id);


--
-- Name: maintenance_rule_templates maintenance_rule_templates_rule_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maintenance_rule_templates
    ADD CONSTRAINT maintenance_rule_templates_rule_code_key UNIQUE (rule_code);


--
-- Name: maintenance_rules maintenance_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maintenance_rules
    ADD CONSTRAINT maintenance_rules_pkey PRIMARY KEY (id);


--
-- Name: maintenance_tasks maintenance_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maintenance_tasks
    ADD CONSTRAINT maintenance_tasks_pkey PRIMARY KEY (id);


--
-- Name: maintenance_tasks maintenance_tasks_source_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maintenance_tasks
    ADD CONSTRAINT maintenance_tasks_source_key_key UNIQUE (source_key);


--
-- Name: marketplace_listings marketplace_listings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketplace_listings
    ADD CONSTRAINT marketplace_listings_pkey PRIMARY KEY (id);


--
-- Name: marketplace_listings marketplace_listings_url_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketplace_listings
    ADD CONSTRAINT marketplace_listings_url_key UNIQUE (url);


--
-- Name: marketplace_preferences marketplace_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketplace_preferences
    ADD CONSTRAINT marketplace_preferences_pkey PRIMARY KEY (preference_key);


--
-- Name: messages messages_message_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_message_id_key UNIQUE (message_id);


--
-- Name: messages messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);


--
-- Name: teller_ignore_rules teller_ignore_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teller_ignore_rules
    ADD CONSTRAINT teller_ignore_rules_pkey PRIMARY KEY (id);


--
-- Name: teller_tokens teller_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teller_tokens
    ADD CONSTRAINT teller_tokens_pkey PRIMARY KEY (id);


--
-- Name: teller_transactions teller_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teller_transactions
    ADD CONSTRAINT teller_transactions_pkey PRIMARY KEY (id);


--
-- Name: teller_transactions teller_transactions_teller_transaction_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teller_transactions
    ADD CONSTRAINT teller_transactions_teller_transaction_id_key UNIQUE (teller_transaction_id);


--
-- Name: toll_charges toll_charges_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.toll_charges
    ADD CONSTRAINT toll_charges_pkey PRIMARY KEY (id);


--
-- Name: toll_charges toll_charges_source_fingerprint_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.toll_charges
    ADD CONSTRAINT toll_charges_source_fingerprint_key UNIQUE (source, external_fingerprint);


--
-- Name: toll_sync_runs toll_sync_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.toll_sync_runs
    ADD CONSTRAINT toll_sync_runs_pkey PRIMARY KEY (id);


--
-- Name: trip_stage_history trip_stage_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trip_stage_history
    ADD CONSTRAINT trip_stage_history_pkey PRIMARY KEY (id);


--
-- Name: trips trips_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trips
    ADD CONSTRAINT trips_pkey PRIMARY KEY (id);


--
-- Name: trips trips_reservation_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trips
    ADD CONSTRAINT trips_reservation_id_key UNIQUE (reservation_id);


--
-- Name: trip_google_sync trip_google_sync_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trip_google_sync
    ADD CONSTRAINT trip_google_sync_pkey PRIMARY KEY (id);


--
-- Name: trip_google_sync trip_google_sync_trip_id_google_calendar_connection_id_even_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trip_google_sync
    ADD CONSTRAINT trip_google_sync_trip_id_google_calendar_connection_id_even_key UNIQUE (trip_id, google_calendar_connection_id, event_type);


--
-- Name: vehicle_condition_notes vehicle_condition_notes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicle_condition_notes
    ADD CONSTRAINT vehicle_condition_notes_pkey PRIMARY KEY (id);


--
-- Name: vehicle_odometer_history vehicle_odometer_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicle_odometer_history
    ADD CONSTRAINT vehicle_odometer_history_pkey PRIMARY KEY (id);


--
-- Name: vehicle_telemetry_signal_values vehicle_telemetry_signal_values_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicle_telemetry_signal_values
    ADD CONSTRAINT vehicle_telemetry_signal_values_pkey PRIMARY KEY (id);


--
-- Name: vehicle_telemetry_snapshots vehicle_telemetry_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicle_telemetry_snapshots
    ADD CONSTRAINT vehicle_telemetry_snapshots_pkey PRIMARY KEY (id);


--
-- Name: vehicles vehicles_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicles
    ADD CONSTRAINT vehicles_id_key UNIQUE (id);


--
-- Name: vehicles vehicles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicles
    ADD CONSTRAINT vehicles_pkey PRIMARY KEY (vin);


--
-- Name: idx_expenses_date_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_expenses_date_category ON public.expenses USING btree (date, category);


--
-- Name: idx_maintenance_events_data_gin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_maintenance_events_data_gin ON public.maintenance_events USING gin (data);


--
-- Name: idx_maintenance_events_result; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_maintenance_events_result ON public.maintenance_events USING btree (vehicle_vin, result);


--
-- Name: idx_maintenance_events_rule_id_performed_at_desc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_maintenance_events_rule_id_performed_at_desc ON public.maintenance_events USING btree (rule_id, performed_at DESC);


--
-- Name: idx_maintenance_events_vehicle_performed_at_desc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_maintenance_events_vehicle_performed_at_desc ON public.maintenance_events USING btree (vehicle_vin, performed_at DESC);


--
-- Name: idx_maintenance_events_vehicle_rule; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_maintenance_events_vehicle_rule ON public.maintenance_events USING btree (vehicle_vin, rule_id, performed_at DESC);


--
-- Name: idx_maintenance_events_vehicle_vin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_maintenance_events_vehicle_vin ON public.maintenance_events USING btree (vehicle_vin);


--
-- Name: idx_maintenance_rule_templates_active_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_maintenance_rule_templates_active_category ON public.maintenance_rule_templates USING btree (is_active, category, title);


--
-- Name: idx_maintenance_rules_vehicle_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_maintenance_rules_vehicle_active ON public.maintenance_rules USING btree (vehicle_vin, is_active);


--
-- Name: idx_maintenance_rules_vehicle_rule_code; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_maintenance_rules_vehicle_rule_code ON public.maintenance_rules USING btree (vehicle_vin, rule_code);


--
-- Name: idx_maintenance_rules_vehicle_vin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_maintenance_rules_vehicle_vin ON public.maintenance_rules USING btree (vehicle_vin);


--
-- Name: idx_maintenance_tasks_blockers; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_maintenance_tasks_blockers ON public.maintenance_tasks USING btree (vehicle_vin, blocks_rental, blocks_guest_export) WHERE (status = ANY (ARRAY['open'::text, 'scheduled'::text, 'in_progress'::text, 'deferred'::text]));


--
-- Name: idx_maintenance_tasks_rule_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_maintenance_tasks_rule_id ON public.maintenance_tasks USING btree (rule_id);


--
-- Name: idx_maintenance_tasks_vehicle_status_priority; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_maintenance_tasks_vehicle_status_priority ON public.maintenance_tasks USING btree (vehicle_vin, status, priority);


--
-- Name: idx_maintenance_tasks_vehicle_vin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_maintenance_tasks_vehicle_vin ON public.maintenance_tasks USING btree (vehicle_vin);


--
-- Name: idx_marketplace_listings_driven_miles; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_marketplace_listings_driven_miles ON public.marketplace_listings USING btree (driven_miles);


--
-- Name: idx_marketplace_listings_hidden; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_marketplace_listings_hidden ON public.marketplace_listings USING btree (hidden);


--
-- Name: idx_marketplace_listings_keywords_gin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_marketplace_listings_keywords_gin ON public.marketplace_listings USING gin (keywords);


--
-- Name: idx_marketplace_listings_last_seen_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_marketplace_listings_last_seen_at ON public.marketplace_listings USING btree (last_seen_at);


--
-- Name: idx_marketplace_listings_price_numeric; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_marketplace_listings_price_numeric ON public.marketplace_listings USING btree (price_numeric);


--
-- Name: idx_marketplace_listings_vin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_marketplace_listings_vin ON public.marketplace_listings USING btree (vin);


--
-- Name: idx_messages_mailbox_uid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_messages_mailbox_uid ON public.messages USING btree (mailbox, imap_uid);


--
-- Name: idx_messages_message_timestamp; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_messages_message_timestamp ON public.messages USING btree (message_timestamp);


--
-- Name: idx_messages_reservation_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_messages_reservation_id ON public.messages USING btree (reservation_id);


--
-- Name: idx_messages_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_messages_status ON public.messages USING btree (status);


--
-- Name: idx_messages_trip_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_messages_trip_id ON public.messages USING btree (trip_id);


--
-- Name: idx_teller_transactions_account_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_teller_transactions_account_id ON public.teller_transactions USING btree (teller_account_id);


--
-- Name: idx_teller_transactions_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_teller_transactions_date ON public.teller_transactions USING btree (transaction_date);


--
-- Name: idx_teller_transactions_description; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_teller_transactions_description ON public.teller_transactions USING btree (description);


--
-- Name: idx_teller_transactions_ignored; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_teller_transactions_ignored ON public.teller_transactions USING btree (ignored);


--
-- Name: idx_toll_charges_license_plate_normalized; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_toll_charges_license_plate_normalized ON public.toll_charges USING btree (license_plate_normalized);


--
-- Name: idx_toll_charges_matched_trip_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_toll_charges_matched_trip_id ON public.toll_charges USING btree (matched_trip_id);


--
-- Name: idx_toll_charges_matched_vehicle_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_toll_charges_matched_vehicle_id ON public.toll_charges USING btree (matched_vehicle_id);


--
-- Name: idx_toll_charges_trxn_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_toll_charges_trxn_at ON public.toll_charges USING btree (trxn_at);


--
-- Name: idx_trip_stage_history_trip_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trip_stage_history_trip_id ON public.trip_stage_history USING btree (trip_id, changed_at DESC);


--
-- Name: idx_trips_has_tolls; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trips_has_tolls ON public.trips USING btree (has_tolls);


--
-- Name: idx_trips_stage_trip_end; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trips_stage_trip_end ON public.trips USING btree (workflow_stage, trip_end);


--
-- Name: idx_trips_stage_trip_start; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trips_stage_trip_start ON public.trips USING btree (workflow_stage, trip_start);


--
-- Name: idx_trips_toll_review_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trips_toll_review_status ON public.trips USING btree (toll_review_status);


--
-- Name: idx_trips_turo_vehicle_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trips_turo_vehicle_id ON public.trips USING btree (turo_vehicle_id);


--
-- Name: idx_trips_workflow_stage; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trips_workflow_stage ON public.trips USING btree (workflow_stage);


--
-- Name: idx_vehicle_condition_notes_active_guest_visible; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vehicle_condition_notes_active_guest_visible ON public.vehicle_condition_notes USING btree (vehicle_vin, active, guest_visible);


--
-- Name: idx_vehicle_condition_notes_vehicle_vin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vehicle_condition_notes_vehicle_vin ON public.vehicle_condition_notes USING btree (vehicle_vin);


--
-- Name: idx_vehicle_odometer_history_vehicle_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vehicle_odometer_history_vehicle_time ON public.vehicle_odometer_history USING btree (vehicle_id, recorded_at DESC);


--
-- Name: idx_vehicle_telemetry_signal_values_signal_timestamp; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vehicle_telemetry_signal_values_signal_timestamp ON public.vehicle_telemetry_signal_values USING btree (signal_timestamp DESC) WHERE (signal_timestamp IS NOT NULL);


--
-- Name: idx_vehicle_telemetry_signal_values_snapshot; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vehicle_telemetry_signal_values_snapshot ON public.vehicle_telemetry_signal_values USING btree (snapshot_id);


--
-- Name: idx_vehicle_telemetry_signal_values_token_signal_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vehicle_telemetry_signal_values_token_signal_time ON public.vehicle_telemetry_signal_values USING btree (dimo_token_id, signal_name, captured_at DESC);


--
-- Name: idx_vehicle_telemetry_snapshots_dimo_token_captured; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vehicle_telemetry_snapshots_dimo_token_captured ON public.vehicle_telemetry_snapshots USING btree (dimo_token_id, captured_at DESC) WHERE ((service_name = 'dimo'::text) AND (dimo_token_id IS NOT NULL));


--
-- Name: idx_vehicle_telemetry_snapshots_external_key; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vehicle_telemetry_snapshots_external_key ON public.vehicle_telemetry_snapshots USING btree (external_vehicle_key) WHERE (external_vehicle_key IS NOT NULL);


--
-- Name: idx_vehicle_telemetry_snapshots_service_token_captured; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vehicle_telemetry_snapshots_service_token_captured ON public.vehicle_telemetry_snapshots USING btree (service_name, dimo_token_id, captured_at DESC);


--
-- Name: idx_vehicle_telemetry_snapshots_service_vin_captured; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vehicle_telemetry_snapshots_service_vin_captured ON public.vehicle_telemetry_snapshots USING btree (service_name, vin, captured_at DESC);


--
-- Name: idx_vehicle_telemetry_snapshots_vin_captured_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vehicle_telemetry_snapshots_vin_captured_at ON public.vehicle_telemetry_snapshots USING btree (vin, captured_at DESC);


--
-- Name: idx_vehicles_dimo_token_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vehicles_dimo_token_id ON public.vehicles USING btree (dimo_token_id) WHERE (dimo_token_id IS NOT NULL);


--
-- Name: idx_vehicles_external_vehicle_key; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vehicles_external_vehicle_key ON public.vehicles USING btree (external_vehicle_key) WHERE (external_vehicle_key IS NOT NULL);


--
-- Name: idx_vehicles_license_plate; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vehicles_license_plate ON public.vehicles USING btree (license_plate);


--
-- Name: ux_maintenance_tasks_source_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_maintenance_tasks_source_key ON public.maintenance_tasks USING btree (source_key) WHERE (source_key IS NOT NULL);


--
-- Name: vehicles_nickname_unique_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX vehicles_nickname_unique_idx ON public.vehicles USING btree (lower(nickname));


--
-- Name: vehicles_vin_unique_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX vehicles_vin_unique_idx ON public.vehicles USING btree (lower(vin));


--
-- Name: trip_intelligence _RETURN; Type: RULE; Schema: public; Owner: -
--

CREATE OR REPLACE VIEW public.trip_intelligence AS
 SELECT t.id,
    t.reservation_id,
    t.vehicle_name,
    t.guest_name,
    t.trip_start,
    t.trip_end,
    t.status,
    t.amount,
    t.needs_review,
    t.created_at,
    t.updated_at,
    count(m.id) AS message_count,
    count(*) FILTER (WHERE (m.status = 'unread'::text)) AS unread_messages,
    max(COALESCE(m.message_timestamp, (m.created_at)::timestamp with time zone)) AS last_message_at,
    max(
        CASE
            WHEN (m.status = 'unread'::text) THEN COALESCE(m.message_timestamp, (m.created_at)::timestamp with time zone)
            ELSE NULL::timestamp with time zone
        END) AS last_unread_at
   FROM (public.trips t
     LEFT JOIN public.messages m ON ((m.trip_id = t.id)))
  GROUP BY t.id;


--
-- Name: maintenance_events trg_maintenance_events_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_maintenance_events_updated_at BEFORE UPDATE ON public.maintenance_events FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: maintenance_rules trg_maintenance_rules_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_maintenance_rules_updated_at BEFORE UPDATE ON public.maintenance_rules FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: maintenance_tasks trg_maintenance_tasks_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_maintenance_tasks_updated_at BEFORE UPDATE ON public.maintenance_tasks FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: vehicle_condition_notes trg_vehicle_condition_notes_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_vehicle_condition_notes_updated_at BEFORE UPDATE ON public.vehicle_condition_notes FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: vehicles trg_vehicles_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_vehicles_updated_at BEFORE UPDATE ON public.vehicles FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: expenses expenses_vehicle_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_vehicle_id_fkey FOREIGN KEY (vehicle_id) REFERENCES public.vehicles(id) ON DELETE SET NULL;


--
-- Name: messages fk_messages_trip; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT fk_messages_trip FOREIGN KEY (trip_id) REFERENCES public.trips(id) ON DELETE SET NULL;


--
-- Name: teller_transactions fk_teller_transactions_matched_expense; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teller_transactions
    ADD CONSTRAINT fk_teller_transactions_matched_expense FOREIGN KEY (matched_expense_id) REFERENCES public.expenses(id) ON DELETE SET NULL;


--
-- Name: maintenance_events maintenance_events_rule_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maintenance_events
    ADD CONSTRAINT maintenance_events_rule_id_fkey FOREIGN KEY (rule_id) REFERENCES public.maintenance_rules(id) ON DELETE SET NULL;


--
-- Name: maintenance_events maintenance_events_vehicle_vin_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maintenance_events
    ADD CONSTRAINT maintenance_events_vehicle_vin_fkey FOREIGN KEY (vehicle_vin) REFERENCES public.vehicles(vin) ON DELETE CASCADE;


--
-- Name: maintenance_rules maintenance_rules_vehicle_vin_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maintenance_rules
    ADD CONSTRAINT maintenance_rules_vehicle_vin_fkey FOREIGN KEY (vehicle_vin) REFERENCES public.vehicles(vin) ON DELETE CASCADE;


--
-- Name: maintenance_tasks maintenance_tasks_rule_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maintenance_tasks
    ADD CONSTRAINT maintenance_tasks_rule_id_fkey FOREIGN KEY (rule_id) REFERENCES public.maintenance_rules(id) ON DELETE SET NULL;


--
-- Name: maintenance_tasks maintenance_tasks_vehicle_vin_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maintenance_tasks
    ADD CONSTRAINT maintenance_tasks_vehicle_vin_fkey FOREIGN KEY (vehicle_vin) REFERENCES public.vehicles(vin) ON DELETE CASCADE;


--
-- Name: messages messages_trip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_trip_id_fkey FOREIGN KEY (trip_id) REFERENCES public.trips(id);


--
-- Name: trip_stage_history trip_stage_history_trip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trip_stage_history
    ADD CONSTRAINT trip_stage_history_trip_id_fkey FOREIGN KEY (trip_id) REFERENCES public.trips(id) ON DELETE CASCADE;


--
-- Name: trip_google_sync trip_google_sync_google_calendar_connection_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trip_google_sync
    ADD CONSTRAINT trip_google_sync_google_calendar_connection_id_fkey FOREIGN KEY (google_calendar_connection_id) REFERENCES public.google_calendar_connections(id);


--
-- Name: trip_google_sync trip_google_sync_trip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trip_google_sync
    ADD CONSTRAINT trip_google_sync_trip_id_fkey FOREIGN KEY (trip_id) REFERENCES public.trips(id);


--
-- Name: vehicle_condition_notes vehicle_condition_notes_vehicle_vin_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicle_condition_notes
    ADD CONSTRAINT vehicle_condition_notes_vehicle_vin_fkey FOREIGN KEY (vehicle_vin) REFERENCES public.vehicles(vin) ON DELETE CASCADE;


--
-- Name: vehicle_odometer_history vehicle_odometer_history_vehicle_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicle_odometer_history
    ADD CONSTRAINT vehicle_odometer_history_vehicle_id_fkey FOREIGN KEY (vehicle_id) REFERENCES public.vehicles(id) ON DELETE CASCADE;


--
-- Name: vehicle_telemetry_signal_values vehicle_telemetry_signal_values_snapshot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicle_telemetry_signal_values
    ADD CONSTRAINT vehicle_telemetry_signal_values_snapshot_id_fkey FOREIGN KEY (snapshot_id) REFERENCES public.vehicle_telemetry_snapshots(id) ON DELETE CASCADE;


--
-- Denmark2.0 seed defaults
--

INSERT INTO public.app_settings (key, value)
VALUES (
  'ui.dispatch',
  '{
    "openTripsSort": "priority",
    "pinOverdue": true,
    "showCanceled": false,
    "visibleBuckets": {
      "needs_closeout": true,
      "in_progress": true,
      "unconfirmed": true,
      "upcoming": true,
      "canceled": false,
      "closed": false
    },
    "bucketOrder": [
      "needs_closeout",
      "in_progress",
      "unconfirmed",
      "upcoming",
      "canceled",
      "closed"
    ]
  }'::jsonb
)
ON CONFLICT (key) DO NOTHING;


--
-- PostgreSQL database dump complete
--

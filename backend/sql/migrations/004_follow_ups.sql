-- Migration 004 - "come back in fifteen days", and the reminders that follow.
--
-- Safe to run against the live database and safe to re-run: it creates one new
-- table and touches nothing that exists.
--
--   Supabase SQL editor, or:
--   psql "$SUPABASE_DB_URL" -f backend/sql/migrations/004_follow_ups.sql

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Follow-ups
-- ---------------------------------------------------------------------------
--
-- Its own table rather than more columns on tokens, because the lifetimes are
-- different. A token is one day's place in one queue and stops mattering at
-- midnight; a follow-up is a promise to a patient that has to survive weeks,
-- outlive the visit that created it, and still be findable when they walk back
-- in. Keeping it separate also means the queue's hot path never reads or writes
-- anything to do with follow-ups.
--
-- The patient's name and number are copied in rather than joined from the
-- token. A follow-up is a standing commitment to a person, and it should not
-- silently change or vanish because the visit row behind it was edited.

create table if not exists public.follow_ups (
  id               uuid primary key default gen_random_uuid(),
  clinic_id        uuid not null references public.clinics (id) on delete cascade,
  -- Kept for context, but nullable and set null on delete: losing the visit
  -- must not lose the promise made during it.
  token_id         uuid references public.tokens (id) on delete set null,
  patient_name     text not null,
  patient_phone    text not null,
  -- A date, not a timestamp: "come back on the 14th" has no time of day, and
  -- storing one would drag timezone questions into a clinical instruction.
  due_on           date not null,
  -- What the doctor actually said, in the doctor's words.
  note             text,
  status           text not null default 'scheduled'
                   check (status in ('scheduled', 'completed', 'cancelled')),
  -- Reserved for automatic reminders, which are not built. Nothing writes this
  -- today: the follow-up list is a staff record, and staff contact patients
  -- themselves from it.
  last_reminded_on date,
  created_at       timestamptz not null default now(),
  completed_at     timestamptz
);

-- The sweep asks one question, often: which follow-ups for this clinic are due
-- around now and still open.
create index if not exists follow_ups_clinic_due_idx
  on public.follow_ups (clinic_id, due_on)
  where status = 'scheduled';

-- Looking a patient up by phone when they call or walk in.
create index if not exists follow_ups_clinic_phone_idx
  on public.follow_ups (clinic_id, patient_phone);

alter table public.follow_ups enable row level security;

-- Grants, which are separate from RLS and easy to miss.
--
-- A table created here does not inherit the privileges Supabase set up for the
-- tables that came with the project, so the API's own role could see the table
-- exist and still be refused with "permission denied for table follow_ups".
-- RLS was never the thing standing in the way.
--
-- Only service_role is granted anything. anon and authenticated are explicitly
-- revoked: this table is patient names, phone numbers and clinical notes, and
-- the browser holds no key that should ever read it.
grant select, insert, update, delete on table public.follow_ups to service_role;
revoke all on table public.follow_ups from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Tell the API about the change
-- ---------------------------------------------------------------------------
--
-- PostgREST answers from a cached copy of the schema. Without this, a column
-- added above exists in the database and the API still reports "Could not find
-- the column ... in the schema cache" until something else happens to reload it.

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- Confirmation
-- ---------------------------------------------------------------------------

select
  (select count(*) from information_schema.tables
    where table_name = 'follow_ups')                        as follow_ups_table,
  (select count(*) from information_schema.role_table_grants
    where table_name = 'follow_ups' and grantee = 'service_role') as service_role_grants,
  (select count(*) from pg_indexes
    where indexname = 'follow_ups_clinic_due_idx')          as due_index,
  (select count(*) from information_schema.columns
    where table_name = 'tokens' and column_name = 'queue_position') as queue_position_column,
  (select count(*) from information_schema.columns
    where table_name = 'tokens' and column_name = 'completed_at')   as completed_at_column;

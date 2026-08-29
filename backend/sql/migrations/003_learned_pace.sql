-- Migration 003 - measure how long the clinic actually takes.
--
-- Safe to run against the live database and safe to re-run: it adds one
-- nullable column and one index, and reads nothing.
--
--   Supabase SQL editor, or:
--   psql "$SUPABASE_DB_URL" -f backend/sql/migrations/003_learned_pace.sql

-- ---------------------------------------------------------------------------
-- When a visit actually ended
-- ---------------------------------------------------------------------------
--
-- Until now the only timestamps were "token issued" and "called in", so the
-- length of a consultation could only ever be inferred from the gap until the
-- next patient was called. That gap is the right number for predicting a wait -
-- it includes the turnaround between patients - but it cannot answer the
-- question the clinic actually asks, which is how long a patient spends with
-- the doctor and how long they are in the building altogether.
--
-- Backfilling is deliberately not attempted: there is no honest value for a
-- visit that finished before this column existed, and inventing one would poison
-- the very averages it is here to measure.

alter table public.tokens add column if not exists completed_at timestamptz;

comment on column public.tokens.completed_at is
  'When the visit was marked done. Null for visits completed before this '
  'column existed, and for anyone not yet seen.';

-- The wait estimate is seeded from previous days before today has enough
-- consultations to measure, which means reading a week of tokens by clinic and
-- date on a cold start each morning.
create index if not exists tokens_clinic_history_idx
  on public.tokens (clinic_id, created_at desc)
  where called_in_at is not null;

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
  (select count(*) from information_schema.columns
    where table_name = 'tokens' and column_name = 'completed_at')     as completed_at_column,
  (select count(*) from information_schema.columns
    where table_name = 'tokens' and column_name = 'queue_position')   as queue_position_column,
  (select count(*) from pg_indexes
    where indexname = 'tokens_clinic_history_idx')                    as history_index,
  (select count(*) from pg_indexes
    where indexname = 'tokens_clinic_day_position_idx')               as position_index;

-- Migration 002 - patients who arrive late keep their place in the day.
--
-- Safe to run against the live database and safe to re-run: it adds one
-- nullable column and one index. No existing token is read, moved or rewritten,
-- and a queue with no deferrals behaves exactly as it does today.
--
--   Supabase SQL editor, or:
--   psql "$SUPABASE_DB_URL" -f backend/sql/migrations/002_late_patients.sql

-- ---------------------------------------------------------------------------
-- Where a patient actually sits in today's queue
-- ---------------------------------------------------------------------------
--
-- Until now the queue was ordered by token_number, which meant a patient who
-- missed their call had exactly two outcomes, both wrong: marked no-show and
-- dropped from the queue entirely, or restored and put straight back at the
-- front because their number was the lowest one left.
--
-- queue_position separates "which token were you issued" from "when will you be
-- seen". Null means the two are the same, which is true for every patient who
-- turns up on time - so this column stays null for almost every row, and the
-- ordering is unchanged for a clinic that never defers anyone.
--
-- It is numeric rather than integer so a patient can always be placed *between*
-- two others without renumbering the rest of the queue: the midpoint of two
-- positions is always available, however many times somebody is pushed back.

alter table public.tokens add column if not exists queue_position numeric;

comment on column public.tokens.queue_position is
  'Order within today''s queue. Null means order by token_number, which is the '
  'case for any patient who has not been deferred.';

-- The waiting list is read on every dashboard poll and every reminder pass, and
-- it now sorts on this rather than on token_number.
create index if not exists tokens_clinic_day_position_idx
  on public.tokens (clinic_id, created_at, queue_position, token_number);

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
  count(*)                                     as tokens_total,
  count(queue_position)                        as tokens_deferred,
  (select count(*) from information_schema.columns
    where table_name = 'tokens'
      and column_name = 'queue_position')      as column_present,
  (select count(*) from pg_indexes
    where indexname = 'tokens_clinic_day_position_idx') as index_present
from public.tokens;

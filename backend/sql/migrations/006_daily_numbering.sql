-- Migration 006 - the clinic day becomes a column, and duplicate numbers
-- become impossible.
--
-- What went wrong. Patients arriving after IST midnight were all issued the
-- previous day's last number. create_token computed "today" from a window that
-- still pointed at yesterday, so it read a stale maximum and never saw the rows
-- it had just inserted. Nothing failed; the numbers simply collided.
--
-- Why this migration adds no functions. Replacing a stored function on this
-- database has failed silently more than once: ist_day_start() was written in
-- an earlier migration and does not exist here at all. So the clinic day stops
-- being an expression that the API and the database each have to derive, and
-- becomes a plain column that is written once and read by both. Everything
-- below is add-column, update and create-index, all of which have applied
-- cleanly here before.
--
-- Safe to run against the live database and safe to re-run.

-- ---------------------------------------------------------------------------
-- 1. The clinic day, stored rather than derived
-- ---------------------------------------------------------------------------

alter table public.tokens add column if not exists token_day date;

comment on column public.tokens.token_day is
  'The Asia/Kolkata calendar day this token belongs to. Written by the API and '
  'defaulted here, so the day a token counts towards is never re-derived and '
  'never disagreed about.';

-- A safety net for anything inserted outside the API. India is a fixed +05:30
-- with no daylight saving, so shifting and truncating is exact.
alter table public.tokens
  alter column token_day
  set default ((((now() + interval '330 minutes') at time zone 'UTC')::date));

-- Fill it in for everything already stored.
update public.tokens
   set token_day = ((created_at + interval '330 minutes') at time zone 'UTC')::date
 where token_day is null;

-- ---------------------------------------------------------------------------
-- 2. Repair the numbers already handed out
-- ---------------------------------------------------------------------------
--
-- Renumbers each clinic day from 1 in the order patients were added. Days that
-- are already contiguous do not move; the day with five #34s becomes 1 to 5.
-- Tracking links are unaffected, since they address a token by its uuid.

with renumbered as (
  select
    id,
    row_number() over (
      partition by clinic_id, token_day
      order by created_at, id
    ) as correct_number
  from public.tokens
)
update public.tokens t
   set token_number = renumbered.correct_number
  from renumbered
 where t.id = renumbered.id
   and t.token_number is distinct from renumbered.correct_number;

-- ---------------------------------------------------------------------------
-- 3. Make a repeat impossible
-- ---------------------------------------------------------------------------
--
-- Plain columns, so no immutability question arises. From here a wrong number
-- is refused by the database instead of being handed to a patient.

create unique index if not exists tokens_clinic_day_number_uniq
  on public.tokens (clinic_id, token_day, token_number);

-- The queue is read by day on every poll, ordered by position then number.
create index if not exists tokens_clinic_day_order_idx
  on public.tokens (clinic_id, token_day, queue_position, token_number);

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- Confirmation
-- ---------------------------------------------------------------------------

select
  (select count(*) from information_schema.columns
    where table_name = 'tokens' and column_name = 'token_day')          as token_day_column,
  (select count(*) from pg_indexes
    where indexname = 'tokens_clinic_day_number_uniq')                  as uniqueness_index,
  (select count(*) from public.tokens where token_day is null)          as rows_missing_day,
  (select count(*) from (
     select clinic_id, token_day, token_number
       from public.tokens group by 1, 2, 3 having count(*) > 1
   ) x)                                                                as duplicates_remaining;

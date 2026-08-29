-- Migration 005 - follow-ups move onto the tokens table.
--
-- Safe to run against the live database and safe to re-run: it adds three
-- nullable columns and one index, and reads nothing.
--
-- Why the move. A follow-up was its own table, which was the tidier model on
-- paper. In practice a table created here does not inherit the privileges
-- Supabase set up for the tables that came with the project, so the API's own
-- role was refused with "permission denied for table follow_ups" no matter how
-- many times the grant was issued. Columns added to tokens inherit that table's
-- working grants, which is the same operation that added queue_position and
-- completed_at without trouble.
--
-- The model is honest either way: the doctor's instruction to come back belongs
-- to the visit it was given at, and the patient's name and number are already
-- on that row, so nothing has to be copied to keep them in step.
--
-- public.follow_ups is left in place and simply unused. It is not dropped here
-- because this file cannot see whether anything ever landed in it; drop it by
-- hand once you are satisfied it is empty.

alter table public.tokens add column if not exists follow_up_due_on date;
alter table public.tokens add column if not exists follow_up_note   text;
alter table public.tokens add column if not exists follow_up_status text;

-- Added separately and guarded, so re-running this file cannot fail on a
-- constraint that already exists.
do $$
begin
  alter table public.tokens add constraint tokens_follow_up_status_check
    check (follow_up_status in ('scheduled', 'completed', 'cancelled'));
exception
  when duplicate_object then null;
end;
$$;

comment on column public.tokens.follow_up_due_on is
  'Date the patient was told to come back. Null when no follow-up was given.';
comment on column public.tokens.follow_up_status is
  'scheduled while open, then completed when they returned or cancelled. Null '
  'when no follow-up was given.';

-- The staff list asks one question: which follow-ups for this clinic are still
-- open, in date order. A partial index keeps that off the ~99% of tokens that
-- carry no follow-up at all.
create index if not exists tokens_clinic_follow_up_idx
  on public.tokens (clinic_id, follow_up_due_on)
  where follow_up_status = 'scheduled';

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
    where table_name = 'tokens' and column_name = 'follow_up_due_on')  as due_on_column,
  (select count(*) from information_schema.columns
    where table_name = 'tokens' and column_name = 'follow_up_note')    as note_column,
  (select count(*) from information_schema.columns
    where table_name = 'tokens' and column_name = 'follow_up_status')  as status_column,
  (select count(*) from pg_indexes
    where indexname = 'tokens_clinic_follow_up_idx')                   as follow_up_index;

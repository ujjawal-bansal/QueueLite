-- Migration 001 - Dev Eye Care, and the columns a 100-patient day needs.
--
-- Safe to run against the existing live database and safe to re-run: no patient
-- token is ever dropped or rewritten. Two queue functions are replaced, which
-- the running API does not call until this deploy ships.
--
--   psql "$SUPABASE_DB_URL" -f backend/sql/migrations/001_dev_eye_care.sql

-- ---------------------------------------------------------------------------
-- 1. Clinic details the patient page and the WhatsApp bot now show
-- ---------------------------------------------------------------------------

alter table public.clinics add column if not exists address              text;
alter table public.clinics add column if not exists phone                text;
alter table public.clinics add column if not exists maps_url             text;
alter table public.clinics add column if not exists opens_at             time;
alter table public.clinics add column if not exists closes_at            time;

-- Minutes the clinic budgets per patient. Every wait estimate is built from
-- this figure.
alter table public.clinics add column if not exists avg_consult_minutes  integer not null default 15;

-- ---------------------------------------------------------------------------
-- 2. Reminder bookkeeping
-- ---------------------------------------------------------------------------
--
-- A reminder is sent at most once per token per kind. Recording the send on the
-- row is what makes that true across restarts, across the two API instances a
-- redeploy briefly runs at once, and across a staff member undoing a mis-tap
-- and calling the same patient in again.

alter table public.tokens add column if not exists heads_up_sent_at  timestamptz;
alter table public.tokens add column if not exists turn_notified_at  timestamptz;

-- ---------------------------------------------------------------------------
-- 3. Indexes for a 100+ token day
-- ---------------------------------------------------------------------------
--
-- Every read is "this clinic, today, ordered by token number". Without the
-- token_number in the index Postgres sorts 100 rows on each of the ~700 reads
-- a full waiting room generates per minute.

create index if not exists tokens_clinic_day_number_idx
  on public.tokens (clinic_id, created_at, token_number);

-- Matching an inbound WhatsApp number against today's active tokens.
create index if not exists tokens_clinic_phone_idx
  on public.tokens (clinic_id, patient_phone);

-- ---------------------------------------------------------------------------
-- 4. Atomic call-in
-- ---------------------------------------------------------------------------
--
-- The API used to close out the previous patient and call in the next one as
-- two separate statements. A failure between them left the clinic with nobody
-- marked as being seen, which the dashboard then showed as "queue not started"
-- mid-morning. Defined here so the API can rely on it being present and on
-- these exact semantics.
--
-- Dropped first rather than replaced: this database already has a call_in_token
-- whose return type differs, and `create or replace` cannot change one.
--
-- Dropped by name, not by signature. Naming the argument types assumes the live
-- function looks the way we expect, and that assumption is what failed here
-- already. Not CASCADE either: if something unexpected does depend on one of
-- these, Postgres refuses and names it rather than quietly removing it too.
do $$
declare
  existing record;
begin
  for existing in
    select oid::regprocedure as signature
      from pg_proc
     where pronamespace = 'public'::regnamespace
       and proname in ('call_in_token', 'claim_reminder')
  loop
    raise notice 'dropping existing function %', existing.signature;
    execute format('drop function %s', existing.signature);
  end loop;
end;
$$;

create function public.call_in_token(
  p_clinic_id uuid,
  p_token_id  uuid
)
returns public.tokens
language plpgsql
as $$
declare
  -- The Kolkata day boundary is written out rather than calling
  -- public.ist_day_start(). That helper's live definition was only ever
  -- inferred, so depending on it here would risk this function creating
  -- cleanly and then failing at the moment a patient is called in.
  v_day_start timestamptz := date_trunc('day', now() at time zone 'Asia/Kolkata')
                               at time zone 'Asia/Kolkata';
  v_token     public.tokens;
begin
  update public.tokens
     set status = 'done'
   where clinic_id = p_clinic_id
     and status = 'in_progress'
     and id <> p_token_id
     and created_at >= v_day_start
     and created_at < v_day_start + interval '1 day';

  update public.tokens
     set status = 'in_progress',
         called_in_at = now()
   where id = p_token_id
     and clinic_id = p_clinic_id
  returning * into v_token;

  return v_token;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Atomic reminder claim
-- ---------------------------------------------------------------------------
--
-- Two API instances (or a retried request) can decide to send the same reminder
-- at the same moment. The conditional update makes the claim atomic: whoever
-- flips the null wins, everyone else gets zero rows and sends nothing. Without
-- it a patient can be messaged twice about the same turn.

create function public.claim_reminder(
  p_token_id uuid,
  p_kind     text
)
returns boolean
language plpgsql
as $$
declare
  v_claimed integer;
begin
  if p_kind = 'heads_up' then
    update public.tokens
       set heads_up_sent_at = now()
     where id = p_token_id
       and heads_up_sent_at is null;
  elsif p_kind = 'your_turn' then
    update public.tokens
       set turn_notified_at = now()
     where id = p_token_id
       and turn_notified_at is null;
  else
    raise exception 'unknown reminder kind: %', p_kind;
  end if;

  get diagnostics v_claimed = row_count;

  return v_claimed > 0;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. The clinic this deployment serves
-- ---------------------------------------------------------------------------

insert into public.clinics (name, slug, doctor_name, address, phone, maps_url, opens_at, closes_at, avg_consult_minutes)
values (
  'Dev Eye Care',
  'dev-eye-care',
  'Dr. Sachin Dev',
  'Near Willsonia School 19, Shanker Vihar Colony, Civil Lines, Moradabad, Uttar Pradesh 244001',
  '+919368444330',
  'https://maps.google.com/?q=Dev+Eye+Care+Civil+Lines+Moradabad',
  '10:00',
  '18:00',
  15
)
on conflict (slug) do update
set name                = excluded.name,
    doctor_name         = excluded.doctor_name,
    address             = excluded.address,
    phone               = excluded.phone,
    maps_url            = excluded.maps_url,
    opens_at            = excluded.opens_at,
    closes_at           = excluded.closes_at,
    avg_consult_minutes = excluded.avg_consult_minutes;

-- ---------------------------------------------------------------------------
-- 7. Confirmation
-- ---------------------------------------------------------------------------
--
-- Shows the seeded clinic and proves the new columns and functions are all in
-- place, so a successful run reports something rather than "0 rows".

select
  c.name,
  c.slug,
  c.doctor_name,
  c.phone,
  c.opens_at,
  c.closes_at,
  c.avg_consult_minutes,
  (select count(*) from information_schema.columns
    where table_name = 'tokens'
      and column_name in ('heads_up_sent_at', 'turn_notified_at')) as reminder_columns,
  (select count(*) from pg_proc
    where proname in ('call_in_token', 'claim_reminder')) as queue_functions
from public.clinics c
where c.slug = 'dev-eye-care';

notify pgrst, 'reload schema';

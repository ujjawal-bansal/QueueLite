-- QueueLite database schema (Supabase / Postgres)
--
-- This is the full shape of a fresh database. An existing deployment should run
-- the files in sql/migrations/ instead -- they are idempotent and will not
-- rewrite live tokens.
--
-- The table and RPC signatures were recovered from the live project's PostgREST
-- schema. The FUNCTION BODIES ARE A RECONSTRUCTION -- the live definitions could
-- not be read over the REST API. They match the behaviour the API depends on,
-- but review them before running this against a database that already has
-- working functions, since `create or replace` will overwrite them.
--
-- A "day" is an Asia/Kolkata calendar day: token numbers restart each IST
-- midnight, which is also how the Node API scopes "today".

create extension if not exists "pgcrypto";

create table if not exists public.clinics (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  slug                text not null unique,
  doctor_name         text,
  address             text,
  phone               text,
  maps_url            text,
  opens_at            time,
  closes_at           time,
  -- Minutes the clinic budgets per patient. Every wait estimate is built from
  -- this figure.
  avg_consult_minutes integer not null default 15,
  created_at          timestamptz not null default now()
);

create table if not exists public.tokens (
  id               uuid primary key default gen_random_uuid(),
  clinic_id        uuid not null references public.clinics (id) on delete cascade,
  token_number     integer not null,
  patient_name     text not null,
  patient_phone    text not null,
  status           text not null default 'waiting'
                   check (status in ('waiting', 'in_progress', 'done', 'no_show')),
  created_at       timestamptz not null default now(),
  called_in_at     timestamptz,
  -- When the visit ended. The only honest record of a consultation's length;
  -- inferring it from when the next patient was called measures something else.
  completed_at     timestamptz,
  -- Order within today's queue. Null means order by token_number, which is the
  -- case for every patient who turns up when they are called. Numeric so a
  -- patient can always be placed between two others without renumbering.
  queue_position   numeric,
  -- The doctor's instruction to come back, kept on the visit it was given at.
  -- The patient's name and number are already on this row, so there is nothing
  -- to copy and nothing that can drift out of step.
  follow_up_due_on date,
  follow_up_note   text,
  follow_up_status text
                   check (follow_up_status in ('scheduled', 'completed', 'cancelled')),
  -- Reminder bookkeeping. A reminder is sent at most once per token per kind;
  -- recording the send on the row is what makes that hold across restarts,
  -- across the two instances a redeploy briefly runs at once, and across staff
  -- undoing a mis-tap and calling the same patient in again.
  heads_up_sent_at timestamptz,
  turn_notified_at timestamptz
);

-- Every read is "this clinic, today, ordered by token number". Without the
-- token_number in the index Postgres sorts the whole day's rows on each of the
-- ~700 reads a full waiting room generates per minute.
create index if not exists tokens_clinic_day_number_idx
  on public.tokens (clinic_id, created_at, token_number);

create index if not exists tokens_clinic_status_idx
  on public.tokens (clinic_id, status);

-- Matching an inbound WhatsApp number against today's active tokens.
create index if not exists tokens_clinic_phone_idx
  on public.tokens (clinic_id, patient_phone);

-- The waiting list sorts on queue position, not token number.
create index if not exists tokens_clinic_day_position_idx
  on public.tokens (clinic_id, created_at, queue_position, token_number);

-- Seeding the wait estimate from previous days on a cold start each morning.
create index if not exists tokens_clinic_history_idx
  on public.tokens (clinic_id, created_at desc)
  where called_in_at is not null;

-- Start of the current Asia/Kolkata day, as a UTC timestamp.
create or replace function public.ist_day_start()
returns timestamptz
language sql
stable
as $$
  select date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata';
$$;

-- Allocates the next token number for the clinic's current IST day and inserts
-- the token. The advisory lock serialises concurrent front-desk entries so two
-- patients cannot receive the same number.
create or replace function public.create_token(
  p_clinic_id     uuid,
  p_patient_name  text,
  p_patient_phone text
)
returns public.tokens
language plpgsql
as $$
declare
  v_day_start timestamptz := public.ist_day_start();
  v_next      integer;
  v_token     public.tokens;
begin
  perform pg_advisory_xact_lock(
    hashtextextended(p_clinic_id::text || v_day_start::text, 0)
  );

  select coalesce(max(token_number), 0) + 1
    into v_next
    from public.tokens
   where clinic_id = p_clinic_id
     and created_at >= v_day_start
     and created_at < v_day_start + interval '1 day';

  insert into public.tokens (clinic_id, token_number, patient_name, patient_phone, status)
  values (p_clinic_id, v_next, p_patient_name, p_patient_phone, 'waiting')
  returning * into v_token;

  return v_token;
end;
$$;

-- Kept for compatibility: the live project also exposes create_daily_token with
-- the same signature and purpose.
create or replace function public.create_daily_token(
  p_clinic_id     uuid,
  p_patient_name  text,
  p_patient_phone text
)
returns public.tokens
language sql
as $$
  select * from public.create_token(p_clinic_id, p_patient_name, p_patient_phone);
$$;

-- Closes out whoever is currently being seen and calls in the given token, in
-- one transaction. The Node API currently does this in two statements instead;
-- either path is fine, but this one is atomic.
create or replace function public.call_in_token(
  p_clinic_id uuid,
  p_token_id  uuid
)
returns public.tokens
language plpgsql
as $$
declare
  v_day_start timestamptz := public.ist_day_start();
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

-- Claims a reminder for a token, returning true only for the caller that won.
--
-- Two API instances (or a retried request) can decide to send the same reminder
-- at the same moment. The conditional update makes the claim atomic: whoever
-- flips the null wins, everyone else gets zero rows and sends nothing. Without
-- it a patient can be messaged twice about the same turn.
create or replace function public.claim_reminder(
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

-- The staff follow-up list asks one question: which follow-ups for this clinic
-- are still open, in date order. A partial index keeps that off the ~99% of
-- tokens that carry no follow-up at all.
create index if not exists tokens_clinic_follow_up_idx
  on public.tokens (clinic_id, follow_up_due_on)
  where follow_up_status = 'scheduled';

-- Row level security
--
-- The Node API uses the service role key and bypasses RLS. The browser uses the
-- anon key and only ever needs to read clinic names, so anon gets read-only
-- access to clinics and nothing on tokens (patient names and phone numbers must
-- not be publicly readable).

alter table public.clinics enable row level security;
alter table public.tokens  enable row level security;

drop policy if exists "clinics are publicly readable" on public.clinics;
create policy "clinics are publicly readable"
  on public.clinics for select
  to anon, authenticated
  using (true);

-- The clinic this deployment serves.
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
on conflict (slug) do nothing;

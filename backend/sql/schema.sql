-- QueueLite database schema (Supabase / Postgres)
--
-- Tables and RPC signatures below were recovered from the live project's
-- PostgREST schema. The FUNCTION BODIES ARE A RECONSTRUCTION -- the live
-- definitions could not be read over the REST API. They match the behaviour the
-- API depends on, but review them before running this against a database that
-- already has working functions, since `create or replace` will overwrite them.
--
-- A "day" is an Asia/Kolkata calendar day: token numbers restart each IST
-- midnight, which is also how the Node API scopes "today".

create extension if not exists "pgcrypto";

create table if not exists public.clinics (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        text not null unique,
  doctor_name text,
  created_at  timestamptz not null default now()
);

create table if not exists public.tokens (
  id             uuid primary key default gen_random_uuid(),
  clinic_id      uuid not null references public.clinics (id) on delete cascade,
  token_number   integer not null,
  patient_name   text not null,
  patient_phone  text not null,
  status         text not null default 'waiting'
                 check (status in ('waiting', 'in_progress', 'done', 'no_show')),
  created_at     timestamptz not null default now(),
  called_in_at   timestamptz
);

create index if not exists tokens_clinic_created_idx
  on public.tokens (clinic_id, created_at);

create index if not exists tokens_clinic_status_idx
  on public.tokens (clinic_id, status);

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

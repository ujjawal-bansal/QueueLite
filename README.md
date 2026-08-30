# QueueLite

Walk-in token queue for **Dev Eye Care**, Civil Lines, Moradabad
(Dr. Sachin Dev). The front desk issues numbered tokens; patients follow their
turn from a link, a public board, or by messaging the clinic on WhatsApp,
instead of sitting in the waiting room.

Built for a hundred-patient day, which is a different problem from a
ten-patient morning and is the reason behind most of what follows.

```
frontend/   React 19 + Vite            ->  Vercel
backend/    Express 5 + Node 20        ->  Render
            Supabase (Postgres)            data
            WhatsApp Cloud API             notifications
```

---

## Contents

- [Pages](#pages)
- [Running it locally](#running-it-locally)
- [Architecture](#architecture)
- [Data model](#data-model)
- [API](#api)
- [Configuration](#configuration)
- [WhatsApp](#whatsapp)
- [Deploying](#deploying)
- [Operations](#operations)
- [Testing](#testing)
- [Security](#security)
- [Known limitations](#known-limitations)

---

## Pages

| Page | Path | Who can reach it |
|---|---|---|
| Staff desk | `/staff/dev-eye-care` | clinic passcode |
| End-of-day report | `/staff/dev-eye-care/today` | clinic passcode |
| Follow-ups | `/staff/dev-eye-care/follow-ups` | clinic passcode |
| Patient tracker | `/q/dev-eye-care/:tokenId` | anyone holding the link |
| Waiting-room board | `/board/dev-eye-care` | public |
| Home | `/` | public |

The queue day is an **Asia/Kolkata calendar day**: numbering restarts at IST
midnight wherever the server runs. One deployment serves one clinic;
`CLINIC_SLUG` names it and any other slug is refused, so a guessed URL cannot
reach another clinic's queue.

---

## Running it locally

```bash
# 1. Database, once against your Supabase project
#    Fresh project:
psql "$SUPABASE_DB_URL" -f backend/sql/schema.sql
#    Existing project, in order:
for f in backend/sql/migrations/*.sql; do psql "$SUPABASE_DB_URL" -f "$f"; done

# 2. Backend
cd backend
cp .env.example .env
npm install
npm run generate-secrets     # SESSION_SECRET + WHATSAPP_VERIFY_TOKEN
npm run hash-passcode        # STAFF_PASSCODE_HASH
npm run generate-recovery    # optional break-glass code
npm run dev                  # http://localhost:3001

# 3. Frontend
cd ../frontend
cp .env.example .env
npm install
npm run dev                  # http://localhost:5173
```

No `psql`? Paste each migration into the Supabase SQL editor instead. Every one
ends with a `select` that reports what it created.

Two things that have caught us before:

- **A `.env` change needs a manual restart.** `node --watch` only watches files
  it `require`s, and `.env` is read by dotenv rather than required.
- **A schema change needs `notify pgrst, 'reload schema'`.** PostgREST answers
  from a cached copy of the schema, so a new column can exist in the database
  while the API insists it does not. Every migration ends with it.

`NOTIFIER=console` (the default) logs messages instead of sending them, so the
whole app works before WhatsApp is configured.

---

## Architecture

```
                    ┌──────────────────────────────────────┐
   patient's phone  │  Vercel                              │
   staff laptop ────┤    React SPA                         │
   waiting-room TV  │    /api/*  ──rewrite──┐              │
                    └───────────────────────┼──────────────┘
                                            │  same origin, so no CORS
                                            │  and a first-party cookie
                    ┌───────────────────────▼──────────────┐
                    │  Render                              │
                    │    Express API                       │
                    │      queue snapshot (2.5s, in-proc)  │
                    │      reminder engine                 │
                    └───┬──────────────────────────────┬───┘
                        │ service role key             │ Graph API
                    ┌───▼──────────────┐        ┌──────▼───────┐
                    │  Supabase        │        │  WhatsApp    │
                    │  Postgres        │        │  Cloud API   │
                    └──────────────────┘        └──────────────┘
```

**The browser holds no database key.** Everything goes through the API, which
uses the service role key server-side. Vercel rewrites `/api/*` to Render, so
the browser makes same-origin requests: no CORS preflight to get wrong, and the
staff session cookie is first-party.

### Load, and why the snapshot exists

A hundred open tracking pages polling every nine seconds is roughly 700
requests a minute, and they all arrive from Vercel's edge as one caller. Two
things keep that flat:

- **Tracking pages poll on a schedule set by how close the patient is:** ten
  seconds at the front of the queue, two minutes forty back, nothing at all in
  a backgrounded tab or after the visit ends.
- **Every concurrent reader shares one snapshot** of the day's tokens, held in
  process for 2.5 seconds and dropped the moment staff change anything. A whole
  waiting room refreshing at once costs a single database read.

### Token numbering

Numbers are allocated **by the API**, not by a database function.

They used to come from a stored `create_token` that derived the clinic day
itself. It got the boundary wrong, so patients arriving after IST midnight were
all issued the previous day's last number, and replacing the function on the
live database proved unreliable. Now:

1. `token_day` is a **column**, written when the token is issued, so the clinic
   day is stored once rather than derived by two systems that can disagree.
2. The API reads the highest number for that day and inserts the next.
3. A **unique index on `(clinic_id, token_day, token_number)`** is the actual
   guarantee. A duplicate is refused by the database rather than handed to a
   patient; the API retries on the collision a genuine race produces.

The API also works against a database that has not had the migration applied
yet, falling back to the same window over `created_at`. Code deploys on a push
and migrations are run by hand, so there is always a gap.

### Reminders

Position decides who hears from the clinic, not which button staff pressed:

| Rung | When | Message |
|---|---|---|
| `heads_up` | `REMINDER_LEAD_PATIENTS` (3) ahead | "start heading over" |
| `your_turn` | nobody left ahead | "you're next" |

The turn notification alone is no use to someone waiting at home: it arrives
when they already need to be in the room.

Every reminder is **claimed in Postgres before it is sent**, so a retried
request, an undone mis-tap, or the two instances a redeploy briefly runs cannot
message the same patient twice. A send that genuinely fails hands the claim
back and is retried on the next queue movement, because losing a patient's only
notification is worse than a duplicate.

Reminders run off the request path. Waiting on four WhatsApp calls would put
that delay on every Call In tap.

### Wait estimates

Every estimate is `clinics.avg_consult_minutes` (15) multiplied by the number
of patients ahead, shown as a **clock time** rather than a minute count,
because "around 3:40 pm" answers "can I go and eat first" and "240 minutes"
does not.

`USE_MEASURED_PACE=true` replaces that with the median gap between real
call-ins, falling back to the last seven days before today has enough to
measure. Off by default: a run of quick reviews at 9am produces a
confident-looking figure that says nothing about the afternoon, and the desk
repeats it to patients as though it were a promise.

An estimate landing more than half an hour past closing is never quoted. The
patient is told to check with the desk, and the desk sees it at the counter
while the patient is still standing there.

### Late patients

A patient who misses their call and returns had two possible outcomes, both
wrong: dropped from the queue, or restored to the *front*, because their token
number was the lowest one still waiting.

`queue_position` separates *which token you were issued* from *when you will be
seen*. It is `numeric`, so a patient can always be placed **between** two
others without renumbering anyone, and it stays null for everybody who turns up
when called. The flow is:

1. Called, nobody comes. **No Answer** marks a no-show; the desk moves on.
2. They turn up late. **Back to Queue** asks *after how many patients* and
   slots them in a few places down.

---

## Data model

Two tables. A follow-up is not a third: it belongs to the visit it was given
at, and the patient's name and number are already on that row, so nothing is
copied and nothing can drift out of step.

**`clinics`**, one row per deployment. Name, doctor, address, phone, map link,
opening hours and `avg_consult_minutes` all live here, so changing any of them
takes effect without a deploy.

**`tokens`**, one row per patient per day.

| Column | Purpose |
|---|---|
| `token_number` | what the patient is told, restarts daily |
| `token_day` | the Kolkata day it counts towards, stored not derived |
| `status` | `waiting`, `in_progress`, `done`, `no_show` |
| `queue_position` | set only when a patient is pushed back |
| `called_in_at`, `completed_at` | when they were called and when the visit ended |
| `heads_up_sent_at`, `turn_notified_at` | reminder claims, one send each |
| `follow_up_due_on`, `follow_up_note`, `follow_up_status` | the doctor's instruction to come back |

Indexes worth knowing: a **unique** one on `(clinic_id, token_day,
token_number)`, a read index on `(clinic_id, token_day, queue_position,
token_number)` for the queue, and a partial index on open follow-ups so the
~99% of tokens without one cost nothing to skip.

---

## API

All responses are `{ success, data }` or `{ success, error }`.

| Method | Path | Auth |
|---|---|---|
| `GET` | `/api/health` | public |
| `GET` | `/api/clinic` | public |
| `GET` | `/api/clinics/:slug/board` | public |
| `GET` | `/api/clinics/:slug/tokens/:tokenId` | public (tracking link) |
| `POST` | `/api/auth/login` \| `/recover` \| `/logout` | public |
| `GET` | `/api/auth/session` | staff |
| `GET` | `/api/clinics/:slug/queue/today` | **staff** |
| `POST` | `/api/clinics/:slug/tokens` | **staff** |
| `POST` | `/api/clinics/:slug/call-next` | **staff** |
| `PATCH` | `/api/clinics/:slug/tokens/:id/call-in` \| `/done` \| `/no-show` \| `/restore` \| `/push-back` | **staff** |
| `GET` | `/api/clinics/:slug/follow-ups` | **staff** |
| `POST` | `/api/clinics/:slug/tokens/:id/follow-up` | **staff** |
| `PATCH` | `/api/clinics/:slug/follow-ups/:id/done` \| `/cancel` | **staff** |
| `GET`/`POST` | `/api/whatsapp/webhook` | Meta (signature-verified) |

Calling a patient in closes out whoever was `in_progress` in the same
transaction, so at most one patient is ever being seen and a failure cannot
leave the clinic with nobody marked as seen.

### Auth

One shared clinic passcode, exchanged for a signed JWT in an **httpOnly**
cookie (`ql_session`, 12h). The passcode is stored only as a scrypt hash.

If the desk forgets it, `STAFF_RECOVERY_CODE_HASH` enables a break-glass
sign-in: rate limited to ten attempts an hour, constant-time compared, and
absent entirely (404, not 403) when no code is configured. A session opened
that way shows an amber banner on every page until the passcode is reset, so a
clinic does not quietly run on it for months.

The patient tracking route is deliberately public: the unguessable token UUID
is the capability, and that endpoint never returns a phone number.

---

## Configuration

`backend/.env`, and the same names on Render. See `.env.example` for the full
list.

| Setting | Default | What it does |
|---|---|---|
| `CLINIC_SLUG` | `dev-eye-care` | the one clinic this deployment serves |
| `FRONTEND_URL` | none | CORS allow-list *and* the base of every tracking link |
| `AVG_CONSULT_MINUTES` | `15` | minutes per patient; every estimate is built from this |
| `USE_MEASURED_PACE` | `false` | override that with today's measured pace |
| `REMINDER_LEAD_PATIENTS` | `3` | how far ahead the "heading over" message goes; `0` disables |
| `SESSION_TTL_HOURS` | `12` | how long a staff sign-in lasts |
| `NOTIFIER` | `console` | `console` logs messages, `whatsapp` sends them |
| `STAFF_RECOVERY_CODE_HASH` | unset | unset means no break-glass sign-in exists |

The server refuses to start on a malformed value and names it, rather than
failing later at the moment somebody needs it.

---

## WhatsApp

Uses the **official Meta Cloud API**. Unofficial libraries that automate
WhatsApp Web (`whatsapp-web.js`, Baileys) violate WhatsApp's terms and get
numbers banned; do not put one behind a clinic.

### What works with no approval at all

Every issued token shows a **QR code** at the desk, and **Send on WhatsApp**
opens the desk's own WhatsApp with the patient's number and the message already
typed. That is an ordinary personal message: no template, no five-recipient
limit, no cost, and it reaches the patients who booked by phone and are not at
the counter to scan anything. The same button sends follow-up reminders.

### Automatic sending

Business-initiated messages need a template approved under **WhatsApp Manager,
Message Templates**, category *Utility*. Two constraints learned from
rejections: a raw URL cannot be a body variable, and the word "token" is read
as an authentication code. The business name cannot be a variable either.

```
queue_token_issued
  Dev Eye Care: your number today is {{1}}. Please keep this message.

queue_your_turn
  Dev Eye Care: now seeing number {{1}}. You are next, number {{2}}. Please come in.

queue_heads_up
  Dev Eye Care: number {{1}}, you are {{2}} patients away. Please start heading to the clinic.
```

Variable order is what the code sends; changing it means changing
`src/services/notifier/index.js`.

**Leave `WHATSAPP_TEMPLATE_HEADS_UP` empty until its template is approved.**
The heads-up then stays off rather than failing on every send, and nobody is
marked as reminded for a message that was never sent.

Reaching real patients automatically also needs a verified business number.
Test mode reaches five registered numbers only.

> **India / DLT:** WhatsApp Cloud API does **not** require TRAI DLT
> registration (that applies to SMS). A Meta-approved display name is needed.

---

## Deploying

### Backend to Render

`render.yaml` is checked in; create a **Blueprint** from the repo and set the
secrets marked `sync: false`. `CLINIC_SLUG` is already `dev-eye-care` and
`SESSION_SECRET` is generated by Render.

Health check is `/api/health`. The free tier sleeps after inactivity, so the
checked-in GitHub Action pings it every ten minutes to keep the first request
of the morning fast.

### Frontend to Vercel

Import the repo with root directory `frontend`. `vercel.json` supplies the SPA
rewrite (without it, refreshing `/q/...` 404s), proxies `/api` to Render, and
sets security headers.

Render and Vercel each need the other's URL: deploy the backend with a
placeholder `FRONTEND_URL`, deploy the frontend, then correct it. It is the
CORS allow-list *and* the base of every tracking link, so a wrong value breaks
both sign-in and patient links.

### Order of operations

Run migrations **before** merging, or rely on the fallbacks. The API tolerates a
missing `token_day`, but not every future change will be so forgiving.

---

## Operations

**Clinic details** live in the `clinics` row, not in code. Editing it updates
the patient page, the board, the messages staff send and the bot's replies.

**Rotating the staff passcode:** `npm run hash-passcode`, update
`STAFF_PASSCODE_HASH` on Render, redeploy. Rotating `SESSION_SECRET` too signs
everyone out immediately.

**Daily rhythm:** nothing to reset. Numbering restarts at IST midnight and
yesterday's queue simply stops being today's.

**Logs:** structured JSON via pino in Render's log tab. Patient names and phone
numbers are redacted at the logger, so they never reach log storage. Each
reminder pass logs how many were due and how many went out; every
recovery-code attempt is logged at `warn`.

**If WhatsApp breaks:** the queue keeps working. Sends are best-effort and
failures are logged, never surfaced to the front desk. Unsent reminders retry
on the next queue movement, and staff fall back to the QR code and the
tap-to-send buttons.

---

## Testing

```bash
cd backend  && npm test     # 127 tests, no database needed
cd frontend && npm test     # 31 tests
cd frontend && npm run lint && npm run build
```

The backend suite drives the real Express app against an in-memory Supabase.
`backend/tests/helpers/fakeSupabase.js` mirrors the SQL in `sql/schema.sql`,
including the unique index, so a change made to one and not the other fails a
test rather than surprising you in production.

What the tests are actually protecting, most of it written after something went
wrong:

- a simulated clinic day: 100 patients issued, called, pushed back, no-showed,
  restored and tracked
- numbering restarts at 1 on a new day, and two entries landing together take
  different numbers
- the API and the SQL agree on the clinic day either side of IST midnight
- the same behaviour again against a database without the `token_day` column
- a hundred simultaneous trackers cost one database read
- a WhatsApp outage does not cost a patient their notification
- the board never returns a name or a phone number
- dates that would otherwise crash `Intl` render as empty strings

---

## Security

- **Rate limits:** 30 sign-ins / 15 min, 10 recovery attempts / hour, 240
  writes / min, 3000 public reads / min. Every request arrives from Vercel's
  edge as one caller, so these are global budgets sized for a full waiting
  room.
- Only `FRONTEND_URL` (plus `ALLOWED_ORIGINS`) may call the API.
- `helmet` sets HSTS, `nosniff` and frame protection.
- The board and the tracker return positions, counts and times only, never a
  name or a phone number, because token numbers are guessable.
- The CSV export escapes cells beginning `=`, `+`, `-` or `@`, which Excel and
  Sheets would otherwise execute as formulas.
- `noindex` and a `robots.txt`: the tracker shows a patient's name to whoever
  holds the link, so none of this should be crawled.
- The service role key belongs **only** in Render's environment. Never in the
  repo, never in the frontend.

---

## Known limitations

- **No automatic follow-up reminders.** The follow-up list is a staff record
  and the contact is made by hand, because the clinic has no approved template
  and no verified business number. Promising a message that never arrives is
  worse than promising nothing.
- **Automatic WhatsApp reaches five numbers** until Meta verifies the business.
  The tap-to-send buttons reach anyone, today.
- **Today only.** The report and the queue are scoped to the current IST day;
  there is no history view yet.
- **One clinic per deployment**, by design.
- **`public.follow_ups` is unused.** Migration 004 created it, 005 superseded
  it. Drop it once you are satisfied it is empty.

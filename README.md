# QueueLite for Dev Eye Care

Walk-in token queue for **Dev Eye Care**, Civil Lines, Moradabad (Dr. Sachin Dev).
The front desk issues numbered tokens; patients track their turn from a link, a
public board, or by messaging the clinic on WhatsApp, instead of sitting in the
waiting room.

| Page | Path | Who |
|---|---|---|
| Staff desk | `/staff/dev-eye-care` | passcode |
| End-of-day report | `/staff/dev-eye-care/today` | passcode |
| Follow-ups | `/staff/dev-eye-care/follow-ups` | passcode |
| Patient tracker | `/q/dev-eye-care/:tokenId` | anyone with the link |
| Waiting-room board | `/board/dev-eye-care` | public |

The queue day is an **Asia/Kolkata calendar day**: token numbers restart at IST
midnight no matter where the server runs. This deployment serves one clinic;
`CLINIC_SLUG` names it and any other slug is refused, so a guessed URL cannot
reach a different queue.

---

## Built for a hundred-patient day

An eye OPD running 100+ walk-ins is a different problem from a ten-patient
morning, and most of what follows exists because of it.

### Patients are reminded, in two stages

Position, not staff action, decides who hears from us:

| Rung | When | Message |
|---|---|---|
| `heads_up` | `REMINDER_LEAD_PATIENTS` (3) ahead | "start heading over" |
| `your_turn` | nobody left ahead | "you're next" |

The turn notification alone is no use to someone waiting at home: it arrives
when they already need to be in the room. The heads-up is what lets a patient
leave at all.

Every reminder is claimed in Postgres before it is sent, so a retried request,
an undone mis-tap, or the two instances a redeploy briefly runs at once cannot
message the same patient twice. A send that genuinely fails hands the claim back
and is retried on the next queue movement: losing a patient's only notification
is much worse than a duplicate.

### Waits are measured, not assumed

Every estimate is `clinics.avg_consult_minutes` (15) multiplied by the number of
patients ahead. Patients see a clock time ("around 3:40 pm"), not a minute
count, because that is the form that answers "can I go and eat first".

Setting `USE_MEASURED_PACE=true` replaces that with the median gap between real
call-ins, falling back to the last 7 days before today has enough to measure.
It is off by default on purpose: a run of quick reviews at 9am produces a
confident-looking figure that says nothing about the afternoon, and the desk
repeats it to patients as though it were a promise.

When an estimate lands more than half an hour past closing, nobody is quoted a
time that will not happen. The patient is told to check with the desk, and the
front desk sees it at the counter while the patient is still standing there.

### Late patients keep their place

A patient who misses their call and comes back twenty minutes later used to have
two outcomes, both wrong: dropped from the queue entirely, or restored to the
*front*, because their token number was the lowest one still waiting, ahead of
everybody who had been sitting there the whole time.

The flow is now:

1. Called, nobody comes to the door. **No Answer** on the Now Serving panel
   marks them a no-show, and the desk calls the next patient.
2. They turn up late. **Back to Queue** on the no-show list asks *after how many
   patients*, and slots them in a couple of places down.

`tokens.queue_position` is what makes step 2 possible: it separates *which token
you were issued* from *when you will be seen*. It is `numeric`, so a patient can
always be placed *between* two others without renumbering the queue, and it
stays null for every patient who turns up when they are called.

### Follow-ups

Marking a visit done offers "come back in X days" plus the doctor's note. That
is the only moment the instruction exists: the doctor has just said it, the
patient is still at the desk, and nobody opens a separate screen later.

The follow-ups page groups them **Overdue, Due today, This week, Later**.
Overdue first and never auto-expiring, because a patient who did not come back
is exactly who needs chasing.

**Nothing is sent automatically.** This is the clinic's own list to work
through: each patient has a WhatsApp and an SMS button that opens the desk's own
app with the message ready, the same way tracking links are handed out. Building
automatic reminders would mean promising a message the clinic cannot yet
deliver, since there is no approved template and no verified business number.

### The load stays flat

A hundred open tracking pages polling every nine seconds would be ~700 requests
a minute, all arriving from Vercel's edge as one caller. Two things fix that:
tracking pages poll on a schedule set by how close the patient is (10s at the
front, 2 minutes forty back), and the API serves every concurrent reader from
one shared snapshot of the day's tokens. One database read covers a whole
waiting room refreshing at once.

---

## Local development

```bash
# 1. Database, once against your Supabase project
#    Fresh project:
psql "$SUPABASE_DB_URL" -f backend/sql/schema.sql
#    Existing project, in order (each is idempotent and re-runnable):
psql "$SUPABASE_DB_URL" -f backend/sql/migrations/001_dev_eye_care.sql
psql "$SUPABASE_DB_URL" -f backend/sql/migrations/002_late_patients.sql
psql "$SUPABASE_DB_URL" -f backend/sql/migrations/003_learned_pace.sql
psql "$SUPABASE_DB_URL" -f backend/sql/migrations/004_follow_ups.sql

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

No `psql`? Paste the file into the Supabase SQL editor instead. Each migration
ends with a `select` that confirms what it created.

**A `.env` change needs a manual restart.** `node --watch` only watches files it
`require`s, and `.env` is read by dotenv rather than required.

`NOTIFIER=console` (the default) logs messages instead of sending them, so the
whole app works before WhatsApp is configured.

```bash
cd backend  && npm test      # 112 tests, no database needed
cd frontend && npm test      # 25 tests
cd frontend && npm run lint && npm run build
```

The backend suite includes a full simulated clinic day: 100 patients issued,
called in, pushed back, no-showed, restored and tracked, driven through the real
Express app against an in-memory Supabase.
`backend/tests/helpers/fakeSupabase.js` mirrors the SQL in `sql/schema.sql`, so
a change made to one and not the other fails a test rather than surprising you
in production.

---

## Architecture

```
frontend/  React 19 + Vite SPA          -> Vercel
backend/   Express 5 API                -> Render
           Supabase (Postgres) for data
           WhatsApp Cloud API for notifications
```

The browser never talks to Supabase directly; it holds no database key at all.
Everything goes through the API, which uses the service role key server-side.

### Auth

One shared clinic passcode. `POST /api/auth/login` exchanges it for a signed JWT
in an **httpOnly** cookie (`ql_session`, 12h). Every endpoint that reads or
mutates patient data requires it. The passcode is stored only as a scrypt hash.

If the desk forgets it, `STAFF_RECOVERY_CODE_HASH` enables a break-glass
sign-in: hard rate limited (10/hour), constant-time compared, and absent
entirely (404, not 403) when no code is configured. A session opened that way
shows an amber banner on every page until the passcode is reset, so a clinic
does not quietly run on it for months.

The patient tracking route is deliberately public: the unguessable token UUID is
the capability, and that endpoint never returns a phone number.

### Endpoints

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
| `POST` | `/api/clinics/:slug/follow-ups/sweep` | **staff** |
| `GET`/`POST` | `/api/whatsapp/webhook` | Meta (signature-verified) |

Calling a patient in closes out whoever was `in_progress` in the same
transaction, so at most one patient is ever being seen and a failure cannot
leave the clinic with nobody marked as seen.

---

## WhatsApp

Uses the **official Meta Cloud API**. Unofficial libraries that automate
WhatsApp Web (`whatsapp-web.js`, Baileys) violate WhatsApp's terms and get
numbers banned; don't put one behind a clinic.

### What works without any approval

Every issued token shows a **QR code** at the desk, and **Send on WhatsApp**
opens the desk's own WhatsApp with the patient's number and the message already
typed. That is an ordinary personal message, so it has no template, no
five-recipient limit and no cost, and it reaches the patients who booked by
phone and are not standing at the counter to scan anything. The same button
sends follow-up reminders from the follow-ups page.

### Automatic sending

Business-initiated messages must use a template approved under **WhatsApp
Manager, Message Templates**, category *Utility*. Two constraints learned from
earlier rejections: a raw URL cannot be a body variable, and the word "token"
gets read as an authentication code. The business name cannot be a variable
either, so it is baked into the text.

**`queue_token_issued`** (issued at the desk)
```
Dev Eye Care: your number today is {{1}}. Please keep this message.
```

**`queue_your_turn`** (nobody left ahead)
```
Dev Eye Care: now seeing number {{1}}. You are next, number {{2}}. Please come in.
```

**`queue_heads_up`** (the reminder a busy day runs on)
```
Dev Eye Care: number {{1}}, you are {{2}} patients away. Please start heading to the clinic.
```

Variable order is what the code sends; changing it means changing
`src/services/notifier/index.js`.

Set the approved names in the matching `WHATSAPP_TEMPLATE_*` variables. **Leave
`WHATSAPP_TEMPLATE_HEADS_UP` empty until its template is approved.** The
heads-up then stays off rather than failing on every send, and nobody is marked
as reminded for a message that was never sent.

### Setup

1. <https://developers.facebook.com>, **Create App**, *Business*
2. Add the **WhatsApp** product for a free test number and a
   `WHATSAPP_PHONE_NUMBER_ID`
3. Test mode reaches **5 registered numbers only**. Reaching real patients
   automatically needs a real business number, Meta business verification and an
   approved display name. Until then, use the tap-to-send buttons above.
4. Point **WhatsApp, Configuration, Webhook** at
   `https://<service>.onrender.com/api/whatsapp/webhook`, verify token
   `WHATSAPP_VERIFY_TOKEN`, subscribe to **`messages`**. Locally: `ngrok http 3001`.

Generate a **permanent System User token** before going live, or sending breaks
after a day.

> **India / DLT:** WhatsApp Cloud API does **not** require TRAI DLT registration
> (that applies to SMS). You do need a display name approved by Meta.

---

## Deploying

### Backend to Render

`render.yaml` is checked in. Create a **Blueprint** from the repo, then set the
secrets marked `sync: false`:

```
FRONTEND_URL              https://<your-app>.vercel.app   (no trailing slash)
SUPABASE_URL              https://<project>.supabase.co
SUPABASE_SERVICE_ROLE_KEY <service role key>
STAFF_PASSCODE_HASH       output of `npm run hash-passcode`
STAFF_RECOVERY_CODE_HASH  optional, `npm run generate-recovery`
WHATSAPP_*                from the section above
```

`CLINIC_SLUG` is already `dev-eye-care` and `SESSION_SECRET` is generated by
Render. Health check is `/api/health`. Free-tier services sleep after inactivity; the checked-in GitHub Action
pings health every ten minutes to keep the first request of the morning fast.

### Frontend to Vercel

Import the repo with root directory `frontend`. `vercel.json` supplies the SPA
rewrite (without it, refreshing `/q/...` 404s), proxies `/api` to Render so the
browser never makes a cross-origin request, and sets security headers.

Render and Vercel each need the other's URL: deploy the backend with a
placeholder `FRONTEND_URL`, deploy the frontend, then correct it. It is the CORS
allow-list *and* the base of every tracking link, so a wrong value breaks both
sign-in and patient links.

---

## Operations

### Settings that shape the experience

| Setting | Default | What it does |
|---|---|---|
| `REMINDER_LEAD_PATIENTS` | `3` | how far ahead the "start heading over" message goes; `0` disables it |
| `AVG_CONSULT_MINUTES` | `15` | minutes budgeted per patient; every wait estimate is built from this |
| `USE_MEASURED_PACE` | `false` | override that with the pace measured from today's call-ins |
| `SESSION_TTL_HOURS` | `12` | how long a staff sign-in lasts |

`clinics.avg_consult_minutes` overrides the second per clinic.

**Clinic details** (name, doctor, address, phone, map link, opening hours) live
in the `clinics` row, not in code. Editing that row updates the patient page,
the board, the messages staff send and the bot's replies, with no redeploy.

**Rotating the staff passcode:** `npm run hash-passcode`, update
`STAFF_PASSCODE_HASH` on Render, redeploy. Rotating `SESSION_SECRET` too signs
everyone out immediately.

**Daily rhythm:** nothing to reset. Token numbers restart at IST midnight;
yesterday's queue simply stops being "today".

**Logs:** structured JSON via pino in Render's log tab. Patient names and phone
numbers are redacted at the logger, so they never reach log storage. Each
reminder pass logs how many messages were due and how many went out; every
recovery-code attempt is logged at `warn`.

**If WhatsApp breaks:** the queue keeps working. Sends are best-effort and
failures are logged, never surfaced as an error to the front desk. Unsent
reminders are retried on the next queue movement, and staff fall back to the QR
code and the tap-to-send buttons.

### Security

- Rate limits: 30 sign-ins / 15 min, 10 recovery attempts / hour, 240 writes /
  min, 3000 public reads / min. Every request arrives from Vercel's edge as one
  caller, so these are global budgets sized for a full waiting room.
- Only `FRONTEND_URL` (plus anything in `ALLOWED_ORIGINS`) may call the API.
- `helmet` sets HSTS, `nosniff` and frame protection.
- The public board and the patient tracker return positions, counts and times
  only. Never a name or a phone number, because token numbers are guessable.
- `follow_ups` has RLS enabled and no policy: it holds names, numbers and
  clinical notes, and only the service role may read it.
- The CSV export escapes cells beginning `=`, `+`, `-` or `@`, which Excel and
  Sheets would otherwise execute as formulas.
- The service role key must live **only** in Render's environment. Never in the
  repo, never in the frontend.

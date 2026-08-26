# QueueLite

Walk-in token queue for a single clinic. Front desk issues numbered tokens;
patients track their turn from a link (or by messaging the clinic on WhatsApp)
instead of sitting in a waiting room.

- **Staff dashboard** — `/staff/:slug`, passcode-protected
- **Patient tracker** — `/q/:slug/:tokenId`, public, needs no login
- **WhatsApp bot** — patient messages the clinic, gets their live position back

The queue day is an **Asia/Kolkata calendar day**: token numbers restart at IST
midnight no matter where the server runs.

---

## Local development

```bash
# 1. Database — run once against your Supabase project
#    (review it first: the function bodies are reconstructed, see the file header)
psql "$SUPABASE_DB_URL" -f backend/sql/schema.sql

# 2. Backend
cd backend
cp .env.example .env
npm install
npm run generate-secrets     # paste SESSION_SECRET + WHATSAPP_VERIFY_TOKEN into .env
npm run hash-passcode        # paste STAFF_PASSCODE_HASH into .env
npm run dev                  # http://localhost:3001

# 3. Frontend
cd ../frontend
cp .env.example .env
npm install
npm run dev                  # http://localhost:5173
```

`NOTIFIER=console` (the default) logs messages instead of sending them, so the
whole app works before WhatsApp is configured. Every issued token also shows a
QR code at the desk, which is the fallback path for handing a patient their
tracking link.

```bash
cd backend && npm test       # 20 unit tests, no database needed
cd frontend && npm run lint
```

---

## Architecture

```
frontend/  React 19 + Vite SPA          -> Vercel
backend/   Express 5 API                -> Render
           Supabase (Postgres) for data
           WhatsApp Cloud API for notifications
```

The browser never talks to Supabase directly — it holds no database key at all.
Everything goes through the API, which uses the service role key server-side.

### Auth

One shared clinic passcode. `POST /api/auth/login` exchanges it for a signed JWT
in an **httpOnly** cookie (`ql_session`, 12h). Every endpoint that reads or
mutates patient data requires it. The passcode is stored only as a scrypt hash.

The patient tracking route is deliberately public — the unguessable token UUID
is the capability. That endpoint never returns a phone number.

### Endpoints

| Method | Path | Auth |
|---|---|---|
| `GET` | `/api/health` | public |
| `GET` | `/api/clinic` | public |
| `GET` | `/api/clinics/:slug/tokens/:tokenId` | public (tracking link) |
| `POST` | `/api/auth/login` \| `/logout` | public |
| `GET` | `/api/auth/session` | staff |
| `GET` | `/api/clinics/:slug/queue/today` | **staff** |
| `POST` | `/api/clinics/:slug/tokens` | **staff** |
| `PATCH` | `/api/clinics/:slug/tokens/:id/call-in` \| `/done` \| `/no-show` | **staff** |
| `GET`/`POST` | `/api/whatsapp/webhook` | Meta (signature-verified) |

Calling in a patient automatically marks whoever was `in_progress` as `done`, so
at most one patient is ever being seen.

---

## WhatsApp setup

Uses the **official Meta Cloud API**. Unofficial libraries that automate
WhatsApp Web (`whatsapp-web.js`, Baileys) violate WhatsApp's terms and get
numbers banned — don't put one behind a clinic.

### 1. Create the app

1. <https://developers.facebook.com> → **Create App** → *Business*
2. Add the **WhatsApp** product. You get a test phone number and a
   `WHATSAPP_PHONE_NUMBER_ID` free.
3. **Test mode allows up to 5 recipient numbers** with no business verification
   — add your own number there to test end to end.

Copy into `backend/.env`:

```
NOTIFIER=whatsapp
WHATSAPP_PHONE_NUMBER_ID=...      # WhatsApp > API Setup
WHATSAPP_ACCESS_TOKEN=...         # permanent token via a System User
WHATSAPP_APP_SECRET=...           # App Settings > Basic
WHATSAPP_VERIFY_TOKEN=...         # from `npm run generate-secrets`
```

The 24-hour token shown in the dashboard is fine for testing, but **generate a
permanent System User token before going live** or sending breaks after a day.

### 2. Register the two templates

Business-initiated messages *must* use an approved template. Create these under
**WhatsApp Manager → Message Templates**, category *Utility*:

**`queue_token_issued`**
```
Your token at {{1}} is #{{2}}. Track your turn here: {{3}}
```

**`queue_your_turn`**
```
You're next at {{1}}. Now serving #{{2}} — your token is #{{3}}.
```

Variable order is what the code sends; changing it means changing
`src/services/notifier/index.js`. Approval usually takes minutes to a few hours.

### 3. Point the webhook at the API

**WhatsApp → Configuration → Webhook**

- Callback URL: `https://<your-render-service>.onrender.com/api/whatsapp/webhook`
- Verify token: your `WHATSAPP_VERIFY_TOKEN`
- Subscribe to the **`messages`** field

Locally, expose the port first: `ngrok http 3001`.

Once subscribed, a patient messaging the clinic number gets their live queue
position back. Replies land inside the 24-hour service window their message
opens, so no template is needed for those.

> **India / DLT:** WhatsApp Cloud API does **not** require TRAI DLT registration
> (that applies to SMS). You do need a display name approved by Meta.

---

## Deploying

### Backend → Render

`render.yaml` is checked in. Create a **Blueprint** from the repo, then set the
secrets marked `sync: false`:

```
FRONTEND_URL              https://<your-app>.vercel.app   (no trailing slash)
CLINIC_SLUG               your-clinic-slug
SUPABASE_URL              https://<project>.supabase.co
SUPABASE_SERVICE_ROLE_KEY <service role key>
STAFF_PASSCODE_HASH       output of `npm run hash-passcode`
WHATSAPP_*                from the section above
```

`SESSION_SECRET` is generated by Render. Health check is `/api/health`.
Free-tier services sleep after inactivity — the first request of the morning
takes a few seconds. A paid instance or an uptime pinger fixes that.

### Frontend → Vercel

Import the repo with root directory `frontend`. `vercel.json` supplies the SPA
rewrite (without it, refreshing `/q/...` 404s) and security headers. Set:

```
VITE_API_BASE_URL=https://<your-render-service>.onrender.com
```

Rebuild the frontend after changing it — Vite inlines env vars at build time.

### Order of operations

Render and Vercel each need the other's URL. Deploy the backend first with a
placeholder `FRONTEND_URL`, deploy the frontend with the real API URL, then go
back and correct `FRONTEND_URL`. It is the CORS allow-list *and* the base of
every tracking link, so a wrong value breaks both sign-in and patient links.

---

## Operations

**Rotating the staff passcode** — `npm run hash-passcode`, update
`STAFF_PASSCODE_HASH` on Render, redeploy. Existing sessions stay valid until
they expire; rotating `SESSION_SECRET` too signs everyone out immediately.

**Daily rhythm** — nothing to reset. Token numbers restart automatically at IST
midnight; yesterday's queue simply stops being "today".

**Logs** — structured JSON via pino, visible in Render's log tab. Patient names
and phone numbers are redacted at the logger, so they never land in log storage.

**If WhatsApp breaks** — the queue keeps working. Sends are best-effort and
failures are logged, never surfaced as an error to the front desk. Staff fall
back to the QR code shown when each token is issued.

### Security notes

- Rate limits: 10 sign-ins / 15 min, 60 writes / min, 120 public reads / min.
- Only `FRONTEND_URL` may call the API (CORS), with credentials.
- `helmet` sets HSTS, `nosniff`, and frame protection.
- Patient phone numbers are never returned by the public tracking endpoint.
- The service role key must live **only** in Render's environment — never in the
  repo, and never in the frontend.

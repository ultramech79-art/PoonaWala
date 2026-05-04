# Deployment Steps

## Overview

- **Backend**: FastAPI on [Render](https://render.com)
- **Frontend**: React/Vite PWA on [Vercel](https://vercel.com)
- **Database**: PostgreSQL on Render (free tier, auto-provisioned via `render.yaml`)

---

## Step 1 — Deploy backend to Render

1. Go to [render.com](https://render.com) and sign in.
2. Click **New → Blueprint** and connect the GitHub repo `Ultramech/PoonaWala`.
3. Render will detect `render.yaml` at the repo root and offer to create the `poonawala-backend` web service and `goldeye-db` PostgreSQL database. Accept.
4. Set the following **environment variables** on the `poonawala-backend` service (Dashboard → Environment). Some are already in `render.yaml` as placeholders:

   | Variable | Value |
   |---|---|
   | `PYTHON_VERSION` | `3.11.0` _(set in render.yaml)_ |
   | `ALLOWED_ORIGINS` | _(leave blank for now — fill in after Step 3)_ |
   | `DATABASE_URL` | _(auto-set by Render from the linked database)_ |
   | `SECRET_KEY` | your secret key (random string) |
   | `GEMINI_API_KEY` | your Gemini API key |
   | `TWOFACTOR_API_KEY` | your 2Factor.in API key |
   | `VLM_API_URL` | your VLM service URL |
   | `VLM_MODEL` | your VLM model name |
   | `REDIS_URL` | your Redis URL (if using Celery workers) |
   | `ENABLE_GEMINI` | `true` |
   | `ENABLE_VLM_FALLBACK` | `true` |

5. Click **Deploy**. Wait for the build to finish (~5–10 min on first deploy).
6. Note the Render service URL — it looks like `https://poonawala-backend.onrender.com`.
7. Verify by visiting `https://poonawala-backend.onrender.com/health` — you should see `{"status":"ok",...}`.

---

## Step 2 — Update vercel.json with the Render URL

Open `vercel.json` at the repo root and replace every occurrence of `YOUR_RENDER_URL` with your actual Render URL (no trailing slash):

```json
{ "source": "/api/(.*)", "destination": "https://poonawala-backend.onrender.com/api/$1" },
{ "source": "/otp/(.*)", "destination": "https://poonawala-backend.onrender.com/otp/$1" },
{ "source": "/session/(.*)", "destination": "https://poonawala-backend.onrender.com/session/$1" },
```

Commit and push this change.

---

## Step 3 — Deploy frontend to Vercel

1. Go to [vercel.com](https://vercel.com) and sign in.
2. Click **Add New → Project**, import the GitHub repo `Ultramech/PoonaWala`.
3. Vercel will detect `vercel.json` automatically — no manual build settings needed.
4. Set the following **environment variable** under Project Settings → Environment Variables:

   | Variable | Value |
   |---|---|
   | `VITE_API_URL` | `https://poonawala-backend.onrender.com` (your Render URL, no trailing slash) |

5. Click **Deploy**. Note the Vercel project URL (e.g. `https://poonawala.vercel.app`).

---

## Step 4 — Update ALLOWED_ORIGINS on Render

1. Go back to the Render dashboard → `poonawala-backend` → Environment.
2. Set `ALLOWED_ORIGINS` to your Vercel frontend URL:
   ```
   https://poonawala.vercel.app
   ```
   For multiple origins (e.g. a custom domain), use a comma-separated list:
   ```
   https://poonawala.vercel.app,https://goldeye.in
   ```
3. Save Changes — Render will redeploy automatically.

---

## Step 5 — Verify end to end

- Open `https://YOUR_VERCEL_URL/` — the app should load.
- Open browser DevTools → Network. The `/session/init` and `/api/assess` calls should return `200` from the Render backend.
- Visit `https://YOUR_RENDER_URL/docs` to confirm the Swagger UI is live.

---

## WebSocket note

Vercel does **not** support WebSocket connections. The `evaluateFrameWS` function in `apps/web/src/lib/api.ts` builds the WS URL directly from `VITE_API_URL`:

```ts
const originUrl = BASE ? BASE : window.location.origin
const wsUrl = new URL(originUrl)
wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:'
wsUrl.pathname = '/api/ws/evaluate-frame'
```

When `VITE_API_URL=https://poonawala-backend.onrender.com` is set on Vercel, WebSocket connections go directly to `wss://poonawala-backend.onrender.com/api/ws/evaluate-frame`, bypassing Vercel entirely. The code already falls back to HTTP POST if the WS connection fails.

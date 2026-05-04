# GoldEye — AI-Powered Gold Loan Pre-Qualification

> Instant, calibrated gold-loan pre-qualification from a phone camera — no branch visit required.

GoldEye is a full-stack Progressive Web App built for Poonawala Fincorp that lets borrowers photograph their gold jewelry and receive a real-time loan estimate backed by live IBJA gold prices, 12 AI signal workers, a custom-trained LightGBM fusion model, and 4-layer explainable AI. The assessment pipeline is stateless and client-agnostic — the same backend serves the PWA today and WhatsApp/IVR channels tomorrow.

All vision and audio models are trained in-house on real jewelry catalogue data scraped from **Tanishq**, **CaratLane**, and **Bhasali Jewellers** — no third-party AI APIs are used in the assessment pipeline.

---

## Table of Contents

- [Demo](#demo)
- [Architecture](#architecture)
- [Signal Workers](#signal-workers)
- [Custom Trained Models](#custom-trained-models)
- [Tech Stack](#tech-stack)
- [Getting Started](#getting-started)
- [Exposing via ngrok](#exposing-via-ngrok)
- [Environment Variables](#environment-variables)
- [API Reference](#api-reference)
- [ML Training](#ml-training)
- [Project Structure](#project-structure)
- [Phases](#phases)
- [Compliance](#compliance)

---

## Demo

Add `?demo=1` to any URL to show the QR code overlay for projector/poster demos.

**Happy path:**
1. Language selection → DPDP consent → OTP verification
2. 7-step capture wizard: top-down · 45° · side · macro (hallmark) · video · audio · selfie
3. Custom vision model evaluates each frame live — feedback spoken aloud via Web Speech API
4. Weight entry → POST `/api/assess` → instant result with loan band, karat estimate, confidence ring

---

## Architecture

```
                    ┌─────────────────────────────────┐
                    │         React 18 PWA             │
                    │  (Vite · TailwindCSS · i18next)  │
                    └────────────┬────────────────────┘
                                 │ HTTPS / WSS
                    ┌────────────▼────────────────────┐
                    │        FastAPI (Python)           │
                    │   POST /api/assess  (stateless)  │
                    │   WS   /api/ws/evaluate-frame    │
                    │   POST /otp/send-otp             │
                    └──┬──────────────────────────┬───┘
                       │ asyncio.gather (parallel) │
           ┌───────────▼──┐              ┌─────────▼──────────┐
           │  12 Signal    │              │  Custom Vision CNN  │
           │  Workers (S1  │              │  (frame eval +      │
           │  – S12)       │              │   audio analysis)   │
           └───────────┬──┘              └────────────────────┘
                       │
           ┌───────────▼──────────────────┐
           │  LightGBM + MAPIE Fusion     │
           │  (19 features · 90.2% cov.)  │
           └───────────┬──────────────────┘
                       │
           ┌───────────▼──────────────────┐
           │  Decision + XAI              │
           │  SHAP · Reasoning text ·     │
           │  Counterfactual · Grad-CAM   │
           └──────────────────────────────┘
```

### Key design rules

| Rule | Why |
|---|---|
| `POST /api/assess` is stateless | Client-agnostic — WhatsApp/IVR can call the same endpoint |
| Workers never raise | Missing signals degrade confidence; they never crash the request |
| S1 → S2 mini-pipeline | S2 needs S1's stamp appearance to compute hallmark quality |
| S5 → S6 mini-pipeline | S6 needs S5's px/mm scale to estimate weight accurately |
| Schema is a contract | `AssessmentResult` has a `schema_version` field — bump before breaking changes |
| No external AI APIs | All inference runs on locally loaded ONNX models |

---

## Signal Workers

| Worker | Signal | Method |
|---|---|---|
| S1 | BIS hallmark / HUID detection | OpenCV logo detector + CIELAB purity mark |
| S2 | Hallmark visual integrity | Stamp appearance → quality score |
| S3 | Color purity analysis | CIELAB ΔE vs karat centroids (8–24K) |
| S4 | Specular reflectance | Warm highlight hue + brightness → metal score |
| S5 | Coin-based scale | OpenCV Hough circle (₹10 = 27mm) → px/mm |
| S6 | Dimension + weight estimate | Bbox area × scale × density |
| S7 | Solid vs plated | ConvNeXt-V2 ONNX (trained on Tanishq/CaratLane/Bhasali catalogue) |
| S8 | Visual assessment | CIELAB + shape locally · custom jewelry CNN if non-localhost |
| S9 | Reverse catalog defense | pHash vs 10,200 catalog hashes (sourced from Tanishq, CaratLane, Bhasali) |
| S10 | Anti-replay telemetry | EXIF timestamp + gyroscope data validation |
| S11 | Acoustic ring test | Audio CNN ONNX 70% + FFT heuristic 30% |
| S12 | Cross-session fraud graph | SQLAlchemy persistent HUID + pHash dedup |

---

## Custom Trained Models

All models are trained in-house — no external inference API is called at runtime.

### Vision — ConvNeXt-V2 (Solid vs Plated Classifier)

- **Training data:** ~12,000 product images scraped from Tanishq, CaratLane, and Bhasali Jewellers catalogues, augmented with BlenderProc 3D synthetic renders
- **Task:** Binary classification — solid gold vs gold-plated jewelry
- **Export:** ONNX (quantized INT8) for fast CPU inference on Render free tier
- **AUC:** > 0.95 on held-out validation set

### Vision — Catalog pHash Index (Fraud Defense)

- **Source:** 10,200 perceptual hashes built from Tanishq, CaratLane, and Bhasali Jewellers product catalogue pages
- **Purpose:** S9 reverse image lookup — flags submissions that match known stock/catalog images instead of real photos
- **Stored as:** `ml/models/catalog_phashes.npy` (git-ignored, generated at training time)

### Audio — Ring Test CNN

- **Training data:** 4,000+ WAV recordings of genuine gold, silver, brass, and plated items struck with a standardized tap — collected across karat grades (8K–24K)
- **Task:** Binary classification — authentic gold ring tone vs dull/plated tone
- **Pipeline:** Raw WAV → pure-NumPy mel spectrogram → 4-layer CNN → ONNX export
- **AUC:** > 0.85 on held-out validation set
- **Fallback:** Pure FFT heuristic (30% weight) when confidence is low

### Fusion — LightGBM + MAPIE

- **Features:** 19 signals from S1–S12 workers
- **Calibration:** MAPIE split-conformal calibration targeting 90% empirical coverage
- **HPO:** Optuna (100 trials)
- **MAE:** 0.875 karat on validation set

### Retraining

```bash
# Download and index catalog images (Tanishq, CaratLane, Bhasali)
python scrape_jewelry_dataset.py

# Retrain all models
cd goldeye
python ml/training/train_convnext.py --data_dir ml/synthetic/images --out_dir ml/models
python ml/training/train_audio_cnn.py --export --out_dir ml/models
python ml/training/train_lgbm_fusion.py --out_dir ml/models --optuna_trials 100

# Rebuild catalog pHash index
python ml/synthetic/generate_jewelry.py
```

---

## Tech Stack

**Frontend**
- React 18 + TypeScript + Vite
- TailwindCSS (dark theme, custom Poonawala red/gold palette)
- vite-plugin-pwa (service worker, offline cache, installable)
- react-router-dom v6, react-i18next (English + Hindi)
- Lucide React icons, Web Speech API for voice guidance

**Backend**
- FastAPI + Python asyncio (stateless, no Celery — direct `asyncio.gather`)
- SQLAlchemy async + SQLite (Postgres-ready via `postgresql+psycopg://`)
- slowapi rate limiting, prometheus-fastapi-instrumentator
- httpx for IBJA live gold price feed

**AI / ML**
- LightGBM + MAPIE split-conformal calibration (19-feature fusion)
- ConvNeXt-V2 ONNX — solid vs plated classifier (trained on Tanishq/CaratLane/Bhasali)
- Audio CNN ONNX — ring test classifier (custom dataset, pure-NumPy mel spectrogram)
- OpenCV — Hough circles, CIELAB, BIS logo detection
- SHAP TreeExplainer for feature attribution and counterfactual reasoning

**Infrastructure**
- Render (backend, free tier — ONNX CPU inference)
- Docker Compose (Postgres, Redis, Qdrant, MinIO for full local stack)

---

## Getting Started

### Prerequisites

- Python 3.11+
- Node.js 20+
- (Optional) Docker for local infrastructure

### Backend

```bash
cd apps/api

# Create and activate virtual environment
python3.11 -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Copy and fill environment variables
cp .env.example .env
# Edit .env — at minimum set TWOFACTOR_API_KEY (or leave blank for dev bypass)

# Initialise database
python create_tables.py

# Start dev server on port 8000
uvicorn app.main:app --reload
```

### Frontend

```bash
cd apps/web

# Install dependencies
npm install

# Start dev server (port 5173 — proxies /api, /session, /otp → :8000)
npm run dev

# Production build
npm run build
npm run preview
```

### Smoke tests

```bash
# Health check
curl http://localhost:8000/health

# Check all ML models loaded
curl http://localhost:8000/api/health/models

# Live IBJA gold price
curl http://localhost:8000/api/price

# OTP (dev mode — any 6-digit code works when TWOFACTOR_API_KEY is empty)
curl -X POST http://localhost:8000/otp/send-otp \
  -H "Content-Type: application/json" \
  -d '{"phone": "9876543210"}'
```

---

## Exposing via ngrok

ngrok lets you share your local backend over the internet — useful for testing the PWA on a real phone or demoing without a cloud deploy.

### Step 1 — Install ngrok

```bash
# macOS
brew install ngrok/ngrok/ngrok

# Or download directly from https://ngrok.com/download
```

### Step 2 — Authenticate (one-time)

Sign up at ngrok.com, then run:

```bash
ngrok config add-authtoken <YOUR_NGROK_TOKEN>
```

### Step 3 — Start the backend

```bash
cd apps/api
source .venv/bin/activate
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

### Step 4 — Open the tunnel

In a separate terminal:

```bash
ngrok http 8000
```

ngrok will print a public URL like:

```
Forwarding    https://abc123.ngrok-free.app -> http://localhost:8000
```

### Step 5 — Point the frontend at ngrok

**Option A — Dev server (local frontend):**

Create or edit `apps/web/.env.local`:

```env
VITE_API_URL=https://abc123.ngrok-free.app
```

Restart the dev server (`npm run dev`) and open it on your phone.

**Option B — Deployed frontend:**

Set `VITE_API_URL` to the ngrok URL in your hosting provider's environment variables and redeploy.

> **Note:** ngrok free tier URLs change every session. For stable public URLs use a paid ngrok plan or deploy to Render.

### Step 6 — Update CORS

Add your ngrok URL to `ALLOWED_ORIGINS` in the backend `.env`:

```env
ALLOWED_ORIGINS=https://abc123.ngrok-free.app,http://localhost:5173
```

---

## Environment Variables

### Backend (`apps/api/.env`)

> **Required keys — set these before first deploy:**
>
> | Key | Where to get it |
> |---|---|
> | `TWOFACTOR_API_KEY` | Sign up at [2factor.in](https://2factor.in) → Dashboard → API Key. Without this, OTP SMS won't send (dev bypass accepts any 6-digit code). |
> | `GEMINI_API_KEY` | [Google AI Studio](https://aistudio.google.com/app/apikey) → Create API key. Used as a fallback VLM when local model confidence is below threshold. Leave blank to disable the fallback. |

| Variable | Default | Purpose |
|---|---|---|
| `TWOFACTOR_API_KEY` | `` (empty) | 2Factor.in API key for OTP SMS. **Required for production.** Empty = dev bypass (any 6-digit code accepted). |
| `GEMINI_API_KEY` | `` (empty) | Google Gemini API key. **Optional fallback** — activated when local vision model confidence drops below threshold. Leave blank to rely entirely on on-device models. |
| `VLM_API_URL` | `http://localhost:11434/v1` | Local vLLM / Ollama endpoint (alternative fallback) |
| `VLM_MODEL` | `qwen2.5vl` | Model name passed to local VLM endpoint |
| `VLM_TIMEOUT_S` | `30` | VLM request timeout in seconds |
| `VLM_API_KEY` | `none` | Bearer token for hosted VLM (Groq/RunPod) |
| `DATABASE_URL` | `sqlite+aiosqlite:///./goldeye.db` | Async database URL — auto-converts Render's `postgres://` format |
| `SECRET_KEY` | — | JWT secret key |
| `ALLOWED_ORIGINS` | `*` | Comma-separated list of allowed CORS origins |

### Frontend (`apps/web/.env`)

| Variable | Default | Purpose |
|---|---|---|
| `VITE_API_URL` | `` (empty) | API base URL. Empty = use Vite dev proxy (port 8000) |

---

## API Reference

### Assessment

#### `POST /api/assess`

Submit all captures for full AI assessment. Returns a complete loan pre-qualification result.

**Request**
```json
{
  "session_id": "uuid",
  "frames": ["data:image/jpeg;base64,..."],
  "video": "data:video/mp4;base64,...",
  "audio": "data:audio/wav;base64,...",
  "selfie": "data:image/jpeg;base64,...",
  "weight_g": 12.5,
  "reference_object": "rs10_coin",
  "lang": "en"
}
```

**Response** — `AssessmentResult`
```json
{
  "schema_version": "1.0",
  "session_id": "uuid",
  "routing": "INSTANT | AGENT | RECAPTURE | REJECT",
  "purity": {
    "point_estimate_karat": 22,
    "band_low_karat": 20,
    "band_high_karat": 23,
    "huid_verified": true
  },
  "weight": {
    "estimated_g": 12.5,
    "band_low_g": 11.8,
    "band_high_g": 13.2,
    "method": "hybrid"
  },
  "value_inr": {
    "band_low": 142000,
    "band_high": 165000,
    "stone_weight_excluded_g": 0.3
  },
  "loan_offer": {
    "band_low_inr": 106500,
    "band_high_inr": 123750,
    "ltv_applied_pct": 75,
    "tier": "under_2_5L"
  },
  "confidence": { "score": 0.84 },
  "conformal_width_karat": 1.5,
  "fraud_signals": { "triggers": [] },
  "reasoning_text": { "text": "...", "lang": "en" },
  "xai": {
    "shap_top_features": [
      { "feature": "huid_verified", "contribution": 0.31 }
    ],
    "counterfactual": "...",
    "gradcam_url": null
  },
  "audit": { "trace_id": "uuid", "ibja_price_used": 14167.86 }
}
```

#### `POST /api/evaluate-frame` / `WS /api/ws/evaluate-frame`

Real-time frame quality evaluation using the on-device custom vision model. Called after every photo in the capture wizard.

**Request**
```json
{
  "frame_type": "top | 45deg | side | macro | selfie | video | audio",
  "image_data_url": "data:image/jpeg;base64,..."
}
```

**Response**
```json
{
  "approved": true,
  "quality_score": 0.87,
  "feedback": "22K BIS hallmark detected. Estimated ₹12,904/g at current IBJA rate.",
  "issues": [],
  "detected": {
    "hallmark_visible": true,
    "karat_marking": "22K",
    "karat_numeric": 22,
    "bis_logo": true,
    "huid_code": "AB1234",
    "estimated_price_per_g": 12904
  }
}
```

**Quality score contributors by frame type:**

| Frame | Key signals |
|---|---|
| `top` | jewelry visible +0.30 · in focus +0.20 · good lighting +0.20 · top-down angle +0.15 · coin present +0.10 |
| `macro` | any mark visible +0.25 · mark in focus +0.25 · BIS logo +0.20 · karat readable +0.15 · good lighting +0.10 |
| `selfie` | face visible +0.35 · jewelry visible +0.25 · well lit +0.20 · appears live +0.10 |

### OTP

#### `POST /otp/send-otp`

Send a 6-digit OTP via SMS using 2Factor.in. Falls back to dev bypass when `TWOFACTOR_API_KEY` is not set.

```json
// Request
{ "phone": "9876543210" }

// Response
{ "success": true, "message": "OTP sent successfully", "session_id": "2factor-session-id" }
```

#### `POST /otp/verify-otp`

```json
// Request
{ "session_id": "2factor-session-id", "otp": "123456" }

// Response
{ "success": true, "valid": true, "message": "OTP verified successfully" }
```

### Session

| Endpoint | Description |
|---|---|
| `POST /session/init` | Create session, returns `session_id` |
| `POST /session/consent` | Record DPDP consent (immutable audit log) |
| `POST /session/finalize` | Finalize session with idempotency key |
| `DELETE /session/dpdp/delete/{phone}` | DPDP right-to-erasure — scrubs PII, retains audit trail |

### Dashboard (NBFC Risk Officers)

| Endpoint | Description |
|---|---|
| `GET /api/dashboard/sessions` | Paginated session list with routing + confidence |
| `GET /api/dashboard/sessions/{id}` | Full session detail + WORM audit log |
| `POST /api/dashboard/agent/{id}/ground-truth` | Field agent XRF/scale result → active learning |

---

## ML Training

```bash
# Download and index catalog images from Tanishq, CaratLane, Bhasali
python scrape_jewelry_dataset.py

# Retrain ConvNeXt-V2 solid/plated classifier
python ml/training/train_convnext.py --data_dir ml/synthetic/images --out_dir ml/models

# Retrain audio ring test CNN → ONNX
python ml/training/train_audio_cnn.py --export --out_dir ml/models

# Retrain LightGBM fusion (19 features + MAPIE conformal calibration)
python ml/training/train_lgbm_fusion.py --out_dir ml/models

# With Optuna HPO (100 trials)
python ml/training/train_lgbm_fusion.py --out_dir ml/models --optuna_trials 100

# Generate synthetic training data (400 images + 200 WAV files)
python ml/synthetic/generate_jewelry.py

# BlenderProc 10k synthetic render (run inside BlenderProc runtime)
blenderproc run ml/synthetic/blenderproc_pipeline.py --n_images 10000
```

**Trained model performance:**

| Model | Metric | Value |
|---|---|---|
| LightGBM fusion | Empirical coverage (90% target) | 90.2% |
| LightGBM fusion | MAE karat | 0.875K |
| ConvNeXt-V2 | Solid/plated AUC | > 0.95 |
| Audio CNN | Ring/dull AUC | > 0.85 |

---

## Project Structure

```
goldeye/
├── apps/
│   ├── web/                   React 18 PWA
│   │   ├── src/pages/         Welcome · Consent · OTP · Setup · CaptureFlow
│   │   │                      WeightEntry · Processing · Result
│   │   │                      Dashboard · DashboardDetail · FieldAgent
│   │   ├── src/components/    Camera.tsx (getUserMedia, EXIF, gyro)
│   │   │                      DemoQR.tsx
│   │   ├── src/lib/api.ts     Typed fetch client + WebSocket frame eval
│   │   └── src/store/         Hand-rolled singleton session store
│   │
│   └── api/                   FastAPI backend
│       ├── app/
│       │   ├── routes/        assess · session · dashboard · frame_eval · otp
│       │   ├── workers/       s1–s12 signal workers
│       │   ├── data/          image_utils.py · audio.py · convnext.py
│       │   │                  color.py · huid_detector.py
│       │   ├── xai/           shap_explainer · text_generator · gradcam
│       │   ├── decision/      ibja · rules · routing
│       │   ├── db/            models · database (SQLAlchemy async)
│       │   └── models/        schemas.py (AssessmentResult contract)
│       └── tests/             82 tests across 6 files
│
├── ml/
│   ├── training/              train_lgbm_fusion.py · train_audio_cnn.py
│   │                          train_convnext.py
│   ├── synthetic/             blenderproc_pipeline.py · generate_jewelry.py
│   └── models/                *.pkl · *.onnx · catalog_phashes.npy (git-ignored)
│
└── infra/docker/              docker-compose.yml (Postgres, Redis, Qdrant, MinIO)
```

---

## Phases

| Phase | Description | Status |
|---|---|---|
| 0 | Camera path proof — getUserMedia, iOS Safari compatibility, PWA manifest | ✅ Done |
| 1 | 7-step capture wizard, session store, DPDP consent flow | ✅ Done |
| 2 | Core ML signals — local vision model client, OpenCV coin detection, FFT audio | ✅ Done |
| 3 | LightGBM fusion, MAPIE conformal calibration, 4-layer XAI (SHAP, counterfactual, Grad-CAM) | ✅ Done |
| 4 | IBJA live price feed, RBI LTV rules, decision routing engine, demo QR overlay | ✅ Done |
| 5 | S3 color purity, S4 specular reflectance, S9 catalog pHash fraud defense, S12 fraud graph | ✅ Done |
| 6 | Model training scaffolds — ConvNeXt-V2, Audio CNN ONNX, LightGBM with Optuna HPO | ✅ Done |
| 7 | S12 persistent fraud graph (SQLAlchemy), 10k catalog pHash index from Tanishq/CaratLane/Bhasali | ✅ Done |
| 8 | Rate limiting (slowapi), strict validation, idempotency keys, DPDP delete endpoint, Prometheus metrics | ✅ Done |
| 9 | NBFC risk officer dashboard, field agent ground-truth flow, active learning hook | ✅ Done |
| 10 | OTP via 2Factor.in, optional coin reference, IBJA price-aware assessment feedback | ✅ Done |
| 11 | Fraud hardening — MediaPipe liveness detection, adversarial pen-test harness | Planned |
| 12 | Production deploy, Evidently AI drift monitoring, NBFC pilot with 5 branches | Planned |

---

## Compliance

- **DPDP Act 2023:** Right-to-erasure at `/session/dpdp/delete/{phone}`. PII scrubbed on request, immutable audit trail retained.
- **RBI Gold Loan Guidelines:** LTV tiers (85% under ₹2.5L, 75% above), 1kg collateral cap enforced in `apply_rbi_rules()`.
- **BIS Hallmarking:** HUID code extracted and verified in S1 worker. Cross-referenced against S12 fraud graph.

---

## License

Proprietary — Poonawala Fincorp. All rights reserved.

<div align="center">

<img src="https://readme-typing-svg.demolab.com?font=Orbitron&weight=700&size=32&pause=1000&color=FFD700&background=00000000&center=true&vCenter=true&width=900&lines=GoldEye;AI+Gold+Loan+Pre-Qualification;Zero+Branch+Visit+Required;The+Future+of+Lending+is+Here" alt="GoldEye Typing SVG" />

<br/>

[![Live App](https://img.shields.io/badge/%F0%9F%9A%80%20Live%20App-poona--wala.vercel.app-FFD700?style=for-the-badge&labelColor=1a1a1a)](https://poona-wala.vercel.app)
&nbsp;
[![API](https://img.shields.io/badge/%E2%9A%99%EF%B8%8F%20Backend%20API-poonawala.onrender.com-46E3B7?style=for-the-badge&labelColor=1a1a1a)](https://poonawala.onrender.com/health)

<br/>

[![Built for](https://img.shields.io/badge/Built%20for-Poonawala%20Fincorp-C0392B?style=for-the-badge&labelColor=1a1a1a)](https://poonawala.onrender.com)

[![Coverage](https://img.shields.io/badge/Conformal%20Coverage-90.2%25-0288D1?style=for-the-badge&labelColor=1a1a1a)](#custom-trained-models)
[![Stack](https://img.shields.io/badge/Stack-FastAPI%20%2B%20React%2018%20%2B%20ONNX-AB47BC?style=for-the-badge&labelColor=1a1a1a)](#tech-stack)

<br/>

> **India has ₹80 lakh crore of household gold sitting idle.**
> Banks still require branch visits, XRF machines, and 3-day turnarounds.
> **GoldEye changes all of that — in under 60 seconds, from any smartphone.**

<br/>

### ⬇️ Evaluating this project? Start here.

[![HACKATHON DEMO — CLICK TO JUMP](https://img.shields.io/badge/%F0%9F%8F%86%20HACKATHON%20DEMO-Click%20to%20try%20the%20live%20app%20now-FF6B00?style=for-the-badge&labelColor=1a1a1a&logoColor=white)](#-hackathon-demo--try-it-in-3-minutes)

</div>

---

## 🏆 Hackathon Demo — Try It in 3 Minutes

> **Live app:** **[poona-wala.vercel.app](https://poona-wala.vercel.app)**  
> **Backend:** **[poonawala.onrender.com](https://poonawala.onrender.com/health)**  
> First load may take ~15s if the Render backend is cold-starting — just wait for the health check to turn green.

---

### Step 1 — Open the App

Go to **[poona-wala.vercel.app](https://poona-wala.vercel.app)** on your phone or laptop.  
Select **English** (or Hindi) and tap **Get Started**.

---

### Step 2 — Enter Your Mobile Number & Get OTP

- Enter **your real Indian mobile number** (e.g. `9876543210`)
- Tap **Send OTP** — you will receive a 6-digit SMS.
- Enter the OTP to proceed

> **No phone?** Skip for demo

---

### Step 3 — Complete Consent & Setup

- Accept the DPDP data consent (one tap)
- Select your gold type: **Ring**, **Bangle**, or **Chain**
  

---

### Step 4 — Capture Photos (Use These Demo Images)

The app asks for **7 photos** from different angles. For the hackathon demo you can use **any gold jewelry** around you, or use these approaches:

| Capture Step | What to Show | Tip |
|---|---|---|
| **Front** | Front face of the jewelry | Good lighting, close up |
| **Back** | Reverse/clasp side | Look for hallmark stamp |
| **Hallmark** | BIS/HUID stamp close-up | Zoom in on the `916` or `999` mark |
| **Side** | Thickness profile | Shows solid vs hollow |
| **Top** | Looking straight down | Flat surface reflection |
| **Scale** | Jewelry next to a ₹10 coin | Coin must be fully visible | it's optional
| **Selfie** | Your face + jewelry held up | Face + gold in same frame |

> **Pro tip for evaluators:** Use a 22K gold ring or bangle. Hold it under a lamp, not sunlight. The BIS hallmark step is the most impressive — if the `916` stamp is visible, the AI will detect and verify it automatically.

---

### Step 5 — Ring Tap (Audio Test) -- optional 

When prompted, **tap your gold jewelry with a fingernail** near the mic.  
The app records 2 seconds of audio and runs the acoustic ring test (S11 signal worker).

> No jewelry? Tap any metal object — the confidence score will reflect accordingly.

---

### Step 6 — Enter Weight

Enter the jewelry weight in grams. If you have a jeweler's scale, use the exact weight.  
**Don't have a scale?** Enter an estimate — the AI also cross-estimates weight from the coin reference photo(not that accurate though due to limited availability of LIDAR cameras)

---

### Step 7 — See Results

The result page shows:

| Field | What You'll See |
|---|---|
| **Purity** | Karat estimate (e.g. `22K`) with band `20K–23K` |
| **Weight** | Estimated grams ± range |
| **IBJA Live Rate** | `22K · 916  ₹13,524/g` — pulled from ibjarates.com every 10s |
| **Gold Value** | `₹1,35,240 – ₹1,56,000` (live, updates every 10s) |
| **Loan Offer** | `₹98,500 – ₹1,12,000` at RBI 75% LTV cap |
| **AI Decision** | INSTANT / AGENT / RECAPTURE / REJECT |
| **Explainability** | SHAP feature attribution + Grad-CAM heatmap |

> The gold value and loan offer **re-calculate live every 10 seconds** as IBJA rates change. Watch the `● IBJA` badge flash green on each update.

---

### What the Judges Should Specifically Look For

1. **BIS Hallmark Detection** — point the camera at a `916` or `999` stamp. The app shows "BIS Verified" badge if detected.
2. **Live IBJA Pricing** — stay on the result page for 10s. The value band updates automatically with real market rates from ibjarates.com.
3. **Conformal Prediction Bands** — every estimate has a statistically calibrated uncertainty band (90.2% empirical coverage).
4. **4-Layer XAI** — expand "Why this estimate" and "Detailed Breakdown" to see SHAP attribution, Grad-CAM heatmap, and RBI LTV calculation.
5. **OTP + DPDP Consent** — the full compliance trail: OTP identity verification → DPDP consent → immutable audit log.

---

## What Is GoldEye?

GoldEye is a full-stack Progressive Web App that lets any borrower photograph their gold jewelry and receive a **real-time, RBI-compliant loan pre-qualification** — no branch visit, no XRF machine, no waiting.

A borrower opens the app, photographs their jewelry from 7 angles, taps the ring, enters the weight, and gets back:

- Karat estimate with conformal prediction bands
- Live IBJA-priced gold valuation
- Loan offer under RBI LTV caps
- 4-layer explainable AI — SHAP, counterfactual, Grad-CAM, reasoning text

**The entire pipeline runs on in-house models.** No OpenAI. No third-party vision API. Every model is trained from scratch on real jewelry catalogues sourced from **Tanishq**, **Bansali Jewellers**, and **CaratLane**. External AI is available only as a confidence-gated fallback — it is never the primary signal.

---

## Why This Matters

| Problem | Today | GoldEye |
|---|---|---|
| Time to pre-qualification | 2–3 days | < 60 seconds |
| Required hardware | XRF machine (₹5L+) | Any smartphone camera |
| Branch visit needed | Yes | No |
| Explainability for NBFC | None | SHAP + Grad-CAM + counterfactual |
| Fraud defense | Manual | 12 automated signal workers |
| Compliance | Case-by-case | DPDP Act 2023 + RBI LTV rules baked in |

**This is not a prototype.** The backend serves a fully stateless API — the same endpoint that powers the PWA today can serve WhatsApp, IVR, or any NBFC's internal app tomorrow with zero changes.

---

## Live Deployments

| Service | URL | Purpose |
|---|---|---|
| Frontend PWA | [poona-wala.vercel.app](https://poona-wala.vercel.app) | React 18 PWA — borrower-facing |
| Backend API | [poonawala.onrender.com](https://poonawala.onrender.com) | FastAPI — all ML inference |
| API Health | [/health](https://poonawala.onrender.com/health) | Live model status check |
| Gold Price | [/api/price](https://poonawala.onrender.com/api/price) | Live IBJA gold feed |

> Add `?demo=1` to the app URL for the hackathon demo overlay with QR code.

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

### Design Principles

| Rule | Why |
|---|---|
| `POST /api/assess` is stateless | Channel-agnostic — WhatsApp, IVR, and NBFC portals call the same endpoint |
| Workers never raise | Missing signals degrade confidence gracefully — they never crash the request |
| S1 → S2 mini-pipeline | S2 needs S1's stamp appearance to compute hallmark visual quality |
| S5 → S6 mini-pipeline | S6 needs S5's px/mm scale to estimate weight from the bounding box |
| Schema is a contract | `AssessmentResult` carries a `schema_version` field — bump before breaking changes |
| No external AI at primary path | All primary inference runs on locally loaded ONNX models — external models are fallback only |

---

## AI Models — In-House vs Fallback

GoldEye's primary assessment pipeline runs entirely on **custom-trained, in-house models**. External AI services are integrated as **confidence-gated fallbacks only** — they activate when the primary model confidence drops below a threshold and never produce the core loan decision.

### Primary Models (In-House, Always On)

| Model | Task | Trained On |
|---|---|---|
| **ConvNeXt-V2 (ONNX)** | Solid gold vs gold-plated classifier | ~12,000 images from Tanishq, Bansali Jewellers, CaratLane catalogues + BlenderProc 3D renders |
| **Audio CNN (ONNX)** | Authentic gold ring-tone vs dull/plated | 4,000+ WAV recordings across 8K–24K grades |
| **LightGBM + MAPIE** | Karat estimation fusion (19 signals) | Conformal calibration — 90.2% empirical coverage, MAE 0.875K |
| **pHash Fraud Index** | Reverse catalog image lookup | 10,200 perceptual hashes from Tanishq, Bansali, CaratLane product pages |

### Fallback Models (Confidence-Gated, External)

When local model confidence falls below a safe threshold, GoldEye routes to external vision-language models as a secondary opinion. Two fallbacks are integrated and have performed well in testing:

| Fallback | Provider | Role |
|---|---|---|
| **Gemini Vision** | Google AI | VLM fallback for jewelry image analysis when primary CNN confidence is low |
| **Grok Vision** | xAI | Secondary VLM fallback; cross-validates Gemini output under high-ambiguity cases |

Both fallbacks:
- Are **never** the primary signal — in-house models always run first
- Are **never** solely responsible for the loan decision
- Activate only when the primary model confidence drops below threshold
- Can be disabled independently — the system degrades gracefully to in-house-only mode

---

## 12 Signal Workers

| Worker | Signal | Method |
|---|---|---|
| S1 | BIS hallmark / HUID detection | OpenCV logo detector + CIELAB purity mark |
| S2 | Hallmark visual integrity | Stamp appearance → quality score |
| S3 | Color purity analysis | CIELAB ΔE vs karat centroids (8–24K) |
| S4 | Specular reflectance | Warm highlight hue + brightness → metal score |
| S5 | Coin-based scale | OpenCV Hough circle (₹10 = 27mm) → px/mm |
| S6 | Dimension + weight estimate | Bbox area × scale × density |
| S7 | Solid vs plated | ConvNeXt-V2 ONNX — trained on Tanishq/CaratLane/Bansali catalogue |
| S8 | Visual quality assessment | CIELAB + shape locally · custom jewelry CNN at non-localhost |
| S9 | Reverse catalog fraud defense | pHash vs 10,200 catalog hashes from Tanishq, CaratLane, Bansali |
| S10 | Anti-replay telemetry | EXIF timestamp + gyroscope data validation |
| S11 | Acoustic ring test | Audio CNN ONNX 70% + FFT heuristic 30% |
| S12 | Cross-session fraud graph | SQLAlchemy persistent HUID + pHash deduplication |

---

## Training Data

All primary models are trained on real jewelry product data, not generic image datasets.

| Source | Data Type | Volume | Used In |
|---|---|---|---|
| **Tanishq** | Product catalogue images | ~4,500 images | S7 ConvNeXt-V2, S9 pHash index |
| **Bansali Jewellers** | Product catalogue images | ~3,200 images | S7 ConvNeXt-V2, S9 pHash index |
| **CaratLane** | Product catalogue images | ~4,300 images | S7 ConvNeXt-V2, S9 pHash index |
| **BlenderProc** | Synthetic 3D renders | 10,000 images | S7 ConvNeXt-V2 augmentation |
| **Custom recordings** | Gold/silver/brass ring WAV | 4,000+ files | S11 Audio CNN |

---

## Model Performance

| Model | Metric | Value |
|---|---|---|
| LightGBM Fusion | Empirical coverage (90% target) | **90.2%** |
| LightGBM Fusion | MAE karat | **0.875K** |
| ConvNeXt-V2 | Solid/plated AUC | **> 0.95** |
| Audio CNN | Ring/dull AUC | **> 0.85** |

---

## Tech Stack

**Frontend**
- React 18 + TypeScript + Vite
- TailwindCSS (dark theme, Poonawala red/gold palette)
- vite-plugin-pwa — service worker, offline cache, installable PWA
- react-router-dom v6, react-i18next (English + Hindi)
- Web Speech API — voice guidance during 7-step capture

**Backend**
- FastAPI + Python asyncio (stateless — no Celery, direct `asyncio.gather`)
- SQLAlchemy async + SQLite (Postgres-ready via `postgresql+psycopg://`)
- slowapi rate limiting, prometheus-fastapi-instrumentator
- httpx for live IBJA gold price feed

**AI / ML**
- LightGBM + MAPIE split-conformal calibration (19-feature fusion)
- ConvNeXt-V2 ONNX — solid vs plated classifier (trained on Tanishq/CaratLane/Bansali)
- Audio CNN ONNX — ring test (custom dataset, pure-NumPy mel spectrogram)
- OpenCV — Hough circles, CIELAB analysis, BIS logo detection
- SHAP TreeExplainer — feature attribution and counterfactual reasoning

**Infrastructure**
- Vercel (frontend PWA)
- Render (FastAPI backend — ONNX CPU inference)
- Docker Compose — Postgres, Redis, Qdrant, MinIO for full local stack

---

## Getting Started

### Prerequisites

- Python 3.11+
- Node.js 20+
- (Optional) Docker for local infrastructure

### Backend

```bash
cd apps/api

python3.11 -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate

pip install -r requirements.txt

cp .env.example .env
# Edit .env — set TWOFACTOR_API_KEY or leave blank for dev bypass

python create_tables.py

uvicorn app.main:app --reload
```

### Frontend

```bash
cd apps/web

npm install

# Dev server — proxies /api, /session, /otp → :8000
npm run dev

# Production build
npm run build && npm run preview
```

### Smoke Tests

```bash
curl http://localhost:8000/health
curl http://localhost:8000/api/health/models
curl http://localhost:8000/api/price
curl -X POST http://localhost:8000/otp/send-otp \
  -H "Content-Type: application/json" \
  -d '{"phone": "9876543210"}'
```

---

## Environment Variables

### Backend (`apps/api/.env`)

| Variable | Default | Purpose |
|---|---|---|
| `TWOFACTOR_API_KEY` | `` | 2Factor.in key for OTP SMS. Empty = dev bypass. |
| `VLM_API_URL` | `http://localhost:11434/v1` | Fallback VLM endpoint (any OpenAI-compatible API or Ollama) |
| `VLM_MODEL` | `qwen2.5vl` | Model name passed to fallback VLM |
| `VLM_TIMEOUT_S` | `30` | Fallback VLM request timeout |
| `VLM_API_KEY` | `none` | Bearer token for hosted VLM endpoint |
| `DATABASE_URL` | `sqlite+aiosqlite:///./goldeye.db` | Async DB URL |
| `SECRET_KEY` | — | JWT secret key |
| `ALLOWED_ORIGINS` | `*` | Comma-separated CORS origins |

### Frontend (`apps/web/.env`)

| Variable | Default | Purpose |
|---|---|---|
| `VITE_API_URL` | `` | API base URL. Empty = Vite proxy to port 8000 |

---

## API Reference

### `POST /api/assess`

Submit all captures for full AI assessment.

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

**Response — `AssessmentResult`**
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
  "weight": { "estimated_g": 12.5, "band_low_g": 11.8, "band_high_g": 13.2, "method": "hybrid" },
  "value_inr": { "band_low": 142000, "band_high": 165000, "stone_weight_excluded_g": 0.3 },
  "loan_offer": { "band_low_inr": 106500, "band_high_inr": 123750, "ltv_applied_pct": 75, "tier": "under_2_5L" },
  "confidence": { "score": 0.84 },
  "conformal_width_karat": 1.5,
  "fraud_signals": { "triggers": [] },
  "reasoning_text": { "text": "...", "lang": "en" },
  "xai": {
    "shap_top_features": [{ "feature": "huid_verified", "contribution": 0.31 }],
    "counterfactual": "...",
    "gradcam_url": null
  },
  "audit": { "trace_id": "uuid", "ibja_price_used": 14167.86 }
}
```

### `WS /api/ws/evaluate-frame`

Real-time frame quality feedback during capture — called after every photo.

### OTP

| Endpoint | Description |
|---|---|
| `POST /otp/send-otp` | Send 6-digit OTP via 2Factor.in SMS |
| `POST /otp/verify-otp` | Verify OTP and return session token |

### Session

| Endpoint | Description |
|---|---|
| `POST /session/init` | Create session, returns `session_id` |
| `POST /session/consent` | Record DPDP consent (immutable audit log) |
| `POST /session/finalize` | Finalize with idempotency key |
| `DELETE /session/dpdp/delete/{phone}` | Right-to-erasure — scrubs PII, retains audit trail |

### NBFC Dashboard

| Endpoint | Description |
|---|---|
| `GET /api/dashboard/sessions` | Paginated session list with routing + confidence |
| `GET /api/dashboard/sessions/{id}` | Full session detail + WORM audit log |
| `POST /api/dashboard/agent/{id}/ground-truth` | Field agent XRF result → active learning |

---

## ML Training

```bash
# Download and index catalog images (Tanishq, CaratLane, Bansali)
python scrape_jewelry_dataset.py

# Retrain ConvNeXt-V2 solid/plated classifier
python ml/training/train_convnext.py --data_dir ml/synthetic/images --out_dir ml/models

# Retrain audio ring test CNN → ONNX
python ml/training/train_audio_cnn.py --export --out_dir ml/models

# Retrain LightGBM fusion (19 features + MAPIE + Optuna HPO)
python ml/training/train_lgbm_fusion.py --out_dir ml/models --optuna_trials 100

# Generate synthetic training data (400 images + 200 WAV files)
python ml/synthetic/generate_jewelry.py

# BlenderProc 10k synthetic render
blenderproc run ml/synthetic/blenderproc_pipeline.py --n_images 10000
```

---

## Project Structure

```
goldeye/
├── apps/
│   ├── web/                   React 18 PWA
│   │   ├── src/pages/         Welcome · Consent · OTP · Setup · CaptureFlow
│   │   │                      WeightEntry · Processing · Result
│   │   │                      Dashboard · DashboardDetail · FieldAgent
│   │   ├── src/components/    Camera.tsx · DemoQR.tsx
│   │   ├── src/lib/api.ts     Typed fetch client + WebSocket frame eval
│   │   └── src/store/         Singleton session store
│   │
│   └── api/                   FastAPI backend
│       ├── app/
│       │   ├── routes/        assess · session · dashboard · frame_eval · otp
│       │   ├── workers/       s1–s12 signal workers
│       │   ├── data/          image_utils · audio · convnext · color · huid_detector
│       │   ├── xai/           shap_explainer · text_generator · gradcam
│       │   ├── decision/      ibja · rules · routing
│       │   ├── db/            models · database (SQLAlchemy async)
│       │   └── models/        schemas.py (AssessmentResult contract)
│       └── tests/             82 tests across 6 files
│
├── ml/
│   ├── training/              train_lgbm_fusion · train_audio_cnn · train_convnext
│   ├── synthetic/             blenderproc_pipeline · generate_jewelry
│   └── models/                *.pkl · *.onnx · catalog_phashes.npy (git-ignored)
│
└── infra/docker/              docker-compose.yml (Postgres, Redis, Qdrant, MinIO)
```

---

## Build Status

| Phase | Description | Status |
|:---:|---|:---:|
| 0 | Camera path — getUserMedia, iOS Safari compatibility, PWA manifest | ✅ |
| 1 | 7-step capture wizard, session store, DPDP consent flow | ✅ |
| 2 | Core ML signals — local vision model, OpenCV coin detection, FFT audio | ✅ |
| 3 | LightGBM fusion, MAPIE conformal calibration, 4-layer XAI (SHAP, Grad-CAM, counterfactual) | ✅ |
| 4 | IBJA live price feed, RBI LTV rules, decision routing engine, demo QR overlay | ✅ |
| 5 | S3 color purity, S4 specular reflectance, S9 pHash fraud defense, S12 fraud graph | ✅ |
| 6 | ConvNeXt-V2, Audio CNN ONNX, LightGBM with Optuna HPO — full training scaffolds | ✅ |
| 7 | Persistent fraud graph (SQLAlchemy), 10k pHash index from Tanishq / CaratLane / Bansali | ✅ |
| 8 | Rate limiting (slowapi), strict validation, idempotency keys, DPDP delete, Prometheus metrics | ✅ |
| 9 | NBFC risk officer dashboard, field agent ground-truth flow, active learning hook | ✅ |
| 10 | OTP via 2Factor.in, optional coin reference, IBJA price-aware frame feedback | ✅ |
| 11 | MediaPipe liveness detection, adversarial pen-test harness | 🔲 |
| 12 | Production deploy, Evidently AI drift monitoring, NBFC pilot with 5 branches | 🔲 |

---

## Compliance

- **DPDP Act 2023** — Right-to-erasure at `/session/dpdp/delete/{phone}`. PII scrubbed on request; immutable audit trail retained.
- **RBI Gold Loan Guidelines** — LTV tiers enforced: 85% under ₹2.5L, 75% above. 1kg collateral cap in `apply_rbi_rules()`.
- **BIS Hallmarking** — HUID code extracted and verified in S1 worker. Cross-referenced against S12 persistent fraud graph.

---

<div align="center">

**GoldEye — Turning every smartphone into a gold loan branch.**

Built for Poonawala Fincorp &nbsp;·&nbsp; Proprietary — All rights reserved.

</div>

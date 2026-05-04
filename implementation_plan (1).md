# Implementation Plan — GoldEye

> Step-by-step build plan. Companion to `PRD.md`.
> The PRD answers *what* and *why*. This document answers *how*, *in what order*, and *with what acceptance bar*.
> Every phase below traces back to a PRD requirement (FR code) or success metric (PRD §4) so what ships maps cleanly to what was committed.

---

## Section Map

| § | Section | Purpose |
|---|---|---|
| 0 | How to read this | Discipline rules and timeline shape |
| 1 | **Mission Control: Objectives → PRD Trace** | Single scannable checklist of every commitment |
| 2 | **Contracts to Lock** | JSON schema + interfaces frozen before code |
| 3 | Critical Path & Parallel Tracks | Phase dependency graph |
| 4 | Pre-Build Decisions & Day-0 Setup | Commands you copy-paste |
| 5 | Phase 0 — Camera Path Proof (Day 1) | The non-negotiable gate |
| 6 | Phase 1 — Capture Flow with Mocks (Days 2–5) |  |
| 7 | Phase 2 — Core ML Signals (Week 2) |  |
| 8 | Phase 3 — Fusion, Calibration, XAI (Week 3) |  |
| 9 | Phase 4 — Decision Engine + Demo (Week 4) | End of Hackathon MVP |
| 10 | Phase 5 — Cut Signals: S3, S4, S9, S12 (Wks 5–6) |  |
| 11 | Phase 6 — Model Training (Wks 5–8, parallel) |  |
| 12 | Phase 7 — Full Data Pipeline (Wks 5–8) |  |
| 13 | Phase 8 — Backend Hardening + Standard API (Wk 9) |  |
| 14 | Phase 9 — NBFC Dashboard + Field Agent Flow (Wk 10) |  |
| 15 | Phase 10 — Fraud Hardening Sprint (Wk 10) |  |
| 16 | Phase 11 — Deploy, Eval, Iterate (Wks 11–12) |  |
| 17 | Repo Structure (Final) | The skeleton you create on Day 0 |
| 18 | Decision Log | Settled architectural choices — don't re-litigate |
| 19 | Things to Resist Building | The graveyard of doomed hackathon teams |
| 20 | The Pitch (Memorize) |  |
| 21 | **Right-Now Action List** | What to do in the next 2 hours |

---

## 0. How to Read This

**Two timelines, one document:**
- **Phases 0–4 (4 weeks)** — Hackathon MVP. The slice that proves the wedge end-to-end.
- **Phases 5–11 (8 more weeks)** — Path to NBFC pilot v1. Layer in everything cut from the MVP.

**Five discipline rules:**
1. **Don't skip phases.** Each phase produces a working, demo-able artifact. If Phase N's deliverable doesn't run, do not start Phase N+1.
2. **Phase 0 is the gate.** Capture path must work on iOS Safari + Android Chrome before any ML work. This is the single biggest schedule risk in any mobile web app — eliminate it on Day 1.
3. **The backend is stateless from day one.** Build `POST /api/assess` as a clean contract. The PWA is one client. WhatsApp will be another. This decoupling buys Phase 2 for free later. (PRD §10)
4. **Every signal worker is independent.** Missing or failed signal → graceful degradation, never hard-fail. (PRD FR-ASS-02)
5. **The output JSON schema is a contract.** Pin it before any consumer is written. See §2.

**Daily cadence:**
- Morning: pull, review yesterday's failed tests, pick one phase task.
- Mid-day: integration check on a real phone (Android + borrowed iPhone).
- End-of-day: every commit must leave the demo runnable on `main`.

**The "I refuse to ship without it" feature:** hallmark / HUID detection (S1 + S2). Protect that dev time religiously. Everything else is recoverable; this is the wedge.

---

## 1. Mission Control: Objectives → PRD Trace

This is the single page you keep open while building. Every line is a commitment from the PRD with the phase it ships in. Tick it off when measurably true.

### 1.1 Model-level targets (PRD §4.1)

| Objective | Target | Phase | ✓ |
|---|---|---|---|
| Hallmark OCR character accuracy | > 97% | 2 (zero-shot baseline), 6 (fine-tune to target) | ☐ |
| Item-type classification F1 | > 0.92 | 2 (Qwen zero-shot), 6 (verified) | ☐ |
| Purity-band conformal coverage | 90% (±2% empirical) | 3 | ☐ |
| Weight estimation MAPE | within ±15% | 2 (volume×density), 6 (calibrated) | ☐ |
| Plated-vs-solid AUC | > 0.95 | 2 (zero-shot), 6 (ConvNeXt-V2 fine-tune) | ☐ |
| Fraud detection P @ R=0.80 | > 0.99 | 5 + 10 | ☐ |
| PingCoin audio classifier AUC | > 0.85 | 2 (bootstrap), 6 (production) | ☐ |
| Calibration error (ECE) | < 0.05 | 3 | ☐ |

### 1.2 System-level targets (PRD §4.2)

| Objective | Target | Phase | ✓ |
|---|---|---|---|
| End-to-end latency p50 | 4 s | 2 (achieve), 8 (verify under load) | ☐ |
| End-to-end latency p95 | 8 s | 2, 8 | ☐ |
| End-to-end latency p99 | 15 s | 2, 8 | ☐ |
| Session completion rate | > 75% | 1 (UX), 4 (polish) | ☐ |
| Recapture-request rate | < 20% | 1 (on-device gates), 3 (counterfactuals) | ☐ |
| API uptime | 99.9% | 11 | ☐ |

### 1.3 Business-level targets (PRD §4.3, NBFC pilot)

| Objective | Target / direction | Phase |
|---|---|---|
| Pre-qual → final disbursal conversion | Track + improve monthly | 11 |
| Acquisition cost per disbursed loan | 60–70% lower than baseline | 11 |
| Agent visit avoidance rate | Baseline → improve | 11 |
| Fraud loss rate on disbursed value | < 0.3% | 10 + 11 |
| NPS / capture-flow drop-off | Baseline → improve | 11 |

### 1.4 Hackathon judging targets (PRD §4.4)

| Criterion | What demonstrates it | Phase |
|---|---|---|
| Innovation | 12-signal stack, conformal calibration, PingCoin audio | 2, 3 |
| Technical depth | SAM 2 + Qwen2.5-VL + LightGBM + conformal, composed | 2, 3 |
| Real-world impact | ₹3.38L crore market, 60–70% acquisition cost reduction | 4 (pitch) |
| Explainability | 4-layer XAI live in demo | 3 |
| Compliance | RBI 2025 + DPDP checklist on a slide | 4 (deck) |

### 1.5 Functional Requirements coverage (PRD §8)

| FR group | Specs | Shipped in |
|---|---|---|
| FR-CAP-01 to FR-CAP-08 | Capture subsystem (camera, gates, telemetry, offline) | Phase 0 + 1 |
| FR-ASS-01 to FR-ASS-05 | Parallel workers, graceful degradation, fusion, conformal | Phases 2 + 3 |
| FR-DEC-01 to FR-DEC-04 | RBI hard-rules + ML routing + IBJA price feed + credit-line | Phase 4 |
| FR-OUT-01 to FR-OUT-03 | Result screen + 4-layer XAI + signed-URL retention | Phases 3 + 4 |
| FR-AUD-01 to FR-AUD-05 | Immutable audit log, model version trace, WORM, DPDP delete | Phase 8 |
| FR-FRD-01 to FR-FRD-05 | FAISS, EXIF, graph, liveness, fraud veto | Phases 5 + 10 |

### 1.6 Non-functional requirements (PRD §9)

| NFR | Target | Phase |
|---|---|---|
| Performance (latency budgets) | per §4.2 | 2 + 8 |
| Reliability (graceful degradation, offline queue) | full | 1 + 8 |
| Privacy & DPDP | India residency, retention, delete SLA | 8 |
| Accessibility & i18n | 12 languages at pilot, 2 at MVP | 1 (en+hi), 8 (rest) |
| Cost ceiling | ₹20–30k/mo MVP | 11 |
| Auditability | full per-decision reproducibility | 8 |

---

## 2. Contracts to Lock (Before Any Code)

Two things are frozen before Phase 0 begins. They're contracts between every component that follows.

### 2.1 The Assessment Output Schema (Pydantic, matches PRD Appendix B)

Drop this into `apps/api/app/models/schemas.py` on Day 0. Don't change it after Phase 1 without bumping `schema_version`.

```python
from datetime import datetime
from typing import Literal, Optional
from pydantic import BaseModel, Field

Routing = Literal["INSTANT", "AGENT", "RECAPTURE", "REJECT"]

class ModelVersions(BaseModel):
    vlm: str
    segmentation: str
    plated_solid: str
    fusion: str
    conformal: str

class Purity(BaseModel):
    band_low_karat: int
    band_high_karat: int
    point_estimate_karat: int
    huid_verified: bool

class Weight(BaseModel):
    manual_entry_g: float
    estimated_g: float
    band_low_g: float
    band_high_g: float
    method: Literal["depth_volume_x_density", "manual_only", "hybrid"]

class ValueINR(BaseModel):
    band_low: int
    band_high: int
    ibja_reference_date: datetime
    stone_weight_excluded_g: float

class LoanOffer(BaseModel):
    band_low_inr: int
    band_high_inr: int
    ltv_applied_pct: int
    tier: Literal["under_2_5L", "above_2_5L"]

class Confidence(BaseModel):
    score: float = Field(ge=0.0, le=1.0)
    coverage_guarantee_pct: int  # 90
    calibration_method: Literal["split_conformal", "none"]

class FraudSignals(BaseModel):
    score: float = Field(ge=0.0, le=1.0)
    triggers: list[str]

class ReasoningText(BaseModel):
    lang: str
    text: str

class SHAPFeature(BaseModel):
    feature: str
    contribution: float

class XAI(BaseModel):
    gradcam_url: Optional[str] = None
    shap_top_features: list[SHAPFeature]
    counterfactual: Optional[str] = None

class AuditTrail(BaseModel):
    trace_id: str
    input_asset_hashes: list[str]

class AssessmentResult(BaseModel):
    schema_version: str = "1.0"
    session_id: str
    timestamp_utc: datetime
    model_versions: ModelVersions
    purity: Purity
    weight: Weight
    value_inr: ValueINR
    loan_offer: LoanOffer
    confidence: Confidence
    fraud_signals: FraudSignals
    routing: Routing
    reasoning_text: ReasoningText
    xai: XAI
    audit: AuditTrail
```

### 2.2 The Stateless Assessment Endpoint

This is the contract every client (PWA, future WhatsApp, future field agent app) consumes.

```
POST /api/assess
Content-Type: application/json
Authorization: Bearer <session-token>

{
  "session_id": "uuid",
  "frames": ["https://r2.../top.jpg", "https://r2.../macro.jpg", ...],
  "video": "https://r2.../pan.mp4",
  "audio": "https://r2.../ping.wav" | null,
  "selfie": "https://r2.../selfie.jpg",
  "weight_g": 8.2,
  "reference_object": "rs10_coin",
  "lang": "hi",
  "device_metadata": { "exif": {...}, "gyro": [...] }
}

→ 200 OK
{ ...AssessmentResult... }

→ 422 (insufficient evidence — recapture required)
{ "routing": "RECAPTURE", "reasons": [...], "guidance": "...", ... }
```

**Headers locked:** `X-Trace-ID` returned on every response, logged to `audit_log`.

### 2.3 Signal worker interface

Every Celery worker conforms to:

```python
class SignalResult(BaseModel):
    signal_id: str           # "s1_huid", "s7_plated_solid", ...
    confidence: float        # the worker's own self-assessed confidence
    payload: dict            # signal-specific structured output
    error: Optional[str]     # populated on failure; fusion handles missing
    duration_ms: int
    model_version: str
```

Workers never raise. They return `error` and let the orchestrator/fusion handle missing signals. (PRD FR-ASS-02)

---

## 3. Critical Path & Parallel Tracks

```
Day 0    Day 1     Days 2–5     Week 2          Week 3            Week 4
─────────────────────────────────────────────────────────────────────────────
[Setup]→[Ph 0]──→ [Ph 1]────────→[Ph 2]─────────→[Ph 3]──────────→[Ph 4]══════ MVP DONE
        camera   capture flow   ML signals     fusion + XAI      decision +
        proof    (mocked back)  (zero-shot)    (calibrated)      demo polish
        🚧 GATE                                                    
                                                                   
                 [Demo asset sourcing — plated brass piece, real samples]
                 ←———— runs in parallel from Day 1 ————→
                 
                                                  Week 5    Week 6    Wk 7-8
─────────────────────────────────────────────────────────────────────────────
                                                  [Ph 5]───→[Ph 5]
                                                  S3,S4,    S9,S12
                                                  
                                                  [Ph 6 model training]══════════
                                                  [Ph 7 data pipeline]═══════════
                                                  ← parallel →
                                                  
                                                                          Week 9
─────────────────────────────────────────────────────────────────────────────
                                                                          [Ph 8]
                                                                          backend
                                                                          hardening
                                                                          
                                                            Week 10   Week 11-12
─────────────────────────────────────────────────────────────────────────────
                                                            [Ph 9 ┐]   [Ph 11]
                                                            [Ph 10┘]   deploy +
                                                            ←parallel→ eval
```

**Hard dependencies (do not violate):**
- Phase 0 blocks everything else.
- Phase 1 blocks Phase 2 (need real captured assets to test workers).
- Phase 2 blocks Phase 3 (need worker outputs to train fusion).
- Phase 3 blocks Phase 4 (need calibrated bands to make routing decisions).
- Phases 5, 6, 7 can run in parallel after Phase 4 — they don't share critical-path resources.
- Phase 8 blocks Phase 9 (dashboard needs hardened endpoints).
- Phase 11 ships when all targets met.

**Parallel tracks you can start Day 1 (don't delay these):**
- Sourcing the plated-brass demo piece (week 1 visit to local market).
- Recording PingCoin audio dataset (~200 samples, can collect bit by bit).
- Scraping Tanishq/Kalyan catalogs for Phase 5 FAISS index — start the scraper now, let it run.

---

## 4. Pre-Build Decisions & Day-0 Setup

### 4.1 Three decisions to lock before any code

None of them technical. Make them now or they'll thrash you for weeks.

1. **Demo persona on the whiteboard.** "Lakshmi, 52, Solapur, daughter's wedding next year, ~80g of gold" (per PRD §5.1). Every UI choice flows from her. When in doubt during a design call, ask: *"would Lakshmi understand this?"*
2. **The one sentence judges remember.** Default: *"We replaced the branch visit with 90 seconds on a phone, and the AI tells the lender exactly when to come into the branch instead."* Pick yours. Design the demo to deliver that line viscerally.
3. **The deliberate-fail demo case.** A plated brass piece the system honestly refuses (PRD §6.2). This is a product requirement, not an exception. Source it in week 1 from a local imitation-jewelry market (~₹500).

### 4.2 Accounts and infra to create on Day 0

| Item | Where | Cost |
|---|---|---|
| GitHub repo (private, monorepo) | github.com | Free |
| Cloudflare account + R2 bucket + Pages project | cloudflare.com | Free tier ample |
| Vercel account (backup frontend host) | vercel.com | Free hobby |
| Hetzner CPU node (CX22) | hetzner.com | ~₹400/mo |
| Runpod GPU pod (RTX 4090 spot) | runpod.io | Pay-per-hour, ~₹15–25k/mo at low volume |
| MSG91 / Fast2SMS | OTP | Pay-as-you-go |
| Domain + Cloudflare DNS | namecheap or similar | ~₹800/yr |
| HuggingFace account | huggingface.co | Free |
| MLflow tracking (self-host on Hetzner) | n/a | Free |

### 4.3 Day-0 commands (copy-paste)

```bash
# 1. Repo
mkdir goldeye && cd goldeye
git init -b main
mkdir -p apps/web apps/api ml/{training,synthetic,eval,models} infra/{docker,deploy} docs .github/workflows
echo "node_modules\n.env\n*.pyc\n__pycache__\n.venv\nml/models/*.bin\nml/models/*.pt" > .gitignore
echo "# GoldEye" > README.md

# 2. Frontend scaffold
cd apps/web
npm create vite@latest . -- --template react-ts
npm install
npm install -D tailwindcss postcss autoprefixer @types/node
npx tailwindcss init -p
npm install i18next react-i18next opencv-ts idb @vite-pwa/assets-generator vite-plugin-pwa
npm install lucide-react
# shadcn/ui (run after tailwind config done)
npx shadcn@latest init

# 3. Backend scaffold
cd ../api
python -m venv .venv && source .venv/bin/activate
cat > requirements.txt << 'REQS'
fastapi==0.115.0
uvicorn[standard]==0.32.0
pydantic==2.9.0
sqlalchemy==2.0.35
alembic==1.13.3
psycopg[binary]==3.2.3
redis==5.1.1
celery==5.4.0
boto3==1.35.40
python-multipart==0.0.12
httpx==0.27.2
pillow==10.4.0
numpy==2.1.2
opencv-python-headless==4.10.0.84
onnxruntime==1.19.2
mapie==0.9.1
lightgbm==4.5.0
shap==0.46.0
mlflow==2.17.0
python-dotenv==1.0.1
REQS
pip install -r requirements.txt
mkdir -p app/{routes,workers,ml,xai,decision,models,db}
touch app/main.py

# 4. Local docker-compose for dev services
cd ../../infra/docker
cat > docker-compose.yml << 'COMPOSE'
version: "3.9"
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: goldeye
      POSTGRES_PASSWORD: goldeye_dev
      POSTGRES_DB: goldeye
    ports: ["5432:5432"]
    volumes: [pgdata:/var/lib/postgresql/data]
  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]
  qdrant:
    image: qdrant/qdrant:latest
    ports: ["6333:6333"]
    volumes: [qdrant:/qdrant/storage]
  minio:
    image: minio/minio:latest
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin
    ports: ["9000:9000", "9001:9001"]
    volumes: [miniodata:/data]
volumes: { pgdata: {}, qdrant: {}, miniodata: {} }
COMPOSE
docker compose up -d

# 5. CI skeleton
cd ../../.github/workflows
cat > ci.yml << 'CI'
name: CI
on: [push, pull_request]
jobs:
  web:
    runs-on: ubuntu-latest
    defaults: { run: { working-directory: apps/web } }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - run: npm run build
  api:
    runs-on: ubuntu-latest
    defaults: { run: { working-directory: apps/api } }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: "3.11" }
      - run: pip install -r requirements.txt
      - run: python -c "import app.main"  # smoke
CI

# 6. First commit
cd ../..
git add . && git commit -m "chore: day-0 scaffold"
git remote add origin git@github.com:<you>/goldeye.git
git push -u origin main
```

### 4.4 Day-0 acceptance

- `docker compose up` brings local stack to healthy (Postgres, Redis, Qdrant, MinIO all reachable).
- Empty React app deploys to Cloudflare Pages on push to `main`.
- FastAPI `/health` returns 200 from Hetzner box, accessible over HTTPS.
- GitHub Actions runs green on the empty commit.

If any of these fail, **stop and fix before Day 1**. Phase 0 will need all of them working.

### 4.5 Day-0 risk callouts

| Risk | Symptom | Mitigation |
|---|---|---|
| Cloudflare Pages routing breaks SPAs | 404 on direct URL | Add `_redirects` with `/* /index.html 200` |
| Hetzner outbound rate-limited on first boot | Slow apt | Use a snapshot/image with stack pre-baked, or just push through |
| Docker on local laptop runs out of disk for model weights later | Pull failures | Plan for ≥40GB free, or alias model dir to external SSD |

---

## 5. Phase 0 — Camera Path Proof (Day 1)

**Goal:** Prove `getUserMedia` works reliably on iOS Safari + Android Chrome before anything else. Single biggest schedule risk in mobile web — eliminate Day 1.

**PRD references:** FR-CAP-01, FR-CAP-02.

### 5.1 Tasks

- One Vite + React screen, two buttons: "Start Camera" and "Capture".
- `getUserMedia` with `facingMode: "environment"`, `playsInline` on the `<video>` element, served strictly over HTTPS (Cloudflare Pages provides this free).
- "Capture" grabs a frame to a `<canvas>`, displays it.
- Add PWA manifest + service worker via `vite-plugin-pwa`.
- Test on three devices: your Android, a borrowed iPhone, one older budget phone (the kind judges or Lakshmi might have).

### 5.2 Starter component

```tsx
// apps/web/src/components/CameraProof.tsx
import { useRef, useState } from "react";

export function CameraProof() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [imgSrc, setImgSrc] = useState<string | null>(null);

  const start = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: 1920, height: 1080 },
      audio: false,
    });
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
    }
  };

  const capture = () => {
    const v = videoRef.current!, c = canvasRef.current!;
    c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext("2d")!.drawImage(v, 0, 0);
    setImgSrc(c.toDataURL("image/jpeg", 0.92));
  };

  return (
    <div className="p-4 space-y-3">
      <video ref={videoRef} playsInline muted className="w-full rounded-2xl" />
      <canvas ref={canvasRef} hidden />
      <div className="flex gap-2">
        <button onClick={start} className="px-4 py-2 rounded-xl bg-black text-white">Start Camera</button>
        <button onClick={capture} className="px-4 py-2 rounded-xl border">Capture</button>
      </div>
      {imgSrc && <img src={imgSrc} className="w-full rounded-2xl" />}
    </div>
  );
}
```

### 5.3 iOS gotchas to handle now (not later)

- HTTPS is mandatory.
- Camera start requires a user gesture (button tap, not auto-start).
- `playsInline` attribute on `<video>` or iOS will full-screen take over.
- `facingMode: { ideal: "environment" }` — the `ideal` qualifier prevents iOS from rejecting the constraint outright.
- Torch is not exposable via `MediaTrackConstraints` on iOS — design around it; don't rely on flash.
- iOS Safari requires a brief user interaction before `<video>.play()` will resolve — the "Start Camera" button satisfies this.

### 5.4 Acceptance for Phase 0

- ✅ Photo captures on Android Chrome.
- ✅ Photo captures on iOS Safari.
- ✅ App is installable as PWA on both ("Add to Home Screen" works).
- ✅ Photo captures on the third "budget Android" device.
- 🛑 If any device fails, **stop and fix before proceeding**. Every later phase assumes this works.

### 5.5 Risk callouts for Phase 0

| Risk | Symptom | Mitigation |
|---|---|---|
| Camera permission blocked silently | Black `<video>` with no error | Add `try/catch` around `getUserMedia`, surface error to UI |
| iOS shows "Start Capture" but ignores it | `<video>` doesn't play | Confirm `playsInline` AND `muted` AND user-gesture |
| Cloudflare Pages serves over HTTP for previews | `getUserMedia` rejects | Use the `*.pages.dev` URL (always HTTPS), not custom domain in dev |
| PWA manifest invalid | "Install" not offered | Validate at chrome://flags + use `@vite-pwa/assets-generator` |

---

## 6. Phase 1 — Capture Flow with Mocks (Days 2–5)

**Goal:** Build the entire customer UX flow end-to-end with **mocked backend responses**. Hardcoded JSON. Why mock first: lock the demo timing and visuals before any model uncertainty enters the picture. By end of Phase 1, the app runs on a real phone in under 3 minutes with a beautiful (mocked) result screen.

**PRD references:** FR-CAP-03 to FR-CAP-08, §6.1 (primary flow).

**Why this phase exists separately from Phase 2:** demoability earned this early is the safety net for everything that follows. If Phase 2's ML hits a snag, Phase 1's UX still wins on capture-quality + storytelling.

### 6.1 Frontend — capture wizard

Build the seven-step flow per PRD §6.1, in order:

1. **Welcome + language picker** — i18next with English + Hindi only at MVP (12 languages is pilot scope, not now). Selection stored in `localStorage`.
2. **DPDP consent screen** — single explicit consent, POST to `/session/consent` with timestamp.
3. **Phone OTP** — MSG91 / Fast2SMS integration. Skippable for hackathon (session-id-in-URL is acceptable).
4. **Setup screen** — voice prompt: *"Place jewelry on a plain surface next to a ₹10 coin."*
5. **Capture wizard (7 captures):**
   - Photo 1: top-down, full piece + reference coin
   - Photo 2: 45-degree angle
   - Photo 3: side view
   - Photo 4: hallmark macro (zoom guide overlay)
   - Video: 5-second pan around the piece
   - Audio (optional): 3-second PingCoin drop test
   - Selfie holding the jewelry (anti-fraud, stored separately)
6. **Review screen** — thumbnail grid, retake any single capture.
7. **Manual weight entry** — kitchen scale value, validated as 0.5–500g.

### 6.2 On-device quality gates (FR-CAP-04, FR-CAP-05)

Use **OpenCV.js** in browser. Per-capture gates that must pass before the capture is accepted:

| Gate | Check | Threshold |
|---|---|---|
| Sharpness | Laplacian variance | > 100 (calibrate empirically) |
| Exposure | Histogram analysis (mean + percentile clipping) | mean ∈ [60, 200], <2% blown highlights |
| Reference coin | Hough circle transform | Coin detected, diameter in expected pixel range |
| Subject framing | Saturation/edge density (segmentation comes later) | Jewelry > 15% of frame |

UI behavior:
- Real-time: green border when all gates pass, red with reason text when any fail.
- Voice announcement of failure reason in chosen language via Web Speech API.
- Capture button disabled until gates green.

```tsx
// apps/web/src/lib/qualityGates.ts (sketch)
import cv from "opencv-ts";

export type GateResult = { ok: boolean; reasons: string[] };

export function evaluateFrame(canvas: HTMLCanvasElement): GateResult {
  const reasons: string[] = [];
  const src = cv.imread(canvas);
  // sharpness via Laplacian variance
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  const lap = new cv.Mat();
  cv.Laplacian(gray, lap, cv.CV_64F);
  const mean = new cv.Mat(); const std = new cv.Mat();
  cv.meanStdDev(lap, mean, std);
  const sharpness = std.doubleAt(0, 0) ** 2;
  if (sharpness < 100) reasons.push("blurry");
  // ... exposure + coin detection here
  src.delete(); gray.delete(); lap.delete(); mean.delete(); std.delete();
  return { ok: reasons.length === 0, reasons };
}
```

### 6.3 Capture telemetry (FR-CAP-08)

- EXIF capture on every photo (timestamp, camera model, exposure).
- Gyroscope motion log during the 5-second video — `DeviceMotionEvent` accelerometer + gyro samples at ~60Hz, stored as JSON array. Helps replay-attack detection later.

### 6.4 Backend — session model

Postgres schema (Alembic migration, on Day 2):

```sql
CREATE TABLE session (
  id UUID PRIMARY KEY,
  user_phone TEXT,
  language TEXT NOT NULL,
  consent_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'in_progress',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  metadata JSONB DEFAULT '{}'::jsonb
);

CREATE TABLE asset (
  id UUID PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES session(id),
  type TEXT NOT NULL,  -- 'photo_top'|'photo_45'|'photo_side'|'macro'|'video'|'audio'|'selfie'
  storage_path TEXT NOT NULL,
  exif JSONB,
  gyroscope JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE consent_log (
  id UUID PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES session(id),
  version TEXT NOT NULL,
  accepted_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE audit_log (
  id BIGSERIAL PRIMARY KEY,
  session_id UUID,
  event TEXT NOT NULL,
  payload JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);
-- audit_log is APPEND-ONLY by convention; never UPDATE or DELETE
```

Endpoints (mocked responses for now):

- `POST /session/init` → `{session_id, signed_upload_urls}`
- `POST /session/upload` → chunked upload, virus scan stub, MinIO/R2 write
- `POST /session/finalize` → returns mocked `AssessmentResult` (the schema from §2.1)

### 6.5 Resilience (FR-CAP-07)

- Chunked upload with resumability via `tus-js-client` or custom range-PUT.
- IndexedDB queue: if upload fails, store locally, retry on reconnect (`navigator.onLine` listener).
- "Captured offline, will sync" badge if user goes offline mid-session.

### 6.6 Acceptance for Phase 1

- ✅ A real human (not you) completes the full capture flow on a real phone in < 3 minutes.
- ✅ All seven captures stored in R2 with EXIF.
- ✅ Final mocked result screen renders the schema beautifully.
- ✅ Demo runs end-to-end on Android Chrome and iOS Safari.
- ✅ Offline test: airplane-mode mid-session, reconnect, session completes successfully.

This phase alone is a defensible demo. If everything after fails, you still have a working capture story.

### 6.7 Risk callouts for Phase 1

| Risk | Symptom | Mitigation |
|---|---|---|
| OpenCV.js initial load is slow on 4G (~8MB) | App appears stuck on first launch | Lazy-load behind a splash; preload during welcome screen |
| Browser kills idle MediaStream after backgrounding | Black video on resume | Listen for `visibilitychange`, restart stream |
| Audio capture permissions block by default on iOS | PingCoin step fails silently | Request audio permission only when user opts into the test |
| Gyroscope API requires explicit permission on iOS 13+ | Empty motion log | Call `DeviceMotionEvent.requestPermission()` on user gesture |

---

## 7. Phase 2 — Core ML Signals (Week 2)

**Goal:** Replace the mocked assessment response with real signal workers. Use zero-shot / pretrained models everywhere; no fine-tuning yet. The bar is "all 8 active signals produce structured output and the worst-case latency is bounded."

**PRD references:** FR-ASS-01 to FR-ASS-05; signals S1, S2, S5, S6, S7, S8, S10, S11. (S3, S4, S9, S12 are pilot scope, deferred to Phase 5.)

### 7.1 Worker architecture

Each signal is an independent Celery task. Orchestrator fans out, collects, fuses.

```python
# apps/api/app/workers/__init__.py
from .s1_huid import run as s1
from .s2_hallmark import run as s2
from .s5_segmentation import run as s5
from .s6_dimensions import run as s6
from .s7_plated_solid import run as s7
from .s8_vlm import run as s8
from .s10_telemetry import run as s10
from .s11_audio import run as s11

ACTIVE_WORKERS = {
    "s1_huid_ocr": s1,
    "s2_hallmark_visual": s2,
    "s5_segmentation": s5,
    "s6_dimensions": s6,
    "s7_plated_solid": s7,
    "s8_vlm_holistic": s8,
    "s10_telemetry": s10,
    "s11_audio_pingcoin": s11,
}
```

Each worker returns a `SignalResult` (schema in §2.3). On exception → `error` field populated, fusion handles missing. Never raises.

### 7.2 S1 + S2 — Hallmark OCR + visual integrity (the must-ship signal)

Pipeline:
1. **Crop** hallmark macro using Grounding DINO 1.5 Edge with prompt `"small engraved stamp on metal"`. Returns bounding box.
2. **OCR** the crop with PaddleOCR (handles small text + curved surfaces well on its own).
3. **Backup OCR** via Qwen2.5-VL-7B with this exact prompt:

```
You are reading a BIS hallmark on a piece of Indian gold jewelry.
Return ONLY a JSON object, no preamble. Schema:
{
  "bis_logo_present": boolean,
  "purity_mark": string | null,    // e.g. "22K916", "750"
  "huid_code": string | null,       // 6 alphanumeric chars
  "jeweller_id": string | null,
  "stamp_appearance": "laser_engraved" | "hand_stamped" | "printed_sticker" | "unclear"
}
If uncertain about a field, use null. Never guess.
```

4. For hackathon: skip live BIS portal lookup; trust the claimed text. (Pilot scope per PRD §7.3.)
5. **Visual integrity (S2):** the `stamp_appearance` field above is the integrity signal — `printed_sticker` is a fraud flag.

```python
# apps/api/app/workers/s1_huid.py (sketch)
def run(session_id: str, macro_url: str) -> SignalResult:
    t0 = time.time()
    try:
        crop = grounding_dino.detect_and_crop(macro_url, prompt="small engraved stamp on metal")
        ocr = paddleocr.read(crop)
        if ocr.confidence < 0.5:
            ocr = vlm.read_hallmark_json(crop)  # fallback
        return SignalResult(
            signal_id="s1_huid",
            confidence=ocr.confidence,
            payload={
                "huid_code": ocr.huid_code,
                "purity_mark": ocr.purity_mark,
                "bis_logo_present": ocr.bis_logo_present,
                "stamp_appearance": ocr.stamp_appearance,
            },
            error=None,
            duration_ms=int((time.time()-t0)*1000),
            model_version="paddleocr-2.7+gd1.5",
        )
    except Exception as e:
        return SignalResult(signal_id="s1_huid", confidence=0.0, payload={}, error=str(e), duration_ms=int((time.time()-t0)*1000), model_version="paddleocr-2.7+gd1.5")
```

### 7.3 S5 + S6 — Segmentation + dimensions

- **SAM 2 (Hiera-Tiny)** segments jewelry from background and separates stones from metal.
- **Grounding DINO 1.5 Edge** locates the ₹10 reference coin (known diameter: 27 mm).
- Pixel-to-mm scale derived from coin's pixel diameter.
- **Depth Anything V2 Small** monocular depth estimation → volume estimate from multi-view (use the 5-second video pan, sample 5 frames).
- Volume × density (look up by claimed karat, fall back to 22K average if unknown) → estimated weight.
- Compare estimated weight against manual scale entry → cross-check signal.

Densities (g/cm³): 24K = 19.32, 22K = 17.7–17.8, 18K = 15.5, 14K = 13.0, plated brass = 8.5.

### 7.4 S7 — Plated vs. solid (zero-shot for MVP)

Hackathon: Qwen2.5-VL prompt asking for plated/solid judgment based on visible wear, edge sheen, weight-to-volume sanity, color uniformity. Returns probability.

Pilot (Phase 6): replace with fine-tuned ConvNeXt-V2 head (target AUC > 0.95 per PRD §4.1).

### 7.5 S8 — VLM holistic reasoner

Qwen2.5-VL-7B served via vLLM with FP8 quantization on the Runpod GPU. One prompt that takes all 4 photos + the macro + the segmentation overlay and returns:

```json
{
  "item_type": "ring|bangle|chain|earring|pendant|necklace|other",
  "estimated_karat_band": [low, high],
  "stones_present": true,
  "stones_estimated_carat_total": 0.0,
  "visible_wear": "low|medium|high",
  "concerns": ["..."],
  "confidence": 0.0
}
```

Validate JSON output with the matching Pydantic model; retry once with stricter prompt if invalid.

### 7.6 S10 — EXIF + telemetry

- EXIF timestamp vs. session timestamp → replay detection (gap > 1 hour is suspicious).
- Camera fingerprint (make, model, focal length) consistent across all captures.
- Gyroscope motion log during video must be non-zero and varied (defeats injection of static images).

### 7.7 S11 — PingCoin audio (the wow-feature)

Data collection (week 2 — runs in parallel with model work):

- ~200 self-recorded samples:
  - Real solid pieces (borrow from family, ₹500/hr from a friendly jeweler — PRD §12 budget)
  - Plated/imitation pieces (₹500 budget at local market — also the deliberate-fail demo piece)
  - Both dropped from ~3 cm onto the same hard surface (wooden table)

Model:

- Convert audio → log-mel spectrogram (128 mels, 64 frames, ~3 s window).
- 4-layer 2D CNN → GAP → 64-dim → 3-class softmax (solid / plated / noise). ~500 KB after ONNX export.
- Train on Kaggle free T4 (30 hr/week budget). Should converge in < 2 hours.
- Target: AUC > 0.85 on held-out ~50 samples (PRD §4.1).
- **Make optional in UX** — some users hesitate to drop their jewelry. Better skip than lose session.

### 7.8 Inference serving topology

- VLM (Qwen2.5-VL-7B): vLLM server on Runpod RTX 4090, FP8 quantization.
- Specialists (SAM 2, Grounding DINO, Depth Anything V2, audio CNN): ONNX Runtime + Triton on the same GPU pod.
- Local dev: smaller variants (SAM 2 Hiera-Tiny, Depth Anything V2 Small) work on CPU at acceptable speed for non-VLM signals; VLM hits the Runpod pod.
- Health-check + warm-up cron: keeps vLLM model loaded; first-request cold-start can take 30s otherwise.

### 7.9 Acceptance for Phase 2

- ✅ Real assessment response returned end-to-end on a real phone capture in < 15 seconds (p95 target: 8s, allow 15s in dev — PRD §4.2).
- ✅ All 8 active signals produce structured outputs.
- ✅ Missing-signal test passes: kill any one worker process, system still returns a (lower-confidence) result.
- ✅ Honest-fail demo case (plated brass) returns confidence < 0.5.
- ✅ S1 hallmark OCR achieves > 90% character accuracy on a self-collected eval set of ~50 hallmark macros (target 97% comes in Phase 6).

### 7.10 Risk callouts for Phase 2

| Risk | Symptom | Mitigation |
|---|---|---|
| Runpod spot instance preempted mid-demo | Inference 503s | Cache last-good response per session; warm secondary pod for demo day |
| Qwen JSON output not parseable | Random fields, prose around JSON | Use stricter system prompt + retry once; fall back to regex extraction |
| Depth Anything V2 wildly off on shiny gold | Volume estimate 5x truth | Cap weight-from-volume contribution in fusion; manual entry dominates |
| Hallmark macro out of focus | OCR returns garbage | Tighten Phase 1 sharpness gate for the macro step; recapture prompt |
| Audio CNN overfits 200 samples | High val AUC, fails on field audio | Treat MVP audio as demo-only; collect more for Phase 6 |

---

## 8. Phase 3 — Fusion, Calibration & XAI (Week 3)

**Goal:** Combine signals into the calibrated bands the PRD promises. Ship the four-layer explainability that wins judging criteria.

**PRD references:** FR-ASS-03, FR-ASS-04, FR-OUT-01, FR-OUT-02. Targets: PRD §4.1 (90% conformal coverage, ECE < 0.05).

### 8.1 BlenderProc minimal synthetic dataset

For MVP, ~10k synthetic images is enough — full ~1M comes in pilot (Phase 7).

- Parametric jewelry meshes: ring, bangle, chain, earring (4 categories cover ~80% of real submissions).
- Karat-dependent BRDF: 24K / 22K / 20K / 18K / 14K / plated brass / silver-plated. Tabulated CIELAB shifts per karat.
- HDRI lighting: 5–10 environment maps (indoor warm, indoor cool, daylight, evening, fluorescent).
- Camera poses: top-down, 45°, side, macro on hallmark.
- Render at 384×384, save with full label JSON (karat, weight, item type, stone count).
- Run on Runpod GPU pod overnight; target 10k images in ~12 hours.

### 8.2 LightGBM fusion model

Features (~50 columns) extracted from worker outputs:

| Source | Features |
|---|---|
| S1 | huid_present (bool), claimed_karat (categorical), stamp_appearance (one-hot) |
| S2 | hallmark_quality_score (float) |
| S5/S6 | estimated_weight_g, weight_consistency_with_manual (Δ%), volume_cm3, item_type (one-hot) |
| S7 | plated_probability (float) |
| S8 | vlm_estimated_karat_band_low, _high, vlm_concerns_count, vlm_confidence |
| S10 | telemetry_anomaly_score |
| S11 | audio_solid_probability (or null if skipped) |

Targets (multi-output):

- `purity_class` (24 / 22 / 20 / 18 / 14 / plated)
- `weight_g` (regression, log-transform)
- `value_inr_low`, `value_inr_high`
- `loan_inr_low`, `loan_inr_high`
- `fraud_probability`

Train on synthetic (10k) + scraped catalog (Tanishq/Kalyan, weak labels) + adversarial set (~1k hard negatives).

Hyperparam tuning via Optuna (~50 trials for MVP, 100+ for pilot). Hold out a test set you never touch during dev.

### 8.3 Conformal wrapper (the differentiator)

**MAPIE library**, split conformal:

- 70% train / 15% calibration / 15% test.
- α = 0.1 → 90% nominal coverage.
- Verify empirical coverage on test holds within ±2% of nominal (PRD §4.1).
- Output `[band_low, band_high]` with mathematical guarantee — the line that wins risk-team trust.

```python
from mapie.regression import MapieRegressor

mapie = MapieRegressor(estimator=lgbm_value, method="plus", cv=5)
mapie.fit(X_train, y_train)
y_pred, y_pis = mapie.predict(X_test, alpha=0.1)
# y_pis[:, 0, 0] = lower bound, y_pis[:, 1, 0] = upper bound
```

### 8.4 Four-layer XAI (PRD FR-OUT-02)

**Layer 1 — Visual (Grad-CAM++).** `pytorch-grad-cam`:
- Heatmap from ConvNeXt-V2 plated/solid head (Phase 6) or from Qwen2.5-VL cross-attention (MVP fallback).
- Overlay on original photo at 60% alpha. Save to R2, serve via signed URL.

**Layer 2 — Tabular (SHAP).** `shap.TreeExplainer` on LightGBM:
- Per-prediction Shapley values → bar chart.
- Positive contributions in green, negative in red. Top 5 features only, for readability.

**Layer 3 — Customer text.** Template-based natural language:
- Top 3–4 signals → human-readable bullets in chosen language.
- Example: *"Pre-approved ₹47,000 because: ✓ BIS hallmark verified ✓ Weight matches estimate ✓ No fraud signals detected."*
- Pre-translate templates per language (English + Hindi at MVP).

**Layer 4 — Counterfactual.** Re-run fusion with one input perturbed; identify the input that, if better, would tighten the band most. Convert to recapture instruction: *"If the hallmark photo were sharper, your estimated band would tighten by ₹X."*

### 8.5 Acceptance for Phase 3

- ✅ Conformal coverage measured at 90% ± 2% on held-out test.
- ✅ Final assessment JSON matches §2.1 schema exactly (Pydantic round-trip).
- ✅ All four XAI layers visible in customer result screen + risk-officer view.
- ✅ Demo shows the deliberate-fail case with honest "confidence 38%, recommend in-branch verification."
- ✅ ECE on calibration set < 0.05.

### 8.6 Risk callouts for Phase 3

| Risk | Symptom | Mitigation |
|---|---|---|
| Conformal coverage drifts on real data after MVP | 80% empirical instead of 90% | Re-calibrate after first 100 real sessions; alert on drift |
| SHAP TreeExplainer slow per-request (>500ms) | p95 budget blown | Pre-compute global SHAP, do per-request only on demand for risk-officer view |
| BlenderProc renders too uniform → fusion overfits | High train AUC, poor real-world | Diverse HDRIs, randomize camera intrinsics, mix with scraped catalog |
| Counterfactual generation expensive | Latency exceeds budget | Generate async after the result page; show "improving your estimate..." spinner |

---

## 9. Phase 4 — Decision Engine, Polish & Demo (Week 4)

**Goal:** Full demo-ready product. Decision routing, RBI compliance hard-rules, polished UX, demo rehearsal.

**PRD references:** FR-DEC-01 to FR-DEC-04, FR-OUT-01, §13.1 (RBI rules).

### 9.1 Decision engine (two layers, in order)

**Layer 1 — Hard rules (RBI compliance, FR-DEC-01):**

```python
def apply_rbi_rules(purity_karat, weight_g, ibja_30d_avg, ibja_yesterday) -> dict:
    if weight_g > 1000:
        return {"reject_reason": "exceeds_1kg_per_applicant"}
    price_per_g = min(ibja_30d_avg, ibja_yesterday) * (purity_karat / 24)
    value_inr = weight_g * price_per_g
    ltv = 0.85 if value_inr * 0.75 < 250_000 else 0.75
    loan_inr = value_inr * ltv
    tier = "under_2_5L" if loan_inr < 250_000 else "above_2_5L"
    return {"value_inr": value_inr, "loan_inr": loan_inr, "ltv_pct": int(ltv*100), "tier": tier}
```

Stones excluded — segmentation already separates them in Phase 2.

**Layer 2 — ML routing (FR-DEC-02):**

| Bucket | Conditions |
|---|---|
| **INSTANT** | confidence > 0.85 AND fraud_score < 0.05 AND loan_amount < ₹50k AND HUID verified |
| **AGENT** | confidence 0.6–0.85 OR loan_amount > ₹50k OR HUID missing-but-otherwise-clean |
| **RECAPTURE** | any signal returns "low quality" with recoverable cause |
| **REJECT** | fraud_score > 0.7 OR multiple fraud signals |

### 9.2 IBJA price feed (FR-DEC-03)

- Hourly cron pulls IBJA daily price.
- Cache last-known-good. If feed fails > 24h, alert and use last-known-good with a banner.
- Store full historical prices in Postgres for the 30-day-avg calc.

### 9.3 UX polish

- Landing screen with NBFC pitch ("90 seconds. Your phone. Honest answer.")
- Loading screens with voice prompts in chosen language.
- Result screen: bands draw in animated, confidence number counts up.
- "Try it" QR code for the demo poster.
- Honest-failure flow: red/orange palette for low-confidence cases, never red-bad-bad. Framing: *"we can't be confident enough — let's verify in person"* (FR-OUT-01, PRD §6.2).

### 9.4 Demo day playbook

- **Hardware:** phone hotspot on demo phone, second phone as backup hotspot, travel router pre-configured if possible.
- **Backup plan:** pre-recorded video of complete flow, queued to run if live demo fails.
- **Cached fallback:** last successful demo response cached, served transparently if API call fails (small "using cached analysis" toast — honest, not embarrassing).
- **Backup VLM:** second Qwen API key on a different account, OR Groq + Llama 3.3 8B as plain-text fallback for non-multimodal turns.
- **Three judge personas, three openers:**
  - *Skeptical fintech VC:* lead with ₹3.38L crore market, 60–70% acquisition cost reduction, RBI compliance.
  - *ML engineer:* lead with 12-signal architecture, conformal calibration, four-layer XAI.
  - *Social impact judge:* lead with Lakshmi's persona, financial inclusion in tier-3/4, "literacy isn't a prerequisite for credit."
- **Rehearse the 90-second demo five times** on different phones. Find failure modes before judges do.

### 9.5 Pitch deck (one slide each, max 8 slides)

1. Problem (Lakshmi + the ₹300–800 acquisition cost)
2. Solution (12-signal stack, one diagram)
3. Demo (live QR, deliberate-fail story)
4. Tech (model stack, architecture)
5. Compliance (RBI 2025 + DPDP checklist)
6. Innovations (PingCoin, conformal, HUID lane, FAISS, credit line, WhatsApp roadmap)
7. Business (acquisition cost reduction, agent avoidance, fraud loss target)
8. Roadmap (4 weeks → 12 weeks → pilot → scale)

### 9.6 Acceptance for Phase 4 (= Hackathon MVP done)

- ✅ All PRD §4.4 hackathon judging targets demonstrably met.
- ✅ 90-second demo lands in any of the three judge-persona openers.
- ✅ Honest-fail case lands the "we don't lie" moment.
- ✅ QR code on poster takes any judge from zero to result in under 3 minutes.
- ✅ Backup video ready in case wifi dies.
- ✅ Final assessment JSON validates against the Pydantic schema for every test session.

### 9.7 Risk callouts for Phase 4

| Risk | Symptom | Mitigation |
|---|---|---|
| Wifi at venue is unreliable | Live demo stalls | Phone hotspot + cached fallback + recorded backup video |
| Judge picks the deliberate-fail piece by accident | Confidence 38% on first try | Have them pick a real one first; the fail case is the *second* pass |
| 90 seconds bleeds to 3 minutes | Judges lose attention | Cut anything unrelated to the wedge; rehearse with a stopwatch |
| Demo phone battery dies | Hard fail | Charge to 100%, low-power mode, second phone primed |

---

## End of Hackathon MVP Path

Above gets you to a winnable hackathon demo. Everything below is the path from MVP to NBFC pilot v1.

---

## 10. Phase 5 — Cut Signals: S3, S4, S9, S12 (Weeks 5–6)

**Goal:** Layer in the four signals deferred from MVP. Each is a focused 2–3 day sub-project.

### 10.1 S3 — CIELAB color analysis

- White-balance the photos using ₹10 coin's known L*a*b* color.
- Extract average L*a*b* values from segmented metal regions (use S5 mask).
- Compute ΔE distance to tabulated karat-color centroids (24K yellow, 22K, 18K rose, etc.).
- Output: per-photo karat probability vector.

### 10.2 S4 — Specular reflectance signature

- 5-second video pan: how do highlights move across the surface?
- Per-frame Fresnel-style analysis: gold has a characteristic specular falloff distinct from plated brass.
- Frequency-domain analysis of pixel intensity in bright spots over time.
- Output: metal-vs-dielectric score (0–1).

### 10.3 S9 — Reverse-catalog FAISS defense

- Scrape Tanishq, Kalyan, Malabar, Bluestone catalogs (~50k–200k jewelry photos). **Start scraping Day 1** so it's done by Phase 5.
- Embed each with EVA-02-Large → 1024-dim vector → Qdrant index.
- Per session: embed customer photo, query top-10. If cosine > 0.92, flag as catalog match (likely stock-photo fraud).
- Output: catalog_match_score, top_match_url, top_match_score.

### 10.4 S12 — Cross-application graph signal

```sql
CREATE TABLE applicant_graph (
  huid TEXT,
  photo_phash TEXT,  -- perceptual hash
  applicant_phone TEXT,
  session_id UUID,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX ON applicant_graph(huid);
CREATE INDEX ON applicant_graph(photo_phash);
```

- New session: same HUID with different applicant phone → fraud-graph hit.
- Same `phash` across sessions → photo reuse signal.
- Output: graph_anomaly_score, related_sessions[].

### 10.5 Acceptance for Phase 5

- ✅ All 12 signals running on every session.
- ✅ Fusion model retrained with new feature columns.
- ✅ Conformal coverage still holds 90% ± 2%.
- ✅ Fraud detection precision @ recall 0.80 measurably improved (target > 0.99 per PRD §4.1).

---

## 11. Phase 6 — Model Training (Weeks 5–8, parallel with Phase 5)

**Goal:** Replace zero-shot models with fine-tuned heads where it pays off.

### 11.1 Model 1 — ConvNeXt-V2 plated/solid head

- Start from `facebook/convnextv2-base-22k-224`.
- Two-stage training:
  - Stage 1: pre-train on 1M synthetic at 224×224 (5 epochs, AdamW, lr=1e-4)
  - Stage 2: fine-tune on 50k real catalog + 1k adversarial at 384×384 (3 epochs, lr=1e-5)
- Augmentations: TrivialAugment, MixUp 0.2, CutMix 0.2, RandomErasing 0.1.
- Loss: focal loss (γ=2) due to class imbalance.
- Metrics: AUC, F1, precision @ high recall, ECE.
- **Target: AUC > 0.95** (PRD §4.1).

### 11.2 Model 2 — PingCoin audio CNN (production version)

- Re-train on full collected dataset (target ~5k samples by pilot start).
- Add SpecAugment + mixup augmentation.
- Convert to ONNX → ~500 KB.
- **Target: AUC > 0.85** (PRD §4.1).

### 11.3 Model 3 — Qwen2.5-VL fine-tune (optional)

- Only if 7B base isn't accurate enough on hallmark OCR (benchmark first).
- LoRA fine-tune on ~5k labeled (image, JSON-output) pairs.
- HuggingFace `peft` + `trl` SFTTrainer.
- Eval: JSON validity rate (target 95%), HUID-format OCR accuracy (target 97%, PRD §4.1).

### 11.4 Model 4 — LightGBM fusion (production version)

- Retrain with full feature set including S3, S4, S9, S12.
- Optuna 100+ trials.
- Held-out test set never touched during dev.

### 11.5 Model 5 — Conformal wrapper (verified)

- Re-calibrate on the new fusion model.
- Verify empirical coverage on held-out test → 90% ± 2%.

### 11.6 MLOps

- Every trained model registered in MLflow with version tag.
- DVC tracks dataset versions.
- Each model version pinned in production via config; no silent updates.
- Shadow deployment + canary (1% → 10% → 100%) for every model update.

---

## 12. Phase 7 — Full Data Pipeline (Weeks 5–8)

**Goal:** Build the dataset that becomes the long-term moat. PRD §12 lays out the strategy.

### 12.1 Public + scraped bootstrap (Week 5)
- HuggingFace `sidd707/jewelry-design-dataset` (~6,100 images).
- OrnAsia (1,088 South-Asian ornaments, fine-grained classes).
- Scrape Tanishq, Kalyan, Malabar, Bluestone with `robots.txt` respect and rate limits. Each catalog row gives weakly-labelled purity + weight + price.

### 12.2 BlenderProc full synthetic pipeline (Weeks 5–7)
- Expand from MVP's 10k to 1M images at 224 / 384 px.
- Add stone variations, clasps, engraving overlays.
- Adversarial-aware: for every "real" karat, render a "plated" version with same geometry.

### 12.3 Adversarial set (Weeks 6–7)
- ~50 imitation pieces from local jewelry markets (₹500 each = ₹25k budget).
- Real pieces from a friendly jeweler (₹500/hr × 20 hrs = ₹10k).
- Photograph each in 8 conditions (lighting × surface).
- Result: ~1k hard-negative cases that look real.

### 12.4 Pilot ground truth (Week 8 onward)
- Field-agent flow (Phase 9) captures XRF + final loan disbursement.
- Each becomes a gold-standard labeled record.
- Target: 50k+ professionally-labeled examples after 6 months — this is the moat.

### 12.5 Active learning loop
- Conformal-band-width = uncertainty signal.
- Wide-band cases auto-flagged for human relabel via Label Studio.
- Re-train monthly.

---

## 13. Phase 8 — Backend Hardening & Standard API (Week 9)

**Goal:** The stateless `/api/assess` endpoint is rock-solid, multi-client ready (PWA today, WhatsApp next phase).

### 13.1 Standard endpoint hardening

- Rate-limiting (per-session and per-phone).
- Request schema validation with Pydantic; reject malformed early.
- Idempotency keys on `/session/finalize`.
- p95 latency target enforced via SLOs in Prometheus.

### 13.2 FR-AUD-01 to FR-AUD-05 implementation

- Every API call → immutable Postgres `audit_log` (already in §6.4).
- Every model decision → `decision_log` with model_version, input_asset_hashes, full output JSON.
- R2 bucket policy set to WORM (object-lock retention).
- DPDP delete endpoint → cascade delete + confirmation log entry.
- All processing in India region.

### 13.3 Drift monitoring (Evidently AI)
- Daily PSI computation on input feature distributions.
- PSI > 0.2 alert → triggers retrain.
- Daily empirical conformal coverage check.

### 13.4 Acceptance for Phase 8
- ✅ Same `/api/assess` endpoint serves PWA today; ready for WhatsApp tomorrow.
- ✅ Audit log queryable by NBFC for any session via `trace_id`.
- ✅ DPDP delete tested end-to-end with cascade verification.
- ✅ p95 latency holds < 8s under 50 concurrent sessions.

---

## 14. Phase 9 — NBFC Dashboard & Field Agent Flow (Week 10)

**Goal:** Lender-side surfaces. Risk officer view + agent feedback loop.

### 14.1 NBFC risk officer dashboard (PRD §6.3, FR-OUT-02)

Per-session view:
- All captures (photos, video player, audio waveform, selfie).
- Segmentation overlay.
- Grad-CAM++ heatmap.
- SHAP feature attribution bar chart.
- Customer reasoning text in original language + English translation.
- Counterfactual ("if X were better, band would tighten by ₹Y").
- Full audit log scroll.
- Three actions: approve agent dispatch / request recapture (with reason) / decline.
- Every action immutably logged for RBI audit.

### 14.2 Field agent flow (PRD §6.4)
- Mobile-friendly PWA with NBFC employee auth.
- Receives dispatch with customer's pre-qual band.
- On-site, captures XRF reading + actual scale weight + final loan amount.
- Submits → flows back as labeled ground truth into active-learning pipeline.

---

## 15. Phase 10 — Fraud Hardening Sprint (Week 10, parallel)

**Goal:** Fraud as its own work-stream. Lender trust hinges on this. PRD §13.3 enumerates the surfaces.

| Surface | Defense |
|---|---|
| Plated jewelry with real hallmark | S7 + S11 + density check (S6 vs. manual entry) |
| Stock-photo submission | S9 reverse-catalog FAISS |
| Photo-of-photo / replay | S10 EXIF + selfie-with-jewelry liveness (MediaPipe face + hand-on-jewelry pose) |
| Identity reuse / ring fraud | S12 cross-application graph |
| Appraisal-doc spoofing | Structural rule: `/api/assess` only accepts jewelry captures, never appraisal docs |
| Tungsten-core counterfeits | Routed to low-confidence — we don't pretend to detect what we cannot |

Adversarial pen-test every release: have a teammate try to game the system, log every successful spoof, add as a hard-negative to training set.

---

## 16. Phase 11 — Deploy, Eval & Iterate (Weeks 11–12)

**Goal:** Production-grade infra at the cost ceiling, evaluation harness, weekly improvement cadence.

### 16.1 Deployment topology

| Component | Where | Cost |
|---|---|---|
| Frontend PWA | Cloudflare Pages | Free |
| FastAPI + Celery workers | Hetzner CX22 | ~₹400/mo |
| Postgres + Redis + Qdrant | Same Hetzner box | Included |
| Object storage | Cloudflare R2 (India) | ~₹500/mo for MVP volume |
| GPU inference | Runpod RTX 4090 spot | ~₹15–25k/mo at low volume |
| Monitoring | Prometheus + Grafana on Hetzner | Free |
| **Total MVP infra** | | **₹20–30k/mo for first 5k sessions** (PRD §9.5) |

Production hardening before Phase 11 close:
- TLS + Caddy auto-renewal verified.
- Postgres backups (daily, 7-day retention) tested with restore.
- R2 bucket replication to a second region.
- Runpod warm-pod failover script.

### 16.2 Evaluation harness — tracks all PRD §4 metrics weekly

**Model-level:** OCR accuracy, item F1, conformal coverage, weight MAPE, plated/solid AUC, fraud P@R, audio AUC, ECE.

**System-level:** p50/p95/p99 latency, completion rate, recapture rate, uptime.

**Business-level:** pre-qual → disbursal, acquisition cost, agent avoidance, fraud loss, NPS.

### 16.3 Continuous improvement cadence
- Weekly model retrain on new pilot data.
- Monthly evaluation report to NBFC partner.
- Adversarial pen-test every release.
- User feedback panel (10–20 users) every two weeks.

### 16.4 Acceptance for Phase 11 (= Pilot v1 done)
- ✅ All PRD §4.1, §4.2 numerical targets met on held-out test set.
- ✅ ₹20–30k/mo cost ceiling holds under MVP volume.
- ✅ One NBFC partner pilot live with real users getting pre-qualified.
- ✅ Drift monitoring catches and alerts on out-of-distribution input.

---

## 17. Repo Structure (Final)

```
goldeye/
├── apps/
│   ├── web/                          # React PWA mobile web app
│   │   ├── src/
│   │   │   ├── pages/
│   │   │   │   ├── Welcome.tsx
│   │   │   │   ├── Consent.tsx
│   │   │   │   ├── OTP.tsx
│   │   │   │   ├── CaptureFlow/      # 7-step wizard
│   │   │   │   ├── Processing.tsx
│   │   │   │   └── Result.tsx
│   │   │   ├── components/
│   │   │   │   ├── Camera.tsx
│   │   │   │   ├── QualityCheck.tsx
│   │   │   │   ├── PingCoinRecorder.tsx
│   │   │   │   ├── XAIView.tsx
│   │   │   │   └── ...
│   │   │   ├── hooks/
│   │   │   ├── i18n/                 # 12 language files (2 at MVP)
│   │   │   ├── lib/
│   │   │   │   ├── opencv.ts         # OpenCV.js wrapper
│   │   │   │   ├── audio.ts          # MediaRecorder + FFT prep
│   │   │   │   ├── upload.ts         # chunked upload + IndexedDB queue
│   │   │   │   └── qualityGates.ts   # on-device gates
│   │   │   └── App.tsx
│   │   ├── public/
│   │   │   └── voice/                # Pre-recorded voice prompts (fallback)
│   │   ├── vite.config.ts
│   │   └── package.json
│   │
│   └── api/                          # FastAPI backend
│       ├── app/
│       │   ├── routes/
│       │   │   ├── session.py
│       │   │   ├── assess.py         # the stateless endpoint
│       │   │   ├── webhook.py
│       │   │   └── feedback.py
│       │   ├── workers/              # Celery tasks (one per signal)
│       │   │   ├── s1_huid.py
│       │   │   ├── s2_hallmark.py
│       │   │   ├── s3_color.py
│       │   │   ├── s4_specular.py
│       │   │   ├── s5_segmentation.py
│       │   │   ├── s6_dimensions.py
│       │   │   ├── s7_plated_solid.py
│       │   │   ├── s8_vlm.py
│       │   │   ├── s9_reverse_catalog.py
│       │   │   ├── s10_telemetry.py
│       │   │   ├── s11_audio.py
│       │   │   ├── s12_graph.py
│       │   │   └── fusion.py
│       │   ├── ml/
│       │   │   ├── vlm.py            # Qwen2.5-VL client
│       │   │   ├── sam.py
│       │   │   ├── grounding_dino.py
│       │   │   ├── depth.py
│       │   │   ├── convnext.py
│       │   │   ├── audio_cnn.py
│       │   │   └── faiss_index.py
│       │   ├── xai/
│       │   │   ├── gradcam.py
│       │   │   ├── shap_explainer.py
│       │   │   ├── text_generator.py
│       │   │   └── counterfactual.py
│       │   ├── decision/
│       │   │   ├── rules.py          # RBI compliance hard-rules
│       │   │   └── routing.py        # ML routing (INSTANT/AGENT/...)
│       │   ├── models/               # Pydantic schemas (output JSON contract)
│       │   │   └── schemas.py        # AssessmentResult, SignalResult, etc.
│       │   ├── db/                   # SQLAlchemy + Alembic migrations
│       │   └── main.py
│       ├── tests/
│       └── requirements.txt
│
├── ml/
│   ├── training/
│   │   ├── train_convnext.py
│   │   ├── train_audio_cnn.py
│   │   ├── train_lgbm_fusion.py
│   │   └── lora_qwen_vl.py           # optional, Phase 6
│   ├── synthetic/
│   │   ├── blenderproc_pipeline.py
│   │   ├── meshes/                   # parametric jewelry assets
│   │   ├── hdris/                    # lighting environments
│   │   └── render.py
│   ├── eval/
│   │   ├── conformal_coverage.ipynb
│   │   ├── ece_calibration.ipynb
│   │   └── drift_psi.ipynb
│   └── models/                       # weights + configs (DVC-tracked)
│
├── infra/
│   ├── docker/
│   │   └── docker-compose.yml
│   └── deploy/
│       ├── Caddyfile
│       └── runpod_pod_spec.yaml
│
├── docs/
│   ├── PRD.md                        # the source of truth for what + why
│   └── implementation_plan.md        # this document
│
├── .github/
│   └── workflows/
│       ├── ci.yml
│       └── deploy.yml
│
└── README.md
```

---

## 18. Decision Log — Architectural Choices Already Made

These are settled. Don't re-litigate during the build.

| Decision | Choice | Why |
|---|---|---|
| Frontend | React PWA, no native app | Reach + zero-install + same backend serves WhatsApp later |
| Mobile capture | `getUserMedia` + on-device OpenCV.js gates | Free, fast, works on slow networks |
| Backend | FastAPI + Celery + Redis | Python ML ecosystem, async fan-out is straightforward |
| Database | Postgres 15+ | Audit-friendly, JSONB for flexible signal payloads |
| Object storage | Cloudflare R2 | Cheap egress, India region, WORM-capable |
| Vector DB | Qdrant | Open-source, fast FAISS-equivalent for catalog search |
| VLM | Qwen2.5-VL-7B (Apache 2.0) | SOTA OCR, multilingual, fits on one L4/4090, no per-call cost |
| Segmentation | SAM 2 Hiera-Tiny | ~30ms, separates jewelry/stones/bg |
| Detection | Grounding DINO 1.5 Edge | Zero-shot hallmark + coin |
| Depth | Depth Anything V2 Small | Volume estimation for weight prior |
| Plated/solid | ConvNeXt-V2-Base, fine-tuned | Fast (~10ms), AUC > 0.95 achievable |
| Embeddings | EVA-02-Large | Reverse-image search |
| Fusion | LightGBM | Auditable, fast, SHAP-friendly |
| Calibration | MAPIE split conformal | Statistical guarantee with no retraining |
| XAI | Grad-CAM++ + SHAP + templated text + counterfactual | Four layers, four audiences |
| Ground truth | NBFC field-agent XRF + active learning | Builds the moat over time |
| Hosting | Cloudflare Pages + Hetzner + Runpod spot | ₹20–30k/mo MVP cost ceiling |

---

## 19. Things to Resist Building

The hackathon graveyard is full of teams who built six features at 60%. Build three at 100%. Refuse these temptations:

- **User accounts / auth.** Session-id-in-URL is fine for MVP.
- **Database admin panel.** Logs to Postgres, query with SQL.
- **End-to-end RL on the VLM.** Frame as active learning + contextual bandit per PRD §14 R8. Don't claim what you can't prove.
- **WhatsApp integration before PWA is rock-solid.** Pilot scope, not MVP.
- **Live video verification.** Phase 2 feature.
- **All 12 languages at MVP.** English + Hindi only for the demo.
- **Federated learning, blockchain, marketplace bidding, insurance quotes.** Slide deck only.
- **Building SAM 2 from scratch when zero-shot works.** Test zero-shot first; only fine-tune if measurably worse than target.
- **Per-session counterfactual generation if it blows the latency budget.** Make it async / on-demand.
- **Native iOS/Android apps.** PWA reaches further, costs less, ships faster.

---

## 20. The Pitch (Memorize for Demo Day)

Adapted from PRD §1, §2, §16:

> India has 25,000 tonnes of privately-held gold. Gold loans are a credit lifeline for millions, especially in semi-urban and rural India. But every loan today requires a physical XRF assay — slow, expensive, ₹300–800 per applicant just to dispatch an agent, with 60% drop-off.
>
> GoldEye is a mobile web app where the customer photographs their jewelry from home and gets an instant, calibrated pre-qualification — purity band, weight band, loan band, with a 90% statistical coverage guarantee.
>
> We don't replace XRF. We do upstream triage: route 70% of applicants directly to instant pre-approval, dispatch agents only for cases that need physical confirmation. We cut acquisition cost by 60–70% while expanding reach to villages no NBFC branch can serve.
>
> Twelve independent signals, four layers of explainability, RBI-2025 compliant by design. Open-weight models, no per-call API cost, fully auditable.
>
> The future of gold lending is at the customer's doorstep — through their phone.

---

## 21. Right-Now Action List (Next 2 Hours)

If you're starting fresh, in this exact order. This is the path from "I have an idea" to "I have shipping infrastructure" in one focused session.

1. ☐ Create GitHub repo `goldeye` (private, monorepo).
2. ☐ Create Cloudflare account → R2 bucket (India region) → Pages project.
3. ☐ Provision Hetzner CX22 → SSH key set up → Docker installed.
4. ☐ Run `docker compose up` from §4.3 — confirm Postgres, Redis, Qdrant, MinIO healthy.
5. ☐ Buy domain → Cloudflare DNS → A record pointing to Hetzner box.
6. ☐ Caddy auto-HTTPS reverse-proxy in front of FastAPI on the Hetzner box.
7. ☐ Run the Vite + React + Tailwind + shadcn scaffold from §4.3 → push → Cloudflare Pages picks it up automatically.
8. ☐ FastAPI `/health` endpoint returns 200 from your phone over the public domain.
9. ☐ Drop the Pydantic schemas from §2.1 into `apps/api/app/models/schemas.py`.
10. ☐ Drop the camera proof component from §5.2 into `apps/web/src/components/CameraProof.tsx` and wire it as the home page.
11. ☐ On your Android phone: open the public URL, tap "Start Camera", capture, see the photo.
12. ☐ On a borrowed iPhone: same.
13. ☐ Source the demo plated-brass piece this week (₹500 at a local imitation-jewelry market).
14. ☐ Start the Tanishq/Kalyan scraper running in the background — let it accumulate while you build.
15. ☐ End-of-session: commit, push, demo runs from `main` on the public URL.

If any of steps 11–12 fail, **stop everything else** until they work. Phase 0 is the gate that protects every later phase from being a waste.

---

**End of plan.** Refer back to PRD §4 when in doubt about scope. Refer to §1 (Mission Control) of this document weekly to track delivery.

Now ship.

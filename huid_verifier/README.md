# BIS CARE HUID Verifier

A proof-of-concept backend service that verifies BIS hallmark UIDs (HUIDs) by automating the **official BIS CARE Android app** via Appium. The user submits a 6-character HUID; the backend opens BIS CARE on a connected Android emulator or device, enters the HUID, captures the result screen, and returns structured JSON.

> **Important:** This project uses visible UI automation of the official BIS CARE app.
> It does not claim to use an official public BIS API.
> It does not scrape private or undocumented endpoints.
> It is a proof-of-concept for low-volume verification only.
> For production use, request official API integration/permission from BIS or your financial partner.

---

## How it works

```
User → GET /verify-huid/ABC123
         │
         ▼
   FastAPI (port 8001)
         │  validate format
         │  run in thread pool (1 worker)
         ▼
   Appium → Android emulator/device
         │  launch BIS CARE
         │  tap "Verify HUID"
         │  type ABC123
         │  tap "Search"
         │  wait for result screen
         │  capture page_source + screenshot
         ▼
   Parser (regex, no AI)
         │  detect purity / failure keywords
         ▼
   JSON response → User
```

---

## Prerequisites (macOS)

### 1. Install Android Studio

Download from [developer.android.com/studio](https://developer.android.com/studio) and install it.

Open Android Studio → Virtual Device Manager → Create a new AVD:
- Phone category, Pixel 6 (or similar)
- System Image: Android 13 (API 33) — x86_64
- Name it, click Finish

Start the emulator — it should appear as `emulator-5554` in `adb devices`.

### 2. Add adb to PATH

```bash
echo 'export PATH="$PATH:$HOME/Library/Android/sdk/platform-tools"' >> ~/.zshrc
source ~/.zshrc
adb devices   # should show emulator-5554
```

### 3. Install BIS CARE on the emulator

Open Google Play Store on the emulator, search for **BIS CARE**, and install it.
Or sideload the APK if you have it:
```bash
adb install biscare.apk
```

Manually open BIS CARE once and confirm the **Verify HUID** flow works without login.

### 4. Install Node.js and Appium 3

```bash
brew install node
npm install -g appium
appium driver install uiautomator2
```

### 5. Set up Python environment

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

### 6. Configure environment

```bash
cp .env.example .env
# Edit .env — most defaults work out of the box
```

The only value you may need to change is `PLATFORM_VERSION` to match your emulator's Android version.

---

## Run the doctor check

```bash
bash scripts/doctor.sh
```

This checks Python version, adb, Appium, UiAutomator2 driver, connected devices, BIS CARE installation, and Python packages. Fix any `[FAIL]` items before proceeding.

---

## Detect the BIS CARE launcher activity (optional)

The agent launches BIS CARE by package name; Appium resolves the activity automatically.
If Appium fails to start the app, run:

```bash
bash scripts/detect_bis_activity.sh
```

Copy the printed activity value into your `.env` as `BIS_ACTIVITY=`.

---

## Start Appium

In a separate terminal:
```bash
bash scripts/start_appium.sh
```

Leave it running. It listens on `http://127.0.0.1:4723`.

---

## Run the FastAPI server

```bash
source venv/bin/activate
uvicorn app.main:app --reload --port 8001
```

The API runs at `http://localhost:8001`.

---

## Test the endpoint

```bash
# Service info
curl http://localhost:8001/

# Health check
curl http://localhost:8001/health

# Verify a real HUID (replace ABC123 with an actual hallmark UID)
curl http://localhost:8001/verify-huid/ABC123
```

Expected response shape:
```json
{
  "huid": "ABC123",
  "source": "BIS_CARE_APP",
  "status": "VERIFIED",
  "confidence": 95,
  "purity": "22K916",
  "article_type": "ring",
  "raw_text": "...",
  "screenshot_path": "screenshots/ABC123_1700000000.png",
  "error": null
}
```

Possible `status` values:

| Status | Meaning |
|---|---|
| `VERIFIED` | Purity found in BIS CARE result |
| `NOT_VERIFIED` | Failure keyword detected (not found, invalid, etc.) |
| `NEEDS_MANUAL_REVIEW` | Result screen captured but parser could not extract purity |
| `INVALID_FORMAT` | HUID is not exactly 6 alphanumeric characters |
| `AGENT_ERROR` | Appium automation failed |

---

## Run unit tests

Tests cover HUID validation and the parser — no Appium or device required.

```bash
source venv/bin/activate
pytest tests/ -v
```

---

## Debug selectors with Appium Inspector

When the automation can't find UI elements, use **Appium Inspector** to discover the correct selectors.

1. Install: [github.com/appium/appium-inspector](https://github.com/appium/appium-inspector/releases)
2. Connect to `http://127.0.0.1:4723` with these capabilities:
   ```json
   {
     "platformName": "Android",
     "appium:deviceName": "Android Emulator",
     "appium:udid": "emulator-5554",
     "appium:appPackage": "com.bis.bisapp",
     "appium:noReset": true,
     "appium:automationName": "UiAutomator2"
   }
   ```
3. Start session → navigate BIS CARE manually → tap elements to see their `resource-id`, `content-desc`, and `text` attributes.

### Selectors to adjust in `app/bis_agent.py`

After inspecting the app, update these values:

| What | Where in bis_agent.py | What to set |
|---|---|---|
| HUID entry button text | `huid_entry_texts` list | Exact text on the menu button |
| Submit button text | `submit_texts` list | Exact text on the search/verify button |
| HUID input `resource-id` | Add before `find_first_edit_text()` call | `driver.find_element(AppiumBy.ID, "com.bis.bisapp:id/YOUR_ID")` |

---

## Known limitations

- **One worker only** — concurrent requests queue behind the single Appium thread.
- **BIS CARE UI may change** — if BIS releases an app update, selectors may need updating.
- **Emulator performance** — cold-start Appium sessions take 10–30 seconds.
- **No login flow tested** — if BIS CARE adds login, the agent will need updating.
- **Screenshot is local** — screenshots are saved to `screenshots/` on the server; not served over HTTP.

---

## Project structure

```
huid_verifier/
├── app/
│   ├── __init__.py
│   ├── main.py          — FastAPI app, HUID validation, route
│   ├── config.py        — Pydantic settings (env-driven)
│   ├── models.py        — Request/response Pydantic models
│   ├── bis_agent.py     — Appium automation
│   ├── parser.py        — Page-source parser (no Appium dependency)
│   └── logging_config.py
├── scripts/
│   ├── doctor.sh        — Environment health check
│   ├── detect_bis_activity.sh
│   └── start_appium.sh
├── tests/
│   ├── test_huid_validation.py
│   └── test_parser.py
├── screenshots/         — Auto-created; stores result screenshots
├── requirements.txt
├── .env.example
└── README.md
```

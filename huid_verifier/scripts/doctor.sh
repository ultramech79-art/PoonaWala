#!/usr/bin/env bash
# doctor.sh — sanity-check the local environment before running the verifier
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()   { echo -e "${GREEN}[OK]${NC}    $*"; }
fail() { echo -e "${RED}[FAIL]${NC}  $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC}  $*"; }

echo ""
echo "═══════════════════════════════════════════════════"
echo "  BIS CARE HUID Verifier — Environment Doctor"
echo "═══════════════════════════════════════════════════"
echo ""

# ── Python ────────────────────────────────────────────────────────────────────
PY=$(python3 --version 2>&1 || echo "NOT FOUND")
if echo "$PY" | grep -qE "Python 3\.(11|12)"; then
    ok "Python: $PY"
else
    fail "Python 3.11 or 3.12 required. Found: $PY"
fi

# ── adb ───────────────────────────────────────────────────────────────────────
if command -v adb &>/dev/null; then
    ADB_VER=$(adb version | head -1)
    ok "adb: $ADB_VER"
else
    fail "adb not found — install Android Studio / Android SDK platform-tools"
fi

# ── Node.js ───────────────────────────────────────────────────────────────────
if command -v node &>/dev/null; then
    ok "Node.js: $(node --version)"
else
    warn "Node.js not found — needed for Appium. Run: brew install node"
fi

# ── Appium ────────────────────────────────────────────────────────────────────
if command -v appium &>/dev/null; then
    APPIUM_VER=$(appium --version 2>&1)
    ok "Appium: $APPIUM_VER"
else
    fail "Appium not found. Run: npm install -g appium"
fi

# ── UiAutomator2 driver ───────────────────────────────────────────────────────
if command -v appium &>/dev/null; then
    if appium driver list --installed 2>&1 | grep -qi "uiautomator2"; then
        ok "UiAutomator2 driver: installed"
    else
        fail "UiAutomator2 driver not installed. Run: appium driver install uiautomator2"
    fi
fi

# ── Connected devices ─────────────────────────────────────────────────────────
echo ""
echo "── Connected Android devices / emulators ──"
if command -v adb &>/dev/null; then
    DEVICES=$(adb devices | tail -n +2 | grep -v "^$" || true)
    if [ -z "$DEVICES" ]; then
        fail "No Android device connected. Start emulator or connect phone."
    else
        while IFS= read -r line; do
            ok "$line"
        done <<< "$DEVICES"
    fi
fi

# ── BIS CARE package ──────────────────────────────────────────────────────────
echo ""
echo "── BIS CARE package check ──"
if command -v adb &>/dev/null && adb devices | grep -q "device$"; then
    if adb shell pm list packages 2>/dev/null | grep -qi "bis"; then
        ok "BIS CARE package detected"
        adb shell pm list packages 2>/dev/null | grep -i bis
    else
        warn "BIS CARE (com.bis.bisapp) not found on device — install from Play Store"
    fi
else
    warn "Skipping BIS package check — no device connected"
fi

# ── Python packages ───────────────────────────────────────────────────────────
echo ""
echo "── Python packages ──"
for pkg in fastapi uvicorn appium selenium pydantic pytest; do
    if python3 -c "import $pkg" 2>/dev/null; then
        ok "$pkg"
    else
        fail "$pkg not installed — run: pip install -r requirements.txt"
    fi
done

echo ""
echo "═══════════════════════════════════════════════════"
echo "  Doctor check complete."
echo "  Fix any [FAIL] items above, then run the service."
echo "═══════════════════════════════════════════════════"
echo ""

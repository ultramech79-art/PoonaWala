#!/usr/bin/env bash
# detect_bis_activity.sh
# Discovers the BIS CARE package name and launcher activity.
# Copy the activity value into your .env as BIS_ACTIVITY.
set -euo pipefail

echo ""
echo "── Searching for BIS-related packages ──"
adb shell pm list packages 2>/dev/null | grep -i bis || echo "(no BIS packages found)"

echo ""
echo "── Resolving launcher activity for com.bis.bisapp ──"
ACTIVITY=$(adb shell cmd package resolve-activity --brief com.bis.bisapp 2>/dev/null | tail -n 1 || echo "")

if [ -z "$ACTIVITY" ] || echo "$ACTIVITY" | grep -qi "error\|not found"; then
    echo "Could not resolve activity automatically."
    echo "Try: adb shell monkey -p com.bis.bisapp -c android.intent.category.LAUNCHER 1"
    echo "Then: adb shell dumpsys window windows | grep -E 'mCurrentFocus|mFocusedApp'"
else
    echo ""
    echo "Detected activity: $ACTIVITY"
    echo ""
    echo "Add to your .env file:"
    echo "  BIS_ACTIVITY=$ACTIVITY"
fi
echo ""

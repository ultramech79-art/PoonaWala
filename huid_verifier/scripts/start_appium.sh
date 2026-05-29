#!/usr/bin/env bash
# start_appium.sh — start the Appium 3 server on port 4723
set -euo pipefail

echo "Starting Appium 3 server on port 4723…"
echo "Press Ctrl+C to stop."
echo ""
ANDROID_SDK_DEFAULT="$HOME/Library/Android/sdk"
export ANDROID_HOME="${ANDROID_HOME:-$ANDROID_SDK_DEFAULT}"
export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$ANDROID_SDK_DEFAULT}"
export PATH="$ANDROID_SDK_ROOT/platform-tools:$PATH"
appium -p 4723 --allow-insecure uiautomator2:chromedriver_autodownload "$@"

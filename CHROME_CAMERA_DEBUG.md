# Chrome Camera Debugging — macOS

## Step 1: Grant Chrome Camera Access (System Level)

1. **Open macOS System Preferences**
2. **Security & Privacy → Camera**
3. **Look for "Google Chrome"** in the list
4. **Check the box next to Chrome** to allow camera access

⚠️ **Important**: If Chrome isn't listed, that's the problem!
- Uninstall Chrome completely: `rm -rf /Applications/Google\ Chrome.app`
- Reinstall Chrome from https://www.google.com/chrome
- Grant permission when first prompted

---

## Step 2: Grant Chrome Permission for localhost

1. **Open Chrome**
2. **Visit**: http://localhost:5173
3. **Tap "Tap to open camera"** on capture flow
4. **Click "Allow"** in the Chrome permission prompt at the top

⚠️ **Chrome often shows this prompt only ONCE** — if you accidentally blocked it, follow Step 3 below.

---

## Step 3: Check/Reset Chrome Permissions

1. **Click the lock icon** 🔒 next to the URL bar
2. **Click "Site settings"** or **"Camera"**
3. **Verify**:
   - Camera: ✅ **Allow** (not "Ask" or "Block")
   - Microphone: ✅ **Allow** (for audio)
4. **If it says "Block"**, click it and change to **"Allow"**
5. **Refresh the page**: Cmd+R

---

## Step 4: Open Browser Console & Check for Errors

1. **Open DevTools**: Cmd+Option+I
2. **Go to Console tab**
3. **Look for any RED error messages**
4. **Share what you see** — especially:
   - `NotAllowedError` = permission denied
   - `NotFoundError` = camera not found
   - `TypeError` = API not supported

---

## Step 5: Test Camera API Directly

**In the Chrome Console (Cmd+Option+I → Console)**, paste this:

```javascript
console.log('Testing Chrome camera access...');
navigator.mediaDevices.getUserMedia({
  video: { 
    width: { min: 320, ideal: 1280, max: 1920 },
    height: { min: 240, ideal: 720, max: 1080 },
    facingMode: 'environment'
  }
})
.then(stream => {
  console.log('✅ SUCCESS! Camera works:', {
    videoTracks: stream.getVideoTracks().length,
    width: stream.getVideoTracks()[0]?.getSettings().width,
    height: stream.getVideoTracks()[0]?.getSettings().height,
  });
  stream.getTracks().forEach(t => t.stop());
})
.catch(err => {
  console.error('❌ CAMERA ERROR:', {
    name: err.name,
    message: err.message,
    details: err.toString()
  });
});
```

### Expected Output:
- ✅ **If it works**: You'll see `✅ SUCCESS! Camera works: ...`
- ❌ **If it fails**: Red error with specific error code

---

## Common Chrome Errors & Fixes

| Error | Cause | Fix |
|-------|-------|-----|
| `NotAllowedError` | Permission denied | Grant in System Preferences + Chrome prompt |
| `NotFoundError` | Camera hardware not found | Check if FaceTime/Zoom using camera; restart Mac if stuck |
| `NotSupportedError` | HTTPS required (in production) | Using localhost is fine for dev |
| `OverconstrainedError` | Video constraints too strict | Refresh page (we auto-relax constraints now) |
| `TypeError: stream is undefined` | Stream not attached | Permission not granted |

---

## Chrome DevTools Network Tab

1. **DevTools → Network tab**
2. **Refresh page**
3. **Look for any failed requests to `localhost:5173`**
4. **Should see status 200 for all requests**

---

## If Console Shows "✅ SUCCESS"

Camera API works! The issue is in **our React component**. 

**Next steps**:
1. Go to Console again
2. **Refresh the capture page**
3. **Tap camera button**
4. **Look for `[Camera] Starting...` logs**
5. **Tell me where the logs stop**

---

## Completely Nuclear Reset

If nothing works, try this:

### Option A: Clear All Chrome Data
1. Chrome → Settings → Privacy and Security → Clear browsing data
2. Select: **All time**, **Cookies**, **Cached images**
3. Click **Clear data**
4. Close Chrome completely
5. Reopen Chrome
6. Go to http://localhost:5173

### Option B: Create New Chrome Profile
1. Chrome → Settings → (bottom left) **You**
2. **+ Add another person**
3. **Create profile** (minimal permissions)
4. Test camera in new profile
5. If it works, the issue is Chrome settings in your main profile

---

## Final Debugging: Screenshot Console

Once you've done the steps above:

1. **Open DevTools**: Cmd+Option+I
2. **Console tab**
3. **Tap camera button**
4. **Take screenshot of ALL console output**
5. **Share the screenshot with me**

This will show me exactly where it's failing.

---

## Still Broken? Use Demo Mode

While we debug, you can still test the full assessment flow:

1. **On any capture step**, click **"📋 Use demo image"**
2. **Bypass camera entirely**
3. **Test audio capture** (doesn't need camera)
4. **Complete mock assessment**

This proves the backend works while we fix the camera.

# Gemini API Integration — GoldEye Phase 10+

**Status**: ✅ **ACTIVE**  
**Version**: 1.0  
**Last Updated**: 2026-05-03

---

## Overview

GoldEye now uses **Google's Gemini 2.0 Flash API** as a trusted multimodal analyzer across the assessment pipeline. Gemini is deployed as:

1. **Primary method for S11 audio detection** (70% weight)
2. **Fallback for S7 plated/solid classification** (when ML unavailable)
3. **Fallback for S3 color/karat analysis** (when confidence < 0.4)
4. **Strategic decision-making** (complex routing when signals conflict)

This gives the app **multiple layers of AI redundancy** and ensures high confidence even when local ML models aren't available.

---

## Features

### 1. **S11 Audio — Gold Solid vs. Plated Detection**

**File**: `app/workers/s11_audio.py`

**What it does**:
- Analyzes audio recordings of gold being tapped/struck
- Detects acoustic signature: clear ring tone (solid) vs. dull thud (plated)
- Returns structured assessment: `{is_solid_gold, confidence, acoustic_signature, reason}`

**Blend Strategy** (70% Gemini, 30% FFT):
```python
solid_prob = 0.7 * (1.0 if gemini_solid else 0.0) + 0.3 * fft_probability
confidence = 0.7 * gemini_confidence + 0.3 * fft_confidence
```

**Signal Output**:
```json
{
  "solid_probability": 0.85,
  "plated_probability": 0.15,
  "method": "gemini_fft_blend",
  "gemini_confidence": 0.92,
  "gemini_signature": "clear_ring_tone",
  "fft_dominant_freq_hz": 850
}
```

---

### 2. **S7 Plated/Solid — Visual Classification Fallback**

**File**: `app/workers/s7_plated_solid.py`

**When used**:
- ConvNeXt ONNX unavailable (no model file)
- CIELAB color heuristic fails or unavailable
- Local ML cannot decide

**Gemini Prompt**:
```
Analyze this gold jewelry image.
Is this solid gold or plated?

Return JSON:
{
  "is_solid": boolean,
  "confidence": 0.0–1.0,
  "wear_indicators": "string",
  "reason": "string"
}
```

**What Gemini looks for**:
- Edge wear revealing base metal (→ plated)
- Surface uniformity (solid more consistent)
- Thickness/density visual clues
- Color uniformity across item

---

### 3. **S3 Color Analysis — Karat Estimation Fallback**

**File**: `app/workers/s3_color.py`

**When used**:
- No local frames can be white-balanced (coin not visible)
- CIELAB analysis returns `confidence < 0.4`

**Gemini Prompt**:
```
Analyze this gold jewelry for purity/karat.

Look for:
- Color saturation (deeper yellow = higher karat)
- Hallmark stamps visible
- Surface patina/aging indicators
- Comparison to reference colors

Return JSON:
{
  "estimated_karat": int (8–24),
  "confidence": 0.0–1.0,
  "hallmark_visible": boolean,
  "color_analysis": "string",
  "reason": "string"
}
```

**Boost Logic**:
```python
if cielab_confidence < 0.4:
    gemini_result = call_gemini("purity analysis")
    if gemini_confidence > cielab_confidence:
        use_gemini_karat_estimate
```

---

### 4. **Complex Decision-Making**

**File**: `app/data/gemini.py` → `analyze_complex_decision()`

**Use case**: When signals conflict (e.g., plated appearance but solid audio), ask Gemini:
```
"Given these conflicting signals, should we INSTANT, AGENT, RECAPTURE, or REJECT?"
```

**Response**:
```json
{
  "recommendation": "AGENT",
  "confidence": 0.78,
  "reasoning": "Audio suggests solid gold, but visual wear patterns indicate plating. Recommend agent review before approval.",
  "risk_level": "medium"
}
```

---

## Setup

### 1. Get Gemini API Key

1. Go to: https://ai.google.dev/
2. Click "Get API key" (free tier available)
3. Copy your API key

### 2. Configure `.env` File

```bash
cp apps/api/.env.example apps/api/.env
# Edit .env and add:
GEMINI_API_KEY=your_key_here
```

### 3. Install Dependencies

```bash
cd apps/api
pip install google-generativeai==0.7.2 aiohttp
```

### 4. Verify Setup

```bash
python3 -c "from app.data.gemini import analyze_audio_gold_detection; print('✅ Gemini module ready')"
```

---

## API Usage

### Audio Analysis

```python
from app.data.gemini import analyze_audio_gold_detection

result = await analyze_audio_gold_detection(
    audio_url="https://example.com/audio.wav"
)
# Returns: {is_solid_gold, confidence, acoustic_signature, reason}
```

### Image Analysis (Fallback)

```python
from app.data.gemini import analyze_image_fallback

result = await analyze_image_fallback(
    image_base64="...",  # base64-encoded JPEG
    analysis_type="plated_solid"  # or "purity", "authenticity", "weight"
)
```

### Complex Decisions

```python
from app.data.gemini import analyze_complex_decision

result = await analyze_complex_decision(
    context={
        "s7_solid_prob": 0.3,  # visual says plated
        "s11_solid_prob": 0.85,  # audio says solid
        "hallmark_verified": False,
        "price_confidence": 0.5
    },
    question="Should we INSTANT, AGENT, RECAPTURE, or REJECT?"
)
```

---

## Error Handling

### Missing API Key

If `GEMINI_API_KEY` is not set:
- Gemini calls return `{error: "gemini_api_key_missing"}`
- Workers fallback to local ML (FFT, CIELAB, color heuristic)
- Assessment still completes with degraded confidence

### API Timeouts

Default timeout: **60 seconds** for audio/image, **30 seconds** for decisions.

Fallback on timeout:
```python
except asyncio.TimeoutError:
    # Use local heuristic instead
    # Confidence reduced but assessment continues
```

### Invalid JSON Response

If Gemini returns malformed JSON:
```python
except json.JSONDecodeError:
    # Return neutral result, trigger fallback
    return {error: "invalid_response", confidence: 0.0}
```

---

## Performance & Cost

### Latency

- **Audio analysis**: 2–5 seconds (30s timeout)
- **Image analysis**: 1–3 seconds (60s timeout)
- **Decision-making**: 1–2 seconds (30s timeout)

### Cost (as of May 2026)

- **Free tier**: 15 requests/minute, 1.5M tokens/day
- **Paid tier**: $2.50/1M input tokens, $10/1M output tokens

**Estimate for 100 assessments/day**:
- Audio analysis: 100 calls × 5-10KB = ~$0.01
- Image fallback: ~10 calls × 20-50KB = ~$0.01
- **Daily cost**: ~$0.02 (well under free tier)

---

## Monitoring & Logging

All Gemini calls are logged at `DEBUG` level:

```
DEBUG    goldeye.gemini: Gemini audio analysis completed (confidence=0.92)
DEBUG    goldeye.workers.s11: S11 blended result: 70% Gemini, 30% FFT
```

For production, enable metrics tracking:

```python
logger.info(f"Gemini API call: method={analysis_type}, latency_ms={elapsed_ms}, confidence={conf}")
```

---

## Fallback Hierarchy

```
┌─────────────────────────────────────────┐
│      Assessment Endpoint (/api/assess)   │
└──────────────────┬──────────────────────┘
                   │
          ┌────────┴────────┐
          ▼                  ▼
    ┌─────────────┐    ┌──────────────┐
    │ S11 Audio   │    │ S7 Plated    │ S3 Color
    │             │    │              │
    │ 1. Gemini   │    │ 1. ConvNeXt  │ 1. CIELAB
    │ 2. FFT      │    │ 2. CIELAB    │ 2. Gemini
    │ 3. Blend    │    │ 3. Gemini    │ 3. Gemini
    └─────────────┘    └──────────────┘
         70/30             Fallback         Fallback
         blend              Priority        Priority
```

---

## Future Enhancements

1. **Vision + Audio fusion** — Gemini analyzes video + audio simultaneously
2. **Real-time liveness** — Video liveness detection (hand movement, lighting changes)
3. **Adversarial detection** — Gemini identifies spoofing attempts in audio/images
4. **Custom fine-tuning** — Adapt Gemini responses to GoldEye-specific hallmarks

---

## Troubleshooting

### "gemini_api_key_missing"

**Problem**: No API key set  
**Solution**: 
```bash
export GEMINI_API_KEY="your_key"
# or add to .env and restart backend
```

### "gemini_timeout"

**Problem**: API took > 60 seconds  
**Solution**:
- Increase timeout in `app/data/gemini.py` (not recommended)
- Check network connectivity
- Retry assessment

### "invalid_response"

**Problem**: Gemini returned unparseable JSON  
**Solution**:
- Gemini prompt may be malformed
- Fallback to local ML activated automatically
- Report bug with request/response

---

## References

- **Gemini API Docs**: https://ai.google.dev/
- **Model Card**: Gemini 2.0 Flash (multimodal, vision + audio + text)
- **Rate Limits**: 15 requests/minute (free tier)

---

**Questions?** Check logs at `DEBUG` level or review `app/data/gemini.py`.

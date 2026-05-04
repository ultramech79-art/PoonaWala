# Image Preprocessing & Scoring Logic - PoonaWala Gold Assessment

## Overview
The system uses a **13-signal parallel processing pipeline** that analyzes gold jewelry images from multiple angles and modalities, then fuses the results using LightGBM machine learning + MAPIE conformal prediction for uncertainty quantification.

---

## 1. IMAGE FLOW ARCHITECTURE

### Input
- User captures **7 images** during assessment:
  1. **Top view** - Jewelry flat, looking down (scale reference: ₹10 coin optional)
  2. **45-degree angle** - Side profile at 45° angle
  3. **Side view** - Full side profile
  4. **Macro/Hallmark** - Zoomed in on BIS hallmark stamp (critical for HUID detection)
  5. **Video** - Rotating jewelry (3 seconds, optional)
  6. **Audio** - Tapping jewelry to detect solid vs plated (optional)
  7. **Selfie** - User holding jewelry (liveness verification)

### Processing
All images are processed in **parallel** through 13 independent signal workers:

```
INPUT FRAMES → [S1, S2, S3, S4, S5, S6, S7, S8, S9, S10, S11, S12, S13] → FUSION → OUTPUT
                (async.gather with mini-chains)
```

---

## 2. SIGNAL WORKERS (PREPROCESSING PIPELINE)

### **S1: HUID Detection (Hallmark OCR)**
**File:** `s1_huid.py`

**Input:** Macro frame (jewelry hallmark image)

**Process:**
1. Fetch macro image from URL or data-URI
2. OpenCV-based local hallmark detection using `huid_detector.py`
   - Detects BIS (Bureau of Indian Standards) logo presence
   - Extracts purity mark (22K, 916, 750, etc.)
   - Extracts 6-character HUID code
   - Analyzes stamp appearance (laser, embossed, stamped, etc.)
3. (Optional) VLM blend if production model available

**Output Confidence:** 
- 0.9+ if HUID found
- 0.3-0.5 if stamp but no HUID
- 0.1 if no hallmark detected

**Payload:**
```json
{
  "bis_logo_present": true/false,
  "purity_mark": "22K916" | "18K750" | null,
  "huid_code": "A3F2K1",
  "stamp_appearance": "laser_engraved" | "embossed" | "stamped" | "unclear"
}
```

---

### **S2: Hallmark Quality Analysis**
**File:** `s2_hallmark.py`

**Input:** Macro frame + S1 payload (HUID data)

**Process:**
1. Uses S1 hallmark detection results
2. Analyzes hallmark quality (clarity, visibility, authenticity indicators)
3. Checks for common fraud patterns

**Output Confidence:** 0.5-0.95 based on hallmark visibility

**Payload:**
```json
{
  "hallmark_quality_score": 0.85,
  "is_authentic_hallmark": true/false,
  "fraud_indicators": []
}
```

---

### **S3: Color & Purity Analysis**
**File:** `s3_color.py`

**Input:** All frames (uses first non-stub frame)

**Process:**
1. Fetch image, convert to base64
2. Send to **Gemini 2.5-Flash API** with prompt:
   ```
   "Analyze this gold jewelry for purity/karat.
   Look for: color saturation (darker yellow = higher karat),
   hallmarks, surface patina/aging, reference colors"
   ```
3. Gemini returns estimated karat (8-24 range)
4. Map to confidence score

**Output Confidence:** 0.0-0.9 (depends on image quality)

**Payload:**
```json
{
  "best_karat": "22K",
  "best_karat_int": 22,
  "color_analysis": "Rich golden yellow, consistent with 22K",
  "hallmark_visible": true,
  "method": "gemini_purity_analysis"
}
```

---

### **S4: Specular Metal Analysis**
**File:** `s4_specular.py`

**Input:** All frames

**Process:**
1. Analyze reflectivity/specularity of the metal
2. Gold has specific light reflection signatures
3. Non-gold metals (silver, aluminum) have different specular properties
4. **Fraud detection:** Plated metals show different specular signatures

**Output Confidence:** 0.3-0.8

**Payload:**
```json
{
  "metal_score": 0.85,
  "is_likely_gold": true,
  "reflection_quality": "strong_specular_reflection"
}
```

---

### **S5: Coin Detection & Jewelry Segmentation**
**File:** `s5_segmentation.py`

**Input:** All frames (tries macro/top-down first)

**Process:**
1. Uses **OpenCV Hough Circle Detection** to find ₹10 coin (if present)
   - ₹10 coin diameter = 27mm (reference scale)
2. Calculates pixels per millimeter (scale factor)
3. Detects jewelry boundaries using bbox estimation
4. Calculates jewelry area in pixels

**Key Equation:**
```
px_per_mm = (detected coin pixels) / 27mm
scale_mm_per_px = 1 / px_per_mm
jewelry_area_px2 = bounding box area
```

**Output Confidence:**
- 0.88 if coin detected
- 0.45 if no coin (falls back to population mean size)

**Payload:**
```json
{
  "coin_detected": true,
  "px_per_mm": 4.2,
  "scale_mm_per_px": 0.238,
  "jewelry_area_px2": 45000,
  "jewelry_bbox": {
    "x": 100,
    "y": 50,
    "width": 200,
    "height": 225,
    "area_px2": 45000
  }
}
```

---

### **S6: Weight Estimation**
**File:** `s6_dimensions.py`

**Input:** Frames, S5 payload (coin scale), manual weight (optional)

**Process:**
1. **If coin detected:**
   ```
   Jewelry area (px²) × scale (mm²/px²) → area (mm²)
   Assume average depth for gold jewelry → volume (mm³)
   Volume (cm³) × density (g/cm³) → weight (g)
   
   Density assumed: 17.75 g/cm³ (for 22K gold)
   ```

2. **If manual weight provided:**
   ```
   Final weight = manual_weight × 0.7 + vision_weight × 0.3
   (Trust user scale more, but blend with vision)
   ```

3. **If no coin/manual:**
   ```
   Use population mean = 7.9g (typical jewelry piece)
   ```

**Output Confidence:**
- 0.90 if hybrid (manual + vision)
- 0.72 if bbox detected
- 0.30 if population mean fallback

**Payload:**
```json
{
  "estimated_weight_g": 8.5,
  "vision_weight_g": 8.2,
  "manual_weight_g": 8.8,
  "method": "hybrid" | "bbox_volume_density" | "population_mean",
  "volume_cm3": 0.479
}
```

---

### **S7: Plated vs Solid Detection**
**File:** `s7_plated_solid.py`

**Input:** All frames

**Process:**
1. Send frames to **Gemini API** with prompt:
   ```
   "Is this solid gold or plated? Look for:
   - Edge wear revealing base metal
   - Thickness indicators
   - Surface uniformity
   - Weight relative to size"
   ```
2. Gemini returns: `is_solid: boolean`, `confidence: 0-1`

**Output Confidence:** 0.0-1.0 (Gemini-provided)

**Payload:**
```json
{
  "solid_probability": 0.95,
  "plated_probability": 0.05,
  "wear_indicators": "No visible wear, consistent thickness",
  "model": "gemini_image_analysis"
}
```

---

### **S8: VLM (Vision Language Model) Detailed Analysis**
**File:** `s8_vlm.py`

**Input:** All frames

**Process:**
1. Uses Vision Language Model (Gemini or equivalent) for comprehensive analysis
2. Detects stones, hallmarks, dimensions, purity from visual inspection
3. Returns detailed assessment with confidence

**Output Confidence:** 0.5-0.95

**Payload:**
```json
{
  "estimated_karat_band": [20, 22],
  "has_stones": false,
  "stone_type": null,
  "stone_carat": 0,
  "dimensions_estimate": "Medium ring, ~1cm width"
}
```

---

### **S9: Reverse Catalog Matching**
**File:** `s9_reverse_catalog.py`

**Input:** All frames

**Process:**
1. Image fingerprinting using deep features
2. Match against catalog of known gold jewelry designs
3. **Fraud detection:** Stock photos appear in catalog (catalog_match_score ≈ 1.0)
4. Legitimate items don't match catalog (score ≈ 0.0)

**Output Confidence:** 0.0-0.9

**Payload:**
```json
{
  "catalog_match_score": 0.15,
  "matching_items": [],
  "is_likely_stock_photo": false
}
```

---

### **S10: Telemetry Analysis**
**File:** `s10_telemetry.py`

**Input:** Device metadata (user-agent, capture conditions, etc.)

**Process:**
1. Analyze capture device info
2. Detect anomalies:
   - Unusual device specs
   - Timing inconsistencies
   - Spoofing indicators

**Output Confidence:** 0.0-1.0

**Payload:**
```json
{
  "telemetry_anomaly_score": 0.05,
  "device_trust_level": "high",
  "timing_consistent": true
}
```

---

### **S11: Audio Analysis (Tapping)**
**File:** `s11_audio.py`

**Input:** Audio URL (user tapping jewelry)

**Process:**
1. Fetch audio file (WAV/MP4)
2. Send to **Gemini API** with acoustic analysis:
   ```
   "Analyze tap/strike sound:
   - Clear ring (2-5 sec decay) = solid
   - Dull/muted (< 1 sec) = plated
   - Fundamental frequency 600-1200Hz = gold
   - Rich harmonics = solid gold"
   ```
3. Returns: `is_solid_gold: boolean`

**Output Confidence:** 0.0-0.95

**Payload:**
```json
{
  "is_solid_gold": true,
  "confidence": 0.87,
  "acoustic_signature": "clear_ring_tone",
  "reason": "2.3 second decay, rich harmonics"
}
```

---

### **S12: Graph Cross-Application Analysis**
**File:** `s12_graph.py`

**Input:** HUID code, frames, session history

**Process:**
1. Build temporal graph of HUID appearances across assessments
2. Detect photo reuse or HUID spoofing
3. Cross-check with previous sessions

**Output Confidence:** 0.0-0.8

**Payload:**
```json
{
  "graph_anomaly_score": 0.0,
  "is_likely_reused_image": false,
  "previous_appearances": 0
}
```

---

### **S13: Liveness Verification (Selfie)**
**File:** `s13_liveness.py`

**Input:** Selfie image

**Process:**
1. Face detection in selfie
2. Jewelry visible in frame?
3. Face is real (not photo/mask)?
4. Returns: `is_likely_human: boolean`

**Output Confidence:** 0.5-0.99

**Payload:**
```json
{
  "face_detected": true,
  "jewelry_in_frame": true,
  "liveness_score": 0.94,
  "is_likely_human": true
}
```

---

## 3. FUSION LOGIC (SCORING)

**File:** `fusion.py`

### Step 1: Extract 19-Feature Vector

All 13 signals converted to flat feature vector:

```python
FEATURES = {
    # S1 (HUID)
    "huid_verified": 1.0 if hallmark found else 0.0,
    "ocr_confidence": s1_confidence,
    
    # S2 (Hallmark Quality)
    "hallmark_quality_score": 0.85,
    
    # S5 (Coin & Jewelry Segmentation)
    "coin_detected": 1.0 if coin found else 0.0,
    "jewelry_area_px2": 45000,
    
    # S6 (Weight)
    "estimated_weight_g": 8.5,
    "weight_method_hybrid": 1.0 if manual weight provided else 0.0,
    
    # S7 (Plated/Solid)
    "solid_probability_s7": 0.95,
    
    # S8 (VLM)
    "vlm_confidence": s8_confidence,
    "vlm_karat_mid": 21.0,  # midpoint of [20, 22]
    
    # S10 (Telemetry)
    "telemetry_anomaly_score": 0.05,
    
    # S11 (Audio)
    "audio_solid_probability": 0.87,
    "audio_confidence": s11_confidence,
    
    # S3 (Color)
    "color_karat_mid": 22,
    "color_confidence": 0.65,
    
    # S4 (Specular)
    "specular_metal_score": 0.85,
    "specular_confidence": 0.70,
    
    # S9 (Catalog)
    "catalog_match_score": 0.15,
    
    # S12 (Graph)
    "graph_anomaly_score": 0.0,
}
```

### Step 2: LightGBM Prediction (If Model Available)

```python
# Load trained LightGBM model
point_karat = lgbm_model.predict(feature_vector)[0]  # Range: 14-24

# Clamp to valid range
point_karat = clip(point_karat, 14, 24)
```

### Step 3: MAPIE Conformal Prediction (If Available)

```python
# Get 90% confidence interval
_, prediction_intervals = mapie_model.predict_interval(feature_vector)

karat_lo = prediction_intervals[0, 0, 0]  # Lower bound
karat_hi = prediction_intervals[0, 1, 0]  # Upper bound

# Ensure valid bounds
karat_lo = clip(karat_lo, 14, 24)
karat_hi = clip(karat_hi, 14, 24)
```

### Step 4: Fallback Heuristic Fusion (If Models Not Available)

```python
# Blend VLM karat with color karat
vlm_karat_mid = 21.0
color_karat_mid = 22
color_confidence = 0.65

blended_karat = (
    vlm_karat_mid * (1 - color_confidence * 0.4) +
    color_karat_mid * (color_confidence * 0.4)
)
# = 21.0 * 0.74 + 22 * 0.26 = 15.54 + 5.72 = 21.26

# Snap to claimed karat
claimed_karat = 22 if blended_karat >= 20 else 18

# If HUID verified, trust it more; otherwise blend
if huid_verified:
    point_karat = claimed_karat  # 22
else:
    point_karat = int(round(claimed_karat * 0.5 + blended_karat * 0.5))

# Uncertainty band
karat_lo = max(14, point_karat - 2)  # 20
karat_hi = min(24, point_karat + 2)  # 24

# If metal is suspicious (low specular score), widen band
if specular_metal_score < 0.35:
    karat_lo -= 2  # Extra uncertainty
```

### Step 5: Weight Blending

```python
# If manual weight provided, trust it 70%, vision 30%
final_weight = (
    manual_weight * 0.7 + vision_weight * 0.3
    if manual_weight
    else vision_weight
)

# Typical variation around estimated weight
weight_lo = final_weight * 0.92
weight_hi = final_weight * 1.10
```

### Step 6: Value Calculation

```python
# Get live IBJA gold price for 24K (₹ per gram)
live_price_24k = 7800  # Updated hourly from IBJA/Metal API

# Calculate price per gram for specific karat
price_per_g = live_price_24k * (point_karat / 24)
# = 7800 * (22/24) = 7800 * 0.917 = ₹7150/g

# Final value
value_inr = final_weight * price_per_g
# = 8.5g * ₹7150/g = ₹60,775

# Band
value_lo = weight_lo * live_price_24k * (karat_lo / 24)
value_hi = weight_hi * live_price_24k * (karat_hi / 24)
```

---

## 4. FRAUD SCORING

```python
solid_prob = 0.95      # From S7
audio_solid = 0.87     # From S11
tele_anomaly = 0.05    # From S10
catalog_match = 0.15   # From S9
graph_anomaly = 0.0    # From S12
specular_score = 0.85  # From S4

fraud_score = min(1.0, max(0.0,
    (1 - solid_prob)   * 0.25  +  # 0.05 * 0.25 = 0.0125
    (1 - audio_solid)  * 0.15  +  # 0.13 * 0.15 = 0.0195
    tele_anomaly       * 0.20  +  # 0.05 * 0.20 = 0.0100
    catalog_match      * 0.25  +  # 0.15 * 0.25 = 0.0375
    graph_anomaly      * 0.15     # 0.0  * 0.15 = 0.0000
))
# = 0.0795

fraud_triggers = []
if solid_prob < 0.5:
    fraud_triggers.append("plated_metal_suspected")
if audio_solid < 0.5 and audio_conf > 0:
    fraud_triggers.append("acoustic_inconsistent")
if specular_score < 0.35:
    fraud_triggers.append("non_gold_specular_signature")
if catalog_match >= 0.85:
    fraud_triggers.append("catalog_stock_photo_match")
if graph_anomaly >= 0.4:
    fraud_triggers.append("cross_session_reuse_detected")
```

---

## 5. CONFIDENCE SCORE

```python
# Average confidence of active signals (non-error ones)
active_signals = [s1, s2, s3, s4, s5, s6, s7, s8, s9, s10]  # 10 signals
base_conf = sum(s.confidence for s in active_signals) / len(active_signals)
# ≈ (0.8 + 0.7 + 0.8 + 0.75 + 0.88 + 0.90 + 0.95 + 0.85 + 0.5 + 0.8) / 10 = 0.81

# Liveness multiplier (selfie check)
if has_selfie and s13_confidence > 0:
    liveness_mult = max(0.5, s13.confidence)  # [0.5, 1.0]
else:
    liveness_mult = 1.0  # Neutral if no selfie

# Apply multipliers
confidence = max(0.0, min(1.0,
    base_conf * liveness_mult - fraud_score * 0.3
))
# = 0.81 * 0.95 - 0.08 * 0.3
# = 0.7695 - 0.024 = 0.7455

# Rounded to 3 decimals
confidence = 0.746
```

---

## 6. RBI RULES

```python
# RBI (Reserve Bank of India) compliance checks
# Based on loan amount and jewelry purity

if point_karat >= 18 and final_weight >= 0.5:
    ltv_pct = 75  # Loan-to-value 75% for genuine gold
    tier = "under_2_5L"  # Loan tier
    reject_reason = None
elif point_karat < 14:
    reject_reason = "karat_below_threshold"
    ltv_pct = 0
elif final_weight < 0.1:
    reject_reason = "weight_too_light"
    ltv_pct = 0
else:
    ltv_pct = 60
    tier = "under_2_5L"
    reject_reason = None

# Calculate loan offer
loan_low = value_lo * (ltv_pct / 100)
loan_high = value_hi * (ltv_pct / 100)
```

---

## 7. ROUTING DECISION

```python
if reject_reason:
    routing = "REJECT"
elif confidence > 0.85 and fraud_score < 0.1:
    routing = "INSTANT"  # Approve immediately
elif confidence > 0.70 and fraud_score < 0.2:
    routing = "AGENT"    # Send to agent for review
else:
    routing = "RECAPTURE"  # Ask user to retake images
```

---

## 8. FINAL OUTPUT

```python
{
    "session_id": "session_123",
    "timestamp_utc": "2024-05-04T15:24:09Z",
    "purity": {
        "band_low_karat": 20,
        "band_high_karat": 24,
        "point_estimate_karat": 22,
        "huid_verified": true
    },
    "weight": {
        "manual_entry_g": 8.8,
        "estimated_g": 8.5,
        "band_low_g": 7.82,
        "band_high_g": 9.35,
        "method": "hybrid"
    },
    "value_inr": {
        "band_low": 55000,
        "band_high": 65000,
        "point_estimate": 60775
    },
    "loan_offer": {
        "band_low_inr": 41250,
        "band_high_inr": 48750,
        "ltv_applied_pct": 75,
        "tier": "under_2_5L"
    },
    "confidence": {
        "score": 0.746,
        "coverage_guarantee_pct": 90,
        "calibration_method": "split_conformal"
    },
    "fraud_signals": {
        "score": 0.080,
        "triggers": []
    },
    "routing": "INSTANT",
    "reasoning_text": {
        "text": "✓ BIS hallmark verified (HUID: A3F2K1)  ✓ Weight consistent...  ✓ No fraud signals"
    }
}
```

---

## SUMMARY TABLE

| Signal | Input | Algorithm | Output | Confidence |
|--------|-------|-----------|--------|------------|
| S1 | Macro | OpenCV + Gemini | HUID Code | 0.1-0.9 |
| S2 | Macro | Hallmark analysis | Quality Score | 0.5-0.95 |
| S3 | All | Gemini Vision | Karat 8-24 | 0.0-0.9 |
| S4 | All | Reflectivity | Metal Score | 0.3-0.8 |
| S5 | All | Hough Circles | Coin + Area | 0.45-0.88 |
| S6 | All + Manual | Volume-Density | Weight (g) | 0.30-0.90 |
| S7 | All | Gemini Vision | Solid% | 0.0-1.0 |
| S8 | All | VLM Analysis | Karat Band | 0.5-0.95 |
| S9 | All | Image Fingerprint | Catalog Match | 0.0-0.9 |
| S10 | Metadata | Anomaly Detection | Trust Score | 0.0-1.0 |
| S11 | Audio | Acoustic Analysis | Solid% | 0.0-0.95 |
| S12 | HUID Graph | Cross-Check | Anomaly Score | 0.0-0.8 |
| S13 | Selfie | Face Detection | Liveness | 0.5-0.99 |

---

## KEY METRICS

- **Total Processing Time:** 2-4 seconds (parallel processing)
- **Feature Vector Size:** 19 columns
- **ML Models:** LightGBM + MAPIE (conformal prediction)
- **Confidence Range:** 0.0-1.0 (rounded to 3 decimals)
- **Fraud Score Weight:** 30% of overall confidence reduction
- **Gold Price Source:** Yahoo Finance + Metal API (1-hour cache)
- **Fallback Price:** ₹7,200/gram (conservative estimate)

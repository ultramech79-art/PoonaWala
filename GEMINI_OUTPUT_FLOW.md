# How Gemini Results Flow Into Final Calculation

## Gemini Outputs → Feature Extraction → Fusion → Final Score

---

## 🔄 STEP 1: Gemini Returns Data

### **S3: Color Analysis** (Gemini)
```json
{
  "estimated_karat": 22,
  "confidence": 0.75,
  "color_analysis": "Rich golden yellow consistent with 22K",
  "hallmark_visible": true
}
```

### **S7: Plated/Solid** (Gemini)
```json
{
  "is_solid": true,
  "confidence": 0.92,
  "wear_indicators": "No visible wear, consistent thickness"
}
```

### **S11: Audio** (Gemini)
```json
{
  "is_solid_gold": true,
  "confidence": 0.87,
  "acoustic_signature": "clear_ring_tone"
}
```

---

## 🔀 STEP 2: Extract Features (Fusion.py)

**File:** `apps/api/app/workers/fusion.py:69-125`

```python
def extract_features(signals: dict[str, Any]) -> dict[str, float]:
    """Convert raw signal payloads to 19-feature vector"""
    
    # From S3 (Gemini Color)
    s3 = signals.get("s3", {})
    color_karat_mid = float(s3.get("best_karat_int", 20))  # ← From Gemini!
    color_confidence = float(signals.get("s3_conf", 0.0))   # ← Gemini confidence!
    
    # From S7 (Gemini Plated/Solid)
    s7 = signals.get("s7", {})
    solid_probability_s7 = float(s7.get("solid_probability", 0.5))  # ← From Gemini!
    
    # From S11 (Gemini Audio)
    s11 = signals.get("s11", {})
    audio_solid_probability = float(s11.get("solid_probability", 0.5))  # ← From Gemini!
    audio_confidence = float(signals.get("s11_conf", 0.0))  # ← Gemini confidence!
    
    # Build 19-feature vector
    return {
        # Gemini S3 features:
        "color_karat_mid": color_karat_mid,        # ← S3 Gemini output
        "color_confidence": color_confidence,      # ← S3 Gemini confidence
        
        # Gemini S7 features:
        "solid_probability_s7": solid_probability_s7,  # ← S7 Gemini output
        
        # Gemini S11 features:
        "audio_solid_probability": audio_solid_probability,  # ← S11 Gemini output
        "audio_confidence": audio_confidence,      # ← S11 Gemini confidence
        
        # Other 14 features from other signals (S1, S2, S4, S5, S6, S8, S9, S10, S12, S13)
        "huid_verified": 1.0 if s1.get("purity_mark") else 0.0,
        "ocr_confidence": float(signals.get("s1_conf", 0.5)),
        "hallmark_quality_score": float(s2.get("hallmark_quality_score", 0.5)),
        "coin_detected": 1.0 if s5.get("coin_detected") else 0.0,
        "jewelry_area_px2": float(s5.get("jewelry_area_px2", 0)),
        "estimated_weight_g": float(s6.get("estimated_weight_g", 7.9)),
        "weight_method_hybrid": 1.0 if s6.get("method") == "hybrid" else 0.0,
        "vlm_confidence": float(signals.get("s8_conf", 0.5)),
        "vlm_karat_mid": float(vlm_karat_mid),
        "telemetry_anomaly_score": float(s10.get("telemetry_anomaly_score", 0.03)),
        "specular_metal_score": float(s4.get("metal_score", 0.5)),
        "specular_confidence": float(signals.get("s4_conf", 0.0)),
        "catalog_match_score": float(s9.get("catalog_match_score", 0.0)),
        "graph_anomaly_score": float(s12.get("graph_anomaly_score", 0.0)),
    }
```

**Result: 19-Feature Vector**
```python
{
    'huid_verified': 1.0,
    'ocr_confidence': 0.8,
    'hallmark_quality_score': 0.7,
    'coin_detected': 1.0,
    'jewelry_area_px2': 45000,
    'estimated_weight_g': 8.5,
    'weight_method_hybrid': 1.0,
    'solid_probability_s7': 0.95,        # ← S7 Gemini
    'vlm_confidence': 0.85,
    'vlm_karat_mid': 21.0,
    'telemetry_anomaly_score': 0.05,
    'audio_solid_probability': 0.87,    # ← S11 Gemini
    'audio_confidence': 0.87,           # ← S11 Gemini
    'color_karat_mid': 22,              # ← S3 Gemini
    'color_confidence': 0.75,           # ← S3 Gemini
    'specular_metal_score': 0.85,
    'specular_confidence': 0.7,
    'catalog_match_score': 0.15,
    'graph_anomaly_score': 0.0,
}
```

---

## 🧠 STEP 3: LightGBM ML Model (If Available)

**File:** `apps/api/app/workers/fusion.py:146-173`

The 19-feature vector (containing Gemini outputs) is fed into **LightGBM model**:

```python
def _lgbm_mapie_fuse(features: dict, ...):
    import pandas as pd
    
    # Convert to DataFrame with exact feature column order
    row = pd.DataFrame([{k: features.get(k, 0.0) for k in FEATURE_COLUMNS}])
    
    # LightGBM predicts final karat using:
    # - S3 Gemini: color_karat_mid (22)
    # - S3 Gemini: color_confidence (0.75)
    # - S7 Gemini: solid_probability_s7 (0.95)
    # - S11 Gemini: audio_solid_probability (0.87)
    # - S11 Gemini: audio_confidence (0.87)
    # ... + 14 other features
    
    point_karat = float(np.clip(_lgbm_model.predict(row)[0], 14, 24))
    # ↓
    # point_karat = 21.8
    
    # MAPIE gives 90% confidence interval
    _, pis = _mapie_model.predict_interval(row)
    
    karat_lo = int(round(float(np.clip(pis[0, 0, 0], 14, 24))))  # 20
    karat_hi = int(round(float(np.clip(pis[0, 1, 0], 14, 24))))  # 24
```

**Output:**
```
point_karat = 22    (rounded from 21.8)
karat_lo = 20       (90% confidence lower)
karat_hi = 24       (90% confidence upper)
```

---

## 📊 STEP 4: Heuristic Fallback (If LightGBM Not Available)

If ML models aren't trained, uses **heuristic fusion** instead:

```python
def _heuristic_fuse(features: dict, ...):
    # Extract Gemini outputs directly
    vlm_karat_mid = features["vlm_karat_mid"]          # 21.0
    color_karat_mid = features.get("color_karat_mid", 21.0)  # 22 ← S3 Gemini!
    color_conf = features.get("color_confidence", 0.0)       # 0.75 ← S3 Gemini!
    
    # Blend VLM karat with Gemini color karat
    blended_karat = (
        vlm_karat_mid * (1 - color_conf * 0.4) +
        color_karat_mid * (color_conf * 0.4)
    )
    # = 21.0 * (1 - 0.75 * 0.4) + 22 * (0.75 * 0.4)
    # = 21.0 * 0.70 + 22 * 0.30
    # = 14.7 + 6.6 = 21.3
    
    claimed_karat = 22 if blended_karat >= 20 else 18
    
    # If HUID verified, use claimed karat; else blend
    if huid_verified:
        point_karat = claimed_karat  # 22
    else:
        point_karat = int(round(claimed_karat * 0.5 + blended_karat * 0.5))
    
    # Use Gemini S7 output for uncertainty
    specular_metal_score = features.get("specular_metal_score", 0.5)
    if specular_metal_score < 0.35:  # Low = not gold
        karat_lo = max(14, point_karat - 4)  # More uncertain
        karat_hi = min(24, point_karat + 4)
    else:
        karat_lo = max(14, point_karat - 2)  # Normal uncertainty
        karat_hi = min(24, point_karat + 2)
```

---

## 💰 STEP 5: Value Calculation Using Gemini Results

```python
# From fusion output (which used Gemini data)
point_karat = 22
final_weight = 8.5

# Get IBJA gold price
live_price_24k = 7800  # ₹ per gram for 24K gold

# Calculate using Gemini-influenced karat
price_per_g = live_price_24k * (point_karat / 24)
# = 7800 * (22 / 24)
# = 7800 * 0.9167
# = ₹7,150 per gram

# Final value
value_inr = final_weight * price_per_g
# = 8.5 * 7150
# = ₹60,775
```

---

## 🚨 STEP 6: Fraud Score (Using Gemini S7 & S11)

```python
# Extract from features (populated by Gemini)
solid_prob = features["solid_probability_s7"]       # 0.95 ← S7 Gemini
audio_solid = features["audio_solid_probability"]    # 0.87 ← S11 Gemini
tele_anomaly = features["telemetry_anomaly_score"]  # 0.05
catalog_match = features["catalog_match_score"]     # 0.15
graph_anomaly = features["graph_anomaly_score"]     # 0.0

# Calculate weighted fraud score
fraud_score = min(1.0, max(0.0,
    (1 - solid_prob)    * 0.25  +  # (1-0.95)*0.25 = 0.0125 ← S7 Gemini
    (1 - audio_solid)   * 0.15  +  # (1-0.87)*0.15 = 0.0195 ← S11 Gemini
    tele_anomaly        * 0.20  +  # 0.05*0.20     = 0.0100
    catalog_match       * 0.25  +  # 0.15*0.25     = 0.0375
    graph_anomaly       * 0.15     # 0.0*0.15      = 0.0000
))
# = 0.0795

# If either Gemini detector says it's plated, flag it
fraud_triggers = []
if solid_prob < 0.5:        # ← S7 Gemini
    fraud_triggers.append("plated_metal_suspected")
if audio_solid < 0.5 and audio_conf > 0:  # ← S11 Gemini
    fraud_triggers.append("acoustic_inconsistent")
```

---

## 🎯 STEP 7: Final Confidence Score (Using All Gemini Results)

```python
# Average confidence of active signals
active_signals = [s1, s2, s3, s4, s5, s6, s7, s8, s9, s10]
signal_confidences = [
    0.8,   # s1: HUID
    0.7,   # s2: Hallmark
    0.75,  # s3: Color ← S3 Gemini confidence
    0.7,   # s4: Specular
    0.88,  # s5: Segmentation
    0.9,   # s6: Weight
    0.92,  # s7: Plated/Solid ← S7 Gemini confidence
    0.85,  # s8: VLM
    0.5,   # s9: Catalog
    0.8    # s10: Telemetry
]

base_conf = sum(signal_confidences) / len(signal_confidences)
# = (0.8 + 0.7 + 0.75 + 0.7 + 0.88 + 0.9 + 0.92 + 0.85 + 0.5 + 0.8) / 10
# = 8.1 / 10 = 0.81

# Liveness multiplier
liveness_mult = 0.95  # From S13 selfie

# Apply fraud penalty
confidence = max(0.0, min(1.0,
    base_conf * liveness_mult - fraud_score * 0.3
))
# = 0.81 * 0.95 - 0.0795 * 0.3
# = 0.7695 - 0.0239
# = 0.7456 → 0.746 (rounded)
```

---

## 📋 STEP 8: RBI Rules (Using Gemini-Influenced Karat)

```python
# From fusion (which used Gemini data)
point_karat = 22        # ← Influenced by S3 Gemini color analysis
final_weight = 8.5
value_inr = 60775       # ← Calculated from Gemini-influenced karat

# RBI compliance check
if point_karat >= 18 and final_weight >= 0.5:
    ltv_pct = 75        # Loan-to-value
    tier = "under_2_5L"
    reject_reason = None
elif point_karat < 14:
    reject_reason = "karat_below_threshold"
    ltv_pct = 0
else:
    ltv_pct = 60

# Loan offer (using Gemini-influenced value)
loan_low = value_low * (ltv_pct / 100)    # Depends on karat from Gemini
loan_high = value_high * (ltv_pct / 100)
```

---

## ✅ STEP 9: Final Routing Decision

```python
# Based on confidence (which uses Gemini fraud detection)
if reject_reason:
    routing = "REJECT"
elif confidence > 0.85 and fraud_score < 0.1:  # fraud_score from Gemini
    routing = "INSTANT"     # ← Approved immediately
elif confidence > 0.70 and fraud_score < 0.2:  # fraud_score from Gemini
    routing = "AGENT"       # ← Send to agent
else:
    routing = "RECAPTURE"   # ← Ask user to retake
```

---

## 📤 FINAL JSON OUTPUT (Using Gemini Throughout)

```json
{
    "session_id": "session_123",
    "purity": {
        "band_low_karat": 20,
        "band_high_karat": 24,
        "point_estimate_karat": 22,              // ← From LightGBM (trained on Gemini)
        "huid_verified": true
    },
    "value_inr": {
        "band_low": 55000,
        "band_high": 65000,
        "point_estimate": 60775                  // ← Calculated from Gemini karat
    },
    "loan_offer": {
        "band_low_inr": 41250,
        "band_high_inr": 48750,
        "ltv_applied_pct": 75,
        "tier": "under_2_5L"
    },
    "confidence": {
        "score": 0.746,                          // ← Uses Gemini S7+S11 fraud detection
        "calibration_method": "split_conformal"
    },
    "fraud_signals": {
        "score": 0.080,                          // ← Calculated from Gemini S7+S11
        "triggers": []                           // ← Flags from Gemini outputs
    },
    "routing": "INSTANT"                        // ← Decision based on Gemini confidence
}
```

---

## 🎯 Summary: How Gemini Results Are Used

```
┌─────────────────────────────────────────────────────────┐
│ GEMINI API OUTPUTS (S3, S7, S11)                       │
├─────────────────────────────────────────────────────────┤
│ S3: color_karat_mid=22, color_confidence=0.75          │
│ S7: solid_probability=0.95                             │
│ S11: audio_solid_probability=0.87, confidence=0.87     │
└─────────────────────────────────────────────────────────┘
              ↓
┌─────────────────────────────────────────────────────────┐
│ FEATURE EXTRACTION (extract_features)                  │
│ Build 19-feature vector using Gemini outputs           │
└─────────────────────────────────────────────────────────┘
              ↓
┌─────────────────────────────────────────────────────────┐
│ FUSION (LightGBM + MAPIE)                              │
│ ML model trained on features that include Gemini data  │
│ Outputs: point_karat, karat_lo, karat_hi              │
└─────────────────────────────────────────────────────────┘
              ↓
┌─────────────────────────────────────────────────────────┐
│ CALCULATIONS                                           │
│ - Value = weight × karat × IBJA_price (uses Gemini)   │
│ - Fraud = (1-S7_gemini)*0.25 + (1-S11_gemini)*0.15   │
│ - Confidence = base_conf - fraud_penalty (uses Gemini)│
│ - Routing = decision based on Gemini fraud score      │
└─────────────────────────────────────────────────────────┘
              ↓
┌─────────────────────────────────────────────────────────┐
│ FINAL ASSESSMENT RESULT                                │
│ - All values influenced by Gemini analysis             │
│ - Decision tree uses Gemini fraud detection            │
│ - Confidence score incorporates Gemini soundness       │
└─────────────────────────────────────────────────────────┘
```

---

## Key Takeaways

✅ **Gemini outputs ARE used throughout the entire calculation:**
- S3 (Gemini color) → influences karat estimation
- S7 (Gemini plated/solid) → fraud score calculation
- S11 (Gemini audio) → fraud score + confidence penalty

✅ **Gemini data affects ALL downstream decisions:**
- Final karat band
- Value calculation
- Fraud score
- Confidence score
- Routing decision (INSTANT/AGENT/RECAPTURE/REJECT)

✅ **Gemini is NOT just initial input, but core to entire pipeline:**
- LightGBM model trained with Gemini features
- Fraud detection weighted by Gemini detectors
- Final score heavily influenced by Gemini confidence levels

⚠️ **If Gemini fails for any signal:**
- S3 fails → fusion still works, but with lower color confidence
- S7 fails → fraud score stays neutral (0.5)
- S11 fails → loses audio fraud detection, but has other signals

This is why having **multiple API keys with automatic failover is critical!**

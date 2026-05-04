# Scoring Logic Analysis & Recommendations

## Current Scoring Formula

```python
# Current Fraud Score Weights
fraud_score = min(1.0, max(0.0,
    (1 - solid_prob_s7)   * 0.25  +  # S7 Gemini plated detector
    (1 - audio_solid)     * 0.15  +  # S11 Gemini audio detector
    tele_anomaly          * 0.20  +  # Device metadata anomalies
    catalog_match         * 0.25  +  # Stock photo detection
    graph_anomaly         * 0.15     # HUID reuse detection
))

# Current Confidence Score
base_conf = avg([s1, s2, s3, s4, s5, s6, s7, s8, s9, s10])  # 10 signals
confidence = base_conf * liveness_mult - fraud_score * 0.3

# Current Routing
INSTANT:   confidence > 0.85 AND fraud_score < 0.1
AGENT:     confidence > 0.70 AND fraud_score < 0.2
RECAPTURE: confidence <= 0.70 OR fraud_score >= 0.2
REJECT:    RBI rules fail OR karat < 14
```

---

## Issues with Current Approach

### ❌ Issue 1: Fraud Score Weighting is Not Aligned with Importance

**Current weights:**
```
S7 (Gemini Plated) ........... 0.25 weight
S11 (Gemini Audio) ........... 0.15 weight
Catalog (Stock photo) ........ 0.25 weight (same as S7!)
Telemetry ..................... 0.20 weight
Graph .......................... 0.15 weight
```

**Problem:** 
- S7 (Gemini) is MOST critical for detecting plated/fake gold → should be weighted higher
- S11 (Gemini Audio) is unique verification → should be weighted higher
- Catalog match shouldn't equal S7 in importance (S7 is direct gold detector)

**Example:**
- If S7 says "95% solid" but catalog says "70% stock photo match" → fraud_score is influenced equally
- But S7 is more direct evidence than catalog match!

---

### ❌ Issue 2: Base Confidence Treats All 10 Signals Equally

**Current:**
```python
base_conf = (s1_conf + s2_conf + s3_conf + s4_conf + s5_conf + 
             s6_conf + s7_conf + s8_conf + s9_conf + s10_conf) / 10
```

**Problem:**
- S3 (Gemini color for karat) is critical → affects ENTIRE value calculation
- S7 (Gemini plated) is critical → affects fraud and authenticity
- S5 (coin detection) affects weight estimation
- But S9 (catalog) is just for fraud flags

**Reality:** Not all signals should be equally important!

**Example:**
- If S3 has 0.3 confidence (low color clarity) but S8 has 0.9 confidence → average is 0.6
- But the karat estimate (from S3) drives the final price!

---

### ❌ Issue 3: Fraud Penalty is Fixed (0.3 multiplier)

**Current:**
```python
confidence = base_conf * liveness_mult - fraud_score * 0.3
```

**Problem:**
- Fraud score of 0.9 (very high) → penalty = 0.27 (only 27% reduction!)
- Confidence could still be 0.70 even with fraud_score=0.90
- This seems too lenient for high fraud scores

**Example:**
```
base_conf = 0.80, fraud_score = 0.90, liveness = 1.0
confidence = 0.80 * 1.0 - 0.90 * 0.3 = 0.80 - 0.27 = 0.53
→ Routes to RECAPTURE (OK)

But what if:
base_conf = 0.95, fraud_score = 0.85, liveness = 1.0
confidence = 0.95 - 0.85 * 0.3 = 0.95 - 0.255 = 0.695
→ Routes to RECAPTURE (questionable for 85% fraud!)
```

---

### ❌ Issue 4: Gemini Confidence Not Explicitly Used in Final Score

**Current:**
- S3 Gemini confidence ✓ used in feature extraction
- S7 Gemini confidence ✓ used in fraud calculation (implied)
- S11 Gemini confidence ✓ used in fraud calculation (implied)

**But:**
- If S3 has only 0.3 confidence (unclear color), the karat estimate still gets full weight in fusion
- If S7 has only 0.2 confidence (unclear image), fraud detection might be unreliable
- If S11 has only 0.1 confidence (no audio), we still get 0.5 default solid_prob

**Problem:** Low Gemini confidence should reduce overall confidence more aggressively!

---

## 🎯 RECOMMENDATIONS

### **Recommendation 1: Weight Fraud Signals by Importance**

**Change from:**
```python
fraud_score = min(1.0, max(0.0,
    (1 - solid_prob_s7)   * 0.25  +  # S7
    (1 - audio_solid)     * 0.15  +  # S11
    tele_anomaly          * 0.20  +
    catalog_match         * 0.25  +  # ← Same as S7!
    graph_anomaly         * 0.15
))
```

**Change to:**
```python
# More aggressive Gemini signal weighting
fraud_score = min(1.0, max(0.0,
    (1 - solid_prob_s7)   * 0.35  +  # ↑ S7 Gemini (plated detection) - PRIMARY
    (1 - audio_solid)     * 0.25  +  # ↑ S11 Gemini (acoustic) - CORROBORATING
    specular_metal_score_low * 0.15 +  # ↑ Add specular (non-gold reflection)
    catalog_match         * 0.15  +  # ↓ Downgrade (less direct evidence)
    tele_anomaly          * 0.05  +  # ↓ Device anomalies are weak signals
    graph_anomaly         * 0.05     # ↓ Graph reuse is edge case
))
```

**Rationale:**
- S7 + S11 are direct Gemini detectors → should dominate (60% total)
- Specular reflectivity backs up S7 (both measure metal genuineness)
- Catalog + graph are secondary evidence (only 10% total)

---

### **Recommendation 2: Weight Confidence Signals by Criticality**

**Change from:**
```python
# Unweighted average of all 10 signals
base_conf = sum([s1, s2, s3, s4, s5, s6, s7, s8, s9, s10].conf) / 10
```

**Change to:**
```python
# Weighted by signal importance to final assessment
weights = {
    "s1": 0.10,  # HUID - important but not critical
    "s2": 0.08,  # Hallmark quality - supporting
    "s3": 0.18,  # ↑ Gemini Color - CRITICAL (drives karat)
    "s4": 0.10,  # Specular - important for metal check
    "s5": 0.12,  # Coin detection - affects weight
    "s6": 0.12,  # Weight estimation - affects value
    "s7": 0.15,  # ↑ Gemini Plated/Solid - CRITICAL (fraud detection)
    "s8": 0.07,  # VLM - supporting analysis
    "s9": 0.05,  # Catalog - fraud flag only
    "s10": 0.03, # Telemetry - weak signal
}

base_conf = (
    signals["s1_conf"] * 0.10 +
    signals["s2_conf"] * 0.08 +
    signals["s3_conf"] * 0.18 +  # ↑ Higher weight for Gemini color
    signals["s4_conf"] * 0.10 +
    signals["s5_conf"] * 0.12 +
    signals["s6_conf"] * 0.12 +
    signals["s7_conf"] * 0.15 +  # ↑ Higher weight for Gemini plated
    signals["s8_conf"] * 0.07 +
    signals["s9_conf"] * 0.05 +
    signals["s10_conf"] * 0.03
)
```

**Rationale:**
- S3 + S7 (both Gemini, both critical) = 33% of base confidence
- Physical measurements (S4, S5, S6) = 34% of base confidence
- Supporting evidence (S1, S2, S8) = 25% of base confidence
- Weak signals (S9, S10) = 8% of base confidence

---

### **Recommendation 3: Dynamic Fraud Penalty Based on Fraud Score**

**Change from:**
```python
# Fixed 0.3 multiplier regardless of fraud level
confidence = base_conf * liveness_mult - fraud_score * 0.3
```

**Change to:**
```python
# Increasing penalty for higher fraud scores
if fraud_score < 0.1:
    fraud_penalty = fraud_score * 0.1  # 0.1 → very lenient
elif fraud_score < 0.3:
    fraud_penalty = fraud_score * 0.25  # 0.25 → moderate
elif fraud_score < 0.6:
    fraud_penalty = fraud_score * 0.40  # 0.40 → aggressive
else:
    fraud_penalty = fraud_score * 0.60  # 0.60 → very aggressive for high fraud

confidence = max(0.0, min(1.0,
    base_conf * liveness_mult - fraud_penalty
))
```

**Example Impact:**
```
Scenario 1: Low fraud (0.05)
- Current: 0.80 - 0.05*0.3 = 0.785 ✓
- Proposed: 0.80 - 0.05*0.1 = 0.795 ✓ (slightly higher)

Scenario 2: Medium fraud (0.35)
- Current: 0.80 - 0.35*0.3 = 0.695 (routes RECAPTURE)
- Proposed: 0.80 - 0.35*0.40 = 0.66 (routes RECAPTURE - more aggressive)

Scenario 3: High fraud (0.80)
- Current: 0.80 - 0.80*0.3 = 0.56 (routes RECAPTURE)
- Proposed: 0.80 - 0.80*0.60 = 0.32 (routes REJECT! - much more protective)
```

---

### **Recommendation 4: Penalize Low Gemini Confidence More**

**Add explicit Gemini confidence penalty:**

```python
# After calculating base_conf
s3_gemini_conf = signals.get("s3_conf", 0.5)  # Color confidence
s7_gemini_conf = signals.get("s7_conf", 0.5)  # Plated confidence
s11_gemini_conf = signals.get("s11_conf", 0.0)  # Audio confidence

# Penalty if critical Gemini signals have low confidence
gemini_confidence = (s3_gemini_conf * 0.5 + s7_gemini_conf * 0.5)  # Average of critical Gemini
if gemini_confidence < 0.4:
    # Reduce confidence significantly if Gemini is uncertain
    base_conf *= 0.7  # 30% reduction
elif gemini_confidence < 0.6:
    base_conf *= 0.85  # 15% reduction
else:
    # High Gemini confidence - no penalty
    pass

# Then apply fraud penalty
confidence = max(0.0, min(1.0,
    base_conf * liveness_mult - fraud_penalty
))
```

---

### **Recommendation 5: Adjust Routing Thresholds**

**Current (might be too lenient):**
```python
if confidence > 0.85 and fraud_score < 0.1:
    routing = "INSTANT"
elif confidence > 0.70 and fraud_score < 0.2:
    routing = "AGENT"
else:
    routing = "RECAPTURE"
```

**Proposed (more conservative):**
```python
# More stringent fraud thresholds
if confidence > 0.80 and fraud_score < 0.05:
    routing = "INSTANT"        # ↑ Stricter: 0.85→0.80, fraud<0.05
elif confidence > 0.65 and fraud_score < 0.15:
    routing = "AGENT"          # ↑ Stricter: 0.70→0.65, fraud<0.15
elif fraud_score >= 0.40:
    routing = "REJECT"         # NEW: Explicit high-fraud reject
else:
    routing = "RECAPTURE"      # Recapture for unclear cases
```

**Rationale:**
- INSTANT approval requires BOTH high confidence AND low fraud
- AGENT review for moderate confidence
- Explicit REJECT for high fraud (not just RECAPTURE)

---

## 🎯 Summary of Changes

| Aspect | Current | Proposed | Impact |
|--------|---------|----------|--------|
| **Fraud Weighting** | Equal (0.25 each) | Gemini-focused (0.35+0.25) | Prioritizes direct detectors |
| **Base Confidence** | Unweighted avg | Weighted by importance | S3+S7 get 33% weight |
| **Fraud Penalty** | Fixed 0.3 | Dynamic 0.1-0.6 | Aggressive on high fraud |
| **Gemini Penalty** | Implicit | Explicit penalty | Penalizes low Gemini conf |
| **INSTANT Threshold** | >0.85 + <0.10 | >0.80 + <0.05 | Stricter approval |
| **Reject Routing** | RBI only | + fraud>0.40 | Explicit fraud rejection |

---

## Implementation Example

**Current Output for 2g Gold Coin:**
```json
{
    "confidence": {
        "score": 0.746,
        "routing": "AGENT"
    },
    "fraud_signals": {
        "score": 0.080
    }
}
```

**Proposed Output (with improvements):**
```json
{
    "confidence": {
        "score": 0.78,
        "routing": "INSTANT",
        "gemini_weight": 0.33,
        "fraud_penalty_applied": 0.05,
        "calibration_detail": "Weighted confidence with dynamic fraud penalty"
    },
    "fraud_signals": {
        "score": 0.082,
        "s7_weight": 0.35,
        "s11_weight": 0.25,
        "distribution": "Gemini-focused"
    }
}
```

---

## Risk Assessment

✅ **Low Risk Changes:**
- Weighting fraud by importance (S3/S7 higher)
- Weighting base_conf by criticality
- Dynamic fraud penalty
- Explicit Gemini confidence penalty

⚠️ **Moderate Risk Changes:**
- Stricter INSTANT threshold (0.85→0.80)
- Lower fraud tolerance (0.10→0.05)
- New explicit REJECT for fraud>0.40

---

## Recommendation Priority

1. **CRITICAL:** Weight fraud signals (S3/S7 > catalog/telemetry)
2. **IMPORTANT:** Weight base_conf (S3+S7 = 33%)
3. **IMPORTANT:** Dynamic fraud penalty (0.1-0.6 instead of fixed 0.3)
4. **GOOD:** Explicit Gemini confidence penalty
5. **NICE:** Adjust routing thresholds


"""
Voice guidance text for each capture angle + system prompt for the LLM guide.
"""

ANGLES = ["top", "45deg", "side", "macro", "selfie"]

ANGLE_LABELS = {
    "top":    "top-down shot",
    "45deg":  "45-degree angle",
    "side":   "side profile",
    "macro":  "close-up hallmark",
    "selfie": "selfie with your gold",
}

ANGLE_INSTRUCTIONS = {
    "top": (
        "Place your gold flat on a white surface and hold the camera directly above it. "
        "A ₹10 coin nearby helps me estimate size."
    ),
    "45deg": (
        "Now tilt the camera to about 45 degrees so I can see the depth and shape of the piece."
    ),
    "side": (
        "Hold the camera level with the edge of the gold so I can clearly see its thickness."
    ),
    "macro": (
        "Move the camera very close to the hallmark stamp — I need to read the karat marking. "
        "Look for a small engraved number like 22K, 18K, or a 3-digit fineness like 916."
    ),
    "selfie": (
        "Finally, take a selfie holding the gold clearly in front of your face. "
        "This is for identity verification."
    ),
}

SYSTEM_PROMPT = """\
You are GoldEye, a friendly and expert gold loan assessment agent from Poonawalla Fincorp.
You are guiding a customer through a live video gold appraisal. Your voice is calm, clear, and encouraging.

Your job:
1. Guide the customer through 5 capture angles: top-down, 45-degree, side profile, close-up hallmark, and selfie.
2. Celebrate each successful capture briefly ("Perfect! I can see the hallmark clearly.").
3. Give specific, actionable correction if quality is poor ("It's a bit blurry — hold it steady and move slightly closer.").
4. Keep responses SHORT — 1-2 sentences maximum. This is a voice conversation.
5. Never mention loan amounts or approval decisions during capture.
6. When all 5 angles are captured, say: "Excellent! I have everything I need. Analyzing your gold now — this takes about 30 seconds."
7. Speak naturally. No bullet points, no lists, no markdown.

Current session state will be injected as a system message before each response.
"""

CAPTURE_SUCCESS_PHRASES = {
    "top":    "Great top shot! I can see the piece clearly.",
    "45deg":  "Perfect angle — the depth is visible.",
    "side":   "Good side view — I can see the thickness.",
    "macro":  "Excellent! The hallmark is readable.",
    "selfie": "Identity captured. You're all set!",
}

CORRECTION_PHRASES = {
    "blurry":      "It's a bit blurry — hold your hand steady and try again.",
    "dark":        "The lighting is too dark — move to a brighter spot.",
    "no_gold":     "I can't see the gold clearly — make sure it fills most of the frame.",
    "wrong_angle": "The angle needs adjusting — ",
    "default":     "Let's try that again — ",
}

ALL_DONE_MESSAGE = (
    "Excellent! I have everything I need. "
    "Analyzing your gold now — this takes about 30 seconds. Please wait."
)

"""
GoldFrameAnalyzer — imported by run_pipeline.py (Python 3.11 subprocess only).
This file uses pipecat types and MUST NOT be imported at FastAPI startup (Python 3.9).

All pipecat imports happen at module level here, which is fine because this file
is only ever imported when Python 3.11 runs run_pipeline.py as a subprocess.
"""
# Intentionally empty — logic moved into run_pipeline.py for clarity.
# Keeping this file so existing imports don't break if referenced elsewhere.

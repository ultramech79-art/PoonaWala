# Item Match Debug Runs

This folder is for local investigation of same-item matching against Supabase
capture sessions.

Generated run folders are ignored by git because they can contain customer
capture images and model outputs.

Run from `apps/api`:

```bash
PYTHONPATH=. venv/bin/python debug/item_match/debug_supabase_sessions.py --max-sessions 20
```

Add `--remote` to include Groq semantic matching. Without `--remote`, the tool
uses only local visual fingerprints so it is faster and cheaper for first-pass
triage.

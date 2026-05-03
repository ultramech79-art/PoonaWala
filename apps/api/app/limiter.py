from slowapi import Limiter
from slowapi.util import get_remote_address

# Default rate limiter uses in-memory (falls back cleanly if Redis isn't configured)
limiter = Limiter(key_func=get_remote_address)

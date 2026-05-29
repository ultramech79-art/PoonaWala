"""
Structured logging setup. Call configure_logging() once at app startup.
"""
import logging
import sys


def configure_logging(level: str = "INFO") -> None:
    fmt = "%(asctime)s %(levelname)-8s %(name)s %(message)s"
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        format=fmt,
        stream=sys.stdout,
    )
    # Quiet noisy third-party loggers
    for noisy in ("appium", "selenium", "urllib3", "asyncio"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(name)

"""
Pydantic v2 models for HUID verification request and response.
"""
from enum import Enum
from typing import Optional
from pydantic import BaseModel, Field


class VerificationStatus(str, Enum):
    VERIFIED = "VERIFIED"
    NOT_VERIFIED = "NOT_VERIFIED"
    NEEDS_MANUAL_REVIEW = "NEEDS_MANUAL_REVIEW"
    INVALID_FORMAT = "INVALID_FORMAT"
    AGENT_ERROR = "AGENT_ERROR"


class HUIDVerificationResponse(BaseModel):
    huid: str = Field(..., description="The HUID that was queried (uppercased)")
    source: str = Field(default="BIS_CARE_APP")
    status: VerificationStatus
    confidence: int = Field(..., ge=0, le=100)
    purity: Optional[str] = Field(
        default=None,
        description="Purity string e.g. 22K916, 18K750, 14K585, 24K999",
    )
    article_type: Optional[str] = Field(default=None)
    jeweller_name: Optional[str] = Field(default=None)
    hallmark_date: Optional[str] = Field(default=None)
    raw_text: str = Field(default="", description="Raw page source / visible text captured from BIS CARE")
    screenshot_path: Optional[str] = Field(default=None)
    error: Optional[str] = Field(default=None)

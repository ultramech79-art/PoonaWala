from fastapi import APIRouter
from app.decision.ibja import price_metadata

router = APIRouter()

@router.get("/prices")
async def get_prices():
    """
    Fetch current gold prices for 24K, 22K, and 18K in ₹/g.
    Includes source metadata and cache age.
    """
    return price_metadata()

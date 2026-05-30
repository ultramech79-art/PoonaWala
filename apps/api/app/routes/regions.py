from fastapi import APIRouter

from app.data.india_regions import INDIA_REGIONS

router = APIRouter()


@router.get("/regions/india")
async def india_regions():
    return {
        "country": "IN",
        "source": "National Portal of India, Know India states and union territories",
        "count": len(INDIA_REGIONS),
        "regions": INDIA_REGIONS,
    }

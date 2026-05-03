import os
from fastapi import FastAPI
from dotenv import load_dotenv

load_dotenv()

app = FastAPI()

@app.get("/api/health")
async def health():
    return {
        "status": "ok",
        "service": "goldeye-api",
        "version": "0.1.0"
    }

handler = app

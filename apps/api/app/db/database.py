import os
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from sqlalchemy.orm import declarative_base

# Fallback to sqlite for dev if Postgres URL is not provided
# but the plan demands Postgres, so we use async psycopg by default.
_raw_url = os.getenv("DATABASE_URL", "sqlite+aiosqlite:///./goldeye.db")
# Render (and Heroku) issue postgres:// — SQLAlchemy needs postgresql+psycopg://
if _raw_url.startswith("postgres://"):
    _raw_url = _raw_url.replace("postgres://", "postgresql+psycopg://", 1)
elif _raw_url.startswith("postgresql://") and "+psycopg" not in _raw_url:
    _raw_url = _raw_url.replace("postgresql://", "postgresql+psycopg://", 1)
DATABASE_URL = _raw_url

# SQLite async driver needs different connection args than Postgres
connect_args = {"check_same_thread": False} if "sqlite" in DATABASE_URL else {}

engine = create_async_engine(
    DATABASE_URL,
    echo=False,
    connect_args=connect_args
)

AsyncSessionLocal = async_sessionmaker(
    bind=engine,
    autocommit=False,
    autoflush=False,
    expire_on_commit=False,
)

Base = declarative_base()

async def get_db():
    async with AsyncSessionLocal() as session:
        yield session

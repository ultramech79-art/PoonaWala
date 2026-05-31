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

# Supabase direct connections (5432) resolve to IPv6, which often fails in Docker/Render.
# The user must use the pooler URL from their Supabase dashboard instead.
DATABASE_URL = _raw_url

# SQLite async driver needs different connection args than Postgres.
# Supabase/pgBouncer transaction poolers can reject prepared statements during
# SQLAlchemy metadata introspection, so disable psycopg server-side prepares.
if "sqlite" in DATABASE_URL:
    connect_args = {"check_same_thread": False}
elif "postgresql+psycopg" in DATABASE_URL:
    connect_args = {"prepare_threshold": None}
else:
    connect_args = {}

engine = create_async_engine(
    DATABASE_URL,
    echo=False,
    connect_args=connect_args,
    pool_pre_ping=True,
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

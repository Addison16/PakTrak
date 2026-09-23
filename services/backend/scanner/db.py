from functools import lru_cache

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from scanner.settings import get_settings


@lru_cache
def session_factory():
    engine = create_engine(
        get_settings().database_url.get_secret_value(),
        pool_pre_ping=True,
        pool_size=5,
        max_overflow=5,
    )
    return sessionmaker(engine, expire_on_commit=False)


def get_db():
    with session_factory()() as session:
        yield session

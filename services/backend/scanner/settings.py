from functools import lru_cache
from urllib.parse import urlparse

from pydantic import Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="SCANNER_", extra="ignore")

    app_url: str = "http://localhost:8095"
    allow_insecure_http: bool = False
    database_url: SecretStr
    broker_url: SecretStr
    session_secret: SecretStr
    oidc_issuer: str
    oidc_internal_issuer: str
    oidc_client_id: str = "mtg-scanner"
    oidc_client_secret: SecretStr
    password_reset_client_id: str = "paktrak-account-admin"
    password_reset_client_secret: SecretStr | None = None
    identity_admin_password: SecretStr | None = None  # Only supplied to the one-shot bootstrap.
    storage_endpoint: str = "http://storage:8333"
    storage_bucket: str = "scanner-private"
    storage_access_key: SecretStr
    storage_secret_key: SecretStr
    max_upload_bytes: int = Field(default=100 * 1024 * 1024, gt=0)
    max_decoded_pixels: int = Field(default=60_000_000, gt=0)
    max_active_jobs: int = Field(default=2, ge=1, le=32)
    session_hours: int = Field(default=24, ge=1, le=168)
    dispatch_seconds: int = Field(default=10, ge=2)
    lease_seconds: int = Field(default=90, ge=75)
    job_deadline_hours: int = Field(default=24, ge=1, le=72)
    image_retention_days: int = Field(default=7, ge=1, le=90)
    max_attempts: int = Field(default=3, ge=1, le=10)

    @model_validator(mode="after")
    def validate_security(self):
        parsed = urlparse(self.app_url)
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.netloc
            or parsed.path not in {"", "/"}
        ):
            raise ValueError("SCANNER_APP_URL must be an absolute HTTP(S) origin")
        self.app_url = self.app_url.rstrip("/")
        if parsed.scheme != "https" and not self.allow_insecure_http:
            raise ValueError("HTTPS required; insecure HTTP needs explicit development opt-in")
        for field in ("session_secret", "oidc_client_secret", "storage_secret_key"):
            if len(getattr(self, field).get_secret_value()) < 32:
                raise ValueError(f"{field} must be a generated secret of at least 32 characters")
        return self

    @property
    def secure_cookies(self) -> bool:
        return self.app_url.startswith("https://")


@lru_cache
def get_settings() -> Settings:
    return Settings()

"""Prepare settings for the single-container PakTrak image.

Creates or completes the private settings file in the data volume, writes the
environment for every service, and renders the nginx configuration.
"""

import os
import re
import secrets
import shlex
import sys
from pathlib import Path
from urllib.parse import urlparse

DATA = Path("/data")
SETTINGS = DATA / "paktrak.env"
RUN = Path("/run/paktrak")
SECRETS = (
    "POSTGRES_PASSWORD",
    "SCANNER_DB_PASSWORD",
    "KEYCLOAK_DB_PASSWORD",
    "SESSION_SECRET",
    "OIDC_CLIENT_SECRET",
    "PASSWORD_RESET_CLIENT_SECRET",
    "STORAGE_ACCESS_KEY",
    "STORAGE_SECRET_KEY",
    "KEYCLOAK_ADMIN_PASSWORD",
)
WEB_PORT = 8095
API = "http://127.0.0.1:8000"
IDENTITY = "http://127.0.0.1:8180"


def fail(message):
    print(f"paktrak: {message}", file=sys.stderr)
    sys.exit(1)


def app_url():
    origin = os.environ.get("APP_URL", "").strip().rstrip("/")
    if not origin:
        fail(
            "Set APP_URL to the address you open PakTrak at, "
            "for example http://192.168.1.50:8095 or https://cards.example.net"
        )
    parsed = urlparse(origin)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.path
        or parsed.query
        or parsed.fragment
        or parsed.username
        or not re.fullmatch(r"[a-zA-Z0-9.\-:\[\]]+", parsed.netloc)
    ):
        fail(f"APP_URL must be an address like http://192.168.1.50:8095 with no path; got {origin!r}")
    return origin


def read_settings(path):
    values = {}
    if path.exists():
        for line in path.read_text().splitlines():
            key, sep, value = line.partition("=")
            if sep and re.fullmatch(r"[A-Z][A-Z0-9_]*", key):
                values[key] = value
    return values


def complete_settings():
    """Keep existing secrets and add any that are missing."""
    values = read_settings(SETTINGS)
    added = [name for name in SECRETS if not values.get(name)]
    if added:
        old_umask = os.umask(0o077)
        try:
            with SETTINGS.open("a") as settings:
                if SETTINGS.stat().st_size and not SETTINGS.read_text().endswith("\n"):
                    settings.write("\n")
                for name in added:
                    values[name] = secrets.token_urlsafe(36)
                    settings.write(f"{name}={values[name]}\n")
                settings.flush()
                os.fsync(settings.fileno())
        finally:
            os.umask(old_umask)
        if len(added) == len(SECRETS):
            print("paktrak: created private settings in /data/paktrak.env")
        else:
            print("paktrak: added missing private settings to /data/paktrak.env")
    SETTINGS.chmod(0o600)
    for name in SECRETS:
        if not re.fullmatch(r"[A-Za-z0-9_.~+/=-]{32,}", values[name]):
            fail(f"{name} in /data/paktrak.env must be a generated secret of at least 32 characters")
    return values


def environment(origin, values):
    max_upload = os.environ.get("MAX_UPLOAD_BYTES", "104857600")
    if not max_upload.isdigit():
        fail("MAX_UPLOAD_BYTES must be a number of bytes")
    env = {name: values[name] for name in SECRETS}
    env.update(
        {
            "APP_URL": origin,
            "SCANNER_APP_URL": origin,
            "SCANNER_ALLOW_INSECURE_HTTP": str(origin.startswith("http://")).lower(),
            "SCANNER_MAX_UPLOAD_BYTES": max_upload,
            "SCANNER_DATABASE_URL": f"postgresql+psycopg://scanner:{values['SCANNER_DB_PASSWORD']}@127.0.0.1/scanner",
            "SCANNER_BROKER_URL": "redis://127.0.0.1:6379/0",
            "SCANNER_SESSION_SECRET": values["SESSION_SECRET"],
            "SCANNER_OIDC_ISSUER": f"{origin}/identity/realms/scanner",
            "SCANNER_OIDC_INTERNAL_ISSUER": f"{IDENTITY}/identity/realms/scanner",
            "SCANNER_OIDC_CLIENT_SECRET": values["OIDC_CLIENT_SECRET"],
            "SCANNER_PASSWORD_RESET_CLIENT_SECRET": values["PASSWORD_RESET_CLIENT_SECRET"],
            "SCANNER_STORAGE_ENDPOINT": "http://127.0.0.1:8333",
            "SCANNER_STORAGE_ACCESS_KEY": values["STORAGE_ACCESS_KEY"],
            "SCANNER_STORAGE_SECRET_KEY": values["STORAGE_SECRET_KEY"],
            "POSTGRES_HOST": "127.0.0.1",
            "SCANNER_BACKUP_DIR": "/data/backups",
            # SeaweedFS creates its S3 admin identity from these.
            "AWS_ACCESS_KEY_ID": values["STORAGE_ACCESS_KEY"],
            "AWS_SECRET_ACCESS_KEY": values["STORAGE_SECRET_KEY"],
            "KC_DB_URL": "jdbc:postgresql://127.0.0.1/identity_service",
            "KC_DB_USERNAME": "identity_service",
            "KC_DB_PASSWORD": values["KEYCLOAK_DB_PASSWORD"],
            "KC_HTTP_ENABLED": "true",
            "KC_HTTP_HOST": "127.0.0.1",
            "KC_HTTP_PORT": "8180",
            "KC_HTTP_MANAGEMENT_PORT": "9000",
            "KC_HOSTNAME": f"{origin}/identity",
            "KC_PROXY_HEADERS": "xforwarded",
            "KC_BOOTSTRAP_ADMIN_USERNAME": "admin",
            "KC_BOOTSTRAP_ADMIN_PASSWORD": values["KEYCLOAK_ADMIN_PASSWORD"],
            "JAVA_OPTS_KC_HEAP": "-Xms128m -Xmx512m",
        }
    )
    return env


def nginx_config(origin):
    site = Path("/usr/share/paktrak/nginx-site.conf").read_text()
    replacements = {
        "${APP_URL}": origin,
        "resolver 127.0.0.11 valid=10s ipv6=off;": "",
        "http://api:8000": API,
        "http://identity:8080": IDENTITY,
        "listen 8080;": f"listen {WEB_PORT};",
        "root /usr/share/nginx/html;": "root /usr/share/paktrak/web;",
    }
    for old, new in replacements.items():
        if old not in site:
            fail(f"The bundled nginx configuration no longer contains {old!r}")
        site = site.replace(old, new)
    temp = RUN / "nginx"
    return f"""worker_processes auto;
pid {RUN}/nginx.pid;
error_log stderr warn;
daemon off;
events {{ worker_connections 1024; }}
http {{
    include /etc/nginx/mime.types;
    default_type application/octet-stream;
    sendfile on;
    keepalive_timeout 65;
    server_tokens off;
    client_body_temp_path {temp}/body;
    proxy_temp_path {temp}/proxy;
    fastcgi_temp_path {temp}/fastcgi;
    uwsgi_temp_path {temp}/uwsgi;
    scgi_temp_path {temp}/scgi;
{site}
}}
"""


def main():
    origin = app_url()
    values = complete_settings()
    env = environment(origin, values)
    old_umask = os.umask(0o077)
    try:
        (RUN / "env.sh").write_text("".join(f"export {key}={shlex.quote(value)}\n" for key, value in env.items()))
    finally:
        os.umask(old_umask)
    (RUN / "nginx.conf").write_text(nginx_config(origin))


if __name__ == "__main__":
    main()

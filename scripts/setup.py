"""Generate local secrets and identity/storage configuration without printing passwords."""

import argparse
import json
import os
import re
import secrets
from pathlib import Path
from urllib.parse import urlparse


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--upgrade",
        action="store_true",
        help="Add missing credentials to an existing installation without changing its settings",
    )
    parser.add_argument("--url", default="http://localhost:8095")
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8095)
    args = parser.parse_args()
    if args.upgrade:
        path = Path(".env")
        if not path.exists():
            parser.error("Run initial setup before upgrading configuration.")
        path.chmod(0o600)
        # Append under an exclusive lock so concurrent starts cannot rotate it.
        import fcntl

        with path.open("r+") as config:
            fcntl.flock(config, fcntl.LOCK_EX)
            contents = config.read()
            if not re.search(r"^PASSWORD_RESET_CLIENT_SECRET=.+$", contents, re.MULTILINE):
                if re.search(r"^PASSWORD_RESET_CLIENT_SECRET=", contents, re.MULTILINE):
                    parser.error(
                        "PASSWORD_RESET_CLIENT_SECRET is empty; set a generated secret of at least 32 characters."
                    )
                config.write(
                    ("" if contents.endswith("\n") else "\n")
                    + "PASSWORD_RESET_CLIENT_SECRET="
                    + secrets.token_urlsafe(36)
                    + "\n"
                )
                config.flush()
                os.fsync(config.fileno())
                print(
                    "Added the private password-management credential; existing settings were preserved."
                )
        return
    origin = args.url.rstrip("/")
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
        parser.error("--url must be an HTTP(S) origin without a path")
    if "\n" in origin or "$" in origin or "#" in origin or "'" in origin:
        parser.error("Unsupported origin characters")
    if parsed.scheme == "http" and parsed.hostname not in {"localhost", "127.0.0.1"}:
        parser.error("Use HTTPS for phone access; plain HTTP setup is limited to localhost")
    if Path(".env").exists() or Path("infra/generated").exists():
        parser.error("Configuration already exists. It will not be overwritten.")
    os.umask(0o077)
    values = {
        "APP_URL": origin,
        "HTTP_BIND": args.bind,
        "HTTP_PORT": str(args.port),
        "ALLOW_INSECURE_HTTP": str(parsed.scheme == "http").lower(),
        "MAX_UPLOAD_BYTES": str(100 * 1024 * 1024),
    }
    for name in (
        "POSTGRES_PASSWORD",
        "SCANNER_DB_PASSWORD",
        "KEYCLOAK_DB_PASSWORD",
        "SESSION_SECRET",
        "OIDC_CLIENT_SECRET",
        "PASSWORD_RESET_CLIENT_SECRET",
        "STORAGE_ACCESS_KEY",
        "STORAGE_SECRET_KEY",
        "KEYCLOAK_ADMIN_PASSWORD",
    ):
        values[name] = secrets.token_urlsafe(36)
    Path(".env").write_text("".join(f"{key}={value}\n" for key, value in values.items()))
    generated = Path("infra/generated")
    generated.mkdir(parents=True)
    realm = {
        "realm": "scanner",
        "enabled": True,
        "displayName": "PakTrak",
        "sslRequired": "none" if parsed.scheme == "http" else "external",
        "registrationAllowed": True,
        "passwordPolicy": "length(8)",
        "loginTheme": "paktrak",
        "resetPasswordAllowed": False,
        "bruteForceProtected": True,
        "clients": [
            {
                "clientId": "mtg-scanner",
                "enabled": True,
                "publicClient": False,
                "secret": values["OIDC_CLIENT_SECRET"],
                "standardFlowEnabled": True,
                "directAccessGrantsEnabled": False,
                "redirectUris": [origin + "/api/auth/callback"],
                "webOrigins": [origin],
                "attributes": {
                    "pkce.code.challenge.method": "S256",
                    "post.logout.redirect.uris": origin + "/",
                },
                "defaultClientScopes": ["web-origins", "profile", "email", "basic"],
            }
        ],
    }
    (generated / "scanner-realm.json").write_text(json.dumps(realm, indent=2))
    s3 = {
        "identities": [
            {
                "name": "scanner",
                "credentials": [
                    {
                        "accessKey": values["STORAGE_ACCESS_KEY"],
                        "secretKey": values["STORAGE_SECRET_KEY"],
                    }
                ],
                "actions": ["Admin", "Read", "Write", "List", "Tagging"],
            }
        ]
    }
    (generated / "s3.json").write_text(json.dumps(s3, indent=2))
    # The 0700 parent protects host access. Individual files are mounted read-only
    # into their designated service, whose uid may differ from the operator's.
    (generated / "scanner-realm.json").chmod(0o644)
    (generated / "s3.json").chmod(0o644)
    print("Created .env and infra/generated (private, excluded from git).")
    print("Open the application to create your administrator account on first launch.")
    print("Run docker compose up -d --build. Application origin: " + origin)


if __name__ == "__main__":
    main()

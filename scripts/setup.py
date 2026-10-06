"""Generate a private .env with local secrets without printing passwords."""

import argparse
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
    parser.add_argument("--image-version", help="Pin the installation to a published Docker image version")
    parser.add_argument(
        "--allow-http",
        action="store_true",
        help="Allow a plain HTTP address on a home network; the in-app camera then needs HTTPS",
    )
    args = parser.parse_args()
    if args.image_version:
        if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?", args.image_version) or len(args.image_version) > 127:
            parser.error("--image-version must be X.Y.Z or X.Y.Z-prerelease")
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
            if args.image_version:
                config.seek(0)
                contents = config.read()
                line = "PAKTRAK_VERSION=" + args.image_version
                if re.search(r"^PAKTRAK_VERSION=.*$", contents, re.MULTILINE):
                    contents = re.sub(r"^PAKTRAK_VERSION=.*$", line, contents, flags=re.MULTILINE)
                else:
                    contents += ("" if contents.endswith("\n") else "\n") + line + "\n"
                config.seek(0)
                config.write(contents)
                config.truncate()
                config.flush()
                os.fsync(config.fileno())
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
    if parsed.scheme == "http" and parsed.hostname not in {"localhost", "127.0.0.1"} and not args.allow_http:
        parser.error(
            "Use HTTPS for phone access. For plain HTTP on a home network, add --allow-http; "
            "the in-app camera then needs HTTPS, while phone camera and library uploads still work"
        )
    if Path(".env").exists() or Path("infra/generated").exists():
        parser.error("Configuration already exists. It will not be overwritten.")
    os.umask(0o077)
    values = {
        "APP_URL": origin,
        "HTTP_BIND": args.bind,
        "HTTP_PORT": str(args.port),
        "ALLOW_INSECURE_HTTP": str(parsed.scheme == "http").lower(),
        "MAX_UPLOAD_BYTES": str(100 * 1024 * 1024),
        "PAKTRAK_VERSION": args.image_version or "latest",
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
    print("Created .env (private, excluded from git).")
    print("Open the application to create your administrator account on first launch.")
    print("Run sh scripts/update.sh for the latest release, or sh scripts/start.sh --build for this source checkout. Application origin: " + origin)


if __name__ == "__main__":
    main()

import re
import time

import httpx
from alembic import command
from alembic.config import Config

from scanner.db import session_factory
from scanner.identity_admin import configure_reset_client
from scanner.identity_origin import IdentityConfigurationError, bind_origin
from scanner.settings import get_settings
from scanner.storage import ensure_bucket


def new_realm(settings):
    origin = settings.app_url
    return {
        "realm": "scanner",
        "enabled": True,
        "displayName": "PakTrak",
        "sslRequired": "external" if settings.secure_cookies else "none",
        "registrationAllowed": True,
        "passwordPolicy": "length(8)",
        "loginTheme": "paktrak",
        "resetPasswordAllowed": False,
        "bruteForceProtected": True,
        "clients": [
            {
                "clientId": settings.oidc_client_id,
                "enabled": True,
                "publicClient": False,
                "secret": settings.oidc_client_secret.get_secret_value(),
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


def configure_registration():
    settings = get_settings()
    if settings.identity_admin_password is None:
        raise RuntimeError("Bootstrap requires the identity administration credential.")
    base = settings.oidc_internal_issuer.rsplit("/realms/", 1)[0]
    with httpx.Client(timeout=10) as client:
        token = client.post(
            base + "/realms/master/protocol/openid-connect/token",
            data={
                "grant_type": "password",
                "client_id": "admin-cli",
                "username": "admin",
                "password": settings.identity_admin_password.get_secret_value(),
            },
        )
        token.raise_for_status()
        headers = {"Authorization": "Bearer " + token.json()["access_token"]}
        realm = client.get(base + "/admin/realms/scanner", headers=headers)
        if realm.status_code == 404:
            # Fresh installations create the realm here instead of importing a
            # generated file, so Compose needs no host configuration mounts.
            client.post(
                base + "/admin/realms", headers=headers, json=new_realm(settings)
            ).raise_for_status()
            print("Created the PakTrak sign-in realm.")
            realm = client.get(base + "/admin/realms/scanner", headers=headers)
        realm.raise_for_status()
        realm_data = realm.json()
        root = base + "/admin/realms/scanner"
        response = client.get(
            root + "/clients", headers=headers, params={"clientId": settings.oidc_client_id}
        )
        response.raise_for_status()
        login_clients = [
            item for item in response.json() if item["clientId"] == settings.oidc_client_id
        ]
        if len(login_clients) != 1:
            raise IdentityConfigurationError("The existing PakTrak sign-in client is missing.")
        login_client = login_clients[0]
        policy, replaced = re.subn(
            r"\blength\(\s*\d+\s*\)", "length(8)", realm_data.get("passwordPolicy") or ""
        )
        if not replaced:
            policy = " and ".join(filter(None, [policy, "length(8)"]))
        with session_factory()() as db, db.begin():
            moved = bind_origin(db, realm_data.get("id"), settings.oidc_issuer)
            # Enrollment is separate from application admission. Every new
            # subject is checked against the app's signup setting in the callback.
            client.put(
                root,
                headers=headers,
                json={
                    "registrationAllowed": True,
                    "bruteForceProtected": True,
                    "passwordPolicy": policy,
                    "displayName": "PakTrak",
                    "loginTheme": "paktrak",
                    "sslRequired": "external" if settings.secure_cookies else "none",
                    "attributes": {
                        **realm_data.get("attributes", {}),
                        "frontendUrl": settings.app_url + "/identity",
                    },
                },
            ).raise_for_status()
            # Update the actual login client on every boot, retaining unrelated
            # attributes and secrets.
            client.put(
                root + "/clients/" + login_client["id"],
                headers=headers,
                json={
                    "rootUrl": settings.app_url,
                    "baseUrl": "/",
                    "redirectUris": [settings.app_url + "/api/auth/callback"],
                    "webOrigins": [settings.app_url],
                    "attributes": {
                        **login_client.get("attributes", {}),
                        "pkce.code.challenge.method": "S256",
                        "post.logout.redirect.uris": settings.app_url + "/",
                    },
                },
            ).raise_for_status()
            discovery = client.get(
                settings.oidc_internal_issuer + "/.well-known/openid-configuration"
            )
            discovery.raise_for_status()
            if discovery.json().get("issuer") != settings.oidc_issuer:
                raise RuntimeError("The sign-in hostname has not finished updating.")
            # Basic scope carries auth_time, which fences password resets.
            response = client.get(root + "/client-scopes", headers=headers)
            response.raise_for_status()
            basic_scope = next(item["id"] for item in response.json() if item["name"] == "basic")
            client.put(
                root + f"/clients/{login_client['id']}/default-client-scopes/{basic_scope}",
                headers=headers,
            ).raise_for_status()
            secret = settings.password_reset_client_secret
            if secret is None or len(secret.get_secret_value()) < 32:
                raise RuntimeError("Password-reset setup requires its dedicated client credential.")
            configure_reset_client(
                client, base, headers, settings.password_reset_client_id, secret.get_secret_value()
            )
        if moved:
            print(
                f"Updated the sign-in address; preserved {moved} existing accounts and their data."
            )


def main():
    command.upgrade(Config("alembic.ini"), "head")
    for attempt in range(90):
        try:
            ensure_bucket()
            configure_registration()
            print("Database, private storage, and account registration are ready.")
            return
        except IdentityConfigurationError:
            raise
        except Exception:
            if attempt == 89:
                raise RuntimeError(
                    "Storage or identity bootstrap is not ready. Check service health and bootstrap credentials."
                ) from None
            time.sleep(2)


if __name__ == "__main__":
    main()

"""Bounded Keycloak credential operations; never expose provider response contents."""

import re
from contextlib import contextmanager
from urllib.parse import quote

import httpx

from scanner.settings import get_settings


class IdentityAdminError(Exception):
    pass


def identity_base():
    return get_settings().oidc_internal_issuer.rsplit("/realms/", 1)[0]


def identity_path(subject):
    # This installation uses Keycloak's local UUID subjects. Never treat a caller
    # supplied subject as a URL path, and never reset a different provider's user.
    if not re.fullmatch(r"[a-fA-F0-9-]{36}", subject):
        raise IdentityAdminError("This account cannot be reset through the sign-in service.")
    realm = get_settings().oidc_internal_issuer.rsplit("/realms/", 1)[1]
    return identity_base() + "/admin/realms/" + quote(realm, safe="") + "/users/" + subject


@contextmanager
def identity_client():
    settings = get_settings()
    secret = settings.password_reset_client_secret
    if secret is None or len(secret.get_secret_value()) < 32:
        raise IdentityAdminError(
            "Password resets are not configured. Restart PakTrak with scripts/start.sh to finish setup."
        )
    try:
        with httpx.Client(timeout=httpx.Timeout(10, connect=3), follow_redirects=False) as client:
            response = client.post(
                settings.oidc_internal_issuer + "/protocol/openid-connect/token",
                data={
                    "grant_type": "client_credentials",
                    "client_id": settings.password_reset_client_id,
                    "client_secret": secret.get_secret_value(),
                },
            )
            if response.status_code != 200:
                raise IdentityAdminError(
                    "The sign-in service could not authorize password management. Check its configuration and retry."
                )
            payload = response.json()
            token = payload.get("access_token") if isinstance(payload, dict) else None
            if not isinstance(token, str) or not token:
                raise IdentityAdminError(
                    "The sign-in service returned an invalid authorization response."
                )
            client.headers["Authorization"] = "Bearer " + token
            yield client
    except (httpx.HTTPError, ValueError, KeyError):
        # HTTP exception strings and response bodies may contain secrets.
        raise IdentityAdminError(
            "The sign-in service could not confirm the request. Try again shortly."
        ) from None


def identity_user(client, subject):
    response = client.get(identity_path(subject))
    if response.status_code != 200:
        raise IdentityAdminError(
            "The sign-in account could not be verified. Reload the account and try again."
        )
    data = response.json()
    if (
        not isinstance(data, dict)
        or data.get("id") != subject
        or data.get("serviceAccountClientId")
    ):
        raise IdentityAdminError("This sign-in account cannot be managed here.")
    return data


def set_temporary_password(client, subject, password):
    # Close SSO sessions before changing the credential; the application also
    # revokes its own sessions and fences callbacks throughout this operation.
    response = client.post(identity_path(subject) + "/logout")
    if response.status_code != 204:
        raise IdentityAdminError(
            "The sign-in service could not end the user’s sessions. Reload the account and retry the reset."
        )
    response = client.put(
        identity_path(subject) + "/reset-password",
        json={"type": "password", "temporary": True, "value": password},
    )
    if response.status_code != 204:
        raise IdentityAdminError(
            "The sign-in service did not confirm the password reset. Reload the account and reset again before sharing a password."
        )


def password_change_complete(subject):
    with identity_client() as client:
        return "UPDATE_PASSWORD" not in identity_user(client, subject).get("requiredActions", [])


def configure_reset_client(client, base, headers, client_id, secret):
    """Bootstrap-only provisioning; the master credential never reaches the API."""
    root = base + "/admin/realms/scanner"
    response = client.get(root + "/clients", headers=headers, params={"clientId": client_id})
    response.raise_for_status()
    existing = next((item for item in response.json() if item["clientId"] == client_id), None)
    if existing and existing.get("attributes", {}).get("paktrak.managed") != "password-resets-v1":
        raise RuntimeError("The password-reset client ID is already used by another configuration.")
    body = {
        "clientId": client_id,
        "name": "PakTrak password management",
        "enabled": True,
        "secret": secret,
        "publicClient": False,
        "serviceAccountsEnabled": True,
        "standardFlowEnabled": False,
        "implicitFlowEnabled": False,
        "directAccessGrantsEnabled": False,
        "fullScopeAllowed": False,
        "defaultClientScopes": ["roles"],
        "optionalClientScopes": [],
        "attributes": {"paktrak.managed": "password-resets-v1", "access.token.lifespan": "60"},
    }
    if existing:
        identifier = existing["id"]
        response = client.put(root + "/clients/" + identifier, headers=headers, json=body)
    else:
        response = client.post(root + "/clients", headers=headers, json=body)
        response.raise_for_status()
        identifier = response.headers["Location"].rsplit("/", 1)[1]
    response.raise_for_status()
    response = client.get(
        root + "/clients/" + identifier + "/service-account-user", headers=headers
    )
    response.raise_for_status()
    service_user = response.json()["id"]
    response = client.get(
        root + "/clients", headers=headers, params={"clientId": "realm-management"}
    )
    response.raise_for_status()
    management = next(
        item["id"] for item in response.json() if item["clientId"] == "realm-management"
    )
    response = client.get(root + "/clients/" + management + "/roles/manage-users", headers=headers)
    response.raise_for_status()
    role = response.json()
    for path in [
        f"/users/{service_user}/role-mappings/clients/{management}",
        f"/clients/{identifier}/scope-mappings/clients/{management}",
    ]:
        response = client.post(root + path, headers=headers, json=[role])
        response.raise_for_status()
    return identifier

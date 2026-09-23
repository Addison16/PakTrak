"""Provision and remove a disposable OIDC client with its own loopback callback."""

import json
import secrets
import sys
import urllib.parse
import urllib.request
from pathlib import Path

import httpx


def main():
    action, destination = sys.argv[1:]
    config = dict(
        line.split("=", 1)
        for line in Path(".env").read_text().splitlines()
        if line and not line.startswith("#")
    )
    host = config.get("HTTP_BIND", "127.0.0.1")
    if host in {"0.0.0.0", "::"}:
        host = "127.0.0.1"
    base = f"http://{host}:{config.get('HTTP_PORT', '8095')}/identity"
    data = urllib.parse.urlencode(
        {
            "client_id": "admin-cli",
            "grant_type": "password",
            "username": "admin",
            "password": config["KEYCLOAK_ADMIN_PASSWORD"],
        }
    ).encode()
    with urllib.request.urlopen(
        urllib.request.Request(base + "/realms/master/protocol/openid-connect/token", data=data),
        timeout=15,
    ) as response:
        token = json.load(response)["access_token"]
    headers = {"Authorization": "Bearer " + token, "Content-Type": "application/json"}
    path = Path(destination)
    if action == "create":
        client = {
            "client_id": "scanner-e2e-accounts-" + secrets.token_hex(8),
            "secret": secrets.token_urlsafe(36),
        }
        body = {
            "clientId": client["client_id"],
            "secret": client["secret"],
            "publicClient": False,
            "standardFlowEnabled": True,
            "directAccessGrantsEnabled": False,
            "redirectUris": ["http://localhost:18097/api/auth/callback"],
            "webOrigins": ["http://localhost:18097"],
            "defaultClientScopes": ["profile", "email", "basic"],
            "attributes": {
                "pkce.code.challenge.method": "S256",
                "post.logout.redirect.uris": "http://localhost:18097/",
            },
        }
        with urllib.request.urlopen(
            urllib.request.Request(
                base + "/admin/realms/scanner/clients",
                data=json.dumps(body).encode(),
                headers=headers,
            ),
            timeout=15,
        ) as response:
            client["id"] = response.headers["Location"].rsplit("/", 1)[1]
        path.write_text(json.dumps(client))
        path.chmod(0o600)
        # A separate service client keeps reset privileges off the OIDC login client.
        sys.path.insert(0, str(Path.cwd() / "services/backend"))
        from scanner.identity_admin import configure_reset_client

        client["reset_client_id"] = "scanner-e2e-passwords-" + secrets.token_hex(8)
        client["reset_secret"] = secrets.token_urlsafe(36)
        path.write_text(json.dumps(client))
        with httpx.Client(timeout=15) as provider:
            client["reset_id"] = configure_reset_client(
                provider, base, headers, client["reset_client_id"], client["reset_secret"]
            )
        path.write_text(json.dumps(client))
    elif action == "remove":
        client = json.loads(path.read_text())
        assert client["client_id"].startswith("scanner-e2e-accounts-")
        with urllib.request.urlopen(
            urllib.request.Request(
                base + "/admin/realms/scanner/clients/" + client["id"],
                headers=headers,
                method="DELETE",
            ),
            timeout=15,
        ):
            pass
        reset_client = client.get("reset_client_id")
        if reset_client:
            assert reset_client.startswith("scanner-e2e-passwords-")
            with httpx.Client(timeout=15) as provider:
                response = provider.get(
                    base + "/admin/realms/scanner/clients",
                    headers=headers,
                    params={"clientId": reset_client},
                )
                response.raise_for_status()
                for saved in response.json():
                    assert saved["clientId"] == reset_client
                    provider.delete(
                        base + "/admin/realms/scanner/clients/" + saved["id"], headers=headers
                    ).raise_for_status()
        path.unlink()
    else:
        raise ValueError("Choose create or remove")


if __name__ == "__main__":
    main()

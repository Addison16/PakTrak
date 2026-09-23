"""Isolated API for real browser signup tests; never points at the live app database."""

import json
import os
import sys


def main():
    original = os.environ["SCANNER_DATABASE_URL"]
    assert original.endswith("/scanner_test"), "Start with the Compose tests service"
    os.environ["SCANNER_DATABASE_URL"] = (
        original.removesuffix("/scanner_test") + "/scanner_accounts_e2e"
    )
    config = json.loads(open(sys.argv[1]).read())
    os.environ["SCANNER_APP_URL"] = "http://localhost:18097"
    os.environ["SCANNER_ALLOW_INSECURE_HTTP"] = "true"
    os.environ["SCANNER_OIDC_CLIENT_ID"] = config["client_id"]
    os.environ["SCANNER_OIDC_CLIENT_SECRET"] = config["secret"]
    os.environ["SCANNER_PASSWORD_RESET_CLIENT_ID"] = config["reset_client_id"]
    os.environ["SCANNER_PASSWORD_RESET_CLIENT_SECRET"] = config["reset_secret"]
    import uvicorn
    from alembic import command
    from alembic.config import Config

    command.upgrade(Config("alembic.ini"), "head")
    uvicorn.run("scanner.api:app", host="0.0.0.0", port=8000, access_log=False)


if __name__ == "__main__":
    main()

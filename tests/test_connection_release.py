import asyncio

from fastapi import Request

from scanner.api import live
from scanner.auth import COOKIE, current_session, require_admin
from scanner.db import session_factory


def signed_in_request(client, method="GET"):
    cookie = f"{COOKIE}={client.cookies.get(COOKIE)}".encode()
    return Request({"type": "http", "method": method, "headers": [(b"cookie", cookie)]})


def test_sign_in_check_hands_back_its_database_connection(clients):
    # Sync dependencies and the endpoint after them each wait for a worker thread.
    # Holding a connection in between let a burst of card pictures take every
    # connection while every thread waited for one, and the server went quiet.
    client, owner_id = clients()
    with session_factory()() as db:
        identity = current_session(signed_in_request(client), db)
        assert not db.in_transaction()
        assert identity.owner_id == owner_id and identity.csrf_token


def test_administrator_check_hands_back_its_database_connection(clients):
    client, owner_id = clients(role="admin")
    with session_factory()() as db:
        user = require_admin(current_session(signed_in_request(client), db), db)
        assert not db.in_transaction()
        assert user.id == owner_id and user.role == "admin"


def test_health_check_answers_without_a_worker_thread():
    assert asyncio.iscoroutinefunction(live)
    assert asyncio.run(live()) == {"status": "ok"}

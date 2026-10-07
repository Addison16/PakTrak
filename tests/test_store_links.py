import pytest

from scanner.db import session_factory
from scanner.models import AccountPolicy

EMPTY = {"tcgplayer": None, "cardkingdom": None, "manapool": None}


@pytest.fixture
def admin(clients):
    client, _ = clients(role="admin")
    with session_factory()() as db:
        policy = db.get(AccountPolicy, 1)
        original = {
            name: getattr(policy, name)
            for name in ("tcgplayer_affiliate", "cardkingdom_affiliate", "manapool_affiliate")
        }
    yield client
    with session_factory()() as db, db.begin():
        policy = db.get(AccountPolicy, 1)
        for name, value in original.items():
            setattr(policy, name, value)


def save(client, **changes):
    version = client.get("/api/auth/settings").json()["version"]
    return client.post("/api/auth/settings", json={**changes, "expected_version": version})


def test_referral_links_are_admin_only_and_shared_with_every_account(clients, admin):
    assert admin.get("/api/auth/settings").json()["store_links"] == EMPTY
    member, _ = clients(role="member")
    assert (
        member.post(
            "/api/auth/settings", json={"tcgplayer_affiliate": "abc", "expected_version": 1}
        ).status_code
        == 403
    )

    tracking = "https://tcgplayer.pxf.io/c/123/456/789"
    response = save(admin, tcgplayer_affiliate=f"  {tracking}  ", manapool_affiliate="myref")
    assert response.status_code == 200, response.text
    links = {"tcgplayer": tracking, "cardkingdom": None, "manapool": "myref"}
    assert response.json()["store_links"] == links
    for role in ("guest", "member", "admin"):
        client, _ = clients(role=role)
        assert client.get("/api/auth/session").json()["store_links"] == links

    # Saving one store leaves the others alone; an empty value turns a store off.
    assert (
        save(admin, cardkingdom_affiliate="ck-partner").json()["store_links"]["tcgplayer"]
        == tracking
    )
    cleared = save(admin, tcgplayer_affiliate="", manapool_affiliate=None).json()["store_links"]
    assert cleared == {"tcgplayer": None, "cardkingdom": "ck-partner", "manapool": None}
    # Older clients changing a switch keep the saved links.
    assert (
        save(admin, guest_signup_enabled=True).json()["store_links"]["cardkingdom"] == "ck-partner"
    )


@pytest.mark.parametrize(
    "value",
    [
        "http://tcgplayer.pxf.io/c/1",
        "javascript:alert(1)",
        "https://user:pw@example.com/",
        "has spaces",
        'https://example.com/"onclick',
        "https://example.com/" + "a" * 500,
        "code/with/slashes",
    ],
)
def test_referral_links_reject_unsafe_values(admin, value):
    response = save(admin, tcgplayer_affiliate=value)
    assert response.status_code == 422
    assert admin.get("/api/auth/settings").json()["store_links"]["tcgplayer"] is None

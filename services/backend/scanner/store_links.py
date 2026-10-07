"""Site-wide store referral settings that the web app adds to store links."""

import re
from urllib.parse import urlparse

STORES = ("tcgplayer", "cardkingdom", "manapool")
FIELDS = tuple(f"{store}_affiliate" for store in STORES)
CODE = re.compile(r"[A-Za-z0-9._-]{1,64}")


def clean_affiliate(value):
    """Return a referral code or tracking link, or None to turn the store's referral off."""
    if value is None:
        return None
    value = value.strip()
    if not value:
        return None
    if CODE.fullmatch(value):
        return value
    parsed = urlparse(value.replace("{url}", "x"))
    if (
        len(value) <= 500
        and parsed.scheme == "https"
        and parsed.hostname
        and not parsed.username
        and not parsed.password
        and not any(char.isspace() or char in "<>\"'" for char in value)
    ):
        return value
    raise ValueError(
        "Enter a referral code (letters, numbers, . _ -) or an https:// tracking link."
    )


def store_links(policy):
    return {store: getattr(policy, f"{store}_affiliate") for store in STORES}

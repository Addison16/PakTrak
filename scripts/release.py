"""Resolve published PakTrak releases and validate registry-compatible release tags."""

import argparse
import json
import re
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

RELEASE_TAG = re.compile(r"v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*))?")
API = "https://api.github.com/repos/Addison16/PakTrak/releases"


def image_version(tag):
    if not RELEASE_TAG.fullmatch(tag) or len(tag) > 128:
        raise ValueError("Release tags must be vX.Y.Z or vX.Y.Z-prerelease (at most 128 characters).")
    return tag[1:]


def resolve_release(version=""):
    tag = (version if version.startswith("v") else "v" + version) if version else ""
    if tag:
        image_version(tag)
    endpoint = f"{API}/tags/{tag}" if tag else f"{API}/latest"
    request = Request(endpoint, headers={"Accept": "application/vnd.github+json", "User-Agent": "PakTrak-updater"})
    with urlopen(request, timeout=30) as response:
        release = json.load(response)
    resolved = release.get("tag_name", "")
    image_version(resolved)
    if release.get("draft") or not release.get("published_at"):
        raise ValueError("The selected release has not been published.")
    if tag and resolved != tag:
        raise ValueError("GitHub returned a different release tag.")
    if not tag and (release.get("prerelease") or "-" in resolved):
        raise ValueError("The latest release must be a stable vX.Y.Z release.")
    return resolved


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["resolve", "validate"])
    parser.add_argument("version", nargs="?", default="")
    args = parser.parse_args()
    try:
        print(resolve_release(args.version) if args.command == "resolve" else image_version(args.version))
    except HTTPError as error:
        parser.exit(1, f"GitHub release lookup failed (HTTP {error.code}); check that the release is published and retry.\n")
    except (URLError, TimeoutError, ValueError) as error:
        parser.exit(1, f"Release lookup failed: {error}\n")


if __name__ == "__main__":
    main()

"""Shared collector-number shortcut for local card searches."""

import re


def split_collector_search(query: str) -> tuple[str, str]:
    """Split a trailing #287 or #123a, preserving the printed number as text."""
    text = query.strip()
    match = re.fullmatch(r"(.*?)\s*#\s*([^\s#]{1,32})", text)
    return (match[1].strip(), match[2]) if match else (text, "")

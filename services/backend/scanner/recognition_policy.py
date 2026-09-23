"""Owner-selected automatic-import rule using server-computed match strength.

This score is not a calibrated probability. Never accept it from an API body.
"""

import uuid

AUTO_IMPORT_THRESHOLD = 0.88
AUTO_IMPORT_POLICY = "match-strength-v1"


def may_auto_import(result):
    candidates = result.get("candidates")
    if result.get("status") != "MATCHED" or not isinstance(candidates, list) or not candidates:
        return False
    candidate = candidates[0]
    if not isinstance(candidate, dict):
        return False
    try:
        uuid.UUID(candidate.get("printing_id", ""))
    except (ValueError, TypeError, AttributeError):
        return False
    strength = candidate.get("match_score")
    return bool(
        isinstance(strength, (int, float))
        and not isinstance(strength, bool)
        and AUTO_IMPORT_THRESHOLD < strength <= 1
    )

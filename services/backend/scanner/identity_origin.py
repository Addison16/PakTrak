"""Bootstrap-only origin changes, authorized by the pinned local identity realm."""

from sqlalchemy import delete, select, text, update

from scanner.models import IdentityBinding, LoginSession, User, now


class IdentityConfigurationError(RuntimeError):
    """An unsafe identity change must stop startup instead of creating new accounts."""


def bind_origin(db, realm_id, issuer):
    """Called inside the bootstrap transaction after authenticating the local provider.

    The provider's immutable realm ID is the authority for a hostname change.
    Never join accounts by their display name, email, or an unverified subject.
    Provider configuration and discovery must succeed before the caller commits.
    """
    if not isinstance(realm_id, str) or not realm_id or len(realm_id) > 255:
        raise IdentityConfigurationError("The sign-in service did not provide a valid realm ID.")
    db.execute(text("SELECT pg_advisory_xact_lock(733184920)"))
    binding = db.scalar(select(IdentityBinding).where(IdentityBinding.id == 1).with_for_update())
    if binding is not None and binding.realm_id != realm_id:
        raise IdentityConfigurationError(
            "The sign-in realm has changed. Restore the original identity database; "
            "changing APP_URL must not replace the realm or its users. No accounts were moved."
        )
    previous = binding.issuer if binding else issuer
    if db.scalar(select(User.id).where(User.issuer != previous).limit(1)) is not None:
        raise IdentityConfigurationError(
            "Existing accounts belong to an unrecognized sign-in address. "
            "Keep the original APP_URL when first upgrading, then restart before changing it. "
            "If an earlier address change already created duplicate accounts, recover their "
            "original identities from the existing database first. Do not delete volumes."
        )
    if binding is None:
        db.add(IdentityBinding(id=1, realm_id=realm_id, issuer=issuer))
        db.flush()
        return 0
    if previous == issuer:
        return 0
    # Keep every owner UUID and all account controls. New-origin login must be
    # fresh; old application cookies cannot retain a session across the move.
    owners = select(User.id).where(User.issuer == previous)
    db.execute(delete(LoginSession).where(LoginSession.owner_id.in_(owners)))
    result = db.execute(update(User).where(User.issuer == previous).values(issuer=issuer))
    binding.issuer = issuer
    binding.updated_at = now()
    db.flush()
    return result.rowcount

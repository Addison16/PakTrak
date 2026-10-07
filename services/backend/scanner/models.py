import uuid
from datetime import UTC, date, datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    Numeric,
    String,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


def now() -> datetime:
    return datetime.now(UTC)


class Base(DeclarativeBase):
    pass


class DataFeed(Base):
    __tablename__ = "data_feeds"
    name: Mapped[str] = mapped_column(String(32), primary_key=True)
    state: Mapped[str] = mapped_column(String(16), default="WAITING")
    progress: Mapped[dict] = mapped_column(JSONB, default=dict)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    next_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    source_time: Mapped[str | None] = mapped_column(String(100))
    error: Mapped[str | None] = mapped_column(String(255))
    records: Mapped[int] = mapped_column(Integer, default=0)
    failures: Mapped[int] = mapped_column(Integer, default=0)


class CardPrice(Base):
    __tablename__ = "card_prices"
    __table_args__ = (
        CheckConstraint("amount > 0", name="card_price_positive"),
        CheckConstraint("finish IN ('nonfoil','foil','etched')", name="card_price_finish"),
    )
    printing_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("card_printings.id", ondelete="CASCADE"), primary_key=True
    )
    provider: Mapped[str] = mapped_column(String(32), primary_key=True)
    finish: Mapped[str] = mapped_column(String(16), primary_key=True)
    amount: Mapped[float] = mapped_column(Numeric(16, 4))
    url: Mapped[str | None] = mapped_column(String(1024))
    available: Mapped[bool | None] = mapped_column(Boolean)


class WorkProgress(Base):
    """Separate from the job's locked transaction so a phone can read live progress."""

    __tablename__ = "work_progress"
    job_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("jobs.id", ondelete="CASCADE"), primary_key=True
    )
    token: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    data: Mapped[dict] = mapped_column(JSONB, default=dict)


class User(Base):
    __tablename__ = "users"
    __table_args__ = (
        UniqueConstraint("issuer", "subject"),
        CheckConstraint("role IN ('admin','member','guest')", name="user_valid_role"),
        CheckConstraint("scan_cards_used >= 0", name="user_scan_cards_nonnegative"),
        CheckConstraint("scan_card_limit_override >= 0", name="user_scan_limit_nonnegative"),
        CheckConstraint("account_version >= 1", name="user_account_version_positive"),
        CheckConstraint(
            "preferred_price_source IN ('tcgplayer','cardkingdom','manapool')",
            name="user_valid_price_source",
        ),
        CheckConstraint(
            "price_alert_percent BETWEEN 1 AND 1000", name="user_price_alert_percent_range"
        ),
        CheckConstraint("price_alert_amount > 0", name="user_price_alert_amount_positive"),
    )
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    issuer: Mapped[str] = mapped_column(String(512))
    subject: Mapped[str] = mapped_column(String(255))
    display_name: Mapped[str] = mapped_column(String(255))
    password_reset_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    password_reset_pending: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="false"
    )
    profile_name: Mapped[str | None] = mapped_column(String(80))
    suspended: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    scans_paused: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    scan_card_limit_override: Mapped[int | None] = mapped_column(Integer)
    account_version: Mapped[int] = mapped_column(Integer, default=1, server_default="1")
    role: Mapped[str] = mapped_column(String(16), default="guest", server_default="guest")
    scan_cards_used: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    approval_notice_pending: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="false"
    )
    preferred_price_source: Mapped[str | None] = mapped_column(String(32))
    tour_dismissed: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    # A private code another account enters to send a friend request. Empty means
    # no one can find this account, and accounts are never listed to each other.
    friend_code: Mapped[str | None] = mapped_column(String(16), unique=True)
    share_collection: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    share_wishlist: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    # A change must meet every threshold that is set, so cheap cards don't alert on cents.
    price_alerts_enabled: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    price_alert_percent: Mapped[int | None] = mapped_column(
        Integer, default=20, server_default="20"
    )
    price_alert_amount: Mapped[object | None] = mapped_column(
        Numeric(10, 2), default=1, server_default="1.00"
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class PriceAlertBaseline(Base):
    """The price each owner last saw for an owned finish; alerts compare against it."""

    __tablename__ = "price_alert_baselines"
    __table_args__ = (CheckConstraint("amount > 0", name="price_alert_baseline_positive"),)
    owner_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    printing_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("card_printings.id", ondelete="CASCADE"), primary_key=True
    )
    finish: Mapped[str] = mapped_column(String(16), primary_key=True)
    provider: Mapped[str] = mapped_column(String(32))
    amount: Mapped[object] = mapped_column(Numeric(16, 4))
    seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    # When watching began; copies added later can't keep an older baseline alive.
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class IdentityBinding(Base):
    """Pin the local realm's stable ID separately from its changeable public address."""

    __tablename__ = "identity_binding"
    __table_args__ = (CheckConstraint("id = 1", name="identity_binding_singleton"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    realm_id: Mapped[str] = mapped_column(String(255))
    issuer: Mapped[str] = mapped_column(String(512))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class LoginSession(Base):
    __tablename__ = "login_sessions"
    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    owner_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    csrf_token: Mapped[str] = mapped_column(String(64))
    approval_notice_eligible: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="false"
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)


class AccountEvent(Base):
    __tablename__ = "account_events"
    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    owner_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    actor_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    kind: Mapped[str] = mapped_column(String(32))
    detail: Mapped[dict] = mapped_column(JSONB, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class RequestErrorLog(Base):
    __tablename__ = "request_error_logs"
    id: Mapped[uuid.UUID] = mapped_column(primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, index=True)
    owner_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    method: Mapped[str] = mapped_column(String(16))
    route: Mapped[str] = mapped_column(String(255))
    status: Mapped[int] = mapped_column(Integer)
    code: Mapped[str] = mapped_column(String(64))
    summary: Mapped[str] = mapped_column(String(255))
    duration_ms: Mapped[int] = mapped_column(Integer)
    context: Mapped[dict] = mapped_column(JSONB, default=dict)


class AccountPolicy(Base):
    __tablename__ = "account_policy"
    __table_args__ = (CheckConstraint("id = 1", name="account_policy_singleton"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    guest_signup_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    enhanced_scanning_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    tcgplayer_affiliate: Mapped[str | None] = mapped_column(String(500))
    cardkingdom_affiliate: Mapped[str | None] = mapped_column(String(500))
    manapool_affiliate: Mapped[str | None] = mapped_column(String(500))
    version: Mapped[int] = mapped_column(Integer, default=1)


class Scan(Base):
    __tablename__ = "scans"
    __table_args__ = (
        UniqueConstraint("owner_id", "request_key"),
        CheckConstraint("expected_bytes > 0", name="scan_positive_bytes"),
        CheckConstraint("foil_count BETWEEN 0 AND 32", name="scan_foil_count_valid"),
        CheckConstraint(
            "state IN ('UPLOADING','QUEUED','PROCESSING','PHOTO_READY','FAILED','EXPIRED')",
            name="scan_state_valid",
        ),
        Index("scan_owner_created", "owner_id", "created_at", "id"),
    )
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    owner_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    request_key: Mapped[str] = mapped_column(String(128))
    request_hash: Mapped[str] = mapped_column(String(64))
    filename: Mapped[str] = mapped_column(String(255))
    mime_type: Mapped[str] = mapped_column(String(64))
    expected_bytes: Mapped[int] = mapped_column(BigInteger)
    foil_count: Mapped[int | None] = mapped_column(Integer)
    finish_selection: Mapped[dict | None] = mapped_column(JSONB)
    add_to_collection: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    target_deck_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("decks.id", ondelete="SET NULL"), index=True
    )
    state: Mapped[str] = mapped_column(String(32), default="UPLOADING")
    source_key: Mapped[str | None] = mapped_column(String(512))
    sha256: Mapped[str | None] = mapped_column(String(64), index=True)
    prepared_key: Mapped[str | None] = mapped_column(String(512))
    thumbnail_key: Mapped[str | None] = mapped_column(String(512))
    width: Mapped[int | None] = mapped_column(Integer)
    height: Mapped[int | None] = mapped_column(Integer)
    accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class Job(Base):
    __tablename__ = "jobs"
    __table_args__ = (
        CheckConstraint(
            "state IN ('QUEUED','RUNNING','SUCCEEDED','FAILED')", name="job_state_valid"
        ),
        CheckConstraint("attempts >= 0", name="job_attempts_nonnegative"),
        CheckConstraint("num_nonnulls(scan_id, import_id, export_id) = 1", name="job_one_resource"),
        CheckConstraint(
            "(kind = 'PREPARE_IMAGE' AND scan_id IS NOT NULL) OR (kind IN ('IMPORT_PREVIEW','IMPORT_COMMIT','IMPORT_UNDO') AND import_id IS NOT NULL) OR (kind = 'EXPORT' AND export_id IS NOT NULL)",
            name="job_kind_resource",
        ),
        UniqueConstraint("import_id", "kind"),
        Index("job_reconcile", "state", "lease_until"),
    )
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    scan_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("scans.id", ondelete="CASCADE"), unique=True
    )
    import_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("imports.id", ondelete="CASCADE")
    )
    export_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("exports.id", ondelete="CASCADE"), unique=True
    )
    kind: Mapped[str] = mapped_column(String(32), default="PREPARE_IMAGE")
    state: Mapped[str] = mapped_column(String(16), default="QUEUED")
    stage: Mapped[str] = mapped_column(String(64), default="Waiting for a server worker")
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    lease_token: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    lease_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    deadline_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    error_code: Mapped[str | None] = mapped_column(String(64))
    error_message: Mapped[str | None] = mapped_column(String(512))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    result: Mapped[dict | None] = mapped_column(JSONB)


class Outbox(Base):
    __tablename__ = "outbox"
    job_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("jobs.id", ondelete="CASCADE"), primary_key=True
    )
    available_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    last_sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    send_count: Mapped[int] = mapped_column(Integer, default=0)


class CatalogSnapshot(Base):
    __tablename__ = "catalog_snapshots"
    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    source: Mapped[str] = mapped_column(String(512))
    checksum: Mapped[str] = mapped_column(String(64), unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    printings: Mapped[int] = mapped_column(Integer)


class Printing(Base):
    __tablename__ = "card_printings"
    __table_args__ = (Index("printing_identifiers", "set_code", "collector_number", "language"),)
    id: Mapped[uuid.UUID] = mapped_column(primary_key=True)  # Scryfall printing ID, never invented.
    oracle_id: Mapped[uuid.UUID | None] = mapped_column(index=True)
    name: Mapped[str] = mapped_column(String(255), index=True)
    set_code: Mapped[str] = mapped_column(String(16))
    collector_number: Mapped[str] = mapped_column(String(32))
    language: Mapped[str] = mapped_column(String(16))
    finishes: Mapped[list] = mapped_column(JSONB)
    source_json: Mapped[dict] = mapped_column(JSONB)
    snapshot_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("catalog_snapshots.id"))


class Binder(Base):
    __tablename__ = "binders"
    __table_args__ = (UniqueConstraint("owner_id", "name"), UniqueConstraint("id", "owner_id"))
    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    owner_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(String(255))
    kind: Mapped[str] = mapped_column(String(16), default="binder", server_default="binder")
    notes: Mapped[str] = mapped_column(String(1024), default="", server_default="")
    version: Mapped[int] = mapped_column(Integer, default=1, server_default="1")


class Deck(Base):
    __tablename__ = "decks"
    __table_args__ = (
        UniqueConstraint("owner_id", "request_key"),
        CheckConstraint("match_mode IN ('any','exact')", name="deck_match_mode_valid"),
    )
    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    owner_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    request_key: Mapped[str] = mapped_column(String(128))
    request_hash: Mapped[str] = mapped_column(String(64))
    name: Mapped[str] = mapped_column(String(255))
    format: Mapped[str] = mapped_column(String(32), default="casual")
    match_mode: Mapped[str] = mapped_column(String(16), default="any", server_default="any")
    notes: Mapped[str] = mapped_column(String(4096), default="")
    version: Mapped[int] = mapped_column(Integer, default=1)
    last_edit_key: Mapped[str | None] = mapped_column(String(128))
    last_edit_hash: Mapped[str | None] = mapped_column(String(64))
    archived: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class DeckCard(Base):
    __tablename__ = "deck_cards"
    __table_args__ = (
        CheckConstraint("quantity > 0 AND quantity <= 100000", name="deck_card_positive_quantity"),
        CheckConstraint(
            "section IN ('main','sideboard','commander')", name="deck_card_valid_section"
        ),
    )
    deck_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("decks.id", ondelete="CASCADE"), primary_key=True
    )
    printing_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("card_printings.id"), primary_key=True
    )
    section: Mapped[str] = mapped_column(String(16), primary_key=True)
    quantity: Mapped[int] = mapped_column(Integer)


class Observation(Base):
    __tablename__ = "observations"
    __table_args__ = (
        UniqueConstraint("scan_id", "region_index"),
        CheckConstraint(
            "finish IN ('unknown','nonfoil','foil','etched')", name="observation_finish_valid"
        ),
    )
    id: Mapped[uuid.UUID] = mapped_column(primary_key=True)
    scan_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("scans.id", ondelete="CASCADE"))
    region_index: Mapped[int] = mapped_column(Integer)
    polygon: Mapped[list] = mapped_column(JSONB)
    crop_key: Mapped[str | None] = mapped_column(String(512))
    detector_version: Mapped[str] = mapped_column(String(64))
    state: Mapped[str] = mapped_column(String(32), default="NEEDS_REVIEW")
    version: Mapped[int] = mapped_column(Integer, default=1)
    recognition: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}")
    finish: Mapped[str] = mapped_column(String(32), default="unknown", server_default="unknown")
    confirmed_printing_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("card_printings.id"))


class DeckScanCard(Base):
    """One physical card from a saved photo can be added to a deck only once."""

    __tablename__ = "deck_scan_cards"
    __table_args__ = (Index("deck_scan_request", "deck_id", "request_key"),)
    deck_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("decks.id", ondelete="CASCADE"), primary_key=True
    )
    observation_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("observations.id", ondelete="CASCADE"), primary_key=True
    )
    request_key: Mapped[str] = mapped_column(String(128))
    request_hash: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class ImportBatch(Base):
    __tablename__ = "imports"
    __table_args__ = (
        UniqueConstraint("owner_id", "request_key"),
        Index("import_owner_checksum", "owner_id", "checksum"),
    )
    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    owner_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    request_key: Mapped[str] = mapped_column(String(128))
    request_hash: Mapped[str] = mapped_column(String(64))
    filename: Mapped[str] = mapped_column(String(255))
    checksum: Mapped[str] = mapped_column(String(64))
    source_key: Mapped[str | None] = mapped_column(String(512))
    format: Mapped[str] = mapped_column(String(32), default="auto")
    adapter_version: Mapped[str] = mapped_column(String(32), default="csv-v1")
    mapping: Mapped[dict] = mapped_column(JSONB, default=dict)
    options: Mapped[dict] = mapped_column(JSONB, default=dict)
    headers: Mapped[list] = mapped_column(JSONB, default=list)
    revision: Mapped[int] = mapped_column(Integer, default=1)
    state: Mapped[str] = mapped_column(String(32), default="PREVIEWING")
    summary: Mapped[dict] = mapped_column(JSONB, default=dict)
    error: Mapped[str | None] = mapped_column(String(512))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class ImportRow(Base):
    __tablename__ = "import_rows"
    __table_args__ = (UniqueConstraint("import_id", "row_number"),)
    id: Mapped[uuid.UUID] = mapped_column(primary_key=True)
    import_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("imports.id", ondelete="CASCADE"))
    row_number: Mapped[int] = mapped_column(Integer)
    raw_fields: Mapped[dict] = mapped_column(JSONB)
    normalized: Mapped[dict] = mapped_column(JSONB)
    printing_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("card_printings.id"))
    quantity: Mapped[int | None] = mapped_column(Integer)
    state: Mapped[str] = mapped_column(String(32))
    error: Mapped[str | None] = mapped_column(String(512))


class InventoryLot(Base):
    __tablename__ = "inventory_lots"
    __table_args__ = (
        ForeignKeyConstraint(["binder_id", "owner_id"], ["binders.id", "binders.owner_id"]),
        CheckConstraint("quantity_remaining >= 0", name="lot_nonnegative_quantity"),
        CheckConstraint(
            "num_nonnulls(source_import_row_id, source_observation_id) <= 1", name="lot_one_source"
        ),
        CheckConstraint("finish IN ('unknown','nonfoil','foil','etched')", name="lot_valid_finish"),
        CheckConstraint(
            "condition IN ('ungraded','NM','LP','MP','HP','damaged')", name="lot_valid_condition"
        ),
        CheckConstraint(
            "split_parent_id IS NULL OR split_parent_id <> id", name="lot_not_own_parent"
        ),
        CheckConstraint(
            "split_parent_id IS NULL OR source_observation_id IS NULL",
            name="lot_scan_cannot_split",
        ),
        Index(
            "lot_original_import_source",
            "source_import_row_id",
            unique=True,
            postgresql_where=text("split_parent_id IS NULL"),
        ),
        Index(
            "lot_original_scan_source",
            "source_observation_id",
            unique=True,
            postgresql_where=text("split_parent_id IS NULL"),
        ),
    )
    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    owner_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    binder_id: Mapped[uuid.UUID] = mapped_column()
    printing_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("card_printings.id"))
    quantity_remaining: Mapped[int] = mapped_column(Integer)
    finish: Mapped[str] = mapped_column(String(32), default="unknown")
    condition: Mapped[str] = mapped_column(String(32), default="ungraded")
    notes: Mapped[str] = mapped_column(String(4096), default="")
    purchase_price: Mapped[object | None] = mapped_column(Numeric(16, 4))
    purchase_currency: Mapped[str | None] = mapped_column(String(3))
    misprint: Mapped[bool | None] = mapped_column(Boolean)
    altered: Mapped[bool | None] = mapped_column(Boolean)
    source_metadata: Mapped[dict] = mapped_column(JSONB, default=dict)
    source_import_row_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("import_rows.id"), index=True
    )
    source_observation_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("observations.id"), index=True
    )
    split_parent_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("inventory_lots.id", ondelete="CASCADE"), index=True
    )
    version: Mapped[int] = mapped_column(Integer, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class InventoryEvent(Base):
    __tablename__ = "inventory_events"
    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    lot_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("inventory_lots.id", ondelete="CASCADE"), index=True
    )
    operation_key: Mapped[str] = mapped_column(String(128), unique=True)
    kind: Mapped[str] = mapped_column(String(32))
    delta: Mapped[int] = mapped_column(Integer)
    detail: Mapped[dict] = mapped_column(JSONB, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class ExportBatch(Base):
    __tablename__ = "exports"
    __table_args__ = (UniqueConstraint("owner_id", "request_key"),)
    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    owner_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    request_key: Mapped[str] = mapped_column(String(128))
    request_hash: Mapped[str] = mapped_column(String(64))
    format: Mapped[str] = mapped_column(String(32))
    binder_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("binders.id"))
    state: Mapped[str] = mapped_column(String(32), default="QUEUED")
    snapshot_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    object_key: Mapped[str | None] = mapped_column(String(512))
    checksum: Mapped[str | None] = mapped_column(String(64))
    report: Mapped[dict] = mapped_column(JSONB, default=dict)
    losses_acknowledged: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class ExportRow(Base):
    __tablename__ = "export_rows"
    export_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("exports.id", ondelete="CASCADE"), primary_key=True
    )
    lot_id: Mapped[uuid.UUID] = mapped_column(primary_key=True)
    payload: Mapped[dict] = mapped_column(JSONB)


class WishlistItem(Base):
    """Cards an account wants; never counted as owned copies."""

    __tablename__ = "wishlist_items"
    __table_args__ = (
        UniqueConstraint("owner_id", "printing_id", "finish"),
        CheckConstraint("quantity > 0 AND quantity <= 999", name="wishlist_quantity_valid"),
        CheckConstraint(
            "finish IN ('any','nonfoil','foil','etched')", name="wishlist_finish_valid"
        ),
    )
    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    owner_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    printing_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("card_printings.id", ondelete="CASCADE")
    )
    finish: Mapped[str] = mapped_column(String(16), default="any", server_default="any")
    quantity: Mapped[int] = mapped_column(Integer, default=1)
    notes: Mapped[str] = mapped_column(String(500), default="", server_default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class CardPriceHistory(Base):
    """One daily price per provider and finish, kept for owned or wanted printings."""

    __tablename__ = "card_price_history"
    __table_args__ = (CheckConstraint("amount > 0", name="price_history_positive"),)
    printing_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("card_printings.id", ondelete="CASCADE"), primary_key=True
    )
    provider: Mapped[str] = mapped_column(String(32), primary_key=True)
    finish: Mapped[str] = mapped_column(String(16), primary_key=True)
    day: Mapped[date] = mapped_column(Date, primary_key=True)
    amount: Mapped[float] = mapped_column(Numeric(16, 4))


class CollectionValueHistory(Base):
    __tablename__ = "collection_value_history"
    owner_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    provider: Mapped[str] = mapped_column(String(32), primary_key=True)
    day: Mapped[date] = mapped_column(Date, primary_key=True)
    amount: Mapped[float] = mapped_column(Numeric(16, 4))
    priced_copies: Mapped[int] = mapped_column(Integer)
    copies: Mapped[int] = mapped_column(Integer)


class Friendship(Base):
    """A pair of accounts, stored once with the smaller ID first."""

    __tablename__ = "friendships"
    __table_args__ = (
        UniqueConstraint("user_a", "user_b"),
        CheckConstraint("user_a < user_b", name="friendship_ordered_pair"),
        CheckConstraint("requested_by IN (user_a, user_b)", name="friendship_requester_member"),
        CheckConstraint("state IN ('pending','accepted')", name="friendship_state_valid"),
    )
    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    user_a: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    user_b: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    requested_by: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    state: Mapped[str] = mapped_column(String(16), default="pending")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class TradeOffer(Base):
    __tablename__ = "trade_offers"
    __table_args__ = (
        UniqueConstraint("sender_id", "request_key"),
        CheckConstraint("sender_id <> recipient_id", name="trade_offer_not_self"),
        CheckConstraint(
            "state IN ('pending','accepted','declined','cancelled')",
            name="trade_offer_state_valid",
        ),
    )
    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    sender_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    recipient_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    request_key: Mapped[str] = mapped_column(String(128))
    message: Mapped[str] = mapped_column(String(500), default="", server_default="")
    state: Mapped[str] = mapped_column(String(16), default="pending")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    responded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Each person updates their own collection after acceptance; these record that.
    sender_applied_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    recipient_applied_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    sender_closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    recipient_closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class TradeOfferCard(Base):
    """side = sender: cards the sender gives; side = recipient: cards the recipient gives."""

    __tablename__ = "trade_offer_cards"
    __table_args__ = (
        CheckConstraint("side IN ('sender','recipient')", name="trade_card_side_valid"),
        CheckConstraint("quantity > 0 AND quantity <= 999", name="trade_card_quantity_valid"),
        CheckConstraint(
            "finish IN ('nonfoil','foil','etched')", name="trade_card_finish_valid"
        ),
    )
    offer_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("trade_offers.id", ondelete="CASCADE"), primary_key=True
    )
    side: Mapped[str] = mapped_column(String(16), primary_key=True)
    printing_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("card_printings.id", ondelete="CASCADE"), primary_key=True
    )
    finish: Mapped[str] = mapped_column(String(16), primary_key=True)
    quantity: Mapped[int] = mapped_column(Integer)

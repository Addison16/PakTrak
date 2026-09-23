from functools import lru_cache

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

from scanner.settings import get_settings


@lru_cache(maxsize=4)
def client(timeout=None):
    settings = get_settings()
    return boto3.client(
        "s3",
        endpoint_url=settings.storage_endpoint,
        aws_access_key_id=settings.storage_access_key.get_secret_value(),
        aws_secret_access_key=settings.storage_secret_key.get_secret_value(),
        region_name="us-east-1",
        config=Config(
            connect_timeout=min(3, timeout) if timeout else 3,
            read_timeout=timeout or 15,
            retries={"max_attempts": 0 if timeout else 2},
            s3={"addressing_style": "path"},
        ),
    )


def ensure_bucket():
    bucket = get_settings().storage_bucket
    try:
        client().head_bucket(Bucket=bucket)
    except ClientError as exc:
        if exc.response["Error"]["Code"] not in {"404", "NoSuchBucket", "NotFound"}:
            raise
        client().create_bucket(Bucket=bucket)
    # A bucket can exist before a storage node can accept writes.
    # Startup is ready only after a full private-object write/read/delete round trip.
    probe = "_health/bootstrap"
    put(probe, b"storage-ready", "text/plain")
    body = get(probe)["Body"]
    try:
        if body.read() != b"storage-ready":
            raise RuntimeError("Private storage read-back failed")
    finally:
        body.close()
        delete(probe)


def put(key, body, content_type, sha256=None):
    client().put_object(
        Bucket=get_settings().storage_bucket,
        Key=key,
        Body=body,
        ContentType=content_type,
        Metadata={"sha256": sha256} if sha256 else {},
    )


def get(key, *, timeout=None):
    connection = client(timeout) if timeout else client()
    return connection.get_object(Bucket=get_settings().storage_bucket, Key=key)


def delete(key):
    client().delete_object(Bucket=get_settings().storage_bucket, Key=key)

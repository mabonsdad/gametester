"""Key/value blob store with two backends.

* FileStore: files under a directory (local development, any normal server).
* S3Store:   objects in a private S3 bucket (AWS Lambda, where disk is not
             persistent). Selected when GAMETESTER_S3_BUCKET is set.

Keys are '/'-separated paths such as 'projects/p_abc/project.json'.
"""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class FileStore:
    kind = "file"

    def __init__(self, root):
        self.root = Path(root).resolve()

    def _path(self, key):
        p = (self.root / key).resolve()
        if self.root not in p.parents:
            raise ValueError(f"Bad key {key!r}")
        return p

    def get(self, key):
        p = self._path(key)
        return p.read_bytes() if p.is_file() else None

    def put(self, key, data, content_type=None):
        p = self._path(key)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_name(p.name + ".tmp")
        tmp.write_bytes(data)
        os.replace(tmp, p)

    def delete(self, key):
        p = self._path(key)
        if p.is_file():
            p.unlink()

    def list(self, prefix):
        """All keys under prefix (recursive)."""
        base = self._path(prefix.rstrip("/")) if prefix.strip("/") else self.root
        if not base.is_dir():
            return []
        return sorted(str(p.relative_to(self.root)).replace(os.sep, "/")
                      for p in base.rglob("*") if p.is_file() and not p.name.endswith(".tmp"))

    def describe(self):
        return str(self.root)


class S3Store:
    kind = "s3"

    def __init__(self, bucket, prefix=""):
        import boto3  # available in the AWS Lambda Python runtime

        self.s3 = boto3.client("s3")
        self.bucket = bucket
        self.prefix = prefix.strip("/") + "/" if prefix.strip("/") else ""

    def _key(self, key):
        if ".." in key.split("/"):
            raise ValueError(f"Bad key {key!r}")
        return self.prefix + key

    def get(self, key):
        try:
            return self.s3.get_object(Bucket=self.bucket, Key=self._key(key))["Body"].read()
        except self.s3.exceptions.NoSuchKey:
            return None

    def put(self, key, data, content_type=None):
        extra = {"ContentType": content_type} if content_type else {}
        self.s3.put_object(Bucket=self.bucket, Key=self._key(key), Body=data, **extra)

    def delete(self, key):
        self.s3.delete_object(Bucket=self.bucket, Key=self._key(key))

    def list(self, prefix):
        out = []
        paginator = self.s3.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=self.bucket, Prefix=self._key(prefix)):
            for obj in page.get("Contents", []):
                out.append(obj["Key"][len(self.prefix):])
        return sorted(out)

    def describe(self):
        return f"s3://{self.bucket}/{self.prefix}"


def from_env():
    bucket = os.environ.get("GAMETESTER_S3_BUCKET")
    if bucket:
        return S3Store(bucket, os.environ.get("GAMETESTER_S3_PREFIX", ""))
    return FileStore(os.environ.get("GAMETESTER_DATA", ROOT / "data"))

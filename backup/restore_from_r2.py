#!/usr/bin/env python3
"""
Restore MongoDB from the Parquet backup in Cloudflare R2 (data/<db>/latest/).

Reverses backup_to_r2.py: downloads each collection's Parquet, parses the
Extended-JSON `doc` column back into BSON, and inserts into local Mongo.

By default restores the 'latest' snapshot; pass a date (YYYYMMDD) to restore a
specific dated snapshot. Existing collections are DROPPED and replaced.

Usage:
    python backup/restore_from_r2.py            # latest
    python backup/restore_from_r2.py 20260725   # a dated snapshot
"""
import io
import os
import sys

try:
    import pyarrow.parquet as pq
    import boto3
    from pymongo import MongoClient
    from bson.json_util import loads as bson_loads
except ImportError as e:
    sys.exit(f"Missing dependency ({e.name}). Run: pip install pymongo pyarrow boto3")

from backup_to_r2 import load_env, get, mongo_client, r2_client, ENV_PATH, log  # noqa: E402


def main():
    snapshot = sys.argv[1] if len(sys.argv) > 1 else "latest"
    env = load_env(ENV_PATH)
    db_name = get(env, "TRADENOTE_DATABASE", "tradenote")

    client = mongo_client(env)
    try:
        client.admin.command("ping")
    except Exception as e:  # noqa: BLE001
        sys.exit(f"Cannot reach local MongoDB: {e}. Is the project running?")

    s3, bucket = r2_client(env)
    prefix = f"data/{db_name}/{snapshot}/"
    listing = s3.list_objects_v2(Bucket=bucket, Prefix=prefix)
    keys = [o["Key"] for o in listing.get("Contents", []) if o["Key"].endswith(".parquet")]
    if not keys:
        sys.exit(f"No backup found at {prefix} in bucket '{bucket}'.")

    log(f"Restoring {len(keys)} collection(s) from {prefix} into '{db_name}'")
    db = client[db_name]
    total = 0
    for key in keys:
        name = os.path.basename(key)[:-len(".parquet")]
        body = s3.get_object(Bucket=bucket, Key=key)["Body"].read()
        table = pq.read_table(io.BytesIO(body))
        docs = [bson_loads(s) for s in table.column("doc").to_pylist()]
        db[name].drop()
        if docs:
            db[name].insert_many(docs)
        total += len(docs)
        log(f"  {name}: {len(docs)} docs restored")

    log(f"Done. {total} documents restored. Restart the app if it was running.")


if __name__ == "__main__":
    main()

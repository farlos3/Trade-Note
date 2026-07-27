#!/usr/bin/env python3
"""
Back up the local MongoDB to Parquet and upload to Cloudflare R2 under data/.

Each collection becomes one Parquet file with two columns:
    _id  : string   (document id)
    doc  : string   (the full document as canonical Extended-JSON)

Storing each document as a JSON string is lossless — Mongo documents are nested
and mixed-typed (arrays, ObjectId, dates, base64 image blobs), which don't map
cleanly onto flat Parquet columns. This keeps every field intact and restores
perfectly with restore_from_r2.py.

Run on the HOST (Mongo is exposed on localhost:27017 by docker-compose).

Setup once:
    pip install pymongo pyarrow boto3
Fill these in .env (R2 -> S3 API):
    R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
    (R2_ENDPOINT is derived from the account id if left blank.)

Usage:
    python backup/backup_to_r2.py
"""
import datetime as dt
import io
import os
import sys

try:
    import pyarrow as pa
    import pyarrow.parquet as pq
    import boto3
    from pymongo import MongoClient
    from bson.json_util import dumps as bson_dumps
except ImportError as e:
    sys.exit(f"Missing dependency ({e.name}). Run: pip install pymongo pyarrow boto3")

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ENV_PATH = os.path.join(ROOT, ".env")
LOCAL_DIR = os.path.join(HERE, "data")   # local copy kept alongside the R2 upload

# Parse system collections not worth backing up for a single-user setup: the app
# rebuilds _SCHEMA on boot, sessions are transient (auto-login re-creates them),
# and _Role/_Idempotency are empty. Only real data is backed up (trades, _User,
# notes, screenshots, ...). Note: _User is your account, so it is NOT excluded.
EXCLUDE_COLLECTIONS = {"_Session", "_SCHEMA", "_Role", "_Idempotency"}


def log(msg):
    print(f"[{dt.datetime.now():%Y-%m-%d %H:%M:%S}] {msg}", flush=True)


def load_env(path):
    env = {}
    if not os.path.exists(path):
        return env
    with open(path, encoding="utf-8") as f:
        for line in f:
            s = line.strip()
            if not s or s.startswith("#") or "=" not in s:
                continue
            k, v = s.split("=", 1)
            env[k.strip()] = v.strip()
    return env


def get(env, key, default=None):
    return os.environ.get(key) or env.get(key) or default


def mongo_client(env):
    # The app connects at mongo:27017 (compose network); from the host it's
    # localhost. Override with BACKUP_MONGO_URI if your Mongo is elsewhere.
    uri = get(env, "BACKUP_MONGO_URI", "mongodb://localhost:27017")
    return MongoClient(uri, serverSelectionTimeoutMS=10000)


def r2_client(env):
    account = get(env, "R2_ACCOUNT_ID", "")
    endpoint = get(env, "R2_ENDPOINT", "") or (
        f"https://{account}.r2.cloudflarestorage.com" if account else "")
    key = get(env, "R2_ACCESS_KEY_ID", "")
    secret = get(env, "R2_SECRET_ACCESS_KEY", "")
    bucket = get(env, "R2_BUCKET", "")
    missing = [n for n, v in [("R2_ACCOUNT_ID/R2_ENDPOINT", endpoint),
                              ("R2_ACCESS_KEY_ID", key),
                              ("R2_SECRET_ACCESS_KEY", secret),
                              ("R2_BUCKET", bucket)] if not v]
    if missing:
        sys.exit("R2 not fully configured in .env - missing: " + ", ".join(missing))
    client = boto3.client(
        "s3", endpoint_url=endpoint,
        aws_access_key_id=key, aws_secret_access_key=secret,
        region_name="auto",
    )
    return client, bucket


def collection_to_parquet_bytes(coll):
    ids, docs = [], []
    for d in coll.find({}):
        ids.append(str(d.get("_id")))
        docs.append(bson_dumps(d))   # canonical Extended-JSON, lossless
    table = pa.table({"_id": pa.array(ids, pa.string()),
                      "doc": pa.array(docs, pa.string())})
    buf = io.BytesIO()
    pq.write_table(table, buf, compression="snappy")
    return buf.getvalue(), len(ids)


def main():
    env = load_env(ENV_PATH)
    db_name = get(env, "TRADENOTE_DATABASE", "tradenote")
    os.makedirs(LOCAL_DIR, exist_ok=True)

    client = mongo_client(env)
    try:
        client.admin.command("ping")
    except Exception as e:  # noqa: BLE001
        # Run on a short interval (e.g. every 30 min): whenever the project is
        # simply not up there is nothing to back up. Treat that as a benign skip
        # (exit 0) so Task Scheduler history isn't full of false failures --
        # real problems (R2 misconfig, upload errors) still exit non-zero below.
        log(f"Local MongoDB not reachable ({e}). Project not running -- nothing to back up, skipping.")
        sys.exit(0)

    s3, bucket = r2_client(env)
    db = client[db_name]
    stamp = dt.datetime.now().strftime("%Y%m%d")
    collections = [c for c in db.list_collection_names() if c not in EXCLUDE_COLLECTIONS]
    log(f"Backing up {len(collections)} data collection(s) from '{db_name}' to R2 bucket '{bucket}' "
        f"(skipping {', '.join(sorted(EXCLUDE_COLLECTIONS))})")

    total = 0
    for name in collections:
        data, n = collection_to_parquet_bytes(db[name])
        total += n
        # Local copy (latest) + a dated snapshot on R2 so history isn't overwritten.
        with open(os.path.join(LOCAL_DIR, f"{name}.parquet"), "wb") as f:
            f.write(data)
        for key in (f"data/{db_name}/latest/{name}.parquet",
                    f"data/{db_name}/{stamp}/{name}.parquet"):
            s3.put_object(Bucket=bucket, Key=key, Body=data,
                          ContentType="application/vnd.apache.parquet")
        log(f"  {name}: {n} docs -> data/{db_name}/latest/{name}.parquet (+dated)")

    log(f"Done. {total} documents across {len(collections)} collections backed up.")


if __name__ == "__main__":
    main()

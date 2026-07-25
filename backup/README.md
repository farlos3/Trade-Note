# Local MongoDB + Parquet backups to R2

No cloud database. TradeNote runs on a **local MongoDB** (the `mongo` service in
the compose files, data in the `mongo_data` Docker volume). Backups are written
as **Parquet** and pushed to **Cloudflare R2** under `data/`.

## How it works

```
local MongoDB ──backup_to_r2.py──► Parquet (1 file/collection) ──► R2 data/<db>/
     ▲                                                                    │
     └───────────────────── restore_from_r2.py ◄─────────────────────────┘
```

Each collection → one Parquet file with columns `_id` and `doc` (the whole
document as lossless Extended-JSON). Screenshots/images live inside the
`screenshots` collection, so they're captured too.

R2 layout:
- `data/<db>/latest/<collection>.parquet` — overwritten every run
- `data/<db>/<YYYYMMDD>/<collection>.parquet` — dated snapshot, kept as history

## One-time setup

```powershell
pip install pymongo pyarrow boto3
```

Fill in `.env` (R2 → S3 API — the same bucket that holds images):
```
R2_ACCOUNT_ID=<cloudflare account id>
R2_BUCKET=<bucket name>
R2_ACCESS_KEY_ID=<r2 access key>
R2_SECRET_ACCESS_KEY=<r2 secret>
# R2_ENDPOINT is derived as https://<account>.r2.cloudflarestorage.com if blank
```

## Run

```powershell
python backup\backup_to_r2.py             # back up now
python backup\restore_from_r2.py          # restore the latest snapshot
python backup\restore_from_r2.py 20260725 # restore a specific dated snapshot
```

> Restore DROPS and replaces each collection. Restart the app afterwards.

## Migrating off Atlas (one time)

Local Mongo starts empty. Either:
- **Fresh start** — just run the project; the login user is re-seeded and MT5
  trades re-sync. Simplest if you have little history.
- **Copy Atlas → local** — with the old Atlas `MONGO_URI` still available:
  ```powershell
  mongodump --uri "<atlas-uri>" --out .\_atlasdump
  mongorestore --uri "mongodb://localhost:27017" .\_atlasdump
  ```

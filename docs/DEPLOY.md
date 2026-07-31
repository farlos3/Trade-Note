# Deploying TradeNote to Render

TradeNote runs as a single long-running container (Parse Server + frontend)
that connects to a MongoDB Atlas database. This guide uses the prebuilt
Docker image `eleventrading/tradenote` and the included [render.yaml](render.yaml).

## 1. Prepare MongoDB Atlas

1. In Atlas, open **Network Access** and add `0.0.0.0/0` (allow from anywhere).
   Render's outbound IP is not fixed, so this is required for the connection to work.
2. In **Database Access**, confirm your user/password.
3. Copy your connection string and add the database name `tradenote`, e.g.:

   ```
   mongodb+srv://<user>:<password>@trade-note.3mvpypa.mongodb.net/tradenote
   ```

   > URL-encode special characters in the password (`?` -> `%3F`, `@` -> `%40`, etc.).

## 2. Push the repo to GitHub

`render.yaml` must be in the repo root. Secrets stay out of git (`.env` is
gitignored; you enter secrets in the Render dashboard).

```bash
git add render.yaml .env.example docs/DEPLOY.md docker-compose.yml docker-compose-local.yml
git commit -m "Add Render deploy config"
git push
```

## 3. Create the service on Render

1. Go to <https://dashboard.render.com> -> **New +** -> **Blueprint**.
2. Connect this GitHub repo. Render reads `render.yaml` automatically.
3. When prompted, fill in the secret env vars:
   - **MONGO_URI** – the Atlas string from step 1.
   - **APP_ID** – any random string, no spaces (e.g. `tn-app-92731`).
   - **MASTER_KEY** – any random string, no spaces (e.g. `tn-master-55012`).
4. Click **Apply**. Render pulls the image and starts the service.

## 4. Use it

- Render gives you a URL like `https://tradenote.onrender.com`.
- Register a user at `/register`, then log in.

## Notes

- **Free tier sleeps** after 15 min of inactivity; the first request after that
  takes ~30s to wake. Upgrade to a paid instance to keep it always on.
- **Port**: `TRADENOTE_PORT` is set to `10000` to match Render's routing.
- **Local run** still works via `docker compose up` (reads `.env`).

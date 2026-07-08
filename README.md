# UNFOLD

**Discover people before pictures.** A dating webapp demo for a live validation event: every face starts behind a 4×4 grid of frosted-glass tiles that clear as a real conversation develops — and shatter at full reveal.

## Run it

```bash
npm install
ADMIN_PASSWORD=your-secret npm start     # http://localhost:3000
npm run seed                              # optional: 6 fake users (3M/3F), password: seed1234
```

No build step. Requires Node ≥ 22 (uses the built-in `node:sqlite`). All dependencies are pure JS — no native modules, deploys anywhere Node runs.

| Env var | Default | |
|---|---|---|
| `ADMIN_PASSWORD` | `unfold-admin` (dev only — always set it for the event) | admin login password |
| `PORT` | `3000` | HTTP port |
| `DATABASE_URL` | `data/unfold.db` | SQLite file path — point at a mounted volume for persistence |
| `UPLOAD_DIR` | `uploads/` | photo/voice storage — point at a mounted volume for persistence |

## Deploy

This is a stateful app (SQLite + uploaded photos/voice on disk), so it needs a host that keeps
a Node process running with real storage — not a static/serverless host.

**Render.com (current setup, `render.yaml` + `Dockerfile` in this repo):**
1. In Render: New → Blueprint → connect this GitHub repo → it reads `render.yaml` → fill in `ADMIN_PASSWORD` → Apply.
2. Free tier has **ephemeral disk** — the server sleeps after 15 min idle and wipes all data (users/photos)
   on wake or redeploy. Fine for a quick look; for a live event, upgrade the service to a paid plan with a
   persistent **Disk** mounted, then set `DATABASE_URL=/var/data/db/unfold.db` and `UPLOAD_DIR=/var/data/uploads`
   (or wherever the disk is mounted) as env vars so data survives restarts.

Any other Docker-friendly host with persistent volumes (Fly.io, Railway, a VPS) works the same way — build the
included `Dockerfile`, mount a volume, and point `DATABASE_URL` / `UPLOAD_DIR` at it.

## Event runbook

1. Deploy, set `ADMIN_PASSWORD`, share the one URL.
2. Attendees register on their phones (throwaway passwords, 2 photos, 3 prompts) and land in the **lobby**.
3. Host logs in as username **`admin`** → Host Console → flips **Matching** on. Every lobby wakes within ~3 s.
4. Watch live stats; edit caps live if the room needs more momentum (defaults: 10 profiles / 3 openers / 30 msgs-per-chat / 5 incoming per day).
5. Attendees submit feedback in the app's Feedback tab; the console shows ratings + "would you join" breakdown.
6. **Reset entire event** in the console wipes everything and restores defaults.

## The reveal mechanic

- Only **meaningful messages** count: ≥ 5 alphanumeric chars and not filler ("hmm", "lol", "ok"…). Rejected ones still send, with a playful toast.
- The ladder starts once **both** people have sent something; every **4 meaningful messages** (combined) clears more glass: 4 → first glimpse (6 tiles), 8 → voice unlocked (12 tiles), 12 → **shatter** (full reveal).
- Reveals are symmetric — both photos advance at the same instant.
- **Enforced server-side**: at upload time the server bakes one JPEG per stage (face box blurred, cleared tiles composited back from the original). A client can only ever fetch the variant its conversation stage allows — the bare face never leaves the server before stage 3. Admin sees originals.

## Layout

```
server.js            Express app — all API routes
lib/db.js            node:sqlite schema + config
lib/images.js        pure-JS stage-variant baking (jpeg-js, box blur, tile compositing)
lib/reveal.js        meaningful-message rules + stage math
seed.js              6 fake users with synthesized placeholder photos
public/              landing (index.html), register, login, lobby, app, chat, admin
public/js/common.js  api/toast helpers + GlassReveal (tiles, glint, shatter)
data/, uploads/      SQLite DB and photo variants (gitignored)
```

Realtime is 3–4 s polling — fine for ~60 concurrent phones on one small box.

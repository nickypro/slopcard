# slopcard — Project Plan

## Desiderata (verbatim, from user messages)

> hi, make a subfolder and start a project: i want a little website called slopcard (slopcard.org) that makes it so that it takes the twitter profile of someone (@cutesuscat) + auto grabs the profile pic and displat name and description, allows manual editing of the these, and also takes a link like https://app.swapcard.com/event/eag-london/person/RXZlbnRQZW9wbGVfNDY0MTU0NzI= to make a "slopcard" (similar to tpotmon) + permalink ( slopcard.org/cutesuscat -> redirects to swapcard link )

> start the project in in /home/dev/slopcard, there should be symlink for /root/ to see it. nginx should work as a proxy to the docker container [eg: slopcard.org:443 -> localhost:<port> ] or something running with docker-compose and all data saved in a subfolder volume. get cert and stuff working. make a plan in the dev folder for this. i think there was existing info too, you should have my desiderata quoted exactly, then the resulting inferred plan written below that. hope that clears things up a bit ^.^

> redirect www to @, and have the data as a test but maybe make it so that my profile is easy to delete / retry making it :)

> oh also idk, i'd prefer if it was the case that people can submit requests to be added to slopcard, but that i need to manually approve them

### Clarifying choices the user picked (from prior questions)

- **Twitter fetch:** Nitter / syndication scraper (no paid X API; brittle but acceptable, manual edit always available as a fallback).
- **Stack:** Next.js + SQLite/Postgres (App Router, TypeScript). SQLite for v1, single-node, file on disk.
- **Linux user:** `dev`, SSH-key-only (3 keys from root), passwordless sudo, member of `sudo` and `docker` groups. Already created.

## Inferred plan

### Environment facts confirmed

- Host: Ubuntu 22.04, public IP `23.94.148.21`.
- `slopcard.org` is a CNAME to `sus.cat`, which resolves to this host's IP — HTTP-01 cert issuance will work without DNS changes.
- `www.slopcard.org` has no DNS record yet → will set up the nginx redirect anyway, issue cert apex-only, extend cert when CNAME is added.
- nginx is already running with existing sites for `nicky.pro`, `sus.cat`, and a `shlink` reverse-proxy block. Adding slopcard alongside, not modifying existing blocks.
- Port `3000` is free on the host. Container will bind there.
- Docker daemon is up; `dev` is in the `docker` group.

### Submission + moderation workflow (the big shape)

- **Public can submit** a card (handle, swapcard link, optional name/bio/avatar override). Submission creates a row with `status='pending'`.
- **Submitter gets back** a private preview link `/pending/<token>` (token = unguessable opaque ID stored on the row). They can return to that URL to see whether their card has been approved, but the public `/[handle]` does not resolve until approval.
- **Admin (you)** logs into `/admin` once by visiting `/admin/login?token=<ADMIN_TOKEN>` — sets an httpOnly cookie. Then `/admin` shows the pending queue with previews, plus a list of approved cards.
- **Admin actions:** approve, reject (deletes), edit any field then approve, or delete any approved card.
- **Only approved cards** are visible at `/[handle]`, `/[handle]/card`, and `/api/og/[handle]`.
- **The pre-seeded `cutesuscat` card** is inserted at first DB init with `status='approved'`, using the swapcard link from your desiderata. Easy to delete + re-submit via admin UI.

### Layout

```
/home/dev/slopcard/              (owned by dev:dev)
├── PLAN.md                      ← this file
├── docker-compose.yml
├── Dockerfile
├── .dockerignore
├── .gitignore
├── .env.example                 ← committed; .env is git-ignored
├── data/                        ← bind-mount volume (sqlite db + secrets)
└── app/                         ← Next.js source
    ├── package.json
    ├── tsconfig.json
    ├── next.config.ts
    └── src/
        ├── app/
        │   ├── layout.tsx
        │   ├── page.tsx                       (submission form)
        │   ├── globals.css
        │   ├── thanks/page.tsx                (post-submit confirmation + preview link)
        │   ├── pending/[token]/page.tsx       (submitter's private preview)
        │   ├── [handle]/
        │   │   ├── page.tsx                   (HTML redirect + OG meta; 404 if not approved)
        │   │   └── card/page.tsx              (public slopcard view)
        │   ├── admin/
        │   │   ├── login/page.tsx             (token entry form, also accepts ?token=)
        │   │   ├── page.tsx                   (queue + approved list)
        │   │   └── edit/[handle]/page.tsx     (edit + approve a pending card)
        │   └── api/
        │       ├── submit/route.ts            (POST — creates a pending card)
        │       ├── fetch/route.ts             (GET twitter profile)
        │       ├── og/[handle]/route.tsx      (dynamic OG image)
        │       └── admin/
        │           ├── login/route.ts         (POST — set cookie)
        │           ├── logout/route.ts        (POST — clear cookie)
        │           ├── approve/route.ts       (POST {handle, ...fields})
        │           ├── reject/route.ts        (POST {handle})  ← deletes a pending
        │           └── delete/route.ts        (POST {handle})  ← deletes an approved
        ├── components/
        │   ├── SlopCard.tsx
        │   ├── SubmitForm.tsx
        │   └── AdminQueue.tsx
        └── lib/
            ├── db.ts                          (better-sqlite3)
            ├── twitter.ts                     (syndication scraper)
            ├── auth.ts                        (admin cookie check)
            └── handle.ts                      (validation, reserved list)

/root/slopcard                   → symlink → /home/dev/slopcard   (already created)
```

### Routes

**Public**
- `GET /` — submission form. Paste handle → "fetch" pre-fills name/bio/avatar (editable). Paste swapcard URL. Submit → row with `status='pending'` → redirect to `/thanks?token=<preview-token>`.
- `GET /thanks` — confirmation + the private preview link.
- `GET /pending/[token]` — submitter's preview of their own pending card (or "approved!" state once moderated).
- `GET /[handle]` — if approved: HTML page with OG meta + JS redirect to swapcard. If not approved: 404.
- `GET /[handle]/card` — public card view (only if approved).
- `GET /api/og/[handle]` — Next.js `ImageResponse`, PNG for og:image. 404 if not approved.

**Submission**
- `POST /api/submit` — body `{handle, displayName, description, avatarUrl, swapcardUrl}`. Validates, rejects if handle already exists (pending OR approved). Returns `{token}` for the preview link.
- `GET /api/fetch?h=<handle>` — tries `syndication.twitter.com/srv/timeline-profile/screen-name/<h>` (parses `__NEXT_DATA__` for bio + name + pic), falls back to `cdn.syndication.twimg.com/widgets/followbutton/info.json` (no bio), final fallback `unavatar.io/twitter/<h>`. Always returns whatever it got; form stays editable.

**Admin (require cookie)**
- `GET /admin/login?token=<ADMIN_TOKEN>` — sets `slopcard_admin` httpOnly cookie, redirects to `/admin`.
- `GET /admin` — pending queue + approved list + per-row actions.
- `GET /admin/edit/[handle]` — edit form for a card (any status).
- `POST /api/admin/approve` — marks `status='approved'`, optionally with edited fields.
- `POST /api/admin/reject` — deletes a pending card.
- `POST /api/admin/delete` — deletes an approved card.
- `POST /api/admin/login` / `POST /api/admin/logout`.

### Data

- SQLite via `better-sqlite3`, file at `/app/data/slopcard.db` inside the container.
- Bind-mount: `./data:/app/data` so the DB sits at `/home/dev/slopcard/data/slopcard.db` on host.
- Schema:
  ```sql
  CREATE TABLE cards (
    handle         TEXT PRIMARY KEY,    -- lowercased, [A-Za-z0-9_]{1,15}
    display_name   TEXT NOT NULL DEFAULT '',
    description    TEXT NOT NULL DEFAULT '',
    avatar_url     TEXT NOT NULL DEFAULT '',
    swapcard_url   TEXT NOT NULL DEFAULT '',
    status         TEXT NOT NULL DEFAULT 'pending'  -- 'pending' | 'approved'
                   CHECK (status IN ('pending','approved')),
    preview_token  TEXT NOT NULL UNIQUE,             -- random; lets submitter view their pending
    submitter_ip   TEXT,                             -- for abuse / debugging
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL,
    approved_at    INTEGER
  );
  CREATE INDEX cards_status ON cards(status);
  ```
- Seed at first run: `cutesuscat` with status=`approved`, swapcard URL from desiderata.
- Reserved handles blocked at write: `api`, `admin`, `pending`, `thanks`, `card`, `_next`, empty, anything outside `[A-Za-z0-9_]{1,15}`.

### Admin auth

- Single shared secret `ADMIN_TOKEN` in `.env` (random 32-byte hex, generated on first setup).
- `/admin/login?token=X` compares X to `ADMIN_TOKEN` (constant-time), sets cookie `slopcard_admin=<HMAC(token)>` httpOnly, secure (in prod), sameSite=lax, 30-day expiry.
- All `/admin/*` and `/api/admin/*` routes require the cookie to be present and verify against `ADMIN_TOKEN`.
- Logout clears the cookie.
- Honest about limits: a single shared token is the simplest workable auth. Anyone who steals the cookie has full admin until rotation. Acceptable for v1 single-admin operation. Rotate the token by editing `.env` + `docker compose restart`.

### Docker

- `Dockerfile`: multi-stage. Builder uses `node:22-bookworm` (full image — has build tools for `better-sqlite3` if no prebuilt is available). Runtime uses `node:22-bookworm-slim`. Next.js `output: 'standalone'` keeps the runtime image small. Container runs as a non-root user.
- `docker-compose.yml`:
  - Service: `slopcard`
  - `ports: ["127.0.0.1:3000:3000"]` — loopback only. Nginx is the only public entrypoint.
  - `volumes: ["./data:/app/data"]`
  - `restart: unless-stopped`
  - `env_file: .env`

### nginx

- New file: `/etc/nginx/sites-available/slopcard.org.conf`, symlinked into `sites-enabled/`.
- `:80` block — server_name `slopcard.org www.slopcard.org`. Redirects all to `https://slopcard.org$request_uri` (so www → apex collapse happens at the HTTP layer too, plus HTTPS upgrade). Includes the `.well-known/acme-challenge` location for certbot renewals.
- `:443 ssl http2` block — server_name `slopcard.org`. `proxy_pass http://127.0.0.1:3000`, standard headers (Host, X-Real-IP, X-Forwarded-For, X-Forwarded-Proto). `proxy_http_version 1.1`, `Connection ""` for upstream keepalive. Larger `client_max_body_size` (1m) is fine — no uploads.
- Second `:443` block once www DNS exists — server_name `www.slopcard.org`, return 301 to `https://slopcard.org$request_uri`. Until then, only apex on 443.
- Uses modern `http2 on;` directive — won't add to the existing deprecation warnings on the other sites.

### TLS / certbot

- Step 1: apex-only. `certbot --nginx -d slopcard.org`. HTTP-01 challenge works because DNS already points here.
- Step 2 (when you add `www CNAME slopcard.org` at your DNS provider): `certbot --nginx -d slopcard.org -d www.slopcard.org --expand`. This is a one-liner you can run later.

### Build / deploy steps (in order)

1. ✅ Create `/home/dev/slopcard` (owned by `dev:dev`) and `/root/slopcard` symlink.
2. ✅ Write this `PLAN.md`.
3. Generate `ADMIN_TOKEN` and write `.env` (only on the host; `.env.example` in the repo).
4. Scaffold Next.js app under `app/` (package.json, configs, source).
5. Write `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `.gitignore`.
6. `git init` (so dev work is version-controlled from the start).
7. As `dev`: `docker compose build && docker compose up -d`. Smoke-test: `curl -I http://127.0.0.1:3000` returns 200; DB file appears in `./data/`.
8. Drop nginx HTTP-only server block for `slopcard.org`, `nginx -t`, `systemctl reload nginx`. Smoke-test: `curl -H 'Host: slopcard.org' http://127.0.0.1` returns the app.
9. `certbot --nginx -d slopcard.org`. Confirm cert installed, :443 block rewritten.
10. End-to-end: visit `https://slopcard.org`, submit a test card, log in to `/admin` with the token, approve it, confirm `/[handle]` redirects to swapcard. Verify `/cutesuscat` already works (pre-seeded).

### Out of scope for v1

- Multi-user admin / GitHub OAuth — single shared token is enough.
- Submitter accounts / claim flow / "is this really your twitter" verification — anyone can submit any handle; admin's job to filter.
- Edit-after-approval by submitter — admin owns approved cards.
- Listing / browsing all cards on a public page.
- Rate limiting (add via nginx `limit_req` if abused).
- Notifications when a submission arrives (Discord webhook is a future add).
- Non-Twitter card sources.
- Custom per-card domains.

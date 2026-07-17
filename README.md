<div align="center">

<img src="internal/webui/static/images/Taggd-Colored.svg" width="96" height="96" alt="Tagged logo">

# Tagged Server

**A fast, self‑hosted time tracker server — one Go binary, no dependencies to babysit.**

Track your time with tags, see where it goes, and own your data.

`🛠️ vibe coded` &nbsp;·&nbsp; `🐹 Go` &nbsp;·&nbsp; `🗄️ SQLite / Postgres` &nbsp;·&nbsp; `🔑 OAuth · 2FA · passkeys` &nbsp;·&nbsp; `🎨 dark theme`

</div>

---

> **Vibe coded.** This whole thing — server, storage, auth, and the entire web UI —
> was built end‑to‑end in a back‑and‑forth conversation with an AI pair‑programmer,
> one feature at a time. No roadmap, no tickets, just vibes and working software.

## Highlights

- ⚡ **Single binary.** Everything — the API, the web UI, the fonts, the icons —
  is embedded. Build it, copy it, run it. No Node, no bundler, no `node_modules`.
- 🏷️ **Tags with colors.** Tag your entries with `#hashtags`, give each tag a
  color, and watch the dashboard light up. Colors are stored with your data and
  sync across your devices.
- 📊 **A real dashboard.** Daily/weekly totals, a time‑allocation donut, a
  calendar, per‑tag breakdowns, and daily/weekly goals with progress bars.
- ⏱️ **Entries, list & timeline.** Add, edit, and delete time entries from a
  clean modal sheet, and review them as a list or a live‑syncing timeline.
- 🔑 **Sign in your way.** Username + password, **OAuth SSO** (Google, GitHub, or
  any custom OpenID provider), and **passkeys** (Face ID / Touch ID / security
  keys). Password accounts can add **two‑factor auth** — TOTP codes plus
  one‑time backup codes.
- 👤 **Accounts & API tokens.** Self‑service sign‑up and personal API tokens for
  scripting against your own data. OAuth users can optionally set a password to
  unlock 2FA and passkeys.
- 🛡️ **Roles you can re‑shape.** Three roles — **User**, **Admin**,
  **Controller** — and a permission matrix you edit from **Admin → Roles**.
  Every privileged route is gated on a capability (manage users, roles, groups,
  server settings, OAuth, switch to users), so you decide what each role may do.
  Config‑defined "root" admins always keep every permission, so you can't lock
  yourself out.
- 👥 **Groups with controllers.** Gather users into groups from
  **Admin → Groups** and put one or more **controllers** over each. A controller
  can view and edit the time data of their groups' members — and nobody else's.
  Users can belong to more than one group.
- 🪪 **Profiles & pictures.** First/last name, job, department, e‑mail, phone and
  mobile, plus a profile picture. Everyone edits their own from **Account**;
  admins edit anyone from **Admin → Users**, where the list is searchable across
  every field.
- 🔒 **HTTPS built in.** Point it at a cert/key for native TLS, or run it behind
  a reverse proxy.
- 🗄️ **Your data, in plain SQLite.** One database file per user. Back it up with
  `cp`.

## Quick start

```bash
# 1. Build the single binary
git clone <your-repo-url> tagged && cd tagged/timetagger-go
go build -o tagged .

# 2. Run it (you are the admin)
./tagged --bind=127.0.0.1:8080 --datadir=~/tagged-data --admins=you@example.com

# 3. Open http://127.0.0.1:8080/ and create your account
```

That's it. Register the account you named in `--admins`, log in, and start tracking.

## Configuration

Everything is a flag (each also works as an environment variable for containers):

| Flag | What it does | Default |
| --- | --- | --- |
| `--bind` | Address and port to listen on | `127.0.0.1:8080` |
| `--datadir` | Where Tagged keeps per‑user databases, server settings (`setup.json`) and its secret key | `~/.tagged` |
| `--admins` | Comma‑separated usernames with admin rights | _(none)_ |
| `--path-prefix` | Serve under a sub‑path (e.g. `/tagged/`) | `/` |
| `--credentials` | Pre‑defined `user:bcrypthash` logins | _(none)_ |
| `--tls-cert` / `--tls-key` | Enable native HTTPS with a cert + key | _(off)_ |
| `--app-redirect` | Redirect `/` straight to the app | `false` |
| `--db-backend` | Storage backend: `sqlite` or `postgres` | `sqlite` |
| `--db-url` | Postgres DSN (required when `--db-backend=postgres`) | _(none)_ |
| `--proxy-auth-enabled` | Trust an authenticating reverse proxy for login | `false` |
| `--proxy-auth-trusted` | IPs/CIDRs allowed to set the proxy auth header | `127.0.0.1` |
| `--proxy-auth-header` | Header carrying the proxy‑authenticated username | `X-Remote-User` |
| `--log-level` | Log verbosity (`debug`, `info`, …) | `info` |

OAuth providers (Google, GitHub, or a custom OpenID Connect issuer) aren't flags —
add them at runtime from **Admin → OAuth** in the web UI.

### Storage backends

Tagged ships with two interchangeable backends. **The HTTP API is identical
either way** — apps, import, and export don't know or care which one you run.

- **Simple Server (`sqlite`, default).** One SQLite file per user under
  `--datadir`. Zero setup, back up with `cp`. Perfect for personal and
  small‑team use.
- **Performance Server (`postgres`).** Shared, multi‑tenant tables behind a
  Postgres connection pool for real concurrency at scale.

  ```bash
  ./tagged --db-backend=postgres \
    --db-url="postgres://user:pass@localhost:5432/tagged?sslmode=disable"
  ```

  `docker-compose.postgres.yml` wires the app to a bundled Postgres (see
  **Run with Docker** below).

You don't have to decide up front: on first run, the setup wizard lets you pick
the server type (unless you've pinned it with `--db-backend`).

**Migrating SQLite → Postgres.** Copy every existing per‑user database into
Postgres (idempotent) before switching the running server over:

```bash
./tagged migrate-to-postgres --datadir=~/tagged-data \
  --db-url="postgres://user:pass@localhost:5432/tagged?sslmode=disable"
```

### HTTPS

```bash
# Local dev with a self-signed cert
openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem \
  -days 365 -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"

./tagged --bind=127.0.0.1:8443 --tls-cert=cert.pem --tls-key=key.pem
```

For production, terminate TLS at a reverse proxy (Caddy/nginx/Traefik) and run
Tagged on plain HTTP behind it.

## Run with Docker

Pre-built multi-arch images are published to GHCR on every release.

```bash
# Simple Server (SQLite), data persisted in a named volume
docker run -d --name tagged -p 8080:8080 -v tagged:/data \
  ghcr.io/taggedhq/server:latest
```

Or with Compose:

```bash
docker compose up -d                       # Simple Server (SQLite)
# Performance Server: app + bundled Postgres
docker compose -f docker-compose.yml -f docker-compose.postgres.yml up -d
```

Then open `http://localhost:8080/` and complete the first-run **setup wizard** —
pick the server type (unless it's pinned via env) and create the first admin.
Configure via the same `TAGGED_*` env vars as the flags (e.g. `TAGGED_ADMINS`,
`TAGGED_DB_BACKEND`, `TAGGED_DB_URL`). The image listens on `0.0.0.0:8080` and
stores data under `/data`.

## Releases

Tagging `vX.Y.Z` triggers a GitHub Actions workflow that builds and pushes the
multi-arch container to `ghcr.io/taggedhq/server` and creates a GitHub Release:

```bash
docker pull ghcr.io/taggedhq/server:vX.Y.Z   # or :latest
```

## The API

Tagged is API‑first — the web UI is just a client. Authenticate to get a token,
then send it as the `authtoken` header.

```bash
# Log in
TOKEN=$(curl -s -X POST \
  --data "$(echo -n '{"method":"usernamepassword","username":"you@example.com","password":"secret"}' | base64)" \
  http://127.0.0.1:8080/api/v2/bootstrap_authentication | jq -r .token)

# Pull your records
curl -s -H "authtoken: $TOKEN" \
  "http://127.0.0.1:8080/api/v2/records?timerange=0-4102444800"
```

Core endpoints (all under `/api/v2/`): `records` (GET/PUT), `settings` (GET/PUT),
`updates`, `webtoken`, `apitoken`, `whoami`, `profile` (GET/PUT — your own name,
contact details and picture), plus auth routes for OAuth (`oauth/…`), two‑factor
(`totp/…`), and passkeys (`webauthn/…`). Grab a long‑lived personal token from
**Account → API token** in the UI.

Admin routes live under `admin/` and each needs the matching capability:
`admin/users`, `admin/password`, `admin/user`, `admin/profile` (manage users),
`admin/admin`, `admin/controller`, `admin/roles` (manage roles), `admin/groups`,
`admin/group` (manage groups), `admin/server`, and `admin/oauth`. A controller
lists the users they may act as via `controller/users`, then sends the
`actasuser` header on data routes.

## Built with

- [Go](https://go.dev) — the whole server, with the UI embedded via `embed`
- [modernc.org/sqlite](https://gitlab.com/cznic/sqlite) — pure‑Go SQLite (no cgo)
- [jackc/pgx](https://github.com/jackc/pgx) — Postgres driver for the Performance Server
- [go-webauthn/webauthn](https://github.com/go-webauthn/webauthn) — passkey (WebAuthn) support
- [Roboto Mono](https://fonts.google.com/specimen/Roboto+Mono) — the monospace look
- Plain HTML/CSS/JS — no framework, no build step

## Project layout

```
server/
├── main.go                 # entry point
├── internal/
│   ├── config/             # flags + environment configuration
│   ├── server/             # routing, auth, API, admin, accounts
│   ├── store/              # storage layer: interfaces + SQLite & Postgres backends
│   ├── util/               # JWT + helpers
│   └── webui/              # embedded UI (HTML/CSS/JS, fonts, logo)
└── README.md
```

---

<div align="center">
<sub>Made with too much coffee and not enough planning. ☕</sub>
</div>

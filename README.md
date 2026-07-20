<div align="center">

<img src="internal/webui/static/images/Taggd-Colored.svg" width="96" height="96" alt="Tagged logo">

# Tagged Server

**A fast, self‑hosted time tracker server — one Go binary, no dependencies to babysit.**

Track your time with tags, see where it goes, and own your data.

`🛠️ vibe coded` &nbsp;·&nbsp; `🐹 Go` &nbsp;·&nbsp; `🗄️ SQLite / Postgres` &nbsp;·&nbsp; `🔑 OAuth · 2FA · passkeys` &nbsp;·&nbsp; `🎓 skills & certificates` &nbsp;·&nbsp; `🎨 dark theme`

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
  A user belongs to **exactly one** group, so "which team is this person on?"
  always has one answer; a controller may oversee as many as you like. Adding
  someone to a group moves them out of their previous one, and says so.
- 🎓 **Skills, certificates and renewals.** Switch on the **Skills** module and
  define a catalogue — each skill with a category, a Font Awesome icon, a
  proficiency scale, and rules: renew every 1 or 3 years, require a certificate,
  require manager approval. People add skills to themselves from **My Skills**,
  picking a category and then a skill from the catalogue — they never invent one.
  A self‑claim on a skill that needs sign‑off waits as **pending** until one of
  their group's controllers approves it; a manager assigning it directly *is* the
  approval. Expiry counts from the certificate's issue date, so a backdated
  ticket doesn't quietly gain a fresh term. Everyone can see who holds what
  across the company; only a holder's own manager can act on it.
- 🪪 **Profiles & pictures.** First/last name, job, department, e‑mail, phone and
  mobile, plus a profile picture. Everyone edits their own from **Account**;
  admins edit anyone from **Admin → Users**, where the list is searchable across
  every field.
- 🌍 **Translate the whole UI.** Add a language from **Admin → Translations**,
  translate the interface in the browser (or export/import JSON and hand it to a
  translator), and it shows up in every user's **Account** language picker.
  Pages are rendered translated *server‑side*, so there is no flash of English —
  and it works with JavaScript switched off.
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

## Skills

An optional module (**Admin → Settings → Modules**) for tracking what people can
do, what proves it, and when that proof runs out.

It separates **defining** a skill from **holding** one:

- **Defining is curated.** The catalogue, its categories and the proficiency
  scale all sit behind a `skills.manage` capability, under the **Skills** section
  in the nav. They are the shared vocabulary everything else is expressed in: if
  anyone could add "Forklift" a second time, or reshape the scale mid‑flight,
  every existing record would quietly mean something else.
- **Holding is self‑service, but only from the catalogue.** On **My Skills** a
  user picks a category, then a skill filed under it. What that skill requires —
  a certificate, a manager's approval, renewal after a year or three — is part of
  its definition, so the rules are set once rather than negotiated per person.

Who may do what:

| | Own entry | Someone you manage | Anyone else |
|---|---|---|---|
| See it | ✔ | ✔ | ✔ |
| Set the level / certificate | ✔ | — | — |
| Approve or reject a pending claim | — | ✔ | — |
| Record a renewal for a **lapsed** certificate | ✔ | ✔ | — |

A manager **vouches for** a claim rather than authoring it, so they cannot edit
someone's level or evidence — that would make the record say something the holder
never claimed. The single exception is a renewal: when a certificate has expired,
a manager may record the new one, and the level carries over untouched.

"Manager" means a controller of the group the holder belongs to — which is why
group membership is exclusive. A holder in no group has no controller, so
`skills.manage` can approve them as a backstop, and only them.

Assignments live in each user's own store, not in `setup.json`, so they travel
with the account and are deleted with it. The catalogue and the two axes are
server‑wide and live alongside groups and roles.

**Upgrading an existing install.** Like translations, the catalogue is gated on a
new `skills.manage` capability, and roles are persisted — so the Admin role does
**not** pick it up automatically. Tick it once under **Admin → Roles**, and grant
it to whichever role you call "manager", or the Skills pages 403 and their nav
entries stay hidden.

## Translations

The UI ships in English. From **Admin → Translations** an admin adds a language
(a BCP‑47‑ish code and a display name), translates the interface, and enables
it — after which it appears in every user's language picker under **Account**.

The key for every string is its English source text, so anything untranslated
falls back to correct English rather than a blank or a placeholder. The list of
translatable strings is extracted from the source at build time, which means the
page always offers exactly the strings the running build actually has.

A few things worth knowing:

- **Rendered server‑side.** The chosen language rides in a `tt_lang` cookie and
  the HTML leaves the server already translated, so pages never paint in English
  and then flip. The UI stays translated with JavaScript disabled. Strings the
  browser renders at runtime are translated client‑side from the same catalog.
- **Translating outside the browser.** Every language can be exported as JSON and
  re‑imported. Import shows a preview — new, changed, and keys the file has that
  this build no longer uses — and never discards a translation silently.
- **Dates, durations and plurals** are catalog entries too, not hardcoded
  formats: month and weekday names, `{h}h {m}m`, and singular/plural forms.
  Composed dates use named placeholders (`{weekday}, {month} {d}`), so a
  translation can reorder them — German renders `Sonntag, 19. Jul`.
- **Storage.** One file per language in `<datadir>/i18n/<code>.json`, kept out of
  `setup.json` so a catalog is never anywhere near the DB password or the OAuth
  client secrets. Back them up with `cp`; a malformed one is skipped at startup
  rather than stopping the server.
- **Upgrading an existing install.** Translations are gated on a new
  `translations.manage` capability. Roles are persisted, so the Admin role does
  **not** pick it up automatically — tick it once under **Admin → Roles**, or the
  page 403s and its nav entry stays hidden.

Adding a string as a developer: mark it `data-i18n="…"` in HTML (leaving the
English as the element's text) or wrap it in `t("…")` / `tn("…", n)` in JS, then
run `go generate ./internal/webui/`. Tests fail if the catalog is stale, if the
markup and its key disagree, if `t()` is called with a computed key, or if a
local variable shadows `t`.

## Secrets at rest

Passwords and two‑factor backup codes are bcrypt hashes — they are never
recoverable. A TOTP secret has to be, since the server reproduces the code from
it, so from 0.2.4 it is encrypted with AES‑256‑GCM under a key derived from
`jwt.key`. Existing plaintext secrets are re‑stored encrypted the first time
their owner signs in; nothing needs to be done by hand.

This protects a database seen on its own — a backup, a Postgres replica, a
copied volume. It does **not** protect a stolen `datadir`, because the key is
derived from `jwt.key`, which lives there. Keep `jwt.key` backed up: losing it
makes the stored secrets undecryptable, and enrolled users then need their
backup codes or an admin reset.

User databases are opened with `PRAGMA secure_delete`, so replacing a secret
zeroes the old bytes rather than leaving them readable in free pages. Data freed
*before* upgrading is not covered by that; to clear it once:

```bash
for db in <datadir>/users/*.db; do sqlite3 "$db" "VACUUM;"; done   # server stopped
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
│       ├── gen/            # build-time extractor for the translatable strings
│       └── static/
│           ├── i18n/       # generated catalog of those strings (en.json)
│           ├── css/        # Font Awesome (icon picker for skills and groups)
│           └── webfonts/   # its webfonts: solid, regular, brands
└── README.md
```

---

<div align="center">
<sub>Made with too much coffee and not enough planning. ☕</sub>
</div>

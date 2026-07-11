<div align="center">

<img src="internal/webui/static/images/Taggd-Colored.svg" width="96" height="96" alt="Tagged logo">

# Tagged Server

**A fast, self‑hosted time tracker server — one Go binary, no dependencies to babysit.**

Track your time with tags, see where it goes, and own your data.

`🛠️ vibe coded` &nbsp;·&nbsp; `🐹 Go` &nbsp;·&nbsp; `🗄️ SQLite` &nbsp;·&nbsp; `🎨 dark theme`

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
- ⏱️ **Full entry management.** Add, edit, and delete time entries from a clean
  modal sheet — description, tags, and start/end times, all editable.
- 👤 **Accounts & API tokens.** Self‑service sign‑up, password changes, and
  personal API tokens for scripting against your own data.
- 🛡️ **Admin panel.** Config‑defined "root" admins can create users, reset
  passwords, grant/revoke admin, and remove accounts — with the usual guardrails.
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
| `--datadir` | Where Tagged keeps per‑user databases and its secret key | `~/tagged-data` |
| `--admins` | Comma‑separated usernames with admin rights | _(none)_ |
| `--path-prefix` | Serve under a sub‑path (e.g. `/tagged/`) | `/` |
| `--credentials` | Pre‑defined `user:bcrypthash` logins | _(none)_ |
| `--tls-cert` / `--tls-key` | Enable native HTTPS with a cert + key | _(off)_ |
| `--app-redirect` | Redirect `/` straight to the app | `false` |

### HTTPS

```bash
# Local dev with a self-signed cert
openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem \
  -days 365 -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"

./tagged --bind=127.0.0.1:8443 --tls-cert=cert.pem --tls-key=key.pem
```

For production, terminate TLS at a reverse proxy (Caddy/nginx/Traefik) and run
Tagged on plain HTTP behind it.

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
`updates`, `webtoken`, `apitoken`, `whoami`, and the admin routes under `admin/`.
Grab a long‑lived personal token from **Account → API token** in the UI.

## Built with

- [Go](https://go.dev) — the whole server, with the UI embedded via `embed`
- [modernc.org/sqlite](https://gitlab.com/cznic/sqlite) — pure‑Go SQLite (no cgo)
- [Roboto Mono](https://fonts.google.com/specimen/Roboto+Mono) — the monospace look
- Plain HTML/CSS/JS — no framework, no build step

## Project layout

```
server/
├── main.go                 # entry point
├── internal/
│   ├── config/             # flags + environment configuration
│   ├── server/             # routing, auth, API, admin, accounts
│   ├── store/              # SQLite storage layer
│   ├── util/               # JWT + helpers
│   └── webui/              # embedded UI (HTML/CSS/JS, fonts, logo)
└── README.md
```

---

<div align="center">
<sub>Made with too much coffee and not enough planning. ☕</sub>
</div>

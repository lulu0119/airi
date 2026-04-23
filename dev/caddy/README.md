# Caddy: HTTPS in front of Vite + Hono (local)

## Why Caddy (e.g. stage-pocket + `dev:ios`)

- **Hono** listens on **`http://127.0.0.1:3000`** in dev.
- **Vite** (Pocket / stage-web) is often **`https://localhost:5273`** (e.g. mkcert).
- In the WebView / browser, a **page on `https:` must not** treat **`http://localhost:3000`** as the API origin — **mixed active content** (and similar) blocks those calls.
- **Caddy** accepts **`https://` on a port (e.g. 8443)** and **reverse-proxies `/api` →** `http://127.0.0.1:3000`, so the client can set **`VITE_SERVER_URL` / `API_SERVER_URL` to that `https://…` address** and talk to the same backend **over HTTPS to the bar**, even though the process is still **plain HTTP** behind Caddy. **No TLS in Node** on `apps/server`.

The **`/`** path in this Caddyfile proxies to Vite for convenience (single entry: open `https://localhost:8443`). If you **only** need a **HTTPS API** while keeping the app on **5273**, you can still do that: set `VITE_SERVER_URL=https://localhost:8443` and load the app from **5273**; API fetches are **cross-origin (5273 → 8443)** and must be allowed by **CORS** (this repo’s server already trusts `https://localhost:5273`). `OIDC_REDIRECT_URI` then stays `https://localhost:5273/auth/callback` while **`resource` / issuer base** follow `VITE_SERVER_URL` — that is **intentional** in this setup, not an accident.

## Prerequisites

- **Caddy binary** comes from the repo: `@radically-straightforward/caddy` (in root `devDependencies` / `catalog`). After **`pnpm install`** at the repository root, `pnpm exec caddy version` should print a version. The package’s `postinstall` downloads the official Caddy build into `node_modules/.bin/caddy`.
- If you see `command not found: caddy` for `pnpm dev:caddy`, run `pnpm install` at the root again, or: `pnpm rebuild @radically-straightforward/caddy` (re-downloads the binary; needs network).
- Alternatively install [Caddy](https://caddyserver.com/docs/install) globally and use the same Caddyfile with `caddy run --config dev/caddy/Caddyfile`.
- Services running (defaults in this repo):
  - `@proj-airi/server` on `127.0.0.1:3000`
  - Vite (e.g. `stage-web` or `stage-pocket` `dev:web`) on `127.0.0.1:5273`
  If Caddy logs **`502`** / **`EOF`** for `/` (non-`/api`), the proxy could not connect to Vite on **:5273** — start the dev build first. `GET /api/...` returning 502 means Hono is not on **:3000**. Empty `curl` body with exit code 0 is still a **502** response if the upstream is down.
- `docker compose` (or your own) for Postgres/Redis as required by the server. See `apps/server/README.md`.

## Run

1. Start the API and the Vite dev server (two terminals).
2. From the **repository root**:

   ```sh
   pnpm dev:caddy
   ```
   (Uses the Caddy binary from `node_modules` after `pnpm install`.) **Each HTTP request** is written as a JSON line to that terminal (see `dev/caddy/Caddyfile` `log` block).

3. If **`https://localhost:8443` does not connect**: confirm this process is running and bound (no other app on 8443), that nothing blocks loopback, and for browser trust run `caddy trust` (macOS). The **Cursor / IDE debug log ingest** on `127.0.0.1:7865` is not part of this repo — that server is provided by the editor when a debug session is active; re-open or restart the session if you need it.

   **curl / `127.0.0.1`:** The `Caddyfile` site names include `https://127.0.0.1:8443` and `https://localhost:8443` so `tls internal` can put both in the leaf cert. After restarting Caddy, `curl -k https://127.0.0.1:8443/` and `curl -k https://localhost:8443/` should work. A **LAN IP** (e.g. `https://192.168.1.10:8443`) is not in that cert — use `Caddyfile.mkcert.example` or add that name to the site list if you need it. Global `protocols h1 h2` keeps HTTP/3 off for simpler tooling.

4. Open the app: either **`https://localhost:8443`** (UI and API both via Caddy) or keep **`https://localhost:5273`** and set **`VITE_SERVER_URL=https://localhost:8443`** so API traffic goes to Caddy’s HTTPS (cross-origin; `:8443` is bound for LAN as well). See **Environment** below.

5. **Trust the dev CA (first time, macOS, `tls internal`)**:

   ```sh
   caddy trust
   ```

   A physical iPhone/iPad will **not** pick up that trust. For a **real device**, use certificates that include your machine’s LAN hostname/IP (e.g. `mkcert` + the `Caddyfile.mkcert.example` pattern below), or another profile/trust flow you use for local HTTPS.

## Environment

Caddy is for the case where the **page is HTTPS** (e.g. `https://localhost:5273`) and you want the **API** to be a normal **`https://` URL** too, e.g. **`https://localhost:8443/api/...`**. Hono still runs on **`http://127.0.0.1:3000`**. Caddy terminates **HTTPS** in front and forwards to that HTTP backend, so the browser does not have to call **`http://...:3000` from a secure page** (mixed content and related security policy issues).

- Point **`VITE_SERVER_URL` and `API_SERVER_URL`** at the **same public `https` origin** the client uses (stage apps and `apps/server/.env.local`). `API_SERVER_URL` is **better-auth `baseURL`**. If the client uses **`https://localhost:8443`** for the API but the server still has **`API_SERVER_URL=http://localhost:3000`**, you can get errors like **`INVALID_CALLBACK_URL`**.

This doc is not about every dev setup. For example **`http://localhost:5173`** (plain HTTP) talking to **`http://127.0.0.1:3000`** is fine and does not need Caddy for that reason.

## Nginx (same idea)

Same routing: one `server` block, `location /api/ { proxy_pass http://127.0.0.1:3000; }` and `location / { proxy_pass http://127.0.0.1:5273; }`, with `listen 443 ssl` and your own certs. **Environment** (public `https` for the API, Hono on HTTP behind the proxy) applies the same way.

## Optional: mkcert + Caddy (LAN / devices)

To replace `tls internal` with cert files (e.g. from `mkcert localhost 192.168.1.42`):

- Copy `Caddyfile.mkcert.example` to something like `Caddyfile.mkcert` (gitignored locally if you prefer), fill in the `tls` paths, and run `pnpm exec caddy run --config dev/caddy/Caddyfile.mkcert` (or merge the `tls` line into a single Caddyfile).

Install/trust the mkcert root on the device or OS as documented by `mkcert`.

## Script

From the repo root: `pnpm dev:caddy` (same as `pnpm exec caddy run --config dev/caddy/Caddyfile`).

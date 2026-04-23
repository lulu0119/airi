# `@proj-airi/server`

HTTP and WebSocket backend for AIRI. This app owns auth, billing, chat synchronization, gateway forwarding, and server-side observability export.

## What It Does

- Serves the Hono-based API and WebSocket endpoints.
- Uses Postgres as the source of truth for users, billing, and durable state.
- Uses Redis for cache, KV, Pub/Sub, and Streams.
- Forwards GenAI requests to the configured upstream gateway and records billing from usage.
- Exports traces, metrics, and logs through OpenTelemetry.

## How To Use It

Install dependencies from the repo root and run scoped commands:

```sh
pnpm -F @proj-airi/server typecheck
pnpm -F @proj-airi/server exec vitest run
pnpm -F @proj-airi/server build
```

For local observability infrastructure, use:

```sh
docker compose -f apps/server/docker-compose.otel.yml up -d
```

## Local Postgres + Redis

```sh
docker compose -f apps/server/docker-compose.yml up -d db redis
```

Point `DATABASE_URL` / `REDIS_URL` in `apps/server/.env.local` at these services (see `docker-compose.yml` for port and default password). Run `pnpm -F @proj-airi/server dev`; migrations apply automatically on startup.

## Local HTTPS in front of the API (no TLS in Node)

To avoid **https (Vite) → http (Hono)** mixed content in WebKit, you can run Caddy (or Nginx) as a **reverse proxy** in front of Vite and the API: one public `https://` base URL, Hono still listens on `http://127.0.0.1:3000`. Set `API_SERVER_URL` to that public URL. See [`dev/caddy/README.md`](../../dev/caddy/README.md).

**Do not** run `drizzle-kit push` against the same database and then rely on startup migrations — that leaves tables in place with an empty `drizzle.__drizzle_migrations` journal and the process will refuse to start. If you are in that state, reset the volume: `docker compose -f apps/server/docker-compose.yml down -v`, then `up -d db redis` again.

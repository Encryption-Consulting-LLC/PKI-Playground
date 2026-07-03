# EC-PKI-Playground

A web console + FastAPI backend over the VM deployment libraries — the same
`vmkit` / `configgen` / `isokit` that back the
[VM-Setup-Scripts](https://github.com/Arnesh-EC/VM-Setup-Scripts) CLIs. The
libraries are consumed as **versioned git dependencies** (see
`backend/pyproject.toml` `[tool.uv.sources]`) — this repo vendors no library
source.

## Layout

```
backend/    FastAPI app over vmkit / configgen / isokit (uv, Python ≥3.14)
frontend/   React + Vite + TypeScript console (shadcn/ui, TanStack Query)
```

## Backend

```sh
cd backend
uv sync                       # pulls fastapi + the three libs (from their git tags)
uv run uvicorn app.main:app --reload
```

Then open http://127.0.0.1:8000/docs.

Boot requires MongoDB (`MONGO_URL`) plus two secrets in the env —
`SESSION_SECRET` and `SETTINGS_ENC_KEY` (`openssl rand -base64 32` each; see
`backend/.env`). In login mode, provision the first account with
`uv run create-admin <username>`; sign-in is username/password (or OIDC SSO
via the `OIDC_*` vars), and the shared ESXi target is stored encrypted in the
Mongo settings document — see `CLAUDE.md` for the auth model.

### Endpoints

| Method | Path                 | Backed by | Notes                                              |
|--------|----------------------|-----------|----------------------------------------------------|
| GET    | `/health`            | —         | Liveness; reports the reachable libraries.         |
| POST   | `/generate/hostname` | configgen | `{platform, hostname}` → first-boot hostname script |
| POST   | `/generate/network`  | configgen | `{platform, dhcp?, ip?, prefix?, ...}` → network script |

Invalid input (bad hostname/IP, broken static/DHCP contract) returns **422** with the
validator's message.

```sh
curl -s -X POST localhost:8000/generate/hostname \
  -H 'content-type: application/json' \
  -d '{"platform":"linux","hostname":"web01"}'
```

## Frontend

```sh
cd frontend
pnpm install
pnpm dev                      # http://localhost:5173
```

The dev server proxies `/api/*` to the backend at `http://127.0.0.1:8000`
(override with `VITE_API_TARGET`), so run the backend alongside it. Build with
`pnpm build`, lint with `pnpm lint`.

## TODO (same libraries, more routes + UI)
- `POST /vm/clone`, `POST /vm/update` over `vmkit.clone_workflow` / `update_workflow`
  (needs ESXi connection params).
- `POST /iso` over `isokit.build_script_iso` (accept the generated scripts, return the ISO).
- Network-script form (the `/generate/network` route is wired in the API client already).

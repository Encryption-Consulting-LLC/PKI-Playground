# VM-Deploy-API

A FastAPI backend over the VM deployment libraries — the same `vmkit` / `configgen` / `isokit`
that back the [VM-Setup-Scripts](https://github.com/Arnesh-EC/VM-Setup-Scripts) CLIs. The
libraries are consumed as **versioned git dependencies** (see `pyproject.toml`
`[tool.uv.sources]`) — this repo vendors no library source.

## Run

```sh
git clone git@github-ec:Arnesh-EC/VM-Deploy-API.git
cd VM-Deploy-API
uv sync                       # pulls fastapi + the three libs (from their git tags)
uv run uvicorn app.main:app --reload
```

Then open http://127.0.0.1:8000/docs.

## Endpoints

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

## TODO (same libraries, more routes)
- `POST /vm/clone`, `POST /vm/update` over `vmkit.clone_workflow` / `update_workflow`
  (needs ESXi connection params).
- `POST /iso` over `isokit.build_script_iso` (accept the generated scripts, return the ISO).

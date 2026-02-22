# FireCAD Web App (DWG/DXF → Auto-place → Edit → Export)

This repo is a **complete, runnable MVP** web app based on your Colab notebook pipeline:
- Convert/upload drawing (DXF; DWG supported if ODAFileConverter is installed)
- Render **DXF → PNG + mapping.json** (no letterbox, padded bbox)
- (Optional) Call **Gemini Nano Banana / Nano Banana Pro** to generate a colored mask image
- Align mask back to the rendered PNG (pixel-perfect tight boxes)
- Solidify/rectify walls
- Extract room polygons
- Auto-place smoke detectors (with wall buffer + spacing)
- **Web editor** to move/add/delete detectors (stored in world coordinates)
- Export updated **DXF** with detectors on your layer

> **Reality check (no surprises):**
> - DXF is supported out-of-the-box.
> - DWG requires **ODAFileConverter** (you must install it yourself due to licensing).
> - Gemini calls require `GEMINI_API_KEY` in `.env` (we do not ship any keys).

---

## 1) Quick start (local)

### Prereqs
- Docker + Docker Compose

### Configure env
Copy `.env.example` → `.env` and fill values:

```bash
cp .env.example .env
```

### Run
```bash
docker compose up --build
```

Open:
- Web UI: http://localhost:3000
- API docs: http://localhost:8000/docs

---

## 2) How to use
1. Create a project
2. Upload a DXF (or DWG if ODA is installed)
3. Click **Run Auto-Placement** (optional if you only want manual editing)
4. Edit detectors directly: **drag / double-click to add / right-click to delete**
5. Export DXF

---

## 3) DWG support (ODAFileConverter)
Because ODA licensing doesn’t allow bundling their converter, we provide:
- `api/app/oda/README.txt` with install instructions
- an environment variable `ODA_PATH` to point to the converter binary

If DWG is uploaded and ODA isn’t available, the API will return a clear error and you can upload DXF instead.

---

## 4) Gemini models (Nano Banana)
This repo supports:
- `gemini-2.5-flash-image` (Nano Banana)
- `gemini-3-pro-image-preview` (Nano Banana Pro)

Model names are configurable via env (`GEMINI_IMAGE_MODEL`).

Docs:
- Nano Banana model names and usage: https://ai.google.dev/gemini-api/docs/image-generation
- Google GenAI Python SDK: https://googleapis.github.io/python-genai/

---

## 5) Deploy quickly
This is a standard Docker web app:
- `web` (Next.js) is a container
- `api` (FastAPI) is a container

Any platform supporting Docker Compose or multi-service deployment works:
- a small VM (fastest)
- Render / Fly / Railway / ECS / Kubernetes (later)

For "ship in 1 hour" use a VM:
1. `git clone` this repo
2. add `.env`
3. `docker compose up -d --build`
4. put a reverse proxy (Caddy/Nginx) in front if needed

---

## 6) Repo layout
- `api/` FastAPI backend + your pipeline (ported from the Colab notebook)
- `web/` Next.js editor UI

---

## 7) Security & production notes
This is a usable MVP, not hardened:
- Add auth (password/SSO), rate limits, virus scanning for uploads
- Restrict file size and file types
- Put data on persistent storage (S3, volume)
- Add a job queue (Celery/RQ) if you expect many concurrent runs


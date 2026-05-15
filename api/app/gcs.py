"""Google Cloud Storage integration.

Hybrid model:
  - GCS is the source of truth for project artifacts.
  - The local DATA_DIR is a per-instance cache so the existing pipeline code
    (subprocess tools like QCAD / ODA, PIL, OpenCV, ezdxf, etc.) can keep
    reading and writing local files unchanged.
  - On reads we lazily download missing/stale objects.
  - On writes we upload changed files back to the bucket.
  - Public file URLs (`/files/<rel>`) are redirected to v4 signed URLs so the
    frontend streams directly from GCS.

Configuration (env vars):
  GCS_BUCKET            - bucket name (e.g. "mepit"). If unset, GCS is disabled
                          and everything falls back to local-only behaviour.
  GCS_PREFIX            - optional key prefix inside the bucket (no leading /).
  GCS_SIGNED_URL_TTL    - seconds; default 3600.
  GCS_SIGNER_SA_EMAIL   - optional override for the service account email used
                          when signing URLs via IAM SignBlob (needed on Cloud
                          Run / GCE where the default credentials don't carry
                          a private key).
  DATA_DIR              - local cache root (default /data).

Auth: uses Application Default Credentials. On Cloud Run the attached service
account is picked up automatically. Locally, run
`gcloud auth application-default login` once or point
`GOOGLE_APPLICATION_CREDENTIALS` at a service-account JSON key.
"""

from __future__ import annotations

import os
import threading
from datetime import timedelta
from typing import Optional

DATA_DIR = os.getenv("DATA_DIR", "/data")
GCS_BUCKET = (os.getenv("GCS_BUCKET") or "").strip()
GCS_PREFIX = (os.getenv("GCS_PREFIX") or "").strip().strip("/")
SIGNED_URL_TTL_SECONDS = int(os.getenv("GCS_SIGNED_URL_TTL", "3600"))
SIGNER_SA_EMAIL_OVERRIDE = (os.getenv("GCS_SIGNER_SA_EMAIL") or "").strip() or None

_client = None
_bucket = None
_init_lock = threading.Lock()
_disabled_reason: Optional[str] = None

# ---------------------------------------------------------------------------
# Lazy client / bucket init
# ---------------------------------------------------------------------------


def _get_client():
    global _client, _disabled_reason
    if _client is not None:
        return _client
    if not GCS_BUCKET:
        _disabled_reason = "GCS_BUCKET env var not set"
        return None
    with _init_lock:
        if _client is None:
            try:
                from google.cloud import storage  # type: ignore

                _client = storage.Client()
            except ImportError as exc:
                _disabled_reason = (
                    f"google-cloud-storage not installed in image: {exc!r}. "
                    "Rebuild the API image (docker compose build api)."
                )
                print(f"[gcs] disabled: {_disabled_reason}")
                return None
            except Exception as exc:  # pragma: no cover - depends on env
                _disabled_reason = f"google.cloud.storage init failed: {exc!r}"
                print(f"[gcs] disabled: {_disabled_reason}")
                return None
    return _client


def _get_bucket():
    global _bucket
    if _bucket is not None:
        return _bucket
    client = _get_client()
    if client is None:
        return None
    with _init_lock:
        if _bucket is None:
            try:
                _bucket = client.bucket(GCS_BUCKET)
            except Exception as exc:  # pragma: no cover
                print(f"[gcs] bucket() failed: {exc!r}")
                return None
    return _bucket


def enabled() -> bool:
    return _get_bucket() is not None


def disabled_reason() -> Optional[str]:
    return _disabled_reason


# ---------------------------------------------------------------------------
# Key <-> local path translation
# ---------------------------------------------------------------------------


def _norm_rel(rel: str) -> str:
    return rel.replace("\\", "/").lstrip("/")


def key_for_local(local_path: str) -> str:
    """Map a local file path (under DATA_DIR) to its bucket key."""
    abs_path = os.path.abspath(local_path)
    base = os.path.abspath(DATA_DIR)
    if not abs_path.startswith(base):
        raise ValueError(f"path not under DATA_DIR: {local_path}")
    rel = abs_path[len(base):].lstrip(os.sep).replace(os.sep, "/")
    return f"{GCS_PREFIX}/{rel}" if GCS_PREFIX else rel


def key_for_rel(rel_path: str) -> str:
    rel = _norm_rel(rel_path)
    return f"{GCS_PREFIX}/{rel}" if GCS_PREFIX else rel


def local_for_key(key: str) -> str:
    if GCS_PREFIX and key.startswith(GCS_PREFIX + "/"):
        key = key[len(GCS_PREFIX) + 1:]
    return os.path.join(DATA_DIR, key.replace("/", os.sep))


def blob_exists(local_path: str) -> bool:
    """Return True if the GCS object mirroring `local_path` exists in the bucket."""
    if not enabled():
        return False
    try:
        bucket = _get_bucket()
        return bucket.blob(key_for_local(local_path)).exists()
    except Exception as exc:
        print(f"[gcs] blob_exists failed {local_path}: {exc!r}")
        return False


# ---------------------------------------------------------------------------
# Uploads
# ---------------------------------------------------------------------------


def upload_path(local_path: str) -> bool:
    """Upload a single local file. Returns True on success."""
    if not enabled() or not os.path.isfile(local_path):
        return False
    try:
        bucket = _get_bucket()
        blob = bucket.blob(key_for_local(local_path))
        blob.upload_from_filename(local_path)
        return True
    except Exception as exc:
        print(f"[gcs] upload_path failed {local_path}: {exc!r}")
        return False


def upload_dir(local_dir: str, since_ts: float = 0.0) -> int:
    """Upload every file under local_dir (optionally only those modified after since_ts)."""
    if not enabled() or not os.path.isdir(local_dir):
        return 0
    count = 0
    for root, _dirs, files in os.walk(local_dir):
        for name in files:
            p = os.path.join(root, name)
            try:
                if since_ts > 0 and os.path.getmtime(p) <= since_ts:
                    continue
            except OSError:
                continue
            if upload_path(p):
                count += 1
    return count


# ---------------------------------------------------------------------------
# Downloads / cache hydration
# ---------------------------------------------------------------------------


def download_to_local(key: str, local_path: str) -> bool:
    if not enabled():
        return False
    try:
        bucket = _get_bucket()
        blob = bucket.blob(key)
        if not blob.exists():
            return False
        os.makedirs(os.path.dirname(local_path) or ".", exist_ok=True)
        blob.download_to_filename(local_path)
        return True
    except Exception as exc:
        print(f"[gcs] download failed key={key}: {exc!r}")
        return False


def ensure_rel_cached(rel_path: str) -> Optional[str]:
    """Make sure a single object is present in the local cache. Returns the local path or None."""
    rel = _norm_rel(rel_path)
    local_path = os.path.join(DATA_DIR, rel.replace("/", os.sep))
    if os.path.isfile(local_path):
        return local_path
    if not enabled():
        return None
    if download_to_local(key_for_rel(rel), local_path):
        return local_path
    return None


def sync_project_to_gcs(project_id: str) -> int:
    """Upload every file in the project's local cache dir to GCS.

    Intended to be chained as a FastAPI BackgroundTask immediately AFTER the
    long-running pipeline task that produced those files. Safe no-op when GCS
    is disabled.
    """
    if not project_id:
        return 0
    if not enabled():
        print(
            f"[gcs] sync_project_to_gcs({project_id}) skipped: "
            f"GCS disabled (reason={_disabled_reason!r}, bucket={GCS_BUCKET!r})"
        )
        return 0
    local_dir = os.path.join(DATA_DIR, "projects", project_id)
    if not os.path.isdir(local_dir):
        print(f"[gcs] sync_project_to_gcs({project_id}) skipped: no local dir {local_dir}")
        return 0
    print(f"[gcs] sync_project_to_gcs({project_id}) starting upload from {local_dir} ...")
    n = upload_dir(local_dir)
    if n:
        print(f"[gcs] post-pipeline sync uploaded {n} files for project {project_id}")
    else:
        print(f"[gcs] post-pipeline sync: nothing to upload for project {project_id}")
    return n


def log_startup_status() -> None:
    """Print a single diagnostic line at API startup describing GCS state."""
    print(
        "[gcs] startup diagnostics: "
        f"GCS_BUCKET={GCS_BUCKET!r}, "
        f"GCS_PREFIX={GCS_PREFIX!r}, "
        f"DATA_DIR={DATA_DIR!r}, "
        f"GOOGLE_APPLICATION_CREDENTIALS={os.getenv('GOOGLE_APPLICATION_CREDENTIALS')!r}, "
        f"creds_file_exists="
        f"{os.path.isfile(os.getenv('GOOGLE_APPLICATION_CREDENTIALS') or '')}"
    )
    if not GCS_BUCKET:
        print("[gcs] startup: DISABLED (GCS_BUCKET not set; falling back to local-only DATA_DIR)")
        return
    # Force lazy init NOW so any error surfaces on boot, not on first request.
    bucket = _get_bucket()
    if bucket is None:
        print(
            f"[gcs] startup: DISABLED (reason={_disabled_reason!r}). "
            "Uploads will silently no-op until this is fixed."
        )
        return
    # Confirm we can actually talk to the bucket.
    try:
        bucket.reload()  # GET bucket metadata; fails on auth / permission / typo
        print(f"[gcs] startup: OK, connected to gs://{GCS_BUCKET}/")
    except Exception as exc:  # pragma: no cover
        print(
            f"[gcs] startup: bucket reachable check FAILED for gs://{GCS_BUCKET}/: {exc!r}. "
            "Likely causes: bucket name typo, SA lacks storage.objectViewer on the bucket, "
            "or service-account key is for the wrong project."
        )


def ensure_project_cached(project_id: str) -> int:
    """Download any missing / stale objects under projects/<id>/ into the local cache."""
    if not enabled() or not project_id:
        return 0
    bucket = _get_bucket()
    prefix = key_for_rel(f"projects/{project_id}/")
    count = 0
    try:
        for blob in bucket.list_blobs(prefix=prefix):
            if blob.name.endswith("/"):
                continue
            local_path = local_for_key(blob.name)
            try:
                if os.path.isfile(local_path) and blob.updated is not None:
                    if os.path.getmtime(local_path) >= blob.updated.timestamp():
                        continue
            except Exception:
                pass
            try:
                os.makedirs(os.path.dirname(local_path) or ".", exist_ok=True)
                blob.download_to_filename(local_path)
                count += 1
            except Exception as exc:
                print(f"[gcs] cache download failed {blob.name}: {exc!r}")
    except Exception as exc:
        print(f"[gcs] list_blobs failed prefix={prefix}: {exc!r}")
    return count


# ---------------------------------------------------------------------------
# Signed URLs (v4) - works with Cloud Run / GCE creds via IAM SignBlob.
# ---------------------------------------------------------------------------

_signing_kwargs_cache: Optional[dict] = None
_signing_lock = threading.Lock()


def _resolve_signing_kwargs() -> dict:
    """Build the kwargs needed for generate_signed_url under ADC.

    Two cases:
      1. Service-account JSON key file (typical local dev / GOOGLE_APPLICATION_CREDENTIALS):
         the credentials object carries the private key, so we return ``{}`` and
         let ``generate_signed_url`` sign locally. This needs no extra IAM role.
      2. Workload identity / Cloud Run / GCE: the credentials have no private
         key. We then sign via the IAM SignBlob API, which requires the runtime
         service account to hold ``roles/iam.serviceAccountTokenCreator`` on
         itself (or on ``GCS_SIGNER_SA_EMAIL``). We pass ``service_account_email``
         and ``access_token`` so google-cloud-storage delegates signing to IAM.
    """
    global _signing_kwargs_cache
    if _signing_kwargs_cache is not None:
        return _signing_kwargs_cache
    with _signing_lock:
        if _signing_kwargs_cache is not None:
            return _signing_kwargs_cache
        kwargs: dict = {}
        try:
            import google.auth  # type: ignore
            from google.auth.transport import requests as g_requests  # type: ignore
            from google.oauth2 import service_account  # type: ignore

            creds, _proj = google.auth.default(
                scopes=["https://www.googleapis.com/auth/cloud-platform"]
            )

            # Case 1: real service-account key file -> creds can sign on their
            # own. Returning empty kwargs lets generate_signed_url use the
            # embedded private key directly. This is the path that works for
            # local dev with GOOGLE_APPLICATION_CREDENTIALS.
            if isinstance(creds, service_account.Credentials):
                print("[gcs] signed URLs will be signed locally with the service-account private key")
                _signing_kwargs_cache = kwargs
                return kwargs

            # Case 2: Compute / Cloud Run / user creds -> no private key.
            # Fall back to IAM SignBlob (requires Token Creator role).
            try:
                creds.refresh(g_requests.Request())
            except Exception as exc:
                print(f"[gcs] creds.refresh failed: {exc!r}")
            sa_email = (
                SIGNER_SA_EMAIL_OVERRIDE
                or getattr(creds, "service_account_email", None)
                or getattr(creds, "_service_account_email", None)
            )
            token = getattr(creds, "token", None)
            if sa_email and token:
                kwargs["service_account_email"] = sa_email
                kwargs["access_token"] = token
                print(
                    f"[gcs] signed URLs will use IAM SignBlob via sa={sa_email}. "
                    "If this fails with PERMISSION_DENIED, grant "
                    "'roles/iam.serviceAccountTokenCreator' to that SA on itself."
                )
            else:
                print(
                    "[gcs] WARNING: cannot determine signer service-account email; "
                    "signed URLs will likely fail. Set GCS_SIGNER_SA_EMAIL or mount "
                    "a service-account key via GOOGLE_APPLICATION_CREDENTIALS."
                )
        except Exception as exc:
            print(f"[gcs] signing kwargs resolution failed: {exc!r}")
        _signing_kwargs_cache = kwargs
        return kwargs


def signed_url_for_rel(rel_path: str, ttl_seconds: Optional[int] = None) -> Optional[str]:
    if not enabled():
        return None
    try:
        bucket = _get_bucket()
        blob = bucket.blob(key_for_rel(rel_path))
        ttl = ttl_seconds or SIGNED_URL_TTL_SECONDS
        kwargs = _resolve_signing_kwargs()
        return blob.generate_signed_url(
            version="v4",
            expiration=timedelta(seconds=ttl),
            method="GET",
            **kwargs,
        )
    except Exception as exc:
        # Common cause: credentials lack a private key AND the signer SA is
        # missing iam.serviceAccountTokenCreator on itself. We surface this
        # once; callers fall back to streaming the file from the local cache.
        print(f"[gcs] signed_url failed rel={rel_path}: {exc!r}")
        return None

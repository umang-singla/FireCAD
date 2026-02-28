import os
import base64
import hashlib
import hmac
import secrets
import uuid
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from app.db import db, now

router = APIRouter(prefix="/auth", tags=["auth"])

SESSION_DAYS = int(os.getenv("SESSION_DAYS", "30"))
COOKIE_NAME = "firecad_token"
PBKDF2_ITERS = int(os.getenv("PBKDF2_ITERS", "200000"))


class RegisterIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    email: str
    password: str = Field(min_length=8, max_length=500)  # allow long passwords safely


class LoginIn(BaseModel):
    email: str
    password: str = Field(min_length=1, max_length=500)


def _new_salt_b64() -> str:
    return base64.b64encode(secrets.token_bytes(16)).decode("utf-8")


def _hash_password(password: str, salt_b64: str) -> str:
    salt = base64.b64decode(salt_b64.encode("utf-8"))
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITERS)
    return base64.b64encode(dk).decode("utf-8")


def _verify_password(password: str, salt_b64: str, hash_b64: str) -> bool:
    test = _hash_password(password, salt_b64)
    return hmac.compare_digest(test, hash_b64)


def _create_session(user_id: str) -> str:
    token = secrets.token_urlsafe(32)
    expires_at = now() + SESSION_DAYS * 24 * 60 * 60
    with db() as con:
        con.execute(
            "INSERT INTO sessions(token, user_id, expires_at, created_at) VALUES(?,?,?,?)",
            (token, user_id, expires_at, now()),
        )
    return token


def _get_token_from_request(req: Request) -> Optional[str]:
    auth = req.headers.get("authorization") or req.headers.get("Authorization")
    if auth and auth.lower().startswith("bearer "):
        return auth.split(" ", 1)[1].strip()
    cookie = req.cookies.get(COOKIE_NAME)
    if cookie:
        return cookie
    return None


def get_current_user(req: Request) -> dict:
    token = _get_token_from_request(req)
    if not token:
        raise HTTPException(status_code=401, detail="Missing token")

    with db() as con:
        row = con.execute(
            """
            SELECT u.id, u.name, u.email
            FROM sessions s
            JOIN users u ON u.id = s.user_id
            WHERE s.token = ? AND s.expires_at > ?
            """,
            (token, now()),
        ).fetchone()

    if not row:
        raise HTTPException(status_code=401, detail="Invalid/expired token")

    return {"id": row["id"], "name": row["name"], "email": row["email"]}


@router.post("/register")
def register(payload: RegisterIn):
    with db() as con:
        exists = con.execute("SELECT 1 FROM users WHERE email = ?", (payload.email,)).fetchone()
        if exists:
            raise HTTPException(status_code=409, detail="Email already registered")

        user_id = str(uuid.uuid4())
        salt = _new_salt_b64()
        pw_hash = _hash_password(payload.password, salt)

        con.execute(
            "INSERT INTO users(id, name, email, pw_salt, pw_hash, created_at) VALUES(?,?,?,?,?,?)",
            (user_id, payload.name, payload.email, salt, pw_hash, now()),
        )

    token = _create_session(user_id)
    return {"token": token, "user": {"id": user_id, "name": payload.name, "email": payload.email}}


@router.post("/login")
def login(payload: LoginIn):
    with db() as con:
        row = con.execute(
            "SELECT id, name, email, pw_salt, pw_hash FROM users WHERE email = ?",
            (payload.email,),
        ).fetchone()

    if not row:
        raise HTTPException(status_code=401, detail="Invalid email/password")

    if not _verify_password(payload.password, row["pw_salt"], row["pw_hash"]):
        raise HTTPException(status_code=401, detail="Invalid email/password")

    token = _create_session(row["id"])
    return {"token": token, "user": {"id": row["id"], "name": row["name"], "email": row["email"]}}


@router.get("/me")
def me(req: Request):
    return get_current_user(req)


@router.post("/logout")
def logout(req: Request):
    token = _get_token_from_request(req)
    if not token:
        return {"ok": True}
    with db() as con:
        con.execute("DELETE FROM sessions WHERE token = ?", (token,))
    return {"ok": True}

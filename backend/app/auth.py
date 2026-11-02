from __future__ import annotations

import hashlib
import hmac
import secrets
from datetime import UTC, datetime, timedelta

from fastapi import HTTPException, Request, Response

from .models import Login, User, now

COOKIE = "famsun_session"


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=16384, r=8, p=1, dklen=32)
    return f"scrypt${salt.hex()}${digest.hex()}"


def verify_password(password: str, encoded: str) -> bool:
    try:
        algorithm, salt, digest = encoded.split("$")
        if algorithm != "scrypt":
            return False
        actual = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1, dklen=32)
        return hmac.compare_digest(actual.hex(), digest)
    except (ValueError, TypeError):
        return False


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def user_json(user: User) -> dict:
    return {"id": user.id, "email": user.email, "name": user.name, "role": user.role}


def current_user(request: Request) -> User:
    token = request.cookies.get(COOKIE)
    if not token:
        raise HTTPException(401, "请先登录工作空间")
    with request.app.state.db.session() as db:
        login = db.get(Login, token_hash(token))
        if not login or login.expires_at < now():
            raise HTTPException(401, "登录已过期，请重新登录")
        user = db.get(User, login.user_id)
        if not user:
            raise HTTPException(401, "请重新登录")
        return user


def admin_user(request: Request) -> User:
    user = current_user(request)
    if user.role != "admin":
        raise HTTPException(403, "只有管理员可以修改此配置")
    return user


def set_login(request: Request, response: Response, user: User):
    settings = request.app.state.settings
    token = secrets.token_urlsafe(48)
    expires = datetime.now(UTC) + timedelta(days=settings.session_days)
    with request.app.state.db.session() as db:
        old = request.cookies.get(COOKIE)
        if old:
            prior = db.get(Login, token_hash(old))
            if prior:
                db.delete(prior)
        db.add(Login(token_hash=token_hash(token), user_id=user.id, expires_at=expires.isoformat()))
        db.commit()
    response.set_cookie(
        COOKIE,
        token,
        max_age=settings.session_days * 86400,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
        path="/",
    )

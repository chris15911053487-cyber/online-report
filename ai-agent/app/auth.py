"""Scoped token 校验：与主后端 server/src/ai-scoped-token.js 的 HMAC 方案一致。

Token 格式： base64url(payloadJson) + "." + base64url(HMAC_SHA256(secret, payloadB64))
Agent 仅需"校验 + 解析"，并在回调主后端时原样转发该 token 字符串（无需自行签发）。
"""
import base64
import hashlib
import hmac
import json
import time

from .config import settings


def _b64url_decode(s: str) -> bytes:
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)


def _b64url_encode(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode("ascii").rstrip("=")


def verify_scoped_token(token: str) -> dict:
    """校验并返回 payload；失败抛 ValueError。"""
    if not token or "." not in token:
        raise ValueError("malformed token")
    payload_b64, sig = token.split(".", 1)
    if not payload_b64 or not sig:
        raise ValueError("malformed token")

    expected = _b64url_encode(
        hmac.new(settings.SCOPED_SECRET.encode("utf-8"), payload_b64.encode("utf-8"), hashlib.sha256).digest()
    )
    if not hmac.compare_digest(sig, expected):
        raise ValueError("bad signature")

    try:
        payload = json.loads(_b64url_decode(payload_b64).decode("utf-8"))
    except Exception as exc:  # noqa: BLE001
        raise ValueError("bad payload") from exc

    if payload.get("scope") != "ai-agent":
        raise ValueError("bad scope")
    exp = payload.get("exp")
    if not isinstance(exp, (int, float)) or exp < time.time():
        raise ValueError("token expired")
    return payload

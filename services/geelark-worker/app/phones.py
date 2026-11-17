"""Converte os phones da API do GeeLark para o tipo `Phone` do contrato."""

from __future__ import annotations

import re
from typing import Any

STATUS = {0: "on", 1: "starting", 2: "off", 3: "expired"}
PROXY_TYPES = {1: "socks5", 2: "http", 3: "https"}


def _android(system_ver: Any) -> str:
    text = str(system_ver or "").strip()
    if not text:
        return "Android ?"
    return text if re.match(r"(?i)^android", text) else f"Android {text}"


def _proxy(proxy: Any) -> str | None:
    if not isinstance(proxy, dict):
        return None
    server = str(proxy.get("server") or "").strip()
    if not server:
        return None
    kind = proxy.get("type")
    if isinstance(kind, int) or (isinstance(kind, str) and kind.isdigit()):
        kind = PROXY_TYPES.get(int(kind), str(kind))
    kind = str(kind or "proxy").lower()
    port = proxy.get("port")
    return f"{kind} {server}:{port}" if port else f"{kind} {server}"


def to_phone(item: dict, busy_job_id: str | None, apps: dict[str, bool] | None) -> dict:
    """`apps` vem do cache do worker (o que o último job viu pelo `pm list packages`);
    sem job anterior no phone fica `null` (desconhecido)."""
    try:
        status = STATUS.get(int(item.get("status")), "unknown")
    except (TypeError, ValueError):
        status = "unknown"
    return {
        "id": str(item.get("id")),
        "name": str(item.get("serialName") or item.get("serialNo") or item.get("id")),
        "status": status,
        "android": _android(item.get("systemVer")),
        "proxy": _proxy(item.get("proxy")),
        "apps": {
            "whatsapp": apps.get("whatsapp") if apps else None,
            "business": apps.get("business") if apps else None,
        },
        "busyJobId": busy_job_id,
    }

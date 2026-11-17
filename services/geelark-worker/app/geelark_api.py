"""Cliente da OpenAPI do GeeLark (https://openapi.geelark.com).

Regras que este módulo respeita:
- Todas as chamadas são POST com JSON; sucesso é `code == 0` no corpo.
- Limite de 200 req/min por endpoint; estourar bloqueia a conta por 2 horas. Por isso as
  chamadas são serializadas (um lock para o processo inteiro) com intervalo mínimo de 350 ms.
- Só 40007 (rate limit) e 47002 (concorrência) são repetidos. Erros de autenticação nunca:
  falhar várias vezes bloqueia a autenticação por 2 h (40014).
- O token e a senha do proxy nunca vão para log nem para mensagens de erro.
"""

from __future__ import annotations

import logging
import threading
import time
import uuid
from typing import Any, Callable

import requests

BASE_URL = "https://openapi.geelark.com"

log = logging.getLogger(__name__)

# Erros transitórios: vale esperar e tentar de novo (segundos de espera).
RETRYABLE = {
    40007: 60,  # rate limit: libera no minuto seguinte
    47002: 10,  # limite de concorrência
}
PROXY_CHECK_FAILED = 45004  # o GeeLark testou o proxy e ele não funcionou

# Status do cloud phone (/phone/status e /phone/list)
PHONE_STARTED = 0
PHONE_STARTING = 1
PHONE_OFF = 2
PHONE_EXPIRED = 3


class GeeLarkError(Exception):
    def __init__(self, code: int, msg: str, trace_id: str, path: str):
        self.code = code
        self.msg = msg
        self.trace_id = trace_id
        self.path = path
        super().__init__(f"[{code}] {msg} (path={path}, traceId={trace_id})")


class GeeLarkAPI:
    def __init__(
        self,
        token: str,
        min_interval: float = 0.35,
        base_url: str = BASE_URL,
        sleep: Callable[[float], None] = time.sleep,
        session: requests.Session | None = None,
    ):
        self._token = token
        self._min_interval = min_interval
        self._base_url = base_url.rstrip("/")
        self._sleep = sleep
        self._session = session or requests.Session()
        self._lock = threading.Lock()  # serializa TODAS as chamadas do processo
        self._last_call = 0.0

    def __repr__(self) -> str:  # nunca expor o token
        return f"GeeLarkAPI(base_url={self._base_url!r})"

    @property
    def configured(self) -> bool:
        return bool(self._token)

    # ------------------------------------------------------------------ core
    def call(self, path: str, body: dict | None = None, retries: int = 3) -> Any:
        if not self._token:
            raise GeeLarkError(-1, "GEELARK_API_TOKEN não configurado", "", path)
        for attempt in range(retries + 1):
            trace_id = str(uuid.uuid4())
            try:
                with self._lock:
                    wait = self._min_interval - (time.monotonic() - self._last_call)
                    if wait > 0:
                        self._sleep(wait)
                    try:
                        resp = self._session.post(
                            self._base_url + path,
                            json=body or {},
                            headers={
                                "Content-Type": "application/json",
                                "traceId": trace_id,
                                "Authorization": f"Bearer {self._token}",
                            },
                            timeout=30,
                        )
                    finally:
                        self._last_call = time.monotonic()
            except (requests.ConnectionError, requests.Timeout) as exc:
                if attempt == retries:
                    raise GeeLarkError(-1, f"falha de rede: {type(exc).__name__}", trace_id, path) from None
                wait = 2 ** attempt
                log.warning("Falha de rede em %s (%s); tentando de novo em %ss", path, type(exc).__name__, wait)
                self._sleep(wait)
                continue

            if resp.status_code >= 400:
                raise GeeLarkError(resp.status_code, f"HTTP {resp.status_code}", trace_id, path)
            try:
                payload = resp.json()
            except ValueError:
                raise GeeLarkError(-1, "resposta não é JSON", trace_id, path) from None

            code = payload.get("code")
            if code == 0:
                return payload.get("data")

            msg = str(payload.get("msg", ""))
            if code in RETRYABLE and attempt < retries:
                wait = RETRYABLE[code]
                log.warning("GeeLark %s em %s; aguardando %ss", code, path, wait)
                self._sleep(wait)
                continue
            raise GeeLarkError(code if isinstance(code, int) else -1, msg, payload.get("traceId", trace_id), path)
        raise RuntimeError("inalcançável")

    @staticmethod
    def _single_result(data: dict | None, phone_id: str, path: str) -> dict:
        """Endpoints em lote devolvem successDetails/failDetails; extrai o do nosso phone."""
        data = data or {}
        for fail in data.get("failDetails") or []:
            if str(fail.get("id")) == phone_id:
                raise GeeLarkError(fail.get("code", -1), str(fail.get("msg", "")), "", path)
        for ok in data.get("successDetails") or []:
            if str(ok.get("id")) == phone_id:
                return ok
        return {}

    # ---------------------------------------------------------------- phones
    def list_phones(self) -> list[dict]:
        """Todos os cloud phones da conta (paginando de 100 em 100)."""
        phones: list[dict] = []
        page = 1
        while True:
            data = self.call("/open/v1/phone/list", {"page": page, "pageSize": 100}) or {}
            items = data.get("items") or []
            phones += items
            if not items or len(phones) >= (data.get("total") or 0):
                return phones
            page += 1

    def get_phone(self, phone_id: str) -> dict | None:
        return next((p for p in self.list_phones() if str(p.get("id")) == phone_id), None)

    def phone_status(self, phone_id: str) -> int:
        path = "/open/v1/phone/status"
        result = self._single_result(self.call(path, {"ids": [phone_id]}), phone_id, path)
        if "status" not in result:
            raise GeeLarkError(-1, "status do phone não veio na resposta", "", path)
        return int(result["status"])

    def start_phone(self, phone_id: str) -> None:
        path = "/open/v1/phone/start"
        self._single_result(self.call(path, {"ids": [phone_id]}), phone_id, path)

    def stop_phone(self, phone_id: str) -> None:
        path = "/open/v1/phone/stop"
        self._single_result(self.call(path, {"ids": [phone_id]}), phone_id, path)

    def update_proxy(self, phone_id: str, type_id: int, server: str, port: int, username: str, password: str) -> None:
        """Troca o proxy do phone. O phone precisa estar DESLIGADO.

        Código 45004 = o GeeLark testou o proxy e ele não respondeu.
        """
        self.call("/open/v1/phone/detail/update", {
            "id": phone_id,
            "proxyConfig": {
                "typeId": type_id, "server": server, "port": port,
                "username": username, "password": password,
            },
        })

    # ------------------------------------------------------------------- adb
    def set_adb(self, phone_id: str, enabled: bool) -> None:
        self.call("/open/v1/adb/setStatus", {"ids": [phone_id], "open": enabled})

    def adb_info(self, phone_id: str) -> dict | None:
        """Retorna {ip, port, pwd} (port sempre str) ou None se o ADB ainda não estiver pronto."""
        data = self.call("/open/v1/adb/getData", {"ids": [phone_id]}) or {}
        for item in data.get("items") or []:
            if str(item.get("id")) == phone_id and item.get("code") == 0 and item.get("ip") and item.get("port"):
                return {"ip": str(item["ip"]), "port": str(item["port"]), "pwd": str(item.get("pwd") or "")}
        return None

    # ------------------------------------------------------------------ apps
    def installable_apps(self, phone_id: str, name: str) -> list[dict]:
        data = self.call(
            "/open/v1/app/installable/list",
            {"envId": phone_id, "name": name, "page": 1, "pageSize": 50},
        ) or {}
        return data.get("items") or []

    def install_app(self, phone_id: str, app_version_id: str) -> None:
        self.call("/open/v1/app/install", {"envId": phone_id, "appVersionId": app_version_id})

    def start_app(self, phone_id: str, package_name: str) -> None:
        self.call("/open/v1/app/start", {"envId": phone_id, "packageName": package_name})

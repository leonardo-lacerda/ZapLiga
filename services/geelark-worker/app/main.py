"""API HTTP interna do geelark-worker (contrato, seção 2).

Rodar: `uvicorn app.main:create_app --factory --host 0.0.0.0 --port 8080`
"""

from __future__ import annotations

import hmac
import logging

from fastapi import Depends, FastAPI, Header, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from starlette.exceptions import HTTPException as StarletteHTTPException

from .config import Settings
from .device_automation import make_factory
from .errors import ApiError
from .geelark_api import PHONE_OFF, PROXY_CHECK_FAILED, GeeLarkAPI, GeeLarkError
from .jobs import JobManager
from .phones import to_phone
from .schemas import CreatePhone, CreateWorkerJob, JobInput, ProfileInput

log = logging.getLogger("geelark_worker")

QUIET_LOGGERS = ("urllib3", "uiautomator2", "adbutils", "requests", "PIL")


def _configure_logging() -> None:
    root = logging.getLogger()
    if not root.handlers:
        logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    # Bibliotecas que podem logar comandos shell (com códigos digitados): só avisos.
    for name in QUIET_LOGGERS:
        logging.getLogger(name).setLevel(logging.WARNING)


def _error(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": code, "message": message})


def create_app(
    settings: Settings | None = None,
    geelark: GeeLarkAPI | None = None,
    manager: JobManager | None = None,
) -> FastAPI:
    _configure_logging()
    settings = settings or Settings.from_env()
    geelark = geelark or GeeLarkAPI(settings.geelark_api_token)
    manager = manager or JobManager(
        factory=make_factory(geelark),
        max_jobs=settings.max_jobs,
        input_timeout_s=settings.input_timeout_s,
        job_timeout_s=settings.job_timeout_s,
        debug_dir=settings.debug_dir,
        stop_phone=geelark.stop_phone,
    )
    # Só o manager real (não o dos testes) tem como desligar phones.
    if getattr(manager, "_stop_phone", None) is not None:
        manager.start_watchdog()
    if not settings.worker_token:
        log.warning("GEELARK_WORKER_TOKEN vazio: todas as rotas (exceto /health) vão responder 401")
    if not settings.geelark_api_token:
        log.warning("GEELARK_API_TOKEN vazio: /phones e os jobs vão falhar")

    app = FastAPI(title="geelark-worker", docs_url=None, redoc_url=None, openapi_url=None)
    app.state.manager = manager
    app.state.geelark = geelark

    # ------------------------------------------------------------ erros
    @app.exception_handler(ApiError)
    async def api_error(_: Request, exc: ApiError) -> JSONResponse:
        return _error(exc.status, exc.code, exc.message)

    @app.exception_handler(RequestValidationError)
    async def validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
        # Nunca ecoar o corpo (tem senha do proxy, códigos...): só campo + motivo.
        parts = []
        for err in exc.errors()[:5]:
            loc = ".".join(str(p) for p in err.get("loc", ()) if p != "body")
            parts.append(f"{loc}: {err.get('msg')}" if loc else str(err.get("msg")))
        return _error(400, "invalid_request", "; ".join(parts) or "corpo inválido")

    @app.exception_handler(StarletteHTTPException)
    async def http_error(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        codes = {404: "not_found", 405: "method_not_allowed"}
        return _error(exc.status_code, codes.get(exc.status_code, "http_error"), str(exc.detail))

    @app.exception_handler(Exception)
    async def unexpected(_: Request, exc: Exception) -> JSONResponse:
        log.exception("erro inesperado na API do worker")
        return _error(500, "internal", f"Erro interno no worker ({type(exc).__name__}).")

    # ------------------------------------------------------------ auth
    def require_token(x_worker_token: str | None = Header(default=None, alias="x-worker-token")) -> None:
        expected = settings.worker_token
        if not expected or not x_worker_token or not hmac.compare_digest(
            x_worker_token.encode("utf-8"), expected.encode("utf-8")
        ):
            raise ApiError(401, "unauthorized", "x-worker-token ausente ou inválido.")

    auth = [Depends(require_token)]

    # ------------------------------------------------------------ rotas
    @app.get("/health")
    def health() -> dict:
        return {"ok": True}

    @app.get("/phones", dependencies=auth)
    def list_phones() -> dict:
        try:
            items = geelark.list_phones()
        except GeeLarkError as exc:
            log.warning("GeeLark /phone/list falhou: %s", exc)
            raise ApiError(502, "geelark_error", f"A API do GeeLark respondeu erro ({exc.code}).") from None
        phones = []
        for item in items:
            pid = str(item.get("id"))
            phones.append(to_phone(item, manager.busy_job_for(pid), manager.known_apps(pid)))
        return {"items": phones}

    @app.post("/phones", dependencies=auth, status_code=201)
    def create_phone(body: CreatePhone) -> dict:
        net_type = 1 if int(body.androidVersion.split()[1]) >= 12 else None  # dados móveis (só Android 12+)
        try:
            detail = geelark.create_phone(body.name, body.androidVersion, body.proxy_url(), net_type=net_type)
        except GeeLarkError as exc:
            if exc.code == PROXY_CHECK_FAILED:
                raise ApiError(409, "egress_offline",
                               "O GeeLark testou a internet pelo PC escolhido e ela não respondeu. "
                               "Confira se o PC está online e tente de novo.") from None
            log.warning("GeeLark /phone/addNew falhou: %s", exc)
            detail_msg = f": {exc.msg}" if exc.msg and exc.code != -1 else ""
            raise ApiError(502, "geelark_error", f"O GeeLark não criou o phone ({exc.code}{detail_msg}).") from None
        pid = str(detail["id"])
        log.info("phone criado: %s (%s)", pid, body.androidVersion)
        try:
            item = geelark.get_phone(pid)
        except GeeLarkError:
            item = None
        # A lista do GeeLark pode demorar a mostrar o phone novo: monta com o que a criação devolveu.
        item = item or {"id": pid, "serialName": detail.get("profileName") or body.name, "status": PHONE_OFF,
                        "systemVer": (detail.get("equipmentInfo") or {}).get("osVersion") or body.androidVersion,
                        "proxy": {"type": body.proxy.typeId, "server": body.proxy.server, "port": body.proxy.port}}
        return to_phone(item, None, None)

    @app.post("/phones/{phone_id}/stop", dependencies=auth)
    def stop_phone(phone_id: str) -> dict:
        manager.cancel_phone(phone_id)  # se houver job nele, cancela (o job também desliga)
        try:
            geelark.stop_phone(phone_id)
        except GeeLarkError as exc:
            # Phone já desligado também conta como sucesso.
            try:
                if geelark.phone_status(phone_id) == PHONE_OFF:
                    return {"ok": True}
            except GeeLarkError:
                pass
            raise ApiError(502, "geelark_error", f"O GeeLark não desligou o phone ({exc.code}).") from None
        return {"ok": True}

    @app.post("/jobs", dependencies=auth, status_code=201)
    def create_job(body: CreateWorkerJob) -> dict:
        job = manager.create(body.to_spec())
        return manager.snapshot(job)

    def _job_or_404(job_id: str):
        job = manager.get(job_id)
        if job is None:
            raise ApiError(404, "not_found", "Job não encontrado (o worker pode ter reiniciado).")
        return job

    @app.get("/jobs/{job_id}", dependencies=auth)
    def get_job(job_id: str) -> dict:
        return manager.snapshot(_job_or_404(job_id))

    @app.post("/jobs/{job_id}/input", dependencies=auth)
    def job_input(job_id: str, body: JobInput) -> dict:
        _job_or_404(job_id)
        data = body.model_dump()
        if isinstance(body, ProfileInput):
            try:
                data["photo"] = body.photo_bytes()
            except ValueError as exc:
                raise ApiError(400, "invalid_request", str(exc)) from None
            data.pop("photoBase64", None)
            if data["photo"] and not data.get("photoMime"):
                data["photoMime"] = "image/jpeg"
        job = manager.submit_input(job_id, data)
        return manager.snapshot(job)

    @app.post("/jobs/{job_id}/cancel", dependencies=auth)
    def cancel_job(job_id: str) -> dict:
        return manager.snapshot(manager.cancel(job_id))

    @app.get("/jobs/{job_id}/screen", dependencies=auth)
    def live_screen(job_id: str) -> Response:
        png = manager.live_screen(job_id)
        if not png:
            raise ApiError(404, "not_found", "Sem tela ao vivo: o job ainda não conectou ao phone ou já terminou.")
        return Response(content=png, media_type="image/png", headers={"Cache-Control": "no-store"})

    @app.get("/jobs/{job_id}/screenshot", dependencies=auth)
    def screenshot(job_id: str) -> Response:
        job = _job_or_404(job_id)
        png = job.screenshot
        if not png:
            raise ApiError(404, "not_found", "Este job não tem screenshot.")
        return Response(content=png, media_type="image/png")

    return app

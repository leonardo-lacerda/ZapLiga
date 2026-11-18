"""Máquina de estados dos jobs de cadastro (contrato, seção 1).

Cada job roda numa thread própria (uiautomator2 é síncrono). Entradas humanas chegam pela
API HTTP e acordam a thread por um Event; o cancelamento usa outro Event, que interrompe
qualquer espera (`JobContext.sleep`). O estado fica só em memória: se o worker reiniciar,
`GET /jobs/{id}` devolve 404 e a API marca `worker_lost` (está no contrato).

Segredos (código SMS, código de pareamento, foto, senha do proxy) só passam pela memória:
não vão para `message`, `history` nem log, e são descartados assim que usados.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from datetime import datetime, timezone
from typing import Any, Callable

from .automation import AutomationFactory, JobContext, JobSpec, PhoneAutomation, ProbeProxySpec
from .egress_probe import ProbeFailed, probe_egress_ip
from .errors import PERMISSION_TODO_MESSAGE, ApiError, JobCancelled, JobError, JobTimedOut
from .geelark_api import GeeLarkError
from .whatsapp import APPS

log = logging.getLogger(__name__)

# probeProxy -> IP público do PC (contrato §4, "IP esperado"); falha = ProbeFailed
EgressProbe = Callable[[ProbeProxySpec], str]
EGRESS_OFFLINE_MESSAGE = "O PC escolhido não está saindo para a internet agora."

TERMINAL = frozenset({"done", "failed", "cancelled"})
MAX_SMS_ATTEMPTS = 5
FINISHED_RETENTION_S = 6 * 3600
MAX_FINISHED_JOBS = 200
# Phone deixado ligado para a API concluir o pareamento: se ela não desligar (fora do ar,
# deploy...), o worker desliga depois disso. O pareamento leva no máximo ~2 min.
HANDOFF_MAX_S = 600

# awaiting -> tipos de JobInput aceitos
ACCEPTED_INPUTS = {
    "sms": {"sms", "resend_sms", "call_me"},
    "profile": {"profile"},
    "link_decision": {"link", "finish"},
    "pair_code": {"pair_code"},
    "manual": {"resume"},
}
AWAITING_LABEL = {
    "sms": "o código SMS",
    "profile": "o nome do perfil",
    "link_decision": "a decisão de conectar ao ZapLiga",
    "pair_code": "o código de pareamento",
    "manual": "você devolver o phone ao robô",
}
# Tela que o robô não conhece: em vez de falhar, ele para e deixa o operador mexer no phone
# pela tela ao vivo. Limite por etapa para não ficar num vai e volta sem fim.
MAX_MANUAL_HELPS = 3
MANUAL_HINT = ('Mexa no phone pela tela ao vivo (clique nela) até passar desta tela e clique em '
               '"Devolver ao robô". Se não der, cancele o cadastro.')


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _step_message(step: str, app_label: str) -> str | None:
    return {
        "queued": "Na fila.",
        "setting_network": "Aplicando a rede (proxy) no phone.",
        "starting_phone": "Ligando o phone.",
        "connecting_adb": "Conectando ao phone por ADB.",
        "checking_network": "Conferindo o IP de saída do phone.",
        "installing_app": f"Instalando o {app_label}.",
        "opening_app": f"Abrindo o {app_label}.",
        "entering_number": "Digitando o número.",
        "waiting_sms": "Digite o código recebido por SMS.",
        "verifying": "Conferindo o código.",
        "waiting_profile": "Informe o nome e a foto do perfil.",
        "saving_profile": "Salvando o perfil.",
        "registered": "Número cadastrado.",
        "opening_link_screen": "Abrindo a tela de conectar aparelho.",
        "waiting_pair_code": "Aguardando o código de pareamento.",
        "entering_pair_code": "Digitando o código de pareamento.",
        "waiting_manual": "O robô parou numa tela que não conhece.",
    }.get(step)


class Job:
    def __init__(self, spec: JobSpec):
        now = _now_iso()
        self.spec = spec
        self.status = "running"
        self.step = "queued"
        self.awaiting: str | None = None
        self.message: str | None = _step_message("queued", "")
        self.error_code: str | None = None
        self.screenshot: bytes | None = None
        self.egress_ip: str | None = None
        self.history: list[dict[str, Any]] = [{"step": "queued", "at": now, "message": self.message}]
        self.created_at = now
        self.updated_at = now
        self.started_mono = time.monotonic()
        self.finished_mono: float | None = None
        # sincronização
        self.cancel_event = threading.Event()
        self.wake = threading.Event()
        self.pending_input: dict[str, Any] | None = None
        self.finished = threading.Event()  # thread terminou (phone desligado e liberado)
        # Automação viva do job (para o print ao vivo); None antes de ligar e depois de terminar.
        self.auto: PhoneAutomation | None = None
        self.screen_lock = threading.Lock()
        self.live_screen: tuple[float, bytes] | None = None

    @property
    def terminal(self) -> bool:
        return self.status in TERMINAL

    def to_dict(self) -> dict[str, Any]:
        return {
            "jobId": self.spec.job_id,
            "phoneId": self.spec.phone_id,
            "mode": self.spec.mode,
            "app": self.spec.app or None,
            "number": self.spec.full_number or None,
            "status": self.status,
            "step": self.step,
            "awaiting": self.awaiting,
            "message": self.message,
            "errorCode": self.error_code,
            "hasScreenshot": self.screenshot is not None,
            "egressIp": self.egress_ip,
            "history": [dict(h) for h in self.history],
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
        }


class JobManager:
    def __init__(
        self,
        factory: AutomationFactory,
        max_jobs: int = 2,
        input_timeout_s: float = 600,
        job_timeout_s: float = 1200,
        debug_dir: str | None = None,
        egress_probe: EgressProbe = probe_egress_ip,
        stop_phone: Callable[[str], None] | None = None,
        handoff_max_s: float = HANDOFF_MAX_S,
    ):
        self._factory = factory
        self._stop_phone = stop_phone
        self.handoff_max_s = handoff_max_s
        self._handed: dict[str, float] = {}         # phoneId -> quando foi entregue à API ligado
        self._egress_probe = egress_probe
        self.max_jobs = max_jobs
        self.input_timeout_s = input_timeout_s
        self.job_timeout_s = job_timeout_s
        self._debug_dir = debug_dir
        self._lock = threading.RLock()
        self._jobs: dict[str, Job] = {}
        self._busy: dict[str, str] = {}             # phoneId -> jobId (até a thread terminar)
        self._apps: dict[str, dict[str, bool]] = {}  # phoneId -> apps vistos no último job

    # ------------------------------------------------------------- consultas
    def get(self, job_id: str) -> Job | None:
        with self._lock:
            return self._jobs.get(job_id)

    def snapshot(self, job: Job) -> dict[str, Any]:
        with self._lock:
            return job.to_dict()

    def busy_job_for(self, phone_id: str) -> str | None:
        with self._lock:
            return self._busy.get(phone_id)

    def known_apps(self, phone_id: str) -> dict[str, bool] | None:
        with self._lock:
            apps = self._apps.get(phone_id)
            return dict(apps) if apps else None

    def active_count(self) -> int:
        with self._lock:
            return len(self._busy)

    # ------------------------------------------------------------- comandos
    def create(self, spec: JobSpec) -> Job:
        with self._lock:
            self._prune()
            if spec.job_id in self._jobs:
                raise ApiError(409, "job_exists", "Já existe um job com esse jobId.")
            if spec.phone_id in self._busy:
                raise ApiError(409, "phone_busy", "Este phone já está em outro cadastro.")
            if len(self._busy) >= self.max_jobs:
                raise ApiError(429, "worker_full", f"O worker já está com {self.max_jobs} cadastros em andamento.")
            job = Job(spec)
            self._jobs[spec.job_id] = job
            self._busy[spec.phone_id] = spec.job_id
            self._handed.pop(spec.phone_id, None)  # um job novo passa a cuidar do phone
        thread = threading.Thread(target=self._run, args=(job,), name=f"job-{spec.job_id[:8]}", daemon=True)
        thread.start()
        log.info("[%s] job criado (phone %s, app %s)", spec.job_id, spec.phone_id, spec.app)
        return job

    def submit_input(self, job_id: str, inp: dict[str, Any]) -> Job:
        with self._lock:
            job = self._require(job_id)
            kind = inp.get("type")
            if job.status != "waiting_input" or kind not in ACCEPTED_INPUTS.get(job.awaiting or "", set()):
                raise ApiError(409, "not_awaiting", f"O job não está esperando '{kind}' agora.")
            job.pending_input = inp
            job.status = "running"
            job.awaiting = None
            job.updated_at = _now_iso()
            job.wake.set()
            log.info("[%s] entrada recebida: %s", job_id, kind)  # nunca o conteúdo
            return job

    def cancel(self, job_id: str) -> Job:
        with self._lock:
            job = self._require(job_id)
            if not job.terminal:
                self._finish_locked(job, "cancelled", "cancelled", "Cadastro cancelado.")
                job.cancel_event.set()
                job.wake.set()
                log.info("[%s] cancelado", job_id)
            return job

    def cancel_phone(self, phone_id: str) -> None:
        job_id = self.busy_job_for(phone_id)
        if job_id:
            self.cancel(job_id)

    def _require(self, job_id: str) -> Job:
        job = self._jobs.get(job_id)
        if job is None:
            raise ApiError(404, "not_found", "Job não encontrado (o worker pode ter reiniciado).")
        return job

    def _prune(self) -> None:
        now = time.monotonic()
        finished = [j for j in self._jobs.values() if j.finished.is_set() and j.finished_mono is not None]
        finished.sort(key=lambda j: j.finished_mono or 0)
        excess = len(finished) - MAX_FINISHED_JOBS
        for i, job in enumerate(finished):
            if i < excess or now - (job.finished_mono or now) > FINISHED_RETENTION_S:
                self._jobs.pop(job.spec.job_id, None)

    # ------------------------------------------------------ tela ao vivo
    def live_screen(self, job_id: str, max_age_s: float = 2.0) -> bytes | None:
        """Print da tela do phone agora (cache curto: a página consulta a cada poucos segundos)."""
        with self._lock:
            job = self._require(job_id)
            auto = job.auto if not job.terminal else None
        if auto is None:
            return None
        with job.screen_lock:
            cached = job.live_screen
            if cached and time.monotonic() - cached[0] < max_age_s:
                return cached[1]
            try:
                png = auto.screenshot()
            except Exception as exc:
                log.info("[%s] sem print ao vivo (%s)", job_id, type(exc).__name__)
                return cached[1] if cached else None
            if png:
                job.live_screen = (time.monotonic(), png)
            return png

    def manual_action(self, job_id: str, action: dict[str, Any]) -> None:
        """Toque, tecla ou texto do operador no phone. Só quando o robô está parado esperando
        alguém (status waiting_input): com o robô andando, os dois brigariam pela tela."""
        with self._lock:
            job = self._require(job_id)
            auto = job.auto if job.status == "waiting_input" else None
        if auto is None:
            raise ApiError(409, "robot_busy",
                           "O robô está mexendo no phone agora. Dá para mexer quando ele parar e pedir algo.")
        with job.screen_lock:
            try:
                auto.manual(action)
            except Exception as exc:
                log.warning("[%s] controle manual falhou (%s)", job_id, type(exc).__name__)
                raise ApiError(502, "device_error", "Não consegui mexer no phone agora. Tente de novo.") from None
            finally:
                job.live_screen = None  # o próximo print já mostra o resultado
        log.info("[%s] controle manual: %s", job_id, action.get("type"))  # nunca o texto digitado

    # ---------------------------------------------------------- vigia
    def sweep_handed(self, now: float | None = None) -> list[str]:
        """Desliga os phones entregues à API ligados há mais de `handoff_max_s`.

        GeeLark cobra por minuto ligado: é a rede de segurança caso a API não desligue
        depois do pareamento. Devolve os phones desligados (ou que tentou desligar).
        """
        now = time.monotonic() if now is None else now
        with self._lock:
            due = [pid for pid, at in self._handed.items()
                   if now - at >= self.handoff_max_s and pid not in self._busy]
            for pid in due:
                self._handed.pop(pid, None)
        for pid in due:
            try:
                if self._stop_phone is not None:
                    self._stop_phone(pid)
                log.info("phone %s desligado pelo vigia (a API não desligou depois do pareamento)", pid)
            except Exception as exc:
                log.warning("vigia: falha ao desligar o phone %s (%s)", pid, type(exc).__name__)
        return due

    def start_watchdog(self, interval_s: float = 60) -> threading.Event:
        """Thread que roda `sweep_handed` a cada `interval_s`; set() no Event para parar."""
        stop = threading.Event()

        def loop() -> None:
            while not stop.wait(interval_s):
                try:
                    self.sweep_handed()
                except Exception:
                    log.exception("vigia de phones falhou")

        threading.Thread(target=loop, name="phone-watchdog", daemon=True).start()
        return stop

    # ------------------------------------------------------- transições
    def _set_step(self, job: Job, step: str, message: str | None = None, *,
                  status: str = "running", awaiting: str | None = None) -> None:
        with self._lock:
            if job.terminal:
                return
            if message is None:
                app = APPS.get(job.spec.app)
                message = _step_message(step, app.label if app else "app")
            job.status = status
            job.step = step
            job.awaiting = awaiting
            job.message = message
            job.updated_at = _now_iso()
            job.history.append({"step": step, "at": job.updated_at, "message": message})
        log.info("[%s] %s/%s", job.spec.job_id, status, step)

    def _finish_locked(self, job: Job, status: str, error_code: str | None, message: str | None,
                       step: str | None = None) -> None:
        if job.terminal:
            return
        job.status = status
        job.error_code = error_code
        job.awaiting = None
        job.message = message
        if step:
            job.step = step
        job.updated_at = _now_iso()
        job.history.append({"step": step or job.step, "at": job.updated_at, "message": message})

    def _finish(self, job: Job, status: str, error_code: str | None, message: str | None,
                step: str | None = None) -> None:
        with self._lock:
            self._finish_locked(job, status, error_code, message, step)

    def _wait_input(self, job: Job, ctx: JobContext, step: str, awaiting: str,
                    message: str | None = None) -> dict[str, Any]:
        with self._lock:
            job.pending_input = None
            job.wake.clear()
        self._set_step(job, step, message, status="waiting_input", awaiting=awaiting)
        input_deadline = time.monotonic() + self.input_timeout_s
        while True:
            ctx.check()
            with self._lock:
                if job.pending_input is not None:
                    inp, job.pending_input = job.pending_input, None
                    return inp
                job.wake.clear()
            remaining = min(input_deadline, ctx.deadline) - time.monotonic()
            if remaining <= 0:
                if time.monotonic() >= ctx.deadline:
                    ctx.check()  # timeout do job inteiro
                minutes = max(1, round(self.input_timeout_s / 60))
                raise JobTimedOut(f"Tempo esgotado esperando {AWAITING_LABEL[awaiting]} ({minutes} min).")
            job.wake.wait(remaining)

    # ----------------------------------------------------------------- fluxo
    def _run(self, job: Job) -> None:
        spec = job.spec
        minutes = max(1, round(self.job_timeout_s / 60))
        ctx = JobContext(job.cancel_event, job.started_mono + self.job_timeout_s,
                         f"O cadastro passou de {minutes} min e foi interrompido.")
        auto: PhoneAutomation | None = None
        outcome: tuple[str, str, str] | None = None  # (status, errorCode, message)
        try:
            auto = self._factory(spec, ctx)
            with self._lock:
                job.auto = auto
            self._flow(job, ctx, auto)
        except JobCancelled:
            outcome = ("cancelled", "cancelled", "Cadastro cancelado.")
        except JobTimedOut as exc:
            outcome = ("failed", "timeout", exc.message)
        except JobError as exc:
            outcome = ("failed", exc.code, exc.message)
        except NotImplementedError:
            outcome = ("failed", "internal", PERMISSION_TODO_MESSAGE)
        except GeeLarkError as exc:
            log.warning("[%s] erro do GeeLark: %s", spec.job_id, exc)
            outcome = ("failed", "internal", f"Erro da API do GeeLark ({exc.code}).")
        except Exception as exc:
            log.exception("[%s] erro inesperado", spec.job_id)
            outcome = ("failed", "internal", f"Erro interno no worker ({type(exc).__name__}).")
        finally:
            self._cleanup(job, auto, outcome)

    def _cleanup(self, job: Job, auto: PhoneAutomation | None,
                 outcome: tuple[str, str, str] | None) -> None:
        spec = job.spec
        with self._lock:
            job.auto = None  # sem print ao vivo de um phone que vai desligar
        try:
            if outcome and outcome[0] == "failed" and auto is not None and not job.terminal:
                self._capture(job, auto, outcome[1])
            if outcome:
                self._finish(job, *outcome)
            # Pareamento por código: o phone principal precisa ficar online até o
            # Waxum confirmar a conexão. Nesse caso quem desliga é a API (contrato §1).
            handed_to_api = job.status == "done" and job.step == "linking"
            if handed_to_api:
                with self._lock:
                    self._handed[spec.phone_id] = time.monotonic()
            if spec.power_off_when_done and not handed_to_api:
                try:
                    if auto is not None:
                        auto.power_off()
                except Exception as exc:
                    log.warning("[%s] falha ao desligar o phone (%s); desligue no GeeLark", spec.job_id, type(exc).__name__)
            if auto is not None:
                try:
                    auto.close()
                except Exception:
                    log.warning("[%s] falha ao fechar a automação", spec.job_id)
        finally:
            with self._lock:
                if not job.terminal:  # não deveria acontecer; garante um estado final
                    self._finish_locked(job, "failed", "internal", "O job terminou sem estado final.")
                job.pending_input = None
                job.finished_mono = time.monotonic()
                if self._busy.get(spec.phone_id) == spec.job_id:
                    del self._busy[spec.phone_id]
                job.finished.set()
            log.info("[%s] finalizado: %s/%s", spec.job_id, job.status, job.error_code)

    def _capture(self, job: Job, auto: PhoneAutomation, error_code: str) -> None:
        try:
            png = auto.screenshot()
            if png:
                with self._lock:
                    job.screenshot = png
        except Exception as exc:
            log.warning("[%s] sem screenshot (%s)", job.spec.job_id, type(exc).__name__)
        if error_code == "unknown_screen":
            self._save_debug_xml(job, auto)

    def _save_debug_xml(self, job: Job, auto: PhoneAutomation) -> None:
        if self._debug_dir:
            try:
                xml = auto.debug_dump()
                if xml:
                    os.makedirs(self._debug_dir, exist_ok=True)
                    path = os.path.join(self._debug_dir, f"{job.spec.job_id}.xml")
                    with open(path, "w", encoding="utf-8") as fh:
                        fh.write(xml)
                    log.warning("[%s] XML da tela desconhecida salvo em %s", job.spec.job_id, path)
            except Exception as exc:
                log.warning("[%s] sem XML de diagnóstico (%s)", job.spec.job_id, type(exc).__name__)

    def _with_help(self, job: Job, ctx: JobContext, auto: PhoneAutomation, step: str,
                   fn: Callable[[], Any]) -> Any:
        """Roda uma etapa do app; numa tela desconhecida, pede ajuda ao operador e tenta de novo."""
        helps = 0
        while True:
            try:
                return fn()
            except JobError as exc:
                if exc.code != "unknown_screen" or helps >= MAX_MANUAL_HELPS:
                    raise
                helps += 1
                self._save_debug_xml(job, auto)  # para ensinar a tela nova ao robô depois
                log.info("[%s] tela desconhecida em %s; esperando o operador (%s)", job.spec.job_id, step, helps)
                self._wait_input(job, ctx, "waiting_manual", "manual", f"{exc.message} {MANUAL_HINT}")
                self._set_step(job, step)

    def _probe_pc_ip(self, job: Job) -> str:
        """IP do PC visto pelo probeProxy; sem resposta = egress_offline (contrato §4)."""
        spec = job.spec
        assert spec.probe_proxy is not None
        try:
            ip = self._egress_probe(spec.probe_proxy)
        except ProbeFailed as exc:
            log.warning("[%s] o PC não respondeu pelo proxy: %s", spec.job_id, exc.reason)
            raise JobError("egress_offline", EGRESS_OFFLINE_MESSAGE) from None
        except Exception as exc:
            log.warning("[%s] falha ao consultar o IP do PC (%s)", spec.job_id, type(exc).__name__)
            raise JobError("egress_offline", EGRESS_OFFLINE_MESSAGE) from None
        log.info("[%s] o PC sai pelo IP %s", spec.job_id, ip)
        return ip

    def _flow(self, job: Job, ctx: JobContext, auto: PhoneAutomation) -> None:
        spec = job.spec

        self._set_step(job, "setting_network")
        expected_ips = spec.expected_egress_ips
        if not expected_ips and spec.probe_proxy is not None:
            # Antes de mexer no phone: o PC está saindo para a internet? Por qual IP?
            expected_ips = (self._probe_pc_ip(job),)
            ctx.check()
        auto.set_network()
        ctx.check()

        self._set_step(job, "starting_phone")
        auto.start_phone()
        ctx.check()

        self._set_step(job, "connecting_adb")
        auto.connect_adb()
        apps = auto.installed_apps()
        with self._lock:
            self._apps[spec.phone_id] = dict(apps)
        ctx.check()

        self._set_step(job, "checking_network")
        ip = auto.egress_ip()
        if not ip:
            raise JobError("no_internet", "O phone está sem internet pelo proxy da máquina escolhida.")
        with self._lock:
            job.egress_ip = ip
        if expected_ips and ip not in expected_ips:
            raise JobError(
                "egress_mismatch",
                f"O phone saiu pelo IP {ip}, que não é o da máquina escolhida "
                f"({', '.join(expected_ips)}). O WhatsApp não foi aberto.",
            )
        ctx.check()

        if spec.mode == "network_check":
            # Só a rede: com o IP conferido, termina aqui e o _cleanup desliga o phone.
            same = ", o mesmo do PC escolhido" if expected_ips else ""
            self._finish(job, "done", None, f"Internet ok: o phone sai pelo IP {ip}{same}.", step="network_ok")
            return

        if not apps.get(spec.app):
            self._set_step(job, "installing_app")
            auto.install_app()
            with self._lock:
                self._apps.setdefault(spec.phone_id, {})[spec.app] = True
            ctx.check()

        self._set_step(job, "opening_app")
        self._with_help(job, ctx, auto, "opening_app", auto.open_app)
        ctx.check()

        self._set_step(job, "entering_number")
        self._with_help(job, ctx, auto, "entering_number", auto.enter_number)

        message = None
        attempts = 0
        while True:
            inp = self._wait_input(job, ctx, "waiting_sms", "sms", message)
            if inp["type"] in ("resend_sms", "call_me"):
                message = auto.request_code("voice" if inp["type"] == "call_me" else "sms")
                continue
            self._set_step(job, "verifying")
            result = auto.submit_sms_code(inp["code"])
            del inp
            if result.accepted:
                break
            attempts += 1
            if attempts >= MAX_SMS_ATTEMPTS:
                raise JobError("sms_rejected", f"O WhatsApp recusou o código {attempts} vezes.")
            message = result.message or "Código incorreto. Confira o SMS e digite de novo."

        inp = self._wait_input(job, ctx, "waiting_profile", "profile")
        self._set_step(job, "saving_profile")
        name, photo, photo_mime = inp["name"], inp.get("photo"), inp.get("photoMime")
        warning = self._with_help(job, ctx, auto, "saving_profile", lambda: auto.save_profile(name, photo, photo_mime))
        del photo
        del inp

        registered_msg = "Número cadastrado." + (f" {warning}" if warning else "")
        inp = self._wait_input(job, ctx, "registered", "link_decision", registered_msg)
        if inp["type"] == "finish":
            self._finish(job, "done", None, "Cadastro concluído (sem conectar ao ZapLiga).", step="done")
            return

        self._set_step(job, "opening_link_screen")
        self._with_help(job, ctx, auto, "opening_link_screen", auto.open_link_screen)

        inp = self._wait_input(job, ctx, "waiting_pair_code", "pair_code")
        self._set_step(job, "entering_pair_code")
        note = auto.enter_pair_code(inp["code"])
        del inp
        # O worker terminou; quem acompanha a sessão até `connected` é a API (step linking).
        self._finish(job, "done", None, note or "Código digitado. Aguardando a conexão no ZapLiga.", step="linking")

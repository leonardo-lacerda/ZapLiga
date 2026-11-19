"""Implementação real de PhoneAutomation: API do GeeLark + adb + uiautomator2.

Adaptado do motor CLI (geelark_api.py / device.py / whatsapp.py): o código SMS e o de
pareamento agora chegam pela API HTTP do worker, e cada espera respeita o cancelamento.

Fatos que este módulo respeita (verificados no projeto):
- ADB do GeeLark só funciona no Android 9 e 11–16; após `adb connect` é obrigatório
  `adb shell glogin <pwd>`, senão o device fica "offline".
- O DNS dentro do phone devolve IPs falsos (192.18.x/192.19.x): conectividade se mede pelo
  `curl` ao api.ipify.org, nunca por ping/DNS.
"""

from __future__ import annotations

import io
import ipaddress
import logging
import random
import re
import time
import uuid
from typing import Any, Callable

from .automation import JobContext, JobSpec, SmsResult
from .errors import PERMISSION_TODO_MESSAGE, JobError
from .geelark_api import (
    PHONE_EXPIRED,
    PHONE_OFF,
    PHONE_STARTED,
    PHONE_STARTING,
    PROXY_CHECK_FAILED,
    GeeLarkAPI,
    GeeLarkError,
)
from . import whatsapp as wa
from .whatsapp import Screen

# Telas que só aparecem depois de o WhatsApp aceitar o código.
AFTER_CODE_SCREENS = frozenset({Screen.PROFILE_NAME, Screen.CHATS, Screen.BUSINESS_CATEGORY,
                                Screen.BUSINESS_WELCOME, Screen.RESTORE_BACKUP, Screen.INITIALIZING})

log = logging.getLogger(__name__)

SUPPORTED_ANDROID = {9, 11, 12, 13, 14, 15, 16}
# Sites que devolvem só o IP; alterna entre eles caso um esteja fora ou bloqueie o IP.
EGRESS_URLS = ("https://api.ipify.org", "https://ifconfig.me/ip", "https://icanhazip.com")
# Os mesmos sites por HTTP simples (host, caminho), para o nc, que não fala HTTPS.
EGRESS_HTTP = (("api.ipify.org", "/"), ("ifconfig.me", "/ip"), ("icanhazip.com", "/"))
# Nem toda imagem de Android do GeeLark tem curl: procura, nesta ordem, o que existir.
IP_TOOL_PROBE = (
    "if which curl >/dev/null 2>&1; then echo curl; "
    "elif which wget >/dev/null 2>&1; then echo wget; "
    "elif which nc >/dev/null 2>&1; then echo nc; "
    "elif toybox 2>/dev/null | grep -qw nc; then echo toybox-nc; "
    "else echo none; fi"
)
NO_IP_TOOL = "este phone não tem curl, wget nem nc para conferir o IP"
EGRESS_ATTEMPTS = 5
EGRESS_RETRY_S = 5


def describe_curl_error(output: str) -> str:
    """Erro do curl em português curto (vai para a mensagem do job e para o log)."""
    text = output.strip()
    if not text:
        return "sem resposta"
    known = (
        (r"\(6\)|resolve host", "não achou o endereço do site (DNS)"),
        (r"\(5\)|resolve proxy", "não achou o endereço do proxy"),
        (r"\(7\)|failed to connect|connection refused", "não conseguiu conectar"),
        (r"\(28\)|timed out", "a conexão demorou demais"),
        (r"\(35\)|\(60\)|ssl|certificate", "erro de segurança (SSL) na conexão"),
        (r"\(56\)|\(52\)|reset|empty reply", "a conexão caiu no meio"),
        (r"\(97\)|proxy", "o proxy recusou a conexão"),
        (r"not found|inaccessible", "o curl não existe neste phone"),
    )
    for pattern, meaning in known:
        if re.search(pattern, text, re.I):
            return f"{meaning} ({text[:120]})"
    return text[:160]


def android_major(system_ver: Any) -> int | None:
    m = re.search(r"\d+", str(system_ver or ""))
    return int(m.group()) if m else None


# Pacotes que podem ficar na frente do WhatsApp durante o cadastro sem ser "o app fechou":
# permissões, seletor de número do Google, instalador e diálogos do sistema.
FOREGROUND_ALLOWED = frozenset({
    "android", "com.android.systemui", "com.google.android.gms",
    "com.android.permissioncontroller", "com.google.android.permissioncontroller",
    "com.android.packageinstaller", "com.google.android.packageinstaller",
})
MAX_RELAUNCHES = 3


class GeeLarkAutomation:
    def __init__(self, api: GeeLarkAPI, spec: JobSpec, ctx: JobContext):
        self.api = api
        self.spec = spec
        self.ctx = ctx
        self.phone_id = spec.phone_id
        # No network_check não há app: o padrão só existe para o objeto ficar completo (nunca é aberto).
        self.app = wa.APPS.get(spec.app) or wa.APPS["whatsapp"]
        self.serial: str | None = None
        self.adb: Any = None   # adbutils.AdbDevice
        self.d: Any = None     # uiautomator2.Device
        self._number_submitted_at = float("-inf")
        self.last_egress_error: str | None = None  # motivo da última falha do egress_ip
        self.egress_tool_missing = False           # sem curl/wget/nc: não dá para conferir o IP
        self._ip_tool_name: str | None = None
        self._reset_done = False  # "apagar o app" do cadastro já feito (não repete ao tentar de novo)

    # ----------------------------------------------------------------- utils
    def _pause(self, lo: float = 1.0, hi: float = 2.5) -> None:
        self.ctx.sleep(random.uniform(lo, hi))

    def _poll(self, fn: Callable[[], Any], timeout: float, interval: float) -> Any:
        deadline = time.monotonic() + timeout
        while True:
            result = fn()
            if result:
                return result
            if time.monotonic() >= deadline:
                return None
            self.ctx.sleep(interval)

    def _shell(self, cmd: list[str], timeout: float = 30) -> str:
        return str(self.adb.shell(cmd, timeout=timeout) or "")

    def _exists(self, selector: dict) -> bool:
        return bool(self.d(**selector).exists)

    def _click(self, *selectors: dict, timeout: float = 5) -> bool:
        self.ctx.check()
        return wa.click_first(self.d, *selectors, timeout=timeout)

    def _handle_permission(self) -> None:
        try:
            wa.handle_permission(self.d)
        except NotImplementedError:
            raise JobError("internal", PERMISSION_TODO_MESSAGE) from None

    # ---------------------------------------------------------------- phone
    def set_network(self) -> None:
        try:
            status = self.api.phone_status(self.phone_id)
            if status == PHONE_EXPIRED:
                raise JobError("phone_start_failed", "O cloud phone expirou; renove no GeeLark.")
            if status in (PHONE_STARTED, PHONE_STARTING):
                log.info("[%s] desligando o phone para trocar o proxy", self.spec.job_id)
                self.api.stop_phone(self.phone_id)
                if not self._poll(lambda: self.api.phone_status(self.phone_id) == PHONE_OFF, 120, 3):
                    raise JobError("phone_start_failed", "O phone não desligou para trocar a rede (proxy).")
        except GeeLarkError as exc:
            raise JobError("phone_start_failed", f"Erro do GeeLark ao consultar/desligar o phone ({exc.code}).") from None

        p = self.spec.proxy
        try:
            self.api.update_proxy(self.phone_id, p.type_id, p.server, p.port, p.username, p.password)
        except GeeLarkError as exc:
            if exc.code == PROXY_CHECK_FAILED:
                raise JobError(
                    "egress_offline",
                    "O GeeLark testou o proxy da máquina escolhida e ele não respondeu. "
                    "Confira se a máquina está ligada e conectada ao Tailscale.",
                ) from None
            raise JobError("internal", f"Erro do GeeLark ao aplicar o proxy ({exc.code}).") from None

    def start_phone(self) -> None:
        try:
            status = self.api.phone_status(self.phone_id)
            if status == PHONE_EXPIRED:
                raise JobError("phone_start_failed", "O cloud phone expirou; renove no GeeLark.")
            if status == PHONE_OFF:
                self.api.start_phone(self.phone_id)
            # Polling a cada 3 s: bem abaixo do limite de 200 req/min.
            ok = self._poll(lambda: self.api.phone_status(self.phone_id) == PHONE_STARTED, 180, 3)
        except GeeLarkError as exc:
            raise JobError("phone_start_failed", f"O GeeLark não ligou o phone ({exc.code}).") from None
        if not ok:
            raise JobError("phone_start_failed", "O phone não ligou em 3 minutos.")
        self.ctx.sleep(5)  # o Android ainda termina o boot depois do status 0

    def connect_adb(self) -> None:
        import adbutils
        import uiautomator2 as u2

        try:
            phone = self.api.get_phone(self.phone_id)
        except GeeLarkError:
            phone = None
        ver = android_major((phone or {}).get("systemVer"))
        if ver is not None and ver not in SUPPORTED_ANDROID:
            raise JobError(
                "adb_failed",
                f"O ADB do GeeLark não funciona no Android {ver} (só 9 e 11 a 16). Use outro phone.",
            )
        try:
            self.api.set_adb(self.phone_id, True)
            self.ctx.sleep(3)
            info = self._poll(lambda: self.api.adb_info(self.phone_id), 60, 3)
        except GeeLarkError as exc:
            raise JobError("adb_failed", f"O GeeLark não liberou o ADB ({exc.code}).") from None
        if not info:
            raise JobError("adb_failed", "O GeeLark não devolveu os dados do ADB em 1 minuto.")

        serial = f"{info['ip']}:{info['port']}"
        self.serial = serial
        try:
            out = adbutils.adb.connect(serial, timeout=15)
            if "connected" not in str(out):
                raise JobError("adb_failed", f"adb connect falhou: {str(out).strip()[:200]}")
            dev = adbutils.adb.device(serial)
            # Autenticação do GeeLark; sem ela o device fica "offline".
            dev.shell(["glogin", info["pwd"]], timeout=20)
            if not self._poll(lambda: _safe_state(dev) == "device", 30, 2):
                raise JobError("adb_failed", "O phone continuou offline no ADB depois do glogin.")
            self.adb = dev
            self.d = u2.connect(serial)
            self.d.info  # força a subida do agente do uiautomator2
        except JobError:
            raise
        except Exception as exc:
            raise JobError("adb_failed", f"Falha ao conectar por ADB ({type(exc).__name__}).") from None
        log.info("[%s] ADB conectado em %s", self.spec.job_id, serial)

    def installed_apps(self) -> dict[str, bool]:
        out = self._shell(["pm", "list", "packages", "com.whatsapp"])
        return {key: wa.parse_installed(out, app) for key, app in wa.APPS.items()}

    def _ip_tool(self) -> str:
        if self._ip_tool_name is None:
            out = self._shell(["sh", "-c", IP_TOOL_PROBE], timeout=15).strip()
            name = out.splitlines()[-1].strip() if out else "none"
            self._ip_tool_name = name if name in ("curl", "wget", "nc", "toybox-nc") else "none"
            log.info("[%s] ferramenta para conferir o IP: %s", self.spec.job_id, self._ip_tool_name)
        return self._ip_tool_name

    def _ip_command(self, tool: str, attempt: int) -> list[str]:
        if tool == "curl":
            # -sS: sem barra de progresso, mas com a mensagem de erro (ex.: "Failed to connect").
            return ["curl", "-sS", "-m", "10", EGRESS_URLS[attempt % len(EGRESS_URLS)]]
        host, path = EGRESS_HTTP[attempt % len(EGRESS_HTTP)]
        if tool == "wget":
            return ["wget", "-q", "-T", "10", "-O", "-", f"http://{host}{path}"]
        nc = "toybox nc" if tool == "toybox-nc" else "nc"
        # HTTP/1.0 à mão: o servidor fecha a conexão no fim e o corpo (o IP) é a última linha.
        request = f"GET {path} HTTP/1.0\\r\\nHost: {host}\\r\\nUser-Agent: curl/8\\r\\nConnection: close\\r\\n\\r\\n"
        return ["sh", "-c", f"printf '{request}' | {nc} -w 10 {host} 80"]

    def egress_ip(self) -> str | None:
        self.last_egress_error = None
        self.egress_tool_missing = False
        tool = self._ip_tool()
        if tool == "none":
            self.egress_tool_missing = True
            self.last_egress_error = NO_IP_TOOL
            return None
        # Logo depois de ligar, a rede do phone pode demorar alguns segundos para subir.
        for attempt in range(EGRESS_ATTEMPTS):
            cmd = self._ip_command(tool, attempt)
            out = self._shell(cmd, timeout=20).strip()
            last_line = out.splitlines()[-1].strip() if out else ""
            try:
                return str(ipaddress.ip_address(last_line))
            except ValueError:
                self.last_egress_error = describe_curl_error(last_line)
                log.info("[%s] %s sem IP (tentativa %s): %s", self.spec.job_id, tool, attempt + 1, self.last_egress_error)
            if attempt + 1 < EGRESS_ATTEMPTS:
                self.ctx.sleep(EGRESS_RETRY_S)
        return None

    def install_app(self) -> None:
        try:
            candidates = [
                item for item in self.api.installable_apps(self.phone_id, "whatsapp")
                if item.get("packageName") == self.app.package
            ]
            versions = [v for item in candidates for v in item.get("appVersionInfoList") or []]
            if not versions:
                raise JobError("install_failed", f"O {self.app.label} não está na loja de apps do GeeLark.")
            latest = max(versions, key=lambda v: int(v.get("versionCode") or 0))
            log.info("[%s] instalando %s %s", self.spec.job_id, self.app.label, latest.get("versionName"))
            self.api.install_app(self.phone_id, latest["id"])
        except GeeLarkError as exc:
            raise JobError("install_failed", f"O GeeLark recusou a instalação ({exc.code}).") from None
        if not self._poll(lambda: self.installed_apps()[self.app.key], 300, 5):
            raise JobError("install_failed", f"O {self.app.label} não apareceu instalado em 5 minutos.")

    # -------------------------------------------------------------- screens
    def _common_actions(self) -> dict[Screen, Callable[[], None]]:
        w = self.app.wid
        return {
            Screen.BANNED: lambda: self._fail_with_text("number_banned", wa.BANNED_TEXT, "O WhatsApp bloqueou este número."),
            Screen.UNDER_REVIEW: lambda: self._fail_with_text(
                "number_banned", wa.UNDER_REVIEW_TEXT, "O WhatsApp colocou esta conta em análise."),
            # Não é o código errado: é o WhatsApp pedindo um tempo. O operador decide se espera.
            Screen.WAIT_LIMIT: lambda: self._fail_with_text(
                "wait_limit", wa.WAIT_LIMIT_TEXT, "O WhatsApp pediu para esperar antes de tentar de novo."),
            Screen.NO_INTERNET: lambda: self._fail_with_text(
                "no_internet", wa.NO_INTERNET_TEXT, "O WhatsApp não conseguiu se conectar (sem internet pelo proxy)."),
            Screen.PERMISSION: self._handle_permission,
            Screen.PHONE_HINT: self._dismiss_phone_hint,
            Screen.EULA: lambda: self._click({"resourceId": w + "eula_accept"}, {"textMatches": wa.EULA_TEXT}),
            Screen.USE_OTHER_NUMBER: lambda: self._click({"textMatches": wa.OTHER_NUMBER_TEXT}),
            Screen.RESTORE_BACKUP: self._skip_restore,
            Screen.TWO_STEP_PIN: self._ask_two_step_pin,
            Screen.BUSINESS_WELCOME: lambda: self._click({"textMatches": wa.GET_STARTED_TEXT}),
            Screen.OPTIONAL_PROMPT: lambda: self._click({"textMatches": wa.SKIP_TEXT}),
        }

    def _type(self, text: str, clear: bool = False) -> None:
        """Digita pelo teclado do uiautomator2 e volta o teclado normal do phone.

        O send_keys troca o teclado padrão para o AdbKeyboard (barra "Clear Text / Done /
        Switch IME") e o deixa assim: um rastro de automação que o WhatsApp consegue ler."""
        before = ""
        try:
            before = self.d.current_ime()
        except Exception:
            pass
        try:
            self.d.send_keys(text, clear=clear)
        finally:
            self._restore_ime(before)

    def _restore_ime(self, before: str) -> None:
        adb_ime = "com.github.uiautomator/.AdbKeyboard"
        try:
            if before and before != adb_ime:
                self._shell(["ime", "set", before], timeout=10)
            self._shell(["ime", "disable", adb_ime], timeout=10)
        except Exception as exc:
            log.warning("[%s] não consegui voltar o teclado do phone (%s)", self.spec.job_id, type(exc).__name__)

    def _fail_with_text(self, code: str, pattern: str, default: str) -> None:
        text = wa.first_text(self.d, {"textMatches": pattern})
        raise JobError(code, f"{default} Tela: \"{text[:200]}\"" if text else default)

    def _dismiss_phone_hint(self) -> None:
        # Nunca escolher o número sugerido (SIM falso do cloud phone).
        if not self._click({"textMatches": wa.NONE_OF_ABOVE_TEXT}, {"descriptionMatches": wa.CLOSE_DESC}, timeout=2):
            self.d.press("back")

    def _skip_restore(self) -> None:
        # "Cancelar" no diálogo que pede os contatos; "Pular" na tela de restaurar.
        self._click({"textMatches": wa.RESTORE_SKIP_TEXT}, {"resourceId": "android:id/button2"})
        self._click({"textMatches": wa.RESTORE_SKIP_TEXT}, timeout=3)  # diálogo de confirmação

    def _ask_two_step_pin(self) -> None:
        raise JobError("unknown_screen", "O WhatsApp pede o PIN da verificação em duas etapas deste número. "
                                         "Digite o PIN pela tela ao vivo (só o dono do número sabe).")

    def _drive(
        self,
        targets: set[Screen],
        actions: dict[Screen, Callable[[], None]] | None = None,
        what: str = "",
        timeout: float = 180,
        unknown_grace: float = 20,
    ) -> Screen:
        """Detecta a tela em loop e age até chegar em uma das `targets`."""
        handlers = {**self._common_actions(), **(actions or {})}
        deadline = time.monotonic() + timeout
        last, repeats, unknown_since, relaunches = None, 0, None, 0
        while True:
            self.ctx.check()
            self.ctx.check_takeover()
            screen = wa.detect_screen(self.d, self.app)
            if screen in targets:
                return screen
            now = time.monotonic()
            if now >= deadline:
                raise JobError("unknown_screen", f"O fluxo não chegou em '{what}' a tempo (última tela: {screen.value}).")

            # O app não está na frente (tela inicial do Android): abriu e fechou, ou nem abriu
            # (comum logo depois de instalar). Abre de novo em vez de esperar a tela certa.
            if screen == Screen.UNKNOWN and self._app_left():
                relaunches += 1
                if relaunches > MAX_RELAUNCHES:
                    raise JobError("unknown_screen", f"O {self.app.label} não fica aberto (fechou {MAX_RELAUNCHES} vezes).")
                log.info("[%s] %s não está na frente; abrindo de novo (%s)", self.spec.job_id, self.app.label, relaunches)
                self.d.app_start(self.app.package, wait=True)
                self._pause(2, 4)
                unknown_since = None
                continue

            if screen in (Screen.UNKNOWN, Screen.INITIALIZING):
                # Às vezes é só uma transição: espera um pouco antes de desistir.
                unknown_since = unknown_since or now
                grace = unknown_grace if screen == Screen.UNKNOWN else max(unknown_grace, 90)
                if now - unknown_since > grace:
                    raise JobError("unknown_screen", f"Tela desconhecida enquanto esperava '{what}'.")
                self.ctx.sleep(2)
                continue
            unknown_since = None

            repeats = repeats + 1 if screen == last else 0
            last = screen
            if repeats >= 4:
                raise JobError("unknown_screen", f"A tela '{screen.value}' não avançou.")
            handler = handlers.get(screen)
            if handler is None:
                raise JobError("unknown_screen", f"Tela inesperada '{screen.value}' enquanto esperava '{what}'.")
            log.info("[%s] tela: %s", self.spec.job_id, screen.value)
            handler()
            self._pause(1.5, 3)

    def _app_left(self) -> bool:
        """True quando outro app (não um diálogo do sistema) está na frente do WhatsApp."""
        try:
            package = str((self.d.app_current() or {}).get("package") or "")
        except Exception:
            return False
        return bool(package) and package != self.app.package and package not in FOREGROUND_ALLOWED

    # ------------------------------------------------------------- registro
    def _clear_app(self, why: str) -> None:
        """Apaga os dados do app (como reinstalar do zero): termos, permissões e número de novo."""
        out = self._shell(["pm", "clear", self.app.package], timeout=60).strip()
        if "success" not in out.lower():
            raise JobError("internal", f"Não consegui limpar o {self.app.label} ({out[:80] or 'sem resposta'}).")
        log.info("[%s] dados do %s apagados (%s)", self.spec.job_id, self.app.label, why)

    def open_app(self) -> None:
        self.ctx.check()
        # Tentar de novo depois da ajuda do operador não apaga o que ele já fez.
        if self.spec.reset_app and not self._reset_done:
            self._clear_app("pedido no cadastro")
            self._reset_done = True
        self.d.app_start(self.app.package, wait=True)
        self._pause(2, 4)
        cleared = self.spec.reset_app

        def already_registered() -> None:
            raise JobError(
                "unknown_screen",
                f"O {self.app.label} já tem uma conta ativa neste phone. Para cadastrar outro número aqui, "
                "marque \"Apagar o WhatsApp que já está neste telefone\" e tente de novo.",
            )

        def mid_registration() -> None:
            # Cadastro anterior pela metade (outro número esperando código): não há conta a perder.
            nonlocal cleared
            if cleared:
                raise JobError("unknown_screen", f"O {self.app.label} voltou para um cadastro antigo mesmo depois de limpo.")
            self._clear_app("cadastro anterior pela metade")
            cleared = True
            self.d.app_start(self.app.package, wait=True)
            self._pause(2, 4)

        def dead_account() -> None:
            # Conta antiga banida ou em análise: é de outro número e não serve mais neste phone.
            # Sem apagar, o WhatsApp nunca mostra a tela de digitar o número novo.
            nonlocal cleared
            if cleared:
                raise JobError("number_banned", f"O {self.app.label} continua bloqueado neste phone mesmo depois de apagado.")
            self._clear_app("conta antiga banida ou em análise")
            cleared = True
            self.d.app_start(self.app.package, wait=True)
            self._pause(2, 4)

        half_done = (Screen.VERIFY_CODE, Screen.CONFIRM_NUMBER, Screen.VERIFY_METHOD, Screen.MISSED_CALL_INTRO)
        self._drive({Screen.PHONE_ENTRY}, {Screen.CHATS: already_registered, Screen.BANNED: dead_account,
                                           Screen.UNDER_REVIEW: dead_account,
                                           **{s: mid_registration for s in half_done}},
                    what="digitar número")

    def _fill_number(self) -> None:
        w = self.app.wid
        if time.monotonic() - self._number_submitted_at < 8:
            return  # acabou de enviar: dá tempo para o diálogo de confirmação aparecer
        cc = self.d(resourceId=w + "registration_cc")
        if cc.exists:
            cc.set_text(self.spec.country_code)
            self._pause(0.5, 1.2)
        self.d(resourceId=w + "registration_phone").set_text(self.spec.number)
        self._pause()
        # Tocar no campo pode abrir o seletor de número do Google; o _drive fecha e volta aqui.
        if wa.detect_screen(self.d, self.app) == Screen.PHONE_ENTRY:
            if self._click({"resourceId": w + "registration_submit"}, {"textMatches": wa.NEXT_TEXT}):
                self._number_submitted_at = time.monotonic()

    def _choose_verify_method(self) -> None:
        # SMS tem preferência; número fixo no Business só recebe por ligação.
        self._click({"textMatches": wa.SMS_METHOD_TEXT}, {"textMatches": wa.CALL_METHOD_TEXT})
        self._click({"textMatches": wa.CONFIRM_TEXT}, timeout=3)

    def enter_number(self) -> None:
        actions = {
            Screen.PHONE_ENTRY: self._fill_number,
            Screen.CONFIRM_NUMBER: lambda: self._click({"resourceId": "android:id/button1"}, {"textMatches": wa.CONFIRM_TEXT}),
            Screen.VERIFY_METHOD: self._choose_verify_method,
            # Nunca "Continuar" aqui: daria permissão de ligações para uma verificação que não tem como passar.
            Screen.MISSED_CALL_INTRO: lambda: self._click({"textMatches": wa.OTHER_VERIFY_TEXT}),
        }
        # Nunca pede um novo código sozinho: pedir repetidamente trava o número por horas.
        self._drive({Screen.VERIFY_CODE}, actions, what="digitar código", timeout=240, unknown_grace=45)

    def submit_sms_code(self, code: str) -> SmsResult:
        w = self.app.wid
        self._drive({Screen.VERIFY_CODE}, what="digitar código", timeout=30)
        field = self.d(resourceId=w + "verify_sms_code_input")
        if not field.exists:
            field = self.d(resourceId=w + "code_input")
        field.click()
        self._pause(0.3, 0.8)
        self._type(code, clear=True)  # o WhatsApp valida sozinho ao completar 6 dígitos

        deadline = time.monotonic() + 45
        handlers = self._common_actions()
        while time.monotonic() < deadline:
            self.ctx.sleep(3)
            self.ctx.check_takeover()
            if self._exists({"textMatches": wa.WRONG_CODE_TEXT}):
                return SmsResult(False, "Código incorreto. Confira o SMS e digite de novo.")
            screen = wa.detect_screen(self.d, self.app)
            if screen in (Screen.PROFILE_NAME, Screen.CHATS, Screen.BUSINESS_CATEGORY):
                return SmsResult(True)
            if screen in (Screen.VERIFY_CODE, Screen.UNKNOWN, Screen.INITIALIZING):
                continue  # ainda verificando
            handler = handlers.get(screen)
            if handler is None:
                raise JobError("unknown_screen", f"Tela inesperada '{screen.value}' depois do código SMS.")
            handler()
        if wa.detect_screen(self.d, self.app) == Screen.VERIFY_CODE:
            return SmsResult(False, "O WhatsApp não aceitou o código. Confira o SMS e digite de novo.")
        raise JobError("unknown_screen", "O WhatsApp não saiu da verificação do código.")

    def past_verification(self) -> bool:
        return wa.detect_screen(self.d, self.app) in AFTER_CODE_SCREENS

    def finish_verification(self) -> None:
        self._drive({Screen.PROFILE_NAME, Screen.CHATS, Screen.BUSINESS_CATEGORY},
                    what="perfil (depois do código)", timeout=120, unknown_grace=30)

    def request_code(self, method: str) -> str:
        label = "uma ligação com o código" if method == "voice" else "um novo SMS"
        pattern = wa.CALL_ME_TEXT if method == "voice" else wa.RESEND_SMS_TEXT
        target = self.d(textMatches=pattern)
        if not target.exists and self._click({"textMatches": wa.DIDNT_RECEIVE_TEXT}, timeout=2):
            self._pause(1, 2)  # abre as opções de reenvio
            target = self.d(textMatches=pattern)
        if not target.exists:
            return (f"O WhatsApp não mostrou a opção de pedir {label} agora. "
                    "Veja a tela do phone: pode haver um relógio contando ou o código foi para outro aparelho.")
        text = (target.get_text() or "").strip()
        if wa.COUNTDOWN.search(text) or not target.info.get("enabled", True):
            return f"Ainda não dá para pedir {label}: o WhatsApp mostra \"{text}\". Tente quando o relógio zerar."
        target.click()
        self._pause(1, 2)
        # Algumas versões confirmam o pedido numa janela ("OK" / "Ligar").
        self._click({"resourceId": "android:id/button1"}, {"textMatches": wa.CONFIRM_TEXT}, timeout=2)
        log.info("[%s] código pedido de novo (%s) a pedido do usuário", self.spec.job_id, method)
        return f"Pedimos {label}. Aguarde e digite o código quando chegar."

    def _choose_category(self) -> None:
        pattern = wa.CATEGORY_OTHER
        if not self._exists({"textMatches": pattern}) and self._exists({"scrollable": True}):
            self.d(scrollable=True).scroll.to(textMatches=pattern)
        if not self._click({"textMatches": pattern}, timeout=3):
            raise JobError("unknown_screen", "O WhatsApp Business pediu a categoria e não encontrei a opção 'Outros'.")
        self._pause()
        self._click({"textMatches": wa.NEXT_TEXT}, timeout=3)

    def _fill_business_category(self) -> None:
        """No perfil comercial a categoria pode ser um campo da mesma tela: abre a lista e escolhe "Outros"."""
        w = self.app.wid
        field = ({"resourceIdMatches": re.escape(w) + r".*categor.*"}, {"textMatches": wa.CATEGORY_FIELD_TEXT})
        if not any(self._exists(sel) for sel in field):
            return
        self._click(*field, timeout=3)
        self._pause(1.5, 2.5)
        if wa.detect_screen(self.d, self.app) == Screen.BUSINESS_CATEGORY or self._exists({"textMatches": wa.CATEGORY_OTHER}):
            self._choose_category()
            self._pause()

    def save_profile(self, name: str, photo: bytes | None, photo_mime: str | None) -> str | None:
        w = self.app.wid
        screen = self._drive({Screen.PROFILE_NAME, Screen.CHATS},
                             {Screen.BUSINESS_CATEGORY: self._choose_category},
                             what="perfil", timeout=120, unknown_grace=60)
        if screen == Screen.CHATS:
            return "O WhatsApp não mostrou a tela de perfil; nome e foto não foram aplicados."

        warning = None
        if photo:
            try:
                self._set_photo(photo, photo_mime)
            except JobError as exc:
                warning = f"A foto não foi aplicada ({exc.message})."
            except Exception as exc:  # melhor esforço: segue só com o nome
                log.warning("[%s] foto falhou: %s", self.spec.job_id, type(exc).__name__)
                warning = "A foto não foi aplicada (falha ao escolher a imagem no phone)."

        name_field = self.d(resourceId=w + "registration_name")
        if not name_field.exists:
            name_field = self.d(resourceId=w + "business_name")
        if not name_field.exists:
            name_field = self.d(**wa.EDIT_TEXT)
        if not name_field.exists:
            raise JobError("unknown_screen", "Não encontrei o campo de nome na tela de perfil.")
        name_field.set_text(name)
        self._pause()
        if self.app.is_business:
            self._fill_business_category()

        def accept() -> None:
            self._click({"resourceId": w + "register_name_accept"}, {"textMatches": wa.NEXT_TEXT})

        accept()
        self._pause(2, 3)
        self._drive({Screen.CHATS},
                    {Screen.PROFILE_NAME: accept, Screen.BUSINESS_CATEGORY: self._choose_category},
                    what="lista de conversas", timeout=240, unknown_grace=60)
        return warning

    def _set_photo(self, photo: bytes, mime: str | None) -> None:
        """Melhor esforço (não verificado em aparelho): push + media scan + escolher pela galeria do app."""
        w = self.app.wid
        ext = "png" if mime == "image/png" else "jpg"
        remote = f"/sdcard/Pictures/zapliga_{uuid.uuid4().hex[:12]}.{ext}"
        try:
            self.adb.sync.push(io.BytesIO(photo), remote, mode=0o644)
            self._media_scan(remote)
            self.ctx.sleep(2)
            if not self._click(
                {"resourceIdMatches": wa._app_ids(self.app, "registration_photo", "change_photo_btn", "photo_btn", "profile_photo", "change_photo")},
                {"descriptionMatches": r"(?i).*(add (a )?photo|adicionar (uma )?foto|profile photo|foto do perfil|change photo|alterar foto).*"},
                timeout=4,
            ):
                raise JobError("internal", "botão da foto não encontrado")
            self._pause()
            self._click({"textMatches": wa.GALLERY_TEXT}, {"descriptionMatches": wa.GALLERY_TEXT}, timeout=4)
            self._pause(2, 3)
            self._click({"textMatches": wa.PICTURES_FOLDER_TEXT}, timeout=3)
            self._pause()
            if not self._click(
                {"resourceIdMatches": r".*:id/(thumb|thumbnail|image|photo|media_item|grid_item|icon_thumb).*", "clickable": True},
                {"className": "android.widget.ImageView", "clickable": True},
                timeout=4,
            ):
                raise JobError("internal", "a imagem não apareceu na galeria")
            self._pause(2, 3)
            self._click({"resourceId": w + "ok_btn"}, {"textMatches": wa.CROP_DONE_TEXT},
                        {"descriptionMatches": wa.CROP_DONE_TEXT}, timeout=5)
            self._pause(2, 3)
        finally:
            # Volta para a tela de perfil se algo ficou aberto, e apaga a foto do phone.
            for _ in range(4):
                if wa.detect_screen(self.d, self.app) == Screen.PROFILE_NAME:
                    break
                self.d.press("back")
                self.ctx.sleep(1)
            try:
                self._shell(["rm", "-f", remote])
                self._media_scan(remote)
            except Exception:
                log.warning("[%s] não consegui apagar a foto do phone", self.spec.job_id)
        if wa.detect_screen(self.d, self.app) != Screen.PROFILE_NAME:
            raise JobError("internal", "não voltou para a tela de perfil")

    def _media_scan(self, remote: str) -> None:
        # Android ≤ 10 usa o broadcast; Android 11+ aceita o scan pelo MediaProvider.
        self._shell(["am", "broadcast", "-a", "android.intent.action.MEDIA_SCANNER_SCAN_FILE", "-d", f"file://{remote}"])
        self._shell(["content", "call", "--uri", "content://media", "--method", "scan_volume", "--arg", "external_primary"])

    # ------------------------------------------------------------ pareamento
    def open_link_screen(self) -> None:
        if wa.detect_screen(self.d, self.app) != Screen.CHATS:
            self.d.app_start(self.app.package, wait=True)
            self._pause(2, 3)
            self._drive({Screen.CHATS}, what="lista de conversas", timeout=60)

        def step(what: str, *selectors: dict, timeout: float = 10) -> None:
            if not self._click(*selectors, timeout=timeout):
                raise JobError("pair_failed", f"Não encontrei '{what}' no WhatsApp.")
            self._pause()

        step("⋮ (mais opções)", wa.MORE_OPTIONS)
        step("Aparelhos conectados", wa.LINKED_DEVICES)
        step("Conectar um aparelho", wa.LINK_A_DEVICE, timeout=15)

        deadline = time.monotonic() + 30
        while True:
            self.ctx.check()
            if self._exists(wa.LINK_WITH_NUMBER):
                self._click(wa.LINK_WITH_NUMBER)
                break
            if wa.detect_screen(self.d, self.app) == Screen.PERMISSION:  # câmera do leitor de QR
                self._handle_permission()
            elif self._exists({"textMatches": wa.DISMISS_OK_TEXT}):
                self._click({"textMatches": wa.DISMISS_OK_TEXT}, timeout=1)
            if time.monotonic() >= deadline:
                raise JobError("pair_failed", "Não encontrei 'Conectar com número de telefone' no leitor de QR.")
            self.ctx.sleep(2)

        if not self._poll(lambda: self._exists(wa.EDIT_TEXT) or self._exists(wa.PAIR_CODE_HINT), 20, 1):
            raise JobError("pair_failed", "A tela para digitar o código de pareamento não abriu.")

    def enter_pair_code(self, code: str) -> str | None:
        field = self.d(**wa.EDIT_TEXT)
        if field.exists:
            field.click()
            self.ctx.sleep(0.3)
        self._type(code, clear=True)

        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            self.ctx.sleep(2)
            if self._exists({"textMatches": wa.PAIR_ERROR_TEXT}):
                text = wa.first_text(self.d, {"textMatches": wa.PAIR_ERROR_TEXT}) or ""
                raise JobError("pair_failed", f"O WhatsApp recusou o código de pareamento. {text[:200]}".strip())
            if self._exists(wa.LINKED_DEVICES) and not self._exists(wa.EDIT_TEXT):
                return "Código aceito pelo WhatsApp. Aguardando a conexão no ZapLiga."
        return "Código digitado; o phone não confirmou na tela. Aguardando a conexão no ZapLiga."

    # --------------------------------------------------------------- limpeza
    def manual(self, action: dict[str, Any]) -> None:
        kind = action.get("type")
        if kind == "tap":
            # O print aparece reduzido na página: ela manda a posição em proporção (0 a 1).
            width, height = self.d.window_size()
            self.d.click(int(action["x"] * (width - 1)), int(action["y"] * (height - 1)))
        elif kind == "key" and action.get("key") in ("back", "home"):
            self.d.press(action["key"])
        elif kind == "key" and action.get("key") in ("scroll_up", "scroll_down"):
            width, height = self.d.window_size()
            top, bottom = int(height * 0.3), int(height * 0.7)
            # Ver o que está mais abaixo = arrastar o dedo de baixo para cima.
            start, end = (bottom, top) if action["key"] == "scroll_down" else (top, bottom)
            self.d.swipe(width // 2, start, width // 2, end, duration=0.25)
        elif kind == "text":
            self._type(action["text"])
        else:
            raise JobError("invalid_action", "Ação manual desconhecida.")
        time.sleep(random.uniform(0.6, 1.2))  # deixa a tela reagir antes do próximo print

    def screenshot(self) -> bytes | None:
        if self.d is None:
            return None
        img = self.d.screenshot()
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return buf.getvalue()

    def debug_dump(self) -> str | None:
        if self.d is None:
            return None
        return wa.scrub_hierarchy(self.d.dump_hierarchy())

    def power_off(self) -> None:
        self.api.stop_phone(self.phone_id)

    def close(self) -> None:
        if self.serial:
            try:
                import adbutils
                adbutils.adb.disconnect(self.serial)
            except Exception:
                pass
        self.d = None
        self.adb = None


def _safe_state(dev: Any) -> str | None:
    try:
        return dev.get_state()
    except Exception:
        return None


def make_factory(api: GeeLarkAPI):
    def factory(spec: JobSpec, ctx: JobContext) -> GeeLarkAutomation:
        return GeeLarkAutomation(api, spec, ctx)
    return factory

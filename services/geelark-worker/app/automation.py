"""Interface entre a máquina de estados (jobs.py) e o que mexe no phone.

A máquina de estados só conhece `PhoneAutomation`. A implementação real
(`device_automation.GeeLarkAutomation`) usa a API do GeeLark + adb + uiautomator2; os testes
usam uma implementação falsa, sem aparelho.

Regras para quem implementa:
- Falhas esperadas viram `JobError(errorCode, mensagem em português)`.
- Toda espera passa por `ctx.sleep()` / `ctx.check()`: é assim que o cancelamento e o
  teto do job (20 min sem atividade, 45 min no total) interrompem o trabalho.
- Nunca logar o código SMS, o código de pareamento nem a senha do proxy.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Protocol

from .errors import JobCancelled, JobError, JobTimedOut


@dataclass(frozen=True)
class ProxySpec:
    type_id: int
    server: str
    port: int
    username: str = field(repr=False)
    password: str = field(repr=False)


@dataclass(frozen=True)
class ProbeProxySpec:
    """Endereço interno do mesmo proxy (socks-gateway), para o worker descobrir o IP do PC."""
    server: str
    port: int
    username: str = field(default="", repr=False)
    password: str = field(default="", repr=False)


@dataclass(frozen=True)
class JobSpec:
    job_id: str
    phone_id: str
    app: str                 # "whatsapp" | "business" ("" no network_check)
    country_code: str
    number: str
    proxy: ProxySpec = field(repr=False)
    expected_egress_ips: tuple[str, ...] = ()
    # (IP, motivo): o cadastro não sai por estes IPs (limite por dia, quarentena depois de banimento).
    blocked_egress_ips: tuple[tuple[str, str], ...] = ()
    power_off_when_done: bool = True
    probe_proxy: ProbeProxySpec | None = field(default=None, repr=False)
    # "register" = cadastro completo; "network_check" = só aplica a rede, liga e confere o IP.
    mode: str = "register"
    # Apaga os dados do app antes de abrir, mesmo com uma conta ativa nele (escolha do usuário).
    reset_app: bool = False
    # Cadastro retomado depois de o worker reiniciar: o phone segue ligado e o WhatsApp parado
    # numa etapa; o fluxo olha a tela e continua dali, sem pedir código de novo.
    resume: bool = False
    # Como pedir o código: "auto" (linha fixa do Brasil -> ligação de voz; resto -> SMS), "sms" ou "voice".
    verification: str = "auto"

    @property
    def full_number(self) -> str:
        return self.country_code + self.number


@dataclass(frozen=True)
class SmsResult:
    accepted: bool
    message: str | None = None   # motivo, quando recusado


class JobContext:
    """Cancelamento e prazo do job, compartilhados com a automação."""

    def __init__(self, cancel_event: threading.Event, deadline: float, timeout_message: str,
                 takeover: threading.Event | None = None, note: Callable[[str], None] | None = None,
                 hard_deadline: float | None = None, hard_message: str | None = None):
        self._cancel = cancel_event
        self._takeover = takeover
        self._note = note
        # `deadline` anda para frente a cada atividade (`extend`), até `hard_deadline`.
        self.hard_deadline = max(deadline, hard_deadline if hard_deadline is not None else deadline)
        self.deadline = deadline
        self._timeout_message = timeout_message
        self._hard_message = hard_message or timeout_message

    def extend(self, seconds: float) -> None:
        """Houve atividade (passo novo, entrada ou toque do operador): o prazo recomeça,
        sem passar do teto absoluto."""
        self.deadline = max(self.deadline, min(time.monotonic() + seconds, self.hard_deadline))

    @property
    def cancelled(self) -> bool:
        return self._cancel.is_set()

    def remaining(self) -> float:
        return self.deadline - time.monotonic()

    def check(self) -> None:
        if self._cancel.is_set():
            raise JobCancelled()
        if time.monotonic() >= self.deadline:
            raise JobTimedOut(self._hard_message if self.deadline >= self.hard_deadline else self._timeout_message)

    def check_takeover(self) -> None:
        """O operador clicou em "Assumir o controle": para a etapa (só entre uma tela e outra)."""
        if self._takeover is not None and self._takeover.is_set():
            raise JobError("manual_takeover", "Você assumiu o controle do phone.")

    def note(self, message: str) -> None:
        """Mensagem para o operador sem mudar a etapa (ex.: a IA está numa tela nova)."""
        if self._note is not None:
            self._note(message)

    def sleep(self, seconds: float) -> None:
        """Dorme até `seconds`, acordando na hora se o job for cancelado ou estourar o prazo."""
        self.check()
        self._cancel.wait(max(0.0, min(seconds, self.remaining())))
        self.check()


class PhoneAutomation(Protocol):
    def set_network(self) -> None:
        """Desliga o phone se preciso e aplica o proxy do job (step setting_network)."""

    def start_phone(self) -> None:
        """Liga e espera status 0 (step starting_phone)."""

    def connect_adb(self) -> None:
        """adb/setStatus + adb/getData + adb connect + glogin + uiautomator2 (connecting_adb)."""

    def installed_apps(self) -> dict[str, bool]:
        """{"whatsapp": bool, "business": bool} visto pelo `pm list packages`."""

    def egress_ip(self) -> str | None:
        """IP público visto de dentro do phone (curl), ou None sem internet."""

    def install_app(self) -> None: ...

    def open_app(self) -> None:
        """Abre o app e passa as telas iniciais até a entrada do número."""

    def enter_number(self) -> None:
        """Digita país + número e confirma, até a tela do código."""

    def submit_sms_code(self, code: str) -> SmsResult:
        """Digita o código. Aceito = chegou na tela de perfil (ou depois)."""

    # "sms" ou "voice": por onde o código vai chegar (a mensagem de `waiting_sms` muda).
    code_channel: str

    def finish_verification(self) -> None:
        """Depois do código (e da ajuda do operador): passa as telas até o perfil."""

    def past_verification(self) -> bool:
        """A tela atual já é de depois do código (o operador verificou na mão)?"""

    def resume_point(self) -> str:
        """Cadastro retomado: onde o WhatsApp está. "code" (esperando o código deste número),
        "profile" (código já aceito), "chats" (cadastro pronto) ou "restart" (começa do zero)."""

    def request_code(self, method: str) -> str:
        """Na tela do código, pede outro por "sms" ou "voice" (ligação). Só a pedido do usuário:
        pedir sozinho e repetidamente trava o número. Retorna a mensagem para `message`."""

    def save_profile(self, name: str, photo: bytes | None, photo_mime: str | None) -> str | None:
        """Preenche o perfil e vai até a lista de conversas. Retorna um aviso (ex.: foto não aplicada)."""

    def open_link_screen(self) -> None:
        """⋮ → Aparelhos conectados → Conectar aparelho → Conectar com número de telefone."""

    def enter_pair_code(self, code: str) -> str | None:
        """Digita o código de 8 caracteres. Retorna uma observação para `message`."""

    def manual(self, action: dict[str, Any]) -> None:
        """Ação do operador: {"type": "tap", "x", "y"} (0 a 1, proporção da tela),
        {"type": "key", "key": back|home|scroll_up|scroll_down} ou {"type": "text", "text"}."""

    def screenshot(self) -> bytes | None: ...

    def screen_elements(self) -> dict[str, Any]:
        """{"width", "height", "elements": [...]}: elementos da tela de agora (MCP e IA)."""

    def debug_dump(self) -> str | None:
        """XML da tela atual sem o texto dos campos (diagnóstico de tela desconhecida)."""

    def power_off(self) -> None: ...

    def close(self) -> None: ...


AutomationFactory = Callable[[JobSpec, JobContext], PhoneAutomation]

"""Interface entre a máquina de estados (jobs.py) e o que mexe no phone.

A máquina de estados só conhece `PhoneAutomation`. A implementação real
(`device_automation.GeeLarkAutomation`) usa a API do GeeLark + adb + uiautomator2; os testes
usam uma implementação falsa, sem aparelho.

Regras para quem implementa:
- Falhas esperadas viram `JobError(errorCode, mensagem em português)`.
- Toda espera passa por `ctx.sleep()` / `ctx.check()`: é assim que o cancelamento e o teto
  de 20 min interrompem o trabalho.
- Nunca logar o código SMS, o código de pareamento nem a senha do proxy.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Protocol

from .errors import JobCancelled, JobTimedOut


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
    power_off_when_done: bool = True
    probe_proxy: ProbeProxySpec | None = field(default=None, repr=False)
    # "register" = cadastro completo; "network_check" = só aplica a rede, liga e confere o IP.
    mode: str = "register"
    # Apaga os dados do app antes de abrir, mesmo com uma conta ativa nele (escolha do usuário).
    reset_app: bool = False

    @property
    def full_number(self) -> str:
        return self.country_code + self.number


@dataclass(frozen=True)
class SmsResult:
    accepted: bool
    message: str | None = None   # motivo, quando recusado


class JobContext:
    """Cancelamento e prazo do job, compartilhados com a automação."""

    def __init__(self, cancel_event: threading.Event, deadline: float, timeout_message: str):
        self._cancel = cancel_event
        self.deadline = deadline
        self._timeout_message = timeout_message

    @property
    def cancelled(self) -> bool:
        return self._cancel.is_set()

    def remaining(self) -> float:
        return self.deadline - time.monotonic()

    def check(self) -> None:
        if self._cancel.is_set():
            raise JobCancelled()
        if time.monotonic() >= self.deadline:
            raise JobTimedOut(self._timeout_message)

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

    def debug_dump(self) -> str | None:
        """XML da tela atual sem o texto dos campos (diagnóstico de tela desconhecida)."""

    def power_off(self) -> None: ...

    def close(self) -> None: ...


AutomationFactory = Callable[[JobSpec, JobContext], PhoneAutomation]

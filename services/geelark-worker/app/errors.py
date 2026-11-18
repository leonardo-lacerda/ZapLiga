"""Exceções compartilhadas entre a automação, a máquina de estados e a camada HTTP."""

from __future__ import annotations

ERROR_CODES = frozenset({
    "egress_offline", "egress_mismatch", "no_internet", "phone_start_failed",
    "adb_failed", "install_failed", "unknown_screen", "number_banned", "sms_rejected", "wait_limit",
    "timeout", "pair_failed", "link_timeout", "worker_lost", "cancelled", "internal",
    "manual_takeover",  # interno: o operador assumiu o controle (nunca vira errorCode de job)
})

PERMISSION_TODO_MESSAGE = (
    "diálogo de permissão do Android ainda não tratado: implemente handle_permission"
)


class JobError(Exception):
    """Falha do job com um `errorCode` do contrato e mensagem em português para o usuário."""

    def __init__(self, code: str, message: str):
        if code not in ERROR_CODES:
            raise ValueError(f"errorCode fora do contrato: {code}")
        self.code = code
        self.message = message
        super().__init__(f"{code}: {message}")


class JobAbort(BaseException):
    """Interrompe o job de qualquer ponto.

    Herda de BaseException de propósito: um `except Exception` de "melhor esforço"
    (ex.: a foto do perfil) não pode engolir um cancelamento ou um timeout.
    """


class JobCancelled(JobAbort):
    pass


class JobTimedOut(JobAbort):
    def __init__(self, message: str):
        self.message = message
        super().__init__(message)


class ApiError(Exception):
    """Erro devolvido pela API HTTP do worker: `{ "error": code, "message": ... }`."""

    def __init__(self, status: int, code: str, message: str):
        self.status = status
        self.code = code
        self.message = message
        super().__init__(f"{status} {code}: {message}")

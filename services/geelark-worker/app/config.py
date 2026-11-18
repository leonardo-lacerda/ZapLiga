"""Configuração lida do ambiente (nunca de arquivos .env)."""

from __future__ import annotations

import os
from dataclasses import dataclass, field


def _int_env(name: str, default: int) -> int:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError as exc:
        raise ValueError(f"{name} precisa ser um número inteiro") from exc


@dataclass(frozen=True)
class Settings:
    geelark_api_token: str = field(default="", repr=False)
    worker_token: str = field(default="", repr=False)
    max_jobs: int = 2
    input_timeout_s: float = 600.0   # espera por entrada humana (contrato: 10 min)
    job_timeout_s: float = 1200.0    # teto do job inteiro (contrato: 20 min)
    rescue_window_s: float = 59.0    # depois de um erro: tempo para o operador assumir o phone
    debug_dir: str = "/tmp/geelark-worker-debug"

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            geelark_api_token=os.getenv("GEELARK_API_TOKEN", "").strip(),
            worker_token=os.getenv("GEELARK_WORKER_TOKEN", "").strip(),
            max_jobs=max(1, _int_env("WORKER_MAX_JOBS", 2)),
            debug_dir=os.getenv("WORKER_DEBUG_DIR", "/tmp/geelark-worker-debug"),
        )

"""Arquivo de telas reais: cada tela diferente que o robô vê, gravada uma vez por versão do app.

  {data_dir}/screens/{app}/{versão}/{tela}--{impressão}.xml   (sem o texto dos campos)
  {data_dir}/screens/{app}/{versão}/{tela}--{impressão}.png

Serve para três coisas: testes com telas de verdade (em vez de listas de textos inventadas),
saber quando o WhatsApp mudou de versão e uma tela nova apareceu, e ensinar telas novas ao robô.
"""

from __future__ import annotations

import logging
import os
import re
import threading
from typing import Callable

log = logging.getLogger(__name__)

MAX_FILES = 5000  # teto de segurança do disco: passou disso, para de gravar
_SAFE = re.compile(r"[^a-z0-9]+")


def slug(value: str) -> str:
    return _SAFE.sub("-", value.lower()).strip("-")[:40] or "tela"


class ScreenArchive:
    def __init__(self, root: str | None):
        self.root = root
        self._lock = threading.Lock()
        self._count: int | None = None

    def _files(self) -> int:
        if self._count is None:
            self._count = sum(len(files) for _, _, files in os.walk(self.root)) if self.root and os.path.isdir(self.root) else 0
        return self._count

    def path_for(self, app: str, version: str, screen: str, fp: str) -> str:
        assert self.root
        return os.path.join(self.root, slug(app), slug(version or "desconhecida"), f"{slug(screen)}--{fp}")

    def save(self, app: str, version: str, screen: str, fp: str, xml: str,
             screenshot: Callable[[], bytes | None]) -> bool:
        """Grava a tela se ela ainda não existe. True = tela nova nesta versão do app."""
        if not self.root:
            return False
        base = self.path_for(app, version, screen, fp)
        with self._lock:
            if os.path.exists(base + ".xml") or self._files() >= MAX_FILES:
                return False
            try:
                os.makedirs(os.path.dirname(base), exist_ok=True)
                with open(base + ".xml", "w", encoding="utf-8") as fh:
                    fh.write(xml)
                png = screenshot()
                if png:
                    with open(base + ".png", "wb") as fh:
                        fh.write(png)
                self._count = self._files() + (2 if png else 1)
            except OSError as exc:
                log.warning("não consegui gravar a tela no arquivo (%s)", type(exc).__name__)
                return False
        log.info("tela nova no arquivo: %s %s %s (%s)", app, version, screen, fp)
        return True

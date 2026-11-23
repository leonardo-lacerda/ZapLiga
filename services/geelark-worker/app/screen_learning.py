"""Memória de telas: o que fazer numa tela que o robô não conhece.

Uma tela desconhecida é resolvida primeiro pela memória (de graça, na hora) e só depois pela
IA (copilot.py). Cada ação que fez a tela andar é gravada aqui com a "impressão digital" da
tela; quando a mesma ação dá certo vezes suficientes (`is_trusted`), o robô passa a repeti-la
sozinho e a IA deixa de ser chamada para essa tela.

A impressão digital é o conjunto de ids e textos dos elementos, com números trocados por `#`:
o número do chip ou um relógio contando não fazem a mesma tela parecer outra. A ação é gravada
pelo que o elemento é (id, texto, descrição), nunca pela posição: o GeeLark troca a resolução
quando gera um aparelho novo.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import threading
import time
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from typing import Any

log = logging.getLogger(__name__)

# Barra de status e de navegação do Android: muda o tempo todo (hora, bateria) e nunca é a saída.
IGNORED_PACKAGES = frozenset({"com.android.systemui"})
MAX_ELEMENTS = 80
_BOUNDS = re.compile(r"\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]")
_DIGITS = re.compile(r"\d+")
_SPACES = re.compile(r"\s+")

# Botões que nem a IA nem a memória tocam: pedir código de novo trava o número por horas,
# e os outros mudam o número, apagam a conta ou saem dela. Quem decide é o operador.
# "Ligação de voz" NÃO entra: na lista de métodos é a escolha certa para linha fixa (23/11).
FORBIDDEN_TEXT = re.compile(
    r"(?i)(reenviar|resend|send (sms|code) again|enviar (o )?(sms|c[óo]digo) (de )?novo|enviar (o )?sms novamente"
    r"|me ligue|ligue-me|ligar para mim|call me"
    r"|n[úu]mero errado|wrong number|editar n[úu]mero|edit number|alterar n[úu]mero|change number"
    r"|(excluir|apagar|delete|remover|remove) (minha |a |sua |esta |my |your |this )?(conta|account)"
    r"|\bsair\b|log ?out|sign out|desconectar|disconnect"
    r"|denunciar|\breport\b|bloquear|\bblock\b|transferir|transfer)"
)
# Teclado do phone: "Tecla Delete", "Enter"... nunca são o botão perigoso de uma tela.
IME_PACKAGE = re.compile(r"(?i).*(inputmethod|keyboard|\.ime\b|com\.github\.uiautomator).*")
IME_KEY_ID = re.compile(r"^key_pos_")


@dataclass(frozen=True)
class Element:
    """Um elemento visível da tela, do jeito que a IA e a memória enxergam."""
    index: int
    cls: str          # classe curta: Button, TextView, EditText...
    text: str         # vazio em campos editáveis (o texto digitado nunca sai daqui)
    desc: str         # content-desc (acessibilidade)
    rid: str          # resource-id sem o pacote: "eula_accept"
    package: str
    clickable: bool
    scrollable: bool
    editable: bool
    bounds: tuple[int, int, int, int]

    @property
    def center(self) -> tuple[int, int]:
        x1, y1, x2, y2 = self.bounds
        return (x1 + x2) // 2, (y1 + y2) // 2

    @property
    def forbidden(self) -> bool:
        if IME_PACKAGE.fullmatch(self.package) or IME_KEY_ID.match(self.rid):
            return False
        return bool(FORBIDDEN_TEXT.search(f"{self.text} {self.desc}"))

    def describe(self) -> str:
        """Uma linha para a IA: `[3] Button "Agora não" id=skip_btn clicável`."""
        parts = [f"[{self.index}] {self.cls}"]
        if self.text:
            parts.append(f'"{self.text[:80]}"')
        elif self.editable:
            parts.append("(campo de texto)")
        if self.desc:
            parts.append(f'desc="{self.desc[:80]}"')
        if self.rid:
            parts.append(f"id={self.rid}")
        flags = [name for name, on in (("clicável", self.clickable), ("rolável", self.scrollable)) if on]
        if flags:
            parts.append(" ".join(flags))
        if self.forbidden:
            parts.append("[BLOQUEADO]")
        return " ".join(parts)


def _norm(value: str) -> str:
    return _SPACES.sub(" ", _DIGITS.sub("#", value.strip().lower()))[:60]


def parse_elements(xml: str) -> list[Element]:
    """Elementos úteis do dump do uiautomator2 (com texto, descrição ou que dá para tocar/rolar)."""
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return []
    found: list[Element] = []
    for node in root.iter("node"):
        package = node.get("package", "")
        if package in IGNORED_PACKAGES:
            continue
        match = _BOUNDS.match(node.get("bounds", ""))
        if not match:
            continue
        x1, y1, x2, y2 = (int(v) for v in match.groups())
        if x2 <= x1 or y2 <= y1:
            continue  # invisível
        cls = node.get("class", "").rsplit(".", 1)[-1]
        editable = cls in ("EditText", "AutoCompleteTextView")
        text = "" if editable else (node.get("text") or "").strip()
        desc = (node.get("content-desc") or "").strip()
        rid = (node.get("resource-id") or "").split("/", 1)[-1]
        clickable = node.get("clickable") == "true"
        scrollable = node.get("scrollable") == "true"
        if not (text or desc or clickable or scrollable or editable):
            continue
        found.append(Element(len(found), cls, text, desc, rid, package, clickable, scrollable, editable,
                             (x1, y1, x2, y2)))
        if len(found) >= MAX_ELEMENTS:
            break
    return found


def fingerprint(elements: list[Element]) -> str:
    """Identidade estável da tela (mesma tela = mesma impressão, mesmo com outro número no chip)."""
    tokens = sorted({f"{e.cls}|{e.rid}|{_norm(e.text)}|{_norm(e.desc)}" for e in elements})
    return hashlib.sha1("\n".join(tokens).encode("utf-8")).hexdigest()[:16]


def summary(elements: list[Element], limit: int = 8) -> list[str]:
    """Os textos da tela, para uma pessoa reconhecer a tela aprendida no painel."""
    texts = [e.text or e.desc for e in elements if (e.text or e.desc)]
    return [t[:80] for t in texts[:limit]]


# --------------------------------------------------------------- ações
# Uma ação gravada: {"kind": "tap", "cls", "rid", "text", "desc"} | {"kind": "back"}
# | {"kind": "scroll", "dir": "down"|"up"}. Esperar não é gravado: não ensina nada.

def tap_action(element: Element) -> dict[str, str]:
    return {"kind": "tap", "cls": element.cls, "rid": element.rid,
            "text": _norm(element.text), "desc": _norm(element.desc)}


def find_target(action: dict[str, Any], elements: list[Element]) -> Element | None:
    """O elemento que uma ação de toque gravada quer, na tela de agora."""
    for element in elements:
        if (element.cls == action.get("cls") and element.rid == action.get("rid")
                and _norm(element.text) == action.get("text") and _norm(element.desc) == action.get("desc")):
            return element
    return None


# ------------------------------------------------------------ memória
def is_trusted(entry: dict[str, Any]) -> bool:
    """A memória já pode repetir esta ação sozinha, sem perguntar à IA?

    `entry` tem `successes` (vezes que a ação fez a tela andar), `failures` (vezes que a
    tela ficou parada ou voltou para trás) e `source` ("ai" ou "operator").
    """
    # Uma falha já tira a confiança: a contagem recomeça quando outra ação passa a ser gravada.
    if entry.get("failures", 0) > 0:
        return False
    # O operador sabe o que está tocando: basta um acerto. A IA precisa repetir o acerto.
    needed = 1 if entry.get("source") == "operator" else 2
    return entry.get("successes", 0) >= needed


class LearnedScreens:
    """Arquivo JSON com as telas aprendidas, compartilhado por todos os jobs do worker."""

    VERSION = 1

    def __init__(self, path: str | None):
        self.path = path
        self._lock = threading.Lock()
        self._screens: dict[str, dict[str, Any]] = {}
        self._load()

    @staticmethod
    def key(app: str, fp: str) -> str:
        return f"{app}:{fp}"

    def _load(self) -> None:
        if not self.path or not os.path.exists(self.path):
            return
        try:
            with open(self.path, encoding="utf-8") as fh:
                data = json.load(fh)
            if data.get("version") == self.VERSION:
                self._screens = dict(data.get("screens") or {})
            log.info("memória de telas: %s telas aprendidas", len(self._screens))
        except (OSError, ValueError) as exc:
            log.warning("memória de telas ilegível; começando do zero (%s)", type(exc).__name__)

    def _save_locked(self) -> None:
        if not self.path:
            return
        try:
            os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
            tmp = f"{self.path}.tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump({"version": self.VERSION, "screens": self._screens}, fh, ensure_ascii=False, indent=1)
            os.replace(tmp, self.path)  # nunca deixa o arquivo pela metade
        except OSError as exc:
            log.warning("não consegui gravar a memória de telas (%s)", type(exc).__name__)

    def lookup(self, app: str, fp: str) -> dict[str, Any] | None:
        with self._lock:
            entry = self._screens.get(self.key(app, fp))
            return dict(entry) if entry else None

    def trusted_action(self, app: str, fp: str) -> dict[str, Any] | None:
        entry = self.lookup(app, fp)
        return entry["action"] if entry and is_trusted(entry) else None

    def record(self, app: str, fp: str, action: dict[str, Any], ok: bool, *, source: str,
               goal: str, screen: list[str]) -> dict[str, Any]:
        """Resultado de uma ação numa tela. Ação diferente da gravada recomeça a contagem."""
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        with self._lock:
            key = self.key(app, fp)
            entry = self._screens.get(key)
            if entry is None or entry.get("action") != action:
                entry = {"app": app, "action": action, "source": source, "successes": 0, "failures": 0,
                         "first_seen": now, "replaced": (entry or {}).get("replaced", 0) + (1 if entry else 0)}
                self._screens[key] = entry
            entry["successes" if ok else "failures"] += 1
            entry.update(goal=goal, screen=screen, last_seen=now)
            self._save_locked()
            return dict(entry)

    def all(self) -> list[dict[str, Any]]:
        with self._lock:
            items = [{"key": key, **entry, "trusted": is_trusted(entry)} for key, entry in self._screens.items()]
        return sorted(items, key=lambda item: item.get("last_seen", ""), reverse=True)

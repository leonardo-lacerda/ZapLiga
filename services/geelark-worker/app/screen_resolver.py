"""Resolve uma tela desconhecida: memória primeiro, IA depois, operador por último.

  tela conhecida      -> robô (whatsapp.py / device_automation.py)
  tela desconhecida   -> memória (ação já confiável, sem custo)
                      -> copiloto (Claude), que ensina a memória a cada ação que anda
  nada resolveu       -> o operador assume, como antes

As operações do aparelho chegam por `ScreenOps`: o resolvedor não conhece o uiautomator2 e
é testado sem phone.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Callable

from .copilot import Copilot, Decision
from .screen_learning import (Element, LearnedScreens, find_target, fingerprint, parse_elements, summary,
                              tap_action)

log = logging.getLogger(__name__)

MAX_STEPS = 8            # ações seguidas da IA antes de chamar o operador
MAX_AI_CALLS_PER_JOB = 25  # teto de custo por cadastro
SETTLE_S = 2.0           # espera a tela reagir antes de conferir se andou
AI_NOTE = "Tela nova do WhatsApp: a IA está tentando passar por ela."


@dataclass
class ScreenOps:
    dump: Callable[[], str]                  # XML da tela (uiautomator2 dump_hierarchy)
    screenshot: Callable[[], bytes | None]
    tap: Callable[[int, int], None]
    back: Callable[[], None]
    scroll: Callable[[str], None]            # "down" | "up"
    sleep: Callable[[float], None]           # acorda no cancelamento (ctx.sleep)
    check: Callable[[], None]                # cancelamento, prazo e "Assumir o controle"
    is_known: Callable[[], bool]             # o robô já reconhece a tela de agora?


class ScreenResolver:
    def __init__(self, memory: LearnedScreens | None, copilot: Copilot | None, app: str, job_id: str = "",
                 note: Callable[[str], None] | None = None, max_ai_calls: int = MAX_AI_CALLS_PER_JOB):
        self.memory = memory
        self.copilot = copilot
        self.app = app
        self.job_id = job_id
        self.note = note or (lambda _message: None)
        self.max_ai_calls = max_ai_calls
        self.ai_calls = 0

    # ----------------------------------------------------------- leitura
    def _read(self, ops: ScreenOps) -> tuple[list[Element], str]:
        elements = parse_elements(ops.dump())
        return elements, fingerprint(elements)

    def _settled_fp(self, ops: ScreenOps) -> str:
        ops.sleep(SETTLE_S)
        return self._read(ops)[1]

    # ----------------------------------------------------------- memória
    def try_memory(self, ops: ScreenOps, goal: str) -> bool:
        """Repete uma ação confiável para esta tela. True = a tela andou."""
        if self.memory is None:
            return False
        elements, fp = self._read(ops)
        return self._replay(ops, goal, elements, fp)

    def _replay(self, ops: ScreenOps, goal: str, elements: list[Element], fp: str) -> bool:
        if self.memory is None:
            return False
        action = self.memory.trusted_action(self.app, fp)
        if action is None or not self._apply(ops, action, elements):
            return False
        moved = self._settled_fp(ops) != fp
        entry = self.memory.lookup(self.app, fp) or {}
        self.memory.record(self.app, fp, action, moved, source=entry.get("source", "ai"), goal=goal,
                           screen=summary(elements))
        log.info("[%s] memória: %s na tela %s (%s)", self.job_id, action.get("kind"), fp,
                 "andou" if moved else "não andou")
        return moved

    def _apply(self, ops: ScreenOps, action: dict[str, Any], elements: list[Element]) -> bool:
        kind = action.get("kind")
        if kind == "tap":
            target = find_target(action, elements)
            if target is None or target.forbidden:
                return False
            ops.tap(*target.center)
        elif kind == "back":
            ops.back()
        elif kind == "scroll":
            ops.scroll(action.get("dir", "down"))
        else:
            return False
        return True

    # --------------------------------------------------------------- IA
    def resolve(self, ops: ScreenOps, goal: str) -> str | None:
        """Tenta passar da tela desconhecida. None = passou; texto = motivo para chamar o operador."""
        if self.copilot is None:
            return "o copiloto de IA está desligado"
        seen: set[str] = set()
        history: list[str] = []
        last_fp = ""
        for _ in range(MAX_STEPS):
            ops.check()
            if ops.is_known():
                return None
            elements, fp = self._read(ops)
            if fp != last_fp:
                history, last_fp = [], fp  # tela nova: o histórico é da tela
            seen.add(fp)
            if self._replay(ops, goal, elements, fp):
                continue
            if self.ai_calls >= self.max_ai_calls:
                return f"a IA já foi usada {self.ai_calls} vezes neste cadastro"
            self.note(AI_NOTE)
            decision = self.copilot.decide(goal, elements, history, ops.screenshot(), self.job_id)
            self.ai_calls += 1
            if decision is None:
                return "a IA não respondeu"
            log.info("[%s] IA: %s %s (%s)", self.job_id, decision.action, decision.element, decision.reason)
            if decision.action == "desistir":
                return decision.reason or "a IA não achou uma ação segura"
            if decision.action == "esperar":
                ops.sleep(4)
                history.append(f"esperar: {decision.reason}")
                continue
            action = self._act(ops, decision, elements)
            if action is None:
                history.append(f"tocar [{decision.element}] foi recusado (elemento bloqueado)")
                continue
            new_fp = self._settled_fp(ops)
            moved = new_fp != fp and new_fp not in seen  # voltar para uma tela já vista não conta
            if self.memory is not None:
                self.memory.record(self.app, fp, action, moved, source="ai", goal=goal, screen=summary(elements))
            history.append(f"{_label(decision)}: {'a tela mudou' if new_fp != fp else 'a tela NÃO mudou'}")
        return "a IA não conseguiu passar desta tela"

    def _act(self, ops: ScreenOps, decision: Decision, elements: list[Element]) -> dict[str, Any] | None:
        if decision.action == "tocar":
            element = elements[decision.element]
            if element.forbidden:
                log.warning("[%s] IA quis tocar num elemento bloqueado; recusado", self.job_id)
                return None
            ops.tap(*element.center)
            return tap_action(element)
        if decision.action == "voltar":
            ops.back()
            return {"kind": "back"}
        direction = "down" if decision.action == "rolar_baixo" else "up"
        ops.scroll(direction)
        return {"kind": "scroll", "dir": direction}

    # ---------------------------------------------------------- operador
    def learn_operator_tap(self, before_xml: str, x: int, y: int, after_xml: str, goal: str) -> None:
        """O operador tocou numa tela desconhecida: se a tela andou, a memória aprende o toque."""
        if self.memory is None:
            return
        elements = parse_elements(before_xml)
        hits = [e for e in elements if e.clickable and _contains(e, x, y)]
        if not hits:
            return
        target = min(hits, key=_area)  # o botão, não o painel em volta dele
        if target.forbidden or target.editable:
            return
        fp = fingerprint(elements)
        moved = fingerprint(parse_elements(after_xml)) != fp
        self.memory.record(self.app, fp, tap_action(target), moved, source="operator", goal=goal,
                           screen=summary(elements))
        log.info("[%s] memória: toque do operador na tela %s (%s)", self.job_id, fp, "andou" if moved else "não andou")


def _label(decision: Decision) -> str:
    return f"tocar [{decision.element}]" if decision.action == "tocar" else decision.action


def _contains(element: Element, x: int, y: int) -> bool:
    x1, y1, x2, y2 = element.bounds
    return x1 <= x <= x2 and y1 <= y <= y2


def _area(element: Element) -> int:
    x1, y1, x2, y2 = element.bounds
    return (x2 - x1) * (y2 - y1)

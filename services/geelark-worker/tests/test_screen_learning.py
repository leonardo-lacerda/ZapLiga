"""Memória de telas, copiloto de IA e resolvedor de telas desconhecidas (sem phone)."""

from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from app import screen_learning
from app.copilot import Copilot, Decision, parse_decision
from app.screen_learning import LearnedScreens, fingerprint, parse_elements
from app.screen_resolver import ScreenOps, ScreenResolver


def node(text="", rid="", cls="android.widget.TextView", bounds=(0, 0, 100, 50), clickable=False,
         package="com.whatsapp", desc=""):
    x1, y1, x2, y2 = bounds
    return (f'<node text="{text}" resource-id="{rid}" class="{cls}" package="{package}" content-desc="{desc}" '
            f'clickable="{str(clickable).lower()}" scrollable="false" bounds="[{x1},{y1}][{x2},{y2}]" />')


def screen(*nodes: str) -> str:
    return f'<?xml version="1.0"?><hierarchy rotation="0">{"".join(nodes)}</hierarchy>'


PROMO = screen(
    node("Conheça o Meta Verified", rid="com.whatsapp:id/title"),
    node("Agora não", rid="com.whatsapp:id/skip", cls="android.widget.Button", bounds=(0, 900, 500, 1000), clickable=True),
    node("Assinar", rid="com.whatsapp:id/go", cls="android.widget.Button", bounds=(500, 900, 1000, 1000), clickable=True),
)
CODE_SHEET = screen(
    node("Não recebeu o código?", rid="com.whatsapp:id/title"),
    node("Reenviar SMS", rid="com.whatsapp:id/resend", cls="android.widget.Button", bounds=(0, 900, 500, 1000), clickable=True),
    node("Fechar", rid="com.whatsapp:id/close", cls="android.widget.Button", bounds=(500, 900, 1000, 1000), clickable=True),
)
NEXT = screen(node("Perfil", rid="com.whatsapp:id/profile_title"))


# ------------------------------------------------------------- elementos
def test_parse_elements_hides_typed_text_and_skips_the_status_bar():
    xml = screen(
        node("10:16", package="com.android.systemui"),
        node("123456", rid="com.whatsapp:id/code", cls="android.widget.EditText", clickable=True),
        node("", rid="com.whatsapp:id/spacer"),                     # sem texto e sem toque: fora
        node("Invisível", bounds=(10, 10, 10, 10)),                  # sem área: fora
        node("Avançar", rid="com.whatsapp:id/next", cls="android.widget.Button", clickable=True),
    )
    elements = parse_elements(xml)
    assert [(e.cls, e.text, e.rid) for e in elements] == [("EditText", "", "code"), ("Button", "Avançar", "next")]
    assert elements[0].editable and "(campo de texto)" in elements[0].describe()
    assert parse_elements("não é xml") == []


def test_fingerprint_ignores_numbers_but_not_buttons():
    a = screen(node("Enviamos um SMS para +55 27 98155-4290"), node("Ok", cls="android.widget.Button", clickable=True))
    b = screen(node("Enviamos um SMS para +55 11 99999-8888"), node("Ok", cls="android.widget.Button", clickable=True))
    c = screen(node("Enviamos um SMS para +55 11 99999-8888"), node("Cancelar", cls="android.widget.Button", clickable=True))
    assert fingerprint(parse_elements(a)) == fingerprint(parse_elements(b))
    assert fingerprint(parse_elements(a)) != fingerprint(parse_elements(c))


def test_buttons_that_burn_the_number_are_blocked():
    elements = parse_elements(CODE_SHEET)
    resend, close = elements[1], elements[2]
    assert resend.forbidden and "[BLOQUEADO]" in resend.describe()
    assert not close.forbidden


# --------------------------------------------------------------- memória
def test_memory_counts_results_restarts_on_a_new_action_and_survives_a_restart(tmp_path):
    path = str(tmp_path / "data" / "learned.json")
    memory = LearnedScreens(path)
    skip = {"kind": "tap", "cls": "Button", "rid": "skip", "text": "agora não", "desc": ""}
    memory.record("whatsapp", "fp1", skip, True, source="ai", goal="g", screen=["Agora não"])
    entry = memory.record("whatsapp", "fp1", skip, False, source="ai", goal="g", screen=["Agora não"])
    assert (entry["successes"], entry["failures"]) == (1, 1)
    entry = memory.record("whatsapp", "fp1", {"kind": "back"}, True, source="operator", goal="g", screen=[])
    assert (entry["successes"], entry["failures"], entry["source"], entry["replaced"]) == (1, 0, "operator", 1)

    again = LearnedScreens(path)  # novo processo (deploy): lê do disco
    assert again.lookup("whatsapp", "fp1")["action"] == {"kind": "back"}
    assert again.lookup("business", "fp1") is None
    assert json.load(open(path, encoding="utf-8"))["version"] == 1


# --------------------------------------------------------------- copiloto
class FakeMessages:
    def __init__(self, replies):
        self.replies = list(replies)
        self.calls = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        stop, payload = reply
        return SimpleNamespace(stop_reason=stop, content=[SimpleNamespace(type="text", text=json.dumps(payload))],
                               usage=SimpleNamespace(input_tokens=900, output_tokens=40))


def fake_copilot(*replies) -> tuple[Copilot, FakeMessages]:
    messages = FakeMessages(replies)
    return Copilot(client=SimpleNamespace(beta=SimpleNamespace(messages=messages))), messages


def test_copilot_asks_for_one_structured_decision_with_the_screen():
    copilot, messages = fake_copilot(("end_turn", {"acao": "tocar", "elemento": 1, "motivo": "pular a oferta"}))
    decision = copilot.decide("chegar no perfil", parse_elements(PROMO), [], None, "job-1")
    assert decision == Decision("tocar", 1, "pular a oferta")
    call = messages.calls[0]
    assert call["model"] == "claude-opus-5-5"
    assert call["output_config"]["format"]["type"] == "json_schema"
    assert call["fallbacks"] == "default" and call["betas"] == ["server-side-fallback-2026-07-01"]
    text = call["messages"][0]["content"][-1]["text"]
    assert "chegar no perfil" in text and '[1] Button "Agora não" id=skip clicável' in text


def test_copilot_without_an_answer_hands_over_to_the_operator():
    copilot, _ = fake_copilot(("refusal", {}), RuntimeError("rede"))
    elements = parse_elements(PROMO)
    assert copilot.decide("g", elements, [], None) is None   # recusa
    assert copilot.decide("g", elements, [], None) is None   # erro de API
    text = lambda payload: [SimpleNamespace(type="text", text=json.dumps(payload))]
    assert parse_decision(text({"acao": "tocar", "elemento": 7, "motivo": ""}), 3) is None  # fora da lista
    assert parse_decision(text({"acao": "voltar", "elemento": 2, "motivo": "x"}), 3) == Decision("voltar", -1, "x")


# ------------------------------------------------------------ resolvedor
class FakePhone:
    """Telas em XML; tocar num botão leva para a tela de `routes[(tela, id)]`."""

    def __init__(self, current: str, screens: dict[str, str], routes: dict[tuple[str, str], str], known=("next",)):
        self.current, self.screens, self.routes, self.known = current, screens, routes, set(known)
        self.taps: list[str] = []

    def tap(self, x, y):
        for element in parse_elements(self.screens[self.current]):
            x1, y1, x2, y2 = element.bounds
            if x1 <= x <= x2 and y1 <= y <= y2 and element.clickable:
                self.taps.append(element.rid)
                self.current = self.routes.get((self.current, element.rid), self.current)
                return

    def ops(self) -> ScreenOps:
        return ScreenOps(dump=lambda: self.screens[self.current], screenshot=lambda: None, tap=self.tap,
                         back=lambda: None, scroll=lambda _d: None, sleep=lambda _s: None, check=lambda: None,
                         is_known=lambda: self.current in self.known)


def phone_at_promo() -> FakePhone:
    return FakePhone("promo", {"promo": PROMO, "next": NEXT}, {("promo", "skip"): "next", ("promo", "go"): "promo"})


def test_the_ai_passes_an_unknown_screen_and_teaches_the_memory(tmp_path):
    memory = LearnedScreens(str(tmp_path / "m.json"))
    copilot, _ = fake_copilot(("end_turn", {"acao": "tocar", "elemento": 1, "motivo": "pular"}))
    notes = []
    resolver = ScreenResolver(memory, copilot, "whatsapp", "job-1", note=notes.append)
    phone = phone_at_promo()
    assert resolver.resolve(phone.ops(), "chegar no perfil") is None
    assert phone.taps == ["skip"] and resolver.ai_calls == 1 and notes
    entry = memory.lookup("whatsapp", fingerprint(parse_elements(PROMO)))
    assert entry["action"]["rid"] == "skip" and (entry["successes"], entry["source"]) == (1, "ai")


def test_a_trusted_screen_is_passed_without_the_ai(tmp_path, monkeypatch):
    monkeypatch.setattr(screen_learning, "is_trusted", lambda entry: entry["successes"] >= 1)
    memory = LearnedScreens(str(tmp_path / "m.json"))
    skip = screen_learning.tap_action(parse_elements(PROMO)[1])
    memory.record("whatsapp", fingerprint(parse_elements(PROMO)), skip, True, source="ai", goal="g", screen=[])
    resolver = ScreenResolver(memory, None, "whatsapp")   # nem há copiloto
    phone = phone_at_promo()
    assert resolver.try_memory(phone.ops(), "g") is True
    assert phone.taps == ["skip"] and resolver.ai_calls == 0
    assert memory.lookup("whatsapp", fingerprint(parse_elements(PROMO)))["successes"] == 2


def test_the_ai_never_taps_a_blocked_button_and_gives_up_with_the_reason():
    copilot, messages = fake_copilot(
        ("end_turn", {"acao": "tocar", "elemento": 1, "motivo": "reenviar"}),      # [1] = Reenviar SMS
        ("end_turn", {"acao": "desistir", "elemento": -1, "motivo": "só dá para pedir outro código"}),
    )
    resolver = ScreenResolver(None, copilot, "whatsapp")
    phone = FakePhone("sheet", {"sheet": CODE_SHEET}, {("sheet", "resend"): "sheet"}, known=())
    assert resolver.resolve(phone.ops(), "g") == "só dá para pedir outro código"
    assert phone.taps == []
    assert "foi recusado" in messages.calls[1]["messages"][0]["content"][-1]["text"]


def test_a_tap_that_goes_nowhere_counts_as_a_failure(tmp_path):
    memory = LearnedScreens(str(tmp_path / "m.json"))
    copilot, _ = fake_copilot(
        ("end_turn", {"acao": "tocar", "elemento": 2, "motivo": "assinar"}),       # não sai da tela
        ("end_turn", {"acao": "tocar", "elemento": 1, "motivo": "pular"}),
    )
    resolver = ScreenResolver(memory, copilot, "whatsapp")
    assert resolver.resolve(phone_at_promo().ops(), "g") is None
    entry = memory.lookup("whatsapp", fingerprint(parse_elements(PROMO)))
    # A ação que andou substitui a que falhou.
    assert entry["action"]["rid"] == "skip" and (entry["successes"], entry["failures"], entry["replaced"]) == (1, 0, 1)


def test_the_ai_budget_per_job_hands_over_to_the_operator():
    copilot, _ = fake_copilot(*[("end_turn", {"acao": "esperar", "elemento": -1, "motivo": "carregando"})] * 3)
    resolver = ScreenResolver(None, copilot, "whatsapp", max_ai_calls=3)
    phone = FakePhone("promo", {"promo": PROMO}, {}, known=())
    assert "3 vezes" in resolver.resolve(phone.ops(), "g")


def test_the_operator_tap_on_an_unknown_screen_is_learned(tmp_path):
    memory = LearnedScreens(str(tmp_path / "m.json"))
    resolver = ScreenResolver(memory, None, "whatsapp")
    resolver.learn_operator_tap(PROMO, 250, 950, NEXT, "g")         # tocou em "Agora não"
    resolver.learn_operator_tap(CODE_SHEET, 250, 950, NEXT, "g")    # "Reenviar SMS": nunca aprende
    entry = memory.lookup("whatsapp", fingerprint(parse_elements(PROMO)))
    assert entry["action"]["rid"] == "skip" and entry["source"] == "operator"
    assert memory.lookup("whatsapp", fingerprint(parse_elements(CODE_SHEET))) is None


@pytest.mark.parametrize("entry, expected", [
    ({"successes": 0, "failures": 0, "source": "ai"}, False),
    ({"successes": 1, "failures": 0, "source": "ai"}, False),        # a IA precisa repetir o acerto
    ({"successes": 2, "failures": 0, "source": "ai"}, True),
    ({"successes": 1, "failures": 0, "source": "operator"}, True),   # o operador basta uma vez
    ({"successes": 9, "failures": 1, "source": "ai"}, False),        # uma falha tira a confiança
    ({"successes": 3, "failures": 1, "source": "operator"}, False),
])
def test_a_brand_new_screen_is_never_trusted(entry, expected):
    assert screen_learning.is_trusted(entry) is expected

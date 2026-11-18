"""Seletores (EN + pt-BR), detecção de tela e partes da automação real que não precisam de aparelho."""

from __future__ import annotations

import re
from unittest import mock

import pytest

from app import whatsapp as wa
from app.automation import JobContext
from app.device_automation import GeeLarkAutomation, android_major
from app.errors import PERMISSION_TODO_MESSAGE, JobError
from app.geelark_api import GeeLarkError
from app.whatsapp import APPS, Screen

from conftest import make_spec

WA, BIZ = APPS["whatsapp"], APPS["business"]


def java_matches(pattern: str, text: str) -> bool:
    """uiautomator usa Matcher.matches() do Java: casa a string inteira."""
    return re.fullmatch(pattern, text) is not None


@pytest.mark.parametrize("pattern,texts", [
    (wa.NO_INTERNET_TEXT, ["Couldn't connect. Please try again later.", "Couldn’t connect. Please try again later.",
                           "WhatsApp service status unavailable.", "Não foi possível conectar. Tente novamente mais tarde."]),
    (wa.PHONE_HINT_TITLE, ["Choose a phone number", "Escolha um número de telefone"]),
    (wa.NONE_OF_ABOVE_TEXT, ["None of the above", "Nenhuma das opções acima"]),
    (wa.EULA_TEXT, ["AGREE AND CONTINUE", "Concordar e continuar"]),
    (wa.SKIP_TEXT, ["Not now", "Agora não", "SKIP", "Pular"]),
    (wa.PROFILE_TITLE, ["Profile info", "Informações do perfil"]),
    (wa.WRONG_CODE_TEXT, ["Wrong code", "The code you entered is incorrect.", "Código incorreto"]),
    (wa.LINKED_DEVICES["textMatches"], ["Linked devices", "Aparelhos conectados"]),
    (wa.LINK_A_DEVICE["textMatches"], ["Link a device", "LINK A DEVICE", "Conectar um aparelho", "Conectar aparelho"]),
    (wa.LINK_WITH_NUMBER["textMatches"], ["Link with phone number instead", "Conectar com número de telefone"]),
    (wa.MORE_OPTIONS["descriptionMatches"], ["More options", "Mais opções"]),
    (wa.BANNED_TEXT, ["This account is not allowed to use WhatsApp.", "Esta conta não pode usar o WhatsApp."]),
    (wa.WAIT_LIMIT_TEXT, ["Please wait 2 hours", "Tente novamente em 5 horas"]),
    (wa.CONFIRM_NUMBER_TEXT, ["O número está certo?", "Este número está correto?", "Is this the correct number?",
                              "Is this the right phone number?", "Is your phone number correct?",
                              "Confirme o número de telefone"]),
])
def test_selectors_match_english_and_portuguese(pattern, texts):
    for text in texts:
        assert java_matches(pattern, text), text


def test_no_false_positives():
    assert not java_matches(wa.WAIT_LIMIT_TEXT, "Couldn't connect. Please try again later.")
    assert not java_matches(wa.PHONE_HINT_TITLE, "+55 11 99999-8888")
    assert not java_matches(wa.SKIP_TEXT, "Next")
    assert not java_matches(wa.CONFIRM_NUMBER_TEXT, "Insira seu número de telefone")
    assert not java_matches(wa.CONFIRM_NUMBER_TEXT, "Qual é o meu número de telefone?")


def test_each_app_uses_its_own_prefix():
    for app, prefix in ((WA, "com.whatsapp:id/"), (BIZ, "com.whatsapp.w4b:id/")):
        ids = [s["resourceId"] for _, sels in wa.build_screens(app) for s in sels if "resourceId" in s]
        assert ids and all(i.startswith(prefix) for i in ids)


def test_business_only_screens():
    comum = {s for s, _ in wa.build_screens(WA)}
    business = {s for s, _ in wa.build_screens(BIZ)}
    assert business - comum == {Screen.USE_OTHER_NUMBER, Screen.BUSINESS_CATEGORY}


class FakeDevice:
    """Responde `.exists` para os seletores cujo texto/id está na 'tela'."""

    def __init__(self, texts=(), ids=()):
        self.texts, self.ids = list(texts), set(ids)

    def __call__(self, **sel):
        hit = False
        if "textMatches" in sel:
            hit = any(java_matches(sel["textMatches"], t) for t in self.texts)
        elif "resourceId" in sel:
            hit = sel["resourceId"] in self.ids
        elif "resourceIdMatches" in sel:
            hit = any(re.fullmatch(sel["resourceIdMatches"], i) for i in self.ids)
        return mock.Mock(exists=hit)


@pytest.mark.parametrize("texts,ids,expected", [
    (["Couldn't connect. Please try again later.", "OK"], [], Screen.NO_INTERNET),
    (["Choose a phone number", "+55 11 9999", "None of the above"], ["com.whatsapp:id/registration_phone"], Screen.PHONE_HINT),
    ([], ["com.whatsapp:id/registration_phone"], Screen.PHONE_ENTRY),
    (["Profile info"], [], Screen.PROFILE_NAME),
    ([], ["com.whatsapp:id/fab"], Screen.CHATS),
    (["Initializing…"], [], Screen.INITIALIZING),
    (["algo novo"], [], Screen.UNKNOWN),
    ([], ["com.android.permissioncontroller:id/permission_allow_button"], Screen.PERMISSION),
    # A janela de confirmação fica por cima da tela do número: tem de ganhar dela.
    (["O número está certo?", "+55 27 98152-2584", "Editar", "Sim"], ["com.whatsapp:id/registration_phone"], Screen.CONFIRM_NUMBER),
    (["O número está certo?", "Editar", "Sim"], [], Screen.CONFIRM_NUMBER),
])
def test_detect_screen(texts, ids, expected):
    assert wa.detect_screen(FakeDevice(texts, ids), WA) == expected


def test_parse_installed_exact_line():
    assert not wa.parse_installed("package:com.whatsapp.w4b\n", WA)
    assert wa.parse_installed("package:com.whatsapp.w4b\n", BIZ)
    assert wa.parse_installed("package:com.whatsapp\npackage:com.whatsapp.w4b\n", WA)


def test_scrub_hierarchy_removes_edit_text_values():
    xml = ('<hierarchy><node text="Enter code" class="android.widget.TextView" />'
           '<node index="1" text="123456" resource-id="com.whatsapp:id/verify_sms_code_input" '
           'class="android.widget.EditText" bounds="[0,0][1,1]" /></hierarchy>')
    out = wa.scrub_hierarchy(xml)
    assert "123456" not in out and "Enter code" in out


class PermissionDialog:
    """Diálogo de permissão do sistema: devolve o texto e registra o botão clicado."""

    def __init__(self, message, buttons, pkg="com.android.permissioncontroller"):
        self.message, self.buttons, self.pkg = message, set(buttons), pkg
        self.clicked = []

    def __call__(self, **sel):
        pattern = sel.get("resourceIdMatches", "")
        ids = [f"{self.pkg}:id/{b}" for b in self.buttons] + [f"{self.pkg}:id/permission_message"]
        hit = next((i for i in ids if re.fullmatch(pattern, i)), None)
        obj = mock.Mock(exists=hit is not None)
        obj.wait.return_value = hit is not None
        obj.get_text.return_value = self.message
        obj.click.side_effect = lambda: self.clicked.append(hit.rsplit("/", 1)[1])
        return obj


@pytest.mark.parametrize("message,buttons,expected", [
    ("Allow WhatsApp to send you notifications?", ["permission_allow_button", "permission_deny_button"],
     "permission_allow_button"),
    ("Permitir que o WhatsApp acesse a câmera?",
     ["permission_allow_foreground_only_button", "permission_allow_one_time_button", "permission_deny_button"],
     "permission_allow_foreground_only_button"),
    ("Allow WhatsApp to access photos and videos?",
     ["permission_allow_all_button", "permission_allow_selected_button", "permission_deny_button"],
     "permission_allow_all_button"),
    ("Permitir que o WhatsApp acesse a localização deste dispositivo?",
     ["permission_allow_foreground_only_button", "permission_deny_button"], "permission_deny_button"),
    ("Allow WhatsApp to access this device's location?",
     ["permission_allow_foreground_only_button", "permission_deny_and_dont_ask_again_button"],
     "permission_deny_and_dont_ask_again_button"),
])
def test_handle_permission_allows_all_but_location(message, buttons, expected):
    d = PermissionDialog(message, buttons)
    wa.handle_permission(d)
    assert d.clicked == [expected]


def test_handle_permission_google_permission_controller():
    d = PermissionDialog("Allow WhatsApp to access your contacts?",
                         ["permission_allow_button", "permission_deny_button"],
                         pkg="com.google.android.permissioncontroller")
    assert wa.detect_screen(FakeDevice(ids=["com.google.android.permissioncontroller:id/permission_allow_button"]),
                            WA) == Screen.PERMISSION
    wa.handle_permission(d)
    assert d.clicked == ["permission_allow_button"]


def test_android_major():
    assert android_major("12") == 12 and android_major("Android 9") == 9 and android_major(None) is None


# ------------------------------------------------- automação real sem aparelho
def make_auto(api):
    import threading
    import time
    ctx = JobContext(threading.Event(), time.monotonic() + 60, "timeout")
    ctx.sleep = lambda s: None  # sem esperas reais
    return GeeLarkAutomation(api, make_spec(), ctx)


def test_set_network_stops_phone_then_updates_proxy():
    api = mock.Mock()
    api.phone_status.side_effect = [0, 2]
    auto = make_auto(api)
    auto.set_network()
    api.stop_phone.assert_called_once_with("phone-1")
    api.update_proxy.assert_called_once_with("phone-1", 1, "edge.example", 1080, "node-a", "s3cret-proxy-pass")


def test_set_network_45004_is_egress_offline():
    api = mock.Mock()
    api.phone_status.return_value = 2
    api.update_proxy.side_effect = GeeLarkError(45004, "check proxy failed", "t", "/open/v1/phone/detail/update")
    with pytest.raises(JobError) as exc:
        make_auto(api).set_network()
    assert exc.value.code == "egress_offline"


def test_set_network_expired_phone():
    api = mock.Mock()
    api.phone_status.return_value = 3
    with pytest.raises(JobError) as exc:
        make_auto(api).set_network()
    assert exc.value.code == "phone_start_failed"


def test_permission_dialog_maps_to_internal_with_clear_message():
    auto = make_auto(mock.Mock())
    auto.d = FakeDevice()
    with mock.patch.object(wa, "handle_permission", side_effect=NotImplementedError), \
            pytest.raises(JobError) as exc:
        auto._handle_permission()
    assert exc.value.code == "internal" and exc.value.message == PERMISSION_TODO_MESSAGE


def test_connect_adb_rejects_android_10():
    api = mock.Mock()
    api.get_phone.return_value = {"id": "phone-1", "systemVer": "10"}
    with pytest.raises(JobError) as exc:
        make_auto(api).connect_adb()
    assert exc.value.code == "adb_failed" and "Android 10" in exc.value.message
    api.set_adb.assert_not_called()


def test_egress_ip_uses_curl_and_validates():
    auto = make_auto(mock.Mock())
    auto.adb = mock.Mock()
    auto.adb.shell.side_effect = ["", "<html>", "203.0.113.7\n"]
    assert auto.egress_ip() == "203.0.113.7"
    assert auto.adb.shell.call_args.args[0] == ["curl", "-s", "-m", "10", "https://api.ipify.org"]
    auto.adb.shell.side_effect = ["", "", ""]
    assert auto.egress_ip() is None

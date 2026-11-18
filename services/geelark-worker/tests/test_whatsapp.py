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
    (wa.RESEND_SMS_TEXT, ["Reenviar SMS", "Reenviar SMS em 0:45", "Resend SMS", "Resend SMS in 1:02"]),
    (wa.CALL_ME_TEXT, ["Ligar para mim", "Ligar para mim em 1:00", "Call me", "Receber ligação"]),
    (wa.OTHER_VERIFY_TEXT, ["Usar outra forma de verificação", "Use another verification method", "Verify another way"]),
    (wa.SMS_METHOD_TEXT, ["Receber SMS", "Receive SMS", "SMS"]),
    (wa.CALL_METHOD_TEXT, ["Receber ligação", "Ligação de voz", "Voice call", "Call me"]),
    (wa.DIDNT_RECEIVE_TEXT, ["Não recebeu o código?", "Didn't receive code?", "Didn’t get the code?"]),
    (wa.CONFIRM_NUMBER_TEXT, ["O número está certo?", "Este número está correto?", "Is this the correct number?",
                              "Is this the right phone number?", "Is your phone number correct?",
                              "Confirme o número de telefone"]),
])
def test_selectors_match_english_and_portuguese(pattern, texts):
    for text in texts:
        assert java_matches(pattern, text), text


def test_describe_curl_error():
    from app.device_automation import describe_curl_error
    assert describe_curl_error("") == "sem resposta"
    assert describe_curl_error("curl: (6) Could not resolve host: api.ipify.org").startswith("não achou o endereço do site (DNS)")
    assert describe_curl_error("curl: (7) Failed to connect to api.ipify.org port 443").startswith("não conseguiu conectar")
    assert describe_curl_error("curl: (28) Connection timed out after 10001 milliseconds").startswith("a conexão demorou demais")
    assert describe_curl_error("/system/bin/sh: curl: inaccessible or not found").startswith("o curl não existe")


def test_no_false_positives():
    assert not java_matches(wa.WAIT_LIMIT_TEXT, "Couldn't connect. Please try again later.")
    assert not java_matches(wa.PHONE_HINT_TITLE, "+55 11 99999-8888")
    assert not java_matches(wa.SKIP_TEXT, "Next")
    assert not java_matches(wa.CONFIRM_NUMBER_TEXT, "Insira seu número de telefone")
    assert not java_matches(wa.CONFIRM_NUMBER_TEXT, "Qual é o meu número de telefone?")
    # A verificação por ligação não atendida nunca passa no phone da nuvem: não é um método válido.
    assert not java_matches(wa.CALL_METHOD_TEXT, "Ligação não atendida")
    assert not java_matches(wa.CALL_METHOD_TEXT, "Missed call")


def test_each_app_uses_its_own_prefix():
    for app, prefix in ((WA, "com.whatsapp:id/"), (BIZ, "com.whatsapp.w4b:id/")):
        ids = [s["resourceId"] for _, sels in wa.build_screens(app) for s in sels if "resourceId" in s]
        assert ids and all(i.startswith(prefix) for i in ids)


def test_business_only_screens():
    comum = {s for s, _ in wa.build_screens(WA)}
    business = {s for s, _ in wa.build_screens(BIZ)}
    assert business - comum == {Screen.USE_OTHER_NUMBER, Screen.BUSINESS_CATEGORY, Screen.BUSINESS_WELCOME}


def test_after_sms_screens():
    # Diálogo que apareceu depois do código: tem de ser "restaurar backup" (pular), não tela desconhecida.
    dialog = ["Restaurar um backup", "Para localizar e restaurar o backup salvo no armazenamento do Google, "
              "permita que o WhatsApp acesse seus contatos.", "Cancelar", "Continuar"]
    assert wa.detect_screen(FakeDevice(dialog, []), WA) == Screen.RESTORE_BACKUP
    assert wa.detect_screen(FakeDevice(["Restore a backup", "Cancel", "Continue"], []), WA) == Screen.RESTORE_BACKUP
    for skip in ("Cancelar", "Pular", "Pular restauração", "Skip", "Não restaurar"):
        assert java_matches(wa.RESTORE_SKIP_TEXT, skip), skip
    assert not java_matches(wa.RESTORE_SKIP_TEXT, "Continuar")
    assert not java_matches(wa.RESTORE_SKIP_TEXT, "Restaurar")
    assert wa.detect_screen(FakeDevice(["Verificação em duas etapas", "Digite seu PIN de 6 dígitos"], []), WA) == Screen.TWO_STEP_PIN
    for text in ("Talvez mais tarde", "Agora não", "Pular por enquanto", "Remind me later"):
        assert java_matches(wa.SKIP_TEXT, text), text


def test_business_profile_and_welcome():
    assert wa.detect_screen(FakeDevice(["Bem-vindo ao WhatsApp Business", "Começar"], []), BIZ) == Screen.BUSINESS_WELCOME
    # No WhatsApp comum, "Começar" não é tela conhecida.
    assert wa.detect_screen(FakeDevice(["Começar"], []), WA) == Screen.UNKNOWN
    for text in ("Categoria", "Selecionar categoria", "Category"):
        assert java_matches(wa.CATEGORY_FIELD_TEXT, text), text


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
    (["Permitir acesso", "Para fazer a verificação com uma ligação não atendida, permita o acesso nas próximas telas:",
      "Continuar", "Usar outra forma de verificação"], [], Screen.MISSED_CALL_INTRO),
    # Lista de métodos com "outra forma" também: escolhe o SMS da lista.
    (["Receber SMS", "Ligação não atendida", "Usar outra forma de verificação"], [], Screen.VERIFY_METHOD),
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


def test_drive_reopens_the_app_when_the_home_screen_is_in_front():
    auto = make_auto(mock.Mock())
    auto.d = mock.Mock()
    auto.d.app_current.side_effect = [{"package": "com.android.launcher3"}, {"package": "com.whatsapp"}]
    auto._pause = lambda *a: None
    screens = iter([Screen.UNKNOWN, Screen.PHONE_ENTRY])
    with mock.patch.object(wa, "detect_screen", side_effect=lambda *a: next(screens)):
        assert auto._drive({Screen.PHONE_ENTRY}, what="digitar número") == Screen.PHONE_ENTRY
    auto.d.app_start.assert_called_once_with("com.whatsapp", wait=True)


def test_drive_gives_up_when_the_app_keeps_closing():
    auto = make_auto(mock.Mock())
    auto.d = mock.Mock()
    auto.d.app_current.return_value = {"package": "com.android.launcher3"}
    auto._pause = lambda *a: None
    with mock.patch.object(wa, "detect_screen", return_value=Screen.UNKNOWN), pytest.raises(JobError) as exc:
        auto._drive({Screen.PHONE_ENTRY}, what="digitar número")
    assert "não fica aberto" in exc.value.message
    assert auto.d.app_start.call_count == 3


def test_drive_waits_on_system_dialogs_instead_of_reopening():
    auto = make_auto(mock.Mock())
    auto.d = mock.Mock()
    auto.d.app_current.return_value = {"package": "com.google.android.gms"}
    auto._pause = lambda *a: None
    screens = iter([Screen.UNKNOWN, Screen.PHONE_ENTRY])
    with mock.patch.object(wa, "detect_screen", side_effect=lambda *a: next(screens)):
        auto._drive({Screen.PHONE_ENTRY}, what="digitar número")
    auto.d.app_start.assert_not_called()


def make_open_app(reset_app=False, pm_out="Success"):
    auto = make_auto(mock.Mock())
    auto.spec = make_spec(reset_app=reset_app)
    auto.d = mock.Mock()
    auto.d.app_current.return_value = {"package": "com.whatsapp"}
    auto._pause = lambda *a: None
    shell = []
    auto._shell = lambda cmd, timeout=30: (shell.append(cmd), pm_out)[1]
    return auto, shell


def test_open_app_clears_a_half_done_registration_and_goes_on():
    auto, shell = make_open_app()
    screens = iter([Screen.VERIFY_CODE, Screen.EULA, Screen.PHONE_ENTRY])
    with mock.patch.object(wa, "detect_screen", side_effect=lambda *a: next(screens)),             mock.patch.object(auto, "_common_actions", return_value={Screen.EULA: lambda: None}):
        auto.open_app()
    assert shell == [["pm", "clear", "com.whatsapp"]]
    assert auto.d.app_start.call_count == 2


def test_open_app_never_wipes_an_active_account_on_its_own():
    auto, shell = make_open_app()
    with mock.patch.object(wa, "detect_screen", return_value=Screen.CHATS), pytest.raises(JobError) as exc:
        auto.open_app()
    assert shell == [] and "Apagar o WhatsApp que já está neste telefone" in exc.value.message


def test_open_app_wipes_first_when_the_user_asked():
    auto, shell = make_open_app(reset_app=True)
    with mock.patch.object(wa, "detect_screen", return_value=Screen.PHONE_ENTRY):
        auto.open_app()
    assert shell == [["pm", "clear", "com.whatsapp"]]


def test_clear_app_failure_is_reported():
    auto, _ = make_open_app(reset_app=True, pm_out="Failed")
    with pytest.raises(JobError) as exc:
        auto.open_app()
    assert "Não consegui limpar" in exc.value.message


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
    auto.adb.shell.side_effect = ["curl\n", "", "<html>", "203.0.113.7\n"]
    assert auto.egress_ip() == "203.0.113.7"
    # Alterna os sites de IP a cada tentativa e pede a mensagem de erro do curl (-sS).
    urls = [c.args[0] for c in auto.adb.shell.call_args_list][1:]
    assert urls == [["curl", "-sS", "-m", "10", u] for u in ("https://api.ipify.org", "https://ifconfig.me/ip", "https://icanhazip.com")]
    auto.adb.shell.side_effect = ["curl: (7) Failed to connect to api.ipify.org port 443"] * 5
    assert auto.egress_ip() is None
    assert auto.last_egress_error.startswith("não conseguiu conectar")


def test_egress_ip_without_curl_uses_toybox_nc():
    auto = make_auto(mock.Mock())
    auto.adb = mock.Mock()
    response = "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n131.255.254.90"
    auto.adb.shell.side_effect = ["toybox-nc\n", response]
    assert auto.egress_ip() == "131.255.254.90"
    cmd = auto.adb.shell.call_args.args[0]
    assert cmd[:2] == ["sh", "-c"]
    assert "toybox nc -w 10 api.ipify.org 80" in cmd[2] and "Host: api.ipify.org" in cmd[2]
    # A ferramenta é procurada uma vez só por phone.
    auto.adb.shell.side_effect = [response]
    assert auto.egress_ip() == "131.255.254.90"


def test_egress_ip_with_wget_and_with_no_tool():
    auto = make_auto(mock.Mock())
    auto.adb = mock.Mock()
    auto.adb.shell.side_effect = ["wget\n", "203.0.113.9\n"]
    assert auto.egress_ip() == "203.0.113.9"
    assert auto.adb.shell.call_args.args[0] == ["wget", "-q", "-T", "10", "-O", "-", "http://api.ipify.org/"]
    bare = make_auto(mock.Mock())
    bare.adb = mock.Mock()
    bare.adb.shell.side_effect = ["none\n"]
    assert bare.egress_ip() is None
    assert bare.egress_tool_missing and "não tem curl, wget nem nc" in bare.last_egress_error
    assert bare.adb.shell.call_count == 1  # não fica tentando à toa

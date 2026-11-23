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
    (wa.UNDER_REVIEW_TEXT, ["Conta em análise", "Análise pedida em: 18 de novembro de 2026", "Account under review"]),
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
    assert business - comum == {Screen.USE_OTHER_NUMBER, Screen.BUSINESS_CATEGORY, Screen.BUSINESS_WELCOME,
                                Screen.BUSINESS_PROFILE_NEW, Screen.BUSINESS_NAME_REJECTED, Screen.BUSINESS_HOURS}


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
    # Conta antiga suspensa: ganha da tela de conversas que fica por baixo.
    (["Conta em análise", "Análise pedida em: 18 de novembro de 2026"], ["com.whatsapp:id/fab"], Screen.UNDER_REVIEW),
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


@pytest.mark.parametrize("dead", [Screen.UNDER_REVIEW, Screen.BANNED])
def test_open_app_wipes_an_old_account_that_is_banned_or_under_review(dead):
    auto, shell = make_open_app()
    screens = iter([dead, Screen.PHONE_ENTRY])
    with mock.patch.object(wa, "detect_screen", side_effect=lambda *a: next(screens)):
        auto.open_app()
    assert shell == [["pm", "clear", "com.whatsapp"]]
    assert auto.d.app_start.call_count == 2


def test_open_app_still_blocked_after_wiping_is_number_banned():
    auto, shell = make_open_app()
    with mock.patch.object(wa, "detect_screen", return_value=Screen.UNDER_REVIEW), pytest.raises(JobError) as exc:
        auto.open_app()
    assert exc.value.code == "number_banned" and shell == [["pm", "clear", "com.whatsapp"]]


def test_typing_puts_the_phone_keyboard_back():
    auto = make_auto(mock.Mock())
    auto.d = mock.Mock()
    auto.d.current_ime.return_value = "com.android.inputmethod.latin/.LatinIME"
    shell = []
    auto._shell = lambda cmd, timeout=30: (shell.append(cmd), "")[1]
    auto._type("123456", clear=True)
    auto.d.send_keys.assert_called_once_with("123456", clear=True)
    assert shell == [["ime", "set", "com.android.inputmethod.latin/.LatinIME"],
                     ["ime", "disable", "com.github.uiautomator/.AdbKeyboard"]]


# ------------------------------------------ tela desconhecida: memória e IA
class ScreensDevice(FakeDevice):
    """Tela desconhecida com um botão "Fechar aviso"; tocar nele leva ao perfil."""
    UNKNOWN_XML = ('<hierarchy><node text="Novidade do WhatsApp" resource-id="com.whatsapp:id/title" '
                   'class="android.widget.TextView" package="com.whatsapp" content-desc="" clickable="false" '
                   'scrollable="false" bounds="[0,0][1000,100]" /><node text="Fechar aviso" '
                   'resource-id="com.whatsapp:id/skip" class="android.widget.Button" package="com.whatsapp" '
                   'content-desc="" clickable="true" scrollable="false" bounds="[0,900][1000,1000]" /></hierarchy>')

    def __init__(self):
        super().__init__(texts=["Novidade do WhatsApp", "Fechar aviso"])
        self.clicks = []

    def dump_hierarchy(self):
        return self.UNKNOWN_XML if self.texts != ["Profile info"] else "<hierarchy />"

    def click(self, x, y):
        self.clicks.append((x, y))
        if 900 <= y <= 1000:
            self.texts = ["Profile info"]

    def app_current(self):
        return {"package": "com.whatsapp"}


def test_drive_asks_the_ai_on_an_unknown_screen_and_carries_on(tmp_path):
    from types import SimpleNamespace

    from app import device_automation
    from app.copilot import Decision
    from app.screen_learning import LearnedScreens

    copilot = SimpleNamespace(decide=mock.Mock(return_value=Decision("tocar", 1, "pular a novidade")))
    memory = LearnedScreens(str(tmp_path / "m.json"))
    auto = make_auto(mock.Mock())
    auto.resolver = device_automation.ScreenResolver(memory, copilot, "whatsapp", "job-1")
    auto.d = ScreensDevice()
    auto.screenshot = lambda: None
    with mock.patch.object(device_automation, "AI_GRACE_S", 0):
        assert auto._drive({Screen.PROFILE_NAME}, what="perfil") == Screen.PROFILE_NAME
    assert auto.d.clicks == [(500, 950)]
    goal = copilot.decide.call_args.args[0]
    assert goal.startswith("perfil.") and Screen.PROFILE_NAME.value in goal
    assert [item["action"]["rid"] for item in memory.all()] == ["skip"]


def test_drive_without_the_ai_still_hands_over_to_the_operator():
    auto = make_auto(mock.Mock())
    auto.d = ScreensDevice()
    clock = iter(range(0, 100_000, 30))  # cada leitura do relógio avança 30 s
    with mock.patch.object(time_module(), "monotonic", side_effect=lambda: next(clock)), \
            pytest.raises(JobError) as exc:
        auto._drive({Screen.PROFILE_NAME}, what="perfil", unknown_grace=20)
    assert exc.value.code == "unknown_screen" and "IA" not in exc.value.message


def time_module():
    from app import device_automation
    return device_automation.time


def test_blocked_sms_on_the_method_list_is_not_a_wait():
    # 18/11: "Receber SMS / Tente novamente em 3 horas" e "Ligação de voz" na mesma lista.
    texts = ["Receber SMS", "Tente novamente em 3 horas", "Ligação de voz", "Continuar"]
    assert wa.detect_screen(FakeDevice(texts), WA) == Screen.VERIFY_METHOD
    assert wa.detect_screen(FakeDevice(["Tente novamente em 5 minutos", "OK"]), WA) == Screen.WAIT_LIMIT


def test_blocked_sms_without_voice_call_is_a_wait():
    auto = make_auto(mock.Mock())
    auto.d = FakeDevice(["Receber SMS", "Tente novamente em 3 horas"])
    with mock.patch.object(wa, "first_text", return_value="Tente novamente em 3 horas"), \
            pytest.raises(JobError) as exc:
        auto._choose_verify_method()
    assert exc.value.code == "wait_limit" and "3 horas" in exc.value.message


# ------------------------------------- 23/11: WhatsApp Business com linha fixa (telas reais)
# Textos e resource-ids lidos com `screen_elements` no telefone "WhatsApp 3" durante o cadastro
# de (27) 3189-0428. As telas Compose do assistente do perfil usam a tag pura como id.
BIZ_ID = "com.whatsapp.w4b:id/"


def n(text="", rid="", cls="android.widget.TextView", clickable=False, checked=None, desc="", key=None,
      children=(), bare=False):
    full = rid if (bare or not rid or ":" in rid) else BIZ_ID + rid
    return {"text": text, "rid": full, "cls": cls, "clickable": clickable, "checked": checked, "desc": desc,
            "key": key, "children": list(children)}


def button(text, rid, bare=False):
    return n(text, rid, "android.widget.Button", True, bare=bare)


class FlowDevice:
    """Aparelho falso que monta o XML de cada tela e muda de tela conforme o que é tocado.

    `transitions[tela][chave]` diz a próxima tela (ou uma função do aparelho que a devolve); a
    chave de um elemento é `key`, senão o texto, senão a descrição, senão o id curto. Tocar num
    elemento sem transição deixa a tela como está. Digitar pelo teclado usa a chave "__keys__".
    """

    def __init__(self, screens, transitions, start):
        self.screens, self.transitions, self.current = screens, transitions, start
        self.taps, self.typed, self.fields, self.presses = [], [], {}, []

    # --- elementos
    def _flat(self):
        out = []

        def walk(node, top, parent_key):
            key = node["key"] or parent_key or node["text"] or node["desc"] or node["rid"].rsplit("/", 1)[-1]
            out.append((node, top, key))
            for child in node["children"]:
                walk(child, top, key)

        for i, node in enumerate(self.screens[self.current]):
            walk(node, i, None)
        return out

    @staticmethod
    def _match(node, sel):
        for k, v in sel.items():
            if k == "textMatches":
                ok = re.fullmatch(v, node["text"]) is not None
            elif k == "resourceId":
                ok = node["rid"] == v
            elif k == "resourceIdMatches":
                ok = bool(node["rid"]) and re.fullmatch(v, node["rid"]) is not None
            elif k == "descriptionMatches":
                ok = re.fullmatch(v, node["desc"]) is not None
            elif k == "className":
                ok = node["cls"] == v
            elif k == "checked":
                ok = node["checked"] is v
            elif k in ("scrollable", "clickable"):
                ok = node.get(k, False) == v
            else:
                raise AssertionError(f"seletor não suportado no teste: {k}")
            if not ok:
                return False
        return True

    def _go(self, key):
        self.taps.append(key)
        nxt = self.transitions.get(self.current, {}).get(key)
        if nxt is not None:
            self.current = nxt(self) if callable(nxt) else nxt

    def __call__(self, **sel):
        hit = next(((node, key) for node, _, key in self._flat() if self._match(node, sel)), None)
        dev = self
        obj = mock.Mock(exists=hit is not None)
        obj.wait.return_value = hit is not None
        obj.info = {"enabled": True}
        if hit:
            node, key = hit
            obj.get_text.return_value = node["text"]
            obj.click.side_effect = lambda: dev._go(key)

            def set_text(value):
                name = node["rid"].rsplit("/", 1)[-1] or key
                dev.typed.append((name, value))
                dev.fields[name] = value
            obj.set_text.side_effect = set_text
        return obj

    # --- aparelho
    def dump_hierarchy(self):
        from xml.sax.saxutils import quoteattr

        def render(node, top):
            attrs = (f'text={quoteattr(node["text"])} resource-id={quoteattr(node["rid"])} class="{node["cls"]}" '
                     f'package="com.whatsapp.w4b" content-desc={quoteattr(node["desc"])} '
                     f'clickable="{str(node["clickable"]).lower()}" checked="{str(bool(node["checked"])).lower()}" '
                     f'scrollable="false" bounds="[0,{top * 100}][1080,{top * 100 + 90}]"')
            inner = "".join(render(c, top) for c in node["children"])
            return f"<node {attrs}>{inner}</node>"

        body = "".join(render(node, i) for i, node in enumerate(self.screens[self.current]))
        return f'<?xml version="1.0"?><hierarchy rotation="0">{body}</hierarchy>'

    def click(self, x, y):
        top = y // 100
        hit = next((key for node, t, key in self._flat() if t == top), None)
        assert hit is not None, f"toque fora de qualquer elemento em ({x}, {y})"
        self._go(hit)

    def send_keys(self, text, clear=False):
        self.typed.append(("teclado", text))
        self._go("__keys__")

    def current_ime(self):
        return "com.google.android.inputmethod.latin/.LatinIME"

    def press(self, key):
        self.presses.append(key)

    def app_current(self):
        return {"package": "com.whatsapp.w4b"}

    def window_size(self):
        return 1080, 2400


def method_row(name, key, checked):
    return n(cls="android.widget.LinearLayout", clickable=True, key=key, children=[
        n(cls="android.widget.RadioButton", checked=checked),
        n(name, "reg_method_name"),
        n("Enviar código para +55 27 3189-0428", "reg_method_details_container"),
    ])


def method_sheet(sms="Receber SMS", checked=None):
    return [
        n("Selecione o método de confirmação", "request_otp_code_bottom_sheet_title"),
        method_row(sms, "sms", checked == "sms"),
        method_row("Ligação de voz", "voice", checked == "voice"),
        button("Continuar", "continue_button"),
    ]


BIZ_NAME_SCREEN = [
    n("Crie seu perfil comercial"),
    n("Nome comercial"),
    n("", "biz_name_field", "android.widget.EditText", True, bare=True),
    button("Avançar", "next_button", bare=True),
]
LANDLINE_SCREENS = {
    "confirm_send": [
        n("Confirmar seu número", "title"),
        n("Enviaremos um código de 6 dígitos por SMS para +55 27 3189-0428", "description"),
        button("Continuar", "primary_button"),
        button("Usar outra forma de verificação", "secondary_button"),
    ],
    "sheet": method_sheet(),
    "sheet_voice": method_sheet(checked="voice"),
    "sheet_sms": method_sheet(checked="sms"),
    "sms_failed": [
        n("Não foi possível enviar um SMS para seu número", "android:id/alertTitle"),
        n("Confira o número de telefone. Se estiver correto, tente novamente em 1 hora ou use outro método de "
          "verificação.", "android:id/message"),
        button("OK", "android:id/button2"),
        button("Usar outro método", "android:id/button1"),
    ],
    "sheet_new_sms": method_sheet("Receber novo SMS"),
    "sheet_new_sms_voice": method_sheet("Receber novo SMS", checked="voice"),
    "code_voice": [
        n("Insira o código de 6 dígitos informado por ligação telefônica para +55 27 3189-0428.",
          "send_code_description"),
        n("", "verify_sms_code_input", "android.widget.EditText", True),
    ],
    "passkey": [
        n("Não é possível criar a senha de acesso", "title"),
        n("Para criar uma senha de acesso, você precisa fazer login na sua Conta do Google neste aparelho.", "subtitle"),
        button("Ok", "continue_button"),
    ],
    "allow_access": [
        n("Permitir acesso", "headline"),
        n("Permita o acesso aos seus contatos e à sua mídia para conversar e enviar fotos.", "description"),
        button("Continuar", "primary_button"),
        button("Pular", "secondary_button"),
    ],
    "restore": [
        n("Restaurar um backup", "permission_title"),
        n("Para localizar e restaurar o backup salvo no armazenamento do Google, permita que o WhatsApp acesse seus "
          "contatos.", "permission_message"),
        button("Cancelar", "cancel"),
        button("Continuar", "submit"),
    ],
    "biz_name": BIZ_NAME_SCREEN,
}


def landline_auto(start, transitions, screens=LANDLINE_SCREENS, **spec):
    auto = make_auto(mock.Mock())
    auto.spec = make_spec(app="business", country_code="55", number=spec.pop("number", "2731890428"), **spec)
    auto.app = BIZ
    auto.d = FlowDevice(screens, transitions, start)
    auto._shell = lambda *a, **k: ""
    return auto


@pytest.mark.parametrize("cc,number,landline", [
    ("55", "2731890428", True),     # (27) 3189-0428, a linha da Fluke
    ("55", "1133334444", True),
    ("55", "5121212121", True),
    ("55", "27981522584", False),   # celular: 9 dígitos começando com 9
    ("55", "1199998888", False),    # 8 dígitos começando com 9: celular antigo, não fixo
    ("55", "552731890428", True),   # veio com o código do país
    ("1", "2731890428", False),
])
def test_br_landline(cc, number, landline):
    assert wa.is_br_landline(cc, number) is landline


@pytest.mark.parametrize("texts,expected", [
    (["Confirmar seu número", "Enviaremos um código de 6 dígitos por SMS para +55 27 3189-0428", "Continuar",
      "Usar outra forma de verificação"], Screen.CONFIRM_SEND),
    (["Selecione o método de confirmação", "Receber SMS", "Enviar código para +55 27 3189-0428", "Ligação de voz",
      "Continuar"], Screen.VERIFY_METHOD),
    (["Receber novo SMS", "Ligação de voz", "Continuar"], Screen.VERIFY_METHOD),
    # "tente novamente em 1 hora" casa a espera, mas o diálogo é o SMS recusado da linha fixa.
    (["Não foi possível enviar um SMS para seu número", "Confira o número de telefone. Se estiver correto, tente "
      "novamente em 1 hora ou use outro método de verificação.", "OK", "Usar outro método"], Screen.SMS_FAILED),
    (["Não é possível criar a senha de acesso", "Para criar uma senha de acesso, você precisa fazer login na sua "
      "Conta do Google...", "Ok"], Screen.PASSKEY),
    (["Permitir acesso", "Permita o acesso aos seus contatos e à sua mídia.", "Continuar", "Pular"],
     Screen.OPTIONAL_PROMPT),
    (["Restaurar um backup", "Cancelar"], Screen.RESTORE_BACKUP),
    (["Crie seu perfil comercial", "Nome comercial", "Avançar"], Screen.BUSINESS_PROFILE_NEW),
    (["O nome comercial não segue nossas diretrizes. Edite o nome e tente de novo.", "Editar",
      "Crie seu perfil comercial", "Avançar"], Screen.BUSINESS_NAME_REJECTED),
    (["Selecionar a categoria da sua empresa", "Outras empresas", "Avançar"], Screen.BUSINESS_CATEGORY),
    (["Adicionar horário de atendimento", "Sempre aberta", "Avançar"], Screen.BUSINESS_HOURS),
    (["Adicionar uma foto do perfil", "Pular"], Screen.OPTIONAL_PROMPT),
    (["Mais formas de encontrar sua empresa", "Endereço", "Site", "Pular"], Screen.OPTIONAL_PROMPT),
    (["Adicionar descrição da empresa", "Pular"], Screen.OPTIONAL_PROMPT),
    (["Adicione seu e-mail", "Pular"], Screen.OPTIONAL_PROMPT),
    (["Crie seu catálogo", "Agora não"], Screen.OPTIONAL_PROMPT),
    (["Ferramentas", "Conversas", "Ligações"], Screen.CHATS),
])
def test_business_landline_screens(texts, expected):
    assert wa.detect_screen(FakeDevice(texts), BIZ) == expected


def test_new_business_screens_by_compose_tag():
    assert wa.detect_screen(FakeDevice(ids=["biz_name_field"]), BIZ) == Screen.BUSINESS_PROFILE_NEW
    assert wa.detect_screen(FakeDevice(ids=["biz_hours_always_open_option"]), BIZ) == Screen.BUSINESS_HOURS
    assert wa.detect_screen(FakeDevice(ids=[BIZ_ID + "request_otp_code_bottom_sheet_title"]), BIZ) == Screen.VERIFY_METHOD
    # Perfil antigo: o rótulo "Selecionar categoria" do campo não pode virar a tela de categoria.
    assert wa.detect_screen(FakeDevice(["Selecionar categoria"], [BIZ_ID + "business_name"]), BIZ) == Screen.PROFILE_NAME
    # No WhatsApp comum, "Ferramentas" não é a tela principal.
    assert wa.detect_screen(FakeDevice(["Ferramentas"]), WA) == Screen.UNKNOWN


def test_find_method_row_returns_the_clickable_parent():
    xml = FlowDevice(LANDLINE_SCREENS, {}, "sheet_voice").dump_hierarchy()
    voice = wa.find_method_row(xml, wa.CALL_METHOD_TEXT)
    sms = wa.find_method_row(xml, wa.SMS_METHOD_TEXT)
    assert voice == wa.MethodRow((540, 245), True)  # a linha (LinearLayout) inteira, 3ª da tela
    assert sms == wa.MethodRow((540, 145), False)
    assert wa.find_method_row("<hierarchy/>", wa.SMS_METHOD_TEXT) is None


def test_landline_goes_straight_to_the_voice_call():
    auto = landline_auto("confirm_send", {
        "confirm_send": {"Usar outra forma de verificação": "sheet", "Continuar": "sms_failed"},
        "sheet": {"voice": "sheet_voice", "sms": "sheet_sms"},
        "sheet_voice": {"Continuar": "code_voice"},
    })
    auto.enter_number()
    assert auto.d.current == "code_voice"
    assert auto.d.taps == ["Usar outra forma de verificação", "voice", "Continuar"]  # nunca o SMS
    assert auto.code_channel == "voice"


def test_refused_sms_dialog_switches_to_the_voice_call():
    # O que aconteceu de verdade: SMS pedido, diálogo de SMS recusado, "Usar outro método" e voz.
    auto = landline_auto("confirm_send", {
        "confirm_send": {"Continuar": "sms_failed"},
        "sms_failed": {"Usar outro método": "sheet_new_sms", "OK": "confirm_send"},
        "sheet_new_sms": {"voice": "sheet_new_sms_voice"},
        "sheet_new_sms_voice": {"Continuar": "code_voice"},
    }, verification="sms")
    auto.enter_number()
    assert auto.d.taps == ["Continuar", "Usar outro método", "voice", "Continuar"]
    assert auto.code_channel == "voice"


def test_a_tap_that_does_not_select_the_row_falls_back_to_the_text():
    auto = landline_auto("sheet", {
        "sheet": {"voice": lambda d: "sheet_voice" if d.taps.count("voice") == 2 else "sheet"},
        "sheet_voice": {"Continuar": "code_voice"},
    })
    auto._choose_verify_method()
    assert auto.d.taps == ["voice", "voice", "Continuar"] and auto.d.current == "code_voice"


def test_blocked_sms_chooses_the_voice_call():
    # 18/11: "Receber SMS / Tente novamente em 3 horas" e "Ligação de voz" na mesma lista (celular).
    screens = {**LANDLINE_SCREENS, "blocked": [*method_sheet(), n("Tente novamente em 3 horas")]}
    auto = landline_auto("blocked", {"blocked": {"voice": "sheet_voice"}, "sheet_voice": {"Continuar": "code_voice"}},
                         screens=screens, number="27981522584")
    auto._choose_verify_method()
    assert auto.d.taps == ["voice", "Continuar"] and auto.code_channel == "voice"


def test_mobile_number_keeps_the_sms():
    auto = landline_auto("confirm_send", {"confirm_send": {"Continuar": "code_voice"}}, number="27981522584")
    assert auto.preferred_method() == "sms"
    auto.enter_number()
    assert auto.d.taps == ["Continuar"]
    # A tela do código diz "informado por ligação telefônica": a mensagem do job acompanha.
    assert auto.code_channel == "voice"


def test_code_accepted_then_passkey_access_and_backup_screens():
    auto = landline_auto("code_voice", {
        "code_voice": {"__keys__": "passkey"},
        "passkey": {"Ok": "allow_access"},
        "allow_access": {"Pular": "restore"},
        "restore": {"Cancelar": "biz_name"},
    })
    assert auto.submit_sms_code("123456").accepted
    assert auto.d.taps == ["verify_sms_code_input", "__keys__", "Ok", "Pular", "Cancelar"]
    assert auto.past_verification()


WIZARD_SCREENS = {
    "biz_name": BIZ_NAME_SCREEN,
    "rejected": [
        n("O nome comercial não segue nossas diretrizes. Edite o nome e tente de novo.", "android:id/message"),
        button("Editar", "android:id/button1"),
        *BIZ_NAME_SCREEN,
    ],
    "category": [
        n("Selecionar a categoria da sua empresa"),
        n("Outras empresas", cls="android.widget.CheckBox", clickable=True, checked=True),
        button("Avançar", "next_button", bare=True),
    ],
    "hours": [
        n("Adicionar horário de atendimento"),
        n("Sempre aberta", "biz_hours_always_open_option", clickable=True, bare=True),
        n("Horários específicos", clickable=True),
        button("Avançar", "next_button", bare=True),
    ],
    "hours_days": [
        n("Adicionar horário de atendimento"),
        *[n(day) for day in ("Domingo", "Segunda-feira", "Terça-feira", "Quarta-feira", "Quinta-feira",
                             "Sexta-feira", "Sábado")],
        n("Aberta 24 horas"),
        button("Avançar", "next_button", bare=True),
    ],
    "photo": [n("Adicionar uma foto do perfil"), button("Pular", "skip_button", bare=True)],
    "more": [n("Mais formas de encontrar sua empresa"), n("Endereço"), n("Site"), button("Pular", "skip_button", bare=True)],
    "description": [n("Adicionar descrição da empresa"), button("Pular", "skip_button", bare=True)],
    "email": [n("Adicione seu e-mail", "toolbar_title_text_v2"), button("Pular", "register_email_skip")],
    "catalog": [n("Crie seu catálogo", "top_container_title"), button("Agora não", "onboarding_decline_button")],
    "home_tools": [n("Ferramentas", clickable=True), n("Conversas", clickable=True), n("Ligações", clickable=True)],
}
WIZARD_SCREENS["hours_chosen"] = WIZARD_SCREENS["hours"]
WIZARD_FLOW = {
    "biz_name": {"Avançar": lambda d: "rejected" if d.fields.get("biz_name_field") == "PREVITAS" else "category"},
    "rejected": {"Editar": "biz_name"},
    "category": {"Avançar": "hours"},
    "hours": {"Sempre aberta": "hours_chosen"},  # sem escolher, "Avançar" não anda
    "hours_chosen": {"Avançar": "hours_days"},
    "hours_days": {"Avançar": "photo"},
    "photo": {"Pular": "more"},
    "more": {"Pular": "description"},
    "description": {"Pular": "email"},
    "email": {"Pular": "catalog"},
    "catalog": {"Agora não": "home_tools"},
}


def test_business_profile_wizard_fixes_the_name_and_reaches_the_home_screen():
    auto = landline_auto("biz_name", WIZARD_FLOW, screens=WIZARD_SCREENS)
    warning = auto.save_profile("PREVITAS", None, None)
    assert auto.d.current == "home_tools"
    assert auto.d.typed == [("biz_name_field", "PREVITAS"), ("biz_name_field", "Previtas")]
    assert "Outras empresas" not in auto.d.taps  # já vinha marcada: tocar desmarcaria
    assert auto.d.taps.count("Pular") == 4 and "Agora não" in auto.d.taps
    assert warning and '"PREVITAS"' in warning and '"Previtas"' in warning


def test_business_name_rejected_twice_asks_the_operator():
    flow = {**WIZARD_FLOW, "biz_name": {"Avançar": "rejected"}}
    auto = landline_auto("biz_name", flow, screens=WIZARD_SCREENS)
    with pytest.raises(JobError) as exc:
        auto.save_profile("PREVITAS", None, None)
    assert exc.value.code == "unknown_screen" and '"Previtas"' in exc.value.message
    assert auto.d.typed == [("biz_name_field", "PREVITAS"), ("biz_name_field", "Previtas")]


def test_business_name_variants():
    assert wa.business_name_variants("PREVITAS") == ["PREVITAS", "Previtas"]
    assert wa.business_name_variants("  ACME   SAÚDE ") == ["ACME SAÚDE", "Acme Saúde"]
    assert wa.business_name_variants("Previtas") == ["Previtas"]


PAIR_SCREENS = {
    "home_tools": [n("Ferramentas", clickable=True), n("Conversas", clickable=True), n("Ligações", clickable=True),
                   n(desc="Mais opções", cls="android.widget.ImageView", clickable=True, key="menu")],
    "menu_tools": [n("Configurações"), n("Ajuda")],
    "home_chats": [n("Ferramentas", clickable=True), n("Conversas", clickable=True), n("", "fab", clickable=True),
                   n(desc="Mais opções", cls="android.widget.ImageView", clickable=True, key="menu")],
    "menu_chats": [n("Novo grupo"), n("Dispositivos conectados"), n("Configurações")],
    "linked": [n("Dispositivos conectados"), button("Conectar dispositivo", "link_device_button")],
    "qr": [n("Escanear QR code"), n("Conectar com número de telefone", "bottom_banner", clickable=True)],
    "enter_code": [n("Insira o código"), *[n("", cls="android.widget.EditText", desc=f"campo {i} de 8", clickable=True)
                                           for i in range(1, 9)]],
    "device_name": [n("Nome do dispositivo"), n("", "device_name_edit_text", "android.widget.EditText", True),
                    button("Salvar", "save_device_name_btn")],
    "linked_done": [n("Dispositivos conectados"), n("1 de 4 dispositivos conectado"), n("ZapLiga")],
}


def test_business_pairing_goes_through_the_chats_tab_and_names_the_device():
    auto = landline_auto("home_tools", {
        "home_tools": {"Conversas": "home_chats", "menu": "menu_tools"},
        "home_chats": {"menu": "menu_chats"},
        "menu_chats": {"Dispositivos conectados": "linked"},
        "linked": {"Conectar dispositivo": "qr"},
        "qr": {"Conectar com número de telefone": "enter_code"},
        "enter_code": {"__keys__": "device_name"},
        "device_name": {"Salvar": "linked_done"},
    }, screens=PAIR_SCREENS)
    auto.open_link_screen()
    assert auto.d.current == "enter_code"
    note = auto.enter_pair_code("ABCD1234")
    assert auto.d.typed == [("teclado", "ABCD1234"), ("device_name_edit_text", "ZapLiga")]
    assert auto.d.current == "linked_done" and "aceito" in note and "ZapLiga" in note


def test_pairing_wrong_code_is_pair_failed():
    screens = {**PAIR_SCREENS, "wrong": [n("Código incorreto"), button("OK", "android:id/button1")]}
    auto = landline_auto("enter_code", {"enter_code": {"__keys__": "wrong"}}, screens=screens)
    with pytest.raises(JobError) as exc:
        auto.enter_pair_code("ABCD1234")
    assert exc.value.code == "pair_failed"

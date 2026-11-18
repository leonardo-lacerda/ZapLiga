"""Telas do WhatsApp e do WhatsApp Business: seletores, detecção e helpers de clique.

Os dois apps têm a mesma estrutura de telas; o que muda é o pacote (e portanto o prefixo
dos resource-ids) e algumas telas extras do Business. Por isso os seletores são gerados a
partir do app escolhido.

O idioma do phone pode ser inglês OU português (pt-BR): todo seletor de texto é uma regex
que casa os dois. Os apóstrofos aparecem como ' ou ’ conforme a versão, por isso `.?`.
O uiautomator usa `Matcher.matches()` do Java (casa a string inteira), então as regexes
"contém" usam `.*` nas pontas.

IMPORTANTE: os seletores mudam entre versões do app. Quando um job para em
`unknown_screen`, o worker grava o XML da tela (sem o texto dos campos) em WORKER_DEBUG_DIR.
Ache o resource-id certo ali e ajuste build_screens().
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import Enum
from functools import lru_cache
from typing import Any


# O diálogo de permissão é do sistema: com.android.permissioncontroller no AOSP e
# com.google.android.permissioncontroller em builds com Google Play.
PERMISSION_ID_PREFIX = r"com\.(google\.)?android\.permissioncontroller:id/"
LOCATION_PERMISSION_TEXT = re.compile(r"(?is).*(location|localiza).*")


@dataclass(frozen=True)
class WhatsAppApp:
    key: str          # chave do contrato: "whatsapp" | "business"
    label: str
    package: str
    is_business: bool

    @property
    def wid(self) -> str:
        """Prefixo dos resource-ids deste app."""
        return self.package + ":id/"


APPS = {
    "whatsapp": WhatsAppApp("whatsapp", "WhatsApp", "com.whatsapp", is_business=False),
    "business": WhatsAppApp("business", "WhatsApp Business", "com.whatsapp.w4b", is_business=True),
}


class Screen(Enum):
    BANNED = "banido"
    WAIT_LIMIT = "aguardar (muitas tentativas)"
    NO_INTERNET = "sem conexão"
    PHONE_HINT = "seletor de número do Google"
    PERMISSION = "pedido de permissão"
    VERIFY_CODE = "digitar código"
    CONFIRM_NUMBER = "confirmar número"
    USE_OTHER_NUMBER = "escolher número (Business)"
    PHONE_ENTRY = "digitar número"
    VERIFY_METHOD = "escolher SMS/ligação"
    MISSED_CALL_INTRO = "verificar por ligação não atendida"
    EULA = "termos (concordar e continuar)"
    RESTORE_BACKUP = "restaurar backup"
    BUSINESS_CATEGORY = "categoria da empresa"
    PROFILE_NAME = "perfil (nome e foto)"
    CHATS = "conversas (registrado)"
    INITIALIZING = "inicializando"
    OPTIONAL_PROMPT = "sugestão opcional (pular)"
    UNKNOWN = "desconhecida"


# ------------------------------------------------------------- textos (EN + pt-BR)
SKIP_TEXT = r"(?i)^(not now|agora não|skip|pular|later|mais tarde|no,? thanks|não,? obrigad[oa])$"
CONFIRM_TEXT = r"(?i)^(yes|sim|ok|confirm|confirmar|continue|continuar)$"
# Tela do código: pedir de novo. Enquanto o relógio corre o texto vem com a contagem
# ("Reenviar SMS em 0:45"); no WhatsApp novo as opções ficam atrás de "Não recebeu o código?".
RESEND_SMS_TEXT = r"(?is)^(resend sms|reenviar( o)? sms|send sms again|enviar sms (de )?novamente)( .*)?$"
CALL_ME_TEXT = r"(?is)^(call me|ligar para mim|me ligue|ligue-me|receber (uma )?liga[cç][aã]o)( .*)?$"
DIDNT_RECEIVE_TEXT = r"(?is).*(didn.?t (get|receive) (the |a |your )?code|n[aã]o recebeu (o |um )?c[oó]digo).*"
COUNTDOWN = re.compile(r"\d{1,2}:\d{2}")

# Janela depois de digitar o número; o texto muda entre versões ("O número está certo?",
# "Este número está correto?", "Is this the correct number?"...). O "Sim" pede o SMS.
CONFIRM_NUMBER_TEXT = (
    r"(?is).*(is this (the )?(correct|right)( phone)? number|is (this|the|your) (phone )?number (correct|right)"
    r"|n[uú]mero( de telefone)? est[aá] (certo|correto)|confirm.*number|confirme o n[uú]mero).*"
)
NEXT_TEXT = r"(?i)^(next|avançar|próximo|done|concluir|salvar|save)$"
OTHER_NUMBER_TEXT = r"(?i)^(use a different number|usar (um )?outro número)$"
EULA_TEXT = r"(?i)^(agree and continue|concordar e continuar|aceitar e continuar)$"
SMS_METHOD_TEXT = r"(?i)^(receive sms|receber (um |o c[oó]digo por )?sms|send sms|enviar sms|sms|text message|mensagem de texto)$"
CALL_METHOD_TEXT = r"(?i)^(call me|me ligue|ligar|receber (uma )?liga[cç][aã]o( de voz)?|liga[cç][aã]o de voz|voice call|receive (a )?(voice )?call)$"
# "Permitir acesso": o WhatsApp quer verificar ligando para o número e lendo o registro de
# chamadas. O chip não está no phone da nuvem, então isso nunca funciona: pede outra forma.
OTHER_VERIFY_TEXT = (
    r"(?i)^(usar outra forma de verifica[cç][aã]o|outra forma de verifica[cç][aã]o|verificar de outra forma"
    r"|use (an)?other (verification )?(method|option)|verify another way|try another way|other verification options?)$"
)

BANNED_TEXT = r"(?is).*(not allowed to use whatsapp|não (tem permissão|pode) usar o whatsapp|is banned|foi banido|banned from|banido).*"
WAIT_LIMIT_TEXT = r"(?is).*(wait \d+|try again in \d|aguarde \d+|tente novamente (em|daqui a) \d).*"
# "Couldn't connect. Please try again later." / "WhatsApp service status unavailable."
NO_INTERNET_TEXT = (
    r"(?is).*(couldn.?t connect|could not connect|unable to connect|não foi possível (se )?conectar"
    r"|service status unavailable|status do serviço.*indisponível|serviço.*indisponível"
    r"|check your (phone.?s )?(internet )?connection|verifique (a|sua) conexão).*"
)
# Bottom sheet "Choose a phone number" do Google (Phone Number Hint). Nunca escolher o
# número sugerido: é o SIM falso do cloud phone.
PHONE_HINT_TITLE = r"(?i)^(choose a phone number|escolha um número( de telefone)?|escolher (um )?número( de telefone)?)$"
NONE_OF_ABOVE_TEXT = r"(?i)^(none of the above|nenhuma das (opções )?(acima|anteriores)|nenhum dos (números )?acima)$"
CLOSE_DESC = r"(?i)^(close|fechar|cancel|cancelar|dismiss|dispensar)$"

WRONG_CODE_TEXT = (
    r"(?is).*(wrong code|incorrect code|invalid code|code you entered.*(incorrect|wrong|invalid)"
    r"|código (incorreto|errado|inválido)|o código .*(incorreto|errado|inválido)).*"
)
INITIALIZING_TEXT = r"(?is)^(initializing|inicializando|please wait|aguarde|loading|carregando).*"
PROFILE_TITLE = (
    r"(?i)^(profile info|informações do perfil|informações de perfil|business info"
    r"|business profile|informações da empresa|perfil comercial)$"
)
CATEGORY_OTHER = r"(?i)^(other|other business|outros?|outros negócios|outra empresa)$"

# Conectar aparelho (pareamento por código)
MORE_OPTIONS = {"descriptionMatches": r"(?i)^(more options|mais opções)$"}
LINKED_DEVICES = {"textMatches": r"(?i)^(linked devices|aparelhos conectados|dispositivos (conectados|vinculados))$"}
LINK_A_DEVICE = {"textMatches": r"(?i)^(link a device|link device|conectar (um )?aparelho|vincular (um )?(aparelho|dispositivo))$"}
LINK_WITH_NUMBER = {"textMatches": (
    r"(?is).*(link with phone number|conectar com (o )?(número de telefone|telefone|número)"
    r"|vincular com (o )?número).*"
)}
PAIR_CODE_HINT = {"textMatches": r"(?is).*(enter (the )?code|insira o código|digite o código|inserir código|código exibido|code shown).*"}
EDIT_TEXT = {"className": "android.widget.EditText"}
PAIR_ERROR_TEXT = (
    r"(?is).*(couldn.?t link|could not link|não foi possível (conectar|vincular)|invalid code|código inválido"
    r"|incorrect code|código incorreto|code (has )?expired|código (expirou|expirado)).*"
)
DISMISS_OK_TEXT = r"(?i)^(ok|got it|entendi|ok, entendi)$"

# Foto do perfil (melhor esforço; não verificado em aparelho real)
GALLERY_TEXT = r"(?i)^(gallery|galeria|choose from gallery|escolher da galeria)$"
PICTURES_FOLDER_TEXT = r"(?i)^(pictures|imagens|fotos|all photos|todas as fotos|recent|recentes)$"
CROP_DONE_TEXT = r"(?i)^(done|concluir|ok|crop|cortar|salvar|save)$"


def _app_ids(app: WhatsAppApp, *names: str) -> str:
    return re.escape(app.wid) + "(" + "|".join(names) + ")"


@lru_cache(maxsize=None)
def build_screens(app: WhatsAppApp) -> tuple[tuple[Screen, tuple[dict, ...]], ...]:
    """Seletores de cada tela para o app dado.

    Ordem importa: telas "de erro" e diálogos que ficam por cima vêm primeiro.
    Cada tela é reconhecida se QUALQUER um dos seletores existir.
    """
    w = app.wid
    screens: list[tuple[Screen, tuple[dict, ...]]] = [
        (Screen.BANNED, ({"textMatches": BANNED_TEXT},)),
        (Screen.WAIT_LIMIT, ({"textMatches": WAIT_LIMIT_TEXT},)),
        (Screen.NO_INTERNET, ({"textMatches": NO_INTERNET_TEXT},)),
        (Screen.PHONE_HINT, ({"textMatches": PHONE_HINT_TITLE}, {"textMatches": NONE_OF_ABOVE_TEXT})),
        (Screen.PERMISSION, (
            {"resourceIdMatches": PERMISSION_ID_PREFIX + r"permission_(allow|deny).*"},
            {"resourceIdMatches": r"com\.android\.packageinstaller:id/permission_(allow|deny).*"},
        )),
        (Screen.VERIFY_CODE, ({"resourceId": w + "verify_sms_code_input"}, {"resourceId": w + "code_input"})),
        (Screen.CONFIRM_NUMBER, ({"textMatches": CONFIRM_NUMBER_TEXT},)),
    ]
    if app.is_business:
        # Com o WhatsApp comum instalado, o Business oferece reaproveitar o mesmo número.
        # Queremos sempre o número do job.
        screens.append((Screen.USE_OTHER_NUMBER, ({"textMatches": OTHER_NUMBER_TEXT},)))
    screens += [
        (Screen.PHONE_ENTRY, ({"resourceId": w + "registration_phone"},)),
        (Screen.VERIFY_METHOD, ({"textMatches": SMS_METHOD_TEXT}, {"textMatches": CALL_METHOD_TEXT})),
        # Depois da lista de métodos: se a lista também oferecer "outra forma", escolhe o SMS nela.
        (Screen.MISSED_CALL_INTRO, ({"textMatches": OTHER_VERIFY_TEXT},)),
        (Screen.EULA, ({"resourceId": w + "eula_accept"}, {"textMatches": EULA_TEXT})),
        (Screen.RESTORE_BACKUP, ({"textMatches": r"(?is).*(restore backup|restaurar backup|restaurar conversas|restore chats).*"},)),
    ]
    if app.is_business:
        screens.append((Screen.BUSINESS_CATEGORY, (
            {"textMatches": r"(?is).*((choose|select) (a )?(business )?category|(escolha|selecione) (uma )?categoria).*"},
        )))
    screens += [
        (Screen.PROFILE_NAME, (
            {"resourceId": w + "registration_name"},
            {"resourceId": w + "business_name"},
            {"textMatches": PROFILE_TITLE},
        )),
        (Screen.CHATS, ({"resourceId": w + "fab"}, {"resourceId": w + "conversations_row_contact_name"})),
        (Screen.INITIALIZING, ({"textMatches": INITIALIZING_TEXT},)),
        (Screen.OPTIONAL_PROMPT, ({"textMatches": SKIP_TEXT},)),
    ]
    return tuple(screens)


def detect_screen(d: Any, app: WhatsAppApp) -> Screen:
    for screen, selectors in build_screens(app):
        if any(d(**sel).exists for sel in selectors):
            return screen
    return Screen.UNKNOWN


def click_first(d: Any, *selectors: dict, timeout: float = 5) -> bool:
    for sel in selectors:
        if d(**sel).wait(timeout=timeout):
            d(**sel).click()
            return True
    return False


def first_text(d: Any, selector: dict) -> str | None:
    """Texto do primeiro elemento que casa (para mensagens ao usuário)."""
    try:
        obj = d(**selector)
        if obj.exists:
            return (obj.get_text() or "").strip() or None
    except Exception:
        return None
    return None


def parse_installed(pm_output: str, app: WhatsAppApp) -> bool:
    # `pm list packages com.whatsapp` também casa com com.whatsapp.w4b; por isso a
    # comparação é por linha exata.
    return f"package:{app.package}" in pm_output.split()


_EDIT_TEXT_NODE = re.compile(r'(<node\b[^>]*class="android\.widget\.EditText"[^>]*>)')
_TEXT_ATTR = re.compile(r'\btext="[^"]*"')


def scrub_hierarchy(xml: str) -> str:
    """Apaga o texto dos campos editáveis antes de gravar o XML de diagnóstico
    (um código SMS ou de pareamento digitado não pode ir para o disco)."""
    return _EDIT_TEXT_NODE.sub(lambda m: _TEXT_ATTR.sub('text=""', m.group(1)), xml)


# --------------------------------------------------------------- permissões
def handle_permission(d: Any) -> None:
    """Responde ao diálogo de permissão do Android que estiver na tela.

    Vale para os dois apps: o diálogo é do sistema, não do WhatsApp.
    Botões disponíveis (resource-ids do permissioncontroller):
      ...:id/permission_allow_button                 -> Permitir
      ...:id/permission_allow_foreground_only_button -> Só durante o uso
      ...:id/permission_deny_button                  -> Não permitir
    O texto do diálogo (qual permissão está sendo pedida) fica em ...:id/permission_message.

    Regra: nega localização (o cadastro não precisa e ela não deve contradizer o IP do PC)
    e permite o resto (notificações, contatos, fotos, câmera), preferindo "só durante o
    uso". Câmera fica permitida porque a tela de "Conectar aparelho" abre o leitor de QR
    antes de oferecer "Conectar com número de telefone".
    """
    message = first_text(d, {"resourceIdMatches": PERMISSION_ID_PREFIX + "permission_message"}) or ""
    if LOCATION_PERMISSION_TEXT.match(message):
        buttons = ("permission_deny_and_dont_ask_again_button", "permission_deny_button")
    else:
        buttons = ("permission_allow_foreground_only_button", "permission_allow_all_button",
                   "permission_allow_button")
    click_first(d, *({"resourceIdMatches": PERMISSION_ID_PREFIX + b} for b in buttons), timeout=1)

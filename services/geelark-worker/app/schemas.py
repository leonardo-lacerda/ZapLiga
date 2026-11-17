"""Corpos da API HTTP do worker (contrato, seção 2). JSON em camelCase."""

from __future__ import annotations

import base64
import binascii
import re
from typing import Annotated, Literal, Union
from urllib.parse import quote

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .automation import JobSpec, ProbeProxySpec, ProxySpec

MAX_PHOTO_BYTES = 3 * 1024 * 1024
MAX_PROFILE_NAME = 25  # limite do WhatsApp


class _Body(BaseModel):
    model_config = ConfigDict(extra="ignore", hide_input_in_errors=True)


class ProxyIn(_Body):
    typeId: Literal[1, 2, 3]
    server: str = Field(min_length=1, max_length=255)
    port: int = Field(ge=1, le=65535)
    username: str = Field(default="", max_length=255, repr=False)
    password: str = Field(default="", max_length=255, repr=False)


class ProbeProxyIn(_Body):
    """Endereço interno do mesmo proxy (contrato §4, "IP esperado"). SOCKS5."""
    server: str = Field(min_length=1, max_length=255)
    port: int = Field(ge=1, le=65535)
    username: str = Field(default="", max_length=255, repr=False)
    password: str = Field(default="", max_length=255, repr=False)


class CreateWorkerJob(_Body):
    jobId: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    phoneId: str = Field(min_length=1, max_length=64)
    # network_check: só aplica a rede, liga o phone, confere o IP e desliga (sem app nem número).
    mode: Literal["register", "network_check"] = "register"
    app: Literal["whatsapp", "business"] | None = None
    countryCode: str | None = Field(default=None, pattern=r"^[1-9]\d{0,3}$")
    number: str | None = Field(default=None, pattern=r"^\d{4,15}$")
    proxy: ProxyIn
    probeProxy: ProbeProxyIn | None = None
    expectedEgressIps: list[str] = Field(default_factory=list, max_length=32)
    powerOffWhenDone: bool = True

    @model_validator(mode="after")
    def register_needs_number(self) -> "CreateWorkerJob":
        if self.mode == "register" and not (self.app and self.countryCode and self.number):
            raise ValueError("app, countryCode e number são obrigatórios no cadastro")
        return self

    def to_spec(self) -> JobSpec:
        p = self.proxy
        probe = self.probeProxy
        register = self.mode == "register"
        return JobSpec(
            job_id=self.jobId,
            phone_id=self.phoneId,
            mode=self.mode,
            app=(self.app or "") if register else "",
            country_code=(self.countryCode or "") if register else "",
            number=(self.number or "") if register else "",
            proxy=ProxySpec(p.typeId, p.server, p.port, p.username, p.password),
            expected_egress_ips=tuple(ip.strip() for ip in self.expectedEgressIps if ip.strip()),
            power_off_when_done=self.powerOffWhenDone,
            probe_proxy=(ProbeProxySpec(probe.server, probe.port, probe.username, probe.password)
                         if probe is not None else None),
        )


class CreatePhone(_Body):
    name: str = Field(min_length=1, max_length=60)
    # Android 10 fica de fora: o GeeLark não libera ADB nele, e sem ADB não há cadastro.
    androidVersion: Literal["Android 12", "Android 13", "Android 14", "Android 15", "Android 16", "Android 11"] = "Android 12"
    # Na prática, o socks-gateway do cadastro (usuário = vaga do PC); o phone já nasce saindo pelo PC.
    proxy: ProxyIn

    @field_validator("name")
    @classmethod
    def clean_name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("o nome é obrigatório")
        return v

    def proxy_url(self) -> str:
        p = self.proxy
        scheme = {1: "socks5", 2: "http", 3: "https"}[p.typeId]
        auth = f"{quote(p.username, safe='')}:{quote(p.password, safe='')}@" if p.username else ""
        return f"{scheme}://{auth}{p.server}:{p.port}"


class SmsInput(_Body):
    type: Literal["sms"]
    code: str

    @field_validator("code")
    @classmethod
    def six_digits(cls, v: str) -> str:
        digits = re.sub(r"\D", "", v)
        if len(digits) != 6:
            raise ValueError("o código SMS precisa ter 6 dígitos")
        return digits


class ProfileInput(_Body):
    type: Literal["profile"]
    name: str = Field(min_length=1)
    photoBase64: str | None = None
    photoMime: Literal["image/jpeg", "image/png"] | None = None

    @field_validator("name")
    @classmethod
    def clean_name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("o nome é obrigatório")
        if len(v) > MAX_PROFILE_NAME:
            raise ValueError(f"o nome pode ter no máximo {MAX_PROFILE_NAME} caracteres")
        return v

    def photo_bytes(self) -> bytes | None:
        if not self.photoBase64:
            return None
        raw = self.photoBase64.split(",", 1)[1] if self.photoBase64.startswith("data:") else self.photoBase64
        try:
            data = base64.b64decode(raw, validate=True)
        except (binascii.Error, ValueError):
            raise ValueError("photoBase64 inválido") from None
        if len(data) > MAX_PHOTO_BYTES:
            raise ValueError("a foto passa de 3 MB")
        return data


class LinkInput(_Body):
    type: Literal["link"]


class FinishInput(_Body):
    type: Literal["finish"]


class PairCodeInput(_Body):
    type: Literal["pair_code"]
    code: str

    @field_validator("code")
    @classmethod
    def eight_chars(cls, v: str) -> str:
        clean = re.sub(r"[\s-]", "", v).upper()
        if not re.fullmatch(r"[A-Z0-9]{8}", clean):
            raise ValueError("o código de pareamento precisa ter 8 letras/números (ABCD-EFGH)")
        return clean


JobInput = Annotated[
    Union[SmsInput, ProfileInput, LinkInput, FinishInput, PairCodeInput],
    Field(discriminator="type"),
]

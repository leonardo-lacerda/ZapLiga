"""Automação falsa (sem aparelho) e helpers para testar a máquina de estados."""

from __future__ import annotations

import sys
import time
from pathlib import Path
from typing import Any, Callable

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.automation import JobContext, JobSpec, ProxySpec, SmsResult  # noqa: E402
from app.jobs import JobManager  # noqa: E402

PNG = b"\x89PNG\r\n\x1a\nfake"


class FakeAutomation:
    """Registra as chamadas; `fail` / `block` / `sms` controlam o comportamento."""

    def __init__(self, spec: JobSpec, ctx: JobContext, *, egress: str | None = "203.0.113.7",
                 apps: dict[str, bool] | None = None, sms: list[SmsResult] | None = None,
                 fail: dict[str, BaseException] | None = None, block: str | None = None,
                 photo_warning: str | None = None):
        self.spec = spec
        self.ctx = ctx
        self.egress = egress
        self.apps = apps if apps is not None else {"whatsapp": True, "business": False}
        self.sms = list(sms or [SmsResult(True)])
        self.fail = fail or {}
        self.block = block
        self.photo_warning = photo_warning
        self.calls: list[str] = []
        self.received: dict[str, Any] = {}
        self.verified = False  # past_verification(): o operador passou do código na mão

    def _do(self, name: str) -> None:
        self.calls.append(name)
        if name in self.fail:
            raise self.fail[name]
        if self.block == name:
            while True:  # simula uma etapa demorada que só o ctx interrompe
                self.ctx.sleep(0.01)

    def set_network(self): self._do("set_network")
    def start_phone(self): self._do("start_phone")
    def connect_adb(self): self._do("connect_adb")

    def installed_apps(self):
        self._do("installed_apps")
        return dict(self.apps)

    def egress_ip(self):
        self._do("egress_ip")
        return self.egress

    def install_app(self): self._do("install_app")

    def request_code(self, method):
        self._do(f"request_code:{method}")
        return f"pedido {method}"
    def open_app(self): self._do("open_app")
    def enter_number(self): self._do("enter_number")

    def submit_sms_code(self, code):
        self._do("submit_sms_code")
        self.received.setdefault("sms", []).append(code)
        return self.sms.pop(0) if self.sms else SmsResult(True)

    def save_profile(self, name, photo, photo_mime):
        self._do("save_profile")
        self.received["profile"] = (name, photo, photo_mime)
        return self.photo_warning

    def open_link_screen(self): self._do("open_link_screen")
    def finish_verification(self): self._do("finish_verification")

    def past_verification(self):
        self.calls.append("past_verification")
        return self.verified

    def enter_pair_code(self, code):
        self._do("enter_pair_code")
        self.received["pair_code"] = code
        return None

    def manual(self, action):
        self.calls.append(f"manual:{action['type']}")
        self.received.setdefault("manual", []).append(action)

    def screenshot(self):
        self.calls.append("screenshot")
        return PNG

    def debug_dump(self):
        return "<hierarchy/>"

    def power_off(self): self.calls.append("power_off")
    def close(self): self.calls.append("close")


class FakeFactory:
    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.instances: dict[str, FakeAutomation] = {}

    def __call__(self, spec: JobSpec, ctx: JobContext) -> FakeAutomation:
        auto = FakeAutomation(spec, ctx, **self.kwargs)
        self.instances[spec.job_id] = auto
        return auto


def make_spec(job_id: str = "job-1", phone_id: str = "phone-1", **overrides) -> JobSpec:
    fields: dict[str, Any] = dict(
        job_id=job_id, phone_id=phone_id, app="whatsapp", country_code="55", number="11999998888",
        proxy=ProxySpec(1, "edge.example", 1080, "node-a", "s3cret-proxy-pass"),
        expected_egress_ips=("203.0.113.7",), power_off_when_done=True,
    )
    fields.update(overrides)
    return JobSpec(**fields)


def wait_for(predicate: Callable[[], bool], timeout: float = 3.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.005)
    raise AssertionError("condição não atingida a tempo")


@pytest.fixture
def factory():
    return FakeFactory()


@pytest.fixture
def manager(factory):
    return JobManager(factory, max_jobs=2, input_timeout_s=5, job_timeout_s=10)

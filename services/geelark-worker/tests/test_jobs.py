"""Máquina de estados com automação falsa."""

from __future__ import annotations

import json
import time

import pytest

from app.automation import SmsResult
from app.errors import ApiError, JobError, PERMISSION_TODO_MESSAGE
from app.egress_probe import ProbeFailed
from app.jobs import JobManager

from conftest import PNG, FakeFactory, make_spec, wait_for


def awaiting(manager, job_id, value):
    wait_for(lambda: manager.get(job_id).awaiting == value)


def finished(manager, job_id):
    wait_for(lambda: manager.get(job_id).finished.is_set())
    return manager.get(job_id)


def steps(job):
    return [h["step"] for h in job.history]


def test_happy_path_sms_profile_link_pair_code(manager, factory):
    manager.create(make_spec())
    awaiting(manager, "job-1", "sms")
    job = manager.get("job-1")
    assert job.status == "waiting_input" and job.step == "waiting_sms"
    assert job.egress_ip == "203.0.113.7"

    manager.submit_input("job-1", {"type": "sms", "code": "123456"})
    awaiting(manager, "job-1", "profile")
    assert manager.get("job-1").step == "waiting_profile"

    manager.submit_input("job-1", {"type": "profile", "name": "Loja", "photo": PNG, "photoMime": "image/png"})
    awaiting(manager, "job-1", "link_decision")
    assert manager.get("job-1").step == "registered"

    manager.submit_input("job-1", {"type": "link"})
    awaiting(manager, "job-1", "pair_code")
    assert manager.get("job-1").step == "waiting_pair_code"

    manager.submit_input("job-1", {"type": "pair_code", "code": "ABCDEFGH"})
    job = finished(manager, "job-1")

    assert job.status == "done" and job.step == "linking" and job.error_code is None
    auto = factory.instances["job-1"]
    assert auto.calls == [
        "set_network", "start_phone", "connect_adb", "installed_apps", "egress_ip",
        "open_app", "enter_number", "submit_sms_code", "save_profile",
        # sem power_off: no pareamento o phone fica ligado e a API desliga depois
        "open_link_screen", "enter_pair_code", "close",
    ]
    assert auto.received == {"sms": ["123456"], "profile": ("Loja", PNG, "image/png"), "pair_code": "ABCDEFGH"}
    assert steps(job) == [
        "queued", "setting_network", "starting_phone", "connecting_adb", "checking_network",
        "opening_app", "entering_number", "waiting_sms", "verifying", "waiting_profile",
        "saving_profile", "registered", "opening_link_screen", "waiting_pair_code",
        "entering_pair_code", "linking",
    ]
    # segredos nunca no estado público
    dumped = json.dumps(job.to_dict())
    for secret in ("123456", "ABCDEFGH", "s3cret-proxy-pass"):
        assert secret not in dumped
    assert job.to_dict()["number"] == "5511999998888"
    assert manager.busy_job_for("phone-1") is None
    assert manager.known_apps("phone-1") == {"whatsapp": True, "business": False}


def test_resend_and_call_while_waiting_sms(manager, factory):
    manager.create(make_spec())
    awaiting(manager, "job-1", "sms")
    manager.submit_input("job-1", {"type": "resend_sms"})
    wait_for(lambda: manager.get("job-1").message == "pedido sms" and manager.get("job-1").awaiting == "sms")
    manager.submit_input("job-1", {"type": "call_me"})
    wait_for(lambda: manager.get("job-1").message == "pedido voice" and manager.get("job-1").awaiting == "sms")
    calls = factory.instances["job-1"].calls
    assert calls[-2:] == ["request_code:sms", "request_code:voice"]
    # O código continua aceito depois dos pedidos.
    manager.submit_input("job-1", {"type": "sms", "code": "123456"})
    awaiting(manager, "job-1", "profile")
    manager.cancel("job-1")


def test_resend_is_refused_outside_the_sms_wait(manager):
    manager.create(make_spec())
    awaiting(manager, "job-1", "sms")
    manager.submit_input("job-1", {"type": "sms", "code": "123456"})
    awaiting(manager, "job-1", "profile")
    with pytest.raises(ApiError) as exc:
        manager.submit_input("job-1", {"type": "resend_sms"})
    assert exc.value.code == "not_awaiting"
    manager.cancel("job-1")


def test_live_screen_while_running_and_none_after():
    factory = FakeFactory()
    manager = JobManager(factory, input_timeout_s=5, job_timeout_s=10)
    manager.create(make_spec())
    awaiting(manager, "job-1", "sms")
    first = manager.live_screen("job-1")
    assert first == PNG
    assert manager.live_screen("job-1") == first  # cache curto
    manager.cancel("job-1")
    finished(manager, "job-1")
    assert manager.live_screen("job-1") is None


def run_to_handoff(manager):
    manager.create(make_spec())
    for awaited, inp in (("sms", {"type": "sms", "code": "123456"}),
                         ("profile", {"type": "profile", "name": "Loja", "photo": None, "photoMime": None}),
                         ("link_decision", {"type": "link"}),
                         ("pair_code", {"type": "pair_code", "code": "ABCDEFGH"})):
        awaiting(manager, "job-1", awaited)
        manager.submit_input("job-1", inp)
    job = finished(manager, "job-1")
    assert job.status == "done" and job.step == "linking"


def test_watchdog_powers_off_a_phone_the_api_never_turned_off():
    stopped = []
    manager = JobManager(FakeFactory(), input_timeout_s=5, job_timeout_s=10, stop_phone=stopped.append, handoff_max_s=600)
    run_to_handoff(manager)

    # Dentro do prazo do pareamento: a API ainda pode precisar do phone ligado.
    assert manager.sweep_handed() == [] and stopped == []
    assert manager.sweep_handed(now=time.monotonic() + 601) == ["phone-1"]
    assert stopped == ["phone-1"]
    # Só uma vez.
    assert manager.sweep_handed(now=time.monotonic() + 1200) == []


def test_watchdog_leaves_a_phone_that_a_new_job_took_over():
    stopped = []
    manager = JobManager(FakeFactory(), input_timeout_s=5, job_timeout_s=10, stop_phone=stopped.append, handoff_max_s=0)
    run_to_handoff(manager)
    manager.create(make_spec("job-2"))  # novo job no mesmo phone: ele é quem desliga no fim
    assert manager.sweep_handed() == [] and stopped == []
    manager.cancel("job-2")


def test_finish_without_linking(manager, factory):
    manager.create(make_spec())
    awaiting(manager, "job-1", "sms")
    manager.submit_input("job-1", {"type": "sms", "code": "123456"})
    awaiting(manager, "job-1", "profile")
    manager.submit_input("job-1", {"type": "profile", "name": "Loja"})
    awaiting(manager, "job-1", "link_decision")
    manager.submit_input("job-1", {"type": "finish"})
    job = finished(manager, "job-1")
    assert job.status == "done" and job.step == "done"
    assert "open_link_screen" not in factory.instances["job-1"].calls
    assert factory.instances["job-1"].received["profile"] == ("Loja", None, None)


def test_wrong_sms_code_goes_back_to_waiting_sms():
    factory = FakeFactory(sms=[SmsResult(False, "Código incorreto."), SmsResult(True)])
    manager = JobManager(factory, input_timeout_s=5, job_timeout_s=10)
    manager.create(make_spec())
    awaiting(manager, "job-1", "sms")
    manager.submit_input("job-1", {"type": "sms", "code": "000000"})
    wait_for(lambda: manager.get("job-1").awaiting == "sms" and steps(manager.get("job-1")).count("waiting_sms") == 2)
    job = manager.get("job-1")
    assert job.step == "waiting_sms" and job.message == "Código incorreto."
    manager.submit_input("job-1", {"type": "sms", "code": "123456"})
    awaiting(manager, "job-1", "profile")
    assert factory.instances["job-1"].received["sms"] == ["000000", "123456"]
    manager.cancel("job-1")


def test_sms_rejected_after_max_attempts():
    factory = FakeFactory(sms=[SmsResult(False)] * 5)
    manager = JobManager(factory, input_timeout_s=5, job_timeout_s=10)
    manager.create(make_spec())
    for _ in range(5):
        wait_for(lambda: manager.get("job-1").awaiting == "sms" or manager.get("job-1").terminal)
        if manager.get("job-1").terminal:
            break
        manager.submit_input("job-1", {"type": "sms", "code": "000000"})
        wait_for(lambda: manager.get("job-1").awaiting is None or manager.get("job-1").terminal)
    job = finished(manager, "job-1")
    assert job.status == "failed" and job.error_code == "sms_rejected"


def test_cancel_while_waiting_input(manager, factory):
    manager.create(make_spec())
    awaiting(manager, "job-1", "sms")
    job = manager.cancel("job-1")
    assert job.status == "cancelled" and job.error_code == "cancelled" and job.awaiting is None
    job = finished(manager, "job-1")
    assert job.status == "cancelled"
    assert factory.instances["job-1"].calls[-2:] == ["power_off", "close"]
    assert "screenshot" not in factory.instances["job-1"].calls
    assert manager.busy_job_for("phone-1") is None
    # cancelar de novo devolve o mesmo estado
    assert manager.cancel("job-1").status == "cancelled"


def test_cancel_interrupts_running_step():
    factory = FakeFactory(block="open_app")
    manager = JobManager(factory, input_timeout_s=5, job_timeout_s=10)
    manager.create(make_spec())
    wait_for(lambda: "job-1" in factory.instances and "open_app" in factory.instances["job-1"].calls)
    manager.cancel("job-1")
    job = finished(manager, "job-1")
    assert job.status == "cancelled"
    assert "enter_number" not in factory.instances["job-1"].calls


def test_input_timeout_fails_with_screenshot():
    factory = FakeFactory()
    manager = JobManager(factory, input_timeout_s=0.1, job_timeout_s=10)
    manager.create(make_spec())
    job = finished(manager, "job-1")
    assert job.status == "failed" and job.error_code == "timeout"
    assert "código SMS" in job.message
    assert job.to_dict()["hasScreenshot"] is True and job.screenshot == PNG
    assert factory.instances["job-1"].calls[-3:] == ["screenshot", "power_off", "close"]


def test_job_timeout_interrupts_long_step():
    factory = FakeFactory(block="start_phone")
    manager = JobManager(factory, input_timeout_s=5, job_timeout_s=0.2)
    manager.create(make_spec())
    job = finished(manager, "job-1")
    assert job.status == "failed" and job.error_code == "timeout"
    assert job.step == "starting_phone"


def test_phone_busy_and_worker_full():
    factory = FakeFactory()
    manager = JobManager(factory, max_jobs=2, input_timeout_s=5, job_timeout_s=10)
    manager.create(make_spec("a", "p1"))
    with pytest.raises(ApiError) as busy:
        manager.create(make_spec("b", "p1"))
    assert (busy.value.status, busy.value.code) == (409, "phone_busy")
    manager.create(make_spec("c", "p2"))
    with pytest.raises(ApiError) as full:
        manager.create(make_spec("d", "p3"))
    assert (full.value.status, full.value.code) == (429, "worker_full")
    with pytest.raises(ApiError) as dup:
        manager.create(make_spec("a", "p9"))
    assert dup.value.code == "job_exists"
    for job_id in ("a", "c"):
        manager.cancel(job_id)
        finished(manager, job_id)
    manager.create(make_spec("e", "p1"))  # liberou o phone e a vaga
    manager.cancel("e")


def network_check_spec(**overrides):
    return make_spec(mode="network_check", app="", country_code="", number="", **overrides)


def test_network_check_stops_after_ip_and_powers_off(manager, factory):
    manager.create(network_check_spec())
    job = finished(manager, "job-1")
    assert job.status == "done" and job.step == "network_ok" and job.error_code is None
    assert job.egress_ip == "203.0.113.7" and "203.0.113.7" in job.message and "mesmo do PC" in job.message
    calls = factory.instances["job-1"].calls
    assert calls[:4] == ["set_network", "start_phone", "connect_adb", "installed_apps"]
    assert "egress_ip" in calls and "power_off" in calls
    assert not {"install_app", "open_app", "enter_number"} & set(calls)
    assert steps(job) == ["queued", "setting_network", "starting_phone", "connecting_adb", "checking_network", "network_ok"]
    assert job.to_dict()["mode"] == "network_check" and job.to_dict()["number"] is None


def test_network_check_mismatch_fails():
    factory = FakeFactory(egress="198.51.100.1")
    manager = JobManager(factory, input_timeout_s=5, job_timeout_s=10)
    manager.create(network_check_spec())
    job = finished(manager, "job-1")
    assert job.status == "failed" and job.error_code == "egress_mismatch"
    assert "power_off" in factory.instances["job-1"].calls


def test_egress_mismatch():
    factory = FakeFactory(egress="198.51.100.1")
    manager = JobManager(factory, input_timeout_s=5, job_timeout_s=10)
    manager.create(make_spec())
    job = finished(manager, "job-1")
    assert job.status == "failed" and job.error_code == "egress_mismatch"
    assert job.egress_ip == "198.51.100.1"
    assert "198.51.100.1" in job.message
    assert "open_app" not in factory.instances["job-1"].calls


def test_empty_expected_ips_only_requires_internet():
    factory = FakeFactory(egress="198.51.100.1")
    manager = JobManager(factory, input_timeout_s=5, job_timeout_s=10)
    manager.create(make_spec(expected_egress_ips=()))
    awaiting(manager, "job-1", "sms")
    manager.cancel("job-1")


def test_no_internet_when_curl_returns_nothing():
    factory = FakeFactory(egress=None)
    manager = JobManager(factory, input_timeout_s=5, job_timeout_s=10)
    manager.create(make_spec())
    job = finished(manager, "job-1")
    assert job.error_code == "no_internet" and job.egress_ip is None


def _no_internet_job(probe):
    from app.automation import ProbeProxySpec

    class Factory(FakeFactory):
        def __call__(self, spec, ctx):
            auto = super().__call__(spec, ctx)
            auto.last_egress_error = "não conseguiu conectar (curl: (7) Failed to connect)"
            return auto

    manager = JobManager(Factory(egress=None), input_timeout_s=5, job_timeout_s=10, egress_probe=probe)
    manager.create(make_spec(expected_egress_ips=(), probe_proxy=ProbeProxySpec("socks-edge-1", 1080, "edge-1", "x")))
    return finished(manager, "job-1")


def test_no_internet_says_the_pc_is_fine_and_shows_the_phone_error():
    job = _no_internet_job(lambda _: "203.0.113.7")
    assert job.error_code == "no_internet"
    assert "PC está saindo normalmente (IP 203.0.113.7)" in job.message
    assert "Failed to connect" in job.message


def test_no_internet_blames_the_pc_when_it_stopped_answering():
    calls = []

    def probe(_):
        calls.append(1)
        if len(calls) > 1:
            raise ProbeFailed("timeout")
        return "203.0.113.7"
    job = _no_internet_job(probe)
    assert job.error_code == "no_internet" and "parou de sair para a internet" in job.message


def test_installs_app_when_missing():
    factory = FakeFactory(apps={"whatsapp": False, "business": False})
    manager = JobManager(factory, input_timeout_s=5, job_timeout_s=10)
    manager.create(make_spec())
    awaiting(manager, "job-1", "sms")
    assert "installing_app" in steps(manager.get("job-1"))
    assert "install_app" in factory.instances["job-1"].calls
    assert manager.known_apps("phone-1")["whatsapp"] is True
    manager.cancel("job-1")


def test_input_not_awaiting(manager):
    manager.create(make_spec())
    awaiting(manager, "job-1", "sms")
    with pytest.raises(ApiError) as exc:
        manager.submit_input("job-1", {"type": "profile", "name": "x"})
    assert (exc.value.status, exc.value.code) == (409, "not_awaiting")
    manager.cancel("job-1")
    with pytest.raises(ApiError):
        manager.submit_input("job-1", {"type": "sms", "code": "123456"})


def test_job_error_from_automation():
    factory = FakeFactory(fail={"connect_adb": JobError("adb_failed", "adb caiu")})
    manager = JobManager(factory, input_timeout_s=5, job_timeout_s=10)
    manager.create(make_spec())
    job = finished(manager, "job-1")
    assert (job.status, job.error_code, job.message, job.step) == ("failed", "adb_failed", "adb caiu", "connecting_adb")
    assert job.screenshot == PNG


def test_handle_permission_not_implemented_becomes_internal():
    factory = FakeFactory(fail={"open_app": NotImplementedError("handle_permission ainda não implementado")})
    manager = JobManager(factory, input_timeout_s=5, job_timeout_s=10)
    manager.create(make_spec())
    job = finished(manager, "job-1")
    assert job.error_code == "internal" and job.message == PERMISSION_TODO_MESSAGE


def test_unknown_screen_saves_debug_xml(tmp_path):
    factory = FakeFactory(fail={"enter_number": JobError("unknown_screen", "tela nova")})
    manager = JobManager(factory, input_timeout_s=5, job_timeout_s=10, debug_dir=str(tmp_path))
    manager.create(make_spec())
    awaiting(manager, "job-1", "manual")  # o XML já fica salvo quando o robô pede ajuda
    assert (tmp_path / "job-1.xml").read_text(encoding="utf-8") == "<hierarchy/>"
    manager.cancel("job-1")


class FailsOnce:
    """Tela desconhecida só na primeira vez: depois da ajuda do operador a etapa passa."""

    def __init__(self, times=1):
        self.left = times

    def install(self, auto, name):
        original = getattr(auto, name)

        def wrapped(*args):
            if self.left:
                self.left -= 1
                auto.calls.append(name)
                raise JobError("unknown_screen", "Tela desconhecida enquanto esperava 'digitar código'.")
            return original(*args)
        setattr(auto, name, wrapped)


def manager_with_flaky(step, times=1):
    flaky = FailsOnce(times)

    class Factory(FakeFactory):
        def __call__(self, spec, ctx):
            auto = super().__call__(spec, ctx)
            flaky.install(auto, step)
            return auto

    factory = Factory()
    return JobManager(factory, input_timeout_s=5, job_timeout_s=10), factory


def test_unknown_screen_waits_for_the_operator_and_resumes():
    manager, factory = manager_with_flaky("enter_number")
    manager.create(make_spec())
    awaiting(manager, "job-1", "manual")
    job = manager.get("job-1")
    assert (job.status, job.step) == ("waiting_input", "waiting_manual")
    assert "Devolver ao robô" in job.message and "digitar código" in job.message
    # O operador mexe no phone enquanto o robô espera; o texto digitado não vai para o log.
    manager.manual_action("job-1", {"type": "tap", "x": 0.5, "y": 0.9})
    manager.manual_action("job-1", {"type": "text", "text": "segredo"})
    auto = factory.instances["job-1"]
    assert auto.calls[-2:] == ["manual:tap", "manual:text"]
    manager.submit_input("job-1", {"type": "resume"})
    awaiting(manager, "job-1", "sms")
    assert steps(manager.get("job-1"))[-3:] == ["waiting_manual", "entering_number", "waiting_sms"]
    assert auto.calls.count("enter_number") == 2
    manager.cancel("job-1")


def test_manual_action_is_refused_while_the_robot_works():
    factory = FakeFactory(block="enter_number")
    manager = JobManager(factory, input_timeout_s=5, job_timeout_s=10)
    manager.create(make_spec())
    wait_for(lambda: "enter_number" in factory.instances.get("job-1", FakeFactory()).calls
             if "job-1" in factory.instances else False)
    with pytest.raises(ApiError) as exc:
        manager.manual_action("job-1", {"type": "key", "key": "back"})
    assert (exc.value.status, exc.value.code) == (409, "robot_busy")
    manager.cancel("job-1")


def test_gives_up_after_too_many_helps():
    manager, _ = manager_with_flaky("open_app", times=10)
    manager.create(make_spec())
    for _ in range(3):
        awaiting(manager, "job-1", "manual")
        manager.submit_input("job-1", {"type": "resume"})
    job = finished(manager, "job-1")
    assert (job.status, job.error_code) == ("failed", "unknown_screen")
    assert "power_off" in manager_calls(manager)


def manager_calls(manager):
    return manager._factory.instances["job-1"].calls


def test_keeps_phone_on_when_power_off_disabled():
    factory = FakeFactory(fail={"set_network": JobError("egress_offline", "proxy fora")})
    manager = JobManager(factory, input_timeout_s=5, job_timeout_s=10)
    manager.create(make_spec(power_off_when_done=False))
    job = finished(manager, "job-1")
    assert job.error_code == "egress_offline"
    assert "power_off" not in factory.instances["job-1"].calls


def test_profile_warning_goes_to_message():
    factory = FakeFactory(photo_warning="A foto não foi aplicada.")
    manager = JobManager(factory, input_timeout_s=5, job_timeout_s=10)
    manager.create(make_spec())
    awaiting(manager, "job-1", "sms")
    manager.submit_input("job-1", {"type": "sms", "code": "123456"})
    awaiting(manager, "job-1", "profile")
    manager.submit_input("job-1", {"type": "profile", "name": "Loja", "photo": PNG, "photoMime": "image/jpeg"})
    awaiting(manager, "job-1", "link_decision")
    assert manager.get("job-1").message == "Número cadastrado. A foto não foi aplicada."
    manager.cancel("job-1")


# ---------------------------------------------------------------- probeProxy (contrato §4)
PROBE_PASSWORD = "s3cret-probe-pass"


def probe_spec(**overrides):
    from app.automation import ProbeProxySpec
    fields = dict(expected_egress_ips=(),
                  probe_proxy=ProbeProxySpec("socks-gateway", 1080, "edge-3", PROBE_PASSWORD))
    fields.update(overrides)
    return make_spec(**fields)


class FakeProbe:
    def __init__(self, result="203.0.113.7"):
        self.result = result
        self.calls = []

    def __call__(self, proxy):
        self.calls.append(proxy)
        if isinstance(self.result, BaseException):
            raise self.result
        return self.result


def test_probe_ip_becomes_the_expected_ip():
    factory, probe = FakeFactory(egress="203.0.113.7"), FakeProbe("203.0.113.7")
    manager = JobManager(factory, input_timeout_s=5, job_timeout_s=10, egress_probe=probe)
    manager.create(probe_spec())
    awaiting(manager, "job-1", "sms")
    assert [(p.server, p.port, p.username) for p in probe.calls] == [("socks-gateway", 1080, "edge-3")]
    assert manager.get("job-1").egress_ip == "203.0.113.7"
    # o probe roda antes de mexer no phone
    assert factory.instances["job-1"].calls[0] == "set_network"
    manager.cancel("job-1")


def test_probe_ip_differs_from_phone_ip_is_egress_mismatch():
    factory, probe = FakeFactory(egress="198.51.100.1"), FakeProbe("203.0.113.7")
    manager = JobManager(factory, input_timeout_s=5, job_timeout_s=10, egress_probe=probe)
    manager.create(probe_spec())
    job = finished(manager, "job-1")
    assert job.error_code == "egress_mismatch"
    assert "198.51.100.1" in job.message and "203.0.113.7" in job.message
    assert "open_app" not in factory.instances["job-1"].calls


@pytest.mark.parametrize("error", [
    pytest.param("probe_failed", id="probe-failed"),
    pytest.param("unexpected", id="unexpected-error"),
])
def test_probe_failure_is_egress_offline_without_touching_the_phone(error, caplog):
    from app.egress_probe import ProbeFailed
    from app.jobs import EGRESS_OFFLINE_MESSAGE
    exc = (ProbeFailed("o proxy recusou a conexão (SOCKS 2)") if error == "probe_failed"
           else RuntimeError(f"boom {PROBE_PASSWORD}"))
    factory, probe = FakeFactory(), FakeProbe(exc)
    manager = JobManager(factory, input_timeout_s=5, job_timeout_s=10, egress_probe=probe)
    caplog.set_level("INFO")
    manager.create(probe_spec())
    job = finished(manager, "job-1")
    assert (job.status, job.error_code, job.step) == ("failed", "egress_offline", "setting_network")
    assert job.message == EGRESS_OFFLINE_MESSAGE == "O PC escolhido não está saindo para a internet agora."
    calls = factory.instances["job-1"].calls
    assert "set_network" not in calls and "start_phone" not in calls
    assert PROBE_PASSWORD not in json.dumps(job.to_dict())
    assert PROBE_PASSWORD not in caplog.text
    assert PROBE_PASSWORD not in repr(job.spec)


def test_no_probe_when_expected_ips_are_given():
    factory, probe = FakeFactory(), FakeProbe()
    manager = JobManager(factory, input_timeout_s=5, job_timeout_s=10, egress_probe=probe)
    manager.create(probe_spec(expected_egress_ips=("203.0.113.7",)))
    awaiting(manager, "job-1", "sms")
    assert probe.calls == []
    manager.cancel("job-1")

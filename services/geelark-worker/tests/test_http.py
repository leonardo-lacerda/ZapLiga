"""Camada HTTP: auth, formatos do contrato e erros."""

from __future__ import annotations

import base64
from unittest import mock

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.errors import JobError
from app.geelark_api import GeeLarkError
from app.jobs import JobManager
from app.main import create_app

from conftest import PNG, FakeFactory, wait_for

TOKEN = "worker-secret"
H = {"x-worker-token": TOKEN}

PHONES = [
    {"id": "p1", "serialName": "Phone 1", "status": 0, "systemVer": "12",
     "proxy": {"type": "socks5", "server": "edge.example", "port": 1080}},
    {"id": "p2", "serialName": "Phone 2", "status": 2, "systemVer": "Android 10", "proxy": {"server": ""}},
    {"id": "p3", "serialNo": "S3", "status": 9},
]


def job_body(**overrides):
    body = {
        "jobId": "11111111-2222-3333-4444-555555555555", "phoneId": "p1", "app": "whatsapp",
        "countryCode": "55", "number": "11999998888",
        "proxy": {"typeId": 1, "server": "edge.example", "port": 1080, "username": "node", "password": "s3cret-pw"},
        "expectedEgressIps": ["203.0.113.7"], "powerOffWhenDone": True,
    }
    body.update(overrides)
    return body


@pytest.fixture
def geelark():
    g = mock.Mock()
    g.list_phones.return_value = PHONES
    return g


@pytest.fixture
def factory():
    return FakeFactory()


@pytest.fixture
def client(geelark, factory):
    manager = JobManager(factory, max_jobs=2, input_timeout_s=5, job_timeout_s=10)
    app = create_app(Settings(worker_token=TOKEN, geelark_api_token="x"), geelark=geelark, manager=manager)
    with TestClient(app) as c:
        c.manager = manager
        yield c
    for job_id in list(manager._jobs):
        manager.cancel(job_id)


def test_health_needs_no_token(client):
    assert client.get("/health").json() == {"ok": True}


@pytest.mark.parametrize("headers", [{}, {"x-worker-token": "wrong"}, {"x-worker-token": ""}])
@pytest.mark.parametrize("method,path", [
    ("get", "/phones"), ("post", "/phones/p1/stop"), ("post", "/jobs"), ("get", "/jobs/x"),
    ("post", "/jobs/x/input"), ("post", "/jobs/x/cancel"), ("get", "/jobs/x/screenshot"),
])
def test_routes_require_token(client, headers, method, path):
    resp = getattr(client, method)(path, headers=headers)
    assert resp.status_code == 401
    assert resp.json()["error"] == "unauthorized"


def test_empty_configured_token_rejects_everything(geelark, factory):
    app = create_app(Settings(worker_token=""), geelark=geelark, manager=JobManager(factory))
    with TestClient(app) as c:
        assert c.get("/phones", headers={"x-worker-token": ""}).status_code == 401
        assert c.get("/health").status_code == 200


def test_phones_mapping(client):
    items = client.get("/phones", headers=H).json()["items"]
    assert items[0] == {
        "id": "p1", "name": "Phone 1", "status": "on", "android": "Android 12",
        "proxy": "socks5 edge.example:1080", "apps": {"whatsapp": None, "business": None}, "busyJobId": None,
    }
    assert items[1]["status"] == "off" and items[1]["android"] == "Android 10" and items[1]["proxy"] is None
    assert items[2]["status"] == "unknown" and items[2]["name"] == "S3"


def test_phones_geelark_error(client, geelark):
    geelark.list_phones.side_effect = GeeLarkError(40014, "locked", "t", "/open/v1/phone/list")
    resp = client.get("/phones", headers=H)
    assert resp.status_code == 502 and resp.json()["error"] == "geelark_error"


PHONE_BODY = {"name": "WhatsApp 3", "androidVersion": "Android 12",
              "proxy": {"typeId": 1, "server": "209.50.229.249", "port": 1080, "username": "edge-1", "password": "a b@c"}}


def test_create_phone_with_proxy(client, geelark):
    geelark.create_phone.return_value = {"code": 0, "id": "new-1", "profileName": "WhatsApp 3"}
    geelark.get_phone.return_value = {"id": "new-1", "serialName": "WhatsApp 3", "status": 2, "systemVer": "12",
                                      "proxy": {"type": "socks5", "server": "209.50.229.249", "port": 1080}}
    resp = client.post("/phones", headers=H, json=PHONE_BODY)
    assert resp.status_code == 201
    assert resp.json() == {"id": "new-1", "name": "WhatsApp 3", "status": "off", "android": "Android 12",
                           "proxy": "socks5 209.50.229.249:1080", "apps": {"whatsapp": None, "business": None},
                           "busyJobId": None}
    # Usuário/senha vão codificados na URL do proxy; Android 12+ ganha rede de dados móveis.
    geelark.create_phone.assert_called_once_with("WhatsApp 3", "Android 12",
                                                  "socks5://edge-1:a%20b%40c@209.50.229.249:1080", net_type=1)


def test_create_phone_falls_back_when_list_lags(client, geelark):
    geelark.create_phone.return_value = {"code": 0, "id": "new-2", "equipmentInfo": {"osVersion": "Android 11"}}
    geelark.get_phone.return_value = None
    body = dict(PHONE_BODY, androidVersion="Android 11")
    data = client.post("/phones", headers=H, json=body).json()
    assert data["id"] == "new-2" and data["name"] == "WhatsApp 3" and data["status"] == "off"
    assert data["android"] == "Android 11" and data["proxy"] == "socks5 209.50.229.249:1080"
    assert geelark.create_phone.call_args.kwargs["net_type"] is None


def test_create_phone_errors(client, geelark):
    geelark.create_phone.side_effect = GeeLarkError(45004, "check proxy failed", "t", "/open/v1/phone/addNew")
    resp = client.post("/phones", headers=H, json=PHONE_BODY)
    assert resp.status_code == 409 and resp.json()["error"] == "egress_offline"
    geelark.create_phone.side_effect = GeeLarkError(42001, "balance not enough", "t", "/open/v1/phone/addNew")
    resp = client.post("/phones", headers=H, json=PHONE_BODY)
    assert resp.status_code == 502 and "balance not enough" in resp.json()["message"]
    resp = client.post("/phones", headers=H, json=dict(PHONE_BODY, androidVersion="Android 10"))
    assert resp.status_code == 400 and "a b@c" not in resp.text


def test_network_check_job_over_http(client, factory):
    body = {k: v for k, v in job_body(mode="network_check").items() if k not in ("app", "countryCode", "number")}
    resp = client.post("/jobs", headers=H, json=body)
    assert resp.status_code == 201 and resp.json()["mode"] == "network_check"
    assert resp.json()["app"] is None and resp.json()["number"] is None
    wait_for(lambda: client.manager.get(body["jobId"]).finished.is_set())
    job = client.get(f"/jobs/{body['jobId']}", headers=H).json()
    assert job["status"] == "done" and job["step"] == "network_ok" and job["egressIp"] == "203.0.113.7"
    # Cadastro sem app/número continua recusado.
    resp = client.post("/jobs", headers=H, json={k: v for k, v in job_body(jobId="j2").items() if k != "number"})
    assert resp.status_code == 400


def test_live_screen_and_resend_over_http(client, factory):
    body = job_body(jobId="live-1")
    assert client.post("/jobs", headers=H, json=body).status_code == 201
    wait_for(lambda: client.manager.get("live-1").awaiting == "sms")
    resp = client.get("/jobs/live-1/screen", headers=H)
    assert resp.status_code == 200 and resp.headers["content-type"] == "image/png"
    assert resp.headers["cache-control"] == "no-store"
    job = client.post("/jobs/live-1/input", headers=H, json={"type": "call_me"}).json()
    assert job["awaiting"] in ("sms", None)
    wait_for(lambda: client.manager.get("live-1").message == "pedido voice")
    client.post("/jobs/live-1/cancel", headers=H)
    wait_for(lambda: client.manager.get("live-1").finished.is_set())
    assert client.get("/jobs/live-1/screen", headers=H).status_code == 404


def test_stop_phone(client, geelark):
    assert client.post("/phones/p1/stop", headers=H).json() == {"ok": True}
    geelark.stop_phone.assert_called_once_with("p1")


def test_job_lifecycle_over_http(client, factory):
    resp = client.post("/jobs", headers=H, json=job_body())
    assert resp.status_code == 201
    job = resp.json()
    assert set(job) == {"jobId", "phoneId", "mode", "app", "number", "status", "step", "awaiting", "message",
                        "errorCode", "hasScreenshot", "egressIp", "history", "createdAt", "updatedAt"}
    assert job["number"] == "5511999998888"
    job_id = job["jobId"]

    wait_for(lambda: client.get(f"/jobs/{job_id}", headers=H).json()["awaiting"] == "sms")
    phones = client.get("/phones", headers=H).json()["items"]
    assert phones[0]["busyJobId"] == job_id
    assert phones[0]["apps"] == {"whatsapp": True, "business": False}

    # código fora do formato
    bad = client.post(f"/jobs/{job_id}/input", headers=H, json={"type": "sms", "code": "12"})
    assert bad.status_code == 400 and bad.json()["error"] == "invalid_request"
    # tipo que o job não está esperando
    wrong = client.post(f"/jobs/{job_id}/input", headers=H, json={"type": "link"})
    assert wrong.status_code == 409 and wrong.json()["error"] == "not_awaiting"

    ok = client.post(f"/jobs/{job_id}/input", headers=H, json={"type": "sms", "code": "123-456"})
    assert ok.status_code == 200 and ok.json()["awaiting"] is None
    wait_for(lambda: client.get(f"/jobs/{job_id}", headers=H).json()["awaiting"] == "profile")
    photo = base64.b64encode(PNG).decode()
    client.post(f"/jobs/{job_id}/input", headers=H,
                json={"type": "profile", "name": " Loja ", "photoBase64": photo, "photoMime": "image/png"})
    wait_for(lambda: client.get(f"/jobs/{job_id}", headers=H).json()["awaiting"] == "link_decision")
    client.post(f"/jobs/{job_id}/input", headers=H, json={"type": "link"})
    wait_for(lambda: client.get(f"/jobs/{job_id}", headers=H).json()["awaiting"] == "pair_code")
    client.post(f"/jobs/{job_id}/input", headers=H, json={"type": "pair_code", "code": "abcd-efgh"})
    wait_for(lambda: client.manager.get(job_id).finished.is_set())

    final = client.get(f"/jobs/{job_id}", headers=H).json()
    assert final["status"] == "done" and final["step"] == "linking"
    received = factory.instances[job_id].received
    assert received["sms"] == ["123456"]
    assert received["profile"] == ("Loja", PNG, "image/png")
    assert received["pair_code"] == "ABCDEFGH"
    assert client.get(f"/jobs/{job_id}/screenshot", headers=H).status_code == 404


def test_create_validation_never_echoes_secrets(client):
    resp = client.post("/jobs", headers=H, json=job_body(number="abc", proxy={"typeId": 9, "server": "x",
                                                                              "port": 1, "password": "s3cret-pw"}))
    assert resp.status_code == 400
    assert resp.json()["error"] == "invalid_request"
    assert "s3cret-pw" not in resp.text


def test_phone_busy_over_http(client):
    assert client.post("/jobs", headers=H, json=job_body()).status_code == 201
    resp = client.post("/jobs", headers=H, json=job_body(jobId="other"))
    assert resp.status_code == 409 and resp.json()["error"] == "phone_busy"


def test_worker_full_over_http(client):
    client.post("/jobs", headers=H, json=job_body(jobId="a", phoneId="p1"))
    client.post("/jobs", headers=H, json=job_body(jobId="b", phoneId="p2"))
    resp = client.post("/jobs", headers=H, json=job_body(jobId="c", phoneId="p3"))
    assert resp.status_code == 429 and resp.json()["error"] == "worker_full"


def test_unknown_job_is_404(client):
    for resp in (client.get("/jobs/nope", headers=H), client.post("/jobs/nope/cancel", headers=H),
                 client.get("/jobs/nope/screenshot", headers=H),
                 client.post("/jobs/nope/input", headers=H, json={"type": "link"})):
        assert resp.status_code == 404 and resp.json()["error"] == "not_found"


def test_cancel_and_failure_screenshot(geelark):
    factory = FakeFactory(fail={"enter_number": JobError("number_banned", "banido")})
    manager = JobManager(factory, input_timeout_s=5, job_timeout_s=10)
    app = create_app(Settings(worker_token=TOKEN), geelark=geelark, manager=manager)
    with TestClient(app) as c:
        job_id = c.post("/jobs", headers=H, json=job_body()).json()["jobId"]
        wait_for(lambda: manager.get(job_id).finished.is_set())
        job = c.get(f"/jobs/{job_id}", headers=H).json()
        assert job["status"] == "failed" and job["errorCode"] == "number_banned" and job["hasScreenshot"] is True
        shot = c.get(f"/jobs/{job_id}/screenshot", headers=H)
        assert shot.status_code == 200 and shot.headers["content-type"] == "image/png" and shot.content == PNG
        # cancelar um job terminado devolve o estado atual
        assert c.post(f"/jobs/{job_id}/cancel", headers=H).json()["status"] == "failed"


def test_manual_control_on_an_unknown_screen(geelark):
    factory = FakeFactory(fail={"open_app": JobError("unknown_screen", "tela nova")})
    manager = JobManager(factory, input_timeout_s=5, job_timeout_s=10)
    app = create_app(Settings(worker_token=TOKEN), geelark=geelark, manager=manager)
    with TestClient(app) as c:
        job_id = c.post("/jobs", headers=H, json=job_body()).json()["jobId"]
        wait_for(lambda: manager.get(job_id).awaiting == "manual")
        for body in ({"type": "tap", "x": 0.25, "y": 1}, {"type": "key", "key": "back"},
                     {"type": "key", "key": "scroll_down"}, {"type": "text", "text": "Loja"}):
            resp = c.post(f"/jobs/{job_id}/manual", headers=H, json=body)
            assert resp.status_code == 200 and resp.json() == {"ok": True}, body
        for bad in ({"type": "tap", "x": 1.5, "y": 0}, {"type": "key", "key": "power"}, {"type": "text", "text": ""}):
            assert c.post(f"/jobs/{job_id}/manual", headers=H, json=bad).status_code == 400, bad
        assert c.post(f"/jobs/{job_id}/manual", json={"type": "key", "key": "back"}).status_code == 401
        assert factory.instances[job_id].received["manual"][0] == {"type": "tap", "x": 0.25, "y": 1.0}
        resp = c.post(f"/jobs/{job_id}/input", headers=H, json={"type": "resume"})
        assert resp.status_code == 200 and resp.json()["status"] == "running"
        c.post(f"/jobs/{job_id}/cancel", headers=H)


def test_takeover_route(client):
    job_id = client.post("/jobs", headers=H, json=job_body()).json()["jobId"]
    wait_for(lambda: client.manager.get(job_id).awaiting == "sms")
    resp = client.post(f"/jobs/{job_id}/takeover", headers=H)
    assert resp.status_code == 200 and resp.json()["message"] == "Assumindo o controle do phone…"
    wait_for(lambda: client.manager.get(job_id).awaiting == "manual")
    assert client.post(f"/jobs/{job_id}/takeover").status_code == 401
    client.post(f"/jobs/{job_id}/cancel", headers=H)
    assert client.post(f"/jobs/{job_id}/takeover", headers=H).status_code == 409


def test_cancel_running_job(client):
    job_id = client.post("/jobs", headers=H, json=job_body()).json()["jobId"]
    wait_for(lambda: client.manager.get(job_id).awaiting == "sms")
    resp = client.post(f"/jobs/{job_id}/cancel", headers=H).json()
    assert resp["status"] == "cancelled" and resp["errorCode"] == "cancelled"


def test_probe_proxy_is_optional_and_reaches_the_job(geelark):
    from app.schemas import CreateWorkerJob
    seen = []

    def probe(proxy):
        seen.append(proxy)
        return "203.0.113.7"

    manager = JobManager(FakeFactory(), input_timeout_s=5, job_timeout_s=10, egress_probe=probe)
    app = create_app(Settings(worker_token=TOKEN), geelark=geelark, manager=manager)
    body = job_body(expectedEgressIps=[], probeProxy={"server": "socks-gateway", "port": 1080,
                                                      "username": "edge-2", "password": "probe-pw-xyz"})
    with TestClient(app) as c:
        job_id = c.post("/jobs", headers=H, json=body).json()["jobId"]
        wait_for(lambda: manager.get(job_id).awaiting == "sms")
        assert "probe-pw-xyz" not in c.get(f"/jobs/{job_id}", headers=H).text
        manager.cancel(job_id)
    assert [(p.server, p.port, p.username, p.password) for p in seen] == [
        ("socks-gateway", 1080, "edge-2", "probe-pw-xyz")]
    parsed = CreateWorkerJob.model_validate(body)
    assert "probe-pw-xyz" not in repr(parsed) and "s3cret-pw" not in repr(parsed)
    assert "probe-pw-xyz" not in repr(parsed.to_spec())
    assert CreateWorkerJob.model_validate(job_body()).to_spec().probe_proxy is None


def test_probe_proxy_validation_never_echoes_password(client):
    resp = client.post("/jobs", headers=H, json=job_body(probeProxy={"server": "", "port": 0,
                                                                      "password": "probe-pw-xyz"}))
    assert resp.status_code == 400 and resp.json()["error"] == "invalid_request"
    assert "probe-pw-xyz" not in resp.text



# --------------------------------------------------------------------------- ações no phone
def _geelark_error(code):
    from app.geelark_api import GeeLarkError
    return GeeLarkError(code, "x", "", "/open/v1/phone/x")


def test_rename_phone(client, geelark):
    resp = client.post("/phones/p2/rename", headers=H, json={"name": "  WhatsApp 4  "})
    assert resp.json() == {"ok": True, "name": "WhatsApp 4"}
    geelark.rename_phone.assert_called_once_with("p2", "WhatsApp 4")
    assert client.post("/phones/p2/rename", headers=H, json={"name": "   "}).status_code == 400
    geelark.rename_phone.side_effect = _geelark_error(42001)
    resp = client.post("/phones/p2/rename", headers=H, json={"name": "Outro"})
    assert (resp.status_code, resp.json()["error"]) == (404, "phone_not_found")


def test_new_device_on_an_off_phone_forgets_its_apps(client, geelark):
    geelark.phone_status.return_value = 2
    client.manager._apps["p2"] = {"whatsapp": True, "business": False}
    assert client.post("/phones/p2/new-device", headers=H).json() == {"ok": True}
    geelark.new_device.assert_called_once_with("p2")
    geelark.stop_phone.assert_not_called()
    assert client.manager.known_apps("p2") is None


@pytest.mark.parametrize("code,status,error", [(44004, 409, "daily_limit"), (45004, 409, "egress_offline"),
                                               (43015, 409, "not_supported"), (12345, 502, "geelark_error")])
def test_new_device_errors(client, geelark, code, status, error):
    geelark.phone_status.return_value = 2
    geelark.new_device.side_effect = _geelark_error(code)
    resp = client.post("/phones/p2/new-device", headers=H)
    assert (resp.status_code, resp.json()["error"]) == (status, error)


def test_delete_stops_a_running_phone_first(client, geelark, monkeypatch):
    import app.main as main_module
    monkeypatch.setattr(main_module.time, "sleep", lambda s: None)
    geelark.phone_status.side_effect = [0, 0, 2]
    assert client.delete("/phones/p1", headers=H).json() == {"ok": True}
    geelark.stop_phone.assert_called_once_with("p1")
    geelark.delete_phone.assert_called_once_with("p1")


def test_phone_actions_refuse_a_phone_in_use(client, geelark):
    resp = client.post("/jobs", headers=H, json=job_body())
    job_id = resp.json()["jobId"]
    wait_for(lambda: client.get(f"/jobs/{job_id}", headers=H).json()["awaiting"] == "sms")
    for method, path in (("delete", "/phones/p1"), ("post", "/phones/p1/new-device")):
        resp = getattr(client, method)(path, headers=H)
        assert (resp.status_code, resp.json()["error"]) == (409, "phone_busy")
    geelark.delete_phone.assert_not_called()
    geelark.new_device.assert_not_called()

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


def test_stop_phone(client, geelark):
    assert client.post("/phones/p1/stop", headers=H).json() == {"ok": True}
    geelark.stop_phone.assert_called_once_with("p1")


def test_job_lifecycle_over_http(client, factory):
    resp = client.post("/jobs", headers=H, json=job_body())
    assert resp.status_code == 201
    job = resp.json()
    assert set(job) == {"jobId", "phoneId", "app", "number", "status", "step", "awaiting", "message",
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
    factory = FakeFactory(fail={"enter_number": JobError("unknown_screen", "tela nova")})
    manager = JobManager(factory, input_timeout_s=5, job_timeout_s=10)
    app = create_app(Settings(worker_token=TOKEN), geelark=geelark, manager=manager)
    with TestClient(app) as c:
        job_id = c.post("/jobs", headers=H, json=job_body()).json()["jobId"]
        wait_for(lambda: manager.get(job_id).finished.is_set())
        job = c.get(f"/jobs/{job_id}", headers=H).json()
        assert job["status"] == "failed" and job["errorCode"] == "unknown_screen" and job["hasScreenshot"] is True
        shot = c.get(f"/jobs/{job_id}/screenshot", headers=H)
        assert shot.status_code == 200 and shot.headers["content-type"] == "image/png" and shot.content == PNG
        # cancelar um job terminado devolve o estado atual
        assert c.post(f"/jobs/{job_id}/cancel", headers=H).json()["status"] == "failed"


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

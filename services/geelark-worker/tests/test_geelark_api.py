"""Cliente da API do GeeLark sem rede (HTTP mockado)."""

from __future__ import annotations

from unittest import mock

import pytest
import requests

from app import geelark_api
from app.geelark_api import GeeLarkAPI, GeeLarkError


def fake_response(payload, status=200):
    resp = mock.Mock()
    resp.status_code = status
    resp.json.return_value = payload
    return resp


@pytest.fixture
def sleeps():
    return []


@pytest.fixture
def api(sleeps):
    client = GeeLarkAPI("tok", min_interval=0, sleep=sleeps.append)
    client._session = mock.Mock()
    return client


def test_success_returns_data_and_sends_headers(api):
    api._session.post.return_value = fake_response({"code": 0, "data": {"x": 1}})
    assert api.call("/p", {"a": 1}) == {"x": 1}
    kwargs = api._session.post.call_args.kwargs
    assert api._session.post.call_args.args[0] == "https://openapi.geelark.com/p"
    assert kwargs["json"] == {"a": 1}
    assert kwargs["headers"]["Authorization"] == "Bearer tok"
    assert len(kwargs["headers"]["traceId"]) == 36


def test_trace_id_changes_per_call(api):
    api._session.post.return_value = fake_response({"code": 0, "data": None})
    api.call("/p")
    api.call("/p")
    ids = {c.kwargs["headers"]["traceId"] for c in api._session.post.call_args_list}
    assert len(ids) == 2


def test_rate_limit_is_retried_after_60s(api, sleeps):
    api._session.post.side_effect = [
        fake_response({"code": 40007, "msg": "too many"}),
        fake_response({"code": 0, "data": "ok"}),
    ]
    assert api.call("/p") == "ok"
    assert 60 in sleeps


def test_concurrency_limit_is_retried_after_10s(api, sleeps):
    api._session.post.side_effect = [
        fake_response({"code": 47002, "msg": "busy"}),
        fake_response({"code": 0, "data": "ok"}),
    ]
    assert api.call("/p") == "ok"
    assert 10 in sleeps


@pytest.mark.parametrize("code", [40014, 40003, 40001])
def test_auth_errors_are_not_retried(api, code):
    api._session.post.return_value = fake_response({"code": code, "msg": "auth"})
    with pytest.raises(GeeLarkError) as exc:
        api.call("/p")
    assert exc.value.code == code
    assert api._session.post.call_count == 1


def test_network_errors_retry_then_raise(api, sleeps):
    api._session.post.side_effect = requests.ConnectionError("boom")
    with pytest.raises(GeeLarkError):
        api.call("/p", retries=2)
    assert api._session.post.call_count == 3
    assert sleeps == [1, 2]


def test_missing_token_never_calls_http():
    client = GeeLarkAPI("", min_interval=0)
    client._session = mock.Mock()
    with pytest.raises(GeeLarkError):
        client.call("/p")
    client._session.post.assert_not_called()
    assert "tok" not in repr(GeeLarkAPI("tok"))


def test_calls_are_spaced_by_min_interval():
    waits = []
    client = GeeLarkAPI("tok", sleep=waits.append)  # padrão: 350 ms
    client._session = mock.Mock()
    client._session.post.return_value = fake_response({"code": 0, "data": None})
    for _ in range(3):
        client.call("/p")
    # sleep falso: entre chamadas seguidas o cliente pede ~350 ms de espera
    assert len(waits) == 2 and all(0.3 < w <= 0.35 for w in waits)


def test_phone_status_and_batch_failure(api):
    api._session.post.return_value = fake_response({"code": 0, "data": {
        "successDetails": [{"id": "p1", "status": 2}]}})
    assert api.phone_status("p1") == geelark_api.PHONE_OFF
    api._session.post.return_value = fake_response({"code": 0, "data": {
        "failDetails": [{"id": "p1", "code": 42001, "msg": "env not found"}]}})
    with pytest.raises(GeeLarkError) as exc:
        api.phone_status("p1")
    assert exc.value.code == 42001


def test_start_and_stop_send_ids(api):
    api._session.post.return_value = fake_response({"code": 0, "data": {"successDetails": [{"id": "p1"}]}})
    api.start_phone("p1")
    api.stop_phone("p1")
    calls = api._session.post.call_args_list
    assert calls[0].args[0].endswith("/open/v1/phone/start") and calls[0].kwargs["json"] == {"ids": ["p1"]}
    assert calls[1].args[0].endswith("/open/v1/phone/stop")


def test_update_proxy_body_and_45004(api):
    api._session.post.return_value = fake_response({"code": 45004, "msg": "check proxy failed"})
    with pytest.raises(GeeLarkError) as exc:
        api.update_proxy("p1", 1, "edge", 1080, "node", "pw")
    assert exc.value.code == geelark_api.PROXY_CHECK_FAILED
    assert "pw" not in str(exc.value)
    body = api._session.post.call_args.kwargs["json"]
    assert body == {"id": "p1", "proxyConfig": {"typeId": 1, "server": "edge", "port": 1080,
                                                 "username": "node", "password": "pw"}}


def test_adb_info_none_until_ready_and_numeric_port(api):
    api._session.post.return_value = fake_response({"code": 0, "data": {"items": [{"id": "p1", "code": 0, "port": ""}]}})
    assert api.adb_info("p1") is None
    api._session.post.return_value = fake_response({"code": 0, "data": {"items": [
        {"id": "p1", "code": 0, "ip": "1.2.3.4", "port": 5555, "pwd": "abc"}]}})
    assert api.adb_info("p1") == {"ip": "1.2.3.4", "port": "5555", "pwd": "abc"}


def test_list_phones_paginates(api):
    page1 = [{"id": str(i)} for i in range(100)]
    api._session.post.side_effect = [
        fake_response({"code": 0, "data": {"items": page1, "total": 101}}),
        fake_response({"code": 0, "data": {"items": [{"id": "100"}], "total": 101}}),
    ]
    assert len(api.list_phones()) == 101
    assert api._session.post.call_args.kwargs["json"] == {"page": 2, "pageSize": 100}


def test_http_error_is_geelark_error(api):
    api._session.post.return_value = fake_response({}, status=502)
    with pytest.raises(GeeLarkError) as exc:
        api.call("/p")
    assert exc.value.code == 502

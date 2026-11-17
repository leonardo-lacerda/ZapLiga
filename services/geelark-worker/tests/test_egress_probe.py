"""Probe do IP do PC (app/egress_probe.py) pelo gateway + edge reais, contra um HTTP local."""

from __future__ import annotations

import asyncio
import threading

import pytest

from app.automation import ProbeProxySpec
from app.egress_probe import ProbeFailed, probe_egress_ip
from app.socks5 import SocksConfig, SocksServer

PASSWORD = "s3nha-do-gateway"


class Stack:
    """gateway -> edge -> servidor HTTP, num event loop em outra thread (o probe é síncrono)."""

    def __init__(self, route_path, body: bytes = b"203.0.113.9", status: str = "200 OK"):
        self.route_path = route_path
        self.body = body
        self.status = status
        self.loop = asyncio.new_event_loop()
        self.thread = threading.Thread(target=self.loop.run_forever, daemon=True)
        self.thread.start()
        self.servers: list = []
        self.http_port, self.gateway_port = self._run(self._start())

    def _run(self, coro):
        return asyncio.run_coroutine_threadsafe(coro, self.loop).result(10)

    async def _start(self):
        async def http(reader, writer):
            await reader.readuntil(b"\r\n\r\n")
            writer.write(f"HTTP/1.1 {self.status}\r\nContent-Length: {len(self.body)}\r\n"
                         "Connection: close\r\n\r\n".encode() + self.body)
            await writer.drain()
            writer.close()

        http_server = await asyncio.start_server(http, "127.0.0.1", 0)
        edge = SocksServer(SocksConfig(mode="edge", host="127.0.0.1", port=0, route_file=str(self.route_path),
                                       allow_private_targets=True))
        await edge.start()
        gateway = SocksServer(SocksConfig(mode="gateway", host="127.0.0.1", port=0, password=PASSWORD,
                                          upstream_template=f"127.0.0.1:{edge.port}", auth_failure_delay=0))
        await gateway.start()
        self.servers = [gateway, edge, http_server]
        return http_server.sockets[0].getsockname()[1], gateway.port

    async def _stop(self):
        for server in self.servers:
            if isinstance(server, SocksServer):
                await server.close()
            else:
                server.close()
                await server.wait_closed()

    def close(self):
        self._run(self._stop())
        self.loop.call_soon_threadsafe(self.loop.stop)
        self.thread.join(5)
        self.loop.close()

    def proxy(self, password: str = PASSWORD, username: str = "edge-1") -> ProbeProxySpec:
        return ProbeProxySpec("127.0.0.1", self.gateway_port, username, password)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.http_port}/"


@pytest.fixture
def route(tmp_path):
    path = tmp_path / "route"
    path.write_text("pc\n", encoding="utf-8")
    return path


@pytest.fixture
def stack(route):
    s = Stack(route)
    yield s
    s.close()


def test_probe_returns_the_ip_seen_through_the_pc(stack):
    assert probe_egress_ip(stack.proxy(), url=stack.url, timeout=5) == "203.0.113.9"


def test_probe_wrong_password_never_leaks_it(stack):
    with pytest.raises(ProbeFailed) as exc:
        probe_egress_ip(stack.proxy(password="senha-errada-123"), url=stack.url, timeout=5)
    assert "usuário/senha" in exc.value.reason
    assert "senha-errada-123" not in str(exc.value) and "senha-errada-123" not in repr(exc.value)
    assert "senha-errada-123" not in repr(stack.proxy(password="senha-errada-123"))


@pytest.mark.parametrize("content", ["offline\n", "vps\n", None])
def test_probe_fails_when_slot_is_not_on_the_pc(stack, route, content):
    if content is None:
        route.unlink()
    else:
        route.write_text(content, encoding="utf-8")
    with pytest.raises(ProbeFailed) as exc:
        probe_egress_ip(stack.proxy(), url=stack.url, timeout=5)
    assert "SOCKS 2" in exc.value.reason


def test_probe_rejects_non_ip_body(route):
    s = Stack(route, body=b"<html>oops</html>")
    try:
        with pytest.raises(ProbeFailed) as exc:
            probe_egress_ip(s.proxy(), url=s.url, timeout=5)
        assert "não devolveu um IP" in exc.value.reason
    finally:
        s.close()


def test_probe_rejects_http_error(route):
    s = Stack(route, status="503 Service Unavailable", body=b"")
    try:
        with pytest.raises(ProbeFailed) as exc:
            probe_egress_ip(s.proxy(), url=s.url, timeout=5)
        assert "HTTP 503" in exc.value.reason
    finally:
        s.close()


def test_probe_fails_when_proxy_is_down():
    proxy = ProbeProxySpec("127.0.0.1", 1, "edge-1", PASSWORD)  # nada escutando
    with pytest.raises(ProbeFailed) as exc:
        probe_egress_ip(proxy, url="http://127.0.0.1:9/", timeout=3)
    assert "falha de rede" in exc.value.reason
    assert PASSWORD not in str(exc.value)

"""Proxy SOCKS5 do cadastro (app/socks5.py): edge, gateway e os dois juntos, tudo em processo."""

from __future__ import annotations

import asyncio
import ipaddress
import logging

import pytest

from app.socks5 import SocksConfig, SocksServer, main, parse_slots, read_route

PASSWORD = "s3nha-do-gateway"
TIMEOUT = 5


# --------------------------------------------------------------------------- helpers
async def start(mode: str, **overrides) -> SocksServer:
    fields = dict(mode=mode, host="127.0.0.1", port=0, auth_failure_delay=0,
                  allow_private_targets=True, route_check_interval=0.05)
    fields.update(overrides)
    server = SocksServer(SocksConfig(**fields))
    await server.start()
    return server


async def echo_server():
    async def handle(reader, writer):
        try:
            while data := await reader.read(4096):
                writer.write(data)
                await writer.drain()
        except ConnectionError:
            pass
        finally:
            writer.close()

    server = await asyncio.start_server(handle, "127.0.0.1", 0)
    return server, server.sockets[0].getsockname()[1]


def _addr(host: str, port: int, atyp: str | None) -> bytes:
    if atyp == "domain" or atyp is None and not _is_ip(host):
        name = host.encode()
        return bytes([3, len(name)]) + name + port.to_bytes(2, "big")
    ip = ipaddress.ip_address(host)
    return bytes([1 if ip.version == 4 else 4]) + ip.packed + port.to_bytes(2, "big")


def _is_ip(host: str) -> bool:
    try:
        ipaddress.ip_address(host)
        return True
    except ValueError:
        return False


async def socks_open(port: int, host: str, target_port: int, *, user: str | None = None,
                     password: str | None = None, cmd: int = 1, atyp: str | None = None,
                     methods: bytes | None = None):
    """Cliente SOCKS5 de teste. Devolve (etapa, código, reader, writer).

    etapa: "method" (servidor recusou os métodos), "auth" (recusou usuário/senha) ou
    "connect" (código = REP da resposta ao CONNECT).
    """
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    if methods is None:
        methods = b"\x02" if user is not None else b"\x00"
    writer.write(bytes([5, len(methods)]) + methods)
    ver, method = await asyncio.wait_for(reader.readexactly(2), TIMEOUT)
    assert ver == 5
    if method == 0xFF:
        return "method", method, reader, writer
    if method == 0x02:
        u, p = (user or "").encode(), (password or "").encode()
        writer.write(bytes([1, len(u)]) + u + bytes([len(p)]) + p)
        _, status = await asyncio.wait_for(reader.readexactly(2), TIMEOUT)
        if status != 0:
            return "auth", status, reader, writer
    writer.write(bytes([5, cmd, 0]) + _addr(host, target_port, atyp))
    head = await asyncio.wait_for(reader.readexactly(4), TIMEOUT)
    assert head[0] == 5
    rest = {1: 6, 4: 18}.get(head[3])
    if rest is None:
        ln = (await reader.readexactly(1))[0]
        rest = ln + 2
    await asyncio.wait_for(reader.readexactly(rest), TIMEOUT)
    return "connect", head[1], reader, writer


async def roundtrip(reader, writer, payload: bytes = b"ola pelo PC") -> bytes:
    writer.write(payload)
    await writer.drain()
    return await asyncio.wait_for(reader.readexactly(len(payload)), TIMEOUT)


async def closed(reader) -> bool:
    try:
        return await asyncio.wait_for(reader.read(1), TIMEOUT) == b""
    except ConnectionError:
        return True


async def stop(*servers) -> None:
    for server in servers:
        if isinstance(server, SocksServer):
            await server.close()
        else:
            server.close()
            await server.wait_closed()


def run(coro):
    return asyncio.run(asyncio.wait_for(coro, 20))


@pytest.fixture
def route(tmp_path):
    path = tmp_path / "route"
    path.write_text("pc\n", encoding="utf-8")
    return path


# --------------------------------------------------------------------------- edge
def test_edge_relays_when_route_is_pc(route):
    async def scenario():
        echo, echo_port = await echo_server()
        edge = await start("edge", route_file=str(route))
        try:
            stage, code, r, w = await socks_open(edge.port, "127.0.0.1", echo_port)
            assert (stage, code) == ("connect", 0)
            assert await roundtrip(r, w) == b"ola pelo PC"
            w.close()
        finally:
            await stop(edge, echo)

    run(scenario())


@pytest.mark.parametrize("content", ["offline\n", "vps\n", "idle\n", "", "pc-ish\n", None])
def test_edge_refuses_unless_route_is_exactly_pc(route, content):
    if content is None:
        route.unlink()
    else:
        route.write_text(content, encoding="utf-8")

    async def scenario():
        echo, echo_port = await echo_server()
        edge = await start("edge", route_file=str(route))
        try:
            stage, code, r, w = await socks_open(edge.port, "127.0.0.1", echo_port)
            assert (stage, code) == ("connect", 2)        # not allowed by ruleset
            assert await closed(r)
        finally:
            await stop(edge, echo)

    run(scenario())


def test_edge_resolves_domain_names(route):
    async def scenario():
        echo, echo_port = await echo_server()
        edge = await start("edge", route_file=str(route))
        try:
            stage, code, r, w = await socks_open(edge.port, "localhost", echo_port, atyp="domain")
            assert (stage, code) == ("connect", 0)
            assert await roundtrip(r, w) == b"ola pelo PC"
            w.close()
        finally:
            await stop(edge, echo)

    run(scenario())


@pytest.mark.parametrize("target", ["127.0.0.1", "localhost", "10.0.0.5", "100.100.100.100", "::1"])
def test_edge_refuses_non_public_targets_by_default(route, target):
    async def scenario():
        edge = await start("edge", route_file=str(route), allow_private_targets=False)
        try:
            stage, code, r, _ = await socks_open(edge.port, target, 5432)
            assert (stage, code) == ("connect", 2)
            assert await closed(r)
        finally:
            await stop(edge)

    run(scenario())


def test_edge_maps_connection_refused(route):
    async def scenario():
        echo, echo_port = await echo_server()
        await stop(echo)                                     # porta fechada
        edge = await start("edge", route_file=str(route))
        try:
            stage, code, _, _ = await socks_open(edge.port, "127.0.0.1", echo_port)
            assert (stage, code) == ("connect", 5)
        finally:
            await stop(edge)

    run(scenario())


@pytest.mark.parametrize("cmd", [2, 9])                    # BIND, comando inexistente
def test_edge_only_supports_connect(route, cmd):
    async def scenario():
        edge = await start("edge", route_file=str(route))
        try:
            stage, code, _, _ = await socks_open(edge.port, "127.0.0.1", 9, cmd=cmd)
            assert (stage, code) == ("connect", 7)
        finally:
            await stop(edge)

    run(scenario())


def test_edge_requires_no_auth_method(route):
    async def scenario():
        edge = await start("edge", route_file=str(route))
        try:
            stage, code, _, _ = await socks_open(edge.port, "127.0.0.1", 9, methods=b"\x02")
            assert (stage, code) == ("method", 0xFF)
        finally:
            await stop(edge)

    run(scenario())


def test_edge_drops_open_connections_when_route_leaves_pc(route):
    async def scenario():
        echo, echo_port = await echo_server()
        edge = await start("edge", route_file=str(route))
        try:
            _, code, r, w = await socks_open(edge.port, "127.0.0.1", echo_port)
            assert code == 0 and await roundtrip(r, w) == b"ola pelo PC"
            route.write_text("vps\n", encoding="utf-8")
            assert await closed(r)
        finally:
            await stop(edge, echo)

    run(scenario())


def test_idle_timeout_closes_the_tunnel(route):
    async def scenario():
        echo, echo_port = await echo_server()
        edge = await start("edge", route_file=str(route), idle_timeout=0.2)
        try:
            _, code, r, _ = await socks_open(edge.port, "127.0.0.1", echo_port)
            assert code == 0
            assert await closed(r)
        finally:
            await stop(edge, echo)

    run(scenario())


def test_max_connections(route):
    async def scenario():
        echo, echo_port = await echo_server()
        edge = await start("edge", route_file=str(route), max_connections=1)
        try:
            _, code, r1, w1 = await socks_open(edge.port, "127.0.0.1", echo_port)
            assert code == 0
            r2, _ = await asyncio.open_connection("127.0.0.1", edge.port)
            assert await closed(r2)                          # segunda conexão recusada
            assert await roundtrip(r1, w1) == b"ola pelo PC"  # a primeira segue de pé
            w1.close()
        finally:
            await stop(edge, echo)

    run(scenario())


# --------------------------------------------------------------------------- gateway
async def chain(route_path, **gateway_overrides):
    echo, echo_port = await echo_server()
    edge = await start("edge", route_file=str(route_path))
    # UDP numa porta própria: no Windows a mesma porta efêmera do TCP às vezes não abre em UDP.
    fields = dict(password=PASSWORD, upstream_template=f"127.0.0.1:{edge.port}", udp_port=0)
    fields.update(gateway_overrides)
    gateway = await start("gateway", **fields)
    return echo, echo_port, edge, gateway


@pytest.mark.parametrize("target,atyp", [("127.0.0.1", None), ("localhost", "domain")])
def test_gateway_to_edge_end_to_end(route, target, atyp, caplog):
    caplog.set_level(logging.INFO, logger="socks5")

    async def scenario():
        echo, echo_port, edge, gateway = await chain(route)
        try:
            stage, code, r, w = await socks_open(gateway.port, target, echo_port, user="edge-1",
                                                 password=PASSWORD, atyp=atyp)
            assert (stage, code) == ("connect", 0)
            assert await roundtrip(r, w, b"x" * 100_000) == b"x" * 100_000
            w.close()
            await closed(r)
        finally:
            await stop(gateway, edge, echo)

    run(scenario())
    gateway_lines = [r.getMessage() for r in caplog.records if "socks5 gateway" in r.getMessage()]
    assert any("slot=edge-1" in line and f"target={target}:" in line and "result=ok" in line
               for line in gateway_lines)
    assert PASSWORD not in caplog.text


def test_gateway_upstream_template_uses_slot_number():
    cfg = SocksConfig(mode="gateway")
    assert cfg.upstream_for("edge-7") == ("tailscale-edge-7", 1080)
    assert SocksConfig(mode="gateway", upstream_template="[::1]:{n}080").upstream_for("edge-2") == ("::1", 2080)


@pytest.mark.parametrize("user,password", [
    ("edge-1", "errada"),
    ("edge-1", ""),
    ("edge-11", PASSWORD),          # fora de EGRESS_SLOTS
    ("edge-01x", PASSWORD),
    ("admin", PASSWORD),
    ("", PASSWORD),
])
def test_gateway_rejects_bad_credentials(route, user, password, caplog):
    caplog.set_level(logging.INFO, logger="socks5")

    async def scenario():
        echo, echo_port, edge, gateway = await chain(route)
        try:
            stage, code, r, _ = await socks_open(gateway.port, "127.0.0.1", echo_port, user=user, password=password)
            assert (stage, code) == ("auth", 1)
            assert await closed(r)
            assert edge.active == 0
        finally:
            await stop(gateway, edge, echo)

    run(scenario())
    assert PASSWORD not in caplog.text


def test_gateway_with_empty_password_refuses_everyone(route, caplog):
    caplog.set_level(logging.INFO, logger="socks5")

    async def scenario():
        echo, echo_port, edge, gateway = await chain(route, password="")
        try:
            for password in ("", "qualquer"):
                stage, code, _, _ = await socks_open(gateway.port, "127.0.0.1", echo_port,
                                                     user="edge-1", password=password)
                assert (stage, code) == ("auth", 1)
        finally:
            await stop(gateway, edge, echo)

    run(scenario())
    assert "result=auth_disabled" in caplog.text


def test_gateway_custom_slot_list(route):
    async def scenario():
        echo, echo_port, edge, gateway = await chain(route, slots=parse_slots("edge-3"))
        try:
            stage, code, _, _ = await socks_open(gateway.port, "127.0.0.1", echo_port, user="edge-1", password=PASSWORD)
            assert (stage, code) == ("auth", 1)
            stage, code, _, w = await socks_open(gateway.port, "127.0.0.1", echo_port, user="edge-3", password=PASSWORD)
            assert (stage, code) == ("connect", 0)
            w.close()
        finally:
            await stop(gateway, edge, echo)

    run(scenario())


def test_gateway_requires_user_pass_method(route):
    async def scenario():
        echo, echo_port, edge, gateway = await chain(route)
        try:
            stage, code, _, _ = await socks_open(gateway.port, "127.0.0.1", echo_port, methods=b"\x00")
            assert (stage, code) == ("method", 0xFF)
        finally:
            await stop(gateway, edge, echo)

    run(scenario())


def test_gateway_forwards_edge_refusal_when_pc_offline(route):
    route.write_text("offline\n", encoding="utf-8")

    async def scenario():
        echo, echo_port, edge, gateway = await chain(route)
        try:
            stage, code, r, _ = await socks_open(gateway.port, "127.0.0.1", echo_port, user="edge-1", password=PASSWORD)
            assert (stage, code) == ("connect", 2)
            assert await closed(r)
        finally:
            await stop(gateway, edge, echo)

    run(scenario())


def test_gateway_reports_unreachable_slot(route):
    async def scenario():
        echo, echo_port = await echo_server()
        dead, dead_port = await echo_server()
        await stop(dead)                                     # nada escutando na vaga
        gateway = await start("gateway", password=PASSWORD, upstream_template=f"127.0.0.1:{dead_port}")
        try:
            stage, code, _, _ = await socks_open(gateway.port, "127.0.0.1", echo_port, user="edge-1", password=PASSWORD)
            assert (stage, code) == ("connect", 3)            # network unreachable
        finally:
            await stop(gateway, echo)

    run(scenario())


def test_gateway_only_supports_connect(route):
    async def scenario():
        echo, echo_port, edge, gateway = await chain(route)
        try:
            stage, code, _, _ = await socks_open(gateway.port, "127.0.0.1", echo_port, user="edge-1",
                                                 password=PASSWORD, cmd=2)     # BIND
            assert (stage, code) == ("connect", 7)
            assert edge.active == 0
        finally:
            await stop(gateway, edge, echo)

    run(scenario())


def test_gateway_ipv6_target_is_forwarded(route):
    async def scenario():
        echo, echo_port, edge, gateway = await chain(route)
        try:
            # ::1 não é público e o edge de produção recusaria; aqui só conferimos o repasse do ATYP 4.
            stage, code, _, _ = await socks_open(gateway.port, "::1", echo_port, user="edge-1", password=PASSWORD)
            assert stage == "connect" and code in (0, 1, 3, 4, 5)
        finally:
            await stop(gateway, edge, echo)

    run(scenario())


# --------------------------------------------------------------------------- config / cli
def test_config_from_env():
    cfg = SocksConfig.from_env("gateway", {
        "EGRESS_SOCKS_PASSWORD": PASSWORD, "EGRESS_SLOTS": "edge-1, edge-2",
        "SOCKS_CONNECT_TIMEOUT": "3", "SOCKS_MAX_CONNECTIONS": "10",
    })
    assert cfg.slots == {"edge-1", "edge-2"} and cfg.connect_timeout == 3 and cfg.max_connections == 10
    assert PASSWORD not in repr(cfg)
    assert SocksConfig.from_env("edge", {}).slots == {f"edge-{n}" for n in range(1, 11)}
    with pytest.raises(ValueError):
        parse_slots("edge-1,tailscale")
    with pytest.raises(ValueError):
        SocksConfig(mode="proxy")


def test_read_route(tmp_path):
    assert read_route(str(tmp_path / "nada")) is None
    (tmp_path / "r").write_text(" pc \n", encoding="utf-8")
    assert read_route(str(tmp_path / "r")) == "pc"


def test_cli_rejects_unknown_mode(capsys):
    assert main(["proxy"]) == 2
    assert "edge|gateway" in capsys.readouterr().err


# --------------------------------------------------------------------------- UDP
from app.socks5 import parse_udp_header, udp_header  # noqa: E402


class _Inbox(asyncio.DatagramProtocol):
    def __init__(self):
        self.queue: asyncio.Queue = asyncio.Queue()

    def datagram_received(self, data, addr):
        self.queue.put_nowait((data, addr))


async def udp_socket():
    loop = asyncio.get_running_loop()
    transport, inbox = await loop.create_datagram_endpoint(_Inbox, local_addr=("127.0.0.1", 0))
    return transport, inbox


async def udp_echo():
    class Echo(asyncio.DatagramProtocol):
        def connection_made(self, transport):
            self.transport = transport

        def datagram_received(self, data, addr):
            self.transport.sendto(b"eco:" + data, addr)

    loop = asyncio.get_running_loop()
    transport, _ = await loop.create_datagram_endpoint(Echo, local_addr=("127.0.0.1", 0))
    return transport, transport.get_extra_info("sockname")[1]


async def udp_associate(port: int, *, user=None, password=None, hint_port: int = 0):
    """UDP ASSOCIATE de teste: devolve (código, (host, porta) do relay, reader, writer)."""
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    writer.write(b"\x05\x01" + (b"\x02" if user else b"\x00"))
    _ver, method = await asyncio.wait_for(reader.readexactly(2), TIMEOUT)
    if method == 0x02:
        u, p = user.encode(), password.encode()
        writer.write(bytes([1, len(u)]) + u + bytes([len(p)]) + p)
        _, status = await asyncio.wait_for(reader.readexactly(2), TIMEOUT)
        assert status == 0
    writer.write(bytes([5, 3, 0, 1, 0, 0, 0, 0]) + hint_port.to_bytes(2, "big"))
    head = await asyncio.wait_for(reader.readexactly(4), TIMEOUT)
    rest = await asyncio.wait_for(reader.readexactly(6 if head[3] == 1 else 18), TIMEOUT)
    host = str(ipaddress.ip_address(rest[:-2]))
    return head[1], (host, int.from_bytes(rest[-2:], "big")), reader, writer


async def recv(inbox, timeout=2.0):
    try:
        return await asyncio.wait_for(inbox.queue.get(), timeout)
    except (asyncio.TimeoutError, TimeoutError):
        return None


def relay_of(bound):
    host, port = bound
    return ("127.0.0.1" if host == "0.0.0.0" else host), port


def test_udp_header_roundtrip_and_fragments_are_dropped():
    data = udp_header("203.0.113.9", 5222) + b"oi"
    atyp, host, port, size = parse_udp_header(data)
    assert (atyp, host, port, data[size:]) == (1, "203.0.113.9", 5222, b"oi")
    assert parse_udp_header(b"\x00\x00\x01" + data[3:]) is None        # FRAG != 0
    assert parse_udp_header(b"\x00\x00\x00\x03\x03ab") is None          # truncado
    named = b"\x00\x00\x00\x03\x0bexample.com\x00\x35dns"
    assert parse_udp_header(named)[1:3] == ("example.com", 53)


def test_edge_udp_goes_out_and_only_answers_from_contacted_peers(route):
    async def scenario():
        echo, echo_port = await udp_echo()
        edge = await start("edge", route_file=str(route))
        client, inbox = await udp_socket()
        stranger, _ = await udp_socket()
        try:
            code, bound, r, w = await udp_associate(edge.port)
            assert code == 0
            relay = relay_of(bound)
            client.sendto(udp_header("127.0.0.1", echo_port) + b"ping", relay)
            data, _ = await recv(inbox)
            assert data == udp_header("127.0.0.1", echo_port) + b"eco:ping"
            # Alguém que o phone nunca contatou manda para o relay: não chega no phone.
            stranger.sendto(b"intruso", relay)
            assert await recv(inbox, 0.5) is None
            w.close()
            await asyncio.sleep(0.2)
            assert edge.active == 0                          # fechou o controle: fim da associação
        finally:
            client.close()
            stranger.close()
            echo.close()
            await stop(edge)

    run(scenario())


@pytest.mark.parametrize("content", ["offline", "vps", ""])
def test_edge_udp_refused_unless_route_is_pc(route, content):
    async def scenario():
        route.write_text(content, encoding="utf-8")
        edge = await start("edge", route_file=str(route))
        try:
            code, _, _, _ = await udp_associate(edge.port)
            assert code == 2
        finally:
            await stop(edge)

    run(scenario())


def test_edge_udp_stops_when_route_leaves_pc(route):
    async def scenario():
        echo, echo_port = await udp_echo()
        edge = await start("edge", route_file=str(route))
        client, inbox = await udp_socket()
        try:
            _code, bound, r, _w = await udp_associate(edge.port)
            route.write_text("offline", encoding="utf-8")
            await asyncio.sleep(0.2)
            client.sendto(udp_header("127.0.0.1", echo_port) + b"ping", relay_of(bound))
            assert await recv(inbox, 0.5) is None
            assert await closed(r)
        finally:
            client.close()
            echo.close()
            await stop(edge)

    run(scenario())


def test_gateway_udp_end_to_end_through_the_edge(route, caplog):
    caplog.set_level(logging.INFO, logger="socks5")

    async def scenario():
        echo, echo_port = await udp_echo()
        tcp_echo, _, edge, gateway = await chain(route, public_host="198.51.100.7")
        client, inbox = await udp_socket()
        try:
            code, bound, _r, w = await udp_associate(gateway.port, user="edge-1", password=PASSWORD)
            assert code == 0
            # Anuncia o IP público configurado e a porta UDP do gateway.
            assert bound == ("198.51.100.7", gateway.udp_port)
            client.sendto(udp_header("127.0.0.1", echo_port) + b"ola", ("127.0.0.1", gateway.udp_port))
            data, _ = await recv(inbox)
            assert data == udp_header("127.0.0.1", echo_port) + b"eco:ola"
            w.close()
            await asyncio.sleep(0.3)
            assert gateway.active == 0 and edge.active == 0
        finally:
            client.close()
            echo.close()
            await stop(gateway, edge, tcp_echo)
        assert "target=udp result=ok" in caplog.text and PASSWORD not in caplog.text

    run(scenario())


def test_gateway_udp_ignores_unknown_senders(route):
    async def scenario():
        echo, echo_port = await udp_echo()
        tcp_echo, _, edge, gateway = await chain(route)
        client, inbox = await udp_socket()
        other, other_inbox = await udp_socket()
        try:
            _code, _bound, _r, _w = await udp_associate(gateway.port, user="edge-1", password=PASSWORD)
            relay = ("127.0.0.1", gateway.udp_port)
            client.sendto(udp_header("127.0.0.1", echo_port) + b"1", relay)
            assert (await recv(inbox))[0].endswith(b"eco:1")
            # Outro socket do mesmo IP, sem associação própria: descartado.
            other.sendto(udp_header("127.0.0.1", echo_port) + b"2", relay)
            assert await recv(other_inbox, 0.5) is None
        finally:
            client.close()
            other.close()
            echo.close()
            await stop(gateway, edge, tcp_echo)

    run(scenario())


def test_gateway_udp_can_be_turned_off(route):
    async def scenario():
        tcp_echo, _, edge, gateway = await chain(route, udp_enabled=False)
        try:
            stage, code, _, _ = await socks_open(gateway.port, "0.0.0.0", 0, user="edge-1",
                                                 password=PASSWORD, cmd=3)
            assert (stage, code) == ("connect", 7) and gateway.udp_port is None
        finally:
            await stop(gateway, edge, tcp_echo)

    run(scenario())


def test_config_reads_udp_settings():
    cfg = SocksConfig.from_env("gateway", {"EGRESS_SOCKS_PUBLIC_HOST": "203.0.113.5", "EGRESS_SOCKS_PORT": "1090",
                                           "SOCKS_UDP": "0"})
    assert (cfg.public_host, cfg.public_udp_port, cfg.udp_enabled) == ("203.0.113.5", 1090, False)
    assert SocksConfig.from_env("gateway", {}).udp_enabled is True

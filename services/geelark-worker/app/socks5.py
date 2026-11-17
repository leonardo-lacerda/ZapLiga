"""Proxy SOCKS5 do cadastro (docs/provisioning-contract.md, seção 4). Só stdlib (asyncio).

O cloud phone do GeeLark precisa sair para a internet pelo PC do atendente, como as linhas
que já usam a vaga `edge-N` (docs/saida-pelo-pc-do-atendente.md). Dois modos, mesma imagem
do geelark-worker:

``edge``
    Um por vaga (`socks-edge-N`, dentro da rede do `tailscale-edge-N`). Sem senha, só
    CONNECT. A cada conexão nova lê `EGRESS_ROUTE_FILE` (`/egress/route`) e só aceita se o
    conteúdo for exatamente `pc`: com `offline`, `vps`, `idle` ou sem arquivo, recusa — um
    cadastro nunca sai pela VPS. Se a rota deixa de ser `pc`, as conexões abertas caem.
    Os nomes são resolvidos aqui dentro, na rede da vaga (o DNS também sai pelo PC), e só
    endereços públicos são aceitos (nada da rede do Compose, da Tailscale ou loopback).
``gateway``
    Um só (`socks-gateway`), a porta que o GeeLark usa. Usuário/senha (RFC 1929): usuário =
    vaga (`edge-N`, precisa estar em `EGRESS_SLOTS`), senha = `EGRESS_SOCKS_PASSWORD`
    (senha vazia recusa todo mundo). Repassa o CONNECT ao `socks-edge-N` da vaga
    (`EGRESS_UPSTREAM_TEMPLATE`) e copia os bytes nos dois sentidos.

Sem UDP ASSOCIATE nem BIND. Uma linha de log por conexão (vaga, destino, resultado); a senha
nunca vai para o log.

Rodar: ``python -m app.socks5 edge`` ou ``python -m app.socks5 gateway``.
"""

from __future__ import annotations

import asyncio
import errno
import hmac
import ipaddress
import logging
import os
import re
import signal
import socket
import sys
import time
from dataclasses import dataclass, field
from typing import Mapping, NoReturn

log = logging.getLogger("socks5")

SOCKS_VERSION = 5
AUTH_VERSION = 1

METHOD_NO_AUTH = 0x00
METHOD_USER_PASS = 0x02
METHOD_NONE_ACCEPTABLE = 0xFF

CMD_CONNECT = 0x01

ATYP_IPV4 = 0x01
ATYP_DOMAIN = 0x03
ATYP_IPV6 = 0x04

REP_SUCCEEDED = 0x00
REP_GENERAL_FAILURE = 0x01
REP_NOT_ALLOWED = 0x02
REP_NETWORK_UNREACHABLE = 0x03
REP_HOST_UNREACHABLE = 0x04
REP_CONNECTION_REFUSED = 0x05
REP_TTL_EXPIRED = 0x06
REP_COMMAND_NOT_SUPPORTED = 0x07
REP_ADDRESS_NOT_SUPPORTED = 0x08

SLOT_RE = re.compile(r"^edge-(\d{1,2})$")
DEFAULT_SLOTS = frozenset(f"edge-{n}" for n in range(1, 11))
ROUTE_PC = "pc"
RELAY_CHUNK = 64 * 1024


# --------------------------------------------------------------------------- config
def _env_float(env: Mapping[str, str], name: str, default: float) -> float:
    raw = (env.get(name) or "").strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError as exc:
        raise ValueError(f"{name} precisa ser um número") from exc
    if value <= 0:
        raise ValueError(f"{name} precisa ser maior que zero")
    return value


def _env_int(env: Mapping[str, str], name: str, default: int) -> int:
    raw = (env.get(name) or "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise ValueError(f"{name} precisa ser um número inteiro") from exc
    if value < 0:
        raise ValueError(f"{name} não pode ser negativo")
    return value


def parse_slots(raw: str | None) -> frozenset[str]:
    if raw is None or not raw.strip():
        return DEFAULT_SLOTS
    slots = frozenset(s.strip() for s in raw.split(",") if s.strip())
    bad = sorted(s for s in slots if not SLOT_RE.fullmatch(s))
    if bad:
        raise ValueError(f"EGRESS_SLOTS com vaga inválida: {', '.join(bad)} (use edge-N)")
    return slots


def split_host_port(value: str) -> tuple[str, int]:
    host, sep, port = value.strip().rpartition(":")
    if not sep or not host or not port.isdigit():
        raise ValueError(f"endereço inválido (esperado host:porta): {value!r}")
    return host.strip("[]"), int(port)


@dataclass(frozen=True)
class SocksConfig:
    mode: str                                   # "edge" | "gateway"
    host: str = "0.0.0.0"
    port: int = 1080
    slot_name: str = ""                         # só para o log do modo edge (EGRESS_SLOT)
    route_file: str = "/egress/route"
    slots: frozenset[str] = DEFAULT_SLOTS
    password: str = field(default="", repr=False)
    upstream_template: str = "tailscale-edge-{n}:1080"
    handshake_timeout: float = 10.0
    connect_timeout: float = 15.0
    idle_timeout: float = 300.0
    max_connections: int = 256
    route_check_interval: float = 2.0
    auth_failure_delay: float = 1.0             # freia quem tenta adivinhar a senha
    allow_private_targets: bool = False         # só para testes (destino em 127.0.0.1)

    def __post_init__(self) -> None:
        if self.mode not in ("edge", "gateway"):
            raise ValueError(f"modo inválido: {self.mode!r} (use edge ou gateway)")

    @classmethod
    def from_env(cls, mode: str, env: Mapping[str, str] | None = None) -> "SocksConfig":
        env = os.environ if env is None else env
        return cls(
            mode=mode,
            host=(env.get("SOCKS_LISTEN_HOST") or "0.0.0.0").strip(),
            port=_env_int(env, "SOCKS_LISTEN_PORT", 1080),
            slot_name=(env.get("EGRESS_SLOT") or "").strip(),
            route_file=(env.get("EGRESS_ROUTE_FILE") or "/egress/route").strip(),
            slots=parse_slots(env.get("EGRESS_SLOTS")),
            password=env.get("EGRESS_SOCKS_PASSWORD") or "",
            upstream_template=(env.get("EGRESS_UPSTREAM_TEMPLATE") or "tailscale-edge-{n}:1080").strip(),
            connect_timeout=_env_float(env, "SOCKS_CONNECT_TIMEOUT", 15.0),
            idle_timeout=_env_float(env, "SOCKS_IDLE_TIMEOUT", 300.0),
            max_connections=max(1, _env_int(env, "SOCKS_MAX_CONNECTIONS", 256)),
        )

    def upstream_for(self, slot: str) -> tuple[str, int]:
        match = SLOT_RE.fullmatch(slot)
        if not match:
            raise ValueError(f"vaga inválida: {slot!r}")
        return split_host_port(self.upstream_template.format(n=int(match.group(1)), slot=slot))


# --------------------------------------------------------------------------- helpers
class _Refused(Exception):
    """Encerra a conexão; `result` vai para a linha de log."""

    def __init__(self, result: str):
        super().__init__(result)
        self.result = result


class _ConnectFailed(Exception):
    def __init__(self, reply: int, result: str):
        super().__init__(result)
        self.reply = reply
        self.result = result


def read_route(path: str) -> str | None:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return fh.read(64).strip()
    except OSError:
        return None


def encode_address(host: str, port: int) -> bytes:
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        name = host.encode("idna")
        return bytes([ATYP_DOMAIN, len(name)]) + name + port.to_bytes(2, "big")
    atyp = ATYP_IPV4 if ip.version == 4 else ATYP_IPV6
    return bytes([atyp]) + ip.packed + port.to_bytes(2, "big")


def reply(code: int, host: str = "0.0.0.0", port: int = 0) -> bytes:
    return bytes([SOCKS_VERSION, code, 0x00]) + encode_address(host, port)


def is_public(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return ip.is_global and not ip.is_multicast


def _connect_error(exc: BaseException) -> _ConnectFailed:
    if isinstance(exc, (asyncio.TimeoutError, TimeoutError)):
        return _ConnectFailed(REP_TTL_EXPIRED, "timeout")
    if isinstance(exc, socket.gaierror):
        return _ConnectFailed(REP_HOST_UNREACHABLE, "dns_failed")
    if isinstance(exc, ConnectionRefusedError):
        return _ConnectFailed(REP_CONNECTION_REFUSED, "connection_refused")
    if isinstance(exc, OSError):
        if exc.errno in (errno.ENETUNREACH, getattr(errno, "WSAENETUNREACH", -1)):
            return _ConnectFailed(REP_NETWORK_UNREACHABLE, "network_unreachable")
        if exc.errno in (errno.EHOSTUNREACH, getattr(errno, "WSAEHOSTUNREACH", -1)):
            return _ConnectFailed(REP_HOST_UNREACHABLE, "host_unreachable")
        if exc.errno in (errno.ETIMEDOUT, getattr(errno, "WSAETIMEDOUT", -1)):
            return _ConnectFailed(REP_TTL_EXPIRED, "timeout")
    return _ConnectFailed(REP_GENERAL_FAILURE, f"connect_failed:{type(exc).__name__}")


def _abort(writer: asyncio.StreamWriter | None) -> None:
    if writer is not None:
        try:
            writer.transport.abort()
        except Exception:  # pragma: no cover - transporte já fechado
            pass


@dataclass(eq=False)
class _Conn:
    client: str
    slot: str = "-"
    target: str = "-"
    result: str = "error"
    up: int = 0
    down: int = 0
    started: float = field(default_factory=time.monotonic)
    silent: bool = False                       # fechou sem mandar nada (healthcheck/scan)
    client_writer: asyncio.StreamWriter | None = None
    upstream_writer: asyncio.StreamWriter | None = None

    def abort(self) -> None:
        _abort(self.client_writer)
        _abort(self.upstream_writer)


# --------------------------------------------------------------------------- server
class SocksServer:
    def __init__(self, config: SocksConfig):
        self.config = config
        self._server: asyncio.base_events.Server | None = None
        self._watchdog: asyncio.Task | None = None
        self._conns: set[_Conn] = set()

    @property
    def port(self) -> int:
        assert self._server is not None
        return self._server.sockets[0].getsockname()[1]

    @property
    def active(self) -> int:
        return len(self._conns)

    async def start(self) -> None:
        cfg = self.config
        self._server = await asyncio.start_server(self._handle, cfg.host, cfg.port)
        if cfg.mode == "edge":
            self._watchdog = asyncio.create_task(self._watch_route())
        elif not cfg.password:
            log.warning("EGRESS_SOCKS_PASSWORD vazio: o gateway vai recusar todas as conexões")
        log.info("socks5 %s ouvindo em %s:%s", cfg.mode, cfg.host, self.port)

    async def close(self) -> None:
        if self._watchdog is not None:
            self._watchdog.cancel()
            await asyncio.gather(self._watchdog, return_exceptions=True)
        for conn in list(self._conns):
            conn.abort()
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()

    async def serve_forever(self) -> None:
        assert self._server is not None
        await self._server.serve_forever()

    # ------------------------------------------------------------ rota (edge)
    async def _watch_route(self) -> None:
        """Derruba as conexões abertas se a vaga deixar de sair pelo PC."""
        while True:
            await asyncio.sleep(self.config.route_check_interval)
            if not self._conns:
                continue
            route = read_route(self.config.route_file)
            if route != ROUTE_PC:
                for conn in list(self._conns):
                    if conn.upstream_writer is not None:
                        conn.result = f"closed_route_{route or 'missing'}"
                        conn.abort()

    # ------------------------------------------------------------ conexão
    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        peer = writer.get_extra_info("peername")
        conn = _Conn(client=str(peer[0]) if peer else "?", client_writer=writer)
        if len(self._conns) >= self.config.max_connections:
            conn.result = "too_many_connections"
            _abort(writer)
            self._log(conn)
            return
        self._conns.add(conn)
        try:
            await self._serve(conn, reader, writer)
        except _Refused as exc:
            conn.result = exc.result
        except (asyncio.IncompleteReadError, ConnectionError):
            if conn.result == "error":
                conn.result = "client_closed"
        except (asyncio.TimeoutError, TimeoutError):
            conn.result = "handshake_timeout"
        except Exception as exc:  # pragma: no cover - defesa
            conn.result = f"error:{type(exc).__name__}"
            log.exception("socks5 %s: erro inesperado", self.config.mode)
        finally:
            self._conns.discard(conn)
            for w in (conn.upstream_writer, writer):
                if w is not None:
                    try:
                        w.close()
                    except Exception:  # pragma: no cover
                        pass
            if not conn.silent:
                self._log(conn)

    def _log(self, conn: _Conn) -> None:
        log.info(
            "socks5 %s slot=%s client=%s target=%s result=%s up=%d down=%d secs=%.1f",
            self.config.mode, conn.slot, conn.client, conn.target, conn.result,
            conn.up, conn.down, time.monotonic() - conn.started,
        )

    async def _read(self, reader: asyncio.StreamReader, n: int) -> bytes:
        return await asyncio.wait_for(reader.readexactly(n), self.config.handshake_timeout)

    async def _serve(self, conn: _Conn, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        cfg = self.config
        # Saudação: VER NMETHODS METHODS...
        try:
            head = await self._read(reader, 2)
        except asyncio.IncompleteReadError as exc:
            if not exc.partial:
                conn.silent = True             # healthcheck / conexão vazia
            raise
        if head[0] != SOCKS_VERSION:
            raise _Refused("bad_version")
        methods = await self._read(reader, head[1]) if head[1] else b""

        if cfg.mode == "gateway":
            if METHOD_USER_PASS not in methods:
                writer.write(bytes([SOCKS_VERSION, METHOD_NONE_ACCEPTABLE]))
                await writer.drain()
                raise _Refused("auth_required")
            writer.write(bytes([SOCKS_VERSION, METHOD_USER_PASS]))
            await writer.drain()
            slot = await self._authenticate(conn, reader, writer)
        else:
            conn.slot = cfg.slot_name or "-"
            if METHOD_NO_AUTH not in methods:
                writer.write(bytes([SOCKS_VERSION, METHOD_NONE_ACCEPTABLE]))
                await writer.drain()
                raise _Refused("no_acceptable_method")
            writer.write(bytes([SOCKS_VERSION, METHOD_NO_AUTH]))
            await writer.drain()
            slot = ""

        raw_request, cmd, host, port = await self._read_request(writer, reader, conn)
        if cmd != CMD_CONNECT:
            writer.write(reply(REP_COMMAND_NOT_SUPPORTED))
            await writer.drain()
            raise _Refused(f"command_not_supported:{cmd}")

        if cfg.mode == "edge":
            up_reader, up_writer = await self._edge_connect(conn, writer, host, port)
        else:
            up_reader, up_writer = await self._gateway_connect(conn, writer, slot, raw_request)

        conn.result = "ok"
        await self._relay(conn, reader, writer, up_reader, up_writer)

    async def _authenticate(self, conn: _Conn, reader: asyncio.StreamReader,
                            writer: asyncio.StreamWriter) -> str:
        ver = (await self._read(reader, 1))[0]
        if ver != AUTH_VERSION:
            raise _Refused("bad_auth_version")
        ulen = (await self._read(reader, 1))[0]
        user = await self._read(reader, ulen) if ulen else b""
        plen = (await self._read(reader, 1))[0]
        password = await self._read(reader, plen) if plen else b""

        try:
            name = user.decode("ascii")
        except UnicodeDecodeError:
            name = ""
        name_ok = bool(SLOT_RE.fullmatch(name))
        if name_ok:
            conn.slot = name                   # nunca logar o que não for edge-N
        expected = self.config.password.encode("utf-8")
        # Sempre compara (tempo constante para a senha), mesmo com usuário inválido.
        password_ok = hmac.compare_digest(password, expected) and bool(expected)
        del password
        slot_ok = name_ok and name in self.config.slots
        if not (password_ok and slot_ok):
            if self.config.auth_failure_delay:
                await asyncio.sleep(self.config.auth_failure_delay)
            writer.write(bytes([AUTH_VERSION, 0x01]))
            await writer.drain()
            if not expected:
                raise _Refused("auth_disabled")
            raise _Refused("unknown_slot" if password_ok else "auth_failed")
        writer.write(bytes([AUTH_VERSION, 0x00]))
        await writer.drain()
        return name

    async def _read_request(self, writer: asyncio.StreamWriter, reader: asyncio.StreamReader,
                            conn: _Conn) -> tuple[bytes, int, str, int]:
        head = await self._read(reader, 4)     # VER CMD RSV ATYP
        if head[0] != SOCKS_VERSION:
            raise _Refused("bad_version")
        cmd, atyp = head[1], head[3]
        if atyp == ATYP_IPV4:
            addr = await self._read(reader, 4)
            host = str(ipaddress.IPv4Address(addr))
        elif atyp == ATYP_IPV6:
            addr = await self._read(reader, 16)
            host = str(ipaddress.IPv6Address(addr))
        elif atyp == ATYP_DOMAIN:
            length = await self._read(reader, 1)
            name = await self._read(reader, length[0]) if length[0] else b""
            addr = length + name
            try:
                host = name.decode("ascii")
            except UnicodeDecodeError:
                host = ""
            if not host:
                writer.write(reply(REP_ADDRESS_NOT_SUPPORTED))
                await writer.drain()
                raise _Refused("bad_domain")
        else:
            writer.write(reply(REP_ADDRESS_NOT_SUPPORTED))
            await writer.drain()
            raise _Refused(f"address_type_not_supported:{atyp}")
        port_raw = await self._read(reader, 2)
        port = int.from_bytes(port_raw, "big")
        conn.target = f"[{host}]:{port}" if atyp == ATYP_IPV6 else f"{host}:{port}"
        return head + addr + port_raw, cmd, host, port

    # ------------------------------------------------------------ edge
    async def _edge_connect(self, conn: _Conn, writer: asyncio.StreamWriter, host: str,
                            port: int) -> tuple[asyncio.StreamReader, asyncio.StreamWriter]:
        route = read_route(self.config.route_file)
        if route != ROUTE_PC:
            writer.write(reply(REP_NOT_ALLOWED))
            await writer.drain()
            raise _Refused(f"route_{route or 'missing'}")
        try:
            up_reader, up_writer = await self._open_target(host, port)
        except _ConnectFailed as exc:
            writer.write(reply(exc.reply))
            await writer.drain()
            raise _Refused(exc.result) from None
        conn.upstream_writer = up_writer
        bound = up_writer.get_extra_info("sockname") or ("0.0.0.0", 0)
        writer.write(reply(REP_SUCCEEDED, bound[0], bound[1]))
        await writer.drain()
        return up_reader, up_writer

    async def _open_target(self, host: str, port: int) -> tuple[asyncio.StreamReader, asyncio.StreamWriter]:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self.config.connect_timeout
        try:
            infos = await asyncio.wait_for(
                loop.getaddrinfo(host, port, type=socket.SOCK_STREAM, proto=socket.IPPROTO_TCP),
                self.config.connect_timeout,
            )
        except Exception as exc:
            if isinstance(exc, socket.gaierror) or isinstance(exc, (asyncio.TimeoutError, TimeoutError)):
                raise _connect_error(exc) from None
            raise _ConnectFailed(REP_HOST_UNREACHABLE, "dns_failed") from None

        addresses: list[str] = []
        for _family, _type, _proto, _canon, sockaddr in infos:
            ip = ipaddress.ip_address(sockaddr[0].split("%", 1)[0])
            if not (self.config.allow_private_targets or is_public(ip)):
                continue
            if sockaddr[0] not in addresses:
                addresses.append(sockaddr[0])
        if not addresses:
            raise _ConnectFailed(REP_NOT_ALLOWED, "target_not_public")

        last: _ConnectFailed | None = None
        for address in addresses:
            remaining = deadline - loop.time()
            if remaining <= 0:
                break
            try:
                return await asyncio.wait_for(asyncio.open_connection(address, port), remaining)
            except Exception as exc:  # tenta o próximo endereço
                last = _connect_error(exc)
        raise last or _ConnectFailed(REP_TTL_EXPIRED, "timeout")

    # ------------------------------------------------------------ gateway
    async def _gateway_connect(self, conn: _Conn, writer: asyncio.StreamWriter, slot: str,
                               raw_request: bytes) -> tuple[asyncio.StreamReader, asyncio.StreamWriter]:
        cfg = self.config

        async def fail(code: int, result: str) -> NoReturn:
            writer.write(reply(code))
            await writer.drain()
            raise _Refused(result)

        up_host, up_port = cfg.upstream_for(slot)
        try:
            up_reader, up_writer = await asyncio.wait_for(
                asyncio.open_connection(up_host, up_port), cfg.connect_timeout)
        except Exception:
            # A vaga não está de pé (contêiner parado, nome não resolve...).
            await fail(REP_NETWORK_UNREACHABLE, "edge_unreachable")
        conn.upstream_writer = up_writer

        # O edge resolve e conecta; espera o tempo de conexão dele + folga.
        wait = cfg.connect_timeout + cfg.handshake_timeout
        try:
            up_writer.write(bytes([SOCKS_VERSION, 1, METHOD_NO_AUTH]))
            await up_writer.drain()
            choice = await asyncio.wait_for(up_reader.readexactly(2), cfg.handshake_timeout)
            if choice != bytes([SOCKS_VERSION, METHOD_NO_AUTH]):
                await fail(REP_GENERAL_FAILURE, "edge_handshake_failed")
            up_writer.write(raw_request)
            await up_writer.drain()
            head = await asyncio.wait_for(up_reader.readexactly(4), wait)
            if head[0] != SOCKS_VERSION:
                await fail(REP_GENERAL_FAILURE, "edge_bad_reply")
            atyp = head[3]
            if atyp == ATYP_IPV4:
                rest = await asyncio.wait_for(up_reader.readexactly(4 + 2), cfg.handshake_timeout)
            elif atyp == ATYP_IPV6:
                rest = await asyncio.wait_for(up_reader.readexactly(16 + 2), cfg.handshake_timeout)
            elif atyp == ATYP_DOMAIN:
                ln = await asyncio.wait_for(up_reader.readexactly(1), cfg.handshake_timeout)
                rest = ln + await asyncio.wait_for(up_reader.readexactly(ln[0] + 2), cfg.handshake_timeout)
            else:
                await fail(REP_GENERAL_FAILURE, "edge_bad_reply")
        except _Refused:
            raise
        except (asyncio.TimeoutError, TimeoutError):
            await fail(REP_TTL_EXPIRED, "edge_timeout")
        except (asyncio.IncompleteReadError, ConnectionError):
            await fail(REP_GENERAL_FAILURE, "edge_closed")

        # Repassa a resposta do edge como veio (inclui o código de recusa dele).
        writer.write(head + rest)
        await writer.drain()
        if head[1] != REP_SUCCEEDED:
            raise _Refused(f"edge_refused:{head[1]}")
        return up_reader, up_writer

    # ------------------------------------------------------------ relay
    async def _relay(self, conn: _Conn, c_reader: asyncio.StreamReader, c_writer: asyncio.StreamWriter,
                     u_reader: asyncio.StreamReader, u_writer: asyncio.StreamWriter) -> None:
        loop = asyncio.get_running_loop()
        last = [loop.time()]

        async def pump(reader: asyncio.StreamReader, writer: asyncio.StreamWriter, upstream: bool) -> None:
            while True:
                data = await reader.read(RELAY_CHUNK)
                if not data:
                    break
                last[0] = loop.time()
                if upstream:
                    conn.up += len(data)
                else:
                    conn.down += len(data)
                writer.write(data)
                await writer.drain()
            # meia-conexão: avisa o outro lado e continua lendo dele
            if writer.can_write_eof() and not writer.is_closing():
                try:
                    writer.write_eof()
                except OSError:
                    pass

        tasks = {
            asyncio.create_task(pump(c_reader, u_writer, True)),
            asyncio.create_task(pump(u_reader, c_writer, False)),
        }
        try:
            while tasks:
                timeout = last[0] + self.config.idle_timeout - loop.time()
                if timeout <= 0:
                    conn.result = "idle_timeout"
                    break
                done, tasks = await asyncio.wait(tasks, timeout=timeout, return_when=asyncio.FIRST_COMPLETED)
                if any(t.exception() is not None for t in done if not t.cancelled()):
                    break                           # erro num lado: fecha tudo
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)


# --------------------------------------------------------------------------- main
async def serve(config: SocksConfig) -> None:
    server = SocksServer(config)
    await server.start()
    loop = asyncio.get_running_loop()
    stop = asyncio.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, stop.set)
        except (NotImplementedError, RuntimeError, AttributeError):  # Windows
            pass
    serving = asyncio.create_task(server.serve_forever())
    stopping = asyncio.create_task(stop.wait())
    try:
        await asyncio.wait({serving, stopping}, return_when=asyncio.FIRST_COMPLETED)
    finally:
        serving.cancel()
        stopping.cancel()
        await asyncio.gather(serving, stopping, return_exceptions=True)
        await server.close()
        log.info("socks5 %s encerrado", config.mode)


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if len(args) != 1 or args[0] not in ("edge", "gateway"):
        print("uso: python -m app.socks5 edge|gateway", file=sys.stderr)
        return 2
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    try:
        config = SocksConfig.from_env(args[0])
    except ValueError as exc:
        print(f"configuração inválida: {exc}", file=sys.stderr)
        return 2
    try:
        asyncio.run(serve(config))
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())

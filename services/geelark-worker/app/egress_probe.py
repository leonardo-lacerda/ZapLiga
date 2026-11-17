"""IP de saída do PC escolhido, consultado pelo proxy SOCKS5 do cadastro (contrato, seção 4).

Antes de ligar o phone, o worker pergunta ao `https://api.ipify.org` **através do
`probeProxy`** (o `socks-gateway` pela rede interna, com o usuário da vaga) qual é o IP de
saída do PC. Esse passa a ser o IP esperado dentro do phone.

Cliente SOCKS5 mínimo, só stdlib (RFC 1928 + RFC 1929). O nome do site é resolvido do lado
do proxy (ATYP domínio), como o phone faz. A senha nunca vai para log nem para a mensagem
de erro (`ProbeFailed.reason` só tem o motivo).
"""

from __future__ import annotations

import http.client
import ipaddress
import socket
import ssl
import time
import urllib.parse

from .automation import ProbeProxySpec

PROBE_URL = "https://api.ipify.org"
PROBE_TIMEOUT_S = 15.0
USER_AGENT = "zapliga-geelark-worker"


class ProbeFailed(Exception):
    """O probe não trouxe um IP. `reason` é curto e não tem segredo."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


def _recv_exact(sock: socket.socket, n: int, deadline: float) -> bytes:
    buf = b""
    while len(buf) < n:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ProbeFailed("tempo esgotado no proxy")
        sock.settimeout(remaining)
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise ProbeFailed("o proxy fechou a conexão")
        buf += chunk
    return buf


def socks5_connect(proxy: ProbeProxySpec, host: str, port: int, timeout: float) -> socket.socket:
    """Abre um túnel CONNECT até host:port pelo proxy e devolve o socket pronto."""
    deadline = time.monotonic() + timeout
    sock = socket.create_connection((proxy.server, proxy.port), timeout=timeout)
    try:
        use_auth = bool(proxy.username or proxy.password)
        sock.sendall(bytes([5, 1, 0x02 if use_auth else 0x00]))
        ver, method = _recv_exact(sock, 2, deadline)
        if ver != 5:
            raise ProbeFailed("resposta SOCKS inválida")
        if method == 0x02:
            user = proxy.username.encode("utf-8")
            password = proxy.password.encode("utf-8")
            if len(user) > 255 or len(password) > 255:
                raise ProbeFailed("usuário/senha do proxy longos demais")
            sock.sendall(bytes([1, len(user)]) + user + bytes([len(password)]) + password)
            del password
            _, status = _recv_exact(sock, 2, deadline)
            if status != 0:
                raise ProbeFailed("o proxy recusou usuário/senha")
        elif method != 0x00:
            raise ProbeFailed("o proxy não aceitou o método de autenticação")

        name = host.encode("idna")
        sock.sendall(bytes([5, 1, 0, 0x03, len(name)]) + name + port.to_bytes(2, "big"))
        head = _recv_exact(sock, 4, deadline)
        if head[0] != 5:
            raise ProbeFailed("resposta SOCKS inválida")
        if head[1] != 0:
            raise ProbeFailed(f"o proxy recusou a conexão (SOCKS {head[1]})")
        atyp = head[3]
        if atyp == 0x01:
            _recv_exact(sock, 4 + 2, deadline)
        elif atyp == 0x04:
            _recv_exact(sock, 16 + 2, deadline)
        elif atyp == 0x03:
            ln = _recv_exact(sock, 1, deadline)[0]
            _recv_exact(sock, ln + 2, deadline)
        else:
            raise ProbeFailed("resposta SOCKS inválida")
        sock.settimeout(max(0.1, deadline - time.monotonic()))
        return sock
    except BaseException:
        sock.close()
        raise


def probe_egress_ip(proxy: ProbeProxySpec, *, url: str = PROBE_URL, timeout: float = PROBE_TIMEOUT_S,
                    ssl_context: ssl.SSLContext | None = None) -> str:
    """IP público (texto) que `url` vê quando acessado pelo proxy. Falha = `ProbeFailed`."""
    parts = urllib.parse.urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ValueError(f"URL do probe inválida: {url}")
    port = parts.port or (443 if parts.scheme == "https" else 80)
    if parts.scheme == "https":
        conn: http.client.HTTPConnection = http.client.HTTPSConnection(
            parts.hostname, port, timeout=timeout, context=ssl_context or ssl.create_default_context())
    else:
        conn = http.client.HTTPConnection(parts.hostname, port, timeout=timeout)
    # O http.client abre a conexão por este atributo; o TLS (https) vai por cima do túnel.
    conn._create_connection = lambda address, *_args, **_kw: socks5_connect(  # type: ignore[attr-defined]
        proxy, address[0], address[1], timeout)
    try:
        conn.request("GET", parts.path or "/", headers={"User-Agent": USER_AGENT, "Accept": "text/plain"})
        resp = conn.getresponse()
        body = resp.read(256)
        if resp.status != 200:
            raise ProbeFailed(f"{parts.hostname} respondeu HTTP {resp.status}")
        try:
            return str(ipaddress.ip_address(body.decode("ascii").strip()))
        except (UnicodeDecodeError, ValueError):
            raise ProbeFailed(f"{parts.hostname} não devolveu um IP") from None
    except ProbeFailed:
        raise
    except (OSError, http.client.HTTPException) as exc:
        # Só o tipo do erro: a mensagem pode trazer o endereço do proxy, nunca a senha,
        # mas fica curto e previsível.
        raise ProbeFailed(f"falha de rede ({type(exc).__name__})") from None
    finally:
        conn.close()

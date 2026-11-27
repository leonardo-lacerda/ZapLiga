#!/usr/bin/env bash
# Reproducible build of the ZapLiga Waxum image (zapliga-waxum:<tag>).
#
# Why this exists: the image running in production is NOT the stock
# fdciabdul/waxum. It is Waxum v0.12.5 with the whatsapp-rust library swapped
# for a patched snapshot that binds every media relay the WhatsApp offer
# carries (see docs/postmortem-audio-unidirecional.md). For a while that
# patched source lived only in a temp folder on one laptop; this script and the
# patches next to it are what make the image rebuildable from a clean machine.
#
# NEVER run this on the production VPS (docs/deploy-runbook.md: heavy builds
# happen elsewhere). Run it locally or in CI, then ship the image:
#   docker save zapliga-waxum:<tag> | gzip | ssh root@<vps> 'gunzip | docker load'
#
# Usage:
#   infra/waxum/build.sh [tag]            # default tag: 0.12.6-multirelay-v10-loss-signals
#   WORKDIR=/some/dir infra/waxum/build.sh # keep the assembled source around
#
set -euo pipefail

TAG="${1:-0.12.6-multirelay-v11-device-profile}"
IMAGE="zapliga-waxum:${TAG}"

# Pinned upstream sources. Bumping either means regenerating the patches:
#   diff -ruN --exclude=target --exclude=.git <upstream> <patched> > patches/...
WAXUM_REPO="https://github.com/imtaqin/waxum"
WAXUM_REF="v0.12.5"                                   # 6 files differ from ours, see patches/waxum-zapliga.patch
WHATSAPP_RUST_REPO="https://github.com/oxidezap/whatsapp-rust"
WHATSAPP_RUST_REF="9be10573aa47bc8dcae42918c553250879383d67"  # main @ 2026-09-01, base of patches/whatsapp-rust-zapliga.patch

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PATCHES="${HERE}/patches"
WORKDIR="${WORKDIR:-$(mktemp -d -t zapliga-waxum-build-XXXXXX)}"
SRC="${WORKDIR}/waxum"

for f in whatsapp-rust-zapliga.patch whatsapp-rust-call-codec.patch whatsapp-rust-zapliga-signal.patch whatsapp-rust-relay-select.patch whatsapp-rust-opus-conceal.patch whatsapp-rust-client-profile-carrier.patch waxum-zapliga.patch waxum-call-codec.patch waxum-zapliga-signal.patch waxum-zapliga-identity.patch waxum-zapliga-loss.patch waxum-zapliga-device-profile.patch; do
  [ -s "${PATCHES}/${f}" ] || { echo "patch ausente: ${PATCHES}/${f}" >&2; exit 1; }
done
command -v docker >/dev/null || { echo "docker nao encontrado" >&2; exit 1; }
command -v git >/dev/null || { echo "git nao encontrado" >&2; exit 1; }
command -v patch >/dev/null || { echo "patch nao encontrado" >&2; exit 1; }

echo "==> Assembling sources in ${WORKDIR}"
rm -rf "${SRC}"
git init -q "${SRC}"
git -C "${SRC}" remote add origin "${WAXUM_REPO}"
git -C "${SRC}" fetch -q --depth 1 origin "refs/tags/${WAXUM_REF}"
git -C "${SRC}" checkout -q FETCH_HEAD
rm -rf "${SRC}/.git"

git init -q "${SRC}/whatsapp-rust"
git -C "${SRC}/whatsapp-rust" remote add origin "${WHATSAPP_RUST_REPO}"
# The versioned Rust patch uses LF. Force the same checkout on Windows/Git Bash,
# where the system git config otherwise converts upstream Rust files to CRLF and
# makes `patch --binary` reject every hunk as "different line endings".
git -C "${SRC}/whatsapp-rust" config core.autocrlf false
git -C "${SRC}/whatsapp-rust" fetch -q --depth 1 origin "${WHATSAPP_RUST_REF}"
git -C "${SRC}/whatsapp-rust" checkout -q FETCH_HEAD
rm -rf "${SRC}/whatsapp-rust/.git"

echo "==> Applying patches"
# --binary keeps line endings exactly as the patch says; the upstream
# docker-entrypoint.sh ships with CRLF, and a CRLF shebang makes the container
# crash-loop with "exec: /app/docker-entrypoint.sh: not found".
(cd "${SRC}/whatsapp-rust" && patch -p1 --binary --forward < "${PATCHES}/whatsapp-rust-zapliga.patch")
(cd "${SRC}/whatsapp-rust" && patch -p1 --forward < "${PATCHES}/whatsapp-rust-call-codec.patch")
# Logs what every call offer carries and every answer to it (target zapliga.call), and lets a
# single call choose its codec (the canary A/B); docs/waxum-version.md.
(cd "${SRC}/whatsapp-rust" && patch -p1 --forward < "${PATCHES}/whatsapp-rust-zapliga-signal.patch")
# Once the peer's media is seen on one relay, outbound media goes only there instead of to every
# relay (back to all of them while settling or when it goes quiet): cuts the call's bandwidth.
(cd "${SRC}/whatsapp-rust" && patch -p1 --forward < "${PATCHES}/whatsapp-rust-relay-select.patch")
# A late or lost packet of the lead's voice is filled by libopus' loss concealment instead of a
# hard silence plus a ~120 ms silent re-prime (what callers heard as the call breaking up).
(cd "${SRC}/whatsapp-rust" && patch -p1 --forward < "${PATCHES}/whatsapp-rust-opus-conceal.patch")
# The carrier (mcc/mnc) of a native handshake profile; WA Web's "000" stays the default.
(cd "${SRC}/whatsapp-rust" && patch -p1 --forward < "${PATCHES}/whatsapp-rust-client-profile-carrier.patch")
# waxum-zapliga.patch was cut from a Windows (CRLF) checkout; a Linux checkout is
# LF, so give the files it touches CRLF first or every hunk is rejected.
for f in Cargo.lock Cargo.toml Dockerfile docker-entrypoint.sh src/handlers/mex.rs; do
  sed -i 's/\r*$/\r/' "${SRC}/${f}"
done
(cd "${SRC}" && patch -p1 --binary --forward < "${PATCHES}/waxum-zapliga.patch")
sed -i 's/\r$//' "${SRC}/docker-entrypoint.sh" "${SRC}/Dockerfile"
(cd "${SRC}" && patch -p1 --forward < "${PATCHES}/waxum-call-codec.patch")
# Publishes the cause of every logout, terminates with our own call creator once, takes a
# per-session lock and reads the handshake profile from the environment; docs/waxum-version.md.
(cd "${SRC}" && patch -p1 --forward < "${PATCHES}/waxum-zapliga-signal.patch")
# The identity (registration props and login locale) per line instead of per container, saved with
# the session so it follows the line across Waxums, and the server's acks of call stanzas published
# as `call_ack`; docs/stealth-profile.md.
(cd "${SRC}" && patch -p1 --forward < "${PATCHES}/waxum-zapliga-identity.patch")
# Why a line was lost, by name: an account lock's cause (never its appeal token), a temporary ban's
# code and duration, any refused connection's code, and the server's reachout timelock on demand.
(cd "${SRC}" && patch -p1 --forward < "${PATCHES}/waxum-zapliga-loss.patch")
# A line may log in as the Android phone it was registered on, sent by the API with the rest of
# its identity and saved in zapliga-identity.json; docs/device-profile.md.
(cd "${SRC}" && patch -p1 --forward < "${PATCHES}/waxum-zapliga-device-profile.patch")
head -c 12 "${SRC}/docker-entrypoint.sh" | grep -q '#!/bin/sh' || { echo "docker-entrypoint.sh invalido apos patch" >&2; exit 1; }

echo "==> Sanity: the multi-relay fix must be present"
grep -q 'MultiRelayMediaChannelFactory' "${SRC}/whatsapp-rust/src/voip/transport/native.rs" \
  || { echo "patch nao trouxe MultiRelayMediaChannelFactory; fonte incompleta" >&2; exit 1; }
grep -q 'get_usable_relay_endpoints' "${SRC}/whatsapp-rust/wacore/src/voip/relay_parse.rs" \
  || { echo "patch nao trouxe get_usable_relay_endpoints; fonte incompleta" >&2; exit 1; }
grep -q 'audio_with_config' "${SRC}/whatsapp-rust/src/voip/facade.rs" \
  || { echo "patch nao trouxe audio_with_config; fonte incompleta" >&2; exit 1; }
grep -q 'struct RelayActivity' "${SRC}/whatsapp-rust/src/voip/transport/native.rs" \
  || { echo "patch nao trouxe RelayActivity; fonte incompleta" >&2; exit 1; }
grep -q 'fn drain_playout_concealing' "${SRC}/whatsapp-rust/wacore/src/voip/engine.rs" \
  || { echo "patch nao trouxe a ocultacao de perda do Opus; fonte incompleta" >&2; exit 1; }
grep -q 'fn zapliga_lock_details' "${SRC}/src/handlers/sessions.rs" \
  || { echo "patch nao trouxe os sinais de queda; fonte incompleta" >&2; exit 1; }
grep -q 'lock_session_storage' "${SRC}/src/handlers/sessions.rs" \
  || { echo "patch nao trouxe lock_session_storage; fonte incompleta" >&2; exit 1; }
grep -q 'zapliga-identity.json' "${SRC}/src/device_props.rs" \
  || { echo "patch nao trouxe a identidade por sessao; fonte incompleta" >&2; exit 1; }
grep -q 'pub mnc: String' "${SRC}/whatsapp-rust/wacore/src/client_profile.rs" \
  || { echo "patch nao trouxe a operadora do perfil; fonte incompleta" >&2; exit 1; }
grep -q 'fn android_profile' "${SRC}/src/device_props.rs" \
  || { echo "patch nao trouxe o perfil Android por linha; fonte incompleta" >&2; exit 1; }

echo "==> Building ${IMAGE} (release, LTO off in Dockerfile; expect 10-45 min cold)"
docker build --progress=plain -t "${IMAGE}" "${SRC}"

echo
echo "OK: ${IMAGE}"
echo "Ship it:  docker save ${IMAGE} | gzip | ssh root@<vps> 'gunzip | docker load'"
echo "Then set  image: ${IMAGE}  for service waxum in docker-compose.yml and commit."
[ -n "${WORKDIR_KEEP:-}" ] || echo "(source kept in ${WORKDIR}; delete when done)"

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
#   infra/waxum/build.sh [tag]            # default tag: 0.12.6-multirelay-v1
#   WORKDIR=/some/dir infra/waxum/build.sh # keep the assembled source around
#
set -euo pipefail

TAG="${1:-0.12.6-multirelay-v1}"
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

for f in whatsapp-rust-zapliga.patch waxum-zapliga.patch; do
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
git -C "${SRC}/whatsapp-rust" fetch -q --depth 1 origin "${WHATSAPP_RUST_REF}"
git -C "${SRC}/whatsapp-rust" checkout -q FETCH_HEAD
rm -rf "${SRC}/whatsapp-rust/.git"

echo "==> Applying patches"
# --binary keeps line endings exactly as the patch says; the upstream
# docker-entrypoint.sh ships with CRLF, and a CRLF shebang makes the container
# crash-loop with "exec: /app/docker-entrypoint.sh: not found".
(cd "${SRC}/whatsapp-rust" && patch -p1 --binary --forward < "${PATCHES}/whatsapp-rust-zapliga.patch")
(cd "${SRC}" && patch -p1 --binary --forward < "${PATCHES}/waxum-zapliga.patch")
sed -i 's/\r$//' "${SRC}/docker-entrypoint.sh"
head -c 12 "${SRC}/docker-entrypoint.sh" | grep -q '#!/bin/sh' || { echo "docker-entrypoint.sh invalido apos patch" >&2; exit 1; }

echo "==> Sanity: the multi-relay fix must be present"
grep -q 'MultiRelayMediaChannelFactory' "${SRC}/whatsapp-rust/src/voip/transport/native.rs" \
  || { echo "patch nao trouxe MultiRelayMediaChannelFactory; fonte incompleta" >&2; exit 1; }
grep -q 'get_usable_relay_endpoints' "${SRC}/whatsapp-rust/wacore/src/voip/relay_parse.rs" \
  || { echo "patch nao trouxe get_usable_relay_endpoints; fonte incompleta" >&2; exit 1; }

echo "==> Building ${IMAGE} (release, LTO off in Dockerfile; expect 10-45 min cold)"
docker build --progress=plain -t "${IMAGE}" "${SRC}"

echo
echo "OK: ${IMAGE}"
echo "Ship it:  docker save ${IMAGE} | gzip | ssh root@<vps> 'gunzip | docker load'"
echo "Then set  image: ${IMAGE}  for service waxum in docker-compose.yml and commit."
[ -n "${WORKDIR_KEEP:-}" ] || echo "(source kept in ${WORKDIR}; delete when done)"

#!/usr/bin/env bash
# Build Hiread Linux desktop packages inside an Ubuntu 24.04 container.
# Intended to run as linux/amd64 (native or qemu) so x64 packages can be
# produced on an ARM runner when GitHub's ubuntu-24.04 x64 apt is stuck.
set -euxo pipefail

export DEBIAN_FRONTEND=noninteractive
export APPIMAGE_EXTRACT_AND_RUN=1
HIREAD_VERSION="${HIREAD_VERSION:?HIREAD_VERSION is required}"
WAILS3_VERSION="${WAILS3_VERSION:-v3.0.0-alpha2.103}"
GO_VERSION="${GO_VERSION:-1.25.0}"

echo 'man-db man-db/auto-update boolean false' | debconf-set-selections || true
rm -f /var/lib/man-db/auto-update

apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=30 -o Dpkg::Use-Pty=0 update
apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=30 -o Dpkg::Use-Pty=0 \
  install -y --no-install-recommends \
    ca-certificates curl git gcc libc6-dev pkg-config xz-utils \
    libgtk-4-dev libwebkitgtk-6.0-dev libfuse2 rpm wget python3 \
    file

if ! command -v go >/dev/null 2>&1; then
  arch="$(dpkg --print-architecture)"
  case "${arch}" in
    amd64) goarch=amd64 ;;
    arm64) goarch=arm64 ;;
    *) echo "unsupported dpkg arch ${arch}" >&2; exit 1 ;;
  esac
  curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${goarch}.tar.gz" | tar -C /usr/local -xz
  export PATH="/usr/local/go/bin:${PATH}"
fi
export PATH="${PATH}:$(go env GOPATH)/bin:/usr/local/go/bin"

if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get -o Dpkg::Use-Pty=0 install -y --no-install-recommends nodejs
fi

go install "github.com/wailsapp/wails/v3/cmd/wails3@${WAILS3_VERSION}"
go install github.com/go-task/task/v3/cmd/task@latest

mkdir -p frontend/dist
if [[ ! -f frontend/dist/index.html ]]; then
  echo '<!doctype html><title>release stub</title>' > frontend/dist/index.html
fi

python3 - <<PY
import os, pathlib, re, sys
version = os.environ["HIREAD_VERSION"]

def sub(path, pattern, repl, count=0):
    p = pathlib.Path(path)
    text = p.read_text(encoding="utf-8")
    new, n = re.subn(pattern, repl, text, count=count, flags=re.M)
    if n == 0:
        sys.exit(f"no match in {path}: {pattern}")
    p.write_text(new, encoding="utf-8")

sub("services/update.go", r'var appVersion = "[^"]+"', f'var appVersion = "{version}"')
sub("build/linux/nfpm/nfpm.yaml", r'^version:\\s*".*"', f'version: "{version}"', count=1)
print(f"stamped {version}")
PY

export GOARCH
GOARCH="$(go env GOARCH)"
task build VERSION="${HIREAD_VERSION}"
task linux:generate:dotdesktop
task linux:generate:deb
task linux:generate:rpm
task linux:generate:aur || true
task linux:create:appimage || true

shopt -s nullglob
mkdir -p dist
label="linux-${GOARCH}"
for f in bin/*.AppImage; do
  cp "$f" "dist/Hiread-${HIREAD_VERSION}-${label}.AppImage"
  chmod +x "dist/Hiread-${HIREAD_VERSION}-${label}.AppImage"
done
for f in bin/*.deb; do cp "$f" "dist/Hiread-${HIREAD_VERSION}-${label}.deb"; done
for f in bin/*.rpm; do cp "$f" "dist/Hiread-${HIREAD_VERSION}-${label}.rpm"; done
for f in bin/*.pkg.tar.zst bin/*.pkg.tar.xz; do
  ext="${f##*.}"
  cp "$f" "dist/Hiread-${HIREAD_VERSION}-${label}.pkg.tar.${ext}"
done
test -f bin/hiread
tar -czf "dist/Hiread-${HIREAD_VERSION}-${label}.tar.gz" -C bin hiread
ls -lh dist

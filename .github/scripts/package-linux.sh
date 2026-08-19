#!/usr/bin/env bash
# Produce linux/amd64 desktop packages on an ARM host by cross-compiling.
# Native x64 Ubuntu runners hang on apt; qemu-user cannot run modern Go
# (fatal error: taggedPointerPack). Bindings/frontend build natively; the
# Wails binary is linked with the amd64 GTK/WebKit sysroot.
set -euxo pipefail

export DEBIAN_FRONTEND=noninteractive
export APPIMAGE_EXTRACT_AND_RUN=1
HIREAD_VERSION="${HIREAD_VERSION:?HIREAD_VERSION is required}"
WAILS3_VERSION="${WAILS3_VERSION:-v3.0.0-alpha2.103}"

echo 'man-db man-db/auto-update boolean false' | sudo debconf-set-selections || true
sudo rm -f /var/lib/man-db/auto-update

sudo apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=30 -o Dpkg::Use-Pty=0 update
sudo apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=30 -o Dpkg::Use-Pty=0 \
  install -y --no-install-recommends \
    ca-certificates curl git gcc libc6-dev pkg-config xz-utils \
    libgtk-4-dev libwebkitgtk-6.0-dev \
    gcc-x86-64-linux-gnu g++-x86-64-linux-gnu \
    rpm wget python3 file

sudo dpkg --add-architecture amd64
sudo apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=30 -o Dpkg::Use-Pty=0 update
sudo apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=30 -o Dpkg::Use-Pty=0 \
  install -y --no-install-recommends \
    libgtk-4-dev:amd64 \
    libwebkitgtk-6.0-dev:amd64 \
    libfuse2:amd64

export PATH="$(go env GOPATH)/bin:${PATH}"
go install "github.com/wailsapp/wails/v3/cmd/wails3@${WAILS3_VERSION}"
go install github.com/go-task/task/v3/cmd/task@latest

mkdir -p frontend/dist
if [[ ! -f frontend/dist/index.html ]]; then
  echo '<!doctype html><title>release stub</title>' > frontend/dist/index.html
fi

python3 - <<'PY'
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
sub("build/linux/nfpm/nfpm.yaml", r'^version:\s*".*"', f'version: "{version}"', count=1)
print(f"stamped {version}")
PY

# Frontend + bindings on the native arch (needs host GTK headers).
task common:build:frontend
task linux:generate:dotdesktop

# Cross-link the production binary against the amd64 GTK/WebKit stack.
export CGO_ENABLED=1
export GOOS=linux
export GOARCH=amd64
export CC=x86_64-linux-gnu-gcc
export CXX=x86_64-linux-gnu-g++
export PKG_CONFIG_ALLOW_CROSS=1
export PKG_CONFIG_LIBDIR=/usr/lib/x86_64-linux-gnu/pkgconfig:/usr/share/pkgconfig
export PKG_CONFIG_PATH=
go build -tags production -trimpath -buildvcs=false -ldflags="-w -s" -o bin/hiread
file bin/hiread

# nfpm reads GOARCH for the package architecture.
wails3 tool package -name hiread -format deb -config ./build/linux/nfpm/nfpm.yaml -out bin
wails3 tool package -name hiread -format rpm -config ./build/linux/nfpm/nfpm.yaml -out bin
wails3 tool package -name hiread -format archlinux -config ./build/linux/nfpm/nfpm.yaml -out bin || true

# AppImage tooling is x86_64; skip rather than run it under qemu.
shopt -s nullglob
mkdir -p dist
label="linux-amd64"
for f in bin/*.deb; do cp "$f" "dist/Hiread-${HIREAD_VERSION}-${label}.deb"; done
for f in bin/*.rpm; do cp "$f" "dist/Hiread-${HIREAD_VERSION}-${label}.rpm"; done
for f in bin/*.pkg.tar.zst bin/*.pkg.tar.xz; do
  ext="${f##*.}"
  cp "$f" "dist/Hiread-${HIREAD_VERSION}-${label}.pkg.tar.${ext}"
done
tar -czf "dist/Hiread-${HIREAD_VERSION}-${label}.tar.gz" -C bin hiread
ls -lh dist
file bin/hiread

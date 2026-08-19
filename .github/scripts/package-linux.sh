#!/usr/bin/env bash
# Produce linux/amd64 desktop packages on an ARM host by cross-compiling.
# Bindings are committed, so we do not need host GTK headers. Only the
# amd64 GTK/WebKit -dev sysroot is installed (multiarch -dev packages
# cannot sit next to their arm64 twins — they share /usr/include).
set -euxo pipefail

export DEBIAN_FRONTEND=noninteractive
HIREAD_VERSION="${HIREAD_VERSION:?HIREAD_VERSION is required}"
WAILS3_VERSION="${WAILS3_VERSION:-v3.0.0-alpha2.103}"

echo 'man-db man-db/auto-update boolean false' | sudo debconf-set-selections || true
sudo rm -f /var/lib/man-db/auto-update

sudo apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=30 -o Dpkg::Use-Pty=0 update
sudo apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=30 -o Dpkg::Use-Pty=0 \
  install -y --no-install-recommends \
    ca-certificates curl git gcc libc6-dev pkg-config xz-utils \
    gcc-x86-64-linux-gnu g++-x86-64-linux-gnu \
    rpm wget python3 file

sudo dpkg --add-architecture amd64
if [[ -f /etc/apt/sources.list.d/ubuntu.sources ]]; then
  if ! grep -q '^Architectures:' /etc/apt/sources.list.d/ubuntu.sources; then
    sudo sed -i 's/^Types:/Architectures: arm64\nTypes:/' /etc/apt/sources.list.d/ubuntu.sources
  fi
fi
for f in /etc/apt/sources.list /etc/apt/sources.list.d/*.list; do
  [[ -f "$f" ]] || continue
  sudo sed -i -E 's|^(deb(-src)? )http://ports\.ubuntu\.com|\1[arch=arm64] http://ports.ubuntu.com|; s|^(deb(-src)? )https://ports\.ubuntu\.com|\1[arch=arm64] https://ports.ubuntu.com|' "$f"
done
sudo tee /etc/apt/sources.list.d/amd64.list >/dev/null <<'EOF'
deb [arch=amd64] http://archive.ubuntu.com/ubuntu noble main restricted universe multiverse
deb [arch=amd64] http://archive.ubuntu.com/ubuntu noble-updates main restricted universe multiverse
deb [arch=amd64] http://archive.ubuntu.com/ubuntu noble-backports main restricted universe multiverse
deb [arch=amd64] http://security.ubuntu.com/ubuntu noble-security main restricted universe multiverse
EOF
sudo apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=30 -o Dpkg::Use-Pty=0 update
sudo apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=30 -o Dpkg::Use-Pty=0 \
  install -y --no-install-recommends \
    libgtk-4-dev:amd64 \
    libwebkitgtk-6.0-dev:amd64

export PATH="$(go env GOPATH)/bin:${PATH}"
# The CLI pulls linux cgo packages if CGO is on; we have no host GTK.
CGO_ENABLED=0 go install "github.com/wailsapp/wails/v3/cmd/wails3@${WAILS3_VERSION}"

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

# Bindings are committed; just bundle the Vue app.
(cd frontend && npm ci && npm run build)

mkdir -p bin
export CGO_ENABLED=1
export GOOS=linux
export GOARCH=amd64
export CC=x86_64-linux-gnu-gcc
export CXX=x86_64-linux-gnu-g++
export PKG_CONFIG_ALLOW_CROSS=1
pcdir=/usr/lib/x86_64-linux-gnu/pkgconfig
ls -l "${pcdir}/gtk4.pc" "${pcdir}/webkitgtk-6.0.pc"
cat > /tmp/pkg-config-amd64 <<EOF
#!/bin/sh
export PKG_CONFIG_LIBDIR=${pcdir}
export PKG_CONFIG_PATH=${pcdir}
exec /usr/bin/pkg-config "\$@"
EOF
chmod +x /tmp/pkg-config-amd64
export PKG_CONFIG=/tmp/pkg-config-amd64
export PKG_CONFIG_LIBDIR="${pcdir}"
export PKG_CONFIG_PATH="${pcdir}"
"${PKG_CONFIG}" --modversion gtk4
"${PKG_CONFIG}" --cflags gtk4 webkitgtk-6.0
go build -tags production -trimpath -buildvcs=false -ldflags="-w -s" -o bin/hiread
file bin/hiread

if ! command -v wails3 >/dev/null; then
  echo "wails3 missing" >&2
  exit 1
fi
# .desktop file for nfpm
mkdir -p build/linux
wails3 generate .desktop -name hiread -exec hiread -icon hiread \
  -outputfile build/linux/hiread.desktop -categories "Office;Viewer;"

wails3 tool package -name hiread -format deb -config ./build/linux/nfpm/nfpm.yaml -out bin
wails3 tool package -name hiread -format rpm -config ./build/linux/nfpm/nfpm.yaml -out bin
wails3 tool package -name hiread -format archlinux -config ./build/linux/nfpm/nfpm.yaml -out bin || true

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

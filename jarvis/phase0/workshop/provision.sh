#!/usr/bin/env bash
# Phase 0: provision the jarvis-workshop distro. Runs as root, once.
# Creates an unprivileged "worker" user WITHOUT sudo, installs tools, and
# writes /etc/wsl.conf so the distro cannot launch Windows programs or see
# Windows drives. Takes effect after `wsl --terminate jarvis-workshop`.
set -euo pipefail

NODE_MAJOR=22
WORKER=worker

log() { printf '\n==> %s\n' "$*"; }

[ "$(id -u)" -eq 0 ] || { echo "must run as root" >&2; exit 1; }

log "Updating packages and installing base tools"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends \
  ca-certificates curl git bubblewrap socat xz-utils jq python3 iproute2 netcat-openbsd procps

log "Installing Node.js ${NODE_MAJOR} (checksum-verified) to /opt/node"
base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
tmp="$(mktemp -d)"
curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
tarball="$(grep -oE "node-v[0-9.]+-linux-x64\.tar\.xz" "$tmp/SHASUMS256.txt" | head -n1)"
curl -fsSL "$base/$tarball" -o "$tmp/$tarball"
( cd "$tmp" && grep " $tarball\$" SHASUMS256.txt | sha256sum -c - )
rm -rf /opt/node && mkdir -p /opt/node
tar -xJf "$tmp/$tarball" -C /opt/node --strip-components=1
ln -sf /opt/node/bin/node /usr/local/bin/node
ln -sf /opt/node/bin/npm /usr/local/bin/npm
ln -sf /opt/node/bin/npx /usr/local/bin/npx
rm -rf "$tmp"
node --version

log "Creating unprivileged user '${WORKER}' (no sudo)"
if ! id "$WORKER" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "$WORKER"
fi
# Remove from any admin group and make sure sudo is not usable.
for g in sudo admin wheel; do gpasswd -d "$WORKER" "$g" >/dev/null 2>&1 || true; done
passwd -l "$WORKER" >/dev/null
mkdir -p "/home/$WORKER/phase0-results" "/home/$WORKER/.npm-global"
chown -R "$WORKER:$WORKER" "/home/$WORKER"
if ! grep -q 'npm-global' "/home/$WORKER/.bashrc"; then
  cat >> "/home/$WORKER/.bashrc" <<'EOF'
export NPM_CONFIG_PREFIX="$HOME/.npm-global"
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"
EOF
fi

log "Allowing bubblewrap to create user namespaces if AppArmor restricts it"
if [ "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = "1" ]; then
  cat > /etc/apparmor.d/bwrap <<'EOF'
abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
  include if exists <local/bwrap>
}
EOF
  (apparmor_parser -r /etc/apparmor.d/bwrap 2>/dev/null || systemctl reload apparmor 2>/dev/null) || \
    echo "WARNING: could not reload AppArmor; Claude Code's sandbox may fail until the distro restarts"
else
  echo "not restricted; nothing to do"
fi

log "Writing /etc/wsl.conf (interop off, automount off, default user worker)"
cat > /etc/wsl.conf <<EOF
# Written by JARVIS Phase 0. Isolation for the development workshop.
[interop]
enabled = false
appendWindowsPath = false

[automount]
enabled = false
mountFsTab = false

[user]
default = ${WORKER}
EOF

log "Provisioning complete"
echo "PROVISION_OK"

#!/usr/bin/env bash
#
# dependencies.sh — instala o único pré-requisito de sistema da REIN:
# Docker + Docker Compose v2 (repositório oficial da Docker).
#
# Uso (a partir da raiz deste repositório, já clonado):
#   chmod +x dependencies.sh
#   sudo ./dependencies.sh
#
# Reexecução: idempotente. Testado em Ubuntu Server 25.04 (Plucky Puffin);
# em outras versões o pin de versão pode não existir no repositório — o
# script cai para a mais recente disponível e avisa, mas não trava.

set -Eeuo pipefail

if [ "$(id -u)" -ne 0 ]; then
    echo "Rode como root (sudo ./dependencies.sh)" >&2
    exit 1
fi

# Validado em 2026-08-29 (mesma VM de experimentos do grupo, ver
# infra/setup.sh do projeto PIBIC).
PIN_DOCKER_CE="${PIN_DOCKER_CE:-5:29.7.2-1~ubuntu.26.04~resolute}"
PIN_DOCKER_CE_CLI="${PIN_DOCKER_CE_CLI:-5:29.7.2-1~ubuntu.26.04~resolute}"
PIN_DOCKER_COMPOSE_PLUGIN="${PIN_DOCKER_COMPOSE_PLUGIN:-5.5.0-1~ubuntu.26.04~resolute}"

log()  { echo -e "\n[REIN-DEPS] $*"; }
warn() { echo -e "\n[AVISO] $*" >&2; }

apt_install_pinned() {
    local pkg="$1" ver="$2"
    if [ -n "$ver" ] && apt-cache madison "$pkg" 2>/dev/null \
        | awk -F'|' '{gsub(/^[ \t]+|[ \t]+$/,"",$2); print $2}' | grep -qx "$ver"; then
        apt-get install -y "${pkg}=${ver}"
    else
        [ -n "$ver" ] && warn "Versão $ver de '$pkg' não está no repositório atual — instalando a mais recente disponível."
        apt-get install -y "$pkg"
    fi
}

log "Atualizando índices do apt"
apt-get update

log "Instalando Docker CE + Compose plugin (repositório oficial da Docker)"
apt-get install -y ca-certificates curl
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
apt-get update
apt_install_pinned docker-ce "$PIN_DOCKER_CE"
apt_install_pinned docker-ce-cli "$PIN_DOCKER_CE_CLI"
apt-get install -y containerd.io docker-buildx-plugin
apt_install_pinned docker-compose-plugin "$PIN_DOCKER_COMPOSE_PLUGIN"
systemctl enable --now docker
if ! getent group docker >/dev/null; then groupadd docker; fi
usermod -aG "docker" "${SUDO_USER:-$USER}"
log "Usuário '${SUDO_USER:-$USER}' adicionado ao grupo 'docker' — precisa de novo login (ou 'newgrp docker') para rodar 'docker' sem sudo."

log "Pronto. Próximo passo: docker compose build"

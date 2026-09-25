#!/bin/bash
# ==============================================================================
# BotConnecta Agent Installer
# 
# Execute na VPS do cliente:
#   curl -fsSL https://raw.githubusercontent.com/SEU_USUARIO/botconnecta-manager/main/agent/install-agent.sh | sudo bash -s -- --token SEU_TOKEN
#
# Ou copie e execute localmente:
#   sudo bash install-agent.sh --token SEU_TOKEN
# ==============================================================================

set -euo pipefail

# ── Cores ────────────────────────────────────────────────────────────────────
RED='\033[1;31m'
GREEN='\033[1;32m'
YELLOW='\033[1;33m'
BLUE='\033[1;34m'
CYAN='\033[1;36m'
WHITE='\033[1;37m'
NC='\033[0m'

# ── Configuração ─────────────────────────────────────────────────────────────
AGENT_PORT=7443
INSTALL_DIR=/opt/botconnecta
BACKUP_DIR=/opt/botconnecta-backups
AGENT_DIR=/opt/botconnecta-agent
AGENT_USER=botconnecta
RELEASES_URL=""
AGENT_TOKEN=""
GHCR_USER=""
GHCR_TOKEN=""

# ── Parse de argumentos ───────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --token)       AGENT_TOKEN="$2";    shift 2 ;;
    --port)        AGENT_PORT="$2";     shift 2 ;;
    --releases)    RELEASES_URL="$2";   shift 2 ;;
    --install-dir) INSTALL_DIR="$2";    shift 2 ;;
    --ghcr-user)   GHCR_USER="$2";      shift 2 ;;
    --ghcr-token)  GHCR_TOKEN="$2";     shift 2 ;;
    *) shift ;;
  esac
done

# ── Funções ───────────────────────────────────────────────────────────────────
banner() {
  echo -e "${BLUE}"
  echo "  ╔══════════════════════════════════════════╗"
  echo "  ║        BOTCONNECTA AGENT INSTALLER       ║"
  echo "  ║              VPS Setup v1.0              ║"
  echo "  ╚══════════════════════════════════════════╝"
  echo -e "${NC}"
}

step() { echo -e "${CYAN}▶ $1${NC}"; }
ok()   { echo -e "${GREEN}✓ $1${NC}"; }
warn() { echo -e "${YELLOW}⚠ $1${NC}"; }
fail() { echo -e "${RED}✗ $1${NC}"; exit 1; }

check_root() {
  if [[ $EUID -ne 0 ]]; then
    fail "Este script precisa ser executado como root. Use: sudo bash $0"
  fi
}

check_os() {
  step "Verificando sistema operacional..."
  if ! command -v lsb_release &>/dev/null; then
    fail "lsb_release não encontrado. Ubuntu/Debian necessário."
  fi
  OS=$(lsb_release -si)
  VER=$(lsb_release -sr)
  if [[ "$OS" != "Ubuntu" && "$OS" != "Debian" ]]; then
    fail "Sistema não suportado: $OS. Ubuntu 20.04+ ou Debian 11+ necessário."
  fi
  ok "Sistema: $OS $VER"
}

install_node() {
  step "Verificando Node.js..."
  if command -v node &>/dev/null; then
    NODE_VER=$(node --version)
    ok "Node.js já instalado: $NODE_VER"
    return
  fi

  step "Instalando Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
  ok "Node.js instalado: $(node --version)"
}

install_docker() {
  step "Verificando Docker..."
  if command -v docker &>/dev/null; then
    ok "Docker já instalado: $(docker --version)"
    return
  fi

  step "Instalando Docker..."
  apt-get update -qq
  apt-get install -y ca-certificates curl gnupg lsb-release

  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | \
    gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg

  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
    https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | \
    tee /etc/apt/sources.list.d/docker.list > /dev/null

  apt-get update -qq
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

  systemctl enable docker
  systemctl start docker

  ok "Docker instalado: $(docker --version)"
}

setup_agent() {
  step "Configurando agente BotConnecta..."

  # Cria usuário
  if ! id "$AGENT_USER" &>/dev/null; then
    useradd -r -s /bin/bash -d "$AGENT_DIR" "$AGENT_USER" || true
    usermod -aG docker "$AGENT_USER"
  fi

  # Cria diretórios
  mkdir -p "$AGENT_DIR" "$INSTALL_DIR" "$BACKUP_DIR"
  chown -R "$AGENT_USER:$AGENT_USER" "$AGENT_DIR" "$INSTALL_DIR" "$BACKUP_DIR"

  # Instala arquivos do agente
  BASE_REPO="${RELEASES_URL:-https://raw.githubusercontent.com/williamcesar/instalador_botconnecta/main}"
  if curl -fsSL "$BASE_REPO/agent.js" -o "$AGENT_DIR/agent.js" 2>/dev/null; then
    curl -fsSL "$BASE_REPO/package.json" -o "$AGENT_DIR/package.json" 2>/dev/null || true
  else
    curl -fsSL "$BASE_REPO/agent/agent.js" -o "$AGENT_DIR/agent.js"
    curl -fsSL "$BASE_REPO/agent/package.json" -o "$AGENT_DIR/package.json" || true
  fi

  # Cria arquivo de ambiente
  cat > "$AGENT_DIR/.env" <<EOF
AGENT_TOKEN=${AGENT_TOKEN}
AGENT_PORT=${AGENT_PORT}
INSTALL_DIR=${INSTALL_DIR}
BACKUP_DIR=${BACKUP_DIR}
RELEASES_URL=${RELEASES_URL}
GHCR_USER=${GHCR_USER}
GHCR_TOKEN=${GHCR_TOKEN}
EOF
  chmod 600 "$AGENT_DIR/.env"
  chown "$AGENT_USER:$AGENT_USER" "$AGENT_DIR/.env"

  if [[ -n "$GHCR_TOKEN" && -n "$GHCR_USER" ]]; then
    step "Autenticando Docker no GitHub Container Registry (ghcr.io)..."
    echo "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin || warn "Aviso: Não foi possível autenticar no ghcr.io agora. Poderá ser feito depois."
  fi

  ok "Arquivos do agente configurados em $AGENT_DIR"
}

create_systemd_service() {
  step "Criando serviço systemd..."

  cat > /etc/systemd/system/botconnecta-agent.service <<EOF
[Unit]
Description=BotConnecta VPS Agent
After=network.target docker.service
Wants=docker.service

[Service]
Type=simple
User=${AGENT_USER}
WorkingDirectory=${AGENT_DIR}
EnvironmentFile=${AGENT_DIR}/.env
ExecStart=/usr/bin/node ${AGENT_DIR}/agent.js
Restart=always
RestartSec=10
StandardOutput=syslog
StandardError=syslog
SyslogIdentifier=botconnecta-agent

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable botconnecta-agent
  systemctl start botconnecta-agent

  ok "Serviço botconnecta-agent ativo"
}

setup_firewall() {
  step "Configurando firewall (porta $AGENT_PORT)..."
  if command -v ufw &>/dev/null; then
    ufw allow "$AGENT_PORT/tcp" comment "BotConnecta Agent" || true
    ok "Porta $AGENT_PORT liberada no UFW"
  else
    warn "UFW não encontrado. Libere a porta $AGENT_PORT manualmente."
  fi
}

verify_agent() {
  step "Verificando agente..."
  sleep 3

  if curl -sf "http://localhost:${AGENT_PORT}/ping" | grep -q '"ok":true'; then
    ok "Agente respondendo na porta $AGENT_PORT"
  else
    warn "Agente não respondeu. Verifique: sudo systemctl status botconnecta-agent"
  fi
}

print_summary() {
  PUBLIC_IP=$(curl -s http://checkip.amazonaws.com || echo "IP_NAO_DETECTADO")
  echo ""
  echo -e "${GREEN}╔══════════════════════════════════════════╗${NC}"
  echo -e "${GREEN}║         AGENTE INSTALADO COM SUCESSO     ║${NC}"
  echo -e "${GREEN}╚══════════════════════════════════════════╝${NC}"
  echo ""
  echo -e "  ${WHITE}IP da VPS:${NC}       $PUBLIC_IP"
  echo -e "  ${WHITE}Porta do agente:${NC} $AGENT_PORT"
  echo -e "  ${WHITE}URL do agente:${NC}   http://$PUBLIC_IP:$AGENT_PORT"
  echo -e "  ${WHITE}Token:${NC}           ${AGENT_TOKEN:0:8}... (oculto)"
  echo ""
  echo -e "  ${CYAN}Comandos úteis:${NC}"
  echo -e "  sudo systemctl status botconnecta-agent"
  echo -e "  sudo journalctl -u botconnecta-agent -f"
  echo ""
  echo -e "  ${YELLOW}Adicione esta VPS no painel com as informações acima.${NC}"
  echo ""
}

# ── Execução Principal ────────────────────────────────────────────────────────
banner
check_root

if [[ -z "$AGENT_TOKEN" ]]; then
  fail "Token não informado. Use: sudo bash install-agent.sh --token SEU_TOKEN_SECRETO"
fi

check_os
apt-get update -qq
apt-get install -y curl wget git

install_node
install_docker
setup_agent
create_systemd_service
setup_firewall
verify_agent
print_summary

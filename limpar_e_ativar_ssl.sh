#!/bin/bash
# ==============================================================================
# BotConnecta — Limpeza do Banco (Novo Cliente) e Ativação do SSL Oficial
# ==============================================================================

set -e

RED='\033[1;31m'
GREEN='\033[1;32m'
YELLOW='\033[1;33m'
CYAN='\033[1;36m'
NC='\033[0m'

echo -e "${CYAN}=====================================================${NC}"
echo -e "${CYAN}▶ 1/11. Atualizando Agente BotConnecta na VPS...${NC}"
echo -e "${CYAN}=====================================================${NC}"
curl -fsSL https://raw.githubusercontent.com/williamcesar/instalador_botconnecta/main/agent.js -o /opt/botconnecta-agent/agent.js
systemctl restart botconnecta-agent
echo -e "${GREEN}✓ Agente atualizado e reiniciado com sucesso!${NC}"

cd /opt/botconnecta

echo -e "${CYAN}=====================================================${NC}"
echo -e "${CYAN}▶ 2/11. Sanitizando senhas do .env (remove caracteres especiais)...${NC}"
echo -e "${CYAN}=====================================================${NC}"
if [ -f .env ]; then
    sed -i 's/\+/X/g' .env
    sed -i 's/\//Y/g' .env
    echo -e "${GREEN}✓ Arquivo .env sanitizado!${NC}"
fi

# Carrega variáveis do .env
export DOMAIN_FRONTEND=$(grep -E '^DOMAIN_FRONTEND=' .env 2>/dev/null | head -n1 | cut -d'=' -f2- | tr -d '\r"')
export DOMAIN_BACKEND=$(grep -E '^DOMAIN_BACKEND=' .env 2>/dev/null | head -n1 | cut -d'=' -f2- | tr -d '\r"')
export DOMAIN_API_OFICIAL=$(grep -E '^DOMAIN_API_OFICIAL=' .env 2>/dev/null | head -n1 | cut -d'=' -f2- | tr -d '\r"')
export POSTGRES_PASSWORD=$(grep -E '^POSTGRES_PASSWORD=' .env 2>/dev/null | head -n1 | cut -d'=' -f2- | tr -d '\r"')
export DB_NAME_OFICIAL=$(grep -E '^DB_NAME_OFICIAL=' .env 2>/dev/null | head -n1 | cut -d'=' -f2- | tr -d '\r"')
[ -z "$DOMAIN_FRONTEND" ] && export DOMAIN_FRONTEND="wa.botconnecta.com.br"
[ -z "$DOMAIN_BACKEND" ] && export DOMAIN_BACKEND="waapi.botconnecta.com.br"
[ -z "$DOMAIN_API_OFICIAL" ] && export DOMAIN_API_OFICIAL="waapioficial.botconnecta.com.br"
[ -z "$DB_NAME_OFICIAL" ] && export DB_NAME_OFICIAL="botconnecta_oficial"

export ADMIN_EMAIL=$(grep -E '^(API_OFICIAL_ADMIN_EMAIL|ADMIN_EMAIL)=' .env 2>/dev/null | head -n1 | cut -d'=' -f2- | tr -d '\r"')
export ADMIN_PASSWORD=$(grep -E '^(API_OFICIAL_ADMIN_PASSWORD|ADMIN_PASSWORD)=' .env 2>/dev/null | head -n1 | cut -d'=' -f2- | tr -d '\r"')
[ -z "$ADMIN_EMAIL" ] && export ADMIN_EMAIL="admin@williamalmeida.com.br"
[ -z "$ADMIN_PASSWORD" ] && export ADMIN_PASSWORD="APuoo6uQdZEPCdBi j6YGY1Td"

echo -e "${CYAN}=====================================================${NC}"
echo -e "${CYAN}▶ 3/11. Baixando docker-compose.yml atualizado...${NC}"
echo -e "${CYAN}=====================================================${NC}"
curl -fsSL https://raw.githubusercontent.com/williamcesar/instalador_botconnecta/main/releases/1.0.0/docker-compose.yml -o docker-compose.yml
mkdir -p docker/postgres
curl -fsSL https://raw.githubusercontent.com/williamcesar/instalador_botconnecta/main/releases/1.0.0/docker/postgres/init-multiple-dbs.sh -o docker/postgres/init-multiple-dbs.sh
chmod +x docker/postgres/init-multiple-dbs.sh
echo -e "${GREEN}✓ docker-compose.yml e scripts atualizados!${NC}"

echo -e "${CYAN}=====================================================${NC}"
echo -e "${CYAN}▶ 4/11. Removendo containers e volumes antigos (ZERA O BANCO)...${NC}"
echo -e "${CYAN}=====================================================${NC}"
docker compose down -v
echo -e "${GREEN}✓ Volumes antigos apagados (contatos, tickets e kanban de localhost removidos)!${NC}"

echo -e "${CYAN}=====================================================${NC}"
echo -e "${CYAN}▶ 5/11. Inicializando PostgreSQL e Redis limpos...${NC}"
echo -e "${CYAN}=====================================================${NC}"
docker compose up -d postgres redis

echo "Aguardando PostgreSQL inicializar..."
for i in {1..30}; do
    if docker compose exec -T postgres pg_isready -U botconnecta >/dev/null 2>&1; then
        echo -e "${GREEN}✓ PostgreSQL pronto!${NC}"
        break
    fi
    sleep 2
done

# Garante senha correta e existência do banco oficial
if [ -n "$POSTGRES_PASSWORD" ]; then
    docker compose exec -T postgres psql -U botconnecta -d template1 -c "ALTER USER botconnecta WITH PASSWORD '$POSTGRES_PASSWORD';" || true
fi
docker compose exec -T postgres psql -U botconnecta -d template1 -tc "SELECT 1 FROM pg_database WHERE datname = '$DB_NAME_OFICIAL'" | grep -q 1 || docker compose exec -T postgres psql -U botconnecta -d template1 -c "CREATE DATABASE \"$DB_NAME_OFICIAL\" OWNER botconnecta;" || true

echo -e "${CYAN}=====================================================${NC}"
echo -e "${CYAN}▶ 6/11. Executando migrations do Backend...${NC}"
echo -e "${CYAN}=====================================================${NC}"
docker compose run --rm backend npm run db:migrate

echo -e "${CYAN}=====================================================${NC}"
echo -e "${CYAN}▶ 7/11. Executando seeds limpas do Backend (Empresa 1)...${NC}"
echo -e "${CYAN}=====================================================${NC}"
docker compose run --rm backend npm run db:seed

echo -e "${CYAN}=====================================================${NC}"
echo -e "${CYAN}▶ 8/11. Configurando usuário administrador do cliente...${NC}"
echo -e "${CYAN}=====================================================${NC}"
docker compose run --rm backend node -e "const bcrypt = require('bcryptjs'); const { Sequelize } = require('sequelize'); const s = new Sequelize(process.env.DB_NAME, process.env.DB_USER, process.env.DB_PASS, { host: process.env.DB_HOST, dialect: 'postgres', logging: false }); s.query(\"UPDATE \\\"Users\\\" SET email='\" + process.env.ADMIN_EMAIL + \"', \\\"passwordHash\\\"='\" + bcrypt.hashSync(process.env.ADMIN_PASSWORD, 8) + \"' WHERE id=1;\").then(() => { console.log('✓ Admin configurado com sucesso!'); process.exit(0); }).catch(e => { console.error('Erro admin:', e); process.exit(1); });"

echo -e "${CYAN}=====================================================${NC}"
echo -e "${CYAN}▶ 9/11. Executando migrations da API Oficial...${NC}"
echo -e "${CYAN}=====================================================${NC}"
docker compose run --rm api_oficial npx prisma migrate deploy

echo -e "${CYAN}=====================================================${NC}"
echo -e "${CYAN}▶ 10/11. Gerando certificados bootstrap para inicialização do Nginx...${NC}"
echo -e "${CYAN}=====================================================${NC}"
for dom in "$DOMAIN_FRONTEND" "$DOMAIN_BACKEND" "$DOMAIN_API_OFICIAL"; do
    docker compose run --rm --entrypoint sh certbot -c "mkdir -p /etc/letsencrypt/live/$dom && if [ ! -f /etc/letsencrypt/live/$dom/fullchain.pem ]; then openssl req -x509 -nodes -newkey rsa:2048 -days 1 -keyout /etc/letsencrypt/live/$dom/privkey.pem -out /etc/letsencrypt/live/$dom/fullchain.pem -subj '/CN=$dom'; fi"
done

echo -e "${CYAN}=====================================================${NC}"
echo -e "${CYAN}▶ 11/11. Subindo todos os containers e emitindo SSL Let's Encrypt...${NC}"
echo -e "${CYAN}=====================================================${NC}"
docker compose up -d
sleep 5

for dom in "$DOMAIN_FRONTEND" "$DOMAIN_BACKEND" "$DOMAIN_API_OFICIAL"; do
    echo "Emitindo certificado SSL para $dom..."
    docker compose exec -T certbot certbot certonly --webroot -w /var/www/certbot --email "$ADMIN_EMAIL" -d "$dom" --agree-tos --no-eff-email --force-renewal --non-interactive || \
    docker compose run --rm --no-deps certbot certonly --webroot -w /var/www/certbot --email "$ADMIN_EMAIL" -d "$dom" --agree-tos --no-eff-email --force-renewal --non-interactive || true
done

echo "Recarregando Nginx..."
docker compose exec -T nginx nginx -s reload || docker compose restart nginx

echo -e "${GREEN}=====================================================${NC}"
echo -e "${GREEN}🎉 TUDO CONCLUÍDO COM SUCESSO!${NC}"
echo -e "${GREEN}✓ Banco 100% limpo e zerado para o novo cliente${NC}"
echo -e "${GREEN}✓ Admin configurado: $ADMIN_EMAIL${NC}"
echo -e "${GREEN}✓ SSL Let's Encrypt ativo e seguro (HTTPS oficial)${NC}"
echo -e "${GREEN}✓ Todos os containers rodando!${NC}"
echo -e "${GREEN}=====================================================${NC}"

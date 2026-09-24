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

echo -e "${CYAN}=====================================================${NC}"
echo -e "${CYAN}▶ 3/11. Baixando docker-compose.yml atualizado...${NC}"
echo -e "${CYAN}=====================================================${NC}"
curl -fsSL https://raw.githubusercontent.com/williamcesar/instalador_botconnecta/main/releases/1.0.0/docker-compose.yml -o docker-compose.yml
echo -e "${GREEN}✓ docker-compose.yml atualizado!${NC}"

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
docker compose run --rm backend node -e "const bcrypt = require('bcryptjs'); const { Sequelize } = require('sequelize'); const s = new Sequelize(process.env.DB_NAME, process.env.DB_USER, process.env.DB_PASS, { host: process.env.DB_HOST, dialect: 'postgres', logging: false }); s.query(\"UPDATE \\\"Users\\\" SET email='admin@williamalmeida.com.br', \\\"passwordHash\\\"='\" + bcrypt.hashSync('APuoo6uQdZEPCdBi j6YGY1Td', 8) + \"' WHERE id=1;\").then(() => { console.log('✓ Admin configurado com sucesso!'); process.exit(0); }).catch(e => { console.error('Erro admin:', e); process.exit(1); });"

echo -e "${CYAN}=====================================================${NC}"
echo -e "${CYAN}▶ 9/11. Executando migrations da API Oficial...${NC}"
echo -e "${CYAN}=====================================================${NC}"
docker compose run --rm api_oficial npx prisma migrate deploy

echo -e "${CYAN}=====================================================${NC}"
echo -e "${CYAN}▶ 10/12. Gerando certificados bootstrap para inicialização do Nginx...${NC}"
echo -e "${CYAN}=====================================================${NC}"
for dom in wa.botconnecta.com.br waapi.botconnecta.com.br waapioficial.botconnecta.com.br; do
    docker compose run --rm --entrypoint sh certbot -c "mkdir -p /etc/letsencrypt/live/$dom && openssl req -x509 -nodes -newkey rsa:2048 -days 1 -keyout /etc/letsencrypt/live/$dom/privkey.pem -out /etc/letsencrypt/live/$dom/fullchain.pem -subj '/CN=$dom'"
done

echo -e "${CYAN}=====================================================${NC}"
echo -e "${CYAN}▶ 11/12. Subindo todos os containers do BotConnecta...${NC}"
echo -e "${CYAN}=====================================================${NC}"
docker compose up -d
sleep 3

echo -e "${CYAN}=====================================================${NC}"
echo -e "${CYAN}▶ 11/11. Emitindo certificados SSL oficiais Let's Encrypt...${NC}"
echo -e "${CYAN}=====================================================${NC}"
docker compose exec -T certbot certbot certonly --webroot -w /var/www/certbot --email admin@williamalmeida.com.br -d wa.botconnecta.com.br --agree-tos --no-eff-email --force-renewal --non-interactive || docker compose run --rm --no-deps certbot certonly --webroot -w /var/www/certbot --email admin@williamalmeida.com.br -d wa.botconnecta.com.br --agree-tos --no-eff-email --force-renewal --non-interactive

docker compose exec -T certbot certbot certonly --webroot -w /var/www/certbot --email admin@williamalmeida.com.br -d waapi.botconnecta.com.br --agree-tos --no-eff-email --force-renewal --non-interactive || docker compose run --rm --no-deps certbot certonly --webroot -w /var/www/certbot --email admin@williamalmeida.com.br -d waapi.botconnecta.com.br --agree-tos --no-eff-email --force-renewal --non-interactive

docker compose exec -T certbot certbot certonly --webroot -w /var/www/certbot --email admin@williamalmeida.com.br -d waapioficial.botconnecta.com.br --agree-tos --no-eff-email --force-renewal --non-interactive || docker compose run --rm --no-deps certbot certonly --webroot -w /var/www/certbot --email admin@williamalmeida.com.br -d waapioficial.botconnecta.com.br --agree-tos --no-eff-email --force-renewal --non-interactive

echo "Recarregando Nginx..."
docker compose exec -T nginx nginx -s reload

echo -e "${GREEN}=====================================================${NC}"
echo -e "${GREEN}🎉 TUDO CONCLUÍDO COM SUCESSO!${NC}"
echo -e "${GREEN}✓ Banco 100% limpo e zerado para o novo cliente${NC}"
echo -e "${GREEN}✓ Admin configurado: admin@williamalmeida.com.br${NC}"
echo -e "${GREEN}✓ SSL Let's Encrypt ativo e seguro (HTTPS oficial)${NC}"
echo -e "${GREEN}✓ Painel Agente atualizado e pronto para checagem online${NC}"
echo -e "${GREEN}=====================================================${NC}"

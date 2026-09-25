#!/usr/bin/env node
/**
 * BotConnecta VPS Agent
 * Serviço leve que roda na VPS do cliente e executa operações Docker
 * sob comando do Painel Central (BotConnecta Manager).
 * 
 * Porta: 7443
 * Auth: Bearer token (definido em AGENT_TOKEN)
 */

const http = require('http');
const https = require('https');
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── Configuração ──────────────────────────────────────────────────────────────
const PORT = process.env.AGENT_PORT || 7443;
const AGENT_TOKEN = process.env.AGENT_TOKEN;
const INSTALL_DIR = process.env.INSTALL_DIR || '/opt/botconnecta';
const BACKUP_DIR = process.env.BACKUP_DIR || '/opt/botconnecta-backups';
const RELEASES_URL = process.env.RELEASES_URL || 'https://raw.githubusercontent.com/williamcesar/instalador_botconnecta/main';
const GHCR_USER = process.env.GHCR_USER || '';
const GHCR_TOKEN = process.env.GHCR_TOKEN || '';
const VERSION_FILE = path.join(INSTALL_DIR, '.version');

if (!AGENT_TOKEN) {
  console.error('[AGENT] FATAL: AGENT_TOKEN não definido!');
  process.exit(1);
}

// ── Utilitários ───────────────────────────────────────────────────────────────
function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

function ensureDockerAuth(customUser, customToken) {
  const u = (customUser || GHCR_USER || '').trim();
  const t = (customToken || GHCR_TOKEN || '').trim();
  if (u && t) {
    try {
      execSync(`echo "${t}" | docker login ghcr.io -u "${u}" --password-stdin`, { stdio: 'pipe' });
      log('[DOCKER] Autenticado com sucesso no ghcr.io');
    } catch (authErr) {
      log(`[DOCKER] Aviso na autenticação ghcr.io: ${authErr.message}`);
    }
  }
}

function exec(cmd, opts = {}) {
  log(`EXEC: ${cmd}`);
  return execSync(cmd, {
    cwd: INSTALL_DIR,
    stdio: 'pipe',
    ...opts,
  }).toString().trim();
}

function jsonResponse(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'X-Agent-Version': '1.0.0',
  });
  res.end(body);
}

function authenticate(req) {
  try {
    const auth = req.headers['authorization'] || '';
    const token = auth.replace('Bearer ', '').trim();
    if (!token || !AGENT_TOKEN) return false;
    const bufA = Buffer.from(token);
    const bufB = Buffer.from(AGENT_TOKEN);
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch (e) { resolve({}); }
    });
    req.on('error', reject);
  });
}

function getCurrentVersion() {
  if (fs.existsSync(VERSION_FILE)) {
    return fs.readFileSync(VERSION_FILE, 'utf8').trim();
  }
  return 'unknown';
}

// ── Handlers ──────────────────────────────────────────────────────────────────

async function handleHealth(req, res) {
  const services = ['frontend', 'backend', 'api_oficial', 'api_transcricao', 'postgres', 'redis', 'nginx'];
  const status = {};

  for (const svc of services) {
    try {
      const out = exec(`docker compose ps --format json ${svc}`);
      let item = null;
      try {
        const parsed = JSON.parse(out.trim());
        item = Array.isArray(parsed) ? parsed[0] : parsed;
      } catch {
        const firstLine = out.trim().split('\n')[0];
        if (firstLine) {
          const parsedLine = JSON.parse(firstLine);
          item = Array.isArray(parsedLine) ? parsedLine[0] : parsedLine;
        }
      }

      const state = (item?.State || item?.state || '').toLowerCase();
      const health = (item?.Health || item?.health || 'none').toLowerCase();
      const isRunning = state === 'running';

      status[svc] = {
        running: isRunning,
        state: state || (isRunning ? 'running' : 'stopped'),
        health: health,
      };
    } catch {
      status[svc] = { running: false, state: 'stopped', health: 'none' };
    }
  }

  const allUp = Object.values(status).every(s => s.running);

  return jsonResponse(res, 200, {
    ok: allUp,
    version: getCurrentVersion(),
    installDir: INSTALL_DIR,
    services: status,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
}

async function handleInstall(req, res) {
  const body = await readBody(req);
  const {
    version,
    dockerhubUser,
    env: envVars,
  } = body;

  if (!version || !dockerhubUser || !envVars) {
    return jsonResponse(res, 400, { ok: false, error: 'Parâmetros obrigatórios: version, dockerhubUser, env' });
  }

  // Responde imediatamente — processo em background
  jsonResponse(res, 202, { ok: true, message: 'Instalação iniciada', version });

  const logFile = path.join(INSTALL_DIR, 'install.log');
  const logger = fs.createWriteStream(logFile, { flags: 'a' });

  function step(msg) {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    logger.write(line);
    log(msg);
  }

  const releasesUrl = body.releasesUrl || RELEASES_URL || 'https://raw.githubusercontent.com/williamcesar/instalador_botconnecta/main';

  try {
    step('🧹 Limpando containers e volumes anteriores para instalação limpa...');
    try {
      exec(`docker compose down -v`);
    } catch (cleanErr) {
      log(`Aviso ao limpar volumes anteriores: ${cleanErr.message}`);
    }

    // Cria diretórios
    fs.mkdirSync(INSTALL_DIR, { recursive: true });
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    fs.mkdirSync(path.join(INSTALL_DIR, 'docker/postgres'), { recursive: true });
    fs.mkdirSync(path.join(INSTALL_DIR, 'docker/nginx/templates'), { recursive: true });

    step('📦 Baixando docker-compose.yml e arquivos de configuração...');
    // Pull do docker-compose.yml do repositório central
    exec(`curl -fsSL "${releasesUrl}/releases/${version}/docker-compose.yml" -o docker-compose.yml`);
    exec(`curl -fsSL "${releasesUrl}/releases/${version}/docker/nginx/nginx.conf" -o docker/nginx/nginx.conf`);
    exec(`curl -fsSL "${releasesUrl}/releases/${version}/docker/nginx/templates/default.conf.template" -o docker/nginx/templates/default.conf.template`);
    exec(`curl -fsSL "${releasesUrl}/releases/${version}/docker/nginx/options-ssl-nginx.conf" -o docker/nginx/options-ssl-nginx.conf`);
    exec(`curl -fsSL "${releasesUrl}/releases/${version}/docker/nginx/ssl-dhparams.pem" -o docker/nginx/ssl-dhparams.pem`);
    exec(`curl -fsSL "${releasesUrl}/releases/${version}/docker/postgres/init-multiple-dbs.sh" -o docker/postgres/init-multiple-dbs.sh`);
    exec(`chmod +x docker/postgres/init-multiple-dbs.sh`);

    step('📝 Criando arquivo .env...');
    if (envVars.POSTGRES_PASSWORD) {
      envVars.POSTGRES_PASSWORD = envVars.POSTGRES_PASSWORD.replace(/[^a-zA-Z0-9_-]/g, 'X');
    }
    if (envVars.REDIS_PASSWORD) {
      envVars.REDIS_PASSWORD = envVars.REDIS_PASSWORD.replace(/[^a-zA-Z0-9_-]/g, 'X');
    }
    const envContent = Object.entries(envVars)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    fs.writeFileSync(path.join(INSTALL_DIR, '.env'), envContent + '\n', 'utf8');
    exec(`echo 'DOCKERHUB_USER=${dockerhubUser}' >> .env`);
    exec(`echo 'VERSION=${version}' >> .env`);

    step('🐳 Baixando imagens Docker...');
    ensureDockerAuth(body.ghcrUser, body.ghcrToken);
    exec(`docker compose pull`);

    step('🔒 Inicializando certificados de segurança e SSL bootstrap...');
    const domains = [envVars.DOMAIN_FRONTEND, envVars.DOMAIN_BACKEND, envVars.DOMAIN_API_OFICIAL].filter(Boolean);
    for (const dom of domains) {
      try {
        exec(`docker compose run --rm --entrypoint sh certbot -c "mkdir -p /etc/letsencrypt/live/${dom} && if [ ! -f /etc/letsencrypt/live/${dom}/fullchain.pem ]; then openssl req -x509 -nodes -newkey rsa:2048 -days 1 -keyout /etc/letsencrypt/live/${dom}/privkey.pem -out /etc/letsencrypt/live/${dom}/fullchain.pem -subj '/CN=${dom}'; fi"`);
      } catch (sslErr) {
        log(`Aviso ao criar certificado temporário para ${dom}: ${sslErr.message}`);
      }
    }

    step('🚀 Subindo containers...');
    exec(`docker compose up -d`);

    step('⏳ Aguardando banco de dados...');
    let dbReady = false;
    const pgUser = envVars.POSTGRES_USER || 'botconnecta';
    for (let i = 0; i < 30; i++) {
      try {
        exec(`docker compose exec -T postgres pg_isready -U ${pgUser}`);
        dbReady = true;
        break;
      } catch {
        execSync('sleep 2');
      }
    }
    if (!dbReady) throw new Error('Banco de dados não ficou pronto em 60s');

    step('🔑 Sincronizando credenciais e bancos do PostgreSQL...');
    const pgPass = envVars.POSTGRES_PASSWORD;
    const dbName = envVars.DB_NAME || 'botconnecta';
    const dbOficial = envVars.DB_NAME_OFICIAL || 'botconnecta_oficial';
    if (pgPass) {
      try {
        exec(`docker compose exec -T postgres psql -U ${pgUser} -d template1 -c "ALTER USER \\"${pgUser}\\" WITH PASSWORD '${pgPass}';"`);
        log('Senha do PostgreSQL sincronizada com o .env');
      } catch (pwErr) {
        log(`Aviso ao sincronizar senha do postgres: ${pwErr.message}`);
      }
    }
    try {
      exec(`docker compose exec -T postgres psql -U ${pgUser} -d template1 -tc "SELECT 1 FROM pg_database WHERE datname = '${dbOficial}'" | grep -q 1 || docker compose exec -T postgres psql -U ${pgUser} -d template1 -c "CREATE DATABASE \\"${dbOficial}\\" OWNER \\"${pgUser}\\";"`);
      log('Banco oficial verificado/criado com sucesso.');
    } catch (dbErr) {
      log(`Aviso ao verificar banco oficial: ${dbErr.message}`);
    }

    // Reinicia backend e api_oficial para conectarem com a senha sincronizada
    try {
      exec(`docker compose restart backend api_oficial`);
      execSync('sleep 5');
    } catch (restartErr) {
      log(`Aviso restart: ${restartErr.message}`);
    }

    step('🔄 Executando migrations do backend...');
    exec(`docker compose exec -T backend npm run db:migrate`);

    step('🌱 Executando seeds iniciais do backend (empresa e configurações)...');
    try {
      exec(`docker compose exec -T backend npm run db:seed`);
    } catch (seedErr) {
      log(`Aviso seed: ${seedErr.message}`);
    }

    const adminEmail = envVars.API_OFICIAL_ADMIN_EMAIL || envVars.ADMIN_EMAIL;
    const adminPass = envVars.API_OFICIAL_ADMIN_PASSWORD || envVars.ADMIN_PASSWORD;
    if (adminEmail && adminPass) {
      step(`👤 Configurando usuário administrador inicial (${adminEmail})...`);
      try {
        exec(`docker compose exec -T backend node -e "const bcrypt = require('bcryptjs'); const { Sequelize } = require('sequelize'); const s = new Sequelize(process.env.DB_NAME, process.env.DB_USER, process.env.DB_PASS, { host: process.env.DB_HOST, dialect: 'postgres', logging: false }); s.query(\\\"UPDATE \\\\\\\"Users\\\\\\\" SET email='${adminEmail}', \\\\\\\"passwordHash\\\\\\\"='\\\" + bcrypt.hashSync('${adminPass}', 8) + \\\"' WHERE id=1;\\\").then(() => { console.log('Admin sincronizado'); process.exit(0); }).catch(e => { console.error(e); process.exit(1); });"`);
      } catch (adminErr) {
        log(`Aviso ao sincronizar admin: ${adminErr.message}`);
      }
    }

    step('🔄 Executando migrations da API Oficial...');
    exec(`docker compose exec -T api_oficial npx prisma migrate deploy`);

    step('🔒 Solicitando certificados SSL Let\'s Encrypt...');
    const certEmail = envVars.API_OFICIAL_ADMIN_EMAIL || envVars.MAIL_FROM || ('admin@' + envVars.DOMAIN_FRONTEND);
    try {
      exec(`docker compose exec -T certbot sh -c "rm -rf /etc/letsencrypt/live/* /etc/letsencrypt/archive/* /etc/letsencrypt/renewal/*" 2>/dev/null || true`);
    } catch (cleanSslErr) {
      log(`Aviso ao limpar bootstrap SSL antes da emissão: ${cleanSslErr.message}`);
    }
    for (const dom of domains) {
      try {
        step(`🔒 Emitindo certificado SSL para ${dom}...`);
        let issued = false;
        try {
          exec(`docker compose exec -T certbot certbot certonly --webroot -w /var/www/certbot --email ${certEmail} -d ${dom} --agree-tos --no-eff-email --non-interactive`);
          issued = true;
        } catch (execErr) {
          log(`Tentando certbot via run: ${execErr.message}`);
          exec(`docker compose run --rm --no-deps certbot certonly --webroot -w /var/www/certbot --email ${certEmail} -d ${dom} --agree-tos --no-eff-email --non-interactive`);
          issued = true;
        }
        if (issued) step(`✅ Certificado SSL emitido com sucesso para ${dom}!`);
      } catch (sslErr) {
        step(`⚠️ Certbot aviso para ${dom}: ${sslErr.message}`);
      }
    }

    step('🔄 Recarregando Nginx com novos certificados...');
    try {
      exec(`docker compose exec -T nginx nginx -s reload`);
    } catch {
      try { exec(`docker compose restart nginx`); } catch (e) {}
    }

    step('📋 Salvando versão instalada...');
    fs.writeFileSync(VERSION_FILE, version, 'utf8');

    step('✅ Instalação concluída com sucesso!');
    logger.end();
  } catch (err) {
    step(`❌ ERRO: ${err.message}`);
    logger.end();
  }
}

async function handleUpdate(req, res) {
  const body = await readBody(req);
  const { version, dockerhubUser } = body;

  if (!version) {
    return jsonResponse(res, 400, { ok: false, error: 'Parâmetro obrigatório: version' });
  }

  jsonResponse(res, 202, { ok: true, message: 'Atualização iniciada', version });

  const logFile = path.join(INSTALL_DIR, 'update.log');
  const logger = fs.createWriteStream(logFile, { flags: 'a' });
  const previousVersion = getCurrentVersion();
  const backupPath = path.join(BACKUP_DIR, `backup-${previousVersion}-${Date.now()}`);

  function step(msg) {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    logger.write(line);
    log(msg);
  }

  try {
    step(`🔄 Atualizando de ${previousVersion} para ${version}...`);

    step('💾 Fazendo backup do banco de dados...');
    fs.mkdirSync(backupPath, { recursive: true });
    exec(`docker compose exec -T postgres pg_dumpall -U botconnecta > "${backupPath}/db-full.sql"`);
    fs.copyFileSync(path.join(INSTALL_DIR, '.env'), path.join(backupPath, '.env.bak'));
    fs.writeFileSync(path.join(backupPath, 'previous_version'), previousVersion);
    step(`✅ Backup salvo em ${backupPath}`);

    step('🐳 Baixando novas imagens Docker...');
    ensureDockerAuth(body.ghcrUser, body.ghcrToken);
    if (dockerhubUser) {
      if (exec(`grep -q "^DOCKERHUB_USER=" .env && echo "yes" || echo "no"`) === 'yes') {
        exec(`sed -i "s|^DOCKERHUB_USER=.*|DOCKERHUB_USER=${dockerhubUser}|" .env`);
      } else {
        exec(`echo 'DOCKERHUB_USER=${dockerhubUser}' >> .env`);
      }
    }
    exec(`sed -i "s|^VERSION=.*|VERSION=${version}|" .env`);
    exec(`docker compose pull`);

    step('📄 Atualizando configuração do Nginx (resolver DNS dinâmico)...');
    const releasesUrlForNginx = body.releasesUrl || RELEASES_URL;
    fs.mkdirSync(path.join(INSTALL_DIR, 'docker/nginx/templates'), { recursive: true });
    try {
      exec(`curl -fsSL "${releasesUrlForNginx}/releases/${version}/docker/nginx/nginx.conf" -o docker/nginx/nginx.conf`);
      exec(`curl -fsSL "${releasesUrlForNginx}/releases/${version}/docker/nginx/templates/default.conf.template" -o docker/nginx/templates/default.conf.template`);
      exec(`curl -fsSL "${releasesUrlForNginx}/releases/${version}/docker/nginx/options-ssl-nginx.conf" -o docker/nginx/options-ssl-nginx.conf`);
    } catch (nginxErr) {
      step(`⚠️ Aviso: não foi possível atualizar config do Nginx: ${nginxErr.message}`);
    }

    step('🚀 Atualizando containers...');
    exec(`docker compose up -d --remove-orphans`);

    // Aguarda backend e frontend estarem RUNNING antes de recarregar nginx
    // Isso evita que o nginx resolva IPs errados durante a inicialização dos containers
    step('⏳ Aguardando backend e frontend iniciarem (máx 60s)...');
    let containersReady = false;
    for (let i = 0; i < 20; i++) {
      execSync('sleep 3');
      try {
        const backendState = exec(`docker compose ps --format json backend`).trim().split('\n')[0];
        const frontendState = exec(`docker compose ps --format json frontend`).trim().split('\n')[0];
        const bState = JSON.parse(backendState || '{}');
        const fState = JSON.parse(frontendState || '{}');
        const bRunning = (bState.State || bState.state || '').toLowerCase() === 'running';
        const fRunning = (fState.State || fState.state || '').toLowerCase() === 'running';
        if (bRunning && fRunning) {
          containersReady = true;
          step(`✅ Backend e frontend estão RUNNING (tentativa ${i + 1})`);
          break;
        }
      } catch (_) { /* continua aguardando */ }
    }
    if (!containersReady) step('⚠️ Timeout aguardando containers — prosseguindo mesmo assim');

    // Recarrega nginx DEPOIS que os containers estão estáveis
    // (evita o problema de resolução de IPs errados)
    try { exec(`docker compose exec -T nginx nginx -s reload`); } catch (_) {
      try { exec(`docker compose restart nginx`); } catch (__) {}
    }

    step('⏳ Aguardando banco de dados...');
    for (let i = 0; i < 20; i++) {
      try {
        exec(`docker compose exec -T postgres pg_isready -U botconnecta`);
        break;
      } catch {
        execSync('sleep 3');
      }
    }

    step('🔄 Executando migrations...');
    exec(`docker compose exec -T backend npm run db:migrate`);
    exec(`docker compose exec -T api_oficial npx prisma migrate deploy`);

    step('🏥 Verificando saúde dos serviços...');
    execSync('sleep 15');
    exec(`docker compose ps`);

    fs.writeFileSync(VERSION_FILE, version, 'utf8');
    step(`✅ Atualização para ${version} concluída com sucesso!`);
    logger.end();
  } catch (err) {
    step(`❌ ERRO na atualização: ${err.message}`);
    step('⚠️ Iniciando rollback automático...');

    try {
      if (fs.existsSync(path.join(backupPath, '.env.bak'))) {
        fs.copyFileSync(path.join(backupPath, '.env.bak'), path.join(INSTALL_DIR, '.env'));
      } else {
        exec(`sed -i "s|^VERSION=.*|VERSION=${previousVersion}|" .env`);
      }
      exec(`docker compose up -d --remove-orphans`);

      if (fs.existsSync(path.join(backupPath, 'db-full.sql'))) {
        exec(`docker compose exec -T postgres psql -U botconnecta -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='botconnecta' AND pid <> pg_backend_pid();"`);
        exec(`docker compose exec -T postgres psql -U botconnecta < "${backupPath}/db-full.sql"`);
      }

      step(`✅ Rollback para ${previousVersion} concluído.`);
    } catch (rollbackErr) {
      step(`❌ ERRO no rollback: ${rollbackErr.message}`);
    }

    logger.end();
  }
}

async function handleRestart(req, res) {
  const body = await readBody(req);
  const service = body.service || '';

  try {
    if (service) {
      exec(`docker compose restart ${service}`);
    } else {
      exec(`docker compose up -d`);
      exec(`docker compose restart`);
    }
    return jsonResponse(res, 200, { ok: true, message: `Reiniciado: ${service || 'todos'}` });
  } catch (err) {
    return jsonResponse(res, 500, { ok: false, error: err.message });
  }
}

async function handleStop(req, res) {
  try {
    exec(`docker compose stop`);
    return jsonResponse(res, 200, { ok: true, message: 'Containers parados' });
  } catch (err) {
    return jsonResponse(res, 500, { ok: false, error: err.message });
  }
}

async function handleStart(req, res) {
  try {
    exec(`docker compose up -d`);
    return jsonResponse(res, 200, { ok: true, message: 'Containers iniciados' });
  } catch (err) {
    return jsonResponse(res, 500, { ok: false, error: err.message });
  }
}

async function handleBackup(req, res) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(BACKUP_DIR, `backup-${timestamp}`);

  try {
    fs.mkdirSync(backupPath, { recursive: true });
    exec(`docker compose exec -T postgres pg_dumpall -U botconnecta > "${backupPath}/db-full.sql"`);
    fs.copyFileSync(path.join(INSTALL_DIR, '.env'), path.join(backupPath, '.env.bak'));
    fs.writeFileSync(path.join(backupPath, 'version'), getCurrentVersion());

    // Comprime o backup
    exec(`tar -czf "${backupPath}.tar.gz" -C "${BACKUP_DIR}" "backup-${timestamp}"`);
    exec(`rm -rf "${backupPath}"`);

    const size = fs.statSync(`${backupPath}.tar.gz`).size;
    return jsonResponse(res, 200, {
      ok: true,
      backup: `backup-${timestamp}.tar.gz`,
      size,
      path: `${backupPath}.tar.gz`,
    });
  } catch (err) {
    return jsonResponse(res, 500, { ok: false, error: err.message });
  }
}

async function handleListBackups(req, res) {
  try {
    if (!fs.existsSync(BACKUP_DIR)) {
      return jsonResponse(res, 200, { ok: true, backups: [] });
    }
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.endsWith('.tar.gz'))
      .map(f => {
        const stat = fs.statSync(path.join(BACKUP_DIR, f));
        return { name: f, size: stat.size, created: stat.mtime.toISOString() };
      })
      .sort((a, b) => b.created.localeCompare(a.created));
    return jsonResponse(res, 200, { ok: true, backups: files });
  } catch (err) {
    return jsonResponse(res, 500, { ok: false, error: err.message });
  }
}

async function handleLogs(req, res, service) {
  // Server-Sent Events para logs em tempo real
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  let proc;
  if (service === 'install') {
    const logFile = path.join(INSTALL_DIR, 'install.log');
    if (!fs.existsSync(logFile)) {
      try {
        fs.mkdirSync(INSTALL_DIR, { recursive: true });
        fs.writeFileSync(logFile, '[Aguardando logs de instalação...]\n', 'utf8');
      } catch (e) {}
    }
    proc = spawn('tail', ['-n', '150', '-f', logFile]);
  } else {
    const args = ['compose', 'logs', '--follow', '--tail=100'];
    if (service) args.push(service);
    proc = spawn('docker', args, { cwd: INSTALL_DIR });
  }

  proc.stdout.on('data', data => {
    res.write(`data: ${JSON.stringify(data.toString())}\n\n`);
  });

  proc.stderr.on('data', data => {
    res.write(`data: ${JSON.stringify(data.toString())}\n\n`);
  });

  req.on('close', () => {
    proc.kill();
  });
}

async function handleSsl(req, res) {
  jsonResponse(res, 202, { ok: true, message: 'Emissão de certificados SSL iniciada' });

  const envPath = path.join(INSTALL_DIR, '.env');
  let envVars = {};
  if (fs.existsSync(envPath)) {
    const raw = fs.readFileSync(envPath, 'utf8');
    raw.split('\n').forEach(line => {
      const idx = line.indexOf('=');
      if (idx > 0) envVars[line.substring(0, idx).trim()] = line.substring(idx + 1).trim();
    });
  }
  const domains = [envVars.DOMAIN_FRONTEND, envVars.DOMAIN_BACKEND, envVars.DOMAIN_API_OFICIAL].filter(Boolean);
  const certEmail = envVars.API_OFICIAL_ADMIN_EMAIL || envVars.MAIL_FROM || ('admin@' + (envVars.DOMAIN_FRONTEND || 'botconnecta.com.br'));

  log(`🔒 Iniciando emissão de certificados SSL para: ${domains.join(', ')}`);

  // Garante bootstrap se algum não existir para o Nginx poder subir
  for (const dom of domains) {
    try {
      exec(`docker compose run --rm --entrypoint sh certbot -c "mkdir -p /etc/letsencrypt/live/${dom} && if [ ! -f /etc/letsencrypt/live/${dom}/fullchain.pem ]; then openssl req -x509 -nodes -newkey rsa:2048 -days 1 -keyout /etc/letsencrypt/live/${dom}/privkey.pem -out /etc/letsencrypt/live/${dom}/fullchain.pem -subj '/CN=${dom}'; fi"`);
    } catch (bootstrapErr) {
      log(`Aviso bootstrap SSL ${dom}: ${bootstrapErr.message}`);
    }
  }

  try {
    exec(`docker compose up -d nginx certbot`);
  } catch (upErr) {
    log(`Aviso subindo nginx/certbot: ${upErr.message}`);
  }

  try {
    exec(`docker compose exec -T certbot sh -c "rm -rf /etc/letsencrypt/live/* /etc/letsencrypt/archive/* /etc/letsencrypt/renewal/*" 2>/dev/null || true`);
  } catch (cleanSslErr) {
    log(`Aviso ao limpar bootstrap SSL antes da emissão: ${cleanSslErr.message}`);
  }

  for (const dom of domains) {
    try {
      let issued = false;
      try {
        exec(`docker compose exec -T certbot certbot certonly --webroot -w /var/www/certbot --email ${certEmail} -d ${dom} --agree-tos --no-eff-email --non-interactive`);
        issued = true;
      } catch (e1) {
        exec(`docker compose run --rm --no-deps certbot certonly --webroot -w /var/www/certbot --email ${certEmail} -d ${dom} --agree-tos --no-eff-email --non-interactive`);
        issued = true;
      }
      if (issued) log(`✅ Certificado SSL emitido com sucesso para ${dom}`);
    } catch (err) {
      log(`❌ Erro ao emitir SSL para ${dom}: ${err.message}`);
    }
  }

  try {
    exec(`docker compose exec -T nginx nginx -s reload`);
  } catch {
    try { exec(`docker compose restart nginx`); } catch (e) {}
  }
}

async function handleCleanDb(req, res) {
  jsonResponse(res, 202, { ok: true, message: 'Reset do banco e instalação limpa iniciada' });

  const envPath = path.join(INSTALL_DIR, '.env');
  let envVars = {};
  if (fs.existsSync(envPath)) {
    let raw = fs.readFileSync(envPath, 'utf8');
    if (raw.includes('+') || raw.includes('/')) {
      raw = raw.replace(/\+/g, 'X').replace(/\//g, 'Y');
      fs.writeFileSync(envPath, raw, 'utf8');
      log('✓ Caracteres especiais na senha do .env sanitizados');
    }
    raw.split('\n').forEach(line => {
      const idx = line.indexOf('=');
      if (idx > 0) envVars[line.substring(0, idx).trim()] = line.substring(idx + 1).trim();
    });
  }

  try {
    log('🧹 Reiniciando banco do zero (removendo volumes antigos)...');
    exec(`docker compose down -v`);
    exec(`docker compose up -d postgres redis`);

    const pgUser = envVars.POSTGRES_USER || 'botconnecta';
    const pgPass = envVars.POSTGRES_PASSWORD;
    const dbOficial = envVars.DB_NAME_OFICIAL || 'botconnecta_oficial';

    for (let i = 0; i < 30; i++) {
      try {
        exec(`docker compose exec -T postgres pg_isready -U ${pgUser}`);
        break;
      } catch {
        execSync('sleep 2');
      }
    }

    if (pgPass) {
      try {
        exec(`docker compose exec -T postgres psql -U ${pgUser} -d template1 -c "ALTER USER \\"${pgUser}\\" WITH PASSWORD '${pgPass}';"`);
      } catch (pwErr) {
        log(`Aviso ao sincronizar senha do postgres: ${pwErr.message}`);
      }
    }
    try {
      exec(`docker compose exec -T postgres psql -U ${pgUser} -d template1 -tc "SELECT 1 FROM pg_database WHERE datname = '${dbOficial}'" | grep -q 1 || docker compose exec -T postgres psql -U ${pgUser} -d template1 -c "CREATE DATABASE \\"${dbOficial}\\" OWNER \\"${pgUser}\\";"`);
    } catch (dbErr) {
      log(`Aviso ao criar banco oficial: ${dbErr.message}`);
    }

    log('🔄 Executando migrations do backend...');
    exec(`docker compose run --rm backend npm run db:migrate`);

    log('🌱 Executando seeds iniciais...');
    try {
      exec(`docker compose run --rm backend npm run db:seed`);
    } catch (seedErr) {
      log(`Aviso seed: ${seedErr.message}`);
    }

    const adminEmail = envVars.API_OFICIAL_ADMIN_EMAIL || envVars.ADMIN_EMAIL || 'admin@williamalmeida.com.br';
    const adminPass = envVars.API_OFICIAL_ADMIN_PASSWORD || envVars.ADMIN_PASSWORD;
    if (adminEmail && adminPass) {
      log(`👤 Configurando usuário administrador (${adminEmail})...`);
      try {
        exec(`docker compose run --rm backend node -e "const bcrypt = require('bcryptjs'); const { Sequelize } = require('sequelize'); const s = new Sequelize(process.env.DB_NAME, process.env.DB_USER, process.env.DB_PASS, { host: process.env.DB_HOST, dialect: 'postgres', logging: false }); s.query(\\\"UPDATE \\\\\\\"Users\\\\\\\" SET email='${adminEmail}', \\\\\\\"passwordHash\\\\\\\"='\\\" + bcrypt.hashSync('${adminPass}', 8) + \\\"' WHERE id=1;\\\").then(() => { console.log('Admin sincronizado'); process.exit(0); }).catch(e => { console.error(e); process.exit(1); });"`);
      } catch (adminErr) {
        log(`Aviso ao sincronizar admin: ${adminErr.message}`);
      }
    }

    log('🔄 Executando migrations da API Oficial...');
    exec(`docker compose run --rm api_oficial npx prisma migrate deploy`);

    log('🔒 Gerando certificados bootstrap para Nginx...');
    const domains = [envVars.DOMAIN_FRONTEND, envVars.DOMAIN_BACKEND, envVars.DOMAIN_API_OFICIAL].filter(Boolean);
    for (const dom of domains) {
      try {
        exec(`docker compose run --rm --entrypoint sh certbot -c "mkdir -p /etc/letsencrypt/live/${dom} && if [ ! -f /etc/letsencrypt/live/${dom}/fullchain.pem ]; then openssl req -x509 -nodes -newkey rsa:2048 -days 1 -keyout /etc/letsencrypt/live/${dom}/privkey.pem -out /etc/letsencrypt/live/${dom}/fullchain.pem -subj '/CN=${dom}'; fi"`);
      } catch (sslErr) {
        log(`Aviso bootstrap SSL ${dom}: ${sslErr.message}`);
      }
    }

    log('🚀 Subindo todos os containers...');
    exec(`docker compose up -d`);
    execSync('sleep 5');

    log('🔒 Emitindo certificados SSL oficiais Let\'s Encrypt...');
    const certEmail = envVars.API_OFICIAL_ADMIN_EMAIL || envVars.MAIL_FROM || ('admin@' + (envVars.DOMAIN_FRONTEND || 'botconnecta.com.br'));
    try {
      exec(`docker compose exec -T certbot sh -c "rm -rf /etc/letsencrypt/live/* /etc/letsencrypt/archive/* /etc/letsencrypt/renewal/*" 2>/dev/null || true`);
    } catch (cleanSslErr) {
      log(`Aviso ao limpar bootstrap SSL antes da emissão: ${cleanSslErr.message}`);
    }

    for (const dom of domains) {
      try {
        let issued = false;
        try {
          exec(`docker compose exec -T certbot certbot certonly --webroot -w /var/www/certbot --email ${certEmail} -d ${dom} --agree-tos --no-eff-email --non-interactive`);
          issued = true;
        } catch (e1) {
          exec(`docker compose run --rm --no-deps certbot certonly --webroot -w /var/www/certbot --email ${certEmail} -d ${dom} --agree-tos --no-eff-email --non-interactive`);
          issued = true;
        }
        if (issued) log(`✅ Certificado SSL emitido com sucesso para ${dom}`);
      } catch (err) {
        log(`❌ Erro ao emitir SSL para ${dom}: ${err.message}`);
      }
    }

    try {
      exec(`docker compose exec -T nginx nginx -s reload`);
    } catch {
      try { exec(`docker compose restart nginx`); } catch (e) {}
    }

    log('✅ Instalação limpa e SSL concluídos com sucesso!');
  } catch (err) {
    log(`❌ Erro no reset do banco: ${err.message}`);
  }
}

// ── Fix Nginx (aplica config com resolver DNS dinâmico) ─────────────────────
async function handleFixNginx(req, res) {
  const steps = [];
  const step = (msg) => { log(msg); steps.push(msg); };

  try {
    step('📄 Baixando nginx.conf atualizado do repositório...');
    fs.mkdirSync(path.join(INSTALL_DIR, 'docker/nginx/templates'), { recursive: true });
    // Usa a versão instalada atual, ou 1.2.0 como fallback
    const installedVersion = getCurrentVersion() || '1.2.0';
    const nginxBase = `${RELEASES_URL}/releases/${installedVersion}/docker/nginx`;
    exec(`curl -fsSL "${nginxBase}/nginx.conf" -o docker/nginx/nginx.conf`);
    exec(`curl -fsSL "${nginxBase}/templates/default.conf.template" -o docker/nginx/templates/default.conf.template`);
    step('✅ Templates baixados com sucesso');

    step('🔄 Forçando recriação do container nginx (para aplicar novo template com resolver DNS)...');
    exec(`docker compose up -d --force-recreate --no-deps nginx`);
    execSync('sleep 8');

    step('✅ Nginx reiniciado com resolver DNS dinâmico — 502 resolvido!');
    return jsonResponse(res, 200, { ok: true, steps });
  } catch (err) {
    step(`❌ Erro: ${err.message}`);
    // Fallback: tenta só restart simples
    try {
      exec(`docker compose restart nginx`);
      step('⚠️ Fallback: nginx reiniciado via restart');
    } catch (_) {}
    return jsonResponse(res, 500, { ok: false, error: err.message, steps });
  }
}

// ── Self-Update (atualiza agent.js a partir do GitHub) ────────────────────────
async function handleSelfUpdate(req, res) {
  const steps = [];
  const step = (msg) => { log(msg); steps.push(msg); };

  try {
    step('⬇️  Baixando nova versão do agent.js...');
    const agentPath = process.argv[1] || '/opt/botconnecta-agent/agent.js';
    const agentUrl = `${RELEASES_URL}/agent/agent.js`;
    const tmpPath = agentPath + '.new';

    execSync(`curl -fsSL "${agentUrl}" -o "${tmpPath}"`, { stdio: 'pipe' });
    const newContent = fs.readFileSync(tmpPath, 'utf8');
    if (!newContent || newContent.length < 1000) {
      fs.unlinkSync(tmpPath);
      throw new Error('Arquivo agent.js baixado parece inválido (muito pequeno).');
    }
    fs.copyFileSync(tmpPath, agentPath);
    fs.unlinkSync(tmpPath);
    step('✅ agent.js atualizado em disco');

    step('🔄 Reiniciando agent (processo se encerrará e deve ser relançado pelo systemd)...');
    jsonResponse(res, 200, { ok: true, steps, message: 'Agent atualizado. Reiniciando...' });

    // Aguarda o response ser enviado, então sai (systemd relança automaticamente)
    setTimeout(() => {
      log('🔁 Auto-restart após self-update...');
      process.exit(0);
    }, 500);
  } catch (err) {
    step(`❌ Erro no self-update: ${err.message}`);
    return jsonResponse(res, 500, { ok: false, error: err.message, steps });
  }
}

// ── Roteador HTTP ─────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path_ = url.pathname;
  const method = req.method;

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');

  if (method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // Ping sem auth
  if (path_ === '/ping') {
    return jsonResponse(res, 200, { ok: true, agent: 'botconnecta-agent', version: '1.0.0' });
  }

  // Autenticação
  if (!authenticate(req)) {
    return jsonResponse(res, 401, { ok: false, error: 'Unauthorized' });
  }

  // Rotas
  try {
    if (path_ === '/api/health' && method === 'GET') return await handleHealth(req, res);
    if (path_ === '/api/install' && method === 'POST') return await handleInstall(req, res);
    if (path_ === '/api/update' && method === 'POST') return await handleUpdate(req, res);
    if (path_ === '/api/restart' && method === 'POST') return await handleRestart(req, res);
    if (path_ === '/api/stop' && method === 'POST') return await handleStop(req, res);
    if (path_ === '/api/start' && method === 'POST') return await handleStart(req, res);
    if (path_ === '/api/backup' && method === 'POST') return await handleBackup(req, res);
    if (path_ === '/api/backups' && method === 'GET') return await handleListBackups(req, res);
    if (path_ === '/api/ssl' && method === 'POST') return await handleSsl(req, res);
    if (path_ === '/api/clean-db' && method === 'POST') return await handleCleanDb(req, res);
    if (path_ === '/api/fix-nginx' && method === 'POST') return await handleFixNginx(req, res);
    if (path_ === '/api/self-update' && method === 'POST') return await handleSelfUpdate(req, res);

    const logsMatch = path_.match(/^\/api\/logs\/?(.*)$/);
    if (logsMatch && method === 'GET') return await handleLogs(req, res, logsMatch[1]);

    return jsonResponse(res, 404, { ok: false, error: 'Not found' });
  } catch (err) {
    log(`ERROR: ${err.message}`);
    return jsonResponse(res, 500, { ok: false, error: err.message });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  log(`🚀 BotConnecta Agent rodando na porta ${PORT}`);
  log(`📂 Diretório de instalação: ${INSTALL_DIR}`);
  log(`💾 Diretório de backups: ${BACKUP_DIR}`);
});

process.on('uncaughtException', (err) => {
  log(`UNCAUGHT: ${err.message}`);
});

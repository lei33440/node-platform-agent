const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { reconcileCounter } = require('./traffic');

const PORT = Number(process.env.AGENT_PORT || 32081);
const HOST = process.env.AGENT_HOST || '127.0.0.1';
const TOKEN = process.env.AGENT_TOKEN || '';
const STATE_PATH = process.env.AGENT_STATE_PATH || '/var/lib/node-platform-agent/nodes.json';
const CONFIG_DIR = process.env.AGENT_CONFIG_DIR || '/var/lib/node-platform-agent/configs';
const MODE = process.env.AGENT_MODE || 'config-only';
const CORE_PATH = process.env.CORE_PATH || 'xray';
const CORE_CONFIG_PATH = process.env.CORE_CONFIG_PATH || path.join(CONFIG_DIR, 'xray.json');
const CORE_API_PORT = Number(process.env.CORE_API_PORT || 10085);
const TLS_CERT = process.env.AGENT_TLS_CERT || '';
const TLS_KEY = process.env.AGENT_TLS_KEY || '';

function load() {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true, mode: 0o700 });
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(STATE_PATH)) return {};
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { return {}; }
}

let state = load();
let coreProcess = null;
let coreOperation = Promise.resolve();
let statsOperation = Promise.resolve();

function save() {
  const tmp = `${STATE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, STATE_PATH);
}

function body(req) {
  return new Promise((resolve, reject) => {
    let text = '';
    req.on('data', chunk => {
      text += chunk;
      if (Buffer.byteLength(text) > 65536) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try { resolve(text ? JSON.parse(text) : {}); } catch { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function json(res, status, value) {
  const text = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(text);
}

function allowed(value) { return /^[a-zA-Z0-9_-]{4,100}$/.test(String(value || '')); }
function nodeTag(nodeId) { return `node-${nodeId}`; }

function configFor(input, status = 'active') {
  return {
    log: { disabled: true },
    inbounds: [{ type: 'vless', tag: input.nodeId, listen: '0.0.0.0', listen_port: input.port, users: [{ uuid: input.uuid, name: input.label }], network: 'tcp' }],
    outbounds: [{ type: 'direct', tag: 'direct' }],
    metadata: { platformNodeId: input.nodeId, expiresAt: input.expiresAt, status, mode: MODE }
  };
}

function writeConfig(input, status) {
  if (!allowed(input.nodeId)) throw new Error('invalid node id');
  const file = path.join(CONFIG_DIR, `${input.nodeId}.json`);
  const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(configFor(input, status), null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return file;
}

function validNodeConfig(input) {
  return /^[0-9a-f-]{36}$/i.test(String(input.uuid || ''))
    && Number.isInteger(Number(input.port))
    && Number(input.port) >= 1024
    && Number(input.port) <= 65535
    && String(input.label || '').length <= 80;
}

function activeNodes() {
  return Object.values(state).filter(node => node.status === 'active' && validNodeConfig(node));
}

function xrayConfig() {
  const inbounds = [{
    tag: 'api',
    listen: '127.0.0.1',
    port: CORE_API_PORT,
    protocol: 'dokodemo-door',
    settings: { address: '127.0.0.1' }
  }];
  for (const node of activeNodes()) {
    inbounds.push({
      tag: nodeTag(node.nodeId),
      listen: '0.0.0.0',
      port: Number(node.port),
      protocol: 'vless',
      settings: { clients: [{ id: node.uuid, email: node.nodeId }], decryption: 'none' },
      streamSettings: { network: 'tcp', security: 'none' }
    });
  }
  return {
    log: { loglevel: 'warning' },
    api: { tag: 'api', services: ['StatsService'] },
    stats: {},
    policy: {
      levels: { '0': { statsUserUplink: true, statsUserDownlink: true } },
      system: { statsInboundUplink: true, statsInboundDownlink: true }
    },
    inbounds,
    outbounds: [{ protocol: 'freedom', tag: 'direct' }, { protocol: 'freedom', tag: 'api' }],
    routing: { rules: [{ type: 'field', inboundTag: ['api'], outboundTag: 'api' }] }
  };
}

function writeXrayConfig() {
  const directory = path.dirname(CORE_CONFIG_PATH);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const tmp = `${CORE_CONFIG_PATH}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(xrayConfig(), null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CORE_CONFIG_PATH);
}

function stopCore() {
  if (!coreProcess) return Promise.resolve();
  const child = coreProcess;
  coreProcess = null;
  return new Promise(resolve => {
    let finished = false;
    const done = () => { if (!finished) { finished = true; resolve(); } };
    child.once('exit', done);
    child.kill('SIGTERM');
    setTimeout(() => { if (!finished) child.kill('SIGKILL'); }, 3000).unref();
    setTimeout(done, 5000).unref();
  });
}

function startCore() {
  if (MODE !== 'xray') return Promise.resolve();
  const check = spawnSync(CORE_PATH, ['run', '-test', '-config', CORE_CONFIG_PATH], { encoding: 'utf8', timeout: 10000 });
  if (check.error) return Promise.reject(check.error);
  if (check.status !== 0) return Promise.reject(new Error(`xray config check failed: ${(check.stderr || check.stdout || '').trim()}`));
  return new Promise((resolve, reject) => {
    const child = spawn(CORE_PATH, ['run', '-config', CORE_CONFIG_PATH], { stdio: ['ignore', 'ignore', 'pipe'] });
    let settled = false;
    let errorText = '';
    child.stderr.on('data', chunk => { errorText = `${errorText}${chunk}`.slice(-1000); });
    child.once('error', error => {
      if (!settled) { settled = true; reject(error); }
    });
    child.once('exit', (code, signal) => {
      if (coreProcess === child) coreProcess = null;
      if (!settled) {
        settled = true;
        reject(new Error(`xray exited (${code ?? signal}): ${errorText.trim()}`));
      }
    });
    coreProcess = child;
    const deadline = Date.now() + 5000;
    const confirmRunning = () => {
      if (settled) return;
      if (!coreProcess) return;
      if (Date.now() >= deadline) { settled = true; resolve(); return; }
      setTimeout(confirmRunning, 100).unref();
    };
    setTimeout(confirmRunning, 100).unref();
  });
}

function syncCore() {
  if (MODE !== 'xray') return Promise.resolve();
  coreOperation = coreOperation.catch(() => {}).then(async () => {
    await captureStats();
    writeXrayConfig();
    await stopCore();
    await startCore();
  });
  return coreOperation;
}

function coreRunning() { return MODE !== 'xray' || Boolean(coreProcess); }

function coreStatus() {
  return MODE === 'xray' ? (coreProcess ? 'running' : 'stopped') : 'not-configured';
}

function queryRawStats(nodeId) {
  if (MODE !== 'xray') return Promise.resolve({ uploadBytes: 0, downloadBytes: 0 });
  return new Promise((resolve, reject) => {
    const pattern = `user>>>${nodeId}>>>traffic>>>`;
    const child = spawn(CORE_PATH, ['api', 'statsquery', '--server', `127.0.0.1:${CORE_API_PORT}`, '--pattern', pattern], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => {
      if (code !== 0) return reject(new Error(`stats query failed: ${stderr.trim()}`));
      try {
        const result = JSON.parse(stdout);
        let uploadBytes = 0;
        let downloadBytes = 0;
        for (const item of result.stat || []) {
          if (String(item.name).endsWith('>>>uplink')) uploadBytes = Number(item.value || 0);
          if (String(item.name).endsWith('>>>downlink')) downloadBytes = Number(item.value || 0);
        }
        resolve({ uploadBytes: Number.isFinite(uploadBytes) ? uploadBytes : 0, downloadBytes: Number.isFinite(downloadBytes) ? downloadBytes : 0 });
      } catch (error) { reject(new Error(`invalid stats response: ${error.message}`)); }
    });
  });
}

async function captureStats() {
  if (MODE !== 'xray' || !coreProcess) return;
  return withStatsLock(async () => {
    for (const node of Object.values(state)) {
      if (!validNodeConfig(node)) continue;
      try { applyRawStats(node, await queryRawStats(node.nodeId)); } catch {}
    }
    save();
  });
}

async function captureNodeStats(node) {
  if (MODE !== 'xray' || !coreProcess || !validNodeConfig(node)) return;
  return withStatsLock(async () => {
    try { applyRawStats(node, await queryRawStats(node.nodeId)); save(); } catch {}
  });
}

function withStatsLock(task) {
  const result = statsOperation.then(task, task);
  statsOperation = result.catch(() => {});
  return result;
}

function applyRawStats(node, raw) {
  const upload = reconcileCounter(node.trafficBaseUploadBytes, node.lastRawUploadBytes, raw.uploadBytes);
  const download = reconcileCounter(node.trafficBaseDownloadBytes, node.lastRawDownloadBytes, raw.downloadBytes);
  node.trafficBaseUploadBytes = upload.total;
  node.trafficBaseDownloadBytes = download.total;
  node.lastRawUploadBytes = upload.raw;
  node.lastRawDownloadBytes = download.raw;
  node.uploadBytes = upload.total;
  node.downloadBytes = download.total;
  return { uploadBytes: upload.total, downloadBytes: download.total };
}

async function queryStats(nodeId) {
  return withStatsLock(async () => {
    const node = state[nodeId];
    const stats = applyRawStats(node, await queryRawStats(nodeId));
    save();
    return stats;
  });
}

async function main(req, res, url) {
  if (req.headers['x-agent-token'] !== TOKEN || !TOKEN) return json(res, 401, { error: 'unauthorized' });
  if (url.pathname === '/health' && req.method === 'GET') {
    const running = coreRunning();
    return json(res, running ? 200 : 503, { ok: running, service: 'node-agent', mode: MODE, nodeCount: Object.keys(state).length, coreRunning: running, coreStatus: coreStatus() });
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
  const input = await body(req);
  const nodeId = String(input.nodeId || '');
  if (!allowed(nodeId)) return json(res, 400, { error: 'invalid node id' });

  if (url.pathname === '/v1/provision') {
    if (!validNodeConfig(input)) return json(res, 400, { error: 'invalid node config' });
    const configPath = writeConfig(input, 'active');
    const previous = state[nodeId];
    state[nodeId] = { ...input, status: 'active', configPath, uploadBytes: previous?.uploadBytes || 0, downloadBytes: previous?.downloadBytes || 0, trafficBaseUploadBytes: previous?.trafficBaseUploadBytes || 0, trafficBaseDownloadBytes: previous?.trafficBaseDownloadBytes || 0, lastRawUploadBytes: 0, lastRawDownloadBytes: 0, updatedAt: new Date().toISOString() };
    save();
    try {
      await syncCore();
    } catch (error) {
      if (previous) state[nodeId] = previous; else delete state[nodeId];
      save();
      throw error;
    }
    return json(res, 200, { ok: true, nodeId, configPath, runtime: MODE });
  }

  if (!state[nodeId]) return json(res, 404, { error: 'node not found' });
  if (['/v1/pause', '/v1/resume', '/v1/reset', '/v1/expire', '/v1/delete'].includes(url.pathname)) {
    const current = state[nodeId];
    const previous = { ...current };
    if (url.pathname === '/v1/delete') {
      await captureNodeStats(current);
      delete state[nodeId];
      try { fs.rmSync(current.configPath, { force: true }); } catch {}
      save();
      try {
        await syncCore();
      } catch (error) {
        state[nodeId] = previous;
        save();
        throw error;
      }
      return json(res, 200, { ok: true, status: 'deleted' });
    }
    const status = url.pathname === '/v1/pause' ? 'paused' : url.pathname === '/v1/expire' ? 'expired' : 'active';
    const next = { ...current, uuid: String(input.uuid || current.uuid), status, updatedAt: new Date().toISOString() };
    next.configPath = writeConfig(next, status);
    state[nodeId] = next;
    save();
    try {
      await syncCore();
    } catch (error) {
      state[nodeId] = previous;
      save();
      throw error;
    }
    return json(res, 200, { ok: true, status: next.status, configPath: next.configPath, runtime: MODE });
  }

  if (url.pathname === '/v1/stats') {
    if (!state[nodeId]) return json(res, 404, { error: 'node not found' });
    try {
      const stats = await queryStats(nodeId);
      state[nodeId].uploadBytes = stats.uploadBytes;
      state[nodeId].downloadBytes = stats.downloadBytes;
      save();
      return json(res, 200, { ok: true, nodeId, ...stats });
    } catch (error) {
      return json(res, 503, { error: error.message });
    }
  }
  return json(res, 404, { error: 'not found' });
}

const requestHandler = (req, res) => {
  try {
    main(req, res, new URL(req.url, `http://${req.headers.host || 'localhost'}`)).catch(error => json(res, 400, { error: error.message }));
  } catch (error) { json(res, 400, { error: error.message }); }
};
const server = TLS_CERT && TLS_KEY
  ? https.createServer({ cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) }, requestHandler)
  : http.createServer(requestHandler);

server.listen(PORT, HOST, () => {
  if (MODE === 'xray') syncCore().catch(error => console.error(`xray startup failed: ${error.message}`));
  console.log(`node-agent listening on ${HOST}:${PORT} (${MODE}, ${TLS_CERT && TLS_KEY ? 'https' : 'http'})`);
});

async function shutdown() {
  server.close();
  await coreOperation.catch(() => {});
  await stopCore();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

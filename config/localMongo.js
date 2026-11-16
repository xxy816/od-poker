const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');

/**
 * 本地 MongoDB 自动管理
 *
 * 目的：让 `npm start` 在一台没有安装 MongoDB 的机器上也能直接跑起来。
 * 优先复用已经在 27017 监听的外部数据库；没有时，自动启动项目自带的
 * 便携版 mongod（tools/mongodb/bin/mongod.exe），数据落在 data/db，可持久保存。
 *
 * 便携版由 `npm run setup-mongo` 下载（见 scripts/setup-mongo.ps1）。
 */

const ROOT = path.join(__dirname, '..');
const MONGO_PORT = parseInt(process.env.MONGO_PORT || '27017', 10);
const MONGO_HOST = process.env.MONGO_HOST || '127.0.0.1';

const TOOLS_DIR = path.join(ROOT, 'tools', 'mongodb');
const DB_PATH = path.join(ROOT, 'data', 'db');
const LOG_PATH = path.join(ROOT, 'data', 'mongod.log');

/**
 * 检测端口是否已被监听
 * @param {number} port
 * @param {number} timeout - 毫秒
 * @returns {Promise<boolean>}
 */
function isPortOpen(port, timeout = 800) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };

    socket.setTimeout(timeout);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, MONGO_HOST);
  });
}

/**
 * 等待端口可用
 * @param {number} port
 * @param {number} maxWaitMs
 * @returns {Promise<boolean>}
 */
async function waitForPort(port, maxWaitMs = 30000) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    if (await isPortOpen(port)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/**
 * 查找 mongod 可执行文件：优先项目自带便携版，其次 PATH
 * @returns {string|null}
 */
function findMongod() {
  const exeName = process.platform === 'win32' ? 'mongod.exe' : 'mongod';
  const candidates = [
    path.join(TOOLS_DIR, 'bin', exeName),
    path.join(TOOLS_DIR, exeName)
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  const pathDirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of pathDirs) {
    if (!dir) continue;
    const candidate = path.join(dir, exeName);
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch (error) {
      // 忽略无权限的 PATH 目录
    }
  }

  return null;
}

/**
 * 后台启动 mongod（进程与当前 Node 进程解耦，退出服务器后数据库仍在）
 * @param {string} exe - mongod 路径
 * @returns {boolean} 是否成功启动
 */
function startMongod(exe) {
  try {
    fs.mkdirSync(DB_PATH, { recursive: true });
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });

    const args = [
      '--dbpath', DB_PATH,
      '--port', String(MONGO_PORT),
      '--bind_ip', MONGO_HOST,
      '--logpath', LOG_PATH,
      '--logappend'
    ];

    const child = spawn(exe, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });

    child.unref();
    return true;
  } catch (error) {
    console.error('启动 mongod 失败:', error.message);
    return false;
  }
}

/**
 * 确保 MongoDB 可用
 * @returns {Promise<{status: 'running'|'started'|'missing'|'failed'|'skipped', exe?: string}>}
 */
async function ensureMongo() {
  // 配置了远程数据库时不需要本地实例
  const uri = process.env.MONGODB_URI;
  if (uri && !/localhost|127\.0\.0\.1/.test(uri)) {
    return { status: 'skipped' };
  }

  if (await isPortOpen(MONGO_PORT)) {
    return { status: 'running' };
  }

  const exe = findMongod();
  if (!exe) {
    return { status: 'missing' };
  }

  console.log(`未检测到运行中的 MongoDB，正在启动便携版: ${exe}`);
  if (!startMongod(exe)) {
    return { status: 'failed', exe };
  }

  const ready = await waitForPort(MONGO_PORT, 30000);
  return { status: ready ? 'started' : 'failed', exe };
}

const MISSING_DB_HINT = [
  '',
  '❌ 无法连接 MongoDB，游戏需要数据库来保存用户名、筹码和交易记录。',
  '   请任选其一：',
  '   1) 运行 `npm run setup-mongo` 下载项目自带便携版（约 600MB，只需一次），之后 `npm start` 会自动启动它；',
  '   2) 安装官方 MongoDB Community Server 并启动服务（https://www.mongodb.com/try/download/community）；',
  '   3) 如果你有远程数据库，在 .env 里设置 MONGODB_URI。',
  ''
].join('\n');

module.exports = {
  ensureMongo,
  findMongod,
  isPortOpen,
  waitForPort,
  MONGO_PORT,
  MONGO_HOST,
  DB_PATH,
  LOG_PATH,
  MISSING_DB_HINT
};

const { spawnSync } = require('child_process');
const path = require('path');
const {
  ensureMongo,
  isPortOpen,
  findMongod,
  MONGO_PORT,
  MONGO_HOST,
  DB_PATH,
  LOG_PATH
} = require('../config/localMongo');

/**
 * 本地 MongoDB 管理脚本
 *   node scripts/mongo.js start    启动（已在运行则跳过）
 *   node scripts/mongo.js status   查看状态
 *   node scripts/mongo.js stop     停止（仅停止数据目录为本项目的 mongod）
 */

async function showStatus() {
  const running = await isPortOpen(MONGO_PORT);
  const exe = findMongod();

  console.log(`MongoDB 端口: ${MONGO_HOST}:${MONGO_PORT}`);
  console.log(`运行状态: ${running ? '✅ 正在运行' : '❌ 未运行'}`);
  console.log(`mongod: ${exe || '未找到（可运行 npm run setup-mongo 下载便携版）'}`);
  console.log(`数据目录: ${DB_PATH}`);
  console.log(`日志文件: ${LOG_PATH}`);

  return running;
}

async function start() {
  const state = await ensureMongo();
  switch (state.status) {
    case 'running':
      console.log('MongoDB 已在运行');
      break;
    case 'started':
      console.log('✅ 本地 MongoDB 已启动');
      console.log(`   数据目录: ${DB_PATH}`);
      console.log(`   日志文件: ${LOG_PATH}`);
      break;
    case 'skipped':
      console.log('已配置远程 MONGODB_URI，跳过本地启动');
      break;
    case 'missing':
      console.error('未找到 mongod，请先运行: npm run setup-mongo');
      process.exitCode = 1;
      break;
    default:
      console.error('MongoDB 启动失败，请查看 ' + LOG_PATH);
      process.exitCode = 1;
  }
}

function stop() {
  if (process.platform !== 'win32') {
    console.log('非 Windows 环境，请使用系统方式停止 mongod');
    return;
  }

  // PowerShell 的 -like 不做反斜杠转义，直接使用原始路径
  const dbPath = DB_PATH.replace(/'/g, "''");
  const script = [
    "$procs = Get-CimInstance Win32_Process -Filter \"Name='mongod.exe'\" | " +
      `Where-Object { $_.CommandLine -like '*${dbPath}*' }`,
    'if (-not $procs) { Write-Host "没有找到本项目的 mongod 进程" }',
    '$procs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; ' +
      'Write-Host "已停止 mongod 进程 $($_.ProcessId)" }'
  ].join('; ');

  const result = spawnSync('powershell', ['-NoProfile', '-Command', script], {
    encoding: 'utf8'
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) process.exitCode = 1;
}

async function main() {
  const command = process.argv[2] || 'status';

  switch (command) {
    case 'start':
      await start();
      break;
    case 'stop':
      stop();
      break;
    case 'status':
    default:
      await showStatus();
      break;
  }
}

main().catch((error) => {
  console.error('执行失败:', error.message);
  process.exit(1);
});

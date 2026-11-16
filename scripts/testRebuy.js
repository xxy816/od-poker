/**
 * 补码功能集成测试
 *
 * 覆盖：
 *  1. 两名玩家坐下自动开局，反复全下直到一方输光（平局会自动开新局）
 *  2. 输光玩家收到 rebuyRequired，且没有被踢出房间
 *  3. 补码金额非法（低于 1000）被拒绝
 *  4. 补码 1000 成功，房间筹码、REBUY 流水符合预期，钱包被扣除且允许为负
 *  5. 补码后房间自动开始新一局
 *
 * 用法：npm run test:rebuy
 * 说明：脚本会自行启动 server.js（端口 3199、独立测试库 poker_rebuy_test）。
 */
const { spawn } = require('child_process');
const path = require('path');
const { io } = require('socket.io-client');
const mongoose = require('mongoose');

const PORT = 3199;
const BROADCAST_PORT = 4199;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_NAME = 'poker_rebuy_test';
const DB_URI = `mongodb://127.0.0.1:27017/${DB_NAME}`;
const MAX_HANDS = 30;
const DEBUG = Boolean(process.env.DEBUG_REBUY);

const sockets = [];
let serverProc = null;
let passed = 0;
let failed = 0;

function check(name, cond, extra) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''}`);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function waitEvent(sock, event, predicate, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      sock.off(event, handler);
      reject(new Error(`等待事件超时: ${event}`));
    }, timeoutMs);
    function handler(data) {
      if (predicate && !predicate(data)) return;
      clearTimeout(timer);
      sock.off(event, handler);
      resolve(data);
    }
    sock.on(event, handler);
  });
}

function waitAny(socks, event, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const cleanups = [];
    const timer = setTimeout(() => {
      cleanups.forEach(fn => fn());
      reject(new Error(`等待事件超时: ${event}`));
    }, timeoutMs);
    socks.forEach(sock => {
      const handler = data => {
        clearTimeout(timer);
        cleanups.forEach(fn => fn());
        resolve({ sock, data });
      };
      sock.on(event, handler);
      cleanups.push(() => sock.off(event, handler));
    });
  });
}

// 事件队列：先注册、后消费，避免事件在等待前就到达而丢失
function makeQueue(sock, event) {
  const buffer = [];
  const waiters = [];
  sock.on(event, data => {
    const waiter = waiters.shift();
    if (waiter) {
      waiter(data);
    } else {
      buffer.push(data);
    }
  });
  return {
    next(timeoutMs = 20000) {
      if (buffer.length > 0) {
        return Promise.resolve(buffer.shift());
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`等待事件超时: ${event}`)), timeoutMs);
        waiters.push(data => {
          clearTimeout(timer);
          resolve(data);
        });
      });
    }
  };
}

// 同时等待多个队列，返回最先到达的事件
function nextAny(queues, timeoutMs = 20000) {
  const wrapped = queues.map(q => q.next(timeoutMs).then(
    data => ({ ok: true, queue: q, data }),
    () => ({ ok: false })
  ));
  return Promise.race(wrapped).then(result => (result.ok ? result : null));
}

async function login(username) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username })
  });
  if (!res.ok) {
    throw new Error(`登录失败: HTTP ${res.status}`);
  }
  return res.json();
}

function connect(token) {
  const sock = io(BASE, {
    auth: { token },
    transports: ['websocket'],
    reconnection: false
  });
  sockets.push(sock);
  return sock;
}

async function waitForServer(child) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`服务端提前退出，退出码 ${child.exitCode}`);
    }
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch (error) {
      // 尚未就绪
    }
    await sleep(500);
  }
  throw new Error('服务端启动超时');
}

async function cleanup() {
  sockets.forEach(sock => {
    try { sock.disconnect(); } catch (error) { /* ignore */ }
  });
  await sleep(800);
  try {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.connection.dropDatabase();
      await mongoose.connection.close();
    }
  } catch (error) {
    console.error('清理测试库失败:', error.message);
  }
  if (serverProc && serverProc.exitCode === null) {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(serverProc.pid), '/T', '/F']);
    } else {
      serverProc.kill('SIGKILL');
    }
  }
}

async function main() {
  console.log('启动测试服务端...');
  serverProc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      BROADCAST_PORT: String(BROADCAST_PORT),
      MONGODB_URI: DB_URI
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  serverProc.stdout.on('data', () => {});
  serverProc.stderr.on('data', chunk => {
    const text = chunk.toString();
    if (DEBUG || /错误|Error|error/.test(text)) process.stderr.write(`[server] ${text}`);
  });

  await waitForServer(serverProc);
  // 提前连库，补码成功后立刻可以校验（避免校验前新一局已经打完）
  await mongoose.connect(DB_URI);

  const suffix = Date.now().toString(36);
  const userA = await login(`rb_a_${suffix}`);
  const userB = await login(`rb_b_${suffix}`);

  const sockA = connect(userA.token);
  const sockB = connect(userB.token);
  await Promise.all([
    waitEvent(sockA, 'connect'),
    waitEvent(sockB, 'connect')
  ]);
  // 关键事件队列必须尽早注册
  const qStarted = makeQueue(sockA, 'gameStarted');
  const qFinished = makeQueue(sockA, 'gameFinished');
  const qRebuyA = makeQueue(sockA, 'rebuyRequired');
  const qRebuyB = makeQueue(sockB, 'rebuyRequired');
  const qUpdateA = makeQueue(sockA, 'roomUpdate');
  const qUpdateB = makeQueue(sockB, 'roomUpdate');

  if (DEBUG) {
    for (const [label, sock] of [['A', sockA], ['B', sockB]]) {
      sock.on('error', d => console.log(`[debug] ${label} error`, d));
      sock.on('gameStateUpdate', d => console.log(`[debug] ${label} state`, String(d.currentPlayer).slice(0, 5), d.pot));
    }
  }

  // 全下脚本：轮到自己且还有筹码就全下（每局一次，天然幂等）
  let driverPaused = false;
  const act = (sock, state) => {
    if (driverPaused) return;
    if (!state || state.gameState === 'showdown' || state.gameState === 'waiting') return;
    if (state.currentPlayer !== sock.id) return;
    const me = (state.players || []).find(p => p.id === sock.id);
    if (!me || me.chips <= 0) return;
    if (DEBUG) console.log('[debug] emit allIn', sock.id.slice(0, 5));
    sock.emit('playerAction', { action: 'allIn' });
  };
  const onStateA = state => act(sockA, state);
  const onStateB = state => act(sockB, state);
  sockA.on('gameStateUpdate', onStateA);
  sockB.on('gameStateUpdate', onStateB);
  sockA.on('gameStarted', state => act(sockA, state));
  sockB.on('gameStarted', state => act(sockB, state));

  console.log('\n[1] 建房间、加入、坐下');
  const createdPromise = waitEvent(sockA, 'roomCreated');
  const createErrPromise = waitEvent(sockA, 'error').catch(() => null);
  sockA.emit('createRoom', {
    roomName: '补码集成测试',
    settings: { initialChips: 1000, minChips: 100, maxChips: 1000, smallBlind: 10, bigBlind: 20, maxPlayers: 8 }
  });
  const created = await createdPromise;
  const roomCode = created.roomCode;
  check('创建房间成功', typeof roomCode === 'string' && roomCode.length > 0, created);

  const joinedPromise = waitEvent(sockB, 'joinedRoom');
  sockB.emit('joinRoom', { roomCode });
  const joined = await joinedPromise;
  check('加入房间成功', joined.room && joined.room.code === roomCode, joined.room && joined.room.code);

  const seatA = waitEvent(sockA, 'seatTaken', data => data.player.id === sockA.id);
  sockA.emit('selectSeat', { seatNumber: 1 });
  await seatA;

  sockB.emit('selectSeat', { seatNumber: 2 });
  const gsA = await qStarted.next(15000);
  check('两人坐下后自动开局', gsA.players.length === 2 && gsA.players.every(p => p.chips > 0), gsA.players.map(p => p.chips));
  const createErr = await createErrPromise;
  check('创建房间未报错', !createErr, createErr);

  console.log('\n[2] 反复全下直到一方输光（平局会自动开新局）');
  let bustSock = null;
  let bustData = null;
  let hands = 0;
  let bustedFromFinished = null;

  while (hands < MAX_HANDS && !bustData) {
    const race = await nextAny([qRebuyA, qRebuyB, qFinished], 25000);
    if (!race) {
      throw new Error('等待补码询问或牌局结束超时');
    }
    if (race.queue === qFinished) {
      hands += 1;
      const busted = race.data.players.find(p => p.chips <= 0);
      if (busted && !bustedFromFinished) {
        bustedFromFinished = busted;
      }
      continue;
    }
    bustSock = race.queue === qRebuyA ? sockA : sockB;
    bustData = race.data;
  }
  check('多局内出现输光玩家', Boolean(bustedFromFinished || bustData), { hands });

  console.log('\n[3] 输光玩家收到补码询问');
  if (!bustData) {
    const req = await nextAny([qRebuyA, qRebuyB], 20000);
    if (!req) {
      throw new Error('未收到 rebuyRequired');
    }
    bustSock = req.queue === qRebuyA ? sockA : sockB;
    bustData = req.data;
  }
  if (bustData && !bustedFromFinished) hands += 1;

  const loserSock = bustSock;
  const winnerSock = loserSock === sockA ? sockB : sockA;
  check('补码金额范围为 1000-10000', bustData.min === 1000 && bustData.max === 10000, bustData);

  // 输光玩家仍在房间内（房间广播的玩家列表里还有他）
  const roomUpdate = await (loserSock === sockA ? qUpdateA : qUpdateB).next(5000).catch(() => null);
  check('输光后仍留在房间内', !roomUpdate || roomUpdate.players.some(p => p.id === loserSock.id), roomUpdate && roomUpdate.players.map(p => p.chips));

  console.log('\n[4] 非法金额被拒绝');
  const badPromise = waitEvent(loserSock, 'rebuyResult');
  loserSock.emit('rebuy', { amount: 500 });
  const badResult = await badPromise;
  check('500 补码被拒绝', badResult.success === false, badResult);

  console.log('\n[5] 补码 1000');
  if (DEBUG) console.log('[debug] loser/winner', loserSock.id.slice(0, 5), winnerSock.id.slice(0, 5));
  const okPromise = waitEvent(loserSock, 'rebuyResult');
  const broadcastPromise = waitEvent(winnerSock, 'rebuySuccess');
  const restartPromise = qStarted.next(15000);
  driverPaused = true; // 校验数据库前先停手，避免新一局立刻打完改变余额
  loserSock.emit('rebuy', { amount: 1000 });
  const okResult = await okPromise;
  check('补码成功', okResult.success === true, okResult);
  check('补码后筹码为 1000', okResult.chips === 1000, okResult.chips);

  const broadcast = await broadcastPromise;
  check('房间内其他玩家收到补码广播', broadcast.amount === 1000 && broadcast.playerId === loserSock.id, broadcast);

  console.log('\n[6] 校验数据库');
  const RoomBalance = require('../models/RoomBalance');
  const ChipTransaction = require('../models/ChipTransaction');
  const User = require('../models/User');

  const userIdOf = payload => (payload && payload.user && (payload.user.id || payload.user._id)) || null;
  const loserUserId = userIdOf(loserSock === sockA ? userA : userB);
  const winnerUserId = userIdOf(loserSock === sockA ? userB : userA);

  if (DEBUG) {
    const all = await RoomBalance.find({}).lean();
    console.log('[debug] roomCode=', roomCode, 'balances=', JSON.stringify(all.map(b => ({ u: String(b.userId), r: b.roomCode, c: b.chips, a: b.isActive }))));
    console.log('[debug] loserUserId=', String(loserUserId));
    const txAll = await ChipTransaction.find({}).lean();
    console.log('[debug] tx=', JSON.stringify(txAll.map(t => ({ t: t.type, u: String(t.userId), r: t.roomCode, a: t.amount }))));
  }
  const loserBalance = await RoomBalance.findOne({ userId: loserUserId, roomCode, isActive: true });
  check('RoomBalance 存在且为 1000', Boolean(loserBalance) && loserBalance.chips === 1000, loserBalance && loserBalance.chips);

  const rebuyTx = await ChipTransaction.findOne({ userId: loserUserId, roomCode, type: 'REBUY' });
  check('写入 1 条 REBUY 流水', Boolean(rebuyTx), rebuyTx && rebuyTx.amount);
  check('REBUY 流水记录钱包变化为负', Boolean(rebuyTx) && rebuyTx.balanceAfter === -1000, rebuyTx && rebuyTx.balanceAfter);

  const loserUser = await User.findById(loserUserId);
  check('补码从钱包扣除，允许余额为负', Boolean(loserUser) && loserUser.totalChips === -1000, loserUser && loserUser.totalChips);

  const winnerBalance = await RoomBalance.findOne({ userId: winnerUserId, roomCode, isActive: true });
  check('赢家房间筹码为 2000', Boolean(winnerBalance) && winnerBalance.chips === 2000, winnerBalance && winnerBalance.chips);

  const winnerUser = await User.findById(winnerUserId);
  check('赢家钱包为 0（筹码都在房间里）', Boolean(winnerUser) && winnerUser.totalChips === 0, winnerUser && winnerUser.totalChips);

  console.log('\n[7] 补码后自动开始新一局');
  const restarted = await restartPromise;
  check('补码后自动开始新一局', restarted.players.length === 2 && restarted.players.every(p => p.chips > 0), restarted.players.map(p => p.chips));

  console.log('\n[8] 钱包为负仍可进房，离场用房间筹码抵扣欠款');
  const negUsername = `neg_${Date.now()}`;
  const negUser = await User.create({ username: negUsername, totalChips: -500 });
  const negLogin = await login(negUsername);
  const negSock = connect(negLogin.token);
  await new Promise((resolve, reject) => {
    if (negSock.connected) return resolve();
    negSock.once('connect', resolve);
    negSock.once('connect_error', reject);
    setTimeout(() => reject(new Error('负余额玩家连接超时')), 8000);
  });

  const negCreated = waitEvent(negSock, 'roomCreated');
  const negPrompt = waitEvent(negSock, 'rebuyRequired');
  negSock.emit('createRoom', {
    roomName: '负余额测试房',
    settings: { minChips: 100, maxChips: 10000, maxPlayers: 8 }
  });
  const negCreatedData = await negCreated;
  check('钱包为负也能创建房间', Boolean(negCreatedData.roomCode), negCreatedData.roomCode);

  const negPromptData = await negPrompt;
  check(
    '空手进房收到补码提示且带钱包余额',
    negPromptData.chips === 0 && negPromptData.walletBalance === -500,
    negPromptData
  );

  const negRebuy = waitEvent(negSock, 'rebuyResult');
  negSock.emit('rebuy', { amount: 1000 });
  const negRebuyData = await negRebuy;
  check('负余额补码成功，钱包继续为负', negRebuyData.success === true && negRebuyData.walletBalance === -1500, negRebuyData);

  const negLeft = waitEvent(negSock, 'leftRoom');
  negSock.emit('leaveRoom');
  await negLeft;
  const negAfter = await User.findById(negUser._id);
  check('离场后房间筹码抵扣欠款，钱包回到 -500', Boolean(negAfter) && negAfter.totalChips === -500, negAfter && negAfter.totalChips);

  const negClosed = await RoomBalance.findOne({ userId: negUser._id, isActive: true });
  check('离场后房间余额已关闭', negClosed === null, Boolean(negClosed));

  console.log(`\n结果: 共 ${hands} 局, ${passed} 通过, ${failed} 失败`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main()
  .catch(error => {
    console.error('测试异常:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup();
  });

/**
 * 牌局规则集成测试
 *
 * 覆盖（对应 P0 修复项）：
 *  1. 单挑盲注位置：按钮位=小盲，大盲在另一侧，翻牌前由小盲（按钮）先行动
 *  2. 过牌校验：有跟注额时 check 被拒绝并回执；跟注后轮转到大盲
 *  3. 最小加注：低于 currentBet + lastRaiseSize 被拒绝，规则额度被接受
 *  4. 行动计时器：TURN_REMINDER_MS=1200 时收到 actionReminder，且不强制行动
 *  5. 弃牌轮转：三人局按座位顺序轮转，不会跳人
 *
 * 用法：npm run test:rules
 * 说明：脚本会自行启动 server.js（端口 3299、独立测试库 poker_rules_test）。
 */
const { spawn } = require('child_process');
const path = require('path');
const { io } = require('socket.io-client');
const mongoose = require('mongoose');

const PORT = 3299;
const BROADCAST_PORT = 4299;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_URI = 'mongodb://127.0.0.1:27017/poker_rules_test';
const TURN_REMINDER_MS = 1200;
const SUFFIX = Date.now().toString().slice(-6);

const sockets = [];
let serverProc = null;
let passed = 0;
let failed = 0;

function check(name, cond, extra) {
  if (cond) {
    passed += 1;
    console.log(`  \u2713 ${name}`);
  } else {
    failed += 1;
    console.error(`  \u2717 ${name}${extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''}`);
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// 事件队列：先注册、后消费，避免事件在等待前就已到达而丢失
function makeQueue(sock, event) {
  const buffer = [];
  const waiters = [];
  sock.on(event, data => {
    for (let i = 0; i < waiters.length; i += 1) {
      if (!waiters[i].predicate || waiters[i].predicate(data)) {
        const waiter = waiters.splice(i, 1)[0];
        clearTimeout(waiter.timer);
        waiter.resolve(data);
        return;
      }
    }
    buffer.push(data);
  });
  return {
    next(predicate, timeoutMs = 10000) {
      for (let i = 0; i < buffer.length; i += 1) {
        if (!predicate || predicate(buffer[i])) {
          return Promise.resolve(buffer.splice(i, 1)[0]);
        }
      }
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, timer: null };
        waiter.timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error(`等待事件超时: ${event}`));
        }, timeoutMs);
        waiters.push(waiter);
      });
    }
  };
}

async function api(pathname, body) {
  const response = await fetch(`${BASE}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return response.json();
}

async function login(username) {
  const data = await api('/api/auth/login', { username });
  if (!data.user || !data.token) throw new Error('登录失败: ' + JSON.stringify(data));
  return { token: data.token, user: data.user };
}

function connect(token) {
  const socket = io(BASE, { auth: { token }, transports: ['websocket'], reconnection: false });
  sockets.push(socket);
  return socket;
}

function waitFor(socket, event, predicate, timeoutMs) {
  return makeQueue(socket, event).next(predicate, timeoutMs);
}

async function waitHealthy(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return;
    } catch (error) {
      // 服务还没起来
    }
    await sleep(300);
  }
  throw new Error('server.js 启动超时');
}

async function main() {
  console.log('[准备] 启动测试服务器');
  serverProc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      BROADCAST_PORT: String(BROADCAST_PORT),
      MONGODB_URI: DB_URI,
      TURN_REMINDER_MS: String(TURN_REMINDER_MS)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  serverProc.stdout.on('data', chunk => {
    if (process.env.DEBUG_RULES) process.stdout.write(`[server] ${chunk}`);
  });
  serverProc.stderr.on('data', chunk => process.stderr.write(`[server-err] ${chunk}`));
  await waitHealthy();

  const userA = await login(`rules_a_${SUFFIX}`);
  const userB = await login(`rules_b_${SUFFIX}`);
  const userC = await login(`rules_c_${SUFFIX}`);

  const sockA = connect(userA.token);
  const sockB = connect(userB.token);
  const sockC = connect(userC.token);
  const qStartedA = makeQueue(sockA, 'gameStarted');
  const qFinishedA = makeQueue(sockA, 'gameFinished');
  const qStateA = makeQueue(sockA, 'gameStateUpdate');
  const qRejectedA = makeQueue(sockA, 'actionRejected');
  const qRejectedC = makeQueue(sockC, 'actionRejected');
  const qStateB = makeQueue(sockB, 'gameStateUpdate');
  const qRejectedB = makeQueue(sockB, 'actionRejected');
  const qReminderA = makeQueue(sockA, 'actionReminder');
  const qRoomCreatedA = makeQueue(sockA, 'roomCreated');

  console.log('[1] 建房并两人落座，单挑自动开局');
  sockA.emit('createRoom', {
    roomName: `规则测试${SUFFIX}`,
    settings: { minChips: 100, maxChips: 10000, smallBlind: 10, bigBlind: 20 }
  });
  const roomCreated = await qRoomCreatedA.next();
  const roomCode = roomCreated.roomCode;

  const qJoinedB = makeQueue(sockB, 'playerJoined');
  sockB.emit('joinRoom', { roomCode, chipsToEnter: 1000 });
  await qJoinedB.next();
  sockA.emit('selectSeat', { seatNumber: 1 });
  sockB.emit('selectSeat', { seatNumber: 2 });

  const hand1 = await qStartedA.next();
  const dealerIndex = hand1.dealerIndex;
  const seated = hand1.seatedPlayers;
  const sbId = seated[hand1.smallBlindIndex].playerId;
  const bbId = seated[hand1.bigBlindIndex].playerId;
  const playerOf = (state, id) => state.players.find(p => p.id === id);

  check('单挑时小盲位就是按钮位', hand1.smallBlindIndex === dealerIndex, {
    dealerIndex,
    smallBlindIndex: hand1.smallBlindIndex
  });
  check('单挑时大盲位在按钮位对侧', hand1.bigBlindIndex === (dealerIndex + 1) % 2);
  check('翻牌前由小盲（按钮）先行动', hand1.currentPlayer === sbId, {
    currentPlayer: hand1.currentPlayer,
    sbId
  });
  check('小盲已下 10', playerOf(hand1, sbId).chips === 990 && playerOf(hand1, sbId).bet === 10);
  check('大盲已下 20', playerOf(hand1, bbId).chips === 980 && playerOf(hand1, bbId).bet === 20);
  check('下注轮带 lastRaiseSize 与提醒截止时间', hand1.lastRaiseSize === 20 && hand1.turnDeadline > Date.now());

  console.log('[2] 过牌校验与跟注');
  sockA.emit('playerAction', { action: 'check' });
  const rejectCheck = await qRejectedA.next();
  check('有跟注额时过牌被拒绝', /跟注/.test(rejectCheck.reason), rejectCheck);

  sockA.emit('playerAction', { action: 'call' });
  const afterCall = await qStateA.next(state => state.currentPlayer === bbId);
  check('跟注后轮到大盲行动', afterCall.currentPlayer === bbId);
  check('跟注后底池为 40', afterCall.pot === 40, afterCall.pot);
  check('跟注后小盲下注额与大盲持平', playerOf(afterCall, sbId).bet === 20);

  console.log('[3] 最小加注校验');
  sockB.emit('playerAction', { action: 'raise', amount: 15 });
  const rejectRaise = await qRejectedB.next();
  check('低于最小加注额被拒绝', /最小加注/.test(rejectRaise.reason), rejectRaise);

  sockB.emit('playerAction', { action: 'raise', amount: 20 });
  const afterRaise = await qStateB.next(state => state.currentPlayer === sbId);
  check('合法加注后 currentBet 变为 40', afterRaise.currentBet === 40, afterRaise.currentBet);
  check('合法加注后 lastRaiseSize 为 20', afterRaise.lastRaiseSize === 20, afterRaise.lastRaiseSize);
  check('加注后轮到小盲行动', afterRaise.currentPlayer === sbId);

  console.log('[4] 第三人中途加入并落座');
  const qJoinedC = makeQueue(sockC, 'playerJoined');
  sockC.emit('joinRoom', { roomCode, chipsToEnter: 1000 });
  await qJoinedC.next();
  sockC.emit('selectSeat', { seatNumber: 3 });
  await sleep(300);

  console.log('[5] 弃牌结束本局，三人局自动开始');
  sockA.emit('playerAction', { action: 'fold' });
  await qFinishedA.next(undefined, 10000);
  const hand2 = await qStartedA.next(undefined, 15000);
  check('第二局有 3 名参与者', hand2.seatedPlayers.length === 3, hand2.seatedPlayers.length);

  const qStateHand2 = makeQueue(sockA, 'gameStateUpdate');
  const seated2 = hand2.seatedPlayers;
  const dealer2 = seated2[hand2.dealerIndex].playerId;
  const sb2 = seated2[hand2.smallBlindIndex].playerId;
  const bb2 = seated2[hand2.bigBlindIndex].playerId;
  check('三人局按钮/小盲/大盲互不相同', new Set([dealer2, sb2, bb2]).size === 3);
  check('三人局翻牌前由按钮位先行动', hand2.currentPlayer === dealer2, {
    currentPlayer: hand2.currentPlayer,
    dealer2
  });

  console.log('[6] 30 秒提醒（此处 1200ms）只提醒、不强制行动');
  const reminder = await qReminderA.next(data => data.playerId === dealer2, 8000);
  check('收到行动提醒', reminder.playerId === dealer2, reminder);
  check('提醒秒数按配置四舍五入', reminder.seconds === Math.round(TURN_REMINDER_MS / 1000), reminder);
  check('提醒文案包含玩家名', reminder.message.includes(reminder.playerName), reminder);

  const dealerSock = dealer2 === sockA.id ? sockA : dealer2 === sockB.id ? sockB : sockC;
  const sbSock = sb2 === sockA.id ? sockA : sb2 === sockB.id ? sockB : sockC;
  const bbSock = bb2 === sockA.id ? sockA : bb2 === sockB.id ? sockB : sockC;

  console.log('[7] 弃牌按座位轮转，不跳人');
  const notDealerSock = [sockA, sockB, sockC].find(socket => socket !== dealerSock);
  notDealerSock.emit('playerAction', { action: 'fold' });
  const rejectQueue = notDealerSock === sockB ? qRejectedB : notDealerSock === sockC ? qRejectedC : qRejectedA;
  const notYourTurn = await rejectQueue.next();
  check('非当前玩家操作被拒绝', /还没轮到你/.test(notYourTurn.reason), notYourTurn);

  dealerSock.emit('playerAction', { action: 'fold' });
  const afterDealerFold = await qStateHand2.next(state => state.currentPlayer === sb2);
  check('按钮位弃牌后轮到小盲，而不是大盲', afterDealerFold.currentPlayer === sb2, {
    currentPlayer: afterDealerFold.currentPlayer,
    sb2,
    bb2
  });
  check('弃牌后底池未被错误清空', afterDealerFold.pot > 0, afterDealerFold.pot);

  console.log(`\n结果: ${passed} 项通过, ${failed} 项失败`);
  if (failed > 0) process.exitCode = 1;
}

async function cleanup() {
  sockets.forEach(socket => {
    try {
      socket.disconnect();
    } catch (error) {
      // 忽略
    }
  });
  await sleep(500);
  try {
    await mongoose.connect(DB_URI, { serverSelectionTimeoutMS: 3000 });
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  } catch (error) {
    console.error('[cleanup] 清理测试库失败:', error.message);
  }
  if (serverProc) {
    serverProc.kill();
    await sleep(500);
    if (process.platform === 'win32' && serverProc.pid) {
      try {
        spawn('taskkill', ['/pid', String(serverProc.pid), '/f', '/t'], { stdio: 'ignore' });
      } catch (error) {
        // 忽略
      }
    }
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

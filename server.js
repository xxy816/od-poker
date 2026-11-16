// 加载环境变量
require('dotenv').config();

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const dgram = require('dgram');
const session = require('express-session');

// 导入数据库和模型
const Database = require('./config/database');
const { authenticateSocket } = require('./middleware/auth');
const ChipService = require('./services/chipService');
const User = require('./models/User');
const RoomBalance = require('./models/RoomBalance');
const ChipTransaction = require('./models/ChipTransaction');

// 导入路由
const authRoutes = require('./routes/auth');
const roomRoutes = require('./routes/room');
const economyRoutes = require('./routes/economy');

// 初始化数据库和服务
const database = require('./config/database');
const chipService = require('./services/chipService');
const schedulerService = require('./services/schedulerService');
const { ensureMongo, MISSING_DB_HINT } = require('./config/localMongo');
const { distributePots } = require('./services/potService');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Express中间件配置
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'texas_holdem_session_secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false } // 在生产环境中应设置为true（需要HTTPS）
}));

// 静态文件服务
app.use(express.static(path.join(__dirname, 'public')));

// API路由
app.use('/api/auth', authRoutes);
app.use('/api/room', roomRoutes);
app.use('/api/economy', economyRoutes);

// 健康检查端点
app.get('/api/health', async (req, res) => {
  try {
    const dbHealth = await database.healthCheck();
    res.json({
      status: 'ok',
      timestamp: new Date(),
      database: dbHealth,
      server: 'running'
    });
  
  } catch (error) {
    res.status(500).json({
      status: 'error',
      timestamp: new Date(),
      error: error.message
    });
  }
});

// 游戏房间管理
const rooms = new Map();
const players = new Map();

// UDP广播服务用于局域网发现
const udpServer = dgram.createSocket('udp4');
const BROADCAST_PORT = process.env.BROADCAST_PORT || 41234;
const SERVER_PORT = process.env.PORT || 3000;

// 补码规则：筹码输光后可以补码继续游戏，单次补码金额范围
const MIN_REBUY_CHIPS = 1000;
const MAX_REBUY_CHIPS = 10000;

// 扑克牌定义
const SUITS = ['hearts', 'diamonds', 'clubs', 'spades'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

// 牌型枚举（从小到大）
const HAND_TYPES = {
  HIGH_CARD: 1,
  PAIR: 2,
  TWO_PAIR: 3,
  THREE_KIND: 4,
  STRAIGHT: 5,
  FLUSH: 6,
  FULL_HOUSE: 7,
  FOUR_KIND: 8,
  STRAIGHT_FLUSH: 9,
  ROYAL_FLUSH: 10
};

// 游戏状态枚举
const GAME_STATES = {
  WAITING: 'waiting',
  PRE_FLOP: 'pre_flop',
  FLOP: 'flop',
  TURN: 'turn',
  RIVER: 'river',
  SHOWDOWN: 'showdown',
  FINISHED: 'finished'
};

// 创建一副牌
function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ suit, rank });
    }
  }
  return shuffleDeck(deck);
}

// 洗牌
function shuffleDeck(deck) {
  const shuffled = [...deck];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

// 生成房间号
function generateRoomCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// 行动提醒：30 秒只提醒，不强制弃牌/过牌（朋友局体验优先）
const TURN_REMINDER_MS = parseInt(process.env.TURN_REMINDER_MS, 10) || 30000;

// 房间级定时器统一登记，房间销毁时一起清理
function scheduleRoomTask(room, fn, delay) {
  if (!room) return null;
  if (!(room.timers instanceof Set)) room.timers = new Set();
  const timer = setTimeout(() => {
    room.timers.delete(timer);
    if (rooms.get(room.code) !== room) return;
    try {
      fn();
    } catch (error) {
      console.error(`房间 ${room.code} 定时任务执行失败:`, error);
    }
  }, delay);
  room.timers.add(timer);
  return timer;
}

function clearRoomTasks(room) {
  if (!room) return;
  if (room.timers instanceof Set) {
    room.timers.forEach(timer => clearTimeout(timer));
    room.timers.clear();
  }
  if (room.turnTimer) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
  }
  room.currentPlayerId = null;
  room.turnDeadline = null;
}

function destroyRoom(room) {
  if (!room) return;
  clearRoomTasks(room);
  rooms.delete(room.code);
}

// 开启本回合的 30 秒提醒（只提醒一次，不改变牌局状态）
function startTurnReminder(room) {
  stopTurnReminder(room);
  if (!room || !room.currentPlayerId) return;
  const player = room.players.get(room.currentPlayerId);
  if (!player) return;
  room.turnDeadline = Date.now() + TURN_REMINDER_MS;
  room.turnTimer = scheduleRoomTask(room, () => {
    if (room.currentPlayerId !== player.id) return;
    if (room.gameState === GAME_STATES.WAITING || room.gameState === GAME_STATES.SHOWDOWN) return;
    const seconds = Math.round(TURN_REMINDER_MS / 1000);
    io.to(room.code).emit('actionReminder', {
      playerId: player.id,
      playerName: player.name,
      seconds,
      message: `${player.name} 已经思考了 ${seconds} 秒，还在等待其行动`
    });
  }, TURN_REMINDER_MS);
}

function stopTurnReminder(room) {
  if (!room) return;
  if (room.turnTimer) {
    clearTimeout(room.turnTimer);
    if (room.timers instanceof Set) room.timers.delete(room.turnTimer);
    room.turnTimer = null;
  }
  room.turnDeadline = null;
}

// 从某个座位号开始，按座位顺序找下一位还能行动的玩家（环形）
function findNextActor(room, seatNumber) {
  const candidates = getActivePlayers(room).filter(p => !p.allIn);
  if (!candidates.length) return null;
  candidates.sort((a, b) => room.playerSeats.get(a.id) - room.playerSeats.get(b.id));
  const from = Number.isInteger(seatNumber) ? seatNumber : -1;
  return candidates.find(p => room.playerSeats.get(p.id) > from) || candidates[0];
}

// 创建房间
function createRoom(roomName, hostId, settings) {
  const roomCode = generateRoomCode();
  const room = {
    code: roomCode,
    name: roomName,
    hostId: hostId,
    players: new Map(),
    seats: new Map(), // 座位号 -> 玩家ID
    playerSeats: new Map(), // 玩家ID -> 座位号
    gameState: GAME_STATES.WAITING,
    deck: [],
    communityCards: [],
    pot: 0,
    currentBet: 0,
    lastRaiseSize: 0,
    currentPlayerId: null,
    turnDeadline: null,
    turnTimer: null,
    timers: new Set(),
    dealerIndex: -1,
    smallBlindIndex: 0,
    bigBlindIndex: 0,
    settings: {
      initialChips: settings.initialChips || parseInt(process.env.DEFAULT_CHIPS) || 1000,
      minChips: settings.minChips || parseInt(process.env.MIN_ROOM_CHIPS) || 100,
      maxChips: settings.maxChips || parseInt(process.env.MAX_ROOM_CHIPS) || 10000,
      smallBlind: settings.smallBlind || 10,
      bigBlind: settings.bigBlind || 20,
      maxPlayers: settings.maxPlayers || 6
    },
    gameHistory: [],
    aiPlayers: [],
    // 本局每个玩家实际投入底池的筹码（含已弃牌/已离桌玩家，用于正确切分边池）
    potContributions: new Map()
  };
  
  rooms.set(roomCode, room);
  return room;
}

// 牌型判断函数
function evaluateHand(cards) {
  if (cards.length < 5) return { type: HAND_TYPES.HIGH_CARD, value: 0 };
  
  // 获取所有可能的5张牌组合
  const combinations = getCombinations(cards, 5);
  let bestHand = { type: HAND_TYPES.HIGH_CARD, value: 0, cards: [] };
  
  for (const combo of combinations) {
    const hand = evaluateFiveCards(combo);
    if (hand.value > bestHand.value) {
      bestHand = hand;
    }
  }
  
  return bestHand;
}

// 评估5张牌的牌型
function evaluateFiveCards(cards) {
  const ranks = cards.map(card => RANKS.indexOf(card.rank));
  const suits = cards.map(card => card.suit);
  
  ranks.sort((a, b) => b - a); // 降序排列
  
  const isFlush = suits.every(suit => suit === suits[0]);
  const isStraight = checkStraight(ranks);
  
  // 统计每个点数的出现次数
  const rankCounts = {};
  ranks.forEach(rank => {
    rankCounts[rank] = (rankCounts[rank] || 0) + 1;
  });
  
  // 按出现次数和点数大小排序，用于精确比较
  const sortedRanks = Object.keys(rankCounts)
    .map(rank => parseInt(rank))
    .sort((a, b) => {
      const countDiff = rankCounts[b] - rankCounts[a];
      if (countDiff !== 0) return countDiff; // 先按出现次数排序
      return b - a; // 再按点数大小排序
    });
  
  const counts = Object.values(rankCounts).sort((a, b) => b - a);
  
  // 判断牌型
  if (isFlush && isStraight) {
    if (ranks[0] === 12 && ranks[4] === 8) { // A-K-Q-J-10
      return { type: HAND_TYPES.ROYAL_FLUSH, value: 10000000, cards };
    }
    // 特殊处理A-2-3-4-5顺子（最小的顺子）
    const straightHigh = (ranks[0] === 12 && ranks[1] === 3) ? 3 : ranks[0];
    return { type: HAND_TYPES.STRAIGHT_FLUSH, value: 9000000 + straightHigh, cards };
  }
  
  if (counts[0] === 4) {
    // 四条：四条的点数 + 单牌点数
    const fourKindRank = sortedRanks[0];
    const kickerRank = sortedRanks[1];
    return { type: HAND_TYPES.FOUR_KIND, value: 8000000 + fourKindRank * 1000 + kickerRank, cards };
  }
  
  if (counts[0] === 3 && counts[1] === 2) {
    // 葫芦：三条的点数 + 对子的点数
    const threeKindRank = sortedRanks[0];
    const pairRank = sortedRanks[1];
    return { type: HAND_TYPES.FULL_HOUSE, value: 7000000 + threeKindRank * 1000 + pairRank, cards };
  }
  
  if (isFlush) {
    // 同花：按所有牌的点数比较
    return { type: HAND_TYPES.FLUSH, value: 6000000 + ranks[0] * 10000 + ranks[1] * 1000 + ranks[2] * 100 + ranks[3] * 10 + ranks[4], cards };
  }
  
  if (isStraight) {
    // 顺子：按最高牌比较，特殊处理A-2-3-4-5
    const straightHigh = (ranks[0] === 12 && ranks[1] === 3) ? 3 : ranks[0];
    return { type: HAND_TYPES.STRAIGHT, value: 5000000 + straightHigh, cards };
  }
  
  if (counts[0] === 3) {
    // 三条：三条的点数 + 两张单牌点数
    const threeKindRank = sortedRanks[0];
    const kicker1 = sortedRanks[1];
    const kicker2 = sortedRanks[2];
    return { type: HAND_TYPES.THREE_KIND, value: 4000000 + threeKindRank * 10000 + kicker1 * 100 + kicker2, cards };
  }
  
  if (counts[0] === 2 && counts[1] === 2) {
    // 两对：大对子点数 + 小对子点数 + 单牌点数
    const bigPairRank = sortedRanks[0];
    const smallPairRank = sortedRanks[1];
    const kickerRank = sortedRanks[2];
    return { type: HAND_TYPES.TWO_PAIR, value: 3000000 + bigPairRank * 10000 + smallPairRank * 100 + kickerRank, cards };
  }
  
  if (counts[0] === 2) {
    // 一对：对子点数 + 三张单牌点数
    const pairRank = sortedRanks[0];
    const kicker1 = sortedRanks[1];
    const kicker2 = sortedRanks[2];
    const kicker3 = sortedRanks[3];
    return { type: HAND_TYPES.PAIR, value: 2000000 + pairRank * 100000 + kicker1 * 1000 + kicker2 * 100 + kicker3, cards };
  }
  
  // 高牌：按所有牌的点数比较
  return { type: HAND_TYPES.HIGH_CARD, value: 1000000 + ranks[0] * 10000 + ranks[1] * 1000 + ranks[2] * 100 + ranks[3] * 10 + ranks[4], cards };
}

// 检查是否为顺子
function checkStraight(ranks) {
  // 特殊情况：A-2-3-4-5
  if (ranks[0] === 12 && ranks[1] === 3 && ranks[2] === 2 && ranks[3] === 1 && ranks[4] === 0) {
    return true;
  }
  
  for (let i = 0; i < ranks.length - 1; i++) {
    if (ranks[i] - ranks[i + 1] !== 1) {
      return false;
    }
  }
  return true;
}

// 获取组合
function getCombinations(arr, k) {
  if (k === 1) return arr.map(x => [x]);
  if (k === arr.length) return [arr];
  
  const combinations = [];
  for (let i = 0; i <= arr.length - k; i++) {
    const head = arr[i];
    const tailCombinations = getCombinations(arr.slice(i + 1), k - 1);
    for (const tail of tailCombinations) {
      combinations.push([head, ...tail]);
    }
  }
  return combinations;
}

// WebSocket连接处理
// Socket.IO认证中间件
io.use(authenticateSocket);

io.on('connection', (socket) => {
  console.log('玩家连接:', socket.id, '用户:', socket.user.username);
  
  // 创建房间
  socket.on('createRoom', async (data) => {
    try {
      const { roomName, settings } = data;
      const user = socket.user;
      
      // 钱包余额为负时也允许空手进房，靠补码继续
      const minChips = settings.minChips || 100;
      if (user.totalChips > 0 && user.totalChips < minChips) {
        socket.emit('error', { 
          message: '筹码余额不足，无法创建房间',
          currentBalance: user.totalChips,
          required: minChips
        });
        return;
      }
      
      const room = createRoom(roomName, socket.id, settings);
      
      // 自动让房主进入房间（转移筹码）；余额 <= 0 时转入 0，等待房主补码
      const chipsToEnter = user.totalChips > 0 ? Math.min(user.totalChips, settings.maxChips || 10000) : 0;
      const chipResult = await chipService.enterRoom(user._id, room.code, chipsToEnter);
      
      const player = {
        id: socket.id,
        userId: user._id,
        name: user.username,
        avatar: user.avatar,
        chips: chipResult.roomChips,
        totalChips: chipResult.totalChips,
        cards: [],
        bet: 0,
        folded: false,
        allIn: false,
        isReady: false,
        needsRebuy: chipResult.roomChips === 0
      };
      
      room.players.set(socket.id, player);
      players.set(socket.id, { roomCode: room.code, player, userId: user._id });
      
      socket.join(room.code);
      socket.emit('roomCreated', { 
        roomCode: room.code, 
        room: getRoomInfo(room),
        chipStatus: chipResult
      });

      // 空手进房：提示房主补码（补码的钱从钱包扣除，余额可为负）
      if (player.chips === 0) {
        socket.emit('rebuyRequired', {
          min: MIN_REBUY_CHIPS,
          max: MAX_REBUY_CHIPS,
          chips: 0,
          walletBalance: chipResult.totalChips,
          message: '钱包余额不足，可通过补码继续（补码会从钱包扣除，可为负）'
        });
      }
      
      console.log(`房间创建成功: ${room.code}, 房主: ${user.username}`);
      
    } catch (error) {
      console.error('创建房间错误:', error);
      socket.emit('error', { message: error.message });
    }
  });
  
  // 加入房间
  socket.on('joinRoom', async (data) => {
    try {
      const { roomCode, chipsToEnter } = data;
      const user = socket.user;
      const room = rooms.get(roomCode);
      
      if (!room) {
        socket.emit('error', { message: '房间不存在' });
        return;
      }
      
      if (room.players.size >= room.settings.maxPlayers) {
        socket.emit('error', { message: '房间已满' });
        return;
      }
      
      // 检查用户筹码是否足够；钱包余额 <= 0 时允许空手进房，靠补码继续
      const minChips = room.settings.minChips || 100;
      const maxChips = room.settings.maxChips || 10000;
      let actualChipsToEnter = 0;
      
      if (user.totalChips > 0) {
        actualChipsToEnter = chipsToEnter || Math.min(user.totalChips, maxChips);
        
        if (!Number.isInteger(actualChipsToEnter) || actualChipsToEnter <= 0) {
          socket.emit('error', { message: '转入筹码数量必须为正整数' });
          return;
        }
        
        if (user.totalChips < minChips) {
          socket.emit('error', { 
            message: '筹码余额不足，无法加入房间',
            currentBalance: user.totalChips,
            required: minChips
          });
          return;
        }
        
        if (actualChipsToEnter > user.totalChips) {
          socket.emit('error', { 
            message: '转入筹码数量超过余额',
            currentBalance: user.totalChips,
            requested: actualChipsToEnter
          });
          return;
        }
      }
      
      // 执行筹码转移
      const chipResult = await chipService.enterRoom(user._id, room.code, actualChipsToEnter);
      
      const player = {
        id: socket.id,
        userId: user._id,
        name: user.username,
        avatar: user.avatar,
        chips: chipResult.roomChips,
        totalChips: chipResult.totalChips,
        cards: [],
        bet: 0,
        folded: false,
        allIn: false,
        isReady: false,
        needsRebuy: chipResult.roomChips === 0
      };
      
      room.players.set(socket.id, player);
      players.set(socket.id, { roomCode: room.code, player, userId: user._id });
      
      socket.join(room.code);
      socket.emit('joinedRoom', { 
        room: getRoomInfo(room),
        chipStatus: chipResult
      });

      // 空手进房：提示补码（补码的钱从钱包扣除，余额可为负）
      if (player.chips === 0) {
        socket.emit('rebuyRequired', {
          min: MIN_REBUY_CHIPS,
          max: MAX_REBUY_CHIPS,
          chips: 0,
          walletBalance: chipResult.totalChips,
          message: '钱包余额不足，可通过补码继续（补码会从钱包扣除，可为负）'
        });
      }
      
      // 同步当前座位信息给新加入的玩家
      console.log(`为新玩家 ${user.username} 同步座位信息，当前座位数量: ${room.seats.size}`);
      if (room.seats.size > 0) {
        room.seats.forEach((playerId, seatNumber) => {
          const seatedPlayer = room.players.get(playerId);
          if (seatedPlayer) {
            console.log(`发送座位信息: 座位${seatNumber} - 玩家${seatedPlayer.name}`);
            socket.emit('seatTaken', {
              seatNumber,
              player: getPlayerInfo(seatedPlayer, room)
            });
          }
        });
      } else {
        console.log('当前房间没有玩家坐下，无需同步座位信息');
      }
      
      io.to(room.code).emit('playerJoined', { player: getPlayerInfo(player, room) });
      
      console.log(`玩家 ${user.username} 加入房间 ${roomCode}，转入筹码: ${actualChipsToEnter}`);
      
    } catch (error) {
      console.error('加入房间错误:', error);
      socket.emit('error', { message: error.message });
    }
  });
  
  // 玩家准备
  socket.on('playerReady', () => {
    const playerData = players.get(socket.id);
    if (!playerData) return;
    
    const room = rooms.get(playerData.roomCode);
    const player = room.players.get(socket.id);
    
    player.isReady = !player.isReady;
    io.to(room.code).emit('playerStatusChanged', { 
      playerId: socket.id, 
      isReady: player.isReady 
    });
  });
  
  // 开始游戏（已改为自动开始，保留此事件以防客户端调用）
  socket.on('startGame', () => {
    const playerData = players.get(socket.id);
    if (!playerData) return;
    
    const room = rooms.get(playerData.roomCode);
    
    // 提示玩家游戏已改为自动开始
    socket.emit('error', { 
      message: '游戏已改为自动开始模式，当有2名玩家坐下时会自动开始游戏' 
    });
  });
  
  // 玩家操作
  socket.on('playerAction', async (data) => {
    try {
      const { action, amount } = data;
      const playerData = players.get(socket.id);
      if (!playerData) return;
      
      const room = rooms.get(playerData.roomCode);
      await handlePlayerAction(room, socket.id, action, amount);
    } catch (error) {
      console.error('玩家操作错误:', error);
      socket.emit('error', { message: '操作失败' });
    }
  });
  
  // 请求座位信息
  socket.on('requestSeatInfo', () => {
    const playerData = players.get(socket.id);
    if (!playerData) return;
    
    const room = rooms.get(playerData.roomCode);
    if (!room) return;
    
    console.log(`玩家请求座位信息，当前座位数量: ${room.seats.size}`);
    
    // 发送当前所有座位信息给请求的玩家
    if (room.seats.size > 0) {
      room.seats.forEach((playerId, seatNumber) => {
        const seatedPlayer = room.players.get(playerId);
        if (seatedPlayer) {
          console.log(`发送座位信息: 座位${seatNumber} - 玩家${seatedPlayer.name}`);
          socket.emit('seatTaken', {
            seatNumber,
            player: getPlayerInfo(seatedPlayer)
          });
        }
      });
    } else {
      console.log('当前房间没有玩家坐下');
    }
  });
  
  // 离开房间
  socket.on('leaveRoom', async () => {
    try {
      const playerData = players.get(socket.id);
      if (!playerData) return;
      
      const room = rooms.get(playerData.roomCode);
      if (room) {
        // 牌局进行中离房：先按弃牌处理，避免牌局卡死
        const leavingPlayer = room.players.get(socket.id);
        if (leavingPlayer) {
          await handlePlayerLeavingGame(room, socket.id, leavingPlayer);
        }
        // 执行筹码转移回总筹码
        const chipResult = await safeExitRoom(playerData.userId, room.code);
        
        // 释放座位
        const seatNumber = room.playerSeats.get(socket.id);
        if (seatNumber) {
          room.seats.delete(seatNumber);
          room.playerSeats.delete(socket.id);
          io.to(room.code).emit('seatLeft', {
            seatNumber,
            playerId: socket.id
          });
        }
        
        room.players.delete(socket.id);
        socket.leave(room.code);
        
        // 通知客户端筹码转移结果
        socket.emit('leftRoom', {
          chipStatus: chipResult,
          message: '已退出房间，筹码已转回账户'
        });
        
        io.to(room.code).emit('playerLeft', { playerId: socket.id });
        
        // 如果房主离开，转移房主权限
        if (room.hostId === socket.id && room.players.size > 0) {
          const newHost = Array.from(room.players.keys())[0];
          room.hostId = newHost;
          io.to(room.code).emit('hostChanged', { newHostId: newHost });
        }
        
        // 如果房间为空，删除房间
        if (room.players.size === 0) {
          destroyRoom(room);
        }
        
        console.log(`玩家离开房间 ${room.code}，转回筹码: ${chipResult.transferredChips}`);
      }
      players.delete(socket.id);
    } catch (error) {
      console.error('离开房间错误:', error);
      socket.emit('error', { message: error.message });
    }
  });
  
  // 退出游戏（游戏进行中）
  socket.on('leaveGame', async () => {
    try {
      const playerData = players.get(socket.id);
      if (!playerData) return;
      
      const room = rooms.get(playerData.roomCode);
      if (!room) return;
      
      const player = room.players.get(socket.id);
      if (!player) return;
      
      // 牌局进行中离桌：先按弃牌结算并推进牌局，再把剩余筹码转回账户
      if (room.gameState !== GAME_STATES.WAITING) {
        await handlePlayerLeavingGame(room, socket.id, player);
      }
      
      // 执行筹码转移回总筹码（包含未参与下注的筹码）
      const chipResult = await safeExitRoom(playerData.userId, room.code);
      
      // 释放座位
      const seatNumber = room.playerSeats.get(socket.id);
      if (seatNumber) {
        room.seats.delete(seatNumber);
        room.playerSeats.delete(socket.id);
        io.to(room.code).emit('seatLeft', {
          seatNumber,
          playerId: socket.id
        });
      }
      
      // 从房间中移除玩家
      room.players.delete(socket.id);
      socket.leave(room.code);
      
      // 通知客户端筹码转移结果
      socket.emit('leftGame', {
        chipStatus: chipResult,
        message: '已退出游戏，筹码已转回账户'
      });
      
      io.to(room.code).emit('playerLeft', { playerId: socket.id });
      
      // 如果房主离开，转移房主权限
      if (room.hostId === socket.id && room.players.size > 0) {
        const newHost = Array.from(room.players.keys())[0];
        room.hostId = newHost;
        io.to(room.code).emit('hostChanged', { newHostId: newHost });
      }
      
      // 如果房间为空，删除房间
      if (room.players.size === 0) {
        destroyRoom(room);
      }
      
      players.delete(socket.id);
      
      console.log(`玩家退出游戏 ${room.code}，转回筹码: ${chipResult ? chipResult.transferredChips : 0}`);
      
    } catch (error) {
      console.error('退出游戏错误:', error);
      socket.emit('error', { message: error.message });
    }
  });
  
  // 选择座位
  socket.on('selectSeat', (data) => {
    const { seatNumber } = data;
    const playerData = players.get(socket.id);
    if (!playerData) return;
    
    const room = rooms.get(playerData.roomCode);
    if (!room) return;
    
    // 检查座位号是否有效
    if (seatNumber < 1 || seatNumber > 8) {
      socket.emit('seatError', { message: '无效的座位号' });
      return;
    }
    
    // 检查座位是否已被占用
    if (room.seats.has(seatNumber)) {
      socket.emit('seatError', { message: '该座位已被占用' });
      return;
    }
    
    // 检查玩家是否已经坐在其他座位
    if (room.playerSeats.has(socket.id)) {
      const currentSeat = room.playerSeats.get(socket.id);
      socket.emit('seatError', { message: `您已经坐在座位${currentSeat}，请先离开当前座位` });
      return;
    }
    
    // 分配座位
    room.seats.set(seatNumber, socket.id);
    room.playerSeats.set(socket.id, seatNumber);
    
    const player = room.players.get(socket.id);
    
    // 通知所有玩家座位被占用
    io.to(room.code).emit('seatTaken', {
      seatNumber,
      player: getPlayerInfo(player, room)
    });
    
    console.log(`玩家 ${player.name} 坐在座位 ${seatNumber}`);
    
    // 检查是否有两个玩家坐下，如果有且游戏未开始，则自动开始游戏
    if (room.seats.size >= 2 && room.gameState === GAME_STATES.WAITING) {
      console.log(`房间 ${room.code} 有 ${room.seats.size} 个玩家坐下，自动开始游戏`);
      startNewGame(room);
    }
  });
  
  // 补码：筹码输光后补充房间筹码并继续游戏
  socket.on('rebuy', async (data) => {
    try {
      const playerData = players.get(socket.id);
      if (!playerData) {
        socket.emit('rebuyResult', { success: false, message: '您不在房间内' });
        return;
      }

      const room = rooms.get(playerData.roomCode);
      const player = room && room.players.get(socket.id);
      if (!room || !player) {
        socket.emit('rebuyResult', { success: false, message: '您不在房间内' });
        return;
      }

      const amount = Number(data && data.amount);
      if (!Number.isInteger(amount) || amount < MIN_REBUY_CHIPS || amount > MAX_REBUY_CHIPS) {
        socket.emit('rebuyResult', {
          success: false,
          message: `补码金额需为 ${MIN_REBUY_CHIPS}-${MAX_REBUY_CHIPS} 的整数`
        });
        return;
      }

      if (player.chips > 0 || !player.needsRebuy) {
        socket.emit('rebuyResult', { success: false, message: '当前不需要补码' });
        return;
      }

      // 补码的钱从钱包扣除，直接记入房间筹码（允许钱包余额为负）
      const result = await chipService.rebuyRoomChips(playerData.userId, room.code, amount);
      player.chips += amount;
      player.needsRebuy = false;
      player.totalChips = result.walletBalance;
      if (socket.user) socket.user.totalChips = result.walletBalance;

      // 以内存中的最新筹码为准，再同步一次房间余额
      await chipService.updateRoomChips(playerData.userId, room.code, player.chips);

      socket.emit('rebuyResult', {
        success: true,
        amount,
        chips: player.chips,
        walletBalance: result.walletBalance,
        min: MIN_REBUY_CHIPS,
        max: MAX_REBUY_CHIPS,
        message: `补码成功，当前筹码 ${player.chips}，钱包余额 ${result.walletBalance}`
      });

      io.to(room.code).emit('rebuySuccess', {
        playerId: socket.id,
        playerName: player.name,
        amount,
        chips: player.chips
      });
      io.to(room.code).emit('roomUpdate', {
        message: `${player.name} 补码 ${amount}，继续游戏`,
        players: Array.from(room.players.values()).map(p => getPlayerInfo(p, room))
      });

      // 房间正在等待（有筹码的玩家不足 2 人）时，补码后自动开局
      if (room.gameState === GAME_STATES.WAITING) {
        const readySeatedPlayers = Array.from(room.players.values()).filter(
          p => room.playerSeats.has(p.id) && p.chips > 0
        );
        if (readySeatedPlayers.length >= 2) {
          scheduleRoomTask(room, () => {
            if (room.gameState === GAME_STATES.WAITING) {
              startNewGame(room);
            }
          }, 800);
        }
      }

    } catch (error) {
      console.error('补码错误:', error);
      socket.emit('rebuyResult', { success: false, message: error.message });
    }
  });

  // 离开座位
  socket.on('leaveSeat', () => {
    const playerData = players.get(socket.id);
    if (!playerData) return;
    
    const room = rooms.get(playerData.roomCode);
    if (!room) return;
    
    const seatNumber = room.playerSeats.get(socket.id);
    if (!seatNumber) {
      socket.emit('seatError', { message: '您没有坐在任何座位上' });
      return;
    }
    
    // 释放座位
    room.seats.delete(seatNumber);
    room.playerSeats.delete(socket.id);
    
    // 通知所有玩家座位被释放
    io.to(room.code).emit('seatLeft', {
      seatNumber,
      playerId: socket.id
    });
    
    console.log(`玩家离开座位 ${seatNumber}`);
  });
  
  // 搜索房间
  socket.on('discoverRooms', () => {
    console.log(`搜索房间请求，当前房间数量: ${rooms.size}`);
    
    const availableRooms = Array.from(rooms.values())
      .filter(room => room.players.size < room.settings.maxPlayers)
      .map(room => ({
        code: room.code,
        name: room.name,
        players: room.players.size,
        maxPlayers: room.settings.maxPlayers,
        gameState: room.gameState,
        isPlaying: room.gameState !== GAME_STATES.WAITING
      }));
    
    console.log(`找到可用房间: ${availableRooms.length}个`);
    availableRooms.forEach(room => {
      const status = room.isPlaying ? '游戏中' : '等待中';
      console.log(`- 房间 ${room.code}: ${room.name} (${room.players}/${room.maxPlayers}) - ${status}`);
    });
    
    socket.emit('discoverRoomsResult', { rooms: availableRooms });
  });
  
  // 断线处理
  socket.on('disconnect', async () => {
    console.log('玩家断线:', socket.id);
    
    const playerData = players.get(socket.id);
    if (playerData) {
      const room = rooms.get(playerData.roomCode);
      if (room) {
        // 牌局进行中掉线：按弃牌处理并推进牌局，避免其他玩家被卡住
        const leavingPlayer = room.players.get(socket.id);
        if (leavingPlayer) {
          try {
            await handlePlayerLeavingGame(room, socket.id, leavingPlayer);
          } catch (error) {
            console.error('断线处理牌局错误:', error.message);
          }
        }
        // 执行筹码转移回总筹码
        const chipResult = await safeExitRoom(playerData.userId, room.code);
        console.log(`断线玩家筹码转回: ${chipResult ? chipResult.transferredChips : 0}`);
        
        // 释放座位
        const seatNumber = room.playerSeats.get(socket.id);
        if (seatNumber) {
          room.seats.delete(seatNumber);
          room.playerSeats.delete(socket.id);
          io.to(room.code).emit('seatLeft', {
            seatNumber,
            playerId: socket.id
          });
        }
        
        room.players.delete(socket.id);
        io.to(room.code).emit('playerLeft', { playerId: socket.id });
        
        // 如果房主离开，转移房主权限
        if (room.hostId === socket.id && room.players.size > 0) {
          const newHost = Array.from(room.players.keys())[0];
          room.hostId = newHost;
          io.to(room.code).emit('hostChanged', { newHostId: newHost });
        }
        
        // 如果房间为空，删除房间
        if (room.players.size === 0) {
          destroyRoom(room);
        }
      }
      players.delete(socket.id);
    }
  });
});

// 开始新游戏
function startNewGame(room) {
  room.deck = createDeck();
  room.communityCards = [];
  room.pot = 0;
  room.currentBet = 0;
  room.lastRaise = 0;
  room.lastRaiseSize = room.settings.bigBlind;
  room.actionCount = 0;
  room.playersActed = new Set();
  room.gameState = GAME_STATES.PRE_FLOP;
  stopTurnReminder(room);

  // 重置玩家状态
  room.players.forEach(player => {
    player.folded = false;
    player.allIn = false;
    player.bet = 0;
    player.cards = [];
    player.initialChips = player.chips; // 记录游戏开始时的筹码数量
    player.isWinner = false; // 重置获胜状态
    player.handType = null; // 重置牌型
  });

  // 重置本局投入明细（边池计算依赖它）
  room.potContributions = new Map();

  // 只有已选择座位、且还有筹码的玩家才能参与游戏（筹码输光的玩家等待补码）
  const seatedPlayers = Array.from(room.players.values()).filter(p => {
    return room.playerSeats.has(p.id) && p.chips > 0;
  });

  // 记录参与本局游戏的玩家ID，用于区分观战玩家
  room.gameParticipants = new Set(seatedPlayers.map(p => p.id));

  // 有筹码的坐下玩家不足 2 人时不开局，保持等待状态（等待输光的玩家补码）
  if (seatedPlayers.length < 2) {
    room.gameState = GAME_STATES.WAITING;
    room.currentPlayerId = null;
    stopTurnReminder(room);
    io.to(room.code).emit('roomUpdate', {
      message: '需要至少2名有筹码的玩家才能开始，等待玩家补码',
      players: Array.from(room.players.values()).map(p => getPlayerInfo(p, room))
    });
    return;
  }

  // 参与本局游戏的玩家都已拥有筹码，清除待补码标记
  seatedPlayers.forEach(p => { p.needsRebuy = false; });

  // 按座位号排序玩家，确保游戏顺序按座位进行
  seatedPlayers.sort((a, b) => {
    const seatA = room.playerSeats.get(a.id);
    const seatB = room.playerSeats.get(b.id);
    return seatA - seatB;
  });

  // 庄家按钮轮转；两人桌时按钮位就是小盲（标准单挑规则）
  const playerCount = seatedPlayers.length;
  const isHeadsUp = playerCount === 2;
  room.dealerIndex = (Number.isInteger(room.dealerIndex) ? room.dealerIndex + 1 : 0) % playerCount;
  room.smallBlindIndex = isHeadsUp ? room.dealerIndex : (room.dealerIndex + 1) % playerCount;
  room.dealerPlayerId = seatedPlayers[room.dealerIndex].id;
  room.bigBlindIndex = isHeadsUp ? (room.dealerIndex + 1) % playerCount : (room.dealerIndex + 2) % playerCount;

  // 发底牌给已选择座位的玩家
  for (let i = 0; i < 2; i++) {
    seatedPlayers.forEach(player => {
      player.cards.push(room.deck.pop());
    });
  }

  // 下盲注（筹码不足时直接全下，避免出现负筹码）
  const smallBlindPlayer = seatedPlayers[room.smallBlindIndex];
  const bigBlindPlayer = seatedPlayers[room.bigBlindIndex];
  const smallBlindAmount = Math.min(room.settings.smallBlind, smallBlindPlayer.chips);
  const bigBlindAmount = Math.min(room.settings.bigBlind, bigBlindPlayer.chips);

  smallBlindPlayer.bet = smallBlindAmount;
  smallBlindPlayer.chips -= smallBlindAmount;
  bigBlindPlayer.bet = bigBlindAmount;
  bigBlindPlayer.chips -= bigBlindAmount;
  if (smallBlindPlayer.chips === 0) smallBlindPlayer.allIn = true;
  if (bigBlindPlayer.chips === 0) bigBlindPlayer.allIn = true;

  addPotContribution(room, smallBlindPlayer.id, smallBlindAmount);
  addPotContribution(room, bigBlindPlayer.id, bigBlindAmount);

  room.pot = smallBlindAmount + bigBlindAmount;
  room.currentBet = room.settings.bigBlind;
  room.lastRaiseSize = room.settings.bigBlind;

  // 翻牌前从大盲左侧第一位能行动的玩家开始（单挑时就是按钮/小盲位）
  const firstActor = findNextActor(room, room.playerSeats.get(bigBlindPlayer.id));
  room.currentPlayerId = firstActor ? firstActor.id : null;
  startTurnReminder(room);

  io.to(room.code).emit('gameStarted', {
    gameState: room.gameState,
    pot: room.pot,
    currentBet: room.currentBet,
    lastRaiseSize: room.lastRaiseSize,
    currentPlayer: room.currentPlayerId,
    turnDeadline: room.turnDeadline,
    players: seatedPlayers.map(p => getPlayerInfo(p, room)),
    dealerIndex: room.dealerIndex,
    smallBlindIndex: room.smallBlindIndex,
    bigBlindIndex: room.bigBlindIndex,
    bigBlind: room.settings.bigBlind,
    smallBlind: room.settings.smallBlind,
    seatedPlayers: seatedPlayers.map(p => ({
      playerId: p.id,
      seatNumber: room.playerSeats.get(p.id)
    }))
  });

  // 发送底牌给已选择座位的玩家
  seatedPlayers.forEach(player => {
    io.to(player.id).emit('dealCards', { cards: player.cards });
  });

  // 极端情况：盲注直接把所有人打成全下，没有可行动玩家，直接进入下一阶段
  if (!room.currentPlayerId) {
    scheduleRoomTask(room, () => {
      if (room.gameState === GAME_STATES.PRE_FLOP && !room.currentPlayerId) {
        nextGameStage(room);
      }
    }, 0);
  }
}

// 构建下注轮状态快照（用于广播与非法操作回执）
function buildGameStatePayload(room, action) {
  const payload = {
    pot: room.pot,
    currentBet: room.currentBet,
    lastRaiseSize: room.lastRaiseSize,
    currentPlayer: room.currentPlayerId,
    turnDeadline: room.turnDeadline,
    players: getActivePlayers(room).map(p => getPlayerInfo(p, room)),
    allPlayers: Array.from(room.players.values()).map(p => getPlayerInfo(p, room)),
    gameParticipants: Array.from(room.gameParticipants || []),
    dealerIndex: room.dealerIndex,
    smallBlindIndex: room.smallBlindIndex,
    bigBlindIndex: room.bigBlindIndex,
    bigBlind: room.settings.bigBlind,
    smallBlind: room.settings.smallBlind
  };
  if (action) payload.action = action;
  return payload;
}

// 拒绝非法操作：只回执给该玩家，并同步一次最新状态
function rejectAction(room, playerId, reason) {
  io.to(playerId).emit('actionRejected', { reason });
  io.to(playerId).emit('gameStateUpdate', buildGameStatePayload(room));
}

// 处理玩家操作
async function handlePlayerAction(room, playerId, action, amount = 0) {
  if (!room) return;

  if (room.gameState !== GAME_STATES.PRE_FLOP && room.gameState !== GAME_STATES.FLOP &&
      room.gameState !== GAME_STATES.TURN && room.gameState !== GAME_STATES.RIVER) {
    return rejectAction(room, playerId, '当前不在下注轮，请稍候');
  }

  if (!room.gameParticipants || !room.gameParticipants.has(playerId)) {
    return rejectAction(room, playerId, '观战中，不能参与本局操作');
  }

  const player = room.players.get(playerId);
  if (!player) return;
  if (player.folded) return rejectAction(room, playerId, '你已弃牌，本局无法再行动');
  if (player.allIn) return rejectAction(room, playerId, '你已全下，等待其他玩家行动');
  if (room.currentPlayerId !== playerId) {
    const current = room.players.get(room.currentPlayerId);
    return rejectAction(room, playerId, current ? `还没轮到你，当前是 ${current.name} 行动` : '还没轮到你行动');
  }

  const callAmount = Math.max(0, room.currentBet - player.bet);
  let appliedAction = action;
  let appliedAmount = 0;
  let fullRaise = false;

  switch (action) {
    case 'fold':
      player.folded = true;
      break;

    case 'check':
      if (callAmount > 0) {
        return rejectAction(room, playerId, `当前有 ${callAmount} 筹码需要跟注，不能过牌`);
      }
      break;

    case 'call': {
      if (callAmount <= 0) {
        return rejectAction(room, playerId, '当前无需跟注，请选择过牌');
      }
      const payAmount = Math.min(callAmount, player.chips);
      if (payAmount <= 0) return rejectAction(room, playerId, '筹码不足，无法跟注');
      player.chips -= payAmount;
      player.bet += payAmount;
      room.pot += payAmount;
      addPotContribution(room, player.id, payAmount);
      appliedAmount = payAmount;
      if (player.chips === 0) {
        player.allIn = true;
        appliedAction = 'allIn';
      }
      break;
    }

    case 'raise': {
      const requested = Number(amount);
      if (!Number.isFinite(requested) || Math.floor(requested) !== requested || requested <= 0) {
        return rejectAction(room, playerId, '加注金额无效');
      }
      if (requested > player.chips) {
        return rejectAction(room, playerId, '加注金额超过你的筹码，请选择全下');
      }
      const newBet = player.bet + requested;
      if (newBet <= room.currentBet) {
        return rejectAction(room, playerId, `加注后需要大于当前下注 ${room.currentBet}`);
      }
      const isAllInRaise = requested === player.chips;
      const minNewBet = room.currentBet + room.lastRaiseSize;
      if (newBet < minNewBet && !isAllInRaise) {
        return rejectAction(room, playerId, `最小加注到 ${minNewBet}（本次需投入 ${minNewBet - player.bet}）`);
      }
      const raiseIncrement = newBet - room.currentBet;
      player.chips -= requested;
      player.bet = newBet;
      room.pot += requested;
      addPotContribution(room, player.id, requested);
      room.currentBet = newBet;
      appliedAmount = requested;
      if (raiseIncrement >= room.lastRaiseSize) {
        room.lastRaiseSize = raiseIncrement;
        fullRaise = true;
      }
      if (player.chips === 0) {
        player.allIn = true;
        appliedAction = 'allIn';
      }
      break;
    }

    case 'allIn': {
      if (player.chips <= 0) return rejectAction(room, playerId, '你已没有筹码可以全下');
      const allInAmount = player.chips;
      const newBet = player.bet + allInAmount;
      player.chips = 0;
      player.bet = newBet;
      room.pot += allInAmount;
      addPotContribution(room, player.id, allInAmount);
      player.allIn = true;
      appliedAmount = allInAmount;
      if (newBet > room.currentBet) {
        const raiseIncrement = newBet - room.currentBet;
        if (raiseIncrement >= room.lastRaiseSize) {
          room.lastRaiseSize = raiseIncrement;
          fullRaise = true;
        }
        room.currentBet = newBet;
      }
      break;
    }

    default:
      return rejectAction(room, playerId, '未知操作');
  }

  // 记录行动：完整加注后所有玩家需要重新行动；短 all-in 不重开行动
  if (!room.playersActed) room.playersActed = new Set();
  if (fullRaise) room.playersActed.clear();
  room.playersActed.add(playerId);

  stopTurnReminder(room);

  // 同步筹码变化到数据库
  try {
    const playerData = players.get(playerId);
    if (playerData && playerData.userId) {
      await chipService.updateRoomChips(playerData.userId, room.code, player.chips);
    }
  } catch (error) {
    console.error('同步筹码错误:', error);
  }

  // 只剩一个未弃牌的玩家，直接结算
  if (getActivePlayers(room).length === 1) {
    await showdown(room);
    return;
  }

  // 本轮下注结束则进入下一阶段（nextGameStage 会重设当前玩家和提醒）
  if (isRoundComplete(room)) {
    nextGameStage(room);
    return;
  }

  // 轮到下一个能行动的玩家
  const nextPlayer = findNextActor(room, room.playerSeats.get(playerId));
  room.currentPlayerId = nextPlayer ? nextPlayer.id : null;
  if (room.currentPlayerId) {
    startTurnReminder(room);
  }

  io.to(room.code).emit('gameStateUpdate', buildGameStatePayload(room, {
    playerId,
    action: appliedAction,
    amount: appliedAmount
  }));
}

// 移动到下一个玩家
function moveToNextPlayer(room) {
  const fromSeat = room.playerSeats.get(room.currentPlayerId);
  const nextPlayer = findNextActor(room, Number.isInteger(fromSeat) ? fromSeat : -1);
  room.currentPlayerId = nextPlayer ? nextPlayer.id : null;
  if (room.currentPlayerId) {
    startTurnReminder(room);
  } else {
    stopTurnReminder(room);
  }
  return room.currentPlayerId;
}

// 获取当前玩家
function getCurrentPlayer(room) {
  if (!room || !room.currentPlayerId) return null;
  return room.players.get(room.currentPlayerId) || null;
}

// 检查回合是否完成
function isRoundComplete(room) {
  // 获取活跃玩家（按座位号排序）
  const activePlayers = Array.from(room.players.values())
    .filter(p => room.gameParticipants.has(p.id) && !p.folded)
    .sort((a, b) => {
      const seatA = room.playerSeats.get(a.id);
      const seatB = room.playerSeats.get(b.id);
      return seatA - seatB;
    });
  
  if (activePlayers.length <= 1) return true;
  
  const playersCanAct = activePlayers.filter(p => !p.allIn);
  
  // 如果没有能行动的玩家，回合结束
  if (playersCanAct.length === 0) return true;
  
  // 检查所有能行动的玩家是否都跟上了当前下注
  const currentBet = room.currentBet;
  const allPlayersMatchCurrentBet = playersCanAct.every(p => p.bet === currentBet);
  
  if (!allPlayersMatchCurrentBet) return false;
  
  // 检查是否所有能行动的玩家都已行动过
  if (!room.actionCount) room.actionCount = 0;
  if (!room.playersActed) room.playersActed = new Set();
  
  // 所有能行动的玩家都必须至少行动过一次
  const allPlayersActed = playersCanAct.every(p => room.playersActed.has(p.id));
  
  return allPlayersActed;
}

// 进入下一游戏阶段
function nextGameStage(room) {
  // 进入新阶段：清空本轮下注，重置最小加注额为一个大盲
  room.players.forEach(player => {
    player.bet = 0;
  });
  room.currentBet = 0;
  room.lastRaise = 0;
  room.lastRaiseSize = room.settings.bigBlind;
  room.actionCount = 0;
  room.playersActed = new Set();
  room.currentPlayerId = null;
  stopTurnReminder(room);

  const activePlayers = getActivePlayers(room);
  const playersCanAct = activePlayers.filter(p => !p.allIn);

  // 如果没有玩家能继续行动（所有玩家都全下或只剩一个能行动的玩家），直接跳到摊牌并发出所有剩余公共牌
  if (playersCanAct.length <= 1 && activePlayers.length > 1) {
    while (room.communityCards.length < 5 && room.deck.length > 0) {
      room.communityCards.push(room.deck.pop());
    }

    room.gameState = GAME_STATES.SHOWDOWN;

    io.to(room.code).emit('allInShowdown', {
      gameState: room.gameState,
      communityCards: room.communityCards,
      message: '所有玩家全下，直接摊牌'
    });

    showdown(room);
    return;
  }

  // 正常的游戏阶段转换
  switch (room.gameState) {
    case GAME_STATES.PRE_FLOP:
      room.gameState = GAME_STATES.FLOP;
      for (let i = 0; i < 3; i++) {
        room.communityCards.push(room.deck.pop());
      }
      break;

    case GAME_STATES.FLOP:
      room.gameState = GAME_STATES.TURN;
      room.communityCards.push(room.deck.pop());
      break;

    case GAME_STATES.TURN:
      room.gameState = GAME_STATES.RIVER;
      room.communityCards.push(room.deck.pop());
      break;

    case GAME_STATES.RIVER: {
      room.gameState = GAME_STATES.SHOWDOWN;

      const showdownData = {
        gameState: room.gameState,
        communityCards: room.communityCards,
        dealerIndex: room.dealerIndex,
        smallBlindIndex: room.smallBlindIndex,
        bigBlindIndex: room.bigBlindIndex
      };

      showdownData.playerCards = Array.from(room.players.values())
        .filter(p => room.gameParticipants.has(p.id))
        .map(p => ({
          playerId: p.id,
          cards: p.cards
        }));

      io.to(room.code).emit('nextStage', showdownData);

      // 延时1秒后进行摊牌计算和结果显示（定时器登记在房间上，离房时会清理）
      scheduleRoomTask(room, () => showdown(room), 1000);
      return;
    }
  }

  // 翻牌/转牌/河牌：从庄家左侧第一位能行动的玩家开始
  setCurrentPlayerForNewStage(room);

  const stageData = {
    gameState: room.gameState,
    communityCards: room.communityCards,
    currentPlayer: room.currentPlayerId,
    turnDeadline: room.turnDeadline,
    lastRaiseSize: room.lastRaiseSize,
    dealerIndex: room.dealerIndex,
    smallBlindIndex: room.smallBlindIndex,
    bigBlindIndex: room.bigBlindIndex
  };

  // 如果是翻牌阶段及之后，发送所有参与游戏玩家的手牌
  if (room.gameState !== GAME_STATES.PRE_FLOP) {
    stageData.playerCards = Array.from(room.players.values())
      .filter(p => room.gameParticipants.has(p.id))
      .map(p => ({
        playerId: p.id,
        cards: p.cards
      }));
  }

  io.to(room.code).emit('nextStage', stageData);
}

// 为新阶段设置当前玩家（Flop/Turn/River 从庄家左侧第一位能行动的玩家开始）
function setCurrentPlayerForNewStage(room) {
  const participants = Array.from(room.players.values())
    .filter(p => room.gameParticipants && room.gameParticipants.has(p.id))
    .sort((a, b) => room.playerSeats.get(a.id) - room.playerSeats.get(b.id));

  const dealerPlayer = room.dealerPlayerId
    ? participants.find(p => p.id === room.dealerPlayerId) || participants[room.dealerIndex]
    : participants[room.dealerIndex];
  const dealerSeat = dealerPlayer ? room.playerSeats.get(dealerPlayer.id) : -1;
  const nextPlayer = findNextActor(room, dealerSeat);

  room.currentPlayerId = nextPlayer ? nextPlayer.id : null;
  if (room.currentPlayerId) {
    startTurnReminder(room);
  } else {
    stopTurnReminder(room);
  }
}

// 摊牌
async function showdown(room) {
  // 获取活跃玩家（按座位号排序）
  const activePlayers = Array.from(room.players.values())
    .filter(p => room.gameParticipants.has(p.id) && !p.folded)
    .sort((a, b) => {
      const seatA = room.playerSeats.get(a.id);
      const seatB = room.playerSeats.get(b.id);
      return seatA - seatB;
    });
  
  // 如果只剩一个玩家，直接获胜
  if (activePlayers.length === 1) {
    const winner = activePlayers[0];
    winner.chips += room.pot;
    winner.isWinner = true;
    winner.handType = null; // 无需摊牌，无牌型
    
    const gameResult = {
      winners: [{ 
        playerId: winner.id, 
        playerName: winner.name,
        hand: null, // 无需摊牌
        winAmount: room.pot 
      }],
      pot: room.pot,
      communityCards: room.communityCards,
      timestamp: new Date(),
      noShowdown: true
    };
    
    room.gameHistory.push(gameResult);
    
    io.to(room.code).emit('gameFinished', {
      result: gameResult,
      players: activePlayers.map(p => getPlayerInfo(p, room))
    });
    
    await finishGame(room);
    return;
  }
  
  // 评估每个玩家的牌型
  const playerHands = activePlayers.map(player => {
    const allCards = [...player.cards, ...room.communityCards];
    const hand = evaluateHand(allCards);
    return { player, hand };
  });
  
  // 排序找出赢家
  playerHands.sort((a, b) => b.hand.value - a.hand.value);
  
  // 处理边池分配（含已弃牌/已离桌玩家的投入，保证筹码守恒）
  const potResults = distributePots({
    pot: room.pot,
    contributions: room.potContributions,
    playerHands
  });
  const distributedTotal = potResults.reduce(
    (sum, result) => sum + result.winners.reduce((s, w) => s + w.winAmount, 0),
    0
  );
  if (distributedTotal !== room.pot) {
    console.warn(`⚠️ 奖池分配异常: 底池 ${room.pot}, 实际发出 ${distributedTotal}`);
  }
  
  // 分配奖池给获胜者并设置获胜状态
  const winnerIds = new Set();
  potResults.forEach(result => {
    result.winners.forEach(winner => {
      winner.player.chips += winner.winAmount;
      winner.player.isWinner = true;
      winnerIds.add(winner.player.id);
    });
  });
  
  // 为所有玩家设置牌型和获胜状态
  playerHands.forEach(ph => {
    ph.player.handType = ph.hand.type;
    if (!winnerIds.has(ph.player.id)) {
      ph.player.isWinner = false;
    }
  });
  
  // 记录游戏历史
  const gameResult = {
    winners: potResults.flatMap(result => result.winners.map(w => ({
      playerId: w.player.id,
      playerName: w.player.name,
      hand: w.hand,
      winAmount: w.winAmount,
      potType: result.potType
    }))),
    pot: room.pot,
    communityCards: room.communityCards,
    timestamp: new Date(),
    potResults: potResults,
    // 添加所有参与摊牌玩家的手牌信息
    showdownPlayers: playerHands.map(ph => ({
      playerId: ph.player.id,
      playerName: ph.player.name,
      cards: ph.player.cards,
      hand: ph.hand
    }))
  };

  room.gameHistory.push(gameResult);

  io.to(room.code).emit('gameFinished', {
    result: gameResult,
    players: activePlayers.map(p => getPlayerInfo(p, room))
  });
  
  await finishGame(room);
}

// 游戏结束处理
async function finishGame(room) {
  // 同步所有玩家的筹码到数据库；筹码输光的玩家不再移出游戏，标记为待补码
  const brokePlayers = [];
  for (const [playerId, player] of room.players) {
    const playerData = players.get(playerId);
    try {
      if (playerData && playerData.userId) {
        await chipService.updateRoomChips(playerData.userId, room.code, player.chips);
      }
    } catch (error) {
      // 玩家可能已经离桌，筹码已随退房结算，跳过即可
      if (!/不在该房间内/.test(error.message)) {
        console.error('同步玩家筹码错误:', error);
      }
    }

    if (player.chips <= 0) {
      player.needsRebuy = true;
      brokePlayers.push(player);

      // 附带钱包余额，方便客户端提示“补码会从钱包扣除”
      let walletBalance = null;
      try {
        if (playerData && playerData.userId) {
          const walletUser = await User.findById(playerData.userId).select('totalChips');
          if (walletUser) walletBalance = walletUser.totalChips;
        }
      } catch (error) {
        console.error('查询钱包余额错误:', error);
      }

      io.to(player.id).emit('rebuyRequired', {
        min: MIN_REBUY_CHIPS,
        max: MAX_REBUY_CHIPS,
        chips: player.chips,
        walletBalance,
        message: '您的筹码已用完，可补码后继续游戏（补码从钱包扣除，可为负）'
      });
    }
  }

  // 重置游戏状态
  room.currentPlayerId = null;
  stopTurnReminder(room);
  room.gameState = GAME_STATES.WAITING;
  room.communityCards = [];
  room.pot = 0;
  room.gameParticipants = null; // 清除本局游戏参与者记录
  room.potContributions = new Map();

  // 通知房间最新玩家状态（含待补码标记）
  io.to(room.code).emit('roomUpdate', {
    players: Array.from(room.players.values()).map(p => getPlayerInfo(p, room))
  });

  // 有筹码的坐下玩家足够 2 人时，3 秒后自动开始新一局；否则等待补码
  const readySeatedPlayers = Array.from(room.players.values()).filter(
    p => room.playerSeats.has(p.id) && p.chips > 0
  );
  if (readySeatedPlayers.length >= 2) {
    scheduleRoomTask(room, () => {
      if (room.gameState === GAME_STATES.WAITING) {
        console.log(`房间 ${room.code} 游戏结束后自动开始新游戏，有筹码的坐下玩家数: ${readySeatedPlayers.length}`);
        startNewGame(room);
      }
    }, 3000);
  } else {
    io.to(room.code).emit('roomUpdate', {
      message: brokePlayers.length > 0
        ? '等待玩家补码，补码完成后自动开始新一局'
        : '需要至少2名有筹码的玩家坐下才能开始游戏',
      players: Array.from(room.players.values()).map(p => getPlayerInfo(p, room))
    });
  }
}

// 获取房间信息
function getRoomInfo(room) {
  return {
    code: room.code,
    name: room.name,
    hostId: room.hostId,
    gameState: room.gameState,
    players: Array.from(room.players.values()).map(p => getPlayerInfo(p, room)),
    settings: room.settings,
    communityCards: room.communityCards,
    pot: room.pot,
    gameParticipants: room.gameParticipants ? Array.from(room.gameParticipants) : []
  };
}

// 获取玩家信息
function getPlayerInfo(player, room = null) {
  const playerInfo = {
    id: player.id,
    name: player.name,
    chips: player.chips,
    bet: player.bet,
    folded: player.folded,
    allIn: player.allIn,
    isReady: player.isReady,
    needsRebuy: Boolean(player.needsRebuy),
    status: getPlayerStatus(player, room)
  };
  
  // 如果提供了房间信息，添加是否为游戏参与者的标识
  if (room && room.gameParticipants) {
    playerInfo.isGameParticipant = room.gameParticipants.has(player.id);
  }
  
  return playerInfo;
}

// 获取玩家状态
function getPlayerStatus(player, room = null) {
  // 检查是否在线（这里简化处理，实际应该检查socket连接状态）
  if (!player.id) {
    return 'offline';
  }
  
  // 如果游戏进行中
  if (room && room.gameState !== GAME_STATES.WAITING && room.gameParticipants && room.gameParticipants.has(player.id)) {
    if (player.folded) {
      return 'folded';
    }
    if (player.allIn) {
      return 'allin';
    }
    
    // 检查是否轮到该玩家行动
    const currentPlayer = getCurrentPlayer(room);
    if (currentPlayer && currentPlayer.id === player.id) {
      return 'thinking';
    }
  }
  
  return 'online';
}

// UDP广播处理
udpServer.on('message', (msg, rinfo) => {
  if (msg.toString() === 'POKER_DISCOVERY') {
    const response = JSON.stringify({
      type: 'POKER_SERVER',
      port: SERVER_PORT,
      rooms: Array.from(rooms.values()).map(room => ({
        code: room.code,
        name: room.name,
        players: room.players.size,
        maxPlayers: room.settings.maxPlayers
      }))
    });
    
    udpServer.send(response, rinfo.port, rinfo.address);
  }
});

udpServer.bind(BROADCAST_PORT);

// 获取当前仍有资格行动的玩家（按座位号排序）
function getActivePlayers(room) {
  return Array.from(room.players.values())
    .filter(p => room.gameParticipants && room.gameParticipants.has(p.id) && !p.folded)
    .sort((a, b) => {
      const seatA = room.playerSeats.get(a.id);
      const seatB = room.playerSeats.get(b.id);
      return seatA - seatB;
    });
}

// 记录玩家投入底池的筹码（用于边池与离桌结算）
function addPotContribution(room, playerId, amount) {
  if (!room.potContributions) room.potContributions = new Map();
  const value = Number(amount) || 0;
  if (value <= 0) return;
  room.potContributions.set(playerId, (room.potContributions.get(playerId) || 0) + value);
}

// 继续游戏流程（玩家弃牌/离桌后调用）
async function continueGame(room) {
  if (!room || room.gameState === GAME_STATES.WAITING) return;

  if (isRoundComplete(room)) {
    nextGameStage(room);
    return;
  }

  io.to(room.code).emit('gameStateUpdate', {
    pot: room.pot,
    currentBet: room.currentBet,
    lastRaiseSize: room.lastRaiseSize,
    currentPlayer: getCurrentPlayer(room)?.id,
    turnDeadline: room.turnDeadline,
    players: getActivePlayers(room).map(p => getPlayerInfo(p, room)),
    allPlayers: Array.from(room.players.values()).map(p => getPlayerInfo(p, room)),
    gameParticipants: Array.from(room.gameParticipants || []),
    dealerIndex: room.dealerIndex,
    smallBlindIndex: room.smallBlindIndex,
    bigBlindIndex: room.bigBlindIndex,
    bigBlind: room.settings.bigBlind,
    smallBlind: room.settings.smallBlind
  });
}

// 玩家在牌局进行中离桌：按弃牌处理并推进牌局，避免牌局卡死
async function handlePlayerLeavingGame(room, socketId, player) {
  if (!room || !player) return;
  if (room.gameState === GAME_STATES.WAITING) return;
  if (!room.gameParticipants || !room.gameParticipants.has(socketId)) return;
  if (player.folded) return;

  const wasCurrentPlayer = getCurrentPlayer(room)?.id === socketId;

  player.folded = true;

  io.to(room.code).emit('playerAction', {
    playerId: socketId,
    action: 'fold',
    playerName: player.name
  });

  const remaining = getActivePlayers(room);

  if (remaining.length === 1) {
    await showdown(room);
    return;
  }

  if (remaining.length === 0) {
    await finishGame(room);
    return;
  }

  // 如果正好轮到他，先轮到下一位玩家
  if (wasCurrentPlayer) moveToNextPlayer(room);

  await continueGame(room);
}

// 退出房间并把筹码转回总账户（失败只记录日志，不阻塞离桌流程）
async function safeExitRoom(userId, roomCode) {
  try {
    return await chipService.exitRoom(userId, roomCode);
  } catch (error) {
    if (!/不在该房间内/.test(error.message)) {
      console.error(`退出房间 ${roomCode} 筹码结算失败:`, error.message);
    }
    return null;
  }
}

// 启动服务器
async function startServer() {
  try {
    // 确保 MongoDB 可用：没有安装时自动拉起项目自带的便携版
    const mongoState = await ensureMongo();

    if (mongoState.status === 'missing' || mongoState.status === 'failed') {
      if (mongoState.status === 'failed') {
        console.error('❌ 便携版 MongoDB 启动失败，请查看 data/mongod.log');
      }
      console.error(MISSING_DB_HINT);
      process.exit(1);
    }

    if (mongoState.status === 'started') {
      console.log('✅ 已自动启动本地 MongoDB（数据目录: data/db）');
    }

    // 连接数据库
    await database.connect();
    console.log('数据库连接成功');
    
    // 启动定时任务服务
    schedulerService.start();
    
    // 启动HTTP服务器
    server.listen(SERVER_PORT, () => {
      console.log(`德州扑克服务器启动在端口 ${SERVER_PORT}`);
      console.log(`UDP广播服务启动在端口 ${BROADCAST_PORT}`);
      console.log(`游戏地址: http://localhost:${SERVER_PORT}`);
      console.log(`API地址: http://localhost:${SERVER_PORT}/api`);
    });
    
  } catch (error) {
    const isDbError = error.name === 'MongooseServerSelectionError' ||
      /ECONNREFUSED|connect failed/i.test(error.message || '');

    if (isDbError) {
      console.error('\n❌ 无法连接 MongoDB:', error.message);
      console.error(MISSING_DB_HINT);
    } else {
      console.error('❌ 服务器启动失败:', error);
    }
    process.exit(1);
  }
}

// 优雅关闭
process.on('SIGINT', async () => {
  console.log('\n正在关闭服务器...');
  
  // 停止定时任务
  schedulerService.stop();
  
  try {
    await database.disconnect();
    console.log('数据库连接已关闭');
  } catch (error) {
    console.error('关闭数据库连接失败:', error);
  }
  
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n正在关闭服务器...');
  
  // 停止定时任务
  schedulerService.stop();
  
  try {
    await database.disconnect();
    console.log('数据库连接已关闭');
  } catch (error) {
    console.error('关闭数据库连接失败:', error);
  }
  
  process.exit(0);
});

// 启动服务器
startServer();

module.exports = { app, server, io };
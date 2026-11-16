const express = require('express');
const User = require('../models/User');
const ChipTransaction = require('../models/ChipTransaction');
const { generateToken, authenticateToken } = require('../middleware/auth');
const chipService = require('../services/chipService');

const router = express.Router();

// 新用户初始筹码
const INITIAL_CHIPS = 1000;

/**
 * 进入游戏（登录 / 首次进入自动创建账号）
 * POST /api/auth/login
 * 请求体：{ username }
 *
 * 局域网游戏已简化为"只填用户名即可进入"：
 * - 用户名已存在：直接登录
 * - 用户名不存在：自动创建账号并发放初始筹码
 */
router.post('/login', async (req, res) => {
  try {
    const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';

    if (!username) {
      return res.status(400).json({ error: '请输入用户名' });
    }

    if (username.length < 2 || username.length > 20) {
      return res.status(400).json({ error: '用户名长度需为 2-20 个字符' });
    }

    let user = await User.findOne({ username });
    let isNewUser = false;

    if (!user) {
      try {
        user = new User({ username, totalChips: INITIAL_CHIPS });
        await user.save();
        isNewUser = true;
      } catch (error) {
        // 并发创建同名账号时，唯一索引会报错，此时按已存在处理
        if (error.code === 11000) {
          user = await User.findOne({ username });
          if (!user) throw error;
        } else {
          throw error;
        }
      }
    }

    // 记录首次进入奖励流水（失败不影响登录本身）
    if (isNewUser) {
      try {
        await ChipTransaction.createTransaction({
          userId: user._id,
          type: 'REGISTER_BONUS',
          amount: INITIAL_CHIPS,
          balanceBefore: 0,
          balanceAfter: INITIAL_CHIPS,
          description: '首次进入游戏奖励'
        });
      } catch (error) {
        console.error('记录首次进入奖励失败:', error);
      }
    }

    // 更新最后登录时间
    user.lastLogin = new Date();
    await user.save();

    // 生成JWT令牌
    const token = generateToken({ userId: user._id });

    res.json({
      success: true,
      message: isNewUser ? '账号已创建，欢迎加入！' : '登录成功',
      isNewUser,
      token,
      user: {
        id: user._id,
        username: user.username,
        totalChips: user.totalChips,
        avatar: user.avatar,
        lastLogin: user.lastLogin
      }
    });

  } catch (error) {
    console.error('登录错误:', error);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 获取当前用户信息
 * GET /api/auth/me
 */
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const user = req.user;

    res.json({
      success: true,
      user: {
        id: user._id,
        username: user.username,
        totalChips: user.totalChips,
        avatar: user.avatar,
        lastLogin: user.lastLogin,
        createdAt: user.createdAt
      }
    });

  } catch (error) {
    console.error('获取用户信息错误:', error);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 更新用户资料
 * PUT /api/auth/profile
 */
router.put('/profile', authenticateToken, async (req, res) => {
  try {
    const { avatar } = req.body;
    const user = req.user;

    if (avatar) {
      user.avatar = avatar;
    }

    await user.save();

    res.json({
      success: true,
      message: '资料更新成功',
      user: {
        id: user._id,
        username: user.username,
        totalChips: user.totalChips,
        avatar: user.avatar
      }
    });

  } catch (error) {
    console.error('更新资料错误:', error);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

/**
 * 获取用户筹码状态
 * GET /api/auth/chips
 */
router.get('/chips', authenticateToken, async (req, res) => {
  try {
    const { roomCode } = req.query;
    const chipStatus = await chipService.getUserChipStatus(req.user._id, roomCode);

    res.json({
      success: true,
      chipStatus
    });

  } catch (error) {
    console.error('获取筹码状态错误:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 获取用户交易历史
 * GET /api/auth/transactions
 */
router.get('/transactions', authenticateToken, async (req, res) => {
  try {
    const { limit = 50, skip = 0 } = req.query;
    const transactions = await chipService.getUserTransactionHistory(
      req.user._id,
      parseInt(limit),
      parseInt(skip)
    );

    res.json({
      success: true,
      transactions
    });

  } catch (error) {
    console.error('获取交易历史错误:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 获取用户统计数据
 * GET /api/auth/stats
 */
router.get('/stats', authenticateToken, async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const stats = await chipService.getUserStats(req.user._id, parseInt(days));

    res.json({
      success: true,
      stats
    });

  } catch (error) {
    console.error('获取统计数据错误:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;

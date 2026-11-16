const express = require('express');
const router = express.Router();
const chipService = require('../services/chipService');
const { authenticateToken } = require('../middleware/auth');

// 使用认证中间件的别名
const auth = authenticateToken;

/**
 * 排行榜相关路由
 */

// 获取排行榜
router.get('/leaderboards', auth, async (req, res) => {
  try {
    const { type = 'total_chips' } = req.query;
    const leaderboard = await chipService.getLeaderboard(type, req.user.id);
    res.json({
      success: true,
      data: leaderboard
    });
  } catch (error) {
    console.error('获取排行榜失败:', error);
    res.status(500).json({
      success: false,
      message: '获取排行榜失败',
      error: error.message
    });
  }
});

// 获取用户排名详情
router.get('/leaderboards/my-rank', auth, async (req, res) => {
  try {
    const { type = 'total_chips' } = req.query;
    const userRank = await chipService.getUserActualRank(req.user.id, type);
    res.json({
      success: true,
      data: userRank
    });
  } catch (error) {
    console.error('获取用户排名失败:', error);
    res.status(500).json({
      success: false,
      message: '获取用户排名失败',
      error: error.message
    });
  }
});

/**
 * 筹码相关路由
 */

// 添加筹码（管理员接口）
router.post('/chips/add', auth, async (req, res) => {
  try {
    // 检查管理员权限
    if (!req.user.isAdmin) {
      return res.status(403).json({
        success: false,
        message: '权限不足'
      });
    }

    const { userId, amount, description, metadata } = req.body;
    const result = await chipService.addChips(
      userId,
      Number(amount),
      'ADMIN_ADJUST',
      description || '管理员调整筹码',
      Object.assign(
        { adminId: req.user._id },
        metadata && typeof metadata === 'object' ? metadata : {}
      )
    );
    res.json({
      success: true,
      message: `成功添加 ${result.amount} 筹码`,
      data: result
    });
  } catch (error) {
    console.error('添加筹码失败:', error);
    res.status(500).json({
      success: false,
      message: '添加筹码失败',
      error: error.message
    });
  }
});

// 获取用户经济数据概览（仅保留排名信息）
router.get('/overview', auth, async (req, res) => {
  try {
    const leaderboard = await chipService.getLeaderboard('total_chips', req.user.id);

    res.json({
      success: true,
      data: {
        myRank: leaderboard ? leaderboard.userRank : null
      }
    });
  } catch (error) {
    console.error('获取经济数据概览失败:', error);
    res.status(500).json({
      success: false,
      message: '获取数据失败',
      error: error.message
    });
  }
});

module.exports = router;

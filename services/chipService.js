const User = require('../models/User');
const RoomBalance = require('../models/RoomBalance');
const ChipTransaction = require('../models/ChipTransaction');
const Leaderboard = require('../models/Leaderboard');
const mongoose = require('mongoose');

/**
 * 筹码管理服务
 * 处理总筹码与房间筹码之间的转移逻辑
 */
class ChipService {
  /**
   * 用户进入房间 - 从总筹码转移到房间筹码
   * @param {string} userId - 用户ID
   * @param {string} roomCode - 房间代码
   * @param {number} chipsToEnter - 要转入房间的筹码数量
   * @returns {Object} 操作结果
   */
  async enterRoom(userId, roomCode, chipsToEnter) {
    try {
      // 获取用户信息
      const user = await User.findById(userId);
      if (!user) {
        throw new Error('用户不存在');
      }
      
      // 验证筹码数量：允许 0（钱包余额为负时先空手进房，再通过补码继续）
      const amount = Number(chipsToEnter);
      if (!Number.isInteger(amount) || amount < 0) {
        throw new Error('转入筹码数量必须为非负整数');
      }
      
      if (amount > 0 && user.totalChips < amount) {
        throw new Error(`筹码余额不足，当前余额: ${user.totalChips}，需要: ${amount}`);
      }
      
      // 检查是否已在房间内
      const existingBalance = await RoomBalance.findOne({
        userId,
        roomCode,
        isActive: true
      });
      
      if (existingBalance) {
        throw new Error('用户已在该房间内');
      }
      
      // 先创建房间筹码记录：唯一索引冲突时不会动到总筹码
      const roomBalance = new RoomBalance({
        userId,
        roomCode,
        chips: amount,
        initialChips: amount
      });
      try {
        await roomBalance.save();
      } catch (error) {
        // 并发进入同一房间时唯一索引会报错，转成友好提示
        if (error.code === 11000) {
          throw new Error('用户已在该房间内');
        }
        throw error;
      }
      
      // 0 筹码进房：不扣钱包、也不产生 ROOM_ENTRY 流水（余额只在补码时变动）
      if (amount === 0) {
        return {
          success: true,
          totalChips: user.totalChips,
          roomChips: 0,
          roomBalanceId: roomBalance._id
        };
      }
      
      // 记录操作前余额并扣除总筹码
      const balanceBefore = user.totalChips;
      user.totalChips -= amount;
      try {
        await user.save();
      } catch (error) {
        // 扣款失败：撤销房间记录，保证账实一致
        await RoomBalance.deleteOne({ _id: roomBalance._id }).catch(() => {});
        throw error;
      }
      
      // 记录交易历史（失败则整体回滚，避免"钱动了没流水"）
      try {
        await ChipTransaction.createTransaction({
          userId,
          type: 'ROOM_ENTRY',
          amount: -amount,
          balanceBefore,
          balanceAfter: user.totalChips,
          roomCode,
          description: `进入房间 ${roomCode}`,
          metadata: { roomBalance: roomBalance._id }
        });
      } catch (error) {
        user.totalChips = balanceBefore;
        await user.save().catch(() => {});
        await RoomBalance.deleteOne({ _id: roomBalance._id }).catch(() => {});
        throw error;
      }
      
      return {
        success: true,
        totalChips: user.totalChips,
        roomChips: amount,
        roomBalanceId: roomBalance._id
      };
      
    } catch (error) {
      throw error;
    }
  }
  
  /**
   * 用户退出房间 - 从房间筹码转移回总筹码
   * @param {string} userId - 用户ID
   * @param {string} roomCode - 房间代码
   * @returns {Object} 操作结果
   */
  async exitRoom(userId, roomCode) {
    try {
      // 获取用户信息
      const user = await User.findById(userId);
      if (!user) {
        throw new Error('用户不存在');
      }
      
      // 获取房间筹码记录
      const roomBalance = await RoomBalance.findOne({
        userId,
        roomCode,
        isActive: true
      });
      
      if (!roomBalance) {
        throw new Error('用户不在该房间内');
      }
      
      const roomChips = roomBalance.chips;
      
      // 先原子地关闭房间记录：并发/重复调用时只有一个请求能成功退款
      const closed = await RoomBalance.findOneAndUpdate(
        { _id: roomBalance._id, isActive: true },
        {
          $set: {
            isActive: false,
            exitTime: new Date(),
            finalChips: roomChips
          }
        },
        { new: true }
      );
      
      if (!closed) {
        throw new Error('用户不在该房间内');
      }
      
      // 转回总筹码
      const balanceBefore = user.totalChips;
      user.totalChips += roomChips;
      try {
        await user.save();
      } catch (error) {
        // 退款失败则恢复房间记录，避免筹码被吞
        await RoomBalance.updateOne(
          { _id: roomBalance._id },
          { $set: { isActive: true, exitTime: null, finalChips: null } }
        ).catch(() => {});
        throw error;
      }
      
      const profitLoss = closed.calculateProfitLoss();
      
      // 交易流水失败不应阻塞退款（只记录错误）
      try {
        await ChipTransaction.createTransaction({
          userId,
          type: 'ROOM_EXIT',
          amount: roomChips,
          balanceBefore,
          balanceAfter: user.totalChips,
          roomCode,
          description: `退出房间 ${roomCode}`,
          metadata: {
            roomBalance: closed._id,
            profitLoss
          }
        });
      } catch (error) {
        console.error(`记录退房流水失败 room=${roomCode} user=${userId}:`, error.message);
      }
      
      return {
        success: true,
        totalChips: user.totalChips,
        roomChips: 0,
        transferredChips: roomChips,
        profitLoss
      };
      
    } catch (error) {
      throw error;
    }
  }
  
  /**
   * 更新房间内筹码数量（游戏过程中）
   * @param {string} userId - 用户ID
   * @param {string} roomCode - 房间代码
   * @param {number} newAmount - 新的筹码数量
   * @returns {Object} 操作结果
   */
  async updateRoomChips(userId, roomCode, newAmount) {
    try {
      if (newAmount < 0) {
        throw new Error('房间筹码不能为负数');
      }
      
      const roomBalance = await RoomBalance.findOne({
        userId,
        roomCode,
        isActive: true
      });
      
      if (!roomBalance) {
        throw new Error('用户不在该房间内');
      }
      
      const oldAmount = roomBalance.chips;
      await roomBalance.updateChips(newAmount);
      
      return {
        success: true,
        oldAmount,
        newAmount,
        change: newAmount - oldAmount
      };
      
    } catch (error) {
      throw error;
    }
  }
  
  /**
   * 牌局补码 - 从用户钱包扣除并计入房间筹码
   * 说明：输光后补码的钱从钱包扣除，允许钱包余额变为负数（欠款）；
   * 玩家离场时房间筹码转回总账户，用于抵扣欠款。
   * @param {string} userId - 用户ID
   * @param {string} roomCode - 房间代码
   * @param {number} amount - 补码数量
   * @returns {Object} 操作结果（含补码后的钱包余额）
   */
  async rebuyRoomChips(userId, roomCode, amount) {
    try {
      const value = Number(amount);
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error('补码数量必须为正整数');
      }

      const user = await User.findById(userId);
      if (!user) {
        throw new Error('用户不存在');
      }

      const roomBalance = await RoomBalance.findOne({
        userId,
        roomCode,
        isActive: true
      });

      if (!roomBalance) {
        throw new Error('用户不在该房间内');
      }

      const roomChipsBefore = roomBalance.chips;
      const walletBefore = user.totalChips;

      // 补码的钱从钱包扣除，允许透支为负数（欠款在离开房间时用房间筹码抵扣）
      user.totalChips = walletBefore - value;
      try {
        await user.save();
      } catch (error) {
        throw error;
      }

      roomBalance.chips = roomChipsBefore + value;
      try {
        await roomBalance.save();
      } catch (error) {
        // 房间余额写入失败：撤销钱包扣款
        user.totalChips = walletBefore;
        await user.save().catch(() => {});
        throw error;
      }

      // 记录补码流水；流水失败则钱包与房间筹码一起回滚，避免"钱动了没流水"
      try {
        await ChipTransaction.createTransaction({
          userId,
          type: 'REBUY',
          amount: value,
          balanceBefore: walletBefore,
          balanceAfter: user.totalChips,
          roomCode,
          description: `房间 ${roomCode} 补码 ${value}（从钱包扣除）`,
          metadata: {
            roomBalance: roomBalance._id,
            roomChipsBefore,
            roomChipsAfter: roomBalance.chips,
            walletBefore,
            walletAfter: user.totalChips,
            source: 'wallet'
          }
        });
      } catch (error) {
        roomBalance.chips = roomChipsBefore;
        await roomBalance.save().catch(() => {});
        user.totalChips = walletBefore;
        await user.save().catch(() => {});
        throw error;
      }

      return {
        success: true,
        amount: value,
        roomChips: roomBalance.chips,
        walletBalance: user.totalChips
      };

    } catch (error) {
      throw error;
    }
  }

  /**
   * 获取用户筹码状态
   * @param {string} userId - 用户ID
   * @param {string} roomCode - 房间代码（可选）
   * @returns {Object} 筹码状态
   */
  async getUserChipStatus(userId, roomCode = null) {
    try {
      const user = await User.findById(userId).select('username totalChips');
      if (!user) {
        throw new Error('用户不存在');
      }
      
      const result = {
        userId,
        username: user.username,
        totalChips: user.totalChips,
        roomChips: 0,
        isInRoom: false
      };
      
      if (roomCode) {
        const roomBalance = await RoomBalance.findOne({
          userId,
          roomCode,
          isActive: true
        });
        
        if (roomBalance) {
          result.roomChips = roomBalance.chips;
          result.isInRoom = true;
          result.roomBalanceId = roomBalance._id;
          result.entryTime = roomBalance.entryTime;
          result.initialChips = roomBalance.initialChips;
          result.currentProfitLoss = roomBalance.calculateProfitLoss();
        }
      }
      
      return result;
    } catch (error) {
      throw error;
    }
  }
  
  /**
   * 获取用户交易历史
   * @param {string} userId - 用户ID
   * @param {number} limit - 限制数量
   * @param {number} skip - 跳过数量
   * @returns {Array} 交易历史
   */
  async getUserTransactionHistory(userId, limit = 50, skip = 0) {
    try {
      return await ChipTransaction.getUserTransactions(userId, limit, skip);
    } catch (error) {
      throw error;
    }
  }
  
  /**
   * 获取用户统计数据
   * @param {string} userId - 用户ID
   * @param {number} days - 统计天数
   * @returns {Object} 统计数据
   */
  async getUserStats(userId, days = 30) {
    try {
      const stats = await ChipTransaction.getUserStats(userId, days);
      const user = await User.findById(userId).select('username totalChips createdAt');
      
      return {
        user: {
          username: user.username,
          totalChips: user.totalChips,
          memberSince: user.createdAt
        },
        period: `${days}天`,
        transactions: stats
      };
    } catch (error) {
      throw error;
    }
  }

  /**
   * 获取排行榜数据
   * @param {string} rankType - 排行榜类型
   * @param {string} userId - 用户ID（可选，用于获取用户排名）
   * @returns {Object} 排行榜数据
   */
  async getLeaderboard(rankType = 'total_chips', userId = null) {
    try {
      let leaderboard = await Leaderboard.findOne({ rankType });
      
      // 如果不存在或需要更新，则更新排行榜
      if (!leaderboard || leaderboard.needsUpdate()) {
        if (rankType === 'total_chips') {
          await Leaderboard.updateTotalChipsLeaderboard();
        } else if (rankType === 'win_rate') {
          await Leaderboard.updateWinRateLeaderboard();
        }
        
        leaderboard = await Leaderboard.findOne({ rankType });
      }
      
      const result = {
        rankType,
        data: leaderboard?.data || [],
        lastUpdated: leaderboard?.lastUpdated,
        userRank: null
      };
      
      // 获取用户排名
      if (userId && leaderboard) {
        result.userRank = leaderboard.getUserRank(userId);
        
        // 如果用户不在前10名，查询实际排名
        if (!result.userRank) {
          result.userRank = await this.getUserActualRank(userId, rankType);
        }
      }
      
      return result;
    } catch (error) {
      throw error;
    }
  }

  /**
   * 获取用户实际排名（不在前10名时）
   * @param {string} userId - 用户ID
   * @param {string} rankType - 排行榜类型
   * @returns {Object|null} 用户排名信息
   */
  async getUserActualRank(userId, rankType) {
    try {
      if (rankType === 'total_chips') {
        const user = await User.findById(userId).select('totalChips');
        if (!user) return null;
        
        const rank = await User.countDocuments({
          totalChips: { $gt: user.totalChips }
        }) + 1;
        
        return {
          rank,
          value: user.totalChips,
          inTopTen: false
        };
      }
      
      return null;
    } catch (error) {
      throw error;
    }
  }

  /**
   * 添加筹码（通用方法）
   * @param {string} userId - 用户ID
   * @param {number} amount - 筹码数量
   * @param {string} type - 交易类型
   * @param {string} description - 描述
   * @param {Object} metadata - 元数据
   * @returns {Object} 操作结果
   */
  async addChips(userId, amount, type, description, metadata = {}) {
    try {
      const value = Number(amount);
      if (!Number.isFinite(value) || !Number.isInteger(value) || value === 0) {
        throw new Error('筹码数量必须是非零整数');
      }
      
      const allowedTypes = [
        'REGISTER_BONUS',
        'ROOM_ENTRY',
        'ROOM_EXIT',
        'LEADERBOARD_REWARD',
        'ADMIN_ADJUST'
      ];
      if (!allowedTypes.includes(type)) {
        throw new Error(`未知的筹码交易类型: ${type}`);
      }
      
      const user = await User.findById(userId);
      if (!user) {
        throw new Error('用户不存在');
      }
      
      const balanceBefore = user.totalChips;
      if (value < 0 && balanceBefore < Math.abs(value)) {
        throw new Error('用户筹码余额不足');
      }
      
      user.totalChips += value;
      await user.save();
      
      // 记录交易；流水失败则回滚余额，避免"钱动了没流水"
      try {
        await ChipTransaction.create({
          userId,
          type,
          amount: value,
          balanceBefore,
          balanceAfter: user.totalChips,
          description,
          metadata
        });
      } catch (error) {
        user.totalChips = balanceBefore;
        await user.save().catch(() => {});
        throw error;
      }
      
      return {
        success: true,
        newBalance: user.totalChips,
        amount: value
      };
    } catch (error) {
      throw error;
    }
  }
}

module.exports = new ChipService();
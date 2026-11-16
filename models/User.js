const mongoose = require('mongoose');

/**
 * 用户模型
 * 仅用用户名标识玩家（局域网游戏，无需密码/邮箱），记录总筹码余额
 */
const UserSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    minlength: 2,
    maxlength: 20
  },
  totalChips: {
    type: Number,
    default: 1000 // 默认初始筹码；允许为负数（补码从钱包扣除，形成欠款）
  },
  avatar: {
    type: String,
    default: '/default-avatar.png'
  },
  isAdmin: {
    type: Boolean,
    default: false
  },
  lastLogin: {
    type: Date,
    default: Date.now
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// 添加筹码方法
UserSchema.methods.addChips = async function(amount) {
  if (amount <= 0) throw new Error('筹码数量必须为正数');
  
  this.totalChips += amount;
  return await this.save();
};

// 扣除筹码方法（允许透支为负数：牌局补码从钱包扣除，离场时再用房间筹码补回）
UserSchema.methods.deductChips = async function(amount) {
  if (amount <= 0) throw new Error('筹码数量必须为正数');
  
  this.totalChips -= amount;
  return await this.save();
};

module.exports = mongoose.model('User', UserSchema);

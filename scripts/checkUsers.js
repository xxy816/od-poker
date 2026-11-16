const mongoose = require('mongoose');
const User = require('../models/User');
const database = require('../config/database');

/**
 * 查询数据库中所有用户账户
 */
async function checkAllUsers() {
  try {
    console.log('正在查询数据库中的所有用户账户...');
    
    // 连接数据库
    await database.connect();
    console.log('数据库连接成功');
    
    // 查询所有用户
    const users = await User.find({}, 'username totalChips isAdmin createdAt');
    
    console.log('\n=== 数据库中的所有用户账户 ===');
    
    if (users.length === 0) {
      console.log('❌ 数据库中没有任何用户账户');
    } else {
      console.log(`📊 共找到 ${users.length} 个用户账户:\n`);
      
      users.forEach((user, index) => {
        const adminFlag = user.isAdmin ? ' [管理员]' : '';
        const createDate = user.createdAt ? user.createdAt.toLocaleString('zh-CN') : '未知';
        
        console.log(`${index + 1}. 👤 ${user.username}`);
        console.log(`   💰 筹码: ${user.totalChips}${adminFlag}`);
        console.log(`   📅 创建时间: ${createDate}`);
        console.log('');
      });
    }
    
  } catch (error) {
    console.error('❌ 查询失败:', error);
    throw error;
  } finally {
    await database.disconnect();
    console.log('数据库连接已断开');
  }
}

// 执行查询
if (require.main === module) {
  checkAllUsers()
    .then(() => {
      console.log('✅ 查询完成');
      process.exit(0);
    })
    .catch((error) => {
      console.error('❌ 查询失败:', error);
      process.exit(1);
    });
}

module.exports = checkAllUsers;

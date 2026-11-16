const User = require('../models/User');
const RoomBalance = require('../models/RoomBalance');
const database = require('../config/database');

/**
 * 数据库索引迁移脚本
 *
 * 1) users：删除已废弃字段（email / password）上的唯一索引。
 *    用户模型现在只用 username 登录，旧库残留的 email 唯一索引会让
 *    "没有 email 的新用户"互相冲突（唯一索引把缺失字段视为 null）。
 * 2) roombalances：删除旧的 (userId, roomCode, isActive) 唯一索引，
 *    它会把历史记录（isActive:false）也算进唯一约束，导致同一用户
 *    退出后再次进入同一房间时写入失败。改用 partial unique index。
 *
 * 用法：npm run migrate-db
 */
async function dropIndexesByPredicate(model, predicate) {
  const indexes = await model.collection.indexes();
  let dropped = 0;

  for (const index of indexes) {
    if (!index.name || index.name === '_id_') continue;
    if (!predicate(index)) continue;

    console.log(`删除索引 ${model.modelName}.${index.name} (${JSON.stringify(index.key)})`);
    await model.collection.dropIndex(index.name);
    dropped++;
  }

  return dropped;
}

async function migrate() {
  try {
    await database.connect();

    // users：只允许 _id / username 相关索引
    const usersDropped = await dropIndexesByPredicate(User, (index) =>
      Object.keys(index.key).some((field) => !['_id', 'username'].includes(field))
    );

    // roombalances：删除包含 isActive 的旧唯一索引
    const balanceDropped = await dropIndexesByPredicate(RoomBalance, (index) =>
      Object.keys(index.key).includes('isActive')
    );

    // 按当前 schema 补齐索引（含新的 partial unique index）
    await User.createIndexes();
    await RoomBalance.createIndexes();

    console.log(`索引迁移完成：users 删除 ${usersDropped} 个，roombalances 删除 ${balanceDropped} 个`);
    console.log('当前 roombalances 索引:');
    for (const index of await RoomBalance.collection.indexes()) {
      console.log(`  - ${index.name} ${JSON.stringify(index.key)}${index.unique ? ' unique' : ''}${index.partialFilterExpression ? ' partial' : ''}`);
    }
  } catch (error) {
    console.error('索引迁移失败:', error);
    throw error;
  } finally {
    await database.disconnect();
  }
}

if (require.main === module) {
  migrate()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

module.exports = migrate;

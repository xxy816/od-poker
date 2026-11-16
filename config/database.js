const mongoose = require('mongoose');

/**
 * 数据库连接配置
 */
class Database {
  constructor() {
    this.connection = null;
  }

  /**
   * 连接到MongoDB数据库
   * @param {string} uri - 数据库连接字符串
   */
  async connect(uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/poker_game') {
    try {
      const options = {
        maxPoolSize: 10, // 连接池最大连接数
        serverSelectionTimeoutMS: 3000, // 服务器选择超时
        socketTimeoutMS: 45000, // Socket超时
        bufferCommands: false // 禁用mongoose缓冲命令
      };

      this.connection = await mongoose.connect(uri, options);
      
      console.log('✅ MongoDB连接成功');
      console.log(`📍 数据库: ${this.connection.connection.name}`);
      console.log(`🌐 主机: ${this.connection.connection.host}:${this.connection.connection.port}`);
      
      // 监听连接事件
      this.setupEventListeners();
      
      return this.connection;
    } catch (error) {
      console.error('❌ MongoDB连接失败:', error.message);
      throw error;
    }
  }

  /**
   * 设置数据库事件监听器
   */
  setupEventListeners() {
    const db = mongoose.connection;

    db.on('error', (error) => {
      console.error('❌ MongoDB连接错误:', error);
    });

    db.on('disconnected', () => {
      console.warn('⚠️ MongoDB连接断开');
    });

    db.on('reconnected', () => {
      console.log('🔄 MongoDB重新连接成功');
    });

    // 优雅关闭
    process.on('SIGINT', async () => {
      await this.disconnect();
      process.exit(0);
    });
  }

  /**
   * 断开数据库连接
   */
  async disconnect() {
    try {
      await mongoose.connection.close();
      console.log('🔌 MongoDB连接已关闭');
    } catch (error) {
      console.error('❌ 关闭MongoDB连接时出错:', error);
    }
  }

  /**
   * 获取连接状态
   */
  getConnectionStatus() {
    const states = {
      0: 'disconnected',
      1: 'connected',
      2: 'connecting',
      3: 'disconnecting'
    };
    
    return {
      state: states[mongoose.connection.readyState],
      host: mongoose.connection.host,
      port: mongoose.connection.port,
      name: mongoose.connection.name
    };
  }

  /**
   * 健康检查
   */
  async healthCheck() {
    try {
      await mongoose.connection.db.admin().ping();
      return { status: 'healthy', timestamp: new Date() };
    } catch (error) {
      return { status: 'unhealthy', error: error.message, timestamp: new Date() };
    }
  }
}

module.exports = new Database();
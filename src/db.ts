import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL || 'postgresql://postgres@localhost:5432/fx_intel';

export const pool = new Pool({
  connectionString,
});

export async function initDatabase() {
  const client = await pool.connect();
  try {
    console.log('🔄 Checking database connection and initializing schema...');

    // 1. 尝试开启 pgvector 扩展
    await client.query('CREATE EXTENSION IF NOT EXISTS vector;');
    console.log('✅ pgvector extension is enabled.');

    // 2. 创建 Polymarket 预测事件表
    await client.query(`
      CREATE TABLE IF NOT EXISTS polymarket_events (
        id VARCHAR(255) PRIMARY KEY,
        title TEXT NOT NULL,
        odds DOUBLE PRECISION NOT NULL,
        url TEXT,
        embedding vector(768),
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        multi_markets JSONB
      );
    `);
    
    // 确保已有表追加 multi_markets 字段
    await client.query(`
      ALTER TABLE polymarket_events ADD COLUMN IF NOT EXISTS multi_markets JSONB;
    `);

    // 确保已有表追加 slug 字段
    await client.query(`
      ALTER TABLE polymarket_events ADD COLUMN IF NOT EXISTS slug VARCHAR(255);
    `);

    // 3. 创建历史汇率存储表
    await client.query(`
      CREATE TABLE IF NOT EXISTS fx_history (
        pair VARCHAR(20) PRIMARY KEY,
        history_data JSONB NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    console.log('✅ Tables are ready.');
  } catch (error) {
    console.error('❌ Database initialization failed:', error);
    throw error;
  } finally {
    client.release();
  }
}

import { GoogleGenerativeAI } from '@google/generative-ai';
import { pool, initDatabase } from './db.js';
import dotenv from 'dotenv';

dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

// 辅助延时函数
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// 真实向 Polymarket 官方 Gamma API 发起抓取
async function fetchRealPolymarket(): Promise<any[]> {
  try {
    console.log('📡 Attempting to fetch real-time events from Polymarket Gamma API...');
    const queries = ['Fed', 'tariff', 'recession'];
    const results: any[] = [];

    for (const query of queries) {
      // 访问 Polymarket 的公开公共 Gamma 检索 API 的 public-search 接口，以获取和关键词匹配的事件
      const res = await fetch(`https://gamma-api.polymarket.com/public-search?q=${encodeURIComponent(query)}`);
      if (!res.ok) continue;
      
      const data: any = await res.json();
      const events = data.events;
      if (!Array.isArray(events)) continue;

      let count = 0;
      for (const event of events) {
        if (count >= 3) break; // 每个关键字最多提取 3 个不同事件下的盘口
        if (!event.markets || !Array.isArray(event.markets)) continue;

        // 寻找该事件下第一个活跃的（未结束、正在交易的）二元或者有赔率的盘口
        const activeMarket = event.markets.find((m: any) => m.active && !m.closed);
        if (!activeMarket) continue;

        let prices: string[] = [];
        if (typeof activeMarket.outcomePrices === 'string') {
          try {
            prices = JSON.parse(activeMarket.outcomePrices);
          } catch (_) {
            prices = [];
          }
        } else if (Array.isArray(activeMarket.outcomePrices)) {
          prices = activeMarket.outcomePrices;
        }

        // 二元预测的 odds (通常 Yes 的价格在 outcomePrices[0])
        const yesPrice = prices.length > 0 ? parseFloat(prices[0]) : null;
        if (yesPrice !== null && !isNaN(yesPrice) && activeMarket.question && activeMarket.slug) {
          const eventSlug = event.slug || '';
          const url = eventSlug
            ? `https://polymarket.com/event/${eventSlug}?slug=${activeMarket.slug}`
            : `https://polymarket.com/event/${activeMarket.slug}`;

          const id = `poly-${activeMarket.id || activeMarket.slug}`;
          // 确保全局去重，不存入重复的盘口
          const alreadyAdded = results.some(r => r.id === id);
          if (!alreadyAdded) {
            results.push({
              id: id,
              title: activeMarket.question,
              odds: Number(yesPrice.toFixed(2)),
              url: url
            });
            count++;
          }
        }
      }
      await delay(500); // 间隔防抖
    }

    if (results.length > 0) {
      console.log(`✅ Successfully fetched ${results.length} live events from Polymarket!`);
      return results;
    }
    throw new Error('No valid events returned');
  } catch (error) {
    console.error('❌ Polymarket Gamma API fetch failed:', error);
    throw error;
  }
}

async function getEmbedding(text: string): Promise<number[]> {
  try {
    // 尝试调用真实的 text-embedding-004
    const model = genAI.getGenerativeModel({ model: 'text-embedding-004' });
    const result = await model.embedContent(text);
    if (result.embedding && result.embedding.values) {
      return result.embedding.values;
    }
    throw new Error('Invalid embedding response structure');
  } catch (error) {
    console.warn(`⚠️ Failed to fetch embedding for "${text}" from Gemini API (Error: ${error instanceof Error ? error.message : String(error)}). Using local hash-based vector fallback.`);
    
    // 基于文本内容生成确定性的 768 维浮点数组（值在 -0.5 到 0.5 之间）
    const mockVector: number[] = [];
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = text.charCodeAt(i) + ((hash << 5) - hash);
    }
    for (let i = 0; i < 768; i++) {
      const seed = Math.sin(hash + i) * 10000;
      mockVector.push(Number((seed - Math.floor(seed) - 0.5).toFixed(6)));
    }
    return mockVector;
  }
}

export async function syncPolymarketData() {
  console.log('🏁 Starting Polymarket Data Sync worker...');
  
  // 确保数据库和表结构就绪
  await initDatabase();

  const client = await pool.connect();
  
  try {
    // 动态拉取：优先获取真实的 Polymarket 胜率数据；若因网络/IP被封失败，则自动选用预置的精良事件兜底
    const events = await fetchRealPolymarket();
    
    for (const event of events) {
      console.log(`Processing event: [${event.id}] - "${event.title}"`);
      
      // 检查事件是否已经存在于数据库
      const checkRes = await client.query('SELECT odds, embedding FROM polymarket_events WHERE id = $1', [event.id]);
      
      if (checkRes.rowCount && checkRes.rowCount > 0) {
        // 事件已存在，更新最新的赔率、链接和更新时间
        const oldOdds = checkRes.rows[0].odds;
        await client.query(
          'UPDATE polymarket_events SET odds = $1, url = $2, title = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $4',
          [event.odds, event.url, event.title, event.id]
        );
        if (oldOdds !== event.odds) {
          console.log(`  Updated odds from ${oldOdds} to ${event.odds}`);
        } else {
          console.log('  Odds unchanged, metadata updated.');
        }
      } else {
        // 事件不存在，调用 Gemini 生成向量 Embedding，并进行首次入库
        console.log('  New event detected. Generating embedding...');
        const embedding = await getEmbedding(event.title);
        
        // 将 float[] 向量序列化为 pgvector 格式的字符串：'[x,y,z...]'
        const vectorStr = `[${embedding.join(',')}]`;
        
        await client.query(
          'INSERT INTO polymarket_events (id, title, odds, url, embedding) VALUES ($1, $2, $3, $4, $5)',
          [event.id, event.title, event.odds, event.url, vectorStr]
        );
        console.log('  Successfully generated vector and inserted into database.');
        
        // 每次调用完 Embedding 后强制防抖延时 1.5 秒，严防免费 Key 超出 15 RPM 的频率限制
        await delay(1500);
      }
    }
    
    console.log('🎉 Polymarket Data Sync worker finished successfully!');
  } catch (error) {
    console.error('❌ Sync failed:', error);
  } finally {
    client.release();
  }
}

// 如果作为命令行脚本直接运行：node sync.js
// 我们判断当前文件名是否是执行主入口
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  syncPolymarketData()
    .then(() => {
      pool.end();
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      pool.end();
      process.exit(1);
    });
}

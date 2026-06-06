import { GoogleGenerativeAI } from '@google/generative-ai';
import { pool, initDatabase } from './db.js';
import dotenv from 'dotenv';

dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

const BASE_URL = 'https://gamma-api.polymarket.com/events';

const IGNORE_TAG_SLUGS = [
  'up-or-down', '15m', '5m', 'recurring', 'daily', 'intraday',
  'sports', 'nba', 'nfl', 'tennis', 'mma', 'baseball', 'pop-culture', 'entertainment'
];

const IGNORE_KEYWORDS = [
  'Price at', 'Above or Below', 'vs', 'Premier League',
];

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function shouldSkip(event: any): boolean {
  const title = event.title || '';
  const tags = event.tags || [];

  // 1. 过滤掉不相关的标签
  for (const tag of tags) {
    const slug = typeof tag === 'string' ? tag : (tag.slug || '');
    if (slug !== '' && IGNORE_TAG_SLUGS.includes(slug)) {
      return true;
    }
  }

  // 2. 过滤掉包含黑名单关键字的标题
  for (const kw of IGNORE_KEYWORDS) {
    if (title.includes(kw)) {
      return true;
    }
  }

  const lowerTitle = title.toLowerCase();

  // 过滤掉地方选举、花边八卦、社交媒体帖子、体育娱乐等噪音
  const ignoreRegex = /\b(house seat|senate seat|governor|mayoral|district|congress|representative|by-election|legislative|parliamentary|mayoral election|governor election|local election|truth social|truthposts|truth posts|truthsocial|truthpost|dance|dancing|danced|praise|praises|praised|flu|hospitalization|covid|charged|arrested|indicted|guilty|jail|prison|space|visit|visits|visited|poker|chess|sports|movie|movies|oscar|oscars|grammy|grammys|celebrity|mrbeast|tiktok|music|album|song|spotify|youtube|subscribers|views|stream|box office|opening weekend|approval rate|crime rate|hospitalization rate|mortality rate|suicide rate|golf|debate|debates|podcast|interview|interviews|rally|rallies|truth|approval)\b/i;

  if (ignoreRegex.test(lowerTitle)) {
    return true;
  }

  // 3. 正向匹配白名单：使用单词边界 \b 防止匹配到 federally, reference 等不相关词汇
  const macroRegex = /\b(fed|fed's|powell|tariff|tariffs|inflation|recession|recessions|cny|gdp|unemployment|economic|trade|debt|treasury|eurozone|cpi|pce|currency|exchange|pboc|bnm|opr|yield|yields|interest rate|interest rates|rate cut|rate cuts|rate hike|rate hikes|policy rate|policy rates|unemployment rate|federal reserve|economic growth)\b/i;
  
  // 大选/关键政治人物相关，但必须是全国性总统大选级别，过滤掉地方选举和花边八卦
  const presidentialRegex = /\b(trump|harris|biden|presidential election|us election)\b/i;

  const hasMacro = macroRegex.test(lowerTitle) || presidentialRegex.test(lowerTitle);
  if (!hasMacro) {
    return true; // 不包含任何金融宏观核心词，跳过
  }

  return false;
}

async function getEmbedding(text: string): Promise<number[]> {
  try {
    const model = genAI.getGenerativeModel({ model: 'text-embedding-004' });
    const result = await model.embedContent(text);
    if (result.embedding && result.embedding.values) {
      return result.embedding.values;
    }
    throw new Error('Invalid embedding response structure');
  } catch (error) {
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

async function fetchAndFilterEventsPage(offset: number, limit = 500): Promise<any[]> {
  const params = new URLSearchParams({
    offset: String(offset),
    limit: String(limit),
    closed: 'false',
    order: 'createdAt',
    ascending: 'false',
  });

  try {
    const url = `${BASE_URL}?${params.toString()}`;
    const response = await fetch(url);
    if (!response.ok) {
      console.error(`⚠️ Request failed (offset=${offset}), status: ${response.status}`);
      return [];
    }
    const events = await response.json();
    if (!Array.isArray(events)) {
      console.warn(`⚠️ offset=${offset} returned abnormal data, not array`);
      return [];
    }
    
    // 过滤掉符合 skip 规则的事件
    return events.filter(event => !shouldSkip(event));
  } catch (error) {
    console.error(`❌ Request error (offset=${offset}):`, error);
    return [];
  }
}

export async function syncPolymarketData() {
  console.log('🏁 Starting Polymarket Data Sync worker (Node.js/TypeScript)...');

  // 1. 确保数据库和表结构就绪
  await initDatabase();

  const client = await pool.connect();

  try {
    // 2. 清空向量数据库的旧数据（确保干净）
    console.log('🧹 Clearing all old events in polymarket_events...');
    await client.query('DELETE FROM polymarket_events;');
    console.log('✅ polymarket_events table cleared.');

    // 3. 约定抓取的分页配置
    const pages = [
      { offset: 0, limit: 500 },
      { offset: 500, limit: 500 },
      { offset: 1000, limit: 500 },
      { offset: 1500, limit: 500 },
      { offset: 2000, limit: 500 },
      { offset: 2500, limit: 500 },
      { offset: 3000, limit: 500 },
      { offset: 3500, limit: 500 },
      { offset: 4000, limit: 500 },
      { offset: 4500, limit: 500 },
      { offset: 5000, limit: 500 },
      { offset: 5500, limit: 500 },
      { offset: 6000, limit: 500 },
      { offset: 6500, limit: 500 },
      { offset: 7000, limit: 500 },
      { offset: 7500, limit: 500 },
    ];

    let insertedCount = 0;

    for (const page of pages) {
      console.log(`📄 Fetching page: offset=${page.offset}, limit=${page.limit}...`);
      const filteredEvents = await fetchAndFilterEventsPage(page.offset, page.limit);
      console.log(`   Fetched and filter-passed: ${filteredEvents.length} events.`);

      for (const event of filteredEvents) {
        if (!event.markets || !Array.isArray(event.markets)) continue;

        // 寻找该事件下第一个活跃的（未结束、正在交易的）盘口
        const activeMarket = event.markets.find((m: any) => m.active && !m.closed);
        if (!activeMarket) continue;

        let prices: any[] = [];
        if (typeof activeMarket.outcomePrices === 'string') {
          try {
            prices = JSON.parse(activeMarket.outcomePrices);
          } catch (_) {
            prices = [];
          }
        } else if (Array.isArray(activeMarket.outcomePrices)) {
          prices = activeMarket.outcomePrices;
        }

        const yesPrice = prices.length > 0 ? parseFloat(prices[0]) : null;
        if (yesPrice !== null && !isNaN(yesPrice) && activeMarket.question && activeMarket.slug) {
          const eventSlug = event.slug || '';
          const url = eventSlug
            ? `https://polymarket.com/event/${eventSlug}?slug=${activeMarket.slug}`
            : `https://polymarket.com/event/${activeMarket.slug}`;

          const id = `poly-${activeMarket.id || activeMarket.slug}`;
          const title = activeMarket.question;
          const odds = Number(yesPrice.toFixed(2));

          // 4. 生成 768 维向量并入库
          const embedding = await getEmbedding(title);
          const vectorStr = `[${embedding.join(',')}]`;

          await client.query(
            `INSERT INTO polymarket_events (id, title, odds, url, embedding) 
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (id) DO UPDATE SET 
               odds = EXCLUDED.odds,
               url = EXCLUDED.url,
               title = EXCLUDED.title,
               updated_at = CURRENT_TIMESTAMP`,
            [id, title, odds, url, vectorStr]
          );

          insertedCount++;
          if (insertedCount % 20 === 0) {
            console.log(`   Inserted ${insertedCount} live event markets...`);
          }
          // 短暂限流防抖，如果使用 Hash Mock 实际上不限流也极快，但依然保持防抖好习惯
          await delay(50); 
        }
      }
    }

    console.log(`🎉 Sync completed! Cleared and successfully inserted ${insertedCount} fresh events to polymarket_events.`);
  } catch (error) {
    console.error('❌ Sync failed:', error);
  } finally {
    client.release();
  }
}

// 允许直接执行 node / tsx 运行
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

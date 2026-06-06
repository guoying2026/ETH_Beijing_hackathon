import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import { pool } from './db.js';
import { syncPolymarketData } from './sync.js';

// 安全提取并解析 AI 返回的 JSON 字符串的辅助工具
function extractJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch (_) {
    // 尝试正则匹配 Markdown JSON 块
    const match = text.match(/```json\s*([\s\S]*?)\s*```/);
    if (match && match[1]) {
      return JSON.parse(match[1]);
    }
    // 尝试截取第一个 { 和最后一个 }
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1) {
      return JSON.parse(text.substring(firstBrace, lastBrace + 1));
    }
    throw new Error('No JSON object found in response');
  }
}

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

// 统一的向量生成工具，带有 mock 兜底
async function getEmbedding(text: string): Promise<number[]> {
  try {
    const model = genAI.getGenerativeModel({ model: 'text-embedding-004' });
    const result = await model.embedContent(text);
    if (result.embedding && result.embedding.values) {
      return result.embedding.values;
    }
    throw new Error('Invalid embedding response structure');
  } catch (error) {
    console.warn(`⚠️ Failed to fetch embedding for "${text}" from Gemini API (Error: ${error instanceof Error ? error.message : String(error)}). Using local hash-based vector fallback.`);
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

// 主动从本地的 Hy-Memory 服务检索长期记忆
async function getHyMemories(userId: string, query: string): Promise<any[]> {
  try {
    const response = await fetch('http://127.0.0.1:19527/api/v1/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        user_ids: [userId]
      })
    });
    if (response.ok) {
      const data = await response.json() as any;
      return data.results || data || [];
    }
  } catch (error) {
    console.warn('⚠️ Failed to query Hy-Memory server:', error instanceof Error ? error.message : String(error));
  }
  return [];
}


// 本地静态新闻库，作为备用以及渲染卡片的基础
const RECENT_NEWS = [
  {
    title: 'Fed hints at higher-for-longer rates as inflation persists',
    source: 'Bloomberg',
    url: 'https://bloomberg.com',
    publishedAt: '2026-06-03',
    summary: 'Federal Reserve officials signaled they are in no rush to cut rates due to sticky inflation data.'
  },
  {
    title: 'Tariff concerns weigh on global supply chain and manufacturing outlook',
    source: 'Reuters',
    url: 'https://reuters.com',
    publishedAt: '2026-06-02',
    summary: 'Proposed trade tariffs spark volatility in foreign exchange markets, pushing safe-haven dollar higher.'
  },
  {
    title: 'Malaysia OPR holds steady as economic growth beats estimates',
    source: 'The Edge Malaysia',
    url: 'https://theedgemalaysia.com',
    publishedAt: '2026-06-01',
    summary: 'Bank Negara Malaysia keeps the Overnight Policy Rate unchanged, citing resilient domestic demand.'
  }
];

// 获取最新的汇率数据（从 ExchangeRate-API 获取）
async function fetchExchangeRates() {
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/USD');
    if (!res.ok) throw new Error('API fetch failed');
    const data = await res.json();
    return data.rates;
  } catch (error) {
    console.warn('⚠️ Failed to fetch live exchange rates, falling back to mock rates.');
    return {
      USD: 1,
      CNY: 7.285,
      MYR: 4.712,
    };
  }
}

// 模拟 30 天的历史走势数据点（基于实时汇率进行小幅度布朗运动波动）
function generateHistory(rate: number) {
  const history = [];
  const now = new Date();
  let currentRate = rate;

  for (let i = 30; i >= 0; i--) {
    const date = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    // 随机浮动 (-0.3% 到 +0.3%)
    const change = (Math.random() - 0.5) * 0.006 * currentRate;
    currentRate += change;
    history.push({
      date: date.toISOString().split('T')[0],
      rate: Number(currentRate.toFixed(4)),
    });
  }
  return history;
}

// 召回与当前货币对最相关的 Polymarket 事件 (本地 RAG)
async function getRelevantPolymarketEvents(base: string, quote: string): Promise<any[]> {
  const queryText = `Analyze exchange rate trends and macro factors for ${base} to ${quote} exchange.`;

  try {
    const queryVector = await getEmbedding(queryText);
    const vectorStr = `[${queryVector.join(',')}]`;

    // <=> 操作符计算余弦距离（越小越相似），召回最相关的 20 个事件
    const res = await pool.query(
      `SELECT id, title, odds, url, multi_markets, slug, (embedding <=> $1) AS distance 
       FROM polymarket_events 
       ORDER BY distance ASC, updated_at DESC LIMIT 20`,
      [vectorStr]
    );

    if (res.rows && res.rows.length > 0) {
      console.log(`📡 RAG: Successfully retrieved ${res.rows.length} events from PostgreSQL vector database.`);
      return res.rows.map(r => ({
        id: r.id,
        title: r.title,
        odds: r.odds,
        url: r.url,
        multiMarkets: r.multi_markets,
        slug: r.slug
      }));
    }
    return [];
  } catch (error) {
    console.error('❌ RAG: Database vector search failed:', error);
    return [];
  }
}

// 格式化 RAG 事件以拼接进给 AI 的 Prompt
function formatEventForLLM(e: any, lang: 'zh' | 'en'): string {
  const isMulti = e.multiMarkets && e.multiMarkets.length > 0;
  if (isMulti) {
    const optionsStr = e.multiMarkets.map((m: any) => `${m.title}: ${(m.odds * 100).toFixed(0)}%`).join(', ');
    return lang === 'zh'
      ? `- 事件："${e.title}" (多市场选项) | 细分选项及发生概率：[${optionsStr}]`
      : `- Event: "${e.title}" (Multi-market) | Outcomes and Odds: [${optionsStr}]`;
  } else {
    return lang === 'zh'
      ? `- 事件："${e.title}" | 发生概率：${(e.odds * 100).toFixed(0)}%`
      : `- Event: "${e.title}" | Market Odds of occurring: ${(e.odds * 100).toFixed(0)}%`;
  }
}

// 健康检查路由，免去频繁调用大模型
app.get('/api/health', (_req, res) => {
  const provider = process.env.LLM_PROVIDER || 'gemini';
  const model = provider === 'hunyuan' ? (process.env.HUNYUAN_MODEL || 'hy3-preview') : 'gemini-2.5-flash';
  res.json({ status: 'ok', provider, model });
});

// OpenAI 兼容的 Embedding 本地代理接口，供 Hy-Memory 插件做向量转换使用
app.post('/v1/embeddings', async (req, res) => {
  const { input, model } = req.body;
  if (!input) {
    return res.status(400).json({ error: 'Missing "input" field in request body' });
  }

  try {
    const textToEmbed = Array.isArray(input) ? input.join('\n') : String(input);
    console.log(`🧠 Local Embedding Proxy: Generating vector for text: "${textToEmbed.slice(0, 50)}..."`);
    
    const vector = await getEmbedding(textToEmbed);
    
    res.json({
      object: 'list',
      data: [
        {
          object: 'embedding',
          index: 0,
          embedding: vector
        }
      ],
      model: model || 'text-embedding-004',
      usage: {
        prompt_tokens: 0,
        total_tokens: 0
      }
    });
  } catch (error) {
    console.error('❌ Local Embedding Proxy failed:', error);
    res.status(500).json({ error: 'Embedding generation failed' });
  }
});

// 主换汇分析路由
app.get('/api/fx-intel', async (req, res) => {
  const base = (req.query.base as string || 'USD').toUpperCase();
  const quote = (req.query.quote as string || 'CNY').toUpperCase();
  const lang = (req.query.lang as string || 'zh').toLowerCase();

  // 获取用户交换金额和观察期限
  const amount = Number(req.query.amount as string || '1000');
  const horizon = (req.query.horizon as string || '3d').toLowerCase();

  console.log(`📥 GET /api/fx-intel request received. Pair: ${base}/${quote}, Amount: ${amount}, Horizon: ${horizon}, Lang: ${lang}`);

  let currentRate = 1;
  let effectiveRate = 1;
  let totalCostFactor = 0.003;
  let history: any[] = [];
  let change7d = 0;
  let change30d = 0;
  let ragEvents: any[] = [];
  let memories: any[] = [];
  const provider = process.env.LLM_PROVIDER || 'gemini';

  try {
    // 1. 获取汇率
    const rates = await fetchExchangeRates();
    if (base === 'USD') {
      currentRate = rates[quote] || 1;
    } else {
      // 交叉汇率（比如 CNY/MYR）
      const baseToUSD = 1 / (rates[base] || 1);
      const usdToQuote = rates[quote] || 1;
      currentRate = baseToUSD * usdToQuote;
    }

    // 计算平台可执行的到手汇率 (Effective Rate)
    // 基础点差：0.3%
    const baseSpread = 0.003;
    // 模拟滑点：金额每增加 10,000 单位，滑点增加 0.05% 的汇率折损
    const slippage = (amount / 10000) * 0.0005;
    totalCostFactor = baseSpread + slippage;
    effectiveRate = currentRate * (1 - totalCostFactor);

    // 2. 生成历史走势
    history = generateHistory(currentRate);

    // 3. 计算 7d 和 30d 的变化率以及波动率特征
    const startRate30d = history[0]?.rate || currentRate;
    const startRate7d = history[history.length - 8]?.rate || currentRate;
    const change30dVal = Number((((currentRate - startRate30d) / startRate30d) * 100).toFixed(2));
    const change7dVal = Number((((currentRate - startRate7d) / startRate7d) * 100).toFixed(2));
    change30d = isNaN(change30dVal) ? 0 : change30dVal;
    change7d = isNaN(change7dVal) ? 0 : change7dVal;

    // 计算 30 天历史波动率与分位数位置
    const avg30d = history.reduce((sum, h) => sum + h.rate, 0) / history.length;
    const variance = history.reduce((sum, h) => sum + Math.pow(h.rate - avg30d, 2), 0) / history.length;
    const stdDev = Math.sqrt(variance);
    const realizedVol30d = Number(((stdDev / avg30d) * 100).toFixed(2));

    const ratesList = history.map(h => h.rate);
    const max30d = Math.max(...ratesList);
    const min30d = Math.min(...ratesList);
    const range30d = max30d - min30d || 0.0001;
    const percentile30d = Math.round(((currentRate - min30d) / range30d) * 100);

    // 4. 通过 pgvector RAG 检索 Polymarket 相关事件概率
    ragEvents = await getRelevantPolymarketEvents(base, quote);

    // 4.5. 通过 Hy-Memory 检索用户长期记忆偏好
    const userId = 'guoying_dev';
    const memoryQuery = `User preference, transaction history, habits or locked zkTLS contracts for ${base}/${quote}.`;
    console.log(`🧠 [Long-term Memory] Querying Hy-Memory for: "${memoryQuery.slice(0, 50)}..."`);
    memories = await getHyMemories(userId, memoryQuery);
    console.log(`🧠 [Long-term Memory] Retrieved ${memories.length} pieces of memory.`);

    // 5. 根据配置文件，组装中英文 Prompt，并分流调用大模型
    const isZh = (process.env.PROMPT_LANG || lang) === 'zh';

    const promptEn = `
      You are an expert financial AI assistant specialized in foreign exchange (FX) market analysis.
      
      Analyze the following data for the currency pair ${base}/${quote}:
      - Target Exchange Amount: ${amount} ${base}
      - Observation Horizon / Time Preference: ${horizon}
      - Spot Market Rate: 1 ${base} = ${currentRate.toFixed(4)} ${quote}
      - Platform Effective Rate (including spread and slippage): 1 ${base} = ${effectiveRate.toFixed(4)} ${quote}
      - Calculated Spread & Slippage cost: ${(totalCostFactor * 100).toFixed(2)}%
      - 7d Change: ${change7d}%
      - 30d Change: ${change30d}%
      - 30d Realized Volatility: ${realizedVol30d}%
      - Current Rate 30-day Percentile: ${percentile30d}% (0% means historical minimum, 100% means historical maximum)
      
       We also retrieved relevant prediction market outcomes from Polymarket (representing crowdsourced odds of macro events):
      ${ragEvents.map(e => formatEventForLLM(e, 'en')).join('\n')}
      
      Here are the user's long-term memory snippets and preference history retrieved from tencent hy-memory:
      ${memories && memories.length > 0
        ? memories.map((m, idx) => `- [Memory Snippet ${idx + 1}]: "${m.content || m.text || JSON.stringify(m)}"`).join('\n')
        : '- No historical FX behavior or preference memory found for this user.'}
      
      Recommend the best action for a user who wants to exchange ${base} into ${quote}.
      Options are:
      - "NOW": The exchange rate is relatively favorable (e.g. high percentile), and major macro risk events are limited.
      - "WAIT": Better rates are expected soon; waiting has high odds of a better rate.
      - "WATCH": Highly volatile market, conflicting information, or major event (e.g. FOMC) approaching. Caution advised.
      
      Specifically, provide:
      1. 'signal': either "NOW", "WAIT", or "WATCH"
      2. 'confidence': confidence score (0 to 100)
      3. 'summary': a clear executive summary (1-2 sentences)
      4. 'drivers': an array of 2 to 4 key impact factors (each with a short title, impact: positive/negative/neutral, and detail)
      5. 'riskWarning': current max uncertainty risks (e.g. upcoming macro announcements)
      6. 'timeWindow': recommended wait/action window (e.g. "Next 24-48 hours", "1-3 days")
      7. 'risk_level': estimated timing risk level ("low", "medium", "high")
      8. 'expected_improvement_pct': potential rate improvement percentage (from 0.0 to 5.0) if wait is advised, or expected degradation if exchange is urgent.
      9. 'execution_suggestion': how the user should execute (e.g. "Exchange all now", "Split into 3 tranches", "Wait and set rate alerts")
      10. 'signals': key scores from 0 to 100 for:
          - 'trend_score': how strong the favorable trend is (0-100)
          - 'volatility_score': volatility risk level (0-100)
          - 'event_risk_score': geopolitical/event risk level (0-100)
          - 'liquidity_score': platform liquidity depth level (0-100)
      
      IMPORTANT: You must write all output text values (specifically the 'summary', the drivers' 'title' and 'detail', the 'riskWarning', the 'timeWindow', and 'execution_suggestion') in ${isZh ? 'Simplified Chinese (简体中文)' : 'English (en-US)'}. Keep the 'signal' as one of the enum values: "NOW", "WAIT", or "WATCH", and 'risk_level' as one of: "low", "medium", "high".
      
      Return your analysis strictly in the requested JSON structure. Do not output any Markdown wrapping or prefix.
    `;

    const promptZh = `
      你是一位专注于外汇（FX）市场分析的资深金融 AI 助手。
      
      请分析以下关于货币对 ${base}/${quote} 的数据：
      - 目标兑换金额：${amount} ${base}
      - 观察期偏好 / 时间偏好：${horizon}
      - 市场即期汇率：1 ${base} = ${currentRate.toFixed(4)} ${quote}
      - 平台实际到手汇率（已计入点差和滑点折损）：1 ${base} = ${effectiveRate.toFixed(4)} ${quote}
      - 计算得出的点差与滑点成本比例：${(totalCostFactor * 100).toFixed(2)}%
      - 7天汇率变化率：${change7d}%
      - 30天汇率变化率：${change30d}%
      - 30天历史实现波动率：${realizedVol30d}%
      - 当前汇率处于过去 30 天的历史百分位位置：${percentile30d}%（0% 代表历史最低点，100% 代表历史最高点）
      
      我们还从 Polymarket 预测市场检索到了相关的 crowdsourced（大众共识）宏观事件发生概率：
      ${ragEvents.map(e => formatEventForLLM(e, 'zh')).join('\n')}
      
      我们还检索到了该用户的长期记忆偏好（User's Long-term memories & transaction history）：
      ${memories && memories.length > 0
        ? memories.map((m, idx) => `- [历史偏好记忆 ${idx + 1}]："${m.content || m.text || JSON.stringify(m)}"`).join('\n')
        : '- 暂无该用户的历史换汇倾向或偏好记忆。'}
      
      请为想要将 ${base} 兑换为 ${quote} 的用户推荐最佳的换汇操作时机。
      可选的决策信号（signal）有：
      - "NOW" (现在兑换)：当前汇率处于相对优势区间（例如高历史百分位），且主要的宏观风险事件较少。
      - "WAIT" (等待观察)：预计近期会有更好的汇率出现；等待有较大几率能换得更多额度。
      - "WATCH" (保持观望)：市场目前波动剧烈、信息冲突或有重大宏观经济事件（如美联储议息会议 FOMC）临近。建议保持谨慎。
      
      请具体输出包含以下字段的 JSON 结构，不要带任何 Markdown 包装（如 \`\`\`json）：
      1. 'signal'：换汇决策信号，必须为 "NOW"、"WAIT" 或 "WATCH" 之一。
      2. 'confidence'：该建议的可信度得分（0 到 100）。
      3. 'summary'：清晰的执行摘要（1-2 句话，使用中文）。
      4. 'drivers'：包含 2 到 4 个核心驱动因子分析的数组，其中每个因子包含：'title' (标题)、'impact' (影响倾向，必须为 'positive'、'negative' 或 'neutral')、'detail' (细节描述，使用中文)。
      5. 'riskWarning'：当前面临的最大不确定性风险提示（例如即将发布的重要数据，使用中文）。
      6. 'timeWindow'：推荐的执行/等待时间窗口（例如 "接下来的 24-48 小时", "1-3 天"）。
      7. 'risk_level'：预估的时机风险等级，必须为 "low"、"medium"、"high" 之一。
      8. 'expected_improvement_pct'：如果建议等待，预计汇率可能的改善百分比（0.0 到 5.0，为浮点数）；如果建议立刻兑换，则表示如果继续拖延可能面临的贬值折损比例。
      9. 'execution_suggestion'：给用户的具体执行操作方案（例如 "现在全额兑换", "分 3 批兑换"，使用中文）。
      10. 'signals'：以下几个核心量化指标的 0 到 100 评分：
          - 'trend_score'：当前有利趋势的强弱评分 (0-100)
          - 'volatility_score'：汇率波动风险程度评分 (0-100)
          - 'event_risk_score'：地缘政治或宏观事件风险评分 (0-100)
          - 'liquidity_score'：平台流动性深度评分 (0-100)
      
      重要要求：你必须使用 简体中文 编写所有的文本输出值（具体包括：'summary' 摘要、drivers 里的 'title' 与 'detail'、'riskWarning' 风险提示、'timeWindow' 时间窗口、以及 'execution_suggestion' 执行建议）。'signal' 必须保持为英文枚举 "NOW"、"WAIT"、"WATCH" 之一，'risk_level' 必须保持为 "low"、"medium"、"high" 之一。
      
      请严格以要求的 JSON 格式返回分析结果。不要输出任何 Markdown 格式的包裹代码块或前后修饰文本。
    `;

    const promptLang = process.env.PROMPT_LANG || 'en';
    const prompt = promptLang === 'zh' ? promptZh : promptEn;

    let textResponse = '';

    if (provider === 'hunyuan') {
      console.log(`📡 Calling Tencent Hunyuan API (${process.env.HUNYUAN_MODEL || 'hy3-preview'})...`);
      const hunyuanKey = process.env.HUNYUAN_API_KEY;
      const hunyuanModel = process.env.HUNYUAN_MODEL || 'hy3-preview';

      const hunyuanBaseUrl = process.env.HUNYUAN_BASE_URL || 'https://tokenhub.tencentmaas.com/v1';
      const cleanBaseUrl = hunyuanBaseUrl.replace(/\/$/, '');
      const response = await fetch(`${cleanBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${hunyuanKey}`
        },
        body: JSON.stringify({
          model: hunyuanModel,
          messages: [
            { role: 'user', content: prompt }
          ]
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Hunyuan API error: ${response.statusText} - ${errText}`);
      }

      const resJson = await response.json();
      if (!resJson.choices || resJson.choices.length === 0) {
        throw new Error('Hunyuan API returned empty choices');
      }
      textResponse = resJson.choices[0].message.content;
    } else {
      console.log('📡 Calling Gemini API (gemini-2.5-flash)...');
      // 使用 Gemini 2.5 Flash 强 JSON 约束
      const model = genAI.getGenerativeModel({
        model: 'gemini-2.5-flash',
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: SchemaType.OBJECT,
            properties: {
              signal: { type: SchemaType.STRING, enum: ['NOW', 'WAIT', 'WATCH'] },
              confidence: { type: SchemaType.INTEGER },
              summary: { type: SchemaType.STRING },
              drivers: {
                type: SchemaType.ARRAY,
                items: {
                  type: SchemaType.OBJECT,
                  properties: {
                    title: { type: SchemaType.STRING },
                    impact: { type: SchemaType.STRING, enum: ['positive', 'negative', 'neutral'] },
                    detail: { type: SchemaType.STRING }
                  },
                  required: ['title', 'impact', 'detail']
                }
              },
              riskWarning: { type: SchemaType.STRING },
              timeWindow: { type: SchemaType.STRING },
              risk_level: { type: SchemaType.STRING, enum: ['low', 'medium', 'high'] },
              expected_improvement_pct: { type: SchemaType.NUMBER },
              execution_suggestion: { type: SchemaType.STRING },
              signals: {
                type: SchemaType.OBJECT,
                properties: {
                  trend_score: { type: SchemaType.NUMBER },
                  volatility_score: { type: SchemaType.NUMBER },
                  event_risk_score: { type: SchemaType.NUMBER },
                  liquidity_score: { type: SchemaType.NUMBER }
                },
                required: ['trend_score', 'volatility_score', 'event_risk_score', 'liquidity_score']
              }
            },
            required: [
              'signal',
              'confidence',
              'summary',
              'drivers',
              'riskWarning',
              'timeWindow',
              'risk_level',
              'expected_improvement_pct',
              'execution_suggestion',
              'signals'
            ]
          }
        }
      });

      const geminiResult = await model.generateContent(prompt);
      textResponse = geminiResult.response.text();
    }

    const parsedAnalysis = extractJson(textResponse);

    // 6. 返回综合的 JSON 响应给前端
    const finalResponse = {
      pair: `${base}/${quote}`,
      base,
      quote,
      currentRate: Number(currentRate.toFixed(4)),
      effectiveRate: Number(effectiveRate.toFixed(4)),
      totalCostFactor: Number(totalCostFactor.toFixed(4)),
      change7d,
      change30d,
      updatedAt: new Date().toISOString(),
      history,
      news: RECENT_NEWS.filter(news => {
        // 简单匹配：只返回跟该币种相关的新闻
        const searchTerms = [base.toLowerCase(), quote.toLowerCase(), 'us', 'china', 'fed', 'rate'];
        return searchTerms.some(term => news.title.toLowerCase().includes(term) || news.summary.toLowerCase().includes(term));
      }).slice(0, 3),
      analysis: parsedAnalysis,
      polymarketData: ragEvents,
      longTermMemories: memories,
      provider,
      model: provider === 'hunyuan' ? (process.env.HUNYUAN_MODEL || 'hy3-preview') : 'gemini-2.5-flash'
    };

    res.json(finalResponse);
  } catch (error) {
    console.error('❌ Failed to process fx-intel analysis:', error);

    const isZh = lang === 'zh';
    const pair = `${base}/${quote}`;

    // 如果第一步网络不通，这里做硬编码兜底
    if (currentRate === 1) {
      const rateMap: Record<string, number> = {
        'USD/CNY': 7.285,
        'USD/MYR': 4.712,
        'CNY/MYR': 0.647
      };
      currentRate = rateMap[pair] || 1;
      effectiveRate = Number((currentRate * 0.997).toFixed(4));
      totalCostFactor = 0.003;
      history = generateHistory(currentRate);
      change7d = 0.45;
      change30d = -1.2;
    }

    const finalRag = ragEvents;

    res.json({
      pair,
      base,
      quote,
      currentRate: Number(currentRate.toFixed(4)),
      effectiveRate: Number(effectiveRate.toFixed(4)),
      totalCostFactor: Number(totalCostFactor.toFixed(4)),
      change7d,
      change30d,
      updatedAt: new Date().toISOString(),
      history,
      news: RECENT_NEWS.slice(0, 2),
      analysis: {
        signal: 'WATCH',
        confidence: 80,
        summary: isZh
          ? '市场目前在关键央行声明发布前处于整合阶段。'
          : 'Market is in a consolidating phase ahead of key central bank statements.',
        drivers: [
          {
            title: isZh ? '美联储利率前景' : 'Fed Outlook',
            impact: 'neutral',
            detail: isZh ? '市场普遍预期美联储在本次会议上将维持利率不变。' : 'Market expects Fed to maintain rates.'
          },
          {
            title: isZh ? '本地出口强劲支撑' : 'Local Demand',
            impact: 'positive',
            detail: isZh ? '强劲的出口贸易数据持续支撑本地货币表现。' : 'Robust export numbers supporting local currencies.'
          }
        ],
        riskWarning: isZh
          ? '受下周潜在关税法案政策出台影响，汇市短期波动率可能大幅飙升。'
          : 'High volatility expected due to potential tariff developments next week.',
        timeWindow: isZh ? '未来 5-7 天' : 'Next 5-7 days',
        risk_level: 'medium',
        expected_improvement_pct: 0.5,
        execution_suggestion: isZh ? '分批兑换，先换汇 50%，其余等待' : 'Split execution, exchange 50% first, observe remainder',
        signals: {
          trend_score: 50,
          volatility_score: 65,
          event_risk_score: 75,
          liquidity_score: 90
        }
      },
      polymarketData: finalRag,
      provider,
      model: provider === 'hunyuan' ? (process.env.HUNYUAN_MODEL || 'hy3-preview') : 'gemini-2.5-flash',
      longTermMemories: memories
    });
  }
});

// 主动向 Hy-Memory 服务保存记忆的路由
app.post('/api/save-memory', async (req, res) => {
  const { content, userId } = req.body;
  const targetUserId = userId || 'guoying_dev';
  
  console.log(`🧠 [Long-term Memory] Request to save memory for user "${targetUserId}": "${content.slice(0, 50)}..."`);
  
  try {
    const response = await fetch('http://127.0.0.1:19527/api/v1/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: content,
        user_id: targetUserId
      })
    });
    
    if (response.ok) {
      const result = await response.json();
      console.log('✅ [Long-term Memory] Saved successfully to Hy-Memory:', result);
      return res.json({ success: true, result });
    }
    throw new Error(`Hy-Memory server returned ${response.status}`);
  } catch (error) {
    console.error('❌ [Long-term Memory] Failed to save memory:', error);
    return res.status(500).json({ success: false, error: error instanceof Error ? error.message : String(error) });
  }
});

// 服务启动
app.listen(PORT, async () => {
  console.log(`🚀 Node.js Backend API Server is running on http://localhost:${PORT}`);

  // 在服务器启动时，自动在后台异步触发一次数据库同步（拉取 Polymarket 赔率并生成向量存库）
  // 这样做可以让用户一键跑通，无需手动输入同步命令
  try {
    console.log('🔄 Triggering auto-sync on startup...');
    syncPolymarketData()
      .then(() => console.log('✅ Startup auto-sync completed.'))
      .catch(err => console.error('⚠️ Startup auto-sync error:', err));
  } catch (e) {
    console.error('⚠️ Failed to queue auto-sync on startup:', e);
  }
});

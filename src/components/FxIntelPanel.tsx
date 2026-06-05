import { useState, useEffect } from 'react';
import { Sparkles, TrendingUp, TrendingDown, Clock, AlertTriangle, Activity, DollarSign, Award, HelpCircle, Cpu } from 'lucide-react';

interface Driver {
  title: string;
  impact: 'positive' | 'negative' | 'neutral';
  detail: string;
}

interface PolymarketEvent {
  id: string;
  title: string;
  odds: number;
  url: string;
}

interface FxData {
  pair: string;
  base: string;
  quote: string;
  currentRate: number;
  effectiveRate: number;
  totalCostFactor: number;
  change7d: number;
  change30d: number;
  updatedAt: string;
  history: Array<{ date: string; rate: number }>;
  news: Array<{ title: string; source: string; publishedAt: string; summary: string }>;
  analysis: {
    signal: 'NOW' | 'WAIT' | 'WATCH';
    confidence: number;
    summary: string;
    drivers: Driver[];
    riskWarning: string;
    timeWindow: string;
    risk_level: 'low' | 'medium' | 'high';
    expected_improvement_pct: number;
    execution_suggestion: string;
    signals: {
      trend_score: number;
      volatility_score: number;
      event_risk_score: number;
      liquidity_score: number;
    };
  };
  polymarketData?: PolymarketEvent[];
  provider?: string;
  model?: string;
}

const T = {
  zh: {
    title: 'FX Intel 智能决策看板',
    usdCny: 'USD/CNY (美元/人民币)',
    usdMyr: 'USD/MYR (美元/马币)',
    cnyMyr: 'CNY/MYR (人民币/马币)',
    liveRate: '市场中间价汇率',
    effectiveRate: '到手可执行汇率',
    costFactor: '点差与滑点损耗',
    change7d: '最近 7 天涨跌',
    change30d: '最近 30 天涨跌',
    trendTitle: '30 天历史汇率走势',
    hoverTip: '* 悬停数据点显示具体价格',
    geminiTitle: 'Gemini AI 智能换汇建议',
    driversTitle: '核心影响驱动因素 (DRIVERS)',
    riskTitle: '最大不确定性风险',
    windowTitle: '建议观察期窗口',
    ragTitle: 'RAG 向量检索关联 Polymarket 宏观预测',
    odds: '胜率',
    amountLabel: '计划兑换金额',
    horizonLabel: '观察周期偏好',
    horizonShort: '1天 (短期偏好)',
    horizonMedium: '3天 (均衡偏好)',
    horizonLong: '7天 (耐心偏好)',
    simulatorTitle: 'AI 兑换收益/损耗模拟器',
    signalsBoard: '决策维度量化打分',
    trendScore: '趋势偏利度',
    volatilityScore: '波动率风险',
    eventScore: '央行事件风险',
    liquidityScore: '流动性深度',
    riskLevel: '时机风险等级',
    executionSuggestion: '推荐执行方案',
  },
  en: {
    title: 'FX Intel Timing Decision Board',
    usdCny: 'USD/CNY (USD/CNY)',
    usdMyr: 'USD/MYR (USD/MYR)',
    cnyMyr: 'CNY/MYR (CNY/MYR)',
    liveRate: 'Market Mid-Rate',
    effectiveRate: 'Platform Effective Rate',
    costFactor: 'Spread & Slippage Cost',
    change7d: '7-Day Change',
    change30d: '30-Day Change',
    trendTitle: '30-Day Historical Trend',
    hoverTip: '* Hover over data points for details',
    geminiTitle: 'Gemini AI Timing Recommendation',
    driversTitle: 'Key Impact Drivers',
    riskTitle: 'Max Uncertainty Risks',
    windowTitle: 'Recommended Window',
    ragTitle: 'RAG Associated Polymarket Macro Event Odds',
    odds: 'Odds',
    amountLabel: 'Exchange Amount',
    horizonLabel: 'Horizon Preference',
    horizonShort: '1 Day (Short)',
    horizonMedium: '3 Days (Balanced)',
    horizonLong: '7 Days (Patient)',
    simulatorTitle: 'AI Exchange Savings Simulator',
    signalsBoard: 'Decision Scoring Dashboard',
    trendScore: 'Trend Favorable',
    volatilityScore: 'Volatility Risk',
    eventScore: 'Event Risk',
    liquidityScore: 'Liquidity Depth',
    riskLevel: 'Timing Risk Level',
    executionSuggestion: 'Suggested Execution',
  }
};

const loadingStepsData = {
  zh: [
    { title: '感知阶段 (Perception)', desc: '正在连接 Polymarket 官方 API 并获取最新宏观赔率...' },
    { title: '数据对齐 (RAG Indexing)', desc: '正在与 pgvector 数据库匹配本币汇率的历史关联事件...' },
    { title: '认知推理 (Model Reasoning)', desc: '正在调取大语言模型 Agent 进行资产套保深度分析...' },
    { title: '策略构建 (Strategy Output)', desc: '正在输出量化置信打分与 zkTLS 支付执行路线规划...' }
  ],
  en: [
    { title: 'Perception Phase', desc: 'Connecting to Polymarket Gamma API to fetch real-time macro odds...' },
    { title: 'RAG Alignment', desc: 'Querying pgvector database to retrieve historical correlation events...' },
    { title: 'Model Reasoning', desc: 'Invoking Large Language Model Agent to analyze foreign exchange hedging risk...' },
    { title: 'Strategy Synthesis', desc: 'Generating AI confidence score and planning zkTLS execution path...' }
  ]
};

interface FxIntelPanelProps {
  onRateChange: (rate: number, pair: string) => void;
  lang: 'zh' | 'en';
  amount: string;
  setAmount: (amt: string) => void;
  horizon: string;
  setHorizon: (hor: string) => void;
  onAnalysisUpdate: (analysis: any) => void;
}

export function FxIntelPanel({ 
  onRateChange, 
  lang, 
  amount, 
  setAmount, 
  horizon, 
  setHorizon, 
  onAnalysisUpdate 
}: FxIntelPanelProps) {
  const [pair, setPair] = useState('USD/CNY');
  const [loading, setLoading] = useState(true);
  const [loadingStep, setLoadingStep] = useState(0);
  const [data, setData] = useState<FxData | null>(null);
  const [hoveredPoint, setHoveredPoint] = useState<{ date: string; rate: number; index: number } | null>(null);

  useEffect(() => {
    if (!loading) {
      setLoadingStep(0);
      return;
    }
    const interval = setInterval(() => {
      setLoadingStep(step => {
        if (step < 3) return step + 1;
        return step;
      });
    }, 750);

    return () => clearInterval(interval);
  }, [loading]);

  const fetchIntel = async (selectedPair: string) => {
    setLoading(true);
    const [base, quote] = selectedPair.split('/');
    try {
      const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:3001';
      const res = await fetch(`${apiUrl}/api/fx-intel?base=${base}&quote=${quote}&amount=${amount}&horizon=${horizon}&lang=${lang}`);
      if (!res.ok) throw new Error('Failed to fetch api');
      const json = await res.json();
      setData(json);
      onRateChange(json.currentRate, selectedPair);
      onAnalysisUpdate(json);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchIntel(pair);
  }, [pair, lang, amount, horizon]);

  // 渲染 SVG 折线图的辅助计算
  const renderChart = (history: FxData['history']) => {
    if (!history || history.length === 0) return null;

    const width = 500;
    const height = 180;
    const padding = 20;

    const rates = history.map((h) => h.rate);
    const max = Math.max(...rates);
    const min = Math.min(...rates);
    const range = max - min || 1;

    // 缩放坐标点
    const points = history.map((h, i) => {
      const x = padding + (i / (history.length - 1)) * (width - padding * 2);
      const y = height - padding - ((h.rate - min) / range) * (height - padding * 2);
      return { x, y, rate: h.rate, date: h.date };
    });

    const pathD = `M ${points.map((p) => `${p.x} ${p.y}`).join(' L ')}`;
    // 创建渐变填充区域的闭合路径
    const areaD = `${pathD} L ${points[points.length - 1].x} ${height - padding} L ${points[0].x} ${height - padding} Z`;

    return (
      <div style={{ position: 'relative' }}>
        <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} style={{ overflow: 'visible' }}>
          <defs>
            <linearGradient id="chartGlow" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#6366f1" stopOpacity="0.25" />
              <stop offset="100%" stopColor="#6366f1" stopOpacity="0.0" />
            </linearGradient>
            <linearGradient id="lineGrad" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#818cf8" />
              <stop offset="50%" stopColor="#6366f1" />
              <stop offset="100%" stopColor="#3b82f6" />
            </linearGradient>
          </defs>

          {/* 网格背景线 */}
          <line x1={padding} y1={padding} x2={width - padding} y2={padding} stroke="rgba(255,255,255,0.03)" />
          <line x1={padding} y1={height / 2} x2={width - padding} y2={height / 2} stroke="rgba(255,255,255,0.03)" />
          <line x1={padding} y1={height - padding} x2={width - padding} y2={height - padding} stroke="rgba(255,255,255,0.05)" />

          {/* 渐变填充 */}
          <path d={areaD} fill="url(#chartGlow)" />

          {/* 折线 */}
          <path d={pathD} fill="none" stroke="url(#lineGrad)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />

          {/* 刻度标注 */}
          <text x={width - padding} y={padding - 5} fill="var(--text-muted)" fontSize="9" textAnchor="end">
            MAX: {max.toFixed(4)}
          </text>
          <text x={width - padding} y={height - padding + 12} fill="var(--text-muted)" fontSize="9" textAnchor="end">
            MIN: {min.toFixed(4)}
          </text>

          {/* 数据点交互 */}
          {points.map((p, i) => (
            <circle
              key={i}
              cx={p.x}
              cy={p.y}
              r={hoveredPoint?.index === i ? 6 : 3}
              fill={hoveredPoint?.index === i ? 'white' : '#6366f1'}
              stroke="rgba(3, 7, 18, 0.9)"
              strokeWidth={hoveredPoint?.index === i ? 3 : 1}
              style={{ cursor: 'pointer', transition: 'all 0.15s ease' }}
              onMouseEnter={() => setHoveredPoint({ date: p.date, rate: p.rate, index: i })}
              onMouseLeave={() => setHoveredPoint(null)}
            />
          ))}
        </svg>

        {/* 悬停价格标签气泡 */}
        {hoveredPoint && (
          <div
            style={{
              position: 'absolute',
              top: '5px',
              left: '50%',
              transform: 'translateX(-50%)',
              background: 'var(--bg-card)',
              border: '1px solid var(--border-card)',
              borderRadius: '8px',
              padding: '6px 12px',
              fontSize: '0.8rem',
              boxShadow: '0 4px 15px rgba(0,0,0,0.15)',
              pointerEvents: 'none',
              display: 'flex',
              gap: '8px',
            }}
          >
            <span style={{ color: 'var(--text-muted)' }}>{hoveredPoint.date}:</span>
            <strong style={{ color: 'var(--text-primary)' }}>{hoveredPoint.rate.toFixed(4)}</strong>
          </div>
        )}
      </div>
    );
  };

  const getSignalClass = (sig: FxData['analysis']['signal']) => {
    if (sig === 'NOW') return 'signal-now';
    if (sig === 'WAIT') return 'signal-wait';
    return 'signal-watch';
  };

  const getImpactColor = (impact: Driver['impact']) => {
    if (impact === 'positive') return '#34d399';
    if (impact === 'negative') return '#f87171';
    return '#9ca3af';
  };

  const getRiskLevelColor = (level: string) => {
    if (level === 'low') return '#34d399';
    if (level === 'medium') return '#fbbf24';
    return '#f87171';
  };

  if (loading) {
    const steps = loadingStepsData[lang] || loadingStepsData.zh;
    return (
      <div className="glass-card" id="fx-intel-board" style={{ minHeight: '520px', display: 'flex', flexDirection: 'column', gap: '1.5rem', padding: '2rem', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', gap: '0.5rem', alignItems: 'center' }}>
          <div className="agent-avatar-sphere" style={{ animation: 'pulsePrimary 1.5s infinite', width: '50px', height: '50px', cursor: 'default' }}>
            <Activity size={20} color="white" />
          </div>
          <h3 style={{ margin: '1rem 0 0 0', fontSize: '1.15rem', fontWeight: 700 }} className="gradient-text">
            {lang === 'zh' ? '智能外汇套保智能体分析中...' : 'FX Hedging Agent is reasoning...'}
          </h3>
          <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-muted)' }}>
            {lang === 'zh' ? '实时感知 Polymarket 预测概率与 RAG 汇率对齐中' : 'Sensing Polymarket odds & aligning exchange risk factors'}
          </p>
        </div>
        
        <div className="agent-thought-container">
          {steps.map((s, idx) => {
            const isActive = loadingStep === idx;
            const isCompleted = loadingStep > idx;
            return (
              <div key={idx} className={`agent-thought-step ${isActive ? 'active' : ''} ${isCompleted ? 'completed' : ''}`}>
                <div className="agent-thought-icon" style={{ fontSize: '0.75rem', fontWeight: 'bold' }}>
                  {isCompleted ? '✓' : (idx + 1)}
                </div>
                <div>
                  <div style={{ fontWeight: 600, fontSize: '0.85rem', color: isActive ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                    {s.title}
                  </div>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '2px' }}>
                    {s.desc}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Loading Progress Bar */}
        <div style={{ width: '100%', height: '4px', background: 'rgba(255,255,255,0.05)', borderRadius: '2px', overflow: 'hidden', marginTop: '1rem' }}>
          <div style={{
            height: '100%',
            width: `${(loadingStep + 1) * 25}%`,
            background: 'linear-gradient(90deg, #6366f1, #a855f7)',
            borderRadius: '2px',
            transition: 'width 0.4s ease-out'
          }} />
        </div>
      </div>
    );
  }

  const t = T[lang];
  const activeAmount = parseFloat(amount) || 1000;
  const currentRateValue = data?.currentRate || 1;
  const improvementPct = data?.analysis?.expected_improvement_pct || 0;
  const simulatedSavingValue = activeAmount * currentRateValue * (improvementPct / 100);

  return (
    <div className="glass-card" id="fx-intel-board" style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      
      {/* 头部控制栏 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Activity size={20} color="var(--primary)" />
          <h2 style={{ margin: 0, fontSize: '1.4rem', fontWeight: 700 }} className="gradient-text">
            {t.title}
          </h2>
        </div>
      </div>

      {/* Agent Status Dashboard */}
      <div className="agent-status-card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.85rem' }}>
            <Cpu size={14} color="var(--primary)" />
            <span style={{ fontWeight: 600, color: 'var(--text-muted)' }}>
              {lang === 'zh' ? '智能体角色:' : 'Agent Role:'}
            </span>
            <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>
              {lang === 'zh' ? '智能外汇套保智能体 v1.0' : 'FX Smart Hedging Agent v1.0'}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ 
              width: '6px', 
              height: '6px', 
              borderRadius: '50%', 
              background: '#34d399', 
              boxShadow: '0 0 8px #34d399',
              animation: 'badgeBlink 2s infinite' 
            }} />
            <span style={{ fontSize: '0.75rem', color: '#34d399', fontWeight: 600 }}>
              {lang === 'zh' ? '运行中' : 'Active'}
            </span>
          </div>
        </div>

        <div style={{ 
          display: 'grid', 
          gridTemplateColumns: 'repeat(2, 1fr)', 
          gap: '8px', 
          fontSize: '0.75rem', 
          marginTop: '4px',
          borderTop: '1px solid rgba(255, 255, 255, 0.05)',
          paddingTop: '8px'
        }}>
          <div style={{ display: 'flex', gap: '4px', color: 'var(--text-muted)' }}>
            <span>{lang === 'zh' ? '基座模型:' : 'Core Model:'}</span>
            <strong style={{ color: 'var(--text-primary)' }}>
              {data?.provider === 'hunyuan' ? 'Tencent Hunyuan' : 'Google Gemini'} 
              <span style={{ fontSize: '0.7rem', color: 'var(--primary)', marginLeft: '4px' }}>
                ({data?.model || 'hy3-preview'})
              </span>
            </strong>
          </div>
          <div style={{ display: 'flex', gap: '4px', color: 'var(--text-muted)' }}>
            <span>{lang === 'zh' ? '感知传感器:' : 'Sensors:'}</span>
            <strong style={{ color: 'var(--text-primary)' }}>Polymarket Gamma API</strong>
          </div>
          <div style={{ display: 'flex', gap: '4px', color: 'var(--text-muted)' }}>
            <span>{lang === 'zh' ? '记忆体类型:' : 'Memory Type:'}</span>
            <strong style={{ color: 'var(--text-primary)' }}>PostgreSQL RAG (pgvector)</strong>
          </div>
          <div style={{ display: 'flex', gap: '4px', color: 'var(--text-muted)' }}>
            <span>{lang === 'zh' ? '决策依据:' : 'Reference:'}</span>
            <strong style={{ color: 'var(--text-primary)' }}>
              {data?.polymarketData?.length || 0} {lang === 'zh' ? '个相关预测盘口' : 'active predictions'}
            </strong>
          </div>
        </div>
      </div>

      {/* 参数输入与货币对切换配置网格 */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
          gap: '1rem',
          background: 'rgba(255,255,255,0.01)',
          borderRadius: '12px',
          padding: '1rem',
          border: '1px solid rgba(255,255,255,0.04)',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <label style={{ fontSize: '0.8rem', color: 'var(--text-muted)', fontWeight: 600 }}>{lang === 'zh' ? '选择分析货币对' : 'Currency Pair'}</label>
          <select value={pair} onChange={(e) => setPair(e.target.value)} className="select-field" style={{ width: '100%' }}>
            <option value="USD/CNY">{t.usdCny}</option>
            <option value="USD/MYR">{t.usdMyr}</option>
            <option value="CNY/MYR">{t.cnyMyr}</option>
          </select>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <label style={{ fontSize: '0.8rem', color: 'var(--text-muted)', fontWeight: 600 }}>{t.amountLabel}</label>
          <div style={{ position: 'relative', width: '100%' }}>
            <input 
              type="number" 
              value={amount} 
              onChange={(e) => setAmount(e.target.value)} 
              className="input-field" 
              style={{ padding: '0.5rem', fontSize: '0.9rem', width: '100%', boxSizing: 'border-box' }}
            />
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <label style={{ fontSize: '0.8rem', color: 'var(--text-muted)', fontWeight: 600 }}>{t.horizonLabel}</label>
          <select value={horizon} onChange={(e) => setHorizon(e.target.value)} className="select-field" style={{ width: '100%' }}>
            <option value="1d">{t.horizonShort}</option>
            <option value="3d">{t.horizonMedium}</option>
            <option value="7d">{t.horizonLong}</option>
          </select>
        </div>
      </div>

      {/* 汇率数值与成本展示区 */}
      {data && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
            gap: '1rem',
            background: 'rgba(255,255,255,0.02)',
            borderRadius: '12px',
            padding: '1rem',
            border: '1px solid rgba(255,255,255,0.04)',
          }}
        >
          <div>
            <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginBottom: '4px' }}>{t.liveRate}</div>
            <div style={{ fontSize: '1.4rem', fontWeight: 800, color: 'var(--text-primary)' }}>
              1 {data.base} = {data.currentRate.toFixed(4)} {data.quote}
            </div>
            <div style={{ fontSize: '0.75rem', color: data.change7d >= 0 ? 'var(--success)' : 'var(--danger)', fontWeight: 600 }}>
              7d: {data.change7d >= 0 ? `+${data.change7d}%` : `${data.change7d}%`}
            </div>
          </div>
          <div>
            <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginBottom: '4px' }}>{t.effectiveRate}</div>
            <div style={{ fontSize: '1.4rem', fontWeight: 800, color: 'var(--primary)' }}>
              1 {data.base} = {data.effectiveRate.toFixed(4)} {data.quote}
            </div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
              {t.costFactor}: {((data.totalCostFactor || 0.003) * 100).toFixed(2)}%
            </div>
          </div>
          <div>
            <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginBottom: '4px' }}>{t.change30d}</div>
            <div
              style={{
                fontSize: '1.2rem',
                fontWeight: 700,
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
                color: data.change30d >= 0 ? 'var(--success)' : 'var(--danger)',
                marginTop: '4px'
              }}
            >
              {data.change30d >= 0 ? <TrendingUp size={16} /> : <TrendingDown size={16} />}
              {data.change30d >= 0 ? `+${data.change30d}%` : `${data.change30d}%`}
            </div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{lang === 'zh' ? '30天趋势变动' : '30-Day Trend'}</div>
          </div>
        </div>
      )}

      {/* SVG 折线走势图 */}
      {data && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem', alignItems: 'center' }}>
            <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)', fontWeight: 600 }}>{t.trendTitle}</span>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{t.hoverTip}</span>
          </div>
          {renderChart(data.history)}
        </div>
      )}

      {/* Gemini AI 信号灯决策区 */}
      {data && (
        <div
          className="glass-card"
          style={{
            background: 'rgba(255,255,255,0.02)',
            border: '1px solid rgba(255,255,255,0.06)',
            padding: '1.25rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '1rem',
          }}
        >
          {/* 时机建议头部 */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Sparkles size={18} color="#a78bfa" />
              <strong style={{ color: 'var(--text-primary)' }}>{t.geminiTitle}</strong>
            </div>
            <span className={`signal-badge ${getSignalClass(data.analysis.signal)}`}>
              {data.analysis.signal}
            </span>
          </div>

          {/* 置信度条 */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '-4px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
              <span>{lang === 'zh' ? '建议可信度 (Confidence)' : 'Recommendation Confidence'}</span>
              <strong style={{ color: '#a78bfa' }}>{data.analysis.confidence}%</strong>
            </div>
            <div style={{ width: '100%', height: '4px', background: 'rgba(255,255,255,0.05)', borderRadius: '2px', overflow: 'hidden' }}>
              <div style={{ width: `${data.analysis.confidence}%`, height: '100%', background: 'linear-gradient(90deg, #6366f1, #c084fc)' }} />
            </div>
          </div>

          <div style={{ fontSize: '0.95rem', lineHeight: '1.6', color: 'var(--text-secondary)', borderLeft: '3px solid rgba(99, 102, 241, 0.4)', paddingLeft: '10px' }}>
            {data.analysis.summary}
          </div>

          {/* AI 收益/损耗模拟器卡片 */}
          <div
            style={{
              background: 'rgba(99, 102, 241, 0.04)',
              border: '1px solid rgba(99, 102, 241, 0.12)',
              borderRadius: '12px',
              padding: '12px 16px',
              display: 'flex',
              flexDirection: 'column',
              gap: '6px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-highlight)' }}>
              <DollarSign size={14} />
              <span>{t.simulatorTitle}</span>
            </div>
            <div style={{ fontSize: '0.9rem', lineHeight: '1.4' }}>
              {data.analysis.signal === 'WAIT' ? (
                <div>
                  {lang === 'zh' ? (
                    <span>
                      建议等待观察以获取更优时机。预计您可能会额外多换得{' '}
                      <strong style={{ color: 'var(--success)', fontSize: '1rem' }}>
                        +{simulatedSavingValue.toFixed(2)} {data.quote}
                      </strong>{' '}
                      (汇率改善约为 <strong style={{ color: 'var(--success)' }}>{improvementPct}%</strong>)。
                    </span>
                  ) : (
                    <span>
                      Waiting is recommended. You could gain up to{' '}
                      <strong style={{ color: 'var(--success)', fontSize: '1rem' }}>
                        +{simulatedSavingValue.toFixed(2)} {data.quote}
                      </strong>{' '}
                      extra (estimated improvement: <strong style={{ color: 'var(--success)' }}>{improvementPct}%</strong>).
                    </span>
                  )}
                </div>
              ) : data.analysis.signal === 'NOW' ? (
                <div>
                  {lang === 'zh' ? (
                    <span>
                      建议立即换汇，目前是极佳兑换窗口。如果继续等待，预计可能面临{' '}
                      <strong style={{ color: 'var(--danger)', fontSize: '1rem' }}>
                        -{simulatedSavingValue.toFixed(2)} {data.quote}
                      </strong>{' '}
                      的汇率贬值贬损损失。
                    </span>
                  ) : (
                    <span>
                      Exchanging now is recommended. Waiting might lead to losing{' '}
                      <strong style={{ color: 'var(--danger)', fontSize: '1rem' }}>
                        -{simulatedSavingValue.toFixed(2)} {data.quote}
                      </strong>{' '}
                      due to unfavorable moves.
                    </span>
                  )}
                </div>
              ) : (
                <div>
                  {lang === 'zh' ? (
                    <span>
                      市场不确定性高（上下波动幅预计为 <strong style={{ color: 'var(--warning)' }}>±{improvementPct}%</strong>，即折合金额{' '}
                      <strong style={{ color: 'var(--warning)' }}>±{simulatedSavingValue.toFixed(2)} {data.quote}</strong>
                      ）。建议暂时搁置大额兑换，关注地缘事件进展。
                    </span>
                  ) : (
                    <span>
                      High market volatility expected (volatility range <strong style={{ color: 'var(--warning)' }}>±{improvementPct}%</strong>,{' '}
                      equivalent to <strong style={{ color: 'var(--warning)' }}>±{simulatedSavingValue.toFixed(2)} {data.quote}</strong>
                      ). Avoid large single trades now.
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* 量化指标大盘 (Signals Scoreboard) */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', background: 'rgba(255,255,255,0.01)', borderRadius: '10px', padding: '12px', border: '1px solid rgba(255,255,255,0.03)' }}>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              {t.signalsBoard}
            </div>
            
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 16px', fontSize: '0.75rem' }}>
              {/* 趋势评分 */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-muted)' }}>
                  <span>{t.trendScore}</span>
                  <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{data.analysis.signals.trend_score}/100</span>
                </div>
                <div style={{ width: '100%', height: '4px', background: 'rgba(255,255,255,0.05)', borderRadius: '2px' }}>
                  <div style={{ width: `${data.analysis.signals.trend_score}%`, height: '100%', background: '#3b82f6' }} />
                </div>
              </div>
              
              {/* 波动率评分 */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-muted)' }}>
                  <span>{t.volatilityScore}</span>
                  <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{data.analysis.signals.volatility_score}/100</span>
                </div>
                <div style={{ width: '100%', height: '4px', background: 'rgba(255,255,255,0.05)', borderRadius: '2px' }}>
                  <div style={{ width: `${data.analysis.signals.volatility_score}%`, height: '100%', background: 'var(--warning)' }} />
                </div>
              </div>
              
              {/* 事件风险评分 */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-muted)' }}>
                  <span>{t.eventScore}</span>
                  <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{data.analysis.signals.event_risk_score}/100</span>
                </div>
                <div style={{ width: '100%', height: '4px', background: 'rgba(255,255,255,0.05)', borderRadius: '2px' }}>
                  <div style={{ width: `${data.analysis.signals.event_risk_score}%`, height: '100%', background: 'var(--danger)' }} />
                </div>
              </div>
              
              {/* 流动性深度评分 */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-muted)' }}>
                  <span>{t.liquidityScore}</span>
                  <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{data.analysis.signals.liquidity_score}/100</span>
                </div>
                <div style={{ width: '100%', height: '4px', background: 'rgba(255,255,255,0.05)', borderRadius: '2px' }}>
                  <div style={{ width: `${data.analysis.signals.liquidity_score}%`, height: '100%', background: 'var(--success)' }} />
                </div>
              </div>
            </div>
          </div>

          {/* 驱动因素解析 */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: '0.25rem' }}>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              {t.driversTitle}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {data.analysis.drivers.map((driver, index) => (
                <div
                  key={index}
                  style={{
                    background: 'var(--bg-subcard)',
                    border: '1px solid var(--border-subcard)',
                    padding: '8px 12px',
                    borderRadius: '8px',
                    fontSize: '0.85rem',
                    borderLeft: `4px solid ${getImpactColor(driver.impact)}`,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '2px' }}>
                    <span>{driver.title}</span>
                    <span style={{ fontSize: '0.75rem', textTransform: 'uppercase', color: getImpactColor(driver.impact) }}>
                      {driver.impact}
                    </span>
                  </div>
                  <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>{driver.detail}</div>
                </div>
              ))}
            </div>
          </div>

          {/* 策略执行方案与风险评级 */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: '1rem',
              background: 'rgba(255,255,255,0.01)',
              borderRadius: '10px',
              padding: '10px',
              fontSize: '0.8rem',
              border: '1px solid rgba(255,255,255,0.03)'
            }}
          >
            <div>
              <div style={{ color: 'var(--text-muted)', marginBottom: '4px', fontWeight: 600 }}>{t.riskLevel}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                <Award size={14} color={getRiskLevelColor(data.analysis.risk_level)} />
                <strong style={{ color: getRiskLevelColor(data.analysis.risk_level), textTransform: 'uppercase' }}>
                  {data.analysis.risk_level}
                </strong>
              </div>
            </div>
            <div>
              <div style={{ color: 'var(--text-muted)', marginBottom: '4px', fontWeight: 600 }}>{t.executionSuggestion}</div>
              <strong style={{ color: 'var(--text-primary)' }}>{data.analysis.execution_suggestion}</strong>
            </div>
          </div>

          {/* 风险和观察窗口 */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', fontSize: '0.8rem' }}>
            <div style={{ background: 'rgba(239, 68, 68, 0.05)', border: '1px solid rgba(239, 68, 68, 0.1)', padding: '10px', borderRadius: '8px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px', color: 'var(--danger)', fontWeight: 600, marginBottom: '4px' }}>
                <AlertTriangle size={14} />
                <span>{t.riskTitle}</span>
              </div>
              <span style={{ color: 'var(--text-muted)', lineHeight: '1.4' }}>{data.analysis.riskWarning}</span>
            </div>
            <div style={{ background: 'rgba(99, 102, 241, 0.05)', border: '1px solid rgba(99, 102, 241, 0.1)', padding: '10px', borderRadius: '8px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px', color: 'var(--primary)', fontWeight: 600, marginBottom: '4px' }}>
                <Clock size={14} />
                <span>{t.windowTitle}</span>
              </div>
              <span style={{ color: 'var(--text-muted)', lineHeight: '1.4' }}>{data.analysis.timeWindow}</span>
            </div>
          </div>
        </div>
      )}

      {/* Polymarket 向量 RAG 检索回显（展现硬核 Web3 属性） */}
      {data && data.polymarketData && data.polymarketData.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              {t.ragTitle}
            </span>
            <span title="Based on vector similarity embeddings matched locally from the Postgres database." style={{ display: 'inline-flex', cursor: 'help' }}>
              <HelpCircle size={12} color="var(--text-muted)" />
            </span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {data.polymarketData.map((event) => (
              <a
                href={event.url}
                target="_blank"
                rel="noopener noreferrer"
                key={event.id}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  background: 'var(--bg-subcard)',
                  border: '1px solid var(--border-subcard)',
                  padding: '8px 12px',
                  borderRadius: '8px',
                  textDecoration: 'none',
                  color: 'var(--text-primary)',
                  fontSize: '0.85rem',
                  transition: 'background 0.2s ease, border-color 0.2s ease',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'var(--bg-subcard-hover)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'var(--bg-subcard)';
                }}
              >
                <span style={{ color: 'var(--text-secondary)', paddingRight: '1rem' }}>{event.title}</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                  <span style={{ color: '#a78bfa', fontWeight: 700 }}>{(event.odds * 100).toFixed(0)}% {t.odds}</span>
                  <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>↗</span>
                </div>
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

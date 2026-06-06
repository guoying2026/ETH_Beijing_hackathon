import { useState, useEffect } from 'react';
import { FxIntelPanel } from './components/FxIntelPanel';
import { C2CTradeCard } from './components/C2CTradeCard';
import { Shield, Database, Cpu, HelpCircle, Server, Languages, Sun, Moon, Bot, Terminal, X } from 'lucide-react';

interface SystemStatus {
  extension: 'ok' | 'missing';
  nodeBackend: 'ok' | 'error';
  rustVerifier: 'ok' | 'error';
  swissBank: 'ok' | 'error';
}

const getT = (lang: 'zh' | 'en', activeAI: { provider: string; model: string }) => {
  const modelName = activeAI.provider === 'hunyuan' ? 'Tencent Hunyuan (腾讯混元)' : 'Gemini 2.5';
  const modelTech = activeAI.provider === 'hunyuan' ? (activeAI.model || 'hy3-preview') : 'Gemini-2.5-flash';
  
  return {
    subtitle: lang === 'zh'
      ? `结合了 **${modelName} AI 时机分析决策 (FX Intel)** 与 **zkTLS 零知识证明网银转账清算** 的去中心化、可信 C2C 汇率交易辅助平台。`
      : `A decentralized, trustless C2C FX trading assistant platform combining **${modelName} AI timing analysis & decisions (FX Intel)** and **zkTLS zero-knowledge banking transfer settlements**.`,
    extLabel: lang === 'zh' ? 'Chrome TLSN 扩展:' : 'Chrome TLSN Extension:',
    extActive: lang === 'zh' ? '已加载 (Active)' : 'Active',
    extMissing: lang === 'zh' ? '未检测到 (Missing)' : 'Missing',
    dbLabel: lang === 'zh' ? 'Node.js & 数据库:' : 'Node.js & PostgreSQL:',
    dbConnected: lang === 'zh' ? '已启动 (Connected)' : 'Connected',
    dbOffline: lang === 'zh' ? '未连接 (Offline)' : 'Offline',
    verifierLabel: lang === 'zh' ? 'Rust 验证器 (:7047):' : 'Rust Verifier (:7047):',
    verifierOnline: lang === 'zh' ? '已运行 (Online)' : 'Online',
    verifierOffline: lang === 'zh' ? '未探测 (No Health)' : 'Offline',
    bankLabel: lang === 'zh' ? 'SwissBank 网银 (:3000):' : 'SwissBank Bank (:3000):',
    bankActive: lang === 'zh' ? '运行中 (Active)' : 'Active',
    bankOffline: lang === 'zh' ? '离线 (Offline)' : 'Offline',
    disclaimer: lang === 'zh'
      ? '免责声明：本系统为黑客松项目 Demo 演示展示，所载之汇率分析及预测数据仅供参考，不构成任何真实的投资与理财决策建议。'
      : 'Disclaimer: This system is a hackathon project demo. The FX analysis and predictions provided are for reference only and do not constitute actual financial or investment advice.',
    techStack: lang === 'zh'
      ? `技术栈: Vite + React 19 + TypeScript | Node.js + Express | PostgreSQL + pgvector | ${modelTech} | TLSNotary`
      : `Technology Stack: Vite + React 19 + TypeScript | Node.js + Express | PostgreSQL + pgvector | ${modelTech} | TLSNotary`,
  };
};

export function App() {
  const [lang, setLang] = useState<'zh' | 'en'>('zh');
  const [currentRate, setCurrentRate] = useState(7.285);
  const [pair, setPair] = useState('USD/CNY');
  const [amount, setAmount] = useState('1000');
  const [horizon, setHorizon] = useState('3d');
  const [analysis, setAnalysis] = useState<any>(null);
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    if (typeof window !== 'undefined' && window.matchMedia) {
      return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    }
    return 'dark';
  });
  const [activeAI, setActiveAI] = useState<{ provider: string; model: string }>({ provider: 'gemini', model: 'gemini-2.5-flash' });

  // AI Agent States
  const [logs, setLogs] = useState<Array<{ time: string; text: string }>>([
    { time: new Date().toLocaleTimeString(), text: '🤖 FX Hedging Agent initialized.' },
    { time: new Date().toLocaleTimeString(), text: '📡 Sensors active. Polling Polymarket Gamma API...' }
  ]);
  const [showLogsDrawer, setShowLogsDrawer] = useState(false);
  const [speechMessage, setSpeechMessage] = useState<string | null>(null);
  const [showSpeech, setShowSpeech] = useState(false);

  const addLog = (text: string) => {
    setLogs(prev => [
      ...prev,
      { time: new Date().toLocaleTimeString(), text }
    ].slice(-35));
  };

  useEffect(() => {
    if (theme === 'light') {
      document.body.classList.add('light-mode');
    } else {
      document.body.classList.remove('light-mode');
    }
  }, [theme]);

  // 监听系统偏好色彩模式的变化
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mediaQuery = window.matchMedia('(prefers-color-scheme: light)');
    const handleChange = (e: MediaQueryListEvent) => {
      setTheme(e.matches ? 'light' : 'dark');
    };
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  // 监听 C2CTradeCard 通过 window 事件发送的 zkTLS 日志
  useEffect(() => {
    const handleAgentLog = (e: Event) => {
      const customEvent = e as CustomEvent;
      addLog(customEvent.detail);
    };
    window.addEventListener('agent-log', handleAgentLog);
    return () => window.removeEventListener('agent-log', handleAgentLog);
  }, []);

  // 监听用户参数并生成日志
  useEffect(() => {
    addLog(`🔄 分析货币对切换为 ${pair}。正在启动 pgvector 向量检索匹配...`);
    const text = lang === 'zh'
      ? `📡 感知：检测到兑换对变更为 ${pair}。我已向 pgvector 发起语义召回以重新对齐外部事件风险。`
      : `📡 Perceived: Currency pair switched to ${pair}. Emitted semantic recall to pgvector to re-align risk factors.`;
    setSpeechMessage(text);
    setShowSpeech(true);
  }, [pair]);

  useEffect(() => {
    addLog(`💰 计划兑换金额更新为 ${amount}。重新计算滑点和点差折损...`);
  }, [amount]);

  useEffect(() => {
    addLog(`⏱️ 观察周期偏好切换为 ${horizon === '1d' ? '短期(1天)' : horizon === '3d' ? '中期(3天)' : '长期(7天)'}。重新过滤央行重大事件窗口...`);
  }, [horizon]);

  useEffect(() => {
    if (analysis) {
      if (analysis.provider && analysis.model) {
        setActiveAI({ provider: analysis.provider, model: analysis.model });
      }
      addLog(`📡 RAG 数据匹配成功。已关联到 ${analysis.polymarketData?.length || 0} 个相关的 Polymarket 宏观预测盘口。`);
      
      // 打印长期记忆检索状态
      if (analysis.longTermMemories && analysis.longTermMemories.length > 0) {
        addLog(`🧠 [Long-term Memory] 从 Hy-Memory (127.0.0.1:19527) 检索到 ${analysis.longTermMemories.length} 条关于您历史行为的长期记忆。`);
        analysis.longTermMemories.forEach((m: any, idx: number) => {
          addLog(`   ↪ 💾 历史记忆 [${idx + 1}]: "${m.content || m.text || JSON.stringify(m)}"`);
        });
      } else {
        addLog(`🧠 [Long-term Memory] 从 Hy-Memory 检索完成。当前用户对该币种暂无长期记忆沉淀。`);
      }

      const signal = analysis.analysis?.signal || 'NOW';
      const confidence = analysis.analysis?.confidence || 85;
      const coreModel = analysis.provider === 'hunyuan' ? 'Tencent Hunyuan' : 'Google Gemini';
      addLog(`🧠 AI 决策器 (${coreModel}) 推荐时机信号：[${signal}]，可信度：${confidence}%。`);
    }
  }, [analysis]);

  // 定时气泡提示
  useEffect(() => {
    const timer = setTimeout(() => {
      if (analysis) {
        const isZh = lang === 'zh';
        const signal = analysis.analysis?.signal || 'NOW';
        const confidence = analysis.analysis?.confidence || 85;
        
        let text = "";
        if (isZh) {
          text = `提示：通过 Polymarket 聚合共识预测分析，当前兑换时机评级为【${signal === 'NOW' ? '现在兑换' : signal === 'WAIT' ? '等待观察' : '保持观望'}】（置信度 ${confidence}%）。建议点击左下角“查看决策详情”获取深度套保数据支撑。`;
        } else {
          text = `Agent Alert: Based on Polymarket aggregate consensus, the swap timing rating is [${signal}] with ${confidence}% confidence. Click "View Decision Details" to review the RAG indicators.`;
        }
        setSpeechMessage(text);
        setShowSpeech(true);
      } else {
        const text = lang === 'zh'
          ? "您好！我是您的智能外汇套保 Agent。我正在实时监听 Polymarket 宏观预测赔率，并为您计算点差及滑点深度。"
          : "Hello! I am your FX Hedging Agent. I monitor Polymarket odds and liquidity depth in real time to suggest optimal swap timing.";
        setSpeechMessage(text);
        setShowSpeech(true);
      }
    }, 3000);

    return () => clearTimeout(timer);
  }, [lang, analysis]);
  
  // 系统四大服务健康检查状态
  const [status, setStatus] = useState<SystemStatus>({
    extension: 'missing',
    nodeBackend: 'error',
    rustVerifier: 'error',
    swissBank: 'error',
  });

  const checkServices = async () => {
    const newStatus: SystemStatus = {
      extension: typeof window !== 'undefined' && (window as any).tlsn ? 'ok' : 'missing',
      nodeBackend: 'error',
      rustVerifier: 'error',
      swissBank: 'error',
    };

    const currentHost = typeof window !== 'undefined' ? window.location.hostname : 'localhost';

    // 1. 探测 Node.js 后端服务
    try {
      const apiUrl = import.meta.env.VITE_API_URL || `http://${currentHost}:3001`;
      const res = await fetch(`${apiUrl}/api/health`);
      if (res.ok) {
        newStatus.nodeBackend = 'ok';
        const data = await res.json();
        if (data.provider && data.model) {
          setActiveAI({ provider: data.provider, model: data.model });
        }
      }
    } catch (e) {
      newStatus.nodeBackend = 'error';
    }

    // 2. 探测 Rust Verifier 服务 (:7047)
    try {
      const res = await fetch(`http://${currentHost}:7047/health`);
      if (res.ok) newStatus.rustVerifier = 'ok';
    } catch (e) {
      newStatus.rustVerifier = 'error';
    }

    // 3. 探测 SwissBank 网银服务 (:3000)
    try {
      const res = await fetch(`http://${currentHost}:3000/account`);
      if (res.status === 200 || res.status === 404) newStatus.swissBank = 'ok';
    } catch (e) {
      newStatus.swissBank = 'error';
    }

    setStatus(newStatus);
  };

  useEffect(() => {
    checkServices();
    const interval = setInterval(checkServices, 5000); // 每 5 秒轮询检查一次状态
    return () => clearInterval(interval);
  }, []);

  const handleRateChange = (rate: number, selectedPair: string) => {
    setCurrentRate(rate);
    setPair(selectedPair);
  };

  const t = getT(lang, activeAI);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem', minHeight: '90vh' }}>
      
      {/* 头部标题区域 */}
      <header style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: '0.75rem', marginTop: '1rem', position: 'relative', width: '100%' }}>
        <div style={{ position: 'absolute', right: '10px', top: '0px', display: 'flex', gap: '8px' }}>
          <button
            onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.08)',
              padding: '6px 14px',
              borderRadius: '20px',
              color: 'inherit',
              cursor: 'pointer',
              fontSize: '0.85rem',
              fontWeight: 600,
              transition: 'all 0.2s ease',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'rgba(255,255,255,0.1)';
              e.currentTarget.style.borderColor = 'rgba(255,255,255,0.2)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'rgba(255,255,255,0.04)';
              e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)';
            }}
          >
            {theme === 'dark' ? <Sun size={14} color="var(--primary)" /> : <Moon size={14} color="var(--primary)" />}
            <span>{theme === 'dark' ? (lang === 'zh' ? '白天' : 'Light') : (lang === 'zh' ? '黑夜' : 'Dark')}</span>
          </button>

          <button
            onClick={() => setLang(l => l === 'zh' ? 'en' : 'zh')}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.08)',
              padding: '6px 14px',
              borderRadius: '20px',
              color: 'inherit',
              cursor: 'pointer',
              fontSize: '0.85rem',
              fontWeight: 600,
              transition: 'all 0.2s ease',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'rgba(255,255,255,0.1)';
              e.currentTarget.style.borderColor = 'rgba(255,255,255,0.2)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'rgba(255,255,255,0.04)';
              e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)';
            }}
          >
            <Languages size={14} color="var(--primary)" />
            <span>{lang === 'zh' ? 'English' : '简体中文'}</span>
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: 'rgba(99, 102, 241, 0.1)', padding: '6px 16px', borderRadius: '30px', border: '1px solid rgba(99, 102, 241, 0.2)' }}>
          <Shield size={16} color="var(--primary)" />
          <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-highlight)', letterSpacing: '0.05em' }}>AI + zkTLS C2C SWAP HUB</span>
        </div>
        <h1 style={{ fontSize: '2.5rem', fontWeight: 800, margin: 0 }} className="gradient-text">
          FX Intel Exchange Platform
        </h1>
        <p 
          style={{ margin: 0, color: 'var(--text-muted)', maxWidth: '640px', fontSize: '1rem', lineHeight: '1.5' }}
          dangerouslySetInnerHTML={{ __html: t.subtitle }}
        />
      </header>

      {/* 服务健康状态检查指示条 */}
      <section
        className="glass-card"
        style={{
          padding: '0.75rem 1.5rem',
          display: 'flex',
          justifyContent: 'space-around',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '1rem',
          background: 'rgba(255,255,255,0.01)',
          borderColor: 'rgba(255,255,255,0.04)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.85rem' }}>
          <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: status.extension === 'ok' ? 'var(--success)' : 'var(--danger)' }} />
          <span style={{ color: 'var(--text-muted)' }}>{t.extLabel}</span>
          <strong style={{ color: status.extension === 'ok' ? 'var(--text-primary)' : 'var(--danger)' }}>
            {status.extension === 'ok' ? t.extActive : t.extMissing}
          </strong>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.85rem' }}>
          <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: status.nodeBackend === 'ok' ? 'var(--success)' : 'var(--danger)' }} />
          <Database size={14} color="var(--text-muted)" />
          <span style={{ color: 'var(--text-muted)' }}>{t.dbLabel}</span>
          <strong style={{ color: status.nodeBackend === 'ok' ? 'var(--text-primary)' : 'var(--danger)' }}>
            {status.nodeBackend === 'ok' ? t.dbConnected : t.dbOffline}
          </strong>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.85rem' }}>
          <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: status.rustVerifier === 'ok' ? 'var(--success)' : 'var(--warning)' }} />
          <Server size={14} color="var(--text-muted)" />
          <span style={{ color: 'var(--text-muted)' }}>{t.verifierLabel}</span>
          <strong style={{ color: status.rustVerifier === 'ok' ? 'var(--text-primary)' : 'var(--warning)' }}>
            {status.rustVerifier === 'ok' ? t.verifierOnline : t.verifierOffline}
          </strong>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.85rem' }}>
          <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: status.swissBank === 'ok' ? 'var(--success)' : 'var(--danger)' }} />
          <Cpu size={14} color="var(--text-muted)" />
          <span style={{ color: 'var(--text-muted)' }}>{t.bankLabel}</span>
          <strong style={{ color: status.swissBank === 'ok' ? 'var(--text-primary)' : 'var(--danger)' }}>
            {status.swissBank === 'ok' ? t.bankActive : t.bankOffline}
          </strong>
        </div>
      </section>

      {/* 主面板分栏区 */}
      <main
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(320px, 1.2fr) minmax(320px, 1fr)',
          gap: '2rem',
          alignItems: 'start',
        }}
      >
        {/* 左侧：FX Intel 决策看板 */}
        <FxIntelPanel 
          onRateChange={handleRateChange} 
          lang={lang}
          amount={amount}
          setAmount={setAmount}
          horizon={horizon}
          setHorizon={setHorizon}
          onAnalysisUpdate={setAnalysis}
        />

        {/* 右侧：C2C 交易卡片 */}
        <C2CTradeCard 
          currentRate={currentRate} 
          pair={pair} 
          lang={lang} 
          amount={amount}
          setAmount={setAmount}
          analysis={analysis}
        />
      </main>

      {/* 底部声明区域 */}
      <footer style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem', opacity: 0.6, fontSize: '0.8rem', textAlign: 'center', padding: '1rem 0' }}>
        <div>
          {t.techStack}
        </div>
        <div className="disclaimer-text" style={{ display: 'flex', alignItems: 'center', gap: '4px', maxWidth: '90%' }}>
          <HelpCircle size={12} style={{ flexShrink: 0, color: 'var(--warning)' }} />
          <span style={{ color: 'var(--warning)' }}>{t.disclaimer}</span>
        </div>
      </footer>

      {/* 强制小改下三栏布局以支持移动端响应式 */}
      <style>{`
        @media (max-width: 900px) {
          main {
            grid-template-columns: 1fr !important;
          }
        }
      `}</style>

      {/* AI Agent Floating Assistant Bot */}
      <div className="agent-assistant-container">
        {/* Proactive Speech Bubble */}
        {showSpeech && speechMessage && (
          <div className="agent-speech-bubble">
            <button 
              onClick={() => setShowSpeech(false)} 
              style={{
                position: 'absolute',
                top: '6px',
                right: '6px',
                background: 'none',
                border: 'none',
                color: 'var(--text-muted)',
                cursor: 'pointer',
                padding: '2px'
              }}
            >
              <X size={12} />
            </button>
            <div style={{ paddingRight: '12px' }}>
              {speechMessage}
            </div>
          </div>
        )}

        {/* Floating Bot Sphere */}
        <div 
          className="agent-avatar-sphere" 
          onClick={() => {
            setShowLogsDrawer(!showLogsDrawer);
            setShowSpeech(false);
          }}
          title={lang === 'zh' ? '查看 AI Agent 运行日志' : 'View AI Agent Logs'}
        >
          <Bot size={28} color="white" />
          {/* Pulsing indicator badge */}
          {showSpeech && <div className="agent-badge" />}
        </div>
      </div>

      {/* Terminal-like Agent Logs Drawer */}
      {showLogsDrawer && (
        <div className="agent-log-drawer">
          <div className="agent-log-header">
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.8rem', fontWeight: 'bold' }}>
              <Terminal size={14} color="var(--primary)" />
              <span className="gradient-text">
                {lang === 'zh' ? 'Agent 决策运行日志' : 'Agent Decision Runtime Logs'}
              </span>
            </div>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <button 
                onClick={() => setLogs([{ time: new Date().toLocaleTimeString(), text: '🧹 Log cleared.' }])}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--text-muted)',
                  cursor: 'pointer',
                  fontSize: '0.7rem'
                }}
              >
                {lang === 'zh' ? '清空' : 'Clear'}
              </button>
              <button 
                onClick={() => setShowLogsDrawer(false)} 
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--text-muted)',
                  cursor: 'pointer',
                  padding: '2px'
                }}
              >
                <X size={14} />
              </button>
            </div>
          </div>
          <div className="agent-log-terminal">
            {logs.map((log, index) => (
              <div key={index} style={{ lineHeight: '1.4' }}>
                <span style={{ color: 'var(--text-muted)', marginRight: '6px' }}>[{log.time}]</span>
                <span>{log.text}</span>
              </div>
            ))}
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginTop: '4px' }}>
              <span style={{ width: '4px', height: '12px', background: '#34d399', display: 'inline-block', animation: 'badgeBlink 1s infinite' }} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
export default App;

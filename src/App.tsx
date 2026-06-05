import { useState, useEffect } from 'react';
import { FxIntelPanel } from './components/FxIntelPanel';
import { C2CTradeCard } from './components/C2CTradeCard';
import { Shield, Database, Cpu, HelpCircle, Server, Languages, Sun, Moon } from 'lucide-react';

interface SystemStatus {
  extension: 'ok' | 'missing';
  nodeBackend: 'ok' | 'error';
  rustVerifier: 'ok' | 'error';
  swissBank: 'ok' | 'error';
}

const T = {
  zh: {
    subtitle: '结合了 **Gemini 2.5 AI 时机分析决策 (FX Intel)** 与 **zkTLS 零知识证明网银转账清算** 的去中心化、可信 C2C 汇率交易辅助平台。',
    extLabel: 'Chrome TLSN 扩展:',
    extActive: '已加载 (Active)',
    extMissing: '未检测到 (Missing)',
    dbLabel: 'Node.js & 数据库:',
    dbConnected: '已启动 (Connected)',
    dbOffline: '未连接 (Offline)',
    verifierLabel: 'Rust 验证器 (:7047):',
    verifierOnline: '已运行 (Online)',
    verifierOffline: '未探测 (No Health)',
    bankLabel: 'SwissBank 网银 (:3000):',
    bankActive: '运行中 (Active)',
    bankOffline: '离线 (Offline)',
    disclaimer: '免责声明：本系统为黑客松项目 Demo 演示展示，所载之汇率分析及预测数据仅供参考，不构成任何真实的投资与理财决策建议。',
    techStack: '技术栈: Vite + React 19 + TypeScript | Node.js + Express | PostgreSQL + pgvector | Gemini-2.5-flash | TLSNotary',
  },
  en: {
    subtitle: 'A decentralized, trustless C2C FX trading assistant platform combining **Gemini 2.5 AI timing analysis & decisions (FX Intel)** and **zkTLS zero-knowledge banking transfer settlements**.',
    extLabel: 'Chrome TLSN Extension:',
    extActive: 'Active',
    extMissing: 'Missing',
    dbLabel: 'Node.js & PostgreSQL:',
    dbConnected: 'Connected',
    dbOffline: 'Offline',
    verifierLabel: 'Rust Verifier (:7047):',
    verifierOnline: 'Online',
    verifierOffline: 'Offline',
    bankLabel: 'SwissBank Bank (:3000):',
    bankActive: 'Active',
    bankOffline: 'Offline',
    disclaimer: 'Disclaimer: This system is a hackathon project demo. The FX analysis and predictions provided are for reference only and do not constitute actual financial or investment advice.',
    techStack: 'Technology Stack: Vite + React 19 + TypeScript | Node.js + Express | PostgreSQL + pgvector | Gemini-2.5-flash | TLSNotary',
  }
};

export function App() {
  const [lang, setLang] = useState<'zh' | 'en'>('zh');
  const [currentRate, setCurrentRate] = useState(7.285);
  const [pair, setPair] = useState('USD/CNY');
  const [amount, setAmount] = useState('1000');
  const [horizon, setHorizon] = useState('3d');
  const [analysis, setAnalysis] = useState<any>(null);
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');

  useEffect(() => {
    if (theme === 'light') {
      document.body.classList.add('light-mode');
    } else {
      document.body.classList.remove('light-mode');
    }
  }, [theme]);
  
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

    // 1. 探测 Node.js 后端服务
    try {
      const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:3001';
      const res = await fetch(`${apiUrl}/api/fx-intel?base=USD&quote=CNY`);
      if (res.ok) newStatus.nodeBackend = 'ok';
    } catch (e) {
      newStatus.nodeBackend = 'error';
    }

    // 2. 探测 Rust Verifier 服务 (:7047)
    try {
      const res = await fetch('http://localhost:7047/health');
      if (res.ok) newStatus.rustVerifier = 'ok';
    } catch (e) {
      newStatus.rustVerifier = 'error';
    }

    // 3. 探测 SwissBank 网银服务 (:3000)
    try {
      const res = await fetch('http://localhost:3000/account');
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

  const t = T[lang];

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
    </div>
  );
}
export default App;

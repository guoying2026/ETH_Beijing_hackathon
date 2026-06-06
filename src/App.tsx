import { useState, useEffect } from 'react';
import { FxIntelPanel } from './components/FxIntelPanel';
import { C2CTradeCard } from './components/C2CTradeCard';
import { DashboardPanel } from './components/DashboardPanel';
import { MerchantPanel } from './components/MerchantPanel';
import { AdminPanel } from './components/AdminPanel';
import { Shield, HelpCircle, Languages, Sun, Moon, Bot, Terminal, X, User, Store, ShieldAlert, Wallet, Download, AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, RefreshCw } from 'lucide-react';
import { createPublicClient, http } from 'viem';
import { hardhat, sepolia } from 'viem/chains';

const ADMIN_ADDRESS = (import.meta.env.VITE_C2C_ADMIN_ADDRESS || '').toLowerCase() as `0x${string}`;
const ESCROW_ADDRESS = (import.meta.env.VITE_C2C_ESCROW_ADDRESS || '').toLowerCase() as `0x${string}`;
const RISK_MANAGER_ADDRESS = (import.meta.env.VITE_C2C_RISK_MANAGER_ADDRESS || '').toLowerCase() as `0x${string}`;
const BOND_VAULT_ADDRESS = (import.meta.env.VITE_C2C_BOND_VAULT_ADDRESS || '').toLowerCase() as `0x${string}`;
const USDT_ADDRESS = (import.meta.env.VITE_USDT_ADDRESS || '').toLowerCase() as `0x${string}`;
const MERCHANT_ADDRESS = (import.meta.env.VITE_MERCHANT_ADDRESS || '').toLowerCase() as `0x${string}`;

const CHAIN_ID = Number(import.meta.env.VITE_CHAIN_ID || '11155111');
const targetChain = CHAIN_ID === 11155111 ? sepolia : hardhat;
const targetRpcUrl = import.meta.env.VITE_RPC_URL || 'https://rpc.ankr.com/eth_sepolia';

const publicClient = createPublicClient({
  chain: targetChain,
  transport: http(targetRpcUrl)
});

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
  const [appTab, setAppTab] = useState<'trade' | 'dashboard' | 'merchant' | 'admin'>('trade');
  const [account, setAccount] = useState<`0x${string}` | null>(null);
  const [hasExtension, setHasExtension] = useState<boolean>(false);
  const [showGuide, setShowGuide] = useState<boolean>(false);

  useEffect(() => {
    const check = () => {
      setHasExtension(!!(window as any).tlsn);
    };
    check();
    const interval = setInterval(check, 1000);
    return () => clearInterval(interval);
  }, []);

  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const handleCopyExtensionsUrl = (e: React.MouseEvent) => {
    e.preventDefault();
    navigator.clipboard.writeText("chrome://extensions/");
    setToastMessage(lang === 'zh' ? "📋 已复制扩展页地址！请粘贴到新标签页打开" : "📋 Copied! Paste into a new tab to open.");
    setTimeout(() => {
      setToastMessage(null);
    }, 2000);
  };

  const handleRecheckExtension = () => {
    const detected = !!(window as any).tlsn;
    setHasExtension(detected);
    if (detected) {
      setToastMessage(lang === 'zh' ? "✅ zkTLS 扩展检测成功，已成功加载并激活！" : "✅ zkTLS extension detected and activated successfully!");
      setShowGuide(false);
    } else {
      setToastMessage(lang === 'zh' ? "❌ 未检测到 zkTLS 扩展！请确认已在管理页中“启用”该插件并刷新。" : "❌ Extension not detected! Please ensure it is enabled in settings and refresh.");
    }
    setTimeout(() => {
      setToastMessage(null);
    }, 3000);
  };

  const checkAndSwitchNetwork = async (ethereum: any) => {
    try {
      const targetChainIdHex = `0x${CHAIN_ID.toString(16)}`;
      const currentChainId = await ethereum.request({ method: 'eth_chainId' });
      if (currentChainId !== targetChainIdHex) {
        try {
          await ethereum.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: targetChainIdHex }],
          });
        } catch (switchError: any) {
          if (switchError.code === 4902) {
            await ethereum.request({
              method: 'wallet_addEthereumChain',
              params: [
                {
                  chainId: targetChainIdHex,
                  chainName: targetChain.name,
                  rpcUrls: [import.meta.env.VITE_RPC_URL || 'http://127.0.0.1:8545'],
                  nativeCurrency: {
                    name: 'ETH',
                    symbol: 'ETH',
                    decimals: 18,
                  },
                },
              ],
            });
          } else {
            console.error('Failed to switch network:', switchError);
          }
        }
      }
    } catch (err) {
      console.error('Error switching network:', err);
    }
  };

  const connectWallet = async () => {
    const ethereum = typeof window !== 'undefined' ? (window as any).ethereum : undefined;
    if (typeof ethereum !== 'undefined') {
      try {
        const addresses = await ethereum.request({ method: 'eth_requestAccounts' });
        if (addresses.length > 0) {
          setAccount(addresses[0] as `0x${string}`);
          await checkAndSwitchNetwork(ethereum);
        }
      } catch (err) {
        console.error(err);
      }
    } else {
      alert(lang === 'zh' ? '未检测到 MetaMask 钱包插件！' : 'MetaMask not detected!');
    }
  };

  useEffect(() => {
    const ethereum = typeof window !== 'undefined' ? (window as any).ethereum : undefined;
    if (typeof ethereum !== 'undefined') {
      ethereum.request({ method: 'eth_accounts' })
        .then((accounts: string[]) => {
          if (accounts.length > 0) {
            setAccount(accounts[0] as `0x${string}`);
            checkAndSwitchNetwork(ethereum);
          }
        })
        .catch(console.error);

      const handleAccountsChanged = (accounts: string[]) => {
        if (accounts.length > 0) {
          setAccount(accounts[0] as `0x${string}`);
          checkAndSwitchNetwork(ethereum);
        } else {
          setAccount(null);
        }
      };

      const handleChainChanged = () => {
        window.location.reload();
      };

      ethereum.on('accountsChanged', handleAccountsChanged);
      ethereum.on('chainChanged', handleChainChanged);
      return () => {
        ethereum?.removeListener('accountsChanged', handleAccountsChanged);
        ethereum?.removeListener('chainChanged', handleChainChanged);
      };
    }
  }, []);

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
            onClick={connectWallet}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              background: account ? 'rgba(16, 185, 129, 0.1)' : 'rgba(99, 102, 241, 0.1)',
              border: account ? '1px solid rgba(16, 185, 129, 0.2)' : '1px solid rgba(99, 102, 241, 0.2)',
              padding: '6px 14px',
              borderRadius: '20px',
              color: account ? '#10b981' : 'inherit',
              cursor: account ? 'default' : 'pointer',
              fontSize: '0.85rem',
              fontWeight: 600,
              transition: 'all 0.2s ease',
            }}
          >
            <Wallet size={14} color={account ? '#10b981' : 'var(--primary)'} />
            <span>
              {account 
                ? `${account.slice(0, 6)}...${account.slice(-4)}` 
                : (lang === 'zh' ? '连接钱包' : 'Connect Wallet')}
            </span>
          </button>

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
      </header>

      {/* zkTLS Extension Downloader & Guide Banner */}
      <div 
        style={{
          width: '100%',
          background: hasExtension 
            ? (theme === 'light' ? '#ecfdf5' : 'rgba(16, 185, 129, 0.05)') 
            : (theme === 'light' ? '#fffbeb' : 'rgba(245, 158, 11, 0.08)'),
          border: hasExtension 
            ? (theme === 'light' ? '1px solid #a7f3d0' : '1px solid rgba(16, 185, 129, 0.2)') 
            : (theme === 'light' ? '1px solid #fde68a' : '1px solid rgba(245, 158, 11, 0.25)'),
          borderRadius: '12px',
          padding: '12px 18px',
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
          fontSize: '0.9rem',
          transition: 'all 0.3s ease',
          boxShadow: hasExtension 
            ? (theme === 'light' ? '0 4px 12px rgba(16, 185, 129, 0.08)' : '0 4px 20px rgba(16, 185, 129, 0.03)') 
            : (theme === 'light' ? '0 4px 12px rgba(245, 158, 11, 0.08)' : '0 4px 20px rgba(245, 158, 11, 0.05)'),
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
          <div 
            style={{ 
              display: 'flex', 
              alignItems: 'center', 
              gap: '8px', 
              color: hasExtension 
                ? (theme === 'light' ? '#065f46' : 'var(--success)') 
                : (theme === 'light' ? '#92400e' : 'var(--warning)') 
            }}
          >
            {hasExtension ? (
              <CheckCircle2 size={18} color={theme === 'light' ? '#059669' : 'var(--success)'} style={{ flexShrink: 0 }} />
            ) : (
              <AlertTriangle size={18} color={theme === 'light' ? '#d97706' : 'var(--warning)'} style={{ flexShrink: 0 }} />
            )}
            <span style={{ fontWeight: 600 }}>
              {hasExtension ? (
                lang === 'zh' ? '检测到 zkTLS 浏览器扩展插件已启用。已开启 MPC 安全计算，您可正常进行商户入驻或转账验证。' : 'zkTLS browser extension detected and active! Ready for MPC notary.'
              ) : (
                lang === 'zh' ? '未检测到 zkTLS 浏览器扩展插件！本系统使用零知识证明以确保交易真实性，请先下载并安装扩展插件。' : 'zkTLS browser extension not detected! This system requires the companion extension for zkTLS notary.'
              )}
            </span>
          </div>

          <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
            {!hasExtension && (
              <a 
                href="/zkTLS-extension.zip" 
                download="zkTLS-extension.zip"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  background: 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)',
                  color: 'white',
                  textDecoration: 'none',
                  padding: '6px 14px',
                  borderRadius: '20px',
                  fontSize: '0.8rem',
                  fontWeight: 700,
                  boxShadow: '0 4px 12px rgba(245, 158, 11, 0.3)',
                  transition: 'transform 0.2s ease',
                }}
                onMouseEnter={(e) => e.currentTarget.style.transform = 'translateY(-1px)'}
                onMouseLeave={(e) => e.currentTarget.style.transform = 'translateY(0)'}
              >
                <Download size={14} />
                <span>{lang === 'zh' ? '📥 下载 zkTLS 扩展包 (ZIP)' : '📥 Download extension (ZIP)'}</span>
              </a>
            )}

            {!hasExtension && (
              <button
                onClick={handleRecheckExtension}
                className="recheck-btn"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  background: theme === 'light' ? '#eef2ff' : 'rgba(99, 102, 241, 0.15)',
                  border: theme === 'light' ? '1px solid #dbeafe' : '1px solid rgba(99, 102, 241, 0.3)',
                  padding: '6px 14px',
                  borderRadius: '20px',
                  color: theme === 'light' ? '#4f46e5' : 'var(--text-highlight)',
                  cursor: 'pointer',
                  fontSize: '0.8rem',
                  fontWeight: 700,
                  transition: 'all 0.2s ease',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = theme === 'light' ? '#e0e7ff' : 'rgba(99, 102, 241, 0.25)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = theme === 'light' ? '#eef2ff' : 'rgba(99, 102, 241, 0.15)';
                }}
              >
                <RefreshCw size={12} className="recheck-icon" style={{ transition: 'transform 0.3s ease' }} />
                <span>{lang === 'zh' ? '🔄 重新检测' : '🔄 Re-detect'}</span>
              </button>
            )}
            
            <button
              onClick={() => setShowGuide(!showGuide)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
                background: theme === 'light' ? '#ffffff' : 'rgba(255, 255, 255, 0.05)',
                border: theme === 'light' ? '1px solid #d1d5db' : '1px solid rgba(255, 255, 255, 0.1)',
                padding: '6px 12px',
                borderRadius: '20px',
                color: theme === 'light' ? '#374151' : 'inherit',
                cursor: 'pointer',
                fontSize: '0.8rem',
                fontWeight: 600,
                transition: 'all 0.2s ease',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = theme === 'light' ? '#f3f4f6' : 'rgba(255, 255, 255, 0.1)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = theme === 'light' ? '#ffffff' : 'rgba(255, 255, 255, 0.05)';
              }}
            >
              <span>{lang === 'zh' ? '安装与配置指南' : 'Installation Guide'}</span>
              {showGuide ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>
          </div>
        </div>

        {showGuide && (
          <div 
            style={{
              background: theme === 'light' ? '#ffffff' : 'rgba(0, 0, 0, 0.25)',
              borderRadius: '8px',
              padding: '14px',
              border: theme === 'light' ? '1px solid #e5e7eb' : '1px solid rgba(255, 255, 255, 0.05)',
              display: 'flex',
              flexDirection: 'column',
              gap: '12px',
              lineHeight: '1.6',
              boxShadow: theme === 'light' ? '0 4px 15px rgba(0, 0, 0, 0.05)' : 'none',
            }}
          >
            <div 
              style={{ 
                fontWeight: 700, 
                fontSize: '0.95rem', 
                borderBottom: theme === 'light' ? '1px solid #e5e7eb' : '1px solid rgba(255, 255, 255, 0.08)', 
                paddingBottom: '6px', 
                color: theme === 'light' ? '#1f2937' : 'var(--text-highlight)' 
              }}
            >
              {lang === 'zh' ? '🛠️ 极简手动安装说明' : '🛠️ Simple Manual Installation Instructions'}
            </div>
            
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '14px' }}>
              <div style={{ display: 'flex', gap: '8px' }}>
                <div className="step-badge-circle" style={{ width: '22px', height: '22px', borderRadius: '50%', background: 'var(--primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold', fontSize: '0.75rem', flexShrink: 0 }}>1</div>
                <div>
                  <div style={{ fontWeight: 600, fontSize: '0.85rem', color: 'var(--text-primary)' }}>{lang === 'zh' ? '下载并解压扩展包' : 'Download & Extract'}</div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                    {lang === 'zh' ? '点击上方下载 zip 压缩包，下载完成后必须在本地进行解压（建议解压到独立文件夹中）。' : 'Click download above to get the zip file. Be sure to extract it locally (recommended into a dedicated folder).'}
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <div className="step-badge-circle" style={{ width: '22px', height: '22px', borderRadius: '50%', background: 'var(--primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold', fontSize: '0.75rem', flexShrink: 0 }}>2</div>
                <div>
                  <div style={{ fontWeight: 600, fontSize: '0.85rem', color: 'var(--text-primary)' }}>{lang === 'zh' ? '进入 Chrome 扩展管理' : 'Open Extensions Page'}</div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                    {lang === 'zh' ? (
                      <span>打开 Chrome 浏览器，访问 <a href="chrome://extensions/" onClick={handleCopyExtensionsUrl} style={{ textDecoration: 'underline', color: theme === 'light' ? '#4f46e5' : 'var(--primary)', cursor: 'pointer', fontWeight: 600 }}>chrome://extensions/</a>。</span>
                    ) : (
                      <span>Go to <a href="chrome://extensions/" onClick={handleCopyExtensionsUrl} style={{ textDecoration: 'underline', color: theme === 'light' ? '#4f46e5' : 'var(--primary)', cursor: 'pointer', fontWeight: 600 }}>chrome://extensions/</a> in your Chrome browser.</span>
                    )}
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <div className="step-badge-circle" style={{ width: '22px', height: '22px', borderRadius: '50%', background: 'var(--primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold', fontSize: '0.75rem', flexShrink: 0 }}>3</div>
                <div>
                  <div style={{ fontWeight: 600, fontSize: '0.85rem', color: 'var(--text-primary)' }}>{lang === 'zh' ? '启用“开发者模式”' : 'Enable Developer Mode'}</div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                    {lang === 'zh' ? '在扩展管理页面右上角，将“开发者模式”开关打开。' : 'In the upper-right corner of the page, switch the "Developer mode" toggle on.'}
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <div className="step-badge-circle" style={{ width: '22px', height: '22px', borderRadius: '50%', background: 'var(--primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold', fontSize: '0.75rem', flexShrink: 0 }}>4</div>
                <div>
                  <div style={{ fontWeight: 600, fontSize: '0.85rem', color: 'var(--text-primary)' }}>{lang === 'zh' ? '加载解压扩展' : 'Load Unpacked'}</div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                    {lang === 'zh' ? '点击左上角“加载已解压的扩展程序”按钮，选择您在第1步中解压好的文件夹；亦可尝试直接拖拽 zip 包加载。' : 'Click "Load unpacked" on the top-left and select the extracted folder from Step 1; you can also try dragging the zip file.'}
                  </div>
                </div>
              </div>
            </div>
            
            <div 
              style={{ 
                display: 'flex', 
                alignItems: 'center', 
                gap: '6px', 
                background: theme === 'light' ? '#eef2ff' : 'rgba(99, 102, 241, 0.05)', 
                border: theme === 'light' ? '1px solid #dbeafe' : '1px solid rgba(99, 102, 241, 0.1)', 
                padding: '8px 12px', 
                borderRadius: '6px', 
                fontSize: '0.8rem', 
                color: theme === 'light' ? '#1e40af' : 'var(--text-highlight)' 
              }}
            >
              <HelpCircle size={14} style={{ flexShrink: 0 }} />
              <span>
                {lang === 'zh' ? (
                  <span><b>网络提示</b>：若您当前使用的是 ngrok 外网代理域名访问此页面，下载链接将直接通过外网分发。安装扩展并登录网银/支付宝即可在本地与 Rust 验证服务交互并签名上链。</span>
                ) : (
                  <span><b>Network Note</b>: If accessing via ngrok, the download works seamlessly. Once installed, the extension connects to local verifier to generate proof for on-chain registry.</span>
                )}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* 导航 Tab 切换栏 */}
      <nav style={{
        display: 'flex',
        background: 'rgba(255, 255, 255, 0.02)',
        border: '1px solid rgba(255, 255, 255, 0.05)',
        borderRadius: '12px',
        padding: '6px',
        gap: '8px',
        justifyContent: 'center',
        flexWrap: 'wrap',
        backdropFilter: 'blur(10px)'
      }}>
        {[
          { key: 'trade', label: lang === 'zh' ? 'Swap & AI 分析' : 'Swap & AI', icon: <Bot size={16} /> },
          { key: 'dashboard', label: lang === 'zh' ? '个人控制面板' : 'User Dashboard', icon: <User size={16} /> },
          { key: 'merchant', label: lang === 'zh' ? '承兑商终端' : 'Merchant Terminal', icon: <Store size={16} /> },
          { key: 'admin', label: lang === 'zh' ? '管理控制台' : 'Admin Console', icon: <ShieldAlert size={16} /> }
        ].map((item) => {
          const isActive = appTab === item.key;
          return (
            <button
              key={item.key}
              onClick={() => setAppTab(item.key as any)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                background: isActive ? 'linear-gradient(135deg, #6366f1 0%, #a855f7 100%)' : 'transparent',
                border: 'none',
                padding: '8px 16px',
                borderRadius: '8px',
                color: isActive ? 'white' : 'var(--text-muted)',
                cursor: 'pointer',
                fontWeight: 600,
                fontSize: '0.9rem',
                transition: 'all 0.2s ease',
                boxShadow: isActive ? '0 4px 12px rgba(99, 102, 241, 0.3)' : 'none'
              }}
              onMouseEnter={(e) => {
                if (!isActive) e.currentTarget.style.color = 'var(--text-primary)';
              }}
              onMouseLeave={(e) => {
                if (!isActive) e.currentTarget.style.color = 'var(--text-muted)';
              }}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>

      {/* 主面板内容渲染区 */}
      {appTab === 'trade' && (
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
            account={account}
            connectWallet={connectWallet}
          />
        </main>
      )}

      {appTab === 'dashboard' && (
        <DashboardPanel
          account={account}
          connectWallet={connectWallet}
          lang={lang}
          theme={theme}
          USDT_ADDRESS={USDT_ADDRESS}
          ESCROW_ADDRESS={ESCROW_ADDRESS}
          ADMIN_ADDRESS={ADMIN_ADDRESS}
          RISK_MANAGER_ADDRESS={RISK_MANAGER_ADDRESS}
          BOND_VAULT_ADDRESS={BOND_VAULT_ADDRESS}
          MERCHANT_ADDRESS={MERCHANT_ADDRESS}
          targetChain={targetChain}
          publicClient={publicClient}
        />
      )}

      {appTab === 'merchant' && (
        <MerchantPanel
          account={account}
          connectWallet={connectWallet}
          lang={lang}
          theme={theme}
          USDT_ADDRESS={USDT_ADDRESS}
          ESCROW_ADDRESS={ESCROW_ADDRESS}
          ADMIN_ADDRESS={ADMIN_ADDRESS}
          RISK_MANAGER_ADDRESS={RISK_MANAGER_ADDRESS}
          BOND_VAULT_ADDRESS={BOND_VAULT_ADDRESS}
          MERCHANT_ADDRESS={MERCHANT_ADDRESS}
          targetChain={targetChain}
          publicClient={publicClient}
        />
      )}

      {appTab === 'admin' && (
        <AdminPanel
          account={account}
          connectWallet={connectWallet}
          lang={lang}
          theme={theme}
          USDT_ADDRESS={USDT_ADDRESS}
          ESCROW_ADDRESS={ESCROW_ADDRESS}
          ADMIN_ADDRESS={ADMIN_ADDRESS}
          RISK_MANAGER_ADDRESS={RISK_MANAGER_ADDRESS}
          BOND_VAULT_ADDRESS={BOND_VAULT_ADDRESS}
          MERCHANT_ADDRESS={MERCHANT_ADDRESS}
          targetChain={targetChain}
          publicClient={publicClient}
        />
      )}

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
        @keyframes slideDownFadeIn {
          from {
            opacity: 0;
            transform: translate(-50%, -20px);
          }
          to {
            opacity: 1;
            transform: translate(-50%, 0);
          }
        }
        .recheck-btn:hover .recheck-icon {
          transform: rotate(180deg);
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

      {/* Global Minimalist Toast */}
      {toastMessage && (
        <div style={{
          position: 'fixed',
          top: '24px',
          left: '50%',
          transform: 'translateX(-50%)',
          background: 'rgba(15, 12, 38, 0.95)',
          backdropFilter: 'blur(16px)',
          border: '1px solid rgba(16, 185, 129, 0.3)',
          color: '#34d399',
          padding: '12px 24px',
          borderRadius: '30px',
          boxShadow: '0 8px 32px 0 rgba(0, 0, 0, 0.4)',
          fontSize: '0.85rem',
          fontWeight: 600,
          zIndex: 1100,
          pointerEvents: 'none',
          animation: 'slideDownFadeIn 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
        }}>
          <span>{toastMessage}</span>
        </div>
      )}
    </div>
  );
}
export default App;

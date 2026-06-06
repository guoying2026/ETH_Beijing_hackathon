import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Landmark, ArrowRight, ShieldCheck, CheckCircle, RotateCw, AlertCircle, RefreshCw, X, ExternalLink } from 'lucide-react';
import { createPublicClient, createWalletClient, custom, http, formatUnits, parseUnits, keccak256, stringToBytes, encodePacked, parseEventLogs } from 'viem';
import { hardhat, sepolia } from 'viem/chains';
import { C2C_ADMIN_ABI, C2C_ESCROW_ABI, C2C_RISK_MANAGER_ABI, ERC20_ABI } from '../lib/contractAbi';

const getEthereum = () => typeof window !== 'undefined' ? (window as any).ethereum : undefined;


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


interface Props {
  currentRate: number;
  pair: string;
  lang: 'zh' | 'en';
  amount: string;
  setAmount: (amt: string) => void;
  analysis: any;
  account: `0x${string}` | null;
  connectWallet: () => Promise<void>;
}

type Tab = 'express' | 'p2p';
type TradeStep = 'input' | 'pay' | 'proving' | 'success' | 'error';

const T = {
  zh: {
    expressTab: 'Express (极速换汇)',
    p2pTab: 'P2P Market (承兑集市)',
    sendAmount: '支付金额',
    receiveAmount: '预计收到',
    escrowDesc: '🔒 **zkTLS 安全担保机制**：资金暂存于链上托管智能合约。当你使用网银证明转账成功后，智能合约会通过密码学方式自动释放托管资产给您，全程去中心化防跑路。',
    btnExchange: '立即安全兑换',
    p2pDesc: '商家锁定保证金在智能合约中，请选择一位承兑商发起交易：',
    orders: '订单量',
    completion: '完成率',
    limit: '限额',
    tradeBtn: '交易',
    escrowTitle: 'C2C 订单托管清算',
    step1Title: '第一步：向承兑商转账付款',
    bankLabel: '承兑商网银：',
    bankName: 'Swiss Bank (瑞士银行)',
    nameLabel: '承兑商户名：',
    accLabel: '承兑商账号：',
    amtLabel: '应转账金额：',
    step2Title: '第二步：生成付款的密码学证明 (zkTLS)',
    step2Desc: '转账完成后，点击下方按钮唤醒 TLSNotary。插件会弹出瑞士银行网银窗口进行核实，自动剥离你的账户隐私字段，仅将 “向承兑商转账 {amount} USD” 的汇款凭证上传智能合约解锁放款。',
    verifyBtn: 'Verify with zkTLS',
    mockBtn: 'Mock 模拟演示',
    backEdit: '返回修改金额',
    loadingTitle: '正在生成 zkTLS 转账证明',
    complete: '完成',
    successTitle: '交易结算成功！',
    successDesc: '密码学证明通过验证，智能合约已解锁托管池。你应得的 **{amount} {quote}** 已成功存入你的钱包账户中！',
    newTrade: '开启新一笔交易',
    failTitle: 'zkTLS 证明验证失败',
    retryBtn: '重新尝试生成证明',
    backOrder: '返回转账订单页',
    errNoExtension: '未检测到 TLSNotary 浏览器扩展！请先按照页面顶部指示在 Chrome 中安装扩展，或点击下方“Mock 演示”免插件体验。',
    errPluginCode: '无法读取内置的瑞士银行插件代码。',
    errVerificationFail: '证明生成失败，请确认您已运行本地的 7047 验证器 and 3000 模拟银行，并在弹窗中成功生成了证明。',
    initMessage: '初始化托管合约，请在承兑商网银完成 1,000 USD 的模拟汇款。',
    msgConnecting: '🔐 正在与瑞士网银建立加密 TLS 连接...',
    msgProving: '⚡ 正在生成 zkTLS 密码学转账凭证...',
    msgComplete: '✅ zkTLS 证明生成成功！正在提交智能合约释放资金...',
    msgBankLoad: '正在加载网银证明插件...',
    msgMockConnecting: '🔐 正在与瑞士网银建立加密 TLS 连接...',
    msgMockRedacting: '⚡ 正在获取账单详情并遮蔽您的密码和账号隐私字段...',
    msgMockProving: '🛡️ 正在生成不可伪造的零知识证明...',
    msgMockSuccess: '✅ zkTLS 证明验证成功！智能合约正在释放托管的 CNY...',
    defaultProveMsg: '请在弹出的网银窗口中登录并完成转账。',
  },
  en: {
    expressTab: 'Express Swap',
    p2pTab: 'P2P Market',
    sendAmount: 'Pay Amount',
    receiveAmount: 'Expected Received',
    escrowDesc: '🔒 **zkTLS Security Escrow**: Funds are safely locked in an on-chain escrow smart contract. Once you verify your bank transfer success using zkTLS, the contract automatically releases the assets to you, fully decentralized and counterparty-risk free.',
    btnExchange: 'Exchange Securely Now',
    p2pDesc: 'Merchants have locked margins in the contract. Select a merchant to trade:',
    orders: 'Orders',
    completion: 'Completion',
    limit: 'Limit',
    tradeBtn: 'Trade',
    escrowTitle: 'C2C Escrow & Settlement',
    step1Title: 'Step 1: Transfer Payment to Merchant',
    bankLabel: 'Merchant Bank:',
    bankName: 'Swiss Bank (SwissBank)',
    nameLabel: 'Recipient Name:',
    accLabel: 'Recipient Account:',
    amtLabel: 'Transfer Amount:',
    step2Title: 'Step 2: Generate Cryptographic Proof (zkTLS)',
    step2Desc: 'After transfer, click the button below to invoke TLSNotary. The extension will open Swiss Bank, verify the transfer, redact your privacy details, and upload only the proof of "sent {amount} USD to merchant" to release funds.',
    verifyBtn: 'Verify with zkTLS',
    mockBtn: 'Mock Demo',
    backEdit: 'Back to Edit Amount',
    loadingTitle: 'Generating zkTLS Proof',
    complete: 'Complete',
    successTitle: 'Transaction Settled!',
    successDesc: 'Cryptographic proof verified. The smart contract has released the escrow. Your **{amount} {quote}** has been successfully deposited into your wallet!',
    newTrade: 'Start New Trade',
    failTitle: 'zkTLS Proof Failed',
    retryBtn: 'Retry Generating Proof',
    backOrder: 'Back to Order Page',
    errNoExtension: 'TLSNotary extension not detected! Please install it in Chrome following the instructions at the top, or click "Mock Demo" below to experience it.',
    errPluginCode: 'Failed to read built-in Swiss Bank plugin code.',
    errVerificationFail: 'Proof generation failed. Verify that your local 7047 verifier and 3000 SwissBank are running, and you successfully completed the popup flow.',
    initMessage: 'Initializing escrow contract. Please complete the mock 1,000 USD transfer in SwissBank.',
    msgConnecting: '🔐 Establishing encrypted TLS connection with Swiss Bank...',
    msgProving: '⚡ Generating zkTLS cryptographic transfer proof...',
    msgComplete: '✅ zkTLS proof generated successfully! Submitting to contract to release funds...',
    msgBankLoad: 'Loading banking proof plugin...',
    msgMockConnecting: '🔐 Establishing encrypted TLS connection with Swiss Bank...',
    msgMockRedacting: '⚡ Fetching bill details & redacting password and account privacy fields...',
    msgMockProving: '🛡️ Generating unforgeable zero-knowledge proof...',
    msgMockSuccess: '✅ zkTLS proof verified! Smart contract is releasing escrowed CNY...',
    defaultProveMsg: 'Please log in and complete transfer in the bank window.',
  }
};

export function C2CTradeCard({ currentRate, pair, lang, amount, setAmount, analysis, account, connectWallet }: Props) {
  const [activeTab, setActiveTab] = useState<Tab>('express');
  const [step, setStep] = useState<TradeStep>('input');
  const [showDecisionModal, setShowDecisionModal] = useState(false);
  
  // 使用 App.tsx 传递的共享金额状态
  const sendAmount = amount;
  const setSendAmount = setAmount;
  const [receiveAmount, setReceiveAmount] = useState('');
  
  const t = T[lang];

  // 兼容直接传入的 analysis 和包裹在整个 json 中的数据
  const parsedAnalysis = analysis?.analysis ? analysis.analysis : (analysis?.signal ? analysis : null);
  const polymarketData = analysis?.polymarketData || [];

  // zkTLS 证明生成状态
  const [proveMessage, setProveMessage] = useState(t.defaultProveMsg);
  const [proveProgress, setProveProgress] = useState(0);
  const [requestId, setRequestId] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  const [realtimeData, setRealtimeData] = useState<Record<string, { loading: boolean; data?: any[]; error?: boolean }>>({});

  const handleMouseEnter = async (slug: string) => {
    if (!slug) return;
    if (realtimeData[slug]) return; // Already loading or loaded

    setRealtimeData(prev => ({
      ...prev,
      [slug]: { loading: true }
    }));

    try {
      const response = await fetch(`https://gamma-api.polymarket.com/events?slug=${slug}`);
      if (!response.ok) throw new Error(`HTTP error ${response.status}`);
      const json = await response.json();
      if (Array.isArray(json) && json.length > 0) {
        const eventObj = json[0];
        if (eventObj.markets && Array.isArray(eventObj.markets)) {
          const activeMarkets = eventObj.markets.filter((m: any) => m.active && !m.closed);
          const parsed = activeMarkets.map((m: any) => {
            let prices: any[] = [];
            if (typeof m.outcomePrices === 'string') {
              try {
                prices = JSON.parse(m.outcomePrices);
              } catch (_) {}
            } else if (Array.isArray(m.outcomePrices)) {
              prices = m.outcomePrices;
            }
            const yesPrice = prices.length > 0 ? parseFloat(prices[0]) : 0;
            const optionTitle = m.groupItemTitle || m.question || '';
            return {
              title: optionTitle,
              odds: Number(yesPrice.toFixed(2))
            };
          });

          setRealtimeData(prev => ({
            ...prev,
            [slug]: { loading: false, data: parsed }
          }));
          return;
        }
      }
      throw new Error('No active markets found in response');
    } catch (err) {
      console.error(`Failed to fetch real-time odds for slug ${slug}:`, err);
      setRealtimeData(prev => ({
        ...prev,
        [slug]: { loading: false, error: true }
      }));
    }
  };

  const [base, quote] = pair.split('/');

  // Web3 state
  const [ethBalance, setEthBalance] = useState<string>('0');
  const [usdtBalance, setUsdtBalance] = useState<string>('0');
  const [requiredBondBps, setRequiredBondBps] = useState<number>(1000); // 默认 10%
  const [riskLevel, setRiskLevel] = useState<number>(0);
  const [isFrozen, setIsFrozen] = useState<boolean>(false);
  const [contractProducts, setContractProducts] = useState<any[]>([]);
  const [selectedProduct, setSelectedProduct] = useState<any>(null);


  const checkAndSwitchNetwork = async () => {
    const ethereum = getEthereum();
    if (typeof ethereum !== 'undefined') {
      const chainId = await ethereum.request({ method: 'eth_chainId' });
      const targetChainIdHex = CHAIN_ID === 11155111 ? '0xaa36a7' : '0x7a69';
      if (chainId !== targetChainIdHex) {
        try {
          await ethereum.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: targetChainIdHex }],
          });
        } catch (switchError: any) {
          if (switchError.code === 4902) {
            try {
              if (CHAIN_ID === 11155111) {
                await ethereum.request({
                  method: 'wallet_addEthereumChain',
                  params: [{
                    chainId: '0xaa36a7',
                    chainName: 'Sepolia Testnet',
                    nativeCurrency: { name: 'SepoliaETH', symbol: 'SepoliaETH', decimals: 18 },
                    rpcUrls: [targetRpcUrl],
                  }],
                });
              } else {
                await ethereum.request({
                  method: 'wallet_addEthereumChain',
                  params: [{
                    chainId: '0x7a69',
                    chainName: 'Localhost 8545',
                    nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
                    rpcUrls: ['http://localhost:8545'],
                  }],
                });
              }
            } catch (addError) {
              console.error(addError);
            }
          } else {
            console.error(switchError);
          }
        }
      }
    }
  };



  // Fetch balances & reputation
  useEffect(() => {
    if (!account) return;

    const fetchUserData = async () => {
      try {
        const ethBal = await publicClient.getBalance({ address: account });
        setEthBalance(formatUnits(ethBal, 18));

        const usdtBal = await publicClient.readContract({
          address: USDT_ADDRESS,
          abi: ERC20_ABI,
          functionName: 'balanceOf',
          args: [account],
        }) as bigint;
        setUsdtBalance(formatUnits(usdtBal, 18));

        const rep = await publicClient.readContract({
          address: RISK_MANAGER_ADDRESS,
          abi: C2C_RISK_MANAGER_ABI,
          functionName: 'getReputation',
          args: [account],
        }) as any;
        
        const bps = await publicClient.readContract({
          address: RISK_MANAGER_ADDRESS,
          abi: C2C_RISK_MANAGER_ABI,
          functionName: 'requiredBondBps',
          args: [account],
        }) as number;

        setRequiredBondBps(bps);
        setRiskLevel(rep.riskLevel ?? rep[4]);
        setIsFrozen(Boolean((rep.temporarilyFrozen ?? rep[5]) || (rep.blacklisted ?? rep[6])));
      } catch (err) {
        console.error('Error fetching user on-chain data:', err);
      }
    };

    fetchUserData();
    const interval = setInterval(fetchUserData, 5000);
    return () => clearInterval(interval);
  }, [account]);

  // Load contract products
  const loadContractProducts = async () => {
    try {
      const fetched = [];
      for (const pId of [0n, 1n]) {
        // 去掉内部的 try-catch，让任何查询错误直接向外抛出
        const prodInfo = await publicClient.readContract({
          address: ESCROW_ADDRESS,
          abi: C2C_ESCROW_ABI,
          functionName: 'getProductInfo',
          args: [MERCHANT_ADDRESS, pId, 0],
        }) as any;

        const rateInfo = await publicClient.readContract({
          address: ADMIN_ADDRESS,
          abi: C2C_ADMIN_ABI,
          functionName: 'getMerchantRate',
          args: [MERCHANT_ADDRESS, pId, 0],
        }) as any;

        const isOpen = await publicClient.readContract({
          address: ADMIN_ADDRESS,
          abi: C2C_ADMIN_ABI,
          functionName: 'isMerchantOpen',
          args: [MERCHANT_ADDRESS, pId, 0],
        }) as boolean;

        const platformId = (prodInfo.platformId ?? prodInfo[4]) as `0x${string}`;
        let platformName = 'Unknown';
        const platformIdLower = platformId.toLowerCase();
        const wiseId = keccak256(stringToBytes('wise')).toLowerCase();
        const alipayId = keccak256(stringToBytes('alipay')).toLowerCase();

        if (platformIdLower === wiseId) {
          platformName = 'Wise';
        } else if (platformIdLower === alipayId) {
          platformName = 'Alipay';
        }

        const rateVal = Number(rateInfo.rate ?? rateInfo[0]) / 1e8;

        fetched.push({
          productId: pId,
          platformId,
          platformName,
          rate: rateVal,
          rateVersion: rateInfo.version ?? rateInfo[1],
          availableAmount: prodInfo.availableAmount ?? prodInfo[7],
          isOpen
        });
      }
      setContractProducts(fetched);
    } catch (err) {
      console.error('Failed to load contract products from chain:', err);
      setContractProducts([]);
      // 抛出异常，不再掩盖
      throw err;
    }
  };

  useEffect(() => {
    loadContractProducts().catch(err => {
      console.error('Failed to fetch chain products in useEffect:', err);
    });
    // Removed 10s high-frequency interval polling to prevent RPC throttling and verbose console errors
  }, [pair]);

  // Construct resolved P2P merchants list using contract data (no mock fallback)
  const resolvedP2pMerchants = contractProducts.map((p) => {
    const limitMax = Number(formatUnits(p.availableAmount, 18)).toFixed(0);
    const name = p.platformName === 'Alipay'
      ? (lang === 'zh' ? '支付宝承兑商 (Alipay)' : 'Alipay Merchant')
      : (lang === 'zh' ? 'Wise承兑商 (Wise)' : 'Wise Merchant');
    return {
      name,
      platformName: p.platformName,
      productId: p.productId,
      rate: p.rate,
      limit: `0 - ${limitMax}`,
      orders: 1845,
      completion: '99.8%',
      isOpen: p.isOpen,
      platformId: p.platformId
    };
  });

  // 直接使用从链上成功读取到的商户列表，不带 mock 兜底
  const p2pMerchants = resolvedP2pMerchants;

  // 动态更新初始消息
  useEffect(() => {
    if (step === 'input') {
      setProveMessage(t.defaultProveMsg);
    }
  }, [lang, step]);

  // 动态根据汇率算出兑换额度
  useEffect(() => {
    const amt = parseFloat(sendAmount);
    if (!isNaN(amt) && currentRate) {
      setReceiveAmount((amt * currentRate).toFixed(2));
    } else {
      setReceiveAmount('');
    }
  }, [sendAmount, currentRate, pair]);

  // 开启清算流程
  const handleInitiateTrade = () => {
    let prod = contractProducts.find(p => p.platformName.toLowerCase() === (pair.includes('CNY') ? 'alipay' : 'wise'));
    if (!prod && contractProducts.length > 0) {
      prod = contractProducts[0];
    }
    
    // 如果没有可用的链上交易产品，直接拦截报错
    if (!prod) {
      const errText = lang === 'zh' 
        ? '合约中未找到可用的交易产品，请确认合约已成功部署并已上架商品！' 
        : 'No available products found on the contract. Please ensure deployment and listing are complete.';
      console.error(errText);
      setErrorMsg(errText);
      setStep('error');
      return;
    }
    
    const resolvedProduct = {
      platformName: prod.platformName,
      productId: prod.productId,
      platformId: prod.platformId,
      rate: prod.rate
    };

    setSelectedProduct(resolvedProduct);
    setStep('pay');
    setErrorMsg('');
    setProveProgress(0);
    setProveMessage(t.initMessage);
  };

  // 监听插件进度消息
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;

      if (event.data?.type === 'TLSN_PROVE_PROGRESS' && event.data.requestId === requestId) {
        const { step: proveStep, progress, message } = event.data;
        
        setProveProgress(Math.round(progress * 100));
        
        if (proveStep === 'CONNECTING') {
          setProveMessage(t.msgConnecting);
        } else if (proveStep === 'PROVING') {
          setProveMessage(t.msgProving);
        } else if (proveStep === 'COMPLETE') {
          setProveMessage(t.msgComplete);
        } else if (message) {
          setProveMessage(message);
        }
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [requestId, lang]);

  // 真实唤起浏览器插件生成网银付款证明
  const handleVerifyZkTls = async (isMock: boolean = false) => {
    const logToAgent = (msg: string) => {
      window.dispatchEvent(new CustomEvent('agent-log', { detail: msg }));
    };

    const saveTransactionMemory = async () => {
      try {
        await fetch('/api/save-memory', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: `用户 EOA ${account} 在即期汇率 1 ${base} = ${currentRate.toFixed(4)} ${quote} 时，成功通过 zkTLS 零知识证明锁定并结算了金额为 ${sendAmount} ${base} 的 C2C 汇率合约交易。`,
            userId: 'guoying_dev'
          })
        });
        logToAgent('🧠 [Long-term Memory] 已将此次 zkTLS 交易记录主动沉淀至腾讯混元 Hy-Memory 长期记忆中。');
      } catch (e) {
        console.warn('Failed to save long term memory:', e);
      }
    };

    if (isMock) {
      logToAgent('🔐 准备启动 zkTLS 虚拟公证证明流程...');
      setStep('proving');
      setProveProgress(10);
      setProveMessage(t.msgMockConnecting);
      logToAgent('🌐 正在模拟与瑞士网银建立加密 TLS 链接 (MPC 模式)...');
      
      await new Promise(r => setTimeout(r, 1200));
      setProveProgress(45);
      setProveMessage(t.msgMockRedacting);
      logToAgent('⚡ 正在抓取账单详情，智能脱敏隐私字段，遮蔽密码与账号余额...');
      
      await new Promise(r => setTimeout(r, 1500));
      setProveProgress(80);
      setProveMessage(t.msgMockProving);
      logToAgent('🛡️ 正在生成不可伪造的零知识密码学证明 (zk-Proof)...');
      
      await new Promise(r => setTimeout(r, 1200));
      setProveProgress(100);
      setProveMessage(t.msgMockSuccess);
      logToAgent('✅ zkTLS 证明生成与本地公证验证成功！');
      logToAgent(`🎉 智能合约自动释放资金托管：已将 ${receiveAmount} ${quote} 解锁并划转至您的钱包。`);
      await saveTransactionMemory();
      
      await new Promise(r => setTimeout(r, 1000));
      setStep('success');
      return;
    }

    logToAgent('🔐 准备启动真实的 zkTLS 公证证明流程...');
    if (!account) {
      logToAgent('❌ 请先连接 Web3 钱包！');
      setErrorMsg(lang === 'zh' ? '请先连接钱包' : 'Please connect wallet');
      setStep('error');
      return;
    }

    if (!(window as any).tlsn) {
      logToAgent('❌ 证明失败：未检测到 TLSNotary 浏览器插件！请先在 Chrome 中安装扩展。');
      setErrorMsg(t.errNoExtension);
      setStep('error');
      return;
    }

    await checkAndSwitchNetwork();

    try {
      const walletClient = createWalletClient({
        account,
        chain: targetChain,
        transport: custom((window as any).ethereum)
      });

      const amountBig = parseUnits(sendAmount, 18);
      const productId = selectedProduct ? selectedProduct.productId : (pair.includes('CNY') ? 1n : 0n);
      const platformName = selectedProduct ? selectedProduct.platformName : (pair.includes('CNY') ? 'Alipay' : 'Wise');
      const platformId = selectedProduct ? selectedProduct.platformId : (keccak256(stringToBytes(platformName.toLowerCase())) as `0x${string}`);

      logToAgent(lang === 'zh' ? '📡 步骤 1/4: 检查并授权保证金库 (approve if needed)...' : '📡 Step 1/4: Check and approve BondVault...');
      const estimatedBond = (amountBig * BigInt(requiredBondBps)) / 10000n;
      
      const currentAllowance = await publicClient.readContract({
        address: USDT_ADDRESS,
        abi: ERC20_ABI,
        functionName: 'allowance',
        args: [account, BOND_VAULT_ADDRESS],
      }) as bigint;

      if (currentAllowance < estimatedBond) {
        logToAgent(lang === 'zh' ? '✍️ 请在钱包中确认授权保证金交易...' : '✍️ Please confirm USDT approval in wallet...');
        const MAX_UINT256 = (2n ** 256n) - 1n;
        const approveTx = await walletClient.writeContract({
          address: USDT_ADDRESS,
          abi: ERC20_ABI,
          functionName: 'approve',
          args: [BOND_VAULT_ADDRESS, MAX_UINT256],
        });
        logToAgent(lang === 'zh' ? '⌛ 等待授权交易确认...' : '⌛ Waiting for approval transaction confirmation...');
        await publicClient.waitForTransactionReceipt({ hash: approveTx });
        logToAgent(lang === 'zh' ? '✅ 授权成功！' : '✅ Approval successful!');
      }

      // 检查并自动设置买家的 Platform Binding
      logToAgent(lang === 'zh' ? '📡 正在核对您的链上支付身份绑定...' : '📡 Verifying your on-chain payment binding...');
      const buyerBinding = await publicClient.readContract({
        address: ADMIN_ADDRESS,
        abi: C2C_ADMIN_ABI,
        functionName: 'getPlatformBinding',
        args: [account, platformId],
      }) as any;

      const isBuyerBound = buyerBinding && (typeof buyerBinding === 'object' ? buyerBinding.isSet ?? buyerBinding[2] : false);

      if (!isBuyerBound) {
        logToAgent(lang === 'zh' ? '✍️ 检测到您的钱包尚未绑定网银身份，正在发起一键绑定...' : '✍️ No platform binding detected, initiating one-click binding...');
        
        const dummyName = platformName.toLowerCase() === 'wise' ? 'Wise Buyer' : 'Alipay Buyer';
        const dummyHandle = '@buyer1';
        
        const saltHex = '0x1234567890123456789012345678901234567890123456789012345678901234' as `0x${string}`;
        const nameHash = keccak256(encodePacked(['string', 'bytes32'], [dummyName.trim().toLowerCase().normalize('NFC'), saltHex]));
        const idHash = keccak256(encodePacked(['string', 'bytes32'], [dummyHandle.trim().toLowerCase().normalize('NFC'), saltHex]));

        const bindTx = await walletClient.writeContract({
          address: ADMIN_ADDRESS,
          abi: C2C_ADMIN_ABI,
          functionName: 'setPlatformBinding',
          args: [platformId, nameHash, idHash],
        });

        logToAgent(lang === 'zh' ? '⌛ 等待绑定交易确认...' : '⌛ Waiting for binding transaction confirmation...');
        await publicClient.waitForTransactionReceipt({ hash: bindTx });
        logToAgent(lang === 'zh' ? '✅ 网银身份绑定成功！' : '✅ Platform binding successful!');
      }

      logToAgent(lang === 'zh' ? '📡 步骤 2/4: 发起链上托管下单交易 (placeOrder)...' : '📡 Step 2/4: Submitting placeOrder transaction...');
      const NULL_BUYER_INFO = {
        nameHash: '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`,
        idHash: '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`,
        isSet: false
      };

      const placeTx = await walletClient.writeContract({
        address: ESCROW_ADDRESS,
        abi: C2C_ESCROW_ABI,
        functionName: 'placeOrder',
        args: [MERCHANT_ADDRESS, productId, 0, amountBig, NULL_BUYER_INFO]
      });

      logToAgent(lang === 'zh' ? '⌛ 等待下单交易确认...' : '⌛ Waiting for order placement confirmation...');
      const receipt = await publicClient.waitForTransactionReceipt({ hash: placeTx });

      let orderId = 0n;
      let deadlineVal = 0n;
      const parsedLogs = parseEventLogs({
        abi: C2C_ESCROW_ABI,
        logs: receipt.logs,
        eventName: 'OrderPlaced',
      });
      if (parsedLogs.length > 0) {
        orderId = (parsedLogs[0].args as any).orderId ?? 0n;
        deadlineVal = (parsedLogs[0].args as any).deadline ?? 0n;
      }

      if (orderId === 0n) {
        throw new Error(lang === 'zh' ? '无法解析下单交易日志获取 OrderID' : 'Failed to parse OrderPlaced logs');
      }

      logToAgent(
        lang === 'zh'
          ? `✅ 下单成功！订单 ID: ${orderId.toString()}，最晚付款时间: ${new Date(Number(deadlineVal) * 1000).toLocaleString()}`
          : `✅ Order placed! ID: ${orderId.toString()}, Deadline: ${new Date(Number(deadlineVal) * 1000).toLocaleString()}`
      );

      // 构建 zkTLS 绑定上下文
      logToAgent(lang === 'zh' ? '📡 正在读取合约订单快照以生成绑定哈希...' : '📡 Fetching contract order for binding hash...');
      const order = await publicClient.readContract({
        address: ESCROW_ADDRESS,
        abi: C2C_ESCROW_ABI,
        functionName: 'getOrder',
        args: [MERCHANT_ADDRESS, productId, 0, orderId],
      }) as any;

      const orderRate = order[2] as bigint;
      const orderRateVersion = order[5] as number;
      const orderDeadline = order[3] as bigint;

      const merchantBinding = await publicClient.readContract({
        address: ADMIN_ADDRESS,
        abi: C2C_ADMIN_ABI,
        functionName: 'getPlatformBinding',
        args: [MERCHANT_ADDRESS, platformId],
      }) as any;

      const ctx = {
        escrowAddress: ESCROW_ADDRESS,
        chainId: CHAIN_ID,
        merchant: MERCHANT_ADDRESS,
        buyer: account,
        productId,
        orderId,
        assetType: 0,
        amount: amountBig,
        rate: orderRate,
        rateVersion: orderRateVersion,
        deadline: orderDeadline,
        merchantNameHash: merchantBinding[0],
        merchantIdHash: merchantBinding[1],
        payeeNameHash: merchantBinding[0],
        payeeIdHash: merchantBinding[1],
      };

      const orderBindingHash = keccak256(
        encodePacked(
          [
            'address', 'uint64',
            'address', 'address',
            'uint256', 'uint256',
            'uint8', 'uint256', 'uint256',
            'uint32',
            'uint256',
            'bytes32', 'bytes32',
            'bytes32', 'bytes32',
          ],
          [
            ctx.escrowAddress,
            BigInt(ctx.chainId),
            ctx.merchant,
            ctx.buyer,
            ctx.productId,
            ctx.orderId,
            ctx.assetType,
            ctx.amount,
            ctx.rate,
            Number(ctx.rateVersion),
            ctx.deadline,
            ctx.merchantNameHash,
            ctx.merchantIdHash,
            ctx.payeeNameHash,
            ctx.payeeIdHash,
          ],
        ),
      );

      // 加载对应的证明插件脚本
      const pluginUrl = platformName.toLowerCase() === 'alipay' ? '/plugins/alipay.js' : '/plugins/wise.js';
      logToAgent(lang === 'zh' ? `📡 步骤 3/4: 加载 ${platformName} 证明插件并注入绑定关系...` : `📡 Step 3/4: Loading ${platformName} plugin...`);
      setStep('proving');
      setProveProgress(20);
      setProveMessage(t.msgBankLoad);

      const response = await fetch(pluginUrl);
      if (!response.ok) throw new Error(t.errPluginCode);
      let pluginCode = await response.text();

      // 替换插件中所有的哨兵常量
      pluginCode = pluginCode
        .replace(/"0x0000000000000000000000000000000000000000000000000000000000000001"/g, `"${orderBindingHash}"`)
        .replace(/'0x0000000000000000000000000000000000000000000000000000000000000001'/g, `'${orderBindingHash}'`)
        .replace(/"0x0000000000000000000000000000000000000000000000000000000000000002"/g, `"${ctx.merchantNameHash}"`)
        .replace(/'0x0000000000000000000000000000000000000000000000000000000000000002'/g, `'${ctx.merchantNameHash}'`)
        .replace(/"0x0000000000000000000000000000000000000000000000000000000000000003"/g, `"${ctx.merchantIdHash}"`)
        .replace(/'0x0000000000000000000000000000000000000000000000000000000000000003'/g, `'${ctx.merchantIdHash}'`)
        .replace(/"0x0000000000000000000000000000000000000000000000000000000000000004"/g, `"${ctx.payeeNameHash}"`)
        .replace(/'0x0000000000000000000000000000000000000000000000000000000000000004'/g, `'${ctx.payeeNameHash}'`)
        .replace(/"0x0000000000000000000000000000000000000000000000000000000000000005"/g, `"${ctx.payeeIdHash}"`)
        .replace(/'0x0000000000000000000000000000000000000000000000000000000000000005'/g, `'${ctx.payeeIdHash}'`)
        .replace(/"0x0000000000000000000000000000000000000000000000000000000000000007"/g, `"${account.toLowerCase()}"`)
        .replace(/'0x0000000000000000000000000000000000000000000000000000000000000007'/g, `'${account.toLowerCase()}'`)
        .replace(/"0x0000000000000000000000000000000000000000000000000000000000000008"/g, `"${MERCHANT_ADDRESS.toLowerCase()}"`)
        .replace(/'0x0000000000000000000000000000000000000000000000000000000000000008'/g, `'${MERCHANT_ADDRESS.toLowerCase()}'`);

      if (platformName.toLowerCase() === 'wise') {
        pluginCode = pluginCode
          .replace(/"0x0000000000000000000000000000000000000000000000000000000000000006"/g, `"${orderBindingHash}"`)
          .replace(/'0x0000000000000000000000000000000000000000000000000000000000000006'/g, `'${orderBindingHash}'`);
      }

      // 执行插件
      logToAgent(lang === 'zh' ? '✍️ 正在唤起浏览器插件进行转账支付证明...请在弹出的网银窗口中完成登录' : '✍️ Invoking browser extension for zkTLS proof...');
      setProveProgress(40);
      setProveMessage(t.msgConnecting);

      const reqId = `c2c_trade_${Date.now()}`;
      setRequestId(reqId);

      const resultStr = await (window as any).tlsn.execCode(pluginCode, {
        requestId: reqId,
        sessionData: { mode: 'Mpc' }
      });

      const parsedResult = JSON.parse(resultStr);
      logToAgent('✅ zkTLS 密码学转账凭证生成成功！');

      setProveProgress(80);
      setProveMessage(t.msgComplete);

      // 构建链上提交的 proofs
      const mapDirection = (dir: string) => {
        if (dir === 'RECV') return 'Recv';
        if (dir === 'SENT') return 'Sent';
        return dir;
      };

      const buildContractProofObj = (proof: any) => {
        if (!proof.verifierSignature) {
          throw new Error('verifierSignature is missing in proof');
        }
        const sig = proof.verifierSignature;
        const policyVersionHash = sig.policyVersionHash || keccak256(stringToBytes(sig.policyVersion || 'v1.0.0'));
        
        const revealedItems = proof.results.map((r: any) => ({
          handlerType: r.type,
          part: r.part,
          value: r.value,
          commitment_index: BigInt(r.commitmentIndex ?? 0),
          start_item: BigInt(r.start ?? 0),
          end_item: BigInt(r.end ?? 0),
          start_value: BigInt(r.startValue ?? 0),
          end_value: BigInt(r.endValue ?? r.value?.length ?? 0),
        }));

        const commitmentOpenings = (proof.transcriptCommitOpenings || []).map((o: any) => ({
          blinderHex: o.blinderHex.startsWith('0x') ? o.blinderHex : `0x${o.blinderHex}`,
        }));

        const commitments = (proof.transcriptCommitments || []).map((c: any) => ({
          direction: mapDirection(c.direction ?? 'RECV'),
          hashAlg: c.hashAlg ?? 'Keccak256',
          hashValue: c.hashHex.startsWith('0x') ? c.hashHex : `0x${c.hashHex}`,
        }));

        return {
          chainId: BigInt(sig.chainId ?? 0),
          sessionId: sig.sessionId,
          commitmentsHash: sig.commitmentsHash.startsWith('0x') ? sig.commitmentsHash : `0x${sig.commitmentsHash}`,
          orderBindingHash: sig.orderBindingHash.startsWith('0x') ? sig.orderBindingHash : `0x${sig.orderBindingHash}`,
          policyVersionHash: policyVersionHash.startsWith('0x') ? policyVersionHash : `0x${policyVersionHash}`,
          verifierSignature: sig.signature.startsWith('0x') ? sig.signature : `0x${sig.signature}`,
          revealedItems,
          commitmentOpenings,
          commitments,
          serverName: proof.serverName ?? '',
        };
      };

      let proofsArr = [];
      if (platformName.toLowerCase() === 'wise') {
        const wiseProofs = parsedResult.proofs || parsedResult;
        proofsArr = [
          buildContractProofObj(wiseProofs.contacts),
          buildContractProofObj(wiseProofs.transfer)
        ];
      } else {
        proofsArr = [buildContractProofObj(parsedResult)];
      }

      logToAgent(lang === 'zh' ? '📡 步骤 4/4: 正在提交智能合约释放资金...' : '📡 Step 4/4: Submitting proofs to contract...');
      const payTx = await walletClient.writeContract({
        address: ESCROW_ADDRESS,
        abi: C2C_ESCROW_ABI,
        functionName: 'payOrderByPlatform',
        args: [MERCHANT_ADDRESS, productId, orderId, proofsArr]
      });

      logToAgent(lang === 'zh' ? '⌛ 等待清算放款交易确认...' : '⌛ Waiting for settlement confirmation...');
      await publicClient.waitForTransactionReceipt({ hash: payTx });

      logToAgent(`🎉 智能合约自动结算成功：已将 ${receiveAmount} ${quote} 解锁并存入您的账户。`);
      await saveTransactionMemory();

      setStep('success');
    } catch (err: any) {
      console.error('❌ C2C transaction failed:', err);
      logToAgent(`❌ 交易发生错误：${err.message || '未知错误'}`);
      setErrorMsg(err.message || t.errVerificationFail);
      setStep('error');
    }
  };

  return (
    <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', minHeight: '480px' }}>
      
      {/* 钱包连接与链上状态栏 */}
      <div style={{
        background: 'rgba(255, 255, 255, 0.02)',
        border: '1px solid rgba(255, 255, 255, 0.05)',
        borderRadius: '12px',
        padding: '12px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        fontSize: '0.85rem'
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>
            {lang === 'zh' ? 'EOA 钱包账户' : 'EOA Wallet'}
          </span>
          {account ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{
                fontFamily: 'monospace',
                color: 'var(--success)',
                fontWeight: 600,
                background: 'rgba(16, 185, 129, 0.1)',
                padding: '2px 8px',
                borderRadius: '6px'
              }}>
                {account.slice(0, 6)}...{account.slice(-4)}
              </span>
            </div>
          ) : (
            <button
              onClick={connectWallet}
              className="btn-primary"
              style={{
                padding: '4px 12px',
                fontSize: '0.8rem',
                borderRadius: '6px',
                margin: 0
              }}
            >
              {lang === 'zh' ? '连接钱包' : 'Connect Wallet'}
            </button>
          )}
        </div>

        {account && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '8px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ color: 'var(--text-muted)' }}>{lang === 'zh' ? 'USDT 可用余额' : 'USDT Balance'}</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <strong style={{ color: 'var(--text-primary)' }}>{Number(usdtBalance).toFixed(2)} USDT</strong>
                <button
                  onClick={async () => {
                    if (!account) return;
                    try {
                      const ethereum = typeof window !== 'undefined' ? (window as any).ethereum : undefined;
                      if (!ethereum) return;
                      const walletClient = createWalletClient({
                        account,
                        chain: targetChain,
                        transport: custom(ethereum)
                      });
                      const mintAmount = parseUnits("1000", 18);
                      const txHash = await walletClient.writeContract({
                        address: USDT_ADDRESS,
                        abi: [
                          ...ERC20_ABI,
                          {
                            type: 'function',
                            name: 'mint',
                            inputs: [
                              { name: 'to', type: 'address' },
                              { name: 'amount', type: 'uint256' }
                            ],
                            outputs: [{ name: '', type: 'bool' }],
                            stateMutability: 'nonpayable'
                          }
                        ],
                        functionName: 'mint',
                        args: [account, mintAmount],
                      });
                      alert(lang === 'zh' ? `领水交易已发送，获得 1000 USDT\nHash: ${txHash}` : `Faucet tx sent, received 1000 USDT\nHash: ${txHash}`);
                    } catch (e: any) {
                      console.error(e);
                      alert(e.message || e);
                    }
                  }}
                  style={{
                    padding: '2px 8px',
                    fontSize: '0.7rem',
                    background: 'rgba(255,255,255,0.08)',
                    border: '1px solid rgba(255,255,255,0.15)',
                    borderRadius: '4px',
                    color: 'var(--text-primary)',
                    cursor: 'pointer',
                    transition: 'all 0.2s',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.15)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.08)'; }}
                >
                  {lang === 'zh' ? '领水' : 'Faucet'}
                </button>
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--text-muted)' }}>{lang === 'zh' ? 'ETH 可用余额' : 'ETH Balance'}</span>
              <strong style={{ color: 'var(--text-primary)' }}>{Number(ethBalance).toFixed(4)} ETH</strong>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--text-muted)' }}>{lang === 'zh' ? '链上风控等级 / 保证金比例' : 'Risk Level / Bond Ratio'}</span>
              <span style={{
                color: isFrozen ? 'var(--danger)' : riskLevel === 0 ? 'var(--success)' : 'var(--warning)',
                fontWeight: 600
              }}>
                {isFrozen ? (lang === 'zh' ? '已冻结' : 'FROZEN') : `${lang === 'zh' ? '等级' : 'Level'} ${riskLevel} (${(requiredBondBps / 100).toFixed(1)}%)`}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* 交易模式 Tab */}
      {step === 'input' && (
        <div style={{ display: 'flex', background: 'var(--bg-subcard)', border: '1px solid var(--border-subcard)', borderRadius: '10px', padding: '4px' }}>
          <button
            style={{
              flex: 1,
              background: activeTab === 'express' ? 'var(--bg-subcard-hover)' : 'transparent',
              border: 'none',
              color: activeTab === 'express' ? 'var(--text-primary)' : 'var(--text-muted)',
              padding: '8px',
              borderRadius: '8px',
              cursor: 'pointer',
              fontWeight: 600,
              fontSize: '0.9rem'
            }}
            onClick={() => setActiveTab('express')}
          >
            {t.expressTab}
          </button>
          <button
            style={{
              flex: 1,
              background: activeTab === 'p2p' ? 'var(--bg-subcard-hover)' : 'transparent',
              border: 'none',
              color: activeTab === 'p2p' ? 'var(--text-primary)' : 'var(--text-muted)',
              padding: '8px',
              borderRadius: '8px',
              cursor: 'pointer',
              fontWeight: 600,
              fontSize: '0.9rem'
            }}
            onClick={() => setActiveTab('p2p')}
          >
            {t.p2pTab}
          </button>
        </div>
      )}

      {/* 步骤一：输入和金额折算 (Express Tab) */}
      {step === 'input' && activeTab === 'express' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <div>
            <label style={{ display: 'block', color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: '6px' }}>{t.sendAmount} ({base})</label>
            <div style={{ position: 'relative' }}>
              <input
                type="number"
                value={sendAmount}
                onChange={(e) => setSendAmount(e.target.value)}
                className="input-field"
                placeholder="0.00"
                style={{ paddingRight: '60px' }}
              />
              <span style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', fontWeight: 700, color: 'var(--text-muted)' }}>
                {base}
              </span>
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <div style={{ background: 'rgba(99, 102, 241, 0.1)', color: 'var(--primary)', padding: '8px', borderRadius: '50%' }}>
              <ArrowRight size={20} />
            </div>
          </div>

          <div>
            <label style={{ display: 'block', color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: '6px' }}>{t.receiveAmount} ({quote})</label>
            <div style={{ position: 'relative' }}>
              <input
                type="text"
                value={receiveAmount}
                disabled
                className="input-field"
                style={{ background: 'rgba(255,255,255,0.02)', color: 'var(--success)', fontWeight: 700 }}
              />
              <span style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', fontWeight: 700, color: 'var(--text-muted)' }}>
                {quote}
              </span>
            </div>
          </div>

          {/* AI 换汇决策提示横幅 */}
          {parsedAnalysis && (
            <div
              onClick={() => {
                setShowDecisionModal(true);
                const el = document.getElementById('fx-intel-board');
                if (el) {
                  el.scrollIntoView({ behavior: 'smooth' });
                  // 闪烁高亮反馈
                  el.classList.add('glowing-border');
                  setTimeout(() => el.classList.remove('glowing-border'), 3000);
                }
              }}
              style={{
                cursor: 'pointer',
                borderRadius: '10px',
                padding: '10px 14px',
                fontSize: '0.82rem',
                display: 'flex',
                flexDirection: 'column',
                gap: '4px',
                background: parsedAnalysis.signal === 'NOW'
                  ? 'rgba(16, 185, 129, 0.08)'
                  : parsedAnalysis.signal === 'WAIT'
                    ? 'rgba(245, 158, 11, 0.08)'
                    : 'rgba(239, 68, 68, 0.08)',
                border: `1px solid ${
                  parsedAnalysis.signal === 'NOW'
                    ? 'var(--success)'
                    : parsedAnalysis.signal === 'WAIT'
                      ? 'var(--warning)'
                      : 'var(--danger)'
                }`,
                boxShadow: `0 0 10px ${
                  parsedAnalysis.signal === 'NOW'
                    ? 'rgba(16, 185, 129, 0.1)'
                    : parsedAnalysis.signal === 'WAIT'
                      ? 'rgba(245, 158, 11, 0.1)'
                      : 'rgba(239, 68, 68, 0.1)'
                }`,
                transition: 'all 0.2s ease',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.transform = 'translateY(-1px)';
                e.currentTarget.style.background = parsedAnalysis.signal === 'NOW'
                  ? 'rgba(16, 185, 129, 0.12)'
                  : parsedAnalysis.signal === 'WAIT'
                    ? 'rgba(245, 158, 11, 0.12)'
                    : 'rgba(239, 68, 68, 0.12)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.transform = 'none';
                e.currentTarget.style.background = parsedAnalysis.signal === 'NOW'
                  ? 'rgba(16, 185, 129, 0.08)'
                  : parsedAnalysis.signal === 'WAIT'
                    ? 'rgba(245, 158, 11, 0.08)'
                    : 'rgba(239, 68, 68, 0.08)';
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <strong style={{
                  color: parsedAnalysis.signal === 'NOW'
                    ? '#34d399'
                    : parsedAnalysis.signal === 'WAIT'
                      ? '#fbbf24'
                      : '#f87171',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px'
                }}>
                  {parsedAnalysis.signal === 'NOW' && '✅ '}
                  {parsedAnalysis.signal === 'WAIT' && '⚠️ '}
                  {parsedAnalysis.signal === 'WATCH' && '🔍 '}
                  {lang === 'zh'
                    ? `AI 推荐策略: ${parsedAnalysis.signal === 'NOW' ? '现在兑换 (NOW)' : parsedAnalysis.signal === 'WAIT' ? '等待观察 (WAIT)' : '保持观望 (WATCH)'}`
                    : `AI Timing: ${parsedAnalysis.signal === 'NOW' ? 'Swapping NOW' : parsedAnalysis.signal === 'WAIT' ? 'WAIT for better rates' : 'WATCH market closely'}`
                  }
                </strong>
                <span style={{ fontSize: '0.75rem', opacity: 0.9, color: 'var(--primary)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '2px' }}>
                  {lang === 'zh' ? '查看决策详情' : 'View Details'} ↗
                </span>
              </div>
              <div style={{ color: 'var(--text-primary)', opacity: 0.9, fontSize: '0.8rem' }}>
                {parsedAnalysis.signal === 'WAIT' && (
                  lang === 'zh'
                    ? `预计在观察窗口内可多获得约 ${parsedAnalysis.expected_improvement_pct}% 的额度。方案：${parsedAnalysis.execution_suggestion}`
                    : `Estimated savings: ${parsedAnalysis.expected_improvement_pct}% inside window. Suggestion: ${parsedAnalysis.execution_suggestion}`
                )}
                {parsedAnalysis.signal === 'NOW' && (
                  lang === 'zh'
                    ? `汇率处于历史优势区间，继续等待风险较高。方案：${parsedAnalysis.execution_suggestion}`
                    : `Exchange rate is highly favorable. Suggestion: ${parsedAnalysis.execution_suggestion}`
                )}
                {parsedAnalysis.signal === 'WATCH' && (
                  lang === 'zh'
                    ? `央行事件或地缘风险临近，不确定性为 ${parsedAnalysis.expected_improvement_pct}%。方案：${parsedAnalysis.execution_suggestion}`
                    : `Central bank events or tariff threats near. Suggestion: ${parsedAnalysis.execution_suggestion}`
                )}
              </div>
            </div>
          )}

          <div className="escrow-banner" style={{ borderRadius: '10px', padding: '10px', fontSize: '0.8rem' }}>
            {t.escrowDesc}
          </div>

          <button onClick={handleInitiateTrade} className="btn-primary" style={{ width: '100%', marginTop: '0.5rem' }}>
            {t.btnExchange}
          </button>
        </div>
      )}

      {/* 步骤一：承兑集市 P2P Tab */}
      {step === 'input' && activeTab === 'p2p' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
            {t.p2pDesc}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {p2pMerchants.map((merchant, idx) => (
              <div
                key={idx}
                style={{
                  background: 'rgba(255,255,255,0.02)',
                  border: '1px solid rgba(255,255,255,0.05)',
                  borderRadius: '12px',
                  padding: '12px',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center'
                }}
              >
                <div>
                  <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{merchant.name}</div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                    {t.orders}: {merchant.orders} | {t.completion}: {merchant.completion}
                  </div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                    {t.limit}: {merchant.limit} {base}
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: '1.2rem', fontWeight: 800, color: '#34d399' }}>
                    {merchant.rate.toFixed(4)}
                  </div>
                  <button
                    onClick={() => {
                      const prod = contractProducts.find(p => p.productId === merchant.productId);
                      const resolvedProduct = prod ? {
                        platformName: prod.platformName,
                        productId: prod.productId,
                        platformId: prod.platformId,
                        rate: prod.rate
                      } : {
                        platformName: merchant.platformName,
                        productId: merchant.productId,
                        platformId: merchant.platformId,
                        rate: merchant.rate
                      };
                      setSelectedProduct(resolvedProduct);
                      setStep('pay');
                      setErrorMsg('');
                      setProveProgress(0);
                      setProveMessage(t.initMessage);
                    }}
                    style={{
                      background: 'var(--primary)',
                      border: 'none',
                      color: 'white',
                      padding: '4px 10px',
                      borderRadius: '6px',
                      fontSize: '0.8rem',
                      fontWeight: 600,
                      cursor: 'pointer',
                      marginTop: '4px'
                    }}
                  >
                    {t.tradeBtn}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 步骤二：付款与 zkTLS 验证清算 */}
      {step === 'pay' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--warning)' }}>
            <Landmark size={20} />
            <h3 style={{ margin: 0 }}>{t.escrowTitle}</h3>
          </div>
          
          <div style={{ background: 'rgba(245,158,11,0.03)', border: '1px solid rgba(245,158,11,0.1)', padding: '12px', borderRadius: '10px', fontSize: '0.85rem' }}>
            <div style={{ color: 'var(--text-primary)', fontWeight: 600, marginBottom: '6px' }}>{t.step1Title}</div>
            <div style={{ color: 'var(--text-muted)', display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <div>{t.bankLabel} **{selectedProduct?.platformName || (pair.includes('CNY') ? 'Alipay' : 'Wise')}**</div>
              <div>{t.nameLabel} **{selectedProduct?.platformName?.toLowerCase() === 'alipay' ? 'KELLY LIM HOOI YEN' : 'KAI XU LOOI'}**</div>
              <div>{t.accLabel} **{selectedProduct?.platformName?.toLowerCase() === 'alipay' ? 'kellylimhooiyen@hotmail.com' : '@kaixul1'}**</div>
              <div>{t.amtLabel} <strong style={{ color: 'var(--warning)', fontSize: '1.1rem' }}>{receiveAmount} {quote}</strong></div>
            </div>
          </div>

          <div style={{ background: 'rgba(99,102,241,0.03)', border: '1px solid rgba(99,102,241,0.1)', padding: '12px', borderRadius: '10px', fontSize: '0.85rem' }}>
            <div style={{ color: 'var(--text-primary)', fontWeight: 600, marginBottom: '6px' }}>{t.step2Title}</div>
            <p style={{ color: 'var(--text-muted)', margin: 0, fontSize: '0.8rem', lineHeight: '1.4' }}>
              {lang === 'zh'
                ? `转账完成后，点击下方按钮唤醒 TLSNotary。插件会弹出相应的网银/支付窗口进行核实，自动剥离你的账户隐私字段，仅将 “向承兑商转账 ${receiveAmount} ${quote}” 的汇款凭证上传智能合约解锁放款。`
                : `After transfer, click the button below to invoke TLSNotary. The extension will open the portal, verify the transfer, redact your privacy details, and upload only the proof of "sent ${receiveAmount} ${quote} to merchant" to release funds.`
              }
            </p>
          </div>

          {errorMsg && (
            <div style={{ background: 'rgba(239,68,68,0.05)', border: '1px solid rgba(239,68,68,0.1)', padding: '10px', borderRadius: '8px', color: '#f87171', fontSize: '0.8rem' }}>
              <div style={{ fontWeight: 600, marginBottom: '4px' }}>Error:</div>
              {errorMsg}
            </div>
          )}

          <div style={{ display: 'flex', gap: '0.75rem' }}>
            <button onClick={() => handleVerifyZkTls(false)} className="btn-primary" style={{ flex: 2 }}>
              <ShieldCheck size={18} />
              {t.verifyBtn}
            </button>
            <button
              onClick={() => handleVerifyZkTls(true)}
              style={{
                flex: 1,
                background: 'rgba(255,255,255,0.05)',
                border: '1px solid rgba(255,255,255,0.1)',
                color: 'var(--text-primary)',
                borderRadius: '10px',
                cursor: 'pointer',
                fontWeight: 600,
                fontSize: '0.85rem'
              }}
            >
              {t.mockBtn}
            </button>
          </div>

          <button
            onClick={() => setStep('input')}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              fontSize: '0.85rem',
              textDecoration: 'underline'
            }}
          >
            {t.backEdit}
          </button>
        </div>
      )}

      {/* 步骤三：正在生成密码学证明 */}
      {step === 'proving' && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, gap: '1.5rem', textAlign: 'center', padding: '2rem 1rem' }}>
          <RotateCw size={48} color="var(--primary)" className="spin-animation" style={{ animation: 'spin 2s linear infinite' }} />
          <div>
            <h3 style={{ margin: '0 0 8px 0', color: 'var(--text-primary)' }}>{t.loadingTitle}</h3>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', margin: 0, minHeight: '40px', lineHeight: '1.4' }}>
              {proveMessage}
            </p>
          </div>

          <div style={{ width: '100%', background: 'rgba(255,255,255,0.05)', height: '6px', borderRadius: '3px', overflow: 'hidden' }}>
            <div style={{ width: `${proveProgress}%`, background: 'linear-gradient(90deg, #6366f1, #a885f7)', height: '100%', transition: 'width 0.4s ease' }} />
          </div>
          <span style={{ fontSize: '0.9rem', color: '#a885f7', fontWeight: 700 }}>
            {proveProgress}% {t.complete}
          </span>
        </div>
      )}

      {/* 步骤四：交易成功完成 */}
      {step === 'success' && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, gap: '1.25rem', textAlign: 'center', padding: '2rem 1rem' }}>
          <CheckCircle size={56} color="var(--success)" />
          <div>
            <h2 style={{ margin: '0 0 8px 0', color: 'var(--text-primary)', fontWeight: 800 }}>{t.successTitle}</h2>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', lineHeight: '1.5', margin: 0 }}>
              {t.successDesc.replace('{amount}', receiveAmount).replace('{quote}', quote)}
            </p>
          </div>
          <button onClick={() => setStep('input')} className="btn-primary" style={{ width: '100%', marginTop: '1rem' }}>
            {t.newTrade}
          </button>
        </div>
      )}

      {/* 步骤五：失败或发生异常 */}
      {step === 'error' && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, gap: '1.25rem', textAlign: 'center', padding: '2rem 1rem' }}>
          <AlertCircle size={56} color="var(--danger)" />
          <div>
            <h3 style={{ margin: '0 0 8px 0', color: 'var(--text-primary)' }}>{t.failTitle}</h3>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', lineHeight: '1.4', margin: 0 }}>
              {errorMsg || t.errVerificationFail}
            </p>
          </div>
          
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', width: '100%', marginTop: '1rem' }}>
            <button onClick={() => handleVerifyZkTls(false)} className="btn-primary" style={{ width: '100%' }}>
              <RefreshCw size={16} />
              {t.retryBtn}
            </button>
            <button
              onClick={() => setStep('pay')}
              style={{
                width: '100%',
                background: 'rgba(255,255,255,0.05)',
                border: 'none',
                color: 'var(--text-primary)',
                padding: '8px',
                borderRadius: '10px',
                fontWeight: 600,
                cursor: 'pointer'
              }}
            >
              {t.backOrder}
            </button>
          </div>
        </div>
      )}
      
      {/* 注入旋转动画 CSS */}
      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        @keyframes fadeIn {
          from { opacity: 0; transform: scale(0.97); }
          to { opacity: 1; transform: scale(1); }
        }
      `}</style>

      {/* AI 换汇决策详情模态框 */}
      {showDecisionModal && parsedAnalysis && createPortal(
        <div
          onClick={() => setShowDecisionModal(false)}
          style={{
            position: 'fixed',
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
            width: '100vw',
            height: '100vh',
            backgroundColor: 'rgba(0, 0, 0, 0.7)',
            backdropFilter: 'blur(10px)',
            WebkitBackdropFilter: 'blur(10px)',
            zIndex: 99999,
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            padding: '1rem',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="glass-card"
            style={{
              padding: '24px',
              borderRadius: '16px',
              width: '100%',
              maxWidth: '560px',
              maxHeight: '85vh',
              overflowY: 'auto',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              boxShadow: '0 20px 50px rgba(0, 0, 0, 0.5)',
              display: 'flex',
              flexDirection: 'column',
              gap: '1.25rem',
              position: 'relative',
              animation: 'fadeIn 0.2s ease-out'
            }}
          >
            {/* 关闭按钮 */}
            <button
              onClick={() => setShowDecisionModal(false)}
              style={{
                position: 'absolute',
                right: '16px',
                top: '16px',
                background: 'rgba(255, 255, 255, 0.04)',
                border: '1px solid rgba(255, 255, 255, 0.08)',
                borderRadius: '50%',
                width: '32px',
                height: '32px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                color: 'var(--text-primary)',
                transition: 'all 0.2s'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'rgba(255,255,255,0.1)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'rgba(255,255,255,0.04)';
              }}
            >
              <X size={16} />
            </button>

            {/* 弹窗头部 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' }}>
              <div style={{
                background: parsedAnalysis.signal === 'NOW'
                  ? 'rgba(16, 185, 129, 0.12)'
                  : parsedAnalysis.signal === 'WAIT'
                    ? 'rgba(245, 158, 11, 0.12)'
                    : 'rgba(239, 68, 68, 0.12)',
                color: parsedAnalysis.signal === 'NOW'
                  ? 'var(--success)'
                  : parsedAnalysis.signal === 'WAIT'
                    ? 'var(--warning)'
                    : 'var(--danger)',
                padding: '4px 10px',
                borderRadius: '8px',
                fontWeight: 700,
                fontSize: '0.85rem'
              }}>
                {parsedAnalysis.signal}
              </div>
              <h3 style={{ margin: 0, fontSize: '1.2rem', fontWeight: 800, color: 'var(--text-primary)' }}>
                {lang === 'zh' ? 'AI 换汇决策报告' : 'AI Timing Decision Report'}
              </h3>
            </div>

            {/* 可信度百分比 */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                <span>{lang === 'zh' ? '建议可信度 (Confidence)' : 'Recommendation Confidence'}</span>
                <strong style={{ color: 'var(--text-primary)' }}>{parsedAnalysis.confidence}%</strong>
              </div>
              <div style={{ width: '100%', height: '5px', background: 'rgba(255,255,255,0.05)', borderRadius: '3px', overflow: 'hidden' }}>
                <div style={{ width: `${parsedAnalysis.confidence}%`, height: '100%', background: 'linear-gradient(90deg, #6366f1, #c084fc)' }} />
              </div>
            </div>

            {/* 决策结论 */}
            <div style={{
              fontSize: '0.9rem',
              lineHeight: '1.5',
              color: 'var(--text-secondary)',
              borderLeft: '3px solid var(--primary)',
              paddingLeft: '12px',
              fontStyle: 'italic',
              margin: '4px 0'
            }}>
              {parsedAnalysis.summary}
            </div>

            {/* 执行建议 */}
            <div style={{
              background: 'rgba(255,255,255,0.01)',
              borderRadius: '12px',
              padding: '12px 14px',
              border: '1px solid rgba(255, 255, 255, 0.04)',
              display: 'flex',
              flexDirection: 'column',
              gap: '6px'
            }}>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', fontWeight: 600 }}>
                {lang === 'zh' ? '⚡ 换汇执行策略' : '⚡ Execution Strategy'}
              </span>
              <div style={{ fontSize: '0.85rem', color: 'var(--text-primary)', lineHeight: 1.4 }}>
                <strong>{lang === 'zh' ? '推荐窗口：' : 'Time Window: '}</strong>
                {parsedAnalysis.timeWindow}
              </div>
              <div style={{ fontSize: '0.85rem', color: 'var(--text-primary)', lineHeight: 1.4 }}>
                <strong>{lang === 'zh' ? '具体建议：' : 'Action Details: '}</strong>
                {parsedAnalysis.execution_suggestion}
              </div>
              <div style={{ fontSize: '0.85rem', color: 'var(--text-primary)', lineHeight: 1.4 }}>
                <strong>{lang === 'zh' ? '时机风险级别：' : 'Timing Risk Level: '}</strong>
                <span style={{
                  color: parsedAnalysis.risk_level === 'low'
                    ? 'var(--success)'
                    : parsedAnalysis.risk_level === 'medium'
                      ? 'var(--warning)'
                      : 'var(--danger)',
                  fontWeight: 700
                }}>
                  {parsedAnalysis.risk_level?.toUpperCase()}
                </span>
              </div>
            </div>

            {/* 影响因素 Drivers */}
            {parsedAnalysis.drivers && parsedAnalysis.drivers.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', fontWeight: 600 }}>
                  {lang === 'zh' ? '🔍 核心驱动力分析' : '🔍 Drivers Analysis'}
                </span>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {parsedAnalysis.drivers.map((drv: any, i: number) => (
                    <div
                      key={i}
                      style={{
                        padding: '10px',
                        borderRadius: '8px',
                        background: 'rgba(255,255,255,0.01)',
                        border: '1px solid rgba(255,255,255,0.03)',
                        fontSize: '0.8rem',
                        lineHeight: '1.4'
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                        <strong style={{ color: 'var(--text-primary)' }}>{drv.title}</strong>
                        <span style={{
                          color: drv.impact === 'positive'
                            ? 'var(--success)'
                            : drv.impact === 'negative'
                              ? 'var(--danger)'
                              : 'var(--text-muted)',
                          fontSize: '0.75rem',
                          fontWeight: 700
                        }}>
                          {drv.impact?.toUpperCase()}
                        </span>
                      </div>
                      <div style={{ color: 'var(--text-muted)' }}>{drv.detail}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 关联的 Polymarket 真实事件 */}
            {polymarketData && polymarketData.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', fontWeight: 600 }}>
                  {lang === 'zh' ? '📊 Polymarket 宏观人群概率' : '📊 Crowdsourced Polymarket Odds'}
                </span>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  {polymarketData.map((ev: any, i: number) => {
                    const isMulti = ev.multiMarkets && ev.multiMarkets.length > 0;
                    
                    let tooltipText = undefined;
                    if (isMulti) {
                      const rtObj = ev.slug ? realtimeData[ev.slug] : undefined;
                      if (rtObj) {
                        if (rtObj.loading) {
                          tooltipText = lang === 'zh' ? '正在获取实时最新赔率...' : 'Fetching latest real-time odds...';
                        } else if (rtObj.data && rtObj.data.length > 0) {
                          tooltipText = rtObj.data.map((m: any) => `${m.title}: ${(m.odds * 100).toFixed(0)}%`).join('\n');
                        } else {
                          tooltipText = ev.multiMarkets ? ev.multiMarkets.map((m: any) => `${m.title}: ${(m.odds * 100).toFixed(0)}% (cached)`).join('\n') : undefined;
                        }
                      } else {
                        tooltipText = ev.multiMarkets ? ev.multiMarkets.map((m: any) => `${m.title}: ${(m.odds * 100).toFixed(0)}% (cached)`).join('\n') : undefined;
                      }
                    }

                    return (
                      <a
                        href={ev.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        key={ev.id || i}
                        title={tooltipText}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          padding: '10px 12px',
                          borderRadius: '8px',
                          background: 'rgba(99, 102, 241, 0.04)',
                          border: '1px solid rgba(99, 102, 241, 0.1)',
                          textDecoration: 'none',
                          color: 'inherit',
                          transition: 'all 0.2s',
                          fontSize: '0.8rem'
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.background = 'rgba(99, 102, 241, 0.08)';
                          e.currentTarget.style.borderColor = 'rgba(99, 102, 241, 0.2)';
                          if (isMulti && ev.slug) {
                            handleMouseEnter(ev.slug);
                          }
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.background = 'rgba(99, 102, 241, 0.04)';
                          e.currentTarget.style.borderColor = 'rgba(99, 102, 241, 0.1)';
                        }}
                      >
                        <span style={{ color: 'var(--text-primary)', maxWidth: '75%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {ev.title}
                        </span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <span style={{ color: 'var(--primary)', fontWeight: 700 }}>
                            {isMulti
                              ? (lang === 'zh' ? '多市场' : 'Multi-market')
                              : `${(ev.odds * 100).toFixed(0)}%`}
                          </span>
                          <ExternalLink size={12} style={{ color: 'var(--text-muted)' }} />
                        </div>
                      </a>
                    );
                  })}
                </div>
              </div>
            )}

            {/* 风险警告 */}
            {parsedAnalysis.riskWarning && (
              <div style={{
                background: 'rgba(239, 68, 68, 0.04)',
                border: '1px solid rgba(239, 68, 68, 0.15)',
                borderRadius: '8px',
                padding: '10px 12px',
                fontSize: '0.75rem',
                color: 'var(--text-muted)',
                lineHeight: '1.4'
              }}>
                <strong style={{ color: 'var(--danger)', display: 'block', marginBottom: '2px' }}>
                  ⚠️ {lang === 'zh' ? '风险提示' : 'Risk Warning'}
                </strong>
                {parsedAnalysis.riskWarning}
              </div>
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

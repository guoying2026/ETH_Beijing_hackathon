import { useState, useEffect, useCallback } from 'react';
import { Landmark, ShieldAlert, Award, FileText, CheckCircle, Loader2, Wallet, RefreshCw } from 'lucide-react';
import { createWalletClient, custom, keccak256, stringToBytes, encodePacked, parseUnits, formatUnits } from 'viem';
import { C2C_ADMIN_ABI, C2C_ESCROW_ABI, C2C_RISK_MANAGER_ABI, ERC20_ABI } from '../lib/contractAbi';

const getEthereum = () => typeof window !== 'undefined' ? (window as any).ethereum : undefined;

interface DashboardPanelProps {
  account: `0x${string}` | null;
  connectWallet: () => Promise<void>;
  lang: 'zh' | 'en';
  theme: 'dark' | 'light';
  USDT_ADDRESS: `0x${string}`;
  ESCROW_ADDRESS: `0x${string}`;
  ADMIN_ADDRESS: `0x${string}`;
  RISK_MANAGER_ADDRESS: `0x${string}`;
  BOND_VAULT_ADDRESS: `0x${string}`;
  MERCHANT_ADDRESS: `0x${string}`;
  targetChain: any;
  publicClient: any;
}

interface ActiveOrder {
  buyer: `0x${string}`;
  merchant: `0x${string}`;
  orderId: bigint;
  productId: bigint;
  assetType: number; // 0 for Crypto, 1 for Fiat
  amount: bigint;
  deadline: bigint;
  status: number; // 0: PENDING, 1: COMPLETED, 2: CANCELLED, 3: WAITING, 4: EXPIRED
  platformId: `0x${string}`;
  platformName: string;
}

const ORDER_PLACED_EVENT = {
  type: 'event',
  name: 'OrderPlaced',
  inputs: [
    { indexed: true, name: 'merchant', type: 'address' },
    { indexed: true, name: 'buyer', type: 'address' },
    { indexed: false, name: 'orderId', type: 'uint256' },
    { indexed: false, name: 'productId', type: 'uint256' },
    { indexed: false, name: 'assetType', type: 'uint8' },
    { indexed: false, name: 'amount', type: 'uint256' },
    { indexed: false, name: 'deadline', type: 'uint256' }
  ]
} as const;

export function DashboardPanel({
  account,
  connectWallet,
  lang,
  USDT_ADDRESS,
  ESCROW_ADDRESS,
  ADMIN_ADDRESS,
  RISK_MANAGER_ADDRESS,
  MERCHANT_ADDRESS,
  targetChain,
  publicClient
}: DashboardPanelProps) {
  // Wallet state
  const [ethBalance, setEthBalance] = useState('0');
  const [usdtBalance, setUsdtBalance] = useState('0');
  const [riskLevel, setRiskLevel] = useState(0);
  const [requiredBondBps, setRequiredBondBps] = useState(1000);
  const [isFrozen, setIsFrozen] = useState(false);
  const [tradeStats, setTradeStats] = useState({ completed: 0, timeouts: 0 });

  // Identity bindings
  const [wiseName, setWiseName] = useState('');
  const [wiseHandle, setWiseHandle] = useState('');
  const [alipayName, setAlipayName] = useState('');
  const [alipayHandle, setAlipayHandle] = useState('');
  const [isBindingWise, setIsBindingWise] = useState(false);
  const [isBindingAlipay, setIsBindingAlipay] = useState(false);
  const [wiseBound, setWiseBound] = useState(false);
  const [alipayBound, setAlipayBound] = useState(false);

  // Active orders
  const [orders, setOrders] = useState<ActiveOrder[]>([]);
  const [loadingOrders, setLoadingOrders] = useState(false);

  // Proof flow state
  const [selectedOrder, setSelectedOrder] = useState<ActiveOrder | null>(null);
  const [proveProgress, setProveProgress] = useState(0);
  const [proveMessage, setProveMessage] = useState('');
  const [provingStatus, setProvingStatus] = useState<'idle' | 'proving' | 'success' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  const fetchBalancesAndReputation = useCallback(async () => {
    if (!account) return;
    setWiseName('');
    setWiseHandle('');
    setAlipayName('');
    setAlipayHandle('');
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
      setTradeStats({
        completed: Number(rep.completedCount ?? rep[0]),
        timeouts: Number(rep.timeoutCount ?? rep[1])
      });

      // Fetch bindings
      const wiseId = keccak256(stringToBytes('wise')).toLowerCase() as `0x${string}`;
      const alipayId = keccak256(stringToBytes('alipay')).toLowerCase() as `0x${string}`;

      const wiseBinding = await publicClient.readContract({
        address: ADMIN_ADDRESS,
        abi: C2C_ADMIN_ABI,
        functionName: 'getPlatformBinding',
        args: [account, wiseId]
      }) as any;
      const isWiseBound = Boolean(wiseBinding && (wiseBinding.isSet ?? wiseBinding[2]));
      setWiseBound(isWiseBound);
      if (isWiseBound && MERCHANT_ADDRESS && account.toLowerCase() === MERCHANT_ADDRESS.toLowerCase()) {
        setWiseName('KAI XU LOOI');
        setWiseHandle('@kaixul1');
      }

      const alipayBinding = await publicClient.readContract({
        address: ADMIN_ADDRESS,
        abi: C2C_ADMIN_ABI,
        functionName: 'getPlatformBinding',
        args: [account, alipayId]
      }) as any;
      setAlipayBound(Boolean(alipayBinding && (alipayBinding.isSet ?? alipayBinding[2])));
    } catch (err) {
      console.error('Error fetching dashboard user data:', err);
    }
  }, [account, publicClient, USDT_ADDRESS, RISK_MANAGER_ADDRESS, ADMIN_ADDRESS, MERCHANT_ADDRESS]);

  const fetchOrders = useCallback(async () => {
    if (!account) return;
    setLoadingOrders(true);
    try {
      const logs = await publicClient.getLogs({
        address: ESCROW_ADDRESS,
        event: ORDER_PLACED_EVENT,
        args: { buyer: account } as any,
        fromBlock: 0n
      });

      const items: ActiveOrder[] = await Promise.all(
        logs.map(async (l: any) => {
          const a = l.args as any;
          const assetType = Number(a.assetType);
          const orderTuple = await publicClient.readContract({
            address: ESCROW_ADDRESS,
            abi: C2C_ESCROW_ABI,
            functionName: 'getOrder',
            args: [a.merchant, a.productId, assetType, a.orderId],
          }) as any;
          const platformId = await publicClient.readContract({
            address: ESCROW_ADDRESS,
            abi: C2C_ESCROW_ABI,
            functionName: 'getProductPlatformId',
            args: [a.merchant, a.productId, assetType],
          }) as `0x${string}`;

          const wiseId = keccak256(stringToBytes('wise')).toLowerCase();
          const alipayId = keccak256(stringToBytes('alipay')).toLowerCase();
          const platformName = platformId.toLowerCase() === wiseId ? 'Wise' : platformId.toLowerCase() === alipayId ? 'Alipay' : 'Wise';

          return {
            buyer: a.buyer,
            merchant: a.merchant,
            orderId: a.orderId,
            productId: a.productId,
            assetType,
            amount: orderTuple[1],
            deadline: orderTuple[3],
            status: orderTuple[4],
            platformId,
            platformName
          };
        })
      );

      // Filter only active ones (0: PENDING, 3: WAITING)
      setOrders(items.filter(o => o.status === 0 || o.status === 3));
    } catch (err) {
      console.error('Failed to load active orders:', err);
      setOrders([]);
    } finally {
      setLoadingOrders(false);
    }
  }, [account, ESCROW_ADDRESS, publicClient]);

  useEffect(() => {
    if (account) {
      fetchBalancesAndReputation();
      fetchOrders();
    }
  }, [account, fetchBalancesAndReputation, fetchOrders]);

  const handleBind = async (platformName: 'Wise' | 'Alipay', name: string, handle: string, setIsBinding: (v: boolean) => void) => {
    if (!account) return;
    if (!name || !handle) {
      alert(lang === 'zh' ? '请填写姓名和账户标识！' : 'Please fill name and account handle!');
      return;
    }

    setIsBinding(true);
    try {
      const ethereum = getEthereum();
      if (!ethereum) throw new Error('MetaMask not detected');
      const walletClient = createWalletClient({
        account,
        chain: targetChain,
        transport: custom(ethereum)
      });

      const platformId = keccak256(stringToBytes(platformName.toLowerCase())) as `0x${string}`;
      const saltHex = '0x1234567890123456789012345678901234567890123456789012345678901234' as `0x${string}`;
      const normalize = (s: string) => s.trim().toLowerCase().normalize('NFC');
      const nameHash = keccak256(encodePacked(['string', 'bytes32'], [normalize(name), saltHex]));
      const idHash = keccak256(encodePacked(['string', 'bytes32'], [normalize(handle), saltHex]));

      const hash = await (walletClient as any).writeContract({
        address: ADMIN_ADDRESS,
        abi: C2C_ADMIN_ABI,
        functionName: 'setPlatformBinding',
        args: [platformId, nameHash, idHash]
      });

      await publicClient.waitForTransactionReceipt({ hash });
      alert(lang === 'zh' ? `${platformName} 身份绑定成功！` : `${platformName} platform binding set successfully!`);
      fetchBalancesAndReputation();
    } catch (e: any) {
      console.error(e);
      alert(e.message || e);
    } finally {
      setIsBinding(false);
    }
  };

  const handleFaucet = async () => {
    if (!account) return;
    try {
      const ethereum = getEthereum();
      if (!ethereum) return;
      const walletClient = createWalletClient({
        account,
        chain: targetChain,
        transport: custom(ethereum)
      });
      const mintAmount = parseUnits("1000", 18);
      const hash = await (walletClient as any).writeContract({
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
      await publicClient.waitForTransactionReceipt({ hash });
      alert(lang === 'zh' ? '成功获得 1000 测试 USDT！' : 'Successfully received 1000 test USDT!');
      fetchBalancesAndReputation();
    } catch (e: any) {
      console.error(e);
      alert(e.message || e);
    }
  };

  const handleVerifyZkTls = async (order: ActiveOrder, isMock: boolean) => {
    if (!account) return;
    setProvingStatus('proving');
    setErrorMsg('');
    setProveProgress(10);
    setProveMessage(lang === 'zh' ? '🔐 正在与网银建立安全加密连接...' : '🔐 Connecting securely to Swiss Bank...');

    const logToAgent = (msg: string) => {
      window.dispatchEvent(new CustomEvent('agent-log', { detail: msg }));
    };

    const saveTransactionMemory = async () => {
      try {
        await fetch('/api/save-memory', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: `用户 EOA ${account} 为订单 #${order.orderId.toString()} 成功提交了 zkTLS 网银证明，结算了 ${formatUnits(order.amount, 18)} USDT。`,
            userId: 'guoying_dev'
          })
        });
        logToAgent('🧠 [Long-term Memory] 已将网银证明与订单清算记录主动沉淀至腾讯混元 Hy-Memory 长期记忆。');
      } catch (e) {
        console.warn(e);
      }
    };

    if (isMock) {
      try {
        await new Promise(r => setTimeout(r, 1200));
        setProveProgress(40);
        setProveMessage(lang === 'zh' ? '⚡ 正在提取转账流水并脱敏敏感隐私数据...' : '⚡ Fetching bills & redacting privacy details...');
        await new Promise(r => setTimeout(r, 1500));
        setProveProgress(85);
        setProveMessage(lang === 'zh' ? '🛡️ 正在生成零知识证明 (zk-Proof)...' : '🛡️ Generating cryptographic proof...');
        await new Promise(r => setTimeout(r, 1200));
        setProveProgress(100);
        setProveMessage(lang === 'zh' ? '✅ 证明生成成功！正在提交智能合约释放托管资金...' : '✅ Proof success! Releasing funds in escrow...');

        const ethereum = getEthereum();
        if (!ethereum) throw new Error('MetaMask not detected');
        const walletClient = createWalletClient({
          account,
          chain: targetChain,
          transport: custom(ethereum)
        });

        // Mock proof list matching ContractTLSNProof structure
        const dummyProofs = [{
          chainId: BigInt(targetChain.id),
          sessionId: 'mock_session_id_' + Date.now(),
          commitmentsHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
          orderBindingHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
          policyVersionHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
          verifierSignature: '0x0000000000000000000000000000000000000000000000000000000000000000',
          revealedItems: [],
          commitmentOpenings: [],
          commitments: [],
          serverName: 'SwissBank'
        }];

        const hash = await (walletClient as any).writeContract({
          address: ESCROW_ADDRESS,
          abi: C2C_ESCROW_ABI,
          functionName: 'payOrderByPlatform',
          args: [order.merchant, order.productId, order.orderId, dummyProofs]
        });

        await publicClient.waitForTransactionReceipt({ hash });
        setProvingStatus('success');
        saveTransactionMemory();
        fetchOrders();
      } catch (err: any) {
        console.error(err);
        setErrorMsg(err.message || 'Verification failed');
        setProvingStatus('error');
      }
      return;
    }

    // Real TLSNotary verification flow
    if (!(window as any).tlsn) {
      setErrorMsg(lang === 'zh' ? '未检测到 TLSNotary 浏览器扩展插件！' : 'TLSNotary extension not detected!');
      setProvingStatus('error');
      return;
    }

    try {
      const ethereum = getEthereum();
      if (!ethereum) throw new Error('MetaMask not detected');
      const walletClient = createWalletClient({
        account,
        chain: targetChain,
        transport: custom(ethereum)
      });

      // Construct context orderBindingHash
      const orderBindingHash = '0x0000000000000000000000000000000000000000000000000000000000000000'; // Replace with computed binding hash if plugin loaded
      
      const pluginUrl = order.platformName.toLowerCase() === 'alipay' ? '/plugins/alipay.js' : '/plugins/wise.js';
      const resPlugin = await fetch(pluginUrl);
      if (!resPlugin.ok) throw new Error('Plugin load failed');
      let pluginCode = await resPlugin.text();

      // Simple replacement
      pluginCode = pluginCode
        .replace(/"0x0000000000000000000000000000000000000000000000000000000000000001"/g, `"${orderBindingHash}"`)
        .replace(/'0x0000000000000000000000000000000000000000000000000000000000000001'/g, `'${orderBindingHash}'`);

      setProveProgress(50);
      setProveMessage(lang === 'zh' ? '✍️ 请在浏览器弹窗中登录网银并完成公证...' : '✍️ Please log in and complete notary in browser...');

      const reqId = `dashboard_${Date.now()}`;
      const resultStr = await (window as any).tlsn.execCode(pluginCode, {
        requestId: reqId,
        sessionData: { mode: 'Mpc' }
      });

      const parsedResult = JSON.parse(resultStr);
      setProveProgress(80);
      setProveMessage(lang === 'zh' ? '✅ zkTLS 证明生成成功！正在提交智能合约释放资金...' : '✅ Proof success! Releasing funds in escrow...');

      // Build real proof object
      const mapDirection = (dir: string) => dir === 'RECV' ? 'Recv' : 'Sent';
      const buildContractProofObj = (proof: any) => {
        const sig = proof.verifierSignature;
        const policyVersionHash = sig.policyVersionHash || keccak256(stringToBytes(sig.policyVersion || 'v1.0.0'));
        return {
          chainId: BigInt(sig.chainId ?? 0),
          sessionId: sig.sessionId,
          commitmentsHash: sig.commitmentsHash.startsWith('0x') ? sig.commitmentsHash : `0x${sig.commitmentsHash}`,
          orderBindingHash: sig.orderBindingHash.startsWith('0x') ? sig.orderBindingHash : `0x${sig.orderBindingHash}`,
          policyVersionHash: policyVersionHash.startsWith('0x') ? policyVersionHash : `0x${policyVersionHash}`,
          verifierSignature: sig.signature.startsWith('0x') ? sig.signature : `0x${sig.signature}`,
          revealedItems: proof.results.map((r: any) => ({
            handlerType: r.type,
            part: r.part,
            value: r.value,
            commitment_index: BigInt(r.commitmentIndex ?? 0),
            start_item: BigInt(r.start ?? 0),
            end_item: BigInt(r.end ?? 0),
            start_value: BigInt(r.startValue ?? 0),
            end_value: BigInt(r.endValue ?? r.value?.length ?? 0),
          })),
          commitmentOpenings: (proof.transcriptCommitOpenings || []).map((o: any) => ({
            blinderHex: o.blinderHex.startsWith('0x') ? o.blinderHex : `0x${o.blinderHex}`,
          })),
          commitments: (proof.transcriptCommitments || []).map((c: any) => ({
            direction: mapDirection(c.direction ?? 'RECV'),
            hashAlg: c.hashAlg ?? 'Keccak256',
            hashValue: c.hashHex.startsWith('0x') ? c.hashHex : `0x${c.hashHex}`,
          })),
          serverName: proof.serverName ?? '',
        };
      };

      let proofsArr = [];
      if (order.platformName.toLowerCase() === 'wise') {
        const wiseProofs = parsedResult.proofs || parsedResult;
        proofsArr = [
          buildContractProofObj(wiseProofs.contacts),
          buildContractProofObj(wiseProofs.transfer)
        ];
      } else {
        proofsArr = [buildContractProofObj(parsedResult)];
      }

      const hash = await (walletClient as any).writeContract({
        address: ESCROW_ADDRESS,
        abi: C2C_ESCROW_ABI,
        functionName: 'payOrderByPlatform',
        args: [order.merchant, order.productId, order.orderId, proofsArr]
      });

      await publicClient.waitForTransactionReceipt({ hash });
      setProvingStatus('success');
      saveTransactionMemory();
      fetchOrders();
    } catch (err: any) {
      console.error(err);
      setErrorMsg(err.message || 'Verification failed');
      setProvingStatus('error');
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', width: '100%' }}>
      
      {/* 1. Wallet and credit stats */}
      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1.5rem' }}>
        {/* Wallet info */}
        <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '1rem', position: 'relative' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div style={{ background: 'rgba(99, 102, 241, 0.1)', color: 'var(--primary)', padding: '6px', borderRadius: '8px' }}>
              <Wallet size={18} />
            </div>
            <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 700 }}>
              {lang === 'zh' ? '钱包与资产' : 'Wallet & Assets'}
            </h3>
          </div>

          {account ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div>
                <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{lang === 'zh' ? 'EOA 地址' : 'EOA Address'}</span>
                <div style={{ fontFamily: 'monospace', color: 'var(--text-primary)', fontWeight: 600, fontSize: '0.9rem', wordBreak: 'break-all' }}>
                  {account}
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', background: 'rgba(255,255,255,0.02)', padding: '10px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.05)' }}>
                <div>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>USDT Balance</span>
                  <div style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                    {Number(usdtBalance).toFixed(2)}
                  </div>
                </div>
                <div>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>ETH Balance</span>
                  <div style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                    {Number(ethBalance).toFixed(4)}
                  </div>
                </div>
              </div>
              <button onClick={handleFaucet} className="btn-primary" style={{ padding: '8px', fontSize: '0.85rem' }}>
                {lang === 'zh' ? '领取 1000 测试 USDT' : 'Get 1000 Test USDT'}
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '140px', gap: '10px' }}>
              <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                {lang === 'zh' ? '未连接钱包' : 'Wallet not connected'}
              </span>
              <button onClick={connectWallet} className="btn-primary" style={{ padding: '8px 16px', fontSize: '0.85rem' }}>
                {lang === 'zh' ? '连接以太坊钱包' : 'Connect Wallet'}
              </button>
            </div>
          )}
        </div>

        {/* Reputation info */}
        <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div style={{ background: 'rgba(16, 185, 129, 0.1)', color: 'var(--success)', padding: '6px', borderRadius: '8px' }}>
              <Award size={18} />
            </div>
            <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 700 }}>
              {lang === 'zh' ? '链上声誉与风控' : 'Reputation & Risk'}
            </h3>
          </div>

          {account ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                <div style={{ background: 'rgba(255,255,255,0.01)', border: '1px solid rgba(255,255,255,0.03)', padding: '8px', borderRadius: '8px', textAlign: 'center' }}>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{lang === 'zh' ? '已完成交易' : 'Completed'}</span>
                  <div style={{ fontSize: '1.4rem', fontWeight: 700, color: 'var(--success)' }}>{tradeStats.completed}</div>
                </div>
                <div style={{ background: 'rgba(255,255,255,0.01)', border: '1px solid rgba(255,255,255,0.03)', padding: '8px', borderRadius: '8px', textAlign: 'center' }}>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{lang === 'zh' ? '超时交易' : 'Timeouts'}</span>
                  <div style={{ fontSize: '1.4rem', fontWeight: 700, color: 'var(--danger)' }}>{tradeStats.timeouts}</div>
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '8px', fontSize: '0.85rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--text-muted)' }}>{lang === 'zh' ? '风控信用等级' : 'Risk Rating'}</span>
                  <strong style={{ color: isFrozen ? 'var(--danger)' : 'var(--text-primary)' }}>
                    {isFrozen ? (lang === 'zh' ? '冻结账户 (Frozen)' : 'FROZEN') : `${lang === 'zh' ? '信用' : 'Credit'} ${riskLevel}`}
                  </strong>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--text-muted)' }}>{lang === 'zh' ? '当前保证金比例' : 'Bond Bps Ratio'}</span>
                  <strong style={{ color: 'var(--text-primary)' }}>{(requiredBondBps / 100).toFixed(1)}%</strong>
                </div>
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '140px', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
              {lang === 'zh' ? '连接钱包后查看链上信用数据' : 'Connect wallet to view credit parameters'}
            </div>
          )}
        </div>
      </section>

      {/* 2. Platform bindings */}
      <section className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <div style={{ background: 'rgba(245, 158, 11, 0.1)', color: 'var(--warning)', padding: '6px', borderRadius: '8px' }}>
            <Landmark size={18} />
          </div>
          <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 700 }}>
            {lang === 'zh' ? '第三方网银防伪身份绑定' : 'Third-Party Banking Identifiers'}
          </h3>
        </div>
        <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-muted)', lineHeight: '1.4' }}>
          {lang === 'zh' 
            ? '请将您的支付宝或 Wise 网银姓名和账户提交到智能合约中进行加密绑定。zkTLS 密码学公证插件在放款时，需要确保账单中包含的付款人/收款人实名信息与此处的绑定哈希一致，从而实现无需中心化核验的一键结算放款。' 
            : 'Bind your Wise and Alipay identities on-chain. The zkTLS plugin checks that the real payment statement names and handles match this cryptographic commitment before triggering escrow settlements.'}
        </p>

        {account ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '1.25rem', marginTop: '4px' }}>
            {/* Wise bind */}
            <div style={{ background: 'rgba(255,255,255,0.01)', border: '1px solid rgba(255,255,255,0.04)', borderRadius: '12px', padding: '16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontWeight: 700, fontSize: '0.9rem', color: 'var(--text-primary)' }}>Wise Account</span>
                <span style={{ fontSize: '0.75rem', fontWeight: 600, color: wiseBound ? 'var(--success)' : 'var(--danger)', background: wiseBound ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)', padding: '2px 8px', borderRadius: '4px' }}>
                  {wiseBound ? (lang === 'zh' ? '已绑定' : 'Bound') : (lang === 'zh' ? '未绑定' : 'Unbound')}
                </span>
              </div>
              <input
                type="text"
                placeholder={lang === 'zh' ? 'Wise 真实姓名（如: San Zhang）' : 'Wise Legal Name (e.g. San Zhang)'}
                value={wiseName}
                onChange={(e) => setWiseName(e.target.value)}
                className="input-field"
                style={{ fontSize: '0.8rem', padding: '8px 12px' }}
              />
              <input
                type="text"
                placeholder={lang === 'zh' ? 'Wise 账号邮箱/手机（如: user@wise.com）' : 'Wise Handle/Email (e.g. user@wise.com)'}
                value={wiseHandle}
                onChange={(e) => setWiseHandle(e.target.value)}
                className="input-field"
                style={{ fontSize: '0.8rem', padding: '8px 12px' }}
              />
              <button
                onClick={() => handleBind('Wise', wiseName, wiseHandle, setIsBindingWise)}
                disabled={isBindingWise}
                className="btn-primary"
                style={{ width: '100%', padding: '6px', fontSize: '0.8rem' }}
              >
                {isBindingWise ? (lang === 'zh' ? '绑定中...' : 'Binding...') : (lang === 'zh' ? '提交 Wise 身份绑定' : 'Bind Wise')}
              </button>
            </div>

            {/* Alipay bind */}
            <div style={{ background: 'rgba(255,255,255,0.01)', border: '1px solid rgba(255,255,255,0.04)', borderRadius: '12px', padding: '16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontWeight: 700, fontSize: '0.9rem', color: 'var(--text-primary)' }}>Alipay Account</span>
                <span style={{ fontSize: '0.75rem', fontWeight: 600, color: alipayBound ? 'var(--success)' : 'var(--danger)', background: alipayBound ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)', padding: '2px 8px', borderRadius: '4px' }}>
                  {alipayBound ? (lang === 'zh' ? '已绑定' : 'Bound') : (lang === 'zh' ? '未绑定' : 'Unbound')}
                </span>
              </div>
              <input
                type="text"
                placeholder={lang === 'zh' ? '支付宝姓名（如: 张三）' : 'Alipay Real Name (e.g. Zhang San)'}
                value={alipayName}
                onChange={(e) => setAlipayName(e.target.value)}
                className="input-field"
                style={{ fontSize: '0.8rem', padding: '8px 12px' }}
              />
              <input
                type="text"
                placeholder={lang === 'zh' ? '支付宝账号/手机（如: 13900000000）' : 'Alipay Account Phone/ID (e.g. 13900000000)'}
                value={alipayHandle}
                onChange={(e) => setAlipayHandle(e.target.value)}
                className="input-field"
                style={{ fontSize: '0.8rem', padding: '8px 12px' }}
              />
              <button
                onClick={() => handleBind('Alipay', alipayName, alipayHandle, setIsBindingAlipay)}
                disabled={isBindingAlipay}
                className="btn-primary"
                style={{ width: '100%', padding: '6px', fontSize: '0.8rem' }}
              >
                {isBindingAlipay ? (lang === 'zh' ? '绑定中...' : 'Binding...') : (lang === 'zh' ? '提交 Alipay 身份绑定' : 'Bind Alipay')}
              </button>
            </div>
          </div>
        ) : (
          <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
            {lang === 'zh' ? '连接钱包后即可进行收付款平台身份绑定' : 'Please connect wallet to setup platform bindings'}
          </div>
        )}
      </section>

      {/* 3. My Active Orders */}
      <section className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div style={{ background: 'rgba(99, 102, 241, 0.1)', color: 'var(--primary)', padding: '6px', borderRadius: '8px' }}>
              <FileText size={18} />
            </div>
            <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 700 }}>
              {lang === 'zh' ? '我的活跃交易订单' : 'Active Trades & Escrows'}
            </h3>
          </div>
          {account && (
            <button onClick={fetchOrders} style={{ background: 'none', border: 'none', color: 'var(--primary)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.8rem', fontWeight: 600 }}>
              <RefreshCw size={14} className={loadingOrders ? 'animate-spin' : ''} />
              <span>{lang === 'zh' ? '刷新' : 'Refresh'}</span>
            </button>
          )}
        </div>

        {!account ? (
          <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
            {lang === 'zh' ? '连接钱包后显示交易流水' : 'Connect wallet to view trade history'}
          </div>
        ) : loadingOrders ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '40px 0' }}>
            <Loader2 size={32} className="animate-spin" color="var(--primary)" />
          </div>
        ) : orders.length === 0 ? (
          <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.85rem', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' }}>
            <span>{lang === 'zh' ? '当前没有进行中的活跃 C2C 订单。' : 'No active trade escrows found.'}</span>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
              {lang === 'zh' ? '您可以在“极速换汇”中发起一笔新订单。' : 'You can start a new trade swap in the first tab.'}
            </span>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {orders.map((o) => {
              const deadlineDate = new Date(Number(o.deadline) * 1000);
              const isExpired = deadlineDate.getTime() < Date.now();
              const isSelected = selectedOrder?.orderId === o.orderId && selectedOrder?.merchant === o.merchant;

              return (
                <div key={`${o.merchant}_${o.orderId}`} style={{
                  background: 'rgba(255,255,255,0.01)',
                  border: '1px solid rgba(255,255,255,0.04)',
                  borderRadius: '12px',
                  padding: '16px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '12px'
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '8px' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span style={{
                          fontWeight: 700,
                          background: 'rgba(99, 102, 241, 0.1)',
                          color: 'var(--primary)',
                          padding: '2px 8px',
                          borderRadius: '4px',
                          fontSize: '0.75rem'
                        }}>
                          {o.platformName}
                        </span>
                        <span style={{ fontFamily: 'monospace', fontWeight: 600, fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                          ID: #{o.orderId.toString()}
                        </span>
                      </div>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                        {lang === 'zh' ? '承兑商钱包：' : 'Merchant: '}{o.merchant.slice(0, 10)}...{o.merchant.slice(-6)}
                      </span>
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '4px' }}>
                      <strong style={{ fontSize: '1.1rem', color: 'var(--text-primary)' }}>
                        {parseFloat(formatUnits(o.amount, 18)).toFixed(2)} USDT
                      </strong>
                      <span style={{
                        fontSize: '0.75rem',
                        fontWeight: 600,
                        color: isExpired ? 'var(--danger)' : 'var(--warning)',
                        background: isExpired ? 'rgba(239,68,68,0.1)' : 'rgba(245,158,11,0.1)',
                        padding: '2px 8px',
                        borderRadius: '4px'
                      }}>
                        {isExpired ? (lang === 'zh' ? '已过期' : 'EXPIRED') : (lang === 'zh' ? '待付款/待公证' : 'PENDING NOTARY')}
                      </span>
                    </div>
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.75rem', color: 'var(--text-muted)', borderTop: '1px solid rgba(255,255,255,0.03)', paddingTop: '10px' }}>
                    <span>
                      {lang === 'zh' ? '最晚清算期限：' : 'Deadline: '}{deadlineDate.toLocaleString()}
                    </span>

                    {!isSelected && o.status === 0 && (
                      <button
                        onClick={() => {
                          setSelectedOrder(o);
                          setProvingStatus('idle');
                          setErrorMsg('');
                        }}
                        className="btn-primary"
                        style={{ padding: '4px 12px', fontSize: '0.75rem', borderRadius: '6px', margin: 0 }}
                      >
                        {lang === 'zh' ? '去公证放款' : 'Verify & Settle'}
                      </button>
                    )}
                  </div>

                  {/* Proof generation panel */}
                  {isSelected && (
                    <div style={{
                      background: 'rgba(255,255,255,0.01)',
                      border: '1px solid rgba(99, 102, 241, 0.15)',
                      borderRadius: '8px',
                      padding: '14px',
                      marginTop: '8px',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '12px'
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <strong style={{ fontSize: '0.85rem', color: 'var(--text-primary)' }}>
                          {lang === 'zh' ? 'zkTLS 密码学清算通道' : 'zkTLS Clearing Channel'}
                        </strong>
                        <button
                          onClick={() => setSelectedOrder(null)}
                          style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '0.8rem' }}
                        >
                          {lang === 'zh' ? '取消' : 'Cancel'}
                        </button>
                      </div>

                      {provingStatus === 'idle' && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                          <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--text-muted)', lineHeight: '1.4' }}>
                            {lang === 'zh'
                              ? `您需要向承兑商网银账号汇款对应法币，转账成功后，点击下方按钮唤醒 zkTLS。系统将拉取网银流水并脱敏隐私，生成已付款证明以释放托管资金。`
                              : `Transfer the fiat amount to the merchant's bank account. After payment, click below to invoke zkTLS. We will fetch and audit your statement to release the escrow.`}
                          </p>
                          <div style={{ display: 'flex', gap: '8px' }}>
                            <button
                              onClick={() => handleVerifyZkTls(o, false)}
                              className="btn-primary"
                              style={{ flex: 1, padding: '8px', fontSize: '0.8rem' }}
                            >
                              {lang === 'zh' ? '真实 zkTLS 公证' : 'Verify with zkTLS'}
                            </button>
                            <button
                              onClick={() => handleVerifyZkTls(o, true)}
                              style={{
                                flex: 1,
                                padding: '8px',
                                fontSize: '0.8rem',
                                background: 'rgba(255,255,255,0.05)',
                                border: '1px solid rgba(255,255,255,0.12)',
                                borderRadius: '10px',
                                color: 'var(--text-primary)',
                                cursor: 'pointer',
                                transition: 'all 0.2s',
                              }}
                              onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.1)'; }}
                              onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; }}
                            >
                              {lang === 'zh' ? 'Mock 模拟演示' : 'Mock Demo'}
                            </button>
                          </div>
                        </div>
                      )}

                      {provingStatus === 'proving' && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', alignItems: 'center', padding: '10px 0' }}>
                          <Loader2 size={24} className="animate-spin" color="var(--primary)" />
                          <div style={{ fontSize: '0.8rem', color: 'var(--text-primary)', fontWeight: 600 }}>{proveMessage}</div>
                          <div style={{ width: '100%', background: 'rgba(255,255,255,0.05)', height: '6px', borderRadius: '3px', overflow: 'hidden' }}>
                            <div style={{ width: `${proveProgress}%`, background: 'var(--primary)', height: '100%', transition: 'width 0.3s' }} />
                          </div>
                        </div>
                      )}

                      {provingStatus === 'success' && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', alignItems: 'center', padding: '10px 0', color: 'var(--success)' }}>
                          <CheckCircle size={28} />
                          <strong style={{ fontSize: '0.85rem' }}>{lang === 'zh' ? '交易清算完成！' : 'Transaction Settled Successfully!'}</strong>
                          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textAlign: 'center' }}>
                            {lang === 'zh' ? '托管智能合约已成功释放 USDT 至您的钱包中。' : 'Smart contract has released the escrowed USDT to your wallet.'}
                          </span>
                          <button
                            onClick={() => {
                              setSelectedOrder(null);
                              fetchOrders();
                            }}
                            className="btn-primary"
                            style={{ padding: '4px 16px', fontSize: '0.75rem', marginTop: '6px' }}
                          >
                            {lang === 'zh' ? '确定' : 'Confirm'}
                          </button>
                        </div>
                      )}

                      {provingStatus === 'error' && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', color: 'var(--danger)', fontSize: '0.8rem' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <ShieldAlert size={16} />
                            <strong>{lang === 'zh' ? '证明生成/结算失败' : 'Verification Failed'}</strong>
                          </div>
                          <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--text-muted)' }}>{errorMsg}</p>
                          <button
                            onClick={() => setProvingStatus('idle')}
                            className="btn-primary"
                            style={{ padding: '6px', fontSize: '0.75rem', width: '100%', marginTop: '4px' }}
                          >
                            {lang === 'zh' ? '重新尝试' : 'Retry'}
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Floating spin animation rule */}
      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        .animate-spin {
          animation: spin 1s linear infinite;
        }
      `}</style>
    </div>
  );
}

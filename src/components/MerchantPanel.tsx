import { useState, useEffect, useCallback } from 'react';
import { Store, FileText, CheckCircle, Loader2, Plus, ShieldCheck, ChevronRight, Award, AlertCircle, Clock, RefreshCw } from 'lucide-react';
import { createWalletClient, custom, keccak256, stringToBytes, parseUnits, formatUnits } from 'viem';
import { C2C_ADMIN_ABI, C2C_ESCROW_ABI, C2C_BOND_VAULT_ABI, ERC20_ABI } from '../lib/contractAbi';

const getEthereum = () => typeof window !== 'undefined' ? (window as any).ethereum : undefined;

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
      direction: c.direction === 'RECV' ? 'Recv' : 'Sent',
      hashAlg: c.hashAlg ?? 'Keccak256',
      hashValue: c.hashHex.startsWith('0x') ? c.hashHex : `0x${c.hashHex}`,
    })),
    serverName: proof.serverName ?? '',
  };
};

interface MerchantPanelProps {
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

interface ProductDetail {
  productId: bigint;
  cryptoID: bigint;
  fiatID: bigint;
  assetType: number; // 0 for Crypto, 1 for Fiat
  platformId: `0x${string}`;
  platformName: string;
  collateralAmount: bigint;
  pendingAmount: bigint;
  availableAmount: bigint;
  isActive: boolean;
  activeOrderCount: bigint;
  rate: number;
  isOpen: boolean;
}

interface MerchantOrder {
  buyer: `0x${string}`;
  merchant: `0x${string}`;
  orderId: bigint;
  productId: bigint;
  assetType: number;
  amount: bigint;
  deadline: bigint;
  status: number;
  platformId: `0x${string}`;
  platformName: string;
}

export function MerchantPanel({
  account,
  connectWallet,
  lang,
  theme,
  USDT_ADDRESS,
  ESCROW_ADDRESS,
  ADMIN_ADDRESS,
  BOND_VAULT_ADDRESS,
  targetChain,
  publicClient
}: MerchantPanelProps) {
  // Toast state
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [toastType, setToastType] = useState<'success' | 'warning'>('success');
  const [toastTimeoutId, setToastTimeoutId] = useState<number | null>(null);

  const showToast = useCallback((msg: string, type: 'success' | 'warning' = 'success') => {
    setToastMessage(msg);
    setToastType(type);
    
    if (toastTimeoutId) {
      clearTimeout(toastTimeoutId);
    }
    
    const id = window.setTimeout(() => {
      setToastMessage(null);
    }, 3000);
    setToastTimeoutId(id);
  }, [toastTimeoutId]);

  const [isMerchant, setIsMerchant] = useState(false);
  const [usdtBalance, setUsdtBalance] = useState('0');
  const [loading, setLoading] = useState(true);
  const [claimableBond, setClaimableBond] = useState('0');
  const [isClaiming, setIsClaiming] = useState(false);

  // Register state
  const [isApplying, setIsApplying] = useState(false);
  const [applicationStatus, setApplicationStatus] = useState<'none' | 'pending' | 'approved' | 'loading'>('loading');

  // Listed products
  const [products, setProducts] = useState<ProductDetail[]>([]);
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [collapsedProducts, setCollapsedProducts] = useState<Set<string>>(new Set());

  // Add Product State
  const [newAssetType, setNewAssetType] = useState<number>(0); // 0 Sell Crypto, 1 Sell Fiat
  const [newCryptoId, setNewCryptoId] = useState('0');
  const [newFiatId, setNewFiatId] = useState('0');
  const [newAmount, setNewAmount] = useState('1000');
  const [newPlatform, setNewPlatform] = useState<'wise' | 'alipay'>('wise');
  const [isListing, setIsListing] = useState(false);

  const renderErrorMessage = (msg: string) => {
    if (!msg) return null;
    if (msg.includes('/zkTLS-extension.zip')) {
      const isZh = lang === 'zh';
      return (
        <span>
          {isZh 
            ? '未检测到 zkTLS 浏览器插件！请先在页面顶部下载安装扩展插件。您也可以在此处 '
            : 'zkTLS browser extension not detected! Please download and install from the top, or click here to '
          }
          <a
            href="/zkTLS-extension.zip"
            style={{ color: '#f87171', textDecoration: 'underline', fontWeight: 600, cursor: 'pointer' }}
            onClick={(e) => {
              e.preventDefault();
              const downloadUrl = `/zkTLS-extension.zip?t=${Date.now()}`;
              const a = document.createElement('a');
              a.href = downloadUrl;
              a.download = 'zkTLS-extension.zip';
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
            }}
          >
            {isZh ? '点击下载最新扩展包 (ZIP)' : 'download extension zip'}
          </a>
          {isZh ? '。' : ' directly.'}
        </span>
      );
    }
    return msg;
  };

  // Product management inline editing states
  const [editRates, setEditRates] = useState<Record<string, string>>({});
  const [editOpenHours, setEditOpenHours] = useState<Record<string, string>>({});
  const [editCloseHours, setEditCloseHours] = useState<Record<string, string>>({});
  const [collateralDeltas, setCollateralDeltas] = useState<Record<string, string>>({});

  // Merchant orders list
  const [orders, setOrders] = useState<MerchantOrder[]>([]);
  const [loadingOrders, setLoadingOrders] = useState(false);

  // Proof release state for Fiat orders
  const [selectedOrder, setSelectedOrder] = useState<MerchantOrder | null>(null);
  const [, setProveProgress] = useState(0);
  const [proveMessage, setProveMessage] = useState('');
  const [provingStatus, setProvingStatus] = useState<'idle' | 'proving' | 'success' | 'error'>('idle');
  const [, setErrorMsg] = useState('');

  const fetchMerchantStatus = useCallback(async () => {
    if (!account) {
      setLoading(false);
      setApplicationStatus('none');
      return;
    }
    try {
      // 1. 先检查本地数据库状态
      let dbStatus: 'none' | 'pending' | 'approved' = 'none';
      try {
        const res = await fetch(`/api/acceptors/status?address=${account}`);
        if (res.ok) {
          const data = await res.json();
          dbStatus = data.status || 'none';
        }
      } catch (e) {
        console.warn('⚠️ Querying backend acceptor status failed, falling back to smart contract check:', e);
      }

      let active = false;
      if (dbStatus === 'approved') {
        active = true;
        setApplicationStatus('approved');
      } else if (dbStatus === 'pending') {
        active = false;
        setApplicationStatus('pending');
      } else {
        // none 或者接口查询失败，fallback 检查智能合约
        try {
          active = await publicClient.readContract({
            address: ADMIN_ADDRESS,
            abi: C2C_ADMIN_ABI,
            functionName: 'isMerchantActive',
            args: [account]
          }) as boolean;
        } catch (contractErr) {
          console.error('Contract isMerchantActive call failed:', contractErr);
        }
        setApplicationStatus(active ? 'approved' : 'none');
      }

      setIsMerchant(active);

      // 2. 获取账户的 USDT 余额
      try {
        const usdtBal = await publicClient.readContract({
          address: USDT_ADDRESS,
          abi: ERC20_ABI,
          functionName: 'balanceOf',
          args: [account],
        }) as bigint;
        setUsdtBalance(formatUnits(usdtBal, 18));
      } catch (balErr) {
        console.error('Error fetching USDT balance in MerchantPanel:', balErr);
      }

      if (active) {
        const claimable = await publicClient.readContract({
          address: BOND_VAULT_ADDRESS,
          abi: C2C_BOND_VAULT_ABI,
          functionName: 'claimableBalance',
          args: [account, USDT_ADDRESS]
        }) as bigint;
        setClaimableBond(formatUnits(claimable, 18));
      }
    } catch (err) {
      console.error('Error fetching merchant status:', err);
    } finally {
      setLoading(false);
    }
  }, [account, ADMIN_ADDRESS, BOND_VAULT_ADDRESS, USDT_ADDRESS, publicClient]);

  const fetchProducts = useCallback(async () => {
    if (!account || !isMerchant) return;
    setLoadingProducts(true);
    try {
      const info = await publicClient.readContract({
        address: ADMIN_ADDRESS,
        abi: C2C_ADMIN_ABI,
        functionName: 'merchants',
        args: [account]
      }) as any;

      const sellCryptoAmount = Number(info.sellCryptoAmount ?? info[3]);
      const sellFiatAmount = Number(info.sellFiatAmount ?? info[4]);

      const fetchedList: ProductDetail[] = [];

      // Fetch sell crypto products
      for (let i = 0; i < sellCryptoAmount; i++) {
        try {
          const prodInfo = await publicClient.readContract({
            address: ESCROW_ADDRESS,
            abi: C2C_ESCROW_ABI,
            functionName: 'getProductInfo',
            args: [account, BigInt(i), 0]
          }) as any;

          const rateInfo = await publicClient.readContract({
            address: ADMIN_ADDRESS,
            abi: C2C_ADMIN_ABI,
            functionName: 'getMerchantRate',
            args: [account, BigInt(i), 0]
          }) as any;

          const isOpen = await publicClient.readContract({
            address: ADMIN_ADDRESS,
            abi: C2C_ADMIN_ABI,
            functionName: 'isMerchantOpen',
            args: [account, BigInt(i), 0]
          }) as boolean;

          const platformId = (prodInfo.platformId ?? prodInfo[4]) as `0x${string}`;
          const wiseId = keccak256(stringToBytes('wise')).toLowerCase();
          const alipayId = keccak256(stringToBytes('alipay')).toLowerCase();
          const platformName = platformId.toLowerCase() === wiseId ? 'Wise' : platformId.toLowerCase() === alipayId ? 'Alipay' : 'Wise';

          fetchedList.push({
            productId: BigInt(i),
            cryptoID: prodInfo.cryptoID ?? prodInfo[1],
            fiatID: prodInfo.fiatID ?? prodInfo[2],
            assetType: 0,
            platformId,
            platformName,
            collateralAmount: prodInfo.collateralAmount ?? prodInfo[5],
            pendingAmount: prodInfo.pendingAmount ?? prodInfo[6],
            availableAmount: prodInfo.availableAmount ?? prodInfo[7],
            isActive: prodInfo.isActive ?? prodInfo[8],
            activeOrderCount: prodInfo.activeOrderCount ?? prodInfo[9],
            rate: Number(rateInfo.rate ?? rateInfo[0]) / 1e8,
            isOpen
          });
        } catch (e) {
          console.error(`Error loading product crypto index ${i}:`, e);
        }
      }

      // Fetch sell fiat products
      for (let i = 0; i < sellFiatAmount; i++) {
        try {
          const prodInfo = await publicClient.readContract({
            address: ESCROW_ADDRESS,
            abi: C2C_ESCROW_ABI,
            functionName: 'getProductInfo',
            args: [account, BigInt(i), 1]
          }) as any;

          const rateInfo = await publicClient.readContract({
            address: ADMIN_ADDRESS,
            abi: C2C_ADMIN_ABI,
            functionName: 'getMerchantRate',
            args: [account, BigInt(i), 1]
          }) as any;

          const isOpen = await publicClient.readContract({
            address: ADMIN_ADDRESS,
            abi: C2C_ADMIN_ABI,
            functionName: 'isMerchantOpen',
            args: [account, BigInt(i), 1]
          }) as boolean;

          const platformId = (prodInfo.platformId ?? prodInfo[4]) as `0x${string}`;
          const wiseId = keccak256(stringToBytes('wise')).toLowerCase();
          const alipayId = keccak256(stringToBytes('alipay')).toLowerCase();
          const platformName = platformId.toLowerCase() === wiseId ? 'Wise' : platformId.toLowerCase() === alipayId ? 'Alipay' : 'Wise';

          fetchedList.push({
            productId: BigInt(i),
            cryptoID: prodInfo.cryptoID ?? prodInfo[1],
            fiatID: prodInfo.fiatID ?? prodInfo[2],
            assetType: 1,
            platformId,
            platformName,
            collateralAmount: prodInfo.collateralAmount ?? prodInfo[5],
            pendingAmount: prodInfo.pendingAmount ?? prodInfo[6],
            availableAmount: prodInfo.availableAmount ?? prodInfo[7],
            isActive: prodInfo.isActive ?? prodInfo[8],
            activeOrderCount: prodInfo.activeOrderCount ?? prodInfo[9],
            rate: Number(rateInfo.rate ?? rateInfo[0]) / 1e8,
            isOpen
          });
        } catch (e) {
          console.error(`Error loading product fiat index ${i}:`, e);
        }
      }

      setProducts(fetchedList);
    } catch (err) {
      console.error('Failed to load merchant products:', err);
    } finally {
      setLoadingProducts(false);
    }
  }, [account, isMerchant, ESCROW_ADDRESS, ADMIN_ADDRESS, publicClient]);

  const fetchOrders = useCallback(async () => {
    if (!account || !isMerchant) return;
    setLoadingOrders(true);
    try {
      const logs = await publicClient.getLogs({
        address: ESCROW_ADDRESS,
        event: {
          type: 'event',
          name: 'OrderPlaced',
          inputs: [
            { indexed: true, name: 'buyer', type: 'address' },
            { indexed: true, name: 'merchant', type: 'address' },
            { indexed: true, name: 'orderId', type: 'uint256' },
            { indexed: false, name: 'productId', type: 'uint256' },
            { indexed: false, name: 'assetType', type: 'uint8' },
            { indexed: false, name: 'amount', type: 'uint256' },
            { indexed: false, name: 'rate', type: 'uint256' },
            { indexed: false, name: 'deadline', type: 'uint256' },
            { indexed: false, name: 'salt', type: 'uint256' }
          ]
        },
        args: { merchant: account } as any,
        fromBlock: 0n
      });

      const items: MerchantOrder[] = await Promise.all(
        logs.map(async (l: any) => {
          const a = l.args as any;
          const assetType = Number(a.assetType);
          const orderTuple = await publicClient.readContract({
            address: ESCROW_ADDRESS,
            abi: C2C_ESCROW_ABI,
            functionName: 'getOrder',
            args: [account, a.productId, assetType, a.orderId],
          }) as any;
          const platformId = await publicClient.readContract({
            address: ESCROW_ADDRESS,
            abi: C2C_ESCROW_ABI,
            functionName: 'getProductPlatformId',
            args: [account, a.productId, assetType],
          }) as `0x${string}`;

          const wiseId = keccak256(stringToBytes('wise')).toLowerCase();
          const alipayId = keccak256(stringToBytes('alipay')).toLowerCase();
          const platformName = platformId.toLowerCase() === wiseId ? 'Wise' : platformId.toLowerCase() === alipayId ? 'Alipay' : 'Wise';

          return {
            buyer: orderTuple[0],
            merchant: account,
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

      // We only care about pending (status 0) and waiting merchant release (status 3) orders
      setOrders(items.filter(o => o.status === 0 || o.status === 3));
    } catch (err) {
      console.error('Failed to load merchant orders:', err);
    } finally {
      setLoadingOrders(false);
    }
  }, [account, isMerchant, ESCROW_ADDRESS, publicClient]);

  useEffect(() => {
    fetchMerchantStatus();
  }, [account, fetchMerchantStatus]);

  useEffect(() => {
    if (isMerchant) {
      fetchProducts();
      fetchOrders();
    }
  }, [isMerchant, fetchProducts, fetchOrders]);

  const handleApplyAcceptor = async () => {
    if (!account) return;
    setIsApplying(true);
    try {
      const res = await fetch('/api/acceptors/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: account })
      });
      if (res.ok) {
        showToast(lang === 'zh' ? '自愿入驻申请提交成功，正在等待超级管理员审核！' : 'Application submitted successfully! Waiting for super admin approval.', 'success');
        fetchMerchantStatus();
      } else {
        const data = await res.json();
        throw new Error(data.error || 'Failed to submit application');
      }
    } catch (e: any) {
      console.error(e);
      showToast(e.message || String(e), 'warning');
    } finally {
      setIsApplying(false);
    }
  };

  const handleClaimBond = async () => {
    if (!account) return;
    setIsClaiming(true);
    try {
      const ethereum = getEthereum();
      if (!ethereum) return;
      const walletClient = createWalletClient({
        account,
        chain: targetChain,
        transport: custom(ethereum)
      });
      const hash = await (walletClient as any).writeContract({
        address: BOND_VAULT_ADDRESS,
        abi: C2C_BOND_VAULT_ABI,
        functionName: 'claim',
        args: [USDT_ADDRESS]
      });
      await publicClient.waitForTransactionReceipt({ hash });
      showToast(lang === 'zh' ? '成功赎回质押保证金！' : 'Successfully claimed bond collateral!', 'success');
      fetchMerchantStatus();
    } catch (e: any) {
      console.error(e);
      showToast(e.message || String(e), 'warning');
    } finally {
      setIsClaiming(false);
    }
  };

  const handleListProduct = async () => {
    if (!account) return;
    setIsListing(true);
    try {
      const ethereum = getEthereum();
      if (!ethereum) return;
      const walletClient = createWalletClient({
        account,
        chain: targetChain,
        transport: custom(ethereum)
      });

      const listAmount = parseUnits(newAmount, 18);
      const platformId = keccak256(stringToBytes(newPlatform)) as `0x${string}`;

      // Approve escrow for collateral
      const approveTx = await (walletClient as any).writeContract({
        address: USDT_ADDRESS,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [ESCROW_ADDRESS, listAmount]
      });
      await publicClient.waitForTransactionReceipt({ hash: approveTx });

      let hash: `0x${string}`;
      if (newAssetType === 0) {
        hash = await (walletClient as any).writeContract({
          address: ESCROW_ADDRESS,
          abi: C2C_ESCROW_ABI,
          functionName: 'listCryptoProduct',
          args: [BigInt(newCryptoId), BigInt(newFiatId), listAmount, true, platformId]
        });
      } else {
        hash = await (walletClient as any).writeContract({
          address: ESCROW_ADDRESS,
          abi: C2C_ESCROW_ABI,
          functionName: 'listFiatProduct',
          args: [BigInt(newFiatId), BigInt(newCryptoId), listAmount, true, platformId]
        });
      }

      await publicClient.waitForTransactionReceipt({ hash });
      showToast(lang === 'zh' ? '新换汇交易商品发布上架成功！' : 'New product listed successfully!', 'success');
      fetchProducts();
      fetchMerchantStatus();
      setNewAmount('1000');
    } catch (e: any) {
      console.error(e);
      showToast(e.message || String(e), 'warning');
    } finally {
      setIsListing(false);
    }
  };

  // Product Row updates
  const handleToggleProduct = async (p: ProductDetail, active: boolean) => {
    if (!account) return;
    try {
      const ethereum = getEthereum();
      if (!ethereum) return;
      const walletClient = createWalletClient({
        account,
        chain: targetChain,
        transport: custom(ethereum)
      });

      const hash = await (walletClient as any).writeContract({
        address: ESCROW_ADDRESS,
        abi: C2C_ESCROW_ABI,
        functionName: active ? 'activeProduct' : 'inactiveProduct',
        args: [p.productId, p.assetType]
      });
      await publicClient.waitForTransactionReceipt({ hash });
      fetchProducts();
    } catch (e: any) {
      console.error(e);
      showToast(e.message || String(e), 'warning');
    }
  };

  const handleUpdateRate = async (p: ProductDetail) => {
    const key = `${p.productId}_${p.assetType}`;
    const rateValStr = editRates[key] !== undefined ? editRates[key] : p.rate.toString();
    if (!account || !rateValStr) return;
    try {
      const ethereum = getEthereum();
      if (!ethereum) return;
      const walletClient = createWalletClient({
        account,
        chain: targetChain,
        transport: custom(ethereum)
      });

      const rateVal = BigInt(Math.round(parseFloat(rateValStr) * 1e8));
      const exp = BigInt(Math.floor(Date.now() / 1000) + 3600 * 24 * 7); // Valid for 7 days

      const hash = await (walletClient as any).writeContract({
        address: ADMIN_ADDRESS,
        abi: C2C_ADMIN_ABI,
        functionName: 'publishRate',
        args: [p.productId, p.assetType, rateVal, exp]
      });
      await publicClient.waitForTransactionReceipt({ hash });
      fetchProducts();
      setEditRates(prev => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    } catch (e: any) {
      console.error(e);
      showToast(e.message || String(e), 'warning');
    }
  };

  const handleUpdateHours = async (p: ProductDetail) => {
    if (!account) return;
    const key = `${p.productId}_${p.assetType}`;
    const openH = editOpenHours[key] !== undefined ? editOpenHours[key] : '8';
    const closeH = editCloseHours[key] !== undefined ? editCloseHours[key] : '22';
    try {
      const ethereum = getEthereum();
      if (!ethereum) return;
      const walletClient = createWalletClient({
        account,
        chain: targetChain,
        transport: custom(ethereum)
      });

      const openSec = Number(openH) * 3600;
      const closeSec = Number(closeH) * 3600;
      const activeDays = 127; // Mon - Sun

      const hash = await (walletClient as any).writeContract({
        address: ADMIN_ADDRESS,
        abi: C2C_ADMIN_ABI,
        functionName: 'setBusinessHours',
        args: [p.productId, p.assetType, openSec, closeSec, activeDays]
      });
      await publicClient.waitForTransactionReceipt({ hash });
      fetchProducts();
    } catch (e: any) {
      console.error(e);
      showToast(e.message || String(e), 'warning');
    }
  };

  const handleManualOpenClose = async (p: ProductDetail, open: boolean) => {
    if (!account) return;
    try {
      const ethereum = getEthereum();
      if (!ethereum) return;
      const walletClient = createWalletClient({
        account,
        chain: targetChain,
        transport: custom(ethereum)
      });

      const hash = await (walletClient as any).writeContract({
        address: ADMIN_ADDRESS,
        abi: C2C_ADMIN_ABI,
        functionName: open ? 'openNow' : 'closeNow',
        args: [p.productId, p.assetType]
      });
      await publicClient.waitForTransactionReceipt({ hash });
      fetchProducts();
    } catch (e: any) {
      console.error(e);
      showToast(e.message || String(e), 'warning');
    }
  };

  const handleAdjustCollateral = async (p: ProductDetail, add: boolean) => {
    const key = `${p.productId}_${p.assetType}`;
    const delta = collateralDeltas[key];
    if (!account || !delta) return;
    try {
      const ethereum = getEthereum();
      if (!ethereum) return;
      const walletClient = createWalletClient({
        account,
        chain: targetChain,
        transport: custom(ethereum)
      });

      const amountVal = parseUnits(delta, 18);

      if (add) {
        // Approve USDT
        const approveTx = await (walletClient as any).writeContract({
          address: USDT_ADDRESS,
          abi: ERC20_ABI,
          functionName: 'approve',
          args: [ESCROW_ADDRESS, amountVal]
        });
        await publicClient.waitForTransactionReceipt({ hash: approveTx });
      }

      const hash = await (walletClient as any).writeContract({
        address: ESCROW_ADDRESS,
        abi: C2C_ESCROW_ABI,
        functionName: add ? 'addAmount' : 'takeAmount',
        args: [p.productId, p.assetType, amountVal]
      });

      await publicClient.waitForTransactionReceipt({ hash });
      fetchProducts();
      fetchMerchantStatus();
      setCollateralDeltas(prev => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    } catch (e: any) {
      console.error(e);
      showToast(e.message || String(e), 'warning');
    }
  };

  // Merchant release escrow with proof for Fiat Orders (Real zkTLS)
  const handleMerchantSettleFiatOrder = async (order: MerchantOrder) => {
    if (!account) return;
    setProvingStatus('proving');
    setErrorMsg('');
    setProveProgress(10);
    setProveMessage(lang === 'zh' ? '🔐 建立加密连接并准备开始清算证明...' : '🔐 Connecting to platform APIs...');

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

      // Construct context orderBindingHash placeholder
      const orderBindingHash = '0x0000000000000000000000000000000000000000000000000000000000000000';
      
      const pluginUrl = order.platformName.toLowerCase() === 'alipay' ? '/plugins/alipay.js' : '/plugins/wise.js';
      setProveProgress(30);
      setProveMessage(lang === 'zh' ? `⚡ 正在加载 ${order.platformName} 清算插件...` : `⚡ Loading ${order.platformName} settlement plugin...`);
      
      const resPlugin = await fetch(pluginUrl);
      if (!resPlugin.ok) throw new Error('Plugin load failed');
      let pluginCode = await resPlugin.text();

      // Simple replacement
      pluginCode = pluginCode
        .replace(/"0x0000000000000000000000000000000000000000000000000000000000000001"/g, `"${orderBindingHash}"`)
        .replace(/'0x0000000000000000000000000000000000000000000000000000000000000001'/g, `'${orderBindingHash}'`);

      setProveProgress(50);
      setProveMessage(lang === 'zh' ? '✍️ 请在浏览器弹窗中登录网银并完成公证...' : '✍️ Please log in and complete notary in browser...');

      const reqId = `merchant_settle_${Date.now()}`;
      const resultStr = await (window as any).tlsn.execCode(pluginCode, {
        requestId: reqId,
        sessionData: { mode: 'Mpc' }
      });

      const parsedResult = JSON.parse(resultStr);
      setProveProgress(80);
      setProveMessage(lang === 'zh' ? '✅ zkTLS 证明生成成功！正在提交智能合约释放资金...' : '✅ Proof success! Releasing funds in escrow...');

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

      // Settle Fiat Order by merchant
      const hash = await (walletClient as any).writeContract({
        address: ESCROW_ADDRESS,
        abi: C2C_ESCROW_ABI,
        functionName: 'receiveCryptoWithPlatformPayment',
        args: [order.productId, order.orderId, proofsArr]
      });

      await publicClient.waitForTransactionReceipt({ hash });
      setProvingStatus('success');
      fetchOrders();
    } catch (err: any) {
      console.error(err);
      setErrorMsg(err.message || 'Settle failed');
      setProvingStatus('error');
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', width: '100%' }}>
      
      {/* Loading state */}
      {loading && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '40px' }}>
          <Loader2 size={32} className="animate-spin" color="var(--primary)" />
        </div>
      )}

      {/* 1. Unregistered Merchant View */}
      {!loading && !isMerchant && (
        <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', padding: '30px', textAlign: 'center', alignItems: 'center' }}>
          
          {applicationStatus === 'pending' ? (
            // 等待审核状态 UI
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1.25rem', width: '100%', maxWidth: '480px' }}>
              <div style={{
                background: 'rgba(245, 158, 11, 0.1)',
                color: 'var(--warning)',
                padding: '12px',
                borderRadius: '50%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                filter: 'drop-shadow(0 0 10px rgba(245, 158, 11, 0.2))'
              }}>
                <Clock size={40} className="animate-pulse" />
              </div>
              <h2 style={{ margin: 0, fontSize: '1.5rem', fontWeight: 800, color: 'var(--text-highlight)' }}>
                {lang === 'zh' ? '承兑商入驻申请审核中' : 'Acceptor Application Pending'}
              </h2>
              <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '0.9rem', lineHeight: '1.5' }}>
                {lang === 'zh'
                  ? '您的地址已自愿申请入驻平台承兑商，当前正在等待系统超级管理员审核。审核通过后，该终端将自动激活解锁。'
                  : 'Your address has voluntarily applied to become a platform acceptor. Currently waiting for super admin review. This terminal will unlock automatically upon approval.'}
              </p>
              
              <div style={{
                background: 'rgba(255,255,255,0.02)',
                border: '1px solid rgba(255,255,255,0.05)',
                borderRadius: '8px',
                padding: '10px 14px',
                width: '100%',
                display: 'flex',
                flexDirection: 'column',
                gap: '6px',
                fontSize: '0.8rem',
                textAlign: 'left'
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--text-muted)' }}>{lang === 'zh' ? '申请钱包地址:' : 'Application Address:'}</span>
                  <span style={{ fontFamily: 'monospace', color: 'var(--text-primary)', fontWeight: 600 }}>
                    {account ? `${account.slice(0, 10)}...${account.slice(-8)}` : ''}
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ color: 'var(--text-muted)' }}>{lang === 'zh' ? '审核状态:' : 'Status:'}</span>
                  <span style={{ color: 'var(--warning)', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'var(--warning)', display: 'inline-block' }} className="animate-ping" />
                    {lang === 'zh' ? '等待审核 (Pending)' : 'Pending Verification'}
                  </span>
                </div>
              </div>

              <button
                onClick={fetchMerchantStatus}
                className="btn-primary"
                style={{
                  padding: '8px 20px',
                  fontSize: '0.85rem',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  marginTop: '10px'
                }}
              >
                <RefreshCw size={14} />
                <span>{lang === 'zh' ? '手动刷新状态' : 'Refresh Status'}</span>
              </button>
            </div>
          ) : (
            // 未入驻申请 UI
            <>
              <Store size={48} color="var(--primary)" style={{ filter: 'drop-shadow(0 0 10px var(--primary-glow))' }} />
              <h2 style={{ margin: 0, fontSize: '1.5rem', fontWeight: 800 }}>
                {lang === 'zh' ? '承兑商入驻中心' : 'Merchant Terminal'}
              </h2>
              <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '0.9rem', maxWidth: '500px', lineHeight: '1.5' }}>
                {lang === 'zh'
                  ? '成为平台承兑商以提供出金、入金双向兑换支持。您可以自愿直接申请入驻，由超级管理员进行地址审核与批准。'
                  : 'Register as an exchange merchant on-chain. Voluntarily apply directly to be verified and approved by the platform super admin.'}
              </p>

              {account ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', width: '100%', maxWidth: '320px', marginTop: '10px' }}>
                  {isApplying ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', alignItems: 'center', marginTop: '10px' }}>
                      <Loader2 size={24} className="animate-spin" color="var(--primary)" />
                      <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                        {lang === 'zh' ? '正在提交入驻申请...' : 'Submitting onboarding application...'}
                      </span>
                    </div>
                  ) : (
                    <>
                      <button
                        onClick={handleApplyAcceptor}
                        className="btn-primary"
                        style={{ width: '100%', padding: '10px', fontSize: '0.9rem' }}
                      >
                        {lang === 'zh' ? '自愿入驻成为承兑商' : 'Voluntarily Apply to Become Acceptor'}
                      </button>
                    </>
                  )}
                </div>
              ) : (
                <button onClick={connectWallet} className="btn-primary" style={{ padding: '8px 16px', marginTop: '10px' }}>
                  {lang === 'zh' ? '连接以太坊钱包以开始' : 'Connect Wallet to Start'}
                </button>
              )}
            </>
          )}
        </div>
      )}

      {/* 2. Registered Merchant Dashboard */}
      {!loading && isMerchant && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          
          {/* Status bar */}
          <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1.5rem' }}>
            <div className="glass-card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{lang === 'zh' ? '承兑商状态' : 'Merchant Status'}</span>
                <div style={{ fontSize: '1.25rem', fontWeight: 800, color: 'var(--success)', display: 'flex', alignItems: 'center', gap: '6px', marginTop: '4px' }}>
                  <ShieldCheck size={20} />
                  <span>{lang === 'zh' ? '正常营业中' : 'Active'}</span>
                </div>
              </div>
              <Store size={36} color="var(--success)" style={{ opacity: 0.15 }} />
            </div>

            <div className="glass-card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{lang === 'zh' ? '可赎回质押金' : 'Claimable Bond'}</span>
                <div style={{ fontSize: '1.25rem', fontWeight: 800, color: 'var(--text-primary)', marginTop: '4px' }}>
                  {Number(claimableBond).toFixed(2)} USDT
                </div>
              </div>
              {Number(claimableBond) > 0 && (
                <button
                  onClick={handleClaimBond}
                  disabled={isClaiming}
                  className="btn-primary"
                  style={{ padding: '6px 12px', fontSize: '0.8rem', borderRadius: '6px', margin: 0 }}
                >
                  {isClaiming ? 'Claiming...' : (lang === 'zh' ? '赎回' : 'Claim')}
                </button>
              )}
            </div>
          </section>

          {/* List new product */}
          <section className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div style={{ background: 'rgba(99, 102, 241, 0.1)', color: 'var(--primary)', padding: '6px', borderRadius: '8px' }}>
                <Plus size={18} />
              </div>
              <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 700 }}>
                {lang === 'zh' ? '上架新外汇商品' : 'List New FX Product'}
              </h3>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem' }}>
              <div>
                <label style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '4px' }}>
                  {lang === 'zh' ? '商品类别' : 'Product Type'}
                </label>
                <select
                  value={newAssetType}
                  onChange={(e) => setNewAssetType(Number(e.target.value))}
                  className="select-field"
                  style={{ width: '100%', height: '40px' }}
                >
                  <option value="0">{lang === 'zh' ? '出金 (Sell Crypto)' : 'Sell Crypto'}</option>
                  <option value="1">{lang === 'zh' ? '入金 (Sell Fiat)' : 'Sell Fiat'}</option>
                </select>
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '4px' }}>
                  {lang === 'zh' ? '数字货币 ID' : 'Crypto Asset'}
                </label>
                <select value={newCryptoId} onChange={(e) => setNewCryptoId(e.target.value)} className="select-field" style={{ width: '100%', height: '40px' }}>
                  <option value="0">USDT</option>
                  <option value="1">USDC</option>
                </select>
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '4px' }}>
                  {lang === 'zh' ? '法定货币 ID' : 'Fiat Currency'}
                </label>
                <select value={newFiatId} onChange={(e) => setNewFiatId(e.target.value)} className="select-field" style={{ width: '100%', height: '40px' }}>
                  <option value="0">CNY</option>
                  <option value="1">USD</option>
                  <option value="2">MYR</option>
                </select>
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '4px' }}>
                  {lang === 'zh' ? '绑定支付网络' : 'Payout Platform'}
                </label>
                <select value={newPlatform} onChange={(e) => setNewPlatform(e.target.value as any)} className="select-field" style={{ width: '100%', height: '40px' }}>
                  <option value="wise">Wise</option>
                  <option value="alipay">Alipay</option>
                </select>
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '4px' }}>
                  {lang === 'zh' ? '初始质押金' : 'Stake Collateral'}
                </label>
                <input
                  type="number"
                  value={newAmount}
                  onChange={(e) => setNewAmount(e.target.value)}
                  className="input-field"
                  placeholder="1000"
                  style={{ height: '40px' }}
                />
              </div>
            </div>

            <button
              onClick={handleListProduct}
              disabled={isListing || !newAmount}
              className="btn-primary"
              style={{ width: '100%', padding: '10px', fontSize: '0.9rem', marginTop: '10px' }}
            >
              {isListing ? 'Listing...' : (lang === 'zh' ? '确认发布上架' : 'Publish Product')}
            </button>
          </section>

          {/* Manage listed products */}
          <section className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div style={{ background: 'rgba(16, 185, 129, 0.1)', color: 'var(--success)', padding: '6px', borderRadius: '8px' }}>
                <Award size={18} />
              </div>
              <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 700 }}>
                {lang === 'zh' ? '我已发布的商品清单' : 'My Listed Products'}
              </h3>
            </div>

            {loadingProducts ? (
              <div style={{ display: 'flex', justifyContent: 'center', padding: '20px' }}>
                <Loader2 size={24} className="animate-spin" color="var(--primary)" />
              </div>
            ) : products.length === 0 ? (
              <div style={{ padding: '30px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                {lang === 'zh' ? '当前没有发布任何商品，请在上方创建新商品！' : 'No listed products found.'}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                {products.map((p) => {
                  const key = `${p.productId}_${p.assetType}`;
                  const isExpanded = !collapsedProducts.has(key);

                  return (
                    <div key={key} style={{
                      background: 'rgba(255,255,255,0.01)',
                      border: '1px solid rgba(255,255,255,0.04)',
                      borderRadius: '12px',
                      overflow: 'hidden'
                    }}>
                      {/* Row header */}
                      <div
                        onClick={() => {
                          setCollapsedProducts(prev => {
                            const next = new Set(prev);
                            if (next.has(key)) {
                              next.delete(key);
                            } else {
                              next.add(key);
                            }
                            return next;
                          });
                          if (editRates[key] === undefined) {
                            setEditRates(prev => ({ ...prev, [key]: p.rate.toString() }));
                          }
                        }}
                        style={{
                          padding: '14px 16px',
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          cursor: 'pointer',
                          background: isExpanded ? 'rgba(255,255,255,0.01)' : 'transparent',
                          transition: 'background 0.2s',
                          flexWrap: 'wrap',
                          gap: '10px'
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                          <ChevronRight size={16} style={{
                            transform: isExpanded ? 'rotate(90deg)' : 'none',
                            transition: 'transform 0.2s',
                            color: 'var(--text-muted)'
                          }} />
                          <span style={{
                            fontWeight: 700,
                            background: p.assetType === 0 ? 'rgba(16, 185, 129, 0.1)' : 'rgba(245, 158, 11, 0.1)',
                            color: p.assetType === 0 ? 'var(--success)' : 'var(--warning)',
                            padding: '2px 6px',
                            borderRadius: '4px',
                            fontSize: '0.7rem'
                          }}>
                            {p.assetType === 0 ? (lang === 'zh' ? '出金' : 'SELL CRYPTO') : (lang === 'zh' ? '入金' : 'SELL FIAT')}
                          </span>
                          <span style={{ fontWeight: 600, fontSize: '0.85rem', color: 'var(--text-primary)' }}>
                            {p.platformName} (#{p.productId.toString()})
                          </span>
                          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                            · {lang === 'zh' ? '可用保证金：' : 'Avail: '}{parseFloat(formatUnits(p.availableAmount, 18)).toFixed(0)} USDT
                          </span>
                          <span style={{
                            width: '8px',
                            height: '8px',
                            borderRadius: '50%',
                            background: p.isOpen ? 'var(--success)' : 'var(--danger)'
                          }} />
                          <span style={{ fontSize: '0.75rem', color: p.isOpen ? 'var(--success)' : 'var(--danger)' }}>
                            {p.isOpen ? (lang === 'zh' ? '商家上线' : 'Online') : (lang === 'zh' ? '商家下线' : 'Offline')}
                          </span>
                        </div>

                        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                          <strong style={{ fontSize: '0.95rem', color: 'var(--text-primary)', fontFamily: 'monospace' }}>
                            Rate: {p.rate.toFixed(4)}
                          </strong>
                          <div style={{ display: 'flex', gap: '6px' }} onClick={e => e.stopPropagation()}>
                            <button
                              onClick={() => handleToggleProduct(p, !p.isActive)}
                              className="btn-primary"
                              style={{
                                padding: '4px 8px',
                                fontSize: '0.7rem',
                                borderRadius: '4px',
                                background: p.isActive ? 'rgba(239,68,68,0.1)' : 'rgba(16,185,129,0.1)',
                                border: p.isActive ? '1px solid rgba(239,68,68,0.2)' : '1px solid rgba(16,185,129,0.2)',
                                color: p.isActive ? 'var(--danger)' : 'var(--success)',
                                cursor: 'pointer',
                                transition: 'all 0.2s'
                              }}
                            >
                              {p.isActive ? (lang === 'zh' ? '商品下架' : 'Delist Product') : (lang === 'zh' ? '商品上架' : 'List Product')}
                            </button>
                          </div>
                        </div>
                      </div>

                      {/* Row Expanded panel */}
                      {isExpanded && (
                        <div style={{
                          padding: '20px',
                          borderTop: theme === 'dark' ? '1px solid rgba(255,255,255,0.05)' : '1px solid rgba(0,0,0,0.06)',
                          background: theme === 'dark' ? 'rgba(0,0,0,0.2)' : '#f9fafb',
                          display: 'grid',
                          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                          gap: '16px',
                          borderRadius: '0 0 12px 12px'
                        }}>
                          
                          {/* 业务逻辑解释提示横幅 */}
                          <div style={{
                            gridColumn: '1 / -1',
                            background: theme === 'dark' ? 'rgba(99, 102, 241, 0.05)' : 'rgba(99, 102, 241, 0.03)',
                            border: theme === 'dark' ? '1px solid rgba(99, 102, 241, 0.15)' : '1px solid rgba(99, 102, 241, 0.12)',
                            borderRadius: '12px',
                            padding: '12px 16px',
                            fontSize: '0.75rem',
                            color: 'var(--text-muted)',
                            lineHeight: '1.45',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '4px'
                          }}>
                            <strong style={{ color: 'var(--primary)', display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.8rem' }}>
                              💡 {lang === 'zh' ? '独立商品业务配置说明' : 'Product-Specific Setting Explanation'}
                            </strong>
                            <span>
                              {lang === 'zh' 
                                ? `即期汇率、营业时间、商家上线/下线状态及保证金均绑定于当前具体的商品 [${p.platformName} (#${p.productId.toString()})]。它们在智能合约中完全独立存储 and 调节，以实现不同支付渠道间的风险和资金隔离。您顶部的全局“承兑商状态：正常营业中”代表您的全局入驻资格处于激活状态。`
                                : `Exchange rate, business hours, online/offline status, and collateral are bound specifically to this product [${p.platformName} (#${p.productId.toString()})]. They are stored and adjusted independently on-chain for risk and asset isolation between networks. Your global "Merchant Status: Active" on top indicates that your overall enrollment is validated.`
                              }
                            </span>
                          </div>

                          {/* 1. 汇率调节卡片 */}
                          <div style={{
                            background: theme === 'dark' ? 'rgba(255,255,255,0.02)' : '#ffffff',
                            border: theme === 'dark' ? '1px solid rgba(255,255,255,0.05)' : '1px solid rgba(0,0,0,0.06)',
                            borderRadius: '12px',
                            padding: '16px',
                            boxShadow: '0 2px 8px rgba(0,0,0,0.02)',
                            display: 'flex',
                            flexDirection: 'column',
                            justifyContent: 'space-between',
                            gap: '12px'
                          }}>
                            <div>
                              <strong style={{ display: 'block', fontSize: '0.85rem', color: theme === 'dark' ? 'rgba(255,255,255,0.9)' : '#1f2937', fontWeight: 700 }}>
                                {lang === 'zh' ? '📈 即期汇率调节' : '📈 Exchange Rate'}
                              </strong>
                              <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', display: 'block', marginTop: '2px' }}>
                                {lang === 'zh' ? `当前汇率: ${p.rate.toFixed(4)}` : `Current: ${p.rate.toFixed(4)}`}
                              </span>
                            </div>
                            <div style={{ display: 'flex', gap: '8px' }}>
                              <input
                                type="number"
                                placeholder={lang === 'zh' ? '输入新汇率' : 'New rate'}
                                value={editRates[key] !== undefined ? editRates[key] : p.rate.toString()}
                                onChange={(e) => setEditRates(prev => ({ ...prev, [key]: e.target.value }))}
                                className="input-field"
                                style={{
                                  padding: '6px 12px',
                                  fontSize: '0.85rem',
                                  height: '36px',
                                  borderRadius: '8px',
                                  background: theme === 'dark' ? 'rgba(255,255,255,0.03)' : '#ffffff',
                                  border: theme === 'dark' ? '1px solid rgba(255,255,255,0.1)' : '1px solid #d1d5db',
                                  flex: 1
                                }}
                              />
                              <button
                                onClick={() => handleUpdateRate(p)}
                                className="btn-primary"
                                style={{
                                  padding: '0 14px',
                                  fontSize: '0.8rem',
                                  height: '36px',
                                  borderRadius: '8px',
                                  fontWeight: 600
                                }}
                              >
                                {lang === 'zh' ? '修改' : 'Update'}
                              </button>
                            </div>
                          </div>

                          {/* 2. 手动营业状态卡片 */}
                          <div style={{
                            background: theme === 'dark' ? 'rgba(255,255,255,0.02)' : '#ffffff',
                            border: theme === 'dark' ? '1px solid rgba(255,255,255,0.05)' : '1px solid rgba(0,0,0,0.06)',
                            borderRadius: '12px',
                            padding: '16px',
                            boxShadow: '0 2px 8px rgba(0,0,0,0.02)',
                            display: 'flex',
                            flexDirection: 'column',
                            justifyContent: 'space-between',
                            gap: '12px'
                          }}>
                            <div>
                              <strong style={{ display: 'block', fontSize: '0.85rem', color: theme === 'dark' ? 'rgba(255,255,255,0.9)' : '#1f2937', fontWeight: 700 }}>
                                {lang === 'zh' ? '🚪 营业状态覆盖' : '🚪 Business Override'}
                              </strong>
                              <span style={{
                                 fontSize: '0.72rem',
                                 color: p.isOpen ? '#10b981' : '#ef4444',
                                 display: 'inline-flex',
                                 alignItems: 'center',
                                 gap: '4px',
                                 marginTop: '2px',
                                 fontWeight: 600
                               }}>
                                 <span style={{
                                   width: '6px',
                                   height: '6px',
                                   borderRadius: '50%',
                                   background: p.isOpen ? '#10b981' : '#ef4444',
                                   display: 'inline-block'
                                 }} />
                                 {lang === 'zh' ? (p.isOpen ? '当前状态: 商家上线' : '当前状态: 商家下线') : (p.isOpen ? 'Status: Online' : 'Status: Offline')}
                               </span>
                            </div>
                            <div style={{ display: 'flex', gap: '8px' }}>
                              <button
                                onClick={() => handleManualOpenClose(p, true)}
                                style={{
                                  flex: 1,
                                  height: '36px',
                                  borderRadius: '8px',
                                  fontSize: '0.8rem',
                                  fontWeight: 600,
                                  cursor: 'pointer',
                                  transition: 'all 0.2s',
                                  background: p.isOpen ? '#10b981' : (theme === 'dark' ? 'rgba(16,185,129,0.1)' : 'rgba(16,185,129,0.05)'),
                                  color: p.isOpen ? '#ffffff' : '#10b981',
                                  border: p.isOpen ? '1px solid #10b981' : (theme === 'dark' ? '1px solid rgba(16,185,129,0.2)' : '1px solid rgba(16,185,129,0.4)')
                                }}
                              >
                                {lang === 'zh' ? '商家上线' : 'Go Online'}
                              </button>
                              <button
                                onClick={() => handleManualOpenClose(p, false)}
                                style={{
                                  flex: 1,
                                  height: '36px',
                                  borderRadius: '8px',
                                  fontSize: '0.8rem',
                                  fontWeight: 600,
                                  cursor: 'pointer',
                                  transition: 'all 0.2s',
                                  background: !p.isOpen ? '#ef4444' : (theme === 'dark' ? 'rgba(239,68,68,0.1)' : 'rgba(239,68,68,0.05)'),
                                  color: !p.isOpen ? '#ffffff' : '#ef4444',
                                  border: !p.isOpen ? '1px solid #ef4444' : (theme === 'dark' ? '1px solid rgba(239,68,68,0.2)' : '1px solid rgba(239,68,68,0.4)')
                                }}
                              >
                                {lang === 'zh' ? '商家下线' : 'Go Offline'}
                              </button>
                            </div>
                          </div>

                          {/* 3. 营业时间段设置 */}
                          <div style={{
                            background: theme === 'dark' ? 'rgba(255,255,255,0.02)' : '#ffffff',
                            border: theme === 'dark' ? '1px solid rgba(255,255,255,0.05)' : '1px solid rgba(0,0,0,0.06)',
                            borderRadius: '12px',
                            padding: '16px',
                            boxShadow: '0 2px 8px rgba(0,0,0,0.02)',
                            display: 'flex',
                            flexDirection: 'column',
                            justifyContent: 'space-between',
                            gap: '12px'
                          }}>
                            <div>
                              <strong style={{ display: 'block', fontSize: '0.85rem', color: theme === 'dark' ? 'rgba(255,255,255,0.9)' : '#1f2937', fontWeight: 700 }}>
                                {lang === 'zh' ? '🕒 营业时间设置' : '🕒 Business Hours'}
                              </strong>
                              <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', display: 'block', marginTop: '2px' }}>
                                {lang === 'zh' ? '输入 24 小时制整数小时' : 'Enter 24h format hours'}
                              </span>
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                              <input
                                type="number"
                                value={editOpenHours[key] !== undefined ? editOpenHours[key] : '8'}
                                onChange={(e) => setEditOpenHours(prev => ({ ...prev, [key]: e.target.value }))}
                                className="input-field"
                                style={{
                                  width: '50px',
                                  padding: '6px',
                                  fontSize: '0.8rem',
                                  textAlign: 'center',
                                  height: '36px',
                                  borderRadius: '8px',
                                  background: theme === 'dark' ? 'rgba(255,255,255,0.03)' : '#ffffff',
                                  border: theme === 'dark' ? '1px solid rgba(255,255,255,0.1)' : '1px solid #d1d5db'
                                }}
                              />
                              <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>-</span>
                              <input
                                type="number"
                                value={editCloseHours[key] !== undefined ? editCloseHours[key] : '22'}
                                onChange={(e) => setEditCloseHours(prev => ({ ...prev, [key]: e.target.value }))}
                                className="input-field"
                                style={{
                                  width: '50px',
                                  padding: '6px',
                                  fontSize: '0.8rem',
                                  textAlign: 'center',
                                  height: '36px',
                                  borderRadius: '8px',
                                  background: theme === 'dark' ? 'rgba(255,255,255,0.03)' : '#ffffff',
                                  border: theme === 'dark' ? '1px solid rgba(255,255,255,0.1)' : '1px solid #d1d5db'
                                }}
                              />
                              <button
                                onClick={() => handleUpdateHours(p)}
                                className="btn-primary"
                                style={{
                                  padding: '0 14px',
                                  fontSize: '0.8rem',
                                  height: '36px',
                                  borderRadius: '8px',
                                  fontWeight: 600,
                                  flex: 1
                                }}
                              >
                                {lang === 'zh' ? '应用' : 'Apply'}
                              </button>
                            </div>
                          </div>

                          {/* 4. 保证金池卡片 */}
                          <div style={{
                            background: theme === 'dark' ? 'rgba(255,255,255,0.02)' : '#ffffff',
                            border: theme === 'dark' ? '1px solid rgba(255,255,255,0.05)' : '1px solid rgba(0,0,0,0.06)',
                            borderRadius: '12px',
                            padding: '16px',
                            boxShadow: '0 2px 8px rgba(0,0,0,0.02)',
                            display: 'flex',
                            flexDirection: 'column',
                            justifyContent: 'space-between',
                            gap: '12px'
                          }}>
                            <div>
                              <strong style={{ display: 'block', fontSize: '0.85rem', color: theme === 'dark' ? 'rgba(255,255,255,0.9)' : '#1f2937', fontWeight: 700 }}>
                                {lang === 'zh' ? '💰 调整保证金池' : '💰 Bond Pool Stake'}
                              </strong>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', marginTop: '4px' }}>
                                <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', display: 'block' }}>
                                  {lang === 'zh' ? `可用: ${formatUnits(p.availableAmount, 18)} USDT` : `Stake: ${formatUnits(p.availableAmount, 18)} USDT`}
                                </span>
                                <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', display: 'block' }}>
                                  {lang === 'zh' ? `账户余额: ${Number(usdtBalance).toFixed(2)} USDT` : `Wallet Balance: ${Number(usdtBalance).toFixed(2)} USDT`}
                                </span>
                              </div>
                            </div>
                            <div style={{ display: 'flex', gap: '6px' }}>
                              <input
                                type="number"
                                placeholder={lang === 'zh' ? '增加/减少额度' : 'Amount'}
                                value={collateralDeltas[key] ?? ''}
                                onChange={(e) => setCollateralDeltas(prev => ({ ...prev, [key]: e.target.value }))}
                                className="input-field"
                                style={{
                                  padding: '6px 12px',
                                  fontSize: '0.85rem',
                                  height: '36px',
                                  borderRadius: '8px',
                                  background: theme === 'dark' ? 'rgba(255,255,255,0.03)' : '#ffffff',
                                  border: theme === 'dark' ? '1px solid rgba(255,255,255,0.1)' : '1px solid #d1d5db',
                                  flex: 1
                                }}
                              />
                              <button
                                onClick={() => handleAdjustCollateral(p, true)}
                                style={{
                                  width: '36px',
                                  height: '36px',
                                  borderRadius: '8px',
                                  fontSize: '1rem',
                                  fontWeight: 'bold',
                                  cursor: 'pointer',
                                  transition: 'all 0.2s',
                                  background: theme === 'dark' ? 'rgba(16,185,129,0.15)' : 'rgba(16,185,129,0.1)',
                                  color: '#10b981',
                                  border: '1px solid rgba(16,185,129,0.3)'
                                }}
                              >
                                +
                              </button>
                              <button
                                onClick={() => handleAdjustCollateral(p, false)}
                                style={{
                                  width: '36px',
                                  height: '36px',
                                  borderRadius: '8px',
                                  fontSize: '1rem',
                                  fontWeight: 'bold',
                                  cursor: 'pointer',
                                  transition: 'all 0.2s',
                                  background: theme === 'dark' ? 'rgba(239,68,68,0.15)' : 'rgba(239,68,68,0.1)',
                                  color: '#ef4444',
                                  border: '1px solid rgba(239,68,68,0.3)'
                                }}
                              >
                                -
                              </button>
                            </div>
                          </div>

                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* Merchant orders tab */}
          <section className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            <div style={{ display: 'flex', justifyItems: 'center', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <div style={{ background: 'rgba(99, 102, 241, 0.1)', color: 'var(--primary)', padding: '6px', borderRadius: '8px' }}>
                  <FileText size={18} />
                </div>
                <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 700 }}>
                  {lang === 'zh' ? '承兑收单交易流水' : 'Merchant Order Settle Requests'}
                </h3>
              </div>
              <button onClick={fetchOrders} style={{ background: 'none', border: 'none', color: 'var(--primary)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.8rem', fontWeight: 600 }}>
                <Plus size={14} className={loadingOrders ? 'animate-spin' : ''} />
                <span>{lang === 'zh' ? '刷新' : 'Refresh'}</span>
              </button>
            </div>

            {loadingOrders ? (
              <div style={{ display: 'flex', justifyContent: 'center', padding: '20px' }}>
                <Loader2 size={24} className="animate-spin" color="var(--primary)" />
              </div>
            ) : orders.length === 0 ? (
              <div style={{ padding: '30px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                {lang === 'zh' ? '暂无相关的交易订单。' : 'No customer orders found.'}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                {orders.map((o) => {
                  const isSelected = selectedOrder?.orderId === o.orderId;

                  return (
                    <div key={`${o.buyer}_${o.orderId}`} style={{
                      background: 'rgba(255,255,255,0.01)',
                      border: '1px solid rgba(255,255,255,0.04)',
                      borderRadius: '12px',
                      padding: '16px',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '10px'
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                        <div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <span style={{ fontWeight: 700, background: 'rgba(245, 158, 11, 0.1)', color: 'var(--warning)', padding: '2px 8px', borderRadius: '4px', fontSize: '0.75rem' }}>
                              {o.platformName}
                            </span>
                            <span style={{ fontFamily: 'monospace', fontWeight: 600, fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                              ID: #{o.orderId.toString()}
                            </span>
                          </div>
                          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                            {lang === 'zh' ? '付款人钱包：' : 'Buyer: '}{o.buyer.slice(0, 10)}...{o.buyer.slice(-6)}
                          </div>
                        </div>
                        <div style={{ textAlign: 'right' }}>
                          <strong style={{ color: 'var(--text-primary)' }}>{parseFloat(formatUnits(o.amount, 18)).toFixed(2)} USDT</strong>
                          <div style={{ fontSize: '0.75rem', color: 'var(--warning)', marginTop: '4px', fontWeight: 600 }}>
                            {o.status === 0 ? (lang === 'zh' ? '等待买家付款证明' : 'Awaiting Buyer Proof') : (lang === 'zh' ? '等待商户付款证明' : 'Awaiting Merchant Settle')}
                          </div>
                        </div>
                      </div>

                      {o.status === 3 && o.assetType === 1 && !isSelected && (
                        <div style={{ display: 'flex', justifyContent: 'flex-end', borderTop: '1px solid rgba(255,255,255,0.03)', paddingTop: '10px' }}>
                          <button
                            onClick={() => {
                              setSelectedOrder(o);
                              setProvingStatus('idle');
                            }}
                            className="btn-primary"
                            style={{ padding: '4px 12px', fontSize: '0.75rem', borderRadius: '6px', margin: 0 }}
                          >
                            {lang === 'zh' ? '去网银付款清算' : 'Settle with Wise'}
                          </button>
                        </div>
                      )}

                      {/* Settle Wise Order (Fiat order type) */}
                      {isSelected && (
                        <div style={{
                          background: 'rgba(255,255,255,0.01)',
                          border: '1px solid rgba(99, 102, 241, 0.15)',
                          borderRadius: '8px',
                          padding: '12px',
                          marginTop: '8px',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '10px'
                        }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                              {lang === 'zh' ? '承兑商转账证明清算 (zkTLS)' : 'Merchant zkTLS Settlement'}
                            </span>
                            <button onClick={() => setSelectedOrder(null)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '0.8rem' }}>
                              {lang === 'zh' ? '取消' : 'Cancel'}
                            </button>
                          </div>

                          {provingStatus === 'idle' && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                              <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                                {lang === 'zh' ? '向买家网银账号付款后，点击下方按钮唤醒 zkTLS。系统将拉取 Wise/支付宝 出账流水并生成付款证明进行自动清算放款。' : 'Transfer fiat to the buyer\'s account, then click below to invoke zkTLS. We will fetch your Wise/Alipay payout statement to verify and settle.'}
                              </p>
                              <button onClick={() => handleMerchantSettleFiatOrder(o)} className="btn-primary" style={{ padding: '8px', fontSize: '0.8rem' }}>
                                {lang === 'zh' ? '真实 zkTLS 清算放款' : 'Verify & Settle with zkTLS'}
                              </button>
                            </div>
                          )}

                          {provingStatus === 'proving' && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', alignItems: 'center' }}>
                              <Loader2 size={20} className="animate-spin" color="var(--primary)" />
                              <span style={{ fontSize: '0.75rem' }}>{proveMessage}</span>
                            </div>
                          )}

                          {provingStatus === 'success' && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', alignItems: 'center', color: 'var(--success)', fontSize: '0.8rem' }}>
                              <CheckCircle size={24} />
                              <strong>{lang === 'zh' ? '清算放款成功！' : 'Escrow Settled!'}</strong>
                              <button onClick={() => { setSelectedOrder(null); fetchOrders(); }} className="btn-primary" style={{ padding: '4px 12px', fontSize: '0.75rem', marginTop: '4px' }}>
                                {lang === 'zh' ? '确定' : 'Confirm'}
                              </button>
                            </div>
                          )}

                          {provingStatus === 'error' && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', alignItems: 'center', color: '#ef4444', fontSize: '0.8rem' }}>
                              <AlertCircle size={24} color="#ef4444" />
                              <strong>{lang === 'zh' ? '证明放款失败' : 'Settlement Failed'}</strong>
                              <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', textAlign: 'center', margin: '4px 0 8px 0', lineHeight: 1.4 }}>
                                {renderErrorMessage(proveMessage)}
                              </span>
                              <button onClick={() => setProvingStatus('idle')} className="btn-primary" style={{ padding: '4px 12px', fontSize: '0.75rem' }}>
                                {lang === 'zh' ? '重试' : 'Retry'}
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

        </div>
      )}

      {/* Global Minimalist Toast */}
      {toastMessage && (
        <div style={{
          position: 'fixed',
          top: '24px',
          left: '50%',
          transform: 'translateX(-50%)',
          background: 'linear-gradient(135deg, rgba(24, 24, 37, 0.95) 0%, rgba(15, 15, 26, 0.98) 100%)',
          backdropFilter: 'blur(20px)',
          borderLeft: toastType === 'success' ? '4px solid #10b981' : '4px solid #f59e0b',
          borderTop: '1px solid rgba(255, 255, 255, 0.08)',
          borderRight: '1px solid rgba(255, 255, 255, 0.08)',
          borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
          color: '#ffffff',
          padding: '12px 20px',
          borderRadius: '12px',
          boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.3), 0 10px 10px -5px rgba(0, 0, 0, 0.3)',
          fontSize: '0.85rem',
          fontWeight: 600,
          zIndex: 9999,
          pointerEvents: 'none',
          animation: 'slideDownFadeIn 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
        }}>
          {toastType === 'success' ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
              <polyline points="22 4 12 14.01 9 11.01" />
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          )}
          <span style={{ letterSpacing: '0.01em', lineHeight: '1.4' }}>{toastMessage}</span>
        </div>
      )}
    </div>
  );
}

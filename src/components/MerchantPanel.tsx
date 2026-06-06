import { useState, useEffect, useCallback } from 'react';
import { Store, FileText, CheckCircle, Loader2, Plus, ShieldCheck, ChevronRight, Award } from 'lucide-react';
import { createWalletClient, custom, keccak256, stringToBytes, parseUnits, formatUnits } from 'viem';
import { C2C_ADMIN_ABI, C2C_ESCROW_ABI, C2C_BOND_VAULT_ABI, ERC20_ABI } from '../lib/contractAbi';

const getEthereum = () => typeof window !== 'undefined' ? (window as any).ethereum : undefined;

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
  USDT_ADDRESS,
  ESCROW_ADDRESS,
  ADMIN_ADDRESS,
  BOND_VAULT_ADDRESS,
  targetChain,
  publicClient
}: MerchantPanelProps) {
  const [isMerchant, setIsMerchant] = useState(false);
  const [loading, setLoading] = useState(true);
  const [claimableBond, setClaimableBond] = useState('0');
  const [isClaiming, setIsClaiming] = useState(false);

  // Register state
  const [registerStake, setRegisterStake] = useState('100');
  const [isRegistering, setIsRegistering] = useState(false);

  // Listed products
  const [products, setProducts] = useState<ProductDetail[]>([]);
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [expandedProduct, setExpandedProduct] = useState<string | null>(null);

  // Add Product State
  const [newAssetType, setNewAssetType] = useState<number>(0); // 0 Sell Crypto, 1 Sell Fiat
  const [newCryptoId, setNewCryptoId] = useState('0');
  const [newFiatId, setNewFiatId] = useState('0');
  const [newAmount, setNewAmount] = useState('1000');
  const [newPlatform, setNewPlatform] = useState<'wise' | 'alipay'>('wise');
  const [isListing, setIsListing] = useState(false);

  // Product management inline editing states
  const [editRate, setEditRate] = useState('');
  const [editOpenHour, setEditOpenHour] = useState('8');
  const [editCloseHour, setEditCloseHour] = useState('22');
  const [collateralDelta, setCollateralDelta] = useState('');

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
      return;
    }
    try {
      const active = await publicClient.readContract({
        address: ADMIN_ADDRESS,
        abi: C2C_ADMIN_ABI,
        functionName: 'isMerchantActive',
        args: [account]
      }) as boolean;
      setIsMerchant(active);

      const claimable = await publicClient.readContract({
        address: BOND_VAULT_ADDRESS,
        abi: C2C_BOND_VAULT_ABI,
        functionName: 'claimableBalance',
        args: [account, USDT_ADDRESS]
      }) as bigint;
      setClaimableBond(formatUnits(claimable, 18));
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

  const handleRegister = async () => {
    if (!account) return;
    setIsRegistering(true);
    try {
      const ethereum = getEthereum();
      if (!ethereum) throw new Error('MetaMask not detected');
      const walletClient = createWalletClient({
        account,
        chain: targetChain,
        transport: custom(ethereum)
      });

      // Approve bond vault
      const bondUnits = parseUnits(registerStake, 18);
      const approveTx = await (walletClient as any).writeContract({
        address: USDT_ADDRESS,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [BOND_VAULT_ADDRESS, bondUnits]
      });
      await publicClient.waitForTransactionReceipt({ hash: approveTx });

      // Merchant registration mock proof
      const dummyProof = {
        chainId: BigInt(targetChain.id),
        sessionId: 'merchant_reg_' + Date.now(),
        commitmentsHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
        orderBindingHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
        policyVersionHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
        verifierSignature: '0x0000000000000000000000000000000000000000000000000000000000000000',
        revealedItems: [],
        commitmentOpenings: [],
        commitments: [],
        serverName: 'Alipay'
      };

      const regTx = await (walletClient as any).writeContract({
        address: ADMIN_ADDRESS,
        abi: C2C_ADMIN_ABI,
        functionName: 'registerMerchant',
        args: [dummyProof]
      });

      await publicClient.waitForTransactionReceipt({ hash: regTx });
      alert(lang === 'zh' ? '商户资质已通过 zkTLS KYB 实名验证，入驻成功！' : 'Successfully registered as merchant with zkTLS KYB proof!');
      fetchMerchantStatus();
    } catch (e: any) {
      console.error(e);
      alert(e.message || e);
    } finally {
      setIsRegistering(false);
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
      alert(lang === 'zh' ? '成功赎回质押保证金！' : 'Successfully claimed bond collateral!');
      fetchMerchantStatus();
    } catch (e: any) {
      console.error(e);
      alert(e.message || e);
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
      alert(lang === 'zh' ? '新换汇交易商品发布上架成功！' : 'New product listed successfully!');
      fetchProducts();
      setNewAmount('1000');
    } catch (e: any) {
      console.error(e);
      alert(e.message || e);
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
      alert(e.message || e);
    }
  };

  const handleUpdateRate = async (p: ProductDetail) => {
    if (!account || !editRate) return;
    try {
      const ethereum = getEthereum();
      if (!ethereum) return;
      const walletClient = createWalletClient({
        account,
        chain: targetChain,
        transport: custom(ethereum)
      });

      const rateVal = BigInt(Math.round(parseFloat(editRate) * 1e8));
      const exp = BigInt(Math.floor(Date.now() / 1000) + 3600 * 24 * 7); // Valid for 7 days

      const hash = await (walletClient as any).writeContract({
        address: ADMIN_ADDRESS,
        abi: C2C_ADMIN_ABI,
        functionName: 'publishRate',
        args: [p.productId, p.assetType, rateVal, exp]
      });
      await publicClient.waitForTransactionReceipt({ hash });
      fetchProducts();
      setEditRate('');
    } catch (e: any) {
      console.error(e);
      alert(e.message || e);
    }
  };

  const handleUpdateHours = async (p: ProductDetail) => {
    if (!account) return;
    try {
      const ethereum = getEthereum();
      if (!ethereum) return;
      const walletClient = createWalletClient({
        account,
        chain: targetChain,
        transport: custom(ethereum)
      });

      const openSec = Number(editOpenHour) * 3600;
      const closeSec = Number(editCloseHour) * 3600;
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
      alert(e.message || e);
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
      alert(e.message || e);
    }
  };

  const handleAdjustCollateral = async (p: ProductDetail, add: boolean) => {
    if (!account || !collateralDelta) return;
    try {
      const ethereum = getEthereum();
      if (!ethereum) return;
      const walletClient = createWalletClient({
        account,
        chain: targetChain,
        transport: custom(ethereum)
      });

      const amountVal = parseUnits(collateralDelta, 18);

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
      setCollateralDelta('');
    } catch (e: any) {
      console.error(e);
      alert(e.message || e);
    }
  };

  // Merchant release escrow with proof for Fiat Orders
  const handleMerchantSettleFiatOrder = async (order: MerchantOrder, isMock: boolean) => {
    if (!account) return;
    setProvingStatus('proving');
    setErrorMsg('');
    setProveProgress(10);
    setProveMessage(lang === 'zh' ? '🔐 建立加密连接验证收款单据...' : '🔐 Connecting to wise API...');

    if (isMock) {
      try {
        await new Promise(r => setTimeout(r, 1200));
        setProveProgress(40);
        setProveMessage(lang === 'zh' ? '⚡ 正在提取 Wise 出账付款流水证明...' : '⚡ Grabbing Wise payout transfer slip...');
        await new Promise(r => setTimeout(r, 1500));
        setProveProgress(80);
        setProveMessage(lang === 'zh' ? '🛡️ 正在生成不可伪造的零知识证明...' : '🛡️ Compiling zero-knowledge proof...');
        await new Promise(r => setTimeout(r, 1200));
        setProveProgress(100);
        setProveMessage(lang === 'zh' ? '✅ 证明生成成功！正在清算释放代币...' : '✅ Settle proof verified! Settling escrow...');

        const ethereum = getEthereum();
        if (!ethereum) throw new Error('MetaMask not detected');
        const walletClient = createWalletClient({
          account,
          chain: targetChain,
          transport: custom(ethereum)
        });

        // Dummy proofs array
        const dummyProofs = [{
          chainId: BigInt(targetChain.id),
          sessionId: 'merchant_settle_' + Date.now(),
          commitmentsHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
          orderBindingHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
          policyVersionHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
          verifierSignature: '0x0000000000000000000000000000000000000000000000000000000000000000',
          revealedItems: [],
          commitmentOpenings: [],
          commitments: [],
          serverName: 'Wise'
        }];

        // Settle Fiat Order by merchant
        const hash = await (walletClient as any).writeContract({
          address: ESCROW_ADDRESS,
          abi: C2C_ESCROW_ABI,
          functionName: 'receiveCryptoWithPlatformPayment',
          args: [order.productId, order.orderId, dummyProofs]
        });

        await publicClient.waitForTransactionReceipt({ hash });
        setProvingStatus('success');
        fetchOrders();
      } catch (err: any) {
        console.error(err);
        setErrorMsg(err.message || 'Settle failed');
        setProvingStatus('error');
      }
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
          <Store size={48} color="var(--primary)" style={{ filter: 'drop-shadow(0 0 10px var(--primary-glow))' }} />
          <h2 style={{ margin: 0, fontSize: '1.5rem', fontWeight: 800 }}>
            {lang === 'zh' ? '承兑商入驻中心' : 'Merchant Terminal'}
          </h2>
          <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '0.9rem', maxWidth: '500px', lineHeight: '1.5' }}>
            {lang === 'zh'
              ? '成为平台承兑商以提供出金、入金双向兑换支持。您需要通过 zkTLS 证明完成企业或个人网银账户的 KYB 身份绑定，并存入基础保证金。'
              : 'Register as an exchange merchant on-chain. Post collateral stake and verify your banking identities via zkTLS KYB validator.'}
          </p>

          {account ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', width: '100%', maxWidth: '320px', marginTop: '10px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '4px', textAlign: 'left' }}>
                  {lang === 'zh' ? '质押基础保证金 (USDT)' : 'Staked Collateral (USDT)'}
                </label>
                <input
                  type="number"
                  value={registerStake}
                  onChange={(e) => setRegisterStake(e.target.value)}
                  className="input-field"
                  placeholder="100"
                />
              </div>
              <button
                onClick={handleRegister}
                disabled={isRegistering || !registerStake}
                className="btn-primary"
                style={{ width: '100%', padding: '10px', fontSize: '0.9rem' }}
              >
                {isRegistering ? (lang === 'zh' ? '验证注册中...' : 'Verifying...') : (lang === 'zh' ? '自愿质押入驻成为承兑商 (Mock)' : 'Verify & Register')}
              </button>
            </div>
          ) : (
            <button onClick={connectWallet} className="btn-primary" style={{ padding: '8px 16px', marginTop: '10px' }}>
              {lang === 'zh' ? '连接以太坊钱包以开始' : 'Connect Wallet to Start'}
            </button>
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
                  const isExpanded = expandedProduct === key;

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
                          setExpandedProduct(isExpanded ? null : key);
                          setEditRate(p.rate.toString());
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
                            background: p.isOpen ? 'var(--success)' : 'var(--text-muted)'
                          }} />
                          <span style={{ fontSize: '0.75rem', color: p.isOpen ? 'var(--success)' : 'var(--text-muted)' }}>
                            {p.isOpen ? (lang === 'zh' ? '营业中' : 'Open') : (lang === 'zh' ? '已休店' : 'Closed')}
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
                              {p.isActive ? (lang === 'zh' ? '下架' : 'Delist') : (lang === 'zh' ? '上架' : 'Activate')}
                            </button>
                          </div>
                        </div>
                      </div>

                      {/* Row Expanded panel */}
                      {isExpanded && (
                        <div style={{
                          padding: '16px',
                          borderTop: '1px solid rgba(255,255,255,0.03)',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '14px',
                          background: 'rgba(0,0,0,0.1)'
                        }}>
                          {/* Rates & manual open/close */}
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1rem' }}>
                            {/* Rate edit */}
                            <div>
                              <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '4px' }}>
                                {lang === 'zh' ? '编辑即期汇率' : 'Edit Exchange Rate'}
                              </label>
                              <div style={{ display: 'flex', gap: '8px' }}>
                                <input
                                  type="number"
                                  value={editRate}
                                  onChange={(e) => setEditRate(e.target.value)}
                                  className="input-field"
                                  style={{ padding: '6px 12px', fontSize: '0.85rem' }}
                                />
                                <button onClick={() => handleUpdateRate(p)} className="btn-primary" style={{ padding: '6px 14px', fontSize: '0.8rem' }}>
                                  {lang === 'zh' ? '修改' : 'Update'}
                                </button>
                              </div>
                            </div>

                            {/* Manual Override */}
                            <div>
                              <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '4px' }}>
                                {lang === 'zh' ? '手动开闭店控制' : 'Manual Open/Close'}
                              </label>
                              <div style={{ display: 'flex', gap: '8px' }}>
                                <button
                                  onClick={() => handleManualOpenClose(p, true)}
                                  className="btn-primary"
                                  style={{
                                    flex: 1,
                                    padding: '6px',
                                    fontSize: '0.8rem',
                                    background: 'rgba(16,185,129,0.15)',
                                    color: 'var(--success)',
                                    border: '1px solid rgba(16,185,129,0.2)'
                                  }}
                                >
                                  {lang === 'zh' ? '立即营业' : 'Open Now'}
                                </button>
                                <button
                                  onClick={() => handleManualOpenClose(p, false)}
                                  className="btn-primary"
                                  style={{
                                    flex: 1,
                                    padding: '6px',
                                    fontSize: '0.8rem',
                                    background: 'rgba(239,68,68,0.15)',
                                    color: 'var(--danger)',
                                    border: '1px solid rgba(239,68,68,0.2)'
                                  }}
                                >
                                  {lang === 'zh' ? '休市闭店' : 'Close Now'}
                                </button>
                              </div>
                            </div>
                          </div>

                          {/* Hours & Collateral delta */}
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1rem' }}>
                            {/* Business Hours */}
                            <div>
                              <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '4px' }}>
                                {lang === 'zh' ? '营业时间设置 (时)' : 'Business Hours (Hours)'}
                              </label>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                <input
                                  type="number"
                                  value={editOpenHour}
                                  onChange={(e) => setEditOpenHour(e.target.value)}
                                  className="input-field"
                                  style={{ padding: '6px', fontSize: '0.8rem', textAlign: 'center' }}
                                />
                                <span style={{ color: 'var(--text-muted)' }}>-</span>
                                <input
                                  type="number"
                                  value={editCloseHour}
                                  onChange={(e) => setEditCloseHour(e.target.value)}
                                  className="input-field"
                                  style={{ padding: '6px', fontSize: '0.8rem', textAlign: 'center' }}
                                />
                                <button onClick={() => handleUpdateHours(p)} className="btn-primary" style={{ padding: '6px 14px', fontSize: '0.8rem' }}>
                                  {lang === 'zh' ? '应用' : 'Apply'}
                                </button>
                              </div>
                            </div>

                            {/* Collateral adjust */}
                            <div>
                              <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '4px' }}>
                                {lang === 'zh' ? '增减保证金资金池' : 'Adjust Collateral Stake'}
                              </label>
                              <div style={{ display: 'flex', gap: '8px' }}>
                                <input
                                  type="number"
                                  value={collateralDelta}
                                  onChange={(e) => setCollateralDelta(e.target.value)}
                                  placeholder="e.g. 500"
                                  className="input-field"
                                  style={{ padding: '6px 12px', fontSize: '0.85rem' }}
                                />
                                <button onClick={() => handleAdjustCollateral(p, true)} className="btn-primary" style={{ padding: '6px 12px', fontSize: '0.8rem', background: 'rgba(16,185,129,0.2)', color: 'var(--success)' }}>
                                  +
                                </button>
                                <button onClick={() => handleAdjustCollateral(p, false)} className="btn-primary" style={{ padding: '6px 12px', fontSize: '0.8rem', background: 'rgba(239,68,68,0.2)', color: 'var(--danger)' }}>
                                  -
                                </button>
                              </div>
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
                                {lang === 'zh' ? '转账给买家后，点击“Mock 模拟演示”或使用 zkTLS 提取 Wise 账单进行自动合约清算。' : 'After transferring fiat to the buyer, click below to verify and settle.'}
                              </p>
                              <button onClick={() => handleMerchantSettleFiatOrder(o, true)} className="btn-primary" style={{ padding: '8px', fontSize: '0.8rem' }}>
                                {lang === 'zh' ? 'Mock 模拟演示清算' : 'Mock Settle'}
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

    </div>
  );
}

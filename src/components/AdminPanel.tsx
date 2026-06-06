import { useState, useEffect, useCallback } from 'react';
import { ShieldAlert, Loader2, ShieldCheck, Shield, Settings, Users, Ban } from 'lucide-react';
import { createWalletClient, custom, parseUnits, formatUnits } from 'viem';
import { C2C_ADMIN_ABI, C2C_RISK_MANAGER_ABI } from '../lib/contractAbi';

const getEthereum = () => typeof window !== 'undefined' ? (window as any).ethereum : undefined;

interface AdminPanelProps {
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

interface CryptoItem {
  id: bigint;
  tokenSymbol: string;
  tokenAddress: string;
  isActive: boolean;
}

interface FiatItem {
  id: bigint;
  fiatName: string;
  isActive: boolean;
}

export function AdminPanel({
  account,
  connectWallet,
  lang,
  ADMIN_ADDRESS,
  RISK_MANAGER_ADDRESS,
  targetChain,
  publicClient
}: AdminPanelProps) {
  const [isAdmin, setIsAdmin] = useState(false);
  const [checkingRole, setCheckingRole] = useState(true);

  // Asset Whitelists
  const [cryptos, setCryptos] = useState<CryptoItem[]>([]);
  const [fiats, setFiats] = useState<FiatItem[]>([]);
  const [loadingAssets, setLoadingAssets] = useState(false);

  // Add crypto form
  const [newCryptoAddr, setNewCryptoAddr] = useState('');
  const [isAddingCrypto, setIsAddingCrypto] = useState(false);

  // Add fiat form
  const [newFiatName, setNewFiatName] = useState('');
  const [isAddingFiat, setIsAddingFiat] = useState(false);

  // Merchant registry
  const [registerMerchantAddr, setRegisterMerchantAddr] = useState('');
  const [isRegisteringMerchant, setIsRegisteringMerchant] = useState(false);

  // Max order configuration
  const [maxOrderAmount, setMaxOrderAmount] = useState('0');
  const [editMaxOrder, setEditMaxOrder] = useState('');
  const [isUpdatingMaxOrder, setIsUpdatingMaxOrder] = useState(false);

  // User reputation adjuster
  const [targetUser, setTargetUser] = useState('');
  const [userReputation, setUserReputation] = useState<any>(null);
  const [isFetchingUser, setIsFetchingUser] = useState(false);
  const [isBlacklisting, setIsBlacklisting] = useState(false);
  const [isUnfreezing, setIsUnfreezing] = useState(false);

  // Risk config values
  const [minBond, setMinBond] = useState('1000');
  const [baseBond, setBaseBond] = useState('1500');
  const [maxBond, setMaxBond] = useState('3000');
  const [stepBond, setStepBond] = useState('500');
  const [freezeThreshold, setFreezeThreshold] = useState('3');
  const [isUpdatingRiskConfig, setIsUpdatingRiskConfig] = useState(false);

  const checkAdminRole = useCallback(async () => {
    if (!account) {
      setCheckingRole(false);
      return;
    }
    setCheckingRole(true);
    try {
      const contractAdmin = await publicClient.readContract({
        address: ADMIN_ADDRESS,
        abi: C2C_ADMIN_ABI,
        functionName: 'admin'
      }) as `0x${string}`;

      setIsAdmin(contractAdmin.toLowerCase() === account.toLowerCase());
    } catch (err) {
      console.error('Failed to query admin role:', err);
      setIsAdmin(false);
    } finally {
      setCheckingRole(false);
    }
  }, [account, ADMIN_ADDRESS, publicClient]);

  const loadAssetsAndStats = useCallback(async () => {
    if (!account || !isAdmin) return;
    setLoadingAssets(true);
    try {
      const cryptoList = await publicClient.readContract({
        address: ADMIN_ADDRESS,
        abi: C2C_ADMIN_ABI,
        functionName: 'getSupportCryptoList'
      }) as any[];

      const fiatList = await publicClient.readContract({
        address: ADMIN_ADDRESS,
        abi: C2C_ADMIN_ABI,
        functionName: 'getSupportFiatList'
      }) as any[];

      const maxLimit = await publicClient.readContract({
        address: ADMIN_ADDRESS,
        abi: C2C_ADMIN_ABI,
        functionName: 'maxOrderAmount'
      }) as bigint;

      setCryptos(cryptoList.map((c: any) => ({
        id: c.id,
        tokenSymbol: c.tokenSymbol,
        tokenAddress: c.tokenAddress,
        isActive: c.isActive
      })));

      setFiats(fiatList.map((f: any) => ({
        id: f.id,
        fiatName: f.fiatName,
        isActive: f.isActive
      })));

      setMaxOrderAmount(formatUnits(maxLimit, 18));
    } catch (err) {
      console.error('Failed to load asset details:', err);
    } finally {
      setLoadingAssets(false);
    }
  }, [account, isAdmin, ADMIN_ADDRESS, publicClient]);

  useEffect(() => {
    checkAdminRole();
  }, [account, checkAdminRole]);

  useEffect(() => {
    if (isAdmin) {
      loadAssetsAndStats();
    }
  }, [isAdmin, loadAssetsAndStats]);

  const handleAddCrypto = async () => {
    if (!account || !newCryptoAddr) return;
    setIsAddingCrypto(true);
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
        functionName: 'addCryptoInfo',
        args: [newCryptoAddr as `0x${string}`, true]
      });

      await publicClient.waitForTransactionReceipt({ hash });
      alert(lang === 'zh' ? '成功将代币添加至白名单！' : 'Token successfully added to whitelist!');
      setNewCryptoAddr('');
      loadAssetsAndStats();
    } catch (e: any) {
      console.error(e);
      alert(e.message || e);
    } finally {
      setIsAddingCrypto(false);
    }
  };

  const handleAddFiat = async () => {
    if (!account || !newFiatName) return;
    setIsAddingFiat(true);
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
        functionName: 'addFiatInfo',
        args: [newFiatName, true]
      });

      await publicClient.waitForTransactionReceipt({ hash });
      alert(lang === 'zh' ? '成功将法币添加至白名单！' : 'Fiat currency successfully added to whitelist!');
      setNewFiatName('');
      loadAssetsAndStats();
    } catch (e: any) {
      console.error(e);
      alert(e.message || e);
    } finally {
      setIsAddingFiat(false);
    }
  };

  const handleToggleAsset = async (id: bigint, isCrypto: boolean, active: boolean) => {
    if (!account) return;
    try {
      const ethereum = getEthereum();
      if (!ethereum) return;
      const walletClient = createWalletClient({
        account,
        chain: targetChain,
        transport: custom(ethereum)
      });

      const functionName = active ? 'activateAsset' : 'deactivateAsset';
      const assetType = isCrypto ? 0 : 1;

      const hash = await (walletClient as any).writeContract({
        address: ADMIN_ADDRESS,
        abi: C2C_ADMIN_ABI,
        functionName,
        args: [id, assetType]
      });

      await publicClient.waitForTransactionReceipt({ hash });
      loadAssetsAndStats();
    } catch (e: any) {
      console.error(e);
      alert(e.message || e);
    }
  };

  const handleRegisterMerchant = async () => {
    if (!account || !registerMerchantAddr) return;
    setIsRegisteringMerchant(true);
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
        functionName: 'registerMerchantByAdmin',
        args: [registerMerchantAddr as `0x${string}`]
      });

      await publicClient.waitForTransactionReceipt({ hash });
      alert(lang === 'zh' ? '承兑商手动验证及录入成功！' : 'Merchant manual registration successful!');
      setRegisterMerchantAddr('');
    } catch (e: any) {
      console.error(e);
      alert(e.message || e);
    } finally {
      setIsRegisteringMerchant(false);
    }
  };

  const handleUpdateMaxOrder = async () => {
    if (!account || !editMaxOrder) return;
    setIsUpdatingMaxOrder(true);
    try {
      const ethereum = getEthereum();
      if (!ethereum) return;
      const walletClient = createWalletClient({
        account,
        chain: targetChain,
        transport: custom(ethereum)
      });

      const limitUnits = parseUnits(editMaxOrder, 18);
      const hash = await (walletClient as any).writeContract({
        address: ADMIN_ADDRESS,
        abi: C2C_ADMIN_ABI,
        functionName: 'setMaxOrderAmount',
        args: [limitUnits]
      });

      await publicClient.waitForTransactionReceipt({ hash });
      alert(lang === 'zh' ? '全局交易限额参数修改成功！' : 'Max order limit updated successfully!');
      setEditMaxOrder('');
      loadAssetsAndStats();
    } catch (e: any) {
      console.error(e);
      alert(e.message || e);
    } finally {
      setIsUpdatingMaxOrder(false);
    }
  };

  const handleFetchUser = async () => {
    if (!targetUser) return;
    setIsFetchingUser(true);
    setUserReputation(null);
    try {
      const rep = await publicClient.readContract({
        address: RISK_MANAGER_ADDRESS,
        abi: C2C_RISK_MANAGER_ABI,
        functionName: 'getReputation',
        args: [targetUser as `0x${string}`]
      }) as any;

      setUserReputation({
        completedCount: Number(rep.completedCount ?? rep[0]),
        timeoutCount: Number(rep.timeoutCount ?? rep[1]),
        riskLevel: Number(rep.riskLevel ?? rep[4]),
        temporarilyFrozen: Boolean(rep.temporarilyFrozen ?? rep[5]),
        blacklisted: Boolean(rep.blacklisted ?? rep[6]),
      });
    } catch (err) {
      console.error(err);
      alert(lang === 'zh' ? '查询失败，请检查输入地址是否合法！' : 'Query failed, check address format!');
    } finally {
      setIsFetchingUser(false);
    }
  };

  const handleToggleBlacklist = async (value: boolean) => {
    if (!account || !targetUser) return;
    setIsBlacklisting(true);
    try {
      const ethereum = getEthereum();
      if (!ethereum) return;
      const walletClient = createWalletClient({
        account,
        chain: targetChain,
        transport: custom(ethereum)
      });

      const hash = await (walletClient as any).writeContract({
        address: RISK_MANAGER_ADDRESS,
        abi: C2C_RISK_MANAGER_ABI,
        functionName: 'setBlacklist',
        args: [targetUser as `0x${string}`, value]
      });

      await publicClient.waitForTransactionReceipt({ hash });
      alert(lang === 'zh' ? '黑名单设置更改成功！' : 'Blacklist status updated!');
      handleFetchUser();
    } catch (e: any) {
      console.error(e);
      alert(e.message || e);
    } finally {
      setIsBlacklisting(false);
    }
  };

  const handleUnfreeze = async () => {
    if (!account || !targetUser) return;
    setIsUnfreezing(true);
    try {
      const ethereum = getEthereum();
      if (!ethereum) return;
      const walletClient = createWalletClient({
        account,
        chain: targetChain,
        transport: custom(ethereum)
      });

      const hash = await (walletClient as any).writeContract({
        address: RISK_MANAGER_ADDRESS,
        abi: C2C_RISK_MANAGER_ABI,
        functionName: 'manualUnfreeze',
        args: [targetUser as `0x${string}`]
      });

      await publicClient.waitForTransactionReceipt({ hash });
      alert(lang === 'zh' ? '解冻成功！该用户已恢复常规信用级别。' : 'User manual unfreeze successful!');
      handleFetchUser();
    } catch (e: any) {
      console.error(e);
      alert(e.message || e);
    } finally {
      setIsUnfreezing(false);
    }
  };

  const handleUpdateRiskConfig = async () => {
    if (!account) return;
    setIsUpdatingRiskConfig(true);
    try {
      const ethereum = getEthereum();
      if (!ethereum) return;
      const walletClient = createWalletClient({
        account,
        chain: targetChain,
        transport: custom(ethereum)
      });

      const hash = await (walletClient as any).writeContract({
        address: RISK_MANAGER_ADDRESS,
        abi: C2C_RISK_MANAGER_ABI,
        functionName: 'setRiskConfig',
        args: [
          Number(minBond),
          Number(baseBond),
          Number(maxBond),
          Number(stepBond),
          10, // resetThreshold
          Number(freezeThreshold),
          100, // rewardCompletedThreshold
          30 // decayIntervalDays
        ]
      });

      await publicClient.waitForTransactionReceipt({ hash });
      alert(lang === 'zh' ? '全局风控与保证参数修改成功！' : 'Risk configs successfully updated!');
    } catch (e: any) {
      console.error(e);
      alert(e.message || e);
    } finally {
      setIsUpdatingRiskConfig(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', width: '100%' }}>
      
      {/* 0. Verify access role */}
      {checkingRole && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '40px' }}>
          <Loader2 size={32} className="animate-spin" color="var(--primary)" />
        </div>
      )}

      {!checkingRole && !isAdmin && (
        <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '1rem', padding: '40px', alignItems: 'center', textAlign: 'center' }}>
          <ShieldAlert size={48} color="var(--danger)" />
          <h2 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 800, color: 'var(--danger)' }}>
            {lang === 'zh' ? '拒绝访问 - 超级管理员专属' : 'Access Denied - Admins Only'}
          </h2>
          <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '0.85rem', maxWidth: '450px' }}>
            {lang === 'zh'
              ? '当前连接的以太坊钱包并不是该 C2C 智能合约底层的超级管理员账户。请切换至平台管理员部署者 EOA 后重试。'
              : 'Your current EOA wallet is not the owner of the platform smart contracts. Switch to the deployer admin to check settings.'}
          </p>
          {!account && (
            <button onClick={connectWallet} className="btn-primary" style={{ padding: '8px 16px', marginTop: '10px' }}>
              {lang === 'zh' ? '连接管理员钱包' : 'Connect Wallet'}
            </button>
          )}
        </div>
      )}

      {/* 1. Admin dashboard tabs and assets whitelist */}
      {!checkingRole && isAdmin && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          
          {/* Header Stats card */}
          <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1.5rem' }}>
            <div className="glass-card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{lang === 'zh' ? '全局单笔交易限额' : 'Max Order Limit'}</span>
                <div style={{ fontSize: '1.25rem', fontWeight: 800, color: 'var(--text-primary)', marginTop: '4px' }}>
                  {Number(maxOrderAmount).toFixed(2)} USDT
                </div>
              </div>
              <Settings size={36} color="var(--primary)" style={{ opacity: 0.15 }} />
            </div>

            <div className="glass-card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{lang === 'zh' ? '白名单代币/法币' : 'Supported Assets'}</span>
                <div style={{ fontSize: '1.25rem', fontWeight: 800, color: 'var(--text-primary)', marginTop: '4px' }}>
                  {cryptos.length} Cryptos / {fiats.length} Fiats
                </div>
              </div>
              <ShieldCheck size={36} color="var(--success)" style={{ opacity: 0.15 }} />
            </div>
          </section>

          {/* Whitelist configuration */}
          <section className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div style={{ background: 'rgba(99, 102, 241, 0.1)', color: 'var(--primary)', padding: '6px', borderRadius: '8px' }}>
                <Shield size={18} />
              </div>
              <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 700 }}>
                {lang === 'zh' ? '代币白名单与法币支持列表' : 'Asset Whitelist Management'}
              </h3>
            </div>

            {loadingAssets ? (
              <div style={{ display: 'flex', justifyContent: 'center', padding: '20px' }}>
                <Loader2 size={24} className="animate-spin" color="var(--primary)" />
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '1.5rem' }}>
                
                {/* Cryptos whitelist table */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  <strong style={{ fontSize: '0.85rem' }}>{lang === 'zh' ? '已支持的加密资产白名单' : 'Supported Cryptos'}</strong>
                  {cryptos.map((c) => (
                    <div key={c.id.toString()} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(255,255,255,0.01)', border: '1px solid rgba(255,255,255,0.03)', padding: '8px 12px', borderRadius: '8px' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                        <span style={{ fontWeight: 700, fontSize: '0.85rem' }}>{c.tokenSymbol}</span>
                        <span style={{ fontFamily: 'monospace', fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                          {c.tokenAddress.slice(0, 10)}...{c.tokenAddress.slice(-6)}
                        </span>
                      </div>
                      <button
                        onClick={() => handleToggleAsset(c.id, true, !c.isActive)}
                        className="btn-primary"
                        style={{
                          padding: '3px 8px',
                          fontSize: '0.7rem',
                          borderRadius: '4px',
                          background: c.isActive ? 'rgba(239,68,68,0.1)' : 'rgba(16,185,129,0.1)',
                          border: c.isActive ? '1px solid rgba(239,68,68,0.2)' : '1px solid rgba(16,185,129,0.2)',
                          color: c.isActive ? 'var(--danger)' : 'var(--success)'
                        }}
                      >
                        {c.isActive ? (lang === 'zh' ? '禁用' : 'Disable') : (lang === 'zh' ? '启用' : 'Enable')}
                      </button>
                    </div>
                  ))}

                  {/* Add crypto form */}
                  <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
                    <input
                      type="text"
                      placeholder={lang === 'zh' ? 'ERC20 代币地址 (0x...)' : 'ERC20 Address (0x...)'}
                      value={newCryptoAddr}
                      onChange={(e) => setNewCryptoAddr(e.target.value)}
                      className="input-field"
                      style={{ fontSize: '0.8rem', padding: '6px 12px' }}
                    />
                    <button onClick={handleAddCrypto} disabled={isAddingCrypto} className="btn-primary" style={{ padding: '6px 12px', fontSize: '0.8rem' }}>
                      {isAddingCrypto ? '...' : (lang === 'zh' ? '新增' : 'Add')}
                    </button>
                  </div>
                </div>

                {/* Fiats whitelist table */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  <strong style={{ fontSize: '0.85rem' }}>{lang === 'zh' ? '已支持的法币支持通道' : 'Supported Fiats'}</strong>
                  {fiats.map((f) => (
                    <div key={f.id.toString()} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(255,255,255,0.01)', border: '1px solid rgba(255,255,255,0.03)', padding: '8px 12px', borderRadius: '8px' }}>
                      <span style={{ fontWeight: 700, fontSize: '0.85rem' }}>{f.fiatName}</span>
                      <button
                        onClick={() => handleToggleAsset(f.id, false, !f.isActive)}
                        className="btn-primary"
                        style={{
                          padding: '3px 8px',
                          fontSize: '0.7rem',
                          borderRadius: '4px',
                          background: f.isActive ? 'rgba(239,68,68,0.1)' : 'rgba(16,185,129,0.1)',
                          border: f.isActive ? '1px solid rgba(239,68,68,0.2)' : '1px solid rgba(16,185,129,0.2)',
                          color: f.isActive ? 'var(--danger)' : 'var(--success)'
                        }}
                      >
                        {f.isActive ? (lang === 'zh' ? '禁用' : 'Disable') : (lang === 'zh' ? '启用' : 'Enable')}
                      </button>
                    </div>
                  ))}

                  {/* Add fiat form */}
                  <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
                    <input
                      type="text"
                      placeholder={lang === 'zh' ? '法币简称（如: CNY, USD）' : 'Fiat Name (e.g. CNY, USD)'}
                      value={newFiatName}
                      onChange={(e) => setNewFiatName(e.target.value)}
                      className="input-field"
                      style={{ fontSize: '0.8rem', padding: '6px 12px' }}
                    />
                    <button onClick={handleAddFiat} disabled={isAddingFiat} className="btn-primary" style={{ padding: '6px 12px', fontSize: '0.8rem' }}>
                      {isAddingFiat ? '...' : (lang === 'zh' ? '新增' : 'Add')}
                    </button>
                  </div>
                </div>

              </div>
            )}
          </section>

          {/* Limit Editor & Merchant Registry */}
          <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '1.5rem' }}>
            
            {/* Limit Config */}
            <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <div style={{ background: 'rgba(99, 102, 241, 0.1)', color: 'var(--primary)', padding: '6px', borderRadius: '8px' }}>
                  <Settings size={18} />
                </div>
                <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 700 }}>
                  {lang === 'zh' ? '全局单笔交易上限配置' : 'Max Order Configuration'}
                </h3>
              </div>
              <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                {lang === 'zh' ? '设置用户在平台单笔 C2C 极速兑换或订单质押所能申请的最大 USDT 额度限制。' : 'Configure the maximum allowed USDT volume for a single exchange escrow order.'}
              </p>
              <div style={{ display: 'flex', gap: '8px', marginTop: '10px' }}>
                <input
                  type="number"
                  placeholder={maxOrderAmount}
                  value={editMaxOrder}
                  onChange={(e) => setEditMaxOrder(e.target.value)}
                  className="input-field"
                  style={{ fontSize: '0.85rem' }}
                />
                <button onClick={handleUpdateMaxOrder} disabled={isUpdatingMaxOrder} className="btn-primary" style={{ padding: '8px 16px', fontSize: '0.85rem' }}>
                  {isUpdatingMaxOrder ? '...' : (lang === 'zh' ? '更新' : 'Update')}
                </button>
              </div>
            </div>

            {/* Merchant manual registrar */}
            <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <div style={{ background: 'rgba(99, 102, 241, 0.1)', color: 'var(--primary)', padding: '6px', borderRadius: '8px' }}>
                  <Users size={18} />
                </div>
                <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 700 }}>
                  {lang === 'zh' ? '承兑商地址手工录入审核' : 'Verify Merchant Directly'}
                </h3>
              </div>
              <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                {lang === 'zh' ? '在测试或免除验证的特殊情况下，管理员可单向跳过 zkTLS KYB，直接将承兑商注册进合约。' : 'Manually register a merchant address directly onto the contract, bypassing the zkTLS KYB flow.'}
              </p>
              <div style={{ display: 'flex', gap: '8px', marginTop: '10px' }}>
                <input
                  type="text"
                  placeholder="Merchant Address (0x...)"
                  value={registerMerchantAddr}
                  onChange={(e) => setRegisterMerchantAddr(e.target.value)}
                  className="input-field"
                  style={{ fontSize: '0.85rem' }}
                />
                <button onClick={handleRegisterMerchant} disabled={isRegisteringMerchant} className="btn-primary" style={{ padding: '8px 16px', fontSize: '0.85rem' }}>
                  {isRegisteringMerchant ? '...' : (lang === 'zh' ? '确认录入' : 'Register')}
                </button>
              </div>
            </div>

          </section>

          {/* User credit & blacklist details */}
          <section className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div style={{ background: 'rgba(239, 68, 68, 0.1)', color: 'var(--danger)', padding: '6px', borderRadius: '8px' }}>
                <Ban size={18} />
              </div>
              <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 700 }}>
                {lang === 'zh' ? '用户信用及恶意拉黑管理' : 'User Reputation & Risk Adjuster'}
              </h3>
            </div>
            <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-muted)', lineHeight: '1.4' }}>
              {lang === 'zh'
                ? '输入用户钱包地址进行信用详情检索。对于发生超时恶意拒付或争议违约的用户，可随时冻结其账号、手动解冻或直接列入交易黑名单。'
                : 'Lookup user wallets to audit trade statistics. Manually blacklist misbehaving accounts or resolve freeze statuses.'}
            </p>

            <div style={{ display: 'flex', gap: '8px', width: '100%', maxWidth: '500px' }}>
              <input
                type="text"
                placeholder="User EOA Address (0x...)"
                value={targetUser}
                onChange={(e) => setTargetUser(e.target.value)}
                className="input-field"
                style={{ fontSize: '0.85rem' }}
              />
              <button onClick={handleFetchUser} disabled={isFetchingUser || !targetUser} className="btn-primary" style={{ padding: '8px 16px' }}>
                {isFetchingUser ? '...' : (lang === 'zh' ? '查询' : 'Lookup')}
              </button>
            </div>

            {userReputation && (
              <div style={{
                background: 'rgba(255,255,255,0.01)',
                border: '1px solid rgba(255,255,255,0.04)',
                borderRadius: '12px',
                padding: '16px',
                display: 'flex',
                flexDirection: 'column',
                gap: '12px',
                fontSize: '0.85rem'
              }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '1rem' }}>
                  <div>
                    <span style={{ color: 'var(--text-muted)' }}>{lang === 'zh' ? '完成交易数' : 'Completed trades'}</span>
                    <div style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--success)' }}>{userReputation.completedCount}</div>
                  </div>
                  <div>
                    <span style={{ color: 'var(--text-muted)' }}>{lang === 'zh' ? '超时拒付数' : 'Timeout count'}</span>
                    <div style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--danger)' }}>{userReputation.timeoutCount}</div>
                  </div>
                  <div>
                    <span style={{ color: 'var(--text-muted)' }}>{lang === 'zh' ? '风险信用分' : 'Risk Rating'}</span>
                    <div style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--warning)' }}>{userReputation.riskLevel}</div>
                  </div>
                  <div>
                    <span style={{ color: 'var(--text-muted)' }}>{lang === 'zh' ? '当前状态' : 'Status'}</span>
                    <div style={{ fontSize: '1.1rem', fontWeight: 700, color: userReputation.blacklisted || userReputation.temporarilyFrozen ? 'var(--danger)' : 'var(--success)' }}>
                      {userReputation.blacklisted ? (lang === 'zh' ? '黑名单' : 'Blacklisted') : userReputation.temporarilyFrozen ? (lang === 'zh' ? '已冻结' : 'Frozen') : (lang === 'zh' ? '信用良好' : 'Healthy')}
                    </div>
                  </div>
                </div>

                <div style={{ display: 'flex', gap: '10px', borderTop: '1px solid rgba(255,255,255,0.03)', paddingTop: '12px', justifyContent: 'flex-end' }}>
                  {userReputation.blacklisted ? (
                    <button onClick={() => handleToggleBlacklist(false)} disabled={isBlacklisting} className="btn-primary" style={{ padding: '6px 12px', fontSize: '0.8rem', background: 'rgba(16,185,129,0.15)', color: 'var(--success)', border: '1px solid rgba(16,185,129,0.2)' }}>
                      {isBlacklisting ? '...' : (lang === 'zh' ? '移除黑名单' : 'Unblacklist')}
                    </button>
                  ) : (
                    <button onClick={() => handleToggleBlacklist(true)} disabled={isBlacklisting} className="btn-primary" style={{ padding: '6px 12px', fontSize: '0.8rem', background: 'rgba(239,68,68,0.15)', color: 'var(--danger)', border: '1px solid rgba(239,68,68,0.2)' }}>
                      {isBlacklisting ? '...' : (lang === 'zh' ? '拉入黑名单' : 'Blacklist User')}
                    </button>
                  )}
                  {userReputation.temporarilyFrozen && (
                    <button onClick={handleUnfreeze} disabled={isUnfreezing} className="btn-primary" style={{ padding: '6px 12px', fontSize: '0.8rem', background: 'rgba(16,185,129,0.15)', color: 'var(--success)', border: '1px solid rgba(16,185,129,0.2)' }}>
                      {isUnfreezing ? '...' : (lang === 'zh' ? '手动清零并解冻' : 'Manual Unfreeze')}
                    </button>
                  )}
                </div>
              </div>
            )}
          </section>

          {/* Risk manager settings */}
          <section className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div style={{ background: 'rgba(99, 102, 241, 0.1)', color: 'var(--primary)', padding: '6px', borderRadius: '8px' }}>
                <Settings size={18} />
              </div>
              <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 700 }}>
                {lang === 'zh' ? '全局风控保证金等级公式调节' : 'Risk & Collateral Param Formulas'}
              </h3>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem' }}>
              <div>
                <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '4px' }}>
                  {lang === 'zh' ? '最低保证金比例 (Bps)' : 'Min Bond (Bps)'}
                </label>
                <input type="number" value={minBond} onChange={(e) => setMinBond(e.target.value)} className="input-field" style={{ height: '40px' }} />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '4px' }}>
                  {lang === 'zh' ? '基准保证金比例 (Bps)' : 'Base Bond (Bps)'}
                </label>
                <input type="number" value={baseBond} onChange={(e) => setBaseBond(e.target.value)} className="input-field" style={{ height: '40px' }} />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '4px' }}>
                  {lang === 'zh' ? '最高惩罚保证金 (Bps)' : 'Max Bond (Bps)'}
                </label>
                <input type="number" value={maxBond} onChange={(e) => setMaxBond(e.target.value)} className="input-field" style={{ height: '40px' }} />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '4px' }}>
                  {lang === 'zh' ? '违规滑退步长 (Bps)' : 'Step Bps'}
                </label>
                <input type="number" value={stepBond} onChange={(e) => setStepBond(e.target.value)} className="input-field" style={{ height: '40px' }} />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '4px' }}>
                  {lang === 'zh' ? '连错冻结阀值' : 'Freeze Timeout count'}
                </label>
                <input type="number" value={freezeThreshold} onChange={(e) => setFreezeThreshold(e.target.value)} className="input-field" style={{ height: '40px' }} />
              </div>
            </div>

            <button
              onClick={handleUpdateRiskConfig}
              disabled={isUpdatingRiskConfig}
              className="btn-primary"
              style={{ width: '100%', padding: '10px', fontSize: '0.9rem', marginTop: '10px' }}
            >
              {isUpdatingRiskConfig ? 'Updating...' : (lang === 'zh' ? '保存风控计算公式配置' : 'Save Config Formula')}
            </button>
          </section>

        </div>
      )}

    </div>
  );
}

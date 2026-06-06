# C2C 平台智能合约体系结构文档

> 版本：V4（Bond + Penalty + Reputation）  
> 适用范围：系统架构分析、业务流程说明、论文图表参考

---

## 目录

1. [系统概述](#1-系统概述)
2. [合约部署拓扑](#2-合约部署拓扑)
3. [合约职责总览](#3-合约职责总览)
4. [核心数据结构](#4-核心数据结构)
5. [订单状态机](#5-订单状态机)
6. [业务流程：CRYPTO 订单](#6-业务流程crypto-订单)
7. [业务流程：FIAT 订单](#7-业务流程fiat-订单)
8. [V4 保证金与惩罚机制](#8-v4-保证金与惩罚机制)
9. [风险等级与声誉模型](#9-风险等级与声誉模型)
10. [TLSNotary 证明验证流程](#10-tlsnotary-证明验证流程)
11. [汇率编码与法币换算](#11-汇率编码与法币换算)
12. [合约间调用权限矩阵](#12-合约间调用权限矩阵)
13. [关键安全设计](#13-关键安全设计)

---

## 1. 系统概述

本系统是一个**去中心化点对点（C2C）加密货币交易平台**，以 TLSNotary（TLSN）零知识 Web 证明作为链下支付凭证，在以太坊智能合约层完成链上资金结算。

**核心创新点：**
- 无需信任中心化撮合方，TLSN 证明直接在链上被智能合约核验
- 引入声誉-保证金联动机制（V4），对恶意超时者施加渐进式经济惩罚
- 支持 CRYPTO（买方售加密货币收法币）和 FIAT（商家用法币买加密货币）两种交易方向
- 平台验证器可插拔注册，无需升级核心合约即可接入新支付渠道

---

## 2. 合约部署拓扑

```
┌─────────────────────────────────────────────────────────────────┐
│                        部署者 / Admin                            │
└──────────────────────────────┬──────────────────────────────────┘
                               │ deploy & configure
          ┌────────────────────┼──────────────────────────┐
          ▼                    ▼                          ▼
  ┌──────────────┐    ┌───────────────┐         ┌─────────────────┐
  │ TLSNVerifier │    │   C2CAdmin    │         │  C2CRiskManager │
  │  (核心验证)   │◄───│ (平台配置中心) │         │  (声誉/风险引擎) │
  └──────┬───────┘    └───────┬───────┘         └────────┬────────┘
         │                   │                           │
         │                   │ ref                       │ onlyEscrow
         │            ┌──────▼───────────────────────────▼────────┐
         │            │               C2CEscrow                    │
         └───────────►│   (产品上架 + 订单生命周期 + 资金流转)       │
                      └──────────────────────┬──────────────────────┘
                                             │ onlyEscrow
                                    ┌────────▼─────────┐
                                    │   C2CBondVault    │
                                    │  (保证金托管/结算) │
                                    └──────────────────┘

  ┌─────────────────────────────────┐
  │  Platform Verifier Registry     │
  │  TLSNVerifier.platformVerifiers │
  │  ┌───────────────────────────┐  │
  │  │ AlipayPlatformVerifier    │  │
  │  ├───────────────────────────┤  │
  │  │ WisePlatformVerifier      │  │
  │  └───────────────────────────┘  │
  └─────────────────────────────────┘
```

**三角绑定（Triangle Binding）：**

```
  C2CEscrow.setManagers(riskManager, bondVault)
  C2CRiskManager.setEscrow(escrow)
  C2CBondVault.setEscrow(escrow)
```

三个合约互相持有对方引用，且通过 `onlyEscrow` 修饰符确保只有 Escrow 合约可以触发状态变更。

---

## 3. 合约职责总览

| 合约 | 职责 | 关键存储 |
|------|------|---------|
| **TLSNVerifier** | ① TLSN 证明完整性验证（签名、chainId、sessionId）<br>② 平台验证器注册表（platformId → address）<br>③ KYB 证明验证（商家资质） | `trustedVerifiers`, `usedSessionIds`, `platformVerifiers` |
| **C2CAdmin** | ① 支持资产列表（Crypto / Fiat）<br>② 商家注册与 KYB 状态<br>③ 商家汇率 + 营业时间管理<br>④ 平台级参数（maxOrderAmount） | `supportCryptoList`, `merchantRates`, `businessHours` |
| **C2CEscrow** | ① 产品上架（CRYPTO / FIAT 两类）<br>② 订单全生命周期（下单→证明→完成/超时）<br>③ 资金在 collateral / buyer escrow / bondVault 间流转 | `merchantsProductCrypto`, `merchantsProductFiat`, `hasActiveOrder` |
| **C2CRiskManager** | ① 用户声誉评分（riskLevel 0–10）<br>② 保证金比率计算（requiredBondBps）<br>③ 黑名单 / 临时冻结管理 | `reps[address]`, 参数: `minBondBps`, `baseBondBps`, ... |
| **C2CBondVault** | ① 订单保证金锁定（createOrderBond）<br>② 结算到可提余额（settle）<br>③ Pull-model 提款（claim） | `orderBonds[bytes32]`, `_claimable[user][token]` |
| **AlipayPlatformVerifier** | 解析支付宝支付证明（orderId、金额、状态、时间戳） | `usedAlipayOrderIds` |
| **WisePlatformVerifier** | 解析 Wise 转账证明（transferId、金额、收款方） | `usedWiseTransferIds` |

---

## 4. 核心数据结构

### 4.1 Order（订单）

```solidity
struct Order {
    address buyer;           // 买家地址
    uint256 amount;          // 交易金额（token 原始单位）
    uint256 rate;            // 汇率快照（编码见 §11）
    uint32  rateVersion;     // 汇率版本（防汇率滑点攻击）
    uint256 deadline;        // 截止时间（block.timestamp + 15 分钟）
    OrderStatus status;      // PENDING / EXPIRED / COMPLETED / WAITING
    bytes32 merchantNameHash;// keccak256(商家真实姓名)
    bytes32 merchantIdHash;  // keccak256(商家平台账号)
    bytes32 platformTxId;    // 支付平台交易哈希（成功后写入）
    uint256 bondAmount;      // 本订单锁定的保证金数量
    uint16  bondBpsSnapshot; // 下单时的保证金比率快照（bps）
}
```

### 4.2 Product（产品）

```solidity
struct Product {
    uint256 productID;
    uint256 cryptoID;            // 对应 C2CAdmin.supportCryptoList 的 id
    uint256 fiatID;              // 对应 C2CAdmin.supportFiatList 的 id
    AssetType assetType;         // CRYPTO=0, FIAT=1
    bytes32 platformId;          // keccak256(平台名称)，如 keccak256("alipay")
    uint256 collateralAmount;    // 商家总质押量
    uint256 pendingAmount;       // 已被订单锁定的量
    uint256 buyerEscrowedAmount; // 买家托管金额（FIAT 产品）
    bool    isActive;
    uint256 nextOrderId;
    uint256 activeOrderCount;
    UintQueue.Queue pendingOrderIds; // 待清算订单 ID 队列
    mapping(uint256 => Order) orders;
}
```

### 4.3 Reputation（声誉）

```solidity
struct Reputation {
    uint32 completedCount;           // 累计完成笔数
    uint32 timeoutCount;             // 累计超时次数
    uint8  consecutiveTimeouts;      // 当前连续超时次数
    uint8  completedSinceLastTimeout;// 上次超时后的完成笔数
    uint8  riskLevel;                // 当前风险等级 (0–10)
    bool   temporarilyFrozen;        // 是否临时冻结
    bool   blacklisted;              // 是否黑名单
    uint64 frozenUntil;              // 冻结截止时间戳
    uint64 lastTimeoutAt;            // 上次超时时间戳（用于衰减计算）
}
```

### 4.4 OrderBondState（保证金状态）

```solidity
struct OrderBondState {
    address token;       // 保证金代币合约地址
    address prover;      // 需要提交证明的一方（CRYPTO=buyer, FIAT=merchant）
    address counterpart; // 对手方（CRYPTO=merchant, FIAT=buyer）
    uint256 bond;        // 保证金金额
    bool    initialized;
    bool    settled;
}
```

---

## 5. 订单状态机

```
                        placeOrder()
                     ┌──────────────┐
                     │              │
                     ▼              │
    ┌─────────────────────────────────────┐
    │  PENDING (0)  ← CRYPTO 订单初始状态 │
    │  WAITING (3)  ← FIAT  订单初始状态  │
    └───────┬──────────────┬──────────────┘
            │              │
            │              │  block.timestamp > deadline
            │              ▼
            │       ┌─────────────┐
            │       │ EXPIRED (1) │  超时：保证金归对手方
            │       └─────────────┘
            │
            │  payOrderByPlatform()         [CRYPTO]
            │  receiveCryptoWithPlatformPayment() [FIAT]
            ▼
     ┌──────────────┐
     │ COMPLETED (2)│  成功：保证金退回 prover，声誉 onCompleted()
     └──────────────┘
```

**注：** V4 删除了 CANCELLED 和 DISPUTED 状态，`cancelOrder()` 调用直接 revert。

---

## 6. 业务流程：CRYPTO 订单

> 场景：商家（merchant）持有 USDT，买家（buyer）需要支付法币换取 USDT。  
> 商家是加密货币卖方，买家需在 15 分钟内通过 Wise/Alipay 转账给商家。

```
Buyer                    C2CEscrow               BondVault           RiskManager
  │                          │                      │                     │
  │  1. approve(escrow, amt) │                      │                     │
  │─────────────────────────►│                      │                     │
  │                          │                      │                     │
  │  2. approve(bondVault,   │                      │                     │
  │     bondAmount)          │                      │                     │
  │─────────────────────────►│                      │                     │
  │                          │                      │                     │
  │  3. placeOrder(merchant, │                      │                     │
  │     productId, CRYPTO,   │                      │                     │
  │     amount, buyerInfo)   │                      │                     │
  │─────────────────────────►│                      │                     │
  │                          │  requiredBondBps(m)  │                     │
  │                          │────────────────────────────────────────────►
  │                          │  requiredBondBps(b)  │                     │
  │                          │────────────────────────────────────────────►
  │                          │  transferFrom(buyer→bondVault, bond)       │
  │                          │──────────────────────►│                    │
  │                          │  createOrderBond(key, token, buyer,        │
  │                          │    merchant, bond)   │                     │
  │                          │──────────────────────►│                    │
  │                          │                      │                     │
  │  ← OrderPlaced, status=PENDING, deadline=now+15min                    │
  │                          │                      │                     │
  │  [在 15 分钟内完成 Wise/Alipay 转账]            │                     │
  │                          │                      │                     │
  │  4. payOrderByPlatform(  │                      │                     │
  │     merchant, productId, │                      │                     │
  │     orderId, [proofs])   │                      │                     │
  │─────────────────────────►│                      │                     │
  │                          │  verifyAndDelegate() │                     │
  │                          │  (TLSNVerifier)      │                     │
  │                          │                      │                     │
  │                          │  transfer(buyer,amt) │  settle(SUCCESS)    │
  │  ←────────────────────── │──────────────────────►│                    │
  │  receive USDT            │                      │  _credit(buyer,bond)│
  │                          │                      │                     │
  │                          │  onCompleted(buyer) ─────────────────────►│
  │                          │                      │                     │
  │  ← OrderStatusChanged: COMPLETED                │                     │

  ── 超时路径（buyer 未在 15 分钟内提交证明）──
  
  [任意人调用 cleanupProductExpired 或下一次 placeOrder 触发 _cleanupExpired]
  
  C2CEscrow.settle(key, PROOF_TIMEOUT)
  → bondVault._credit(merchant, bond)   // 商家可提取买家保证金
  → riskManager.onTimeout(buyer)        // buyer 风险等级上升
```

---

## 7. 业务流程：FIAT 订单

> 场景：商家（merchant）需要支付法币换取买家持有的加密货币（如买家卖出 USDT 收人民币）。  
> 商家是法币支付方，需在 15 分钟内通过 Alipay 转账给买家。

```
Buyer                    C2CEscrow               BondVault           Merchant
  │                          │                      │                   │
  │  1. approve(escrow, amt) │                      │                   │
  │─────────────────────────►│                      │                   │
  │                          │                      │                   │
  │  2. placeOrder(merchant, │                      │                   │
  │     productId, FIAT,     │                      │                   │
  │     amount, buyerInfo)   │                      │                   │
  │─────────────────────────►│                      │                   │
  │                          │ 从商家 collateral 扣除 bond              │
  │                          │ transferFrom(buyer→escrow, amount)       │
  │                          │──────────────────────►│                  │
  │                          │  createOrderBond(key, token,             │
  │                          │    merchant, buyer, bond)                │
  │                          │──────────────────────►│                  │
  │  ← status=WAITING, deadline=now+15min            │                  │
  │                          │                      │                   │
  │  [等待商家提交证明]        │                      │                   │
  │                          │                      │                   │
  │                          │  3. receiveCryptoWith│PlatformPayment(   │
  │                          │     productId, order │Id, [proofs])      │
  │                          │◄─────────────────────────────────────────│
  │                          │  verifyAndDelegate() │                   │
  │                          │                      │                   │
  │                          │  transfer(merchant, amount)              │
  │                          │─────────────────────────────────────────►│
  │                          │  settle(SUCCESS, stake, 0)               │
  │                          │──────────────────────►│                  │
  │                          │                      │  _credit(merchant,│
  │                          │                      │    bond+stake)    │
  │                          │  onCompleted(merchant)                   │
  │  ← COMPLETED             │                      │                   │

  ── 超时路径（merchant 未在 15 分钟内提交证明）──
  
  _cleanupExpired:
  → bondVault.settle(key, PROOF_TIMEOUT, stake, buyerAmount)
    → _credit(buyer,   bond + buyerAmount)  // 买家拿回本金+保证金
    → _credit(merchant, stake)              // 商家拿回未锁定质押
  → riskManager.onTimeout(merchant)        // 商家风险等级上升
```

---

## 8. V4 保证金与惩罚机制

### 8.1 保证金计算公式

设用户当前有效风险等级为 $L_{eff}$，系统参数为 $b_{min}$、$b_{base}$、$b_{max}$、$b_{step}$（单位：bps，1 bps = 0.01%），则：

$$
b_{raw}(L_{eff}) = b_{base} + L_{eff} \cdot b_{step}
$$

$$
b_{req}(user) = \begin{cases}
  b_{min} & \text{if } L_{eff}=0 \text{ and } N_{completed} \geq T_{reward} \\
  \min(b_{raw},\ b_{max}) & \text{otherwise}
\end{cases}
$$

其中 $N_{completed}$ 为用户历史完成笔数，$T_{reward}$ 为 `rewardCompletedThreshold`。

**订单保证金金额：**

$$
bond = \left\lfloor \frac{amount \times b_{req}}{10000} \right\rfloor
$$

其中 `amount` 为订单加密货币金额（token 原始单位）。

### 8.2 两种订单的保证金归属

| 订单类型 | Prover（需提交证明方） | Counterpart（受益方） | 成功归属 | 超时归属 |
|---------|---------------------|---------------------|---------|---------|
| **CRYPTO** | Buyer（买家） | Merchant（商家） | bond → Buyer | bond → Merchant |
| **FIAT** | Merchant（商家） | Buyer（买家） | bond → Merchant | bond → Buyer |

### 8.3 FIAT 订单资金流详图

设质押总量 $C$，订单金额 $A$，保证金 $G = \lfloor A \cdot b_{req}/10000 \rfloor$，可动用余额 $S = A - G$：

```
下单时：
  Escrow.collateral  C → C - G       (bond 划入 BondVault)
  Escrow.pendingAmt  P → P + S       (本金净锁定 = A - G)
  Escrow.buyerEscrow B → B + A       (买家托管金额)

成功时：
  Escrow → Merchant: A               (全额本金)
  BondVault → Merchant 可提: G + S   (bond 退回 + 本金余额)

超时时：
  BondVault → Buyer 可提: G + A      (bond 补偿 + 全额本金退款)
  BondVault → Merchant 可提: S       (未锁定质押退回)
```

### 8.4 orderKey 唯一标识

$$
\text{orderKey} = \text{keccak256}(\text{escrow} \| \text{chainId} \| \text{merchant} \| \text{productId} \| \text{assetType} \| \text{orderId})
$$

---

## 9. 风险等级与声誉模型

### 9.1 风险等级状态转移

```
                   onTimeout()              onTimeout()             onTimeout()
riskLevel=0 ─────────────────► riskLevel=1 ──────────► riskLevel=2 ──► ... ─► riskLevel=10
                (+1)                        (+1~+3)                               (上限)
     ▲                                                                              │
     │              onCompleted()                                                   │
     └──────────── (riskLevel -= 1) ◄────────────────────────────────────────────┘
```

**超时惩罚加速（连续超时）：**

$$
\Delta_{risk}(ct) = \begin{cases}
  1 & \text{if } ct < 2 \\
  2 & \text{if } ct = 2 \\
  3 & \text{if } ct \geq 3
\end{cases}
$$

其中 $ct$ = `consecutiveTimeouts`（当前连续超时次数）。

### 9.2 时间衰减（Decay）

若距上次超时已过 $d$ 天，衰减步数为：

$$
\Delta_{decay} = \left\lfloor \frac{d}{T_{decay}} \right\rfloor
$$

$$
L_{eff} = \max(0,\ L_{stored} - \Delta_{decay})
$$

其中 $T_{decay}$ = `decayIntervalDays`（默认 90 天）。  
**含义：** 如果用户保持良好行为足够长时间，风险等级会自然归零，保证金比率恢复到基础值。

### 9.3 冻结触发条件

满足以下任一条件，账户被临时冻结 $T_{freeze}$ 天：

$$
N_{timeout} \geq T_{freeze} \quad \text{OR} \quad L_{stored} \geq L_{max}
$$

其中 $N_{timeout}$ = `timeoutCount`（累计超时次数），$T_{freeze}$ = `freezeThreshold`，$L_{max}$ = `maxRiskLevel`（默认 10）。

### 9.4 声誉评分对保证金比率的影响（示例）

以默认参数 $b_{base}=10\%$，$b_{step}=3\%$，$b_{max}=100\%$ 为例：

| 风险等级 $L$ | 保证金比率 | 对应行为 |
|------------|---------|---------|
| 0 | 10.00% | 无超时记录，正常用户 |
| 1 | 13.00% | 1 次超时 |
| 2 | 16.00% | 连续 2 次超时 |
| 3 | 19.00% | 连续 3 次超时 |
| 10 | 100.00% | 达上限，触发临时冻结 |

---

## 10. TLSNotary 证明验证流程

### 10.1 验证层次

```
TLSProof
  │
  ├── 层1：协议完整性（TLSNVerifier）
  │     ├── chainId 校验（防跨链重放）
  │     ├── sessionId 去重（防重放攻击）
  │     ├── commitmentsHash 校验（防篡改）
  │     └── verifierSignature ECDSA 验签（防伪造）
  │
  ├── 层2：订单绑定（C2CEscrow）
  │     └── orderBindingHash 校验
  │           = keccak256(escrow ‖ chainId ‖ merchant ‖ buyer ‖
  │                       productId ‖ orderId ‖ assetType ‖ amount ‖
  │                       rate ‖ rateVersion ‖ deadline ‖
  │                       merchantNameHash ‖ merchantIdHash ‖
  │                       payeeNameHash ‖ payeeIdHash)
  │
  └── 层3：业务规则（Platform Verifier）
        ├── AlipayPlatformVerifier
        │     ├── status == "SUCCESS"
        │     ├── bizType == "TRANSFER"
        │     ├── payAmount 金额核验（法币金额 ≥ 订单应付）
        │     ├── payeeName / payeeLoginEmail 匹配商家
        │     ├── gmtSuccess 在 [deadline-15min, deadline] 窗口内
        │     └── orderId 去重（防重放）
        │
        └── WisePlatformVerifier
              ├── 联系人证明（contacts proof）
              │     └── 核验商家账号存在于联系人列表
              └── 转账证明（transfer proof）
                    ├── transferId 去重
                    ├── 金额核验
                    └── 收款方匹配
```

### 10.2 orderBindingHash 的防攻击作用

$$
H_{binding} = \text{keccak256}\big(\underbrace{\text{escrow} \| \text{chainId}}_{\text{合约绑定}} \| \underbrace{\text{merchant} \| \text{buyer}}_{\text{双方绑定}} \| \underbrace{\text{amount} \| \text{rate} \| \text{deadline}}_{\text{金额绑定}}\big)
$$

TLSN 证明中必须包含与链上计算完全一致的 `orderBindingHash`，使得证明与特定订单不可分离，从根本上阻止：
- **证明复用攻击**：将同一 TLSN 证明提交给不同订单
- **金额替换攻击**：篡改订单金额后提交同一证明
- **跨账户攻击**：将 A 的证明用于 B 的订单

---

## 11. 汇率编码与法币换算

### 11.1 汇率编码规范

汇率 `rate` 以整数编码，精度为 $10^8$：

$$
\text{rate} = \text{fiat\_price\_per\_whole\_token} \times 10^8
$$

**示例：** 1 USDT = 4.70 MYR → `rate = 470_000_000`

### 11.2 法币金额换算（链上验证用）

设代币精度为 $d$（如 USDT: $d=18$），链上计算买家应付法币金额（×1000 精度以保持整数运算）：

$$
F_{\times 1000} = \left\lfloor \frac{A \times 1000 \times \text{rate}}{10^{d+8}} \right\rfloor
$$

其中 $A$ 为订单加密货币金额（原始单位）。

**具体展开（USDT, d=18）：**

$$
F_{\times 1000} = \left\lfloor \frac{A \times 1000 \times \text{rate}}{10^{26}} \right\rfloor
$$

与支付证明中的实际法币金额进行比较时：

$$
F_{proof\_\times 1000} \geq F_{\times 1000}
$$

**示例：** 买 100 USDT（$A = 100 \times 10^{18}$），rate = 470_000_000（4.70 MYR），  
$F_{\times 1000} = 4700$，即实际需支付 ≥ 4.700 MYR。

---

## 12. 合约间调用权限矩阵

| 调用方 → 被调用方 | TLSNVerifier | C2CAdmin | C2CEscrow | C2CRiskManager | C2CBondVault |
|----------------|:-----------:|:--------:|:---------:|:--------------:|:-----------:|
| **Admin EOA** | ✅ 所有管理操作 | ✅ 所有管理操作 | `setManagers`, `pause` | `setRiskConfig`, `setBlacklist` | `setEscrow` |
| **Merchant EOA** | — | `publishRate`, `setBusinessHours` | `listCryptoProduct`, `receiveCrypto...` | — | — |
| **Buyer EOA** | — | — | `placeOrder`, `payOrderByPlatform` | — | `claim(token)` |
| **C2CEscrow** | `verifyAndDelegate` | `isMerchantOpen`, `getMerchantRate`, `incrementSellCount` | — | `onCompleted`, `onTimeout`, `requiredBondBps` | `createOrderBond`, `settle` |
| **C2CAdmin** | `verifyKYB` | — | — | — | — |
| **TLSNVerifier** | — | — | — | — | — |
| **Platform Verifier** | — | — | — | — | — |

---

## 13. 关键安全设计

### 13.1 重放攻击防护

| 层级 | 防护机制 |
|------|---------|
| TLSN 层 | `usedSessionIds[sessionId] = true`，全局唯一 |
| Alipay 层 | `usedAlipayOrderIds[keccak256(orderId)] = true` |
| Wise 层 | `usedWiseTransferIds[keccak256(transferId)] = true` |
| 订单绑定 | `orderBindingHash` 将 TLSN 证明与具体订单绑定 |

### 13.2 资金安全

- **Pull 模式提款**：`C2CBondVault` 从不主动推送资金，受益方调用 `claim(token)` 自行提取，避免重入攻击
- **SafeERC20**：所有 ERC-20 转账使用 OpenZeppelin `SafeERC20.safeTransfer/safeTransferFrom`
- **可用量校验**：`available = collateral - pending`，下单前强制检查防止超发

### 13.3 速率与规模限制

```
MAX_PENDING_ORDERS  = 200   // 单产品最大并发挂单
ORDER_TIMEOUT       = 15 分钟
maxOrderAmount      = 1000 USDT（可调）
maxRiskLevel        = 10
maxBondBps          ≤ 10000 = 100%
```

### 13.4 管理权限两步转移

C2CAdmin、TLSNVerifier 均采用 propose-accept 两步 admin 转移，防止因地址输入错误导致永久失去管理权。

### 13.5 合约暂停机制

`C2CEscrow` 支持 `pause()` / `unpause()`，在发现严重漏洞时可立即停止新订单创建，已有订单通过超时自然结算。

### 13.6 Escrow 迁移安全

`C2CRiskManager` 和 `C2CBondVault` 均实现 `proposeMigrateEscrow` / `acceptMigrateEscrow` 两步迁移，保证合约升级时新旧 Escrow 衔接安全。

---

## 附录 A：合约部署顺序

```
1. deploy TLSNVerifier()
2. deploy C2CAdmin(tlsnVerifier.address)
3. deploy AlipayPlatformVerifier(tlsnVerifier.address)
4. deploy WisePlatformVerifier(tlsnVerifier.address)
5. tlsnVerifier.setPlatformVerifier(PLATFORM_ALIPAY, alipay.address)
6. tlsnVerifier.setPlatformVerifier(PLATFORM_WISE, wise.address)
7. deploy C2CRiskManager(c2cAdmin.address)
8. deploy C2CBondVault(c2cAdmin.address)
9. deploy C2CEscrow(c2cAdmin.address, tlsnVerifier.address)
10. c2cAdmin.setAuthorizedCaller(c2cEscrow.address, true)
11. c2cEscrow.setManagers(riskManager.address, bondVault.address)
12. riskManager.setEscrow(c2cEscrow.address)
13. bondVault.setEscrow(c2cEscrow.address)
14. tlsnVerifier.setAuthorizedCaller(c2cAdmin.address, true)
15. c2cAdmin.addCryptoInfo(usdtAddress, true)
16. c2cAdmin.addFiatInfo("MYR", true)
17. ...
```

## 附录 B：关键事件列表

| 事件 | 合约 | 触发时机 |
|------|------|---------|
| `OrderPlaced` | C2CEscrow | 买家成功下单 |
| `OrderStatusChanged` | C2CEscrow | 状态变更（PENDING→COMPLETED/EXPIRED 等） |
| `OrderBondCreated` | C2CBondVault | 保证金锁定 |
| `OrderBondSettled` | C2CBondVault | 保证金结算（成功或超时） |
| `ClaimableIncreased` | C2CBondVault | 某账户可提余额增加 |
| `Claimed` | C2CBondVault | 用户成功提取保证金 |
| `ReputationUpdated` | C2CRiskManager | 声誉评分变更 |
| `FreezeUpdated` | C2CRiskManager | 账户冻结/解冻 |
| `BlacklistUpdated` | C2CRiskManager | 黑名单变更 |
| `PlatformPaymentVerified` | TLSNVerifier | 平台支付证明核验通过 |
| `ProductListed` | C2CEscrow | 商家上架新产品 |
| `RatePublished` | C2CAdmin | 商家发布汇率 |

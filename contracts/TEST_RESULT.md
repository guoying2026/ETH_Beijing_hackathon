# 智能合约测试结果

> 测试日期：2026-05-27  
> 测试网络：`hardhatMainnet`（Hardhat 模拟 L1 主网环境）  
> Solidity 版本：`0.8.28`（EVM 目标：cancun）  
> 测试总结：**324 个测试用例 100% 通过，0 失败** ✅  
> Node:test runner 报告 **331 passing**（= 324 业务用例 + 7 个 helper 模块文件各计 1 个"模块加载通过"）  
> 命令：`npx hardhat test` 或 `npm run test`（两者等价，均触发全量 12 个测试文件）

---

## 总体概览

| 测试套件                    | 测试数  | 通过    | 失败 |
|-----------------------------|-------:|-------:|-----:|
| C2CAdmin                    |     60 |     60 |    0 |
| C2CEscrow (V4)              |     62 |     62 |    0 |
| WisePlatform 验证器         |     34 |     34 |    0 |
| AlipayPlatform 验证器       |     37 |     37 |    0 |
| 集成测试 (V4)               |     17 |     17 |    0 |
| TLSN 验证器                 |     30 |     30 |    0 |
| 汇率快照                    |      9 |      9 |    0 |
| 单笔限额                    |      6 |      6 |    0 |
| 营业时间                    |     14 |     14 |    0 |
| Bond 双边公平机制 (V4)      |     22 |     22 |    0 |
| 过期订单清理                |     11 |     11 |    0 |
| Sweep 公开清理 (V4)         |     22 |     22 |    0 |
| **合计**                    | **324** | **324** | **0** |

---

## C2CAdmin — 60/60 ✅

### FLOW — 正常流程

| 编号          | 测试内容                                              | 通过 | 总时间(ms) | 验证时间(ms) | Gas 消耗       |
|---------------|-------------------------------------------------------|:----:|-----------:|------------:|---------------:|
| ADM-FLOW-01   | proposeAdmin→acceptAdmin 管理员两步移交成功                 | ✅   |          6 |           3 |         27,676 |
| ADM-FLOW-02   | addCryptoInfo 事件正确 + 计数加一                          | ✅   |          2 |           2 |        105,810 |
| ADM-FLOW-03   | addFiatInfo 事件正确 + 计数加一                            | ✅   |          3 |           1 |         99,801 |
| ADM-FLOW-04   | deactivateAsset→activateAsset 状态正确切换                 | ✅   |          4 |           2 |         34,216 |
| ADM-FLOW-05   | 管理员直接注册商家，KYB=true                                 | ✅   |          2 |           1 |         74,966 |
| ADM-FLOW-06   | 商家通过 KYB 证明自助注册，触发 MerchantRegistered 事件          | ✅   |         12 |          10 |        142,236 |
| ADM-FLOW-07   | setMerchantPaymentInfoForPlatform(WISE) isSet=true   | ✅   |          4 |           1 |        101,698 |
| ADM-FLOW-07A  | 商家可分别设置 Wise/Alipay 支付信息且互不干扰                    | ✅   |          5 |           1 |        101,710 |
| ADM-FLOW-07B  | 更新单平台支付信息不影响其他平台                                  | ✅   |          7 |           2 |         47,598 |
| ADM-FLOW-07C  | 未设置平台读取 isSet=false                                 | ✅   |          4 |           1 |        101,698 |
| ADM-FLOW-08   | setMerchantFiatAccount 法币账户字符串正确保存                  | ✅   |          4 |           2 |         49,701 |
| ADM-FLOW-09   | 首次 publishRate，version=1，publishedAt>0               | ✅   |          3 |           1 |         72,239 |
| ADM-FLOW-10   | 二次 publishRate，version 单调递增                          | ✅   |          4 |           1 |         38,039 |
| ADM-FLOW-11   | setBusinessHours open/close/daymask 写入正确              | ✅   |          4 |           2 |         49,973 |
| ADM-FLOW-12   | openNow/closeNow/clearManualOverride 覆盖生效            | ✅   |          7 |           2 |         26,483 |
| ADM-FLOW-13   | setMaxOrderAmount 新限额立即生效                            | ✅   |          2 |           2 |         30,117 |
| ADM-FLOW-14   | setAuthorizedCaller 授权映射正确更新                         | ✅   |          3 |           1 |         46,528 |
| ADM-FLOW-15   | 被授权合约调用 incrementSellCount，CRYPTO/FIAT 计数独立          | ✅   |          6 |           3 |        200,513 |

### ERR — 错误拦截

| 编号           | 测试内容                                                    | 通过 | 总时间(ms) |
|----------------|-------------------------------------------------------------|:----:|-----------:|
| ADM-ERR-01     | 非管理员调用 proposeAdmin → OnlyAdmin                          | ✅   |        691 |
| ADM-ERR-02     | 非 pendingAdmin 调用 acceptAdmin → NotPendingAdmin            | ✅   |         11 |
| ADM-ERR-03     | proposeAdmin(零地址) → ZeroAddress                           | ✅   |          4 |
| ADM-ERR-04     | 非管理员 addCryptoInfo → OnlyAdmin                            | ✅   |          3 |
| ADM-ERR-05     | 非管理员 addFiatInfo → OnlyAdmin                              | ✅   |          3 |
| ADM-ERR-06     | 重复激活资产 → AlreadyActive                                   | ✅   |          3 |
| ADM-ERR-07     | 重复下架资产 → AlreadyInactive                                  | ✅   |         86 |
| ADM-ERR-08     | activateAsset ID 越界 → WrongId                              | ✅   |          2 |
| ADM-ERR-09     | 非商家 publishRate → NotMerchant                              | ✅   |          2 |
| ADM-ERR-10     | 发布 expiresAt≤now 的汇率 → RateExpired                       | ✅   |          2 |
| ADM-ERR-11     | 非商家 setBusinessHours → NotMerchant                        | ✅   |          1 |
| ADM-ERR-12     | 非商家 openNow/closeNow → NotMerchant                        | ✅   |          3 |
| ADM-ERR-13     | 非管理员 setMaxOrderAmount → OnlyAdmin                        | ✅   |          2 |
| ADM-ERR-14     | 未授权调用 incrementSellCount → NotAuthorizedCaller            | ✅   |          2 |
| ADM-ERR-15     | 非商家 setMerchantFiatAccount → NotMerchant                   | ✅   |          2 |
| ADM-ERR-16     | setMerchantFiatAccount 空字符串 → EmptyAccount                | ✅   |          2 |
| ADM-ERR-17     | 非商家 setMerchantPaymentInfoForPlatform → NotMerchant        | ✅   |          2 |
| ADM-ERR-18     | nameHash=0 → EmptyPaymentInfo                               | ✅   |          3 |
| ADM-ERR-18A    | 未注册平台设置支付信息 → PlatformNotRegistered                     | ✅   |         13 |
| ADM-ERR-19     | 重复注册商家 → AlreadyRegistered                                | ✅   |          2 |
| ADM-ERR-20     | KYB proof 链 ID 错误 → WrongChainId                          | ✅   |          4 |
| ADM-ERR-21     | KYB 同 sessionId 重放 → SessionAlreadyUsed                   | ✅   |         15 |
| ADM-ERR-22     | KYB proof 伪造签名 → UntrustedVerifier                        | ✅   |          6 |
| ADM-ERR-23     | KYB server 未被信任 → NotTrustedKYBServer                     | ✅   |          6 |
| ADM-ERR-24     | KYB 状态非 verified → KYCNotVerified                         | ✅   |          7 |

### ATTACK — 攻击防御

| 编号        | 测试内容                                                    | 通过 | 总时间(ms) |
|-------------|-------------------------------------------------------------|:----:|-----------:|
| ADM-ATT-01  | 非 pending 抢先 acceptAdmin → NotPendingAdmin               | ✅   |         15 |
| ADM-ATT-02  | 攻击者用自有私钥伪造 KYB proof → UntrustedVerifier              | ✅   |          6 |
| ADM-ATT-03  | 复用旧 sessionId 重放 KYB proof → SessionAlreadyUsed         | ✅   |         10 |
| ADM-ATT-04  | 篡改 commitmentsHash → CommitmentsHashMismatch             | ✅   |          3 |
| ADM-ATT-05  | 篡改 blinderHex → CommitmentOpeningMismatch                | ✅   |          3 |
| ADM-ATT-06  | 非管理员 setAuthorizedCaller → OnlyAdmin                     | ✅   |          2 |
| ADM-ATT-07  | 非管理员 setMaxOrderAmount → OnlyAdmin                       | ✅   |          2 |
| ADM-ATT-08  | 未注册地址伪造商家身份 publishRate → NotMerchant                 | ✅   |          2 |

### TAMPER — 流程篡改

| 编号            | 测试内容                                                    | 通过 | 总时间(ms) | Gas 消耗       |
|-----------------|-------------------------------------------------------------|:----:|-----------:|---------------:|
| ADM-TAMPER-01   | 商家频繁改汇率，version 严格单调递增不回退                           | ✅   |         15 |         38,039 |
| ADM-TAMPER-02   | 短 expiresAt 汇率：时间窗口内有效，快进后过期拦截                      | ✅   |          5 |             —  |
| ADM-TAMPER-03   | openNow→closeNow，最新 manualOverride 生效                   | ✅   |          3 |         31,522 |
| ADM-TAMPER-04   | closeNow→clearManualOverride，回落到时间表                    | ✅   |          4 |         26,495 |
| ADM-TAMPER-05   | openNow 后 setBusinessHours 不覆盖 manualOverride            | ✅   |          4 |         32,885 |
| ADM-TAMPER-06   | isMerchantOpen 按 productId 维度隔离                          | ✅   |          4 |             —  |
| ADM-TAMPER-07   | 管理员中途调低限额，仅影响新订单                                     | ✅   |          3 |             —  |
| ADM-TAMPER-08   | ⚠️ assetType=2 发布汇率当前无守卫（风险用例）                       | ✅   |          1 |         72,251 |
| ADM-TAMPER-09   | ⚠️ rate=0 发布汇率当前无守卫（风险用例）                            | ✅   |          2 |         33,215 |

---

## C2CEscrow (V4) — 62/62 ✅

### FLOW — 正常流程

| 编号           | 测试内容                                                                   | 通过 | 总时间(ms) |
|----------------|----------------------------------------------------------------------------|:----:|-----------:|
| ESC-FLOW-01    | listCryptoProduct — 商家上架 CRYPTO 产品                                       | ✅   |         88 |
| ESC-FLOW-02    | listFiatProduct — 商家上架 FIAT 产品                                           | ✅   |         68 |
| ESC-FLOW-03    | placeOrder CRYPTO — 状态为 PENDING，collateral 锁定                            | ✅   |         88 |
| ESC-FLOW-04    | placeOrder FIAT — 状态为 WAITING，买家资产托管                                    | ✅   |         90 |
| ESC-FLOW-05    | payOrderByPlatform (Wise CRYPTO) — 订单完成，crypto 释放                       | ✅   |        147 |
| ESC-FLOW-06    | payOrderByPlatform (Alipay CRYPTO) — 订单完成                                 | ✅   |        129 |
| ESC-FLOW-07    | receiveCryptoWithPlatformPayment (Wise FIAT) — 订单完成                       | ✅   |        654 |
| ESC-FLOW-08    | CRYPTO 订单超时 — 状态 EXPIRED，保证金转至商家                                     | ✅   |         93 |
| ESC-FLOW-09    | FIAT 订单超时 — 状态 EXPIRED，买家可通过 BondVault claim 本金+保证金               | ✅   |         90 |
| ESC-FLOW-10    | addAmount / takeAmount — collateral 资金管理                                   | ✅   |         88 |
| ESC-FLOW-11    | activeProduct / inactiveProduct — 产品上下架切换                                | ✅   |         86 |
| ESC-FLOW-12    | 不同买家同时下单，各自独立                                                         | ✅   |         78 |
| ESC-FLOW-13    | cleanupProductExpired 移除过期 PENDING 订单                                    | ✅   |         92 |
| ESC-FLOW-14    | V4 cancelOrder → revert OrderCancellationDisabled                          | ✅   |         86 |

### ERR — 错误拦截

| 编号          | 测试内容                                                                   | 通过 | 总时间(ms) |
|---------------|----------------------------------------------------------------------------|:----:|-----------:|
| ESC-ERR-01    | 产品未激活时下单 → ProductInactive                                              | ✅   |         89 |
| ESC-ERR-02    | 商家营业时间外下单 → MerchantClosed                                             | ✅   |         81 |
| ESC-ERR-03    | 金额为零下单 → ZeroAmount                                                     | ✅   |         77 |
| ESC-ERR-04    | CRYPTO 下单超出 collateral → InsufficientAvailable                           | ✅   |         84 |
| ESC-ERR-05    | FIAT 下单缺少买家支付信息 → BuyerPaymentInfoRequired                             | ✅   |         85 |
| ESC-ERR-06    | 同一买家重复下单 → AlreadyHasActiveOrder                                        | ✅   |         82 |
| ESC-ERR-07    | 汇率未发布时下单 → RateNotPublished                                             | ✅   |         55 |
| ESC-ERR-08    | payOrderByPlatform 超截止时间 → OutOfDeadline                                 | ✅   |         90 |
| ESC-ERR-09    | receiveCryptoWithPlatformPayment 超截止时间 → OutOfDeadline                   | ✅   |         95 |
| ESC-ERR-10    | 非买家调用 payOrderByPlatform → NotAllowed                                    | ✅   |         96 |
| ESC-ERR-11    | 非商家调用 receiveCryptoWithPlatformPayment → 订单不存在                         | ✅   |         90 |
| ESC-ERR-12    | 错误 assetType 下单 → WrongId 或 ProductInactive                             | ✅   |        944 |
| ESC-ERR-13    | takeAmount 超出可用额度 → InsufficientPendingLocked                            | ✅   |         74 |
| ESC-ERR-14    | payOrderByPlatform 订单不存在 → OrderNotFound                                 | ✅   |         87 |
| ESC-ERR-15    | 非管理员 setManagers → OnlyAdmin                                              | ✅   |         88 |
| ESC-ERR-16    | 下单金额超 USD 上限 → ExceedsUsdCap                                            | ✅   |         83 |
| ESC-ERR-17    | FIAT 订单金额超过 collateral → InsufficientAvailable                           | ✅   |         83 |
| ESC-ERR-18    | 未设置 Managers 时下单 → ManagersNotSet                                        | ✅   |         53 |
| ESC-ERR-19    | 对已完成订单重复 payOrderByPlatform → NotPending                                | ✅   |        136 |
| ESC-ERR-20    | 激活已激活产品 → AlreadyActive                                                 | ✅   |         77 |
| ESC-ERR-21    | 下架已下架产品 → AlreadyInactive                                               | ✅   |         86 |
| ESC-ERR-22    | 汇率已过期时下单 → RateExpired                                                 | ✅   |         72 |
| ESC-ERR-23    | 非商家调用 listCryptoProduct → NotMerchant                                    | ✅   |        974 |
| ESC-ERR-24    | FIAT 非 WAITING 状态调用 receiveCrypto → NotWaiting                          | ✅   |         88 |

### ATTACK — 攻击防御

| 编号          | 测试内容                                                                   | 通过 | 总时间(ms) |
|---------------|----------------------------------------------------------------------------|:----:|-----------:|
| ESC-ATT-01    | proof 含错误 orderBindingHash → OrderBindingHashMismatch                    | ✅   |         91 |
| ESC-ATT-02    | proof 链 ID 错误 → OrderBindingHashMismatch                                 | ✅   |         93 |
| ESC-ATT-03    | proof orderId 错误 → OrderBindingHashMismatch                               | ✅   |         94 |
| ESC-ATT-04    | 攻击者重放已用 sessionId → SessionAlreadyUsed                                 | ✅   |        157 |
| ESC-ATT-05    | 验证者签名被篡改 → UntrustedVerifier                                           | ✅   |         90 |
| ESC-ATT-06    | 付款金额不匹配 → PaymentAmountMismatch                                         | ✅   |        107 |
| ESC-ATT-07    | 货币类型不匹配 → CurrencyMismatch                                              | ✅   |        111 |
| ESC-ATT-08    | 付款状态不匹配 → PaymentNotCompleted                                           | ✅   |        117 |
| ESC-ATT-09    | 付款时间晚于截止时间 → TransferDateExpired                                       | ✅   |        115 |
| ESC-ATT-10    | 重复使用 Alipay orderId → DuplicateAlipayOrderId                             | ✅   |        165 |
| ESC-ATT-11    | FIAT proof 商家身份错误 → OrderBindingHashMismatch                             | ✅   |         94 |
| ESC-ATT-12    | FIAT proof 收款方身份错误 → OrderBindingHashMismatch                           | ✅   |        100 |
| ESC-ATT-13    | 攻击者伪造 CRYPTO 平台 proof → 验证失败                                          | ✅   |         81 |
| ESC-ATT-14    | 商家直接调用 bondVault.settle 窃取保证金 → OnlyEscrow                            | ✅   |         88 |

### TAMPER — 篡改测试

| 编号             | 测试内容                                                                   | 通过 | 总时间(ms) |
|------------------|----------------------------------------------------------------------------|:----:|-----------:|
| ESC-TAMPER-01    | 修改 commitmentsHash → CommitmentsHashMismatch                             | ✅   |         96 |
| ESC-TAMPER-02    | 修改验证者签名 → UntrustedVerifier                                            | ✅   |         98 |
| ESC-TAMPER-03    | Alipay 状态非 succeed → AlipayPaymentNotCompleted                          | ✅   |        107 |
| ESC-TAMPER-04    | Alipay bizType 不合法 → InvalidAlipayBizType                               | ✅   |        113 |
| ESC-TAMPER-05~13 | 其余篡改场景由 AlipayPlatform.ts / WisePlatform.ts 覆盖                       | ✅   |         —  |

### PAUSE — 紧急暂停机制

| 编号      | 测试内容                                                                   | 通过 | 总时间(ms) |
|-----------|----------------------------------------------------------------------------|:----:|-----------:|
| PAUSE-01  | pause 后 placeOrder → revert ContractPaused                               | ✅   |         79 |
| PAUSE-02  | pause 后 payOrderByPlatform → revert ContractPaused                       | ✅   |        103 |
| PAUSE-03  | pause 后 receiveCryptoWithPlatformPayment → revert ContractPaused         | ✅   |         95 |
| PAUSE-04  | unpause 后 placeOrder 恢复正常                                               | ✅   |        174 |
| PAUSE-05  | 非管理员无法调用 pause → OnlyAdmin                                             | ✅   |         69 |

---

## WisePlatform 验证器 — 34/34 ✅

### FLOW — 正常流程

| 编号            | 测试内容                                              | 通过 | 总时间(ms) | 验证时间(ms) | Gas 消耗       |
|-----------------|-------------------------------------------------------|:----:|-----------:|------------:|---------------:|
| WISE-FLOW-01    | 买家支付验证成功，txId=transferId                            | ✅   |         51 |          44 |        488,213 |
| WISE-FLOW-02    | 商家收款验证成功，txId=transferId                            | ✅   |         44 |          35 |        487,002 |
| WISE-FLOW-03    | 时间边界 dateMs/1000==orderCreationTime 允许通过            | ✅   |         46 |          40 |        488,177 |
| WISE-FLOW-04    | 时间边界 dateMs/1000==orderDeadline 允许通过                | ✅   |         49 |          42 |        488,201 |
| WISE-FLOW-05    | transferId 成功后落库，usedTransferIds=true               | ✅   |         44 |          37 |        488,213 |

### ERR — 错误拦截

| 编号            | 测试内容                                              | 通过 | 总时间(ms) | 验证时间(ms) |
|-----------------|-------------------------------------------------------|:----:|-----------:|------------:|
| WISE-ERR-01     | 非 TLSNVerifier 直接调用 verify* → 拒绝                   | ✅   |          5 |           4 |
| WISE-ERR-02     | proof 数量不足（仅 transfer 或仅 contacts）→ 拒绝            | ✅   |         28 |           9 |
| WISE-ERR-03     | proof 顺序颠倒 [transfer, contacts] → 拒绝               | ✅   |         18 |          12 |
| WISE-ERR-04     | state 不匹配 → PaymentNotCompleted                     | ✅   |         28 |          22 |
| WISE-ERR-05     | amount 不匹配 → PaymentAmountMismatch                  | ✅   |         26 |          21 |
| WISE-ERR-06     | currency 不匹配 → CurrencyMismatch                     | ✅   |         21 |          16 |
| WISE-ERR-07     | transferId 重放 → DuplicateTransferId                 | ✅   |         68 |          17 |
| WISE-ERR-08     | 付款早于下单时间 → WiseTransferTooOld                       | ✅   |         26 |          18 |
| WISE-ERR-09     | 付款晚于截止时间 → TransferDateExpired                      | ✅   |         23 |          16 |
| WISE-ERR-10     | 缺 state 字段 → MissingWiseField                       | ✅   |         33 |          27 |
| WISE-ERR-11     | 缺 targetAmount 字段 → MissingWiseField                | ✅   |         35 |          18 |
| WISE-ERR-12     | 缺 targetCurrency 字段 → MissingWiseField              | ✅   |         27 |          19 |
| WISE-ERR-13     | 缺 id 字段 → MissingWiseField                          | ✅   |         27 |          18 |
| WISE-ERR-14     | 缺 date 字段 → MissingWiseField                        | ✅   |         31 |          24 |

### ATTACK — 攻击防御

| 编号            | 测试内容                                              | 通过 | 总时间(ms) | 验证时间(ms) | Gas 消耗       |
|-----------------|-------------------------------------------------------|:----:|-----------:|------------:|---------------:|
| WISE-ATT-01     | 跨订单 transferId 重放 → DuplicateTransferId             | ✅   |         75 |          18 |             —  |
| WISE-ATT-02     | 旧转账复用攻击 → WiseTransferTooOld                        | ✅   |         29 |          20 |             —  |
| WISE-ATT-03     | 延迟提交攻击 → TransferDateExpired                        | ✅   |         35 |          29 |             —  |
| WISE-ATT-04     | 伪造 amount/currency → 参数校验拒绝                        | ✅   |         35 |          23 |             —  |
| WISE-ATT-05     | 弱化 contacts proof（文档性用例）                           | ✅   |         63 |          52 |        559,644 |
| WISE-ATT-06     | 直连平台合约绕过 TLSN → OnlyTLSNVerifier                   | ✅   |          3 |           2 |             —  |
| WISE-ATT-07     | 跨 proof session 重放 → SessionAlreadyUsed             | ✅   |         12 |           4 |             —  |
| WISE-ATT-08     | 不可信 payment server → NotTrustedPaymentServer        | ✅   |          8 |           4 |             —  |

### TAMPER — 篡改测试

| 编号              | 测试内容                                              | 通过 | 总时间(ms) | 验证时间(ms) | Gas 消耗       |
|-------------------|-------------------------------------------------------|:----:|-----------:|------------:|---------------:|
| WISE-TAMPER-01    | 商家改支付哈希后沿用旧 proof 仍可通过                              | ✅   |         45 |          38 |        488,213 |
| WISE-TAMPER-02    | 改 rateVersion 提交 → OrderBindingHashMismatch        | ✅   |         13 |           3 |             —  |
| WISE-TAMPER-03    | 改 buyer/payee 绑定 → OrderBindingHashMismatch        | ✅   |         10 |           3 |             —  |
| WISE-TAMPER-04    | 商家更新汇率后，旧单 proof 仍可通过                               | ✅   |         43 |          37 |        488,249 |
| WISE-TAMPER-05    | 订单完成后重复提交同 proof → SessionAlreadyUsed            | ✅   |         55 |           3 |             —  |
| WISE-TAMPER-06    | 伪造同平台不同商家上下文 → 绑定不一致拒绝                             | ✅   |         26 |           2 |             —  |
| WISE-TAMPER-07    | 改支付哈希后用新哈希签旧订单 → OrderBindingHashMismatch         | ✅   |          8 |           2 |             —  |

---

## AlipayPlatform 验证器 — 37/37 ✅

### FLOW — 正常流程

| 编号           | 测试内容                                              | 通过 | 总时间(ms) | 验证时间(ms) | Gas 消耗       |
|----------------|-------------------------------------------------------|:----:|-----------:|------------:|---------------:|
| ALI-FLOW-01    | 买家支付验证成功，txId=keccak(orderId)                       | ✅   |         40 |          34 |        437,730 |
| ALI-FLOW-02    | 商家收款验证成功，txId=keccak(orderId)                       | ✅   |         47 |          40 |        436,427 |
| ALI-FLOW-03    | 边界 gmtSuccess==creation 允许通过                        | ✅   |         45 |          40 |        437,706 |
| ALI-FLOW-04    | 边界 gmtSuccess==deadline 允许通过                        | ✅   |         39 |          32 |        437,718 |
| ALI-FLOW-05    | orderId 成功后落库，usedAlipayOrderIds=true               | ✅   |         37 |          30 |        437,706 |

### ERR — 错误拦截

| 编号           | 测试内容                                              | 通过 | 总时间(ms) | 验证时间(ms) |
|----------------|-------------------------------------------------------|:----:|-----------:|------------:|
| ALI-ERR-01     | 非 TLSNVerifier 直接调用 verify* → OnlyTLSNVerifier    | ✅   |          2 |           1 |
| ALI-ERR-02     | status 非 SUCCESS → AlipayPaymentNotCompleted         | ✅   |         18 |          13 |
| ALI-ERR-03     | bizType 非 TRANSFER → InvalidAlipayBizType            | ✅   |         23 |          17 |
| ALI-ERR-04     | 买家侧金额不匹配 → PaymentAmountMismatch                   | ✅   |         20 |          14 |
| ALI-ERR-05     | 商家侧金额不匹配 → ReceivedAmountMismatch                  | ✅   |         36 |          29 |
| ALI-ERR-06     | orderId 重放 → DuplicateAlipayOrderId                  | ✅   |         64 |          13 |
| ALI-ERR-07     | 付款早于下单时间 → AlipayTransferTooOld                     | ✅   |         25 |          19 |
| ALI-ERR-08     | 付款晚于截止时间 → AlipayTransferDateExpired               | ✅   |         28 |          19 |
| ALI-ERR-09     | 缺 payAmount 字段 → MissingAlipayField                  | ✅   |         17 |          12 |
| ALI-ERR-10     | 缺 status 字段 → MissingAlipayField                    | ✅   |         18 |          12 |
| ALI-ERR-11     | 缺 bizType 字段 → MissingAlipayField                   | ✅   |         23 |          16 |
| ALI-ERR-12     | 缺 orderId 字段 → MissingAlipayField                   | ✅   |         15 |          11 |
| ALI-ERR-13     | 缺 gmtSuccess 字段 → MissingAlipayField                | ✅   |         17 |          11 |
| ALI-ERR-14     | 时间格式异常 → InvalidDatetimeFormat                      | ✅   |         22 |          16 |

### ATTACK — 攻击防御

| 编号           | 测试内容                                              | 通过 | 总时间(ms) | 验证时间(ms) |
|----------------|-------------------------------------------------------|:----:|-----------:|------------:|
| ALI-ATT-01     | 跨订单 orderId 重放 → DuplicateAlipayOrderId            | ✅   |         79 |          13 |
| ALI-ATT-02     | 旧支付复用攻击 → AlipayTransferTooOld                     | ✅   |         24 |          17 |
| ALI-ATT-03     | 延时提交攻击 → AlipayTransferDateExpired                 | ✅   |         26 |          20 |
| ALI-ATT-04     | 字段删减绕过 → MissingAlipayField                        | ✅   |         17 |          11 |
| ALI-ATT-05     | 直连平台合约绕过 TLSN → OnlyTLSNVerifier                  | ✅   |          4 |           3 |
| ALI-ATT-06     | 伪造支付状态码 → AlipayPaymentNotCompleted               | ✅   |         19 |          13 |
| ALI-ATT-07     | 伪造业务类型 → InvalidAlipayBizType                      | ✅   |         20 |          14 |
| ALI-ATT-08     | 不可信 payment server → NotTrustedPaymentServer        | ✅   |         12 |           6 |

### TAMPER — 篡改测试

| 编号             | 测试内容                                              | 通过 | 总时间(ms) | 验证时间(ms) | Gas 消耗       |
|------------------|-------------------------------------------------------|:----:|-----------:|------------:|---------------:|
| ALI-TAMPER-01    | 商家改汇率后，旧单 proof 仍可通过                                | ✅   |         46 |          37 |        438,211 |
| ALI-TAMPER-02    | proof 使用错误 rateVersion → OrderBindingHashMismatch  | ✅   |         18 |          12 |             —  |
| ALI-TAMPER-03    | 改 buyer/payee 绑定 → OrderBindingHashMismatch        | ✅   |         18 |           6 |             —  |
| ALI-TAMPER-04    | FIAT WAITING 订单 cancel → OrderCancellationDisabled  | ✅   |          6 |           2 |             —  |
| ALI-TAMPER-05    | 非买家取消 PENDING 订单 → OrderCancellationDisabled       | ✅   |          5 |           1 |             —  |
| ALI-TAMPER-06    | 非商家提交 FIAT 证明 → WrongId                            | ✅   |         10 |           2 |             —  |
| ALI-TAMPER-07    | 订单完成后重复提交 proof → OrderNotFound 或 NotPending      | ✅   |         87 |           3 |             —  |
| ALI-TAMPER-08    | 商家更新支付哈希后复用旧 proof 仍可通过                             | ✅   |         36 |          29 |        438,247 |
| ALI-TAMPER-09    | 非营业时段下单 → MerchantClosed                           | ✅   |          3 |           1 |             —  |
| ALI-TAMPER-10    | 改支付哈希后用新哈希签旧订单 → OrderBindingHashMismatch         | ✅   |          8 |           1 |             —  |

---

## 集成测试 (V4) — 17/17 ✅

| 编号    | 测试内容                                                             | 通过 | 总时间(ms) |
|---------|----------------------------------------------------------------------|:----:|-----------:|
| INT-01  | CRYPTO 全流程：下单 → 提交 proof → claim 保证金                          | ✅   |        120 |
| INT-02  | FIAT 全流程：下单 → 商家收款证明 → claim 保证金                            | ✅   |        124 |
| INT-03  | CRYPTO 超时 → cleanupExpired → 商家 claimable 增加                    | ✅   |        406 |
| INT-04  | FIAT 超时 → 买家通过 BondVault claim 本金+保证金                         | ✅   |         81 |
| INT-05  | 多平台并发订单（Wise CRYPTO + Alipay FIAT）                              | ✅   |        149 |
| INT-06  | 高风险买家需缴纳更高保证金                                                  | ✅   |         82 |
| INT-07  | FIAT 超时 → 减少商家 collateral，信誉系统记录超时                            | ✅   |         82 |
| INT-08  | cancelOrder 已禁用 → revert OrderCancellationDisabled                | ✅   |         83 |
| INT-09  | 完成订单重复 settle → OrderBondAlreadySettled（内部防护）                  | ✅   |        118 |
| INT-10  | 跨平台 sessionId 复用被拒 → SessionAlreadyUsed                         | ✅   |        134 |
| INT-11  | claim 保证金 → ERC20 实际转账至领取方，claimable 清零                       | ✅   |        117 |
| INT-12  | 买家完成后在同 CRYPTO 产品重新下单，hasActiveOrder 已释放                    | ✅   |        122 |
| INT-13  | 超时后重新下单，placeOrder 内 _cleanupExpired 自动清除过期槽位                | ✅   |         81 |
| INT-14  | 商家 collateral 耗尽阻止超额 CRYPTO 订单                                  | ✅   |         92 |
| INT-15  | FIAT 顺序订单：第一笔完成后第二个买家可下单                                   | ✅   |        121 |
| INT-16  | 汇率快照保护进行中 CRYPTO 订单不受商家改价影响                                 | ✅   |        118 |
| INT-17  | 两周期账务精确核对（钱包余额 + claimable 完全匹配）                            | ✅   |        159 |

---

## TLSN 验证器 — 30/30 ✅

### 管理员移交

| 测试内容                              | 通过 |
|---------------------------------------|:----:|
| proposeAdmin→acceptAdmin 两步移交成功  | ✅   |
| 非管理员调用 proposeAdmin → 拒绝        | ✅   |
| 非 pendingAdmin 调用 acceptAdmin → 拒绝 | ✅   |
| proposeAdmin 零地址 → 拒绝            | ✅   |

### 可信验证者管理

| 测试内容                              | 通过 |
|---------------------------------------|:----:|
| addTrustedVerifier 成功               | ✅   |
| removeTrustedVerifier 成功            | ✅   |
| 非管理员 addTrustedVerifier → 拒绝    | ✅   |

### KYB 服务器管理

| 测试内容                              | 通过 |
|---------------------------------------|:----:|
| 添加和移除 KYB server                 | ✅   |

### 授权调用方

| 测试内容                              | 通过 |
|---------------------------------------|:----:|
| 管理员成功设置授权调用方                | ✅   |
| 未授权调用方调用 verifyProof → 拒绝    | ✅   |

### Proof 验证

| 测试内容                              | 通过 |
|---------------------------------------|:----:|
| 有效 proof 验证通过                    | ✅   |
| 错误 chainId → 拒绝                   | ✅   |
| 重复 sessionId → 拒绝                 | ✅   |
| 篡改 commitment opening → 拒绝        | ✅   |
| 篡改 commitmentsHash → 拒绝          | ✅   |
| 不可信验证者签名 → 拒绝                 | ✅   |

### KYB 验证

| 测试内容                              | 通过 |
|---------------------------------------|:----:|
| 有效 KYB proof 验证通过                | ✅   |
| KYC 状态非 verified → 拒绝            | ✅   |
| serverName 非信任 KYB → 拒绝         | ✅   |
| revealedItems 为空 → 拒绝             | ✅   |

### verifyAndDelegate 委托验证

| 测试内容                              | 通过 |
|---------------------------------------|:----:|
| Wise 买家支付通过 verifyAndDelegate 验证成功 | ✅  |
| Wise 商家收款通过 verifyAndDelegate 验证成功 | ✅  |
| 平台未注册 → 拒绝                      | ✅   |
| proof 服务器不可信 → 拒绝              | ✅   |
| Wise 付款金额不匹配（委托路径）→ 拒绝   | ✅   |
| Wise 货币不匹配（委托路径）→ 拒绝      | ✅   |
| Wise transfer proof 缺必要字段 → 拒绝 | ✅   |
| Alipay 买家支付通过 verifyAndDelegate 验证成功 | ✅ |

### 端到端签名格式

| 测试内容                              | 通过 |
|---------------------------------------|:----:|
| 真实验证者 5-item 签名格式通过合约验证  | ✅   |
| 旧版 4-item 签名被 UntrustedVerifier 拒绝 | ✅ |

---

## 汇率快照 — 9/9 ✅

| 编号     | 测试内容                                                      | 通过 |
|----------|---------------------------------------------------------------|:----:|
| RATE-01  | 汇率未发布时下单 → RateNotPublished                              | ✅   |
| RATE-02  | 首次发布汇率，version=1                                          | ✅   |
| RATE-03  | 二次发布汇率，version=2                                          | ✅   |
| RATE-04  | placeOrder 将 rateVersion 快照至订单结构                          | ✅   |
| RATE-05  | 第二次发布后下单，快照 version=2                                   | ✅   |
| RATE-06  | placeOrder 后再 publishRate 不影响已有订单 proof                  | ✅   |
| RATE-07  | 用新 rateVersion 提交旧订单 proof → OrderBindingHashMismatch    | ✅   |
| RATE-08  | 汇率过期时下单 → RateExpired                                     | ✅   |
| RATE-09  | expiresAt=0 表示永不过期，下单成功                                 | ✅   |

---

## 单笔限额 — 6/6 ✅

| 编号    | 测试内容                                                      | 通过 |
|---------|---------------------------------------------------------------|:----:|
| CAP-01  | 金额恰好等于 maxOrderAmount（1000 USDT）→ 下单成功               | ✅   |
| CAP-02  | 金额小于 maxOrderAmount（999 USDT）→ 下单成功                    | ✅   |
| CAP-03  | 金额超出 maxOrderAmount（1001 USDT）→ ExceedsUsdCap            | ✅   |
| CAP-04  | 管理员降低限额至 500 USDT，600 USDT 订单 → ExceedsUsdCap         | ✅   |
| CAP-05  | FIAT 产品下单金额超限 → ExceedsUsdCap                           | ✅   |
| CAP-06  | 限额按单笔计算，非累计（提高限额后两笔 600 USDT 均成功）              | ✅   |

---

## 营业时间 — 14/14 ✅

| 编号   | 测试内容                                                             | 通过 |
|--------|----------------------------------------------------------------------|:----:|
| BH-01  | 默认状态（未设营业时间，无 openNow）→ isMerchantOpen=false             | ✅   |
| BH-02  | 营业时间外下单 → MerchantClosed                                       | ✅   |
| BH-03  | openNow → isMerchantOpen=true，下单成功                              | ✅   |
| BH-04  | openNow 后 closeNow → isMerchantOpen=false                          | ✅   |
| BH-05  | openNow 后 clearManualOverride → 回落到时间表（默认关闭）              | ✅   |
| BH-06  | setBusinessHours 后叠加 openNow → isMerchantOpen=true               | ✅   |
| BH-07  | setBusinessHours + clearManualOverride，时间戳在窗口内 → open         | ✅   |
| BH-08  | activeDays=0（无激活日）→ isMerchantOpen=false                       | ✅   |
| BH-09  | 全天激活（activeDays=0x7F），窗口 00:00–23:59 → 始终开放               | ✅   |
| BH-10  | 跨午夜时间表（22:00–06:00，全天），daySecond=23:00 → open             | ✅   |
| BH-11  | 跨午夜时间表（22:00–06:00，全天），daySecond=12:00 → closed           | ✅   |
| BH-12  | manualOverride=2（closeNow）下单 → MerchantClosed                    | ✅   |
| BH-13  | 全天 00:00–23:59 时间表 → 下单成功                                    | ✅   |
| BH-14  | 不同 productId 的营业时间相互独立                                       | ✅   |

---

## Bond 双边公平机制 (V4) — 22/22 ✅

| 编号      | 测试内容                                                                | 通过 | 总时间(ms) |
|-----------|-------------------------------------------------------------------------|:----:|-----------:|
| BOND-01   | cancelOrder → revert OrderCancellationDisabled                          | ✅   |         78 |
| BOND-02   | Managers 未设置时下单 → revert ManagersNotSet                            | ✅   |         —  |
| BOND-03   | 黑名单买家下 CRYPTO 单 → revert UserBlacklisted                           | ✅   |        721 |
| BOND-03b  | 黑名单买家下 FIAT 单 → revert UserBlacklisted                             | ✅   |         83 |
| BOND-03c  | 黑名单商家的 CRYPTO 产品不可下单 → revert UserBlacklisted                   | ✅   |         —  |
| BOND-03d  | 冻结商家的 CRYPTO 产品不可下单 → revert UserTemporarilyFrozen               | ✅   |         89 |
| BOND-04   | 冻结买家下单 → revert UserTemporarilyFrozen                               | ✅   |        267 |
| BOND-05   | CRYPTO 商家 collateral 不足 → revert InsufficientAvailable               | ✅   |         —  |
| BOND-06   | FIAT 订单金额超出 collateral → revert InsufficientAvailable               | ✅   |         77 |
| BOND-07   | CRYPTO 买家完成证明 → 买家 claim 回 bondAmount                             | ✅   |        117 |
| BOND-08   | CRYPTO 买家超时 → 商家 claimableBalance 增加 bondAmount                    | ✅   |      3,057 |
| BOND-09   | FIAT 商家完成证明 → 商家 claim 回 bondAmount                               | ✅   |        117 |
| BOND-10   | FIAT 商家超时 → 买家 claimable=本金+bond；商家 claimable=stake              | ✅   |        743 |
| BOND-11   | 重复 settle → revert OrderBondAlreadySettled                            | ✅   |        126 |
| BOND-12   | 连续超时 3 次 → riskLevel 上升，requiredBondBps 上升                        | ✅   |        107 |
| BOND-13   | 超时后完成 2 笔 → consecutiveTimeouts 不清零                               | ✅   |      1,022 |
| BOND-14   | 超时后完成 3 笔 → consecutiveTimeouts 清零                                | ✅   |        257 |
| BOND-15   | 累计超时 15 次 → temporarilyFrozen=true                                  | ✅   |        126 |
| BOND-16   | 冻结期满 → requiredBondBps 正常返回（不再 revert）                          | ✅   |         87 |
| BOND-17   | _applyDecay 先于 riskLevel 递增写入存储，onTimeout 基于衰减后值               | ✅   |         94 |
| BOND-18   | 快进 90 天 → requiredBondBps 随衰减下降                                    | ✅   |         86 |
| BOND-19   | admin 设置极大 stepBps → requiredBondBps 返回 maxBondBps，不 panic         | ✅   |         91 |

---

## 过期订单清理 — 11/11 ✅

### GAS — gas 随批量变化分析

| 编号           | 测试内容                                              | 通过 | 总时间(ms) | Gas 消耗      |
|----------------|-------------------------------------------------------|:----:|-----------:|--------------:|
| CLEAN-GAS-01   | 1 笔过期 CRYPTO 订单清理基准 gas                           | ✅   |        128 |       162,765 |
| CLEAN-GAS-02   | 10 笔过期 CRYPTO 订单批量清理（线性增长验证）                  | ✅   |        204 |     1,037,738 |
| CLEAN-GAS-03   | 15 笔过期 CRYPTO 订单（超线性趋势观测）                       | ✅   |        289 |     1,523,838 |
| CLEAN-GAS-04   | 块 gas 上限瓶颈 — riskManager cold SSTORE 超线性增长分析    | ✅   |         —  |     1,523,838 |
| CLEAN-GAS-05   | EIP-3529 退款效应汇总验证（per-order gas 随 N 下降趋势）      | ✅   |         —  |            —  |

**EIP-3529 退款效应分析**

| 批量 N | 总 gas     | 每笔 gas  | 说明                    |
|-------:|----------:|----------:|-------------------------|
|      1 |   162,765 |   162,765 | 基准（无退款叠加效应）     |
|     10 | 1,037,738 |   103,773 | 退款效应显现，每笔下降     |
|     15 | 1,523,838 |   101,589 | 退款效应继续              |

> EIP-3529 退款上限 = total_gas / 5（20%）。每笔 gas 随 N 增大而下降，预计 N≈40 后趋于稳定。

### BLOCK — 队列堵塞与合约流程瓶颈

| 编号             | 测试内容                                              | 通过 | 总时间(ms) | Gas 消耗      |
|------------------|-------------------------------------------------------|:----:|-----------:|--------------:|
| CLEAN-BLOCK-01   | 200 笔未过期订单满载 → 无效 cleanup + TooManyPending 拦截  | ✅   |        793 |        36,044 |
| CLEAN-BLOCK-02   | 队首未过期订单 break → 仅清理 10/15 笔（部分清理）           | ✅   |         91 |     1,043,044 |
| CLEAN-BLOCK-03   | placeOrder 自动触发 cleanup → 新订单成功下达               | ✅   |         84 |     1,421,075 |
| CLEAN-BLOCK-04   | cleanup 后 hasActiveOrder=false，订单存储已删除，可重新下单   | ✅   |         43 |       551,641 |

### TYPE — FIAT 与 CRYPTO 清理 gas 对比

| 编号             | 测试内容                                              | 通过 | 总时间(ms) | Gas 消耗      |
|------------------|-------------------------------------------------------|:----:|-----------:|--------------:|
| CLEAN-TYPE-01    | 5 笔 FIAT WAITING 超时订单 cleanup gas                 | ✅   |        141 |       593,552 |
| CLEAN-TYPE-02    | N=10 批量：FIAT（109,978/笔）vs CRYPTO（103,773/笔）对比  | ✅   |        465 |     1,099,782 |

> FIAT 清理比 CRYPTO 贵约 **6,205 gas/笔**，原因：FIAT 超时额外触发 `buyerEscrowedAmount` 更新及 `bondVault.settle` 的双参数重载路径。

---

## Sweep 公开清理 (V4) — 22/22 ✅

> 对应文件：[`test/Sweep.ts`](test/Sweep.ts)  
> 覆盖功能：`sweepExpired(merchant, productId, assetType, maxSteps)` 与 `sweepExpiredBatch(targets[])` 两个公开入口，任何 EOA 可调用，配合 `ReentrancyGuard` + `whenNotPaused` 保护。

### SINGLE — `sweepExpired`（单产品）

| 编号        | 测试内容                                                                | 通过 |
|-------------|-------------------------------------------------------------------------|:----:|
| SWEEP-S-01  | 无过期订单时 no-op（返回 cleaned=0，不发事件）                              | ✅   |
| SWEEP-S-02  | 清理 1 笔过期 CRYPTO 订单 → 订单存储被删除（buyer 归零）                      | ✅   |
| SWEEP-S-03  | 清理 1 笔过期 FIAT 订单（WAITING → EXPIRED → 删除）                         | ✅   |
| SWEEP-S-04  | 清理同产品多笔过期订单（N=5 全部删除）                                       | ✅   |
| SWEEP-S-05  | `maxSteps=2`，5 笔过期 → 仅前 2 笔被清理，3-5 笔保持 PENDING                | ✅   |
| SWEEP-S-06  | 第三方 EOA（非买家非商家）调用成功                                          | ✅   |
| SWEEP-S-07  | 每笔过期订单触发一次 `riskManager.onTimeout`（buyer.timeoutCount += 1）     | ✅   |
| SWEEP-S-08  | CRYPTO 超时 → `bondVault.settle(PROOF_TIMEOUT)`，商家 claimable 增加     | ✅   |
| SWEEP-S-09  | 清理后 `hasActiveOrder[buyer][merchant][asset][pid]` 复位为 false         | ✅   |
| SWEEP-S-10  | 发出 `ExpiredSwept(caller, merchant, productId, assetType, count)` 事件 | ✅   |
| SWEEP-S-11  | 每笔过期订单各发出一次 `OrderStatusChanged(EXPIRED)` 事件                   | ✅   |
| SWEEP-S-12  | 合约 paused 时调用 → revert (`ContractPaused` / selector 0xab35696f)     | ✅   |

### BATCH — `sweepExpiredBatch`（跨产品批量）

| 编号        | 测试内容                                                                | 通过 |
|-------------|-------------------------------------------------------------------------|:----:|
| SWEEP-B-01  | 一笔 tx 清理 3 个不同产品的过期订单（cleaned=3）                            | ✅   |
| SWEEP-B-02  | 过期与未过期产品混合 batch → 仅清理过期的（cleaned=1）                       | ✅   |
| SWEEP-B-03  | `targets.length=0` → revert `BatchSizeInvalid`                          | ✅   |
| SWEEP-B-04  | `targets.length=21`（> MAX_SWEEP_BATCH=20）→ revert `BatchSizeInvalid`   | ✅   |
| SWEEP-B-05  | 幂等：第二次 batch 调用 cleaned=0，不发 `ExpiredSwept`                      | ✅   |
| SWEEP-B-06  | 合约 paused 时调用 → revert                                              | ✅   |

### INV — 不变量校验

| 编号        | 测试内容                                                                | 通过 |
|-------------|-------------------------------------------------------------------------|:----:|
| SWEEP-I-01  | CRYPTO：`pendingAmount` 精确下降 N × TRADE_AMOUNT；`collateralAmount` 不变 | ✅   |
| SWEEP-I-02  | FIAT：`buyerEscrowedAmount` 下降（通过 `pendingAmount` 变化间接观测）       | ✅   |
| SWEEP-I-03  | `riskManager.timeoutCount` 累加值等于过期订单数                            | ✅   |

### IDEM — 与 `placeOrder` 协作

| 编号        | 测试内容                                                                | 通过 |
|-------------|-------------------------------------------------------------------------|:----:|
| SWEEP-D-01  | sweep 后同产品可继续接受新订单（`orderId` 递增到 1，状态 PENDING）            | ✅   |

> **实现要点**：`_cleanupExpired` 重构为 `_cleanupExpiredBounded(maxSteps)` 内部包装，对原有 4 个内部调用点（`placeOrder` + 3 个结算路径）行为零变化；公开入口通过 `before/after` 的 `activeOrderCount` 差值精确计算被清理订单数。

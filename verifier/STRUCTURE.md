# Verifier 服务整体架构 (STRUCTURE.md)

> 本目录：`packages/verifier/` —— 基于 Rust + Axum 的 **TLSNotary 验证 / 签名 / 留存 / 分发** 一体化服务。
>
> 在 C2C 平台中扮演的角色：把跨平台支付 (Wise / Alipay / X 等) 的 HTTPS 响应通过 MPC-TLS 转化为**可上链 / 可审计**的"链下证据"，并对接前端 (浏览器扩展 + DApp) 与后端 (Webhook 接收方)。

---

## 1. 目录本身做什么 (What this directory is)

它是一个独立可部署的 **HTTP + WebSocket 服务进程**，端口默认 `7047`。
对外提供 4 类能力：

| 能力 | 协议 | 端点 | 服务对象 |
|---|---|---|---|
| TLSNotary MPC-TLS Verifier | WS | `/verifier`, `/session` | 浏览器扩展 (Prover) |
| TLS-over-WebSocket Proxy | WS | `/proxy?token=<host>` | 浏览器扩展 (兼容 `notary.pse.dev`) |
| Proof Store / 5 年留存 (FATF R.11) | HTTP REST | `/proof/*`, `/proofs` | 合规后端 / 监管 / 前端审计页 |
| Verifier 签名 + Slim Webhook 分发 | HTTP outbound + SIWE/API-Key | `/auth/*` | 商户后端、链上合约、AML 系统 |

它**不是**一个纯 TLSNotary 节点 —— 它在 TLSNotary 之上把"验证结果"加工成 4 件交付物：
1. **HandlerResult[]** —— 按字段语义抽取的明文 (e.g. `originator.amount = "100.00"`)
2. **VerifierSignature** —— secp256k1 / EIP-191 签名，可直接喂给 Solidity 合约
3. **SlimWebhookPayload** —— 推送给商户后端 (HMAC-SHA256 签名)
4. **ProofExportV1** —— SQLite 持久化的完整证据记录，保留 5 年

---

## 2. 源码模块图 (`src/`)

```
src/
├── main.rs                    入口：tracing、配置加载、路由装配、SIWE 开关、CORS
├── app_state.rs               AppState：sessions / db / api_keys / siwe / rate_limiter
├── domain.rs                  领域类型 (Handler, RangeWithHandler, AccountCheck, …)
├── verifier.rs                封装 tlsn::Verifier，跑 MPC-TLS、产出 TranscriptCommitment
├── ws.rs                      /session WS 主循环 (register → reveal_config → completed)
├── axum_websocket.rs          axum WebSocket → AsyncRead/AsyncWrite 桥接 (给 tlsn-core 用)
├── signing.rs                 secp256k1 签名 (EIP-191)；preimage = chainId || sid || …
├── webhook.rs                 SlimWebhookPayload 构造 + HMAC + fire-and-forget POST
├── util.rs                    小工具 (时间、hex、keccak)
│
├── api/                       HTTP handler
│   ├── meta.rs                /health, /info
│   ├── proofs.rs              /proof/:id, PATCH /proof/:id/tx, /proof?txHash=, /proofs
│   └── auth.rs                /auth/nonce, /auth/verify (SIWE → JWT)
│
├── auth/                      鉴权层
│   ├── api_key.rs             PROOF_API_KEYS 解析；SuperAdmin / Tenant 二级作用域
│   ├── siwe.rs                Sign-In-With-Ethereum 验证 + nonce 存储
│   └── mod.rs                 Extractor (Principal: ApiKey | User)
│
├── storage/                   持久化 (SQLite, R.11)
│   ├── schema.sql             表结构
│   ├── record.rs              ProofExportRecord / ListQuery
│   ├── repo.rs                init_db、insert_proof_record、get_by_session/tx、list、promote
│   ├── export.rs              record_to_response (DB row → ProofExportV1 JSON)
│   └── retention.rs           ephemeral 行的 5 分钟轮询清理 (compliance 永不删)
│
└── tests/                     集成 + 单元测试 (proxy / range mapping / e2e)
tests/
├── proxy_test.rs              /proxy 端到端转发测试
└── range_mapping_test.rs      Reveal Range ↔ Commitment 对齐测试
scripts/
└── compare-proxy.mjs          对比本地 /proxy 与 notary.pse.dev/proxy 行为差异
```

> 重构后 `main.rs` 仍保留了 `pub(crate) use storage::…` re-export，纯粹是为了让旧测试 `src/tests/*` 不用改路径 —— 不是新增能力。

---

## 3. 一次完整证明的生命周期 (端到端时序)

```
┌──────────────┐   1. POST /session(register, sessionData)
│  Extension   ├──────────────────────────────────────────────┐
│  (Prover)    │                                              │
└──────┬───────┘                                              ▼
       │                                          ┌───────────────────┐
       │   2. ws://.../verifier?sessionId=…       │  AppState         │
       ├────────────────────────────────────────► │  sessions: HashMap│
       │                                          └─────────┬─────────┘
       │   3. /proxy?token=api.x.com  (TLS over WS)         │
       ├────────────────────────────────────────────────────┤
       │                                                    ▼
       │       MPC-TLS handshake + transcript           ┌────────┐
       │ ◄──────────────────────────────────────────────│ tlsn   │
       │                                                │Verifier│
       │   4. reveal_config { sent[], recv[],           └────┬───┘
       │                      accountChecks[] }              │
       ├────────────────────────────────────────────────────►│
       │                                                     │
       │   5. session_completed {                            │
       │        results, transcriptCommitments,              │
       │        verifierSignature: { r,s,v, addr, … }  ◄─────┤
       │      }                                              │
       ◄─────────────────────────────────────────────────────┤
                                                             │
                                  ┌──────────────────────────┤
                                  ▼                          ▼
                       ┌─────────────────┐         ┌──────────────────┐
                       │ insert_proof_   │         │ Slim Webhook POST│
                       │ record (SQLite) │         │ + X-TLSN-Signature│
                       │ retain 5 years  │         │ 商户后端 / AML   │
                       └─────────────────┘         └──────────────────┘
                                  ▲
                                  │ 6. eth_sendTransaction 上链成功后
                                  │    PATCH /proof/:id/tx { txHash, chainId }
                       ┌──────────┴──────────┐
                       │  Frontend (DApp)    │
                       └─────────────────────┘
```

关键不变量：
- `sessionId` (UUID) 全流程贯穿 = WS 会话 + 签名 preimage + DB 主键 + Webhook 关联键
- `orderBindingHash` 把链下证明**锁定**到链上订单 (escrow + buyer + amount + deadline 的 keccak)
- `policyVersionHash` 锁定合规策略版本 (FATF R.15)，可在链上验证"用哪一版规则签的"

---

## 4. 为各角色提供的服务

### 4.1 给 浏览器扩展 / Prover (`packages/extension`, `packages/plugin-sdk`)
- `WS /session` —— 注册 maxRecv/Sent、policy version、order binding hash；接收 reveal 结果与 verifierSignature
- `WS /verifier?sessionId=…` —— TLSNotary MPC 内部通道 (tlsn-core 直接使用)
- `WS /proxy?token=host` —— 浏览器无法直发 TCP，所有 TLS 出站包都从这里转发到 `host:443`
- 兼容性：`token` 与 `host` query 参数 alias，可以无缝替换 `notary.pse.dev/proxy`

### 4.2 给 前端 DApp / 用户审计页
- `GET /info` —— 显示当前 verifier 版本 & tlsn-core 版本 & git hash，前端可校验"这个签名是哪版规则出的"
- `GET /proof/:sessionId` —— 一次性拿到完整 `ProofExportV1`，含 redactedTranscript、handlerResults、accountChecks、verifierSignature —— 可直接喂给合约的 `verify()` 方法
- `GET /proof?txHash=0x…` —— 反向查询，从链上 tx 回到链下证据
- `PATCH /proof/:sessionId/tx` —— 链上交易确认后回写 txHash，**`promote_to_committed`** 会把这一行从 ephemeral 升级为 compliance (永不清理)
- `GET /proofs` —— 分页列表，给运营 / 监管面板
- `POST /auth/nonce` + `POST /auth/verify` —— SIWE 登录换 JWT (仅当 `SIWE_JWT_SECRET` + `SIWE_DOMAIN` 都设置时挂载)

### 4.3 给 商户后端 / Webhook 接收方
- 服务**主动 POST** `SlimWebhookPayload` 到 `config.yaml` 里配置的 URL
- Per-host 路由 + `"*"` 兜底
- HMAC-SHA256：`secret` 字段存在时附加 `X-TLSN-Signature: sha256=<hex>` header
- 自定义 headers (如 `Authorization: Bearer …`) 可在 YAML 内直接附加
- Fire-and-forget：webhook 失败**不影响**主会话与 DB 落库

### 4.4 给 链上 (Solidity 合约 / 跨链)
- `verifierSignature` 是直接可 `ecrecover` 的 65-byte (r||s||v) EIP-191 签名
- preimage 固定为 **136 bytes**：`chainId(8 BE) || keccak256(sessionId)(32) || commitmentsHash(32) || orderBindingHash(32) || policyVersionHash(32)`
- 合约方只需要保存 verifier 地址，即可链上验证"这笔订单的支付证据真的由我们的 verifier 签过"

### 4.5 给 合规 / 监管 (FATF)
- **R.11** —— SQLite `retain_until = recorded_at + 5y`；compliance/已上链记录**永不**被 purge 删除
- **R.15** —— `policyVersion` + `policyVersionHash` 写入签名与 DB，可证明"用的是当时生效的规则"
- **R.16** —— Travel Rule 字段语义化 (`originator.*` / `beneficiary.*` / `transaction.*`) 由 plugin 的 `Handler.label` 标注，验证器原样转发到 webhook 与 `/proof` 响应

---

## 5. 前端如何接入 (How to use from the frontend)

### 5.1 在浏览器扩展中 (Plugin 作者视角)
Plugin 完全不用直接讲 verifier 协议，`@tlsn/plugin-sdk` 的 `prove()` 已经封装：

```javascript
const proof = await prove(
  { url: 'https://api.x.com/...', method: 'GET', headers: {...} },
  {
    verifierUrl: 'http://localhost:7047',         // <- 指向本服务
    proxyUrl:    'ws://localhost:7047/proxy?token=api.x.com',
    maxRecvData: 16384, maxSentData: 4096,
    handlers: [
      { type: 'RECV', part: 'BODY', action: 'REVEAL',
        params: { type: 'json', path: 'amount' },
        label: 'originator.amount' }              // <- Travel Rule 字段
    ],
    sessionData: {
      __tlsn_policy_version:      'v1.0.0',
      __tlsn_order_binding_hash:  '0x' + orderHash
    }
  }
);
// proof.verifierSignature 可以直接喂合约
```

### 5.2 在 DApp 中 (React 视角)
```ts
// 1. 上链
const tx = await escrow.settle(orderId, proof.verifierSignature.signature, …);
await tx.wait();

// 2. 回写 txHash，让该证据升级为 compliance 行
await fetch(`${VERIFIER_URL}/proof/${proof.sessionId}/tx`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json',
             'X-TLSN-Api-Key': API_KEY },
  body: JSON.stringify({ txHash: tx.hash, chainId: 11155111 })
});

// 3. 在审计页按 tx 反查
const evidence = await fetch(
  `${VERIFIER_URL}/proof?txHash=${tx.hash}`,
  { headers: { 'X-TLSN-Api-Key': API_KEY } }
).then(r => r.json());
```

### 5.3 CORS / 鉴权一览
- `CORS_ALLOW_ORIGINS` —— 逗号分隔；不设默认只允许 `localhost:3000` + `localhost:8080`
- `PROOF_API_KEYS` —— `k1:tenantA,k2:tenantB,super:*` (`*` = SuperAdmin)；不设则**所有 /proof\* 端点免鉴权**并在启动日志打印 WARN
- `X-TLSN-Api-Key: <key>` 或 `Authorization: Bearer <key>` 二选一
- SIWE 模式：前端用 ethers 签 EIP-4361 message → POST `/auth/verify` → 拿 JWT → 后续 `Authorization: Bearer <jwt>`

---

## 6. 运行与部署

```bash
# 开发
cd packages/verifier
cargo run                          # :7047，dev 模式无 API key 鉴权

# 生产
cargo build --release
PROOF_API_KEYS=…  PROOF_DB_PATH=/var/lib/tlsn/evidence.db \
VERIFIER_PRIVATE_KEY=0x…  CHAIN_ID=11155111 \
CORS_ALLOW_ORIGINS=https://app.example.com \
./target/release/verifier

# Docker (由 packages/demo/docker-compose.yml 启动)
npm run docker:up                  # 在 monorepo 根目录
```

关键环境变量 (完整列表见 `API_SPEC.md`)：

| 变量 | 作用 |
|---|---|
| `PORT` | 监听端口，默认 7047 |
| `VERIFIER_PRIVATE_KEY` | secp256k1 私钥；缺失则进程退出 |
| `CHAIN_ID` | 签名 preimage 里的 chainId，默认 Sepolia `11155111` |
| `PROOF_DB_PATH` | SQLite 路径，默认 `evidence.db` |
| `PROOF_API_KEYS` | 多租户 API key 表 |
| `SIWE_JWT_SECRET` + `SIWE_DOMAIN` | 两者**同时**设置才挂载 `/auth/*` |
| `CORS_ALLOW_ORIGINS` | 逗号分隔白名单 |

---

## 7. 与 monorepo 其他包的关系

| 包 | 依赖方向 | 关系 |
|---|---|---|
| `packages/extension` | extension → verifier | 通过 plugin SDK 的 `prove()` 调 `/session` + `/proxy` |
| `packages/plugin-sdk` | sdk → verifier | 仅 URL 约定，不直接 import |
| `packages/common` | — | verifier 是 Rust，不共享 TS 包 |
| `packages/demo` | demo compose → verifier | 用 Docker 起 verifier + nginx 反代供示例插件用 |

---

## 8. 阅读地图 (Reading order)

1. [API_SPEC.md](API_SPEC.md) —— 端点与字段的权威说明
2. [src/main.rs](src/main.rs) —— 路由装配 & 启动流程
3. [src/ws.rs](src/ws.rs) —— `/session` 的状态机
4. [src/verifier.rs](src/verifier.rs) —— MPC-TLS 调用 tlsn-core
5. [src/signing.rs](src/signing.rs) —— 签名 preimage 构造
6. [src/storage/](src/storage/) —— 持久化与 R.11 留存
7. [src/webhook.rs](src/webhook.rs) —— 出站 webhook + HMAC

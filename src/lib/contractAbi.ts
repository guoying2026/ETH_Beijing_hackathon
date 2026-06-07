/**
 * ABI definitions for C2C platform contracts.
 */

const tlsnProofTuple = {
    type: 'tuple' as const,
    components: [
        { name: 'chainId', type: 'uint64' as const },
        { name: 'sessionId', type: 'string' as const },
        { name: 'commitmentsHash', type: 'bytes32' as const },
        { name: 'orderBindingHash', type: 'bytes32' as const },
        { name: 'policyVersionHash', type: 'bytes32' as const },
        { name: 'verifierSignature', type: 'bytes' as const },
        {
            name: 'revealedItems',
            type: 'tuple[]' as const,
            components: [
                { name: 'handlerType', type: 'string' as const },
                { name: 'part', type: 'string' as const },
                { name: 'value', type: 'string' as const },
                { name: 'commitment_index', type: 'uint64' as const },
                { name: 'start_item', type: 'uint64' as const },
                { name: 'end_item', type: 'uint64' as const },
                { name: 'start_value', type: 'uint64' as const },
                { name: 'end_value', type: 'uint64' as const },
            ],
        },
        {
            name: 'commitmentOpenings',
            type: 'tuple[]' as const,
            components: [{ name: 'blinderHex', type: 'bytes' as const }],
        },
        {
            name: 'commitments',
            type: 'tuple[]' as const,
            components: [
                { name: 'direction', type: 'string' as const },
                { name: 'hashAlg', type: 'string' as const },
                { name: 'hashValue', type: 'bytes32' as const },
            ],
        },
        { name: 'serverName', type: 'string' as const },
    ],
};

function proofParam(name: string) {
    return { ...tlsnProofTuple, name };
}

const buyerPaymentInfoTuple = {
    type: 'tuple' as const,
    components: [
        { name: 'nameHash', type: 'bytes32' as const },
        { name: 'idHash',   type: 'bytes32' as const },
        { name: 'isSet',    type: 'bool'    as const },
    ],
};

// ── C2CAdmin ABI ──────────────────────────────────────────────

export const C2C_ADMIN_ABI = [
    {
        type: 'function' as const,
        name: 'registerMerchant',
        inputs: [proofParam('proof')],
        outputs: [],
        stateMutability: 'nonpayable' as const,
    },
    {
        type: 'function' as const,
        name: 'registerMerchantByAdmin',
        inputs: [{ name: '_merchant', type: 'address' as const }],
        outputs: [],
        stateMutability: 'nonpayable' as const,
    },
    {
        type: 'function' as const,
        name: 'setMerchantFiatAccount',
        inputs: [{ name: 'account', type: 'string' as const }],
        outputs: [],
        stateMutability: 'nonpayable' as const,
    },
    {
        type: 'function' as const,
        name: 'isMerchantActive',
        inputs: [{ name: '_merchant', type: 'address' as const }],
        outputs: [{ name: '', type: 'bool' as const }],
        stateMutability: 'view' as const,
    },
    {
        type: 'function' as const,
        name: 'getMerchantFiatAccount',
        inputs: [{ name: '_merchant', type: 'address' as const }],
        outputs: [{ name: '', type: 'string' as const }],
        stateMutability: 'view' as const,
    },
    {
        type: 'function' as const,
        name: 'getSupportCryptoCount',
        inputs: [],
        outputs: [{ name: '', type: 'uint256' as const }],
        stateMutability: 'view' as const,
    },
    {
        type: 'function' as const,
        name: 'getSupportFiatCount',
        inputs: [],
        outputs: [{ name: '', type: 'uint256' as const }],
        stateMutability: 'view' as const,
    },
    {
        type: 'function' as const,
        name: 'getSupportCryptoInfo',
        inputs: [{ name: '_id', type: 'uint256' as const }],
        outputs: [
            {
                name: '',
                type: 'tuple' as const,
                components: [
                    { name: 'id', type: 'uint256' as const },
                    { name: 'tokenSymbol', type: 'string' as const },
                    { name: 'tokenAddress', type: 'address' as const },
                    { name: 'assetType', type: 'uint8' as const },
                    { name: 'isActive', type: 'bool' as const },
                ],
            },
        ],
        stateMutability: 'view' as const,
    },
    {
        type: 'function' as const,
        name: 'getSupportFiatInfo',
        inputs: [{ name: '_id', type: 'uint256' as const }],
        outputs: [
            {
                name: '',
                type: 'tuple' as const,
                components: [
                    { name: 'id', type: 'uint256' as const },
                    { name: 'fiatName', type: 'string' as const },
                    { name: 'assetType', type: 'uint8' as const },
                    { name: 'isActive', type: 'bool' as const },
                ],
            },
        ],
        stateMutability: 'view' as const,
    },
    {
        type: 'function' as const,
        name: 'getSupportCryptoList',
        inputs: [],
        outputs: [
            {
                name: '',
                type: 'tuple[]' as const,
                components: [
                    { name: 'id', type: 'uint256' as const },
                    { name: 'tokenSymbol', type: 'string' as const },
                    { name: 'tokenAddress', type: 'address' as const },
                    { name: 'assetType', type: 'uint8' as const },
                    { name: 'isActive', type: 'bool' as const },
                ],
            },
        ],
        stateMutability: 'view' as const,
    },
    {
        type: 'function' as const,
        name: 'getSupportFiatList',
        inputs: [],
        outputs: [
            {
                name: '',
                type: 'tuple[]' as const,
                components: [
                    { name: 'id', type: 'uint256' as const },
                    { name: 'fiatName', type: 'string' as const },
                    { name: 'assetType', type: 'uint8' as const },
                    { name: 'isActive', type: 'bool' as const },
                ],
            },
        ],
        stateMutability: 'view' as const,
    },
    {
        type: 'function' as const,
        name: 'getCryptoTokenAddress',
        inputs: [{ name: '_cryptoID', type: 'uint256' as const }],
        outputs: [{ name: '', type: 'address' as const }],
        stateMutability: 'view' as const,
    },
    {
        type: 'function' as const,
        name: 'merchants',
        inputs: [{ name: '', type: 'address' as const }],
        outputs: [
            { name: 'isActive', type: 'bool' as const },
            { name: 'kybVerified', type: 'bool' as const },
            { name: 'registeredAt', type: 'uint256' as const },
            { name: 'sellCryptoAmount', type: 'uint256' as const },
            { name: 'sellFiatAmount', type: 'uint256' as const },
        ],
        stateMutability: 'view' as const,
    },
    // ── Admin-only write functions ──────────────────────────────
    {
        type: 'function' as const,
        name: 'addCryptoInfo',
        inputs: [
            { name: '_tokenAddress', type: 'address' as const },
            { name: '_isActive', type: 'bool' as const },
        ],
        outputs: [],
        stateMutability: 'nonpayable' as const,
    },
    {
        type: 'function' as const,
        name: 'addFiatInfo',
        inputs: [
            { name: '_fiatName', type: 'string' as const },
            { name: '_isActive', type: 'bool' as const },
        ],
        outputs: [],
        stateMutability: 'nonpayable' as const,
    },
    {
        type: 'function' as const,
        name: 'activateAsset',
        inputs: [
            { name: '_id', type: 'uint256' as const },
            { name: '_assetType', type: 'uint8' as const },
        ],
        outputs: [],
        stateMutability: 'nonpayable' as const,
    },
    {
        type: 'function' as const,
        name: 'deactivateAsset',
        inputs: [
            { name: '_id', type: 'uint256' as const },
            { name: '_assetType', type: 'uint8' as const },
        ],
        outputs: [],
        stateMutability: 'nonpayable' as const,
    },
    // ── Merchant platform payment info ──
    {
        type: 'function' as const,
        name: 'setPlatformBinding',
        inputs: [
            { name: '_platformId', type: 'bytes32' as const },
            { name: '_nameHash',   type: 'bytes32' as const },
            { name: '_idHash',     type: 'bytes32' as const },
        ],
        outputs: [],
        stateMutability: 'nonpayable' as const,
    },
    {
        type: 'function' as const,
        name: 'getPlatformBinding',
        inputs: [
            { name: '_merchant',   type: 'address' as const },
            { name: '_platformId', type: 'bytes32' as const },
        ],
        outputs: [
            {
                name: '', type: 'tuple' as const,
                components: [
                    { name: 'nameHash', type: 'bytes32' as const },
                    { name: 'idHash',   type: 'bytes32' as const },
                    { name: 'isSet',    type: 'bool'    as const },
                ],
            },
        ],
        stateMutability: 'view' as const,
    },
    // ── Exchange rate ──
    {
        type: 'function' as const,
        name: 'publishRate',
        inputs: [
            { name: '_productId', type: 'uint256' as const },
            { name: '_assetType', type: 'uint8'   as const },
            { name: '_rate',      type: 'uint256' as const },
            { name: '_expiresAt', type: 'uint64'  as const },
        ],
        outputs: [],
        stateMutability: 'nonpayable' as const,
    },
    {
        type: 'function' as const,
        name: 'getMerchantRate',
        inputs: [
            { name: '_merchant',   type: 'address' as const },
            { name: '_productId',  type: 'uint256' as const },
            { name: '_assetType',  type: 'uint8'   as const },
        ],
        outputs: [
            {
                name: '', type: 'tuple' as const,
                components: [
                    { name: 'rate',        type: 'uint256' as const },
                    { name: 'version',     type: 'uint32'  as const },
                    { name: 'publishedAt', type: 'uint64'  as const },
                    { name: 'expiresAt',   type: 'uint64'  as const },
                ],
            },
        ],
        stateMutability: 'view' as const,
    },
    // ── Operating hours ──
    {
        type: 'function' as const,
        name: 'isMerchantOpen',
        inputs: [
            { name: '_merchant',   type: 'address' as const },
            { name: '_productId',  type: 'uint256' as const },
            { name: '_assetType',  type: 'uint8'   as const },
        ],
        outputs: [{ name: '', type: 'bool' as const }],
        stateMutability: 'view' as const,
    },
    {
        type: 'function' as const,
        name: 'setBusinessHours',
        inputs: [
            { name: '_productId',   type: 'uint256' as const },
            { name: '_assetType',   type: 'uint8'   as const },
            { name: '_openSecond',  type: 'uint32'  as const },
            { name: '_closeSecond', type: 'uint32'  as const },
            { name: '_activeDays',  type: 'uint8'   as const },
        ],
        outputs: [],
        stateMutability: 'nonpayable' as const,
    },
    {
        type: 'function' as const,
        name: 'openNow',
        inputs: [
            { name: '_productId', type: 'uint256' as const },
            { name: '_assetType', type: 'uint8'   as const },
        ],
        outputs: [],
        stateMutability: 'nonpayable' as const,
    },
    {
        type: 'function' as const,
        name: 'closeNow',
        inputs: [
            { name: '_productId', type: 'uint256' as const },
            { name: '_assetType', type: 'uint8'   as const },
        ],
        outputs: [],
        stateMutability: 'nonpayable' as const,
    },
    {
        type: 'function' as const,
        name: 'clearManualOverride',
        inputs: [
            { name: '_productId', type: 'uint256' as const },
            { name: '_assetType', type: 'uint8'   as const },
        ],
        outputs: [],
        stateMutability: 'nonpayable' as const,
    },
    // ── Global limits (Admin only) ──
    {
        type: 'function' as const,
        name: 'setMaxOrderAmount',
        inputs: [{ name: '_amount', type: 'uint256' as const }],
        outputs: [],
        stateMutability: 'nonpayable' as const,
    },
    {
        type: 'function' as const,
        name: 'maxOrderAmount',
        inputs: [],
        outputs: [{ name: '', type: 'uint256' as const }],
        stateMutability: 'view' as const,
    },
    // ── Access control (admin / two-step transfer / authorized callers) ──
    {
        type: 'function' as const,
        name: 'admin',
        inputs: [],
        outputs: [{ name: '', type: 'address' as const }],
        stateMutability: 'view' as const,
    },
    {
        type: 'function' as const,
        name: 'pendingAdmin',
        inputs: [],
        outputs: [{ name: '', type: 'address' as const }],
        stateMutability: 'view' as const,
    },
    {
        type: 'function' as const,
        name: 'proposeAdminTransfer',
        inputs: [{ name: 'newAdmin', type: 'address' as const }],
        outputs: [],
        stateMutability: 'nonpayable' as const,
    },
    {
        type: 'function' as const,
        name: 'acceptAdmin',
        inputs: [],
        outputs: [],
        stateMutability: 'nonpayable' as const,
    },
    {
        type: 'function' as const,
        name: 'setAuthorizedCaller',
        inputs: [
            { name: 'caller',  type: 'address' as const },
            { name: 'granted', type: 'bool'    as const },
        ],
        outputs: [],
        stateMutability: 'nonpayable' as const,
    },
    // ── Events ──
    {
        type: 'event' as const,
        name: 'MerchantRegistered',
        inputs: [
            { indexed: true,  name: 'merchant',     type: 'address' as const },
            { indexed: false, name: 'registeredAt', type: 'uint256' as const },
        ],
    },
] as const;

// ── C2CEscrow ABI ─────────────────────────────────────────────

export const C2C_ESCROW_ABI = [
    // ── placeOrder (V4: direct params, no EIP-712 signature) ──
    {
        type: 'function' as const,
        name: 'placeOrder',
        inputs: [
            { name: '_merchant',   type: 'address' as const },
            { name: '_productId',  type: 'uint256' as const },
            { name: '_assetType',  type: 'uint8'   as const },
            { name: '_amount',     type: 'uint256' as const },
            { ...buyerPaymentInfoTuple, name: '_buyerInfo' },
        ],
        outputs: [],
        stateMutability: 'nonpayable' as const,
    },
    // ── cancelOrder (V4: disabled, calling always reverts; kept for error handling) ──
    {
        type: 'function' as const,
        name: 'cancelOrder',
        inputs: [
            { name: '', type: 'address' as const },
            { name: '', type: 'uint256' as const },
            { name: '', type: 'uint8'   as const },
            { name: '', type: 'uint256' as const },
        ],
        outputs: [],
        stateMutability: 'pure' as const,
    },
    // ── CRYPTO product: buyer submits fiat payment proof ──
    {
        type: 'function' as const,
        name: 'payOrderByPlatform',
        inputs: [
            { name: '_merchant',  type: 'address'  as const },
            { name: '_productId', type: 'uint256'  as const },
            { name: '_orderId',   type: 'uint256'  as const },
            { name: 'proofs',     type: 'tuple[]'  as const,
              components: tlsnProofTuple.components },
        ],
        outputs: [],
        stateMutability: 'nonpayable' as const,
    },
    // ── FIAT product: merchant submits fiat payment proof ──
    {
        type: 'function' as const,
        name: 'receiveCryptoWithPlatformPayment',
        inputs: [
            { name: '_productId', type: 'uint256' as const },
            { name: '_orderId',   type: 'uint256' as const },
            { name: 'proofs',     type: 'tuple[]' as const,
              components: tlsnProofTuple.components },
        ],
        outputs: [],
        stateMutability: 'nonpayable' as const,
    },
    // ── Product management ──
    {
        type: 'function' as const,
        name: 'listCryptoProduct',
        inputs: [
            { name: '_cryptoID',   type: 'uint256' as const },
            { name: '_fiatID',     type: 'uint256' as const },
            { name: '_amount',     type: 'uint256' as const },
            { name: '_isActive',   type: 'bool'    as const },
            { name: '_platformId', type: 'bytes32' as const },
        ],
        outputs: [],
        stateMutability: 'nonpayable' as const,
    },
    {
        type: 'function' as const,
        name: 'listFiatProduct',
        inputs: [
            { name: '_fiatID',     type: 'uint256' as const },
            { name: '_cryptoID',   type: 'uint256' as const },
            { name: '_amount',     type: 'uint256' as const },
            { name: '_isActive',   type: 'bool'    as const },
            { name: '_platformId', type: 'bytes32' as const },
        ],
        outputs: [],
        stateMutability: 'nonpayable' as const,
    },
    {
        type: 'function' as const,
        name: 'activeProduct',
        inputs: [
            { name: '_id',        type: 'uint256' as const },
            { name: '_assetType', type: 'uint8'   as const },
        ],
        outputs: [],
        stateMutability: 'nonpayable' as const,
    },
    {
        type: 'function' as const,
        name: 'inactiveProduct',
        inputs: [
            { name: '_id',        type: 'uint256' as const },
            { name: '_assetType', type: 'uint8'   as const },
        ],
        outputs: [],
        stateMutability: 'nonpayable' as const,
    },
    {
        type: 'function' as const,
        name: 'addAmount',
        inputs: [
            { name: '_id',        type: 'uint256' as const },
            { name: '_assetType', type: 'uint8'   as const },
            { name: '_amount',    type: 'uint256' as const },
        ],
        outputs: [],
        stateMutability: 'nonpayable' as const,
    },
    {
        type: 'function' as const,
        name: 'takeAmount',
        inputs: [
            { name: '_id',        type: 'uint256' as const },
            { name: '_assetType', type: 'uint8'   as const },
            { name: '_amount',    type: 'uint256' as const },
        ],
        outputs: [],
        stateMutability: 'nonpayable' as const,
    },
    {
        type: 'function' as const,
        name: 'cleanupProductExpired',
        inputs: [
            { name: '_merchant',   type: 'address' as const },
            { name: '_productId',  type: 'uint256' as const },
            { name: '_assetType',  type: 'uint8'   as const },
        ],
        outputs: [],
        stateMutability: 'nonpayable' as const,
    },
    // ── Admin ──
    {
        type: 'function' as const,
        name: 'setManagers',
        inputs: [
            { name: '_riskManager', type: 'address' as const },
            { name: '_bondVault',   type: 'address' as const },
        ],
        outputs: [],
        stateMutability: 'nonpayable' as const,
    },
    // ── View functions ──
    {
        type: 'function' as const,
        name: 'getOrder',
        inputs: [
            { name: '_merchant',   type: 'address' as const },
            { name: '_productId',  type: 'uint256' as const },
            { name: '_assetType',  type: 'uint8'   as const },
            { name: '_orderId',    type: 'uint256' as const },
        ],
        outputs: [
            { name: 'buyer',            type: 'address' as const },
            { name: 'amount',           type: 'uint256' as const },
            { name: 'rate',             type: 'uint256' as const },
            { name: 'deadline',         type: 'uint256' as const },
            { name: 'status',           type: 'uint8'   as const },
            { name: 'rateVersion',      type: 'uint32'  as const },
            { name: 'platformTxId',     type: 'bytes32' as const },
            { name: 'merchantNameHash', type: 'bytes32' as const },
            { name: 'merchantIdHash',   type: 'bytes32' as const },
        ],
        stateMutability: 'view' as const,
    },
    {
        type: 'function' as const,
        name: 'getProductPlatformId',
        inputs: [
            { name: '_merchant',   type: 'address' as const },
            { name: '_productId',  type: 'uint256' as const },
            { name: '_assetType',  type: 'uint8'   as const },
        ],
        outputs: [{ name: '', type: 'bytes32' as const }],
        stateMutability: 'view' as const,
    },
    {
        type: 'function' as const,
        name: 'getBuyerPaymentInfo',
        inputs: [
            { name: '_merchant',  type: 'address' as const },
            { name: '_productId', type: 'uint256' as const },
            { name: '_orderId',   type: 'uint256' as const },
        ],
        outputs: [
            {
                name: '', type: 'tuple' as const,
                components: [
                    { name: 'nameHash', type: 'bytes32' as const },
                    { name: 'idHash',   type: 'bytes32' as const },
                    { name: 'isSet',    type: 'bool'    as const },
                ],
            },
        ],
        stateMutability: 'view' as const,
    },
    {
        type: 'function' as const,
        name: 'paused',
        inputs: [],
        outputs: [{ name: '', type: 'bool' as const }],
        stateMutability: 'view' as const,
    },
    {
        type: 'function' as const,
        name: 'getProductInfo',
        inputs: [
            { name: '_merchant',  type: 'address' as const },
            { name: '_productId', type: 'uint256' as const },
            { name: '_assetType', type: 'uint8'   as const },
        ],
        outputs: [
            {
                name: '', type: 'tuple' as const,
                components: [
                    { name: 'productId',        type: 'uint256'  as const },
                    { name: 'cryptoID',         type: 'uint256'  as const },
                    { name: 'fiatID',           type: 'uint256'  as const },
                    { name: 'assetType',        type: 'uint8'    as const },
                    { name: 'platformId',       type: 'bytes32'  as const },
                    { name: 'collateralAmount', type: 'uint256'  as const },
                    { name: 'pendingAmount',    type: 'uint256'  as const },
                    { name: 'availableAmount',  type: 'uint256'  as const },
                    { name: 'isActive',         type: 'bool'     as const },
                    { name: 'activeOrderCount', type: 'uint256'  as const },
                ],
            },
        ],
        stateMutability: 'view' as const,
    },
    {
        type: 'function' as const,
        name: 'hasActiveOrder',
        inputs: [
            { name: '_buyer',      type: 'address' as const },
            { name: '_merchant',   type: 'address' as const },
            { name: '_assetType',  type: 'uint8'   as const },
            { name: '_productId',  type: 'uint256' as const },
        ],
        outputs: [{ name: '', type: 'bool' as const }],
        stateMutability: 'view' as const,
    },
    // ── Events ──
    {
        type: 'event' as const,
        name: 'OrderPlaced',
        inputs: [
            { indexed: true,  name: 'buyer',      type: 'address' as const },
            { indexed: true,  name: 'merchant',   type: 'address' as const },
            { indexed: true,  name: 'orderId',    type: 'uint256' as const },
            { indexed: false, name: 'productId',  type: 'uint256' as const },
            { indexed: false, name: 'assetType',  type: 'uint8'   as const },
            { indexed: false, name: 'amount',     type: 'uint256' as const },
            { indexed: false, name: 'rate',       type: 'uint256' as const },
            { indexed: false, name: 'deadline',   type: 'uint256' as const },
            { indexed: false, name: 'salt',       type: 'uint256' as const },
        ],
    },
] as const;

// ── C2CRiskManager ABI ────────────────────────────────────────

export const C2C_RISK_MANAGER_ABI = [
    {
        type: 'function' as const,
        name: 'requiredBondBps',
        inputs: [{ name: 'user', type: 'address' as const }],
        outputs: [{ name: '', type: 'uint16' as const }],
        stateMutability: 'view' as const,
    },
    {
        type: 'function' as const,
        name: 'getReputation',
        inputs: [{ name: 'user', type: 'address' as const }],
        outputs: [
            {
                name: '', type: 'tuple' as const,
                components: [
                    { name: 'completedCount',            type: 'uint32' as const },
                    { name: 'timeoutCount',              type: 'uint32' as const },
                    { name: 'consecutiveTimeouts',       type: 'uint8'  as const },
                    { name: 'completedSinceLastTimeout', type: 'uint8'  as const },
                    { name: 'riskLevel',                 type: 'uint8'  as const },
                    { name: 'temporarilyFrozen',         type: 'bool'   as const },
                    { name: 'blacklisted',               type: 'bool'   as const },
                    { name: 'frozenUntil',               type: 'uint64' as const },
                    { name: 'lastTimeoutAt',             type: 'uint64' as const },
                ],
            },
        ],
        stateMutability: 'view' as const,
    },
    // ── Admin writes ──
    {
        type: 'function' as const,
        name: 'setBlacklist',
        inputs: [
            { name: 'user',  type: 'address' as const },
            { name: 'value', type: 'bool'    as const },
        ],
        outputs: [],
        stateMutability: 'nonpayable' as const,
    },
    {
        type: 'function' as const,
        name: 'manualUnfreeze',
        inputs: [{ name: 'user', type: 'address' as const }],
        outputs: [],
        stateMutability: 'nonpayable' as const,
    },
    {
        type: 'function' as const,
        name: 'setRiskConfig',
        inputs: [
            { name: '_min',             type: 'uint16' as const },
            { name: '_base',            type: 'uint16' as const },
            { name: '_max',             type: 'uint16' as const },
            { name: '_step',            type: 'uint16' as const },
            { name: '_reset',           type: 'uint8'  as const },
            { name: '_freezeThreshold', type: 'uint32' as const },
            { name: '_rewardThreshold', type: 'uint32' as const },
            { name: '_decayDays',       type: 'uint32' as const },
        ],
        outputs: [],
        stateMutability: 'nonpayable' as const,
    },
    // ── Config views ──
    {
        type: 'function' as const,
        name: 'minBondBps',
        inputs: [],
        outputs: [{ name: '', type: 'uint16' as const }],
        stateMutability: 'view' as const,
    },
    {
        type: 'function' as const,
        name: 'baseBondBps',
        inputs: [],
        outputs: [{ name: '', type: 'uint16' as const }],
        stateMutability: 'view' as const,
    },
    {
        type: 'function' as const,
        name: 'maxBondBps',
        inputs: [],
        outputs: [{ name: '', type: 'uint16' as const }],
        stateMutability: 'view' as const,
    },
    {
        type: 'function' as const,
        name: 'stepBps',
        inputs: [],
        outputs: [{ name: '', type: 'uint16' as const }],
        stateMutability: 'view' as const,
    },
    {
        type: 'function' as const,
        name: 'resetThreshold',
        inputs: [],
        outputs: [{ name: '', type: 'uint8' as const }],
        stateMutability: 'view' as const,
    },
    {
        type: 'function' as const,
        name: 'freezeThreshold',
        inputs: [],
        outputs: [{ name: '', type: 'uint32' as const }],
        stateMutability: 'view' as const,
    },
    {
        type: 'function' as const,
        name: 'rewardCompletedThreshold',
        inputs: [],
        outputs: [{ name: '', type: 'uint32' as const }],
        stateMutability: 'view' as const,
    },
    {
        type: 'function' as const,
        name: 'decayIntervalDays',
        inputs: [],
        outputs: [{ name: '', type: 'uint32' as const }],
        stateMutability: 'view' as const,
    },
] as const;

// ── C2CBondVault ABI ──────────────────────────────────────────

export const C2C_BOND_VAULT_ABI = [
    {
        type: 'function' as const,
        name: 'claim',
        inputs: [{ name: 'token', type: 'address' as const }],
        outputs: [{ name: '', type: 'uint256' as const }],
        stateMutability: 'nonpayable' as const,
    },
    {
        type: 'function' as const,
        name: 'claimableBalance',
        inputs: [
            { name: 'user',  type: 'address' as const },
            { name: 'token', type: 'address' as const },
        ],
        outputs: [{ name: '', type: 'uint256' as const }],
        stateMutability: 'view' as const,
    },
] as const;

// ── ERC20 ABI (full: balanceOf / allowance / approve / decimals / symbol) ───

export const ERC20_ABI = [
    {
        type: 'function' as const,
        name: 'balanceOf',
        inputs: [{ name: 'account', type: 'address' as const }],
        outputs: [{ name: '', type: 'uint256' as const }],
        stateMutability: 'view' as const,
    },
    {
        type: 'function' as const,
        name: 'allowance',
        inputs: [
            { name: 'owner',   type: 'address' as const },
            { name: 'spender', type: 'address' as const },
        ],
        outputs: [{ name: '', type: 'uint256' as const }],
        stateMutability: 'view' as const,
    },
    {
        type: 'function' as const,
        name: 'approve',
        inputs: [
            { name: 'spender', type: 'address' as const },
            { name: 'amount',  type: 'uint256' as const },
        ],
        outputs: [{ name: '', type: 'bool' as const }],
        stateMutability: 'nonpayable' as const,
    },
    {
        type: 'function' as const,
        name: 'decimals',
        inputs: [],
        outputs: [{ name: '', type: 'uint8' as const }],
        stateMutability: 'view' as const,
    },
    {
        type: 'function' as const,
        name: 'symbol',
        inputs: [],
        outputs: [{ name: '', type: 'string' as const }],
        stateMutability: 'view' as const,
    },
] as const;

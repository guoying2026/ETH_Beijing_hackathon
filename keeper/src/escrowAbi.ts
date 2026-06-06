/**
 * Minimal C2CEscrow ABI subset needed by the keeper.
 * Kept in-package (rather than imported from contracts/) to keep this
 * package shippable without a workspace dependency on the contracts package.
 */
export const escrowAbi = [
  {
    type: 'event',
    name: 'OrderPlaced',
    inputs: [
      { name: 'buyer', type: 'address', indexed: true },
      { name: 'merchant', type: 'address', indexed: true },
      { name: 'orderId', type: 'uint256', indexed: true },
      { name: 'productId', type: 'uint256', indexed: false },
      { name: 'assetType', type: 'uint8', indexed: false },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'rate', type: 'uint256', indexed: false },
      { name: 'deadline', type: 'uint256', indexed: false },
      { name: 'salt', type: 'uint256', indexed: false },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'OrderStatusChanged',
    inputs: [
      { name: 'buyer', type: 'address', indexed: true },
      { name: 'merchant', type: 'address', indexed: true },
      { name: 'orderId', type: 'uint256', indexed: true },
      { name: 'productId', type: 'uint256', indexed: false },
      { name: 'assetType', type: 'uint8', indexed: false },
      { name: 'status', type: 'uint8', indexed: false },
      { name: 'deadline', type: 'uint256', indexed: false },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'ExpiredSwept',
    inputs: [
      { name: 'caller', type: 'address', indexed: true },
      { name: 'merchant', type: 'address', indexed: true },
      { name: 'productId', type: 'uint256', indexed: true },
      { name: 'assetType', type: 'uint8', indexed: false },
      { name: 'cleanedCount', type: 'uint256', indexed: false },
    ],
    anonymous: false,
  },
  {
    type: 'function',
    name: 'paused',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'sweepExpired',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'merchant', type: 'address' },
      { name: 'productId', type: 'uint256' },
      { name: 'assetType', type: 'uint8' },
      { name: 'maxSteps', type: 'uint256' },
    ],
    outputs: [{ name: 'cleaned', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'sweepExpiredBatch',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'targets',
        type: 'tuple[]',
        components: [
          { name: 'merchant', type: 'address' },
          { name: 'productId', type: 'uint256' },
          { name: 'assetType', type: 'uint8' },
          { name: 'maxSteps', type: 'uint256' },
        ],
      },
    ],
    outputs: [{ name: 'totalCleaned', type: 'uint256' }],
  },
] as const;

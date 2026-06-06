import { keccak256, encodePacked } from "viem";

/**
 * Mirrors C2CEscrow._computeOrderBindingHash() exactly.
 * CRYPTO product → payeeNameHash = merchantNameHash, payeeIdHash = merchantIdHash
 * FIAT  product  → payeeNameHash = buyerNameHash,    payeeIdHash = buyerIdHash
 */
export function computeOrderBindingHash(p: {
  escrow:            `0x${string}`;
  chainId:           bigint;
  merchant:          `0x${string}`;
  buyer:             `0x${string}`;
  productId:         bigint;
  orderId:           bigint;
  assetType:         number; // 0 = CRYPTO, 1 = FIAT
  amount:            bigint;
  rate:              bigint;
  rateVersion:       bigint; // uint32 snapshot taken at placeOrder time
  deadline:          bigint;
  merchantNameHash:  `0x${string}`;
  merchantIdHash:    `0x${string}`;
  payeeNameHash:     `0x${string}`;
  payeeIdHash:       `0x${string}`;
}): `0x${string}` {
  return keccak256(
    encodePacked(
      [
        "address", "uint64",
        "address", "address",
        "uint256", "uint256",
        "uint8",   "uint256", "uint256", "uint32", "uint256",
        "bytes32", "bytes32",
        "bytes32", "bytes32",
      ],
      [
        p.escrow,      p.chainId,
        p.merchant,    p.buyer,
        p.productId,   p.orderId,
        p.assetType,   p.amount, p.rate, p.rateVersion, p.deadline,
        p.merchantNameHash, p.merchantIdHash,
        p.payeeNameHash,    p.payeeIdHash,
      ],
    ),
  );
}

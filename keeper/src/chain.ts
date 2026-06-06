import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  webSocket,
  type Chain,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { KeeperConfig } from './config.js';

/** Build an anonymous viem Chain definition from the keeper config. */
export function makeChain(cfg: KeeperConfig): Chain {
  return defineChain({
    id: cfg.chainId,
    name: `keeper-chain-${cfg.chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: {
      default: { http: [cfg.rpcUrlHttp], webSocket: [cfg.rpcUrlWs] },
    },
  });
}

/** Bundle of viem clients used by the keeper. */
export interface ChainClients {
  chain: Chain;
  publicClient: PublicClient;
  /** Same as publicClient but bound to the WebSocket transport for event watching. */
  wsClient: PublicClient;
  walletClient: WalletClient;
  keeperAddress: `0x${string}`;
}

/** Construct HTTP + WS public clients and the keeper-signed wallet client. */
export function makeClients(cfg: KeeperConfig): ChainClients {
  const chain = makeChain(cfg);
  const account = privateKeyToAccount(cfg.keeperPrivateKey);

  const publicClient = createPublicClient({ chain, transport: http(cfg.rpcUrlHttp) });
  const wsClient = createPublicClient({ chain, transport: webSocket(cfg.rpcUrlWs) });
  const walletClient = createWalletClient({ account, chain, transport: http(cfg.rpcUrlHttp) });

  return {
    chain,
    publicClient,
    wsClient,
    walletClient,
    keeperAddress: account.address,
  };
}

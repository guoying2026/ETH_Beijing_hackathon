import { formatUnits } from "viem";
import { network } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  // 1. 读取父目录中的 .env 文件获取 Token 地址
  const envPath = path.resolve(__dirname, "../../.env");
  let usdtAddr = "";
  let usdcAddr = "";
  let daiAddr = "";

  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, "utf-8");
    
    // 解析具体的 token 地址
    envContent.split("\n").forEach(line => {
      const parts = line.split("=");
      if (parts.length === 2) {
        const key = parts[0].trim();
        const val = parts[1].trim();
        if (key === "VITE_USDT_ADDRESS") usdtAddr = val;
        if (key === "VITE_USDC_ADDRESS") usdcAddr = val;
        if (key === "VITE_DAI_ADDRESS") daiAddr = val;
      }
    });
  }

  console.log("Token Addresses from .env:");
  console.log(`  USDT: ${usdtAddr || "Not Found"}`);
  console.log(`  USDC: ${usdcAddr || "Not Found"}`);
  console.log(`  DAI:  ${daiAddr || "Not Found"}\n`);

  // 2. 连接网络并获取 viem 实例
  const { viem } = await network.connect();
  const walletClients = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  const labels = [
    "Admin (deployer)",
    "Merchant 1",
    "Merchant 2",
    "Merchant 3",
    "User 1",
    "User 2",
    "User 3",
    "User 4",
    "User 5",
    "VerifierSigner"
  ];

  console.log("==================== Account Balances ====================");

  for (let i = 0; i < Math.min(walletClients.length, labels.length); i++) {
    const client = walletClients[i];
    const address = client.account.address;
    const label = labels[i];

    // 查询 ETH 余额
    const ethBalance = await publicClient.getBalance({ address });

    // 查询 Token 余额
    let usdtBal = "0";
    let usdcBal = "0";
    let daiBal = "0";

    if (usdtAddr) {
      try {
        const bal = await publicClient.readContract({
          address: usdtAddr as `0x${string}`,
          abi: [{
            name: "balanceOf",
            type: "function",
            inputs: [{ name: "account", type: "address" }],
            outputs: [{ name: "", type: "uint256" }],
            stateMutability: "view"
          }],
          functionName: "balanceOf",
          args: [address]
        }) as bigint;
        usdtBal = formatUnits(bal, 18);
      } catch (e) {}
    }

    if (usdcAddr) {
      try {
        const bal = await publicClient.readContract({
          address: usdcAddr as `0x${string}`,
          abi: [{
            name: "balanceOf",
            type: "function",
            inputs: [{ name: "account", type: "address" }],
            outputs: [{ name: "", type: "uint256" }],
            stateMutability: "view"
          }],
          functionName: "balanceOf",
          args: [address]
        }) as bigint;
        usdcBal = formatUnits(bal, 6);
      } catch (e) {}
    }

    if (daiAddr) {
      try {
        const bal = await publicClient.readContract({
          address: daiAddr as `0x${string}`,
          abi: [{
            name: "balanceOf",
            type: "function",
            inputs: [{ name: "account", type: "address" }],
            outputs: [{ name: "", type: "uint256" }],
            stateMutability: "view"
          }],
          functionName: "balanceOf",
          args: [address]
        }) as bigint;
        daiBal = formatUnits(bal, 18);
      } catch (e) {}
    }

    console.log(`[${label}] - ${address}`);
    console.log(`  ETH:  ${formatUnits(ethBalance, 18)} ETH`);
    console.log(`  USDT: ${usdtBal} USDT`);
    console.log(`  USDC: ${usdcBal} USDC`);
    console.log(`  DAI:  ${daiBal} DAI`);
    console.log("----------------------------------------------------------");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

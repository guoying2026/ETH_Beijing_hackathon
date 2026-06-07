import { keccak256, stringToBytes } from "viem";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  const escrowPath = path.join(__dirname, "../artifacts/contracts/C2CEscrow.sol/C2CEscrow.json");
  let targetSig = "0x0e0c8dd3";
  
  // 兼容可能带有 0x 前缀或没有的情况
  if (!targetSig.startsWith("0x")) {
    targetSig = "0x" + targetSig;
  }
  targetSig = targetSig.toLowerCase();

  let found = false;

  const checkAbi = (abi: any[], fileName: string) => {
    for (const item of abi) {
      if (item.type === "error") {
        const signatureStr = `${item.name}(${item.inputs.map((input: any) => input.type).join(",")})`;
        const hash = keccak256(stringToBytes(signatureStr));
        const sig = hash.slice(0, 10).toLowerCase();
        if (sig === targetSig) {
          console.log(`🎉 Found match in ${fileName}: ${signatureStr} has signature ${sig}`);
          found = true;
        }
      }
    }
  };

  if (fs.existsSync(escrowPath)) {
    const escrowArtifact = JSON.parse(fs.readFileSync(escrowPath, "utf8"));
    checkAbi(escrowArtifact.abi, "C2CEscrow.json");
  }

  const artifactsContractsDir = path.join(__dirname, "../artifacts/contracts");
  if (fs.existsSync(artifactsContractsDir)) {
    const scanDir = (dir: string) => {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        const fullPath = path.join(dir, file);
        if (fs.statSync(fullPath).isDirectory()) {
          scanDir(fullPath);
        } else if (file.endsWith(".json") && !file.endsWith(".dbg.json")) {
          try {
            const artifact = JSON.parse(fs.readFileSync(fullPath, "utf8"));
            if (artifact.abi) {
              checkAbi(artifact.abi, file);
            }
          } catch (e) {
            // Ignore parse errors
          }
        }
      }
    };
    scanDir(artifactsContractsDir);
  }

  if (!found) {
    console.log(`❌ No match found for signature ${targetSig}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

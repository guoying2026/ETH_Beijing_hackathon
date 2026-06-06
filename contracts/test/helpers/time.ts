import type { TestClient } from "viem";

export async function advanceTime(
  testClient: TestClient,
  seconds: number,
) {
  await testClient.increaseTime({ seconds });
  await testClient.mine({ blocks: 1 });
}

import * as yargs from "yargs";
import { builder, nodeWithComputedArgv } from "../../util/node";

export const command = "node";
export const aliases = [];
export const describe = "Run a mangrove node";

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types

type Arguments = ReturnType<typeof builder>["argv"];

export { builder };

export async function handler(argv: Arguments): Promise<void> {
  const { spawnEndedPromise } = await (
    await nodeWithComputedArgv({
      ...(await argv),
      pipe: true,
    })
  ).connect();
  if (spawnEndedPromise) {
    console.log("Node ready.");
    await spawnEndedPromise;
  }
}

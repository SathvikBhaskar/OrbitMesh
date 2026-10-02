import { PilotRunner } from "./runners/pilot-runner";

async function main() {
  const runner = new PilotRunner();
  await runner.runPilot1();
}

main().catch(console.error).finally(() => process.exit(0));

import "dotenv/config";
import { runAllScenarios } from "../lib/scenarios";

async function main() {
  const results = await runAllScenarios();
  for (const result of results) {
    console.log(`\n=== ${result.name} ===`);
    for (const step of result.steps) {
      console.log(`[${step.label}] ${step.detail}`);
    }
    console.log(`Result: ${result.ok ? "OK" : "FAILED"}`);
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error(`\n${failed.length} scenario(s) failed.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

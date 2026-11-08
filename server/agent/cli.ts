import { buildBrief, DEFAULT_GOAL } from "./brief.js";
import { runAgent } from "./autonomous.js";

const goal = process.argv.slice(2).join(" ") || DEFAULT_GOAL;
const brief = await buildBrief();
console.log("BRIEF\n" + brief + "\n");
const run = await runAgent(goal, brief);
for (const s of run.steps) console.log(`#${s.n} ${s.action} ${JSON.stringify(s.args).slice(0, 120)}\n   ${s.thought.slice(0, 200)}\n   → ${s.result.split("\n")[0].slice(0, 160)}`);
console.log(`\nSTATUS ${run.status}  files ${run.filesChanged.join(", ") || "-"}  commit ${run.commit ?? "-"}`);
for (const g of run.gates) console.log(`gate ${g.name}: ${g.passed ? "pass" : "FAIL"}`);
console.log(`summary: ${run.summary}`);
process.exit(0);

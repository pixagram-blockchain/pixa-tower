#!/usr/bin/env node
// Regenerate docs/METRICS.md from the metric catalogue (packages/core/src/metrics.ts).
//   node --experimental-strip-types scripts/gen-metrics-doc.mjs
import { writeFileSync } from "node:fs";
const { METRICS } = await import("../packages/core/src/metrics.ts");

const sections = {
  accounts: "Accounts and activity", content: "Content", votes: "Votes and controversy", rewards: "Rewards",
  economy: "Economy and supply", governance: "Governance", portals: "Portals", chain: "Chain health", social: "Social graph", security: "Security",
};
const kinds = {
  counter: "counted per hour; day, week and month are sums",
  range: "computed over each period directly (distinct counts, ratios, peaks)",
  daily: "computed once per closed day (cohort metrics per week)",
  gauge: "snapshot every 5 minutes; each period keeps its last value",
};
let md = `# Metric reference\n\nGenerated from \`packages/core/src/metrics.ts\` (${METRICS.length} metrics). Read any of them at \`GET /v1/metrics/{id}?grain=…\`.\n\nKinds: ${Object.entries(kinds).map(([k, v]) => `**${k}**, ${v}`).join("; ")}.\n`;
for (const [key, title] of Object.entries(sections)) {
  const list = METRICS.filter((m) => m.section === key);
  if (!list.length) continue;
  md += `\n## ${title}\n\n| id | Metric | Unit | Kind | Grains | Definition |\n| --- | --- | --- | --- | --- | --- |\n`;
  for (const m of list) md += `| \`${m.id}\` | ${m.title} | ${m.unit} | ${m.kind} | ${m.grains.join(", ")} | ${m.description.replace(/\|/g, "\\|")} |\n`;
}
writeFileSync(new URL("../docs/METRICS.md", import.meta.url), md);
console.log(`docs/METRICS.md: ${METRICS.length} metrics`);

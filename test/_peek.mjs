/** Read a view: node _peek.mjs [--demo] method arg... */
import { readFileSync } from "node:fs";
import { connect } from "./harness.mjs";
const dep = JSON.parse(readFileSync(new URL("../deployments.json", import.meta.url))).deployments.studiodev;
const demo = process.argv.includes("--demo");
const c = connect({ address: process.env.ADDR ?? (demo ? dep.PoolRiskDemo : dep.PoolRisk).address, role: "trigger" });
const [m, ...a] = process.argv.slice(2).filter((x) => x !== "--demo");
const v = await c.view(m, a.map((x) => (/^\d+$/.test(x) ? Number(x) : x)));
const plain = (x) => (typeof x === "bigint" ? x.toString() : x instanceof Map ? Object.fromEntries(x) : x);
console.log(typeof v === "string" ? v : JSON.stringify(v, (k, x) => plain(x), 1));

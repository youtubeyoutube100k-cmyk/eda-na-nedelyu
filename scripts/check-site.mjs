import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const path = fileURLToPath(new URL("../index.html", import.meta.url));
const html = readFileSync(path, "utf8");
const scripts = [...html.matchAll(/<script(?:\\s[^>]*)?>([\\s\\S]*?)<\\/script>/gi)]
  .filter((match) => !/\\bsrc\\s*=/.test(match[0].slice(0, match[0].indexOf(">"))))
  .map((match) => match[1])
  .filter((body) => body.trim());

for (const [index, source] of scripts.entries()) {
  // Compile only; browser globals are not evaluated.
  new Function(source);
  console.log(`Inline script ${index + 1}: syntax OK`);
}

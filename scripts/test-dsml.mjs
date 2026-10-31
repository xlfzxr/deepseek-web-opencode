import { parseToolCallFromText } from "../src/server.mjs";

const FW = String.fromCharCode(0xff5c);
const tools = [
  { kind: "function", name: "get_weather", wireName: "get_weather" },
  { kind: "custom", name: "run_shell", wireName: "run_shell" },
];

let failures = 0;

function check(name, actual, expected) {
  if (actual === expected) {
    console.log("ok   - " + name);
    return;
  }
  failures += 1;
  console.error("FAIL - " + name);
  console.error("  expected: " + expected);
  console.error("  actual:   " + actual);
}

function argsOf(text) {
  const call = parseToolCallFromText(text, tools);
  return call ? call.arguments : null;
}

function mk(pipe, name, key, value) {
  const o = "<" + pipe + "DSML" + pipe + "invoke name=\"" + name + "\">";
  const p = "<" + pipe + "DSML" + pipe + "parameter name=\"" + key + "\" string=\"true\">";
  const p2 = "</" + pipe + "DSML" + pipe + "parameter>";
  const c = "</" + pipe + "DSML" + pipe + "invoke>";
  return o + p + value + p2 + c;
}

check("dsml canonical", argsOf(mk("|", "get_weather", "city", "Jakarta")), "{\"city\":\"Jakarta\"}");
check("dsml fullwidth pipes", argsOf(mk(FW, "get_weather", "city", "Bandung")), "{\"city\":\"Bandung\"}");

const plain = "<invoke name=\"get_weather\">";
const prm = "<parameter name=\"city\" string=\"true\">Surabaya</parameter>";
check("dsml no wrapper", argsOf(plain + prm + "</invoke>"), "{\"city\":\"Surabaya\"}");

const jsonVal = "{\"unit\":\"C\"}";
const typed = mk("|", "get_weather", "opts", jsonVal);
const typedCall = parseToolCallFromText(
  typed.replace("string=\"true\"", "string=\"false\""),
  tools,
);
check("dsml string=false json", typedCall ? typedCall.arguments : null, "{\"opts\":{\"unit\":\"C\"}}");

check("dsml custom tool", argsOf(mk("|", "run_shell", "input", "ls -la")), "ls -la");

const xml = "<tool_call name=\"get_weather\" id=\"c1\">{\"city\":\"Medan\"}</tool_call>";
check("xml tool_call", argsOf(xml), "{\"city\":\"Medan\"}");

const fenced = "```json\n{\"name\":\"get_weather\",\"arguments\":{\"city\":\"Bogor\"}}\n```";
check("fenced json", argsOf(fenced), "{\"city\":\"Bogor\"}");

check("plain text returns null", parseToolCallFromText("hello there", tools), null);
check("empty returns null", parseToolCallFromText("", tools), null);

if (failures) {
  console.error("\ndsml tests failed: " + failures);
  process.exit(1);
}
console.log("\ndsml tests passed");

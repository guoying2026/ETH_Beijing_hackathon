import fs from "node:fs";
import path from "node:path";

const cwd = process.cwd();
const LOG_PATH = path.join(cwd, "all-tests-output-rerun.log");
const SPEC_PATH = path.join(cwd, "C2C_TEST_CASES_REGENERATED.md");
const TEST_DIR = path.join(cwd, "test");
const OUT_PATH = path.join(cwd, "TEST_RESULTS.md");

const SUITE_ORDER = [
  "C2CAdmin",
  "C2CEscrow",
  "AlipayPlatformVerifier",
  "WisePlatformVerifier",
  "Integration — 跨合约联动",
  "BusinessHours",
  "Cap",
  "Rate",
  "TLSNVerifier",
];

const SUITE_CODE = {
  AlipayPlatformVerifier: "ALI",
  BusinessHours: "BH",
  C2CAdmin: "ADM",
  C2CEscrow: "ESC",
  Cap: "CAP",
  "Integration — 跨合约联动": "INT",
  Rate: "RATE",
  TLSNVerifier: "TLSN",
  WisePlatformVerifier: "WISE",
};

const TABLE_TITLE_TO_SUITE = [
  ["AlipayPlatform", "AlipayPlatformVerifier"],
  ["C2CAdmin", "C2CAdmin"],
  ["C2CEscrow", "C2CEscrow"],
  ["Integration", "Integration — 跨合约联动"],
  ["WisePlatform", "WisePlatformVerifier"],
];

const KNOWN_SUITES = new Set(SUITE_ORDER);

function readTextSmart(filePath) {
  const buf = fs.readFileSync(filePath);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.toString("utf16le").replace(/\u0000/g, "");
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.toString("utf8").replace(/\u0000/g, "");
  }
  const utf8 = buf.toString("utf8");
  if (utf8.includes("\u0000")) {
    return buf.toString("utf16le").replace(/\u0000/g, "");
  }
  return utf8.replace(/\u0000/g, "");
}

function splitLines(s) {
  return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

function escapePipes(s) {
  return String(s).replace(/\|/g, "\\|");
}

function fmtMs(v) {
  return v === null || v === undefined ? "—" : String(v);
}

function fmtGas(v) {
  return v === null || v === undefined ? "—" : Number(v).toLocaleString("en-US");
}

function normalizeSpace(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

function stripMd(s) {
  return normalizeSpace(String(s).replace(/`/g, "").replace(/\*\*/g, ""));
}

function parseIdAndDesc(testName) {
  const m = testName.match(/^([A-Z]+(?:-[A-Z0-9]+)*-\d+)(\s+\([^)]*\))?:\s*(.+)$/u);
  if (!m) return null;
  const qualifier = (m[2] ?? "").trim();
  const desc = qualifier ? `${qualifier} ${m[3]}` : m[3];
  return { id: m[1], desc };
}

function detectTopSuite(headingByIndent) {
  const entries = [...headingByIndent.entries()].sort((a, b) => a[0] - b[0]);
  for (const [, value] of entries) {
    if (KNOWN_SUITES.has(value)) return value;
  }
  return null;
}

function parseNumberCell(s) {
  const t = String(s ?? "").trim();
  if (!t || t === "—" || t === "-") return null;
  const n = Number(t.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function parseLog(logText) {
  const lines = splitLines(logText);
  const startIdx = lines.findIndex((l) => l.includes("Running node:test tests"));
  const summaryIdx = lines.findIndex((l, i) => i > startIdx && /^\s*\d+\s+passing\s+\(\d+\s+nodejs\)\s*$/u.test(l));
  if (startIdx < 0 || summaryIdx < 0) {
    throw new Error("Failed to locate node:test run section in log");
  }

  const suites = new Map();
  const headingByIndent = new Map();
  const failCasesInOrder = [];

  function ensureSuite(name) {
    if (!suites.has(name)) {
      suites.set(name, {
        name,
        cases: [],
        keySet: new Set(),
        autoCounter: 0,
      });
    }
    return suites.get(name);
  }

  for (let i = startIdx; i < summaryIdx; i += 1) {
    const line = lines[i];

    const passMatch = line.match(/^(\s*)[✔✓]\s+(.+?)(?:\s+\((\d+)ms\))?\s*$/u);
    if (passMatch) {
      const testName = passMatch[2].trim();
      const totalMs = passMatch[3] ? Number(passMatch[3]) : null;
      const suiteName = detectTopSuite(headingByIndent) ?? "UnknownSuite";
      const suite = ensureSuite(suiteName);
      const key = `pass::${testName}`;
      if (suite.keySet.has(key)) continue;
      suite.keySet.add(key);

      const parsed = parseIdAndDesc(testName);
      if (!parsed) suite.autoCounter += 1;
      suite.cases.push({
        suite: suiteName,
        testName,
        id: parsed?.id ?? `${SUITE_CODE[suiteName] ?? "CASE"}-${String(suite.autoCounter).padStart(2, "0")}`,
        desc: parsed?.desc ?? testName,
        pass: true,
        totalMs,
        verifyMs: null,
        gasUsed: null,
        failIndex: null,
        failBlock: "",
        failReason: null,
      });
      continue;
    }

    const failListingMatch = line.match(/^(\s*)(\d+)\)\s+(.+?)\s*$/u);
    if (failListingMatch) {
      const failIndex = Number(failListingMatch[2]);
      const testName = failListingMatch[3].trim();
      const suiteName = detectTopSuite(headingByIndent) ?? "UnknownSuite";
      const suite = ensureSuite(suiteName);
      const key = `fail::${testName}`;
      if (suite.keySet.has(key)) continue;
      suite.keySet.add(key);

      const parsed = parseIdAndDesc(testName);
      if (!parsed) suite.autoCounter += 1;
      const rec = {
        suite: suiteName,
        testName,
        id: parsed?.id ?? `${SUITE_CODE[suiteName] ?? "CASE"}-${String(suite.autoCounter).padStart(2, "0")}`,
        desc: parsed?.desc ?? testName,
        pass: false,
        totalMs: null,
        verifyMs: null,
        gasUsed: null,
        failIndex,
        failBlock: "",
        failReason: null,
      };
      suite.cases.push(rec);
      failCasesInOrder.push(rec);
      continue;
    }

    if (/[┌┬┐├┼┤└┴┘│═]/u.test(line)) continue;
    if (/^\s*$/.test(line)) continue;

    const headingMatch = line.match(/^(\s{2,})([^ ].*)$/u);
    if (!headingMatch) continue;

    const indent = headingMatch[1].length;
    const text = headingMatch[2].trim();

    if (!text || text.startsWith("总计:")) continue;
    if (text.endsWith("测试报告")) continue;
    if (text.includes("No contracts to compile")) continue;
    if (/^\d+\s+passing/u.test(text) || /^\d+\s+failing/u.test(text)) continue;

    for (const k of [...headingByIndent.keys()]) {
      if (k >= indent) headingByIndent.delete(k);
    }
    headingByIndent.set(indent, text);
  }

  // Attach tableReporter metrics (verifyMs/gas/totalMs) by suite order.
  const tableMetricsBySuite = new Map();
  let currentTableSuite = null;
  for (const line of lines) {
    const titleMatch = line.match(/^\s{2}(.+测试报告)\s*$/u);
    if (titleMatch) {
      currentTableSuite = null;
      for (const [needle, suiteName] of TABLE_TITLE_TO_SUITE) {
        if (titleMatch[1].includes(needle)) {
          currentTableSuite = suiteName;
          if (!tableMetricsBySuite.has(suiteName)) tableMetricsBySuite.set(suiteName, []);
          break;
        }
      }
      continue;
    }

    if (!currentTableSuite) continue;
    if (!line.trim().startsWith("│")) continue;
    if (line.includes("测试内容") || line.includes("----")) continue;

    const cells = line.split("│").map((c) => c.trim());
    if (cells.length < 8) continue;

    const totalMs = parseNumberCell(cells[4]);
    const verifyMs = parseNumberCell(cells[5]);
    const gasUsed = parseNumberCell(cells[6]);
    const pass = cells[3] === "✅";
    tableMetricsBySuite.get(currentTableSuite).push({ totalMs, verifyMs, gasUsed, pass });
  }

  for (const [suiteName, suite] of suites.entries()) {
    const metrics = tableMetricsBySuite.get(suiteName);
    if (!metrics || metrics.length === 0) continue;
    const n = Math.min(metrics.length, suite.cases.length);
    for (let i = 0; i < n; i += 1) {
      suite.cases[i].totalMs = metrics[i].totalMs;
      suite.cases[i].verifyMs = metrics[i].verifyMs;
      suite.cases[i].gasUsed = metrics[i].gasUsed;
    }
  }

  // Parse failure detail blocks by failure index.
  const detailMap = new Map();
  for (let i = summaryIdx + 1; i < lines.length; i += 1) {
    const m = lines[i].match(/^\s*(\d+)\)\s+(.+)\s*$/u);
    if (!m) continue;
    const idx = Number(m[1]);
    const blockLines = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      if (/^\s*\d+\)\s+.+$/u.test(lines[j])) break;
      blockLines.push(lines[j]);
    }
    detailMap.set(idx, blockLines.join("\n"));
  }

  for (const rec of failCasesInOrder) {
    const block = detailMap.get(rec.failIndex) ?? "";
    rec.failBlock = block;
    const firstErr = splitLines(block).map((l) => l.trim()).find(
      (l) =>
        /^(AssertionError|ContractFunctionExecutionError|HardhatError|TypeError|Error):/u.test(l),
    );
    rec.failReason = firstErr ?? "见失败详情";
  }

  const passingLine = lines[summaryIdx] ?? "";
  const failingLine = lines[summaryIdx + 1] ?? "";
  const passSummary = Number((passingLine.match(/^\s*(\d+)\s+passing/u) ?? [])[1] ?? 0);
  const failSummary = Number((failingLine.match(/^\s*(\d+)\s+failing/u) ?? [])[1] ?? 0);

  return { suites, passSummary, failSummary };
}

function parseMarkdownTables(mdText) {
  const lines = splitLines(mdText);
  const tables = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].trim().startsWith("|")) continue;
    if (i + 1 >= lines.length) continue;
    if (!lines[i + 1].trim().startsWith("|")) continue;
    if (!/\|[-: ]+\|/.test(lines[i + 1])) continue;

    const header = lines[i].split("|").slice(1, -1).map((c) => c.trim());
    const rows = [];
    let j = i + 2;
    while (j < lines.length && lines[j].trim().startsWith("|")) {
      const row = lines[j].split("|").slice(1, -1).map((c) => c.trim());
      if (row.length === header.length) rows.push(row);
      j += 1;
    }
    tables.push({ header, rows });
    i = j - 1;
  }
  return tables;
}

function expandIdCell(idCell) {
  const raw = stripMd(idCell);
  if (!raw) return [];
  if (/^ID$/i.test(raw)) return [];

  const direct = raw.match(/^([A-Z]+-[A-Z0-9]+-\d+)$/u);
  if (direct) return [direct[1]];

  const slashPair = raw.match(/^([A-Z]+-[A-Z0-9]+-)(\d+)\s*\/\s*(\d+)$/u);
  if (slashPair) {
    const p = slashPair[1];
    const a = slashPair[2].padStart(2, "0");
    const b = slashPair[3].padStart(2, "0");
    return [`${p}${a}`, `${p}${b}`];
  }

  return [];
}

function normalizeRevertReason(reasonText) {
  let reason = normalizeSpace(reasonText);

  // Canonicalize common wrappers so revert("x"), Error("x"), and plain "x" compare equally.
  const wrapped = reason.match(/^(?:revert|error)\s*\(\s*(?:"([^"]+)"|'([^']+)')\s*\)$/iu);
  if (wrapped) {
    reason = normalizeSpace(wrapped[1] ?? wrapped[2] ?? "");
  }

  reason = reason.replace(/^execution reverted:\s*/iu, "");
  return reason;
}

function normalizeExpectedFromSpec(rawExpected, knownErrorTokens) {
  const text = stripMd(rawExpected);
  if (!text) return null;

  const bt = [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim()).filter(Boolean);
  const errorLike = bt.filter((t) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(t));
  if (errorLike.length === 1) return `触发 ${errorLike[0]}`;
  if (errorLike.length > 1) return `触发 ${errorLike.join(" / ")}`;

  const pureToken = text.match(/^([A-Za-z_][A-Za-z0-9_]*)$/u);
  if (pureToken) {
    const t = pureToken[1];
    if (knownErrorTokens.has(t) || t === "NotWaiting") {
      return `触发 ${t}`;
    }
  }

  const tokenInText = [...text.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\b/gu)]
    .map((m) => m[1])
    .find((t) => knownErrorTokens.has(t));
  if (tokenInText && /当前实现|实际行为|行为确认|预期错误|防御/u.test(text)) {
    return `触发 ${tokenInText}`;
  }

  if (/(成功|可通过|允许通过|完整完成|通过|succeed|succeeds|always open)/iu.test(text)) {
    return "成功";
  }

  const wrappedRevert = text.match(/^revert\s*\(\s*(?:"([^"]+)"|'([^']+)')\s*\)$/iu);
  if (wrappedRevert) return `revert: ${normalizeRevertReason(wrappedRevert[1] ?? wrappedRevert[2])}`;

  if (/revert\(/iu.test(text)) return `revert: ${text}`;
  return text;
}

function parseSpecExpectedMap(specText, knownErrorTokens) {
  const tables = parseMarkdownTables(specText);
  const expectedById = new Map();

  for (const t of tables) {
    const idIdx = t.header.findIndex((h) => h === "ID");
    if (idIdx < 0) continue;
    const expIdx = t.header.findIndex((h) => h.includes("预期"));
    if (expIdx < 0) continue;

    for (const row of t.rows) {
      const ids = expandIdCell(row[idIdx] ?? "");
      if (ids.length === 0) continue;
      const normalized = normalizeExpectedFromSpec(row[expIdx] ?? "", knownErrorTokens);
      if (!normalized) continue;
      for (const id of ids) {
        if (!expectedById.has(id)) expectedById.set(id, normalized);
      }
    }
  }

  return expectedById;
}

function findMatchingBrace(text, openBraceIndex) {
  let i = openBraceIndex;
  let depth = 0;
  let inS = false;
  let inD = false;
  let inT = false;
  let inLineComment = false;
  let inBlockComment = false;

  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1] ?? "";

    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      i += 1;
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }

    if (!inS && !inD && !inT) {
      if (ch === "/" && next === "/") {
        inLineComment = true;
        i += 2;
        continue;
      }
      if (ch === "/" && next === "*") {
        inBlockComment = true;
        i += 2;
        continue;
      }
    }

    if (!inD && !inT && ch === "'" && text[i - 1] !== "\\") {
      inS = !inS;
      i += 1;
      continue;
    }
    if (!inS && !inT && ch === "\"" && text[i - 1] !== "\\") {
      inD = !inD;
      i += 1;
      continue;
    }
    if (!inS && !inD && ch === "`" && text[i - 1] !== "\\") {
      inT = !inT;
      i += 1;
      continue;
    }

    if (inS || inD || inT) {
      i += 1;
      continue;
    }

    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }

  return -1;
}

function inferOutcomeFromBody(body) {
  const candidates = [];

  const inferOutcomeFromRegexSource = (regexSource) => {
    const source = String(regexSource ?? "").replace(/\\\|/g, "|");
    if (!source) return null;

    // If a regex literal contains explicit custom error names, normalize to "触发 ...".
    // Example: /(NotMerchant|0x3b6405f4)/ -> "触发 NotMerchant"
    const tokens = [...source.matchAll(/\b([A-Z][A-Za-z0-9_]+)\b/g)]
      .map((m) => m[1])
      .filter(Boolean);
    const uniq = [...new Set(tokens)];
    if (uniq.length === 0) return null;
    if (uniq.length === 1) return `触发 ${uniq[0]}`;
    return `触发 ${uniq.join(" / ")}`;
  };

  const mCustom = /revertWithCustomError\([\s\S]*?,\s*[^,]+,\s*(?:"([^"]+)"|'([^']+)')/u.exec(body);
  if (mCustom) {
    const token = mCustom[1] ?? mCustom[2];
    candidates.push({ idx: mCustom.index, outcome: `触发 ${token}` });
  }

  const mExpectRevert = /expectRevert(?:Tracked)?\([\s\S]*?,\s*(?:"([^"]+)"|'([^']+)'|\/([^/]+)\/[gimsuy]*)/u.exec(body);
  if (mExpectRevert) {
    const s = mExpectRevert[1] ?? mExpectRevert[2];
    const r = mExpectRevert[3];
    const inferred = r ? inferOutcomeFromRegexSource(r) : null;
    candidates.push({
      idx: mExpectRevert.index,
      outcome: s ? `触发 ${s}` : (inferred ?? `revert匹配 /${r}/`),
    });
  }

  const mExpectRevertGeneric = /expectRevert(?:Tracked)?\([\s\S]*?\)\s*;/u.exec(body);
  if (mExpectRevertGeneric) {
    candidates.push({ idx: mExpectRevertGeneric.index, outcome: "触发回滚" });
  }

  const mRevertWith = /revertWith\([\s\S]*?,\s*(?:"([^"]+)"|'([^']+)'|\/([^/]+)\/[gimsuy]*)/u.exec(body);
  if (mRevertWith) {
    const s = mRevertWith[1] ?? mRevertWith[2];
    const r = mRevertWith[3];
    const inferred = r ? inferOutcomeFromRegexSource(r) : null;
    candidates.push({
      idx: mRevertWith.index,
      outcome: s ? `revert: ${s}` : (inferred ?? `revert匹配 /${r}/`),
    });
  }

  const mMsgIncludes = /msg\.includes\("([A-Za-z0-9_]+)"\)/u.exec(body);
  if (mMsgIncludes) {
    candidates.push({ idx: mMsgIncludes.index, outcome: `触发 ${mMsgIncludes[1]}` });
  }

  if (candidates.length === 0) return "成功";
  candidates.sort((a, b) => a.idx - b.idx);
  return candidates[0].outcome;
}

function parseSuiteName(fileText, fileName) {
  const m = fileText.match(/describe\(\s*"([^"]+)"/u);
  if (m) return m[1];
  return path.basename(fileName, ".ts");
}

function parseCasesFromFile(filePath) {
  const text = readTextSmart(filePath);
  const suite = parseSuiteName(text, filePath);
  const cases = [];
  let autoCounter = 0;

  const tRegex = /\bT\(\s*"((?:[^"\\]|\\.)*)"\s*,\s*"((?:[^"\\]|\\.)*)"\s*,\s*async\b/gu;
  for (const m of text.matchAll(tRegex)) {
    const id = m[1].replace(/\\"/g, "\"");
    const desc = m[2].replace(/\\"/g, "\"");
    const braceOpen = text.indexOf("{", m.index + m[0].length);
    if (braceOpen < 0) continue;
    const braceClose = findMatchingBrace(text, braceOpen);
    if (braceClose < 0) continue;
    const body = text.slice(braceOpen + 1, braceClose);
    const testName = `${id}: ${desc}`;
    cases.push({
      suite,
      testName,
      id,
      desc,
      inferredOutcome: inferOutcomeFromBody(body),
    });
  }

  const itRegex = /\bit\(\s*"((?:[^"\\]|\\.)*)"\s*,\s*async\b/gu;
  for (const m of text.matchAll(itRegex)) {
    const name = m[1].replace(/\\"/g, "\"");
    const braceOpen = text.indexOf("{", m.index + m[0].length);
    if (braceOpen < 0) continue;
    const braceClose = findMatchingBrace(text, braceOpen);
    if (braceClose < 0) continue;
    const body = text.slice(braceOpen + 1, braceClose);

    const parsed = parseIdAndDesc(name);
    if (!parsed) autoCounter += 1;
    cases.push({
      suite,
      testName: name,
      id: parsed?.id ?? `${SUITE_CODE[suite] ?? "CASE"}-${String(autoCounter).padStart(2, "0")}`,
      desc: parsed?.desc ?? name,
      inferredOutcome: inferOutcomeFromBody(body),
    });
  }

  return cases;
}

function parseSourceCases(testDir) {
  const files = fs.readdirSync(testDir).filter((f) => f.endsWith(".ts"));
  const map = new Map();
  for (const f of files) {
    const fileCases = parseCasesFromFile(path.join(testDir, f));
    for (const c of fileCases) {
      const key = `${c.suite}@@${c.testName}`;
      if (!map.has(key)) map.set(key, c);
    }
  }
  return map;
}

function collectKnownErrorTokens(sourceCaseMap) {
  const set = new Set();
  for (const c of sourceCaseMap.values()) {
    const tok = extractOutcomeToken(c.inferredOutcome);
    if (!tok || tok === "SUCCESS") continue;
    if (tok.startsWith("REVERT:")) continue;
    for (const part of tok.split(/[|/]/).map((x) => x.trim()).filter(Boolean)) {
      set.add(part);
    }
  }
  return set;
}

function extractOutcomeToken(text) {
  const t = String(text ?? "");
  if (!t) return null;
  if (t === "成功") return "SUCCESS";

  const m1 = t.match(/触发\s+([A-Za-z0-9_()|/\-]+)/u);
  if (m1) return m1[1].replace(/\s+/g, "");

  const m2 = t.match(/revert:\s*(.+)$/u);
  if (m2) return `REVERT:${normalizeRevertReason(m2[1]).toLowerCase()}`;

  const m3 = t.match(/revert匹配\s*\/(.+)\/$/u);
  if (m3) return m3[1].replace(/[()\s]+/g, "");

  return null;
}

function pickActualFromFailure(block, failReason) {
  const text = `${failReason ?? ""}\n${block ?? ""}`;

  const mismatch = text.match(/reverted with custom error ["']([A-Za-z0-9_]+)\(?\)?["']/u);
  if (mismatch) return `触发 ${mismatch[1]}`;

  const detailsErr = text.match(/custom error ['"]([A-Za-z0-9_]+)\(?\)?['"]/u);
  if (detailsErr) return `触发 ${detailsErr[1]}`;

  const numMismatch = text.match(/(\d+\s*!==\s*\d+n?)/u);
  if (numMismatch) return `断言失败: ${numMismatch[1]}`;

  const tErr = text.match(/TypeError:\s*([^\n]+)/u);
  if (tErr) return `TypeError: ${normalizeSpace(tErr[1])}`;

  const hErr = text.match(/HardhatError:\s*([^\n]+)/u);
  if (hErr) return `HardhatError: ${normalizeSpace(hErr[1])}`;

  const cErr = text.match(/ContractFunctionExecutionError:\s*([^\n]+)/u);
  if (cErr) return `ContractFunctionExecutionError: ${normalizeSpace(cErr[1])}`;

  const aErr = text.match(/AssertionError:\s*([^\n]+)/u);
  if (aErr) return `AssertionError: ${normalizeSpace(aErr[1])}`;

  return "失败（见日志）";
}

function expectedFromName(testName) {
  const parsed = parseIdAndDesc(testName);
  const desc = parsed?.desc ?? testName;
  const arrow = desc.match(/->\s*([^,，]+)$/u);
  if (arrow) {
    const tail = normalizeSpace(arrow[1]);
    if (/(成功|succeed|succeeds|allow|允许|通过)/iu.test(tail)) return "成功";
    if (/^[A-Za-z][A-Za-z0-9_]+$/u.test(tail)) return `触发 ${tail}`;
    return tail;
  }
  if (/(成功|succeed|succeeds|allow|允许|通过)/iu.test(desc)) return "成功";
  return "成功";
}

function outcomeMatch(expected, actual) {
  const eToken = extractOutcomeToken(expected);
  const aToken = extractOutcomeToken(actual);

  // For narrative/spec text without explicit outcome token, don't mark mismatch automatically.
  if (!eToken) return true;
  if (!aToken) return false;

  if (eToken === aToken) return true;

  const eOpts = String(eToken).split(/[|/]/).map((x) => x.trim()).filter(Boolean);
  const aOpts = String(aToken).split(/[|/]/).map((x) => x.trim()).filter(Boolean);
  if (eOpts.length > 1 && aOpts.some((x) => eOpts.includes(x))) return true;
  if (aOpts.length > 1 && eOpts.some((x) => aOpts.includes(x))) return true;
  return false;
}

function buildReport({ suites, passSummary, failSummary }, expectedById, sourceCaseMap) {
  const ordered = [
    ...SUITE_ORDER.filter((s) => suites.has(s)).map((s) => suites.get(s)),
    ...[...suites.values()].filter((s) => !SUITE_ORDER.includes(s.name)),
  ];

  // Fill ids from source map for no-id runtime cases + expected/actual.
  for (const suite of ordered) {
    let autoCounter = 0;
    for (const c of suite.cases) {
      const key = `${suite.name}@@${c.testName}`;
      const src = sourceCaseMap.get(key);
      if (src) {
        c.id = src.id;
        c.desc = src.desc;
      } else {
        const parsed = parseIdAndDesc(c.testName);
        if (parsed) {
          c.id = parsed.id;
          c.desc = parsed.desc;
        } else {
          autoCounter += 1;
          c.id = `${SUITE_CODE[suite.name] ?? "CASE"}-${String(autoCounter).padStart(2, "0")}`;
          c.desc = c.testName;
        }
      }
    }
  }

  const mismatchPassedCases = [];
  let total = 0;
  let totalPass = 0;
  let totalFail = 0;

  for (const suite of ordered) {
    for (const c of suite.cases) {
      total += 1;
      if (c.pass) totalPass += 1;
      else totalFail += 1;

      const key = `${suite.name}@@${c.testName}`;
      const src = sourceCaseMap.get(key);
      const actualFromAssertion = src?.inferredOutcome ?? expectedFromName(c.testName);
      const expected = expectedById.get(c.id) ?? actualFromAssertion;
      const actual = c.pass ? actualFromAssertion : pickActualFromFailure(c.failBlock, c.failReason);

      c.expected = expected || "成功";
      c.actual = actual || "成功";
      c.consistent = outcomeMatch(c.expected, c.actual);

      if (c.pass && !c.consistent) {
        c.actual = `${c.actual}（与预期 ${c.expected} 不一致）`;
        mismatchPassedCases.push(c);
      }
    }
  }

  const now = new Date();
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

  const lines = [];
  lines.push("# C2C Platform Smart Contract Test Results");
  lines.push("");
  lines.push(`**Date:** ${dateStr}`);
  lines.push("**Command:** `npx hardhat test --network hardhatMainnet`");
  lines.push("**Log:** `packages/contracts/all-tests-output-rerun.log`");
  lines.push("**Expected Source:** `C2C_TEST_CASES_REGENERATED.md` (spec-first, fallback to test assertions)");
  lines.push("**Network:** hardhatMainnet (chainId 31337, simulated)");
  lines.push("**Framework:** Hardhat v3 + node:test + viem");
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("| Suite | Tests | Pass | Fail |");
  lines.push("|-------|------:|-----:|-----:|");
  for (const suite of ordered) {
    const p = suite.cases.filter((c) => c.pass).length;
    const f = suite.cases.length - p;
    lines.push(`| ${escapePipes(suite.name)} | ${suite.cases.length} | ${p} | ${f} |`);
  }
  lines.push(`| **Total** | **${total}** | **${totalPass}** | **${totalFail}** |`);
  lines.push("");
  lines.push(`**Run Summary (node:test):** ${passSummary} passing / ${failSummary} failing`);
  lines.push("");
  lines.push("---");
  lines.push("");

  for (const suite of ordered) {
    const p = suite.cases.filter((c) => c.pass).length;
    const f = suite.cases.length - p;
    lines.push(`## ${suite.name}`);
    lines.push("");
    lines.push(`**Result:** ${p} / ${suite.cases.length} passed${f > 0 ? `, ${f} failed` : ""}`);
    lines.push("");
    lines.push("| # | 测试内容 | 预期结果 | 结果 | 通过 | 总时间(ms) | 验证时间(ms) | Gas (gas units) | 失败原因 |");
    lines.push("|---|---------|---------|------|:----:|----------:|------------:|----------------:|---------|");

    for (const c of suite.cases) {
      lines.push(
        `| ${escapePipes(c.id)} | ${escapePipes(c.desc)} | ${escapePipes(c.expected)} | ${escapePipes(c.actual)} | ${c.pass ? "✅" : "❌"} | ${fmtMs(c.totalMs)} | ${fmtMs(c.verifyMs)} | ${fmtGas(c.gasUsed)} | ${c.pass ? "—" : escapePipes(c.failReason ?? "见日志")} |`,
      );
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push("## 预期与实际不一致清单（通过但不一致）");
  lines.push("");
  if (mismatchPassedCases.length === 0) {
    lines.push("- 无");
  } else {
    for (const c of mismatchPassedCases) {
      lines.push(`- [${c.suite}] ${c.id} ${c.desc} | 预期: ${c.expected} | 实际: ${c.actual}`);
    }
  }
  lines.push("");

  return { markdown: `${lines.join("\n")}\n`, total, totalPass, totalFail, mismatchPassedCases };
}

function validateResult(mdText, parsed) {
  const lines = splitLines(mdText);
  const rowCount = lines.filter((l) => /^\| [A-Z]+(?:-[A-Z0-9]+)*-\d+ \|/u.test(l)).length;
  if (rowCount !== 270) {
    throw new Error(`Row count validation failed: expected 270, got ${rowCount}`);
  }

  const bad = lines.filter((l) => /^\| [A-Z]+(?:-[A-Z0-9]+)*-\d+ \|/u.test(l)).filter((l) => {
    const cells = l.split("|").slice(1, -1).map((c) => c.trim());
    // #, 测试内容, 预期结果, 结果, 通过, 总时间, 验证时间, gas, 失败原因
    return !cells[2] || !cells[3];
  });
  if (bad.length > 0) {
    throw new Error(`Expected/actual non-empty validation failed: ${bad.length} rows`);
  }

  const mustContain = [
    "ESC-ERR-19",
    "ESC-ERR-30",
    "ESC-ATT-03",
    "ESC-ATT-04",
    "ALI-TAMPER-06",
  ];
  for (const id of mustContain) {
    if (!mdText.includes(`| ${id} |`)) {
      throw new Error(`Missing required case in report: ${id}`);
    }
  }

  if (parsed.total !== 270 || parsed.totalPass !== 241 || parsed.totalFail !== 29) {
    throw new Error(
      `Count validation failed: total=${parsed.total}, pass=${parsed.totalPass}, fail=${parsed.totalFail}`,
    );
  }
}

function main() {
  if (!fs.existsSync(LOG_PATH)) throw new Error(`Log not found: ${LOG_PATH}`);
  if (!fs.existsSync(SPEC_PATH)) throw new Error(`Spec not found: ${SPEC_PATH}`);

  const logText = readTextSmart(LOG_PATH);
  const specText = readTextSmart(SPEC_PATH);

  const parsedLog = parseLog(logText);
  const sourceCaseMap = parseSourceCases(TEST_DIR);
  const knownErrorTokens = collectKnownErrorTokens(sourceCaseMap);
  const expectedById = parseSpecExpectedMap(specText, knownErrorTokens);
  const report = buildReport(parsedLog, expectedById, sourceCaseMap);
  validateResult(report.markdown, report);

  fs.writeFileSync(OUT_PATH, report.markdown, "utf8");

  console.log(`Generated: ${OUT_PATH}`);
  console.log(`Totals: ${report.total} | pass ${report.totalPass} | fail ${report.totalFail}`);
  console.log(`Pass-but-mismatch: ${report.mismatchPassedCases.length}`);
}

main();

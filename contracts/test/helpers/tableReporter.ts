/**
 * tableReporter.ts
 *
 * Collects per-test metrics and prints a formatted summary table.
 * Call addRecord() inside each test, then printTable() in an after() hook.
 */

export interface TestRecord {
  id: string;
  desc: string;
  pass: boolean;
  totalMs: number;
  verifyMs: number;
  gasUsed: bigint;
}

const _records: TestRecord[] = [];

// Overload 1: legacy object-based call — addRecord({ id, desc, pass, totalMs, verifyMs, gasUsed })
export function addRecord(record: TestRecord): void;
// Overload 2: positional call — addRecord(id, desc, pass, ctx)
export function addRecord(id: string, desc: string, pass: boolean, ctx: ReturnType<typeof makeCtx>): void;
export function addRecord(
  idOrRecord: string | TestRecord,
  desc?: string,
  pass?: boolean,
  ctx?: ReturnType<typeof makeCtx>,
): void {
  if (typeof idOrRecord === "object") {
    _records.push(idOrRecord);
  } else {
    _records.push({
      id: idOrRecord,
      desc: desc!,
      pass: pass!,
      totalMs: ctx ? Date.now() - ctx.startTime : 0,
      verifyMs: ctx ? ctx.verifyMs() : 0,
      gasUsed: ctx ? ctx.gasUsed : 0n,
    });
  }
}

/** Clear all records (useful if multiple suites share a process). */
export function clearRecords(): void {
  _records.length = 0;
}

/** Return a timing/gas context to be filled in by each test. */
export function makeCtx() {
  const ctx = {
    startTime: Date.now(),
    verifyStart: 0,
    verifyEnd: 0,
    gasUsed: 0n as bigint,
    markVerifyStart() { ctx.verifyStart = Date.now(); },
    markVerifyEnd()   { ctx.verifyEnd   = Date.now(); },
    setGas(g: bigint) { ctx.gasUsed = g; },
    verifyMs() { return ctx.verifyEnd - ctx.verifyStart; },
  };
  return ctx;
}

export function printTable(title: string): void {
  // Column widths (content only, border + spaces added separately)
  const W = { id: 8, desc: 52, pass: 2, tot: 10, ver: 12, gas: 16 };

  const pad  = (s: string, w: number) => s.slice(0, w).padEnd(w);
  const rpad = (s: string, w: number) => s.slice(0, w).padStart(w);

  const cols = [W.id, W.desc, W.pass, W.tot, W.ver, W.gas];
  const hr = (l: string, m: string, r: string, sep: string) =>
    l + cols.map(w => "─".repeat(w + 2)).join(sep) + r;

  const row = (...cells: string[]) => {
    const widths = [W.id, W.desc, W.pass, W.tot, W.ver, W.gas];
    return "│ " + cells.map((c, i) => pad(c, widths[i])).join(" │ ") + " │";
  };

  const rowR = (id: string, desc: string, passStr: string, tot: string, ver: string, gas: string) =>
    "│ " +
    pad(id, W.id) + " │ " +
    pad(desc, W.desc) + " │ " +
    rpad(passStr, W.pass) + " │ " +
    rpad(tot, W.tot) + " │ " +
    rpad(ver, W.ver) + " │ " +
    rpad(gas, W.gas) + " │";

  const LINE = 8 + 2 + 52 + 2 + 2 + 2 + 10 + 2 + 12 + 2 + 16 + 2 + 7; // col widths + separators

  console.log("\n" + "═".repeat(LINE));
  console.log(`  ${title}`);
  console.log("═".repeat(LINE));
  console.log(hr("┌", "┬", "┐", "┬"));
  console.log(rowR("#", "测试内容", "通过", "总时间(ms)", "验证时间(ms)", "Gas (gas units)"));
  console.log(hr("├", "┼", "┤", "┼"));

  let passCount = 0;
  for (const r of _records) {
    const passStr = r.pass ? "✅" : "❌";
    const totStr  = r.totalMs > 0  ? r.totalMs.toString()  : "—";
    const verStr  = r.verifyMs > 0 ? r.verifyMs.toString()  : "—";
    const gasStr  = r.gasUsed > 0n ? r.gasUsed.toString()   : "—";
    const desc    = r.desc.length > W.desc ? r.desc.slice(0, W.desc - 1) + "…" : r.desc;
    console.log(rowR(r.id, desc, passStr, totStr, verStr, gasStr));
    if (r.pass) passCount++;
  }

  console.log(hr("└", "┴", "┘", "┴"));
  const failCount = _records.length - passCount;
  console.log(
    `  总计: ${_records.length} 个测试  ` +
    `✅ ${passCount} 通过  ` +
    (failCount > 0 ? `❌ ${failCount} 失败` : "全部通过"),
  );
  console.log("═".repeat(LINE) + "\n");
}

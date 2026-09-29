/**
 * 判定业务（judgment.js）
 * 声呐异常接触点的登记与复核：
 *  - 登记测线号、目标编号、坐标、置信等级
 *  - 同线同编号重传：资料一致沿用首次结果
 *  - 资料变化：新资料转待复核，原记录继续有效
 *  - 复核判定：确认异常 / 排除 / 采用新资料 / 维持原记录
 * 资料不直接依赖任务业务，采用后通过 onChange 广播变更。
 */
const Judgment = (function () {
  const STORE_KEY = "arch.judgment.v1";
  const LEVELS = ["高", "中", "低"];

  let contacts = load();
  const listeners = [];

  function load() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || []; }
    catch (e) { return []; }
  }
  function persist() { localStorage.setItem(STORE_KEY, JSON.stringify(contacts)); }
  function uid() {
    return crypto.randomUUID ? crypto.randomUUID()
      : "J-" + Date.now().toString(16) + Math.random().toString(16).slice(2, 8);
  }
  function now() { return new Date().toISOString(); }
  function clean(v) { return String(v == null ? "" : v).trim(); }
  function addLog(contact, text) { contact.log.push({ at: now(), text }); }

  function find(line, target) {
    const l = clean(line), t = clean(target);
    return contacts.find(c => c.line === l && c.target === t) || null;
  }
  function get(id) { return contacts.find(c => c.id === id) || null; }
  function list() { return contacts.slice(); }
  function snapshot(id) {
    const c = get(id);
    return c ? { line: c.line, target: c.target, x: c.x, y: c.y, confidence: c.confidence } : null;
  }
  /** 复核采用新资料后广播：listener(contact, changes, before) */
  function onChange(fn) { listeners.push(fn); }

  function normalize(p) {
    return {
      line: clean(p.line),
      target: clean(p.target),
      x: Number(p.x),
      y: Number(p.y),
      confidence: LEVELS.includes(clean(p.confidence)) ? clean(p.confidence) : "中"
    };
  }
  function isValid(p) {
    return p.line !== "" && p.target !== "" && Number.isFinite(p.x) && Number.isFinite(p.y);
  }
  function sameData(c, p) {
    return c.x === p.x && c.y === p.y && c.confidence === p.confidence;
  }
  function diff(before, after) {
    return {
      lineChanged: before.line !== after.line,
      coordChanged: before.x !== after.x || before.y !== after.y,
      confidenceChanged: before.confidence !== after.confidence
    };
  }
  function diffText(before, r) {
    const parts = [];
    if (r.line !== before.line) parts.push(`测线 ${before.line} → ${r.line}`);
    if (r.x !== before.x || r.y !== before.y)
      parts.push(`坐标 (${before.x.toFixed(1)}, ${before.y.toFixed(1)}) → (${r.x.toFixed(1)}, ${r.y.toFixed(1)})`);
    if (r.confidence !== before.confidence) parts.push(`置信 ${before.confidence} → ${r.confidence}`);
    return parts.join("；") || "无变化";
  }

  /**
   * 声呐回传登记。
   * 返回 { ok, type: 'created' | 'reused' | 'revision' }
   */
  function ingest(payload) {
    const p = normalize(payload);
    if (!isValid(p)) return { ok: false, code: "INVALID", message: "测线号、目标编号和坐标必须完整填写" };

    const existing = find(p.line, p.target);
    if (!existing) {
      const contact = {
        id: uid(), line: p.line, target: p.target,
        x: p.x, y: p.y, confidence: p.confidence,
        status: "pending",          // pending 待复核 / confirmed 已确认 / dismissed 已排除
        prevStatus: null,
        revision: null,             // 待复核的新资料 {line,x,y,confidence,at}
        firstAt: now(), reviewedAt: null,
        log: []
      };
      addLog(contact, "声呐首次回传，已登记，待复核");
      contacts.push(contact);
      persist();
      return { ok: true, type: "created", contact };
    }

    const rev = existing.revision;
    if (sameData(existing, p) || (rev && rev.x === p.x && rev.y === p.y && rev.confidence === p.confidence)) {
      // 与首次（有效）资料一致：若此前挂着不同的待复核资料，说明最新回传已回到原值，撤销待复核
      if (rev && sameData(existing, p)) {
        existing.revision = null;
        existing.status = existing.prevStatus || "pending";
        existing.prevStatus = null;
        addLog(existing, "最新回传与首次资料一致，沿用首次结果，撤销待复核");
        persist();
      }
      return { ok: true, type: "reused", contact: existing };
    }

    // 资料变化：排队待复核，当前有效记录（原记录）保持不动
    if (existing.status !== "pending") existing.prevStatus = existing.status;
    existing.status = "pending";
    existing.revision = { line: existing.line, x: p.x, y: p.y, confidence: p.confidence, at: now() };
    addLog(existing, `声呐重传资料变化（${diffText(existing, existing.revision)}），转待复核，原记录继续有效`);
    persist();
    return { ok: true, type: "revision", contact: existing };
  }

  /** 人工资料更正：同样走待复核流程，测线也可在此更正 */
  function propose(id, patch) {
    const contact = get(id);
    if (!contact) return { ok: false, code: "NOT_FOUND" };
    const next = {
      line: clean(patch.line) || contact.line,
      x: Number(patch.x),
      y: Number(patch.y),
      confidence: LEVELS.includes(clean(patch.confidence)) ? clean(patch.confidence) : contact.confidence
    };
    if (!Number.isFinite(next.x) || !Number.isFinite(next.y) || !next.line)
      return { ok: false, code: "INVALID", message: "测线号和坐标必须完整填写" };
    if (next.line === contact.line && next.x === contact.x && next.y === contact.y &&
        next.confidence === contact.confidence)
      return { ok: false, code: "NO_CHANGE", message: "资料与当前有效记录一致，无需更正" };

    if (contact.status !== "pending") contact.prevStatus = contact.status;
    contact.status = "pending";
    contact.revision = Object.assign({ at: now() }, next);
    addLog(contact, `提交资料更正（${diffText(contact, contact.revision)}），待复核，原记录继续有效`);
    persist();
    return { ok: true, contact };
  }

  /** 复核采用新资料（仅在有待复核资料时） */
  function adopt(id) {
    const contact = get(id);
    if (!contact) return { ok: false, code: "NOT_FOUND" };
    if (!contact.revision) return { ok: false, code: "NO_REVISION", message: "没有待复核的新资料" };

    const r = contact.revision;
    const before = { line: contact.line, x: contact.x, y: contact.y, confidence: contact.confidence };
    const changes = diff(before, r);
    addLog(contact, `复核通过，采用新资料（${diffText(before, r)}）`);

    contact.line = r.line;
    contact.x = r.x;
    contact.y = r.y;
    contact.confidence = r.confidence;
    contact.revision = null;
    contact.status = "confirmed";
    contact.prevStatus = null;
    contact.reviewedAt = now();
    persist();

    listeners.slice().forEach(fn => { try { fn(contact, changes, before); } catch (e) { console.error(e); } });
    return { ok: true, contact, changes };
  }

  /** 复核维持原记录，驳回待复核资料 */
  function keep(id) {
    const contact = get(id);
    if (!contact) return { ok: false, code: "NOT_FOUND" };
    if (!contact.revision) return { ok: false, code: "NO_REVISION", message: "没有待复核的新资料" };
    addLog(contact, "复核维持原记录，未采用新资料");
    contact.revision = null;
    contact.status = contact.prevStatus || "pending";
    contact.prevStatus = null;
    contact.reviewedAt = now();
    persist();
    return { ok: true, contact };
  }

  /** 首次判定（无待复核资料时）：confirm 确认异常 / dismiss 排除 */
  function decide(id, verdict) {
    const contact = get(id);
    if (!contact) return { ok: false, code: "NOT_FOUND" };
    if (contact.revision) return { ok: false, code: "HAS_REVISION", message: "存在资料变化，请先采用或维持新资料" };
    if (verdict === "confirm") {
      contact.status = "confirmed";
      addLog(contact, "复核判定：确认异常，可生成下水任务");
    } else if (verdict === "dismiss") {
      contact.status = "dismissed";
      addLog(contact, "复核判定：排除该目标");
    } else {
      return { ok: false, code: "BAD_VERDICT" };
    }
    contact.prevStatus = null;
    contact.reviewedAt = now();
    persist();
    return { ok: true, contact };
  }

  /** 已排除目标重新进入判定 */
  function reopen(id) {
    const contact = get(id);
    if (!contact || contact.status !== "dismissed") return { ok: false, code: "NOT_ALLOWED" };
    contact.prevStatus = "dismissed";
    contact.status = "pending";
    addLog(contact, "申请重新判定，待复核");
    persist();
    return { ok: true, contact };
  }

  return { ingest, propose, adopt, keep, decide, reopen, find, get, list, snapshot, onChange, LEVELS };
})();

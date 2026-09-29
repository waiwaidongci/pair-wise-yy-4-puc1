/*
 * 判定业务文件（judgment.js）
 * 声呐异常目标的登记判别与复核裁决，只放纯业务规则，不碰 DOM 与存储：
 * 1. 同测线号 + 同目标编号重传：资料一致 -> 沿用首次结果；
 * 2. 资料变化 -> 挂“待复核”新资料，原记录继续有效，复核后再采纳或维持；
 * 3. 采纳的新资料若改动测线号或坐标 -> 告知未结束下水任务需要重排（已下潜任务留档，由任务文件执行）。
 */
(function (global) {
  "use strict";

  const CONFIDENCE_LABELS = { high: "高", medium: "中", low: "低" };
  // 参与“资料是否变化”比对的字段（测线号/目标编号也是登记资料，改动同样转待复核）；
  // 备注只随次留档，不触发待复核
  const DATA_FIELDS = ["line", "target", "lon", "lat", "confidence", "depth"];
  const COORD_PRECISION = 1e6; // 坐标比对精度：约 0.1 米

  function uid() {
    return global.crypto && global.crypto.randomUUID
      ? global.crypto.randomUUID()
      : "id-" + Date.now() + "-" + Math.random().toString(16).slice(2);
  }
  function roundCoord(v) {
    return Math.round(Number(v) * COORD_PRECISION) / COORD_PRECISION;
  }
  function keyOf(rec) {
    return String(rec.line).trim() + "//" + String(rec.target).trim();
  }

  function normalize(input) {
    const line = String(input.line ?? "").trim();
    const target = String(input.target ?? "").trim();
    const lon = Number(input.lon);
    const lat = Number(input.lat);
    if (!line) throw new Error("请填写测线号");
    if (!target) throw new Error("请填写目标编号");
    if (!Number.isFinite(lon)) throw new Error("请填写有效的经度");
    if (!Number.isFinite(lat)) throw new Error("请填写有效的纬度");
    if (!CONFIDENCE_LABELS[input.confidence]) throw new Error("请选择置信等级");
    return {
      line,
      target,
      lon: roundCoord(lon),
      lat: roundCoord(lat),
      confidence: input.confidence,
      depth: String(input.depth ?? "").trim(),
      note: String(input.note ?? "").trim()
    };
  }

  function sameData(a, b) {
    return DATA_FIELDS.every(f => String(a[f]) === String(b[f]));
  }

  // existing 为 null = 首次登记；否则视为同线同编号重传
  // 返回 outcome: new 新登记 / repeat 重传沿用首次结果 / revision 资料变化转待复核
  function register(existing, raw, at) {
    const data = normalize(raw);
    if (!existing) {
      return {
        outcome: "new",
        contact: {
          id: uid(),
          line: data.line, // 首次测线号/目标编号，作为身份标识
          target: data.target,
          // pending 待复核 / approved 已通过 / rejected 已排除
          status: "pending",
          // 现行有效记录（首次结果或最近一次采纳的资料）
          effective: Object.assign({ at }, data),
          // 待复核的新资料；非空期间原记录继续有效
          pending: null,
          history: [{ at, type: "register", text: "首次登记（" + data.line + " / " + data.target + "），等待复核" }],
          createdAt: at,
          updatedAt: at
        }
      };
    }
    if (sameData(data, existing.effective) || (existing.pending && sameData(data, existing.pending))) {
      existing.history.push({ at, type: "repeat", text: "同线同编号重传，资料一致，沿用首次结果" });
      existing.updatedAt = at;
      return { outcome: "repeat", contact: existing };
    }
    const hadRevision = existing.history.some(x => x.type === "revision");
    existing.pending = Object.assign({ at }, data);
    existing.history.push({
      at,
      type: "revision",
      text: hadRevision
        ? "重传资料再次变化，已更新待复核资料，原记录继续有效"
        : "重传资料有变化，转待复核，原记录继续有效"
    });
    existing.updatedAt = at;
    return { outcome: "revision", contact: existing };
  }

  // action: approve 通过/采纳，reject 排除/维持原记录
  function review(contact, action, at) {
    if (action !== "approve" && action !== "reject") throw new Error("未知的复核结论");

    // 有待复核的新资料
    if (contact.pending) {
      if (action === "reject") {
        contact.pending = null;
        contact.history.push({ at, type: "keep", text: "复核维持原记录，新资料不予采纳" });
        contact.updatedAt = at;
        return { result: "kept", reschedule: false };
      }
      const before = contact.effective;
      const after = contact.pending;
      const lineChanged = before.line !== after.line || before.target !== after.target;
      const coordChanged = before.lon !== after.lon || before.lat !== after.lat;
      contact.effective = Object.assign({ at }, after);
      contact.pending = null;
      contact.status = "approved";
      contact.history.push({
        at,
        type: "adopt",
        text: "复核采纳新资料，原记录归档" +
          (lineChanged || coordChanged ? "；测线/坐标变更，未结束任务重排，已下潜留档" : "")
      });
      contact.updatedAt = at;
      return { result: "adopted", reschedule: lineChanged || coordChanged, lineChanged, coordChanged };
    }

    // 首次结果的复核
    contact.status = action === "approve" ? "approved" : "rejected";
    contact.history.push({
      at,
      type: action,
      text: action === "approve" ? "复核通过，可生成下水任务" : "复核排除，判为声呐干扰"
    });
    contact.updatedAt = at;
    return { result: contact.status, reschedule: false };
  }

  // 现行记录 vs 待复核资料的逐字段对照（供页面展示）
  function diffFields(before, after) {
    return [
      ["测线号", before.line, after.line],
      ["目标编号", before.target, after.target],
      ["经度", before.lon, after.lon],
      ["纬度", before.lat, after.lat],
      ["置信等级", CONFIDENCE_LABELS[before.confidence], CONFIDENCE_LABELS[after.confidence]],
      ["水深", before.depth || "—", after.depth || "—"]
    ].map(([label, oldV, newV]) => ({ label, oldV, newV, changed: String(oldV) !== String(newV) }));
  }

  global.ReviewJudgment = {
    CONFIDENCE_LABELS,
    keyOf,
    register,
    review,
    diffFields
  };
})(window);

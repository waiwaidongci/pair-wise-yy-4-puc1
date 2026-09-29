/*
 * 任务业务文件（tasks.js）
 * 负责接触点台账、下水任务的存储与生命周期编排，判定规则一律调用 judgment.js：
 * - 复核通过后才可生成下水任务，绑定接触点、潜次和申报人；
 * - 同一接触点只保留一条未结束任务（planned 待下潜 / rescheduled 待重排 均算未结束）；
 * - 撤回必须填写原因；
 * - 采纳的新资料改动测线/坐标时，未结束任务转“待重排”并解绑原潜次，已下潜任务留档不动。
 */
(function (global) {
  "use strict";

  const J = global.ReviewJudgment;
  const CONTACT_KEY = "zfl30ReviewContacts";
  const TASK_KEY = "zfl30ReviewTasks";
  const STATUS_LABELS = {
    planned: "待下潜",
    rescheduled: "待重排",
    dived: "已下潜·留档",
    withdrawn: "已撤回"
  };
  // 未结束：未完成下潜、未撤回
  const OPEN_STATES = ["planned", "rescheduled"];

  function uid() {
    return global.crypto && global.crypto.randomUUID
      ? global.crypto.randomUUID()
      : "id-" + Date.now() + "-" + Math.random().toString(16).slice(2);
  }
  function now() { return new Date().toISOString(); }
  function persist() {
    localStorage.setItem(CONTACT_KEY, JSON.stringify(contacts));
    localStorage.setItem(TASK_KEY, JSON.stringify(tasks));
  }
  function load(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      return null;
    }
  }

  function seed() {
    const c1 = J.register(null, {
      line: "L-03", target: "M-017", lon: 122.1042, lat: 28.7311,
      confidence: "high", depth: "17.8m", note: "声呐强回波，疑似陶片堆积"
    }, "2026-09-20T02:10:00.000Z").contact;
    J.review(c1, "approve", "2026-09-20T03:00:00.000Z");
    const c2 = J.register(null, {
      line: "L-03", target: "M-021", lon: 122.1059, lat: 28.7327,
      confidence: "low", depth: "19.5m", note: "回波偏弱，待复核确认"
    }, "2026-09-21T01:40:00.000Z").contact;
    const c3 = J.register(null, {
      line: "L-05", target: "W-003", lon: 122.1078, lat: 28.7298,
      confidence: "medium", depth: "18.2m", note: "疑似横梁"
    }, "2026-09-22T02:20:00.000Z").contact;
    J.review(c3, "approve", "2026-09-22T03:10:00.000Z");
    J.register(c3, {
      line: "L-05", target: "W-003", lon: 122.1081, lat: 28.7299,
      confidence: "high", depth: "18.1m", note: "复核扫描后回波更清晰，坐标微调"
    }, "2026-09-25T06:00:00.000Z");
    const c4 = J.register(null, {
      line: "L-07", target: "X-008", lon: 122.1112, lat: 28.7274,
      confidence: "medium", depth: "20.1m", note: ""
    }, "2026-09-24T08:30:00.000Z").contact;
    J.review(c4, "approve", "2026-09-24T09:00:00.000Z");
    return [c1, c2, c3, c4];
  }

  let contacts = load(CONTACT_KEY) || seed();
  let tasks = load(TASK_KEY) || [
    {
      id: uid(), contactId: contacts[0].id, dive: "DIVE-04", applicant: "周明远",
      status: "planned", reason: "", previousDive: "", createdAt: "2026-09-20T04:00:00.000Z", updatedAt: "2026-09-20T04:00:00.000Z"
    },
    {
      id: uid(), contactId: contacts[3].id, dive: "DIVE-02", applicant: "陈岚",
      status: "dived", reason: "", previousDive: "", createdAt: "2026-09-24T09:30:00.000Z", updatedAt: "2026-09-26T02:00:00.000Z"
    },
    {
      id: uid(), contactId: contacts[3].id, dive: "DIVE-05", applicant: "林海",
      status: "withdrawn", reason: "海况突变，潜次整体取消", previousDive: "", createdAt: "2026-09-25T01:00:00.000Z", updatedAt: "2026-09-25T05:00:00.000Z"
    }
  ];
  persist();

  // 接触点：登记 / 重传
  function submit(raw) {
    const data = { line: raw.line, target: raw.target };
    const existing = findByKey(J.keyOf(data));
    const result = J.register(existing, raw, now());
    if (result.outcome === "new") contacts.push(result.contact);
    persist();
    return result;
  }

  // 接触点：复核（采纳新资料时联动重排未结束任务）
  function adjudicate(contactId, action) {
    const contact = contacts.find(c => c.id === contactId);
    if (!contact) throw new Error("接触点不存在");
    if (contact.status !== "pending" && !contact.pending) throw new Error("该接触点没有待办复核项");
    const verdict = J.review(contact, action, now());
    if (verdict.reschedule) {
      let count = 0;
      tasks.forEach(task => {
        if (task.contactId !== contactId || task.status !== "planned") return;
        task.status = "rescheduled";
        task.previousDive = task.dive;
        task.dive = ""; // 解绑原潜次，等待重新排期
        task.updatedAt = now();
        count++;
      });
      verdict.rescheduled = count;
    }
    persist();
    return verdict;
  }

  function openTaskOf(contactId) {
    return tasks.find(t => t.contactId === contactId && OPEN_STATES.includes(t.status));
  }

  // 生成下水任务：绑定接触点、潜次、申报人
  function createTask({ contactId, dive, applicant }) {
    const contact = contacts.find(c => c.id === contactId);
    if (!contact) throw new Error("接触点不存在");
    if (contact.status !== "approved") throw new Error("接触点尚未复核通过，不能生成下水任务");
    if (contact.pending) throw new Error("该接触点有待复核的新资料，请先完成复核");
    if (openTaskOf(contactId)) throw new Error("同一接触点只保留一条未结束任务");
    const diveTrim = String(dive || "").trim();
    const applicantTrim = String(applicant || "").trim();
    if (!diveTrim) throw new Error("请填写潜次");
    if (!applicantTrim) throw new Error("请填写申报人");
    const at = now();
    const task = {
      id: uid(), contactId, dive: diveTrim, applicant: applicantTrim,
      status: "planned", reason: "", previousDive: "", createdAt: at, updatedAt: at
    };
    tasks.push(task);
    persist();
    return task;
  }

  // 撤回：必须写原因
  function withdrawTask(taskId, reason) {
    const task = tasks.find(t => t.id === taskId);
    if (!task) throw new Error("任务不存在");
    if (!OPEN_STATES.includes(task.status)) throw new Error("只有未结束任务可以撤回");
    const reasonTrim = String(reason || "").trim();
    if (!reasonTrim) throw new Error("撤回必须填写原因");
    task.status = "withdrawn";
    task.reason = reasonTrim;
    task.updatedAt = now();
    persist();
    return task;
  }

  // 重排：为“待重排”任务重新安排潜次（申报人沿用）
  function replanTask(taskId, dive) {
    const task = tasks.find(t => t.id === taskId);
    if (!task) throw new Error("任务不存在");
    if (task.status !== "rescheduled") throw new Error("只有待重排任务可以重新安排潜次");
    const diveTrim = String(dive || "").trim();
    if (!diveTrim) throw new Error("请填写重排后的潜次");
    task.dive = diveTrim;
    task.status = "planned";
    task.updatedAt = now();
    persist();
    return task;
  }

  // 完成下潜：任务留档，之后任何测线/坐标改动都不再动它
  function completeTask(taskId) {
    const task = tasks.find(t => t.id === taskId);
    if (!task) throw new Error("任务不存在");
    if (!OPEN_STATES.includes(task.status)) throw new Error("任务已结束");
    task.status = "dived";
    task.updatedAt = now();
    persist();
    return task;
  }

  function findByKey(k) {
    const exact = contacts.find(c =>
      J.keyOf(c.effective) === k || J.keyOf(c) === k ||
      (c.pending && J.keyOf(c.pending) === k));
    if (exact) return exact;
    // 测线被改派的重传（新资料带新线号）：同编号在全台账唯一则归并到原接触点；
    // 若多条测线都有这个编号（无法判别），仍按新目标登记
    const target = k.split("//")[1];
    const sameTarget = contacts.filter(c =>
      c.target === target || c.effective.target === target ||
      (c.pending && c.pending.target === target));
    return sameTarget.length === 1 ? sameTarget[0] : null;
  }
  function contactOf(task) {
    return contacts.find(c => c.id === task.contactId) || null;
  }
  function exportJson() {
    return JSON.stringify({ contacts, tasks }, null, 2);
  }

  global.ReviewTasks = {
    get contacts() { return contacts; },
    get tasks() { return tasks; },
    STATUS_LABELS,
    OPEN_STATES,
    submit,
    adjudicate,
    openTaskOf,
    createTask,
    withdrawTask,
    replanTask,
    completeTask,
    contactOf,
    exportJson
  };
})(window);

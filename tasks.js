/**
 * 下水任务业务（tasks.js）
 *  - 复核过后生成任务，绑定接触点、潜次、申报人
 *  - 同一接触点只留一条未结束任务
 *  - 撤回必须写原因
 *  - 测线或坐标改动让未结束任务重排，已下潜留档不动
 */
const Tasks = (function () {
  const STORE_KEY = "arch.tasks.v1";

  let tasks = load();
  function load() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || []; }
    catch (e) { return []; }
  }
  function persist() { localStorage.setItem(STORE_KEY, JSON.stringify(tasks)); }
  function uid() {
    return crypto.randomUUID ? crypto.randomUUID()
      : "T-" + Date.now().toString(16) + Math.random().toString(16).slice(2, 8);
  }
  function now() { return new Date().toISOString(); }
  function addLog(task, text) { task.log.push({ at: now(), text }); }

  /** open 待执行（未结束） / diving 已下潜（结束，留档） / withdrawn 已撤回（结束） */
  const OPEN = ["open"];
  function isOpen(task) { return OPEN.includes(task.status); }
  function list() { return tasks.slice(); }
  function openFor(contactId) { return tasks.find(t => t.contactId === contactId && isOpen(t)) || null; }

  /** 生成下水任务；同一接触点已有未结束任务时拒绝 */
  function create({ contact, dive, applicant }) {
    const d = String(dive == null ? "" : dive).trim();
    const a = String(applicant == null ? "" : applicant).trim();
    if (!contact) return { ok: false, code: "INVALID", message: "请选择接触点" };
    if (!d) return { ok: false, code: "INVALID", message: "请填写潜次" };
    if (!a) return { ok: false, code: "INVALID", message: "请填写申报人" };
    if (contact.status !== "confirmed")
      return { ok: false, code: "NOT_CONFIRMED", message: "接触点尚未确认异常，不能生成任务" };
    if (openFor(contact.id))
      return { ok: false, code: "OPEN_EXISTS", message: "该接触点已有一条未结束任务" };

    const task = {
      id: uid(),
      contactId: contact.id,
      dive: d,
      applicant: a,
      status: "open",
      rescheduleCount: 0,
      changeNote: "",
      snapshot: null,
      createdAt: now(),
      startedAt: null,
      endedAt: null,
      withdrawReason: "",
      log: []
    };
    addLog(task, `生成下水任务：${contact.line}/${contact.target}，潜次 ${d}，申报人 ${a}`);
    tasks.push(task);
    persist();
    return { ok: true, task };
  }

  /** 撤回未结束任务，原因必填 */
  function withdraw(id, reason) {
    const task = tasks.find(t => t.id === id);
    if (!task) return { ok: false, code: "NOT_FOUND" };
    if (!isOpen(task)) return { ok: false, code: "FINISHED", message: "任务已结束，不能撤回" };
    const r = String(reason == null ? "" : reason).trim();
    if (!r) return { ok: false, code: "REASON_REQUIRED", message: "撤回必须填写原因" };
    task.status = "withdrawn";
    task.withdrawReason = r;
    task.endedAt = now();
    addLog(task, `任务撤回：${r}`);
    persist();
    return { ok: true, task };
  }

  /** 登记下潜：任务结束，按当时资料留档；后续接触点改动不再影响该任务 */
  function markDived(id, note) {
    const task = tasks.find(t => t.id === id);
    if (!task) return { ok: false, code: "NOT_FOUND" };
    if (!isOpen(task)) return { ok: false, code: "FINISHED", message: "任务已结束" };
    const snap = Judgment.snapshot(task.contactId);
    if (!snap) return { ok: false, code: "CONTACT_GONE", message: "接触点已不存在" };
    task.status = "diving";
    task.snapshot = Object.assign({ contactId: task.contactId }, snap);
    task.startedAt = now();
    task.endedAt = task.startedAt;
    addLog(task, `已下潜，资料留档：${snap.line}/${snap.target} (${snap.x.toFixed(1)}, ${snap.y.toFixed(1)})` +
      (note ? `；备注：${String(note).trim()}` : ""));
    persist();
    return { ok: true, task };
  }

  /** 重排后重新排入待执行队列（保留重排痕迹，排到队尾） */
  function reschedule(id) {
    const task = tasks.find(t => t.id === id);
    if (!task || !isOpen(task)) return { ok: false, code: "NOT_ALLOWED" };
    tasks = tasks.filter(t => t.id !== id);
    tasks.push(task);
    addLog(task, "按最新资料重新排入任务队列");
    persist();
    return { ok: true, task };
  }

  /**
   * 接触点资料变更回调（由 judgment.onChange 触发）。
   * 仅测线或坐标改动才重排未结束任务；置信等级变化不触发。
   * 已下潜 / 已撤回的结束任务一律留档不动。
   */
  function handleContactChange(contact, changes) {
    if (!changes.coordChanged && !changes.lineChanged) return { affected: 0 };
    const reason = changes.lineChanged && changes.coordChanged ? "测线与坐标已变更"
      : changes.lineChanged ? "测线已变更" : "坐标已变更";
    let affected = 0;
    tasks.filter(t => t.contactId === contact.id && isOpen(t)).forEach(task => {
      affected += 1;
      task.rescheduleCount += 1;
      task.changeNote = reason;
      addLog(task, `${reason}，未结束任务待重排（第 ${task.rescheduleCount} 次）`);
      const moved = tasks.splice(tasks.indexOf(task), 1)[0];
      tasks.push(moved);
    });
    if (affected) persist();
    return { affected, reason };
  }

  Judgment.onChange(handleContactChange);

  return { create, withdraw, markDived, reschedule, list, openFor, handleContactChange };
})();

/**
 * 页面业务（page.js）
 * 只负责界面渲染与交互：声呐回传登记表、复核台、下水任务板、平面图标记。
 * 判定规则全部走 Judgment，任务规则全部走 Tasks，本文件不写业务裁决。
 */
(function () {
  const $ = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));
  const esc = v => String(v == null ? "" : v).replace(/[&<>"']/g, s =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[s]));
  const fmt = iso => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("zh-CN", {
      month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false
    });
  };

  const map = $("#map");
  const app = $("#app");
  const intakeForm = $("#intakeForm");
  const contactFilter = $("#contactFilter");
  const contactList = $("#contactList");
  const taskForm = $("#taskForm");
  const contactSelect = $("#t-contact");
  const openList = $("#openList");
  const doneList = $("#doneList");

  const STATUS = {
    pending: { text: "待复核", cls: "st-pending" },
    confirmed: { text: "已确认", cls: "st-confirmed" },
    dismissed: { text: "已排除", cls: "st-dismissed" }
  };
  const TASK_STATUS = {
    open: { text: "待执行", cls: "t-open" },
    diving: { text: "已下潜留档", cls: "t-diving" },
    withdrawn: { text: "已撤回", cls: "t-withdrawn" }
  };
  const confCls = c => ({ 高: "conf-h", 中: "conf-m", 低: "conf-l" }[c] || "conf-m");

  const state = { selectedId: null, editId: null, tab: "review", taskContactId: "" };

  /* ---------- 首次使用的演示数据 ---------- */
  function seedIfEmpty() {
    if (localStorage.getItem("arch.judgment.v1")) return;
    const a = Judgment.ingest({ line: "L-03", target: "S-017", x: 42, y: 46, confidence: "高" }).contact;
    Judgment.decide(a.id, "confirm");
    const b = Judgment.ingest({ line: "L-03", target: "S-022", x: 58, y: 39, confidence: "中" }).contact;
    Judgment.decide(b.id, "confirm");
    const c = Judgment.ingest({ line: "L-05", target: "S-031", x: 30, y: 62, confidence: "低" }).contact;
    Judgment.decide(c.id, "confirm");
    Judgment.ingest({ line: "L-05", target: "S-045", x: 70, y: 74, confidence: "低" });
    const e = Judgment.ingest({ line: "L-07", target: "S-052", x: 64, y: 28, confidence: "中" }).contact;
    Judgment.decide(e.id, "dismiss");

    Tasks.create({ contact: a, dive: "DIVE-04", applicant: "林舟" });
    Tasks.create({ contact: c, dive: "DIVE-04", applicant: "赵潜" });
    Tasks.markDived(c.id, "船肋边缘定位");
    Judgment.propose(c.id, { line: "L-05", x: 31.5, y: 60.2, confidence: "低" }); // 已下潜，留档不动

    Tasks.create({ contact: b, dive: "DIVE-05", applicant: "林舟" });
    Tasks.handleContactChange(b, { lineChanged: false, coordChanged: true, confidenceChanged: false }); // 演示待重排
    state.selectedId = a.id;
  }

  /* ---------- 提示条 ---------- */
  let toastTimer = null;
  function toast(text, kind) {
    const box = $("#toast");
    box.textContent = text;
    box.className = "show " + (kind || "ok");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { box.className = ""; }, 3200);
  }
  function notify(res, okText) {
    if (res.ok) { if (okText) toast(okText); }
    else toast(res.message || "操作未成功", "warn");
  }

  /* ---------- 渲染 ---------- */
  function render() {
    renderMap();
    renderContacts();
    renderTaskForm();
    renderTasks();
  }

  function renderMap() {
    map.querySelectorAll(".marker").forEach(el => el.remove());
    const f = contactFilter.value;
    Judgment.list()
      .filter(c => !f || c.status === f)
      .forEach(c => {
        const el = document.createElement("button");
        el.type = "button";
        el.className = "marker " + confCls(c.confidence) +
          (c.status === "pending" ? " mp" : "") +
          (c.status === "dismissed" ? " md" : "") +
          (c.revision ? " proposed" : "") +
          (c.id === state.selectedId ? " selected" : "");
        el.style.left = c.x + "%";
        el.style.top = c.y + "%";
        el.title = `${c.line}/${c.target} · ${c.confidence}置信`;
        el.textContent = esc(c.target.replace(/^S-?/, ""));
        el.onclick = ev => { ev.stopPropagation(); selectContact(c.id); };
        map.appendChild(el);
      });
  }

  function pill(meta) { return `<span class="pill ${meta.cls}">${meta.text}</span>`; }
  function coord(c) { return `(${Number(c.x).toFixed(1)}, ${Number(c.y).toFixed(1)})`; }

  function revisionBox(c) {
    const r = c.revision;
    const chgLine = r.line !== c.line, chgXY = r.x !== c.x || r.y !== c.y, chgConf = r.confidence !== c.confidence;
    return `<div class="revbox">
      <div class="muted"><b>新资料待复核</b> · ${fmt(r.at)}（原记录继续有效）</div>
      <div class="${chgLine ? "chg" : "muted"}">测线：${esc(r.line)}</div>
      <div class="${chgXY ? "chg" : "muted"}">坐标：(${r.x.toFixed(1)}, ${r.y.toFixed(1)})</div>
      <div class="${chgConf ? "chg" : "muted"}">置信：${esc(r.confidence)}</div>
      <div class="row">
        <button type="button" data-act="adopt" data-id="${c.id}">采用新资料</button>
        <button type="button" class="secondary" data-act="keep" data-id="${c.id}">维持原记录</button>
      </div>
    </div>`;
  }

  function editBox(c) {
    return `<div class="revbox">
      <label>测线号</label><input data-edit="line" value="${esc(c.line)}">
      <label>坐标 X</label><input data-edit="x" type="number" step="0.1" value="${c.x}">
      <label>坐标 Y</label><input data-edit="y" type="number" step="0.1" value="${c.y}">
      <label>置信等级</label><select data-edit="confidence">
        ${Judgment.LEVELS.map(l => `<option ${l === c.confidence ? "selected" : ""}>${l}</option>`).join("")}
      </select>
      <div class="row">
        <button type="button" data-act="save-edit" data-id="${c.id}">提交更正</button>
        <button type="button" class="secondary" data-act="cancel-edit">取消</button>
      </div>
    </div>`;
  }

  function actionButtons(c, openTask) {
    if (state.editId === c.id) return "";
    if (c.revision) return ""; // 有新资料时优先处理采用/维持
    const btns = [];
    if (c.status === "pending") {
      btns.push(`<button type="button" data-act="confirm" data-id="${c.id}">确认异常</button>`);
      btns.push(`<button type="button" class="secondary" data-act="dismiss" data-id="${c.id}">排除</button>`);
      btns.push(`<button type="button" class="secondary" data-act="propose" data-id="${c.id}">资料更正</button>`);
    } else if (c.status === "confirmed") {
      btns.push(openTask
        ? `<button type="button" disabled title="同一接触点只留一条未结束任务">已在任务队列</button>`
        : `<button type="button" data-act="to-task" data-id="${c.id}">生成下水任务</button>`);
      btns.push(`<button type="button" class="secondary" data-act="propose" data-id="${c.id}">资料更正</button>`);
    } else if (c.status === "dismissed") {
      btns.push(`<button type="button" data-act="reopen" data-id="${c.id}">重新判定</button>`);
    }
    return `<div class="row">${btns.join("")}</div>`;
  }

  function renderContacts() {
    const f = contactFilter.value;
    const data = Judgment.list()
      .filter(c => !f || c.status === f)
      .sort((a, b) => (a.line + a.target).localeCompare(b.line + b.target, "zh-CN"));
    if (!data.length) {
      contactList.innerHTML = `<div class="muted empty">没有符合条件的接触点</div>`;
      return;
    }
    contactList.innerHTML = data.map(c => {
      const openTask = Tasks.openFor(c.id);
      const last = c.log[c.log.length - 1];
      return `<div class="item contact ${c.id === state.selectedId ? "active" : ""}" data-contact="${c.id}">
        <div class="item-head"><b>${esc(c.line)} / ${esc(c.target)}</b>
          ${pill(STATUS[c.status])}<span class="pill ${confCls(c.confidence)}">${esc(c.confidence)}置信</span>
        </div>
        <div class="muted">坐标 ${coord(c)}${openTask ? ` · <b>在办：${esc(openTask.dive)}</b>` : ""}</div>
        ${state.editId === c.id ? editBox(c) : (c.revision ? revisionBox(c) : "")}
        ${actionButtons(c, openTask)}
        <div class="muted logline">${last ? esc(last.text) : ""}</div>
      </div>`;
    }).join("");
  }

  function renderTaskForm() {
    const contacts = Judgment.list().filter(c => c.status === "confirmed");
    const current = state.taskContactId && contacts.some(c => c.id === state.taskContactId)
      ? state.taskContactId : (contacts[0] && contacts[0].id) || "";
    state.taskContactId = current;
    contactSelect.innerHTML = contacts.length
      ? contacts.map(c => {
        const rev = c.revision ? "（待复核）" : "";
        const busy = Tasks.openFor(c.id) ? "（已有在办任务）" : "";
        return `<option value="${c.id}" ${c.id === current ? "selected" : ""}
          ${Tasks.openFor(c.id) ? "disabled" : ""}>${esc(c.line)} / ${esc(c.target)}${rev}${busy}</option>`;
      }).join("")
      : `<option value="">暂无已确认接触点</option>`;
  }

  function taskItem(t) {
    const c = Judgment.get(t.contactId);
    const name = c ? `${c.line} / ${c.target}` : "接触点已删除";
    const head = `<div class="item-head"><b>${esc(t.dive)}</b> · ${esc(name)} ${pill(TASK_STATUS[t.status])}</div>`;
    const info = `<div class="muted">申报人：${esc(t.applicant)} · 建单 ${fmt(t.createdAt)}</div>`;
    let body = "";
    if (t.status === "open") {
      const live = c ? coord(c) : "—";
      body = `<div class="muted">当前坐标 ${live}${t.rescheduleCount ? ` · 已重排 ${t.rescheduleCount} 次（${esc(t.changeNote)}）` : ""}</div>
        <div class="row">
          <button type="button" data-act="dived" data-id="${t.id}">登记下潜</button>
          <button type="button" class="secondary" data-act="withdraw" data-id="${t.id}">撤回</button>
          ${t.rescheduleCount ? `<button type="button" class="secondary" data-act="reschedule" data-id="${t.id}">重新排入队列</button>` : ""}
        </div>`;
    } else if (t.status === "diving") {
      const s = t.snapshot;
      body = `<div class="muted">留档：${esc(s.line)} / ${esc(s.target)} (${s.x.toFixed(1)}, ${s.y.toFixed(1)}) · ${esc(s.confidence)}置信 · ${fmt(t.startedAt)}</div>`;
    } else {
      body = `<div class="muted">撤回原因：${esc(t.withdrawReason)} · ${fmt(t.endedAt)}</div>`;
    }
    return `<div class="item task">${head}${info}${body}</div>`;
  }

  function renderTasks() {
    const all = Tasks.list();
    const open = all.filter(t => t.status === "open"); // 存储顺序即队列顺序，重排会排到队尾
    const done = all.filter(t => t.status !== "open")
      .sort((a, b) => String(b.endedAt).localeCompare(String(a.endedAt)));
    openList.innerHTML = open.length ? open.map(taskItem).join("")
      : `<div class="muted empty">没有未结束任务</div>`;
    doneList.innerHTML = done.length ? done.map(taskItem).join("")
      : `<div class="muted empty">暂无已下潜或已撤回记录</div>`;
  }

  /* ---------- 交互 ---------- */
  function selectContact(id) {
    state.selectedId = id;
    switchTab("review");
    render();
    const el = contactList.querySelector(`[data-contact="${id}"]`);
    if (el) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function switchTab(tab) {
    state.tab = tab;
    app.classList.toggle("show-tasks", tab === "tasks");
    $$(".tab").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  }

  // 平面图取坐标
  map.addEventListener("click", event => {
    if (event.target.closest(".marker")) return;
    const rect = map.getBoundingClientRect();
    const x = Math.min(100, Math.max(0, Number(((event.clientX - rect.left) / rect.width * 100).toFixed(1))));
    const y = Math.min(100, Math.max(0, Number(((event.clientY - rect.top) / rect.height * 100).toFixed(1))));
    $("#f-x").value = x;
    $("#f-y").value = y;
    toast(`已取坐标 (${x}, ${y})`);
  });

  // 声呐回传登记
  intakeForm.addEventListener("submit", event => {
    event.preventDefault();
    const res = Judgment.ingest({
      line: $("#f-line").value, target: $("#f-target").value,
      x: $("#f-x").value, y: $("#f-y").value, confidence: $("#f-confidence").value
    });
    if (!res.ok) { notify(res); return; }
    state.selectedId = res.contact.id;
    intakeForm.reset();
    $("#f-confidence").value = "中";
    render();
    if (res.type === "reused") toast("同线同编号重传，资料一致，沿用首次结果");
    else if (res.type === "revision") toast("资料变化，已转待复核；原记录继续有效", "warn");
    else toast("接触点已登记，等待复核");
  });

  // 复核台操作（事件委托）
  contactList.addEventListener("click", event => {
    const btn = event.target.closest("button[data-act]");
    if (!btn) return;
    event.stopPropagation();
    const id = btn.dataset.id;
    switch (btn.dataset.act) {
      case "confirm": notify(Judgment.decide(id, "confirm"), "已确认异常，可生成下水任务"); break;
      case "dismiss": notify(Judgment.decide(id, "dismiss"), "已排除该目标"); break;
      case "reopen": notify(Judgment.reopen(id), "已重新进入待复核"); break;
      case "adopt": {
        const resAdopt = Judgment.adopt(id);
        if (!resAdopt.ok) { notify(resAdopt); break; }
        toast("已采用新资料");
        break;
      }
      case "keep": notify(Judgment.keep(id), "已维持原记录"); break;
      case "propose": state.editId = id; renderContacts(); return;
      case "cancel-edit": state.editId = null; renderContacts(); return;
      case "save-edit": {
        const box = btn.closest(".revbox");
        const res = Judgment.propose(id, {
          line: box.querySelector('[data-edit="line"]').value,
          x: box.querySelector('[data-edit="x"]').value,
          y: box.querySelector('[data-edit="y"]').value,
          confidence: box.querySelector('[data-edit="confidence"]').value
        });
        state.editId = null;
        notify(res, res.ok ? "资料更正已提交，待复核；原记录继续有效" : "");
        break;
      }
      case "to-task":
        state.taskContactId = id;
        switchTab("tasks");
        renderTaskForm();
        $("#t-dive").focus();
        return;
      default: return;
    }
    render();
  });

  // 点条目本身选中
  contactList.addEventListener("click", event => {
    const item = event.target.closest("[data-contact]");
    if (!item || event.target.closest("button,input,select")) return;
    state.selectedId = item.dataset.contact;
    renderContacts();
    renderMap();
  });

  // 生成下水任务
  taskForm.addEventListener("submit", event => {
    event.preventDefault();
    const contact = Judgment.get(contactSelect.value);
    const res = Tasks.create({ contact, dive: $("#t-dive").value, applicant: $("#t-applicant").value });
    if (!res.ok) { notify(res); return; }
    $("#t-dive").value = "";
    $("#t-applicant").value = "";
    state.taskContactId = contact.id;
    render();
    toast(`下水任务已生成：${contact.line}/${contact.target} · ${res.task.dive}`);
  });

  // 任务板操作
  function taskListHandler(event) {
    const btn = event.target.closest("button[data-act]");
    if (!btn) return;
    const id = btn.dataset.id;
    let res;
    if (btn.dataset.act === "withdraw") {
      const reason = window.prompt("请填写撤回原因：");
      if (reason === null) return;
      res = Tasks.withdraw(id, reason);
    } else if (btn.dataset.act === "dived") {
      res = Tasks.markDived(id, "");
    } else if (btn.dataset.act === "reschedule") {
      res = Tasks.reschedule(id);
    } else return;
    notify(res, btn.dataset.act === "dived" ? "已登记下潜，资料已留档"
      : btn.dataset.act === "reschedule" ? "已重新排入任务队列" : "任务已撤回");
    render();
  }
  openList.addEventListener("click", taskListHandler);
  doneList.addEventListener("click", taskListHandler);

  // 接触点资料变更后提示任务重排（Tasks 的监听器先注册先执行重排；这里仅提示）
  // 先于启动注册，保证包括首次演示数据在内的变更都能走到。
  Judgment.onChange((contact, changes) => {
    if (!changes.coordChanged && !changes.lineChanged) return;
    const n = Tasks.list().filter(t => t.contactId === contact.id && t.status === "open").length;
    if (n) toast(`${n} 条未结束任务因测线/坐标改动已重排，已挪到队列末尾；已下潜任务留档不变`, "warn");
  });

  // 筛选与页签
  contactFilter.addEventListener("change", render);
  $$(".tab").forEach(b => b.addEventListener("click", () => { switchTab(b.dataset.tab); render(); }));

  // 导出
  $("#exportBtn").addEventListener("click", () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      contacts: Judgment.list(),
      tasks: Tasks.list()
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "sonar-review-tasks.json";
    a.click();
    URL.revokeObjectURL(a.href);
  });

  /* ---------- 启动 ---------- */
  seedIfEmpty();
  switchTab("review");
  render();
})();

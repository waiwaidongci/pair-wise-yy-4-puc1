/*
 * 页面业务文件（page.js）
 * 声呐复核台界面：只负责采集输入、调用任务业务并渲染；判定规则不下沉到这里。
 */
(function (global) {
  "use strict";

  const T = global.ReviewTasks;
  const J = global.ReviewJudgment;

  const $ = sel => document.querySelector(sel);
  const contactForm = $("#contactForm");
  const taskForm = $("#taskForm");
  const queueEl = $("#queue");
  const ledgerEl = $("#ledger");
  const taskListEl = $("#taskList");
  const toastEl = $("#toast");

  const CONTACT_STATUS = {
    pending: ["待复核", "warn"],
    approved: ["已通过", "ok"],
    rejected: ["已排除", "bad"]
  };
  const TASK_STATUS = {
    planned: ["待下潜", "ok"],
    rescheduled: ["待重排", "warn"],
    dived: ["已下潜·留档", "neutral"],
    withdrawn: ["已撤回", "bad"]
  };

  function esc(v) {
    return String(v ?? "").replace(/[&<>"']/g, s =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[s]));
  }
  function pill(text, kind) {
    return '<span class="pill ' + kind + '">' + esc(text) + "</span>";
  }
  function fmtTime(iso) {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("zh-CN", { hour12: false });
  }
  function coord(c) {
    return esc(c.lon.toFixed(4)) + ", " + esc(c.lat.toFixed(4));
  }
  function toast(msg, ok) {
    toastEl.textContent = msg;
    toastEl.className = "toast show " + (ok === false ? "error" : "");
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toastEl.classList.remove("show"), 2600);
  }
  function handle(fn) {
    try {
      const msg = fn();
      render();
      if (msg) toast(msg);
    } catch (err) {
      toast(err.message, false);
    }
  }

  function historyHtml(contact) {
    return contact.history.slice().reverse().map(h =>
      '<div class="hist"><span class="muted">' + fmtTime(h.at) + "</span><div>" + esc(h.text) + "</div></div>"
    ).join("");
  }

  // ---- 待复核队列：首次结果 + 待采纳新资料 ----
  function renderQueue() {
    const items = [];
    T.contacts.forEach(c => {
      // 首次结果与变更资料并存时，只显示变更卡片，避免两条操作入口
      if (c.status === "pending" && !c.pending) items.push({ kind: "first", contact: c });
      if (c.pending) items.push({ kind: "revision", contact: c });
    });
    items.sort((a, b) => {
      const ta = a.kind === "first" ? a.contact.createdAt : a.contact.pending.at;
      const tb = b.kind === "first" ? b.contact.createdAt : b.contact.pending.at;
      return ta < tb ? 1 : -1;
    });
    if (!items.length) {
      queueEl.innerHTML = '<p class="muted empty">暂无待复核项。先在左侧登记声呐目标。</p>';
      return;
    }
    queueEl.innerHTML = items.map(item => {
      const c = item.contact;
      if (item.kind === "first") {
        const d = c.effective;
        return '<div class="card"><div class="card-head"><b>' + esc(c.effective.line + " / " + c.effective.target) +
          '</b> ' + pill("首次结果", "warn") +
          '</div><div class="kv"><span>坐标</span><b>' + coord(d) + '</b></div>' +
          '<div class="kv"><span>置信等级</span><b>' + esc(J.CONFIDENCE_LABELS[d.confidence]) + '</b></div>' +
          '<div class="kv"><span>水深</span><b>' + esc(d.depth || "—") + '</b></div>' +
          '<div class="note muted">备注：' + esc(d.note || "—") + " · " + fmtTime(c.createdAt) + '</div>' +
          '<div class="actions"><button data-act="approve" data-id="' + c.id + '">复核通过</button>' +
          '<button class="danger" data-act="reject" data-id="' + c.id + '">判为干扰</button></div></div>';
      }
      const rows = J.diffFields(c.effective, c.pending)
        .filter(r => r.changed)
        .map(r => '<div class="diffrow"><span>' + esc(r.label) + '</span><s>' + esc(r.oldV) +
          '</s><b class="arrow">' + esc(r.newV) + "</b></div>").join("");
      return '<div class="card"><div class="card-head"><b>' + esc(c.effective.line + " / " + c.effective.target) +
        '</b> ' + pill("资料变化·待复核", "warn") + pill("原记录有效", "neutral") + '</div>' +
        '<div class="diff">' + (rows || '<div class="muted">资料内容一致</div>') + '</div>' +
        '<div class="note muted">重传时间：' + fmtTime(c.pending.at) +
        ' · 备注：' + esc(c.pending.note || "—") + '</div>' +
        '<div class="actions"><button data-act="adopt" data-id="' + c.id + '">采纳新资料</button>' +
        '<button class="secondary" data-act="keep" data-id="' + c.id + '">维持原记录</button></div></div>';
    }).join("");
  }

  // ---- 接触点台账 ----
  function renderLedger() {
    const list = T.contacts.slice().sort((a, b) => a.updatedAt < b.updatedAt ? 1 : -1);
    if (!list.length) {
      ledgerEl.innerHTML = '<p class="muted empty">还没有接触点。</p>';
      return;
    }
    ledgerEl.innerHTML = list.map(c => {
      const d = c.effective;
      const [label, kind] = CONTACT_STATUS[c.status];
      const open = T.openTaskOf(c.id);
      return '<div class="card"><div class="card-head"><b>' + esc(c.effective.line + " / " + c.effective.target) +
        '</b> ' + pill(label, kind) + (c.pending ? pill("待复核", "warn") : "") + '</div>' +
        '<div class="kv"><span>坐标</span><b>' + coord(d) + '</b></div>' +
        '<div class="kv"><span>置信等级</span><b>' + esc(J.CONFIDENCE_LABELS[d.confidence]) + '</b></div>' +
        '<div class="kv"><span>下水任务</span><b>' + (open ? esc(open.dive || T.STATUS_LABELS.rescheduled) + "（" + esc(T.STATUS_LABELS[open.status]) + "）" : "无未结束任务") + '</b></div>' +
        '<details><summary class="muted">处理留痕（' + c.history.length + "）</summary><div class='history'>" + historyHtml(c) + "</div></details></div>";
    }).join("");
  }

  // ---- 下水任务 ----
  function contactOptions() {
    return T.contacts
      .filter(c => c.status === "approved")
      .map(c => {
        const blocked = Boolean(T.openTaskOf(c.id)) || Boolean(c.pending);
        return '<option value="' + c.id + '"' + (blocked ? " disabled" : "") + ">" +
          esc(c.effective.line + " / " + c.effective.target + "（" + coord(c.effective) + "）") +
          (blocked ? "（已有未结束任务）" : "") + "</option>";
      }).join("");
  }

  function renderTasks() {
    $("#contactSelect").innerHTML =
      '<option value="">选择已复核通过的接触点</option>' + contactOptions();
    const list = T.tasks.slice().sort((a, b) => a.createdAt < b.createdAt ? 1 : -1);
    if (!list.length) {
      taskListEl.innerHTML = '<p class="muted empty">还没有下水任务。</p>';
      return;
    }
    taskListEl.innerHTML = list.map(t => {
      const c = T.contactOf(t);
      const name = c ? c.effective.line + " / " + c.effective.target : "接触点已删除";
      const [label, kind] = TASK_STATUS[t.status];
      const open = T.OPEN_STATES.includes(t.status);
      let body = '<div class="kv"><span>接触点</span><b>' + esc(name) + " · " +
        (c ? coord(c.effective) : "—") + "</b></div>" +
        '<div class="kv"><span>潜次</span><b>' + esc(t.dive || "待重排") +
        (t.previousDive ? ' <span class="muted">（原 ' + esc(t.previousDive) + "）</span>" : "") + "</b></div>" +
        '<div class="kv"><span>申报人</span><b>' + esc(t.applicant) + "</b></div>";
      if (t.status === "withdrawn") body += '<div class="kv"><span>撤回原因</span><b>' + esc(t.reason) + "</b></div>";
      let actions = "";
      if (t.status === "planned") {
        actions = '<button data-act="dive" data-id="' + t.id + '">确认已下潜</button>' +
          '<input data-reason="' + t.id + '" placeholder="撤回原因（必填）">' +
          '<button class="danger" data-act="withdraw" data-id="' + t.id + '">撤回</button>';
      } else if (t.status === "rescheduled") {
        actions = '<input data-dive="' + t.id + '" placeholder="重排后潜次，如 DIVE-08">' +
          '<button data-act="replan" data-id="' + t.id + '">确认重排</button>' +
          '<input data-reason="' + t.id + '" placeholder="撤回原因（必填）">' +
          '<button class="danger" data-act="withdraw" data-id="' + t.id + '">撤回</button>';
      } else {
        actions = '<span class="muted">' + (t.status === "dived" ? "已下潜记录留档，不再变动" : "任务已结束") +
          " · " + fmtTime(t.updatedAt) + "</span>";
      }
      return '<div class="card"><div class="card-head"><b>' + esc(name) + "</b> " + pill(label, kind) + "</div>" +
        body + '<div class="actions ' + (open ? "grid" : "") + '">' + actions + "</div></div>";
    }).join("");
  }

  function render() {
    renderQueue();
    renderLedger();
    renderTasks();
  }

  // ---- 事件 ----
  contactForm.addEventListener("submit", e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(contactForm).entries());
    handle(() => {
      const r = T.submit(f);
      contactForm.reset();
      $("#confidenceDefault").selected = true;
      if (r.outcome === "new") return "已登记 " + r.contact.line + " / " + r.contact.target + "，等待复核";
      if (r.outcome === "repeat") return "同线同编号重传，资料一致，沿用首次结果";
      return "资料变化，已转待复核；原记录继续有效";
    });
  });

  taskForm.addEventListener("submit", e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(taskForm).entries());
    handle(() => {
      const t = T.createTask(f);
      taskForm.reset();
      return "下水任务已生成：" + t.dive;
    });
  });

  document.body.addEventListener("click", e => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const { act, id } = btn.dataset;

    if (act === "approve" || act === "reject" || act === "adopt" || act === "keep") {
      handle(() => {
        const action = (act === "approve" || act === "adopt") ? "approve" : "reject";
        const v = T.adjudicate(id, action);
        if (act === "adopt") {
          return v.reschedule
            ? "已采纳新资料；" + v.rescheduled + " 条未结束任务转待重排，已下潜任务留档"
            : "已采纳新资料，未结束任务无需调整";
        }
        if (act === "keep") return "已维持原记录";
        return act === "approve" ? "复核通过，可生成下水任务" : "已判为声呐干扰";
      });
      return;
    }

    if (act === "withdraw") {
      const reason = document.querySelector('[data-reason="' + id + '"]')?.value || "";
      handle(() => {
        T.withdrawTask(id, reason);
        return "任务已撤回并记录原因";
      });
      return;
    }

    if (act === "replan") {
      const dive = document.querySelector('[data-dive="' + id + '"]')?.value || "";
      handle(() => {
        const t = T.replanTask(id, dive);
        return "已重排至 " + t.dive;
      });
      return;
    }

    if (act === "dive") {
      if (!global.confirm("确认该任务已完成下潜？确认后将留档，不再随测线/坐标改动变动。")) return;
      handle(() => {
        T.completeTask(id);
        return "已标记下潜，任务留档";
      });
    }
  });

  $("#exportBtn").addEventListener("click", () => {
    const blob = new Blob([T.exportJson()], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "review-tasks.json";
    a.click();
    URL.revokeObjectURL(a.href);
  });

  render();
})(window);

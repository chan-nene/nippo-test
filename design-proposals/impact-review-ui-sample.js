(() => {
  "use strict";

  const root = document.documentElement;
  const views = Array.from(document.querySelectorAll("[data-view]"));
  const viewButtons = Array.from(document.querySelectorAll("[data-view-target]"));
  const navButtons = Array.from(document.querySelectorAll(".nav-item[data-view-target]"));
  const themeToggle = document.getElementById("themeToggle");
  const sidebarToggle = document.getElementById("sidebarToggle");
  const queueList = document.getElementById("queueList");
  const queueItems = Array.from(document.querySelectorAll(".queue-item"));
  const statusFilters = Array.from(document.querySelectorAll(".status-filter"));
  const reportDocument = document.getElementById("reportDocument");
  const changeSummary = document.getElementById("changeSummary");
  const diffToggle = document.getElementById("diffToggle");
  const reviewState = document.getElementById("reviewState");
  const confirmNext = document.getElementById("confirmNext");
  const progressBar = document.querySelector(".progress-track");
  const progressFill = document.getElementById("progressFill");
  const toast = document.getElementById("prototypeToast");
  let toastTimer = 0;
  let reviewedCount = 18;
  const totalCount = 23;

  function setView(name) {
    views.forEach((view) => view.classList.toggle("is-active", view.dataset.view === name));
    navButtons.forEach((button) => {
      const active = button.dataset.viewTarget === name;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    document.querySelector(`[data-view="${name}"]`)?.focus({ preventScroll: true });
  }

  viewButtons.forEach((button) => {
    button.addEventListener("click", () => setView(button.dataset.viewTarget));
  });

  sidebarToggle.addEventListener("click", () => {
    const collapsed = root.dataset.sidebar !== "collapsed";
    root.dataset.sidebar = collapsed ? "collapsed" : "expanded";
    sidebarToggle.setAttribute("aria-pressed", String(collapsed));
    sidebarToggle.setAttribute("aria-label", collapsed ? "サイドバーを展開する" : "サイドバーを折りたたむ");
  });

  function applyTheme(theme) {
    const dark = theme === "dark";
    root.dataset.theme = theme;
    themeToggle.setAttribute("aria-pressed", String(dark));
    themeToggle.setAttribute("aria-label", dark ? "ライトモードに切り替える" : "ダークモードに切り替える");
    const themeName = themeToggle.querySelector(".theme-name");
    if (themeName) themeName.textContent = dark ? "ダーク" : "ライト";
    document.querySelectorAll("[data-theme-choice]").forEach((choice) => {
      const selected = choice.dataset.themeChoice === theme;
      choice.classList.toggle("is-selected", selected);
      choice.setAttribute("aria-pressed", String(selected));
    });
  }

  themeToggle.addEventListener("click", () => applyTheme(root.dataset.theme === "dark" ? "light" : "dark"));
  document.querySelectorAll("[data-theme-choice]").forEach((choice) => {
    choice.addEventListener("click", () => applyTheme(choice.dataset.themeChoice));
  });

  function statusCopy(status) {
    if (status === "changed") return { label: "前回確認後に更新", className: "is-changed" };
    if (status === "missing") return { label: "まだ提出されていません", className: "is-missing" };
    return { label: "未確認", className: "is-unread" };
  }

  function selectQueueItem(item) {
    if (!item || item.hidden || item.dataset.state === "done") return;
    queueItems.forEach((candidate) => {
      const selected = candidate === item;
      candidate.classList.toggle("is-selected", selected);
      candidate.setAttribute("aria-pressed", String(selected));
    });

    document.getElementById("reportPerson").textContent = item.dataset.person;
    document.getElementById("reportInitial").textContent = item.dataset.initial;
    document.getElementById("reportRole").textContent = item.dataset.role;
    document.getElementById("reportWork").textContent = item.dataset.work || "入力されていません";
    document.getElementById("reportDetail").textContent = item.dataset.detail || "日報が提出されると、ここに業務詳細が表示されます。";
    document.getElementById("previousWork").textContent = item.dataset.previousWork || "—";
    document.getElementById("previousDetail").textContent = item.dataset.previousDetail || "—";

    const status = item.dataset.status;
    const copy = statusCopy(status);
    reviewState.className = `review-state ${copy.className}`;
    reviewState.querySelector("span").textContent = copy.label;
    changeSummary.hidden = status !== "changed";
    reportDocument.querySelectorAll(".report-field[data-field]").forEach((field) => {
      field.classList.toggle("is-changed", status === "changed");
    });
    reportDocument.classList.toggle("is-comparison-hidden", status !== "changed");

    confirmNext.disabled = status === "missing";
    confirmNext.setAttribute("aria-disabled", String(status === "missing"));
    confirmNext.querySelector(".button-label").textContent = status === "missing" ? "提出待ち" : "確認して次へ";
  }

  queueItems.forEach((item) => item.addEventListener("click", () => selectQueueItem(item)));

  statusFilters.forEach((button) => {
    button.addEventListener("click", () => {
      const filter = button.dataset.filter;
      statusFilters.forEach((candidate) => {
        const active = candidate === button;
        candidate.classList.toggle("is-active", active);
        candidate.setAttribute("aria-pressed", String(active));
      });
      queueItems.forEach((item) => {
        item.hidden = filter !== "all" && item.dataset.status !== filter;
      });
      const selected = queueItems.find((item) => item.classList.contains("is-selected") && !item.hidden && item.dataset.state !== "done");
      selectQueueItem(selected || queueItems.find((item) => !item.hidden && item.dataset.state !== "done"));
    });
  });

  diffToggle.addEventListener("click", () => {
    const hidden = reportDocument.classList.toggle("is-comparison-hidden");
    diffToggle.textContent = hidden ? "比較を表示" : "比較を閉じる";
    diffToggle.setAttribute("aria-expanded", String(!hidden));
  });

  function updateProgress() {
    const remaining = Math.max(0, totalCount - reviewedCount);
    document.getElementById("reviewedCount").textContent = String(reviewedCount);
    document.getElementById("remainingText").textContent = remaining ? `残り${remaining}件` : "すべて確認しました";
    progressBar.setAttribute("aria-valuenow", String(reviewedCount));
    progressFill.style.transform = `scaleX(${reviewedCount / totalCount})`;
    const navCount = document.querySelector(".nav-count");
    if (navCount) navCount.textContent = String(remaining);
  }

  function nextAvailableItem(current) {
    const start = Math.max(0, queueItems.indexOf(current) + 1);
    return queueItems.slice(start).find((item) => !item.hidden && item.dataset.state !== "done" && item.dataset.status !== "missing")
      || queueItems.find((item) => !item.hidden && item.dataset.state !== "done" && item.dataset.status !== "missing");
  }

  function confirmCurrent() {
    const current = queueItems.find((item) => item.classList.contains("is-selected"));
    if (!current || current.dataset.status === "missing" || confirmNext.dataset.state === "loading") return;
    confirmNext.dataset.state = "loading";
    confirmNext.querySelector(".button-label").textContent = "確認を保存中";
    window.setTimeout(() => {
      current.dataset.state = "done";
      current.setAttribute("aria-pressed", "false");
      current.querySelector(".queue-copy small").textContent = "8月19日・確認済み";
      current.querySelector(".queue-state").className = "queue-state";
      current.querySelector(".queue-state").innerHTML = '<svg aria-hidden="true"><use href="#i-check"/></svg>';
      reviewedCount = Math.min(totalCount, reviewedCount + 1);
      updateProgress();
      confirmNext.dataset.state = "success";
      confirmNext.querySelector(".button-label").textContent = "確認済み";
      window.setTimeout(() => {
        confirmNext.dataset.state = "default";
        selectQueueItem(nextAvailableItem(current));
      }, 480);
    }, 520);
  }

  confirmNext.addEventListener("click", confirmCurrent);
  document.addEventListener("keydown", (event) => {
    if (event.ctrlKey && event.key === "Enter" && document.querySelector('[data-view="review"]')?.classList.contains("is-active")) {
      event.preventDefault();
      confirmCurrent();
    }
  });

  document.getElementById("holdReview").addEventListener("click", () => {
    const current = queueItems.find((item) => item.classList.contains("is-selected"));
    selectQueueItem(nextAvailableItem(current));
  });

  function showToast(message) {
    window.clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.add("is-visible");
    toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 2200);
  }

  function bindRefresh(buttonId) {
    const button = document.getElementById(buttonId);
    if (!button) return;
    button.addEventListener("click", () => {
      button.dataset.state = "loading";
      const label = button.querySelector("span");
      if (label) label.textContent = "確認中";
      window.setTimeout(() => {
        button.dataset.state = "success";
        if (label) label.textContent = "最新です";
        showToast("ファイルサーバーの最新状態を読み込みました。");
        window.setTimeout(() => {
          button.dataset.state = "default";
          if (label) label.textContent = "最新の状態";
        }, 1200);
      }, 520);
    });
  }

  bindRefresh("refreshReview");
  bindRefresh("refreshTable");

  document.querySelectorAll(".editable-cell").forEach((cell) => {
    cell.addEventListener("input", () => {
      cell.classList.add("is-dirty");
      document.getElementById("saveTable").dataset.state = "default";
    });
  });

  function bindSave(buttonId, dirtySelector) {
    const button = document.getElementById(buttonId);
    if (!button) return;
    button.addEventListener("click", () => {
      if (button.dataset.state === "loading") return;
      const label = button.querySelector(".button-label");
      button.dataset.state = "loading";
      if (label) label.textContent = "保存中";
      window.setTimeout(() => {
        document.querySelectorAll(dirtySelector).forEach((item) => item.classList.remove("is-dirty"));
        button.dataset.state = "success";
        if (label) label.textContent = "保存しました";
        window.setTimeout(() => {
          button.dataset.state = "default";
          if (label) label.textContent = buttonId === "saveSettings" ? "設定を保存" : "変更を保存";
        }, 1400);
      }, 560);
    });
  }

  bindSave("saveTable", ".editable-cell.is-dirty");
  bindSave("saveSettings", ".settings-form .is-dirty");

  document.querySelectorAll(".filter-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      document.querySelectorAll(".filter-chip").forEach((candidate) => {
        const active = candidate === chip;
        candidate.classList.toggle("is-active", active);
        candidate.setAttribute("aria-pressed", String(active));
      });
    });
  });

  document.querySelectorAll(".segmented-control button").forEach((button) => {
    button.addEventListener("click", () => {
      button.closest(".segmented-control").querySelectorAll("button").forEach((candidate) => candidate.classList.toggle("is-active", candidate === button));
    });
  });

  document.querySelectorAll("[data-admin-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll("[data-admin-tab]").forEach((candidate) => {
        const active = candidate === button;
        candidate.classList.toggle("is-active", active);
        candidate.setAttribute("aria-pressed", String(active));
      });
      showToast(`${button.textContent.trim()}の編集画面に切り替えました。`);
    });
  });

  const previewParams = new URLSearchParams(window.location.search);
  const previewTheme = previewParams.get("theme");
  const previewView = previewParams.get("view");
  if (previewTheme === "dark" || previewTheme === "light") applyTheme(previewTheme);
  if (views.some((view) => view.dataset.view === previewView)) setView(previewView);
  selectQueueItem(queueItems[0]);
})();

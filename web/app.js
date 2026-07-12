const state = {
  employeeId: "",
  displayName: "",
  isSuperior: false,
  activeView: "daily",
  lastReportView: "daily",
  hasInitializedReportView: false,
  selectedSubordinateId: "",
  expandedReplies: new Set(),
  pendingReplyFocusKey: "",
  pendingEditTarget: null,

  rows: [],
  dirtyReports: new Map(),
  dirtyComments: new Map(),
  dirtyReportFields: new Set(),
  dirtyReplyKeys: new Set(),
  startDate: "",
  activePeriodPreset: "default",
  myRank: 9999,
  isBusy: false,
  busyAction: "",
  hideHolidays: false,
  showMissingCommentsOnly: false,
  missingCommentStartDate: "",
  commentSignature: "",
  darkMode: false,
  fontSize: "standard",
};

let currentEditingElement = null;
let uiStateSaveQueue = Promise.resolve();
let lastNativeUnsavedState = null;
const toastState = {
  hideTimer: null,
  fadeTimer: null,
  type: "",
};

const $ = (id) => document.getElementById(id);

window.addEventListener("pywebviewready", async () => {
  initializeTheme();
  updateSidebarToggleButton();
  bindEvents();
  syncChrome();
  updateViewChrome();
  const initial = await window.pywebview.api.get_initial_state();
  state.employeeId = initial.employee_id;
  syncCurrentUserName();
  fillSettings(initial.settings || {});
  restoreUiState(initial.settings || {});
  initializeDefaultDateRange();
  if (!initial.settings_complete) {
    showSettings(true);
    notify({ text: "初回設定を行ってください。", type: "info" });
    return;
  }
  await loadData();
});

function bindEvents() {
  $("saveSettingsButton").addEventListener("click", saveSettings);
  $("refreshButton").addEventListener("click", refreshData);
  $("saveButton").addEventListener("click", saveUpdates);
  $("openSettingsButton").addEventListener("click", () => switchView("settings"));
  $("toggleThemeButton").addEventListener("click", toggleTheme);
  $("fontSizeButton").addEventListener("click", toggleFontSizeMenu);
  $("fontSizeMenu").addEventListener("click", (event) => {
    const button = event.target.closest("[data-font-size]");
    if (button) setFontSize(button.dataset.fontSize);
  });
  $("defaultStartOffsetDays").addEventListener("input", updateDefaultRangePreview);
  $("defaultEndOffsetDays").addEventListener("input", updateDefaultRangePreview);
  $("startDate").addEventListener("change", handleDateChange);
  $("endDate").addEventListener("change", handleDateChange);

  const btnDefault = $("presetDefaultButton");
  if (btnDefault)
    btnDefault.addEventListener("click", () => applyPreset("default"));
  const btnToday = $("presetTodayButton");
  if (btnToday)
    btnToday.addEventListener("click", () => applyPreset("today"));
  const btnLast7 = $("presetLast7DaysButton");
  if (btnLast7)
    btnLast7.addEventListener("click", () => applyPreset("last7days"));
  const btnThisMonth = $("presetThisMonthButton");
  if (btnThisMonth)
    btnThisMonth.addEventListener("click", () => applyPreset("thisMonth"));

  const btnMissingComments = $("showMissingCommentsButton");
  if (btnMissingComments) {
    btnMissingComments.addEventListener("click", toggleMissingCommentsFilter);
  }

  $("showAllSubordinatesButton").addEventListener(
    "click",
    clearSubordinateFilters,
  );
  $("bossSearchControl").addEventListener("click", (e) => {
    const tag = e.target.closest(".member-switch-button[data-id]");
    if (tag) toggleSubordinateFilter(tag.dataset.id);
  });
  $("bossSearchControl").addEventListener(
    "wheel",
    (event) => {
      const list = event.currentTarget;
      if (list.scrollWidth <= list.clientWidth) return;
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      event.preventDefault();
      list.scrollLeft += event.deltaY;
    },
    { passive: false },
  );
  $("toggleSidebarButton").addEventListener("click", toggleSidebar);
  $("tableWrap").addEventListener("click", handleTableClick);
  $("tableWrap").addEventListener("keydown", handleTableKeydown);
  document.addEventListener("keydown", handleGlobalShortcut);
  $("dailyViewButton").addEventListener("click", () => switchView("daily"));
  $("bossViewButton").addEventListener("click", () => switchView("boss"));
  window.addEventListener("beforeunload", handleBeforeUnload);
  window.addEventListener("resize", positionToast);

  document.addEventListener("mousedown", (e) => {
    if (!e.target.closest("#fontSizeControl")) closeFontSizeMenu();
    finishEditingOnOutsideClick(e);
    // 編集モード中のボタン押下中は is-pressing を付けホバーを抑制
    if (currentEditingElement) document.body.classList.add("is-pressing");
  });
  document.addEventListener("mouseup", () =>
    document.body.classList.remove("is-pressing"),
  );
}

function clearSubordinateFilters() {
  state.selectedSubordinateId = "";
  updateSubordinateFilterUi();
  renderTable();
}

function toggleSubordinateFilter(employeeId) {
  if (!employeeId) return;
  state.selectedSubordinateId =
    state.selectedSubordinateId === employeeId ? "" : employeeId;
  updateSubordinateFilterUi();
  renderTable();
}

function toggleMissingCommentsFilter() {
  state.selectedSubordinateId = "";
  state.showMissingCommentsOnly = !state.showMissingCommentsOnly;
  updateSubordinateFilterUi();
  renderTable();
}

function updateSubordinateFilterUi() {
  const container = $("bossSearchControl");
  if (!container) return;

  const hasSelection = Boolean(state.selectedSubordinateId);
  const allButton = $("showAllSubordinatesButton");
  if (allButton) {
    const isAllActive = !hasSelection;
    allButton.classList.toggle("is-active", isAllActive);
    allButton.setAttribute("aria-pressed", String(isAllActive));
  }
  const missingButton = $("showMissingCommentsButton");
  if (missingButton) {
    syncMissingCommentCount();
    missingButton.classList.toggle("is-active", state.showMissingCommentsOnly);
    missingButton.setAttribute(
      "aria-pressed",
      String(state.showMissingCommentsOnly),
    );
  }

  container.querySelectorAll(".member-switch-button[data-id]").forEach((btn) => {
    const isActive = btn.dataset.id === state.selectedSubordinateId;
    btn.classList.toggle("is-active", isActive);
    btn.setAttribute("aria-pressed", String(isActive));
  });

  syncChrome();
}

function getDirtyCounts() {
  const reports = state.dirtyReports.size;
  const comments = state.dirtyComments.size;
  return {
    reports,
    comments,
    total: reports + comments,
  };
}

function syncChrome() {
  const model = getChromeModel();
  renderActionButtons(model.actions);
  syncPeriodPresets();
  syncNativeUnsavedState(model.dirty.total > 0);
  syncMissingCommentCount();
}

function syncNativeUnsavedState(hasUnsavedChanges) {
  if (lastNativeUnsavedState === hasUnsavedChanges) return;
  lastNativeUnsavedState = hasUnsavedChanges;
  const setter = window.pywebview?.api?.set_unsaved_changes;
  if (typeof setter !== "function") return;
  Promise.resolve(setter(hasUnsavedChanges)).catch(() => {
    lastNativeUnsavedState = null;
  });
}

function syncMissingCommentCount() {
  const button = $("showMissingCommentsButton");
  if (!button) return;
  const summary = getMissingCommentSummary();
  const label = document.createElement("span");
  label.className = "missing-filter-label";
  label.textContent = "未確認";
  const children = [label];
  if (summary.count > 0) {
    const badge = document.createElement("span");
    badge.className = `missing-count-badge${summary.hasOverdue ? " is-overdue" : ""}`;
    badge.textContent = `${summary.count}日`;
    badge.setAttribute("aria-hidden", "true");
    children.push(badge);
  }
  button.replaceChildren(...children);
  const description =
    summary.count > 0
      ? `未確認が残っている日を表示 ${summary.count}日${summary.hasOverdue ? "、過去日の未確認あり" : ""}`
      : "未確認が残っている日はありません";
  button.setAttribute("aria-label", description);
  button.title = description;
  button.classList.toggle("has-overdue", summary.hasOverdue);
}

function syncPeriodPresets() {
  const presets = {
    today: $("presetTodayButton"),
    last7days: $("presetLast7DaysButton"),
    thisMonth: $("presetThisMonthButton"),
    default: $("presetDefaultButton"),
  };
  Object.entries(presets).forEach(([name, button]) => {
    if (!button) return;
    const isActive = state.activePeriodPreset === name;
    button.disabled = state.isBusy;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  });
}

function getChromeModel() {
  const dirty = getDirtyCounts();
  return {
    dirty,
    actions: {
      refresh: getRefreshButtonModel(),
      save: getSaveButtonModel(dirty),
    },
  };
}

function getRefreshButtonModel() {
  if (state.busyAction === "load") {
    return {
      disabled: true,
      icon: "loader",
      label: "取得中...",
    };
  }

  return {
    disabled: state.isBusy,
    icon: "refresh",
    label: "最新データを取得",
  };
}

function getSaveButtonModel(dirty) {
  if (state.busyAction === "save") {
    return {
      disabled: true,
      icon: "loader",
      label: "保存中...",
    };
  }

  return {
    disabled: state.isBusy || dirty.total === 0,
    icon: "check",
    label: "保存",
    badge: dirty.total > 0 ? String(dirty.total) : "",
    ariaLabel: dirty.total > 0 ? `保存 未保存${dirty.total}件` : "保存",
  };
}

function renderActionButtons(actions) {
  renderActionButton("refreshButton", actions.refresh);
  renderActionButton("saveButton", actions.save);
}

function renderActionButton(id, model) {
  const button = $(id);
  if (!button) return;
  button.disabled = model.disabled;

  const icon = document.createElement("span");
  icon.className = "toolbar-button-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = renderToolbarIcon(model.icon);

  const label = document.createElement("span");
  label.className = "toolbar-button-label";
  label.textContent = model.label;
  const children = [icon, label];
  if (model.badge) {
    const badge = document.createElement("span");
    badge.className = "toolbar-button-badge";
    badge.setAttribute("aria-hidden", "true");
    badge.textContent = model.badge;
    children.push(badge);
  }
  if (model.ariaLabel) {
    button.setAttribute("aria-label", model.ariaLabel);
  } else {
    button.removeAttribute("aria-label");
  }
  button.replaceChildren(...children);
}

function renderToolbarIcon(icon) {
  const paths = {
    refresh: '<path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 4v6h-6" />',
    reset: '<path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v6h6" />',
    check: '<path d="m5 12 4 4L19 6" />',
    loader: '<path d="M21 12a9 9 0 0 1-9 9" /><path d="M3 12a9 9 0 0 1 9-9" />',
  };
  return `<svg class="${icon === "loader" ? "is-spinning" : ""}" viewBox="0 0 24 24">${paths[icon] || paths.check}</svg>`;
}

function fillSettings(settings) {
  $("usersDir").value = settings.users_dir || "";
  $("commentsDir").value = settings.comments_dir || "";
  $("commonDir").value = settings.common_dir || "";
  const startOffset = Number(settings.default_start_offset_days ?? -1);
  const endOffset = Number(settings.default_end_offset_days ?? 0);
  $("defaultStartOffsetDays").value = String(
    clampNumber(Math.abs(Math.min(0, startOffset)), 0, 14),
  );
  $("defaultEndOffsetDays").value = String(clampNumber(endOffset, 0, 7));
  $("missingCommentStartDate").value = settings.missing_comment_start_date || "";
  $("commentSignature").value = settings.comment_signature || "";
  state.hideHolidays = false;
  state.missingCommentStartDate = settings.missing_comment_start_date || "";
  state.commentSignature = settings.comment_signature || "";
  updateDefaultRangePreview();
}

function restoreUiState(settings) {
  const preset = ["default", "today", "last7days", "thisMonth", ""].includes(
    settings.ui_period_preset,
  )
    ? settings.ui_period_preset
    : "default";
  const range = getPresetRange(preset);
  state.activePeriodPreset = preset;
  state.startDate = preset
    ? range.startDate
    : String(settings.ui_start_date || "");
  state.endDate = preset ? range.endDate : String(settings.ui_end_date || "");
  state.hideHolidays = false;
  state.fontSize = ["standard", "large", "xlarge"].includes(
    settings.ui_font_size,
  )
    ? settings.ui_font_size
    : "standard";

  const sidebar = $("sidebar");
  const isSidebarOpen = settings.ui_sidebar_open !== false;
  sidebar.classList.toggle("is-open", isSidebarOpen);
  updateSidebarToggleButton(isSidebarOpen);
  syncPeriodPresets();
  applyFontSize();
}

function persistUiState() {
  const api = window.pywebview?.api;
  if (typeof api?.save_ui_state !== "function") return;
  const payload = {
    sidebar_open: $("sidebar").classList.contains("is-open"),
    period_preset: state.activePeriodPreset,
    start_date: state.activePeriodPreset ? "" : state.startDate,
    end_date: state.activePeriodPreset ? "" : state.endDate,
    hide_holidays: state.hideHolidays,
    font_size: state.fontSize,
  };
  uiStateSaveQueue = uiStateSaveQueue
    .catch(() => {})
    .then(() => api.save_ui_state(payload))
    .catch(() => {});
}

// UTC+9（JST）の今日の日付を "YYYY-MM-DD" で返す
function getTodayJST() {
  const jst = new Date(new Date().getTime() + 9 * 60 * 60 * 1000);
  return [
    jst.getUTCFullYear(),
    String(jst.getUTCMonth() + 1).padStart(2, "0"),
    String(jst.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

// ISO日付文字列に日数を加算して ISO文字列で返す（タイムゾーン非依存）
function offsetDateStr(dateStr, days) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function isWeekendDate(dateStr) {
  const day = new Date(dateStr + "T00:00:00Z").getUTCDay();
  return day === 0 || day === 6;
}

function offsetVisibleDateStr(dateStr, days) {
  let next = offsetDateStr(dateStr, days);
  while (state.hideHolidays && isWeekendDate(next)) {
    next = offsetDateStr(next, days);
  }
  return next;
}

function initializeDefaultDateRange() {
  // Python 側から取得したデータを元にセットするため、ここでは何もしない
}

function initializeTheme() {
  state.darkMode = readThemePreference();
  applyTheme();
}

function readThemePreference() {
  return false;
}

function saveThemePreference() {
  // 開発中はブラウザに設定を永続保存しない
}

function toggleTheme() {
  state.darkMode = !state.darkMode;
  saveThemePreference();
  applyTheme();
}

function toggleFontSizeMenu() {
  const menu = $("fontSizeMenu");
  const willOpen = menu.classList.contains("hidden");
  menu.classList.toggle("hidden", !willOpen);
  $("fontSizeButton").setAttribute("aria-expanded", String(willOpen));
}

function closeFontSizeMenu() {
  $("fontSizeMenu").classList.add("hidden");
  $("fontSizeButton").setAttribute("aria-expanded", "false");
}

function setFontSize(fontSize) {
  if (!["standard", "large", "xlarge"].includes(fontSize)) return;
  state.fontSize = fontSize;
  applyFontSize();
  closeFontSizeMenu();
  persistUiState();
}

function applyFontSize() {
  document.body.dataset.fontSize = state.fontSize;
  $("fontSizeButton").classList.toggle("is-active", state.fontSize !== "standard");
  $("fontSizeMenu")
    .querySelectorAll("[data-font-size]")
    .forEach((button) => {
      const isActive = button.dataset.fontSize === state.fontSize;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-pressed", String(isActive));
    });
}

function applyTheme() {
  document.body.classList.add("is-theme-switching");
  document.body.classList.toggle("is-dark-mode", state.darkMode);
  document.documentElement.classList.toggle("dark", state.darkMode);
  document.documentElement.classList.toggle("light", !state.darkMode);
  document.documentElement.style.colorScheme = state.darkMode ? "dark" : "light";
  updateThemeToggleButton();
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      document.body.classList.remove("is-theme-switching");
    });
  });
}

function updateThemeToggleButton() {
  const themeButton = $("toggleThemeButton");
  if (!themeButton) return;
  const icon = themeButton.querySelector("svg");
  const title = state.darkMode ? "ライトモードに切替" : "ダークモードに切替";
  themeButton.title = title;
  themeButton.setAttribute("aria-label", title);
  themeButton.setAttribute("aria-pressed", String(state.darkMode));
  themeButton.classList.toggle("is-active", state.darkMode);
  if (icon) {
    icon.innerHTML = state.darkMode
      ? '<circle cx="12" cy="12" r="4" /><path d="M12 2v2" /><path d="M12 20v2" /><path d="m4.93 4.93 1.41 1.41" /><path d="m17.66 17.66 1.41 1.41" /><path d="M2 12h2" /><path d="M20 12h2" /><path d="m6.34 17.66-1.41 1.41" /><path d="m19.07 4.93-1.41 1.41" />'
      : '<path d="M12 3a6 6 0 0 0 9 7.8A8.5 8.5 0 1 1 12 3z" />';
  }
}

function toggleSidebar() {
  const sidebar = $("sidebar");
  const willOpen = !sidebar.classList.contains("is-open");
  sidebar.classList.toggle("is-open", willOpen);
  updateSidebarToggleButton(willOpen);
  persistUiState();
}

function updateSidebarToggleButton(
  isOpen = $("sidebar").classList.contains("is-open"),
) {
  const toggleButton = $("toggleSidebarButton");
  const toggleIcon = toggleButton.querySelector(".sidebar-toggle-icon");
  const toggleText = toggleButton.querySelector(".sidebar-utility-text");
  if (toggleIcon) {
    toggleIcon.innerHTML = isOpen
      ? '<svg viewBox="0 0 24 24" role="img" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /><path d="m16 9-3 3 3 3" /></svg>'
      : '<svg viewBox="0 0 24 24" role="img" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /><path d="m13 9 3 3-3 3" /></svg>';
  }
  if (toggleText) toggleText.textContent = isOpen ? "折りたたむ" : "展開する";
  toggleButton.title = isOpen ? "サイドバーを閉じる" : "サイドバーを開く";
}

function showSettings(visible) {
  switchView(visible ? "settings" : state.lastReportView || "daily");
}

function showMain(visible) {
  // ツールバーは常時表示。テーブルだけ出し入れする
  $("tableWrap").classList.toggle("hidden", !visible);
}

function clampNumber(value, min, max) {
  const numericValue = Number.isFinite(value) ? value : min;
  return Math.min(max, Math.max(min, numericValue));
}

function updateDefaultRangePreview() {
  const pastDays = clampNumber(
    Number.parseInt($("defaultStartOffsetDays").value, 10),
    0,
    14,
  );
  const futureDays = clampNumber(
    Number.parseInt($("defaultEndOffsetDays").value, 10),
    0,
    7,
  );
  const today = getTodayJST();
  const startDate = offsetDateStr(today, -pastDays);
  const endDate = offsetDateStr(today, futureDays);
  $("pastDaysValue").textContent =
    pastDays === 0 ? "今日から" : `今日より${pastDays}日前`;
  $("futureDaysValue").textContent =
    futureDays === 0 ? "今日まで" : `今日より${futureDays}日後`;
  $("rangeTodayDate").textContent = formatPreviewDate(today);
  $("defaultRangePreview").textContent =
    `表示期間：${formatPreviewDate(startDate)}〜${formatPreviewDate(endDate)}` +
    `（今日を含む${pastDays + futureDays + 1}日間）`;
}

function formatPreviewDate(dateStr) {
  const [year, month, day] = dateStr.split("-").map(Number);
  return `${year}/${month}/${day}`;
}

function hasUnsavedChanges() {
  return getDirtyCounts().total > 0;
}

function confirmDiscardUnsaved(message) {
  if (!hasUnsavedChanges()) return true;
  return window.confirm(
    `${message}\n\n未保存の変更は破棄されます。先に保存する場合はキャンセルしてください。`,
  );
}

function handleBeforeUnload(event) {
  if (!hasUnsavedChanges()) return;
  event.preventDefault();
  event.returnValue = "";
}

function handleGlobalShortcut(event) {
  if (!event.ctrlKey || event.altKey || event.key.toLowerCase() !== "s") return;
  event.preventDefault();
  if (state.isBusy || !hasUnsavedChanges()) return;
  saveUpdates();
}

function notify({ text, type = "info", autoHide = shouldAutoHideToast(type) }) {
  const message = $("message");
  if (!message) return;
  clearToastTimers();
  message.textContent = text;
  message.classList.remove(
    "hidden",
    "is-fading",
    "success",
    "error",
    "warning",
    "info",
  );
  message.classList.add(type);
  positionToast();
  showToast(message);
  toastState.type = type;

  if (autoHide) {
    scheduleToastHide();
  }
}

function positionToast() {
  const region = $("statusRegion");
  if (!region) return;
  const saveButton = $("saveButton");
  const hasVisibleSaveButton = saveButton?.offsetParent !== null;
  const anchor = hasVisibleSaveButton
    ? saveButton.getBoundingClientRect()
    : $("mainPanel").getBoundingClientRect();
  const top = hasVisibleSaveButton ? anchor.bottom + 8 : anchor.top + 12;
  const right = hasVisibleSaveButton
    ? Math.max(12, window.innerWidth - anchor.right)
    : 12;
  region.style.setProperty("--toast-top", `${Math.round(top)}px`);
  region.style.setProperty("--toast-right", `${Math.round(right)}px`);
}

function shouldAutoHideToast(type) {
  return type === "success" || type === "info";
}

function clearToastTimers() {
  if (toastState.hideTimer) clearTimeout(toastState.hideTimer);
  if (toastState.fadeTimer) clearTimeout(toastState.fadeTimer);
  toastState.hideTimer = null;
  toastState.fadeTimer = null;
}

function scheduleToastHide() {
  const message = $("message");
  if (!message) return;

  // 3秒表示 → 0.8秒かけてフェードアウト → 非表示
  toastState.hideTimer = setTimeout(() => {
    message.classList.add("is-fading");
    toastState.fadeTimer = setTimeout(() => {
      hideToast(message);
      message.classList.remove("is-fading");
      clearToastTimers();
      toastState.type = "";
    }, 800);
  }, 3000);
}

function showToast(message) {
  message.classList.remove("hidden");
}

function hideToast(message) {
  message.classList.add("hidden");
}

function setFieldError(errorId, message, inputIds = []) {
  const error = $(errorId);
  if (error) {
    error.textContent = message;
    error.classList.toggle("hidden", !message);
  }
  inputIds.forEach((inputId) => {
    const input = $(inputId);
    if (!input) return;
    if (message) {
      input.setAttribute("aria-invalid", "true");
    } else {
      input.removeAttribute("aria-invalid");
    }
  });
}

const settingsErrorTargets = {
  users_dir: { errorId: "usersDirError", inputId: "usersDir" },
  comments_dir: { errorId: "commentsDirError", inputId: "commentsDir" },
  common_dir: { errorId: "commonDirError", inputId: "commonDir" },
};

function clearSettingsErrors() {
  Object.values(settingsErrorTargets).forEach(({ errorId, inputId }) => {
    setFieldError(errorId, "", [inputId]);
  });
}

function showSettingsErrors(fieldErrors) {
  const entries = Object.entries(fieldErrors || {}).filter(
    ([field, message]) => settingsErrorTargets[field] && message,
  );
  entries.forEach(([field, message]) => {
    const target = settingsErrorTargets[field];
    setFieldError(target.errorId, String(message), [target.inputId]);
  });
  if (entries.length) {
    $(settingsErrorTargets[entries[0][0]].inputId)?.focus();
  }
  return entries.length;
}

function validateSettingsInputs() {
  const errors = {};
  if (!$("usersDir").value.trim()) {
    errors.users_dir = "ユーザー日報フォルダを入力してください。";
  }
  if (!$("commentsDir").value.trim()) {
    errors.comments_dir = "上司コメントフォルダを入力してください。";
  }
  if (!$("commonDir").value.trim()) {
    errors.common_dir = "共通マスターフォルダを入力してください。";
  }
  return errors;
}

function setBusy(busy, action = "") {
  state.isBusy = busy;
  state.busyAction = busy ? action : "";
  document.querySelectorAll("button").forEach((button) => {
    button.disabled = busy;
  });
  syncChrome();
}

async function saveSettings() {
  clearSettingsErrors();
  const clientErrorCount = showSettingsErrors(validateSettingsInputs());
  if (clientErrorCount) {
    notify({
      text: `${clientErrorCount}項目を確認してください。`,
      type: "error",
    });
    return;
  }
  const payload = {
    users_dir: $("usersDir").value,
    comments_dir: $("commentsDir").value,
    common_dir: $("commonDir").value,
    default_start_offset_days: -Number($("defaultStartOffsetDays").value),
    default_end_offset_days: Number($("defaultEndOffsetDays").value),
    missing_comment_start_date: $("missingCommentStartDate").value,
    comment_signature: $("commentSignature").value,
  };
  setBusy(true, "settings");
  const result = await window.pywebview.api.save_settings(payload);
  setBusy(false);
  const serverErrorCount = showSettingsErrors(result.field_errors);
  notify({ text: result.message, type: result.ok ? "success" : "error" });
  if (!result.ok && serverErrorCount) return;
  if (result.ok) {
    state.startDate = "";
    state.endDate = "";
    state.activePeriodPreset = "default";
    state.hideHolidays = false;
    state.missingCommentStartDate =
      result.settings?.missing_comment_start_date || "";
    state.commentSignature = result.settings?.comment_signature || "";
    showSettings(false);
    await loadData();
    persistUiState();
  }
}

async function refreshData() {
  finishEditing();
  if (!confirmDiscardUnsaved("最新データを取得しますか？")) return;
  discardDirtyEdits();
  await loadData({ preserveDirty: false });
}

function discardDirtyEdits() {
  state.dirtyReports.clear();
  state.dirtyComments.clear();
  state.dirtyReportFields.clear();
  state.dirtyReplyKeys.clear();
  syncChrome();
}

async function loadData({ silent = false, preserveDirty = true } = {}) {
  finishEditing();
  setBusy(true, "load");
  const result = await window.pywebview.api.load_data({
    start_date: state.startDate || null,
    end_date: state.endDate || null,
  });
  setBusy(false);
  if (!result.ok) {
    showMain(false);
    if (result.needs_settings) showSettings(true);
    notify({ text: result.message, type: "error" }); // エラーは silent でも必ず表示
    return;
  }
  state.displayName = result.data.display_name || result.data.employee_id || "";
  syncCurrentUserName();
  state.isSuperior = Boolean(result.data.is_superior);
  if (!state.hasInitializedReportView) {
    state.activeView = state.isSuperior ? "boss" : "daily";
    state.lastReportView = state.activeView;
    state.hasInitializedReportView = true;
  }
  state.myRank = Number.isFinite(result.data.my_rank)
    ? result.data.my_rank
    : 9999;
  state.rows = Array.isArray(result.data.rows) ? result.data.rows : [];
  state.startDate = result.data.start_date || state.startDate;
  state.endDate = result.data.end_date || state.endDate;
  $("startDate").value = state.startDate;
  $("endDate").value = state.endDate;
  if (preserveDirty) {
    reapplyDirtyEditsToRows();
  }
  state.expandedReplies.clear();

  const container = $("bossSearchControl");
  if (container) {
    const subordinates = [
      ...new Map(
        state.rows
          .filter((r) => r.employee_id !== state.employeeId)
          .map((r) => [
            r.employee_id,
            { id: r.employee_id, name: r.display_name || r.employee_id },
          ]),
      ).values(),
    ].sort((a, b) => a.name.localeCompare(b.name, "ja"));

    const availableIds = new Set(subordinates.map((sub) => sub.id));
    if (!availableIds.has(state.selectedSubordinateId)) {
      state.selectedSubordinateId = "";
    }

    const existingTags = container.querySelectorAll(
      ".member-switch-button[data-id]",
    );
    existingTags.forEach((t) => t.remove());

    const familyNameCounts = new Map();
    subordinates.forEach((sub) => {
      const familyName = getFamilyName(sub.name);
      familyNameCounts.set(
        familyName,
        (familyNameCounts.get(familyName) || 0) + 1,
      );
    });

    subordinates.forEach((sub) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "member-switch-button";
      btn.dataset.id = sub.id;
      const familyName = getFamilyName(sub.name);
      btn.textContent =
        familyNameCounts.get(familyName) === 1 ? familyName : sub.name;
      btn.title = sub.name;
      btn.setAttribute("aria-pressed", "false");
      container.appendChild(btn);
    });

    const allButton = $("showAllSubordinatesButton");
    if (allButton) allButton.textContent = `全員（${subordinates.length}人）`;

    updateSubordinateFilterUi();
  }

  updateViewAvailability();
  updateViewChrome();
  syncChrome();
  renderTable();
  showMain(true);
  showSettings(false);
  const warningCount = Number(result.data.load_warning_count || 0);
  if (warningCount > 0) {
    notify({
      text: `${warningCount}件のCSVを読み込めませんでした。読み込めたデータのみ表示しています。詳細はログを確認してください。`,
      type: "warning",
    });
  } else if (!silent) {
    notify({ text: "最新データを取得しました。", type: "info" });
  }
}

function getFamilyName(displayName) {
  const normalized = String(displayName || "").trim();
  return normalized.split(/[\s　]+/)[0] || normalized;
}

function reapplyDirtyEditsToRows() {
  if (state.dirtyReports.size === 0 && state.dirtyComments.size === 0) return;

  const rowsByKey = new Map(
    state.rows.map((row) => [`${row.employee_id}|${row.date}`, row]),
  );

  for (const [key, dirtyRow] of state.dirtyReports.entries()) {
    const row = rowsByKey.get(key);
    if (!row) continue;

    row.business_name = dirtyRow.business_name;
    row.business_detail = dirtyRow.business_detail;

    const loadedComments = new Map(
      (row.comments || []).map((cell) => [cell.superior_employee_id, cell]),
    );
    for (const dirtyCell of dirtyRow.comments || []) {
      const cell = loadedComments.get(dirtyCell.superior_employee_id);
      if (cell) cell.reply = dirtyCell.reply;
    }

    state.dirtyReports.set(key, row);
  }

  for (const [key, dirty] of state.dirtyComments.entries()) {
    const row = rowsByKey.get(`${dirty.row.employee_id}|${dirty.row.date}`);
    if (!row) continue;

    const cell = (row.comments || []).find(
      (candidate) =>
        candidate.superior_employee_id === dirty.cell.superior_employee_id,
    );
    if (!cell) continue;

    cell.comment = dirty.cell.comment;
    state.dirtyComments.set(key, { row, cell });
  }
}

async function handleDateChange() {
  finishEditing();
  setFieldError("periodError", "", ["startDate", "endDate"]);
  const startDate = $("startDate").value;
  const endDate = $("endDate").value;
  if (!startDate || !endDate) {
    setFieldError(
      "periodError",
      "開始日と終了日を入力してください。",
      ["startDate", "endDate"],
    );
    return;
  }
  if (startDate > endDate) {
    setFieldError(
      "periodError",
      "開始日は終了日以前にしてください。",
      ["startDate", "endDate"],
    );
    return;
  }
  if (!confirmDiscardUnsaved("日付範囲を変更しますか？")) {
    $("startDate").value = state.startDate;
    $("endDate").value = state.endDate;
    setFieldError("periodError", "", ["startDate", "endDate"]);
    return;
  }
  discardDirtyEdits();
  state.startDate = startDate;
  state.endDate = endDate;
  state.activePeriodPreset = "";
  await loadData();
  persistUiState();
}

async function shiftDateBoundary(boundary, deltaDays) {
  finishEditing();
  const startInput = $("startDate");
  const endInput = $("endDate");
  let startDate = startInput.value || state.startDate;
  let endDate = endInput.value || state.endDate;
  if (!startDate || !endDate) return;

  if (boundary === "start") {
    const nextStart = offsetVisibleDateStr(startDate, deltaDays);
    if (nextStart > endDate) return;
    startDate = nextStart;
  } else {
    const nextEnd = offsetVisibleDateStr(endDate, deltaDays);
    if (nextEnd < startDate) return;
    endDate = nextEnd;
  }

  if (!confirmDiscardUnsaved("表示する日付範囲を広げますか？")) return;
  discardDirtyEdits();
  startInput.value = startDate;
  endInput.value = endDate;
  state.startDate = startDate;
  state.endDate = endDate;
  state.activePeriodPreset = "";
  await loadData();
  persistUiState();
}

function formatDisplayDateHTML(value) {
  if (!value) return "";
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return escapeHtml(String(value));
  const days = ["日", "月", "火", "水", "木", "金", "土"];
  const day = d.getUTCDay();
  const weekdayClass =
    day === 0 ? "date-weekday-sun" : day === 6 ? "date-weekday-sat" : "";
  const weekday = weekdayClass
    ? `<span class="${weekdayClass}">${days[day]}</span>`
    : days[day];
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} <span class="date-weekday">(${weekday})</span>`;
}

async function applyPreset(presetName) {
  finishEditing();
  setFieldError("periodError", "", ["startDate", "endDate"]);
  if (!confirmDiscardUnsaved("日付範囲を変更しますか？")) return;
  discardDirtyEdits();
  const range = getPresetRange(presetName);
  state.startDate = range.startDate;
  state.endDate = range.endDate;
  state.activePeriodPreset = presetName;
  $("startDate").value = state.startDate;
  $("endDate").value = state.endDate;
  await loadData();
  persistUiState();
}

function getPresetRange(presetName) {
  const today = getTodayJST();
  if (presetName === "today") {
    return { startDate: today, endDate: today };
  }
  if (presetName === "last7days") {
    return { startDate: offsetDateStr(today, -6), endDate: today };
  }
  if (presetName === "thisMonth") {
    const d = new Date(today + "T00:00:00Z");
    const year = d.getUTCFullYear();
    const month = String(d.getUTCMonth() + 1).padStart(2, "0");
    const nextMonth = new Date(Date.UTC(year, d.getUTCMonth() + 1, 1));
    nextMonth.setUTCDate(0);
    return {
      startDate: `${year}-${month}-01`,
      endDate: nextMonth.toISOString().slice(0, 10),
    };
  }
  return { startDate: "", endDate: "" };
}

function renderTable() {
  const wrap = $("tableWrap");
  const rows = getFilteredRows();
  if (!rows.length) {
    wrap.innerHTML = `<div class="empty">${escapeHtml(getEmptyMessage())}</div>`;
    return;
  }

  const context = createTableRenderContext(rows);
  wrap.innerHTML = renderTableShell({
    header: renderTableHeader(context),
    body: renderReportRows(rows, context),
    prevBand: renderDateExpandBand("prev"),
    nextBand: renderDateExpandBand("next"),
    minWidth: getTableContentWidth(context),
  });
  focusPendingReplyEditor();
  focusPendingEditTarget();
}

function createTableRenderContext(rows) {
  const showUserColumn = state.activeView === "boss";
  const sampleComments = getVisibleComments(
    rows[0]?.comments || state.rows[0]?.comments || [],
  );

  return {
    showUserColumn,
    sampleComments,
    ...buildDateRowMetadata(rows, showUserColumn),
  };
}

function renderTableShell({ header, body, prevBand, nextBand, minWidth }) {
  return `${prevBand}<div class="table-scroll"><div class="table-content" style="--table-content-width:${minWidth}px"><table>${header}<tbody>${body}</tbody></table></div></div>${nextBand}`;
}

function getTableContentWidth(context) {
  const fixedColumns = 86 + 220 + (context.showUserColumn ? 132 + 380 : 420);
  const commentColumns = context.sampleComments.length * 300;
  const fallback = context.showUserColumn ? 1240 : 1110;
  return Math.max(fallback, fixedColumns + commentColumns);
}

function renderTableHeader(context) {
  const userHeader = context.showUserColumn
    ? '<th class="user-col">部下の氏名</th>'
    : "";
  const superiorHeaders = context.sampleComments
    .map(renderSuperiorHeader)
    .join("");

  return `<thead><tr>
    <th class="date-col">日付</th>
    ${userHeader}
    <th class="name-col">業務名</th>
    <th class="detail-col">業務詳細</th>
    ${superiorHeaders}
  </tr></thead>`;
}

function renderSuperiorHeader(cell) {
  const isMe = cell.superior_employee_id === state.employeeId;
  const label =
    isMe && state.activeView === "boss" ? "自分のコメント" : cell.superior_name;
  const selfClass = isMe && state.activeView === "boss" ? " self-comment-col" : "";
  return `<th class="comment-col${selfClass}">${escapeHtml(label)}</th>`;
}

function getVisibleComments(comments = []) {
  if (!Array.isArray(comments)) return [];
  if (state.activeView === "boss") return comments;
  return comments.filter((cell) => cell.rank > state.myRank);
}

function buildDateRowMetadata(rows, showUserColumn) {
  // 上司コメント画面では同じ日付のセルを結合し、日付単位で背景を切り替える
  const dateRowSpans = new Map();
  const dateGroupClasses = new Map();

  if (!showUserColumn) {
    return { dateRowSpans, dateGroupClasses };
  }

  let i = 0;
  let groupIndex = 0;
  const useStripedDateGroups = !state.selectedSubordinateId;
  while (i < rows.length) {
    const d = rows[i].date;
    let span = 1;
    while (i + span < rows.length && rows[i + span].date === d) span++;
    dateRowSpans.set(i, span);
    const groupClass = useStripedDateGroups
      ? groupIndex % 2 === 0
        ? "boss-date-group-even"
        : "boss-date-group-alt"
      : "";
    for (let offset = 0; offset < span; offset += 1) {
      dateGroupClasses.set(i + offset, groupClass);
    }
    i += span;
    groupIndex += 1;
  }

  return { dateRowSpans, dateGroupClasses };
}

function renderReportRows(rows, context) {
  return rows.map((row, idx) => renderReportRow(row, idx, context)).join("");
}

function renderReportRow(row, idx, context) {
  return `<tr class="${renderReportRowClass(row, idx, context)}">
    ${renderDateCell(row, idx, context)}
    ${renderUserCell(row, context)}
    ${renderReportNameCell(row)}
    ${renderReportDetailCell(row)}
    ${renderCommentCells(row)}
  </tr>`;
}

function renderReportRowClass(row, idx, context) {
  return [
    row.is_holiday ? "holiday" : "",
    row.is_today ? "is-today" : "",
    rowHasReportData(row) ? "has-report-data" : "is-report-empty",
    rowHasVisibleBossComment(row) ? "has-boss-comment" : "",
    rowNeedsBossComment(row) ? "needs-boss-comment" : "",
    context.showUserColumn ? context.dateGroupClasses.get(idx) || "" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function renderDateCell(row, idx, context) {
  const content = renderCellFrame(
    `${formatDisplayDateHTML(row.date)}${renderRowStateBadges(row)}${renderHolidayLabel(row)}`,
    "cell-frame-static date-content",
  );
  if (!context.showUserColumn) {
    return `<td class="date-col">${content}</td>`;
  }
  if (!context.dateRowSpans.has(idx)) {
    return "";
  }
  const span = context.dateRowSpans.get(idx);
  return `<td class="date-col" rowspan="${span}">${content}</td>`;
}

function renderHolidayLabel(row) {
  return row.holiday_description
    ? `<div class="cell-sub-label">${escapeHtml(row.holiday_description)}</div>`
    : "";
}

function rowHasVisibleBossComment(row) {
  return getVisibleComments(row.comments || []).some((cell) =>
    normalizeCellValue(cell.comment),
  );
}

function renderRowStateBadges(row) {
  const badges = [];
  if (row.is_today) badges.push('<span class="row-state-badge today">今日</span>');
  if (rowNeedsBossComment(row)) {
    badges.push('<span class="row-state-badge attention">未確認</span>');
  }
  return badges.length
    ? `<div class="row-state-badges">${badges.join("")}</div>`
    : "";
}

function renderUserCell(row, context) {
  return context.showUserColumn
    ? `<td class="user-col">${renderCellFrame(escapeHtml(row.display_name), "cell-frame-static user-content")}</td>`
    : "";
}

function renderReportNameCell(row) {
  return `<td class="${renderReportTdClass("name-col", row, "business_name")}">${renderEditableCell({
    kind: "report",
    type: "name",
    field: "business_name",
    rowIndex: row.__index,
    value: row.business_name,
    editable: row.can_edit_report,
  })}</td>`;
}

function renderReportDetailCell(row) {
  return `<td class="${renderReportTdClass("detail-col", row, "business_detail")}">${renderEditableCell({
    kind: "report",
    type: "details",
    field: "business_detail",
    rowIndex: row.__index,
    value: row.business_detail,
    editable: row.can_edit_report,
  })}</td>`;
}

function renderReportTdClass(baseClass, row, field) {
  return [baseClass, isReportFieldDirty(row, field) ? "is-dirty-cell" : ""]
    .filter(Boolean)
    .join(" ");
}

function renderCommentCells(row) {
  return getVisibleComments(row.comments)
    .map((cell) => {
      const originalIndex = row.comments.indexOf(cell);
      return renderCommentCell(row, cell, row.__index, originalIndex);
    })
    .join("");
}

function renderDateExpandBand(direction) {
  const isPrev = direction === "prev";
  const dateStr = isPrev
    ? state.startDate && offsetVisibleDateStr(state.startDate, -1)
    : state.endDate && offsetVisibleDateStr(state.endDate, 1);
  if (!dateStr) return "";

  const className = isPrev
    ? "date-expand-band band-top"
    : "date-expand-band band-bottom";
  const action = isPrev ? "expand-prev" : "expand-next";
  const label = `${dateStr.replaceAll("-", "/")}を表示`;
  const icon = isPrev ? renderInsertDirectionIcon("up") : renderInsertDirectionIcon("down");
  return `<button class="${className}" type="button" data-action="${action}"><span class="date-expand-label">${icon}<span>${label}</span></span></button>`;
}

function renderInsertDirectionIcon(direction) {
  const isUp = direction === "up";
  const chevron = isUp ? "M8 13l4-4 4 4" : "M8 11l4 4 4-4";
  const lineY = isUp ? "6" : "18";
  return `<svg class="date-expand-icon" viewBox="0 0 24 24" role="img" aria-hidden="true"><path d="M6 ${lineY}h12" /><path d="${chevron}" /></svg>`;
}

function focusPendingReplyEditor() {
  if (!state.pendingReplyFocusKey) return;
  const target = document.querySelector(
    `.editable-content.reply-content[data-reply-key="${state.pendingReplyFocusKey}"]`,
  );
  state.pendingReplyFocusKey = "";
  if (target instanceof HTMLElement) {
    startEditingTarget(target);
  }
}

function focusPendingEditTarget() {
  const pending = state.pendingEditTarget;
  state.pendingEditTarget = null;
  if (!pending) return;
  const selector = buildEditableSelector(pending);
  const target = selector ? document.querySelector(selector) : null;
  if (target instanceof HTMLElement) startEditingTarget(target);
}

function buildEditableSelector(targetInfo) {
  if (!targetInfo || targetInfo.rowIndex === undefined) return "";
  const row = String(targetInfo.rowIndex);
  if (targetInfo.kind === "report") {
    return `.editable-content[data-kind="report"][data-row="${row}"][data-field="${targetInfo.field}"]`;
  }
  if (targetInfo.kind === "reply" || targetInfo.kind === "comment") {
    return `.editable-content[data-kind="${targetInfo.kind}"][data-row="${row}"][data-comment="${targetInfo.commentIndex}"]`;
  }
  return "";
}

function getReplyKey(row, cell) {
  return `${row.employee_id}|${row.date}|${cell.superior_employee_id}`;
}

function renderCommentCell(row, cell, rowIndex, commentIndex) {
  const context = createCommentRenderContext(row, cell, rowIndex, commentIndex);
  return state.activeView === "boss"
    ? renderBossCommentCell(context)
    : renderDailyCommentCell(context);
}

function createCommentRenderContext(row, cell, rowIndex, commentIndex) {
  const canEditComment =
    state.activeView === "boss" ? Boolean(cell.editable) : false;
  const hasBossComment = Boolean(String(cell.comment || "").trim());
  const hasReply = Boolean(String(cell.reply || "").trim());
  const canEditReply =
    state.activeView === "daily" && row.can_edit_report && hasBossComment;

  return {
    row,
    cell,
    rowIndex,
    commentIndex,
    canEditComment,
    hasBossComment,
    hasReply,
    canEditReply,
    replyKey: getReplyKey(row, cell),
  };
}

function renderBossCommentCell(context) {
  return `<td class="comment-col"><div class="comment-stack">${renderBossCommentActions(context)}${renderBossCommentDisplay(context)}${renderBossReplyPreview(context)}</div></td>`;
}

function renderBossCommentActions(context) {
  if (!context.canEditComment) return "";

  return `<div class="cell-frame boss-comment-actions${context.hasBossComment ? " hidden" : ""}" data-boss-comment-actions="true">
    <button class="boss-comment-link" type="button" data-action="sign-comment" data-row="${context.rowIndex}" data-comment="${context.commentIndex}">サイン</button>
    <button class="boss-comment-link" type="button" data-action="edit-comment" data-row="${context.rowIndex}" data-comment="${context.commentIndex}">コメントを追加</button>
  </div>`;
}

function renderBossCommentDisplay(context) {
  if (context.hasBossComment) {
    return renderBossCommentEditor(context, context.canEditComment);
  }

  return `<div class="cell-frame editable-content boss-content is-empty hidden" data-kind="comment" data-type="boss" data-row="${context.rowIndex}" data-field="comment" data-comment="${context.commentIndex}" data-editable="${context.canEditComment ? "true" : "false"}"></div>`;
}

function renderBossCommentEditor(context, editable) {
  return renderEditableCell({
    kind: "comment",
    type: "boss",
    field: "comment",
    rowIndex: context.rowIndex,
    commentIndex: context.commentIndex,
    value: context.cell.comment,
    editable,
    dirty: isBossCommentDirty(context.row, context.cell),
  });
}

function renderBossReplyPreview(context) {
  if (!context.hasReply) return "";
  return `<div class="cell-frame boss-reply-preview" title="部下返信" aria-label="部下返信"><span class="boss-reply-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m9 17-5-5 5-5" /><path d="M20 18v-2a4 4 0 0 0-4-4H4" /></svg></span><div class="boss-reply-text">${escapeHtml(displayText(context.cell.reply))}</div></div>`;
}

function renderDailyCommentCell(context) {
  return `<td class="comment-col"><div class="comment-stack">${renderBossCommentEditor(context, false)}${renderReplySection(context)}</div></td>`;
}

function renderReplySection(context) {
  if (!canShowReplySection(context)) return "";
  return `<div class="reply-section">${renderReplyToggleButton(context)}${renderReplyEditor(context)}</div>`;
}

function canShowReplySection(context) {
  return context.hasBossComment || context.hasReply;
}

function isReplySectionExpanded(context) {
  return context.hasReply || state.expandedReplies.has(context.replyKey);
}

function renderReplyToggleButton(context) {
  if (isReplySectionExpanded(context)) return "";
  return `<button class="reply-toggle-button" type="button" data-action="toggle-reply" data-row="${context.rowIndex}" data-comment="${context.commentIndex}">返信する</button>`;
}

function renderReplyEditor(context) {
  if (!isReplySectionExpanded(context)) return "";

  return renderEditableCell({
    kind: "reply",
    type: "reply",
    rowIndex: context.rowIndex,
    commentIndex: context.commentIndex,
    value: context.cell.reply || "",
    editable: context.canEditReply,
    dirty: isReplyDirty(context.row, context.cell),
    extraAttributes: ` data-reply-key="${context.replyKey}"`,
  });
}

function getReportRowKey(row) {
  return `${row.employee_id}|${row.date}`;
}

function getReportFieldKey(row, field) {
  return `${getReportRowKey(row)}|${field}`;
}

function isReportFieldDirty(row, field) {
  return state.dirtyReportFields.has(getReportFieldKey(row, field));
}

function isReplyDirty(row, cell) {
  return state.dirtyReplyKeys.has(getReplyKey(row, cell));
}

function isBossCommentDirty(row, cell) {
  return state.dirtyComments.has(getReplyKey(row, cell));
}

function renderEditableCell({
  kind,
  type,
  field = "",
  rowIndex,
  commentIndex = "",
  value,
  editable,
  dirty = false,
  extraAttributes = "",
}) {
  const display = displayText(value);
  const empty = isEmpty(value);
  const classes = [
    "cell-frame",
    "editable-content",
    `${type}-content`,
    empty ? "is-empty" : "",
    editable ? "is-editable" : "is-readonly",
    dirty ? "is-dirty" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const accessibilityAttributes = editable
    ? ' role="button" tabindex="0" title="クリックまたはEnterで編集"'
    : "";
  return `<div class="${classes}" data-kind="${kind}" data-type="${type}" data-row="${rowIndex}" data-field="${field}" data-comment="${commentIndex}" data-editable="${editable ? "true" : "false"}"${accessibilityAttributes}${extraAttributes}>${escapeHtml(display)}</div>`;
}

function renderCellFrame(content, extraClass = "") {
  const classes = ["cell-frame", extraClass].filter(Boolean).join(" ");
  return `<div class="${classes}">${content}</div>`;
}

function normalizeCellValue(value) {
  const text = String(value ?? "");
  return text.trim() ? text : "";
}

function displayText(value) {
  return normalizeCellValue(value);
}

function isEmpty(value) {
  return normalizeCellValue(value) === "";
}

function handleTableClick(event) {
  const expandPrev = event.target.closest('[data-action="expand-prev"]');
  if (expandPrev) {
    shiftDateBoundary("start", -1);
    return;
  }
  const expandNext = event.target.closest('[data-action="expand-next"]');
  if (expandNext) {
    shiftDateBoundary("end", 1);
    return;
  }
  const signComment = event.target.closest('[data-action="sign-comment"]');
  if (signComment) {
    applyBossCommentSignature(signComment);
    return;
  }
  const editComment = event.target.closest('[data-action="edit-comment"]');
  if (editComment) {
    openBossCommentEditor(editComment);
    return;
  }

  const replyToggle = event.target.closest('[data-action="toggle-reply"]');
  if (replyToggle) {
    toggleReplyEditor(replyToggle);
    return;
  }
  beginCellEditing(event);
}

function handleTableKeydown(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  if (target.matches("textarea")) return;

  const editable = target.closest(".editable-content");
  if (!(editable instanceof HTMLElement)) return;

  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    startEditingTarget(editable);
  }
}

function toggleReplyEditor(button) {
  const rowIndex = Number(button.dataset.row);
  const commentIndex = Number(button.dataset.comment);
  const row = state.rows[rowIndex];
  const cell = row?.comments?.[commentIndex];
  if (!row || !cell) return;

  const replyKey = getReplyKey(row, cell);
  state.expandedReplies.add(replyKey);
  state.pendingReplyFocusKey = replyKey;
  renderTable();
}

function openBossCommentEditor(button) {
  const { target } = getBossCommentTarget(button);
  if (!target) return;

  const actions = button.closest(".boss-comment-actions");
  if (actions) actions.classList.add("hidden");

  target.classList.remove("hidden");
  startEditingTarget(target);
}

function applyBossCommentSignature(button) {
  const actions = button.closest(".boss-comment-actions");
  if (actions) actions.classList.add("hidden");

  const { row, cell } = getBossCommentTarget(button);
  if (!row || !cell) return;

  finishEditing();

  const signature = normalizeCellValue(
    state.commentSignature || cell.superior_name,
  );
  cell.comment = signature;
  state.dirtyComments.set(
    `${row.employee_id}|${row.date}|${cell.superior_employee_id}`,
    { row, cell },
  );

  syncChrome();
  renderTable();
}

function getBossCommentTarget(button) {
  const rowIndex = Number(button.dataset.row);
  const commentIndex = Number(button.dataset.comment);
  const row = state.rows[rowIndex];
  const cell = row?.comments?.[commentIndex];
  const target = document.querySelector(
    `.editable-content.boss-content[data-row="${rowIndex}"][data-comment="${commentIndex}"]`,
  );
  return { row, cell, target: target instanceof HTMLElement ? target : null };
}

function applyReplySignature(button) {
  const rowIndex = Number(button.dataset.row);
  const commentIndex = Number(button.dataset.comment);
  const row = state.rows[rowIndex];
  const cell = row?.comments?.[commentIndex];
  if (!row || !cell) return;

  finishEditing();
  const signature = normalizeCellValue(row.display_name);
  cell.reply = signature;
  state.dirtyReports.set(getReportRowKey(row), row);
  state.dirtyReplyKeys.add(getReplyKey(row, cell));
  syncChrome();
  renderTable();
}

function beginCellEditing(event) {
  const target = getEditableTargetFromEvent(event);
  if (!(target instanceof HTMLElement)) return;
  startEditingTarget(target);
}

function getEditableTargetFromEvent(event) {
  const directTarget = event.target.closest(".editable-content");
  if (directTarget instanceof HTMLElement) return directTarget;

  const cell = event.target.closest("td.name-col, td.detail-col");
  if (!(cell instanceof HTMLElement)) return null;

  const cellTarget = cell.querySelector(":scope > .editable-content");
  return cellTarget instanceof HTMLElement ? cellTarget : null;
}

function startEditingTarget(target, options = {}) {
  const { allowReadonly = false, initialValue = "" } = options;
  if (!allowReadonly && target.dataset.editable !== "true") return;
  if (target === currentEditingElement) return;

  finishEditing();
  currentEditingElement = target;
  currentEditingElement.classList.add("is-editing");

  const textarea = document.createElement("textarea");
  textarea.rows = 1;
  textarea.value = initialValue !== "" ? initialValue : target.textContent;
  textarea.className = "editing-textarea";
  const pureHeight = getEditingBaseHeight(target);
  textarea.dataset.baseHeight = String(pureHeight);
  copyDataset(target, textarea);

  textarea.addEventListener("input", (e) => {
    autoResizeTextarea(textarea);
    onCellInput(e);
  });
  textarea.addEventListener("click", (innerEvent) =>
    innerEvent.stopPropagation(),
  );
  textarea.addEventListener("keydown", (keyEvent) => {
    if (keyEvent.key === "Escape") {
      keyEvent.preventDefault();
      finishEditing();
      return;
    }
    if (keyEvent.key === "Tab") {
      keyEvent.preventDefault();
      moveEditingFocus(keyEvent.shiftKey ? -1 : 1, "horizontal");
      return;
    }
    if (keyEvent.key === "Enter" && !(keyEvent.ctrlKey || keyEvent.metaKey)) {
      keyEvent.preventDefault();
      moveEditingFocus(1, "enter");
    }
  });

  target.innerHTML = "";
  target.appendChild(textarea);
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  // DOM に追加後に高さをコンテンツに合わせる
  autoResizeTextarea(textarea);
}

function moveEditingFocus(direction, axis) {
  const textarea = currentEditingElement?.querySelector("textarea");
  if (!textarea) return;

  const nextTarget = findNextEditableTarget(textarea, direction, axis);
  finishEditing();
  if (nextTarget instanceof HTMLElement) {
    startEditingTarget(nextTarget);
  }
}

function findNextEditableTarget(textarea, direction, axis) {
  const rowIndex = Number(textarea.dataset.row);
  if (!Number.isInteger(rowIndex)) return null;

  if (axis === "vertical") {
    return findVerticalEditableTarget(textarea, rowIndex, direction);
  }
  if (axis === "enter") {
    return findEnterEditableTarget();
  }

  return findHorizontalEditableTarget(textarea, direction);
}

function findEnterEditableTarget() {
  const current = currentEditingElement;
  if (!(current instanceof HTMLElement)) return null;

  const currentRow = current.closest("tr");
  if (!(currentRow instanceof HTMLTableRowElement)) return null;

  const sameRowTargets = getEditableTargetsInRow(currentRow);
  const currentIndex = sameRowTargets.indexOf(current);
  if (currentIndex >= 0 && sameRowTargets[currentIndex + 1]) {
    return sameRowTargets[currentIndex + 1];
  }

  let nextRow = currentRow.nextElementSibling;
  while (nextRow instanceof HTMLTableRowElement) {
    const firstTarget = getEditableTargetsInRow(nextRow)[0];
    if (firstTarget) return firstTarget;
    nextRow = nextRow.nextElementSibling;
  }

  return null;
}

function getEditableTargetsInRow(row) {
  return Array.from(
    row.querySelectorAll('.editable-content[data-editable="true"]'),
  ).filter((element) => element instanceof HTMLElement && element.offsetParent);
}

function findHorizontalEditableTarget(textarea, direction) {
  const editables = getVisibleEditableTargets();
  const current = currentEditingElement;
  const index = editables.indexOf(current);
  if (index < 0) return null;
  return editables[index + direction] || null;
}

function findVerticalEditableTarget(textarea, rowIndex, direction) {
  const kind = textarea.dataset.kind;
  const field = textarea.dataset.field || "";
  const commentIndex = textarea.dataset.comment || "";
  const rows = getFilteredRows();
  const visibleIndex = rows.findIndex((row) => row.__index === rowIndex);
  if (visibleIndex < 0) return null;

  for (
    let nextIndex = visibleIndex + direction;
    nextIndex >= 0 && nextIndex < rows.length;
    nextIndex += direction
  ) {
    const nextRow = rows[nextIndex];
    const selector =
      kind === "report"
        ? `.editable-content[data-kind="report"][data-row="${nextRow.__index}"][data-field="${field}"]`
        : `.editable-content[data-kind="${kind}"][data-row="${nextRow.__index}"][data-comment="${commentIndex}"]`;
    const target = document.querySelector(selector);
    if (target instanceof HTMLElement && target.dataset.editable === "true") {
      return target;
    }
  }

  return null;
}

function getVisibleEditableTargets() {
  return Array.from(
    document.querySelectorAll('#tableWrap .editable-content[data-editable="true"]'),
  ).filter((element) => element instanceof HTMLElement && element.offsetParent);
}

function autoResizeTextarea(textarea) {
  const baseHeight = Number(textarea.dataset.baseHeight || "40") || 40;
  textarea.style.height = "0px";
  textarea.style.height = `${Math.max(textarea.scrollHeight, baseHeight)}px`;
}

function getEditingBaseHeight(target) {
  if (target.closest(".comment-stack")) {
    return target.clientHeight;
  }

  const cell = target.closest("td");
  if (!(cell instanceof HTMLElement)) return target.clientHeight;

  const cellStyle = window.getComputedStyle(cell);
  const paddingTop = Number.parseFloat(cellStyle.paddingTop) || 0;
  const paddingBottom = Number.parseFloat(cellStyle.paddingBottom) || 0;
  const availableCellHeight = cell.clientHeight - paddingTop - paddingBottom;
  return Math.max(target.clientHeight, availableCellHeight);
}

function copyDataset(source, target) {
  Object.entries(source.dataset).forEach(([key, value]) => {
    target.dataset[key] = value;
  });
}

function finishEditingOnOutsideClick(event) {
  if (!currentEditingElement) return;
  if (currentEditingElement.contains(event.target)) return;
  finishEditing();
}

function finishEditing() {
  if (!currentEditingElement) return;
  const editingElement = currentEditingElement;
  const textarea = editingElement.querySelector("textarea");
  if (textarea) {
    const normalized = normalizeCellValue(textarea.value);
    editingElement.textContent = displayText(normalized);
    editingElement.classList.toggle("is-empty", isEmpty(normalized));
    editingElement.classList.remove("is-editing");

    if (state.activeView === "boss" && textarea.dataset.kind === "comment") {
      const bossCommentActions = editingElement.parentElement?.querySelector(
        ".boss-comment-actions",
      );
      editingElement.classList.toggle("hidden", isEmpty(normalized));
      if (bossCommentActions) {
        bossCommentActions.classList.toggle("hidden", !isEmpty(normalized));
      }
    }

    const isEmptyReply =
      textarea.dataset.kind === "reply" && isEmpty(normalized);
    const replyKey = textarea.dataset.replyKey || "";
    if (isEmptyReply && replyKey) {
      state.expandedReplies.delete(replyKey);
      const replySection = editingElement.parentElement;
      if (replySection?.classList.contains("reply-section")) {
        replySection.innerHTML = `<button class="reply-toggle-button" type="button" data-action="toggle-reply" data-row="${textarea.dataset.row || ""}" data-comment="${textarea.dataset.comment || ""}">返信する</button>`;
      }
    }
  }
  currentEditingElement = null;
}

function switchView(view) {
  if (view === "boss" && !state.isSuperior) return;
  finishEditing();
  if (state.activeView === view) return;
  if (view === "settings") {
    if (state.activeView === "daily" || state.activeView === "boss") {
      state.lastReportView = state.activeView;
    }
  } else {
    state.lastReportView = view;
  }
  state.activeView = view;
  const isSettings = view === "settings";
  $("settingsPanel").classList.toggle("hidden", !isSettings);
  $("reportPanel").classList.toggle("hidden", isSettings);
  updateViewChrome();
  syncChrome();
  if (!isSettings) renderTable();
}

function updateViewAvailability() {
  const bossButton = $("bossViewButton");
  if (!bossButton) return;
  bossButton.classList.toggle("hidden", !state.isSuperior);
  if (!state.isSuperior && state.activeView === "boss") {
    state.activeView = "daily";
    state.lastReportView = "daily";
  }
}

function updateViewChrome() {
  const isBossView = state.activeView === "boss" && state.isSuperior;
  const isSettingsView = state.activeView === "settings";
  const pageTitle = $("pageTitle");
  const pageDescription = $("pageDescription");

  if (pageTitle) {
    pageTitle.textContent = isBossView ? "上司コメント" : "日報入力";
  }
  if (pageDescription) {
    pageDescription.textContent = isBossView
      ? "部下の日報を確認・コメント"
      : "自分の日報を入力・確認";
  }

  $("dailyViewButton").classList.toggle(
    "is-active",
    !isBossView && !isSettingsView,
  );
  $("bossViewButton").classList.toggle("is-active", isBossView);
  $("openSettingsButton").classList.toggle("is-active", isSettingsView);
  document.body.classList.toggle("is-boss-view", isBossView);
  document.body.classList.toggle("is-settings-view", isSettingsView);
  const bossFilterArea = $("bossFilterArea");
  if (bossFilterArea) {
    bossFilterArea.classList.toggle("hidden", !isBossView || isSettingsView);
  }
  const missingCommentsButton = $("showMissingCommentsButton");
  if (missingCommentsButton) {
    missingCommentsButton.classList.toggle(
      "hidden",
      !isBossView || isSettingsView,
    );
  }
}

function syncCurrentUserName() {
  const userName = $("currentUserName");
  if (!userName) return;
  userName.textContent = state.displayName || state.employeeId || "ユーザー";
}

function rowHasReportData(row) {
  return Boolean(
    normalizeCellValue(row.business_name) ||
      normalizeCellValue(row.business_detail),
  );
}

function rowNeedsBossComment(row) {
  if (!row || row.employee_id === state.employeeId) return false;
  if (state.missingCommentStartDate && row.date < state.missingCommentStartDate) {
    return false;
  }
  return (row.comments || []).some(
    (cell) =>
      cell.superior_employee_id === state.employeeId &&
      cell.editable &&
      (isEmpty(cell.comment) || isBossCommentDirty(row, cell)),
  );
}

function getMissingCommentSummary() {
  if (!state.isSuperior) return { count: 0, hasOverdue: false, dates: [] };
  const dates = [
    ...new Set(
      state.rows
        .filter((row) => {
          if (row.employee_id === state.employeeId) return false;
          if (state.startDate && row.date < state.startDate) return false;
          if (state.endDate && row.date > state.endDate) return false;
          if (state.hideHolidays && row.is_holiday && !rowHasReportData(row)) {
            return false;
          }
          return rowNeedsBossComment(row);
        })
        .map((row) => row.date),
    ),
  ].sort();
  const today = getTodayJST();
  return {
    count: dates.length,
    hasOverdue: dates.some((date) => date < today),
    dates,
  };
}

function getMissingCommentCount() {
  return getMissingCommentSummary().count;
}

function getFilteredRows() {
  const indexedRows = state.rows.map((row, index) => ({
    ...row,
    __index: index,
  }));

  const filteredByDate = indexedRows.filter((row) => {
    if (state.startDate && row.date < state.startDate) return false;
    if (state.endDate && row.date > state.endDate) return false;
    return true;
  });

  const filteredByHoliday = state.hideHolidays
    ? filteredByDate.filter((row) => !row.is_holiday || rowHasReportData(row))
    : filteredByDate;

  if (state.activeView === "boss" && state.isSuperior) {
    const selectedId = state.selectedSubordinateId;
    return filteredByHoliday.filter((row) => {
      if (row.employee_id === state.employeeId) return false;
      if (selectedId && row.employee_id !== selectedId) {
        return false;
      }
      if (state.showMissingCommentsOnly && !rowNeedsBossComment(row)) {
        return false;
      }
      return true;
    });
  }

  return filteredByHoliday.filter(
    (row) => row.employee_id === state.employeeId,
  );
}

function getEmptyMessage() {
  if (state.activeView === "boss" && state.isSuperior) {
    if (state.showMissingCommentsOnly) {
      return "条件に一致する未確認の日報はありません。";
    }
    return "条件に一致する部下の日報はありません。";
  }
  return "表示対象の日報がありません。";
}

function onCellInput(event) {
  const target = event.target;
  const row = state.rows[Number(target.dataset.row)];
  if (!row) return;
  const normalizedValue = normalizeCellValue(target.value);
  if (target.dataset.kind === "report") {
    row[target.dataset.field] = normalizedValue;
    state.dirtyReports.set(getReportRowKey(row), row);
    state.dirtyReportFields.add(getReportFieldKey(row, target.dataset.field));
    markReportFieldDirtyUi(target.dataset.row, target.dataset.field);
  }
  if (target.dataset.kind === "reply") {
    const cell = row.comments[Number(target.dataset.comment)];
    cell.reply = normalizedValue;
    state.dirtyReports.set(getReportRowKey(row), row);
    state.dirtyReplyKeys.add(getReplyKey(row, cell));
    markCurrentEditingDirtyUi();
  }
  if (target.dataset.kind === "comment") {
    const cell = row.comments[Number(target.dataset.comment)];
    cell.comment = normalizedValue;
    state.dirtyComments.set(
      `${row.employee_id}|${row.date}|${cell.superior_employee_id}`,
      { row, cell },
    );
    markCurrentEditingDirtyUi();
  }
  syncChrome();
}

function markReportFieldDirtyUi(rowIndex, field) {
  if (rowIndex === undefined || rowIndex === "" || !field) return;
  document
    .querySelectorAll(
      `.editable-content[data-kind="report"][data-row="${rowIndex}"][data-field="${field}"]`,
    )
    .forEach((element) => {
      element.closest("td")?.classList.add("is-dirty-cell");
    });
}

function markCurrentEditingDirtyUi() {
  currentEditingElement?.classList.add("is-dirty");
}

function buildSaveResultMessage(result, userCount, commentCount) {
  if (result.ok) {
    const savedLabels = [];
    if (userCount) savedLabels.push(`日報${userCount}件`);
    if (commentCount) savedLabels.push(`コメント${commentCount}件`);
    return `${savedLabels.join(" / ")}を保存しました。`;
  }

  if (result.no_targets) {
    return "更新対象がありません。";
  }

  const targetLabels = [];
  if (userCount) targetLabels.push(`日報${userCount}件`);
  if (commentCount) targetLabels.push(`コメント${commentCount}件`);
  const summary = targetLabels.length
    ? `${targetLabels.join(" / ")}の保存に失敗しました。`
    : "保存に失敗しました。";
  return `${summary} ${result.message}`.trim();
}

async function saveUpdates() {
  finishEditing();
  const userUpdates = Array.from(state.dirtyReports.values()).map((row) => ({
    date: row.date,
    business_name: normalizeCellValue(row.business_name),
    business_detail: normalizeCellValue(row.business_detail),
    replies: row.comments.map((cell) => ({
      superior_employee_id: cell.superior_employee_id,
      reply: normalizeCellValue(cell.reply),
    })),
  }));
  const commentUpdates = Array.from(state.dirtyComments.values()).map(
    ({ row, cell }) => ({
      subordinate_employee_id: row.employee_id,
      date: row.date,
      comment: normalizeCellValue(cell.comment),
    }),
  );
  notify({
    text: `保存中です... 日報${userUpdates.length}件 / コメント${commentUpdates.length}件`,
    type: "info",
  });
  setBusy(true, "save");
  const result = await window.pywebview.api.save_updates({
    user_updates: userUpdates,
    comment_updates: commentUpdates,
  });
  setBusy(false);
  if (result.ok) {
    // 保存成功: サイレントリロード後に確定メッセージを1回だけ表示
    state.dirtyReports.clear();
    state.dirtyComments.clear();
    state.dirtyReportFields.clear();
    state.dirtyReplyKeys.clear();
    syncChrome();
    await loadData({ silent: true });
    notify({
      text: buildSaveResultMessage(
        result,
        userUpdates.length,
        commentUpdates.length,
      ),
      type: "success",
    });
  } else {
    // 対象なし→グレー、実際の失敗→赤
    const msgType = result.no_targets ? "info" : "error";
    notify({
      text: buildSaveResultMessage(
        result,
        userUpdates.length,
        commentUpdates.length,
      ),
      type: msgType,
    });
    syncChrome();
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

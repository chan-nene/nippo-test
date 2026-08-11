// Shared application state, shell behavior, and startup.
const state = {
  employeeId: "",
  displayName: "",
  isSuperior: false,
  activeView: "reports",
  hasInitializedReportView: false,
  memberScope: "all",
  viewableMembers: [],
  currentTeam: [],
  selectedSubordinateId: "",
  expandedReplies: new Set(),
  pendingReplyFocusKey: "",

  rows: [],
  reportChanges: new Map(),
  commentChanges: new Map(),
  startDate: "",
  activePeriodPreset: "default",
  periodBeforeMissing: null,
  legacyLoadPreset: "",
  myRank: 9999,
  isBusy: false,
  busyAction: "",
  showMissingCommentsOnly: false,
  missingCommentStartDate: "",
  includeTodayInMissingComments: false,
  missingCommentDates: null,
  missingCommentRangeStart: "",
  missingCommentRangeEnd: "",
  commentSignature: "",
  fontSize: "large",
};

let currentEditingElement = null;
let uiStateSaveQueue = Promise.resolve();
let lastNativeUnsavedState = null;
const toastState = {
  hideTimer: null,
  fadeTimer: null,
};
const actionButtonSignatures = new Map();
const PERIOD_MODES = ["month", "week", "day", "default"];
const LEGACY_PERIOD_MODE_MAP = Object.freeze({
  last7days: "default",
  previousWorkday: "day",
  today: "day",
  previousWeek: "week",
  thisWeek: "week",
  previousMonth: "month",
  thisMonth: "month",
});

const $ = (id) => document.getElementById(id);

function bindEvents() {
  $("saveSettingsButton").addEventListener("click", saveSettings);
  $("refreshButton").addEventListener("click", refreshData);
  $("saveButton").addEventListener("click", saveUpdates);
  $("dismissToastButton").addEventListener("click", dismissToast);
  $("openSettingsButton").addEventListener("click", () => switchView("settings"));
  $("adminViewButton").addEventListener("click", () => switchView("admin"));
  $("fontSizeButton").addEventListener("click", toggleFontSizeMenu);
  $("fontSizeMenu").addEventListener("click", (event) => {
    const button = event.target.closest("[data-font-size]");
    if (button) setFontSize(button.dataset.fontSize);
  });
  $("defaultStartOffsetDays").addEventListener("input", updateDefaultRangePreview);
  $("defaultEndOffsetDays").addEventListener("input", updateDefaultRangePreview);
  $("startDate").addEventListener("change", handleDateChange);
  $("endDate").addEventListener("change", handleDateChange);

  [
    ["presetMonthButton", "month"],
    ["presetWeekButton", "week"],
    ["presetDayButton", "day"],
    ["presetDefaultButton", "default"],
  ].forEach(([buttonId, presetName]) => {
    $(buttonId)?.addEventListener("click", () => applyPreset(presetName));
  });

  $("periodPrevButton")?.addEventListener("click", () => shiftDateRange(-1));
  $("periodNextButton")?.addEventListener("click", () => shiftDateRange(1));

  const btnMissingComments = $("showMissingCommentsButton");
  if (btnMissingComments) {
    btnMissingComments.addEventListener("click", () => applyPreset("missing"));
  }

  $("bossSearchControl").addEventListener("click", (e) => {
    const scopeButton = e.target.closest("[data-member-scope]");
    if (scopeButton) {
      setMemberScope(scopeButton.dataset.memberScope);
      return;
    }
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
  $("dailyViewButton").addEventListener("click", () => switchView("reports"));
  window.adminMasters?.initialize();
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

function restoreUiState(settings) {
  const requestedPreset = String(settings.ui_period_preset ?? "default").trim();
  const supportedPresets = new Set([
    ...PERIOD_MODES,
    ...Object.keys(LEGACY_PERIOD_MODE_MAP),
    "missing",
    "",
  ]);
  const savedPreset = supportedPresets.has(requestedPreset)
    ? requestedPreset
    : "default";
  const savedStartDate = String(settings.ui_start_date || "").trim();
  const savedEndDate = String(settings.ui_end_date || "").trim();

  state.periodBeforeMissing = null;
  state.legacyLoadPreset = "";
  if (savedPreset === "missing") {
    const range = getPresetRange("missing");
    state.activePeriodPreset = "default";
    state.showMissingCommentsOnly = true;
    state.startDate = range.startDate;
    state.endDate = range.endDate;
  } else {
    const periodMode = LEGACY_PERIOD_MODE_MAP[savedPreset] ?? savedPreset;
    const restoredRange = getRestorablePeriodRange(
      periodMode,
      savedStartDate,
      savedEndDate,
    );
    const range = restoredRange || getPresetRange(savedPreset);
    const hasUsableCustomRange = periodMode !== "" || Boolean(restoredRange);
    state.activePeriodPreset = hasUsableCustomRange ? periodMode : "default";
    state.showMissingCommentsOnly = false;
    state.legacyLoadPreset =
      savedPreset === "previousWorkday" ? "previousWorkday" : "";
    state.startDate = hasUsableCustomRange ? range.startDate : "";
    state.endDate = hasUsableCustomRange ? range.endDate : "";
  }
  state.fontSize = ["compact", "standard", "medium", "large", "xlarge"].includes(
    settings.ui_font_size,
  )
    ? settings.ui_font_size
    : "large";
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
  const periodPreset = state.showMissingCommentsOnly
    ? "missing"
    : state.activePeriodPreset;
  const shouldPersistDates =
    !state.showMissingCommentsOnly &&
    ["month", "week", "day", ""].includes(state.activePeriodPreset);
  const payload = {
    sidebar_open: $("sidebar").classList.contains("is-open"),
    period_preset: periodPreset,
    start_date: shouldPersistDates ? state.startDate : "",
    end_date: shouldPersistDates ? state.endDate : "",
    font_size: state.fontSize,
  };
  uiStateSaveQueue = uiStateSaveQueue
    .catch(() => {})
    .then(() => api.save_ui_state(payload))
    .catch(() => {});
}

function getRestorablePeriodRange(periodMode, startDate, endDate) {
  if (
    !isValidIsoDate(startDate) ||
    !isValidIsoDate(endDate) ||
    startDate > endDate
  ) {
    return null;
  }
  const range = { startDate, endDate };
  if (periodMode === "month") {
    const expected = getCalendarMonthRange(startDate);
    return expected.startDate === startDate && expected.endDate === endDate
      ? range
      : null;
  }
  if (periodMode === "week") {
    const expected = getMondayBasedWeekRange(startDate);
    return expected.startDate === startDate && expected.endDate === endDate
      ? range
      : null;
  }
  if (periodMode === "day") return startDate === endDate ? range : null;
  if (periodMode !== "") return null;
  const inclusiveDays =
    Math.round(
      (Date.parse(`${endDate}T00:00:00Z`) -
        Date.parse(`${startDate}T00:00:00Z`)) /
        86400000,
    ) + 1;
  return inclusiveDays <= 366 ? range : null;
}

function isValidIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
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
  if (!["compact", "standard", "medium", "large", "xlarge"].includes(fontSize)) return;
  state.fontSize = fontSize;
  applyFontSize();
  closeFontSizeMenu();
  persistUiState();
}

function applyFontSize() {
  document.body.dataset.fontSize = state.fontSize;
  $("fontSizeButton").classList.remove("is-active");
  $("fontSizeMenu")
    .querySelectorAll("[data-font-size]")
    .forEach((button) => {
      const isActive = button.dataset.fontSize === state.fontSize;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-pressed", String(isActive));
    });
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
  switchView(visible ? "settings" : "reports");
}

function showMain(visible) {
  // ツールバーは常時表示。テーブルだけ出し入れする
  $("tableWrap").classList.toggle("hidden", !visible);
}

function hasUnsavedChanges() {
  return (
    getDirtyCounts().total > 0 ||
    Boolean(window.adminMasters?.hasUnsaved?.())
  );
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
  if (state.isBusy) return;
  if (state.activeView === "admin") {
    window.adminMasters?.save?.();
    return;
  }
  if (getDirtyCounts().total === 0) return;
  saveUpdates();
}

function notify({ text, type = "info", autoHide = shouldAutoHideToast(type) }) {
  const message = $("message");
  if (!message) return;
  clearToastTimers();
  $("messageText").textContent = text;
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

  if (autoHide) {
    scheduleToastHide(type);
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

function shouldAutoHideToast() {
  return true;
}

function clearToastTimers() {
  if (toastState.hideTimer) clearTimeout(toastState.hideTimer);
  if (toastState.fadeTimer) clearTimeout(toastState.fadeTimer);
  toastState.hideTimer = null;
  toastState.fadeTimer = null;
}

function scheduleToastHide(type = "info") {
  const message = $("message");
  if (!message) return;

  // エラーと警告は読み取る時間を長めにし、いずれも自動で閉じる。
  const visibleDuration = type === "error" || type === "warning" ? 7000 : 4000;
  toastState.hideTimer = setTimeout(() => {
    message.classList.add("is-fading");
    toastState.fadeTimer = setTimeout(() => {
      hideToast(message);
      message.classList.remove("is-fading");
      clearToastTimers();
    }, 300);
  }, visibleDuration);
}

function dismissToast() {
  const message = $("message");
  if (!message) return;
  clearToastTimers();
  message.classList.remove("is-fading");
  hideToast(message);
}

function showToast(message) {
  message.classList.remove("hidden");
}

function hideToast(message) {
  message.classList.add("hidden");
}

function setBusy(busy, action = "") {
  state.isBusy = busy;
  state.busyAction = busy ? action : "";
  document.querySelectorAll("button").forEach((button) => {
    if (!button.hasAttribute("data-allow-when-busy")) button.disabled = busy;
  });
  syncChrome();
  syncPeriodPresets();
}

function switchView(view) {
  finishEditing();
  if (state.activeView === view) return;
  state.activeView = view;
  const isSettings = view === "settings";
  const isAdmin = view === "admin";
  $("settingsPanel").classList.toggle("hidden", !isSettings);
  $("adminPanel").classList.toggle("hidden", !isAdmin);
  $("reportPanel").classList.toggle("hidden", isSettings || isAdmin);
  updateViewChrome();
  syncChrome();
  if (isAdmin) {
    window.adminMasters?.ensureLoaded?.();
  } else if (!isSettings) {
    renderTable();
  }
}

function updateViewAvailability() {
  // The report screen is shared by every role; permissions are row-specific.
}

function updateViewChrome() {
  const isReportView = state.activeView === "reports";
  const isSettingsView = state.activeView === "settings";
  const isAdminView = state.activeView === "admin";
  $("dailyViewButton").classList.toggle(
    "is-active",
    isReportView && !isSettingsView && !isAdminView,
  );
  $("adminViewButton").classList.toggle("is-active", isAdminView);
  $("openSettingsButton").classList.toggle("is-active", isSettingsView);
  document.body.classList.toggle("is-boss-view", state.isSuperior && isReportView);
  document.body.classList.toggle("is-settings-view", isSettingsView);
  document.body.classList.toggle("is-admin-view", isAdminView);
  const bossFilterArea = $("bossFilterArea");
  if (bossFilterArea) {
    bossFilterArea.classList.toggle(
      "hidden",
      !isReportView || isSettingsView || isAdminView,
    );
  }
  const missingCommentsFilterGroup = $("missingCommentsFilterGroup");
  if (missingCommentsFilterGroup) {
    missingCommentsFilterGroup.classList.toggle(
      "hidden",
      !isReportView || !state.isSuperior || isSettingsView || isAdminView,
    );
  }
}

function syncCurrentUserName() {
  const userName = $("currentUserName");
  if (!userName) return;
  userName.textContent = state.displayName || state.employeeId || "ユーザー";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

window.addEventListener("pywebviewready", async () => {
  updateSidebarToggleButton();
  bindEvents();
  syncChrome();
  updateViewChrome();
  const initial = await window.pywebview.api.get_initial_state();
  state.employeeId = initial.employee_id;
  syncCurrentUserName();
  fillSettings(initial.settings || {});
  restoreUiState(initial.settings || {});
  if (!initial.settings_complete) {
    showSettings(true);
    notify({ text: "初回設定を行ってください。", type: "info" });
    return;
  }
  await loadData();
});

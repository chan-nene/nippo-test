// Shared application state, shell behavior, and startup.
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

  rows: [],
  reportChanges: new Map(),
  commentChanges: new Map(),
  startDate: "",
  activePeriodPreset: "default",
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
  darkMode: false,
  fontSize: "standard",
  colorTheme: "green",
};

let currentEditingElement = null;
let uiStateSaveQueue = Promise.resolve();
let lastNativeUnsavedState = null;
const toastState = {
  hideTimer: null,
  fadeTimer: null,
};
const actionButtonSignatures = new Map();
const COLOR_THEMES = ["green", "blue", "orange"];

const $ = (id) => document.getElementById(id);

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
  $("colorThemeOptions")?.addEventListener("click", (event) => {
    const button = event.target.closest(".color-theme-option[data-color-theme]");
    if (button) setColorTheme(button.dataset.colorTheme);
  });
  $("defaultStartOffsetDays").addEventListener("input", updateDefaultRangePreview);
  $("defaultEndOffsetDays").addEventListener("input", updateDefaultRangePreview);
  $("startDate").addEventListener("change", handleDateChange);
  $("endDate").addEventListener("change", handleDateChange);

  [
    ["presetDefaultButton", "default"],
    ["presetPreviousWorkdayButton", "previousWorkday"],
    ["presetTodayButton", "today"],
    ["presetPreviousWeekButton", "previousWeek"],
    ["presetThisWeekButton", "thisWeek"],
    ["presetPreviousMonthButton", "previousMonth"],
    ["presetThisMonthButton", "thisMonth"],
  ].forEach(([buttonId, presetName]) => {
    $(buttonId)?.addEventListener("click", () => applyPreset(presetName));
  });

  const btnMissingComments = $("showMissingCommentsButton");
  if (btnMissingComments) {
    btnMissingComments.addEventListener("click", () => applyPreset("missing"));
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

function restoreUiState(settings) {
  const savedPreset =
    settings.ui_period_preset === "last7days"
      ? "default"
      : settings.ui_period_preset;
  const preset = [
    "default",
    "previousWorkday",
    "today",
    "previousWeek",
    "thisWeek",
    "previousMonth",
    "thisMonth",
    "missing",
    "",
  ].includes(savedPreset)
    ? savedPreset
    : "default";
  const range = getPresetRange(preset);
  state.activePeriodPreset = preset;
  state.showMissingCommentsOnly = preset === "missing";
  state.startDate = preset
    ? range.startDate
    : String(settings.ui_start_date || "");
  state.endDate = preset ? range.endDate : String(settings.ui_end_date || "");
  state.fontSize = ["standard", "large", "xlarge"].includes(
    settings.ui_font_size,
  )
    ? settings.ui_font_size
    : "standard";
  state.colorTheme = normalizeColorTheme(settings.ui_color_theme);

  const sidebar = $("sidebar");
  const isSidebarOpen = settings.ui_sidebar_open !== false;
  sidebar.classList.toggle("is-open", isSidebarOpen);
  updateSidebarToggleButton(isSidebarOpen);
  syncPeriodPresets();
  applyFontSize();
  applyTheme();
}

function persistUiState() {
  const api = window.pywebview?.api;
  if (typeof api?.save_ui_state !== "function") return;
  const payload = {
    sidebar_open: $("sidebar").classList.contains("is-open"),
    period_preset: state.activePeriodPreset,
    start_date: state.activePeriodPreset ? "" : state.startDate,
    end_date: state.activePeriodPreset ? "" : state.endDate,
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

function toggleTheme() {
  state.darkMode = !state.darkMode;
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

function normalizeColorTheme(colorTheme) {
  return COLOR_THEMES.includes(colorTheme) ? colorTheme : "green";
}

function setColorTheme(colorTheme) {
  state.colorTheme = normalizeColorTheme(colorTheme);
  applyTheme();
}

function syncColorThemeOptions() {
  $("colorThemeOptions")
    ?.querySelectorAll("[data-color-theme]")
    .forEach((button) => {
      const isSelected = button.dataset.colorTheme === state.colorTheme;
      button.classList.toggle("is-selected", isSelected);
      button.setAttribute("aria-pressed", String(isSelected));
    });
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
  document.body.dataset.colorTheme = normalizeColorTheme(state.colorTheme);
  document.body.classList.toggle("is-dark-mode", state.darkMode);
  document.documentElement.classList.toggle("dark", state.darkMode);
  document.documentElement.classList.toggle("light", !state.darkMode);
  document.documentElement.style.colorScheme = state.darkMode ? "dark" : "light";
  syncColorThemeOptions();
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
    }, 800);
  }, 3000);
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
    button.disabled = busy;
  });
  syncChrome();
  syncPeriodPresets();
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

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

window.addEventListener("pywebviewready", async () => {
  applyTheme();
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

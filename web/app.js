// Shared application state, shell behavior, and startup.
const MEMBER_FILTER_LEVELS = Object.freeze(["department", "section", "member"]);
const MEMBER_FILTER_LABELS = Object.freeze({
  department: "課",
  section: "係",
  member: "個人",
});
const ACCESS_DENIED_MESSAGE = "このアプリは使用できません。管理者に連絡してください。";

function normalizeMemberFilterLevels(value, fallback = MEMBER_FILTER_LEVELS) {
  const parseLevels = (raw) => {
    const values = Array.isArray(raw)
      ? raw.map((item) => String(item).trim())
      : String(raw ?? "")
          .replaceAll(";", ",")
          .split(",")
          .map((item) => item.trim());
    const aliases = { large: "department", medium: "section", small: "section" };
    return values.map((item) => aliases[item] || item);
  };
  const fallbackLevels = MEMBER_FILTER_LEVELS.filter((level) =>
    parseLevels(fallback).includes(level),
  );
  if (value === undefined || value === null) return fallbackLevels;
  const rawLevels = parseLevels(value);
  const normalized = MEMBER_FILTER_LEVELS.filter((level) => rawLevels.includes(level));
  if (normalized.length || rawLevels.every((level) => !level)) return normalized;
  return fallbackLevels;
}

const state = {
  employeeId: "",
  displayName: "",
  canInputOwnReport: true,
  isSuperior: false,
  isDirector: false,
  isAdmin: false,
  restrictToSelf: false,
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
  missingCommentMode: "daily",
  missingCommentMemberCounts: {},
  directorMissingDays: 0,
  commentSignature: "",
  settingsSnapshot: "",
  colorTheme: "light",
  fontSize: "large",
  columnWidths: {},
  memberFilterLevels: [...MEMBER_FILTER_LEVELS],
  accessDenied: false,
  closeApproved: false,
  loadRequestSequence: 0,
  cacheGeneration: 0,
};

let currentEditingElement = null;
let uiStateSaveQueue = Promise.resolve();
let lastNativeUnsavedState = null;
let pendingConfirmation = null;
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

function normalizeColorTheme(value) {
  return value === "dark" ? "dark" : "light";
}

function applyColorTheme(value) {
  const theme = normalizeColorTheme(value);
  state.colorTheme = theme;
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  syncColorThemeControls(theme);
}

function getColorThemeOptions() {
  return [
    ...document.querySelectorAll("#colorThemeControl [role=\"radio\"]"),
  ];
}

function updateColorThemeIndicator() {
  const group = $("colorThemeControl");
  const indicator = group?.querySelector(".theme-indicator");
  const selected = getColorThemeOptions().find(
    (option) => option.getAttribute("aria-checked") === "true",
  );
  if (!indicator || !selected) return;
  indicator.style.width = `${selected.offsetWidth}px`;
  indicator.style.transform = `translate3d(${selected.offsetLeft}px, 0, 0)`;
}

function updateColorThemeRovingTabindex(focusedIndex) {
  getColorThemeOptions().forEach((option, index) => {
    option.tabIndex = index === focusedIndex ? 0 : -1;
  });
}

function syncColorThemeControls(theme = state.colorTheme) {
  const options = getColorThemeOptions();
  const selectedIndex = options.findIndex(
    (option) => option.dataset.themeOption === theme,
  );
  options.forEach((option, index) => {
    const selected = index === selectedIndex;
    option.dataset.state = selected ? "on" : "off";
    option.setAttribute("aria-checked", String(selected));
  });
  if (selectedIndex >= 0) updateColorThemeRovingTabindex(selectedIndex);
  updateColorThemeIndicator();
  document
    .querySelectorAll('input[name="uiColorTheme"]')
    .forEach((input) => {
      input.checked = input.value === theme;
    });
}

function setColorTheme(value, focus = true) {
  const theme = normalizeColorTheme(value);
  const settingsWereDirty =
    typeof isSettingsDirty === "function" && isSettingsDirty();
  applyColorTheme(theme);
  if (!settingsWereDirty && typeof getSettingsDraftSnapshot === "function") {
    state.settingsSnapshot = getSettingsDraftSnapshot();
  }
  syncChrome();
  persistUiState();
  if (focus) {
    getColorThemeOptions()
      .find((option) => option.dataset.themeOption === theme)
      ?.focus({ preventScroll: true });
  }
}

function colorThemeKeyboardIndex(event, currentIndex, optionCount) {
  if (event.key === "ArrowRight") return (currentIndex + 1) % optionCount;
  if (event.key === "ArrowLeft") {
    return (currentIndex - 1 + optionCount) % optionCount;
  }
  if (event.key === "Home") return 0;
  if (event.key === "End") return optionCount - 1;
  return -1;
}

function moveColorThemeFocus(index) {
  const options = getColorThemeOptions();
  const step = index >= options.length ? 1 : -1;
  let next = index;
  for (let count = 0; count < options.length; count += 1) {
    const option = options[next];
    if (option && !option.hasAttribute("data-disabled") && !option.disabled) {
      updateColorThemeRovingTabindex(next);
      option.focus({ preventScroll: true });
      return;
    }
    next = (next + step + options.length) % options.length;
  }
}

function initializeColorThemeControl() {
  const group = $("colorThemeControl");
  if (!group) return;
  const options = getColorThemeOptions();
  options.forEach((option, index) => {
    option.addEventListener("click", () => {
      setColorTheme(option.dataset.themeOption);
    });
    option.addEventListener("keydown", (event) => {
      const nextIndex = colorThemeKeyboardIndex(event, index, options.length);
      if (nextIndex >= 0) {
        event.preventDefault();
        moveColorThemeFocus(nextIndex);
      } else if (event.key === " " || event.key === "Enter") {
        event.preventDefault();
        setColorTheme(option.dataset.themeOption);
      }
    });
  });
  group.addEventListener("keydown", (event) => {
    if (event.target !== group) return;
    const currentIndex = options.findIndex((option) => option.tabIndex === 0);
    const baseIndex = currentIndex < 0 ? 0 : currentIndex;
    const nextIndex = colorThemeKeyboardIndex(
      event,
      baseIndex,
      options.length,
    );
    if (nextIndex >= 0) {
      event.preventDefault();
      moveColorThemeFocus(nextIndex);
    } else if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      setColorTheme(options[baseIndex]?.dataset.themeOption);
    }
  });
  window.addEventListener("resize", updateColorThemeIndicator, { passive: true });
  if ("ResizeObserver" in window) {
    new ResizeObserver(updateColorThemeIndicator).observe(group);
  }
  syncColorThemeControls();
  requestAnimationFrame(updateColorThemeIndicator);
}

function bindEvents() {
  $("saveSettingsButton").addEventListener("click", saveSettings);
  $("settingsPanel").addEventListener("input", syncSettingsDirtyState);
  $("settingsPanel").addEventListener("change", syncSettingsDirtyState);
  $("refreshButton").addEventListener("click", refreshData);
  $("saveButton").addEventListener("click", saveUpdates);
  $("cancelActionConfirmButton").addEventListener("click", () => {
    resolveConfirmationDialog(false);
  });
  $("confirmActionConfirmButton").addEventListener("click", () => {
    resolveConfirmationDialog(true);
  });
  $("actionConfirmDialog").addEventListener("cancel", (event) => {
    event.preventDefault();
    resolveConfirmationDialog(false);
  });
  $("actionConfirmDialog").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) resolveConfirmationDialog(false);
  });
  $("resetColumnWidthsButton").addEventListener(
    "click",
    openResetColumnWidthsDialog,
  );
  $("cancelResetColumnWidthsButton").addEventListener(
    "click",
    closeResetColumnWidthsDialog,
  );
  $("confirmResetColumnWidthsButton").addEventListener("click", () => {
    closeResetColumnWidthsDialog();
    resetColumnWidths();
  });
  $("resetColumnWidthsDialog").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) closeResetColumnWidthsDialog();
  });
  $("dismissToastButton").addEventListener("click", dismissToast);
  $("openSettingsButton").addEventListener("click", () => switchView("settings"));
  $("adminViewButton").addEventListener("click", () => switchView("admin"));
  $("fontSizeButton").addEventListener("click", toggleFontSizeMenu);
  $("fontSizeMenu").addEventListener("click", (event) => {
    const button = event.target.closest("[data-font-size]");
    if (button) setFontSize(button.dataset.fontSize);
  });
  initializeColorThemeControl();
  $("defaultStartOffsetDays").addEventListener("input", updateDefaultRangePreview);
  $("defaultEndOffsetDays").addEventListener("input", updateDefaultRangePreview);
  ["startDate", "endDate"].forEach((inputId) => {
    const input = $(inputId);
    if (!input) return;
    const field = input.closest(".period-field-group");
    input.addEventListener("change", handleDateChange);
    field?.addEventListener("pointerdown", () => {
      clearDateInputSelection(input);
      field?.classList.add("is-pointer-focused");
    });
    input.addEventListener("keydown", () => {
      field?.classList.remove("is-pointer-focused");
    });
    input.addEventListener("blur", () => {
      field?.classList.remove("is-pointer-focused");
    });
    field?.addEventListener("click", () => {
      clearDateInputSelection(input);
      openDatePickerFromField(input);
    });
  });

  initializePeriodPresetControl();

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
  $("tableWrap").addEventListener("click", handleTableClick);
  $("tableWrap").addEventListener("keydown", handleTableKeydown);
  $("tableWrap").addEventListener("pointerdown", startColumnResize);
  $("tableWrap").addEventListener("pointermove", moveColumnResize);
  $("tableWrap").addEventListener("pointerup", finishColumnResize);
  $("tableWrap").addEventListener("pointercancel", finishColumnResize);
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

function openResetColumnWidthsDialog() {
  const dialog = $("resetColumnWidthsDialog");
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
  requestAnimationFrame(() => $("cancelResetColumnWidthsButton").focus());
}

function closeResetColumnWidthsDialog() {
  const dialog = $("resetColumnWidthsDialog");
  if (typeof dialog.close === "function" && dialog.open) dialog.close();
  else dialog.removeAttribute("open");
}

function openDatePickerFromField(input) {
  if (typeof input?.showPicker !== "function") return;
  try {
    input.showPicker();
  } catch {
    // The browser may already have opened the native picker from its icon.
  }
}

function clearDateInputSelection(input) {
  const selection = window.getSelection?.();
  selection?.removeAllRanges();
  try {
    input?.setSelectionRange?.(0, 0);
  } catch {
    // Chromium does not expose a text range for date inputs.
  }
}

function restoreUiState(settings) {
  applyColorTheme(settings.ui_color_theme);
  state.memberFilterLevels = normalizeMemberFilterLevels(
    settings.ui_member_filter_levels,
  );
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
  state.columnWidths = parseStoredColumnWidths(settings.ui_column_widths);
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
    period_preset: periodPreset,
    start_date: shouldPersistDates ? state.startDate : "",
    end_date: shouldPersistDates ? state.endDate : "",
    font_size: state.fontSize,
    column_widths: state.columnWidths,
    ui_color_theme: state.colorTheme,
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
  applyColumnWidthsToRenderedTable();
}

function showSettings(visible) {
  switchView(visible ? "settings" : "reports");
}

function showAccessDenied(message = ACCESS_DENIED_MESSAGE) {
  state.accessDenied = true;
  state.isBusy = false;
  state.busyAction = "";
  $("accessDeniedMessage").textContent = message || ACCESS_DENIED_MESSAGE;
  $("accessDeniedPanel").classList.remove("hidden");
  $("mainPanel").classList.add("hidden");
  $("dailyViewButton").classList.add("hidden");
  $("adminViewButton").classList.add("hidden");
  $("openSettingsButton").classList.add("hidden");
  document.body.classList.add("is-access-denied");
}

function showMain(visible) {
  // ツールバーは常時表示。テーブルだけ出し入れする
  $("tableWrap").classList.toggle("hidden", !visible);
}

function hasUnsavedChanges() {
  return (
    getDirtyCounts().total > 0 ||
    Boolean(window.isSettingsDirty?.()) ||
    Boolean(window.adminMasters?.hasUnsaved?.())
  );
}

function requestConfirmationDialog({
  title,
  description,
  confirmLabel,
  cancelLabel,
  confirmTone = "primary",
}) {
  const dialog = $("actionConfirmDialog");
  if (!dialog) return Promise.resolve(false);

  if (pendingConfirmation) resolveConfirmationDialog(false);

  const confirmation = { resolve: null, previousFocus: document.activeElement };
  const promise = new Promise((resolve) => {
    confirmation.resolve = resolve;
  });
  pendingConfirmation = confirmation;

  $("actionConfirmDialogTitle").textContent = title;
  $("actionConfirmDialogDescription").textContent = description;
  $("cancelActionConfirmButton").textContent = cancelLabel;
  const confirmButton = $("confirmActionConfirmButton");
  confirmButton.textContent = confirmLabel;
  confirmButton.className = `dialog-button ${
    confirmTone === "danger" ? "danger" : "primary"
  }`;

  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
  requestAnimationFrame(() => {
    if (pendingConfirmation === confirmation) $("cancelActionConfirmButton").focus();
  });
  return promise;
}

function resolveConfirmationDialog(confirmed) {
  const confirmation = pendingConfirmation;
  if (!confirmation) return;
  pendingConfirmation = null;
  const dialog = $("actionConfirmDialog");
  if (typeof dialog.close === "function" && dialog.open) dialog.close();
  else dialog.removeAttribute("open");
  confirmation.resolve(Boolean(confirmed));
  if (confirmation.previousFocus?.isConnected) confirmation.previousFocus.focus();
}

async function confirmDiscardUnsaved(action) {
  if (!hasUnsavedChanges()) return true;
  return requestConfirmationDialog({
    title: "未保存の変更があります",
    description: `${action}すると、保存していない変更は失われます。`,
    confirmLabel: `破棄して${action}`,
    cancelLabel: "このまま編集を続ける",
    confirmTone: "danger",
  });
}

function handleBeforeUnload(event) {
  if (state.closeApproved || !hasUnsavedChanges()) return;
  event.preventDefault();
  event.returnValue = "";
}

async function closeNativeWindow() {
  const api = window.pywebview?.api;
  if (typeof api?.close_window !== "function") return;
  state.closeApproved = true;
  const result = await api.close_window();
  if (!result?.ok) state.closeApproved = false;
}

function requestNativeCloseConfirmation() {
  if (!hasUnsavedChanges()) {
    void closeNativeWindow();
    return;
  }
  requestConfirmationDialog({
    title: "未保存の変更があります",
    description: "アプリを終了すると、保存していない変更は失われます。",
    confirmLabel: "破棄して終了",
    cancelLabel: "終了しない",
    confirmTone: "danger",
  }).then((confirmed) => {
    if (confirmed) void closeNativeWindow();
  });
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
  const preferredSaveButton =
    state.activeView === "admin"
      ? $("adminSaveButton") || document.querySelector("[data-save-editor]")
      : state.activeView === "settings"
        ? $("saveSettingsButton")
        : $("saveButton");
  const hasVisibleSaveButton = Boolean(
    preferredSaveButton && preferredSaveButton.offsetParent !== null,
  );
  const mainPanel = $("mainPanel");
  if (!hasVisibleSaveButton && !mainPanel) return;
  const anchor = hasVisibleSaveButton
    ? preferredSaveButton.getBoundingClientRect()
    : mainPanel.getBoundingClientRect();
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
  if (state.accessDenied) return;
  finishEditing();
  if (view === "admin" && !state.isAdmin) {
    notify({ text: "管理者機能を利用する権限がありません。", type: "error" });
    return;
  }
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
  const adminButton = $("adminViewButton");
  if (adminButton) {
    adminButton.classList.toggle("hidden", state.accessDenied || !state.isAdmin);
  }
  $("dailyViewButton")?.classList.toggle("hidden", state.accessDenied);
  $("openSettingsButton")?.classList.toggle("hidden", state.accessDenied);
  if (state.accessDenied) return;
  if (!state.isAdmin && state.activeView === "admin") switchView("reports");
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
  if (state.accessDenied) {
    $("dailyViewButton")?.classList.add("hidden");
    $("adminViewButton")?.classList.add("hidden");
    $("openSettingsButton")?.classList.add("hidden");
  }
}

function syncCurrentUserDisplay() {
  const userName = $("currentUserName");
  if (!userName) return;
  const employeeId = state.employeeId || "未取得";
  userName.textContent = employeeId;
  $("currentUserDisplay")?.setAttribute(
    "aria-label",
    `ログイン中のユーザー: ${employeeId}`,
  );
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
  bindEvents();
  syncChrome();
  updateViewChrome();
  const initial = await window.pywebview.api.get_initial_state();
  state.employeeId = initial.employee_id || "";
  state.isAdmin = initial.is_admin === true;
  state.accessDenied =
    initial.access_denied === true || initial.employee_registered === false;
  updateViewAvailability();
  syncCurrentUserDisplay();
  fillSettings(initial.settings || {});
  restoreUiState(initial.settings || {});
  if (state.accessDenied) {
    showAccessDenied(initial.access_denied_message);
    return;
  }
  if (!initial.settings_complete) {
    showSettings(true);
    notify({ text: "初回設定を行ってください。", type: "info" });
    return;
  }
  await loadData();
});

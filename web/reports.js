// Daily report and supervisor report screens.
const imeEditorStates = new WeakMap();
const imeDiagnosticState = {
  startedAt: performance.now(),
  nextSequence: 1,
  nextEditorId: 1,
  events: [],
  droppedCount: 0,
  flushTimer: null,
  flushQueue: Promise.resolve(),
};
const IME_DIAGNOSTIC_FLUSH_DELAY_MS = 1500;
const IME_DIAGNOSTIC_BATCH_SIZE = 200;
const IME_DIAGNOSTIC_MAX_BUFFERED_EVENTS = 1000;

function createImeEditorState(textarea) {
  const editorState = {
    editorId: imeDiagnosticState.nextEditorId++,
    compositionId: 0,
    composing: false,
    pendingInput: false,
    hasAppliedInput: false,
    lastAppliedValue: "",
  };
  imeEditorStates.set(textarea, editorState);
  return editorState;
}

function getImeEditorState(textarea) {
  return imeEditorStates.get(textarea) || null;
}

function isImeCompositionActive(textarea, event = null) {
  const editorState = getImeEditorState(textarea);
  return Boolean(
    editorState?.composing || event?.isComposing || event?.keyCode === 229,
  );
}

function getImeDiagnosticKey(event) {
  if (!event) return "";
  if (["Enter", "Escape", "Tab", "Process", "Unidentified"].includes(event.key)) {
    return event.key;
  }
  return event.isComposing || event.keyCode === 229 ? "IME" : "";
}

function queueImeDiagnostic(name, textarea = null, event = null, extra = {}) {
  const editorState = textarea ? getImeEditorState(textarea) : null;
  const selectionStart = Number.isInteger(textarea?.selectionStart)
    ? textarea.selectionStart
    : -1;
  const selectionEnd = Number.isInteger(textarea?.selectionEnd)
    ? textarea.selectionEnd
    : -1;
  const record = {
    sequence: imeDiagnosticState.nextSequence++,
    elapsed_ms: Math.max(
      0,
      Math.round(performance.now() - imeDiagnosticState.startedAt),
    ),
    name,
    editor_id: editorState?.editorId || 0,
    composition_id: editorState?.compositionId || 0,
    editor_kind: textarea?.dataset.kind || "",
    input_type: typeof event?.inputType === "string" ? event.inputType : "",
    key: getImeDiagnosticKey(event),
    reason: extra.reason || "",
    composing: Boolean(editorState?.composing),
    event_composing: Boolean(event?.isComposing),
    focused: Boolean(textarea && document.activeElement === textarea),
    connected: Boolean(textarea?.isConnected),
    deferred: Boolean(extra.deferred),
    default_prevented: Boolean(event?.defaultPrevented),
    value_length: textarea?.value.length || 0,
    data_length: typeof event?.data === "string" ? event.data.length : 0,
    selection_start: selectionStart,
    selection_end: selectionEnd,
  };
  if (Number.isInteger(extra.heightPx)) record.height_px = extra.heightPx;
  if (Number.isInteger(extra.droppedCount)) {
    record.dropped_count = extra.droppedCount;
  }
  if (
    imeDiagnosticState.events.length >= IME_DIAGNOSTIC_MAX_BUFFERED_EVENTS
  ) {
    imeDiagnosticState.events.shift();
    imeDiagnosticState.droppedCount += 1;
  }
  imeDiagnosticState.events.push(record);
  if (name !== "editor_open" && name !== "focus") {
    scheduleImeDiagnosticFlush();
  }
}

function scheduleImeDiagnosticFlush(delay = IME_DIAGNOSTIC_FLUSH_DELAY_MS) {
  if (imeDiagnosticState.flushTimer) {
    clearTimeout(imeDiagnosticState.flushTimer);
  }
  imeDiagnosticState.flushTimer = setTimeout(() => {
    imeDiagnosticState.flushTimer = null;
    flushImeDiagnostics();
  }, delay);
}

function flushImeDiagnostics({ force = false } = {}) {
  if (imeDiagnosticState.flushTimer) {
    clearTimeout(imeDiagnosticState.flushTimer);
    imeDiagnosticState.flushTimer = null;
  }
  const textarea = currentEditingElement?.querySelector("textarea");
  if (!force && textarea && isImeCompositionActive(textarea)) {
    scheduleImeDiagnosticFlush();
    return imeDiagnosticState.flushQueue;
  }

  if (imeDiagnosticState.droppedCount > 0) {
    const droppedCount = imeDiagnosticState.droppedCount;
    imeDiagnosticState.droppedCount = 0;
    queueImeDiagnostic("buffer_dropped", null, null, { droppedCount });
    if (imeDiagnosticState.flushTimer) {
      clearTimeout(imeDiagnosticState.flushTimer);
      imeDiagnosticState.flushTimer = null;
    }
  }
  if (!imeDiagnosticState.events.length) return imeDiagnosticState.flushQueue;

  const recorder = window.pywebview?.api?.record_ime_diagnostics;
  const events = imeDiagnosticState.events.splice(0);
  if (typeof recorder !== "function") return imeDiagnosticState.flushQueue;
  const client = {
    user_agent: String(navigator.userAgent || "").slice(0, 512),
    language: String(navigator.language || "").slice(0, 32),
  };
  imeDiagnosticState.flushQueue = imeDiagnosticState.flushQueue
    .catch(() => undefined)
    .then(async () => {
      for (let index = 0; index < events.length; index += IME_DIAGNOSTIC_BATCH_SIZE) {
        const batch = events.slice(index, index + IME_DIAGNOSTIC_BATCH_SIZE);
        try {
          await recorder({ client, events: batch });
        } catch {
          // Diagnostics must never interfere with editing.
        }
      }
    });
  return imeDiagnosticState.flushQueue;
}

function applyCellEditorInput(textarea, reason, event = null) {
  const editorState = getImeEditorState(textarea);
  if (!editorState) return;
  if (
    !editorState.pendingInput &&
    editorState.hasAppliedInput &&
    editorState.lastAppliedValue === textarea.value
  ) {
    return;
  }
  editorState.pendingInput = false;
  editorState.hasAppliedInput = true;
  editorState.lastAppliedValue = textarea.value;
  const heightPx = autoResizeTextarea(textarea);
  queueImeDiagnostic("input_applied", textarea, event, { reason, heightPx });
  onCellInput({ target: textarea });
}

function installImeProtectedEditor(textarea) {
  const editorState = createImeEditorState(textarea);

  textarea.addEventListener("compositionstart", (event) => {
    editorState.compositionId += 1;
    editorState.composing = true;
    queueImeDiagnostic("composition_start", textarea, event);
  });
  textarea.addEventListener("compositionupdate", (event) => {
    queueImeDiagnostic("composition_update", textarea, event);
  });
  textarea.addEventListener("compositionend", (event) => {
    editorState.composing = false;
    queueImeDiagnostic("composition_end", textarea, event);
    queueMicrotask(() => {
      if (textarea.isConnected && editorState.pendingInput) {
        applyCellEditorInput(textarea, "composition_end", event);
      }
    });
  });
  textarea.addEventListener("beforeinput", (event) => {
    queueImeDiagnostic("before_input", textarea, event, {
      deferred: isImeCompositionActive(textarea, event),
    });
  });
  textarea.addEventListener("input", (event) => {
    if (isImeCompositionActive(textarea, event)) {
      editorState.pendingInput = true;
      queueImeDiagnostic("input_deferred", textarea, event, {
        deferred: true,
      });
      return;
    }
    const wasDeferred = editorState.pendingInput;
    if (
      !wasDeferred &&
      editorState.hasAppliedInput &&
      editorState.lastAppliedValue === textarea.value
    ) {
      return;
    }
    editorState.pendingInput = true;
    applyCellEditorInput(
      textarea,
      wasDeferred ? "composition_end" : "input",
      event,
    );
  });
  textarea.addEventListener("focus", (event) => {
    queueImeDiagnostic("focus", textarea, event);
  });
  textarea.addEventListener("blur", (event) => {
    queueImeDiagnostic("blur", textarea, event);
  });
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
  }

  container.querySelectorAll(".member-switch-button[data-id]").forEach((btn) => {
    const isActive = btn.dataset.id === state.selectedSubordinateId;
    btn.classList.toggle("is-active", isActive);
    btn.setAttribute("aria-pressed", String(isActive));
  });
}

function getDirtyCounts() {
  const reports = state.reportChanges.size;
  const comments = state.commentChanges.size;
  return {
    reports,
    comments,
    total: reports + comments,
  };
}

function syncChrome() {
  const textarea = currentEditingElement?.querySelector("textarea");
  if (textarea) queueImeDiagnostic("chrome_sync", textarea);
  const model = getChromeModel();
  renderActionButtons(model.actions);
  syncNativeUnsavedState(model.dirty.total > 0);
}

function syncNativeUnsavedState(hasUnsavedChanges) {
  if (lastNativeUnsavedState === hasUnsavedChanges) return;
  lastNativeUnsavedState = hasUnsavedChanges;
  const setter = window.pywebview?.api?.set_unsaved_changes;
  if (typeof setter !== "function") return;
  const textarea = currentEditingElement?.querySelector("textarea");
  if (textarea) queueImeDiagnostic("native_unsaved_sync", textarea);
  Promise.resolve(setter(hasUnsavedChanges)).catch(() => {
    lastNativeUnsavedState = null;
  });
}

function syncMissingCommentCount() {
  const button = $("showMissingCommentsButton");
  if (!button) return;
  const summary = getMissingCommentSummary();
  const isLoading = state.busyAction === "load";
  const label = document.createElement("span");
  label.className = "missing-filter-label";
  label.textContent = "未コメントのみ";
  const badge = document.createElement("span");
  badge.className = [
    "missing-count-badge",
    isLoading ? "is-loading" : "",
    !isLoading && summary.hasOverdue ? "is-overdue" : "",
    !isLoading && summary.count === 0 ? "is-empty" : "",
  ]
    .filter(Boolean)
    .join(" ");
  badge.textContent = isLoading ? "…" : `${summary.count}日`;
  badge.setAttribute("aria-hidden", "true");
  button.replaceChildren(label, badge);
  let statusDescription = "未コメントの日報だけを表示、対象0日";
  if (isLoading) {
    statusDescription = "未コメントの日数を確認中";
  } else if (summary.count > 0) {
    const overdueDescription = summary.hasOverdue
      ? "、過去日の未コメントあり"
      : "";
    statusDescription = `未コメントの日報だけを表示、対象${summary.count}日${overdueDescription}`;
  }
  const todayScopeDescription = state.includeTodayInMissingComments
    ? "今日分を含む"
    : "今日分は対象外";
  const rangeDescription =
    summary.rangeStart &&
    summary.rangeEnd &&
    summary.rangeStart <= summary.rangeEnd
      ? `、${formatNavigationDate(summary.rangeStart, true)}から${formatNavigationDate(summary.rangeEnd, true)}までを集計（${todayScopeDescription}）`
      : `、${todayScopeDescription}`;
  const description = `${statusDescription}${rangeDescription}`;
  button.setAttribute("aria-label", description);
  button.title = description;
}

function syncPeriodPresets() {
  const presets = {
    month: $("presetMonthButton"),
    week: $("presetWeekButton"),
    day: $("presetDayButton"),
    default: $("presetDefaultButton"),
  };
  Object.entries(presets).forEach(([name, button]) => {
    if (!button) return;
    const isActive =
      !state.showMissingCommentsOnly && state.activePeriodPreset === name;
    button.disabled = state.isBusy;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  });
  const missingButton = $("showMissingCommentsButton");
  if (missingButton) {
    missingButton.disabled = state.isBusy;
    missingButton.classList.toggle(
      "is-active",
      state.showMissingCommentsOnly,
    );
    missingButton.setAttribute(
      "aria-pressed",
      String(state.showMissingCommentsOnly),
    );
    syncMissingCommentCount();
  }
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
  const signature = JSON.stringify(model);
  if (
    actionButtonSignatures.get(id) === signature &&
    button.disabled === Boolean(model.disabled)
  ) {
    return;
  }
  actionButtonSignatures.set(id, signature);
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
    check: '<path d="m5 12 4 4L19 6" />',
    loader: '<path d="M21 12a9 9 0 0 1-9 9" /><path d="M3 12a9 9 0 0 1 9-9" />',
  };
  return `<svg class="${icon === "loader" ? "is-spinning" : ""}" viewBox="0 0 24 24">${paths[icon] || paths.check}</svg>`;
}

async function refreshData() {
  finishEditing();
  if (!confirmDiscardUnsaved("最新データを取得しますか？")) return;
  discardDirtyEdits();
  await loadData({ preserveDirty: false });
}

function discardDirtyEdits() {
  state.reportChanges.clear();
  state.commentChanges.clear();
  syncChrome();
}

async function loadData({
  silent = false,
  preserveDirty = true,
  preserveTableScroll = false,
} = {}) {
  finishEditing();
  setBusy(true, "load");
  const result = await window.pywebview.api.load_data({
    start_date: state.startDate || null,
    end_date: state.endDate || null,
    period_preset: state.showMissingCommentsOnly
      ? "missing"
      : state.legacyLoadPreset || state.activePeriodPreset || null,
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
  const missingCommentSummary = result.data.missing_comment_summary;
  state.missingCommentDates = Array.isArray(missingCommentSummary?.dates)
    ? missingCommentSummary.dates
    : null;
  state.missingCommentRangeStart = missingCommentSummary?.start_date || "";
  state.missingCommentRangeEnd = missingCommentSummary?.end_date || "";
  state.startDate = result.data.start_date || state.startDate;
  state.endDate = result.data.end_date || state.endDate;
  state.legacyLoadPreset = "";
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
  renderTable({ preserveScroll: preserveTableScroll });
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
  if (state.reportChanges.size === 0 && state.commentChanges.size === 0) return;

  const rowsByKey = new Map(
    state.rows.map((row) => [`${row.employee_id}|${row.date}`, row]),
  );

  for (const [key, change] of state.reportChanges.entries()) {
    const row = rowsByKey.get(key);
    if (!row) continue;

    Object.entries(change.fields).forEach(([field, value]) => {
      row[field] = value;
    });
    for (const [superiorId, reply] of Object.entries(change.replies)) {
      const cell = (row.comments || []).find(
        (candidate) => candidate.superior_employee_id === superiorId,
      );
      if (cell) cell.reply = reply;
    }
  }

  for (const change of state.commentChanges.values()) {
    const row = rowsByKey.get(
      `${change.subordinate_employee_id}|${change.date}`,
    );
    if (!row) continue;

    const cell = (row.comments || []).find(
      (candidate) =>
        candidate.superior_employee_id === change.superior_employee_id,
    );
    if (!cell) continue;

    cell.comment = change.comment;
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
  state.showMissingCommentsOnly = false;
  state.periodBeforeMissing = null;
  state.legacyLoadPreset = "";
  await loadData();
  persistUiState();
}

async function shiftDateRange(direction) {
  finishEditing();
  setFieldError("periodError", "", ["startDate", "endDate"]);
  const startInput = $("startDate");
  const endInput = $("endDate");
  const currentStartDate = startInput.value || state.startDate;
  const currentEndDate = endInput.value || state.endDate;
  if (!currentStartDate || !currentEndDate) return;

  const { startDate, endDate } = getShiftedPeriodRange(
    direction,
    currentStartDate,
    currentEndDate,
  );
  if (!startDate || !endDate) return;

  if (!confirmDiscardUnsaved("表示する日付範囲を移動しますか？")) return;
  discardDirtyEdits();
  startInput.value = startDate;
  endInput.value = endDate;
  state.startDate = startDate;
  state.endDate = endDate;
  state.showMissingCommentsOnly = false;
  state.periodBeforeMissing = null;
  state.legacyLoadPreset = "";
  await loadData();
  persistUiState();
}

function getShiftedPeriodRange(
  direction,
  startDate = state.startDate,
  endDate = state.endDate,
) {
  const step = direction < 0 ? -1 : 1;
  if (!startDate || !endDate) return { startDate: "", endDate: "" };
  if (state.activePeriodPreset === "month") {
    return getCalendarMonthRange(startDate, step);
  }
  const deltaDays = state.activePeriodPreset === "week" ? step * 7 : step;
  return {
    startDate: offsetDateStr(startDate, deltaDays),
    endDate: offsetDateStr(endDate, deltaDays),
  };
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
  if (presetName !== "missing" && !PERIOD_MODES.includes(presetName)) return;
  finishEditing();
  setFieldError("periodError", "", ["startDate", "endDate"]);
  if (!confirmDiscardUnsaved("日付範囲を変更しますか？")) return;
  discardDirtyEdits();

  if (presetName === "missing" && state.showMissingCommentsOnly) {
    const previous = state.periodBeforeMissing || {
      preset: "default",
      startDate: "",
      endDate: "",
    };
    state.activePeriodPreset = previous.preset;
    state.startDate = previous.startDate;
    state.endDate = previous.endDate;
    state.showMissingCommentsOnly = false;
    state.periodBeforeMissing = null;
  } else if (presetName === "missing") {
    state.periodBeforeMissing = {
      preset: state.activePeriodPreset,
      startDate: state.startDate,
      endDate: state.endDate,
    };
    const range = getPresetRange("missing");
    state.startDate = range.startDate;
    state.endDate = range.endDate;
    state.showMissingCommentsOnly = true;
    state.selectedSubordinateId = "";
  } else {
    const range = getPresetRange(presetName);
    state.activePeriodPreset = presetName;
    state.startDate = range.startDate;
    state.endDate = range.endDate;
    state.showMissingCommentsOnly = false;
    state.periodBeforeMissing = null;
  }
  state.legacyLoadPreset = "";
  $("startDate").value = state.startDate;
  $("endDate").value = state.endDate;
  await loadData();
  persistUiState();
}

function getPresetRange(presetName, today = getTodayJST()) {
  if (presetName === "month") {
    return getCalendarMonthRange(today);
  }
  if (presetName === "week") {
    return getMondayBasedWeekRange(today);
  }
  if (presetName === "day") {
    return { startDate: today, endDate: today };
  }
  if (presetName === "previousWorkday") {
    // 休日設定を含む判定はバックエンドで行い、loadData の応答で日付を確定する。
    return { startDate: "", endDate: "" };
  }
  if (presetName === "today") {
    return { startDate: today, endDate: today };
  }
  if (presetName === "previousWeek") {
    return getMondayBasedWeekRange(today, -1);
  }
  if (presetName === "thisWeek") {
    return getMondayBasedWeekRange(today);
  }
  if (presetName === "previousMonth") {
    return getCalendarMonthRange(today, -1);
  }
  if (presetName === "thisMonth") {
    return getCalendarMonthRange(today);
  }
  if (presetName === "missing") {
    const configuredStart =
      state.missingCommentRangeStart || state.missingCommentStartDate;
    const defaultPastDays = Math.max(
      0,
      Number.parseInt($("defaultStartOffsetDays")?.value || "0", 10) || 0,
    );
    const startDate = configuredStart || offsetDateStr(today, -defaultPastDays);
    const endDate =
      state.missingCommentRangeEnd ||
      (state.includeTodayInMissingComments ? today : offsetDateStr(today, -1));
    return {
      startDate: startDate <= endDate ? startDate : endDate,
      endDate,
    };
  }
  return { startDate: "", endDate: "" };
}

function getMondayBasedWeekRange(referenceDate, weekOffset = 0) {
  const reference = new Date(`${referenceDate}T00:00:00Z`);
  const daysFromMonday = (reference.getUTCDay() + 6) % 7;
  const startDate = offsetDateStr(
    referenceDate,
    weekOffset * 7 - daysFromMonday,
  );
  return { startDate, endDate: offsetDateStr(startDate, 6) };
}

function getCalendarMonthRange(referenceDate, monthOffset = 0) {
  const reference = new Date(`${referenceDate}T00:00:00Z`);
  const start = new Date(
    Date.UTC(
      reference.getUTCFullYear(),
      reference.getUTCMonth() + monthOffset,
      1,
    ),
  );
  const nextMonth = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1),
  );
  nextMonth.setUTCDate(0);
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: nextMonth.toISOString().slice(0, 10),
  };
}

function renderTable({ preserveScroll = false } = {}) {
  syncMissingCommentCount();
  const wrap = $("tableWrap");
  const scrollState = preserveScroll ? captureTableScrollState(wrap) : null;
  const rows = getFilteredRows();
  if (!rows.length) {
    wrap.innerHTML = `<div class="empty">${escapeHtml(getEmptyMessage())}</div>`;
    return;
  }

  const context = createTableRenderContext(rows);
  wrap.innerHTML = renderTableShell({
    header: renderTableHeader(context),
    body: renderReportRows(rows, context),
    prevBand: renderDateShiftBand("prev"),
    nextBand: renderDateShiftBand("next"),
    minWidth: getTableContentWidth(context),
  });
  restoreTableScrollState(wrap, scrollState);
  focusPendingReplyEditor();
}

function captureTableScrollState(wrap) {
  const scroll = wrap.querySelector(".table-scroll");
  if (!(scroll instanceof HTMLElement)) return null;

  const viewport = scroll.getBoundingClientRect();
  const header = scroll.querySelector("thead");
  const contentTop = header
    ? header.getBoundingClientRect().bottom
    : viewport.top;
  const anchors = [...scroll.querySelectorAll("tbody tr[data-scroll-key]")]
    .map((row) => {
      const rect = row.getBoundingClientRect();
      return {
        key: row.dataset.scrollKey || "",
        offsetTop: rect.top - contentTop,
        rect,
      };
    })
    .filter(
      ({ key, rect }) =>
        key && rect.bottom > contentTop + 1 && rect.top < viewport.bottom - 1,
    )
    .slice(0, 12)
    .map(({ key, offsetTop }) => ({ key, offsetTop }));

  return {
    scrollTop: scroll.scrollTop,
    scrollLeft: scroll.scrollLeft,
    anchors,
  };
}

function restoreTableScrollState(wrap, scrollState) {
  if (!scrollState) return;
  const scroll = wrap.querySelector(".table-scroll");
  if (!(scroll instanceof HTMLElement)) return;

  scroll.scrollTop = scrollState.scrollTop;
  scroll.scrollLeft = scrollState.scrollLeft;

  for (const anchor of scrollState.anchors) {
    const target = [...scroll.querySelectorAll("tbody tr[data-scroll-key]")].find(
      (row) => row.dataset.scrollKey === anchor.key,
    );
    if (!target) continue;
    const header = scroll.querySelector("thead");
    const contentTop = header
      ? header.getBoundingClientRect().bottom
      : scroll.getBoundingClientRect().top;
    const offsetDelta =
      target.getBoundingClientRect().top - contentTop - anchor.offsetTop;
    scroll.scrollTop += offsetDelta;
    break;
  }
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
  const selfClass = isMe && state.activeView === "boss" ? " self-comment-col" : "";
  return `<th class="comment-col${selfClass}">${escapeHtml(cell.superior_name)}</th>`;
}

function getVisibleComments(comments = []) {
  if (!Array.isArray(comments)) return [];
  if (state.activeView === "boss") return comments;
  return comments.filter((cell) => cell.rank > state.myRank);
}

function buildDateRowMetadata(rows, showUserColumn) {
  // 上司コメント画面では同じ日付のセルを結合し、全員表示では日付ごとに罫線で区切る
  const dateRowSpans = new Map();
  const dateGroupClasses = new Map();

  if (!showUserColumn) {
    return { dateRowSpans, dateGroupClasses };
  }

  let i = 0;
  let groupIndex = 0;
  const showDateGroupDividers = !state.selectedSubordinateId;
  while (i < rows.length) {
    const d = rows[i].date;
    let span = 1;
    while (i + span < rows.length && rows[i + span].date === d) span++;
    dateRowSpans.set(i, span);
    if (showDateGroupDividers && groupIndex > 0) {
      dateGroupClasses.set(i, "boss-date-group-start");
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
  const contentCells = row.__holidayPlaceholder
    ? renderHolidayPlaceholderCells(context)
    : `${renderUserCell(row, context)}
    ${renderReportNameCell(row)}
    ${renderReportDetailCell(row)}
    ${renderCommentCells(row)}`;
  return `<tr class="${renderReportRowClass(row, idx, context)}" data-scroll-key="${escapeHtml(getReportRowKey(row))}">
    ${renderDateCell(row, idx, context)}
    ${contentCells}
  </tr>`;
}

function renderHolidayPlaceholderCells(context) {
  const commentCells = context.sampleComments
    .map(() => '<td class="comment-col holiday-placeholder-cell"></td>')
    .join("");
  return `<td class="user-col holiday-placeholder-cell" aria-label="休日のため日報なし"></td>
    <td class="name-col holiday-placeholder-cell"></td>
    <td class="detail-col holiday-placeholder-cell"></td>
    ${commentCells}`;
}

function renderReportRowClass(row, idx, context) {
  return [
    row.is_holiday ? "holiday" : "",
    row.__holidayPlaceholder ? "holiday-placeholder" : "",
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
    `${formatDisplayDateHTML(row.date)}${renderHolidayLabel(row)}`,
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

function renderDateShiftBand(direction) {
  if (!shouldShowDateShiftBands()) return "";

  const isPrev = direction === "prev";
  const { startDate: targetStartDate, endDate: targetEndDate } =
    getShiftedPeriodRange(isPrev ? -1 : 1);
  if (!targetStartDate || !targetEndDate) return "";

  const className = isPrev
    ? "date-shift-band band-top"
    : "date-shift-band band-bottom";
  const action = isPrev ? "shift-prev" : "shift-next";
  const directionLabel = getDateShiftDirectionLabel(isPrev);
  const targetLabel = formatDateShiftTarget(targetStartDate, targetEndDate);
  const accessibleLabel = `${directionLabel}、${formatNavigationDateRangeDescription(
    targetStartDate,
    targetEndDate,
  )}`;
  const icon = isPrev
    ? renderDateShiftIcon("up")
    : renderDateShiftIcon("down");
  return `<button class="${className}" type="button" data-action="${action}" aria-label="${escapeHtml(accessibleLabel)}" title="${escapeHtml(accessibleLabel)}"><span class="date-shift-label">${icon}<span class="date-shift-text"><span class="date-shift-direction">${escapeHtml(directionLabel)}</span> <span class="date-shift-target">${escapeHtml(targetLabel)}</span><span class="date-shift-action">を表示</span></span></span></button>`;
}

function shouldShowDateShiftBands() {
  return (
    !state.showMissingCommentsOnly && Boolean(state.startDate && state.endDate)
  );
}

function getDateShiftDirectionLabel(isPrevious) {
  if (state.activePeriodPreset === "month") {
    return isPrevious ? "前月" : "翌月";
  }
  if (state.activePeriodPreset === "week") {
    return isPrevious ? "前週" : "翌週";
  }
  if (state.activePeriodPreset === "day") {
    return isPrevious ? "前日" : "翌日";
  }
  return isPrevious ? "前の期間" : "次の期間";
}

function formatDateShiftTarget(startDate, endDate) {
  if (state.activePeriodPreset === "month") {
    const target = new Date(`${startDate}T00:00:00Z`);
    const current = new Date(`${state.startDate}T00:00:00Z`);
    const includeYear = target.getUTCFullYear() !== current.getUTCFullYear();
    const yearLabel = includeYear ? `${target.getUTCFullYear()}年` : "";
    return `${yearLabel}${target.getUTCMonth() + 1}月`;
  }
  const formattedStart = formatNavigationDateWithMonth(startDate);
  if (startDate === endDate) return formattedStart;
  return `${formattedStart}〜${formatNavigationDateWithMonth(endDate)}`;
}

function formatNavigationDateWithMonth(value) {
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return String(value || "");
  const weekdays = ["日", "月", "火", "水", "木", "金", "土"];
  const weekday = weekdays[date.getUTCDay()];
  return `${date.getUTCMonth() + 1}/${date.getUTCDate()}(${weekday})`;
}

function formatNavigationDateRange(startDate, endDate) {
  const formattedStart = formatNavigationDate(startDate, false);
  if (startDate === endDate) return formattedStart;
  return `${formattedStart}〜${formatNavigationDate(endDate, false)}`;
}

function formatNavigationDateRangeDescription(startDate, endDate) {
  const formattedStart = formatNavigationDate(startDate, true);
  if (startDate === endDate) return `${formattedStart}の表示へ移動`;
  return `${formattedStart}から${formatNavigationDate(
    endDate,
    true,
  )}の表示へ移動`;
}

function formatNavigationDate(value, includeYearAndMonth) {
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return String(value || "");
  const weekdays = ["日", "月", "火", "水", "木", "金", "土"];
  const weekday = weekdays[date.getUTCDay()];
  const dayAndWeekday = `${date.getUTCDate()}(${weekday})`;
  if (!includeYearAndMonth) return dayAndWeekday;
  return `${date.getUTCFullYear()}年${date.getUTCMonth() + 1}月${date.getUTCDate()}日（${weekday}）`;
}

function renderDateShiftIcon(direction) {
  const isUp = direction === "up";
  const chevron = isUp ? "M8 13l4-4 4 4" : "M8 11l4 4 4-4";
  const lineY = isUp ? "6" : "18";
  return `<svg class="date-shift-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 ${lineY}h12" /><path d="${chevron}" /></svg>`;
}

function focusPendingReplyEditor() {
  if (!state.pendingReplyFocusKey) return;
  const replyKey = state.pendingReplyFocusKey;
  const target = Array.from(
    document.querySelectorAll(
      ".editable-content.reply-content[data-reply-key]",
    ),
  ).find((element) => element.dataset.replyKey === replyKey);
  state.pendingReplyFocusKey = "";
  if (target instanceof HTMLElement) {
    startEditingTarget(target, { preventScroll: true });
  }
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
  const canAddBossComment = canEditComment && rowCanReceiveBossComment(row);
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
    canAddBossComment,
    hasBossComment,
    hasReply,
    canEditReply,
    replyKey: getReplyKey(row, cell),
  };
}

function renderBossCommentCell(context) {
  const dirtyClass = isBossCommentDirty(context.row, context.cell)
    ? " is-dirty-cell"
    : "";
  return `<td class="comment-col${dirtyClass}"><div class="comment-stack">${renderBossCommentActions(context)}${renderBossCommentDisplay(context)}${renderBossReplyPreview(context)}</div></td>`;
}

function renderBossCommentActions(context) {
  if (!context.canAddBossComment) return "";

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
    dataAttributes: { "reply-key": context.replyKey },
  });
}

function getReportRowKey(row) {
  return `${row.employee_id}|${row.date}`;
}

function getOrCreateReportChange(row) {
  const key = getReportRowKey(row);
  let change = state.reportChanges.get(key);
  if (!change) {
    change = { date: row.date, fields: {}, replies: {} };
    state.reportChanges.set(key, change);
  }
  return change;
}

function recordReportFieldChange(row, field, value) {
  row[field] = value;
  getOrCreateReportChange(row).fields[field] = value;
}

function recordReplyChange(row, cell, value) {
  cell.reply = value;
  getOrCreateReportChange(row).replies[cell.superior_employee_id] = value;
}

function recordCommentChange(row, cell, value) {
  cell.comment = value;
  state.commentChanges.set(getReplyKey(row, cell), {
    subordinate_employee_id: row.employee_id,
    superior_employee_id: cell.superior_employee_id,
    date: row.date,
    comment: value,
  });
}

function isReportFieldDirty(row, field) {
  const change = state.reportChanges.get(getReportRowKey(row));
  return Boolean(
    change && Object.prototype.hasOwnProperty.call(change.fields, field),
  );
}

function isReplyDirty(row, cell) {
  const change = state.reportChanges.get(getReportRowKey(row));
  return Boolean(
    change &&
      Object.prototype.hasOwnProperty.call(
        change.replies,
        cell.superior_employee_id,
      ),
  );
}

function isBossCommentDirty(row, cell) {
  return state.commentChanges.has(getReplyKey(row, cell));
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
  dataAttributes = {},
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
  const serializedDataAttributes = Object.entries(dataAttributes)
    .map(([name, attributeValue]) => {
      if (!/^[a-z][a-z0-9-]*$/.test(name)) return "";
      return ` data-${name}="${escapeHtml(attributeValue)}"`;
    })
    .join("");
  return `<div class="${classes}" data-kind="${kind}" data-type="${type}" data-row="${rowIndex}" data-field="${field}" data-comment="${commentIndex}" data-editable="${editable ? "true" : "false"}"${accessibilityAttributes}${serializedDataAttributes}>${escapeHtml(display)}</div>`;
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
  const shiftPrev = event.target.closest('[data-action="shift-prev"]');
  if (shiftPrev) {
    shiftDateRange(-1);
    return;
  }
  const shiftNext = event.target.closest('[data-action="shift-next"]');
  if (shiftNext) {
    shiftDateRange(1);
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
  renderTable({ preserveScroll: true });
}

function openBossCommentEditor(button) {
  const { target } = getBossCommentTarget(button);
  if (!target) return;

  const actions = button.closest(".boss-comment-actions");
  if (actions) actions.classList.add("hidden");

  target.classList.remove("hidden");
  startEditingTarget(target, { preventScroll: true });
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
  recordCommentChange(row, cell, signature);

  syncChrome();
  renderTable({ preserveScroll: true });
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

function beginCellEditing(event) {
  const target = getEditableTargetFromEvent(event);
  if (!(target instanceof HTMLElement)) return;
  startEditingTarget(target, { preventScroll: true });
}

function getEditableTargetFromEvent(event) {
  const directTarget = event.target.closest(".editable-content");
  if (directTarget instanceof HTMLElement) return directTarget;

  const cell = event.target.closest("td.name-col, td.detail-col");
  if (!(cell instanceof HTMLElement)) return null;

  const cellTarget = cell.querySelector(":scope > .editable-content");
  return cellTarget instanceof HTMLElement ? cellTarget : null;
}

function startEditingTarget(target, { preventScroll = false } = {}) {
  if (target.dataset.editable !== "true") return;
  if (target === currentEditingElement) return;

  finishEditing();
  currentEditingElement = target;
  currentEditingElement.classList.add("is-editing");

  const textarea = document.createElement("textarea");
  textarea.rows = 1;
  textarea.value = target.textContent;
  textarea.className = "editing-textarea";
  const pureHeight = getEditingBaseHeight(target);
  textarea.dataset.baseHeight = String(pureHeight);
  copyDataset(target, textarea);
  installImeProtectedEditor(textarea);
  textarea.addEventListener("click", (innerEvent) =>
    innerEvent.stopPropagation(),
  );
  textarea.addEventListener("keydown", (keyEvent) => {
    if (isImeCompositionActive(textarea, keyEvent)) {
      queueImeDiagnostic("keydown_ignored", textarea, keyEvent, {
        deferred: true,
      });
      return;
    }
    if (keyEvent.key === "Escape") {
      keyEvent.preventDefault();
      queueImeDiagnostic("keydown_handled", textarea, keyEvent, {
        reason: "escape",
      });
      finishEditing();
      return;
    }
    if (keyEvent.key === "Tab") {
      keyEvent.preventDefault();
      queueImeDiagnostic("keydown_handled", textarea, keyEvent, {
        reason: "tab",
      });
      moveEditingFocus(keyEvent.shiftKey ? -1 : 1, "horizontal");
      return;
    }
    if (keyEvent.key === "Enter" && !(keyEvent.ctrlKey || keyEvent.metaKey)) {
      keyEvent.preventDefault();
      queueImeDiagnostic("keydown_handled", textarea, keyEvent, {
        reason: "enter",
      });
      moveEditingFocus(1, "enter");
    }
  });

  target.innerHTML = "";
  target.appendChild(textarea);
  const initialHeight = autoResizeTextarea(textarea);
  queueImeDiagnostic("editor_open", textarea, null, {
    reason: "initial",
    heightPx: initialHeight,
  });
  textarea.focus({ preventScroll });
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
}

function moveEditingFocus(direction, axis) {
  if (!currentEditingElement?.querySelector("textarea")) return;
  const nextTarget =
    axis === "enter"
      ? findEnterEditableTarget()
      : findHorizontalEditableTarget(direction);
  finishEditing();
  if (nextTarget instanceof HTMLElement) {
    startEditingTarget(nextTarget);
  }
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

function findHorizontalEditableTarget(direction) {
  const editables = getVisibleEditableTargets();
  const current = currentEditingElement;
  const index = editables.indexOf(current);
  if (index < 0) return null;
  return editables[index + direction] || null;
}

function getVisibleEditableTargets() {
  return Array.from(
    document.querySelectorAll('#tableWrap .editable-content[data-editable="true"]'),
  ).filter((element) => element instanceof HTMLElement && element.offsetParent);
}

function autoResizeTextarea(textarea) {
  const baseHeight = Number(textarea.dataset.baseHeight || "40") || 40;
  textarea.style.height = "auto";
  const height = Math.max(textarea.scrollHeight, baseHeight);
  textarea.style.height = `${height}px`;
  return Math.round(height);
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
    const editorState = getImeEditorState(textarea);
    const wasComposing = Boolean(editorState?.composing);
    if (editorState && (editorState.pendingInput || wasComposing)) {
      editorState.composing = false;
      editorState.pendingInput = true;
      applyCellEditorInput(textarea, "finish");
    }
    queueImeDiagnostic("editor_finish", textarea, null, {
      reason: "finish",
      deferred: wasComposing,
    });
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
  scheduleImeDiagnosticFlush();
}

function rowHasReportData(row) {
  return Boolean(
    normalizeCellValue(row.business_name) ||
      normalizeCellValue(row.business_detail),
  );
}

function rowCanReceiveBossComment(row) {
  if (!row) return false;
  if (row.date > getTodayJST()) return false;
  return !row.is_holiday || rowHasReportData(row);
}

function rowNeedsBossComment(row) {
  if (!row || row.employee_id === state.employeeId) return false;
  if (!rowCanReceiveBossComment(row)) return false;
  if (
    row.date === getTodayJST() &&
    !state.includeTodayInMissingComments
  ) {
    return false;
  }
  const missingStartDate =
    state.missingCommentRangeStart || state.missingCommentStartDate;
  if (missingStartDate && row.date < missingStartDate) {
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
  const today = getTodayJST();
  const rangeEnd =
    state.missingCommentRangeEnd ||
    (state.includeTodayInMissingComments ? today : offsetDateStr(today, -1));
  const emptySummary = {
    count: 0,
    hasOverdue: false,
    dates: [],
    rangeStart: state.missingCommentRangeStart || "",
    rangeEnd,
  };
  if (!state.isSuperior) return emptySummary;

  const rangeStart =
    state.missingCommentRangeStart || state.missingCommentStartDate || "";
  const sourceDates = Array.isArray(state.missingCommentDates)
    ? state.missingCommentDates
    : state.rows.filter(rowNeedsBossComment).map((row) => row.date);
  const dates = [
    ...new Set(
      sourceDates.filter(
        (date) =>
          date &&
          date <= rangeEnd &&
          (!rangeStart || date >= rangeStart),
      ),
    ),
  ].sort();
  return {
    count: dates.length,
    hasOverdue: dates.some((date) => date < today),
    dates,
    rangeStart,
    rangeEnd,
  };
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

  if (state.activeView === "boss" && state.isSuperior) {
    const selectedId = state.selectedSubordinateId;
    const bossRows = filteredByDate.filter((row) => {
      if (row.employee_id === state.employeeId) return false;
      if (selectedId && row.employee_id !== selectedId) {
        return false;
      }
      return true;
    });
    if (state.showMissingCommentsOnly) {
      return bossRows.filter(rowNeedsBossComment);
    }
    return collapseEmptyHolidayRows(bossRows);
  }

  return filteredByDate.filter(
    (row) => row.employee_id === state.employeeId,
  );
}

function collapseEmptyHolidayRows(rows) {
  const holidayDatesWithReports = new Set(
    rows
      .filter((row) => row.is_holiday && rowHasReportData(row))
      .map((row) => row.date),
  );
  const placeholderDates = new Set();

  return rows.flatMap((row) => {
    if (!row.is_holiday) return [row];
    if (rowHasReportData(row)) return [row];
    if (
      holidayDatesWithReports.has(row.date) ||
      placeholderDates.has(row.date)
    ) {
      return [];
    }
    placeholderDates.add(row.date);
    return [{ ...row, __holidayPlaceholder: true }];
  });
}

function getEmptyMessage() {
  if (state.activeView === "boss" && state.isSuperior) {
    if (state.showMissingCommentsOnly) {
      return "未コメントの日報はありません。";
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
    recordReportFieldChange(row, target.dataset.field, normalizedValue);
    markReportFieldDirtyUi(target.dataset.row, target.dataset.field);
  }
  if (target.dataset.kind === "reply") {
    const cell = row.comments[Number(target.dataset.comment)];
    recordReplyChange(row, cell, normalizedValue);
    markCurrentEditingDirtyUi();
  }
  if (target.dataset.kind === "comment") {
    const cell = row.comments[Number(target.dataset.comment)];
    recordCommentChange(row, cell, normalizedValue);
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
  if (currentEditingElement?.dataset.kind === "comment") {
    currentEditingElement.closest("td")?.classList.add("is-dirty-cell");
  }
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

  const targets = [
    { label: `日報${userCount}件`, count: userCount, status: result.result?.user },
    {
      label: `コメント${commentCount}件`,
      count: commentCount,
      status: result.result?.comment,
    },
  ].filter((target) => target.count > 0);
  const saved = targets.filter((target) => target.status?.saved);
  const failed = targets.filter((target) => !target.status?.saved);
  const messages = [];
  if (saved.length) {
    messages.push(`${saved.map((target) => target.label).join(" / ")}は保存しました。`);
  }
  messages.push(
    failed.length
      ? `${failed.map((target) => target.label).join(" / ")}の保存に失敗しました。`
      : "保存に失敗しました。",
  );
  const details = [
    ...new Set(failed.map((target) => target.status?.error).filter(Boolean)),
  ];
  if (details.length) {
    messages.push(`詳細: ${details.join(" / ")}`);
  } else if (result.message) {
    messages.push(result.message);
  } else {
    messages.push("ネットワーク接続を確認して、もう一度保存してください。");
  }
  return messages.join(" ");
}

async function saveUpdates() {
  finishEditing();
  if (state.isBusy || getDirtyCounts().total === 0) {
    syncChrome();
    return;
  }
  const userUpdates = Array.from(state.reportChanges.values()).map((change) => {
    const update = { date: change.date, ...change.fields };
    const replies = Object.entries(change.replies).map(
      ([superiorEmployeeId, reply]) => ({
        superior_employee_id: superiorEmployeeId,
        reply,
      }),
    );
    if (replies.length) update.replies = replies;
    return update;
  });
  const commentUpdates = Array.from(state.commentChanges.values()).map(
    ({ subordinate_employee_id, date, comment }) => ({
      subordinate_employee_id,
      date,
      comment,
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
  const userSaved = Boolean(result.result?.user?.saved);
  const commentSaved = Boolean(result.result?.comment?.saved);
  if (userSaved) {
    state.reportChanges.clear();
  }
  if (commentSaved) {
    state.commentChanges.clear();
  }
  if (userSaved || commentSaved) {
    syncChrome();
    await loadData({ silent: true, preserveTableScroll: true });
  } else {
    syncChrome();
  }
  notify({
    text: buildSaveResultMessage(
      result,
      userUpdates.length,
      commentUpdates.length,
    ),
    type: result.ok ? "success" : result.no_targets ? "info" : "error",
  });
}

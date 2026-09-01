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

const TABLE_COLUMN_WIDTH_PROFILES = Object.freeze({
  compact: { user: 112, date: 116, name: 170, detail: 300, comment: 230 },
  standard: { user: 128, date: 120, name: 190, detail: 350, comment: 260 },
  medium: { user: 136, date: 124, name: 205, detail: 390, comment: 280 },
  large: { user: 144, date: 128, name: 220, detail: 420, comment: 300 },
  xlarge: { user: 160, date: 136, name: 240, detail: 460, comment: 330 },
});
const TABLE_COLUMN_MIN_WIDTH_PROFILES = Object.freeze({
  compact: { user: 88, date: 116, name: 112, detail: 160, comment: 145 },
  standard: { user: 96, date: 120, name: 120, detail: 180, comment: 155 },
  medium: { user: 104, date: 124, name: 130, detail: 195, comment: 165 },
  large: { user: 112, date: 128, name: 140, detail: 210, comment: 175 },
  xlarge: { user: 124, date: 136, name: 160, detail: 235, comment: 195 },
});
const TABLE_COLUMN_MAX_WIDTHS = Object.freeze({
  user: 360,
  date: 220,
  name: 520,
  detail: 720,
  comment: 620,
});
const TABLE_FONT_SIZES = Object.freeze([
  "compact",
  "standard",
  "medium",
  "large",
  "xlarge",
]);
let tableColumnResizeState = null;
let editingSnapshot = null;
let periodPresetIndicatorWasVisible = false;

function getTableColumnKind(columnId) {
  if (["user", "date", "name", "detail"].includes(columnId)) return columnId;
  return String(columnId || "").startsWith("comment:") ? "comment" : "";
}

function clampTableColumnWidth(columnKind, width, fontSize = state.fontSize) {
  const size = TABLE_COLUMN_WIDTH_PROFILES[fontSize] ? fontSize : "large";
  const minimum = TABLE_COLUMN_MIN_WIDTH_PROFILES[size][columnKind];
  const maximum = TABLE_COLUMN_MAX_WIDTHS[columnKind];
  return Math.round(Math.min(maximum, Math.max(minimum, Number(width))));
}

function normalizeColumnWidthProfile(profile, fontSize = state.fontSize) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) return {};
  const size = TABLE_COLUMN_WIDTH_PROFILES[fontSize] ? fontSize : "large";
  const normalized = {};
  Object.entries(profile).forEach(([columnId, width]) => {
    const columnKind = getTableColumnKind(columnId);
    if (!columnKind || !Number.isFinite(Number(width))) return;
    normalized[columnId] = clampTableColumnWidth(columnKind, width, size);
  });
  return normalized;
}

function parseStoredColumnWidths(rawValue, fontSize = state.fontSize) {
  let parsed = rawValue;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed || "{}");
    } catch {
      return {};
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

  const size = TABLE_COLUMN_WIDTH_PROFILES[fontSize] ? fontSize : "large";
  const sharedProfile = normalizeColumnWidthProfile(parsed, size);
  if (Object.keys(sharedProfile).length) return sharedProfile;

  // Migrate the former per-font-size format to one shared profile. Prefer the
  // profile matching the restored font size so the current appearance is kept.
  const legacyProfileOrder = [size, ...TABLE_FONT_SIZES].filter(
    (candidate, index, values) => values.indexOf(candidate) === index,
  );
  for (const legacySize of legacyProfileOrder) {
    const migratedProfile = normalizeColumnWidthProfile(parsed[legacySize], size);
    if (Object.keys(migratedProfile).length) return migratedProfile;
  }
  return {};
}

function getTableColumnWidth(columnId, columnKind, fontSize = state.fontSize) {
  const size = TABLE_COLUMN_WIDTH_PROFILES[fontSize] ? fontSize : "large";
  const storedWidth = state.columnWidths?.[columnId];
  const width = Number.isFinite(Number(storedWidth))
    ? Number(storedWidth)
    : TABLE_COLUMN_WIDTH_PROFILES[size][columnKind];
  return clampTableColumnWidth(columnKind, width, size);
}

function setTableColumnWidth(columnId, columnKind, width) {
  const fontSize = TABLE_COLUMN_WIDTH_PROFILES[state.fontSize]
    ? state.fontSize
    : "large";
  const normalizedWidth = clampTableColumnWidth(columnKind, width, fontSize);
  state.columnWidths = {
    ...(state.columnWidths || {}),
    [columnId]: normalizedWidth,
  };
  return normalizedWidth;
}

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

function isMemberFilterLevelEnabled(level) {
  return Array.isArray(state.memberFilterLevels) &&
    state.memberFilterLevels.includes(level);
}

function memberMatchesTeamEntry(member, teamEntry) {
  return Array.isArray(member?.team_path) &&
    member.team_path.some((team) => team?.team_id === teamEntry?.team_id);
}

function getAvailableTeamFilterScopes() {
  if (state.restrictToSelf) return [];
  const members = Array.isArray(state.viewableMembers)
    ? state.viewableMembers
    : [];
  const scopes = [];
  const seenTeamIds = new Set();
  ["department", "section"].forEach((level) => {
    if (!isMemberFilterLevelEnabled(level)) return;
    members.forEach((member) => {
      (Array.isArray(member?.team_path) ? member.team_path : []).forEach((team) => {
        const teamLevel = team?.team_type || team?.team_level;
        const teamId = String(team?.team_id || "");
        if (teamLevel !== level || !teamId || seenTeamIds.has(teamId)) return;
        seenTeamIds.add(teamId);
        const memberCount = members.filter(
          (candidate) =>
            candidate.employee_id !== state.employeeId &&
            memberMatchesTeamEntry(candidate, team),
        ).length;
        if (memberCount > 0) {
          scopes.push({
            level,
            scope: `team:${teamId}`,
            team,
            memberCount,
          });
        }
      });
    });
  });
  return scopes;
}

function isAvailableMemberScope(scope) {
  if (state.restrictToSelf) {
    return scope === "self" && state.canInputOwnReport;
  }
  if (scope === "self") {
    return state.canInputOwnReport;
  }
  if (scope === "member") return isMemberFilterLevelEnabled("member");
  if (scope?.startsWith("team:")) {
    return getAvailableTeamFilterScopes().some((item) => item.scope === scope);
  }
  return ["all", "team", "subordinates"].includes(scope);
}

function clearSubordinateFilters() {
  state.memberScope = getDefaultMemberScope();
  state.selectedSubordinateId = "";
  updateSubordinateFilterUi();
  renderTable();
}

function getDefaultMemberScope() {
  if (state.restrictToSelf) return "self";
  if (hasCommentTargetMembers()) return "all";
  if (state.canInputOwnReport) return "self";
  return getAvailableTeamFilterScopes()[0]?.scope || "all";
}

function hasCommentTargetMembers() {
  return state.viewableMembers.some((member) =>
    Array.isArray(member.relations) &&
    member.relations.includes("assigned_subordinate"),
  );
}

function setMemberScope(scope) {
  if (
    !["all", "self", "team", "subordinates"].includes(scope) &&
    !scope?.startsWith("team:")
  ) return;
  if (!isAvailableMemberScope(scope)) return;
  state.memberScope =
    scope === "all" && !hasCommentTargetMembers() && state.canInputOwnReport
      ? getDefaultMemberScope()
      : scope;
  state.selectedSubordinateId = "";
  updateSubordinateFilterUi();
  renderTable();
}

function toggleSubordinateFilter(employeeId) {
  if (
    state.restrictToSelf ||
    !employeeId ||
    !isMemberFilterLevelEnabled("member")
  ) return;
  const wasSelected = state.selectedSubordinateId === employeeId;
  state.selectedSubordinateId = wasSelected ? "" : employeeId;
  state.memberScope = wasSelected ? "all" : "member";
  updateSubordinateFilterUi();
  renderTable();
}

function updateSubordinateFilterUi() {
  const container = $("bossSearchControl");
  if (!container) return;

  container.querySelectorAll("[data-member-scope]").forEach((button) => {
    const isActive =
      !state.selectedSubordinateId && button.dataset.memberScope === state.memberScope;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  });
  container.querySelectorAll(".member-switch-button[data-id]").forEach((btn) => {
    const isActive =
      state.memberScope === "member" && btn.dataset.id === state.selectedSubordinateId;
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
  syncNativeUnsavedState(hasUnsavedChanges());
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
  const controlsBusy = state.isBusy && state.busyAction !== "save";
  button.disabled = controlsBusy || summary.count === 0;
  let label = button.querySelector(":scope > .missing-filter-label");
  let badge = button.querySelector(":scope > .missing-count-badge");
  if (!label) {
    label = document.createElement("span");
    label.className = "missing-filter-label";
    label.textContent = "未確認のみ";
    button.appendChild(label);
  }
  if (!badge) {
    badge = document.createElement("span");
    badge.className = "missing-count-badge";
    badge.setAttribute("aria-hidden", "true");
    button.appendChild(badge);
  }
  badge.className = [
    "missing-count-badge",
    isLoading ? "is-loading" : "",
    !isLoading && summary.hasOverdue ? "is-overdue" : "",
    !isLoading && summary.count === 0 ? "is-empty" : "",
  ]
    .filter(Boolean)
    .join(" ");
  badge.textContent = isLoading ? "…" : `${summary.count}日`;
  const isDirectorSummary =
    state.isDirector && state.missingCommentMode === "weekly_director";
  let statusDescription = isDirectorSummary
    ? "部長コメントの未確認対象はありません。最長経過0日"
    : "未確認の日報はありません。対象0日";
  if (isLoading) {
    statusDescription = "未確認の日数を確認中";
  } else if (summary.count > 0) {
    if (isDirectorSummary) {
      statusDescription = `部長コメントが未確認の対象者だけを表示、最長経過${summary.count}稼働日`;
    } else {
      const overdueDescription = summary.hasOverdue
        ? "、過去日の未確認あり"
        : "";
      statusDescription = `未確認の日報だけを表示、対象${summary.count}日${overdueDescription}`;
    }
  }
  const todayScopeDescription = isDirectorSummary
    ? "今日までの稼働日を集計"
    : state.includeTodayInMissingComments
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
  button.removeAttribute("title");
}

function exitMissingCommentsFilter() {
  if (!state.showMissingCommentsOnly) return false;
  const previous = state.periodBeforeMissing || {
    preset: "default",
    startDate: "",
    endDate: "",
  };
  state.activePeriodPreset = previous.preset || "default";
  state.startDate = previous.startDate || state.startDate;
  state.endDate = previous.endDate || state.endDate;
  state.showMissingCommentsOnly = false;
  state.periodBeforeMissing = null;
  const startInput = $("startDate");
  const endInput = $("endDate");
  if (startInput) startInput.value = state.startDate;
  if (endInput) endInput.value = state.endDate;
  syncReportDateDisplays();
  syncPeriodPresets();
  return true;
}

function syncReportDateDisplays() {
  syncReportDatePicker();
}

function getPeriodPresetOptions() {
  return [
    ...document.querySelectorAll('.period-presets [role="radio"]'),
  ];
}

function updatePeriodPresetIndicator(options = {}) {
  const group = document.querySelector(".period-presets");
  const indicator = group?.querySelector(".period-presets-indicator");
  const immediate = options?.immediate === true;
  if (!group || !indicator) return;

  // The report panel is display:none while the user is in administration or
  // settings. Measuring the controls in that state yields offsetLeft=0, which
  // would make the indicator animate from the first button when the panel is
  // shown again. Keep the last valid position until the controls are visible.
  if (!group.getClientRects().length) {
    periodPresetIndicatorWasVisible = false;
    return;
  }

  const becameVisible = !periodPresetIndicatorWasVisible;
  periodPresetIndicatorWasVisible = true;
  const selected = getPeriodPresetOptions().find(
    (option) => option.getAttribute("aria-checked") === "true",
  );
  if (!selected) {
    if (immediate || becameVisible) {
      const previousTransition = indicator.style.transition;
      indicator.style.transition = "none";
      indicator.style.opacity = "0";
      void indicator.offsetWidth;
      indicator.style.transition = previousTransition;
    } else {
      indicator.style.opacity = "0";
    }
    return;
  }

  const applyPosition = () => {
    indicator.style.removeProperty("opacity");
    indicator.style.width = `${selected.offsetWidth}px`;
    indicator.style.transform = `translate3d(${selected.offsetLeft}px, 0, 0)`;
  };
  if (!immediate && !becameVisible) {
    applyPosition();
    return;
  }

  // Initial restoration and the first frame after returning from a hidden
  // view are placement, not user interaction. Apply them without a motion
  // transition, then restore the normal transition for subsequent changes.
  const previousTransition = indicator.style.transition;
  indicator.style.transition = "none";
  applyPosition();
  void indicator.offsetWidth;
  indicator.style.transition = previousTransition;
}

function updatePeriodPresetRovingTabindex(focusedIndex) {
  getPeriodPresetOptions().forEach((option, index) => {
    option.tabIndex = index === focusedIndex ? 0 : -1;
  });
}

function initializePeriodPresetControl() {
  const group = document.querySelector(".period-presets");
  if (!group || group.dataset.initialized === "true") return;
  group.dataset.initialized = "true";
  const options = getPeriodPresetOptions();
  options.forEach((option, index) => {
    option.addEventListener("click", () => {
      applyPreset(option.dataset.periodMode);
    });
    option.addEventListener("keydown", (event) => {
      const optionCount = options.length;
      let nextIndex = -1;
      if (event.key === "ArrowRight") nextIndex = (index + 1) % optionCount;
      if (event.key === "ArrowLeft") {
        nextIndex = (index - 1 + optionCount) % optionCount;
      }
      if (event.key === "Home") nextIndex = 0;
      if (event.key === "End") nextIndex = optionCount - 1;
      if (nextIndex >= 0) {
        event.preventDefault();
        movePeriodPresetFocus(nextIndex);
      } else if (event.key === " " || event.key === "Enter") {
        event.preventDefault();
        applyPreset(option.dataset.periodMode);
      }
    });
  });
  window.addEventListener("resize", () => updatePeriodPresetIndicator(), {
    passive: true,
  });
  if ("ResizeObserver" in window) {
    new ResizeObserver(() => updatePeriodPresetIndicator()).observe(group);
  }
  syncPeriodPresets({ immediate: true });
  requestAnimationFrame(() => updatePeriodPresetIndicator({ immediate: true }));
}

function movePeriodPresetFocus(index) {
  const options = getPeriodPresetOptions();
  if (!options.length) return;
  const step = index >= options.length ? 1 : -1;
  let next = index;
  for (let count = 0; count < options.length; count += 1) {
    const option = options[next];
    if (option && !option.hasAttribute("data-disabled") && !option.disabled) {
      updatePeriodPresetRovingTabindex(next);
      option.focus({ preventScroll: true });
      return;
    }
    next = (next + step + options.length) % options.length;
  }
}

function syncPeriodPresets(config = {}) {
  const controlsBusy = state.isBusy && state.busyAction !== "save";
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
    button.disabled = controlsBusy;
    button.classList.toggle("is-active", isActive);
    button.dataset.state = isActive ? "on" : "off";
    button.setAttribute("aria-checked", String(isActive));
    button.setAttribute("aria-pressed", String(isActive));
  });
  const options = getPeriodPresetOptions();
  const activeIndex = options.findIndex(
    (option) => option.getAttribute("aria-checked") === "true",
  );
  const fallbackIndex = options.findIndex(
    (option) => option.dataset.periodMode === state.activePeriodPreset,
  );
  updatePeriodPresetRovingTabindex(
    activeIndex >= 0 ? activeIndex : fallbackIndex >= 0 ? fallbackIndex : options.length - 1,
  );
  updatePeriodPresetIndicator(config);
  const missingButton = $("showMissingCommentsButton");
  if (missingButton) {
    missingButton.disabled = controlsBusy;
    missingButton.classList.toggle(
      "is-active",
      state.showMissingCommentsOnly,
    );
    missingButton.setAttribute(
      "aria-pressed",
      String(state.showMissingCommentsOnly),
    );
  }
  syncMissingCommentCount();
  syncPeriodShiftButtons();
}

function syncPeriodShiftButtons() {
  const controlsBusy = state.isBusy && state.busyAction !== "save";
  const stepLabel = $("periodShiftStepLabel");
  if (stepLabel) stepLabel.textContent = getPeriodShiftStepLabel();
  const navigation = document.querySelector("#reportPanel .period-navigation");
  if (navigation instanceof HTMLElement) {
    navigation.classList.toggle(
      "is-missing-range",
      state.showMissingCommentsOnly,
    );
    navigation.setAttribute(
      "aria-label",
      state.showMissingCommentsOnly
        ? `${getPeriodShiftStepLabel()}。期間移動は利用できません`
        : "表示期間を移動",
    );
  }
  [
    ["periodPrevButton", -1],
    ["periodNextButton", 1],
  ].forEach(([buttonId, direction]) => {
    const button = $(buttonId);
    if (!button) return;
    const isPrevious = direction < 0;
    const label = getDateShiftDirectionLabel(isPrevious);
    const labelElement = button.querySelector(".period-shift-label");
    if (labelElement) labelElement.textContent = label;
    const target = getShiftedPeriodRange(direction);
    const hasTarget = Boolean(target.startDate && target.endDate);
    const description = hasTarget
      ? `${label}、${formatNavigationDateRangeDescription(target.startDate, target.endDate)}`
      : `${label}へ移動`;
    button.disabled =
      controlsBusy || state.showMissingCommentsOnly || !hasTarget;
    button.setAttribute("aria-label", description);
    button.removeAttribute("title");
  });
}

function getPeriodShiftStepLabel() {
  if (state.showMissingCommentsOnly) {
    return "未確認のみ表示中";
  }
  if (state.activePeriodPreset === "month") return "1か月";
  if (state.activePeriodPreset === "week") return "1週間";
  return "1日";
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
      ariaLabel: "最新データを取得中",
    };
  }

  return {
    disabled: state.isBusy && state.busyAction !== "save",
    icon: "refresh",
    label: "最新データを取得",
    ariaLabel: "最新データを取得",
  };
}

function getSaveButtonModel(dirty) {
  if (state.busyAction === "save") {
    return {
      disabled: true,
      label: "保存",
      hasPendingChanges: dirty.total > 0,
      ariaLabel: dirty.total > 0 ? `保存 未保存${dirty.total}件` : "保存",
    };
  }

  return {
    disabled: state.isBusy || dirty.total === 0,
    label: "保存",
    hasPendingChanges: dirty.total > 0,
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

  const children = [];
  if (id === "refreshButton") {
    const icon = document.createElement("span");
    icon.className = "toolbar-button-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = renderToolbarIcon(model.icon);
    children.push(icon);
  } else {
    const label = document.createElement("span");
    label.className = "toolbar-button-label";
    label.textContent = model.label;
    children.push(label);
    if (model.hasPendingChanges) {
      const indicator = document.createElement("span");
      indicator.className = "save-pending-indicator";
      indicator.setAttribute("aria-hidden", "true");
      children.push(indicator);
    }
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
    refresh:
      '<path fill="currentColor" fill-rule="evenodd" d="M4.5 2.5a1 1 0 0 1 1 1v1.572A9.5 9.5 0 1 1 12 21.5c-4.87 0-8.882-3.663-9.435-8.384a1 1 0 0 1 1.986-.232A7.501 7.501 0 0 0 19.5 12 7.5 7.5 0 0 0 6.41 7H9a1 1 0 0 1 0 2H4.5a1 1 0 0 1-1-1.024V3.5a1 1 0 0 1 1-1Z" clip-rule="evenodd" />',
    check: '<path d="m5 12 4 4L19 6" />',
    loader: '<path d="M21 12a9 9 0 0 1-9 9" /><path d="M3 12a9 9 0 0 1 9-9" />',
  };
  const className =
    icon === "loader"
      ? "is-spinning is-loader-icon"
      : icon === "refresh"
        ? "is-refresh-icon"
        : "";
  return `<svg class="${className}" viewBox="0 0 24 24" aria-hidden="true">${paths[icon] || paths.check}</svg>`;
}

const REPORT_LOAD_ERROR_MESSAGE =
  "日報データを読み込めませんでした。「再読み込み」を押してください。";
const REPORT_LOAD_FAILURE_TOAST =
  "最新データを取得できませんでした。もう一度お試しください。";
const REPORT_PARTIAL_LOAD_MESSAGE =
  "一部のデータを読み込めませんでした。もう一度「最新データを取得」を押してください。";
const REPORT_SAVE_SUCCESS_MESSAGE = "変更を保存しました。";
const REPORT_SAVE_PARTIAL_MESSAGE =
  "一部の変更を保存できませんでした。もう一度保存してください。";
const REPORT_SAVE_FAILURE_MESSAGE =
  "変更を保存できませんでした。もう一度保存してください。";
const REPORT_SAVE_CACHE_WARNING =
  "変更は保存されましたが、表示を更新できませんでした。「最新データを取得」を押してください。";

async function refreshData() {
  finishEditing();
  if (!(await confirmDiscardUnsaved("最新データを取得"))) return;
  discardDirtyEdits();
  await loadData({ preserveDirty: false, forceRefresh: true, manual: true });
}

function discardDirtyEdits() {
  state.reportChanges.clear();
  state.commentChanges.clear();
  syncChrome();
}

function clearReportViewForLoadFailure() {
  state.rows = [];
  state.viewableMembers = [];
  state.currentTeam = [];
  state.hasInitializedReportView = false;
  state.missingCommentDates = null;
  state.missingCommentRangeStart = "";
  state.missingCommentRangeEnd = "";
  state.missingCommentMemberCounts = {};
  state.directorMissingDays = 0;
  $("tableWrap")?.replaceChildren();
  showMain(false);
}

async function loadData({
  silent = false,
  preserveDirty = true,
  preserveTableScroll = false,
  forceRefresh = false,
  manual = false,
  transition = false,
  viewSequence,
} = {}) {
  finishEditing();
  const requestSequence = ++state.loadRequestSequence;
  const hadData = Boolean(state.hasInitializedReportView);
  if (transition || !hadData) {
    showMain(false);
    $("tableWrap")?.replaceChildren();
  }
  clearScreenLoadError("reports");
  setBusy(true, "load");
  let result;
  try {
    result = await window.pywebview.api.load_data({
      start_date: state.startDate || null,
      end_date: state.endDate || null,
      period_preset: state.showMissingCommentsOnly
        ? "missing"
        : state.legacyLoadPreset || state.activePeriodPreset || null,
      force_refresh: forceRefresh,
    });
  } catch (error) {
    if (requestSequence !== state.loadRequestSequence) return;
    console.error("日報データの読み込みに失敗しました。", error);
    const hasDisplay = hadData && !transition;
    if (transition || !hadData) {
      clearReportViewForLoadFailure();
    }
    if (hasDisplay) {
      if (manual) {
        notify({
          text: REPORT_LOAD_FAILURE_TOAST,
          type: "error",
          source: "load",
        });
      }
    } else {
      showScreenLoadError(
        "reports",
        REPORT_LOAD_ERROR_MESSAGE,
        "error",
      );
    }
    return { ok: false };
  } finally {
    if (requestSequence === state.loadRequestSequence) setBusy(false);
  }
  if (requestSequence !== state.loadRequestSequence) return;
  if (
    viewSequence !== undefined &&
    viewSequence !== viewSwitchSequence
  ) {
    return { ok: false, stale: true };
  }
  if (!result.ok) {
    const accessDenied =
      result.access_denied === true || result.employee_registered === false;
    if (accessDenied) {
      state.accessDenied = true;
      clearReportViewForLoadFailure();
      updateViewAvailability();
      updateViewChrome();
      showScreenLoadError(
        "reports",
        result.message || REPORT_LOAD_ERROR_MESSAGE,
        "error",
      );
      return { ok: false, accessDenied: true };
    }
    const hasDisplay = hadData && !transition;
    if (transition || !hadData) {
      clearReportViewForLoadFailure();
    }
    if (hasDisplay) {
      if (manual) {
        notify({
          text: REPORT_LOAD_FAILURE_TOAST,
          type: "error",
          source: "load",
        });
      }
    } else {
      showScreenLoadError(
        "reports",
        REPORT_LOAD_ERROR_MESSAGE,
        "error",
      );
    }
    return { ok: false };
  }
  if (result.data_load_status === "all_failed") {
    state.accessDenied = false;
    clearReportViewForLoadFailure();
    updateViewAvailability();
    updateViewChrome();
    showScreenLoadError("reports", REPORT_LOAD_ERROR_MESSAGE, "error");
    return { ok: false, allDataFailed: true };
  }
  state.accessDenied = false;
  state.displayName = result.data.display_name || result.data.employee_id || "";
  syncCurrentUserDisplay();
  state.canInputOwnReport = result.data.can_input_own_report !== false;
  state.restrictToSelf = result.data.restrict_to_self === true;
  state.isSuperior = Boolean(result.data.is_superior);
  state.isDirector = Boolean(result.data.is_director);
  state.hasInitializedReportView = true;
  state.viewableMembers = Array.isArray(result.data.viewable_members)
    ? result.data.viewable_members
    : [
        ...new Map(
          (Array.isArray(result.data.rows) ? result.data.rows : []).map((row) => [
            row.employee_id,
            {
              employee_id: row.employee_id,
              display_name: row.display_name || row.employee_id,
              relations:
                row.employee_id === result.data.employee_id &&
                state.canInputOwnReport
                  ? ["self", "same_small_team"]
                  : result.data.is_superior
                    ? ["assigned_subordinate"]
                    : [],
              team_path: [],
            },
          ]),
        ).values(),
      ];
  state.currentTeam = Array.isArray(result.data.current_team)
    ? result.data.current_team
    : [];
  state.myRank = Number.isFinite(result.data.my_rank)
    ? result.data.my_rank
    : 9999;
  state.rows = Array.isArray(result.data.rows) ? result.data.rows : [];
  state.cacheGeneration = Number(result.cache_generation || 0);
  const missingCommentSummary = result.data.missing_comment_summary;
  state.missingCommentDates = Array.isArray(missingCommentSummary?.dates)
    ? missingCommentSummary.dates
    : null;
  state.missingCommentRangeStart = missingCommentSummary?.start_date || "";
  state.missingCommentRangeEnd = missingCommentSummary?.end_date || "";
  state.missingCommentMode = missingCommentSummary?.mode || "daily";
  state.missingCommentMemberCounts =
    missingCommentSummary?.member_counts &&
    typeof missingCommentSummary.member_counts === "object"
      ? { ...missingCommentSummary.member_counts }
      : {};
  state.directorMissingDays = Math.max(
    0,
    Number(
      missingCommentSummary?.director_missing_days ??
        missingCommentSummary?.max_elapsed_workdays ??
        0,
    ) || 0,
  );
  state.startDate = result.data.start_date || state.startDate;
  state.endDate = result.data.end_date || state.endDate;
  state.legacyLoadPreset = "";
  $("startDate").value = state.startDate;
  $("endDate").value = state.endDate;
  syncReportDateDisplays();
  syncPeriodPresets();
  if (preserveDirty) {
    reapplyDirtyEditsToRows();
  }
  state.expandedReplies.clear();

  const container = $("bossSearchControl");
  if (container) {
    const individualFilterEnabled =
      state.restrictToSelf || isMemberFilterLevelEnabled("member");
    const selfButton = $("showSelfButton");
    selfButton?.classList.toggle("hidden", !state.canInputOwnReport);
    const subordinates = state.viewableMembers.map((member) => ({
      id: member.employee_id,
      name: member.display_name || member.employee_id,
      relations: Array.isArray(member.relations) ? member.relations : [],
    }));
    const commentTargetMembers = subordinates.filter((member) =>
      member.relations.includes("assigned_subordinate"),
    );

    const availableIds = new Set(commentTargetMembers.map((sub) => sub.id));
    if (!individualFilterEnabled || !availableIds.has(state.selectedSubordinateId)) {
      state.selectedSubordinateId = "";
      if (state.memberScope === "member") state.memberScope = "all";
    }
    if (!commentTargetMembers.length) {
      state.memberScope = getDefaultMemberScope();
      state.selectedSubordinateId = "";
    } else if (!state.canInputOwnReport && state.memberScope === "self") {
      state.memberScope = getDefaultMemberScope();
    }
    if (!isAvailableMemberScope(state.memberScope)) {
      state.memberScope = getDefaultMemberScope();
    }

    const existingTeamFilters = container.querySelectorAll("[data-team-filter]");
    existingTeamFilters.forEach((button) => button.remove());
    const existingTags = container.querySelectorAll(
      ".member-switch-button[data-id]",
    );
    existingTags.forEach((t) => t.remove());

    getAvailableTeamFilterScopes().forEach(({ level, scope, team }) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "member-switch-button";
      btn.dataset.memberScope = scope;
      btn.dataset.teamFilter = team.team_id;
      const label = document.createElement("span");
      label.className = "relative";
      const teamName = team.team_name || MEMBER_FILTER_LABELS[level];
      label.textContent = teamName;
      btn.appendChild(label);
      btn.setAttribute("aria-label", teamName);
      btn.title = teamName;
      btn.setAttribute("aria-pressed", "false");
      container.appendChild(btn);
    });

    const individualMembers = individualFilterEnabled ? commentTargetMembers : [];
    individualMembers.forEach((sub) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "member-switch-button";
      btn.dataset.id = sub.id;
      const label = document.createElement("span");
      label.className = "relative";
      label.textContent = sub.name;
      btn.appendChild(label);
      btn.setAttribute("aria-label", sub.name);
      btn.title = sub.name;
      btn.setAttribute("aria-pressed", "false");
      container.appendChild(btn);
    });

    const allButton = $("showAllSubordinatesButton");
    if (allButton) {
      setMemberFilterButtonLabel(allButton, "全員");
      allButton.classList.toggle("hidden", commentTargetMembers.length === 0);
    }
    updateSubordinateFilterUi();
  }

  updateViewAvailability();
  updateViewChrome();
  syncChrome();
  renderTable({ preserveScroll: preserveTableScroll });
  showMain(true);
  const refreshResult = result.refresh_result || {};
  const warningCount = Number(result.data.load_warning_count || 0);
  const refreshFailed = Number(refreshResult.failed || 0);
  const dataLoadPartial = result.data_load_status === "partial";
  if (dataLoadPartial || refreshFailed > 0 || warningCount > 0) {
    showScreenLoadError("reports", REPORT_PARTIAL_LOAD_MESSAGE, "warning");
  } else {
    clearScreenLoadError("reports");
    clearLoadToasts("reports");
    if (manual) {
      notify({
        text: "最新データを取得しました。",
        type: "success",
      });
    }
  }
  return {
    ok: true,
    partial: dataLoadPartial || refreshFailed > 0 || warningCount > 0,
  };
}

function setMemberFilterButtonLabel(button, text) {
  if (!button) return;
  let label = button.querySelector(":scope > .relative");
  if (!label) {
    label = document.createElement("span");
    label.className = "relative";
    button.replaceChildren(label);
  }
  label.textContent = text;
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
  const startDate = $("startDate").value;
  const endDate = $("endDate").value;
  if (!startDate || !endDate || startDate > endDate) return;
  if (!(await confirmDiscardUnsaved("日付範囲を変更"))) {
    $("startDate").value = state.startDate;
    $("endDate").value = state.endDate;
    syncReportDateDisplays();
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

  if (!(await confirmDiscardUnsaved("日付範囲を変更"))) return;
  discardDirtyEdits();
  startInput.value = startDate;
  endInput.value = endDate;
  syncReportDateDisplays();
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
  const action = presetName === "missing" ? "表示を切り替え" : "日付範囲を変更";
  if (!(await confirmDiscardUnsaved(action))) return;
  discardDirtyEdits();

  if (presetName === "missing" && state.showMissingCommentsOnly) {
    exitMissingCommentsFilter();
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
    state.memberScope = "all";
    state.selectedSubordinateId = "";
    updateSubordinateFilterUi();
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
  syncReportDateDisplays();
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
      (state.isDirector || state.includeTodayInMissingComments
        ? today
        : offsetDateStr(today, -1));
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
    columns: context.columns,
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
  const sampleComments = getVisibleComments(
    rows[0]?.comments || state.rows[0]?.comments || [],
  );

  return {
    sampleComments,
    columns: createTableColumnDefinitions(sampleComments),
  };
}

function createTableColumnDefinitions(sampleComments) {
  const columns = [
    { id: "user", kind: "user", className: "user-col", label: "名前" },
    { id: "date", kind: "date", className: "date-col", label: "日付" },
    { id: "name", kind: "name", className: "name-col", label: "業務名" },
    { id: "detail", kind: "detail", className: "detail-col", label: "業務詳細" },
  ];
  sampleComments.forEach((cell, index) => {
    const isCurrentUser = cell.superior_employee_id === state.employeeId;
    columns.push({
      id: `comment:${index}`,
      kind: "comment",
      className: `comment-col${isCurrentUser ? " self-comment-col" : ""}`,
      isCurrentUser,
      label: cell.superior_name,
    });
  });
  return columns.map((column) => ({
    ...column,
    width: getTableColumnWidth(column.id, column.kind),
    minWidth: TABLE_COLUMN_MIN_WIDTH_PROFILES[state.fontSize][column.kind],
    maxWidth: TABLE_COLUMN_MAX_WIDTHS[column.kind],
  }));
}

function renderTableShell({ header, body, columns }) {
  const totalWidth = columns.reduce((total, column) => total + column.width, 0);
  const userColumn = columns.find((column) => column.kind === "user");
  const columnMarkup = columns
    .map(
      (column) =>
        `<col data-column-id="${escapeHtml(column.id)}" data-column-kind="${column.kind}" style="width:${column.width}px">`,
    )
    .join("");
  return `<div class="table-scroll">
    <div class="column-resize-guide" aria-hidden="true"></div>
    <div class="table-content" style="width:${totalWidth}px;--sticky-date-left:${userColumn.width}px">
      <table><colgroup>${columnMarkup}</colgroup>${header}<tbody>${body}</tbody></table>
    </div>
  </div>`;
}

function renderTableHeader(context) {
  return `<thead><tr>${context.columns.map(renderResizableHeader).join("")}</tr></thead>`;
}

function renderResizableHeader(column) {
  const columnId = escapeHtml(column.id);
  const label = `<span class="column-header-label">${escapeHtml(column.label)}</span>`;
  const headerContent = column.isCurrentUser
    ? `<span class="column-header-content">${label}<span class="column-header-you" aria-label="You">You</span></span>`
    : label;
  return `<th class="${column.className}" data-column-id="${columnId}">
    ${headerContent}
    <span class="column-resize-handle" role="separator" aria-orientation="vertical" aria-label="${escapeHtml(column.label)}列の幅を変更" aria-valuemin="${column.minWidth}" aria-valuemax="${column.maxWidth}" aria-valuenow="${column.width}" data-column-id="${columnId}" data-column-kind="${column.kind}" tabindex="0"></span>
  </th>`;
}

function getVisibleComments(comments = []) {
  if (!Array.isArray(comments)) return [];
  if (state.memberScope !== "self" || !state.isSuperior) return comments;
  return comments.filter(
    (cell) => cell?.superior_employee_id !== state.employeeId,
  );
}

function renderReportRows(rows, context) {
  const groups = [];
  rows.forEach((row) => {
    let group = groups.at(-1);
    if (!group || group.employeeId !== row.employee_id) {
      group = { employeeId: row.employee_id, rows: [] };
      groups.push(group);
    }
    group.rows.push(row);
  });
  return groups
    .map((group) => {
      const member = getViewableMember(group.employeeId);
      const displayName =
        member?.display_name || group.rows[0]?.display_name || group.employeeId;
      return group.rows
        .map((row, idx) => renderReportRow(row, idx, context, {
          displayName,
          rowSpan: group.rows.length,
          showUserCell: idx === 0,
        }))
        .join("");
    })
    .join("");
}

function getViewableMember(employeeId) {
  return state.viewableMembers.find((member) => member.employee_id === employeeId);
}

function renderReportRow(row, idx, context, memberContext) {
  const contentCells = row.__holidayPlaceholder
    ? renderHolidayPlaceholderCells(context, row)
    : `${renderReportNameCell(row)}
    ${renderReportDetailCell(row)}
    ${renderCommentCells(row)}`;
  return `<tr class="${renderReportRowClass(row, idx, context)}" data-scroll-key="${escapeHtml(getReportRowKey(row))}">
    ${renderUserCell(memberContext)}
    ${renderDateCell(row, idx, context)}
    ${contentCells}
  </tr>`;
}

function renderUserCell(memberContext) {
  if (!memberContext?.showUserCell) return "";
  return `<th class="user-col" scope="rowgroup" rowspan="${memberContext.rowSpan}">
    <div class="user-content">
      <strong>${escapeHtml(memberContext.displayName)}</strong>
    </div>
  </th>`;
}

function renderHolidayPlaceholderCells(context, row) {
  const commentCells = getVisibleComments(row.comments || [])
    .map((cell, index) => {
      const originalIndex = row.comments.indexOf(cell);
      return renderCommentCell(row, cell, row.__index, originalIndex);
    })
    .join("");
  return `<td class="name-col holiday-placeholder-cell" aria-label="休日のため日報なし"></td>
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
  ]
    .filter(Boolean)
    .join(" ");
}

function renderDateCell(row, idx, context) {
  const holidayLabel = renderHolidayLabel(row);
  const todayAriaLabel = row.is_today
    ? ` aria-label="今日、${escapeHtml(formatNavigationDate(row.date, true))}"`
    : "";
  const content = renderCellFrame(
    `<div class="date-primary">
        <span class="date-value">${formatDisplayDateHTML(row.date)}</span>
        ${holidayLabel}
      </div>
      `,
    "cell-frame-static date-content",
  );
  return `<td class="date-col"${todayAriaLabel}>${content}</td>`;
}

function renderHolidayLabel(row) {
  return row.holiday_description
    ? `<span class="cell-sub-label">${escapeHtml(row.holiday_description)}</span>`
    : "";
}

function rowHasVisibleBossComment(row) {
  return getVisibleComments(row.comments || []).some((cell) =>
    normalizeCellValue(cell.comment),
  );
}

function renderReportNameCell(row) {
  return `<td class="${renderReportTdClass("name-col", row, "business_name")}">${renderEditableCell({
    kind: "report",
    type: "name",
    field: "business_name",
    rowIndex: row.__index,
    value: row.business_name,
    editable: row.can_edit_report,
    showEmptyIcon: !row.is_holiday,
    editLabel: `${formatNavigationDate(row.date, true)}の業務名`,
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
    showEmptyIcon: !row.is_holiday,
    editLabel: `${formatNavigationDate(row.date, true)}の業務詳細`,
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
  return context.canEditComment
    ? renderBossCommentCell(context)
    : renderDailyCommentCell(context);
}

function createCommentRenderContext(row, cell, rowIndex, commentIndex) {
  const canEditComment = Boolean(cell.editable);
  const canAddBossComment = canEditComment && rowCanReceiveBossComment(row);
  const hasBossComment = Boolean(String(cell.comment || "").trim());
  const hasReply = Boolean(String(cell.reply || "").trim());
  const canEditReply =
    row.can_edit_report && hasBossComment;

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
    <button class="boss-comment-link" type="button" data-action="sign-comment" data-row="${context.rowIndex}" data-comment="${context.commentIndex}" aria-label="名前を記入" title="名前を記入"><svg class="boss-comment-action-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19.5h16" /><path d="m14.5 4.5 5 5" /><path d="m13 6 4 4-7.5 7.5-4.5 1 1-4.5Z" /></svg></button>
    <button class="boss-comment-link" type="button" data-action="edit-comment" data-row="${context.rowIndex}" data-comment="${context.commentIndex}" aria-label="コメントを記入" title="コメントを記入"><svg class="boss-comment-action-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19H5l-3 3V6a3 3 0 0 1 3-3h11a3 3 0 0 1 3 3v4" /><path d="m14 17 5.5-5.5a1.77 1.77 0 0 1 2.5 2.5L16.5 19.5 13 20Z" /></svg></button>
  </div>`;
}

function renderBossCommentDisplay(context) {
  if (context.hasBossComment) {
    return renderBossCommentEditor(context, context.canEditComment);
  }

  return renderEditableCell({
    kind: "comment",
    type: "boss",
    field: "comment",
    rowIndex: context.rowIndex,
    commentIndex: context.commentIndex,
    value: "",
    editable: context.canEditComment,
    showEmptyIcon: false,
    hidden: context.canAddBossComment,
    editLabel: `${formatNavigationDate(context.row.date, true)}の${context.cell.superior_name || "上司"}へのコメント`,
  });
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
    editLabel: `${formatNavigationDate(context.row.date, true)}の${context.cell.superior_name || "上司"}へのコメント`,
  });
}

function renderBossReplyPreview(context) {
  if (!context.hasReply) return "";
  return `<div class="reply-section is-expanded">${renderReplyCard(context)}</div>`;
}

function renderDailyCommentCell(context) {
  return `<td class="comment-col"><div class="comment-stack">${renderBossCommentEditor(context, false)}${renderReplySection(context)}</div></td>`;
}

function renderReplySection(context) {
  if (!canShowReplySection(context)) return "";
  const stateClass = isReplySectionExpanded(context)
    ? " is-expanded"
    : " is-collapsed";
  return `<div class="reply-section${stateClass}">${renderReplyToggleButton(context)}${renderReplyCard(context)}</div>`;
}

function canShowReplySection(context) {
  return context.canEditReply || context.hasReply;
}

function isReplySectionExpanded(context) {
  return context.hasReply || state.expandedReplies.has(context.replyKey);
}

function renderReplyToggleButton(context) {
  if (!context.canEditReply || isReplySectionExpanded(context)) return "";
  return renderReplyToggleButtonMarkup(
    context.rowIndex,
    context.commentIndex,
  );
}

function renderReplyToggleButtonMarkup(rowIndex, commentIndex) {
  return `<button class="reply-toggle-button" type="button" data-action="toggle-reply" data-row="${rowIndex}" data-comment="${commentIndex}" aria-label="返信する" title="返信する"><svg class="reply-toggle-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 17-5-5 5-5" /><path d="M20 18v-2a4 4 0 0 0-4-4H4" /></svg></button>`;
}

function renderReplyCard(context) {
  if (!isReplySectionExpanded(context)) return "";
  return `<div class="cell-frame reply-card" aria-label="部下返信"><span class="boss-reply-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m9 17-5-5 5-5" /><path d="M20 18v-2a4 4 0 0 0-4-4H4" /></svg></span><div class="reply-card-content">${renderReplyEditor(context)}</div></div>`;
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
    editLabel: `${formatNavigationDate(context.row.date, true)}の${context.cell.superior_name || "上司"}への返信`,
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
  showEmptyIcon = true,
  hidden = false,
  dataAttributes = {},
  editLabel = "セル",
}) {
  const display = displayText(value);
  const empty = isEmpty(value);
  const classes = [
    "cell-frame",
    "editable-content",
    `${type}-content`,
    empty ? "is-empty" : "",
    !showEmptyIcon ? "empty-icon-hidden" : "",
    editable ? "is-editable" : "is-readonly",
    dirty ? "is-dirty" : "",
    hidden ? "hidden" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const accessibilityAttributes = editable
    ? ` role="button" tabindex="0" aria-label="${escapeHtml(`${editLabel}を${empty ? "入力" : "編集"}`)}"`
    : "";
  const serializedDataAttributes = Object.entries(dataAttributes)
    .map(([name, attributeValue]) => {
      if (!/^[a-z][a-z0-9-]*$/.test(name)) return "";
      return ` data-${name}="${escapeHtml(attributeValue)}"`;
    })
    .join("");
  const content = empty && editable && showEmptyIcon
    ? renderEmptyEditableIcon()
    : escapeHtml(display);
  return `<div class="${classes}" data-kind="${kind}" data-type="${type}" data-row="${rowIndex}" data-field="${field}" data-comment="${commentIndex}" data-editable="${editable ? "true" : "false"}"${accessibilityAttributes}${serializedDataAttributes}>${content}</div>`;
}

function renderEmptyEditableIcon() {
  return `<span class="editable-empty-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path fill="currentColor" fill-rule="evenodd" d="M16.793 2.793a3.121 3.121 0 1 1 4.414 4.414l-8.5 8.5A1 1 0 0 1 12 16H9a1 1 0 0 1-1-1v-3a1 1 0 0 1 .293-.707l8.5-8.5Zm3 1.414a1.121 1.121 0 0 0-1.586 0L10 12.414V14h1.586l8.207-8.207a1.121 1.121 0 0 0 0-1.586ZM6 5a1 1 0 0 1-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 1-1-1v-4a1 1 0 1 1 2 0v4a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3h4a1 1 0 1 1 0 2H6Z" clip-rule="evenodd" /></svg></span>`;
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

function getRenderedTableColumn(columnId) {
  return [...document.querySelectorAll("#tableWrap col[data-column-id]")].find(
    (column) => column.dataset.columnId === columnId,
  );
}

function getRenderedColumnResizeHandle(columnId) {
  return [
    ...document.querySelectorAll("#tableWrap .column-resize-handle[data-column-id]"),
  ].find((handle) => handle.dataset.columnId === columnId);
}

function applyColumnWidthsToRenderedTable() {
  const tableContent = document.querySelector("#tableWrap .table-content");
  const columns = [
    ...document.querySelectorAll("#tableWrap col[data-column-id][data-column-kind]"),
  ];
  if (!(tableContent instanceof HTMLElement) || !columns.length) return;

  let totalWidth = 0;
  let userWidth = 0;
  columns.forEach((column) => {
    const { columnId, columnKind } = column.dataset;
    const width = getTableColumnWidth(columnId, columnKind);
    column.style.width = `${width}px`;
    totalWidth += width;
    if (columnKind === "user") userWidth = width;
    const handle = getRenderedColumnResizeHandle(columnId);
    if (handle) {
      handle.setAttribute(
        "aria-valuemin",
        String(TABLE_COLUMN_MIN_WIDTH_PROFILES[state.fontSize][columnKind]),
      );
      handle.setAttribute(
        "aria-valuemax",
        String(TABLE_COLUMN_MAX_WIDTHS[columnKind]),
      );
      handle.setAttribute("aria-valuenow", String(width));
    }
  });
  tableContent.style.width = `${totalWidth}px`;
  tableContent.style.setProperty("--sticky-date-left", `${userWidth}px`);
}

function positionColumnResizeGuide(clientX) {
  const scroll = document.querySelector("#tableWrap .table-scroll");
  const guide = document.querySelector("#tableWrap .column-resize-guide");
  if (!(scroll instanceof HTMLElement) || !(guide instanceof HTMLElement)) return;
  const bounds = scroll.getBoundingClientRect();
  guide.style.left = `${clientX}px`;
  guide.style.top = `${bounds.top}px`;
  guide.style.height = `${bounds.height}px`;
}

function startColumnResize(event) {
  const handle = event.target.closest(".column-resize-handle");
  if (!(handle instanceof HTMLElement) || event.button !== 0) return;
  const { columnId, columnKind } = handle.dataset;
  const column = getRenderedTableColumn(columnId);
  if (!column || !columnKind) return;

  finishEditing();
  const startWidth = getTableColumnWidth(columnId, columnKind);
  tableColumnResizeState = {
    pointerId: event.pointerId,
    handle,
    columnId,
    columnKind,
    startX: event.clientX,
    startWidth,
  };
  handle.setPointerCapture(event.pointerId);
  handle.classList.add("is-active");
  document.body.classList.add("is-resizing-column");
  document
    .querySelector("#tableWrap .column-resize-guide")
    ?.classList.add("is-visible");
  positionColumnResizeGuide(event.clientX);
  event.preventDefault();
}

function moveColumnResize(event) {
  if (
    !tableColumnResizeState ||
    event.pointerId !== tableColumnResizeState.pointerId
  ) {
    return;
  }
  const width = setTableColumnWidth(
    tableColumnResizeState.columnId,
    tableColumnResizeState.columnKind,
    tableColumnResizeState.startWidth + event.clientX - tableColumnResizeState.startX,
  );
  applyColumnWidthsToRenderedTable();
  tableColumnResizeState.handle.setAttribute("aria-valuenow", String(width));
  positionColumnResizeGuide(event.clientX);
}

function finishColumnResize(event) {
  if (
    !tableColumnResizeState ||
    event.pointerId !== tableColumnResizeState.pointerId
  ) {
    return;
  }
  const { handle } = tableColumnResizeState;
  if (handle.hasPointerCapture(event.pointerId)) {
    handle.releasePointerCapture(event.pointerId);
  }
  handle.classList.remove("is-active");
  document.body.classList.remove("is-resizing-column");
  document
    .querySelector("#tableWrap .column-resize-guide")
    ?.classList.remove("is-visible");
  tableColumnResizeState = null;
  persistUiState();
}

function handleColumnResizeKeydown(event, handle) {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return false;
  const { columnId, columnKind } = handle.dataset;
  const direction = event.key === "ArrowRight" ? 1 : -1;
  const step = event.shiftKey ? 24 : 8;
  setTableColumnWidth(
    columnId,
    columnKind,
    getTableColumnWidth(columnId, columnKind) + direction * step,
  );
  applyColumnWidthsToRenderedTable();
  persistUiState();
  event.preventDefault();
  return true;
}

function resetColumnWidths() {
  state.columnWidths = {};
  applyColumnWidthsToRenderedTable();
  persistUiState();
}

function handleTableClick(event) {
  if (event.target.closest(".column-resize-handle")) return;
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
  const resizeHandle = target.closest(".column-resize-handle");
  if (resizeHandle instanceof HTMLElement) {
    handleColumnResizeKeydown(event, resizeHandle);
    return;
  }
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
  startEditingTarget(target, { preventScroll: true });
}

function applyBossCommentSignature(button) {
  const { row, cell } = getBossCommentTarget(button);
  if (!row || !cell) return;
  button.closest(".boss-comment-actions")?.classList.add("hidden");
  finishEditing();
  const signature = normalizeCellValue(state.commentSignature || cell.superior_name);
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
  const row = state.rows[Number(target.dataset.row)];
  const commentCell = row?.comments?.[Number(target.dataset.comment)];
  const reportChange = row
    ? state.reportChanges.get(getReportRowKey(row))
    : null;
  const commentKey = row && commentCell ? getReplyKey(row, commentCell) : "";
  editingSnapshot = {
    kind: target.dataset.kind,
    row,
    field: target.dataset.field || "",
    commentCell,
    originalValue:
      target.dataset.kind === "report"
        ? normalizeCellValue(row?.[target.dataset.field])
        : target.dataset.kind === "reply"
          ? normalizeCellValue(commentCell?.reply)
          : normalizeCellValue(commentCell?.comment),
    reportChange: reportChange
      ? { date: reportChange.date, fields: { ...reportChange.fields }, replies: { ...reportChange.replies } }
      : null,
    commentChange: commentKey ? state.commentChanges.get(commentKey) : null,
    commentKey,
    elementDirty: target.classList.contains("is-dirty"),
    cellDirty: Boolean(target.closest("td")?.classList.contains("is-dirty-cell")),
    elementHidden: target.classList.contains("hidden"),
    actionsHidden: Boolean(target.parentElement?.querySelector(".boss-comment-actions")?.classList.contains("hidden")),
  };
  const actions = target.parentElement?.querySelector(".boss-comment-actions");
  actions?.classList.add("hidden");
  target.classList.remove("hidden");
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
      cancelEditing();
      return;
    }
    if (keyEvent.key === "Tab") {
      keyEvent.preventDefault();
      queueImeDiagnostic("keydown_handled", textarea, keyEvent, {
        reason: "tab",
      });
      moveEditingFocus(keyEvent.shiftKey ? -1 : 1);
      return;
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

function cancelEditing() {
  if (!currentEditingElement) return;
  const editingElement = currentEditingElement;
  const snapshot = editingSnapshot;
  if (snapshot?.row) {
    if (snapshot.kind === "report") snapshot.row[snapshot.field] = snapshot.originalValue;
    if (snapshot.kind === "reply" && snapshot.commentCell) snapshot.commentCell.reply = snapshot.originalValue;
    if (snapshot.kind === "comment" && snapshot.commentCell) snapshot.commentCell.comment = snapshot.originalValue;
    const reportKey = getReportRowKey(snapshot.row);
    if (snapshot.reportChange) state.reportChanges.set(reportKey, snapshot.reportChange);
    else state.reportChanges.delete(reportKey);
    if (snapshot.commentKey) {
      if (snapshot.commentChange) state.commentChanges.set(snapshot.commentKey, snapshot.commentChange);
      else state.commentChanges.delete(snapshot.commentKey);
    }
  }
  editingElement.innerHTML =
    isEmpty(snapshot?.originalValue) && !editingElement.classList.contains("empty-icon-hidden")
      ? renderEmptyEditableIcon()
      : escapeHtml(displayText(snapshot?.originalValue || ""));
  editingElement.classList.toggle("is-empty", isEmpty(snapshot?.originalValue));
  editingElement.classList.toggle("is-dirty", Boolean(snapshot?.elementDirty));
  editingElement.closest("td")?.classList.toggle("is-dirty-cell", Boolean(snapshot?.cellDirty));
  editingElement.classList.toggle("hidden", Boolean(snapshot?.elementHidden));
  editingElement.parentElement?.querySelector(".boss-comment-actions")?.classList.toggle(
    "hidden",
    Boolean(snapshot?.actionsHidden),
  );
  editingElement.classList.remove("is-editing");
  currentEditingElement = null;
  editingSnapshot = null;
  syncChrome();
  scheduleImeDiagnosticFlush();
}

function moveEditingFocus(direction) {
  if (!currentEditingElement?.querySelector("textarea")) return;
  const nextTarget = findHorizontalEditableTarget(direction);
  finishEditing();
  if (nextTarget instanceof HTMLElement) {
    startEditingTarget(nextTarget);
  }
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
    if (isEmpty(normalized) && !editingElement.classList.contains("empty-icon-hidden")) {
      editingElement.innerHTML = renderEmptyEditableIcon();
    } else {
      editingElement.textContent = displayText(normalized);
    }
    const currentLabel = editingElement.getAttribute("aria-label");
    if (currentLabel) {
      editingElement.setAttribute(
        "aria-label",
        currentLabel.replace(/を(?:入力|編集)$/, `を${isEmpty(normalized) ? "入力" : "編集"}`),
      );
    }
    editingElement.classList.toggle("is-empty", isEmpty(normalized));
    editingElement.classList.remove("is-editing");

    if (textarea.dataset.kind === "comment") {
      const bossCommentActions = editingElement.parentElement?.querySelector(
        ".boss-comment-actions",
      );
      const hasActions = Boolean(bossCommentActions);
      editingElement.classList.toggle("hidden", isEmpty(normalized) && hasActions);
      bossCommentActions?.classList.toggle("hidden", !isEmpty(normalized));
    }

    const isEmptyReply =
      textarea.dataset.kind === "reply" && isEmpty(normalized);
    const replyKey = textarea.dataset.replyKey || "";
    if (isEmptyReply && replyKey) {
      state.expandedReplies.delete(replyKey);
      const replySection = editingElement.closest(".reply-section");
      if (replySection?.classList.contains("reply-section")) {
        replySection.classList.remove("is-expanded");
        replySection.classList.add("is-collapsed");
        replySection.innerHTML = renderReplyToggleButtonMarkup(
          textarea.dataset.row || "",
          textarea.dataset.comment || "",
        );
      }
    }
  }
  currentEditingElement = null;
  editingSnapshot = null;
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
  return !row.is_holiday;
}

function rowNeedsBossComment(row) {
  if (!row || !row.needs_review) return false;
  const myCell = (row.comments || []).find(
    (cell) => cell.superior_employee_id === state.employeeId && cell.editable,
  );
  return Boolean(myCell && (isEmpty(myCell.comment) || isBossCommentDirty(row, myCell)));
}

function rowMatchesMissingCommentFilter(row) {
  if (state.isDirector && state.missingCommentMode === "weekly_director") {
    return Number(state.missingCommentMemberCounts?.[row?.employee_id] || 0) > 0;
  }
  return rowNeedsBossComment(row);
}

function getMissingCommentSummary({ useCurrentRows = false } = {}) {
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
  if (state.isDirector && state.missingCommentMode === "weekly_director") {
    const count = Math.max(0, Number(state.directorMissingDays || 0));
    return {
      count,
      hasOverdue: count > 0,
      dates: Array.isArray(state.missingCommentDates)
        ? [...state.missingCommentDates]
        : [],
      rangeStart: state.missingCommentRangeStart || "",
      rangeEnd: state.missingCommentRangeEnd || today,
    };
  }

  const rangeStart =
    state.missingCommentRangeStart || state.missingCommentStartDate || "";
  const sourceDates = useCurrentRows || !Array.isArray(state.missingCommentDates)
    ? state.rows.filter(rowNeedsBossComment).map((row) => row.date)
    : state.missingCommentDates;
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

  const selectedId = state.selectedSubordinateId;
  const allowedIds = new Set(
    state.viewableMembers
      .filter((member) => {
        const relations = Array.isArray(member.relations) ? member.relations : [];
        if (state.restrictToSelf) {
          return state.canInputOwnReport && member.employee_id === state.employeeId;
        }
        if (state.memberScope === "self") {
          return state.canInputOwnReport && member.employee_id === state.employeeId;
        }
        if (member.employee_id === state.employeeId) return false;
        if (state.memberScope?.startsWith("team:")) {
          const teamScope = getAvailableTeamFilterScopes().find(
            (scope) => scope.scope === state.memberScope,
          );
          return Boolean(
            teamScope && memberMatchesTeamEntry(member, teamScope.team),
          );
        }
        if (state.memberScope === "team") return relations.includes("same_small_team");
        if (state.memberScope === "subordinates") {
          return relations.includes("assigned_subordinate");
        }
        if (state.memberScope === "all") {
          return relations.includes("assigned_subordinate");
        }
        if (state.memberScope === "member") return member.employee_id === selectedId;
        return true;
      })
      .map((member) => member.employee_id),
  );
  let visibleRows = filteredByDate.filter((row) => allowedIds.has(row.employee_id));
  if (state.showMissingCommentsOnly) {
    visibleRows = visibleRows.filter(rowMatchesMissingCommentFilter);
  }

  const memberOrder = new Map(
    state.viewableMembers.map((member, index) => [member.employee_id, index]),
  );
  return collapseEmptyHolidayRows(visibleRows).sort((left, right) => {
    const memberDelta =
      (memberOrder.get(left.employee_id) ?? Number.MAX_SAFE_INTEGER) -
      (memberOrder.get(right.employee_id) ?? Number.MAX_SAFE_INTEGER);
    if (memberDelta) return memberDelta;
    return left.date.localeCompare(right.date);
  });
}

function collapseEmptyHolidayRows(rows) {
  const holidayDatesWithReports = new Set(
    rows
      .filter((row) => row.is_holiday && rowHasReportData(row))
      .map((row) => `${row.employee_id}|${row.date}`),
  );
  const placeholderDates = new Set();

  return rows.flatMap((row) => {
    if (!row.is_holiday) return [row];
    if (row.can_edit_report) return [row];
    const holidayKey = `${row.employee_id}|${row.date}`;
    if (rowHasReportData(row)) return [row];
    if (
      holidayDatesWithReports.has(holidayKey) ||
      placeholderDates.has(holidayKey)
    ) {
      return [];
    }
    placeholderDates.add(holidayKey);
    return [{ ...row, __holidayPlaceholder: true }];
  });
}

function getEmptyMessage() {
  if (state.showMissingCommentsOnly) {
    return "未確認の日報はありません。";
  }
  return "条件に一致するメンバーの日報はありません。";
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

function cloneReportChange(change) {
  return {
    date: change.date,
    fields: { ...(change.fields || {}) },
    replies: { ...(change.replies || {}) },
  };
}

function createReportSaveEntry(key, change) {
  const snapshot = cloneReportChange(change);
  const update = { date: snapshot.date, ...snapshot.fields };
  const replies = Object.entries(snapshot.replies).map(
    ([superiorEmployeeId, reply]) => ({
      superior_employee_id: superiorEmployeeId,
      reply,
    }),
  );
  if (replies.length) update.replies = replies;
  return { key, snapshot, update };
}

function createCommentSaveEntry(key, change) {
  const snapshot = {
    subordinate_employee_id: change.subordinate_employee_id,
    superior_employee_id: change.superior_employee_id,
    date: change.date,
    comment: change.comment,
  };
  return {
    key,
    snapshot,
    update: {
      subordinate_employee_id: snapshot.subordinate_employee_id,
      date: snapshot.date,
      comment: snapshot.comment,
    },
  };
}

function hasSameObjectEntries(left, right) {
  const leftEntries = Object.entries(left || {});
  const rightEntries = Object.entries(right || {});
  return (
    leftEntries.length === rightEntries.length &&
    rightEntries.every(
      ([key, value]) =>
        Object.prototype.hasOwnProperty.call(left || {}, key) &&
        left[key] === value,
    )
  );
}

function reportChangeMatchesSnapshot(change, snapshot) {
  return Boolean(change) &&
    change.date === snapshot.date &&
    hasSameObjectEntries(change.fields, snapshot.fields) &&
    hasSameObjectEntries(change.replies, snapshot.replies);
}

function commentChangeMatchesSnapshot(change, snapshot) {
  return Boolean(change) &&
    change.subordinate_employee_id === snapshot.subordinate_employee_id &&
    change.superior_employee_id === snapshot.superior_employee_id &&
    change.date === snapshot.date &&
    change.comment === snapshot.comment;
}

function applySavedReportEntry(entry) {
  const currentChange = state.reportChanges.get(entry.key);
  if (currentChange && !reportChangeMatchesSnapshot(currentChange, entry.snapshot)) {
    return;
  }
  const row = state.rows.find(
    (candidate) =>
      candidate.employee_id === state.employeeId &&
      candidate.date === entry.snapshot.date,
  );
  if (!row) return;
  Object.entries(entry.snapshot.fields).forEach(([field, value]) => {
    row[field] = value;
  });
  const comments = Array.isArray(row.comments) ? row.comments : [];
  Object.entries(entry.snapshot.replies).forEach(([superiorId, reply]) => {
    const cell = comments.find(
      (candidate) => candidate.superior_employee_id === superiorId,
    );
    if (cell) cell.reply = reply;
  });
}

function applySavedCommentEntry(entry) {
  const currentChange = state.commentChanges.get(entry.key);
  if (currentChange && !commentChangeMatchesSnapshot(currentChange, entry.snapshot)) {
    return;
  }
  const row = state.rows.find(
    (candidate) =>
      candidate.employee_id === entry.snapshot.subordinate_employee_id &&
      candidate.date === entry.snapshot.date,
  );
  if (!row) return;
  const cell = (Array.isArray(row.comments) ? row.comments : []).find(
    (candidate) =>
      candidate.superior_employee_id === entry.snapshot.superior_employee_id,
  );
  if (cell) cell.comment = entry.snapshot.comment;
}

function commitSavedReportEntry(entry) {
  const currentChange = state.reportChanges.get(entry.key);
  if (reportChangeMatchesSnapshot(currentChange, entry.snapshot)) {
    state.reportChanges.delete(entry.key);
  }
}

function commitSavedCommentEntry(entry) {
  const currentChange = state.commentChanges.get(entry.key);
  if (commentChangeMatchesSnapshot(currentChange, entry.snapshot)) {
    state.commentChanges.delete(entry.key);
  }
}

async function saveUpdates() {
  if (state.isBusy) {
    syncChrome();
    return false;
  }

  finishEditing();
  const reportEntries = Array.from(state.reportChanges.entries()).map(
    ([key, change]) => createReportSaveEntry(key, change),
  );
  const commentEntries = Array.from(state.commentChanges.entries()).map(
    ([key, change]) => createCommentSaveEntry(key, change),
  );
  if (!reportEntries.length && !commentEntries.length) {
    syncChrome();
    return false;
  }

  setBusy(true, "save");
  let result;
  try {
    result = await window.pywebview.api.save_updates({
      user_updates: reportEntries.map(({ update }) => update),
      comment_updates: commentEntries.map(({ update }) => update),
    });
  } catch (error) {
    console.error("日報の保存に失敗しました。", error);
    notify({ text: REPORT_SAVE_FAILURE_MESSAGE, type: "error" });
    return false;
  } finally {
    setBusy(false);
  }

  if (result?.no_targets === true) {
    syncChrome();
    return false;
  }

  const userSaved =
    reportEntries.length === 0 || result?.result?.user?.saved === true;
  const commentSaved =
    commentEntries.length === 0 || result?.result?.comment?.saved === true;
  const reportChangesSaved = reportEntries.length > 0 && userSaved;
  const commentChangesSaved = commentEntries.length > 0 && commentSaved;
  const anySaved = reportChangesSaved || commentChangesSaved;
  const allSaved = result?.ok === true && userSaved && commentSaved;
  let displayUpdateFailed = result?.cache_sync_failed === true;

  if (anySaved) {
    try {
      if (reportChangesSaved) {
        reportEntries.forEach((entry) => applySavedReportEntry(entry));
      }
      if (commentChangesSaved) {
        commentEntries.forEach((entry) => applySavedCommentEntry(entry));
      }
    } catch (error) {
      displayUpdateFailed = true;
      console.error("日報の保存結果を画面に反映できませんでした。", error);
    }
    if (reportChangesSaved) {
      reportEntries.forEach((entry) => commitSavedReportEntry(entry));
    }
    if (commentChangesSaved) {
      commentEntries.forEach((entry) => commitSavedCommentEntry(entry));
    }
    try {
      if (commentChangesSaved) {
        const refreshResult = await loadData({
          silent: true,
          preserveDirty: true,
          preserveTableScroll: true,
        });
        if (refreshResult?.ok !== true) {
          displayUpdateFailed = true;
          syncChrome();
          renderTable({ preserveScroll: true });
        } else if (
          state.showMissingCommentsOnly &&
          getMissingCommentSummary().count === 0
        ) {
          exitMissingCommentsFilter();
          persistUiState();
          const restoredResult = await loadData({
            silent: true,
            preserveDirty: true,
            preserveTableScroll: true,
          });
          if (restoredResult?.ok !== true) displayUpdateFailed = true;
        }
      } else {
        syncChrome();
        renderTable({ preserveScroll: true });
      }
    } catch (error) {
      displayUpdateFailed = true;
      console.error("日報の保存結果を画面に反映できませんでした。", error);
    }
  } else {
    syncChrome();
  }

  if (allSaved) {
    if (displayUpdateFailed) {
      notify({
        text: REPORT_SAVE_CACHE_WARNING,
        type: "warning",
        autoHide: false,
        source: "save",
      });
    } else {
      notify({ text: REPORT_SAVE_SUCCESS_MESSAGE, type: "success" });
    }
    return true;
  }

  if (anySaved) {
    notify({ text: REPORT_SAVE_PARTIAL_MESSAGE, type: "error" });
    if (displayUpdateFailed) {
      notify({
        text: REPORT_SAVE_CACHE_WARNING,
        type: "warning",
        autoHide: false,
        source: "save",
      });
    }
    return false;
  }

  notify({ text: REPORT_SAVE_FAILURE_MESSAGE, type: "error" });
  return false;
}

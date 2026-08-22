// Settings screen behavior and validation.
function setSettingsTab(tabName = "general") {
  const tabs = [...document.querySelectorAll("[data-settings-tab]")];
  const panels = [...document.querySelectorAll("[data-settings-panel]")];
  const activeTab = tabs.find((tab) => tab.dataset.settingsTab === tabName) || tabs[0];
  const activeName = activeTab?.dataset.settingsTab || "general";
  tabs.forEach((tab) => {
    const isActive = tab === activeTab;
    tab.classList.toggle("is-active", isActive);
    tab.setAttribute("aria-selected", String(isActive));
  });
  panels.forEach((panel) => {
    const isActive = panel.dataset.settingsPanel === activeName;
    panel.classList.toggle("hidden", !isActive);
    panel.hidden = !isActive;
  });
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
  $("includeTodayInMissingComments").checked = Boolean(
    settings.include_today_in_missing_comments,
  );
  $("commentSignature").value = settings.comment_signature || "";
  const colorTheme = normalizeColorTheme(settings.ui_color_theme);
  document
    .querySelectorAll('input[name="uiColorTheme"]')
    .forEach((input) => {
      input.checked = input.value === colorTheme;
    });
  const memberFilterLevels = normalizeMemberFilterLevels(
    settings.ui_member_filter_levels,
  );
  document
    .querySelectorAll("[data-member-filter-level]")
    .forEach((input) => {
      input.checked = memberFilterLevels.includes(input.value);
    });
  state.missingCommentStartDate = settings.missing_comment_start_date || "";
  state.includeTodayInMissingComments = Boolean(
    settings.include_today_in_missing_comments,
  );
  state.commentSignature = settings.comment_signature || "";
  updateDefaultRangePreview();
  markSettingsClean();
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

function getSettingsPayload() {
  return {
    users_dir: $("usersDir").value,
    comments_dir: $("commentsDir").value,
    common_dir: $("commonDir").value,
    default_start_offset_days: -Number($("defaultStartOffsetDays").value),
    default_end_offset_days: Number($("defaultEndOffsetDays").value),
    missing_comment_start_date: $("missingCommentStartDate").value,
    include_today_in_missing_comments: $("includeTodayInMissingComments").checked,
    comment_signature: $("commentSignature").value,
    ui_color_theme:
      document.querySelector('input[name="uiColorTheme"]:checked')?.value ||
      "light",
    ui_member_filter_levels: [
      ...document.querySelectorAll("[data-member-filter-level]:checked"),
    ].map((input) => input.value),
  };
}

function getSettingsDraftSnapshot() {
  return JSON.stringify(getSettingsPayload());
}

function isSettingsDirty() {
  return Boolean(state.settingsSnapshot) &&
    state.settingsSnapshot !== getSettingsDraftSnapshot();
}

function markSettingsClean() {
  state.settingsSnapshot = getSettingsDraftSnapshot();
  syncChrome();
}

function syncSettingsDirtyState() {
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
  const payload = getSettingsPayload();
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
    state.showMissingCommentsOnly = false;
    state.periodBeforeMissing = null;
    state.legacyLoadPreset = "";
    state.missingCommentStartDate =
      result.settings?.missing_comment_start_date || "";
    state.includeTodayInMissingComments = Boolean(
      result.settings?.include_today_in_missing_comments ??
        payload.include_today_in_missing_comments,
    );
    state.commentSignature = result.settings?.comment_signature || "";
    state.memberFilterLevels = normalizeMemberFilterLevels(
      result.settings?.ui_member_filter_levels ?? payload.ui_member_filter_levels,
    );
    applyColorTheme(result.settings?.ui_color_theme ?? payload.ui_color_theme);
    markSettingsClean();
    showSettings(false);
    await loadData();
    persistUiState();
  }
}

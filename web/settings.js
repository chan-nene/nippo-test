// Settings screen behavior and validation.
function fillSettings(settings) {
  $("usersDir").value = settings.users_dir || "";
  $("commentsDir").value = settings.comments_dir || "";
  $("commonDir").value = settings.common_dir || "";
  const startOffset = Number(settings.default_start_offset_days ?? -1);
  const endOffset = Number(settings.default_end_offset_days ?? 0);
  $("defaultStartOffsetDays").value = String(
    clampNumber(Math.abs(Math.min(0, startOffset)), 0, 5),
  );
  $("defaultEndOffsetDays").value = String(clampNumber(endOffset, 0, 5));
  $("missingCommentStartDate").value = settings.missing_comment_start_date || "";
  syncDateInputDisplay("missingCommentStartDate");
  $("includeTodayInMissingComments").checked = Boolean(
    settings.include_today_in_missing_comments,
  );
  $("commentSignature").value = settings.comment_signature || "";
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
  markSettingsClean();
}

function clampNumber(value, min, max) {
  const numericValue = Number.isFinite(value) ? value : min;
  return Math.min(max, Math.max(min, numericValue));
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
    errors.common_dir = "管理フォルダを入力してください。";
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
    // Theme selection lives in the title bar. Keep its value in the settings
    // payload so saving another setting never resets the persisted theme.
    ui_color_theme: state.colorTheme,
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

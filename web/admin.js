// Common-data workbench. Comment permissions and display order are derived from
// each team's ordered commenter list and the current team hierarchy.
(function () {
  const MASTER_DEFINITIONS = [
    {
      key: "user_master",
      label: "ユーザー管理",
      navLabel: "ユーザー",
      title: "ユーザー管理",
      file: "user_master.csv",
      navFile: "user_master.csv",
      columns: [
        { key: "employee_id", label: "社員ID", type: "text", required: true },
        { key: "display_name", label: "表示名", type: "text", required: true },
        {
          key: "can_input_own_report",
          label: "自分の日報入力",
          type: "self_report_input",
          required: true,
          defaultValue: "1",
        },
        {
          key: "employment_type",
          label: "雇用区分",
          type: "employment_type",
          required: true,
          defaultValue: "regular",
        },
        {
          key: "is_admin",
          label: "管理者",
          type: "admin_flag",
          required: false,
          defaultValue: "0",
        },
        {
          key: "small_team_id",
          label: "所属チーム",
          type: "small_team",
          required: false,
        },
        {
          key: "display_order",
          label: "表示順",
          type: "number",
          required: false,
          table: false,
        },
      ],
    },
    {
      key: "team_master",
      label: "チーム管理",
      navLabel: "チーム",
      title: "チーム階層",
      file: "team_master.csv",
      navFile: "team_master.csv",
      columns: [
        { key: "team_id", label: "チームID", type: "text", required: true },
        { key: "team_name", label: "チーム名", type: "text", required: true },
        {
          key: "team_level",
          label: "階層",
          type: "team_level",
          required: true,
          defaultValue: "small",
        },
        {
          key: "parent_team_id",
          label: "親チーム",
          type: "parent_team",
          required: false,
        },
        { key: "sort_order", label: "表示順", type: "number" },
        {
          key: "is_active",
          label: "状態",
          type: "active",
          required: true,
          defaultValue: "1",
        },
        {
          key: "commenter_employee_ids",
          label: "コメント担当者",
          type: "text",
          required: false,
          table: false,
        },
      ],
    },
    {
      key: "calendar",
      label: "カレンダー",
      navLabel: "カレンダー設定",
      title: "稼働日カレンダー",
      file: "calendar.csv",
      navFile: "calendar.csv",
      columns: [{ key: "date", label: "日付", type: "date", required: true }],
    },
  ];

  let isLoaded = false;
  let isLoading = false;
  let activeMaster = "team_master";
  let activeFiscalYear = fiscalYearForDate(new Date());
  let searchText = "";
  let nextRowId = 1;
  const drafts = new Map();
  const collapsedTeamIds = new Set();

  const byId = (id) => document.getElementById(id);
  const getDefinition = (key = activeMaster) =>
    MASTER_DEFINITIONS.find((definition) => definition.key === key);
  const getDraft = (key = activeMaster) => drafts.get(key);
  const valuesOnly = (draft) => draft.entries.map((entry) => entry.values);
  const snapshot = (rows) => JSON.stringify(rows);
  const isDraftDirty = (draft) =>
    Boolean(draft) &&
    (Boolean(draft.migrationRequired) ||
      snapshot(valuesOnly(draft)) !== draft.originalSnapshot);
  const hasEditorChanges = (key = activeMaster) => {
    if (key === "team_master") return isOrganizationAdministrationDirty();
    const draft = drafts.get(key);
    const rowsChanged =
      Boolean(draft) && snapshot(valuesOnly(draft)) !== draft.originalSnapshot;
    return rowsChanged;
  };
  const isUserAdministrationDirty = () =>
    isDraftDirty(drafts.get("user_master"));
  const isOrganizationAdministrationDirty = () =>
    isUserAdministrationDirty() || isDraftDirty(drafts.get("team_master"));
  const isDefinitionDirty = (key) =>
    key === "user_master"
      ? isUserAdministrationDirty()
      : isDraftDirty(drafts.get(key));

  function createEntry(values, definition, isNew = false) {
    const entry = {
      id: `master-row-${nextRowId++}`,
      isNew,
      values: Object.fromEntries(
        definition.columns.map((column) => [
          column.key,
          String(values?.[column.key] ?? column.defaultValue ?? ""),
        ]),
      ),
    };
    if (definition.key === "team_master") entry.values.is_active = "1";
    return entry;
  }

  function fiscalYearForDate(value) {
    const target = value instanceof Date ? value : new Date(value);
    return target.getMonth() >= 3 ? target.getFullYear() : target.getFullYear() - 1;
  }

  function calendarIsoDate(year, monthIndex, day) {
    return `${year}-${String(monthIndex + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  function calendarDateParts(dateText) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateText || ""));
    if (!match) return null;
    return {
      year: Number(match[1]),
      monthIndex: Number(match[2]) - 1,
      day: Number(match[3]),
    };
  }

  function calendarDate(dateText) {
    const parts = calendarDateParts(dateText);
    return parts
      ? new Date(Date.UTC(parts.year, parts.monthIndex, parts.day))
      : null;
  }

  function calendarDateLabel(dateText, includeYear = true) {
    const target = calendarDate(dateText);
    if (!target) return dateText || "日付未設定";
    const weekday = ["日", "月", "火", "水", "木", "金", "土"][target.getUTCDay()];
    const prefix = includeYear ? `${target.getUTCFullYear()}年` : "";
    return `${prefix}${target.getUTCMonth() + 1}月${target.getUTCDate()}日（${weekday}）`;
  }

  function fiscalYearDayCount(fiscalYear) {
    const start = Date.UTC(fiscalYear, 3, 1);
    const end = Date.UTC(fiscalYear + 1, 3, 1);
    return Math.round((end - start) / 86_400_000);
  }

  function ensureFiscalYearEntries(fiscalYear = activeFiscalYear) {
    const definition = getDefinition("calendar");
    const draft = drafts.get("calendar");
    if (!definition || !draft) return;
    const existingByDate = new Map(
      draft.entries.map((entry) => [valueFor(entry, "date"), entry]),
    );
    const end = new Date(Date.UTC(fiscalYear + 1, 2, 31));
    for (
      let cursor = new Date(Date.UTC(fiscalYear, 3, 1));
      cursor <= end;
      cursor.setUTCDate(cursor.getUTCDate() + 1)
    ) {
      const dateText = calendarIsoDate(
        cursor.getUTCFullYear(),
        cursor.getUTCMonth(),
        cursor.getUTCDate(),
      );
      if (![0, 6].includes(cursor.getUTCDay())) continue;
      if (existingByDate.has(dateText)) continue;
      const entry = createEntry(
        { date: dateText },
        definition,
        true,
      );
      draft.entries.push(entry);
      existingByDate.set(dateText, entry);
    }
    draft.entries.sort((left, right) =>
      valueFor(left, "date").localeCompare(valueFor(right, "date")),
    );
  }

  function createTeamId() {
    if (typeof crypto?.randomUUID === "function") {
      return `team_${crypto.randomUUID()}`;
    }
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return `team_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }

  function initialize() {
    byId("adminReloadButton").addEventListener("click", reload);
    byId("adminSaveButton").addEventListener("click", save);
    byId("adminAddRowButton").addEventListener("click", addRow);
    byId("adminSearchInput").addEventListener("input", (event) => {
      searchText = String(event.target.value || "").trim().toLocaleLowerCase("ja");
      renderTableHeading();
      renderTable();
    });
    byId("masterNav").addEventListener("click", (event) => {
      const button = event.target.closest("[data-master]");
      if (button) selectMaster(button.dataset.master);
    });
    byId("adminTableWrap").addEventListener("click", (event) => {
      const fiscalYearButton = event.target.closest("[data-calendar-year-action]");
      if (fiscalYearButton) {
        changeFiscalYear(fiscalYearButton.dataset.calendarYearAction);
        return;
      }
      const calendarDay = event.target.closest("[data-calendar-date]");
      if (calendarDay) {
        toggleCalendarDay(calendarDay.dataset.calendarDate);
        return;
      }
      if (event.target.closest("[data-add-team-root]")) {
        openTeamCreateDialog("large", "");
        return;
      }
      const toggle = event.target.closest("[data-team-toggle]");
      if (toggle) {
        toggleTeam(toggle.dataset.teamToggle);
        return;
      }
      const expandAction = event.target.closest("[data-team-expand-action]");
      if (expandAction) {
        setAllTeamsCollapsed(expandAction.dataset.teamExpandAction === "collapse");
        return;
      }
      const row = event.target.closest("[data-row-id]");
      if (row) selectRow(row.dataset.rowId);
    });
    byId("adminTableWrap").addEventListener("input", (event) => {
      const search = event.target.closest("[data-team-search]");
      if (!search) return;
      searchText = String(search.value || "").trim().toLocaleLowerCase("ja");
      renderTeamTree(getDraft("team_master"));
      requestAnimationFrame(() => {
        const nextSearch = byId("adminTableWrap").querySelector("[data-team-search]");
        if (!nextSearch) return;
        nextSearch.focus();
        nextSearch.setSelectionRange(searchText.length, searchText.length);
      });
    });
    byId("adminTableWrap").addEventListener("keydown", (event) => {
      if (!["Enter", " "].includes(event.key)) return;
      const row = event.target.closest("[data-row-id]");
      if (!row) return;
      event.preventDefault();
      selectRow(row.dataset.rowId);
    });
    byId("adminInspectorForm").addEventListener("input", (event) => {
      updateSelectedRow(event);
    });
    byId("adminInspectorForm").addEventListener("change", (event) => {
      const assignment = event.target.closest("[data-team-assignment-select]");
      if (assignment) {
        setTeamAssignment(
          assignment.dataset.assignmentKind,
          assignment.dataset.teamId,
          assignment.value,
          true,
        );
        return;
      }
      updateSelectedRow(event);
    });
    byId("adminInspectorForm").addEventListener("click", (event) => {
      if (event.target.closest("[data-save-editor]")) save();
      if (event.target.closest("[data-delete-row]")) void deleteSelectedRow();
      const memberMove = event.target.closest("[data-member-move]");
      if (memberMove) {
        moveSelectedMember(
          memberMove.dataset.memberId,
          memberMove.dataset.memberMove,
        );
        return;
      }
      const commenterMove = event.target.closest("[data-commenter-move]");
      if (commenterMove) {
        moveSelectedCommenter(
          commenterMove.dataset.employeeId,
          commenterMove.dataset.commenterMove,
        );
        return;
      }
      const assignmentRemove = event.target.closest("[data-team-assignment-remove]");
      if (assignmentRemove) {
        setTeamAssignment(
          assignmentRemove.dataset.assignmentKind,
          assignmentRemove.dataset.teamId,
          assignmentRemove.dataset.employeeId,
          false,
        );
        return;
      }
      const addTeamButton = event.target.closest("[data-add-child-level]");
      if (addTeamButton) {
        openTeamCreateDialog(
          addTeamButton.dataset.addChildLevel,
          addTeamButton.dataset.parentTeamId,
        );
      }
      const moveButton = event.target.closest("[data-move-team]");
      if (moveButton) moveSelectedTeam(moveButton.dataset.moveTeam);
    });
    byId("teamCreateForm").addEventListener("submit", submitTeamCreateDialog);
    byId("teamCreateLevel").addEventListener("change", () => {
      renderTeamCreateParentChoices();
    });
    byId("teamCreateParent").addEventListener("change", updateTeamCreateDialogState);
    byId("teamCreateName").addEventListener("input", updateTeamCreateDialogState);
    byId("cancelTeamCreateButton").addEventListener("click", closeTeamCreateDialog);
    byId("teamCreateDialog").addEventListener("cancel", (event) => {
      event.preventDefault();
      closeTeamCreateDialog();
    });
    byId("teamCreateDialog").addEventListener("click", (event) => {
      if (event.target === event.currentTarget) closeTeamCreateDialog();
    });
  }

  async function ensureLoaded() {
    if (isLoaded || isLoading) return;
    await load();
  }

  async function load() {
    const api = window.pywebview?.api;
    if (typeof api?.load_common_masters !== "function") {
      notify({
        text: "共通マスターの読み込み機能を利用できません。",
        type: "error",
      });
      return;
    }
    isLoading = true;
    byId("adminLoading").classList.remove("hidden");
    byId("adminWorkspace").classList.add("hidden");
    setBusy(true, "admin-load");
    try {
      const result = await api.load_common_masters();
      if (!result?.ok) {
        notify({
          text: result?.message || "共通マスターを読み込めませんでした。",
          type: "error",
        });
        return;
      }

      drafts.clear();
      collapsedTeamIds.clear();
      MASTER_DEFINITIONS.forEach((definition) => {
        const rows = Array.isArray(result.data?.[definition.key])
          ? result.data[definition.key]
          : [];
        const entries = rows.map((row) =>
          createEntry(row, definition, false),
        );
        drafts.set(definition.key, {
          entries,
          originalSnapshot: snapshot(entries.map((entry) => entry.values)),
          revision: String(result.revisions?.[definition.key] || ""),
          migrationRequired: Boolean(
            result.migration_required?.[definition.key],
          ),
          selectedId: "",
        });
      });
      if (activeMaster === "calendar") ensureFiscalYearEntries();
      isLoaded = true;
      searchText = "";
      byId("adminLoading").classList.add("hidden");
      byId("adminWorkspace").classList.remove("hidden");
      render();
    } finally {
      isLoading = false;
      setBusy(false);
      syncAdminChrome();
    }
  }

  async function reload() {
    if (hasUnsaved()) {
      const confirmed = await requestConfirmationDialog({
        title: "未保存の変更があります",
        description:
          "共通マスターを再読み込みすると、保存していない変更は失われます。",
        confirmLabel: "破棄して再読み込み",
        cancelLabel: "このまま編集を続ける",
        confirmTone: "danger",
      });
      if (!confirmed) return;
    }
    isLoaded = false;
    await load();
  }

  async function save() {
    if (!hasUnsaved()) return true;
    if (isLoading) return false;
    const api = window.pywebview?.api;
    setBusy(true, "admin-save");
    try {
      const userDraft = drafts.get("user_master");
      const teamDraft = drafts.get("team_master");
      const teamDirty = isDraftDirty(teamDraft);
      const userDirty = isDraftDirty(userDraft);
      if (teamDirty || userDirty) {
        if (typeof api?.save_user_administration !== "function") {
          throw new Error("ユーザー管理の保存機能を利用できません。");
        }
        if (teamDirty) normalizeAllTeamOrders();
        const payload = {
          users: valuesOnly(userDraft),
          revisions: {
            user_master: userDraft.revision,
          },
        };
        if (teamDirty) {
          payload.teams = valuesOnly(teamDraft);
          payload.revisions.team_master = teamDraft.revision;
        }
        const result = await api.save_user_administration(payload);
        if (!result?.ok) {
          notify({
            text:
              result?.message ||
              "ユーザー情報を保存できませんでした。入力内容を確認してください。",
            type: "error",
          });
          return false;
        }
        if (userDirty || teamDirty) {
          userDraft.originalSnapshot = snapshot(valuesOnly(userDraft));
          userDraft.migrationRequired = false;
          userDraft.revision = String(
            result.revisions?.user_master || userDraft.revision,
          );
          userDraft.entries.forEach((entry) => {
            entry.isNew = false;
          });
        }
        if (teamDirty) {
          teamDraft.originalSnapshot = snapshot(valuesOnly(teamDraft));
          teamDraft.revision = String(
            result.revisions?.team_master || teamDraft.revision,
          );
          teamDraft.entries.forEach((entry) => {
            entry.isNew = false;
          });
        }
      }

      const calendarDraft = drafts.get("calendar");
      if (isDraftDirty(calendarDraft)) {
        const result = await api.save_common_master({
          master: "calendar",
          rows: valuesOnly(calendarDraft),
          revision: calendarDraft.revision,
        });
        if (!result?.ok) {
          notify({
            text:
              result?.message ||
              "カレンダーを保存できませんでした。入力内容を確認してください。",
            type: "error",
          });
          return false;
        }
        calendarDraft.originalSnapshot = snapshot(valuesOnly(calendarDraft));
        calendarDraft.migrationRequired = false;
        calendarDraft.revision = String(
          result.revision || calendarDraft.revision,
        );
        calendarDraft.entries.forEach((entry) => {
          entry.isNew = false;
        });
      }

      notify({ text: "共通データの変更を保存しました。", type: "success" });
      return true;
    } catch (error) {
      notify({
        text:
          error?.message || "共通マスターの保存中にエラーが発生しました。",
        type: "error",
      });
      return false;
    } finally {
      setBusy(false);
      renderMasterNav();
      renderTable();
      renderInspector();
      syncAdminChrome();
    }
  }

  function selectMaster(key) {
    if (!drafts.has(key) || key === activeMaster) return;
    if (hasEditorChanges(activeMaster)) {
      notify({ text: "編集中の変更を保存してから移動してください。", type: "warning" });
      return;
    }
    activeMaster = key;
    searchText = "";
    if (activeMaster === "calendar") ensureFiscalYearEntries();
    render();
  }

  function selectRow(rowId) {
    const draft = getDraft();
    if (!draft?.entries.some((entry) => entry.id === rowId)) return;
    if (
      activeMaster !== "calendar" &&
      draft.selectedId !== rowId &&
      hasEditorChanges(activeMaster)
    ) {
      notify({ text: "現在の編集内容を保存してから別の項目を選択してください。", type: "warning" });
      return;
    }
    draft.selectedId = rowId;
    renderTable();
    renderInspector();
    syncAdminChrome();
  }

  function changeFiscalYear(direction) {
    if (![-1, 1].includes(Number(direction))) return;
    activeFiscalYear += Number(direction);
    ensureFiscalYearEntries();
    const draft = drafts.get("calendar");
    const selectedDate = valueFor(
      draft?.entries.find((entry) => entry.id === draft.selectedId),
      "date",
    );
    if (selectedDate && fiscalYearForDate(calendarDate(selectedDate)) !== activeFiscalYear) {
      draft.selectedId = "";
    }
    render();
  }

  function toggleCalendarDay(dateText) {
    const draft = drafts.get("calendar");
    const definition = getDefinition("calendar");
    if (!draft || !definition || !calendarDate(dateText)) return;
    const index = draft.entries.findIndex(
      (entry) => valueFor(entry, "date") === dateText,
    );
    if (index >= 0) {
      draft.entries.splice(index, 1);
    } else {
      draft.entries.push(createEntry({ date: dateText }, definition, true));
      draft.entries.sort((left, right) =>
        valueFor(left, "date").localeCompare(valueFor(right, "date")),
      );
    }
    draft.selectedId = "";
    renderMasterNav();
    renderTable();
    syncAdminChrome();
  }

  function toggleTeam(teamId) {
    if (collapsedTeamIds.has(teamId)) collapsedTeamIds.delete(teamId);
    else collapsedTeamIds.add(teamId);
    renderTable();
  }

  function setAllTeamsCollapsed(collapsed) {
    collapsedTeamIds.clear();
    if (collapsed) {
      const parentIds = new Set(
        (drafts.get("team_master")?.entries || [])
          .map((entry) => valueFor(entry, "parent_team_id"))
          .filter(Boolean),
      );
      parentIds.forEach((teamId) => collapsedTeamIds.add(teamId));
    }
    renderTable();
  }

  function addRow() {
    if (hasEditorChanges(activeMaster)) {
      notify({ text: "現在の編集内容を保存してから追加してください。", type: "warning" });
      return;
    }
    if (activeMaster === "team_master") {
      openTeamCreateDialog("large", "");
      return;
    }
    const definition = getDefinition();
    const draft = getDraft();
    const entry = createEntry({}, definition, true);
    draft.entries.push(entry);
    draft.selectedId = entry.id;
    searchText = "";
    render();
    requestAnimationFrame(() => {
      byId("adminInspectorForm")
        .querySelector("input:not(:disabled), select")
        ?.focus();
    });
  }

  function addTeam(level, parentTeamId = "", teamName = "") {
    const definition = getDefinition("team_master");
    const draft = drafts.get("team_master");
    if (!definition || !draft || !["large", "medium", "small"].includes(level)) return;
    if (hasEditorChanges("team_master")) {
      notify({ text: "現在の編集内容を保存してから追加してください。", type: "warning" });
      return;
    }
    const parent = draft.entries.find(
      (entry) => valueFor(entry, "team_id") === parentTeamId,
    );
    const validParent =
      level === "large"
        ? !parentTeamId
        : Boolean(parentTeamId) &&
          ((level === "medium" && valueFor(parent, "team_level") === "large") ||
            (level === "small" && ["large", "medium"].includes(valueFor(parent, "team_level"))));
    if (level === "large" && parentTeamId) return;
    if (!validParent) return;

    const entry = createEntry(
      {
        team_id: createTeamId(),
        team_name: String(teamName).trim(),
        team_level: level,
        parent_team_id: parentTeamId,
        sort_order: String(nextSiblingOrder(parentTeamId)),
        is_active: "1",
      },
      definition,
      true,
    );
    draft.entries.push(entry);
    draft.selectedId = entry.id;
    if (parentTeamId) collapsedTeamIds.delete(parentTeamId);
    searchText = "";
    render();
    requestAnimationFrame(() => {
      byId("adminInspectorForm").querySelector('[data-column="team_name"]')?.focus();
    });
  }

  function openTeamCreateDialog(level = "large", parentTeamId = "") {
    if (hasEditorChanges("team_master")) {
      notify({ text: "現在の編集内容を保存してから追加してください。", type: "warning" });
      return;
    }
    const dialog = byId("teamCreateDialog");
    const levelInput = byId("teamCreateLevel");
    levelInput.value = ["large", "medium", "small"].includes(level) ? level : "large";
    byId("teamCreateName").value = "";
    byId("teamCreateError").textContent = "";
    renderTeamCreateParentChoices(parentTeamId);
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    requestAnimationFrame(() => byId("teamCreateName").focus());
  }

  function closeTeamCreateDialog() {
    const dialog = byId("teamCreateDialog");
    if (typeof dialog.close === "function" && dialog.open) dialog.close();
    else dialog.removeAttribute("open");
    byId("teamCreateError").textContent = "";
  }

  function submitTeamCreateDialog(event) {
    event.preventDefault();
    const form = byId("teamCreateForm");
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }
    const level = byId("teamCreateLevel").value;
    const parentTeamId = byId("teamCreateParent").value;
    const teamName = byId("teamCreateName").value.trim();
    if (level !== "large" && !teamEntryFor(parentTeamId)) {
      byId("teamCreateError").textContent = "親チームを選択してください。";
      return;
    }
    closeTeamCreateDialog();
    addTeam(level, parentTeamId, teamName);
  }

  function renderTeamCreateParentChoices(preferredParentId = null) {
    const level = byId("teamCreateLevel").value;
    const parentSelect = byId("teamCreateParent");
    const currentParentId = preferredParentId ?? parentSelect.value;
    const parentLevels =
      level === "medium" ? ["large"] : level === "small" ? ["large", "medium"] : [];
    const choices =
      level === "large"
        ? [["", "組織直下"]]
        : [["", "親チームを選択してください"], ...teamParentChoices(parentLevels, "")];
    parentSelect.replaceChildren();
    choices.forEach(([value, label]) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      parentSelect.append(option);
    });
    parentSelect.value = choices.some(([value]) => value === currentParentId)
      ? currentParentId
      : "";
    parentSelect.disabled = level === "large";
    parentSelect.required = level !== "large";
    updateTeamCreateDialogState();
  }

  function updateTeamCreateDialogState() {
    const level = byId("teamCreateLevel").value;
    const parentTeamId = byId("teamCreateParent").value;
    const teamName = byId("teamCreateName").value.trim();
    const parent = teamEntryFor(parentTeamId);
    const parentLabel = parent ? `組織 ＞ ${teamPathLabel(parent)}` : "組織";
    byId("teamCreateBreadcrumb").textContent =
      `${parentLabel} ＞ ${teamName || "新しいチーム"}`;
    byId("confirmTeamCreateButton").disabled =
      !teamName || (level !== "large" && !parent);
  }

  function nextSiblingOrder(parentTeamId, excludedEntryId = "") {
    const orders = (drafts.get("team_master")?.entries || [])
      .filter(
        (entry) =>
          entry.id !== excludedEntryId &&
          valueFor(entry, "parent_team_id") === parentTeamId,
      )
      .map((entry) => Number(valueFor(entry, "sort_order")))
      .filter(Number.isFinite);
    return (orders.length ? Math.max(...orders) : 0) + 10;
  }

  function normalizeSiblingOrders(parentTeamId) {
    (drafts.get("team_master")?.entries || [])
      .filter((entry) => valueFor(entry, "parent_team_id") === parentTeamId)
      .sort(compareTeamEntries)
      .forEach((entry, index) => {
        entry.values.sort_order = String((index + 1) * 10);
      });
  }

  function normalizeAllTeamOrders() {
    const parentIds = new Set(
      (drafts.get("team_master")?.entries || []).map((entry) =>
        valueFor(entry, "parent_team_id"),
      ),
    );
    parentIds.forEach(normalizeSiblingOrders);
  }

  async function deleteSelectedRow() {
    const draft = getDraft();
    const index = draft.entries.findIndex(
      (entry) => entry.id === draft.selectedId,
    );
    if (index < 0) return;
    const entry = draft.entries[index];
    if (activeMaster === "team_master") {
      const teamId = valueFor(entry, "team_id");
      const hasChildren = draft.entries.some(
        (candidate) => valueFor(candidate, "parent_team_id") === teamId,
      );
      const hasMembers = drafts
        .get("user_master")
        ?.entries.some((user) => valueFor(user, "small_team_id") === teamId);
      const isManaged = teamCommenterIds(entry).length > 0;
      if (hasChildren || hasMembers || isManaged) {
        notify({
          text: hasChildren
            ? "下位チームが残っています。先に下位チームを移動または削除してください。"
            : hasMembers
              ? "所属ユーザーが残っています。先にユーザーの所属を変更してください。"
              : "コメント対象組織に設定されています。先にユーザー設定を変更してください。",
          type: "error",
        });
        return;
      }
    }
    const definition = getDefinition();
    const identifyingValue = valueFor(entry, definition.columns[0]?.key);
    const confirmed = await requestConfirmationDialog({
      title: "削除の確認",
      description: `「${identifyingValue || "この行"}」を削除します。削除後、変更を保存します。`,
      confirmLabel: "削除して保存",
      cancelLabel: "削除しない",
      confirmTone: "danger",
    });
    if (!confirmed) return;
    const commenterSnapshots = [];
    if (activeMaster === "user_master") {
      const employeeId = valueFor(entry, "employee_id");
      (drafts.get("team_master")?.entries || []).forEach((team) => {
        const commenterIds = teamCommenterIds(team);
        if (!commenterIds.includes(employeeId)) return;
        commenterSnapshots.push([team, valueFor(team, "commenter_employee_ids")]);
        team.values.commenter_employee_ids = commenterIds
          .filter((commenterId) => commenterId !== employeeId)
          .join(";");
      });
    }
    draft.entries.splice(index, 1);
    draft.selectedId = "";
    render();
    const saved = await save();
    if (!saved) {
      draft.entries.splice(index, 0, entry);
      commenterSnapshots.forEach(([team, value]) => {
        team.values.commenter_employee_ids = value;
      });
      draft.selectedId = entry.id;
      render();
    }
  }

  function updateSelectedRow(event) {
    const input = event.target.closest("[data-column]");
    if (!input) return;
    const draft = getDraft();
    const entry = draft.entries.find((item) => item.id === draft.selectedId);
    if (!entry) return;
    const previousValue = entry.values[input.dataset.column];
    const nextValue =
      input.type === "checkbox" ? (input.checked ? "1" : "0") : input.value;
    if (
      event.type === "change" &&
      input.tagName === "INPUT" &&
      previousValue === nextValue
    ) {
      return;
    }
    if (
      input.dataset.column === "small_team_id" &&
      previousValue !== nextValue
    ) {
      setUserTeamAssignment(entry, nextValue);
    } else {
      entry.values[input.dataset.column] = nextValue;
    }
    if (input.dataset.column === "employment_type" && nextValue === "temporary") {
      entry.values.is_admin = "0";
    }
    if (input.dataset.column === "team_level") {
      entry.values.parent_team_id = "";
    }
    if (
      activeMaster === "team_master" &&
      input.dataset.column === "parent_team_id" &&
      previousValue !== nextValue
    ) {
      entry.values.sort_order = String(nextSiblingOrder(nextValue, entry.id));
      normalizeSiblingOrders(previousValue);
      normalizeSiblingOrders(nextValue);
    }
    const isInvalid = input.required && !nextValue.trim();
    input.classList.toggle("is-invalid", isInvalid);
    input.setAttribute("aria-invalid", String(isInvalid));
    renderMasterNav();
    renderTable();
    if (
      event.type === "change" &&
      ((input.dataset.column === "employee_id" && entry.isNew) ||
        input.dataset.column === "employment_type" ||
        input.dataset.column === "team_level" ||
        input.dataset.column === "parent_team_id")
    ) {
      renderInspector();
    }
    syncAdminChrome();
  }

  function getSelectedUser() {
    const draft = drafts.get("user_master");
    return draft?.entries.find((entry) => entry.id === draft.selectedId);
  }

  function render() {
    byId("adminWorkspace").classList.toggle(
      "is-user-master",
      activeMaster === "user_master",
    );
    byId("adminWorkspace").classList.toggle(
      "is-team-master",
      activeMaster === "team_master",
    );
    byId("adminWorkspace").classList.toggle(
      "is-calendar-master",
      activeMaster === "calendar",
    );
    byId("masterInspector").hidden = activeMaster === "calendar";
    renderMasterNav();
    renderTableHeading();
    renderTable();
    renderInspector();
    syncAdminChrome();
  }

  function renderMasterNav() {
    const navigation = byId("masterNav");
    navigation.replaceChildren();
    MASTER_DEFINITIONS.forEach((definition) => {
      const draft = drafts.get(definition.key);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "master-nav-button";
      button.dataset.master = definition.key;
      button.id = `master-tab-${definition.key}`;
      button.setAttribute("role", "tab");
      button.setAttribute("aria-controls", "adminWorkspace");
      const isActive = definition.key === activeMaster;
      button.classList.toggle("is-active", isActive);
      button.classList.toggle(
        "is-dirty",
        isDefinitionDirty(definition.key),
      );
      button.setAttribute("aria-selected", String(isActive));

      const copy = document.createElement("span");
      copy.className = "master-nav-copy";
      const title = document.createElement("strong");
      title.textContent = definition.navLabel || definition.label;
      copy.append(title);
      button.append(copy);
      navigation.append(button);
    });
    byId("adminWorkspace").setAttribute(
      "aria-labelledby",
      `master-tab-${activeMaster}`,
    );
  }

  function renderTableHeading() {
    const definition = getDefinition();
    const draft = getDraft();
    const addButton = byId("adminAddRowButton");
    const title = byId("adminTableTitle");
    const count = byId("adminTableCount");
    const searchControl = byId("adminSearchControl");
    const searchInput = byId("adminSearchInput");
    const isTeam = definition.key === "team_master";
    addButton.setAttribute(
      "aria-expanded",
      "false",
    );
    addButton.lastChild.textContent =
      definition.key === "user_master"
        ? "ユーザーを追加"
        : definition.key === "team_master"
          ? "チームを追加"
          : "日付を追加";
    title.textContent =
      definition.key === "user_master"
        ? "ユーザー"
        : definition.key === "team_master"
          ? "チーム"
          : `${activeFiscalYear}年度カレンダー`;
    count.textContent =
      definition.key === "user_master"
        ? `${draft.entries.length}人`
        : definition.key === "team_master"
          ? `${draft.entries.length}チーム`
          : `${fiscalYearDayCount(activeFiscalYear)}日`;
    addButton.hidden = isTeam || definition.key === "calendar";
    searchControl.hidden = isTeam || definition.key === "calendar";
    searchInput.placeholder =
      definition.key === "team_master"
        ? "チームを検索"
        : definition.key === "user_master"
          ? "ユーザーを検索"
          : "日付を検索";
    searchInput.value = searchText;
  }

  function filteredEntries() {
    const draft = getDraft();
    if (!searchText) return draft.entries;
    return draft.entries.filter((entry) =>
      Object.values(entry.values).some((value) =>
        String(value).toLocaleLowerCase("ja").includes(searchText),
      ),
    );
  }

  function renderTable() {
    const draft = getDraft();
    if (activeMaster === "team_master") {
      renderTeamTree(draft);
      return;
    }
    if (activeMaster === "calendar") {
      renderCalendarList(draft);
      return;
    }
    renderUserList(draft);
  }

  function renderUserList(draft) {
    const entries = filteredEntries();
    const wrap = byId("adminTableWrap");
    wrap.replaceChildren();
    if (!entries.length) {
      const empty = document.createElement("div");
      empty.className = "admin-table-empty";
      empty.textContent = searchText
        ? "検索条件に一致するユーザーがいません。"
        : "ユーザーがいません。";
      wrap.append(empty);
      return;
    }

    const table = document.createElement("table");
    table.className = "organization-user-table";
    const head = document.createElement("thead");
    const headerRow = document.createElement("tr");
    [
      "ユーザー",
      "雇用区分",
      "管理者",
      "自分の日報",
      "所属チーム",
      "コメント対象",
    ].forEach((label) => {
      const th = document.createElement("th");
      th.scope = "col";
      th.textContent = label;
      headerRow.append(th);
    });
    head.append(headerRow);
    const body = document.createElement("tbody");
    entries.forEach((entry) => {
      const row = document.createElement("tr");
      row.tabIndex = 0;
      row.dataset.rowId = entry.id;
      row.classList.toggle("is-selected", entry.id === draft.selectedId);
      row.setAttribute("aria-selected", String(entry.id === draft.selectedId));
      const name = document.createElement("td");
      name.textContent = valueFor(entry, "display_name") || valueFor(entry, "employee_id") || "—";
      const employment = document.createElement("td");
      employment.textContent = employmentTypeLabel(valueFor(entry, "employment_type"));
      const administrator = document.createElement("td");
      administrator.textContent = valueFor(entry, "is_admin") === "1" ? "管理者" : "—";
      const ownReport = document.createElement("td");
      ownReport.textContent = valueFor(entry, "can_input_own_report") === "0"
        ? "入力しない"
        : "入力する";
      const team = document.createElement("td");
      team.textContent = teamNameFor(valueFor(entry, "small_team_id")) || "—";
      const managed = document.createElement("td");
      managed.textContent = commenterTeamIdsForUser(valueFor(entry, "employee_id"))
        .map((teamId) => teamNameFor(teamId))
        .filter(Boolean)
        .join("、") || "—";
      row.append(name, employment, administrator, ownReport, team, managed);
      body.append(row);
    });
    table.append(head, body);
    wrap.append(table);
  }

  function renderCalendarList(draft) {
    const wrap = byId("adminTableWrap");
    wrap.replaceChildren();
    const fiscalEntries = draft.entries.filter((entry) => {
      const target = calendarDate(valueFor(entry, "date"));
      return target && fiscalYearForDate(target) === activeFiscalYear;
    });
    const entriesByDate = new Map(
      fiscalEntries.map((entry) => [valueFor(entry, "date"), entry]),
    );
    const holidayCount = fiscalEntries.length;

    const toolbar = document.createElement("div");
    toolbar.className = "fiscal-calendar-toolbar";
    const yearNavigation = document.createElement("div");
    yearNavigation.className = "fiscal-year-navigation";
    const previous = createFiscalYearButton(-1, "前年度を表示", "‹");
    const year = document.createElement("strong");
    year.className = "fiscal-year-label";
    year.textContent = `${activeFiscalYear}年度`;
    year.setAttribute("aria-live", "polite");
    const next = createFiscalYearButton(1, "次年度を表示", "›");
    yearNavigation.append(previous, year, next);

    const legend = document.createElement("div");
    legend.className = "fiscal-calendar-legend";
    const holidayLegend = document.createElement("span");
    holidayLegend.className = "calendar-legend-item";
    holidayLegend.innerHTML = '<i class="calendar-holiday-swatch" aria-hidden="true"></i>休日';
    const workdayLegend = document.createElement("span");
    workdayLegend.className = "calendar-legend-item";
    workdayLegend.innerHTML = '<i class="calendar-workday-swatch" aria-hidden="true"></i>土日の稼働日';
    const summary = document.createElement("span");
    summary.className = "fiscal-calendar-summary";
    summary.textContent = `休日 ${holidayCount}日`;
    legend.append(holidayLegend, workdayLegend, summary);
    toolbar.append(yearNavigation, legend);

    const calendar = document.createElement("div");
    calendar.className = "fiscal-calendar-grid";
    for (let offset = 0; offset < 12; offset += 1) {
      const absoluteMonth = 3 + offset;
      const calendarYear = activeFiscalYear + Math.floor(absoluteMonth / 12);
      const monthIndex = absoluteMonth % 12;
      calendar.append(
        createCalendarMonth(calendarYear, monthIndex, entriesByDate),
      );
    }
    wrap.append(toolbar, calendar);
  }

  function createFiscalYearButton(direction, label, text) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "fiscal-year-button";
    button.dataset.calendarYearAction = String(direction);
    button.setAttribute("aria-label", label);
    button.textContent = text;
    return button;
  }

  function createCalendarMonth(year, monthIndex, entriesByDate) {
    const month = document.createElement("section");
    month.className = "fiscal-calendar-month";
    month.setAttribute("aria-label", `${year}年${monthIndex + 1}月`);
    const heading = document.createElement("h4");
    heading.textContent = `${monthIndex + 1}月`;
    const weekdays = document.createElement("div");
    weekdays.className = "fiscal-calendar-weekdays";
    ["日", "月", "火", "水", "木", "金", "土"].forEach((label, index) => {
      const weekday = document.createElement("span");
      weekday.textContent = label;
      weekday.classList.toggle("is-sunday", index === 0);
      weekday.classList.toggle("is-saturday", index === 6);
      weekdays.append(weekday);
    });
    const days = document.createElement("div");
    days.className = "fiscal-calendar-days";
    const firstWeekday = new Date(Date.UTC(year, monthIndex, 1)).getUTCDay();
    const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
    for (let index = 0; index < firstWeekday; index += 1) {
      const empty = document.createElement("span");
      empty.className = "fiscal-calendar-day-empty";
      empty.setAttribute("aria-hidden", "true");
      days.append(empty);
    }
    for (let day = 1; day <= lastDay; day += 1) {
      const dateText = calendarIsoDate(year, monthIndex, day);
      const entry = entriesByDate.get(dateText);
      const weekday = new Date(Date.UTC(year, monthIndex, day)).getUTCDay();
      const isWeekend = [0, 6].includes(weekday);
      const isHoliday = Boolean(entry);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "fiscal-calendar-day";
      button.dataset.calendarDate = dateText;
      button.classList.toggle("is-holiday", isHoliday);
      button.classList.toggle("is-weekend-workday", isWeekend && !isHoliday);
      button.setAttribute("aria-pressed", String(isHoliday));
      button.setAttribute(
        "aria-label",
        `${calendarDateLabel(dateText)}、${isHoliday ? "休日" : "稼働日"}。押すと${isHoliday ? "稼働日" : "休日"}に変更`,
      );
      const number = document.createElement("span");
      number.textContent = String(day);
      button.append(number);
      days.append(button);
    }
    month.append(heading, weekdays, days);
    return month;
  }

  function renderTeamTree(draft) {
    const wrap = byId("adminTableWrap");
    wrap.replaceChildren();
    const entries = draft.entries;
    const browser = document.createElement("section");
    browser.className = "team-browser";
    browser.setAttribute("aria-label", "チーム一覧");
    const heading = document.createElement("div");
    heading.className = "team-browser-heading";
    const title = document.createElement("h2");
    title.textContent = "チーム";
    const count = document.createElement("span");
    count.className = "team-browser-count";
    count.textContent = `${entries.length}チーム`;
    heading.append(title, count);

    const search = document.createElement("input");
    search.type = "search";
    search.className = "team-browser-search";
    search.dataset.teamSearch = "true";
    search.value = searchText;
    search.placeholder = "チームを検索";
    search.setAttribute("aria-label", "チームを検索");

    const tree = document.createElement("div");
    tree.className = "team-tree";
    tree.setAttribute("role", "tree");
    const children = new Map();
    entries.forEach((entry) => {
      const parentId = valueFor(entry, "parent_team_id");
      if (!children.has(parentId)) children.set(parentId, []);
      children.get(parentId).push(entry);
    });
    children.forEach((items) => items.sort(compareTeamEntries));
    const visibleIds = visibleTeamIds(entries);
    const roots = (children.get("") || []).filter((entry) => visibleIds.has(valueFor(entry, "team_id")));
    roots.forEach((entry) => {
      appendTeamBrowserItem(tree, entry, children, visibleIds, draft, 0);
    });
    if (!tree.childElementCount) {
      const empty = document.createElement("div");
      empty.className = "admin-table-empty team-browser-empty";
      empty.textContent = entries.length
        ? "検索条件に一致するチームがありません。"
        : "チームがありません。";
      tree.append(empty);
    }

    const addButton = document.createElement("button");
    addButton.type = "button";
    addButton.className = "team-browser-add";
    addButton.dataset.addTeamRoot = "true";
    addButton.textContent = "＋ チームを追加";
    browser.append(heading, search, tree, addButton);
    wrap.append(browser);
  }

  function appendTeamBrowserItem(container, entry, children, visibleIds, draft, depth) {
    const teamId = valueFor(entry, "team_id");
    if (!visibleIds.has(teamId)) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "team-item";
    button.dataset.rowId = entry.id;
    button.style.setProperty("--team-depth", String(depth));
    button.classList.toggle("is-active", entry.id === draft.selectedId);
    button.setAttribute("aria-selected", String(entry.id === draft.selectedId));
    const mark = document.createElement("span");
    mark.className = "team-mark";
    const name = document.createElement("span");
    name.className = "team-name";
    name.textContent = valueFor(entry, "team_name") || "名称未設定";
    const count = document.createElement("span");
    count.className = "team-count";
    count.textContent = String(teamMemberCountFor(teamId));
    button.append(mark, name, count);
    container.append(button);
    (children.get(teamId) || [])
      .filter((child) => visibleIds.has(valueFor(child, "team_id")))
      .forEach((child) => {
        appendTeamBrowserItem(container, child, children, visibleIds, draft, depth + 1);
      });
  }

  function visibleTeamIds(entries) {
    const allIds = new Set(entries.map((entry) => valueFor(entry, "team_id")));
    if (!searchText) return allIds;
    const byId = new Map(
      entries.map((entry) => [valueFor(entry, "team_id"), entry]),
    );
    const visibleIds = new Set();
    entries.forEach((entry) => {
      const name = valueFor(entry, "team_name").toLocaleLowerCase("ja");
      const path = teamPathLabel(entry).toLocaleLowerCase("ja");
      if (!name.includes(searchText) && !path.includes(searchText)) return;
      let current = entry;
      const visited = new Set();
      while (current) {
        const teamId = valueFor(current, "team_id");
        if (visited.has(teamId)) break;
        visited.add(teamId);
        visibleIds.add(teamId);
        current = byId.get(valueFor(current, "parent_team_id"));
      }
    });
    return visibleIds;
  }

  function createTeamDisplayNumbers(paths) {
    const sortOrders = paths.map((path) => {
      const entry = [...path].reverse().find(Boolean);
      const sortOrder = valueFor(entry, "sort_order");
      return /^\d+$/.test(sortOrder) ? sortOrder : "";
    });
    const canUseSortOrders =
      sortOrders.every(Boolean) && new Set(sortOrders).size === sortOrders.length;
    return sortOrders.map((sortOrder, index) =>
      canUseSortOrders ? sortOrder : String(index + 1),
    );
  }

  function countTeamPathRowSpan(paths, startIndex, columnIndex, entry) {
    const teamId = valueFor(entry, "team_id");
    let rowSpan = 1;
    for (let index = startIndex + 1; index < paths.length; index += 1) {
      if (valueFor(paths[index][columnIndex], "team_id") !== teamId) break;
      rowSpan += 1;
    }
    return rowSpan;
  }

  function createTeamTablePaths(entries) {
    const children = new Map();
    entries.forEach((entry) => {
      const parentId = valueFor(entry, "parent_team_id");
      if (!children.has(parentId)) children.set(parentId, []);
      children.get(parentId).push(entry);
    });
    children.forEach((items) => items.sort(compareTeamEntries));
    const paths = [];
    (children.get("") || [])
      .filter((entry) => valueFor(entry, "team_level") === "large")
      .forEach((section) => {
        const units = (children.get(valueFor(section, "team_id")) || [])
          .filter((entry) => valueFor(entry, "team_level") === "medium");
        if (!units.length) paths.push([section, null, null]);
        units.forEach((unit) => {
          const teams = (children.get(valueFor(unit, "team_id")) || [])
            .filter((entry) => valueFor(entry, "team_level") === "small");
          if (!teams.length) paths.push([section, unit, null]);
          else teams.forEach((team) => paths.push([section, unit, team]));
        });
      });
    return paths;
  }

  function createTeamTreeNode(entry, children, visibleIds, draft, depth) {
    const teamId = valueFor(entry, "team_id");
    if (!visibleIds.has(teamId)) return null;
    const branch = document.createElement("div");
    branch.className = "team-tree-branch";
    branch.setAttribute("role", "treeitem");
    branch.setAttribute("aria-level", String(depth));

    const row = document.createElement("div");
    row.className = "team-tree-row";
    row.classList.toggle("is-selected", entry.id === draft.selectedId);

    const childEntries = (children.get(teamId) || []).filter((child) =>
      visibleIds.has(valueFor(child, "team_id")),
    );
    if (childEntries.length) {
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "team-tree-toggle";
      toggle.dataset.teamToggle = teamId;
      const isCollapsed = !searchText && collapsedTeamIds.has(teamId);
      toggle.setAttribute("aria-expanded", String(!isCollapsed));
      toggle.setAttribute("aria-label", `${valueFor(entry, "team_name")}の配下を${isCollapsed ? "開く" : "閉じる"}`);
      toggle.classList.toggle("is-collapsed", isCollapsed);
      toggle.append(createTeamSvgIcon("m5 8 7 7 7-7"));
      row.append(toggle);
    } else {
      const spacer = document.createElement("span");
      spacer.className = "team-tree-toggle-spacer";
      row.append(spacer);
    }

    const select = document.createElement("button");
    select.type = "button";
    select.className = "team-tree-select";
    select.dataset.rowId = entry.id;
    select.setAttribute("aria-selected", String(entry.id === draft.selectedId));
    const name = document.createElement("strong");
    name.textContent = valueFor(entry, "team_name") || "名称未設定";
    const metadata = document.createElement("span");
    const level = document.createElement("span");
    level.className = `team-level-label is-${valueFor(entry, "team_level")}`;
    level.textContent = teamLevelLabel(valueFor(entry, "team_level"));
    metadata.append(level);
    if (entry.isNew) {
      const unsaved = document.createElement("span");
      unsaved.className = "team-unsaved-label";
      unsaved.textContent = "未保存";
      metadata.append(unsaved);
    }
    const memberCount = document.createElement("span");
    memberCount.className = "team-member-count";
    memberCount.textContent = String(teamMemberCountFor(teamId));
    select.append(name, metadata);
    select.append(memberCount);
    row.append(select);
    branch.append(row);

    if (childEntries.length && (searchText || !collapsedTeamIds.has(teamId))) {
      const group = document.createElement("div");
      group.className = "team-tree-children";
      group.setAttribute("role", "group");
      childEntries.forEach((child) => {
        const childNode = createTeamTreeNode(child, children, visibleIds, draft, depth + 1);
        if (childNode) group.append(childNode);
      });
      branch.append(group);
    }
    return branch;
  }

  function compareTeamEntries(left, right) {
    const leftOrder = Number(valueFor(left, "sort_order") || 999999);
    const rightOrder = Number(valueFor(right, "sort_order") || 999999);
    return leftOrder - rightOrder || valueFor(left, "team_name").localeCompare(
      valueFor(right, "team_name"),
      "ja",
    );
  }

  function createTeamSvgIcon(pathData) {
    const namespace = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(namespace, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(namespace, "path");
    path.setAttribute("d", pathData);
    svg.append(path);
    return svg;
  }

  function valueFor(entry, key) {
    return String(entry?.values?.[key] || "");
  }

  function employmentTypeLabel(value) {
    return value === "temporary" ? "派遣社員" : "正社員";
  }

  function teamLevelLabel(level) {
    return { large: "課", medium: "係", small: "チーム" }[level] || level || "—";
  }

  function teamNameFor(teamId) {
    if (!teamId) return "";
    const entry = drafts
      .get("team_master")
      ?.entries.find((item) => valueFor(item, "team_id") === teamId);
    return valueFor(entry, "team_name") || teamId;
  }

  function teamCommenterIds(entry) {
    return valueFor(entry, "commenter_employee_ids")
      .split(";")
      .map((employeeId) => employeeId.trim())
      .filter(Boolean);
  }

  function commenterTeamIdsForUser(employeeId) {
    return (drafts.get("team_master")?.entries || [])
      .filter((team) => teamCommenterIds(team).includes(employeeId))
      .sort(compareTeamPathOrder)
      .map((team) => valueFor(team, "team_id"));
  }

  function descendantTeamIds(rootIds) {
    const entries = drafts.get("team_master")?.entries || [];
    const covered = new Set(rootIds);
    const pending = [...rootIds];
    while (pending.length) {
      const parentId = pending.pop();
      entries
        .filter((entry) => valueFor(entry, "parent_team_id") === parentId)
        .forEach((entry) => {
          const childId = valueFor(entry, "team_id");
          if (!covered.has(childId)) {
            covered.add(childId);
            pending.push(childId);
          }
        });
    }
    return covered;
  }

  function countSubordinates(supervisor) {
    const covered = descendantTeamIds(
      commenterTeamIdsForUser(valueFor(supervisor, "employee_id")),
    );
    return (drafts.get("user_master")?.entries || []).filter(
      (entry) =>
        entry.id !== supervisor.id && covered.has(valueFor(entry, "small_team_id")),
    ).length;
  }

  function renderInspector() {
    if (activeMaster === "calendar") return;
    const draft = getDraft();
    const entry = draft.entries.find((item) => item.id === draft.selectedId);
    const empty = byId("adminInspectorEmpty");
    const form = byId("adminInspectorForm");
    empty.classList.toggle("hidden", Boolean(entry));
    form.classList.toggle("hidden", !entry);
    form.replaceChildren();
    if (!entry) {
      const title = empty.querySelector("h3");
      const description = empty.querySelector("p");
      if (title) title.textContent = activeMaster === "calendar" ? "日付を選択" : "行を選択";
      if (description) {
        description.textContent =
          activeMaster === "calendar"
            ? "カレンダーの日付を押すと、休日と稼働日が切り替わります。"
            : "一覧から編集する行を選んでください。";
      }
      return;
    }

    if (activeMaster === "user_master") {
      renderUserInspector(form, entry);
    } else if (activeMaster === "team_master") {
      renderTeamInspector(form, entry);
    } else {
      renderGenericInspector(form, entry);
    }
  }

  function renderTeamInspector(form, entry) {
    const teamId = valueFor(entry, "team_id");
    const level = valueFor(entry, "team_level");
    const header = createTeamInspectorHeader(entry);
    const basicSection = document.createElement("section");
    basicSection.className = "team-settings-fields";
    const fields = document.createElement("div");
    fields.className = "inspector-fields team-editor-fields";
    fields.append(...createTeamEditorFields(entry));
    basicSection.append(fields);

    const actions = document.createElement("div");
    actions.className = "team-arrange-actions team-editor-actions";
    const childActions = document.createElement("div");
    childActions.className = "team-child-actions";
    if (level === "large") {
      childActions.append(
        createChildTeamButton("medium", teamId, "係を追加"),
      );
    } else if (level === "medium") {
      childActions.append(createChildTeamButton("small", teamId, "チームを追加"));
    }
    if (childActions.childElementCount) actions.append(childActions);

    const moveAvailability = teamMoveAvailability(entry);
    if (moveAvailability.up || moveAvailability.down) {
      const orderRow = document.createElement("div");
      orderRow.className = "team-order-row";
      const orderLabel = document.createElement("span");
      orderLabel.textContent = "並び順";
      orderRow.append(orderLabel);
      const orderButtons = document.createElement("div");
      orderButtons.className = "team-order-buttons";
      [
        ["up", "上へ移動", "M7 15l5-5 5 5"],
        ["down", "下へ移動", "M7 9l5 5 5-5"],
      ].forEach(([direction, label, pathData]) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "team-order-button";
        button.dataset.moveTeam = direction;
        button.setAttribute("aria-label", label);
        button.title = label;
        button.append(createTeamSvgIcon(pathData));
        button.disabled = !moveAvailability[direction];
        orderButtons.append(button);
      });
      orderRow.append(orderButtons);
      actions.append(orderRow);
    }

    const assignmentGrid = document.createElement("div");
    assignmentGrid.className = "team-assignment-grid";
    assignmentGrid.append(
      renderTeamAssignmentCard(teamId, "member"),
      renderTeamAssignmentCard(teamId, "commenter"),
    );

    const settings = document.createElement("details");
    settings.className = "team-settings";
    const settingsSummary = document.createElement("summary");
    settingsSummary.textContent = "チーム情報を編集";
    const settingsBody = document.createElement("div");
    settingsBody.className = "team-settings-body";
    settingsBody.append(
      basicSection,
      actions,
      createDeleteActionBar(createDeleteButton("このチームを削除")),
    );
    settings.append(settingsSummary, settingsBody);
    form.append(header, assignmentGrid, settings);
  }

  function createTeamInspectorHeader(entry) {
    const header = document.createElement("div");
    header.className = "team-inspector-header";
    const breadcrumb = document.createElement("div");
    breadcrumb.className = "team-inspector-breadcrumb";
    breadcrumb.textContent = `組織 ＞ ${teamPathLabel(entry)}`;
    const detail = document.createElement("div");
    detail.className = "team-inspector-title-row";
    const copy = document.createElement("div");
    const title = document.createElement("h3");
    title.textContent = valueFor(entry, "team_name") || "名称未設定";
    const description = document.createElement("p");
    description.textContent = "チーム情報と、ユーザーの所属・コメント担当をここから変更できます。";
    copy.append(title, description);
    const status = document.createElement("span");
    status.className = "team-status";
    status.classList.toggle("is-inactive", valueFor(entry, "is_active") !== "1");
    status.textContent = valueFor(entry, "is_active") === "1" ? "有効" : "廃止";
    detail.append(copy, status);
    header.append(breadcrumb, detail);
    return header;
  }

  function renderTeamAssignmentCard(teamId, kind) {
    const isMember = kind === "member";
    const currentEntries = isMember
      ? teamMemberEntries(teamId)
      : teamCommenterEntries(teamId);
    const card = document.createElement("section");
    card.className = "team-assignment-card assignment-card";
    const heading = document.createElement("div");
    heading.className = "section-heading";
    const title = document.createElement("h3");
    title.textContent = isMember ? "所属ユーザー" : "コメント担当ユーザー";
    const count = document.createElement("span");
    count.className = "team-assignment-count count";
    count.textContent = `${currentEntries.length}人`;
    heading.append(title, count);
    const description = document.createElement("p");
    description.textContent = isMember
      ? "このチームを現在の所属先としているユーザーです。追加・解除するとユーザー側の所属チームも更新されます。"
      : "この組織と下位組織の日報にコメントできるユーザーです。上下ボタンの順でコメント欄に表示されます。";

    const list = document.createElement("div");
    list.className = "team-member-list member-list";
    if (!currentEntries.length) {
      const empty = document.createElement("p");
      empty.className = "team-assignment-empty";
      empty.textContent = isMember
        ? "所属ユーザーはまだいません。"
        : "コメント担当ユーザーはまだいません。";
      list.append(empty);
    } else {
      let previousAssignedTeamId = "";
      currentEntries.forEach((user) => {
        const employeeId = valueFor(user, "employee_id");
        const assignedTeamId = valueFor(user, "small_team_id");
        if (isMember && assignedTeamId !== previousAssignedTeamId) {
          const groupHeading = document.createElement("div");
          groupHeading.className = "team-member-group-heading";
          groupHeading.textContent =
            teamPathLabel(teamEntryFor(assignedTeamId)) ||
            teamNameFor(assignedTeamId) ||
            "所属なし";
          list.append(groupHeading);
          previousAssignedTeamId = assignedTeamId;
        }
        const row = document.createElement("div");
        row.className = "team-member-row member-row";
        const avatar = document.createElement("span");
        avatar.className = "team-member-avatar avatar";
        avatar.textContent = (valueFor(user, "display_name") || employeeId || "?").trim().slice(0, 1);
        const meta = document.createElement("span");
        meta.className = "team-member-meta member-meta";
        const name = document.createElement("strong");
        name.className = "member-name";
        name.textContent = displayNameFor(employeeId);
        const role = document.createElement("small");
        role.className = "member-role";
        role.textContent = isMember
          ? "メンバー"
          : "コメント担当";
        meta.append(name, role);
        const orderControls = document.createElement("span");
        orderControls.className = "team-member-order-controls";
        {
          const availability = isMember
            ? memberMoveAvailability(user)
            : commenterMoveAvailability(teamId, employeeId);
          [
            ["up", "上へ", "M7 15l5-5 5 5"],
            ["down", "下へ", "M7 9l5 5 5-5"],
          ].forEach(([direction, label, pathData]) => {
            const move = document.createElement("button");
            move.type = "button";
            move.className = "team-member-order-button";
            if (isMember) {
              move.dataset.memberMove = direction;
              move.dataset.memberId = employeeId;
            } else {
              move.dataset.commenterMove = direction;
              move.dataset.employeeId = employeeId;
            }
            move.disabled = !availability[direction];
            move.title = label;
            move.setAttribute("aria-label", `${displayNameFor(employeeId)}を${label}`);
            move.append(createTeamSvgIcon(pathData));
            orderControls.append(move);
          });
        }
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "team-assignment-remove remove";
        remove.dataset.teamAssignmentRemove = "true";
        remove.dataset.assignmentKind = kind;
        remove.dataset.teamId = isMember
          ? valueFor(user, "small_team_id")
          : teamId;
        remove.dataset.employeeId = employeeId;
        remove.textContent = "解除";
        row.append(avatar, meta);
        row.append(orderControls);
        row.append(remove);
        list.append(row);
      });
    }

    const picker = document.createElement("details");
    picker.className = "team-assignment-picker";
    const pickerSummary = document.createElement("summary");
    pickerSummary.className = "add-link";
    pickerSummary.textContent = isMember
      ? "＋ 所属ユーザーを変更"
      : "＋ コメント担当を変更";
    const select = document.createElement("select");
    select.dataset.teamAssignmentSelect = "true";
    select.dataset.assignmentKind = kind;
    select.dataset.teamId = teamId;
    const canAssignMembers = !isMember || isAssignableTeam(teamId);
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = !canAssignMembers
      ? "所属先の課・係・チームから変更してください"
      : isMember
        ? "ユーザーを追加…"
        : "担当者を追加…";
    select.append(placeholder);
    const currentIds = new Set(currentEntries.map((user) => valueFor(user, "employee_id")));
    const candidates = userEntriesForAssignment()
      .filter((user) => {
        const employeeId = valueFor(user, "employee_id");
        if (!employeeId || currentIds.has(employeeId)) return false;
        return isMember || valueFor(user, "employment_type") !== "temporary";
      })
      .sort(compareUserEntries);
    candidates.forEach((user) => {
      const option = document.createElement("option");
      const employeeId = valueFor(user, "employee_id");
      option.value = employeeId;
      option.textContent = isMember
        ? `${displayNameFor(employeeId)}${valueFor(user, "small_team_id") ? `（現在: ${teamNameFor(valueFor(user, "small_team_id")) || "所属あり"}）` : ""}`
        : displayNameFor(employeeId);
      select.append(option);
    });
    select.disabled = !candidates.length || !canAssignMembers;
    picker.classList.toggle("is-disabled", select.disabled);
    picker.append(pickerSummary, select);
    card.append(heading, description, list, picker);
    return card;
  }

  function userEntriesForAssignment() {
    return drafts.get("user_master")?.entries || [];
  }

  function compareUserEntries(left, right) {
    const leftOrder = Number(valueFor(left, "display_order") || 999999);
    const rightOrder = Number(valueFor(right, "display_order") || 999999);
    return leftOrder - rightOrder || displayNameFor(valueFor(left, "employee_id")).localeCompare(
      displayNameFor(valueFor(right, "employee_id")),
      "ja",
    ) || valueFor(left, "employee_id").localeCompare(
      valueFor(right, "employee_id"),
      "ja",
    );
  }

  function teamPathEntries(teamId) {
    const path = [];
    let current = teamEntryFor(teamId);
    const visited = new Set();
    while (current) {
      const currentId = valueFor(current, "team_id");
      if (!currentId || visited.has(currentId)) break;
      visited.add(currentId);
      path.unshift(current);
      current = teamEntryFor(valueFor(current, "parent_team_id"));
    }
    return path;
  }

  function compareTeamPaths(leftTeamId, rightTeamId) {
    const leftPath = teamPathEntries(leftTeamId);
    const rightPath = teamPathEntries(rightTeamId);
    for (let index = 0; index < Math.min(leftPath.length, rightPath.length); index += 1) {
      const difference = compareTeamEntries(leftPath[index], rightPath[index]);
      if (difference) return difference;
    }
    if (leftPath.length !== rightPath.length) {
      if (!leftPath.length) return 1;
      if (!rightPath.length) return -1;
      return leftPath.length - rightPath.length;
    }
    return 0;
  }

  function compareTeamScopedUsers(left, right) {
    return compareTeamPaths(
      valueFor(left, "small_team_id"),
      valueFor(right, "small_team_id"),
    ) || compareUserEntries(left, right);
  }

  function teamMemberEntries(teamId) {
    const scopeIds = descendantTeamIds([teamId]);
    return userEntriesForAssignment()
      .filter((entry) => scopeIds.has(valueFor(entry, "small_team_id")))
      .sort(compareTeamScopedUsers);
  }

  function teamCommenterEntries(teamId) {
    const usersById = new Map(
      userEntriesForAssignment().map((entry) => [valueFor(entry, "employee_id"), entry]),
    );
    return teamCommenterIds(teamEntryFor(teamId))
      .map((employeeId) => usersById.get(employeeId))
      .filter(Boolean);
  }

  function commenterMoveAvailability(teamId, employeeId) {
    const commenterIds = teamCommenterIds(teamEntryFor(teamId));
    const index = commenterIds.indexOf(employeeId);
    return {
      up: index > 0,
      down: index >= 0 && index < commenterIds.length - 1,
    };
  }

  function teamMemberCountFor(teamId) {
    return teamMemberEntries(teamId).length;
  }

  function memberMoveAvailability(entry) {
    const teamId = valueFor(entry, "small_team_id");
    const siblings = userEntriesForAssignment()
      .filter((candidate) => valueFor(candidate, "small_team_id") === teamId)
      .sort(compareUserEntries);
    const index = siblings.findIndex((candidate) => candidate.id === entry.id);
    return {
      up: index > 0,
      down: index >= 0 && index < siblings.length - 1,
    };
  }

  function normalizeMemberDisplayOrders(teamId, excludedEntryId = "") {
    if (!teamId) return [];
    const siblings = userEntriesForAssignment()
      .filter(
        (entry) =>
          valueFor(entry, "small_team_id") === teamId &&
          entry.id !== excludedEntryId,
      )
      .sort(compareUserEntries);
    siblings.forEach((entry, index) => {
      entry.values.display_order = String((index + 1) * 10);
    });
    return siblings;
  }

  function setUserTeamAssignment(entry, nextTeamId) {
    const previousTeamId = valueFor(entry, "small_team_id");
    const normalizedTeamId = String(nextTeamId || "");
    if (previousTeamId === normalizedTeamId) return;
    entry.values.small_team_id = normalizedTeamId;
    entry.values.display_order = "";
    normalizeMemberDisplayOrders(previousTeamId);
    if (normalizedTeamId) {
      const siblings = normalizeMemberDisplayOrders(normalizedTeamId, entry.id);
      entry.values.display_order = String((siblings.length + 1) * 10);
    }
  }

  function isAssignableTeam(teamId) {
    return teamAssignmentChoices().some(([choiceId]) => choiceId === teamId);
  }

  function setTeamAssignment(kind, teamId, employeeId, assigned) {
    const user = userEntriesForAssignment().find(
      (entry) => valueFor(entry, "employee_id") === employeeId,
    );
    if (!user || !teamId || !employeeId) return;
    if (kind === "member") {
      if (assigned && !isAssignableTeam(teamId)) return;
      if (assigned) setUserTeamAssignment(user, teamId);
      else if (valueFor(user, "small_team_id") === teamId) {
        setUserTeamAssignment(user, "");
      }
    } else {
      const team = teamEntryFor(teamId);
      if (!team) return;
      const commenterIds = teamCommenterIds(team);
      const index = commenterIds.indexOf(employeeId);
      if (assigned && index < 0) commenterIds.push(employeeId);
      if (!assigned && index >= 0) commenterIds.splice(index, 1);
      team.values.commenter_employee_ids = commenterIds.join(";");
    }
    renderMasterNav();
    renderTable();
    renderInspector();
    syncAdminChrome();
  }

  function createChildTeamButton(level, parentTeamId, text) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "team-child-add-button";
    button.dataset.addChildLevel = level;
    button.dataset.parentTeamId = parentTeamId;
    button.append(createTeamSvgIcon("M12 5v14M5 12h14"), document.createTextNode(text));
    return button;
  }

  function createTeamEditorFields(entry) {
    const level = valueFor(entry, "team_level");
    const nameField = createInspectorField(
      { key: "team_name", label: teamLevelLabel(level), type: "text" },
      valueFor(entry, "team_name"),
      { required: true, hideKey: true },
    );
    if (level === "large") {
      return [nameField];
    }

    const entryId = valueFor(entry, "team_id");
    const parentId = valueFor(entry, "parent_team_id");
    const parent = teamEntryFor(parentId);
    const selectedSectionId =
      valueFor(parent, "team_level") === "medium"
        ? valueFor(parent, "parent_team_id")
        : valueFor(parent, "team_level") === "large"
          ? parentId
          : "";
    const sectionChoices = [["", "課を選択してください"], ...teamParentChoices(["large"], entryId)];
    const sectionField = createTeamPlacementSelect(
      "課",
      sectionChoices,
      selectedSectionId,
      { required: true },
    );
    if (level === "medium") return [sectionField, nameField];

    const unitChoices = selectedSectionId
      ? [
          ["", "係を選択してください"],
          ...teamChildrenChoices(selectedSectionId, "medium", entryId),
        ]
      : [["", "先に課を選択してください"]];
    const selectedUnitId = valueFor(parent, "team_level") === "medium" ? parentId : selectedSectionId;
    const unitField = createTeamPlacementSelect(
      "係",
      unitChoices,
      selectedUnitId,
      { required: true, disabled: !selectedSectionId },
    );
    return [sectionField, unitField, nameField];
  }

  function createTeamPlacementSelect(labelText, choices, value, options = {}) {
    const label = document.createElement("label");
    label.className = "inspector-field team-placement-field";
    const heading = document.createElement("span");
    heading.className = "inspector-field-label";
    const visibleLabel = document.createElement("span");
    visibleLabel.textContent = labelText;
    heading.append(visibleLabel);
    if (options.optional) {
      const optional = document.createElement("small");
      optional.textContent = "任意";
      heading.append(optional);
    }
    const select = document.createElement("select");
    select.dataset.column = "parent_team_id";
    select.disabled = Boolean(options.disabled);
    select.required = Boolean(options.required);
    choices.forEach(([optionValue, text]) => {
      const option = document.createElement("option");
      option.value = optionValue;
      option.textContent = text;
      select.append(option);
    });
    select.value = value;
    label.append(heading, select);
    if (options.hint) {
      const hint = document.createElement("small");
      hint.className = "inspector-field-hint";
      hint.textContent = options.hint;
      label.append(hint);
    }
    return label;
  }

  function teamEntryFor(teamId) {
    return (drafts.get("team_master")?.entries || []).find(
      (entry) => valueFor(entry, "team_id") === teamId,
    );
  }

  function teamChildrenChoices(parentTeamId, level, excludedTeamId) {
    return (drafts.get("team_master")?.entries || [])
      .filter((entry) => valueFor(entry, "parent_team_id") === parentTeamId)
      .filter((entry) => valueFor(entry, "team_level") === level)
      .filter((entry) => valueFor(entry, "team_id") !== excludedTeamId)
      .sort(compareTeamEntries)
      .map((entry) => [valueFor(entry, "team_id"), valueFor(entry, "team_name")]);
  }

  function teamPathLabel(entry) {
    const entries = drafts.get("team_master")?.entries || [];
    const byTeamId = new Map(
      entries.map((candidate) => [valueFor(candidate, "team_id"), candidate]),
    );
    const names = [];
    let current = entry;
    const visited = new Set();
    while (current) {
      const id = valueFor(current, "team_id");
      if (visited.has(id)) break;
      visited.add(id);
      names.unshift(valueFor(current, "team_name") || "名称未設定");
      current = byTeamId.get(valueFor(current, "parent_team_id"));
    }
    return names.join(" ＞ ");
  }

  function moveSelectedMember(employeeId, direction) {
    const userDraft = drafts.get("user_master");
    const selected = userDraft?.entries.find(
      (entry) => valueFor(entry, "employee_id") === employeeId,
    );
    if (!selected || !["up", "down"].includes(direction)) return;
    const teamId = valueFor(selected, "small_team_id");
    if (!teamId) return;
    const siblings = userEntriesForAssignment()
      .filter((entry) => valueFor(entry, "small_team_id") === teamId)
      .sort(compareUserEntries);
    const index = siblings.findIndex((entry) => entry.id === selected.id);
    const targetIndex = direction === "up" ? index - 1 : index + 1;
    if (index < 0 || targetIndex < 0 || targetIndex >= siblings.length) return;
    [siblings[index], siblings[targetIndex]] = [
      siblings[targetIndex],
      siblings[index],
    ];
    siblings.forEach((entry, siblingIndex) => {
      entry.values.display_order = String((siblingIndex + 1) * 10);
    });
    renderTable();
    renderInspector();
    syncAdminChrome();
  }

  function moveSelectedCommenter(employeeId, direction) {
    const teamDraft = drafts.get("team_master");
    const team = teamDraft?.entries.find((entry) => entry.id === teamDraft.selectedId);
    if (!team || !employeeId || !["up", "down"].includes(direction)) return;
    const commenterIds = teamCommenterIds(team);
    const index = commenterIds.indexOf(employeeId);
    const targetIndex = direction === "up" ? index - 1 : index + 1;
    if (index < 0 || targetIndex < 0 || targetIndex >= commenterIds.length) return;
    [commenterIds[index], commenterIds[targetIndex]] = [
      commenterIds[targetIndex],
      commenterIds[index],
    ];
    team.values.commenter_employee_ids = commenterIds.join(";");
    renderTable();
    renderInspector();
    syncAdminChrome();
  }

  function moveSelectedTeam(direction) {
    const draft = drafts.get("team_master");
    const selected = draft?.entries.find((entry) => entry.id === draft.selectedId);
    if (!selected || !["up", "down"].includes(direction)) return;
    const parentId = valueFor(selected, "parent_team_id");
    const siblings = draft.entries
      .filter((entry) => valueFor(entry, "parent_team_id") === parentId)
      .sort(compareTeamEntries);
    const index = siblings.findIndex((entry) => entry.id === selected.id);
    const targetIndex = direction === "up" ? index - 1 : index + 1;
    if (index < 0 || targetIndex < 0 || targetIndex >= siblings.length) return;
    [siblings[index], siblings[targetIndex]] = [siblings[targetIndex], siblings[index]];
    siblings.forEach((entry, siblingIndex) => {
      entry.values.sort_order = String((siblingIndex + 1) * 10);
    });
    renderTable();
    renderInspector();
    syncAdminChrome();
  }

  function teamMoveAvailability(entry) {
    const draft = drafts.get("team_master");
    const parentId = valueFor(entry, "parent_team_id");
    const siblings = (draft?.entries || [])
      .filter((candidate) => valueFor(candidate, "parent_team_id") === parentId)
      .sort(compareTeamEntries);
    const index = siblings.findIndex((candidate) => candidate.id === entry.id);
    return {
      up: index > 0,
      down: index >= 0 && index < siblings.length - 1,
    };
  }

  function renderUserInspector(form, entry) {
    const header = document.createElement("div");
    header.className = "user-editor-header";
    const title = document.createElement("h2");
    title.textContent = valueFor(entry, "display_name") || "新しいユーザー";
    const caption = document.createElement("p");
    caption.className = "editor-caption";
    caption.textContent = "ユーザー情報を編集";
    header.append(title, caption);

    const fields = document.createElement("div");
    fields.className = "user-editor-fields";
    const definition = getDefinition("user_master");
    definition.columns
      .filter(
        (column) =>
          [
            "display_name",
            "employment_type",
            "is_admin",
            "can_input_own_report",
            "small_team_id",
          ].includes(column.key),
      )
      .forEach((column) => {
        const field = createInspectorField(column, entry.values[column.key], {
          required: Boolean(column.required),
          disabled:
            column.key === "is_admin" &&
            valueFor(entry, "employment_type") !== "regular",
          hint: column.key === "is_admin" ? "正社員のみ設定できます。" : "",
          hideKey: true,
        });
        fields.append(field);
      });

    const advanced = document.createElement("details");
    advanced.className = "user-advanced-settings";
    advanced.open = entry.isNew;
    const advancedSummary = document.createElement("summary");
    advancedSummary.textContent = "詳細設定";
    const advancedFields = document.createElement("div");
    advancedFields.className = "user-editor-fields";
    definition.columns
      .filter((column) => column.key === "employee_id")
      .forEach((column) => {
        advancedFields.append(
          createInspectorField(column, entry.values[column.key], {
            required: Boolean(column.required),
            disabled: column.key === "employee_id" && !entry.isNew,
            hideKey: true,
          }),
        );
    });
    advanced.append(advancedSummary, advancedFields);
    form.append(header, fields, advanced, createUserEditorActions());
  }

  function createUserEditorActions() {
    const actions = document.createElement("div");
    actions.className = "user-editor-actions";
    const deleteButton = createDeleteButton("削除");
    deleteButton.classList.add("is-secondary");
    const saveButton = document.createElement("button");
    saveButton.type = "button";
    saveButton.className = "inspector-save-button";
    saveButton.dataset.saveEditor = "true";
    saveButton.textContent = "保存";
    actions.append(deleteButton, saveButton);
    return actions;
  }

  function displayNameFor(employeeId) {
    const entry = drafts
      .get("user_master")
      ?.entries.find((item) => valueFor(item, "employee_id") === employeeId);
    return valueFor(entry, "display_name") || employeeId;
  }

  function renderGenericInspector(form, entry) {
    const definition = getDefinition();
    const header = createInspectorHeader(
      "選択中の行",
      entry.values[definition.columns[0].key] || "新しい行",
    );
    const fields = document.createElement("div");
    fields.className = "inspector-fields";
    definition.columns.forEach((column) => {
      const field = createInspectorField(column, entry.values[column.key], {
        required: Boolean(column.required),
        disabled:
          activeMaster === "team_master" &&
          column.key === "team_id" &&
          !entry.isNew,
      });
      if (
        activeMaster === "team_master" &&
        column.key === "team_id" &&
        !entry.isNew
      ) {
        const hint = document.createElement("small");
        hint.className = "inspector-field-hint";
        hint.textContent = "登録後のチームIDは変更できません";
        field.append(hint);
      }
      fields.append(field);
    });
    form.append(header, fields, createUserEditorActions());
  }

  function createInspectorHeader(eyebrowText, titleText) {
    const header = document.createElement("div");
    header.className = "inspector-form-header";
    const eyebrow = document.createElement("span");
    eyebrow.textContent = eyebrowText;
    const title = document.createElement("h3");
    title.textContent = titleText;
    header.append(eyebrow, title);
    return header;
  }

  function createSectionHeading(titleText, descriptionText) {
    const heading = document.createElement("div");
    heading.className = "inspector-section-heading";
    const copy = document.createElement("div");
    const title = document.createElement("h4");
    title.textContent = titleText;
    const description = document.createElement("p");
    description.textContent = descriptionText;
    copy.append(title);
    if (descriptionText) copy.append(description);
    heading.append(copy);
    return heading;
  }

  function createInspectorField(column, value, options = {}) {
    const label = document.createElement("label");
    label.className = "inspector-field";
    const labelText = document.createElement("span");
    labelText.className = "inspector-field-label";
    const visibleLabel = document.createElement("span");
    visibleLabel.textContent = column.label;
    const key = document.createElement("small");
    key.textContent = column.key;
    labelText.append(visibleLabel);
    if (!options.hideKey) labelText.append(key);

    let input;
    if (column.type === "admin_flag") {
      label.classList.add("admin-flag-field");
      input = document.createElement("input");
      input.type = "checkbox";
      input.checked = value === "1";
      input.setAttribute("aria-label", column.label);
    } else if (
      [
        "boolean",
        "active",
        "employment_type",
        "self_report_input",
        "team_level",
        "small_team",
        "parent_team",
      ].includes(column.type)
    ) {
      input = document.createElement("select");
      let choices = [];
      if (column.type === "boolean") {
        choices = [["0", "稼働日"], ["1", "休日"]];
      } else if (column.type === "self_report_input") {
        choices = [["1", "入力する"], ["0", "入力しない"]];
      } else if (column.type === "employment_type") {
        choices = [["regular", "正社員"], ["temporary", "派遣社員"]];
      } else if (column.type === "active") {
        choices = [["1", "有効"], ["0", "廃止"]];
      } else if (column.type === "team_level") {
        choices = [["large", "課"], ["medium", "係"], ["small", "チーム"]];
      } else if (column.type === "small_team") {
        choices = [["", "所属なし"], ...teamAssignmentChoices()];
      } else {
        const selected = getDraft()?.entries.find(
          (entry) => entry.id === getDraft()?.selectedId,
        );
        const level = valueFor(selected, "team_level");
        const parentLevels =
          level === "medium" ? ["large"] : level === "small" ? ["large", "medium"] : [];
        choices = [["", parentLevels.length ? "親なし（最上位）" : "親チームなし"]];
        if (parentLevels.length) {
          choices.push(...teamParentChoices(parentLevels, valueFor(selected, "team_id")));
        }
        options.disabled = options.disabled || !parentLevels.length;
      }
      choices.forEach(([optionValue, text]) => {
        const option = document.createElement("option");
        option.value = optionValue;
        option.textContent = text;
        input.append(option);
      });
    } else {
      input = document.createElement("input");
      input.type = column.type;
      if (column.type === "number") {
        input.min = "0";
        input.max = "9999";
        input.step = "1";
        input.placeholder = "未設定";
      }
    }
    input.dataset.column = column.key;
    if (input.type !== "checkbox") input.value = value;
    input.required = Boolean(options.required);
    input.disabled = Boolean(options.disabled);
    input.autocomplete = "off";
    const isInvalid = input.required && !String(value).trim();
    input.classList.toggle("is-invalid", isInvalid);
    input.setAttribute("aria-invalid", String(isInvalid));
    label.append(labelText, input);
    if (options.hint) {
      const hint = document.createElement("small");
      hint.className = "inspector-field-hint";
      hint.textContent = options.hint;
      label.append(hint);
    }
    return label;
  }

  function teamChoices(level) {
    return (drafts.get("team_master")?.entries || [])
      .filter((entry) => valueFor(entry, "team_level") === level)
      .sort((left, right) => {
        const leftOrder = Number(valueFor(left, "sort_order") || 999999);
        const rightOrder = Number(valueFor(right, "sort_order") || 999999);
        return leftOrder - rightOrder || teamNameFor(valueFor(left, "team_id")).localeCompare(
          teamNameFor(valueFor(right, "team_id")),
          "ja",
        );
      })
      .map((entry) => [
        valueFor(entry, "team_id"),
        teamNameFor(valueFor(entry, "team_id")),
      ]);
  }

  function teamAssignmentChoices() {
    const entries = drafts.get("team_master")?.entries || [];
    return entries
      .filter((entry) => ["large", "medium", "small"].includes(valueFor(entry, "team_level")))
      .sort(compareTeamPathOrder)
      .map((entry) => [valueFor(entry, "team_id"), teamPathLabel(entry)]);
  }

  function compareTeamPathOrder(left, right) {
    const entries = drafts.get("team_master")?.entries || [];
    const byId = new Map(entries.map((entry) => [valueFor(entry, "team_id"), entry]));
    const key = (entry) => {
      const orders = [];
      let current = entry;
      while (current) {
        orders.unshift(Number(valueFor(current, "sort_order") || 999999));
        current = byId.get(valueFor(current, "parent_team_id"));
      }
      return orders;
    };
    const leftKey = key(left);
    const rightKey = key(right);
    for (let index = 0; index < Math.max(leftKey.length, rightKey.length); index += 1) {
      const delta = (leftKey[index] ?? -1) - (rightKey[index] ?? -1);
      if (delta) return delta;
    }
    return valueFor(left, "team_name").localeCompare(valueFor(right, "team_name"), "ja");
  }

  function teamParentChoices(levels, excludedTeamId) {
    return (drafts.get("team_master")?.entries || [])
      .filter((entry) => levels.includes(valueFor(entry, "team_level")))
      .filter((entry) => valueFor(entry, "team_id") !== excludedTeamId)
      .sort(compareTeamEntries)
      .map((entry) => [valueFor(entry, "team_id"), teamPathLabel(entry)]);
  }

  function createDeleteButton(text) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "inspector-delete-button";
    button.dataset.deleteRow = "true";
    button.textContent = text;
    return button;
  }

  function createEditorActionBar() {
    const actions = document.createElement("div");
    actions.className = "inspector-record-actions";
    const saveButton = document.createElement("button");
    saveButton.type = "button";
    saveButton.className = "inspector-save-button";
    saveButton.dataset.saveEditor = "true";
    saveButton.append(
      createTeamSvgIcon("m5 12 4 4L19 6"),
      document.createTextNode("変更を保存"),
    );
    actions.append(saveButton);
    return actions;
  }

  function createDeleteActionBar(deleteButton) {
    const actions = document.createElement("div");
    actions.className = "inspector-delete-actions";
    actions.append(deleteButton);
    return actions;
  }

  function dirtyFileCount() {
    let count = 0;
    if (isDraftDirty(drafts.get("user_master"))) count += 1;
    if (isDraftDirty(drafts.get("team_master"))) count += 1;
    if (isDraftDirty(drafts.get("calendar"))) count += 1;
    return count;
  }

  function syncAdminChrome() {
    const count = dirtyFileCount();
    const badge = byId("adminDirtyBadge");
    const ledger = byId("adminLedgerCount");
    const pageSaveButton = byId("adminSaveButton");
    const activeEditorDirty =
      activeMaster === "team_master"
        ? isOrganizationAdministrationDirty()
        : isDefinitionDirty(activeMaster);
    if (badge) {
      badge.classList.toggle("hidden", count === 0);
      badge.textContent = `${count}ファイル変更中`;
    }
    document.querySelectorAll("[data-save-editor]").forEach((button) => {
      button.disabled = !activeEditorDirty || isLoading;
    });
    if (pageSaveButton) {
      pageSaveButton.disabled = count === 0 || isLoading;
    }
    if (ledger) ledger.textContent = count === 0 ? "変更はありません" : `${count}ファイルを編集中`;
    if (typeof syncNativeUnsavedState === "function") {
      syncNativeUnsavedState(hasUnsavedChanges());
    }
  }

  function hasUnsaved() {
    return dirtyFileCount() > 0;
  }

  window.adminMasters = {
    initialize,
    ensureLoaded,
    hasUnsaved,
    save,
    syncChrome: syncAdminChrome,
  };
})();

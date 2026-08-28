// Common-data workbench. Organization membership and comment assignments are
// edited together and saved as one three-file transaction.
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
        { key: "employee_id", label: "社員番号", type: "text", required: true },
        { key: "display_name", label: "氏名", type: "text", required: true },
        {
          key: "employment_type",
          label: "雇用区分",
          type: "employment_type",
          required: true,
          defaultValue: "regular",
        },
        {
          key: "is_admin",
          label: "権限",
          type: "admin_flag",
          required: false,
          defaultValue: "0",
        },
        {
          key: "affiliation_type",
          label: "所属区分",
          type: "affiliation_type",
          required: true,
          defaultValue: "organization",
        },
        {
          key: "organization_id",
          label: "所属組織",
          type: "organization",
          required: true,
        },
        {
          key: "can_input_own_report",
          label: "日報入力",
          type: "self_report_input",
          required: true,
          defaultValue: "1",
        },
        {
          key: "member_order",
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
        { key: "team_id", label: "組織ID", type: "number", required: true },
        { key: "team_name", label: "組織名", type: "text", required: true },
        {
          key: "team_type",
          label: "組織種別",
          type: "team_type",
          required: true,
          defaultValue: "section",
        },
        {
          key: "parent_team_id",
          label: "親課",
          type: "parent_department",
          required: false,
        },
        { key: "sort_order", label: "表示順", type: "number" },
      ],
    },
    {
      key: "comment_assignment",
      label: "コメント担当設定",
      file: "comment_assignment.csv",
      hidden: true,
      columns: [
        { key: "commenter_employee_id", label: "コメント担当者", type: "text", required: true },
        { key: "target_type", label: "コメント対象", type: "text", required: true, defaultValue: "none" },
        { key: "target_organization_ids", label: "対象組織", type: "text" },
        { key: "target_employee_ids", label: "対象ユーザー", type: "text" },
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

  const EMBEDDED_EDIT_ICON_PATH =
    "M16.793 2.793a3.121 3.121 0 1 1 4.414 4.414l-8.5 8.5A1 1 0 0 1 12 16H9a1 1 0 0 1-1-1v-3a1 1 0 0 1 .293-.707l8.5-8.5Zm3 1.414a1.121 1.121 0 0 0-1.586 0L10 12.414V14h1.586l8.207-8.207a1.121 1.121 0 0 0 0-1.586ZM6 5a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-4a1 1 0 1 1 2 0v4a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3h4a1 1 0 1 1 0 2H6Z";
  const EMBEDDED_DELETE_ICON_PATH =
    "M10.556 4a1 1 0 0 0-.97.751l-.292 1.14h5.421l-.293-1.14A1 1 0 0 0 13.453 4h-2.897Zm6.224 1.892-.421-1.639A3 3 0 0 0 13.453 2h-2.897A3 3 0 0 0 7.65 4.253l-.421 1.639H4a1 1 0 1 0 0 2h.1l1.215 11.425A3 3 0 0 0 8.3 22h7.4a3 3 0 0 0 2.984-2.683l1.214-11.425H20a1 1 0 1 0 0-2h-3.22Zm1.108 2H6.112l1.192 11.214A1 1 0 0 0 8.3 20h7.4a1 1 0 0 0 .995-.894l1.192-11.214ZM10 10a1 1 0 0 1 1 1v5a1 1 0 1 1-2 0v-5a1 1 0 0 1 1-1Zm4 0a1 1 0 0 1 1 1v5a1 1 0 1 1-2 0v-5a1 1 0 0 1 1-1Z";

  let isLoaded = false;
  let isLoading = false;
  const MIN_FISCAL_YEAR = 2026;
  let activeMaster = "user_master";
  let activeFiscalYear = Math.max(
    MIN_FISCAL_YEAR,
    fiscalYearForDate(new Date()),
  );
  let calendarFocusDate = "";
  let isChangingFiscalYear = false;
  let searchText = "";
  let nextRowId = 1;
  const drafts = new Map();
  const collapsedTeamIds = new Set();
  const expandedOrganizationIds = new Set();
  let organizationMigrationState = null;
  let selectedOrganizationSpecial = "";
  let userEditorModalState = null;
  let currentEmployeeId = "";
  let teamEditorModalState = null;
  let organizationDragState = null;
  let organizationSortableInstances = [];
  let teamEditorMemberDragState = null;
  let teamEditorMemberSortableInstances = [];
  let selectedOrganizationDepartmentId = "";

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
  const hasDraftRowChanges = (draft) =>
    Boolean(draft) && snapshot(valuesOnly(draft)) !== draft.originalSnapshot;
  const hasEditorChanges = (key = activeMaster) => {
    if (key === "team_master") {
      return ["user_master", "team_master", "comment_assignment"].some(
        (draftKey) => hasDraftRowChanges(drafts.get(draftKey)),
      );
    }
    if (key === "user_master") {
      return ["user_master", "comment_assignment"].some((draftKey) =>
        hasDraftRowChanges(drafts.get(draftKey)),
      );
    }
    return hasDraftRowChanges(drafts.get(key));
  };
  const isUserAdministrationDirty = () =>
    isDraftDirty(drafts.get("user_master")) ||
    isDraftDirty(drafts.get("comment_assignment"));
  const isOrganizationAdministrationDirty = () =>
    isUserAdministrationDirty() ||
    isDraftDirty(drafts.get("team_master")) ||
    isDraftDirty(drafts.get("comment_assignment"));
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
    return entry;
  }

  function buildLegacyOrganizationCandidates(data, preview) {
    const legacyTeams = Array.isArray(data.team_master) ? data.team_master : [];
    const convertibleIds = new Set();
    const departments = legacyTeams
      .filter((team) => team.team_level === "large" && !team.parent_team_id)
      .map((team) => {
        convertibleIds.add(String(team.team_id || ""));
        return {
          team_id: String(team.team_id || ""),
          team_name: String(team.team_name || ""),
          team_type: "department",
          parent_team_id: "",
          sort_order: String(team.sort_order || ""),
        };
      });
    const departmentIds = new Set(departments.map((team) => team.team_id));
    const sections = legacyTeams
      .filter(
        (team) =>
          team.team_level === "medium" &&
          departmentIds.has(String(team.parent_team_id || "")),
      )
      .map((team) => {
        convertibleIds.add(String(team.team_id || ""));
        return {
          team_id: String(team.team_id || ""),
          team_name: String(team.team_name || ""),
          team_type: "section",
          parent_team_id: String(team.parent_team_id || ""),
          sort_order: String(team.sort_order || ""),
        };
      });
    const users = (Array.isArray(data.user_master) ? data.user_master : []).map(
      (user) => {
        const organizationId = String(user.small_team_id || "");
        return {
          employee_id: String(user.employee_id || ""),
          display_name: String(user.display_name || ""),
          can_input_own_report: String(user.can_input_own_report ?? "1"),
          employment_type: String(user.employment_type || "regular"),
          is_admin: String(user.is_admin || "0"),
          affiliation_type: "organization",
          organization_id: convertibleIds.has(organizationId) ? organizationId : "",
          member_order: String(user.display_order || ""),
        };
      },
    );
    return {
      rows: {
        user_master: users,
        team_master: [...departments, ...sections],
        comment_assignment: users.map((user) => ({
          commenter_employee_id: user.employee_id,
          target_type: "none",
          target_organization_ids: "",
          target_employee_ids: "",
        })),
        calendar: Array.isArray(data.calendar) ? data.calendar : [],
      },
      ambiguousTeamIds: Array.isArray(preview.ambiguous_team_ids)
        ? preview.ambiguous_team_ids
        : [],
      unresolvedEmployeeIds: users
        .filter((user) => !user.organization_id)
        .map((user) => user.employee_id),
      legacyAssignments: legacyTeams
        .filter(
          (team) =>
            String(team.commenter_employee_ids || "").trim() ||
            String(team.target_employee_ids || "").trim(),
        )
        .map((team) => ({
          teamName: String(team.team_name || team.team_id || "名称未設定"),
          commenters: String(team.commenter_employee_ids || "") || "なし",
          scope: String(team.commenter_scope || team.team_level || "不明"),
          targets: String(team.target_employee_ids || "") || "組織範囲",
        })),
    };
  }

  function ensureAssignmentRows() {
    const draft = drafts.get("comment_assignment");
    const definition = getDefinition("comment_assignment");
    const employeeIds = new Set(
      (drafts.get("user_master")?.entries || []).map((entry) =>
        valueFor(entry, "employee_id"),
      ),
    );
    draft.entries = draft.entries.filter((entry) =>
      employeeIds.has(valueFor(entry, "commenter_employee_id")),
    );
    const existing = new Set(
      draft.entries.map((entry) => valueFor(entry, "commenter_employee_id")),
    );
    employeeIds.forEach((employeeId) => {
      if (!employeeId || existing.has(employeeId)) return;
      draft.entries.push(
        createEntry(
          {
            commenter_employee_id: employeeId,
            target_type: "none",
            target_organization_ids: "",
            target_employee_ids: "",
          },
          definition,
          true,
        ),
      );
    });
  }

  function normalizeAllMemberOrders() {
    const groups = new Map();
    (drafts.get("user_master")?.entries || []).forEach((entry) => {
      const group =
        valueFor(entry, "affiliation_type") === "director"
          ? "director"
          : valueFor(entry, "organization_id");
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(entry);
    });
    groups.forEach((entries) => {
      entries
        .sort(compareUserListEntries)
        .forEach((entry, index) => {
          entry.values.member_order = String((index + 1) * 10);
        });
    });
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

  function hasCalendarEntriesForFiscalYear(fiscalYear) {
    const draft = drafts.get("calendar");
    return Boolean(
      draft?.entries.some((entry) => {
        const date = calendarDate(valueFor(entry, "date"));
        return date && fiscalYearForDate(date) === fiscalYear;
      }),
    );
  }

  function createTeamId() {
    const usedIds = new Set(
      (drafts.get("team_master")?.entries || [])
        .map((entry) => Number.parseInt(valueFor(entry, "team_id"), 10))
        .filter((teamId) => Number.isSafeInteger(teamId) && teamId > 0),
    );
    let nextId = 1;
    while (usedIds.has(nextId)) nextId += 1;
    return String(nextId);
  }

  function initialize() {
    byId("adminReloadButton").addEventListener("click", reload);
    byId("adminAddRowButton").addEventListener("click", addRow);
    byId("adminSearchInput").addEventListener("input", (event) => {
      searchText = String(event.target.value || "").trim().toLocaleLowerCase("ja");
      renderTableHeading();
      renderTable();
    });
    byId("adminSearchClearButton").addEventListener("click", () => {
      const searchInput = byId("adminSearchInput");
      searchInput.value = "";
      searchText = "";
      renderTableHeading();
      renderTable();
      searchInput.focus();
    });
    byId("masterNav").addEventListener("click", (event) => {
      const button = event.target.closest("[data-master]");
      if (button) selectMaster(button.dataset.master);
    });
    byId("adminTableWrap").addEventListener("click", (event) => {
      if (event.target.closest("[data-save-editor]")) {
        void save();
        return;
      }
      const fiscalYearButton = event.target.closest("[data-calendar-year-action]");
      if (fiscalYearButton) {
        changeFiscalYear(fiscalYearButton.dataset.calendarYearAction);
        return;
      }
      const calendarDay = event.target.closest("[data-calendar-date]");
      if (calendarDay) {
        calendarFocusDate = calendarDay.dataset.calendarDate;
        toggleCalendarDay(calendarDay.dataset.calendarDate);
        return;
      }
      if (event.target.closest("[data-add-team-root]")) {
        openTeamCreateDialog("department", "");
        return;
      }
      const addChildLevel = event.target.closest("[data-add-child-level]");
      if (addChildLevel) {
        openTeamCreateDialog(
          addChildLevel.dataset.addChildLevel,
          addChildLevel.dataset.parentTeamId,
        );
        return;
      }
      const organizationToggle = event.target.closest("[data-organization-toggle]");
      if (organizationToggle) {
        toggleOrganizationSections(organizationToggle.dataset.organizationToggle);
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
      const organizationSelect = event.target.closest("[data-organization-select]");
      if (organizationSelect) {
        selectOrganizationDepartment(organizationSelect.dataset.organizationSelect);
        return;
      }
      const userAction = event.target.closest("[data-user-row-action]");
      if (userAction) {
        if (
          userAction.disabled ||
          userAction.getAttribute("aria-disabled") === "true"
        ) {
          return;
        }
        if (userAction.dataset.userRowAction === "edit") {
          openUserEditor(userAction.dataset.userId);
        } else if (userAction.dataset.userRowAction === "delete") {
          void deleteSelectedRow(userAction.dataset.userId);
        }
        return;
      }
      const organizationEdit = event.target.closest("[data-organization-edit]");
      if (organizationEdit) {
        if (organizationEdit.dataset.organizationEdit === "director") {
          openDirectorEditor();
        } else {
          openTeamEditor(organizationEdit.dataset.organizationEdit);
        }
        return;
      }
      if (event.target.closest("[data-organization-drag-handle]")) return;
      const departmentCard = event.target.closest(
        ".organization-department-card[data-team-id]",
      );
      if (departmentCard) {
        selectOrganizationDepartment(departmentCard.dataset.teamId);
        return;
      }
      const row = event.target.closest("[data-row-id]");
      if (row) {
        if (activeMaster !== "team_master" && activeMaster !== "user_master") {
          selectRow(row.dataset.rowId);
        }
        return;
      }
      if (
        activeMaster === "team_master" &&
        selectedOrganizationDepartmentId &&
        event.target.closest(".organization-browser-v2")
      ) {
        clearSelectedOrganizationDepartment();
      }
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
      if (handleCalendarGridKeydown(event)) return;
      if (!["Enter", " "].includes(event.key)) return;
      if (
        event.target.closest(
          "[data-user-row-action], [data-organization-edit], [data-organization-toggle], [data-organization-drag-handle], [data-organization-select], [data-add-child-level]",
        )
      ) return;
      const row = event.target.closest("[data-row-id]");
      if (!row) return;
      event.preventDefault();
      if (activeMaster === "user_master") openUserEditor(row.dataset.rowId);
      else if (activeMaster === "team_master") return;
      else selectRow(row.dataset.rowId);
    });
    byId("adminTableWrap").addEventListener("focusin", (event) => {
      const calendarDay = event.target.closest("[data-calendar-date]");
      if (!calendarDay) return;
      calendarFocusDate = calendarDay.dataset.calendarDate;
      syncCalendarRovingTabindex(calendarFocusDate);
    });
    ["adminInspectorForm", "userEditorDialogForm", "teamEditorDialogForm"].forEach((formId) => {
      const form = byId(formId);
      if (!form) return;
      form.addEventListener("input", handleInspectorInput);
      form.addEventListener("change", handleInspectorChange);
      form.addEventListener("click", handleInspectorClick);
    });
    byId("teamCreateForm").addEventListener("submit", submitTeamCreateDialog);
    byId("teamCreateName").addEventListener("input", updateTeamCreateDialogState);
    byId("cancelTeamCreateButton").addEventListener("click", closeTeamCreateDialog);
    byId("teamCreateDialog").addEventListener("cancel", (event) => {
      event.preventDefault();
      closeTeamCreateDialog();
    });
    byId("teamCreateDialog").addEventListener("click", (event) => {
      if (event.target === event.currentTarget) closeTeamCreateDialog();
    });
    byId("userEditorDialog").addEventListener("cancel", (event) => {
      event.preventDefault();
    });
    byId("teamEditorDialog").addEventListener("cancel", (event) => {
      event.preventDefault();
    });
  }

  function handleInspectorInput(event) {
    updateSelectedRow(event);
  }

  function handleInspectorChange(event) {
    const affiliation = event.target.closest("[data-user-affiliation]");
    if (affiliation) {
      void changeUserAffiliation(affiliation.value);
      return;
    }
    const assignmentType = event.target.closest("[data-comment-target-type]");
    if (assignmentType) {
      updateCommentTargetType(assignmentType.value);
      return;
    }
    const assignmentOrganization = event.target.closest(
      "[data-comment-target-organization]",
    );
    if (assignmentOrganization) {
      const assignment = assignmentEntryForSelectedUser(true);
      assignment.values.target_organization_ids = assignmentOrganization.value;
      assignment.values.target_employee_ids = "";
      renderInspector();
      syncAdminChrome();
      return;
    }
    const assignmentTarget = event.target.closest("[data-comment-target-employee]");
    if (assignmentTarget) {
      toggleAssignmentListValue(
        "target_employee_ids",
        assignmentTarget.value,
        assignmentTarget.checked,
      );
      return;
    }
    const assignmentDepartment = event.target.closest("[data-comment-target-department]");
    if (assignmentDepartment) {
      toggleAssignmentListValue(
        "target_organization_ids",
        assignmentDepartment.value,
        assignmentDepartment.checked,
      );
      return;
    }
    const moveToGroup = event.target.closest("[data-move-user-affiliation]");
    if (moveToGroup && moveToGroup.value) {
      void moveUserToAffiliation(
        moveToGroup.dataset.employeeId,
        moveToGroup.value,
      );
      return;
    }
    const addMember = event.target.closest("[data-add-organization-member]");
    if (addMember && addMember.value) {
      void moveUserToAffiliation(addMember.value, addMember.dataset.destination);
      return;
    }
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
  }

  function handleInspectorClick(event) {
    const isUserEditorModal = event.currentTarget?.id === "userEditorDialogForm";
    const isTeamEditorModal = event.currentTarget?.id === "teamEditorDialogForm";
    if (event.target.closest("[data-user-editor-cancel]")) {
      closeUserEditorModal(true);
      return;
    }
    if (event.target.closest("[data-team-editor-cancel]")) {
      closeTeamEditorModal(true);
      return;
    }
    if (event.target.closest("[data-save-editor]")) {
      if (isUserEditorModal) void saveUserEditor();
      else if (isTeamEditorModal) void saveTeamEditor();
      else void save();
      return;
    }
    const deleteAction = event.target.closest("[data-delete-row]");
    if (deleteAction) {
      if (
        deleteAction.disabled ||
        deleteAction.getAttribute("aria-disabled") === "true"
      ) {
        return;
      }
      void deleteSelectedRow();
      return;
    }
    const organizationMemberMove = event.target.closest("[data-organization-member-move]");
    if (organizationMemberMove) {
      moveOrganizationMember(
        organizationMemberMove.dataset.employeeId,
        organizationMemberMove.dataset.organizationMemberMove,
      );
      return;
    }
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
      return;
    }
    const moveButton = event.target.closest("[data-move-team]");
    if (moveButton) moveSelectedTeam(moveButton.dataset.moveTeam);
  }

  async function ensureLoaded() {
    if (isLoaded || isLoading) return;
    await load();
  }

  async function load() {
    const api = window.pywebview?.api;
    if (typeof api?.load_common_masters !== "function") {
      notify({
        text: "管理の読み込み機能を利用できません。",
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
          text: result?.message || "管理を読み込めませんでした。",
          type: "error",
        });
        return;
      }

      drafts.clear();
      collapsedTeamIds.clear();
      expandedOrganizationIds.clear();
      selectedOrganizationDepartmentId = "";
      const schemaMode = result.data?.organization_schema?.[0]?.mode || "new";
      organizationMigrationState =
        schemaMode === "legacy"
          ? buildLegacyOrganizationCandidates(result.data || {}, result.migration_preview || {})
          : null;
      const organizationRows = organizationMigrationState?.rows || result.data || {};
      MASTER_DEFINITIONS.forEach((definition) => {
        const rows = Array.isArray(organizationRows?.[definition.key])
          ? organizationRows[definition.key]
          : [];
        const entries = rows.map((row) =>
          createEntry(row, definition, false),
        );
        drafts.set(definition.key, {
          entries,
          originalSnapshot: snapshot(entries.map((entry) => entry.values)),
          revision: String(result.revisions?.[definition.key] || ""),
          migrationRequired: Boolean(
            result.migration_required?.[definition.key] ||
              (organizationMigrationState && definition.key !== "calendar"),
          ),
          selectedId: "",
        });
      });
      const calendarDraft = drafts.get("calendar");
      if (calendarDraft?.entries.length === 0) {
        activeFiscalYear = Math.max(
          MIN_FISCAL_YEAR,
          fiscalYearForDate(new Date()),
        );
        ensureFiscalYearEntries(activeFiscalYear);
      }
      isLoaded = true;
      searchText = "";
      byId("adminLoading").classList.add("hidden");
      byId("adminWorkspace").classList.remove("hidden");
    } finally {
      isLoading = false;
      setBusy(false);
      if (isLoaded) render();
      else syncAdminChrome();
    }
  }

  async function reload() {
    if (hasUnsaved()) {
      const confirmed = await requestConfirmationDialog({
        title: "未保存の変更があります",
        description:
          "管理を再読み込みすると、保存していない変更は失われます。",
        confirmLabel: "破棄して再読み込み",
        cancelLabel: "このまま編集を続ける",
        confirmTone: "danger",
      });
      if (!confirmed) return;
    }
    isLoaded = false;
    await load();
  }

  async function save(targetMaster = activeMaster) {
    const saveAdministration = ["user_master", "team_master", "comment_assignment"].includes(targetMaster);
    const saveCalendar = targetMaster === "calendar";
    const targetIsDirty = saveAdministration
      ? isOrganizationAdministrationDirty()
      : saveCalendar && isDraftDirty(drafts.get("calendar"));
    if (!targetIsDirty) return true;
    if (saveAdministration && regularAdministratorCount() < 1) {
      notifyAdministratorGuard("保存");
      return false;
    }
    if (isLoading) return false;
    const api = window.pywebview?.api;
    setBusy(true, "admin-save");
    try {
      const userDraft = drafts.get("user_master");
      const teamDraft = drafts.get("team_master");
      const assignmentDraft = drafts.get("comment_assignment");
      const teamDirty = saveAdministration && isDraftDirty(teamDraft);
      const userDirty = saveAdministration && isDraftDirty(userDraft);
      const assignmentDirty = saveAdministration && isDraftDirty(assignmentDraft);
      if (teamDirty || userDirty || assignmentDirty) {
        if (typeof api?.save_user_administration !== "function") {
          throw new Error("ユーザー管理の保存機能を利用できません。");
        }
        normalizeAllTeamOrders();
        normalizeAllMemberOrders();
        ensureAssignmentRows();
        const payload = {
          users: valuesOnly(userDraft),
          teams: valuesOnly(teamDraft),
          comment_assignments: valuesOnly(assignmentDraft),
          revisions: {
            user_master: userDraft.revision,
            team_master: teamDraft.revision,
            comment_assignment: assignmentDraft.revision,
          },
        };
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
        if (userDirty || teamDirty || assignmentDirty) {
          userDraft.originalSnapshot = snapshot(valuesOnly(userDraft));
          userDraft.migrationRequired = false;
          userDraft.revision = String(
            result.revisions?.user_master || userDraft.revision,
          );
          userDraft.entries.forEach((entry) => {
            entry.isNew = false;
          });
        }
        if (userDirty || teamDirty || assignmentDirty) {
          teamDraft.originalSnapshot = snapshot(valuesOnly(teamDraft));
          teamDraft.migrationRequired = false;
          teamDraft.revision = String(
            result.revisions?.team_master || teamDraft.revision,
          );
          teamDraft.entries.forEach((entry) => {
            entry.isNew = false;
          });
          assignmentDraft.originalSnapshot = snapshot(valuesOnly(assignmentDraft));
          assignmentDraft.migrationRequired = false;
          assignmentDraft.revision = String(
            result.revisions?.comment_assignment || assignmentDraft.revision,
          );
          assignmentDraft.entries.forEach((entry) => {
            entry.isNew = false;
          });
          organizationMigrationState = null;
        }
      }

      const calendarDraft = drafts.get("calendar");
      if (saveCalendar && isDraftDirty(calendarDraft)) {
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
          error?.message || "管理の保存中にエラーが発生しました。",
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
    if (activeMaster === "team_master" && teamEditorModalState) {
      closeTeamEditorModal(true);
    }
    if (activeMaster === "team_master") {
      selectedOrganizationDepartmentId = "";
    }
    activeMaster = key;
    searchText = "";
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
    selectedOrganizationSpecial = "";
    renderTable();
    renderInspector();
    syncAdminChrome();
  }

  function selectOrganizationDepartment(teamId) {
    if (activeMaster !== "team_master") return;
    const entry = teamEntryFor(teamId);
    if (!entry || valueFor(entry, "team_type") !== "department") return;
    if (selectedOrganizationDepartmentId === teamId) return;
    selectedOrganizationDepartmentId = teamId;
    renderTable();
    syncAdminChrome();
  }

  function clearSelectedOrganizationDepartment() {
    if (activeMaster !== "team_master" || !selectedOrganizationDepartmentId) return;
    selectedOrganizationDepartmentId = "";
    renderTable();
    syncAdminChrome();
  }

  function regularAdministratorCount() {
    return (drafts.get("user_master")?.entries || []).filter(
      (entry) => valueFor(entry, "employment_type") === "regular" && valueFor(entry, "is_admin") === "1",
    ).length;
  }

  function isProtectedAdministratorEntry(entry) {
    if (!entry || valueFor(entry, "is_admin") !== "1") return false;
    return valueFor(entry, "employee_id") === currentEmployeeId || regularAdministratorCount() <= 1;
  }

  function notifyAdministratorGuard(action = "変更") {
    notify({ text: `正社員の管理者を1人以上残す必要があるため、${action}できません。`, type: "error" });
  }

  function captureUserEditorSnapshot() {
    return ["user_master", "team_master", "comment_assignment"].map((key) => {
      const draft = drafts.get(key);
      return {
        key,
        selectedId: draft?.selectedId || "",
        entries: (draft?.entries || []).map((entry) => ({
          entry,
          values: { ...entry.values },
          isNew: entry.isNew,
        })),
      };
    });
  }

  function restoreUserEditorSnapshot(snapshotState) {
    snapshotState.forEach(({ key, selectedId, entries }) => {
      const draft = drafts.get(key);
      if (!draft) return;
      entries.forEach(({ entry, values, isNew }) => {
        entry.values = { ...values };
        entry.isNew = isNew;
      });
      draft.entries = entries.map(({ entry }) => entry);
      draft.selectedId = selectedId;
    });
  }

  function openUserEditor(rowId, previousSnapshot = null) {
    if (userEditorModalState) return;
    const draft = drafts.get("user_master");
    const entry = draft?.entries.find((item) => item.id === rowId);
    if (!entry) return;
    userEditorModalState = {
      entryId: rowId,
      snapshot: previousSnapshot || captureUserEditorSnapshot(),
    };
    draft.selectedId = rowId;
    selectedOrganizationSpecial = "";
    render();
    const dialog = byId("userEditorDialog");
    if (typeof dialog.showModal === "function" && !dialog.open) dialog.showModal();
    else dialog.setAttribute("open", "");
    requestAnimationFrame(() => {
      byId("userEditorDialogForm")
        ?.querySelector("input:not(:disabled), select")
        ?.focus();
    });
  }

  function closeUserEditorModal(discard = true) {
    const state = userEditorModalState;
    if (!state) return;
    if (discard) restoreUserEditorSnapshot(state.snapshot);
    else {
      const draft = drafts.get("user_master");
      if (draft?.selectedId === state.entryId) draft.selectedId = "";
    }
    userEditorModalState = null;
    const dialog = byId("userEditorDialog");
    if (typeof dialog.close === "function" && dialog.open) dialog.close();
    else dialog.removeAttribute("open");
    byId("userEditorDialogForm")?.replaceChildren();
    render();
  }

  async function saveUserEditor() {
    if (!userEditorModalState || isLoading) return;
    const saved = await save("user_master");
    if (saved) closeUserEditorModal(false);
  }

  function openTeamEditor(rowId) {
    if (teamEditorModalState || userEditorModalState) return;
    const draft = drafts.get("team_master");
    const entry = draft?.entries.find((item) => item.id === rowId);
    if (!entry) return;
    teamEditorModalState = {
      kind: "team",
      entryId: rowId,
      snapshot: captureUserEditorSnapshot(),
    };
    draft.selectedId = rowId;
    selectedOrganizationSpecial = "";
    render();
    const dialog = byId("teamEditorDialog");
    if (typeof dialog.showModal === "function" && !dialog.open) dialog.showModal();
    else dialog.setAttribute("open", "");
    requestAnimationFrame(() => {
      byId("teamEditorDialogForm")
        ?.querySelector("input:not(:disabled), select")
        ?.focus();
    });
  }

  function openDirectorEditor() {
    if (teamEditorModalState || userEditorModalState) return;
    if (!drafts.get("team_master")) return;
    teamEditorModalState = {
      kind: "director",
      entryId: "",
      snapshot: captureUserEditorSnapshot(),
    };
    const draft = drafts.get("team_master");
    if (draft) draft.selectedId = "";
    selectedOrganizationSpecial = "director";
    render();
    const dialog = byId("teamEditorDialog");
    if (typeof dialog.showModal === "function" && !dialog.open) dialog.showModal();
    else dialog.setAttribute("open", "");
    requestAnimationFrame(() => {
      byId("teamEditorDialogForm")
        ?.querySelector("input:not(:disabled), select")
        ?.focus();
    });
  }

  function renderTeamEditorDialog() {
    const state = teamEditorModalState;
    const form = byId("teamEditorDialogForm");
    if (!state || !form) return;
    destroyTeamEditorMemberSortables();
    const content = form.closest(".user-editor-dialog-content");
    content?.querySelector(".team-editor-dialog-header")?.remove();
    form.replaceChildren();
    if (state.kind === "director") {
      const header = document.createElement("header");
      header.className = "user-editor-dialog-header team-editor-dialog-header";
      const title = document.createElement("h2");
      title.id = "teamEditorDialogTitle";
      title.textContent = "部長を編集";
      header.append(title);
      content?.insertBefore(header, form);
      form.append(
        renderTeamEditorMembers("", "director"),
        createEditorActionBar({ modal: true }),
      );
      return;
    }
    const entry = drafts
      .get("team_master")
      ?.entries.find((item) => item.id === state?.entryId);
    if (!entry || !form) return;
    renderTeamEditorModal(form, entry);
  }

  function closeTeamEditorModal(discard = true) {
    const state = teamEditorModalState;
    if (!state) return;
    destroyTeamEditorMemberSortables();
    if (discard) restoreUserEditorSnapshot(state.snapshot);
    else {
      const draft = drafts.get("team_master");
      if (draft?.selectedId === state.entryId) draft.selectedId = "";
    }
    selectedOrganizationSpecial = "";
    teamEditorModalState = null;
    const dialog = byId("teamEditorDialog");
    if (typeof dialog.close === "function" && dialog.open) dialog.close();
    else dialog.removeAttribute("open");
    byId("teamEditorDialogForm")?.replaceChildren();
    render();
  }

  async function saveTeamEditor() {
    if (!teamEditorModalState || isLoading) return;
    const saved = await save("team_master");
    if (saved) closeTeamEditorModal(false);
  }

  async function changeFiscalYear(direction) {
    if (![-1, 1].includes(Number(direction))) return;
    if (isChangingFiscalYear) return;
    const targetFiscalYear = activeFiscalYear + Number(direction);
    if (targetFiscalYear < MIN_FISCAL_YEAR) return;
    const draft = drafts.get("calendar");
    if (!draft) return;
    if (!hasCalendarEntriesForFiscalYear(targetFiscalYear)) {
      isChangingFiscalYear = true;
      try {
        const confirmed = await requestConfirmationDialog({
          title: `${targetFiscalYear}年度のカレンダーを作りますか？`,
          description: `${targetFiscalYear}年度の土日を休日として作成します。`,
          confirmLabel: "作成する",
          cancelLabel: "キャンセル",
        });
        if (!confirmed) return;
        ensureFiscalYearEntries(targetFiscalYear);
      } finally {
        isChangingFiscalYear = false;
      }
    }
    activeFiscalYear = targetFiscalYear;
    calendarFocusDate = "";
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
    const date = calendarDate(dateText);
    if (
      !draft ||
      !definition ||
      !date ||
      fiscalYearForDate(date) < MIN_FISCAL_YEAR
    ) return;
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
    requestAnimationFrame(() => focusCalendarDate(dateText));
  }

  function handleCalendarGridKeydown(event) {
    const current = event.target.closest(".fiscal-calendar-day[data-calendar-date]");
    if (!current || event.altKey || event.metaKey) return false;
    const currentDate = current.dataset.calendarDate;
    const parsed = calendarDate(currentDate);
    if (!parsed) return false;

    let targetDate = "";
    if (event.key === "ArrowLeft") targetDate = offsetCalendarDate(currentDate, -1);
    else if (event.key === "ArrowRight") targetDate = offsetCalendarDate(currentDate, 1);
    else if (event.key === "ArrowUp") targetDate = offsetCalendarDate(currentDate, -7);
    else if (event.key === "ArrowDown") targetDate = offsetCalendarDate(currentDate, 7);
    else if (event.key === "Home") {
      targetDate = offsetCalendarDate(currentDate, -parsed.getUTCDay());
    } else if (event.key === "End") {
      targetDate = offsetCalendarDate(currentDate, 6 - parsed.getUTCDay());
    } else if (event.key === "PageUp") {
      targetDate = offsetCalendarMonth(currentDate, -1);
    } else if (event.key === "PageDown") {
      targetDate = offsetCalendarMonth(currentDate, 1);
    } else {
      return false;
    }

    event.preventDefault();
    const target = findCalendarDayButton(targetDate);
    if (!target) return true;
    calendarFocusDate = targetDate;
    syncCalendarRovingTabindex(targetDate);
    target.focus({ preventScroll: false });
    return true;
  }

  function offsetCalendarDate(dateText, dayOffset) {
    const target = calendarDate(dateText);
    if (!target) return "";
    target.setUTCDate(target.getUTCDate() + dayOffset);
    return calendarIsoDate(
      target.getUTCFullYear(),
      target.getUTCMonth(),
      target.getUTCDate(),
    );
  }

  function offsetCalendarMonth(dateText, monthOffset) {
    const parts = calendarDateParts(dateText);
    if (!parts) return "";
    const first = new Date(Date.UTC(parts.year, parts.monthIndex + monthOffset, 1));
    const lastDay = new Date(
      Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0),
    ).getUTCDate();
    return calendarIsoDate(
      first.getUTCFullYear(),
      first.getUTCMonth(),
      Math.min(parts.day, lastDay),
    );
  }

  function findCalendarDayButton(dateText) {
    return [...document.querySelectorAll(".fiscal-calendar-day[data-calendar-date]")]
      .find((button) => button.dataset.calendarDate === dateText) || null;
  }

  function syncCalendarRovingTabindex(dateText) {
    document
      .querySelectorAll(".fiscal-calendar-day[data-calendar-date]")
      .forEach((button) => {
        button.tabIndex = button.dataset.calendarDate === dateText ? 0 : -1;
      });
  }

  function focusCalendarDate(dateText) {
    const target = findCalendarDayButton(dateText);
    if (!target) return;
    syncCalendarRovingTabindex(dateText);
    target.focus({ preventScroll: true });
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

  function toggleOrganizationSections(teamId) {
    if (!teamId) return;
    if (expandedOrganizationIds.has(teamId)) expandedOrganizationIds.delete(teamId);
    else expandedOrganizationIds.add(teamId);
    renderTable();
  }

  function addRow() {
    if (hasEditorChanges(activeMaster)) {
      notify({ text: "現在の編集内容を保存してから追加してください。", type: "warning" });
      return;
    }
    if (activeMaster === "team_master") {
      openTeamCreateDialog("department", "");
      return;
    }
    const definition = getDefinition();
    const draft = getDraft();
    const snapshotState =
      activeMaster === "user_master" ? captureUserEditorSnapshot() : null;
    const entry = createEntry({}, definition, true);
    draft.entries.push(entry);
    draft.selectedId = entry.id;
    searchText = "";
    if (activeMaster === "user_master") {
      openUserEditor(entry.id, snapshotState);
      return;
    }
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
    if (!definition || !draft || !["department", "section"].includes(level)) return;
    if (hasEditorChanges("team_master")) {
      notify({ text: "現在の編集内容を保存してから追加してください。", type: "warning" });
      return;
    }
    const parent = draft.entries.find(
      (entry) => valueFor(entry, "team_id") === parentTeamId,
    );
    const validParent =
      level === "department"
        ? !parentTeamId
        : Boolean(parentTeamId) &&
          level === "section" && valueFor(parent, "team_type") === "department";
    if (level === "department" && parentTeamId) return;
    if (!validParent) return;
    const snapshotState = captureUserEditorSnapshot();

    const entry = createEntry(
      {
        team_id: createTeamId(),
        team_name: String(teamName).trim(),
        team_type: level,
        parent_team_id: parentTeamId,
        sort_order: String(nextSiblingOrder(parentTeamId)),
      },
      definition,
      true,
    );
    draft.entries.push(entry);
    draft.selectedId = entry.id;
    selectedOrganizationDepartmentId =
      level === "department" ? valueFor(entry, "team_id") : parentTeamId;
    if (parentTeamId) expandedOrganizationIds.add(parentTeamId);
    searchText = "";
    openTeamEditor(entry.id, snapshotState);
  }

  function openTeamCreateDialog(level = "department", parentTeamId = "") {
    if (hasEditorChanges("team_master")) {
      notify({ text: "現在の編集内容を保存してから追加してください。", type: "warning" });
      return;
    }
    if (teamEditorModalState) closeTeamEditorModal(false);
    const dialog = byId("teamCreateDialog");
    const levelInput = byId("teamCreateLevel");
    const nextLevel = ["department", "section"].includes(level) ? level : "department";
    levelInput.value = nextLevel;
    byId("teamCreateDialogTitle").textContent = nextLevel === "section" ? "係を追加" : "課を追加";
    byId("teamCreateNameLabel").textContent = nextLevel === "section" ? "係名" : "課名";
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
    const parentTeamId = byId("teamCreateParent")?.dataset.teamId || "";
    const teamName = byId("teamCreateName").value.trim();
    if (level !== "department" && !teamEntryFor(parentTeamId)) {
      byId("teamCreateError").textContent = "親課を選択してください。";
      return;
    }
    closeTeamCreateDialog();
    addTeam(level, parentTeamId, teamName);
  }

  function renderTeamCreateParentChoices(preferredParentId = null) {
    const level = byId("teamCreateLevel").value;
    const nameField = byId("teamCreateName").closest(".inspector-field");
    let parentField = byId("teamCreateParentField");
    if (level === "section" && !parentField) {
      parentField = document.createElement("label");
      parentField.id = "teamCreateParentField";
      parentField.className = "inspector-field";
      const label = document.createElement("span");
      label.className = "inspector-field-label";
      label.textContent = "親課";
      const input = document.createElement("input");
      input.id = "teamCreateParent";
      input.dataset.teamCreateParent = "true";
      input.type = "text";
      input.readOnly = true;
      input.setAttribute("aria-readonly", "true");
      input.autocomplete = "off";
      parentField.append(label, input);
      nameField?.before(parentField);
    } else if (level !== "section") {
      parentField?.remove();
      parentField = null;
    }
    const parentInput = byId("teamCreateParent");
    const currentParentId = preferredParentId ?? parentInput?.dataset.teamId ?? "";
    const parent = level === "section" ? teamEntryFor(currentParentId) : null;
    if (parentField && parentInput) {
      parentInput.dataset.teamId = parent ? currentParentId : "";
      parentInput.value = parent ? teamPathLabel(parent) : "";
      parentInput.required = level === "section";
    }
    updateTeamCreateDialogState();
  }

  function updateTeamCreateDialogState() {
    const level = byId("teamCreateLevel").value;
    const parentTeamId = byId("teamCreateParent")?.dataset.teamId || "";
    const teamName = byId("teamCreateName").value.trim();
    const parent = teamEntryFor(parentTeamId);
    byId("confirmTeamCreateButton").disabled =
      !teamName || (level !== "department" && !parent);
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

  async function deleteSelectedRow(rowId = "") {
    const draft = getDraft();
    const targetId = rowId || draft.selectedId;
    const index = draft.entries.findIndex(
      (entry) => entry.id === targetId,
    );
    if (index < 0) return;
    const entry = draft.entries[index];
    if (activeMaster === "user_master" && isProtectedAdministratorEntry(entry)) {
      return;
    }
    const relatedDraftSnapshots = [
      "user_master",
      "team_master",
      "comment_assignment",
    ].map((key) => {
      const relatedDraft = drafts.get(key);
      return {
        key,
        selectedId: relatedDraft?.selectedId || "",
        entries: (relatedDraft?.entries || []).map((item) => ({
          entry: item,
          values: { ...item.values },
          isNew: item.isNew,
        })),
      };
    });
    if (activeMaster === "team_master") {
      const teamId = valueFor(entry, "team_id");
      const hasChildren = draft.entries.some(
        (candidate) => valueFor(candidate, "parent_team_id") === teamId,
      );
      const hasMembers = drafts
        .get("user_master")
        ?.entries.some((user) => valueFor(user, "organization_id") === teamId);
      const isReferenced = (drafts.get("comment_assignment")?.entries || []).some(
        (assignment) =>
          splitIds(valueFor(assignment, "target_organization_ids")).includes(teamId),
      );
      if (hasChildren || hasMembers || isReferenced) {
        notify({
          text: hasChildren
            ? "下位チームが残っています。先に下位チームを移動または削除してください。"
            : hasMembers
              ? "所属ユーザーが残っています。先にユーザーの所属を変更してください。"
              : "コメント対象の設定から参照されています。先にユーザー管理で対象を変更してください。",
          type: "error",
        });
        return;
      }
    }
    const definition = getDefinition();
    const identifyingValue = valueFor(entry, definition.columns[0]?.key);
    const confirmed = await requestConfirmationDialog({
      title: "削除の確認",
      description: `「${identifyingValue || "この行"}」を削除します。`,
      confirmLabel: "削除",
      cancelLabel: "キャンセル",
      confirmTone: "danger",
      confirmationVariant: "delete",
    });
    if (!confirmed) return;
    if (teamEditorModalState) closeTeamEditorModal(false);
    if (activeMaster === "team_master") {
      expandedOrganizationIds.delete(valueFor(entry, "team_id"));
    }
    if (activeMaster === "user_master") {
      const employeeId = valueFor(entry, "employee_id");
      (drafts.get("comment_assignment")?.entries || []).forEach((assignment) => {
        if (valueFor(assignment, "commenter_employee_id") === employeeId) {
          return;
        }
        assignment.values.target_employee_ids = splitIds(
          valueFor(assignment, "target_employee_ids"),
        )
          .filter((targetId) => targetId !== employeeId)
          .join(";");
        if (
          valueFor(assignment, "target_type") === "custom" &&
          !assignment.values.target_employee_ids
        ) {
          assignment.values.target_type = "none";
        }
      });
      const assignmentDraft = drafts.get("comment_assignment");
      assignmentDraft.entries = assignmentDraft.entries.filter(
        (assignment) => valueFor(assignment, "commenter_employee_id") !== employeeId,
      );
    }
    draft.entries.splice(index, 1);
    draft.selectedId = "";
    render();
    const saved = await save();
    if (!saved) {
      relatedDraftSnapshots.forEach((snapshotState) => {
        const relatedDraft = drafts.get(snapshotState.key);
        if (!relatedDraft) return;
        snapshotState.entries.forEach(({ entry: snapshotEntry, values, isNew }) => {
          snapshotEntry.values = { ...values };
          snapshotEntry.isNew = isNew;
        });
        relatedDraft.entries = snapshotState.entries.map(({ entry: snapshotEntry }) => snapshotEntry);
        relatedDraft.selectedId = snapshotState.selectedId;
      });
      render();
    }
  }

  function updateSelectedRow(event) {
    const input = event.target.closest("[data-column]");
    if (!input) return;
    if (input.type === "radio" && !input.checked) return;
    const draft = getDraft();
    const entry = draft.entries.find((item) => item.id === draft.selectedId);
    if (!entry) return;
    const previousValue = entry.values[input.dataset.column];
    const nextValue =
      input.type === "checkbox" ? (input.checked ? "1" : "0") : input.value;
    if (
      activeMaster === "user_master" && input.dataset.column === "is_admin" &&
      nextValue === "0" && valueFor(entry, "is_admin") === "1" &&
      regularAdministratorCount() <= 1
    ) {
      input.checked = true;
      notifyAdministratorGuard("権限を変更");
      return;
    }
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
    if (
      activeMaster === "user_master" &&
      input.dataset.column === "employee_id" &&
      previousValue !== nextValue
    ) {
      const assignment = assignmentEntryForUser(previousValue);
      if (assignment) assignment.values.commenter_employee_id = nextValue;
    }
    if (input.dataset.column === "employment_type" && nextValue === "temporary") {
      entry.values.is_admin = "0";
      if (activeMaster === "user_master") {
        resetCommentAssignment(valueFor(entry, "employee_id"));
      }
    }
    if (input.dataset.column === "team_level") {
      entry.values.parent_team_id = "";
    }
    if (input.dataset.column === "team_type") {
      entry.values.parent_team_id = nextValue === "department" ? "" : entry.values.parent_team_id;
    }
    if (input.dataset.column === "commenter_scope" && nextValue !== "custom") {
      entry.values.target_employee_ids = "";
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
      (event.type === "change" ||
        (event.type === "input" && input.dataset.column === "employment_type")) &&
      ((input.dataset.column === "employee_id" && entry.isNew) ||
        input.dataset.column === "employment_type" ||
        input.dataset.column === "team_type" ||
        input.dataset.column === "team_level" ||
        input.dataset.column === "parent_team_id" ||
        input.dataset.column === "commenter_scope")
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
    byId("adminPanel").classList.toggle(
      "is-calendar-master",
      activeMaster === "calendar",
    );
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
    byId("masterInspector").hidden =
      activeMaster === "calendar" ||
      activeMaster === "user_master" ||
      activeMaster === "team_master";
    renderMasterNav();
    renderTableHeading();
    renderTable();
    renderInspector();
    syncAdminChrome();
  }

  function renderMasterNav() {
    const navigation = byId("masterNav");
    navigation.replaceChildren();
    MASTER_DEFINITIONS.filter((definition) => !definition.hidden).forEach((definition) => {
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
    const addButton = byId("adminAddRowButton");
    const title = byId("adminTableTitle");
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
    title.hidden = ["user_master", "calendar"].includes(definition.key);
    addButton.hidden = isTeam || definition.key === "calendar";
    searchControl.hidden = isTeam || definition.key === "calendar";
    searchInput.placeholder =
      definition.key === "team_master"
        ? "チームを検索"
        : definition.key === "user_master"
          ? "社員番号・氏名を検索"
          : "日付を検索";
    searchInput.setAttribute(
      "aria-label",
      definition.key === "user_master"
        ? "社員番号・氏名を検索"
        : definition.key === "team_master"
          ? "チームを検索"
          : "日付を検索",
    );
    searchInput.value = searchText;
    byId("adminSearchClearButton").hidden = !searchInput.value;
  }

  function filteredEntries() {
    const draft = getDraft();
    if (!searchText) return draft.entries;
    const searchableKeys =
      activeMaster === "user_master" ? ["employee_id", "display_name"] : null;
    return draft.entries.filter((entry) =>
      (searchableKeys || Object.keys(entry.values)).some((key) =>
        String(entry.values[key] ?? "").toLocaleLowerCase("ja").includes(searchText),
      ),
    );
  }

  function renderTable() {
    if (activeMaster === "user_master" && userEditorModalState) return;
    if (activeMaster === "team_master" && teamEditorModalState) return;
    if (activeMaster !== "team_master") destroyOrganizationSortables();
    const draft = getDraft();
    if (activeMaster === "team_master") {
      renderTeamTree(draft);
      renderOrganizationMigrationNotice();
      return;
    }
    if (activeMaster === "calendar") {
      renderCalendarList(draft);
      return;
    }
    renderUserList(draft);
    renderOrganizationMigrationNotice();
  }

  function renderOrganizationMigrationNotice() {
    if (!organizationMigrationState || activeMaster === "calendar") return;
    const notice = document.createElement("section");
    notice.className = "organization-migration-notice";
    notice.setAttribute("role", "status");
    const title = document.createElement("strong");
    title.textContent = "旧組織データの移行確認が必要です";
    const description = document.createElement("p");
    const unresolved = organizationMigrationState.unresolvedEmployeeIds.length;
    const ambiguous = organizationMigrationState.ambiguousTeamIds.length;
    description.textContent =
      "課・係の候補だけを編集用に展開しました。コメント担当は全員「なし」です。" +
      (ambiguous || unresolved
        ? ` 旧チーム${ambiguous}件、所属未確定ユーザー${unresolved}人を解消してから保存してください。`
        : " 所属とコメント担当を確認し、保存すると新形式へ確定します。");
    notice.append(title, description);
    if (organizationMigrationState.legacyAssignments.length) {
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = `旧コメント担当設定を参照（${organizationMigrationState.legacyAssignments.length}件）`;
      const list = document.createElement("ul");
      organizationMigrationState.legacyAssignments.forEach((assignment) => {
        const item = document.createElement("li");
        item.textContent = `${assignment.teamName}: 担当 ${assignment.commenters} / 範囲 ${assignment.scope} / 個別対象 ${assignment.targets}`;
        list.append(item);
      });
      details.append(summary, list);
      notice.append(details);
    }
    byId("adminTableWrap").prepend(notice);
  }

  function renderUserList(draft) {
    const entries = filteredEntries().slice().sort(compareUserListEntries);
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
      "社員番号",
      "氏名",
      "雇用区分",
      "権限",
      "日報入力",
      "所属組織",
      "コメント対象",
    ].forEach((label) => {
      const th = document.createElement("th");
      th.scope = "col";
      th.textContent = label;
      headerRow.append(th);
    });
    const actionHeading = document.createElement("th");
    actionHeading.className = "organization-user-actions-heading";
    actionHeading.scope = "col";
    actionHeading.setAttribute("aria-label", "操作");
    headerRow.append(actionHeading);
    head.append(headerRow);
    const body = document.createElement("tbody");
    entries.forEach((entry) => {
      const row = document.createElement("tr");
      row.tabIndex = 0;
      row.dataset.rowId = entry.id;
      row.classList.toggle("is-selected", entry.id === draft.selectedId);
      row.setAttribute("aria-selected", String(entry.id === draft.selectedId));
      const employeeId = document.createElement("td");
      employeeId.textContent = valueFor(entry, "employee_id") || "—";
      const name = document.createElement("td");
      name.textContent = valueFor(entry, "display_name") || valueFor(entry, "employee_id") || "—";
      const employment = document.createElement("td");
      employment.textContent = employmentTypeLabel(valueFor(entry, "employment_type"));
      const administrator = document.createElement("td");
      administrator.textContent = valueFor(entry, "is_admin") === "1" ? "管理者" : "一般";
      const team = document.createElement("td");
      team.textContent = affiliationLabel(entry);
      const managed = document.createElement("td");
      managed.textContent = commentAssignmentSummary(
        valueFor(entry, "employee_id"),
      );
      const ownReport = document.createElement("td");
      ownReport.textContent = valueFor(entry, "can_input_own_report") === "0" ? "不要" : "要";
      const actions = document.createElement("td");
      actions.className = "organization-user-actions";
      const actionGroup = document.createElement("div");
      actionGroup.className = "api-key-actions";
      actionGroup.setAttribute("role", "toolbar");
      const displayLabel = valueFor(entry, "display_name") || valueFor(entry, "employee_id") || "ユーザー";
      actionGroup.setAttribute("aria-label", displayLabel + "の操作");
      actionGroup.append(
        createUserRowAction("edit", entry, displayLabel),
        createUserRowAction("delete", entry, displayLabel),
      );
      actions.append(actionGroup);
      row.append(employeeId, name, employment, administrator, ownReport, team, managed, actions);
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
    const previous = createFiscalYearButton(-1, "前年度を表示");
    const year = document.createElement("strong");
    year.className = "fiscal-year-label";
    year.textContent = `${activeFiscalYear}年度`;
    year.setAttribute("aria-live", "polite");
    const next = createFiscalYearButton(1, "次年度を表示");
    yearNavigation.append(previous, year, next);

    const legend = document.createElement("div");
    legend.className = "fiscal-calendar-legend";
    const holidayLegend = document.createElement("span");
    holidayLegend.className = "calendar-legend-item";
    holidayLegend.innerHTML = '<i class="calendar-holiday-swatch" aria-hidden="true"></i>休日';
    const summary = document.createElement("span");
    summary.className = "fiscal-calendar-summary";
    summary.textContent = `休日（計 ${holidayCount}日）`;
    legend.append(holidayLegend, summary);
    const toolbarActions = document.createElement("div");
    toolbarActions.className = "fiscal-calendar-toolbar-actions";
    toolbarActions.append(legend, createEditorActionBar());
    toolbar.append(yearNavigation, toolbarActions);

    const calendar = document.createElement("div");
    calendar.className = "fiscal-calendar-grid";
    calendar.setAttribute("role", "grid");
    calendar.setAttribute("aria-label", `${activeFiscalYear}年度カレンダー`);
    calendarFocusDate = getCalendarFocusDate();
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

  function getCalendarFocusDate() {
    const candidate = calendarDate(calendarFocusDate);
    if (candidate && fiscalYearForDate(candidate) === activeFiscalYear) {
      return calendarFocusDate;
    }
    const today = new Date();
    const todayText = calendarIsoDate(
      today.getFullYear(),
      today.getMonth(),
      today.getDate(),
    );
    const todayDate = calendarDate(todayText);
    if (todayDate && fiscalYearForDate(todayDate) === activeFiscalYear) {
      return todayText;
    }
    return calendarIsoDate(activeFiscalYear, 3, 1);
  }

  function createFiscalYearButton(direction, label) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "fiscal-year-button";
    button.dataset.calendarYearAction = String(direction);
    button.setAttribute("aria-label", label);
    button.disabled = direction < 0 && activeFiscalYear <= MIN_FISCAL_YEAR;
    button.append(
      createTeamSvgIcon(
        direction < 0 ? "m15 18-6-6 6-6" : "m9 18 6-6-6-6",
      ),
    );
    return button;
  }

  function createCalendarMonth(year, monthIndex, entriesByDate) {
    const month = document.createElement("section");
    month.className = "fiscal-calendar-month";
    month.setAttribute("role", "rowgroup");
    const heading = document.createElement("h4");
    heading.id = `fiscal-calendar-month-${year}-${monthIndex + 1}`;
    heading.textContent = `${monthIndex + 1}月`;
    month.setAttribute("aria-labelledby", heading.id);
    const weekdays = document.createElement("div");
    weekdays.className = "fiscal-calendar-weekdays";
    weekdays.setAttribute("role", "row");
    ["日", "月", "火", "水", "木", "金", "土"].forEach((label, index) => {
      const weekday = document.createElement("span");
      weekday.textContent = label;
      weekday.setAttribute("role", "columnheader");
      weekday.classList.toggle("is-sunday", index === 0);
      weekday.classList.toggle("is-saturday", index === 6);
      weekdays.append(weekday);
    });
    const days = document.createElement("div");
    days.className = "fiscal-calendar-days";
    days.setAttribute("role", "presentation");
    const firstWeekday = new Date(Date.UTC(year, monthIndex, 1)).getUTCDay();
    const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
    let cellIndex = 0;
    let week = null;
    const appendCell = (cell) => {
      if (cellIndex % 7 === 0) {
        week = document.createElement("div");
        week.className = "fiscal-calendar-week";
        week.setAttribute("role", "row");
        days.append(week);
      }
      week.append(cell);
      cellIndex += 1;
    };
    const appendEmptyCell = () => {
      const empty = document.createElement("span");
      empty.className = "fiscal-calendar-cell fiscal-calendar-day-empty";
      empty.setAttribute("role", "gridcell");
      empty.setAttribute("aria-hidden", "true");
      appendCell(empty);
    };
    for (let index = 0; index < firstWeekday; index += 1) appendEmptyCell();
    for (let day = 1; day <= lastDay; day += 1) {
      const dateText = calendarIsoDate(year, monthIndex, day);
      const entry = entriesByDate.get(dateText);
      const isHoliday = Boolean(entry);
      const cell = document.createElement("span");
      cell.className = "fiscal-calendar-cell";
      cell.setAttribute("role", "gridcell");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "fiscal-calendar-day";
      button.dataset.calendarDate = dateText;
      button.tabIndex = dateText === calendarFocusDate ? 0 : -1;
      button.classList.toggle("is-holiday", isHoliday);
      button.setAttribute("aria-pressed", String(isHoliday));
      button.setAttribute(
        "aria-label",
        `${calendarDateLabel(dateText)}、${isHoliday ? "休日" : "稼働日"}。押すと${isHoliday ? "稼働日" : "休日"}に変更`,
      );
      const number = document.createElement("span");
      number.textContent = String(day);
      button.append(number);
      cell.append(button);
      appendCell(cell);
    }
    while (cellIndex % 7 !== 0) appendEmptyCell();
    month.append(heading, weekdays, days);
    return month;
  }

  function renderOrganizationTree(draft) {
    const wrap = byId("adminTableWrap");
    destroyOrganizationSortables();
    wrap.replaceChildren();
    const browser = document.createElement("section");
    browser.className = "team-browser organization-browser-v2";
    browser.setAttribute("aria-label", "課と係の管理");
    const columns = document.createElement("div");
    columns.className = "organization-browser-columns";

    const departmentPane = document.createElement("section");
    departmentPane.className = "organization-pane organization-department-pane";
    departmentPane.setAttribute("aria-labelledby", "organization-departments-heading");
    const departmentHeading = createOrganizationPaneHeading(
      "organization-departments-heading",
      "課",
    );
    const addDepartment = createOrganizationAddButton("課を追加");
    addDepartment.dataset.addTeamRoot = "true";
    addDepartment.classList.add("organization-department-add");
    departmentHeading.append(addDepartment);
    const departmentList = document.createElement("div");
    departmentList.className = "organization-card-list organization-department-list";
    departmentList.dataset.organizationSortList = "departments";
    departmentList.setAttribute("role", "list");
    departmentList.setAttribute("aria-label", "課一覧");

    const departments = draft.entries
      .filter((entry) => valueFor(entry, "team_type") === "department")
      .sort(compareTeamEntries);
    const selectedDepartment = departments.find(
      (entry) => valueFor(entry, "team_id") === selectedOrganizationDepartmentId,
    );
    if (selectedOrganizationDepartmentId && !selectedDepartment) {
      selectedOrganizationDepartmentId = "";
    }
    departments.forEach((department) => {
      const departmentId = valueFor(department, "team_id");
      departmentList.append(
        createOrganizationCard(department, {
          organizationId: departmentId,
          draggable: true,
          selectable: true,
          selected: departmentId === selectedOrganizationDepartmentId,
        }),
      );
    });
    if (!departments.length) {
      const empty = document.createElement("p");
      empty.className = "admin-table-empty team-browser-empty organization-pane-empty";
      empty.textContent = "課がありません。「課を追加」から作成してください。";
      departmentList.append(empty);
    }
    departmentPane.append(departmentHeading, departmentList);

    const sectionPane = document.createElement("section");
    sectionPane.className = "organization-pane organization-section-pane";
    sectionPane.setAttribute("aria-labelledby", "organization-sections-heading");
    const activeDepartment = departments.find(
      (entry) => valueFor(entry, "team_id") === selectedOrganizationDepartmentId,
    );
    const activeDepartmentId = valueFor(activeDepartment, "team_id");
    const activeDepartmentName = valueFor(activeDepartment, "team_name") || "選択した課";
    const sections = activeDepartmentId
      ? draft.entries
          .filter(
            (entry) =>
              valueFor(entry, "team_type") === "section" &&
              valueFor(entry, "parent_team_id") === activeDepartmentId,
          )
          .sort(compareTeamEntries)
      : [];
    const sectionHeading = createOrganizationPaneHeading(
      "organization-sections-heading",
      activeDepartmentId ? `${activeDepartmentName}の係` : "係",
    );
    sectionHeading.querySelector("h2")?.setAttribute("aria-live", "polite");
    const addSection = createOrganizationAddButton("係を追加");
    addSection.classList.add("organization-section-add");
    addSection.dataset.addChildLevel = "section";
    addSection.dataset.parentTeamId = activeDepartmentId;
    addSection.disabled = !activeDepartmentId;
    addSection.hidden = !activeDepartmentId;
    sectionHeading.append(addSection);
    const sectionList = document.createElement("div");
    sectionList.className = "organization-card-list organization-section-list";
    sectionList.dataset.organizationSortList = "sections";
    sectionList.dataset.organizationParentTeamId = activeDepartmentId;
    sectionList.setAttribute("role", "list");
    sectionList.setAttribute("aria-label", activeDepartmentId ? `${activeDepartmentName}の係一覧` : "係一覧");
    sections.forEach((section) => {
      sectionList.append(
        createOrganizationCard(section, {
          organizationId: valueFor(section, "team_id"),
          draggable: true,
          selectable: false,
        }),
      );
    });
    if (!activeDepartmentId) {
      const empty = document.createElement("p");
      empty.className = "admin-table-empty team-browser-empty organization-pane-empty";
      empty.textContent = departments.length ? "課を選択してください。" : "課がありません。";
      sectionList.append(empty);
    } else if (!sections.length) {
      const empty = document.createElement("p");
      empty.className = "admin-table-empty team-browser-empty organization-pane-empty";
      empty.textContent = "この課には係がありません。";
      sectionList.append(empty);
    }
    sectionPane.append(sectionHeading, sectionList);
    columns.append(departmentPane, sectionPane);
    browser.append(columns);
    wrap.append(browser);
    initializeOrganizationSortables();
  }

  function createOrganizationPaneHeading(id, titleText) {
    const heading = document.createElement("div");
    heading.className = "organization-pane-heading";
    const title = document.createElement("h2");
    title.id = id;
    title.textContent = titleText;
    heading.append(title);
    return heading;
  }

  function createOrganizationAddButton(label) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "admin-add-button";
    const icon = document.createElement("span");
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "＋";
    button.append(icon, label);
    return button;
  }

  function createOrganizationDirectorCard() {
    const card = document.createElement("article");
    card.className = "organization-card organization-director-card";
    card.dataset.directorGroup = "true";
    card.setAttribute("role", "treeitem");
    card.append(
      createOrganizationCardHeader(
        "部長",
        "director",
      ),
    );
    return card;
  }

  function createOrganizationCard(entry, options = {}) {
    const teamId = valueFor(entry, "team_id");
    const type = valueFor(entry, "team_type");
    const card = document.createElement("article");
    card.className = `organization-card organization-${type}-card`;
    card.dataset.rowId = entry.id;
    card.dataset.teamId = teamId;
    card.dataset.organizationCard = "true";
    card.dataset.organizationLevel = type;
    card.setAttribute("role", "listitem");
    if (type === "department" && options.selectable) {
      card.classList.toggle("is-selected", Boolean(options.selected));
    }
    card.append(
      createOrganizationCardHeader(
        valueFor(entry, "team_name") || "名称未設定",
        entry.id,
        {
          organizationId: teamId,
          draggable: options.draggable !== false,
          selectable: Boolean(options.selectable),
          selected: Boolean(options.selected),
        },
      ),
    );
    return card;
  }

  function createOrganizationCardHeader(nameText, editId, options = {}) {
    const header = document.createElement("div");
    header.className = "organization-card-header";
    if (options.draggable) {
      header.append(createOrganizationDragHandle(options.organizationId, nameText));
    }
    const name = document.createElement("strong");
    name.textContent = nameText;
    const copy = document.createElement("div");
    copy.className = "organization-card-copy";
    copy.append(name);
    if (options.selectable) {
      const select = document.createElement("button");
      select.type = "button";
      select.className = "organization-card-select";
      select.dataset.organizationSelect = options.organizationId;
      select.setAttribute("aria-label", `${nameText}を選択`);
      select.setAttribute("aria-pressed", String(Boolean(options.selected)));
      select.setAttribute("aria-current", options.selected ? "true" : "false");
      select.append(copy);
      header.append(select);
    } else {
      header.append(copy);
    }
    const actions = document.createElement("div");
    actions.className = "organization-card-header-actions";
    actions.append(createOrganizationEditButton(editId, nameText));
    header.append(actions);
    return header;
  }

  function createOrganizationToggleButton(teamId, sectionCount, expanded) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "organization-card-toggle";
    button.dataset.organizationToggle = teamId;
    button.setAttribute("aria-expanded", String(expanded));
    button.setAttribute("aria-label", `係${sectionCount}件を${expanded ? "閉じる" : "開く"}`);
    button.title = expanded ? "係を閉じる" : "係を表示";
    button.append(
      createTeamSvgIcon(expanded ? "m5 15 7-7 7 7" : "m5 9 7 7 7-7"),
      document.createTextNode(`係 ${sectionCount}件`),
    );
    return button;
  }

  function createOrganizationDragHandle(teamId, nameText) {
    const handle = document.createElement("span");
    handle.className = "organization-drag-handle";
    handle.dataset.organizationDragHandle = teamId;
    handle.setAttribute("role", "img");
    handle.setAttribute("aria-label", `${nameText}の並び順をドラッグで変更`);
    handle.title = "ドラッグで並び替え";
    handle.append(
      createTeamSvgIcon(
        "M7 5h2v2H7V5Zm4 0h2v2h-2V5ZM7 11h2v2H7v-2Zm4 0h2v2h-2v-2ZM7 17h2v2H7v-2Zm4 0h2v2h-2v-2Z",
      ),
    );
    return handle;
  }

  function organizationCardsIn(list) {
    return [...(list?.children || [])].filter((child) =>
      child.matches("[data-organization-card]"),
    );
  }

  function organizationOrderIn(list) {
    return organizationCardsIn(list).map((card) => card.dataset.teamId);
  }

  function organizationOrderSnapshot(list) {
    return organizationOrderIn(list).map((teamId) => ({
      teamId,
      sortOrder: valueFor(teamEntryFor(teamId), "sort_order"),
    }));
  }

  function initializeOrganizationSortables() {
    if (typeof window.Sortable !== "function") {
      notify({
        text: "組織の並び替え機能を読み込めませんでした。",
        type: "error",
      });
      return;
    }
    const wrap = byId("adminTableWrap");
    wrap.querySelectorAll("[data-organization-sort-list]").forEach((list) => {
      const sortable = new window.Sortable(list, {
        animation: 160,
        bubbleScroll: true,
        chosenClass: "organization-card-sortable-chosen",
        draggable: "[data-organization-card]",
        dragClass: "organization-card-sortable-drag",
        fallbackOnBody: false,
        fallbackTolerance: 3,
        forceFallback: true,
        group: {
          name: "organization-same-level",
          pull: false,
          put: false,
        },
        ghostClass: "organization-card-sortable-ghost",
        handle: "[data-organization-drag-handle]",
        invertSwap: false,
        scroll: true,
        scrollSensitivity: 60,
        scrollSpeed: 12,
        swapThreshold: 0.55,
        onMove: (event) =>
          event.from === list && event.to === list && event.related !== event.dragged,
        onStart: (event) => {
          if (activeMaster !== "team_master" || isLoading || organizationDragState) {
            event.preventDefault?.();
            return;
          }
          organizationDragState = {
            card: event.item,
            list,
            previousOrder: organizationOrderSnapshot(list),
          };
          event.item.classList.add("is-dragging");
        },
        onEnd: () => {
          commitOrganizationDrag();
        },
      });
      list.dataset.organizationSortable = "true";
      organizationSortableInstances.push(sortable);
    });
  }

  function destroyOrganizationSortables() {
    organizationSortableInstances.forEach((sortable) => sortable.destroy());
    organizationSortableInstances = [];
    organizationDragState = null;
  }

  function teamEditorMemberCardsIn(list) {
    return [...(list?.children || [])].filter((child) =>
      child.matches("[data-team-editor-member-card]"),
    );
  }

  function teamEditorMemberOrderIn(list) {
    return teamEditorMemberCardsIn(list).map((card) => card.dataset.employeeId || "");
  }

  function initializeTeamEditorMemberSortables() {
    if (typeof window.Sortable !== "function") return;
    const form = byId("teamEditorDialogForm");
    if (!form) return;
    form.querySelectorAll("[data-team-editor-member-list]").forEach((list) => {
      if (!teamEditorMemberCardsIn(list).length || list.dataset.teamEditorMemberSortable === "true") {
        return;
      }
      const sortable = new window.Sortable(list, {
        animation: 160,
        bubbleScroll: true,
        chosenClass: "team-editor-member-sortable-chosen",
        draggable: "[data-team-editor-member-card]",
        dragClass: "team-editor-member-sortable-drag",
        fallbackOnBody: false,
        fallbackTolerance: 3,
        forceFallback: true,
        ghostClass: "team-editor-member-sortable-ghost",
        handle: "[data-team-editor-member-drag-handle]",
        group: {
          name: "team-editor-members",
          pull: false,
          put: false,
        },
        scroll: true,
        scrollSensitivity: 60,
        scrollSpeed: 12,
        swapThreshold: 0.55,
        onMove: (event) => event.from === list && event.to === list,
        onStart: (event) => {
          if (activeMaster !== "team_master" || !teamEditorModalState || isLoading || teamEditorMemberDragState) {
            event.preventDefault?.();
            return;
          }
          teamEditorMemberDragState = {
            item: event.item,
            list,
            previousOrder: teamEditorMemberOrderIn(list),
          };
          event.item.classList.add("is-dragging");
        },
        onEnd: () => {
          commitTeamEditorMemberDrag();
        },
      });
      list.dataset.teamEditorMemberSortable = "true";
      teamEditorMemberSortableInstances.push(sortable);
    });
  }

  function destroyTeamEditorMemberSortables() {
    teamEditorMemberSortableInstances.forEach((sortable) => sortable.destroy());
    teamEditorMemberSortableInstances = [];
    if (teamEditorMemberDragState?.item) {
      teamEditorMemberDragState.item.classList.remove("is-dragging");
    }
    teamEditorMemberDragState = null;
    byId("teamEditorDialogForm")?.querySelectorAll(
      "[data-team-editor-member-list]",
    ).forEach((list) => {
      delete list.dataset.teamEditorMemberSortable;
    });
  }

  function commitTeamEditorMemberDrag() {
    const state = teamEditorMemberDragState;
    if (!state) return;
    const nextOrder = teamEditorMemberOrderIn(state.list);
    const previousOrder = state.previousOrder;
    const changed = nextOrder.some((employeeId, index) => employeeId !== previousOrder[index]);
    state.item.classList.remove("is-dragging");
    teamEditorMemberDragState = null;
    if (!changed) return;
    const userEntries = drafts.get("user_master")?.entries || [];
    const usersByEmployeeId = new Map(
      userEntries.map((entry) => [valueFor(entry, "employee_id"), entry]),
    );
    nextOrder.forEach((employeeId, index) => {
      const user = usersByEmployeeId.get(employeeId);
      if (user) user.values.member_order = String((index + 1) * 10);
    });
    syncAdminChrome();
  }

  function commitOrganizationDrag() {
    const state = organizationDragState;
    if (!state) return;
    const nextOrder = organizationOrderIn(state.list);
    const previousOrder = state.previousOrder.map(({ teamId }) => teamId);
    const changed = nextOrder.some((teamId, index) => teamId !== previousOrder[index]);
    state.card.classList.remove("is-dragging");
    organizationDragState = null;
    if (!changed) {
      renderTable();
      return;
    }
    const previousOrders = new Map(
      state.previousOrder.map(({ teamId, sortOrder }) => [teamId, sortOrder]),
    );
    const parentTeamId = state.list.dataset.organizationParentTeamId || "";
    nextOrder.forEach((teamId, index) => {
      const entry = teamEntryFor(teamId);
      if (!entry) return;
      entry.values.parent_team_id = parentTeamId;
      entry.values.sort_order = String((index + 1) * 10);
    });
    renderTable();
    syncAdminChrome();
    void saveOrganizationOrder(previousOrders);
  }

  async function saveOrganizationOrder(previousOrders) {
    const saved = await save("team_master");
    if (saved) return;
    previousOrders.forEach((sortOrder, teamId) => {
      const entry = teamEntryFor(teamId);
      if (entry) entry.values.sort_order = sortOrder;
    });
    renderTable();
    syncAdminChrome();
  }

  function createOrganizationEditButton(editId, nameText) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "organization-card-edit";
    button.dataset.organizationEdit = editId;
    button.setAttribute("aria-label", `${nameText}を編集`);
    button.title = "編集";
    const icon = createTeamSvgIcon(EMBEDDED_EDIT_ICON_PATH);
    const iconPath = icon.querySelector("path");
    iconPath.setAttribute("fill-rule", "evenodd");
    iconPath.setAttribute("clip-rule", "evenodd");
    iconPath.setAttribute("fill", "currentColor");
    button.append(icon);
    return button;
  }

  function renderTeamTree(draft) {
    return renderOrganizationTree(draft);
    /* istanbul ignore next -- legacy renderer retained for migration reference */
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
    heading.append(title);

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
    button.append(mark, name);
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
    select.append(name, metadata);
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
    ) || valueFor(left, "team_id").localeCompare(valueFor(right, "team_id"), "ja");
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
    return {
      department: "課",
      section: "係",
      large: "課",
      medium: "係",
      small: "旧チーム",
    }[level] || level || "—";
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
    if (activeMaster === "user_master") {
      const empty = byId("adminInspectorEmpty");
      const form = byId("adminInspectorForm");
      empty.classList.add("hidden");
      form.classList.add("hidden");
      form.replaceChildren();
      if (userEditorModalState) renderUserEditorDialog();
      return;
    }
    if (activeMaster === "team_master") {
      const empty = byId("adminInspectorEmpty");
      const form = byId("adminInspectorForm");
      empty.classList.add("hidden");
      form.classList.add("hidden");
      form.replaceChildren();
      if (teamEditorModalState) renderTeamEditorDialog();
      return;
    }
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
      renderOrganizationInspector(form, entry);
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
          // 課・係の2階層。既存smallは読み書き可能だが新規作成しない。
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
    if (valueFor(entry, "commenter_scope") === "custom") {
      assignmentGrid.append(renderTeamAssignmentCard(teamId, "target"));
    }

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
    form.append(header, assignmentGrid, settings, createEditorActionBar());
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
    copy.append(title);
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
    const isTarget = kind === "target";
    const currentEntries = isMember
      ? teamMemberEntries(teamId)
      : isTarget
        ? teamTargetEntries(teamId)
        : teamCommenterEntries(teamId);
    const card = document.createElement("section");
    card.className = "team-assignment-card assignment-card";
    const heading = document.createElement("div");
    heading.className = "section-heading";
    const title = document.createElement("h3");
      title.textContent = isMember
        ? "所属ユーザー"
        : isTarget
          ? "カスタム対象ユーザー"
        : valueFor(teamEntryFor(teamId), "commenter_scope") === "custom"
          ? "カスタム対象ユーザー"
          : "コメント担当ユーザー";
    heading.append(title);
    const list = document.createElement("div");
    list.className = "team-member-list member-list";
    if (!currentEntries.length) {
      const empty = document.createElement("p");
      empty.className = "team-assignment-empty";
      empty.textContent = isMember
        ? "所属ユーザーはまだいません。"
        : isTarget
          ? "カスタム対象ユーザーはまだいません。"
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
          : isTarget ? "コメント対象" : "コメント担当";
        meta.append(name, role);
        const orderControls = document.createElement("span");
        orderControls.className = "team-member-order-controls";
        if (!isTarget) {
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
            } else if (!isTarget) {
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
        remove.setAttribute("aria-label", `${displayNameFor(employeeId)}を対象から解除`);
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
      : isTarget ? "＋ 対象ユーザーを1人追加" : "＋ コメント担当を変更";
    const select = document.createElement("select");
    select.dataset.teamAssignmentSelect = "true";
    select.dataset.assignmentKind = kind;
    select.dataset.teamId = teamId;
    select.setAttribute(
      "aria-label",
      isMember ? "所属ユーザーを1人追加" : "カスタム対象ユーザーを1人追加",
    );
    const canAssignMembers = !isMember || isAssignableTeam(teamId);
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = !canAssignMembers
      ? "所属先の課・係・チームから変更してください"
      : isMember
        ? "ユーザーを追加…"
        : isTarget ? "対象ユーザーを追加…" : "担当者を追加…";
    select.append(placeholder);
    const currentIds = new Set(currentEntries.map((user) => valueFor(user, "employee_id")));
    const candidates = userEntriesForAssignment()
      .filter((user) => {
        const employeeId = valueFor(user, "employee_id");
        if (!employeeId || currentIds.has(employeeId)) return false;
        return (isMember || valueFor(user, "employment_type") !== "temporary") &&
          (!isTarget || !currentIds.has(employeeId));
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
    card.append(heading, list, picker);
    return card;
  }

  function userEntriesForAssignment() {
    return drafts.get("user_master")?.entries || [];
  }

  function compareUserEntries(left, right) {
    const leftOrder = Number(valueFor(left, "member_order") || 999999);
    const rightOrder = Number(valueFor(right, "member_order") || 999999);
    return leftOrder - rightOrder || displayNameFor(valueFor(left, "employee_id")).localeCompare(
      displayNameFor(valueFor(right, "employee_id")),
      "ja",
    ) || valueFor(left, "employee_id").localeCompare(
      valueFor(right, "employee_id"),
      "ja",
    );
  }

  function compareUserListEntries(left, right) {
    const organizationOrder = organizationDisplayOrder();
    const key = (entry) =>
      valueFor(entry, "affiliation_type") === "director"
        ? Number.MAX_SAFE_INTEGER
        : organizationOrder.get(valueFor(entry, "organization_id")) ??
          Number.MAX_SAFE_INTEGER - 1;
    return key(left) - key(right) || compareUserEntries(left, right);
  }

  function organizationDisplayOrder() {
    const entries = drafts.get("team_master")?.entries || [];
    const order = new Map();
    let index = 0;
    entries
      .filter((entry) => valueFor(entry, "team_type") === "department")
      .sort(compareTeamEntries)
      .forEach((department) => {
        const departmentId = valueFor(department, "team_id");
        entries
          .filter(
            (entry) =>
              valueFor(entry, "team_type") === "section" &&
              valueFor(entry, "parent_team_id") === departmentId,
          )
          .sort(compareTeamEntries)
          .forEach((section) => order.set(valueFor(section, "team_id"), index++));
        order.set(departmentId, index++);
      });
    return order;
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
      valueFor(left, "organization_id"),
      valueFor(right, "organization_id"),
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

  function teamTargetIds(team) {
    return valueFor(team, "target_employee_ids")
      .split(";").map((id) => id.trim()).filter(Boolean);
  }

  function teamTargetEntries(teamId) {
    const usersById = new Map(
      userEntriesForAssignment().map((entry) => [valueFor(entry, "employee_id"), entry]),
    );
    return teamTargetIds(teamEntryFor(teamId))
      .map((employeeId) => usersById.get(employeeId)).filter(Boolean);
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
    } else if (kind === "target") {
      const team = teamEntryFor(teamId);
      if (!team || valueFor(team, "commenter_scope") !== "custom") return;
      const ids = teamTargetIds(team);
      const index = ids.indexOf(employeeId);
      if (assigned && index < 0) ids.push(employeeId);
      if (!assigned && index >= 0) ids.splice(index, 1);
      team.values.target_employee_ids = ids.join(";");
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
    const scopeField = createInspectorField(
      { key: "commenter_scope", label: "コメント対象", type: "commenter_scope" },
      valueFor(entry, "commenter_scope") || "custom",
      { required: true, hideKey: true },
    );
    if (level === "large") {
      return [nameField, scopeField];
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
    if (level === "medium") return [sectionField, nameField, scopeField];

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
    return [sectionField, unitField, nameField, scopeField];
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

  function renderOrganizationInspector(form, entry, options = {}) {
    if (options.modal) {
      renderTeamEditorModal(form, entry);
      return;
    }
    const teamId = valueFor(entry, "team_id");
    const teamType = valueFor(entry, "team_type");
    const modal = Boolean(options.modal);
    const header = createInspectorHeader(
      teamType === "department" ? "選択中の課" : "選択中の係",
      valueFor(entry, "team_name") || "名称未設定",
    );
    const basic = document.createElement("section");
    basic.className = "organization-editor-section";
    basic.append(createSectionHeading("基本情報", "組織IDは作成後に変更できません。"));
    const fields = document.createElement("div");
    fields.className = "inspector-fields team-editor-fields";
    const definition = getDefinition("team_master");
    ["team_id", "team_name", "team_type"].forEach((key) => {
      const column = definition.columns.find((item) => item.key === key);
      fields.append(
        createInspectorField(column, valueFor(entry, key), {
          required: true,
          disabled: key !== "team_name",
          hideKey: true,
        }),
      );
    });
    if (teamType === "section") {
      const parentColumn = definition.columns.find(
        (item) => item.key === "parent_team_id",
      );
      fields.append(
        createInspectorField(parentColumn, valueFor(entry, "parent_team_id"), {
          required: true,
          disabled: true,
          hideKey: true,
        }),
      );
    }
    basic.append(fields);

    const arrange = document.createElement("div");
    arrange.className = "team-arrange-actions organization-arrange-actions";
    if (teamType === "department") {
      const add = document.createElement("button");
      add.type = "button";
      add.className = "admin-add-button";
      add.dataset.addChildLevel = "section";
      add.dataset.parentTeamId = teamId;
      add.textContent = "係を追加";
      arrange.append(add);
    }
    const availability = teamMoveAvailability(entry);
    [["up", "上へ"], ["down", "下へ"]].forEach(([direction, label]) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "team-member-order-button";
      button.dataset.moveTeam = direction;
      button.textContent = label;
      button.disabled = !availability[direction];
      arrange.append(button);
    });

    form.append(header, basic, arrange);
    renderOrganizationMembersInspector(form, "organization", teamId, entry, false);
    const deleteActions = createDeleteActionBar(
      createDeleteButton(`${teamType === "department" ? "課" : "係"}を削除`),
    );
    if (modal) {
      form.append(deleteActions, createEditorActionBar({ modal: true }));
    } else {
      form.append(createEditorActionBar(), deleteActions);
    }
  }

  function renderTeamEditorModal(form, entry) {
    const definition = getDefinition("team_master");
    const teamId = valueFor(entry, "team_id");
    const teamType = valueFor(entry, "team_type");
    const toolbar = document.createElement("div");
    toolbar.className = "team-editor-modal-toolbar";
    toolbar.append(
      createDeleteIconButton(`${teamType === "department" ? "課" : "係"}を削除`),
    );

    const fields = document.createElement("div");
    fields.className = "inspector-fields team-editor-fields team-editor-modal-fields";
    ["team_type", "team_name"].forEach((key) => {
      const column = definition.columns.find((item) => item.key === key);
      if (!column) return;
      fields.append(
        createInspectorField(column, valueFor(entry, key), {
          required: true,
          disabled: key === "team_type",
          hideKey: true,
        }),
      );
    });

    form.append(
      toolbar,
      fields,
      renderTeamEditorMembers(teamId),
      createEditorActionBar({ modal: true }),
    );
    initializeTeamEditorMemberSortables();
  }

  function renderTeamEditorMembers(teamId, affiliationType = "organization") {
    const section = document.createElement("section");
    section.className = "organization-members-section team-editor-modal-members";
    const heading = document.createElement("h3");
    heading.textContent = "所属ユーザー";
    const list = document.createElement("div");
    list.className = "team-editor-modal-member-list";
    const sortableMembers = affiliationType === "organization";
    if (sortableMembers) {
      list.dataset.teamEditorMemberList = "true";
      list.dataset.teamEditorMemberTeamId = teamId;
      list.dataset.teamEditorMemberAffiliation = affiliationType;
    }
    list.setAttribute("role", "list");
    const members = directMembersFor(affiliationType, teamId);
    members.forEach((member) => {
      const employeeId = valueFor(member, "employee_id");
      const card = document.createElement("div");
      card.className = "team-editor-modal-member-card";
      card.dataset.teamEditorMemberCard = "true";
      card.dataset.employeeId = employeeId;
      card.setAttribute("role", "listitem");
      const id = document.createElement("span");
      id.className = "team-editor-modal-member-id";
      id.textContent = employeeId;
      const name = document.createElement("strong");
      name.className = "team-editor-modal-member-name";
      name.textContent = valueFor(member, "display_name") || employeeId;
      if (sortableMembers) {
        const handle = document.createElement("span");
        handle.className = "team-editor-modal-member-drag-handle";
        handle.dataset.teamEditorMemberDragHandle = employeeId;
        handle.setAttribute("role", "img");
        handle.setAttribute("aria-label", `${valueFor(member, "display_name") || employeeId}の並び順をドラッグで変更`);
        handle.title = "ドラッグで並び替え";
        handle.append(
          createTeamSvgIcon(
            "M7 5h2v2H7V5Zm4 0h2v2h-2V5ZM7 11h2v2H7v-2Zm4 0h2v2h-2v-2ZM7 17h2v2H7v-2Zm4 0h2v2h-2v-2Z",
          ),
        );
        card.append(handle);
      }
      card.append(id, name);
      list.append(card);
    });
    if (!members.length) {
      const empty = document.createElement("p");
      empty.className = "team-editor-modal-member-empty";
      empty.textContent = "所属ユーザーはいません。";
      list.append(empty);
    }
    section.append(heading, list);
    return section;
  }

  function renderOrganizationMembersInspector(
    form,
    affiliationType,
    organizationId,
    teamEntry = null,
    includeHeader = true,
    options = {},
  ) {
    if (includeHeader) {
      form.append(createInspectorHeader("固定グループ", "部長"));
    }
    const section = document.createElement("section");
    section.className = "organization-editor-section organization-members-section";
    section.append(
      createSectionHeading(
        "直接所属ユーザー",
        "並び順は日報のユーザー行とコメント担当者列に共通で使われます。",
      ),
    );
    const members = directMembersFor(affiliationType, organizationId);
    const list = document.createElement("div");
    list.className = "organization-member-list";
    members.forEach((member, index) => {
      const employeeId = valueFor(member, "employee_id");
      const row = document.createElement("div");
      row.className = "organization-member-row";
      const copy = document.createElement("span");
      copy.className = "organization-member-copy";
      const name = document.createElement("strong");
      name.textContent = valueFor(member, "display_name") || employeeId;
      const meta = document.createElement("small");
      meta.textContent = `${employeeId} ・ 順序 ${valueFor(member, "member_order") || "未設定"}`;
      copy.append(name, meta);
      const controls = document.createElement("span");
      controls.className = "organization-member-controls";
      [["up", "上へ"], ["down", "下へ"]].forEach(([direction, label]) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "team-member-order-button";
        button.dataset.organizationMemberMove = direction;
        button.dataset.employeeId = employeeId;
        button.textContent = label;
        button.disabled = direction === "up" ? index === 0 : index === members.length - 1;
        controls.append(button);
      });
      const destination = document.createElement("select");
      destination.dataset.moveUserAffiliation = "true";
      destination.dataset.employeeId = employeeId;
      destination.setAttribute("aria-label", `${name.textContent}の移動先`);
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "別の所属へ移動…";
      destination.append(placeholder);
      organizationAffiliationChoices()
        .filter(([value]) => value !== affiliationValue(member))
        .forEach(([value, label]) => {
          const option = document.createElement("option");
          option.value = value;
          option.textContent = label;
          destination.append(option);
        });
      controls.append(destination);
      row.append(copy, controls);
      list.append(row);
    });
    if (!members.length) {
      const empty = document.createElement("p");
      empty.className = "admin-table-empty";
      empty.textContent = "直接所属ユーザーはいません。";
      list.append(empty);
    }

    const addField = document.createElement("label");
    addField.className = "inspector-field organization-add-member";
    const addLabel = document.createElement("span");
    addLabel.className = "inspector-field-label";
    addLabel.textContent = "別の所属からユーザーを移動";
    const addSelect = document.createElement("select");
    addSelect.dataset.addOrganizationMember = "true";
    addSelect.dataset.destination =
      affiliationType === "director" ? "director" : `organization:${organizationId}`;
    const addPlaceholder = document.createElement("option");
    addPlaceholder.value = "";
    addPlaceholder.textContent = "ユーザーを選択…";
    addSelect.append(addPlaceholder);
    (drafts.get("user_master")?.entries || [])
      .filter((entry) => !members.includes(entry))
      .sort(compareUserListEntries)
      .forEach((entry) => {
        const option = document.createElement("option");
        option.value = valueFor(entry, "employee_id");
        option.textContent = `${valueFor(entry, "display_name")}（現在: ${affiliationLabel(entry)}）`;
        addSelect.append(option);
      });
    addField.append(addLabel, addSelect);
    section.append(list, addField);
    form.append(section);
    if (includeHeader) form.append(createEditorActionBar({ modal: Boolean(options.modal) }));
  }

  function moveOrganizationMember(employeeId, direction) {
    const user = drafts
      .get("user_master")
      ?.entries.find((entry) => valueFor(entry, "employee_id") === employeeId);
    if (!user || !["up", "down"].includes(direction)) return;
    const siblings = directMembersFor(
      valueFor(user, "affiliation_type"),
      valueFor(user, "organization_id"),
    );
    const index = siblings.findIndex((entry) => entry.id === user.id);
    const targetIndex = direction === "up" ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= siblings.length) return;
    [siblings[index], siblings[targetIndex]] = [siblings[targetIndex], siblings[index]];
    siblings.forEach((entry, siblingIndex) => {
      entry.values.member_order = String((siblingIndex + 1) * 10);
    });
    renderTable();
    renderInspector();
    syncAdminChrome();
  }

  function assignmentEntryForUser(employeeId, create = false) {
    const draft = drafts.get("comment_assignment");
    let entry = draft?.entries.find(
      (item) => valueFor(item, "commenter_employee_id") === employeeId,
    );
    if (!entry && create && draft) {
      entry = createEntry(
        {
          commenter_employee_id: employeeId,
          target_type: "none",
          target_organization_ids: "",
          target_employee_ids: "",
        },
        getDefinition("comment_assignment"),
        true,
      );
      draft.entries.push(entry);
    }
    return entry || null;
  }

  function assignmentEntryForSelectedUser(create = false) {
    return assignmentEntryForUser(
      valueFor(getSelectedUser(), "employee_id"),
      create,
    );
  }

  function resetCommentAssignment(employeeId) {
    const assignment = assignmentEntryForUser(employeeId, true);
    if (!assignment) return;
    assignment.values.target_type = "none";
    assignment.values.target_organization_ids = "";
    assignment.values.target_employee_ids = "";
  }

  function affiliationValue(entry) {
    return valueFor(entry, "affiliation_type") === "director"
      ? "director"
      : `organization:${valueFor(entry, "organization_id")}`;
  }

  function affiliationLabel(entry) {
    if (valueFor(entry, "affiliation_type") === "director") return "部長";
    const organizationId = valueFor(entry, "organization_id");
    return teamPathLabel(teamEntryFor(organizationId)) || "所属未設定";
  }

  function directMembersFor(affiliationType, organizationId) {
    return (drafts.get("user_master")?.entries || [])
      .filter((entry) =>
        affiliationType === "director"
          ? valueFor(entry, "affiliation_type") === "director"
          : valueFor(entry, "affiliation_type") === "organization" &&
            valueFor(entry, "organization_id") === organizationId,
      )
      .sort(compareUserListEntries);
  }

  function commentAssignmentSummary(employeeId) {
    const assignment = assignmentEntryForUser(employeeId);
    const type = valueFor(assignment, "target_type") || "none";
    if (type === "none") return "なし";
    if (type === "organization") {
      return (
        teamPathLabel(teamEntryFor(valueFor(assignment, "target_organization_ids"))) ||
        teamNameFor(valueFor(assignment, "target_organization_ids")) ||
        "組織"
      );
    }
    if (type === "departments") {
      const count = splitIds(valueFor(assignment, "target_organization_ids")).length;
      return `複数課（${count}課）`;
    }
    const count = splitIds(valueFor(assignment, "target_employee_ids")).length;
    return "個別設定（" + count + "人）";
  }

  function splitIds(value) {
    return [...new Set(String(value || "").split(";").map((item) => item.trim()).filter(Boolean))];
  }

  function organizationAffiliationChoices() {
    const teams = drafts.get("team_master")?.entries || [];
    const departments = teams
      .filter((entry) => valueFor(entry, "team_type") === "department")
      .sort(compareTeamEntries);
    const choices = [["director", "部長"]];
    departments.forEach((department) => {
      const departmentId = valueFor(department, "team_id");
      choices.push([`organization:${departmentId}`, teamPathLabel(department)]);
      teams
        .filter(
          (entry) =>
            valueFor(entry, "team_type") === "section" &&
            valueFor(entry, "parent_team_id") === departmentId,
        )
        .sort(compareTeamEntries)
        .forEach((section) => {
          choices.push([
            `organization:${valueFor(section, "team_id")}`,
            teamPathLabel(section),
          ]);
        });
    });
    return choices;
  }

  async function changeUserAffiliation(nextValue) {
    const user = getSelectedUser();
    if (!user) return;
    await applyUserAffiliationChange(user, nextValue);
  }

  async function moveUserToAffiliation(employeeId, nextValue) {
    const user = drafts
      .get("user_master")
      ?.entries.find((entry) => valueFor(entry, "employee_id") === employeeId);
    if (!user) return;
    await applyUserAffiliationChange(user, nextValue);
  }

  async function applyUserAffiliationChange(user, nextValue) {
    const previous = affiliationValue(user);
    if (!nextValue || previous === nextValue) {
      renderInspector();
      return;
    }
    const employeeId = valueFor(user, "employee_id");
    const assignment = assignmentEntryForUser(employeeId);
    if (assignment && valueFor(assignment, "target_type") !== "none") {
      const confirmed = await requestConfirmationDialog({
        title: "所属変更とコメント担当解除",
        description:
          "所属を変更すると、現在のコメント担当設定を解除します。保存後は過去分を含むコメント列の表示も変わります。",
        confirmLabel: "解除して所属を変更",
        cancelLabel: "変更しない",
        confirmTone: "danger",
      });
      if (!confirmed) {
        renderInspector();
        return;
      }
    }
    if (nextValue === "director") {
      user.values.affiliation_type = "director";
      user.values.organization_id = "";
      user.values.can_input_own_report = "0";
    } else {
      user.values.affiliation_type = "organization";
      user.values.organization_id = nextValue.replace(/^organization:/, "");
    }
    user.values.member_order = String(
      directMembersFor(
        user.values.affiliation_type,
        user.values.organization_id,
      ).length * 10,
    );
    resetCommentAssignment(employeeId);
    pruneInvalidCustomAssignments();
    renderMasterNav();
    renderTable();
    renderInspector();
    syncAdminChrome();
  }

  function pruneInvalidCustomAssignments() {
    (drafts.get("comment_assignment")?.entries || []).forEach((assignment) => {
      if (valueFor(assignment, "target_type") !== "custom") return;
      const commenter = drafts
        .get("user_master")
        ?.entries.find(
          (entry) =>
            valueFor(entry, "employee_id") ===
            valueFor(assignment, "commenter_employee_id"),
        );
      const allowed = new Set(
        allowedCustomTargets(commenter).map((entry) => valueFor(entry, "employee_id")),
      );
      assignment.values.target_employee_ids = splitIds(
        valueFor(assignment, "target_employee_ids"),
      )
        .filter((employeeId) => allowed.has(employeeId))
        .join(";");
      if (!assignment.values.target_employee_ids) {
        assignment.values.target_type = "none";
      }
    });
  }

  function updateCommentTargetType(targetType) {
    const assignment = assignmentEntryForSelectedUser(true);
    if (!assignment) return;
    const normalizedTargetType = String(targetType || "");
    const organizationPrefix = "organization:";
    const organizationId = normalizedTargetType.startsWith(organizationPrefix)
      ? normalizedTargetType.slice(organizationPrefix.length)
      : "";
    assignment.values.target_type = organizationId ? "organization" : normalizedTargetType;
    assignment.values.target_organization_ids = organizationId;
    assignment.values.target_employee_ids = "";
    renderInspector();
    renderTable();
    syncAdminChrome();
  }

  function toggleAssignmentListValue(column, id, selected) {
    const assignment = assignmentEntryForSelectedUser(true);
    if (!assignment) return;
    const values = splitIds(valueFor(assignment, column));
    const next = selected
      ? [...new Set([...values, id])]
      : values.filter((value) => value !== id);
    assignment.values[column] = next.join(";");
    renderTable();
    renderInspector();
    syncAdminChrome();
  }

  function allowedOrganizationTargets(user) {
    const organization = teamEntryFor(valueFor(user, "organization_id"));
    if (!organization) return [];
    const organizationId = valueFor(organization, "team_id");
    if (valueFor(organization, "team_type") === "section") {
      return [
        organization,
        teamEntryFor(valueFor(organization, "parent_team_id")),
      ].filter(Boolean).sort(compareTeamPathOrder);
    }
    return [
      organization,
      ...(drafts.get("team_master")?.entries || []).filter(
        (entry) =>
          valueFor(entry, "team_type") === "section" &&
          valueFor(entry, "parent_team_id") === organizationId,
      ),
    ].sort(compareTeamPathOrder);
  }

  function allowedCustomTargets(user) {
    const organization = teamEntryFor(valueFor(user, "organization_id"));
    if (!organization) return [];
    const organizationIds = new Set([valueFor(organization, "team_id")]);
    if (valueFor(organization, "team_type") === "department") {
      (drafts.get("team_master")?.entries || [])
        .filter(
          (entry) =>
            valueFor(entry, "team_type") === "section" &&
            valueFor(entry, "parent_team_id") === valueFor(organization, "team_id"),
        )
        .forEach((entry) => organizationIds.add(valueFor(entry, "team_id")));
    }
    return (drafts.get("user_master")?.entries || [])
      .filter(
        (entry) =>
          entry.id !== user.id &&
          valueFor(entry, "affiliation_type") === "organization" &&
          organizationIds.has(valueFor(entry, "organization_id")) &&
          valueFor(entry, "can_input_own_report") === "1",
      )
      .sort(compareUserListEntries);
  }

  function renderUserEditorDialog() {
    const state = userEditorModalState;
    const entry = drafts
      .get("user_master")
      ?.entries.find((item) => item.id === state?.entryId);
    const form = byId("userEditorDialogForm");
    if (!entry || !form) return;
    form.replaceChildren();
    renderOrganizationUserInspector(form, entry, { modal: true });
  }

  function renderOrganizationUserInspector(form, entry, options = {}) {
    const definition = getDefinition("user_master");
    const fields = document.createElement("div");
    fields.className = "inspector-fields user-editor-fields";
    ["employee_id", "display_name"].forEach((key) => {
      const column = definition.columns.find((item) => item.key === key);
      fields.append(
        createInspectorField(column, valueFor(entry, key), {
          required: true,
          disabled: key === "employee_id" && !entry.isNew,
          hideKey: true,
        }),
      );
    });

    const affiliationField = document.createElement("label");
    affiliationField.className = "inspector-field";
    const affiliationLabelElement = document.createElement("span");
    affiliationLabelElement.className = "inspector-field-label";
    affiliationLabelElement.textContent = "所属組織";
    const affiliationSelect = document.createElement("select");
    affiliationSelect.dataset.userAffiliation = "true";
    const currentAffiliation = affiliationValue(entry);
    const emptyOption = document.createElement("option");
    emptyOption.value = "";
    emptyOption.textContent = "所属を選択";
    affiliationSelect.append(emptyOption);
    organizationAffiliationChoices().forEach(([value, label]) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      affiliationSelect.append(option);
    });
    affiliationSelect.value = currentAffiliation === "organization:" ? "" : currentAffiliation;
    affiliationSelect.required = true;
    affiliationField.append(affiliationLabelElement, affiliationSelect);

    ["employment_type", "is_admin", "can_input_own_report"].forEach((key) => {
      const column = definition.columns.find((item) => item.key === key);
      fields.append(
        createInspectorField(column, valueFor(entry, key), {
          required: Boolean(column.required),
          disabled:
            (key === "is_admin" && valueFor(entry, "employment_type") !== "regular") ||
            (key === "is_admin" && valueFor(entry, "is_admin") === "1" && regularAdministratorCount() <= 1) ||
            (key === "can_input_own_report" && valueFor(entry, "affiliation_type") === "director"),
          hideKey: true,
        }),
      );
    });
    fields.append(affiliationField);

    const assignmentSection = document.createElement("section");
    assignmentSection.className = "organization-editor-section user-comment-assignment-section";
    assignmentSection.append(renderCommentAssignmentEditor(entry));
    form.append(
      fields,
      assignmentSection,
      createUserEditorActions({ modal: Boolean(options.modal) }),
    );
  }

  function renderCommentAssignmentEditor(user) {
    const assignment = assignmentEntryForUser(valueFor(user, "employee_id"), true);
    const wrap = document.createElement("div");
    wrap.className = "comment-assignment-editor";
    const typeField = document.createElement("label");
    typeField.className = "inspector-field";
    const label = document.createElement("span");
    label.className = "inspector-field-label";
    label.textContent = "コメント対象";
    const select = document.createElement("select");
    select.dataset.commentTargetType = "true";
    const isDirector = valueFor(user, "affiliation_type") === "director";
    const isTemporary = valueFor(user, "employment_type") === "temporary";
    const organizationChoices = allowedOrganizationTargets(user).map((entry) => {
      const organizationId = valueFor(entry, "team_id");
      return ["organization:" + organizationId, teamPathLabel(entry)];
    });
    const choices = isTemporary
      ? [["none", "なし"]]
      : isDirector
      ? [["none", "なし"], ["departments", "複数課"]]
      : [["none", "なし"], ...organizationChoices, ["custom", "所属組織内で個別設定"]];
    choices.forEach(([value, text]) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      select.append(option);
    });
    const assignmentType = valueFor(assignment, "target_type");
    const currentValue = assignmentType === "organization"
      ? "organization:" + valueFor(assignment, "target_organization_ids")
      : assignmentType;
    select.value = choices.some(([value]) => value === currentValue)
      ? currentValue
      : "none";
    typeField.append(label, select);
    wrap.append(typeField);

    if (select.value === "custom") {
      wrap.append(
        createAssignmentChecklist(
          "所属組織内のユーザー",
          allowedCustomTargets(user),
          splitIds(valueFor(assignment, "target_employee_ids")),
          "employee",
        ),
      );
    } else if (select.value === "departments") {
      const departments = (drafts.get("team_master")?.entries || [])
        .filter((entry) => valueFor(entry, "team_type") === "department")
        .sort(compareTeamEntries);
      wrap.append(
        createAssignmentChecklist(
          "対象の課（複数選択）",
          departments,
          splitIds(valueFor(assignment, "target_organization_ids")),
          "department",
        ),
      );
    }
    return wrap;
  }

  function createAssignmentChecklist(titleText, entries, selectedIds, kind) {
    const fieldset = document.createElement("fieldset");
    fieldset.className = "assignment-checklist";
    const legend = document.createElement("legend");
    legend.textContent = `${titleText}（${selectedIds.length}件選択）`;
    fieldset.append(legend);
    entries.forEach((entry) => {
      const id =
        kind === "employee" ? valueFor(entry, "employee_id") : valueFor(entry, "team_id");
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = id;
      input.checked = selectedIds.includes(id);
      if (kind === "employee") input.dataset.commentTargetEmployee = "true";
      else input.dataset.commentTargetDepartment = "true";
      const text = document.createElement("span");
      text.textContent =
        kind === "employee"
          ? `${valueFor(entry, "display_name")}（${id}）`
          : teamPathLabel(entry);
      label.append(input, text);
      fieldset.append(label);
    });
    if (!entries.length) {
      const empty = document.createElement("p");
      empty.textContent = "選択可能な対象がありません。";
      fieldset.append(empty);
    }
    return fieldset;
  }

  function renderUserInspector(form, entry) {
    return renderOrganizationUserInspector(form, entry);
    /* istanbul ignore next -- legacy inspector retained for migration reference */
    const fields = document.createElement("div");
    fields.className = "user-editor-fields";
    const definition = getDefinition("user_master");
    const editorColumnOrder = [
      "employee_id",
      "display_name",
      "employment_type",
      "is_admin",
      "small_team_id",
      "can_input_own_report",
    ];
    editorColumnOrder.forEach((columnKey) => {
      const column = definition.columns.find((candidate) => candidate.key === columnKey);
      if (!column) return;
      const field = createInspectorField(column, entry.values[column.key], {
        required: Boolean(column.required),
        disabled:
          (column.key === "employee_id" && !entry.isNew) ||
          (column.key === "is_admin" &&
            valueFor(entry, "employment_type") !== "regular") ||
          (column.key === "is_admin" && valueFor(entry, "is_admin") === "1" && regularAdministratorCount() <= 1),
        hideKey: true,
      });
      field.dataset.userField = column.key;
      fields.append(field);
      if (column.key === "small_team_id") {
        fields.append(createUserCommenterTeamsField(entry));
      }
    });
    form.append(fields, createUserEditorActions());
  }

  function createUserCommenterTeamsField(entry) {
    const field = document.createElement("div");
    field.className = "inspector-field user-commenter-teams-field";
    field.dataset.userField = "commenter_team_ids";

    const label = document.createElement("span");
    label.className = "inspector-field-label";
    const labelText = document.createElement("span");
    labelText.textContent = "コメント対象チーム";
    label.append(labelText);

    const values = document.createElement("div");
    values.className = "user-commenter-teams";
    const teamIds = commenterTeamIdsForUser(valueFor(entry, "employee_id"));
    teamIds.forEach((teamId) => {
      const team = document.createElement("span");
      team.className = "user-commenter-team";
      team.textContent = teamNameFor(teamId);
      values.append(team);
    });
    if (!teamIds.length) {
      values.classList.add("is-empty");
      values.textContent = "—";
    }

    field.append(label, values);
    return field;
  }

  function createUserEditorActions({ modal = false } = {}) {
    const actions = document.createElement("div");
    actions.className = "user-editor-actions";
    if (modal) {
      const cancelButton = document.createElement("button");
      cancelButton.type = "button";
      cancelButton.className = "inspector-cancel-button";
      cancelButton.dataset.userEditorCancel = "true";
      cancelButton.textContent = "キャンセル";
      actions.append(cancelButton);
    } else {
      const deleteButton = createDeleteButton("削除");
      deleteButton.classList.add("is-secondary");
      const selectedUser = getDraft("user_master")?.entries.find((entry) => entry.id === getDraft("user_master")?.selectedId);
      if (activeMaster === "user_master" && isProtectedAdministratorEntry(selectedUser)) {
        deleteButton.disabled = true;
        deleteButton.title = "最後の管理者またはログイン中の管理者は削除できません";
        deleteButton.setAttribute("aria-label", "削除できません");
        deleteButton.setAttribute("aria-disabled", "true");
      }
      actions.append(deleteButton);
    }
    const saveButton = document.createElement("button");
    saveButton.type = "button";
    saveButton.className = "inspector-save-button";
    saveButton.dataset.saveEditor = "true";
    saveButton.textContent = "保存";
    actions.append(saveButton);
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
    const isRadioField = [
      "employment_type",
      "admin_flag",
      "self_report_input",
    ].includes(column.type);
    const label = document.createElement(isRadioField ? "div" : "label");
    label.className = isRadioField
      ? "inspector-field inspector-radio-field"
      : "inspector-field";
    const labelText = document.createElement("span");
    labelText.className = "inspector-field-label";
    const visibleLabel = document.createElement("span");
    visibleLabel.textContent = column.label;
    const key = document.createElement("small");
    key.textContent = column.key;
    labelText.append(visibleLabel);
    if (!options.hideKey) labelText.append(key);

    if (isRadioField) {
      const radioGroup = document.createElement("div");
      radioGroup.className = "inspector-radio-group";
      radioGroup.setAttribute("role", "radiogroup");
      radioGroup.setAttribute("aria-label", column.label);
      const choices =
        column.type === "employment_type"
          ? [["regular", "正社員"], ["temporary", "派遣社員"]]
          : column.type === "admin_flag"
            ? [["1", "管理者"], ["0", "一般"]]
            : [["1", "要"], ["0", "不要"]];
      const isInvalid = Boolean(options.required) && !String(value).trim();
      choices.forEach(([optionValue, text], index) => {
        const optionLabel = document.createElement("label");
        optionLabel.className = "inspector-radio-option";
        const radio = document.createElement("input");
        radio.type = "radio";
        radio.name = "user-editor-" + column.key;
        radio.value = optionValue;
        radio.checked = String(value) === optionValue;
        radio.dataset.column = column.key;
        radio.required = Boolean(options.required) && index === 0;
        radio.disabled = Boolean(options.disabled);
        radio.autocomplete = "off";
        radio.setAttribute("aria-invalid", String(isInvalid));
        const optionText = document.createElement("span");
        optionText.textContent = text;
        optionLabel.append(radio, optionText);
        radioGroup.append(optionLabel);
      });
      radioGroup.setAttribute("aria-invalid", String(isInvalid));
      label.append(labelText, radioGroup);
      if (options.hint) {
        const hint = document.createElement("small");
        hint.className = "inspector-field-hint";
        hint.textContent = options.hint;
        label.append(hint);
      }
      return label;
    }

    let input;
    if (
      [
        "boolean",
        "active",
        "team_level",
        "team_type",
        "small_team",
        "organization",
        "affiliation_type",
        "parent_team",
        "parent_department",
        "commenter_scope",
      ].includes(column.type)
    ) {
      input = document.createElement("select");
      let choices = [];
      if (column.type === "boolean") {
        choices = [["0", "稼働日"], ["1", "休日"]];
      } else if (column.type === "active") {
        choices = [["1", "有効"], ["0", "廃止"]];
      } else if (column.type === "team_level") {
        choices = [["large", "課"], ["medium", "係"]];
        if (value === "small") choices.push(["small", "旧チーム（既存）"]);
      } else if (column.type === "team_type") {
        choices = [["department", "課"], ["section", "係"]];
      } else if (column.type === "affiliation_type") {
        choices = [["organization", "課・係"], ["director", "部長"]];
      } else if (column.type === "commenter_scope") {
        choices = [["large", "課"], ["medium", "係"], ["custom", "カスタム"]];
      } else if (column.type === "small_team") {
        choices = [["", "所属なし"], ...teamAssignmentChoices()];
      } else if (column.type === "organization") {
        choices = [["", "所属を選択"], ...teamAssignmentChoices()];
      } else if (column.type === "parent_department") {
        choices = [["", "親課を選択"], ...teamChoices("department")];
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
    if (column.type === "commenter_scope") {
      input.setAttribute("aria-label", "コメント対象範囲");
    }
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
      .filter((entry) =>
        valueFor(entry, "team_type") === level ||
        valueFor(entry, "team_level") === level,
      )
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
      .filter((entry) => ["department", "section"].includes(valueFor(entry, "team_type")))
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
      .filter((entry) =>
        levels.includes(valueFor(entry, "team_type")) ||
        levels.includes(valueFor(entry, "team_level")),
      )
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

  function createDeleteIconButton(label) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "api-key-action delete team-editor-modal-delete";
    button.dataset.deleteRow = "true";
    button.setAttribute("aria-label", label);
    button.title = label;
    const iconWrap = document.createElement("span");
    const icon = createTeamSvgIcon(EMBEDDED_DELETE_ICON_PATH);
    const iconPath = icon.querySelector("path");
    iconPath.setAttribute("fill-rule", "evenodd");
    iconPath.setAttribute("clip-rule", "evenodd");
    iconPath.setAttribute("fill", "currentColor");
    iconWrap.append(icon);
    button.append(iconWrap);
    return button;
  }

  function createUserRowAction(action, entry, displayLabel) {
    const button = document.createElement("button");
    const isEdit = action === "edit";
    const iconPath = isEdit
      ? EMBEDDED_EDIT_ICON_PATH
      : EMBEDDED_DELETE_ICON_PATH;
    button.type = "button";
    button.className = "api-key-action " + action;
    button.dataset.userRowAction = action;
    button.dataset.userId = entry.id;
    button.setAttribute(
      "aria-label",
      displayLabel + (isEdit ? "を編集" : "を削除"),
    );
    button.title = isEdit ? "編集" : "削除";
    if (!isEdit && isProtectedAdministratorEntry(entry)) {
      button.disabled = true;
      button.title = "最後の管理者またはログイン中の管理者は削除できません";
      button.setAttribute("aria-label", `${displayLabel}を削除できません`);
      button.setAttribute("aria-disabled", "true");
    }
    const iconWrap = document.createElement("span");
    const icon = createTeamSvgIcon(iconPath);
    const iconPathElement = icon.querySelector("path");
    iconPathElement.setAttribute("fill-rule", "evenodd");
    iconPathElement.setAttribute("clip-rule", "evenodd");
    iconPathElement.setAttribute("fill", "currentColor");
    iconWrap.append(icon);
    button.append(iconWrap);
    return button;
  }

  function createEditorActionBar({ modal = false } = {}) {
    const actions = document.createElement("div");
    actions.className = modal
      ? "team-editor-modal-actions"
      : "inspector-record-actions";
    if (modal) {
      const cancelButton = document.createElement("button");
      cancelButton.type = "button";
      cancelButton.className = "inspector-cancel-button";
      cancelButton.dataset.teamEditorCancel = "true";
      cancelButton.textContent = "キャンセル";
      actions.append(cancelButton);
    }
    const saveButton = document.createElement("button");
    saveButton.type = "button";
    saveButton.className = "inspector-save-button";
    saveButton.dataset.saveEditor = "true";
    saveButton.textContent = "保存";
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
    if (isDraftDirty(drafts.get("comment_assignment"))) count += 1;
    if (isDraftDirty(drafts.get("calendar"))) count += 1;
    return count;
  }

  function syncAdminChrome() {
    const count = dirtyFileCount();
    const badge = byId("adminDirtyBadge");
    const ledger = byId("adminLedgerCount");
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
    reload,
    hasUnsaved,
    save,
    syncChrome: syncAdminChrome,
    setCurrentEmployeeId(employeeId) {
      currentEmployeeId = String(employeeId || "");
      if (isLoaded) render();
    },
  };
})();

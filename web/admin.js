// Common-data workbench. The user screen joins person data and reporting lines,
// while persistence keeps those two concerns in separate CSV files.
(function () {
  const MASTER_DEFINITIONS = [
    {
      key: "user_master",
      label: "ユーザー管理",
      title: "ユーザーと担当部下",
      file: "user_master.csv · superior_config.csv",
      navFile: "user_master + config",
      columns: [
        { key: "employee_id", label: "社員ID", type: "text", required: true },
        { key: "display_name", label: "表示名", type: "text", required: true },
        {
          key: "superior_rank",
          label: "上司ランク",
          type: "number",
          required: false,
        },
        {
          key: "small_team_id",
          label: "所属小チーム",
          type: "small_team",
          required: false,
        },
        {
          key: "display_order",
          label: "表示順",
          type: "number",
          required: false,
        },
      ],
    },
    {
      key: "team_master",
      label: "チーム管理",
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
      ],
    },
    {
      key: "calendar",
      label: "カレンダー",
      title: "稼働日カレンダー",
      file: "calendar.csv",
      navFile: "calendar.csv",
      columns: [
        { key: "date", label: "日付", type: "date", required: true },
        {
          key: "is_holiday",
          label: "休日区分",
          type: "boolean",
          required: true,
          defaultValue: "0",
        },
        { key: "description", label: "名称・備考", type: "text" },
      ],
    },
  ];

  let isLoaded = false;
  let isLoading = false;
  let activeMaster = MASTER_DEFINITIONS[0].key;
  let searchText = "";
  let subordinateSearchText = "";
  let nextRowId = 1;
  const drafts = new Map();
  let relationshipDraft = null;

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
  const isRelationshipDirty = () =>
    Boolean(relationshipDraft) &&
    snapshot(relationshipDraft.rows) !== relationshipDraft.originalSnapshot;
  const isUserAdministrationDirty = () =>
    isDraftDirty(drafts.get("user_master")) || isRelationshipDirty();
  const isOrganizationAdministrationDirty = () =>
    isUserAdministrationDirty() || isDraftDirty(drafts.get("team_master"));
  const isDefinitionDirty = (key) =>
    key === "user_master"
      ? isUserAdministrationDirty()
      : isDraftDirty(drafts.get(key));

  function createEntry(values, definition, isNew = false) {
    return {
      id: `master-row-${nextRowId++}`,
      isNew,
      values: Object.fromEntries(
        definition.columns.map((column) => [
          column.key,
          String(values?.[column.key] ?? column.defaultValue ?? ""),
        ]),
      ),
    };
  }

  function initialize() {
    byId("adminReloadButton").addEventListener("click", reload);
    byId("adminSaveButton").addEventListener("click", save);
    byId("adminAddRowButton").addEventListener("click", addRow);
    byId("adminSearchInput").addEventListener("input", (event) => {
      searchText = event.target.value.trim().toLocaleLowerCase("ja");
      renderTable();
    });
    byId("masterNav").addEventListener("click", (event) => {
      const button = event.target.closest("[data-master]");
      if (button) selectMaster(button.dataset.master);
    });
    byId("adminTableWrap").addEventListener("click", (event) => {
      const row = event.target.closest("[data-row-id]");
      if (row) selectRow(row.dataset.rowId);
    });
    byId("adminTableWrap").addEventListener("keydown", (event) => {
      if (!["Enter", " "].includes(event.key)) return;
      const row = event.target.closest("[data-row-id]");
      if (!row) return;
      event.preventDefault();
      selectRow(row.dataset.rowId);
    });
    byId("adminInspectorForm").addEventListener("input", (event) => {
      const search = event.target.closest("[data-subordinate-search]");
      if (search) {
        subordinateSearchText = search.value.trim().toLocaleLowerCase("ja");
        renderSubordinateList();
        return;
      }
      updateSelectedRow(event);
    });
    byId("adminInspectorForm").addEventListener("change", (event) => {
      const checkbox = event.target.closest("[data-subordinate-id]");
      if (checkbox) {
        toggleSubordinate(checkbox.dataset.subordinateId, checkbox.checked);
        return;
      }
      updateSelectedRow(event);
    });
    byId("adminInspectorForm").addEventListener("click", (event) => {
      if (event.target.closest("[data-delete-row]")) deleteSelectedRow();
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
      const relationships = Array.isArray(result.data?.superior_config)
        ? result.data.superior_config.map(normalizeRelationship)
        : [];
      relationshipDraft = {
        rows: relationships,
        originalSnapshot: snapshot(relationships),
        revision: String(result.revisions?.superior_config || ""),
      };

      isLoaded = true;
      searchText = "";
      subordinateSearchText = "";
      byId("adminSearchInput").value = "";
      byId("adminLoading").classList.add("hidden");
      byId("adminWorkspace").classList.remove("hidden");
      render();
    } finally {
      isLoading = false;
      setBusy(false);
      syncAdminChrome();
    }
  }

  function normalizeRelationship(row) {
    return {
      superior_employee_id: String(row?.superior_employee_id || ""),
      subordinate_employee_id: String(row?.subordinate_employee_id || ""),
    };
  }

  async function reload() {
    if (
      hasUnsaved() &&
      !window.confirm("未保存の変更を破棄して、共通マスターを再読み込みしますか？")
    ) {
      return;
    }
    isLoaded = false;
    await load();
  }

  async function save() {
    if (!hasUnsaved() || isLoading) return;
    const api = window.pywebview?.api;
    setBusy(true, "admin-save");
    try {
      if (isOrganizationAdministrationDirty()) {
        if (typeof api?.save_user_administration !== "function") {
          throw new Error("ユーザー管理の保存機能を利用できません。");
        }
        const userDraft = drafts.get("user_master");
        const teamDraft = drafts.get("team_master");
        const result = await api.save_user_administration({
          teams: valuesOnly(teamDraft),
          users: valuesOnly(userDraft),
          relationships: relationshipDraft.rows,
          revisions: {
            team_master: teamDraft.revision,
            user_master: userDraft.revision,
            superior_config: relationshipDraft.revision,
          },
        });
        if (!result?.ok) {
          notify({
            text:
              result?.message ||
              "ユーザー情報を保存できませんでした。入力内容を確認してください。",
            type: "error",
          });
          return;
        }
        userDraft.originalSnapshot = snapshot(valuesOnly(userDraft));
        teamDraft.originalSnapshot = snapshot(valuesOnly(teamDraft));
        userDraft.migrationRequired = false;
        userDraft.revision = String(
          result.revisions?.user_master || userDraft.revision,
        );
        userDraft.entries.forEach((entry) => {
          entry.isNew = false;
        });
        teamDraft.revision = String(
          result.revisions?.team_master || teamDraft.revision,
        );
        teamDraft.entries.forEach((entry) => {
          entry.isNew = false;
        });
        relationshipDraft.originalSnapshot = snapshot(relationshipDraft.rows);
        relationshipDraft.revision = String(
          result.revisions?.superior_config || relationshipDraft.revision,
        );
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
          return;
        }
        calendarDraft.originalSnapshot = snapshot(valuesOnly(calendarDraft));
        calendarDraft.revision = String(
          result.revision || calendarDraft.revision,
        );
        calendarDraft.entries.forEach((entry) => {
          entry.isNew = false;
        });
      }

      notify({ text: "共通データの変更を保存しました。", type: "success" });
    } catch (error) {
      notify({
        text:
          error?.message || "共通マスターの保存中にエラーが発生しました。",
        type: "error",
      });
    } finally {
      setBusy(false);
      renderMasterNav();
      renderInspector();
      syncAdminChrome();
    }
  }

  function selectMaster(key) {
    if (!drafts.has(key) || key === activeMaster) return;
    activeMaster = key;
    searchText = "";
    subordinateSearchText = "";
    byId("adminSearchInput").value = "";
    render();
  }

  function selectRow(rowId) {
    const draft = getDraft();
    if (!draft?.entries.some((entry) => entry.id === rowId)) return;
    draft.selectedId = rowId;
    subordinateSearchText = "";
    renderTable();
    renderInspector();
  }

  function addRow() {
    const definition = getDefinition();
    const draft = getDraft();
    const entry = createEntry({}, definition, true);
    draft.entries.push(entry);
    draft.selectedId = entry.id;
    searchText = "";
    subordinateSearchText = "";
    byId("adminSearchInput").value = "";
    render();
    requestAnimationFrame(() => {
      byId("adminInspectorForm")
        .querySelector("input:not(:disabled), select")
        ?.focus();
    });
  }

  function deleteSelectedRow() {
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
      if (hasChildren || hasMembers) {
        notify({
          text: hasChildren
            ? "下位チームが残っています。先に下位チームを移動または削除してください。"
            : "所属ユーザーが残っています。先にユーザーの所属を変更してください。",
          type: "error",
        });
        return;
      }
    }
    if (
      activeMaster === "user_master" &&
      relationshipDraft.rows.some(
        (row) =>
          row.superior_employee_id === entry.values.employee_id ||
          row.subordinate_employee_id === entry.values.employee_id,
      )
    ) {
      notify({
        text: "担当関係が残っています。上司・部下の割り当てを解除してから削除してください。",
        type: "error",
      });
      return;
    }
    if (
      !window.confirm(
        "この行を削除対象にしますか？ 保存するまでCSVには反映されません。",
      )
    ) {
      return;
    }
    draft.entries.splice(index, 1);
    draft.selectedId = "";
    render();
  }

  function updateSelectedRow(event) {
    const input = event.target.closest("[data-column]");
    if (!input) return;
    const draft = getDraft();
    const entry = draft.entries.find((item) => item.id === draft.selectedId);
    if (!entry) return;
    entry.values[input.dataset.column] = input.value;
    if (input.dataset.column === "team_level") {
      entry.values.parent_team_id = "";
    }
    const isInvalid = input.required && !input.value.trim();
    input.classList.toggle("is-invalid", isInvalid);
    input.setAttribute("aria-invalid", String(isInvalid));
    renderMasterNav();
    renderTable();
    if (
      event.type === "change" &&
      ((input.dataset.column === "employee_id" && entry.isNew) ||
        input.dataset.column === "team_level")
    ) {
      renderInspector();
    }
    syncAdminChrome();
  }

  function toggleSubordinate(subordinateId, checked) {
    const supervisor = getSelectedUser();
    if (!supervisor || !subordinateId) return;
    const supervisorId = supervisor.values.employee_id;
    const index = relationshipDraft.rows.findIndex(
      (row) =>
        row.superior_employee_id === supervisorId &&
        row.subordinate_employee_id === subordinateId,
    );
    if (checked && index < 0) {
      relationshipDraft.rows.push({
        superior_employee_id: supervisorId,
        subordinate_employee_id: subordinateId,
      });
    } else if (!checked && index >= 0) {
      relationshipDraft.rows.splice(index, 1);
    }
    renderMasterNav();
    renderTable();
    renderInspector();
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
      const isActive = definition.key === activeMaster;
      button.classList.toggle("is-active", isActive);
      button.classList.toggle(
        "is-dirty",
        isDefinitionDirty(definition.key),
      );
      button.setAttribute("aria-pressed", String(isActive));

      const copy = document.createElement("span");
      copy.className = "master-nav-copy";
      const title = document.createElement("strong");
      title.textContent = definition.label;
      const file = document.createElement("small");
      file.textContent = definition.navFile;
      copy.append(title, file);

      const count = document.createElement("span");
      count.className = "master-nav-count";
      count.textContent = String(draft?.entries.length ?? 0);
      button.append(copy, count);
      navigation.append(button);
    });
  }

  function renderTableHeading() {
    const definition = getDefinition();
    byId("activeMasterFile").textContent = definition.file;
    byId("activeMasterTitle").textContent = definition.title;
    byId("adminSearchInput").placeholder =
      definition.key === "calendar"
        ? "日付・名称で検索"
        : definition.key === "team_master"
          ? "チームID・名称で検索"
          : "ID・氏名で検索";
    const addButton = byId("adminAddRowButton");
    addButton.lastChild.textContent =
      definition.key === "user_master"
        ? "ユーザーを追加"
        : definition.key === "team_master"
          ? "チームを追加"
          : "日付を追加";
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
    const definition = getDefinition();
    const draft = getDraft();
    const entries = filteredEntries();
    const wrap = byId("adminTableWrap");
    wrap.replaceChildren();

    if (!entries.length) {
      const empty = document.createElement("div");
      empty.className = "admin-table-empty";
      empty.textContent = searchText
        ? "検索条件に一致する行がありません。"
        : "データがありません。追加ボタンから登録できます。";
      wrap.append(empty);
    } else {
      const table = document.createElement("table");
      table.className = "admin-data-table";
      if (activeMaster === "user_master") {
        table.classList.add("is-user-table");
      }
      const head = document.createElement("thead");
      const headerRow = document.createElement("tr");
      definition.columns.forEach((column) => {
        const th = document.createElement("th");
        th.scope = "col";
        th.textContent = column.label;
        headerRow.append(th);
      });
      head.append(headerRow);

      const body = document.createElement("tbody");
      entries.forEach((entry) => {
        const row = document.createElement("tr");
        row.tabIndex = 0;
        row.dataset.rowId = entry.id;
        row.classList.toggle("is-selected", entry.id === draft.selectedId);
        row.setAttribute(
          "aria-selected",
          String(entry.id === draft.selectedId),
        );
        definition.columns.forEach((column, index) => {
          const cell = document.createElement("td");
          if (index === 0) cell.className = "admin-cell-primary";
          const value = entry.values[column.key];
          if (column.type === "boolean") {
            const pill = document.createElement("span");
            pill.className = "admin-holiday-pill";
            const isHoliday = value === "1";
            pill.classList.toggle("is-holiday", isHoliday);
            pill.textContent = isHoliday ? "休日" : "稼働日";
            cell.append(pill);
          } else if (column.type === "active") {
            const status = document.createElement("span");
            status.className = "admin-holiday-pill";
            status.classList.toggle("is-holiday", value !== "1");
            status.textContent = value === "1" ? "有効" : "廃止";
            cell.append(status);
          } else if (column.type === "team_level") {
            cell.textContent = teamLevelLabel(value);
          } else if (column.type === "small_team" || column.type === "parent_team") {
            cell.textContent = teamNameFor(value) || "—";
          } else if (column.key === "superior_rank") {
            const assignedCount = countSubordinates(valueFor(entry, "employee_id"));
            if (value) {
              const rank = document.createElement("span");
              rank.className = "admin-rank-pill";
              rank.textContent = `ランク${value}`;
              cell.append(rank);
            } else {
              cell.textContent = "一般";
            }
            if (assignedCount) {
              const count = document.createElement("small");
              count.className = "admin-subordinate-count";
              count.textContent = `${assignedCount}名`;
              cell.append(count);
            }
          } else {
            cell.textContent = value || "—";
            cell.title = value || "";
          }
          row.append(cell);
        });
        body.append(row);
      });
      table.append(head, body);
      wrap.append(table);
    }

    byId("adminRowCount").textContent = searchText
      ? `${entries.length} / ${draft.entries.length}件`
      : `${draft.entries.length}件`;
  }

  function valueFor(entry, key) {
    return String(entry?.values?.[key] || "");
  }

  function teamLevelLabel(level) {
    return { large: "大チーム", medium: "中チーム", small: "小チーム" }[level] || level || "—";
  }

  function teamNameFor(teamId) {
    if (!teamId) return "";
    const entry = drafts
      .get("team_master")
      ?.entries.find((item) => valueFor(item, "team_id") === teamId);
    return valueFor(entry, "team_name") || teamId;
  }

  function countSubordinates(supervisorId) {
    return relationshipDraft?.rows.filter(
      (row) => row.superior_employee_id === supervisorId,
    ).length || 0;
  }

  function renderInspector() {
    const draft = getDraft();
    const entry = draft.entries.find((item) => item.id === draft.selectedId);
    const empty = byId("adminInspectorEmpty");
    const form = byId("adminInspectorForm");
    empty.classList.toggle("hidden", Boolean(entry));
    form.classList.toggle("hidden", !entry);
    form.replaceChildren();
    if (!entry) return;

    if (activeMaster === "user_master") {
      renderUserInspector(form, entry);
    } else {
      renderGenericInspector(form, entry);
    }
  }

  function renderUserInspector(form, entry) {
    const employeeId = valueFor(entry, "employee_id");
    const subordinateCount = countSubordinates(employeeId);
    const header = createInspectorHeader(
      entry.isNew ? "新しいユーザー" : "選択中のユーザー",
      valueFor(entry, "display_name") || employeeId || "名前未設定",
    );
    const status = document.createElement("span");
    status.className = "user-role-badge";
    status.textContent = valueFor(entry, "superior_rank")
      ? `上司ランク ${valueFor(entry, "superior_rank")}`
      : "一般ユーザー";
    header.append(status);

    const basicSection = document.createElement("section");
    basicSection.className = "inspector-section";
    basicSection.append(
      createSectionHeading("基本情報", "氏名、所属小チーム、上司ランク"),
    );
    const fields = document.createElement("div");
    fields.className = "inspector-fields";
    const definition = getDefinition("user_master");
    definition.columns.forEach((column) => {
      const required =
        column.required ||
        (column.key === "superior_rank" && subordinateCount > 0);
      const field = createInspectorField(column, entry.values[column.key], {
        required,
        disabled: column.key === "employee_id" && !entry.isNew,
      });
      if (column.key === "employee_id" && !entry.isNew) {
        const hint = document.createElement("small");
        hint.className = "inspector-field-hint";
        hint.textContent = "登録後の社員IDは変更できません";
        field.append(hint);
      }
      if (column.key === "superior_rank") {
        const hint = document.createElement("small");
        hint.className = "inspector-field-hint";
        hint.textContent = subordinateCount
          ? "担当部下がいるため必須です"
          : "一般ユーザーは空欄にします";
        field.append(hint);
      }
      fields.append(field);
    });
    basicSection.append(fields);

    const subordinateSection = document.createElement("section");
    subordinateSection.className = "inspector-section subordinate-section";
    const heading = createSectionHeading(
      "担当部下",
      "同じ社員を複数の上司へ割り当てられます",
    );
    const count = document.createElement("span");
    count.className = "section-count-badge";
    count.textContent = `${subordinateCount}名`;
    heading.append(count);
    subordinateSection.append(heading);

    const search = document.createElement("label");
    search.className = "subordinate-search";
    const searchLabel = document.createElement("span");
    searchLabel.className = "visually-hidden";
    searchLabel.textContent = "担当部下を検索";
    const searchInput = document.createElement("input");
    searchInput.type = "search";
    searchInput.placeholder = "氏名・社員IDで絞り込み";
    searchInput.autocomplete = "off";
    searchInput.dataset.subordinateSearch = "true";
    searchInput.value = subordinateSearchText;
    search.append(searchLabel, searchInput);
    subordinateSection.append(search);

    const list = document.createElement("div");
    list.id = "subordinateCandidateList";
    list.className = "subordinate-candidate-list";
    subordinateSection.append(list);

    const deleteButton = createDeleteButton("このユーザーを削除");
    form.append(header, basicSection, subordinateSection, deleteButton);
    renderSubordinateList();
  }

  function renderSubordinateList() {
    const list = byId("subordinateCandidateList");
    const supervisor = getSelectedUser();
    if (!list || !supervisor || !relationshipDraft) return;
    list.replaceChildren();
    const supervisorId = valueFor(supervisor, "employee_id");
    const userDraft = drafts.get("user_master");
    const candidates = userDraft.entries
      .filter((candidate) => candidate.id !== supervisor.id)
      .filter((candidate) => {
        if (!subordinateSearchText) return true;
        return [valueFor(candidate, "display_name"), valueFor(candidate, "employee_id")]
          .join(" ")
          .toLocaleLowerCase("ja")
          .includes(subordinateSearchText);
      });

    if (!candidates.length) {
      const empty = document.createElement("p");
      empty.className = "subordinate-empty";
      empty.textContent = "条件に一致するユーザーがいません。";
      list.append(empty);
      return;
    }

    candidates.forEach((candidate) => {
      const candidateId = valueFor(candidate, "employee_id");
      const label = document.createElement("label");
      label.className = "subordinate-option";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.dataset.subordinateId = candidateId;
      checkbox.checked = relationshipDraft.rows.some(
        (row) =>
          row.superior_employee_id === supervisorId &&
          row.subordinate_employee_id === candidateId,
      );
      checkbox.disabled = !supervisorId || !candidateId;

      const copy = document.createElement("span");
      copy.className = "subordinate-option-copy";
      const name = document.createElement("strong");
      name.textContent = valueFor(candidate, "display_name") || "名前未設定";
      const metadata = document.createElement("small");
      const otherSuperiors = relationshipDraft.rows
        .filter(
          (row) =>
            row.subordinate_employee_id === candidateId &&
            row.superior_employee_id !== supervisorId,
        )
        .map((row) => displayNameFor(row.superior_employee_id))
        .filter(Boolean);
      metadata.textContent = otherSuperiors.length
        ? `${candidateId} · 他の上司: ${otherSuperiors.join("、")}`
        : candidateId;
      copy.append(name, metadata);
      label.append(checkbox, copy);
      list.append(label);
    });
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
    form.append(header, fields, createDeleteButton("この行を削除"));
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
    copy.append(title, description);
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
    labelText.append(visibleLabel, key);

    let input;
    if (["boolean", "active", "team_level", "small_team", "parent_team"].includes(column.type)) {
      input = document.createElement("select");
      let choices = [];
      if (column.type === "boolean") {
        choices = [["0", "稼働日"], ["1", "休日"]];
      } else if (column.type === "active") {
        choices = [["1", "有効"], ["0", "廃止"]];
      } else if (column.type === "team_level") {
        choices = [["large", "大チーム"], ["medium", "中チーム"], ["small", "小チーム"]];
      } else if (column.type === "small_team") {
        choices = [["", "所属なし"], ...teamChoices("small", true)];
      } else {
        const selected = getDraft()?.entries.find(
          (entry) => entry.id === getDraft()?.selectedId,
        );
        const level = valueFor(selected, "team_level");
        const parentLevel = level === "medium" ? "large" : level === "small" ? "medium" : "";
        choices = [["", parentLevel ? "親チームを選択" : "親チームなし"]];
        if (parentLevel) choices.push(...teamChoices(parentLevel, false));
        options.disabled = options.disabled || !parentLevel;
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
    input.value = value;
    input.required = Boolean(options.required);
    input.disabled = Boolean(options.disabled);
    input.autocomplete = "off";
    const isInvalid = input.required && !String(value).trim();
    input.classList.toggle("is-invalid", isInvalid);
    input.setAttribute("aria-invalid", String(isInvalid));
    label.append(labelText, input);
    return label;
  }

  function teamChoices(level, activeOnly) {
    return (drafts.get("team_master")?.entries || [])
      .filter((entry) => valueFor(entry, "team_level") === level)
      .filter((entry) => !activeOnly || valueFor(entry, "is_active") === "1")
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

  function createDeleteButton(text) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "inspector-delete-button";
    button.dataset.deleteRow = "true";
    button.textContent = text;
    return button;
  }

  function dirtyFileCount() {
    let count = 0;
    if (isDraftDirty(drafts.get("user_master"))) count += 1;
    if (isRelationshipDirty()) count += 1;
    if (isDraftDirty(drafts.get("team_master"))) count += 1;
    if (isDraftDirty(drafts.get("calendar"))) count += 1;
    return count;
  }

  function syncAdminChrome() {
    const count = dirtyFileCount();
    const badge = byId("adminDirtyBadge");
    const saveButton = byId("adminSaveButton");
    const ledger = byId("adminLedgerCount");
    badge.classList.toggle("hidden", count === 0);
    badge.textContent = `${count}ファイル変更中`;
    saveButton.disabled = count === 0 || isLoading;
    ledger.textContent =
      count === 0
        ? "変更はありません"
        : drafts.get("user_master")?.migrationRequired
          ? "上司ランクの統合待ち"
          : `${count}ファイルを編集中`;
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

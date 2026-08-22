"use strict";

const STORAGE_KEY = "nippo-column-resize-playground:v1";
const COLUMN_ORDER = [
  "person",
  "date",
  "business",
  "detail",
  "superior-1",
  "superior-2",
];

const COLUMN_LABELS = {
  person: "名前",
  date: "日付",
  business: "業務名",
  detail: "業務詳細",
  "superior-1": "上司1",
  "superior-2": "上司2",
};

const WIDTH_PROFILES = {
  compact: [112, 80, 170, 300, 230, 230],
  standard: [128, 86, 190, 350, 260, 260],
  medium: [136, 94, 205, 390, 280, 280],
  large: [144, 102, 220, 420, 300, 300],
  xlarge: [160, 114, 240, 460, 330, 330],
};

const MIN_WIDTH_PROFILES = {
  compact: [88, 68, 112, 160, 145, 145],
  standard: [96, 72, 120, 180, 155, 155],
  medium: [104, 78, 130, 195, 165, 165],
  large: [112, 84, 140, 210, 175, 175],
  xlarge: [124, 110, 160, 235, 195, 195],
};

const MAX_WIDTHS = {
  person: 360,
  date: 220,
  business: 520,
  detail: 720,
  "superior-1": 620,
  "superior-2": 620,
};

const state = {
  fontSize: document.documentElement.dataset.fontSize || "large",
  widths: {},
  drag: null,
};

const table = document.getElementById("resizableTable");
const tableContent = document.getElementById("tableContent");
const tableScroll = document.getElementById("tableScroll");
const resizeGuide = document.getElementById("resizeGuide");
const resizeStatus = document.getElementById("resizeStatus");

function readStoredWidths() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function persistWidths() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.widths));
  } catch {
    // The playground still works when storage is unavailable on file URLs.
  }
}

function widthsFor(size) {
  const defaults = WIDTH_PROFILES[size];
  const stored = state.widths[size];
  if (!stored || typeof stored !== "object") {
    return Object.fromEntries(COLUMN_ORDER.map((id, index) => [id, defaults[index]]));
  }
  return Object.fromEntries(
    COLUMN_ORDER.map((id, index) => [
      id,
      clampWidth(id, Number(stored[id]) || defaults[index], size),
    ]),
  );
}

function clampWidth(columnId, width, size = state.fontSize) {
  const index = COLUMN_ORDER.indexOf(columnId);
  const minimum = MIN_WIDTH_PROFILES[size][index];
  return Math.round(Math.min(MAX_WIDTHS[columnId], Math.max(minimum, width)));
}

function applyWidths({ announce = false } = {}) {
  const widths = widthsFor(state.fontSize);
  let total = 0;
  COLUMN_ORDER.forEach((columnId) => {
    const width = widths[columnId];
    const col = table.querySelector(`col[data-column="${columnId}"]`);
    col.style.width = `${width}px`;
    total += width;
  });
  tableContent.style.width = `${total}px`;
  document.documentElement.style.setProperty(
    "--sticky-date-left",
    `${widths.person}px`,
  );
  if (announce) resizeStatus.textContent = "保存済みの列幅を反映しました";
}

function saveColumnWidth(columnId, width) {
  const profileWidths = widthsFor(state.fontSize);
  profileWidths[columnId] = clampWidth(columnId, width);
  state.widths[state.fontSize] = profileWidths;
  persistWidths();
  applyWidths();
  resizeStatus.textContent = `${COLUMN_LABELS[columnId]}：${profileWidths[columnId]}px`;
}

function positionGuide(clientX) {
  const bounds = tableScroll.getBoundingClientRect();
  resizeGuide.style.left = `${clientX}px`;
  resizeGuide.style.top = `${bounds.top}px`;
  resizeGuide.style.height = `${bounds.height}px`;
}

function startResize(event) {
  if (event.button !== 0) return;
  const handle = event.currentTarget;
  const header = handle.closest("th[data-column]");
  const columnId = header.dataset.column;
  const startWidth = widthsFor(state.fontSize)[columnId];
  state.drag = {
    pointerId: event.pointerId,
    handle,
    columnId,
    startX: event.clientX,
    startWidth,
  };
  handle.setPointerCapture(event.pointerId);
  handle.classList.add("is-active");
  document.body.classList.add("is-resizing");
  resizeGuide.classList.add("is-visible");
  positionGuide(event.clientX);
  resizeStatus.textContent = `${COLUMN_LABELS[columnId]}：${startWidth}px`;
  event.preventDefault();
}

function moveResize(event) {
  if (!state.drag || event.pointerId !== state.drag.pointerId) return;
  const width = clampWidth(
    state.drag.columnId,
    state.drag.startWidth + event.clientX - state.drag.startX,
  );
  const profileWidths = widthsFor(state.fontSize);
  profileWidths[state.drag.columnId] = width;
  state.widths[state.fontSize] = profileWidths;
  applyWidths();
  positionGuide(event.clientX);
  resizeStatus.textContent = `${COLUMN_LABELS[state.drag.columnId]}：${width}px`;
}

function finishResize(event) {
  if (!state.drag || event.pointerId !== state.drag.pointerId) return;
  const { handle, columnId } = state.drag;
  const width = widthsFor(state.fontSize)[columnId];
  if (handle.hasPointerCapture(event.pointerId)) {
    handle.releasePointerCapture(event.pointerId);
  }
  handle.classList.remove("is-active");
  document.body.classList.remove("is-resizing");
  resizeGuide.classList.remove("is-visible");
  state.drag = null;
  persistWidths();
  resizeStatus.textContent = `${COLUMN_LABELS[columnId]}：${width}pxで保存しました`;
}

function handleResizeKeydown(event) {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  const header = event.currentTarget.closest("th[data-column]");
  const columnId = header.dataset.column;
  const direction = event.key === "ArrowRight" ? 1 : -1;
  const step = event.shiftKey ? 24 : 8;
  saveColumnWidth(
    columnId,
    widthsFor(state.fontSize)[columnId] + direction * step,
  );
  event.preventDefault();
}

function setFontSize(size) {
  if (!WIDTH_PROFILES[size]) return;
  state.fontSize = size;
  document.documentElement.dataset.fontSize = size;
  document.querySelectorAll("[data-font-size]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.fontSize === size));
  });
  applyWidths({ announce: true });
}

function resetCurrentWidths() {
  delete state.widths[state.fontSize];
  persistWidths();
  applyWidths();
  resizeStatus.textContent = "現在の文字サイズの列幅をリセットしました";
}

function bindEvents() {
  document.querySelectorAll(".resize-handle").forEach((handle) => {
    handle.addEventListener("pointerdown", startResize);
    handle.addEventListener("pointermove", moveResize);
    handle.addEventListener("pointerup", finishResize);
    handle.addEventListener("pointercancel", finishResize);
    handle.addEventListener("keydown", handleResizeKeydown);
  });
  document.querySelectorAll("[data-font-size]").forEach((button) => {
    button.addEventListener("click", () => setFontSize(button.dataset.fontSize));
  });
  document.getElementById("resetWidthsButton").addEventListener("click", resetCurrentWidths);
  window.addEventListener("resize", () => applyWidths());
}

state.widths = readStoredWidths();
bindEvents();
setFontSize(state.fontSize);

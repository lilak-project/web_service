const SHEET_ID = "1Z58kV19shHwtP_Je65JCY1jaQQB92HWdceCgc7PyHL0";
const SHEET_GID = "0";
const SHEET_CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${SHEET_GID}`;
const INITIAL_ROWS = 5;
const AUTO_SAVE_KEY = "asset-list-helper:auto-save";
const PRINT_STYLE_ID = "dynamicPrintPageStyle";
const decoder = new TextDecoder();

const rowsEl = document.querySelector("#assetRows");
const rowTemplate = document.querySelector("#rowTemplate");
const addRowBtn = document.querySelector("#addRowBtn");
const addRowCountInput = document.querySelector("#addRowCount");
const clearAllBtn = document.querySelector("#clearAllBtn");
const exportPdfBtn = document.querySelector("#exportPdfBtn");
const exportHwpxBtn = document.querySelector("#exportHwpxBtn");
const zoomToggleBtn = document.querySelector("#zoomToggleBtn");
const saveListBtn = document.querySelector("#saveListBtn");
const saveAllPhotosBtn = document.querySelector("#saveAllPhotosBtn");
const loadListBtn = document.querySelector("#loadListBtn");
const loadListInput = document.querySelector("#loadListInput");
const documentTitleInput = document.querySelector("#documentTitle");
const printTitle = document.querySelector("#printTitle");
const printFontSizeInput = document.querySelector("#printFontSizeInput");
const rowStartInput = document.querySelector("#rowStartInput");
const printDescriptionSelect = document.querySelector("#printDescriptionSelect");
const printPhotoSelect = document.querySelector("#printPhotoSelect");
const requestTypeButtons = document.querySelectorAll(".request-type-btn");
const requestSections = document.querySelectorAll("[data-request-section]");
const requestInputs = document.querySelectorAll(".request-input");
const sheetStatus = document.querySelector("#sheetStatus");

const imageDialog = document.querySelector("#imageDialog");
const imageStage = document.querySelector("#imageStage");
const dialogImage = document.querySelector("#dialogImage");
const cropBox = document.querySelector("#cropBox");
const rotate90Btn = document.querySelector("#rotate90Btn");
const cropToggleBtn = document.querySelector("#cropToggleBtn");
const applyCropBtn = document.querySelector("#applyCropBtn");
const cancelCropBtn = document.querySelector("#cancelCropBtn");
const closeDialogBtn = document.querySelector("#closeDialogBtn");

let sheetCache = null;
let activeImage = null;
let cropMode = false;
let cropDrag = null;
let isRestoring = false;
let draggedPhotoCell = null;
let photoDirectoryHandle = null;
let activeRequestType = "takeout";

function scheduleAutoSave() {
  if (isRestoring) return;
  try {
    window.localStorage.setItem(AUTO_SAVE_KEY, JSON.stringify(buildListPayload()));
  } catch (error) {
    sheetStatus.textContent = "사진 용량이 커서 자동 저장을 건너뛰었습니다. 목록 저장하기를 사용하세요.";
  }
}

function clampNumber(value, min, max, fallback) {
  const number = Number.parseFloat(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(number, max));
}

function addRow() {
  const fragment = rowTemplate.content.cloneNode(true);
  const row = fragment.querySelector("tr");
  bindRow(row);
  rowsEl.appendChild(row);
  updateRowNumbers();
  scheduleAutoSave();
}

function addRows(count) {
  for (let i = 0; i < count; i += 1) {
    addRow();
  }
}

function getAddRowCount() {
  const count = Number.parseInt(addRowCountInput.value, 10);
  return Number.isFinite(count) ? Math.max(1, Math.min(count, 100)) : 1;
}

function getRowStartNumber() {
  const number = Number.parseInt(rowStartInput.value, 10);
  return Number.isFinite(number) ? Math.max(1, Math.min(number, 9999)) : 1;
}

function addRowsFromInput() {
  addRows(getAddRowCount());
}

function setRequestType(type) {
  activeRequestType = type;
  const isSimple = type === "simple";

  requestTypeButtons.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.requestType === type);
  });

  document.querySelector("#requestInfoPanel").hidden = isSimple;

  requestSections.forEach((section) => {
    section.hidden = isSimple || section.dataset.requestSection !== type;
  });

  scheduleAutoSave();
}

function bindRow(row) {
  const assetNumberInput = row.querySelector(".asset-number-input");
  const assetNameInput = row.querySelector(".asset-name-input");
  const assetDescriptionInput = row.querySelector(".asset-description-input");
  const assetDescriptionPrintText = row.querySelector(".asset-description-print-text");
  const loadNameBtn = row.querySelector(".load-name-btn");
  const manualNameBtn = row.querySelector(".manual-name-btn");
  const clearTextBtn = row.querySelector(".clear-text-btn");
  const clearRowBtn = row.querySelector(".clear-row-btn");
  const deleteRowBtn = row.querySelector(".delete-row-btn");
  const saveRowPhotosBtn = row.querySelector(".save-row-photos-btn");
  const swapRowPhotosBtn = row.querySelector(".swap-row-photos-btn");
  const message = row.querySelector(".row-message");

  assetNumberInput.addEventListener("input", () => {
    message.textContent = "";
    message.className = "row-message";
    scheduleAutoSave();
  });

  assetNumberInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      loadNameBtn.click();
    }
  });

  loadNameBtn.addEventListener("click", async () => {
    const assetNumber = assetNumberInput.value.trim();
    if (!assetNumber) {
      setRowMessage(message, "자산번호를 먼저 입력하세요.", "error");
      return;
    }

    setRowMessage(message, "자산명을 불러오는 중입니다.", "");
    loadNameBtn.disabled = true;

    try {
      const assetMap = await loadAssetMap();
      const asset = assetMap.get(assetNumber);
      if (!asset) {
        assetNameInput.disabled = false;
        assetDescriptionInput.disabled = false;
        setRowMessage(message, "찾을 수 없습니다. 직접 입력하세요.", "error");
        return;
      }

      assetNameInput.value = asset.name;
      assetDescriptionInput.value = asset.description;
      assetDescriptionPrintText.textContent = asset.description;
      assetNameInput.disabled = true;
      assetDescriptionInput.disabled = true;
      setRowMessage(message, "자산명을 불러왔습니다.", "success");
      scheduleAutoSave();
    } catch (error) {
      assetNameInput.disabled = false;
      assetDescriptionInput.disabled = false;
      setRowMessage(message, "시트를 불러올 수 없습니다. 직접 입력하세요.", "error");
      sheetStatus.textContent = "Google Sheets 접근 권한 또는 네트워크 상태를 확인하세요.";
    } finally {
      loadNameBtn.disabled = false;
    }
  });

  manualNameBtn.addEventListener("click", () => {
    assetNameInput.disabled = false;
    assetDescriptionInput.disabled = false;
    assetNameInput.focus();
    setRowMessage(message, "직접 입력할 수 있습니다.", "success");
  });

  assetNameInput.addEventListener("input", scheduleAutoSave);
  assetDescriptionInput.addEventListener("input", () => {
    assetDescriptionPrintText.textContent = assetDescriptionInput.value;
    scheduleAutoSave();
  });

  clearTextBtn.addEventListener("click", () => clearTextFields(row));
  clearRowBtn.addEventListener("click", () => clearRow(row));
  deleteRowBtn.addEventListener("click", () => deleteRow(row));
  saveRowPhotosBtn.addEventListener("click", () => saveRowPhotos(row));
  swapRowPhotosBtn.addEventListener("click", () => swapRowPhotos(row));

  row.querySelectorAll(".photo-cell").forEach(bindPhotoCell);
}

function clearTextFields(row) {
  row.querySelector(".asset-number-input").value = "";

  const assetNameInput = row.querySelector(".asset-name-input");
  assetNameInput.value = "";
  assetNameInput.disabled = true;

  const assetDescriptionInput = row.querySelector(".asset-description-input");
  assetDescriptionInput.value = "";
  assetDescriptionInput.disabled = true;

  const assetDescriptionPrintText = row.querySelector(".asset-description-print-text");
  assetDescriptionPrintText.textContent = "";

  const message = row.querySelector(".row-message");
  message.textContent = "";
  message.className = "row-message";

  scheduleAutoSave();
}

function clearRow(row) {
  clearTextFields(row);

  row.querySelectorAll(".photo-cell").forEach((cell) => {
    clearPhotoCell(cell);
  });

  scheduleAutoSave();
}

function deleteRow(row) {
  row.remove();
  updateRowNumbers();
  scheduleAutoSave();
}

function setRowMessage(element, text, type) {
  element.textContent = text;
  element.className = type ? `row-message ${type}` : "row-message";
}

async function loadAssetMap() {
  if (sheetCache) return sheetCache;

  sheetStatus.textContent = "Google Sheets에서 자산 목록을 불러오는 중입니다.";
  const response = await fetch(SHEET_CSV_URL);
  if (!response.ok) {
    throw new Error(`Sheet request failed: ${response.status}`);
  }

  const csv = await response.text();
  const rows = parseCsv(csv);
  const map = new Map();

  rows.forEach((row) => {
    const number = normalizeCell(row[0]);
    const name = normalizeCell(row[1]);
    const description = normalizeCell(row[2]);
    if (number && name) map.set(number, { name, description });
  });

  sheetCache = map;
  sheetStatus.textContent = `자산명 ${map.size}개를 불러왔습니다.`;
  return sheetCache;
}

function parseCsv(csv) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < csv.length; i += 1) {
    const char = csv[i];
    const next = csv[i + 1];

    if (char === '"' && quoted && next === '"') {
      cell += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }

  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }

  return rows;
}

function normalizeCell(value) {
  return String(value ?? "").trim();
}

function bindPhotoCell(cell) {
  const input = cell.querySelector(".photo-input");
  const loadButton = cell.querySelector(".photo-load-btn");
  const clearButton = cell.querySelector(".photo-clear-btn");
  const dropZone = cell.querySelector(".drop-zone");
  const preview = cell.querySelector(".photo-preview");

  loadButton.addEventListener("click", () => input.click());
  clearButton.addEventListener("click", (event) => {
    event.stopPropagation();
    clearPhotoCell(cell);
  });
  dropZone.addEventListener("click", () => {
    if (preview.dataset.imageSrc) {
      openImageDialog(preview);
    } else {
      input.click();
    }
  });

  input.addEventListener("change", () => {
    const [file] = input.files;
    if (file) setImagePreview(file, dropZone, preview);
  });

  dropZone.addEventListener("dragover", (event) => {
    if (event.dataTransfer.types.includes("Files") || event.dataTransfer.types.includes("text/plain")) {
      event.preventDefault();
      dropZone.classList.add("drag-over");
    }
  });

  dropZone.addEventListener("dragleave", () => {
    dropZone.classList.remove("drag-over");
  });

  dropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    dropZone.classList.remove("drag-over");

    const copiedPhoto = event.dataTransfer.getData("text/plain");
    if (copiedPhoto && draggedPhotoCell && draggedPhotoCell !== cell) {
      setImagePreviewSrc(copiedPhoto, dropZone, preview);
      draggedPhotoCell = null;
      return;
    }

    const [file] = event.dataTransfer.files;
    if (file && file.type.startsWith("image/")) {
      setImagePreview(file, dropZone, preview);
    }
  });

  preview.addEventListener("dragstart", (event) => {
    if (!preview.dataset.imageSrc) {
      event.preventDefault();
      return;
    }
    draggedPhotoCell = cell;
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData("text/plain", preview.dataset.imageSrc);
  });

  preview.addEventListener("dragend", () => {
    draggedPhotoCell = null;
  });

  dropZone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      dropZone.click();
    }
  });
}

function clearPhotoCell(cell) {
  const input = cell.querySelector(".photo-input");
  const dropZone = cell.querySelector(".drop-zone");
  const preview = cell.querySelector(".photo-preview");
  input.value = "";
  preview.src = "";
  delete preview.dataset.imageSrc;
  preview.removeAttribute("src");
  dropZone.classList.remove("has-image", "drag-over");
  scheduleAutoSave();
}

function setImagePreview(file, dropZone, preview) {
  const reader = new FileReader();
  reader.addEventListener("load", () => {
    setImagePreviewSrc(reader.result, dropZone, preview);
  });
  reader.readAsDataURL(file);
}

function setImagePreviewSrc(src, dropZone, preview) {
  preview.src = src;
  preview.dataset.imageSrc = src;
  dropZone.classList.add("has-image");
  scheduleAutoSave();
}

function applyPhotoPreviewSrc(src, cell) {
  const input = cell.querySelector(".photo-input");
  const dropZone = cell.querySelector(".drop-zone");
  const preview = cell.querySelector(".photo-preview");
  input.value = "";

  if (!src) {
    preview.src = "";
    delete preview.dataset.imageSrc;
    preview.removeAttribute("src");
    dropZone.classList.remove("has-image", "drag-over");
    return;
  }

  preview.src = src;
  preview.dataset.imageSrc = src;
  dropZone.classList.add("has-image");
  dropZone.classList.remove("drag-over");
}

function restorePhotoPreview(src, cell) {
  try {
    applyPhotoPreviewSrc(src, cell);
  } catch (error) {
    console.warn("Photo restore skipped:", error);
  }
}

function swapRowPhotos(row) {
  const numberPhotoCell = row.querySelector('[data-photo-type="number"]');
  const wholePhotoCell = row.querySelector('[data-photo-type="whole"]');
  const numberPhoto = numberPhotoCell.querySelector(".photo-preview").dataset.imageSrc || "";
  const wholePhoto = wholePhotoCell.querySelector(".photo-preview").dataset.imageSrc || "";

  applyPhotoPreviewSrc(wholePhoto, numberPhotoCell);
  applyPhotoPreviewSrc(numberPhoto, wholePhotoCell);
  scheduleAutoSave();
}

function openImageDialog(preview) {
  activeImage = preview;
  dialogImage.src = preview.dataset.imageSrc || preview.src;
  resetCropMode();
  imageDialog.showModal();
}

function resetCropMode() {
  cropMode = false;
  cropDrag = null;
  cropBox.hidden = true;
  applyCropBtn.hidden = true;
  cancelCropBtn.hidden = true;
  cropToggleBtn.hidden = false;
}

function enterCropMode() {
  cropMode = true;
  cropBox.hidden = false;
  applyCropBtn.hidden = false;
  cancelCropBtn.hidden = false;
  cropToggleBtn.hidden = true;

  const bounds = getRenderedImageRect();
  const size = Math.min(bounds.width, bounds.height) * 0.62;
  setCropBox({
    left: bounds.left + (bounds.width - size) / 2,
    top: bounds.top + (bounds.height - size) / 2,
    width: size,
    height: size,
  });
}

function getRenderedImageRect() {
  const stageRect = imageStage.getBoundingClientRect();
  const imageRect = dialogImage.getBoundingClientRect();
  return {
    left: imageRect.left - stageRect.left,
    top: imageRect.top - stageRect.top,
    width: imageRect.width,
    height: imageRect.height,
  };
}

function setCropBox(rect) {
  const bounds = getRenderedImageRect();
  const minSize = 50;
  const width = Math.max(minSize, Math.min(rect.width, bounds.width));
  const height = Math.max(minSize, Math.min(rect.height, bounds.height));
  const left = Math.max(bounds.left, Math.min(rect.left, bounds.left + bounds.width - width));
  const top = Math.max(bounds.top, Math.min(rect.top, bounds.top + bounds.height - height));

  cropBox.style.left = `${left}px`;
  cropBox.style.top = `${top}px`;
  cropBox.style.width = `${width}px`;
  cropBox.style.height = `${height}px`;
}

function getCropRect() {
  return {
    left: Number.parseFloat(cropBox.style.left),
    top: Number.parseFloat(cropBox.style.top),
    width: Number.parseFloat(cropBox.style.width),
    height: Number.parseFloat(cropBox.style.height),
  };
}

function applyCrop() {
  if (!activeImage || !dialogImage.naturalWidth || !dialogImage.naturalHeight) return;

  const imageRect = getRenderedImageRect();
  const cropRect = getCropRect();
  const scaleX = dialogImage.naturalWidth / imageRect.width;
  const scaleY = dialogImage.naturalHeight / imageRect.height;

  const sourceX = Math.max(0, (cropRect.left - imageRect.left) * scaleX);
  const sourceY = Math.max(0, (cropRect.top - imageRect.top) * scaleY);
  const sourceWidth = Math.min(dialogImage.naturalWidth - sourceX, cropRect.width * scaleX);
  const sourceHeight = Math.min(dialogImage.naturalHeight - sourceY, cropRect.height * scaleY);

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(sourceWidth);
  canvas.height = Math.round(sourceHeight);

  const context = canvas.getContext("2d");
  context.drawImage(
    dialogImage,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    0,
    0,
    canvas.width,
    canvas.height,
  );

  const croppedSrc = canvas.toDataURL("image/png");
  activeImage.src = croppedSrc;
  activeImage.dataset.imageSrc = croppedSrc;
  dialogImage.src = croppedSrc;
  resetCropMode();
  scheduleAutoSave();
}

function rotateImage90() {
  if (!activeImage || !dialogImage.naturalWidth || !dialogImage.naturalHeight) return;

  resetCropMode();

  const canvas = document.createElement("canvas");
  canvas.width = dialogImage.naturalHeight;
  canvas.height = dialogImage.naturalWidth;

  const context = canvas.getContext("2d");
  context.translate(canvas.width / 2, canvas.height / 2);
  context.rotate(Math.PI / 2);
  context.drawImage(dialogImage, -dialogImage.naturalWidth / 2, -dialogImage.naturalHeight / 2);

  const rotatedSrc = canvas.toDataURL("image/png");
  activeImage.src = rotatedSrc;
  activeImage.dataset.imageSrc = rotatedSrc;
  dialogImage.src = rotatedSrc;
  scheduleAutoSave();
}

rotate90Btn.addEventListener("click", rotateImage90);
cropToggleBtn.addEventListener("click", enterCropMode);
cancelCropBtn.addEventListener("click", resetCropMode);
applyCropBtn.addEventListener("click", applyCrop);
closeDialogBtn.addEventListener("click", () => imageDialog.close());
imageDialog.addEventListener("close", resetCropMode);

cropBox.addEventListener("pointerdown", (event) => {
  if (!cropMode) return;
  event.preventDefault();

  const rect = getCropRect();
  const resize = event.offsetX > rect.width - 18 && event.offsetY > rect.height - 18;
  cropDrag = {
    resize,
    startX: event.clientX,
    startY: event.clientY,
    rect,
  };
  cropBox.setPointerCapture(event.pointerId);
});

cropBox.addEventListener("pointermove", (event) => {
  if (!cropDrag) return;

  const dx = event.clientX - cropDrag.startX;
  const dy = event.clientY - cropDrag.startY;

  if (cropDrag.resize) {
    setCropBox({
      ...cropDrag.rect,
      width: cropDrag.rect.width + dx,
      height: cropDrag.rect.height + dy,
    });
  } else {
    setCropBox({
      ...cropDrag.rect,
      left: cropDrag.rect.left + dx,
      top: cropDrag.rect.top + dy,
    });
  }
});

cropBox.addEventListener("pointerup", () => {
  cropDrag = null;
});

window.addEventListener("resize", () => {
  if (cropMode) enterCropMode();
});

function getRowsData() {
  return [...rowsEl.querySelectorAll("tr")].map((row) => ({
    assetNumber: row.querySelector(".asset-number-input").value.trim(),
    assetName: row.querySelector(".asset-name-input").value.trim(),
    assetDescription: row.querySelector(".asset-description-input").value.trim(),
    numberPhoto: row.querySelector('[data-photo-type="number"] .photo-preview').dataset.imageSrc || "",
    wholePhoto: row.querySelector('[data-photo-type="whole"] .photo-preview').dataset.imageSrc || "",
  }));
}

function getRequestData() {
  const fields = {};
  requestInputs.forEach((input) => {
    fields[input.dataset.requestField] = input.value;
  });

  return {
    type: activeRequestType,
    fields,
  };
}

function buildListPayload() {
  const title = documentTitleInput.value.trim() || "자산 목록";
  return {
    version: 1,
    title,
    savedAt: new Date().toISOString(),
    printSettings: {
      fontSize: clampNumber(printFontSizeInput.value, 8, 18, 12),
      rowStart: getRowStartNumber(),
      orientation: "portrait",
      viewMode: "wide",
      description: printDescriptionSelect.value === "hide" ? "hide" : "show",
      photos: printPhotoSelect.value === "hide" ? "hide" : "show",
    },
    request: getRequestData(),
    rows: getRowsData(),
  };
}

function saveList() {
  const title = documentTitleInput.value.trim() || "자산 목록";
  const payload = buildListPayload();
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${sanitizeFileName(title)}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function exportHwpx() {
  if (!window.CensHwpx) {
    alert("HWPX 모듈을 불러오지 못했습니다. 페이지를 새로고침하세요.");
    return;
  }

  try {
    const title = documentTitleInput.value.trim() || "자산 목록";
    const payload = buildListPayload();
    exportHwpxBtn.disabled = true;
    exportHwpxBtn.textContent = "HWPX 생성 중";
    const blob = await window.CensHwpx.build(payload, getRequestTypeLabel());
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${sanitizeFileName(title)}.hwpx`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  } catch (error) {
    alert(`HWPX 파일을 만들 수 없습니다.\n${error.message || error}`);
  } finally {
    exportHwpxBtn.disabled = false;
    exportHwpxBtn.textContent = "HWPX";
  }
}

function sanitizeFileName(value) {
  return value.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim() || "asset-list";
}

function getImageExtension(src) {
  const match = /^data:image\/([^;,]+)/.exec(src);
  if (!match) return "png";

  const type = match[1].toLowerCase();
  if (type === "jpeg") return "jpg";
  if (type === "svg+xml") return "svg";
  return type;
}

function downloadDataUrl(src, filenameBase) {
  const link = document.createElement("a");
  link.href = src;
  link.download = `${filenameBase}.${getImageExtension(src)}`;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function dataUrlToBlob(src) {
  const [metadata, data] = src.split(",");
  const mimeMatch = /^data:([^;]+)/.exec(metadata);
  const mimeType = mimeMatch ? mimeMatch[1] : "application/octet-stream";
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return new Blob([bytes], { type: mimeType });
}

async function getPhotoDirectoryHandle({ forcePick = false } = {}) {
  if (!("showDirectoryPicker" in window)) return null;
  if (photoDirectoryHandle && !forcePick) return photoDirectoryHandle;

  photoDirectoryHandle = await window.showDirectoryPicker({
    id: "asset-photo-save-directory",
    mode: "readwrite",
  });
  return photoDirectoryHandle;
}

async function savePhotoFiles(photos, options = {}) {
  const directoryHandle = await getPhotoDirectoryHandle(options);

  if (!directoryHandle) {
    photos.forEach((photo) => downloadDataUrl(photo.src, photo.filenameBase));
    return;
  }

  for (const photo of photos) {
    const filename = `${photo.filenameBase}.${getImageExtension(photo.src)}`;
    const fileHandle = await directoryHandle.getFileHandle(filename, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(dataUrlToBlob(photo.src));
    await writable.close();
  }
}

function getRowPhotoDownloads(row) {
  const rowNumber = row.querySelector(".row-number").textContent.trim();
  const assetNumber = row.querySelector(".asset-number-input").value.trim() || `row${rowNumber}`;
  const safeAssetNumber = sanitizeFileName(assetNumber);
  const numberPhoto = row.querySelector('[data-photo-type="number"] .photo-preview').dataset.imageSrc || "";
  const wholePhoto = row.querySelector('[data-photo-type="whole"] .photo-preview').dataset.imageSrc || "";
  const photos = [];

  if (numberPhoto) {
    photos.push({
      src: numberPhoto,
      filenameBase: `asset_${safeAssetNumber}_1`,
    });
  }

  if (wholePhoto) {
    photos.push({
      src: wholePhoto,
      filenameBase: `asset_${safeAssetNumber}_2`,
    });
  }

  return photos;
}

async function saveRowPhotos(row) {
  const photos = getRowPhotoDownloads(row);
  if (!photos.length) {
    alert("저장할 사진이 없습니다.");
    return;
  }

  try {
    await savePhotoFiles(photos);
    sheetStatus.textContent = `사진 ${photos.length}개를 저장했습니다.`;
  } catch (error) {
    if (error.name !== "AbortError") {
      alert("사진을 저장할 수 없습니다.");
    }
  }
}

async function saveAllPhotos() {
  const photos = [...rowsEl.querySelectorAll("tr")].flatMap(getRowPhotoDownloads);
  if (!photos.length) {
    alert("저장할 사진이 없습니다.");
    return;
  }

  try {
    await savePhotoFiles(photos, { forcePick: true });
    sheetStatus.textContent = `사진 ${photos.length}개를 저장했습니다.`;
  } catch (error) {
    if (error.name !== "AbortError") {
      alert("사진을 저장할 수 없습니다.");
    }
  }
}

async function loadListFile(file) {
  try {
    const data = await readListFile(file);
    applyListData(normalizeListData(data));
    sheetStatus.textContent = file.name.toLowerCase().endsWith(".hwpx") ? "HWPX 목록을 불러왔습니다." : "저장된 목록을 불러왔습니다.";
  } catch (error) {
    console.error("List load failed:", error);
    alert(`목록 파일을 읽을 수 없습니다.\n${error.message || error}`);
  } finally {
    loadListInput.value = "";
  }
}

async function readListFile(file) {
  if (file.name.toLowerCase().endsWith(".hwpx")) {
    return parseHwpxList(new Uint8Array(await file.arrayBuffer()));
  }
  return JSON.parse(await file.text());
}

function readZipUint16(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readZipUint32(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function findZipFooter(bytes) {
  for (let index = bytes.length - 22; index >= 0; index -= 1) {
    if (readZipUint32(bytes, index) === 0x06054b50) return index;
  }
  throw new Error("HWPX ZIP footer was not found.");
}

async function inflateZipEntry(bytes, name) {
  if (!("DecompressionStream" in window)) {
    throw new Error(`압축된 HWPX 항목을 풀 수 없습니다: ${name}`);
  }

  const formats = ["deflate-raw", "deflate"];
  for (const format of formats) {
    try {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (error) {
      if (format === formats[formats.length - 1]) throw error;
    }
  }

  throw new Error(`압축된 HWPX 항목을 풀 수 없습니다: ${name}`);
}

async function parseZipEntries(bytes) {
  const footer = findZipFooter(bytes);
  const entryCount = readZipUint16(bytes, footer + 10);
  const centralOffset = readZipUint32(bytes, footer + 16);
  const entries = [];
  let offset = centralOffset;

  for (let index = 0; index < entryCount; index += 1) {
    if (readZipUint32(bytes, offset) !== 0x02014b50) {
      throw new Error("Invalid HWPX central directory.");
    }

    const method = readZipUint16(bytes, offset + 10);
    const compressedSize = readZipUint32(bytes, offset + 20);
    const uncompressedSize = readZipUint32(bytes, offset + 24);
    const nameLength = readZipUint16(bytes, offset + 28);
    const extraLength = readZipUint16(bytes, offset + 30);
    const commentLength = readZipUint16(bytes, offset + 32);
    const localOffset = readZipUint32(bytes, offset + 42);
    const name = decoder.decode(bytes.slice(offset + 46, offset + 46 + nameLength));

    if (![0, 8].includes(method)) {
      throw new Error(`지원하지 않는 HWPX ZIP 압축 방식입니다: ${name}`);
    }
    if (readZipUint32(bytes, localOffset) !== 0x04034b50) {
      throw new Error(`Invalid HWPX ZIP entry: ${name}`);
    }

    const localNameLength = readZipUint16(bytes, localOffset + 26);
    const localExtraLength = readZipUint16(bytes, localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = bytes.slice(dataStart, dataStart + compressedSize);
    entries.push({ name, data: method === 8 ? await inflateZipEntry(data, name) : data });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

function xmlChildrenByName(node, localName) {
  return Array.from(node.children || []).filter((child) => child.localName === localName);
}

function xmlDescendantsByName(node, localName) {
  return Array.from(node.getElementsByTagName("*")).filter((child) => child.localName === localName);
}

function xmlText(node) {
  if (!node) return "";
  return xmlDescendantsByName(node, "t")
    .map((item) => item.textContent || "")
    .join("")
    .trim();
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function imageMimeFromPath(path) {
  const lower = path.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".bmp")) return "image/bmp";
  return "image/png";
}

function buildHwpxImageMap(entries) {
  const map = new Map();
  entries.forEach((entry) => {
    const match = /^BinData\/([^/.]+)\.[^/]+$/i.exec(entry.name);
    if (!match) return;
    map.set(match[1], `data:${imageMimeFromPath(entry.name)};base64,${bytesToBase64(entry.data)}`);
  });
  return map;
}

function getCellImage(cell, imageMap) {
  if (!cell) return "";
  const image = xmlDescendantsByName(cell, "img")[0];
  const id = image?.getAttribute("binaryItemIDRef");
  return id ? imageMap.get(id) || "" : "";
}

function parseHwpxIntro(paragraphs) {
  const fieldLabels = {
    "신청자 이름": "applicantName",
    "소속": "applicantOrg",
    "반출 기간": "takeoutPeriod",
    "반출 사유": "takeoutReason",
    "반출 장소": "takeoutPlace",
    "자산공동활용여부": "assetSharing",
    "국외/국내 반출 여부": "domesticOrInternational",
    "보안관리대상물품 여부": "securityManagedItem",
    "관세감면사후관리 대상물품 면세번호": "customsExemptionNumber",
    "연장 기간": "extensionPeriod",
    "연장 사유": "extensionReason",
    "반입 일자": "returnDate",
    "반입 사유": "returnReason",
    "반입 장소": "returnPlace",
  };
  const typeLabels = {
    반출신청: "takeout",
    연장신청: "extension",
    반입신청: "return",
  };
  const fields = {};
  let title = "자산 목록";
  let type = "takeout";

  paragraphs.forEach((line, index) => {
    if (!line) return;
    if (index === 0) {
      const titleMatch = /^\[([^\]]+)\]\s*(.*)$/.exec(line);
      if (titleMatch) {
        type = typeLabels[titleMatch[1]] || type;
        title = titleMatch[2] || title;
      } else {
        title = line;
      }
      return;
    }

    const fieldMatch = /^([^:]+):\s*([\s\S]*)$/.exec(line);
    if (!fieldMatch) return;
    const key = fieldLabels[fieldMatch[1].trim()];
    if (key) fields[key] = fieldMatch[2].trim();
  });

  return { title, request: { type, fields } };
}

async function parseHwpxList(bytes) {
  const entries = await parseZipEntries(bytes);
  const sectionEntry = entries.find((entry) => entry.name === "Contents/section0.xml");
  if (!sectionEntry) throw new Error("HWPX section0.xml was not found.");

  const xml = decoder.decode(sectionEntry.data);
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("HWPX XML could not be parsed.");

  const imageMap = buildHwpxImageMap(entries);
  const section = doc.documentElement;
  const introLines = [];
  const sectionParagraphs = xmlChildrenByName(section, "p");

  for (const paragraph of sectionParagraphs) {
    if (xmlDescendantsByName(paragraph, "tbl").length) break;
    const line = xmlText(paragraph);
    if (line) introLines.push(line);
  }

  const table = xmlDescendantsByName(doc, "tbl")[0];
  if (!table) throw new Error("HWPX 자산 표를 찾을 수 없습니다.");

  const tableRows = xmlChildrenByName(table, "tr");
  if (tableRows.length < 2) throw new Error("HWPX 자산 표에 행이 없습니다.");

  const headers = xmlChildrenByName(tableRows[0], "tc").map(xmlText);
  const columnIndex = (label) => headers.indexOf(label);
  const indexColumn = columnIndex("#");
  const assetNumberColumn = columnIndex("자산번호");
  const assetNameColumn = columnIndex("자산명");
  const numberPhotoColumn = columnIndex("자산번호가 확대된 사진");
  const wholePhotoColumn = columnIndex("자산 전체 사진");
  const descriptionColumn = columnIndex("자산설명");
  const rows = tableRows.slice(1).map((row) => {
    const cells = xmlChildrenByName(row, "tc");
    return {
      assetNumber: assetNumberColumn >= 0 ? xmlText(cells[assetNumberColumn]) : "",
      assetName: assetNameColumn >= 0 ? xmlText(cells[assetNameColumn]) : "",
      assetDescription: descriptionColumn >= 0 ? xmlText(cells[descriptionColumn]) : "",
      numberPhoto: numberPhotoColumn >= 0 ? getCellImage(cells[numberPhotoColumn], imageMap) : "",
      wholePhoto: wholePhotoColumn >= 0 ? getCellImage(cells[wholePhotoColumn], imageMap) : "",
    };
  });
  const firstRowNumber = indexColumn >= 0 ? Number.parseInt(xmlText(xmlChildrenByName(tableRows[1], "tc")[indexColumn]), 10) : 1;
  const intro = parseHwpxIntro(introLines);

  return {
    version: 1,
    title: intro.title,
    savedAt: new Date().toISOString(),
    printSettings: {
      fontSize: 12,
      rowStart: Number.isFinite(firstRowNumber) ? firstRowNumber : 1,
      orientation: "portrait",
      viewMode: "wide",
      description: descriptionColumn >= 0 ? "show" : "hide",
      photos: numberPhotoColumn >= 0 || wholePhotoColumn >= 0 ? "show" : "hide",
    },
    request: intro.request,
    rows,
  };
}

function getListRows(data) {
  if (Array.isArray(data?.rows)) return data.rows;
  if (Array.isArray(data?.assets)) return data.assets;
  if (Array.isArray(data?.items)) return data.items;
  return null;
}

function normalizeRowData(row = {}) {
  return {
    assetNumber: row.assetNumber || row.assetId || row.assetID || row.id || "",
    assetName: row.assetName || row.name || row.asset_name || "",
    assetDescription: row.assetDescription || row.description || row.asset_description || "",
    numberPhoto: row.numberPhoto || row.photo1 || row.assetNumberPhoto || row.number_photo || "",
    wholePhoto: row.wholePhoto || row.photo2 || row.assetPhoto || row.whole_photo || "",
  };
}

function normalizeListData(data) {
  const rows = getListRows(data);
  if (!data || !rows) {
    throw new Error("Invalid list data");
  }

  return {
    ...data,
    printSettings: data.printSettings || {},
    request: data.request || { type: "takeout", fields: {} },
    rows: rows.map(normalizeRowData),
  };
}

function applyListData(data) {
  if (!data || !Array.isArray(data.rows)) {
    throw new Error("Invalid list data");
  }

  isRestoring = true;

  try {
    documentTitleInput.value = data.title || "자산 목록 작성";
    if (data.printSettings) {
      printFontSizeInput.value = data.printSettings.fontSize || 12;
      rowStartInput.value = data.printSettings.rowStart || 1;
      printDescriptionSelect.value = data.printSettings.description === "hide" ? "hide" : "show";
      printPhotoSelect.value = data.printSettings.photos === "hide" ? "hide" : "show";
    }

    requestInputs.forEach((input) => {
      input.value = data.request?.fields?.[input.dataset.requestField] || "";
    });
    setRequestType(data.request?.type || "takeout");

    rowsEl.innerHTML = "";

    const rows = data.rows.length ? data.rows : Array.from({ length: INITIAL_ROWS }, () => ({}));
    rows.forEach((rowData) => {
      addRow();
      const row = rowsEl.lastElementChild;
      const assetNumberInput = row.querySelector(".asset-number-input");
      const assetNameInput = row.querySelector(".asset-name-input");
      const assetDescriptionInput = row.querySelector(".asset-description-input");
      const assetDescriptionPrintText = row.querySelector(".asset-description-print-text");
      const numberPhotoCell = row.querySelector('[data-photo-type="number"]');
      const wholePhotoCell = row.querySelector('[data-photo-type="whole"]');

      assetNumberInput.value = rowData.assetNumber || "";
      assetNameInput.value = rowData.assetName || "";
      assetDescriptionInput.value = rowData.assetDescription || "";
      assetDescriptionPrintText.textContent = rowData.assetDescription || "";
      assetNameInput.disabled = false;
      assetDescriptionInput.disabled = false;

      if (rowData.numberPhoto) {
        restorePhotoPreview(rowData.numberPhoto, numberPhotoCell);
      }

      if (rowData.wholePhoto) {
        restorePhotoPreview(rowData.wholePhoto, wholePhotoCell);
      }
    });
  } finally {
    isRestoring = false;
    updateRequestPrintValues();
    scheduleAutoSave();
  }
}

function restoreAutoSave() {
  const saved = window.localStorage.getItem(AUTO_SAVE_KEY);
  if (!saved) return false;

  try {
    applyListData(normalizeListData(JSON.parse(saved)));
    sheetStatus.textContent = "저장된 작성 내용을 복원했습니다.";
    return true;
  } catch (error) {
    window.localStorage.removeItem(AUTO_SAVE_KEY);
    return false;
  }
}

addRowBtn.addEventListener("click", addRowsFromInput);
addRowCountInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    addRowsFromInput();
  }
});
saveListBtn.addEventListener("click", saveList);
exportHwpxBtn.addEventListener("click", exportHwpx);
saveAllPhotosBtn.addEventListener("click", saveAllPhotos);
loadListBtn.addEventListener("click", () => loadListInput.click());
loadListInput.addEventListener("change", () => {
  const [file] = loadListInput.files;
  if (file) loadListFile(file);
});

zoomToggleBtn.addEventListener("click", () => {
  const appShell = document.querySelector(".app-shell");
  const isNarrow = appShell.classList.toggle("is-narrow");
  zoomToggleBtn.textContent = isNarrow ? "확대" : "축소";
});

function applyPrintSettings() {
  const fontSize = clampNumber(printFontSizeInput.value, 8, 18, 12);
  const orientation = "portrait";
  const viewMode = "wide";
  const descriptionMode = printDescriptionSelect.value === "hide" ? "hide" : "show";
  const photoMode = printPhotoSelect.value === "hide" ? "hide" : "show";
  let printStyle = document.querySelector(`#${PRINT_STYLE_ID}`);

  if (!printStyle) {
    printStyle = document.createElement("style");
    printStyle.id = PRINT_STYLE_ID;
    document.head.appendChild(printStyle);
  }

  printStyle.textContent = `
    @page {
      size: A4 ${orientation};
      margin: 10mm;
    }

    @media print {
      @page {
        size: A4 ${orientation};
        margin: 10mm;
      }
    }
  `;
  document.documentElement.style.setProperty("--print-font-size", `${fontSize}px`);
  document.documentElement.style.setProperty("--print-table-width", viewMode === "narrow" ? "80%" : "100%");
  document.body.dataset.printOrientation = orientation;
  document.body.dataset.printViewMode = viewMode;
  document.body.classList.toggle("print-hide-description", descriptionMode === "hide");
  document.body.classList.toggle("print-hide-photos", photoMode === "hide");
  document.body.classList.toggle("print-simple-request", activeRequestType === "simple");
  updatePrintTitle();
  markEmptyRequestFields();
  updateRequestPrintValues();
  resizeTextareasForPrint();
}

function getRequestTypeLabel() {
  const labels = {
    takeout: "반출신청",
    extension: "연장신청",
    return: "반입신청",
  };
  return labels[activeRequestType] || "";
}

function updatePrintTitle() {
  const title = documentTitleInput.value.trim() || "자산 목록";
  const requestTypeLabel = getRequestTypeLabel();
  printTitle.textContent = requestTypeLabel ? `[${requestTypeLabel}] ${title}` : title;
}

function markEmptyRequestFields() {
  requestInputs.forEach((input) => {
    input.closest("label").classList.toggle("is-print-empty", !input.value.trim());
  });
}

function ensureRequestPrintValues() {
  requestInputs.forEach((input) => {
    if (input.parentElement.querySelector(".request-print-value")) return;
    const printValue = document.createElement("span");
    printValue.className = "request-print-value";
    input.insertAdjacentElement("afterend", printValue);
  });
}

function updateRequestPrintValues() {
  ensureRequestPrintValues();
  requestInputs.forEach((input) => {
    input.parentElement.querySelector(".request-print-value").textContent = input.value.trim();
  });
}

function getVisibleRequiredFields() {
  const fields = [];

  if (!documentTitleInput.value.trim()) {
    fields.push({
      element: documentTitleInput,
      label: "제목",
    });
  }

  if (activeRequestType === "simple") return fields;

  requestInputs.forEach((input) => {
    const section = input.closest("[data-request-section]");
    if (section && section.dataset.requestSection !== activeRequestType) return;

    fields.push({
      element: input,
      label: input.closest("label").querySelector("span").textContent.trim(),
    });
  });

  return fields;
}

function validateBeforePrint() {
  const missing = getVisibleRequiredFields().filter((field) => !field.element.value.trim());
  if (!missing.length) return true;

  alert(`다음 항목을 채워주세요.\n\n${missing.map((field) => `- ${field.label}`).join("\n")}`);
  missing[0].element.focus();
  return false;
}

function resizeTextareasForPrint() {
  document.querySelectorAll(".asset-name-input, .asset-description-input, .request-textarea").forEach((textarea) => {
    textarea.style.height = "auto";
    textarea.style.height = `${Math.max(1, textarea.scrollHeight)}px`;
  });
}

function waitForPrintStyles() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(resolve);
    });
  });
}

window.addEventListener("beforeprint", applyPrintSettings);
window.addEventListener("afterprint", () => {
  document.querySelectorAll(".asset-name-input, .asset-description-input, .request-textarea").forEach((textarea) => {
    textarea.style.height = "";
  });
});

exportPdfBtn.addEventListener("click", async () => {
  if (!validateBeforePrint()) return;

  const title = documentTitleInput.value.trim() || "자산 목록";
  const previousTitle = document.title;
  document.title = title;
  applyPrintSettings();
  await waitForPrintStyles();
  window.print();
  setTimeout(() => {
    document.title = previousTitle;
  }, 500);
});

clearAllBtn.addEventListener("click", () => {
  if (!confirm("작성 중인 내용을 모두 비울까요?")) return;
  rowsEl.innerHTML = "";
  addRows(INITIAL_ROWS);
  scheduleAutoSave();
});

documentTitleInput.addEventListener("input", scheduleAutoSave);
printFontSizeInput.addEventListener("input", scheduleAutoSave);
rowStartInput.addEventListener("input", () => {
  updateRowNumbers();
  scheduleAutoSave();
});
printDescriptionSelect.addEventListener("change", scheduleAutoSave);
printPhotoSelect.addEventListener("change", scheduleAutoSave);
requestTypeButtons.forEach((button) => {
  button.addEventListener("click", () => setRequestType(button.dataset.requestType));
});
requestInputs.forEach((input) => {
  input.addEventListener("input", () => {
    updateRequestPrintValues();
    scheduleAutoSave();
  });
});

ensureRequestPrintValues();
updateRequestPrintValues();

function updateRowNumbers() {
  const startNumber = getRowStartNumber();
  rowsEl.querySelectorAll("tr").forEach((row, index) => {
    row.querySelector(".row-number").textContent = startNumber + index;
  });
}

if (!restoreAutoSave()) {
  addRows(INITIAL_ROWS);
}

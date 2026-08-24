import { storage } from "./storage.js";

const SLOT_COUNT = 9;
const HOLD_DURATION_MS = 2000;
const ERROR_DISPLAY_MS = 1800;

const slots = Array.from({ length: SLOT_COUNT }, (_, index) => ({
  id: index + 1,
  audioFile: null,
  audioFileName: "",
  audioUrl: null,
  imageFile: null,
  imageFileName: "",
  imageUrl: null,
  label: "",
  hasError: false,
}));

const playback = {
  status: "idle",
  activeSlotId: null,
  requestId: 0,
  errorSlotId: null,
};

const grid = document.querySelector("#jukeboxGrid");
const slotEditors = document.querySelector("#slotEditors");
const settingsTrigger = document.querySelector("#settingsTrigger");
const settingsDialog = document.querySelector("#settingsDialog");
const closeSettingsButton = document.querySelector("#closeSettings");
const audio = document.querySelector("#audioPlayer");
const toast = document.querySelector("#toast");
const liveRegion = document.querySelector("#liveRegion");

let holdTimer = null;
let holdOpened = false;
let toastTimer = null;
let errorTimer = null;

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = (bytes / Math.pow(1024, i)).toFixed(i >= 2 ? 1 : 0);
  return `${value} ${units[i]}`;
}

function isSlotReady(slot) {
  return Boolean(slot.audioFile && slot.audioUrl && slot.imageFile && slot.imageUrl);
}

function getSlot(slotId) {
  return slots.find((slot) => slot.id === Number(slotId));
}

function getFileLabel(fileName) {
  return fileName.replace(/\.[^/.]+$/, "").trim() || "음악";
}

function renderJukebox() {
  const fragment = document.createDocumentFragment();

  slots.forEach((slot) => {
    const ready = isSlotReady(slot);
    const isActive = playback.activeSlotId === slot.id && playback.status === "playing";
    const isLoading = playback.activeSlotId === slot.id && playback.status === "loading";
    const hasError = playback.errorSlotId === slot.id;
    const button = document.createElement("button");

    button.type = "button";
    button.className = "track-tile";
    button.dataset.slotId = String(slot.id);
    button.disabled = !ready;
    button.classList.toggle("is-empty", !ready);
    button.classList.toggle("is-active", isActive || isLoading);
    button.classList.toggle("is-loading", isLoading);
    button.classList.toggle("is-error", hasError);
    button.setAttribute("aria-label", `${slot.id}번 음악 ${isActive ? "정지" : "재생"}`);
    button.setAttribute("aria-pressed", String(isActive));

    if (ready) {
      const image = document.createElement("img");
      image.className = "track-image";
      image.src = slot.imageUrl;
      image.alt = "";
      image.draggable = false;
      button.append(image);

      const shade = document.createElement("span");
      shade.className = "track-shade";
      shade.setAttribute("aria-hidden", "true");
      button.append(shade);

      if (isActive || isLoading) {
        const mark = document.createElement("span");
        mark.className = "playback-mark";
        mark.setAttribute("aria-hidden", "true");
        button.append(mark);
      }
    }

    fragment.append(button);
  });

  grid.replaceChildren(fragment);
}

function renderSettings() {
  const fragment = document.createDocumentFragment();

  slots.forEach((slot) => {
    const ready = isSlotReady(slot);
    const editor = document.createElement("article");
    editor.className = "slot-editor";
    editor.dataset.slotId = String(slot.id);

    const preview = document.createElement("div");
    preview.className = "slot-preview";
    if (slot.imageUrl) {
      const image = document.createElement("img");
      image.src = slot.imageUrl;
      image.alt = `${slot.id}번 칸 썸네일 미리보기`;
      preview.append(image);
    } else {
      const number = document.createElement("span");
      number.className = "slot-number";
      number.textContent = String(slot.id);
      number.setAttribute("aria-label", `${slot.id}번 빈 칸`);
      preview.append(number);
    }

    const body = document.createElement("div");
    body.className = "slot-editor-body";

    const status = document.createElement("div");
    status.className = "slot-status";
    const title = document.createElement("strong");
    title.textContent = `${slot.id}번 칸`;
    const statusText = document.createElement("span");

    if (ready) {
      statusText.className = "is-ready";
      statusText.textContent = "사용 가능";
    } else if (slot.hasError) {
      statusText.className = "is-error";
      statusText.textContent = "파일 손상";
    } else {
      statusText.textContent = "등록 필요";
    }

    status.append(title, statusText);

    const summary = document.createElement("p");
    summary.className = "file-summary";
    const audioName = slot.audioFileName || slot.audioFile?.name || "음악 없음";
    const imageName = slot.imageFileName || slot.imageFile?.name || "사진 없음";
    summary.textContent = `${audioName} · ${imageName}`;

    const actions = document.createElement("div");
    actions.className = "slot-actions";
    actions.append(
      createFileAction(slot.id, "audio", "음악 선택", "audio/*"),
      createFileAction(slot.id, "image", "사진 선택", "image/*"),
    );

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "delete-button";
    deleteButton.dataset.action = "clear-slot";
    deleteButton.dataset.slotId = String(slot.id);
    deleteButton.textContent = "이 칸 비우기";
    const hasAnyContent = Boolean(slot.audioFile || slot.imageFile || slot.audioFileName || slot.imageFileName);
    deleteButton.disabled = !hasAnyContent;
    actions.append(deleteButton);

    body.append(status, summary, actions);
    editor.append(preview, body);
    fragment.append(editor);
  });

  slotEditors.replaceChildren(fragment);
}

function createFileAction(slotId, kind, text, accept) {
  const label = document.createElement("label");
  label.className = "file-action";

  const input = document.createElement("input");
  input.type = "file";
  input.accept = accept;
  input.dataset.slotId = String(slotId);
  input.dataset.kind = kind;
  input.setAttribute("aria-label", `${slotId}번 칸 ${text}`);

  const labelText = document.createElement("span");
  labelText.textContent = text;
  label.append(input, labelText);
  return label;
}

async function updateStorageInfo() {
  try {
    const { usage, quota, persisted, percent } = await storage.estimate();
    const usageEl = document.querySelector("#storageUsageText");
    const badgeEl = document.querySelector("#storagePersistedBadge");
    const progressBar = document.querySelector("#storageProgressBar");
    const progressFill = document.querySelector("#storageProgressFill");

    if (usageEl) {
      if (quota > 0) {
        usageEl.textContent = `${formatBytes(usage)} / ${formatBytes(quota)} (${percent}%)`;
      } else {
        usageEl.textContent = formatBytes(usage);
      }
    }

    if (badgeEl) {
      badgeEl.textContent = persisted ? "영구 저장 활성" : "브라우저 자동 관리";
      badgeEl.classList.toggle("is-persisted", persisted);
    }

    if (progressBar && progressFill) {
      progressBar.setAttribute("aria-valuenow", String(percent));
      progressFill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    }
  } catch (err) {
    console.warn("저장소 정보 조회 실패:", err);
  }
}

async function playSlot(slotId, { resume = false } = {}) {
  const slot = getSlot(slotId);
  if (!slot || !isSlotReady(slot)) return;

  const requestId = ++playback.requestId;

  if (!resume) {
    audio.pause();
    audio.src = slot.audioUrl;
    audio.currentTime = 0;
    setMediaMetadata(slot);
  }

  playback.activeSlotId = slot.id;
  playback.status = "loading";
  playback.errorSlotId = null;
  renderJukebox();

  try {
    await audio.play();
    if (requestId !== playback.requestId) return;

    playback.status = "playing";
    setMediaPlaybackState("playing");
    renderJukebox();
    announce(`${slot.id}번 음악을 재생합니다.`);
  } catch (error) {
    if (requestId !== playback.requestId || error?.name === "AbortError") return;

    playback.status = "error";
    playback.errorSlotId = slot.id;
    playback.activeSlotId = null;
    setMediaPlaybackState("none");
    renderJukebox();
    showToast("음악을 재생할 수 없습니다. 보호자 설정에서 파일을 확인해 주세요.");

    window.clearTimeout(errorTimer);
    errorTimer = window.setTimeout(() => {
      playback.status = "idle";
      playback.errorSlotId = null;
      renderJukebox();
    }, ERROR_DISPLAY_MS);
  }
}

function stopPlayback({ announceStop = true } = {}) {
  playback.requestId += 1;
  audio.pause();
  try {
    audio.currentTime = 0;
  } catch {
    // Some browsers reject currentTime changes before metadata is available.
  }
  audio.removeAttribute("src");
  audio.load();

  const previousSlotId = playback.activeSlotId;
  playback.status = "idle";
  playback.activeSlotId = null;
  playback.errorSlotId = null;
  setMediaPlaybackState("none");
  renderJukebox();

  if (announceStop && previousSlotId) announce(`${previousSlotId}번 음악을 정지했습니다.`);
}

function pauseFromSystem() {
  if (!playback.activeSlotId || audio.paused) return;
  playback.requestId += 1;
  audio.pause();
  playback.status = "paused";
  setMediaPlaybackState("paused");
  renderJukebox();
}

function handleTileActivation(slotId) {
  const isSameActiveSlot = playback.activeSlotId === slotId;
  const isPlayingOrLoading = playback.status === "playing" || playback.status === "loading";

  if (isSameActiveSlot && isPlayingOrLoading) {
    stopPlayback();
    return;
  }

  playSlot(slotId);
}

async function registerFile(slotId, kind, file) {
  const slot = getSlot(slotId);
  if (!slot || !file) return;

  const expectedType = kind === "audio" ? "audio/" : "image/";
  if (!file.type.startsWith(expectedType)) {
    showToast(kind === "audio" ? "음악 파일을 선택해 주세요." : "사진 파일을 선택해 주세요.");
    return;
  }

  if (playback.activeSlotId === slot.id) stopPlayback({ announceStop: false });

  try {
    const updated = await storage.saveSlotFile(slotId, kind, file);

    if (kind === "audio") {
      if (slot.audioUrl) URL.revokeObjectURL(slot.audioUrl);
      slot.audioFile = updated.audioFile;
      slot.audioFileName = updated.audioFileName;
      slot.audioUrl = updated.audioFile ? URL.createObjectURL(updated.audioFile) : null;
      slot.label = updated.label;
    } else {
      if (slot.imageUrl) URL.revokeObjectURL(slot.imageUrl);
      slot.imageFile = updated.imageFile;
      slot.imageFileName = updated.imageFileName;
      slot.imageUrl = updated.imageFile ? URL.createObjectURL(updated.imageFile) : null;
    }

    slot.hasError = false;
    renderAll();
    updateStorageInfo();
    announce(`${slot.id}번 칸에 ${kind === "audio" ? "음악" : "사진"}을 등록했습니다.`);
  } catch (error) {
    console.error("파일 저장 실패:", error);
    showToast("파일 저장에 실패했습니다. 기기 저장 공간을 확인해 주세요.");
  }
}

async function clearSlot(slotId) {
  const slot = getSlot(slotId);
  const hasAny = Boolean(slot && (slot.audioFile || slot.imageFile || slot.audioFileName || slot.imageFileName));
  if (!slot || !hasAny) return;

  if (!window.confirm(`${slot.id}번 칸의 음악과 사진을 모두 지울까요?`)) return;
  if (playback.activeSlotId === slot.id) stopPlayback({ announceStop: false });

  try {
    await storage.removeSlot(slotId);

    if (slot.audioUrl) URL.revokeObjectURL(slot.audioUrl);
    if (slot.imageUrl) URL.revokeObjectURL(slot.imageUrl);

    Object.assign(slot, {
      audioFile: null,
      audioFileName: "",
      audioUrl: null,
      imageFile: null,
      imageFileName: "",
      imageUrl: null,
      label: "",
      hasError: false,
    });

    renderAll();
    updateStorageInfo();
    announce(`${slot.id}번 칸을 비웠습니다.`);
  } catch (error) {
    console.error("슬롯 삭제 실패:", error);
    showToast("칸 비우기에 실패했습니다.");
  }
}

function setMediaMetadata(slot) {
  if (!("mediaSession" in navigator) || !("MediaMetadata" in window)) return;

  navigator.mediaSession.metadata = new MediaMetadata({
    title: slot.label || `${slot.id}번 음악`,
    artist: "나의 주크박스",
    artwork: slot.imageUrl
      ? [{ src: slot.imageUrl, sizes: "512x512", type: slot.imageFile?.type || "image/jpeg" }]
      : [],
  });
}

function setMediaPlaybackState(state) {
  if (!("mediaSession" in navigator)) return;
  try {
    navigator.mediaSession.playbackState = state;
  } catch {
    // Media Session is a progressive enhancement.
  }
}

function setupMediaSession() {
  if (!("mediaSession" in navigator)) return;

  const actions = {
    play: () => {
      if (playback.activeSlotId) playSlot(playback.activeSlotId, { resume: true });
    },
    pause: pauseFromSystem,
    stop: () => stopPlayback(),
  };

  Object.entries(actions).forEach(([action, handler]) => {
    try {
      navigator.mediaSession.setActionHandler(action, handler);
    } catch {
      // Individual media actions are not available in every browser.
    }
  });
}

function startSettingsHold(event) {
  if (event.type === "pointerdown" && event.button !== 0) return;
  event.preventDefault();
  cancelSettingsHold();
  holdOpened = false;
  settingsTrigger.classList.add("is-arming");

  holdTimer = window.setTimeout(() => {
    holdOpened = true;
    settingsTrigger.classList.remove("is-arming");
    openSettings();
  }, HOLD_DURATION_MS);
}

function cancelSettingsHold() {
  window.clearTimeout(holdTimer);
  holdTimer = null;
  settingsTrigger.classList.remove("is-arming");
}

function openSettings() {
  renderSettings();
  updateStorageInfo();
  if (!settingsDialog.open) settingsDialog.showModal();
  announce("보호자 설정을 열었습니다.");
}

function closeSettings() {
  if (settingsDialog.open) settingsDialog.close();
  settingsTrigger.focus({ preventScroll: true });
}

function showToast(message) {
  window.clearTimeout(toastTimer);
  toast.textContent = message;
  toast.hidden = false;
  toastTimer = window.setTimeout(() => {
    toast.hidden = true;
  }, 3200);
}

function announce(message) {
  liveRegion.textContent = "";
  window.requestAnimationFrame(() => {
    liveRegion.textContent = message;
  });
}

function renderAll() {
  renderJukebox();
  renderSettings();
}

function revokeAllObjectUrls() {
  slots.forEach((slot) => {
    if (slot.audioUrl) URL.revokeObjectURL(slot.audioUrl);
    if (slot.imageUrl) URL.revokeObjectURL(slot.imageUrl);
  });
}

async function loadPersistedSlots() {
  try {
    await storage.init();
    const persistedList = await storage.listSlots();

    persistedList.forEach((persisted) => {
      const slot = getSlot(persisted.id);
      if (!slot) return;

      slot.audioFile = persisted.audioFile;
      slot.audioFileName = persisted.audioFileName || (persisted.audioFile ? persisted.audioFile.name : "");
      slot.audioUrl = persisted.audioFile ? URL.createObjectURL(persisted.audioFile) : null;

      slot.imageFile = persisted.imageFile;
      slot.imageFileName = persisted.imageFileName || (persisted.imageFile ? persisted.imageFile.name : "");
      slot.imageUrl = persisted.imageFile ? URL.createObjectURL(persisted.imageFile) : null;

      slot.label = persisted.label || (slot.audioFileName ? getFileLabel(slot.audioFileName) : "");
      slot.hasError = Boolean(persisted.error);
    });
  } catch (err) {
    console.error("저장소 복원 중 오류 발생:", err);
    showToast("일부 저장된 파일을 불러오지 못했습니다.");
  } finally {
    renderAll();
    updateStorageInfo();
  }
}

grid.addEventListener("click", (event) => {
  const tile = event.target.closest(".track-tile");
  if (!tile || tile.disabled) return;
  handleTileActivation(Number(tile.dataset.slotId));
});

slotEditors.addEventListener("change", (event) => {
  const input = event.target.closest('input[type="file"]');
  if (!input) return;
  const [file] = input.files;
  if (file) registerFile(Number(input.dataset.slotId), input.dataset.kind, file);
  input.value = "";
});

slotEditors.addEventListener("click", (event) => {
  const button = event.target.closest('[data-action="clear-slot"]');
  if (!button) return;
  clearSlot(Number(button.dataset.slotId));
});

settingsTrigger.addEventListener("pointerdown", startSettingsHold);
settingsTrigger.addEventListener("pointerup", cancelSettingsHold);
settingsTrigger.addEventListener("pointercancel", cancelSettingsHold);
settingsTrigger.addEventListener("pointerleave", cancelSettingsHold);
settingsTrigger.addEventListener("click", (event) => {
  event.preventDefault();
  if (!holdOpened) showToast("보호자 설정은 톱니바퀴를 2초 동안 눌러 여세요.");
  holdOpened = false;
});
settingsTrigger.addEventListener("keydown", (event) => {
  if ((event.key === "Enter" || event.key === " ") && !event.repeat) startSettingsHold(event);
});
settingsTrigger.addEventListener("keyup", (event) => {
  if (event.key === "Enter" || event.key === " ") cancelSettingsHold();
});

closeSettingsButton.addEventListener("click", closeSettings);
settingsDialog.addEventListener("click", (event) => {
  if (event.target === settingsDialog) closeSettings();
});

audio.addEventListener("ended", () => stopPlayback({ announceStop: false }));
audio.addEventListener("error", () => {
  if (playback.status !== "loading" && playback.status !== "playing") return;
  const failedSlotId = playback.activeSlotId;
  playback.status = "error";
  playback.activeSlotId = null;
  playback.errorSlotId = failedSlotId;
  setMediaPlaybackState("none");
  renderJukebox();
  showToast("음악 파일을 확인해 주세요.");
});

window.addEventListener("beforeunload", revokeAllObjectUrls);

if ("serviceWorker" in navigator && window.isSecureContext) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {
      // The prototype still works without offline shell caching.
    });
  });
}

setupMediaSession();
loadPersistedSlots();

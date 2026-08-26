import { storage, normalizeScreenId } from "./storage.js";
import { normalizeFileForKind } from "./file-types.js";
import { extractEmbeddedArtwork } from "./album-art.js";
import { applyVolumeLimit } from "./volume.js";
import { createBackupArchive, readBackupArchive } from "./backup.js";
import { ActivationGuard, PointerGestureTracker, TwoFingerSwipeTracker } from "./interaction.js";
import { WakeLockController, WAKE_LOCK_MODES, normalizeWakeLockMode } from "./wake-lock.js";

const SLOT_COUNT = 27;
const HOLD_DURATION_MS = 2000;
const ERROR_DISPLAY_MS = 1800;
const STATS_CHECKPOINT_MS = 30000;
const AUDIO_ACCEPT = "audio/*,.mp3,.m4a,.aac,.wav,.ogg,.oga,.opus,.flac";
const IMAGE_ACCEPT = "image/*,.jpg,.jpeg,.png,.webp,.gif";

const slots = Array.from({ length: SLOT_COUNT }, (_, index) => ({
  id: index + 1,
  audioFile: null,
  audioFileName: "",
  audioUrl: null,
  imageFile: null,
  imageFileName: "",
  imageUrl: null,
  imageSource: null,
  trackId: null,
  label: "",
  hasError: false,
  hasPersistedData: false,
}));

const playback = {
  status: "idle",
  activeSlotId: null,
  requestId: 0,
  errorSlotId: null,
};

// 진행 중인 저장 작업을 추적하여 빠른 연속 등록/재생 경쟁 상태 방지
const savingSlots = new Set();
const activationGuard = new ActivationGuard(700);
const pointerGesture = new PointerGestureTracker(64);
const swipeTracker = new TwoFingerSwipeTracker(80);
const wakeLockController = new WakeLockController();

const grid = document.querySelector("#jukeboxGrid");
const slotEditors = document.querySelector("#slotEditors");
const settingsTrigger = document.querySelector("#settingsTrigger");
const settingsDialog = document.querySelector("#settingsDialog");
const closeSettingsButton = document.querySelector("#closeSettings");
const audio = document.querySelector("#audioPlayer");
const toast = document.querySelector("#toast");
const settingsFeedback = document.querySelector("#settingsFeedback");
const liveRegion = document.querySelector("#liveRegion");
const maxVolumeRange = document.querySelector("#maxVolumeRange");
const maxVolumeValue = document.querySelector("#maxVolumeValue");
const wakeLockRadios = document.querySelectorAll('input[name="wakeLockMode"]');
const screenSelectionRadios = document.querySelectorAll('input[name="currentScreen"]');
const updateAppCacheButton = document.querySelector("#updateAppCache");
const exportBackupButton = document.querySelector("#exportBackup");
const importBackupInput = document.querySelector("#importBackup");
const importBackupLabel = importBackupInput.closest(".backup-import");
const playbackStatsList = document.querySelector("#playbackStatsList");
const clearAllStatsButton = document.querySelector("#clearAllStats");

// Tabs
const tabSettings = document.querySelector("#tabSettings");
const tabStats = document.querySelector("#tabStats");
const panelSettings = document.querySelector("#panelSettings");
const panelStats = document.querySelector("#panelStats");
const statsChartContainer = document.querySelector("#statsChartContainer");
const statsDonutChart = document.querySelector("#statsDonutChart");
const statsDonutLegend = document.querySelector("#statsDonutLegend");

let holdTimer = null;
let holdOpened = false;
let toastTimer = null;
let errorTimer = null;
let maxVolume = 100;
let persistedMaxVolume = 100;
let wakeLockMode = WAKE_LOCK_MODES.PLAYING;
let persistedWakeLockMode = WAKE_LOCK_MODES.PLAYING;
let currentScreen = 1;
let persistedCurrentScreen = 1;
let settingsSaving = false;
let maintenanceBusy = false;
let maintenanceAction = "";
let stabilizationTimer = null;
let listeningSession = null;
let listeningCheckpointTimer = null;
const playbackStats = new Map();

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = (bytes / Math.pow(1024, i)).toFixed(i >= 2 ? 1 : 0);
  return `${value} ${units[i]}`;
}

function formatListeningTime(milliseconds) {
  const totalMinutes = Math.floor(Math.max(0, milliseconds) / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${hours}시간 ${minutes}분`;
  if (minutes > 0) return `${minutes}분`;
  return milliseconds > 0 ? "1분 미만" : "0분";
}

function renderPlaybackStats() {
  const fragment = document.createDocumentFragment();
  const audioSlots = slots.filter((slot) => slot.audioFile && slot.trackId);
  clearAllStatsButton.disabled =
    maintenanceBusy || settingsSaving || savingSlots.size > 0 || playbackStats.size === 0;

  if (audioSlots.length === 0) {
    const empty = document.createElement("p");
    empty.className = "stats-empty";
    empty.textContent = "음악을 등록하면 선택 기록이 여기에 표시됩니다.";
    fragment.append(empty);
    statsChartContainer.hidden = true;
    playbackStatsList.replaceChildren(fragment);
    return;
  }

  // --- 통계 데이터 계산 (차트용) ---
  let totalSelections = 0;
  const chartData = [];
  const palette = ["#FF6B6B", "#4ECDC4", "#45B7D1", "#F9CA24", "#6AB04C", "#A3CB38"];

  for (const slot of audioSlots) {
    const stat = playbackStats.get(slot.trackId) || {
      selectionCount: 0,
      completedCount: 0,
      listenedMs: 0,
      lastPlayedAt: 0,
    };
    
    // 조각 렌더링용 데이터 수집
    if (stat.selectionCount > 0) {
      chartData.push({
        slotId: slot.id,
        label: slot.label || "음악",
        count: stat.selectionCount,
      });
      totalSelections += stat.selectionCount;
    }

    const row = document.createElement("article");
    row.className = "stats-row";

    if (slot.imageUrl) {
      const image = document.createElement("img");
      image.className = "stats-image";
      image.src = slot.imageUrl;
      image.alt = "";
      row.append(image);
    } else {
      const number = document.createElement("span");
      number.className = "stats-slot-number";
      number.textContent = String(slot.id);
      row.append(number);
    }

    const copy = document.createElement("div");
    copy.className = "stats-copy";
    const title = document.createElement("strong");
    title.textContent = `${slot.id}번 · ${slot.label || "음악"}`;
    const values = document.createElement("p");
    values.className = "stats-values";
    const recent = stat.lastPlayedAt ? new Date(stat.lastPlayedAt).toLocaleDateString("ko-KR") : "기록 없음";
    values.textContent = `선택 ${stat.selectionCount}회 · 완료 ${stat.completedCount}회 · ${formatListeningTime(stat.listenedMs)} · 최근 ${recent}`;
    copy.append(title, values);

    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "stats-reset-button";
    reset.dataset.trackId = slot.trackId;
    reset.dataset.slotId = String(slot.id);
    reset.textContent = "초기화";
    reset.disabled = maintenanceBusy || !playbackStats.has(slot.trackId);
    row.append(copy, reset);
    fragment.append(row);
  }
  playbackStatsList.replaceChildren(fragment);

  // --- 도넛 차트 렌더링 ---
  if (totalSelections === 0) {
    statsChartContainer.hidden = true;
    return;
  }
  
  statsChartContainer.hidden = false;
  chartData.sort((a, b) => b.count - a.count);
  
  // 상위 5곡 + 기타
  const topData = chartData.slice(0, 5);
  const othersCount = chartData.slice(5).reduce((sum, item) => sum + item.count, 0);
  if (othersCount > 0) {
    topData.push({ slotId: "etc", label: "기타", count: othersCount });
  }

  let conicString = "";
  let currentPercentage = 0;
  const legendFragment = document.createDocumentFragment();

  topData.forEach((item, index) => {
    const percentage = (item.count / totalSelections) * 100;
    const color = item.slotId === "etc" ? "#95A5A6" : palette[index % palette.length];
    
    // background: conic-gradient(red 0% 30%, blue 30% 100%)
    conicString += `${color} ${currentPercentage}% ${currentPercentage + percentage}%, `;
    currentPercentage += percentage;

    // Legend item
    const li = document.createElement("li");
    const colorBox = document.createElement("div");
    colorBox.className = "donut-legend-color";
    colorBox.style.backgroundColor = color;
    
    const labelSpan = document.createElement("span");
    labelSpan.className = "donut-legend-label";
    labelSpan.textContent = item.slotId === "etc" ? "기타" : `${item.slotId}번 ${item.label}`;
    
    const valueSpan = document.createElement("span");
    valueSpan.className = "donut-legend-value";
    valueSpan.textContent = `${Math.round(percentage)}%`;

    li.append(colorBox, labelSpan, valueSpan);
    legendFragment.append(li);
  });

  statsDonutChart.style.background = `conic-gradient(${conicString.slice(0, -2)})`;
  statsDonutLegend.replaceChildren(legendFragment);
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

function applyMaxVolume(value) {
  maxVolume = applyVolumeLimit(audio, value);
  maxVolumeRange.value = String(maxVolume);
  maxVolumeValue.value = `${maxVolume}%`;
  maxVolumeValue.textContent = `${maxVolume}%`;
}

async function persistMaxVolume() {
  settingsSaving = true;
  renderSettings();
  try {
    const saved = await storage.saveSettings({ maxVolume });
    persistedMaxVolume = saved.maxVolume;
    applyMaxVolume(saved.maxVolume);
    announce(`최대 음량을 ${saved.maxVolume}%로 저장했습니다.`);
  } catch (error) {
    console.error("최대 음량 저장 실패:", error);
    applyMaxVolume(persistedMaxVolume);
    showToast("최대 음량을 저장하지 못했습니다. 다시 시도해 주세요.");
  } finally {
    settingsSaving = false;
    renderSettings();
  }
}

function applyWakeLockMode(value) {
  wakeLockMode = normalizeWakeLockMode(value);
  wakeLockController.setMode(wakeLockMode);
  wakeLockRadios.forEach((radio) => {
    radio.checked = radio.value === wakeLockMode;
  });
}

function applyCurrentScreen(value) {
  currentScreen = normalizeScreenId(value);
  screenSelectionRadios.forEach((radio) => {
    radio.checked = Number(radio.value) === currentScreen;
  });
}

async function persistCurrentScreen(value) {
  const normalized = normalizeScreenId(value);
  settingsSaving = true;
  renderSettings();
  try {
    const saved = await storage.saveSettings({ currentScreen: normalized });
    persistedCurrentScreen = saved.currentScreen;
    applyCurrentScreen(saved.currentScreen);
    announce(`화면 ${saved.currentScreen} 세트로 변경되었습니다.`);
    showToast(`화면 ${saved.currentScreen} 세트로 변경되었습니다.`);
  } catch (error) {
    console.error("화면 세트 설정 저장 실패:", error);
    applyCurrentScreen(persistedCurrentScreen);
    showToast("화면 세트 설정을 저장하지 못했습니다. 다시 시도해 주세요.");
  } finally {
    settingsSaving = false;
    renderAll();
  }
}

async function persistWakeLockMode(value) {
  const normalized = normalizeWakeLockMode(value);
  applyWakeLockMode(normalized);
  settingsSaving = true;
  renderSettings();
  try {
    const saved = await storage.saveSettings({ wakeLockMode: normalized });
    persistedWakeLockMode = saved.wakeLockMode;
    applyWakeLockMode(saved.wakeLockMode);
    announce("화면 켜짐 유지 설정을 저장했습니다.");
  } catch (error) {
    console.error("화면 켜짐 유지 설정 저장 실패:", error);
    applyWakeLockMode(persistedWakeLockMode);
    showToast("화면 켜짐 설정을 저장하지 못했습니다. 다시 시도해 주세요.");
  } finally {
    settingsSaving = false;
    renderSettings();
  }
}

async function updateAppCache() {
  if (maintenanceBusy || settingsSaving || savingSlots.size > 0) return;
  if (!navigator.onLine) {
    showToast("오프라인 상태입니다. 네트워크 연결을 확인해 주세요.");
    return;
  }
  
  maintenanceBusy = true;
  maintenanceAction = "update-cache";
  renderSettings();
  showToast("최신 앱 버전을 확인하고 있습니다...");

  try {
    let updated = false;
    if ("serviceWorker" in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) {
        await reg.update();
        updated = true;
      }
    }
    if ("caches" in window && updated) {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    }
    showToast("최신 버전으로 갱신되었습니다. 새로고침합니다.");
    window.setTimeout(() => {
      window.location.reload();
    }, 800);
  } catch (error) {
    console.error("앱 캐시 갱신 실패:", error);
    showToast("캐시 갱신 중 오류가 발생했습니다. 새로고침합니다.");
    window.setTimeout(() => {
      window.location.reload();
    }, 1000);
  } finally {
    maintenanceBusy = false;
    maintenanceAction = "";
    renderSettings();
  }
}

function renderJukebox() {
  const fragment = document.createDocumentFragment();
  const startIndex = (currentScreen - 1) * 9;
  const currentSlots = slots.slice(startIndex, startIndex + 9);

  currentSlots.forEach((slot) => {
    const ready = isSlotReady(slot);
    const isActive = playback.activeSlotId === slot.id && playback.status === "playing";
    const isLoading = playback.activeSlotId === slot.id && playback.status === "loading";
    const hasError = playback.errorSlotId === slot.id;
    const isSaving = savingSlots.has(slot.id) || maintenanceBusy; // 저장·복원 중 상태 확인

    const button = document.createElement("button");
    button.type = "button";
    button.className = "track-tile";
    button.dataset.slotId = String(slot.id);

    // 저장 중이거나 준비되지 않았으면 버튼 비활성화 (경쟁 상태 방지)
    button.disabled = !ready || isSaving;
    button.classList.toggle("is-empty", !ready);
    button.classList.toggle("is-active", isActive || isLoading);
    button.classList.toggle("is-loading", isLoading || isSaving);
    button.classList.toggle("is-error", hasError);
    button.classList.toggle("is-stabilizing", activationGuard.isStabilizing(slot.id));
    button.setAttribute("aria-label", `${slot.id}번 음악 ${isActive ? "정지" : "재생"}`);
    button.setAttribute("aria-pressed", String(isActive));

    if (ready || isSaving) {
      if (slot.imageUrl) {
        const image = document.createElement("img");
        image.className = "track-image";
        image.src = slot.imageUrl;
        image.alt = "";
        image.draggable = false;
        button.append(image);
      }

      const shade = document.createElement("span");
      shade.className = "track-shade";
      shade.setAttribute("aria-hidden", "true");
      button.append(shade);

      if (isActive || isLoading || isSaving) {
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
  const isAnySlotSaving = savingSlots.size > 0 || settingsSaving || maintenanceBusy;

  closeSettingsButton.disabled = isAnySlotSaving;
  closeSettingsButton.textContent = isAnySlotSaving ? "저장 중…" : "확인";
  maxVolumeRange.value = String(maxVolume);
  maxVolumeRange.disabled = settingsSaving || maintenanceBusy;
  maxVolumeValue.value = `${maxVolume}%`;
  maxVolumeValue.textContent = `${maxVolume}%`;
  wakeLockRadios.forEach((radio) => {
    radio.checked = radio.value === wakeLockMode;
    radio.disabled = settingsSaving || maintenanceBusy;
  });
  screenSelectionRadios.forEach((radio) => {
    radio.checked = Number(radio.value) === currentScreen;
    radio.disabled = settingsSaving || maintenanceBusy;
  });
  if (updateAppCacheButton) {
    updateAppCacheButton.disabled = maintenanceBusy || settingsSaving || savingSlots.size > 0;
    updateAppCacheButton.textContent =
      maintenanceBusy && maintenanceAction === "update-cache" ? "업데이트 적용 중…" : "최신 버전으로 업데이트";
  }
  exportBackupButton.disabled = maintenanceBusy || settingsSaving || savingSlots.size > 0;
  exportBackupButton.textContent = maintenanceBusy && maintenanceAction === "export" ? "백업 만드는 중…" : "전체 백업 저장";
  importBackupInput.disabled = maintenanceBusy || settingsSaving || savingSlots.size > 0;
  importBackupLabel.classList.toggle("is-disabled", importBackupInput.disabled);

  const startIndex = (currentScreen - 1) * 9;
  const currentSlots = slots.slice(startIndex, startIndex + 9);

  currentSlots.forEach((slot) => {
    const ready = isSlotReady(slot);
    const isSaving = savingSlots.has(slot.id) || maintenanceBusy; // 저장·복원 중 상태 확인
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

    if (isSaving) {
      statusText.className = "is-ready";
      statusText.textContent = "저장 중...";
    } else if (ready) {
      statusText.className = "is-ready";
      statusText.textContent = "사용 가능";
    } else if (slot.hasError) {
      statusText.className = "is-error";
      statusText.textContent = "파일 손상";
    } else if (slot.audioFile && !slot.imageFile) {
      statusText.textContent = "사진 필요";
    } else {
      statusText.textContent = "등록 필요";
    }

    status.append(title, statusText);

    const summary = document.createElement("p");
    summary.className = "file-summary";
    const audioName = slot.audioFileName || slot.audioFile?.name || "음악 없음";
    const imageName =
      slot.imageSource === "embedded" ? "내장 앨범아트" : slot.imageFileName || slot.imageFile?.name || "사진 없음";
    summary.textContent = `${audioName} · ${imageName}`;

    const actions = document.createElement("div");
    actions.className = "slot-actions";

    // 저장 중일 때 파일 선택 방지
    actions.append(
      createFileAction(slot.id, "audio", "음악 선택", AUDIO_ACCEPT, isSaving),
      createFileAction(slot.id, "image", "사진 선택", IMAGE_ACCEPT, isSaving),
    );

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "delete-button";
    deleteButton.dataset.action = "clear-slot";
    deleteButton.dataset.slotId = String(slot.id);
    deleteButton.textContent = "이 칸 비우기";
    const hasAnyContent = Boolean(slot.audioFile || slot.imageFile || slot.audioFileName || slot.imageFileName);

    // 저장 중이거나 비어있으면 삭제 버튼 비활성화
    deleteButton.disabled = !hasAnyContent || isSaving;
    actions.append(deleteButton);

    body.append(status, summary, actions);
    editor.append(preview, body);
    fragment.append(editor);
  });

  slotEditors.replaceChildren(fragment);
  renderPlaybackStats();
}

function createFileAction(slotId, kind, text, accept, disabled = false) {
  const label = document.createElement("label");
  label.className = "file-action";
  if (disabled) {
    label.style.opacity = "0.5";
    label.style.pointerEvents = "none";
  }

  const input = document.createElement("input");
  input.type = "file";
  input.accept = accept;
  input.disabled = disabled;
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

function startMaintenance(action) {
  maintenanceBusy = true;
  maintenanceAction = action;
  renderAll();
}

function finishMaintenance() {
  maintenanceBusy = false;
  maintenanceAction = "";
  renderAll();
}

async function exportBackup() {
  if (maintenanceBusy || savingSlots.size > 0 || settingsSaving) return;
  startMaintenance("export");
  try {
    if (listeningSession) await flushListening({ continueSession: true });
    const snapshot = await storage.createBackupSnapshot();
    const archive = await createBackupArchive(snapshot);
    const url = URL.createObjectURL(archive);
    const link = document.createElement("a");
    link.href = url;
    link.download = archive.name;
    link.style.display = "none";
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60000);
    showToast(`백업 파일을 저장했습니다. (${formatBytes(archive.size)})`);
    announce("전체 주크박스 백업 파일을 저장했습니다.");
  } catch (error) {
    console.error("백업 생성 실패:", error);
    showToast(error?.message || "백업 파일을 만들지 못했습니다.");
  } finally {
    finishMaintenance();
  }
}

async function importBackup(file) {
  if (!file || maintenanceBusy || savingSlots.size > 0 || settingsSaving) return;
  startMaintenance("import-backup");
  try {
    const snapshot = await readBackupArchive(file);
    const musicCount = snapshot.slots.filter((slot) => slot.audioFile).length;
    const createdDate = new Date(snapshot.createdAt);
    const dateLabel = Number.isNaN(createdDate.getTime()) ? "날짜 정보 없음" : createdDate.toLocaleString("ko-KR");
    
    const shouldRestore = await showConfirm(
      `백업 날짜: ${dateLabel}\n음악: ${musicCount}개\n파일 크기: ${formatBytes(file.size)}\n\n현재 주크박스를 이 백업으로 교체할까요?`,
    );
    if (!shouldRestore) return;

    if (playback.activeSlotId) stopPlayback({ announceStop: false });
    await storage.restoreBackupSnapshot(snapshot);
    await loadPersistedSlots();
    showToast("백업에서 주크박스를 복원했습니다.");
    announce("전체 주크박스 복원을 완료했습니다.");
  } catch (error) {
    console.error("백업 복원 실패:", error);
    showToast(error?.message || "백업을 복원하지 못했습니다. 기존 내용은 유지됩니다.");
  } finally {
    importBackupInput.value = "";
    finishMaintenance();
  }
}

function acceptStatsUpdate(promise) {
  promise
    .then((record) => {
      if (!record?.trackId) return;
      playbackStats.set(record.trackId, record);
      if (settingsDialog.open) renderPlaybackStats();
    })
    .catch((error) => {
      console.warn("재생 통계를 저장하지 못했습니다. 재생은 계속합니다:", error);
    });
}

function scheduleListeningCheckpoint() {
  window.clearTimeout(listeningCheckpointTimer);
  if (!listeningSession) return;
  listeningCheckpointTimer = window.setTimeout(() => flushListening({ continueSession: true }), STATS_CHECKPOINT_MS);
}

function beginListening(slot, { countSelection }) {
  listeningSession = {
    trackId: slot.trackId,
    slotId: slot.id,
    startedAt: performance.now(),
  };
  if (countSelection && slot.trackId) {
    acceptStatsUpdate(storage.recordPlaybackStart(slot.trackId, slot.id));
  }
  scheduleListeningCheckpoint();
}

function flushListening({ completed = false, continueSession = false } = {}) {
  if (!listeningSession) return Promise.resolve();
  const now = performance.now();
  const session = { ...listeningSession };
  const listenedMs = Math.max(0, Math.round(now - session.startedAt));
  window.clearTimeout(listeningCheckpointTimer);

  if (continueSession) {
    listeningSession.startedAt = now;
    scheduleListeningCheckpoint();
  } else {
    listeningSession = null;
  }

  if (session.trackId && (listenedMs > 0 || completed)) {
    const update = storage.recordListening(session.trackId, session.slotId, listenedMs, { completed });
    acceptStatsUpdate(update);
    return update.catch(() => null);
  }
  return Promise.resolve();
}

async function clearStatsForTrack(trackId, slotId) {
  if (!trackId || maintenanceBusy) return;
  if (!(await showConfirm(`${slotId}번 음악의 재생 기록을 초기화할까요?`))) return;
  try {
    await storage.clearPlaybackStats(trackId);
    if (listeningSession?.trackId === trackId) listeningSession.startedAt = performance.now();
    playbackStats.delete(trackId);
    renderPlaybackStats();
    showToast(`${slotId}번 음악의 재생 기록을 초기화했습니다.`);
  } catch (error) {
    console.error("재생 기록 초기화 실패:", error);
    showToast("재생 기록을 초기화하지 못했습니다.");
  }
}

async function clearAllStats() {
  if (maintenanceBusy || playbackStats.size === 0) return;
  if (!(await showConfirm("모든 음악의 재생 기록을 초기화할까요?"))) return;
  try {
    await storage.clearPlaybackStats();
    if (listeningSession) listeningSession.startedAt = performance.now();
    playbackStats.clear();
    renderPlaybackStats();
    showToast("모든 재생 기록을 초기화했습니다.");
  } catch (error) {
    console.error("전체 재생 기록 초기화 실패:", error);
    showToast("재생 기록을 초기화하지 못했습니다.");
  }
}

async function playSlot(slotId, { resume = false } = {}) {
  const slot = getSlot(slotId);
  if (!slot || !isSlotReady(slot)) return;

  const requestId = ++playback.requestId;
  applyVolumeLimit(audio, maxVolume);

  if (!resume) {
    flushListening();
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
    wakeLockController.setPlaying(true);
    beginListening(slot, { countSelection: !resume });
    setMediaPlaybackState("playing");
    renderJukebox();
    announce(`${slot.id}번 음악을 재생합니다.`);
  } catch (error) {
    if (requestId !== playback.requestId || error?.name === "AbortError") return;

    playback.status = "error";
    wakeLockController.setPlaying(false);
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

function stopPlayback({ announceStop = true, skipStatsFlush = false } = {}) {
  playback.requestId += 1;
  wakeLockController.setPlaying(false);
  if (!skipStatsFlush) flushListening();
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
  wakeLockController.setPlaying(false);
  flushListening();
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

function scheduleStabilizationEnd() {
  window.clearTimeout(stabilizationTimer);
  stabilizationTimer = window.setTimeout(() => renderJukebox(), activationGuard.remaining() + 20);
}

function requestTileActivation(slotId) {
  const accepted = activationGuard.attempt(slotId);
  scheduleStabilizationEnd();
  if (accepted) handleTileActivation(slotId);
  else renderJukebox();
}

async function registerFile(slotId, kind, file) {
  const slot = getSlot(slotId);
  if (!slot || !file) return;

  const normalizedFile = await normalizeFileForKind(file, kind);
  if (!normalizedFile) {
    showToast(
      kind === "audio"
        ? "음악 파일을 인식하지 못했습니다. MP3, M4A, WAV 파일을 선택해 주세요."
        : "사진 파일을 인식하지 못했습니다. JPG, PNG 파일을 선택해 주세요.",
    );
    return;
  }
  file = normalizedFile;
  const embeddedImageFile = kind === "audio" ? await extractEmbeddedArtwork(file) : null;

  // 파일 등록 시작 시 재생 중이면 정지
  if (playback.activeSlotId === slot.id) stopPlayback({ announceStop: false });

  // 슬롯 잠금 (경쟁 상태 방지)
  savingSlots.add(slotId);
  renderAll();

  try {
    let updated;
    try {
      // 영구 저장소 기록 시도
      updated = await storage.saveSlotFile(slotId, kind, file, { embeddedImageFile });
    } catch (storageError) {
      console.warn("영구 저장 실패, 기존 슬롯을 유지합니다:", storageError);
      showToast("파일을 저장하지 못했습니다. 기존 등록은 그대로 유지됩니다.");
      return;
    }

    if (kind === "audio") {
      const previousTrackId = slot.trackId;
      if (slot.audioUrl) URL.revokeObjectURL(slot.audioUrl);
      if (slot.imageUrl) URL.revokeObjectURL(slot.imageUrl);
      slot.audioFile = updated.audioFile;
      slot.audioFileName = updated.audioFileName;
      slot.audioUrl = updated.audioFile ? URL.createObjectURL(updated.audioFile) : null;
      slot.imageFile = updated.imageFile;
      slot.imageFileName = updated.imageFileName || "";
      slot.imageUrl = updated.imageFile ? URL.createObjectURL(updated.imageFile) : null;
      slot.imageSource = updated.imageSource || null;
      slot.trackId = updated.trackId || null;
      slot.label = updated.label;
      if (previousTrackId && previousTrackId !== slot.trackId) playbackStats.delete(previousTrackId);
    } else {
      if (slot.imageUrl) URL.revokeObjectURL(slot.imageUrl);
      slot.imageFile = updated.imageFile;
      slot.imageFileName = updated.imageFileName;
      slot.imageUrl = updated.imageFile ? URL.createObjectURL(updated.imageFile) : null;
      slot.imageSource = updated.imageSource || "manual";
    }

    slot.hasError = false;
    slot.hasPersistedData = true;
    announce(`${slot.id}번 칸에 ${kind === "audio" ? "음악" : "사진"}을 등록했습니다.`);
  } catch (error) {
    console.error("파일 등록 처리 실패:", error);
    showToast("파일 등록에 실패했습니다. 다시 시도해 주세요.");
  } finally {
    // 슬롯 잠금 해제 및 상태 갱신
    savingSlots.delete(slotId);
    renderAll();
    updateStorageInfo();
  }
}

async function clearSlot(slotId) {
  const slot = getSlot(slotId);
  const hasAny = Boolean(slot && (slot.audioFile || slot.imageFile || slot.audioFileName || slot.imageFileName));
  if (!slot || !hasAny) return;

  if (!(await showConfirm(`${slot.id}번 칸의 음악과 사진을 모두 지울까요?`))) return;
  if (playback.activeSlotId === slot.id) stopPlayback({ announceStop: false });

  // 슬롯 잠금 (경쟁 상태 방지)
  savingSlots.add(slotId);
  renderAll();

  try {
    if (slot.hasPersistedData) await storage.removeSlot(slotId);

    if (slot.audioUrl) URL.revokeObjectURL(slot.audioUrl);
    if (slot.imageUrl) URL.revokeObjectURL(slot.imageUrl);
    if (slot.trackId) playbackStats.delete(slot.trackId);

    Object.assign(slot, {
      audioFile: null,
      audioFileName: "",
      audioUrl: null,
      imageFile: null,
      imageFileName: "",
      imageUrl: null,
      imageSource: null,
      trackId: null,
      label: "",
      hasError: false,
      hasPersistedData: false,
    });

    announce(`${slot.id}번 칸을 비웠습니다.`);
  } catch (error) {
    console.error("슬롯 삭제 실패:", error);
    showToast("칸을 비우지 못했습니다. 다시 시도해 주세요.");
    announce(`${slot.id}번 칸을 비우지 못했습니다.`);
  } finally {
    savingSlots.delete(slotId);
    renderAll();
    updateStorageInfo();
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
  if (event.type === "pointerdown") {
    try {
      settingsTrigger.setPointerCapture(event.pointerId);
    } catch {}
  }
  cancelSettingsHold();
  holdOpened = false;
  settingsTrigger.classList.add("is-arming");

  holdTimer = window.setTimeout(() => {
    holdOpened = true;
    settingsTrigger.classList.remove("is-arming");
    openSettings();
  }, HOLD_DURATION_MS);
}

function cancelSettingsHold(event) {
  window.clearTimeout(holdTimer);
  holdTimer = null;
  settingsTrigger.classList.remove("is-arming");
  if (event?.pointerId !== undefined && settingsTrigger.hasPointerCapture?.(event.pointerId)) {
    try {
      settingsTrigger.releasePointerCapture(event.pointerId);
    } catch {}
  }
}

function openSettings() {
  switchTab("tabSettings");
  if (settingsFeedback) settingsFeedback.hidden = true;
  renderSettings();
  updateStorageInfo();
  if (!settingsDialog.open) settingsDialog.showModal();
  announce("보호자 설정을 열었습니다.");
}

function closeSettings() {
  if (savingSlots.size > 0 || settingsSaving || maintenanceBusy) {
    showToast("파일 저장이 끝난 뒤 확인을 눌러 주세요.");
    return;
  }
  if (settingsDialog.open) settingsDialog.close();
  settingsTrigger.focus({ preventScroll: true });
}

function showToast(message) {
  window.clearTimeout(toastTimer);
  toast.textContent = message;
  toast.hidden = false;
  if (settingsDialog.open && settingsFeedback) {
    settingsFeedback.textContent = message;
    settingsFeedback.hidden = false;
  }
  toastTimer = window.setTimeout(() => {
    toast.hidden = true;
    if (settingsFeedback) settingsFeedback.hidden = true;
  }, 3200);
}

function showConfirm(message) {
  return new Promise((resolve) => {
    const dialog = document.getElementById("confirmDialog");
    const messageEl = document.getElementById("confirmMessage");
    const okBtn = document.getElementById("confirmOk");
    const cancelBtn = document.getElementById("confirmCancel");
    if (!dialog || !messageEl || !okBtn || !cancelBtn) {
      resolve(window.confirm(message));
      return;
    }

    messageEl.textContent = message;

    const cleanup = () => {
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      dialog.removeEventListener("cancel", onCancel);
      dialog.close();
    };

    const onOk = () => {
      cleanup();
      resolve(true);
    };

    const onCancel = (e) => {
      e.preventDefault();
      cleanup();
      resolve(false);
    };

    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    dialog.addEventListener("cancel", onCancel);

    dialog.showModal();
  });
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
    const [persistedList, persistedSettings, persistedStats] = await Promise.all([
      storage.listSlots(),
      storage.getSettings(),
      storage.getAllPlaybackStats(),
    ]);
    persistedMaxVolume = persistedSettings.maxVolume;
    applyMaxVolume(persistedSettings.maxVolume);
    persistedWakeLockMode = persistedSettings.wakeLockMode;
    applyWakeLockMode(persistedSettings.wakeLockMode);
    persistedCurrentScreen = persistedSettings.currentScreen;
    applyCurrentScreen(persistedSettings.currentScreen);
    playbackStats.clear();
    persistedStats.forEach((record) => playbackStats.set(record.trackId, record));

    // 복원에 성공한 경우에만 기존 URL을 폐기해 실패 시 현재 세션을 보존한다.
    revokeAllObjectUrls();

    persistedList.forEach((persisted) => {
      const slot = getSlot(persisted.id);
      if (!slot) return;

      slot.audioFile = persisted.audioFile;
      slot.audioFileName = persisted.audioFileName || (persisted.audioFile ? persisted.audioFile.name : "");
      slot.audioUrl = persisted.audioFile ? URL.createObjectURL(persisted.audioFile) : null;

      slot.imageFile = persisted.imageFile;
      slot.imageFileName = persisted.imageFileName || (persisted.imageFile ? persisted.imageFile.name : "");
      slot.imageUrl = persisted.imageFile ? URL.createObjectURL(persisted.imageFile) : null;
      slot.imageSource = persisted.imageSource || null;
      slot.trackId = persisted.trackId || null;

      slot.label = persisted.label || (slot.audioFileName ? getFileLabel(slot.audioFileName) : "");
      slot.hasError = Boolean(persisted.error);
      slot.hasPersistedData = Boolean(persisted.audioPath || persisted.imagePath);
    });
  } catch (err) {
    console.error("저장소 복원 중 오류 발생:", err);
    showToast("일부 저장된 파일을 불러오지 못했습니다.");
  } finally {
    renderAll();
    updateStorageInfo();
  }
}

grid.addEventListener("pointerdown", (event) => {
  const tile = event.target.closest(".track-tile");
  if (!tile || tile.disabled) return;
  const started = pointerGesture.begin({
    pointerId: event.pointerId,
    isPrimary: event.isPrimary,
    button: event.button,
    clientX: event.clientX,
    clientY: event.clientY,
    slotId: tile.dataset.slotId,
  });
  if (!started) return;
  event.preventDefault();
  tile.classList.add("is-pressed");
  try {
    tile.setPointerCapture(event.pointerId);
  } catch {}
});

grid.addEventListener("pointermove", (event) => {
  const activeTile = grid.querySelector(".track-tile.is-pressed");
  if (!activeTile) return;
  if (!pointerGesture.move(event)) activeTile.classList.remove("is-pressed");
});

grid.addEventListener("pointerup", (event) => {
  const activeTile = grid.querySelector(".track-tile.is-pressed");
  if (activeTile) activeTile.classList.remove("is-pressed");
  const slotId = pointerGesture.finish(event);
  if (slotId) requestTileActivation(slotId);
});

grid.addEventListener("pointercancel", (event) => {
  pointerGesture.cancel(event.pointerId);
  grid.querySelector(".track-tile.is-pressed")?.classList.remove("is-pressed");
});

grid.addEventListener("lostpointercapture", (event) => {
  pointerGesture.cancel(event.pointerId);
  grid.querySelector(".track-tile.is-pressed")?.classList.remove("is-pressed");
});

grid.addEventListener("contextmenu", (event) => {
  if (event.target.closest(".track-tile")) event.preventDefault();
});

grid.addEventListener("click", (event) => {
  // Pointer 입력은 위 상태 기계에서 처리하고, detail=0인 키보드·보조공학 click만 이 경로로 받는다.
  if (event.detail !== 0) {
    event.preventDefault();
    return;
  }
  const tile = event.target.closest(".track-tile");
  if (!tile || tile.disabled) return;
  requestTileActivation(Number(tile.dataset.slotId));
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

maxVolumeRange.addEventListener("input", () => applyMaxVolume(maxVolumeRange.value));
maxVolumeRange.addEventListener("change", persistMaxVolume);
wakeLockRadios.forEach((radio) => {
  radio.addEventListener("change", () => {
    if (radio.checked) persistWakeLockMode(radio.value);
  });
});
screenSelectionRadios.forEach((radio) => {
  radio.addEventListener("change", () => {
    if (radio.checked) persistCurrentScreen(Number(radio.value));
  });
});
if (updateAppCacheButton) {
  updateAppCacheButton.addEventListener("click", updateAppCache);
}
exportBackupButton.addEventListener("click", exportBackup);
importBackupInput.addEventListener("change", () => {
  const [file] = importBackupInput.files;
  if (file) importBackup(file);
});
playbackStatsList.addEventListener("click", (event) => {
  const button = event.target.closest(".stats-reset-button");
  if (button) clearStatsForTrack(button.dataset.trackId, Number(button.dataset.slotId));
});
clearAllStatsButton.addEventListener("click", clearAllStats);

// --- Tab Switching Logic ---
function switchTab(tabId) {
  const isSettings = tabId === "tabSettings";
  
  tabSettings.setAttribute("aria-selected", isSettings);
  tabStats.setAttribute("aria-selected", !isSettings);
  
  panelSettings.hidden = !isSettings;
  panelStats.hidden = isSettings;

  if (!isSettings) {
    renderPlaybackStats();
  }
}

tabSettings.addEventListener("click", () => switchTab("tabSettings"));
tabStats.addEventListener("click", () => switchTab("tabStats"));

settingsTrigger.addEventListener("pointerdown", startSettingsHold);
settingsTrigger.addEventListener("pointerup", cancelSettingsHold);
settingsTrigger.addEventListener("pointercancel", cancelSettingsHold);
settingsTrigger.addEventListener("contextmenu", (event) => event.preventDefault());
settingsTrigger.addEventListener("dragstart", (event) => event.preventDefault());
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

audio.addEventListener("ended", () => {
  flushListening({ completed: true });
  stopPlayback({ announceStop: false, skipStatsFlush: true });
});
audio.addEventListener("error", () => {
  if (playback.status !== "loading" && playback.status !== "playing") return;
  flushListening();
  const failedSlotId = playback.activeSlotId;
  playback.status = "error";
  wakeLockController.setPlaying(false);
  playback.activeSlotId = null;
  playback.errorSlotId = failedSlotId;
  setMediaPlaybackState("none");
  renderJukebox();
  showToast("음악 파일을 확인해 주세요.");
});

window.addEventListener("pagehide", () => flushListening());
window.addEventListener("beforeunload", () => {
  flushListening();
  revokeAllObjectUrls();
});

function handleSwipe(direction) {
  let newScreen = currentScreen;
  if (direction === "right") {
    newScreen = currentScreen - 1;
    if (newScreen < 1) newScreen = 3;
  } else if (direction === "left") {
    newScreen = currentScreen + 1;
    if (newScreen > 3) newScreen = 1;
  }
  if (newScreen !== currentScreen) {
    persistCurrentScreen(newScreen);
  }
}

document.body.addEventListener("touchstart", (event) => {
  swipeTracker.handleTouchStart(event.touches);
}, { passive: false });

document.body.addEventListener("touchmove", (event) => {
  if (event.touches.length > 1) {
    event.preventDefault(); // 다중 터치 시 브라우저 동작 전면 차단
  }
  const direction = swipeTracker.handleTouchMove(event.touches);
  if (direction) {
    handleSwipe(direction);
  }
}, { passive: false });

document.body.addEventListener("touchend", (event) => {
  swipeTracker.handleTouchEnd(event.touches);
});

document.body.addEventListener("touchcancel", (event) => {
  swipeTracker.handleTouchEnd(event.touches);
});

if ("serviceWorker" in navigator && window.isSecureContext) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {
      // The prototype still works without offline shell caching.
    });
  });
}

setupMediaSession();
loadPersistedSlots();

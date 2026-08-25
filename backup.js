const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_END_SIGNATURE = 0x06054b50;
const UTF8_FLAG = 0x0800;
const MAX_ENTRY_COUNT = 128;
const MAX_ARCHIVE_SIZE = 0xffffffff;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

async function analyzeBlob(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return {
    crc: crc32(bytes),
    sha256: Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join(""),
  };
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  return {
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
  };
}

function extensionFor(file, fallback) {
  const match = String(file?.name || "").toLowerCase().match(/\.([a-z0-9]{1,8})$/);
  return match ? match[1] : fallback;
}

function safeOriginalName(name, fallback) {
  const normalized = String(name || "").replace(/[\u0000-\u001f]/g, "").slice(0, 240);
  return normalized || fallback;
}

function createLocalHeader(entry, timestamp) {
  const nameBytes = textEncoder.encode(entry.path);
  const buffer = new ArrayBuffer(30 + nameBytes.length);
  const view = new DataView(buffer);
  view.setUint32(0, ZIP_LOCAL_SIGNATURE, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, UTF8_FLAG, true);
  view.setUint16(8, 0, true);
  view.setUint16(10, timestamp.time, true);
  view.setUint16(12, timestamp.date, true);
  view.setUint32(14, entry.crc, true);
  view.setUint32(18, entry.blob.size, true);
  view.setUint32(22, entry.blob.size, true);
  view.setUint16(26, nameBytes.length, true);
  view.setUint16(28, 0, true);
  new Uint8Array(buffer, 30).set(nameBytes);
  return new Uint8Array(buffer);
}

function createCentralHeader(entry, timestamp) {
  const nameBytes = textEncoder.encode(entry.path);
  const buffer = new ArrayBuffer(46 + nameBytes.length);
  const view = new DataView(buffer);
  view.setUint32(0, ZIP_CENTRAL_SIGNATURE, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 20, true);
  view.setUint16(8, UTF8_FLAG, true);
  view.setUint16(10, 0, true);
  view.setUint16(12, timestamp.time, true);
  view.setUint16(14, timestamp.date, true);
  view.setUint32(16, entry.crc, true);
  view.setUint32(20, entry.blob.size, true);
  view.setUint32(24, entry.blob.size, true);
  view.setUint16(28, nameBytes.length, true);
  view.setUint16(30, 0, true);
  view.setUint16(32, 0, true);
  view.setUint16(34, 0, true);
  view.setUint16(36, 0, true);
  view.setUint32(38, 0, true);
  view.setUint32(42, entry.offset, true);
  new Uint8Array(buffer, 46).set(nameBytes);
  return new Uint8Array(buffer);
}

function createEndRecord(entryCount, centralSize, centralOffset) {
  const buffer = new ArrayBuffer(22);
  const view = new DataView(buffer);
  view.setUint32(0, ZIP_END_SIGNATURE, true);
  view.setUint16(4, 0, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, entryCount, true);
  view.setUint16(10, entryCount, true);
  view.setUint32(12, centralSize, true);
  view.setUint32(16, centralOffset, true);
  view.setUint16(20, 0, true);
  return new Uint8Array(buffer);
}

function validateArchivePath(path) {
  if (
    !path ||
    path.length > 240 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => !part || part === "." || part === "..") ||
    /[\u0000-\u001f]/.test(path)
  ) {
    throw new Error("백업 파일에 안전하지 않은 경로가 있습니다.");
  }
}

function validateManifest(manifest, entries) {
  if (!manifest || manifest.format !== "jukebox-backup" || manifest.formatVersion !== 1) {
    throw new Error("지원하지 않는 주크박스 백업 형식입니다.");
  }
  if (!Array.isArray(manifest.slots) || manifest.slots.length > 27) {
    throw new Error("백업의 슬롯 정보가 올바르지 않습니다.");
  }

  const slotIds = new Set();
  const trackIds = new Map();
  for (const slot of manifest.slots) {
    if (!Number.isInteger(slot.id) || slot.id < 1 || slot.id > 27 || slotIds.has(slot.id)) {
      throw new Error("백업에 중복되거나 잘못된 슬롯이 있습니다.");
    }
    slotIds.add(slot.id);
    if (slot.trackId != null) {
      if (typeof slot.trackId !== "string" || !/^[a-zA-Z0-9-]{1,120}$/.test(slot.trackId) || trackIds.has(slot.trackId)) {
        throw new Error("백업의 음원 ID가 올바르지 않습니다.");
      }
      trackIds.set(slot.trackId, slot.id);
    }
    for (const media of [slot.audio, slot.image]) {
      if (!media) continue;
      if (!entries.has(media.entry) || !Number.isSafeInteger(media.size) || media.size < 0) {
        throw new Error("백업에서 필요한 미디어 파일을 찾지 못했습니다.");
      }
      if (!/^[a-f0-9]{64}$/.test(media.sha256 || "")) throw new Error("백업 체크섬이 올바르지 않습니다.");
    }
  }

  if (!Array.isArray(manifest.stats) || manifest.stats.length > 27) {
    throw new Error("백업의 재생 통계가 올바르지 않습니다.");
  }
  for (const stat of manifest.stats) {
    const validCounters = [stat?.selectionCount, stat?.completedCount, stat?.listenedMs].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    );
    if (
      !validCounters ||
      trackIds.get(stat?.trackId) !== Number(stat?.slotId) ||
      !(Number.isFinite(Number(stat?.lastPlayedAt)) && Number(stat.lastPlayedAt) >= 0)
    ) {
      throw new Error("백업의 재생 통계 연결이 올바르지 않습니다.");
    }
  }
}

export async function createBackupArchive({ slots, settings, stats = [] }) {
  const createdAt = new Date();
  const entries = [];
  const manifestSlots = [];

  for (const slot of slots) {
    if (!slot.audioFile && !slot.imageFile) continue;
    const manifestSlot = {
      id: slot.id,
      label: slot.label || "",
      imageSource: slot.imageSource || null,
      trackId: slot.trackId || null,
      audio: null,
      image: null,
    };

    if (slot.audioFile) {
      const path = `media/slot-${slot.id}-audio.${extensionFor(slot.audioFile, "bin")}`;
      const analysis = await analyzeBlob(slot.audioFile);
      entries.push({ path, blob: slot.audioFile, crc: analysis.crc });
      manifestSlot.audio = {
        entry: path,
        name: safeOriginalName(slot.audioFileName || slot.audioFile.name, `slot-${slot.id}-audio`),
        type: slot.audioFile.type || "application/octet-stream",
        size: slot.audioFile.size,
        sha256: analysis.sha256,
      };
    }

    if (slot.imageFile) {
      const path = `media/slot-${slot.id}-image.${extensionFor(slot.imageFile, "bin")}`;
      const analysis = await analyzeBlob(slot.imageFile);
      entries.push({ path, blob: slot.imageFile, crc: analysis.crc });
      manifestSlot.image = {
        entry: path,
        name: safeOriginalName(slot.imageFileName || slot.imageFile.name, `slot-${slot.id}-image`),
        type: slot.imageFile.type || "application/octet-stream",
        size: slot.imageFile.size,
        sha256: analysis.sha256,
      };
    }
    manifestSlots.push(manifestSlot);
  }

  const trackSlots = new Map(
    manifestSlots.filter((slot) => slot.trackId).map((slot) => [slot.trackId, slot.id]),
  );
  const backupStats = Array.isArray(stats)
    ? stats.filter((stat) => trackSlots.get(stat?.trackId) === Number(stat?.slotId))
    : [];
  const manifest = {
    format: "jukebox-backup",
    formatVersion: 1,
    createdAt: createdAt.toISOString(),
    appSettings: {
      maxVolume: settings?.maxVolume ?? 100,
      wakeLockMode: settings?.wakeLockMode ?? "playing",
      currentScreen: settings?.currentScreen ?? 1,
    },
    slots: manifestSlots,
    stats: backupStats,
  };
  const manifestBlob = new Blob([JSON.stringify(manifest)], { type: "application/json" });
  const manifestBytes = new Uint8Array(await manifestBlob.arrayBuffer());
  entries.unshift({ path: "manifest.json", blob: manifestBlob, crc: crc32(manifestBytes) });

  if (entries.length > MAX_ENTRY_COUNT) throw new Error("백업 파일 수가 허용 범위를 넘었습니다.");

  const timestamp = dosDateTime(createdAt);
  const parts = [];
  let offset = 0;
  for (const entry of entries) {
    if (entry.blob.size > MAX_ARCHIVE_SIZE) throw new Error("4GB보다 큰 파일은 백업할 수 없습니다.");
    entry.offset = offset;
    const header = createLocalHeader(entry, timestamp);
    parts.push(header, entry.blob);
    offset += header.byteLength + entry.blob.size;
    if (offset > MAX_ARCHIVE_SIZE) throw new Error("전체 백업 크기가 4GB를 넘었습니다.");
  }

  const centralOffset = offset;
  for (const entry of entries) {
    const header = createCentralHeader(entry, timestamp);
    parts.push(header);
    offset += header.byteLength;
  }
  const centralSize = offset - centralOffset;
  parts.push(createEndRecord(entries.length, centralSize, centralOffset));

  const date = createdAt.toISOString().slice(0, 10).replaceAll("-", "");
  return new File(parts, `jukebox-backup-${date}.zip`, { type: "application/zip", lastModified: createdAt.getTime() });
}

async function readZipEntries(file) {
  if (!file || file.size < 22 || file.size > MAX_ARCHIVE_SIZE) throw new Error("백업 파일 크기가 올바르지 않습니다.");
  const tailSize = Math.min(file.size, 65557);
  const tail = new Uint8Array(await file.slice(file.size - tailSize).arrayBuffer());
  const tailView = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let endOffset = -1;
  for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
    if (tailView.getUint32(offset, true) === ZIP_END_SIGNATURE) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) throw new Error("올바른 ZIP 백업 파일이 아닙니다.");

  const entryCount = tailView.getUint16(endOffset + 10, true);
  const centralSize = tailView.getUint32(endOffset + 12, true);
  const centralOffset = tailView.getUint32(endOffset + 16, true);
  if (entryCount < 1 || entryCount > MAX_ENTRY_COUNT || centralOffset + centralSize > file.size) {
    throw new Error("ZIP 백업의 파일 목록이 손상되었습니다.");
  }

  const central = new Uint8Array(await file.slice(centralOffset, centralOffset + centralSize).arrayBuffer());
  const centralView = new DataView(central.buffer, central.byteOffset, central.byteLength);
  const entries = new Map();
  let offset = 0;

  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > central.length || centralView.getUint32(offset, true) !== ZIP_CENTRAL_SIGNATURE) {
      throw new Error("ZIP 백업의 중앙 디렉터리가 손상되었습니다.");
    }
    const flags = centralView.getUint16(offset + 8, true);
    const method = centralView.getUint16(offset + 10, true);
    const expectedCrc = centralView.getUint32(offset + 16, true);
    const compressedSize = centralView.getUint32(offset + 20, true);
    const uncompressedSize = centralView.getUint32(offset + 24, true);
    const nameLength = centralView.getUint16(offset + 28, true);
    const extraLength = centralView.getUint16(offset + 30, true);
    const commentLength = centralView.getUint16(offset + 32, true);
    const localOffset = centralView.getUint32(offset + 42, true);
    if ((flags & 1) !== 0 || method !== 0 || compressedSize !== uncompressedSize) {
      throw new Error("압축되거나 암호화된 파일은 이 백업에서 지원하지 않습니다.");
    }
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > central.length) throw new Error("ZIP 파일명이 손상되었습니다.");
    const path = textDecoder.decode(central.slice(nameStart, nameEnd));
    validateArchivePath(path);
    if (entries.has(path)) throw new Error("ZIP 백업에 중복 파일이 있습니다.");

    const localHeader = new Uint8Array(await file.slice(localOffset, localOffset + 30).arrayBuffer());
    if (localHeader.length !== 30 || new DataView(localHeader.buffer).getUint32(0, true) !== ZIP_LOCAL_SIGNATURE) {
      throw new Error("ZIP 백업의 파일 헤더가 손상되었습니다.");
    }
    const localView = new DataView(localHeader.buffer);
    const localNameLength = localView.getUint16(26, true);
    const localExtraLength = localView.getUint16(28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (dataStart + uncompressedSize > centralOffset) throw new Error("ZIP 파일 범위가 올바르지 않습니다.");
    const blob = file.slice(dataStart, dataStart + uncompressedSize);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (crc32(bytes) !== expectedCrc) throw new Error("백업 파일의 CRC 검사가 실패했습니다.");
    entries.set(path, { blob, size: uncompressedSize });
    offset = nameEnd + extraLength + commentLength;
  }
  return entries;
}

export async function readBackupArchive(file) {
  const entries = await readZipEntries(file);
  const manifestEntry = entries.get("manifest.json");
  if (!manifestEntry || manifestEntry.size > 1024 * 1024) throw new Error("백업 매니페스트가 없거나 너무 큽니다.");

  let manifest;
  try {
    manifest = JSON.parse(await manifestEntry.blob.text());
  } catch {
    throw new Error("백업 매니페스트를 읽지 못했습니다.");
  }
  validateManifest(manifest, entries);

  const slots = [];
  for (const slot of manifest.slots) {
    const restored = {
      id: slot.id,
      label: String(slot.label || "").slice(0, 240),
      imageSource: slot.imageSource === "manual" || slot.imageSource === "embedded" ? slot.imageSource : null,
      trackId: typeof slot.trackId === "string" ? slot.trackId : null,
      audioFile: null,
      imageFile: null,
    };
    for (const [kind, media] of [["audio", slot.audio], ["image", slot.image]]) {
      if (!media) continue;
      const entry = entries.get(media.entry);
      if (entry.size !== media.size) throw new Error("백업 미디어 크기가 일치하지 않습니다.");
      const declaredType = String(media.type || "").toLowerCase();
      if (!declaredType.startsWith(`${kind}/`)) throw new Error("백업 미디어 형식이 올바르지 않습니다.");
      const analysis = await analyzeBlob(entry.blob);
      if (analysis.sha256 !== media.sha256) throw new Error("백업 미디어의 SHA-256 검사가 실패했습니다.");
      const restoredFile = new File([entry.blob], safeOriginalName(media.name, `${kind}-${slot.id}`), {
        type: declaredType.slice(0, 120),
        lastModified: Date.now(),
      });
      restored[`${kind}File`] = restoredFile;
    }
    if (!restored.imageFile) restored.imageSource = null;
    slots.push(restored);
  }

  return {
    createdAt: manifest.createdAt,
    slots,
    settings: {
      maxVolume: manifest.appSettings?.maxVolume ?? 100,
      wakeLockMode: manifest.appSettings?.wakeLockMode ?? "playing",
      currentScreen: manifest.appSettings?.currentScreen ?? 1,
    },
    stats: manifest.stats.map((stat) => ({
      trackId: stat.trackId,
      slotId: Number(stat.slotId),
      selectionCount: Number(stat.selectionCount),
      completedCount: Number(stat.completedCount),
      listenedMs: Number(stat.listenedMs),
      lastPlayedAt: Number(stat.lastPlayedAt),
    })),
  };
}

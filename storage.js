import { normalizeMaxVolume } from "./volume.js";

/**
 * JukeboxStorage - IndexedDB(메타데이터) + OPFS(바이너리) 영구 저장 계층
 */

const DB_NAME = "jukebox_db";
const DB_VERSION = 2;
const STORE_NAME = "slots";
const SETTINGS_STORE_NAME = "settings";
const MEDIA_DIR_NAME = "media";
const TOTAL_SLOTS = 9;

export class JukeboxStorage {
  constructor({
    dbName = DB_NAME,
    dbVersion = DB_VERSION,
    storeName = STORE_NAME,
    settingsStoreName = SETTINGS_STORE_NAME,
    mediaDirName = MEDIA_DIR_NAME,
    totalSlots = TOTAL_SLOTS,
    requestPersistence = true,
  } = {}) {
    this.dbName = dbName;
    this.dbVersion = dbVersion;
    this.storeName = storeName;
    this.settingsStoreName = settingsStoreName;
    this.mediaDirName = mediaDirName;
    this.totalSlots = totalSlots;
    this.shouldRequestPersistence = requestPersistence;
    this.db = null;
    this.mediaDir = null;
    this.initialized = false;
    this.initPromise = null;
    this.slotQueues = new Map(); // 슬롯별 직렬화 큐 (동시성 안전)
  }

  /**
   * 슬롯별 작업 직렬화 실행 (Mutex)
   */
  async _enqueueSlotOperation(slotId, operation) {
    const prevPromise = this.slotQueues.get(slotId) || Promise.resolve();
    let resolveCurrent;
    const currentPromise = new Promise((resolve) => {
      resolveCurrent = resolve;
    });

    const queuedPromise = prevPromise
      .catch(() => {})
      .then(() => currentPromise);

    this.slotQueues.set(slotId, queuedPromise);

    try {
      await prevPromise.catch(() => {});
      return await operation();
    } finally {
      resolveCurrent();
      if (this.slotQueues.get(slotId) === queuedPromise) {
        this.slotQueues.delete(slotId);
      }
    }
  }

  /**
   * IndexedDB 연결 열기
   */
  async _openDatabase() {
    if (this.db) return this.db;

    return new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(new Error("IndexedDB를 지원하지 않는 브라우저입니다."));
        return;
      }

      const request = window.indexedDB.open(this.dbName, this.dbVersion);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(this.settingsStoreName)) {
          db.createObjectStore(this.settingsStoreName, { keyPath: "key" });
        }
      };

      request.onsuccess = () => {
        this.db = request.result;
        this.db.onversionchange = () => {
          this.db.close();
          this.db = null;
        };
        resolve(this.db);
      };

      request.onerror = () => {
        reject(request.error || new Error("IndexedDB 연결 실패"));
      };
    });
  }

  /**
   * OPFS 미디어 디렉터리 핸들 가져오기
   */
  async _getMediaDir() {
    if (this.mediaDir) return this.mediaDir;

    if (!navigator.storage || !navigator.storage.getDirectory) {
      throw new Error("OPFS(Origin Private File System)를 지원하지 않는 환경입니다.");
    }

    const rootDir = await navigator.storage.getDirectory();
    this.mediaDir = await rootDir.getDirectoryHandle(this.mediaDirName, { create: true });
    return this.mediaDir;
  }

  /**
   * 고유 안전 파일명 생성 (슬롯 ID + UUID)
   */
  _generateSafeFileName(slotId, kind, originalFileName, mimeType) {
    const uuid =
      typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

    let ext = "";
    if (originalFileName && originalFileName.includes(".")) {
      ext = originalFileName.split(".").pop().replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
    }
    if (!ext) {
      if (mimeType && (mimeType.includes("mpeg") || mimeType.includes("mp3"))) ext = "mp3";
      else if (mimeType && mimeType.includes("wav")) ext = "wav";
      else if (mimeType && mimeType.includes("ogg")) ext = "ogg";
      else if (mimeType && (mimeType.includes("m4a") || mimeType.includes("mp4"))) ext = "m4a";
      else if (mimeType && (mimeType.includes("jpeg") || mimeType.includes("jpg"))) ext = "jpg";
      else if (mimeType && mimeType.includes("png")) ext = "png";
      else if (mimeType && mimeType.includes("webp")) ext = "webp";
      else ext = "bin";
    }

    return `slot_${slotId}_${kind}_${uuid}.${ext}`;
  }

  /**
   * OPFS에 파일 기록 (Safe Write)
   */
  async _writeFileToOpfs(fileName, file) {
    const dir = await this._getMediaDir();
    const fileHandle = await dir.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    try {
      await writable.write(file);
      await writable.close();
    } catch (err) {
      try {
        await writable.abort();
      } catch {}
      try {
        await dir.removeEntry(fileName);
      } catch {}
      throw err;
    }
  }

  /**
   * OPFS에서 파일 읽기
   */
  async _readFileFromOpfs(fileName, originalName, mimeType, updatedAt) {
    if (!fileName) return null;
    const dir = await this._getMediaDir();
    const fileHandle = await dir.getFileHandle(fileName);
    const blob = await fileHandle.getFile();
    return new File([blob], originalName || fileName, {
      type: mimeType || blob.type,
      lastModified: updatedAt || Date.now(),
    });
  }

  /**
   * OPFS에서 파일 삭제 (존재하지 않아도 에러 무시)
   */
  async _deleteFileFromOpfs(fileName) {
    if (!fileName) return;
    try {
      const dir = await this._getMediaDir();
      await dir.removeEntry(fileName);
    } catch (err) {
      if (err.name !== "NotFoundError") {
        console.warn(`OPFS 파일 삭제 중 경고 (${fileName}):`, err);
      }
    }
  }

  /**
   * IndexedDB 단일 메타데이터 조회
   */
  async _getMetaFromDb(slotId) {
    const db = await this._openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readonly");
      const store = tx.objectStore(this.storeName);
      const request = store.get(Number(slotId));
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * IndexedDB 전체 메타데이터 조회
   */
  async _getAllMetaFromDb() {
    const db = await this._openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readonly");
      const store = tx.objectStore(this.storeName);
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * IndexedDB 메타데이터 저장/갱신
   */
  async _putMetaToDb(meta) {
    const db = await this._openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readwrite");
      const store = tx.objectStore(this.storeName);
      const request = store.put(meta);
      let requestResult;
      const rejectTransaction = () => {
        reject(tx.error || request.error || new Error("IndexedDB 메타데이터 저장 실패"));
      };

      request.onsuccess = () => {
        requestResult = request.result;
      };
      request.onerror = rejectTransaction;
      tx.onerror = rejectTransaction;
      tx.onabort = rejectTransaction;
      tx.oncomplete = () => resolve(requestResult);
    });
  }

  async _getSettingsFromDb() {
    const db = await this._openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.settingsStoreName, "readonly");
      const request = tx.objectStore(this.settingsStoreName).get("app-settings");
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error("설정 조회 실패"));
    });
  }

  async _putSettingsToDb(settings) {
    const db = await this._openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.settingsStoreName, "readwrite");
      const request = tx.objectStore(this.settingsStoreName).put(settings);
      const rejectTransaction = () => reject(tx.error || request.error || new Error("설정 저장 실패"));
      request.onerror = rejectTransaction;
      tx.onerror = rejectTransaction;
      tx.onabort = rejectTransaction;
      tx.oncomplete = () => resolve();
    });
  }

  /**
   * IndexedDB 메타데이터 삭제
   */
  async _deleteMetaFromDb(slotId) {
    const db = await this._openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readwrite");
      const store = tx.objectStore(this.storeName);
      const request = store.delete(Number(slotId));
      const rejectTransaction = () => {
        reject(tx.error || request.error || new Error("IndexedDB 메타데이터 삭제 실패"));
      };

      request.onerror = rejectTransaction;
      tx.onerror = rejectTransaction;
      tx.onabort = rejectTransaction;
      tx.oncomplete = () => resolve();
    });
  }

  /**
   * 고아 OPFS 파일 정리 (Garbage Collection)
   */
  async _cleanOrphanedFiles() {
    try {
      const allMeta = await this._getAllMetaFromDb();
      const validFiles = new Set();

      for (const meta of allMeta) {
        if (meta.audioPath) validFiles.add(meta.audioPath);
        if (meta.imagePath) validFiles.add(meta.imagePath);
      }

      const dir = await this._getMediaDir();
      const fileNames = [];
      if (typeof dir.keys === "function") {
        for await (const name of dir.keys()) {
          fileNames.push(name);
        }
      } else if (typeof dir.entries === "function") {
        for await (const [name] of dir.entries()) {
          fileNames.push(name);
        }
      }

      for (const fileName of fileNames) {
        if (!validFiles.has(fileName)) {
          await this._deleteFileFromOpfs(fileName);
        }
      }
    } catch (err) {
      console.warn("고아 파일 정리 중 경고:", err);
    }
  }

  /**
   * 초기화 (DB 및 OPFS 연결, 영구 저장 요청, 고아 파일 정리)
   */
  async init() {
    if (this.initialized) return;
    if (!this.initPromise) {
      this.initPromise = (async () => {
        await this._openDatabase();
        await this._getMediaDir();

        if (this.shouldRequestPersistence && navigator.storage && navigator.storage.persist) {
          try {
            await navigator.storage.persist();
          } catch {}
        }

        await this._cleanOrphanedFiles();
        this.initialized = true;
      })().catch((error) => {
        this.initialized = false;
        this.initPromise = null;
        throw error;
      });
    }

    await this.initPromise;
  }

  /**
   * 1~9번 전체 슬롯 목록 복원
   * 손상된 슬롯이 있어도 다른 슬롯 복원을 방해하지 않음
   */
  async listSlots() {
    await this.init();
    const metas = await this._getAllMetaFromDb();
    const metaMap = new Map(metas.map((m) => [m.id, m]));

    const result = [];
    for (let slotId = 1; slotId <= this.totalSlots; slotId++) {
      const meta = metaMap.get(slotId);
      if (!meta) {
        result.push({
          id: slotId,
          audioFile: null,
          audioFileName: null,
          audioMime: null,
          audioPath: null,
          imageFile: null,
          imageFileName: null,
          imageMime: null,
          imagePath: null,
          imageSource: null,
          label: "",
          updatedAt: 0,
        });
        continue;
      }

      let audioFile = null;
      let imageFile = null;
      const errors = {};

      if (meta.audioPath) {
        try {
          audioFile = await this._readFileFromOpfs(
            meta.audioPath,
            meta.audioFileName,
            meta.audioMime,
            meta.updatedAt
          );
        } catch (err) {
          console.warn(`슬롯 ${slotId} 음원 파일 로드 실패:`, err);
          errors.audio = true;
        }
      }

      if (meta.imagePath) {
        try {
          imageFile = await this._readFileFromOpfs(
            meta.imagePath,
            meta.imageFileName,
            meta.imageMime,
            meta.updatedAt
          );
        } catch (err) {
          console.warn(`슬롯 ${slotId} 사진 파일 로드 실패:`, err);
          errors.image = true;
        }
      }

      result.push({
        id: slotId,
        audioFile,
        audioFileName: meta.audioFileName || (audioFile ? audioFile.name : null),
        audioMime: meta.audioMime || (audioFile ? audioFile.type : null),
        audioPath: meta.audioPath || null,
        imageFile,
        imageFileName: meta.imageFileName || (imageFile ? imageFile.name : null),
        imageMime: meta.imageMime || (imageFile ? imageFile.type : null),
        imagePath: meta.imagePath || null,
        imageSource: meta.imagePath ? meta.imageSource || "manual" : null,
        label: meta.label || "",
        updatedAt: meta.updatedAt || 0,
        error: Object.keys(errors).length > 0 ? errors : undefined,
      });
    }

    return result;
  }

  /**
   * 단일 슬롯 파일(음원 또는 사진) 저장/교체
   * 트랜잭션 안전성: 새 파일 OPFS 저장 -> IDB 메타 갱신 -> 이전 OPFS 파일 삭제
   */
  async saveSlotFile(slotId, kind, file, { embeddedImageFile = null } = {}) {
    if (!file) throw new Error("저장할 파일이 없습니다.");
    if (kind !== "audio" && kind !== "image") throw new Error("잘못된 파일 종류입니다.");

    return this._enqueueSlotOperation(slotId, async () => {
      await this.init();

      const existingMeta = (await this._getMetaFromDb(slotId)) || {
        id: slotId,
        audioFileName: null,
        audioMime: null,
        audioPath: null,
        imageFileName: null,
        imageMime: null,
        imagePath: null,
        label: "",
        updatedAt: 0,
      };

      const existingImageSource = existingMeta.imagePath ? existingMeta.imageSource || "manual" : null;
      const newOpfsFileName = this._generateSafeFileName(slotId, kind, file.name, file.type);
      const oldOpfsFileName = kind === "audio" ? existingMeta.audioPath : existingMeta.imagePath;
      let newEmbeddedPath = null;

      // 1. 새 파일 OPFS에 저장
      await this._writeFileToOpfs(newOpfsFileName, file);

      if (kind === "audio" && existingImageSource !== "manual" && embeddedImageFile) {
        newEmbeddedPath = this._generateSafeFileName(
          slotId,
          "image",
          embeddedImageFile.name,
          embeddedImageFile.type,
        );
        try {
          await this._writeFileToOpfs(newEmbeddedPath, embeddedImageFile);
        } catch (error) {
          await this._deleteFileFromOpfs(newOpfsFileName);
          throw error;
        }
      }

      // 2. 메타데이터 생성 및 IDB 저장
      const now = Date.now();
      const updatedMeta = {
        ...existingMeta,
        updatedAt: now,
      };

      if (kind === "audio") {
        updatedMeta.audioFileName = file.name;
        updatedMeta.audioMime = file.type;
        updatedMeta.audioPath = newOpfsFileName;
        updatedMeta.label = file.name.replace(/\.[^/.]+$/, "").trim() || `${slotId}번 음악`;

        if (existingImageSource !== "manual") {
          updatedMeta.imageFileName = embeddedImageFile ? embeddedImageFile.name : null;
          updatedMeta.imageMime = embeddedImageFile ? embeddedImageFile.type : null;
          updatedMeta.imagePath = newEmbeddedPath;
          updatedMeta.imageSource = embeddedImageFile ? "embedded" : null;
        }
      } else {
        updatedMeta.imageFileName = file.name;
        updatedMeta.imageMime = file.type;
        updatedMeta.imagePath = newOpfsFileName;
        updatedMeta.imageSource = "manual";
      }

      try {
        await this._putMetaToDb(updatedMeta);
      } catch (dbErr) {
        // IDB 갱신 실패 시 새로 쓴 OPFS 파일 롤백
        await this._deleteFileFromOpfs(newOpfsFileName);
        if (newEmbeddedPath) await this._deleteFileFromOpfs(newEmbeddedPath);
        throw dbErr;
      }

      // 3. IDB 갱신 성공 후 이전 파일 정리
      if (oldOpfsFileName && oldOpfsFileName !== newOpfsFileName) {
        await this._deleteFileFromOpfs(oldOpfsFileName);
      }
      if (
        kind === "audio" &&
        existingImageSource !== "manual" &&
        existingMeta.imagePath &&
        existingMeta.imagePath !== updatedMeta.imagePath
      ) {
        await this._deleteFileFromOpfs(existingMeta.imagePath);
      }

      // 4. 슬롯 상태 반환
      let audioFile = null;
      let imageFile = null;

      if (updatedMeta.audioPath) {
        if (kind === "audio") {
          audioFile = file;
        } else {
          audioFile = await this._readFileFromOpfs(
            updatedMeta.audioPath,
            updatedMeta.audioFileName,
            updatedMeta.audioMime,
            updatedMeta.updatedAt
          ).catch(() => null);
        }
      }

      if (updatedMeta.imagePath) {
        if (kind === "image") {
          imageFile = file;
        } else if (newEmbeddedPath && updatedMeta.imagePath === newEmbeddedPath) {
          imageFile = embeddedImageFile;
        } else {
          imageFile = await this._readFileFromOpfs(
            updatedMeta.imagePath,
            updatedMeta.imageFileName,
            updatedMeta.imageMime,
            updatedMeta.updatedAt
          ).catch(() => null);
        }
      }

      return {
        id: slotId,
        audioFile,
        audioFileName: updatedMeta.audioFileName,
        audioMime: updatedMeta.audioMime,
        audioPath: updatedMeta.audioPath,
        imageFile,
        imageFileName: updatedMeta.imageFileName,
        imageMime: updatedMeta.imageMime,
        imagePath: updatedMeta.imagePath,
        imageSource: updatedMeta.imagePath ? updatedMeta.imageSource || "manual" : null,
        label: updatedMeta.label,
        updatedAt: updatedMeta.updatedAt,
      };
    });
  }

  /**
   * 음원과 사진을 한 번에 저장 (DESIGN.md 계약)
   */
  async saveSlot(slotId, audioFile, imageFile) {
    if (!audioFile || !imageFile) {
      throw new Error("음원과 사진 파일이 모두 필요합니다.");
    }

    return this._enqueueSlotOperation(slotId, async () => {
      await this.init();

      const existingMeta = (await this._getMetaFromDb(slotId)) || {
        id: slotId,
        audioPath: null,
        imagePath: null,
      };

      const newAudioPath = this._generateSafeFileName(slotId, "audio", audioFile.name, audioFile.type);
      const newImagePath = this._generateSafeFileName(slotId, "image", imageFile.name, imageFile.type);

      const oldAudioPath = existingMeta.audioPath;
      const oldImagePath = existingMeta.imagePath;

      // 1. 새 음원 저장
      await this._writeFileToOpfs(newAudioPath, audioFile);

      // 2. 새 사진 저장
      try {
        await this._writeFileToOpfs(newImagePath, imageFile);
      } catch (err) {
        await this._deleteFileFromOpfs(newAudioPath);
        throw err;
      }

      // 3. IDB 갱신
      const now = Date.now();
      const updatedMeta = {
        id: slotId,
        audioFileName: audioFile.name,
        audioMime: audioFile.type,
        audioPath: newAudioPath,
        imageFileName: imageFile.name,
        imageMime: imageFile.type,
        imagePath: newImagePath,
        imageSource: "manual",
        label: audioFile.name.replace(/\.[^/.]+$/, "").trim() || `${slotId}번 음악`,
        updatedAt: now,
      };

      try {
        await this._putMetaToDb(updatedMeta);
      } catch (dbErr) {
        await this._deleteFileFromOpfs(newAudioPath);
        await this._deleteFileFromOpfs(newImagePath);
        throw dbErr;
      }

      // 4. 이전 파일 정리
      if (oldAudioPath && oldAudioPath !== newAudioPath) {
        await this._deleteFileFromOpfs(oldAudioPath);
      }
      if (oldImagePath && oldImagePath !== newImagePath) {
        await this._deleteFileFromOpfs(oldImagePath);
      }

      return {
        id: slotId,
        audioFile,
        audioFileName: updatedMeta.audioFileName,
        audioMime: updatedMeta.audioMime,
        audioPath: updatedMeta.audioPath,
        imageFile,
        imageFileName: updatedMeta.imageFileName,
        imageMime: updatedMeta.imageMime,
        imagePath: updatedMeta.imagePath,
        imageSource: "manual",
        label: updatedMeta.label,
        updatedAt: updatedMeta.updatedAt,
      };
    });
  }

  /**
   * 슬롯 완전 삭제 (IDB 메타데이터 및 OPFS 파일 삭제)
   */
  async removeSlot(slotId) {
    return this._enqueueSlotOperation(slotId, async () => {
      await this.init();

      const existingMeta = await this._getMetaFromDb(slotId);
      if (!existingMeta) return;

      // 1. IDB 메타 삭제
      await this._deleteMetaFromDb(slotId);

      // 2. OPFS 파일 삭제
      if (existingMeta.audioPath) {
        await this._deleteFileFromOpfs(existingMeta.audioPath);
      }
      if (existingMeta.imagePath) {
        await this._deleteFileFromOpfs(existingMeta.imagePath);
      }
    });
  }

  async getSettings() {
    await this.init();
    const stored = await this._getSettingsFromDb();
    return { maxVolume: normalizeMaxVolume(stored?.maxVolume) };
  }

  async saveSettings({ maxVolume }) {
    await this.init();
    const normalized = normalizeMaxVolume(maxVolume);
    await this._putSettingsToDb({
      key: "app-settings",
      maxVolume: normalized,
      updatedAt: Date.now(),
    });
    return { maxVolume: normalized };
  }

  /**
   * 저장소 사용량 및 영구 저장 상태 조회
   */
  async estimate() {
    let usage = 0;
    let quota = 0;
    let persisted = false;

    if (navigator.storage) {
      if (typeof navigator.storage.estimate === "function") {
        try {
          const est = await navigator.storage.estimate();
          usage = est.usage || 0;
          quota = est.quota || 0;
        } catch {}
      }

      if (typeof navigator.storage.persisted === "function") {
        try {
          persisted = await navigator.storage.persisted();
        } catch {}
      }
    }

    const percent = quota > 0 ? Math.min(100, Math.round((usage / quota) * 1000) / 10) : 0;

    return {
      usage,
      quota,
      persisted,
      percent,
    };
  }

  /**
   * 영구 저장 권한 요청
   */
  async requestPersistence() {
    if (navigator.storage && typeof navigator.storage.persist === "function") {
      try {
        return await navigator.storage.persist();
      } catch {
        return false;
      }
    }
    return false;
  }
}

export const storage = new JukeboxStorage();

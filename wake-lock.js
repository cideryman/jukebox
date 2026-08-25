export const WAKE_LOCK_MODES = {
  PLAYING: "playing",
  ALWAYS: "always",
  SYSTEM: "system",
};

export function normalizeWakeLockMode(mode) {
  if (mode === WAKE_LOCK_MODES.ALWAYS || mode === WAKE_LOCK_MODES.SYSTEM) {
    return mode;
  }
  return WAKE_LOCK_MODES.PLAYING;
}

export class WakeLockController {
  constructor({
    navigatorRef = typeof navigator !== "undefined" ? navigator : null,
    documentRef = typeof document !== "undefined" ? document : null,
  } = {}) {
    this.navigator = navigatorRef;
    this.document = documentRef;
    this.mode = WAKE_LOCK_MODES.PLAYING;
    this.isPlaying = false;
    this.sentinel = null;
    this.isRequesting = false;
    this._onVisibilityChange = this._onVisibilityChange.bind(this);

    if (this.document) {
      this.document.addEventListener("visibilitychange", this._onVisibilityChange);
    }
  }

  get isSupported() {
    return Boolean(
      this.navigator &&
        "wakeLock" in this.navigator &&
        typeof this.navigator.wakeLock?.request === "function",
    );
  }

  get isActive() {
    return Boolean(this.sentinel && !this.sentinel.released);
  }

  setMode(mode) {
    this.mode = normalizeWakeLockMode(mode);
    this.update();
    return this.mode;
  }

  setPlaying(isPlaying) {
    this.isPlaying = Boolean(isPlaying);
    this.update();
  }

  shouldKeepAwake() {
    if (!this.isSupported) return false;
    if (this.document && this.document.visibilityState === "hidden") return false;
    if (this.mode === WAKE_LOCK_MODES.ALWAYS) return true;
    if (this.mode === WAKE_LOCK_MODES.PLAYING && this.isPlaying) return true;
    return false;
  }

  async update() {
    if (this.shouldKeepAwake()) {
      await this.request();
    } else {
      await this.release();
    }
  }

  async request() {
    if (!this.isSupported || this.isRequesting || this.isActive) return false;
    this.isRequesting = true;
    try {
      const sentinel = await this.navigator.wakeLock.request("screen");
      this.sentinel = sentinel;
      sentinel.addEventListener("release", () => {
        if (this.sentinel === sentinel) {
          this.sentinel = null;
        }
      });
      return true;
    } catch (err) {
      console.warn("Screen Wake Lock 요청 실패:", err);
      return false;
    } finally {
      this.isRequesting = false;
    }
  }

  async release() {
    if (!this.sentinel) return false;
    try {
      const sentinel = this.sentinel;
      this.sentinel = null;
      if (!sentinel.released) {
        await sentinel.release();
      }
      return true;
    } catch (err) {
      console.warn("Screen Wake Lock 해제 실패:", err);
      return false;
    }
  }

  _onVisibilityChange() {
    if (this.document && this.document.visibilityState === "visible") {
      this.update();
    } else {
      this.release();
    }
  }

  destroy() {
    if (this.document) {
      this.document.removeEventListener("visibilitychange", this._onVisibilityChange);
    }
    this.release();
  }
}

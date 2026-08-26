export class ActivationGuard {
  constructor(quietPeriodMs = 700) {
    this.quietPeriodMs = quietPeriodMs;
    this.blockedUntil = 0;
    this.feedbackSlotId = null;
  }

  attempt(slotId, now = performance.now()) {
    const accepted = now >= this.blockedUntil;
    this.blockedUntil = now + this.quietPeriodMs;
    if (accepted) this.feedbackSlotId = Number(slotId);
    return accepted;
  }

  isStabilizing(slotId, now = performance.now()) {
    return Number(slotId) === this.feedbackSlotId && now < this.blockedUntil;
  }

  remaining(now = performance.now()) {
    return Math.max(0, this.blockedUntil - now);
  }
}

export class PointerGestureTracker {
  constructor(maxMovementPx = 64) {
    this.maxMovementPx = maxMovementPx;
    this.active = null;
  }

  begin({ pointerId, isPrimary, button, clientX, clientY, slotId }) {
    if (!isPrimary || button !== 0 || this.active) return false;
    this.active = {
      pointerId,
      slotId: Number(slotId),
      startX: clientX,
      startY: clientY,
      cancelled: false,
    };
    return true;
  }

  move({ pointerId, clientX, clientY }) {
    if (!this.active || this.active.pointerId !== pointerId) return false;
    if (Math.hypot(clientX - this.active.startX, clientY - this.active.startY) > this.maxMovementPx) {
      this.active.cancelled = true;
    }
    return !this.active.cancelled;
  }

  finish({ pointerId }) {
    if (!this.active || this.active.pointerId !== pointerId) return null;
    const result = this.active.cancelled ? null : this.active.slotId;
    this.active = null;
    return result;
  }

  cancel(pointerId) {
    if (!this.active || this.active.pointerId !== pointerId) return false;
    this.active = null;
    return true;
  }
}

export class TwoFingerSwipeTracker {
  constructor(thresholdPx = 80) {
    this.thresholdPx = thresholdPx;
    this.active = false;
    this.startX = 0;
    this.startY = 0;
  }

  handleTouchStart(touches) {
    if (touches.length === 2) {
      this.active = true;
      this.startX = (touches[0].clientX + touches[1].clientX) / 2;
      this.startY = (touches[0].clientY + touches[1].clientY) / 2;
    } else {
      this.active = false;
    }
  }

  handleTouchMove(touches) {
    if (!this.active || touches.length !== 2) return null;
    const currentX = (touches[0].clientX + touches[1].clientX) / 2;
    const currentY = (touches[0].clientY + touches[1].clientY) / 2;

    const deltaX = currentX - this.startX;
    const deltaY = currentY - this.startY;

    // 수평 이동이 수직 이동보다 크고 임계값을 넘었는지 확인
    if (Math.abs(deltaX) > this.thresholdPx && Math.abs(deltaX) > Math.abs(deltaY)) {
      this.active = false; // 한 번 감지되면 초기화 (중복 트리거 방지)
      return deltaX > 0 ? "right" : "left";
    }
    return null;
  }

  handleTouchEnd(touches) {
    if (touches.length !== 2) {
      this.active = false;
    }
  }
}

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

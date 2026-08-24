export function normalizeMaxVolume(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 10 && parsed <= 100 && parsed % 10 === 0 ? parsed : 100;
}

export function applyVolumeLimit(audioElement, value) {
  const normalized = normalizeMaxVolume(value);
  if (audioElement) audioElement.volume = normalized / 100;
  return normalized;
}

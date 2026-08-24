const MIME_BY_EXTENSION = {
  audio: {
    mp3: "audio/mpeg",
    m4a: "audio/mp4",
    aac: "audio/aac",
    wav: "audio/wav",
    ogg: "audio/ogg",
    oga: "audio/ogg",
    opus: "audio/opus",
    flac: "audio/flac",
  },
  image: {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    gif: "image/gif",
  },
};

function getExtension(fileName) {
  const match = String(fileName || "").toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? match[1] : "";
}

/**
 * 모바일 파일 선택기가 MIME을 비워 두거나 application/octet-stream으로
 * 전달하더라도 알려진 확장자를 기준으로 재생 가능한 File을 구성한다.
 */
export function normalizeFileForKind(file, kind) {
  if (!file || !MIME_BY_EXTENSION[kind]) return null;

  const expectedPrefix = `${kind}/`;
  const currentType = String(file.type || "").toLowerCase();
  if (currentType.startsWith(expectedPrefix)) return file;

  const inferredType = MIME_BY_EXTENSION[kind][getExtension(file.name)];
  if (!inferredType) return null;

  return new File([file], file.name, {
    type: inferredType,
    lastModified: file.lastModified || Date.now(),
  });
}

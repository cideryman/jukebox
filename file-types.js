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

function hasBytes(bytes, signature, offset = 0) {
  return signature.every((value, index) => bytes[offset + index] === value);
}

function isMpegAudioFrame(bytes, offset) {
  if (bytes[offset] !== 0xff || (bytes[offset + 1] & 0xe0) !== 0xe0) return false;

  const version = (bytes[offset + 1] >> 3) & 0x03;
  const layer = (bytes[offset + 1] >> 1) & 0x03;
  const bitrate = (bytes[offset + 2] >> 4) & 0x0f;
  const sampleRate = (bytes[offset + 2] >> 2) & 0x03;
  return version !== 0x01 && layer !== 0x00 && bitrate !== 0x00 && bitrate !== 0x0f && sampleRate !== 0x03;
}

async function detectTypeFromContents(file, kind) {
  try {
    const bytes = new Uint8Array(await file.slice(0, 4096).arrayBuffer());

    if (kind === "audio") {
      if (hasBytes(bytes, [0x49, 0x44, 0x33])) return "audio/mpeg"; // ID3
      for (let offset = 0; offset < bytes.length - 3; offset += 1) {
        if (isMpegAudioFrame(bytes, offset)) return "audio/mpeg";
      }
      if (hasBytes(bytes, [0x52, 0x49, 0x46, 0x46]) && hasBytes(bytes, [0x57, 0x41, 0x56, 0x45], 8)) {
        return "audio/wav";
      }
      if (hasBytes(bytes, [0x4f, 0x67, 0x67, 0x53])) return "audio/ogg";
      if (hasBytes(bytes, [0x66, 0x4c, 0x61, 0x43])) return "audio/flac";
      if (hasBytes(bytes, [0x66, 0x74, 0x79, 0x70], 4)) return "audio/mp4";
      if (bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0) return "audio/aac";
    }

    if (kind === "image") {
      if (hasBytes(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
      if (hasBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
      if (hasBytes(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
      if (hasBytes(bytes, [0x52, 0x49, 0x46, 0x46]) && hasBytes(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {
        return "image/webp";
      }
    }
  } catch (error) {
    console.warn("선택한 파일의 형식을 확인하지 못했습니다:", error);
  }

  return null;
}

/**
 * 모바일 파일 선택기가 MIME과 확장자를 누락하거나 일반 형식으로
 * 전달하더라도 확장자와 실제 파일 표식을 확인해 재생 가능한 File을 구성한다.
 */
export async function normalizeFileForKind(file, kind) {
  if (!file || !MIME_BY_EXTENSION[kind]) return null;

  const expectedPrefix = `${kind}/`;
  const currentType = String(file.type || "").toLowerCase();
  if (currentType.startsWith(expectedPrefix)) return file;

  const inferredType = MIME_BY_EXTENSION[kind][getExtension(file.name)] || (await detectTypeFromContents(file, kind));
  if (!inferredType) return null;

  return new File([file], file.name, {
    type: inferredType,
    lastModified: file.lastModified || Date.now(),
  });
}

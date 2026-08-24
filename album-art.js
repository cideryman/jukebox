const MAX_ID3_TAG_SIZE = 32 * 1024 * 1024;

function readSyncSafe(bytes, offset) {
  return (
    ((bytes[offset] & 0x7f) << 21) |
    ((bytes[offset + 1] & 0x7f) << 14) |
    ((bytes[offset + 2] & 0x7f) << 7) |
    (bytes[offset + 3] & 0x7f)
  );
}

function readUint32(bytes, offset) {
  return (
    bytes[offset] * 0x1000000 +
    (bytes[offset + 1] << 16) +
    (bytes[offset + 2] << 8) +
    bytes[offset + 3]
  );
}

function readLatin1(bytes, start, end) {
  let result = "";
  for (let index = start; index < end; index += 1) result += String.fromCharCode(bytes[index]);
  return result;
}

function findDescriptionEnd(bytes, start, encoding) {
  if (encoding === 1 || encoding === 2) {
    for (let index = start; index < bytes.length - 1; index += 2) {
      if (bytes[index] === 0 && bytes[index + 1] === 0) return index + 2;
    }
    return -1;
  }

  const end = bytes.indexOf(0, start);
  return end === -1 ? -1 : end + 1;
}

function detectImageType(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (readLatin1(bytes, 0, 4) === "GIF8") return "image/gif";
  if (readLatin1(bytes, 0, 4) === "RIFF" && readLatin1(bytes, 8, 12) === "WEBP") return "image/webp";
  return null;
}

function parseApicFrame(payload) {
  if (payload.length < 5) return null;

  const encoding = payload[0];
  const mimeEnd = payload.indexOf(0, 1);
  if (mimeEnd < 0 || mimeEnd + 2 >= payload.length) return null;

  let mimeType = readLatin1(payload, 1, mimeEnd).toLowerCase();
  if (mimeType === "image/jpg") mimeType = "image/jpeg";
  if (mimeType === "-->") return null;

  const imageStart = findDescriptionEnd(payload, mimeEnd + 2, encoding);
  if (imageStart < 0 || imageStart >= payload.length) return null;

  const imageBytes = payload.slice(imageStart);
  mimeType = mimeType.startsWith("image/") ? mimeType : detectImageType(imageBytes);
  if (!mimeType) return null;

  const extension = mimeType === "image/jpeg" ? "jpg" : mimeType.split("/")[1] || "img";
  return new File([imageBytes], `embedded-cover.${extension}`, {
    type: mimeType,
    lastModified: Date.now(),
  });
}

/**
 * MP3 ID3v2.3/v2.4의 APIC 프레임에서 내장 앨범아트를 꺼낸다.
 * 지원하지 않거나 손상된 태그는 음원 등록을 막지 않고 null을 반환한다.
 */
export async function extractEmbeddedArtwork(file) {
  try {
    if (!file || file.size < 10) return null;
    const header = new Uint8Array(await file.slice(0, 10).arrayBuffer());
    if (readLatin1(header, 0, 3) !== "ID3") return null;

    const version = header[3];
    if (version !== 3 && version !== 4) return null;

    const tagSize = readSyncSafe(header, 6);
    if (tagSize <= 0 || tagSize > MAX_ID3_TAG_SIZE) return null;

    const bytes = new Uint8Array(await file.slice(0, Math.min(file.size, tagSize + 10)).arrayBuffer());
    let offset = 10;

    if ((header[5] & 0x40) !== 0 && offset + 4 <= bytes.length) {
      const extendedSize = version === 4 ? readSyncSafe(bytes, offset) : readUint32(bytes, offset) + 4;
      if (extendedSize <= 0 || offset + extendedSize > bytes.length) return null;
      offset += extendedSize;
    }

    while (offset + 10 <= bytes.length) {
      const frameId = readLatin1(bytes, offset, offset + 4);
      if (!/^[A-Z0-9]{4}$/.test(frameId)) break;

      const frameSize = version === 4 ? readSyncSafe(bytes, offset + 4) : readUint32(bytes, offset + 4);
      const payloadStart = offset + 10;
      const payloadEnd = payloadStart + frameSize;
      if (frameSize <= 0 || payloadEnd > bytes.length) break;

      if (frameId === "APIC") return parseApicFrame(bytes.slice(payloadStart, payloadEnd));
      offset = payloadEnd;
    }
  } catch (error) {
    console.warn("내장 앨범아트를 읽지 못했습니다:", error);
  }

  return null;
}

export function containerMime(mimeType) {
  return String(mimeType).split(';', 1)[0].trim().toLowerCase();
}

export function extensionForMime(mimeType) {
  return ({
    'audio/webm': 'webm',
    'audio/ogg': 'ogg',
    'audio/mp4': 'm4a',
    'video/webm': 'webm',
  })[containerMime(mimeType)];
}

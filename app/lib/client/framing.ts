export const FRAME_HEADER = 52;
export const INITIAL_CHUNK = 16 * 1024;
export const MAX_CHUNK = 64 * 1024;
export const RECEIVE_WINDOW = 4 * 1024 * 1024;
export const MEMORY_FILE_LIMIT = 64 * 1024 * 1024;
function uuidBytes(value: string): Uint8Array {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new Error('Invalid transfer identifier.');
  return Uint8Array.from(value.replaceAll('-', '').match(/.{2}/g)!, byte => parseInt(byte, 16));
}
function uuidString(bytes: Uint8Array): string {
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function encodeFrame(batchId: string, fileId: string, offset: number, payload: ArrayBuffer): ArrayBuffer {
  if (!Number.isSafeInteger(offset) || offset < 0 || payload.byteLength > MAX_CHUNK) throw new Error('Invalid transfer frame.');
  const buffer = new ArrayBuffer(FRAME_HEADER + payload.byteLength);
  const bytes = new Uint8Array(buffer); const view = new DataView(buffer);
  view.setUint32(0, 0x46385331); bytes.set(uuidBytes(batchId), 4); bytes.set(uuidBytes(fileId), 20);
  view.setBigUint64(36, BigInt(offset)); view.setUint32(44, payload.byteLength); view.setUint32(48, 1);
  bytes.set(new Uint8Array(payload), FRAME_HEADER); return buffer;
}
export function decodeFrame(buffer: ArrayBuffer): {batchId: string; fileId: string; offset: number; payload: Uint8Array} {
  if (buffer.byteLength < FRAME_HEADER) throw new Error('Truncated transfer frame.');
  const view = new DataView(buffer); const bytes = new Uint8Array(buffer);
  const offset = Number(view.getBigUint64(36)); const length = view.getUint32(44);
  if (view.getUint32(0) !== 0x46385331 || view.getUint32(48) !== 1 || !Number.isSafeInteger(offset) || length > MAX_CHUNK || length !== buffer.byteLength - FRAME_HEADER) throw new Error('Invalid transfer frame.');
  return {batchId: uuidString(bytes.subarray(4, 20)), fileId: uuidString(bytes.subarray(20, 36)), offset, payload: bytes.subarray(FRAME_HEADER)};
}

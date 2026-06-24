// 状态流分享 blob 压缩（REPLAY_SHARE_DESIGN §7）。
//
// 分享 blob 是高度重复的 delta JSON（同结构逐帧），gzip 压缩比极高（~10-20×）。分享只发生在 Web
// （需 fetch + 在线），故直接用浏览器原生 CompressionStream/'gzip'；线上以 base64 字符串塞进既有
// JSON 包络（服务端 opaque 存储、不解释）。运行环境缺 CompressionStream（老浏览器 / 微信小游戏，
// 后者本就不可达分享路径）则抛错，由分享 UI 兜底提示。

/** gzip 魔数：解包时据此判断 blob 是否压缩（兼容历史/未压缩明文）。 */
const GZIP_MAGIC0 = 0x1f;
const GZIP_MAGIC1 = 0x8b;

function bytesToBase64(bytes: Uint8Array): string {
  // 分块拼 binary string 避免大数组撑爆 String.fromCharCode 调用栈。
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** EncodedStateReplay → gzip → base64 字符串。环境不支持压缩则抛错（分享 UI 兜底）。 */
export async function packReplayBlob(enc: unknown): Promise<string> {
  const json = JSON.stringify(enc);
  if (typeof CompressionStream === 'undefined') {
    throw new Error('compression unavailable in this runtime');
  }
  const cs = new CompressionStream('gzip');
  const stream = new Blob([json]).stream().pipeThrough(cs);
  const buf = new Uint8Array(await new Response(stream).arrayBuffer());
  return bytesToBase64(buf);
}

/** base64(gzip) → EncodedStateReplay。明文 JSON（未压缩历史/降级流）亦兼容解析。 */
export async function unpackReplayBlob(packed: unknown): Promise<unknown> {
  // 兼容：历史/降级路径可能直接存了对象而非压缩串。
  if (typeof packed !== 'string') return packed;
  const bytes = base64ToBytes(packed);
  // 拷进一块确定的 ArrayBuffer，规避 Uint8Array<ArrayBufferLike> 不满足 BlobPart 的类型问题。
  const ab = new ArrayBuffer(bytes.length);
  new Uint8Array(ab).set(bytes);
  if (bytes.length >= 2 && bytes[0] === GZIP_MAGIC0 && bytes[1] === GZIP_MAGIC1) {
    const ds = new DecompressionStream('gzip');
    const stream = new Blob([ab]).stream().pipeThrough(ds);
    const json = await new Response(stream).text();
    return JSON.parse(json) as unknown;
  }
  // 非 gzip：当作明文 JSON（理论上不该发生，留兜底）。
  return JSON.parse(new TextDecoder().decode(ab)) as unknown;
}

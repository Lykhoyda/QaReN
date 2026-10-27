import { crc32, inflateSync } from 'node:zlib';

export interface PngImage {
  width: number;
  height: number;
  channels: 3 | 4;
  data: Uint8Array;
}

export function decodePng(bytes: Uint8Array): PngImage | undefined {
  try {
    const png = Buffer.from(bytes);
    if (
      png.length > 64 * 1024 * 1024 ||
      !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      return undefined;
    let width = 0;
    let height = 0;
    let channels: 3 | 4 = 3;
    const chunks: Buffer[] = [];
    let ended = false;
    let dataEnded = false;
    for (let offset = 8; offset < png.length; ) {
      const length = png.readUInt32BE(offset);
      const end = offset + 12 + length;
      if (end > png.length) return undefined;
      const type = png.toString('ascii', offset + 4, offset + 8);
      const data = png.subarray(offset + 8, end - 4);
      if (crc32(png.subarray(offset + 4, end - 4)) !== png.readUInt32BE(end - 4)) return undefined;
      if (offset === 8 && type !== 'IHDR') return undefined;
      if (type === 'IHDR') {
        if (width || length !== 13) return undefined;
        width = data.readUInt32BE(0);
        height = data.readUInt32BE(4);
        if (
          !width ||
          !height ||
          width * height > 16 * 1024 * 1024 ||
          data[8] !== 8 ||
          (data[9] !== 2 && data[9] !== 6) ||
          data[10] ||
          data[11] ||
          data[12]
        )
          return undefined;
        channels = data[9] === 2 ? 3 : 4;
      } else if (type === 'IDAT') {
        if (dataEnded) return undefined;
        chunks.push(data);
      } else if (type === 'IEND') {
        if (length !== 0 || !chunks.length || end !== png.length) return undefined;
        ended = true;
        break;
      } else {
        if (chunks.length) dataEnded = true;
        if (type !== 'PLTE' && (png[offset + 4] & 32) === 0) return undefined;
        if (type === 'tRNS') return undefined;
      }
      offset = end;
    }
    if (!ended) return undefined;
    const stride = width * channels;
    const size = (stride + 1) * height;
    const raw = inflateSync(Buffer.concat(chunks), { maxOutputLength: size });
    if (raw.length !== size) return undefined;
    const data = new Uint8Array(stride * height);
    for (let y = 0; y < height; y++) {
      const filter = raw[y * (stride + 1)];
      if (filter > 4) return undefined;
      for (let x = 0; x < stride; x++) {
        const index = y * stride + x;
        const left = x >= channels ? data[index - channels] : 0;
        const up = y ? data[index - stride] : 0;
        const corner = y && x >= channels ? data[index - stride - channels] : 0;
        const p = left + up - corner;
        const pa = Math.abs(p - left),
          pb = Math.abs(p - up),
          pc = Math.abs(p - corner);
        const predictor =
          filter === 0
            ? 0
            : filter === 1
              ? left
              : filter === 2
                ? up
                : filter === 3
                  ? Math.floor((left + up) / 2)
                  : pa <= pb && pa <= pc
                    ? left
                    : pb <= pc
                      ? up
                      : corner;
        data[index] = (raw[y * (stride + 1) + 1 + x] + predictor) & 255;
      }
    }
    return { width, height, channels, data };
  } catch {
    return undefined;
  }
}

export interface PixelCrop {
  x: number;
  y: number;
  width: number;
  height: number;
  imageWidth: number;
  imageHeight: number;
  rgb: Uint8Array;
}

// A reported point scale, or the app root's size in points to derive one from the image.
export type PixelScale = number | { width: number; height: number };

export function cropPng(
  bytes: Uint8Array,
  frame: { x: number; y: number; width: number; height: number },
  points: PixelScale,
): PixelCrop | undefined {
  if (
    ![frame.x, frame.y, frame.width, frame.height].every(Number.isFinite) ||
    frame.width <= 0 ||
    frame.height <= 0
  )
    return undefined;
  const image = decodePng(bytes);
  if (!image) return undefined;
  const scale = typeof points === 'number' ? points : image.width / points.width;
  // A derived scale must agree on both axes, or the shot is not of the measured root.
  if (
    !Number.isFinite(scale) ||
    scale <= 0 ||
    (typeof points !== 'number' && Math.abs(image.height / points.height - scale) > 0.01)
  )
    return undefined;
  const clamp = (value: number, max: number) =>
    Math.max(0, Math.min(max, Math.round(value * scale)));
  const x = clamp(frame.x, image.width),
    y = clamp(frame.y, image.height);
  const width = clamp(frame.x + frame.width, image.width) - x;
  const height = clamp(frame.y + frame.height, image.height) - y;
  if (width <= 0 || height <= 0) return undefined;
  const rgb = new Uint8Array(width * height * 3);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const source = ((y + row) * image.width + x + col) * image.channels;
      if (image.channels === 4 && image.data[source + 3] !== 255) return undefined;
      rgb.set(image.data.subarray(source, source + 3), (row * width + col) * 3);
    }
  }
  return { x, y, width, height, imageWidth: image.width, imageHeight: image.height, rgb };
}

export function changedPixels(a: PixelCrop, b: PixelCrop): number | undefined {
  if (
    a.x !== b.x ||
    a.y !== b.y ||
    a.width !== b.width ||
    a.height !== b.height ||
    a.imageWidth !== b.imageWidth ||
    a.imageHeight !== b.imageHeight
  )
    return undefined;
  let changed = 0;
  for (let i = 0; i < a.rgb.length; i += 3) {
    if (
      Math.max(
        Math.abs(a.rgb[i] - b.rgb[i]),
        Math.abs(a.rgb[i + 1] - b.rgb[i + 1]),
        Math.abs(a.rgb[i + 2] - b.rgb[i + 2]),
      ) > 24
    )
      changed++;
  }
  return changed;
}

export function stablePixelChange(before: PixelCrop, first: PixelCrop, second: PixelCrop): boolean {
  const stable = changedPixels(first, second);
  const changed = changedPixels(before, second);
  const pixels = before.width * before.height;
  return (
    stable !== undefined &&
    changed !== undefined &&
    stable < pixels * 0.002 &&
    changed >= Math.max(pixels * 0.01, 16)
  );
}

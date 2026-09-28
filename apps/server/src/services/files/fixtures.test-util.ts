// Small byte fixtures of every supported upload type (only the headers the sniffer reads), shared by the W1.5 tests.

function bytes(...chunks: (string | number[])[]): Uint8Array {
  const out: number[] = []
  for (const chunk of chunks) {
    if (typeof chunk === 'string')
      out.push(...Array.from(chunk, char => char.charCodeAt(0)))
    else
      out.push(...chunk)
  }
  return new Uint8Array(out)
}

export const PNG = bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13], 'IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0])
export const JPEG = bytes([0xFF, 0xD8, 0xFF, 0xE0, 0, 16], 'JFIF', [0, 1, 1, 0, 0, 1, 0, 1, 0, 0])
export const GIF = bytes('GIF89a', [1, 0, 1, 0, 0, 0, 0])
export const WEBP = bytes('RIFF', [26, 0, 0, 0], 'WEBPVP8 ', [14, 0, 0, 0])
export const AVIF = bytes([0, 0, 0, 0x1C], 'ftyp', 'avif', [0, 0, 0, 0], 'avif', 'mif1', 'miaf')
export const HEIC = bytes([0, 0, 0, 0x18], 'ftyp', 'heic', [0, 0, 0, 0], 'mif1', 'heic')
export const BMP = bytes('BM', [70, 0, 0, 0], [0, 0, 0, 0], [54, 0, 0, 0], [40, 0, 0, 0], [1, 0, 0, 0, 1, 0, 0, 0])
export const ICO = bytes([0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0])
export const TIFF = bytes('II*', [0, 8, 0, 0, 0])
export const PDF = bytes('%PDF-1.7\n%', [0xE2, 0xE3, 0xCF, 0xD3], '\n1 0 obj\n<<>>\nendobj\n%%EOF\n')
export const SVG = bytes('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>\n')
export const TEXT = bytes('hello world\n')
export const INVALID_UTF8 = bytes('abc', [0xC3, 0x28], 'def')
export const WITH_NUL = bytes('abc', [0], 'def')
export const MP4 = bytes([0, 0, 0, 0x18], 'ftyp', 'isom', [0, 0, 2, 0], 'isom', 'mp41')

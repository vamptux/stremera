const FALLBACK_ACCENT = { red: 120, green: 130, blue: 145 };

export interface HeroAccent {
  red: number;
  green: number;
  blue: number;
}

function rgbToHsl(r: number, g: number, b: number) {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return { h, s, l };
}

function hslToRgb(h: number, s: number, l: number) {
  if (s === 0) { const v = Math.round(l * 255); return { r: v, g: v, b: v }; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue2rgb = (t: number) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return {
    r: Math.round(hue2rgb(h + 1 / 3) * 255),
    g: Math.round(hue2rgb(h) * 255),
    b: Math.round(hue2rgb(h - 1 / 3) * 255),
  };
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Failed to load hero artwork'));
    image.src = url;
  });
}

export async function extractHeroAccent(url?: string | null): Promise<HeroAccent> {
  if (!url || typeof window === 'undefined') return FALLBACK_ACCENT;

  try {
    const image = await loadImage(url);
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return FALLBACK_ACCENT;

    const size = 64;
    canvas.width = size;
    canvas.height = size;
    ctx.drawImage(image, 0, 0, size, size);

    const { data } = ctx.getImageData(0, 0, size, size);
    let totalWeight = 0;
    let rSum = 0, gSum = 0, bSum = 0;

    for (let y = 0; y < size; y++) {
      // Reduce weight for bottom quarter (dark bottom gradient area)
      const yWeight = y > size * 0.75 ? 0.25 : 1;

      for (let x = 0; x < size; x++) {
        // Reduce weight for left 15% (dark left gradient overlay)
        const xWeight = x < size * 0.15 ? 0.2 : 1;

        const i = (y * size + x) * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const a = data[i + 3] / 255;
        if (a < 0.8) continue;

        const { s, l } = rgbToHsl(r, g, b);
        // Skip near-black, near-white, or very desaturated
        if (l < 0.07 || l > 0.93 || s < 0.08) continue;

        // Cubic saturation bias — vivid pixels dominate heavily
        const satWeight = s * s * s;
        // Prefer mid-luminance over extremes
        const lumWeight = 1 - Math.abs(l - 0.5) * 0.7;
        const weight = satWeight * lumWeight * xWeight * yWeight;

        totalWeight += weight;
        rSum += r * weight;
        gSum += g * weight;
        bSum += b * weight;
      }
    }

    if (totalWeight === 0) return FALLBACK_ACCENT;

    const rawR = Math.round(rSum / totalWeight);
    const rawG = Math.round(gSum / totalWeight);
    const rawB = Math.round(bSum / totalWeight);

    const { h, s, l } = rgbToHsl(rawR, rawG, rawB);

    // If result is still very desaturated, the image has no strong color
    if (s < 0.1) return FALLBACK_ACCENT;

    // Boost saturation and clamp luminance for UI readability
    const boostedS = Math.min(0.85, s * 1.25);
    const targetL = Math.max(0.38, Math.min(0.55, l));
    const result = hslToRgb(h, boostedS, targetL);

    return { red: result.r, green: result.g, blue: result.b };
  } catch {
    return FALLBACK_ACCENT;
  }
}

export function buildHeroAccentStyles(accent: HeroAccent) {
  const rgb = `${accent.red}, ${accent.green}, ${accent.blue}`;
  // Lighter tint for badge text
  const lightR = Math.min(255, accent.red + 80);
  const lightG = Math.min(255, accent.green + 80);
  const lightB = Math.min(255, accent.blue + 80);

  return {
    button: {
      backgroundImage: `linear-gradient(135deg, rgba(${rgb}, 0.5), rgba(${rgb}, 0.18))`,
      borderColor: `rgba(${rgb}, 0.4)`,
      boxShadow: `inset 0 1px 0 rgba(255,255,255,0.08), 0 8px 24px rgba(${rgb}, 0.18)`,
    },
    badge: {
      backgroundImage: `linear-gradient(135deg, rgba(${rgb}, 0.25), rgba(${rgb}, 0.1))`,
      borderColor: `rgba(${rgb}, 0.32)`,
      color: `rgb(${lightR} ${lightG} ${lightB})`,
    },
    chip: {
      backgroundImage: `linear-gradient(135deg, rgba(${rgb}, 0.18), rgba(${rgb}, 0.06))`,
      borderColor: `rgba(${rgb}, 0.24)`,
      color: 'rgba(244, 244, 245, 0.88)',
    },
  };
}
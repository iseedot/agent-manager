interface PaletteLike {
  surface0: string;
  surface1: string;
  surface2: string;
  foreground: string;
  foregroundMuted: string;
  border: string;
  accent: string;
  statusSuccess: string;
  statusWarning: string;
  statusDanger: string;
}

interface ThemeLike {
  colors: PaletteLike;
}

export type StyleMap = Record<string, any>;

interface Tones {
  accent: string;
  ok: string;
  warn: string;
  danger: string;
  onAccent: string;
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function parseColor(value: string): Rgb | null {
  const text = (value ?? "").trim();
  const short = /^#([0-9a-f]{3})$/i.exec(text);
  if (short) {
    const [r, g, b] = short[1].split("").map((part) => parseInt(part + part, 16));
    return { r, g, b };
  }
  const long = /^#([0-9a-f]{6})$/i.exec(text);
  if (long) {
    const int = parseInt(long[1], 16);
    return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 };
  }
  const rgb = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(text);
  if (rgb) {
    return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]) };
  }
  return null;
}

function luminance(color: string): number {
  const rgb = parseColor(color);
  if (!rgb) {
    return 0;
  }
  return (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255;
}

function toHsl(rgb: Rgb): { h: number; s: number; l: number } {
  const r = rgb.r / 255;
  const g = rgb.g / 255;
  const b = rgb.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const delta = max - min;
  if (delta === 0) {
    return { h: 0, s: 0, l };
  }
  const s = delta / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) {
    h = 60 * (((g - b) / delta) % 6);
  } else if (max === g) {
    h = 60 * ((b - r) / delta + 2);
  } else {
    h = 60 * ((r - g) / delta + 4);
  }
  return { h: h < 0 ? h + 360 : h, s, l };
}

function alpha(color: string, value: number): string {
  const rgb = parseColor(color);
  if (!rgb) {
    return color;
  }
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${value})`;
}

function hsl(h: number, s: number, l: number): string {
  return `hsl(${Math.round(h)}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%)`;
}

function readable(
  color: string,
  options: { minSaturation: number; lightness: number; fallbackHue: number },
): string {
  const rgb = parseColor(color);
  if (!rgb) {
    return hsl(options.fallbackHue, options.minSaturation, options.lightness);
  }
  const { h, s } = toHsl(rgb);
  const hue = s < 0.12 ? options.fallbackHue : h;
  return hsl(hue, Math.max(s, options.minSaturation), options.lightness);
}

function buildTones(input: {
  surface0: string;
  accent: string;
  statusSuccess: string;
  statusWarning: string;
  statusDanger: string;
}): Tones {
  const dark = luminance(input.surface0) < 0.5;
  const bodyLightness = dark ? 0.63 : 0.4;
  return {
    accent: readable(input.accent, { minSaturation: 0.5, lightness: bodyLightness, fallbackHue: 212 }),
    ok: readable(input.statusSuccess, { minSaturation: 0.45, lightness: bodyLightness, fallbackHue: 142 }),
    warn: readable(input.statusWarning, {
      minSaturation: 0.55,
      lightness: dark ? 0.66 : 0.42,
      fallbackHue: 35,
    }),
    danger: readable(input.statusDanger, { minSaturation: 0.5, lightness: bodyLightness, fallbackHue: 5 }),
    onAccent: dark ? "#10151c" : "#ffffff",
  };
}

/** Styles for the composer pill and its popover — the only UI this plugin renders. */
export function buildStyles(
  theme: ThemeLike,
  _compact: boolean,
): { styles: StyleMap; tones: Tones } {
  const palette = theme.colors;
  const tones = buildTones({
    surface0: palette.surface0,
    accent: palette.accent,
    statusSuccess: palette.statusSuccess,
    statusWarning: palette.statusWarning,
    statusDanger: palette.statusDanger,
  });
  const styles: StyleMap = {
    factAccent: { color: tones.accent, fontWeight: "600" as const },
    factOk: { color: tones.ok },
    factWarn: { color: tones.warn },
    factDanger: { color: tones.danger },
    actionsGrid: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8, marginTop: 4 },
    hint: { color: palette.foregroundMuted, fontSize: 11, lineHeight: 16 },
    button: {
      minHeight: 34,
      justifyContent: "center" as const,
      alignItems: "center" as const,
      paddingHorizontal: 12,
      borderRadius: 8,
      backgroundColor: "transparent",
      borderWidth: 1,
      borderColor: palette.border,
    },
    buttonPrimary: { backgroundColor: tones.accent, borderColor: tones.accent },
    buttonDanger: { backgroundColor: tones.danger, borderColor: tones.danger },
    buttonHover: { borderColor: tones.accent },
    buttonSmall: { minHeight: 28, paddingHorizontal: 10 },
    buttonText: { color: palette.foreground, fontSize: 12 },
    buttonTextOn: { color: tones.onAccent, fontSize: 12 },
    disabled: { opacity: 0.45 },
    pillPanel: { gap: 8 },
    pillHost: { color: palette.foregroundMuted, fontSize: 11, lineHeight: 16 },
    pillHead: {
      flexDirection: "row" as const,
      alignItems: "baseline" as const,
      justifyContent: "space-between" as const,
      gap: 8,
    },
    pillLabel: {
      color: palette.foregroundMuted,
      fontSize: 10,
      letterSpacing: 0.8,
      fontWeight: "600" as const,
    },
    pillCount: {
      color: palette.foregroundMuted,
      fontSize: 11,
      flexShrink: 1,
      textAlign: "right" as const,
    },
    pillTabs: { gap: 3 },
    pillTabRow: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 4,
      minHeight: 32,
      paddingVertical: 3,
      paddingLeft: 8,
      paddingRight: 4,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: "transparent",
    },
    pillTabOpen: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 8,
      flex: 1,
      minWidth: 0,
      paddingVertical: 3,
    },
    pillTabClose: {
      width: 24,
      height: 24,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      borderRadius: 6,
    },
    pillTabCloseActive: { backgroundColor: alpha(palette.foreground, 0.1) },
    pillTabCloseText: { color: palette.foregroundMuted, fontSize: 15, lineHeight: 16 },
    pillTabRowCurrent: { backgroundColor: palette.surface2, borderColor: palette.border },
    pillTabDot: { width: 7, height: 7, borderRadius: 4, flexShrink: 0 },
    pillTabDotRunning: { backgroundColor: tones.accent },
    pillTabDotUnread: { backgroundColor: tones.ok },
    pillTabDotInput: { backgroundColor: tones.warn },
    pillTabDotFailed: { backgroundColor: tones.danger },
    pillTabDotMuted: { backgroundColor: palette.foregroundMuted, opacity: 0.5 },
    pillTabTitle: { color: palette.foreground, fontSize: 12.5, flexGrow: 1, flexShrink: 1 },
    pillTabTitleCurrent: { fontWeight: "600" as const },
    pillTabMeta: { color: palette.foregroundMuted, fontSize: 11, flexShrink: 0 },
    pillButton: { flexBasis: "48%" as const, flexGrow: 1 },
    pillNote: { gap: 2, borderTopWidth: 1, borderTopColor: palette.border, paddingTop: 8 },
    noticeBlock: { gap: 2 },
    buildStamp: { color: palette.foregroundMuted, fontSize: 10, opacity: 0.8 },
  };
  return { styles, tones };
}

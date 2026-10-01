export interface PaletteLike {
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

export interface ThemeLike {
  colors: PaletteLike;
}

export type StyleMap = Record<string, any>;
export type FactTone = "quiet" | "accent" | "ok" | "warn" | "danger";

export interface TerminalInfo {
  count: number;
  busy: number;
  working: number;
  idle: number;
  rssBytes: number;
}

export interface Tones {
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

function readable(color: string, options: { minSaturation: number; lightness: number; fallbackHue: number }): string {
  const rgb = parseColor(color);
  if (!rgb) {
    return hsl(options.fallbackHue, options.minSaturation, options.lightness);
  }
  const { h, s } = toHsl(rgb);
  const hue = s < 0.12 ? options.fallbackHue : h;
  return hsl(hue, Math.max(s, options.minSaturation), options.lightness);
}

export function buildTones(input: {
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
    warn: readable(input.statusWarning, { minSaturation: 0.55, lightness: dark ? 0.66 : 0.42, fallbackHue: 35 }),
    danger: readable(input.statusDanger, { minSaturation: 0.5, lightness: bodyLightness, fallbackHue: 5 }),
    onAccent: dark ? "#10151c" : "#ffffff",
  };
}

export interface TreeMetrics {
  chevron: number;
}

export interface TreeRowProfile {
  paddingVertical: number;
  gap: number;
  titleLine: number;
  titleLineSmall: number;
  factsLine: number;
}

export function treeRowProfile(compact: boolean): TreeRowProfile {
  return compact
    ? { paddingVertical: 6, gap: 1, titleLine: 16, titleLineSmall: 15, factsLine: 14 }
    : { paddingVertical: 8, gap: 2, titleLine: 18, titleLineSmall: 17, factsLine: 16 };
}

export function treeMetrics(compact: boolean): TreeMetrics {
  return { chevron: compact ? 11 : 8 };
}

export function buildStyles(theme: ThemeLike, compact: boolean): { styles: StyleMap; tones: Tones } {
  const palette = theme.colors;
  const tones = buildTones({
    surface0: palette.surface0,
    accent: palette.accent,
    statusSuccess: palette.statusSuccess,
    statusWarning: palette.statusWarning,
    statusDanger: palette.statusDanger,
  });
  const tree = treeMetrics(compact);
  const row = treeRowProfile(compact);
  const styles: StyleMap = {
    screen: { flex: 1, backgroundColor: palette.surface0, padding: compact ? 12 : 18 },
    headline: { color: palette.foreground, fontSize: compact ? 15 : 16, fontWeight: "600" as const },
    subline: { color: palette.foregroundMuted, fontSize: 12, flexShrink: 1, lineHeight: 17 },
    hero: {
      borderRadius: 10,
      borderWidth: 1,
      borderColor: palette.border,
      backgroundColor: palette.surface1,
      padding: compact ? 10 : 12,
      gap: 6,
    },
    heroActions: {
      flexDirection: "row" as const,
      flexWrap: "wrap" as const,
      alignItems: "center" as const,
      justifyContent: "space-between" as const,
      gap: 8,
      marginTop: 2,
    },
    heroSettingsLabel: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
    heroSettingsHint: { color: palette.foregroundMuted, fontSize: 11, flexShrink: 1, flexGrow: 1 },
    heroButtons: {
      flexDirection: "row" as const,
      gap: 8,
      marginLeft: "auto" as const,
      flexBasis: compact ? ("100%" as const) : undefined,
      justifyContent: "flex-end" as const,
    },
    settingsPanel: {
      borderWidth: 1,
      borderColor: palette.border,
      borderRadius: 10,
      backgroundColor: palette.surface1,
      padding: compact ? 10 : 12,
      gap: 10,
      marginTop: 10,
    },
    dot: { width: 7, height: 7, borderRadius: 4 },
    dotOk: { backgroundColor: tones.ok },
    dotWarn: { backgroundColor: tones.warn },
    dotMuted: { backgroundColor: palette.foregroundMuted, opacity: 0.5 },
    body: {
      flex: 1,
      flexDirection: compact ? ("column" as const) : ("row" as const),
      gap: 12,
      marginTop: 12,
    },
    pane: {
      borderWidth: 1,
      borderColor: palette.border,
      borderRadius: 10,
      backgroundColor: palette.surface1,
      overflow: "hidden" as const,
      flex: 1,
    },
    paneTree: {
      borderWidth: 1,
      borderColor: palette.border,
      borderRadius: 10,
      backgroundColor: palette.surface1,
      overflow: "hidden" as const,
      flexGrow: 0,
      flexShrink: 0,
      flexBasis: 330,
    },
    paneScroll: { flex: 1 },
    paneContent: { padding: compact ? 8 : 10, gap: 2 },
    treeRow: {
      position: "relative" as const,
      borderRadius: 8,
      borderWidth: 0.5,
      borderColor: "transparent",
      paddingRight: 8,
      paddingLeft: 0,
      overflow: "hidden" as const,
    },
    treeRowProject: {
      backgroundColor: palette.surface2,
      borderColor: palette.border,
      marginTop: 3,
      marginBottom: 1,
    },
    treeRowNested: { backgroundColor: alpha(palette.foreground, 0.05) },
    treeRowSelected: { borderColor: tones.accent, backgroundColor: palette.surface2 },
    treeRowArchived: { opacity: 0.72 },
    treeBar: {
      width: tree.chevron,
      alignSelf: "stretch" as const,
      alignItems: "center" as const,
      justifyContent: "center" as const,
    },
    treeBarProject: { backgroundColor: tones.accent },
    treeBarWorkspace: { backgroundColor: alpha(palette.foregroundMuted, 0.3) },
    treeBarLabel: { fontSize: compact ? 10 : 8 },
    treeBarLabelProject: { color: tones.onAccent },
    treeBarLabelWorkspace: { color: palette.foreground },
    treeBarSpacer: { width: tree.chevron },
    treeRowBody: { flexDirection: "row" as const, flex: 1, gap: 4 },
    treeRowContent: {
      flex: 1,
      gap: row.gap,
      justifyContent: "center" as const,
      paddingVertical: row.paddingVertical,
    },
    treeRowInner: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
    treeLabel: {
      color: palette.foreground,
      fontSize: 13,
      lineHeight: row.titleLine,
      fontWeight: "600" as const,
      flexShrink: 1,
    },
    treeLabelProject: {
      fontSize: 12,
      lineHeight: row.titleLineSmall,
      fontWeight: "700" as const,
      letterSpacing: 0.2,
    },
    treeLabelWorkspace: { fontSize: 13, lineHeight: row.titleLine, fontWeight: "600" as const },
    treeLabelAgent: { fontSize: 12.5, lineHeight: row.titleLineSmall, fontWeight: "500" as const },
    treeLabelArchived: { color: palette.foregroundMuted, fontWeight: "500" as const },
    treeFacts: { color: palette.foregroundMuted, fontSize: 11, lineHeight: row.factsLine },
    treeCountBadge: {
      minWidth: 22,
      height: 18,
      paddingHorizontal: 6,
      borderRadius: 9,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      backgroundColor: palette.surface1,
      borderWidth: 1,
      borderColor: palette.border,
    },
    treeCountText: { color: palette.foregroundMuted, fontSize: 10.5, fontWeight: "600" as const },
    factAccent: { color: tones.accent, fontWeight: "600" as const },
    factOk: { color: tones.ok },
    factWarn: { color: tones.warn },
    factDanger: { color: tones.danger },
    actionsPaneContent: { padding: compact ? 12 : 14, gap: 10 },
    actionsHead: { gap: 4 },
    actionsTitle: { color: palette.foreground, fontSize: compact ? 15 : 16, fontWeight: "600" as const },
    actionsSub: { color: palette.foregroundMuted, fontSize: 12, lineHeight: 17 },
    actionsKind: { color: palette.foregroundMuted, fontSize: 10, letterSpacing: 0.8, fontWeight: "600" as const },
    actionsGrid: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8, marginTop: 4 },
    hint: { color: palette.foregroundMuted, fontSize: 11, lineHeight: 16 },
    infoRow: { flexDirection: "row" as const, gap: 8, alignItems: "baseline" as const },
    infoLabel: { color: palette.foregroundMuted, fontSize: 11, width: 74 },
    infoValue: { color: palette.foreground, fontSize: 12, flexShrink: 1, lineHeight: 17 },
    divider: { height: 1, backgroundColor: palette.border, marginVertical: 4 },
    terminalRow: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 8,
      paddingVertical: 4,
    },
    terminalText: { flex: 1, gap: 1 },
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
    buttonHalf: { flexBasis: "48%" as const, flexGrow: 1 },
    buttonSmall: { minHeight: 28, paddingHorizontal: 10 },
    buttonText: { color: palette.foreground, fontSize: 12 },
    buttonTextOn: { color: tones.onAccent, fontSize: 12 },
    disabled: { opacity: 0.45 },
    confirm: {
      borderWidth: 1,
      borderColor: tones.danger,
      borderRadius: 10,
      backgroundColor: palette.surface2,
      padding: 10,
      gap: 8,
    },
    confirmText: { color: palette.foreground, fontSize: 12, lineHeight: 17 },
    renamePanel: { borderWidth: 1, borderColor: tones.accent, borderRadius: 8, padding: 10, gap: 8 },
    renameInput: {
      minHeight: 36,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: palette.border,
      backgroundColor: palette.surface2,
      color: palette.foreground,
      paddingHorizontal: 10,
      fontSize: 13,
    },
    autoRow: {
      flexDirection: compact ? ("column" as const) : ("row" as const),
      flexWrap: "wrap" as const,
      alignItems: compact ? ("stretch" as const) : ("center" as const),
      justifyContent: "space-between" as const,
      gap: compact ? 6 : 12,
    },
    autoLabel: { color: palette.foreground, fontSize: 12, flexShrink: 1 },
    autoDivider: { height: 1, backgroundColor: palette.border, opacity: 0.6 },
    autoStatus: { color: palette.foregroundMuted, fontSize: 11, lineHeight: 16 },
    autoStatusWarn: { color: tones.danger, fontSize: 11, lineHeight: 16 },
    segment: {
      flexDirection: "row" as const,
      flexShrink: 1,
      alignSelf: compact ? ("stretch" as const) : ("auto" as const),
      borderRadius: 8,
      borderWidth: 1,
      borderColor: palette.border,
      overflow: "hidden" as const,
    },
    segmentItem: {
      flexGrow: 1,
      minHeight: 30,
      paddingHorizontal: compact ? 6 : 12,
      justifyContent: "center" as const,
      alignItems: "center" as const,
      borderLeftWidth: 1,
      borderLeftColor: palette.border,
    },
    segmentItemFirst: { borderLeftWidth: 0 },
    segmentItemActive: { backgroundColor: tones.accent },
    segmentText: { color: palette.foregroundMuted, fontSize: 12 },
    segmentTextActive: { color: tones.onAccent, fontSize: 12, fontWeight: "600" as const },
    chip: {
      minHeight: 28,
      paddingHorizontal: 10,
      justifyContent: "center" as const,
      alignItems: "center" as const,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: palette.border,
      backgroundColor: palette.surface1,
    },
    chipOn: { backgroundColor: tones.accent, borderColor: tones.accent },
    chipText: { color: palette.foreground, fontSize: 11 },
    chipTextOn: { color: tones.onAccent, fontSize: 11, fontWeight: "600" as const },
    warning: { color: tones.warn, fontSize: 12, lineHeight: 17 },
    empty: { color: palette.foregroundMuted, fontSize: 13, paddingVertical: 16, paddingHorizontal: 8 },
    footer: {
      color: palette.foreground,
      fontSize: 11,
      lineHeight: 16,
      padding: 10,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: palette.border,
      backgroundColor: palette.surface1,
    },
    popover: { maxWidth: 320, maxHeight: 360 },
    popoverContent: { padding: 12, gap: 8 },
    popoverList: { gap: 3 },
    buildStamp: { color: palette.foregroundMuted, fontSize: 10, opacity: 0.8 },
    footerRow: { gap: 8, marginTop: 10 },
    jobRow: { marginTop: 8 },
  };
  return { styles, tones };
}

export function factStyle(tone: FactTone, styles: StyleMap): StyleMap[string] {
  if (tone === "accent") return styles.factAccent;
  if (tone === "ok") return styles.factOk;
  if (tone === "warn") return styles.factWarn;
  if (tone === "danger") return styles.factDanger;
  return undefined;
}

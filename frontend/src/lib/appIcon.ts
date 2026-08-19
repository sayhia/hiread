// Official app-icon palettes. Night is the packaged default (Dock /
// installer). All four share the moon-and-book mark.

export const APP_ICONS = ["night", "dawn", "gold", "platinum"] as const;
export type AppIcon = (typeof APP_ICONS)[number];

export function isAppIcon(v: unknown): v is AppIcon {
  return typeof v === "string" && (APP_ICONS as readonly string[]).includes(v);
}

export function iconPng(v: AppIcon): string {
  return `/icons/${v}.png`;
}

export function iconSvg(v: AppIcon): string {
  return `/icons/${v}.svg`;
}

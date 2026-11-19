import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/ui";
import { View } from "react-native";
import { artwork, palette } from "./brand.generated";

export function scheme(theme: PluginTheme) {
  const color = theme.colors.surface0;
  const hex = /^#([a-f\d]{6})$/i.exec(color);
  const rgb = hex
    ? [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16))
    : (color.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
  return rgb.length === 3 && rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722 < 128 ? "dark" : "light";
}
export function clydeTheme(theme: PluginTheme): PluginTheme {
  const p = palette[scheme(theme)];
  return {
    colors: {
      surface0: p["paper-0"],
      surface1: p["paper-1"],
      surface2: p["paper-2"],
      border: p.rule,
      foreground: p.ink,
      foregroundMuted: p["ink-3"],
      accent: p.carbon,
      accentForeground: p["on-carbon"],
      statusSuccess: p.ok,
      statusWarning: p.warn,
      statusDanger: p.bad,
    },
  };
}
export function Lockup({ theme, width = 90 }: { theme: PluginTheme; width?: number }) {
  const height = width * 92 / 332;
  return (
    <View accessible accessibilityLabel="Clyde" style={{ width, height, overflow: "hidden", flexShrink: 0 }}>
      <View style={{ position: "absolute", top: (height - width) / 2, width, height: width }}>
        <Icon icon={artwork[scheme(theme)].lockup} size={width} color={theme.colors.foreground} />
      </View>
    </View>
  );
}

import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { waitRpc, type Status } from "../shared/clyde";

/** The design's palette, from scripts/gridposter.py: a strong stroke and a soft fill per meaning. */
export const PALETTE = {
  blue: { ink: "#2f5fd0", soft: "#eaf1ff" },
  amber: { ink: "#c86a12", soft: "#fff1e2" },
  green: { ink: "#1f8a45", soft: "#e8f6ec" },
  purple: { ink: "#6c46c8", soft: "#f1ecfb" },
  red: { ink: "#b91c1c", soft: "#fde8e8" },
  grey: { ink: "#9a9d96", soft: "#f0f0ec" },
};

const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
  "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];

/** "Four steps, eleven pieces": numbers up to twenty in words, as the design writes them. */
export function count(n: number, noun: string, capital = false): string {
  const word = WORDS[n] ?? String(n);
  const head = capital ? word[0].toUpperCase() + word.slice(1) : word;
  return `${head} ${noun}${n === 1 ? "" : "s"}`;
}

/** Running is blue, waiting on Wen is amber, sent back is amber too, passed is green, failed is red, pending is grey. */
export function hue(status: Status) {
  if (status === "running") return PALETTE.blue;
  if (status === "asking" || status === "sent-back") return PALETTE.amber;
  if (status === "passed" || status === "done") return PALETTE.green;
  if (status === "failed") return PALETTE.red;
  return PALETTE.grey;
}

export const STATUS_LABEL: Record<Status, string> = {
  running: "Running", asking: "Needs you", passed: "Passed", "sent-back": "Sent back", failed: "Failed",
  pending: "Pending", skipped: "Skipped", done: "Done",
};

export function Pill({ status, label }: { status: Status; label?: string }) {
  const h = hue(status);
  return (
    <View style={{ backgroundColor: h.soft, borderRadius: 5, paddingVertical: 3, paddingHorizontal: 6 }}>
      <Text style={{ color: h.ink, fontSize: 10, fontWeight: "700" }}>{label ?? STATUS_LABEL[status]}</Text>
    </View>
  );
}

export function Eyebrow({ theme, children }: { theme: PluginTheme; children: string }) {
  return <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10, letterSpacing: 1.2, fontWeight: "700" }}>{children.toUpperCase()}</Text>;
}

export function Ladder({ theme, level, label }: { theme: PluginTheme; level: string; label: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <View style={{ width: 22, height: 22, borderRadius: 5, backgroundColor: theme.colors.surface2, alignItems: "center", justifyContent: "center" }}>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10, fontWeight: "700" }}>{level}</Text>
      </View>
      <Eyebrow theme={theme}>{label}</Eyebrow>
    </View>
  );
}

export function ago(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "";
  const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (m < 1) return "just now";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h} hr ${m % 60} min` : `${Math.floor(h / 24)} d`;
}

/** How long something took, or has been going: "4 min", "1 hr 12 min". */
export function duration(from: string | undefined, to?: string, now = Date.now()): string {
  if (!from) return "";
  const m = Math.max(0, Math.round(((to ? Date.parse(to) : now) - Date.parse(from)) / 60_000));
  if (m < 1) return "under a minute";
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} hr ${m % 60} min`;
}

/** Long-polls the server's revision and refreshes every clyde query when the daemon's event stream moves. */
export function useLive(): number {
  const wait = useRpc(waitRpc);
  const client = useQueryClient();
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let stopped = false;
    let after = 0;
    (async () => {
      while (!stopped) {
        try {
          const { revision: next } = await wait({ after });
          if (stopped) return;
          if (next > after) {
            after = next;
            setRevision(next);
            void client.invalidateQueries({ queryKey: ["clyde"] });
          }
        } catch {
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
    })();
    return () => { stopped = true; };
  }, [wait, client]);
  return revision;
}

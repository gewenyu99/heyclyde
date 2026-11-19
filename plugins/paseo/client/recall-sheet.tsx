import type { PluginTheme } from "@getpaseo/plugin";
import { useState } from "react";
import { Pressable, ScrollView, Text, useWindowDimensions, View } from "react-native";
import { Lockup, scheme } from "./brand";
import { palette } from "./brand.generated";
import { usedFirst } from "../shared/recall";
import type { Activity } from "../shared/clyde";

export type Packet = Extract<Activity, { kind: "recall" }>;
export type Vote = "helpful" | "nothing_useful";
type Note = Packet["notes"][number];
type Paper = typeof palette[keyof typeof palette];

function noteState(n: Note, p: Paper) {
  if (n.superseded_by) return { label: "superseded", color: p["ink-3"] };
  if (n.trial) return { label: n.chance ? `on trial · ${n.chance} of 3` : "on trial", color: p.warn };
  if (n.confidence != null && n.confidence < 0.15) return { label: "dormant", color: p["ink-3"] };
  if (n.unreviewed != null || n.confidence != null) {
    return { label: n.unreviewed ? "agent-filed" : "settled", color: p.ok };
  }
}
function pen(name: string, p: Paper) {
  const pens = [
    p["pen-blue"],
    p["pen-red"],
    p["pen-green"],
    p["pen-violet"],
    p["pen-amber"],
    p["pen-teal"],
    p["pen-graphite"],
  ];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return pens[h % pens.length];
}
function Chip({ text, color, fill }: { text: string; color: string; fill: string }) {
  return (
    <View style={{ backgroundColor: fill, borderRadius: 3, paddingHorizontal: 6, paddingVertical: 3 }}>
      <Text style={{ fontFamily: "Menlo", fontSize: 10.5, letterSpacing: .6, color }}>{text.toUpperCase()}</Text>
    </View>
  );
}
function MemoryNote(
  { n, p, used, expanded, toggle, onOpen, compact }: {
    n: Note;
    p: Paper;
    used: boolean;
    expanded: boolean;
    toggle: () => void;
    onOpen?: (id: string) => Promise<string>;
    compact: boolean;
  },
) {
  const [detail, setDetail] = useState(""),
    [showDetail, setShowDetail] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function inspect() {
    if (showDetail) {
      setShowDetail(false);
      return;
    }
    if (detail) {
      setShowDetail(true);
      return;
    }
    if (!onOpen || busy) return;
    setBusy(true);
    try {
      setDetail(await onOpen(n.id));
      setError("");
      setShowDetail(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  const state = noteState(n, p), pct = n.confidence == null ? null : Math.round(n.confidence * 100);
  const origin = n.provenance?.match(/^from (\S+)(.*)$/);
  const kindColor = n.kind === "fact"
    ? p.ok
    : n.kind === "wen"
    ? p["carbon-ink"]
    : n.kind === "plan"
    ? p.warn
    : p["ink-2"];
  const kindFill = n.kind === "fact"
    ? p["ok-wash"]
    : n.kind === "wen"
    ? p["carbon-wash"]
    : n.kind === "plan"
    ? p["warn-wash"]
    : p["paper-2"];
  const meta = { fontFamily: "Menlo", fontSize: 11, color: p["ink-3"] } as const;
  const usedStamp = used
    ? (
      <View
        pointerEvents="none"
        style={{
          position: "absolute",
          top: 7,
          right: 10,
          zIndex: 1,
          transform: [{ rotate: "-5deg" }],
          borderWidth: 1.5,
          borderRadius: 3,
          borderColor: p.ok,
          backgroundColor: p["paper-1"],
          paddingHorizontal: 4,
          paddingVertical: 2,
        }}
      >
        <Text style={{ fontFamily: "Menlo", fontSize: 11, fontWeight: "700", color: p.ok }}>[USED]</Text>
      </View>
    )
    : null;
  return (
    <View
      style={{
        backgroundColor: p["paper-1"],
        borderWidth: 1,
        borderColor: p.rule,
        borderRadius: 9,
        paddingVertical: expanded ? 12 : 8,
        paddingHorizontal: expanded ? 16 : 12,
        gap: 7,
      }}
    >
      {usedStamp}
      {expanded
        ? (
          <>
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                flexWrap: "wrap",
                gap: 6,
                paddingRight: used ? 62 : 0,
              }}
            >
              {n.kind && (
                <Chip text={n.kind + (n.verified === false ? " · unverified" : "")} color={kindColor} fill={kindFill} />
              )}
              {[n.category, n.context].map((v, i) =>
                v && v !== "general" ? <Chip key={i} text={v} color={p["ink-2"]} fill={p["paper-2"]} /> : null
              )}
              {state && (
                <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                  <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: state.color }} />
                  <Text style={{ fontSize: 12, color: p["ink-2"] }}>{state.label}</Text>
                </View>
              )}
              {n.private && <Chip text="private" color={p["ink-2"]} fill={p["paper-2"]} />}
              {pct !== null && (
                <View style={{ marginLeft: "auto", flexDirection: "row", alignItems: "center", gap: 6 }}>
                  {!compact && (
                    <View style={{ width: 32, height: 4, backgroundColor: p["paper-2"] }}>
                      <View style={{ width: `${pct}%`, height: 4, backgroundColor: p["ink-2"] }} />
                    </View>
                  )}
                  <Text style={{ ...meta, fontWeight: "600", color: p["ink-2"] }}>{pct}% confidence</Text>
                </View>
              )}
            </View>
            <Text
              selectable
              style={{
                fontSize: 15,
                lineHeight: 21,
                fontWeight: "600",
                color: p.ink,
                textDecorationLine: n.superseded_by ? "line-through" : "none",
              }}
            >
              {n.title}
            </Text>
            {!!n.body && <Text selectable style={{ fontSize: 13, lineHeight: 19, color: p["ink-2"] }}>{n.body}</Text>}
            {!!n.quote && (
              <Text
                selectable
                style={{
                  backgroundColor: p["carbon-wash"],
                  borderLeftWidth: 2,
                  borderColor: p.carbon,
                  padding: 7,
                  color: p["carbon-ink"],
                  fontSize: 13,
                }}
              >
                “{n.quote}”
              </Text>
            )}
            {!!n.superseded_by && <Text style={meta}>Superseded by {n.superseded_by}</Text>}
            {!!n.provenance && (
              <Text style={meta}>
                {origin
                  ? (
                    <>
                      <Text>from</Text>
                      <Text style={{ fontWeight: "700", color: pen(origin[1], p) }}>{origin[1]}</Text>
                      {origin[2]}
                    </>
                  )
                  : n.provenance}
                {n.valid_from ? " · " + n.valid_from : ""}
              </Text>
            )}
            {!!n.artifacts?.length && (
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4 }}>
                {n.artifacts.map((a) => (
                  <Chip key={a.name} text={a.name + " · " + a.kind} color={p["ink-2"]} fill={p["paper-2"]} />
                ))}
              </View>
            )}
            <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 14 }}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={"Compact " + n.title}
                onPress={toggle}
                hitSlop={4}
              >
                <Text style={{ fontSize: 12, color: p["ink-2"] }}>Less ⌃</Text>
              </Pressable>
              {onOpen && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={"Open " + n.title}
                  disabled={busy}
                  onPress={() => void inspect()}
                  hitSlop={4}
                >
                  <Text style={{ fontSize: 12, color: p["ink-2"] }}>
                    {busy ? "Opening…" : showDetail ? "Close details" : "Open ↗"}
                  </Text>
                </Pressable>
              )}
            </View>
            {showDetail && (
              <Text selectable style={{ ...meta, borderTopWidth: 1, borderColor: p.rule, paddingTop: 8 }}>
                {detail}
              </Text>
            )}
            {!!error && <Text accessibilityRole="alert" style={{ color: p.bad }}>{error}</Text>}
          </>
        )
        : (
          <Pressable accessibilityRole="button" accessibilityState={{ expanded: false }} onPress={toggle}>
            <Text numberOfLines={1} style={{ fontWeight: "600", color: p.ink, paddingRight: used ? 62 : 0 }}>
              {n.title} ▾
            </Text>
          </Pressable>
        )}
    </View>
  );
}
export function RecallSheet(
  { theme, packet, onVote, onOpen }: {
    theme: PluginTheme;
    packet: Packet;
    onVote: (v: Vote) => Promise<{ pendingSync?: boolean }>;
    onOpen?: (id: string) => Promise<string>;
  },
) {
  const p = palette[scheme(theme)], viewport = useWindowDimensions();
  const [closed, setClosed] = useState<Set<string>>(new Set()), [width, setWidth] = useState(640);
  const [pending, setPending] = useState(false),
    [selected, setSelected] = useState<Vote>(),
    [queued, setQueued] = useState(false),
    [error, setError] = useState("");
  const choice = selected ?? packet.choice, used = new Set(packet.used ?? []), notes = usedFirst(packet.notes, used);
  const allOpen = notes.every((n) => !closed.has(n.id));
  async function vote(v: Vote) {
    if (pending || choice === v || !notes.length) return;
    setPending(true);
    try {
      const saved = await onVote(v);
      setSelected(v);
      setQueued(!!saved?.pendingSync);
      setError("");
    } catch (e) {
      setError(String(e));
    } finally {
      setPending(false);
    }
  }
  function action(label: string, v: Vote) {
    const active = choice === v, primary = choice ? active : v === "helpful";
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ selected: active, disabled: pending }}
        disabled={pending}
        onPress={() => void vote(v)}
        style={{
          paddingHorizontal: 11,
          paddingVertical: 6,
          borderRadius: 6,
          backgroundColor: primary ? p.ink : "transparent",
          borderBottomColor: p["carbon-copy"],
          borderBottomWidth: primary ? 2 : 0,
        }}
      >
        <Text style={{ fontSize: 12, fontWeight: "600", color: primary ? p["paper-1"] : p["ink-2"] }}>
          {active ? "✓ " : ""}
          {label}
        </Text>
      </Pressable>
    );
  }
  const badge = packet.badge;
  const heading = [
    packet.page === "more" ? "more" : "recall",
    packet.query ? "“" + packet.query + "”" : null,
    notes.length || null,
  ].filter(Boolean).join(" · ");
  return (
    <View
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      style={{
        width: "100%",
        maxWidth: 700,
        alignSelf: "flex-start",
        borderRadius: 10,
        borderWidth: 1,
        borderColor: p["rule-strong"],
        backgroundColor: p["paper-1"],
        overflow: "hidden",
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingVertical: 8,
          paddingHorizontal: 12,
          borderBottomWidth: 1,
          borderColor: p.rule,
        }}
      >
        <Lockup theme={theme} width={72} />
        <Text numberOfLines={1} style={{ flex: 1, color: p["ink-3"], fontSize: 13 }}>{heading}</Text>
        {badge && width > 400 && (
          <View style={{ maxWidth: "30%", flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Text
              style={{
                fontSize: 10,
                fontFamily: "Menlo",
                color: pen(badge.name, p),
                borderWidth: 1,
                borderColor: pen(badge.name, p),
                padding: 2,
                borderRadius: 3,
              }}
            >
              {badge.name.split(/[^a-z0-9]+/i).map((s) => s[0]).slice(0, 2).join("").toUpperCase()}
            </Text>
            <View style={{ flexShrink: 1 }}>
              <Text numberOfLines={1} style={{ fontSize: 12, color: p.ink, fontWeight: "600" }}>{badge.name}</Text>
              <Text numberOfLines={1} style={{ fontSize: 10, fontFamily: "Menlo", color: p["ink-3"] }}>
                {[badge.context, badge.surface].filter(Boolean).join(" · ")}
              </Text>
            </View>
          </View>
        )}
        {!!notes.length && (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: allOpen }}
            onPress={() =>
              setClosed(
                allOpen ? new Set(notes.map((n) => n.id)) : new Set(),
              )}
          >
            <Text style={{ fontSize: 12, color: p["ink-2"], fontWeight: "600" }}>
              {allOpen ? "Compact ⌃" : "Expand ▾"}
            </Text>
          </Pressable>
        )}
      </View>
      {!notes.length ? <Text style={{ padding: 12, color: p["ink-2"], fontSize: 13 }}>No matching notes.</Text> : (
        <>
          <ScrollView
            accessibilityLabel="Recalled notes"
            nestedScrollEnabled
            showsVerticalScrollIndicator
            persistentScrollbar
            style={{
              maxHeight: Math.max(160, Math.min(420, Math.floor(viewport.height * .48))),
              backgroundColor: p["paper-0"],
            }}
            contentContainerStyle={{ gap: 6, paddingHorizontal: 12, paddingVertical: 8 }}
          >
            {!!packet.degraded && <Text style={{ color: p.warn, fontSize: 12 }}>{packet.degraded}</Text>}
            {notes.map((n) => (
              <MemoryNote
                key={n.id}
                n={n}
                p={p}
                used={used.has(n.id)}
                expanded={!closed.has(n.id)}
                compact={width <= 460}
                onOpen={onOpen}
                toggle={() =>
                  setClosed((prev) => {
                    const next = new Set(prev);
                    if (next.has(n.id)) next.delete(n.id);
                    else next.add(n.id);
                    return next;
                  })}
              />
            ))}
          </ScrollView>
          {(!packet.used || packet.used.length > 0 || choice) && (
            <View
              style={{
                borderTopWidth: 1,
                borderColor: p.rule,
                paddingVertical: 8,
                paddingHorizontal: 12,
                flexDirection: "row",
                alignItems: "center",
                flexWrap: "wrap",
                gap: 8,
              }}
            >
              {action("That helped", "helpful")}
              {action("That didn’t", "nothing_useful")}
              {(choice || pending) && (
                <Text accessibilityLiveRegion="polite" style={{ fontSize: 12, color: p["ink-3"] }}>
                  {pending
                    ? "Saving…"
                    : (packet.choice === choice ? packet.pendingSync : queued)
                    ? "Saved on this host"
                    : "Feedback recorded"}
                </Text>
              )}
            </View>
          )}
          {!!error && <Text accessibilityRole="alert" style={{ padding: 8, color: p.bad, fontSize: 12 }}>{error}</Text>}
        </>
      )}
    </View>
  );
}

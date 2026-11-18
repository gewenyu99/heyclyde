import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { type Activity, feedbackRpc, respondRpc } from "../shared/clyde";

export function InlineActivity({ agentId, item, theme }: PluginTimelineItemProps<Activity>) {
  const data = item.data, c = theme.colors, feedback = useRpc(feedbackRpc), respond = useRpc(respondRpc);
  const [open, setOpen] = useState(true),
    [text, setText] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [votes, setVotes] = useState<Record<string, "used" | "irrelevant" | "wrong">>({});
  async function submit(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    try {
      await action();
      setError("");
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }
  const button = (label: string, onPress: () => void, active = false) => (
    <Pressable
      key={label}
      accessibilityRole="button"
      disabled={busy}
      onPress={onPress}
      style={{
        paddingHorizontal: 9,
        paddingVertical: 5,
        borderWidth: 1,
        borderColor: active ? c.accent : c.border,
        borderRadius: 6,
      }}
    >
      <Text style={{ color: active ? c.accent : c.foreground, fontSize: 12, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
  return (
    <View
      style={{
        borderLeftWidth: 3,
        borderLeftColor: data.kind === "approval" ? c.statusWarning : c.accent,
        paddingLeft: 12,
        paddingVertical: 5,
        gap: 7,
      }}
    >
      {data.kind === "notice"
        ? <Text style={{ color: c.foregroundMuted }}>{data.text}</Text>
        : data.kind === "saved"
        ? <Text style={{ color: c.foregroundMuted }}>Saved to Clyde · {data.title}</Text>
        : data.kind === "recall"
        ? (
          <>
            <>
              <Pressable
                accessibilityRole="button"
                onPress={() => setOpen(!open)}
              >
                <Text style={{ color: c.foreground, fontWeight: "600" }}>
                  {data.notes.length} {data.notes.length === 1 ? "memory" : "memories"} recalled {open ? "▴" : "▾"}
                </Text>
              </Pressable>
              {open && (
                <>
                  {data.notes.map((note) => (
                    <View key={note.id} style={{ gap: 5 }}>
                      <Text style={{ color: c.foreground }}>{note.title}</Text>
                      {note.body && <Text style={{ color: c.foregroundMuted }}>{note.body}</Text>}
                      {!data.rated && !data.native && (
                        <View style={{ flexDirection: "row", gap: 5, flexWrap: "wrap" }}>
                          {(["used", "irrelevant", "wrong"] as const).map((v, i) =>
                            button(["Useful", "Irrelevant", "Incorrect"][i], () =>
                              setVotes({ ...votes, [note.id]: v }), votes[note.id] === v)
                          )}
                        </View>
                      )}
                    </View>
                  ))}
                  {data.native ? <Text style={{color:c.foregroundMuted}}>Feedback uses the original Clyde tool session.</Text> : data.rated
                    ? <Text style={{ color: c.foregroundMuted }}>Feedback recorded</Text>
                    : (
                      <View style={{ flexDirection: "row", gap: 6 }}>
                        {Object.keys(votes).length === data.notes.length && data.notes.length > 0 &&
                          button("Save feedback", () =>
                            void submit(() =>
                              feedback({
                                agent: agentId,
                                retrieval: data.retrieval,
                                votes: Object.entries(votes).map(([entry_id, verdict]) => ({ entry_id, verdict })),
                              })
                            ))}
                        {button(
                          "None helped",
                          () =>
                            void submit(() => feedback({ agent: agentId, retrieval: data.retrieval, votes: [] })),
                        )}
                      </View>
                    )}
                </>
              )}
            </>
          </>
        )
        : (
          <>
            <Text style={{ color: c.foreground, fontWeight: "700" }}>{data.title}</Text>
            <Text style={{ color: c.foreground }}>{data.question}</Text>
            {data.answer ? <Text style={{ color: c.foregroundMuted }}>Answered · {data.answer}</Text> : (
              <>
                <TextInput
                  accessibilityLabel="Reply to Clyde"
                  placeholder="Reply or request changes"
                  value={text}
                  onChangeText={setText}
                  style={{ padding: 8, borderWidth: 1, borderColor: c.border, borderRadius: 6, color: c.foreground }}
                />
                <View style={{ flexDirection: "row", gap: 6 }}>
                  {data.approve && button(
                    "Approve",
                    () =>
                      void submit(() => respond({ agent: agentId, run: data.run, key: data.key, text: "approved" })),
                    true,
                  )}
                  {text.trim().length > 0 &&
                    button(
                      "Send reply",
                      () =>
                        void submit(() => respond({ agent: agentId, run: data.run, key: data.key, text })),
                    )}
                </View>
              </>
            )}
          </>
        )}
      {error.length > 0 && <Text style={{ color: c.statusDanger }}>{error}</Text>}
    </View>
  );
}

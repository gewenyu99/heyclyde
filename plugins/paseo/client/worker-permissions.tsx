import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { respondWorkerPermissionRpc, workerPermissionsRpc, type WorkerPermissions as WorkerPermissionsData } from "../shared/clyde";
import { formatRpcError, MIN_HIT_HEIGHT } from "./palette";

type Request = WorkerPermissionsData["requests"][number];

function PermissionRequest({ theme, request, runId, agentId, openAgent, onAnswered }: {
  theme: PluginTheme; request: Request; runId: string; agentId?: string;
  openAgent?: (id: string) => void; onAnswered: () => void;
}) {
  const c = theme.colors;
  const respond = useRpc(respondWorkerPermissionRpc);
  const locked = useRef(false);
  const [pending, setPending] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");
  async function answer(optionId: string) {
    if (!agentId || locked.current || submitted) return;
    locked.current = true; setPending(optionId); setError("");
    try {
      await respond({ runId, agentId, requestId: request.id, revision: request.revision, optionId });
      setSubmitted(true);
      onAnswered();
    } catch (e) { setError(formatRpcError(e)); }
    finally { locked.current = false; setPending(null); }
  }
  return <View style={{ gap: 8 }}>
    <Text accessibilityRole="header" style={{ color: c.foreground, fontSize: 15, fontWeight: "600", lineHeight: 22 }}>{request.title || request.name}</Text>
    {!!request.description && request.description !== request.title && <Text selectable style={{ color: c.foreground, fontSize: 13, lineHeight: 20 }}>{request.description}</Text>}
    {!!request.input && request.input !== request.description && <Text selectable style={{ color: c.foreground, backgroundColor: c.surface2, padding: 10, borderRadius: 6, fontFamily: "Menlo", fontSize: 12, lineHeight: 18 }}>{request.input}</Text>}
    {request.unsupported ? <View style={{ gap: 6 }}>
      <Text style={{ color: c.foregroundMuted, fontSize: 13, lineHeight: 20 }}>{request.unsupported}</Text>
      {(!agentId || !openAgent) && <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>Review this request in the worker’s Paseo chat.</Text>}
      {agentId && openAgent && <Pressable accessibilityRole="button" onPress={() => openAgent(agentId)} style={{ minHeight: MIN_HIT_HEIGHT, justifyContent: "center" }}>
        <Text style={{ color: c.accent, fontSize: 13, fontWeight: "600" }}>Review permission in Paseo</Text>
      </Pressable>}
    </View> : submitted ? <Text accessibilityLiveRegion="polite" style={{ color: c.foregroundMuted, fontSize: 13 }}>Permission answered. Waiting for the worker…</Text>
      : <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {request.options.map(option => {
          const disabled = pending !== null || !agentId;
          const primary = option.variant === "primary";
          const danger = option.variant === "danger";
          return <Pressable key={option.id} accessibilityRole="button" accessibilityLabel={option.label} accessibilityState={{ disabled }} disabled={disabled} onPress={() => void answer(option.id)} style={{ minHeight: MIN_HIT_HEIGHT, justifyContent: "center", paddingHorizontal: 12, borderRadius: 6, borderWidth: 1, borderColor: disabled ? c.border : danger ? c.statusDanger : primary ? c.accent : c.border, backgroundColor: primary && !disabled ? c.accent : c.surface1 }}>
            <Text style={{ color: disabled ? c.foregroundMuted : primary ? c.accentForeground : danger ? c.statusDanger : c.foreground, fontSize: 13, fontWeight: "600" }}>{pending === option.id ? "Sending…" : option.label}</Text>
          </Pressable>;
        })}
      </View>}
    {!!error && <Text accessibilityRole="alert" style={{ color: c.statusDanger, fontSize: 13, lineHeight: 20 }}>{error}</Text>}
  </View>;
}

export function WorkerPermissions({ theme, runId, openAgent, onPending, expected = false }: {
  theme: PluginTheme; runId: string; openAgent?: (id: string) => void; onPending: (id: string | null | undefined) => void; expected?: boolean;
}) {
  const read = useRpc(workerPermissionsRpc), cache = useQueryClient();
  const [answered, setAnswered] = useState(false);
  const query = useQuery({ queryKey: ["clyde", "worker-permissions", runId], queryFn: () => read({ runId }), refetchInterval: 3000, retry: false });
  const error = query.error ? formatRpcError(query.error) : query.data?.error;
  const pendingAgent = error || query.isPending ? undefined : query.data?.requests.length ? query.data.agentId : null;
  useEffect(() => {
    onPending(pendingAgent);
    return () => onPending(undefined);
  }, [pendingAgent, onPending]);
  function onAnswered() {
    setAnswered(true);
    void cache.invalidateQueries({ queryKey: ["clyde"] });
  }
  if (!error && !query.data?.requests.length && !answered && (!query.isPending || !expected)) return null;
  return <View style={{ gap: 12, paddingVertical: 6 }}>
    {query.isPending && expected && <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>Loading permission request…</Text>}
    {!!error && <View style={{ gap: 4 }}>
      <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger, fontSize: 13, lineHeight: 20 }}>{error}</Text>
      <Pressable accessibilityRole="button" accessibilityState={{ disabled: query.isFetching }} disabled={query.isFetching} onPress={() => void query.refetch()} style={{ minHeight: MIN_HIT_HEIGHT, justifyContent: "center" }}>
        <Text style={{ color: theme.colors.accent, fontSize: 13 }}>Retry loading permissions</Text>
      </Pressable>
    </View>}
    {!error && query.data?.requests.map(request => <PermissionRequest key={`${query.data?.agentId}:${request.id}:${request.revision}`} theme={theme} request={request} runId={runId} agentId={query.data?.agentId} openAgent={openAgent} onAnswered={onAnswered} />)}
    {!query.isPending && !error && !query.data?.requests.length && answered && <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>Permission answered. The worker can continue.</Text>}
  </View>;
}

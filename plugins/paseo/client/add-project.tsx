import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { openProjectRpc } from "../shared/clyde";
import { formatRpcError, MIN_HIT_HEIGHT } from "./palette";
import { requestId } from "./request-id";

export function AddProject({ theme, onSelected }: { theme: PluginTheme; onSelected: (id: string) => void }) {
  const [open, setOpen] = useState(false), [path, setPath] = useState("");
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const locked = useRef(false), pending = useRef<{ path: string; id: string } | null>(null);
  const register = useRpc(openProjectRpc), cache = useQueryClient(), c = theme.colors;
  async function submit() {
    const value = path.trim();
    if (!value || locked.current) return;
    locked.current = true; setBusy(true); setError("");
    if (pending.current?.path !== value) pending.current = { path: value, id: requestId() };
    try {
      const project = await register({path:value, requestId:pending.current.id});
      await cache.invalidateQueries({queryKey:["clyde","projects"]});
      onSelected(project.projectId);
    } catch (e) { setError(formatRpcError(e)); }
    finally { locked.current = false; setBusy(false); }
  }
  const button = (label:string, press:()=>void, disabled=false) => <Pressable accessibilityRole="button" accessibilityState={{disabled}} disabled={disabled} onPress={press} style={{minHeight:MIN_HIT_HEIGHT,justifyContent:"center",paddingHorizontal:8}}>
    <Text style={{color:disabled ? c.foregroundMuted : c.accent,fontSize:13,fontWeight:"600"}}>{label}</Text>
  </Pressable>;
  return open ? <View style={{gap:4,padding:8}}>
    <TextInput accessibilityLabel="Project folder path" autoCapitalize="none" autoCorrect={false} placeholder="Absolute path to a project folder" placeholderTextColor={c.foregroundMuted}
      editable={!busy} value={path} onChangeText={value=>{setPath(value);setError("");}} onSubmitEditing={()=>void submit()}
      style={{fontSize:14,color:c.foreground,backgroundColor:c.surface0,borderWidth:1,borderColor:c.border,borderRadius:6,padding:10}}/>
    <View style={{flexDirection:"row",gap:10}}>{button(busy?"Opening…":"Open project",()=>void submit(),busy||!path.trim())}{button("Cancel",()=>setOpen(false),busy)}</View>
    {!!error && <Text accessibilityRole="alert" style={{fontSize:13,color:c.statusDanger}}>{error}</Text>}
  </View> : button("Add a project folder…",()=>setOpen(true));
}

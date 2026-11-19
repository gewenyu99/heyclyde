import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { folderReposRpc, openProjectRpc } from "../shared/clyde";
import { formatRpcError, MIN_HIT_HEIGHT } from "./palette";
import { requestId } from "./request-id";

export function FolderRepositories({theme,projectId,onSelect}:{theme:PluginTheme;projectId:string;onSelect:(id:string)=>void}) {
  const list=useRpc(folderReposRpc), open=useRpc(openProjectRpc), cache=useQueryClient();
  const [filter,setFilter]=useState(""), [busy,setBusy]=useState(""), [error,setError]=useState("");
  const lock=useRef(false), pending=useRef<{path:string;id:string}|null>(null);
  const result=useQuery({queryKey:["clyde","folder-repositories",projectId],queryFn:()=>list({projectId}),retry:false});
  const c=theme.colors, term=filter.trim().toLowerCase();
  const rows=(result.data ?? []).filter(row=>[row.name,row.slug,row.path].some(value=>value.toLowerCase().includes(term)));
  async function select(repo: NonNullable<typeof result.data>[number]) {
    if(lock.current)return;
    if(repo.projectId){onSelect(repo.projectId);return;}
    lock.current=true;setBusy(repo.path);setError("");
    if(pending.current?.path!==repo.path)pending.current={path:repo.path,id:requestId()};
    try {
      const registered=await open({path:repo.path,requestId:pending.current.id});
      await cache.invalidateQueries({queryKey:["clyde","projects"]});
      await cache.invalidateQueries({queryKey:["clyde","folder-repositories",projectId]});
      onSelect(registered.projectId);
    }catch(err){setError(formatRpcError(err));}
    finally{lock.current=false;setBusy("");}
  }
  return <View style={{gap:6}}>
    <Text accessibilityRole="header" style={{color:c.foreground,fontSize:14,fontWeight:"600"}}>Choose a repository in this folder</Text>
    {(result.data?.length ?? 0)>5 && <TextInput accessibilityLabel="Find a repository in this folder" value={filter} onChangeText={setFilter} placeholder="Find a repository…" placeholderTextColor={c.foregroundMuted} autoCapitalize="none"
      style={{minHeight:MIN_HIT_HEIGHT,paddingHorizontal:10,borderWidth:1,borderColor:c.border,borderRadius:6,color:c.foreground,fontSize:14}}/>}
    {result.isPending && <Text style={{color:c.foregroundMuted,fontSize:13}}>Finding checkouts…</Text>}
    {!result.isPending && !result.error && !rows.length && <Text style={{color:c.foregroundMuted,fontSize:13}}>{term?"No matching repositories.":"No Git checkouts found in this folder."}</Text>}
    <ScrollView nestedScrollEnabled keyboardShouldPersistTaps="handled" style={{maxHeight:240}}>
      {rows.map(repo=><Pressable key={repo.path} accessibilityRole="button" disabled={!!busy} accessibilityState={{disabled:!!busy}} onPress={()=>void select(repo)}
        style={{minHeight:MIN_HIT_HEIGHT,justifyContent:"center",padding:8,borderBottomWidth:1,borderColor:c.border}}>
        <Text style={{fontSize:14,color:c.foreground,fontWeight:"600"}}>{busy===repo.path?"Opening…":repo.name}</Text>
        <Text selectable={false} style={{fontSize:12,color:c.foregroundMuted}}>{repo.path}</Text>
      </Pressable>)}
    </ScrollView>
    {(error || result.error) && <Text accessibilityRole="alert" style={{fontSize:13,color:c.statusDanger}}>{error || formatRpcError(result.error)}</Text>}
  </View>;
}

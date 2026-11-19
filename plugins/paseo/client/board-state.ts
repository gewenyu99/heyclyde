import { defineSettings } from "@getpaseo/plugin";
import { useSettings, type PluginTab } from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";
import { z } from "zod";
import { workerModels } from "../shared/clyde";

export const composerDraftSchema = z.object({
  project:z.string().default(""),folderProject:z.string().default(""),selectedWorkspace:z.string().default(""),chatId:z.string().default(""),text:z.string().default(""),
  flow:z.enum(["task","ship"]).default("task"),worker:z.enum(workerModels).default("auto"),
  doneWhen:z.string().default(""),showCriteria:z.boolean().default(false),allowNeon:z.boolean().default(false),
  mode:z.enum(["auto","manual"]).default("manual"),menu:z.enum(["project","workspace","chat","worker"]).nullable().default(null),routingNote:z.string().default(""),
  suggestion:z.object({projectId:z.string(),reason:z.string(),prompt:z.string(),revision:z.number(),catalogue:z.string()}).optional(),
  pendingRequest:z.object({key:z.string(),id:z.string()}).nullable().default(null),
});
export type ComposerDraft = z.infer<typeof composerDraftSchema>;
export const boardStateSchema = z.object({
  picked:z.string().default(""),tab:z.enum(["board","agents","quests"]).default("board"),newTask:z.boolean().default(false),
  mobilePane:z.enum(["task","chat"]).default("task"),composer:composerDraftSchema.default(()=>emptyComposer()),
  supervisorDrafts:z.record(z.string(),z.string()).default({}),openedTaskParam:z.string().optional(),modifiedAt:z.number().default(0),
});
export type BoardState = z.infer<typeof boardStateSchema>;
export function emptyComposer(auto=false):ComposerDraft { return composerDraftSchema.parse({mode:auto?"auto":"manual"}); }
export function emptyBoard(auto=false):BoardState { return boardStateSchema.parse({composer:emptyComposer(auto)}); }
const validTask=(value:unknown):value is string=>typeof value==="string" && /^(run|thread):[^:]+$/.test(value);
function tabValue(tab:PluginTab|undefined,auto:boolean):BoardState|undefined {
  if(validTask(tab?.state))return {...emptyBoard(auto),picked:tab.state};
  const parsed=boardStateSchema.safeParse(tab?.state);
  return parsed.success?parsed.data:undefined;
}
// A separate device document per host/surface/workspace avoids whole-document merge races across workspaces.
export function boardSettingsId(scope:string):string {
  let a=0x811c9dc5,b=0x9e3779b9;
  for(let i=0;i<scope.length;i++){a=Math.imul(a^scope.charCodeAt(i),16777619);b=Math.imul(b^scope.charCodeAt(i),2246822519);}
  return "board-state-"+(a>>>0).toString(16).padStart(8,"0")+(b>>>0).toString(16).padStart(8,"0");
}
export function boardSettings(scope:string,auto:boolean) {
  return defineSettings({id:boardSettingsId(scope),scope:"device",version:1,schema:z.object({scope:z.literal(scope).default(scope),board:boardStateSchema.default(()=>emptyBoard(auto))}).default({scope,board:emptyBoard(auto)})});
}
type Document={scope:string;board:BoardState};
type Driver={status:string;revision?:string;values?:Document;error?:string;saveError?:string|null;save:(values:Document,revision:string)=>Promise<boolean>;reload:()=>Promise<void>};
type Snapshot={value:BoardState;ready:boolean;error:string};

/** Keeps unsaved edits through unmounts and serializes revisioned writes; the device settings remain authoritative after reload. */
export class BoardStateSession {
  snapshot:Snapshot; listeners=new Set<()=>void>();
  private driver?:Driver; private tab?:PluginTab; private dirty=false; private writing=false; private attempted?:string;
  constructor(readonly scope:string,readonly auto=false){this.snapshot={value:emptyBoard(auto),ready:false,error:""};}
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  private emit(){for(const listener of this.listeners)listener();}
  observe(driver:Driver,tab?:PluginTab,initialTask?:string){
    this.driver=driver;this.tab=tab;
    if(driver.status!=="ready" || !driver.values || driver.values.scope!==this.scope){
      if(!this.snapshot.ready && driver.status!=="loading"){this.snapshot={...this.snapshot,error:driver.error||"Couldn’t restore Clyde state."};this.emit();}
      return;
    }
    const persisted=boardStateSchema.parse(driver.values.board);
    if(!this.snapshot.ready){
      const native=tabValue(tab,this.auto);
      let value=native && (native.modifiedAt>persisted.modifiedAt || (persisted.modifiedAt===0 && validTask(tab?.state)))?native:persisted;
      if(validTask(initialTask) && value.openedTaskParam!==initialTask)value={...value,picked:initialTask,tab:"board",openedTaskParam:initialTask,modifiedAt:Math.max(Date.now(),value.modifiedAt+1)};
      this.dirty=value!==persisted;
      this.snapshot={value,ready:true,error:""};this.emit();
      tab?.setState(JSON.parse(JSON.stringify(value)));
    }else if(validTask(initialTask) && this.snapshot.value.openedTaskParam!==initialTask){
      this.update({picked:initialTask,tab:"board",openedTaskParam:initialTask});
    }else if(!this.dirty && !this.writing && persisted.modifiedAt>this.snapshot.value.modifiedAt){
      this.snapshot={value:persisted,ready:true,error:""};this.emit();
    }
    void this.flush();
  }
  update=(change:Partial<BoardState>|((value:BoardState)=>BoardState))=>{
    if(!this.snapshot.ready)return;
    const previous=this.snapshot.value,next=typeof change==="function"?change(previous):{...previous,...change};
    const value={...next,modifiedAt:Math.max(Date.now(),previous.modifiedAt+1)};
    this.snapshot={value,ready:true,error:""};this.dirty=true;this.emit();
    this.tab?.setState(JSON.parse(JSON.stringify(value)));
    void this.flush();
  };
  retry=async()=>{this.attempted=undefined;await this.driver?.reload();void this.flush();};
  private async flush(){
    const driver=this.driver;
    if(this.writing || !this.dirty || !this.snapshot.ready || driver?.status!=="ready" || driver.revision===undefined || driver.revision===this.attempted)return;
    const value=this.snapshot.value;this.writing=true;this.attempted=driver.revision;
    let saved=false;
    try{saved=await driver.save({scope:this.scope,board:value},driver.revision);}
    catch{/* Older hosts may throw instead of returning false. */}
    if(saved){if(this.snapshot.value===value)this.dirty=false;if(this.snapshot.error){this.snapshot={...this.snapshot,error:""};this.emit();}}
    else{this.snapshot={...this.snapshot,error:driver.saveError||"Couldn’t save Clyde state. Your draft is still open."};this.emit();await driver.reload().catch(()=>{});}
    this.writing=false;
    // A successful save publishes a new revision through useSettings before the next queued write.
    if(this.driver?.revision!==this.attempted)void this.flush();
  }
}
const sessions=new Map<string,BoardStateSession>(),definitions=new Map<string,ReturnType<typeof boardSettings>>();
export function useBoardState(scope:string,auto:boolean,tab?:PluginTab,initialTask?:string){
  let definition=definitions.get(scope);if(!definition){definition=boardSettings(scope,auto);definitions.set(scope,definition);}
  const settings=useSettings(definition);
  let session=sessions.get(scope);if(!session){session=new BoardStateSession(scope,auto);sessions.set(scope,session);}
  const current=session;
  const [snapshot,setSnapshot]=useState(current.snapshot);
  useEffect(()=>{setSnapshot(current.snapshot);return current.subscribe(()=>setSnapshot(current.snapshot));},[current]);
  useEffect(()=>{current.observe(settings,tab,initialTask);},[current,settings,tab,initialTask]);
  return {...snapshot,set:current.update,retry:current.retry};
}

import type { PluginTheme } from "@getpaseo/plugin";
import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { Piece, Status, TaskView } from "../shared/clyde";
import { MIN_HIT_HEIGHT, STATUS_LABEL, tones } from "./palette";

export type FlowNode = { id:string; title:string; status?:Status; note?:string; piece?:Piece; stage?:string; observed:boolean };
export function orchestrationNodes(view:TaskView):FlowNode[] {
  const pieces=view.steps.flatMap(step=>step.pieces);
  const stageFor=(piece:Piece)=>piece.phases.find(phase=>["running","asking","sent-back","failed"].includes(phase.status))?.stage || piece.phases[0]?.stage;
  const actual=(piece:Piece,title=piece.title):FlowNode=>({id:piece.id,title,piece,stage:stageFor(piece),status:piece.status,observed:piece.phases.some(phase=>(view.attempts[phase.stage]?.length ?? 0)>0) || piece.status!=="pending"});
  const plan=pieces.find(piece=>piece.id==="PLAN" || piece.phases.some(phase=>/^plan(-\d+)?$/.test(phase.stage)));
  if (!plan) return pieces.map(piece=>actual(piece));
  const builds=pieces.filter(piece=>piece!==plan && !piece.phases.some(phase=>phase.stage==="review"));
  const review=pieces.find(piece=>piece.phases.some(phase=>phase.stage==="review"));
  return [actual(plan,"Plan"),
    {id:"approval-gate",title:"Approve",observed:!!view.planApproval || view.approve,status:view.planApproval || (view.approve?"asking":undefined),note:view.planApproval==="passed"?"Plan approved":view.planApproval==="sent-back"?"Changes requested":view.approve?"Your approval is needed":"Approval gate"},
    ...(builds.length ? builds.map(piece=>actual(piece,`Build · ${piece.title}`)) : [{id:"future-build",title:"Build",observed:false,note:"Slices appear after planning"}]),
    review?actual(review,"Review"):{id:"future-review",title:"Review",observed:false,note:"After the build"},
  ];
}
const NODE_W=186,NODE_H=120,GAP_X=30,GAP_Y=32;
export function flowLayout(count:number,available:number,compact=false) {
  const columns=Math.min(count,available>=640?4:available>=480?3:available>=310?2:1);
  const nodeHeight=compact?84:NODE_H;
  const nodeWidth=Math.max(132,Math.min(NODE_W,Math.floor((available-GAP_X*(columns-1))/columns)));
  const positions=Array.from({length:count},(_,i)=>{const row=Math.floor(i/columns),col=i%columns;return {x:(row%2?columns-1-col:col)*(nodeWidth+GAP_X),y:row*(nodeHeight+GAP_Y)};});
  return {positions,nodeWidth,nodeHeight,width:columns*(nodeWidth+GAP_X)-GAP_X,height:Math.ceil(count/columns)*(nodeHeight+GAP_Y)-GAP_Y};
}
export function OrchestrationFlow({theme,view,selectedStage,onSelect}:{theme:PluginTheme;view:TaskView;selectedStage?:string;onSelect:(stage:string)=>void}) {
  const [width,setWidth]=useState(620),nodes=orchestrationNodes(view),layout=flowLayout(nodes.length,width,nodes.length===1 && !nodes[0]?.note),c=theme.colors,t=tones(theme);
  if (!nodes.length) return null;
  return <View onLayout={event=>setWidth(event.nativeEvent.layout.width)} style={{gap:8}}>
    <ScrollView horizontal contentContainerStyle={{paddingVertical:2}}>
      <View accessibilityLabel="Orchestration workflow" style={{width:layout.width,height:layout.height}}>
        {nodes.slice(1).map((node,i)=>{
          const from=layout.positions[i],to=layout.positions[i+1],horizontal=from.y===to.y;
          const color=node.status==="running"||node.status==="asking"||node.status==="sent-back"?c.accent:c.border;
          const x=horizontal?Math.min(from.x,to.x)+layout.nodeWidth:from.x+layout.nodeWidth/2;
          const y=horizontal?from.y+layout.nodeHeight/2:from.y+layout.nodeHeight;
          return <View key={"edge-"+node.id} pointerEvents="none" style={{position:"absolute",left:x,top:y,width:horizontal?GAP_X:1,height:horizontal?1:GAP_Y,borderTopWidth:horizontal?1:0,borderLeftWidth:horizontal?0:1,borderColor:color}}>
            <Text style={{position:"absolute",left:horizontal?GAP_X/2-6:-6,top:horizontal?-9:GAP_Y/2-9,color:c.foregroundMuted,fontSize:12,backgroundColor:c.surface1}}>{horizontal?(to.x>from.x?"→":"←"):"↓"}</Text>
          </View>;
        })}
        {nodes.map((node,i)=>{
          const selected=!!selectedStage && !!node.piece?.phases.some(phase=>phase.stage===selectedStage),position=layout.positions[i];
          const status=node.status?STATUS_LABEL[node.status]:"Planned";
          const ink=node.status==="failed"?c.statusDanger:node.status==="asking"||node.status==="sent-back"?t.amber.ink:node.status==="running"?c.accent:node.status==="passed"||node.status==="done"?t.green.ink:c.foregroundMuted;
          const body=<>
            <Text numberOfLines={2} style={{color:c.foreground,fontSize:14,lineHeight:19,fontWeight:"600"}}>{node.title}</Text>
            <Text style={{color:ink,fontSize:12}}>{status}</Text>
            {!!node.note && <Text numberOfLines={2} style={{color:c.foregroundMuted,fontSize:12,lineHeight:16}}>{node.note}</Text>}
          </>;
          const style={position:"absolute" as const,left:position.x,top:position.y,width:layout.nodeWidth,height:layout.nodeHeight,minHeight:MIN_HIT_HEIGHT,padding:12,gap:5,borderRadius:8,borderWidth:selected?2:1,borderStyle:node.observed?"solid" as const:"dashed" as const,borderColor:selected?c.accent:c.border,backgroundColor:selected?c.surface2:c.surface1};
          return node.stage?<Pressable key={node.id} accessibilityRole="button" accessibilityLabel={`${node.title}, ${status}`} accessibilityState={{selected}} onPress={()=>onSelect(node.stage!)} style={style}>{body}</Pressable>:<View key={node.id} accessibilityLabel={`${node.title}, ${status}`} style={style}>{body}</View>;
        })}
      </View>
    </ScrollView>
  </View>;
}

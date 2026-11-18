import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { Text, View } from "react-native";
import {nativeRecall} from "./shared/recall";
import {InlineActivity} from "./client/inline";
import {activitySchema,recallRpc} from "./shared/clyde";
import {clydeIcon} from "./client/icon";
import { Sidecar } from "./client/sidecar";
import { ClydeScreen } from "./client/screen";
import { PALETTE, useLive } from "./client/nodes";
import { homeRpc } from "./shared/clyde";

function Badge({ n, tone }: { n: number; tone: { ink: string; soft: string } }) {
  if (!n) return null;
  return (
    <View style={{ minWidth: 19, height: 19, paddingHorizontal: 5, borderRadius: 5, backgroundColor: tone.soft, alignItems: "center", justifyContent: "center" }}>
      <Text style={{ color: tone.ink, fontSize: 10, fontWeight: "700" }}>{n}</Text>
    </View>
  );
}

/** Clyde in the sidebar: amber counts what needs Wen, blue counts what's running. */
function ClydeItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  useLive();
  const read = useRpc(homeRpc);
  const q = useQuery({ queryKey: ["clyde", "home"], queryFn: () => read({}), refetchInterval: 15_000 });
  const home = q.data?.data;
  return (
    <SidebarRow
      icon={clydeIcon}
      label="Clyde"
      active={currentScreen?.screenId === "clyde"}
      onPress={() => openScreen({ screenId: "clyde" })}
      trailing={home ? (
        <View style={{ flexDirection: "row", gap: 4 }}>
          <Badge n={home.needsYou.length} tone={PALETTE.amber} />
          <Badge n={home.running} tone={PALETTE.blue} />
        </View>
      ) : null}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  client.addTimelineTransformer({id:"native-clyde-recall",query:{itemType:"tool_call"},transform:({item})=>{
    if(item.status!=="completed")return;
    const result=item.detail.type==="unknown"?item.detail.output:item.detail.type==="plain_text"?item.detail.text:undefined;
    const packet=nativeRecall(item.name,result);
    if(packet)return {items:[{type:"plugin",kind:"clyde-activity",version:1,data:{kind:"recall",retrieval:packet.retrieval_id,notes:packet.items,rated:false,native:true}}]};
  }});
  client.addTimelineRenderer({kind:"clyde-activity",version:1,schema:activitySchema,Component:InlineActivity});
  client.addSlashCommand({name:"clyde-recall",context:"agent",description:"Recall Clyde memory in this chat",argumentHint:"what to recall",onSubmit:async ctx=>{await ctx.rpc(recallRpc,{agent:ctx.agent.id,query:ctx.args.trim()||"Recent decisions for this project"});}});
  client.addWorkspacePanel({id:"board",title:"Clyde",icon:clydeIcon,locations:["workspace","explorer"],Component:Sidecar});
  client.addAgentPanel({id:"chat-board",title:"Clyde quests",icon:clydeIcon,locations:["explorer"],Component:Sidecar});
  client.addSlashCommand({name:"clyde",context:"agent",description:"Open Clyde beside this chat",argumentHint:"",onSubmit:ctx=>ctx.openPanel("chat-board",{location:"explorer"})});
  client.addCommandCenterItem({id:"beside-chat",icon:clydeIcon,title:"Open Clyde beside chat",context:"workspace",onSelect:ctx=>ctx.openPanel("board",{location:"explorer"})});
  client.addScreen({ id: "clyde", title: "Clyde", Component: ClydeScreen });
  client.addSidebarHeaderItem({ id: "clyde", title: "Clyde", Component: ClydeItem });
  return () => {};
}

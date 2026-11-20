/** Runs under the installed Paseo CLI runtime, using the same authenticated daemon connection as the CLI. */
import {createHash} from 'node:crypto'
import {join} from 'node:path'
import {realpathSync} from 'node:fs'
import {pathToFileURL} from 'node:url'
const [dist]=process.argv.slice(2)
const load=path=>import(pathToFileURL(join(dist,path)).href)
const input=JSON.parse(await new Promise(resolve=>{let data='';process.stdin.on('data',chunk=>data+=chunk);process.stdin.on('end',()=>resolve(data))}))
let client, child, aborted=false, ownedTurnId, unsubscribe
async function stop(){
  aborted=true
  if(child && client){
    await child.refresh().catch(()=>{})
    const active=child.current?.()?.activeTurn?.turnId
    if(!ownedTurnId || !active || active===ownedTurnId)await client.cancelAgent(child.id).catch(()=>{})
  }
}
// Stage workers in a run share one durable private workspace, even when two start together.
async function workerWorkspace(api, owner) {
  if (!owner.workspaceId) throw Error('The originating Paseo agent has no workspace')
  const origin = api.workspaces.ref(owner.workspaceId)
  await origin.refresh()
  if (!origin.projectId || !origin.directory) throw Error('The originating Paseo workspace is unavailable')

  const path = realpathSync(input.cwd)
  if (realpathSync(origin.directory) === path) return origin

  const key = 'clyde-workspace:' + JSON.stringify([origin.projectId, path, input.run ?? input.thread])
  const workspaceId = 'wks_' + createHash('sha256').update(key).digest('hex').slice(0, 16)
  let workspace = api.workspaces.ref(workspaceId)
  if (!(await workspace.refresh())) {
    workspace = await api.workspaces.create({
      workspaceId,
      idempotencyKey: workspaceId,
      source: { kind: 'directory', path, projectId: origin.projectId },
      callerAgentId: input.parent,
      background: true,
      title: input.taskTitle,
    })
  }
  if (workspace.id !== workspaceId || workspace.projectId !== origin.projectId || !workspace.current()?.background ||
      !workspace.directory || realpathSync(workspace.directory) !== path) {
    throw Error('Paseo worker workspace placement does not match the originating project and isolated worktree')
  }
  return workspace
}

process.on('SIGINT',stop)
process.on('SIGTERM',stop)
try{
  const {selectDaemonTarget}=await load('utils/daemon-target.js')
  const {connectToDaemon}=await load('utils/client.js')
  const {createPaseoApi}=await load('../../client/dist/index.js')
  client=await connectToDaemon({target:selectDaemonTarget({},process.env,false)})
  const api=createPaseoApi(client), parent=api.agents.ref(input.parent)
  let owner
  if(input.first){
    await parent.refresh()
    owner=parent.current()
    if(!owner || owner.archivedAt)throw Error('The originating Paseo agent is unavailable')
  }
  const FULL_ACCESS_MODE={claude:'bypassPermissions',codex:'full-access',antigravity:'full-access'}
  const FALLBACK_MODE={claude:'auto',codex:'auto-review'}
  const inherited=owner?.provider===input.backend ? owner.currentModeId : undefined
  let modeId=FULL_ACCESS_MODE[input.backend] ?? inherited
  if(input.memoryTask && input.first){
    const page=await parent.timeline.refetch({direction:'tail',limit:200})
    const missed=page.entries.map(e=>e.item).filter(i=>i.type==='plugin' && i.pluginId==='clyde' && i.data?.kind==='recall' &&
      (!i.data.notes?.length || i.data.choice==='nothing_useful')).map(i=>i.data.query).filter(q=>typeof q==='string'&&q.trim()).slice(-12)
    input.prompt += '\nRecent recall misses visible in the originating chat: '+JSON.stringify([...new Set(missed)])+
      '\nAn empty list means no missed query was recorded in the visible timeline window. Do not invent missing facts.'
  }
  if(aborted)throw Error('Cancelled before launch')
  if(input.first){
    const workspace=await workerWorkspace(api,owner)
    const createWith=mode=>workspace.agents.create({agentId:input.id,idempotencyKey:input.id,parent:input.parent,
      title:input.title,env:input.env,labels:{'clyde.run':input.run,'clyde.thread':input.thread},background:true,
      config:{provider:input.backend+'/'+input.model,...(mode?{modeId:mode}:{}),...(input.thinking && input.backend!=='antigravity'?{thinkingOptionId:input.thinking}:{}),systemPrompt:input.system},
    })
    try{
      child=await createWith(modeId)
    }catch(err){
      const fallback=FALLBACK_MODE[input.backend]
      if(fallback && fallback!==modeId && /mode/i.test(String(err))){
        child=await createWith(fallback)
      }else{
        throw err
      }
    }
  }else{
    child=api.agents.ref(input.id)
  }
  await child.refresh()
  const initial=child.current()
  if(!initial || initial.archivedAt || initial.provider!==input.backend || initial.labels?.['clyde.run']!==input.run || initial.labels?.['clyde.thread']!==input.thread || !child.cwd || realpathSync(child.cwd)!==realpathSync(input.cwd))throw Error('Paseo worker placement or ownership does not match the run worktree')
  if(initial.activeTurn || initial.pendingPermissions?.length)throw Error('Paseo worker already has an active turn or permission request')
  if(aborted){await stop();throw Error('Cancelled')}

  // Subscribe before sending so even a fast completion is bound to this exact outbound message.
  let sent=false, ownMessage=false, completed=false, failure, lastMessage='', activity='', lastProgress='', previousStatus='queued'
  const pollMs=Math.min(1500,Math.max(10,Number(process.env.CLYDE_PASEO_POLL_MS)||1500))
  const emit=(status,snapshot)=>{
    const requestIds=(snapshot.pendingPermissions??[]).map(p=>p.id)
    const state={agentId:child.id,status,permissionPending:status==='permission',observedAt:new Date().toISOString(),messageId:input.messageId,
      ...(ownedTurnId?{turnId:ownedTurnId}:{}),requestIds,...(activity?{activity}:{}),...(failure?{error:failure}:{})}
    console.log(JSON.stringify({workerState:state}))
    const progress=status==='permission' ? 'Permission requested in Paseo worker '+child.id
      : status==='active' ? (previousStatus==='permission' ? 'Paseo worker resumed after permission request' : 'Paseo worker active'+(activity?' · '+activity:''))
      : status==='queued' ? 'Paseo worker queued for its turn' : status==='idle' ? 'Paseo worker finished its turn' : 'Paseo worker error: '+failure
    if(progress!==lastProgress){console.log(JSON.stringify({progress}));lastProgress=progress}
    previousStatus=status
  }
  const bind=id=>{
    if(!id)return
    if(ownedTurnId && ownedTurnId!==id){if(!completed)failure='Paseo worker changed turns before the requested turn completed';return}
    ownedTurnId=id
  }
  const observe=(item,turnId)=>{
    if(item.type==='user_message'){
      if(item.clientMessageId===input.messageId || item.messageId===input.messageId){ownMessage=true;bind(turnId)}
      return
    }
    if(!ownMessage || (turnId && ownedTurnId && turnId!==ownedTurnId) || (completed && turnId!==ownedTurnId))return
    if(item.type==='assistant_message' && item.text?.trim()){lastMessage=item.text;activity=item.text.replace(/\s+/g,' ').slice(0,250)}
    else if(item.type==='tool_call')activity='Using '+(item.name||'tool')
    else if(item.type==='todo')activity=item.items.find(i=>i.status==='in_progress')?.activeForm || item.items.find(i=>i.status==='in_progress')?.text || activity
    else if(item.type==='reasoning')activity='Considering the task'
  }
  unsubscribe=child.timeline.subscribe(({agentId,event})=>{
    if(agentId!==child.id || !sent)return
    if(event.type==='timeline')observe(event.item,event.turnId)
    else if(event.type==='turn_started')bind(event.turnId)
    else if(['turn_completed','turn_failed','turn_canceled'].includes(event.type) && ownMessage && (!event.turnId || event.turnId===ownedTurnId)){
      if(event.type==='turn_completed')completed=true
      else failure=event.error || event.reason || 'Paseo worker turn failed'
    }
  })
  await unsubscribe.ready
  sent=true
  await child.send(input.prompt,{messageId:input.messageId})
  console.log(JSON.stringify({started:child.id}))
  let remaining=input.timeoutMs,lastTick=Date.now(),wasPermission=false
  while(!aborted){
    await child.refresh()
    const snapshot=child.current()
    if(!snapshot || snapshot.archivedAt)throw Error('Paseo worker became unavailable')
    if(snapshot.activeTurn?.turnId)bind(snapshot.activeTurn.turnId)
    if(!ownedTurnId || (!snapshot.activeTurn && snapshot.status==='idle' && !completed)){
      const page=await child.timeline.refetch({direction:'tail',limit:1,wholeTurns:true})
      for(const entry of page.entries)observe(entry.item,entry.turnId)
      // A refreshed idle snapshot and exact-turn assistant response recover missed completion events.
      if(ownMessage && ownedTurnId && !snapshot.activeTurn && snapshot.status==='idle' && !snapshot.pendingPermissions?.length && lastMessage)completed=true
    }
    const now=Date.now(),permission=!!snapshot.pendingPermissions?.length
    // User approval time is unbounded; only execution/queue time spends this turn's budget.
    if(!wasPermission && !permission)remaining-=now-lastTick
    lastTick=now;wasPermission=permission
    if(completed){emit('idle',{...snapshot,pendingPermissions:[]});break}
    if(snapshot.status==='error' || snapshot.status==='closed')failure=snapshot.lastError || 'Paseo worker '+snapshot.status
    if(failure){emit('error',snapshot);throw Error(failure)}
    if(permission){emit('permission',snapshot)}
    else if(snapshot.activeTurn){emit('active',snapshot)}
    else emit('queued',snapshot)
    if(remaining<=0){await stop();throw Error('Paseo worker active execution timed out after '+input.timeoutMs+' ms')}
    await new Promise(resolve=>setTimeout(resolve,pollMs))
  }
  if(aborted)throw Error('Paseo worker was stopped')
  // Timeline subscriptions can deliver message deltas. The stored turn contains the complete reply.
  if (!ownedTurnId || !ownMessage) throw Error('Could not identify the completed Paseo turn for this message.')
  lastMessage = ''
  for (let retry = 0; retry < 3 && !lastMessage && !aborted; retry++) {
    if (retry) await new Promise(resolve => setTimeout(resolve, 200 * retry))
    let page = await child.timeline.refetch({direction:'tail', limit:32, wholeTurns:true})
    const seenCursors = new Set()
    while (!aborted) {
      const turn = page.entries.filter(entry => entry.turnId === ownedTurnId)
      if (turn.length) {
        const user = turn.find(entry => entry.item.type === 'user_message' &&
          (entry.item.clientMessageId === input.messageId || entry.item.messageId === input.messageId))
        const reply = turn.findLast(entry => entry.item.type === 'assistant_message' && entry.item.text?.trim())
        if (user && reply) lastMessage = reply.item.text
        break
      }
      if (!page.hasOlder || !page.startCursor || !page.entries.length || page.staleCursor) break
      const cursorKey = JSON.stringify(page.startCursor)
      if (seenCursors.has(cursorKey)) break
      seenCursors.add(cursorKey)
      page = await child.timeline.refetch({direction:'before', cursor:page.startCursor, limit:32, wholeTurns:true})
    }
  }
  if (aborted) throw Error('Paseo worker was stopped')
  if (!lastMessage) throw Error('Paseo finished but its saved turn has no complete response for the requested message.')
  console.log(JSON.stringify({ok:true,text:lastMessage}))

}catch(e){console.log(JSON.stringify({ok:false,error:e.message||String(e)}));process.exitCode=1}
finally{unsubscribe?.();await client?.close().catch(()=>{})}

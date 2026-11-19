/** Runs under the installed Paseo CLI runtime, using the same authenticated daemon connection as the CLI. */
import {createHash} from 'node:crypto'
import {join} from 'node:path'
import {realpathSync} from 'node:fs'
import {pathToFileURL} from 'node:url'
const [dist]=process.argv.slice(2)
const load=path=>import(pathToFileURL(join(dist,path)).href)
const input=JSON.parse(await new Promise(resolve=>{let data='';process.stdin.on('data',chunk=>data+=chunk);process.stdin.on('end',()=>resolve(data))}))
let client, child, aborted=false
async function stop(){
  aborted=true
  if(child && client)await client.cancelAgent(child.id).catch(()=>{})
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
  await parent.refresh()
  const owner=parent.current()
  if(!owner || owner.archivedAt)throw Error('The originating Paseo agent is unavailable')
  const inherited=owner.provider===input.backend ? owner.currentModeId : undefined
  let modeId=inherited ?? ({codex:'auto-review',claude:'auto'})[input.backend]
  if(input.backend==='antigravity'){
    if(inherited!=='full-access' && !input.allowFullAccess)throw Error('Permission required: allow Antigravity full access for this run to launch its Paseo worker.')
    modeId='full-access'
  }
  if(input.memoryTask){
    const page=await parent.timeline.refetch({direction:'tail',limit:200})
    const missed=page.entries.map(e=>e.item).filter(i=>i.type==='plugin' && i.pluginId==='clyde' && i.data?.kind==='recall' &&
      (!i.data.notes?.length || i.data.choice==='nothing_useful')).map(i=>i.data.query).filter(q=>typeof q==='string'&&q.trim()).slice(-12)
    input.prompt += '\nRecent recall misses visible in the originating chat: '+JSON.stringify([...new Set(missed)])+
      '\nAn empty list means no missed query was recorded in the visible timeline window. Do not invent missing facts.'
  }
  if(aborted)throw Error('Cancelled before launch')
  if(input.first){
    const workspace=await workerWorkspace(api,owner)
    child=await workspace.agents.create({agentId:input.id,idempotencyKey:input.id,parent:input.parent,
      title:input.title,env:input.env,labels:{'clyde.run':input.run,'clyde.thread':input.thread},background:true,
      config:{provider:input.backend+'/'+input.model,modeId,...(input.thinking && input.backend!=='antigravity'?{thinkingOptionId:input.thinking}:{}),systemPrompt:input.system},
    })
  }else{
    child=api.agents.ref(input.id)
  }
  await child.refresh()
  if(!child.cwd || realpathSync(child.cwd)!==realpathSync(input.cwd))throw Error('Paseo worker placement does not match the run worktree')
  if(aborted){await stop();throw Error('Cancelled')}
  await child.send(input.prompt,{clientMessageId:input.messageId})
  console.log(JSON.stringify({started:child.id}))
  const deadline=Date.now()+input.timeoutMs
  let result=await child.waitForFinish(input.timeoutMs)
  while(result.status==='permission' && !aborted && Date.now()<deadline){
    console.log(JSON.stringify({progress:'Permission requested in Paseo worker '+child.id}))
    do {
      await new Promise(resolve=>setTimeout(resolve,1500))
      await child.refresh()
    }while(child.pendingPermissions?.length && !aborted && Date.now()<deadline)
    if(aborted || Date.now()>=deadline){await stop();throw Error('Paseo worker stopped while awaiting permission')}
    result=await child.waitForFinish(Math.max(1,deadline-Date.now()))
  }
  if(result.status!=='idle'){
    if(result.status==='timeout')await stop()
    throw Error(result.error || ('Paseo worker '+result.status))
  }
  let text=result.lastMessage
  if(!text){
    const page=await child.timeline.refetch({direction:'tail',limit:1,wholeTurns:true})
    text=page.entries.filter(e=>e.item.type==='assistant_message').map(e=>e.item.text).at(-1)
  }
  if(!text?.trim())throw Error('Paseo worker finished without a response')
  console.log(JSON.stringify({ok:true,text}))
}catch(e){console.log(JSON.stringify({ok:false,error:e.message||String(e)}));process.exitCode=1}
finally{await client?.close().catch(()=>{})}

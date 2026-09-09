export type RunLifecycle = 'queued' | 'preparing' | 'compiling' | 'running' | 'verifying' | 'cancelling' | 'completed' | 'failed' | 'cancelled';
export type RunOutcome = 'pass' | 'fail' | 'inconclusive' | null;
export const MAX_AGENT_TIMEOUT_MS = 15 * 60_000;

export type VerificationSpec = {id:string;command:string;timeoutMs:number;required:boolean};
export type ToolConfig = {allow:string[];extensions:string[]};
export type ExperimentDefinition = {
  id:string;
  taskFile:string;
  agent?: {provider?:string;model?:string;thinking?:string;timeoutMs?:number};
  tools?: {allow?:string[];extensions?:string[]};
  verification:Array<string | (Partial<VerificationSpec> & Pick<VerificationSpec,'command'>)>;
};
export type RunSpec = {runId:string;subject:{repository:string;githubSha:string};experiment:{path:string};agent:{provider:string|null;model:string|null;thinking:string|null;timeoutMs:number};tools:ToolConfig|null;createdAt:string};
export type RunState = {runId:string;status:RunLifecycle;outcome:RunOutcome;createdAt:string;startedAt:string|null;finishedAt:string|null;updatedAt:string;elapsedMs:number;error:string|null;errorCode:string|null;cancelRequestedAt:string|null;workerId:string|null;leaseUntil:string|null;attempts:number;spec:RunSpec};
export type RunEvent = {seq?:number;runId:string;type:string;at:string;data?:Record<string,unknown>};
export type ArtifactRecord = {runId:string;type:string;key:string;mediaType:string;bytes:number;sha256:string;createdAt:string};

export function validateExperimentDefinition(definition: ExperimentDefinition): string[] {
  const errors:string[]=[];
  if (!definition || typeof definition !== 'object') return ['experiment must be an object'];
  if (typeof definition.id !== 'string' || !definition.id.trim()) errors.push('id must be a non-empty string');
  if (typeof definition.taskFile !== 'string' || !definition.taskFile.trim() || definition.taskFile.startsWith('/') || definition.taskFile.split(/[\\/]/).includes('..')) errors.push('taskFile must be a safe repo-relative path');
  const agent=definition.agent;
  if (!agent || typeof agent !== 'object') errors.push('agent is required');
  else {
    if (typeof agent.provider !== 'string' || !agent.provider.trim()) errors.push('agent.provider is required');
    if (typeof agent.model !== 'string' || !agent.model.trim()) errors.push('agent.model is required');
    if (agent.thinking != null && (typeof agent.thinking !== 'string' || !agent.thinking.trim())) errors.push('agent.thinking must be a non-empty string when provided');
    if (!Number.isInteger(agent.timeoutMs) || Number(agent.timeoutMs) < 1_000 || Number(agent.timeoutMs) > MAX_AGENT_TIMEOUT_MS) errors.push(`agent.timeoutMs must be an integer from 1000 to ${MAX_AGENT_TIMEOUT_MS}`);
  }
  const tools=definition.tools;
  if (tools != null) {
    if (!tools || typeof tools!=='object') errors.push('tools must be an object');
    if (tools.allow != null && (!Array.isArray(tools.allow) || tools.allow.length===0 || tools.allow.some(name=>typeof name!=='string'||!name.trim()))) errors.push('tools.allow must be a non-empty array of tool names');
    if (tools.extensions != null && (!Array.isArray(tools.extensions) || tools.extensions.some(extension=>typeof extension!=='string'||!extension.trim()||extension.startsWith('/')||extension.split(/[\\/]/).includes('..')))) errors.push('tools.extensions must contain safe repo-relative paths');
  }
  if (!Array.isArray(definition.verification) || definition.verification.length===0) errors.push('verification must be a non-empty array');
  else definition.verification.forEach((item,index)=>{
    if (typeof item==='string') { if(!item.trim()) errors.push(`verification[${index}] must not be empty`); return; }
    if (!item || typeof item.command!=='string' || !item.command.trim()) errors.push(`verification[${index}].command is required`);
    if (item?.timeoutMs != null && (!Number.isInteger(item.timeoutMs) || Number(item.timeoutMs)<1_000)) errors.push(`verification[${index}].timeoutMs must be an integer >= 1000`);
    if (item?.required != null && typeof item.required!=='boolean') errors.push(`verification[${index}].required must be boolean`);
  });
  return errors;
}

export function resolveExperimentAgent(definition: ExperimentDefinition) {
  const agent=definition.agent;
  if(!agent?.provider||!agent.model)throw new Error('experiment agent configuration must be validated before resolution');
  return {provider:agent.provider.trim(),model:agent.model.trim(),thinking:agent.thinking?.trim() || null,timeoutMs:Number(agent.timeoutMs)};
}

export function resolveExperimentTools(definition: ExperimentDefinition): ToolConfig {
  return {allow:definition.tools?.allow?.map(name=>name.trim())??['read','bash','edit','write'],extensions:definition.tools?.extensions?.map(extension=>extension.trim())??[]};
}

export function normalizeVerification(definition: ExperimentDefinition): VerificationSpec[] {
  return definition.verification.map((item,index)=>typeof item==='string'?{id:`verify-${index+1}`,command:item,timeoutMs:1_800_000,required:true}:{id:item.id??`verify-${index+1}`,command:item.command,timeoutMs:item.timeoutMs??1_800_000,required:item.required??true});
}
export function withElapsed(state:RunState,now=Date.now()):RunState {if(!state.startedAt)return {...state,elapsedMs:0};return {...state,elapsedMs:Math.max(0,Date.parse(state.finishedAt??new Date(now).toISOString())-Date.parse(state.startedAt))};}
export const TERMINAL_STATES:RunLifecycle[]=['completed','failed','cancelled'];

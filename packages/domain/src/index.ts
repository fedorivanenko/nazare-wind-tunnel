export type Arm = 'raw' | 'nazare';
export type RunLifecycle = 'queued' | 'preparing' | 'compiling' | 'running' | 'verifying' | 'cancelling' | 'completed' | 'failed' | 'cancelled';
export type RunOutcome = 'pass' | 'fail' | 'inconclusive' | null;
export const MAX_AGENT_TIMEOUT_MS = 15 * 60_000;

export type VerificationSpec = {id:string;command:string;timeoutMs:number;required:boolean};
export type ExperimentDefinition = {
  id:string;
  taskFile:string;
  agent?: {provider?:string;model?:string;thinking?:string;timeoutMs?:number};
  nazare?: {capabilityId:string;requestedChange:string};
  verification:Array<string | (Partial<VerificationSpec> & Pick<VerificationSpec,'command'>)>;
};
export type RunSpec = {runId:string;subject:{repository:string;githubSha:string};experiment:{path:string};arm:Arm;agent:{provider:string|null;model:string|null;thinking:string|null;timeoutMs:number};createdAt:string};
export type RunState = {runId:string;status:RunLifecycle;outcome:RunOutcome;createdAt:string;startedAt:string|null;finishedAt:string|null;updatedAt:string;elapsedMs:number;error:string|null;errorCode:string|null;cancelRequestedAt:string|null;workerId:string|null;leaseUntil:string|null;attempts:number;spec:RunSpec};
export type RunEvent = {seq?:number;runId:string;type:string;at:string;data?:Record<string,unknown>};
export type ArtifactRecord = {runId:string;type:string;key:string;mediaType:string;bytes:number;sha256:string;createdAt:string};

export function validateExperimentDefinition(definition: ExperimentDefinition, arm: Arm): string[] {
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
  if (!Array.isArray(definition.verification) || definition.verification.length===0) errors.push('verification must be a non-empty array');
  else definition.verification.forEach((item,index)=>{
    if (typeof item==='string') { if(!item.trim()) errors.push(`verification[${index}] must not be empty`); return; }
    if (!item || typeof item.command!=='string' || !item.command.trim()) errors.push(`verification[${index}].command is required`);
    if (item?.timeoutMs != null && (!Number.isInteger(item.timeoutMs) || Number(item.timeoutMs)<1_000)) errors.push(`verification[${index}].timeoutMs must be an integer >= 1000`);
    if (item?.required != null && typeof item.required!=='boolean') errors.push(`verification[${index}].required must be boolean`);
  });
  if (arm==='nazare') {
    if (!definition.nazare) errors.push('nazare configuration is required for the nazare arm');
    else {
      if (typeof definition.nazare.capabilityId!=='string' || !definition.nazare.capabilityId.trim()) errors.push('nazare.capabilityId is required');
      if (typeof definition.nazare.requestedChange!=='string' || !definition.nazare.requestedChange.trim()) errors.push('nazare.requestedChange is required');
    }
  }
  return errors;
}

export function resolveExperimentAgent(definition: ExperimentDefinition) {
  const agent=definition.agent!;
  return {provider:agent.provider!.trim(),model:agent.model!.trim(),thinking:agent.thinking?.trim() || null,timeoutMs:Number(agent.timeoutMs)};
}

export function normalizeVerification(definition: ExperimentDefinition): VerificationSpec[] {
  return definition.verification.map((item,index)=>typeof item==='string'?{id:`verify-${index+1}`,command:item,timeoutMs:1_800_000,required:true}:{id:item.id??`verify-${index+1}`,command:item.command,timeoutMs:item.timeoutMs??1_800_000,required:item.required??true});
}
export function withElapsed(state:RunState,now=Date.now()):RunState {if(!state.startedAt)return {...state,elapsedMs:0};return {...state,elapsedMs:Math.max(0,Date.parse(state.finishedAt??new Date(now).toISOString())-Date.parse(state.startedAt))};}
export const TERMINAL_STATES:RunLifecycle[]=['completed','failed','cancelled'];

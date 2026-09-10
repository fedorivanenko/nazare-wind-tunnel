import path from 'node:path';

export const REPOSITORY_ROOT='/workspace/repo';
const MAX_TEXT_BYTES=200_000;

export function safeRepositoryPath(relativePath:string){
  if(!relativePath||path.isAbsolute(relativePath))throw new Error(`Expected repository-relative path: ${relativePath}`);
  const normalized=path.posix.normalize(relativePath.replaceAll('\\','/'));
  if(normalized==='..'||normalized.startsWith('../')||normalized==='.git'||normalized.startsWith('.git/')||normalized.includes('/.git/'))throw new Error(`Path escapes repository: ${relativePath}`);
  return `${REPOSITORY_ROOT}/${normalized}`;
}

export function shellQuote(value:string){return `'${value.replaceAll("'","'\\''")}'`;}

export function requiredText(value:string|null,label:string){if(value===null)throw new Error(`${label} not found`);return value;}

export function bounded(text:string,maxBytes=MAX_TEXT_BYTES){
  const bytes=Buffer.from(text);
  return bytes.byteLength<=maxBytes?text:`${bytes.subarray(0,maxBytes).toString('utf8')}\n[truncated at ${maxBytes} bytes]`;
}

export type ExperimentDefinition={
  taskFile:string;
  tools?:{bootstrap?:Array<{id:string;entrypoint:string;timeoutMs?:number;maxOutputBytes?:number;required?:boolean}>};
  verification?:Array<string|{name?:string;command:string;required?:boolean;timeoutMs?:number}>;
};

export function parseExperiment(text:string):ExperimentDefinition{
  const value=JSON.parse(text) as ExperimentDefinition;
  if(typeof value.taskFile!=='string'||!value.taskFile)throw new Error('Experiment taskFile missing');
  return value;
}

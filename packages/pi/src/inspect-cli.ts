import {inspectPiExtensions} from './index';

let input='';
process.stdin.setEncoding('utf8');
for await(const chunk of process.stdin)input+=chunk;
const extensions=JSON.parse(input) as Array<{path:string;absolutePath:string;sha256:string}>;
const tools=await inspectPiExtensions(extensions);
process.stdout.write(JSON.stringify(tools));

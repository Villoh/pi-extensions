// Fake `@99percentpeople/pi-ssh-remote` backend module for tests: same exports
// the real 0.6.2 bundle has, with in-memory files and a recorded call log.
// `defaultExport` is the module's default export (the parent extension factory).
const NO_PARENT_FACTORY =
  "export default function() { throw new Error('Parent extension factory must not run in BTW'); }";

export function fakeSshBackend(defaultExport: string = NO_PARENT_FACTORY): string {
  return `
  import { posix } from 'node:path';
  export const files = new Map([['/srv/project/src/main.ts', Buffer.from('first line\\nremote-only sentinel\\nlast line\\n')]]);
  export const calls = [];
  export let failure;
  export let disconnect;
  export function setFailure(value) { failure = value; }
  export function findSshEnvironmentState(entries) {
    const entry = entries.filter(e => e.type === 'custom' && ['pi-ssh-remote-state', 'pi-ssh-local-state'].includes(e.customType)).at(-1);
    return !entry ? undefined : entry.customType === 'pi-ssh-local-state' ? {mode:'local'} : {mode:'remote',session:entry.data};
  }
  export function createSshTransportClient(options, settings) {
    calls.push(['connect', options, settings]);
    if (failure === 'factory') throw new Error('transport unavailable');
    return {
      dispose: async () => calls.push(['dispose']),
      onDisconnect(fn) { disconnect = fn; return () => { disconnect = undefined; }; },
    };
  }
  const decode = path => path.replace('/__remote__', '');
  export async function selectRemoteAdapter(client, options) {
    if (failure === 'connect') throw new Error('connection refused');
    const workspace = {cwd:options.requestedCwd,home:'/home/test',platform:'unix',shell:'bash'};
    const record = (name, path) => { calls.push([name, decode(path)]); if (failure === 'operation') throw new Error('remote unavailable'); };
    return {workspace, adapter: {
      toToolPath: (path, ws) => '/__remote__' + posix.resolve(ws.cwd, path.startsWith('~/') ? '/home/test/' + path.slice(2) : path),
      mapCwd: (path, localCwd, ws) => path === localCwd ? ws.cwd : posix.resolve(ws.cwd,path),
      access: async path => { record('access',path); if (!files.has(decode(path))) throw new Error('remote file not found'); },
      readFile: async path => { record('read',path); if (!files.has(decode(path))) throw new Error('remote file not found'); return files.get(decode(path)); },
      detectImageMimeType: async () => null,
      mkdir: async path => record('mkdir',path),
      writeFile: async (path, value) => { record('write',path); files.set(decode(path),Buffer.from(value)); },
      runShell: async (command,cwd,options) => { calls.push(['shell',command,cwd]); options.onStdout(Buffer.from('remote shell sentinel')); return 0; },
      listDirectory: async path => { record('ls',path); return [{name:'src',isDirectory:true}]; },
      findEntries: async (path,pattern,count) => { record('find',path); return [{path:'src/main.ts',isDirectory:false}]; },
      grep: async (path,pattern,options) => { record('grep',path); return [{path:'src/main.ts',toolPath:'/__remote__/srv/project/src/main.ts',lineNumber:2,line:'remote-only sentinel'}]; },
    }};
  }
  ${defaultExport}
`;
}

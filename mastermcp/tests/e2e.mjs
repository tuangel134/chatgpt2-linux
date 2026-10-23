/* Ephemeral loopback OAuth E2E. Test approval is entirely synthetic/temp-state. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
const BASE = resolve(import.meta.dirname,'..');
const root = await mkdtemp(join(tmpdir(), 'chatgpt2-mcp-e2e-'));
const workspace = join(root,'workspace');
const ctrl = join(root,'state');
await mkdir(workspace);
await writeFile(join(workspace,'readme.txt'),'test-read-ok\n');
const secret = (await readFile(join(homedir(),'.codex-2/hub-token'),'utf8')).trim();
const server = createServer();
const port = await new Promise((ok,fail) => {server.listen(0,'127.0.0.1',()=>{
  const address=server.address();ok(address.port);server.close();
});server.on('error',fail)});
const base='http://127.0.0.1:'+port;
const logs=[];
const child=spawn(process.execPath,[join(BASE,'host.cjs')],{
 env:{...process.env,CHATGPT2_MCP_TEST_ROOT:ctrl,CHATGPT2_MCP_CONTROL_PORT:String(port)},
 stdio:['ignore','pipe','pipe']
});
child.stdout.on('data', d => logs.push(String(d).replace(/[A-Za-z0-9_-]{48,}/g,'[masked]')));
child.stderr.on('data', d => logs.push(String(d).replace(/[A-Za-z0-9_-]{48,}/g,'[masked]')));
async function req(path, data, options={}){
 const headers={...(options.auth===false?{}:{'x-hub-token':secret}),...(data===undefined?{}:{'content-type':'application/json'}),...(options.headers||{})};
 const r=await fetch(base+path,{method:data===undefined?'GET':'POST',headers,body:data===undefined?undefined:JSON.stringify(data),redirect:'manual'});
 const obj=await r.json().catch(()=>({}));
 return {status:r.status,data:obj,headers:r.headers};
}
const pause=ms=>new Promise(ok=>setTimeout(ok,ms));
async function wait(read,tries=80){
 for(let i=0;i<tries;i++){const v=await read();if(v)return v;await pause(100)}
 throw new Error('Timed out waiting for server state.');
}
let count=0;
function check(label, condition){assert.ok(condition,label); console.log('PASS '+(++count)+': '+label);}
try {
 await wait(async()=>{try{const r=await req('/state');return r.status===200}catch{return false}});
 check('No token rejected', (await req('/state',undefined,{auth:false})).status===401);
 check('Hostile Origin rejected',(await req('/state',undefined,{headers:{origin:'https://attacker.invalid'}})).status===403);
 const state=await req('/state');
 check('Default OFF + no public url',!state.data.control.enabled && !state.data.masterMcp.running && !state.data.masterMcp.publicUrl);
 check('High risk permissions disabled',!state.data.permissions.includes('forja:host-terminal'));
 const dummy='synthetic-not-a-real-ngrok-token-'+randomBytes(24).toString('hex');
 const stored=await req('/settings',{enabled:false,mode:'local',domain:'',ngrokToken:dummy});
 check('Dummy ngrok secret accepted while OFF',stored.status===200 && stored.data.tunnel.configured);
 const encrypted=await readFile(join(ctrl,'secrets.enc'),'utf8');
 check('ngrok token encrypted at rest',!encrypted.includes(dummy));
 check('ngrok token never appears in status',!JSON.stringify(stored.data).includes(dummy));
 const on=await req('/settings',{enabled:true,mode:'local',domain:''});
 check('Local MCP started',on.status===200 && on.data.masterMcp.running && !on.data.masterMcp.publicUrl);
 const ws=await req('/workspace/add',{path:workspace});
 check('Isolated temporary workspace added',ws.status===200 && ws.data.workspaces.length===1);
 const excluded=await req('/workspace/add',{path:resolve(homedir(),'.local/opt/chatgpt2')});
 check('Clone installation blocked as workspace',excluded.status===422);
 const wid=ws.data.workspaces[0].id;
 const mcpbase=on.data.masterMcp.localUrl;
 const register=await fetch(mcpbase+'/oauth/register',{method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({client_name:'Synthetic E2E ONLY',redirect_uris:['http://127.0.0.1:39551/callback'],token_endpoint_auth_method:'none'})});
 check('OAuth DCR register',register.status===201);
 const client=await register.json();
 const verifier=randomBytes(32).toString('base64url');
 const challenge=createHash('sha256').update(verifier).digest('base64url');
 const params=new URLSearchParams({response_type:'code',client_id:client.client_id,
  redirect_uri:'http://127.0.0.1:39551/callback',state:'synthetic-test',
  code_challenge:challenge,code_challenge_method:'S256',scope:'forja:read forja:host-terminal offline_access'});
 const auth=fetch(mcpbase+'/oauth/authorize?'+params,{redirect:'manual'});
 const pending=await wait(async()=>{const s=await req('/state');return s.data.pendingAuthorizations?.[0]});
 check('Authorization pending, not auto-approved',pending.scopes.includes('forja:host-terminal'));
 const forbidden=await req('/authorization/approve',{id:pending.id,workspaceIds:[wid],scopes:['forja:read','forja:host-terminal']});
 check('Unenabled high-risk scope refused',forbidden.status===422);
 // This is a synthetic-only approval in a temporary server, never a real user grant.
 const approval=await req('/authorization/approve',{id:pending.id,workspaceIds:[wid],scopes:['forja:read']});
 check('Simulated read-only approval',approval.status===200);
 const redirected=await auth;
 check('PKCE authorization code redirect',redirected.status===302 && !!redirected.headers.get('location'));
 const code=new URL(redirected.headers.get('location')).searchParams.get('code');
 const tr=await fetch(mcpbase+'/oauth/token',{method:'POST',
  headers:{'content-type':'application/x-www-form-urlencoded'},
  body:new URLSearchParams({grant_type:'authorization_code',code,client_id:client.client_id,
    redirect_uri:'http://127.0.0.1:39551/callback',code_verifier:verifier})});
 check('OAuth token exchanged',tr.status===200);
 const access=(await tr.json()).access_token;
 async function mcp(method,params){
  const r=await fetch(mcpbase+'/mcp',{method:'POST',headers:{authorization:'Bearer '+access,
    'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
  return {status:r.status,data:await r.json()};
 }
 const init=await mcp('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'E2E',version:'1'}});
 check('MCP initialize',init.status===200 && !!init.data.result);
 const tools=await mcp('tools/list',{});
 check('MCP tools/list no fake sessions',tools.data.result.tools.some(t=>t.name==='forja_call_workspace_tool') &&
   !tools.data.result.tools.some(t=>t.name==='forja_start_session'));
 const list=await mcp('tools/call',{name:'forja_list_workspaces',arguments:{}});
 check('MCP allowed read-only tool',list.status===200 && JSON.stringify(list.data).includes(wid));
 const browserDenied=await mcp('tools/call',{name:'forja_browser_list_pages',arguments:{workspaceId:wid}});
 check('Browser scope needed even for list',JSON.stringify(browserDenied.data).includes('forja:browser'));
 const read=await mcp('tools/call',{name:'forja_call_workspace_tool',
  arguments:{workspaceId:wid,tool:'read_file',arguments:{path:'readme.txt'}}});
 check('MCP workspace file read',read.status===200 && JSON.stringify(read.data).includes('test-read-ok'));
 const denied=await mcp('tools/call',{name:'forja_call_workspace_tool',
  arguments:{workspaceId:wid,tool:'create_file',arguments:{path:'test.txt',content:'deny'}}});
 check('Write without agent scope denied',!!denied.data.error || JSON.stringify(denied.data).includes('forja:agent'));
 const rev=await req('/authorization/revoke',{clientId:client.client_id});
 check('Synthetic connector revoked',rev.status===200 && rev.data.authorizations.length===0);
 const after=await mcp('tools/list',{});
 check('Revoked token no longer works',after.status===401);
 const off=await req('/settings',{enabled:false,mode:'local',domain:''});
 check('Stop local service',off.status===200 && !off.data.masterMcp.running);
 console.log('TOTAL '+count+' assertions OK, all test state temporary. No real connector approved.');
} catch(e) {
 console.error('E2E FAILED:',e.message);
 console.error(logs.join('').slice(-1000));
 process.exitCode=1;
} finally {
 child.kill('SIGTERM');
 await Promise.race([new Promise(ok=>child.once('exit',ok)),pause(1500)]);
 await rm(root,{recursive:true,force:true});
}

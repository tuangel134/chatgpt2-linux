// Full OAuth MCP -> Brave CDP bridge in a fresh temporary profile; all approvals synthetic.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
const APP = resolve(import.meta.dirname, '..');
const root = await mkdtemp(join(tmpdir(), 'chatgpt2-mcp-browser-'));
const work = join(root, 'work'), work2=join(root,'work2'), state = join(root, 'state'), profile = join(root, 'brave-profile');
await mkdir(work);
await mkdir(work2);
await writeFile(join(work, 'fixture.txt'), 'fixture');
const secret = (await readFile(join(homedir(),'.codex-2/hub-token'),'utf8')).trim();
const site = createServer((request, response) => {
  response.writeHead(200, {'content-type':'text/html; charset=utf-8'});
  response.end('<!doctype html><title>MCP fixture</title><h2 id="value">NOT CLICKED</h2><button onclick="document.querySelector(\'#value\').textContent=\'CLICKED SUCCESS\'">Run</button>');
});
const reserve = createServer();
await new Promise(ok=>reserve.listen(0,'127.0.0.1',ok));
const port=reserve.address().port;
await new Promise(ok=>reserve.close(ok));
let child, tests=0;
const check=(label, condition)=>{assert.ok(condition,label); console.log('PASS '+(++tests)+' '+label)};
const apiBase='http://127.0.0.1:'+port;
async function ctl(route, data) {
 const res=await fetch(apiBase+route,{method:data===undefined?'GET':'POST',
 headers:{'x-hub-token':secret,'content-type':'application/json'},
 body:data===undefined?undefined:JSON.stringify(data)});
 return {status:res.status,data:await res.json()};
}
async function ready() {
 for(let i=0;i<70;i++){
  try { if ((await ctl('/state')).status===200)return } catch{}
  await new Promise(ok=>setTimeout(ok,100));
 }
 throw Error('Control server not ready');
}
try {
 await new Promise(ok=>site.listen(0,'127.0.0.1',ok));
 child=spawn(process.execPath,[join(APP,'host.cjs')],{stdio:['ignore','pipe','pipe'],
 env:{...process.env,CHATGPT2_MCP_TEST_ROOT:state,CHATGPT2_MCP_CONTROL_PORT:String(port),
 CHATGPT2_MCP_BROWSER_PROFILE:profile,CHATGPT2_MCP_HEADLESS:'1'}});
 let log='';
 child.stdout.on('data', d=>{log+=String(d)});
 child.stderr.on('data', d=>{log+=String(d)});
 await ready();
 const ws=await ctl('/workspace/add',{path:work});
 assert.equal(ws.status,200);
 const wid=ws.data.workspaces[0].id;
 const ws2=await ctl('/workspace/add',{path:work2});
 const wid2=ws2.data.workspaces.find(w=>w.root===work2)?.id;
 assert.ok(wid2);
 await ctl('/permissions',{scopes:['forja:read','forja:agent','forja:browser']});
 const running=await ctl('/settings',{enabled:true,mode:'local',domain:''});
 assert.equal(running.status,200);
 const base=running.data.masterMcp.localUrl;
 const post=async(path,body,contentType='application/json')=>fetch(base+path,{method:'POST',
  headers:{'content-type':contentType},body:contentType==='application/json'?JSON.stringify(body):body});
 const register=await post('/oauth/register',{client_name:'Synthetic browser integration',
  redirect_uris:['http://127.0.0.1:39394/callback'],token_endpoint_auth_method:'none'});
 check('Synthetic browser OAuth DCR',register.status===201);
 const client=await register.json();
 const verifier=randomBytes(32).toString('base64url');
 const challenge=createHash('sha256').update(verifier).digest('base64url');
 const query=new URLSearchParams({response_type:'code',client_id:client.client_id,redirect_uri:'http://127.0.0.1:39394/callback',
 state:'synthetic',code_challenge:challenge,code_challenge_method:'S256',
 scope:'forja:read forja:agent forja:browser offline_access'});
 const pendingPromise=fetch(base+'/oauth/authorize?'+query,{redirect:'manual'});
 let pending;
 for(let i=0;i<60&&!pending;i++){
   pending=(await ctl('/state')).data.pendingAuthorizations[0];
   if(!pending)await new Promise(ok=>setTimeout(ok,100));
 }
 check('Grant still pending manual action',!!pending);
 const approval=await ctl('/authorization/approve',{id:pending.id,workspaceIds:[wid,wid2],
 scopes:['forja:read','forja:agent','forja:browser']});
 check('Synthetic approval only',approval.status===200);
 const redirect=await pendingPromise;
 const code=new URL(redirect.headers.get('location')).searchParams.get('code');
 const tokenResp=await post('/oauth/token',new URLSearchParams({
 grant_type:'authorization_code',code,client_id:client.client_id,
 redirect_uri:'http://127.0.0.1:39394/callback',code_verifier:verifier}), 'application/x-www-form-urlencoded');
 check('PKCE token exchange',tokenResp.status===200);
 const access=(await tokenResp.json()).access_token;
 const rpc=async(name,args)=>{
  const response=await fetch(base+'/mcp',{method:'POST',headers:{authorization:'Bearer '+access,
  'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',
  params:{name,arguments:args}})});
  return (await response.json());
 };
 const siteUrl='http://127.0.0.1:'+site.address().port+'/';
 const opened=await rpc('forja_browser_open',{workspaceId:wid,url:siteUrl});
 const bodyText=opened.result?.content?.[0]?.text??'';
 let page;
 try {page=JSON.parse(bodyText)}catch{}
 check('MCP opened real Brave CDP tab',!!page?.id);
 const narrower=await ctl('/authorization/update',{clientId:client.client_id,
  workspaceIds:[wid],scopes:['forja:read','forja:agent','forja:browser']});
 check('Reduced connector workspace access',narrower.status===200 && narrower.data.authorizations[0]?.workspaceIds.length===1);
 const deniedOther=await rpc('forja_call_workspace_tool',{workspaceId:wid2,tool:'read_file',arguments:{path:'fixture.txt'}});
 check('Old bearer cannot enter removed workspace',!!deniedOther.error);
 const expanded=await ctl('/authorization/update',{clientId:client.client_id,workspaceIds:[wid,wid2],
  scopes:['forja:read','forja:agent','forja:browser']});
 check('Access expansion requires new approval',expanded.status===422);
 const summary=await rpc('forja_browser_summary',{workspaceId:wid,pageId:page.id});
 check('MCP read webpage title',JSON.stringify(summary).includes('MCP fixture'));
 const action=await rpc('forja_browser_execute',{workspaceId:wid,pageId:page.id,
 code:'async (page) => { await page.getByRole("button",{name:"Run"}).click(); return "OK"; }'});
 check('MCP clicked webpage element',JSON.stringify(action).includes('CLICKED SUCCESS'));
 const image=await rpc('forja_browser_screenshot',{workspaceId:wid,pageId:page.id});
 const shot=JSON.parse(image.result?.content?.[0]?.text??'{}');
 check('MCP captured browser screenshot',shot.mimeType==='image/png'&&shot.data?.length>300);
 const unshare=await rpc('forja_browser_unshare_page',{workspaceId:wid,pageId:page.id});
 check('MCP unshared own page',!!unshare.result);
 const denied=await rpc('forja_browser_summary',{workspaceId:wid,pageId:page.id});
 check('Unshared page inaccessible via MCP',!!denied.error);
 const reduced=await ctl('/permissions',{scopes:['forja:read']});
 check('Global permissions can be reduced',reduced.status===200);
 const scoped=await rpc('forja_browser_list_pages',{workspaceId:wid});
 check('Browser fails after global scope reduction',!!scoped.error);
 await ctl('/authorization/revoke',{clientId:client.client_id});
 const revoked=await rpc('forja_browser_list_pages',{workspaceId:wid});
 check('Revoked bearer cannot use browser',!!revoked.error || JSON.stringify(revoked).includes('invalid_token'));
 console.log('MCP BROWSER E2E: '+tests+' PASS with temporary data/Brave profile');
} catch(e) {
 console.error('MCP BROWSER E2E FAILED:',e.message);
 process.exitCode=1;
} finally {
 if(child){child.kill('SIGTERM');await Promise.race([new Promise(ok=>child.once('exit',ok)),new Promise(ok=>setTimeout(ok,1200))])}
 site.close();
 await new Promise(ok=>setTimeout(ok,250));
 await rm(root,{recursive:true,force:true});
}

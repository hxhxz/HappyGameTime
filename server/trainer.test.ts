import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
let server: Server, url: string, cookie: string;
let dir='';
async function request(path: string, data?: unknown, auth = true) {
  const res=await fetch(`${url}/${path}`,{...(data===undefined?{}:{method:'POST',body:JSON.stringify(data)}),headers:{'Content-Type':'application/json',...(auth?{Cookie:cookie}:{})}});
  return {status:res.status,data:await res.json(),headers:res.headers};
}
beforeAll(async()=>{
  dir=mkdtempSync(join(tmpdir(),'pokemon-integration-'));
  process.env.DATA_DIR=dir;process.env.ACCESS_PASSWORD='test-password-integration';process.env.COOKIE_SECURE='false';
  server=(await import('./trainer')).server;
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  url=`http://127.0.0.1:${(server.address() as {port:number}).port}/pokemon/api`;
});
afterAll(async()=>{await new Promise<void>(r=>server.close(()=>r()));});
describe('private trainer HTTP flow',()=>{
  it('requires authentication and rejects wrong passwords',async()=>{
    expect((await request('state',undefined,false)).status).toBe(401);
    expect((await request('login',{password:'wrong'},false)).status).toBe(401);
    const login=await request('login',{password:'test-password-integration'},false);
    expect(login.status).toBe(200);cookie=login.headers.get('set-cookie')!.split(';')[0];
    expect(login.headers.get('set-cookie')).toContain('HttpOnly');
  });
  it('needs no model configuration and hides decks',async()=>{
    const state=(await request('state')).data;
    expect(state.configured).toBe(true);
    expect(state.settings).toEqual({baseUrl:'',model:'本地规则引擎',hasKey:false});
    expect(state.game.players).toHaveLength(4);
    expect(state.game.players.filter((p:{isAI:boolean})=>p.isAI)).toHaveLength(3);
    expect(state.game.decks[1].drawPile[0]).toEqual({id:'hidden'});
    expect((await request('settings',{})).status).toBe(404);
  });
  it('rejects illegal actions, foreign-origin requests and stale revisions',async()=>{
    const state=(await request('state')).data;
    expect((await request('action',{revision:state.revision,action:{type:'TAKE_THREE',colors:['red']}})).status).toBe(400);
    expect((await request('action',{revision:-1,action:{type:'TAKE_THREE',colors:['red','blue','black']}})).status).toBe(400);
    const res=await fetch(`${url}/new`,{method:'POST',headers:{Origin:'https://evil.example',Cookie:cookie,'Content-Type':'application/json'},body:'{}'});
    expect(res.status).toBe(403);
  });
  it('runs three local rule agents, returns to human, and persists auditable terms',async()=>{
    const state=(await request('state')).data;
    await request('resume',{});
    await request('action',{revision:state.revision,action:{type:'TAKE_THREE',colors:['red','blue','black']}});
    let latest;
    for(let i=0;i<50;i++){latest=(await request('state')).data;if(latest.game.currentPlayerIndex===0)break;await new Promise(r=>setTimeout(r,100));}
    expect(latest.game.currentPlayerIndex).toBe(0);
    expect(latest.decisions.map((d:{name:string})=>d.name)).toEqual(['赤焰','青岚','紫苑']);
    expect(latest.usage).toEqual({calls:0,tokens:0,cacheHitTokens:0,cacheMissTokens:0});
    expect(JSON.parse(readFileSync(join(dir,'game.json'),'utf8')).game.turnNumber).toBe(5);
    const exported=await request('export');
    expect(exported.status).toBe(200);
    expect(exported.headers.get('content-disposition')).toContain('pokemon-review-');
    expect(exported.data.decisions).toHaveLength(3);
    expect(exported.data.model).toBe('local-rules-engine');
    expect(exported.data.decisions[0].modelInput).toBeUndefined();
    expect(exported.data.decisions[0].chosenActionId).toBe(0);
    expect(exported.data.decisions[0].heuristicScore).toEqual(expect.any(Number));
    expect(exported.data.decisions[0].heuristicTerms.total).toBe(exported.data.decisions[0].heuristicScore);
    expect(exported.data.decisions[0].legalActionLabels.length).toBeGreaterThan(0);
  },10000);
});

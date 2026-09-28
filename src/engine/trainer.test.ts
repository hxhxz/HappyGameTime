import { describe, it, expect } from 'vitest';
import { createGame, applyAction, legalMoves } from './index';
import { CARDS } from '../data/cards';
const fresh = () => createGame({ players:[0,1,2,3].map(i=>({id:`P${i}`, name:`P${i}`, isAI:i>0})), cards:CARDS, seed:18 });
describe('rule corrections for trainer', () => {
  it('requires three distinct colors when available, fewer only when exhausted', () => {
    const g=fresh();
    expect(()=>applyAction(g,{type:'TAKE_THREE',colors:['red']})).toThrow();
    expect(legalMoves(g).filter(a=>a.type==='TAKE_THREE').every(a=>a.type==='TAKE_THREE'&&a.colors.length===3)).toBe(true);
    g.tokenPool.blue=0;g.tokenPool.black=0;g.tokenPool.pink=0;
    expect(()=>applyAction(g,{type:'TAKE_THREE',colors:['red','yellow']})).not.toThrow();
  });
  it('rejects negative and missing discard values and gives the agent all legal discard choices', () => {
    const g=fresh(); g.awaitingDiscard=true;
    g.players[0].tokens={red:4,blue:4,black:3,pink:0,yellow:0,master:0};
    const moves=legalMoves(g);
    expect(moves.length).toBe(3);
    for(const a of moves) expect(()=>applyAction(g,a)).not.toThrow();
    expect(()=>applyAction(g,{type:'DISCARD',tokens:{red:-1,blue:2,black:0,pink:0,yellow:0,master:0}})).toThrow();
  });
  it('finishes the round after a trigger even if the leading score subsequently drops', () => {
    const g=fresh();g.currentPlayerIndex=3;g.endTriggeredByPlayerIndex=0;
    expect(applyAction(g,{type:'TAKE_THREE',colors:['red','blue','black']}).isGameOver).toBe(true);
  });
});

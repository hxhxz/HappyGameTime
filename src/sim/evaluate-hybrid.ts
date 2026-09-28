import { applyAction, createGame, legalMoves, passTurn, type Action } from '../engine';
import { CARDS } from '../data/cards';
import { estimateContextTokens, messagesFor, observation } from '../../server/agent';
import { rankCandidates, type AgentStyle } from '../../server/strategy';
import { playGreedyGame } from './selfplay';

const STYLES: AgentStyle[] = ['抢分型', '进化型', '控场型'];
const compactLegacy = (action: Action, i: number) => ({ i, a: action.type, action });

function legacyMessages(state: ReturnType<typeof createGame>, moves: Action[]) {
  return [
    { role: 'system', content: '四人各自争胜。18分触发最终轮。从合法动作中选择一个，只输出JSON。' },
    { role: 'user', content: JSON.stringify({ state: observation(state, state.log.length), legalActions: moves.map(compactLegacy) }) },
  ];
}

export function evaluateHybrid(games = 100, startSeed = 20_000) {
  let turns = 0, evolutions = 0, calls = 0, hybridInputTokens = 0, legacyInputTokens = 0, stalemates = 0;
  for (let gameNo = 0; gameNo < games; gameNo++) {
    let state = createGame({ players: [0, 1, 2, 3].map(i => ({ id: `P${i}`, name: i ? ['赤焰', '青岚', '紫苑'][i - 1] : '基准', isAI: true })), cards: CARDS, seed: startSeed + gameNo });
    let guard = 0;
    while (!state.isGameOver) {
      if (guard++ > 2_000) throw new Error(`seed ${startSeed + gameNo} exceeded turn guard`);
      const moves = legalMoves(state);
      if (!moves.length) { state = passTurn(state); continue; }
      const style = STYLES[(Math.max(1, state.currentPlayerIndex) - 1) % STYLES.length];
      const candidates = rankCandidates(state, moves, style);
      if (state.currentPlayerIndex > 0) {
        hybridInputTokens += estimateContextTokens(messagesFor(state, candidates));
        legacyInputTokens += estimateContextTokens(legacyMessages(state, moves));
        calls++;
      }
      state = applyAction(state, candidates[0].action);
    }
    turns += state.turnNumber;
    evolutions += state.players.reduce((sum, p) => sum + p.evolved.length, 0);
    if (state.log.some(line => line.startsWith('僵局'))) stalemates++;
  }
  const greedyGames = Array.from({ length: games }, (_, i) => playGreedyGame(startSeed + i, 4));
  return {
    games,
    hybridTop1Proxy: {
      avgTurnsToFinish: turns / games,
      avgEvolutions: evolutions / games,
      stalemates,
      estimatedInputTokensPerModelCall: hybridInputTokens / calls,
      estimatedInputTokensPerGameForThreeAgents: hybridInputTokens / games,
    },
    legacyPromptEstimate: {
      estimatedInputTokensPerModelCall: legacyInputTokens / calls,
      estimatedInputTokensPerGameForThreeAgents: legacyInputTokens / games,
      reductionRatio: 1 - hybridInputTokens / legacyInputTokens,
    },
    greedyBaseline: {
      avgTurnsToFinish: greedyGames.reduce((sum, game) => sum + game.turns, 0) / games,
      avgEvolutions: greedyGames.reduce((sum, game) => sum + game.evolutions, 0) / games,
      stalemates: greedyGames.filter(game => game.stalemate).length,
    },
    explanationConsistency: {
      hardIdentityContradictionsAccepted: 0,
      reason: 'selfPoints must exactly match the active player before an action can execute',
      semanticContradictions: 'requires live LLM outputs or human review; not claimed by offline simulation',
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(JSON.stringify(evaluateHybrid(Number(process.argv[2] ?? 100)), null, 2));

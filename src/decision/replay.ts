import { applyAction, legalMoves, passTurn } from '../engine';
import type { Action, GameState } from '../engine/types';
import { playerView, publicView, viewHash } from './views';
import { ENV_VERSION, type PublicView } from './types';

export interface ReplayStep {
  t: number;
  playerId: string;
  playerViewHash: string;
  legalActions: Action[];
  chosenAction: Action | null;
  observation: PublicView;
}

export interface EpisodeRecord {
  schemaVersion: 2;
  episodeId: string;
  envVersion: string;
  initialState: GameState;
  steps: ReplayStep[];
  outcome?: { winnerId?: string; scores: Record<string, number>; turns: number };
}

export function newEpisodeRecord(episodeId: string, initialState: GameState): EpisodeRecord {
  return { schemaVersion: 2, episodeId, envVersion: ENV_VERSION, initialState: structuredClone(initialState), steps: [] };
}

export function appendReplayStep(record: EpisodeRecord, before: GameState, action: Action | null, after: GameState): void {
  const index = before.currentPlayerIndex;
  record.steps.push({
    t: record.steps.length,
    playerId: before.players[index].id,
    playerViewHash: viewHash(playerView(before, index)),
    legalActions: legalMoves(before),
    chosenAction: action ? structuredClone(action) : null,
    observation: publicView(after),
  });
  if (after.isGameOver) {
    record.outcome = {
      winnerId: after.winnerId,
      scores: Object.fromEntries(after.players.map(player => [player.id, player.points])),
      turns: after.turnNumber,
    };
  }
}

export function replayEpisode(record: EpisodeRecord): GameState {
  if (record.envVersion !== ENV_VERSION) throw new Error(`unsupported env version ${record.envVersion}`);
  let state = structuredClone(record.initialState);
  for (const expected of record.steps) {
    const actualHash = viewHash(playerView(state, state.currentPlayerIndex));
    if (actualHash !== expected.playerViewHash) throw new Error(`replay view mismatch at step ${expected.t}`);
    const legal = legalMoves(state);
    if (JSON.stringify(legal) !== JSON.stringify(expected.legalActions)) throw new Error(`replay legal actions mismatch at step ${expected.t}`);
    state = expected.chosenAction ? applyAction(state, expected.chosenAction) : passTurn(state);
    if (JSON.stringify(publicView(state)) !== JSON.stringify(expected.observation)) throw new Error(`replay observation mismatch at step ${expected.t}`);
  }
  return state;
}


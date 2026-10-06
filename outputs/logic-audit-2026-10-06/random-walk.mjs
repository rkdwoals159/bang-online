import { initializeGame } from '../../packages/engine/src/setup/initialize.ts';
import { BASE_PHYSICAL_CARDS } from '../../packages/catalog/src/cards/index.ts';
import { projectMatchSnapshot } from '../../packages/engine/src/state/projection.ts';
import { parseMatchSyncResponse } from '../../packages/contracts/src/validation.ts';
import { parseMatchState } from '../../apps/site/src/storage/state-schema.ts';
import { applyMatchCommand } from '../../packages/engine/src/commands/index.ts';
import { createEffectRegistry } from '../../packages/engine/src/effects/registry.ts';
import { createEffectCommandHandlers } from '../../packages/engine/src/effects/runtime/index.ts';
import { withTurnStartEffects } from '../../packages/engine/src/turn/draw.ts';
import { advanceTurnPhases, createTurnAwareCommandHandlers } from '../../apps/server/src/commands/turn-runtime.ts';
import { buildLegalActionCandidates } from '../../packages/engine/src/actions/index.ts';
import { writeFileSync } from 'node:fs';

const results = []; let commands = 0;
for (let seed = 1; seed <= 80; seed++) {
  let value = seed, counter = 0;
  const random = {nextFloat: () => {value = (Math.imul(value, 1664525) + 1013904223) >>> 0; return value / 4294967296;}};
  const pick = list => list[Math.floor(random.nextFloat() * list.length)];
  const count = 4 + (seed % 4);
  const identity = () => ({interactionId: `audit-${seed}-${++counter}`, createdAt: '2026-10-06T00:00:00Z'});
  const options = withTurnStartEffects({registry: createEffectRegistry(), nextInteractionIdentity: identity});
  const runtime = {matchId: `audit-${seed}`, random, nextInteractionIdentity: identity, runtimeOptions: options};
  const context = {random, handlers: createTurnAwareCommandHandlers(createEffectCommandHandlers(options), runtime), interaction: identity()};
  let state = initializeGame({players: Array.from({length: count}, (_, i) => ({playerId: `p${i}`, displayName: `P${i}`})), random});
  let history = [], step = 0;
  try {
    state = advanceTurnPhases(state, runtime).state;
    for (; step < 1800 && state.status === 'playing'; step++) {
      parseMatchState(state);
      const views = state.seats.map(seat => projectMatchSnapshot(state, seat.public.playerId, BASE_PHYSICAL_CARDS));
      for (const snapshot of views) {
        const parsed = parseMatchSyncResponse({protocolVersion:1, requestId:'audit', matchId:'audit', version:state.version, eventSeq:state.eventSeq, requiresFullSnapshot:true, snapshot, visibleEvents:[]});
        if (!parsed.ok) throw new Error(`Invalid viewer DTO: ${JSON.stringify(parsed)}`);
      }
      const responders = views.filter(view => view.pendingInteraction && 'responseOptions' in view.pendingInteraction);
      let command, actor;
      if (responders.length) {
        const view = pick(responders), pending = view.pendingInteraction, option = pick(pending.responseOptions);
        actor = view.viewer.playerId;
        const payload = {...option};
        if (payload.choice === 'ORDER_CARDS' && !payload.orderedCardInstanceIds) payload.orderedCardInstanceIds = pending.discardOrder.allowedCards.slice(0, pending.discardOrder.requiredCount).map(card => card.cardInstanceId);
        command = {type:'RESPOND', payload};
      } else {
        actor = state.turn.currentPlayerId;
        const actions = buildLegalActionCandidates(state, actor);
        if (!actions.length) throw new Error('No legal actions or responders in playing state');
        command = random.nextFloat() < .2 ? (actions.find(action => action.type === 'END_TURN') ?? pick(actions)) : pick(actions);
      }
      history.push({step, version:state.version, actor, command});
      context.interaction = identity();
      const result = applyMatchCommand(state, actor, command, context);
      if (!result.ok) throw new Error(`Projected legal command rejected: ${JSON.stringify(result.error)}`);
      const next = advanceTurnPhases(result.state, runtime);
      state = {...next.state, version:result.state.version, eventSeq:state.eventSeq+result.events.length+next.events.length};
      commands++;
    }
    parseMatchState(state);
    results.push({seed, count, steps:step, status:state.status});
  } catch (error) {
    const evidence = {seed,count,step,error:String(error),state,history:history.slice(-30)};
    writeFileSync(new URL(`./failure-seed-${seed}.json`,import.meta.url),JSON.stringify(evidence,null,2));
    results.push({seed,count,steps:step,status:'FAIL',error:String(error)});
  }
}
const report = {scope:'Isolated deterministic random walks, not production/browser acceptance', commands, results};
writeFileSync(new URL('./random-walk-results.json',import.meta.url),JSON.stringify(report,null,2));
console.log(JSON.stringify({commands, games:results.length, completed:results.filter(r=>r.status==='completed').length, failed:results.filter(r=>r.status==='FAIL')},null,2));

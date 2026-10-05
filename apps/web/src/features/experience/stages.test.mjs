import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { survivorSnapshot, eliminatedSnapshot, forbiddenSentinels } from '../game-table/game-table.fixtures.mjs';
let vite, ReactionPrompt, GameExperience, MatchPage;
before(async () => {
  vite = await createServer({ configFile: 'apps/web/vite.config.ts', root: 'apps/web', appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } });
  ({ ReactionPrompt } = await vite.ssrLoadModule('/src/features/reactions/ReactionPrompt.tsx'));
  ({ GameExperience } = await vite.ssrLoadModule('/src/features/experience/GameExperience.tsx'));
  ({ MatchPage } = await vite.ssrLoadModule('/src/app/pages.tsx'));
});
after(async () => { await vite?.close(); });
const card = { cardInstanceId: 'public-choice', typeId: 'beer', rank: '6', suit: 'HEARTS' };
const pending = (view, kind, options = []) => ({ interactionId: 'test-choice', kind, currentResponderPlayerId: view.viewer.playerId, allowedChoices: options.map(o => o.choice), responseOptions: options, step: { current: 1, total: 1 } });
const render = view => renderToStaticMarkup(createElement(ReactionPrompt, { matchId: 'experience-test', version: 8, snapshot: view, transport: {} }));
test('Indians explains its effect and shows public damage/card choices without ordered waiting copy',()=>{
  const view=structuredClone(survivorSnapshot);view.pendingInteraction=pending(view,'INDIANS_RESPONSE',[]);
  view.publicTable.tablewideAttack={attackId:'indians-test',kind:'indians',sourcePlayerId:'player-sheriff',targets:[{playerId:view.viewer.playerId,status:'submitted',response:'USE_BANG'},{playerId:'player-four',status:'resolved',response:'TAKE_HIT'}]};
  const markup=render(view);assert.match(markup,/카드 효과/);assert.match(markup,/각 생존자는 뱅 1장을 버리거나 피해 1/);assert.match(markup,/뱅! 선택/);assert.match(markup,/♥ −1/);assert.match(markup,/순서를 기다리지 않고/);assert.doesNotMatch(markup,/제출 완료|대응 대기|님이 응답 중/);
});

test('shared store offers only the current picker a take button; observers see public cards', () => {
  const view = structuredClone(survivorSnapshot);
  view.pendingInteraction = pending(view, 'GENERAL_STORE_PICK', [{ interactionId: 'test-choice', choice: 'CHOOSE_CARD', selectedCardInstanceId: card.cardInstanceId }]);
  view.publicTable.generalStoreCards = [card];
  const own = render(view);
  assert.match(own, /<dialog[^>]*aria-modal="true"/);
  assert.match(own, /가져오기/);
  assert.match(own, /잡화점 선택 순서/);
  for (const other of ['active', 'eliminated_observer']) {
    const observer = structuredClone(view); observer.viewer = { ...observer.viewer, playerId: 'player-four', mode: other }; observer.selfPrivate = null;
    delete observer.pendingInteraction.responseOptions; observer.pendingInteraction.allowedChoices = [];
    const markup = render(observer);
    assert.match(markup, /맥주 카드 그림/);
    assert.doesNotMatch(markup, /가져오기|public-choice/);
    for (const sentinel of forbiddenSentinels) assert.equal(markup.includes(sentinel), false);
  }
});

test('Kit private choice opens a stage only for its authenticated picker', () => {
  const view = structuredClone(survivorSnapshot);
  view.pendingInteraction = { ...pending(view, 'KIT_CARLSON_PICK', [{ interactionId: 'test-choice', choice: 'CHOOSE_CARD', selectedCardInstanceId: card.cardInstanceId }]), choiceCards: [card] };
  assert.match(render(view), /<dialog[^>]*choice-stage__dialog/);
  const other = structuredClone(view); other.viewer.playerId = 'player-four'; other.selfPrivate = null;
  delete other.pendingInteraction.responseOptions; delete other.pendingInteraction.choiceCards;
  assert.doesNotMatch(render(other), /<dialog|맥주 카드 그림|public-choice/);
});

test('Lucky judgments are public while response options stay with Lucky', () => {
  const view = structuredClone(survivorSnapshot);
  view.pendingInteraction = pending(view, 'LUCKY_DRAW', [{ interactionId: 'test-choice', choice: 'CHOOSE_CARD', selectedCardInstanceId: card.cardInstanceId }]);
  view.publicTable.luckyJudgment = { sourceKind: 'barrel', cards: [card] };
  const other = structuredClone(view); other.viewer.playerId = 'player-four'; other.selfPrivate = null;
  delete other.pendingInteraction.responseOptions;
  const markup = render(other);
  assert.match(markup, /<dialog[^>]*choice-stage__dialog/);
  assert.match(markup, /맥주 카드 그림/);
  assert.doesNotMatch(markup, /응답 선택지|public-choice/);
});

test('the eliminated owner may finish server-authorized discard ordering, then becomes an observer', () => {
  const view = structuredClone(eliminatedSnapshot);
  view.pendingInteraction = { ...pending(view, 'DISCARDS_ORDER', [{ interactionId: 'test-choice', choice: 'ORDER_CARDS' }]), discardOrder: { requiredCount: 1, allowedCards: [card] } };
  const markup = render(view);
  assert.match(markup, /aria-label="맥주, 6 하트, 버릴 순서에 추가"/);
  assert.doesNotMatch(markup, /<button[^>]*aria-label="맥주, 6 하트, 버릴 순서에 추가"[^>]*disabled/);
  view.status = 'completed';
  assert.match(render(view), /<button[^>]*aria-label="맥주, 6 하트, 버릴 순서에 추가"[^>]*disabled/);
});

test('mobile navigation points to my response only when I am the responder and is absent for observers', () => {
  const markup = view => renderToStaticMarkup(createElement(GameExperience, { version: 1, snapshot: view, visibleEvents: [] }, createElement('div', null, 'table')));
  const own = structuredClone(survivorSnapshot); own.pendingInteraction = pending(own, 'BANG_RESPONSE');
  assert.match(markup(own), /href="#reaction-prompt-title">내 응답/);
  own.pendingInteraction.currentResponderPlayerId = 'player-four';
  assert.match(markup(own), /href="#game-actions-title">내 손패/);
  assert.doesNotMatch(markup(eliminatedSnapshot), /게임 화면 바로가기/);
});

test('observer page has a full public table without empty hand/actions, but keeps authorized final discards and shared store', () => {
  const markup = view => renderToStaticMarkup(createElement(MatchPage, { matchId: 'experience-test', version: 8, snapshot: view, visibleEvents: [], showActions: true, transport: {} }));
  const observer = structuredClone(eliminatedSnapshot);
  assert.match(markup(observer), /탈락 · 경기를 지켜보고 있어요/);
  assert.doesNotMatch(markup(observer), /id="game-actions-title"|행동 입력/);
  observer.pendingInteraction = { ...pending(observer, 'DISCARDS_ORDER', [{ interactionId: 'test-choice', choice: 'ORDER_CARDS' }]), discardOrder: { requiredCount: 1, allowedCards: [card] } };
  assert.match(markup(observer), /버릴 카드 후보/);
  observer.pendingInteraction = { ...pending(observer, 'GENERAL_STORE_PICK'), currentResponderPlayerId: 'player-sheriff' };
  delete observer.pendingInteraction.responseOptions;
  observer.publicTable.generalStoreCards = [card];
  assert.match(markup(observer), /잡화점에 남은 공개 카드/);
  assert.doesNotMatch(markup(observer), /가져오기|id="game-actions-title"/);
});

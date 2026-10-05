import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {createServer} from 'vite';
import {createElement as h} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
let vite, GameExperience, GameScene;
before(async()=>{vite=await createServer({configFile:'apps/web/vite.config.ts',root:'apps/web',appType:'custom',logLevel:'silent',server:{middlewareMode:true}});({GameExperience}=await vite.ssrLoadModule('/src/features/experience/GameExperience.tsx'));({GameScene}=await vite.ssrLoadModule('/src/features/game-scene/GameScene.tsx'));});
after(async()=>{await vite?.close();});
import {sceneSeatPosition} from './layout.ts';
import {survivorSnapshot,eliminatedSnapshot,forbiddenSentinels} from '../game-table/game-table.fixtures.mjs';
const render=snapshot=>renderToStaticMarkup(h(GameExperience,{scene:true,version:1,snapshot,visibleEvents:[]},h(GameScene,{snapshot,version:1,matchId:'test-match',visibleEvents:[],showActions:true,transport:{}})));
test('4–7 seats use explicit clockwise centers with self at the bottom',()=>{
  for(const count of [4,5,6,7]){const points=Array.from({length:count},(_,i)=>sceneSeatPosition(i,count));assert.deepEqual(points[0],{left:'50%',top:'88%'});assert.equal(new Set(points.map(p=>JSON.stringify(p))).size,count);assert.ok(parseFloat(points[1].left)<50);assert.ok(parseFloat(points.at(-1).left)>50);}
});
test('one persistent scene has menu, public table and private hand without web page panels',()=>{
  const view=structuredClone(survivorSnapshot);view.legalActions=[];const markup=render(view);
  assert.match(markup,/game-scene/);assert.match(markup,/scene-hand-dock/);assert.match(markup,/시계 방향 게임 테이블/);assert.match(markup,/경기 메뉴/);assert.doesNotMatch(markup,/게임 화면 바로가기|현재 판|게임 진행|게임 규칙은 서버/);
});
test('inspection host is outside compact seats, hand and action regions with no eagerly mounted dialogs',()=>{
  const markup=render(survivorSnapshot);
  assert.match(markup,/<\/footer>(?:<div[^>]*><\/div>)*<div class="scene-inspections"><\/div><\/div><\/div>$/);
  assert.doesNotMatch(markup,/<dialog/);
});
test('scene never renders hidden opponent role, card identities or deck contents',()=>{const markup=render(survivorSnapshot);for(const secret of forbiddenSentinels)assert.equal(markup.includes(secret),false);assert.doesNotMatch(markup,/deckCount|privateResolutionContext/);});
test('opponent hand back icons exactly reflect public counts, including more than 80',()=>{const view=structuredClone(survivorSnapshot);view.publicTable.players[0].handCount=81;const markup=render(view);assert.equal((markup.match(/class="scene-seat__hand"/g)??[]).length,4);const first=markup.match(/aria-label="손패 81장"[^>]*>(.*?)<\/span>/s);assert.ok(first);assert.equal((first[1].match(/<i /g)??[]).length,81);});
test('public distance and role use authenticated projection while own HUD shows own role',()=>{const markup=render(survivorSnapshot);assert.match(markup,/나에게서 거리/);assert.match(markup,/배신자/);assert.match(markup,/보안관/);assert.match(markup,/역할 비공개/);});
test('observer retains public scene without any private hand input',()=>{const markup=render(eliminatedSnapshot);assert.match(markup,/탈락 · 경기를 지켜보고 있어요/);assert.doesNotMatch(markup,/id="game-actions-title"|내 손패에서 카드 선택/);});
test('zero healing beer retains confirmation and image selection uses legal candidates',()=>{const view=structuredClone(survivorSnapshot);view.publicTable.turn.currentPlayerId=view.viewer.playerId;view.legalActions=[{type:'PLAY_CARD',payload:{cardInstanceId:view.selfPrivate.hand[0].cardInstanceId}},{type:'END_TURN',payload:{}}];const markup=render(view);assert.match(markup,/맥주 선택/);assert.match(markup,/차례 마치기/);assert.doesNotMatch(markup,/맥주 6 하트, 사용 가능/);});
test('every projected response uses the inline table area including ordered discard',()=>{const view=structuredClone(survivorSnapshot);view.pendingInteraction={kind:'DISCARDS_ORDER',interactionId:'discard',currentResponderPlayerId:view.viewer.playerId,step:{current:1,total:1},allowedChoices:['ORDER_CARDS'],responseOptions:[{interactionId:'discard',choice:'ORDER_CARDS'}],discardOrder:{requiredCount:1,allowedCards:view.selfPrivate.hand}};const markup=render(view);assert.match(markup,/scene-center/);assert.match(markup,/class="table-stage"/);assert.match(markup,/버릴 카드 후보/);assert.doesNotMatch(markup,/choice-stage__dialog|게임판 보기|aria-modal="true"/);});
test('first scene render is silent and exposes no history animation',()=>{const markup=render(survivorSnapshot);assert.doesNotMatch(markup,/data-last-sound|scene-card-flight|table-effects--shot/);});

test('scene store has a nonmodal shared table area for picker and observers',()=>{
  const view=structuredClone(survivorSnapshot),card={cardInstanceId:'store-public',typeId:'beer',rank:'6',suit:'HEARTS'};
  view.pendingInteraction={kind:'GENERAL_STORE_PICK',interactionId:'store',currentResponderPlayerId:view.viewer.playerId,step:{current:1,total:4},allowedChoices:['CHOOSE_CARD'],responseOptions:[{interactionId:'store',choice:'CHOOSE_CARD',selectedCardInstanceId:card.cardInstanceId}]};view.publicTable.generalStoreCards=[card];
  const own=render(view);assert.match(own,/class="table-stage"/);assert.match(own,/맥주, 6 하트 가져오기/);assert.doesNotMatch(own,/choice-stage__dialog|aria-modal="true"|게임판 보기/);
  view.viewer.playerId='player-four';view.selfPrivate=null;delete view.pendingInteraction.responseOptions;view.pendingInteraction.allowedChoices=[];
  const observer=render(view);assert.match(observer,/class="table-stage"/);assert.match(observer,/맥주 카드 그림/);assert.doesNotMatch(observer,/가져오기|store-public|aria-modal="true"/);
});

test('all projected request kinds use a visible inline region without a close or reopen step',()=>{
  for(const kind of ['BANG_RESPONSE','GATLING_RESPONSE','INDIANS_RESPONSE','DUEL_RESPONSE','DEATH_RESCUE','LUCKY_DRAW','KIT_CARLSON_PICK','PEDRO_DISCARD_TOP','JESSE_DRAW_SOURCE']){
    const view=structuredClone(survivorSnapshot);view.pendingInteraction={kind,interactionId:'request:'+kind,currentResponderPlayerId:view.viewer.playerId,step:{current:1,total:1},allowedChoices:[],responseOptions:[]};
    const markup=render(view);assert.match(markup,/class="table-stage"/,kind);assert.doesNotMatch(markup,/choice-stage__dialog|aria-modal="true"|게임판 보기|카드 펼쳐 보기/,kind);
  }
});

test('tablewide response preserves private choices and shared progress without a dialog',()=>{
  const view=structuredClone(survivorSnapshot);view.pendingInteraction={kind:'GATLING_RESPONSE',interactionId:'attack:self',currentResponderPlayerId:view.viewer.playerId,step:{current:1,total:1},allowedChoices:['TAKE_HIT'],responseOptions:[{interactionId:'attack:self',choice:'TAKE_HIT'}]};
  view.publicTable.tablewideAttack={attackId:'attack',kind:'gatling',sourcePlayerId:'player-sheriff',targets:[{playerId:view.viewer.playerId,status:'waiting'},{playerId:'player-four',status:'submitted'}]};
  const markup=render(view);assert.match(markup,/광역 공격 대응 상황/);assert.match(markup,/선택함/);assert.match(markup,/응답 선택지/);assert.doesNotMatch(markup,/choice-stage__dialog|aria-modal="true"|대응 대기|제출 완료/);
});

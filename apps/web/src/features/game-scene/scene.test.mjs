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
test('scene never renders hidden opponent role, card identities or deck contents',()=>{const markup=render(survivorSnapshot);for(const secret of forbiddenSentinels)assert.equal(markup.includes(secret),false);assert.doesNotMatch(markup,/deckCount|privateResolutionContext/);});
test('opponent hand back icons exactly reflect public counts, including more than 80',()=>{const view=structuredClone(survivorSnapshot);view.publicTable.players[0].handCount=81;const markup=render(view);assert.equal((markup.match(/class="scene-seat__hand"/g)??[]).length,4);const first=markup.match(/aria-label="손패 81장"[^>]*>(.*?)<\/span>/s);assert.ok(first);assert.equal((first[1].match(/<i /g)??[]).length,81);});
test('public distance and role use authenticated projection while own HUD shows own role',()=>{const markup=render(survivorSnapshot);assert.match(markup,/나에게서 거리/);assert.match(markup,/배신자/);assert.match(markup,/보안관/);assert.match(markup,/역할 비공개/);});
test('observer retains public scene without any private hand input',()=>{const markup=render(eliminatedSnapshot);assert.match(markup,/탈락 · 경기를 지켜보고 있어요/);assert.doesNotMatch(markup,/id="game-actions-title"|내 손패에서 카드 선택/);});
test('zero healing beer retains confirmation and image selection uses legal candidates',()=>{const view=structuredClone(survivorSnapshot);view.publicTable.turn.currentPlayerId=view.viewer.playerId;view.legalActions=[{type:'PLAY_CARD',payload:{cardInstanceId:view.selfPrivate.hand[0].cardInstanceId}},{type:'END_TURN',payload:{}}];const markup=render(view);assert.match(markup,/맥주 선택/);assert.match(markup,/차례 마치기/);assert.doesNotMatch(markup,/맥주 6 하트, 사용 가능/);});
test('every projected response uses a central scene dialog including ordered discard',()=>{const view=structuredClone(survivorSnapshot);view.pendingInteraction={kind:'DISCARDS_ORDER',interactionId:'discard',currentResponderPlayerId:view.viewer.playerId,step:{current:1,total:1},allowedChoices:['ORDER_CARDS'],responseOptions:[{interactionId:'discard',choice:'ORDER_CARDS'}],discardOrder:{requiredCount:1,allowedCards:view.selfPrivate.hand}};const markup=render(view);assert.match(markup,/choice-stage__dialog/);assert.match(markup,/버릴 카드 후보/);assert.match(markup,/게임판 보기/);});
test('first scene render is silent and exposes no history animation',()=>{const markup=render(survivorSnapshot);assert.doesNotMatch(markup,/data-last-sound|scene-card-flight|table-effects--shot/);});

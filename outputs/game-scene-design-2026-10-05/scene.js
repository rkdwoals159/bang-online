const $ = id => document.getElementById(id);
const asset = (type, name) => '../../apps/site/public/assets/cards/'+type+'/01_'+name+'.png';
const cards = [
 {name:'뱅!',file:'bang',kind:'bang',description:'사거리 안의 상대 한 명을 공격해요. 상대는 빗나감!으로 피할 수 있어요.'},
 {name:'빗나감!',file:'mancato',kind:'missed',description:'뱅! 또는 개틀링 공격을 피해요. 대응이 필요할 때 사용해요.'},
 {name:'맥주',file:'birra',kind:'heal',description:'생명력을 1 회복해요. 생존자가 둘이면 효과가 없어요.'},
 {name:'개틀링',file:'gatling',kind:'gatling',description:'나를 제외한 모든 플레이어를 공격해요. 각자 빗나감!으로 피할 수 있어요.'},
 {name:'인디언',file:'indiani',kind:'indians',description:'나를 제외한 모두가 뱅! 한 장을 버리거나 생명력 1을 잃어요.'},
 {name:'잡화점',file:'emporio',kind:'store',description:'생존자 수만큼 카드를 공개하고, 사용한 사람부터 시계방향으로 하나씩 가져가요.'},
 {name:'술통',file:'barile',kind:'equip',description:'내 앞에 놓아요. 뱅! 공격마다 판정해 하트가 나오면 피할 수 있어요.'}
];
const people=[
 {name:'나',character:'윌리 더 키드',file:'willythekid',hp:5,max:5,hand:7},
 {name:'서부의 별',character:'캘러미티 재닛',file:'calamityjanet',hp:4,max:4,hand:4},
 {name:'먼지바람',character:'블랙 잭',file:'blackjack',hp:4,max:4,hand:3},
 {name:'밤의 보안관',character:'제시 존스',file:'jessejones',hp:4,max:4,hand:5},
 {name:'붉은 석양',character:'바트 캐시디',file:'bartcassidy',hp:4,max:4,hand:2},
 {name:'황금 탄환',character:'로즈 둘런',file:'rosedoolan',hp:4,max:4,hand:4},
 {name:'마지막 한 발',character:'엘 그링고',file:'elgringo',hp:4,max:4,hand:3}
];
const coordinates={
 4:[[50,88],[13,51],[50,13],[87,51]],
 5:[[50,88],[15,63],[29,17],[71,17],[85,63]],
 6:[[50,88],[13,64],[23,23],[50,11],[77,23],[87,64]],
 7:[[50,88],[13,70],[17,36],[37,13],[63,13],[83,36],[87,70]]
};
let count=7,selected=0,turn=0,sound=false,motion=true,generation=0,busy=false,chooseTarget=false,events=[],timer=null,audio;
const timers=new Set();
const delay=(fn,ms)=>{const gen=generation;const t=setTimeout(()=>{timers.delete(t);if(gen===generation)fn();},ms);timers.add(t);return t;};
const animated=()=>motion&&!matchMedia('(prefers-reduced-motion: reduce)').matches;
function animate(el,keyframes,options){
 if(!animated()){const final=keyframes.at(-1);Object.assign(el.style,final);return {finished:Promise.resolve()};}
 return el.animate(keyframes,options);
}
function cleanup(){generation++;for(const t of timers)clearTimeout(t);timers.clear();$('fx').replaceChildren();document.querySelectorAll('.seat').forEach(el=>el.getAnimations().forEach(a=>a.cancel()));if($('overlay').open)$('overlay').close();busy=false;chooseTarget=false;$('use').disabled=false;}
function beep(kind){
 if(!sound)return;
 audio??=new (window.AudioContext||window.webkitAudioContext)();
 if(audio.state==='suspended')audio.resume();
 const now=audio.currentTime,osc=audio.createOscillator(),gain=audio.createGain();
 const tones={shot:[110,45,.12],ping:[1800,850,.19],heal:[550,900,.22],card:[260,170,.07],win:[440,880,.4]};
 const [from,to,length]=tones[kind]||tones.card;
 osc.type=kind==='shot'?'sawtooth':'sine';osc.frequency.setValueAtTime(from,now);osc.frequency.exponentialRampToValueAtTime(to,now+length);
 gain.gain.setValueAtTime(kind==='shot'?.055:.04,now);gain.gain.exponentialRampToValueAtTime(.001,now+length);osc.connect(gain).connect(audio.destination);osc.start(now);osc.stop(now+length);
}
function toast(message){$('toast').textContent=message;$('toast').classList.add('show');clearTimeout(timer);timer=setTimeout(()=>$('toast').classList.remove('show'),1900);}
function log(message){events.unshift({time:new Date(),message});events=events.slice(0,30);renderLog();}
function renderLog(){const fragment=document.createDocumentFragment();events.forEach(e=>{const p=document.createElement('p'),time=document.createElement('time');time.dateTime=e.time.toISOString();time.textContent=e.time.toLocaleTimeString('ko-KR',{hour12:false})+'('+Math.max(0,Math.floor((Date.now()-e.time)/1000))+'초 전)';p.append(time,document.createTextNode(' - '+e.message));fragment.append(p);});$('logEntries').replaceChildren(fragment);}
setInterval(()=>{if(!$('log').hidden&&!document.hidden)renderLog();},1000);
function renderSeats(){
 $('seats').replaceChildren();
 for(let i=0;i<count;i++){
  const p=people[i], [x,y]=coordinates[count][i],seat=document.createElement('button');
  seat.className='seat'+(i===0?' self':'')+(i===turn?' is-turn':'');seat.id='seat'+i;seat.style.left=x+'%';seat.style.top=y+'%';seat.setAttribute('aria-label',p.name+' · '+p.character+' · 생명력 '+p.hp+' · 손패 '+p.hand+'장');
  seat.innerHTML='<img class="portrait" src="'+asset('characters',p.file)+'" alt=""><strong>'+p.name+'</strong><span class="subtitle">'+p.character+'</span><div class="hearts" aria-label="생명력">'+ '♥'.repeat(p.hp)+'<span style="opacity:.25">'+ '♥'.repeat(p.max-p.hp)+'</span></div><div class="mini-hand" aria-hidden="true">'+ '<i></i>'.repeat(p.hand)+'</div>'+(i>0?'<span class="distance" title="내게서 거리 '+Math.min(i,count-i)+'">'+Math.min(i,count-i)+'</span>':'');
  seat.addEventListener('click',()=>{if(chooseTarget&&i>0){chooseTarget=false;shoot(0,i,false);updateTargeting();}else detailCharacter(i);});$('seats').append(seat);
 }
 $('selfHearts').textContent='♥'.repeat(people[0].hp);
}
function renderHand(){
 $('hand').replaceChildren();
 cards.forEach((card,i)=>{const b=document.createElement('button');b.className='hand-card'+(i===selected?' selected':'');b.style.setProperty('--rotation',(i-3)*2+'deg');b.setAttribute('aria-label',card.name+' 카드 설명');b.setAttribute('aria-pressed',String(i===selected));b.innerHTML='<img src="'+asset('playing',card.file)+'" alt="'+card.name+'" draggable="false">';
 b.onclick=()=>{if(selected===i)detailCard(card);else{selected=i;chooseTarget=false;renderHand();renderCopy();updateTargeting();beep('card');}};$('hand').append(b);});
 renderCopy();
}
function renderCopy(){const c=cards[selected];$('cardName').textContent=c?.name||'카드를 골라 주세요';$('cardDescription').textContent=c?.description||'';$('use').textContent=c?.kind==='bang'?'상대 선택':'카드 사용';}
function updateTargeting(){document.querySelectorAll('.seat').forEach((el,i)=>el.classList.toggle('targetable',chooseTarget&&i>0));$('hint').textContent=chooseTarget?'공격할 상대를 선택하세요':'카드를 고르고, 상대를 선택하세요';}
function position(id){const a=$(id).getBoundingClientRect(),b=$('board').getBoundingClientRect();return {x:a.left+a.width/2-b.left,y:a.top+a.height/2-b.top};}
function floating(target,text,good=false){const p=position('seat'+target),el=document.createElement('span');el.className='float-label'+(good?' good':'');el.textContent=text;el.style.left=p.x+'px';el.style.top=p.y+'px';$('fx').append(el);animate(el,[{opacity:1,transform:'translate(-50%,-50%) translateY(0)'},{opacity:0,transform:'translate(-50%,-50%) translateY(-50px)'}],{duration:800,easing:'ease-out',fill:'forwards'}).finished.catch(()=>{}).then(()=>el.remove());}
function shoot(source,target,blocked,onDone,burst=false){
 const a=position('seat'+source),b=position('seat'+target),angle=Math.atan2(b.y-a.y,b.x-a.x)*180/Math.PI;
 const fire=()=>{const el=document.createElement('i');el.className='shot';el.style.left=a.x+'px';el.style.top=a.y+'px';$('fx').append(el);beep('shot');
 animate(el,[{transform:'rotate('+angle+'deg)',opacity:1},{transform:'translate('+(b.x-a.x)+'px,'+(b.y-a.y)+'px) rotate('+angle+'deg)',opacity:1}],{duration:240,easing:'ease-in',fill:'forwards'}).finished.catch(()=>{}).then(()=>el.remove());};
 fire();if(burst){delay(fire,80);delay(fire,160);}
 delay(()=>{if(blocked){beep('ping');floating(target,'팅!');log(people[target].name+' · 빗나감!으로 피했어요');}else{people[target].hp=Math.max(1,people[target].hp-1);floating(target,'−1');log(people[target].name+' · 생명력 1 감소');}
 renderSeats();const seat=$('seat'+target);if(animated())animate(seat,[{transform:'translate(-50%,-50%) translateX(0)'},{transform:'translate(-50%,-50%) translateX(-7px)'},{transform:'translate(-50%,-50%) translateX(5px)'},{transform:'translate(-50%,-50%) translateX(0)'}],{duration:240});
 onDone?.();},burst?420:250);
}
function fly(file,from,to,done){const a=position(from),b=position(to),el=document.createElement('img');el.src=asset('playing',file);el.className='fly-card';el.alt='';el.style.left=(a.x-29)+'px';el.style.top=(a.y-42)+'px';$('fx').append(el);beep('card');animate(el,[{transform:'translate(0,0) rotate(-8deg)',opacity:1},{transform:'translate('+(b.x-a.x)+'px,'+(b.y-a.y)+'px) rotate(8deg)',opacity:.8}],{duration:440,easing:'cubic-bezier(.2,.8,.2,1)',fill:'forwards'}).finished.catch(()=>{}).then(()=>el.remove());delay(()=>done?.(),450);}
function showDialog(markup){if($('overlay').open)$('overlay').close();$('dialogContent').innerHTML=markup;const title=$('dialogContent').querySelector('h2');if(title){title.id='dialogTitle';$('overlay').setAttribute('aria-labelledby','dialogTitle');}$('overlay').showModal();}
function detailCard(card){showDialog('<h2>'+card.name+'</h2><div class="card-detail"><img src="'+asset('playing',card.file)+'" alt="'+card.name+'"><div><p>'+card.description+'</p><p class="intro">카드 사용은 아래 손패에서 선택할 수 있어요.</p></div></div>');}
function detailCharacter(i){const p=people[i];showDialog('<h2>'+p.character+'</h2><div class="card-detail"><img src="'+asset('characters',p.file)+'" alt="'+p.character+'"><div><p>'+ (i===0?'내 차례에 뱅! 카드를 여러 번 사용할 수 있어요.':'인물 설명은 실제 게임의 인물 규칙 정본으로 표시합니다. 이 시안은 테이블과 연출을 확인하기 위한 화면이에요.')+'</p></div></div>');}
function groupAttack(kind){
 cleanup();busy=true;$('use').disabled=true;
 const targets=Array.from({length:count},(_,i)=>i).filter(i=>i!==1);
 showDialog('<h2>'+ (kind==='gatling'?'개틀링!':'인디언!')+'</h2><p class="intro">'+people[1].name+'의 공격 · 각자 지금 대응할 수 있어요.<br>시안에서는 상대의 대응을 자동으로 연출합니다.</p><div class="responses">'+targets.map(i=>'<div class="response" id="response'+i+'" data-status="waiting"><strong>'+people[i].name+'</strong><span>대응 선택 중</span></div>').join('')+'</div><div class="response-actions"><img src="'+asset('playing',kind==='gatling'?'mancato':'bang')+'" alt="'+(kind==='gatling'?'빗나감!':'뱅!')+'"><button class="primary" id="defend">'+(kind==='gatling'?'빗나감!으로 피하기':'뱅! 버리기')+'</button><button id="takeHit">생명력 1 잃기</button></div>');
 $('close').hidden=true;log(people[1].name+' · '+(kind==='gatling'?'개틀링':'인디언')+' 사용');
 let answered=0;
 const respond=(i,blocked)=>{if(!$('response'+i))return;const box=$('response'+i);box.dataset.status='done';box.querySelector('span').textContent=blocked?'방어 선택 완료':'피해 선택 완료';answered++;
  if(kind==='gatling')shoot(1,i,blocked,undefined,true);else{if(blocked){beep('ping');floating(i,'뱅!');}else{people[i].hp=Math.max(1,people[i].hp-1);renderSeats();floating(i,'−1');}}
  if(answered===targets.length)delay(()=>{$('overlay').close();$('close').hidden=false;busy=false;$('use').disabled=false;toast('모두의 대응이 끝났어요');},1000);
 };
 targets.filter(i=>i!==0).forEach((i,k)=>delay(()=>respond(i,k%3!==1),650+k*420));
 const own=blocked=>{if($('defend').disabled)return;$('defend').disabled=true;$('takeHit').disabled=true;respond(0,blocked);};
 $('defend').onclick=()=>own(true);$('takeHit').onclick=()=>own(false);
}
function store(){
 cleanup();busy=true;$('use').disabled=true;
 const picks=cards.slice(0,count);let pick=0;
 showDialog('<h2>잡화점</h2><p class="intro" id="storeHint">내 차례예요. 가져갈 카드를 골라 주세요.</p><div class="store-cards">'+picks.map((c,i)=>'<button class="store-card" style="--i:'+i+'" data-index="'+i+'" aria-label="'+c.name+' 가져가기"><img src="'+asset('playing',c.file)+'" alt="'+c.name+'"><span>'+c.name+'</span></button>').join('')+'</div><div class="responses">'+Array.from({length:count},(_,i)=>'<div class="response" id="pick'+i+'"><strong>'+people[i].name+'</strong><span>'+(i===0?'카드 선택 중':'기다리는 중')+'</span></div>').join('')+'</div>');
 $('close').hidden=true;
 const take=(i,cardIndex)=>{const b=document.querySelector('[data-index="'+cardIndex+'"]');const from=b.querySelector('img').getBoundingClientRect(),to=$('pick'+i).getBoundingClientRect(),copy=b.querySelector('img').cloneNode();copy.className='fly-card';copy.style.position='fixed';copy.style.left=from.left+'px';copy.style.top=from.top+'px';$('overlay').append(copy);animate(copy,[{transform:'translate(0,0) scale(1)',opacity:1},{transform:'translate('+(to.left+to.width/2-from.left)+'px,'+(to.top-from.top)+'px) scale(.35)',opacity:0}],{duration:450,easing:'ease-out',fill:'forwards'}).finished.catch(()=>{}).then(()=>copy.remove());b.disabled=true;b.classList.add('taken');$('pick'+i).dataset.status='done';$('pick'+i).querySelector('span').textContent=picks[cardIndex].name+' 획득';beep('card');people[i].hand++;renderSeats();log(people[i].name+' · '+picks[cardIndex].name+' 획득');
 if(i===count-1)delay(()=>{$('overlay').close();$('close').hidden=false;busy=false;$('use').disabled=false;toast('잡화점 선택 완료');},900);};
 document.querySelectorAll('.store-card').forEach(b=>b.onclick=()=>{if(pick!==0)return;pick=1;take(0,Number(b.dataset.index));$('storeHint').textContent='시계방향으로 하나씩 가져가요.';const remaining=picks.map((_,i)=>i).filter(i=>i!==Number(b.dataset.index));remaining.forEach((ci,k)=>delay(()=>take(k+1,ci),800+k*650));});
}
function run(kind){
 cleanup();$('close').hidden=false;
 if(kind==='bang'){log('나 · 뱅! 사용');shoot(0,Math.min(2,count-1),false);$('played').querySelector('img').src=asset('playing','bang');}
 else if(kind==='gatling'||kind==='indians')groupAttack(kind);
 else if(kind==='store')store();
 else if(kind==='draw'){fly('bang','deck','seat0',()=>{people[0].hand++;renderSeats();toast('카드 2장 뽑기');});delay(()=>fly('birra','deck','seat0',()=>{people[0].hand++;renderSeats();log('나 · 카드 2장 뽑기');}),130);}
 else if(kind==='heal'){if(people[0].hp===people[0].max)people[0].hp--;delay(()=>{people[0].hp++;renderSeats();floating(0,'+1',true);beep('heal');log('나 · 맥주로 생명력 1 회복');},100);}
 else if(kind==='turn'){turn=(turn+1)%count;renderSeats();$('turnCaption').textContent=turn===0?'당신의 차례':people[turn].name+'의 차례';log(people[turn].name+' · 차례 시작');}
 else if(kind==='role')showDialog('<h2>당신은 보안관</h2><div class="role-reveal"><img src="'+asset('roles','sceriffo')+'" alt="보안관"><div><strong>모두가 당신을 알고 있어요.</strong><p>무법자와 배신자를 모두 제거하세요. 부관은 당신 편이에요.</p><button class="primary" id="enter">게임판으로</button></div></div>'),$('enter').onclick=()=>$('overlay').close();
 else if(kind==='win'){beep('win');showDialog('<div class="victory"><div class="medal">BANG!</div><h2>보안관 팀 승리</h2><p class="intro">끝까지 살아남은 서부의 주인공</p><button class="primary" id="again">테이블로 돌아가기</button></div>');$('again').onclick=()=>$('overlay').close();}
 else if(kind==='equip'){fly('barile','seat0','played',()=>{log('나 · 술통 장착');toast('술통을 내 앞에 놓았어요');});}
}
$('play').onclick=()=>run($('demo').value);
$('count').onchange=()=>{cleanup();$('close').hidden=false;count=Number($('count').value);turn=0;people.forEach(p=>p.hp=p.max);$('turnCaption').textContent='당신의 차례';renderSeats();renderHand();updateTargeting();log(count+'인 테이블');};
$('sound').onclick=()=>{sound=!sound;$('sound').textContent=sound?'소리 켜짐':'소리 켜기';$('sound').setAttribute('aria-pressed',String(sound));if(sound)beep('ping');};
$('motion').onclick=()=>{motion=!motion;document.body.classList.toggle('motion-off',!motion);$('motion').textContent=motion?'모션 켜짐':'모션 줄임';$('motion').setAttribute('aria-pressed',String(motion));};
$('cancel').onclick=()=>{chooseTarget=false;updateTargeting();toast('선택을 취소했어요');};
$('use').onclick=()=>{if(busy)return;const kind=cards[selected]?.kind;if(kind==='bang'){chooseTarget=!chooseTarget;updateTargeting();}else if(kind==='missed')toast('공격을 받을 때 대응으로 사용할 수 있어요');else run(kind);};
$('end').onclick=()=>run('turn');$('character').onclick=()=>detailCharacter(0);
$('close').onclick=()=>$('overlay').close();$('overlay').addEventListener('cancel',event=>{if(busy){event.preventDefault();toast('내 대응을 먼저 선택해 주세요');}});
$('overlay').addEventListener('close',()=>{if(!busy)$('close').hidden=false;});
$('logToggle').onclick=()=>{$('log').hidden=!$('log').hidden;$('logToggle').setAttribute('aria-expanded',String(!$('log').hidden));renderLog();};
$('full').onclick=async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await document.querySelector('.game').requestFullscreen?.();}catch{toast('이 환경에서는 전체 화면을 열 수 없어요');}};
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&chooseTarget){chooseTarget=false;updateTargeting();}});
renderSeats();renderHand();log('보안관의 차례 시작');


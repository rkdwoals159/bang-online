from pathlib import Path
import json,csv,re
out=Path('outputs/development-plan/data');out.mkdir(parents=True,exist_ok=True)
ranks=['2','3','4','5','6','7','8','9','10','J','Q','K','A']
def seq(a,b,s):return [(r,s) for r in ranks[ranks.index(a):ranks.index(b)+1]]
rows=[
('barrel','Barrel','barile',[('Q','S'),('K','S')]),
('dynamite','Dynamite','dinamite',[('2','H')]),
('jail','Jail','prigione',[('J','S'),('4','H'),('10','S')]),
('mustang','Mustang','mustang',[('8','H'),('9','H')]),
('remington','Remington','remington',[('K','C')]),
('carabine','Rev. Carabine','carabine',[('A','C')]),
('schofield','Schofield','schofield',[('J','C'),('Q','C'),('K','S')]),
('scope','Scope','mirino',[('A','S')]),
('volcanic','Volcanic','volcanic',[('10','S'),('10','C')]),
('winchester','Winchester','winchester',[('8','S')]),
('bang','BANG!','bang',[('A','S')]+seq('2','A','D')+seq('2','9','C')+seq('Q','A','H')),
('beer','Beer','birra',seq('6','J','H')),
('cat_balou','Cat Balou','catbalou',[('K','H')]+seq('9','J','D')),
('duel','Duel','duello',[('Q','D'),('J','S'),('8','C')]),
('gatling','Gatling','gatling',[('10','H')]),
('general_store','General Store','emporio',[('9','C'),('Q','S')]),
('indians','Indians!','indiani',[('K','D'),('A','D')]),
('missed','Missed!','mancato',seq('10','A','C')+seq('2','8','S')),
('panic','Panic!','panico',seq('J','Q','H')+[('A','H'),('8','D')]),
('saloon','Saloon','saloon',[('5','H')]),
('stagecoach','Stagecoach','diligenza',[('9','S'),('9','S')]),
('wells_fargo','Wells Fargo','wellsfargo',[('3','H')])]
suits={'S':'SPADES','H':'HEARTS','D':'DIAMONDS','C':'CLUBS'}
deck=[];types=[]
for idx,(id,name,file,cards) in enumerate(rows):
 types.append(dict(typeId=id,nameEn=name,count=len(cards),border='BLUE' if idx<10 else 'BROWN',assetPath=f'../assets/cards/playing/01_{file}.png',source='S3'))
 for n,(rank,suit) in enumerate(cards,1):deck.append(dict(definitionId=f'{id}_{n:02}',typeId=id,rank=rank,suit=suits[suit],copyIndex=n))
def save(name,data): (out/name).write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
save('base-deck.json',{'rulesetVersion':'base4-ko-online-1.0','sourceUrl':'https://bang.dvgiochi.com/cardslist.php?id=1&lang=en','cards':deck})
save('card-types.json',types)
names=['Bart Cassidy','Black Jack','Calamity Janet','El Gringo','Jesse Jones','Jourdonnais','Kit Carlson','Lucky Duke','Paul Regret','Pedro Ramirez','Rose Doolan','Sid Ketchum','Slab the Killer','Suzy Lafayette','Vulture Sam','Willy the Kid']
chars=[]
for n,name in enumerate(names,1):
 file='slab' if name=='Slab the Killer' else name.lower().replace(' ','')
 chars.append(dict(characterId=name.lower().replace(' ','_'),nameEn=name,baseMaxHp=3 if name in ['El Gringo','Paul Regret'] else 4,ruleId=f'C{n:02}',assetPath=f'../assets/cards/characters/01_{file}.png'))
save('characters.json',chars)
save('roles.json',{'types':[dict(roleId=i,assetPath=f'../assets/cards/roles/01_{f}.png') for i,f in [('sheriff','sceriffo'),('deputy','vice'),('outlaw','fuorilegge'),('renegade','rinnegato')]],'countsByPlayers':{'4':[1,0,2,1],'5':[1,1,2,1],'6':[1,1,3,1],'7':[1,2,3,1]},'countOrder':['sheriff','deputy','outlaw','renegade']})
with (out/'base-deck.csv').open('w',encoding='utf-8-sig',newline='') as f:
 w=csv.DictWriter(f,fieldnames=list(deck[0]));w.writeheader();w.writerows(deck)
save('catalog-summary.json',{'cardCount':len(deck),'typeCount':len(types),'characterCount':len(chars),'roleTypeCount':4,'note':'definitionId is public catalogue identity, never use it as a hidden runtime cardInstanceId. Asset paths are relative to development-plan/, not data/. Images contain printed rank/suit and must be masked or illustration-cropped before instance overlays.'})

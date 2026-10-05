"""Prepare controlled visual review states in the local Sites D1 database only.

Run from repository root: python scripts/local-design-fixture.py ROOM_ID play
Supports play, experience, critical, completed, observer, paused; explicitly reload the QA browser after use.
These fixtures verify UI states, not acceptance scenarios or a natural complete game.
"""
import copy
import json
import sqlite3
import sys
from pathlib import Path

room_id, mode = sys.argv[1:3]
if mode not in ('play', 'experience', 'critical', 'completed', 'observer', 'paused'):
    raise ValueError('Unknown visual review mode')
database = Path('apps/site/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/faaf2b0445ab934c3aac48ddf0cdfade8f9bac050be98993748742cdd2cb05fb.sqlite').resolve()
expected = Path('apps/site/.wrangler/state').resolve()
if not database.is_relative_to(expected) or not database.is_file():
    raise ValueError('Local Sites database is required')
connection = sqlite3.connect(database, timeout=30)
connection.execute('BEGIN IMMEDIATE')
row = connection.execute('SELECT id,version,state_json,event_seq FROM matches WHERE room_id=? ORDER BY started_at DESC LIMIT 1', (room_id,)).fetchone()
if not row:
    raise ValueError('No local match for that room')
current = json.loads(row[2])
reviewer = next((s for s in current['seats'] if s['public']['displayName'].startswith('디자인 검증')), None)
if not reviewer:
    raise ValueError('Only agent-created design review rooms may be changed')
baseline_path = Path('.sites-runtime/design-fixtures') / (room_id + '.json')
baseline_path.parent.mkdir(parents=True, exist_ok=True)
if not baseline_path.exists():
    baseline_path.write_text(row[2], encoding='utf-8')
state = copy.deepcopy(json.loads(baseline_path.read_text(encoding='utf-8')))
reviewer = next(s for s in state['seats'] if s['public']['playerId'] == reviewer['public']['playerId'])
zones = state['zones']
def remove_card(card_id):
    for name in ('drawPileCardInstanceIds', 'discardPileCardInstanceIds', 'revealedPoolCardInstanceIds'):
        zones[name] = [i for i in zones[name] if i != card_id]
    for seat in state['seats']:
        for scope, name in (('private', 'handCardInstanceIds'), ('public', 'inPlayCardInstanceIds')):
            seat[scope][name] = [i for i in seat[scope][name] if i != card_id]
def eliminate(seat):
    zones['discardPileCardInstanceIds'] += seat['private']['handCardInstanceIds'] + seat['public']['inPlayCardInstanceIds']
    seat['private']['handCardInstanceIds'] = []
    seat['public'].update(hp=0, eliminated=True, roleRevealed=True, inPlayCardInstanceIds=[])
state['turn'].update(currentPlayerId=reviewer['public']['playerId'], phase='play', bangCardPlaysThisTurn=0)
if mode in ('play', 'experience', 'critical'):
    for definition in ('beer_01', 'general_store_01'):
        card_id = next(i for i, c in zones['cardsByInstanceId'].items() if c['cardDefinitionId'] == definition)
        remove_card(card_id)
        reviewer['private']['handCardInstanceIds'].append(card_id)
    if mode in ('experience', 'critical'):
        # Controlled presentation fixture: no unresolved opening choice, all 80 cards preserved.
        zones['drawPileCardInstanceIds'] += zones['revealedPoolCardInstanceIds']
        zones['revealedPoolCardInstanceIds'] = []
        state['resolution']['pendingInteraction'] = None
        state['resolution']['effectQueue'] = []
        state['resolution']['continuations'] = []
        reviewer['public']['hp'] = max(1, reviewer['public']['maxHp'] - 1)
        for definition in ('bang_01', 'gatling_01', 'panic_01', 'cat_balou_01', 'barrel_01', 'dynamite_01', 'jail_01', 'winchester_01'):
            card_id = next(i for i, c in zones['cardsByInstanceId'].items() if c['cardDefinitionId'] == definition)
            remove_card(card_id)
            destination = reviewer['public']['inPlayCardInstanceIds'] if definition == 'winchester_01' else reviewer['private']['handCardInstanceIds']
            destination.append(card_id)
        opponents = [s for s in state['seats'] if s['public']['playerId'] != reviewer['public']['playerId']]
        for seat, definition in zip(opponents, ('missed_01', 'missed_02', 'missed_03')):
            card_id = next(i for i, c in zones['cardsByInstanceId'].items() if c['cardDefinitionId'] == definition)
            remove_card(card_id)
            seat['private']['handCardInstanceIds'].append(card_id)
        if mode == 'critical':
            # Actual PLAY_CARD/RESPOND commands must still create the death-rescue window.
            target = next((s for s in opponents if s['public']['displayName'].startswith('디자인 검증')), opponents[0])
            target['public']['hp'] = 1
            beer_id = next(i for i, c in zones['cardsByInstanceId'].items() if c['cardDefinitionId'] == 'beer_01')
            remove_card(beer_id)
            target['private']['handCardInstanceIds'].append(beer_id)
elif mode == 'completed':
    sheriff = next(s for s in state['seats'] if s['private']['roleId'] == 'sheriff')
    eliminate(sheriff)
    state['status'] = 'completed'
    state['outcome'] = {'winningFaction': 'outlaws', 'winningPlayerIds': [s['public']['playerId'] for s in state['seats'] if s['private']['roleId'] == 'outlaw']}
elif mode == 'observer':
    if reviewer['private']['roleId'] == 'sheriff':
        raise ValueError('Use a non-sheriff review guest for observer fixture')
    eliminate(reviewer)
    state['turn']['currentPlayerId'] = next(s['public']['playerId'] for s in state['seats'] if not s['public']['eliminated'])
elif mode == 'paused':
    state.update(status='paused', pauseReason='RULE_RESOURCE_EXHAUSTED')
all_ids = sum([zones[name] for name in ('drawPileCardInstanceIds', 'discardPileCardInstanceIds', 'revealedPoolCardInstanceIds')], [])
for seat in state['seats']:
    all_ids += seat['private']['handCardInstanceIds'] + seat['public']['inPlayCardInstanceIds']
if len(all_ids) != 80 or len(set(all_ids)) != 80:
    raise ValueError('Fixture must conserve all 80 cards')
state['version'] = row[1] + 1
state['eventSeq'] = row[3]
connection.execute("UPDATE matches SET status=?,version=?,state_json=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND version=?", (state['status'], state['version'], json.dumps(state, ensure_ascii=False), row[0], row[1]))
connection.commit()
print(json.dumps({'roomId':room_id, 'mode':mode, 'version':state['version'], 'cardsConserved':len(all_ids)}, ensure_ascii=False))

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { BASE_CARD_DEFINITIONS, BASE_PHYSICAL_CARDS } from '../packages/catalog/src/cards/index.ts';
import { characters } from '../packages/catalog/src/characters/index.ts';
import { roles } from '../packages/catalog/src/roles/index.ts';
const out = 'outputs/migration-parity-2026-10-12';
const baseline = 'fddad9b8d26f953728f86b38d456b1096bd8f331';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const rows = [];
function add(group, feature, status, site, node, evidence) {
  rows.push({ id: `M${String(rows.length + 1).padStart(3, '0')}`, group, feature, status, site, node, evidence });
}
const both = '양쪽 구현 확인';
const shared = '공통 코드 동일';
const gap = '차이/결함 확인';
const sessionSite = 'apps/site/src/server/routes/session.ts';
const sessionNode = 'apps/server/src/main.ts';
for (const feature of ['닉네임으로 게스트 생성', '쿠키로 동일 게스트 복원', '지속 쿠키·복원 시 갱신', '명시적 TTL 만료', '닉네임 변경 및 기존 좌석 유지']) add('인증', feature, both, sessionSite, sessionNode, 'Node runtime·Sites session-room 회귀 테스트; 기존 지속 쿠키 누락은 10/11 수정');
add('인증', '참여 방 복구 및 조회량', gap, 'D1RoomService.recoverAssignedSeats / listRoomsForPlayer', 'RoomService.recoverAssignedSeats / BrowserGameTransport.performRecoverAssignedSeats', 'F03: 닫힌 방 포함, N+1 조회, 모든 과거 방·게임 자동 동기화');
add('인증', '변경 API와 WebSocket Origin 검증', gap, sessionSite, sessionNode, 'F06: 격리 서버에서 외부 Origin 차등 재현');
add('인증', '이미 연결된 세션 취소 반영', gap, 'routes/notifications.ts / 매 요청 authenticate', 'socket/gateway.ts / 연결 시 authenticate', 'F07: 취소 후 기존 소켓 읽기 지속 재현');
const roomSite = 'apps/site/src/server/routes/rooms.ts / rooms/service.ts';
const roomNode = 'apps/server/src/main.ts / rooms/service.ts / storage/room-lifecycle.ts';
for (const feature of ['CREATE_ROOM', 'JOIN', 'SET_READY (레거시 API)', 'START_MATCH', 'RETURN_TO_LOBBY', 'CLOSE_ROOM', 'KICK_MEMBER', '초대 링크 미리조회', '방장 초대 링크 재발급', '4–7명 정원·빈자리·중복 입장 검사', '방장·현재 멤버·버전 검사', '게임 중 입장·추방 제한', '종료 후 새 게임 및 이전 기록 보존']) add('방', feature, both, roomSite, roomNode, '방 서비스·라이프사이클·런타임·Sites D1 테스트; KICK_MEMBER/링크 재발급은 10/11 보완');
add('방', 'SET_RULESET', '동일한 의도적 제한', roomSite, roomNode, '양쪽 모두 기본판 ruleset 고정; 기능 누락으로 집계하지 않음');
add('방', '입장하면 자동 준비·즉시 대기실', shared, 'apps/web/src/features/room-entry / lobby', '같은 React 컴포넌트', '준비 버튼/방 미리열기 제거 유지; 서버 JOIN ready=true');
add('방', '시작 명령 영수증 재조회 순서', '정적 위험 확인', 'rooms/service.ts:402 prior receipt 우선', 'rooms/service.ts:386 현재 인원 검사 우선', 'F12: 기존 시작 명령 재전송 전 방 인원이 바뀐 드문 경우; 이번 실행 재현 없음');
add('방', '대기실 연결 상태·복수 탭', both, 'routes/notifications.ts 45초 lease', 'socket/presence.ts 소켓 수 및 room:presence', '의도된 전송 차이; Node presence 회귀 테스트. 원래 누락은 10/11 수정');
for (const feature of ['PLAY_CARD', 'RESPOND', 'USE_ABILITY', 'END_TURN']) add('게임 명령', feature, shared, 'D1MatchService → packages/engine/src/commands', 'commands/index.ts → 같은 engine', '공통 계약 파서·턴 런타임·효과 레지스트리; 각 어댑터 쓰기 경계는 별도');
for (const feature of ['80장 구성·랭크·무늬·셔플', '4/5/6/7인 역할 배분', '보안관 첫 차례', '보안관 캐릭터 기본 HP +1 및 초기 손패', '차례 시작 다이너마이트·감옥·드로우', '턴 종료 현재 HP 초과분 버리기', '거리·사거리·장비 및 탈락자 제외', '만피 맥주 허용·회복 0 확인 UX 유지', '빈사 구제·자동 탈락 카드 정리', '보상·보안관 페널티·승리 판정', '동시 광역 응답 접수와 순차 엔진 정산']) add('규칙', feature, shared, 'packages/engine/src / server/commands/turn-runtime.ts', '같은 파일', 'Sites v27 이후 engine/catalog/contracts 변경 없음; shared 테스트 420개. 전체 97 시나리오 통과를 뜻하지 않음');
for (const card of BASE_CARD_DEFINITIONS) add('카드', `${card.typeId} (${card.quantity}장)`, shared, 'packages/catalog/src/cards/index.ts / engine/src/effects/cards', '동일 catalog·registry·effect handler', '22종 80장 전부 포함; 개별 공개 도메인 4–7인 E2E는 이번 미실행');
for (const character of characters) add('캐릭터', `${character.id} (기본 HP ${character.baseHealth})`, shared, 'packages/catalog/src/characters/index.ts / engine/src/effects/characters', '동일 roster·ability handler', '16명 전부 포함; 공통 엔진 및 캐릭터 회귀 테스트');
for (const role of roles) add('역할', role.id, shared, 'packages/catalog/src/roles/index.ts / engine/src/endgame', '동일 역할 데이터·승리 엔진', '4–7명 역할 분포 및 엔진 코드 동일');
for (const feature of ['커맨드 ID·내용 불변 재전송', '중복 명령 쓰기 멱등성', '같은 버전 동시 명령 한 건만 확정', '상태·이벤트·영수증·outbox 원자성', '시청자별 손패·역할·legalActions 투영', 'outbox는 공개 변경 힌트만 전송', '현재 멤버 확인·외부인 조회 거부', '낡은 버전·이벤트 역행 방지']) add('정합성', feature, both, 'D1StorageRepository / D1MatchService / shared validation', 'StorageRepository / commands / shared validation', 'D1 CAS batch vs PostgreSQL transaction 차이; 양쪽 회귀 테스트');
add('정합성', '저장된 스냅샷 전체 형태·지원 버전 검사', gap, 'storage/state-schema.ts / supportedSchemaVersion', 'storage/repository.ts / recovery/index.ts', 'F08: Node 시작 시 메타데이터 점검은 있음; 요청 경계 검증은 약함. schema 2 차등 재현');
add('정합성', '명령 request hash', '장래 호환 위험', 'matches/service.ts', 'commands/index.ts', 'D-HASH: 동일 봉투의 키 순서 차이로 해시 상이. 현재 서로 다른 DB에서는 직접 장애 아님');
for (const [feature, evidence] of [
  ['늦은 ACK·응답 유실·UI 잠금 복구', 'F01'], ['일시적 sync 실패 자동 재시도', 'F02'],
  ['명령 ACK에 최신 투영 포함', 'F04'], ['오래된 이벤트 sync 상한', 'F05'],
  ['권한 잃은 게임 캐시·구독 폐기', 'F10'], ['변경 없는 sync 응답 축소', 'F11'],
]) add('통신', feature, gap, 'apps/web/src/transport/sites-client.ts / site server routes', 'apps/web/src/transport/client.ts / server projections', `${evidence}: 차등 실행 재현; REPORT 참고`);
add('통신', 'SSE/HTTP → Socket.IO polling/WebSocket', '의도된 구현 차이', 'SitesGameTransport', 'BrowserGameTransport', '전송 기술 변경 자체는 누락 아님; 어댑터 의미 차이가 문제');
add('통신', '탭 숨김·다시 활성화', '의도 차이 및 보완 권고', 'visibility handler가 스트림 종료·복귀 sync', 'Socket.IO 연결 유지, 복귀용 별도 sync 없음', '공통 F02 재시도/가시성 복구로 보완 권고; 브라우저 장시간 절전 E2E 미실행');
add('통신', '예상 밖 조회 오류', '정적 위험 확인', 'routes/sync.ts 안전 오류·단계 로그', 'socket/gateway.ts:316 invoke disconnect', 'F08 연관: 오류 ACK/진단 없이 disconnect될 수 있음; 임의 운영 오류 주입 없음');
for (const feature of ['4–7인 원형 테이블·거리', '작은 손패 카드 아이콘', '카드·캐릭터·장착 상세', '중앙 행동 무대 및 대응 카드 배치', '잡화점 공개 선택 무대', '인디언·개틀링 효과·각 플레이어 결과', '총격·방어·결투 애니메이션', '다이너마이트 폭발 이펙트', '강제 버림·탈취 이펙트', '드로우·사용·이동 효과음', '음량·효과 설정·reduced motion', '빈 손패 UI·중복 닫기 제거', '불필요한 기술 알림 억제', '모바일 반응형·접근성', 'WebMCP 도구 및 실패 시 UI 유지']) add('화면/연출', feature, shared, 'apps/web/src/features / app/webmcp.ts', '동일 React·CSS·audio/motion 코드', 'Sites v27 이후 features 파일 변경 없음; web 회귀 256개. 실제 모바일·음성 청취는 이번 미실행');
for (const feature of ['최신순 hh:mm:ss 및 60초 이상 분 표시', '열린 패널 상대 시각 고정', '오래된 기록 페이지 추가 조회', '카드 이동·버림·탈취 공개 기록과 비공개 정보 제거']) add('기록', feature, both, 'routes/history.ts + shared status / public projector', 'match:history + 같은 status / public projector', 'Node/Sites history 회귀 및 공통 UI; F05는 동기화 전송량의 차이');
add('에셋', '한국어 카드 22 + 인물 16 + 역할 4 이미지', shared, 'apps/site/public/assets/cards', 'apps/web/public/assets/cards', '42개 상대 경로·SHA256 비교; asset-parity.json');
add('에셋', '안정된 카드 이미지 URL 캐시', gap, 'public/_headers 1시간 재검증', 'Caddy /assets/* 1년 immutable', 'F09: 운영 HTTPS 응답에서도 확인');
for (const [feature, status, evidence] of [
  ['HTTPS·도메인·터널·정적 SPA 직접 경로', '운영 확인', '현재 공개 health 200; 기존 배포 검증 기록. TLS 종단은 Cloudflare'],
  ['실행 중 릴리스·서버 번들', '운영 확인', 'SSH release 2026-10-11-presence, 로컬/서버 SHA256 일치'],
  ['프로세스 장애 자동 재시작', '구현 확인', 'LaunchAgent KeepAlive. 현재 Node/Caddy/Postgres/Tunnel 실행 상태 확인'],
  ['OS 재부팅·로그아웃 뒤 무인 실행', '운영 제약', 'O02: gui/502 LaunchAgents이므로 로그인 필요; 실제 서버 재부팅 미실행'],
  ['DB 백업·디스크 재해 복구', '운영 제약', 'O03: 동일 서버 백업 존재, 외부 복제 없음. 전체 복원 리허설 미실행'],
  ['이전 Sites 서비스 완전 중지', gap, 'O01: get_site active=true, owner 전용. 공개 접근 제한과 서비스 중지는 다름'],
  ['기존 D1 데이터·다른 도메인 쿠키 이전', '의도된 범위 제외', '이전 문서에 미이관 명시; 데이터 유실로 단정하지 않음'],
  ['www 별칭', '의도된 미구성', '정본 bang-online.site만 연결; www 요구 없었음'],
  ['HTTP 보안 헤더·요청 크기·초대 제한', '구현 차이', '양쪽 제한 존재; Origin은 F06, Node profile 오류 코드 정규화는 보완 가능'],
  ['배포 게이트·어댑터 계약 회귀', '과정 누락 확인', '정상 흐름 중심 검증으로 F01/F02 등 통신 차이 놓침. parity 테스트 게이트 필요'],
]) add('운영', feature, status, 'Sites managed hosting / D1', 'deploy/selfhost / PostgreSQL / Caddy / Tunnel', evidence);

async function files(root) { return (await Promise.all((await readdir(root, { withFileTypes: true })).map(e => e.isDirectory() ? files(`${root}/${e.name}`) : [`${root}/${e.name}`]))).flat().sort(); }
const assets = [];
for (const path of await files('apps/web/public/assets/cards')) {
  const relative = path.slice('apps/web/public/'.length), a = await readFile(path), b = await readFile(`apps/site/public/${relative}`);
  assets.push({ path: relative, bytes: a.length, sha256: createHash('sha256').update(a).digest('hex'), equal: a.equals(b) });
}
const sitePaths = await files('apps/site/public/assets/cards');
const sourceDiff = git('diff', '--name-only', baseline, 'HEAD', '--', 'packages', 'apps/web/src/features', 'apps/web/src/components', 'apps/web/src/app/webmcp.ts');
const metadata = {
  checkedAt: new Date().toISOString(), siteBaseline: { version: 27, commit: baseline, active: true, access: 'custom owner-only', oldDatabaseMigrated: false },
  repositoryHead: git('rev-parse', 'HEAD'), sharedGameAndFeatureDiff: sourceDiff ? sourceDiff.split('\n') : [],
  definitions: { cardTypes: BASE_CARD_DEFINITIONS.length, physicalCards: BASE_PHYSICAL_CARDS.length, characters: characters.length, roles: roles.length },
  production: { sourceCommit: '72550cd3e3ebc56641918c76a752204b21c849e0', release: '2026-10-11-presence', serverSha256: '11893b77ae836ebdaee34c06a9791aa23da47ebd7e877d80847f726681378a87', publicHealth: 'ok', imageCacheControl: 'public, max-age=31536000, immutable', servicesRunning: ['server', 'web', 'postgres', 'tunnel'], backupPresent: true, mutatedDuringAudit: false },
  featureRows: rows.length,
};
await mkdir(out, { recursive: true });
await writeFile(`${out}/baseline-and-production.json`, JSON.stringify(metadata, null, 2) + '\n');
await writeFile(`${out}/asset-parity.json`, JSON.stringify({ count: assets.length, siteCount: sitePaths.length, allEqual: assets.length === sitePaths.length && assets.every(a => a.equal), assets }, null, 2) + '\n');
await writeFile(`${out}/feature-matrix.json`, JSON.stringify(rows, null, 2) + '\n');
let markdown = '# Sites ↔ 정훈서버 기능 대조표\n\n기준: Sites v27 / 현재 저장소 및 정훈서버 2026-10-11-presence. **공통 코드 동일**은 소스·공용 회귀 검증이며 모든 운영 E2E를 통과했다는 뜻이 아니다. 결함의 우선순위·재현·조치는 REPORT.md 참고.\n';
for (const group of [...new Set(rows.map(r => r.group))]) {
  markdown += `\n## ${group}\n\n| ID | 기능 | 판정 | Sites 경로 | 정훈서버 경로 | 근거·제한 |\n|---|---|---|---|---|---|\n`;
  for (const row of rows.filter(r => r.group === group)) markdown += `| ${row.id} | ${row.feature} | ${row.status} | ${row.site} | ${row.node} | ${row.evidence} |\n`;
}
await writeFile(`${out}/FEATURE_MATRIX.md`, markdown);
console.log(JSON.stringify({ rows: rows.length, assets: assets.length, assetsEqual: assets.every(a => a.equal), unchangedSharedSource: !sourceDiff }));

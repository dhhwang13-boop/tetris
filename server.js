const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- 봇용 실제 테트리스 엔진 (서버에서 직접 판단하며 플레이) ----------
const BOT_COLS = 10, BOT_ROWS = 20;
// 각 조각의 회전 상태별 셀 좌표 (x,y) - 나중에 난이도(하수/중수/고수)를 조절할 때
// 이 엔진은 그대로 두고 BOT_TICK_MS(판단 주기)나 평가 가중치만 조절하면 됨
const BOT_PIECES = {
  I: [[[0,1],[1,1],[2,1],[3,1]], [[2,0],[2,1],[2,2],[2,3]]],
  O: [[[1,0],[2,0],[1,1],[2,1]]],
  T: [[[1,0],[0,1],[1,1],[2,1]], [[1,0],[1,1],[2,1],[1,2]], [[0,1],[1,1],[2,1],[1,2]], [[1,0],[0,1],[1,1],[1,2]]],
  S: [[[1,0],[2,0],[0,1],[1,1]], [[1,0],[1,1],[2,1],[2,2]]],
  Z: [[[0,0],[1,0],[1,1],[2,1]], [[2,0],[1,1],[2,1],[1,2]]],
  J: [[[0,0],[0,1],[1,1],[2,1]], [[1,0],[2,0],[1,1],[1,2]], [[0,1],[1,1],[2,1],[2,2]], [[1,0],[1,1],[0,2],[1,2]]],
  L: [[[2,0],[0,1],[1,1],[2,1]], [[1,0],[1,1],[1,2],[2,2]], [[0,1],[1,1],[2,1],[0,2]], [[0,0],[1,0],[1,1],[1,2]]],
};
const BOT_PIECE_TYPES = Object.keys(BOT_PIECES);
function botBag(){
  const arr = [...BOT_PIECE_TYPES];
  for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[arr[i], arr[j]] = [arr[j], arr[i]]; }
  return arr;
}
function ensureBotQueue(bot){ while (bot.queue.length < 2) bot.queue.push(...botBag()); }
function botColumnTop(board, col){
  for (let r = 0; r < BOT_ROWS; r++) if (board[r][col]) return r;
  return BOT_ROWS;
}
function botDropOffset(board, cells, colOffset){
  let minDrop = Infinity;
  const perCol = {};
  for (const [dx, dy] of cells) {
    const col = colOffset + dx;
    if (!(col in perCol) || dy > perCol[col]) perCol[col] = dy;
  }
  for (const colStr in perCol) {
    const col = +colStr;
    const top = botColumnTop(board, col);
    const drop = (top - 1) - perCol[col];
    if (drop < minDrop) minDrop = drop;
  }
  return minDrop;
}
function botEvalBoard(board, clearedLines){
  const heights = Array(BOT_COLS).fill(0);
  let holes = 0;
  for (let c = 0; c < BOT_COLS; c++) {
    let seen = false;
    for (let r = 0; r < BOT_ROWS; r++) {
      if (board[r][c]) { if (!seen) { heights[c] = BOT_ROWS - r; seen = true; } }
      else if (seen) holes++;
    }
  }
  const aggHeight = heights.reduce((a, b) => a + b, 0);
  let bump = 0;
  for (let i = 0; i < BOT_COLS - 1; i++) bump += Math.abs(heights[i] - heights[i + 1]);
  return -0.51 * aggHeight + 1.2 * clearedLines - 0.36 * holes - 0.18 * bump;
}
// 현재 조각 하나를 최적 위치(모든 회전 x 모든 열)로 실제로 놓아보고 그 중 가장 좋은 수를 둠
function botPlaceBestPiece(bot){
  ensureBotQueue(bot);
  const type = bot.queue.shift();
  ensureBotQueue(bot);
  const rotations = BOT_PIECES[type];
  let best = null;
  for (const cells of rotations) {
    const maxX = Math.max(...cells.map(c => c[0]));
    for (let col = 0; col <= BOT_COLS - 1 - maxX; col++) {
      const dropAmt = botDropOffset(bot.board, cells, col);
      const testBoard = bot.board.map(r => r.slice());
      let outOfBounds = false;
      for (const [dx, dy] of cells) {
        const r = dy + dropAmt, c = col + dx;
        if (r < 0) { outOfBounds = true; break; }
        testBoard[r][c] = 1;
      }
      if (outOfBounds) continue;
      let cleared = 0;
      const newBoard = [];
      for (let r = 0; r < BOT_ROWS; r++) { if (!testBoard[r].every(v => v)) newBoard.push(testBoard[r]); else cleared++; }
      while (newBoard.length < BOT_ROWS) newBoard.unshift(Array(BOT_COLS).fill(0));
      const score = botEvalBoard(newBoard, cleared);
      if (!best || score > best.score) best = { newBoard, cleared, score };
    }
  }
  if (!best) return { topOut: true };
  bot.board = best.newBoard;
  return { cleared: best.cleared, topOut: false };
}
function botBoardFlat(bot){
  return bot.board.map(row => row.map(c => c ? '1' : '0').join('')).join('|');
}
const BOT_GARBAGE_TABLE = { 1: 0, 2: 1, 3: 2, 4: 4 };
const BOT_TICK_MS = 800; // 봇이 조각 하나를 놓는 주기 - 난이도 조절 시 이 값을 조절하면 됨

// ---------- 정적 파일 서버 ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.mp3': 'audio/mpeg' };
const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
  if (req.url === '/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify({ online: wss.clients.size }));
    return;
  }
  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = path.join(PUBLIC_DIR, path.normalize(filePath).replace(/^(\.\.[\/\\])+/, ''));
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    // HTML은 항상 최신 버전을 받도록 캐시를 막음 (배포했는데 브라우저가 예전 버전을 계속 쓰는 문제 방지)
    headers['Cache-Control'] = ext === '.html' ? 'no-cache, no-store, must-revalidate' : 'public, max-age=86400';
    res.writeHead(200, headers);
    res.end(data);
  });
});

// ---------- WebSocket 룸 관리 ----------
const wss = new WebSocketServer({ server });

/** rooms: id -> { id, isPrivate, password, hostId, status, startAt, players: Map(id -> {ws,name,ready,alive,score,lines}) } */
const rooms = new Map();

function roomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 4; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return rooms.has(s) ? roomId() : s;
}
function uid() { return crypto.randomBytes(6).toString('hex'); }

function send(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}
function broadcast(room, obj, exceptId) {
  for (const [pid, p] of room.players) {
    if (pid !== exceptId) send(p.ws, obj);
  }
}
function broadcastToSpectators(room, obj) {
  if (!room.spectators) return;
  for (const [, s] of room.spectators) send(s.ws, obj);
}
function broadcastAll(room, obj, exceptId) {
  broadcast(room, obj, exceptId);
  broadcastToSpectators(room, obj);
}
function lobbyPayload(room) {
  return {
    type: 'lobby',
    roomId: room.id,
    title: room.title,
    mode: room.mode,
    max: modeMax(room.mode),
    hostId: room.hostId,
    isPrivate: room.isPrivate,
    players: [...room.players.entries()].map(([id, p]) => ({ id, name: p.name, ready: p.ready, isBot: !!p.isBot }))
  };
}
function modeMax(mode){ if(mode === 'classic2') return 2; if(mode === 'territory') return 4; if(mode === 'defense') return 4; return 5; }
const TERRITORY_SIZE = 14;
const FLAG_COLORS = ['#e24b4a', '#ff9c47', '#ffce45', '#52ff9d']; // 빨강/주황/노랑/초록
const TERRITORY_CORNERS = [[0,0], [TERRITORY_SIZE-1,0], [0,TERRITORY_SIZE-1], [TERRITORY_SIZE-1,TERRITORY_SIZE-1]];
const DEFAULT_ROOM_TITLES = ['즐거운 게임해요!', '테트리스 초보만!', '매너게임 부탁합니다!', 'glhf'];

function roomListPayload() {
  const list = [...rooms.values()]
    .filter(r => (r.status === 'lobby' && r.players.size < modeMax(r.mode)) || (r.status === 'playing' && r.mode === 'classic5'))
    .map(r => ({
      roomId: r.id,
      title: r.title || null,
      mode: r.mode,
      status: r.status,
      hostName: (r.players.get(r.hostId) || {}).name || '플레이어',
      count: r.players.size,
      max: modeMax(r.mode),
      isPrivate: r.isPrivate
    }));
  return { type: 'roomList', rooms: list };
}

wss.on('connection', (ws, req) => {
  ws.playerId = null;
  ws.roomId = null;
  ws.isAlive = true;
  ws.msgCount = 0;
  ws.msgWindowStart = Date.now();
  ws.ip = ((req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || (req.socket ? req.socket.remoteAddress : null);
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    // 과도한 트래픽/악의적 클라이언트로부터 무료 서버 자원을 보호하기 위한 기본 방어
    if (raw.length > 8000) return; // 비정상적으로 큰 페이로드 차단
    const now = Date.now();
    if (now - ws.msgWindowStart > 1000) { ws.msgWindowStart = now; ws.msgCount = 0; }
    ws.msgCount++;
    if (ws.msgCount > 40) return; // 초당 40개 초과 메시지는 조용히 무시 (도배 방지)

    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    if (msg.type === 'joinSpectator') {
      const id = String(msg.roomId || '').toUpperCase();
      const room = rooms.get(id);
      if (!room) { send(ws, { type: 'error', message: '해당 방을 찾을 수 없어요.' }); return; }
      if (room.mode !== 'classic5') { send(ws, { type: 'error', message: '이 모드는 관전을 지원하지 않아요.' }); return; }
      if (room.isPrivate && String(msg.password || '') !== room.password) {
        send(ws, { type: 'error', message: '코드가 올바르지 않아요.' });
        return;
      }
      const specId = 'spec_' + uid();
      ws.playerId = specId; ws.roomId = id; ws.isSpectator = true;
      room.spectators.set(specId, { ws });
      send(ws, {
        type: 'spectating', roomId: id, playerId: specId, mode: room.mode, title: room.title, status: room.status,
        players: [...room.players.entries()].map(([pid, p]) => ({ id: pid, name: p.name, score: p.score, alive: p.alive }))
      });
      return;
    }

    if (msg.type === 'joinAsPlayer') {
      const room = rooms.get(ws.roomId);
      if (!room || !ws.isSpectator) return;
      if (room.status !== 'lobby') { send(ws, { type: 'error', message: '게임이 진행 중이라 지금은 참가할 수 없어요. 종료 후 참가해주세요.' }); return; }
      if (room.players.size >= modeMax(room.mode)) { send(ws, { type: 'error', message: '방이 가득 찼어요.' }); return; }
      room.spectators.delete(ws.playerId);
      const newId = uid();
      ws.playerId = newId; ws.isSpectator = false;
      room.players.set(newId, { ws, name: String(msg.name || '플레이어').slice(0, 8), ready: false, alive: true, score: 0, lines: 0, ip: ws.ip });
      send(ws, { type: 'joined', roomId: room.id, playerId: newId });
      broadcast(room, lobbyPayload(room));
      return;
    }

    if (msg.type === 'addBot') {
      const room = rooms.get(ws.roomId);
      if (!room || ws.playerId !== room.hostId) return;
      if (room.status !== 'lobby') return;
      if (room.players.size >= modeMax(room.mode)) return;
      const botId = 'bot_' + uid();
      const botNum = [...room.players.values()].filter(p => p.isBot).length + 1;
      room.players.set(botId, { ws: null, name: '봇 ' + botNum, ready: true, alive: true, score: 0, lines: 0, isBot: true });
      broadcast(room, lobbyPayload(room));
      return;
    }

    if (msg.type === 'removeBot') {
      const room = rooms.get(ws.roomId);
      if (!room || ws.playerId !== room.hostId) return;
      if (room.status !== 'lobby') return;
      const target = room.players.get(msg.botId);
      if (!target || !target.isBot) return;
      room.players.delete(msg.botId);
      broadcast(room, lobbyPayload(room));
      return;
    }

    if (msg.type === 'leaveRoom') {
      ws.deliberateLeave = true;
      return;
    }

    if (msg.type === 'listRooms') {
      send(ws, roomListPayload());
      return;
    }

    if (msg.type === 'create') {
      const id = roomId();
      const hostId = uid();
      const isPrivate = !!msg.isPrivate;
      const password = isPrivate ? String(msg.password || '').slice(0, 16) : null;
      if (isPrivate && !password) { send(ws, { type: 'error', message: '비공개 방은 코드를 설정해야 해요.' }); return; }
      const title = String(msg.roomTitle || '').trim().slice(0, 20) || DEFAULT_ROOM_TITLES[Math.floor(Math.random() * DEFAULT_ROOM_TITLES.length)];
      const mode = msg.mode === 'classic2' ? 'classic2' : (msg.mode === 'territory' ? 'territory' : (msg.mode === 'defense' ? 'defense' : 'classic5'));
      const room = { id, title, mode, isPrivate, password, hostId, status: 'lobby', startAt: null, players: new Map(), spectators: new Map() };
      room.players.set(hostId, { ws, name: String(msg.name || '플레이어').slice(0, 8), ready: true, alive: true, score: 0, lines: 0, ip: ws.ip });
      rooms.set(id, room);
      ws.playerId = hostId; ws.roomId = id;
      send(ws, { type: 'created', roomId: id, playerId: hostId });
      broadcast(room, lobbyPayload(room));
      return;
    }

    if (msg.type === 'joinRoom') {
      const id = String(msg.roomId || '').toUpperCase();
      const room = rooms.get(id);
      if (!room) { send(ws, { type: 'error', message: '해당 방을 찾을 수 없어요. 목록을 새로고침해보세요.' }); return; }
      if (room.status !== 'lobby') { send(ws, { type: 'error', message: '이미 게임이 진행 중인 방이에요.' }); return; }
      if (room.players.size >= modeMax(room.mode)) { send(ws, { type: 'error', message: `방이 가득 찼어요 (최대 ${modeMax(room.mode)}인).` }); return; }
      if (room.isPrivate && String(msg.password || '') !== room.password) {
        send(ws, { type: 'error', message: '코드가 올바르지 않아요.' });
        return;
      }
      const id2 = uid();
      room.players.set(id2, { ws, name: String(msg.name || '플레이어').slice(0, 8), ready: false, alive: true, score: 0, lines: 0, ip: ws.ip });
      ws.playerId = id2; ws.roomId = id;
      send(ws, { type: 'joined', roomId: id, playerId: id2 });
      broadcast(room, lobbyPayload(room));
      return;
    }

    const room = rooms.get(ws.roomId);
    if (!room || !ws.playerId) return;
    const me = room.players.get(ws.playerId);
    if (!me) return;

    if (msg.type === 'ready') {
      me.ready = !!msg.ready;
      broadcast(room, lobbyPayload(room));
      return;
    }

    if (msg.type === 'start') {
      if (ws.playerId !== room.hostId) return;
      if (room.players.size < 2) return;
      if (![...room.players.values()].every(p => p.ready)) return;
      room.status = 'starting';
      room.startAt = Date.now() + 3000;
      broadcastAll(room, { type: 'countdown', startAt: room.startAt });
      setTimeout(() => {
        if (room.status !== 'starting') return;
        room.status = 'playing';
        room.startCount = room.players.size;
        room.playStartedAt = Date.now();
        for (const p of room.players.values()) { p.alive = true; p.score = 0; p.lines = 0; }
        const playerList = [...room.players.entries()].map(([id, p]) => ({ id, name: p.name, isBot: !!p.isBot }));
        if (room.mode === 'territory') {
          initTerritoryMap(room);
          room.territoryEndAt = Date.now() + 180000;
          broadcastAll(room, { type: 'gameStart', players: playerList, mode: room.mode, territoryEndAt: room.territoryEndAt, land: territoryFlat(room), territoryOrder: room.territoryOrder });
          startBotSimulation(room);
          clearTimeout(room.territoryTimer);
          room.territoryTimer = setTimeout(() => endTerritoryMatch(room), 180000);
        } else if (room.mode === 'defense') {
          initDefenseState(room);
          broadcastAll(room, { type: 'gameStart', players: playerList, mode: room.mode, defense: { round: 1, teamHp: DEFENSE_START_HP, maxHp: DEFENSE_START_HP, roundRemainMs: DEFENSE_ROUND_MS } });
          startBotSimulation(room);
          startDefenseLoop(room);
        } else {
          broadcastAll(room, { type: 'gameStart', players: playerList, mode: room.mode });
        }
      }, 3000);
      return;
    }

    if (msg.type === 'territoryCapture') {
      if (room.mode !== 'territory' || room.status !== 'playing') return;
      const amount = Math.max(0, Math.min(6, msg.amount || 0));
      if (amount > 0) { captureCells(room, ws.playerId, amount); broadcastTerritoryUpdate(room); }
      return;
    }

    if (msg.type === 'defenseAttack') {
      if (room.mode !== 'defense' || room.status !== 'playing') return;
      applyDefenseDamage(room, Math.max(0, Math.min(4, msg.amount || 0)));
      return;
    }

    if (msg.type === 'state') {
      me.score = msg.score || 0;
      me.lines = msg.lines || 0;
      const wasAlive = me.alive;
      me.alive = !!msg.alive;
      broadcast(room, {
        type: 'opponentState',
        id: ws.playerId,
        score: me.score,
        lines: me.lines,
        alive: me.alive,
        boardFlat: msg.boardFlat
      }, ws.playerId);
      broadcastToSpectators(room, {
        type: 'opponentState',
        id: ws.playerId,
        score: me.score,
        lines: me.lines,
        alive: me.alive,
        boardFlat: msg.boardFlat
      });
      if (wasAlive && !me.alive && room.mode !== 'territory') checkEnd(room);
      return;
    }

    if (msg.type === 'garbage') {
      applyPlayerAttack(room, ws.playerId, me.name, msg.amount);
      return;
    }

    if (msg.type === 'chat') {
      const text = String(msg.text || '').slice(0, 80);
      if (!text) return;
      broadcast(room, { type: 'chat', id: ws.playerId, name: me.name, text, isEmoji: !!msg.isEmoji }, ws.playerId);
      return;
    }
  });

  ws.on('close', () => {
    const room = rooms.get(ws.roomId);
    if (!room) return;
    if (ws.isSpectator) {
      room.spectators.delete(ws.playerId);
      return;
    }
    if (!ws.playerId) return;
    const wasHost = (room.hostId === ws.playerId);
    room.players.delete(ws.playerId);
    if (wasHost) {
      // 호스트가 나가거나 연결이 끊기면 방 전체를 닫고 모두 메인화면으로 보냄
      clearInterval(room.botInterval); clearTimeout(room.territoryTimer);
      const reason = ws.deliberateLeave ? 'closed' : 'disconnected';
      broadcastAll(room, { type: 'roomClosed', reason });
      rooms.delete(ws.roomId);
      return;
    }
    if (room.players.size === 0 && room.spectators.size === 0) {
      clearInterval(room.botInterval); clearTimeout(room.territoryTimer);
      rooms.delete(ws.roomId); return;
    }
    if (room.players.size === 0) return; // 관전자만 남은 경우 방은 유지하되 더 진행할 참가자가 없음
    if (room.status === 'lobby') {
      broadcast(room, lobbyPayload(room));
    } else if (room.status === 'playing') {
      if (room.mode === 'territory') {
        const humansLeft = [...room.players.values()].filter(p => !p.isBot).length;
        if (humansLeft === 0) { clearInterval(room.botInterval); clearTimeout(room.territoryTimer); room.status = 'ended'; rooms.delete(ws.roomId); }
      } else {
        checkEnd(room);
      }
    }
  });
});

function initTerritoryMap(room){
  room.land = Array.from({ length: TERRITORY_SIZE }, () => Array(TERRITORY_SIZE).fill(null));
  room.territoryOrder = [...room.players.keys()];
  room.territoryOrder.forEach((id, i) => {
    if (i < TERRITORY_CORNERS.length) {
      const [r, c] = TERRITORY_CORNERS[i];
      room.land[r][c] = id;
    }
  });
}
function captureCells(room, playerId, count){
  if (!room.land) return;
  for (let i = 0; i < count; i++) {
    const candidates = [];
    for (let r = 0; r < TERRITORY_SIZE; r++) for (let c = 0; c < TERRITORY_SIZE; c++) {
      if (room.land[r][c] !== playerId) continue;
      const neighbors = [[r-1,c],[r+1,c],[r,c-1],[r,c+1]];
      for (const [nr, nc] of neighbors) {
        if (nr<0||nr>=TERRITORY_SIZE||nc<0||nc>=TERRITORY_SIZE) continue;
        if (room.land[nr][nc] === null) candidates.push([nr,nc]);
      }
    }
    if (candidates.length > 0) {
      const [cr, cc] = candidates[Math.floor(Math.random() * candidates.length)];
      room.land[cr][cc] = playerId;
      continue;
    }
    // 빈 땅이 지도 전체에 하나도 없을 때만 인접한 상대방 땅을 빼앗음
    const anyNeutralLeft = room.land.some(row => row.some(cell => cell === null));
    if (!anyNeutralLeft) {
      const stealCandidates = [];
      for (let r = 0; r < TERRITORY_SIZE; r++) for (let c = 0; c < TERRITORY_SIZE; c++) {
        if (room.land[r][c] !== playerId) continue;
        const neighbors = [[r-1,c],[r+1,c],[r,c-1],[r,c+1]];
        for (const [nr, nc] of neighbors) {
          if (nr<0||nr>=TERRITORY_SIZE||nc<0||nc>=TERRITORY_SIZE) continue;
          if (room.land[nr][nc] !== null && room.land[nr][nc] !== playerId) stealCandidates.push([nr,nc]);
        }
      }
      if (stealCandidates.length > 0) {
        const [sr, sc] = stealCandidates[Math.floor(Math.random() * stealCandidates.length)];
        room.land[sr][sc] = playerId;
      }
    }
  }
}
function territoryFlat(room){
  const idIndex = new Map(room.territoryOrder.map((id, i) => [id, i]));
  return room.land.map(row => row.map(cell => cell === null ? '.' : String(idIndex.get(cell) ?? '.')).join('')).join('|');
}
function broadcastTerritoryUpdate(room){
  const counts = {};
  for (const row of room.land) for (const cell of row) { if (cell) counts[cell] = (counts[cell] || 0) + 1; }
  broadcastAll(room, { type: 'territoryUpdate', land: territoryFlat(room), counts });
}
function endTerritoryMatch(room){
  if (room.status !== 'playing') return;
  clearInterval(room.botInterval);
  room.status = 'ended';
  const counts = {};
  for (const row of room.land) for (const cell of row) { if (cell) counts[cell] = (counts[cell] || 0) + 1; }
  const ranking = [...room.players.entries()]
    .map(([id, p]) => ({ id, name: p.name, score: p.score, land: counts[id] || 0, isBot: !!p.isBot }))
    .sort((a, b) => (b.land - a.land) || (b.score - a.score));
  const humanCount = [...room.players.values()].filter(p => !p.isBot).length;
  const ipCounts = {};
  for (const [, p] of room.players) { if (p.ip) ipCounts[p.ip] = (ipCounts[p.ip] || 0) + 1; }
  const noCoinIds = [...room.players.entries()].filter(([, p]) => p.ip && ipCounts[p.ip] >= 2).map(([id]) => id);
  broadcastAll(room, { type: 'territoryEnd', ranking, mode: room.mode, humanCount, noCoinIds });
  room.status = 'lobby';
  room.land = null;
  for (const [id, p] of room.players) { p.ready = (id === room.hostId) || p.isBot; p.score = 0; p.lines = 0; p.alive = true; p.bot = null; }
  broadcastAll(room, lobbyPayload(room));
}
function applyGarbageToBot(room, id, p, amount){
  if (!p.bot || p.bot.frozen) return;
  for (let i = 0; i < amount; i++) {
    p.bot.board.shift();
    const gapCol = Math.floor(Math.random() * BOT_COLS);
    const row = Array(BOT_COLS).fill(1);
    row[gapCol] = 0;
    p.bot.board.push(row);
  }
  const toppedOut = p.bot.board[0].some(v => v) || p.bot.board[1].some(v => v);
  if (toppedOut) {
    if (room.mode === 'territory') { p.bot.frozen = true; p.bot.frozenUntil = Date.now() + 5000; }
    else { p.alive = false; checkEnd(room); }
  }
  broadcastAll(room, { type: 'opponentState', id, score: p.score, lines: 0, alive: !p.bot.frozen, boardFlat: botBoardFlat(p.bot) });
}
function applyPlayerAttack(room, sourceId, sourceName, amount){
  if (!amount || amount <= 0) return;
  const aliveOthers = [...room.players.entries()].filter(([id, p]) => id !== sourceId && p.alive);
  if (aliveOthers.length === 0) return;
  const targets = (room.mode === 'classic5' || room.mode === 'territory')
    ? aliveOthers
    : [aliveOthers[Math.floor(Math.random() * aliveOthers.length)]];
  for (const [tid, tp] of targets) {
    if (tp.isBot) applyGarbageToBot(room, tid, tp, amount);
    else send(tp.ws, { type: 'garbage', amount, from: sourceName });
  }
}
function startBotSimulation(room){
  clearInterval(room.botInterval);
  room.botInterval = setInterval(() => {
    if (room.status !== 'playing') { clearInterval(room.botInterval); return; }
    for (const [id, p] of room.players) {
      if (!p.isBot || !p.alive) continue;
      if (!p.bot) p.bot = { board: Array.from({ length: BOT_ROWS }, () => Array(BOT_COLS).fill(0)), queue: [], combo: 0, frozen: false, frozenUntil: 0 };
      const bot = p.bot;
      if (bot.frozen) {
        if (Date.now() >= bot.frozenUntil) {
          bot.board = Array.from({ length: BOT_ROWS }, () => Array(BOT_COLS).fill(0));
          bot.frozen = false;
          bot.combo = 0;
        } else {
          continue; // 프리징 중에는 이번 틱은 그냥 넘어감 (실제 플레이어와 동일한 패널티)
        }
      }
      const result = botPlaceBestPiece(bot);
      if (result.topOut) {
        if (room.mode === 'territory' || room.mode === 'defense') { bot.frozen = true; bot.frozenUntil = Date.now() + 5000; }
        else { p.alive = false; checkEnd(room); }
      } else if (result.cleared > 0) {
        bot.combo = (bot.combo || 0) + 1;
        const comboBonus = bot.combo >= 2 ? Math.floor(bot.combo / 2) : 0;
        const attackAmount = Math.min((BOT_GARBAGE_TABLE[result.cleared] || 0) + comboBonus, 6);
        const captureAmount = Math.min(result.cleared, 6);
        p.score += result.cleared * 100;
        if (room.mode === 'territory' && captureAmount > 0) { captureCells(room, id, captureAmount); broadcastTerritoryUpdate(room); }
        else if (room.mode === 'defense') { applyDefenseDamage(room, Math.min(result.cleared, 4)); }
        else if (attackAmount > 0) { applyPlayerAttack(room, id, p.name, attackAmount); }
      } else {
        bot.combo = 0;
      }
      broadcastAll(room, { type: 'opponentState', id, score: p.score, lines: 0, alive: !bot.frozen, boardFlat: botBoardFlat(bot) });
    }
  }, BOT_TICK_MS);
}
// ---------- "침공저지" 협동 디펜스 모드 ----------
const DEFENSE_ROUND_MS = 60000;
const DEFENSE_BOSS_MS = 180000;
const DEFENSE_MONSTER_HP = { zombie: 1, wraith: 1, fire: 3, blue: 10 };
const DEFENSE_MONSTER_TRAVEL_MS = 14000;
const DEFENSE_BOSS_HP = 65;
const DEFENSE_START_HP = 100;
const DEFENSE_ROUND_GAP_MS = 5000;

function defenseMonsterPool(round){
  const pool = ['zombie', 'wraith'];
  if (round >= 2) pool.push('fire');
  if (round >= 3) pool.push('blue');
  return pool;
}
function defenseRoundDuration(round){
  if (round === 3) return 90000;
  if (round === 4) return 120000;
  return DEFENSE_ROUND_MS;
}
const DEFENSE_SPAWN_BATCH = 2;
function defenseTargetSpawnCount(round, playerCount){
  return Math.max(1, playerCount) * 5 * round;
}
function defenseSpawnInterval(round, playerCount){
  const duration = defenseRoundDuration(round);
  return duration * DEFENSE_SPAWN_BATCH / defenseTargetSpawnCount(round, playerCount);
}
function initDefenseState(room){
  const now = Date.now();
  const playerCount = room.players.size;
  room.defense = {
    round: 1, teamHp: DEFENSE_START_HP, maxHp: DEFENSE_START_HP,
    monsters: [], boss: null,
    roundEndAt: now + defenseRoundDuration(1),
    spawnInterval: defenseSpawnInterval(1, playerCount),
    nextSpawnAt: now + 500,
    pendingRoundAt: null,
    gold: {}, ended: false,
  };
}
function broadcastDefenseUpdate(room){
  const d = room.defense; if (!d) return;
  const now = Date.now();
  broadcastAll(room, {
    type: 'defenseUpdate', round: d.round, teamHp: d.teamHp, maxHp: d.maxHp,
    roundRemainMs: Math.max(0, d.roundEndAt - now),
    pending: !!(d.pendingRoundAt && now < d.pendingRoundAt),
    monsters: d.monsters.map(m => ({ id: m.id, type: m.type, progress: Math.min(1, (now - m.spawnAt) / m.travelMs), hp: m.hp, maxHp: m.maxHp })),
    boss: d.boss ? { id: d.boss.id, progress: Math.min(1, (now - d.boss.spawnAt) / d.boss.travelMs), hp: d.boss.hp, maxHp: d.boss.maxHp } : null,
  });
}
function clearDefenseRound(room){
  const d = room.defense;
  for (const [id, p] of room.players) { if (!p.isBot) d.gold[id] = (d.gold[id] || 0) + 1; }
  const clearedRound = d.round;
  d.round += 1;
  d.monsters = [];
  d.pendingRoundAt = Date.now() + DEFENSE_ROUND_GAP_MS;
  broadcastAll(room, { type: 'defenseRoundClear', clearedRound, nextRound: d.round });
}
function endDefenseGame(room, bossDefeated){
  const d = room.defense; if (!d || d.ended) return;
  d.ended = true;
  clearInterval(room.defenseInterval);
  if (d.round === 5 && bossDefeated) {
    for (const [id, p] of room.players) { if (!p.isBot) d.gold[id] = (d.gold[id] || 0) + 2; }
  }
  const ipCounts = {};
  for (const [, p] of room.players) { if (p.ip) ipCounts[p.ip] = (ipCounts[p.ip] || 0) + 1; }
  const noCoinIds = [...room.players.entries()].filter(([, p]) => p.ip && ipCounts[p.ip] >= 2).map(([id]) => id);
  const botCount = [...room.players.values()].filter(p => p.isBot).length;
  const results = [...room.players.entries()].map(([id, p]) => ({ id, name: p.name, gold: noCoinIds.includes(id) ? 0 : Math.max(0, (d.gold[id] || 0) - botCount), isBot: !!p.isBot }));
  broadcastAll(room, { type: 'defenseEnd', success: !!(bossDefeated && d.round === 5), roundReached: d.round, results });
  room.status = 'lobby';
  for (const [id, p] of room.players) { p.ready = (id === room.hostId) || p.isBot; p.score = 0; p.lines = 0; p.alive = true; p.bot = null; }
  broadcastAll(room, lobbyPayload(room));
}
function applyDefenseDamage(room, amount){
  const d = room.defense; if (!d || d.ended || amount <= 0) return;
  if (d.round === 5) {
    if (!d.boss) return;
    d.boss.hp -= amount;
    if (d.boss.hp <= 0) { endDefenseGame(room, true); return; }
  } else {
    const now = Date.now();
    d.monsters.sort((a, b) => ((now - b.spawnAt) / b.travelMs) - ((now - a.spawnAt) / a.travelMs));
    let remaining = amount;
    const survivors = [];
    for (const m of d.monsters) {
      if (remaining <= 0) { survivors.push(m); continue; }
      if (m.hp <= remaining) { remaining -= m.hp; }
      else { m.hp -= remaining; remaining = 0; survivors.push(m); }
    }
    d.monsters = survivors;
  }
  broadcastDefenseUpdate(room);
}
function startDefenseLoop(room){
  clearInterval(room.defenseInterval);
  room.defenseInterval = setInterval(() => {
    const d = room.defense;
    if (room.status !== 'playing' || !d || d.ended) { clearInterval(room.defenseInterval); return; }
    const now = Date.now();
    if (d.pendingRoundAt) {
      if (now < d.pendingRoundAt) { broadcastDefenseUpdate(room); return; }
      d.pendingRoundAt = null;
      const playerCount = room.players.size;
      if (d.round === 5) {
        d.boss = { id: uid(), spawnAt: now, travelMs: DEFENSE_BOSS_MS, hp: DEFENSE_BOSS_HP, maxHp: DEFENSE_BOSS_HP };
        d.roundEndAt = now + DEFENSE_BOSS_MS;
      } else {
        const duration = defenseRoundDuration(d.round);
        d.roundEndAt = now + duration;
        d.nextSpawnAt = now;
        d.spawnInterval = defenseSpawnInterval(d.round, playerCount);
      }
    }
    if (d.round !== 5) {
      if (now >= d.nextSpawnAt) {
        const pool = defenseMonsterPool(d.round);
        for (let i = 0; i < DEFENSE_SPAWN_BATCH; i++) {
          const type = pool[Math.floor(Math.random() * pool.length)];
          const hp = DEFENSE_MONSTER_HP[type] || 1;
          d.monsters.push({ id: uid(), type, spawnAt: now, travelMs: DEFENSE_MONSTER_TRAVEL_MS, hp, maxHp: hp });
        }
        d.nextSpawnAt = now + d.spawnInterval;
      }
      d.monsters = d.monsters.filter(m => {
        if ((now - m.spawnAt) / m.travelMs >= 1) { d.teamHp = Math.max(0, d.teamHp - 1); return false; }
        return true;
      });
      if (d.teamHp <= 0) { endDefenseGame(room, false); return; }
      if (now >= d.roundEndAt) { clearDefenseRound(room); return; }
    } else {
      if (d.boss && (now - d.boss.spawnAt) / d.boss.travelMs >= 1) { endDefenseGame(room, false); return; }
      if (d.teamHp <= 0) { endDefenseGame(room, false); return; }
    }
    broadcastDefenseUpdate(room);
  }, 200);
}

function checkEnd(room) {
  if (room.status !== 'playing') return;
  const alivePlayers = [...room.players.entries()].filter(([, p]) => p.alive);
  const startCount = room.startCount || room.players.size;
  // 살아있는 사람이 1명 이하이거나, 접속 자체가 1명만 남은 경우(나머지 전원 접속 끊김) 모두 종료 처리
  if (startCount >= 2 && (alivePlayers.length <= 1 || room.players.size <= 1)) {
    room.status = 'ended';
    const duration = Date.now() - (room.playStartedAt || Date.now());
    const noCoins = duration < 60000;
    // 동일 IP로 2인 이상 참여(다중접속) 감지 시 해당 인원은 이번 판 코인 지급 대상에서 제외 (조용히 차단, 별도 안내 없음)
    const ipCounts = {};
    for (const [, p] of room.players) { if (p.ip) ipCounts[p.ip] = (ipCounts[p.ip] || 0) + 1; }
    const noCoinIds = [...room.players.entries()].filter(([, p]) => p.ip && ipCounts[p.ip] >= 2).map(([id]) => id);
    const ranking = [...room.players.entries()]
      .map(([id, p]) => ({ id, name: p.name, score: p.score, alive: p.alive }))
      .sort((a, b) => (b.alive - a.alive) || (b.score - a.score));
    broadcastAll(room, { type: 'end', ranking, winnerId: alivePlayers[0] ? alivePlayers[0][0] : null, mode: room.mode, noCoins, noCoinIds });
    // 종료 후 방을 나가지 않고 대기실로 복귀 (호스트만 자동 준비, 나머지는 재준비 필요)
    room.status = 'lobby';
    for (const [id, p] of room.players) { p.ready = (id === room.hostId) || p.isBot; p.score = 0; p.lines = 0; p.alive = true; p.bot = null; }
    broadcastAll(room, lobbyPayload(room));
  }
}

// 응답 없는 연결(비정상 종료 등)을 주기적으로 정리 - 방이 유령처럼 남는 것을 방지
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) { ws.terminate(); return; }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  });
}, 10000);

// 종료됐지만 정리되지 않은 방(빈 방, 오래된 종료 상태)을 주기적으로 청소 - 무료 서버 메모리 보호
setInterval(() => {
  for (const [id, room] of rooms) {
    if (room.players.size === 0) { rooms.delete(id); continue; }
    if (room.status === 'ended') { rooms.delete(id); continue; }
  }
}, 2 * 60 * 1000);

server.listen(PORT, () => {
  console.log(`테트리스 배틀 서버 실행 중: http://localhost:${PORT}`);
});

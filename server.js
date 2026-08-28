const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- 정적 파일 서버 ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg' };
const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = path.join(PUBLIC_DIR, path.normalize(filePath).replace(/^(\.\.[\/\\])+/, ''));
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
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
function lobbyPayload(room) {
  return {
    type: 'lobby',
    roomId: room.id,
    title: room.title,
    hostId: room.hostId,
    isPrivate: room.isPrivate,
    players: [...room.players.entries()].map(([id, p]) => ({ id, name: p.name, ready: p.ready }))
  };
}
function roomListPayload() {
  const list = [...rooms.values()]
    .filter(r => r.status === 'lobby' && r.players.size < 4)
    .map(r => ({
      roomId: r.id,
      title: r.title || null,
      hostName: (r.players.get(r.hostId) || {}).name || '플레이어',
      count: r.players.size,
      max: 4,
      isPrivate: r.isPrivate
    }));
  return { type: 'roomList', rooms: list };
}

wss.on('connection', (ws) => {
  ws.playerId = null;
  ws.roomId = null;
  ws.isAlive = true;
  ws.msgCount = 0;
  ws.msgWindowStart = Date.now();
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
      const title = String(msg.roomTitle || '').slice(0, 20) || null;
      const room = { id, title, isPrivate, password, hostId, status: 'lobby', startAt: null, players: new Map() };
      room.players.set(hostId, { ws, name: String(msg.name || '플레이어').slice(0, 8), ready: true, alive: true, score: 0, lines: 0 });
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
      if (room.players.size >= 4) { send(ws, { type: 'error', message: '방이 가득 찼어요 (최대 4인).' }); return; }
      if (room.isPrivate && String(msg.password || '') !== room.password) {
        send(ws, { type: 'error', message: '코드가 올바르지 않아요.' });
        return;
      }
      const id2 = uid();
      room.players.set(id2, { ws, name: String(msg.name || '플레이어').slice(0, 8), ready: false, alive: true, score: 0, lines: 0 });
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
      broadcast(room, { type: 'countdown', startAt: room.startAt });
      setTimeout(() => {
        if (room.status !== 'starting') return;
        room.status = 'playing';
        for (const p of room.players.values()) { p.alive = true; p.score = 0; p.lines = 0; }
        const playerList = [...room.players.entries()].map(([id, p]) => ({ id, name: p.name }));
        broadcast(room, { type: 'gameStart', players: playerList });
      }, 3000);
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
      if (wasAlive && !me.alive) checkEnd(room);
      return;
    }

    if (msg.type === 'garbage') {
      const aliveOthers = [...room.players.entries()].filter(([id, p]) => id !== ws.playerId && p.alive);
      if (aliveOthers.length === 0) return;
      const [targetId, targetP] = aliveOthers[Math.floor(Math.random() * aliveOthers.length)];
      send(targetP.ws, { type: 'garbage', amount: msg.amount, from: me.name });
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
    if (!room || !ws.playerId) return;
    room.players.delete(ws.playerId);
    if (room.players.size === 0) { rooms.delete(ws.roomId); return; }
    if (room.hostId === ws.playerId) {
      room.hostId = room.players.keys().next().value;
    }
    if (room.status === 'lobby') {
      broadcast(room, lobbyPayload(room));
    } else if (room.status === 'playing') {
      checkEnd(room);
    }
  });
});

function checkEnd(room) {
  if (room.status !== 'playing') return;
  const alivePlayers = [...room.players.entries()].filter(([, p]) => p.alive);
  if (room.players.size >= 2 && alivePlayers.length <= 1) {
    room.status = 'ended';
    const ranking = [...room.players.entries()]
      .map(([id, p]) => ({ id, name: p.name, score: p.score, alive: p.alive }))
      .sort((a, b) => (b.alive - a.alive) || (b.score - a.score));
    broadcast(room, { type: 'end', ranking, winnerId: alivePlayers[0] ? alivePlayers[0][0] : null });
  }
}

// 응답 없는 연결(비정상 종료 등)을 주기적으로 정리 - 방이 유령처럼 남는 것을 방지
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) { ws.terminate(); return; }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  });
}, 30000);

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

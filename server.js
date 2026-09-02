const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const MAX_STRIKES = 6;
const ROUND_POOL = 5;
const DEFAULT_TARGET_SCORE = 50;
const BUZZ_TIME_MS = 20000;
const ROUND_TIME_MS = 120000;
const DISCONNECT_GRACE_MS = 120000; // 2 min to reconnect before permanently removed

const MIME = { '.html': 'text/html', '.json': 'application/json', '.js': 'application/javascript', '.png': 'image/png' };

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const staticMap = {
    '/manifest.json': 'manifest.json',
    '/service-worker.js': 'service-worker.js',
    '/icon-192.png': 'icon-192.png',
    '/icon-512.png': 'icon-512.png',
  };
  const relPath = staticMap[url] || 'index.html';
  const ext = path.extname(relPath);
  fs.readFile(path.join(__dirname, 'public', relPath), (err, data) => {
    if (err) { res.writeHead(500); res.end('Server error'); return; }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/html' });
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server });
const rooms = new Map();
const socketsByPlayer = new Map();
const buzzTimers = new Map();
const roundTimers = new Map();
const disconnectTimers = new Map(); // playerId -> timeout handle

function clearBuzzTimer(code) { if (buzzTimers.has(code)) { clearTimeout(buzzTimers.get(code)); buzzTimers.delete(code); } }
function clearRoundTimer(code) { if (roundTimers.has(code)) { clearTimeout(roundTimers.get(code)); roundTimers.delete(code); } }
function clearAllTimers(code) { clearBuzzTimer(code); clearRoundTimer(code); }
function clearDisconnectTimer(playerId) { if (disconnectTimers.has(playerId)) { clearTimeout(disconnectTimers.get(playerId)); disconnectTimers.delete(playerId); } }

function randomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let c = '';
  for (let i = 0; i < 4; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}
function broadcastRoom(room) {
  const msg = JSON.stringify({ type: 'room', room });
  room.players.forEach(p => {
    const s = socketsByPlayer.get(p.id);
    if (s && s.readyState === WebSocket.OPEN) s.send(msg);
  });
}
function sendError(ws, message) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'error', message }));
}

function freshRoundState(room) {
  room.guessed = [];
  room.strikes = 0;
  room.hints = [];
  room.buzzHolder = null;
  room.lockedOut = [];
  room.contributions = {};
  room.roundResult = null;
  room.buzzDeadline = null;
  room.roundDeadline = null;
}

function wordDisplayDone(room) {
  return room.currentWord.split('').every(ch => ch === ' ' || room.guessed.includes(ch) || room.hints.some(h => h.letter === ch));
}

function giveHintLetter(room) {
  const uniqueLetters = [...new Set(room.currentWord.replace(/ /g, '').split(''))];
  if (uniqueLetters.length <= 4) return false;
  if (room.hints.length >= 2) return false;
  const candidates = uniqueLetters.filter(l => !room.guessed.includes(l) && !room.hints.some(h => h.letter === l));
  if (candidates.length === 0) return false;
  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  room.hints.push({ letter: pick });
  return true;
}

function distributePoints(room, winnerIdIfInstant) {
  const contributions = { ...room.contributions };
  if (winnerIdIfInstant) {
    const revealedSoFar = new Set([...room.guessed.filter(l => room.currentWord.includes(l)), ...room.hints.map(h => h.letter)]);
    const remaining = [...new Set(room.currentWord.replace(/ /g, '').split(''))].filter(l => !revealedSoFar.has(l));
    contributions[winnerIdIfInstant] = (contributions[winnerIdIfInstant] || 0) + Math.max(1, remaining.length);
  }
  const total = Object.values(contributions).reduce((a, b) => a + b, 0);
  if (total <= 0) return;
  const raw = {};
  let assigned = 0;
  const entries = Object.entries(contributions);
  entries.forEach(([id, units]) => {
    const share = Math.floor((units / total) * ROUND_POOL);
    raw[id] = share;
    assigned += share;
  });
  let remainder = ROUND_POOL - assigned;
  entries.sort((a, b) => (b[1] / total) - (a[1] / total));
  let i = 0;
  while (remainder > 0 && entries.length > 0) {
    const id = entries[i % entries.length][0];
    raw[id] = (raw[id] || 0) + 1;
    remainder -= 1;
    i += 1;
  }
  for (const id in raw) room.scores[id] = (room.scores[id] || 0) + raw[id];
}

function checkGameOver(room) {
  const target = room.targetScore || DEFAULT_TARGET_SCORE;
  const winner = room.players.find(p => (room.scores[p.id] || 0) >= target);
  if (!winner) return false;
  room.finalTable = [...room.players]
    .map(p => ({ id: p.id, name: p.name, score: room.scores[p.id] || 0 }))
    .sort((a, b) => b.score - a.score);
  return true;
}

function loseRoundByStrikeout(room, note) {
  const setterName = (room.players.find(p => p.id === room.setterId) || {}).name || 'The Word Master';
  room.scores[room.setterId] = (room.scores[room.setterId] || 0) + ROUND_POOL;
  room.roundResult = { won: false, note: note || (setterName + ' stumped the group and takes ' + ROUND_POOL + ' points.') };
  room.buzzHolder = null;
  room.buzzDeadline = null;
  room.roundDeadline = null;
  clearAllTimers(room.code);
  room.phase = checkGameOver(room) ? 'game-over' : 'round-result';
}

function startRoundTimer(room) {
  clearRoundTimer(room.code);
  room.roundDeadline = Date.now() + ROUND_TIME_MS;
  const t = setTimeout(() => {
    const r = rooms.get(room.code);
    if (!r || r.phase !== 'guessing') return;
    const setterName = (r.players.find(p => p.id === r.setterId) || {}).name || 'The Word Master';
    loseRoundByStrikeout(r, "Time's up! " + setterName + ' takes ' + ROUND_POOL + ' points.');
    broadcastRoom(r);
  }, ROUND_TIME_MS);
  roundTimers.set(room.code, t);
}

function startBuzzTimer(room) {
  clearBuzzTimer(room.code);
  room.buzzDeadline = Date.now() + BUZZ_TIME_MS;
  const holderAtStart = room.buzzHolder;
  const t = setTimeout(() => {
    const r = rooms.get(room.code);
    if (!r || r.phase !== 'guessing' || r.buzzHolder !== holderAtStart) return;
    r.strikes += 1;
    if (!r.lockedOut.includes(holderAtStart)) r.lockedOut.push(holderAtStart);
    r.buzzHolder = null;
    r.buzzDeadline = null;
    clearBuzzTimer(r.code);
    if (r.strikes >= MAX_STRIKES) loseRoundByStrikeout(r);
    broadcastRoom(r);
  }, BUZZ_TIME_MS);
  buzzTimers.set(room.code, t);
}

function permanentlyRemove(code, playerId) {
  const room = rooms.get(code);
  if (!room) return;
  room.players = room.players.filter(p => p.id !== playerId);
  delete room.scores[playerId];
  room.voiceOn = (room.voiceOn || []).filter(id => id !== playerId);
  room.lockedOut = (room.lockedOut || []).filter(id => id !== playerId);
  socketsByPlayer.delete(playerId);
  clearDisconnectTimer(playerId);

  if (room.players.length === 0) { rooms.delete(code); clearAllTimers(code); return; }

  if (room.hostId === playerId) room.hostId = room.players[0].id;

  if (room.buzzHolder === playerId) { room.buzzHolder = null; room.buzzDeadline = null; clearBuzzTimer(code); }

  if (room.setterId === playerId && (room.phase === 'word-entry' || room.phase === 'guessing')) {
    // orphaned round — void it, hand word-giving duty to the host, back to word-entry
    room.setterId = room.hostId;
    room.currentWord = '';
    freshRoundState(room);
    clearAllTimers(code);
    room.phase = 'word-entry';
  }

  broadcastRoom(room);
}

wss.on('connection', (ws) => {
  ws.playerId = null;
  ws.roomCode = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    if (msg.type === 'create') {
      const code = randomCode();
      const room = {
        code, phase: 'lobby',
        players: [{ id: msg.id, name: msg.name, connected: true }],
        scores: { [msg.id]: 0 },
        hostId: msg.id, setterId: null,
        currentWord: '', guessed: [], strikes: 0, hints: [],
        buzzHolder: null, lockedOut: [], contributions: {}, roundResult: null,
        finalTable: null, voiceOn: [], targetScore: DEFAULT_TARGET_SCORE,
        buzzDeadline: null, roundDeadline: null,
      };
      rooms.set(code, room);
      ws.playerId = msg.id; ws.roomCode = code;
      socketsByPlayer.set(msg.id, ws);
      broadcastRoom(room);
      return;
    }

    if (msg.type === 'join') {
      const room = rooms.get(msg.code);
      if (!room) { sendError(ws, 'No room found with that code.'); return; }

      const existing = room.players.find(p => p.id === msg.id);
      if (existing) {
        // reconnect — same browser/id rejoining, mid-game or not
        existing.connected = true;
        if (msg.name && msg.name.trim()) existing.name = msg.name.trim();
        clearDisconnectTimer(msg.id);
        ws.playerId = msg.id; ws.roomCode = msg.code;
        socketsByPlayer.set(msg.id, ws);
        broadcastRoom(room);
        return;
      }

      if (room.phase !== 'lobby') {
        sendError(ws, 'That game already started — ask the host to add you next round.');
        return;
      }
      if (room.players.some(p => p.name.toLowerCase() === (msg.name || '').trim().toLowerCase())) {
        sendError(ws, 'That name is taken in this room.'); return;
      }
      room.players.push({ id: msg.id, name: msg.name, connected: true });
      room.scores[msg.id] = 0;
      ws.playerId = msg.id; ws.roomCode = msg.code;
      socketsByPlayer.set(msg.id, ws);
      broadcastRoom(room);
      return;
    }

    const room = rooms.get(ws.roomCode);

    if (msg.type === 'leave') {
      if (!room) return;
      permanentlyRemove(room.code, msg.id);
      return;
    }

    if (msg.type === 'setTargetScore') {
      if (!room || msg.id !== room.hostId || room.phase !== 'lobby') return;
      const val = parseInt(msg.value, 10);
      if (!Number.isFinite(val) || val < 10 || val > 500) { sendError(ws, 'Winning score must be between 10 and 500.'); return; }
      room.targetScore = val;
      broadcastRoom(room);
      return;
    }

    if (msg.type === 'start') {
      if (!room || msg.id !== room.hostId || room.players.length < 2) return;
      room.setterId = msg.id;
      room.phase = 'word-entry';
      broadcastRoom(room);
      return;
    }

    if (msg.type === 'setWord') {
      if (!room || msg.id !== room.setterId) return;
      const val = (msg.word || '').trim();
      if (val.length < 3 || !/^[a-zA-Z ]+$/.test(val)) { sendError(ws, 'Use only letters/spaces, at least 3 letters.'); return; }
      room.currentWord = val.toUpperCase();
      freshRoundState(room);
      room.phase = 'guessing';
      startRoundTimer(room);
      broadcastRoom(room);
      return;
    }

    if (msg.type === 'giveHint') {
      if (!room || room.phase !== 'guessing' || msg.id !== room.setterId) return;
      if (giveHintLetter(room)) broadcastRoom(room);
      return;
    }

    if (msg.type === 'buzz') {
      if (!room || room.phase !== 'guessing') return;
      if (msg.id === room.setterId) return;
      if (room.buzzHolder) return;
      if ((room.lockedOut || []).includes(msg.id)) return;
      room.buzzHolder = msg.id;
      startBuzzTimer(room);
      broadcastRoom(room);
      return;
    }

    if (msg.type === 'guessLetter') {
      if (!room || room.phase !== 'guessing') return;
      if (msg.id !== room.buzzHolder) return;
      const letter = (msg.letter || '').toUpperCase().slice(0, 1);
      if (!letter || room.guessed.includes(letter)) return;
      room.guessed.push(letter);

      if (room.currentWord.includes(letter)) {
        room.contributions[msg.id] = (room.contributions[msg.id] || 0) + 1;
        if (wordDisplayDone(room)) {
          room.roundResult = { won: true, note: room.players.find(p => p.id === msg.id).name + ' finished the word!' };
          room.setterId = msg.id;
          distributePoints(room);
          room.buzzHolder = null; room.buzzDeadline = null; room.roundDeadline = null;
          clearAllTimers(room.code);
          room.phase = checkGameOver(room) ? 'game-over' : 'round-result';
        } else {
          startBuzzTimer(room);
        }
      } else {
        room.strikes += 1;
        if (!room.lockedOut.includes(msg.id)) room.lockedOut.push(msg.id);
        room.buzzHolder = null;
        room.buzzDeadline = null;
        clearBuzzTimer(room.code);
        if (room.strikes >= MAX_STRIKES) loseRoundByStrikeout(room);
      }
      broadcastRoom(room);
      return;
    }

    if (msg.type === 'guessWord') {
      if (!room || room.phase !== 'guessing') return;
      if (msg.id !== room.buzzHolder) return;
      const attempt = (msg.word || '').trim().toUpperCase();
      if (!attempt) return;

      if (attempt === room.currentWord) {
        room.roundResult = { won: true, note: room.players.find(p => p.id === msg.id).name + ' guessed the whole word!' };
        room.setterId = msg.id;
        distributePoints(room, msg.id);
        room.buzzHolder = null; room.buzzDeadline = null; room.roundDeadline = null;
        clearAllTimers(room.code);
        room.phase = checkGameOver(room) ? 'game-over' : 'round-result';
      } else {
        room.strikes += 1;
        if (!room.lockedOut.includes(msg.id)) room.lockedOut.push(msg.id);
        room.buzzHolder = null;
        room.buzzDeadline = null;
        clearBuzzTimer(room.code);
        if (room.strikes >= MAX_STRIKES) loseRoundByStrikeout(room);
      }
      broadcastRoom(room);
      return;
    }

    if (msg.type === 'nextRound') {
      if (!room || msg.id !== room.setterId || room.phase !== 'round-result') return;
      room.phase = 'word-entry';
      room.currentWord = '';
      freshRoundState(room);
      clearAllTimers(room.code);
      broadcastRoom(room);
      return;
    }

    if (msg.type === 'newGame') {
      if (!room || msg.id !== room.hostId || room.phase !== 'game-over') return;
      room.players.forEach(p => { room.scores[p.id] = 0; });
      room.setterId = null;
      room.currentWord = '';
      freshRoundState(room);
      clearAllTimers(room.code);
      room.finalTable = null;
      room.phase = 'lobby';
      broadcastRoom(room);
      return;
    }

    if (msg.type === 'signal') {
      const target = socketsByPlayer.get(msg.to);
      if (target && target.readyState === WebSocket.OPEN) {
        target.send(JSON.stringify({ type: 'signal', from: msg.id, data: msg.data }));
      }
      return;
    }

    if (msg.type === 'voiceStatus') {
      if (!room) return;
      room.voiceOn = room.voiceOn || [];
      if (msg.on) { if (!room.voiceOn.includes(msg.id)) room.voiceOn.push(msg.id); }
      else { room.voiceOn = room.voiceOn.filter(id => id !== msg.id); }
      broadcastRoom(room);
      return;
    }
  });

  ws.on('close', () => {
    const room = rooms.get(ws.roomCode);
    if (!room || !ws.playerId) return;
    const player = room.players.find(p => p.id === ws.playerId);
    if (!player) return;
    player.connected = false;
    if (room.buzzHolder === ws.playerId) { room.buzzHolder = null; room.buzzDeadline = null; clearBuzzTimer(room.code); }
    broadcastRoom(room);
    clearDisconnectTimer(ws.playerId);
    disconnectTimers.set(ws.playerId, setTimeout(() => permanentlyRemove(room.code, ws.playerId), DISCONNECT_GRACE_MS));
  });
});

server.listen(PORT, () => console.log('Chalkboard Hangman server running on port ' + PORT));

const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const MAX_STRIKES = 6;
const ROUND_POOL = 5;
const WIN_SCORE = 50;

const MIME = { '.html':'text/html', '.json':'application/json', '.js':'application/javascript', '.png':'image/png' };

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const staticMap = {
    '/manifest.json': 'manifest.json',
    '/service-worker.js': 'service-worker.js',
    '/icons/icon-192.png': 'icons/icon-192.png',
    '/icons/icon-512.png': 'icons/icon-512.png',
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
  room.contributions = {};
  room.roundResult = null;
}

function wordDisplayDone(room) {
  return room.currentWord.split('').every(ch => ch === ' ' || room.guessed.includes(ch) || room.hints.some(h => h.letter === ch));
}

function maybeRevealHint(room) {
  const word = room.currentWord;
  const uniqueLetters = [...new Set(word.replace(/ /g, '').split(''))];
  if (uniqueLetters.length <= 4) return;
  const thresholds = [2, 4];
  const hintIndex = thresholds.indexOf(room.strikes);
  if (hintIndex === -1) return;
  if (room.hints.length > hintIndex) return;
  const candidates = uniqueLetters.filter(l => !room.guessed.includes(l) && !room.hints.some(h => h.letter === l));
  if (candidates.length === 0) return;
  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  room.hints.push({ letter: pick });
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
  for (const id in raw) {
    room.scores[id] = (room.scores[id] || 0) + raw[id];
  }
}

function checkGameOver(room) {
  const winner = room.players.find(p => (room.scores[p.id] || 0) >= WIN_SCORE);
  if (!winner) return false;
  room.finalTable = [...room.players]
    .map(p => ({ id: p.id, name: p.name, score: room.scores[p.id] || 0 }))
    .sort((a, b) => b.score - a.score);
  return true;
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
        players: [{ id: msg.id, name: msg.name }],
        scores: { [msg.id]: 0 },
        hostId: msg.id, setterId: null,
        currentWord: '', guessed: [], strikes: 0, hints: [],
        buzzHolder: null, contributions: {}, roundResult: null,
        finalTable: null, voiceOn: [],
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
      if (room.phase !== 'lobby') { sendError(ws, 'That game has already started.'); return; }
      if (room.players.some(p => p.name.toLowerCase() === (msg.name || '').trim().toLowerCase())) {
        sendError(ws, 'That name is taken in this room.'); return;
      }
      room.players.push({ id: msg.id, name: msg.name });
      room.scores[msg.id] = 0;
      ws.playerId = msg.id; ws.roomCode = msg.code;
      socketsByPlayer.set(msg.id, ws);
      broadcastRoom(room);
      return;
    }

    const room = rooms.get(ws.roomCode);

    if (msg.type === 'leave') {
      if (!room) return;
      room.players = room.players.filter(p => p.id !== msg.id);
      delete room.scores[msg.id];
      socketsByPlayer.delete(msg.id);
      if (room.players.length === 0) { rooms.delete(room.code); return; }
      if (room.hostId === msg.id) room.hostId = room.players[0].id;
      if (room.buzzHolder === msg.id) room.buzzHolder = null;
      room.voiceOn = (room.voiceOn || []).filter(id => id !== msg.id);
      broadcastRoom(room);
      return;
    }

    if (msg.type === 'voiceStatus') {
      if (!room) return;
      room.voiceOn = room.voiceOn || [];
      if (msg.on) {
        if (!room.voiceOn.includes(msg.id)) room.voiceOn.push(msg.id);
      } else {
        room.voiceOn = room.voiceOn.filter(id => id !== msg.id);
      }
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
      if (val.length < 3 || !/^[a-zA-Z ]+$/.test(val)) {
        sendError(ws, 'Use only letters/spaces, at least 3 letters.');
        return;
      }
      room.currentWord = val.toUpperCase();
      freshRoundState(room);
      room.phase = 'guessing';
      broadcastRoom(room);
      return;
    }

    if (msg.type === 'buzz') {
      if (!room || room.phase !== 'guessing') return;
      if (msg.id === room.setterId) return;
      if (room.buzzHolder) return;
      room.buzzHolder = msg.id;
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
          room.phase = checkGameOver(room) ? 'game-over' : 'round-result';
        }
      } else {
        room.strikes += 1;
        room.buzzHolder = null;
        maybeRevealHint(room);
        if (room.strikes >= MAX_STRIKES) {
          const setterName = room.players.find(p => p.id === room.setterId).name;
          room.scores[room.setterId] = (room.scores[room.setterId] || 0) + ROUND_POOL;
          room.roundResult = { won: false, note: setterName + ' stumped the group and takes ' + ROUND_POOL + ' points.' };
          room.phase = checkGameOver(room) ? 'game-over' : 'round-result';
        }
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
        room.phase = checkGameOver(room) ? 'game-over' : 'round-result';
      } else {
        room.strikes += 1;
        room.buzzHolder = null;
        maybeRevealHint(room);
        if (room.strikes >= MAX_STRIKES) {
          const setterName = room.players.find(p => p.id === room.setterId).name;
          room.scores[room.setterId] = (room.scores[room.setterId] || 0) + ROUND_POOL;
          room.roundResult = { won: false, note: setterName + ' stumped the group and takes ' + ROUND_POOL + ' points.' };
          room.phase = checkGameOver(room) ? 'game-over' : 'round-result';
        }
      }
      broadcastRoom(room);
      return;
    }

    if (msg.type === 'nextRound') {
      if (!room || msg.id !== room.setterId || room.phase !== 'round-result') return;
      room.phase = 'word-entry';
      room.currentWord = '';
      freshRoundState(room);
      broadcastRoom(room);
      return;
    }

    if (msg.type === 'newGame') {
      if (!room || msg.id !== room.hostId || room.phase !== 'game-over') return;
      room.players.forEach(p => { room.scores[p.id] = 0; });
      room.setterId = null;
      room.currentWord = '';
      freshRoundState(room);
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
  });

  ws.on('close', () => {
    if (ws.playerId) socketsByPlayer.delete(ws.playerId);
    const room = rooms.get(ws.roomCode);
    if (room) {
      room.players = room.players.filter(p => p.id !== ws.playerId);
      delete room.scores[ws.playerId];
      if (room.buzzHolder === ws.playerId) room.buzzHolder = null;
      room.voiceOn = (room.voiceOn || []).filter(id => id !== ws.playerId);
      if (room.players.length === 0) {
        rooms.delete(ws.roomCode);
      } else {
        if (room.hostId === ws.playerId) room.hostId = room.players[0].id;
        broadcastRoom(room);
      }
    }
  });
});

server.listen(PORT, () => console.log('Chalkboard Hangman server running on port ' + PORT));

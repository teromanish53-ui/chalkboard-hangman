const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const MAX_WRONG = 6;

const server = http.createServer((req, res) => {
  fs.readFile(path.join(__dirname, 'public', 'index.html'), (err, data) => {
    if (err) { res.writeHead(500); res.end('Server error'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server });
const rooms = new Map();          // code -> room object
const socketsByPlayer = new Map(); // playerId -> ws

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
        currentWord: '', guessed: [], wrong: 0,
        turnOrder: [], turnPointer: 0, roundResult: null,
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
      room.guessed = [];
      room.wrong = 0;
      room.turnOrder = room.players.filter(p => p.id !== room.setterId).map(p => p.id);
      room.turnPointer = 0;
      room.roundResult = null;
      room.phase = 'guessing';
      broadcastRoom(room);
      return;
    }

    if (msg.type === 'guess') {
      if (!room || room.phase !== 'guessing') return;
      const currentGuesser = room.turnOrder[room.turnPointer % room.turnOrder.length];
      if (msg.id !== currentGuesser) return;
      const letter = (msg.letter || '').toUpperCase();
      if (room.guessed.includes(letter)) return;
      room.guessed.push(letter);

      const inWord = room.currentWord.includes(letter);
      if (inWord) room.scores[msg.id] = (room.scores[msg.id] || 0) + 1;
      else room.wrong += 1;

      const wordDone = room.currentWord.split('').every(ch => ch === ' ' || room.guessed.includes(ch));
      if (wordDone) {
        room.scores[msg.id] = (room.scores[msg.id] || 0) + 3;
        const name = room.players.find(p => p.id === msg.id).name;
        room.roundResult = { won: true, note: name + ' called the final letter, +3 bonus, and gives the next word.' };
        room.setterId = msg.id;
        room.phase = 'round-result';
      } else if (room.wrong >= MAX_WRONG) {
        const setterName = room.players.find(p => p.id === room.setterId).name;
        room.scores[room.setterId] = (room.scores[room.setterId] || 0) + 5;
        room.roundResult = { won: false, note: setterName + ' stumped the group, +5 bonus, and gives the next word again.' };
        room.phase = 'round-result';
      } else {
        room.turnPointer = (room.turnPointer + 1) % room.turnOrder.length;
      }
      broadcastRoom(room);
      return;
    }

    if (msg.type === 'nextRound') {
      if (!room || msg.id !== room.setterId) return;
      room.phase = 'word-entry';
      room.currentWord = '';
      room.guessed = [];
      room.wrong = 0;
      room.roundResult = null;
      broadcastRoom(room);
      return;
    }

    // Voice chat signaling relay (WebRTC offer/answer/ICE) — server just passes it through
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

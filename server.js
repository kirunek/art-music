const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const server = http.createServer((req, res) => { res.writeHead(200); res.end('ok'); });
const wss = new WebSocketServer({ server });
server.listen(PORT, () => console.log(`WebSocket server on port ${PORT}`));

// rooms: Map<roomId, Map<playerId, ws>>
const rooms = new Map();
const MAX_PLAYERS = 2;

function uid(){ return Math.random().toString(36).slice(2, 8); }

function send(ws, msg){ if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }

function broadcast(roomId, msg, excludeId){
  const players = rooms.get(roomId);
  if (!players) return;
  for (const [id, ws] of players){
    if (id !== excludeId) send(ws, msg);
  }
}

wss.on('connection', ws => {
  const playerId = uid();
  let roomId = null;

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch(e){ return; }

    if (msg.type === 'join'){
      const room = String(msg.room || '').trim().toUpperCase().slice(0, 12);
      if (!room) return;

      // leave current room
      if (roomId){
        const prev = rooms.get(roomId);
        if (prev){ prev.delete(playerId); if (!prev.size) rooms.delete(roomId); }
        broadcast(roomId, { type: 'player_left', playerId });
      }

      if (!rooms.has(room)) rooms.set(room, new Map());
      const players = rooms.get(room);

      if (players.size >= MAX_PLAYERS){
        send(ws, { type: 'error', msg: 'room_full' });
        roomId = null;
        return;
      }

      players.set(playerId, ws);
      roomId = room;

      send(ws, { type: 'joined', playerId, room, playerCount: players.size });
      broadcast(room, { type: 'player_joined', playerId }, playerId);
    }

    if (msg.type === 'move' && roomId){
      broadcast(roomId, { type: 'move', playerId, touches: msg.touches || [] }, playerId);
    }
  });

  ws.on('close', () => {
    if (!roomId) return;
    const players = rooms.get(roomId);
    if (players){ players.delete(playerId); if (!players.size) rooms.delete(roomId); }
    broadcast(roomId, { type: 'player_left', playerId });
  });
});


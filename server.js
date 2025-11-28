const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

const READY_STATE_OPEN = WebSocket.OPEN || 1;

const rooms = new Map();

wss.on('connection', socket => {
    socket.meta = { roomId: null, role: null };

    socket.on('message', data => {
        try {
            const payload = JSON.parse(data);
            handleMessage(socket, payload);
        } catch (err) {
            send(socket, { type: 'error', message: 'Invalid JSON payload' });
        }
    });

    socket.on('close', () => handleDisconnect(socket));
});

function handleMessage(socket, payload) {
    // Log incoming messages for debugging
    if (payload.type === 'motion-detected') {
        console.log(`Server received motion-detected from ${payload.from || 'unknown'} in room ${payload.roomId}`);
    }
    
    switch (payload.type) {
        case 'create-room':
            return createRoom(socket, payload.roomId);
        case 'join-room':
            return joinRoom(socket, payload.roomId);
        case 'offer':
        case 'answer':
        case 'ice-candidate':
        case 'motion-detected':
            return relaySignal(socket, payload);
        default:
            return send(socket, { type: 'error', message: 'Unknown message type' });
    }
}

function createRoom(socket, roomId) {
    if (!roomId) {
        send(socket, { type: 'error', message: 'Room ID required' });
        return;
    }
    if (rooms.has(roomId)) {
        send(socket, { type: 'error', message: 'Room already exists' });
        return;
    }
    rooms.set(roomId, {
        host: socket,
        inspector: null,
        pendingForInspector: [],
        pendingForHost: []
    });
    socket.meta = { roomId, role: 'provider' };
    send(socket, { type: 'room-created', roomId });
    console.log(`Room ${roomId} created`);
}

function joinRoom(socket, roomId) {
    const room = rooms.get(roomId);
    if (!room || !room.host) {
        send(socket, { type: 'error', message: 'Room not found' });
        return;
    }
    if (room.inspector && room.inspector.readyState === READY_STATE_OPEN) {
        send(socket, { type: 'error', message: 'Room already has an inspector' });
        return;
    }
    room.inspector = socket;
    socket.meta = { roomId, role: 'inspector' };
    send(socket, { type: 'room-joined', roomId });
    send(room.host, { type: 'inspector-joined' });
    console.log(`Inspector joined room ${roomId}, flushing ${room.pendingForInspector.length} queued messages`);
    flushQueue(room.pendingForInspector, socket);
    console.log(`Inspector joined room ${roomId}`);
}

function relaySignal(socket, payload) {
    const { roomId } = payload;
    const room = rooms.get(roomId);
    if (!room) {
        send(socket, { type: 'error', message: 'Room not found' });
        return;
    }
    const role = socket.meta.role;
    if (!role) {
        send(socket, { type: 'error', message: 'Join a room before sending signals' });
        return;
    }

    const targetRole = role === 'provider' ? 'inspector' : 'provider';
    const targetSocket = targetRole === 'inspector' ? room.inspector : room.host;
    const queue = targetRole === 'inspector' ? room.pendingForInspector : room.pendingForHost;

    const message = sanitizeSignal(payload);

    // Log motion-detected messages for debugging
    if (payload.type === 'motion-detected') {
        console.log(`Relaying motion-detected from ${role} to ${targetRole} in room ${roomId}`);
    }

    if (targetSocket && targetSocket.readyState === READY_STATE_OPEN) {
        send(targetSocket, message);
        if (payload.type === 'motion-detected') {
            console.log(`Motion-detected sent directly to ${targetRole}`);
        }
    } else {
        queue.push(message);
        if (payload.type === 'motion-detected') {
            console.log(`Motion-detected queued for ${targetRole} (queue length: ${queue.length})`);
        }
    }
}

function sanitizeSignal(payload) {
    const { type, offer, answer, candidate } = payload;
    return { type, offer, answer, candidate };
}

function flushQueue(queue, socket) {
    while (queue.length && socket.readyState === READY_STATE_OPEN) {
        const msg = queue.shift();
        send(socket, msg);
    }
}

function handleDisconnect(socket) {
    const { roomId, role } = socket.meta || {};
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;

    if (role === 'provider') {
        if (room.inspector) {
            send(room.inspector, { type: 'provider-left' });
            room.inspector.meta = { roomId: null, role: null };
            room.inspector.close();
        }
        rooms.delete(roomId);
        console.log(`Room ${roomId} closed`);
    } else if (role === 'inspector') {
        room.inspector = null;
        room.pendingForInspector = [];
        if (room.host && room.host.readyState === READY_STATE_OPEN) {
            send(room.host, { type: 'inspector-left' });
        }
    }
}

function send(socket, payload) {
    if (!socket || socket.readyState !== READY_STATE_OPEN) return;
    socket.send(JSON.stringify(payload));
}

console.log(`Signaling server running on ws://localhost:${PORT}`);


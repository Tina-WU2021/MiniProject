// const SIGNALING_URL = (() => {
//     const protocol = location.protocol === 'https:' ? 'wss://' : 'ws://';
//     const host = location.hostname || 'localhost';
//     const port = 8080;
//     return `${protocol}${host}:${port}`;
// })();
const SIGNALING_URL = 'ws://192.168.8.3:8080';

const servers = {
    iceServers: [
        { urls: ['stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'] }
    ]
};

let ws;
let wsReadyPromise;
let roomId = null;
let peerConnection;
let localStream;

const providerVideo = document.getElementById('providerVideo');
const startBtn = document.getElementById('startBtn');
const roomCode = document.getElementById('roomCode');
const statusText = document.getElementById('statusText');

startBtn.addEventListener('click', async () => {
    startBtn.disabled = true;
    try {
        await startProvider();
    } catch (err) {
        console.error(err);
        updateStatus('Failed to start camera');
        startBtn.disabled = false;
    }
});

function connectSignaling() {
    ws = new WebSocket(SIGNALING_URL);
    wsReadyPromise = new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true });
        ws.addEventListener('error', reject, { once: true });
    });
    ws.addEventListener('message', handleSignalMessage);
    ws.addEventListener('close', () => updateStatus('Signaling disconnected'));
    ws.addEventListener('error', () => updateStatus('Signaling error'));
}

async function ensureSocket() {
    if (!ws || ws.readyState === WebSocket.CLOSED) {
        connectSignaling();
    }
    if (ws.readyState === WebSocket.OPEN) return;
    await wsReadyPromise;
}

async function startProvider() {
    roomId = generateRoomId();
    roomCode.textContent = roomId;
    updateStatus('Requesting camera access…');

    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    providerVideo.srcObject = localStream;

    try {
        await ensureSocket();
    } catch (err) {
        console.error('Signaling connection failed', err);
        updateStatus('Camera on, but signaling server is unreachable');
        return;
    }

    peerConnection = new RTCPeerConnection(servers);
    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

    peerConnection.onicecandidate = event => {
        if (event.candidate) {
            sendSignal({
                type: 'ice-candidate',
                candidate: event.candidate
            });
        }
    };

    peerConnection.onconnectionstatechange = () => {
        if (!peerConnection) return;
        if (peerConnection.connectionState === 'connected') {
            updateStatus('Streaming to inspector');
        }
    };

    ws.send(JSON.stringify({ type: 'create-room', roomId }));
    updateStatus('Waiting for inspector to join room ' + roomId);

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    sendSignal({ type: 'offer', offer });
}

function handleSignalMessage(event) {
    const data = JSON.parse(event.data);
    switch (data.type) {
        case 'room-created':
            updateStatus('Room created. Share code ' + roomId);
            break;
        case 'inspector-joined':
            updateStatus('Inspector joined. Connecting…');
            break;
        case 'answer':
            handleAnswer(data.answer);
            break;
        case 'ice-candidate':
            handleRemoteCandidate(data.candidate);
            break;
        case 'inspector-left':
            updateStatus('Inspector disconnected');
            break;
        case 'error':
            updateStatus(data.message || 'Unknown error');
            alert(data.message || 'Signaling error');
            break;
        default:
            break;
    }
}

async function handleAnswer(answer) {
    if (!peerConnection) return;
    await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
    updateStatus('Answer received. Finalising connection…');
}

async function handleRemoteCandidate(candidate) {
    if (!peerConnection || !candidate) return;
    try {
        await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
        console.error('Failed to add candidate', err);
    }
}

function sendSignal(payload) {
    if (!roomId || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ roomId, from: 'provider', ...payload }));
}

function generateRoomId() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

function updateStatus(text) {
    statusText.textContent = text;
}


// const SIGNALING_URL = (() => {
//     const protocol = location.protocol === 'https:' ? 'wss://' : 'ws://';
//     const host = location.hostname || 'localhost';
//     const port = 8080;
//     return `${protocol}${host}:${port}`;
// })();
const SIGNALING_URL = 'https://miniproject-7tgi.onrender.com';

const servers = {
    iceServers: [
        { urls: ['stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'] }
    ]
};

let ws;
let wsReadyPromise;
let roomId = null;
let peerConnection;
let remoteStream;

const inspectorVideo = document.getElementById('inspectorVideo');
const roomInput = document.getElementById('roomInput');
const joinBtn = document.getElementById('joinBtn');
const connectedRoom = document.getElementById('connectedRoom');
const statusText = document.getElementById('statusText');

joinBtn.addEventListener('click', async () => {
    try {
        const value = roomInput.value.trim();
        if (!value || value.length < 4) {
            alert('Enter a valid room number');
            return;
        }
        joinBtn.disabled = true;
        await ensureSocket();
        await joinRoom(value);
    } catch (err) {
        console.error(err);
        updateStatus('Failed to join room');
        joinBtn.disabled = false;
    }
});

connectSignaling();

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

async function joinRoom(value) {
    roomId = value;
    connectedRoom.textContent = roomId;
    updateStatus('Joining room...');
    ws.send(JSON.stringify({ type: 'join-room', roomId }));
}

async function ensurePeerConnection() {
    if (peerConnection) return;

    remoteStream = new MediaStream();
    inspectorVideo.srcObject = remoteStream;

    peerConnection = new RTCPeerConnection(servers);
    peerConnection.ontrack = event => {
        event.streams[0].getTracks().forEach(track => remoteStream.addTrack(track));
    };

    peerConnection.onicecandidate = event => {
        if (event.candidate) {
            sendSignal({
                type: 'ice-candidate',
                candidate: event.candidate
            });
        }
    };
}

function handleSignalMessage(event) {
    const data = JSON.parse(event.data);
    switch (data.type) {
        case 'room-joined':
            updateStatus('Joined room. Waiting for video…');
            break;
        case 'offer':
            handleOffer(data.offer);
            break;
        case 'ice-candidate':
            handleRemoteCandidate(data.candidate);
            break;
        case 'provider-left':
            updateStatus('Provider disconnected');
            joinBtn.disabled = false;
            break;
        case 'error':
            updateStatus(data.message || 'Unknown error');
            alert(data.message || 'Signaling error');
            joinBtn.disabled = false;
            break;
        default:
            break;
    }
}

async function handleOffer(offer) {
    await ensurePeerConnection();
    await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    sendSignal({ type: 'answer', answer });
    updateStatus('Receiving remote stream');
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
    ws.send(JSON.stringify({ roomId, from: 'inspector', ...payload }));
}

function updateStatus(text) {
    statusText.textContent = text;
}


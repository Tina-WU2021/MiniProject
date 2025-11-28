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
const motionStatus = document.getElementById('motionStatus');

// Initialize motion status display
if (motionStatus) {
    motionStatus.textContent = 'No motion';
    console.log('Motion status element found and initialized');
} else {
    console.error('Motion status element not found in DOM!');
}

joinBtn.addEventListener('click', async () => {
    try {
        const value = roomInput.value.trim();
        if (!value || value.length < 4) {
            updateStatus('Please enter a valid room number');
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
        ws.addEventListener('open', () => {
            console.log('Inspector WebSocket connected');
            resolve();
        }, { once: true });
        ws.addEventListener('error', (err) => {
            console.error('Inspector WebSocket error:', err);
            reject(err);
        }, { once: true });
    });
    ws.addEventListener('message', (event) => {
        console.log('Inspector raw message received:', event.data);
        handleSignalMessage(event);
    });
    ws.addEventListener('close', () => {
        console.log('Inspector WebSocket closed');
        updateStatus('Signaling disconnected');
    });
    ws.addEventListener('error', (err) => {
        console.error('Inspector WebSocket error:', err);
        updateStatus('Signaling error');
    });
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
    try {
        const data = JSON.parse(event.data);
        console.log('Inspector received message:', data.type, data);
        
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
            case 'motion-detected':
                console.log('Motion detected event received');
                showMotionDetected();
                break;
            case 'provider-left':
                updateStatus('Provider disconnected');
                resetMotionStatus();
                joinBtn.disabled = false;
                break;
            case 'error':
                updateStatus(data.message || 'Unknown error');
                console.error('Signaling error:', data.message || 'Unknown error');
                joinBtn.disabled = false;
                break;
            default:
                console.log('Unhandled message type:', data.type);
                break;
        }
    } catch (err) {
        console.error('Error parsing message:', err, event.data);
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

let motionTimeout = null;

function showMotionDetected() {
    if (motionStatus) {
        motionStatus.textContent = 'Motion detected';
        
        // Clear any existing timeout
        if (motionTimeout) {
            clearTimeout(motionTimeout);
        }
        
        // Reset to "No motion" after 0.75 seconds (you can change this to 0.5 or 1.0)
        motionTimeout = setTimeout(() => {
            if (motionStatus) {
                motionStatus.textContent = 'No motion';
            }
            motionTimeout = null;
        }, 750);
    } else {
        console.warn('Motion status element not found');
    }
}

function resetMotionStatus() {
    if (motionTimeout) {
        clearTimeout(motionTimeout);
        motionTimeout = null;
    }
    if (motionStatus) {
        motionStatus.textContent = 'No motion';
    }
}


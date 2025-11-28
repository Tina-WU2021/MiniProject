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
let localStream;
let motionDetectionActive = false;
let lastFrame = null;
let canvas = null;
let ctx = null;
let motionThreshold = 30; // Adjust sensitivity (0-255)
let lastMotionStatus = null; // Track last sent status to avoid redundant updates
let providerMotionTimeout = null; // Timeout for resetting provider motion display
let lastMotionEventTime = 0; // Track when last motion event was sent
let motionEventInterval = 1000; // Send motion event every 1 second while motion is detected

const providerVideo = document.getElementById('providerVideo');
const startBtn = document.getElementById('startBtn');
const roomCode = document.getElementById('roomCode');
const statusText = document.getElementById('statusText');
const motionStatus = document.getElementById('motionStatus');

// Initialize motion status display
if (motionStatus) {
    motionStatus.textContent = 'No motion';
}

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

    // Initialize motion detection
    initializeMotionDetection();

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
        const state = peerConnection.connectionState;
        if (state === 'connected') {
            updateStatus('Connected and streaming');
        } else if (state === 'connecting') {
            updateStatus('Connecting...');
        } else if (state === 'disconnected' || state === 'failed') {
            updateStatus('Connection lost');
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
            stopMotionDetection();
            break;
        case 'error':
            // Ignore "Unknown message type" errors and show connected status instead
            if (data.message === 'Unknown message type') {
                if (peerConnection && peerConnection.connectionState === 'connected') {
                    updateStatus('Connected and streaming');
                } else {
                    updateStatus('Connected');
                }
                console.log('Ignoring unknown message type error (likely from server)');
            } else {
                updateStatus(data.message || 'Unknown error');
                console.error('Signaling error:', data.message || 'Unknown error');
            }
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

function initializeMotionDetection() {
    // Create canvas for frame analysis
    canvas = document.createElement('canvas');
    ctx = canvas.getContext('2d', { willReadFrequently: true });
    
    // Wait for video to be ready
    const setupCanvas = () => {
        if (providerVideo.videoWidth > 0 && providerVideo.videoHeight > 0) {
            canvas.width = providerVideo.videoWidth;
            canvas.height = providerVideo.videoHeight;
        }
    };
    
    providerVideo.addEventListener('loadedmetadata', setupCanvas);
    providerVideo.addEventListener('loadeddata', setupCanvas);

    // Start motion detection loop after a short delay to ensure video is ready
    motionDetectionActive = true;
    setTimeout(() => {
        detectMotion();
    }, 1000);
}

function detectMotion() {
    if (!motionDetectionActive || !providerVideo || !canvas || !ctx) return;
    
    if (providerVideo.readyState === providerVideo.HAVE_ENOUGH_DATA && 
        providerVideo.videoWidth > 0 && providerVideo.videoHeight > 0) {
        // Ensure canvas dimensions match video
        if (canvas.width !== providerVideo.videoWidth || canvas.height !== providerVideo.videoHeight) {
            canvas.width = providerVideo.videoWidth;
            canvas.height = providerVideo.videoHeight;
        }
        
        try {
            // Draw current frame to canvas
            ctx.drawImage(providerVideo, 0, 0, canvas.width, canvas.height);
            const currentFrame = ctx.getImageData(0, 0, canvas.width, canvas.height);
            
            if (lastFrame && lastFrame.data.length === currentFrame.data.length) {
                const motionDetected = compareFrames(lastFrame, currentFrame);
                const currentTime = Date.now();
                
                // Send event when motion is first detected (transition from false to true)
                if (motionDetected && !lastMotionStatus) {
                    console.log('Motion detected! Sending notification to inspector');
                    sendMotionDetected();
                    lastMotionEventTime = currentTime;
                }
                // Also send periodic events while motion is continuously detected
                else if (motionDetected && lastMotionStatus && 
                         (currentTime - lastMotionEventTime) >= motionEventInterval) {
                    console.log('Continuous motion detected! Sending notification to inspector');
                    sendMotionDetected();
                    lastMotionEventTime = currentTime;
                }
                
                lastMotionStatus = motionDetected;
            }
            
            lastFrame = currentFrame;
        } catch (err) {
            console.error('Error in motion detection:', err);
        }
    }
    
    // Check for motion every 500ms
    setTimeout(detectMotion, 500);
}

function compareFrames(frame1, frame2) {
    if (!frame1 || !frame2) return false;
    
    const data1 = frame1.data;
    const data2 = frame2.data;
    if (data1.length !== data2.length) return false;
    
    let diff = 0;
    let pixelCount = 0;
    let significantChanges = 0;
    
    // Compare pixels (sample every 4th pixel for performance)
    for (let i = 0; i < data1.length; i += 16) { // RGBA = 4 bytes, so 16 = 4 pixels
        const r1 = data1[i];
        const g1 = data1[i + 1];
        const b1 = data1[i + 2];
        
        const r2 = data2[i];
        const g2 = data2[i + 1];
        const b2 = data2[i + 2];
        
        // Calculate color difference
        const rDiff = Math.abs(r1 - r2);
        const gDiff = Math.abs(g1 - g2);
        const bDiff = Math.abs(b1 - b2);
        const avgDiff = (rDiff + gDiff + bDiff) / 3;
        
        diff += avgDiff;
        pixelCount++;
        
        // Count pixels with significant change (more than threshold)
        if (avgDiff > motionThreshold) {
            significantChanges++;
        }
    }
    
    const avgDiff = diff / pixelCount;
    // Motion detected if average difference exceeds threshold OR if significant portion of pixels changed
    const motionDetected = avgDiff > motionThreshold || (significantChanges / pixelCount) > 0.05;
    
    return motionDetected;
}

function sendMotionDetected() {
    // Update local display
    if (motionStatus) {
        motionStatus.textContent = 'Motion detected';
        
        // Clear any existing timeout
        if (providerMotionTimeout) {
            clearTimeout(providerMotionTimeout);
        }
        
        // Reset to "No motion" after 0.75 seconds
        providerMotionTimeout = setTimeout(() => {
            if (motionStatus) {
                motionStatus.textContent = 'No motion';
            }
            providerMotionTimeout = null;
        }, 750);
    }
    
    // Send motion-detected event to inspector via WebSocket
    if (!roomId) {
        console.log('Cannot send motion detected: No roomId');
        return;
    }
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        console.log('Cannot send motion detected: WebSocket not ready (state:', ws ? ws.readyState : 'null', ')');
        return;
    }
    console.log('Sending motion-detected event to inspector. RoomId:', roomId);
    const payload = { 
        type: 'motion-detected'
    };
    sendSignal(payload);
}

function stopMotionDetection() {
    motionDetectionActive = false;
    lastFrame = null;
    lastMotionStatus = null;
    lastMotionEventTime = 0;
    
    // Clear motion timeout and reset display
    if (providerMotionTimeout) {
        clearTimeout(providerMotionTimeout);
        providerMotionTimeout = null;
    }
    if (motionStatus) {
        motionStatus.textContent = 'No motion';
    }
}


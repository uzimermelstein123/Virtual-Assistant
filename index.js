'use strict';

// LivekitClient is loaded globally via CDN script tag in index.html
const { Room, RoomEvent, Track } = window.LivekitClient;

const statusEl = document.querySelector('#status');
const connectBtn = document.querySelector('#connectBtn');
const disconnectBtn = document.querySelector('#disconnectBtn');
const connectionStatusEl = document.querySelector('#connectionStatus');
const talkBtn = document.querySelector('#talkBtn');
const recordBtn = document.querySelector('#recordBtn');
const mediaElement = document.querySelector('#mediaElement');
const avatarPlaceholder = document.querySelector('#avatarPlaceholder');
const taskInput = document.querySelector('#taskInput');
const clearCartBtn = document.querySelector('#clearCartBtn');
const menuDisplay = document.querySelector('#menuDisplay');
const orderDisplay = document.querySelector('#orderDisplay');

let room = null;
let sessionId = null;
let recognition = null;
let isRecording = false;
let cart = [];

const orderId = crypto.randomUUID().slice(0, 8);

// LiveKit topics
const COMMAND_TOPIC = 'agent-control';
const RESPONSE_TOPIC = 'agent-response';

function log(msg) {
  statusEl.innerHTML += msg + '<br>';
  statusEl.scrollTop = statusEl.scrollHeight;
}

// ── Menu + order file display ─────────────────────────────────────────────────

async function fetchMenu() {
  try {
    const resp = await fetch('/menu');
    menuDisplay.textContent = resp.ok ? await resp.text() : 'Failed to load menu.';
  } catch {
    menuDisplay.textContent = 'Failed to load menu.';
  }
}

async function refreshOrder() {
  try {
    const resp = await fetch(`/order/${orderId}`);
    orderDisplay.textContent = resp.ok ? await resp.text() : 'No items yet';
  } catch {
    orderDisplay.textContent = 'No items yet';
  }
}

// ── LiveKit data channel ──────────────────────────────────────────────────────

function sendCommand(event_type, extra = {}) {
  if (!room?.localParticipant) return;
  const payload = { event_id: crypto.randomUUID(), event_type, ...extra };
  const data = new TextEncoder().encode(JSON.stringify(payload));
  room.localParticipant.publishData(data, { reliable: true, topic: COMMAND_TOPIC });
}

function speakText(text) {
  if (room?.localParticipant) {
    sendCommand('avatar.interrupt');
    sendCommand('avatar.speak_text', { text });
  } else {
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  }
}

function handleDataReceived(payload, _participant, _kind, topic) {
  if (topic !== RESPONSE_TOPIC) return;
  let event;
  try {
    event = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return;
  }
  switch (event.event_type) {
    case 'session.state_updated':
      log(`Session: ${event.state}`);
      if (event.state === 'connected') setConnected(true);
      break;
    case 'avatar.speak_started':
      connectionStatusEl.textContent = 'Speaking…';
      break;
    case 'avatar.speak_ended':
      connectionStatusEl.textContent = 'Connected';
      break;
    case 'user.transcription':
      if (event.text) log(`You said: "${event.text}"`);
      break;
    case 'avatar.transcription':
      if (event.text) log(`Avatar: "${event.text}"`);
      break;
  }
}

// ── Connection lifecycle ──────────────────────────────────────────────────────

async function connect() {
  connectBtn.disabled = true;
  connectionStatusEl.textContent = 'Connecting…';
  log('Requesting session from server…');

  try {
    const resp = await fetch('/liveavatar-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (!resp.ok) {
      const err = await resp.json();
      throw new Error(err.error || 'Session request failed');
    }
    const { livekit_url, livekit_client_token, session_id } = await resp.json();
    sessionId = session_id;
    log('Session created. Connecting to LiveKit…');

    room = new Room({ adaptiveStream: true, dynacast: true });

    room.on(RoomEvent.TrackSubscribed, (track) => {
      if (track.kind === Track.Kind.Video) {
        track.attach(mediaElement);
        mediaElement.style.display = 'block';
        avatarPlaceholder.style.display = 'none';
      } else if (track.kind === Track.Kind.Audio) {
        track.attach();
      }
    });

    room.on(RoomEvent.TrackUnsubscribed, (track) => { track.detach(); });
    room.on(RoomEvent.DataReceived, handleDataReceived);
    room.on(RoomEvent.Disconnected, () => {
      log('Disconnected from LiveKit.');
      setConnected(false);
    });

    await room.connect(livekit_url, livekit_client_token);
    log('Connected to LiveKit room.');
    setTimeout(() => {
      if (connectionStatusEl.textContent === 'Connecting…') setConnected(true);
    }, 5000);
  } catch (err) {
    log(`Connection error: ${err.message}`);
    connectionStatusEl.textContent = 'Disconnected';
    connectBtn.disabled = false;
  }
}

async function disconnect() {
  recognition?.stop();
  if (room) {
    room.disconnect();
    room = null;
  }
  if (sessionId) {
    await fetch('/liveavatar-stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId }),
    }).catch(() => {});
    sessionId = null;
  }
  mediaElement.srcObject = null;
  mediaElement.style.display = 'none';
  avatarPlaceholder.style.display = 'flex';
  cart = [];
  setConnected(false);
  log('Session ended.');
}

function setConnected(connected) {
  connectBtn.disabled = connected;
  disconnectBtn.disabled = !connected;
  connectionStatusEl.textContent = connected ? 'Connected' : 'Disconnected';
}

// ── LLM call ──────────────────────────────────────────────────────────────────

async function talkToLLM(prompt) {
  const resp = await fetch('/openai/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, cart, order_id: orderId }),
  });
  if (!resp.ok) throw new Error(await resp.text());
  return resp.json(); // { text, cart }
}

// ── Talk button ───────────────────────────────────────────────────────────────

async function talkHandler() {
  const prompt = taskInput.value.trim();
  if (!prompt) { alert('Enter a message first'); return; }
  log('Thinking…');
  try {
    const { text, cart: newCart } = await talkToLLM(prompt);
    cart = newCart || cart;
    await refreshOrder();
    speakText(text);
    log('Done.');
  } catch (err) {
    console.error(err);
    log(`Error: ${err.message}`);
  }
}

// ── Continuous Speech (Web Speech API) ───────────────────────────────────────

function recordSpeechHandler() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    log('Speech recognition not supported — use Chrome or Edge.');
    return;
  }

  if (isRecording) {
    isRecording = false;
    recognition?.stop();
    return;
  }

  recognition = new SpeechRecognition();
  recognition.lang = 'en-US';
  recognition.continuous = true;
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;

  recognition.onstart = () => {
    isRecording = true;
    recordBtn.textContent = '⏹ Stop Listening';
    log('Listening continuously — speak naturally, pause to send.');
  };

  recognition.onresult = async (event) => {
    const result = event.results[event.results.length - 1];
    if (!result.isFinal) return;
    const transcript = result[0].transcript.trim();
    if (!transcript) return;

    log(`You said: "${transcript}"`);
    try {
      const { text, cart: newCart } = await talkToLLM(transcript);
      cart = newCart || cart;
      await refreshOrder();
      speakText(text);
    } catch (err) {
      console.error(err);
      log(`Error: ${err.message}`);
    }
  };

  recognition.onerror = (e) => {
    if (e.error !== 'no-speech') log(`Speech error: ${e.error}`);
  };

  recognition.onend = () => {
    if (isRecording) {
      recognition.start();
    } else {
      recordBtn.textContent = 'Start Listening';
      recognition = null;
    }
  };

  recognition.start();
}

// ── Button listeners ──────────────────────────────────────────────────────────

connectBtn.addEventListener('click', connect);
disconnectBtn.addEventListener('click', disconnect);
talkBtn.addEventListener('click', talkHandler);
recordBtn.addEventListener('click', recordSpeechHandler);
clearCartBtn.addEventListener('click', async () => {
  await fetch('/order/clear', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ order_id: orderId }),
  });
  cart = [];
  await refreshOrder();
});

// ── Init ──────────────────────────────────────────────────────────────────────

mediaElement.style.display = 'none';
fetchMenu();
log('Click <strong>Connect</strong> to start.');

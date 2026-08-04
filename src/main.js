import { PoseLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";

const video = document.getElementById("video");
const gameCanvas = document.getElementById("gameCanvas");
const gameCtx = gameCanvas.getContext("2d");
const camCanvas = document.getElementById("camCanvas");
const camCtx = camCanvas.getContext("2d");
const laneDebugCanvas = document.getElementById("laneDebugCanvas");
const laneDebugCtx = laneDebugCanvas.getContext("2d");

const startBtn = document.getElementById("startBtn");
const calibrateBtn = document.getElementById("calibrateBtn");
const permissionMsg = document.getElementById("permissionMsg");
const statusText = document.getElementById("statusText");
const fpsText = document.getElementById("fpsText");
const debugLog = document.getElementById("debugLog");

const boxes = {
  jump: document.getElementById("jumpBox"),
  crouch: document.getElementById("crouchBox"),
  left: document.getElementById("leftBox"),
  right: document.getElementById("rightBox"),
};
const values = {
  jump: document.getElementById("jumpValue"),
  crouch: document.getElementById("crouchValue"),
  left: document.getElementById("leftValue"),
  right: document.getElementById("rightValue"),
};

const WIDTH = 640;
const HEIGHT = 480;
gameCanvas.width = WIDTH;
gameCanvas.height = HEIGHT;
camCanvas.width = 320;
camCanvas.height = 240;
laneDebugCanvas.width = 240;
laneDebugCanvas.height = 80;

let poseLandmarker = null;
let running = false;
let lastFrameTime = performance.now();
let baseline = null;

const THRESHOLDS = {
  jumpDelta: 0.05,
  crouchDelta: 0.05,
  dodgeDelta: 0.08,
};

// ---- Phase state machine ----
// idle -> countdown (5s, get in position) -> calibrating (grab baseline on next frame) -> playing
let phase = "idle";
let countdownRemaining = 0;
const COUNTDOWN_MS = 5000;

// ---- Character / game state ----
const character = {
  lane: 1, // 0 left, 1 center, 2 right — target lane, snapped from the dot's zone
  visualLane: 1, // smoothed float position used for rendering; eases toward `lane`
  isJumping: false,
  jumpT: 0,
  isCrouching: false,
};

// How far (in normalized frame units) you need to shift from your calibrated
// center before it counts as entering the left/right zone, instead of center.
const DODGE_ZONE = 0.09;
// How fast the rendered character glides between lanes (lanes per second).
const LANE_GLIDE_SPEED = 6;

let prevRawState = { jump: false, crouch: false, left: false, right: false };
let lastLandmarks = null;

const HORIZON_Y = 110;
const GROUND_Y = HEIGHT - 20;
const TOP_LANES_HALF_WIDTH = 40;
const BOTTOM_LANES_HALF_WIDTH = 220;
const CENTER_X = WIDTH / 2;

function laneEdgeX(edgeIndex, y) {
  const t = (y - HORIZON_Y) / (GROUND_Y - HORIZON_Y);
  const topX = CENTER_X - TOP_LANES_HALF_WIDTH + (edgeIndex / 3) * (TOP_LANES_HALF_WIDTH * 2);
  const bottomX = CENTER_X - BOTTOM_LANES_HALF_WIDTH + (edgeIndex / 3) * (BOTTOM_LANES_HALF_WIDTH * 2);
  return topX + (bottomX - topX) * t;
}

function laneCenterX(laneIndex, y) {
  return (laneEdgeX(laneIndex, y) + laneEdgeX(laneIndex + 1, y)) / 2;
}

// Interpolates between lane centers for a fractional lane value (e.g. 1.4),
// so the character glides smoothly instead of snapping — and passing from
// lane 2 to lane 0 necessarily crosses through lane 1's position.
function laneVisualX(laneFloat, y) {
  const clamped = Math.min(2, Math.max(0, laneFloat));
  const lower = Math.floor(clamped);
  const upper = Math.min(2, lower + 1);
  const t = clamped - lower;
  const xLower = laneCenterX(lower, y);
  const xUpper = laneCenterX(upper, y);
  return xLower + (xUpper - xLower) * t;
}

function logDebug(msg) {
  console.log(msg);
  const lines = debugLog.textContent.split("\n").filter((l) => l !== "Waiting for camera start...");
  lines.push(msg);
  while (lines.length > 8) lines.shift();
  debugLog.textContent = lines.join("\n");
  debugLog.scrollTop = debugLog.scrollHeight;
}

async function initPoseLandmarker() {
  const vision = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.9/wasm"
  );
  poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath:
        "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
      delegate: "GPU",
    },
    runningMode: "VIDEO",
    numPoses: 1,
  });
}

async function startCamera() {
  try {
    statusText.textContent = "Loading model...";
    if (!poseLandmarker) await initPoseLandmarker();

    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: "user" },
      audio: false,
    });

    video.srcObject = stream;
    await video.play();

    permissionMsg.textContent = "Camera active";

    // Reset everything for a fresh run
    character.lane = 1;
    character.visualLane = 1;
    character.isJumping = false;
    character.jumpT = 0;
    character.isCrouching = false;
    baseline = null;
    phase = "countdown";
    countdownRemaining = COUNTDOWN_MS;

    running = true;
    requestAnimationFrame(loop);
  } catch (err) {
    console.error(err);
    permissionMsg.textContent = "Camera permission denied or unavailable";
    statusText.textContent = "Error";
  }
}

function loop() {
  if (!running) return;

  const now = performance.now();
  const delta = now - lastFrameTime;
  lastFrameTime = now;
  fpsText.textContent = Math.round(1000 / delta);

  if (poseLandmarker && video.readyState >= 2) {
    const result = poseLandmarker.detectForVideo(video, now);
    if (result.landmarks && result.landmarks.length > 0) {
      lastLandmarks = result.landmarks[0];
    }
  }

  if (phase === "countdown") {
    countdownRemaining -= delta;
    const secondsLeft = Math.max(0, Math.ceil(countdownRemaining / 1000));
    statusText.textContent = `Get in position: ${secondsLeft}`;
    if (countdownRemaining <= 0) {
      phase = "calibrating";
    }
  } else if (phase === "calibrating") {
    if (lastLandmarks) {
      captureBaseline(lastLandmarks);
      phase = "playing";
      statusText.textContent = "Calibrated — move around";
    }
  } else if (phase === "playing") {
    if (lastLandmarks) {
      const rawState = analyzePose(lastLandmarks);
      updateCharacterState(rawState, delta);
    }
  }

  drawCameraPreview();
  advanceJumpAnimation(delta);
  advanceLaneGlide(delta);
  renderGame();

  requestAnimationFrame(loop);
}

function captureBaseline(landmarks) {
  const LEFT_SHOULDER = landmarks[11];
  const RIGHT_SHOULDER = landmarks[12];
  const LEFT_HIP = landmarks[23];
  const RIGHT_HIP = landmarks[24];

  const hipY = (LEFT_HIP.y + RIGHT_HIP.y) / 2;
  const shoulderMidX = (LEFT_SHOULDER.x + RIGHT_SHOULDER.x) / 2;
  const mirroredNormX = 1 - shoulderMidX;

  baseline = { hipY, shoulderMidX, mirroredNormX };
  logDebug(
    `[calibrated] shoulderMidX=${shoulderMidX.toFixed(3)} mirroredNormX=${mirroredNormX.toFixed(3)} hipY=${hipY.toFixed(3)}`
  );
}

// Raw camera coordinates are NOT mirrored: moving your real right shifts your
// body toward the LEFT edge of the raw video frame (x decreases). We mirror
// the normalized x here so it matches what you see on screen and in the debug dot.
function analyzePose(landmarks) {
  const LEFT_SHOULDER = landmarks[11];
  const RIGHT_SHOULDER = landmarks[12];
  const LEFT_HIP = landmarks[23];
  const RIGHT_HIP = landmarks[24];

  const hipY = (LEFT_HIP.y + RIGHT_HIP.y) / 2;
  const shoulderMidX = (LEFT_SHOULDER.x + RIGHT_SHOULDER.x) / 2;

  const hipDelta = baseline.hipY - hipY;

  // Mirrored normalized x (0 = your real left edge of frame, 1 = your real right edge)
  const mirroredNormX = 1 - shoulderMidX;
  // Offset from YOUR calibrated center — not the middle of the whole camera frame.
  // This is what makes the zones match a realistic dodge distance instead of
  // requiring you to walk to the extreme edge of the frame.
  const offset = mirroredNormX - baseline.mirroredNormX;

  let column;
  if (offset < -DODGE_ZONE) column = 0; // left
  else if (offset > DODGE_ZONE) column = 2; // right
  else column = 1; // center

  const state = {
    jump: hipDelta > THRESHOLDS.jumpDelta,
    crouch: hipDelta < -THRESHOLDS.crouchDelta,
    column,
    hipDelta,
    rawShoulderMidX: shoulderMidX,
    mirroredNormX,
    offset,
  };

  updateRawDisplay(state);
  return state;
}

function updateRawDisplay(state) {
  boxes.jump.classList.toggle("active", state.jump);
  boxes.crouch.classList.toggle("active", state.crouch);
  boxes.left.classList.toggle("active", state.column === 0);
  boxes.right.classList.toggle("active", state.column === 2);
  values.jump.textContent = state.hipDelta.toFixed(2);
  values.crouch.textContent = state.hipDelta.toFixed(2);
  values.left.textContent = state.offset.toFixed(2);
  values.right.textContent = state.offset.toFixed(2);
}

function updateCharacterState(rawState, delta) {
  if (rawState.column !== character.lane) {
    logDebug(
      `[column change] rawShoulderMidX=${rawState.rawShoulderMidX.toFixed(3)} ` +
      `offset=${rawState.offset.toFixed(3)} ` +
      `lane ${character.lane} -> ${rawState.column}`
    );
    character.lane = rawState.column;
  }

  const jumpEdge = rawState.jump && !prevRawState.jump;
  if (jumpEdge && !character.isJumping) {
    character.isJumping = true;
    character.jumpT = 0;
  }

  character.isCrouching = rawState.crouch && !character.isJumping;

  prevRawState = rawState;
}

function advanceJumpAnimation(delta) {
  if (!character.isJumping) return;
  character.jumpT += delta / 500;
  if (character.jumpT >= 1) {
    character.jumpT = 0;
    character.isJumping = false;
  }
}

// Eases visualLane toward the target lane at a fixed speed. Because this
// moves through every intermediate float value, going from lane 2 to lane 0
// always passes through lane 1's position — no teleporting across tracks.
function advanceLaneGlide(delta) {
  const maxStep = LANE_GLIDE_SPEED * (delta / 1000);
  const diff = character.lane - character.visualLane;
  if (Math.abs(diff) <= maxStep) {
    character.visualLane = character.lane;
  } else {
    character.visualLane += Math.sign(diff) * maxStep;
  }
}

function jumpHeight() {
  if (!character.isJumping) return 0;
  return Math.sin(character.jumpT * Math.PI) * 60;
}

// ---- Camera preview: mirrored display + grid overlay for debugging ----
function drawCameraPreview() {
  camCtx.save();
  // Mirror horizontally so the preview behaves like looking in a mirror
  camCtx.translate(camCanvas.width, 0);
  camCtx.scale(-1, 1);
  camCtx.drawImage(video, 0, 0, camCanvas.width, camCanvas.height);

  if (lastLandmarks) {
    drawSkeletonOnPreview(lastLandmarks);
  }
  camCtx.restore();

  drawLaneDebug();
}

function drawSkeletonOnPreview(landmarks) {
  const scaleX = camCanvas.width;
  const scaleY = camCanvas.height;
  const pairs = [
    [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
    [11, 23], [12, 24], [23, 24], [23, 25], [25, 27],
    [24, 26], [26, 28],
  ];
  camCtx.strokeStyle = "#4ade80";
  camCtx.lineWidth = 2;
  pairs.forEach(([i, j]) => {
    const p1 = landmarks[i];
    const p2 = landmarks[j];
    camCtx.beginPath();
    camCtx.moveTo(p1.x * scaleX, p1.y * scaleY);
    camCtx.lineTo(p2.x * scaleX, p2.y * scaleY);
    camCtx.stroke();
  });
}

function drawLaneDebug() {
  // Standalone canvas, separate from the camera preview. Shows the SAME
  // baseline-relative zones used by analyzePose() — not fixed frame thirds —
  // so what you see here is exactly what decides the character's lane.
  const w = laneDebugCanvas.width;
  const h = laneDebugCanvas.height;

  laneDebugCtx.clearRect(0, 0, w, h);

  // Zone boundaries in pixel space, centered on the calibrated baseline.
  // Falls back to dead-center 0.5 if not calibrated yet.
  const centerNormX = baseline ? baseline.mirroredNormX : 0.5;
  const leftBoundaryPx = (centerNormX - DODGE_ZONE) * w;
  const rightBoundaryPx = (centerNormX + DODGE_ZONE) * w;

  laneDebugCtx.fillStyle = "rgba(212,69,58,0.25)";
  laneDebugCtx.fillRect(0, 0, leftBoundaryPx, h);
  laneDebugCtx.fillStyle = "rgba(255,255,255,0.08)";
  laneDebugCtx.fillRect(leftBoundaryPx, 0, rightBoundaryPx - leftBoundaryPx, h);
  laneDebugCtx.fillStyle = "rgba(58,124,197,0.25)";
  laneDebugCtx.fillRect(rightBoundaryPx, 0, w - rightBoundaryPx, h);

  // Outline the zone that currently matches the character's lane
  laneDebugCtx.strokeStyle = "#4ade80";
  laneDebugCtx.lineWidth = 2;
  const zoneEdges = [0, leftBoundaryPx, rightBoundaryPx, w];
  laneDebugCtx.strokeRect(
    zoneEdges[character.lane] + 1,
    1,
    zoneEdges[character.lane + 1] - zoneEdges[character.lane] - 2,
    h - 2
  );

  laneDebugCtx.strokeStyle = "rgba(255,255,255,0.5)";
  laneDebugCtx.lineWidth = 1.5;
  laneDebugCtx.beginPath();
  laneDebugCtx.moveTo(leftBoundaryPx, 0);
  laneDebugCtx.lineTo(leftBoundaryPx, h);
  laneDebugCtx.moveTo(rightBoundaryPx, 0);
  laneDebugCtx.lineTo(rightBoundaryPx, h);
  laneDebugCtx.stroke();

  laneDebugCtx.fillStyle = "rgba(255,255,255,0.7)";
  laneDebugCtx.font = "9px sans-serif";
  laneDebugCtx.textAlign = "center";
  laneDebugCtx.fillText("L", leftBoundaryPx / 2, 12);
  laneDebugCtx.fillText("C", w / 2, 12);
  laneDebugCtx.fillText("R", (rightBoundaryPx + w) / 2, 12);
  laneDebugCtx.textAlign = "left";

  if (lastLandmarks) {
    const rawMidX = (lastLandmarks[11].x + lastLandmarks[12].x) / 2;
    const mirroredX = w - rawMidX * w;
    const dotY = h / 2 + 10;

    laneDebugCtx.fillStyle = "#ff0000";
    laneDebugCtx.strokeStyle = "#ffffff";
    laneDebugCtx.lineWidth = 2;
    laneDebugCtx.beginPath();
    laneDebugCtx.arc(mirroredX, dotY, 8, 0, Math.PI * 2);
    laneDebugCtx.fill();
    laneDebugCtx.stroke();

    laneDebugCtx.fillStyle = "#ffffff";
    laneDebugCtx.font = "9px sans-serif";
    laneDebugCtx.fillText(`x=${rawMidX.toFixed(3)}`, 4, h - 4);
  }
}

// ---- Background scene rendering ----
function renderGame() {
  drawSky();
  drawRiver();
  drawLanes();
  drawTrees();
  drawCharacterSprite();
}

function drawSky() {
  gameCtx.fillStyle = "#87ceeb";
  gameCtx.fillRect(0, 0, WIDTH, HORIZON_Y);
}

function drawRiver() {
  gameCtx.fillStyle = "#3a7ca5";
  gameCtx.beginPath();
  gameCtx.moveTo(laneEdgeX(0, HORIZON_Y) - 15, HORIZON_Y);
  gameCtx.lineTo(laneEdgeX(0, GROUND_Y) - 90, GROUND_Y);
  gameCtx.lineTo(laneEdgeX(0, GROUND_Y), GROUND_Y);
  gameCtx.lineTo(laneEdgeX(0, HORIZON_Y), HORIZON_Y);
  gameCtx.closePath();
  gameCtx.fill();

  gameCtx.strokeStyle = "rgba(255,255,255,0.4)";
  gameCtx.lineWidth = 1;
  for (let i = 0; i < 5; i++) {
    const y = HORIZON_Y + (i / 4) * (GROUND_Y - HORIZON_Y);
    const xLeft = laneEdgeX(0, y) - 15 - i * 15;
    gameCtx.beginPath();
    gameCtx.moveTo(xLeft, y);
    gameCtx.lineTo(xLeft + 30, y + 3);
    gameCtx.stroke();
  }
}

function drawLanes() {
  gameCtx.fillStyle = "#8a7a5c";
  gameCtx.beginPath();
  gameCtx.moveTo(laneEdgeX(0, HORIZON_Y), HORIZON_Y);
  gameCtx.lineTo(laneEdgeX(3, HORIZON_Y), HORIZON_Y);
  gameCtx.lineTo(laneEdgeX(3, GROUND_Y), GROUND_Y);
  gameCtx.lineTo(laneEdgeX(0, GROUND_Y), GROUND_Y);
  gameCtx.closePath();
  gameCtx.fill();

  for (let lane = 0; lane < 3; lane++) {
    drawRailLine(lane, -12);
    drawRailLine(lane, 12);
  }
  drawSleepers();

  gameCtx.strokeStyle = "rgba(0,0,0,0.25)";
  gameCtx.lineWidth = 1;
  for (let edge = 0; edge <= 3; edge++) {
    gameCtx.beginPath();
    gameCtx.moveTo(laneEdgeX(edge, HORIZON_Y), HORIZON_Y);
    gameCtx.lineTo(laneEdgeX(edge, GROUND_Y), GROUND_Y);
    gameCtx.stroke();
  }
}

function drawRailLine(lane, offsetAtBottom) {
  gameCtx.strokeStyle = "#c0c0c0";
  gameCtx.lineWidth = 2;
  gameCtx.beginPath();
  const steps = 20;
  for (let i = 0; i <= steps; i++) {
    const y = HORIZON_Y + (i / steps) * (GROUND_Y - HORIZON_Y);
    const t = (y - HORIZON_Y) / (GROUND_Y - HORIZON_Y);
    const cx = laneCenterX(lane, y);
    const x = cx + offsetAtBottom * t;
    if (i === 0) gameCtx.moveTo(x, y);
    else gameCtx.lineTo(x, y);
  }
  gameCtx.stroke();
}

function drawSleepers() {
  gameCtx.strokeStyle = "#6b5638";
  gameCtx.lineWidth = 3;
  const count = 14;
  for (let i = 0; i < count; i++) {
    const t = i / count;
    const y = HORIZON_Y + t * (GROUND_Y - HORIZON_Y);
    gameCtx.beginPath();
    gameCtx.moveTo(laneEdgeX(0, y), y);
    gameCtx.lineTo(laneEdgeX(3, y), y);
    gameCtx.stroke();
  }
}

function drawTrees() {
  for (let i = 0; i < 6; i++) {
    const t = i / 5;
    const y = HORIZON_Y + 15 + t * (GROUND_Y - HORIZON_Y - 15);
    const scale = 0.3 + t * 0.9;
    drawTree(laneEdgeX(0, y) - 40 * (0.3 + t), y, scale);
    drawTree(laneEdgeX(3, y) + 30 * (0.3 + t), y, scale);
  }
}

function drawTree(x, y, scale) {
  const trunkH = 14 * scale;
  const trunkW = 4 * scale;
  gameCtx.fillStyle = "#6b4423";
  gameCtx.fillRect(x - trunkW / 2, y - trunkH, trunkW, trunkH);

  gameCtx.fillStyle = "#2f6b3a";
  for (let i = 0; i < 3; i++) {
    const layerY = y - trunkH - i * 9 * scale;
    const layerW = (22 - i * 5) * scale;
    gameCtx.beginPath();
    gameCtx.moveTo(x, layerY - 14 * scale);
    gameCtx.lineTo(x - layerW / 2, layerY);
    gameCtx.lineTo(x + layerW / 2, layerY);
    gameCtx.closePath();
    gameCtx.fill();
  }
}

function drawCharacterSprite() {
  const y = GROUND_Y - 10;
  const x = laneVisualX(character.visualLane, y);
  const jumpOffset = jumpHeight();
  const crouchSquish = character.isCrouching ? 0.6 : 1;

  const baseY = y - jumpOffset;
  const bodyHeight = 40 * crouchSquish;
  const headRadius = 9;

  gameCtx.fillStyle = `rgba(0,0,0,${character.isJumping ? 0.15 : 0.3})`;
  gameCtx.beginPath();
  gameCtx.ellipse(x, y + 4, 16, 5, 0, 0, Math.PI * 2);
  gameCtx.fill();

  gameCtx.fillStyle = "#d4453a";
  gameCtx.fillRect(x - 10, baseY - bodyHeight, 20, bodyHeight);

  gameCtx.fillStyle = "#f0c090";
  gameCtx.beginPath();
  gameCtx.arc(x, baseY - bodyHeight - headRadius, headRadius, 0, Math.PI * 2);
  gameCtx.fill();

  gameCtx.strokeStyle = "#d4453a";
  gameCtx.lineWidth = 5;
  gameCtx.beginPath();
  gameCtx.moveTo(x - 10, baseY - bodyHeight + 8);
  gameCtx.lineTo(x - 18, baseY - bodyHeight * 0.4);
  gameCtx.moveTo(x + 10, baseY - bodyHeight + 8);
  gameCtx.lineTo(x + 18, baseY - bodyHeight * 0.4);
  gameCtx.stroke();
}

startBtn.addEventListener("click", startCamera);
calibrateBtn.addEventListener("click", () => {
  phase = "countdown";
  countdownRemaining = COUNTDOWN_MS;
  statusText.textContent = "Recalibrating...";
});
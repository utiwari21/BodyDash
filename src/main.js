import { PoseLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";

// ---- DOM ----
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
const scoreText = document.getElementById("scoreText");
const streakText = document.getElementById("streakText");
const levelText = document.getElementById("levelText");

// ---- Canvas sizes ----
const WIDTH = 640;
const HEIGHT = 480;
gameCanvas.width = WIDTH;
gameCanvas.height = HEIGHT;
camCanvas.width = 320;
camCanvas.height = 240;
laneDebugCanvas.width = 240;
laneDebugCanvas.height = 80;

// ---- Pose / phase ----
let poseLandmarker = null;
let running = false;
let lastFrameTime = performance.now();
let baseline = null;

const THRESHOLDS = {
  jumpDelta: 0.05,
  crouchDelta: 0.05,
};
const DODGE_ZONE = 0.09;
const LANE_GLIDE_SPEED = 6;

let phase = "idle";
let countdownRemaining = 0;
const COUNTDOWN_MS = 5000;

// ---- Character state (still tracked, just not drawn) ----
const character = {
  lane: 1,
  visualLane: 1,
  isJumping: false,
  jumpT: 0,
  isCrouching: false,
};

let prevRawState = { jump: false, crouch: false, left: false, right: false };
let lastLandmarks = null;

// ---- Perspective geometry (one-point perspective, Subway Surfers style) ----
// The camera is behind and slightly above the character, looking forward.
// All parallel lines (tracks, lane edges) converge to a single vanishing point.
const VANISH_X = WIDTH / 2; // vanishing point x: dead center
const VANISH_Y = HEIGHT * 0.28; // vanishing point y: about 1/3 from top
const NEAR_HALF_WIDTH = 280; // half-width of the 3-lane block at the very bottom (near camera)
const NEAR_Y = HEIGHT + 40; // the "near plane" sits slightly below the canvas bottom

// depth: 0 = at camera (bottom of screen), 1 = at vanishing point (horizon).
// Returns screen Y for a given depth.
function depthToY(depth) {
  return NEAR_Y + (VANISH_Y - NEAR_Y) * depth;
}

// Returns the screen X of a lane edge at a given depth.
// edgeIndex 0..3 (4 edges for 3 lanes).
function laneEdgeX(edgeIndex, depth) {
  const y = typeof depth === "number" && depth <= 1.5 ? depth : screenYToDepth(depth);
  const spread = NEAR_HALF_WIDTH * (1 - y); // narrows to 0 at vanishing point
  const left = VANISH_X - spread;
  const right = VANISH_X + spread;
  return left + (edgeIndex / 3) * (right - left);
}

// Overloaded helper: when the scene code passes a screenY, convert it.
function screenYToDepth(screenY) {
  return (screenY - NEAR_Y) / (VANISH_Y - NEAR_Y);
}

// Lane edge X from a raw depth value (0..1).
function laneEdgeAtDepth(edgeIndex, depth) {
  const spread = NEAR_HALF_WIDTH * (1 - depth);
  const left = VANISH_X - spread;
  const right = VANISH_X + spread;
  return left + (edgeIndex / 3) * (right - left);
}

function laneCenterAtDepth(laneIndex, depth) {
  return (laneEdgeAtDepth(laneIndex, depth) + laneEdgeAtDepth(laneIndex + 1, depth)) / 2;
}

// For backward compatibility: laneCenterX takes a screenY.
function laneCenterX(laneIndex, screenY) {
  const d = screenYToDepth(screenY);
  return laneCenterAtDepth(laneIndex, d);
}

function scaleAtDepth(depth) {
  return Math.max(0.05, 1 - depth * 0.85);
}

// ---- Scrolling state ----
let scrollOffset = 0;
const SCROLL_SPEED = 0.35; // depth-units per second (constant for now; will tie to running later)

// Loop system: trees repeat every LOOP_LENGTH depth-units.
const TREE_SPACING = 0.12; // distance between consecutive trees in depth-units
const TREES_PER_SIDE = 10;
const LOOP_LENGTH = TREE_SPACING * TREES_PER_SIDE;

// Sleeper (railroad tie) spacing
const SLEEPER_SPACING = 0.06;
const SLEEPER_COUNT = 18;

// River wave spacing
const WAVE_SPACING = 0.08;
const WAVE_COUNT = 14;

// ---- Tree sprites (generated at startup) ----
const TREE_SPRITE_W = 64;
const TREE_SPRITE_H = 96;
const treeSprites = {}; // keyed by color palette name

function generateTreeSprite(trunkColor, foliageColors) {
  const c = document.createElement("canvas");
  c.width = TREE_SPRITE_W;
  c.height = TREE_SPRITE_H;
  const ctx = c.getContext("2d");

  const w = TREE_SPRITE_W;
  const h = TREE_SPRITE_H;
  const trunkW = w * 0.14;
  const trunkH = h * 0.35;
  const trunkX = w / 2 - trunkW / 2;
  const trunkY = h - trunkH;

  // Trunk (slightly tapered)
  ctx.fillStyle = trunkColor;
  ctx.beginPath();
  ctx.moveTo(trunkX + 1, trunkY + trunkH);
  ctx.lineTo(trunkX - 2, trunkY + trunkH);
  ctx.lineTo(trunkX + 3, trunkY);
  ctx.lineTo(trunkX + trunkW - 3, trunkY);
  ctx.lineTo(trunkX + trunkW + 2, trunkY + trunkH);
  ctx.closePath();
  ctx.fill();

  // Foliage layers (3 overlapping triangles, bottom to top, each slightly smaller)
  const layers = [
    { yBase: h * 0.58, width: w * 0.92, height: h * 0.34 },
    { yBase: h * 0.40, width: w * 0.70, height: h * 0.32 },
    { yBase: h * 0.20, width: w * 0.48, height: h * 0.30 },
  ];
  layers.forEach((layer, i) => {
    ctx.fillStyle = foliageColors[i % foliageColors.length];
    ctx.beginPath();
    ctx.moveTo(w / 2, layer.yBase - layer.height);
    ctx.lineTo(w / 2 - layer.width / 2, layer.yBase);
    ctx.lineTo(w / 2 + layer.width / 2, layer.yBase);
    ctx.closePath();
    ctx.fill();
  });

  return c;
}

function initTreeSprites() {
  treeSprites.green = generateTreeSprite("#5a3a1a", ["#2d7a3a", "#3a9e4a", "#2a6e32"]);
  treeSprites.autumn = generateTreeSprite("#4a2e12", ["#c4652a", "#d4883a", "#b8502a"]);
  treeSprites.pink = generateTreeSprite("#5a3a1a", ["#d45a8a", "#e87aaa", "#c44a78"]);
  treeSprites.dark = generateTreeSprite("#3a2a12", ["#1a4e2a", "#246a34", "#18422a"]);
}

const PALETTE_CYCLE = ["green", "autumn", "pink", "dark"];

function getTreePalette(loopIndex) {
  return PALETTE_CYCLE[loopIndex % PALETTE_CYCLE.length];
}

// ---- Debug log ----
function logDebug(msg) {
  console.log(msg);
  const lines = debugLog.textContent.split("\n").filter((l) => l !== "Waiting for camera start...");
  lines.push(msg);
  while (lines.length > 8) lines.shift();
  debugLog.textContent = lines.join("\n");
  debugLog.scrollTop = debugLog.scrollHeight;
}

// ---- MediaPipe init ----
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

// ---- Start / reset ----
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
    character.lane = 1;
    character.visualLane = 1;
    character.isJumping = false;
    character.jumpT = 0;
    character.isCrouching = false;
    baseline = null;
    scrollOffset = 0;
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

// ---- Main loop ----
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
    if (countdownRemaining <= 0) phase = "calibrating";
  } else if (phase === "calibrating") {
    if (lastLandmarks) {
      captureBaseline(lastLandmarks);
      phase = "playing";
      statusText.textContent = "Running!";
    }
  } else if (phase === "playing") {
    if (lastLandmarks) {
      const rawState = analyzePose(lastLandmarks);
      updateCharacterState(rawState, delta);
    }
    // Scroll the world forward
    scrollOffset += SCROLL_SPEED * (delta / 1000);
  }

  drawCameraPreview();
  advanceJumpAnimation(delta);
  advanceLaneGlide(delta);
  renderScene();

  requestAnimationFrame(loop);
}

// ---- Calibration ----
function captureBaseline(landmarks) {
  const LEFT_SHOULDER = landmarks[11];
  const RIGHT_SHOULDER = landmarks[12];
  const LEFT_HIP = landmarks[23];
  const RIGHT_HIP = landmarks[24];

  const hipY = (LEFT_HIP.y + RIGHT_HIP.y) / 2;
  const shoulderMidX = (LEFT_SHOULDER.x + RIGHT_SHOULDER.x) / 2;
  const mirroredNormX = 1 - shoulderMidX;

  baseline = { hipY, shoulderMidX, mirroredNormX };
  logDebug(`[calibrated] mirroredNormX=${mirroredNormX.toFixed(3)} hipY=${hipY.toFixed(3)}`);
}

// ---- Pose analysis ----
function analyzePose(landmarks) {
  const LEFT_SHOULDER = landmarks[11];
  const RIGHT_SHOULDER = landmarks[12];
  const LEFT_HIP = landmarks[23];
  const RIGHT_HIP = landmarks[24];

  const hipY = (LEFT_HIP.y + RIGHT_HIP.y) / 2;
  const shoulderMidX = (LEFT_SHOULDER.x + RIGHT_SHOULDER.x) / 2;
  const hipDelta = baseline.hipY - hipY;
  const mirroredNormX = 1 - shoulderMidX;
  const offset = mirroredNormX - baseline.mirroredNormX;

  let column;
  if (offset < -DODGE_ZONE) column = 0;
  else if (offset > DODGE_ZONE) column = 2;
  else column = 1;

  const state = { jump: hipDelta > THRESHOLDS.jumpDelta, crouch: hipDelta < -THRESHOLDS.crouchDelta, column, hipDelta, rawShoulderMidX: shoulderMidX, mirroredNormX, offset };
  updateRawDisplay(state);
  return state;
}

function updateRawDisplay(state) {
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
  boxes.jump.classList.toggle("active", state.jump);
  boxes.crouch.classList.toggle("active", state.crouch);
  boxes.left.classList.toggle("active", state.column === 0);
  boxes.right.classList.toggle("active", state.column === 2);
  values.jump.textContent = state.hipDelta.toFixed(2);
  values.crouch.textContent = state.hipDelta.toFixed(2);
  values.left.textContent = state.offset.toFixed(2);
  values.right.textContent = state.offset.toFixed(2);
}

// ---- Character state ----
function updateCharacterState(rawState, delta) {
  if (rawState.column !== character.lane) {
    logDebug(`[lane] ${character.lane} -> ${rawState.column}`);
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

function advanceLaneGlide(delta) {
  const maxStep = LANE_GLIDE_SPEED * (delta / 1000);
  const diff = character.lane - character.visualLane;
  if (Math.abs(diff) <= maxStep) character.visualLane = character.lane;
  else character.visualLane += Math.sign(diff) * maxStep;
}

// ---- Camera preview ----
function drawCameraPreview() {
  camCtx.save();
  camCtx.translate(camCanvas.width, 0);
  camCtx.scale(-1, 1);
  camCtx.drawImage(video, 0, 0, camCanvas.width, camCanvas.height);
  if (lastLandmarks) drawSkeletonOnPreview(lastLandmarks);
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
  const w = laneDebugCanvas.width;
  const h = laneDebugCanvas.height;
  const colW = w / 3; // all three columns are equal width
  laneDebugCtx.clearRect(0, 0, w, h);

  // Three equal-width columns
  laneDebugCtx.fillStyle = "rgba(212,69,58,0.25)";
  laneDebugCtx.fillRect(0, 0, colW, h);
  laneDebugCtx.fillStyle = "rgba(255,255,255,0.08)";
  laneDebugCtx.fillRect(colW, 0, colW, h);
  laneDebugCtx.fillStyle = "rgba(58,124,197,0.25)";
  laneDebugCtx.fillRect(colW * 2, 0, colW, h);

  // Outline the column matching the character's current lane
  laneDebugCtx.strokeStyle = "#4ade80";
  laneDebugCtx.lineWidth = 2;
  laneDebugCtx.strokeRect(character.lane * colW + 1, 1, colW - 2, h - 2);

  // Divider lines
  laneDebugCtx.strokeStyle = "rgba(255,255,255,0.5)";
  laneDebugCtx.lineWidth = 1.5;
  laneDebugCtx.beginPath();
  laneDebugCtx.moveTo(colW, 0);
  laneDebugCtx.lineTo(colW, h);
  laneDebugCtx.moveTo(colW * 2, 0);
  laneDebugCtx.lineTo(colW * 2, h);
  laneDebugCtx.stroke();

  // Labels
  laneDebugCtx.fillStyle = "rgba(255,255,255,0.7)";
  laneDebugCtx.font = "9px sans-serif";
  laneDebugCtx.textAlign = "center";
  laneDebugCtx.fillText("L", colW * 0.5, 12);
  laneDebugCtx.fillText("C", colW * 1.5, 12);
  laneDebugCtx.fillText("R", colW * 2.5, 12);
  laneDebugCtx.textAlign = "left";

  // Red dot: maps the player's offset into the 3-column space, clamped to edges
  if (lastLandmarks && baseline) {
    const rawMidX = (lastLandmarks[11].x + lastLandmarks[12].x) / 2;
    const mirroredNormX = 1 - rawMidX;
    const offset = mirroredNormX - baseline.mirroredNormX;
    // Map offset to canvas x: center of canvas = offset 0, ±DODGE_ZONE maps to column edges
    // Then allow going beyond but clamp to [dotRadius, w - dotRadius]
    const dotRadius = 8;
    const centerPx = w / 2;
    // colW/2 is the distance from canvas center to the column boundary.
    // We want offset = ±DODGE_ZONE to land exactly on that boundary.
    const pxPerUnit = (colW / 2) / DODGE_ZONE;
    const rawDotX = centerPx + offset * pxPerUnit;
    const dotX = Math.max(dotRadius, Math.min(w - dotRadius, rawDotX));
    const dotY = h / 2 + 10;

    laneDebugCtx.fillStyle = "#ff0000";
    laneDebugCtx.strokeStyle = "#ffffff";
    laneDebugCtx.lineWidth = 2;
    laneDebugCtx.beginPath();
    laneDebugCtx.arc(dotX, dotY, dotRadius, 0, Math.PI * 2);
    laneDebugCtx.fill();
    laneDebugCtx.stroke();
  }
}

// ===========================================================================
//  SCROLLING SCENE RENDERER
// ===========================================================================
//
// Everything below draws the world as if the camera is running forward along
// the tracks. Objects are placed at depth-positions along an infinite track
// and scroll toward the camera. The track loops; every other loop the tree
// palette changes.
//
// depthToY() applies a power-curve so the ground feels slightly spherical —
// distant objects cluster near the horizon and nearby objects spread out,
// matching the Subway-Surfer POV.

function renderScene() {
  drawSky();
  drawGround();
  drawRiver();
  drawGravel();
  drawSleepers();
  drawRails();
  drawLaneBorders();
  drawTrees();
  drawCharacter();
}

// ---- Character sprite ----
const CHAR_DEPTH = 0.08; // how far "into" the scene the character stands (0 = nearest)

function laneVisualX(laneFloat, depth) {
  const clamped = Math.min(2, Math.max(0, laneFloat));
  const lower = Math.floor(clamped);
  const upper = Math.min(2, lower + 1);
  const t = clamped - lower;
  return laneCenterAtDepth(lower, depth) * (1 - t) + laneCenterAtDepth(upper, depth) * t;
}

function jumpHeight() {
  if (!character.isJumping) return 0;
  return Math.sin(character.jumpT * Math.PI) * 55;
}

function drawCharacter() {
  const depth = CHAR_DEPTH;
  const scale = scaleAtDepth(depth);
  const baseY = depthToY(depth);
  const x = laneVisualX(character.visualLane, depth);
  const jmp = jumpHeight();
  const crouchSquish = character.isCrouching ? 0.55 : 1;

  const bodyH = 42 * scale * crouchSquish;
  const bodyW = 20 * scale;
  const headR = 10 * scale;
  const footY = baseY - jmp * scale;

  // Shadow on ground
  gameCtx.fillStyle = `rgba(0,0,0,${character.isJumping ? 0.12 : 0.25})`;
  gameCtx.beginPath();
  gameCtx.ellipse(x, baseY + 2, 18 * scale, 5 * scale, 0, 0, Math.PI * 2);
  gameCtx.fill();

  // Legs
  const legW = 5 * scale;
  const legH = bodyH * 0.45;
  gameCtx.fillStyle = "#3a5ea8";
  gameCtx.fillRect(x - bodyW * 0.3, footY - legH, legW, legH);
  gameCtx.fillRect(x + bodyW * 0.1, footY - legH, legW, legH);

  // Body / torso
  const torsoBottom = footY - legH;
  const torsoH = bodyH * 0.55;
  gameCtx.fillStyle = "#e04040";
  const torsoR = bodyW / 2;
  gameCtx.beginPath();
  gameCtx.roundRect(x - torsoR, torsoBottom - torsoH, bodyW, torsoH, torsoR * 0.3);
  gameCtx.fill();

  // Arms
  const armW = 4 * scale;
  const armH = torsoH * 0.7;
  gameCtx.fillStyle = "#e04040";
  gameCtx.fillRect(x - torsoR - armW, torsoBottom - torsoH + 4 * scale, armW, armH);
  gameCtx.fillRect(x + torsoR, torsoBottom - torsoH + 4 * scale, armW, armH);

  // Hands
  gameCtx.fillStyle = "#f0c090";
  const handR = 3 * scale;
  gameCtx.beginPath();
  gameCtx.arc(x - torsoR - armW / 2, torsoBottom - torsoH + 4 * scale + armH, handR, 0, Math.PI * 2);
  gameCtx.arc(x + torsoR + armW / 2, torsoBottom - torsoH + 4 * scale + armH, handR, 0, Math.PI * 2);
  gameCtx.fill();

  // Head
  const headY = torsoBottom - torsoH - headR;
  gameCtx.fillStyle = "#f0c090";
  gameCtx.beginPath();
  gameCtx.arc(x, headY, headR, 0, Math.PI * 2);
  gameCtx.fill();

  // Hair
  gameCtx.fillStyle = "#4a3020";
  gameCtx.beginPath();
  gameCtx.arc(x, headY - headR * 0.15, headR, Math.PI, Math.PI * 2);
  gameCtx.fill();

  // Eyes
  const eyeR = 1.5 * scale;
  gameCtx.fillStyle = "#222";
  gameCtx.beginPath();
  gameCtx.arc(x - 3 * scale, headY - 1 * scale, eyeR, 0, Math.PI * 2);
  gameCtx.arc(x + 3 * scale, headY - 1 * scale, eyeR, 0, Math.PI * 2);
  gameCtx.fill();
}

// ---- Sky ----
function drawSky() {
  const grad = gameCtx.createLinearGradient(0, 0, 0, VANISH_Y + 20);
  grad.addColorStop(0, "#4a90d9");
  grad.addColorStop(1, "#a8d8f0");
  gameCtx.fillStyle = grad;
  gameCtx.fillRect(0, 0, WIDTH, VANISH_Y + 20);
}

// ---- Ground ----
function drawGround() {
  // Dirt/grass on left
  gameCtx.fillStyle = "#5a7a3c";
  gameCtx.beginPath();
  gameCtx.moveTo(0, VANISH_Y);
  gameCtx.lineTo(laneEdgeAtDepth(0, 1), depthToY(1));
  gameCtx.lineTo(laneEdgeAtDepth(0, 0), depthToY(0));
  gameCtx.lineTo(0, HEIGHT);
  gameCtx.closePath();
  gameCtx.fill();

  // Dirt/grass on right
  gameCtx.fillStyle = "#5a7a3c";
  gameCtx.beginPath();
  gameCtx.moveTo(WIDTH, VANISH_Y);
  gameCtx.lineTo(laneEdgeAtDepth(3, 1), depthToY(1));
  gameCtx.lineTo(laneEdgeAtDepth(3, 0), depthToY(0));
  gameCtx.lineTo(WIDTH, HEIGHT);
  gameCtx.closePath();
  gameCtx.fill();

  // Plain dirt track bed — uniform color, no texture
  gameCtx.fillStyle = "#7a6e5a";
  gameCtx.beginPath();
  gameCtx.moveTo(laneEdgeAtDepth(0, 0), depthToY(0));
  gameCtx.lineTo(laneEdgeAtDepth(3, 0), depthToY(0));
  gameCtx.lineTo(laneEdgeAtDepth(3, 1), depthToY(1));
  gameCtx.lineTo(laneEdgeAtDepth(0, 1), depthToY(1));
  gameCtx.closePath();
  gameCtx.fill();
}

// ---- River (left side, perspective-correct, scrolling waves) ----
function drawRiver() {
  const RIVER_NEAR_W = 80;
  const RIVER_FAR_W = 6;
  const gap = 8; // gap between river and track edge

  gameCtx.fillStyle = "#3a7ca5";
  gameCtx.beginPath();
  const nearLeft0 = laneEdgeAtDepth(0, 0) - gap;
  const farLeft0 = laneEdgeAtDepth(0, 1) - gap * 0.05;
  gameCtx.moveTo(nearLeft0, depthToY(0));
  gameCtx.lineTo(nearLeft0 - RIVER_NEAR_W, depthToY(0));
  gameCtx.lineTo(farLeft0 - RIVER_FAR_W, depthToY(1));
  gameCtx.lineTo(farLeft0, depthToY(1));
  gameCtx.closePath();
  gameCtx.fill();

  // Scrolling wave highlights
  gameCtx.strokeStyle = "rgba(255,255,255,0.3)";
  gameCtx.lineWidth = 1;
  for (let i = 0; i < WAVE_COUNT; i++) {
    const rawD = (i * WAVE_SPACING - (scrollOffset % WAVE_SPACING) + WAVE_SPACING) % (WAVE_COUNT * WAVE_SPACING);
    const depth = rawD / (WAVE_COUNT * WAVE_SPACING);
    if (depth < 0.01 || depth > 0.99) continue;
    const y = depthToY(depth);
    const scale = scaleAtDepth(depth);
    const edgeX = laneEdgeAtDepth(0, depth) - gap * (1 - depth);
    const rw = RIVER_NEAR_W * (1 - depth) + RIVER_FAR_W * depth;
    gameCtx.beginPath();
    gameCtx.moveTo(edgeX - rw + 4, y);
    gameCtx.quadraticCurveTo(edgeX - rw / 2, y - 2 * scale, edgeX - 4, y);
    gameCtx.stroke();
  }
}

// ---- Sleepers (wooden blocks between each lane's rail pair only) ----
const RAIL_OFFSET = 45; // shared constant — distance from lane center to rail
function drawSleepers() {
  for (let i = 0; i < SLEEPER_COUNT; i++) {
    const rawD = (i * SLEEPER_SPACING - (scrollOffset % SLEEPER_SPACING) + SLEEPER_SPACING) % (SLEEPER_COUNT * SLEEPER_SPACING);
    const depth = rawD / (SLEEPER_COUNT * SLEEPER_SPACING);
    if (depth < 0.005) continue;
    const y = depthToY(depth);
    if (y > HEIGHT + 20) continue;

    const scale = scaleAtDepth(depth);
    const h = Math.max(1.5, 7 * scale);

    // Draw a separate sleeper for each lane (between that lane's two rails)
    for (let lane = 0; lane < 3; lane++) {
      const cx = laneCenterAtDepth(lane, depth);
      const railL = cx - RAIL_OFFSET * scale;
      const railR = cx + RAIL_OFFSET * scale;
      gameCtx.fillStyle = "#8a6a3a";
      gameCtx.fillRect(railL, y - h / 2, railR - railL, h);
    }
  }
}

// ---- Gravel between lanes (fills the gaps between adjacent rail pairs) ----
const GRAVEL_ROCKS_PER_GAP = 60;
const gravelRocks = [];
for (let gap = 0; gap < 2; gap++) { // 2 gaps: between lane 0-1 and lane 1-2
  for (let i = 0; i < GRAVEL_ROCKS_PER_GAP; i++) {
    gravelRocks.push({
      gap,
      posInGap: Math.random(), // 0-1 across the gap width
      depthOffset: Math.random(),
      size: 1 + Math.random() * 2,
      shade: Math.floor(80 + Math.random() * 50),
    });
  }
}
// Also add gravel outside the outer rails (between outer rail and lane edge)
const GRAVEL_OUTER = 40;
for (let side = 0; side < 2; side++) { // 0 = left of lane 0, 1 = right of lane 2
  for (let i = 0; i < GRAVEL_OUTER; i++) {
    gravelRocks.push({
      gap: side === 0 ? -1 : 3, // special marker
      posInGap: Math.random(),
      depthOffset: Math.random(),
      size: 1 + Math.random() * 2,
      shade: Math.floor(80 + Math.random() * 50),
    });
  }
}

function drawGravel() {
  for (const rock of gravelRocks) {
    const rawD = (rock.depthOffset - (scrollOffset % 1) + 1) % 1;
    const depth = rawD;
    if (depth > 0.98 || depth < 0.02) continue;
    const y = depthToY(depth);
    if (y > HEIGHT + 5) continue;
    const scale = scaleAtDepth(depth);
    const r = rock.size * scale;
    if (r < 0.4) continue;

    let x;
    if (rock.gap === -1) {
      // Left outer: between lane edge and left rail of lane 0
      const edgeL = laneEdgeAtDepth(0, depth);
      const railL = laneCenterAtDepth(0, depth) - RAIL_OFFSET * scale;
      x = edgeL + rock.posInGap * (railL - edgeL);
    } else if (rock.gap === 3) {
      // Right outer: between right rail of lane 2 and lane edge
      const railR = laneCenterAtDepth(2, depth) + RAIL_OFFSET * scale;
      const edgeR = laneEdgeAtDepth(3, depth);
      x = railR + rock.posInGap * (edgeR - railR);
    } else {
      // Inner gap: between right rail of lane N and left rail of lane N+1
      const railR = laneCenterAtDepth(rock.gap, depth) + RAIL_OFFSET * scale;
      const railL = laneCenterAtDepth(rock.gap + 1, depth) - RAIL_OFFSET * scale;
      x = railR + rock.posInGap * (railL - railR);
    }

    const g = rock.shade;
    gameCtx.fillStyle = `rgb(${g},${g - 8},${g - 16})`;
    gameCtx.beginPath();
    gameCtx.arc(x, y, r / 2, 0, Math.PI * 2);
    gameCtx.fill();
  }
}

// ---- Rails (thin dark lines, like the real game) ----
function drawRails() {
  const steps = 50;
  gameCtx.strokeStyle = "#555560";
  for (let lane = 0; lane < 3; lane++) {
    for (const offsetSign of [-1, 1]) {
      gameCtx.beginPath();
      for (let i = 0; i <= steps; i++) {
        const depth = i / steps;
        const y = depthToY(depth);
        const scale = scaleAtDepth(depth);
        const cx = laneCenterAtDepth(lane, depth);
        const x = cx + RAIL_OFFSET * scale * offsetSign;
        gameCtx.lineWidth = Math.max(1, 3 * scale);
        if (i === 0) gameCtx.moveTo(x, y);
        else gameCtx.lineTo(x, y);
      }
      gameCtx.stroke();
    }
  }
}

// ---- Lane border lines (subtle dark edges between lanes) ----
function drawLaneBorders() {
  gameCtx.strokeStyle = "rgba(0,0,0,0.15)";
  const steps = 40;
  for (let edge = 0; edge <= 3; edge++) {
    gameCtx.beginPath();
    for (let i = 0; i <= steps; i++) {
      const depth = i / steps;
      const y = depthToY(depth);
      const x = laneEdgeAtDepth(edge, depth);
      gameCtx.lineWidth = Math.max(0.5, 2 * scaleAtDepth(depth));
      if (i === 0) gameCtx.moveTo(x, y);
      else gameCtx.lineTo(x, y);
    }
    gameCtx.stroke();
  }
}

// ---- Trees (scroll toward camera, scale with perspective, alternate palette) ----
function drawTrees() {
  for (let i = 0; i < TREES_PER_SIDE; i++) {
    const rawD = (i * TREE_SPACING - (scrollOffset % LOOP_LENGTH) + LOOP_LENGTH) % LOOP_LENGTH;
    const depth = rawD / LOOP_LENGTH;
    if (depth > 0.99) continue; // too close to vanishing point to draw
    const y = depthToY(depth);
    if (y > HEIGHT + TREE_SPRITE_H * 2) continue; // off-screen below, skip

    const scale = scaleAtDepth(depth);
    const loopIndex = Math.floor((scrollOffset + rawD) / LOOP_LENGTH);
    const palette = getTreePalette(loopIndex);
    const sprite = treeSprites[palette];

    const drawW = TREE_SPRITE_W * scale;
    const drawH = TREE_SPRITE_H * scale;

    // Left side: just beyond the left track edge
    const leftEdgeX = laneEdgeAtDepth(0, depth);
    const leftX = leftEdgeX - 16 * scale - drawW;
    gameCtx.drawImage(sprite, leftX, y - drawH, drawW, drawH);

    // Right side: just beyond the right track edge
    const rightEdgeX = laneEdgeAtDepth(3, depth);
    const rightX = rightEdgeX + 16 * scale;
    gameCtx.drawImage(sprite, rightX, y - drawH, drawW, drawH);
  }
}

// ---- Init + event listeners ----
initTreeSprites();

startBtn.addEventListener("click", startCamera);
calibrateBtn.addEventListener("click", () => {
  phase = "countdown";
  countdownRemaining = COUNTDOWN_MS;
  statusText.textContent = "Recalibrating...";
});
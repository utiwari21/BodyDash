# Subway Surfer IRL — movement capture prototype

Real-time pose detection prototype for an in-place motion-controlled runner game.
Uses your webcam and MediaPipe pose detection to identify jump, crouch, and left/right dodge movements.

## Setup

1. Install dependencies:

```
npm install
```

2. Run the dev server:

```
npm run dev
```

3. Open the printed local URL (usually `http://localhost:5173`) in your browser.
4. Click "Start camera" and allow camera permission.
5. Stand back so your full upper body and hips are visible, and stand still for a moment to calibrate.

## How it works

- `@mediapipe/tasks-vision` runs a pose-landmark model in the browser (WebAssembly, no server needed).
- On start, the app captures a **baseline** pose (your neutral standing position).
- Every frame after that, it compares your hip height and shoulder midpoint x-position against the baseline:
  - Hips rise significantly -> **jump**
  - Hips drop significantly -> **crouch**
  - Shoulder midpoint shifts left/right -> **dodge**
- Thresholds live in `THRESHOLDS` at the top of `src/main.js` — tune these based on your camera distance and testing.

## Why camera didn't work in the chat preview

Claude's inline widget preview renders inside a sandboxed iframe that blocks camera access for security reasons.
Locally, `getUserMedia` works normally on `localhost` (browsers treat localhost as a secure context even over http).

## Project structure

```
subway-surfer-irl/
├── index.html          # Page markup, canvas + UI
├── src/
│   ├── main.js          # Camera capture, pose detection, movement logic
│   └── style.css        # Styling
├── package.json
└── README.md
```

## Notes on the model

Currently using `pose_landmarker_lite` for speed. If detection feels inaccurate, you can swap to
`pose_landmarker_full` or `pose_landmarker_heavy` in `main.js` (slower but more accurate):

```
https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task
https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task
```

## Architecture: character state, not raw pose

Gameplay logic never reads pose landmarks directly. The flow is:

```
Camera → pose landmarks → analyzePose() → raw movement signal
       → updateCharacterState() → character { lane, isJumping, isCrouching }
       → renderGame() draws the scene using only `character`
```

This matters because it means obstacles, scoring, and collisions (built next) only need to
compare against `character.lane`, `character.isJumping`, `character.isCrouching` — never
against camera coordinates. It also makes the game logic testable without a camera at all
(you could feed `updateCharacterState()` fake input in a unit test).

- `character.lane`: 0 (left), 1 (center), 2 (right). Switches on the rising edge of a
  left/right dodge signal, with a 350ms cooldown to prevent flicker from noisy detection.
- `character.isJumping` / `jumpT`: jump plays out a fixed ~500ms arc once triggered,
  regardless of how long you hold the pose.
- `character.isCrouching`: a held state, active while the crouch signal is true.

The small camera preview (bottom-right corner) is for calibration only — it shows the raw
feed with skeleton overlay so you can see what the model sees, but no gameplay code reads
from it.

## Next steps (not yet built)

- Obstacle spawning and scrolling logic, checked against `character.lane` / `isJumping` / `isCrouching`
- Collision detection
- Scoring system
- WebSocket-based multiplayer sync
- Difficulty scaling over time
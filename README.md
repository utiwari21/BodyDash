# BodyDash

A runner game you play with your whole body. Step left or right, jump, and crouch in front of your webcam to steer your runner down the tracks. No controller, headset, or download needed.

**Play it:** https://d1p30moihm4q7m.cloudfront.net

<!-- Add a short gameplay GIF here: ![BodyDash gameplay](docs/gameplay.gif) -->

## How to play

1. Open the link on a laptop or desktop with a webcam, in Chrome, Edge, Firefox, or Safari.
2. Click **Start camera** and allow camera access.
3. Stand back until your whole body is in frame. Hold still during the 5-second countdown while BodyDash calibrates to where you're standing.
4. Move your body to move your runner:

| You do this | Your runner does this |
|---|---|
| Step left or right | Switches tracks |
| Jump | Jumps |
| Crouch | Ducks |

If you change where you're standing, click **Recalibrate**. To see what the tracker is detecting, open **Show tracking details** below the game.

**Privacy:** your camera feed is processed on your device by an in-browser pose model. No video is ever uploaded.

## Status

BodyDash is in active development. Working today:

- Real-time full-body tracking from a standard webcam
- Three-lane movement that follows your position, with smooth transitions between tracks
- Jump and crouch detection
- A scrolling 3D-perspective scene with rails, wooden sleepers, gravel, a river, and trees that change color each loop

Next up are running-in-place detection to control speed, obstacles and scoring, and the features in the [roadmap](#roadmap).

## How it works

**Pose detection.** Google's MediaPipe PoseLandmarker runs in the browser through WebAssembly with GPU acceleration, tracking 33 body landmarks per frame. BodyDash uses the shoulders and hips.

**Calibration.** A 5-second countdown gives you time to get in position. Then BodyDash records your neutral stance as the baseline, and every movement is measured relative to it.

**Movement classification.**

- *Lanes:* the shoulder midpoint's horizontal offset from your baseline is compared against a dodge zone. Past it to the left or right puts you on that track; inside it keeps you centered. Camera coordinates are mirrored, so stepping to your right moves the runner right.
- *Jump:* hips rising above the baseline trigger a fixed jump arc once, no matter how long you stay up.
- *Crouch:* hips dropping below the baseline hold a crouch for as long as you stay down.

**Game state is separate from raw tracking.** `analyzePose()` turns landmarks into a movement signal, and `updateCharacterState()` turns that signal into a character object (`lane`, `isJumping`, `isCrouching`). Rendering, and the obstacle and scoring systems to come, read only the character object, never camera data. So game logic can be tested without a camera.

**Rendering.** The scene is drawn on an HTML5 canvas with one-point perspective, so every track, rail, and tree converges on a single vanishing point. Tree sprites are generated in code at startup, in four color palettes that cycle as the world loops. The runner glides between lanes rather than snapping, passing through the center track on the way.

## Tech stack

| Layer | Technology |
|---|---|
| Build | Vite 5 |
| Language | JavaScript (ES modules), no framework |
| Pose detection | MediaPipe Tasks Vision (PoseLandmarker, WebAssembly + GPU) |
| Rendering | HTML5 Canvas 2D |
| Hosting | AWS S3 (private bucket) behind CloudFront CDN with Origin Access Control, served over HTTPS |
| Deploys | Node script using the AWS CLI with short-lived `aws login` credentials |

## Run it locally

You need Node.js 18 or newer and a webcam.

```bash
git clone https://github.com/utiwari21/REAL_SUBWAY_SURFER.git
cd REAL_SUBWAY_SURFER
npm install
npm run dev
```

Open the URL Vite prints, usually http://localhost:5173. Browsers allow camera access on `localhost`, but on any other address the site must be served over HTTPS.

## Deploy

```bash
npm run deploy
```

This builds the site, uploads it to S3, and refreshes the CloudFront cache. First-time setup, verification, and troubleshooting are in [DEPLOY.md](DEPLOY.md).

## Tuning

The detection and feel settings are constants near the top of `src/main.js`:

| Constant | Controls |
|---|---|
| `THRESHOLDS.jumpDelta`, `THRESHOLDS.crouchDelta` | How far your hips must move to count as a jump or crouch |
| `DODGE_ZONE` | How far you must step sideways to change tracks |
| `LANE_GLIDE_SPEED` | How quickly the runner slides between tracks |
| `SCROLL_SPEED` | How fast the world moves toward you |

## Project structure

```
├── index.html          Page layout
├── src/
│   ├── main.js         Camera, pose detection, movement logic, and scene rendering
│   └── style.css       Page styles
├── scripts/
│   └── deploy.mjs      One-command AWS deploy
├── DEPLOY.md           Deployment guide
└── package.json
```

## Roadmap

- Running-in-place detection, so your pace controls the runner's speed
- Obstacles to jump over, duck under, and dodge around, with collision detection
- Scoring with streak bonuses
- Adaptive difficulty that adjusts speed and obstacle frequency to your recent performance
- An encouraging voice commentator that reacts to streaks, misses, and personal bests
- Multiplayer races and worldwide leaderboards
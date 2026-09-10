# AR / WebXR: entering the model, calibrating it to the room, moving in it

How the client enters an immersive session, how the model is served to a Meta Quest,
how you grab things and move the whole model onto a real workcell, and how procedures
are run without a keyboard.

Companion to [README.md](README.md) (the client as a whole) and
[ROBOTICS.md](ROBOTICS.md) (URDF robots and BPMN execution — the reason laying the
model over a real cell matters).

Almost everything here lives in two engine modules:
`engine/ar-initiator.ts` (session, input, world-origin calibration) and
`engine/ar-procedure-menu.ts` (the in-headset procedure list). The entry button is
`views/three-canvas/XrButton.tsx`.

## Contents

- [Entering a session](#entering-a-session)
- [Serving it to a Meta Quest](#serving-it-to-a-meta-quest)
- [Controls](#controls)
- [World-origin calibration](#world-origin-calibration)
- [The 3D procedure menu](#the-3d-procedure-menu)
- [Relation lines and ports follow in AR](#relation-lines-and-ports-follow-in-ar)
- [AR ↔ robotics](#ar--robotics)
- [Limits worth knowing](#limits-worth-knowing)

## Entering a session

`XrButton.tsx` waits for `engine.whenReady()`, then appends the element from
`engine.createXRButton()` — three's `XRButton` bound to our one renderer, requested
with `requiredFeatures: ["local"]` and `optionalFeatures: ["hand-tracking"]`.

On `sessionstart`, `ArInitiator.onSessionStarted()`:

1. swaps the active camera to `globalObject.ARCamera`;
2. captures the session's **native reference space** (`baseReferenceSpace`) and
   reapplies any persisted world-origin offset;
3. draws the world-origin axis marker (`worldOriginMarker`);
4. builds the two controllers, their grips, the hand models, and a pointer ray per
   controller.

The render loop is `arInitiator.render` (the `setAnimationLoop` callback). While
`renderer.xr.isPresenting` it forces `globalObject.render = true` every frame — the
desktop dirty-flag optimisation (`animator` only draws when `render === true`) would
otherwise freeze the AR view — and runs the per-frame AR work: poll the face button,
update a two-hand canvas grab, update the procedure-menu hover, update the pointer
rays. `onSessionEnded` swaps the camera back and tears all of that down.

## Serving it to a Meta Quest

The Quest browser only exposes "Enter VR" on a **secure context**, and
`http://<lan-ip>` is not one. The client solves this with one HTTPS origin that
reverse-proxies everything else (see also `vite.config.ts`):

- **`VITE_HTTPS_PROXY=true`** — vite serves HTTPS using `../certs/dev-{cert,key}.pem`
  (self-signed, with a `IP:<lan-ip>` SAN) and adds `server.proxy` entries:
  `/api → VITE_PROXY_API_TARGET` and `/sync → VITE_PROXY_SYNC_TARGET` (`ws: true`).
  Same origin ⇒ no CORS, no mixed content.
- **`.env` / `.env.development`**:
  `VITE_API_URL=https://<ip>:<port>/api`, `VITE_SYNC_URL=wss://<ip>:<port>/sync`,
  `VITE_HTTPS_PROXY=true`, plus the two `VITE_PROXY_*_TARGET` upstreams.
- **`mmar-server`'s `CORS_ORIGINS`** must list the LAN origin
  (`https://<ip>:<port>`).
- **On the Quest**: open `https://<ip>:<port>` and accept the certificate warning
  once. If "Enter VR" still reports unsupported *after* accepting the cert, the
  headset's Chromium is refusing powerful features on a cert-error page — install the
  CA on the headset, or serve from a real domain / tunnel.

## Controls

Input is wired on three's two `getController(i)` objects. `select*` fires for **both**
a physical controller's trigger and a tracked hand's pinch; `squeeze*` and the gamepad
face buttons are physical controllers only.

| Input | Tracked hands | Controllers | What it does |
| --- | --- | --- | --- |
| on an object | pinch | trigger | grab and move it |
| **both** held | both pinch | both triggers | **canvas grab** — the whole model follows both hands (translate + yaw about their midpoint) until either is released, then stays put |
| grip button | — | squeeze | recenter the world origin to that controller, instantly |
| on empty space, held ~1.2 s | pinch-hold | trigger-hold | recenter the world origin to that controller (the hand fallback for the grip button) |
| A / X face button | — | press | toggle the 3D procedure menu |
| trigger while the menu is open | pinch | trigger | run the procedure row the pointer ray is on |

The face button raises no WebXR events, so it is polled each frame
(`source.gamepad.buttons[4].pressed`, rising edge) — index 4 is A on the right
controller, X on the left; either counts.

Each controller also carries a thin **pointer ray** with a reticle that snaps onto
the nearest grabbable object (white when it hits nothing, yellow on a hit). Tracked
hands get the equivalent from three's `OculusHandPointerModel`.

## World-origin calibration

The model is drawn at fixed scene coordinates whose `(0,0,0)` is wherever the headset
dropped the session's reference-space origin — an arbitrary spot on the floor. To lay
the model over a real workcell (so a Task's canvas position *is* a robot command —
`$$cmdpos`, see ROBOTICS.md) that origin has to be moved onto a real reference point,
usually the robot's base.

`ArInitiator` does this by replacing the WebXR reference space with an offset one
(`baseReferenceSpace.getOffsetReferenceSpace(new XRRigidTransform(pos, quat))`).
Everything in the scene — grid, model, origin marker, controllers, hands — then moves
together as one rigid "canvas", so grabbing and ray hits stay aligned. Only the
**yaw** of the calibration pose is used, so the model always stays level.

| Entry point | Where | Effect |
| --- | --- | --- |
| grip button / hold-trigger-on-empty-space | in session | snap the origin to that controller's pose (position + yaw) |
| two-hand canvas grab | in session | free translate + yaw while both triggers are held; persisted on release |
| `arInitiator.setOrigin(x, y, z, yaw?)` | console / code | explicit metres + radians, relative to the native origin |
| `arInitiator.resetOrigin()` | console / code | back to the native origin |

The offset is stored in `localStorage["mmar.ar.originOffset"]` and reapplied on the
next `sessionstart`, so a calibration survives taking the headset off.

**Two-hand grab, in detail.** Everything is computed in the session's fixed *base*
reference space (the current offset is undone via
`originOffsetMatrix ∘ controller.matrixWorld`), so the maths stays consistent even
though the reference space is being replaced every frame:

```
handStart, originStart = midpoint-of-controllers frame + offset, captured at grab start
delta                  = handNow ∘ handStart⁻¹          (a base-space rigid motion)
originOffsetMatrix      = delta ∘ originStart
```

Because `handNow` and `handStart` share a translation, `delta` is a rotation *about
the hands' midpoint* — the canvas turns under your hands, not about the far-off scene
origin. Yaw only updates while the controllers are ≥ `MIN_TWO_HAND_SEPARATION` (8 cm)
apart, and the yaw baseline re-anchors on the first well-separated frame, so spreading
your hands after grabbing does not snap-rotate the model. On release the matrix is
re-decomposed to a clean yaw-only offset (float drift from the per-frame chain cannot
accumulate pitch / roll).

## The 3D procedure menu

The "Algorithms" dialog is DOM/MUI — the headset does not composite it into the
immersive view — so the A / X button opens a floating 3D list instead
(`engine/ar-procedure-menu.ts`).

- It lists the procedures **assigned to the open scene type**
  (`procedureUtility.getAssignedProcedures()`), one selectable row each, rebuilt from
  the backend every time it opens.
- It is placed once, upright, ~0.6 m in front of the viewer, and world-locked after
  that (it does not chase your head).
- A trigger press while pointing at a row runs `procedureUtility.execute("", name)`,
  then announces `historyRecord` and `checkForVizRepUpdate` on the event bus (engine
  modules must not import `history-service`), and closes the menu.
- Hover is shown by tinting the row under either pointer ray.
- Controller-only — tracked hands raise no face-button event.

## Relation lines and ports follow in AR

The animator's move-detection → relation re-routing block is guarded by
`camera == normalCamera`, so in a session it never runs: a class grabbed with a
controller used to drag its relation lines nowhere and leave its child ports behind.

`animator.updateMovedObjectsInAr()` — called from the `ARCamera` branch of
`animate()`, before the frame is drawn — mirrors just the parts that matter: the
per-object `userData.update()` (ports re-glue to their class) and `setPos` for every
relation line when a draggable has moved since the last frame. Detection compares
**world** positions, not `element.position`: an AR grab reparents the object under the
controller (`controller.attach`), which freezes its local position. Coordinate
write-back to the gds instances is deliberately left to the desktop path (see Limits).

## AR ↔ robotics

Once the world origin is calibrated to the cell, canvas space and robot space are the
same space. A Task placed where the tool should go is then already the command: use
`$$cmdpos` (units converted, nothing re-framed) in the Task's variable table, and the
simulation tab's reach check will agree with the machine — both solve against the
arm's own base. See [ROBOTICS.md → Positions: frames and units](ROBOTICS.md#positions-frames-and-units).

## Limits worth knowing

- **AR edits are not persisted.** Moving / rotating / scaling an instance in a session
  updates the view and re-routes its relations, but the `coordinates-updater`
  write-back to the gds instances is gated to the normal camera — so AR moves do not
  auto-save, do not sync to collaborators, and are lost on reload. The world-origin
  calibration is separate and *is* persisted (localStorage, per browser).
- **Recenter and the procedure menu are controller-only.** Tracked hands can grab and
  can two-hand canvas-grab, but have no grip button and no face button; with hands,
  only the hold-on-empty-space recenter is available.
- **The world-origin offset only exists inside a session.** The desktop 2D/3D preview
  always renders at the native origin.
- **A robot on a different network from the headset needs a bridge.**
  `executionProcedure` sends its command over HTTP/WS *from the headset's browser*. If
  the robot is on a wired LAN the Quest cannot route to — and the page is HTTPS — the
  machine running the dev server has to relay: e.g. add a `/robot` entry to
  `server.proxy` in `vite.config.ts` (mirroring `/api` and `/sync`) pointing at the
  robot, and have the procedure call a relative `/robot/...` path. Not wired up in
  this repo.
- **The origin marker's axis labels need a CDN font.** `createWorldOriginMarker`
  fetches the helvetiker typeface from jsDelivr; offline, the axis cross still draws
  but the `+X` / `+Y` / `+Z` labels do not.

const FPS = 60;
const FIRST_FRAME = 35;
const LAST_FRAME = 260;
const MOBILE_FRAME_PATH = "bday-clip-v2-frames";
const DESKTOP_FRAME_PATH = "bday-clip-v2-frames-large";
const DESKTOP_MEDIA_QUERY = "(min-width: 760px) and (min-height: 720px)";
const USE_DESKTOP_FRAMES = window.matchMedia(DESKTOP_MEDIA_QUERY).matches;
const FRAME_PATH = USE_DESKTOP_FRAMES
  ? DESKTOP_FRAME_PATH
  : MOBILE_FRAME_PATH;

if (USE_DESKTOP_FRAMES) {
  document.body.classList.add("is-desktop-view");
}

const ANCHOR = {
  A: 35,
  B: 109,
  C: 202,
  D: 260,
};

const THRESHOLD = {
  forwardCommit: 162,
  backwardCommit: 138,
};

const SCRUB_SMOOTHING = 0.24;
const SCRUB_DISTANCE_RATIO = 0.82;

const scrubber = document.querySelector("#scrubber");
const frameEl = document.querySelector("#frame");

const state = {
  restingSide: "A",
  mode: "loading",
  frame: ANCHOR.A,
  autoPhase: "",
  dragPointerId: null,
  isPointerDown: false,
  entryStartX: 0,
  pointerX: 0,
  scrubStartX: 0,
  scrubStartProgress: 0,
  targetProgress: 0,
  actualProgress: 0,
  scrubRaf: 0,
  playToken: 0,
};

function frameSrc(frame) {
  return `${FRAME_PATH}/frame_${String(frame).padStart(4, "0")}.jpg`;
}

function loadFrame(frame) {
  return new Promise((resolve) => {
    const image = new Image();

    image.onload = async () => {
      if (image.decode) {
        try {
          await image.decode();
        } catch {
          // The image is already loaded; decode can fail on some Safari versions.
        }
      }

      resolve();
    };

    image.onerror = resolve;
    image.src = frameSrc(frame);
  });
}

function preloadFrames() {
  const loads = [];

  for (let i = FIRST_FRAME; i <= LAST_FRAME; i += 1) {
    loads.push(loadFrame(i));
  }

  return Promise.all(loads);
}

function showFrame(frame, force = false) {
  const nextFrame = Math.round(Math.min(LAST_FRAME, Math.max(FIRST_FRAME, frame)));
  if (!force && nextFrame === state.frame) return;
  state.frame = nextFrame;
  frameEl.src = frameSrc(nextFrame);
}

function progressToFrame(progress) {
  return ANCHOR.B + progress * (ANCHOR.C - ANCHOR.B);
}

function frameToProgress(frame) {
  return clamp((frame - ANCHOR.B) / (ANCHOR.C - ANCHOR.B), 0, 1);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function stopScrubLoop() {
  if (state.scrubRaf) cancelAnimationFrame(state.scrubRaf);
  state.scrubRaf = 0;
}

function playSegment(from, to, autoPhase = "") {
  state.mode = "auto";
  state.autoPhase = autoPhase;
  state.playToken += 1;

  const token = state.playToken;
  const startFrame = Math.round(from);
  const endFrame = Math.round(to);
  const distance = Math.abs(endFrame - startFrame);
  const duration = distance / FPS * 1000;
  const direction = Math.sign(endFrame - startFrame) || 1;
  const startedAt = performance.now();

  showFrame(startFrame);

  return new Promise((resolve) => {
    function tick(now) {
      if (token !== state.playToken) return resolve(false);

      if (duration === 0) {
        showFrame(endFrame);
        return resolve(true);
      }

      const elapsed = now - startedAt;
      const progress = clamp(elapsed / duration, 0, 1);
      const nextFrame = startFrame + direction * Math.round(distance * progress);
      showFrame(nextFrame);

      if (progress < 1) {
        requestAnimationFrame(tick);
      } else {
        showFrame(endFrame);
        resolve(true);
      }
    }

    requestAnimationFrame(tick);
  });
}

function getScrubDistance() {
  return Math.max(160, scrubber.clientWidth * SCRUB_DISTANCE_RATIO);
}

function setTargetFromPointer() {
  const distance = getScrubDistance();

  if (state.restingSide === "A") {
    const delta = state.pointerX - state.scrubStartX;
    state.targetProgress = clamp(state.scrubStartProgress + delta / distance, 0, 1);
    return;
  }

  const delta = state.pointerX - state.scrubStartX;
  state.targetProgress = clamp(state.scrubStartProgress + delta / distance, 0, 1);
}

function scrubTick() {
  if (state.mode !== "scrubbing") return;

  setTargetFromPointer();
  state.actualProgress += (state.targetProgress - state.actualProgress) * SCRUB_SMOOTHING;
  showFrame(progressToFrame(state.actualProgress));
  state.scrubRaf = requestAnimationFrame(scrubTick);
}

function beginScrub() {
  const currentProgress = frameToProgress(state.frame);

  state.mode = "scrubbing";
  state.scrubStartX = state.entryStartX;
  state.scrubStartProgress = currentProgress;
  state.targetProgress = state.scrubStartProgress;
  state.actualProgress = state.scrubStartProgress;
  stopScrubLoop();
  scrubTick();
}

async function beginInteraction(clientX, pointerId) {
  if (state.mode !== "resting") return false;

  state.dragPointerId = pointerId;
  state.isPointerDown = true;
  state.entryStartX = clientX;
  state.pointerX = clientX;
  state.playToken += 1;

  if (state.restingSide === "A") {
    await playSegment(ANCHOR.A, ANCHOR.B, "enterToB");
  } else {
    await playSegment(ANCHOR.D, ANCHOR.C, "enterToC");
  }

  if (!state.isPointerDown) {
    await cancelToRest();
    return true;
  }

  beginScrub();
  return true;
}

async function reverseTailToGrab(clientX, pointerId) {
  const interruptedPhase = state.autoPhase;
  const grabFrame = interruptedPhase === "returnToA" ? ANCHOR.B : ANCHOR.C;

  state.playToken += 1;
  state.dragPointerId = pointerId;
  state.isPointerDown = true;
  state.entryStartX = clientX;
  state.pointerX = clientX;

  const completed = await playSegment(state.frame, grabFrame, "reverseToGrab");
  if (!completed) return true;

  showFrame(grabFrame);

  if (state.isPointerDown) {
    beginScrub();
  } else {
    state.mode = "grabbed";
    state.autoPhase = "";
  }

  return true;
}

async function completeToRest(nextRestingSide) {
  stopScrubLoop();
  state.playToken += 1;

  if (nextRestingSide === "D") {
    if (!await playSegment(state.frame, ANCHOR.C, "snapToC")) return;
    if (!await playSegment(ANCHOR.C, ANCHOR.D, "releaseToD")) return;
    state.restingSide = "D";
    state.mode = "resting";
    state.autoPhase = "";
    showFrame(ANCHOR.D);
    return;
  }

  if (!await playSegment(state.frame, ANCHOR.B, "snapToB")) return;
  if (!await playSegment(ANCHOR.B, ANCHOR.A, "returnToA")) return;
  state.restingSide = "A";
  state.mode = "resting";
  state.autoPhase = "";
  showFrame(ANCHOR.A);
}

function releaseScrub() {
  const releasedFrame = state.frame;

  if (state.restingSide === "A") {
    completeToRest(releasedFrame >= THRESHOLD.forwardCommit ? "D" : "A");
    return;
  }

  completeToRest(releasedFrame <= THRESHOLD.backwardCommit ? "A" : "D");
}

function cancelToRest() {
  return completeToRest(state.restingSide);
}

function endPointer(pointerId) {
  if (pointerId !== state.dragPointerId) return;

  state.isPointerDown = false;
  state.dragPointerId = null;

  if (state.mode === "scrubbing") {
    releaseScrub();
  }
}

scrubber.addEventListener("pointerdown", (event) => {
  if (
    state.mode !== "resting" &&
    state.mode !== "grabbed" &&
    state.autoPhase !== "returnToA" &&
    state.autoPhase !== "releaseToD"
  ) {
    return;
  }

  scrubber.setPointerCapture(event.pointerId);

  if (state.mode === "grabbed") {
    state.dragPointerId = event.pointerId;
    state.isPointerDown = true;
    state.entryStartX = event.clientX;
    state.pointerX = event.clientX;
    beginScrub();
    return;
  }

  if (state.autoPhase === "returnToA" || state.autoPhase === "releaseToD") {
    reverseTailToGrab(event.clientX, event.pointerId);
    return;
  }

  beginInteraction(event.clientX, event.pointerId);
});

scrubber.addEventListener("pointermove", (event) => {
  if (event.pointerId !== state.dragPointerId) return;
  state.pointerX = event.clientX;
});

scrubber.addEventListener("pointerup", (event) => {
  endPointer(event.pointerId);
});

scrubber.addEventListener("pointercancel", (event) => {
  endPointer(event.pointerId);
});

scrubber.addEventListener("keydown", (event) => {
  if ((event.key !== "Enter" && event.key !== " ") || state.mode !== "resting") return;

  event.preventDefault();
  const rect = scrubber.getBoundingClientRect();
  const startX = state.restingSide === "A" ? rect.left : rect.right;
  const endX = state.restingSide === "A" ? rect.right : rect.left;

  beginInteraction(startX, "keyboard").then(() => {
    if (state.mode !== "scrubbing") return;
    state.pointerX = endX;
    state.targetProgress = state.restingSide === "A" ? 1 : 0;
    setTimeout(() => endPointer("keyboard"), 250);
  });
});

showFrame(ANCHOR.A, true);

preloadFrames().then(() => {
  state.mode = "resting";
  document.body.classList.add("is-loaded");
});

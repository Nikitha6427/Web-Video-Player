const dropZone = document.getElementById("dropZone");
const videoInput = document.getElementById("videoInput");
const playerShell = document.getElementById("playerShell");
const videoStage = document.getElementById("videoStage");
const video = document.getElementById("video");
const playPauseBtn = document.getElementById("playPauseBtn");
const seekBar = document.getElementById("seekBar");
const seekBuffer = document.getElementById("seekBuffer");
const seekProgress = document.getElementById("seekProgress");
const timeDisplay = document.getElementById("timeDisplay");
const muteBtn = document.getElementById("muteBtn");
const volumeBar = document.getElementById("volumeBar");
const fullscreenBtn = document.getElementById("fullscreenBtn");
const speedSelect = document.getElementById("speedSelect");
const audioWrap = document.getElementById("audioWrap");
const audioSelect = document.getElementById("audioSelect");
const ccBtn = document.getElementById("ccBtn");
const subtitlePanel = document.getElementById("subtitlePanel");
const subtitleInput = document.getElementById("subtitleInput");
const subtitleToggle = document.getElementById("subtitleToggle");
const subtitleSize = document.getElementById("subtitleSize");
const messageBanner = document.getElementById("messageBanner");
const bigPlay = document.getElementById("bigPlay");
const transcodeOverlay = document.getElementById("transcodeOverlay");
const transcodeTitle = document.getElementById("transcodeTitle");
const transcodeStatus = document.getElementById("transcodeStatus");
const transcodeProgressFill = document.getElementById("transcodeProgressFill");

let currentVideoUrl = null;
let currentSubtitleUrl = null;
let hideControlsTimer = null;
let userIsSeeking = false;
let subtitlesEnabled = false;
let loadedTrack = null;

let ffmpegInstance = null;
let ffmpegLoadPromise = null;
let ffmpegProgressBound = false;
let ffmpegLogBound = false;
let isTranscoding = false;
let currentSourceKind = "none";
let pendingFsCleanup = [];
let activeTranscodeFileName = "";
let activeFfmpegLogTap = null;

let audioVariants = [];
let selectedAudioVariantIndex = 0;

function showMessage(text) {
  messageBanner.textContent = text;
  messageBanner.classList.remove("hidden");
}

function showError(html) {
  messageBanner.innerHTML = html;
  messageBanner.classList.remove("hidden");
}

function hideMessage() {
  messageBanner.classList.add("hidden");
  messageBanner.textContent = "";
}

function ensurePlayerVisible() {
  dropZone.classList.add("hidden");
  playerShell.classList.remove("hidden");
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "00:00";
  }

  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const mins = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;

  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }

  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function updateTimeDisplay() {
  timeDisplay.textContent = `${formatTime(video.currentTime)} / ${formatTime(video.duration)}`;
}

function updateSeekVisuals() {
  const duration = video.duration || 0;
  if (duration <= 0) {
    seekProgress.style.width = "0%";
    seekBuffer.style.width = "0%";
    seekBar.value = "0";
    return;
  }

  const progress = (video.currentTime / duration) * 100;
  if (!userIsSeeking) {
    seekBar.value = String(progress);
  }
  seekProgress.style.width = `${progress}%`;

  let bufferedEnd = 0;
  if (video.buffered.length > 0) {
    try {
      bufferedEnd = video.buffered.end(video.buffered.length - 1);
    } catch (_err) {
      bufferedEnd = 0;
    }
  }

  const bufferedPercent = Math.min((bufferedEnd / duration) * 100, 100);
  seekBuffer.style.width = `${bufferedPercent}%`;
}

function syncPlayButtonState() {
  playPauseBtn.classList.toggle("is-playing", !video.paused && !video.ended);
  bigPlay.classList.toggle("hidden", !video.paused && !video.ended);
}

function syncMuteLabel() {
  muteBtn.textContent = video.muted || video.volume === 0 ? "Mute" : "Vol";
}

function setControlsVisible() {
  videoStage.classList.remove("controls-hidden");
  clearTimeout(hideControlsTimer);
  if (video.paused) {
    return;
  }

  hideControlsTimer = window.setTimeout(() => {
    videoStage.classList.add("controls-hidden");
  }, 3000);
}

function hideSubtitlePanel() {
  subtitlePanel.classList.add("hidden");
}

function removeLoadedSubtitle() {
  if (loadedTrack && loadedTrack.parentNode) {
    loadedTrack.parentNode.removeChild(loadedTrack);
  }
  loadedTrack = null;

  if (currentSubtitleUrl) {
    URL.revokeObjectURL(currentSubtitleUrl);
    currentSubtitleUrl = null;
  }

  subtitlesEnabled = false;
  subtitleToggle.textContent = "Off";
  subtitleToggle.setAttribute("aria-pressed", "false");
}

function applySubtitleState() {
  if (!loadedTrack || !loadedTrack.track) {
    subtitlesEnabled = false;
    subtitleToggle.textContent = "Off";
    subtitleToggle.setAttribute("aria-pressed", "false");
    return;
  }

  loadedTrack.track.mode = subtitlesEnabled ? "showing" : "hidden";
  subtitleToggle.textContent = subtitlesEnabled ? "On" : "Off";
  subtitleToggle.setAttribute(
    "aria-pressed",
    subtitlesEnabled ? "true" : "false",
  );
}

function attachSubtitleFromVttText(vttText, label = "Extracted subtitles") {
  removeLoadedSubtitle();

  currentSubtitleUrl = URL.createObjectURL(
    new Blob([vttText], { type: "text/vtt" }),
  );

  const track = document.createElement("track");
  track.kind = "subtitles";
  track.label = label;
  track.srclang = "en";
  track.src = currentSubtitleUrl;
  track.default = true;

  track.addEventListener("load", () => {
    subtitlesEnabled = true;
    applySubtitleState();
  });

  video.appendChild(track);
  loadedTrack = track;
  subtitlesEnabled = true;
  applySubtitleState();
}

function buildVttFromSrt(srtText) {
  const normalized = srtText.replace(/\r+/g, "").replace(/^\uFEFF/, "");
  const blocks = normalized.split(/\n\n+/);
  const lines = ["WEBVTT", ""];

  for (const block of blocks) {
    const rawLines = block.split("\n").map((line) => line.trimEnd());
    if (!rawLines.length) {
      continue;
    }

    let cueLines = rawLines;
    if (/^\d+$/.test(cueLines[0].trim())) {
      cueLines = cueLines.slice(1);
    }

    if (!cueLines[0] || !cueLines[0].includes("-->")) {
      continue;
    }

    cueLines[0] = cueLines[0]
      .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2")
      .replace(/(\d{2}:\d{2}),(\d{3})/g, "00:$1.$2");

    lines.push(...cueLines, "");
  }

  return lines.join("\n");
}

async function loadSubtitleFile(file) {
  const fileName = file.name.toLowerCase();
  const isSrt = fileName.endsWith(".srt");
  const isVtt = fileName.endsWith(".vtt");

  if (!isSrt && !isVtt) {
    showMessage("Subtitle format not supported. Please use .vtt or .srt.");
    return;
  }

  const text = await file.text();
  const content = isSrt ? buildVttFromSrt(text) : text;

  attachSubtitleFromVttText(content, file.name);
  hideMessage();
}

function cleanupAudioVariants() {
  for (const variant of audioVariants) {
    if (variant.url) {
      URL.revokeObjectURL(variant.url);
    }
  }
  audioVariants = [];
  selectedAudioVariantIndex = 0;
  audioSelect.innerHTML = "";
  audioWrap.classList.add("hidden");
}

function currentUrlIsAudioVariant() {
  return audioVariants.some((variant) => variant.url === currentVideoUrl);
}

function cleanupObjectUrls() {
  if (currentVideoUrl && !currentUrlIsAudioVariant()) {
    URL.revokeObjectURL(currentVideoUrl);
  }
  currentVideoUrl = null;

  if (currentSubtitleUrl) {
    URL.revokeObjectURL(currentSubtitleUrl);
    currentSubtitleUrl = null;
  }

  cleanupAudioVariants();
}

function renderAudioSelector() {
  audioSelect.innerHTML = "";
  if (audioVariants.length <= 1) {
    audioWrap.classList.add("hidden");
    return;
  }

  audioVariants.forEach((variant, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = variant.label;
    if (index === selectedAudioVariantIndex) {
      option.selected = true;
    }
    audioSelect.appendChild(option);
  });

  audioWrap.classList.remove("hidden");
}

function showTranscodeOverlay(fileName) {
  activeTranscodeFileName = fileName;
  transcodeTitle.textContent = "Preparing MKV file... this may take a moment";
  transcodeStatus.textContent = `${fileName} - Transcoding... 0%`;
  transcodeProgressFill.classList.remove("is-indeterminate");
  transcodeProgressFill.style.width = "0%";
  transcodeOverlay.style.opacity = "1";
  transcodeOverlay.classList.remove("hidden");
}

function setOverlayStage(text) {
  transcodeStatus.textContent = text;
}

function setCoreLoadingPhase(fileName) {
  transcodeTitle.textContent = "Loading FFmpeg core...";
  transcodeStatus.textContent = `${fileName} - Loading FFmpeg core...`;
  transcodeProgressFill.classList.add("is-indeterminate");
  transcodeProgressFill.style.width = "36%";
}

function updateTranscodeProgress(percent, textPrefix = "Transcoding") {
  const clamped = Math.max(0, Math.min(100, percent));
  transcodeTitle.textContent = "Preparing MKV file... this may take a moment";
  transcodeProgressFill.classList.remove("is-indeterminate");
  transcodeStatus.textContent = `${textPrefix}... ${clamped}%`;
  transcodeProgressFill.style.width = `${clamped}%`;
}

function hideTranscodeOverlay() {
  transcodeOverlay.style.opacity = "0";
  window.setTimeout(() => {
    transcodeOverlay.classList.add("hidden");
    transcodeOverlay.style.opacity = "1";
  }, 240);
}

async function ensureFfmpegLoaded(activeFileName) {
  activeTranscodeFileName = activeFileName;

  if (!window.FFmpegWASM || !window.FFmpegUtil) {
    throw new Error("FFmpeg.wasm failed to load from CDN.");
  }

  if (!window.crossOriginIsolated) {
    throw new Error(
      "MKV transcoding requires Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy headers.",
    );
  }

  if (ffmpegInstance) {
    return ffmpegInstance;
  }

  if (!ffmpegLoadPromise) {
    const { FFmpeg } = window.FFmpegWASM;
    ffmpegInstance = new FFmpeg();
    setCoreLoadingPhase(activeFileName);

    if (!ffmpegProgressBound) {
      ffmpegInstance.on("progress", ({ progress }) => {
        const percent = Math.round(progress * 100);
        updateTranscodeProgress(
          percent,
          `${activeTranscodeFileName} - Transcoding`,
        );
      });
      ffmpegProgressBound = true;
    }

    if (!ffmpegLogBound) {
      ffmpegInstance.on("log", ({ message }) => {
        console.log("[FFmpeg]", message);
        if (typeof activeFfmpegLogTap === "function") {
          activeFfmpegLogTap(message);
        }
      });
      ffmpegLogBound = true;
    }

    ffmpegLoadPromise = ffmpegInstance.load().then(() => ffmpegInstance);
  }

  return ffmpegLoadPromise;
}

function setCurrentVideoUrl(videoUrl) {
  if (
    currentVideoUrl &&
    currentVideoUrl !== videoUrl &&
    !audioVariants.some((variant) => variant.url === currentVideoUrl)
  ) {
    URL.revokeObjectURL(currentVideoUrl);
  }
  currentVideoUrl = videoUrl;
}

function loadVideoFromUrl(videoUrl, sourceKind) {
  setCurrentVideoUrl(videoUrl);
  currentSourceKind = sourceKind;

  video.src = currentVideoUrl;
  video.load();
  ensurePlayerVisible();

  video.play().catch(() => {
    syncPlayButtonState();
  });
}

function loadVideoDirectly(file) {
  if (!file) {
    return;
  }

  cleanupObjectUrls();
  removeLoadedSubtitle();
  hideMessage();
  pendingFsCleanup = [];

  const directUrl = URL.createObjectURL(file);
  audioWrap.classList.add("hidden");
  loadVideoFromUrl(directUrl, "direct");
}

async function safeDeleteFsFile(ffmpeg, fileName) {
  if (!ffmpeg || !fileName) {
    return;
  }

  try {
    await ffmpeg.deleteFile(fileName);
  } catch (_err) {
    // Best-effort cleanup.
  }
}

async function flushPendingFsCleanup() {
  if (!ffmpegInstance || !pendingFsCleanup.length) {
    return;
  }

  const names = [...new Set(pendingFsCleanup)];
  pendingFsCleanup = [];

  for (const name of names) {
    await safeDeleteFsFile(ffmpegInstance, name);
  }
}

function getUint8ArrayFromReadFileData(data) {
  if (data instanceof Uint8Array) {
    return data;
  }

  if (data && data.buffer instanceof ArrayBuffer) {
    return new Uint8Array(data.buffer);
  }

  return new Uint8Array();
}

async function validatePlayableUrl(videoUrl) {
  const probe = document.createElement("video");
  probe.preload = "metadata";
  probe.muted = true;

  return new Promise((resolve) => {
    let done = false;
    const finalize = (ok) => {
      if (done) {
        return;
      }
      done = true;
      probe.removeAttribute("src");
      probe.load();
      resolve(ok);
    };

    const timeoutId = window.setTimeout(() => {
      finalize(false);
    }, 7000);

    probe.onloadedmetadata = () => {
      window.clearTimeout(timeoutId);
      finalize(true);
    };

    probe.onerror = () => {
      window.clearTimeout(timeoutId);
      finalize(false);
    };

    probe.src = videoUrl;
    probe.load();
  });
}

async function detectAudioStreams(ffmpeg) {
  const seen = new Set();
  const streams = [];
  const streamPattern =
    /Stream #0:(\d+)(?:\[[^\]]+\])?(?:\([^)]*\))?: Audio: ([^,]+)/i;

  activeFfmpegLogTap = (message) => {
    const match = message.match(streamPattern);
    if (!match) {
      return;
    }

    const streamId = match[1];
    if (seen.has(streamId)) {
      return;
    }

    seen.add(streamId);
    streams.push({
      codec: (match[2] || "audio").trim(),
    });
  };

  try {
    await ffmpeg.exec(["-i", "input.mkv", "-f", "null", "-"]);
  } catch (_err) {
    // ffmpeg may return non-zero during probe-like null output; ignore.
  } finally {
    activeFfmpegLogTap = null;
  }

  if (!streams.length) {
    return [{ mapIndex: 0, label: "Track 1" }];
  }

  return streams.map((stream, index) => ({
    mapIndex: index,
    label: `Track ${index + 1} - ${stream.codec.toUpperCase()}`,
  }));
}

async function extractFirstSubtitleTrack(ffmpeg) {
  try {
    await ffmpeg.exec(["-i", "input.mkv", "-map", "0:s:0", "subs.vtt"]);
    const data = await ffmpeg.readFile("subs.vtt");
    const bytes = getUint8ArrayFromReadFileData(data);
    if (!bytes.length) {
      return;
    }

    const subtitleText = new TextDecoder().decode(bytes);
    attachSubtitleFromVttText(subtitleText, "Extracted subtitle");
    pendingFsCleanup.push("subs.vtt");
  } catch (_err) {
    // Embedded subtitle extraction is optional.
  }
}

function revokeVariantUrls(variants) {
  for (const variant of variants) {
    if (variant.url) {
      URL.revokeObjectURL(variant.url);
    }
  }
}

async function buildAudioOutputs(ffmpeg, audioStreams, useX264) {
  const variants = [];

  for (let i = 0; i < audioStreams.length; i += 1) {
    const outputName = `output_audio_${i}_${useX264 ? "x264" : "copy"}.mp4`;
    const args = [
      "-i",
      "input.mkv",
      "-map",
      "0:v:0",
      "-map",
      `0:a:${audioStreams[i].mapIndex}`,
      "-c:v",
      useX264 ? "libx264" : "copy",
    ];

    if (useX264) {
      args.push("-preset", "veryfast");
    }

    args.push("-c:a", "aac", "-movflags", "faststart", outputName);

    await ffmpeg.exec(args);

    const data = await ffmpeg.readFile(outputName);
    const bytes = getUint8ArrayFromReadFileData(data);
    const url = URL.createObjectURL(new Blob([bytes], { type: "video/mp4" }));

    variants.push({
      outputName,
      url,
      label: audioStreams[i].label || `Track ${i + 1}`,
    });
  }

  return variants;
}

async function runTranscodePipeline(ffmpeg, audioStreams, forceX264) {
  if (!forceX264) {
    try {
      const copyVariants = await buildAudioOutputs(ffmpeg, audioStreams, false);
      const playable = await validatePlayableUrl(copyVariants[0].url);
      if (playable) {
        return { profile: "copy", variants: copyVariants };
      }

      revokeVariantUrls(copyVariants);
      for (const variant of copyVariants) {
        await safeDeleteFsFile(ffmpeg, variant.outputName);
      }
    } catch (_err) {
      // Fall through to x264 pass.
    }
  }

  const x264Variants = await buildAudioOutputs(ffmpeg, audioStreams, true);
  return { profile: "x264", variants: x264Variants };
}

function setAudioVariants(variants) {
  cleanupAudioVariants();
  audioVariants = variants;
  selectedAudioVariantIndex = 0;
  renderAudioSelector();
}

function switchAudioVariant(index) {
  if (index < 0 || index >= audioVariants.length) {
    return;
  }

  const target = audioVariants[index];
  const wasPaused = video.paused;
  const resumeTime = video.currentTime;

  setCurrentVideoUrl(target.url);
  currentSourceKind = "mkv-multi";

  video.src = target.url;
  video.load();

  video.addEventListener(
    "loadedmetadata",
    () => {
      if (Number.isFinite(video.duration) && video.duration > 0) {
        video.currentTime = Math.min(resumeTime, video.duration);
      }

      if (!wasPaused) {
        video.play().catch(() => {});
      }
    },
    { once: true },
  );

  selectedAudioVariantIndex = index;
}

async function transcodeWithFFmpeg(file, forceX264 = false) {
  if (!file) {
    return;
  }

  if (typeof SharedArrayBuffer === "undefined") {
    hideTranscodeOverlay();
    showError(
      "⚠️ MKV transcoding requires a local server with security headers.<br><br>Run: <code>npx serve . --cors</code> then open <code>http://localhost:3000</code><br>Opening via <code>file://</code> will not work for MKV files.",
    );
    return;
  }

  try {
    isTranscoding = true;
    activeTranscodeFileName = file.name;
    showTranscodeOverlay(file.name);
    setOverlayStage("MKV detected - starting transcoder...");

    if (file.size > 2 * 1024 * 1024 * 1024) {
      showMessage(
        "Warning: files over 2GB may cause memory issues in the browser.",
      );
    } else {
      hideMessage();
    }

    cleanupObjectUrls();
    removeLoadedSubtitle();
    pendingFsCleanup = [];

    setOverlayStage("Loading FFmpeg core...");
    const ffmpeg = await ensureFfmpegLoaded(file.name);
    const { fetchFile } = window.FFmpegUtil;

    setOverlayStage("Writing file...");
    await ffmpeg.writeFile("input.mkv", await fetchFile(file));

    setOverlayStage("Detecting audio streams...");
    const audioStreams = await detectAudioStreams(ffmpeg);

    setOverlayStage("Transcoding video...");
    const result = await runTranscodePipeline(ffmpeg, audioStreams, forceX264);

    setOverlayStage("Extracting subtitles...");
    await extractFirstSubtitleTrack(ffmpeg);

    pendingFsCleanup.push(
      "input.mkv",
      ...result.variants.map((v) => v.outputName),
    );

    setAudioVariants(result.variants);

    setOverlayStage("Loading into player...");
    loadVideoFromUrl(result.variants[0].url, `mkv-${result.profile}`);
    currentSourceKind = "mkv-multi";

    updateTranscodeProgress(100, `${file.name} - Transcoding complete`);
    window.setTimeout(hideTranscodeOverlay, 180);
  } catch (err) {
    console.error("[FFmpeg Error]", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    showError(`❌ MKV transcoding failed: ${message}`);
    hideTranscodeOverlay();
  } finally {
    isTranscoding = false;
  }
}

async function handleSelectedFile(file) {
  if (!file) {
    return;
  }

  const fileName = file.name.toLowerCase();
  if (fileName.endsWith(".mkv")) {
    ensurePlayerVisible();
    showTranscodeOverlay(file.name);
    setOverlayStage("MKV detected - starting transcoder...");
    await transcodeWithFFmpeg(file);
    return;
  }

  loadVideoDirectly(file);
}

function requestFullscreen(target) {
  if (target.requestFullscreen) {
    target.requestFullscreen();
  } else if (target.webkitRequestFullscreen) {
    target.webkitRequestFullscreen();
  }
}

function exitFullscreen() {
  if (document.exitFullscreen) {
    document.exitFullscreen();
  } else if (document.webkitExitFullscreen) {
    document.webkitExitFullscreen();
  }
}

function togglePlayPause() {
  if (video.paused || video.ended) {
    video.play().catch(() => {});
  } else {
    video.pause();
  }
}

function seekBy(deltaSeconds) {
  if (!Number.isFinite(video.duration)) {
    return;
  }
  video.currentTime = Math.min(
    Math.max(video.currentTime + deltaSeconds, 0),
    video.duration,
  );
}

dropZone.addEventListener("click", () => videoInput.click());

dropZone.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    videoInput.click();
  }
});

dropZone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropZone.classList.add("drag-over");
});

dropZone.addEventListener("dragleave", () => {
  dropZone.classList.remove("drag-over");
});

dropZone.addEventListener("drop", async (event) => {
  event.preventDefault();
  dropZone.classList.remove("drag-over");

  const file = event.dataTransfer?.files?.[0];
  await handleSelectedFile(file);
});

videoInput.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  await handleSelectedFile(file);
  videoInput.value = "";
});

playPauseBtn.addEventListener("click", () => {
  togglePlayPause();
  setControlsVisible();
});

video.addEventListener("click", () => {
  togglePlayPause();
  setControlsVisible();
});

video.addEventListener("play", () => {
  syncPlayButtonState();
  setControlsVisible();
});

video.addEventListener("pause", () => {
  syncPlayButtonState();
  setControlsVisible();
});

video.addEventListener("ended", () => {
  syncPlayButtonState();
  setControlsVisible();
});

video.addEventListener("playing", () => {
  flushPendingFsCleanup();
});

video.addEventListener("timeupdate", () => {
  updateTimeDisplay();
  updateSeekVisuals();
});

video.addEventListener("progress", updateSeekVisuals);

video.addEventListener("loadedmetadata", () => {
  updateTimeDisplay();
  updateSeekVisuals();
  setControlsVisible();
});

video.addEventListener("error", () => {
  if (currentSourceKind.startsWith("mkv")) {
    showMessage(
      "Unable to play this MKV-derived video in the current browser.",
    );
  } else {
    showMessage(
      "Unable to play this video file. Please verify format and codec.",
    );
  }
});

seekBar.addEventListener("input", () => {
  userIsSeeking = true;
  const percent = Number(seekBar.value);
  seekProgress.style.width = `${percent}%`;
});

seekBar.addEventListener("change", () => {
  if (!Number.isFinite(video.duration) || video.duration <= 0) {
    userIsSeeking = false;
    return;
  }

  const percent = Number(seekBar.value) / 100;
  video.currentTime = percent * video.duration;
  userIsSeeking = false;
  setControlsVisible();
});

muteBtn.addEventListener("click", () => {
  video.muted = !video.muted;
  syncMuteLabel();
  setControlsVisible();
});

volumeBar.addEventListener("input", () => {
  video.volume = Number(volumeBar.value);
  video.muted = video.volume === 0;
  syncMuteLabel();
  setControlsVisible();
});

speedSelect.addEventListener("change", () => {
  video.playbackRate = Number(speedSelect.value);
  setControlsVisible();
});

audioSelect.addEventListener("change", () => {
  const index = Number(audioSelect.value);
  switchAudioVariant(index);
  setControlsVisible();
});

ccBtn.addEventListener("click", () => {
  subtitlePanel.classList.toggle("hidden");
  setControlsVisible();
});

subtitleInput.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) {
    return;
  }
  await loadSubtitleFile(file);
  subtitleInput.value = "";
});

subtitleToggle.addEventListener("click", () => {
  subtitlesEnabled = !subtitlesEnabled;
  applySubtitleState();
});

subtitleSize.addEventListener("input", () => {
  document.documentElement.style.setProperty(
    "--subtitle-size",
    `${subtitleSize.value}px`,
  );
});

fullscreenBtn.addEventListener("click", () => {
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    exitFullscreen();
  } else {
    requestFullscreen(videoStage);
  }
  setControlsVisible();
});

document.addEventListener("fullscreenchange", setControlsVisible);

videoStage.addEventListener("mousemove", setControlsVisible);

videoStage.addEventListener("mouseleave", () => {
  if (!video.paused) {
    videoStage.classList.add("controls-hidden");
  }
});

videoStage.addEventListener("touchstart", setControlsVisible, {
  passive: true,
});

document.addEventListener("keydown", (event) => {
  const activeTag = document.activeElement
    ? document.activeElement.tagName
    : "";
  const isTypingTarget =
    activeTag === "INPUT" || activeTag === "SELECT" || activeTag === "TEXTAREA";

  if (isTypingTarget && event.key !== " " && event.key !== "Escape") {
    return;
  }

  switch (event.key.toLowerCase()) {
    case " ":
      event.preventDefault();
      togglePlayPause();
      break;
    case "arrowleft":
      event.preventDefault();
      seekBy(-10);
      break;
    case "arrowright":
      event.preventDefault();
      seekBy(10);
      break;
    case "arrowup":
      event.preventDefault();
      video.volume = Math.min(video.volume + 0.05, 1);
      volumeBar.value = String(video.volume);
      video.muted = false;
      syncMuteLabel();
      break;
    case "arrowdown":
      event.preventDefault();
      video.volume = Math.max(video.volume - 0.05, 0);
      volumeBar.value = String(video.volume);
      video.muted = video.volume === 0;
      syncMuteLabel();
      break;
    case "f":
      event.preventDefault();
      if (document.fullscreenElement || document.webkitFullscreenElement) {
        exitFullscreen();
      } else {
        requestFullscreen(videoStage);
      }
      break;
    case "m":
      event.preventDefault();
      video.muted = !video.muted;
      syncMuteLabel();
      break;
    case "escape":
      hideSubtitlePanel();
      break;
    default:
      return;
  }

  setControlsVisible();
});

window.addEventListener("load", () => {
  if (typeof window.FFmpegWASM === "undefined") {
    console.error("FFmpeg.wasm failed to load from CDN");
  } else {
    console.log("FFmpeg.wasm ready");
  }
});

window.addEventListener("beforeunload", cleanupObjectUrls);

updateTimeDisplay();
updateSeekVisuals();
syncPlayButtonState();
syncMuteLabel();
hideSubtitlePanel();

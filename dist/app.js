"use strict";

const TRACKS = [
  { id: "kick", label: "KICK", color: "#d8562c" },
  { id: "snare", label: "SNARE", color: "#d49a32" },
  { id: "clap", label: "CLAP", color: "#b34b45" },
  { id: "closedHat", label: "C. HAT", color: "#567f7b" },
  { id: "openHat", label: "O. HAT", color: "#2e7771" },
];

const CHANNELS = [
  ...TRACKS,
  { id: "bass", label: "BASS", color: "#2e7771" },
  { id: "juno", label: "J-4", color: "#6f62a8" },
];

const FX_NAMES = ["delay", "reverb", "phaser", "chorus", "flanger"];
const FX_SEND_DEFAULTS = {
  delay: 0.24,
  reverb: 0.18,
  phaser: 0.28,
  chorus: 0.30,
  flanger: 0.22,
};
const FX_PARAMETER_DEFAULTS = {
  delayMode: "tape",
  delayTiming: "free",
  delayDivision: "1/8",
  delayPingPong: false,
  delayTime: 0.31,
  delayFeedback: 0.38,
  delayTone: 4200,
  reverbMode: "room",
  reverbDamping: 6500,
  phaserRate: 0.32,
  phaserDepth: 0.48,
  chorusRate: 0.8,
  chorusDepth: 0.52,
  flangerRate: 0.18,
  flangerFeedback: 0.32,
};
const DELAY_DIVISION_BEATS = {
  "1/16": 0.25,
  "1/8T": 1 / 3,
  "1/8": 0.5,
  "1/8D": 0.75,
  "1/4": 1,
};
const AUTO_CUTOFF_DIVISION_CYCLES = {
  "1/1": 0.25,
  "1/2": 0.5,
  "1/2T": 0.75,
  "1/4": 1,
  "1/4T": 1.5,
  "1/8": 2,
};
const ARP_DIVISION_BEATS = {
  "1/4": 1,
  "1/8": 0.5,
  "1/8T": 1 / 3,
  "1/16": 0.25,
};
const ARP_MODES = ["UP", "DOWN", "UP/DOWN", "RANDOM", "ORDER"];

const BASS_GAIN_FLOOR = 0.0001;
const BASS_FADE_TIME = 0.008;
const JUNO_POLYPHONY = 4;
const JUNO_GAIN_FLOOR = 0.0001;
const JUNO_FADE_TIME = 0.009;
const JUNO_ARP_RETRIGGER_MARGIN = 0.006;
const DIAGNOSTIC_BUFFER_SIZE = 256;
const DIAGNOSTIC_METRICS = {
  schedulerInterval: 0, schedulerLateness: 1, schedulerSkippedThisTick: 2, schedulerHorizon: 3,
  schedulerEvents: 4, input: 5, directRender: 6, playheadRender: 7,
  scopeRender: 8, meterRender: 9, longTask: 10, audioClockDelta: 11,
  animationFrameGap: 12, tabSwitch: 13, controlFlush: 14,
  scheduledStartDelta: 15, scheduledStopDelta: 16, audioProgress: 17, outputTimestampSkew: 18,
};
const DIAGNOSTIC_METRIC_COUNT = 19;
const DIAGNOSTIC_VOICE_INDEX = Object.fromEntries(CHANNELS.map(({ id }, index) => [id, index]));
const JUNO_CHORUS_SETTINGS = {
  OFF: { rate: 0.45, depth: 0, wet: 0, dry: 1 },
  I: { rate: 0.52, depth: 0.0019, wet: 0.52, dry: 0.86 },
  II: { rate: 0.86, depth: 0.0034, wet: 0.61, dry: 0.78 },
  "I+II": { rate: 1.12, depth: 0.0046, wet: 0.70, dry: 0.72 },
};

function getJunoUnitSettings(synth) {
  const chorus = JUNO_CHORUS_SETTINGS[synth.chorusMode] || JUNO_CHORUS_SETTINGS.I;
  return {
    chorusRate: chorus.rate,
    chorusDepth: chorus.depth,
    dry: chorus.dry,
    wet: chorus.wet,
    lfoRate: synth.lfoRate,
    pitchDepth: synth.lfoPitch * 38,
    filterDepth: synth.lfoFilter * 2400,
    pwmDepth: synth.pwmAmount * 0.42,
  };
}
// The two-pole J-4 filter becomes numerically fragile below this point when
// resonance, PWM and modulation all meet. Keep the musical low end, but do
// not let control signals drive the AudioParam into negative frequencies.
const JUNO_FILTER_FLOOR = 120;
// Low/highpass Q uses dB in Web Audio: this is linear Q = 1/sqrt(2).
const NON_RESONANT_Q_DB = -3.01029995664;
const REVERB_PRESETS = {
  room: { seconds: 0.8, decay: 3.9, diffusion: 0.12 },
  plate: { seconds: 1.65, decay: 3.1, diffusion: 0.34 },
  hall: { seconds: 3.4, decay: 3.8, diffusion: 0.62 },
};

const NOTE_NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
const BLACK_NOTES = new Set([1, 3, 6, 8, 10]);
const WHITE_KEY_INDEX = new Map([[0, 0], [2, 1], [4, 2], [5, 3], [7, 4], [9, 5], [11, 6]]);
const BLACK_KEY_AFTER = new Map([[1, 0], [3, 1], [6, 3], [8, 4], [10, 5]]);
const COMPUTER_JUNO_KEYS = new Map([
  ["KeyZ", 60], ["KeyS", 61], ["KeyX", 62], ["KeyD", 63], ["KeyC", 64], ["KeyV", 65],
  ["KeyG", 66], ["KeyB", 67], ["KeyH", 68], ["KeyN", 69], ["KeyJ", 70], ["KeyM", 71],
  ["KeyQ", 72], ["Digit2", 73], ["KeyW", 74], ["Digit3", 75], ["KeyE", 76], ["KeyR", 77],
  ["Digit5", 78], ["KeyT", 79], ["Digit6", 80], ["KeyY", 81], ["Digit7", 82], ["KeyU", 83],
]);
const COMPUTER_JUNO_LABELS = new Map([...COMPUTER_JUNO_KEYS].map(([code, midi]) => [midi, code.startsWith("Key") ? code.slice(3) : code.slice(5)]));

const BASE_DRUM_PATTERN = {
  kick:       [2, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 1, 1, 0, 0, 0],
  snare:      [0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0],
  clap:       [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
  closedHat:  [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0],
  openHat:    [0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0],
};

const BASE_BASS_PATTERN = [
  { active: true, midi: 24, accent: true, slide: false },
  { active: false, midi: 24, accent: false, slide: false },
  { active: false, midi: 24, accent: false, slide: false },
  { active: true, midi: 24, accent: false, slide: false },
  { active: false, midi: 24, accent: false, slide: false },
  { active: false, midi: 24, accent: false, slide: false },
  { active: true, midi: 31, accent: false, slide: true },
  { active: false, midi: 31, accent: false, slide: false },
  { active: true, midi: 36, accent: true, slide: false },
  { active: false, midi: 36, accent: false, slide: false },
  { active: false, midi: 36, accent: false, slide: false },
  { active: true, midi: 34, accent: false, slide: false },
  { active: false, midi: 34, accent: false, slide: false },
  { active: false, midi: 34, accent: false, slide: false },
  { active: true, midi: 31, accent: false, slide: true },
  { active: false, midi: 31, accent: false, slide: false },
];

const state = {
  bpm: 112,
  swing: 54,
  master: 0.82,
  masterProcessor: {
    limiterEnabled: false,
    limiterThreshold: -3,
    limiterAttack: 0.001,
    limiterRelease: 0.12,
    limiterCeiling: -1,
    eqEnabled: true,
    highPassFreq: 20,
    lowShelfFreq: 120,
    lowShelfGain: 0,
    highShelfFreq: 6500,
    highShelfGain: 0,
    lowPassFreq: 20000,
  },
  playing: false,
  starting: false,
  currentStep: -1,
  selectedBassStep: 0,
  selectedProcessorChannel: "kick",
  selectedFxChannel: "kick",
  drumPattern: cloneDrumPattern(),
  bassPattern: cloneBassPattern(),
  mutes: Object.fromEntries(CHANNELS.map(({ id }) => [id, false])),
  directMutes: { drums: false, bass: false, juno: false },
  snareBreak: {
    mode: "ONLY",
    bars: 4,
    status: "idle",
    startTime: null,
    startStep: null,
    stepsScheduled: 0,
    totalSteps: 0,
    activeMode: null,
  },
  levels: {
    kick: 0.90,
    snare: 0.76,
    clap: 0.65,
    closedHat: 0.58,
    openHat: 0.54,
    bass: 0.78,
    juno: 0.68,
  },
  pans: {
    kick: 0,
    snare: 0,
    clap: 0.10,
    closedHat: -0.18,
    openHat: 0.18,
    bass: 0,
    juno: 0,
  },
  drums: {
    kickTune: 48,
    snareTone: 1150,
    hatDecay: 0.46,
  },
  processors: createProcessorStates(),
  synth: {
    wave: "sawtooth",
    cutoff: 900,
    resonance: 7,
    envAmount: 2200,
    attack: 0.008,
    decay: 0.18,
    sustain: 0.42,
    release: 0.09,
    glide: 0.055,
    sub: 0.32,
    drive: 0.18,
    autoCutoffEnabled: false,
    autoCutoffDivision: "1/2",
    autoCutoffAmount: 0.45,
  },
  juno: {
    saw: true,
    pulse: true,
    sub: 0.22,
    octave: 8,
    fineTune: 0,
    pulseWidth: 0.46,
    pwmAmount: 0.28,
    highPass: 90,
    cutoff: 2800,
    resonance: 4.5,
    envAmount: 3200,
    attack: 0.018,
    decay: 0.34,
    sustain: 0.62,
    release: 0.72,
    lfoRate: 0.72,
    lfoPitch: 0.04,
    lfoFilter: 0.16,
    chorusMode: "I",
    arp: {
      enabled: false,
      hold: false,
      mode: "UP",
      division: "1/8",
      octaves: 1,
      gate: 0.72,
    },
  },
  fx: {
    enabled: createFxEnabledStates(),
    sends: createFxSendStates(),
    channels: createFxParameterStates(),
  },
};

const DIRECT_MUTE_CHANNELS = {
  drums: ["kick", "snare", "clap", "closedHat", "openHat"],
  bass: ["bass"],
  juno: ["juno"],
};
const SNARE_BREAK_STEPS_PER_BAR = 16;
const SNARE_BREAK_START_VELOCITY = 50 / 127;
const SNARE_BREAK_TARGET_VELOCITY = 1;

function isChannelMuted(id) {
  return Boolean(state.mutes[id]
    || (DIRECT_MUTE_CHANNELS.drums.includes(id) && state.directMutes.drums)
    || (id === "bass" && state.directMutes.bass)
    || (id === "juno" && state.directMutes.juno));
}

function cloneDrumPattern() {
  return Object.fromEntries(Object.entries(BASE_DRUM_PATTERN).map(([key, values]) => [key, [...values]]));
}

function cloneBassPattern() {
  return BASE_BASS_PATTERN.map((step) => ({ ...step }));
}

function createProcessorStates() {
  return Object.fromEntries(CHANNELS.map(({ id }) => [id, {
    peakReduction: 25,
    makeupGain: 0,
    highPassFreq: 28,
    lowShelfFreq: 120,
    lowShelfGain: 0,
    highShelfFreq: 6500,
    highShelfGain: 0,
    lowPassFreq: 20000,
  }]));
}

function createFxEnabledStates() {
  return Object.fromEntries(CHANNELS.map(({ id }) => [
    id,
    Object.fromEntries(FX_NAMES.map((effect) => [effect, false])),
  ]));
}

function createFxSendStates() {
  return Object.fromEntries(CHANNELS.map(({ id }) => [id, { ...FX_SEND_DEFAULTS }]));
}

function createFxParameterStates() {
  return Object.fromEntries(CHANNELS.map(({ id }) => [id, { ...FX_PARAMETER_DEFAULTS }]));
}

function getChannelFxState(channelId = state.selectedFxChannel) {
  return state.fx.channels[channelId];
}

function getDelaySeconds(fx, bpm = state.bpm) {
  if (fx.delayTiming !== "sync") return clamp(fx.delayTime, 0.055, 0.9);
  const beats = DELAY_DIVISION_BEATS[fx.delayDivision] || DELAY_DIVISION_BEATS["1/8"];
  return clamp(60 / clamp(bpm, 50, 190) * beats, 0.055, 1.2);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function midiToFrequency(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function midiToName(midi) {
  const name = NOTE_NAMES[((midi % 12) + 12) % 12];
  const octave = Math.floor(midi / 12) - 1;
  return `${name}${octave}`;
}

function buildArpSequence(notes, mode = "UP", octaves = 1) {
  const unique = new Map();
  notes.forEach((note, index) => {
    const midi = Number(typeof note === "number" ? note : note.midi);
    const order = Number(typeof note === "number" ? index : note.order ?? index);
    if (Number.isFinite(midi) && !unique.has(midi)) unique.set(midi, { midi, order });
  });
  const base = [...unique.values()];
  if (!base.length) return [];
  const ordered = mode === "ORDER"
    ? base.sort((a, b) => a.order - b.order)
    : base.sort((a, b) => a.midi - b.midi);
  const expanded = [];
  for (let octave = 0; octave < clamp(Math.round(octaves), 1, 3); octave += 1) {
    ordered.forEach(({ midi }) => {
      const shifted = midi + octave * 12;
      if (shifted <= 127) expanded.push(shifted);
    });
  }
  if (mode === "DOWN") return expanded.reverse();
  if (mode === "UP/DOWN" && expanded.length > 2) return [...expanded, ...expanded.slice(1, -1).reverse()];
  return expanded;
}

function dbToGain(decibels) {
  return Math.pow(10, decibels / 20);
}

function rangeFill(input) {
  const min = Number(input.min || 0);
  const max = Number(input.max || 100);
  const value = Number(input.value);
  const percent = ((value - min) / Math.max(1, max - min)) * 100;
  input.style.setProperty("--range-fill", `${percent}%`);
}

function panLabel(value) {
  const amount = Math.round(Math.abs(value) * 100);
  if (amount < 2) return "C";
  return `${amount}${value < 0 ? "L" : "R"}`;
}

class PerformanceDiagnostics {
  constructor() {
    this.enabled = false;
    this.buffers = null;
    this.writeIndexes = null;
    this.sampleCounts = null;
    this.voiceCreated = null;
    this.voiceActive = null;
    this.voiceCleaned = null;
    this.totals = null;
    this.lastSchedulerTick = NaN;
    this.lastAnimationFrame = NaN;
    this.audioClockReferencePerformance = NaN;
    this.audioClockReferenceAudio = NaN;
    this.lastAudioClockPerformance = NaN;
    this.lastAudioClockTime = NaN;
    this.lastClockJumpMs = 0;
    this.lastClockJumpPerformance = NaN;
    this.lastLongTaskDuration = 0;
    this.lastLongTaskPerformance = NaN;
    this.lastControl = "—";
    this.lastAudioState = "uninitialized";
    this.lastAudioStateReason = "initial";
    this.lastAudioStatePerformance = NaN;
    this.outputTimestampCurrentTime = NaN;
    this.outputTimestampContextTime = NaN;
    this.outputTimestampPerformanceTime = NaN;
    this.outputTimestampNow = NaN;
    this.outputTimestampBaseLatency = 0;
    this.outputTimestampOutputLatency = 0;
    this.observer = null;
  }

  enable(audioEngine) {
    if (this.enabled) return;
    this.buffers = Array.from({ length: DIAGNOSTIC_METRIC_COUNT }, () => new Float64Array(DIAGNOSTIC_BUFFER_SIZE));
    this.writeIndexes = new Uint16Array(DIAGNOSTIC_METRIC_COUNT);
    this.sampleCounts = new Uint16Array(DIAGNOSTIC_METRIC_COUNT);
    this.voiceCreated = new Uint32Array(CHANNELS.length);
    this.voiceActive = new Uint32Array(CHANNELS.length);
    this.voiceCleaned = new Uint32Array(CHANNELS.length);
    this.totals = {
      schedulerTicks: 0, skippedSteps: 0, scheduledEvents: 0, inputEvents: 0, longTasks: 0, visibilityChanges: 0,
      scopeFrames: 0, meterFrames: 0, scopeSkippedVisibility: 0, meterSkippedVisibility: 0, meterSkippedRate: 0,
      scheduledPast: 0, scheduledInHorizon: 0, scheduledTooFar: 0, audioStateChanges: 0,
    };
    this.lastSchedulerTick = NaN;
    this.lastAnimationFrame = NaN;
    this.lastAudioClockPerformance = NaN;
    this.lastAudioClockTime = NaN;
    this.lastClockJumpMs = 0;
    this.lastClockJumpPerformance = NaN;
    this.lastLongTaskDuration = 0;
    this.lastLongTaskPerformance = NaN;
    this.lastControl = "—";
    this.lastAudioState = audioEngine?.ctx?.state || "uninitialized";
    this.lastAudioStateReason = "initial";
    this.lastAudioStatePerformance = performance.now();
    this.outputTimestampCurrentTime = NaN;
    this.outputTimestampContextTime = NaN;
    this.outputTimestampPerformanceTime = NaN;
    this.outputTimestampNow = NaN;
    this.outputTimestampBaseLatency = 0;
    this.outputTimestampOutputLatency = 0;
    this.enabled = true;
    this.syncActiveVoices(audioEngine);
    this.resetAudioClockReference(audioEngine);
    this.startLongTaskObserver();
  }

  disable() {
    if (!this.enabled) return;
    this.enabled = false;
    this.observer?.disconnect();
    this.observer = null;
  }

  record(metric, value) {
    if (!this.enabled || !Number.isFinite(value)) return;
    const index = DIAGNOSTIC_METRICS[metric];
    const buffer = this.buffers[index];
    const writeIndex = this.writeIndexes[index];
    buffer[writeIndex] = value;
    this.writeIndexes[index] = (writeIndex + 1) % DIAGNOSTIC_BUFFER_SIZE;
    if (this.sampleCounts[index] < DIAGNOSTIC_BUFFER_SIZE) this.sampleCounts[index] += 1;
  }

  begin() {
    return this.enabled ? performance.now() : 0;
  }

  end(metric, startedAt) {
    if (this.enabled) this.record(metric, performance.now() - startedAt);
  }

  recordScheduler(audioNow, latenessMs, skippedSteps, horizonMs, scheduledEvents) {
    if (!this.enabled) return;
    const now = performance.now();
    if (Number.isFinite(this.lastSchedulerTick)) this.record("schedulerInterval", now - this.lastSchedulerTick);
    this.lastSchedulerTick = now;
    this.record("schedulerLateness", latenessMs);
    this.record("schedulerSkippedThisTick", skippedSteps);
    this.record("schedulerHorizon", horizonMs);
    this.record("schedulerEvents", scheduledEvents);
    if (Number.isFinite(this.audioClockReferencePerformance) && Number.isFinite(this.audioClockReferenceAudio)) {
      this.record("audioClockDelta", (now - this.audioClockReferencePerformance) - (audioNow - this.audioClockReferenceAudio) * 1000);
    }
    this.totals.schedulerTicks += 1;
    this.totals.skippedSteps += skippedSteps;
    this.totals.scheduledEvents += scheduledEvents;
  }

  recordInput(startedAt) {
    if (!this.enabled) return;
    this.record("input", performance.now() - startedAt);
    this.totals.inputEvents += 1;
  }

  recordControl(name) {
    if (this.enabled && name) this.lastControl = String(name);
  }

  recordAudioState(audioEngine, reason = "statechange") {
    if (!this.enabled) return;
    this.lastAudioState = audioEngine?.ctx?.state || "uninitialized";
    this.lastAudioStatePerformance = performance.now();
    this.totals.audioStateChanges += 1;
    this.lastAudioStateReason = reason;
  }

  captureAudioClock(audioEngine) {
    if (!this.enabled || !audioEngine?.ctx) return;
    const context = audioEngine.ctx;
    const now = performance.now();
    const currentTime = context.currentTime;
    if (Number.isFinite(this.lastAudioClockPerformance) && Number.isFinite(this.lastAudioClockTime)) {
      const wallElapsed = now - this.lastAudioClockPerformance;
      const audioElapsed = (currentTime - this.lastAudioClockTime) * 1000;
      const jump = wallElapsed - audioElapsed;
      this.record("audioProgress", audioElapsed);
      if (Math.abs(jump) >= 50) {
        this.lastClockJumpMs = jump;
        this.lastClockJumpPerformance = now;
      }
    }
    this.lastAudioClockPerformance = now;
    this.lastAudioClockTime = currentTime;
    if (typeof context.getOutputTimestamp !== "function") return;
    try {
      const timestamp = context.getOutputTimestamp();
      if (!timestamp || !Number.isFinite(timestamp.contextTime) || !Number.isFinite(timestamp.performanceTime)) return;
      this.outputTimestampCurrentTime = currentTime;
      this.outputTimestampContextTime = timestamp.contextTime;
      this.outputTimestampPerformanceTime = timestamp.performanceTime;
      this.outputTimestampNow = now;
      this.outputTimestampBaseLatency = Number(context.baseLatency) || 0;
      this.outputTimestampOutputLatency = Number(context.outputLatency) || 0;
      this.record("outputTimestampSkew", timestamp.performanceTime - now);
    } catch {
      // Optional on Safari and some Android implementations.
    }
  }

  recordScheduledEvent(startAt, stopAt, audioEngine, horizon = 0.11) {
    if (!this.enabled || !audioEngine?.ctx) return;
    const now = audioEngine.ctx.currentTime;
    const startDelta = startAt - now;
    const stopDelta = stopAt - now;
    if (Number.isFinite(startDelta)) {
      this.record("scheduledStartDelta", startDelta * 1000);
      if (startDelta < 0) this.totals.scheduledPast += 1;
      else if (startDelta <= horizon) this.totals.scheduledInHorizon += 1;
      else this.totals.scheduledTooFar += 1;
    }
    if (Number.isFinite(stopDelta)) this.record("scheduledStopDelta", stopDelta * 1000);
  }

  voiceCreatedFor(track) {
    if (!this.enabled) return;
    const index = DIAGNOSTIC_VOICE_INDEX[track];
    if (index === undefined) return;
    this.voiceCreated[index] += 1;
    this.voiceActive[index] += 1;
  }

  voiceCleanedFor(track) {
    if (!this.enabled) return;
    const index = DIAGNOSTIC_VOICE_INDEX[track];
    if (index === undefined) return;
    this.voiceCleaned[index] += 1;
    if (this.voiceActive[index] > 0) this.voiceActive[index] -= 1;
  }

  syncActiveVoices(audioEngine) {
    if (!this.enabled || !audioEngine) return;
    this.voiceActive.fill(0);
    audioEngine.drumVoices.forEach((voice) => {
      const index = DIAGNOSTIC_VOICE_INDEX[voice.track];
      if (index !== undefined) this.voiceActive[index] += 1;
    });
    this.voiceActive[DIAGNOSTIC_VOICE_INDEX.bass] = audioEngine.bassVoices.size;
    this.voiceActive[DIAGNOSTIC_VOICE_INDEX.juno] = audioEngine.junoVoices.size;
  }

  recordVisibility(audioEngine) {
    if (!this.enabled) return;
    this.totals.visibilityChanges += 1;
    this.syncActiveVoices(audioEngine);
  }

  resetAudioClockReference(audioEngine) {
    if (!this.enabled || !audioEngine?.ctx) return;
    this.audioClockReferencePerformance = performance.now();
    this.audioClockReferenceAudio = audioEngine.ctx.currentTime;
  }

  recordAnimationFrame(timestamp) {
    if (!this.enabled) return;
    if (Number.isFinite(this.lastAnimationFrame)) this.record("animationFrameGap", timestamp - this.lastAnimationFrame);
    this.lastAnimationFrame = timestamp;
  }

  recordVisualFrame(kind) {
    if (!this.enabled) return;
    if (kind === "scope") this.totals.scopeFrames += 1;
    else this.totals.meterFrames += 1;
  }

  recordVisualSkip(kind, reason) {
    if (!this.enabled) return;
    if (reason === "visibility") {
      if (kind === "scope") this.totals.scopeSkippedVisibility += 1;
      else this.totals.meterSkippedVisibility += 1;
    } else if (kind === "meter") this.totals.meterSkippedRate += 1;
  }

  startLongTaskObserver() {
    const Observer = window.PerformanceObserver || globalThis.PerformanceObserver;
    if (!Observer) return;
    try {
      this.observer = new Observer((entries) => {
        if (!this.enabled) return;
        entries.getEntries().forEach((entry) => {
          if (entry.duration > 50) {
            this.record("longTask", entry.duration);
            this.totals.longTasks += 1;
            this.lastLongTaskDuration = entry.duration;
            this.lastLongTaskPerformance = Number.isFinite(entry.startTime) ? entry.startTime + entry.duration : performance.now();
          }
        });
      });
      this.observer.observe({ type: "longtask", buffered: true });
    } catch {
      this.observer?.disconnect();
      this.observer = null;
    }
  }

  metricSummary(metric) {
    if (!this.enabled) return { count: 0, min: 0, max: 0, p50: 0, p95: 0 };
    const index = DIAGNOSTIC_METRICS[metric];
    const count = this.sampleCounts[index];
    if (!count) return { count: 0, min: 0, max: 0, p50: 0, p95: 0 };
    const values = new Float64Array(count);
    const start = count === DIAGNOSTIC_BUFFER_SIZE ? this.writeIndexes[index] : 0;
    for (let offset = 0; offset < count; offset += 1) values[offset] = this.buffers[index][(start + offset) % DIAGNOSTIC_BUFFER_SIZE];
    values.sort();
    return {
      count,
      min: values[0],
      max: values[count - 1],
      p50: values[Math.floor((count - 1) * 0.5)],
      p95: values[Math.floor((count - 1) * 0.95)],
    };
  }

  snapshot(audioEngine) {
    this.syncActiveVoices(audioEngine);
    const voices = {};
    CHANNELS.forEach(({ id }, index) => {
      voices[id] = { created: this.voiceCreated?.[index] || 0, active: this.voiceActive?.[index] || 0, cleaned: this.voiceCleaned?.[index] || 0 };
    });
    return {
      enabled: this.enabled,
      bufferSize: DIAGNOSTIC_BUFFER_SIZE,
      scheduler: ["schedulerInterval", "schedulerLateness", "schedulerSkippedThisTick", "schedulerHorizon", "schedulerEvents"].map((metric) => [metric, this.metricSummary(metric)]),
      ui: ["input", "directRender", "playheadRender", "scopeRender", "meterRender", "longTask", "animationFrameGap", "tabSwitch", "controlFlush"].map((metric) => [metric, this.metricSummary(metric)]),
      audioClock: this.metricSummary("audioClockDelta"),
      timing: ["scheduledStartDelta", "scheduledStopDelta", "audioProgress", "outputTimestampSkew"].map((metric) => [metric, this.metricSummary(metric)]),
      totals: this.totals ? { ...this.totals } : null,
      voices,
      fxActive: audioEngine ? audioEngine.channelDelays.size + audioEngine.channelChoruses.size + audioEngine.channelPhasers.size + audioEngine.channelFlangers.size + audioEngine.channelReverbs.size : 0,
      audioContextState: audioEngine?.ctx?.state || "uninitialized",
      visibilityState: document.visibilityState,
      visualMode: getVisualMode(),
      visuals: getVisualDiagnostics(),
      clock: {
        lastJumpMs: this.lastClockJumpMs,
        lastJumpPerformance: this.lastClockJumpPerformance,
        lastLongTaskDuration: this.lastLongTaskDuration,
        lastLongTaskPerformance: this.lastLongTaskPerformance,
        outputTimestamp: {
          currentTime: this.outputTimestampCurrentTime,
          contextTime: this.outputTimestampContextTime,
          performanceTime: this.outputTimestampPerformanceTime,
          now: this.outputTimestampNow,
          baseLatency: this.outputTimestampBaseLatency,
          outputLatency: this.outputTimestampOutputLatency,
        },
      },
      scheduling: this.totals ? {
        past: this.totals.scheduledPast,
        inHorizon: this.totals.scheduledInHorizon,
        tooFar: this.totals.scheduledTooFar,
      } : null,
      lastControl: this.lastControl,
      lastAudioState: { state: this.lastAudioState, reason: this.lastAudioStateReason || "initial", at: this.lastAudioStatePerformance },
    };
  }
}

const diagnostics = new PerformanceDiagnostics();

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.masterInput = null;
    this.masterGain = null;
    this.masterLimiter = null;
    this.masterLimiterDry = null;
    this.masterLimiterWet = null;
    this.masterCeiling = null;
    this.masterPostLimiter = null;
    this.masterEqDry = null;
    this.masterEqWet = null;
    this.masterEq = null;
    this.mixBus = null;
    this.channels = {};
    this.noiseBuffer = null;
    this.analyser = null;
    this.effects = {};
    this.channelDelays = new Map();
    this.channelChoruses = new Map();
    this.channelPhasers = new Map();
    this.channelFlangers = new Map();
    this.channelReverbs = new Map();
    this.driveCache = new Map();
    this.smoothParams = new WeakMap();
    this.diagnosticTaps = null;
    this.bassVoices = new Set();
    this.junoVoices = new Set();
    this.junoUnit = null;
    this.junoPulseCurve = null;
    this.junoPreviewRequests = new Map();
    this.junoHeldVoices = new Map();
    this.junoArpVoicePool = [];
    this.junoArpPoolIndex = 0;
    this.junoInputNotes = new Map();
    this.junoLatchedNotes = new Map();
    this.junoInputOrder = 0;
    this.junoArpAwaitingChord = true;
    this.autoCutoff = null;
    this.drumVoices = new Set();
    this.bassPreviewRequest = 0;
    this.drumPreviewRequests = {};
  }

  async init() {
    if (this.ctx) {
      if (this.ctx.state === "suspended") {
        try {
          await resumeAudioContext(this, "resume");
        } catch (error) {
          diagnostics.recordAudioState(this, "resume-rejected");
          throw error;
        }
      }
      return;
    }

    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) throw new Error("Este navegador no dispone de Web Audio.");

    try {
      this.ctx = new Context({ latencyHint: "interactive" });
    } catch {
      this.ctx = new Context();
    }
    if (diagnosticsPanelRequested()) installDiagnosticContextListeners(this);
    this.masterInput = this.ctx.createGain();
    this.masterLimiter = this.ctx.createDynamicsCompressor();
    this.masterLimiterDry = this.ctx.createGain();
    this.masterLimiterWet = this.ctx.createGain();
    this.masterCeiling = this.ctx.createGain();
    this.masterPostLimiter = this.ctx.createGain();
    this.masterEqDry = this.ctx.createGain();
    this.masterEqWet = this.ctx.createGain();
    const masterHighPass = this.ctx.createBiquadFilter();
    const masterLowShelf = this.ctx.createBiquadFilter();
    const masterHighShelf = this.ctx.createBiquadFilter();
    const masterLowPass = this.ctx.createBiquadFilter();
    this.masterGain = this.ctx.createGain();

    this.masterLimiter.knee.value = 0;
    this.masterLimiter.ratio.value = 20;
    this.masterLimiter.threshold.value = state.masterProcessor.limiterThreshold;
    this.masterLimiter.attack.value = state.masterProcessor.limiterAttack;
    this.masterLimiter.release.value = state.masterProcessor.limiterRelease;
    this.masterLimiterDry.gain.value = state.masterProcessor.limiterEnabled ? 0 : 1;
    this.masterLimiterWet.gain.value = state.masterProcessor.limiterEnabled ? 1 : 0;
    this.masterCeiling.gain.value = dbToGain(state.masterProcessor.limiterCeiling - state.masterProcessor.limiterThreshold);
    this.masterEqDry.gain.value = state.masterProcessor.eqEnabled ? 0 : 1;
    this.masterEqWet.gain.value = state.masterProcessor.eqEnabled ? 1 : 0;
    this.masterGain.gain.value = state.master;
    masterHighPass.type = "highpass";
    masterHighPass.Q.value = NON_RESONANT_Q_DB;
    masterLowShelf.type = "lowshelf";
    masterHighShelf.type = "highshelf";
    masterLowPass.type = "lowpass";
    masterLowPass.Q.value = NON_RESONANT_Q_DB;
    masterHighPass.frequency.value = state.masterProcessor.highPassFreq;
    masterLowShelf.frequency.value = state.masterProcessor.lowShelfFreq;
    masterLowShelf.gain.value = state.masterProcessor.lowShelfGain;
    masterHighShelf.frequency.value = state.masterProcessor.highShelfFreq;
    masterHighShelf.gain.value = state.masterProcessor.highShelfGain;
    masterLowPass.frequency.value = state.masterProcessor.lowPassFreq;
    this.masterEq = { highPass: masterHighPass, lowShelf: masterLowShelf, highShelf: masterHighShelf, lowPass: masterLowPass };

    this.masterInput.connect(this.masterLimiterDry);
    this.masterLimiterDry.connect(this.masterPostLimiter);
    this.masterInput.connect(this.masterLimiter);
    this.masterLimiter.connect(this.masterCeiling);
    this.masterCeiling.connect(this.masterLimiterWet);
    this.masterLimiterWet.connect(this.masterPostLimiter);

    this.masterPostLimiter.connect(this.masterEqDry);
    this.masterEqDry.connect(this.masterGain);
    this.masterPostLimiter.connect(masterHighPass);
    masterHighPass.connect(masterLowShelf);
    masterLowShelf.connect(masterHighShelf);
    masterHighShelf.connect(masterLowPass);
    masterLowPass.connect(this.masterEqWet);
    this.masterEqWet.connect(this.masterGain);

    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.76;

    this.masterGain.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);

    this.mixBus = this.ctx.createGain();
    const dryGain = this.ctx.createGain();
    dryGain.gain.value = 0.93;
    this.mixBus.connect(dryGain);
    dryGain.connect(this.masterInput);

    CHANNELS.forEach(({ id }) => {
      const input = this.ctx.createGain();
      const highPass = this.ctx.createBiquadFilter();
      const lowShelf = this.ctx.createBiquadFilter();
      const highShelf = this.ctx.createBiquadFilter();
      const lowPass = this.ctx.createBiquadFilter();
      const peakDrive = this.ctx.createGain();
      const compressor = this.ctx.createDynamicsCompressor();
      const peakTrim = this.ctx.createGain();
      const makeup = this.ctx.createGain();
      const level = this.ctx.createGain();
      const panner = typeof this.ctx.createStereoPanner === "function" ? this.ctx.createStereoPanner() : this.ctx.createGain();

      highPass.type = "highpass";
      highPass.Q.value = 0.707;
      lowShelf.type = "lowshelf";
      highShelf.type = "highshelf";
      lowPass.type = "lowpass";
      lowPass.Q.value = 0.707;
      compressor.threshold.value = -18;
      compressor.ratio.value = 4;
      compressor.knee.value = 12;
      compressor.attack.value = 0.01;
      compressor.release.value = 0.52;

      input.connect(highPass);
      highPass.connect(lowShelf);
      lowShelf.connect(highShelf);
      highShelf.connect(lowPass);
      lowPass.connect(peakDrive);
      peakDrive.connect(compressor);
      compressor.connect(peakTrim);
      peakTrim.connect(makeup);
      makeup.connect(level);
      level.connect(panner);
      panner.connect(this.mixBus);
      this.channels[id] = {
        input,
        highPass,
        lowShelf,
        highShelf,
        lowPass,
        peakDrive,
        compressor,
        peakTrim,
        makeup,
        gain: level,
        panner,
      };
    });

    this.noiseBuffer = this.createNoiseBuffer(2);
    this.setupEffects();
    this.updateAllChannels();
    this.updateAllProcessors();
    this.updateMaster();
    this.updateMasterProcessor();
    this.updateAllEffectSends();

    if (this.ctx.state === "suspended") await resumeAudioContext(this, "init-resume");
  }

  createDiagnosticTaps() {
    if (!diagnostics.enabled || !this.ctx || this.diagnosticTaps) return this.diagnosticTaps;
    const createTap = (source) => {
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0;
      source.connect(analyser);
      return { source, analyser, byteData: new Uint8Array(analyser.fftSize), floatData: null };
    };
    this.diagnosticTaps = {
      drums: ["kick", "snare", "clap", "closedHat", "openHat"].map((id) => createTap(this.channels[id].input)),
      bass: createTap(this.channels.bass.input),
      juno: createTap(this.channels.juno.input),
      masterPre: createTap(this.masterInput),
      masterOut: { analyser: this.analyser, byteData: new Uint8Array(this.analyser.fftSize), floatData: null },
    };
    return this.diagnosticTaps;
  }

  captureDiagnosticSignal() {
    const taps = this.createDiagnosticTaps();
    if (!taps) return null;
    const sample = (tap) => {
      const analyser = tap.analyser;
      const size = analyser.fftSize;
      let sum = 0; let peak = 0; let finite = true;
      if (typeof analyser.getFloatTimeDomainData === "function") {
        if (!(tap.floatData instanceof Float32Array) || tap.floatData.length !== size) tap.floatData = new Float32Array(size);
        analyser.getFloatTimeDomainData(tap.floatData);
        for (let index = 0; index < size; index += 1) {
          const value = tap.floatData[index];
          if (!Number.isFinite(value)) finite = false;
          const magnitude = Math.abs(value);
          sum += value * value;
          if (magnitude > peak) peak = magnitude;
        }
      } else {
        if (!(tap.byteData instanceof Uint8Array) || tap.byteData.length !== size) tap.byteData = new Uint8Array(size);
        analyser.getByteTimeDomainData(tap.byteData);
        for (let index = 0; index < size; index += 1) {
          const value = (tap.byteData[index] - 128) / 128;
          const magnitude = Math.abs(value);
          sum += value * value;
          if (magnitude > peak) peak = magnitude;
        }
      }
      return { rms: Math.sqrt(sum / size), peak, finite };
    };
    const combine = (signals) => ({
      rms: Math.sqrt(signals.reduce((sum, signal) => sum + signal.rms ** 2, 0)),
      peak: signals.reduce((peak, signal) => Math.max(peak, signal.peak), 0),
      finite: signals.every((signal) => signal.finite),
    });
    return {
      drums: combine(taps.drums.map(sample)), bass: sample(taps.bass), juno: sample(taps.juno),
      masterPre: sample(taps.masterPre), masterOut: sample(taps.masterOut),
    };
  }

  disposeDiagnosticTaps() {
    if (!this.diagnosticTaps) return;
    const taps = [...this.diagnosticTaps.drums, this.diagnosticTaps.bass, this.diagnosticTaps.juno, this.diagnosticTaps.masterPre];
    taps.forEach((tap) => {
      try { tap.source.disconnect(tap.analyser); } catch { /* already detached */ }
      tap.analyser.disconnect();
    });
    this.diagnosticTaps = null;
  }

  autoCutoffFrequency() {
    const cycles = AUTO_CUTOFF_DIVISION_CYCLES[state.synth.autoCutoffDivision] || 0.5;
    return state.bpm / 60 * cycles;
  }

  autoCutoffRange() {
    const synth = state.synth;
    const headroom = Math.max(0, 18000 - synth.cutoff - synth.envAmount * 1.28);
    return Math.min(6000, headroom) * synth.autoCutoffAmount;
  }

  createAutoCutoff(startTime = null) {
    if (!this.ctx || !state.synth.autoCutoffEnabled) return null;
    if (this.autoCutoff) {
      if (this.autoCutoff.cleanupTimer !== null) window.clearTimeout(this.autoCutoff.cleanupTimer);
      this.autoCutoff.cleanupTimer = null;
      const halfRange = this.autoCutoffRange() / 2;
      this.setSmooth(this.autoCutoff.lfo.frequency, this.autoCutoffFrequency(), 0.035);
      this.setSmooth(this.autoCutoff.depth.gain, halfRange, 0.035);
      this.setSmooth(this.autoCutoff.offset.offset, halfRange, 0.035);
      return this.autoCutoff;
    }
    const lfo = this.ctx.createOscillator();
    const depth = this.ctx.createGain();
    const offset = this.ctx.createConstantSource();
    const halfRange = this.autoCutoffRange() / 2;
    lfo.type = "sine";
    lfo.frequency.value = this.autoCutoffFrequency();
    depth.gain.value = 0;
    offset.offset.value = 0;
    lfo.connect(depth);
    const phaseStart = Math.max(this.ctx.currentTime, startTime ?? this.ctx.currentTime);
    lfo.start(phaseStart);
    offset.start(phaseStart);
    this.autoCutoff = { lfo, depth, offset, filters: new Set(), cleanupTimer: null, sourcesStopped: false };
    this.setSmooth(depth.gain, halfRange, 0.035);
    this.setSmooth(offset.offset, halfRange, 0.035);
    return this.autoCutoff;
  }

  updateAutoCutoff(startTime = null) {
    if (!this.ctx) return;
    if (!state.synth.autoCutoffEnabled) {
      this.scheduleAutoCutoffDisposal();
      return;
    }
    const unit = this.autoCutoff || (state.playing || startTime !== null ? this.createAutoCutoff(startTime) : null);
    if (!unit) return;
    if (unit.cleanupTimer !== null) window.clearTimeout(unit.cleanupTimer);
    unit.cleanupTimer = null;
    const halfRange = this.autoCutoffRange() / 2;
    this.setSmooth(unit.lfo.frequency, this.autoCutoffFrequency(), 0.035);
    this.setSmooth(unit.depth.gain, halfRange, 0.035);
    this.setSmooth(unit.offset.offset, halfRange, 0.035);
    this.bassVoices.forEach((voice) => this.attachAutoCutoff(voice.filters));
  }

  attachAutoCutoff(filters, startTime) {
    const unit = this.createAutoCutoff(startTime);
    if (!unit) return;
    filters.forEach((filter) => {
      if (unit.filters.has(filter)) return;
      unit.depth.connect(filter.frequency);
      unit.offset.connect(filter.frequency);
      unit.filters.add(filter);
    });
  }

  detachAutoCutoff(filters) {
    const unit = this.autoCutoff;
    if (!unit) return;
    filters.forEach((filter) => {
      try { unit.depth.disconnect(filter.frequency); } catch { /* already detached */ }
      try { unit.offset.disconnect(filter.frequency); } catch { /* already detached */ }
      unit.filters.delete(filter);
    });
    if (!state.playing && unit.filters.size === 0) this.scheduleAutoCutoffDisposal();
  }

  scheduleAutoCutoffDisposal() {
    const unit = this.autoCutoff;
    if (!unit || unit.cleanupTimer !== null) return;
    this.setSmooth(unit.depth.gain, 0, 0.018);
    this.setSmooth(unit.offset.offset, 0, 0.018);
    unit.cleanupTimer = window.setTimeout(() => {
      unit.cleanupTimer = null;
      if (!state.synth.autoCutoffEnabled || (!state.playing && unit.filters.size === 0)) this.disposeAutoCutoff();
    }, 80);
  }

  disposeAutoCutoff() {
    const unit = this.autoCutoff;
    if (!unit) return;
    if (unit.cleanupTimer !== null) window.clearTimeout(unit.cleanupTimer);
    unit.filters.forEach((filter) => {
      try { unit.depth.disconnect(filter.frequency); } catch { /* already detached */ }
      try { unit.offset.disconnect(filter.frequency); } catch { /* already detached */ }
    });
    unit.filters.clear();
    if (!unit.sourcesStopped) {
      unit.lfo.stop(this.ctx?.currentTime || 0);
      unit.offset.stop(this.ctx?.currentTime || 0);
      unit.sourcesStopped = true;
    }
    unit.lfo.disconnect();
    unit.depth.disconnect();
    unit.offset.disconnect();
    this.autoCutoff = null;
  }

  createJunoPulseCurve() {
    if (this.junoPulseCurve) return this.junoPulseCurve;
    const curve = new Float32Array(512);
    for (let index = 0; index < curve.length; index += 1) curve[index] = index < curve.length / 2 ? -1 : 1;
    this.junoPulseCurve = curve;
    return curve;
  }

  createJunoUnipolarLfoCurve() {
    if (this.junoUnipolarLfoCurve) return this.junoUnipolarLfoCurve;
    const curve = new Float32Array(257);
    for (let index = 0; index < curve.length; index += 1) curve[index] = index / (curve.length - 1);
    this.junoUnipolarLfoCurve = curve;
    return curve;
  }

  createJunoUnit() {
    if (!this.ctx || !this.channels.juno) return null;
    if (this.junoUnit) {
      if (this.junoUnit.cleanupTimer !== null) window.clearTimeout(this.junoUnit.cleanupTimer);
      this.junoUnit.cleanupTimer = null;
      return this.junoUnit;
    }
    const input = this.ctx.createGain();
    const dry = this.ctx.createGain();
    const wet = this.ctx.createGain();
    const delayLeft = this.ctx.createDelay(0.05);
    const delayRight = this.ctx.createDelay(0.05);
    const pannerLeft = typeof this.ctx.createStereoPanner === "function" ? this.ctx.createStereoPanner() : this.ctx.createGain();
    const pannerRight = typeof this.ctx.createStereoPanner === "function" ? this.ctx.createStereoPanner() : this.ctx.createGain();
    const chorusLfo = this.ctx.createOscillator();
    const chorusDepthLeft = this.ctx.createGain();
    const chorusDepthRight = this.ctx.createGain();
    const lfo = this.ctx.createOscillator();
    const pitchDepth = this.ctx.createGain();
    const filterLfoShape = this.ctx.createWaveShaper();
    const filterDepth = this.ctx.createGain();
    const pwmDepth = this.ctx.createGain();
    const settings = getJunoUnitSettings(state.juno);

    chorusLfo.type = "sine";
    chorusLfo.frequency.value = settings.chorusRate;
    chorusDepthLeft.gain.value = settings.chorusDepth;
    chorusDepthRight.gain.value = -settings.chorusDepth;
    dry.gain.value = settings.dry;
    wet.gain.value = settings.wet;
    lfo.type = "triangle";
    lfo.frequency.value = settings.lfoRate;
    pitchDepth.gain.value = settings.pitchDepth;
    filterLfoShape.curve = this.createJunoUnipolarLfoCurve();
    filterDepth.gain.value = settings.filterDepth;
    pwmDepth.gain.value = settings.pwmDepth;
    delayLeft.delayTime.value = 0.017;
    delayRight.delayTime.value = 0.023;
    if (pannerLeft.pan) pannerLeft.pan.value = -0.82;
    if (pannerRight.pan) pannerRight.pan.value = 0.82;

    input.connect(dry);
    dry.connect(this.channels.juno.input);
    input.connect(delayLeft);
    input.connect(delayRight);
    delayLeft.connect(pannerLeft);
    delayRight.connect(pannerRight);
    pannerLeft.connect(wet);
    pannerRight.connect(wet);
    wet.connect(this.channels.juno.input);
    chorusLfo.connect(chorusDepthLeft);
    chorusLfo.connect(chorusDepthRight);
    chorusDepthLeft.connect(delayLeft.delayTime);
    chorusDepthRight.connect(delayRight.delayTime);
    lfo.connect(pitchDepth);
    lfo.connect(filterLfoShape);
    filterLfoShape.connect(filterDepth);
    lfo.connect(pwmDepth);
    chorusLfo.start();
    lfo.start();

    this.junoUnit = {
      input, dry, wet, delayLeft, delayRight, pannerLeft, pannerRight,
      chorusLfo, chorusDepthLeft, chorusDepthRight,
      lfo, pitchDepth, filterLfoShape, filterDepth, pwmDepth,
      cleanupTimer: null, sourcesStopped: false,
    };
    return this.junoUnit;
  }

  updateJunoUnit(controlName = null) {
    const unit = this.junoUnit;
    if (!unit || !this.ctx) return;
    const settings = getJunoUnitSettings(state.juno);
    if (!controlName || controlName === "chorusMode") {
      this.setSmooth(unit.chorusLfo.frequency, settings.chorusRate, 0.04);
      this.setSmooth(unit.chorusDepthLeft.gain, settings.chorusDepth, 0.04);
      this.setSmooth(unit.chorusDepthRight.gain, -settings.chorusDepth, 0.04);
      this.setSmooth(unit.wet.gain, settings.wet, 0.035);
      this.setSmooth(unit.dry.gain, settings.dry, 0.035);
    }
    if (!controlName || controlName === "lfoRate") this.setSmooth(unit.lfo.frequency, settings.lfoRate, 0.035);
    if (!controlName || controlName === "lfoPitch") this.setSmooth(unit.pitchDepth.gain, settings.pitchDepth, 0.035);
    if (!controlName || controlName === "lfoFilter") this.setSmooth(unit.filterDepth.gain, settings.filterDepth, 0.035);
    if (!controlName || controlName === "pwmAmount") this.setSmooth(unit.pwmDepth.gain, settings.pwmDepth, 0.035);
  }

  updateJunoVoices(controlName = null) {
    if (!this.ctx) return;
    const synth = state.juno;
    const maxFrequency = this.ctx.sampleRate * 0.45;
    if (!controlName || ["chorusMode", "lfoRate", "lfoPitch", "lfoFilter", "pwmAmount"].includes(controlName)) {
      this.updateJunoUnit(controlName);
    }
    this.junoVoices.forEach((voice) => {
      if (!controlName || controlName === "saw") this.setSmooth(voice.sawGain.gain, synth.saw ? 0.34 : 0, 0.025);
      if (!controlName || controlName === "pulse") this.setSmooth(voice.pulseGain.gain, synth.pulse ? 0.27 : 0, 0.025);
      if (!controlName || controlName === "sub") this.setSmooth(voice.subGain.gain, synth.sub * 0.24, 0.025);
      if (!controlName || controlName === "pulseWidth") this.setSmooth(voice.pulseBias.offset, (synth.pulseWidth - 0.5) * 1.55, 0.025);
      if (!controlName || controlName === "highPass") this.setSmooth(voice.highPass.frequency, clamp(synth.highPass, 20, maxFrequency));
      if (!controlName || controlName === "resonance") {
        this.setSmooth(voice.filterA.Q, synth.resonance * 0.72);
        this.setSmooth(voice.filterB.Q, synth.resonance * 0.34);
      }
      if (["cutoff", "envAmount"].includes(controlName) && voice.releasedAt === Infinity) {
        this.rebaseJunoFilterEnvelope(voice, maxFrequency);
      }
    });
  }

  junoEnvelopeLevelAt(voice, time) {
    const elapsed = Math.max(0, time - voice.startAt);
    if (elapsed < voice.attack) return voice.peak * elapsed / voice.attack;
    if (elapsed < voice.attack + voice.decay) {
      const progress = (elapsed - voice.attack) / voice.decay;
      return voice.peak * (voice.sustain / voice.peak) ** progress;
    }
    return voice.sustain;
  }

  junoFilterEnvelopeValueAt(voice, time) {
    const envelope = voice.filterEnvelope;
    if (!envelope) return voice.baseCutoff;
    let value = envelope.value;
    for (const segment of envelope.segments) {
      if (time <= segment.start) return value;
      if (time < segment.end) {
        const progress = (time - segment.start) / (segment.end - segment.start);
        return segment.type === "linear"
          ? segment.from + (segment.to - segment.from) * progress
          : segment.from * (segment.to / segment.from) ** progress;
      }
      value = segment.to;
    }
    return value;
  }

  scheduleJunoAmpEnvelope(voice, startAt, noteOff = Infinity, release = state.juno.release) {
    const { attack, decay, peak, sustain } = voice;
    const finiteNote = Number.isFinite(noteOff);
    const attackEnd = startAt + attack;
    const decayEnd = attackEnd + decay;
    const param = voice.amp.gain;
    param.cancelScheduledValues(startAt);
    param.setValueAtTime(0, startAt);
    if (!finiteNote || noteOff > attackEnd) {
      param.linearRampToValueAtTime(peak, attackEnd);
      if (!finiteNote || noteOff > decayEnd) param.exponentialRampToValueAtTime(sustain, decayEnd);
      else param.exponentialRampToValueAtTime(this.junoEnvelopeLevelAt(voice, noteOff), noteOff);
    } else {
      param.linearRampToValueAtTime(this.junoEnvelopeLevelAt(voice, noteOff), noteOff);
    }
    if (!finiteNote) return;
    const releaseLevel = Math.max(JUNO_GAIN_FLOOR, this.junoEnvelopeLevelAt(voice, noteOff));
    param.setValueAtTime(releaseLevel, noteOff);
    if (release > 0) param.exponentialRampToValueAtTime(JUNO_GAIN_FLOOR, noteOff + release);
  }

  scheduleJunoFilterEnvelope(voice, startAt, noteOff = Infinity, release = state.juno.release) {
    const finiteNote = Number.isFinite(noteOff);
    const attackEnd = startAt + voice.attack;
    const decayEnd = attackEnd + voice.decay;
    const envelope = { value: voice.baseCutoff, segments: [] };
    let current = voice.baseCutoff;
    const add = (type, start, end, value) => {
      if (end <= start) return;
      envelope.segments.push({ type, start, end, from: current, to: value });
      current = value;
    };

    if (!finiteNote || noteOff > attackEnd) {
      add("linear", startAt, attackEnd, voice.peakCutoff);
      if (!finiteNote || noteOff > decayEnd) add("exponential", attackEnd, decayEnd, voice.filterSustainCutoff);
      else {
        const progress = (noteOff - attackEnd) / voice.decay;
        add("exponential", attackEnd, noteOff,
          voice.peakCutoff * (voice.filterSustainCutoff / voice.peakCutoff) ** progress);
      }
    } else {
      const progress = (noteOff - startAt) / voice.attack;
      add("linear", startAt, noteOff, voice.baseCutoff + (voice.peakCutoff - voice.baseCutoff) * progress);
    }
    if (finiteNote && release > 0) add("exponential", noteOff, noteOff + release, voice.baseCutoff);

    [voice.filterA, voice.filterB].forEach((filter) => {
      filter.frequency.cancelScheduledValues(startAt);
      filter.frequency.setValueAtTime(voice.baseCutoff, startAt);
      envelope.segments.forEach((segment) => {
        if (segment.type === "linear") filter.frequency.linearRampToValueAtTime(segment.to, segment.end);
        else filter.frequency.exponentialRampToValueAtTime(segment.to, segment.end);
      });
    });
    voice.filterEnvelope = envelope;
  }

  rebaseJunoFilterEnvelope(voice, maxFrequency) {
    if (!this.ctx || voice.releasedAt !== Infinity) return;
    const now = this.ctx.currentTime;
    const current = this.junoFilterEnvelopeValueAt(voice, now);
    const synth = state.juno;
    const baseCutoff = clamp(synth.cutoff, JUNO_FILTER_FLOOR, Math.min(16000, maxFrequency));
    const peakCutoff = clamp(baseCutoff + synth.envAmount * voice.filterAccent, JUNO_FILTER_FLOOR, Math.min(18000, maxFrequency));
    const sustainCutoff = clamp(baseCutoff + (peakCutoff - baseCutoff) * voice.filterSustain, JUNO_FILTER_FLOOR, Math.min(18000, maxFrequency));
    const attackEnd = voice.startAt + voice.attack;
    const decayEnd = attackEnd + voice.decay;
    const envelope = { value: current, segments: [] };
    let value = current;
    const add = (type, start, end, target) => {
      if (end <= start) return;
      envelope.segments.push({ type, start, end, from: value, to: target });
      value = target;
    };
    if (now < attackEnd) {
      add("linear", now, attackEnd, peakCutoff);
      add("exponential", attackEnd, decayEnd, sustainCutoff);
    } else if (now < decayEnd) {
      add("exponential", now, decayEnd, sustainCutoff);
    } else {
      add("linear", now, now + 0.025, sustainCutoff);
    }
    [voice.filterA, voice.filterB].forEach((filter) => {
      filter.frequency.cancelScheduledValues(now);
      filter.frequency.setValueAtTime(current, now);
      envelope.segments.forEach((segment) => {
        if (segment.type === "linear") filter.frequency.linearRampToValueAtTime(segment.to, segment.end);
        else filter.frequency.exponentialRampToValueAtTime(segment.to, segment.end);
      });
    });
    Object.assign(voice, { baseCutoff, peakCutoff, filterSustainCutoff: sustainCutoff, filterEnvelope: envelope });
  }

  startJunoVoice(midi, time, accent = false, origin = "live", silent = false) {
    if (!this.ctx) return null;
    const unit = this.createJunoUnit();
    const synth = state.juno;
    const startAt = Math.max(time, this.ctx.currentTime);
    const availableVoices = [...this.junoVoices]
      .filter((voice) => !voice.retiring && voice.origin !== "arp-pool");
    const reusable = availableVoices
      .filter((voice) => voice.releasedAt <= startAt)
      .sort((a, b) => a.releasedAt - b.releasedAt || a.startAt - b.startAt)[0];
    const oldest = availableVoices.sort((a, b) => a.startAt - b.startAt)[0];
    if (origin !== "arp-pool" && availableVoices.length >= JUNO_POLYPHONY) {
      this.retireJunoVoice(reusable || oldest, startAt);
    }

    const octaveMultiplier = synth.octave === 16 ? 0.5 : synth.octave === 4 ? 2 : 1;
    const frequency = midiToFrequency(midi) * octaveMultiplier;
    const detune = synth.fineTune;
    const saw = this.ctx.createOscillator();
    const pulseRamp = this.ctx.createOscillator();
    const pulseBias = this.ctx.createConstantSource();
    const sub = this.ctx.createOscillator();
    const sawGain = this.ctx.createGain();
    const pulseShaper = this.ctx.createWaveShaper();
    const pulseGain = this.ctx.createGain();
    const subGain = this.ctx.createGain();
    const mix = this.ctx.createGain();
    const dcBlocker = this.ctx.createBiquadFilter();
    const highPass = this.ctx.createBiquadFilter();
    const filterA = this.ctx.createBiquadFilter();
    const filterB = this.ctx.createBiquadFilter();
    const amp = this.ctx.createGain();
    const fade = this.ctx.createGain();

    saw.type = "sawtooth";
    pulseRamp.type = "sawtooth";
    sub.type = "square";
    [saw, pulseRamp].forEach((oscillator) => {
      oscillator.frequency.value = frequency;
      oscillator.detune.value = detune;
      unit.pitchDepth.connect(oscillator.detune);
    });
    sub.frequency.value = frequency / 2;
    sub.detune.value = detune;
    unit.pitchDepth.connect(sub.detune);
    sawGain.gain.value = synth.saw ? 0.34 : 0;
    pulseGain.gain.value = synth.pulse ? 0.27 : 0;
    subGain.gain.value = synth.sub * 0.24;
    mix.gain.value = 0.48;
    pulseBias.offset.value = (synth.pulseWidth - 0.5) * 1.55;
    pulseShaper.curve = this.createJunoPulseCurve();
    pulseShaper.oversample = "2x";
    unit.pwmDepth.connect(pulseShaper);
    dcBlocker.type = "highpass";
    dcBlocker.Q.value = NON_RESONANT_Q_DB;
    dcBlocker.frequency.value = 20;
    highPass.type = "highpass";
    highPass.Q.value = NON_RESONANT_Q_DB;
    highPass.frequency.value = synth.highPass;
    filterA.type = "lowpass";
    filterB.type = "lowpass";
    filterA.Q.value = synth.resonance * 0.72;
    filterB.Q.value = synth.resonance * 0.34;
    unit.filterDepth.connect(filterA.frequency);
    unit.filterDepth.connect(filterB.frequency);

    const attack = Math.max(0.003, synth.attack);
    const decay = Math.max(0.025, synth.decay);
    const peak = accent ? 0.78 : 0.62;
    const sustain = Math.max(JUNO_GAIN_FLOOR, peak * synth.sustain);
    const baseCutoff = clamp(synth.cutoff, JUNO_FILTER_FLOOR, 16000);
    const filterAccent = accent ? 1.16 : 1;
    const peakCutoff = clamp(baseCutoff + synth.envAmount * filterAccent, JUNO_FILTER_FLOOR, 18000);
    const filterSustainCutoff = clamp(baseCutoff + (peakCutoff - baseCutoff) * synth.sustain, JUNO_FILTER_FLOOR, 18000);

    const voice = {
      midi, origin, startAt, attack, decay, peak, sustain, baseCutoff, peakCutoff, filterSustainCutoff, filterAccent, filterSustain: synth.sustain,
      releasedAt: silent ? startAt : Infinity, stopAt: Infinity, retiring: false,
      arpActiveUntil: 0, filterEnvelope: null,
      saw, pulseRamp, pulseBias, sub, sawGain, pulseShaper, pulseGain, subGain,
      mix, dcBlocker, highPass, filterA, filterB, amp, fade,
    };
    if (silent) {
      amp.gain.value = 0;
      amp.gain.setValueAtTime(0, startAt);
      filterA.frequency.setValueAtTime(baseCutoff, startAt);
      filterB.frequency.setValueAtTime(baseCutoff, startAt);
      voice.filterEnvelope = { value: baseCutoff, segments: [] };
    } else {
      this.scheduleJunoAmpEnvelope(voice, startAt);
      this.scheduleJunoFilterEnvelope(voice, startAt);
    }

    saw.connect(sawGain);
    sawGain.connect(mix);
    pulseRamp.connect(pulseShaper);
    pulseBias.connect(pulseShaper);
    pulseShaper.connect(pulseGain);
    pulseGain.connect(mix);
    sub.connect(subGain);
    subGain.connect(mix);
    mix.connect(dcBlocker);
    dcBlocker.connect(highPass);
    highPass.connect(filterA);
    filterA.connect(filterB);
    filterB.connect(amp);
    amp.connect(fade);
    fade.connect(unit.input);

    this.junoVoices.add(voice);
    diagnostics.voiceCreatedFor("juno");
    renderJunoVoiceLeds();
    let ended = 0;
    const cleanup = () => {
      ended += 1;
      if (ended !== 3) return;
      [saw, pulseRamp, sub].forEach((source) => { source.onended = null; });
      try { unit.pitchDepth.disconnect(saw.detune); } catch { /* detached */ }
      try { unit.pitchDepth.disconnect(pulseRamp.detune); } catch { /* detached */ }
      try { unit.pitchDepth.disconnect(sub.detune); } catch { /* detached */ }
      try { unit.filterDepth.disconnect(filterA.frequency); } catch { /* detached */ }
      try { unit.filterDepth.disconnect(filterB.frequency); } catch { /* detached */ }
      try { unit.pwmDepth.disconnect(pulseShaper); } catch { /* detached */ }
      [saw, pulseRamp, pulseBias, sub, sawGain, pulseShaper, pulseGain, subGain,
        mix, dcBlocker, highPass, filterA, filterB, amp, fade].forEach((node) => node.disconnect());
      this.junoVoices.delete(voice);
      diagnostics.voiceCleanedFor("juno");
      this.junoArpVoicePool = this.junoArpVoicePool.filter((pooled) => pooled !== voice);
      this.junoArpPoolIndex %= Math.max(1, this.junoArpVoicePool.length);
      this.junoHeldVoices.forEach((held, key) => { if (held === voice) this.junoHeldVoices.delete(key); });
      if (this.junoVoices.size === 0 && !state.playing) this.scheduleJunoUnitDisposal();
      renderJunoVoiceLeds();
    };
    saw.onended = cleanup;
    pulseRamp.onended = cleanup;
    sub.onended = cleanup;
    saw.start(startAt);
    pulseRamp.start(startAt);
    pulseBias.start(startAt);
    sub.start(startAt);
    return voice;
  }

  releaseJunoVoice(voice, time = this.ctx?.currentTime || 0) {
    if (!voice || voice.releasedAt !== Infinity || !this.ctx) return;
    const releaseAt = Math.max(time, this.ctx.currentTime);
    const release = Math.max(0.03, state.juno.release);
    const stopAt = releaseAt + release + 0.018;
    const level = Math.max(JUNO_GAIN_FLOOR, this.junoEnvelopeLevelAt(voice, releaseAt));
    voice.amp.gain.cancelScheduledValues(releaseAt);
    voice.amp.gain.setValueAtTime(level, releaseAt);
    voice.amp.gain.exponentialRampToValueAtTime(JUNO_GAIN_FLOOR, releaseAt + release);
    voice.amp.gain.linearRampToValueAtTime(0, stopAt - 0.006);
    const cutoff = this.junoFilterEnvelopeValueAt(voice, releaseAt);
    const filterEnvelope = {
      value: cutoff,
      segments: [{ type: "exponential", start: releaseAt, end: releaseAt + release, from: cutoff, to: voice.baseCutoff }],
    };
    [voice.filterA, voice.filterB].forEach((filter) => {
      filter.frequency.cancelScheduledValues(releaseAt);
      filter.frequency.setValueAtTime(cutoff, releaseAt);
      filter.frequency.exponentialRampToValueAtTime(voice.baseCutoff, releaseAt + release);
    });
    voice.filterEnvelope = filterEnvelope;
    voice.releasedAt = releaseAt;
    voice.stopAt = stopAt;
    [voice.saw, voice.pulseRamp, voice.pulseBias, voice.sub].forEach((source) => source.stop(stopAt));
    renderJunoVoiceLeds();
  }

  retireJunoVoice(voice, time) {
    if (!voice || voice.retiring || !this.ctx) return;
    const fadeAt = Math.max(time, this.ctx.currentTime);
    const stopAt = fadeAt + JUNO_FADE_TIME + 0.004;
    voice.fade.gain.cancelScheduledValues(fadeAt);
    voice.fade.gain.setValueAtTime(1, fadeAt);
    voice.fade.gain.linearRampToValueAtTime(0, fadeAt + JUNO_FADE_TIME);
    voice.releasedAt = fadeAt;
    voice.retiring = true;
    voice.stopAt = Math.min(voice.stopAt, stopAt);
    [voice.saw, voice.pulseRamp, voice.pulseBias, voice.sub].forEach((source) => source.stop(voice.stopAt));
    renderJunoVoiceLeds();
  }

  scheduleJunoNote(midi, time, duration = 0.5, accent = false, origin = "sequence", arpStepDuration = duration) {
    if (origin === "arp") return this.scheduleJunoArpNote(midi, time, duration, accent, arpStepDuration);
    const voice = this.startJunoVoice(midi, time, accent, origin);
    if (voice) {
      this.releaseJunoVoice(voice, time + Math.max(0.05, duration));
      if (diagnostics.enabled) diagnostics.recordScheduledEvent(time, voice.stopAt, this);
    }
    return voice;
  }

  getJunoArpVoice(time) {
    this.junoArpVoicePool = this.junoArpVoicePool.filter((voice) => !voice.retiring && this.junoVoices.has(voice));
    if (this.junoArpVoicePool.length < JUNO_POLYPHONY) {
      const voice = this.startJunoVoice(60, time, false, "arp-pool", true);
      if (voice) this.junoArpVoicePool.push(voice);
      return voice;
    }
    const voice = this.junoArpVoicePool[this.junoArpPoolIndex % this.junoArpVoicePool.length];
    this.junoArpPoolIndex = (this.junoArpPoolIndex + 1) % this.junoArpVoicePool.length;
    return voice;
  }

  scheduleJunoArpNote(midi, time, duration, accent = false, stepDuration = duration) {
    if (!this.ctx) return null;
    const startAt = Math.max(time, this.ctx.currentTime);
    const voice = this.getJunoArpVoice(startAt);
    if (!voice) return null;
    const synth = state.juno;
    const octaveMultiplier = synth.octave === 16 ? 0.5 : synth.octave === 4 ? 2 : 1;
    const frequency = midiToFrequency(midi) * octaveMultiplier;
    const attack = Math.max(0.003, synth.attack);
    const decay = Math.max(0.025, synth.decay);
    const peak = accent ? 0.78 : 0.62;
    const sustain = Math.max(JUNO_GAIN_FLOOR, peak * synth.sustain);
    const baseCutoff = clamp(synth.cutoff, JUNO_FILTER_FLOOR, 16000);
    const peakCutoff = clamp(baseCutoff + synth.envAmount * (accent ? 1.16 : 1), JUNO_FILTER_FLOOR, 18000);
    const noteDuration = Number.isFinite(duration) ? Math.max(0.02, duration) : 0.02;
    const noteOff = startAt + noteDuration;
    const requestedRelease = Number.isFinite(synth.release) ? Math.max(0.03, synth.release) : 0.03;
    const validStepDuration = Number.isFinite(stepDuration) && stepDuration > 0 ? stepDuration : noteDuration;
    // A cold pool will be full before this voice comes around again. Once warm,
    // use its actual size, keeping the calculation tied to the fixed pool.
    const poolSizeAtReuse = this.junoArpVoicePool.length < JUNO_POLYPHONY
      ? JUNO_POLYPHONY
      : this.junoArpVoicePool.length;
    const arpReuseAt = startAt + validStepDuration * poolSizeAtReuse;
    const availableRelease = Math.max(0, arpReuseAt - noteOff - JUNO_ARP_RETRIGGER_MARGIN);
    const effectiveArpRelease = Math.min(requestedRelease, availableRelease);
    const fadeAt = Math.max(this.ctx.currentTime, startAt - JUNO_ARP_RETRIGGER_MARGIN);

    voice.fade.gain.cancelScheduledValues(fadeAt);
    voice.fade.gain.setValueAtTime(1, fadeAt);
    voice.fade.gain.linearRampToValueAtTime(0, startAt);
    voice.fade.gain.setValueAtTime(0, startAt);
    voice.fade.gain.linearRampToValueAtTime(1, startAt + 0.003);
    [voice.saw, voice.pulseRamp].forEach((oscillator) => {
      oscillator.frequency.setValueAtTime(frequency, startAt);
      oscillator.detune.setValueAtTime(synth.fineTune, startAt);
    });
    voice.sub.frequency.setValueAtTime(frequency / 2, startAt);
    voice.sub.detune.setValueAtTime(synth.fineTune, startAt);

    Object.assign(voice, {
      midi, startAt, attack, decay, peak, sustain, baseCutoff, peakCutoff,
      filterSustainCutoff: clamp(baseCutoff + (peakCutoff - baseCutoff) * synth.sustain, JUNO_FILTER_FLOOR, 18000),
      filterAccent: accent ? 1.16 : 1, filterSustain: synth.sustain,
      releasedAt: noteOff, arpActiveUntil: noteOff + effectiveArpRelease,
      effectiveArpRelease, arpAvailableRelease: availableRelease, arpReuseAt,
    });
    this.scheduleJunoAmpEnvelope(voice, startAt, noteOff, effectiveArpRelease);
    this.scheduleJunoFilterEnvelope(voice, startAt, noteOff, effectiveArpRelease);
    if (diagnostics.enabled) diagnostics.recordScheduledEvent(startAt, noteOff + effectiveArpRelease + 0.018, this);
    renderJunoVoiceLeds();
    return voice;
  }

  stopJunoArpVoices() {
    if (!this.ctx) return;
    [...this.junoVoices]
      .filter((voice) => voice.origin === "arp-pool")
      .forEach((voice) => this.retireJunoVoice(voice, this.ctx.currentTime));
    this.junoArpVoicePool = [];
    this.junoArpPoolIndex = 0;
  }

  stopJunoVoices(clearInput = true) {
    this.junoPreviewRequests.clear();
    this.junoHeldVoices.clear();
    if (clearInput) {
      this.junoInputNotes.clear();
      this.junoLatchedNotes.clear();
      this.junoArpAwaitingChord = true;
    }
    if (!this.ctx) return;
    [...this.junoVoices].forEach((voice) => this.retireJunoVoice(voice, this.ctx.currentTime));
    this.junoArpVoicePool = [];
    this.junoArpPoolIndex = 0;
  }

  scheduleJunoUnitDisposal() {
    const unit = this.junoUnit;
    if (!unit || unit.cleanupTimer !== null || this.junoVoices.size > 0) return;
    unit.cleanupTimer = window.setTimeout(() => {
      unit.cleanupTimer = null;
      if (this.junoVoices.size === 0 && !state.playing) this.disposeJunoUnit();
    }, 180);
  }

  disposeJunoUnit() {
    const unit = this.junoUnit;
    if (!unit || this.junoVoices.size > 0) return;
    if (unit.cleanupTimer !== null) window.clearTimeout(unit.cleanupTimer);
    if (!unit.sourcesStopped) {
      unit.chorusLfo.stop(this.ctx?.currentTime || 0);
      unit.lfo.stop(this.ctx?.currentTime || 0);
      unit.sourcesStopped = true;
    }
    [unit.input, unit.dry, unit.wet, unit.delayLeft, unit.delayRight,
      unit.pannerLeft, unit.pannerRight, unit.chorusLfo, unit.chorusDepthLeft,
      unit.chorusDepthRight, unit.lfo, unit.pitchDepth, unit.filterLfoShape, unit.filterDepth,
      unit.pwmDepth].forEach((node) => node.disconnect());
    this.junoUnit = null;
  }

  async pressJunoKey(midi, pointerId) {
    const key = `${midi}:${pointerId}`;
    const request = {};
    this.junoPreviewRequests.set(key, request);
    await this.init();
    if (this.junoPreviewRequests.get(key) !== request) return;
    refreshVisualVisibility();
    updateMeterAnimation();
    const note = { midi, order: this.junoInputOrder += 1 };
    this.junoInputNotes.set(key, note);
    FX_NAMES.forEach((effect) => this.updateEffectSend("juno", effect));
    if (state.juno.arp.enabled) {
      if (state.juno.arp.hold && this.junoArpAwaitingChord) this.junoLatchedNotes.clear();
      this.junoArpAwaitingChord = false;
      this.junoLatchedNotes.set(key, note);
      renderJunoArp();
      return;
    }
    const voice = this.startJunoVoice(midi, this.ctx.currentTime + 0.008);
    if (voice) this.junoHeldVoices.set(key, voice);
  }

  releaseJunoKey(midi, pointerId) {
    const key = `${midi}:${pointerId}`;
    this.junoPreviewRequests.delete(key);
    this.junoInputNotes.delete(key);
    if (!state.juno.arp.hold) this.junoLatchedNotes.delete(key);
    if (state.juno.arp.hold && this.junoInputNotes.size === 0) this.junoArpAwaitingChord = true;
    const voice = this.junoHeldVoices.get(key);
    this.junoHeldVoices.delete(key);
    if (voice) this.releaseJunoVoice(voice);
    renderJunoArp();
  }

  setJunoArpEnabled(enabled) {
    state.juno.arp.enabled = Boolean(enabled);
    if (state.juno.arp.enabled) {
      this.junoHeldVoices.forEach((voice) => this.retireJunoVoice(voice, this.ctx?.currentTime || 0));
      this.junoHeldVoices.clear();
      this.junoLatchedNotes = new Map(this.junoInputNotes);
      this.junoArpAwaitingChord = this.junoInputNotes.size === 0;
      resetArpClock();
    } else {
      this.stopJunoArpVoices();
      this.junoLatchedNotes.clear();
      this.junoArpAwaitingChord = true;
      if (this.ctx) {
        this.junoInputNotes.forEach((note, key) => {
          const voice = this.startJunoVoice(note.midi, this.ctx.currentTime + 0.008);
          if (voice) this.junoHeldVoices.set(key, voice);
        });
      }
    }
  }

  createNoiseBuffer(seconds) {
    const length = Math.ceil(this.ctx.sampleRate * seconds);
    const buffer = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < length; i += 1) {
      const white = Math.random() * 2 - 1;
      last = last * 0.18 + white * 0.82;
      data[i] = last;
    }
    return buffer;
  }

  setupEffects() {
    const ctx = this.ctx;
    const reverbWet = ctx.createGain();
    reverbWet.gain.value = 0.78;
    reverbWet.connect(this.masterInput);
    // Convolution is linear, so channels with the same preset can share its
    // kernel after their independent damping and preset gains have been applied.
    const banks = {};
    Object.keys(REVERB_PRESETS).forEach((mode) => {
      const convolver = ctx.createConvolver();
      convolver.buffer = this.createReverbImpulse(mode);
      convolver.connect(reverbWet);
      banks[mode] = { convolver };
    });
    this.effects.reverb = { banks, wet: reverbWet };

  }

  createChannelDelay(channelId) {
    if (!this.ctx || !this.channels[channelId]) return null;
    const existing = this.channelDelays.get(channelId);
    if (existing) {
      if (existing.cleanupTimer !== null) window.clearTimeout(existing.cleanupTimer);
      existing.cleanupTimer = null;
      return existing;
    }

    const send = this.ctx.createGain();
    const delay = this.ctx.createDelay(2);
    const delayRight = this.ctx.createDelay(2);
    const tone = this.ctx.createBiquadFilter();
    const toneRight = this.ctx.createBiquadFilter();
    const feedback = this.ctx.createGain();
    const crossFeedbackLeft = this.ctx.createGain();
    const crossFeedbackRight = this.ctx.createGain();
    const wet = this.ctx.createGain();
    const pannerLeft = typeof this.ctx.createStereoPanner === "function" ? this.ctx.createStereoPanner() : this.ctx.createGain();
    const pannerRight = typeof this.ctx.createStereoPanner === "function" ? this.ctx.createStereoPanner() : this.ctx.createGain();
    const lfo = this.ctx.createOscillator();
    const lfoDepth = this.ctx.createGain();
    const lfoDepthRight = this.ctx.createGain();
    const fx = getChannelFxState(channelId);
    const enabled = state.fx.enabled[channelId].delay;
    const delaySeconds = getDelaySeconds(fx);
    const feedbackAmount = enabled ? clamp(fx.delayFeedback, 0, 0.82) : 0;
    const pingPong = Boolean(fx.delayPingPong);

    send.gain.value = enabled ? state.fx.sends[channelId].delay : 0;
    delay.delayTime.value = delaySeconds;
    delayRight.delayTime.value = delaySeconds;
    tone.type = "lowpass";
    toneRight.type = "lowpass";
    // A resonant filter inside feedback can amplify each repeat even when the
    // feedback knob is below 100%. Keep this loop strictly attenuating.
    tone.Q.value = NON_RESONANT_Q_DB;
    toneRight.Q.value = NON_RESONANT_Q_DB;
    tone.frequency.value = fx.delayMode === "tape" ? Math.min(fx.delayTone, 6200) : fx.delayTone;
    toneRight.frequency.value = fx.delayMode === "tape" ? Math.min(fx.delayTone, 6200) : fx.delayTone;
    feedback.gain.value = pingPong ? 0 : feedbackAmount;
    crossFeedbackLeft.gain.value = pingPong ? feedbackAmount : 0;
    crossFeedbackRight.gain.value = pingPong ? feedbackAmount : 0;
    wet.gain.value = 0.72;
    if (pannerLeft.pan) pannerLeft.pan.value = pingPong ? -1 : 0;
    if (pannerRight.pan) pannerRight.pan.value = 1;
    lfo.type = "sine";
    lfo.frequency.value = 0.21;
    lfoDepth.gain.value = fx.delayMode === "tape" ? 0.0018 : 0;
    lfoDepthRight.gain.value = fx.delayMode === "tape" ? 0.0018 : 0;
    this.channels[channelId].panner.connect(send);
    send.connect(delay);
    delay.connect(tone);
    tone.connect(pannerLeft);
    pannerLeft.connect(wet);
    delayRight.connect(toneRight);
    toneRight.connect(pannerRight);
    pannerRight.connect(wet);
    wet.connect(this.masterInput);
    tone.connect(feedback);
    feedback.connect(delay);
    tone.connect(crossFeedbackLeft);
    crossFeedbackLeft.connect(delayRight);
    toneRight.connect(crossFeedbackRight);
    crossFeedbackRight.connect(delay);
    lfo.connect(lfoDepth);
    lfoDepth.connect(delay.delayTime);
    lfo.connect(lfoDepthRight);
    lfoDepthRight.connect(delayRight.delayTime);
    lfo.start();

    const unit = {
      channelId, send, delay, delayRight, tone, toneRight, feedback, crossFeedbackLeft, crossFeedbackRight,
      wet, pannerLeft, pannerRight, lfo, lfoDepth, lfoDepthRight, cleanupTimer: null, lfoStopped: false,
    };
    this.channelDelays.set(channelId, unit);
    return unit;
  }

  updateDelay(channelId) {
    const unit = this.channelDelays.get(channelId);
    if (!unit) return;
    const fx = getChannelFxState(channelId);
    const delaySeconds = getDelaySeconds(fx);
    const feedback = state.fx.enabled[channelId].delay ? clamp(fx.delayFeedback, 0, 0.82) : 0;
    const pingPong = Boolean(fx.delayPingPong);
    this.setSmooth(unit.delay.delayTime, delaySeconds, 0.035);
    this.setSmooth(unit.delayRight.delayTime, delaySeconds, 0.035);
    this.setSmooth(unit.feedback.gain, pingPong ? 0 : feedback);
    this.setSmooth(unit.crossFeedbackLeft.gain, pingPong ? feedback : 0);
    this.setSmooth(unit.crossFeedbackRight.gain, pingPong ? feedback : 0);
    this.setSmooth(unit.tone.frequency, fx.delayMode === "tape" ? Math.min(fx.delayTone, 6200) : fx.delayTone);
    this.setSmooth(unit.toneRight.frequency, fx.delayMode === "tape" ? Math.min(fx.delayTone, 6200) : fx.delayTone);
    this.setSmooth(unit.lfoDepth.gain, fx.delayMode === "tape" ? 0.0018 : 0);
    this.setSmooth(unit.lfoDepthRight.gain, fx.delayMode === "tape" ? 0.0018 : 0);
    if (unit.pannerLeft.pan) this.setSmooth(unit.pannerLeft.pan, pingPong ? -1 : 0, 0.035);
    if (unit.pannerRight.pan) this.setSmooth(unit.pannerRight.pan, 1, 0.035);
    this.setSmooth(unit.wet.gain, 0.72);
  }

  updateSyncedDelays() {
    this.channelDelays.forEach((unit, channelId) => {
      if (getChannelFxState(channelId).delayTiming === "sync") this.updateDelay(channelId);
    });
  }

  scheduleDelayDisposal(channelId) {
    const unit = this.channelDelays.get(channelId);
    if (!unit || unit.cleanupTimer !== null) return;
    const fx = getChannelFxState(channelId);
    this.setSmooth(unit.send.gain, 0);
    this.setSmooth(unit.feedback.gain, 0, 0.035);
    this.setSmooth(unit.crossFeedbackLeft.gain, 0, 0.035);
    this.setSmooth(unit.crossFeedbackRight.gain, 0, 0.035);
    const tailSeconds = clamp(getDelaySeconds(fx) * (fx.delayPingPong ? 3 : 2) + 0.12, 0.24, 4);
    unit.cleanupTimer = window.setTimeout(() => {
      unit.cleanupTimer = null;
      if (!state.fx.enabled[channelId].delay) this.disposeChannelDelay(channelId);
    }, tailSeconds * 1000);
  }

  disposeChannelDelay(channelId) {
    const unit = this.channelDelays.get(channelId);
    if (!unit) return;
    if (unit.cleanupTimer !== null) window.clearTimeout(unit.cleanupTimer);
    unit.cleanupTimer = null;
    const now = this.ctx?.currentTime || 0;
    unit.send.gain.cancelScheduledValues(now);
    unit.send.gain.setValueAtTime(0, now);
    unit.feedback.gain.cancelScheduledValues(now);
    unit.feedback.gain.setValueAtTime(0, now);
    unit.crossFeedbackLeft.gain.cancelScheduledValues(now);
    unit.crossFeedbackLeft.gain.setValueAtTime(0, now);
    unit.crossFeedbackRight.gain.cancelScheduledValues(now);
    unit.crossFeedbackRight.gain.setValueAtTime(0, now);
    if (!unit.lfoStopped) {
      unit.lfo.stop(now);
      unit.lfoStopped = true;
    }
    this.channels[channelId].panner.disconnect(unit.send);
    [unit.send, unit.delay, unit.delayRight, unit.tone, unit.toneRight, unit.feedback, unit.crossFeedbackLeft,
      unit.crossFeedbackRight, unit.wet, unit.pannerLeft, unit.pannerRight, unit.lfo, unit.lfoDepth,
      unit.lfoDepthRight].forEach((node) => node.disconnect());
    this.channelDelays.delete(channelId);
  }

  disposeAllChannelDelays() {
    [...this.channelDelays.keys()].forEach((channelId) => this.disposeChannelDelay(channelId));
  }

  createChannelChorus(channelId) {
    if (!this.ctx || !this.channels[channelId]) return null;
    const existing = this.channelChoruses.get(channelId);
    if (existing) {
      if (existing.cleanupTimer !== null) window.clearTimeout(existing.cleanupTimer);
      existing.cleanupTimer = null;
      return existing;
    }

    const send = this.ctx.createGain();
    const delay = this.ctx.createDelay(0.08);
    const wet = this.ctx.createGain();
    const lfo = this.ctx.createOscillator();
    const depth = this.ctx.createGain();
    const fx = getChannelFxState(channelId);
    const enabled = state.fx.enabled[channelId].chorus;

    send.gain.value = enabled ? state.fx.sends[channelId].chorus : 0;
    delay.delayTime.value = 0.018;
    wet.gain.value = 0.62;
    lfo.type = "sine";
    lfo.frequency.value = fx.chorusRate;
    depth.gain.value = 0.001 + fx.chorusDepth * 0.0065;
    this.channels[channelId].panner.connect(send);
    send.connect(delay);
    delay.connect(wet);
    wet.connect(this.masterInput);
    lfo.connect(depth);
    depth.connect(delay.delayTime);
    lfo.start();

    const unit = { channelId, send, delay, wet, lfo, depth, cleanupTimer: null, lfoStopped: false };
    this.channelChoruses.set(channelId, unit);
    return unit;
  }

  updateChorus(channelId) {
    const unit = this.channelChoruses.get(channelId);
    if (!unit) return;
    const fx = getChannelFxState(channelId);
    this.setSmooth(unit.lfo.frequency, fx.chorusRate);
    this.setSmooth(unit.depth.gain, 0.001 + fx.chorusDepth * 0.0065);
    this.setSmooth(unit.wet.gain, 0.62);
  }

  scheduleChorusDisposal(channelId) {
    const unit = this.channelChoruses.get(channelId);
    if (!unit || unit.cleanupTimer !== null) return;
    this.setSmooth(unit.send.gain, 0);
    unit.cleanupTimer = window.setTimeout(() => {
      unit.cleanupTimer = null;
      if (!state.fx.enabled[channelId].chorus) this.disposeChannelChorus(channelId);
    }, 120);
  }

  disposeChannelChorus(channelId) {
    const unit = this.channelChoruses.get(channelId);
    if (!unit) return;
    if (unit.cleanupTimer !== null) window.clearTimeout(unit.cleanupTimer);
    unit.cleanupTimer = null;
    const now = this.ctx?.currentTime || 0;
    unit.send.gain.cancelScheduledValues(now);
    unit.send.gain.setValueAtTime(0, now);
    if (!unit.lfoStopped) {
      unit.lfo.stop(now);
      unit.lfoStopped = true;
    }
    this.channels[channelId].panner.disconnect(unit.send);
    [unit.send, unit.delay, unit.wet, unit.lfo, unit.depth].forEach((node) => node.disconnect());
    this.channelChoruses.delete(channelId);
  }

  disposeAllChannelChoruses() {
    [...this.channelChoruses.keys()].forEach((channelId) => this.disposeChannelChorus(channelId));
  }

  createChannelPhaser(channelId) {
    if (!this.ctx || !this.channels[channelId]) return null;
    const existing = this.channelPhasers.get(channelId);
    if (existing) {
      if (existing.cleanupTimer !== null) window.clearTimeout(existing.cleanupTimer);
      existing.cleanupTimer = null;
      return existing;
    }

    const send = this.ctx.createGain();
    const filters = [280, 620, 1280, 2500].map((frequency) => {
      const filter = this.ctx.createBiquadFilter();
      filter.type = "allpass";
      filter.frequency.value = frequency;
      filter.Q.value = 0.78;
      return filter;
    });
    const wet = this.ctx.createGain();
    const lfo = this.ctx.createOscillator();
    const depths = filters.map(() => this.ctx.createGain());
    const fx = getChannelFxState(channelId);
    const enabled = state.fx.enabled[channelId].phaser;

    send.gain.value = enabled ? state.fx.sends[channelId].phaser : 0;
    wet.gain.value = 0.62;
    lfo.type = "sine";
    lfo.frequency.value = fx.phaserRate;
    depths.forEach((depth, index) => { depth.gain.value = [260, 470, 780, 1150][index] * fx.phaserDepth; });
    this.channels[channelId].panner.connect(send);
    send.connect(filters[0]);
    filters.forEach((filter, index) => {
      if (filters[index + 1]) filter.connect(filters[index + 1]);
    });
    filters.at(-1).connect(wet);
    wet.connect(this.masterInput);
    depths.forEach((depth, index) => {
      lfo.connect(depth);
      depth.connect(filters[index].frequency);
    });
    lfo.start();

    const unit = { channelId, send, filters, wet, lfo, depths, cleanupTimer: null, lfoStopped: false };
    this.channelPhasers.set(channelId, unit);
    return unit;
  }

  updatePhaser(channelId) {
    const unit = this.channelPhasers.get(channelId);
    if (!unit) return;
    const fx = getChannelFxState(channelId);
    this.setSmooth(unit.lfo.frequency, fx.phaserRate);
    unit.depths.forEach((depth, index) => {
      this.setSmooth(depth.gain, [260, 470, 780, 1150][index] * fx.phaserDepth);
    });
    this.setSmooth(unit.wet.gain, 0.62);
  }

  schedulePhaserDisposal(channelId) {
    const unit = this.channelPhasers.get(channelId);
    if (!unit || unit.cleanupTimer !== null) return;
    this.setSmooth(unit.send.gain, 0);
    unit.cleanupTimer = window.setTimeout(() => {
      unit.cleanupTimer = null;
      if (!state.fx.enabled[channelId].phaser) this.disposeChannelPhaser(channelId);
    }, 100);
  }

  disposeChannelPhaser(channelId) {
    const unit = this.channelPhasers.get(channelId);
    if (!unit) return;
    if (unit.cleanupTimer !== null) window.clearTimeout(unit.cleanupTimer);
    unit.cleanupTimer = null;
    const now = this.ctx?.currentTime || 0;
    unit.send.gain.cancelScheduledValues(now);
    unit.send.gain.setValueAtTime(0, now);
    if (!unit.lfoStopped) {
      unit.lfo.stop(now);
      unit.lfoStopped = true;
    }
    this.channels[channelId].panner.disconnect(unit.send);
    [unit.send, ...unit.filters, unit.wet, unit.lfo, ...unit.depths].forEach((node) => node.disconnect());
    this.channelPhasers.delete(channelId);
  }

  disposeAllChannelPhasers() {
    [...this.channelPhasers.keys()].forEach((channelId) => this.disposeChannelPhaser(channelId));
  }

  createChannelFlanger(channelId) {
    if (!this.ctx || !this.channels[channelId]) return null;
    const existing = this.channelFlangers.get(channelId);
    if (existing) {
      if (existing.cleanupTimer !== null) window.clearTimeout(existing.cleanupTimer);
      existing.cleanupTimer = null;
      return existing;
    }

    const send = this.ctx.createGain();
    const delay = this.ctx.createDelay(0.03);
    const feedback = this.ctx.createGain();
    const wet = this.ctx.createGain();
    const lfo = this.ctx.createOscillator();
    const depth = this.ctx.createGain();
    const fx = getChannelFxState(channelId);
    const enabled = state.fx.enabled[channelId].flanger;

    send.gain.value = enabled ? state.fx.sends[channelId].flanger : 0;
    delay.delayTime.value = 0.004;
    feedback.gain.value = enabled ? clamp(fx.flangerFeedback, 0, 0.75) * 0.75 : 0;
    wet.gain.value = 0.55;
    lfo.type = "sine";
    lfo.frequency.value = fx.flangerRate;
    depth.gain.value = 0.0018;
    this.channels[channelId].panner.connect(send);
    send.connect(delay);
    delay.connect(wet);
    wet.connect(this.masterInput);
    delay.connect(feedback);
    feedback.connect(delay);
    lfo.connect(depth);
    depth.connect(delay.delayTime);
    lfo.start();

    const unit = { channelId, send, delay, feedback, wet, lfo, depth, cleanupTimer: null, lfoStopped: false };
    this.channelFlangers.set(channelId, unit);
    return unit;
  }

  updateFlanger(channelId) {
    const unit = this.channelFlangers.get(channelId);
    if (!unit) return;
    const fx = getChannelFxState(channelId);
    this.setSmooth(unit.lfo.frequency, fx.flangerRate);
    this.setSmooth(unit.depth.gain, 0.0018);
    this.setSmooth(unit.feedback.gain, state.fx.enabled[channelId].flanger ? clamp(fx.flangerFeedback, 0, 0.75) * 0.75 : 0);
    this.setSmooth(unit.wet.gain, 0.55);
  }

  scheduleFlangerDisposal(channelId) {
    const unit = this.channelFlangers.get(channelId);
    if (!unit || unit.cleanupTimer !== null) return;
    this.setSmooth(unit.send.gain, 0);
    this.setSmooth(unit.feedback.gain, 0, 0.035);
    unit.cleanupTimer = window.setTimeout(() => {
      unit.cleanupTimer = null;
      if (!state.fx.enabled[channelId].flanger) this.disposeChannelFlanger(channelId);
    }, 240);
  }

  disposeChannelFlanger(channelId) {
    const unit = this.channelFlangers.get(channelId);
    if (!unit) return;
    if (unit.cleanupTimer !== null) window.clearTimeout(unit.cleanupTimer);
    unit.cleanupTimer = null;
    const now = this.ctx?.currentTime || 0;
    unit.send.gain.cancelScheduledValues(now);
    unit.send.gain.setValueAtTime(0, now);
    unit.feedback.gain.cancelScheduledValues(now);
    unit.feedback.gain.setValueAtTime(0, now);
    if (!unit.lfoStopped) {
      unit.lfo.stop(now);
      unit.lfoStopped = true;
    }
    this.channels[channelId].panner.disconnect(unit.send);
    [unit.send, unit.delay, unit.feedback, unit.wet, unit.lfo, unit.depth].forEach((node) => node.disconnect());
    this.channelFlangers.delete(channelId);
  }

  disposeAllChannelFlangers() {
    [...this.channelFlangers.keys()].forEach((channelId) => this.disposeChannelFlanger(channelId));
  }

  createChannelReverb(channelId) {
    if (!this.ctx || !this.channels[channelId] || !this.effects.reverb) return null;
    const existing = this.channelReverbs.get(channelId);
    if (existing) {
      if (existing.cleanupTimer !== null) window.clearTimeout(existing.cleanupTimer);
      existing.cleanupTimer = null;
      return existing;
    }

    const send = this.ctx.createGain();
    const damping = this.ctx.createBiquadFilter();
    const presetGains = Object.fromEntries(Object.keys(REVERB_PRESETS).map((mode) => [mode, this.ctx.createGain()]));
    send.gain.value = 0;
    damping.type = "lowpass";
    this.channels[channelId].panner.connect(send);
    send.connect(damping);
    Object.entries(presetGains).forEach(([mode, gain]) => {
      gain.gain.value = 0;
      damping.connect(gain);
      gain.connect(this.effects.reverb.banks[mode].convolver);
    });

    const unit = { channelId, send, damping, presetGains, cleanupTimer: null };
    this.channelReverbs.set(channelId, unit);
    this.updateReverb(channelId);
    return unit;
  }

  updateReverb(channelId) {
    const unit = this.channelReverbs.get(channelId);
    if (!unit) return;
    const fx = getChannelFxState(channelId);
    this.setSmooth(unit.damping.frequency, fx.reverbDamping);
    Object.entries(unit.presetGains).forEach(([mode, gain]) => {
      const active = state.fx.enabled[channelId].reverb && mode === fx.reverbMode ? 1 : 0;
      this.setSmooth(gain.gain, active, 0.07, true);
    });
  }

  scheduleReverbDisposal(channelId) {
    const unit = this.channelReverbs.get(channelId);
    if (!unit || unit.cleanupTimer !== null) return;
    this.setSmooth(unit.send.gain, 0);
    Object.values(unit.presetGains).forEach((gain) => this.setSmooth(gain.gain, 0, 0.07, true));
    // The shared convolvers retain already-received audio, so this input route
    // can be removed after its fade without cutting any channel's reverb tail.
    unit.cleanupTimer = window.setTimeout(() => {
      unit.cleanupTimer = null;
      if (!state.fx.enabled[channelId].reverb) this.disposeChannelReverb(channelId);
    }, 120);
  }

  disposeChannelReverb(channelId) {
    const unit = this.channelReverbs.get(channelId);
    if (!unit) return;
    if (unit.cleanupTimer !== null) window.clearTimeout(unit.cleanupTimer);
    unit.cleanupTimer = null;
    const now = this.ctx?.currentTime || 0;
    unit.send.gain.cancelScheduledValues(now);
    unit.send.gain.setValueAtTime(0, now);
    Object.values(unit.presetGains).forEach((gain) => {
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(0, now);
    });
    this.channels[channelId].panner.disconnect(unit.send);
    [unit.send, unit.damping, ...Object.values(unit.presetGains)].forEach((node) => node.disconnect());
    this.channelReverbs.delete(channelId);
  }

  disposeAllChannelReverbs() {
    [...this.channelReverbs.keys()].forEach((channelId) => this.disposeChannelReverb(channelId));
  }

  setSmooth(param, value, timeConstant = 0.018, linear = false) {
    if (!this.ctx || !param) return;
    const now = this.ctx.currentTime;
    const previous = this.smoothParams.get(param);
    if (previous && previous.target === value && previous.timeConstant === timeConstant && previous.linear === linear) return;
    // These parameters are controlled only here (note envelopes use their own
    // automation). Evaluate the old target curve before replacing its history.
    // This also works in browsers without cancelAndHoldAtTime.
    const progress = previous ? Math.max(0, now - previous.time) / previous.timeConstant : 0;
    const current = previous ? previous.linear
      ? previous.startValue + (previous.target - previous.startValue) * Math.min(1, progress)
      : previous.target + (previous.startValue - previous.target) * Math.exp(-progress)
      : param.value;
    param.cancelScheduledValues(0);
    param.setValueAtTime(current, now);
    if (linear) param.linearRampToValueAtTime(value, now + timeConstant);
    else param.setTargetAtTime(value, now, timeConstant);
    this.smoothParams.set(param, { target: value, startValue: current, time: now, timeConstant, linear });
  }

  updateMaster() {
    if (this.masterGain) this.setSmooth(this.masterGain.gain, state.master);
  }

  updateMasterProcessor() {
    if (!this.ctx || !this.masterLimiter || !this.masterEq) return;
    const master = state.masterProcessor;
    const frequencyLimit = this.ctx.sampleRate * 0.49;
    this.setSmooth(this.masterLimiter.threshold, master.limiterThreshold);
    this.setSmooth(this.masterLimiter.attack, master.limiterAttack);
    this.setSmooth(this.masterLimiter.release, master.limiterRelease);
    // DynamicsCompressorNode has no output ceiling control. Referencing its
    // post gain to the threshold makes the compressed threshold land at the
    // requested pre-EQ ceiling. The creative EQ deliberately comes later.
    this.setSmooth(this.masterCeiling.gain, dbToGain(master.limiterCeiling - master.limiterThreshold));
    this.setSmooth(this.masterLimiterDry.gain, master.limiterEnabled ? 0 : 1, 0.025, true);
    this.setSmooth(this.masterLimiterWet.gain, master.limiterEnabled ? 1 : 0, 0.025, true);

    this.setSmooth(this.masterEq.highPass.frequency, clamp(master.highPassFreq, 20, frequencyLimit));
    this.setSmooth(this.masterEq.lowShelf.frequency, clamp(master.lowShelfFreq, 20, frequencyLimit));
    this.setSmooth(this.masterEq.lowShelf.gain, master.lowShelfGain);
    this.setSmooth(this.masterEq.highShelf.frequency, clamp(master.highShelfFreq, 20, frequencyLimit));
    this.setSmooth(this.masterEq.highShelf.gain, master.highShelfGain);
    this.setSmooth(this.masterEq.lowPass.frequency, clamp(master.lowPassFreq, 20, frequencyLimit));
    this.setSmooth(this.masterEqDry.gain, master.eqEnabled ? 0 : 1, 0.025, true);
    this.setSmooth(this.masterEqWet.gain, master.eqEnabled ? 1 : 0, 0.025, true);
  }

  updateChannel(id) {
    const channel = this.channels[id];
    if (!channel) return;
    const muted = isChannelMuted(id);
    this.setSmooth(channel.gain.gain, muted ? 0 : state.levels[id]);
    if (channel.panner.pan) this.setSmooth(channel.panner.pan, state.pans[id]);
  }

  updateAllChannels() {
    Object.keys(this.channels).forEach((id) => this.updateChannel(id));
  }

  updateProcessor(id) {
    const channel = this.channels[id];
    const processor = state.processors[id];
    if (!channel || !processor || !this.ctx) return;
    const frequencyLimit = this.ctx.sampleRate * 0.49;
    this.setSmooth(channel.highPass.frequency, clamp(processor.highPassFreq, 20, frequencyLimit));
    this.setSmooth(channel.lowShelf.frequency, clamp(processor.lowShelfFreq, 20, frequencyLimit));
    this.setSmooth(channel.lowShelf.gain, processor.lowShelfGain);
    this.setSmooth(channel.highShelf.frequency, clamp(processor.highShelfFreq, 20, frequencyLimit));
    this.setSmooth(channel.highShelf.gain, processor.highShelfGain);
    this.setSmooth(channel.lowPass.frequency, clamp(processor.lowPassFreq, 20, frequencyLimit));

    const detectorDriveDb = -14 + processor.peakReduction * 0.28;
    this.setSmooth(channel.peakDrive.gain, dbToGain(detectorDriveDb));
    this.setSmooth(channel.peakTrim.gain, dbToGain(-detectorDriveDb));
    this.setSmooth(channel.makeup.gain, dbToGain(processor.makeupGain));
  }

  updateAllProcessors() {
    Object.keys(this.channels).forEach((id) => this.updateProcessor(id));
  }

  updateEffectSend(channelId, effect) {
    if (!this.ctx || !this.channels[channelId]) return;
    if (effect === "delay") {
      if (!state.fx.enabled[channelId].delay) {
        this.scheduleDelayDisposal(channelId);
        return;
      }
      const existing = this.channelDelays.has(channelId);
      const unit = this.createChannelDelay(channelId);
      if (existing) {
        this.updateDelay(channelId);
        this.setSmooth(unit.send.gain, state.fx.sends[channelId].delay);
      }
      return;
    }
    if (effect === "chorus") {
      if (!state.fx.enabled[channelId].chorus) {
        this.scheduleChorusDisposal(channelId);
        return;
      }
      const existing = this.channelChoruses.has(channelId);
      const unit = this.createChannelChorus(channelId);
      if (existing) {
        this.updateChorus(channelId);
        this.setSmooth(unit.send.gain, state.fx.sends[channelId].chorus);
      }
      return;
    }
    if (effect === "phaser") {
      if (!state.fx.enabled[channelId].phaser) {
        this.schedulePhaserDisposal(channelId);
        return;
      }
      const existing = this.channelPhasers.has(channelId);
      const unit = this.createChannelPhaser(channelId);
      if (existing) {
        this.updatePhaser(channelId);
        this.setSmooth(unit.send.gain, state.fx.sends[channelId].phaser);
      }
      return;
    }
    if (effect === "flanger") {
      if (!state.fx.enabled[channelId].flanger) {
        this.scheduleFlangerDisposal(channelId);
        return;
      }
      const existing = this.channelFlangers.has(channelId);
      const unit = this.createChannelFlanger(channelId);
      if (existing) {
        this.updateFlanger(channelId);
        this.setSmooth(unit.send.gain, state.fx.sends[channelId].flanger);
      }
      return;
    }
    if (effect === "reverb") {
      if (!state.fx.enabled[channelId].reverb) {
        this.scheduleReverbDisposal(channelId);
        return;
      }
      const unit = this.createChannelReverb(channelId);
      this.updateReverb(channelId);
      this.setSmooth(unit.send.gain, state.fx.sends[channelId].reverb);
    }
  }

  updateAllEffectSends() {
    CHANNELS.forEach(({ id }) => {
      FX_NAMES.forEach((effect) => this.updateEffectSend(id, effect));
    });
  }

  updateEffect(effect, channelId = state.selectedFxChannel) {
    if (!this.ctx) return;
    if (effect === "delay") {
      this.updateDelay(channelId);
      return;
    }
    if (effect === "chorus") {
      this.updateChorus(channelId);
      return;
    }
    if (effect === "phaser") {
      this.updatePhaser(channelId);
      return;
    }
    if (effect === "flanger") {
      this.updateFlanger(channelId);
      return;
    }
    if (effect === "reverb") {
      this.updateReverb(channelId);
    }
  }

  createReverbImpulse(mode) {
    const preset = REVERB_PRESETS[mode];
    const length = Math.floor(this.ctx.sampleRate * preset.seconds);
    const impulse = this.ctx.createBuffer(2, length, this.ctx.sampleRate);

    for (let channel = 0; channel < 2; channel += 1) {
      const data = impulse.getChannelData(channel);
      let smoothNoise = 0;
      for (let i = 0; i < length; i += 1) {
        const progress = i / length;
        const white = Math.random() * 2 - 1;
        smoothNoise = smoothNoise * preset.diffusion + white * (1 - preset.diffusion);
        const envelope = Math.pow(1 - progress, preset.decay);
        const early = i < this.ctx.sampleRate * 0.055 && i % 127 === 0 ? (1 - progress) * 0.34 : 0;
        data[i] = (smoothNoise * envelope + early) * 0.72;
      }
    }
    return impulse;
  }

  trackDrumVoice(track, sources, nodes, fade, stopAt) {
    const voice = { track, sources, fade, stopAt, fadeAt: Infinity };
    this.drumVoices.add(voice);
    diagnostics.voiceCreatedFor(track);
    let remaining = sources.length;
    sources.forEach((source) => {
      source.onended = () => {
        source.onended = null;
        remaining -= 1;
        if (remaining !== 0) return;
        nodes.forEach((node) => node.disconnect());
        this.drumVoices.delete(voice);
        diagnostics.voiceCleanedFor(track);
      };
    });
    return voice;
  }

  fadeDrumVoices(time, track = null) {
    const fadeAt = Math.max(time, this.ctx.currentTime);
    this.drumVoices.forEach((voice) => {
      if ((track && voice.track !== track) || voice.stopAt <= fadeAt || voice.fadeAt <= fadeAt) return;
      const fadeEnd = Math.min(voice.stopAt, fadeAt + BASS_FADE_TIME);
      voice.fade.gain.cancelScheduledValues(fadeAt);
      voice.fade.gain.setValueAtTime(1, fadeAt);
      voice.fade.gain.linearRampToValueAtTime(0, fadeEnd);
      voice.fadeAt = fadeAt;
      voice.stopAt = Math.min(voice.stopAt, fadeEnd + 0.004);
      voice.sources.forEach((source) => {
        // A snare body may have already finished before its noise tail.
        if (source.onended) source.stop(voice.stopAt);
      });
    });
  }

  stopVoices(disposeEffects = true) {
    this.drumPreviewRequests = {};
    this.stopBassVoices();
    this.stopJunoVoices(disposeEffects);
    if (this.ctx) this.fadeDrumVoices(this.ctx.currentTime);
    if (disposeEffects) {
      this.disposeAutoCutoff();
      this.scheduleJunoUnitDisposal();
      this.disposeAllChannelDelays();
      this.disposeAllChannelChoruses();
      this.disposeAllChannelPhasers();
      this.disposeAllChannelFlangers();
      this.disposeAllChannelReverbs();
    }
  }

  makeDriveCurve(amount) {
    const key = Math.round(amount * 100);
    if (this.driveCache.has(key)) return this.driveCache.get(key);
    const samples = 512;
    const curve = new Float32Array(samples);
    if (amount <= 0.01) {
      for (let i = 0; i < samples; i += 1) curve[i] = (i * 2) / (samples - 1) - 1;
      this.driveCache.set(key, curve);
      return curve;
    }
    const k = 1 + amount * 90;
    for (let i = 0; i < samples; i += 1) {
      const x = (i * 2) / (samples - 1) - 1;
      curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
    }
    this.driveCache.set(key, curve);
    return curve;
  }

  scheduleKick(time, velocity) {
    const osc = this.ctx.createOscillator();
    const amp = this.ctx.createGain();
    const fade = this.ctx.createGain();
    const tune = state.drums.kickTune;
    osc.type = "sine";
    osc.frequency.setValueAtTime(tune * 3.6, time);
    osc.frequency.exponentialRampToValueAtTime(tune, time + 0.085);
    amp.gain.setValueAtTime(0.0001, time);
    amp.gain.exponentialRampToValueAtTime(0.95 * velocity, time + 0.003);
    amp.gain.exponentialRampToValueAtTime(0.0001, time + 0.48);
    osc.connect(amp);
    amp.connect(fade);
    fade.connect(this.channels.kick.input);
    const voice = this.trackDrumVoice("kick", [osc], [osc, amp, fade], fade, time + 0.52);
    osc.start(time);
    osc.stop(time + 0.52);
    return voice;
  }

  scheduleSnare(time, velocity) {
    const noise = this.ctx.createBufferSource();
    const noiseFilter = this.ctx.createBiquadFilter();
    const noiseAmp = this.ctx.createGain();
    const fade = this.ctx.createGain();
    noise.buffer = this.noiseBuffer;
    noiseFilter.type = "highpass";
    noiseFilter.frequency.setValueAtTime(state.drums.snareTone, time);
    noiseAmp.gain.setValueAtTime(0.0001, time);
    noiseAmp.gain.exponentialRampToValueAtTime(0.46 * velocity, time + 0.003);
    noiseAmp.gain.exponentialRampToValueAtTime(0.0001, time + 0.24);
    noise.connect(noiseFilter);
    noiseFilter.connect(noiseAmp);
    noiseAmp.connect(fade);
    fade.connect(this.channels.snare.input);

    const body = this.ctx.createOscillator();
    const bodyAmp = this.ctx.createGain();
    body.type = "triangle";
    body.frequency.setValueAtTime(178, time);
    body.frequency.exponentialRampToValueAtTime(122, time + 0.11);
    bodyAmp.gain.setValueAtTime(0.0001, time);
    bodyAmp.gain.exponentialRampToValueAtTime(0.30 * velocity, time + 0.002);
    bodyAmp.gain.exponentialRampToValueAtTime(0.0001, time + 0.17);
    body.connect(bodyAmp);
    bodyAmp.connect(fade);
    const voice = this.trackDrumVoice("snare", [noise, body], [noise, noiseFilter, noiseAmp, body, bodyAmp, fade], fade, time + 0.28);

    noise.start(time);
    noise.stop(time + 0.28);
    body.start(time);
    body.stop(time + 0.2);
    return voice;
  }

  scheduleClap(time, velocity) {
    const noise = this.ctx.createBufferSource();
    const band = this.ctx.createBiquadFilter();
    const high = this.ctx.createBiquadFilter();
    const amp = this.ctx.createGain();
    const fade = this.ctx.createGain();
    noise.buffer = this.noiseBuffer;
    band.type = "bandpass";
    band.frequency.value = 1350;
    band.Q.value = 0.7;
    high.type = "highpass";
    high.frequency.value = 650;
    amp.gain.setValueAtTime(0.0001, time);
    [0, 0.022, 0.047].forEach((offset, index) => {
      amp.gain.setValueAtTime(0.0001, time + offset);
      amp.gain.linearRampToValueAtTime((0.38 - index * 0.05) * velocity, time + offset + 0.004);
      amp.gain.exponentialRampToValueAtTime(0.025, time + offset + 0.018);
    });
    amp.gain.exponentialRampToValueAtTime(0.0001, time + 0.28);
    noise.connect(band);
    band.connect(high);
    high.connect(amp);
    amp.connect(fade);
    fade.connect(this.channels.clap.input);
    const voice = this.trackDrumVoice("clap", [noise], [noise, band, high, amp, fade], fade, time + 0.31);
    noise.start(time);
    noise.stop(time + 0.31);
    return voice;
  }

  scheduleHat(time, velocity, open) {
    const mix = this.ctx.createGain();
    const band = this.ctx.createBiquadFilter();
    const high = this.ctx.createBiquadFilter();
    const amp = this.ctx.createGain();
    const fade = this.ctx.createGain();
    const decay = open ? state.drums.hatDecay : 0.055;
    const frequencies = [205, 304, 370, 523, 800, 1047];
    mix.gain.value = 0.032;
    band.type = "bandpass";
    band.frequency.value = 9800;
    band.Q.value = 0.72;
    high.type = "highpass";
    high.frequency.value = 6900;
    amp.gain.setValueAtTime(0.0001, time);
    amp.gain.exponentialRampToValueAtTime((open ? 0.34 : 0.25) * velocity, time + 0.002);
    amp.gain.exponentialRampToValueAtTime(0.0001, time + decay);
    mix.connect(band);
    band.connect(high);
    high.connect(amp);
    const track = open ? "openHat" : "closedHat";
    amp.connect(fade);
    fade.connect(this.channels[track].input);

    const oscillators = frequencies.map((frequency) => {
      const osc = this.ctx.createOscillator();
      osc.type = "square";
      osc.frequency.value = frequency;
      osc.connect(mix);
      osc.start(time);
      osc.stop(time + decay + 0.025);
      return osc;
    });
    return this.trackDrumVoice(track, oscillators, [...oscillators, mix, band, high, amp, fade], fade, time + decay + 0.025);
  }

  scheduleDrum(track, time, level, velocityOverride = null) {
    if (!this.ctx || level === 0 || isChannelMuted(track)) return;
    const velocity = Number.isFinite(velocityOverride) ? clamp(velocityOverride, 0, 1) : level === 2 ? 1 : 0.72;
    let voice;
    if (track === "kick") voice = this.scheduleKick(time, velocity);
    else if (track === "snare") voice = this.scheduleSnare(time, velocity);
    else if (track === "clap") voice = this.scheduleClap(time, velocity);
    else if (track === "closedHat") voice = this.scheduleHat(time, velocity, false);
    else if (track === "openHat") voice = this.scheduleHat(time, velocity, true);
    if (voice && diagnostics.enabled) diagnostics.recordScheduledEvent(time, voice.stopAt, this);
    return voice;
  }

  scheduleBass(step, time, duration, previousMidi = null) {
    if (!this.ctx || !step.active) return;
    const synth = state.synth;
    const frequency = midiToFrequency(step.midi);
    const previousFrequency = previousMidi == null ? frequency : midiToFrequency(previousMidi);
    const accent = step.accent ? 1.28 : 1;
    const attack = Math.max(0.002, step.slide ? Math.min(synth.attack, 0.01) : synth.attack);
    const decay = Math.max(0.025, synth.decay);
    const release = Math.max(0.02, synth.release);
    const gateEnd = time + Math.max(0.045, duration - release * 0.35);
    const envelopeEnd = gateEnd + release + 0.005;
    const stopAt = envelopeEnd + 0.01;

    const osc = this.ctx.createOscillator();
    const sub = this.ctx.createOscillator();
    const oscGain = this.ctx.createGain();
    const subGain = this.ctx.createGain();
    const drive = this.ctx.createWaveShaper();
    const filterA = this.ctx.createBiquadFilter();
    const filterB = this.ctx.createBiquadFilter();
    const amp = this.ctx.createGain();
    const fade = this.ctx.createGain();

    osc.type = synth.wave;
    sub.type = "square";
    oscGain.gain.value = 0.64;
    subGain.gain.value = synth.sub * 0.42;
    drive.curve = this.makeDriveCurve(synth.drive);
    drive.oversample = "2x";
    filterA.type = "lowpass";
    filterB.type = "lowpass";
    filterA.Q.value = synth.resonance * 0.72;
    filterB.Q.value = synth.resonance * 0.34;

    const glideTime = step.slide ? synth.glide : 0;
    osc.frequency.setValueAtTime(glideTime > 0 ? previousFrequency : frequency, time);
    sub.frequency.setValueAtTime((glideTime > 0 ? previousFrequency : frequency) / 2, time);
    if (glideTime > 0) {
      osc.frequency.exponentialRampToValueAtTime(frequency, time + glideTime);
      sub.frequency.exponentialRampToValueAtTime(frequency / 2, time + glideTime);
    }

    const baseCutoff = clamp(synth.cutoff, 70, 15000);
    const peakCutoff = clamp(baseCutoff + synth.envAmount * accent, baseCutoff + 1, 18000);
    [filterA, filterB].forEach((filter) => {
      filter.frequency.setValueAtTime(baseCutoff, time);
      filter.frequency.exponentialRampToValueAtTime(peakCutoff, time + attack);
      filter.frequency.exponentialRampToValueAtTime(baseCutoff, time + attack + decay);
    });
    this.attachAutoCutoff([filterA, filterB], time);

    const peak = 0.72 * accent;
    const sustain = Math.max(BASS_GAIN_FLOOR, peak * synth.sustain);
    const attackEnd = time + attack;
    const decayEnd = attackEnd + decay;
    amp.gain.value = 0;
    amp.gain.setValueAtTime(0, time);

    // End attack/decay at note-off, releasing from the level actually reached.
    // A later decay event must never raise the gain again after release.
    if (gateEnd <= attackEnd) {
      const gateLevel = peak * (gateEnd - time) / attack;
      amp.gain.linearRampToValueAtTime(gateLevel, gateEnd);
    } else {
      amp.gain.linearRampToValueAtTime(peak, attackEnd);
      if (gateEnd < decayEnd) {
        const progress = (gateEnd - attackEnd) / decay;
        const gateLevel = peak * Math.pow(sustain / peak, progress);
        amp.gain.exponentialRampToValueAtTime(gateLevel, gateEnd);
      } else {
        amp.gain.exponentialRampToValueAtTime(sustain, decayEnd);
        amp.gain.setValueAtTime(sustain, gateEnd);
      }
    }
    amp.gain.exponentialRampToValueAtTime(BASS_GAIN_FLOOR, gateEnd + release);
    amp.gain.linearRampToValueAtTime(0, envelopeEnd);

    osc.connect(oscGain);
    sub.connect(subGain);
    oscGain.connect(drive);
    subGain.connect(drive);
    drive.connect(filterA);
    filterA.connect(filterB);
    filterB.connect(amp);
    amp.connect(fade);
    fade.connect(this.channels.bass.input);

    // Retire the previous mono voice with an independent fade, so its existing
    // ADSR automation stays continuous even if a new note arrives mid-release.
    this.fadeBassVoices(time);
    const voice = { osc, sub, amp, fade, filters: [filterA, filterB], stopAt, fadeAt: Infinity };
    this.bassVoices.add(voice);
    if (diagnostics.enabled) diagnostics.recordScheduledEvent(time, stopAt, this);
    diagnostics.voiceCreatedFor("bass");
    let endedSources = 0;
    const cleanup = () => {
      endedSources += 1;
      if (endedSources !== 2) return;
      osc.onended = sub.onended = null;
      this.detachAutoCutoff(voice.filters);
      [osc, sub, oscGain, subGain, drive, filterA, filterB, amp, fade].forEach((node) => node.disconnect());
      this.bassVoices.delete(voice);
      diagnostics.voiceCleanedFor("bass");
    };
    osc.onended = cleanup;
    sub.onended = cleanup;
    osc.start(time);
    sub.start(time);
    osc.stop(stopAt);
    sub.stop(stopAt);
    return voice;
  }

  fadeBassVoices(time) {
    if (!this.ctx) return;
    const fadeAt = Math.max(time, this.ctx.currentTime);
    this.bassVoices.forEach((voice) => {
      if (voice.stopAt <= fadeAt || voice.fadeAt <= fadeAt) return;
      const fadeEnd = Math.min(voice.stopAt, fadeAt + BASS_FADE_TIME);
      voice.fade.gain.cancelScheduledValues(fadeAt);
      voice.fade.gain.setValueAtTime(1, fadeAt);
      voice.fade.gain.linearRampToValueAtTime(0, fadeEnd);
      voice.fadeAt = fadeAt;
      voice.stopAt = Math.min(voice.stopAt, fadeEnd + 0.004);
      voice.osc.stop(voice.stopAt);
      voice.sub.stop(voice.stopAt);
    });
  }

  stopBassVoices() {
    this.bassPreviewRequest += 1;
    if (this.ctx) this.fadeBassVoices(this.ctx.currentTime);
  }

  async previewDrum(track, level = 1) {
    if (state.playing || state.starting) return;
    const request = {};
    this.drumPreviewRequests[track] = request;
    await this.init();
    if (this.drumPreviewRequests[track] !== request || state.playing || state.starting) return;
    refreshVisualVisibility();
    updateMeterAnimation();
    this.updateEffectSend(track, "delay");
    this.updateEffectSend(track, "chorus");
    this.updateEffectSend(track, "phaser");
    this.updateEffectSend(track, "flanger");
    this.updateEffectSend(track, "reverb");
    const time = this.ctx.currentTime + 0.012;
    this.fadeDrumVoices(time, track);
    return this.scheduleDrum(track, time, level);
  }

  async previewBass(step) {
    // While playing, edited notes are heard through the sequencer only.
    if (state.playing || state.starting) return;
    const request = ++this.bassPreviewRequest;
    const previewStep = { ...step, active: true };
    await this.init();
    if (request !== this.bassPreviewRequest || state.playing || state.starting) return;
    refreshVisualVisibility();
    updateMeterAnimation();
    this.updateEffectSend("bass", "delay");
    this.updateEffectSend("bass", "chorus");
    this.updateEffectSend("bass", "phaser");
    this.updateEffectSend("bass", "flanger");
    this.updateEffectSend("bass", "reverb");
    return this.scheduleBass(previewStep, this.ctx.currentTime + 0.012, 0.34, null);
  }
}

const engine = new AudioEngine();
let schedulerTimer = null;
let transportRequest = 0;
let nextStepTime = 0;
let stepToSchedule = 0;
let transportStartTime = 0;
let nextArpTime = 0;
let arpStepIndex = 0;
let lastRandomArpMidi = null;
let previousBassMidi = null;
let previousStepHadBass = false;
const PLAYHEAD_QUEUE_SIZE = 16;
const pendingPlayheadSteps = new Int8Array(PLAYHEAD_QUEUE_SIZE);
const pendingPlayheadTimes = new Float64Array(PLAYHEAD_QUEUE_SIZE);
let pendingPlayheadRead = 0;
let pendingPlayheadWrite = 0;
let pendingPlayheadCount = 0;
let playheadAnimationFrame = null;
let renderedPlayheadStep = -1;
const playheadElements = {
  position: [],
  drums: Object.fromEntries(TRACKS.map(({ id }) => [id, []])),
  bass: [],
};
const pendingControlUpdates = new Set();
const coalescedRangeBindings = new WeakMap();
let controlAnimationFrame = null;
let activeTab = "drums";
const computerJunoHeld = new Map();
let meterAnimationFrame = null;
let lastMeterFrame = -Infinity;
let scopeData = null;
let masterMeterData = null;
let visualVisibility = { scope: false, meter: false };
let masterClipHoldUntil = 0;
let wakeLock = null;
let toastTimer = null;
let tapTimes = [];
let diagnosticInputStartedAt = 0;
let diagnosticsInputListenersInstalled = false;
let diagnosticsContextWithListeners = null;

function flushCoalescedControls(timestamp) {
  controlAnimationFrame = null;
  const diagnosticStartedAt = diagnostics.begin();
  pendingControlUpdates.forEach((pending) => {
    pending.queued = false;
    if (pending.value !== pending.lastApplied) {
      pending.apply(pending.value);
      pending.lastApplied = pending.value;
    }
  });
  pendingControlUpdates.clear();
  diagnostics.end("controlFlush", diagnosticStartedAt);
}

function queueCoalescedControl(pending, value) {
  pending.value = value;
  if (value === pending.lastApplied) {
    if (pending.queued) {
      pendingControlUpdates.delete(pending);
      pending.queued = false;
      if (pendingControlUpdates.size === 0 && controlAnimationFrame !== null) {
        window.cancelAnimationFrame(controlAnimationFrame);
        controlAnimationFrame = null;
      }
    }
    return;
  }
  if (!pending.queued) {
    pending.queued = true;
    pendingControlUpdates.add(pending);
  }
  if (controlAnimationFrame === null) controlAnimationFrame = window.requestAnimationFrame(flushCoalescedControls);
}

function flushCoalescedControl(pending) {
  if (!pending.queued) return;
  pendingControlUpdates.delete(pending);
  pending.queued = false;
  if (pending.value !== pending.lastApplied) {
    pending.apply(pending.value);
    pending.lastApplied = pending.value;
  }
  if (pendingControlUpdates.size === 0 && controlAnimationFrame !== null) {
    window.cancelAnimationFrame(controlAnimationFrame);
    controlAnimationFrame = null;
  }
}

function syncCoalescedRange(input, value = input?.value) {
  const pending = input ? coalescedRangeBindings.get(input) : null;
  if (!pending) return String(value);
  // A user gesture already queued for this range wins over a simultaneous
  // visual rehydration. Apply it first, then make that effective value the
  // synchronized baseline instead of silently discarding the gesture.
  const hadPendingGesture = pending.queued;
  if (hadPendingGesture) flushCoalescedControl(pending);
  const synchronizedValue = hadPendingGesture ? pending.lastApplied : String(value);
  if (hadPendingGesture) input.value = synchronizedValue;
  pending.value = synchronizedValue;
  pending.lastApplied = synchronizedValue;
  return synchronizedValue;
}

function bindCoalescedRange(input, apply, renderValue = null) {
  const pending = { value: input.value, lastApplied: input.value, apply, queued: false };
  coalescedRangeBindings.set(input, pending);
  const enqueue = () => {
    const value = input.value;
    if (renderValue) renderValue(value);
    queueCoalescedControl(pending, value);
  };
  const flush = () => {
    if (input.value !== pending.value || input.value !== pending.lastApplied) enqueue();
    flushCoalescedControl(pending);
  };
  input.addEventListener("input", enqueue);
  ["change", "pointerup", "pointercancel", "blur"].forEach((eventName) => input.addEventListener(eventName, flush));
  return pending;
}

const dom = {
  play: document.getElementById("playButton"),
  stop: document.getElementById("stopButton"),
  engineState: document.getElementById("engineState"),
  bpm: document.getElementById("bpmInput"),
  swing: document.getElementById("swingControl"),
  swingValue: document.getElementById("swingValue"),
  master: document.getElementById("masterControl"),
  masterValue: document.getElementById("masterValue"),
  masterOutput: document.getElementById("masterOutputControl"),
  masterOutputValue: document.getElementById("masterOutputValue"),
  masterReductionBar: document.getElementById("masterReductionBar"),
  masterReductionValue: document.getElementById("masterReductionValue"),
  masterPeakBar: document.getElementById("masterPeakBar"),
  masterPeakValue: document.getElementById("masterPeakValue"),
  masterClipLamp: document.getElementById("masterClipLamp"),
  positionLeds: document.getElementById("positionLeds"),
  beatCounter: document.getElementById("beatCounter"),
  drumSequencer: document.getElementById("drumSequencer"),
  bassSequencer: document.getElementById("bassSequencer"),
  noteKeyboard: document.getElementById("noteKeyboard"),
  selectedStepNumber: document.getElementById("selectedStepNumber"),
  selectedNoteName: document.getElementById("selectedNoteName"),
  bassGate: document.getElementById("bassGateToggle"),
  bassAccent: document.getElementById("bassAccentToggle"),
  bassSlide: document.getElementById("bassSlideToggle"),
  junoKeyboard: document.getElementById("junoKeyboard"),
  junoVoiceLeds: document.getElementById("junoVoiceLeds"),
  junoArpStatus: document.getElementById("junoArpStatus"),
  fxChannelNumber: document.getElementById("fxChannelNumber"),
  fxChannelName: document.getElementById("fxChannelName"),
  processorChannelNumber: document.getElementById("processorChannelNumber"),
  processorChannelName: document.getElementById("processorChannelName"),
  reductionMeterBar: document.getElementById("reductionMeterBar"),
  reductionMeterValue: document.getElementById("reductionMeterValue"),
  canvas: document.getElementById("oscilloscope"),
  toast: document.getElementById("toast"),
  wakeLockToggle: document.getElementById("wakeLockToggle"),
};

function renderPositionLeds() {
  dom.positionLeds.replaceChildren();
  playheadElements.position.length = 0;
  for (let index = 0; index < 16; index += 1) {
    const led = document.createElement("span");
    led.className = `position-led${index % 4 === 0 ? " is-beat" : ""}`;
    led.dataset.step = String(index);
    dom.positionLeds.append(led);
    playheadElements.position[index] = led;
  }
}

function renderDrumSequencer() {
  dom.drumSequencer.replaceChildren();
  TRACKS.forEach(({ id }) => { playheadElements.drums[id].length = 0; });
  const corner = document.createElement("div");
  corner.className = "step-number";
  corner.textContent = "VOICE";
  dom.drumSequencer.append(corner);

  for (let step = 0; step < 16; step += 1) {
    const number = document.createElement("div");
    number.className = `step-number${step % 4 === 0 ? " is-beat" : ""}`;
    number.textContent = String(step + 1).padStart(2, "0");
    dom.drumSequencer.append(number);
  }

  TRACKS.forEach((track) => {
    const label = document.createElement("div");
    label.className = "track-label";
    label.style.setProperty("--track-color", track.color);
    const name = document.createElement("span");
    name.textContent = track.label;
    const mute = document.createElement("button");
    mute.type = "button";
    mute.className = `mute-key${state.mutes[track.id] ? " is-muted" : ""}`;
    mute.textContent = "M";
    mute.dataset.mute = track.id;
    mute.setAttribute("aria-label", `${state.mutes[track.id] ? "Activar" : "Silenciar"} ${track.label}`);
    mute.setAttribute("aria-pressed", String(state.mutes[track.id]));
    label.append(name, mute);
    dom.drumSequencer.append(label);

    state.drumPattern[track.id].forEach((level, step) => {
      const button = document.createElement("button");
      const levelName = level === 0 ? "apagado" : level === 1 ? "golpe" : "acento";
      button.type = "button";
      button.className = [
        "drum-step",
        level > 0 ? "is-active" : "",
        level === 2 ? "is-accent" : "",
        step === state.currentStep ? "is-current" : "",
        step > 0 && step % 4 === 0 ? "is-quarter" : "",
      ].filter(Boolean).join(" ");
      button.dataset.track = track.id;
      button.dataset.step = String(step);
      button.setAttribute("aria-label", `${track.label}, paso ${step + 1}: ${levelName}`);
      button.setAttribute("aria-pressed", String(level > 0));
      dom.drumSequencer.append(button);
      playheadElements.drums[track.id][step] = button;
    });
  });
}

function configurePianoKey(button, midi, startMidi, octaveCount) {
  const relative = midi - startMidi;
  const octave = Math.floor(relative / 12);
  const pitch = ((midi % 12) + 12) % 12;
  const whiteCount = octaveCount * 7;
  const isBlack = BLACK_NOTES.has(pitch);
  const keyIndex = octave * 7 + (isBlack ? BLACK_KEY_AFTER.get(pitch) : WHITE_KEY_INDEX.get(pitch));
  const widthInWhiteKeys = isBlack ? 0.62 : 1;
  const leftInWhiteKeys = isBlack ? keyIndex + 1 - widthInWhiteKeys / 2 : keyIndex;
  button.style.setProperty("--key-left", `${leftInWhiteKeys / whiteCount * 100}%`);
  button.style.setProperty("--key-width", `${widthInWhiteKeys / whiteCount * 100}%`);
  button.style.setProperty("--key-layer", isBlack ? "3" : "1");
  return isBlack;
}

function appendPianoLabels(button, note, shortcut = "") {
  const noteLabel = document.createElement("span");
  noteLabel.className = "piano-note-label";
  noteLabel.textContent = note;
  button.append(noteLabel);
  if (!shortcut) return;
  const shortcutLabel = document.createElement("kbd");
  shortcutLabel.className = "piano-shortcut";
  shortcutLabel.textContent = shortcut;
  button.append(shortcutLabel);
}

function renderNoteKeyboard() {
  dom.noteKeyboard.replaceChildren();
  const bed = document.createElement("div");
  bed.className = "piano-bed bass-piano-bed";
  const selectedMidi = state.bassPattern[state.selectedBassStep].midi;
  const selectedPitch = ((selectedMidi % 12) + 12) % 12;
  NOTE_NAMES.forEach((name, pitch) => {
    const button = document.createElement("button");
    button.type = "button";
    const isBlack = configurePianoKey(button, 60 + pitch, 60, 1);
    button.className = ["note-key", "piano-key", isBlack ? "is-black" : "", selectedPitch === pitch ? "is-selected" : ""].filter(Boolean).join(" ");
    button.dataset.pitch = String(pitch);
    button.setAttribute("aria-label", `Asignar nota ${name}`);
    appendPianoLabels(button, name);
    bed.append(button);
  });
  dom.noteKeyboard.append(bed);
}

function renderBassSequencer() {
  dom.bassSequencer.replaceChildren();
  playheadElements.bass.length = 0;
  state.bassPattern.forEach((step, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = [
      "bass-step",
      step.active ? "is-active" : "",
      step.active && step.accent ? "is-accent" : "",
      state.selectedBassStep === index ? "is-selected" : "",
      state.currentStep === index ? "is-current" : "",
    ].filter(Boolean).join(" ");
    button.dataset.bassStep = String(index);
    button.setAttribute("aria-label", `Paso ${index + 1}: ${step.active ? midiToName(step.midi) : "apagado"}${step.accent ? ", acento" : ""}${step.slide ? ", slide" : ""}`);
    const number = document.createElement("span");
    number.className = "bass-index";
    number.textContent = String(index + 1).padStart(2, "0");
    const note = document.createElement("span");
    note.className = "bass-note";
    note.textContent = step.active ? midiToName(step.midi) : "—";
    const flags = document.createElement("span");
    flags.className = "bass-flags";
    flags.textContent = [step.active && step.accent ? "ACCENT" : "", step.active && step.slide ? "SLIDE" : ""].filter(Boolean).join(" · ");
    button.append(number, note, flags);
    dom.bassSequencer.append(button);
    playheadElements.bass[index] = button;
  });
}

function updateToggle(button, on, onLabel, offLabel = onLabel) {
  button.classList.toggle("is-on", on);
  button.setAttribute("aria-pressed", String(on));
  button.textContent = on ? onLabel : offLabel;
}

function renderBassEditor() {
  const step = state.bassPattern[state.selectedBassStep];
  const octave = Math.floor(step.midi / 12) - 1;
  dom.selectedStepNumber.textContent = String(state.selectedBassStep + 1).padStart(2, "0");
  dom.selectedNoteName.textContent = midiToName(step.midi);
  updateToggle(dom.bassGate, step.active, "NOTA ON", "NOTA OFF");
  updateToggle(dom.bassAccent, step.accent, "ACENTO");
  updateToggle(dom.bassSlide, step.slide, "SLIDE");
  document.querySelectorAll(".octave-key").forEach((button) => {
    const active = Number(button.dataset.octave) === octave;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  renderNoteKeyboard();
}

function renderJunoKeyboard() {
  if (!dom.junoKeyboard) return;
  dom.junoKeyboard.replaceChildren();
  const bed = document.createElement("div");
  bed.className = "piano-bed juno-piano-bed";
  for (let midi = 60; midi < 84; midi += 1) {
    const button = document.createElement("button");
    button.type = "button";
    const isBlack = configurePianoKey(button, midi, 60, 2);
    button.className = `juno-key piano-key${isBlack ? " is-black" : ""}`;
    button.dataset.junoMidi = String(midi);
    button.setAttribute("aria-label", `Tocar ${midiToName(midi)} en J-4`);
    appendPianoLabels(button, midiToName(midi), COMPUTER_JUNO_LABELS.get(midi));
    bed.append(button);
  }
  dom.junoKeyboard.append(bed);
}

function renderJunoVoiceLeds() {
  if (!dom.junoVoiceLeds) return;
  const now = engine.ctx?.currentTime || 0;
  const active = [...engine.junoVoices].filter((voice) => !voice.retiring && (
    voice.origin === "arp-pool" ? voice.arpActiveUntil > now : voice.releasedAt > now
  )).length;
  [...dom.junoVoiceLeds.children].forEach((led, index) => led.classList.toggle("is-on", index < active));
  dom.junoVoiceLeds.setAttribute("aria-label", `${active} de ${JUNO_POLYPHONY} voces activas`);
}

function getJunoArpNotes() {
  const source = state.juno.arp.hold ? engine.junoLatchedNotes : engine.junoInputNotes;
  return buildArpSequence([...source.values()], state.juno.arp.mode, state.juno.arp.octaves);
}

function renderJunoArp() {
  const arp = state.juno.arp;
  document.querySelectorAll("[data-juno-arp-toggle]").forEach((button) => {
    const name = button.dataset.junoArpToggle;
    const enabled = Boolean(arp[name]);
    button.classList.toggle("is-on", enabled);
    button.setAttribute("aria-pressed", String(enabled));
    button.textContent = name === "enabled" ? (enabled ? "ARP ON" : "ARP OFF") : "HOLD";
  });
  document.querySelectorAll("[data-juno-arp-mode]").forEach((button) => {
    const active = button.dataset.junoArpMode === arp.mode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-checked", String(active));
  });
  document.querySelectorAll("[data-juno-arp-division]").forEach((button) => {
    const active = button.dataset.junoArpDivision === arp.division;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-checked", String(active));
  });
  document.querySelectorAll("[data-juno-arp-octaves]").forEach((button) => {
    const active = Number(button.dataset.junoArpOctaves) === arp.octaves;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-checked", String(active));
  });
  const gate = [...document.querySelectorAll("[data-juno-arp-gate]")][0];
  if (gate) {
    const input = gate.querySelector("input");
    input.value = String(Math.round(arp.gate * 100));
    const raw = Number(syncCoalescedRange(input));
    gate.querySelector("output").textContent = `${Math.round(raw)}%`;
    rangeFill(input);
  }
  if (dom.junoArpStatus) {
    const notes = getJunoArpNotes();
    dom.junoArpStatus.textContent = !arp.enabled ? "BYPASS"
      : !notes.length ? "WAITING FOR NOTES"
        : state.playing ? `${notes.length} NOTE${notes.length === 1 ? "" : "S"} · CLOCKED`
          : `${notes.length} NOTE${notes.length === 1 ? "" : "S"} · PRESS PLAY`;
  }
}

function formatJunoOutput(name, rawValue) {
  const value = Number(rawValue);
  if (["sub", "pulseWidth", "pwmAmount", "sustain", "lfoPitch", "lfoFilter"].includes(name)) return `${Math.round(value)}%`;
  if (["attack", "decay", "release"].includes(name)) return `${Math.round(value)} ms`;
  if (name === "resonance") return value.toFixed(1);
  if (name === "fineTune") return `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(Math.round(value))} ct`;
  if (name === "lfoRate") return `${(value / 100).toFixed(2)} Hz`;
  if (name === "envAmount") {
    const sign = value > 0 ? "+" : value < 0 ? "−" : "";
    return `${sign}${Math.abs(value) >= 1000 ? `${(Math.abs(value) / 1000).toFixed(1)} kHz` : `${Math.abs(Math.round(value))} Hz`}`;
  }
  return value >= 1000 ? `${(value / 1000).toFixed(1)} kHz` : `${Math.round(value)} Hz`;
}

function junoStateValue(name, rawValue) {
  const value = Number(rawValue);
  if (["attack", "decay", "release"].includes(name)) return value / 1000;
  if (["sub", "pulseWidth", "pwmAmount", "sustain", "lfoPitch", "lfoFilter"].includes(name)) return value / 100;
  if (name === "lfoRate") return value / 100;
  return value;
}

function applyJunoControl(name, rawValue) {
  if (diagnostics.enabled) diagnostics.recordControl(`J-4 ${name}`);
  state.juno[name] = junoStateValue(name, rawValue);
  // Attack defines future envelopes only; FILTER LFO owns only the shared
  // modulation depth, so neither route touches a voice cutoff envelope.
  if (name === "lfoFilter") engine.updateJunoUnit("lfoFilter");
  else if (name === "sub" || name === "pulseWidth" || name === "pwmAmount" || name === "highPass"
    || name === "cutoff" || name === "resonance" || name === "envAmount" || name === "lfoRate" || name === "lfoPitch") {
    engine.updateJunoVoices(name);
  }
}

function applyJunoArpGate(rawValue) {
  if (diagnostics.enabled) diagnostics.recordControl("J-4 ARP GATE");
  state.juno.arp.gate = Number(rawValue) / 100;
}

function renderJunoControls() {
  document.querySelectorAll("[data-juno-toggle]").forEach((button) => {
    const enabled = Boolean(state.juno[button.dataset.junoToggle]);
    button.classList.toggle("is-on", enabled);
    button.setAttribute("aria-pressed", String(enabled));
  });
  document.querySelectorAll("[data-juno-octave]").forEach((button) => {
    const active = Number(button.dataset.junoOctave) === state.juno.octave;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-checked", String(active));
  });
  document.querySelectorAll("[data-juno-chorus]").forEach((button) => {
    const active = button.dataset.junoChorus === state.juno.chorusMode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-checked", String(active));
  });
  document.querySelectorAll("[data-juno-control]").forEach((control) => {
    const name = control.dataset.junoControl;
    const input = control.querySelector("input");
    const raw = ["attack", "decay", "release"].includes(name) ? state.juno[name] * 1000
      : ["sub", "pulseWidth", "pwmAmount", "sustain", "lfoPitch", "lfoFilter"].includes(name) ? state.juno[name] * 100
        : name === "lfoRate" ? state.juno[name] * 100 : state.juno[name];
    input.value = String(raw);
    const effectiveRaw = syncCoalescedRange(input);
    control.querySelector("output").textContent = formatJunoOutput(name, effectiveRaw);
    rangeFill(input);
  });
  renderJunoVoiceLeds();
  renderJunoArp();
}

function bindJunoControls() {
  document.querySelectorAll("[data-juno-arp-toggle]").forEach((button) => {
    button.addEventListener("click", () => {
      const name = button.dataset.junoArpToggle;
      if (name === "enabled") engine.setJunoArpEnabled(!state.juno.arp.enabled);
      else {
        state.juno.arp.hold = !state.juno.arp.hold;
        if (!state.juno.arp.hold) {
          engine.junoLatchedNotes = new Map(engine.junoInputNotes);
          engine.junoArpAwaitingChord = engine.junoInputNotes.size === 0;
        }
      }
      renderJunoArp();
    });
  });
  document.querySelectorAll("[data-juno-arp-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      state.juno.arp.mode = button.dataset.junoArpMode;
      arpStepIndex = 0;
      lastRandomArpMidi = null;
      renderJunoArp();
    });
  });
  document.querySelectorAll("[data-juno-arp-division]").forEach((button) => {
    button.addEventListener("click", () => {
      state.juno.arp.division = button.dataset.junoArpDivision;
      resetArpClock();
      renderJunoArp();
    });
  });
  document.querySelectorAll("[data-juno-arp-octaves]").forEach((button) => {
    button.addEventListener("click", () => {
      state.juno.arp.octaves = Number(button.dataset.junoArpOctaves);
      arpStepIndex = 0;
      renderJunoArp();
    });
  });
  const arpGate = [...document.querySelectorAll("[data-juno-arp-gate]")][0];
  if (arpGate) {
    const input = arpGate.querySelector("input");
    const output = arpGate.querySelector("output");
    bindCoalescedRange(input, applyJunoArpGate, (raw) => {
      output.textContent = `${Math.round(Number(raw))}%`;
      rangeFill(input);
    });
  }
  document.querySelectorAll("[data-juno-toggle]").forEach((button) => {
    button.addEventListener("click", () => {
      const name = button.dataset.junoToggle;
      state.juno[name] = !state.juno[name];
      // Never allow a completely silent DCO by accident.
      const forcedPulse = !state.juno.saw && !state.juno.pulse && state.juno.sub <= 0;
      if (forcedPulse) state.juno.pulse = true;
      engine.updateJunoVoices(name);
      // The safeguard can change PULSE while the user clicked SAW. Update its
      // live gain too, so state, UI, and held/ARP voices cannot diverge.
      if (forcedPulse && name !== "pulse") engine.updateJunoVoices("pulse");
      renderJunoControls();
    });
  });
  document.querySelectorAll("[data-juno-octave]").forEach((button) => {
    button.addEventListener("click", () => {
      state.juno.octave = Number(button.dataset.junoOctave);
      engine.stopJunoVoices(false);
      renderJunoControls();
    });
  });
  document.querySelectorAll("[data-juno-chorus]").forEach((button) => {
    button.addEventListener("click", () => {
      state.juno.chorusMode = button.dataset.junoChorus;
      engine.updateJunoUnit("chorusMode");
      renderJunoControls();
    });
  });
  document.querySelectorAll("[data-juno-control]").forEach((control) => {
    const input = control.querySelector("input");
    const name = control.dataset.junoControl;
    bindCoalescedRange(input, (raw) => applyJunoControl(name, Number(raw)), (raw) => {
      control.querySelector("output").textContent = formatJunoOutput(name, raw);
      rangeFill(input);
    });
  });
  if (dom.junoKeyboard) {
    const release = (button, pointerId) => {
      if (!button) return;
      const midi = Number(button.dataset.junoMidi);
      button.classList.remove("is-held");
      engine.releaseJunoKey(midi, pointerId);
    };
    dom.junoKeyboard.addEventListener("pointerdown", (event) => {
      const button = event.target.closest(".juno-key");
      if (!button) return;
      event.preventDefault();
      button.setPointerCapture?.(event.pointerId);
      button.classList.add("is-held");
      engine.pressJunoKey(Number(button.dataset.junoMidi), event.pointerId).catch(() => {});
    });
    ["pointerup", "pointercancel", "lostpointercapture"].forEach((type) => {
      dom.junoKeyboard.addEventListener(type, (event) => release(event.target.closest(".juno-key"), event.pointerId));
    });
    dom.junoKeyboard.addEventListener("keydown", (event) => {
      const button = event.target.closest(".juno-key");
      if (!button || !["Enter", " "].includes(event.key) || event.repeat) return;
      event.preventDefault();
      button.classList.add("is-held");
      engine.pressJunoKey(Number(button.dataset.junoMidi), `key-${button.dataset.junoMidi}`).catch(() => {});
    });
    dom.junoKeyboard.addEventListener("keyup", (event) => {
      const button = event.target.closest(".juno-key");
      if (!button || !["Enter", " "].includes(event.key)) return;
      event.preventDefault();
      release(button, `key-${button.dataset.junoMidi}`);
    });
  }
  document.addEventListener("keydown", handleComputerJunoKeyDown);
  document.addEventListener("keyup", handleComputerJunoKeyUp);
  window.addEventListener("blur", releaseAllComputerJunoKeys);
  renderJunoControls();
}

function computerKeyboardTargetIsEditable(target) {
  return ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName) || Boolean(target?.isContentEditable);
}

function setJunoKeyVisual(midi, held) {
  dom.junoKeyboard?.querySelector(`[data-juno-midi="${midi}"]`)?.classList.toggle("is-held", held);
}

function handleComputerJunoKeyDown(event) {
  const midi = COMPUTER_JUNO_KEYS.get(event.code);
  if (activeTab !== "juno" || midi === undefined || event.repeat || event.metaKey || event.ctrlKey || event.altKey
    || computerKeyboardTargetIsEditable(event.target) || computerJunoHeld.has(event.code)) return;
  event.preventDefault();
  computerJunoHeld.set(event.code, midi);
  setJunoKeyVisual(midi, true);
  engine.pressJunoKey(midi, `computer-${event.code}`).catch(() => {
    computerJunoHeld.delete(event.code);
    setJunoKeyVisual(midi, false);
  });
}

function releaseComputerJunoKey(code) {
  const midi = computerJunoHeld.get(code);
  if (midi === undefined) return;
  computerJunoHeld.delete(code);
  setJunoKeyVisual(midi, false);
  engine.releaseJunoKey(midi, `computer-${code}`);
}

function handleComputerJunoKeyUp(event) {
  if (!COMPUTER_JUNO_KEYS.has(event.code)) return;
  if (computerJunoHeld.has(event.code)) event.preventDefault();
  releaseComputerJunoKey(event.code);
}

function releaseAllComputerJunoKeys() {
  [...computerJunoHeld.keys()].forEach(releaseComputerJunoKey);
}

function renderPlayhead(step) {
  const diagnosticStartedAt = diagnostics.begin();
  const previousStep = renderedPlayheadStep;
  if (previousStep === step) {
    diagnostics.end("playheadRender", diagnosticStartedAt);
    return;
  }
  state.currentStep = step;
  playheadElements.position[previousStep]?.classList.remove("is-current");
  playheadElements.bass[previousStep]?.classList.remove("is-current");
  TRACKS.forEach(({ id }) => playheadElements.drums[id][previousStep]?.classList.remove("is-current"));
  playheadElements.position[step]?.classList.add("is-current");
  playheadElements.bass[step]?.classList.add("is-current");
  TRACKS.forEach(({ id }) => playheadElements.drums[id][step]?.classList.add("is-current"));
  renderedPlayheadStep = step;
  dom.beatCounter.textContent = `${Math.floor(step / 4) + 1}.${(step % 4) + 1}`;
  diagnostics.end("playheadRender", diagnosticStartedAt);
}

function clearPlayhead() {
  state.currentStep = -1;
  playheadElements.position[renderedPlayheadStep]?.classList.remove("is-current");
  playheadElements.bass[renderedPlayheadStep]?.classList.remove("is-current");
  TRACKS.forEach(({ id }) => playheadElements.drums[id][renderedPlayheadStep]?.classList.remove("is-current"));
  renderedPlayheadStep = -1;
  dom.beatCounter.textContent = "1.1";
}

function queuePlayhead(step, audioTime) {
  if (pendingPlayheadCount === PLAYHEAD_QUEUE_SIZE) {
    pendingPlayheadRead = (pendingPlayheadRead + 1) % PLAYHEAD_QUEUE_SIZE;
    pendingPlayheadCount -= 1;
  }
  pendingPlayheadSteps[pendingPlayheadWrite] = step;
  pendingPlayheadTimes[pendingPlayheadWrite] = audioTime;
  pendingPlayheadWrite = (pendingPlayheadWrite + 1) % PLAYHEAD_QUEUE_SIZE;
  pendingPlayheadCount += 1;
  if (playheadAnimationFrame === null) playheadAnimationFrame = window.requestAnimationFrame(flushPlayhead);
}

function flushPlayhead(timestamp) {
  playheadAnimationFrame = null;
  diagnostics.recordAnimationFrame(timestamp);
  if (!state.playing || !engine.ctx) {
    pendingPlayheadRead = 0;
    pendingPlayheadWrite = 0;
    pendingPlayheadCount = 0;
    return;
  }
  let step = -1;
  const visualLead = 0.012;
  while (pendingPlayheadCount > 0 && pendingPlayheadTimes[pendingPlayheadRead] <= engine.ctx.currentTime + visualLead) {
    step = pendingPlayheadSteps[pendingPlayheadRead];
    pendingPlayheadRead = (pendingPlayheadRead + 1) % PLAYHEAD_QUEUE_SIZE;
    pendingPlayheadCount -= 1;
  }
  if (step >= 0) renderPlayhead(step);
  if (pendingPlayheadCount > 0) playheadAnimationFrame = window.requestAnimationFrame(flushPlayhead);
}

function resetSnareBreak() {
  Object.assign(state.snareBreak, {
    status: "idle", startTime: null, startStep: null, stepsScheduled: 0, totalSteps: 0, activeMode: null,
  });
}

function scheduleSnareBreakStep(step, time) {
  const performance = state.snareBreak;
  if (performance.status === "armed") {
    if (step % 4 !== 0) return { suppressPattern: false };
    performance.status = "active";
    performance.startTime = time;
    performance.startStep = step;
    performance.stepsScheduled = 0;
    renderDirectControls();
  }
  if (performance.status === "cancelRequested" && step % 4 === 0) {
    resetSnareBreak();
    renderDirectControls();
    return { suppressPattern: false };
  }
  if (performance.status !== "active" && performance.status !== "cancelRequested") return { suppressPattern: false };

  const progress = performance.totalSteps <= 1 ? 1 : performance.stepsScheduled / (performance.totalSteps - 1);
  const velocity = SNARE_BREAK_START_VELOCITY + (SNARE_BREAK_TARGET_VELOCITY - SNARE_BREAK_START_VELOCITY) * progress;
  engine.scheduleDrum("snare", time, 1, velocity);
  performance.stepsScheduled += 1;
  const suppressPattern = performance.activeMode === "ONLY";
  if (performance.stepsScheduled >= performance.totalSteps) {
    resetSnareBreak();
    renderDirectControls();
  }
  return { suppressPattern };
}

function scheduleStep(step, time) {
  const snareBreak = scheduleSnareBreakStep(step, time);
  if (!snareBreak.suppressPattern) {
    TRACKS.forEach(({ id }) => engine.scheduleDrum(id, time, state.drumPattern[id][step]));
  }

  const bassStep = state.bassPattern[step];
  if (bassStep.active) {
    const baseDuration = 60 / state.bpm / 4;
    const nextPatternStep = state.bassPattern[(step + 1) % 16];
    const extendsIntoSlide = nextPatternStep.active && nextPatternStep.slide;
    const duration = baseDuration * (extendsIntoSlide ? 1.16 : 0.88);
    engine.scheduleBass(bassStep, time, duration, previousStepHadBass ? previousBassMidi : null);
    previousBassMidi = bassStep.midi;
    previousStepHadBass = true;
  } else {
    previousStepHadBass = false;
  }
  queuePlayhead(step, time);
}

function advanceStep() {
  const secondsPerSixteenth = 60 / state.bpm / 4;
  const swing = state.swing / 100;
  const interval = secondsPerSixteenth * (stepToSchedule % 2 === 0 ? 2 * swing : 2 * (1 - swing));
  nextStepTime += interval;
  stepToSchedule = (stepToSchedule + 1) % 16;
}

function getArpInterval() {
  return 60 / clamp(state.bpm, 50, 190) * (ARP_DIVISION_BEATS[state.juno.arp.division] || 0.5);
}

function resetArpClock() {
  arpStepIndex = 0;
  lastRandomArpMidi = null;
  if (!engine.ctx || !state.playing) {
    nextArpTime = 0;
    return;
  }
  const interval = getArpInterval();
  const earliest = engine.ctx.currentTime + 0.012;
  const elapsed = Math.max(0, earliest - transportStartTime);
  nextArpTime = transportStartTime + Math.ceil(elapsed / interval) * interval;
}

function chooseArpNote(notes) {
  if (!notes.length) return null;
  if (state.juno.arp.mode !== "RANDOM") {
    const note = notes[arpStepIndex % notes.length];
    arpStepIndex += 1;
    return note;
  }
  let candidates = notes;
  if (notes.length > 1 && lastRandomArpMidi !== null) candidates = notes.filter((note) => note !== lastRandomArpMidi);
  const note = candidates[Math.floor(Math.random() * candidates.length)];
  lastRandomArpMidi = note;
  return note;
}

function scheduleArpeggiator(now, horizon, collectEventCount = false) {
  if (!state.juno.arp.enabled) return 0;
  const interval = getArpInterval();
  const earliest = now + 0.005;
  if (!nextArpTime) resetArpClock();
  if (nextArpTime < earliest) {
    const missed = Math.ceil((earliest - nextArpTime) / interval);
    nextArpTime += missed * interval;
    arpStepIndex += missed;
  }
  let scheduledEvents = 0;
  while (nextArpTime < horizon) {
    const notes = getJunoArpNotes();
    const midi = chooseArpNote(notes);
    if (midi !== null) {
      engine.scheduleJunoNote(midi, nextArpTime, interval * state.juno.arp.gate, false, "arp", interval);
      if (collectEventCount) scheduledEvents += 1;
    }
    nextArpTime += interval;
  }
  return scheduledEvents;
}

function scheduler() {
  if (!state.playing || !engine.ctx) return;
  const now = engine.ctx.currentTime;
  if (diagnostics.enabled) diagnostics.captureAudioClock(engine);
  const earliest = now + 0.005;
  const diagnosticsEnabled = diagnostics.enabled;
  const latenessMs = diagnosticsEnabled ? Math.max(0, now - nextStepTime) * 1000 : 0;
  let skippedSteps = 0;
  if (nextStepTime < earliest) {
    // UI work can delay this timer. Skip expired beats instead of firing every
    // missed note simultaneously, keeping the original tempo and swing phase.
    const barDuration = 60 / state.bpm * 4;
    const skippedBars = Math.floor((earliest - nextStepTime) / barDuration);
    nextStepTime += skippedBars * barDuration;
    if (diagnosticsEnabled) skippedSteps += skippedBars * 16;
    while (nextStepTime < earliest) {
      advanceStep();
      if (diagnosticsEnabled) skippedSteps += 1;
    }
    previousStepHadBass = false;
    previousBassMidi = null;
  }
  let scheduledEvents = 0;
  while (nextStepTime < now + 0.11) {
    scheduleStep(stepToSchedule, nextStepTime);
    if (diagnosticsEnabled) scheduledEvents += 1;
    advanceStep();
  }
  const arpEvents = scheduleArpeggiator(now, now + 0.11, diagnosticsEnabled);
  if (diagnosticsEnabled) {
    scheduledEvents += arpEvents;
    diagnostics.recordScheduler(now, latenessMs, skippedSteps, Math.max(0, nextStepTime - now) * 1000, scheduledEvents);
  }
}

async function requestWakeLock() {
  if (!dom.wakeLockToggle.checked || !("wakeLock" in navigator) || document.visibilityState !== "visible") return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => { wakeLock = null; });
  } catch {
    wakeLock = null;
  }
}

async function releaseWakeLock() {
  if (!wakeLock) return;
  try { await wakeLock.release(); } catch { /* already released */ }
  wakeLock = null;
}

function updateTransportUI() {
  dom.play.classList.toggle("is-playing", state.playing);
  dom.play.setAttribute("aria-label", state.playing ? "Pausar patrón" : "Reproducir patrón");
  dom.play.querySelector(".transport-icon").textContent = state.playing ? "❚❚" : "▶";
  dom.play.querySelector("span:last-child").textContent = state.playing ? "PAUSE" : "PLAY";
  dom.engineState.classList.toggle("is-running", state.playing);
  dom.engineState.querySelector("span:last-child").textContent = state.playing ? "RUN" : "LISTO";
}

async function startTransport() {
  if (state.playing || state.starting) return;
  state.starting = true;
  const request = ++transportRequest;
  try {
    await engine.init();
    if (request !== transportRequest) return;
    diagnostics.resetAudioClockReference(engine);
    engine.stopVoices(false);
    engine.updateAllEffectSends();
    state.playing = true;
    stepToSchedule = 0;
    previousBassMidi = state.bassPattern[15].active ? state.bassPattern[15].midi : null;
    previousStepHadBass = state.bassPattern[15].active;
    nextStepTime = engine.ctx.currentTime + 0.055;
    transportStartTime = nextStepTime;
    nextArpTime = nextStepTime;
    arpStepIndex = 0;
    lastRandomArpMidi = null;
    engine.updateAutoCutoff(nextStepTime);
    scheduler();
    schedulerTimer = window.setInterval(scheduler, 25);
    updateTransportUI();
    refreshVisualVisibility();
    updateMeterAnimation();
    renderJunoArp();
    requestWakeLock();
  } catch (error) {
    if (request === transportRequest) {
      stopTransport();
      showToast(error.message || "No se ha podido iniciar el audio.");
    }
  } finally {
    if (request === transportRequest) state.starting = false;
  }
}

function stopTransport() {
  transportRequest += 1;
  state.playing = false;
  state.starting = false;
  resetSnareBreak();
  engine.stopVoices();
  if (schedulerTimer) window.clearInterval(schedulerTimer);
  schedulerTimer = null;
  if (playheadAnimationFrame !== null) window.cancelAnimationFrame(playheadAnimationFrame);
  playheadAnimationFrame = null;
  pendingPlayheadRead = 0;
  pendingPlayheadWrite = 0;
  pendingPlayheadCount = 0;
  clearPlayhead();
  updateTransportUI();
  refreshVisualVisibility();
  updateMeterAnimation();
  renderJunoArp();
  renderDirectControls();
  releaseWakeLock();
}

function switchTab(tabName) {
  const diagnosticStartedAt = diagnostics.begin();
  activeTab = tabName;
  const tabs = [...document.querySelectorAll(".tab-button")];
  tabs.forEach((tab) => {
    const active = tab.dataset.tab === tabName;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
  });
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    const active = panel.id === `panel-${tabName}`;
    panel.classList.toggle("is-active", active);
    panel.hidden = !active;
  });
  if (tabName === "directo") renderDirectControls();
  if (tabName === "juno") renderJunoControls();
  if (tabName === "synth") renderSynthControls();
  refreshVisualVisibility();
  updateMeterAnimation();
  diagnostics.end("tabSwitch", diagnosticStartedAt);
}

function showToast(message) {
  window.clearTimeout(toastTimer);
  dom.toast.textContent = message;
  dom.toast.classList.add("is-visible");
  toastTimer = window.setTimeout(() => dom.toast.classList.remove("is-visible"), 2700);
}

function setBpm(value) {
  state.bpm = clamp(Math.round(Number(value) || state.bpm), 50, 190);
  dom.bpm.value = String(state.bpm);
  engine.updateSyncedDelays();
  engine.updateAutoCutoff();
  renderFxParameters();
}

function bindSequencers() {
  dom.drumSequencer.addEventListener("click", (event) => {
    const stepButton = event.target.closest(".drum-step");
    if (stepButton) {
      const track = stepButton.dataset.track;
      const step = Number(stepButton.dataset.step);
      const nextLevel = (state.drumPattern[track][step] + 1) % 3;
      state.drumPattern[track][step] = nextLevel;
      const label = TRACKS.find(({ id }) => id === track).label;
      const levelName = nextLevel === 0 ? "apagado" : nextLevel === 1 ? "golpe" : "acento";
      stepButton.classList.toggle("is-active", nextLevel > 0);
      stepButton.classList.toggle("is-accent", nextLevel === 2);
      stepButton.setAttribute("aria-pressed", String(nextLevel > 0));
      stepButton.setAttribute("aria-label", `${label}, paso ${step + 1}: ${levelName}`);
      if (nextLevel > 0) engine.previewDrum(track, nextLevel).catch(() => {});
      return;
    }

    const muteButton = event.target.closest(".mute-key");
    if (muteButton) {
      const track = muteButton.dataset.mute;
      state.mutes[track] = !state.mutes[track];
      engine.updateChannel(track);
      muteButton.classList.toggle("is-muted", state.mutes[track]);
      muteButton.setAttribute("aria-pressed", String(state.mutes[track]));
      const label = TRACKS.find(({ id }) => id === track).label;
      muteButton.setAttribute("aria-label", `${state.mutes[track] ? "Activar" : "Silenciar"} ${label}`);
    }
  });

  dom.bassSequencer.addEventListener("click", (event) => {
    const button = event.target.closest(".bass-step");
    if (!button) return;
    state.selectedBassStep = Number(button.dataset.bassStep);
    renderBassSequencer();
    renderBassEditor();
    const step = state.bassPattern[state.selectedBassStep];
    if (step.active) engine.previewBass(step).catch(() => {});
  });

  dom.noteKeyboard.addEventListener("click", (event) => {
    const button = event.target.closest(".note-key");
    if (!button) return;
    const selected = state.bassPattern[state.selectedBassStep];
    const currentOctave = Math.floor(selected.midi / 12) - 1;
    selected.midi = (currentOctave + 1) * 12 + Number(button.dataset.pitch);
    selected.active = true;
    renderBassSequencer();
    renderBassEditor();
    engine.previewBass(selected).catch(() => {});
  });

  document.querySelectorAll(".octave-key").forEach((button) => {
    button.addEventListener("click", () => {
      const selected = state.bassPattern[state.selectedBassStep];
      const pitch = ((selected.midi % 12) + 12) % 12;
      selected.midi = (Number(button.dataset.octave) + 1) * 12 + pitch;
      selected.active = true;
      renderBassSequencer();
      renderBassEditor();
      engine.previewBass(selected).catch(() => {});
    });
  });

  dom.bassGate.addEventListener("click", () => {
    const selected = state.bassPattern[state.selectedBassStep];
    selected.active = !selected.active;
    renderBassSequencer();
    renderBassEditor();
    if (selected.active) engine.previewBass(selected).catch(() => {});
    else if (!state.playing) engine.stopBassVoices();
  });

  dom.bassAccent.addEventListener("click", () => {
    const selected = state.bassPattern[state.selectedBassStep];
    selected.active = true;
    selected.accent = !selected.accent;
    renderBassSequencer();
    renderBassEditor();
    engine.previewBass(selected).catch(() => {});
  });

  dom.bassSlide.addEventListener("click", () => {
    const selected = state.bassPattern[state.selectedBassStep];
    selected.active = true;
    selected.slide = !selected.slide;
    renderBassSequencer();
    renderBassEditor();
  });

  document.getElementById("clearDrums").addEventListener("click", () => {
    TRACKS.forEach(({ id }) => state.drumPattern[id].fill(0));
    renderDrumSequencer();
    showToast("Batería vaciada. PATRÓN BASE la recupera.");
  });

  document.getElementById("restoreDrums").addEventListener("click", () => {
    state.drumPattern = cloneDrumPattern();
    renderDrumSequencer();
    showToast("Patrón de batería restaurado.");
  });

  document.getElementById("clearBass").addEventListener("click", () => {
    state.bassPattern.forEach((step) => { step.active = false; step.accent = false; step.slide = false; });
    renderBassSequencer();
    renderBassEditor();
    showToast("Bajo vaciado. PATRÓN BASE lo recupera.");
  });

  document.getElementById("restoreBass").addEventListener("click", () => {
    state.bassPattern = cloneBassPattern();
    state.selectedBassStep = 0;
    renderBassSequencer();
    renderBassEditor();
    showToast("Patrón de bajo restaurado.");
  });
}

function formatSynthOutput(control, rawValue) {
  const value = Number(rawValue);
  if (["cutoff", "envAmount"].includes(control)) return `${Math.round(value)} Hz`;
  if (control === "resonance") return value.toFixed(1);
  if (["attack", "decay", "release", "glide"].includes(control)) return `${Math.round(value)} ms`;
  return `${Math.round(value)}%`;
}

function applySynthControl(name, rawValue) {
  const raw = Number(rawValue);
  state.synth[name] = ["attack", "decay", "release", "glide"].includes(name) ? raw / 1000
    : ["sustain", "sub", "drive"].includes(name) ? raw / 100 : raw;
  if (["cutoff", "envAmount"].includes(name)) engine.updateAutoCutoff();
}

function synthControlRawValue(name, value) {
  if (["attack", "decay", "release", "glide"].includes(name)) return value * 1000;
  if (["sustain", "sub", "drive"].includes(name)) return value * 100;
  return value;
}

function renderSynthControl(control, rawValue, synchronize = false) {
  const input = control.querySelector("input");
  const output = control.querySelector("output");
  const name = control.dataset.control;
  let effectiveRaw = rawValue;
  if (synchronize) {
    input.value = String(rawValue);
    effectiveRaw = syncCoalescedRange(input);
  }
  const value = Number(effectiveRaw);
  output.textContent = formatSynthOutput(name, value);
  const percent = (value - Number(input.min)) / (Number(input.max) - Number(input.min));
  control.style.setProperty("--dial-angle", `${-125 + percent * 250}deg`);
  rangeFill(input);
}

function renderSynthControls() {
  document.querySelectorAll(".dial-control").forEach((control) => {
    const name = control.dataset.control;
    renderSynthControl(control, synthControlRawValue(name, state.synth[name]), true);
  });
}

function bindSynthControls() {
  document.querySelectorAll(".wave-key").forEach((button) => {
    button.addEventListener("click", () => {
      state.synth.wave = button.dataset.wave;
      document.querySelectorAll(".wave-key").forEach((candidate) => {
        const active = candidate === button;
        candidate.classList.toggle("is-active", active);
        candidate.setAttribute("aria-checked", String(active));
      });
      document.getElementById("waveName").textContent = state.synth.wave === "sawtooth" ? "SAW" : state.synth.wave.toUpperCase();
      drawScopeFrame();
    });
  });

  document.querySelectorAll(".dial-control").forEach((control) => {
    const input = control.querySelector("input");
    const name = control.dataset.control;
    const update = (raw) => {
      applySynthControl(name, Number(raw));
    };
    bindCoalescedRange(input, update, (raw) => renderSynthControl(control, raw));
  });
  // State is authoritative: browsers may restore an old form value before
  // this binding runs, but it must not overwrite the current synth state.
  renderSynthControls();

  const autoToggle = document.getElementById("autoCutoffToggle");
  const autoAmount = document.getElementById("autoCutoffAmount");
  const renderAutoCutoff = () => {
    autoToggle.classList.toggle("is-on", state.synth.autoCutoffEnabled);
    autoToggle.setAttribute("aria-pressed", String(state.synth.autoCutoffEnabled));
    autoToggle.querySelector("span:last-child").textContent = state.synth.autoCutoffEnabled ? "ON" : "OFF";
    document.querySelectorAll("[data-auto-cutoff-division]").forEach((button) => {
      const active = button.dataset.autoCutoffDivision === state.synth.autoCutoffDivision;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-checked", String(active));
    });
    document.getElementById("autoCutoffAmountValue").textContent = `${Math.round(state.synth.autoCutoffAmount * 100)}%`;
  };
  autoToggle.addEventListener("click", () => {
    state.synth.autoCutoffEnabled = !state.synth.autoCutoffEnabled;
    engine.updateAutoCutoff();
    renderAutoCutoff();
  });
  document.querySelectorAll("[data-auto-cutoff-division]").forEach((button) => {
    button.addEventListener("click", () => {
      state.synth.autoCutoffDivision = button.dataset.autoCutoffDivision;
      engine.updateAutoCutoff();
      renderAutoCutoff();
    });
  });
  bindCoalescedRange(autoAmount, (raw) => {
    state.synth.autoCutoffAmount = Number(raw) / 100;
    engine.updateAutoCutoff();
  }, (raw) => {
    document.getElementById("autoCutoffAmountValue").textContent = `${Math.round(Number(raw))}%`;
    rangeFill(autoAmount);
  });
  rangeFill(autoAmount);
  renderAutoCutoff();
}

function fxOutput(name, raw) {
  const value = Number(raw);
  if (name === "delayTime") return `${Math.round(value)} ms`;
  if (["delayTone", "reverbDamping"].includes(name)) return value >= 1000 ? `${(value / 1000).toFixed(1)} kHz` : `${Math.round(value)} Hz`;
  if (["phaserRate", "chorusRate", "flangerRate"].includes(name)) return `${(value / 100).toFixed(2)} Hz`;
  return `${Math.round(value)}%`;
}

function fxStateValue(name, raw) {
  const value = Number(raw);
  if (name === "delayTime") return value / 1000;
  if (["delayFeedback", "phaserDepth", "chorusDepth", "flangerFeedback"].includes(name)) return value / 100;
  if (["phaserRate", "chorusRate", "flangerRate"].includes(name)) return value / 100;
  return value;
}

function fxControlRawValue(name, value) {
  if (name === "delayTime") return value * 1000;
  if (["delayFeedback", "phaserDepth", "chorusDepth", "flangerFeedback"].includes(name)) return value * 100;
  if (["phaserRate", "chorusRate", "flangerRate"].includes(name)) return value * 100;
  return value;
}

const REVERB_TIME_LABELS = { room: "0.8 s", plate: "1.6 s", hall: "3.4 s" };

function renderFxParameters() {
  const fx = getChannelFxState();
  document.querySelectorAll("[data-delay-mode]").forEach((button) => {
    const active = button.dataset.delayMode === fx.delayMode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-checked", String(active));
  });
  document.querySelectorAll("[data-delay-timing]").forEach((button) => {
    const active = button.dataset.delayTiming === fx.delayTiming;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-checked", String(active));
  });
  document.querySelectorAll("[data-delay-division]").forEach((button) => {
    const active = button.dataset.delayDivision === fx.delayDivision;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-checked", String(active));
    button.disabled = fx.delayTiming !== "sync";
  });
  const pingPongButton = document.querySelector("[data-delay-ping-pong]");
  if (pingPongButton) {
    pingPongButton.classList.toggle("is-active", fx.delayPingPong);
    pingPongButton.setAttribute("aria-pressed", String(fx.delayPingPong));
  }
  const divisionPanel = document.querySelector("[data-delay-division-panel]");
  if (divisionPanel) divisionPanel.classList.toggle("is-disabled", fx.delayTiming !== "sync");
  document.querySelectorAll("[data-reverb-mode]").forEach((button) => {
    const active = button.dataset.reverbMode === fx.reverbMode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-checked", String(active));
  });
  const reverbDisplay = document.getElementById("reverbDisplay");
  reverbDisplay.querySelector("span").textContent = fx.reverbMode.toUpperCase();
  reverbDisplay.querySelector("strong").textContent = REVERB_TIME_LABELS[fx.reverbMode];

  document.querySelectorAll("[data-fx-control]").forEach((control) => {
    const input = control.querySelector("input");
    const name = control.dataset.fxControl;
    const raw = fxControlRawValue(name, fx[name]);
    input.value = String(raw);
    syncCoalescedRange(input);
    control.querySelector("output").textContent = name === "delayTime" && fx.delayTiming === "sync"
      ? `${fx.delayDivision} · ${Math.round(getDelaySeconds(fx) * 1000)} ms`
      : fxOutput(name, raw);
    if (name === "delayTime") {
      input.disabled = fx.delayTiming === "sync";
      control.classList?.toggle("is-disabled", input.disabled);
    }
    rangeFill(input);
  });
}

function updateEffectPowerUI(effect) {
  const channelId = state.selectedFxChannel;
  const channel = CHANNELS.find(({ id }) => id === channelId);
  const enabled = state.fx.enabled[channelId][effect];
  const button = document.querySelector(`[data-effect-power="${effect}"]`);
  const unit = document.querySelector(`[data-effect="${effect}"]`);
  button.classList.toggle("is-on", enabled);
  button.setAttribute("aria-pressed", String(enabled));
  button.setAttribute("aria-label", `${enabled ? "Desactivar" : "Activar"} ${effect} en ${channel.label}`);
  button.lastChild.textContent = enabled ? " ON" : " OFF";
  unit.classList.toggle("is-enabled", enabled);
}

function renderFxChannel() {
  const channelId = state.selectedFxChannel;
  const channelIndex = CHANNELS.findIndex(({ id }) => id === channelId);
  const channel = CHANNELS[channelIndex];
  dom.fxChannelNumber.textContent = String(channelIndex + 1).padStart(2, "0");
  dom.fxChannelName.textContent = channel.label;

  document.querySelectorAll("[data-fx-channel]").forEach((button) => {
    const buttonChannel = button.dataset.fxChannel;
    const active = buttonChannel === channelId;
    const hasActiveEffect = FX_NAMES.some((effect) => state.fx.enabled[buttonChannel][effect]);
    button.classList.toggle("is-active", active);
    button.classList.toggle("has-active-fx", hasActiveEffect);
    button.setAttribute("aria-checked", String(active));
  });

  document.querySelectorAll("[data-fx-channel-indicator]").forEach((indicator) => {
    indicator.textContent = channel.label;
  });

  document.querySelectorAll("[data-fx-send]").forEach((control) => {
    const effect = control.dataset.fxSend;
    const input = control.querySelector("input");
    const raw = Math.round(state.fx.sends[channelId][effect] * 100);
    input.value = String(raw);
    syncCoalescedRange(input);
    control.querySelector("output").textContent = `${raw}%`;
    rangeFill(input);
  });

  renderFxParameters();
  FX_NAMES.forEach(updateEffectPowerUI);
}

function bindEffects() {
  document.querySelectorAll("[data-fx-channel]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedFxChannel = button.dataset.fxChannel;
      renderFxChannel();
    });
  });

  document.querySelectorAll("[data-effect-power]").forEach((button) => {
    button.addEventListener("click", () => {
      const effect = button.dataset.effectPower;
      const channelId = state.selectedFxChannel;
      state.fx.enabled[channelId][effect] = !state.fx.enabled[channelId][effect];
      renderFxChannel();
      engine.updateEffectSend(channelId, effect);
    });
  });

  document.querySelectorAll("[data-delay-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      getChannelFxState().delayMode = button.dataset.delayMode;
      renderFxParameters();
      engine.updateEffect("delay");
    });
  });

  document.querySelectorAll("[data-delay-timing]").forEach((button) => {
    button.addEventListener("click", () => {
      getChannelFxState().delayTiming = button.dataset.delayTiming;
      renderFxParameters();
      engine.updateEffect("delay");
    });
  });

  document.querySelectorAll("[data-delay-division]").forEach((button) => {
    button.addEventListener("click", () => {
      if (getChannelFxState().delayTiming !== "sync") return;
      getChannelFxState().delayDivision = button.dataset.delayDivision;
      renderFxParameters();
      engine.updateEffect("delay");
    });
  });

  const pingPongButton = document.querySelector("[data-delay-ping-pong]");
  if (pingPongButton) {
    pingPongButton.addEventListener("click", () => {
      getChannelFxState().delayPingPong = !getChannelFxState().delayPingPong;
      renderFxParameters();
      engine.updateEffect("delay");
    });
  }

  document.querySelectorAll("[data-reverb-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      getChannelFxState().reverbMode = button.dataset.reverbMode;
      renderFxParameters();
      engine.updateEffect("reverb");
    });
  });

  document.querySelectorAll("[data-fx-control]").forEach((control) => {
    const input = control.querySelector("input");
    const output = control.querySelector("output");
    const name = control.dataset.fxControl;
    const effect = FX_NAMES.find((candidate) => name.startsWith(candidate));
    const update = (raw) => {
      getChannelFxState()[name] = fxStateValue(name, Number(raw));
      engine.updateEffect(effect);
    };
    const renderValue = (raw) => {
      output.textContent = fxOutput(name, raw);
      rangeFill(input);
    };
    bindCoalescedRange(input, update, renderValue);
    renderValue(input.value);
  });

  document.querySelectorAll("[data-fx-send]").forEach((control) => {
    const input = control.querySelector("input");
    const effect = control.dataset.fxSend;
    const output = control.querySelector("output");
    bindCoalescedRange(input, (raw) => {
      const channelId = state.selectedFxChannel;
      state.fx.sends[channelId][effect] = raw / 100;
      engine.updateEffectSend(channelId, effect);
    }, (raw) => {
      output.textContent = `${Math.round(Number(raw))}%`;
      rangeFill(input);
    });
  });

  renderFxChannel();
}

function formatProcessorOutput(name, value) {
  if (name === "peakReduction") return `${Math.round(value)}%`;
  if (["makeupGain", "lowShelfGain", "highShelfGain"].includes(name)) {
    const sign = value > 0 ? "+" : value < 0 ? "−" : "";
    return `${sign}${Math.abs(value).toFixed(1)} dB`;
  }
  if (value >= 1000) return `${(value / 1000).toFixed(1)} kHz`;
  return `${Math.round(value)} Hz`;
}

function renderProcessor() {
  const channelId = state.selectedProcessorChannel;
  const channelIndex = CHANNELS.findIndex(({ id }) => id === channelId);
  const channel = CHANNELS[channelIndex];
  const processor = state.processors[channelId];
  dom.processorChannelNumber.textContent = String(channelIndex + 1).padStart(2, "0");
  dom.processorChannelName.textContent = channel.label;

  document.querySelectorAll("[data-processor-channel]").forEach((button) => {
    const active = button.dataset.processorChannel === channelId;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
    button.closest(".channel-strip")?.classList.toggle("is-processor-selected", active);
  });

  document.querySelectorAll("[data-processor-control]").forEach((control) => {
    const name = control.dataset.processorControl;
    const input = control.querySelector("input");
    const output = control.querySelector("output");
    const value = processor[name];
    input.value = String(value);
    syncCoalescedRange(input);
    output.textContent = formatProcessorOutput(name, value);
    rangeFill(input);
    if (control.classList.contains("large-dial-control")) {
      const percent = (value - Number(input.min)) / (Number(input.max) - Number(input.min));
      control.style.setProperty("--dial-angle", `${-125 + percent * 250}deg`);
    }
  });
}

function renderReductionMeter() {
  const diagnosticStartedAt = diagnostics.begin();
  const compressor = engine.channels[state.selectedProcessorChannel]?.compressor;
  const reduction = compressor ? clamp(Math.abs(Number(compressor.reduction) || 0), 0, 24) : 0;
  dom.reductionMeterBar.style.height = `${reduction / 24 * 100}%`;
  dom.reductionMeterValue.textContent = `${reduction.toFixed(1)} dB`;

  const masterReduction = state.masterProcessor.limiterEnabled && engine.masterLimiter
    ? clamp(Math.abs(Number(engine.masterLimiter.reduction) || 0), 0, 24) : 0;
  dom.masterReductionBar.style.width = `${masterReduction / 24 * 100}%`;
  dom.masterReductionValue.textContent = `${masterReduction.toFixed(1)} dB`;

  if (!engine.analyser) {
    diagnostics.end("meterRender", diagnosticStartedAt);
    return;
  }
  const size = engine.analyser.fftSize;
  let peak = 0;
  if (typeof engine.analyser.getFloatTimeDomainData === "function") {
    if (!(masterMeterData instanceof Float32Array) || masterMeterData.length !== size) masterMeterData = new Float32Array(size);
    engine.analyser.getFloatTimeDomainData(masterMeterData);
    masterMeterData.forEach((sample) => { peak = Math.max(peak, Math.abs(sample)); });
  } else {
    if (!(masterMeterData instanceof Uint8Array) || masterMeterData.length !== size) masterMeterData = new Uint8Array(size);
    engine.analyser.getByteTimeDomainData(masterMeterData);
    masterMeterData.forEach((sample) => { peak = Math.max(peak, Math.abs((sample - 128) / 128)); });
  }
  const peakDb = peak > 0.000001 ? 20 * Math.log10(peak) : -Infinity;
  dom.masterPeakBar.style.width = `${clamp((peakDb + 60) / 60 * 100, 0, 100)}%`;
  dom.masterPeakValue.textContent = Number.isFinite(peakDb) ? `${peakDb.toFixed(1)} dBFS` : "−∞ dBFS";
  if (peak >= 1) masterClipHoldUntil = performance.now() + 900;
  dom.masterClipLamp.classList.toggle("is-clipping", performance.now() < masterClipHoldUntil);
  diagnostics.end("meterRender", diagnosticStartedAt);
}

function formatMasterOutput(name, value) {
  if (["limiterThreshold", "limiterCeiling", "lowShelfGain", "highShelfGain"].includes(name)) return `${Number(value).toFixed(1).replace("-", "−")} dB`;
  if (["limiterAttack", "limiterRelease"].includes(name)) return `${Number(value).toFixed(value < 10 ? 1 : 0)} ms`;
  return formatProcessorOutput(name, value);
}

function masterRawValue(name, value) {
  return ["limiterAttack", "limiterRelease"].includes(name) ? value * 1000 : value;
}

function renderMasterVolume(rawValue = state.master * 100) {
  let raw = clamp(Number(rawValue), 0, 100);
  dom.master.value = String(raw);
  dom.masterOutput.value = String(raw);
  syncCoalescedRange(dom.master);
  syncCoalescedRange(dom.masterOutput);
  raw = clamp(state.master * 100, 0, 100);
  dom.master.value = String(raw);
  dom.masterOutput.value = String(raw);
  syncCoalescedRange(dom.master);
  syncCoalescedRange(dom.masterOutput);
  dom.masterValue.textContent = `${Math.round(raw)}%`;
  dom.masterOutputValue.textContent = `${Math.round(raw)}%`;
  rangeFill(dom.master);
  rangeFill(dom.masterOutput);
}

function setMasterVolume(rawValue) {
  const raw = clamp(Number(rawValue), 0, 100);
  state.master = raw / 100;
  renderMasterVolume(raw);
  engine.updateMaster();
}

function renderMasterProcessor() {
  const master = state.masterProcessor;
  const limiterToggle = document.getElementById("masterLimiterToggle");
  const eqToggle = document.getElementById("masterEqToggle");
  [[limiterToggle, master.limiterEnabled], [eqToggle, master.eqEnabled]].forEach(([button, enabled]) => {
    button.classList.toggle("is-on", enabled);
    button.setAttribute("aria-pressed", String(enabled));
    button.querySelector("span:last-child").textContent = enabled ? "ON" : "OFF";
  });
  document.querySelectorAll("[data-master-control]").forEach((control) => {
    const name = control.dataset.masterControl;
    const raw = masterRawValue(name, master[name]);
    const input = control.querySelector("input");
    input.value = String(raw);
    syncCoalescedRange(input);
    control.querySelector("output").textContent = formatMasterOutput(name, raw);
    rangeFill(input);
  });
  renderMasterVolume();
}

function bindMasterProcessor() {
  document.getElementById("masterLimiterToggle").addEventListener("click", () => {
    state.masterProcessor.limiterEnabled = !state.masterProcessor.limiterEnabled;
    engine.updateMasterProcessor();
    renderMasterProcessor();
  });
  document.getElementById("masterEqToggle").addEventListener("click", () => {
    state.masterProcessor.eqEnabled = !state.masterProcessor.eqEnabled;
    engine.updateMasterProcessor();
    renderMasterProcessor();
  });
  document.querySelectorAll("[data-master-control]").forEach((control) => {
    const input = control.querySelector("input");
    const name = control.dataset.masterControl;
    const output = control.querySelector("output");
    bindCoalescedRange(input, (raw) => {
      const value = Number(raw);
      state.masterProcessor[name] = ["limiterAttack", "limiterRelease"].includes(name) ? value / 1000 : value;
      engine.updateMasterProcessor();
    }, (raw) => {
      const value = Number(raw);
      output.textContent = formatMasterOutput(name, value);
      rangeFill(input);
    });
  });
  bindCoalescedRange(dom.masterOutput, setMasterVolume, (raw) => {
    const value = Math.round(Number(raw));
    dom.masterValue.textContent = `${value}%`;
    dom.masterOutputValue.textContent = `${value}%`;
    rangeFill(dom.masterOutput);
  });
  renderMasterProcessor();
}

function bindChannelProcessor() {
  document.querySelectorAll("[data-processor-channel]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedProcessorChannel = button.dataset.processorChannel;
      renderProcessor();
      if (window.matchMedia("(max-width: 760px)").matches) {
        document.getElementById("channelProcessor").scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
  });

  document.querySelectorAll("[data-processor-control]").forEach((control) => {
    const input = control.querySelector("input");
    const name = control.dataset.processorControl;
    const output = control.querySelector("output");
    const renderValue = (raw) => {
      const value = Number(raw);
      output.textContent = formatProcessorOutput(name, value);
      rangeFill(input);
      if (control.classList.contains("large-dial-control")) {
        const percent = (value - Number(input.min)) / (Number(input.max) - Number(input.min));
        control.style.setProperty("--dial-angle", `${-125 + percent * 250}deg`);
      }
    };
    bindCoalescedRange(input, (raw) => {
      const value = Number(raw);
      state.processors[state.selectedProcessorChannel][name] = value;
      engine.updateProcessor(state.selectedProcessorChannel);
    }, renderValue);
  });

  renderProcessor();
}

function bindMixer() {
  document.querySelectorAll(".channel-strip").forEach((strip) => {
    const channel = strip.dataset.channel;
    const volume = strip.querySelector(".volume-control");
    const levelOutput = strip.querySelector(".level-output");
    const pan = strip.querySelector(".pan-control");
    const panOutput = strip.querySelector(".pan-readout output");

    const updateVolume = () => {
      state.levels[channel] = Number(volume.value) / 100;
      levelOutput.textContent = String(volume.value);
      rangeFill(volume);
      engine.updateChannel(channel);
    };
    const updatePan = () => {
      state.pans[channel] = Number(pan.value) / 100;
      panOutput.textContent = panLabel(state.pans[channel]);
      rangeFill(pan);
      engine.updateChannel(channel);
    };
    bindCoalescedRange(volume, (raw) => {
      state.levels[channel] = Number(raw) / 100;
      engine.updateChannel(channel);
    }, () => {
      levelOutput.textContent = String(volume.value);
      rangeFill(volume);
    });
    bindCoalescedRange(pan, (raw) => {
      state.pans[channel] = Number(raw) / 100;
      engine.updateChannel(channel);
    }, () => {
      panOutput.textContent = panLabel(Number(pan.value) / 100);
      rangeFill(pan);
    });
    updateVolume();
    updatePan();
  });

  const toneBindings = [
    ["kickTune", (value) => { state.drums.kickTune = Number(value); }],
    ["snareTone", (value) => { state.drums.snareTone = Number(value); }],
    ["hatDecay", (value) => { state.drums.hatDecay = Number(value) / 1000; }],
  ];
  toneBindings.forEach(([id, setter]) => {
    const input = document.getElementById(id);
    const update = () => { setter(input.value); rangeFill(input); };
    bindCoalescedRange(input, (value) => setter(value), () => rangeFill(input));
    update();
  });
}

function bindTransport() {
  dom.play.addEventListener("click", () => state.playing ? stopTransport() : startTransport());
  dom.stop.addEventListener("click", stopTransport);
  document.getElementById("tempoDown").addEventListener("click", () => setBpm(state.bpm - 1));
  document.getElementById("tempoUp").addEventListener("click", () => setBpm(state.bpm + 1));
  dom.bpm.addEventListener("change", () => setBpm(dom.bpm.value));
  dom.bpm.addEventListener("blur", () => setBpm(dom.bpm.value));

  bindCoalescedRange(dom.swing, (raw) => {
    state.swing = Number(raw);
  }, (raw) => {
    dom.swingValue.textContent = `${Math.round(Number(raw))}%`;
    rangeFill(dom.swing);
  });

  bindCoalescedRange(dom.master, setMasterVolume, (raw) => {
    const value = Math.round(Number(raw));
    dom.masterValue.textContent = `${value}%`;
    dom.masterOutputValue.textContent = `${value}%`;
    rangeFill(dom.master);
  });

  // Form-state restoration must never override the JavaScript source of truth.
  dom.swing.value = String(state.swing);
  syncCoalescedRange(dom.swing);
  dom.swingValue.textContent = `${Math.round(state.swing)}%`;
  rangeFill(dom.swing);
  renderMasterVolume();

  document.getElementById("tapTempo").addEventListener("click", () => {
    const now = performance.now();
    if (tapTimes.length && now - tapTimes.at(-1) > 2000) tapTimes = [];
    tapTimes.push(now);
    tapTimes = tapTimes.slice(-6);
    if (tapTimes.length >= 2) {
      const intervals = tapTimes.slice(1).map((time, index) => time - tapTimes[index]);
      const average = intervals.reduce((sum, interval) => sum + interval, 0) / intervals.length;
      setBpm(60000 / average);
    }
  });

  dom.wakeLockToggle.addEventListener("change", () => {
    if (dom.wakeLockToggle.checked && state.playing) requestWakeLock();
    if (!dom.wakeLockToggle.checked) releaseWakeLock();
  });
}

function bindTabs() {
  const tabs = [...document.querySelectorAll(".tab-button")];
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => switchTab(tab.dataset.tab));
    tab.addEventListener("keydown", (event) => {
      let target = null;
      if (event.key === "ArrowRight") target = tabs[(index + 1) % tabs.length];
      if (event.key === "ArrowLeft") target = tabs[(index - 1 + tabs.length) % tabs.length];
      if (event.key === "Home") target = tabs[0];
      if (event.key === "End") target = tabs.at(-1);
      if (target) {
        event.preventDefault();
        switchTab(target.dataset.tab);
        target.focus();
      }
    });
  });
}

function renderDirectControls() {
  const diagnosticStartedAt = diagnostics.begin();
  const values = {
    bassCutoff: state.synth.cutoff,
    junoCutoff: state.juno.cutoff,
    junoResonance: state.juno.resonance,
    junoArpGate: state.juno.arp.gate * 100,
    junoLfoFilter: state.juno.lfoFilter * 100,
  };
  document.querySelectorAll("[data-direct-control]").forEach((control) => {
    const name = control.dataset.directControl;
    const raw = values[name];
    const input = control.querySelector("input");
    input.value = String(raw);
    const effectiveRaw = syncCoalescedRange(input);
    control.querySelector("output").textContent = name === "bassCutoff" ? formatSynthOutput("cutoff", effectiveRaw)
      : name === "junoArpGate" ? `${Math.round(Number(effectiveRaw))}%`
        : formatJunoOutput(name === "junoCutoff" ? "cutoff" : name === "junoResonance" ? "resonance" : "lfoFilter", effectiveRaw);
    rangeFill(input);
  });
  document.querySelectorAll("[data-direct-mute]").forEach((button) => {
    const muted = state.directMutes[button.dataset.directMute];
    button.classList.toggle("is-muted", muted);
    button.setAttribute("aria-pressed", String(muted));
    button.querySelector("span").textContent = muted ? "MUTE" : "ON";
  });
  document.querySelectorAll("[data-snare-break-mode]").forEach((button) => {
    const active = button.dataset.snareBreakMode === state.snareBreak.mode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-checked", String(active));
  });
  document.querySelectorAll("[data-snare-break-bars]").forEach((button) => {
    const active = Number(button.dataset.snareBreakBars) === state.snareBreak.bars;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-checked", String(active));
  });
  const breakButton = document.getElementById("snareBreakButton");
  if (breakButton) {
    const status = state.snareBreak.status;
    breakButton.classList.toggle("is-armed", status === "armed");
    breakButton.classList.toggle("is-active", status === "active");
    breakButton.classList.toggle("is-canceling", status === "cancelRequested");
    breakButton.setAttribute("aria-pressed", String(status !== "idle"));
    breakButton.querySelector("small").textContent = status === "armed" ? "ARMADO · PRÓXIMO PASO"
      : status === "active" ? "ACTIVO · PULSA PARA CANCELAR"
        : status === "cancelRequested" ? "CANCELACIÓN PENDIENTE"
          : "ARMAR";
  }
  diagnostics.end("directRender", diagnosticStartedAt);
}

function toggleDirectMute(group) {
  state.directMutes[group] = !state.directMutes[group];
  DIRECT_MUTE_CHANNELS[group].forEach((channelId) => engine.updateChannel(channelId));
  renderDirectControls();
}

function updateDirectControlVisual(name, rawValue) {
  const control = document.querySelector(`[data-direct-control="${name}"]`);
  if (!control) return;
  const input = control.querySelector("input");
  const raw = Number(rawValue);
  control.querySelector("output").textContent = name === "bassCutoff" ? formatSynthOutput("cutoff", raw)
    : name === "junoArpGate" ? `${Math.round(raw)}%`
      : formatJunoOutput(name === "junoCutoff" ? "cutoff" : name === "junoResonance" ? "resonance" : "lfoFilter", raw);
  rangeFill(input);
}

function applyDirectControl(name, rawValue) {
  if (name === "bassCutoff") applySynthControl("cutoff", rawValue);
  else if (name === "junoCutoff") applyJunoControl("cutoff", rawValue);
  else if (name === "junoResonance") applyJunoControl("resonance", rawValue);
  else if (name === "junoArpGate") applyJunoArpGate(rawValue);
  else if (name === "junoLfoFilter") applyJunoControl("lfoFilter", rawValue);
}

function requestSnareBreak() {
  const performance = state.snareBreak;
  if (!state.playing || !engine.ctx) {
    showToast("Inicia PLAY para armar BREAK SNARE.");
    return;
  }
  if (performance.status === "idle") {
    Object.assign(performance, {
      status: "armed", startTime: null, startStep: null, stepsScheduled: 0,
      totalSteps: performance.bars * SNARE_BREAK_STEPS_PER_BAR, activeMode: performance.mode,
    });
  } else if (performance.status === "armed" || performance.status === "active") {
    performance.status = "cancelRequested";
  }
  renderDirectControls();
}

function bindDirectControls() {
  document.querySelectorAll("[data-direct-control]").forEach((control) => {
    const input = control.querySelector("input");
    const name = control.dataset.directControl;
    bindCoalescedRange(input, (raw) => applyDirectControl(name, raw), (raw) => updateDirectControlVisual(name, raw));
  });
  document.querySelectorAll("[data-direct-mute]").forEach((button) => {
    button.addEventListener("click", () => toggleDirectMute(button.dataset.directMute));
  });
  document.querySelectorAll("[data-snare-break-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      state.snareBreak.mode = button.dataset.snareBreakMode;
      renderDirectControls();
    });
  });
  document.querySelectorAll("[data-snare-break-bars]").forEach((button) => {
    button.addEventListener("click", () => {
      state.snareBreak.bars = Number(button.dataset.snareBreakBars);
      renderDirectControls();
    });
  });
  document.getElementById("snareBreakButton")?.addEventListener("click", requestSnareBreak);
  renderDirectControls();
}

function drawScopeFrame() {
  if (!visualVisibility.scope || getVisualMode() === "mobile-performance") return;
  const diagnosticStartedAt = diagnostics.begin();
  const canvas = dom.canvas;
  const context = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#081513";
  context.fillRect(0, 0, width, height);
  context.strokeStyle = "rgba(101, 213, 200, 0.12)";
  context.lineWidth = 1;
  for (let x = 0; x <= width; x += width / 12) {
    context.beginPath(); context.moveTo(x, 0); context.lineTo(x, height); context.stroke();
  }
  for (let y = 0; y <= height; y += height / 6) {
    context.beginPath(); context.moveTo(0, y); context.lineTo(width, y); context.stroke();
  }

  context.beginPath();
  context.strokeStyle = "#65d5c8";
  context.lineWidth = 3;
  context.shadowColor = "rgba(101, 213, 200, 0.68)";
  context.shadowBlur = 8;

  if (engine.analyser && engine.ctx) {
    if (!scopeData || scopeData.length !== engine.analyser.fftSize) scopeData = new Uint8Array(engine.analyser.fftSize);
    const data = scopeData;
    engine.analyser.getByteTimeDomainData(data);
    data.forEach((sample, index) => {
      const x = index / (data.length - 1) * width;
      const y = sample / 255 * height;
      if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
    });
  } else {
    const cycles = 4;
    for (let x = 0; x <= width; x += 2) {
      const phase = (x / width * cycles) % 1;
      let sample = 0;
      if (state.synth.wave === "square") sample = phase < 0.5 ? -1 : 1;
      else if (state.synth.wave === "triangle") sample = 1 - 4 * Math.abs(Math.round(phase) - phase);
      else sample = phase * 2 - 1;
      const y = height / 2 - sample * height * 0.29;
      if (x === 0) context.moveTo(x, y); else context.lineTo(x, y);
    }
  }
  context.stroke();
  context.shadowBlur = 0;
  diagnostics.end("scopeRender", diagnosticStartedAt);
}

function hasUsefulDimensions(element) {
  if (!element || element.hidden) return false;
  const target = element.parentElement || element;
  const width = Number(target.clientWidth || target.width || 0);
  const height = Number(target.clientHeight || target.height || 0);
  return width > 0 && height > 0;
}

function getVisualMode() {
  return state.playing && typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches
    ? "mobile-performance" : "desktop";
}

function refreshVisualVisibility() {
  const appVisible = document.visibilityState === "visible";
  const contextRunning = engine.ctx?.state === "running";
  // Desktop visuals may show preview audio and let peak/clip state decay after
  // STOP. The coarse-pointer performance profile is stricter only while PLAY.
  const desktopPreviewEligible = getVisualMode() === "desktop" && contextRunning;
  const visualEligible = appVisible && (state.playing || desktopPreviewEligible);
  visualVisibility.scope = visualEligible && activeTab === "synth" && hasUsefulDimensions(dom.canvas);
  visualVisibility.meter = visualEligible && activeTab === "mixer" && hasUsefulDimensions(dom.reductionMeterBar);
}

function getVisualDiagnostics() {
  return {
    scopeActive: meterAnimationFrame !== null && visualVisibility.scope && getVisualMode() === "desktop",
    meterActive: meterAnimationFrame !== null && visualVisibility.meter,
    scopeVisible: visualVisibility.scope,
    meterVisible: visualVisibility.meter,
  };
}

function activeVisualKind() {
  if (visualVisibility.scope) return "scope";
  if (visualVisibility.meter) return "meter";
  return null;
}

function scopeLoop(timestamp) {
  meterAnimationFrame = null;
  if (document.visibilityState !== "visible" || engine.ctx?.state !== "running") {
    diagnostics.recordVisualSkip(activeTab === "synth" ? "scope" : "meter", "visibility");
    return;
  }
  const kind = activeVisualKind();
  if (!kind) {
    diagnostics.recordVisualSkip(activeTab === "synth" ? "scope" : "meter", "visibility");
    return;
  }
  if (kind === "scope" && getVisualMode() === "mobile-performance") {
    diagnostics.recordVisualSkip("scope", "visibility");
    return;
  }
  diagnostics.recordAnimationFrame(timestamp);
  const fps = kind === "meter" && getVisualMode() === "mobile-performance" ? 10 : 30;
  if (timestamp - lastMeterFrame >= 1000 / fps) {
    if (kind === "scope") drawScopeFrame();
    else renderReductionMeter();
    diagnostics.recordVisualFrame(kind);
    lastMeterFrame = timestamp;
  } else if (kind === "meter") {
    diagnostics.recordVisualSkip("meter", "rate");
  }
  meterAnimationFrame = window.requestAnimationFrame(scopeLoop);
}

function updateMeterAnimation() {
  if (meterAnimationFrame !== null) window.cancelAnimationFrame(meterAnimationFrame);
  meterAnimationFrame = null;
  lastMeterFrame = -Infinity;
  const kind = activeVisualKind();
  if (!kind || (kind === "scope" && getVisualMode() === "mobile-performance")) return;
  meterAnimationFrame = window.requestAnimationFrame(scopeLoop);
}

async function resumeAudioContext(audioEngine, reason) {
  await audioEngine.ctx.resume();
  diagnostics.recordAudioState(audioEngine, reason);
  diagnostics.resetAudioClockReference(audioEngine);
  // A hidden/suspended context stops the visual RAF. Re-evaluate only after
  // resume succeeds, so ineligible panels remain paused and no RAF is doubled.
  refreshVisualVisibility();
  updateMeterAnimation();
}

async function handleVisibilityChange() {
  diagnostics.recordVisibility(engine);
  refreshVisualVisibility();
  updateMeterAnimation();
  if (document.visibilityState !== "visible") {
    // Internal tabs do not release keys; actual document invisibility does.
    releaseAllComputerJunoKeys();
    return;
  }
  if (document.visibilityState === "visible" && state.playing) {
    if (engine.ctx?.state === "suspended") {
      try {
        await resumeAudioContext(engine, "visibility-resume");
      } catch {
        diagnostics.recordAudioState(engine, "visibility-resume-rejected");
      }
    } else diagnostics.resetAudioClockReference(engine);
    requestWakeLock();
  }
}

function handlePageHide() {
  stopTransport();
  if (meterAnimationFrame !== null) window.cancelAnimationFrame(meterAnimationFrame);
  meterAnimationFrame = null;
  if (engine.ctx?.state === "running") {
    engine.ctx.suspend()
      .then(() => diagnostics.recordAudioState(engine, "pagehide-suspend"))
      .catch(() => diagnostics.recordAudioState(engine, "pagehide-suspend-rejected"));
  }
}

function diagnosticsPanelRequested() {
  return typeof location !== "undefined" && /(?:^|[?&])diag=1(?:&|$)/.test(location.search || "");
}

function formatDiagnosticMetric([name, metric]) {
  return `${name}: n=${metric.count} min=${metric.min.toFixed(1)} ms p50=${metric.p50.toFixed(1)} ms p95=${metric.p95.toFixed(1)} ms max=${metric.max.toFixed(1)} ms`;
}

function refreshDiagnosticsPanel() {
  const output = document.getElementById("diagnosticsOutput");
  if (!output) return;
  diagnostics.captureAudioClock(engine);
  const signal = engine.captureDiagnosticSignal();
  const snapshot = diagnostics.snapshot(engine);
  if (!snapshot.enabled) {
    output.textContent = "Diagnóstico apagado.";
    return;
  }
  output.textContent = [
    `ctx=${snapshot.audioContextState} visible=${snapshot.visibilityState} FX activos=${snapshot.fxActive}`,
    `ticks=${snapshot.totals.schedulerTicks} pasos omitidos totales=${snapshot.totals.skippedSteps} eventos=${snapshot.totals.scheduledEvents} input=${snapshot.totals.inputEvents} long tasks=${snapshot.totals.longTasks} visibilidad=${snapshot.totals.visibilityChanges}`,
    `visual=${snapshot.visualMode} scope=${snapshot.visuals.scopeActive ? "activo" : "pausado"} medidor=${snapshot.visuals.meterActive ? "activo" : "pausado"} frames scope=${snapshot.totals.scopeFrames} medidor=${snapshot.totals.meterFrames} descartados scope=${snapshot.totals.scopeSkippedVisibility} medidor-visible=${snapshot.totals.meterSkippedVisibility} medidor-fps=${snapshot.totals.meterSkippedRate}`,
    ...snapshot.scheduler.map(formatDiagnosticMetric),
    ...snapshot.ui.map(formatDiagnosticMetric),
    `audioClockDelta (deriva relativa desde PLAY/resume): n=${snapshot.audioClock.count} p95=${snapshot.audioClock.p95.toFixed(1)} ms max=${snapshot.audioClock.max.toFixed(1)} ms`,
    ...snapshot.timing.map(formatDiagnosticMetric),
    `último control=${snapshot.lastControl} · estado audio=${snapshot.lastAudioState.state} (${snapshot.lastAudioState.reason}) · salto reloj=${snapshot.clock.lastJumpMs.toFixed(1)} ms @${snapshot.clock.lastJumpPerformance.toFixed(1)} · última long task=${snapshot.clock.lastLongTaskDuration.toFixed(1)} ms @${snapshot.clock.lastLongTaskPerformance.toFixed(1)}`,
    `eventos: pasado=${snapshot.scheduling.past} horizonte=${snapshot.scheduling.inHorizon} futuro=${snapshot.scheduling.tooFar}`,
    `output timestamp: current=${snapshot.clock.outputTimestamp.currentTime.toFixed(3)} context=${snapshot.clock.outputTimestamp.contextTime.toFixed(3)} perf=${snapshot.clock.outputTimestamp.performanceTime.toFixed(1)} now=${snapshot.clock.outputTimestamp.now.toFixed(1)} base=${snapshot.clock.outputTimestamp.baseLatency.toFixed(3)} output=${snapshot.clock.outputTimestamp.outputLatency.toFixed(3)}`,
    ...(signal ? Object.entries(signal).map(([name, value]) => `${name}: rms=${value.rms.toFixed(5)} pico=${value.peak.toFixed(5)} finito=${value.finite ? "sí" : "NO"}`) : ["señal: no disponible"]),
    ...Object.entries(snapshot.voices).map(([name, voice]) => `${name}: voces creadas=${voice.created} activas=${voice.active} limpias=${voice.cleaned}`),
  ].join("\n");
}

function bindDiagnostics() {
  const panel = document.getElementById("diagnosticsPanel");
  if (!panel || !diagnosticsPanelRequested()) return;
  if (!diagnosticsInputListenersInstalled) {
    diagnosticsInputListenersInstalled = true;
    document.addEventListener("input", () => {
      diagnosticInputStartedAt = diagnostics.begin();
    }, true);
    document.addEventListener("input", () => {
      diagnostics.recordInput(diagnosticInputStartedAt);
    });
  }
  installDiagnosticContextListeners(engine);
  panel.hidden = false;
  const toggle = document.getElementById("diagnosticsToggle");
  toggle?.addEventListener("click", () => {
    if (diagnostics.enabled) {
      engine.disposeDiagnosticTaps();
      diagnostics.disable();
    }
    else diagnostics.enable(engine);
    toggle.textContent = diagnostics.enabled ? "DETENER DIAGNÓSTICO" : "INICIAR DIAGNÓSTICO";
    refreshDiagnosticsPanel();
  });
  document.getElementById("diagnosticsRefresh")?.addEventListener("click", refreshDiagnosticsPanel);
}

function installDiagnosticContextListeners(audioEngine) {
  const context = audioEngine?.ctx;
  if (!diagnosticsPanelRequested() || !context || diagnosticsContextWithListeners === context) return;
  diagnosticsContextWithListeners = context;
  context.addEventListener?.("statechange", () => diagnostics.recordAudioState(audioEngine, "statechange"));
  context.addEventListener?.("error", () => diagnostics.recordAudioState(audioEngine, "error"));
}

function initialize() {
  renderPositionLeds();
  renderDrumSequencer();
  renderBassSequencer();
  renderBassEditor();
  renderJunoKeyboard();
  bindSequencers();
  bindSynthControls();
  bindJunoControls();
  bindDirectControls();
  bindEffects();
  bindChannelProcessor();
  bindMasterProcessor();
  bindMixer();
  bindTransport();
  bindTabs();
  bindDiagnostics();
  document.querySelectorAll("input[type='range']").forEach(rangeFill);
  updateTransportUI();
  refreshVisualVisibility();
  updateMeterAnimation();

  document.addEventListener("visibilitychange", handleVisibilityChange);

  window.addEventListener("pagehide", handlePageHide);
  window.addEventListener("pageshow", () => {
    refreshVisualVisibility();
    updateMeterAnimation();
  });
  window.addEventListener("resize", () => {
    refreshVisualVisibility();
    updateMeterAnimation();
  });

  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
}

initialize();

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
];

const FX_NAMES = ["delay", "reverb", "phaser", "chorus", "flanger"];
const FX_SEND_DEFAULTS = {
  delay: 0.24,
  reverb: 0.18,
  phaser: 0.28,
  chorus: 0.30,
  flanger: 0.22,
};

const BASS_GAIN_FLOOR = 0.0001;
const BASS_FADE_TIME = 0.008;
// Low/highpass Q uses dB in Web Audio: this is linear Q = 1/sqrt(2).
const NON_RESONANT_Q_DB = -3.01029995664;
const REVERB_PRESETS = {
  room: { seconds: 0.8, decay: 3.9, diffusion: 0.12 },
  plate: { seconds: 1.65, decay: 3.1, diffusion: 0.34 },
  hall: { seconds: 3.4, decay: 3.8, diffusion: 0.62 },
};

const NOTE_NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
const BLACK_NOTES = new Set([1, 3, 6, 8, 10]);

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
  playing: false,
  starting: false,
  currentStep: -1,
  selectedBassStep: 0,
  selectedProcessorChannel: "kick",
  selectedFxChannel: "kick",
  drumPattern: cloneDrumPattern(),
  bassPattern: cloneBassPattern(),
  mutes: Object.fromEntries(TRACKS.map(({ id }) => [id, false])),
  levels: {
    kick: 0.90,
    snare: 0.76,
    clap: 0.65,
    closedHat: 0.58,
    openHat: 0.54,
    bass: 0.78,
  },
  pans: {
    kick: 0,
    snare: 0,
    clap: 0.10,
    closedHat: -0.18,
    openHat: 0.18,
    bass: 0,
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
  },
  fx: {
    enabled: createFxEnabledStates(),
    sends: createFxSendStates(),
    delayMode: "tape",
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
  },
};

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

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.mixBus = null;
    this.channels = {};
    this.noiseBuffer = null;
    this.analyser = null;
    this.effects = {};
    this.driveCache = new Map();
    this.smoothParams = new WeakMap();
    this.bassVoices = new Set();
    this.drumVoices = new Set();
    this.bassPreviewRequest = 0;
    this.drumPreviewRequests = {};
  }

  async init() {
    if (this.ctx) {
      if (this.ctx.state === "suspended") await this.ctx.resume();
      return;
    }

    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) throw new Error("Este navegador no dispone de Web Audio.");

    try {
      this.ctx = new Context({ latencyHint: "interactive" });
    } catch {
      this.ctx = new Context();
    }
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = state.master;

    const limiter = this.ctx.createDynamicsCompressor();
    limiter.threshold.value = -8;
    limiter.knee.value = 7;
    limiter.ratio.value = 14;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.14;

    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.76;

    this.masterGain.connect(limiter);
    limiter.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);

    this.mixBus = this.ctx.createGain();
    const dryGain = this.ctx.createGain();
    dryGain.gain.value = 0.93;
    this.mixBus.connect(dryGain);
    dryGain.connect(this.masterGain);

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
    this.setupEffectSends();
    this.updateAllChannels();
    this.updateAllProcessors();
    this.updateMaster();
    this.updateAllEffects();

    if (this.ctx.state === "suspended") await this.ctx.resume();
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

    const delayInput = ctx.createGain();
    const delay = ctx.createDelay(2);
    const delayTone = ctx.createBiquadFilter();
    const delayFeedback = ctx.createGain();
    const delayWet = ctx.createGain();
    const delayLfo = ctx.createOscillator();
    const delayLfoDepth = ctx.createGain();
    delayTone.type = "lowpass";
    // A resonant filter inside feedback can amplify each repeat even when the
    // feedback knob is below 100%. Keep this loop strictly attenuating.
    delayTone.Q.value = NON_RESONANT_Q_DB;
    delay.delayTime.value = state.fx.delayTime;
    delayFeedback.gain.value = clamp(state.fx.delayFeedback, 0, 0.82);
    delayLfo.type = "sine";
    delayLfo.frequency.value = 0.21;
    delayInput.connect(delay);
    delay.connect(delayTone);
    delayTone.connect(delayWet);
    delayWet.connect(this.masterGain);
    delayTone.connect(delayFeedback);
    delayFeedback.connect(delay);
    delayLfo.connect(delayLfoDepth);
    delayLfoDepth.connect(delay.delayTime);
    delayLfo.start();
    this.effects.delay = { input: delayInput, delay, tone: delayTone, feedback: delayFeedback, wet: delayWet, lfo: delayLfo, lfoDepth: delayLfoDepth };

    const reverbInput = ctx.createGain();
    const reverbFilter = ctx.createBiquadFilter();
    const reverbWet = ctx.createGain();
    reverbFilter.type = "lowpass";
    reverbInput.connect(reverbFilter);
    reverbWet.connect(this.masterGain);
    // Prepare a bounded bank before scheduling music. Switching modes only
    // fades gains; it never allocates an impulse or replaces a running kernel.
    // Gate both ends so inactive banks receive silence and can finish their tail.
    const banks = {};
    Object.keys(REVERB_PRESETS).forEach((mode) => {
      const input = ctx.createGain();
      const convolver = ctx.createConvolver();
      const output = ctx.createGain();
      input.gain.value = output.gain.value = mode === state.fx.reverbMode ? 1 : 0;
      convolver.buffer = this.createReverbImpulse(mode);
      reverbFilter.connect(input);
      input.connect(convolver);
      convolver.connect(output);
      output.connect(reverbWet);
      banks[mode] = { input, convolver, output };
    });
    this.effects.reverb = { input: reverbInput, filter: reverbFilter, banks, wet: reverbWet };

    const phaserInput = ctx.createGain();
    const phaserFilters = [280, 620, 1280, 2500].map((frequency) => {
      const filter = ctx.createBiquadFilter();
      filter.type = "allpass";
      filter.frequency.value = frequency;
      filter.Q.value = 0.78;
      return filter;
    });
    const phaserWet = ctx.createGain();
    const phaserLfo = ctx.createOscillator();
    const phaserDepths = phaserFilters.map((filter, index) => {
      const depth = ctx.createGain();
      phaserLfo.connect(depth);
      depth.connect(filter.frequency);
      depth.gain.value = [220, 420, 720, 1100][index];
      return depth;
    });
    phaserInput.connect(phaserFilters[0]);
    phaserFilters.forEach((filter, index) => {
      if (phaserFilters[index + 1]) filter.connect(phaserFilters[index + 1]);
    });
    phaserFilters.at(-1).connect(phaserWet);
    phaserWet.connect(this.masterGain);
    phaserLfo.start();
    this.effects.phaser = { input: phaserInput, filters: phaserFilters, wet: phaserWet, lfo: phaserLfo, depths: phaserDepths };

    const chorusInput = ctx.createGain();
    const chorusDelay = ctx.createDelay(0.08);
    const chorusWet = ctx.createGain();
    const chorusLfo = ctx.createOscillator();
    const chorusDepth = ctx.createGain();
    chorusDelay.delayTime.value = 0.018;
    chorusLfo.type = "sine";
    chorusInput.connect(chorusDelay);
    chorusDelay.connect(chorusWet);
    chorusWet.connect(this.masterGain);
    chorusLfo.connect(chorusDepth);
    chorusDepth.connect(chorusDelay.delayTime);
    chorusLfo.start();
    this.effects.chorus = { input: chorusInput, delay: chorusDelay, wet: chorusWet, lfo: chorusLfo, depth: chorusDepth };

    const flangerInput = ctx.createGain();
    const flangerDelay = ctx.createDelay(0.03);
    const flangerFeedback = ctx.createGain();
    const flangerWet = ctx.createGain();
    const flangerLfo = ctx.createOscillator();
    const flangerDepth = ctx.createGain();
    flangerDelay.delayTime.value = 0.004;
    flangerFeedback.gain.value = state.fx.flangerFeedback * 0.75;
    flangerInput.connect(flangerDelay);
    flangerDelay.connect(flangerWet);
    flangerWet.connect(this.masterGain);
    flangerDelay.connect(flangerFeedback);
    flangerFeedback.connect(flangerDelay);
    flangerLfo.connect(flangerDepth);
    flangerDepth.connect(flangerDelay.delayTime);
    flangerLfo.start();
    this.effects.flanger = { input: flangerInput, delay: flangerDelay, feedback: flangerFeedback, wet: flangerWet, lfo: flangerLfo, depth: flangerDepth };
  }

  setupEffectSends() {
    CHANNELS.forEach(({ id }) => {
      const channel = this.channels[id];
      channel.fxSends = {};
      FX_NAMES.forEach((effect) => {
        const send = this.ctx.createGain();
        send.gain.value = 0;
        channel.panner.connect(send);
        send.connect(this.effects[effect].input);
        channel.fxSends[effect] = send;
      });
    });
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

  updateChannel(id) {
    const channel = this.channels[id];
    if (!channel) return;
    const muted = Boolean(state.mutes[id]);
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
    const send = this.channels[channelId]?.fxSends?.[effect];
    if (!send) return;
    const enabled = state.fx.enabled[channelId][effect];
    const amount = state.fx.sends[channelId][effect];
    this.setSmooth(send.gain, enabled ? amount : 0);
  }

  updateAllEffectSends() {
    CHANNELS.forEach(({ id }) => {
      FX_NAMES.forEach((effect) => this.updateEffectSend(id, effect));
    });
  }

  updateAllEffects() {
    FX_NAMES.forEach((effect) => this.updateEffect(effect));
    this.updateAllEffectSends();
  }

  updateEffect(effect) {
    if (!this.ctx) return;
    const fx = state.fx;
    const unit = this.effects[effect];
    if (!unit) return;
    if (effect === "delay") {
      this.setSmooth(unit.delay.delayTime, clamp(fx.delayTime, 0.055, 0.9), 0.035);
      this.setSmooth(unit.feedback.gain, clamp(fx.delayFeedback, 0, 0.82));
      this.setSmooth(unit.tone.frequency, fx.delayMode === "tape" ? Math.min(fx.delayTone, 6200) : fx.delayTone);
      this.setSmooth(unit.lfoDepth.gain, fx.delayMode === "tape" ? 0.0018 : 0);
      this.setSmooth(unit.wet.gain, 0.72);
    } else if (effect === "reverb") {
      this.setSmooth(unit.filter.frequency, fx.reverbDamping);
      this.setSmooth(unit.wet.gain, 0.78);
    } else if (effect === "phaser") {
      this.setSmooth(unit.lfo.frequency, fx.phaserRate);
      unit.depths.forEach((depth, index) => {
        this.setSmooth(depth.gain, [260, 470, 780, 1150][index] * fx.phaserDepth);
      });
      this.setSmooth(unit.wet.gain, 0.62);
    } else if (effect === "chorus") {
      this.setSmooth(unit.lfo.frequency, fx.chorusRate);
      this.setSmooth(unit.depth.gain, 0.001 + fx.chorusDepth * 0.0065);
      this.setSmooth(unit.wet.gain, 0.62);
    } else if (effect === "flanger") {
      this.setSmooth(unit.lfo.frequency, fx.flangerRate);
      this.setSmooth(unit.depth.gain, 0.0018);
      this.setSmooth(unit.feedback.gain, clamp(fx.flangerFeedback, 0, 0.75) * 0.75);
      this.setSmooth(unit.wet.gain, 0.55);
    }
  }

  rebuildReverb() {
    if (!this.ctx || !this.effects.reverb) return;
    Object.entries(this.effects.reverb.banks).forEach(([mode, bank]) => {
      const active = mode === state.fx.reverbMode ? 1 : 0;
      // Finish at exactly zero so inactive convolution banks can become idle.
      this.setSmooth(bank.input.gain, active, 0.07, true);
      this.setSmooth(bank.output.gain, active, 0.07, true);
    });
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
    let remaining = sources.length;
    sources.forEach((source) => {
      source.onended = () => {
        source.onended = null;
        remaining -= 1;
        if (remaining !== 0) return;
        nodes.forEach((node) => node.disconnect());
        this.drumVoices.delete(voice);
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

  stopVoices() {
    this.drumPreviewRequests = {};
    this.stopBassVoices();
    if (this.ctx) this.fadeDrumVoices(this.ctx.currentTime);
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

  scheduleDrum(track, time, level) {
    if (!this.ctx || level === 0 || state.mutes[track]) return;
    const velocity = level === 2 ? 1 : 0.72;
    if (track === "kick") return this.scheduleKick(time, velocity);
    if (track === "snare") return this.scheduleSnare(time, velocity);
    if (track === "clap") return this.scheduleClap(time, velocity);
    if (track === "closedHat") return this.scheduleHat(time, velocity, false);
    if (track === "openHat") return this.scheduleHat(time, velocity, true);
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
    const voice = { osc, sub, amp, fade, stopAt, fadeAt: Infinity };
    this.bassVoices.add(voice);
    let endedSources = 0;
    const cleanup = () => {
      endedSources += 1;
      if (endedSources !== 2) return;
      osc.onended = sub.onended = null;
      [osc, sub, oscGain, subGain, drive, filterA, filterB, amp, fade].forEach((node) => node.disconnect());
      this.bassVoices.delete(voice);
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
    return this.scheduleBass(previewStep, this.ctx.currentTime + 0.012, 0.34, null);
  }
}

const engine = new AudioEngine();
let schedulerTimer = null;
let transportRequest = 0;
let nextStepTime = 0;
let stepToSchedule = 0;
let previousBassMidi = null;
let previousStepHadBass = false;
const playheadTimers = new Set();
let activeTab = "drums";
let meterAnimationFrame = null;
let lastMeterFrame = -Infinity;
let scopeData = null;
let wakeLock = null;
let toastTimer = null;
let tapTimes = [];

const dom = {
  play: document.getElementById("playButton"),
  stop: document.getElementById("stopButton"),
  engineState: document.getElementById("engineState"),
  bpm: document.getElementById("bpmInput"),
  swing: document.getElementById("swingControl"),
  swingValue: document.getElementById("swingValue"),
  master: document.getElementById("masterControl"),
  masterValue: document.getElementById("masterValue"),
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
  for (let index = 0; index < 16; index += 1) {
    const led = document.createElement("span");
    led.className = `position-led${index % 4 === 0 ? " is-beat" : ""}`;
    led.dataset.step = String(index);
    dom.positionLeds.append(led);
  }
}

function renderDrumSequencer() {
  dom.drumSequencer.replaceChildren();
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
    });
  });
}

function renderNoteKeyboard() {
  dom.noteKeyboard.replaceChildren();
  const selectedMidi = state.bassPattern[state.selectedBassStep].midi;
  const selectedPitch = ((selectedMidi % 12) + 12) % 12;
  NOTE_NAMES.forEach((name, pitch) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = ["note-key", BLACK_NOTES.has(pitch) ? "is-black" : "", selectedPitch === pitch ? "is-selected" : ""].filter(Boolean).join(" ");
    button.dataset.pitch = String(pitch);
    button.textContent = name;
    button.setAttribute("aria-label", `Asignar nota ${name}`);
    dom.noteKeyboard.append(button);
  });
}

function renderBassSequencer() {
  dom.bassSequencer.replaceChildren();
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

function renderPlayhead(step) {
  state.currentStep = step;
  document.querySelectorAll(".position-led").forEach((led) => led.classList.toggle("is-current", Number(led.dataset.step) === step));
  document.querySelectorAll(".drum-step").forEach((button) => button.classList.toggle("is-current", Number(button.dataset.step) === step));
  document.querySelectorAll(".bass-step").forEach((button) => button.classList.toggle("is-current", Number(button.dataset.bassStep) === step));
  dom.beatCounter.textContent = `${Math.floor(step / 4) + 1}.${(step % 4) + 1}`;
}

function clearPlayhead() {
  state.currentStep = -1;
  document.querySelectorAll(".is-current").forEach((element) => element.classList.remove("is-current"));
  dom.beatCounter.textContent = "1.1";
}

function queuePlayhead(step, audioTime) {
  const delay = Math.max(0, (audioTime - engine.ctx.currentTime) * 1000);
  const timer = window.setTimeout(() => {
    playheadTimers.delete(timer);
    if (state.playing) renderPlayhead(step);
  }, delay);
  playheadTimers.add(timer);
}

function scheduleStep(step, time) {
  TRACKS.forEach(({ id }) => engine.scheduleDrum(id, time, state.drumPattern[id][step]));

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

function scheduler() {
  if (!state.playing || !engine.ctx) return;
  const now = engine.ctx.currentTime;
  const earliest = now + 0.005;
  if (nextStepTime < earliest) {
    // UI work can delay this timer. Skip expired beats instead of firing every
    // missed note simultaneously, keeping the original tempo and swing phase.
    const barDuration = 60 / state.bpm * 4;
    nextStepTime += Math.floor((earliest - nextStepTime) / barDuration) * barDuration;
    while (nextStepTime < earliest) advanceStep();
    previousStepHadBass = false;
    previousBassMidi = null;
  }
  while (nextStepTime < now + 0.11) {
    scheduleStep(stepToSchedule, nextStepTime);
    advanceStep();
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
    engine.stopVoices();
    state.playing = true;
    stepToSchedule = 0;
    previousBassMidi = state.bassPattern[15].active ? state.bassPattern[15].midi : null;
    previousStepHadBass = state.bassPattern[15].active;
    nextStepTime = engine.ctx.currentTime + 0.055;
    scheduler();
    schedulerTimer = window.setInterval(scheduler, 25);
    updateTransportUI();
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
  engine.stopVoices();
  if (schedulerTimer) window.clearInterval(schedulerTimer);
  schedulerTimer = null;
  playheadTimers.forEach((timer) => window.clearTimeout(timer));
  playheadTimers.clear();
  clearPlayhead();
  updateTransportUI();
  releaseWakeLock();
}

function switchTab(tabName) {
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
  updateMeterAnimation();
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
    const output = control.querySelector("output");
    const name = control.dataset.control;
    const update = () => {
      const raw = Number(input.value);
      state.synth[name] = ["attack", "decay", "release", "glide"].includes(name) ? raw / 1000 : ["sustain", "sub", "drive"].includes(name) ? raw / 100 : raw;
      output.textContent = formatSynthOutput(name, raw);
      const percent = (raw - Number(input.min)) / (Number(input.max) - Number(input.min));
      control.style.setProperty("--dial-angle", `${-125 + percent * 250}deg`);
      rangeFill(input);
    };
    input.addEventListener("input", update);
    update();
  });
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
    control.querySelector("output").textContent = `${raw}%`;
    rangeFill(input);
  });

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
      state.fx.delayMode = button.dataset.delayMode;
      document.querySelectorAll("[data-delay-mode]").forEach((candidate) => {
        const active = candidate === button;
        candidate.classList.toggle("is-active", active);
        candidate.setAttribute("aria-checked", String(active));
      });
      engine.updateEffect("delay");
    });
  });

  const reverbTimes = { room: "0.8 s", plate: "1.6 s", hall: "3.4 s" };
  document.querySelectorAll("[data-reverb-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      state.fx.reverbMode = button.dataset.reverbMode;
      document.querySelectorAll("[data-reverb-mode]").forEach((candidate) => {
        const active = candidate === button;
        candidate.classList.toggle("is-active", active);
        candidate.setAttribute("aria-checked", String(active));
      });
      const display = document.getElementById("reverbDisplay");
      display.querySelector("span").textContent = state.fx.reverbMode.toUpperCase();
      display.querySelector("strong").textContent = reverbTimes[state.fx.reverbMode];
      engine.rebuildReverb();
    });
  });

  document.querySelectorAll("[data-fx-control]").forEach((control) => {
    const input = control.querySelector("input");
    const output = control.querySelector("output");
    const name = control.dataset.fxControl;
    const effect = FX_NAMES.find((candidate) => name.startsWith(candidate));
    const update = () => {
      const raw = Number(input.value);
      state.fx[name] = fxStateValue(name, raw);
      output.textContent = fxOutput(name, raw);
      rangeFill(input);
      engine.updateEffect(effect);
    };
    input.addEventListener("input", update);
    update();
  });

  document.querySelectorAll("[data-fx-send]").forEach((control) => {
    const input = control.querySelector("input");
    const effect = control.dataset.fxSend;
    input.addEventListener("input", () => {
      const channelId = state.selectedFxChannel;
      const raw = Number(input.value);
      state.fx.sends[channelId][effect] = raw / 100;
      control.querySelector("output").textContent = `${Math.round(raw)}%`;
      rangeFill(input);
      engine.updateEffectSend(channelId, effect);
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
    output.textContent = formatProcessorOutput(name, value);
    rangeFill(input);
    if (control.classList.contains("large-dial-control")) {
      const percent = (value - Number(input.min)) / (Number(input.max) - Number(input.min));
      control.style.setProperty("--dial-angle", `${-125 + percent * 250}deg`);
    }
  });
}

function renderReductionMeter() {
  const compressor = engine.channels[state.selectedProcessorChannel]?.compressor;
  const reduction = compressor ? clamp(Math.abs(Number(compressor.reduction) || 0), 0, 24) : 0;
  dom.reductionMeterBar.style.height = `${reduction / 24 * 100}%`;
  dom.reductionMeterValue.textContent = `${reduction.toFixed(1)} dB`;
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
    input.addEventListener("input", () => {
      const value = Number(input.value);
      state.processors[state.selectedProcessorChannel][name] = value;
      control.querySelector("output").textContent = formatProcessorOutput(name, value);
      rangeFill(input);
      if (control.classList.contains("large-dial-control")) {
        const percent = (value - Number(input.min)) / (Number(input.max) - Number(input.min));
        control.style.setProperty("--dial-angle", `${-125 + percent * 250}deg`);
      }
      engine.updateProcessor(state.selectedProcessorChannel);
    });
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
    volume.addEventListener("input", updateVolume);
    pan.addEventListener("input", updatePan);
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
    input.addEventListener("input", update);
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

  dom.swing.addEventListener("input", () => {
    state.swing = Number(dom.swing.value);
    dom.swingValue.textContent = `${state.swing}%`;
    rangeFill(dom.swing);
  });

  dom.master.addEventListener("input", () => {
    state.master = Number(dom.master.value) / 100;
    dom.masterValue.textContent = `${dom.master.value}%`;
    rangeFill(dom.master);
    engine.updateMaster();
  });

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

function drawScopeFrame() {
  if (activeTab !== "synth" || document.visibilityState !== "visible") return;
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
}

function metersVisible() {
  return document.visibilityState === "visible" && (activeTab === "synth" || activeTab === "mixer");
}

function scopeLoop(timestamp) {
  meterAnimationFrame = null;
  if (!metersVisible()) return;
  if (timestamp - lastMeterFrame >= 1000 / 30) {
    if (activeTab === "synth") drawScopeFrame();
    else renderReductionMeter();
    lastMeterFrame = timestamp;
  }
  meterAnimationFrame = window.requestAnimationFrame(scopeLoop);
}

function updateMeterAnimation() {
  if (meterAnimationFrame !== null) window.cancelAnimationFrame(meterAnimationFrame);
  meterAnimationFrame = null;
  lastMeterFrame = -Infinity;
  if (metersVisible()) meterAnimationFrame = window.requestAnimationFrame(scopeLoop);
}

function initialize() {
  renderPositionLeds();
  renderDrumSequencer();
  renderBassSequencer();
  renderBassEditor();
  bindSequencers();
  bindSynthControls();
  bindEffects();
  bindChannelProcessor();
  bindMixer();
  bindTransport();
  bindTabs();
  document.querySelectorAll("input[type='range']").forEach(rangeFill);
  updateTransportUI();
  updateMeterAnimation();

  document.addEventListener("visibilitychange", () => {
    updateMeterAnimation();
    if (document.visibilityState === "visible" && state.playing) {
      if (engine.ctx?.state === "suspended") engine.ctx.resume().catch(() => {});
      requestWakeLock();
    }
  });

  window.addEventListener("pagehide", () => {
    stopTransport();
    if (meterAnimationFrame !== null) window.cancelAnimationFrame(meterAnimationFrame);
    meterAnimationFrame = null;
    if (engine.ctx?.state === "running") engine.ctx.suspend().catch(() => {});
  });
  window.addEventListener("pageshow", updateMeterAnimation);

  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
}

initialize();

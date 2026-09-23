"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { execFileSync } = require("node:child_process");

const source = process.env.VOLT16_TEST_REVISION
  ? execFileSync("git", ["show", `${process.env.VOLT16_TEST_REVISION}:dist/app.js`], { encoding: "utf8" })
  : fs.readFileSync(path.join(__dirname, "../dist/app.js"), "utf8");

// Instrument the real engine. These are lifecycle/automation simulations, not
// measurements of a browser's heap, audio thread, or audible buffer underruns.
class Param {
  constructor(value = 1) { this.value = value; this.events = []; this.calls = 0; }
  event(type, value, time, tau) {
    assert.ok(Number.isFinite(value) && Number.isFinite(time));
    this.events.push({ type, value, time, tau });
    this.calls += 1;
  }
  setValueAtTime(v, t) { this.event("set", v, t); }
  setTargetAtTime(v, t, tau) { this.event("target", v, t, tau); }
  linearRampToValueAtTime(v, t) { this.event("linear", v, t); }
  exponentialRampToValueAtTime(v, t) { this.event("exponential", v, t); }
  cancelScheduledValues(t) { this.events = this.events.filter((e) => e.time < t); }
  valueAt(t) {
    let value = this.value;
    let previous = null;
    for (const event of this.events) {
      if (event.time > t) {
        if (previous && (event.type === "linear" || event.type === "exponential")) {
          const fraction = Math.max(0, (t - previous.time) / (event.time - previous.time));
          return event.type === "linear" ? value + (event.value - value) * fraction
            : value * (event.value / value) ** fraction;
        }
        break;
      }
      if (previous?.type === "target") {
        value = previous.value + (value - previous.value) * Math.exp(-(event.time - previous.time) / previous.tau);
      }
      if (event.type !== "target") value = event.value;
      previous = event;
    }
    if (previous?.type === "target") {
      return previous.value + (value - previous.value) * Math.exp(-(t - previous.time) / previous.tau);
    }
    return value;
  }
}

function mockContext(sampleRate = 48000) {
  const ctx = { currentTime: 0, state: "running", sampleRate, nodes: new Set(), sources: new Set(), created: 0, buffers: 0 };
  const make = (kind) => {
    const node = { kind, connections: [], gain: new Param(), frequency: new Param(350), detune: new Param(0), offset: new Param(0), Q: new Param(),
      delayTime: new Param(0), pan: new Param(0), threshold: new Param(), knee: new Param(),
      ratio: new Param(), attack: new Param(), release: new Param(),
      connect(target) { this.connections.push(target); },
      disconnect(target) {
        if (target) {
          this.connections = this.connections.filter((connection) => connection !== target);
          return;
        }
        this.connections = [];
        ctx.nodes.delete(this);
      },
      start(t = 0) { this.startAt = t; ctx.sources.add(this); },
      stop(t = 0) { this.stopAt = t; },
      getByteTimeDomainData(data) { data.fill(128); },
    };
    ctx.nodes.add(node); ctx.created += 1;
    return node;
  };
  for (const [method, kind] of Object.entries({ createGain: "gain", createOscillator: "oscillator", createConstantSource: "constantSource",
    createBufferSource: "bufferSource", createBiquadFilter: "filter", createWaveShaper: "shaper",
    createConvolver: "convolver", createDelay: "delay", createStereoPanner: "panner",
    createDynamicsCompressor: "compressor", createAnalyser: "analyser" })) ctx[method] = () => make(kind);
  ctx.createBuffer = (channels, length, rate) => {
    ctx.buffers += 1;
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { length, sampleRate: rate, getChannelData: (channel) => data[channel] };
  };
  ctx.destination = {};
  ctx.resume = async () => { ctx.state = "running"; };
  ctx.suspend = async () => { ctx.state = "suspended"; };
  ctx.finishUntil = (t) => {
    ctx.currentTime = t;
    for (const node of [...ctx.sources]) {
      if (node.stopAt <= t) { ctx.sources.delete(node); node.onended?.(); }
    }
  };
  return ctx;
}

function setup() {
  const callbacks = new Map(); let nextId = 0;
  const elements = new Map();
  const element = () => ({ textContent: "", checked: false, hidden: false, children: [],
    style: { setProperty() {} }, classList: { toggle() {}, remove() {}, contains() { return false; } },
    setAttribute() {}, querySelector() { return element(); }, getContext() { return new Proxy({}, { get: () => () => {} }); },
  });
  const ctx = mockContext();
  const document = { visibilityState: "visible", querySelectorAll: () => [],
    getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); } };
  const window = { AudioContext: function () { return ctx; },
    setTimeout(fn) { const id = ++nextId; callbacks.set(id, fn); return id; },
    clearTimeout(id) { callbacks.delete(id); },
    setInterval(fn) { const id = ++nextId; callbacks.set(id, fn); return id; },
    clearInterval(id) { callbacks.delete(id); },
    requestAnimationFrame(fn) { const id = ++nextId; callbacks.set(id, fn); return id; },
    cancelAnimationFrame(id) { callbacks.delete(id); },
  };
  const context = vm.createContext({ document, window, navigator: {}, console, performance: { now: () => 0 } });
  vm.runInContext(source.replace(/\ninitialize\(\);\s*$/, "") + `
    globalThis.api = { state, engine, startTransport, stopTransport, switchTab, scopeLoop,
      queuePlayhead, getPlayheadTimerCount: () => playheadTimers.size ?? playheadTimers.length };
  `, context);
  return { ...context.api, ctx, callbacks, document, elements };
}

test("master topology keeps the creative EQ after the optional limiter and before output volume", async () => {
  const { state, engine, ctx } = setup();
  await engine.init();

  assert.ok(engine.masterInput.connections.includes(engine.masterLimiterDry));
  assert.ok(engine.masterInput.connections.includes(engine.masterLimiter));
  assert.deepEqual(engine.masterLimiter.connections, [engine.masterCeiling]);
  assert.deepEqual(engine.masterCeiling.connections, [engine.masterLimiterWet]);
  assert.deepEqual(engine.masterLimiterDry.connections, [engine.masterPostLimiter]);
  assert.deepEqual(engine.masterLimiterWet.connections, [engine.masterPostLimiter]);

  assert.ok(engine.masterPostLimiter.connections.includes(engine.masterEqDry));
  assert.ok(engine.masterPostLimiter.connections.includes(engine.masterEq.highPass));
  assert.deepEqual(engine.masterEq.highPass.connections, [engine.masterEq.lowShelf]);
  assert.deepEqual(engine.masterEq.lowShelf.connections, [engine.masterEq.highShelf]);
  assert.deepEqual(engine.masterEq.highShelf.connections, [engine.masterEq.lowPass]);
  assert.deepEqual(engine.masterEq.lowPass.connections, [engine.masterEqWet]);
  assert.deepEqual(engine.masterEqDry.connections, [engine.masterGain]);
  assert.deepEqual(engine.masterEqWet.connections, [engine.masterGain]);
  assert.deepEqual(engine.masterGain.connections, [engine.analyser]);
  assert.deepEqual(engine.analyser.connections, [ctx.destination]);
  assert.equal(engine.masterGain.connections.some((node) => node.kind === "compressor"), false,
    "there must be no hidden post-EQ limiter");

  assert.equal(state.masterProcessor.limiterEnabled, false);
  assert.equal(engine.masterLimiterDry.gain.value, 1);
  assert.equal(engine.masterLimiterWet.gain.value, 0);
  assert.equal(state.masterProcessor.eqEnabled, true);
  assert.equal(engine.masterEqDry.gain.value, 0);
  assert.equal(engine.masterEqWet.gain.value, 1);

  const permanentNodes = ctx.nodes.size;
  state.masterProcessor.limiterEnabled = true;
  state.masterProcessor.eqEnabled = false;
  engine.updateMasterProcessor();
  assert.equal(engine.masterLimiterDry.gain.events.at(-1).value, 0);
  assert.equal(engine.masterLimiterWet.gain.events.at(-1).value, 1);
  assert.equal(engine.masterEqDry.gain.events.at(-1).value, 1);
  assert.equal(engine.masterEqWet.gain.events.at(-1).value, 0);
  assert.ok(Math.abs(engine.masterCeiling.gain.events.at(-1).value - 10 ** ((-1 - -3) / 20)) < 1e-12,
    "the pre-EQ ceiling is referenced to the limiter threshold");

  for (let index = 0; index < 4000; index += 1) {
    ctx.currentTime += 0.003;
    state.masterProcessor.limiterThreshold = -18 + (index % 37) * 0.5;
    state.masterProcessor.limiterRelease = 0.04 + (index % 77) * 0.01;
    state.masterProcessor.limiterCeiling = -6 + (index % 61) * 0.1;
    state.masterProcessor.lowShelfGain = -15 + (index % 61) * 0.5;
    state.masterProcessor.highShelfGain = 15 - (index % 61) * 0.5;
    engine.updateMasterProcessor();
    [engine.masterLimiter.threshold, engine.masterLimiter.release, engine.masterCeiling.gain,
      engine.masterEq.lowShelf.gain, engine.masterEq.highShelf.gain].forEach((param) => {
      assert.ok(param.events.length <= 2, "master automation must stay bounded");
    });
  }
  assert.equal(ctx.nodes.size, permanentNodes, "editing the master must never allocate audio nodes");
});

test("ten simulated minutes at 190 BPM release all completed percussion and bass nodes", async () => {
  const { state, engine, ctx } = setup();
  await engine.init();
  const permanentNodes = ctx.nodes.size;
  const permanentSources = ctx.sources.size;
  const interval = 60 / 190 / 4;
  state.synth.release = 1.4;
  state.drums.hatDecay = 0.9;
  let maximum = 0;
  for (let step = 0; step < Math.ceil(600 / interval); step += 1) {
    const now = step * interval;
    ctx.finishUntil(now);
    for (const track of ["kick", "snare", "clap", "closedHat", "openHat"]) engine.scheduleDrum(track, now + 0.01, 2);
    engine.scheduleBass({ active: true, midi: 24 + step % 12, slide: true }, now + 0.01, interval, 24);
    maximum = Math.max(maximum, ctx.nodes.size - permanentNodes);
    assert.ok(ctx.nodes.size - permanentNodes < 300, `transient graph grew to ${ctx.nodes.size - permanentNodes} nodes`);
  }
  ctx.finishUntil(605);
  assert.equal(ctx.nodes.size, permanentNodes, "every ended voice must disconnect all its nodes");
  assert.equal(ctx.sources.size, permanentSources, "no completed voice source may remain");
  assert.equal(engine.bassVoices.size, 0);
  assert.equal(engine.drumVoices.size, 0);
  console.log(`stress: ${ctx.created} nodes created; max ${maximum} transient nodes; ${ctx.nodes.size} permanent nodes after cleanup`);
});

test("Auto Cutoff is lazy, tempo-synced, shared by live bass voices, and fully disposable", async () => {
  const { state, engine, ctx, callbacks } = setup();
  await engine.init();
  const baseline = ctx.nodes.size;
  assert.equal(engine.autoCutoff, null);

  state.synth.autoCutoffEnabled = true;
  state.playing = true;
  engine.updateAutoCutoff(ctx.currentTime + 0.055);
  const unit = engine.autoCutoff;
  assert.ok(unit, "enabling during PLAY must create the shared LFO");
  assert.equal(unit.lfo.type, "sine");
  assert.equal(unit.lfo.startAt, 0.055, "the first cycle must align with transport start");
  assert.equal(unit.offset.startAt, 0.055);
  assert.equal(unit.lfo.frequency.value, 112 / 60 * 0.5);
  assert.equal(ctx.nodes.size, baseline + 3, "one oscillator, one depth gain, and one DC offset are enough");
  assert.equal(unit.depth.gain.events[0].value, 0, "modulation must enter from silence without a cutoff jump");
  assert.equal(unit.offset.offset.events[0].value, 0, "unipolar offset must also enter from zero");

  engine.scheduleBass({ active: true, midi: 24 }, 0.055, 0.2);
  assert.equal(unit.filters.size, 2, "both poles of the bass filter receive the same modulation");
  assert.equal(unit.depth.connections.length, 2);
  assert.equal(unit.offset.connections.length, 2);
  engine.updateAutoCutoff();
  assert.equal(unit.depth.connections.length, 2, "updating a live voice must not duplicate modulation routes");
  assert.equal(unit.offset.connections.length, 2);
  const created = ctx.created;
  state.synth.autoCutoffAmount = 0.72;
  state.bpm = 120;
  for (let index = 0; index < 100; index += 1) engine.updateAutoCutoff();
  assert.equal(ctx.created, created, "editing rate or amount must not allocate new nodes");
  assert.equal(unit.lfo.frequency.events.at(-1).value, 1);
  assert.equal(unit.depth.gain.events.at(-1).value, 2160);
  assert.equal(unit.offset.offset.events.at(-1).value, 2160);
  assert.equal(state.synth.cutoff, 900, "the LFO must add modulation without rewriting manual cutoff");

  ctx.finishUntil(2);
  assert.equal(unit.filters.size, 0, "ended voices must detach their AudioParam routes");
  assert.equal(unit.depth.connections.length, 0);
  assert.equal(unit.offset.connections.length, 0);
  assert.equal(engine.autoCutoff, unit, "transport phase remains alive between bass notes");

  engine.stopVoices();
  assert.equal(engine.autoCutoff, null);
  assert.equal(unit.lfo.stopAt, ctx.currentTime);
  assert.equal(unit.offset.stopAt, ctx.currentTime);
  assert.ok(unit.lfo.connections.length === 0 && unit.depth.connections.length === 0 && unit.offset.connections.length === 0);
  assert.equal([...callbacks.values()].length, 0, "STOP leaves no Auto Cutoff cleanup timer");
});

test("Auto Cutoff disable fades, can reuse its pending LFO, and then cleans it", async () => {
  const { state, engine, callbacks } = setup();
  await engine.init();
  state.synth.autoCutoffEnabled = true;
  state.playing = true;
  engine.updateAutoCutoff(0.055);
  const first = engine.autoCutoff;

  state.synth.autoCutoffEnabled = false;
  engine.updateAutoCutoff();
  const pendingTimer = first.cleanupTimer;
  assert.ok(pendingTimer !== null);
  assert.equal(first.depth.gain.events.at(-1).value, 0, "disable must ramp modulation depth to silence");

  state.synth.autoCutoffEnabled = true;
  engine.updateAutoCutoff();
  assert.equal(engine.autoCutoff, first, "reactivation during fade reuses the oscillator");
  assert.equal(first.cleanupTimer, null);
  assert.equal(callbacks.has(pendingTimer), false);

  state.synth.autoCutoffEnabled = false;
  engine.updateAutoCutoff();
  const cleanup = callbacks.get(first.cleanupTimer);
  cleanup();
  assert.equal(engine.autoCutoff, null);
  assert.equal(first.sourcesStopped, true);
});

test("J-4 is lazy and builds a complete voice only when a key is played", async () => {
  const { engine, ctx } = setup();
  await engine.init();
  const baseline = ctx.nodes.size;
  assert.equal(engine.junoUnit, null);
  assert.equal(engine.junoVoices.size, 0);

  const voice = engine.startJunoVoice(60, 0.01);
  assert.ok(engine.junoUnit, "the shared modulation and chorus unit must be created on first use");
  assert.equal(engine.junoVoices.size, 1);
  assert.equal(ctx.nodes.size, baseline + 28, "one 14-node shared unit and one 14-node voice are allocated");
  assert.equal(voice.saw.type, "sawtooth");
  assert.equal(voice.pulseRamp.type, "sawtooth");
  assert.equal(voice.sub.type, "square");
  assert.deepEqual(voice.highPass.connections, [voice.filterA]);
  assert.deepEqual(voice.filterA.connections, [voice.filterB]);
  assert.deepEqual(voice.filterB.connections, [voice.amp]);
  assert.ok(engine.junoUnit.pitchDepth.connections.includes(voice.saw.detune));
  assert.ok(engine.junoUnit.filterDepth.connections.includes(voice.filterA.frequency));
  assert.ok(engine.junoUnit.pwmDepth.connections.includes(voice.pulseShaper));
});

test("J-4 steals the oldest voice with a short fade and keeps four playable voices", async () => {
  const { engine, ctx } = setup();
  await engine.init();
  const voices = [60, 64, 67, 71].map((midi, index) => engine.startJunoVoice(midi, 0.01 + index * 0.01));
  assert.equal([...engine.junoVoices].filter((voice) => !voice.retiring).length, 4);

  const replacement = engine.startJunoVoice(74, 0.06);
  assert.equal(voices[0].retiring, true);
  assert.equal(voices[0].releasedAt, 0.06);
  assert.equal(voices[0].fade.gain.events.at(-1).value, 0);
  assert.equal(replacement.midi, 74);
  assert.equal([...engine.junoVoices].filter((voice) => !voice.retiring).length, 4);
  assert.equal(engine.junoVoices.size, 5, "the stolen voice remains only for its click-free overlap");

  ctx.finishUntil(0.08);
  assert.equal(engine.junoVoices.size, 4);
  assert.equal([...engine.junoVoices].filter((voice) => !voice.retiring).length, 4);
});

test("J-4 parameter churn allocates nothing and STOP releases every node and source", async () => {
  const { state, engine, ctx, callbacks } = setup();
  await engine.init();
  const baselineNodes = ctx.nodes.size;
  const baselineSources = ctx.sources.size;
  const voices = [60, 63, 67, 70].map((midi, index) => engine.startJunoVoice(midi, 0.01 + index * 0.01));
  const allocated = ctx.nodes.size;

  for (let index = 0; index < 4000; index += 1) {
    ctx.currentTime += 0.003;
    state.juno.cutoff = 400 + (index % 120) * 80;
    state.juno.pulseWidth = 0.12 + (index % 75) / 100;
    state.juno.pwmAmount = (index % 101) / 100;
    state.juno.lfoRate = 0.08 + (index % 120) / 20;
    engine.updateJunoVoices();
    assert.ok(engine.junoUnit.lfo.frequency.events.length <= 2);
    assert.ok(engine.junoUnit.pwmDepth.gain.events.length <= 2);
    voices.forEach((voice) => {
      assert.ok(voice.pulseBias.offset.events.length <= 2);
      assert.ok(voice.filterA.frequency.events.length <= 2);
      assert.ok(voice.filterB.frequency.events.length <= 2);
    });
  }
  assert.equal(ctx.nodes.size, allocated, "turning J-4 controls must reuse the live graph");

  engine.stopVoices();
  ctx.finishUntil(ctx.currentTime + 1);
  assert.equal(engine.junoVoices.size, 0);
  assert.ok(callbacks.size > 0, "the shared chorus waits briefly for the release tail");
  [...callbacks].forEach(([id, callback]) => { callbacks.delete(id); callback(); });
  ctx.finishUntil(ctx.currentTime + 0.1);
  assert.equal(engine.junoUnit, null);
  assert.equal(ctx.nodes.size, baselineNodes);
  assert.equal(ctx.sources.size, baselineSources);
  assert.equal(callbacks.size, 0);
});

test("maximum seven-channel FX load survives parameter churn, reuse, PLAY/STOP, and final cleanup", async () => {
  const api = setup();
  await api.engine.init();
  const { state, engine, ctx, callbacks } = api;
  const channelIds = ["kick", "snare", "clap", "closedHat", "openHat", "bass", "juno"];
  const effectNames = ["delay", "chorus", "phaser", "flanger", "reverb"];
  const registries = [
    engine.channelDelays,
    engine.channelChoruses,
    engine.channelPhasers,
    engine.channelFlangers,
    engine.channelReverbs,
  ];
  const baseline = ctx.nodes.size;
  state.bpm = 190;

  channelIds.forEach((channelId, channelIndex) => {
    Object.assign(state.fx.channels[channelId], {
      delayMode: channelIndex % 2 ? "digital" : "tape",
      delayTime: 0.08 + channelIndex * 0.09,
      delayFeedback: 0.22 + channelIndex * 0.09,
      delayTone: 2800 + channelIndex * 1500,
      chorusRate: 0.35 + channelIndex * 0.21,
      chorusDepth: 0.18 + channelIndex * 0.12,
      phaserRate: 0.16 + channelIndex * 0.14,
      phaserDepth: 0.24 + channelIndex * 0.11,
      flangerRate: 0.12 + channelIndex * 0.10,
      flangerFeedback: 0.20 + channelIndex * 0.10,
      reverbMode: ["room", "plate", "hall"][channelIndex % 3],
      reverbDamping: 1800 + channelIndex * 2200,
    });
    effectNames.forEach((effect, effectIndex) => {
      state.fx.enabled[channelId][effect] = true;
      state.fx.sends[channelId][effect] = 0.12 + (channelIndex + effectIndex) * 0.035;
    });
  });
  engine.updateAllEffectSends();

  registries.forEach((registry) => assert.equal(registry.size, channelIds.length));
  const fullFxGraph = ctx.nodes.size;
  const initialRoutes = registries.map((registry) => channelIds.map((channelId) => registry.get(channelId)));
  const beforeParameterChurn = ctx.created;

  for (let iteration = 0; iteration < 600; iteration += 1) {
    channelIds.forEach((channelId, channelIndex) => {
      const fx = state.fx.channels[channelId];
      fx.delayTime = 0.055 + ((iteration + channelIndex * 11) % 80) / 100;
      fx.delayFeedback = ((iteration + channelIndex * 7) % 83) / 100;
      fx.delayTone = 1800 + ((iteration + channelIndex * 13) % 100) * 110;
      fx.chorusRate = 0.1 + ((iteration + channelIndex * 17) % 190) / 100;
      fx.chorusDepth = ((iteration + channelIndex * 19) % 101) / 100;
      fx.phaserRate = 0.08 + ((iteration + channelIndex * 23) % 140) / 100;
      fx.phaserDepth = ((iteration + channelIndex * 29) % 101) / 100;
      fx.flangerRate = 0.05 + ((iteration + channelIndex * 31) % 95) / 100;
      fx.flangerFeedback = ((iteration + channelIndex * 37) % 76) / 100;
      fx.reverbMode = ["room", "plate", "hall"][(iteration + channelIndex) % 3];
      fx.reverbDamping = 1000 + ((iteration + channelIndex * 41) % 130) * 100;
      effectNames.forEach((effect) => engine.updateEffect(effect, channelId));
    });
  }
  assert.equal(ctx.created, beforeParameterChurn, "parameter automation must not allocate audio nodes");

  const interval = 60 / state.bpm / 4;
  let maximumTransient = 0;
  for (let step = 0; step < 256; step += 1) {
    const now = step * interval;
    ctx.finishUntil(now);
    for (const track of channelIds.slice(0, -2)) engine.scheduleDrum(track, now + 0.01, 2);
    engine.scheduleBass({ active: true, midi: 24 + step % 12, slide: step % 4 === 0 }, now + 0.01, interval, 24);
    maximumTransient = Math.max(maximumTransient, ctx.nodes.size - fullFxGraph);
  }
  ctx.finishUntil(256 * interval + 5);
  assert.equal(ctx.nodes.size, fullFxGraph);
  assert.equal(engine.drumVoices.size, 0);
  assert.equal(engine.bassVoices.size, 0);

  channelIds.forEach((channelId) => effectNames.forEach((effect) => {
    state.fx.enabled[channelId][effect] = false;
  }));
  engine.updateAllEffectSends();
  assert.ok(callbacks.size > 0, "disabled routes wait for their bounded cleanup");
  channelIds.forEach((channelId) => effectNames.forEach((effect) => {
    state.fx.enabled[channelId][effect] = true;
  }));
  engine.updateAllEffectSends();
  assert.equal(callbacks.size, 0, "reactivation cancels every pending cleanup");
  registries.forEach((registry, registryIndex) => channelIds.forEach((channelId, channelIndex) => {
    assert.equal(registry.get(channelId), initialRoutes[registryIndex][channelIndex], "reactivation must reuse the existing route");
  }));
  assert.equal(ctx.nodes.size, fullFxGraph);

  await api.startTransport();
  assert.equal(state.playing, true);
  maximumTransient = Math.max(maximumTransient, ctx.nodes.size - fullFxGraph);
  api.stopTransport();
  ctx.finishUntil(ctx.currentTime + 5);
  registries.forEach((registry) => assert.equal(registry.size, 0));
  assert.equal(callbacks.size, 0);
  assert.equal(ctx.nodes.size, baseline);

  await api.startTransport();
  registries.forEach((registry) => assert.equal(registry.size, channelIds.length));
  api.stopTransport();
  ctx.finishUntil(ctx.currentTime + 5);
  registries.forEach((registry) => assert.equal(registry.size, 0));
  assert.equal(callbacks.size, 0);
  assert.equal(ctx.nodes.size, baseline);
  assert.equal([...ctx.nodes].filter((node) => node.kind === "convolver").length, 3);
  assert.equal(ctx.buffers, 4, "one noise buffer and exactly three reverb impulses survive the session");
  console.log(`max FX stress: ${fullFxGraph} sustained nodes; max ${maximumTransient} transient nodes; ${baseline} baseline nodes after cleanup`);
});

test("drum previews cannot add off-grid hits during playback, startup, or a delayed resume", async () => {
  const { state, engine, ctx } = setup(); let hits = 0; let resolve;
  engine.ctx = ctx;
  engine.scheduleDrum = () => { hits += 1; };
  engine.init = async () => {};
  state.playing = true; await engine.previewDrum("kick");
  state.playing = false; state.starting = true; await engine.previewDrum("snare");
  state.starting = false;
  engine.init = () => new Promise((r) => { resolve = r; });
  const pending = engine.previewDrum("clap"); state.playing = true; resolve(); await pending;
  assert.equal(hits, 0);
});

test("STOP cancels future drums and bass, clears timers, and wins over a pending PLAY", async () => {
  const api = setup(); await api.engine.init();
  const baseline = api.ctx.nodes.size;
  api.engine.scheduleDrum("openHat", 0.2, 2);
  api.engine.scheduleBass({ active: true, midi: 24 }, 0.2, 0.2);
  api.stopTransport(); api.ctx.finishUntil(0.05);
  assert.equal(api.ctx.nodes.size, baseline, "queued notes must be retired before their start");
  let resume;
  api.engine.init = () => new Promise((resolve) => { resume = resolve; });
  const start = api.startTransport(); api.stopTransport(); resume(); await start;
  assert.equal(api.state.playing, false);
  assert.equal(api.state.starting, false);
  assert.equal(api.callbacks.size, 0, "STOP must not leave a sequencer interval behind");
});

test("rapid continuous controls stay continuous, bound automation, and ignore identical targets", async () => {
  const { engine, ctx } = setup(); await engine.init();
  const param = new Param(0.25);
  for (let index = 0; index < 4000; index += 1) {
    ctx.currentTime += 0.003;
    const before = param.valueAt(ctx.currentTime);
    engine.setSmooth(param, (index % 101) / 100);
    assert.ok(Math.abs(param.valueAt(ctx.currentTime) - before) < 1e-9, "control retargeting must preserve current gain");
    assert.ok(param.events.length <= 2, "old control automation must not accumulate");
  }
  const calls = param.calls;
  engine.setSmooth(param, (3999 % 101) / 100);
  assert.equal(param.calls, calls, "identical target needs no new automation");
});

test("reverb switches reuse prepared buffers and nodes, without replacing a live impulse", async () => {
  const { state, engine, ctx } = setup(); await engine.init();
  const channelId = state.selectedFxChannel;
  const fx = state.fx.channels[channelId];
  state.fx.enabled[channelId].reverb = true;
  engine.updateEffectSend(channelId, "reverb");
  const route = engine.channelReverbs.get(channelId);
  const nodes = ctx.created; const buffers = ctx.buffers;
  for (let index = 0; index < 1200; index += 1) {
    ctx.currentTime += 0.01;
    fx.reverbMode = ["room", "plate", "hall"][index % 3];
    const before = Object.values(route.presetGains).map((gain) => gain.gain.valueAt(ctx.currentTime));
    engine.updateEffect("reverb", channelId);
    assert.equal(ctx.buffers, buffers, "no impulse generation while turning the reverb selector");
    Object.values(route.presetGains).forEach((gain, i) => {
      assert.ok(Math.abs(gain.gain.valueAt(ctx.currentTime) - before[i]) < 1e-9);
    });
  }
  assert.equal(ctx.created, nodes);
  assert.equal(ctx.buffers, buffers, "no impulse generation while turning the reverb selector");
  for (const [mode, gain] of Object.entries(route.presetGains)) {
    const target = mode === fx.reverbMode ? 1 : 0;
    assert.equal(gain.gain.valueAt(ctx.currentTime + 1), target, "inactive preset route must receive exact silence");
  }
});

// W3C lowpass coefficients; Q is in dB for this filter type, NOT linear Q.
// https://www.w3.org/TR/webaudio/#filters-characteristics
function lowpassMagnitude(cutoff, qDb, sampleRate, frequency) {
  const w0 = 2 * Math.PI * cutoff / sampleRate;
  const alpha = Math.sin(w0) / (2 * 10 ** (qDb / 20));
  const b = [(1 - Math.cos(w0)) / 2, 1 - Math.cos(w0), (1 - Math.cos(w0)) / 2];
  const a = [1 + alpha, -2 * Math.cos(w0), 1 - alpha];
  const w = 2 * Math.PI * frequency / sampleRate;
  const magnitudeSquared = (c) => (c[0] + c[1] * Math.cos(w) + c[2] * Math.cos(2 * w)) ** 2
    + (c[1] * Math.sin(w) + c[2] * Math.sin(2 * w)) ** 2;
  return Math.sqrt(magnitudeSquared(b) / magnitudeSquared(a));
}

test("delay feedback stays below unity across its tone range at the maximum UI feedback", async () => {
  const { state, engine } = setup(); await engine.init();
  const channelId = state.selectedFxChannel;
  state.fx.channels[channelId].delayFeedback = 0.82;
  state.fx.enabled[channelId].delay = true;
  engine.updateEffectSend(channelId, "delay");
  const q = engine.channelDelays.get(channelId).tone.Q.value;
  for (const sampleRate of [44100, 48000, 96000]) {
    for (const cutoff of [900, 4200, 6200, 12000]) {
      for (let bin = 0; bin < 4096; bin += 1) {
        const loopGain = 0.82 * lowpassMagnitude(cutoff, q, sampleRate, bin / 4096 * sampleRate / 2);
        assert.ok(loopGain < 1, `feedback grows at ${cutoff} Hz tone: loop gain ${loopGain}`);
      }
    }
  }
});

test("a numerical impulse through the delay feedback decays instead of growing over 20 seconds", async () => {
  const { state, engine } = setup(); await engine.init();
  const channelId = state.selectedFxChannel;
  state.fx.enabled[channelId].delay = true;
  engine.updateEffectSend(channelId, "delay");
  const sampleRate = 48000; const w0 = 2 * Math.PI * 900 / sampleRate;
  const alpha = Math.sin(w0) / (2 * 10 ** (engine.channelDelays.get(channelId).tone.Q.value / 20));
  const a0 = 1 + alpha;
  const b0 = (1 - Math.cos(w0)) / 2 / a0; const b1 = 2 * b0; const b2 = b0;
  const a1 = -2 * Math.cos(w0) / a0; const a2 = (1 - alpha) / a0;
  const delay = new Float64Array(Math.round(sampleRate * 0.055));
  let x1 = 0; let x2 = 0; let y1 = 0; let y2 = 0; let initialPeak = 0; let finalPeak = 0;
  for (let frame = 0; frame < sampleRate * 20; frame += 1) {
    const index = frame % delay.length;
    const x = delay[index];
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    delay[index] = (frame === 0 ? 0.1 : 0) + 0.82 * y;
    if (frame < sampleRate) initialPeak = Math.max(initialPeak, Math.abs(y));
    if (frame >= sampleRate * 19) finalPeak = Math.max(finalPeak, Math.abs(y));
  }
  assert.ok(finalPeak < initialPeak * 0.001, `delay grew from ${initialPeak} to ${finalPeak}`);
});

test("completed playhead timers are removed, and hidden tabs do no meter animation", () => {
  const api = setup(); api.engine.ctx = api.ctx;
  for (let index = 0; index < 500; index += 1) {
    api.queuePlayhead(index % 16, api.ctx.currentTime);
    for (const [id, callback] of [...api.callbacks]) { api.callbacks.delete(id); callback(); }
    assert.equal(api.getPlayheadTimerCount(), 0);
  }
  api.switchTab("synth"); assert.equal(api.callbacks.size, 1);
  api.switchTab("synth"); assert.equal(api.callbacks.size, 1, "do not duplicate animation loops");
  api.switchTab("bass"); assert.equal(api.callbacks.size, 0);
  api.switchTab("mixer"); assert.equal(api.callbacks.size, 1);
  api.document.visibilityState = "hidden";
  for (const [id, callback] of [...api.callbacks]) { api.callbacks.delete(id); callback(1000); }
  assert.equal(api.callbacks.size, 0);
});

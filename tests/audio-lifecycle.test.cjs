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
  constructor(value = 1) { this.value = value; this.events = []; this.calls = 0; this.cancelledAt = []; }
  event(type, value, time, tau) {
    assert.ok(Number.isFinite(value) && Number.isFinite(time));
    this.events.push({ type, value, time, tau });
    this.calls += 1;
  }
  setValueAtTime(v, t) { this.event("set", v, t); }
  setTargetAtTime(v, t, tau) { this.event("target", v, t, tau); }
  linearRampToValueAtTime(v, t) { this.event("linear", v, t); }
  exponentialRampToValueAtTime(v, t) { this.event("exponential", v, t); }
  cancelScheduledValues(t) { this.cancelledAt.push(t); this.events = this.events.filter((e) => e.time < t); }
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
  const ctx = { currentTime: 0, state: "running", sampleRate, nodes: new Set(), sources: new Set(), recordOperations: false, operations: [], created: 0, buffers: 0 };
  const snapshot = (node) => ({
    gain: node?.gain?.value,
    frequency: node?.frequency?.value,
    delayTime: node?.delayTime?.value,
    pan: node?.pan?.value,
  });
  const make = (kind) => {
    const node = { kind, connections: [], gain: new Param(), frequency: new Param(kind === "oscillator" ? 440 : 350), detune: new Param(0), offset: new Param(0), Q: new Param(),
      delayTime: new Param(0), pan: new Param(0), threshold: new Param(), knee: new Param(),
      ratio: new Param(), attack: new Param(), release: new Param(),
      connect(target) {
        if (ctx.recordOperations) {
          ctx.operations.push({
            type: "connect",
            source: this,
            target,
            sourceSnapshot: snapshot(this),
            targetSnapshot: snapshot(target),
            targetValue: target instanceof Param ? target.value : undefined,
          });
        }
        this.connections.push(target);
      },
      disconnect(target) {
        if (target) {
          this.connections = this.connections.filter((connection) => connection !== target);
          return;
        }
        this.connections = [];
        ctx.nodes.delete(this);
      },
      start(t = 0) {
        if (ctx.recordOperations) ctx.operations.push({ type: "start", source: this, sourceSnapshot: snapshot(this) });
        this.startAt = t;
        ctx.sources.add(this);
      },
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

function setup({ junoControls = [], junoToggles = [], junoArpGates = [], synthControls = [], directControls = [], clock = { now: 0 }, PerformanceObserver = undefined, coarsePointer = false } = {}) {
  const callbacks = new Map(); let nextId = 0; let timeoutCount = 0;
  const windowListeners = new Map();
  const queryCounts = new Map();
  const elements = new Map();
  const element = () => {
    const classes = new Set();
    return { textContent: "", checked: false, hidden: false, children: [], width: 720, height: 230, clientWidth: 720, clientHeight: 230,
      style: { setProperty() {} }, classList: {
        add(name) { classes.add(name); }, remove(name) { classes.delete(name); },
        toggle(name, force) { const active = force === undefined ? !classes.has(name) : Boolean(force); if (active) classes.add(name); else classes.delete(name); return active; },
        contains(name) { return classes.has(name); },
      },
    setAttribute() {}, addEventListener() {}, querySelector() { return element(); },
    getContext() { return new Proxy({}, { get: () => () => {} }); },
    };
  };
  const ctx = mockContext();
  const document = { visibilityState: "visible",
    querySelectorAll(selector) {
      queryCounts.set(selector, (queryCounts.get(selector) || 0) + 1);
      if (selector === "[data-juno-control]") return junoControls;
      if (selector === "[data-juno-toggle]") return junoToggles;
      if (selector === "[data-juno-arp-gate]") return junoArpGates;
      if (selector === ".dial-control") return synthControls;
      if (selector === "[data-direct-control]") return directControls;
      return [];
    },
    querySelector(selector) {
      const match = selector.match(/^\[data-direct-control="(.+)"\]$/);
      return match ? directControls.find((control) => control.dataset.directControl === match[1]) : null;
    },
    addEventListener() {},
    getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); } };
  const window = { AudioContext: function () { return ctx; },
    setTimeout(fn) { timeoutCount += 1; const id = ++nextId; callbacks.set(id, fn); return id; },
    clearTimeout(id) { callbacks.delete(id); },
    setInterval(fn) { const id = ++nextId; callbacks.set(id, fn); return id; },
    clearInterval(id) { callbacks.delete(id); },
    requestAnimationFrame(fn) { const id = ++nextId; callbacks.set(id, fn); return id; },
    cancelAnimationFrame(id) { callbacks.delete(id); },
    matchMedia() { return { matches: coarsePointer }; },
    addEventListener(type, listener) {
      if (!windowListeners.has(type)) windowListeners.set(type, []);
      windowListeners.get(type).push(listener);
    },
  };
  if (PerformanceObserver !== undefined) window.PerformanceObserver = PerformanceObserver;
  const context = vm.createContext({ document, window, navigator: {}, console, performance: { now: () => clock.now } });
  vm.runInContext(source.replace(/\ninitialize\(\);\s*$/, "") + `
    globalThis.api = { state, engine, diagnostics, scheduler, startTransport, stopTransport, switchTab, scopeLoop,
      queuePlayhead, handleComputerJunoKeyDown, handleComputerJunoKeyUp, releaseAllComputerJunoKeys,
      bindJunoControls, bindSynthControls, bindDirectControls, bindTransport, applyDirectControl, toggleDirectMute, requestSnareBreak, scheduleStep,
      bindCoalescedRange, flushCoalescedControls, flushCoalescedControl, renderPlayhead, renderDirectControls, applyJunoControl,
      renderJunoControls, renderSynthControls, handleVisibilityChange, refreshVisualVisibility, updateMeterAnimation, getVisualMode, getVisualDiagnostics, renderReductionMeter,
      buildArpSequence, scheduleArpeggiator, getBassFollowSourceNotes, getLowestBassFollowRootMidi,
      queueBassFollowRootFromJuno, applyPendingBassFollowRoot, getBassFollowMidi, toggleBassFollow,
      setArpClock: (origin, next) => { transportStartTime = origin; nextArpTime = next; arpStepIndex = 0; },
      setSchedulerTimeline: (time, step) => { nextStepTime = time; stepToSchedule = step; },
      getComputerJunoHeldCount: () => computerJunoHeld.size,
      getPlayheadTimerCount: () => pendingPlayheadCount,
      getPlayheadFrameActive: () => playheadAnimationFrame !== null,
      getControlFrameActive: () => controlAnimationFrame !== null };
  `, context);
  return {
    ...context.api, ctx, callbacks, document, elements, clock, queryCounts,
    dispatchWindowEvent: (type, event = {}) => (windowListeners.get(type) || []).forEach((listener) => listener(event)),
    getTimeoutCount: () => timeoutCount,
  };
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
  assert.equal(ctx.nodes.size, baseline + 30, "one 15-node shared unit and one 15-node voice are allocated");
  assert.equal(voice.saw.type, "sawtooth");
  assert.equal(voice.pulseRamp.type, "sawtooth");
  assert.equal(voice.sub.type, "square");
  assert.deepEqual(voice.mix.connections, [voice.dcBlocker]);
  assert.deepEqual(voice.dcBlocker.connections, [voice.highPass]);
  assert.deepEqual(voice.highPass.connections, [voice.filterA]);
  assert.deepEqual(voice.filterA.connections, [voice.filterB]);
  assert.deepEqual(voice.filterB.connections, [voice.amp]);
  assert.ok(engine.junoUnit.pitchDepth.connections.includes(voice.saw.detune));
  assert.ok(engine.junoUnit.filterDepth.connections.includes(voice.filterA.frequency));
  assert.ok(engine.junoUnit.pwmDepth.connections.includes(voice.pulseShaper));
});

test("J-4 initializes shared modulation and chorus values before connect and start", async () => {
  const { state, engine, ctx } = setup();
  await engine.init();
  Object.assign(state.juno, {
    chorusMode: "I+II",
    lfoRate: 3.17,
    lfoPitch: 0.37,
    lfoFilter: 0.63,
    pwmAmount: 0.81,
  });

  ctx.recordOperations = true;
  engine.startJunoVoice(60, 0.01);
  const unit = engine.junoUnit;
  const connection = (sourceNode, target) => {
    const operation = ctx.operations.find((entry) => entry.type === "connect"
      && entry.source === sourceNode && entry.target === target);
    assert.ok(operation, `missing ${sourceNode.kind} connection`);
    return operation;
  };
  const start = (sourceNode) => {
    const operation = ctx.operations.find((entry) => entry.type === "start" && entry.source === sourceNode);
    assert.ok(operation, `missing ${sourceNode.kind} start`);
    return operation;
  };

  const inputToDry = connection(unit.input, unit.dry);
  const inputToDelayLeft = connection(unit.input, unit.delayLeft);
  const inputToDelayRight = connection(unit.input, unit.delayRight);
  const delayLeftToPanner = connection(unit.delayLeft, unit.pannerLeft);
  const delayRightToPanner = connection(unit.delayRight, unit.pannerRight);
  const pannerLeftToWet = connection(unit.pannerLeft, unit.wet);
  const chorusToLeftDepth = connection(unit.chorusLfo, unit.chorusDepthLeft);
  const chorusToRightDepth = connection(unit.chorusLfo, unit.chorusDepthRight);
  const leftDepthToDelay = connection(unit.chorusDepthLeft, unit.delayLeft.delayTime);
  const rightDepthToDelay = connection(unit.chorusDepthRight, unit.delayRight.delayTime);
  const lfoToPitch = connection(unit.lfo, unit.pitchDepth);
  const lfoToShape = connection(unit.lfo, unit.filterLfoShape);
  const shapeToFilterDepth = connection(unit.filterLfoShape, unit.filterDepth);
  const lfoToPwm = connection(unit.lfo, unit.pwmDepth);

  const expected = {
    chorusFrequency: 1.12,
    lfoFrequency: state.juno.lfoRate,
    chorusDepthLeft: 0.0046,
    chorusDepthRight: -0.0046,
    pitchDepth: state.juno.lfoPitch * 38,
    filterDepth: state.juno.lfoFilter * 2400,
    pwmDepth: state.juno.pwmAmount * 0.42,
    dry: 0.72,
    wet: 0.70,
    delayLeft: 0.017,
    delayRight: 0.023,
    panLeft: -0.82,
    panRight: 0.82,
  };
  assert.deepEqual({
    chorusFrequency: chorusToLeftDepth.sourceSnapshot.frequency,
    chorusFrequencyRight: chorusToRightDepth.sourceSnapshot.frequency,
    chorusFrequencyAtStart: start(unit.chorusLfo).sourceSnapshot.frequency,
    lfoFrequency: lfoToPitch.sourceSnapshot.frequency,
    lfoFrequencyAtShape: lfoToShape.sourceSnapshot.frequency,
    lfoFrequencyAtPwm: lfoToPwm.sourceSnapshot.frequency,
    lfoFrequencyAtStart: start(unit.lfo).sourceSnapshot.frequency,
    chorusDepthLeft: chorusToLeftDepth.targetSnapshot.gain,
    chorusDepthLeftAtDelay: leftDepthToDelay.sourceSnapshot.gain,
    chorusDepthRight: chorusToRightDepth.targetSnapshot.gain,
    chorusDepthRightAtDelay: rightDepthToDelay.sourceSnapshot.gain,
    pitchDepth: lfoToPitch.targetSnapshot.gain,
    filterDepth: shapeToFilterDepth.targetSnapshot.gain,
    pwmDepth: lfoToPwm.targetSnapshot.gain,
    dry: inputToDry.targetSnapshot.gain,
    wet: pannerLeftToWet.targetSnapshot.gain,
    delayLeft: inputToDelayLeft.targetSnapshot.delayTime,
    delayLeftAtModulation: leftDepthToDelay.targetValue,
    delayRight: inputToDelayRight.targetSnapshot.delayTime,
    delayRightAtModulation: rightDepthToDelay.targetValue,
    panLeft: delayLeftToPanner.targetSnapshot.pan,
    panRight: delayRightToPanner.targetSnapshot.pan,
  }, {
    chorusFrequency: expected.chorusFrequency,
    chorusFrequencyRight: expected.chorusFrequency,
    chorusFrequencyAtStart: expected.chorusFrequency,
    lfoFrequency: expected.lfoFrequency,
    lfoFrequencyAtShape: expected.lfoFrequency,
    lfoFrequencyAtPwm: expected.lfoFrequency,
    lfoFrequencyAtStart: expected.lfoFrequency,
    chorusDepthLeft: expected.chorusDepthLeft,
    chorusDepthLeftAtDelay: expected.chorusDepthLeft,
    chorusDepthRight: expected.chorusDepthRight,
    chorusDepthRightAtDelay: expected.chorusDepthRight,
    pitchDepth: expected.pitchDepth,
    filterDepth: expected.filterDepth,
    pwmDepth: expected.pwmDepth,
    dry: expected.dry,
    wet: expected.wet,
    delayLeft: expected.delayLeft,
    delayLeftAtModulation: expected.delayLeft,
    delayRight: expected.delayRight,
    delayRightAtModulation: expected.delayRight,
    panLeft: expected.panLeft,
    panRight: expected.panRight,
  });

  assert.deepEqual({
    chorusFrequency: unit.chorusLfo.frequency.value,
    lfoFrequency: unit.lfo.frequency.value,
    chorusDepthLeft: unit.chorusDepthLeft.gain.value,
    chorusDepthRight: unit.chorusDepthRight.gain.value,
    pitchDepth: unit.pitchDepth.gain.value,
    filterDepth: unit.filterDepth.gain.value,
    pwmDepth: unit.pwmDepth.gain.value,
    dry: unit.dry.gain.value,
    wet: unit.wet.gain.value,
    delayLeft: unit.delayLeft.delayTime.value,
    delayRight: unit.delayRight.delayTime.value,
    panLeft: unit.pannerLeft.pan.value,
    panRight: unit.pannerRight.pan.value,
  }, expected, "shared parameters must retain their direct initial values after construction");

  [
    ["chorusLfo.frequency", unit.chorusLfo.frequency],
    ["lfo.frequency", unit.lfo.frequency],
    ["chorusDepthLeft.gain", unit.chorusDepthLeft.gain],
    ["chorusDepthRight.gain", unit.chorusDepthRight.gain],
    ["pitchDepth.gain", unit.pitchDepth.gain],
    ["filterDepth.gain", unit.filterDepth.gain],
    ["pwmDepth.gain", unit.pwmDepth.gain],
    ["dry.gain", unit.dry.gain],
    ["wet.gain", unit.wet.gain],
    ["delayLeft.delayTime", unit.delayLeft.delayTime],
    ["delayRight.delayTime", unit.delayRight.delayTime],
    ["pannerLeft.pan", unit.pannerLeft.pan],
    ["pannerRight.pan", unit.pannerRight.pan],
  ].forEach(([name, param]) => {
    assert.deepEqual(param.events, [], `${name} must not use setSmooth during construction`);
  });
});

test("editing J-4 Attack preserves a held manual voice and its amp automation", async () => {
  const listeners = new Map();
  const attackInput = {
    min: "3", max: "2000", value: "18", style: { setProperty() {} },
    addEventListener(type, listener) { listeners.set(type, listener); },
  };
  const attackOutput = { textContent: "" };
  const attackControl = {
    dataset: { junoControl: "attack" },
    querySelector(selector) { return selector === "input" ? attackInput : attackOutput; },
  };
  const { state, engine, ctx, bindJunoControls } = setup({ junoControls: [attackControl] });
  await engine.pressJunoKey(60, "manual-test");
  const heldKey = "60:manual-test";
  const voice = engine.junoHeldVoices.get(heldKey);
  assert.ok(voice, "manual key press must own a held voice");
  ctx.currentTime = voice.startAt + voice.attack + voice.decay + 0.02;
  const ampEventsBefore = structuredClone(voice.amp.gain.events);
  const inputNoteBefore = engine.junoInputNotes.get(heldKey);
  const playingBefore = state.playing;
  let ampCancelCalls = 0;
  const cancelAmp = voice.amp.gain.cancelScheduledValues.bind(voice.amp.gain);
  voice.amp.gain.cancelScheduledValues = (...args) => {
    ampCancelCalls += 1;
    return cancelAmp(...args);
  };
  let updateVoiceCalls = 0;
  const updateJunoVoices = engine.updateJunoVoices.bind(engine);
  engine.updateJunoVoices = (...args) => {
    updateVoiceCalls += 1;
    return updateJunoVoices(...args);
  };

  bindJunoControls();
  [3, 2000, 18, 1450].forEach((raw) => {
    attackInput.value = String(raw);
    listeners.get("input")();
  });
  listeners.get("pointerup")();

  assert.equal(state.juno.attack, 1.45, "Attack state uses the last slider value for future notes");
  assert.equal(updateVoiceCalls, 0, "Attack must not reconfigure active voices");
  assert.equal(voice.releasedAt, Infinity, "the held voice must not be released");
  assert.strictEqual(engine.junoHeldVoices.get(heldKey), voice, "the manual key must retain its voice");
  assert.strictEqual(engine.junoInputNotes.get(heldKey), inputNoteBefore, "Attack must not alter held-key input state");
  assert.equal(state.playing, playingBefore, "Attack must not alter transport state");
  assert.equal(ampCancelCalls, 0, "Attack must not cancel the held voice amplitude timeline");
  assert.deepEqual(voice.amp.gain.events, ampEventsBefore, "Attack must retain the programmed amp envelope");
  assert.ok(voice.amp.gain.valueAt(ctx.currentTime) > 0, "the held voice amplitude must remain audible");
});

test("forcing PULSE on while disabling the last J-4 DCO updates active voices", async () => {
  const listeners = new Map();
  const sawButton = {
    dataset: { junoToggle: "saw" },
    classList: { toggle() {} }, setAttribute() {},
    addEventListener(type, listener) { listeners.set(type, listener); },
  };
  const api = setup({ junoToggles: [sawButton] });
  await api.engine.init();
  Object.assign(api.state.juno, { saw: true, pulse: false, sub: 0 });
  const voice = api.engine.startJunoVoice(60, api.ctx.currentTime + 0.01, false, "manual");
  const before = voice.pulseGain.gain.events.length;

  api.bindJunoControls();
  listeners.get("click")();

  assert.equal(api.state.juno.saw, false);
  assert.equal(api.state.juno.pulse, true, "the DCO safety guard enables PULSE in state");
  assert.ok(voice.pulseGain.gain.events.length > before, "the forced oscillator updates every existing voice");
  assert.equal(voice.pulseGain.gain.events.at(-1).value, 0.27, "the active voice receives the audible PULSE target");
});

test("J-4 keeps filter modulation above the safe floor and removes PWM DC", async () => {
  const { state, engine, ctx } = setup();
  await engine.init();
  state.juno.cutoff = 40;
  state.juno.lfoFilter = 1;
  const voice = engine.startJunoVoice(60, 0.01);

  assert.equal(voice.baseCutoff, 120);
  assert.ok(engine.junoUnit.lfo.connections.includes(engine.junoUnit.filterLfoShape));
  assert.equal(engine.junoUnit.lfo.connections.includes(engine.junoUnit.filterDepth), false);
  assert.deepEqual(engine.junoUnit.filterLfoShape.connections, [engine.junoUnit.filterDepth]);
  assert.equal(voice.dcBlocker.type, "highpass");
  assert.equal(voice.dcBlocker.frequency.value, 20);
  assert.deepEqual(voice.mix.connections, [voice.dcBlocker]);
});

test("J-4 uses one ADSR filter envelope and releases from its instantaneous value", async () => {
  for (const phase of ["attack", "decay", "sustain"]) {
    const { state, engine, ctx } = setup();
    await engine.init();
    Object.assign(state.juno, {
      attack: 0.2, decay: 0.3, sustain: 0.4, release: 0.25,
      cutoff: 1000, envAmount: 3000,
    });
    const voice = engine.startJunoVoice(60, 0.01);
    const releaseAt = phase === "attack" ? 0.11 : phase === "decay" ? 0.31 : 0.62;
    const expectedAmp = engine.junoEnvelopeLevelAt(voice, releaseAt);
    const expectedCutoff = engine.junoFilterEnvelopeValueAt(voice, releaseAt);
    assert.equal(voice.filterSustainCutoff, 2200, "filter sustain follows the visible ADSR sustain control");
    assert.equal(voice.filterA.frequency.events.at(-1).value, 2200, "filter decay ends at sustain, not base cutoff");

    ctx.currentTime = releaseAt;
    engine.releaseJunoVoice(voice, releaseAt);

    const ampAtRelease = voice.amp.gain.events.find((event) => event.type === "set" && event.time === releaseAt);
    const filterAtRelease = voice.filterA.frequency.events.find((event) => event.type === "set" && event.time === releaseAt);
    assert.ok(Math.abs(ampAtRelease.value - expectedAmp) < 1e-12, `${phase} release keeps amp continuity`);
    assert.ok(Math.abs(filterAtRelease.value - expectedCutoff) < 1e-12, `${phase} release keeps cutoff continuity`);
    assert.equal(voice.filterA.frequency.events.at(-1).value, voice.baseCutoff, "release returns the filter to base cutoff");
  }
});

test("J-4 ARP truncates ADSR segments at every gate without post-note-off decay", async () => {
  const cases = [
    { bpm: 120, division: "1/8", gate: 0.2 },
    { bpm: 120, division: "1/8", gate: 0.5 },
    { bpm: 96, division: "1/4", gate: 0.95 },
  ];
  for (const { bpm, division, gate } of cases) {
    const { state, engine } = setup();
    await engine.init();
    Object.assign(state.juno, { attack: 0.04, decay: 0.12, sustain: 0.55, release: 0.2 });
    state.bpm = bpm;
    state.juno.arp.division = division;
    const interval = 60 / bpm * ({ "1/4": 1, "1/8": 0.5, "1/8T": 1 / 3, "1/16": 0.25 }[division]);
    const startAt = 0.01;
    const voice = engine.scheduleJunoArpNote(60, startAt, interval * gate, false, interval);
    const noteOff = startAt + interval * gate;
    const decayEnd = startAt + voice.attack + voice.decay;
    const tailEvents = (param) => param.events.filter((event) => event.time > noteOff && event.time < noteOff + state.juno.release);

    assert.ok(Math.abs(voice.releasedAt - noteOff) < 1e-12, `${division} gate ${gate} schedules its exact note-off`);
    assert.equal(voice.amp.gain.cancelledAt.some((time) => time === noteOff), false, "ARP never cancels amp decay at note-off");
    assert.equal(voice.filterA.frequency.cancelledAt.some((time) => time === noteOff), false, "ARP never cancels filter decay at note-off");
    assert.deepEqual(tailEvents(voice.amp.gain), [], "ARP leaves no cancelled decay endpoint after note-off");
    assert.deepEqual(tailEvents(voice.filterA.frequency), [], "filter envelope leaves no cancelled decay endpoint after note-off");
    if (decayEnd > noteOff) {
      assert.equal(voice.amp.gain.events.some((event) => event.time === decayEnd && event.value === voice.sustain), false);
      assert.equal(voice.filterA.frequency.events.some((event) => event.time === decayEnd && event.value === voice.filterSustainCutoff), false);
    } else {
      assert.ok(voice.amp.gain.events.some((event) => event.time === decayEnd && event.value === voice.sustain));
      assert.ok(voice.filterA.frequency.events.some((event) => event.time === decayEnd && event.value === voice.filterSustainCutoff));
    }
  }
});

test("J-4 ARP caps each release before its four-voice reuse at 190 BPM", async () => {
  const divisions = { "1/8": 0.5, "1/8T": 1 / 3, "1/16": 0.25 };
  const margin = 0.006;
  for (const [division, beats] of Object.entries(divisions)) {
    for (const gate of [0.2, 0.5, 0.95]) {
      const releaseInput = { value: "720", style: { setProperty() {} }, addEventListener() {} };
      const releaseControl = {
        dataset: { junoControl: "release" },
        querySelector(selector) { return selector === "input" ? releaseInput : { textContent: "" }; },
      };
      const { state, engine } = setup({ junoControls: [releaseControl] });
      await engine.init();
      Object.assign(state.juno, { attack: 0.018, decay: 0.34, sustain: 0.62, release: 0.72 });
      state.bpm = 190;
      state.juno.arp.division = division;
      state.juno.arp.gate = gate;
      const requestedRelease = state.juno.release;
      const interval = 60 / state.bpm * beats;
      const startAt = 0.1;
      const scheduled = [];

      for (let index = 0; index < 4; index += 1) {
        const voice = engine.scheduleJunoArpNote(60 + index, startAt + index * interval, interval * gate, false, interval);
        scheduled.push({
          voice,
          startAt: voice.startAt,
          noteOff: voice.releasedAt,
          effectiveRelease: voice.effectiveArpRelease,
          availableRelease: voice.arpAvailableRelease,
          reuseAt: voice.arpReuseAt,
          ampEvents: structuredClone(voice.amp.gain.events),
          filterEvents: structuredClone(voice.filterA.frequency.events),
        });
      }

      assert.equal(engine.junoArpVoicePool.length, 4, "the fixed pool is warm before reuse");
      for (const note of scheduled) {
        const expectedReuseAt = note.startAt + interval * engine.junoArpVoicePool.length;
        const expectedAvailable = Math.max(0, expectedReuseAt - note.noteOff - margin);
        assert.ok(Number.isFinite(note.effectiveRelease) && note.effectiveRelease >= 0, "effective release is finite and non-negative");
        assert.ok(Number.isFinite(note.availableRelease) && note.availableRelease >= 0, "available release is finite and non-negative");
        assert.ok(note.effectiveRelease <= expectedAvailable + 1e-12, "release cannot reach the next reuse");
        assert.ok(note.effectiveRelease <= requestedRelease, "ARP never extends the requested release");
        assert.ok(note.reuseAt <= expectedReuseAt + 1e-12, "reuse estimate uses the real warm-pool size");
        assert.ok(note.noteOff + note.effectiveRelease <= expectedReuseAt - margin + 1e-12,
          "arpActiveUntil finishes before the retrigger fade starts");
        assert.equal(note.ampEvents.some((event) => event.time > expectedReuseAt - margin + 1e-12), false,
          "no old amp event survives into the next reuse");
        assert.equal(note.filterEvents.some((event) => event.time > expectedReuseAt - margin + 1e-12), false,
          "no old cutoff event survives into the next reuse");
      }

      const first = scheduled[0];
      const fadeAt = first.reuseAt - margin;
      assert.ok(Math.abs(first.voice.amp.gain.valueAt(fadeAt) - 0.0001) < 1e-12,
        "the amplitude tail reaches its safe floor before fade-out");
      assert.equal(engine.junoFilterEnvelopeValueAt(first.voice, fadeAt), first.voice.baseCutoff,
        "the cutoff tail returns to base before fade-out");
      const reused = engine.scheduleJunoArpNote(72, first.reuseAt, interval * gate, false, interval);
      assert.strictEqual(reused, first.voice, "the fifth note reuses the first pool voice only after its effective release");
      assert.equal(state.juno.release, requestedRelease, "ARP does not mutate the release state");
      assert.equal(releaseInput.value, "720", "ARP does not alter the release control value");
      assert.equal(first.voice.amp.gain.cancelledAt.includes(first.reuseAt), true,
        "the retrigger cancels only after the prior amplitude tail reached its floor");
    }
  }
});

test("J-4 retains the requested release for slow ARP and manual notes", async () => {
  const { state, engine, ctx } = setup();
  await engine.init();
  Object.assign(state.juno, { release: 0.72 });
  const requestedRelease = state.juno.release;
  const interval = 60 / 96;
  const arpVoice = engine.scheduleJunoArpNote(60, 0.1, interval * 0.2, false, interval);
  assert.equal(arpVoice.effectiveArpRelease, requestedRelease, "slow ARP preserves a release that fits the pool turnaround");
  assert.equal(arpVoice.arpActiveUntil, arpVoice.releasedAt + requestedRelease);
  assert.equal(state.juno.release, requestedRelease, "slow ARP leaves release state untouched");

  const manualVoice = engine.startJunoVoice(64, 1);
  const releaseAt = 1.1;
  ctx.currentTime = releaseAt;
  engine.releaseJunoVoice(manualVoice, releaseAt);
  assert.ok(manualVoice.amp.gain.events.some((event) => event.type === "exponential" && event.time === releaseAt + requestedRelease),
    "manual notes retain the complete requested release");
  assert.equal(manualVoice.effectiveArpRelease, undefined, "manual voices do not use the ARP release policy");
});

test("J-4 non-filter controls preserve active cutoff automation", async () => {
  const controls = ["pwmAmount", "sub", "resonance", "pulseWidth"].map((name) => {
    const listeners = new Map();
    const input = {
      min: "0", max: "100", value: "0", style: { setProperty() {} },
      addEventListener(type, listener) { listeners.set(type, listener); },
    };
    return {
      control: { dataset: { junoControl: name }, querySelector(selector) { return selector === "input" ? input : { textContent: "" }; } },
      input, listeners,
    };
  });
  const { state, engine, ctx, bindJunoControls } = setup({ junoControls: controls.map(({ control }) => control) });
  await engine.init();
  Object.assign(state.juno, { attack: 0.2, decay: 0.3, sustain: 0.5 });
  const voice = engine.startJunoVoice(60, 0.01);
  ctx.currentTime = 0.12;
  const before = structuredClone(voice.filterA.frequency.events);
  bindJunoControls();

  for (const { control, input, listeners } of controls) {
    input.value = control.dataset.junoControl === "resonance" ? "9" : "70";
    listeners.get("input")();
  }

  assert.deepEqual(voice.filterA.frequency.events, before);
  assert.deepEqual(voice.filterB.frequency.events, before);
});

test("J-4 live controls write only their owning AudioParams", async () => {
  const cases = [
    ["resonance", 9, 8], ["pwmAmount", 70, 1], ["sub", 50, 4], ["pulseWidth", 68, 4],
    ["highPass", 600, 4], ["lfoRate", 360, 1], ["lfoPitch", 65, 1], ["lfoFilter", 72, 1],
    ["cutoff", 4300, 0], ["envAmount", 4100, 0], ["attack", 180, 0], ["decay", 620, 0],
    ["sustain", 45, 0], ["release", 980, 0], ["fineTune", 17, 0],
  ];
  for (const [name, rawValue, expectedParams] of cases) {
    const { state, engine, ctx, applyJunoControl } = setup();
    await engine.init();
    state.bpm = 190;
    state.juno.arp.division = "1/16";
    const interval = 60 / state.bpm / 4;
    const voices = Array.from({ length: 4 }, (_, index) => engine.scheduleJunoArpNote(
      60 + index, 0.1 + index * interval, interval * 0.5, false, interval,
    ));
    const liveParams = [
      engine.junoUnit.chorusLfo.frequency, engine.junoUnit.chorusDepthLeft.gain, engine.junoUnit.chorusDepthRight.gain,
      engine.junoUnit.wet.gain, engine.junoUnit.dry.gain, engine.junoUnit.lfo.frequency, engine.junoUnit.pitchDepth.gain,
      engine.junoUnit.filterDepth.gain, engine.junoUnit.pwmDepth.gain,
      ...voices.flatMap((voice) => [voice.sawGain.gain, voice.pulseGain.gain, voice.subGain.gain, voice.pulseBias.offset,
        voice.highPass.frequency, voice.filterA.Q, voice.filterB.Q]),
    ];
    const before = liveParams.map((param) => ({ events: param.events.length, cancels: param.cancelledAt.length }));
    const envelopes = voices.map((voice) => ({ amp: structuredClone(voice.amp.gain.events), filter: structuredClone(voice.filterA.frequency.events) }));
    ctx.currentTime = 0.05;
    applyJunoControl(name, rawValue);
    const changed = liveParams.reduce((count, param, index) => count + Number(param.events.length > before[index].events), 0);
    const cancels = liveParams.reduce((count, param, index) => count + param.cancelledAt.length - before[index].cancels, 0);
    const events = liveParams.reduce((count, param, index) => count + param.events.length - before[index].events, 0);
    assert.equal(changed, expectedParams, `${name}: only its owning params change`);
    assert.equal(cancels, expectedParams, `${name}: one controlled cancellation per owning param`);
    assert.equal(events, expectedParams * 2, `${name}: one anchor and target per owning param`);
    voices.forEach((voice, index) => {
      assert.deepEqual(voice.amp.gain.events, envelopes[index].amp, `${name}: amp ADSR remains exclusive`);
      assert.deepEqual(voice.filterA.frequency.events, envelopes[index].filter, `${name}: filter ADSR remains exclusive for ARP`);
    });
    const afterFirst = liveParams.map((param) => ({ events: param.events.length, cancels: param.cancelledAt.length }));
    applyJunoControl(name, rawValue);
    liveParams.forEach((param, index) => {
      assert.equal(param.events.length, afterFirst[index].events, `${name}: identical target schedules nothing`);
      assert.equal(param.cancelledAt.length, afterFirst[index].cancels, `${name}: identical target cancels nothing`);
    });
  }
});

test("J-4 slider bursts coalesce to one selective update with the last value", async () => {
  const listeners = new Map();
  const input = {
    min: "0", max: "16", value: "4.5", style: { setProperty() {} },
    addEventListener(type, listener) { listeners.set(type, listener); },
  };
  const control = {
    dataset: { junoControl: "resonance" },
    querySelector(selector) { return selector === "input" ? input : { textContent: "" }; },
  };
  const api = setup({ junoControls: [control] });
  await api.engine.init();
  const originalUpdate = api.engine.updateJunoVoices.bind(api.engine);
  let updates = 0;
  api.engine.updateJunoVoices = (...args) => { updates += 1; return originalUpdate(...args); };
  api.bindJunoControls();
  ["5.5", "8.0", "12.5"].forEach((value) => {
    input.value = value;
    listeners.get("input")();
  });
  assert.equal(updates, 0, "a drag burst does not update before the shared animation frame");
  assert.equal(api.callbacks.size, 1, "the burst queues one shared frame");
  const [[id, callback]] = api.callbacks;
  api.callbacks.delete(id);
  callback(16);
  assert.equal(updates, 1, "the frame applies one selective J-4 update");
  assert.equal(api.state.juno.resonance, 12.5, "the final pending slider value wins");
});

test("J-4 ARP control stress preserves envelopes with bounded live automation", async () => {
  const divisions = { "1/4": 1, "1/8": 0.5, "1/8T": 1 / 3, "1/16": 0.25 };
  for (const [division, beats] of Object.entries(divisions)) {
    const { state, engine, ctx } = setup();
    await engine.init();
    Object.assign(state.juno, { attack: 0.045, decay: 0.18, sustain: 0.55, release: 0.72, cutoff: 920, envAmount: 2800 });
    state.bpm = 190;
    state.juno.arp.division = division;
    const interval = 60 / state.bpm * beats;
    const voices = Array.from({ length: 4 }, (_, index) => engine.scheduleJunoArpNote(
      60 + index, 0.1 + index * interval, interval * 0.5, false, interval,
    ));
    const envelopes = voices.map((voice) => ({
      amp: structuredClone(voice.amp.gain.events),
      filterA: structuredClone(voice.filterA.frequency.events),
      filterB: structuredClone(voice.filterB.frequency.events),
    }));
    const changes = [
      ["resonance", (update) => 0.5 + (update % 90) / 10, () => voices[0].filterA.Q],
      ["pwmAmount", (update) => (update % 101) / 100, () => engine.junoUnit.pwmDepth.gain],
      ["sub", (update) => (update % 81) / 100, () => voices[0].subGain.gain],
      ["pulseWidth", (update) => 0.12 + (update % 75) / 100, () => voices[0].pulseBias.offset],
      ["highPass", (update) => 20 + (update % 80) * 25, () => voices[0].highPass.frequency],
      ["lfoRate", (update) => 0.08 + (update % 120) / 20, () => engine.junoUnit.lfo.frequency],
      ["lfoPitch", (update) => (update % 100) / 100, () => engine.junoUnit.pitchDepth.gain],
      ["lfoFilter", (update) => (update % 100) / 100, () => engine.junoUnit.filterDepth.gain],
      ["cutoff", (update) => 400 + (update % 120) * 80, null],
      ["envAmount", (update) => -5000 + (update % 200) * 50, null],
    ];
    for (let update = 0; update < 512; update += 1) {
      ctx.currentTime = 0.05 + update * 0.002;
      const [name, valueAt, paramForContinuity] = changes[update % changes.length];
      const param = paramForContinuity?.();
      const before = param?.valueAt(ctx.currentTime);
      state.juno[name] = valueAt(update);
      engine.updateJunoVoices(name);
      if (param) assert.ok(Math.abs(param.valueAt(ctx.currentTime) - before) < 1e-9,
        `${division}: ${name} preserves its effective live value while retargeting`);
    }

    voices.forEach((voice, index) => {
      assert.deepEqual(voice.amp.gain.events, envelopes[index].amp, `${division}: control bursts do not rewrite amp ADSR`);
      assert.deepEqual(voice.filterA.frequency.events, envelopes[index].filterA, `${division}: control bursts do not rewrite filter ADSR`);
      assert.deepEqual(voice.filterB.frequency.events, envelopes[index].filterB, `${division}: control bursts do not rewrite both filter ADSRs`);
      assert.equal(voice.amp.gain.cancelledAt.length, 1, `${division}: amp is cancelled only by its original ARP programming`);
      assert.equal(voice.filterA.frequency.cancelledAt.length, 1, `${division}: filter is cancelled only by its original ARP programming`);
      [voice.sawGain.gain, voice.pulseGain.gain, voice.subGain.gain, voice.pulseBias.offset, voice.highPass.frequency, voice.filterA.Q, voice.filterB.Q]
        .forEach((param) => assert.ok(param.events.length <= 2, `${division}: live-only parameter automation remains bounded`));
    });
    assert.ok(engine.junoUnit.lfo.frequency.events.length <= 2, `${division}: shared J-4 LFO automation remains bounded`);
    assert.ok(engine.junoUnit.pwmDepth.gain.events.length <= 2, `${division}: shared PWM automation remains bounded`);
  }
});

test("DIRECTO reuses safe live controls and mutes channels without changing transport or allocating nodes", async () => {
  const { state, engine, ctx, applyDirectControl, toggleDirectMute } = setup();
  await engine.init();
  const voice = engine.startJunoVoice(60, ctx.currentTime + 0.01);
  const cutoffEvents = voice.filterA.frequency.events.slice();
  const patterns = { drums: JSON.stringify(state.drumPattern), bass: JSON.stringify(state.bassPattern) };
  state.playing = true;
  state.currentStep = 9;
  const nodes = ctx.created;

  applyDirectControl("bassCutoff", 1760);
  applyDirectControl("junoCutoff", 4300);
  applyDirectControl("junoResonance", 8.2);
  applyDirectControl("junoArpGate", 53);
  const eventsAfterCutoff = voice.filterA.frequency.events.slice();
  applyDirectControl("junoLfoFilter", 71);

  assert.equal(state.synth.cutoff, 1760);
  assert.equal(state.juno.cutoff, 4300);
  assert.equal(state.juno.resonance, 8.2);
  assert.equal(state.juno.arp.gate, 0.53);
  assert.equal(state.juno.lfoFilter, 0.71);
  assert.equal(engine.junoUnit.filterDepth.gain.events.at(-1).value, 0.71 * 2400);
  assert.deepEqual(voice.filterA.frequency.events, eventsAfterCutoff, "FILTER LFO must not alter an active cutoff envelope");
  assert.notDeepEqual(eventsAfterCutoff, cutoffEvents, "DIRECTO cutoff must use the live cutoff rebase path");

  toggleDirectMute("drums");
  toggleDirectMute("bass");
  toggleDirectMute("juno");
  assert.equal(ctx.created, nodes, "mute must not allocate audio nodes");
  assert.equal(state.playing, true);
  assert.equal(state.currentStep, 9);
  assert.equal(JSON.stringify(state.drumPattern), patterns.drums);
  assert.equal(JSON.stringify(state.bassPattern), patterns.bass);
  ["kick", "snare", "clap", "closedHat", "openHat", "bass", "juno"].forEach((id) => {
    assert.equal(engine.channels[id].gain.gain.events.at(-1).value, 0, `${id} must fade to mute`);
  });

  toggleDirectMute("drums");
  toggleDirectMute("bass");
  toggleDirectMute("juno");
  ["kick", "snare", "clap", "closedHat", "openHat", "bass", "juno"].forEach((id) => {
    assert.equal(engine.channels[id].gain.gain.events.at(-1).value, state.levels[id], `${id} must recover its stored level`);
  });
});

test("BASS FOLLOW arms without a chord and retains the lowest J-4 chord root", () => {
  const api = setup();
  const patternBefore = JSON.stringify(api.state.bassPattern);

  api.toggleBassFollow();
  assert.equal(api.state.bassFollow.enabled, true);
  assert.equal(api.state.bassFollow.pendingRootMidi, null, "FOLLOW waits when no J-4 chord exists");
  assert.equal(api.state.bassFollow.effectiveRootMidi, null, "arming alone leaves the bass at its untransposed base");

  api.engine.junoInputNotes.set("67:one", { midi: 67, order: 1 });
  api.engine.junoInputNotes.set("60:two", { midi: 60, order: 2 });
  api.engine.junoInputNotes.set("64:three", { midi: 64, order: 3 });
  assert.equal(api.getLowestBassFollowRootMidi(), 60, "the lowest held J-4 note is the chord root");
  assert.equal(api.queueBassFollowRootFromJuno(), true);
  assert.equal(api.state.bassFollow.pendingRootMidi, 60);
  api.applyPendingBassFollowRoot();
  assert.equal(api.state.bassFollow.effectiveRootMidi, 60);

  api.engine.junoInputNotes.clear();
  assert.equal(api.queueBassFollowRootFromJuno(), false, "releasing a chord keeps the retained root");
  assert.equal(api.state.bassFollow.effectiveRootMidi, 60);

  api.engine.junoInputNotes.set("65:new", { midi: 65, order: 4 });
  api.engine.junoInputNotes.set("69:new", { midi: 69, order: 5 });
  api.queueBassFollowRootFromJuno();
  api.applyPendingBassFollowRoot();
  assert.equal(api.state.bassFollow.effectiveRootMidi, 65, "a new chord replaces the retained root");
  assert.equal(JSON.stringify(api.state.bassPattern), patternBefore, "FOLLOW never mutates the saved bass pattern");
});

test("BASS FOLLOW uses ARP chord ownership and transposes only future scheduled bass steps", async () => {
  const api = setup();
  await api.engine.init();
  const patternBefore = JSON.stringify(api.state.bassPattern);
  const invariants = {
    bpm: api.state.bpm,
    drums: JSON.stringify(api.state.drumPattern),
    mutes: JSON.stringify(api.state.mutes),
    directMutes: JSON.stringify(api.state.directMutes),
    juno: JSON.stringify(api.state.juno),
  };
  const scheduled = [];
  api.engine.scheduleBass = (step, time, duration, previousMidi) => {
    scheduled.push({ step: { ...step }, time, duration, previousMidi });
    return { stopAt: time + duration, fadeAt: Infinity };
  };

  api.state.bassFollow.enabled = true;
  api.state.juno.arp.enabled = true;
  api.state.juno.arp.hold = true;
  invariants.juno = JSON.stringify(api.state.juno);
  api.engine.junoInputNotes.set("60:input", { midi: 60, order: 1 });
  api.engine.junoLatchedNotes.set("66:held", { midi: 66, order: 1 });
  api.engine.junoLatchedNotes.set("70:held", { midi: 70, order: 2 });
  assert.deepEqual(Array.from(api.getBassFollowSourceNotes(), (note) => note.midi), [66, 70], "ARP FOLLOW reads held chord ownership, not input or arp playback");
  api.queueBassFollowRootFromJuno();
  assert.equal(api.state.bassFollow.pendingRootMidi, 66);

  const previousEffective = api.state.bassFollow.effectiveRootMidi;
  assert.equal(previousEffective, null);
  assert.equal(scheduled.length, 0, "queuing a root does not retune already scheduled bass voices");
  api.scheduleStep(0, 4);
  assert.equal(api.state.bassFollow.effectiveRootMidi, 66, "the root becomes effective inside a future scheduler step");
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].step.midi, api.state.bassPattern[0].midi - 6, "a tritone follows the documented descending tie-break");
  assert.equal(JSON.stringify(api.state.bassPattern), patternBefore);

  api.toggleBassFollow();
  assert.equal(api.state.bassFollow.enabled, false);
  assert.equal(api.state.bassFollow.effectiveRootMidi, null, "disabling clears the retained root immediately without touching live audio");
  api.scheduleStep(3, 4.1);
  assert.equal(scheduled.at(-1).step.midi, api.state.bassPattern[3].midi, "returning OFF restores untransposed bass notes");

  assert.equal(api.state.bpm, invariants.bpm);
  assert.equal(JSON.stringify(api.state.drumPattern), invariants.drums);
  assert.equal(JSON.stringify(api.state.mutes), invariants.mutes);
  assert.equal(JSON.stringify(api.state.directMutes), invariants.directMutes);
  assert.equal(JSON.stringify(api.state.juno), invariants.juno);
});

test("BASS FOLLOW OFF clears stale roots and a fresh arm waits for a new chord", () => {
  const api = setup();
  const scheduled = [];
  api.engine.scheduleBass = (step) => scheduled.push({ ...step });
  const firstActive = api.state.bassPattern.findIndex((step) => step.active);
  api.state.bassFollow.enabled = true;
  api.state.bassFollow.effectiveRootMidi = 29;

  api.toggleBassFollow();
  assert.equal(api.state.bassFollow.enabled, false);
  assert.equal(api.state.bassFollow.pendingRootMidi, null);
  assert.equal(api.state.bassFollow.effectiveRootMidi, null);
  api.state.bassPattern[firstActive].midi = 31;
  api.scheduleStep(firstActive, 2);
  assert.equal(scheduled.at(-1).midi, 31, "OFF follows an edited pattern note without a residual transpose");

  api.toggleBassFollow();
  assert.equal(api.state.bassFollow.enabled, true);
  assert.equal(api.state.bassFollow.pendingRootMidi, null);
  assert.equal(api.state.bassFollow.effectiveRootMidi, null, "OFF -> ON without notes is visibly armed but rootless");

  api.engine.junoInputNotes.set("65:chord", { midi: 65, order: 1 });
  assert.equal(api.queueBassFollowRootFromJuno(), true);
  assert.equal(api.state.bassFollow.pendingRootMidi, 65, "OFF -> ON with a chord queues its fresh root");
});

test("BASS FOLLOW uses the nearest pitch-class interval and preserves pattern intervals", () => {
  const api = setup();
  const baseStep = api.state.bassPattern.find((step) => step.active);
  baseStep.midi = 28; // E
  api.state.bassFollow.enabled = true;

  api.state.bassFollow.effectiveRootMidi = 26; // D: -2, not +10
  assert.equal(api.getBassFollowMidi(28), 26);
  assert.equal(api.getBassFollowMidi(35), 33, "all pattern notes keep the same intervalal relationship");

  api.state.bassFollow.effectiveRootMidi = 33; // F: +5
  assert.equal(api.getBassFollowMidi(28), 33, "nearest upper root moves upward when closer");

  api.state.bassFollow.effectiveRootMidi = 34; // F#: tritone
  assert.equal(api.getBassFollowMidi(28), 22, "tritone ties choose the descending -6 direction");
});

test("BASS FOLLOW retains chord ownership across releases and ignores ARP playback, blur, hidden, and tabs", async () => {
  const api = setup();
  api.state.bassFollow.enabled = true;
  api.engine.junoInputNotes.set("60:low", { midi: 60, order: 1 });
  api.engine.junoInputNotes.set("67:high", { midi: 67, order: 2 });
  api.queueBassFollowRootFromJuno();
  api.applyPendingBassFollowRoot();
  api.engine.junoInputNotes.delete("60:low");
  assert.equal(api.state.bassFollow.effectiveRootMidi, 60, "releasing the lowest key keeps the retained root");

  api.state.juno.arp.enabled = true;
  api.state.juno.arp.hold = false;
  api.engine.junoInputNotes.set("62:source", { midi: 62, order: 3 });
  api.engine.junoLatchedNotes.set("75:arp-output", { midi: 75, order: 4 });
  assert.deepEqual(Array.from(api.getBassFollowSourceNotes(), (note) => note.midi), [67, 62], "normal ARP still reads held keyboard ownership, never its steps");
  api.queueBassFollowRootFromJuno();
  api.applyPendingBassFollowRoot();
  assert.equal(api.state.bassFollow.effectiveRootMidi, 62);

  api.switchTab("fx");
  api.dispatchWindowEvent("blur");
  api.document.visibilityState = "hidden";
  await api.handleVisibilityChange();
  assert.equal(api.state.bassFollow.effectiveRootMidi, 62, "focus and visibility cleanup never erase the retained FOLLOW root");
});

test("BASS FOLLOW transport initialization uses the effective root and repeated toggles stay inert", async () => {
  const api = setup();
  await api.engine.init();
  api.state.bassFollow.enabled = true;
  api.state.bassFollow.effectiveRootMidi = 26;
  api.state.bassPattern[15] = { ...api.state.bassPattern[15], active: true, midi: 36 };
  const scheduled = [];
  api.engine.scheduleBass = (step, time, duration, previousMidi) => scheduled.push({ step: { ...step }, previousMidi });
  await api.startTransport();
  assert.equal(scheduled[0].previousMidi, 38, "initial slide source is already transposed when FOLLOW is effective");
  api.stopTransport();

  api.toggleBassFollow();
  const beforeNodes = api.ctx.created;
  const beforeScheduled = scheduled.length;
  for (let index = 0; index < 100; index += 1) {
    api.toggleBassFollow();
    api.toggleBassFollow();
  }
  assert.equal(api.state.bassFollow.enabled, false);
  assert.equal(api.state.bassFollow.pendingRootMidi, null);
  assert.equal(api.state.bassFollow.effectiveRootMidi, null);
  assert.equal(api.ctx.created, beforeNodes, "FOLLOW toggles do not allocate nodes or schedule audio automation");
  assert.equal(scheduled.length, beforeScheduled, "FOLLOW toggles do not add bass events until a future scheduler step");
});

test("BREAK SNARE starts on the next safe quarter-note boundary and ONLY replaces future pattern drums", async () => {
  const { state, engine, requestSnareBreak, scheduleStep } = setup();
  await engine.init();
  const hits = [];
  engine.scheduleDrum = (track, time, level, velocity) => { if (level > 0) hits.push({ track, time, level, velocity }); };
  engine.scheduleBass = () => {};
  state.playing = true;
  state.snareBreak.mode = "ONLY";
  const patterns = JSON.stringify(state.drumPattern);
  const transport = { bpm: state.bpm, step: state.currentStep, bass: JSON.stringify(state.bassPattern), juno: JSON.stringify(state.juno), mutes: JSON.stringify(state.mutes) };

  requestSnareBreak();
  assert.equal(state.snareBreak.status, "armed");
  scheduleStep(5, 3.25);
  assert.equal(state.snareBreak.status, "armed", "a non-quarter step must leave the break armed");
  assert.equal(hits.some((hit) => hit.velocity !== undefined), false);
  scheduleStep(8, 3.375);

  assert.equal(state.snareBreak.status, "active");
  assert.equal(state.snareBreak.startStep, 8);
  assert.equal(state.snareBreak.startTime, 3.375);
  assert.deepEqual(hits.at(-1), { track: "snare", time: 3.375, level: 1, velocity: 50 / 127 });
  assert.equal(JSON.stringify(state.drumPattern), patterns);
  assert.equal(state.bpm, transport.bpm);
  assert.equal(state.currentStep, transport.step);
  assert.equal(JSON.stringify(state.bassPattern), transport.bass);
  assert.equal(JSON.stringify(state.juno), transport.juno);
  assert.equal(JSON.stringify(state.mutes), transport.mutes);
});

test("BREAK SNARE ADD retains pattern hits and each duration restores them after its exact bar count", async () => {
  for (const bars of [1, 2, 4, 8]) {
    const { state, engine, requestSnareBreak, scheduleStep } = setup();
    await engine.init();
    const hits = [];
    engine.scheduleDrum = (track, time, level, velocity) => { if (level > 0) hits.push({ track, time, level, velocity }); };
    engine.scheduleBass = () => {};
    state.playing = true;
    state.snareBreak.mode = "ADD";
    state.snareBreak.bars = bars;
    const patterns = JSON.stringify(state.drumPattern);
    requestSnareBreak();

    const totalSteps = bars * 16;
    for (let index = 0; index < totalSteps; index += 1) scheduleStep(index % 16, index * 0.1);
    const breakHits = hits.filter((hit) => hit.track === "snare" && hit.velocity !== undefined);
    const regularAtFirstStep = Object.entries(state.drumPattern)
      .filter(([, pattern]) => pattern[0] > 0).length;
    assert.equal(breakHits.length, totalSteps, `${bars} bars must add one snare per sixteenth`);
    assert.equal(hits.filter((hit) => hit.time === 0).length, regularAtFirstStep + 1, "ADD keeps normal pattern hits");
    assert.equal(breakHits[0].velocity, 50 / 127, "break snare must start at MIDI velocity 50");
    assert.equal(breakHits.at(-1).velocity, 1, "break snare must end at MIDI velocity 127");
    const midpoint = Math.floor((totalSteps - 1) / 2);
    assert.ok(Math.abs(breakHits[midpoint].velocity - (50 / 127 + (1 - 50 / 127) * midpoint / (totalSteps - 1))) < 1e-12,
      "break snare fade must progress uniformly across its duration");
    assert.equal(state.snareBreak.status, "idle", `${bars} bars must restore automatically`);
    const beforeRestore = hits.length;
    scheduleStep(0, totalSteps * 0.1);
    assert.equal(hits.length - beforeRestore, regularAtFirstStep, "normal pattern resumes on the next sixteenth");
    assert.equal(JSON.stringify(state.drumPattern), patterns);
  }
});

test("BREAK SNARE cancellation takes effect on the next safe quarter-note boundary without persistent growth", async () => {
  const { state, engine, ctx, callbacks, requestSnareBreak, scheduleStep } = setup();
  await engine.init();
  const hits = [];
  engine.scheduleDrum = (track, time, level, velocity) => { if (level > 0) hits.push({ track, time, level, velocity }); };
  engine.scheduleBass = () => {};
  state.playing = true;
  state.bpm = 190;
  const nodes = ctx.created;
  const patterns = JSON.stringify(state.drumPattern);
  const normalAtStep = (step) => Object.entries(state.drumPattern).filter(([, pattern]) => pattern[step] > 0).length;

  for (let index = 0; index < 80; index += 1) {
    requestSnareBreak();
    scheduleStep(0, index * 0.01);
    requestSnareBreak();
    const beforePendingCancel = hits.length;
    scheduleStep(1, index * 0.01 + 0.0025);
    assert.equal(hits.length - beforePendingCancel, 1, "cancel must keep the break until a quarter-note boundary");
    const beforeCancel = hits.length;
    scheduleStep(4, index * 0.01 + 0.005);
    assert.equal(hits.length - beforeCancel, normalAtStep(4), "cancel restores pattern at the next safe quarter-note boundary");
    for (const [id, callback] of [...callbacks]) { callbacks.delete(id); callback(); }
  }
  assert.equal(ctx.created, nodes, "arming or cancelling must not allocate structural audio nodes");
  assert.ok(callbacks.size <= 1, "break adds no timers; an in-flight visual RAF may remain for a queued playhead");
  assert.equal(JSON.stringify(state.drumPattern), patterns);
});

test("J-4 rebases live cutoff without a discontinuity during filter decay", async () => {
  const { state, engine, ctx } = setup();
  await engine.init();
  Object.assign(state.juno, { attack: 0.2, decay: 0.3, sustain: 0.5, cutoff: 1000, envAmount: 3000 });
  const voice = engine.startJunoVoice(60, 0.01);
  ctx.currentTime = 0.31;
  const cutoffBefore = engine.junoFilterEnvelopeValueAt(voice, ctx.currentTime);
  state.juno.cutoff = 1800;
  engine.updateJunoVoices("cutoff");

  const rebase = voice.filterA.frequency.events.find((event) => event.type === "set" && event.time === ctx.currentTime);
  assert.ok(Math.abs(rebase.value - cutoffBefore) < 1e-12, "rebasing begins at the current cutoff value");
  assert.equal(voice.filterA.frequency.events.some((event) => event.type === "target"), false, "filter ADSR never uses setSmooth");
  assert.equal(voice.filterSustainCutoff, 3300, "the new cutoff retains the same ADSR sustain fraction");
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
  const filterEvents = new Map(voices.map((voice) => [voice, structuredClone(voice.filterA.frequency.events)]));

  for (let index = 0; index < 4000; index += 1) {
    ctx.currentTime += 0.003;
    state.juno.cutoff = 400 + (index % 120) * 80;
    state.juno.pulseWidth = 0.12 + (index % 75) / 100;
    state.juno.pwmAmount = (index % 101) / 100;
    state.juno.lfoRate = 0.08 + (index % 120) / 20;
    engine.updateJunoVoices("pwmAmount");
    assert.ok(engine.junoUnit.lfo.frequency.events.length <= 2);
    assert.ok(engine.junoUnit.pwmDepth.gain.events.length <= 2);
    voices.forEach((voice) => {
      assert.ok(voice.pulseBias.offset.events.length <= 2);
      assert.deepEqual(voice.filterA.frequency.events, filterEvents.get(voice));
      assert.deepEqual(voice.filterB.frequency.events, filterEvents.get(voice));
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

test("Mac keyboard mapping keeps held J-4 notes across internal tab changes", async () => {
  const api = setup();
  const pressed = [];
  const released = [];
  api.engine.pressJunoKey = async (midi, id) => { pressed.push([midi, id]); };
  api.engine.releaseJunoKey = (midi, id) => { released.push([midi, id]); };
  api.switchTab("juno");
  const event = (code, extra = {}) => ({
    code, repeat: false, metaKey: false, ctrlKey: false, altKey: false,
    target: { tagName: "BODY", isContentEditable: false },
    preventDefault() { this.prevented = true; },
    ...extra,
  });

  ["KeyZ", "KeyC", "KeyB", "KeyM"].forEach((code) => api.handleComputerJunoKeyDown(event(code)));
  await Promise.resolve();
  assert.deepEqual(pressed.map(([midi]) => midi), [60, 64, 67, 71]);
  assert.equal(api.getComputerJunoHeldCount(), 4);

  api.handleComputerJunoKeyDown(event("KeyZ", { repeat: true }));
  api.handleComputerJunoKeyDown(event("KeyQ", { target: { tagName: "INPUT" } }));
  assert.equal(pressed.length, 4, "key repeat and editable controls must not create notes");

  api.handleComputerJunoKeyUp(event("KeyZ"));
  assert.deepEqual(released[0], [60, "computer-KeyZ"]);
  assert.equal(api.getComputerJunoHeldCount(), 3);

  api.switchTab("fx");
  assert.equal(api.getComputerJunoHeldCount(), 3, "internal navigation must not release held computer keys");
  assert.deepEqual(released.map(([midi]) => midi), [60]);
});

test("a live held J-4 voice survives switchTab fx until its matching keyup", async () => {
  const api = setup();
  await api.engine.init();
  api.switchTab("juno");
  const event = {
    code: "KeyZ", repeat: false, metaKey: false, ctrlKey: false, altKey: false,
    target: { tagName: "BODY", isContentEditable: false }, preventDefault() {},
  };
  api.handleComputerJunoKeyDown(event);
  await new Promise((resolve) => setImmediate(resolve));
  const key = "60:computer-KeyZ";
  const voice = api.engine.junoHeldVoices.get(key);
  assert.ok(voice, "the physical key owns a live manual J-4 voice");
  assert.equal(voice.releasedAt, Infinity);

  api.switchTab("fx");
  assert.equal(api.engine.junoHeldVoices.get(key), voice, "internal navigation keeps the held voice");
  assert.equal(voice.releasedAt, Infinity, "internal navigation does not release its envelope");

  api.handleComputerJunoKeyUp(event);
  assert.equal(api.engine.junoHeldVoices.has(key), false, "the matching keyup remains the release owner");
});

test("real blur and document invisibility release held J-4 computer keys without changing ARP", async () => {
  const api = setup();
  const pressed = [];
  const released = [];
  api.engine.pressJunoKey = async (midi, id) => { pressed.push([midi, id]); };
  api.engine.releaseJunoKey = (midi, id) => { released.push([midi, id]); };
  api.bindJunoControls();
  api.switchTab("juno");
  const event = (code) => ({
    code, repeat: false, metaKey: false, ctrlKey: false, altKey: false,
    target: { tagName: "BODY", isContentEditable: false }, preventDefault() {},
  });

  api.state.juno.arp.enabled = true;
  api.engine.junoInputNotes.set("60:arp", { midi: 60, order: 1 });
  api.handleComputerJunoKeyDown(event("KeyZ"));
  await Promise.resolve();
  api.dispatchWindowEvent("blur");
  assert.equal(api.getComputerJunoHeldCount(), 0, "window blur releases physical keyboard ownership");
  assert.deepEqual(released, [[60, "computer-KeyZ"]]);
  assert.equal(api.engine.junoInputNotes.size, 1, "blur does not alter ARP note state directly");

  api.handleComputerJunoKeyDown(event("KeyC"));
  await Promise.resolve();
  api.document.visibilityState = "hidden";
  await api.handleVisibilityChange();
  assert.equal(api.getComputerJunoHeldCount(), 0, "hidden documents release held computer keys");
  assert.deepEqual(released.at(-1), [64, "computer-KeyC"]);
  assert.equal(api.engine.junoInputNotes.size, 1, "visibility cleanup preserves ARP ownership/state");
  assert.equal(pressed.length, 2);
});

test("ARP-5 builds deterministic UP, DOWN, UP/DOWN, and played-order ranges", () => {
  const api = setup();
  const notes = [{ midi: 67, order: 2 }, { midi: 60, order: 1 }, { midi: 64, order: 3 }, { midi: 60, order: 4 }];
  assert.deepEqual(Array.from(api.buildArpSequence(notes, "UP", 2)), [60, 64, 67, 72, 76, 79]);
  assert.deepEqual(Array.from(api.buildArpSequence(notes, "DOWN", 1)), [67, 64, 60]);
  assert.deepEqual(Array.from(api.buildArpSequence(notes, "UP/DOWN", 1)), [60, 64, 67, 64]);
  assert.deepEqual(Array.from(api.buildArpSequence(notes, "ORDER", 1)), [60, 67, 64]);
});

test("ARP-5 schedules triplets on the audio clock and derives note length from GATE", async () => {
  const api = setup();
  await api.engine.init();
  api.state.playing = true;
  api.state.bpm = 120;
  api.state.juno.arp.enabled = true;
  api.state.juno.arp.division = "1/8T";
  api.state.juno.arp.gate = 0.5;
  api.engine.junoInputNotes.set("60:test", { midi: 60, order: 1 });
  api.setArpClock(0.1, 0.1);
  api.scheduleArpeggiator(0, 0.45);

  const voices = [...api.engine.junoVoices].sort((a, b) => a.startAt - b.startAt);
  assert.equal(voices.length, 3);
  assert.ok(Math.abs(voices[0].startAt - 0.1) < 1e-9);
  assert.ok(Math.abs(voices[1].startAt - (0.1 + 1 / 6)) < 1e-9);
  assert.ok(Math.abs(voices[2].startAt - (0.1 + 2 / 6)) < 1e-9);
  voices.forEach((voice) => {
    assert.equal(voice.origin, "arp-pool");
    assert.ok(Math.abs((voice.releasedAt - voice.startAt) - 1 / 12) < 1e-9);
  });
});

test("ARP-5 reuses four voices for ten minutes without clock gaps or node churn", async () => {
  const api = setup();
  await api.engine.init();
  api.state.playing = true;
  api.state.bpm = 190;
  api.state.juno.arp.enabled = true;
  api.state.juno.arp.division = "1/16";
  api.state.juno.arp.gate = 0.72;
  api.engine.junoInputNotes.set("60:test", { midi: 60, order: 1 });
  api.engine.junoInputNotes.set("64:test", { midi: 64, order: 2 });
  api.engine.junoInputNotes.set("67:test", { midi: 67, order: 3 });
  const scheduledTimes = [];
  const schedule = api.engine.scheduleJunoNote.bind(api.engine);
  api.engine.scheduleJunoNote = (...args) => {
    scheduledTimes.push(args[1]);
    return schedule(...args);
  };
  api.setArpClock(0.05, 0.05);

  for (let now = 0; now < 1; now += 0.025) {
    api.ctx.currentTime = now;
    api.scheduleArpeggiator(now, now + 0.11);
  }
  const warmNodes = api.ctx.nodes.size;
  const warmCreated = api.ctx.created;
  assert.equal(api.engine.junoArpVoicePool.length, 4);

  for (let now = 1; now < 600; now += 0.025) {
    api.ctx.currentTime = now;
    api.scheduleArpeggiator(now, now + 0.11);
  }
  const interval = 60 / 190 / 4;
  assert.ok(scheduledTimes.length > 7500, "the arpeggiator must continue through the full simulation");
  for (let index = 1; index < scheduledTimes.length; index += 1) {
    assert.ok(Math.abs((scheduledTimes[index] - scheduledTimes[index - 1]) - interval) < 1e-8,
      `clock gap at note ${index}`);
  }
  assert.equal(api.engine.junoArpVoicePool.length, 4);
  assert.equal(api.ctx.nodes.size, warmNodes);
  assert.equal(api.ctx.created, warmCreated, "ARP notes must never allocate after the four-voice pool is warm");
});

test("ARP-5 HOLD keeps a released chord and replaces it on the next chord", async () => {
  const api = setup();
  api.state.juno.arp.enabled = true;
  api.state.juno.arp.hold = true;
  await api.engine.pressJunoKey(60, "a");
  await api.engine.pressJunoKey(64, "b");
  api.engine.releaseJunoKey(60, "a");
  api.engine.releaseJunoKey(64, "b");
  assert.deepEqual([...api.engine.junoLatchedNotes.values()].map((note) => note.midi), [60, 64]);

  await api.engine.pressJunoKey(67, "c");
  await api.engine.pressJunoKey(71, "d");
  assert.deepEqual([...api.engine.junoLatchedNotes.values()].map((note) => note.midi), [67, 71]);
});

test("ARP-5 STOP cancels queued voices and returns to the permanent graph", async () => {
  const api = setup();
  await api.engine.init();
  const baselineNodes = api.ctx.nodes.size;
  const baselineSources = api.ctx.sources.size;
  api.state.playing = true;
  api.state.juno.arp.enabled = true;
  api.state.juno.arp.division = "1/16";
  api.engine.junoInputNotes.set("60:test", { midi: 60, order: 1 });
  api.engine.junoInputNotes.set("64:test", { midi: 64, order: 2 });
  api.setArpClock(0.1, 0.1);
  api.scheduleArpeggiator(0, 0.3);
  assert.ok(api.engine.junoVoices.size > 0);

  api.stopTransport();
  api.ctx.finishUntil(2);
  for (const [id, callback] of [...api.callbacks]) { api.callbacks.delete(id); callback(); }
  api.ctx.finishUntil(2.2);
  assert.equal(api.engine.junoVoices.size, 0);
  assert.equal(api.engine.junoUnit, null);
  assert.equal(api.ctx.nodes.size, baselineNodes);
  assert.equal(api.ctx.sources.size, baselineSources);
  assert.equal(api.callbacks.size, 0);
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
    assert.ok(param.events.filter((event) => event.time >= ctx.currentTime).length <= 2,
      "only the current control automation may remain scheduled into the future");
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

test("performance diagnostics stay inert while disabled and use fixed-size buffers when explicitly enabled", async () => {
  const api = setup();
  const { diagnostics, engine } = api;
  assert.equal(diagnostics.enabled, false);
  assert.equal(diagnostics.buffers, null, "disabled diagnostics must not allocate sample buffers");
  diagnostics.recordScheduler(0, 80, 2, 110, 3);
  assert.equal(diagnostics.buffers, null, "disabled scheduler recording must have no side effect");

  await engine.init();
  diagnostics.enable(engine);
  assert.equal(diagnostics.buffers.length, 19);
  assert.equal(diagnostics.buffers[0].length, 256, "each diagnostic ring buffer has a fixed capacity");
  for (let index = 0; index < 300; index += 1) diagnostics.record("schedulerLateness", index);
  const snapshot = diagnostics.snapshot(engine);
  const lateness = new Map(snapshot.scheduler).get("schedulerLateness");
  assert.equal(lateness.count, 256, "the ring buffer retains a fixed recent window");
  assert.equal(lateness.max, 299);
  diagnostics.disable();
});

test("performance diagnostics record scheduler lateness and skipped steps without changing scheduling", async () => {
  const api = setup({ clock: { now: 1000 } });
  await api.engine.init();
  api.state.playing = true;
  api.ctx.currentTime = 10.02;
  api.setSchedulerTimeline(1, 0);
  api.diagnostics.enable(api.engine);
  api.scheduler();
  const snapshot = api.diagnostics.snapshot(api.engine);
  const scheduler = new Map(snapshot.scheduler);
  assert.ok(snapshot.totals.schedulerTicks >= 1);
  assert.ok(snapshot.totals.skippedSteps > 0, "late scheduler recovery must report skipped steps");
  assert.equal(scheduler.get("schedulerSkippedThisTick").max, snapshot.totals.skippedSteps, "the per-tick series and total use the same skipped-step unit");
  assert.ok(scheduler.get("schedulerLateness").max > 0);
  assert.ok(scheduler.get("schedulerEvents").max > 0);
  assert.ok(scheduler.get("schedulerHorizon").max > 0);
  api.diagnostics.disable();
});

test("performance diagnostics degrade silently when PerformanceObserver is unavailable", async () => {
  const api = setup();
  await api.engine.init();
  assert.doesNotThrow(() => api.diagnostics.enable(api.engine));
  assert.equal(api.diagnostics.observer, null);
  assert.equal(api.diagnostics.snapshot(api.engine).totals.longTasks, 0);
  api.diagnostics.disable();
});

test("diagnostics capture audio-clock progress, output timestamps, and bounded event windows", async () => {
  const api = setup({ clock: { now: 1000 } });
  await api.engine.init();
  api.ctx.currentTime = 10;
  api.ctx.baseLatency = 0.02;
  api.ctx.outputLatency = 0.04;
  api.ctx.getOutputTimestamp = () => ({ contextTime: api.ctx.currentTime - 0.01, performanceTime: api.clock.now - 7 });
  api.diagnostics.enable(api.engine);
  api.diagnostics.captureAudioClock(api.engine);

  api.clock.now = 1120;
  api.ctx.currentTime = 10.02;
  api.diagnostics.captureAudioClock(api.engine);
  api.diagnostics.recordScheduledEvent(9.99, 10.08, api.engine);
  api.diagnostics.recordScheduledEvent(10.06, 10.14, api.engine);
  api.diagnostics.recordScheduledEvent(10.5, 10.7, api.engine);
  const snapshot = api.diagnostics.snapshot(api.engine);

  assert.equal(snapshot.scheduling.past, 1);
  assert.equal(snapshot.scheduling.inHorizon, 1);
  assert.equal(snapshot.scheduling.tooFar, 1);
  assert.equal(snapshot.clock.outputTimestamp.currentTime, 10.02);
  assert.equal(snapshot.clock.outputTimestamp.contextTime, 10.01);
  assert.equal(snapshot.clock.outputTimestamp.performanceTime, 1113);
  assert.equal(snapshot.clock.outputTimestamp.baseLatency, 0.02);
  assert.equal(snapshot.clock.outputTimestamp.outputLatency, 0.04);
  assert.ok(snapshot.clock.lastJumpMs >= 99, "wall/audio divergence records its last significant jump");
  const timing = new Map(snapshot.timing);
  assert.equal(timing.get("scheduledStartDelta").count, 3);
  assert.equal(timing.get("scheduledStopDelta").count, 3);
  assert.equal(timing.get("audioProgress").count, 1);
  api.ctx.state = "interrupted";
  api.diagnostics.recordAudioState(api.engine, "statechange");
  assert.equal(api.diagnostics.snapshot(api.engine).lastAudioState.state, "interrupted");
  assert.equal(api.diagnostics.snapshot(api.engine).lastAudioState.reason, "statechange");
  api.diagnostics.disable();
});

test("diagnostic signal snapshot is explicit, finite, and does not allocate a visual loop", async () => {
  const api = setup();
  await api.engine.init();
  api.diagnostics.enable(api.engine);
  const nodesBefore = api.ctx.created;
  const first = api.engine.captureDiagnosticSignal();
  const nodesAfterFirst = api.ctx.created;
  const second = api.engine.captureDiagnosticSignal();

  assert.equal(nodesAfterFirst - nodesBefore, 8, "one analyser tap per requested bus is created only for explicit capture");
  assert.equal(api.ctx.created, nodesAfterFirst, "repeated captures reuse the diagnostic taps");
  for (const signal of Object.values(first)) {
    assert.equal(signal.finite, true);
    assert.equal(signal.rms, 0);
    assert.equal(signal.peak, 0);
  }
  assert.deepEqual(second, first);
  assert.equal(api.callbacks.size, 0, "signal capture schedules no render callback");
  api.engine.disposeDiagnosticTaps();
  api.diagnostics.disable();
});

test("coalesced ranges apply once per frame, retain the last value, and flush on gesture completion", () => {
  const api = setup();
  const listeners = new Map();
  const input = {
    value: "0",
    addEventListener(type, listener) { listeners.set(type, listener); },
  };
  const applied = [];
  api.bindCoalescedRange(input, (value) => applied.push(Number(value)));
  ["10", "35", "72"].forEach((value) => {
    input.value = value;
    listeners.get("input")();
  });
  assert.deepEqual(applied, [], "input bursts must wait for the shared frame");
  assert.equal(api.callbacks.size, 1, "one shared RAF is scheduled for a burst");
  const [[id, frame]] = api.callbacks;
  api.callbacks.delete(id);
  frame(16);
  assert.deepEqual(applied, [72], "the frame applies only the last input value");

  input.value = "91";
  listeners.get("input")();
  listeners.get("pointerup")();
  assert.deepEqual(applied, [72, 91], "gesture completion flushes the final value immediately");
});

test("coalesced range ignores click or blur without a real change and flushes a pending final value", () => {
  const api = setup();
  const listeners = new Map();
  const input = {
    value: "40",
    addEventListener(type, listener) { listeners.set(type, listener); },
  };
  const applied = [];
  api.bindCoalescedRange(input, (value) => applied.push(Number(value)));

  listeners.get("pointerup")();
  listeners.get("blur")();
  listeners.get("change")();
  assert.deepEqual(applied, [], "a click without a changed value does not reapply automation");

  input.value = "67";
  listeners.get("input")();
  listeners.get("pointerup")();
  assert.deepEqual(applied, [67], "the final pending value is applied immediately on gesture completion");
  listeners.get("blur")();
  assert.deepEqual(applied, [67], "a later blur does not repeat the same update");
});

test("state rehydration preserves a pending coalesced gesture instead of discarding it", async () => {
  const listeners = new Map();
  const input = {
    min: "120", max: "14000", value: "2800", style: { setProperty() {} },
    addEventListener(type, listener) { listeners.set(type, listener); },
  };
  const control = {
    dataset: { junoControl: "cutoff" }, style: { setProperty() {} },
    querySelector(selector) { return selector === "input" ? input : { textContent: "" }; },
  };
  const api = setup({ junoControls: [control] });
  await api.engine.init();
  let updates = 0;
  const update = api.engine.updateJunoVoices.bind(api.engine);
  api.engine.updateJunoVoices = (...args) => { updates += 1; return update(...args); };
  api.bindJunoControls();

  input.value = "4300";
  listeners.get("input")();
  api.renderJunoControls();

  assert.equal(api.state.juno.cutoff, 4300, "the final user gesture wins over a simultaneous visual sync");
  assert.equal(input.value, "4300", "the range is rehydrated to the effective user value");
  assert.equal(updates, 1, "the pending gesture is applied once");
  listeners.get("pointerup")();
  assert.equal(updates, 1, "completion after rehydration does not reapply the same J-4 value");
});

test("DIRECTO-to-instrument tabs rehydrate J-4, bass, and ARP controls from state", async () => {
  const junoListeners = new Map();
  const arpListeners = new Map();
  const bassListeners = new Map();
  const junoInput = { min: "120", max: "14000", value: "200", style: { setProperty() {} }, addEventListener(type, listener) { junoListeners.set(type, listener); } };
  const arpInput = { min: "10", max: "100", value: "10", style: { setProperty() {} }, addEventListener(type, listener) { arpListeners.set(type, listener); } };
  const bassInput = { min: "80", max: "12000", value: "80", style: { setProperty() {} }, addEventListener(type, listener) { bassListeners.set(type, listener); } };
  const junoControl = {
    dataset: { junoControl: "cutoff" }, style: { setProperty() {} },
    querySelector(selector) { return selector === "input" ? junoInput : { textContent: "" }; },
  };
  const arpGate = {
    querySelector(selector) { return selector === "input" ? arpInput : { textContent: "" }; },
  };
  const bassControl = {
    dataset: { control: "cutoff" }, style: { setProperty() {} },
    querySelector(selector) { return selector === "input" ? bassInput : { textContent: "" }; },
  };
  const api = setup({ junoControls: [junoControl], junoArpGates: [arpGate], synthControls: [bassControl] });
  await api.engine.init();
  api.bindJunoControls();
  api.bindSynthControls();

  api.applyDirectControl("junoCutoff", 4300);
  api.applyDirectControl("junoArpGate", 53);
  api.applyDirectControl("bassCutoff", 1760);
  api.switchTab("juno");
  assert.equal(junoInput.value, "4300", "JUNO cutoff reflects the DIRECTO state on entry");
  assert.equal(arpInput.value, "53", "ARP gate reflects the DIRECTO state on entry");
  api.switchTab("synth");
  assert.equal(bassInput.value, "1760", "BAJO cutoff reflects the DIRECTO state on entry");

  junoInput.value = "4800";
  arpInput.value = "68";
  bassInput.value = "2100";
  junoListeners.get("input")();
  arpListeners.get("input")();
  bassListeners.get("input")();
  api.flushCoalescedControls();
  assert.equal(api.state.juno.cutoff, 4800, "the rehydrated J-4 range remains live");
  assert.equal(api.state.juno.arp.gate, 0.68, "the rehydrated ARP range remains live");
  assert.equal(api.state.synth.cutoff, 2100, "the rehydrated bass range remains live");
});

test("transport ranges are rehydrated from state rather than restored form values", () => {
  const api = setup();
  const swing = api.elements.get("swingControl");
  const master = api.elements.get("masterControl");
  const masterOutput = api.elements.get("masterOutputControl");
  api.state.swing = 37;
  api.state.master = 0.63;
  swing.value = "99";
  master.value = "5";
  masterOutput.value = "5";

  api.bindTransport();

  assert.equal(swing.value, "37");
  assert.equal(master.value, "63");
  assert.equal(masterOutput.value, "63");
  assert.equal(api.state.swing, 37, "form restoration never overwrites swing state");
  assert.equal(api.state.master, 0.63, "form restoration never overwrites master state");
});

test("an unchanged J-4 cutoff gesture does not rebase a live filter envelope", async () => {
  const listeners = new Map();
  const input = {
    value: "2800", style: { setProperty() {} },
    addEventListener(type, listener) { listeners.set(type, listener); },
  };
  const control = {
    dataset: { junoControl: "cutoff" },
    querySelector(selector) { return selector === "input" ? input : { textContent: "" }; },
  };
  const api = setup({ junoControls: [control] });
  await api.engine.init();
  api.engine.startJunoVoice(60, api.ctx.currentTime + 0.01, false, "manual");
  let rebases = 0;
  const originalRebase = api.engine.rebaseJunoFilterEnvelope.bind(api.engine);
  api.engine.rebaseJunoFilterEnvelope = (...args) => { rebases += 1; return originalRebase(...args); };
  api.bindJunoControls();

  listeners.get("pointerup")();
  listeners.get("blur")();
  assert.equal(rebases, 0, "an unchanged click/blur does not touch the active cutoff envelope");

  input.value = "3600";
  listeners.get("input")();
  listeners.get("pointerup")();
  assert.equal(rebases, 1, "a real final change flushes exactly once");
});

test("bass controls render from JavaScript state instead of restored form values", () => {
  const listeners = new Map();
  const style = { values: new Map(), setProperty(name, value) { this.values.set(name, value); } };
  const input = {
    min: "90", max: "6000", value: "5300", style,
    addEventListener(type, listener) { listeners.set(type, listener); },
  };
  const output = { textContent: "" };
  const dial = {
    dataset: { control: "cutoff" }, style,
    querySelector(selector) { return selector === "input" ? input : output; },
  };
  const api = setup({ synthControls: [dial] });
  api.state.synth.cutoff = 900;

  api.bindSynthControls();

  assert.equal(api.state.synth.cutoff, 900, "restored form state never overwrites synth state");
  assert.equal(input.value, "900", "the input is rehydrated from state");
  assert.equal(output.textContent, "900 Hz");
  assert.ok(style.values.has("--dial-angle"), "the dial is rendered from the same state value");
  assert.ok(listeners.has("input"));
});

test("DIRECTO slider drags do not trigger a full DIRECTO render or allocate audio nodes", async () => {
  const listeners = new Map();
  const input = {
    value: "0",
    style: { setProperty() {} },
    addEventListener(type, listener) { listeners.set(type, listener); },
  };
  const output = { textContent: "" };
  const control = {
    dataset: { directControl: "junoLfoFilter" },
    querySelector(selector) { return selector === "input" ? input : output; },
  };
  const api = setup({ directControls: [control] });
  await api.engine.init();
  api.diagnostics.enable(api.engine);
  const nodesBefore = api.ctx.created;
  api.bindDirectControls();
  const rendersBefore = new Map(api.diagnostics.snapshot(api.engine).ui).get("directRender").count;
  ["20", "55", "80"].forEach((value) => {
    input.value = value;
    listeners.get("input")();
  });
  const [[id, frame]] = api.callbacks;
  api.callbacks.delete(id);
  frame(16);
  const directRender = new Map(api.diagnostics.snapshot(api.engine).ui).get("directRender");
  assert.equal(api.state.juno.lfoFilter, 0.8);
  assert.equal(directRender.count, rendersBefore, "continuous DIRECTO updates must not rerender the whole surface");
  assert.equal(api.ctx.created, nodesBefore, "a DIRECTO slider does not allocate audio nodes");
  api.diagnostics.disable();
});

test("playhead uses one RAF queue instead of per-step timeouts and updates cached elements", () => {
  const api = setup();
  api.engine.ctx = api.ctx;
  api.state.playing = true;
  const timeoutsBefore = api.getTimeoutCount();
  api.queuePlayhead(3, 0);
  api.queuePlayhead(4, 0);
  assert.equal(api.getTimeoutCount(), timeoutsBefore, "queuing playhead steps creates no setTimeout");
  assert.equal(api.callbacks.size, 1, "queued steps share one RAF");
  const [[id, frame]] = api.callbacks;
  api.callbacks.delete(id);
  frame(16);
  assert.equal(api.getPlayheadTimerCount(), 0);
  assert.equal(api.state.currentStep, 4, "the latest due playhead step wins within the frame");
  assert.equal(api.queryCounts.get(".position-led") || 0, 0, "playhead rendering does not rescan position LEDs");
  assert.equal(api.queryCounts.get(".drum-step") || 0, 0, "playhead rendering does not rescan drum steps");
  assert.equal(api.queryCounts.get(".bass-step") || 0, 0, "playhead rendering does not rescan bass steps");
});

test("diagnostics measure audio clock drift from a reference plus frame gaps and tab switches", async () => {
  const api = setup({ clock: { now: 1000 } });
  await api.engine.init();
  api.ctx.currentTime = 2;
  api.diagnostics.enable(api.engine);
  api.clock.now = 1500;
  api.diagnostics.recordScheduler(2.5, 0, 0, 110, 1);
  api.clock.now = 1600;
  api.diagnostics.recordScheduler(2.55, 0, 0, 110, 1);
  api.switchTab("synth");
  api.state.playing = true;
  api.refreshVisualVisibility();
  api.scopeLoop(10);
  api.scopeLoop(95);
  const ui = new Map(api.diagnostics.snapshot(api.engine).ui);
  assert.ok(Math.abs(api.diagnostics.snapshot(api.engine).audioClock.max - 50) < 1e-9, "clock delta is drift from the reference, not page age");
  assert.equal(ui.get("animationFrameGap").max, 85);
  assert.ok(ui.get("tabSwitch").count >= 1);
  api.diagnostics.disable();
});

test("completed playhead timers are removed, and inactive visual tabs do no meter animation", () => {
  const api = setup(); api.engine.ctx = api.ctx;
  for (let index = 0; index < 500; index += 1) {
    api.queuePlayhead(index % 16, api.ctx.currentTime);
    for (const [id, callback] of [...api.callbacks]) { api.callbacks.delete(id); callback(); }
    assert.equal(api.getPlayheadTimerCount(), 0);
  }
  api.state.playing = true;
  api.switchTab("synth"); assert.equal(api.callbacks.size, 1);
  api.switchTab("synth"); assert.equal(api.callbacks.size, 1, "do not duplicate animation loops");
  api.switchTab("bass"); assert.equal(api.callbacks.size, 0);
  api.switchTab("mixer"); assert.equal(api.callbacks.size, 1);
  api.document.visibilityState = "hidden";
  for (const [id, callback] of [...api.callbacks]) { api.callbacks.delete(id); callback(1000); }
  assert.equal(api.callbacks.size, 0);
});

test("scope rendering requires a visible synth tab", async () => {
  const api = setup();
  await api.engine.init();
  api.diagnostics.enable(api.engine);
  api.state.playing = true;
  api.switchTab("synth");
  assert.equal(api.callbacks.size, 1, "the visible synth tab owns one visual RAF");
  api.switchTab("juno");
  assert.equal(api.callbacks.size, 0, "leaving synth cancels its visual RAF immediately");
  api.scopeLoop(100);
  const ui = new Map(api.diagnostics.snapshot(api.engine).ui);
  assert.equal(ui.get("scopeRender").count, 0, "an inactive synth tab does not draw scope frames");
  api.diagnostics.disable();
});

test("a successful visibility resume restarts only the eligible visual RAF", async () => {
  const api = setup();
  await api.engine.init();
  api.state.playing = true;
  api.switchTab("synth");
  assert.equal(api.callbacks.size, 1, "the visible scope starts with one RAF");

  api.document.visibilityState = "hidden";
  api.ctx.state = "suspended";
  await api.handleVisibilityChange();
  assert.equal(api.callbacks.size, 0, "hiding a suspended context stops the scope RAF");

  api.document.visibilityState = "visible";
  await api.handleVisibilityChange();
  assert.equal(api.ctx.state, "running");
  assert.equal(api.getVisualDiagnostics().scopeActive, true, "scope restarts after a successful resume");
  assert.equal(api.callbacks.size, 1, "resume creates one scope RAF, not duplicates");
  await api.handleVisibilityChange();
  assert.equal(api.callbacks.size, 1, "a repeated visible event keeps one RAF");

  api.document.visibilityState = "hidden";
  api.ctx.state = "suspended";
  await api.handleVisibilityChange();
  api.document.visibilityState = "visible";
  api.switchTab("mixer");
  await api.handleVisibilityChange();
  assert.equal(api.getVisualDiagnostics().meterActive, true, "the eligible mixer meter also restarts after resume");
  assert.equal(api.callbacks.size, 1, "the meter owns exactly one RAF after resume");
});

test("desktop visuals remain eligible for preview and clip decay after STOP", async () => {
  const api = setup({ clock: { now: 0 } });
  await api.engine.init();
  api.state.playing = false;
  api.switchTab("synth");
  assert.equal(api.getVisualMode(), "desktop");
  assert.equal(api.getVisualDiagnostics().scopeVisible, true, "a running desktop context may render a stopped-transport preview");
  assert.equal(api.callbacks.size, 1, "desktop preview owns one visual RAF");

  api.switchTab("mixer");
  api.engine.analyser.getFloatTimeDomainData = (data) => data.fill(1);
  api.renderReductionMeter();
  assert.equal(api.elements.get("masterClipLamp").classList.contains("is-clipping"), true, "a preview peak lights the clip lamp");
  api.clock.now = 1000;
  api.engine.analyser.getFloatTimeDomainData = (data) => data.fill(0);
  api.renderReductionMeter();
  assert.equal(api.elements.get("masterClipLamp").classList.contains("is-clipping"), false, "the clip lamp expires after STOP while visuals remain active");
});

test("coarse pointer PLAY profile disables scope and caps visible mixer meters at 10 fps", async () => {
  const api = setup({ coarsePointer: true });
  await api.engine.init();
  api.diagnostics.enable(api.engine);
  api.state.playing = true;
  api.switchTab("synth");
  assert.equal(api.getVisualMode(), "mobile-performance");
  assert.equal(api.callbacks.size, 0, "mobile PLAY never schedules scope rendering");
  api.switchTab("mixer");
  assert.equal(api.callbacks.size, 1, "the visible mixer keeps one capped meter loop");
  for (const timestamp of [0, 40, 80, 100, 140, 200]) {
    const [[id, callback]] = api.callbacks;
    api.callbacks.delete(id);
    callback(timestamp);
  }
  const snapshot = api.diagnostics.snapshot(api.engine);
  const ui = new Map(snapshot.ui);
  assert.equal(ui.get("scopeRender").count, 0, "mobile profile performs no scope or analyser read for scope");
  assert.equal(snapshot.totals.meterFrames, 3, "meter frames are limited to 10 fps");
  assert.ok(snapshot.totals.meterSkippedRate >= 3, "intermediate meter frames are counted as frequency-capped");
  api.stopTransport();
  assert.equal(api.getVisualMode(), "desktop", "stopping reverses the mobile performance profile");
  assert.equal(api.callbacks.size, 1, "after STOP, desktop-style meter decay remains observable on a running context");
  api.diagnostics.disable();
});

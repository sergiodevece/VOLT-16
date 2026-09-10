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
    const node = { kind, connections: [], gain: new Param(), frequency: new Param(350), Q: new Param(),
      delayTime: new Param(0), pan: new Param(0), threshold: new Param(), knee: new Param(),
      ratio: new Param(), attack: new Param(), release: new Param(),
      connect(target) { this.connections.push(target); },
      disconnect() { this.connections = []; ctx.nodes.delete(this); },
      start(t = 0) { this.startAt = t; ctx.sources.add(this); },
      stop(t = 0) { this.stopAt = t; },
      getByteTimeDomainData(data) { data.fill(128); },
    };
    ctx.nodes.add(node); ctx.created += 1;
    return node;
  };
  for (const [method, kind] of Object.entries({ createGain: "gain", createOscillator: "oscillator",
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
  const element = () => ({ textContent: "", checked: false, hidden: false,
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
  assert.equal(ctx.sources.size, permanentSources, "only the four shared FX LFOs may remain");
  assert.equal(engine.bassVoices.size, 0);
  assert.equal(engine.drumVoices.size, 0);
  console.log(`stress: ${ctx.created} nodes created; max ${maximum} transient nodes; ${ctx.nodes.size} permanent nodes after cleanup`);
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
    engine.rebuildReverb();
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

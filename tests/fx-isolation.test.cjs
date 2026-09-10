"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../dist/app.js"), "utf8");

class Param {
  constructor(value = 1) {
    this.value = value;
    this.events = [];
  }

  record(type, value, time = 0, timeConstant) {
    this.value = value;
    this.events.push({ type, value, time, timeConstant });
  }

  setValueAtTime(value, time) { this.record("set", value, time); }
  setTargetAtTime(value, time, timeConstant) { this.record("target", value, time, timeConstant); }
  linearRampToValueAtTime(value, time) { this.record("linear", value, time); }
  exponentialRampToValueAtTime(value, time) { this.record("exponential", value, time); }
  cancelScheduledValues(time) { this.events = this.events.filter((event) => event.time < time); }
}

function mockContext(sampleRate = 48000) {
  const ctx = {
    currentTime: 0,
    state: "running",
    sampleRate,
    destination: { kind: "destination" },
    nodes: [],
    buffers: [],
    startedSources: [],
  };

  const makeNode = (kind) => {
    const node = {
      kind,
      connections: [],
      gain: new Param(),
      frequency: new Param(350),
      Q: new Param(),
      delayTime: new Param(),
      pan: new Param(),
      threshold: new Param(),
      knee: new Param(),
      ratio: new Param(),
      attack: new Param(),
      release: new Param(),
      disconnected: false,
      connect(target) { this.connections.push(target); return target; },
      disconnect(target) {
        if (target) {
          this.connections = this.connections.filter((connection) => connection !== target);
          return;
        }
        this.connections = [];
        this.disconnected = true;
      },
      start(time = 0) { this.startAt = time; ctx.startedSources.push(this); },
      stop(time = 0) { this.stopAt = time; this.stopped = true; },
      getByteTimeDomainData(data) { data.fill(128); },
    };
    ctx.nodes.push(node);
    return node;
  };

  const factories = {
    createGain: "gain",
    createOscillator: "oscillator",
    createBufferSource: "bufferSource",
    createBiquadFilter: "filter",
    createWaveShaper: "shaper",
    createConvolver: "convolver",
    createDelay: "delay",
    createStereoPanner: "panner",
    createDynamicsCompressor: "compressor",
    createAnalyser: "analyser",
  };
  Object.entries(factories).forEach(([method, kind]) => {
    ctx[method] = () => makeNode(kind);
  });

  ctx.createBuffer = (channels, length, rate) => {
    const channelData = Array.from({ length: channels }, () => new Float32Array(length));
    const buffer = {
      channels,
      length,
      sampleRate: rate,
      getChannelData: (channel) => channelData[channel],
    };
    ctx.buffers.push(buffer);
    return buffer;
  };
  ctx.resume = async () => { ctx.state = "running"; };
  ctx.suspend = async () => { ctx.state = "suspended"; };
  return ctx;
}

function setup({ fxControls = [], delayModeButtons = [], reverbModeButtons = [] } = {}) {
  const ctx = mockContext();
  const callbacks = new Map();
  let nextCallbackId = 0;
  const element = () => ({
    textContent: "",
    checked: false,
    hidden: false,
    style: { setProperty() {} },
    classList: { toggle() {}, remove() {}, contains() { return false; } },
    setAttribute() {},
    addEventListener() {},
    lastChild: { textContent: "" },
    querySelector() { return element(); },
    getContext() { return new Proxy({}, { get: () => () => {} }); },
  });
  const reverbDisplay = element();
  const document = {
    visibilityState: "visible",
    querySelectorAll: (selector) => {
      if (selector === "[data-fx-control]") return fxControls;
      if (selector === "[data-delay-mode]") return delayModeButtons;
      if (selector === "[data-reverb-mode]") return reverbModeButtons;
      return [];
    },
    querySelector: () => element(),
    getElementById: (id) => id === "reverbDisplay" ? reverbDisplay : element(),
  };
  const window = {
    AudioContext: function AudioContext() { return ctx; },
    setTimeout(callback) { const id = ++nextCallbackId; callbacks.set(id, callback); return id; },
    clearTimeout(id) { callbacks.delete(id); },
    setInterval: () => 1,
    clearInterval() {},
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    addEventListener() {},
  };
  const context = vm.createContext({
    document,
    window,
    navigator: {},
    console,
    performance: { now: () => 0 },
  });
  vm.runInContext(source.replace(/\ninitialize\(\);\s*$/, "") + `
    globalThis.api = { state, engine, CHANNELS, FX_NAMES, bindEffects, renderFxChannel, stopTransport, handlePageHide };
  `, context);
  return {
    ...context.api,
    ctx,
    callbacks,
    runTimeouts() {
      [...callbacks].forEach(([id, callback]) => {
        callbacks.delete(id);
        callback();
      });
    },
    activeNodeCount() { return ctx.nodes.filter((node) => !node.disconnected).length; },
  };
}

function fxControl(name, initialValue, min = 0, max = 1000) {
  const listeners = {};
  const input = {
    value: String(initialValue),
    min: String(min),
    max: String(max),
    style: { setProperty() {} },
    addEventListener(type, listener) { listeners[type] = listener; },
  };
  const output = { textContent: "" };
  return {
    dataset: { fxControl: name },
    input,
    output,
    querySelector(selector) { return selector === "input" ? input : output; },
    inputValue(value) {
      input.value = String(value);
      listeners.input();
    },
  };
}

function modeButton(dataName, value) {
  const listeners = {};
  return {
    dataset: { [dataName]: value },
    active: false,
    classList: {
      toggle(name, active) { if (name === "is-active") this.owner.active = active; },
      owner: null,
    },
    setAttribute() {},
    addEventListener(type, listener) { listeners[type] = listener; },
    click() { listeners.click(); },
  };
}

function prepareModeButton(dataName, value) {
  const button = modeButton(dataName, value);
  button.classList.owner = button;
  return button;
}

test("reverb and modulation remain global while delay has no eager singleton", async () => {
  const { engine } = setup();
  await engine.init();

  assert.deepEqual(Object.keys(engine.effects), ["reverb", "phaser", "chorus", "flanger"]);
  assert.equal(engine.effects.delay, undefined);
  assert.equal(engine.channelDelays.size, 0);
  assert.equal(Object.keys(engine.effects.reverb.banks).length, 3);
  assert.equal(engine.effects.phaser.filters.length, 4);
  assert.equal(engine.effects.chorus.delay.kind, "delay");
  assert.equal(engine.effects.flanger.delay.kind, "delay");
});

test("only the four still-global effects create eager channel sends", async () => {
  const { engine, CHANNELS } = setup();
  await engine.init();
  const sends = new Set();
  const globalEffects = ["reverb", "phaser", "chorus", "flanger"];

  CHANNELS.forEach(({ id }) => {
    assert.deepEqual(Object.keys(engine.channels[id].fxSends), globalEffects);
    globalEffects.forEach((effect) => {
      const send = engine.channels[id].fxSends[effect];
      sends.add(send);
      assert.equal(send.connections.length, 1);
      assert.equal(send.connections[0], engine.effects[effect].input);
    });
  });

  assert.equal(sends.size, CHANNELS.length * globalEffects.length);
});

test("send, enablement, and parameter state are independent per channel", async () => {
  const { state, engine, CHANNELS } = setup();
  await engine.init();

  state.fx.enabled.snare.delay = true;
  state.fx.sends.snare.delay = 0.61;
  engine.updateEffectSend("snare", "delay");

  assert.equal(state.fx.enabled.bass.delay, false);
  assert.equal(state.fx.sends.bass.delay, 0.24);
  assert.equal(engine.channels.snare.fxSends.delay.gain.value, 0.61);
  assert.equal(engine.channels.bass.fxSends.delay, undefined);

  const parameterStates = CHANNELS.map(({ id }) => state.fx.channels[id]);
  assert.equal(new Set(parameterStates).size, CHANNELS.length, "every channel owns a distinct parameter object");
  parameterStates.slice(1).forEach((parameters) => assert.deepEqual(parameters, parameterStates[0]));
  state.fx.channels.snare.delayTime = 0.18;
  state.fx.channels.snare.reverbMode = "hall";
  assert.equal(state.fx.channels.bass.delayTime, 0.31);
  assert.equal(state.fx.channels.bass.reverbMode, "room");
});

test("snare and bass use independent delay processors and parameter automation", async () => {
  const { state, engine } = setup();
  await engine.init();
  Object.assign(state.fx.channels.snare, { delayTime: 0.18, delayFeedback: 0.27, delayTone: 8000, delayMode: "tape" });
  Object.assign(state.fx.channels.bass, { delayTime: 0.57, delayFeedback: 0.66, delayTone: 9000, delayMode: "digital" });
  state.fx.enabled.snare.delay = true;
  state.fx.enabled.bass.delay = true;
  engine.updateEffectSend("snare", "delay");
  engine.updateEffectSend("bass", "delay");

  const snare = engine.channelDelays.get("snare");
  const bass = engine.channelDelays.get("bass");
  assert.equal(engine.channelDelays.size, 2);
  assert.notEqual(snare.delay, bass.delay);
  assert.notEqual(snare.feedback, bass.feedback);
  assert.notEqual(snare.tone, bass.tone);
  assert.notEqual(snare.lfoDepth, bass.lfoDepth);
  assert.equal(snare.delay.delayTime.value, 0.18);
  assert.equal(snare.feedback.gain.value, 0.27);
  assert.equal(snare.tone.frequency.value, 6200, "tape mode keeps the existing tone cap");
  assert.equal(snare.lfoDepth.gain.value, 0.0018);
  assert.equal(bass.delay.delayTime.value, 0.57);
  assert.equal(bass.feedback.gain.value, 0.66);
  assert.equal(bass.tone.frequency.value, 9000);
  assert.equal(bass.lfoDepth.gain.value, 0);

  const snareSnapshot = {
    time: snare.delay.delayTime.value,
    feedback: snare.feedback.gain.value,
    tone: snare.tone.frequency.value,
    depth: snare.lfoDepth.gain.value,
    timeEvents: snare.delay.delayTime.events.length,
    feedbackEvents: snare.feedback.gain.events.length,
  };
  Object.assign(state.fx.channels.bass, { delayTime: 0.72, delayFeedback: 1, delayTone: 11000, delayMode: "tape" });
  engine.updateEffect("delay", "bass");

  assert.deepEqual({
    time: snare.delay.delayTime.value,
    feedback: snare.feedback.gain.value,
    tone: snare.tone.frequency.value,
    depth: snare.lfoDepth.gain.value,
    timeEvents: snare.delay.delayTime.events.length,
    feedbackEvents: snare.feedback.gain.events.length,
  }, snareSnapshot);
  assert.equal(bass.delay.delayTime.value, 0.72);
  assert.equal(bass.feedback.gain.value, 0.82, "feedback retains the existing safety limit");
  assert.equal(bass.tone.frequency.value, 6200);
  assert.equal(bass.lfoDepth.gain.value, 0.0018);
});

test("FX controls edit and reload the selected channel's parameter values", () => {
  const delayTime = fxControl("delayTime", 310, 55, 900);
  const tape = prepareModeButton("delayMode", "tape");
  const digital = prepareModeButton("delayMode", "digital");
  const room = prepareModeButton("reverbMode", "room");
  const hall = prepareModeButton("reverbMode", "hall");
  const { state, bindEffects, renderFxChannel } = setup({
    fxControls: [delayTime],
    delayModeButtons: [tape, digital],
    reverbModeButtons: [room, hall],
  });
  bindEffects();

  state.selectedFxChannel = "snare";
  state.fx.channels.snare.delayMode = "digital";
  state.fx.channels.snare.reverbMode = "hall";
  renderFxChannel();
  assert.equal(digital.active, true);
  assert.equal(tape.active, false);
  assert.equal(hall.active, true);
  assert.equal(room.active, false);
  delayTime.inputValue(180);
  assert.equal(state.fx.channels.snare.delayTime, 0.18);
  assert.equal(state.fx.channels.bass.delayTime, 0.31);

  state.selectedFxChannel = "bass";
  renderFxChannel();
  assert.equal(delayTime.input.value, "310");
  assert.equal(tape.active, true);
  assert.equal(room.active, true);
  digital.click();
  delayTime.inputValue(570);
  assert.equal(state.fx.channels.bass.delayMode, "digital");
  assert.equal(state.fx.channels.bass.delayTime, 0.57);

  state.selectedFxChannel = "snare";
  renderFxChannel();
  assert.equal(delayTime.input.value, "180");
  assert.equal(state.fx.channels.snare.delayTime, 0.18);
  assert.equal(state.fx.channels.snare.reverbMode, "hall");
});

test("delay instances are lazy and add seven active nodes per enabled channel", async () => {
  const { state, engine, ctx, CHANNELS } = setup();
  await engine.init();

  assert.equal(ctx.nodes.length, 129);
  assert.equal(ctx.buffers.length, 4, "one shared noise buffer plus three reverb impulses");
  assert.equal(ctx.buffers.filter((buffer) => buffer.channels === 2).length, 3);
  assert.equal(ctx.startedSources.length, 3, "only phaser, chorus, and flanger LFOs start eagerly");

  state.fx.enabled.snare.delay = true;
  state.fx.enabled.bass.delay = true;
  engine.updateEffectSend("snare", "delay");
  engine.updateEffectSend("bass", "delay");
  assert.equal(ctx.nodes.length, 143);
  assert.equal(engine.channelDelays.size, 2);

  CHANNELS.map(({ id }) => id).filter((id) => !["snare", "bass"].includes(id)).forEach((id) => {
    state.fx.enabled[id].delay = true;
    engine.updateEffectSend(id, "delay");
  });
  assert.equal(ctx.nodes.length, 171);
  assert.equal(engine.channelDelays.size, 6);
});

test("disabling delays preserves a bounded tail and then restores the idle graph", async () => {
  const api = setup();
  await api.engine.init();
  api.state.fx.enabled.snare.delay = true;
  api.state.fx.enabled.bass.delay = true;
  api.engine.updateEffectSend("snare", "delay");
  api.engine.updateEffectSend("bass", "delay");
  const units = [...api.engine.channelDelays.values()];

  api.state.fx.enabled.snare.delay = false;
  api.state.fx.enabled.bass.delay = false;
  api.engine.updateEffectSend("snare", "delay");
  api.engine.updateEffectSend("bass", "delay");
  assert.equal(api.engine.channelDelays.size, 2, "instances remain available while their tails finish");
  assert.equal(api.callbacks.size, 2);
  units.forEach((unit) => {
    assert.equal(unit.send.gain.value, 0);
    assert.equal(unit.feedback.gain.value, 0, "feedback is neutralized before cleanup");
  });
  api.state.fx.channels.snare.delayFeedback = 0.82;
  api.engine.updateEffect("delay", "snare");
  assert.equal(api.engine.channelDelays.get("snare").feedback.gain.value, 0, "editing a disabled tail cannot restore feedback");

  api.runTimeouts();
  assert.equal(api.engine.channelDelays.size, 0);
  assert.equal(api.callbacks.size, 0);
  assert.equal(api.activeNodeCount(), 129);
  units.forEach((unit) => {
    assert.equal(unit.lfo.stopped, true);
    assert.ok([unit.send, unit.delay, unit.tone, unit.feedback, unit.wet, unit.lfo, unit.lfoDepth]
      .every((node) => node.disconnected));
  });
});

test("reactivating during a delay tail reuses the instance and cancels cleanup", async () => {
  const api = setup();
  await api.engine.init();
  api.state.fx.enabled.snare.delay = true;
  api.engine.updateEffectSend("snare", "delay");
  const unit = api.engine.channelDelays.get("snare");
  const createdNodes = api.ctx.nodes.length;

  api.state.fx.enabled.snare.delay = false;
  api.engine.updateEffectSend("snare", "delay");
  assert.equal(api.callbacks.size, 1);
  api.state.fx.enabled.snare.delay = true;
  api.engine.updateEffectSend("snare", "delay");

  assert.equal(api.callbacks.size, 0);
  assert.equal(api.engine.channelDelays.get("snare"), unit);
  assert.equal(api.ctx.nodes.length, createdNodes);
  assert.equal(unit.lfo.stopped, undefined);
  assert.equal(unit.send.gain.value, api.state.fx.sends.snare.delay);
});

test("rapid channel delay edits keep automation bounded and isolated", async () => {
  const { state, engine, ctx } = setup();
  await engine.init();
  state.fx.enabled.snare.delay = true;
  state.fx.enabled.bass.delay = true;
  engine.updateEffectSend("snare", "delay");
  engine.updateEffectSend("bass", "delay");
  const snare = engine.channelDelays.get("snare");
  const bass = engine.channelDelays.get("bass");

  for (let index = 0; index < 4000; index += 1) {
    ctx.currentTime += 0.003;
    state.fx.channels.bass.delayTime = 0.055 + (index % 100) / 120;
    state.fx.channels.bass.delayFeedback = (index % 83) / 100;
    engine.updateEffect("delay", "bass");
    assert.ok(bass.delay.delayTime.events.length <= 2);
    assert.ok(bass.feedback.gain.events.length <= 2);
  }
  assert.equal(snare.delay.delayTime.events.length, 2);
  assert.equal(snare.feedback.gain.events.length, 2);
});

test("STOP and pagehide synchronously dispose delay instances, timers, LFOs, and routes", async () => {
  const api = setup();
  await api.engine.init();
  const enableTwoDelays = () => {
    api.state.fx.enabled.snare.delay = true;
    api.state.fx.enabled.bass.delay = true;
    api.engine.updateEffectSend("snare", "delay");
    api.engine.updateEffectSend("bass", "delay");
    return [...api.engine.channelDelays.values()];
  };

  let units = enableTwoDelays();
  api.state.fx.enabled.snare.delay = false;
  api.engine.updateEffectSend("snare", "delay");
  assert.equal(api.callbacks.size, 1);
  api.stopTransport();
  assert.equal(api.engine.channelDelays.size, 0);
  assert.equal(api.callbacks.size, 0);
  assert.ok(units.every((unit) => unit.lfo.stopped && unit.lfo.disconnected));
  assert.ok(units.every((unit) => !api.engine.channels[unit.channelId].panner.connections.includes(unit.send)));
  assert.ok(units.every((unit) => api.engine.channels[unit.channelId].fxSends.delay === undefined));

  units = enableTwoDelays();
  api.handlePageHide();
  assert.equal(api.engine.channelDelays.size, 0);
  assert.equal(api.callbacks.size, 0);
  assert.equal(api.activeNodeCount(), 129);
  assert.ok(units.every((unit) => unit.lfo.stopped && unit.lfo.disconnected));
  assert.ok(units.every((unit) => !api.engine.channels[unit.channelId].panner.connections.includes(unit.send)));
});

test("repeated delay activation cycles return to the permanent-node baseline", async () => {
  const api = setup();
  await api.engine.init();
  for (let index = 0; index < 1200; index += 1) {
    const channelId = index % 2 === 0 ? "snare" : "bass";
    api.state.fx.enabled[channelId].delay = true;
    api.engine.updateEffectSend(channelId, "delay");
    api.state.fx.enabled[channelId].delay = false;
    api.engine.updateEffectSend(channelId, "delay");
    api.runTimeouts();
  }
  assert.equal(api.engine.channelDelays.size, 0);
  assert.equal(api.callbacks.size, 0);
  assert.equal(api.activeNodeCount(), 129);
});

test("reverb preset switches reuse the three prepared convolution banks", async () => {
  const { state, engine, ctx } = setup();
  await engine.init();
  const fx = state.fx.channels[state.selectedFxChannel];
  const initialNodes = ctx.nodes.length;
  const initialBuffers = ctx.buffers.length;
  const convolvers = Object.values(engine.effects.reverb.banks).map((bank) => bank.convolver);

  for (let index = 0; index < 1200; index += 1) {
    fx.reverbMode = ["room", "plate", "hall"][index % 3];
    engine.rebuildReverb();
  }

  assert.equal(ctx.nodes.length, initialNodes);
  assert.equal(ctx.buffers.length, initialBuffers);
  assert.deepEqual(Object.values(engine.effects.reverb.banks).map((bank) => bank.convolver), convolvers);
});

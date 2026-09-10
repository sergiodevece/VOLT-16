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

test("only reverb remains global while delay and modulation effects are lazy", async () => {
  const { engine } = setup();
  await engine.init();

  assert.deepEqual(Object.keys(engine.effects), ["reverb"]);
  assert.equal(engine.effects.delay, undefined);
  assert.equal(engine.effects.chorus, undefined);
  assert.equal(engine.effects.phaser, undefined);
  assert.equal(engine.effects.flanger, undefined);
  assert.equal(engine.channelDelays.size, 0);
  assert.equal(engine.channelChoruses.size, 0);
  assert.equal(engine.channelPhasers.size, 0);
  assert.equal(engine.channelFlangers.size, 0);
  assert.equal(engine.channelReverbs.size, 0);
  assert.equal(Object.keys(engine.effects.reverb.banks).length, 3);
  assert.equal(Object.values(engine.effects.reverb.banks).filter((bank) => bank.convolver.kind === "convolver").length, 3);
});

test("no per-channel FX send is created eagerly", async () => {
  const { engine, CHANNELS } = setup();
  await engine.init();

  CHANNELS.forEach(({ id }) => {
    assert.deepEqual(Object.keys(engine.channels[id].fxSends), []);
  });
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
  const reverbDamping = fxControl("reverbDamping", 6500, 1000, 14000);
  const tape = prepareModeButton("delayMode", "tape");
  const digital = prepareModeButton("delayMode", "digital");
  const room = prepareModeButton("reverbMode", "room");
  const hall = prepareModeButton("reverbMode", "hall");
  const { state, bindEffects, renderFxChannel } = setup({
    fxControls: [delayTime, reverbDamping],
    delayModeButtons: [tape, digital],
    reverbModeButtons: [room, hall],
  });
  bindEffects();

  state.selectedFxChannel = "snare";
  state.fx.channels.snare.delayMode = "digital";
  state.fx.channels.snare.reverbMode = "hall";
  state.fx.channels.snare.reverbDamping = 3200;
  renderFxChannel();
  assert.equal(digital.active, true);
  assert.equal(tape.active, false);
  assert.equal(hall.active, true);
  assert.equal(room.active, false);
  assert.equal(reverbDamping.input.value, "3200");
  delayTime.inputValue(180);
  reverbDamping.inputValue(4100);
  assert.equal(state.fx.channels.snare.delayTime, 0.18);
  assert.equal(state.fx.channels.snare.reverbDamping, 4100);
  assert.equal(state.fx.channels.bass.delayTime, 0.31);
  assert.equal(state.fx.channels.bass.reverbDamping, 6500);

  state.selectedFxChannel = "bass";
  renderFxChannel();
  assert.equal(delayTime.input.value, "310");
  assert.equal(reverbDamping.input.value, "6500");
  assert.equal(tape.active, true);
  assert.equal(room.active, true);
  digital.click();
  delayTime.inputValue(570);
  assert.equal(state.fx.channels.bass.delayMode, "digital");
  assert.equal(state.fx.channels.bass.delayTime, 0.57);

  state.selectedFxChannel = "snare";
  renderFxChannel();
  assert.equal(delayTime.input.value, "180");
  assert.equal(reverbDamping.input.value, "4100");
  assert.equal(state.fx.channels.snare.delayTime, 0.18);
  assert.equal(state.fx.channels.snare.reverbMode, "hall");
});

test("delay instances are lazy and add seven active nodes per enabled channel", async () => {
  const { state, engine, ctx, CHANNELS } = setup();
  await engine.init();

  assert.equal(ctx.nodes.length, 75);
  assert.equal(ctx.buffers.length, 4, "one shared noise buffer plus three reverb impulses");
  assert.equal(ctx.buffers.filter((buffer) => buffer.channels === 2).length, 3);
  assert.equal(ctx.startedSources.length, 0, "no modulation LFO starts eagerly");

  state.fx.enabled.snare.delay = true;
  state.fx.enabled.bass.delay = true;
  engine.updateEffectSend("snare", "delay");
  engine.updateEffectSend("bass", "delay");
  assert.equal(ctx.nodes.length, 89);
  assert.equal(engine.channelDelays.size, 2);

  CHANNELS.map(({ id }) => id).filter((id) => !["snare", "bass"].includes(id)).forEach((id) => {
    state.fx.enabled[id].delay = true;
    engine.updateEffectSend(id, "delay");
  });
  assert.equal(ctx.nodes.length, 117);
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
  assert.equal(api.activeNodeCount(), 75);
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
  assert.equal(api.activeNodeCount(), 75);
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
  assert.equal(api.activeNodeCount(), 75);
});

test("chorus instances are independent, lazy, and keep automation bounded", async () => {
  const { state, engine, ctx } = setup();
  await engine.init();
  Object.assign(state.fx.channels.snare, { chorusRate: 0.35, chorusDepth: 0.22 });
  Object.assign(state.fx.channels.bass, { chorusRate: 1.45, chorusDepth: 0.78 });
  state.fx.enabled.snare.chorus = true;
  state.fx.enabled.bass.chorus = true;
  engine.updateEffectSend("snare", "chorus");
  engine.updateEffectSend("bass", "chorus");

  const snare = engine.channelChoruses.get("snare");
  const bass = engine.channelChoruses.get("bass");
  assert.equal(engine.channelChoruses.size, 2);
  assert.notEqual(snare.delay, bass.delay);
  assert.notEqual(snare.lfo, bass.lfo);
  assert.notEqual(snare.depth, bass.depth);
  assert.equal(snare.lfo.frequency.value, 0.35);
  assert.equal(bass.lfo.frequency.value, 1.45);
  const snareRateEvents = snare.lfo.frequency.events.length;
  const snareDepthEvents = snare.depth.gain.events.length;

  for (let index = 0; index < 4000; index += 1) {
    ctx.currentTime += 0.003;
    state.fx.channels.bass.chorusRate = 0.1 + (index % 190) / 100;
    state.fx.channels.bass.chorusDepth = (index % 101) / 100;
    engine.updateEffect("chorus", "bass");
    assert.ok(bass.lfo.frequency.events.length <= 2);
    assert.ok(bass.depth.gain.events.length <= 2);
  }
  assert.equal(snare.lfo.frequency.events.length, snareRateEvents);
  assert.equal(snare.depth.gain.events.length, snareDepthEvents);
});

test("chorus cleanup is quick, reusable during its tail, and returns to baseline", async () => {
  const api = setup();
  await api.engine.init();
  api.state.fx.enabled.snare.chorus = true;
  api.engine.updateEffectSend("snare", "chorus");
  const unit = api.engine.channelChoruses.get("snare");
  const createdNodes = api.ctx.nodes.length;
  assert.equal(createdNodes, 80);

  api.state.fx.enabled.snare.chorus = false;
  api.engine.updateEffectSend("snare", "chorus");
  assert.equal(api.callbacks.size, 1);
  api.state.fx.enabled.snare.chorus = true;
  api.engine.updateEffectSend("snare", "chorus");
  assert.equal(api.callbacks.size, 0);
  assert.equal(api.engine.channelChoruses.get("snare"), unit);
  assert.equal(api.ctx.nodes.length, createdNodes);

  api.state.fx.enabled.snare.chorus = false;
  api.engine.updateEffectSend("snare", "chorus");
  api.runTimeouts();
  assert.equal(api.engine.channelChoruses.size, 0);
  assert.equal(api.callbacks.size, 0);
  assert.equal(api.activeNodeCount(), 75);
  assert.equal(unit.lfo.stopped, true);
  assert.ok([unit.send, unit.delay, unit.wet, unit.lfo, unit.depth].every((node) => node.disconnected));
  assert.ok(!api.engine.channels.snare.panner.connections.includes(unit.send));
});

test("phaser instances isolate filters, LFO modulation, and parameter automation", async () => {
  const { state, engine, ctx } = setup();
  await engine.init();
  Object.assign(state.fx.channels.snare, { phaserRate: 0.24, phaserDepth: 0.31 });
  Object.assign(state.fx.channels.bass, { phaserRate: 1.62, phaserDepth: 0.84 });
  state.fx.enabled.snare.phaser = true;
  state.fx.enabled.bass.phaser = true;
  engine.updateEffectSend("snare", "phaser");
  engine.updateEffectSend("bass", "phaser");

  const snare = engine.channelPhasers.get("snare");
  const bass = engine.channelPhasers.get("bass");
  assert.equal(engine.channelPhasers.size, 2);
  assert.notEqual(snare.lfo, bass.lfo);
  snare.filters.forEach((filter, index) => assert.notEqual(filter, bass.filters[index]));
  snare.depths.forEach((depth, index) => assert.notEqual(depth, bass.depths[index]));
  assert.equal(snare.lfo.frequency.value, 0.24);
  assert.equal(snare.depths[0].gain.value, 260 * 0.31);
  const snareEvents = [snare.lfo.frequency, ...snare.depths.map((depth) => depth.gain)].map((param) => param.events.length);

  for (let index = 0; index < 4000; index += 1) {
    ctx.currentTime += 0.003;
    state.fx.channels.bass.phaserRate = 0.1 + (index % 190) / 100;
    state.fx.channels.bass.phaserDepth = (index % 101) / 100;
    engine.updateEffect("phaser", "bass");
    assert.ok(bass.lfo.frequency.events.length <= 2);
    bass.depths.forEach((depth) => assert.ok(depth.gain.events.length <= 2));
  }
  assert.deepEqual([snare.lfo.frequency, ...snare.depths.map((depth) => depth.gain)].map((param) => param.events.length), snareEvents);
});

test("phaser cleanup disconnects every modulation route and can reuse a pending instance", async () => {
  const api = setup();
  await api.engine.init();
  api.state.fx.enabled.snare.phaser = true;
  api.state.fx.enabled.bass.phaser = true;
  api.engine.updateEffectSend("snare", "phaser");
  api.engine.updateEffectSend("bass", "phaser");
  const snare = api.engine.channelPhasers.get("snare");
  const bass = api.engine.channelPhasers.get("bass");
  assert.equal(api.ctx.nodes.length, 97);

  api.state.fx.enabled.snare.phaser = false;
  api.engine.updateEffectSend("snare", "phaser");
  api.state.fx.enabled.snare.phaser = true;
  api.engine.updateEffectSend("snare", "phaser");
  assert.equal(api.engine.channelPhasers.get("snare"), snare);
  assert.equal(api.callbacks.size, 0);
  assert.equal(api.ctx.nodes.length, 97);

  api.state.fx.enabled.snare.phaser = false;
  api.state.fx.enabled.bass.phaser = false;
  api.engine.updateEffectSend("snare", "phaser");
  api.engine.updateEffectSend("bass", "phaser");
  api.runTimeouts();
  assert.equal(api.engine.channelPhasers.size, 0);
  assert.equal(api.callbacks.size, 0);
  assert.equal(api.activeNodeCount(), 75);
  [snare, bass].forEach((unit) => {
    assert.equal(unit.lfo.stopped, true);
    assert.ok([unit.send, ...unit.filters, unit.wet, unit.lfo, ...unit.depths].every((node) => node.disconnected));
    assert.ok(!api.engine.channels[unit.channelId].panner.connections.includes(unit.send));
  });
});

test("flanger instances isolate delay, feedback, LFO, and parameter automation", async () => {
  const { state, engine, ctx } = setup();
  await engine.init();
  Object.assign(state.fx.channels.snare, { flangerRate: 0.12, flangerFeedback: 0.2 });
  Object.assign(state.fx.channels.bass, { flangerRate: 1.3, flangerFeedback: 0.7 });
  state.fx.enabled.snare.flanger = true;
  state.fx.enabled.bass.flanger = true;
  engine.updateEffectSend("snare", "flanger");
  engine.updateEffectSend("bass", "flanger");

  const snare = engine.channelFlangers.get("snare");
  const bass = engine.channelFlangers.get("bass");
  assert.equal(engine.channelFlangers.size, 2);
  assert.notEqual(snare.delay, bass.delay);
  assert.notEqual(snare.feedback, bass.feedback);
  assert.notEqual(snare.lfo, bass.lfo);
  assert.notEqual(snare.depth, bass.depth);
  assert.equal(snare.lfo.frequency.value, 0.12);
  assert.ok(Math.abs(snare.feedback.gain.value - 0.15) < 1e-12);
  const snareEvents = [snare.lfo.frequency.events.length, snare.feedback.gain.events.length, snare.depth.gain.events.length];

  for (let index = 0; index < 4000; index += 1) {
    ctx.currentTime += 0.003;
    state.fx.channels.bass.flangerRate = 0.05 + (index % 195) / 100;
    state.fx.channels.bass.flangerFeedback = (index % 101) / 100;
    engine.updateEffect("flanger", "bass");
    assert.ok(bass.lfo.frequency.events.length <= 2);
    assert.ok(bass.feedback.gain.events.length <= 2);
    assert.ok(bass.depth.gain.events.length <= 2);
  }
  assert.deepEqual([snare.lfo.frequency.events.length, snare.feedback.gain.events.length, snare.depth.gain.events.length], snareEvents);
  state.fx.channels.bass.flangerFeedback = 1;
  engine.updateEffect("flanger", "bass");
  assert.equal(bass.feedback.gain.value, 0.75 * 0.75, "flanger feedback retains the existing safety limit and scaling");
});

test("flanger tail neutralizes feedback, reuses pending nodes, and cleans every route", async () => {
  const api = setup();
  await api.engine.init();
  api.state.fx.enabled.snare.flanger = true;
  api.state.fx.enabled.bass.flanger = true;
  api.engine.updateEffectSend("snare", "flanger");
  api.engine.updateEffectSend("bass", "flanger");
  const snare = api.engine.channelFlangers.get("snare");
  const bass = api.engine.channelFlangers.get("bass");
  assert.equal(api.ctx.nodes.length, 87);

  api.state.fx.enabled.snare.flanger = false;
  api.state.fx.enabled.bass.flanger = false;
  api.engine.updateEffectSend("snare", "flanger");
  api.engine.updateEffectSend("bass", "flanger");
  assert.equal(snare.feedback.gain.value, 0);
  assert.equal(bass.feedback.gain.value, 0);
  assert.equal(api.callbacks.size, 2);

  api.state.fx.enabled.snare.flanger = true;
  api.engine.updateEffectSend("snare", "flanger");
  assert.equal(api.engine.channelFlangers.get("snare"), snare);
  assert.equal(api.callbacks.size, 1);
  assert.equal(api.ctx.nodes.length, 87);
  api.state.fx.enabled.snare.flanger = false;
  api.engine.updateEffectSend("snare", "flanger");
  api.state.fx.channels.snare.flangerFeedback = 0.75;
  api.engine.updateEffect("flanger", "snare");
  assert.equal(snare.feedback.gain.value, 0, "editing a disabled tail cannot restore feedback");

  api.runTimeouts();
  assert.equal(api.engine.channelFlangers.size, 0);
  assert.equal(api.callbacks.size, 0);
  assert.equal(api.activeNodeCount(), 75);
  [snare, bass].forEach((unit) => {
    assert.equal(unit.lfo.stopped, true);
    assert.ok([unit.send, unit.delay, unit.feedback, unit.wet, unit.lfo, unit.depth].every((node) => node.disconnected));
    assert.ok(!api.engine.channels[unit.channelId].panner.connections.includes(unit.send));
  });
});

test("STOP and pagehide dispose every lazy FX family without orphaned routes or LFOs", async () => {
  const api = setup();
  await api.engine.init();
  const enableAllForSnare = () => {
    ["delay", "chorus", "phaser", "flanger", "reverb"].forEach((effect) => {
      api.state.fx.enabled.snare[effect] = true;
      api.engine.updateEffectSend("snare", effect);
    });
    return [
      api.engine.channelDelays.get("snare"),
      api.engine.channelChoruses.get("snare"),
      api.engine.channelPhasers.get("snare"),
      api.engine.channelFlangers.get("snare"),
      api.engine.channelReverbs.get("snare"),
    ];
  };
  const assertDisposed = (units) => {
    assert.equal(api.engine.channelDelays.size, 0);
    assert.equal(api.engine.channelChoruses.size, 0);
    assert.equal(api.engine.channelPhasers.size, 0);
    assert.equal(api.engine.channelFlangers.size, 0);
    assert.equal(api.engine.channelReverbs.size, 0);
    assert.equal(api.callbacks.size, 0);
    assert.equal(api.activeNodeCount(), 75);
    assert.ok(units.filter((unit) => unit.lfo).every((unit) => unit.lfo.stopped && unit.lfo.disconnected));
    assert.ok(units.every((unit) => unit.send.disconnected));
    const reverb = units.at(-1);
    assert.ok([reverb.damping, ...Object.values(reverb.presetGains)].every((node) => node.disconnected));
    assert.ok(units.every((unit) => !api.engine.channels.snare.panner.connections.includes(unit.send)));
  };

  let units = enableAllForSnare();
  assert.equal(api.activeNodeCount(), 109);
  api.stopTransport();
  assertDisposed(units);

  units = enableAllForSnare();
  api.handlePageHide();
  assertDisposed(units);
});

test("reverb keeps exactly three shared impulses and convolvers for the whole session", async () => {
  const { state, engine, ctx, CHANNELS } = setup();
  await engine.init();
  const impulses = ctx.buffers.filter((buffer) => buffer.channels === 2);
  const convolvers = ctx.nodes.filter((node) => node.kind === "convolver");

  assert.equal(impulses.length, 3);
  assert.equal(convolvers.length, 3);
  assert.deepEqual(Object.values(engine.effects.reverb.banks).map((bank) => bank.convolver), convolvers);

  CHANNELS.forEach(({ id }, index) => {
    state.fx.channels[id].reverbMode = ["room", "plate", "hall"][index % 3];
    state.fx.enabled[id].reverb = true;
    engine.updateEffectSend(id, "reverb");
  });

  assert.equal(engine.channelReverbs.size, CHANNELS.length);
  assert.equal(ctx.nodes.filter((node) => node.kind === "convolver").length, 3);
  assert.equal(ctx.buffers.filter((buffer) => buffer.channels === 2).length, 3);
  assert.equal(ctx.nodes.length, 105, "six routes add five nodes each to the 75-node baseline");
});

test("two channels own isolated reverb damping and preset routes", async () => {
  const { state, engine, ctx } = setup();
  await engine.init();
  Object.assign(state.fx.channels.snare, { reverbMode: "room", reverbDamping: 2800 });
  Object.assign(state.fx.channels.bass, { reverbMode: "hall", reverbDamping: 11000 });
  state.fx.enabled.snare.reverb = true;
  state.fx.enabled.bass.reverb = true;
  engine.updateEffectSend("snare", "reverb");
  engine.updateEffectSend("bass", "reverb");

  const snare = engine.channelReverbs.get("snare");
  const bass = engine.channelReverbs.get("bass");
  assert.equal(engine.channelReverbs.size, 2);
  assert.equal(ctx.nodes.length, 85);
  assert.notEqual(snare.damping, bass.damping);
  assert.notEqual(snare.presetGains.room, bass.presetGains.room);
  assert.equal(snare.damping.frequency.value, 2800);
  assert.equal(bass.damping.frequency.value, 11000);
  assert.equal(snare.presetGains.room.gain.value, 1);
  assert.equal(snare.presetGains.hall.gain.value, 0);
  assert.equal(bass.presetGains.room.gain.value, 0);
  assert.equal(bass.presetGains.hall.gain.value, 1);
  assert.ok(snare.presetGains.room.connections.includes(engine.effects.reverb.banks.room.convolver));
  assert.ok(bass.presetGains.hall.connections.includes(engine.effects.reverb.banks.hall.convolver));

  const snareSnapshot = {
    damping: snare.damping.frequency.value,
    dampingEvents: snare.damping.frequency.events.length,
    gains: Object.values(snare.presetGains).map((gain) => gain.gain.value),
    gainEvents: Object.values(snare.presetGains).map((gain) => gain.gain.events.length),
  };
  Object.assign(state.fx.channels.bass, { reverbMode: "plate", reverbDamping: 6400 });
  engine.updateEffect("reverb", "bass");

  assert.deepEqual({
    damping: snare.damping.frequency.value,
    dampingEvents: snare.damping.frequency.events.length,
    gains: Object.values(snare.presetGains).map((gain) => gain.gain.value),
    gainEvents: Object.values(snare.presetGains).map((gain) => gain.gain.events.length),
  }, snareSnapshot);
  assert.equal(bass.damping.frequency.value, 6400);
  assert.equal(bass.presetGains.room.gain.value, 0);
  assert.equal(bass.presetGains.plate.gain.value, 1);
  assert.equal(bass.presetGains.hall.gain.value, 0);
});

test("reverb crossfades stay bounded and repeated preset changes allocate nothing", async () => {
  const { state, engine, ctx } = setup();
  await engine.init();
  const channelId = "snare";
  state.fx.enabled[channelId].reverb = true;
  engine.updateEffectSend(channelId, "reverb");
  const route = engine.channelReverbs.get(channelId);
  const initialNodes = ctx.nodes.length;
  const initialBuffers = ctx.buffers.length;
  const convolvers = Object.values(engine.effects.reverb.banks).map((bank) => bank.convolver);

  for (let index = 0; index < 4000; index += 1) {
    ctx.currentTime += 0.003;
    state.fx.channels[channelId].reverbMode = ["room", "plate", "hall"][index % 3];
    state.fx.channels[channelId].reverbDamping = 1500 + (index % 100) * 120;
    engine.rebuildReverb(channelId);
    assert.ok(route.damping.frequency.events.length <= 2);
    Object.values(route.presetGains).forEach((gain) => assert.ok(gain.gain.events.length <= 2));
  }

  assert.equal(ctx.nodes.length, initialNodes);
  assert.equal(ctx.buffers.length, initialBuffers);
  assert.deepEqual(Object.values(engine.effects.reverb.banks).map((bank) => bank.convolver), convolvers);
  Object.entries(route.presetGains).forEach(([mode, gain]) => {
    assert.equal(gain.gain.value, mode === state.fx.channels[channelId].reverbMode ? 1 : 0);
  });
});

test("reverb cleanup preserves shared tails, isolates other channels, and reuses a pending route", async () => {
  const api = setup();
  await api.engine.init();
  api.state.fx.enabled.snare.reverb = true;
  api.state.fx.enabled.bass.reverb = true;
  api.engine.updateEffectSend("snare", "reverb");
  api.engine.updateEffectSend("bass", "reverb");
  const snare = api.engine.channelReverbs.get("snare");
  const bass = api.engine.channelReverbs.get("bass");
  const createdNodes = api.ctx.nodes.length;
  const bassSnapshot = Object.values(bass.presetGains).map((gain) => gain.gain.value);

  api.state.fx.enabled.snare.reverb = false;
  api.engine.updateEffectSend("snare", "reverb");
  assert.equal(api.callbacks.size, 1);
  assert.equal(api.engine.channelReverbs.get("snare"), snare);
  assert.equal(snare.send.gain.value, 0);
  assert.deepEqual(Object.values(snare.presetGains).map((gain) => gain.gain.value), [0, 0, 0]);
  assert.deepEqual(Object.values(bass.presetGains).map((gain) => gain.gain.value), bassSnapshot);

  api.state.fx.enabled.snare.reverb = true;
  api.engine.updateEffectSend("snare", "reverb");
  assert.equal(api.callbacks.size, 0);
  assert.equal(api.engine.channelReverbs.get("snare"), snare);
  assert.equal(api.ctx.nodes.length, createdNodes);

  api.state.fx.enabled.snare.reverb = false;
  api.engine.updateEffectSend("snare", "reverb");
  api.runTimeouts();
  assert.equal(api.engine.channelReverbs.size, 1);
  assert.equal(api.engine.channelReverbs.get("bass"), bass);
  assert.equal(api.activeNodeCount(), 80);
  assert.ok([snare.send, snare.damping, ...Object.values(snare.presetGains)].every((node) => node.disconnected));
  assert.ok(Object.values(api.engine.effects.reverb.banks).every((bank) => !bank.convolver.disconnected));
  assert.equal(api.ctx.nodes.filter((node) => node.kind === "convolver").length, 3);

  api.state.fx.enabled.bass.reverb = false;
  api.engine.updateEffectSend("bass", "reverb");
  api.runTimeouts();
  assert.equal(api.engine.channelReverbs.size, 0);
  assert.equal(api.callbacks.size, 0);
  assert.equal(api.activeNodeCount(), 75);
});

test("repeated reverb activation cycles return to the permanent-node baseline", async () => {
  const api = setup();
  await api.engine.init();
  for (let index = 0; index < 1200; index += 1) {
    const channelId = index % 2 ? "snare" : "bass";
    api.state.fx.enabled[channelId].reverb = true;
    api.engine.updateEffectSend(channelId, "reverb");
    api.state.fx.enabled[channelId].reverb = false;
    api.engine.updateEffectSend(channelId, "reverb");
    api.runTimeouts();
  }
  assert.equal(api.engine.channelReverbs.size, 0);
  assert.equal(api.callbacks.size, 0);
  assert.equal(api.activeNodeCount(), 75);
  assert.equal(api.ctx.nodes.filter((node) => node.kind === "convolver").length, 3);
  assert.equal(api.ctx.buffers.filter((buffer) => buffer.channels === 2).length, 3);
});

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

// Record Web Audio automation and evaluate its scheduled gain numerically.
// This checks scheduling/continuity, not browser rendering or subjective sound.
// Interpolation: https://www.w3.org/TR/webaudio/#AudioParam
class Param {
  constructor(value = 1) {
    this.value = value;
    this.events = [];
  }
  add(type, value, time) {
    assert.ok(Number.isFinite(value) && Number.isFinite(time));
    if (type === "exponential") assert.ok(value > 0);
    this.events.push({ type, value, time });
  }
  setValueAtTime(value, time) { this.add("set", value, time); }
  linearRampToValueAtTime(value, time) { this.add("linear", value, time); }
  exponentialRampToValueAtTime(value, time) { this.add("exponential", value, time); }
  cancelScheduledValues(time) { this.events = this.events.filter((event) => event.time < time); }
  valueAt(time) {
    let previous = { time: 0, value: this.value };
    for (const event of [...this.events].sort((a, b) => a.time - b.time)) {
      if (time < event.time) {
        if (event.type === "set") return previous.value;
        const fraction = Math.max(0, (time - previous.time) / (event.time - previous.time));
        return event.type === "linear"
          ? previous.value + (event.value - previous.value) * fraction
          : previous.value * Math.pow(event.value / previous.value, fraction);
      }
      previous = event;
    }
    return previous.value;
  }
}

function audioContext() {
  const nodes = [];
  function node(kind) {
    const result = {
      kind, connections: [], disconnected: false,
      gain: new Param(), frequency: new Param(440), Q: new Param(),
      connect(target) { this.connections.push(target); },
      disconnect() { this.disconnected = true; this.connections = []; },
      start(time) { this.startAt = time; },
      stop(time) { this.stopAt = time; },
    };
    nodes.push(result);
    return result;
  }
  return {
    currentTime: 0, sampleRate: 48000, nodes,
    createOscillator: () => node("oscillator"),
    createGain: () => node("gain"),
    createBiquadFilter: () => node("filter"),
    createWaveShaper: () => node("shaper"),
    finishUntil(time) {
      this.currentTime = time;
      for (const sourceNode of nodes.filter((entry) => entry.kind === "oscillator")) {
        if (sourceNode.stopAt <= time && !sourceNode.ended) {
          sourceNode.ended = true;
          sourceNode.onended?.();
        }
      }
    },
  };
}

function setup() {
  const context = vm.createContext({ document: { getElementById: () => ({}) }, window: {}, console });
  vm.runInContext(source.replace(/\ninitialize\(\);\s*$/, "") + `
    globalThis.api = {
      state, engine, scheduler,
      setTimeline(time, step) { nextStepTime = time; stepToSchedule = step; },
      getTimeline() { return { time: nextStepTime, step: stepToSchedule }; },
      collectScheduled(callback) { scheduleStep = callback; }
    };
  `, context);
  const api = context.api;
  api.engine.ctx = audioContext();
  api.engine.channels.bass = { input: api.engine.ctx.createGain() };
  api.engine.init = async () => {};
  return api;
}

test("short gates release continuously, without later gain rebounds or an audible hard stop", () => {
  const scenarios = [
    { label: "default sixteenth", duration: 0.118 },
    { label: "long attack", duration: 0.075, attack: 0.5, decay: 1.2 },
    { label: "long decay", duration: 0.1, decay: 1.2 },
    { label: "zero sustain", duration: 0.34, sustain: 0 },
    { label: "long release", duration: 0.08, release: 1.4 },
    { label: "high tempo and accent", duration: 0.07, accent: true },
    { label: "sustain phase", duration: 0.7, decay: 0.025 },
    { label: "full sustain", duration: 0.7, sustain: 1 },
  ];
  for (const scenario of scenarios) {
    const { state, engine } = setup();
    Object.assign(state.synth, scenario);
    const start = 1;
    engine.scheduleBass({ midi: 24, active: true, accent: Boolean(scenario.accent) }, start, scenario.duration);
    const amp = engine.ctx.nodes.find((node) => node.kind === "gain" && node.gain.events.some((event) => event.type === "exponential"));
    const gain = amp.gain;
    const gate = start + Math.max(0.045, scenario.duration - Math.max(0.02, state.synth.release) * 0.35);
    for (const event of gain.events.filter((entry) => entry.time > start)) {
      const jump = Math.abs(gain.valueAt(event.time) - gain.valueAt(event.time - 1e-7));
      assert.ok(jump < 0.0001, `${scenario.label}: gain jumps by ${jump} at ${event.time - start}s`);
    }
    let previous = gain.valueAt(gate);
    for (const event of [...gain.events].sort((a, b) => a.time - b.time).filter((entry) => entry.time > gate)) {
      const level = gain.valueAt(event.time);
      assert.ok(level <= previous + 1e-9, `${scenario.label}: gain rises after note-off`);
      previous = level;
    }
    const osc = engine.ctx.nodes.find((node) => node.kind === "oscillator");
    assert.equal(gain.valueAt(osc.stopAt - 1e-6), 0, `${scenario.label}: oscillator must stop in silence`);
    assert.equal(gain.valueAt(start), 0, `${scenario.label}: note must start from silence`);
  }
});

test("editing notes during playback or transport startup does not trigger extra bass notes", async () => {
  const { state, engine } = setup();
  let auditions = 0;
  engine.scheduleBass = () => { auditions += 1; };
  state.playing = true;
  await engine.previewBass({ midi: 24 });
  state.playing = false;
  state.starting = true;
  await engine.previewBass({ midi: 31 });
  assert.equal(auditions, 0);
});

test("rapid preview requests retain only the latest note and snapshot its pitch before audio resumes", async () => {
  const { engine } = setup();
  const pending = [];
  const played = [];
  engine.init = () => new Promise((resolve) => pending.push(resolve));
  engine.scheduleBass = (step) => played.push(step.midi);
  const first = engine.previewBass({ midi: 24 });
  const note = { midi: 31 };
  const last = engine.previewBass(note);
  note.midi = 48;
  pending[1]();
  await last;
  pending[0]();
  await first;
  assert.deepEqual(played, [31]);
});

test("a new mono note fades the old voice and disconnects it after both oscillators end", () => {
  const { state, engine } = setup();
  state.synth.release = 1.4;
  engine.scheduleBass({ active: true, midi: 24 }, 1, 0.34);
  const firstNodes = engine.ctx.nodes.slice(1);
  const oldSources = firstNodes.filter((node) => node.kind === "oscillator");
  engine.scheduleBass({ active: true, midi: 31, slide: true }, 1.05, 0.34, 24);
  assert.ok(oldSources.every((node) => node.stopAt <= 1.07), "long release must not stack under new notes");
  const fade = firstNodes.find((node) => node.kind === "gain" && node.gain.events.some((event) => event.type === "linear" && event.value === 0 && event.time <= 1.07));
  assert.ok(fade, "voice replacement must ramp to silence");
  engine.ctx.finishUntil(1.08);
  assert.ok(firstNodes.every((node) => node.disconnected), "ended voice nodes must be disconnected");
  engine.ctx.finishUntil(4);
  assert.ok(engine.ctx.nodes.slice(1).every((node) => node.disconnected));
});

test("stop cancels queued notes before they start, and cannot restart a voice already fading", () => {
  const { engine } = setup();
  engine.scheduleBass({ active: true, midi: 24 }, 0.2, 0.34);
  engine.stopBassVoices();
  const sources = engine.ctx.nodes.filter((node) => node.kind === "oscillator");
  assert.ok(sources.every((node) => node.stopAt < node.startAt));
  const stops = sources.map((node) => node.stopAt);
  engine.ctx.currentTime = 0.004;
  engine.stopBassVoices();
  assert.deepEqual(sources.map((node) => node.stopAt), stops, "repeated stop must not reopen a fading voice");
});

test("scheduler recovers from UI delays without firing missed beats together", () => {
  const api = setup();
  const scheduled = [];
  api.state.playing = true;
  api.engine.ctx.currentTime = 10.02;
  api.setTimeline(1, 0);
  api.collectScheduled((step, time) => scheduled.push({ step, time }));
  api.scheduler();
  assert.ok(scheduled.length <= 2, "expired beats must be skipped rather than replayed in a burst");
  assert.ok(scheduled.every(({ time }) => time >= 10.025 && time < 10.13));
  assert.ok(api.getTimeline().time >= 10.13);
});

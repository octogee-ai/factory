import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMattermostBrain, type BrainAgentEvent, type BrainEvent, type BrainInboundEvent } from "./brain.js";

class FakeEvents {
  private listeners = new Set<(e: BrainEvent) => void>();
  subscribe(listener: (e: BrainEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event: BrainEvent) {
    for (const l of this.listeners) l(event);
  }
  get size() {
    return this.listeners.size;
  }
}

const SESSION = "agent:mom-coach:mattermost:channel:chan1";

function lifecycle(runId: string, phase: string, sessionKey = SESSION): BrainAgentEvent {
  return { kind: "agent", runId, stream: "lifecycle", ts: Date.now(), sessionKey, data: { phase } };
}
function assistant(runId: string, data: Record<string, unknown>): BrainAgentEvent {
  return { kind: "agent", runId, stream: "assistant", ts: Date.now(), sessionKey: SESSION, data };
}
function received(messageId: string, sessionKey = SESSION): BrainInboundEvent {
  return { kind: "inbound", messageId, sessionKey, ts: Date.now() };
}

describe("createMattermostBrain", () => {
  beforeEach(() => vi.useFakeTimers({ now: 10_000 }));
  afterEach(() => vi.useRealTimers());

  function setup() {
    const events = new FakeEvents();
    const posts = { createPost: vi.fn(async () => ({ id: "post-1" })) };
    const brain = createMattermostBrain({ posts, events, replyStartTimeoutMs: 5_000, replyMaxMs: 60_000 });
    const handlers = { onRunStarted: vi.fn(), onDelta: vi.fn(), onDone: vi.fn() };
    return { events, posts, brain, handlers };
  }

  it("interrupts only the correlated native run and waits for its acknowledgement", async () => {
    const events = new FakeEvents();
    const posts = { createPost: vi.fn(async () => ({ id: "post-1" })) };
    let confirm!: (value: { status: "aborted"; runId: string }) => void;
    const interruptRun = vi.fn<(target: { runId: string; sessionKey: string }) => Promise<{ status: "aborted"; runId: string }>>().mockImplementation(() => new Promise((resolve) => { confirm = resolve; }));
    const brain = createMattermostBrain({ posts, events, interruptRun });
    const handlers = { onDelta: vi.fn(), onDone: vi.fn() };
    const turn = await brain.ask({ channelId: "chan1", text: "Open the news", turnId: "turn1" }, handlers);
    await expect(turn.interrupt()).rejects.toThrow("not identified");
    expect(interruptRun).not.toHaveBeenCalled();
    events.emit(received("post-1"));
    events.emit(lifecycle("run-1", "start"));
    const result = turn.interrupt();
    expect(interruptRun).toHaveBeenCalledWith({ runId: "run-1", sessionKey: SESSION });
    expect(handlers.onDone).not.toHaveBeenCalled();
    confirm({ status: "aborted", runId: "run-1" });
    await expect(result).resolves.toEqual({ status: "aborted", runId: "run-1" });
    expect(handlers.onDone).toHaveBeenCalledWith({ text: "", status: "aborted", runId: "run-1" });
    brain.dispose();
  });

  it("keeps observation alive when native interruption fails", async () => {
    const events = new FakeEvents();
    const posts = { createPost: vi.fn(async () => ({ id: "post-1" })) };
    const brain = createMattermostBrain({ posts, events, interruptRun: async () => { throw new Error("native refused"); } });
    const handlers = { onDelta: vi.fn(), onDone: vi.fn() };
    const turn = await brain.ask({ channelId: "chan1", text: "Open the news", turnId: "turn1" }, handlers);
    events.emit(received("post-1"));
    events.emit(lifecycle("run-1", "start"));
    await expect(turn.interrupt()).rejects.toThrow("native refused");
    events.emit(assistant("run-1", { delta: "Still running." }));
    expect(handlers.onDelta).toHaveBeenCalledWith("Still running.");
    brain.dispose();
  });

  it("posts the transcript as the Builder and speaks only the run that starts after OpenClaw received that post", async () => {
    const { events, posts, brain, handlers } = setup();
    const turn = await brain.ask({ channelId: "chan1", text: "What's on my calendar?", turnId: "t1" }, handlers);
    expect(posts.createPost).toHaveBeenCalledWith({ channelId: "chan1", text: "What's on my calendar?", turnId: "t1" });
    expect(turn.postId).toBe("post-1");

    events.emit(lifecycle("run-before-receipt", "start"));
    events.emit(assistant("run-before-receipt", { delta: "IGNORED" }));
    events.emit(lifecycle("run-before-receipt", "end"));
    events.emit(received("post-other"));
    events.emit(lifecycle("run-for-other-post", "start"));
    events.emit(lifecycle("run-for-other-post", "end"));
    expect(handlers.onRunStarted).not.toHaveBeenCalled();

    events.emit(received("post-1"));
    events.emit(lifecycle("run-elsewhere", "start", "agent:mom-coach:mattermost:channel:chan9"));
    expect(handlers.onRunStarted).not.toHaveBeenCalled();
    events.emit(lifecycle("run-1", "start"));
    expect(handlers.onRunStarted).toHaveBeenCalledWith("run-1");
    events.emit(assistant("run-1", { delta: "You have ", text: "You have " }));
    events.emit(assistant("run-1", { text: "You have lunch at noon." }));
    events.emit(assistant("run-2", { delta: "IGNORED" }));
    expect(handlers.onDelta.mock.calls.map((c) => c[0])).toEqual(["You have ", "lunch at noon."]);
    events.emit(lifecycle("run-1", "end"));
    expect(handlers.onDone).toHaveBeenCalledWith({ text: "You have lunch at noon.", status: "complete", runId: "run-1" });
    expect(events.size).toBe(1);
    brain.dispose();
    expect(events.size).toBe(0);
  });

  it("does not lose the receipt or first words when they arrive before the post request returns", async () => {
    const { events, posts, brain, handlers } = setup();
    let resolvePost!: (post: { id: string }) => void;
    posts.createPost.mockImplementationOnce(() => new Promise<{ id: string }>((resolve) => (resolvePost = resolve)));
    const asking = brain.ask({ channelId: "chan1", text: "hello", turnId: "t1" }, handlers);
    await Promise.resolve();
    events.emit(received("post-1"));
    events.emit(lifecycle("run-1", "start"));
    events.emit(assistant("run-1", { text: "Hi Mom." }));
    resolvePost({ id: "post-1" });
    await asking;
    expect(handlers.onRunStarted).toHaveBeenCalledWith("run-1");
    expect(handlers.onDelta).toHaveBeenCalledWith("Hi Mom.");
    events.emit(assistant("run-1", { text: "Hi Mom. How are you?" }));
    events.emit(lifecycle("run-1", "end"));
    expect(handlers.onDone).toHaveBeenCalledWith({ text: "Hi Mom. How are you?", status: "complete", runId: "run-1" });
  });

  it("when a run is already active on the session, the post is steered into it and only text after the receipt is the reply", async () => {
    const { events, brain, handlers } = setup();
    events.emit(lifecycle("run-active", "start"));
    events.emit(assistant("run-active", { text: "Earlier answer. " }));
    await brain.ask({ channelId: "chan1", text: "and the weather?", turnId: "t1" }, handlers);
    events.emit(assistant("run-active", { text: "Earlier answer. Still earlier. " }));
    events.emit(received("post-1"));
    expect(handlers.onRunStarted).toHaveBeenCalledWith("run-active");
    events.emit(assistant("run-active", { text: "Earlier answer. Still earlier. Sunny and mild." }));
    expect(handlers.onDelta.mock.calls.map((c) => c[0])).toEqual(["Sunny and mild."]);
    events.emit(lifecycle("run-active", "end"));
    expect(handlers.onDone).toHaveBeenCalledWith({ text: "Sunny and mild.", status: "complete", runId: "run-active" });
  });

  it("when the steered run ends without answering, the follow-up run that starts next is the reply", async () => {
    const { events, brain, handlers } = setup();
    events.emit(lifecycle("run-active", "start"));
    await brain.ask({ channelId: "chan1", text: "one more thing", turnId: "t1" }, handlers);
    events.emit(received("post-1"));
    events.emit(lifecycle("run-active", "end"));
    expect(handlers.onDone).not.toHaveBeenCalled();
    events.emit(lifecycle("run-followup", "start"));
    events.emit(assistant("run-followup", { delta: "Of course." }));
    events.emit(lifecycle("run-followup", "end"));
    expect(handlers.onRunStarted.mock.calls.map((c) => c[0])).toEqual(["run-active", "run-followup"]);
    expect(handlers.onDone).toHaveBeenCalledWith({ text: "Of course.", status: "complete", runId: "run-followup" });
  });

  it("times out when the post is never received or never answered, and closes long runs with what arrived", async () => {
    const { events, brain, handlers } = setup();
    await brain.ask({ channelId: "chan1", text: "hello", turnId: "t1" }, handlers);
    events.emit(lifecycle("run-unrelated", "start"));
    vi.advanceTimersByTime(5_001);
    expect(handlers.onDone).toHaveBeenCalledWith({ text: "", status: "timeout", runId: null });

    const steered = setup();
    steered.events.emit(lifecycle("run-active", "start"));
    await steered.brain.ask({ channelId: "chan1", text: "hello", turnId: "t2" }, steered.handlers);
    steered.events.emit(received("post-1"));
    vi.advanceTimersByTime(5_001);
    expect(steered.handlers.onDone).toHaveBeenCalledWith({ text: "", status: "timeout", runId: "run-active" });

    const long = setup();
    await long.brain.ask({ channelId: "chan1", text: "hello", turnId: "t3" }, long.handlers);
    long.events.emit(received("post-1"));
    long.events.emit(lifecycle("run-1", "start"));
    long.events.emit(assistant("run-1", { delta: "Working on it" }));
    vi.advanceTimersByTime(60_001);
    expect(long.handlers.onDone).toHaveBeenCalledWith({ text: "Working on it", status: "timeout", runId: "run-1" });
  });

  it("maps abort/error lifecycle phases and cancel to statuses, rethrows post failures, and dispose ends open turns", async () => {
    const { events, brain, handlers } = setup();
    await brain.ask({ channelId: "chan1", text: "x", turnId: "t1" }, handlers);
    events.emit(received("post-1"));
    events.emit(lifecycle("run-1", "start"));
    events.emit(lifecycle("run-1", "error"));
    expect(handlers.onDone).toHaveBeenCalledWith({ text: "", status: "error", runId: "run-1" });

    const cancelled = setup();
    const turn = await cancelled.brain.ask({ channelId: "chan1", text: "x", turnId: "t2" }, cancelled.handlers);
    turn.cancel();
    expect(cancelled.handlers.onDone).toHaveBeenCalledWith({ text: "", status: "aborted", runId: null });
    expect(cancelled.events.size).toBe(1);

    const failing = setup();
    failing.posts.createPost.mockRejectedValueOnce(new Error("MM 401"));
    await expect(failing.brain.ask({ channelId: "chan1", text: "x", turnId: "t3" }, failing.handlers)).rejects.toThrow("MM 401");
    expect(failing.events.size).toBe(1);

    const disposed = setup();
    await disposed.brain.ask({ channelId: "chan1", text: "x", turnId: "t4" }, disposed.handlers);
    disposed.brain.dispose();
    expect(disposed.handlers.onDone).toHaveBeenCalledWith({ text: "", status: "aborted", runId: null });
    expect(disposed.events.size).toBe(0);
  });
});

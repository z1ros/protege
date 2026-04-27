import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted spies — vi.mock factories run before module-level const declarations,
// so spies must be created via vi.hoisted to be accessible inside the factory.
// ---------------------------------------------------------------------------
const {
  onDidChangeTextDocument,
  onDidChangeActiveTextEditor,
  onDidChangeTextEditorSelection,
} = vi.hoisted(() => {
  function fakeDisp() {
    return { dispose: vi.fn() };
  }
  return {
    onDidChangeTextDocument: vi.fn(() => fakeDisp()),
    onDidChangeActiveTextEditor: vi.fn(() => fakeDisp()),
    onDidChangeTextEditorSelection: vi.fn(() => fakeDisp()),
  };
});

// ---------------------------------------------------------------------------
// vscode mock
// ---------------------------------------------------------------------------
vi.mock("vscode", () => ({
  workspace: { onDidChangeTextDocument },
  window: {
    activeTextEditor: null,
    onDidChangeActiveTextEditor,
    onDidChangeTextEditorSelection,
  },
  Disposable: class {
    dispose: () => void;
    constructor(fn: () => void) {
      this.dispose = fn;
    }
  },
}));

// ---------------------------------------------------------------------------
// batcher mock
// ---------------------------------------------------------------------------
vi.mock("./batcher.js", () => ({
  getBatcher: vi.fn(() => ({ push: vi.fn() })),
}));

// ---------------------------------------------------------------------------
// Module under test
// ---------------------------------------------------------------------------
import { startSessionTracker } from "./sessionTracker.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx() {
  return { subscriptions: [] } as any;
}

function fakeDisp() {
  return { dispose: vi.fn() };
}

/**
 * Returns the fake disposables returned by the three listener stubs for the
 * given call index (0 = first startSessionTracker call, 1 = second, etc.).
 */
function captureDisposablesForCall(callIndex: number) {
  return [
    onDidChangeTextDocument.mock.results[callIndex].value,
    onDidChangeActiveTextEditor.mock.results[callIndex].value,
    onDidChangeTextEditorSelection.mock.results[callIndex].value,
  ];
}

// ---------------------------------------------------------------------------
// Reset stubs before each test so call counts start at zero
// ---------------------------------------------------------------------------
beforeEach(() => {
  onDidChangeTextDocument.mockReset().mockImplementation(() => fakeDisp());
  onDidChangeActiveTextEditor.mockReset().mockImplementation(() => fakeDisp());
  onDidChangeTextEditorSelection.mockReset().mockImplementation(() => fakeDisp());
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("startSessionTracker", () => {
  it("T1: single call registers exactly 3 listeners", () => {
    // Counterfactual: would fail if startSessionTracker registered fewer or more event listeners.
    startSessionTracker(makeCtx());

    expect(onDidChangeTextDocument).toHaveBeenCalledTimes(1);
    expect(onDidChangeActiveTextEditor).toHaveBeenCalledTimes(1);
    expect(onDidChangeTextEditorSelection).toHaveBeenCalledTimes(1);
  });

  it("T2: double call without disposing first — each call gets its own 3 listeners; disposing second cleans only its own", () => {
    // Counterfactual: would fail if subscriptions stayed module-level — disposing the second
    // call would dispose both sets, and the first call's dispose trackers would show 1 call
    // even though only the second was explicitly disposed.
    const _disp1 = startSessionTracker(makeCtx());
    const disp2 = startSessionTracker(makeCtx());

    expect(onDidChangeTextDocument).toHaveBeenCalledTimes(2);
    expect(onDidChangeActiveTextEditor).toHaveBeenCalledTimes(2);
    expect(onDidChangeTextEditorSelection).toHaveBeenCalledTimes(2);

    const firstCallDisps = captureDisposablesForCall(0);
    const secondCallDisps = captureDisposablesForCall(1);

    disp2.dispose();

    for (const d of secondCallDisps) {
      expect(d.dispose).toHaveBeenCalledTimes(1);
    }
    for (const d of firstCallDisps) {
      expect(d.dispose).not.toHaveBeenCalled();
    }
  });

  it("T3: disposing first disposable while second is active cleans only first call's listeners", () => {
    // Counterfactual: would fail if both disposables shared the same subscriptions list.
    const disp1 = startSessionTracker(makeCtx());
    const _disp2 = startSessionTracker(makeCtx());

    const firstCallDisps = captureDisposablesForCall(0);
    const secondCallDisps = captureDisposablesForCall(1);

    disp1.dispose();

    for (const d of firstCallDisps) {
      expect(d.dispose).toHaveBeenCalledTimes(1);
    }
    for (const d of secondCallDisps) {
      expect(d.dispose).not.toHaveBeenCalled();
    }
  });
});

import assert from "node:assert/strict";
import test from "node:test";
import { browserKeyboardCommand } from "../src/lib/keyboard";

test("maps global transcript shortcuts", () => {
  assert.equal(browserKeyboardCommand({ key: "/" }), "focus-search");
  assert.equal(browserKeyboardCommand({ key: "J" }), "next-transcript");
  assert.equal(browserKeyboardCommand({ key: "k" }), "previous-transcript");
  assert.equal(browserKeyboardCommand({ key: "P" }), "toggle-pin");
  assert.equal(browserKeyboardCommand({ key: "c" }), "focus-comparison");
  assert.equal(browserKeyboardCommand({ key: "C", shiftKey: true }), "set-comparison");
  assert.equal(browserKeyboardCommand({ key: "PageDown" }), "page-down");
});

test("blocks shortcuts in editing and modal contexts", () => {
  for (const targetTag of ["input", "TEXTAREA", "select"]) {
    assert.equal(browserKeyboardCommand({ key: "j", targetTag }), null);
  }
  assert.equal(browserKeyboardCommand({ key: "j", contentEditable: true }), null);
  assert.equal(browserKeyboardCommand({ key: "j", targetRole: "textbox" }), null);
  assert.equal(browserKeyboardCommand({ key: "j", blockedContext: true }), null);
  assert.equal(browserKeyboardCommand({ key: "j", modalOpen: true }), null);
  assert.equal(browserKeyboardCommand({ key: "j", metaKey: true }), null);
});

test("does not claim unknown or modified shortcuts", () => {
  assert.equal(browserKeyboardCommand({ key: "x" }), null);
  assert.equal(browserKeyboardCommand({ key: "/", shiftKey: true }), null);
  assert.equal(browserKeyboardCommand({ key: "p", ctrlKey: true }), null);
});

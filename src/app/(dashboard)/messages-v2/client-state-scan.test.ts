import { readFileSync } from "node:fs";
import path from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Closure check for the client state machine (client-state.ts): in these files, NO React state setter may be
 * called directly from an async continuation -- after an `await` in an async function, or inside a `.then` /
 * `.catch` / `.finally` / `setTimeout` / `setInterval` callback. Those results must go through `commitIfCurrent`
 * (the setter is passed to it, never called). Synchronous setters (render-phase sync, click handlers before their
 * first await, effect bodies) carry no staleness and are allowed.
 *
 * The one explicit exemption is the realtime channel's `.on(...)` handlers: they apply a pushed row by run id, are
 * not a response to a request this page made, and so have nothing to be stale against (see the PR's state table).
 */

const FILES = ["messages-v2-view.tsx", "waiting-column.tsx", "page.tsx"];
const DEFERRED_CALLBACK_CALLEES = new Set(["then", "catch", "finally", "setTimeout", "setInterval"]);
const EXEMPT_CALLBACK_CALLEES = new Set(["on"]);
/**
 * Setters that are not results of a request at all, so there is nothing to be stale against:
 *  - setNowMs: the page clock tick (setInterval);
 *  - setLive: the realtime channel's own connection status, from its subscribe callback (the channel is torn down
 *    with its effect, so a status never outlives the channel it describes).
 */
const NOT_A_RESULT = new Set(["setNowMs", "setLive"]);

type Violation = { file: string; line: number; text: string };

function setterNames(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (n: ts.Node) => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isArrayBindingPattern(n.name) &&
      n.initializer &&
      ts.isCallExpression(n.initializer) &&
      /^(React\.)?useState$/.test(n.initializer.expression.getText(sf))
    ) {
      const second = n.name.elements[1];
      if (second && ts.isBindingElement(second) && ts.isIdentifier(second.name)) names.add(second.name.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return names;
}

const isFn = (n: ts.Node): n is ts.FunctionLikeDeclaration =>
  ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n);

function calleeName(call: ts.CallExpression): string {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return "";
}

/** Is `node` in an async continuation of its enclosing function (or of any enclosing deferred callback)? */
function inAsyncContinuation(node: ts.Node): boolean | "exempt" {
  let child: ts.Node = node;
  let p: ts.Node | undefined = node.parent;
  while (p) {
    if (isFn(p)) {
      const fn = p;
      // A callback passed to then/catch/finally/setTimeout/setInterval runs later.
      if (fn.parent && ts.isCallExpression(fn.parent) && fn.parent.arguments.includes(fn as ts.Expression)) {
        const name = calleeName(fn.parent);
        if (EXEMPT_CALLBACK_CALLEES.has(name)) return "exempt";
        if (DEFERRED_CALLBACK_CALLEES.has(name)) return true;
      }
      // An async function: anything positioned after its first await runs later.
      const isAsync = !!fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
      if (isAsync && fn.body) {
        let firstAwait = Infinity;
        const find = (n: ts.Node) => {
          if (n !== fn && isFn(n)) return; // nested functions have their own timeline
          if (ts.isAwaitExpression(n)) firstAwait = Math.min(firstAwait, n.getEnd());
          ts.forEachChild(n, find);
        };
        find(fn.body);
        if (node.getStart() > firstAwait) return true;
        // `finally` / `catch` blocks of a try that awaits also run after the await.
        let q: ts.Node | undefined = node.parent;
        while (q && q !== fn) {
          if (ts.isTryStatement(q) && firstAwait !== Infinity && (q.finallyBlock?.pos ?? Infinity) <= node.pos) return true;
          if (ts.isCatchClause(q) && firstAwait !== Infinity) return true;
          q = q.parent;
        }
      }
    }
    child = p;
    p = p.parent;
  }
  void child;
  return false;
}

function scan(file: string): Violation[] {
  const full = path.join(__dirname, file);
  const sf = ts.createSourceFile(full, readFileSync(full, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const setters = setterNames(sf);
  const out: Violation[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && setters.has(n.expression.text) && !NOT_A_RESULT.has(n.expression.text)) {
      if (inAsyncContinuation(n) === true) {
        out.push({ file, line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, text: n.getText(sf).slice(0, 80) });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

describe("client state machine closure: no async result bypasses commitIfCurrent", () => {
  for (const file of FILES)
    it(`${file}: no state setter is called directly from an async continuation`, () => {
      expect(scan(file)).toEqual([]);
    });

  it("the scanner catches a direct setter call after an await (self-test)", () => {
    const src = `
      import { useState } from "react";
      export function X() {
        const [a, setA] = useState(0);
        const go = async () => { await Promise.resolve(); setA(1); };
        const ok = async () => { setA(2); await Promise.resolve(); };
        Promise.resolve().then(() => setA(3));
        return null;
      }`;
    const sf = ts.createSourceFile("x.tsx", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const setters = setterNames(sf);
    const hits: string[] = [];
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && setters.has(n.expression.text) && inAsyncContinuation(n) === true)
        hits.push(n.getText(sf));
      ts.forEachChild(n, visit);
    };
    visit(sf);
    expect(hits).toEqual(["setA(1)", "setA(3)"]);
  });
});

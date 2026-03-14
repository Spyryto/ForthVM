// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: cyan; icon-glyph: magic;
// Minimal "real" Forth VM in JavaScript (direct-threaded)

function makeVM() {
  const DS = [];
  const RS = [];
  const dict = new Map();

  let compiling = false;
  let current = null;          // current word being compiled
  let control = [];            // compile-time control-flow stack (addresses)

  function push(x){ DS.push(x); }
  function pop(){ if (!DS.length) throw new Error("stack underflow"); return DS.pop(); }
  function rpush(x){ RS.push(x); }
  function rpop(){ if (!RS.length) throw new Error("return stack underflow"); return RS.pop(); }

  // Inner interpreter: runs a colon definition (array of ops / literals)
  function run(code) {
    let ip = 0;
    while (ip < code.length) {
      const op = code[ip++];
      op(vm, code, () => ip, (v) => { ip = v; });
    }
  }

  // Helper: call a word (primitive or colon)
  function execWord(w) {
    if (typeof w.code === "function") w.code(vm);
    else run(w.code);
  }

  // ---- Core VM object passed to ops ----
  const vm = { DS, RS, push, pop, rpush, rpop, dict, execWord };

  // ---- Ops for colon-threaded code ----
  // Each op gets (vm, code, getIP, setIP)
  const OP = {
    call: (w) => (vm) => execWord(w),

    lit: (vm, code, getIP, setIP) => {
      const ip = getIP();
      vm.push(code[ip]);       // next cell is a literal number
      setIP(ip + 1);
    },

    branch: (vm, code, getIP, setIP) => {
      const ip = getIP();
      const target = code[ip];
      setIP(target);
    },

    zbranch: (vm, code, getIP, setIP) => {
      const flag = vm.pop();
      const ip = getIP();
      const target = code[ip];
      setIP(flag ? ip + 1 : target);
    },

    exit: (vm) => {
      // implemented by setting ip past end: simplest trick is throw/catch,
      // but here we avoid it by relying on run() loop end:
      // we'll compile exit as a special op that jumps to end
      // (needs code length; easiest: close over a setter)
      throw new Error("EXIT should be patched with exitToEnd");
    },
  };

  // Better EXIT op that knows the current code length at runtime:
  function exitToEnd(vm, code, getIP, setIP) {
    setIP(code.length);
  }

  // ---- Dictionary helpers ----
  function defPrim(name, fn, immediate=false) {
    dict.set(name, { name, immediate, code: fn });
  }
  function defColon(name) {
    const w = { name, immediate: false, code: [] };
    dict.set(name, w);
    return w;
  }

  // ---- Compiler helpers ----
  function compileOp(op) {
    current.code.push(op);
  }
  function compileLit(n) {
    current.code.push(OP.lit, n);
  }
  function compileCall(word) {
    // calling a word inside colon def means compiling an op that calls it
    current.code.push((vm) => execWord(word));
  }

  function interpretToken(tok) {
    const w = dict.get(tok);
    if (w) {
      if (compiling && !w.immediate) compileCall(w);
      else execWord(w);
      return;
    }
    // number?
    const n = Number(tok);
    if (!Number.isNaN(n)) {
      if (compiling) compileLit(n);
      else push(n);
      return;
    }
    throw new Error(`Unknown token: ${tok}`);
  }

  // ---- Core primitives ----
  defPrim(".", (vm) => console.log(vm.pop()));
  defPrim("dup", (vm) => { const a = vm.pop(); vm.push(a); vm.push(a); });
  defPrim("drop", (vm) => { vm.pop(); });
  defPrim("swap", (vm) => { const b=vm.pop(), a=vm.pop(); vm.push(b); vm.push(a); });
  defPrim("over", (vm) => { const b=vm.pop(), a=vm.pop(); vm.push(a); vm.push(b); vm.push(a); });

  defPrim("+", (vm) => { const b=vm.pop(), a=vm.pop(); vm.push(a+b); });
  defPrim("-", (vm) => { const b=vm.pop(), a=vm.pop(); vm.push(a-b); });
  defPrim("*", (vm) => { const b=vm.pop(), a=vm.pop(); vm.push(a*b); });
  defPrim("=", (vm) => { const b=vm.pop(), a=vm.pop(); vm.push(a===b ? 1 : 0); });
  defPrim("0=", (vm) => { const a=vm.pop(); vm.push(a===0 ? 1 : 0); });

  // ":" starts a colon definition (immediate)
  defPrim(":", (vm) => { throw new Error(": is handled by outer interpreter"); }, true);
  defPrim(";", (vm) => { throw new Error("; is handled by outer interpreter"); }, true);

  // Control flow (immediate compile-time words)
  // if ... then  => zbranch <patch> ... <patch target>
  defPrim("if", (vm) => {
    if (!compiling) throw new Error("if outside compilation");
    compileOp(OP.zbranch);
    const addr = current.code.length;
    current.code.push(0);     // placeholder target
    control.push({ kind:"if", addr });
  }, true);

  defPrim("then", (vm) => {
    if (!compiling) throw new Error("then outside compilation");
    const c = control.pop();
    if (!c || c.kind !== "if") throw new Error("then without if");
    current.code[c.addr] = current.code.length; // patch target to here
  }, true);

  defPrim("begin", (vm) => {
    if (!compiling) throw new Error("begin outside compilation");
    control.push({ kind:"begin", addr: current.code.length });
  }, true);

  defPrim("until", (vm) => {
    if (!compiling) throw new Error("until outside compilation");
    const c = control.pop();
    if (!c || c.kind !== "begin") throw new Error("until without begin");
    compileOp(OP.zbranch);
    current.code.push(c.addr); // if flag==0 jump back
  }, true);

  // ---- Outer interpreter (tokenizer + : ;) ----
  function evalForth(src) {
    const tokens = src.trim().split(/\s+/).filter(Boolean);
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];

      if (t === ":") {
        const name = tokens[++i];
        current = defColon(name);
        compiling = true;
        continue;
      }

      if (t === ";") {
        // compile exit
        current.code.push(exitToEnd);
        compiling = false;
        current = null;
        continue;
      }

      interpretToken(t);
    }
    if (compiling) throw new Error("Unterminated definition (missing ;) ");
  }

  return { eval: evalForth, vm };
}

// Demo
const F = makeVM();
F.eval(`: sq dup * ; 5 sq .`);
F.eval(`: 1- 1 - ; : countDown begin dup . 1- dup 0= until drop ; 5 countDown`);



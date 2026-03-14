// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: cyan; icon-glyph: magic;
// Minimal "real" Forth VM in JavaScript (direct-threaded)

function makeVM() {
  const DS = [];
  const RS = [];
  const dict = new Map();

  // data space (very small, but enough for create/does>)
  const mem = [];
  let here = 0;

  function allot(n) {
    if ((n|0) !== n || n < 0) throw new Error("allot expects non-negative int");
    here += n;
  }

  let compiling = false;
  let current = null;          // current word being compiled
  let control = [];            // compile-time control-flow stack (addresses)
  let lastDefined = null;      // last word added to dictionary (for IMMEDIATE)

  // compile-time control-flow stack (addresses)

  function push(x){ DS.push(x); }
  function pop(){ if (!DS.length) throw new Error("stack underflow"); return DS.pop(); }
  function rpush(x){ RS.push(x); }
  function rpop(){ if (!RS.length) throw new Error("return stack underflow"); return RS.pop(); }

  // Inner interpreter: runs a colon definition (array of ops / literals)
  function run(code) {
    let ip = 0;
    while (ip < code.length) {
      const op = code[ip++];
      if (op.length <= 1) op(vm);
      else op(vm, code, () => ip, (v) => { ip = v; });
    }
  }

  // Helper: call a word (primitive or colon)
  function execWord(w) {
    const prevWord = vm.currentWord;
    const prevDef = vm.currentDefiner;

    vm.currentWord = w;

    try {
      if (typeof w.code === "function") {
        // primitive: do NOT change currentDefiner
        w.code(vm);
      } else {
        // colon: this word becomes the current definer for the duration
        vm.currentDefiner = w;
        run(w.code);
      }
    } finally {
      vm.currentWord = prevWord;
      vm.currentDefiner = prevDef;
    }
  }

  // ---- Core VM object passed to ops ----
    // ---- Core VM object passed to ops ----
  const vm = {
    DS, RS, push, pop, rpush, rpop, dict, execWord,

    // input stream (set by evalForth)
    input: null,
    nextToken() {
      const inp = this.input;
      if (!inp) throw new Error("No input stream");
      const j = inp.i + 1;
      if (j >= inp.tokens.length) throw new Error("Unexpected end of input");
      inp.i = j;
      return inp.tokens[j];
    },

    // word currently being executed (changes also for primitives)
    currentWord: null,

    // colon-word currently "owning" the execution (stable through primitives)
    currentDefiner: null,

    mem,
    get here() { return here; },
    set here(v) { here = v|0; },
    allot,
  };

  // ---- Ops for colon-threaded code ----
  // Each op gets (vm, code, getIP, setIP)
  const OP = {
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

  };

  // Better EXIT op that knows the current code length at runtime:
  function exitToEnd(vm, code, getIP, setIP) {
    setIP(code.length);
  }

  // ---- Dictionary helpers ----
  function defPrim(name, fn, immediate=false) {
    const w = { name, immediate, code: fn };
    dict.set(name, w);
    lastDefined = w;
  }

  function defColon(name) {
    const w = { name, immediate: false, code: [] };
    dict.set(name, w);
    lastDefined = w;
    return w;
  }

  // ---- Compiler helpers ----
  let compileTarget = null; // points to current.code or doesBuf
  let doesBuf = null;       // array or null

  function compileOp(op) {
    compileTarget.push(op);
  }
  function compileLit(n) {
    compileTarget.push(OP.lit, n);
  }
  function compileCall(word) {
    compileTarget.push(callWordOp, word);
  }

  function callWordOp(vm, code, getIP, setIP) {
    const ip = getIP();
    const w = code[ip];
    setIP(ip + 1);
    execWord(w);
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
  defPrim("/", (vm) => { const b=vm.pop(), a=vm.pop(); vm.push((a/b)|0); }); // divisione intera semplice
  defPrim("mod", (vm) => { const b=vm.pop(), a=vm.pop(); vm.push(a % b); });

  defPrim("here", (vm) => { vm.push(vm.here); });
  defPrim("allot", (vm) => { vm.allot(vm.pop()); });

  defPrim(",", (vm) => {
    const x = vm.pop();
    const addr = vm.here;
    vm.mem[addr] = x;
    vm.here = addr + 1;
  });

  defPrim("@", (vm) => {
    const addr = vm.pop();
    vm.push(vm.mem[addr] ?? 0);
  });

  defPrim("!", (vm) => {
    const addr = vm.pop();
    const x = vm.pop();
    vm.mem[addr] = x;
  });

    // addressing helpers (cell = 1 for now, but keeps the model Forth-ish)
  defPrim("cells", (vm) => { vm.push(vm.pop()); });
  defPrim("cell+", (vm) => { vm.push(vm.pop() + 1); });

  defPrim("+!", (vm) => {
    const addr = vm.pop();
    const n = vm.pop();
    vm.mem[addr] = (vm.mem[addr] ?? 0) + n;
  });

  // xt (execution token) + execute
  defPrim("execute", (vm) => {
    const xt = vm.pop();
    if (!xt || typeof xt !== "object" || !xt.name) throw new Error("execute expects an XT (word)");
    vm.execWord(xt);
  });

    // --- Bootstrap kit -------------------------------------------------

  // IMMEDIATE: mark last defined word as immediate
  defPrim("immediate", (vm) => {
    if (!lastDefined) throw new Error("immediate: no last defined word");
    lastDefined.immediate = true;
  });

  // [ and ]: switch interpreter/compiler state inside a colon definition
  defPrim("[", (vm) => { compiling = false; }, true);
  defPrim("]", (vm) => {
    if (!current) throw new Error("] outside a colon definition");
    compiling = true;
  }, true);

  // compile,  ( xt -- )  compile an execution token into current definition
  defPrim("compile,", (vm) => {
    if (!compiling) throw new Error("compile, outside compilation");
    const xt = vm.pop();
    if (!xt || typeof xt !== "object" || !xt.name) throw new Error("compile, expects an XT (word)");
    compileCall(xt);
  });

  // literal  ( x -- )  compile stack value as a literal into current definition
  defPrim("literal", (vm) => {
    if (!compiling) throw new Error("literal outside compilation");
    const x = vm.pop();
    compileLit(x);
  });

  // POSTPONE: compile the compilation semantics of the next word token
  // In our model: always compile a call to the word, even if it's immediate.
  defPrim("postpone", (vm) => {
    if (!compiling) throw new Error("postpone outside compilation");
    const name = vm.nextToken();
    const w = vm.dict.get(name);
    if (!w) throw new Error(`Unknown word: ${name}`);
    compileCall(w);
  }, true);

  // tick: ' name  ( -- xt )  (compiles xt as literal when compiling)
  defPrim("'", (vm) => {
    const name = vm.nextToken();
    const w = vm.dict.get(name);
    if (!w) throw new Error(`Unknown word: ${name}`);

    if (compiling) {
      compileLit(w);   // compile xt as a literal cell
    } else {
      vm.push(w);
    }
  }, true);

  // debug / introspection
  defPrim(".s", (vm) => {
    console.log("<" + vm.DS.length + "> " + vm.DS.map(x => {
      if (x && typeof x === "object" && x.name) return `'${x.name}`;
      return String(x);
    }).join(" "));
  });

  defPrim("words", (vm) => {
    console.log(Array.from(vm.dict.keys()).sort().join(" "));
  });

  defPrim("see", (vm) => {
    const name = vm.nextToken();
    const w = vm.dict.get(name);
    if (!w) throw new Error(`Unknown word: ${name}`);

    const tagCell = (cell) => {
      if (cell === callWordOp) return "call";
      if (cell === OP.lit) return "lit";
      if (cell === OP.branch) return "branch";
      if (cell === OP.zbranch) return "0branch";
      if (cell === exitToEnd) return "exit";
      if (typeof cell === "function") return "fn";
      if (cell && typeof cell === "object" && cell.name) return `'${cell.name}`;
      return JSON.stringify(cell);
    };

    if (typeof w.code === "function") {
      console.log(`${w.name}  (primitive)`);
      return;
    }

    console.log(`: ${w.name}`);
    const code = w.code;
    for (let i = 0; i < code.length; i++) {
      const c = code[i];

      // decode common threaded patterns
      if (c === callWordOp) {
        const ww = code[i + 1];
        console.log("  " + (ww && ww.name ? ww.name : "<bad-xt>"));
        i += 1;
        continue;
      }

      if (c === OP.lit) {
        console.log("  lit " + tagCell(code[i + 1]));
        i += 1;
        continue;
      }

      if (c === OP.branch) {
        console.log("  branch -> " + code[i + 1]);
        i += 1;
        continue;
      }

      if (c === OP.zbranch) {
        console.log("  0branch -> " + code[i + 1]);
        i += 1;
        continue;
      }

      console.log("  " + tagCell(c));
    }
    console.log(";");
    if (w.definerDoes) {
      console.log(`(has DOES> template: ${w.definerDoes.length} cells)`);
      console.log("does>  (template)");
      const code2 = w.definerDoes;
      for (let i = 0; i < code2.length; i++) {
        const c = code2[i];

        if (c === callWordOp) {
          const ww = code2[i + 1];
          console.log("  " + (ww && ww.name ? ww.name : "<bad-xt>"));
          i += 1;
          continue;
        }

        if (c === OP.lit) {
          console.log("  lit " + tagCell(code2[i + 1]));
          i += 1;
          continue;
        }

        if (c === OP.branch) {
          console.log("  branch -> " + code2[i + 1]);
          i += 1;
          continue;
        }

        if (c === OP.zbranch) {
          console.log("  0branch -> " + code2[i + 1]);
          i += 1;
          continue;
        }

        console.log("  " + tagCell(c));
      }
      console.log("(end template)");
    }
  });

  defPrim("1+", (vm) => { const a=vm.pop(); vm.push(a+1); });
  defPrim("1-", (vm) => { const a=vm.pop(); vm.push(a-1); });
  defPrim("negate", (vm) => { const a=vm.pop(); vm.push(-a); });

  defPrim("=", (vm) => { const b=vm.pop(), a=vm.pop(); vm.push(a===b ? 1 : 0); });
  defPrim("0=", (vm) => { const a=vm.pop(); vm.push(a===0 ? 1 : 0); });
  defPrim("0<", (vm) => { const a=vm.pop(); vm.push(a < 0 ? 1 : 0); });
  defPrim("<", (vm) => { const b=vm.pop(), a=vm.pop(); vm.push(a < b ? 1 : 0); });
  defPrim(">", (vm) => { const b=vm.pop(), a=vm.pop(); vm.push(a > b ? 1 : 0); });

  defPrim(">r", (vm) => { vm.rpush(vm.pop()); });
  defPrim("r>", (vm) => { vm.push(vm.rpop()); });
  defPrim("r@", (vm) => {
    if (!vm.RS.length) throw new Error("return stack underflow");
    vm.push(vm.RS[vm.RS.length - 1]);
  });

  // ":" starts a colon definition (immediate)
  defPrim(":", (vm) => { throw new Error(": is handled by outer interpreter"); }, true);
  defPrim(";", (vm) => { throw new Error("; is handled by outer interpreter"); }, true);

  defPrim("create", (vm) => {
    const name = vm.nextToken();

    const pfa = vm.here; // parameter field address (HERE at creation time)

    const w = {
      name,
      immediate: false,
      pfa,
      definerDoes: null, // only used if this word becomes a definer
      does: null,
      code: null,
    };

    // If we're executing a defining word that has a DOES> template, attach it
    const definer = vm.currentDefiner;
    if (definer && definer.definerDoes) {
      w.does = definer.definerDoes;
    }

    // runtime semantics of created word:
    // push PFA, then execute DOES-part if present
    w.code = (vm2) => {
      vm2.push(w.pfa);
      if (w.does) run(w.does);
    };

    dict.set(name, w);
  });

    // built-ins built on CREATE...DOES>
  // constant: ( n -- )  constant NAME   ; later: NAME ( -- n )
  defPrim("constant", (vm) => {
    const name = vm.nextToken();
    const n = vm.pop();

    const pfa = vm.here;
    vm.mem[pfa] = n;
    vm.here = pfa + 1;

    const w = {
      name,
      immediate: false,
      pfa,
      code: (vm2) => { vm2.push(vm2.mem[pfa] ?? 0); },
    };

    vm.dict.set(name, w);
  });

  // variable: ( -- )  variable NAME     ; later: NAME ( -- addr )
  defPrim("variable", (vm) => {
    const name = vm.nextToken();

    const pfa = vm.here;
    vm.mem[pfa] = 0;
    vm.here = pfa + 1;

    const w = {
      name,
      immediate: false,
      pfa,
      code: (vm2) => { vm2.push(pfa); },
    };

    vm.dict.set(name, w);
  });

  // Control flow (immediate compile-time words)
  // if ... then  => zbranch <patch> ... <patch target>
  defPrim("if", (vm) => {
    if (!compiling) throw new Error("if outside compilation");
    compileOp(OP.zbranch);
    const addr = current.code.length;
    current.code.push(0);               // placeholder target for 0branch
    control.push({ kind: "if", addr }); // addr points to placeholder cell
  }, true);

  defPrim("else", (vm) => {
    if (!compiling) throw new Error("else outside compilation");

    const c = control.pop();
    if (!c || c.kind !== "if") throw new Error("else without if");

    // compile unconditional branch to skip the ELSE-part
    compileOp(OP.branch);
    const addr = current.code.length;
    current.code.push(0);                 // placeholder target for branch

    // patch IF's 0branch to jump here (start of ELSE-part)
    current.code[c.addr] = current.code.length;

    // remember the branch placeholder to be patched by THEN
    control.push({ kind: "else", addr });
  }, true);

  defPrim("then", (vm) => {
    if (!compiling) throw new Error("then outside compilation");

    const c = control.pop();
    if (!c || (c.kind !== "if" && c.kind !== "else")) {
      throw new Error("then without if/else");
    }

    // patch the most recent placeholder (IF's 0branch or ELSE's branch)
    current.code[c.addr] = current.code.length;
  }, true);

  function takeForthStringToken(vm, who) {
    const t = vm.nextToken();
    const p = "\u0000STR:";
    if (typeof t !== "string" || !t.startsWith(p)) {
      throw new Error(`${who} expects a Forth string (missing closing ")`);
    }
    return t.slice(p.length);
  }

  // s" ...": ( -- s )  (compiles as literal in colon defs)
  defPrim('s"', (vm) => {
    const s = takeForthStringToken(vm, 's"');
    if (compiling) compileLit(s);
    else vm.push(s);
  }, true);

  // ." ...": print string (compiles: push string + type)
  defPrim('."', (vm) => {
    const s = takeForthStringToken(vm, '."');
    if (compiling) {
      compileLit(s);
      const typeW = vm.dict.get("type");
      if (!typeW) throw new Error('Missing word: type');
      compileCall(typeW);
    } else {
      console.log(s);
    }
  }, true);

  // type ( s -- ): print string (newline is console-dependent)
  defPrim("type", (vm) => {
    const s = vm.pop();
    console.log(String(s));
  });

  defPrim("does>", (vm) => {
    if (!compiling) throw new Error("does> outside compilation");

    // end the create-time part of the defining word
    compileTarget.push(exitToEnd);

    // start compiling the does-part into a separate buffer
    doesBuf = [];
    compileTarget = doesBuf;
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
  function tokenize(src) {
    const tokens = [];
    const n = src.length;
    let i = 0;

    const isWS = (c) => c === " " || c === "\t" || c === "\r" || c === "\n";

    while (i < n) {
      // skip whitespace
      while (i < n && isWS(src[i])) i++;
      if (i >= n) break;

      // backslash comment: \ ... end of line
      if (src[i] === "\\") {
        while (i < n && src[i] !== "\n") i++;
        continue;
      }
      // double-slash comment: // ... end of line
      if (src[i] === "/" && i + 1 < n && src[i + 1] === "/") {
        while (i < n && src[i] !== "\n") i++;
        continue;
      }

      // paren comment: ( ... )  (not nested)
      if (src[i] === "(") {
        i++; // consume '('
        while (i < n && src[i] !== ")") i++;
        if (i < n && src[i] === ")") i++; // consume ')'
        continue;
      }

      // Forth-style strings for s" and ."
      // We tokenize them as:  [ 's"' | '."' ]  [ \u0000STR:<content> ]
      if (
        (src[i] === "s" && i + 1 < n && src[i + 1] === '"') ||
        (src[i] === "." && i + 1 < n && src[i + 1] === '"')
      ) {
        const head = src[i] === "s" ? 's"' : '."';
        tokens.push(head);
        i += 2; // consume s" or ."

        // optional single whitespace after s"/."
        if (i < n && isWS(src[i])) i++;

        let s = "";
        while (i < n) {
          const c = src[i++];
          if (c === '"') break;
          if (c === "\\" && i < n) {
            const next = src[i++];
            if (next === '"' || next === "\\") s += next;
            else { s += "\\" + next; }
          } else {
            s += c;
          }
        }

        tokens.push("\u0000STR:" + s);
        continue;
      }

      // regular token: read until whitespace or comment start
      let tok = "";
      while (i < n && !isWS(src[i])) {
        // allow comments to start only when they are the first char of a token,
        // so inside tokens like "x\y" won't be treated as comment.
        tok += src[i++];
      }
      if (tok) tokens.push(tok);
    }

    return tokens;
  }

  function evalForth(src) {
    const tokens = tokenize(src);
    vm.input = { tokens, i: 0 };

    while (vm.input.i < tokens.length) {
      const i = vm.input.i;
      const t = tokens[i];

      if (t === ":") {
        const name = vm.nextToken();
        current = defColon(name);
        compiling = true;
        compileTarget = current.code;
        doesBuf = null;

        // (compileTarget/doesBuf li aggiungiamo nella PATCH 3)
        vm.input.i += 1;
        continue;
      }

      if (t === ";") {
                // finish whichever segment we're compiling
        compileTarget.push(exitToEnd);

        // if we had DOES>, store template on the defining word
        if (doesBuf) {
          current.definerDoes = doesBuf;
        }

        compiling = false;
        current = null;
        compileTarget = null;
        doesBuf = null;
        vm.input.i += 1;
        continue;
      }

      interpretToken(t);
      vm.input.i += 1;
    }

    if (compiling) throw new Error("Unterminated definition (missing ;) ");
    vm.input = null;
  }

  return { eval: evalForth, vm };
}

// Demo
const F = makeVM();
F.eval(`: sq dup * ; 5 sq .`);
F.eval(`: 1- 1 - ; : countDown begin dup . 1- dup 0= until drop ; 5 countDown`);
F.eval(`: abs dup 0< if negate then ; 0 2 - abs .`);
F.eval(`: sign dup 0= if drop 0 else 0< if -1 else 1 then then ; 0 3 - sign .`);
F.eval(String.raw`\ questo è un commento a fine riga
: sq ( n -- n^2 ) dup * ; 7 sq .`)
// F.eval(`
// : const  create , does> @ ;
// 5 const five
// five .
// `);
F.eval(`
: 2const  create , , does> dup @ swap 1+ @ ;
10 20 2const ten-twenty
ten-twenty . .   \\ dovrebbe stampare 20 poi 10 (dipende dall'ordine che vuoi)
`);
F.eval(`
: const create , does> @ ;
5 const five
' five execute .
.s
words
see const
`);
F.eval(`
123 constant K
K .          \\ 123

variable X
10 X !
X @ .        \\ 10
`);
F.eval(`
." ciao mondo"
s" hello" type
`);
F.eval(`
: hi  ." ciao da dentro una colon" ;
hi
`);
F.eval(`
: foo  111 . ;
immediate foo`);
F.eval(`: ten  [ 7 3 + ] literal ;
ten . `)
// @ts-nocheck
var yo = Object.create;
var Ke = Object.defineProperty;
var bo = Object.getOwnPropertyDescriptor;
var wo = Object.getOwnPropertyNames;
var Ro = Object.getPrototypeOf, ko = Object.prototype.hasOwnProperty;
var T = (e, n, t) => () => {
  if (t) throw t[0];
  try {
    return e && (n = e(e = 0)), n;
  } catch (r) {
    throw t = [r], r;
  }
};
var An = (e, n) => () => {
  try {
    return n || e((n = { exports: {} }).exports, n), n.exports;
  } catch (t) {
    throw n = 0, t;
  }
}, vn = (e, n) => {
  for (var t in n)
    Ke(e, t, { get: n[t], enumerable: !0 });
}, xo = (e, n, t, r) => {
  if (n && typeof n == "object" || typeof n == "function")
    for (let o of wo(n))
      !ko.call(e, o) && o !== t && Ke(e, o, { get: () => n[o], enumerable: !(r = bo(n, o)) || r.enumerable });
  return e;
};
var Mn = (e, n, t) => (t = e != null ? yo(Ro(e)) : {}, xo(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  n || !e || !e.__esModule ? Ke(t, "default", { value: e, enumerable: !0 }) : t,
  e
));

// openclaw/packages/normalization-core/src/record-coerce.ts
function V(e) {
  return e !== null && typeof e == "object" && !Array.isArray(e);
}
function N(e) {
  return V(e) ? e : void 0;
}
function L(e) {
  return V(e) ? e : null;
}
function Je(e) {
  return e && typeof e == "object" ? e : void 0;
}
function ne(e) {
  return Je(e) ?? null;
}
var D = T(() => {
});

// openclaw/ui/src/components/browser/browser-target.ts
function Ye(e, n = 128) {
  return typeof e == "string" && e.length > 0 && e.length <= n && e.trim() === e;
}
function Dn(e) {
  let n = L(e);
  if (!Ye(n?.targetId) || !Ye(n.profile))
    return;
  let t = { targetId: n.targetId, profile: n.profile };
  if (n.target === "host" && n.node === void 0)
    return { ...t, target: "host" };
  if (n.target === "node" && Ye(n.node, 256))
    return { ...t, target: "node", node: n.node };
}
function Pn(e) {
  return JSON.stringify([e.target, e.node, e.profile, e.targetId]);
}
var Xe = T(() => {
  D();
});

// openclaw/packages/gateway-client/src/device-auth.ts
var On = T(() => {
});

// openclaw/packages/gateway-client/src/chat-stream-message.ts
var Nn = T(() => {
  D();
});

// openclaw/packages/gateway-client/src/chat-stream-projection.ts
var Fn = T(() => {
  D();
});

// openclaw/packages/normalization-core/src/string-coerce.ts
function U(e) {
  if (typeof e != "string")
    return null;
  let n = e.trim();
  return n || null;
}
function B(e) {
  return U(e) ?? void 0;
}
function M(e) {
  return typeof e == "string" && e.trim() ? e : void 0;
}
var j = T(() => {
});

// openclaw/packages/normalization-core/src/number-coercion.ts
function te(e) {
  return typeof e == "number" && Number.isFinite(e) ? e : void 0;
}
var Co, hc, re = T(() => {
  j();
  Co = 2147e6, hc = Math.floor(Co / 1e3);
});

// openclaw/packages/normalization-core/src/string-normalization.ts
var Ae = T(() => {
  j();
});

// openclaw/packages/gateway-protocol/src/connect-error-details.ts
var _, xc, Cc, Ze = T(() => {
  re();
  Ae();
  _ = {
    AUTH_REQUIRED: "AUTH_REQUIRED",
    AUTH_UNAUTHORIZED: "AUTH_UNAUTHORIZED",
    AUTH_TOKEN_MISSING: "AUTH_TOKEN_MISSING",
    AUTH_TOKEN_MISMATCH: "AUTH_TOKEN_MISMATCH",
    AUTH_TOKEN_NOT_CONFIGURED: "AUTH_TOKEN_NOT_CONFIGURED",
    AUTH_PASSWORD_MISSING: "AUTH_PASSWORD_MISSING",
    // pragma: allowlist secret
    AUTH_PASSWORD_MISMATCH: "AUTH_PASSWORD_MISMATCH",
    // pragma: allowlist secret
    AUTH_PASSWORD_NOT_CONFIGURED: "AUTH_PASSWORD_NOT_CONFIGURED",
    // pragma: allowlist secret
    AUTH_BOOTSTRAP_TOKEN_INVALID: "AUTH_BOOTSTRAP_TOKEN_INVALID",
    AUTH_DEVICE_TOKEN_MISMATCH: "AUTH_DEVICE_TOKEN_MISMATCH",
    AUTH_SCOPE_MISMATCH: "AUTH_SCOPE_MISMATCH",
    AUTH_RATE_LIMITED: "AUTH_RATE_LIMITED",
    AUTH_TAILSCALE_IDENTITY_MISSING: "AUTH_TAILSCALE_IDENTITY_MISSING",
    AUTH_TAILSCALE_PROXY_MISSING: "AUTH_TAILSCALE_PROXY_MISSING",
    AUTH_TAILSCALE_WHOIS_FAILED: "AUTH_TAILSCALE_WHOIS_FAILED",
    AUTH_TAILSCALE_IDENTITY_MISMATCH: "AUTH_TAILSCALE_IDENTITY_MISMATCH",
    AUTH_IDENTITY_HEADER_REQUIRED: "AUTH_IDENTITY_HEADER_REQUIRED",
    AUTH_VERIFIED_USER_REQUIRED: "AUTH_VERIFIED_USER_REQUIRED",
    AUTHENTICATED_PROFILE_UNAVAILABLE: "AUTHENTICATED_PROFILE_UNAVAILABLE",
    OPERATOR_ACCESS_DENIED: "OPERATOR_ACCESS_DENIED",
    CONTROL_UI_BUILD_MISMATCH: "CONTROL_UI_BUILD_MISMATCH",
    CONTROL_UI_ORIGIN_NOT_ALLOWED: "CONTROL_UI_ORIGIN_NOT_ALLOWED",
    PROTOCOL_MISMATCH: "PROTOCOL_MISMATCH",
    CONTROL_UI_DEVICE_IDENTITY_REQUIRED: "CONTROL_UI_DEVICE_IDENTITY_REQUIRED",
    DEVICE_IDENTITY_REQUIRED: "DEVICE_IDENTITY_REQUIRED",
    DEVICE_AUTH_INVALID: "DEVICE_AUTH_INVALID",
    DEVICE_AUTH_DEVICE_ID_MISMATCH: "DEVICE_AUTH_DEVICE_ID_MISMATCH",
    DEVICE_AUTH_SIGNATURE_EXPIRED: "DEVICE_AUTH_SIGNATURE_EXPIRED",
    DEVICE_AUTH_NONCE_REQUIRED: "DEVICE_AUTH_NONCE_REQUIRED",
    DEVICE_AUTH_NONCE_MISMATCH: "DEVICE_AUTH_NONCE_MISMATCH",
    DEVICE_AUTH_SIGNATURE_INVALID: "DEVICE_AUTH_SIGNATURE_INVALID",
    DEVICE_AUTH_PUBLIC_KEY_INVALID: "DEVICE_AUTH_PUBLIC_KEY_INVALID",
    PAIRING_REQUIRED: "PAIRING_REQUIRED",
    PAIRING_REJECTED: "PAIRING_REJECTED",
    PAIRING_EXPIRED: "PAIRING_EXPIRED",
    CLIENT_VERSION_MISMATCH: "CLIENT_VERSION_MISMATCH"
  }, xc = /* @__PURE__ */ new Map([
    ["token_missing", _.AUTH_TOKEN_MISSING],
    ["token_mismatch", _.AUTH_TOKEN_MISMATCH],
    ["token_missing_config", _.AUTH_TOKEN_NOT_CONFIGURED],
    ["password_missing", _.AUTH_PASSWORD_MISSING],
    ["password_mismatch", _.AUTH_PASSWORD_MISMATCH],
    ["password_missing_config", _.AUTH_PASSWORD_NOT_CONFIGURED],
    ["bootstrap_token_invalid", _.AUTH_BOOTSTRAP_TOKEN_INVALID],
    ["tailscale_user_missing", _.AUTH_TAILSCALE_IDENTITY_MISSING],
    ["tailscale_proxy_missing", _.AUTH_TAILSCALE_PROXY_MISSING],
    ["tailscale_whois_failed", _.AUTH_TAILSCALE_WHOIS_FAILED],
    ["tailscale_user_mismatch", _.AUTH_TAILSCALE_IDENTITY_MISMATCH],
    ["rate_limited", _.AUTH_RATE_LIMITED],
    ["device_token_mismatch", _.AUTH_DEVICE_TOKEN_MISMATCH],
    ["scope_mismatch", _.AUTH_SCOPE_MISMATCH],
    [void 0, _.AUTH_REQUIRED]
  ]), Cc = /* @__PURE__ */ new Map([
    ["device-id-mismatch", _.DEVICE_AUTH_DEVICE_ID_MISMATCH],
    ["device-signature-stale", _.DEVICE_AUTH_SIGNATURE_EXPIRED],
    ["device-nonce-missing", _.DEVICE_AUTH_NONCE_REQUIRED],
    ["device-nonce-mismatch", _.DEVICE_AUTH_NONCE_MISMATCH],
    ["device-signature", _.DEVICE_AUTH_SIGNATURE_INVALID],
    ["device-public-key", _.DEVICE_AUTH_PUBLIC_KEY_INVALID]
  ]);
});

// openclaw/packages/gateway-client/src/connect-auth.ts
var Ln = T(() => {
  j();
});

// openclaw/packages/gateway-client/src/browser-device-auth.ts
var Un = T(() => {
});

// openclaw/packages/gateway-client/src/gateway-origin-scope.ts
var Bn = T(() => {
});

// openclaw/packages/gateway-client/src/model-catalog-connect.ts
var jn = T(() => {
});

// openclaw/packages/normalization-core/src/balanced-json.ts
var Gn = T(() => {
});

// openclaw/packages/normalization-core/src/boolean-coercion.ts
var Wn = T(() => {
});

// openclaw/packages/normalization-core/src/cjk-chars.ts
var Qe, Dc, Pc, Hn = T(() => {
  Qe = [
    [
      [183, 183],
      [12288, 12703],
      [19968, 40869],
      [44032, 55215],
      [65281, 65376]
    ],
    [
      [4352, 4607],
      [11904, 12287],
      [12704, 19967],
      [40870, 40959],
      [40960, 42239],
      [42752, 42759],
      [43360, 43391],
      [55216, 55295],
      [63744, 64255]
    ],
    [
      [711, 711],
      [713, 715],
      [729, 729],
      [746, 747],
      [773, 773],
      [803, 803],
      [65040, 65103],
      [65377, 65500],
      [65504, 65510]
    ],
    [[119648, 119665]],
    [
      [94176, 94207],
      [110576, 110591],
      [110592, 110959],
      [127488, 127743],
      [131072, 195103],
      [196608, 210047]
    ]
  ], Dc = new RegExp(
    `[${Qe.flatMap(
      (e) => e.map(([n, t]) => `\\u{${n.toString(16)}}-\\u{${t.toString(16)}}`)
    ).join("")}]`,
    "u"
  ), Pc = (() => {
    let e = Math.max(
      ...Qe.flatMap((t) => t.map(([, r]) => r))
    ), n = new Uint8Array(e + 1);
    for (let [t, r] of Qe.entries())
      for (let [o, i] of r)
        n.fill(t + 1, o, i + 1);
    return n;
  })();
});

// openclaw/packages/normalization-core/src/code-points.ts
var en = T(() => {
});

// openclaw/packages/normalization-core/src/error-coercion.ts
var So, zn, $n, qn, Vn = T(() => {
  So = /* @__PURE__ */ Symbol.for(
    "openclaw.provider-auth-persistence-error"
  ), qn = class extends ($n = AggregateError, zn = So, $n) {
    constructor(t, r, { cause: o }) {
      super([r, o], t, { cause: o });
      this[zn] = !0;
      this.persistenceError = r, this.cleanupError = o;
    }
  };
});

// openclaw/packages/normalization-core/src/expect.ts
var nn = T(() => {
});

// openclaw/packages/normalization-core/src/format.ts
var Kn = T(() => {
  nn();
});

// openclaw/packages/normalization-core/src/json-coercion.ts
function tn(e) {
  try {
    return JSON.parse(e);
  } catch {
    return;
  }
}
function ie(e) {
  return /^[\t\n\r ]*\{/.test(e) ? N(tn(e)) : void 0;
}
var rn = T(() => {
  D();
});

// openclaw/packages/normalization-core/src/response-bytes.ts
var Jn = T(() => {
});

// openclaw/packages/normalization-core/src/stable-stringify.ts
var Yn = T(() => {
});

// openclaw/packages/normalization-core/src/text-decoding.ts
var Xn = T(() => {
});

// openclaw/packages/normalization-core/src/utf16-slice.ts
function Zn(e) {
  return e >= 55296 && e <= 56319;
}
function Qn(e) {
  return e >= 56320 && e <= 57343;
}
function Eo(e, n, t) {
  let r = e.length, o = n < 0 ? Math.max(r + n, 0) : Math.min(n, r), i = t === void 0 ? r : t < 0 ? Math.max(r + t, 0) : Math.min(t, r);
  if (i <= o)
    return "";
  if (o > 0 && o < r) {
    let s = e.charCodeAt(o);
    Qn(s) && Zn(e.charCodeAt(o - 1)) && (o += 1);
  }
  if (i > 0 && i < r) {
    let s = e.charCodeAt(i - 1);
    Zn(s) && Qn(e.charCodeAt(i)) && (i -= 1);
  }
  return e.slice(o, i);
}
function ge(e, n) {
  let t = Math.max(0, Math.floor(n));
  return e.length <= t ? e : Eo(e, 0, t);
}
var me = T(() => {
});

// openclaw/packages/normalization-core/src/index.ts
var z = T(() => {
  Gn();
  Wn();
  Hn();
  en();
  Vn();
  nn();
  Kn();
  rn();
  re();
  D();
  Jn();
  Yn();
  j();
  Ae();
  Xn();
  me();
});

// openclaw/packages/retry/src/index.ts
function ve(e, n, t, r) {
  return typeof e != "number" || !Number.isFinite(e) ? n : Math.min(
    Math.max(e, t ?? Number.NEGATIVE_INFINITY),
    r ?? Number.POSITIVE_INFINITY
  );
}
function ye(e) {
  let n = e === Number.POSITIVE_INFINITY ? 2147e6 : Number.isFinite(e) ? e : 0;
  return Math.min(Math.max(Math.round(n), 0), 2147e6);
}
function Io(e = et, n) {
  let t = Math.max(1, Math.round(ve(n?.attempts, e.attempts))), r = ye(
    ve(n?.minDelayMs, e.minDelayMs, 0)
  ), o = Math.max(
    r,
    ye(ve(n?.maxDelayMs, e.maxDelayMs, 0))
  ), i = n?.jitter, s = e.jitter;
  return {
    attempts: t,
    minDelayMs: r,
    maxDelayMs: o,
    jitter: i === "full" ? i : typeof i == "number" && Number.isFinite(i) ? Math.min(Math.max(i, 0), 1) : s
  };
}
function Ao(e, n, t, r) {
  if (n === "full")
    return t === "symmetric" ? Math.max(0, Math.round(e * (0.5 + r() * 0.5))) : Math.max(0, Math.ceil(e * (1 + r())));
  if (n <= 0)
    return t === "positive" ? Math.ceil(e) : e;
  let o = r(), i = t === "positive" ? o * n : (o * 2 - 1) * n, s = e * (1 + i);
  return Math.max(0, t === "positive" ? Math.ceil(s) : Math.round(s));
}
function vo(e, n = "Non-Error thrown") {
  if (e instanceof Error)
    return e;
  if (typeof e == "string")
    return new Error(e);
  let t = new Error(n, { cause: e });
  return (typeof e == "object" && e !== null || typeof e == "function") && Object.assign(t, e), t;
}
function Mo(e = {}) {
  let n = e.sleep ?? _o, t = e.random ?? Math.random, r = e.createFailure ?? ((o) => vo(o.at(-1) ?? new Error("Retry failed")));
  return async function(i, s = 3, a = 300) {
    let u = [], d = typeof s == "number", h = typeof s == "number" ? { attempts: s } : s, g = Io(et, h), m = g.attempts, c = g.minDelayMs, l = g.maxDelayMs > 0 ? g.maxDelayMs : Number.POSITIVE_INFINITY, f = h.retryAfterMaxDelayMs === void 0 ? l : Math.max(
      c,
      ye(ve(h.retryAfterMaxDelayMs, l, 0))
    ), p = h.random ?? t, y = h.sleep ?? n, b = h.shouldRetry ?? (() => !0);
    for (let w = 1; w <= m; w += 1)
      try {
        return await i();
      } catch (R) {
        if (u.push(R), w >= m || !b(R, w))
          break;
        if (d) {
          await n(ye(a * 2 ** (w - 1)));
          continue;
        }
        let k = {
          attempt: w,
          maxAttempts: m,
          err: R,
          label: h.label
        }, x = h.retryAfterMs?.(R), S = typeof x == "number" && Number.isFinite(x), v = typeof h.delayMs == "function" ? h.delayMs(k) : h.delayMs, E = v === void 0 ? void 0 : ye(v), O = S ? Math.max(x, c) : E === void 0 ? c * 2 ** (w - 1) : Math.max(E, c), I = S ? f : l, A = Math.min(O, I), W = S && (x ?? 0) <= I, H = g.jitter === "full" && !S || W;
        A = Ao(
          A,
          g.jitter,
          H ? "positive" : "symmetric",
          p
        ), A = Math.min(Math.max(A, c), I), await h.onRetry?.({ ...k, delayMs: A }), A > 0 && await y(A);
      }
    throw r(u);
  };
}
var et, _o, ll, nt = T(() => {
  et = {
    attempts: 3,
    minDelayMs: 300,
    maxDelayMs: 3e4,
    jitter: 0
  }, _o = async (e) => {
    let n = e;
    do {
      let t = Math.min(n, 2147e6);
      await new Promise((r) => {
        setTimeout(r, t);
      }), n -= t;
    } while (n > 0);
  };
  ll = Mo();
});

// openclaw/packages/gateway-protocol/src/startup-unavailable.ts
var tt = T(() => {
});

// openclaw/packages/gateway-client/src/protocol-client.ts
var xl, rt = T(() => {
  z();
  D();
  Ae();
  nt();
  xl = Object.freeze({ closeCode: 1008, closeReason: "connect failed" });
});

// openclaw/packages/gateway-client/src/reconnect-policy.ts
var _l, ot = T(() => {
  Ze();
  _l = /* @__PURE__ */ new Set([
    _.AUTH_TOKEN_MISSING,
    _.AUTH_BOOTSTRAP_TOKEN_INVALID,
    _.AUTH_PASSWORD_MISSING,
    _.AUTH_PASSWORD_MISMATCH,
    _.AUTH_RATE_LIMITED,
    _.AUTH_DEVICE_TOKEN_MISMATCH,
    _.AUTH_SCOPE_MISMATCH,
    _.AUTH_IDENTITY_HEADER_REQUIRED,
    _.AUTH_VERIFIED_USER_REQUIRED,
    _.CONTROL_UI_BUILD_MISMATCH,
    _.PAIRING_REQUIRED,
    _.PAIRING_REJECTED,
    _.PAIRING_EXPIRED,
    _.CONTROL_UI_DEVICE_IDENTITY_REQUIRED,
    _.DEVICE_IDENTITY_REQUIRED
  ]);
});

// openclaw/packages/gateway-protocol/src/gateway-error-details.ts
var it = T(() => {
});

// openclaw/packages/gateway-client/src/session-projection-message-identity.ts
function st(e) {
  return typeof e == "number" && Number.isSafeInteger(e) && e > 0 ? e : null;
}
function at(e, n) {
  let t = L(L(e)?.__openclaw);
  return st(t?.seq) ?? st(n?.messageSeq);
}
function be(e) {
  let n = U(e);
  return n?.endsWith(":user") ? n.slice(0, -5) || null : n;
}
function on(e, n) {
  let t = L(e), r = U(t?.role)?.toLowerCase();
  if (!t || !r)
    return null;
  let o = L(t.__openclaw), i = U(o?.importedFrom), s = U(o?.cliSessionId), a = U(o?.externalId), u = L(o?.transcriptPosition), d = U(u?.source), g = !(d !== null && d.length <= 128 && typeof u?.rawSeq == "number" && Number.isSafeInteger(u.rawSeq) && u.rawSeq >= 0) && !!(i || s || a), m = U(o?.idempotencyKey) ?? U(t.idempotencyKey) ?? U(n?.idempotencyKey) ?? U(n?.clientRunId), c = be(m), l = be(n?.runId), f = be(o?.runId), p = be(
    L(t.openclawStreamFallback)?.runId
  ), y = U(o?.mirrorOrigin) !== null, b = r === "assistant" && U(t.api)?.toLowerCase() === "cli", w = b && c?.startsWith("cli-assistant:") ? U(c.slice(14)) : c, R = r === "assistant" ? f ?? l ?? p ?? (b || !y ? w : null) : f ?? w ?? l;
  return {
    role: r,
    id: U(o?.id) ?? U(n?.messageId),
    sequence: at(e, n),
    idempotencyKey: m,
    sendId: r === "user" ? c ?? R : null,
    runId: R,
    isImported: g,
    // Imported IDs belong to their provider and CLI session, never the native ID namespace.
    externalSource: g && i && s && a ? JSON.stringify([i, s, a]) : null
  };
}
var ct = T(() => {
  D();
  j();
});

// openclaw/packages/gateway-client/src/session-projection.ts
var lt = T(() => {
  D();
  j();
  ct();
});

// openclaw/packages/normalization-core/src/result.ts
var ut = T(() => {
});

// openclaw/packages/normalization-core/src/agent-id.ts
var dt = T(() => {
  ut();
});

// openclaw/packages/normalization-core/src/uuid.ts
var pt = T(() => {
});

// openclaw/packages/gateway-client/src/session-subscriptions.ts
var ft = T(() => {
  dt();
  pt();
});

// openclaw/packages/gateway-protocol/src/client-info.ts
var Do, Po, Xl, Zl, ht = T(() => {
  j();
  Do = {
    WEBCHAT_UI: "webchat-ui",
    CONTROL_UI: "openclaw-control-ui",
    BROWSER_COPILOT: "openclaw-browser-copilot",
    TUI: "openclaw-tui",
    WEBCHAT: "webchat",
    CLI: "cli",
    GATEWAY_CLIENT: "gateway-client",
    MACOS_APP: "openclaw-macos",
    // Native Linux UI uses the same trusted-client admission class as the macOS app.
    LINUX_APP: "openclaw-linux",
    IOS_APP: "openclaw-ios",
    WATCHOS_APP: "openclaw-watchos",
    ANDROID_APP: "openclaw-android",
    NODE_HOST: "node-host",
    WORKER: "openclaw-worker",
    TEST: "test",
    FINGERPRINT: "fingerprint",
    PROBE: "openclaw-probe"
  }, Po = {
    WEBCHAT: "webchat",
    CLI: "cli",
    UI: "ui",
    BACKEND: "backend",
    NODE: "node",
    WORKER: "worker",
    PROBE: "probe",
    TEST: "test"
  }, Xl = new Map(
    Object.values(Do).map((e) => [e, e])
  ), Zl = new Map(
    Object.values(Po).map((e) => [e, e])
  );
});

// openclaw/packages/gateway-protocol/src/session-row-deltas.ts
var gt = T(() => {
});

// openclaw/packages/gateway-protocol/src/version.ts
var mt = T(() => {
});

// openclaw/packages/gateway-client/src/browser.ts
var yt = T(() => {
  On();
  Nn();
  Fn();
  Un();
  Bn();
  Ln();
  jn();
  rt();
  ot();
  lt();
  ft();
  ht();
  Ze();
  it();
  gt();
  tt();
  mt();
});

// openclaw/node_modules/.pnpm/punycode.js@2.3.1/node_modules/punycode.js/punycode.js
var cr = An((Gp, ar) => {
  "use strict";
  var Ii = /^xn--/, Ai = /[^\0-\x7F]/, vi = /[\x2E\u3002\uFF0E\uFF61]/g, Mi = {
    overflow: "Overflow: input needs wider integers to process",
    "not-basic": "Illegal input >= 0x80 (not a basic code point)",
    "invalid-input": "Invalid input"
  }, mn = 35, K = Math.floor, yn = String.fromCharCode;
  function Z(e) {
    throw new RangeError(Mi[e]);
  }
  function Di(e, n) {
    let t = [], r = e.length;
    for (; r--; )
      t[r] = n(e[r]);
    return t;
  }
  function tr(e, n) {
    let t = e.split("@"), r = "";
    t.length > 1 && (r = t[0] + "@", e = t[1]), e = e.replace(vi, ".");
    let o = e.split("."), i = Di(o, n).join(".");
    return r + i;
  }
  function rr(e) {
    let n = [], t = 0, r = e.length;
    for (; t < r; ) {
      let o = e.charCodeAt(t++);
      if (o >= 55296 && o <= 56319 && t < r) {
        let i = e.charCodeAt(t++);
        (i & 64512) == 56320 ? n.push(((o & 1023) << 10) + (i & 1023) + 65536) : (n.push(o), t--);
      } else
        n.push(o);
    }
    return n;
  }
  var Pi = (e) => String.fromCodePoint(...e), Oi = function(e) {
    return e >= 48 && e < 58 ? 26 + (e - 48) : e >= 65 && e < 91 ? e - 65 : e >= 97 && e < 123 ? e - 97 : 36;
  }, nr = function(e, n) {
    return e + 22 + 75 * (e < 26) - ((n != 0) << 5);
  }, or = function(e, n, t) {
    let r = 0;
    for (e = t ? K(e / 700) : e >> 1, e += K(e / n); e > mn * 26 >> 1; r += 36)
      e = K(e / mn);
    return K(r + (mn + 1) * e / (e + 38));
  }, ir = function(e) {
    let n = [], t = e.length, r = 0, o = 128, i = 72, s = e.lastIndexOf("-");
    s < 0 && (s = 0);
    for (let a = 0; a < s; ++a)
      e.charCodeAt(a) >= 128 && Z("not-basic"), n.push(e.charCodeAt(a));
    for (let a = s > 0 ? s + 1 : 0; a < t; ) {
      let u = r;
      for (let h = 1, g = 36; ; g += 36) {
        a >= t && Z("invalid-input");
        let m = Oi(e.charCodeAt(a++));
        m >= 36 && Z("invalid-input"), m > K((2147483647 - r) / h) && Z("overflow"), r += m * h;
        let c = g <= i ? 1 : g >= i + 26 ? 26 : g - i;
        if (m < c)
          break;
        let l = 36 - c;
        h > K(2147483647 / l) && Z("overflow"), h *= l;
      }
      let d = n.length + 1;
      i = or(r - u, d, u == 0), K(r / d) > 2147483647 - o && Z("overflow"), o += K(r / d), r %= d, n.splice(r++, 0, o);
    }
    return String.fromCodePoint(...n);
  }, sr = function(e) {
    let n = [];
    e = rr(e);
    let t = e.length, r = 128, o = 0, i = 72;
    for (let u of e)
      u < 128 && n.push(yn(u));
    let s = n.length, a = s;
    for (s && n.push("-"); a < t; ) {
      let u = 2147483647;
      for (let h of e)
        h >= r && h < u && (u = h);
      let d = a + 1;
      u - r > K((2147483647 - o) / d) && Z("overflow"), o += (u - r) * d, r = u;
      for (let h of e)
        if (h < r && ++o > 2147483647 && Z("overflow"), h === r) {
          let g = o;
          for (let m = 36; ; m += 36) {
            let c = m <= i ? 1 : m >= i + 26 ? 26 : m - i;
            if (g < c)
              break;
            let l = g - c, f = 36 - c;
            n.push(
              yn(nr(c + l % f, 0))
            ), g = K(l / f);
          }
          n.push(yn(nr(g, 0))), i = or(o, d, a === s), o = 0, ++a;
        }
      ++o, ++r;
    }
    return n.join("");
  }, Ni = function(e) {
    return tr(e, function(n) {
      return Ii.test(n) ? ir(n.slice(4).toLowerCase()) : n;
    });
  }, Fi = function(e) {
    return tr(e, function(n) {
      return Ai.test(n) ? "xn--" + sr(n) : n;
    });
  }, Li = {
    /**
     * A string representing the current Punycode.js version number.
     * @memberOf punycode
     * @type String
     */
    version: "2.3.1",
    /**
     * An object of methods to convert from JavaScript's internal character
     * representation (UCS-2) to Unicode code points, and back.
     * @see <https://mathiasbynens.be/notes/javascript-encoding>
     * @memberOf punycode
     * @type Object
     */
    ucs2: {
      decode: rr,
      encode: Pi
    },
    decode: ir,
    encode: sr,
    toASCII: Fi,
    toUnicode: Ni
  };
  ar.exports = Li;
});

// openclaw/node_modules/.pnpm/ipaddr.js@2.5.0/node_modules/ipaddr.js/lib/ipaddr.js
var jr = An((Br, $e) => {
  (function(e) {
    "use strict";
    let n = "(0?\\d+|0x[a-f0-9]+)", t = {
      fourOctet: new RegExp(`^${n}\\.${n}\\.${n}\\.${n}$`, "i"),
      threeOctet: new RegExp(`^${n}\\.${n}\\.${n}$`, "i"),
      twoOctet: new RegExp(`^${n}\\.${n}$`, "i"),
      longValue: new RegExp(`^${n}$`, "i")
    }, r = new RegExp("^0[0-7]+$", "i"), o = new RegExp("^0x[a-f0-9]+$", "i"), i = "%[0-9a-z]{1,}", s = "(?:[0-9a-f]+::?)+", a = {
      zoneIndex: new RegExp(i, "i"),
      native: new RegExp(`^(::)?(${s})?([0-9a-f]+)?(::)?(${i})?$`, "i"),
      deprecatedTransitional: new RegExp(`^(?:::)(${n}\\.${n}\\.${n}\\.${n}(${i})?)$`, "i"),
      transitional: new RegExp(`^((?:${s})|(?:::)(?:${s})?)${n}\\.${n}\\.${n}\\.${n}(${i})?$`, "i")
    };
    function u(c, l) {
      if (c.indexOf("::") !== c.lastIndexOf("::"))
        return null;
      let f = 0, p = -1, y = (c.match(a.zoneIndex) || [])[0], b, w;
      for (y && (y = y.substring(1), c = c.replace(/%.+$/, "")); (p = c.indexOf(":", p + 1)) >= 0; )
        f++;
      if (c.substr(0, 2) === "::" && f--, c.substr(-2, 2) === "::" && f--, f >= l)
        return null;
      for (w = l - f, b = ":"; w--; )
        b += "0:";
      return c = c.replace("::", b), c[0] === ":" && (c = c.slice(1)), c[c.length - 1] === ":" && (c = c.slice(0, -1)), l = (function() {
        let R = c.split(":"), k = [];
        for (let x = 0; x < R.length; x++)
          k.push(R[x].length > 4 ? NaN : parseInt(R[x], 16));
        return k;
      })(), {
        parts: l,
        zoneId: y
      };
    }
    function d(c, l, f, p) {
      if (c.length !== l.length)
        throw new Error("ipaddr: cannot match CIDR for objects with different lengths");
      let y = 0, b;
      for (; p > 0; ) {
        if (b = f - p, b < 0 && (b = 0), c[y] >> b !== l[y] >> b)
          return !1;
        p -= f, y += 1;
      }
      return !0;
    }
    function h(c) {
      if (o.test(c))
        return parseInt(c, 16);
      if (c[0] === "0" && !isNaN(parseInt(c[1], 10))) {
        if (r.test(c))
          return parseInt(c, 8);
        throw new Error(`ipaddr: cannot parse ${c} as octal`);
      }
      return parseInt(c, 10);
    }
    function g(c, l) {
      for (; c.length < l; )
        c = `0${c}`;
      return c;
    }
    let m = {};
    m.IPv4 = (function() {
      function c(l) {
        if (l.length !== 4)
          throw new Error("ipaddr: ipv4 octet count should be 4");
        let f, p;
        for (f = 0; f < l.length; f++)
          if (p = l[f], !(0 <= p && p <= 255))
            throw new Error("ipaddr: ipv4 octet should fit in 8 bits");
        this.octets = l;
      }
      return c.prototype.SpecialRanges = {
        unspecified: [[new c([0, 0, 0, 0]), 8]],
        broadcast: [[new c([255, 255, 255, 255]), 32]],
        // RFC3171
        multicast: [[new c([224, 0, 0, 0]), 4]],
        // RFC3927
        linkLocal: [[new c([169, 254, 0, 0]), 16]],
        // RFC5735
        loopback: [[new c([127, 0, 0, 0]), 8]],
        // RFC6598
        carrierGradeNat: [[new c([100, 64, 0, 0]), 10]],
        // RFC1918
        private: [
          [new c([10, 0, 0, 0]), 8],
          [new c([172, 16, 0, 0]), 12],
          [new c([192, 168, 0, 0]), 16]
        ],
        // Reserved and testing-only ranges; RFCs 5735, 5737, 2544, 1700
        reserved: [
          [new c([192, 0, 0, 0]), 24],
          [new c([192, 0, 2, 0]), 24],
          [new c([192, 88, 99, 0]), 24],
          [new c([198, 18, 0, 0]), 15],
          [new c([198, 51, 100, 0]), 24],
          [new c([203, 0, 113, 0]), 24],
          [new c([240, 0, 0, 0]), 4]
        ],
        // RFC7534, RFC7535
        as112: [
          [new c([192, 175, 48, 0]), 24],
          [new c([192, 31, 196, 0]), 24]
        ],
        // RFC7450
        amt: [
          [new c([192, 52, 193, 0]), 24]
        ]
      }, c.prototype.kind = function() {
        return "ipv4";
      }, c.prototype.match = function(l, f) {
        let p;
        if (f === void 0 && (p = l, l = p[0], f = p[1]), l.kind() !== "ipv4")
          throw new Error("ipaddr: cannot match ipv4 address with non-ipv4 one");
        return d(this.octets, l.octets, 8, f);
      }, c.prototype.prefixLengthFromSubnetMask = function() {
        let l = 0, f = !1, p = {
          0: 8,
          128: 7,
          192: 6,
          224: 5,
          240: 4,
          248: 3,
          252: 2,
          254: 1,
          255: 0
        }, y, b, w;
        for (y = 3; y >= 0; y -= 1)
          if (b = this.octets[y], b in p) {
            if (w = p[b], f && w !== 0)
              return null;
            w !== 8 && (f = !0), l += w;
          } else
            return null;
        return 32 - l;
      }, c.prototype.range = function() {
        return m.subnetMatch(this, this.SpecialRanges);
      }, c.prototype.toByteArray = function() {
        return this.octets.slice(0);
      }, c.prototype.toIPv4MappedAddress = function() {
        return m.IPv6.parse(`::ffff:${this.toString()}`);
      }, c.prototype.toNormalizedString = function() {
        return this.toString();
      }, c.prototype.toString = function() {
        return this.octets.join(".");
      }, c;
    })(), m.IPv4.broadcastAddressFromCIDR = function(c) {
      try {
        let l = this.parseCIDR(c), f = l[0].toByteArray(), p = this.subnetMaskFromPrefixLength(l[1]).toByteArray(), y = [], b = 0;
        for (; b < 4; )
          y.push(parseInt(f[b], 10) | parseInt(p[b], 10) ^ 255), b++;
        return new this(y);
      } catch (l) {
        throw new Error("ipaddr: the address does not have IPv4 CIDR format", { cause: l });
      }
    }, m.IPv4.isIPv4 = function(c) {
      return this.parser(c) !== null;
    }, m.IPv4.isValid = function(c) {
      try {
        return new this(this.parser(c)), !0;
      } catch {
        return !1;
      }
    }, m.IPv4.isValidCIDR = function(c) {
      try {
        return this.parseCIDR(c), !0;
      } catch {
        return !1;
      }
    }, m.IPv4.isValidFourPartDecimal = function(c) {
      return !!(m.IPv4.isValid(c) && c.match(/^(0|[1-9]\d*)(\.(0|[1-9]\d*)){3}$/));
    }, m.IPv4.isValidCIDRFourPartDecimal = function(c) {
      let l = c.match(/^(.+)\/(\d+)$/);
      return !m.IPv4.isValidCIDR(c) || !l ? !1 : m.IPv4.isValidFourPartDecimal(l[1]);
    }, m.IPv4.networkAddressFromCIDR = function(c) {
      let l, f, p, y, b;
      try {
        for (l = this.parseCIDR(c), p = l[0].toByteArray(), b = this.subnetMaskFromPrefixLength(l[1]).toByteArray(), y = [], f = 0; f < 4; )
          y.push(parseInt(p[f], 10) & parseInt(b[f], 10)), f++;
        return new this(y);
      } catch (w) {
        throw new Error("ipaddr: the address does not have IPv4 CIDR format", { cause: w });
      }
    }, m.IPv4.parse = function(c) {
      let l = this.parser(c);
      if (l === null)
        throw new Error("ipaddr: string is not formatted like an IPv4 Address");
      return new this(l);
    }, m.IPv4.parseCIDR = function(c) {
      let l;
      if (l = c.match(/^(.+)\/(\d+)$/)) {
        let f = parseInt(l[2]);
        if (f >= 0 && f <= 32) {
          let p = [this.parse(l[1]), f];
          return Object.defineProperty(p, "toString", {
            value: function() {
              return this.join("/");
            }
          }), p;
        }
      }
      throw new Error("ipaddr: string is not formatted like an IPv4 CIDR range");
    }, m.IPv4.parser = function(c) {
      let l, f, p;
      if (l = c.match(t.fourOctet))
        return (function() {
          let y = l.slice(1, 6), b = [];
          for (let w = 0; w < y.length; w++)
            f = y[w], b.push(h(f));
          return b;
        })();
      if (l = c.match(t.longValue)) {
        if (p = h(l[1]), p > 4294967295 || p < 0)
          throw new Error("ipaddr: address outside defined range");
        return (function() {
          let y = [], b;
          for (b = 0; b <= 24; b += 8)
            y.push(p >> b & 255);
          return y;
        })().reverse();
      } else return (l = c.match(t.twoOctet)) ? (function() {
        let y = l.slice(1, 4), b = [];
        if (p = h(y[1]), p > 16777215 || p < 0)
          throw new Error("ipaddr: address outside defined range");
        return b.push(h(y[0])), b.push(p >> 16 & 255), b.push(p >> 8 & 255), b.push(p & 255), b;
      })() : (l = c.match(t.threeOctet)) ? (function() {
        let y = l.slice(1, 5), b = [];
        if (p = h(y[2]), p > 65535 || p < 0)
          throw new Error("ipaddr: address outside defined range");
        return b.push(h(y[0])), b.push(h(y[1])), b.push(p >> 8 & 255), b.push(p & 255), b;
      })() : null;
    }, m.IPv4.subnetMaskFromPrefixLength = function(c) {
      if (c = parseInt(c), Number.isNaN(c) || c < 0 || c > 32)
        throw new Error("ipaddr: invalid IPv4 prefix length");
      let l = [0, 0, 0, 0], f = 0, p = Math.floor(c / 8);
      for (; f < p; )
        l[f] = 255, f++;
      return p < 4 && (l[p] = Math.pow(2, c % 8) - 1 << 8 - c % 8), new this(l);
    }, m.IPv6 = (function() {
      function c(l, f) {
        let p, y;
        if (l.length === 16)
          for (this.parts = [], p = 0; p <= 14; p += 2)
            this.parts.push(l[p] << 8 | l[p + 1]);
        else if (l.length === 8)
          this.parts = l;
        else
          throw new Error("ipaddr: ipv6 part count should be 8 or 16");
        for (p = 0; p < this.parts.length; p++)
          if (y = this.parts[p], !(0 <= y && y <= 65535))
            throw new Error("ipaddr: ipv6 part should fit in 16 bits");
        f && (this.zoneId = f);
      }
      return c.prototype.SpecialRanges = {
        // RFC4291, here and after
        unspecified: [new c([0, 0, 0, 0, 0, 0, 0, 0]), 128],
        linkLocal: [new c([65152, 0, 0, 0, 0, 0, 0, 0]), 10],
        multicast: [new c([65280, 0, 0, 0, 0, 0, 0, 0]), 8],
        loopback: [new c([0, 0, 0, 0, 0, 0, 0, 1]), 128],
        uniqueLocal: [new c([64512, 0, 0, 0, 0, 0, 0, 0]), 7],
        ipv4Mapped: [new c([0, 0, 0, 0, 0, 65535, 0, 0]), 96],
        // RFC3879
        deprecatedSiteLocal: [new c([65216, 0, 0, 0, 0, 0, 0, 0]), 10],
        // RFC6666
        discard: [new c([256, 0, 0, 0, 0, 0, 0, 0]), 64],
        // RFC6145
        rfc6145: [new c([0, 0, 0, 0, 65535, 0, 0, 0]), 96],
        rfc6052: [
          // RFC6052
          [new c([100, 65435, 0, 0, 0, 0, 0, 0]), 96],
          // RFC8215
          [new c([100, 65435, 1, 0, 0, 0, 0, 0]), 48]
        ],
        // RFC3056
        "6to4": [new c([8194, 0, 0, 0, 0, 0, 0, 0]), 16],
        // RFC6052, RFC6146
        teredo: [new c([8193, 0, 0, 0, 0, 0, 0, 0]), 32],
        // RFC5180
        benchmarking: [new c([8193, 2, 0, 0, 0, 0, 0, 0]), 48],
        // RFC7450
        amt: [new c([8193, 3, 0, 0, 0, 0, 0, 0]), 32],
        as112v6: [
          // RFC7535
          [new c([8193, 4, 274, 0, 0, 0, 0, 0]), 48],
          // RFC7534
          [new c([9760, 79, 32768, 0, 0, 0, 0, 0]), 48]
        ],
        // RFC4843
        deprecatedOrchid: [new c([8193, 16, 0, 0, 0, 0, 0, 0]), 28],
        // RFC7343
        orchid2: [new c([8193, 32, 0, 0, 0, 0, 0, 0]), 28],
        // RFC9374
        droneRemoteIdProtocolEntityTags: [new c([8193, 48, 0, 0, 0, 0, 0, 0]), 28],
        // RFC9602
        segmentRouting: [new c([24320, 0, 0, 0, 0, 0, 0, 0]), 16],
        reserved: [
          // RFC3849
          [new c([8193, 0, 0, 0, 0, 0, 0, 0]), 23],
          // RFC2928
          [new c([8193, 3512, 0, 0, 0, 0, 0, 0]), 32],
          // RFC9637
          [new c([16383, 0, 0, 0, 0, 0, 0, 0]), 20]
        ]
      }, c.prototype.isIPv4MappedAddress = function() {
        return this.range() === "ipv4Mapped";
      }, c.prototype.kind = function() {
        return "ipv6";
      }, c.prototype.match = function(l, f) {
        let p;
        if (f === void 0 && (p = l, l = p[0], f = p[1]), l.kind() !== "ipv6")
          throw new Error("ipaddr: cannot match ipv6 address with non-ipv6 one");
        return d(this.parts, l.parts, 16, f);
      }, c.prototype.prefixLengthFromSubnetMask = function() {
        let l = 0, f = !1, p = {
          0: 16,
          32768: 15,
          49152: 14,
          57344: 13,
          61440: 12,
          63488: 11,
          64512: 10,
          65024: 9,
          65280: 8,
          65408: 7,
          65472: 6,
          65504: 5,
          65520: 4,
          65528: 3,
          65532: 2,
          65534: 1,
          65535: 0
        }, y, b;
        for (let w = 7; w >= 0; w -= 1)
          if (y = this.parts[w], y in p) {
            if (b = p[y], f && b !== 0)
              return null;
            b !== 16 && (f = !0), l += b;
          } else
            return null;
        return 128 - l;
      }, c.prototype.range = function() {
        return m.subnetMatch(this, this.SpecialRanges);
      }, c.prototype.toByteArray = function() {
        let l, f = [], p = this.parts;
        for (let y = 0; y < p.length; y++)
          l = p[y], f.push(l >> 8), f.push(l & 255);
        return f;
      }, c.prototype.toFixedLengthString = function() {
        let l = (function() {
          let p = [];
          for (let y = 0; y < this.parts.length; y++)
            p.push(g(this.parts[y].toString(16), 4));
          return p;
        }).call(this).join(":"), f = "";
        return this.zoneId && (f = `%${this.zoneId}`), l + f;
      }, c.prototype.toIPv4Address = function() {
        if (!this.isIPv4MappedAddress())
          throw new Error("ipaddr: trying to convert a generic ipv6 address to ipv4");
        let l = this.parts.slice(-2), f = l[0], p = l[1];
        return new m.IPv4([f >> 8, f & 255, p >> 8, p & 255]);
      }, c.prototype.toNormalizedString = function() {
        let l = (function() {
          let p = [];
          for (let y = 0; y < this.parts.length; y++)
            p.push(this.parts[y].toString(16));
          return p;
        }).call(this).join(":"), f = "";
        return this.zoneId && (f = `%${this.zoneId}`), l + f;
      }, c.prototype.toRFC5952String = function() {
        let l = /((^|:)(0(:|$)){2,})/g, f = "";
        this.zoneId && (f = `%${this.zoneId}`);
        let p = this.toNormalizedString(), y = p.slice(0, p.length - f.length), b = 0, w = -1, R = -1, k;
        for (; k = l.exec(y); ) {
          let x = (k[0].match(/0/g) || []).length;
          x > R && (R = x, b = k.index, w = k[0].length);
        }
        return w < 0 ? y + f : `${y.substring(0, b)}::${y.substring(b + w)}${f}`;
      }, c.prototype.toString = function() {
        return this.toRFC5952String();
      }, c;
    })(), m.IPv6.broadcastAddressFromCIDR = function(c) {
      try {
        let l = this.parseCIDR(c), f = l[0].toByteArray(), p = this.subnetMaskFromPrefixLength(l[1]).toByteArray(), y = [], b = 0;
        for (; b < 16; )
          y.push(parseInt(f[b], 10) | parseInt(p[b], 10) ^ 255), b++;
        return new this(y);
      } catch (l) {
        throw new Error("ipaddr: the address does not have IPv6 CIDR format", { cause: l });
      }
    }, m.IPv6.isIPv6 = function(c) {
      return this.parser(c) !== null;
    }, m.IPv6.isValid = function(c) {
      if (typeof c == "string" && c.indexOf(":") === -1)
        return !1;
      try {
        let l = this.parser(c);
        return new this(l.parts, l.zoneId), !0;
      } catch {
        return !1;
      }
    }, m.IPv6.isValidCIDR = function(c) {
      if (typeof c == "string" && c.indexOf(":") === -1)
        return !1;
      try {
        return this.parseCIDR(c), !0;
      } catch {
        return !1;
      }
    }, m.IPv6.networkAddressFromCIDR = function(c) {
      let l, f, p, y, b;
      try {
        for (l = this.parseCIDR(c), p = l[0].toByteArray(), b = this.subnetMaskFromPrefixLength(l[1]).toByteArray(), y = [], f = 0; f < 16; )
          y.push(parseInt(p[f], 10) & parseInt(b[f], 10)), f++;
        return new this(y);
      } catch (w) {
        throw new Error("ipaddr: the address does not have IPv6 CIDR format", { cause: w });
      }
    }, m.IPv6.parse = function(c) {
      let l = this.parser(c);
      if (l === null)
        throw new Error("ipaddr: string is not formatted like an IPv6 Address");
      return new this(l.parts, l.zoneId);
    }, m.IPv6.parseCIDR = function(c) {
      let l, f, p;
      if ((f = c.match(/^(.+)\/(\d+)$/)) && (l = parseInt(f[2]), l >= 0 && l <= 128))
        return p = [this.parse(f[1]), l], Object.defineProperty(p, "toString", {
          value: function() {
            return this.join("/");
          }
        }), p;
      throw new Error("ipaddr: string is not formatted like an IPv6 CIDR range");
    }, m.IPv6.parser = function(c) {
      let l, f, p, y, b, w;
      if (p = c.match(a.deprecatedTransitional))
        return this.parser(`::ffff:${p[1]}`);
      if (a.native.test(c))
        return u(c, 8);
      if ((p = c.match(a.transitional)) && (w = p[6] || "", l = p[1], p[1].endsWith("::") || (l = l.slice(0, -1)), l = u(l + w, 6), l && l.parts)) {
        for (b = [
          parseInt(p[2]),
          parseInt(p[3]),
          parseInt(p[4]),
          parseInt(p[5])
        ], f = 0; f < b.length; f++)
          if (y = b[f], !(0 <= y && y <= 255))
            return null;
        return l.parts.push(b[0] << 8 | b[1]), l.parts.push(b[2] << 8 | b[3]), {
          parts: l.parts,
          zoneId: l.zoneId
        };
      }
      return null;
    }, m.IPv6.subnetMaskFromPrefixLength = function(c) {
      if (c = parseInt(c), Number.isNaN(c) || c < 0 || c > 128)
        throw new Error("ipaddr: invalid IPv6 prefix length");
      let l = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], f = 0, p = Math.floor(c / 8);
      for (; f < p; )
        l[f] = 255, f++;
      return p < 16 && (l[p] = Math.pow(2, c % 8) - 1 << 8 - c % 8), new this(l);
    }, m.fromByteArray = function(c) {
      let l = c.length;
      if (l === 4)
        return new m.IPv4(c);
      if (l === 16)
        return new m.IPv6(c);
      throw new Error("ipaddr: the binary input is neither an IPv6 nor IPv4 address");
    }, m.isValid = function(c) {
      return m.IPv6.isValid(c) || m.IPv4.isValid(c);
    }, m.isValidCIDR = function(c) {
      return m.IPv6.isValidCIDR(c) || m.IPv4.isValidCIDR(c);
    }, m.parse = function(c) {
      if (m.IPv6.isValid(c))
        return m.IPv6.parse(c);
      if (m.IPv4.isValid(c))
        return m.IPv4.parse(c);
      throw new Error("ipaddr: the address has neither IPv6 nor IPv4 format");
    }, m.parseCIDR = function(c) {
      try {
        return m.IPv6.parseCIDR(c);
      } catch {
        try {
          return m.IPv4.parseCIDR(c);
        } catch (l) {
          throw new Error("ipaddr: the address has neither IPv6 nor IPv4 CIDR format", { cause: l });
        }
      }
    }, m.process = function(c) {
      let l = this.parse(c);
      return l.kind() === "ipv6" && l.isIPv4MappedAddress() ? l.toIPv4Address() : l;
    }, m.subnetMatch = function(c, l, f) {
      let p, y, b, w;
      f == null && (f = "unicast");
      for (y in l)
        if (Object.prototype.hasOwnProperty.call(l, y)) {
          for (b = l[y], b[0] && !(b[0] instanceof Array) && (b = [b]), p = 0; p < b.length; p++)
            if (w = b[p], c.kind() === w[0].kind() && c.match.apply(c, w))
              return y;
        }
      return f;
    }, typeof $e < "u" && $e.exports ? $e.exports = m : e.ipaddr = m;
  })(Br);
});

// openclaw/ui/src/i18n/locales/en-agents.ts
var qr, zr, $r, Vr = T(() => {
  qr = {
    menuLabel: "Agent menu",
    agents: "Agents",
    showAll: "Show all",
    createAgent: "Create new agent",
    newAgent: "New agent",
    creatingAgent: "Creating new agent\u2026",
    namedSettings: "{name} settings",
    newConversation: "New conversation",
    workspaceMenuLabel: "Workspace menu",
    switchAgent: "Switch agent",
    working: "Working\u2026",
    ready: "Ready to chat",
    help: "Help",
    getHelp: "Get support",
    getApps: "Get the apps",
    discord: "Discord community",
    viewChangelog: "View changelog"
  }, zr = {
    label: "Agent",
    allAgents: "All agents"
  }, $r = {
    pinToSwitcher: "Pin to switcher",
    unpinFromSwitcher: "Unpin from switcher"
  };
});

// openclaw/ui/src/i18n/locales/en.ts
var Ca, he, _n = T(() => {
  Vr();
  Ca = {
    pluginUi: {
      retryView: "Retry plugin view",
      inlineLoading: "Loading plugin view\u2026",
      inlineUnavailable: "This view is unavailable. Check that its plugin is installed, enabled, and allowed for your account. Reload the conversation after installing or updating the plugin.",
      dashboardTitle: "Session dashboard",
      customPluginsDisabled: "Custom plugin UI is off",
      customPluginsEnableHint: "Enable Custom plugin UI in Labs.",
      openLabs: "Open Labs",
      surface: {}
    },
    capacityMeter: {},
    agentsHome: {
      loadFailed: "Could not load agents. Try again."
    },
    outputs: {
      dashboard: "Dashboard"
    },
    common: {
      uploadsDisabled: "File and image uploads are disabled.",
      health: "Health",
      ok: "OK",
      yes: "Yes",
      no: "No",
      default: "Default",
      active: "Active",
      loading: "Loading\u2026",
      gatewayStarting: "Gateway starting\u2026",
      refreshing: "Refreshing\u2026",
      offline: "Offline",
      connect: "Connect",
      connected: "Connected",
      refresh: "Refresh",
      retry: "Retry",
      staleData: "Showing stale data.",
      reload: "Reload",
      reset: "Reset",
      restore: "Restore",
      unarchive: "Unarchive",
      undo: "Undo",
      probe: "Check connection",
      call: "Call",
      confirm: "Confirm",
      dontAskAgain: "Don't ask me again",
      cancel: "Cancel",
      close: "Close",
      previous: "Previous",
      next: "Next",
      continue: "Continue",
      back: "Back",
      create: "Create",
      copy: "Copy",
      copied: "Copied!",
      copyFailed: "Copy failed",
      copyCode: "Copy code",
      copyTable: "Copy table",
      expandTable: "Expand table",
      expandedTable: "Expanded table",
      closeTable: "Close expanded table",
      resizeSplitView: "Resize split view",
      delete: "Delete",
      remove: "Remove",
      dismiss: "Dismiss",
      dismissAndDontShowAgain: "Dismiss and don't show again",
      unselect: "Unselect",
      enabled: "Enabled",
      disabled: "Disabled",
      failed: "Failed",
      none: "none",
      na: "n/a",
      never: "never",
      justNow: "just now",
      now: "now",
      unknown: "Unknown",
      configured: "Configured",
      running: "Running",
      queued: "Queued",
      completed: "Completed",
      cancelled: "Cancelled",
      linked: "Linked",
      mode: "Mode",
      system: "System",
      light: "Light",
      dark: "Dark",
      baseUrl: "Base URL",
      lastStart: "Last start",
      lastProbe: "Last connection check",
      lastConnect: "Last connect",
      lastMessage: "Last message",
      authAge: "Auth age",
      credential: "Credential",
      audience: "Audience",
      publicKey: "Public Key",
      probeOk: "Connection check passed",
      probeFailed: "Connection check failed",
      reloadConfig: "Reload Config",
      multiSelect: {
        addCustom: "Add \u201C{value}\u201D",
        noMatches: "No matches",
        remove: "Remove {value}"
      },
      loadConfig: "Load config",
      loadApprovals: "Load approvals",
      settingsSections: "Settings sections",
      version: "Version",
      docs: "Docs",
      learnMore: "Learn more",
      colorMode: "Color mode",
      colorModeOption: "Color mode: {mode}",
      search: "Search",
      pickerNoMatches: "No matches",
      save: "Save",
      saving: "Saving\u2026",
      saveAndPublish: "Save & Publish",
      importing: "Importing\u2026",
      importFromRelays: "Import from Relays",
      showAdvanced: "Show Advanced",
      hideAdvanced: "Hide Advanced",
      unsavedChanges: "You have unsaved changes",
      working: "Working\u2026",
      showQr: "Show QR",
      relink: "Relink",
      waitForScan: "Wait for scan",
      logout: "Logout",
      skipToMainContent: "Skip to main content"
    },
    focus: {
      unsupported: "This focused view is not supported."
    },
    shortcutsOverlay: { title: "Keyboard shortcuts" },
    optionCard: {
      recommended: "Recommended",
      skip: "Skip for now"
    },
    nativeConversation: {
      openDashboardFailed: "Couldn't open that page in the Dashboard"
    },
    nativeLinkMenu: {},
    browserLinkPreferences: {
      openInControlUi: "Open links in Control UI browser"
    },
    filePreview: {
      bundle: {},
      label: "Support files"
    },
    mcpApp: {},
    sessionHovercard: {
      ariaLabel: "Session information",
      linkedChannel: "Linked to {channel}",
      moreParticipants: "+{count}",
      moreParticipantsLabel: "{count} more participants",
      projectLabel: "Project",
      workspaceLabel: "Workspace",
      branchLabel: "Branch",
      runsOn: "Runs on {providerId} \xB7 {profileId}",
      machineLabel: "Machine",
      machineCpu: "{cpu} vCPU",
      machineMemory: "{memory} GB",
      more: "+{count} more",
      changedFile: "{count} file",
      changedFiles: "{count} files",
      states: {},
      checks: {}
    },
    sessionProgressCard: {
      composerTitle: "Task progress",
      clearFailed: "Could not clear saved progress card.",
      refresh: {},
      activity: {},
      outcome: {},
      status: {},
      receipt: {
        updating: "Updating progress",
        failed: "Progress update failed",
        skipped: "Progress update skipped",
        updated: "Progress updated \u2014 {completed}/{total} \xB7 {current}",
        noteUpdated: "Progress note updated",
        cleared: "Progress cleared"
      }
    },
    channels: {
      lastError: {},
      refreshingStaleSnapshot: {},
      hub: {},
      pairing: {},
      setup: {},
      config: {},
      generic: {},
      discord: {},
      googleChat: {},
      imessage: {},
      signal: {},
      slack: {},
      telegram: {},
      whatsapp: {
        loggedOut: "Logged out.",
        logoutNotCleared: "No stored WhatsApp session was cleared. It may already be absent, or its auth directory may require manual cleanup."
      }
    },
    agentStartup: {
      title: "Starting up",
      description: "The agent is getting ready. This view will load automatically.",
      short: "Starting up\u2026"
    },
    lazyView: {
      errorTitle: "Panel failed to load",
      genericSubtitle: "Something went wrong while loading this panel.",
      staleTitle: "This view could not load",
      staleSubtitle: "Some interface files could not be downloaded. Check your connection, then reload.",
      reloading: "Reloading\u2026",
      retry: "Retry",
      stylesFailed: "Styles failed to load, so the page may look broken."
    },
    communityInvite: {
      title: "Pull up a chair.",
      body: "There\u2019s a place for you in the AI future. Join the Community on Reddit, Discord, and X.",
      join: "Join",
      follow: "Follow",
      dismissForever: "Dismiss and don't show again",
      dismissFailed: "Invitation dismissed, but your preference couldn't be saved.",
      joinPlatform: "Join the OpenClaw community on {platform}",
      followPlatform: "Follow OpenClaw on {platform}"
    },
    updates: {
      campaign: {
        countdown: "Updating in {time}",
        waitingForIdle: "Waiting for active work \xB7 forced update in {time}",
        held: "Update held \xB7 resumes in {time}",
        applying: "Applying update\u2026"
      },
      run: {
        phase: {}
      },
      confirm: {},
      target: {
        version: "v{version}",
        commitBehind: "{count} commit behind",
        commitsBehind: "{count} commits behind"
      },
      sidebar: {
        waitingForIdle: "Waiting for active work"
      },
      dialog: {},
      channel: {},
      installKind: {},
      page: {},
      coalescedRestart: "Update installed. A gateway restart is already in progress; status will refresh after it reconnects.",
      error: "Update error: {error}",
      checkError: "Could not check for updates: {error}",
      status: "Update {status}: {reason}. {guidance}",
      verificationFailedWithIdentity: "Update finished, but the running install does not match the expected revision. Expected {expected}, running {actual}. Run `openclaw triage` on the Gateway host before retrying.",
      handoffTimeout: "Update completion was not confirmed. Run `openclaw triage` on the Gateway host and inspect the result before retrying.",
      outcomeUnknown: "The update outcome is unknown. Run `openclaw triage` on the Gateway host and inspect the result before retrying.",
      triage: {
        hostHint: "If Ask OpenClaw is unavailable, run `openclaw triage` on the Gateway host to open a local coding agent for diagnosis and repair. Diagnose the cause before retrying."
      },
      report: {},
      failureReasons: {
        dirty: "Commit or stash changes, then retry.",
        noUpstream: "Set an upstream branch, then retry.",
        notGitInstall: "Not a git checkout. Run `openclaw update` from the CLI for a global reinstall.",
        notOpenclawRoot: "Run the update from an OpenClaw checkout or use the CLI global reinstall path.",
        depsInstallFailed: "Dependency install failed. Fix the install error and retry.",
        buildFailed: "Build failed. Fix the build error and retry.",
        buildDirty: "The selected revision's build changed checkout files. Retry with a revision that includes its generated artifacts.",
        uiBuildFailed: "The control UI rebuild failed. Fix the UI build error and retry.",
        globalInstallFailed: "The global package install did not verify on disk. Retry or reinstall from the CLI.",
        restartDisabled: "The update was not applied because gateway restarts are disabled. Enable restarts in config, then retry.",
        restartUnavailable: "This global install cannot be safely replaced while restarts are disabled and no supervisor is present.",
        externalSupervisorUpdateRequired: "This Gateway is managed by an external supervisor. Use your server or deployment's update workflow to update OpenClaw and restart the Gateway. The Control UI and `openclaw update` cannot update this installation. No package changes or Gateway restart were attempted.",
        restartUnhealthy: "The replacement process never became healthy. The previous process stayed up so you can recover.",
        restartRevisionMismatch: "The restarted Gateway is running a different revision. Check the service install root and retry.",
        restartRevisionUnavailable: "The restarted Gateway could not report its revision. Check the service install root and logs before retrying.",
        alreadyCurrent: "This checkout is already at its tracked upstream revision.",
        managedServiceHandoffAlreadyRunning: "Another managed update is already running. Wait for it to complete, then refresh update status.",
        managedServiceHandoffUnavailable: "Stop the foreground Gateway, run `openclaw update`, then launch it again. For automatic updates, install a managed Gateway service.",
        doctorFailed: "Doctor repair failed. Run `openclaw doctor --non-interactive` and retry.",
        managedServiceHandoffFailed: "The update helper stopped before finishing. Run `openclaw update` in the terminal to see why.",
        managedServiceHandoffSpawnFailed: "The Gateway could not start the update helper. Run `openclaw update` in the terminal instead.",
        managedServiceHandoffParentTimeout: "The Gateway stayed up too long for the update helper. Start the update again, or run `openclaw update`.",
        default: "See the gateway logs for the exact failure and retry once the cause is fixed."
      },
      failedAtStep: "The update failed at {step}: {cause}.",
      succeededVersion: "Gateway updated to v{version}.",
      succeededCommit: "Gateway updated \xB7 now on {sha}.",
      succeeded: "Gateway updated and restarted."
    },
    devices: {
      readOnly: {},
      // The trigger and load failure stay eager; dialog copy follows its lazy renderer.
      pairing: {
        button: "Pair device",
        adminRequired: "Administrator access is required to create setup codes.",
        title: "Pair a device",
        loadFailed: "Could not load the pairing dialog. Check your connection and try again."
      },
      binding: {},
      inventory: {},
      // Lazy: en-devices.ts registers this subtree when the Devices page renders chips.
      capabilities: {},
      execApprovals: {}
    },
    worktrees: {},
    agentChip: qr,
    agentScope: zr,
    newSession: {
      title: "New session",
      hint: "Pick where this session works, then say what to do.",
      placementReloadBlocked: "Recovery needs a reload. Unsaved starts will be lost.",
      discardUnsavedAndReload: "Discard unsaved starts and reload"
    },
    dashboardsPage: {},
    dashboardDocument: {
      close: "Close dashboard",
      missingSession: "No dashboard session was specified.",
      notFound: "This session could not be found.",
      unavailable: "Session dashboards are unavailable for this connection.",
      loadFailed: "Could not load this dashboard: {error}. Check the Gateway connection and try again."
    },
    sessionsView: {
      pullRequestCount: "{count} pull requests",
      subagentPrefix: "Subagent:",
      automationPrefix: "Automation:",
      actionRequiresConnection: "Connect to the Gateway to change sessions.",
      actionUnavailable: "This Gateway does not support this session action.",
      actionRequiresScope: "This action requires {scope} access.",
      actionRequiresOwnership: "Only the session creator or an admin can make this change.",
      draftCleanupFailed: "Session deleted; browser draft remains. Clear site data.",
      createdBy: "Created by {name}",
      ownedBy: "Owned by {name}",
      archivedBy: "Archived by {name}",
      viewingNow: "viewing now",
      owners: "Owners",
      allOwners: "All owners",
      involvingMe: "Involving me",
      withParticipant: "with {name}",
      withMoreParticipants: "+{count} more",
      snoozeWakes: "Wakes {time}",
      snoozeTomorrowTime: "tomorrow {time}",
      user: "User",
      assistant: "Assistant",
      opensAsDashboard: "Opens as dashboard",
      approvalNeeded: "Approval needed",
      messageNeedsAttention: "{count} message needs attention",
      messagesNeedAttention: "{count} messages need attention",
      unsentDraft: "Unsent draft",
      noArchivedSessions: "No archived sessions.",
      status: "Status",
      statusLive: "Live",
      statusIdle: "Idle",
      statusUnknown: "Unknown",
      statusQueued: "Queued",
      statusRunning: "Running",
      statusDone: "Done",
      statusFailed: "Failed",
      statusInterrupted: "Interrupted",
      statusKilled: "Killed",
      statusTimeout: "Timed out",
      waitingForAnswer: "Waiting for your answer",
      waitingForApproval: "Waiting for approval",
      questionsNeedAnswer: "{count} questions need your answer",
      approvalsNeedApproval: "{count} requests need approval",
      attentionMore: "+{count} more",
      runFailedReason: "Run failed: {reason}",
      childRunFailedReason: "Child session {label} failed: {reason}",
      runErrorTimedOut: "Timed out",
      runErrorUnknown: "Unknown error",
      attentionRequired: "Session needs attention",
      openSession: "Open session",
      provider: "Provider",
      lastActive: "Last active {time}",
      activeRun: "Active run",
      subagentsWorking: "Subagents working",
      showChildSessions: "Show {count} child sessions for {session}",
      hideChildSessions: "Hide {count} child sessions for {session}",
      childSessions: "Child sessions",
      showMoreChildren: "Show {count} more",
      archived: "Archived",
      unread: "Unread",
      automationAttached: "Automation attached",
      incognito: "Incognito session",
      incognitoLabel: "Incognito",
      incognitoDescription: "Incognito session. History expires 24 hours after creation or when the Gateway restarts, whichever comes first.",
      incognitoLimits: "Your model provider still processes messages. Tools, plugins, and uploads may save data.",
      cloudWorkerPlacement: "Placement: {state}",
      placementWorkspaceConflict: "{placement} \xB7 1 workspace conflict",
      placementWorkspaceConflicts: "{placement} \xB7 {count} workspace conflicts",
      cloudWorkerDiskWarning: "Cloud session disk space is low",
      cloudWorkerDiskCritical: "Cloud session disk space is critically low",
      cloudWorkerDescendantConflict: "Cloud worker child: 1 workspace conflict",
      cloudWorkerDescendantConflicts: "Cloud worker children: {count} workspace conflicts",
      sessionColor: "Session color: {color}",
      colors: {
        red: "Red",
        blue: "Blue",
        green: "Green",
        yellow: "Yellow",
        purple: "Purple",
        orange: "Orange",
        pink: "Pink",
        cyan: "Cyan"
      },
      pinSession: "Pin session",
      unpinSession: "Unpin session",
      forkedSession: "Forked session",
      archiveSession: "Archive session",
      restoreSession: "Restore session",
      deleteSessionStale: {},
      deleteSessionIdentityMissing: 'Cannot queue deletion of "{session}" without its session identity. Refresh after reconnecting and try again.',
      deleteSessionsStale: {},
      groupMenu: "Group options for {group}",
      groupOptions: "Group options",
      newSessionInGroup: "New session in {group}",
      groupDefaultsStale: "Gateway connection replaced before the defaults were saved. Try again.",
      moveToTopLevel: "Move to top level"
    },
    agents: {
      noAgents: "No agents",
      createdBy: {},
      defaults: {},
      copyId: {},
      default: "Default",
      setDefault: {},
      ...$r,
      selectTitle: {},
      selectSubtitle: {},
      tabs: {},
      context: {},
      identity: {},
      overview: {
        title: {},
        subtitle: {},
        selectedSkills: "{count} selected",
        allSkills: "all skills",
        unsavedConfig: {},
        modelSelection: {},
        primaryModel: {},
        primaryModelDefault: {},
        notSet: {},
        inheritDefault: {},
        inheritDefaultModel: {},
        fallbacks: {},
        addFallback: {}
      },
      toolCatalog: {},
      skillsPanel: {},
      channels: {},
      cronPanel: {},
      files: {}
    },
    debug: {
      lanes: {},
      overlay: {
        title: "System busyness"
      }
    },
    configForm: {
      hideValue: "Hide value",
      revealValue: "Reveal value",
      defaultValue: "Default: {value}",
      sections: {}
    },
    // Historical namespace from the pre-restructure "quick settings" page; its
    // keys now serve Models, Privacy & Security, Appearance, and Profile.
    // Renaming would force retranslation of every key, so the name stays.
    quickSettings: {
      appearance: {
        lobsterVisits: "Lobster visits"
      },
      personal: {
        browserOnly: "Stored in this browser only."
      }
    },
    configPage: {},
    configView: {
      adminRequired: "Configuration changes require operator.admin access.",
      categories: {},
      sections: {},
      themes: {},
      textSizes: {},
      notifications: {},
      appearance: {},
      chatPrefs: {},
      sidebarPrefs: {},
      sessionObserver: {},
      connection: {},
      fileOpenedOnGateway: "Configuration file opened on Gateway host.",
      recoveryNotRestored: "Settings could not be restored. Your draft is kept. Check {path} before saving again.",
      recoveryUnknown: "Settings restoration could not be confirmed. Your draft is kept. Check {path} before saving again.",
      recoveryBackup: "Inspect the recovery backup at {path}.",
      discardUnconfirmed: "The last save could not be confirmed. Your draft is kept. Reload configuration before discarding this setting.",
      writeGatewayChanged: "This unsettled change belongs to a different Gateway. Reconnect to that Gateway to retry, or discard the draft.",
      writeUnconfirmed: "The last configuration change could not be confirmed. Your draft is kept. Retry before changing other settings.",
      reloadBlocked: "Finish saving or discard pending config changes before reloading.",
      rawDraftBlocksApply: "Save or discard edits in the Raw editor before applying changes.",
      rawDraftBlocksFormEdit: "Unsaved raw config edits could not be parsed; resolve them in the Raw editor before changing settings.",
      rawDraftUnverified: "Cannot verify the raw draft against the saved configuration; reload and retry."
    },
    execApproval: {
      scope: {
        standingGrant: 'Always allow runs this exact command for "{automation}" without asking, until revoked (revocable)',
        standingGrantDays: 'Always allow runs this exact command for "{automation}" without asking, for {count} days (revocable)',
        messageSend: "Sends to {count} recipient(s) via {target}",
        payment: "Pays {amount} {currency} to {target}",
        externalPost: "Posts externally to {target}"
      },
      agentPendingOne: "{count} pending approval",
      agentPending: "{count} pending approvals",
      reviewOnly: "Review only. Sign in with approval access to record a decision.",
      labels: {}
    },
    approvalPage: {},
    agentTools: {},
    skillGroups: {},
    skillsPage: {},
    skillStatus: {},
    nav: {
      gateway: {
        sectionLabel: "Gateway",
        menuLabel: "Gateway: {gateway}",
        primaryTag: "primary",
        setPrimary: "Set as primary\u2026",
        openSettings: "Gateway settings",
        connected: "Connected",
        unreachable: "Unreachable",
        unknown: "Unknown status"
      },
      owner: "Owner",
      back: "Back",
      forward: "Forward",
      settings: "Settings",
      askOpenClaw: "Ask OpenClaw",
      askBrand: "Ask {brand}",
      settingsGroupDevice: "This Mac",
      settingsGroupThisComputer: "This computer",
      settingsGroupThisIPhone: "This iPhone",
      settingsGroupThisIPad: "This iPad",
      settingsGroupThisDevice: "This device",
      settingsGroupConnections: "Connections",
      settingsGroupAgents: "Agents & Tools",
      settingsGroupSecurity: "Privacy & Security",
      settingsGroupSystem: "System",
      settingsSearchLabel: "Search settings",
      settingsSearchPlaceholder: "Search settings\u2026",
      settingsSearchNoResults: "No matching settings.",
      settingsSearchClear: "Clear settings search",
      settingsLoadFailed: "Settings navigation could not load.",
      exitSettings: "Back to app",
      expand: "Expand sidebar",
      collapse: "Collapse sidebar",
      resize: "Resize sidebar",
      more: "More",
      home: "Home",
      pages: "Pages",
      pin: "Pin",
      unpin: "Unpin",
      customize: "Edit pinned items",
      customizeReset: "Reset pinned items",
      workboardGroup: "WorkBoard"
    },
    terminal: {
      title: "Terminal",
      toggle: "Toggle terminal",
      open: "Open terminal",
      startCancelled: "Terminal start was cancelled. Try again.",
      unavailable: "The terminal is not available on this gateway."
    },
    browser: {
      nativeTab: {},
      remoteTab: {},
      stop: {},
      profile: {},
      title: "Browser",
      open: "Open",
      openPanel: "Open browser panel",
      moreActions: "More actions",
      copyUrl: "Copy URL",
      openNewTab: "Open in new tab",
      openWithinOpenClaw: "Open in OpenClaw",
      toggle: "Toggle browser panel",
      close: {},
      resize: {},
      newTab: "New tab",
      closeTab: "Close tab",
      untitledTab: {},
      tweetPost: "Post on X",
      openPost: "Open post",
      back: {},
      forward: {},
      reload: {},
      openExternal: "Open in your browser",
      urlPlaceholder: {},
      dockBottom: {},
      dockRight: {},
      annotate: {},
      inspect: {},
      annotateSend: {},
      annotateUndo: {},
      annotateClear: {},
      annotateDone: {},
      annotateHint: {},
      inspectName: {},
      inspectRole: {},
      inspectFocusable: {},
      loading: {},
      notRunning: {},
      start: {},
      errors: {},
      annotatePrompt: {}
    },
    desktop: {
      title: "Desktop",
      openWindow: "Open desktop in new window",
      unavailable: "Desktop viewing is unavailable for this connection.",
      toggle: "Toggle desktop panel",
      reconnect: "Reconnect",
      connecting: "Connecting to desktop\u2026"
    },
    systems: {},
    routeTitles: {
      modelProviders: "Models",
      notifications: "Notifications",
      advanced: "Advanced"
    },
    tabs: {
      device: "This Mac",
      devicePermissions: "Permissions",
      agentsHome: "Agents",
      agents: "Agents",
      activity: "Activity",
      meetings: "Meetings",
      apps: "Apps",
      portals: "Portals",
      approvals: "Approvals",
      workboard: "Workboard",
      worktrees: "Worktrees",
      channels: "Channels",
      connection: "Gateway",
      sessions: "Sessions",
      systems: "Systems",
      usage: "Usage",
      cron: "Automations",
      skills: "Skills",
      plugins: "Plugins",
      skillWorkshop: "Skill workshop",
      devices: "Devices",
      claws: "Claws",
      cloudWorkers: "Cloud environments",
      chat: "Chat",
      dashboards: "Dashboards",
      custodian: "OpenClaw",
      profile: "Profile",
      communications: "Communications",
      appearance: "Appearance",
      lobsterdex: "Lobsterdex",
      automation: "Automation",
      mcp: "MCP",
      memory: "Memory",
      search: "Search",
      talk: "Talk",
      infrastructure: "Infrastructure",
      labs: "Labs",
      updates: "Updates",
      about: "About",
      aiAgents: "Agent Defaults",
      modelSetup: "Model Setup",
      memoryImport: "Import Memory",
      security: "Privacy & Security",
      secrets: "Secrets",
      debug: "Debug",
      logs: "Logs",
      plugin: "Plugin"
    },
    subtitles: {},
    meetingCapture: {
      title: "Meeting capture",
      description: "Choose which sources can save meeting notes on this Gateway.",
      sources: "Auto-start sources"
    },
    cloudWorkersPage: {},
    portalsPage: {},
    modelSetup: {
      discovery: {},
      missingAuth: "No provider credential is configured for this model. Set it up in Model Setup.",
      commandHint: "Try /models or /help.",
      heading: {},
      intro: {},
      required: {
        title: "No AI provider configured",
        body: "Connect a provider and choose a model to send messages.",
        action: "Connect an AI provider"
      },
      loading: {},
      testing: {},
      retry: {},
      checkAgain: {},
      recovery: {},
      verify: {},
      access: {},
      candidates: {
        title: {},
        recommended: {},
        credentialsReady: {},
        signInNeeded: "Sign-in needed",
        detected: {},
        testAndUse: {},
        retry: {},
        testingButton: {}
      },
      nativeDiscovery: {},
      nativeModels: {},
      empty: {},
      signIn: {},
      prepare: {},
      manual: {},
      success: {},
      utility: {},
      failure: {
        auth: "Authentication failed"
      },
      failureGuidance: {
        auth: "Review the provider credential or sign-in, then retry."
      },
      errors: {},
      wizard: {},
      waitingForApproval: {},
      providerConnected: {}
    },
    memoryImport: {},
    onboarding: {
      memoryImport: {
        title: "Bring your assistant memory with you"
      }
    },
    assistantPanel: {
      title: "Assistant sidebar",
      home: "Home",
      toggle: "Talk to your Home agent",
      openHome: "Open Home full page",
      close: "Close assistant sidebar",
      resize: "Resize assistant sidebar",
      dockBottom: "Dock assistant sidebar at bottom",
      dockRight: "Dock assistant sidebar at right",
      contextOff: "Work context off"
    },
    custodian: {
      title: {},
      subtitleCaretaker: {},
      exitSetup: {},
      newAgent: "New agent",
      hatchDraft: {},
      placeholder: {},
      sensitivePlaceholder: {},
      sensitiveReply: {},
      cancel: {},
      send: {},
      thinking: {},
      earlier: {},
      requestFailed: {},
      connectionChanged: {},
      sessionRestarted: {},
      unsupportedGateway: {},
      accessRequired: {},
      autoSetup: { thisComputer: "This computer" },
      panel: {},
      history: {},
      nudge: {}
    },
    mcpServers: {},
    mcpPage: {},
    talkPage: {},
    memoryPage: {},
    sessionsPage: {
      hubTablistLabel: "Session sections"
    },
    pluginsPage: {
      installed: "Installed",
      official: "Official",
      install: "Install"
    },
    labsPage: {
      intro: "Labs contains experimental capabilities that may change, break, or disappear between releases.",
      sectionTitle: "Experimental features",
      sectionDescription: "Changes save without restarting the Gateway. Code Mode and Tool Search apply to future agent runs.",
      documentation: "Documentation",
      restartRequired: "Gateway restart required.",
      saveErrorTitle: "Could not update feature",
      saveFailed: "The feature setting could not be saved.",
      decisionAssistance: {},
      codeMode: {},
      swarm: {
        title: "Swarm",
        defaultPhase: "Unphased"
      },
      toolSearch: {},
      customPluginUi: {},
      hostDesktop: {},
      workerDesktop: {}
    },
    aboutPage: {
      artifactDetails: "Control UI build details",
      commit: "Commit",
      built: "Built",
      unavailable: "Unavailable",
      copyCommit: "Copy full commit hash",
      copiedCommit: "Commit hash copied",
      gateway: "Gateway"
    },
    appsPage: {},
    presence: {
      sharedOwner: {
        name: "Shared owner",
        named: "{name} \xB7 Shared owner",
        hint: "Connected with the Gateway token or over a tunnel, not a personal sign-in."
      },
      rosterTitle: "Online",
      usersTitle: "Users",
      allUsers: "All users",
      directoryFailed: "Could not load all users. Retry",
      filters: {
        label: "Filter & sort people",
        noMatches: "No people match this filter",
        presence: "Active people first",
        reset: "Reset to defaults",
        running: "Running sessions",
        total: "Total sessions",
        name: "Name"
      },
      active: "Active",
      onlineActive: "Online \xB7 Active",
      onlineIdle: "Online \xB7 Idle",
      idle: "Idle",
      offline: "Offline",
      sessions: {
        openCount: "{count}\xA0open",
        runningCount: "{count}\xA0running",
        openHint: "Owned, unarchived conversations you can access across agents. Excludes hidden subagents, automation, and system sessions.",
        runningHint: "Open sessions actively executing an agent turn. Queued work is not running.",
        counts: "{open} open sessions, {running} running",
        unavailable: "Session counts unavailable",
        retry: "Counts may be out of date. Retry"
      },
      card: {
        details: "Details for {name}",
        loadFailed: "Could not open details. Try again, or open this person\u2019s Activity page.",
        ariaLabel: "Activity for {name}",
        person: "Person",
        onlineFor: "Online for",
        where: "Where",
        reportedTimeZone: "Reported time zone: {zone}",
        lastActivity: "Last interaction",
        notObserved: "Activity unavailable",
        viewingNow: "Viewing now",
        recentSessions: "Recent sessions",
        noVisibleSessions: "No visible sessions being viewed.",
        noRecentSessions: "No recent visible sessions.",
        sessionUpdated: "Session updated",
        ago: "ago",
        viewActivity: "View activity",
        web: "Web app",
        cli: "Command line",
        terminal: "Terminal",
        app: "App"
      }
    },
    activityFeed: {
      showing: "Showing {shown} of {total}",
      viewingNow: "Viewing now"
    },
    githubPublication: {
      newAction: "Choose a new publication",
      capacity: 'Too many publications are awaiting review. Finish an existing publication, then select "{newAction}" to make room. Existing retries remain available.'
    },
    githubConnections: {
      title: "GitHub connections",
      mine: "My GitHub",
      system: "System GitHub",
      forMe: "For me",
      forSystem: "For the system"
    },
    profilePage: {
      personalInstructions: {
        title: "Personal instructions",
        description: "Tell this agent about you and how you like to work. This edits only your personal USER.md, not the shared workspace file."
      },
      offline: "Connect to the gateway to meet your agent.",
      access: {},
      usageStatistics: "Usage statistics",
      usageStatisticsDescription: "View activity, costs, and usage trends.",
      identity: {
        title: "Identity",
        menuLabel: "Identity menu",
        menuButtonLabel: "Identity and app menu for {name}",
        description: "Your profile on this gateway.",
        avatar: "Avatar",
        chooseAvatar: "Choose image",
        displayName: "Display name",
        linkedEmails: "Linked emails"
      },
      modelAccounts: {}
    },
    skillWorkshop: {},
    // Chat swarm summaries render before the lazy Activity catalog loads.
    // Keep their shared label in startup English; Activity replaces the full namespace on entry.
    activity: {
      status: {
        done: "Done"
      }
    },
    gatewayLogs: {},
    pluginTabs: {
      unavailableTitle: "Plugin panel unavailable",
      unavailableSubtitle: "The plugin that owns this tab is not active on the connected gateway, or it did not provide a panel."
    },
    logbook: {},
    board: {
      announcement: {},
      widget: {
        resizeHandle: "Resize {title}",
        menuLabel: "Widget options",
        moveToTab: "Move to tab",
        noOtherTabs: "No other tabs",
        resize: "Resize",
        autoHeight: "Auto height",
        remove: "Delete"
      }
    },
    connection: {
      browserSignIn: {
        title: "Sign in to continue loading content",
        description: "Your website sign-in has expired. Images and files cannot load until you sign in again. Your conversation and draft will stay open.",
        action: "Sign in",
        dismiss: "Not now",
        returnHint: {},
        checkAgain: {},
        checking: {},
        stillRequired: {},
        unavailable: {}
      },
      connecting: "Connecting\u2026",
      starting: "Starting\u2026",
      restoring: "Restoring\u2026",
      "reload-required": "Refresh required",
      offline: "Disconnected",
      reconnecting: "Reconnecting\u2026",
      interruptedRetrying: "Connection to the Gateway was interrupted. Reconnecting automatically. (WebSocket {code})",
      interrupted: "Connection to the Gateway was interrupted. Check your connection and try again. (WebSocket {code})",
      restarting: "Restarting\u2026",
      suspending: "Suspending\u2026",
      suspended: "Suspended",
      retryNow: "Retry now",
      queued: "{count} queued",
      offlineChangesDiscarded: "Offline changes discarded: {count}",
      offlineChangesReloadBlocked: "Offline changes are waiting to reconnect. Reloading would discard them.",
      sessionMoveRefreshFailed: "The session move was saved, but refreshing the list failed: {error}",
      sessionMoveUncertain: "The session move could not be confirmed. Refresh and check its group before retrying. {error}",
      sessionOperationCompletedPreviousConnection: "The session operation completed on the previous connection. Check the current session list before continuing.",
      sessionOperationCompletedPreviousConnectionWithRefreshError: "The session operation completed on the previous connection, but refreshing the current session list failed: {error}",
      scopeUpgrade: {},
      // Settings → Gateway copy lives in the lazy en-settings catalog; the anchor keeps its merge target.
      access: {},
      switchGateway: {},
      help: {
        title: {},
        step1: {},
        step2: {},
        step3: {},
        docsLink: {},
        copyCommand: "Copy command",
        copyCommandAria: "Copy command: {command}"
      }
    },
    // The Inbox loader renders before its diagnostics catalog loads.
    attention: {
      issues: "Inbox"
    },
    standingGrants: {},
    approvalHistory: {},
    commandPalette: {},
    palette: {
      placeholder: "Search or start a task\u2026",
      attachmentPrompt: "What would you like to do with these files?",
      categories: { navigation: "Navigation" }
    },
    dreaming: {},
    modelProviders: {},
    searchPage: {},
    usage: {
      common: {
        emptyValue: "\u2014",
        unknown: "unknown",
        atLeast: "\u2265 {value}",
        approx: "\u2248 {value}"
      },
      loading: {
        title: "Usage Overview",
        badge: "Loading"
      },
      metrics: {
        tokens: "Tokens",
        cost: "Cost",
        session: "session",
        sessions: "sessions"
      },
      heatmap: {
        title: "Token Activity",
        subtitle: "Daily token intensity for the selected range, up to one year.",
        cellTokens: "{tokens} tokens",
        less: "Less",
        more: "More"
      },
      providerUsage: {
        title: "Provider plans & billing",
        subtitle: "Live plan, quota, balance, and budget data reported by configured providers.",
        stalled: "Provider usage did not finish loading. Refresh to retry.",
        unavailable: "Provider usage is unavailable; the last request failed. Refresh to retry.",
        balance: "Balance",
        spend: "Usage",
        budget: "Budget",
        today: "Today",
        last7Days: "7 days",
        lastDays: "{count} days",
        dailyCost: "Daily provider cost",
        requests: "{count} requests",
        inputTokens: "{count} input",
        cacheTokens: "{count} cache",
        outputTokens: "{count} output",
        topModels: "Top models",
        costCategories: "Cost categories",
        remaining: "{percent}% left",
        resets: "Resets {date}",
        exhausted: "{label} is used up.",
        checkFailed: "Check failed",
        exhaustedUntil: "{label} is used up until {date}."
      },
      presets: {},
      scope: {},
      filters: {},
      query: {},
      export: {},
      cacheStatus: {},
      empty: {},
      daily: {},
      costWindows: {},
      breakdown: {
        output: "Output",
        input: "Input",
        cacheWrite: "Cache Write",
        cacheRead: "Cache Read",
        total: "Total",
        tokensByType: "Tokens by Type",
        costByType: "Cost by Type"
      },
      overview: {
        title: "Usage Overview"
      },
      sessions: {},
      // Sidebar collapse stays eager; Usage registers the remaining detail copy.
      details: {
        noUsageData: {},
        duration: {},
        modelMix: {},
        filtered: {},
        close: {},
        noTimeline: {},
        loadFailed: {},
        noDataInRange: {},
        usageOverTime: {},
        rangeStart: {},
        rangeEnd: {},
        reset: {},
        perTurn: {},
        cumulative: {},
        turnRange: {},
        assistantOutputTokens: {},
        userToolInputTokens: {},
        tokensWrittenToCache: {},
        tokensReadFromCache: {},
        noContextData: {},
        contextOutOfDate: {},
        systemPromptBreakdown: {},
        collapse: "Collapse",
        collapseAll: {},
        expandAll: {},
        baseContextPerMessage: {},
        system: {},
        systemShort: {},
        skills: {},
        tools: {},
        files: {},
        ofInput: {},
        of: {},
        timelineFiltered: {},
        loadedIntervalMessages: {},
        conversation: {},
        noMessages: {},
        tool: {},
        toolResult: {},
        hasTools: {},
        searchConversation: {},
        filterByRole: {},
        filterByTool: {},
        you: {},
        noMessagesMatch: {}
      },
      mosaic: {}
    },
    // Login copy lives in the lazy en-login catalog; the anchor keeps its merge target.
    login: {},
    chat: {
      sessionAutomation: {},
      activityPills: {},
      mobileDetails: {
        people: "People",
        outputs: "Outputs",
        generatedFiles: "Generated files"
      },
      sessionDetails: {
        automations: "Automations",
        progressOptions: "Task progress options",
        automationError: "Couldn't load automations.",
        automationUnavailable: "Automations unavailable for this session.",
        automationLoading: "Loading automations\u2026",
        automationEmpty: "No automations for this session",
        automationMore: "Load more automations",
        automationAttention: "Needs attention",
        automationPaused: "Paused",
        automationEnabled: "Enabled"
      },
      agentDatabaseWarming: "This agent is still starting. Retry in a moment.",
      historyRequestTimedOut: "Chat history request timed out. Retry to load the conversation.",
      clawhub: {},
      modelAccounts: {
        section: "Account",
        automatic: "Automatic (new-chat default)",
        manage: "Manage saved accounts\u2026"
      },
      mentions: {},
      cloudWorkerFailed: "Runner failed: {error}",
      errorDetails: "Error details",
      errorReplySummary: "Couldn't finish this reply. Check the conversation before trying again.",
      errorReplyTitle: "Couldn\u2019t finish this reply",
      historyUnavailableTitle: "Couldn\u2019t load this conversation",
      historyUnavailableBody: "Try again to load its messages.",
      recovery: {
        retrying: "Retrying\u2026",
        retryingIn: "Retrying in {seconds}s",
        tryingFallback: "Trying fallback model\u2026",
        failedTitle: "Unable to finish this reply",
        failedRepeatCount: "{count} times",
        failedHelp: "Automatic recovery has stopped. Check any completed work before trying again.",
        tryAgain: "Try again",
        continuePrompt: "Continue from where you stopped. Check which actions already completed before retrying anything."
      },
      errorBusySummary: "OpenClaw is busy. Check status before trying again.",
      errorSignInSummary: "Couldn't sign in to the AI service. Sign in again under Models.",
      errorStartSummary: "Couldn't start this conversation. Open Settings \u2192 Logs for details.",
      checkStatus: "Check status",
      details: "Details",
      usageLimit: {},
      copyError: "Copy error",
      providerAccessRemoved: "This reply stopped because the provider was signed out. Sign in again or choose another model.",
      providerReview: {},
      providerPolicy: {},
      diskSpace: {},
      workerRuntimeInstall: {},
      sendErrors: {},
      waitingForApproval: "Waiting for approval\u2026",
      waitingOnSubagents: "Waiting on subagents",
      waitingForMessage: "Waiting for a message",
      waitingOnSubagent: "Waiting on {name}",
      subagentsRunning: "{count} subagents running",
      subagentsRunningOne: "1 subagent running",
      startupStatus: {
        preparingWorkspace: "Preparing workspace\u2026",
        namingWorktree: "Naming worktree\u2026",
        updatingRepository: "Updating repository\u2026",
        creatingWorktree: "Creating worktree\u2026",
        runningSetup: "Running setup\u2026",
        provisioningEnvironment: "Provisioning environment\u2026",
        startingFromSnapshot: "Starting from snapshot\u2026",
        preparingCloudEnvironment: "Preparing cloud environment\u2026",
        savingSnapshot: "Saving snapshot\u2026",
        preparingContext: "Preparing this turn\u2026",
        waitingForTurn: "Waiting for turn to start\u2026",
        memoryFlushing: "Saving conversation memory\u2026",
        startingModel: "Waiting for a response",
        waitingForLocalModel: "Waiting for the local model to respond",
        waitingForModelSlot: "Waiting for a free model slot",
        waitingForState: "Temporarily busy\u2014retrying\u2026"
      },
      archivedSessionDisabled: "This session is archived. Unarchive it to continue the conversation.",
      subagentViewOnly: "View-only subagent",
      subagentSessionDisabled: "Continue in {parent}.",
      processesPanel: { title: "Processes", refresh: "Refresh processes" },
      subagentsPanel: {},
      parentSession: "the parent session",
      openParentSession: "Open parent session",
      parentSessionUnavailable: "Parent session information is unavailable.",
      sessionRoute: {},
      commandResults: {
        startingNewThread: "Starting new session...",
        resettingThread: "Resetting session...",
        stoppingCurrentRun: "Stopping current run...",
        chatHistoryCleared: "Chat history cleared.",
        emptyExport: "There are no messages to export yet.",
        exportPathUnsupported: "Control UI exports Markdown through your browser. Run /export without a file path.",
        help: {},
        compaction: {},
        model: {},
        thinking: {},
        verbose: {},
        fast: {
          autoValue: "auto ({seconds} sec)",
          on: "on",
          off: "off",
          sourceSession: " (session)",
          sourceAgent: " (default: agent)",
          sourceModel: " (default: model)",
          sourceDefault: " (default)",
          current: "Current fast mode: {value}"
        },
        usage: {},
        agents: {},
        steer: {},
        redirect: {}
      },
      sessionSharing: {
        draft: "Draft"
      },
      reactions: {},
      sessionSuggestions: {
        state: {}
      },
      sessionHeader: {},
      board: {},
      codexSupervisionDisabled: "Codex supervision is off. Enable it in plugin settings to continue this session.",
      openCodexSettings: "Open settings",
      catalog: {},
      taskSuggestions: {},
      pullRequests: {
        open: "Open",
        draft: "Draft",
        merged: "Merged",
        closed: "Closed"
      },
      usageRemaining: "Usage Remaining",
      view: {},
      sendShortcutModifierEnter: "\u2318/Ctrl+Enter",
      followUpModeSteer: "Steer into the active run",
      catalogOutputTruncated: "[Output truncated]",
      onboardingDisabled: "Disabled during setup",
      commandPaletteTitle: "Search or jump to\u2026 (\u2318K)",
      openCommandPalette: "Command palette",
      actions: {
        copyAsMarkdown: "Copy as markdown",
        dismissError: "Dismiss error",
        exitFocusMode: "Exit focus mode",
        scrollToLatest: "Scroll to latest"
      },
      markdown: {
        truncated: "\u2026 truncated ({total} chars, showing first {shown})."
      },
      mermaid: {},
      codeBlock: {},
      workspaceConflict: {},
      compaction: {
        label: "Compacted history",
        savedTokens: "saved {count} tokens"
      },
      sessionReset: {
        label: "Session reset",
        description: "The earlier conversation was cleared."
      },
      outboxRecoveryReviewTitle: {},
      outboxRecoveryConfirm: {},
      outboxRecoveryRestore: {},
      outboxRecoveryConflict: {},
      outboxRecoveryStorageFailed: {},
      outboxRecoveryFull: {},
      outboxRecoveryDraft: {},
      outboxRecoveryQueued: {},
      outboxRecoverySource: {},
      outboxRecoveryUpdated: {},
      outboxRecoveryGoal: {},
      outboxRecoveryReply: {},
      outboxRecoveryAttachments: {},
      outboxRecoveryUnconfirmedLabel: {},
      outboxRecoveryUnconfirmed: {},
      outboxRecoveryAttachmentMissing: {},
      outboxRecoveryDelete: {},
      outboxRecoveryDeleteTitle: {},
      outboxRecoveryDeleteConfirm: {},
      outboxRecoveryDeleteConflict: {},
      privateDraftReload: {
        blocked: "An unsent Incognito draft is keeping this tab open. Review it before refreshing.",
        review: "Review private draft",
        changed: "The draft changed while you were reviewing it. It has not been discarded; review the current draft before refreshing.",
        unavailable: "The private draft could not be opened. It remains in this tab; try Review private draft again."
      },
      incognitoExpiredTitle: "Incognito session expired",
      incognitoExpiredBody: "Incognito sessions last for 24 hours or until the Gateway restarts. Your unsent input stays in this tab.",
      newIncognitoSession: "New Incognito session",
      restartRecoveryTitle: "This task was interrupted by a restart.",
      restartRecoveryDisabled: "Your transcript is safe. Resume to continue in this session.",
      restartRecoveryNewSession: "This provider cannot safely resume tool work here. Your transcript can continue in a new session.",
      resumeSession: "Resume",
      resumeInNewSession: "Resume in new session",
      resumingSession: "Resuming\u2026",
      systemNotice: {
        guardian: {},
        restartRecovery: {},
        automationRecovery: {},
        gatewayRestarted: {},
        cliHarnessContext: {},
        claudeCliTaskNotification: {},
        pluginSteering: {}
      },
      skillLearned: {},
      progressLabels: {},
      turnRecap: {
        doneIn: "Done in {duration}",
        tokens: "{count} output tokens",
        tokensOne: "1 output token"
      },
      commands: {},
      skills: {
        menu: "Skill references",
        label: "Skills",
        loading: "Loading skills\u2026"
      },
      splitView: {
        chooseConversation: "Choose a conversation",
        missingOwner: "Select this pane, then choose Home or a conversation in the sidebar to restore it.",
        open: "Open split view",
        splitRight: "Split right",
        splitDown: "Split down",
        closePane: "Close pane",
        panePosition: "Column {column}, row {row} ({pane})",
        dropSplit: "Split",
        dropOpenHere: "Open here"
      },
      sidebar: {
        mySessions: "My sessions",
        threads: "Sessions",
        pinned: "Pinned",
        otherSessions: "Other",
        groups: "Groups",
        coding: "Coding",
        catalogViewOptions: "View options",
        reorderItem: "Reorder {item}",
        moveUp: "Move up",
        moveDown: "Move down",
        hideFromSidebar: "Hide from sidebar",
        sectionHidden: "{section} hidden.",
        sectionHiddenRecovery: "Show it again in Settings > Appearance > Sidebar.",
        catalogGroupByProject: "Project",
        catalogGroupByPerson: "Person",
        openSessionMenu: "Open session menu",
        sortBy: "Sort by",
        sortCreated: "Created",
        menuFilters: "Filters",
        menuDisplay: "Display",
        hideEmpty: "Hide empty",
        activeFilterCount: "Active filters: {count}",
        sortSessions: "Filter & sort",
        sessionSources: "Session sources",
        showAllSessions: "Show all sessions",
        noActiveSessionsForFilter: "No active sessions match this filter",
        sortUpdated: "Last updated",
        sessionMenu: "Actions for {session}",
        sessionMenuMany: "Actions for {count} sessions",
        catalogDiscoveryHelp: "{error}. Configure automatic session discovery in Settings > Appearance > Session sources.",
        catalogPaginationFailed: "Session catalog returned a repeated page cursor",
        catalogPageMissingHost: "Session catalog page did not include the requested host"
      },
      welcome: { suggestions: { whatCanYouDo: "What can you do?" } },
      runControls: {
        newSession: "New session",
        newSessionWorktree: "New session in worktree",
        exportChat: "Export chat",
        queue: "Queue",
        queueMessage: "Queue message",
        stop: "Stop",
        stopWithShortcut: "Stop (Esc)",
        stopGenerating: "Stop generating",
        send: "Send",
        sendMessage: "Send message"
      },
      queue: {},
      goals: {},
      asyncQuestions: {},
      questions: {
        showSecret: "Show secret",
        hideSecret: "Hide secret",
        answer: "Answer",
        disconnected: "Not connected. Try again after reconnecting."
      },
      imageLightbox: {},
      externalImage: { notLoaded: "External image not loaded", open: "Open image" },
      messages: {
        copySelection: "Copy",
        replyingTo: "Replying to {name}",
        message: "message",
        showLess: "Show less",
        showMore: "Show more",
        tooLargeToDisplay: "This message is too large to display here.",
        unattributedSender: "Message",
        toolSender: "Tool",
        errorSender: "Error"
      },
      mediaPlayer: {},
      youtube: {},
      modelControls: {},
      nativeRuntimeRecovery: {},
      permissionControls: {},
      rail: {},
      detailPanel: {},
      sidebarColumns: {
        close: "Close {panel}"
      },
      sidePanel: {
        context: "Context",
        contextEmpty: "Send a message to capture context usage.",
        label: "Side panel",
        quickAccess: "Quick access",
        explorePanels: "Explore panels",
        addTab: "Add side panel tab",
        closeNewTab: "Close New tab",
        closeAll: "Close all",
        closeAllTabs: "Close all tabs",
        closeOtherTabs: "Close other tabs",
        closeFileChanges: "Save changes to {file} before closing?",
        reviewFileChanges: "Open the file to review its unsaved changes before closing.",
        expand: "Focus",
        expandPanel: "Expand {panel}",
        restore: "Restore split",
        useViewAsDefault: "Use current view as default",
        currentViewIsDefault: "This is the default view",
        defaultViewDescription: "Used when anyone opens this dashboard. Personal layout choices still apply.",
        savingDefault: "Saving default\u2026",
        defaultSaved: "Dashboard default saved for future opens.",
        defaultSaveFailed: "Could not save the dashboard default. Check the connection and try again.",
        defaultSaveError: "Could not save the dashboard default: {error}",
        swap: "Swap {main} and {side}",
        layout: "Layout",
        panelPosition: "Panel position",
        dockLeft: "Move side panel left",
        dockRight: "Move side panel right",
        dockBottom: "Move side panel below",
        positionLeft: "Left",
        positionRight: "Right",
        positionBelow: "Below",
        conversation: "Chat",
        showChat: "Show this conversation",
        hideChat: "Hide this conversation",
        conversationEmpty: "The conversation for this task.",
        minimize: "Minimize side panel",
        resize: "Resize side panel",
        review: "Review",
        reviewEmpty: "Open a change, file, image, or tool result to review it here.",
        terminal: "Terminal",
        terminalEmpty: "Open a shell for this session's workspace.",
        browser: "Browser",
        browserEmpty: "A shared browser for you and the agent.",
        browserUnavailableReason: {
          permission: "You need operator.admin to use Browser.",
          disconnected: "Disconnected.",
          unavailable: "Browser unavailable."
        },
        files: "Files",
        filesEmpty: "Browse files, artifacts, and changes from this session.",
        companion: "Side chat",
        companionEmpty: "Ask a focused question about this session.",
        processes: "Processes",
        processesEmpty: "Inspect background commands and their output for this conversation.",
        subagents: "Subagents",
        subagentsEmpty: "Follow delegated work from this conversation.",
        desktop: "Desktop",
        desktopEmpty: "Connect to an available remote desktop.",
        portal: "Portal",
        portalEmpty: "Preview a web application running for this task.",
        discussion: "Discussion",
        discussionEmpty: "Open the shared discussion for this session.",
        dashboard: "Dashboard",
        dashboardOptions: "Dashboard options",
        dashboardSize: "Size",
        dashboardEmpty: "This task does not have a dashboard yet."
      },
      thread: {},
      pendingInputs: {
        agentUpdate: {}
      },
      pairingQrExpired: {
        title: "Pairing QR expired",
        reason: "Run /pair qr again to generate a fresh setup code.",
        badge: "Expired"
      },
      composer: {},
      attachments: {
        previewUnavailable: "Preview unavailable"
      },
      voice: {},
      selectors: {
        loadMoreSessions: "Show more",
        loadMoreRosterSessions: "Load more sessions",
        model: "Chat model",
        modelSection: "Model",
        modelLocked: "Locked",
        modelLockedLabel: "Model selection controlled for this session",
        lockedSessionModel: "Session model",
        thinkingLevel: "Chat thinking level"
      },
      permissions: {},
      toolCards: {
        activity: {},
        review: {},
        verbs: {}
      },
      workRun: {
        workedFor: "Worked for {duration}",
        worked: "Worked",
        toolCallsOne: "1 tool call",
        toolCallsMany: "{count} tool calls"
      },
      sessionDiff: {
        title: "Changes",
        show: "Show session changes"
      },
      sessionDiscussion: {},
      workspaceFiles: {
        copyPath: "Copy path"
      }
    },
    languages: {},
    // Navigation and in-chat secret requests render before the Secrets page loads.
    secretsStore: {
      allowedHosts: "Allowed hosts",
      allowedHostsPlaceholder: "api.example.com",
      protectedSecret: "Protected secret",
      agentReadable: "Agent-readable environment",
      hint: "Choose protected, write-only secrets or intentionally agent-readable Gateway environment values."
    },
    cron: {
      adminRequired: {},
      tabs: {},
      list: {},
      suggestions: {},
      stats: {},
      detail: {},
      actions: {},
      runNotStarted: {},
      jobs: {},
      runs: {},
      form: {},
      jobState: {},
      runEntry: {},
      errors: {}
    },
    linkReader: {
      loadingPreview: "Loading preview\u2026",
      title: "Link reader",
      urlPlaceholder: "Supported link URL"
    }
  }, he = Ca;
});

// octogee/app/openclaw-islands/i18n.ts
var Kr = T(() => {
  _n();
});

// openclaw/ui/src/lib/chat/browser-tab-preview.ts
D();
Xe();

// openclaw/ui/src/lib/chat/tool-cards.ts
yt();

// openclaw/packages/net-policy/src/url-protocol.ts
function Oo(e) {
  return e instanceof URL ? e : URL.parse(e);
}
function bt(e) {
  let n = Oo(e);
  return n?.protocol === "http:" || n?.protocol === "https:";
}

// openclaw/ui/src/lib/chat/tool-cards.ts
z();
D();
j();
me();

// openclaw/src/agents/tool-display-call.ts
D();

// openclaw/src/chat/canvas-render.ts
z();
re();
D();
j();

// openclaw/src/shared/text/code-regions.ts
z();

// openclaw/packages/markdown-core/src/reasoning-tag-parser.ts
z();
var wt = [
  "think",
  "thinking",
  "thought",
  "reasoning",
  "internal",
  "antthinking",
  "antml:think",
  "antml:thinking",
  "antml:thought",
  "antml:reasoning",
  "mm:think",
  "mm:thinking",
  "mm:thought",
  "mm:reasoning"
], Fu = new Set(wt);

// openclaw/src/chat/canvas-render.ts
function Fo(e) {
  let n = M(e?.viewId);
  if (!n || n.length > 128)
    return;
  let t = M(e?.serverName), r = M(e?.toolName), o = M(e?.uiResourceUri), i = M(e?.toolCallId), s = M(e?.originSessionKey), a = e?.resultMetaState === "unavailable" ? "unavailable" : void 0;
  return !!(t && t.length <= 256 && r && r.length <= 256 && o?.startsWith("ui://") && o.length <= 2048 && i && i.length <= 512) ? {
    viewId: n,
    serverName: t,
    toolName: r,
    uiResourceUri: o,
    toolCallId: i,
    ...s && s.length <= 512 ? { originSessionKey: s } : {},
    ...a ? { resultMetaState: a } : {}
  } : { viewId: n };
}
function Lo(e) {
  return typeof e == "number" && Number.isFinite(e) && e >= 160 ? Math.min(Math.trunc(e), 1200) : void 0;
}
function xt(e) {
  return typeof e == "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/u.test(e);
}
function Ct(e) {
  let n = N(e);
  if (!n || M(n?.kind)?.trim().toLowerCase() !== "canvas")
    return;
  let r = N(n.presentation), o = N(n.view), i = N(n.source), s = Fo(N(n.mcpApp)), a = s?.viewId, d = M(r?.target) ?? M(n?.target) ?? "assistant_message";
  if (d !== "assistant_message" && d !== "node_panel")
    return;
  let h = M(r?.title) ?? M(o?.title), g = Lo(
    te(r?.preferred_height) ?? te(r?.preferredHeight) ?? te(o?.preferred_height) ?? te(o?.preferredHeight)
  ), m = M(r?.class_name) ?? M(r?.className), c = M(r?.style), l = M(r?.sandbox), f = M(o?.url) ?? M(o?.entryUrl), p = M(o?.id) ?? M(o?.docId), y = M(o?.boardWidgetName), b = xt(y) ? y : void 0, w = {
    kind: "canvas",
    surface: d,
    render: "url",
    ...h ? { title: h } : {},
    ...g ? { preferredHeight: g } : {},
    ...l === "strict" || l === "scripts" ? { sandbox: l } : {},
    ...s ? { mcpApp: s } : {}
  };
  if (a && p === a)
    return { ...w, viewId: p };
  let R = f ?? (M(i?.type)?.trim().toLowerCase() === "url" ? M(i?.url) : void 0);
  if (R)
    return {
      ...w,
      url: R,
      ...f && p ? { viewId: p } : {},
      ...m ? { className: m } : {},
      ...c ? { style: c } : {},
      ...f && b ? { boardWidgetName: b } : {}
    };
}
function Tt(e) {
  let n = N(e);
  return Ct(n?.mcpAppPreview);
}
function St(e) {
  let n = e ? ie(e) : void 0;
  return Ct(n);
}

// openclaw/src/chat/tool-content.ts
rn();
j();
var Uo = [
  "id",
  "tool_call_id",
  "toolCallId",
  "tool_use_id",
  "toolUseId"
];
function Et(e) {
  return typeof e == "string" ? e.toLowerCase() : "";
}
function sn(e) {
  let n = Et(e);
  return n === "toolcall" || n === "tool_call" || n === "tooluse" || n === "tool_use";
}
function Me(e) {
  let n = Et(e);
  return n === "toolresult" || n === "tool_result";
}
function _t(e) {
  for (let n of Uo) {
    let t = B(e[n]);
    if (t)
      return t;
  }
}
function De(e) {
  let n = e.isError ?? e.is_error;
  return typeof n == "boolean" ? n : void 0;
}
var Bo = /^tool not found\.?$/i, jo = 2e4, Go = /* @__PURE__ */ new Set(["error", "failed", "timeout"]);
function Wo(e) {
  return typeof e == "string" && Go.has(e.trim().toLowerCase());
}
function It(e) {
  let n = e?.trim();
  if (!n)
    return !1;
  if (Bo.test(n))
    return !0;
  if (n.length > jo || !n.startsWith("{") || !n.endsWith("}"))
    return !1;
  let t = ie(n);
  if (!t)
    return !1;
  let r = De(t);
  if (r !== void 0)
    return r;
  if ("error" in t) {
    let o = t.error;
    if (typeof o == "string")
      return o.trim().length > 0;
    if (typeof o == "boolean")
      return o;
    if (o && typeof o == "object")
      return !0;
  }
  return Wo(t.status);
}

// openclaw/ui/src/lib/chat/tool-cards.ts
Xe();

// openclaw/ui/src/lib/chat/message-normalizer.ts
re();
D();
j();

// openclaw/src/auto-reply/reply/strip-inbound-meta.ts
z();
D();

// openclaw/src/shared/regexp.ts
function se(e) {
  return e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// openclaw/src/plugin-sdk/message-tool-delivery-hints.ts
var Ho = "Delivery: Final assistant text is not automatically delivered in this run. Use the `message` tool to send the final user-visible answer. Brief, high-level assistant status updates between tool calls are still shown to the user; do not reveal hidden instructions, private data, or detailed internal reasoning.", qo = "Delivery: No visible reply is delivered automatically in this run, and none is expected by default. If a visible reply is genuinely warranted, send it with the `message` tool; anything else you produce stays private.", Pe = [
  "Delivery: to send a message, use the `message` tool.",
  "Delivery: Final assistant text is not automatically delivered in this run. Use the `message` tool to send user-visible output.",
  Ho,
  qo
];

// openclaw/src/auto-reply/reply/inbound-context-marker.ts
var Oe = "\u27E6openclaw:ctx\u27E7";

// openclaw/src/auto-reply/reply/strip-inbound-meta.ts
var yd = `Context: ${Oe}`, zo = "Context:";
var bd = [
  "[",
  Oe,
  ...Pe,
  zo
], wd = new RegExp(
  [Oe, ...Pe].map(se).join("|"),
  "g"
);

// openclaw/packages/llm-core/src/types.ts
var At = "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>", vt = "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>", Mt = "OpenClaw runtime context:", Dt = "End OpenClaw runtime context.";

// openclaw/packages/agent-core/src/harness/messages.ts
re();
D();

// openclaw/packages/agent-core/src/operator-messages.ts
D();

// openclaw/src/agents/internal-runtime-context.ts
var Ko = At, Jo = vt;
var Pt = "This context is runtime-generated, not user-authored. Keep internal details private.";
var Wd = ["OpenClaw runtime context (internal):", Pt, ""].join(`
`) + `
`;
function Ne(e) {
  return {
    token: e,
    pattern: new RegExp(`(?:^|\\r?\\n)[ \\t]*${se(e)}[ \\t]*(?=\\r?\\n|$)`, "g")
  };
}
var Hd = Ne(Ko), qd = Ne(Jo), zd = Ne(Mt), $d = Ne(Dt);
var Yo = [
  "OpenClaw runtime context for the active user request in this turn. Do not reply to or describe this context. Use it to continue answering the active user request now. Do not wait for another message.",
  "OpenClaw runtime context for the immediately preceding user message.",
  "OpenClaw runtime event."
], Xo = new RegExp(
  Yo.flatMap((e) => {
    let n = e.split(". ");
    return n.map((t, r) => n.slice(r).join(". "));
  }).map((e) => e.split(/\s+/).map(se).join("\\s+")).join("|")
), Zo = new RegExp(
  Pt.split(/\s+/).map(se).join("\\s+")
), Vd = new RegExp(
  `^[ \\t]*(?:${Xo.source})\\s+${Zo.source}[ \\t]*(?:\\r?\\n|$)`,
  "gm"
);

// openclaw/src/chat/message-client-source.ts
D();
j();
me();

// openclaw/src/chat/work-context.ts
D();
me();

// openclaw/packages/markdown-core/src/image-spans.ts
z();

// openclaw/node_modules/.pnpm/mdurl@2.1.0/node_modules/mdurl/index.mjs
var an = {};
vn(an, {
  decode: () => we,
  encode: () => X,
  format: () => pe,
  parse: () => Re
});

// openclaw/node_modules/.pnpm/mdurl@2.1.0/node_modules/mdurl/lib/decode.mjs
var Ot = {};
function ei(e) {
  let n = Ot[e];
  if (n)
    return n;
  n = Ot[e] = [];
  for (let t = 0; t < 128; t++) {
    let r = String.fromCharCode(t);
    n.push(r);
  }
  for (let t = 0; t < e.length; t++) {
    let r = e.charCodeAt(t);
    n[r] = "%" + ("0" + r.toString(16).toUpperCase()).slice(-2);
  }
  return n;
}
function Fe(e, n) {
  typeof n != "string" && (n = Fe.defaultChars);
  let t = ei(n);
  return e.replace(/(%[a-f0-9]{2})+/gi, function(r) {
    let o = "";
    for (let i = 0, s = r.length; i < s; i += 3) {
      let a = parseInt(r.slice(i + 1, i + 3), 16);
      if (a < 128) {
        o += t[a];
        continue;
      }
      if ((a & 224) === 192 && i + 3 < s) {
        let u = parseInt(r.slice(i + 4, i + 6), 16);
        if ((u & 192) === 128) {
          let d = a << 6 & 1984 | u & 63;
          d < 128 ? o += "\uFFFD\uFFFD" : o += String.fromCharCode(d), i += 3;
          continue;
        }
      }
      if ((a & 240) === 224 && i + 6 < s) {
        let u = parseInt(r.slice(i + 4, i + 6), 16), d = parseInt(r.slice(i + 7, i + 9), 16);
        if ((u & 192) === 128 && (d & 192) === 128) {
          let h = a << 12 & 61440 | u << 6 & 4032 | d & 63;
          h < 2048 || h >= 55296 && h <= 57343 ? o += "\uFFFD\uFFFD\uFFFD" : o += String.fromCharCode(h), i += 6;
          continue;
        }
      }
      if ((a & 248) === 240 && i + 9 < s) {
        let u = parseInt(r.slice(i + 4, i + 6), 16), d = parseInt(r.slice(i + 7, i + 9), 16), h = parseInt(r.slice(i + 10, i + 12), 16);
        if ((u & 192) === 128 && (d & 192) === 128 && (h & 192) === 128) {
          let g = a << 18 & 1835008 | u << 12 & 258048 | d << 6 & 4032 | h & 63;
          g < 65536 || g > 1114111 ? o += "\uFFFD\uFFFD\uFFFD\uFFFD" : (g -= 65536, o += String.fromCharCode(55296 + (g >> 10), 56320 + (g & 1023))), i += 9;
          continue;
        }
      }
      o += "\uFFFD";
    }
    return o;
  });
}
Fe.defaultChars = ";/?:@&=+$,#";
Fe.componentChars = "";
var we = Fe;

// openclaw/node_modules/.pnpm/mdurl@2.1.0/node_modules/mdurl/lib/encode.mjs
var Nt = {};
function ni(e) {
  let n = Nt[e];
  if (n)
    return n;
  n = Nt[e] = [];
  for (let t = 0; t < 128; t++) {
    let r = String.fromCharCode(t);
    /^[0-9a-z]$/i.test(r) ? n.push(r) : n.push("%" + ("0" + t.toString(16).toUpperCase()).slice(-2));
  }
  for (let t = 0; t < e.length; t++)
    n[e.charCodeAt(t)] = e[t];
  return n;
}
function Le(e, n, t) {
  typeof n != "string" && (t = n, n = Le.defaultChars), typeof t > "u" && (t = !0);
  let r = ni(n), o = "";
  for (let i = 0, s = e.length; i < s; i++) {
    let a = e.charCodeAt(i);
    if (t && a === 37 && i + 2 < s && /^[0-9a-f]{2}$/i.test(e.slice(i + 1, i + 3))) {
      o += e.slice(i, i + 3), i += 2;
      continue;
    }
    if (a < 128) {
      o += r[a];
      continue;
    }
    if (a >= 55296 && a <= 57343) {
      if (a >= 55296 && a <= 56319 && i + 1 < s) {
        let u = e.charCodeAt(i + 1);
        if (u >= 56320 && u <= 57343) {
          o += encodeURIComponent(e[i] + e[i + 1]), i++;
          continue;
        }
      }
      o += "%EF%BF%BD";
      continue;
    }
    o += encodeURIComponent(e[i]);
  }
  return o;
}
Le.defaultChars = ";/?:@&=+$,-_.!~*'()#";
Le.componentChars = "-_.!~*'()";
var X = Le;

// openclaw/node_modules/.pnpm/mdurl@2.1.0/node_modules/mdurl/lib/format.mjs
function pe(e) {
  let n = "";
  return n += e.protocol || "", n += e.slashes ? "//" : "", n += e.auth ? e.auth + "@" : "", e.hostname && e.hostname.indexOf(":") !== -1 ? n += "[" + e.hostname + "]" : n += e.hostname || "", n += e.port ? ":" + e.port : "", n += e.pathname || "", n += e.search || "", n += e.hash || "", n;
}

// openclaw/node_modules/.pnpm/mdurl@2.1.0/node_modules/mdurl/lib/parse.mjs
function Ue() {
  this.protocol = null, this.slashes = null, this.auth = null, this.port = null, this.hostname = null, this.hash = null, this.search = null, this.pathname = null;
}
var ti = /^([a-z0-9.+-]+:)/i, ri = /:[0-9]*$/, oi = /^(\/\/?(?!\/)[^\?\s]*)(\?[^\s]*)?$/, ii = ["<", ">", '"', "`", " ", "\r", `
`, "	"], si = ["{", "}", "|", "\\", "^", "`"].concat(ii), ai = ["'"].concat(si), Ft = ["%", "/", "?", ";", "#"].concat(ai), Lt = ["/", "?", "#"], ci = 255, Ut = /^[+a-z0-9A-Z_-]{0,63}$/, li = /^([+a-z0-9A-Z_-]{0,63})(.*)$/, Bt = {
  javascript: !0,
  "javascript:": !0
}, jt = {
  http: !0,
  https: !0,
  ftp: !0,
  gopher: !0,
  file: !0,
  "http:": !0,
  "https:": !0,
  "ftp:": !0,
  "gopher:": !0,
  "file:": !0
};
function ui(e, n) {
  if (e && e instanceof Ue) return e;
  let t = new Ue();
  return t.parse(e, n), t;
}
Ue.prototype.parse = function(e, n) {
  let t, r, o, i = e;
  if (i = i.trim(), !n && e.split("#").length === 1) {
    let d = oi.exec(i);
    if (d)
      return this.pathname = d[1], d[2] && (this.search = d[2]), this;
  }
  let s = ti.exec(i);
  if (s && (s = s[0], t = s.toLowerCase(), this.protocol = s, i = i.substr(s.length)), (n || s || i.match(/^\/\/[^@\/]+@[^@\/]+/)) && (o = i.substr(0, 2) === "//", o && !(s && Bt[s]) && (i = i.substr(2), this.slashes = !0)), !Bt[s] && (o || s && !jt[s])) {
    let d = -1;
    for (let l = 0; l < Lt.length; l++)
      r = i.indexOf(Lt[l]), r !== -1 && (d === -1 || r < d) && (d = r);
    let h, g;
    d === -1 ? g = i.lastIndexOf("@") : g = i.lastIndexOf("@", d), g !== -1 && (h = i.slice(0, g), i = i.slice(g + 1), this.auth = h), d = -1;
    for (let l = 0; l < Ft.length; l++)
      r = i.indexOf(Ft[l]), r !== -1 && (d === -1 || r < d) && (d = r);
    d === -1 && (d = i.length), i[d - 1] === ":" && d--;
    let m = i.slice(0, d);
    i = i.slice(d), this.parseHost(m), this.hostname = this.hostname || "";
    let c = this.hostname[0] === "[" && this.hostname[this.hostname.length - 1] === "]";
    if (!c) {
      let l = this.hostname.split(/\./);
      for (let f = 0, p = l.length; f < p; f++) {
        let y = l[f];
        if (y && !y.match(Ut)) {
          let b = "";
          for (let w = 0, R = y.length; w < R; w++)
            y.charCodeAt(w) > 127 ? b += "x" : b += y[w];
          if (!b.match(Ut)) {
            let w = l.slice(0, f), R = l.slice(f + 1), k = y.match(li);
            k && (w.push(k[1]), R.unshift(k[2])), R.length && (i = R.join(".") + i), this.hostname = w.join(".");
            break;
          }
        }
      }
    }
    this.hostname.length > ci && (this.hostname = ""), c && (this.hostname = this.hostname.substr(1, this.hostname.length - 2));
  }
  let a = i.indexOf("#");
  a !== -1 && (this.hash = i.substr(a), i = i.slice(0, a));
  let u = i.indexOf("?");
  return u !== -1 && (this.search = i.substr(u), i = i.slice(0, u)), i && (this.pathname = i), jt[t] && this.hostname && !this.pathname && (this.pathname = ""), this;
};
Ue.prototype.parseHost = function(e) {
  let n = ri.exec(e);
  n && (n = n[0], n !== ":" && (this.port = n.substr(1)), e = e.substr(0, e.length - n.length)), e && (this.hostname = e);
};
var Re = ui;

// openclaw/node_modules/.pnpm/uc.micro@3.0.0/node_modules/uc.micro/build/index.mjs
var pn = {};
vn(pn, {
  Any: () => cn,
  Cc: () => ln,
  Cf: () => di,
  P: () => ke,
  S: () => un,
  Z: () => dn
});
var cn = /[\0-\uD7FF\uE000-\uFFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/, ln = /[\0-\x1F\x7F-\x9F]/, di = /[\xAD\u0600-\u0605\u061C\u06DD\u070F\u0890\u0891\u08E2\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFFF9-\uFFFB]|\uD804[\uDCBD\uDCCD]|\uD80D[\uDC30-\uDC3F]|\uD82F[\uDCA0-\uDCA3]|\uD834[\uDD73-\uDD7A]|\uDB40[\uDC01\uDC20-\uDC7F]/, ke = /[!-#%-\*,-\/:;\?@\[-\]_\{\}\xA1\xA7\xAB\xB6\xB7\xBB\xBF\u037E\u0387\u055A-\u055F\u0589\u058A\u05BE\u05C0\u05C3\u05C6\u05F3\u05F4\u0609\u060A\u060C\u060D\u061B\u061D-\u061F\u066A-\u066D\u06D4\u0700-\u070D\u07F7-\u07F9\u0830-\u083E\u085E\u0964\u0965\u0970\u09FD\u0A76\u0AF0\u0C77\u0C84\u0DF4\u0E4F\u0E5A\u0E5B\u0F04-\u0F12\u0F14\u0F3A-\u0F3D\u0F85\u0FD0-\u0FD4\u0FD9\u0FDA\u104A-\u104F\u10FB\u1360-\u1368\u1400\u166E\u169B\u169C\u16EB-\u16ED\u1735\u1736\u17D4-\u17D6\u17D8-\u17DA\u1800-\u180A\u1944\u1945\u1A1E\u1A1F\u1AA0-\u1AA6\u1AA8-\u1AAD\u1B4E\u1B4F\u1B5A-\u1B60\u1B7D-\u1B7F\u1BFC-\u1BFF\u1C3B-\u1C3F\u1C7E\u1C7F\u1CC0-\u1CC7\u1CD3\u2010-\u2027\u2030-\u2043\u2045-\u2051\u2053-\u205E\u207D\u207E\u208D\u208E\u2308-\u230B\u2329\u232A\u2768-\u2775\u27C5\u27C6\u27E6-\u27EF\u2983-\u2998\u29D8-\u29DB\u29FC\u29FD\u2CF9-\u2CFC\u2CFE\u2CFF\u2D70\u2E00-\u2E2E\u2E30-\u2E4F\u2E52-\u2E5D\u3001-\u3003\u3008-\u3011\u3014-\u301F\u3030\u303D\u30A0\u30FB\uA4FE\uA4FF\uA60D-\uA60F\uA673\uA67E\uA6F2-\uA6F7\uA874-\uA877\uA8CE\uA8CF\uA8F8-\uA8FA\uA8FC\uA92E\uA92F\uA95F\uA9C1-\uA9CD\uA9DE\uA9DF\uAA5C-\uAA5F\uAADE\uAADF\uAAF0\uAAF1\uABEB\uFD3E\uFD3F\uFE10-\uFE19\uFE30-\uFE52\uFE54-\uFE61\uFE63\uFE68\uFE6A\uFE6B\uFF01-\uFF03\uFF05-\uFF0A\uFF0C-\uFF0F\uFF1A\uFF1B\uFF1F\uFF20\uFF3B-\uFF3D\uFF3F\uFF5B\uFF5D\uFF5F-\uFF65]|\uD800[\uDD00-\uDD02\uDF9F\uDFD0]|\uD801\uDD6F|\uD802[\uDC57\uDD1F\uDD3F\uDE50-\uDE58\uDE7F\uDEF0-\uDEF6\uDF39-\uDF3F\uDF99-\uDF9C]|\uD803[\uDD6E\uDEAD\uDED0\uDF55-\uDF59\uDF86-\uDF89]|\uD804[\uDC47-\uDC4D\uDCBB\uDCBC\uDCBE-\uDCC1\uDD40-\uDD43\uDD74\uDD75\uDDC5-\uDDC8\uDDCD\uDDDB\uDDDD-\uDDDF\uDE38-\uDE3D\uDEA9\uDFD4\uDFD5\uDFD7\uDFD8]|\uD805[\uDC4B-\uDC4F\uDC5A\uDC5B\uDC5D\uDCC6\uDDC1-\uDDD7\uDE41-\uDE43\uDE60-\uDE6C\uDEB9\uDF3C-\uDF3E]|\uD806[\uDC3B\uDD44-\uDD46\uDDE2\uDE3F-\uDE46\uDE9A-\uDE9C\uDE9E-\uDEA2\uDF00-\uDF09\uDFE1]|\uD807[\uDC41-\uDC45\uDC70\uDC71\uDEF7\uDEF8\uDF43-\uDF4F\uDFFF]|\uD809[\uDC70-\uDC74]|\uD80B[\uDFF1\uDFF2]|\uD81A[\uDE6E\uDE6F\uDEF5\uDF37-\uDF3B\uDF44]|\uD81B[\uDD6D-\uDD6F\uDE97-\uDE9A\uDFE2]|\uD82F\uDC9F|\uD836[\uDE87-\uDE8B]|\uD839\uDDFF|\uD83A[\uDD5E\uDD5F]/, un = /[\$\+<->\^`\|~\xA2-\xA6\xA8\xA9\xAC\xAE-\xB1\xB4\xB8\xD7\xF7\u02C2-\u02C5\u02D2-\u02DF\u02E5-\u02EB\u02ED\u02EF-\u02FF\u0375\u0384\u0385\u03F6\u0482\u058D-\u058F\u0606-\u0608\u060B\u060E\u060F\u06DE\u06E9\u06FD\u06FE\u07F6\u07FE\u07FF\u0888\u09F2\u09F3\u09FA\u09FB\u0AF1\u0B70\u0BF3-\u0BFA\u0C7F\u0D4F\u0D79\u0E3F\u0F01-\u0F03\u0F13\u0F15-\u0F17\u0F1A-\u0F1F\u0F34\u0F36\u0F38\u0FBE-\u0FC5\u0FC7-\u0FCC\u0FCE\u0FCF\u0FD5-\u0FD8\u109E\u109F\u1390-\u1399\u166D\u17DB\u1940\u19DE-\u19FF\u1B61-\u1B6A\u1B74-\u1B7C\u1FBD\u1FBF-\u1FC1\u1FCD-\u1FCF\u1FDD-\u1FDF\u1FED-\u1FEF\u1FFD\u1FFE\u2044\u2052\u207A-\u207C\u208A-\u208C\u20A0-\u20C1\u2100\u2101\u2103-\u2106\u2108\u2109\u2114\u2116-\u2118\u211E-\u2123\u2125\u2127\u2129\u212E\u213A\u213B\u2140-\u2144\u214A-\u214D\u214F\u218A\u218B\u2190-\u2307\u230C-\u2328\u232B-\u2429\u2440-\u244A\u249C-\u24E9\u2500-\u2767\u2794-\u27C4\u27C7-\u27E5\u27F0-\u2982\u2999-\u29D7\u29DC-\u29FB\u29FE-\u2B73\u2B76-\u2BFF\u2CE5-\u2CEA\u2E50\u2E51\u2E80-\u2E99\u2E9B-\u2EF3\u2F00-\u2FD5\u2FF0-\u2FFF\u3004\u3012\u3013\u3020\u3036\u3037\u303E\u303F\u309B\u309C\u3190\u3191\u3196-\u319F\u31C0-\u31E5\u31EF\u3200-\u321E\u322A-\u3247\u3250\u3260-\u327F\u328A-\u32B0\u32C0-\u33FF\u4DC0-\u4DFF\uA490-\uA4C6\uA700-\uA716\uA720\uA721\uA789\uA78A\uA828-\uA82B\uA836-\uA839\uAA77-\uAA79\uAB5B\uAB6A\uAB6B\uFB29\uFBB2-\uFBD2\uFD40-\uFD4F\uFD90\uFD91\uFDC8-\uFDCF\uFDFC-\uFDFF\uFE62\uFE64-\uFE66\uFE69\uFF04\uFF0B\uFF1C-\uFF1E\uFF3E\uFF40\uFF5C\uFF5E\uFFE0-\uFFE6\uFFE8-\uFFEE\uFFFC\uFFFD]|\uD800[\uDD37-\uDD3F\uDD79-\uDD89\uDD8C-\uDD8E\uDD90-\uDD9C\uDDA0\uDDD0-\uDDFC]|\uD802[\uDC77\uDC78\uDEC8]|\uD803[\uDD8E\uDD8F\uDED1-\uDED8]|\uD805\uDF3F|\uD807[\uDFD5-\uDFF1]|\uD81A[\uDF3C-\uDF3F\uDF45]|\uD82F\uDC9C|\uD833[\uDC00-\uDCEF\uDCFA-\uDCFC\uDD00-\uDEB3\uDEBA-\uDED0\uDEE0-\uDEF0\uDF50-\uDFC3]|\uD834[\uDC00-\uDCF5\uDD00-\uDD26\uDD29-\uDD64\uDD6A-\uDD6C\uDD83\uDD84\uDD8C-\uDDA9\uDDAE-\uDDEA\uDE00-\uDE41\uDE45\uDF00-\uDF56]|\uD835[\uDEC1\uDEDB\uDEFB\uDF15\uDF35\uDF4F\uDF6F\uDF89\uDFA9\uDFC3]|\uD836[\uDC00-\uDDFF\uDE37-\uDE3A\uDE6D-\uDE74\uDE76-\uDE83\uDE85\uDE86]|\uD838[\uDD4F\uDEFF]|\uD83B[\uDCAC\uDCB0\uDD2E\uDEF0\uDEF1]|\uD83C[\uDC00-\uDC2B\uDC30-\uDC93\uDCA0-\uDCAE\uDCB1-\uDCBF\uDCC1-\uDCCF\uDCD1-\uDCF5\uDD0D-\uDDAD\uDDE6-\uDE02\uDE10-\uDE3B\uDE40-\uDE48\uDE50\uDE51\uDE60-\uDE65\uDF00-\uDFFF]|\uD83D[\uDC00-\uDED8\uDEDC-\uDEEC\uDEF0-\uDEFC\uDF00-\uDFD9\uDFE0-\uDFEB\uDFF0]|\uD83E[\uDC00-\uDC0B\uDC10-\uDC47\uDC50-\uDC59\uDC60-\uDC87\uDC90-\uDCAD\uDCB0-\uDCBB\uDCC0\uDCC1\uDCD0-\uDCD8\uDD00-\uDE57\uDE60-\uDE6D\uDE70-\uDE7C\uDE80-\uDE8A\uDE8E-\uDEC6\uDEC8\uDECD-\uDEDC\uDEDF-\uDEEA\uDEEF-\uDEF8\uDF00-\uDF92\uDF94-\uDFEF\uDFFA]/, dn = /[ \xA0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/;

// openclaw/node_modules/.pnpm/entities@8.1.0/node_modules/entities/dist/decode-codepoint.js
var pi = [
  8364,
  0,
  8218,
  402,
  8222,
  8230,
  8224,
  8225,
  710,
  8240,
  352,
  8249,
  338,
  0,
  381,
  0,
  0,
  8216,
  8217,
  8220,
  8221,
  8226,
  8211,
  8212,
  732,
  8482,
  353,
  8250,
  339,
  0,
  382,
  376
];
function fi(e) {
  return e === 0 || e >= 55296 && e <= 57343 || e > 1114111;
}
function Gt(e) {
  return fi(e) ? 65533 : e >= 128 && e <= 159 && pi[e - 128] || e;
}
function Wt(e) {
  return e - 1 >>> 0 < 127 || e - 160 >>> 0 < 55136 ? String.fromCharCode(e) : String.fromCodePoint(Gt(e));
}

// openclaw/node_modules/.pnpm/entities@8.1.0/node_modules/entities/dist/internal/decode-shared.js
var $ = /* @__PURE__ */ (() => {
  let e = new Uint8Array(127), n = 0;
  for (let t = 33; t <= 126; t++)
    t !== 34 && t !== 36 && t !== 92 && (e[t] = n++);
  return e;
})();
function Ht(e, n, t, r, o, i) {
  let a = e.length, u = i * 90, d = 0, h = () => {
    let E = $[e.charCodeAt(d++)];
    return E < i ? E : E * 91 - u + $[e.charCodeAt(d++)];
  }, g = t - r, m = t + o, c = new Int32Array(m);
  c.fill(-1, r, i), c.fill(-1, i + g, m);
  let l = new Int32Array(m), f = new Int32Array(m);
  function p(E, O) {
    let I = 0, A = O, W = O + E;
    for (; A < W; ) {
      let H = $[e.charCodeAt(d++)];
      if (H < 89)
        I += H, c[A++] = I;
      else if (H === 89) {
        let q = $[e.charCodeAt(d++)] + 2;
        for (; q--; )
          c[A++] = ++I;
      } else {
        let q = $[e.charCodeAt(d++)];
        I += 89 + // eslint-disable-next-line unicorn/prefer-minimal-ternary -- branches read a different number of side-effecting input bytes
        (q < 90 ? q * 91 + $[e.charCodeAt(d++)] : $[e.charCodeAt(d++)] * 8281 + $[e.charCodeAt(d++)] * 91 + $[e.charCodeAt(d++)]), c[A++] = I;
      }
    }
  }
  p(r, 0), p(g, i);
  let y = new Int32Array(o * 2), b = 0, w = 0;
  function R(E, O) {
    for (let I = 0; I < E; I++) {
      let A = O + I, W = h(), H = h();
      y[w * 2] = W, y[w * 2 + 1] = H, w += 1, l[A] = b;
      let q = (c[W] < 0 ? f[W] : 1) + (c[H] < 0 ? f[H] : 1);
      f[A] = q, b += q;
    }
  }
  R(o - i + r, i + g), R(i - r, r);
  let k = new Uint16Array(b), x = 0;
  for (let E = 0; E < w; E++)
    for (let O = 0; O < 2; O++) {
      let I = y[E * 2 + O], A = c[I];
      if (A < 0) {
        let W = l[I], H = W + f[I];
        for (; W < H; )
          k[x++] = k[W++];
      } else
        k[x++] = A;
    }
  let S = new Uint16Array(n), v = 0;
  for (; d < a; ) {
    let E = $[e.charCodeAt(d++)];
    E >= i && (E = E * 91 - u + $[e.charCodeAt(d++)]);
    let O = c[E];
    if (O < 0) {
      let I = l[E], A = I + f[E];
      for (; I < A; )
        S[v++] = k[I++];
    } else
      S[v++] = O;
  }
  return S;
}

// openclaw/node_modules/.pnpm/entities@8.1.0/node_modules/entities/dist/generated/decode-data-html.js
var qt = /* @__PURE__ */ Ht("!}.&u%}'&}*'~!6*)%&,~!J~!J~%L~y<~!R,~~%Lu~~#GD~~#|)1#%}^%}2%+#.##%##%}&%##%'#%##&%#%#'%#&#%#&#'#%%#&#%##%#)%''%&%#%#'%#%%#%%}%%%#%#&(23#%%#&-%0%('1#(##%#'##+%'*.:1}#%#6-+(%'%%#%%%}#L'2351&('%}&/N'(0(/*-%(%%}#'+&T%7.2}#&%&#%#36/5##%&%%#&#%%#))2%%##%&&'0~!#*+&'%1~!%).'3q?&%'1~!.##%6(~!+%%%(Gw'rT~!E#<nA%#jZ~!H%(~!42##~!*31&~!G%U~#)5~#`3~!J~!Z~%]~%Y~%C~!q~!u~#kz~%#~!6'~!D~!U~!?~#T~!c%~!G#'~%7|~!G~!J~!G&~#pb~(Df}#%}*&}#%##%##%##&#-}&'#'&%#.++}%mI,#,@&(}*%}*'%&##&#%##%}&0}#.},U},%}+%}&%}#%##&}B%(}(%}+%)})%##%#&}&%##%&}<%}>%#%&}*%}(%}9%}/%})%}*%}*%}?&}&%}3%}&*#%})%#%#)}#&#-#+*%E%%'%'#%}#*V##&##I}#&&##%&%#&&Qf%%))w/0+&%#(#.%-''''++++7}>%4'',##1,#%#&%##&#'##&#*#9)%&%}#*}%,#+P(%A&%#'&##wSD',9E00#y#@}(+}&%&>~!#~!X}#*}(&&}(&}(,%}%&#+&}#&}I%#%}%)#(},'%#*}4%%#%}(''}#/##(##),%-##%%)#&}(.}&%#&}%%}*&#%},&&}&%}#%*'#%})%}D&}&%}-&}6&#&}-,%}#%})-(~+`~,=?~I9'9%~!,#%})%})%}@%}?%}(~!?~#<~#pP~#BG~#=1#%K+~#?#~%;)~#A~#mF1~#A'~'X%'~#lR~#N~'N~#r~#m#-~#i'?%#'%~#B%##%,%#~#_%#0%~#]732~,w~2+#:&#%&'0%&>%}#>##F+)#%&&#(+_}4&}-%}(&}@&}O7Fdf0@+/v4}&WU##&/0#&'('B#%}.%}'+#%}#%%&#&%#%##+#&#)#6#'#.},%}c%},%#%##%&#&%#&~#>'*-.%##%##%}#%%}%'~#)D1}#%*&~#_%%'(~#S2%'.}#~#=##*'*-%}&'%'##&&~'E%.#&~#M4}%%##&'%#~#O1##%&#'+~#<B%##%%'%+~#;#@%}#&%#&&%#(~#H1}'%'##&&~#?A}&'~#D#%32}'&&&&~#[}'(#%}'~#;C})&}%%#%~#=&%,3}%'(#%%~#^'#&&)#%'~#Y%-~#d-%'~#^%%&#&&&}#~#b~2t*&'~&(~&@~0%~e~3}%*''0})&}+~!9##-}#%-hD*)1fC#%/&/fB#40~!+#)*4~!+~!K'&:~!/*7~!.#~!H~!L':~%x&~!H#~!*~%1~!I#~!+A~#p'~!F~~#-#~,,(~.Z~!V~%;'B'mq-W~!N~%I%#&&#&}#%},%%}'%}+X#%}#&}(%}'%}<%}#%}%%'}'%}:~![)9@~%>~#UA%-%##&~!C%~!-.9:~!1~!-^2/:a~!y,D*J#-5)/4~%23,~#G~!L1~!0X3`~!2+~!!0-~&E~!W~!o,>Y&]~%cZx_&~#O*9#A#'#+I'%#)~!0B*-5A+-((F&*M#)(-7-5+'-3a5Vi~!Y~!?+[)%3),ERHm~!+:D,VG.+)?fB%%*(%)'(#&80%1'8`K8?`+'Z#&O&'H5#*9)A%%5&3))0%39+.*7#()&&*=4@**L)<'_&*+..;(#*+)./&0#3)%')-8(4ixD(&.}%,('aI:,)%,k2231T)I'#/-W7,/'Q#.'Y24+h')37</31&83##&0#),H(?'&?/1##%#&&#%''-%&&&#(&''&#.-'%#%%(,')*'&#&#'##%(%(#%('#&##%%%%('%#%#%%#%#&%##h>w+v<ayvyvcg.uuhKr}g/v|g>u9i[~>g5uI~=RvdwEg;v/g;uk!!TTSx]@RT!U!#!@VBRUU!'UTe-d0c`e&gSdicedFcrdTaqb.kYcAohdYd@a3e+d}dMdtd.aJ#bqcK`dle/e.e'dwdPdodddjbEb}ogd^ofdpduc6j?l%d{drdqc)d7bacOdQ%T#Y)X.sR[yH>6Vyv3[xwLu>vo'!*.[yBacahoj>6Rew3[xqdZa#!a&#^(X-[yG>6Vyu3[xvg3sEr|g.u/Ri9db0T#^(Xa)!-[y;>6Vylg4wKs{JwNZt3@3r=c4Z([xlg;wKt!cpq's@v7A'*a(a+!-a#[y<3Dt?3Dt'>6Vym3[xmg9rxsNJwLZt4~?r?db1T#`-!(Xa,!0[yS>6Vz%NuQs.g4wKtnJwNZtS@3r>c4Z([y%g;wKtrdga8!a(!#&T*Y-Xa#!a0<or[yc3Dtq>6Vz43[y3JwNZtf@3s!Ju}!%Dti:pm3c_%X#tjB5pkd6q!r]u?voC'*-a.a2!0a&a+[yI3DtI3Ds~3DtH>6Vyw3[xx;:s#~<5pKJwNZtE@3r~d`a)!a2T#a.(!+U.X1[yT3Dt`3Dtv>6Vz&3[y&g9rxwzcxstPu.<rAJwLZtT~?r@dZa%!a.&^*Za(/Reu[ya>6Vz23[y1g3sEr}wkg{NuQRg{ci(U#5@b`~,cg#U(2WnH5wugcRh7dX#T(Y,a'Ta!!a,[yZ<]mj>6Vz,3[y+Pv#5ReZKu+=,%!H}7ABwkaS?Rh:BcW(X#<]mrj:ubv/ARekdg%!(!a.*Ta(Y.X1!#sP>Rl*Dt6[y>>6Vyo3Wf*jOvuumvuRgRJuq*!:9<B@bX~3jVv&v@s@5Re[d/rQt{uAvo&a&a*)a2!,0Wf!3Dt0=Bs'>6Re}3[xy~<5s%JwJZt1~Gs)c;&!#2sJkNuXvzq7rxu,Re8dka4!a8(aEZ+a@Y.X1Xa)[yd=Bs(3DtP>6Vz53[y4cX#X&Re:avRe9~<5s&JwJZtQ~Gs*i^rzvdRg+Jv{%!2sbB@bX}kdga,!Za?&^*T1/!a'Dt+[y6>6Vyf3Wf%g/u;s4hGu6?Rh-JvZ,!c%#&RoX54Rivj7uyvf8RgTKvZB%*!2sGh<vu5Rgq<=C::9bb~#dZ#T&Ta6Y.X*Dt>[y93Wf)coZ(T,6VyifluvRgC@95@B@bX~/hFu34cC#T,k/unq8w8Q5RkUklwQuzunq8w8Q5Rk8d/rJu?v8w9)-&!a0a;a&aIWejg3sEr/h1s<DtDJvyZqY5aws3Jvy!&Wei~Hr1:au5@Bag>23E~5c:Z&bX};kKv?w&unuVu5Rjc;>bs)#~@:Rh.=ay<a]C;b`}Vd6s/t{uAvoaxa()!a,a7%-a#a2Dt,[yF2Wo[>6Vyt3[xuNuPRi&NuPwpi#RoWh?vf8Ri%Jv]!%Ri:KvxD!.'2WeAjZu`q9rxu,Re7woeAg-unLq(qA_/*2Wg_g3u5q^9:4E}/jTrxrzv=Wkkd~0UX#^^Xa-a1a5T&a=U1a'*aEa]!a*aPaA-adok[y54Rn>;:p3~Dp5g9rpsFNvZqjg3uJp4~<5p0Pw;5qlJwNZt*@3p1Pw:5p/Ou!5p2JvG'!6Vye=<qnJvh_[xhg3v,Rh3kOwOw-sDuev/Re^dha[a%!%!a+#Ta7)-5TaCaO!aka!a)sf[yb2>Rl!9ARiq5E}Qg=ucRkBE|oJrJ_@Wk~@Wk{JrJ_@Wk|@WkyJrJ_@Wk}@WkzJvO_[y2g-vMRmiKuYC!)&>Ri;>Ri<@3RkNc](X#@9Rk=g5vuRmhKvDB!+'=]meg3u4Rmgd)#Y'Vz3CARmfd`a+!%T'!+#Ta1Ta6TaM-sTDt9[yA9sYd'%Y#s[[xpj:ueunaXRgEjRq,v-vuqdd2'`#6Rev<32@5>:2<E}5xIo9a*X#Y(;5RePJvD_g>vyRgNj8w)v8<wggs:RgXiZt|vjx,hSq3ah!-(~@:Ro/Ou!5RhWj^v(pyw8unRhUdx-UY#^Ua.a3a70!)%UX1TaDa)'omRiRRhE[y:3Dsz=Br,>6Vyj3[xkg6ruwjcqsrPw;5r*Ku]D'Zt-@3r(~?r.i[vwv]dU1a--U#`a4(g/vsRhPOu!5RhLj:rmu9Wo!~@:wdh@g/vsRiTjXuvvNr}:RhBj^v(pyw8unRn]dz1UYa'a+^Y(!aETZalaRY.Ta?a4[yDJw1!#qLsW>6Vyrfzq-pLflpwRe|Js>%!Dt@3Dt&Jvy_[xs~HrnjMuwpsw'RecKu+D#'!t<~Grl~?rjg5u-x,gwp{ah!-(~@:Rg~Ou!5Rh'jXuvvNr}:Rh#cW#X/c;&!#2sLi[v7u7RgpJv)(!iLrxu,Re6j7v@s@5Se[e7d`aW!Za(a`T.a#!a3!&aDa-!9)Dt_=6s+3[x~~DR|h~DS6avhGun5RkZj3w)v-]mkKunB!&*]kb97R|i<ARk<c:Z(6Vy}Juh'!wziMRoS:F|vkLuauJv5vtvQRh1d='T+Y#VyO~DR|jcF#T'7R|g97R|kJv3'!ay<Rj,Jvh&!:ReXcsa6*a+#a#_aIRf9aLRf?c,Z&Rf5Rf7c.Z&Rf;Rf>cQ#%T'p-Rf8Rf=ct#%'(*!,p,Rf4p+Rf6Rf:Rf<d~'Ua%U*^UYa(!a,-!#a4YaTalaEX0a8a<Weo3Dt/3Dsx=Br93Wen~Dr;~<5p<JwNZt2@3p=Pw:5p;Ou!5r3c7&!#:p>3Ds}KvGB)_6Vyk2sM=<r7x'eovA(!hFu1ARf}cV#X&@r5j6rvwQa^Rf3c=Za'wkghJv__g;unRggA53B9=b^}%j6uduo5Jq;!(hIv%2Re`Ou4ARe_e%a#^^^Xa&!a*a2!&a6YaP!*ad!#a:aE/5Rn?[y@>6Vyp;:pE~DrY~<5pBJwNZt8@3pCh=rt3rWPw:5pAJup_[xoNuPpF9c!#'45pD5ARn)d8#X'X*3@rU72s]h>v<<sSjJpqvewOJq/(!hNw'5ReBk0s2u3w/w'5ReE5@Jq.!a+JQ!&WeU23d(#Y&RjG5]jBk!u7w&u0udARjEe#+^^^Ub#!a2/a`Z(agT1!a-a;|@TaG!aS[yV=Re~fow'RguNuPRe?bz#'>RoUWeL>:Cbb|?JwPZtVg6ruRmzJvD'!6Vz(g/vmRh~Jvy_[y(g9voRgyx*cy(#2>Ri2B9b]~9kIw9u7rluJu3Rg]dI#a%UY'@=p%CAx.gQZ&RhwwygtRm{x5g_Z'+ABqR9Woa=Bp&dV#^*Xa'!&@o{g4v]Rk;Jv{!%Rk[wkkiA5RkiwwfUB=x,fUuqC&*!>RfTg8v0RfV~ARfSd;rJsAuAv9wR'ae+/aO!a@aza/a#[yQ@Wg!2Wemg3sEr0JvB_g>uvReWg2v+Re=KupB_+[y!2AbY~-~Hr2AJwD!(h<~El>h<~El?Kun@+_:9b`}Kg-v/Ri3g;vtwyk_9]k_d=&T#*U.6qh@Ab`|K9:H|CJv[!&3Dtex'fDwC%!Rf[9WlMd[(^X,!a%Z06Vz!@WgBg=v~Rgvg,QRe@awd,#Y+jTv|Q~EfWj]uNr|~FRfXdy#Y&^Ua%!aO.!(a)Ua;=!a@aKap!a-,a!Ta]a[rSa]p?[y82sK=Bq~;:p:~<5p8Pw:5p7d'#Y'Wf(;RnRi[u4w&RgJJvG'!6Vyh=<r#ijuuv/sIKuYD'ZtG@3p9~Gr&d2#`(g<vtRgFj`u5w&rqpxRf2CJuY!+:wfnTOu!5Rg}jNs1ucv&RfwJvA!&3@q|BDcC#T,k/unq8w8Q5RkTklwQuzunq8w8Q5Rk9dga#!a'!a=#a0!:+Tb*b@aO.a4!aba8aFJv^}?!VyR~Dr<g;u%Rn.~<5p[x'e`wNZtR@3p]Pw:5pZhNvjBp.woe_g5u-r4JwF!%DtO3:ooc7&!#:p^3DtpLuGw(!+%)Dtk6Vz#2sd=<r8d'#Y([y#<x3gJt`w@!)%}MRiowzikRij=]ilxAf3,U(#B2Rf#g0v-Rm[ck{`U#]giKv3>)!&6Ri154s,KuGB_%@r68r:dJ|t`#X(9<E|u2@H|rx3gJu?w'!+'1Nu7Reg4=H~+9<wxgY95Rm]xLggZ-`(X}U2:Ri4h<uOawRmsJv__5@bb{jbV~3dka#a'a]!,#a+U=a>b6a3b%!/aKa/)!arwve^VyJ;:pR~DpTg3uJpS~<5pOPw;5qmPw:5pNOu!5pQJvG'!6Vyx=<qoJvA!{~Jup!%@qk7Rn/KvyD!}''[xz;>wkh'?Rh,x8gyt`w5D!&),(SgyccRgztJ@3pPB5p#d'(Y#<]mmifubw&RgoJvE&!82s^JvF&!8Rf,ADb]~;x=h'rNu]vK!,%'*0RnORh)4Rh*AqQg-vaRnNg;wHwkh'ba~4cE#Ta*x3gctyw@'!+%RnFRnD<4Rn@hFvK5RnCxWg[#`&a0Ua()`1Rm75Rg[c]%X#qi8Rg^NvdRj>BwzgZauwji7Rm6A4wgg]d1#&(*,.0a#Rm;Rm<Rm=Rm>Rm?Rm@RmARmBe%#^^^Xaea?aC/b+(,!a+a#!a/!>a&Ta<aKbD!2wphBRnk[yPw}hE|.=Br-3Dtm>6Vy~g6urRf.x,hPrNav!%'RnqRo%Ro#Nu;q[Pw;5r+JwNZtM@3r)d'#Y'Weh;xChL#`&RnmRnoKu}>%(!Rne~Bs-;2wjcussJv+'!aYSO}6@B<5?ba~8LrNvj!.%*ROwungw~ng~:9;Ri^>wtnig;wHRnixDh@|(UZ.x1h@|)!#:2<H|*xHn]#-UX'3Ro)z=iT}6ARns=Bwsn_wpnaRncw]aR(#UXa&Ua*a/=]iPd'#Y&Ro'WnXf{QRm2hNvj]nZd`'T~&1`{|`#9b]{}c:'!#Wl{>@=be}]?cl{{U#:5Abb}Jds#^YaF!a*b4a#a3aPa>&Tb!bH!*a_!Eau?/a&RjY<]gj>6Vz*;:pe~DrZg,QRj1JwNZtX@wihspcJvZ&!VyX9WmOJu|!|N2WmHJvh&!]ht~Bpbcn&T(!#RmQ<s7Nu;padH#X'`+WmJ@>RmKCARhnKup=!)&Wf+:RhqNuPpf9c!#'45pd5AwghpARn(Ls@w!%,)!RmP@Wfe<E|IJva!&WmNg8vsRmLd`*.`#Y'Xa!axRn*]hrA8Rhug5s@rXg8u!RmMd8#X'X*3@rV72smdI*#UY&RmICARho~GsgxVgd)Ta'U-Y&Xa!T#RnEWnA@Wffg1uDRi0hFvK5RnBxGnG&#`%owp)@wsf+bX}Ze-*1!a*^^^Ua|!#a.aq&Ya2!a>.a6!a:aO`aJDtL[y`@Wg#>6Vz12@wzoYRoZNuPRi!NuPRhzg=ucRi,@=b`{Yg=ucRi-ACJvB!&Sh[ebSh]ebi`wUuFRm4Jw2_[y0JvB!.<Ju(!&SoG}6Shd}6<Ju(!&SoH}6She}6Kur@._g5vHRieJvx!{L2G{Kx6gd'T#?Rh82Wi5cZ#X(g1w)Rm5dW-Y(Ta#!a)!#aYa=wnfE=su2>>bU{0j9udv:<svj8uQv-7RgHdE%#^'sq9sp=>Bb_{TJv`!&g/r|snj6v(us5d,#Y(56H}[978H}]Jw5!&g1rushJvB!+j;v{u5?zDhd}6}bj;v{u5?zDhe}6}ce*#`(^^^a[aea!=!a6a*aoXb1a.!aAbL!b>,b'aL!aV@Wf|2Wlg3[y/JwNZt^@3piPw:5pgJunZou3@rsJva&!Vy_g<v~Rm#JvG'!6Vz0=<r{Ju{%!:pj@WfsiXuJu3Rm:JvZ&!WfA~Bph@c4Z&Dtwax5rubx(#:awRk1@d,#Y&RfjRfid1#,Y(@Wfp2Wlrg5s@ryKu[@!,'=]ig9wlk?Rk>g5u-rqJvy'!@9RkQcH(T#=>Ri~@<wkj(Wj(KuZB*!&<7rw@9RkRcH(T#=>Ri}@<wkj)Wj)dg(Ta2Xa9X#`-!a*CARhg@@=I}d9x;c~#X%so=<sj>2@@=aybb}XjWv0Q~EfEj3vLv;<d,#Y(56H}`978H}_dgaPaFa'a/!#a3Y0a_a;a|!1(a7-[yE3[xt;:pJNvZrrg3uJrvJwNZt=@3pIh=rt3rxPw:5pGOu!5rpJvG'!6Vys=<rz@c4Z&Dt(ax5rtJvZ!&~BpH@wsfNg-vaRlNci*U#=<wei<F}a5@Jq.!a*JQ!%@qZ23d(#Y&RjH5]jCk!u7w&u0udARjFd/prq=tyvpaEa(a:.!a1aZ(@@=I}:9wpd%=<sX55w_h}@@=I{t=ay<aU@@=I}T=ay<2@@=I})?C9:9au@9Cb]}DP~=x-fAZ(2Wl1=ay<aU@@=I}>5@d##Y+jTv|vV~EfFj]uNpn~FRfGdgaK!Z2&!a8a-Tb({E!acTbM*!a(DtY[yYd'%Y#sl[y*hHvh>Re5x2c{Z}.j4uCvcawRiMd+#X+_x&d!},<5RkX;2Hzw@x,gavfB-!{CcF&T#Roe;RodwWbBg5urRgaKvHC*_6Vz+<4opieuew&Rmq@d]&Y)X,T#X0Rh}<BqP=4qS9:ReMg/ujReNJw0!/<Jui%!bd{kawwnemRelAxUa?a3#*.&UX(Ya+a/RhvRnQ<o}9Wmtd-#Y&RgSRmw9;Rmxay=Rmyg-vaRmuxEhSrNu,v-voC!%(aR.a(a7+1Ro1>Ro5CE{A9b]{@;5x#eO{:g;urRi+KrNA!%(Ro3>Ro79;Ri_Ku@>{;&!x%gX|{KunA_+g5QRj/g3u5Rj#g>uERj%wio/xRhS&!,!#^1U}wba{8>>@=be}qC@:D5ba{7Ku+A&!}x?ba}t>>@=be}se(aA^^^Uat!b0#{pa+awUazbGa#aLb9bgaWac'a5TbS=Br!d1#`%scp_Jvl!#rT>Re0JvX&!VyN=H{Fcm#U&:pY=ReaJv2&!]h0=]nUJvG'!6Vy|=<r%JrM_=]h2@Wlud'#)U'Wf'b]{i=]h/Jvh!&~BpWg=v]RnMx+ny#'Nu;pVwjnu=]nwxJnx,T#`&Reqwjnt=]nvieu9vrRjLLuYwP(#+!th@wih5pX~Gr'g5v/Rh4KunA'!-CARnP@wwiN:Rm_9x'cvw>!|l=<saKvAA!0&3@q}>w^e1bp#&Re2Re3BDx7gH#T|f5H|eKuZ>!%(:qNAH{]Jv6!+3B2B9=b^{X<5<B92:E{ZLvhwA(a;a%!igQuyRmad+#Y}m@3Rh5d8#X'X*:AqUAHzmaxwbh<aXRnVcF}RT#Nw&cj#U(BWnug/vsRntdka)(a3+.Zb7aYYan1!bVa@Xa}[y^@b[{G=H{+hFu73Rj&Pv#5ReQcK%T#sig1v{Rj'Ku+D#'!t]~Grm~?rkKuMB!01d5#`'Vy.ta3Dtu~Hroc8#'{^45s85AwZbP&!#Rn!wghxWn#KvEA!)&2RlA2RlBx:h|#(T,=]j09Wobz>x]z/@awRoTd+#Y(az]hFhCrm4d,#Y+jTv|Q~EfMj]uNr|~FRfOdCa!Xa9_X#@<plJvf!%b`{(9;Rgwc;.!#2x7cw#T|UDb]|T5Ju={(!=@E{&Jv)&!Ab`{'awJvf!~*>>@=be{#KuY>!+&4Ezyi[ugv&RjIdea+T)#UXa&T-T&a!Rh9auRmW=]kLg5vuRn+g3u4Rn-Ow6ARn,hHus5xNk?#UX(U~)/g8v0RkD~AwkkF?Ri.OuNBwkkA?Ri/d|a2`a*^UYa.!aBTZaTa'Xa;!(!2!-a#b2[yC>6Vyq3[xr2Wi?g1rusVh%s?DtF~<5rbJs;%!DtBfswKtCj[uvuSsEu3RgVx3o:u+wN'*Zt;@3rd~Grh~?rfg8w)Lq)qE&-a%!>bI|`jWv0vV~EfCjTv|vV~Ef@j]uNpn~FRfBcK#T']gWNu7x,k7q4ai(0!hHv8<RhmkMu9vrsBuev/RhlCJvB!,g<v{wchh~@:Rhji[vrv{wchi~@:RhkdS&a5UY#Ta!RgPwwiI5BwciI~@:Rh`x'iJvj'!5]iJPu8Bwch]~@:Rhach)U#h3rp]gLh@t|Ax,hTq3ah!-(~@:Ro0Ou!5RhXj^v(pyw8unRhVd|)`,^UYas!a?/a2Z'a^Ta{Tb7Ta(a#!a,Wf&9sZ3DtAadamov=Bqt3[xig8vsRm~>waiL2b`{QJv*_Ouv2qgj<v]v2BqfdR'X*X#Y-@3qr~Gqv~?p6hHv-]glPup5Lq+q?_%*b_{qF{n9b^{rOu4ARhpKvCD!+&~Bqp:5Dbb}nwoiKl&unuTuBv]v+ueunaXRf0=Jvh!0nKufu8v1w&w7q%w&uHrz:Rgnj5w,uxDJq/(!hNw'5ReCk0s2u3w/w'5ReFd>Za&!*UaA=<wkgsRnSJv^!%Refifw3vyRgOKu_B'!,<]gkiiu:w&Rh<=C@a^<B57@2F{[<B5@aW:=3away9A5aW=<B=C@a^<B57@2F{Ie-#`(^^^bCara.b8aza6!/bZ,!adTbnTbOb+aFaS!aAT9@Wf~2Wli3Dtl2@d,#Y&RfnRfmJwJZtN~GqyJva&!VyMg<v~Rm%iXuJu3Rm9Jv[_=]ih9wlkDRkCd1#`(@Wg>2Wls3cH#T(@<Rj*=>Ri|b~'#23s9h<~El.d'#Y&Dtxi^rzvdRl#d*#U%(o|B2s`hJwSaxRmDKv4B&!1:Rmdd5#`'Vx}to~Hq{x'f1v3(!BA5ba|bJv_&!Wfug1v]ReIdO+U/Y#&G}-8wze=Rh{g1v]ReHg/uQRf/by#)ibQwERl/cH#T(@<Rj+=>Ri{cNu+vlax-!(#a0qa9<Rii2;;bU{H;x<i=&X#Rk`<4wwi=C9H~8xAI(Y#<azRi@45wXI<B9;5bb~7dL(X#Xa(+!aL6Vy{g5QqOau:5au2@ay547EzbxOcU(UX-T#Ta#:Cbb|A?wjh/b_|SOw6ARgtihr}u7Rhy<d1#T)X1@@=I|~=ay<2@@=aybb}Sj3vLv;<d,#Y(56H}A978H}@dGpvs@uAu`vcw9*!aFa+ai%(b!aXa8.a?a[ozWey=sU2@G}Nch&U#Rf_WexKu+D#'!t:~Gr`~?r^j]uNr|~FRg*j^psurwJt|RmcKv)@&!)7Rkv~Br[@wxfO:Rl3co#U'6Rezj_q#vIuavjRltwzeyh@vr5JqD0!>aY?C9:9au@9Cb]}9cl#U*5;5<H||jbuus1ucv&Rfvg1v~d/pppzqFr^a--a~!aMat1(hFv;Wiz@@=Izoj5uuv-7Rix~Cw`fk2WlVcZ#X,k)u3vWs@u2]ktg;wEx'fBq(_2Wg/jTv|vV~EfoJv]!15x'hzqG!(P~EfU~CRl_j6v(us5x4i-#T(2WmZ?C2F|d>Kq<aj1!*jTqIsBv=Wl`~Cw`fi2WlWj`v0u*~>RlR=c>Z,k#u3vWs@u2]kr<c1Z+jTqIsBv=Wla~Cw`fm2WlXdmb3!a{(arZa`bkTa%TbQTa-a9+c'!aM!/[yL=Bqug.w'RifhFvyDRj.g>vgwyk^9]k^Jv3_@WfbAARkhJw2_[x|JvB_wkoIRoKwkoJRoLd'(Y#<]gm=<9<H|yd'%_X#skDtb3awwqkgNulRkgdB#^',9:p'hJwSaxRmEBwVb8@4=H|qLu+w50&!)@3qs~?pU>Awwn;;Rn=c:Z'ARn<=<qwKvC@!/&~BqqJv6!&]eVb^z^xRge'/a%+^`#Sge}6<4Rn3=]n0Pw2>Rn8Jw0!&>Rn:>Rn6cY#a7+!a&=<wkaNw~h3z_c5Z{=wjh#=]nLKv^D!&)Vyz=bW|swYb<WetcG#T(2wxa@qVx@gD#Y&b^|V5JwG&!5bb|pg/w&RgD@x=kHs=uAvn!a%%/'+RmSRh694Ro`g-vaRmRhHv-]mlxCcS#`&ba~.5cD#Ta)P~=d,#Y(56H{>978H{Dd_#{2^Y%_+qbbb{6g3sERhsbU{?dfa.,`a(Xa<!aiX#(55RiG54RiHcI#T'WiU3RiVNvdwtfcRlKNvdd,#Y&RlHRlExQgf.1*^T'X#Sgf}6Wn4=]hfPrk>Rn7Jw0!&>Rn5>Rn9Lunw?&a2!,5<oq@@wqfdRlJj5Q~=d,#Y(~ARfcOuN]fdDKw;ay(}i!547E}j?cI#T(@5bV}iCbV}hdv(^^Tb?a40,b##Tbo!a*bR!a<b|a/!aKai!aU[yK=]o^g:v>ReGJwPZtK<7Rh+h<~El,Pv#5ReR@awwxjCg,ulRjDJv6&!]j!z?aQeeg>w=Sh<eeJw;!&axEzOg,Qosc!#*:wkeJ]eJ>x'h-u(!%Ro.w~h.zPdNZ(X,Ya![x{;9ReY;wkgxRiF:x?ap#Y&RmUg<s2Rkod]+UY0TZ'!a&A9sw<=bczLNvuw{gqzNhJwSaxRmCKuLay!#&s_Rf-55b^{uJvZa!!c%#(55Ri654wmiu5RiuawLu,vp!+}^%b_}Y9;wkgxba}o>A9:=b^}zKuh=a''!3awRk3c*'!#aHRk6c+Z&Rk5Rk4Jv)&!awRjSawd9*`#0?C2@EzMj8u<uJ5RmbjQrquJu3x,k>uq@_+=ayb^|W~ARkEOuN]k@7dhzV^X/X&a-#zRzSb`zXcJzTT#2WkVKvDBzW!%FzY9;5bbzWjQrquJu3Jw3%!b`zU=ayb^zQd:#X(T-a!6Vyywxh}=b]{Jg=u1RiAdGp~qHtzv!w(wA+a+a;<!aJaYai'anasb(=azRmV:Cbb{MLq2vb!%')RjuRjrRjtRjqx3jnqCw3!%')Rk(Rk+Rk&Rk)Lq2vb!%')Rj{RjxRjzRjwLq2vb!%')RjsRjpRjfRjex3jcqCw3!%')Rk'Rk*RjkRjl9<CbbzfOu4ARhxLq2vb!%')RjyRjvRjhRjgx=joq*uKvb!%')+-Rk.Rk%Rj~Rk-Rk#Rj}x=jdq*uKvb!%')+-Rk,Rk!Rj|RjmRjjRjidAq&qKs@uAv8Aa.'*-a@a&0!aM@a5[y73Dsy3Ds|3Dt):wxgI2sHJwJZt.~Gqxwsf0ikrzt}Rl0Jvy_[xj~HqzKv_A|D!&WfP8axRoVcf,U#k(v]v+ueunaXRf1Ju}'!g8u#Ri=jQw!sCunLprq>!,')~<5qeGzq9F{W=c##%s5au:5aU3CBE|;d4#X(D!a&6Vygx(b;#(=]ed?C2F{N<capoq2r[a&!aPa9,'Pw;5s:@@=I|,55w_h|@@=IzcP~=x'fCqB_2Wl2>aU@@=I|1OuNBc1Z+jTqIsBv=Wlc~Cw`fl2WlZ~AcTa%!Z+jTqIsBv=Wlb~Cw`fh2WlYk+uNqJsBv=WlSg,u3dca3#UXaMYa)TaB-=cM|7T#<bI}l5@B932:aV2G{BOuNBJq:|M!5Ezt=<B=C@a^<B57@2F{v>cB{/T#=ay<bI{3Jv6!a.6BKq0ah&+!5E}HP~Ef{978BaU@@=Iza<7d#.Y#978BaU@@=IzH~AJq0!(@@=IzG978BaU@@=IzFe,aU*Y&^^^bvJb,b:bFad!a,c2Ta>aL.bo6!a#CbTa'T#Re{2Wlh2@G{yg6t~Ro_NvdRfticuRQRllJv3&!x&c|zs@Jw3!%RflwpfkRlpKuL;%(!Re<@G|C2GzdhIvuBwgjAg-u0RjAKQB%!(GzZ@G|5NuuRl7d='T+Y#Vy[g<v~Rm!==G|>JvA!)@wma=]m1ifuaw&RmnLs@vT'!|/+[y,g:v>ReTJw1!#qX=x!eC{bLu+wT&)ZtZauq_~Graci&U#F|89:r_Lupvq!.)&2RlG8RfaC=x!eF{_h?rpWlmd&'!#X|&]k::xJey#`'T|+<E|&2@H|%dE#(^,g;u.RiEg6vjRiC9xCkA{O|zY#g=ucRmXKs0@!&*@G|m@awRknJuh!,3d(}gY}eJvj!%Rm):Jw3!%Rm+Rm-Ls0w(&!a(a#@b[|6cZ#X'7RkxWgAOu4ARn'dH'U#Y*Vz-Wm'CARm}d]*#a%^a*T'aK!a<9bV{PC=p*Jw4!&SgxcbB5r]idw(wBRmF7xFkt#&`(Rm/Rm8E|!JuY_9:Rl5=wrgr2:bbxd@xXfB(a*#T+!.X0X1Ta/a'T&RlDRfL>RlyARl9b[z[>RfZ:RlL:RfRwlg/ARl;9;RlxKv,A/!%7s69<74=BA5ba{-8Bde#`a<XaKYa1,a'P~=wxfB2bZ}}?C972@@=I}r8@55B9;5bb}G978B2@@=aybb}3j3vLv;<Jw3&!>Rfk=ayb^}4~Ad1#`*@@=aybb{w2@>==<bbz]dx+UY#^UaF!a9!bB'Ya1.!ajXa#%olRhD[y=3Dt#Ov5BrHKuMB%!(Rf^Wep~HrJwkiQjKr|~FRg)Ku+D#'!t5~GrF~?rDdV)UY,Z/_7RkuG{<~BrBg,rlsO:235B@bX}|d?a1!#`(6Vyn5@d##Y+jTv|vV~EfIj]uNpn~FRfH7Lq2vb1!a9-978BaU@@=Iz9978BbU}#~AJq0!(@@=Iz8978BaU@@=Iz7~AJQ|}!978BbU}!JvkaK!AdUa21-U#`a+(g/vsRn~Ou!5RPj:rmu9WhOjXuvvNr}:RhAj^v(pyw8unRn[kPr}p|u7vwv]RiSBd;pppzq@qHQa?(b.!a.a`@.|xa(hFv;Wiyj5uuv-7Riw~Cw`fg2WlU978BbU|wOuNBJqG!(P~EfD~CRlQcZ#X,k)u3vWs@u2]ksg;wEx'f@q1_2Wg.j]uNpn~FRfqJv]!15x'h{qG!(@@=IzK~CRl^j6v(us5x4i,#T(2WmY?C2F{1>Kq<aj1!*jTqIsBv=Wld~Cw`fj2Wl[j`v0u*~>RlT=c>Z,k#u3vWs@u2]kq<c1Z+jTqIsBv=Wle~Cw`fn2Wl]dn1#c(a(b^a2!b/bAT(bj!aDa7bu,a_a{c0!2T0g:v>ReD2@G{42@G{5~DpM~<5rc=Bx6i>{RT#RnI@zCx]y]z:2Jv[!zr5Awyk]9]k]dD(Y+X#6Vz.g=wKtgwhaCwgmTWj2Lu,w%_+/[y-B;b^xeg3u3Rj-2@bX{*KrJ<!+'@Wg(g?QRlC@Jv`!%b[zIwsfII}8JQ_@w|kW|=Jv(%!AqcOuNBJvEzh!bYzjLs@wP#(0!oy@>RkdJwMZtc3Dtd@BcG#T'9bWxg2@2Fznd*#Y+;2x'c}w<zizixNgwa#Z'U+!/!a'!a+w~g~z6wcn{Rn}wcnzRn|5Rh%=]nJg5vuRmvNvdRlvcprJu}w*az*a#!%.a.'Bot9qT]kj@Wg'ay2Gzv@Jv`!%b[zEwsfHI}1;ck#Ux`<Cbbx_Lu+w!a&0*!wko*wwo,So,}6Juqxf!E}PigQuyRm`d3(`#8>Rn%:A5B;bZ~%KvhCa!a2!x>k7#Uxb@b{#xaRk7Jw0!)>wwhlShl}6>wwhmShm}6CJvB!.x'hhvj{!!5Bwkhhbaz}x'hivjz~!5Bwkhibaz|xEhTrNu,v-vpD!a%&/)a3a.,%Ro2t[CE{)@3re9b]{%wjo09:rgc:Z&Ro6=<riifuaw&RmoKrNA!%(Ro4>Ro89;Ri`dSaL'UYzxZb)7Rka3xRhT&!,!#^1U}vbaz{>>@=be}yC@:D5bazzKu+A&!}{?ba}y>>@=be}wxBh[t`u~vJvr!%a!a()a,a0a4RoC=]o;Ju(!%RoGRhdwjh`=]oAg>w#Ro?g5vuRo=NvdRl|Ku]C.!&;RoEJvB!%RoORoMBx'h[v+_?w~h`}~5?w~hd~!xKh]oiptu-utv.vp!#%&a30a@a'a+(a/aOp(o~p!RoDJu(!%RoHRhewjha=]oBNvdRl}g>w#Ro@g5vuRo>c[#X']o<CauRoRAd-#Y':RkpauRoQKu]C.!&;RoFJvB!%RoNRoPBx'h]v+_?w~ha}t5?w~he}ue!/UbhYacXaW^Tc&a;b:a-c/#b&aja1(!cL+!bKbt!bmcRc9aIc?8[yW3Dtt94Rg`Jv}!&SiRMzBhEebShEMNuPRe>x7gL#TzuwjirRipc<Z&>on;>z=h-MSh.Mwqczx'a7vj&!>Re4@=ResJt__NuPRi*NuPRi)j]uNr|~FRfzKrJ>_+@Wfy@Wf]2WocKrJ<!+'@Wg%g/QRl@@Jv`!&awRl<wsfFIzgLu(w*!.*&ShBMwvhIRhI9;RhNx1hK'!#Sn]Mx1hK~0!#:2<H~7cNu+w7D*'1ZtW>Rn1~?rOc:Z&Rn2=<rQ<7wjh&=BSnLMc]#X(6Vz)w[b=a!U#9wzgMc3#&(RgMRitRis<x,gKt`ax!&+SioM=BSilMc3#&(RgKRinRimKurB,!&SiQMzBhDebShDM6BJQ!(P~Efx978B2@@=I}WLrJw!!,a*&@G}O@9wkibRid@@x'fKwC!&SlDMSfLMjUv~Q~EfKKv3@a+!(hFv-]mpx/hYZ(C5RiWz<o/MwkhY?So/M@x,gbvfB*&!SgEM:SoeeehFu3:Rgbda(,^TZa)X/7Sg[eb:2RgI~BrMC@wgkc:wwkcRerx3h(uUvK!&*,SnOM4Sh*MArRg;wHRh(x=h;rJvPwI!a4',a'0@Wg&=BSh/Mg>w=Rh=g3w*wwgGRgGcW(X#;Sg}M2Gzk@Jv`!&awRl=wsfGIz`dKZ*T'Y-:RhR7RhQg5u-p`j6v(us5d,#Y+~Awkia?RicOuNBwkibba}Ld6p~tyu_vbAa'a+!a/'a3aEa8a!>Sh,ebJv{!&Sh@ebSaReb9;SgwebNuPRi(NvdRl)NuPRi'hHu^<Rm^Jvv_@Wl(g;u1Si/ebKu'B&!*Sh?eb@Wl'z@aPeb95Si.ebcpputyvjB)!,&a+0a%ShAMWeK@G}C@WfJ9;RhMwvhH9w{ia}ix,hJvRA1(!zAn[MRhHx1hJ~*!#hFv(BSn[MBJQ!(@@=I~'978B2@@=I}2db.Ua<'X}+T#a0XaG2G}E;wkg|wuh!Rh!x,hZu,@)!&So0MVy)C5RiXACJvB!&5RiY5RiZg8w)cG}*T#2@bU}=KsA>(!a.3wkhZba~(x,h^u(A!&(SoCMRhb5Bz=h[eb?w~hb~6x,h_u(A!&(SoDMRhc5Bz=h]eb?w~hc~6e)aA1T#T,^^^c-bMb&blcPaP(a/!0!bA=b5c@a(!bfbrc#2afwmhARnjwchORnp2Wlf3DtsNvdRl-2@wpa<]m0bx(#:awRk2@Jw3!%RfhwpfgRlnKQB%!(G{V@G|'NuuRl6d='T+Y#VyUg<v~Rl~==G|<Jv+'!aYShC}6@B<5?ba~8@Jw3'!g2QRljhLrpWlOd+#Y'g.w'rIg>w*wgj@g-u0Rj@Lu+wT&)ZtUauq]~GrGci&U#F|39:rELrNvj!.%*RhCwunfw~nf~:9;Ri]>wtnhg;wHRnhx3hDs@v~!/+'@Wfr@9RkSNu&Rlo=@<5GzoKs0@_+@Wl+@awRkmJuh!-3d(}pY#qWJvj!%Rm(:Jw3!%Rm,Rm*de&!1U-U#`)Re;@G|.@9Ri82@wjfvRlq=@<5GzpLvOvr!).&2RlF8Rf`C=x!eE{.Jw3_g2QRlkhLrpWlPde(!#U{s,UXa*Ta'[y'g:v>ReS;x0PZ&RnlRnn~HrKJw1}f!=x!eB|2w]aP(#Xa&a*Ta.Ua2a7=]iOd'#Y&Ro&WnWg;u.RiDg6vjRiBNvdRlzhNvj]nYJuW_2Wm3x)kFze{9d])!a.!,Y01!#&aC!a3RndC=ox~BrC@2b^{pg,rlse7x'ksuq!%Rm.E{xidw(wBRmGx9o+)X#wwo-So-}69:Rl4@xSf@a#XZ'X)X,Ta(/ARl8b[xc>RfY:RlI:RfQwlg.ARl:9;Rlwdn'#^XafaQa1X1TaHTa)@b[{zcZ#X'7RkwWg@Ou4ARn&x)kG#{,g7u/RkGdH'U#Y*Vz'Wm&CARm|bx#(A]gUbUzJj9Q~=d,#Y(56H}l978H{U7d,0#U*2>ABb_xZ978BbU{e~AJQ{g!978BbU{hxMh?ad{oUYZ.x1h?{l!#:2<H{mx3n[t{vl!,&a%3Ro(z=iS}6ARnr=Bwsn^wvn`Rnbd`*T}B0!#^X'BG{c9b]{a>>@=be}F?JvS!&BG{d7BG}(Bde#`a1X,Ya@!a'P~=wxf@2bZ}I56B2@@=aybb}08@55B9;5bb}<j3vLv;<Jw3&!>Rfg=ayb^}&OuNBKuLA!)a!P~=x#fD{f2@>==<bbzl?C972@@=Ix^d6rSu,v7w*C(0a)a6#B+a%!sQ[y?3Dt%3[xn~<5rLOu!5p@Ku+D#'!t7~GrP~?rNKvlaya7'!h+v-5qMg=t|cd,U#5AAaa5Abb{S@52B5@a[@52B5Gx[iXueu;d<#`a(!/549C;ag>23ExY5@Dah89b^~689Jv)!~2b[~1Lv'w(%*!a#bX|aPrmawRe]keu7uhv-q6rxu,q`xTo]/a5aU!bNaDXbi!b-!ao!b<bwA!#5@B932:aV2G|:d-)Y#hJrL>RhG<7@C5<H|_=Cau:5aj5@B932:bJ|ng>vIbs)#?C2F|9jPv0w.vISh-MKvUaz(.!9ABbb|[5;5<H|Eg>unwfh;9:4E|YjQsBt|vjx'hYq3!(?C2F|J:2<BaY?C2F|GOu!5x,g|p{ah!-(?C2F|c9:4E|OjXuvvNr}:Rh&i[w*t|cd+U#jJvsu)vsSn~Mkfrmu9p}u7vwv]So!McW#Xa!ax5@A5aY:5;5<H|>kJv~vYrquJu3x4ib#T)2@SmZM?C2F|Bj:rmu9@xPhI(a*a#U#`a3-5Abb|L~@:RhK9:4E|0@52B5G|#C::aY?C2F|-:2<BaY?C2F|.5Jvk!a)javYrquJu3x4ia#T)2@SmYM?C2F|HAxPhH(!a#U#`a*-5Abb|4~@:RhJ9:4E|R@52B5G|F:2<BaY?C2F|Sc^#Xa2j=Qq5CJvB!-g<v{z;hhM?C2F|Zi[vrv{z;hiM?C2F|XKsA>!a)-g<v{z;h[eb?C2F|]i[vrv{z;h]eb?C2F|^iZu.vix,hZq3ah!.(?C2F|QOu!5ShXM:2<BaY?C2F|P", 13494, 2713, 49, 25, 61);

// openclaw/node_modules/.pnpm/entities@8.1.0/node_modules/entities/dist/internal/bin-trie-flags.js
var F;
(function(e) {
  e[e.VALUE_LENGTH = 49152] = "VALUE_LENGTH", e[e.FLAG13 = 8192] = "FLAG13", e[e.BRANCH_LENGTH = 8064] = "BRANCH_LENGTH", e[e.JUMP_TABLE = 127] = "JUMP_TABLE", e[e.VALUE_MASK = 8191] = "VALUE_MASK";
})(F || (F = {}));

// openclaw/node_modules/.pnpm/entities@8.1.0/node_modules/entities/dist/decode.js
var G;
(function(e) {
  e[e.AMP = 38] = "AMP", e[e.NUM = 35] = "NUM", e[e.SEMI = 59] = "SEMI", e[e.EQUALS = 61] = "EQUALS", e[e.ZERO = 48] = "ZERO", e[e.NINE = 57] = "NINE", e[e.LOWER_A = 97] = "LOWER_A", e[e.LOWER_X = 120] = "LOWER_X";
})(G || (G = {}));
var Be = 32, Vt = 21, hi = 2097151, fn = 2047, Kt = 0;
function gi(e) {
  let n = e >>> Vt;
  return n === fn ? Kt : n;
}
function Jt(e) {
  return e - G.ZERO >>> 0 <= 9;
}
function mi(e) {
  return (e | Be) - G.LOWER_A >>> 0 <= 5;
}
function Yt(e) {
  return (e | Be) - G.LOWER_A >>> 0 <= 25;
}
function yi(e) {
  return e === G.EQUALS || Yt(e) || Jt(e);
}
var zt;
(function(e) {
  e[e.EntityStart = 0] = "EntityStart", e[e.NumericStart = 1] = "NumericStart", e[e.NumericDecimal = 2] = "NumericDecimal", e[e.NumericHex = 3] = "NumericHex", e[e.NamedEntity = 4] = "NamedEntity";
})(zt || (zt = {}));
var hn;
(function(e) {
  e[e.Legacy = 0] = "Legacy", e[e.Strict = 1] = "Strict", e[e.Attribute = 2] = "Attribute";
})(hn || (hn = {}));
function bi(e, n, t, r) {
  let o = (n & F.BRANCH_LENGTH) >> 7, i = n & F.JUMP_TABLE;
  if (i) {
    if (o === 0)
      return r === i ? t : -1;
    let u = r - i;
    if (u >>> 0 >= o)
      return -1;
    let d = e[t + u];
    return d === 0 ? -1 : t + o + d - 1 & 65535;
  }
  if (o === 0)
    return -1;
  let s = o + 1 >> 1, a = t + s + o;
  for (let u = 0; u < o; u++) {
    let h = e[t + (u >> 1)] >> ((u & 1) << 3) & 255;
    if (h === r) {
      let g = t + s + u;
      return a + e[g] & 65535;
    }
    if (h > r)
      return -1;
  }
  return -1;
}
function $t(e, n, t) {
  return t === 1 ? String.fromCharCode(e[n] & F.VALUE_MASK) : t === 2 ? String.fromCharCode(e[n + 1]) : String.fromCharCode(e[n + 1], e[n + 2]);
}
function wi(e, n, t) {
  let r = n + 1, o = 0, i = r;
  if (r < t && (e.charCodeAt(r) | Be) === G.LOWER_X)
    for (r += 1, i = r; r < t; ) {
      let a = e.charCodeAt(r);
      if (Jt(a))
        o = o * 16 + (a - G.ZERO);
      else if (mi(a))
        o = o * 16 + ((a | Be) - G.LOWER_A + 10);
      else
        break;
      r += 1;
    }
  else
    for (; r < t; ) {
      let a = e.charCodeAt(r) - G.ZERO;
      if (a >>> 0 > 9)
        break;
      o = o * 10 + a, r += 1;
    }
  if (r === i)
    return 0;
  r < t && e.charCodeAt(r) === G.SEMI && (r += 1), o > 1114111 && (o = 1114112);
  let s = r - n;
  return s >= fn && (Kt = s, s = fn), s << Vt | o;
}
function Ri(e, n, t) {
  let r = qt, o = e.indexOf("&");
  if (o < 0)
    return e;
  let i = e.length, s = 0, a = "", u = r[0], d = u & F.JUMP_TABLE, h = (u & F.BRANCH_LENGTH) >> 7;
  do {
    let g = o + 1, m = e.charCodeAt(g), c, l;
    if (m === G.NUM) {
      let f = wi(e, g, i);
      c = gi(f), n && c > 0 && e.charCodeAt(g + c - 1) !== G.SEMI && (c = 0), l = c === 0 ? "" : Wt(f & hi);
    } else if (Yt(m)) {
      c = 0, l = "";
      let f = m - d, p;
      if (f >>> 0 < h) {
        let k = r[1 + f];
        p = k === 0 ? -1 : h + k & 65535;
      } else
        p = -1;
      let y = 0, b = 0, w = p < 0 ? 0 : r[p], R = g + 1;
      e: for (; R < i; ) {
        for (
          ;
          // Value-less, non-run node with a nonzero jump offset.
          (w & (F.VALUE_LENGTH | F.FLAG13)) === 0 && (w & F.JUMP_TABLE) !== 0;
        ) {
          let v = w & F.JUMP_TABLE, E = (w & F.BRANCH_LENGTH) >> 7;
          if (E === 0) {
            if (e.charCodeAt(R) !== v)
              break e;
            p += 1;
          } else {
            let O = e.charCodeAt(R) - v;
            if (O >>> 0 >= E)
              break e;
            let I = r[p + 1 + O];
            if (I === 0)
              break e;
            p = p + E + I & 65535;
          }
          if (w = r[p], R += 1, R >= i)
            break e;
        }
        if ((w & (F.VALUE_LENGTH | F.FLAG13)) === F.FLAG13) {
          let v = (w & F.BRANCH_LENGTH) >> 7;
          if (e.charCodeAt(R) !== (w & F.JUMP_TABLE))
            break;
          R += 1;
          let E = v - 1, O = p + 1, I = 0;
          for (; I + 1 < E; I += 2) {
            let A = r[O];
            if (e.charCodeAt(R) !== (A & 255) || (R += 1, e.charCodeAt(R) !== (A >> 8 & 255)))
              break e;
            R += 1, O += 1;
          }
          if (I < E) {
            if (e.charCodeAt(R) !== (r[O] & 255))
              break;
            R += 1;
          }
          p += 1 + (v >> 1), w = r[p];
          continue;
        }
        let k = w >>> 14, x = e.charCodeAt(R);
        if (k !== 0) {
          if (x === G.SEMI) {
            c = R - g + 1, l = k === 1 ? String.fromCharCode(w & F.VALUE_MASK) : $t(r, p, k);
            break;
          }
          if (!n && (w & F.FLAG13) === 0 && (c = R - g, y = p, b = k), k === 1)
            break;
        }
        let S = bi(r, w, p + (k || 1), x);
        if (S < 0)
          break;
        p = S, w = r[p], R += 1;
      }
      if (l === "") {
        let k = w >>> 14;
        k !== 0 && !n && (w & F.FLAG13) === 0 && (c = R - g, y = p, b = k), c > 0 && (l = $t(r, y, b));
      }
    } else
      c = 0, l = "";
    c === 0 || t && m !== G.NUM && e.charCodeAt(g + c - 1) !== G.SEMI && g + c < i && yi(e.charCodeAt(g + c)) ? o = g : (s < o && (a += e.slice(s, o)), a += l, o = s = g + c), e.charCodeAt(o) !== G.AMP && (o = e.indexOf("&", o));
  } while (o >= 0);
  return a + e.slice(s);
}
function je(e) {
  return Ri(e, !0, !1);
}

// openclaw/node_modules/.pnpm/entities@8.1.0/node_modules/entities/dist/index.js
var Xt;
(function(e) {
  e[e.XML = 0] = "XML", e[e.HTML = 1] = "HTML";
})(Xt || (Xt = {}));
var Zt;
(function(e) {
  e[e.UTF8 = 0] = "UTF8", e[e.ASCII = 1] = "ASCII", e[e.Extensive = 2] = "Extensive", e[e.Attribute = 3] = "Attribute", e[e.Text = 4] = "Text";
})(Zt || (Zt = {}));

// openclaw/node_modules/.pnpm/linkify-it@6.1.0/node_modules/linkify-it/build/index.mjs
var xi = class {
  src_Any = cn.source;
  src_Cc = ln.source;
  src_Z = dn.source;
  src_P = ke.source;
  src_ZPCc = [
    this.src_Z,
    this.src_P,
    this.src_Cc
  ].join("|");
  src_ZCc = [this.src_Z, this.src_Cc].join("|");
  cache = {};
  opts = {
    maxLength: 1e4,
    urlAuth: !1,
    schema_names: []
  };
  constructor(e = {}) {
    this.opts = {
      ...this.opts,
      ...e
    };
  }
  set(e = {}) {
    return this.opts = {
      ...this.opts,
      ...e
    }, this.cache = {}, this;
  }
  escapeRE(e) {
    return e.replace(/[.?*+^$[\]\\(){}|-]/g, "\\$&");
  }
  nestedPairRE(e, n, t = 4) {
    let r = this.escapeRE(e), o = this.escapeRE(n), i = `(?:(?!${this.src_ZCc}|${r}|${o}).)`, s = `${r}${i}{0,1000}${o}`;
    for (let a = 2; a <= t; a++) s = `${r}(?:${i}|${s}){0,1000}${o}`;
    return s;
  }
  get_text_separators() {
    return this.cache.text_separators ??= /[><\uff5c]/;
  }
  get_pseudo_letter() {
    return this.cache.src_pseudo_letter ??= new RegExp(`(?:(?!${this.get_text_separators().source}|${this.src_ZPCc})${this.src_Any})`);
  }
  get_ipv4_addr() {
    return this.cache.src_ip4 ??= /* @__PURE__ */ new RegExp("(?:(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9][0-9]|[0-9])[.]){3}(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9][0-9]|[0-9])");
  }
  get_ipv6_addr() {
    let e = "[0-9A-Fa-f]{1,4}", n = `(?:(?:${e}:${e})|${this.get_ipv4_addr().source})`;
    return this.cache.src_ip6_addr ??= new RegExp(`(?:(?:${e}:){6}${n}|::(?:${e}:){5}${n}|(?:${e})?::(?:${e}:){4}${n}|(?:(?:${e}:){0,1}${e})?::(?:${e}:){3}${n}|(?:(?:${e}:){0,2}${e})?::(?:${e}:){2}${n}|(?:(?:${e}:){0,3}${e})?::${e}:${n}|(?:(?:${e}:){0,4}${e})?::${n}|(?:(?:${e}:){0,5}${e})?::${e}|(?:(?:${e}:){0,6}${e})?::)`);
  }
  get_ipv6_url_host() {
    return this.cache.src_ip6_host ??= new RegExp(`\\[${this.get_ipv6_addr().source}\\]`);
  }
  get_ipv6_mail_host() {
    return this.cache.src_ipv6_mail_host ??= new RegExp(`\\[IPv6:${this.get_ipv6_addr().source}\\]`);
  }
  get_auth() {
    return this.cache.src_auth ??= new RegExp(`(?:(?:(?!${this.src_ZCc}|[@/\\[\\]()]).){1,50}@)?`);
  }
  get_port() {
    return this.cache.src_port ??= /* @__PURE__ */ new RegExp("(?::(?:6(?:[0-4]\\d{3}|5(?:[0-4]\\d{2}|5(?:[0-2]\\d|3[0-5])))|[1-5]?\\d{1,4}))?");
  }
  get_host_terminator() {
    return this.cache.src_host_terminator ??= new RegExp(`(?=$|${this.get_text_separators().source}|${this.src_ZPCc})(?!${this.opts["---"] ? "-(?!--)|" : "-|"}_|:\\d|\\.-|\\.(?!$|${this.src_ZPCc}))`);
  }
  get_path_terminator() {
    return this.cache.src_path_terminator ??= new RegExp(`${this.src_ZPCc}|${this.get_text_separators().source}`);
  }
  get_path() {
    return this.cache.src_path ??= new RegExp(`(?:[/?#](?:${this.nestedPairRE("[", "]")}|${this.nestedPairRE("(", ")")}|${this.nestedPairRE("{", "}")}|\\"(?:(?!${this.src_ZCc}|["]).){1,100}\\"|\\'(?:(?!${this.src_ZCc}|[']).){1,100}\\'|\\'(?=${this.get_pseudo_letter().source}|[-])|\\.{2,20}[:]?[a-zA-Z0-9%/&]|\\.(?!${this.src_ZCc}|[.]|$)|` + (this.opts["---"] ? "\\-(?!--(?:[^-]|$))(?:-{0,19})|" : "\\-{1,20}|") + `,(?!${this.src_ZCc}|$)|;(?!${this.src_ZCc}|$)|\\!{1,20}(?!${this.src_ZCc}|[!]|$)|\\?(?!${this.src_ZCc}|[?]|$)|` + this.get_path_extra().source + `[\\\\/:%@#&=_~*]|(?!${this.get_path_terminator().source}).){1,${this.opts.maxLength}}|\\/)?`);
  }
  get_mail_name() {
    return this.cache.src_mail_name ??= /* @__PURE__ */ new RegExp("[-!#$%&'*+/=?^_`{|}~a-zA-Z0-9](?:[-!#$%&'*+/=?^_`{|}~a-zA-Z0-9]|[.](?=[-!#$%&'*+/=?^_`{|}~a-zA-Z0-9])){0,63}");
  }
  get_xn() {
    return this.cache.src_xn ??= /* @__PURE__ */ new RegExp("xn--[a-z0-9\\-]{1,59}");
  }
  get_tld() {
    if (this.cache.tld) return this.cache.tld;
    let e = [...new Set(this.opts.tlds || [])].sort().reverse().join("|");
    return this.cache.tld = new RegExp(`${e || "$#none#$"}|${this.get_xn().source}`), this.cache.tld;
  }
  get_domain_root() {
    return this.cache.src_domain_root ??= new RegExp("(?:" + this.get_xn().source + `|${this.get_pseudo_letter().source}{1,63})`);
  }
  get_domain() {
    return this.cache.src_domain ??= new RegExp("(?:" + this.get_xn().source + `|(?:${this.get_pseudo_letter().source})|(?:${this.get_pseudo_letter().source}(?:-|${this.get_pseudo_letter().source}){0,61}${this.get_pseudo_letter().source}))`);
  }
  get_url_host_port() {
    return this.cache.url_host_port ??= new RegExp("(?:" + this.get_ipv6_url_host().source + `|(?:(?:(?:${this.get_domain().source})\\.){0,10}${this.get_domain().source}))` + this.get_port().source + this.get_host_terminator().source);
  }
  get_fuzzy_url_host_port() {
    return this.cache.fuzzy_url_host_port ??= new RegExp("(?:" + (this.opts.fuzzyIP ? this.get_ipv4_addr().source + "|" : "") + `(?:(?:(?:${this.get_domain().source})\\.){1,10}(?:${this.get_tld().source})))` + this.get_host_terminator().source);
  }
  get_mail_host() {
    return this.cache.src_mail_host ??= new RegExp("(?:" + this.get_ipv6_mail_host().source + `|(?:(?:(?:${this.get_domain().source})\\.){0,4}${this.get_domain().source}))` + this.get_host_terminator().source);
  }
  get_fuzzy_mail_host() {
    return this.cache.src_fuzzy_mail_host ??= new RegExp("(?:" + this.get_ipv6_mail_host().source + `|(?:(?:(?:${this.get_domain().source})[.]){1,4}${this.get_domain_root().source}))` + this.get_host_terminator().source);
  }
  get_path_extra() {
    return this.cache.src_path_extra ??= /* @__PURE__ */ new RegExp("");
  }
  get_fuzzy_mail_host_search() {
    return this.cache.mail_fuzzy_host_search ??= new RegExp(`@${this.get_fuzzy_mail_host().source}`, "ig");
  }
  get_fuzzy_link_search() {
    return this.cache.link_fuzzy_search ??= new RegExp(`(^|(?![.:/\\-_@])(?:[$+<=>^\`|\uFF5C]|${this.src_ZPCc}))(?:(?![$+<=>^\`|\uFF5C])${this.get_fuzzy_url_host_port().source}${this.get_path().source})`, "ig");
  }
  get_http_validator() {
    return this.cache.http_validator ??= new RegExp("\\/\\/" + (this.opts.urlAuth ? this.get_auth().source : "") + this.get_url_host_port().source + this.get_path().source, "iy");
  }
  get_relative_proto_validator() {
    return this.cache.relative_proto_validator ??= new RegExp((this.opts.urlAuth ? this.get_auth().source : "") + `(?:localhost|${this.get_ipv6_url_host().source}|(?:(?:${this.get_domain().source})[.]){1,10}${this.get_domain_root().source})` + this.get_port().source + this.get_host_terminator().source + this.get_path().source, "iy");
  }
  get_mail_name_validator() {
    return this.cache.mail_name_validator ??= new RegExp(`(?:^|${this.get_text_separators().source}|"|\\(|${this.src_ZCc})(${this.get_mail_name().source})$`);
  }
  get_mailto_validator() {
    return this.cache.mailto_validator ??= new RegExp(`${this.get_mail_name().source}@${this.get_mail_host().source}`, "iy");
  }
  get_schema_names() {
    return this.cache.schema_names ??= new RegExp((this.opts.schema_names || []).map((e) => this.escapeRE(e)).join("|"));
  }
  get_schema_search() {
    return this.cache.schema_search ??= new RegExp(`(^|(?!_)(?:[><\uFF5C]|${this.src_ZPCc}))(${this.get_schema_names().source})`, "ig");
  }
  get_schema_at_start() {
    return this.cache.schema_at_start ??= new RegExp(`^${this.get_schema_search().source}`, "i");
  }
}, gn = {
  validate: (e, n, t) => {
    let r = t.re.get_http_validator();
    r.lastIndex = n;
    let o = r.exec(e);
    return o ? o[0].length : 0;
  },
  normalize: (e, n) => n.normalize(e)
}, Ci = {
  "http:": gn,
  "https:": gn,
  "ftp:": gn,
  "//": {
    validate: function(e, n, t) {
      let r = t.re.get_relative_proto_validator();
      r.lastIndex = n;
      let o = r.exec(e);
      return o ? n >= 3 && e[n - 3] === ":" || n >= 3 && e[n - 3] === "/" ? 0 : o[0].length : 0;
    },
    normalize: (e, n) => n.normalize(e)
  },
  "mailto:": {
    validate: function(e, n, t) {
      let r = t.re.get_mailto_validator();
      r.lastIndex = n;
      let o = r.exec(e);
      return o ? o[0].length : 0;
    },
    normalize: (e, n) => n.normalize(e)
  }
}, Ti = "a:cdefgilmnoqrstuwxz|b:abdefghijmnorstvwyz|c:acdfghiklmnoruvwxyz|d:ejkmoz|e:cegrstu|f:ijkmor|g:abdefghilmnpqrstuwy|h:kmnrtu|i:delmnoqrst|j:emop|k:eghimnprwyz|l:abcikrstuvy|m:acdeghklmnopqrstuvwxyz|n:acefgilopruz|o:m|p:aefghklmnrstwy|q:a|r:eosuw|s:abcdeghijklmnortuvxyz|t:cdfghjklmnortvwz|u:agksyz|v:aceginu|w:fs|y:et|z:amw", Si = "biz|com|edu|gov|net|org|pro|web|xxx|aero|asia|coop|info|museum|name|shop|\u0440\u0444";
function Ei() {
  let e = Si.split("|");
  return Ti.split("|").forEach((n) => {
    let t = n.indexOf(":"), r = n.slice(0, t);
    for (let o of n.slice(t + 1)) e.push(r + o);
  }), e;
}
var _i = {
  fuzzyLink: !1,
  fuzzyEmail: !0,
  fuzzyIP: !1,
  "---": !1,
  tlds: Ei(),
  urlAuth: !1,
  maxLength: 1e4
}, Qt = class {
  /** Prefix (protocol) for matched string. Empty for fuzzy links. */
  schema;
  /** First position of matched string. */
  index;
  /** Next position after matched string. */
  lastIndex;
  /** Matched string. */
  raw;
  /** Normalized text of matched string. */
  text;
  /** Normalized URL of matched string. */
  url;
  constructor(e, n, t, r) {
    let o = e.slice(t, r);
    this.schema = n.toLowerCase(), this.index = t, this.lastIndex = r, this.raw = o, this.text = o, this.url = o;
  }
}, er = class {
  __opts__;
  __schemas__;
  re;
  /**
  * Creates new linkifier instance.
  *
  * By default understands:
  *
  * - `http(s)://...` , `ftp://...`, `mailto:...` & `//...` links
  * - "fuzzy" emails (foo@bar.com).
  *
  * See {@link LinkifyConstructorOptions} for available options.
  *
  * @param options Recognition options.
  *
  * @example
  * ```javascript
  * import { LinkifyIt } from 'linkify-it'
  *
  * const linkify = new LinkifyIt({ fuzzyLink: true })
  *
  * linkify
  *   .tlds(require('tlds'))       // Reload with full TLD list
  *   .tlds('onion', true)         // Add unofficial `.onion` domain
  *   .add('ftp:', null)           // Disable `ftp:` protocol
  *   .set({ fuzzyIP: true })      // Enable IPs in fuzzy links
  *
  * console.log(linkify.test('Site github.com!')) // true
  * console.log(linkify.match('Site github.com!'))
  * ```
  */
  constructor(e = {}) {
    let { rebuilder: n, ...t } = e;
    this.__opts__ = {
      ..._i,
      ...t
    }, this.__schemas__ = { ...Ci }, this.re = n || new xi(), this.re.set({
      ...this.__opts__,
      schema_names: Object.keys(this.__schemas__)
    });
  }
  /**
  * Add new rule definition.
  *
  * `schema` is a link prefix (usually, protocol name with `:` at the end,
  * `skype:` for example). `linkify-it` makes sure that prefix is not
  * preceded with alphanumeric char and symbols. Only whitespaces and
  * punctuation allowed.
  *
  * `definition` is a rule to check tail after link prefix. To disable an
  * existing rule, pass `null`.
  *
  * @param schema Rule name (fixed pattern prefix).
  * @param definition Schema definition, or `null` to disable the rule.
  *
  * See [twitter mentions example](https://github.com/markdown-it/linkify-it/blob/master/examples/twitter.mjs).
  */
  add(e, n = null) {
    if (!n) delete this.__schemas__[e];
    else {
      let t = {
        normalize: (r, o) => o.normalize(r),
        ...n
      };
      this.__schemas__[e] = t;
    }
    return this.re.set({
      ...this.__opts__,
      schema_names: Object.keys(this.__schemas__)
    }), this;
  }
  /**
  * Set recognition options for links without schema.
  *
  * @param options Recognition options.
  */
  set(e = {}) {
    return this.__opts__ = {
      ...this.__opts__,
      ...e
    }, this.re.set({
      ...this.__opts__,
      schema_names: Object.keys(this.__schemas__)
    }), this;
  }
  /**
  * Searches linkifiable pattern and returns `true` on success or `false` on fail.
  *
  * @param text Text to scan.
  */
  test(e) {
    if (!e.length) return !1;
    let n, t;
    for (t = this.re.get_schema_search(), t.lastIndex = 0; (n = t.exec(e)) !== null; ) if (this.testSchemaAt(e, n[2], t.lastIndex)) return !0;
    if (this.__opts__.fuzzyLink && this.__schemas__["http:"] && (t = this.re.get_fuzzy_link_search(), t.lastIndex = 0, t.exec(e) !== null))
      return !0;
    if (this.__opts__.fuzzyEmail && this.__schemas__["mailto:"] && e.indexOf("@") >= 0) {
      let r = this.re.get_fuzzy_mail_host_search(), o = this.re.get_mail_name_validator();
      for (r.lastIndex = 0; (n = r.exec(e)) !== null; ) {
        let i = e.slice(Math.max(0, n.index - 65), n.index);
        if (o.test(i)) return !0;
      }
    }
    return !1;
  }
  /**
  * Similar to {@link LinkifyIt.test} but checks only specific protocol tail exactly
  * at given position. Returns length of found pattern (0 on fail).
  *
  * @param text Text to scan.
  * @param schema Rule (schema) name.
  * @param pos Text offset to check from.
  */
  testSchemaAt(e, n, t) {
    return this.__schemas__[n.toLowerCase()] ? this.__schemas__[n.toLowerCase()].validate(e.slice(0, t + this.__opts__.maxLength), t, this) : 0;
  }
  /**
  * Returns array of found link descriptions or `null` on fail. We strongly
  * recommend to use {@link LinkifyIt.test} first, for best speed.
  *
  * @param text Text to scan.
  */
  match(e) {
    let n = [], t = this.re.get_schema_search(), r, o, i, s, a, u, d = !1, h = !1, g = !1, m = 0;
    if (!e.length) return null;
    for (t.lastIndex = 0, this.__opts__.fuzzyLink && this.__schemas__["http:"] && (r = this.re.get_fuzzy_link_search(), r.lastIndex = 0), this.__opts__.fuzzyEmail && this.__schemas__["mailto:"] && (o = this.re.get_fuzzy_mail_host_search(), o.lastIndex = 0, i = this.re.get_mail_name_validator()); ; ) {
      let c = Math.max(m - 1, 0);
      if (o && i && !g && (!a || a.index < m))
        for (o.lastIndex < c && (o.lastIndex = c); ; ) {
          let b = o.exec(e);
          if (!b) {
            g = !0, a = void 0;
            break;
          }
          let w = i.exec(e.slice(Math.max(0, b.index - 65), b.index));
          if (w) {
            if (a = {
              schema: "mailto:",
              index: b.index - w[1].length,
              lastIndex: b.index + b[0].length
            }, a.index >= m) break;
            o.lastIndex < c && (o.lastIndex = c);
          }
        }
      if (r && !h && (!s || s.index < m))
        for (r.lastIndex < c && (r.lastIndex = c); ; ) {
          let b = r.exec(e);
          if (!b) {
            h = !0, s = void 0;
            break;
          }
          if (s = {
            schema: "",
            index: b.index + b[1].length,
            lastIndex: b.index + b[0].length
          }, s.index >= m) break;
          r.lastIndex < c && (r.lastIndex = c);
        }
      let l = a;
      (!l || s && (s.index < l.index || s.index === l.index && s.lastIndex > l.lastIndex)) && (l = s);
      let f;
      if (!d) for (; ; ) {
        if (!u) {
          t.lastIndex < c && (t.lastIndex = c);
          let R = t.exec(e);
          if (!R) {
            d = !0;
            break;
          }
          u = {
            schema: R[2],
            index: R.index + R[1].length,
            lastIndex: R.index + R[0].length
          };
        }
        if (u.index < m) {
          u = void 0;
          continue;
        }
        if (l && u.index > l.index) break;
        let b = u;
        u = void 0;
        let w = this.testSchemaAt(e, b.schema, b.lastIndex);
        if (w) {
          f = {
            schema: b.schema,
            index: b.index,
            lastIndex: b.lastIndex + w
          };
          break;
        }
      }
      let p = f;
      if ((!p || a && (a.index < p.index || a.index === p.index && a.lastIndex > p.lastIndex)) && (p = a), (!p || s && (s.index < p.index || s.index === p.index && s.lastIndex > p.lastIndex)) && (p = s), !p) break;
      p === a ? a = void 0 : p === s && (s = void 0);
      let y = new Qt(e, p.schema, p.index, p.lastIndex);
      y.schema ? this.__schemas__[y.schema].normalize(y, this) : this.normalize(y), n.push(y), m = p.lastIndex;
    }
    return n.length ? n : null;
  }
  /**
  * Returns fully-formed (not fuzzy) link if it starts at the beginning
  * of the string, and null otherwise.
  *
  * @param text Text to scan.
  */
  matchAtStart(e) {
    if (!e.length) return null;
    let n = this.re.get_schema_at_start().exec(e);
    if (!n) return null;
    let t = this.testSchemaAt(e, n[2], n[0].length);
    if (!t) return null;
    let r = new Qt(e, n[2], n.index + n[1].length, n.index + n[0].length + t);
    return this.__schemas__[r.schema].normalize(r, this), r;
  }
  /**
  * Load (or merge) new TLDs list. Those are used for fuzzy links (without
  * prefix) to avoid false positives. By default this algorithm is used:
  *
  * - hostname with any 2-letter root zones are ok.
  * - biz|com|edu|gov|net|org|pro|web|xxx|aero|asia|coop|info|museum|name|shop|рф
  *   are ok.
  * - encoded (`xn--...`) root zones are ok.
  *
  * If list is replaced, then exact match for 2-chars root zones will be checked.
  *
  * @param list List of TLDs.
  * @param keepOld Merge with current list if `true` (`false` by default).
  */
  tlds(e, n = !1) {
    return e = Array.isArray(e) ? e : [e], n ? this.__opts__.tlds = this.__opts__.tlds.concat(e) : this.__opts__.tlds = e, this.re.set({
      ...this.__opts__,
      schema_names: Object.keys(this.__schemas__)
    }), this;
  }
  /**
  * Default normalizer (if schema does not define its own).
  *
  * @param match Match to normalize.
  */
  normalize(e) {
    e.schema || (e.url = `http://${e.url}`), e.schema === "mailto:" && !/^mailto:/i.test(e.url) && (e.url = `mailto:${e.url}`);
  }
};

// openclaw/node_modules/.pnpm/markdown-it@15.0.3/node_modules/markdown-it/dist/markdown-it.mjs
var Cn = Mn(cr(), 1);
var lr = Object.defineProperty, kr = (e, n) => {
  let t = {};
  for (var r in e) lr(t, r, {
    get: e[r],
    enumerable: !0
  });
  return n || lr(t, Symbol.toStringTag, { value: "Module" }), t;
}, Ui = /* @__PURE__ */ kr({
  arrayReplaceAt: () => Bi,
  asciiTrim: () => ze,
  callable: () => xr,
  escapeHtml: () => Q,
  escapeRE: () => Ji,
  fromCodePoint: () => Ce,
  isMdAsciiPunct: () => Ee,
  isPunctChar: () => Tr,
  isPunctCharCode: () => Se,
  isSpace: () => P,
  isValidEntityCode: () => Tn,
  isWhiteSpace: () => Te,
  lib: () => Yi,
  normalizeReference: () => qe,
  unescapeAll: () => fe,
  unescapeMd: () => Hi
});
function xr(e) {
  let n = function(...t) {
    return Reflect.construct(e, t, new.target && new.target !== n ? new.target : e);
  };
  return Object.defineProperty(n, "name", { value: e.name }), Object.setPrototypeOf(n, e), n.prototype = e.prototype, n;
}
function Bi(e, n, t) {
  return [].concat(e.slice(0, n), t, e.slice(n + 1));
}
function Tn(e) {
  return !(e >= 55296 && e <= 57343 || e >= 64976 && e <= 65007 || (e & 65535) === 65535 || (e & 65535) === 65534 || e >= 0 && e <= 8 || e === 11 || e >= 14 && e <= 31 || e >= 127 && e <= 159 || e > 1114111);
}
function Ce(e) {
  if (e > 65535) {
    e -= 65536;
    let n = 55296 + (e >> 10), t = 56320 + (e & 1023);
    return String.fromCharCode(n, t);
  }
  return String.fromCharCode(e);
}
var Cr = /\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, ji = new RegExp(`${Cr.source}|${/&([a-z#][a-z0-9]{1,31});/gi.source}`, "gi"), Gi = /^#((?:x[a-f0-9]{1,8}|[0-9]{1,8}))$/i;
function Wi(e, n) {
  if (n.charCodeAt(0) === 35 && Gi.test(n)) {
    let r = n[1].toLowerCase() === "x" ? parseInt(n.slice(2), 16) : parseInt(n.slice(1), 10);
    return Tn(r) ? Ce(r) : e;
  }
  let t = je(e);
  return t !== e ? t : e;
}
function Hi(e) {
  return e.indexOf("\\") < 0 ? e : e.replace(Cr, "$1");
}
function fe(e) {
  return e.indexOf("\\") < 0 && e.indexOf("&") < 0 ? e : e.replace(ji, function(n, t, r) {
    return t || Wi(n, r);
  });
}
var qi = /[&<>"]/, zi = /[&<>"]/g, $i = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;"
};
function Vi(e) {
  return $i[e];
}
function Q(e) {
  return qi.test(e) ? e.replace(zi, Vi) : e;
}
var Ki = /[.?*+^$[\]\\(){}|-]/g;
function Ji(e) {
  return e.replace(Ki, "\\$&");
}
function P(e) {
  switch (e) {
    case 9:
    case 32:
      return !0;
  }
  return !1;
}
function Te(e) {
  if (e >= 8192 && e <= 8202) return !0;
  switch (e) {
    case 9:
    case 10:
    case 11:
    case 12:
    case 13:
    case 32:
    case 160:
    case 5760:
    case 8239:
    case 8287:
    case 12288:
      return !0;
  }
  return !1;
}
function Tr(e) {
  return ke.test(e) || un.test(e);
}
function Se(e) {
  return Tr(Ce(e));
}
function Ee(e) {
  switch (e) {
    case 33:
    case 34:
    case 35:
    case 36:
    case 37:
    case 38:
    case 39:
    case 40:
    case 41:
    case 42:
    case 43:
    case 44:
    case 45:
    case 46:
    case 47:
    case 58:
    case 59:
    case 60:
    case 61:
    case 62:
    case 63:
    case 64:
    case 91:
    case 92:
    case 93:
    case 94:
    case 95:
    case 96:
    case 123:
    case 124:
    case 125:
    case 126:
      return !0;
    default:
      return !1;
  }
}
function qe(e) {
  return e = e.trim().replace(/\s+/g, " "), e.toLowerCase().toUpperCase();
}
function ur(e) {
  return e === 32 || e === 9 || e === 10 || e === 13;
}
function ze(e) {
  let n = 0;
  for (; n < e.length && ur(e.charCodeAt(n)); n++) ;
  let t = e.length - 1;
  for (; t >= n && ur(e.charCodeAt(t)); t--) ;
  return e.slice(n, t + 1);
}
var Yi = {
  mdurl: an,
  ucmicro: pn
};
function Xi(e, n, t) {
  let r, o, i, s, a = e.posMax, u = e.pos;
  for (e.pos = n + 1, r = 1; e.pos < a; ) {
    if (i = e.src.charCodeAt(e.pos), i === 93 && (r--, r === 0)) {
      o = !0;
      break;
    }
    if (s = e.pos, e.md.inline.skipToken(e), i === 91) {
      if (s === e.pos - 1) r++;
      else if (t)
        return e.pos = u, -1;
    }
  }
  let d = -1;
  return o && (d = e.pos), e.pos = u, d;
}
function Zi(e, n, t) {
  let r, o = n, i = {
    ok: !1,
    pos: 0,
    str: ""
  };
  if (e.charCodeAt(o) === 60) {
    for (o++; o < t; ) {
      if (r = e.charCodeAt(o), r === 10 || r === 60) return i;
      if (r === 62)
        return i.pos = o + 1, i.str = fe(e.slice(n + 1, o)), i.ok = !0, i;
      if (r === 92 && o + 1 < t) {
        o += 2;
        continue;
      }
      o++;
    }
    return i;
  }
  let s = 0;
  for (; o < t && (r = e.charCodeAt(o), !(r === 32 || r < 32 || r === 127)); ) {
    if (r === 92 && o + 1 < t) {
      if (e.charCodeAt(o + 1) === 32) {
        o++;
        continue;
      }
      o += 2;
      continue;
    }
    if (r === 40 && (s++, s > 32))
      return i;
    if (r === 41) {
      if (s === 0) break;
      s--;
    }
    o++;
  }
  return n === o || s !== 0 || (i.str = fe(e.slice(n, o)), i.pos = o, i.ok = !0), i;
}
function Qi(e, n, t, r) {
  let o, i = n, s = {
    ok: !1,
    can_continue: !1,
    pos: 0,
    str: "",
    marker: 0
  };
  if (r)
    s.str = r.str, s.marker = r.marker;
  else {
    if (i >= t) return s;
    let a = e.charCodeAt(i);
    if (a !== 34 && a !== 39 && a !== 40) return s;
    n++, i++, a === 40 && (a = 41), s.marker = a;
  }
  for (; i < t; ) {
    if (o = e.charCodeAt(i), o === s.marker)
      return s.pos = i + 1, s.str += fe(e.slice(n, i)), s.ok = !0, s;
    if (o === 40 && s.marker === 41) return s;
    o === 92 && i + 1 < t && i++, i++;
  }
  return s.can_continue = !0, s.str += fe(e.slice(n, i)), s;
}
var es = /* @__PURE__ */ kr({
  parseLinkDestination: () => Zi,
  parseLinkLabel: () => Xi,
  parseLinkTitle: () => Qi
});
function _e(e) {
  "@babel/helpers - typeof";
  return _e = typeof Symbol == "function" && typeof Symbol.iterator == "symbol" ? function(n) {
    return typeof n;
  } : function(n) {
    return n && typeof Symbol == "function" && n.constructor === Symbol && n !== Symbol.prototype ? "symbol" : typeof n;
  }, _e(e);
}
function ns(e, n) {
  if (_e(e) != "object" || !e) return e;
  var t = e[Symbol.toPrimitive];
  if (t !== void 0) {
    var r = t.call(e, n || "default");
    if (_e(r) != "object") return r;
    throw new TypeError("@@toPrimitive must return a primitive value.");
  }
  return (n === "string" ? String : Number)(e);
}
function ts(e) {
  var n = ns(e, "string");
  return _e(n) == "symbol" ? n : n + "";
}
function C(e, n, t) {
  return (n = ts(n)) in e ? Object.defineProperty(e, n, {
    value: t,
    enumerable: !0,
    configurable: !0,
    writable: !0
  }) : e[n] = t, e;
}
var ce = class {
  constructor(e, n, t) {
    C(
      this,
      /**
      * Source map info. Format: `[ line_begin, line_end ]`
      */
      "map",
      null
    ), C(
      this,
      /**
      * nesting level, the same as `state.level`
      */
      "level",
      0
    ), C(
      this,
      /**
      * An array of child nodes (inline and img tokens)
      */
      "children",
      null
    ), C(
      this,
      /**
      * In a case of self-closing tag (code, html, fence, etc.),
      * it has contents of this tag.
      */
      "content",
      ""
    ), C(
      this,
      /**
      * '*' or '_' for emphasis, fence string for fence, etc.
      */
      "markup",
      ""
    ), C(
      this,
      /**
      * Additional information:
      *
      * - Info string for "fence" tokens
      * - The value "auto" for autolink "link_open" and "link_close" tokens
      * - The string value of the item marker for ordered-list "list_item_open" tokens
      */
      "info",
      ""
    ), C(
      this,
      /**
      * True for block-level tokens, false for inline tokens.
      * Used in renderer to calculate line breaks
      */
      "block",
      !1
    ), C(
      this,
      /**
      * If it's true, ignore this element when rendering. Used for tight lists
      * to hide paragraphs.
      */
      "hidden",
      !1
    ), this.type = e, this.tag = n, this.attrs = null, this.nesting = t, this.meta = null;
  }
  /**
  * Search attribute index by name.
  */
  attrIndex(e) {
    if (!this.attrs) return -1;
    let n = this.attrs;
    for (let t = 0, r = n.length; t < r; t++) if (n[t][0] === e) return t;
    return -1;
  }
  /**
  * Add `[ name, value ]` attribute to list. Init attrs if necessary
  */
  attrPush(e) {
    this.attrs ? this.attrs.push(e) : this.attrs = [e];
  }
  /**
  * Set `name` attribute to `value`. Override old value if exists.
  */
  attrSet(e, n) {
    let t = this.attrIndex(e), r = [e, n];
    t < 0 ? this.attrPush(r) : this.attrs[t] = r;
  }
  /**
  * Get the value of attribute `name`, or null if it does not exist.
  */
  attrGet(e) {
    let n = this.attrIndex(e), t = null;
    return n >= 0 && (t = this.attrs[n][1]), t;
  }
  /**
  * Join value to existing attribute via space. Or create new attribute if not
  * exists. Useful to operate with token classes.
  */
  attrJoin(e, n) {
    let t = this.attrIndex(e);
    t < 0 ? this.attrPush([e, n]) : this.attrs[t][1] = `${this.attrs[t][1]} ${n}`;
  }
}, Ie = class {
  constructor() {
    C(
      this,
      /** @internal */
      "__rules__",
      []
    ), C(
      this,
      /** @internal */
      "__cache__",
      null
    );
  }
  /** @internal */
  __find__(e) {
    for (let n = 0; n < this.__rules__.length; n++) if (this.__rules__[n].name === e) return n;
    return -1;
  }
  /** @internal */
  __compile__() {
    let e = /* @__PURE__ */ new Set();
    this.__rules__.forEach((n) => {
      n.enabled && n.alt.forEach((t) => {
        t && e.add(t);
      });
    }), this.__cache__ = /* @__PURE__ */ Object.create(null), this.__cache__[""] = [], this.__rules__.forEach((n) => {
      n.enabled && this.__cache__[""].push(n.fn);
    }), e.forEach((n) => {
      this.__cache__[n] = [], this.__rules__.forEach((t) => {
        t.enabled && t.alt.indexOf(n) >= 0 && this.__cache__[n].push(t.fn);
      });
    });
  }
  /**
  * Replace rule by name with new function & options. Throws error if name not
  * found.
  *
  * @example Replace existing typographer replacement rule with new one
  * ```javascript
  * import MarkdownIt from 'markdown-it'
  * const md = new MarkdownIt()
  *
  * md.core.ruler.at('replacements', function replace(state) {
  *   //...
  * });
  * ```
  */
  at(e, n, t = {}) {
    let r = this.__find__(e);
    if (r === -1) throw new Error(`Parser rule not found: ${e}`);
    this.__rules__[r].fn = n, this.__rules__[r].alt = t.alt || [], this.__cache__ = null;
  }
  /**
  * Add new rule to chain before one with given name. See also
  * {@link Ruler.after}, {@link Ruler.push}.
  *
  * @example
  * ```javascript
  * import MarkdownIt from 'markdown-it'
  * const md = new MarkdownIt()
  *
  * md.block.ruler.before('paragraph', 'my_rule', function replace(state) {
  *   //...
  * });
  * ```
  */
  before(e, n, t, r = {}) {
    let o = this.__find__(e);
    if (o === -1) throw new Error(`Parser rule not found: ${e}`);
    this.__rules__.splice(o, 0, {
      name: n,
      enabled: !0,
      fn: t,
      alt: r.alt || []
    }), this.__cache__ = null;
  }
  /**
  * Add new rule to chain after one with given name. See also
  * {@link Ruler.before}, {@link Ruler.push}.
  *
  * @example
  * ```javascript
  * import MarkdownIt from 'markdown-it'
  * const md = new MarkdownIt()
  *
  * md.inline.ruler.after('text', 'my_rule', function replace(state) {
  *   //...
  * });
  * ```
  */
  after(e, n, t, r = {}) {
    let o = this.__find__(e);
    if (o === -1) throw new Error(`Parser rule not found: ${e}`);
    this.__rules__.splice(o + 1, 0, {
      name: n,
      enabled: !0,
      fn: t,
      alt: r.alt || []
    }), this.__cache__ = null;
  }
  /**
  * Push new rule to the end of chain. See also
  * {@link Ruler.before}, {@link Ruler.after}.
  *
  * @example
  * ```javascript
  * import MarkdownIt from 'markdown-it'
  * const md = new MarkdownIt()
  *
  * md.core.ruler.push('my_rule', function replace(state) {
  *   //...
  * });
  * ```
  */
  push(e, n, t = {}) {
    this.__rules__.push({
      name: e,
      enabled: !0,
      fn: n,
      alt: t.alt || []
    }), this.__cache__ = null;
  }
  /**
  * Enable rules with given names. If any rule name not found - throw Error.
  * Errors can be disabled by second param.
  *
  * See also {@link Ruler.disable}, {@link Ruler.enableOnly}.
  *
  * Returns list of found rule names (if no exception happened).
  */
  enable(e, n = !1) {
    Array.isArray(e) || (e = [e]);
    let t = [];
    return e.forEach((r) => {
      let o = this.__find__(r);
      if (o < 0) {
        if (n) return;
        throw new Error(`Rules manager: invalid rule name ${r}`);
      }
      this.__rules__[o].enabled = !0, t.push(r);
    }), this.__cache__ = null, t;
  }
  /**
  * Enable rules with given names, and disable everything else. If any rule name
  * not found - throw Error. Errors can be disabled by second param.
  *
  * See also {@link Ruler.disable}, {@link Ruler.enable}.
  */
  enableOnly(e, n = !1) {
    Array.isArray(e) || (e = [e]), this.__rules__.forEach((t) => {
      t.enabled = !1;
    }), this.enable(e, n);
  }
  /**
  * Disable rules with given names. If any rule name not found - throw Error.
  * Errors can be disabled by second param.
  *
  * See also {@link Ruler.enable}, {@link Ruler.enableOnly}.
  *
  * Returns list of found rule names (if no exception happened).
  */
  disable(e, n = !1) {
    Array.isArray(e) || (e = [e]);
    let t = [];
    return e.forEach((r) => {
      let o = this.__find__(r);
      if (o < 0) {
        if (n) return;
        throw new Error(`Rules manager: invalid rule name ${r}`);
      }
      this.__rules__[o].enabled = !1, t.push(r);
    }), this.__cache__ = null, t;
  }
  /**
  * Return array of active functions (rules) for given chain name. It analyzes
  * rules configuration, compiles caches if not exists and returns result.
  *
  * Default chain name is `''` (empty string). It can't be skipped. That's
  * done intentionally, to keep signature monomorphic for high speed.
  */
  getRules(e) {
    return this.__cache__ || this.__compile__(), this.__cache__[e] || [];
  }
}, J = {};
J.code_inline = function(e, n, t, r, o) {
  let i = e[n];
  return `<code${o.renderAttrs(i)}>${Q(i.content)}</code>`;
};
J.code_block = function(e, n, t, r, o) {
  let i = e[n];
  return `<pre${o.renderAttrs(i)}><code>${Q(e[n].content)}</code></pre>
`;
};
J.fence = function(e, n, t, r, o) {
  let i = e[n], s = i.info ? fe(i.info).trim() : "", a = "", u = "";
  if (s) {
    let h = s.split(/(\s+)/g);
    a = h[0], u = h.slice(2).join("");
  }
  let d;
  if (t.highlight ? d = t.highlight(i.content, a, u) || Q(i.content) : d = Q(i.content), d.indexOf("<pre") === 0) return d + `
`;
  if (s) {
    let h = i.attrIndex("class"), g = i.attrs ? i.attrs.slice() : [];
    h < 0 ? g.push(["class", `${t.langPrefix}${a}`]) : (g[h] = [g[h][0], g[h][1]], g[h][1] += ` ${t.langPrefix}${a}`);
    let m = { attrs: g };
    return `<pre><code${o.renderAttrs(m)}>${d}</code></pre>
`;
  }
  return `<pre><code${o.renderAttrs(i)}>${d}</code></pre>
`;
};
J.image = function(e, n, t, r, o) {
  let i = e[n];
  return i.attrs[i.attrIndex("alt")][1] = o.renderInlineAsText(i.children, t, r), o.renderToken(e, n, t);
};
J.hardbreak = function(e, n, t) {
  return t.xhtmlOut ? `<br />
` : `<br>
`;
};
J.softbreak = function(e, n, t) {
  return t.breaks ? t.xhtmlOut ? `<br />
` : `<br>
` : `
`;
};
J.text = function(e, n) {
  return Q(e[n].content);
};
J.html_block = function(e, n) {
  return e[n].content;
};
J.html_inline = function(e, n) {
  return e[n].content;
};
var Sr = class {
  constructor() {
    C(
      this,
      /**
      * Contains render rules for tokens. Can be updated and extended.
      *
      * See [source code](https://github.com/markdown-it/markdown-it/blob/master/src/renderer.ts)
      * for more details and examples.
      *
      * @example Custom render rules
      * ```javascript
      * import MarkdownIt from 'markdown-it'
      * const md = new MarkdownIt()
      *
      * md.renderer.rules.strong_open  = function () { return '<b>'; };
      * md.renderer.rules.strong_close = function () { return '</b>'; };
      *
      * const result = md.renderInline(...);
      * ```
      *
      * @example Each rule is called as independent static function with fixed signature
      * ```javascript
      * function my_token_render(tokens, idx, options, env, renderer) {
      *   // ...
      *   return renderedHTML;
      * }
      * ```
      */
      "rules",
      Object.assign({}, J)
    );
  }
  /**
  * Render token attributes to string.
  */
  renderAttrs(e) {
    let n, t, r;
    if (!e.attrs) return "";
    for (r = "", n = 0, t = e.attrs.length; n < t; n++) r += ` ${Q(e.attrs[n][0])}="${Q(String(e.attrs[n][1]))}"`;
    return r;
  }
  /**
  * Default token renderer. Can be overriden by custom function
  * in {@link Renderer.rules}.
  */
  renderToken(e, n, t) {
    let r = e[n], o = "";
    if (r.hidden) return "";
    let i = n - 1;
    for (; i >= 0 && e[i].hidden && e[i].nesting === 0; ) i--;
    r.block && r.nesting !== -1 && i >= 0 && e[i].hidden && e[i].nesting === -1 && (o += `
`), o += (r.nesting === -1 ? "</" : "<") + r.tag, o += this.renderAttrs(r), r.nesting === 0 && t.xhtmlOut && (o += " /");
    let s = !1;
    if (r.block && (s = !0, r.nesting === 1)) {
      let a = n + 1;
      for (; a < e.length && e[a].hidden && e[a].nesting === 0; ) a++;
      if (a < e.length) {
        let u = e[a];
        (u.type === "inline" || u.hidden || u.nesting === -1 && u.tag === r.tag) && (s = !1);
      }
    }
    return o += s ? `>
` : ">", o;
  }
  /**
  * The same as {@link Renderer.render}, but for single token of `inline` type.
  */
  renderInline(e, n, t) {
    let r = "", o = this.rules;
    for (let i = 0, s = e.length; i < s; i++) {
      let a = e[i].type;
      typeof o[a] < "u" ? r += o[a](e, i, n, t, this) : r += this.renderToken(e, i, n);
    }
    return r;
  }
  /**
  * Special kludge for image `alt` attributes to conform CommonMark spec.
  * Don't try to use it! Spec requires to show `alt` content with stripped markup,
  * instead of simple escaping.
  */
  renderInlineAsText(e, n, t) {
    let r = "";
    for (let o = 0, i = e.length; o < i; o++) switch (e[o].type) {
      case "text":
      case "code_inline":
        r += e[o].content;
        break;
      case "image":
        r += this.renderInlineAsText(e[o].children, n, t);
        break;
      case "html_inline":
      case "html_block":
        r += e[o].content;
        break;
      case "softbreak":
      case "hardbreak":
        r += `
`;
    }
    return r;
  }
  /**
  * Takes token stream and generates HTML. Probably, you will never need to call
  * this method directly.
  */
  render(e, n, t) {
    let r = "", o = this.rules;
    for (let i = 0, s = e.length; i < s; i++) {
      let a = e[i].type;
      a === "inline" ? r += this.renderInline(e[i].children, n, t) : typeof o[a] < "u" ? r += o[a](e, i, n, t, this) : r += this.renderToken(e, i, n);
    }
    return r;
  }
}, Er = class {
  constructor(e, n, t) {
    C(this, "tokens", []), C(this, "inlineMode", !1), C(this, "Token", ce), this.src = e, this.env = t, this.md = n;
  }
}, rs = /\r\n?/g, os = /\0/g;
function is(e) {
  let n;
  n = e.src.replace(rs, `
`), n = n.replace(os, "\uFFFD"), e.src = n;
}
function ss(e) {
  let n;
  e.inlineMode ? (n = new e.Token("inline", "", 0), n.content = e.src, n.map = [0, 1], n.children = [], e.tokens.push(n)) : e.md.block.parse(e.src, e.md, e.env, e.tokens);
}
function as(e) {
  let n = e.tokens, t = 0;
  for (let r = 0; r < n.length; r++)
    n[r].type !== "reference_definition" && (r !== t && (n[t] = n[r]), t++);
  n.length !== t && (n.length = t);
}
function cs(e) {
  let n = e.tokens;
  for (let t = 0, r = n.length; t < r; t++) {
    let o = n[t];
    o.type === "inline" && e.md.inline.parse(o.content, e.md, e.env, o.children);
  }
}
function ls(e) {
  return /^<a[>\s]/i.test(e);
}
function us(e) {
  return /^<\/a\s*>/i.test(e);
}
function ds(e) {
  let n = e.tokens;
  if (e.md.options.linkify)
    for (let t = 0, r = n.length; t < r; t++) {
      if (n[t].type !== "inline" || !e.md.linkify.test(n[t].content)) continue;
      let o = n[t].children, i = [], s = 0;
      for (let a = o.length - 1; a >= 0; a--) {
        let u = o[a];
        if (u.type === "link_close") {
          for (a--; o[a].level !== u.level && o[a].type !== "link_open"; ) a--;
          continue;
        }
        if (u.type === "html_inline" && (ls(u.content) && s > 0 && s--, us(u.content) && s++), !(s > 0) && u.type === "text" && e.md.linkify.test(u.content)) {
          let d = u.content, h = e.md.linkify.match(d), g = [], m = u.level, c = 0;
          h.length > 0 && h[0].index === 0 && a > 0 && o[a - 1].type === "text_special" && (h = h.slice(1));
          for (let l = 0; l < h.length; l++) {
            let f = h[l].url, p = e.md.normalizeLink(f);
            if (!e.md.validateLink(p)) continue;
            let y = h[l].text;
            h[l].schema ? h[l].schema === "mailto:" && !/^mailto:/i.test(y) ? y = e.md.normalizeLinkText(`mailto:${y}`).replace(/^mailto:/, "") : y = e.md.normalizeLinkText(y) : y = e.md.normalizeLinkText(`http://${y}`).replace(/^http:\/\//, "");
            let b = h[l].index;
            if (b > c) {
              let x = new e.Token("text", "", 0);
              x.content = d.slice(c, b), x.level = m, g.push(x);
            }
            let w = new e.Token("link_open", "a", 1);
            w.attrs = [["href", p]], w.level = m++, w.markup = "linkify", w.info = "auto", g.push(w);
            let R = new e.Token("text", "", 0);
            R.content = y, R.level = m, g.push(R);
            let k = new e.Token("link_close", "a", -1);
            k.level = --m, k.markup = "linkify", k.info = "auto", g.push(k), c = h[l].lastIndex;
          }
          if (c < d.length) {
            let l = new e.Token("text", "", 0);
            l.content = d.slice(c), l.level = m, g.push(l);
          }
          i.push({
            index: a,
            nodes: g
          });
        }
      }
      if (i.length > 0) {
        let a = o.length;
        for (let g of i) a += g.nodes.length - 1;
        let u = new Array(a), d = 0, h = 0;
        i.reverse();
        for (let g = 0; g < o.length; g++) {
          let m = i[d];
          if (m?.index === g) {
            for (let c of m.nodes) u[h++] = c;
            d++;
          } else u[h++] = o[g];
        }
        n[t].children = u;
      }
    }
}
var _r = /\+-|\.\.|\?\?\?\?|!!!!|,,|--/, ps = /\((c|tm|r)\)/i, fs = /\((c|tm|r)\)/gi, hs = {
  c: "\xA9",
  r: "\xAE",
  tm: "\u2122"
};
function gs(e, n) {
  return hs[n.toLowerCase()];
}
function ms(e) {
  let n = 0;
  for (let t = e.length - 1; t >= 0; t--) {
    let r = e[t];
    r.type === "text" && !n && (r.content = r.content.replace(fs, gs)), r.type === "link_open" && r.info === "auto" && n--, r.type === "link_close" && r.info === "auto" && n++;
  }
}
function ys(e) {
  let n = 0;
  for (let t = e.length - 1; t >= 0; t--) {
    let r = e[t];
    r.type === "text" && !n && _r.test(r.content) && (r.content = r.content.replace(/\+-/g, "\xB1").replace(/\.{2,}/g, "\u2026").replace(/([?!])…/g, "$1..").replace(/([?!]){4,}/g, "$1$1$1").replace(/,{2,}/g, ",").replace(/(^|[^-])---(?=[^-]|$)/gm, "$1\u2014").replace(/(^|\s)--(?=\s|$)/gm, "$1\u2013").replace(/(^|[^-\s])--(?=[^-\s]|$)/gm, "$1\u2013")), r.type === "link_open" && r.info === "auto" && n--, r.type === "link_close" && r.info === "auto" && n++;
  }
}
function bs(e) {
  let n;
  if (e.md.options.typographer)
    for (n = e.tokens.length - 1; n >= 0; n--)
      e.tokens[n].type === "inline" && (ps.test(e.tokens[n].content) && ms(e.tokens[n].children), _r.test(e.tokens[n].content) && ys(e.tokens[n].children));
}
var ws = /['"]/, dr = /['"]/g, pr = "\u2019", Rs = 1e3;
function fr(e, n, t) {
  for (; e.length > t; ) {
    let r = e.pop();
    r.isSingleQuote ? n.single = r.prevSameQuoteIdx : n.double = r.prevSameQuoteIdx;
  }
}
function Ge(e, n, t, r) {
  e[n] || (e[n] = []), e[n].push({
    pos: t,
    ch: r
  });
}
function ks(e, n) {
  let t = "", r = 0;
  n.sort((o, i) => o.pos - i.pos);
  for (let o = 0; o < n.length; o++) {
    let i = n[o];
    t += e.slice(r, i.pos) + i.ch, r = i.pos + 1;
  }
  return t + e.slice(r);
}
function xs(e, n) {
  let t, r = [], o = {
    single: -1,
    double: -1
  }, i = {};
  for (let s = 0; s < e.length; s++) {
    let a = e[s], u = e[s].level;
    for (t = r.length - 1; t >= 0 && !(r[t].level <= u); t--) ;
    if (fr(r, o, t + 1), a.type !== "text") continue;
    let d = a.content, h = 0, g = d.length;
    e: for (; h < g; ) {
      dr.lastIndex = h;
      let m = dr.exec(d);
      if (!m) break;
      let c = !0, l = !0;
      h = m.index + 1;
      let f = m[0] === "'", p = 32;
      if (m.index - 1 >= 0) p = d.charCodeAt(m.index - 1);
      else for (t = s - 1; t >= 0 && !(e[t].type === "softbreak" || e[t].type === "hardbreak"); t--)
        if (e[t].content) {
          p = e[t].content.charCodeAt(e[t].content.length - 1);
          break;
        }
      let y = 32;
      if (h < g) y = d.charCodeAt(h);
      else for (t = s + 1; t < e.length && !(e[t].type === "softbreak" || e[t].type === "hardbreak"); t++)
        if (e[t].content) {
          y = e[t].content.charCodeAt(0);
          break;
        }
      let b = Ee(p) || Se(p), w = Ee(y) || Se(y), R = Te(p), k = Te(y);
      if (k ? c = !1 : w && (R || b || (c = !1)), R ? l = !1 : b && (k || w || (l = !1)), y === 34 && m[0] === '"' && p >= 48 && p <= 57 && (l = c = !1), c && l && (c = b, l = w), !c && !l) {
        f && Ge(i, s, m.index, pr);
        continue;
      }
      if (l && (t = f ? o.single : o.double, t >= 0 && r[t].level === u)) {
        let x = r[t], S, v;
        f ? (S = n.md.options.quotes[2], v = n.md.options.quotes[3]) : (S = n.md.options.quotes[0], v = n.md.options.quotes[1]), Ge(i, s, m.index, v), Ge(i, x.tokenIdx, x.contentPos, S), fr(r, o, t);
        continue e;
      }
      if (c) {
        if (r.length >= Rs) return;
        r.push({
          tokenIdx: s,
          contentPos: m.index,
          isSingleQuote: f,
          level: u,
          prevSameQuoteIdx: f ? o.single : o.double
        }), f ? o.single = r.length - 1 : o.double = r.length - 1;
      } else l && f && Ge(i, s, m.index, pr);
    }
  }
  Object.keys(i).forEach(function(s) {
    let a = Number(s);
    e[a].content = ks(e[a].content, i[s]);
  });
}
function Cs(e) {
  if (e.md.options.typographer)
    for (let n = e.tokens.length - 1; n >= 0; n--)
      e.tokens[n].type !== "inline" || !ws.test(e.tokens[n].content) || xs(e.tokens[n].children, e);
}
function Ts(e) {
  let n, t, r = e.length;
  for (n = 0; n < r; n++) e[n].type === "text_special" && (e[n].type = "text");
  for (n = t = 0; n < r; n++) e[n].type === "text" && n + 1 < r && e[n + 1].type === "text" ? e[n + 1].content = e[n].content + e[n + 1].content : (n !== t && (e[t] = e[n]), t++);
  n !== t && (e.length = t);
}
function Ss(e) {
  let n, t, r = e.tokens, o = r.length;
  for (let i = 0; i < o; i++) {
    if (r[i].type !== "inline") continue;
    let s = r[i].children, a = s.length;
    for (n = 0; n < a; n++)
      s[n].type === "text_special" && (s[n].type = "text"), s[n].children && Ts(s[n].children);
    for (n = t = 0; n < a; n++) s[n].type === "text" && n + 1 < a && s[n + 1].type === "text" ? s[n + 1].content = s[n].content + s[n + 1].content : (n !== t && (s[t] = s[n]), t++);
    n !== t && (s.length = t);
  }
}
var bn = [
  ["normalize", is],
  ["block", ss],
  ["strip_references", as],
  ["inline", cs],
  ["linkify", ds],
  ["replacements", bs],
  ["smartquotes", Cs],
  ["text_join", Ss]
], Ir = class {
  constructor() {
    C(
      this,
      /**
      * {@link Ruler} instance. Keep configuration of core rules.
      */
      "ruler",
      new Ie()
    ), C(this, "State", Er);
    for (let e = 0; e < bn.length; e++) this.ruler.push(bn[e][0], bn[e][1]);
  }
  /**
  * Executes core chain rules.
  */
  process(e) {
    let n = this.ruler.getRules("");
    for (let t = 0, r = n.length; t < r; t++) n[t](e);
  }
}, Ar = class {
  constructor(e, n, t, r) {
    C(this, "bMarks", []), C(this, "eMarks", []), C(this, "tShift", []), C(this, "sCount", []), C(this, "bsCount", []), C(this, "blkIndent", 0), C(this, "line", 0), C(this, "lineMax", 0), C(this, "tight", !1), C(this, "listIndent", -1), C(this, "parentType", "root"), C(this, "level", 0), C(this, "Token", ce), this.src = e, this.md = n, this.env = t, this.tokens = r;
    let o = this.src;
    for (let i = 0, s = 0, a = 0, u = 0, d = o.length, h = !1; s < d; s++) {
      let g = o.charCodeAt(s);
      if (!h)
        if (P(g)) {
          a++, g === 9 ? u += 4 - u % 4 : u++;
          continue;
        } else h = !0;
      (g === 10 || s === d - 1) && (g !== 10 && s++, this.bMarks.push(i), this.eMarks.push(s), this.tShift.push(a), this.sCount.push(u), this.bsCount.push(0), h = !1, a = 0, u = 0, i = s + 1);
    }
    this.bMarks.push(o.length), this.eMarks.push(o.length), this.tShift.push(0), this.sCount.push(0), this.bsCount.push(0), this.lineMax = this.bMarks.length - 1;
  }
  push(e, n, t) {
    let r = new ce(e, n, t);
    return r.block = !0, t < 0 && this.level--, r.level = this.level, t > 0 && this.level++, this.tokens.push(r), r;
  }
  isEmpty(e) {
    return this.bMarks[e] + this.tShift[e] >= this.eMarks[e];
  }
  skipEmptyLines(e) {
    for (let n = this.lineMax; e < n && !(this.bMarks[e] + this.tShift[e] < this.eMarks[e]); e++) ;
    return e;
  }
  skipSpaces(e) {
    for (let n = this.src.length; e < n && P(this.src.charCodeAt(e)); e++) ;
    return e;
  }
  skipSpacesBack(e, n) {
    if (e <= n) return e;
    for (; e > n; ) if (!P(this.src.charCodeAt(--e))) return e + 1;
    return e;
  }
  skipChars(e, n) {
    for (let t = this.src.length; e < t && this.src.charCodeAt(e) === n; e++) ;
    return e;
  }
  skipCharsBack(e, n, t) {
    if (e <= t) return e;
    for (; e > t; ) if (n !== this.src.charCodeAt(--e)) return e + 1;
    return e;
  }
  getLines(e, n, t, r) {
    if (e >= n) return "";
    let o = new Array(n - e);
    for (let i = 0, s = e; s < n; s++, i++) {
      let a = 0, u = this.bMarks[s], d = u, h;
      for (s + 1 < n || r ? h = this.eMarks[s] + 1 : h = this.eMarks[s]; d < h && a < t; ) {
        let g = this.src.charCodeAt(d);
        if (P(g))
          g === 9 ? a += 4 - (a + this.bsCount[s]) % 4 : a++;
        else if (d - u < this.tShift[s]) a++;
        else break;
        d++;
      }
      a > t ? o[i] = new Array(a - t + 1).join(" ") + this.src.slice(d, h) : o[i] = this.src.slice(d, h);
    }
    return o.join("");
  }
}, Es = 65536;
function wn(e, n) {
  let t = e.bMarks[n] + e.tShift[n], r = e.eMarks[n];
  return e.src.slice(t, r);
}
function hr(e) {
  let n = [], t = e.length, r = 0, o = e.charCodeAt(r), i = !1, s = 0, a = "";
  for (; r < t; )
    o === 124 && (i ? (a += e.substring(s, r - 1), s = r) : (n.push(a + e.substring(s, r)), a = "", s = r + 1)), i = o === 92, r++, o = e.charCodeAt(r);
  return n.push(a + e.substring(s)), n;
}
function _s(e, n, t, r) {
  if (n + 2 > t) return !1;
  let o = n + 1;
  if (e.sCount[o] < e.blkIndent || e.sCount[o] - e.blkIndent >= 4) return !1;
  let i = e.bMarks[o] + e.tShift[o];
  if (i >= e.eMarks[o]) return !1;
  let s = e.src.charCodeAt(i++);
  if (s !== 124 && s !== 45 && s !== 58 || i >= e.eMarks[o]) return !1;
  let a = e.src.charCodeAt(i++);
  if (a !== 124 && a !== 45 && a !== 58 && !P(a) || s === 45 && P(a)) return !1;
  for (; i < e.eMarks[o]; ) {
    let R = e.src.charCodeAt(i);
    if (R !== 124 && R !== 45 && R !== 58 && !P(R)) return !1;
    i++;
  }
  let u = wn(e, n + 1), d = u.split("|"), h = [];
  for (let R = 0; R < d.length; R++) {
    let k = d[R].trim();
    if (!k) {
      if (R === 0 || R === d.length - 1) continue;
      return !1;
    }
    if (!/^:?-+:?$/.test(k)) return !1;
    k.charCodeAt(k.length - 1) === 58 ? h.push(k.charCodeAt(0) === 58 ? "center" : "right") : k.charCodeAt(0) === 58 ? h.push("left") : h.push("");
  }
  if (u = wn(e, n).trim(), u.indexOf("|") === -1 || e.sCount[n] - e.blkIndent >= 4) return !1;
  d = hr(u), d.length && d[0] === "" && d.shift(), d.length && d[d.length - 1] === "" && d.pop();
  let g = d.length;
  if (g === 0 || g !== h.length) return !1;
  if (r) return !0;
  let m = e.parentType;
  e.parentType = "table";
  let c = e.md.block.ruler.getRules("blockquote"), l = e.push("table_open", "table", 1), f = [n, 0];
  l.map = f;
  let p = e.push("thead_open", "thead", 1);
  p.map = [n, n + 1];
  let y = e.push("tr_open", "tr", 1);
  y.map = [n, n + 1];
  for (let R = 0; R < d.length; R++) {
    let k = e.push("th_open", "th", 1);
    h[R] && (k.attrs = [["style", `text-align:${h[R]}`]]);
    let x = e.push("inline", "", 0);
    x.content = d[R].trim(), x.children = [], e.push("th_close", "th", -1);
  }
  e.push("tr_close", "tr", -1), e.push("thead_close", "thead", -1);
  let b, w = 0;
  for (o = n + 2; o < t && !(e.sCount[o] < e.blkIndent); o++) {
    let R = !1;
    for (let x = 0, S = c.length; x < S; x++) if (c[x](e, o, t, !0)) {
      R = !0;
      break;
    }
    if (R || (u = wn(e, o).trim(), !u) || e.sCount[o] - e.blkIndent >= 4 || (d = hr(u), d.length && d[0] === "" && d.shift(), d.length && d[d.length - 1] === "" && d.pop(), w += g - d.length, w > Es)) break;
    if (o === n + 2) {
      let x = e.push("tbody_open", "tbody", 1);
      x.map = b = [n + 2, 0];
    }
    let k = e.push("tr_open", "tr", 1);
    k.map = [o, o + 1];
    for (let x = 0; x < g; x++) {
      let S = e.push("td_open", "td", 1);
      h[x] && (S.attrs = [["style", `text-align:${h[x]}`]]);
      let v = e.push("inline", "", 0);
      v.content = d[x] ? d[x].trim() : "", v.children = [], e.push("td_close", "td", -1);
    }
    e.push("tr_close", "tr", -1);
  }
  return b && (e.push("tbody_close", "tbody", -1), b[1] = o), e.push("table_close", "table", -1), f[1] = o, e.parentType = m, e.line = o, !0;
}
function Is(e, n, t) {
  if (e.sCount[n] - e.blkIndent < 4) return !1;
  let r = n + 1, o = r;
  for (; r < t; ) {
    if (e.isEmpty(r)) {
      r++;
      continue;
    }
    if (e.sCount[r] - e.blkIndent >= 4) {
      r++, o = r;
      continue;
    }
    break;
  }
  e.line = o;
  let i = e.push("code_block", "code", 0);
  return i.content = e.getLines(n, o, 4 + e.blkIndent, !1) + `
`, i.map = [n, e.line], !0;
}
function As(e, n, t, r) {
  let o = e.bMarks[n] + e.tShift[n], i = e.eMarks[n];
  if (e.sCount[n] - e.blkIndent >= 4 || o + 3 > i) return !1;
  let s = e.src.charCodeAt(o);
  if (s !== 126 && s !== 96) return !1;
  let a = o;
  o = e.skipChars(o, s);
  let u = o - a;
  if (u < 3) return !1;
  let d = e.src.slice(a, o), h = e.src.slice(o, i);
  if (s === 96 && h.indexOf(String.fromCharCode(s)) >= 0)
    return !1;
  if (r) return !0;
  let g = n, m = !1;
  for (; g++, !(g >= t || (o = a = e.bMarks[g] + e.tShift[g], i = e.eMarks[g], o < i && e.sCount[g] < e.blkIndent)); )
    if (e.src.charCodeAt(o) === s && !(e.sCount[g] - e.blkIndent >= 4) && (o = e.skipChars(o, s), !(o - a < u) && (o = e.skipSpaces(o), !(o < i)))) {
      m = !0;
      break;
    }
  u = e.sCount[n], e.line = g + (m ? 1 : 0);
  let c = e.push("fence", "code", 0);
  return c.info = h, c.content = e.getLines(n + 1, g, u, !0), c.markup = d, c.map = [n, e.line], !0;
}
function vs(e, n, t, r) {
  let o = e.bMarks[n] + e.tShift[n], i = e.eMarks[n], s = e.lineMax;
  if (e.sCount[n] - e.blkIndent >= 4 || e.src.charCodeAt(o) !== 62) return !1;
  if (r) return !0;
  let a = [], u = [], d = [], h = [], g = e.md.block.ruler.getRules("blockquote"), m = e.parentType;
  e.parentType = "blockquote";
  let c = !1, l;
  for (l = n; l < t; l++) {
    let w = e.sCount[l] < e.blkIndent;
    if (o = e.bMarks[l] + e.tShift[l], i = e.eMarks[l], o >= i) break;
    if (e.src.charCodeAt(o++) === 62 && !w) {
      let k = e.sCount[l] + 1, x, S;
      e.src.charCodeAt(o) === 32 ? (o++, k++, S = !1, x = !0) : e.src.charCodeAt(o) === 9 ? (x = !0, (e.bsCount[l] + k) % 4 === 3 ? (o++, k++, S = !1) : S = !0) : x = !1;
      let v = k;
      for (a.push(e.bMarks[l]), e.bMarks[l] = o; o < i; ) {
        let E = e.src.charCodeAt(o);
        if (P(E))
          E === 9 ? v += 4 - (v + e.bsCount[l] + (S ? 1 : 0)) % 4 : v++;
        else break;
        o++;
      }
      c = o >= i, u.push(e.bsCount[l]), e.bsCount[l] = e.sCount[l] + 1 + (x ? 1 : 0), d.push(e.sCount[l]), e.sCount[l] = v - k, h.push(e.tShift[l]), e.tShift[l] = o - e.bMarks[l];
      continue;
    }
    if (c) break;
    let R = !1;
    for (let k = 0, x = g.length; k < x; k++) if (g[k](e, l, t, !0)) {
      R = !0;
      break;
    }
    if (R) {
      e.lineMax = l, e.blkIndent !== 0 && (a.push(e.bMarks[l]), u.push(e.bsCount[l]), h.push(e.tShift[l]), d.push(e.sCount[l]), e.sCount[l] -= e.blkIndent);
      break;
    }
    a.push(e.bMarks[l]), u.push(e.bsCount[l]), h.push(e.tShift[l]), d.push(e.sCount[l]), e.sCount[l] = -1;
  }
  let f = e.blkIndent;
  e.blkIndent = 0;
  let p = e.push("blockquote_open", "blockquote", 1);
  p.markup = ">";
  let y = [n, 0];
  p.map = y, e.md.block.tokenize(e, n, l);
  let b = e.push("blockquote_close", "blockquote", -1);
  b.markup = ">", e.lineMax = s, e.parentType = m, y[1] = e.line;
  for (let w = 0; w < h.length; w++)
    e.bMarks[w + n] = a[w], e.tShift[w + n] = h[w], e.sCount[w + n] = d[w], e.bsCount[w + n] = u[w];
  return e.blkIndent = f, !0;
}
function Ms(e, n, t, r) {
  let o = e.eMarks[n];
  if (e.sCount[n] - e.blkIndent >= 4) return !1;
  let i = e.bMarks[n] + e.tShift[n], s = e.src.charCodeAt(i++);
  if (s !== 42 && s !== 45 && s !== 95) return !1;
  let a = 1;
  for (; i < o; ) {
    let d = e.src.charCodeAt(i++);
    if (d !== s && !P(d)) return !1;
    d === s && a++;
  }
  if (a < 3) return !1;
  if (r) return !0;
  e.line = n + 1;
  let u = e.push("hr", "hr", 0);
  return u.map = [n, e.line], u.markup = Array(a + 1).join(String.fromCharCode(s)), !0;
}
function gr(e, n) {
  let t = e.eMarks[n], r = e.bMarks[n] + e.tShift[n], o = e.src.charCodeAt(r++);
  return o !== 42 && o !== 45 && o !== 43 || r < t && !P(e.src.charCodeAt(r)) ? -1 : r;
}
function mr(e, n) {
  let t = e.bMarks[n] + e.tShift[n], r = e.eMarks[n], o = t;
  if (o + 1 >= r) return -1;
  let i = e.src.charCodeAt(o++);
  if (i < 48 || i > 57) return -1;
  for (; ; ) {
    if (o >= r) return -1;
    if (i = e.src.charCodeAt(o++), i >= 48 && i <= 57) {
      if (o - t >= 10) return -1;
      continue;
    }
    if (i === 41 || i === 46) break;
    return -1;
  }
  return o < r && (i = e.src.charCodeAt(o), !P(i)) ? -1 : o;
}
function Ds(e, n) {
  let t = e.level + 2;
  for (let r = n + 2, o = e.tokens.length - 2; r < o; r++) e.tokens[r].level === t && e.tokens[r].type === "paragraph_open" && (e.tokens[r + 2].hidden = !0, e.tokens[r].hidden = !0, r += 2);
}
function Ps(e, n, t, r) {
  let o, i, s, a, u = n, d = !0;
  if (e.sCount[u] - e.blkIndent >= 4 || e.listIndent >= 0 && e.sCount[u] - e.listIndent >= 4 && e.sCount[u] < e.blkIndent) return !1;
  let h = !1;
  r && e.parentType === "paragraph" && e.sCount[u] >= e.blkIndent && (h = !0);
  let g, m, c;
  if ((c = mr(e, u)) >= 0) {
    if (g = !0, s = e.bMarks[u] + e.tShift[u], m = Number(e.src.slice(s, c - 1)), h && m !== 1) return !1;
  } else if ((c = gr(e, u)) >= 0) g = !1;
  else return !1;
  if (h && e.skipSpaces(c) >= e.eMarks[u])
    return !1;
  if (r) return !0;
  let l = e.src.charCodeAt(c - 1), f = e.tokens.length;
  g ? (a = e.push("ordered_list_open", "ol", 1), m !== 1 && (a.attrs = [["start", m]])) : a = e.push("bullet_list_open", "ul", 1);
  let p = [u, 0];
  a.map = p, a.markup = String.fromCharCode(l);
  let y = !1, b = e.md.block.ruler.getRules("list"), w = e.parentType;
  for (e.parentType = "list"; u < t; ) {
    i = c, o = e.eMarks[u];
    let R = e.sCount[u] + c - (e.bMarks[u] + e.tShift[u]), k = R;
    for (; i < o; ) {
      let q = e.src.charCodeAt(i);
      if (q === 9) k += 4 - (k + e.bsCount[u]) % 4;
      else if (q === 32) k++;
      else break;
      i++;
    }
    let x = i, S;
    x >= o ? S = 1 : S = k - R, S > 4 && (S = 1);
    let v = R + S;
    a = e.push("list_item_open", "li", 1), a.markup = String.fromCharCode(l);
    let E = [u, 0];
    a.map = E, g && (a.info = e.src.slice(s, c - 1));
    let O = e.tight, I = e.tShift[u], A = e.sCount[u], W = e.listIndent;
    if (e.listIndent = e.blkIndent, e.blkIndent = v, e.tight = !0, e.tShift[u] = x - e.bMarks[u], e.sCount[u] = k, x >= o && e.isEmpty(u + 1) ? e.line = Math.min(e.line + 2, t) : e.md.block.tokenize(e, u, t), (!e.tight || y) && (d = !1), y = e.line - u > 1 && e.isEmpty(e.line - 1), e.blkIndent = e.listIndent, e.listIndent = W, e.tShift[u] = I, e.sCount[u] = A, e.tight = O, a = e.push("list_item_close", "li", -1), a.markup = String.fromCharCode(l), u = e.line, E[1] = u, u >= t || e.sCount[u] < e.blkIndent || e.sCount[u] - e.blkIndent >= 4) break;
    let H = !1;
    for (let q = 0, mo = b.length; q < mo; q++) if (b[q](e, u, t, !0)) {
      H = !0;
      break;
    }
    if (H) break;
    if (g) {
      if (c = mr(e, u), c < 0) break;
      s = e.bMarks[u] + e.tShift[u];
    } else if (c = gr(e, u), c < 0) break;
    if (l !== e.src.charCodeAt(c - 1)) break;
  }
  return g ? a = e.push("ordered_list_close", "ol", -1) : a = e.push("bullet_list_close", "ul", -1), a.markup = String.fromCharCode(l), p[1] = u, e.line = u, e.parentType = w, d && Ds(e, f), !0;
}
var Rn = 999;
function Os(e) {
  let n = e.length;
  for (let t = 0; t < e.length - 1; t++) {
    let r = e.charCodeAt(t);
    if (r < 55296 || r > 56319) continue;
    let o = e.charCodeAt(t + 1);
    o >= 56320 && o <= 57343 && (n--, t++);
  }
  return n;
}
function xe(e, n) {
  return Math.min(e.eMarks[n] + 1, e.src.length);
}
function We(e, n) {
  let t = e.lineMax;
  if (n >= t || e.isEmpty(n)) return -1;
  let r = !1;
  if (e.sCount[n] - e.blkIndent > 3 && (r = !0), e.sCount[n] < 0 && (r = !0), !r) {
    let o = e.md.block.ruler.getRules("reference"), i = e.parentType;
    e.parentType = "reference";
    let s = !1;
    for (let a = 0, u = o.length; a < u; a++) if (o[a](e, n, t, !0)) {
      s = !0;
      break;
    }
    if (e.parentType = i, s) return -1;
  }
  return e.bMarks[n] + e.tShift[n];
}
function Ns(e, n, t, r) {
  let o = e.src, i = e.bMarks[n] + e.tShift[n], s = n + 1;
  if (e.sCount[n] - e.blkIndent >= 4 || o.charCodeAt(i) !== 91) return !1;
  let a = xe(e, n), u = "", d = -1, h = ++i;
  for (; i < a; ) {
    if (u.length + i - h > Rn * 2) return !1;
    let x = o.charCodeAt(i);
    if (x === 91) return !1;
    if (x === 93) {
      d = i;
      break;
    }
    if (x === 92 && (x = o.charCodeAt(++i)), x === 10 && i < a) {
      let S = We(e, s);
      if (S < 0) return !1;
      u += o.slice(h, a), i = h = S, a = xe(e, s++);
      continue;
    }
    i++;
  }
  if (d < 0 || o.charCodeAt(d + 1) !== 58 || (u += o.slice(h, d), u.length > Rn && Os(u) > Rn)) return !1;
  for (i = d + 2; i < a; ) {
    let x = o.charCodeAt(i);
    if (x === 10) {
      let S = We(e, s);
      if (S < 0) break;
      i = S, a = xe(e, s++);
    } else if (P(x)) i++;
    else break;
  }
  let g = e.md.helpers.parseLinkDestination(o, i, a);
  if (!g.ok) return !1;
  let m = e.md.normalizeLink(g.str);
  if (!e.md.validateLink(m)) return !1;
  i = g.pos;
  let c = i, l = a, f = s;
  for (; i < a; ) {
    let x = o.charCodeAt(i);
    if (x === 10) {
      let S = We(e, s);
      if (S < 0) break;
      i = S, a = xe(e, s++);
    } else if (P(x)) i++;
    else break;
  }
  let p = i, y = e.md.helpers.parseLinkTitle(o, i, a);
  for (; y.can_continue; ) {
    let x = We(e, s);
    if (x < 0) break;
    i = x, a = xe(e, s++), y = e.md.helpers.parseLinkTitle(o, i, a, y);
  }
  let b;
  for (p !== c && y.ok ? (b = y.str, i = y.pos) : (b = "", i = c, a = l, s = f); i < a && P(o.charCodeAt(i)); )
    i++;
  if (i < a && o.charCodeAt(i) !== 10 && b)
    for (b = "", i = c, a = l, s = f; i < a && P(o.charCodeAt(i)); )
      i++;
  if (i < a && o.charCodeAt(i) !== 10) return !1;
  let w = qe(u);
  if (!w) return !1;
  if (r) return !0;
  typeof e.env.references > "u" && (e.env.references = {}), typeof e.env.references[w] > "u" && (e.env.references[w] = {
    title: b,
    href: m
  });
  let R = e.push("reference_definition", "", 0);
  R.map = [n, s], R.hidden = !0;
  let k = /* @__PURE__ */ Object.create(null);
  return k.label = w, R.meta = k, e.line = s, !0;
}
var Fs = [
  "address",
  "article",
  "aside",
  "base",
  "basefont",
  "blockquote",
  "body",
  "caption",
  "center",
  "col",
  "colgroup",
  "dd",
  "details",
  "dialog",
  "dir",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "frame",
  "frameset",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "head",
  "header",
  "hr",
  "html",
  "iframe",
  "legend",
  "li",
  "link",
  "main",
  "menu",
  "menuitem",
  "nav",
  "noframes",
  "ol",
  "optgroup",
  "option",
  "p",
  "param",
  "search",
  "section",
  "summary",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "title",
  "tr",
  "track",
  "ul"
], vr = `<[A-Za-z][A-Za-z0-9\\-]*(?:\\s+[a-zA-Z_:][a-zA-Z0-9:._-]*(?:\\s*=\\s*(?:[^"'=<>\`\\x00-\\x20]+|'[^']*'|"[^"]*"))?)*\\s*\\/?>`, Mr = "<\\/[A-Za-z][A-Za-z0-9\\-]*\\s*>";
new RegExp(`^(?:${vr}|${Mr}|<!---?>|<!--(?:[^-]|-[^-]|--[^>])*-->|<[?][\\s\\S]*?[?]>|<![A-Za-z][^>]*>|<!\\[CDATA\\[[\\s\\S]*?\\]\\]>)`);
var Dr = new RegExp(`^(?:${vr}|${Mr})`), ae = [
  [
    /^<(script|pre|style|textarea)(?=(\s|>|$))/i,
    /<\/(script|pre|style|textarea)>/i,
    !0
  ],
  [
    /^<!--/,
    /-->/,
    !0
  ],
  [
    /^<\?/,
    /\?>/,
    !0
  ],
  [
    /^<![A-Za-z]/,
    />/,
    !0
  ],
  [
    /^<!\[CDATA\[/,
    /\]\]>/,
    !0
  ],
  [
    new RegExp(`^</?(${Fs.join("|")})(?=(\\s|/?>|$))`, "i"),
    /^$/,
    !0
  ],
  [
    new RegExp(`${Dr.source}\\s*$`),
    /^$/,
    !1
  ]
];
function Ls(e, n, t, r) {
  let o = e.bMarks[n] + e.tShift[n], i = e.eMarks[n];
  if (e.sCount[n] - e.blkIndent >= 4 || !e.md.options.html || e.src.charCodeAt(o) !== 60) return !1;
  let s = e.src.slice(o, i), a = 0;
  for (; a < ae.length && !ae[a][0].test(s); a++) ;
  if (a === ae.length) return !1;
  if (r) return ae[a][2];
  let u = n + 1, d = ae[a][1].test("");
  if (!ae[a][1].test(s)) {
    for (; u < t && !(e.sCount[u] < e.blkIndent && (d || !e.isEmpty(u))); u++)
      if (o = e.bMarks[u] + e.tShift[u], i = e.eMarks[u], s = e.src.slice(o, i), ae[a][1].test(s)) {
        s.length !== 0 && u++;
        break;
      }
  }
  e.line = u;
  let h = e.push("html_block", "", 0);
  return h.map = [n, u], h.content = e.getLines(n, u, e.blkIndent, !0), !0;
}
function Us(e, n, t, r) {
  let o = e.bMarks[n] + e.tShift[n], i = e.eMarks[n];
  if (e.sCount[n] - e.blkIndent >= 4) return !1;
  let s = e.src.charCodeAt(o);
  if (s !== 35 || o >= i) return !1;
  let a = 1;
  for (s = e.src.charCodeAt(++o); s === 35 && o < i && a <= 6; )
    a++, s = e.src.charCodeAt(++o);
  if (a > 6 || o < i && !P(s)) return !1;
  if (r) return !0;
  i = e.skipSpacesBack(i, o);
  let u = e.skipCharsBack(i, 35, o);
  u > o && P(e.src.charCodeAt(u - 1)) && (i = u), e.line = n + 1;
  let d = e.push("heading_open", `h${a}`, 1);
  d.markup = "########".slice(0, a), d.map = [n, e.line];
  let h = e.push("inline", "", 0);
  h.content = ze(e.src.slice(o, i)), h.map = [n, e.line], h.children = [];
  let g = e.push("heading_close", `h${a}`, -1);
  return g.markup = "########".slice(0, a), !0;
}
function Bs(e, n, t) {
  let r = e.md.block.ruler.getRules("paragraph");
  if (e.sCount[n] - e.blkIndent >= 4) return !1;
  let o = e.parentType;
  e.parentType = "paragraph";
  let i = 0, s, a = n + 1;
  for (; a < t && !e.isEmpty(a); a++) {
    if (e.sCount[a] - e.blkIndent > 3) continue;
    if (e.sCount[a] >= e.blkIndent) {
      let c = e.bMarks[a] + e.tShift[a], l = e.eMarks[a];
      if (c < l && (s = e.src.charCodeAt(c), (s === 45 || s === 61) && (c = e.skipChars(c, s), c = e.skipSpaces(c), c >= l))) {
        i = s === 61 ? 1 : 2;
        break;
      }
    }
    if (e.sCount[a] < 0) continue;
    let m = !1;
    for (let c = 0, l = r.length; c < l; c++) if (r[c](e, a, t, !0)) {
      m = !0;
      break;
    }
    if (m) break;
  }
  if (!i)
    return e.parentType = o, !1;
  let u = ze(e.getLines(n, a, e.blkIndent, !1));
  e.line = a + 1;
  let d = e.push("heading_open", `h${i}`, 1);
  d.markup = String.fromCharCode(s), d.map = [n, e.line];
  let h = e.push("inline", "", 0);
  h.content = u, h.map = [n, e.line - 1], h.children = [];
  let g = e.push("heading_close", `h${i}`, -1);
  return g.markup = String.fromCharCode(s), e.parentType = o, !0;
}
function js(e, n, t) {
  let r = e.md.block.ruler.getRules("paragraph"), o = e.parentType, i = n + 1;
  for (e.parentType = "paragraph"; i < t && !e.isEmpty(i); i++) {
    if (e.sCount[i] - e.blkIndent > 3 || e.sCount[i] < 0) continue;
    let d = !1;
    for (let h = 0, g = r.length; h < g; h++) if (r[h](e, i, t, !0)) {
      d = !0;
      break;
    }
    if (d) break;
  }
  let s = ze(e.getLines(n, i, e.blkIndent, !1));
  e.line = i;
  let a = e.push("paragraph_open", "p", 1);
  a.map = [n, e.line];
  let u = e.push("inline", "", 0);
  return u.content = s, u.map = [n, e.line], u.children = [], e.push("paragraph_close", "p", -1), e.parentType = o, !0;
}
var He = [
  [
    "table",
    _s,
    ["paragraph", "reference"]
  ],
  ["code", Is],
  [
    "fence",
    As,
    [
      "paragraph",
      "reference",
      "blockquote",
      "list"
    ]
  ],
  [
    "blockquote",
    vs,
    [
      "paragraph",
      "reference",
      "blockquote",
      "list"
    ]
  ],
  [
    "hr",
    Ms,
    [
      "paragraph",
      "reference",
      "blockquote",
      "list"
    ]
  ],
  [
    "list",
    Ps,
    [
      "paragraph",
      "reference",
      "blockquote"
    ]
  ],
  ["reference", Ns],
  [
    "html_block",
    Ls,
    [
      "paragraph",
      "reference",
      "blockquote"
    ]
  ],
  [
    "heading",
    Us,
    [
      "paragraph",
      "reference",
      "blockquote"
    ]
  ],
  ["lheading", Bs],
  ["paragraph", js]
], Pr = class {
  constructor() {
    C(
      this,
      /**
      * {@link Ruler} instance. Keep configuration of block rules.
      */
      "ruler",
      new Ie()
    ), C(this, "State", Ar);
    for (let e = 0; e < He.length; e++) this.ruler.push(He[e][0], He[e][1], { alt: (He[e][2] || []).slice() });
  }
  tokenize(e, n, t) {
    let r = this.ruler.getRules(""), o = r.length, i = e.md.options.maxNesting, s = n, a = !1;
    for (; s < t && (e.line = s = e.skipEmptyLines(s), !(s >= t || e.sCount[s] < e.blkIndent)); ) {
      if (e.level >= i) {
        e.line = t;
        break;
      }
      let u = e.line, d = !1;
      for (let h = 0; h < o; h++)
        if (d = r[h](e, s, t, !1), d) {
          if (u >= e.line) throw new Error("block rule didn't increment state.line");
          break;
        }
      if (!d) throw new Error("none of the block rules matched");
      e.tight = !a, e.isEmpty(e.line - 1) && (a = !0), s = e.line, s < t && e.isEmpty(s) && (a = !0, s++, e.line = s);
    }
  }
  /**
  * Process input string and push block tokens into `outTokens`
  */
  parse(e, n, t, r) {
    if (!e) return;
    let o = new this.State(e, n, t, r);
    this.tokenize(o, o.line, o.lineMax);
  }
}, Or = class {
  constructor(e, n, t, r) {
    C(this, "pos", 0), C(this, "level", 0), C(this, "pending", ""), C(this, "pendingLevel", 0), C(this, "cache", {}), C(this, "backticks", {}), C(this, "backticksScanned", !1), C(this, "skipHtmlSpecial", !1), C(this, "linkLevel", 0), C(this, "delimiters", []), C(this, "_prev_delimiters", []), C(this, "Token", ce), this.src = e, this.env = t, this.md = n, this.tokens = r, this.tokens_meta = Array(r.length), this.posMax = this.src.length;
  }
  pushPending() {
    let e = new ce("text", "", 0);
    return e.content = this.pending, e.level = this.pendingLevel, this.tokens.push(e), this.pending = "", e;
  }
  push(e, n, t) {
    this.pending && this.pushPending();
    let r = new ce(e, n, t), o;
    return t < 0 && (this.level--, this.delimiters = this._prev_delimiters.pop()), r.level = this.level, t > 0 && (this.level++, this._prev_delimiters.push(this.delimiters), this.delimiters = [], o = { delimiters: this.delimiters }), this.pendingLevel = this.level, this.tokens.push(r), this.tokens_meta.push(o), r;
  }
  scanDelims(e, n) {
    let t = this.posMax, r = this.src.charCodeAt(e), o;
    if (e === 0) o = 32;
    else if (e === 1)
      o = this.src.charCodeAt(0), (o & 63488) === 55296 && (o = 65533);
    else if (o = this.src.charCodeAt(e - 1), (o & 64512) === 56320) {
      let l = this.src.charCodeAt(e - 2);
      o = (l & 64512) === 55296 ? 65536 + (l - 55296 << 10) + (o - 56320) : 65533;
    } else (o & 64512) === 55296 && (o = 65533);
    let i = e;
    for (; i < t && this.src.charCodeAt(i) === r; ) i++;
    let s = i - e, a = i < t ? this.src.charCodeAt(i) : 32;
    if ((a & 64512) === 55296) {
      let l = this.src.charCodeAt(i + 1);
      a = (l & 64512) === 56320 ? 65536 + (a - 55296 << 10) + (l - 56320) : 65533;
    } else (a & 64512) === 56320 && (a = 65533);
    let u = Ee(o) || Se(o), d = Ee(a) || Se(a), h = Te(o), g = Te(a), m = !g && (!d || h || u), c = !h && (!u || g || d);
    return {
      can_open: m && (n || !c || u),
      can_close: c && (n || !m || d),
      length: s
    };
  }
};
function Gs(e) {
  switch (e) {
    case 10:
    case 33:
    case 35:
    case 36:
    case 37:
    case 38:
    case 42:
    case 43:
    case 45:
    case 58:
    case 60:
    case 61:
    case 62:
    case 64:
    case 91:
    case 92:
    case 93:
    case 94:
    case 95:
    case 96:
    case 123:
    case 125:
    case 126:
      return !0;
    default:
      return !1;
  }
}
function Ws(e, n) {
  let t = e.pos;
  for (; t < e.posMax && !Gs(e.src.charCodeAt(t)); ) t++;
  return t === e.pos ? !1 : (n || (e.pending += e.src.slice(e.pos, t)), e.pos = t, !0);
}
function Hs(e) {
  return e >= 65 && e <= 90 || e >= 97 && e <= 122;
}
function qs(e) {
  return e >= 65 && e <= 90 || e >= 97 && e <= 122 || e >= 48 && e <= 57 || e === 43 || e === 45 || e === 46;
}
function zs(e, n) {
  if (!e.md.options.linkify || e.linkLevel > 0) return !1;
  let t = e.pos, r = e.posMax;
  if (t + 3 > r || e.src.charCodeAt(t) !== 58 || e.src.charCodeAt(t + 1) !== 47 || e.src.charCodeAt(t + 2) !== 47) return !1;
  let o = t - Math.min(10, e.pending.length, t), i = t;
  for (; i > o && qs(e.src.charCodeAt(i - 1)); ) i--;
  if (i === t || !Hs(e.src.charCodeAt(i))) return !1;
  let s = t - i, a = e.md.linkify.matchAtStart(e.src.slice(i));
  if (!a) return !1;
  let u = a.url;
  if (u.length <= s) return !1;
  let d = u.length;
  for (; d > 0 && u.charCodeAt(d - 1) === 42; ) d--;
  d !== u.length && (u = u.slice(0, d));
  let h = e.md.normalizeLink(u);
  if (!e.md.validateLink(h)) return !1;
  if (!n) {
    e.pending = e.pending.slice(0, -s);
    let g = e.push("link_open", "a", 1);
    g.attrs = [["href", h]], g.markup = "linkify", g.info = "auto";
    let m = e.push("text", "", 0);
    m.content = e.md.normalizeLinkText(u);
    let c = e.push("link_close", "a", -1);
    c.markup = "linkify", c.info = "auto";
  }
  return e.pos += u.length - s, !0;
}
function $s(e, n) {
  let t = e.pos;
  if (e.src.charCodeAt(t) !== 10) return !1;
  let r = e.pending.length - 1, o = e.posMax;
  if (!n)
    if (r >= 0 && e.pending.charCodeAt(r) === 32)
      if (r >= 1 && e.pending.charCodeAt(r - 1) === 32) {
        let i = r - 1;
        for (; i >= 1 && e.pending.charCodeAt(i - 1) === 32; ) i--;
        e.pending = e.pending.slice(0, i), e.push("hardbreak", "br", 0);
      } else
        e.pending = e.pending.slice(0, -1), e.push("softbreak", "br", 0);
    else e.push("softbreak", "br", 0);
  for (t++; t < o && P(e.src.charCodeAt(t)); ) t++;
  return e.pos = t, !0;
}
var Sn = [];
for (let e = 0; e < 256; e++) Sn.push(0);
"\\!\"#$%&'()*+,./:;<=>?@[]^_`{|}~-".split("").forEach(function(e) {
  Sn[e.charCodeAt(0)] = 1;
});
function Vs(e, n) {
  let t = e.pos, r = e.posMax;
  if (e.src.charCodeAt(t) !== 92 || (t++, t >= r)) return !1;
  let o = e.src.charCodeAt(t);
  if (o === 10) {
    for (n || e.push("hardbreak", "br", 0), t++; t < r && (o = e.src.charCodeAt(t), !!P(o)); )
      t++;
    return e.pos = t, !0;
  }
  if (o === 32) {
    if (!n) {
      let a = e.push("text_special", "", 0);
      a.content = "\\", a.markup = "\\", a.info = "escape";
    }
    return e.pos = t, !0;
  }
  let i = e.src[t];
  if (o >= 55296 && o <= 56319 && t + 1 < r) {
    let a = e.src.charCodeAt(t + 1);
    a >= 56320 && a <= 57343 && (i += e.src[t + 1], t++);
  }
  let s = "\\" + i;
  if (!n) {
    let a = e.push("text_special", "", 0);
    o < 256 && Sn[o] !== 0 ? a.content = i : a.content = s, a.markup = s, a.info = "escape";
  }
  return e.pos = t + 1, !0;
}
function Ks(e) {
  let n = {}, t = 0;
  for (; (t = e.indexOf("`", t)) !== -1; ) {
    let r = t;
    for (; e.charCodeAt(++t) === 96; ) ;
    n[t - r] = r;
  }
  return n;
}
function Js(e, n) {
  var t;
  let r = e.pos;
  if (e.src.charCodeAt(r) !== 96) return !1;
  let o = e.posMax, i = r + 1;
  for (; i < o && e.src.charCodeAt(i) === 96; ) i++;
  let s = e.src.slice(r, i), a = s.length;
  if (e.backticksScanned || (e.backticks = Ks(e.src), e.backticksScanned = !0), ((t = e.backticks[a]) !== null && t !== void 0 ? t : -1) >= i) {
    let u = i, d;
    for (; (d = e.src.indexOf("`", u)) !== -1 && d < o; ) {
      for (u = d + 1; e.src.charCodeAt(u) === 96; ) u++;
      if (u > o) break;
      if (u - d === a) {
        if (!n) {
          let h = e.push("code_inline", "code", 0);
          h.markup = s;
          let g = e.src.slice(i, d).replace(/\n/g, " ");
          g.startsWith(" ") && g.endsWith(" ") && /[^ ]/.test(g) && (g = g.slice(1, -1)), h.content = g;
        }
        return e.pos = u, !0;
      }
    }
  }
  return n || (e.pending += s), e.pos = i, !0;
}
function Ys(e, n) {
  let t = e.pos, r = e.src.charCodeAt(t);
  if (n || r !== 126) return !1;
  let o = e.scanDelims(e.pos, !0), i = o.length, s = String.fromCharCode(r);
  if (i < 2) return !1;
  let a;
  i % 2 && (a = e.push("text", "", 0), a.content = s, i--);
  for (let u = 0; u < i; u += 2)
    a = e.push("text", "", 0), a.content = s + s, e.delimiters.push({
      marker: r,
      length: 0,
      token: e.tokens.length - 1,
      end: -1,
      open: o.can_open,
      close: o.can_close
    });
  return e.pos += o.length, !0;
}
function yr(e, n) {
  let t, r = [], o = n.length;
  for (let i = 0; i < o; i++) {
    let s = n[i];
    if (s.marker !== 126 || s.end === -1) continue;
    let a = n[s.end];
    t = e.tokens[s.token], t.type = "s_open", t.tag = "s", t.nesting = 1, t.markup = "~~", t.content = "", t = e.tokens[a.token], t.type = "s_close", t.tag = "s", t.nesting = -1, t.markup = "~~", t.content = "", e.tokens[a.token - 1].type === "text" && e.tokens[a.token - 1].content === "~" && r.push(a.token - 1);
  }
  for (; r.length; ) {
    let i = r.pop(), s = i + 1;
    for (; s < e.tokens.length && e.tokens[s].type === "s_close"; ) s++;
    s--, i !== s && (t = e.tokens[s], e.tokens[s] = e.tokens[i], e.tokens[i] = t);
  }
}
function Xs(e) {
  let n = e.tokens_meta, t = e.tokens_meta.length;
  yr(e, e.delimiters);
  for (let o = 0; o < t; o++) {
    var r;
    let i = (r = n[o]) === null || r === void 0 ? void 0 : r.delimiters;
    i && yr(e, i);
  }
}
var Nr = {
  tokenize: Ys,
  postProcess: Xs
};
function Zs(e, n) {
  let t = e.pos, r = e.src.charCodeAt(t);
  if (n || r !== 95 && r !== 42) return !1;
  let o = e.scanDelims(e.pos, r === 42);
  for (let i = 0; i < o.length; i++) {
    let s = e.push("text", "", 0);
    s.content = String.fromCharCode(r), e.delimiters.push({
      marker: r,
      length: o.length,
      token: e.tokens.length - 1,
      end: -1,
      open: o.can_open,
      close: o.can_close
    });
  }
  return e.pos += o.length, !0;
}
function br(e, n) {
  let t = n.length;
  for (let r = t - 1; r >= 0; r--) {
    let o = n[r];
    if (o.marker !== 95 && o.marker !== 42 || o.end === -1) continue;
    let i = n[o.end], s = r > 0 && n[r - 1].end === o.end + 1 && n[r - 1].marker === o.marker && n[r - 1].token === o.token - 1 && n[o.end + 1].token === i.token + 1, a = String.fromCharCode(o.marker), u = e.tokens[o.token];
    u.type = s ? "strong_open" : "em_open", u.tag = s ? "strong" : "em", u.nesting = 1, u.markup = s ? a + a : a, u.content = "";
    let d = e.tokens[i.token];
    d.type = s ? "strong_close" : "em_close", d.tag = s ? "strong" : "em", d.nesting = -1, d.markup = s ? a + a : a, d.content = "", s && (e.tokens[n[r - 1].token].content = "", e.tokens[n[o.end + 1].token].content = "", r--);
  }
}
function Qs(e) {
  let n = e.tokens_meta, t = e.tokens_meta.length;
  br(e, e.delimiters);
  for (let o = 0; o < t; o++) {
    var r;
    let i = (r = n[o]) === null || r === void 0 ? void 0 : r.delimiters;
    i && br(e, i);
  }
}
var Fr = {
  tokenize: Zs,
  postProcess: Qs
};
function ea(e, n) {
  let t, r, o, i, s = "", a = "", u = e.pos, d = !0;
  if (e.src.charCodeAt(e.pos) !== 91) return !1;
  let h = e.pos, g = e.posMax, m = e.pos + 1, c = e.md.helpers.parseLinkLabel(e, e.pos, !0);
  if (c < 0) return !1;
  let l = c + 1;
  if (l < g && e.src.charCodeAt(l) === 40) {
    for (d = !1, l++; l < g && (t = e.src.charCodeAt(l), !(!P(t) && t !== 10)); l++)
      ;
    if (l >= g) return !1;
    if (u = l, o = e.md.helpers.parseLinkDestination(e.src, l, e.posMax), o.ok) {
      for (s = e.md.normalizeLink(o.str), e.md.validateLink(s) ? l = o.pos : s = "", u = l; l < g && (t = e.src.charCodeAt(l), !(!P(t) && t !== 10)); l++)
        ;
      if (o = e.md.helpers.parseLinkTitle(e.src, l, e.posMax), l < g && u !== l && o.ok)
        for (a = o.str, l = o.pos; l < g && (t = e.src.charCodeAt(l), !(!P(t) && t !== 10)); l++)
          ;
    }
    (l >= g || e.src.charCodeAt(l) !== 41) && (d = !0), l++;
  }
  if (d) {
    if (typeof e.env.references > "u") return !1;
    if (l < g && e.src.charCodeAt(l) === 91 ? (u = l + 1, l = e.md.helpers.parseLinkLabel(e, l), l >= 0 ? r = e.src.slice(u, l++) : l = c + 1) : l = c + 1, r || (r = e.src.slice(m, c)), r = qe(r), i = e.env.references[r], !i)
      return e.pos = h, !1;
    s = i.href, a = i.title;
  }
  if (!n) {
    e.pos = m, e.posMax = c;
    let f = e.push("link_open", "a", 1), p = [["href", s]];
    if (f.attrs = p, a && p.push(["title", a]), r) {
      let y = /* @__PURE__ */ Object.create(null);
      y.label = r, f.meta = y;
    }
    e.linkLevel++, e.md.inline.tokenize(e), e.linkLevel--, e.push("link_close", "a", -1);
  }
  return e.pos = l, e.posMax = g, !0;
}
function na(e, n) {
  let t, r, o, i, s, a, u, d, h = "", g = e.pos, m = e.posMax;
  if (e.src.charCodeAt(e.pos) !== 33 || e.src.charCodeAt(e.pos + 1) !== 91) return !1;
  let c = e.pos + 2, l = e.md.helpers.parseLinkLabel(e, e.pos + 1, !1);
  if (l < 0) return !1;
  if (i = l + 1, i < m && e.src.charCodeAt(i) === 40) {
    for (i++; i < m && (t = e.src.charCodeAt(i), !(!P(t) && t !== 10)); i++)
      ;
    if (i >= m) return !1;
    for (d = i, a = e.md.helpers.parseLinkDestination(e.src, i, e.posMax), a.ok && (h = e.md.normalizeLink(a.str), e.md.validateLink(h) ? i = a.pos : h = ""), d = i; i < m && (t = e.src.charCodeAt(i), !(!P(t) && t !== 10)); i++)
      ;
    if (a = e.md.helpers.parseLinkTitle(e.src, i, e.posMax), i < m && d !== i && a.ok)
      for (u = a.str, i = a.pos; i < m && (t = e.src.charCodeAt(i), !(!P(t) && t !== 10)); i++)
        ;
    else u = "";
    if (i >= m || e.src.charCodeAt(i) !== 41)
      return e.pos = g, !1;
    i++;
  } else {
    if (typeof e.env.references > "u") return !1;
    if (i < m && e.src.charCodeAt(i) === 91 ? (d = i + 1, i = e.md.helpers.parseLinkLabel(e, i), i >= 0 ? o = e.src.slice(d, i++) : i = l + 1) : i = l + 1, o || (o = e.src.slice(c, l)), o = qe(o), s = e.env.references[o], !s)
      return e.pos = g, !1;
    h = s.href, u = s.title;
  }
  if (!n) {
    r = e.src.slice(c, l);
    let f = [];
    e.md.inline.parse(r, e.md, e.env, f);
    let p = e.push("image", "img", 0), y = [["src", h], ["alt", ""]];
    if (p.attrs = y, p.children = f, p.content = r, u && y.push(["title", u]), o) {
      let b = /* @__PURE__ */ Object.create(null);
      b.label = o, p.meta = b;
    }
  }
  return e.pos = i, e.posMax = m, !0;
}
var ta = /^([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)$/, ra = /^([a-zA-Z][a-zA-Z0-9+.-]{1,31}):([^<>\x00-\x20]*)$/;
function oa(e, n) {
  let t = e.pos;
  if (e.src.charCodeAt(t) !== 60) return !1;
  let r = e.pos, o = e.posMax;
  for (; ; ) {
    if (++t >= o) return !1;
    let s = e.src.charCodeAt(t);
    if (s === 60) return !1;
    if (s === 62) break;
  }
  let i = e.src.slice(r + 1, t);
  if (ra.test(i)) {
    let s = e.md.normalizeLink(i);
    if (!e.md.validateLink(s)) return !1;
    if (!n) {
      let a = e.push("link_open", "a", 1);
      a.attrs = [["href", s]], a.markup = "autolink", a.info = "auto";
      let u = e.push("text", "", 0);
      u.content = e.md.normalizeLinkText(i);
      let d = e.push("link_close", "a", -1);
      d.markup = "autolink", d.info = "auto";
    }
    return e.pos += i.length + 2, !0;
  }
  if (ta.test(i)) {
    let s = e.md.normalizeLink(`mailto:${i}`);
    if (!e.md.validateLink(s)) return !1;
    if (!n) {
      let a = e.push("link_open", "a", 1);
      a.attrs = [["href", s]], a.markup = "autolink", a.info = "auto";
      let u = e.push("text", "", 0);
      u.content = e.md.normalizeLinkText(i);
      let d = e.push("link_close", "a", -1);
      d.markup = "autolink", d.info = "auto";
    }
    return e.pos += i.length + 2, !0;
  }
  return !1;
}
function ia(e) {
  return /^<a[>\s]/i.test(e);
}
function sa(e) {
  return /^<\/a\s*>/i.test(e);
}
function Lr(e) {
  let n = e | 32;
  return n >= 97 && n <= 122;
}
function aa(e, n) {
  let t = e.src, r, o;
  if (t.startsWith("<!--", n)) {
    if (t.startsWith(">", n + 4)) return n + 5;
    if (t.startsWith("->", n + 4)) return n + 6;
    r = n + 4, o = "-->";
  } else if (t.startsWith("<![CDATA[", n))
    r = n + 9, o = "]]>";
  else if (t.charCodeAt(n + 1) === 63)
    r = n + 2, o = "?>";
  else if (Lr(t.charCodeAt(n + 2)))
    r = n + 3, o = ">";
  else return -1;
  if (e.skipHtmlSpecial) return -1;
  let i = t.indexOf(o, r);
  return i < 0 ? (e.skipHtmlSpecial = !0, -1) : i + o.length;
}
function ca(e, n) {
  if (!e.md.options.html) return !1;
  let t = e.posMax, r = e.pos;
  if (e.src.charCodeAt(r) !== 60 || r + 2 >= t) return !1;
  let o, i = e.src.charCodeAt(r + 1);
  if (i === 33 || i === 63) o = aa(e, r);
  else if (i === 47 || Lr(i)) {
    let s = e.src.slice(r).match(Dr);
    o = s ? r + s[0].length : -1;
  } else return !1;
  if (o < 0) return !1;
  if (!n) {
    let s = e.push("html_inline", "", 0);
    s.content = e.src.slice(r, o), ia(s.content) && e.linkLevel++, sa(s.content) && e.linkLevel--;
  }
  return e.pos = o, !0;
}
var la = /^&#((?:x[a-f0-9]{1,6}|[0-9]{1,7}));/i, ua = /^&([a-z][a-z0-9]{1,31});/i;
function da(e, n) {
  let t = e.pos, r = e.posMax;
  if (e.src.charCodeAt(t) !== 38 || t + 1 >= r) return !1;
  if (e.src.charCodeAt(t + 1) === 35) {
    let o = e.src.slice(t).match(la);
    if (o) {
      if (!n) {
        let i = o[1][0].toLowerCase() === "x" ? parseInt(o[1].slice(1), 16) : parseInt(o[1], 10), s = e.push("text_special", "", 0);
        s.content = Tn(i) ? Ce(i) : Ce(65533), s.markup = o[0], s.info = "entity";
      }
      return e.pos += o[0].length, !0;
    }
  } else {
    let o = e.src.slice(t).match(ua);
    if (o) {
      let i = je(o[0]);
      if (i !== o[0]) {
        if (!n) {
          let s = e.push("text_special", "", 0);
          s.content = i, s.markup = o[0], s.info = "entity";
        }
        return e.pos += o[0].length, !0;
      }
    }
  }
  return !1;
}
function wr(e) {
  let n = {}, t = e.length;
  if (!t) return;
  let r = 0, o = -2, i = [];
  for (let s = 0; s < t; s++) {
    let a = e[s];
    if (i.push(0), (e[r].marker !== a.marker || o !== a.token - 1) && (r = s), o = a.token, a.length = a.length || 0, !a.close) continue;
    n.hasOwnProperty(a.marker) || (n[a.marker] = [
      -1,
      -1,
      -1,
      -1,
      -1,
      -1
    ]);
    let u = n[a.marker][(a.open ? 3 : 0) + a.length % 3], d = r - i[r] - 1, h = d;
    for (; d > u; d -= i[d] + 1) {
      let g = e[d];
      if (g.marker === a.marker && g.open && g.end < 0) {
        let m = !1;
        if ((g.close || a.open) && (g.length + a.length) % 3 === 0 && (g.length % 3 !== 0 || a.length % 3 !== 0) && (m = !0), !m) {
          let c = d > 0 && !e[d - 1].open ? i[d - 1] + 1 : 0;
          i[s] = s - d + c, i[d] = c, a.open = !1, g.end = s, g.close = !1, h = -1, o = -2;
          break;
        }
      }
    }
    h !== -1 && (n[a.marker][(a.open ? 3 : 0) + (a.length || 0) % 3] = h);
  }
}
function pa(e) {
  let n = e.tokens_meta, t = e.tokens_meta.length;
  wr(e.delimiters);
  for (let o = 0; o < t; o++) {
    var r;
    let i = (r = n[o]) === null || r === void 0 ? void 0 : r.delimiters;
    i && wr(i);
  }
}
function fa(e) {
  let n, t, r = 0, o = e.tokens, i = e.tokens.length;
  for (n = t = 0; n < i; n++)
    o[n].nesting < 0 && r--, o[n].level = r, o[n].nesting > 0 && r++, o[n].type === "text" && n + 1 < i && o[n + 1].type === "text" ? o[n + 1].content = o[n].content + o[n + 1].content : (n !== t && (o[t] = o[n]), t++);
  n !== t && (o.length = t);
}
var kn = [
  ["text", Ws],
  ["linkify", zs],
  ["newline", $s],
  ["escape", Vs],
  ["backticks", Js],
  ["strikethrough", Nr.tokenize],
  ["emphasis", Fr.tokenize],
  ["link", ea],
  ["image", na],
  ["autolink", oa],
  ["html_inline", ca],
  ["entity", da]
], xn = [
  ["balance_pairs", pa],
  ["strikethrough", Nr.postProcess],
  ["emphasis", Fr.postProcess],
  ["fragments_join", fa]
], Ur = class {
  constructor() {
    C(
      this,
      /**
      * {@link Ruler} instance. Keep configuration of inline rules.
      */
      "ruler",
      new Ie()
    ), C(
      this,
      /**
      * {@link Ruler} instance. Second ruler used for post-processing
      * (e.g. in emphasis-like rules).
      */
      "ruler2",
      new Ie()
    ), C(this, "State", Or);
    for (let e = 0; e < kn.length; e++) this.ruler.push(kn[e][0], kn[e][1]);
    for (let e = 0; e < xn.length; e++) this.ruler2.push(xn[e][0], xn[e][1]);
  }
  skipToken(e) {
    let n = e.pos, t = this.ruler.getRules(""), r = t.length, o = e.md.options.maxNesting, i = e.cache;
    if (typeof i[n] < "u") {
      e.pos = i[n];
      return;
    }
    let s = !1;
    if (e.level < o) {
      for (let a = 0; a < r; a++)
        if (e.level++, s = t[a](e, !0), e.level--, s) {
          if (n >= e.pos) throw new Error("inline rule didn't increment state.pos");
          break;
        }
    } else e.pos = e.posMax;
    s || e.pos++, i[n] = e.pos;
  }
  tokenize(e) {
    let n = this.ruler.getRules(""), t = n.length, r = e.posMax, o = e.md.options.maxNesting;
    for (; e.pos < r; ) {
      let i = e.pos, s = !1;
      if (e.level < o) {
        for (let a = 0; a < t; a++)
          if (s = n[a](e, !1), s) {
            if (i >= e.pos) throw new Error("inline rule didn't increment state.pos");
            break;
          }
      }
      if (s) {
        if (e.pos >= r) break;
        continue;
      }
      e.pending += e.src[e.pos++];
    }
    e.pending && e.pushPending();
  }
  /**
  * Process input string and push inline tokens into `outTokens`
  */
  parse(e, n, t, r) {
    let o = new this.State(e, n, t, r);
    this.tokenize(o);
    let i = this.ruler2.getRules(""), s = i.length;
    for (let a = 0; a < s; a++) i[a](o);
  }
}, ha = {
  default: {
    options: {
      html: !1,
      xhtmlOut: !1,
      breaks: !1,
      langPrefix: "language-",
      linkify: !1,
      typographer: !1,
      quotes: "\u201C\u201D\u2018\u2019",
      highlight: null,
      maxNesting: 100
    },
    components: {
      core: {},
      block: {},
      inline: {}
    }
  },
  zero: {
    options: {
      html: !1,
      xhtmlOut: !1,
      breaks: !1,
      langPrefix: "language-",
      linkify: !1,
      typographer: !1,
      quotes: "\u201C\u201D\u2018\u2019",
      highlight: null,
      maxNesting: 20
    },
    components: {
      core: { rules: [
        "normalize",
        "block",
        "strip_references",
        "inline",
        "text_join"
      ] },
      block: { rules: ["paragraph"] },
      inline: {
        rules: ["text"],
        rules2: ["balance_pairs", "fragments_join"]
      }
    }
  },
  commonmark: {
    options: {
      html: !0,
      xhtmlOut: !0,
      breaks: !1,
      langPrefix: "language-",
      linkify: !1,
      typographer: !1,
      quotes: "\u201C\u201D\u2018\u2019",
      highlight: null,
      maxNesting: 20
    },
    components: {
      core: { rules: [
        "normalize",
        "block",
        "strip_references",
        "inline",
        "text_join"
      ] },
      block: { rules: [
        "blockquote",
        "code",
        "fence",
        "heading",
        "hr",
        "html_block",
        "lheading",
        "list",
        "reference",
        "paragraph"
      ] },
      inline: {
        rules: [
          "autolink",
          "backticks",
          "emphasis",
          "entity",
          "escape",
          "html_inline",
          "image",
          "link",
          "newline",
          "text"
        ],
        rules2: [
          "balance_pairs",
          "emphasis",
          "fragments_join"
        ]
      }
    }
  }
}, ga = /^(vbscript|javascript|file|data):/, ma = /^data:image\/(gif|png|jpeg|webp);/, Rr = [
  "http:",
  "https:",
  "mailto:"
], Y = class {
  /**
  * Link validation function. CommonMark allows too much in links. By default
  * we disable `javascript:`, `vbscript:`, `file:` schemas, and almost all `data:...` schemas
  * except some embedded image types.
  *
  * You can change this behaviour:
  *
  * @example
  * ```javascript
  * import MarkdownIt from 'markdown-it'
  * const md = new MarkdownIt()
  *
  * // enable everything
  * md.validateLink = function () { return true; }
  * ```
  */
  validateLink(e) {
    let n = e.trim().toLowerCase();
    return ga.test(n) ? ma.test(n) : !0;
  }
  /**
  * Function used to encode link url to a machine-readable format,
  * which includes url-encoding, punycode, etc.
  */
  normalizeLink(e) {
    let n = Re(e, !0);
    if (n.hostname && (!n.protocol || Rr.indexOf(n.protocol) >= 0))
      try {
        n.hostname = Cn.default.toASCII(n.hostname);
      } catch {
      }
    return n.auth && (n.auth = X(n.auth)), n.hostname && (n.hostname = X(n.hostname)), n.pathname && (n.pathname = X(n.pathname)), n.search && (n.search = X(n.search)), n.hash && (n.hash = X(n.hash)), pe(n);
  }
  /**
  * Function used to decode link url to a human-readable format`
  */
  normalizeLinkText(e) {
    let n = Re(e, !0);
    if (n.hostname && (!n.protocol || Rr.indexOf(n.protocol) >= 0))
      try {
        n.hostname = Cn.default.toUnicode(n.hostname);
      } catch {
      }
    return we(pe(n), we.defaultChars + "%");
  }
  constructor(...e) {
    C(
      this,
      /**
      * Instance of {@link ParserInline}. You may need it to add new rules when
      * writing plugins. For simple rules control use {@link MarkdownIt.disable}
      * and {@link MarkdownIt.enable}.
      */
      "inline",
      new Ur()
    ), C(
      this,
      /**
      * Instance of {@link ParserBlock}. You may need it to add new rules when
      * writing plugins. For simple rules control use {@link MarkdownIt.disable}
      * and {@link MarkdownIt.enable}.
      */
      "block",
      new Pr()
    ), C(
      this,
      /**
      * Instance of {@link ParserCore} chain executor. You may need it to add new
      * rules when writing plugins. For simple rules control use
      * {@link MarkdownIt.disable} and {@link MarkdownIt.enable}.
      */
      "core",
      new Ir()
    ), C(
      this,
      /**
      * Instance of {@link Renderer}. Use it to modify output look. Or to add rendering
      * rules for new token types, generated by plugins.
      *
      * See {@link Renderer} docs and
      * [source code](https://github.com/markdown-it/markdown-it/blob/master/src/renderer.ts).
      *
      * @example
      * ```javascript
      * import MarkdownIt from 'markdown-it'
      * const md = new MarkdownIt()
      *
      * function myToken(tokens, idx, options, env, self) {
      *   //...
      *   return result;
      * };
      *
      * md.renderer.rules['my_token'] = myToken
      * ```
      */
      "renderer",
      new Sr()
    ), C(
      this,
      /**
      * [linkify-it](https://github.com/markdown-it/linkify-it) instance.
      * Used by [linkify](https://github.com/markdown-it/markdown-it/blob/master/src/rules_core/linkify.ts)
      * rule.
      */
      "linkify",
      new er()
    ), C(
      this,
      /**
      * Assorted utility functions, useful to write plugins. See details
      * [here](https://github.com/markdown-it/markdown-it/blob/master/src/common/utils.ts).
      */
      "utils",
      Ui
    ), C(
      this,
      /**
      * Link components parser functions, useful to write plugins. See details
      * [here](https://github.com/markdown-it/markdown-it/blob/master/src/helpers).
      */
      "helpers",
      Object.assign({}, es)
    );
    let [n, t] = e;
    typeof n == "string" ? (this.configure(n), t && this.set(t)) : (this.configure("default"), this.set(n || {}));
  }
  /**
  * Set parser options (in the same format as in constructor). Probably, you
  * will never need it, but you can change options after constructor call.
  *
  * __Note:__ To achieve the best possible performance, don't modify a
  * `markdown-it` instance options on the fly. If you need multiple configurations
  * it's best to create multiple instances and initialize each with separate
  * config.
  *
  * @example
  * ```javascript
  * import MarkdownIt from 'markdown-it'
  *
  * const md = new MarkdownIt()
  *   .set({ html: true, breaks: true })
  *   .set({ typographer: true })
  * ```
  */
  set(e) {
    return Object.assign(this.options, e), this;
  }
  /**
  * Batch load of all options and compenent settings. This is internal method,
  * and you probably will not need it. But if you will - see available presets
  * and data structure [here](https://github.com/markdown-it/markdown-it/tree/master/src/presets)
  *
  * We strongly recommend to use presets instead of direct config loads. That
  * will give better compatibility with next versions.
  */
  configure(e) {
    let n;
    if (typeof e == "string") {
      let o = e;
      if (n = ha[o], !n) throw new Error(`Wrong 'markdown-it' preset "${o}", check name`);
    } else n = e;
    if (!n) throw new Error("Wrong `markdown-it` preset, can't be empty");
    n.options && (this.options = { ...n.options });
    let t = n.components;
    if (t) {
      var r;
      [
        "core",
        "block",
        "inline"
      ].forEach((i) => {
        var s;
        let a = (s = t[i]) === null || s === void 0 ? void 0 : s.rules;
        a && this[i].ruler.enableOnly(a);
      });
      let o = (r = t.inline) === null || r === void 0 ? void 0 : r.rules2;
      o && this.inline.ruler2.enableOnly(o);
    }
    return this;
  }
  /**
  * Enable list or rules. It will automatically find appropriate components,
  * containing rules with given names. If rule not found, and `ignoreInvalid`
  * not set - throws exception.
  *
  * @example
  * ```javascript
  * import MarkdownIt from 'markdown-it'
  *
  * const md = new MarkdownIt()
  *   .enable(['sub', 'sup'])
  *   .disable('smartquotes')
  * ```
  */
  enable(e, n = !1) {
    let t = [];
    Array.isArray(e) || (e = [e]), [
      "core",
      "block",
      "inline"
    ].forEach((o) => {
      t = t.concat(this[o].ruler.enable(e, !0));
    }), t = t.concat(this.inline.ruler2.enable(e, !0));
    let r = e.filter((o) => t.indexOf(o) < 0);
    if (r.length && !n) throw new Error(`MarkdownIt. Failed to enable unknown rule(s): ${r}`);
    return this;
  }
  /**
  * The same as {@link MarkdownIt.enable}, but turn specified rules off.
  */
  disable(e, n = !1) {
    let t = [];
    Array.isArray(e) || (e = [e]), [
      "core",
      "block",
      "inline"
    ].forEach((o) => {
      t = t.concat(this[o].ruler.disable(e, !0));
    }), t = t.concat(this.inline.ruler2.disable(e, !0));
    let r = e.filter((o) => t.indexOf(o) < 0);
    if (r.length && !n) throw new Error(`MarkdownIt. Failed to disable unknown rule(s): ${r}`);
    return this;
  }
  /**
  * Load specified plugin with given params into current parser instance.
  * It's just a sugar to call `plugin(md, params)` with curring.
  *
  * @example
  * ```javascript
  * import MarkdownIt from 'markdown-it'
  * import iterator from 'markdown-it-for-inline'
  *
  * const md = new MarkdownIt()
  *   .use(iterator, 'foo_replace', 'text', function (tokens, idx) {
  *     tokens[idx].content = tokens[idx].content.replace(/foo/g, 'bar')
  *   })
  * ```
  */
  use(e, ...n) {
    return e.apply(e, [this, ...n]), this;
  }
  /**
  * Parse input string and return list of block tokens (special token type
  * "inline" will contain list of inline tokens). You should not call this
  * method directly, until you write custom renderer (for example, to produce
  * AST).
  *
  * `env` is used to pass data between "distributed" rules and return additional
  * metadata like reference info, needed for the renderer. It also can be used to
  * inject data in specific cases. Usually, you will be ok to pass `{}`,
  * and then pass updated object to renderer.
  */
  parse(e, n) {
    if (typeof e != "string") throw new Error("Input data should be a String");
    let t = new this.core.State(e, this, n);
    return this.core.process(t), t.tokens;
  }
  /**
  * Render markdown string into html. It does all magic for you :).
  *
  * `env` can be used to inject additional metadata (`{}` by default).
  * But you will not need it with high probability. See also comment
  * in {@link MarkdownIt.parse}.
  */
  render(e, n = {}) {
    return this.renderer.render(this.parse(e, n), this.options, n);
  }
  /**
  * The same as {@link MarkdownIt.parse} but skip all block rules. It returns
  * the block tokens list with the single `inline` element, containing parsed
  * inline tokens in `children` property. Also updates `env` object.
  */
  parseInline(e, n) {
    let t = new this.core.State(e, this, n);
    return t.inlineMode = !0, this.core.process(t), t.tokens;
  }
  /**
  * Similar to {@link MarkdownIt.render} but for single paragraph content.
  * Result will NOT be wrapped into `<p>` tags.
  */
  renderInline(e, n = {}) {
    return this.renderer.render(this.parseInline(e, n), this.options, n);
  }
};
C(Y, "Token", ce);
C(Y, "Ruler", Ie);
C(Y, "Renderer", Sr);
C(Y, "ParserCore", Ir);
C(Y, "StateCore", Er);
C(Y, "ParserBlock", Pr);
C(Y, "StateBlock", Ar);
C(Y, "ParserInline", Ur);
C(Y, "StateInline", Or);
var ya = xr(Y);

// openclaw/packages/net-policy/src/ip.ts
j();
var Gr = Mn(jr(), 1);
var sf = [Gr.default.IPv4.parse("198.18.0.0"), 15];

// openclaw/src/media/parse-output.ts
z();

// openclaw/src/utils/directive-tags.ts
z();
en();
j();

// openclaw/src/shared/text/text-projection.ts
z();

// openclaw/packages/markdown-core/src/fences.ts
var wa = /(?:^|\n)( {0,3})(`{3,}|~{3,})([^\r\n\u2028\u2029]*)\r?(?=\n|$)/g, cf = new RegExp(wa, "gy");

// openclaw/packages/tool-call-repair/src/grammar.ts
var kf = new TextEncoder();

// openclaw/src/shared/clawhub-recommendations.ts
D();
var Wr = [
  "type",
  "id",
  "name",
  "description",
  "iconUrl",
  "installed",
  "official",
  "kind"
], dh = /* @__PURE__ */ new Set([...Wr, "pluginId"]), ph = /* @__PURE__ */ new Set([...Wr, "registry", "skillRef"]);

// openclaw/src/shared/plugin-inline-view.ts
D();
var gh = 16 * 1024;

// openclaw/ui/src/lib/chat/imported-message-display.ts
D();

// openclaw/ui/src/lib/chat/message-normalizer-attachments.ts
re();
D();

// openclaw/ui/src/lib/chat/sender-label.ts
D();
j();

// openclaw/ui/src/lib/chat/message-normalizer.ts
function En(e) {
  return Me(N(e)?.role);
}

// openclaw/ui/src/lib/chat/tool-call-diff.ts
D();
function Hr(e) {
  let n = ne(e), t = n?.added, r = n?.removed;
  return typeof t == "number" && Number.isInteger(t) && t >= 0 && typeof r == "number" && Number.isInteger(r) && r >= 0 ? { added: t, removed: r } : void 0;
}

// openclaw/ui/src/lib/chat/tool-call-grouping.ts
D();

// openclaw/src/agents/agent-activity-presentation.ts
D();
j();

// openclaw/src/session-cards/progress-card-input.ts
D();

// openclaw/src/agents/agent-activity-presentation.ts
function le(e, n) {
  return n.map((t) => [t, e]);
}
var xg = new Map([
  // A launched subagent is a worker, not one more operation of the launcher.
  ...le("subagents", ["sessions_spawn"]),
  ...le("commands", ["exec", "bash", "shell", "run_command", "run_terminal_cmd"]),
  ...le("reads", ["read", "read_file", "readfile", "notebookread", "notebook_read"]),
  ...le("edits", [
    "edit",
    "apply_patch",
    "applypatch",
    "patch",
    "edit_file",
    "multiedit",
    "multi_edit",
    "notebookedit",
    "notebook_edit"
  ]),
  ...le("writes", ["write", "write_file", "create_file"]),
  ...le("searches", [
    "grep",
    "glob",
    "find",
    "ls",
    "list",
    "codebase_search",
    "web_search"
  ]),
  ...le("fetches", ["web_fetch", "webfetch", "fetch"])
]);

// openclaw/ui/src/lib/chat/tool-call-grouping.ts
Kr();

// openclaw/ui/src/i18n/locales/en-chat-tool-labels.ts
_n();
var Jr = {
  chat: {
    toolCards: {
      tool: "Tool",
      canvas: "Canvas",
      summary: "Summary",
      toolInput: "Tool input",
      toolOutput: "Tool output",
      rawDetails: "Raw details",
      activity: {
        titleOne: "1 operation",
        titleMany: "{count} operations",
        commandsOne: "1 command",
        commandsMany: "{count} commands",
        readsOne: "1 read",
        readsMany: "{count} reads",
        editsOne: "1 edit",
        editsMany: "{count} edits",
        writesOne: "1 write",
        writesMany: "{count} writes",
        searchesOne: "1 search",
        searchesMany: "{count} searches",
        fetchesOne: "1 fetch",
        fetchesMany: "{count} fetches",
        otherOne: "1 other operation",
        otherMany: "{count} other operations",
        subagentsOne: "1 subagent",
        subagentsMany: "{count} subagents",
        failed: "{count} failed",
        blocked: "{count} blocked",
        unknown: "{count} unknown"
      },
      showRawDetails: "Show raw details",
      hideRawDetails: "Hide raw details",
      openFile: "Open file",
      widgetActions: "Widget actions",
      copyToClipboard: "Copy to clipboard",
      downloadFile: "Download file",
      copyAsImage: "Copy as image",
      downloadAsImage: "Download as image",
      widgetExportRerender: "This widget needs to be re-rendered to export as an image.",
      widgetExportHtmlFallback: "Image unavailable. Downloaded the widget as HTML instead.",
      widgetExportFailed: "Widget export failed. Try again.",
      pinToDashboard: "Pin to dashboard",
      pinToDashboardPending: "Pinning\u2026",
      pinToDashboardFailed: "Could not pin to dashboard. Try again.",
      pinnedToDashboard: "Pinned",
      fileChanges: "File changes",
      attemptedChanges: "Attempted changes",
      failed: "failed",
      skipped: "Skipped",
      skippedCount: "{count} skipped",
      running: "Running",
      subagentRunning: "running",
      subagentStopped: "stopped",
      openSubagent: "Open subagent session",
      completed: "Completed",
      blocked: "Blocked",
      outcomeUnknown: "Outcome unknown",
      exitCode: "Exit code {code}",
      failureCount: "{count} failed",
      noOutputSucceeded: "No output \u2014 tool completed successfully.",
      noResult: "No result available.",
      review: {
        reviewing: "{reviewer} reviewing",
        approved: "{reviewer} approved",
        denied: "{reviewer} denied",
        timedOut: "{reviewer} timed out",
        aborted: "{reviewer} stopped",
        risk: "{level} risk",
        authorization: "{level} authorization",
        noRationale: "No rationale was provided."
      },
      verbs: {
        read: "Read",
        edit: "Edit",
        editing: "Editing",
        edited: "Edited",
        create: "Create",
        creating: "Creating",
        created: "Created",
        delete: "Delete",
        deleting: "Deleting",
        deleted: "Deleted",
        change: "Change",
        changing: "Changing",
        changed: "Changed",
        write: "Write",
        writing: "Writing",
        wrote: "Wrote",
        searched: "Searched",
        fetched: "Fetched"
      }
    }
  }
}, Yr = Object.assign(
  () => {
    let { activity: e, review: n, verbs: t, ...r } = Jr.chat.toolCards;
    Object.assign(he.chat.toolCards, r), Object.assign(he.chat.toolCards.activity, e), Object.assign(he.chat.toolCards.review, n), Object.assign(he.chat.toolCards.verbs, t);
  },
  { catalog: Jr }
);

// openclaw/ui/src/lib/protocol-validators.generated/activity.js
function ue(e) {
  let n = 0, t = 0, r = 0;
  for (; t < e.length; ) {
    let o = e.charCodeAt(t++) >> 10;
    n += +((r << 8 | o) !== 13879), r = o;
  }
  return n;
}
var eo = [
  /(^delegation$|^itemId$|^phase$|^kind$|^title$|^status$|^name$|^meta$|^commandBearing$|^toolCallId$|^unpairedCall$|^startedAt$|^endedAt$|^error$|^summary$|^progressText$|^suppressChannelProgress$|^hideFromChannelProgress$|^approvalId$|^approvalSlug$)/u,
  /(^runId$|^childSessionKey$|^label$|^groupId$|^runtimeMs$|^status$)/u,
  /(^sessionKey$|^agentId$|^sessionId$|^lifecycleRevision$|^runId$|^revision$|^updatedAt$|^headline$|^assessment$|^health$|^planProgress$)/u,
  /(^completed$|^total$)/u,
  /(^sessionKey$|^agentId$|^runId$|^text$)/u,
  /(^sessionKey$|^agentId$|^sessionId$|^messageId$|^emoji$|^action$|^actor$|^reactions$)/u,
  /(^type$|^id$|^label$|^avatarUrl$|^identity$)/u,
  /(^type$|^id$)/u,
  /(^type$|^id$)/u,
  /(^type$|^pluginId$|^domain$|^idKind$|^id$)/u,
  /(^type$|^pluginId$|^accountId$|^senderKind$|^id$)/u,
  /(^type$|^actorType$|^source$|^id$)/u,
  /(^emoji$|^count$|^identities$)/u,
  /(^id$|^label$)/u
], Ta = (e) => Sa(e), Sa = (e) => typeof e == "object" && e !== null && !Array.isArray(e) && "itemId" in e && "phase" in e && "kind" in e && "title" in e && Object.getOwnPropertyNames(e).every(
  (n, t) => eo[0].test(n) || no(e[n])
) && (e.delegation === void 0 || !("delegation" in e) || Ea(e.delegation)) && Fa(e.itemId) && La(e.phase) && Zr(e.kind) && Zr(e.title) && (e.status === void 0 || !("status" in e) || Ga(e.status)) && (e.name === void 0 || !("name" in e) || ee(e.name)) && (e.meta === void 0 || !("meta" in e) || ee(e.meta)) && (e.commandBearing === void 0 || !("commandBearing" in e) || Ve(e.commandBearing)) && (e.toolCallId === void 0 || !("toolCallId" in e) || ee(e.toolCallId)) && (e.unpairedCall === void 0 || !("unpairedCall" in e) || Ve(e.unpairedCall)) && (e.startedAt === void 0 || !("startedAt" in e) || Qr(e.startedAt)) && (e.endedAt === void 0 || !("endedAt" in e) || Qr(e.endedAt)) && (e.error === void 0 || !("error" in e) || ee(e.error)) && (e.summary === void 0 || !("summary" in e) || ee(e.summary)) && (e.progressText === void 0 || !("progressText" in e) || ee(e.progressText)) && (e.suppressChannelProgress === void 0 || !("suppressChannelProgress" in e) || Ve(e.suppressChannelProgress)) && (e.hideFromChannelProgress === void 0 || !("hideFromChannelProgress" in e) || Ve(e.hideFromChannelProgress)) && (e.approvalId === void 0 || !("approvalId" in e) || ee(e.approvalId)) && (e.approvalSlug === void 0 || !("approvalSlug" in e) || ee(e.approvalSlug)), no = (e) => !1, Ea = (e) => Array.isArray(e) && e.every((n, t) => _a(n)) && e.length <= 32, _a = (e) => typeof e == "object" && e !== null && !Array.isArray(e) && "runId" in e && "childSessionKey" in e && "status" in e && Object.getOwnPropertyNames(e).every(
  (n, t) => eo[1].test(n) || no(e[n])
) && Ia(e.runId) && Aa(e.childSessionKey) && (e.label === void 0 || !("label" in e) || Xr(e.label)) && (e.groupId === void 0 || !("groupId" in e) || Xr(e.groupId)) && (e.runtimeMs === void 0 || !("runtimeMs" in e) || va(e.runtimeMs)) && Ma(e.status), Ia = (e) => typeof e == "string" && (e.length >= 2 || e.length >= 1 && ue(e) >= 1) && (e.length <= 256 || e.length <= 512 && ue(e) <= 256), Aa = (e) => typeof e == "string" && (e.length >= 2 || e.length >= 1 && ue(e) >= 1) && (e.length <= 1024 || e.length <= 2048 && ue(e) <= 1024), Xr = (e) => typeof e == "string" && (e.length >= 2 || e.length >= 1 && ue(e) >= 1) && (e.length <= 512 || e.length <= 1024 && ue(e) <= 512), va = (e) => Number.isFinite(e) && e >= 0 && e <= 9007199254740991, Ma = (e) => Da(e) || Pa(e) || to(e) || Oa(e) || Na(e), Da = (e) => typeof e == "string" && e === "accepted", Pa = (e) => typeof e == "string" && e === "done", to = (e) => typeof e == "string" && e === "failed", Oa = (e) => typeof e == "string" && e === "killed", Na = (e) => typeof e == "string" && e === "timeout", Fa = (e) => typeof e == "string" && (e.length >= 2 || e.length >= 1 && ue(e) >= 1), La = (e) => Ua(e) || Ba(e) || ja(e), Ua = (e) => typeof e == "string" && e === "start", Ba = (e) => typeof e == "string" && e === "update", ja = (e) => typeof e == "string" && e === "end", Zr = (e) => typeof e == "string", Ga = (e) => Wa(e) || Ha(e) || to(e) || qa(e) || za(e), Wa = (e) => typeof e == "string" && e === "running", Ha = (e) => typeof e == "string" && e === "completed", qa = (e) => typeof e == "string" && e === "blocked", za = (e) => typeof e == "string" && e === "skipped", ee = (e) => typeof e == "string", Ve = (e) => typeof e == "boolean", Qr = (e) => Number.isFinite(e);
var ro = (e) => Ta(e);

// openclaw/ui/src/lib/chat/tool-call-grouping.ts
Yr();
function oo(e) {
  let n = N(e)?.activity;
  return Array.isArray(n) ? n.filter(ro) : [];
}

// openclaw/ui/src/lib/chat/tool-cards.ts
function $a(e) {
  return M(e.messageId) ?? M(L(e.__openclaw)?.id);
}
function io(e) {
  let n = L(L(e)?.__openclaw), t = L(n?.toolOutput);
  return (t?.source === "provider-response" || t?.source === "execution") && t.modelInput === "unverified" ? {
    source: t.source,
    modelInput: t.modelInput,
    ...t.outcome === "unknown" ? { outcome: "unknown" } : {},
    ...t.captureTruncated === !0 ? { captureTruncated: !0 } : {}
  } : void 0;
}
function Va(e) {
  return Array.isArray(e) ? e.filter((n) => ne(n) !== null) : [];
}
function Ka(e) {
  if (typeof e != "string")
    return e;
  let n = e.trim();
  return n.startsWith("{") || n.startsWith("[") ? tn(n) ?? e : e;
}
function Ja(e) {
  if (typeof e.text == "string")
    return e.text;
  if (typeof e.content == "string")
    return e.content;
  if (Array.isArray(e.content)) {
    let n = e.content.flatMap((t) => {
      let r = ne(t)?.text;
      return typeof r == "string" ? [r] : [];
    });
    if (n.length > 0)
      return n.join(`
`);
  }
}
function Ya(...e) {
  for (let n of e) {
    let t = ne(n), r = t?.exitCode ?? t?.exit_code;
    if (typeof r == "number" && Number.isInteger(r))
      return r;
  }
}
function uo(e) {
  if (e.activity)
    return e.activity.status === "skipped";
  let n = ne(e.details);
  return (e.live !== !0 || e.completed === !0) && n?.status === "skipped" && n.deniedReason === "steering";
}
function so(e) {
  if (uo(e))
    return !1;
  if (e.activity)
    return e.activity.status === "failed";
  let n = e.live !== !0 || e.completed === !0;
  return e.isError ?? (n && It(e.outputText));
}
function po(e, n) {
  if (uo(e))
    return "skipped";
  if (e.toolOutput?.outcome === "unknown")
    return so(e) ? "failed" : "unknown";
  if (e.activity) {
    let { status: t, phase: r } = e.activity;
    return t === "failed" || t === "blocked" ? t : t === "completed" ? "succeeded" : n === !0 && e.live === !0 && (t === "running" || r !== "end" && e.completed !== !0) ? "running" : "unknown";
  }
  return so(e) ? "failed" : n === !0 && e.live === !0 && e.completed !== !0 ? "running" : e.completed === !0 || e.live !== !0 && e.outputText !== void 0 ? "succeeded" : "unknown";
}
function Xa(e) {
  let n = St(e);
  return n?.surface === "assistant_message" ? { ...n, surface: "assistant_message" } : void 0;
}
function Za(e, n, t) {
  let r = Tt(e), o = r?.surface === "assistant_message" ? { ...r, surface: "assistant_message" } : Xa(n);
  if (o)
    return { preview: { ...o, surface: "assistant_message" } };
  let i = L(L(e)?.browserTab), s = Dn(i);
  if (t !== "browser" || !i || !s)
    return {};
  let a = typeof i.url == "string" ? ge(i.url, 2048) : "";
  return {
    browserTab: s,
    preview: bt(a) ? {
      kind: "browser-tab",
      ...s,
      url: a,
      ...typeof i.title == "string" ? { title: ge(i.title, 512) } : {}
    } : void 0
  };
}
function ao(e, n) {
  return _t(e) ?? B(e.callId) ?? B(n.toolCallId) ?? B(n.tool_call_id) ?? B(n.toolUseId) ?? B(n.tool_use_id);
}
function In(e, n) {
  return B(e.name) ?? B(n.toolName) ?? B(n.tool_name) ?? "tool";
}
function Qa(e) {
  if (e != null)
    return typeof e == "string" ? e : JSON.stringify(e, null, 2);
}
var ec = 0;
function nc(e) {
  return sn(e.type) || typeof e.name == "string" && (e.arguments != null || e.args != null || e.input != null);
}
function co(e) {
  let n = e, t = typeof n.role == "string" ? n.role.toLowerCase() : "", r = En(e) || t === "tool" || t === "function" || typeof n.toolName == "string" || typeof n.tool_name == "string", o = Va(n.content), i = De(n), s = n.__openclawToolStreamLive === !0, a = Hr(n.__openclawToolStreamDiffStat), u = [], d = /* @__PURE__ */ new WeakSet(), h = $a(n), g = on(n)?.runId ?? M(n.runId), m = (f, p, y = !1) => {
    let b = Ja(f), w = f.details ?? n.details, R = L(f.__openclaw), k = De(f) ?? i, x = Ya(
      f,
      w,
      b ? ie(b.trim()) : void 0,
      y ? void 0 : n
    );
    return {
      outputText: b,
      resultMessageId: !y && R && Object.hasOwn(R, "id") ? M(R.id) : h,
      outputTruncated: (R && Object.hasOwn(R, "truncated") ? R : L(n.__openclaw))?.truncated === !0,
      toolOutput: io(f) ?? io(n),
      ...w !== void 0 ? { details: w } : {},
      ...k !== void 0 ? { isError: k } : {},
      ...x !== void 0 ? { exitCode: x } : {},
      ...Za(w, b, p)
    };
  };
  for (let f = 0; f < o.length; f++) {
    let p = o[f] ?? {}, y = nc(p);
    if (!y && !Me(p.type))
      continue;
    let b = M(p.runId) ?? g, w = M(p.parentToolCallId), R = ao(p, n), k = In(p, n), x = {
      id: R ?? `${k}:${f}`,
      ...R ? { callId: R } : {},
      ...b ? { runId: b } : {},
      ...w ? { parentToolCallId: w } : {},
      name: k,
      messageId: h
    }, S = p.details ?? n.details;
    if (y) {
      let A = Ka(p.arguments ?? p.args ?? p.input);
      u.push({
        ...x,
        args: A,
        inputText: Qa(A),
        ...S !== void 0 ? { details: S } : {},
        ...s ? {
          live: !0,
          completed: n.__openclawToolStreamResultReceived === !0 || n.__openclawToolStreamItemEnded === !0
        } : {},
        ...a ? { liveDiffStat: a } : {}
      });
      continue;
    }
    let v = u.find((A) => A.id === x.id) ?? u.find(
      (A) => (
        // Same-name fallback belongs to legacy blocks missing an explicit identity.
        (!R || !A.callId) && A.name === k && A.outputText === void 0 && !d.has(A)
      )
    ), E = r ? In({}, n) : void 0, O = E && E !== "browser" ? E : v?.name ?? E ?? k, I = m(p, O);
    if (v) {
      d.add(v), v.callId ??= R, v.runId ??= b, v.parentToolCallId ??= w, s || (v.completed = !0), Object.assign(v, I, {
        preview: I.preview,
        browserTab: I.browserTab
      });
      continue;
    }
    u.push({
      ...x,
      completed: !0,
      ...I
    });
  }
  if (r && u.length === 0) {
    let f = typeof n.toolName == "string" && n.toolName || typeof n.tool_name == "string" && n.tool_name || "tool", p = ao({}, n);
    u.push({
      id: p ?? `${In({}, n)}:0`,
      ...p ? { callId: p } : {},
      ...g ? { runId: g } : {},
      name: f,
      completed: En(e) || t === "tool" || t === "function",
      messageId: h,
      ...m(n, f, !0)
    });
  }
  let c = new Map(
    oo(e).filter((f) => !f.suppressChannelProgress).map((f) => [f.toolCallId ?? f.itemId, f])
  ), l;
  for (let [f, p] of u.entries()) {
    let y = p.callId ? c.get(p.callId) : void 0;
    y && (p.activity = y), !(!p.browserTab || p.callId || p.messageId) && (l ??= ++ec, p.previewRevision = `${l}:${f}`);
  }
  return u;
}
var lo = /* @__PURE__ */ new WeakMap();
function fo(e) {
  if (!e || typeof e != "object")
    return co(e);
  let n = lo.get(e);
  if (n)
    return n;
  let t = co(e);
  return lo.set(e, t), t;
}

// openclaw/ui/src/lib/chat/browser-tab-preview.ts
function tc(e) {
  return e.callId ?? e.messageId ?? e.previewRevision;
}
var ho = /* @__PURE__ */ new WeakMap();
function go(e, n) {
  let t = ho.get(e);
  if (t?.toolMessages === n)
    return t.latest;
  let r = /* @__PURE__ */ new Map();
  for (let o of [e, n])
    for (let i of o)
      if (V(i))
        for (let s of fo(i)) {
          let a = tc(s);
          if (s.browserTab && a && po(s, !1) === "succeeded") {
            let u = Pn(s.browserTab);
            r.delete(u), r.set(u, { tab: s.browserTab, revision: a });
          }
        }
  return ho.set(e, { toolMessages: n, latest: r }), r;
}

// octogee/app/openclaw-browser/resources.ts
function om(e, n) {
  return [...go(e, []).values()].filter((r) => r.tab.target === "host" && r.tab.profile === n).at(-1) ?? null;
}
export {
  om as latestNativeBrowserTab
};
/*!
TypeBox

The MIT License (MIT)

Copyright (c) 2017-2026 Haydn Paterson

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
*/
/*! Bundled license information:

markdown-it/dist/markdown-it.mjs:
  (*! markdown-it 15.0.3 https://github.com/markdown-it/markdown-it @license MIT *)
*/

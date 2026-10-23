// @ts-nocheck
var jo = Object.create;
var Ke = Object.defineProperty;
var Go = Object.getOwnPropertyDescriptor;
var qo = Object.getOwnPropertyNames;
var Wo = Object.getPrototypeOf, zo = Object.prototype.hasOwnProperty;
var E = (e, n, t) => () => {
  if (t) throw t[0];
  try {
    return e && (n = e(e = 0)), n;
  } catch (o) {
    throw t = [o], o;
  }
};
var Pn = (e, n) => () => {
  try {
    return n || e((n = { exports: {} }).exports, n), n.exports;
  } catch (t) {
    throw n = 0, t;
  }
}, On = (e, n) => {
  for (var t in n)
    Ke(e, t, { get: n[t], enumerable: !0 });
}, Ho = (e, n, t, o) => {
  if (n && typeof n == "object" || typeof n == "function")
    for (let r of qo(n))
      !zo.call(e, r) && r !== t && Ke(e, r, { get: () => n[r], enumerable: !(o = Go(n, r)) || o.enumerable });
  return e;
};
var Nn = (e, n, t) => (t = e != null ? jo(Wo(e)) : {}, Ho(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  n || !e || !e.__esModule ? Ke(t, "default", { value: e, enumerable: !0 }) : t,
  e
));

// openclaw/packages/normalization-core/src/record-coerce.ts
function J(e) {
  return e !== null && typeof e == "object" && !Array.isArray(e);
}
function L(e) {
  return J(e) ? e : void 0;
}
function B(e) {
  return J(e) ? e : null;
}
function Je(e) {
  return e && typeof e == "object" ? e : void 0;
}
function oe(e) {
  return Je(e) ?? null;
}
var N = E(() => {
});

// openclaw/ui/src/components/browser/browser-target.ts
function Ye(e, n = 128) {
  return typeof e == "string" && e.length > 0 && e.length <= n && e.trim() === e;
}
function Fn(e) {
  let n = B(e);
  if (!Ye(n?.targetId) || !Ye(n.profile))
    return;
  let t = { targetId: n.targetId, profile: n.profile };
  if (n.target === "host" && n.node === void 0)
    return { ...t, target: "host" };
  if (n.target === "node" && Ye(n.node, 256))
    return { ...t, target: "node", node: n.node };
}
function Ln(e) {
  return JSON.stringify([e.target, e.node, e.profile, e.targetId]);
}
var Xe = E(() => {
  N();
});

// openclaw/packages/gateway-client/src/device-auth.ts
var Un = E(() => {
});

// openclaw/packages/gateway-client/src/chat-stream-message.ts
var Bn = E(() => {
  N();
});

// openclaw/packages/gateway-client/src/chat-stream-projection.ts
var jn = E(() => {
  N();
});

// openclaw/packages/normalization-core/src/string-coerce.ts
function j(e) {
  if (typeof e != "string")
    return null;
  let n = e.trim();
  return n || null;
}
function q(e) {
  return j(e) ?? void 0;
}
function P(e) {
  return typeof e == "string" && e.trim() ? e : void 0;
}
var W = E(() => {
});

// openclaw/packages/normalization-core/src/number-coercion.ts
function ie(e) {
  return typeof e == "number" && Number.isFinite(e) ? e : void 0;
}
var $o, gc, se = E(() => {
  W();
  $o = 2147e6, gc = Math.floor($o / 1e3);
});

// openclaw/packages/normalization-core/src/string-normalization.ts
var ve = E(() => {
  W();
});

// openclaw/packages/gateway-protocol/src/connect-error-details.ts
var D, Cc, Tc, Ze = E(() => {
  se();
  ve();
  D = {
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
  }, Cc = /* @__PURE__ */ new Map([
    ["token_missing", D.AUTH_TOKEN_MISSING],
    ["token_mismatch", D.AUTH_TOKEN_MISMATCH],
    ["token_missing_config", D.AUTH_TOKEN_NOT_CONFIGURED],
    ["password_missing", D.AUTH_PASSWORD_MISSING],
    ["password_mismatch", D.AUTH_PASSWORD_MISMATCH],
    ["password_missing_config", D.AUTH_PASSWORD_NOT_CONFIGURED],
    ["bootstrap_token_invalid", D.AUTH_BOOTSTRAP_TOKEN_INVALID],
    ["tailscale_user_missing", D.AUTH_TAILSCALE_IDENTITY_MISSING],
    ["tailscale_proxy_missing", D.AUTH_TAILSCALE_PROXY_MISSING],
    ["tailscale_whois_failed", D.AUTH_TAILSCALE_WHOIS_FAILED],
    ["tailscale_user_mismatch", D.AUTH_TAILSCALE_IDENTITY_MISMATCH],
    ["rate_limited", D.AUTH_RATE_LIMITED],
    ["device_token_mismatch", D.AUTH_DEVICE_TOKEN_MISMATCH],
    ["scope_mismatch", D.AUTH_SCOPE_MISMATCH],
    [void 0, D.AUTH_REQUIRED]
  ]), Tc = /* @__PURE__ */ new Map([
    ["device-id-mismatch", D.DEVICE_AUTH_DEVICE_ID_MISMATCH],
    ["device-signature-stale", D.DEVICE_AUTH_SIGNATURE_EXPIRED],
    ["device-nonce-missing", D.DEVICE_AUTH_NONCE_REQUIRED],
    ["device-nonce-mismatch", D.DEVICE_AUTH_NONCE_MISMATCH],
    ["device-signature", D.DEVICE_AUTH_SIGNATURE_INVALID],
    ["device-public-key", D.DEVICE_AUTH_PUBLIC_KEY_INVALID]
  ]);
});

// openclaw/packages/gateway-client/src/connect-auth.ts
var Gn = E(() => {
  W();
});

// openclaw/packages/gateway-client/src/browser-device-auth.ts
var qn = E(() => {
});

// openclaw/packages/gateway-client/src/gateway-origin-scope.ts
var Wn = E(() => {
});

// openclaw/packages/gateway-client/src/model-catalog-connect.ts
var zn = E(() => {
});

// openclaw/packages/retry/src/index.ts
function Me(e, n, t, o) {
  return typeof e != "number" || !Number.isFinite(e) ? n : Math.min(
    Math.max(e, t ?? Number.NEGATIVE_INFINITY),
    o ?? Number.POSITIVE_INFINITY
  );
}
function ye(e) {
  let n = e === Number.POSITIVE_INFINITY ? 2147e6 : Number.isFinite(e) ? e : 0;
  return Math.min(Math.max(Math.round(n), 0), 2147e6);
}
function Jo(e = Hn, n) {
  let t = Math.max(1, Math.round(Me(n?.attempts, e.attempts))), o = ye(
    Me(n?.minDelayMs, e.minDelayMs, 0)
  ), r = Math.max(
    o,
    ye(Me(n?.maxDelayMs, e.maxDelayMs, 0))
  ), i = n?.jitter, a = e.jitter;
  return {
    attempts: t,
    minDelayMs: o,
    maxDelayMs: r,
    jitter: i === "full" ? i : typeof i == "number" && Number.isFinite(i) ? Math.min(Math.max(i, 0), 1) : a
  };
}
function Yo(e, n, t, o) {
  if (n === "full")
    return t === "symmetric" ? Math.max(0, Math.round(e * (0.5 + o() * 0.5))) : Math.max(0, Math.ceil(e * (1 + o())));
  if (n <= 0)
    return t === "positive" ? Math.ceil(e) : e;
  let r = o(), i = t === "positive" ? r * n : (r * 2 - 1) * n, a = e * (1 + i);
  return Math.max(0, t === "positive" ? Math.ceil(a) : Math.round(a));
}
function Xo(e, n = "Non-Error thrown") {
  if (e instanceof Error)
    return e;
  if (typeof e == "string")
    return new Error(e);
  let t = new Error(n, { cause: e });
  return (typeof e == "object" && e !== null || typeof e == "function") && Object.assign(t, e), t;
}
function Zo(e = {}) {
  let n = e.sleep ?? Ko, t = e.random ?? Math.random, o = e.createFailure ?? ((r) => Xo(r.at(-1) ?? new Error("Retry failed")));
  return async function(i, a = 3, c = 300) {
    let d = [], p = typeof a == "number", g = typeof a == "number" ? { attempts: a } : a, m = Jo(Hn, g), y = m.attempts, l = m.minDelayMs, u = m.maxDelayMs > 0 ? m.maxDelayMs : Number.POSITIVE_INFINITY, h = g.retryAfterMaxDelayMs === void 0 ? u : Math.max(
      l,
      ye(Me(g.retryAfterMaxDelayMs, u, 0))
    ), f = g.random ?? t, b = g.sleep ?? n, w = g.shouldRetry ?? (() => !0);
    for (let R = 1; R <= y; R += 1)
      try {
        return await i();
      } catch (k) {
        if (d.push(k), R >= y || !w(k, R))
          break;
        if (p) {
          await n(ye(c * 2 ** (R - 1)));
          continue;
        }
        let x = {
          attempt: R,
          maxAttempts: y,
          err: k,
          label: g.label
        }, C = g.retryAfterMs?.(k), M = typeof C == "number" && Number.isFinite(C), v = typeof g.delayMs == "function" ? g.delayMs(x) : g.delayMs, S = v === void 0 ? void 0 : ye(v), O = M ? Math.max(C, l) : S === void 0 ? l * 2 ** (R - 1) : Math.max(S, l), I = M ? h : u, A = Math.min(O, I), G = M && (C ?? 0) <= I, H = m.jitter === "full" && !M || G;
        A = Yo(
          A,
          m.jitter,
          H ? "positive" : "symmetric",
          f
        ), A = Math.min(Math.max(A, l), I), await g.onRetry?.({ ...x, delayMs: A }), A > 0 && await b(A);
      }
    throw o(d);
  };
}
var Hn, Ko, Mc, $n = E(() => {
  Hn = {
    attempts: 3,
    minDelayMs: 300,
    maxDelayMs: 3e4,
    jitter: 0
  }, Ko = async (e) => {
    let n = e;
    do {
      let t = Math.min(n, 2147e6);
      await new Promise((o) => {
        setTimeout(o, t);
      }), n -= t;
    } while (n > 0);
  };
  Mc = Zo();
});

// openclaw/packages/gateway-protocol/src/startup-unavailable.ts
var Vn = E(() => {
});

// openclaw/packages/gateway-client/src/protocol-client.ts
var Kn = E(() => {
  N();
  ve();
  $n();
});

// openclaw/packages/gateway-client/src/reconnect-policy.ts
var $c, Jn = E(() => {
  Ze();
  $c = /* @__PURE__ */ new Set([
    D.AUTH_TOKEN_MISSING,
    D.AUTH_BOOTSTRAP_TOKEN_INVALID,
    D.AUTH_PASSWORD_MISSING,
    D.AUTH_PASSWORD_MISMATCH,
    D.AUTH_RATE_LIMITED,
    D.AUTH_DEVICE_TOKEN_MISMATCH,
    D.AUTH_SCOPE_MISMATCH,
    D.AUTH_IDENTITY_HEADER_REQUIRED,
    D.AUTH_VERIFIED_USER_REQUIRED,
    D.CONTROL_UI_BUILD_MISMATCH,
    D.PAIRING_REQUIRED,
    D.PAIRING_REJECTED,
    D.PAIRING_EXPIRED,
    D.CONTROL_UI_DEVICE_IDENTITY_REQUIRED,
    D.DEVICE_IDENTITY_REQUIRED
  ]);
});

// openclaw/packages/normalization-core/src/stable-stringify.ts
var Yn = E(() => {
});

// openclaw/packages/gateway-protocol/src/gateway-error-details.ts
var Xn = E(() => {
});

// openclaw/packages/gateway-client/src/session-projection-message-identity.ts
function Zn(e) {
  return typeof e == "number" && Number.isSafeInteger(e) && e > 0 ? e : null;
}
function Qn(e, n) {
  let t = B(B(e)?.__openclaw);
  return Zn(t?.seq) ?? Zn(n?.messageSeq);
}
function be(e) {
  let n = j(e);
  return n?.endsWith(":user") ? n.slice(0, -5) || null : n;
}
function Qe(e, n) {
  let t = B(e), o = j(t?.role)?.toLowerCase();
  if (!t || !o)
    return null;
  let r = B(t.__openclaw), i = j(r?.importedFrom), a = j(r?.cliSessionId), c = j(r?.externalId), d = B(r?.transcriptPosition), p = j(d?.source), m = !(p !== null && p.length <= 128 && typeof d?.rawSeq == "number" && Number.isSafeInteger(d.rawSeq) && d.rawSeq >= 0) && !!(i || a || c), y = j(r?.idempotencyKey) ?? j(t.idempotencyKey) ?? j(n?.idempotencyKey) ?? j(n?.clientRunId), l = be(y), u = be(n?.runId), h = be(r?.runId), f = be(
    B(t.openclawStreamFallback)?.runId
  ), b = j(r?.mirrorOrigin) !== null, w = o === "assistant" && j(t.api)?.toLowerCase() === "cli", R = w && l?.startsWith("cli-assistant:") ? j(l.slice(14)) : l, k = o === "assistant" ? h ?? u ?? f ?? (w || !b ? R : null) : h ?? R ?? u;
  return {
    role: o,
    id: j(r?.id) ?? j(n?.messageId),
    sequence: Qn(e, n),
    idempotencyKey: y,
    sendId: o === "user" ? l ?? k : null,
    runId: k,
    isImported: m,
    // Imported IDs belong to their provider and CLI session, never the native ID namespace.
    externalSource: m && i && a && c ? JSON.stringify([i, a, c]) : null
  };
}
var et = E(() => {
  N();
  W();
});

// openclaw/packages/gateway-client/src/session-projection.ts
var nt = E(() => {
  N();
  W();
  et();
});

// openclaw/packages/normalization-core/src/result.ts
var tt = E(() => {
});

// openclaw/packages/normalization-core/src/agent-id.ts
var rt = E(() => {
  tt();
});

// openclaw/packages/normalization-core/src/uuid.ts
var ot = E(() => {
});

// openclaw/packages/gateway-client/src/session-subscriptions.ts
var it = E(() => {
  rt();
  ot();
});

// openclaw/packages/gateway-protocol/src/client-info.ts
var Qo, ei, yl, bl, st = E(() => {
  W();
  Qo = {
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
  }, ei = {
    WEBCHAT: "webchat",
    CLI: "cli",
    UI: "ui",
    BACKEND: "backend",
    NODE: "node",
    WORKER: "worker",
    PROBE: "probe",
    TEST: "test"
  }, yl = new Map(
    Object.values(Qo).map((e) => [e, e])
  ), bl = new Map(
    Object.values(ei).map((e) => [e, e])
  );
});

// openclaw/packages/gateway-protocol/src/session-row-deltas.ts
var at = E(() => {
});

// openclaw/packages/gateway-protocol/src/version.ts
var ct = E(() => {
});

// openclaw/packages/gateway-client/src/browser.ts
var lt = E(() => {
  Un();
  Bn();
  jn();
  qn();
  Wn();
  Gn();
  zn();
  Kn();
  Jn();
  nt();
  it();
  st();
  Ze();
  Xn();
  at();
  Vn();
  ct();
});

// openclaw/packages/normalization-core/src/balanced-json.ts
var dt = E(() => {
});

// openclaw/packages/normalization-core/src/boolean-coercion.ts
var pt = E(() => {
});

// openclaw/packages/normalization-core/src/cjk-chars.ts
var en, Wl, zl, ft = E(() => {
  en = [
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
  ], Wl = new RegExp(
    `[${en.flatMap(
      (e) => e.map(([n, t]) => `\\u{${n.toString(16)}}-\\u{${t.toString(16)}}`)
    ).join("")}]`,
    "u"
  ), zl = (() => {
    let e = Math.max(
      ...en.flatMap((t) => t.map(([, o]) => o))
    ), n = new Uint8Array(e + 1);
    for (let [t, o] of en.entries())
      for (let [r, i] of o)
        n.fill(t + 1, r, i + 1);
    return n;
  })();
});

// openclaw/packages/normalization-core/src/code-points.ts
var nn = E(() => {
});

// openclaw/packages/normalization-core/src/error-coercion.ts
var ti, gt, mt, ht, yt = E(() => {
  ti = /* @__PURE__ */ Symbol.for(
    "openclaw.provider-auth-persistence-error"
  ), ht = class extends (mt = AggregateError, gt = ti, mt) {
    constructor(t, o, { cause: r }) {
      super([o, r], t, { cause: r });
      this[gt] = !0;
      this.persistenceError = o, this.cleanupError = r;
    }
  };
});

// openclaw/packages/normalization-core/src/expect.ts
var tn = E(() => {
});

// openclaw/packages/normalization-core/src/format.ts
var bt = E(() => {
  tn();
});

// openclaw/packages/normalization-core/src/json-coercion.ts
function rn(e) {
  try {
    return JSON.parse(e);
  } catch {
    return;
  }
}
function ce(e) {
  return /^[\t\n\r ]*\{/.test(e) ? L(rn(e)) : void 0;
}
var on = E(() => {
  N();
});

// openclaw/packages/normalization-core/src/response-bytes.ts
var wt = E(() => {
});

// openclaw/packages/normalization-core/src/text-decoding.ts
var kt = E(() => {
});

// openclaw/packages/normalization-core/src/utf16-slice.ts
function Rt(e) {
  return e >= 55296 && e <= 56319;
}
function xt(e) {
  return e >= 56320 && e <= 57343;
}
function ri(e, n, t) {
  let o = e.length, r = n < 0 ? Math.max(o + n, 0) : Math.min(n, o), i = t === void 0 ? o : t < 0 ? Math.max(o + t, 0) : Math.min(t, o);
  if (i <= r)
    return "";
  if (r > 0 && r < o) {
    let a = e.charCodeAt(r);
    xt(a) && Rt(e.charCodeAt(r - 1)) && (r += 1);
  }
  if (i > 0 && i < o) {
    let a = e.charCodeAt(i - 1);
    Rt(a) && xt(e.charCodeAt(i)) && (i -= 1);
  }
  return e.slice(r, i);
}
function we(e, n) {
  let t = Math.max(0, Math.floor(n));
  return e.length <= t ? e : ri(e, 0, t);
}
var ke = E(() => {
});

// openclaw/packages/normalization-core/src/index.ts
var Y = E(() => {
  dt();
  pt();
  ft();
  nn();
  yt();
  tn();
  bt();
  on();
  se();
  N();
  wt();
  Yn();
  W();
  ve();
  kt();
  ke();
});

// openclaw/node_modules/.pnpm/punycode.js@2.3.1/node_modules/punycode.js/punycode.js
var pr = Pn((Fp, dr) => {
  "use strict";
  var Xi = /^xn--/, Zi = /[^\0-\x7F]/, Qi = /[\x2E\u3002\uFF0E\uFF61]/g, es = {
    overflow: "Overflow: input needs wider integers to process",
    "not-basic": "Illegal input >= 0x80 (not a basic code point)",
    "invalid-input": "Invalid input"
  }, mn = 35, X = Math.floor, yn = String.fromCharCode;
  function ne(e) {
    throw new RangeError(es[e]);
  }
  function ns(e, n) {
    let t = [], o = e.length;
    for (; o--; )
      t[o] = n(e[o]);
    return t;
  }
  function sr(e, n) {
    let t = e.split("@"), o = "";
    t.length > 1 && (o = t[0] + "@", e = t[1]), e = e.replace(Qi, ".");
    let r = e.split("."), i = ns(r, n).join(".");
    return o + i;
  }
  function ar(e) {
    let n = [], t = 0, o = e.length;
    for (; t < o; ) {
      let r = e.charCodeAt(t++);
      if (r >= 55296 && r <= 56319 && t < o) {
        let i = e.charCodeAt(t++);
        (i & 64512) == 56320 ? n.push(((r & 1023) << 10) + (i & 1023) + 65536) : (n.push(r), t--);
      } else
        n.push(r);
    }
    return n;
  }
  var ts = (e) => String.fromCodePoint(...e), rs = function(e) {
    return e >= 48 && e < 58 ? 26 + (e - 48) : e >= 65 && e < 91 ? e - 65 : e >= 97 && e < 123 ? e - 97 : 36;
  }, ir = function(e, n) {
    return e + 22 + 75 * (e < 26) - ((n != 0) << 5);
  }, cr = function(e, n, t) {
    let o = 0;
    for (e = t ? X(e / 700) : e >> 1, e += X(e / n); e > mn * 26 >> 1; o += 36)
      e = X(e / mn);
    return X(o + (mn + 1) * e / (e + 38));
  }, lr = function(e) {
    let n = [], t = e.length, o = 0, r = 128, i = 72, a = e.lastIndexOf("-");
    a < 0 && (a = 0);
    for (let c = 0; c < a; ++c)
      e.charCodeAt(c) >= 128 && ne("not-basic"), n.push(e.charCodeAt(c));
    for (let c = a > 0 ? a + 1 : 0; c < t; ) {
      let d = o;
      for (let g = 1, m = 36; ; m += 36) {
        c >= t && ne("invalid-input");
        let y = rs(e.charCodeAt(c++));
        y >= 36 && ne("invalid-input"), y > X((2147483647 - o) / g) && ne("overflow"), o += y * g;
        let l = m <= i ? 1 : m >= i + 26 ? 26 : m - i;
        if (y < l)
          break;
        let u = 36 - l;
        g > X(2147483647 / u) && ne("overflow"), g *= u;
      }
      let p = n.length + 1;
      i = cr(o - d, p, d == 0), X(o / p) > 2147483647 - r && ne("overflow"), r += X(o / p), o %= p, n.splice(o++, 0, r);
    }
    return String.fromCodePoint(...n);
  }, ur = function(e) {
    let n = [];
    e = ar(e);
    let t = e.length, o = 128, r = 0, i = 72;
    for (let d of e)
      d < 128 && n.push(yn(d));
    let a = n.length, c = a;
    for (a && n.push("-"); c < t; ) {
      let d = 2147483647;
      for (let g of e)
        g >= o && g < d && (d = g);
      let p = c + 1;
      d - o > X((2147483647 - r) / p) && ne("overflow"), r += (d - o) * p, o = d;
      for (let g of e)
        if (g < o && ++r > 2147483647 && ne("overflow"), g === o) {
          let m = r;
          for (let y = 36; ; y += 36) {
            let l = y <= i ? 1 : y >= i + 26 ? 26 : y - i;
            if (m < l)
              break;
            let u = m - l, h = 36 - l;
            n.push(
              yn(ir(l + u % h, 0))
            ), m = X(u / h);
          }
          n.push(yn(ir(m, 0))), i = cr(r, p, c === a), r = 0, ++c;
        }
      ++r, ++o;
    }
    return n.join("");
  }, os = function(e) {
    return sr(e, function(n) {
      return Xi.test(n) ? lr(n.slice(4).toLowerCase()) : n;
    });
  }, is = function(e) {
    return sr(e, function(n) {
      return Zi.test(n) ? "xn--" + ur(n) : n;
    });
  }, ss = {
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
      decode: ar,
      encode: ts
    },
    decode: lr,
    encode: ur,
    toASCII: is,
    toUnicode: os
  };
  dr.exports = ss;
});

// openclaw/node_modules/.pnpm/ipaddr.js@2.5.0/node_modules/ipaddr.js/lib/ipaddr.js
var qr = Pn((Gr, $e) => {
  (function(e) {
    "use strict";
    let n = "(0?\\d+|0x[a-f0-9]+)", t = {
      fourOctet: new RegExp(`^${n}\\.${n}\\.${n}\\.${n}$`, "i"),
      threeOctet: new RegExp(`^${n}\\.${n}\\.${n}$`, "i"),
      twoOctet: new RegExp(`^${n}\\.${n}$`, "i"),
      longValue: new RegExp(`^${n}$`, "i")
    }, o = new RegExp("^0[0-7]+$", "i"), r = new RegExp("^0x[a-f0-9]+$", "i"), i = "%[0-9a-z]{1,}", a = "(?:[0-9a-f]+::?)+", c = {
      zoneIndex: new RegExp(i, "i"),
      native: new RegExp(`^(::)?(${a})?([0-9a-f]+)?(::)?(${i})?$`, "i"),
      deprecatedTransitional: new RegExp(`^(?:::)(${n}\\.${n}\\.${n}\\.${n}(${i})?)$`, "i"),
      transitional: new RegExp(`^((?:${a})|(?:::)(?:${a})?)${n}\\.${n}\\.${n}\\.${n}(${i})?$`, "i")
    };
    function d(l, u) {
      if (l.indexOf("::") !== l.lastIndexOf("::"))
        return null;
      let h = 0, f = -1, b = (l.match(c.zoneIndex) || [])[0], w, R;
      for (b && (b = b.substring(1), l = l.replace(/%.+$/, "")); (f = l.indexOf(":", f + 1)) >= 0; )
        h++;
      if (l.substr(0, 2) === "::" && h--, l.substr(-2, 2) === "::" && h--, h >= u)
        return null;
      for (R = u - h, w = ":"; R--; )
        w += "0:";
      return l = l.replace("::", w), l[0] === ":" && (l = l.slice(1)), l[l.length - 1] === ":" && (l = l.slice(0, -1)), u = (function() {
        let k = l.split(":"), x = [];
        for (let C = 0; C < k.length; C++)
          x.push(k[C].length > 4 ? NaN : parseInt(k[C], 16));
        return x;
      })(), {
        parts: u,
        zoneId: b
      };
    }
    function p(l, u, h, f) {
      if (l.length !== u.length)
        throw new Error("ipaddr: cannot match CIDR for objects with different lengths");
      let b = 0, w;
      for (; f > 0; ) {
        if (w = h - f, w < 0 && (w = 0), l[b] >> w !== u[b] >> w)
          return !1;
        f -= h, b += 1;
      }
      return !0;
    }
    function g(l) {
      if (r.test(l))
        return parseInt(l, 16);
      if (l[0] === "0" && !isNaN(parseInt(l[1], 10))) {
        if (o.test(l))
          return parseInt(l, 8);
        throw new Error(`ipaddr: cannot parse ${l} as octal`);
      }
      return parseInt(l, 10);
    }
    function m(l, u) {
      for (; l.length < u; )
        l = `0${l}`;
      return l;
    }
    let y = {};
    y.IPv4 = (function() {
      function l(u) {
        if (u.length !== 4)
          throw new Error("ipaddr: ipv4 octet count should be 4");
        let h, f;
        for (h = 0; h < u.length; h++)
          if (f = u[h], !(0 <= f && f <= 255))
            throw new Error("ipaddr: ipv4 octet should fit in 8 bits");
        this.octets = u;
      }
      return l.prototype.SpecialRanges = {
        unspecified: [[new l([0, 0, 0, 0]), 8]],
        broadcast: [[new l([255, 255, 255, 255]), 32]],
        // RFC3171
        multicast: [[new l([224, 0, 0, 0]), 4]],
        // RFC3927
        linkLocal: [[new l([169, 254, 0, 0]), 16]],
        // RFC5735
        loopback: [[new l([127, 0, 0, 0]), 8]],
        // RFC6598
        carrierGradeNat: [[new l([100, 64, 0, 0]), 10]],
        // RFC1918
        private: [
          [new l([10, 0, 0, 0]), 8],
          [new l([172, 16, 0, 0]), 12],
          [new l([192, 168, 0, 0]), 16]
        ],
        // Reserved and testing-only ranges; RFCs 5735, 5737, 2544, 1700
        reserved: [
          [new l([192, 0, 0, 0]), 24],
          [new l([192, 0, 2, 0]), 24],
          [new l([192, 88, 99, 0]), 24],
          [new l([198, 18, 0, 0]), 15],
          [new l([198, 51, 100, 0]), 24],
          [new l([203, 0, 113, 0]), 24],
          [new l([240, 0, 0, 0]), 4]
        ],
        // RFC7534, RFC7535
        as112: [
          [new l([192, 175, 48, 0]), 24],
          [new l([192, 31, 196, 0]), 24]
        ],
        // RFC7450
        amt: [
          [new l([192, 52, 193, 0]), 24]
        ]
      }, l.prototype.kind = function() {
        return "ipv4";
      }, l.prototype.match = function(u, h) {
        let f;
        if (h === void 0 && (f = u, u = f[0], h = f[1]), u.kind() !== "ipv4")
          throw new Error("ipaddr: cannot match ipv4 address with non-ipv4 one");
        return p(this.octets, u.octets, 8, h);
      }, l.prototype.prefixLengthFromSubnetMask = function() {
        let u = 0, h = !1, f = {
          0: 8,
          128: 7,
          192: 6,
          224: 5,
          240: 4,
          248: 3,
          252: 2,
          254: 1,
          255: 0
        }, b, w, R;
        for (b = 3; b >= 0; b -= 1)
          if (w = this.octets[b], w in f) {
            if (R = f[w], h && R !== 0)
              return null;
            R !== 8 && (h = !0), u += R;
          } else
            return null;
        return 32 - u;
      }, l.prototype.range = function() {
        return y.subnetMatch(this, this.SpecialRanges);
      }, l.prototype.toByteArray = function() {
        return this.octets.slice(0);
      }, l.prototype.toIPv4MappedAddress = function() {
        return y.IPv6.parse(`::ffff:${this.toString()}`);
      }, l.prototype.toNormalizedString = function() {
        return this.toString();
      }, l.prototype.toString = function() {
        return this.octets.join(".");
      }, l;
    })(), y.IPv4.broadcastAddressFromCIDR = function(l) {
      try {
        let u = this.parseCIDR(l), h = u[0].toByteArray(), f = this.subnetMaskFromPrefixLength(u[1]).toByteArray(), b = [], w = 0;
        for (; w < 4; )
          b.push(parseInt(h[w], 10) | parseInt(f[w], 10) ^ 255), w++;
        return new this(b);
      } catch (u) {
        throw new Error("ipaddr: the address does not have IPv4 CIDR format", { cause: u });
      }
    }, y.IPv4.isIPv4 = function(l) {
      return this.parser(l) !== null;
    }, y.IPv4.isValid = function(l) {
      try {
        return new this(this.parser(l)), !0;
      } catch {
        return !1;
      }
    }, y.IPv4.isValidCIDR = function(l) {
      try {
        return this.parseCIDR(l), !0;
      } catch {
        return !1;
      }
    }, y.IPv4.isValidFourPartDecimal = function(l) {
      return !!(y.IPv4.isValid(l) && l.match(/^(0|[1-9]\d*)(\.(0|[1-9]\d*)){3}$/));
    }, y.IPv4.isValidCIDRFourPartDecimal = function(l) {
      let u = l.match(/^(.+)\/(\d+)$/);
      return !y.IPv4.isValidCIDR(l) || !u ? !1 : y.IPv4.isValidFourPartDecimal(u[1]);
    }, y.IPv4.networkAddressFromCIDR = function(l) {
      let u, h, f, b, w;
      try {
        for (u = this.parseCIDR(l), f = u[0].toByteArray(), w = this.subnetMaskFromPrefixLength(u[1]).toByteArray(), b = [], h = 0; h < 4; )
          b.push(parseInt(f[h], 10) & parseInt(w[h], 10)), h++;
        return new this(b);
      } catch (R) {
        throw new Error("ipaddr: the address does not have IPv4 CIDR format", { cause: R });
      }
    }, y.IPv4.parse = function(l) {
      let u = this.parser(l);
      if (u === null)
        throw new Error("ipaddr: string is not formatted like an IPv4 Address");
      return new this(u);
    }, y.IPv4.parseCIDR = function(l) {
      let u;
      if (u = l.match(/^(.+)\/(\d+)$/)) {
        let h = parseInt(u[2]);
        if (h >= 0 && h <= 32) {
          let f = [this.parse(u[1]), h];
          return Object.defineProperty(f, "toString", {
            value: function() {
              return this.join("/");
            }
          }), f;
        }
      }
      throw new Error("ipaddr: string is not formatted like an IPv4 CIDR range");
    }, y.IPv4.parser = function(l) {
      let u, h, f;
      if (u = l.match(t.fourOctet))
        return (function() {
          let b = u.slice(1, 6), w = [];
          for (let R = 0; R < b.length; R++)
            h = b[R], w.push(g(h));
          return w;
        })();
      if (u = l.match(t.longValue)) {
        if (f = g(u[1]), f > 4294967295 || f < 0)
          throw new Error("ipaddr: address outside defined range");
        return (function() {
          let b = [], w;
          for (w = 0; w <= 24; w += 8)
            b.push(f >> w & 255);
          return b;
        })().reverse();
      } else return (u = l.match(t.twoOctet)) ? (function() {
        let b = u.slice(1, 4), w = [];
        if (f = g(b[1]), f > 16777215 || f < 0)
          throw new Error("ipaddr: address outside defined range");
        return w.push(g(b[0])), w.push(f >> 16 & 255), w.push(f >> 8 & 255), w.push(f & 255), w;
      })() : (u = l.match(t.threeOctet)) ? (function() {
        let b = u.slice(1, 5), w = [];
        if (f = g(b[2]), f > 65535 || f < 0)
          throw new Error("ipaddr: address outside defined range");
        return w.push(g(b[0])), w.push(g(b[1])), w.push(f >> 8 & 255), w.push(f & 255), w;
      })() : null;
    }, y.IPv4.subnetMaskFromPrefixLength = function(l) {
      if (l = parseInt(l), Number.isNaN(l) || l < 0 || l > 32)
        throw new Error("ipaddr: invalid IPv4 prefix length");
      let u = [0, 0, 0, 0], h = 0, f = Math.floor(l / 8);
      for (; h < f; )
        u[h] = 255, h++;
      return f < 4 && (u[f] = Math.pow(2, l % 8) - 1 << 8 - l % 8), new this(u);
    }, y.IPv6 = (function() {
      function l(u, h) {
        let f, b;
        if (u.length === 16)
          for (this.parts = [], f = 0; f <= 14; f += 2)
            this.parts.push(u[f] << 8 | u[f + 1]);
        else if (u.length === 8)
          this.parts = u;
        else
          throw new Error("ipaddr: ipv6 part count should be 8 or 16");
        for (f = 0; f < this.parts.length; f++)
          if (b = this.parts[f], !(0 <= b && b <= 65535))
            throw new Error("ipaddr: ipv6 part should fit in 16 bits");
        h && (this.zoneId = h);
      }
      return l.prototype.SpecialRanges = {
        // RFC4291, here and after
        unspecified: [new l([0, 0, 0, 0, 0, 0, 0, 0]), 128],
        linkLocal: [new l([65152, 0, 0, 0, 0, 0, 0, 0]), 10],
        multicast: [new l([65280, 0, 0, 0, 0, 0, 0, 0]), 8],
        loopback: [new l([0, 0, 0, 0, 0, 0, 0, 1]), 128],
        uniqueLocal: [new l([64512, 0, 0, 0, 0, 0, 0, 0]), 7],
        ipv4Mapped: [new l([0, 0, 0, 0, 0, 65535, 0, 0]), 96],
        // RFC3879
        deprecatedSiteLocal: [new l([65216, 0, 0, 0, 0, 0, 0, 0]), 10],
        // RFC6666
        discard: [new l([256, 0, 0, 0, 0, 0, 0, 0]), 64],
        // RFC6145
        rfc6145: [new l([0, 0, 0, 0, 65535, 0, 0, 0]), 96],
        rfc6052: [
          // RFC6052
          [new l([100, 65435, 0, 0, 0, 0, 0, 0]), 96],
          // RFC8215
          [new l([100, 65435, 1, 0, 0, 0, 0, 0]), 48]
        ],
        // RFC3056
        "6to4": [new l([8194, 0, 0, 0, 0, 0, 0, 0]), 16],
        // RFC6052, RFC6146
        teredo: [new l([8193, 0, 0, 0, 0, 0, 0, 0]), 32],
        // RFC5180
        benchmarking: [new l([8193, 2, 0, 0, 0, 0, 0, 0]), 48],
        // RFC7450
        amt: [new l([8193, 3, 0, 0, 0, 0, 0, 0]), 32],
        as112v6: [
          // RFC7535
          [new l([8193, 4, 274, 0, 0, 0, 0, 0]), 48],
          // RFC7534
          [new l([9760, 79, 32768, 0, 0, 0, 0, 0]), 48]
        ],
        // RFC4843
        deprecatedOrchid: [new l([8193, 16, 0, 0, 0, 0, 0, 0]), 28],
        // RFC7343
        orchid2: [new l([8193, 32, 0, 0, 0, 0, 0, 0]), 28],
        // RFC9374
        droneRemoteIdProtocolEntityTags: [new l([8193, 48, 0, 0, 0, 0, 0, 0]), 28],
        // RFC9602
        segmentRouting: [new l([24320, 0, 0, 0, 0, 0, 0, 0]), 16],
        reserved: [
          // RFC3849
          [new l([8193, 0, 0, 0, 0, 0, 0, 0]), 23],
          // RFC2928
          [new l([8193, 3512, 0, 0, 0, 0, 0, 0]), 32],
          // RFC9637
          [new l([16383, 0, 0, 0, 0, 0, 0, 0]), 20]
        ]
      }, l.prototype.isIPv4MappedAddress = function() {
        return this.range() === "ipv4Mapped";
      }, l.prototype.kind = function() {
        return "ipv6";
      }, l.prototype.match = function(u, h) {
        let f;
        if (h === void 0 && (f = u, u = f[0], h = f[1]), u.kind() !== "ipv6")
          throw new Error("ipaddr: cannot match ipv6 address with non-ipv6 one");
        return p(this.parts, u.parts, 16, h);
      }, l.prototype.prefixLengthFromSubnetMask = function() {
        let u = 0, h = !1, f = {
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
        }, b, w;
        for (let R = 7; R >= 0; R -= 1)
          if (b = this.parts[R], b in f) {
            if (w = f[b], h && w !== 0)
              return null;
            w !== 16 && (h = !0), u += w;
          } else
            return null;
        return 128 - u;
      }, l.prototype.range = function() {
        return y.subnetMatch(this, this.SpecialRanges);
      }, l.prototype.toByteArray = function() {
        let u, h = [], f = this.parts;
        for (let b = 0; b < f.length; b++)
          u = f[b], h.push(u >> 8), h.push(u & 255);
        return h;
      }, l.prototype.toFixedLengthString = function() {
        let u = (function() {
          let f = [];
          for (let b = 0; b < this.parts.length; b++)
            f.push(m(this.parts[b].toString(16), 4));
          return f;
        }).call(this).join(":"), h = "";
        return this.zoneId && (h = `%${this.zoneId}`), u + h;
      }, l.prototype.toIPv4Address = function() {
        if (!this.isIPv4MappedAddress())
          throw new Error("ipaddr: trying to convert a generic ipv6 address to ipv4");
        let u = this.parts.slice(-2), h = u[0], f = u[1];
        return new y.IPv4([h >> 8, h & 255, f >> 8, f & 255]);
      }, l.prototype.toNormalizedString = function() {
        let u = (function() {
          let f = [];
          for (let b = 0; b < this.parts.length; b++)
            f.push(this.parts[b].toString(16));
          return f;
        }).call(this).join(":"), h = "";
        return this.zoneId && (h = `%${this.zoneId}`), u + h;
      }, l.prototype.toRFC5952String = function() {
        let u = /((^|:)(0(:|$)){2,})/g, h = "";
        this.zoneId && (h = `%${this.zoneId}`);
        let f = this.toNormalizedString(), b = f.slice(0, f.length - h.length), w = 0, R = -1, k = -1, x;
        for (; x = u.exec(b); ) {
          let C = (x[0].match(/0/g) || []).length;
          C > k && (k = C, w = x.index, R = x[0].length);
        }
        return R < 0 ? b + h : `${b.substring(0, w)}::${b.substring(w + R)}${h}`;
      }, l.prototype.toString = function() {
        return this.toRFC5952String();
      }, l;
    })(), y.IPv6.broadcastAddressFromCIDR = function(l) {
      try {
        let u = this.parseCIDR(l), h = u[0].toByteArray(), f = this.subnetMaskFromPrefixLength(u[1]).toByteArray(), b = [], w = 0;
        for (; w < 16; )
          b.push(parseInt(h[w], 10) | parseInt(f[w], 10) ^ 255), w++;
        return new this(b);
      } catch (u) {
        throw new Error("ipaddr: the address does not have IPv6 CIDR format", { cause: u });
      }
    }, y.IPv6.isIPv6 = function(l) {
      return this.parser(l) !== null;
    }, y.IPv6.isValid = function(l) {
      if (typeof l == "string" && l.indexOf(":") === -1)
        return !1;
      try {
        let u = this.parser(l);
        return new this(u.parts, u.zoneId), !0;
      } catch {
        return !1;
      }
    }, y.IPv6.isValidCIDR = function(l) {
      if (typeof l == "string" && l.indexOf(":") === -1)
        return !1;
      try {
        return this.parseCIDR(l), !0;
      } catch {
        return !1;
      }
    }, y.IPv6.networkAddressFromCIDR = function(l) {
      let u, h, f, b, w;
      try {
        for (u = this.parseCIDR(l), f = u[0].toByteArray(), w = this.subnetMaskFromPrefixLength(u[1]).toByteArray(), b = [], h = 0; h < 16; )
          b.push(parseInt(f[h], 10) & parseInt(w[h], 10)), h++;
        return new this(b);
      } catch (R) {
        throw new Error("ipaddr: the address does not have IPv6 CIDR format", { cause: R });
      }
    }, y.IPv6.parse = function(l) {
      let u = this.parser(l);
      if (u === null)
        throw new Error("ipaddr: string is not formatted like an IPv6 Address");
      return new this(u.parts, u.zoneId);
    }, y.IPv6.parseCIDR = function(l) {
      let u, h, f;
      if ((h = l.match(/^(.+)\/(\d+)$/)) && (u = parseInt(h[2]), u >= 0 && u <= 128))
        return f = [this.parse(h[1]), u], Object.defineProperty(f, "toString", {
          value: function() {
            return this.join("/");
          }
        }), f;
      throw new Error("ipaddr: string is not formatted like an IPv6 CIDR range");
    }, y.IPv6.parser = function(l) {
      let u, h, f, b, w, R;
      if (f = l.match(c.deprecatedTransitional))
        return this.parser(`::ffff:${f[1]}`);
      if (c.native.test(l))
        return d(l, 8);
      if ((f = l.match(c.transitional)) && (R = f[6] || "", u = f[1], f[1].endsWith("::") || (u = u.slice(0, -1)), u = d(u + R, 6), u && u.parts)) {
        for (w = [
          parseInt(f[2]),
          parseInt(f[3]),
          parseInt(f[4]),
          parseInt(f[5])
        ], h = 0; h < w.length; h++)
          if (b = w[h], !(0 <= b && b <= 255))
            return null;
        return u.parts.push(w[0] << 8 | w[1]), u.parts.push(w[2] << 8 | w[3]), {
          parts: u.parts,
          zoneId: u.zoneId
        };
      }
      return null;
    }, y.IPv6.subnetMaskFromPrefixLength = function(l) {
      if (l = parseInt(l), Number.isNaN(l) || l < 0 || l > 128)
        throw new Error("ipaddr: invalid IPv6 prefix length");
      let u = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], h = 0, f = Math.floor(l / 8);
      for (; h < f; )
        u[h] = 255, h++;
      return f < 16 && (u[f] = Math.pow(2, l % 8) - 1 << 8 - l % 8), new this(u);
    }, y.fromByteArray = function(l) {
      let u = l.length;
      if (u === 4)
        return new y.IPv4(l);
      if (u === 16)
        return new y.IPv6(l);
      throw new Error("ipaddr: the binary input is neither an IPv6 nor IPv4 address");
    }, y.isValid = function(l) {
      return y.IPv6.isValid(l) || y.IPv4.isValid(l);
    }, y.isValidCIDR = function(l) {
      return y.IPv6.isValidCIDR(l) || y.IPv4.isValidCIDR(l);
    }, y.parse = function(l) {
      if (y.IPv6.isValid(l))
        return y.IPv6.parse(l);
      if (y.IPv4.isValid(l))
        return y.IPv4.parse(l);
      throw new Error("ipaddr: the address has neither IPv6 nor IPv4 format");
    }, y.parseCIDR = function(l) {
      try {
        return y.IPv6.parseCIDR(l);
      } catch {
        try {
          return y.IPv4.parseCIDR(l);
        } catch (u) {
          throw new Error("ipaddr: the address has neither IPv6 nor IPv4 CIDR format", { cause: u });
        }
      }
    }, y.process = function(l) {
      let u = this.parse(l);
      return u.kind() === "ipv6" && u.isIPv4MappedAddress() ? u.toIPv4Address() : u;
    }, y.subnetMatch = function(l, u, h) {
      let f, b, w, R;
      h == null && (h = "unicast");
      for (b in u)
        if (Object.prototype.hasOwnProperty.call(u, b)) {
          for (w = u[b], w[0] && !(w[0] instanceof Array) && (w = [w]), f = 0; f < w.length; f++)
            if (R = w[f], l.kind() === R[0].kind() && l.match.apply(l, R))
              return b;
        }
      return h;
    }, typeof $e < "u" && $e.exports ? $e.exports = y : e.ipaddr = y;
  })(Gr);
});

// openclaw/ui/src/i18n/locales/en-agents.ts
var $r, Vr, Kr, Jr = E(() => {
  $r = {
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
  }, Vr = {
    label: "Agent",
    allAgents: "All agents"
  }, Kr = {
    pinToSwitcher: "Pin to switcher",
    unpinFromSwitcher: "Unpin from switcher"
  };
});

// openclaw/ui/src/i18n/locales/en.ts
var me, En = E(() => {
  Jr();
  me = {
    pluginUi: {
      sessionRecentMessages: "Recent messages",
      sessionHistoryUnavailable: "Session history could not be loaded. Try again.",
      sessionHistoryEmpty: "No recent messages.",
      customize: "Customize UI",
      selectionScope: "Choose views for this browser window. Built-in views are always available.",
      builtin: "Built-in view",
      retryView: "Retry plugin view",
      reload: "Reload plugin UI",
      dashboardTitle: "Session dashboard",
      dashboardEmpty: "This session has no dashboard widgets yet.",
      customPluginsDisabled: "Custom plugin UI is off",
      customPluginsEnableHint: "Enable Custom plugin UI in Labs.",
      openLabs: "Open Labs",
      surface: {
        "session-list": "Session list",
        composer: "Composer",
        workspace: "Workspace",
        transcript: "Transcript",
        "tool-result": "Tool results"
      }
    },
    capacityMeter: {
      workerSlots: "{used} of {total} slots busy",
      unavailable: "Slot utilization unavailable",
      execHost: "Codex exec"
    },
    agentsHome: {},
    outputs: {
      viewAll: "View all",
      dashboard: "Dashboard",
      files: "Files",
      loading: "Loading outputs\u2026",
      updating: "Updating outputs\u2026",
      loadingDashboard: "Loading dashboard\u2026",
      emptyTitle: "No outputs yet",
      emptyDescription: "Files and dashboards from the session appear here."
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
    nativeLinkMenu: {
      label: "Link actions",
      openInline: "Open in Browser Panel",
      openExternal: "Open in Default Browser",
      copy: "Copy Link"
    },
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
      title: "Progress",
      composerTitle: "Task progress",
      stepCount: "Step {current} of {total}",
      hide: "Hide this card",
      noteLabel: "Progress note",
      dismiss: "Dismiss progress card",
      clearSaved: "Clear saved progress for everyone",
      clearFailed: "Could not clear saved progress card.",
      refresh: {
        label: "Refresh task progress",
        retry: "Retry progress refresh",
        pending: "Refreshing task progress\u2026",
        failed: "Could not refresh. Previous update kept.",
        timeout: "No new update yet. The request may still be running.",
        updated: "Task progress updated"
      },
      widgetLabel: "Session progress",
      widgetLoading: "Loading session progress\u2026",
      widgetEmpty: "No progress card yet",
      detailsEmptyTitle: "No saved progress",
      detailsEmptyDescription: "Progress saved by this session appears here.",
      showInChat: "Show in chat",
      widgetUnavailable: "Session progress is unavailable.",
      widgetAccessDenied: "Select a session you can access or change sharing for this session.",
      countLabel: "{completed} of {total} completed",
      activity: {
        updated: "Updated {time}",
        completed: "Completed {time}",
        failed: "Failed {time}",
        stopped: "Stopped {time}"
      },
      outcome: {
        completed: "Completed",
        failed: "Failed",
        stopped: "Stopped"
      },
      stepLabel: "{step}, {status}",
      status: {
        completed: "completed",
        failed: "failed",
        inProgress: "in progress",
        paused: "paused",
        pending: "pending",
        stopped: "stopped"
      },
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
      adminRequired: "Administrator access is required to change update settings or start an update.",
      refreshFailed: "Could not refresh. Check your connection and try again.",
      campaign: {
        countdown: "Updating in {time}",
        waitingForIdle: "Waiting for active work \xB7 forced update in {time}",
        held: "Update held \xB7 resumes in {time}",
        applying: "Applying update\u2026"
      },
      holdOneHour: "Hold 1 h",
      reviewUpdate: "Review update",
      run: {
        restarting: "Gateway restarting\u2026",
        progress: "{completed} of {total} phases complete",
        phase: {
          requested: "Requested",
          staging: "Staging",
          validating: "Validating",
          repairing: "Repairing",
          activating: "Activating",
          restarting: "Restarting",
          verifying: "Verifying",
          finished: "Finished"
        }
      },
      confirm: {
        action: "Update and restart"
      },
      target: {
        version: "v{version}",
        commitBehind: "{count} commit behind",
        commitsBehind: "{count} commits behind",
        viewChanges: "Compare on GitHub"
      },
      sidebar: {
        campaignTarget: "{status} \xB7 {target}",
        checking: "Checking for updates\u2026",
        checkFailed: "Could not check the latest update. Try again.",
        updating: "Updating Gateway\u2026",
        availableTitle: "Update available",
        availableBadge: "Available",
        availableSummary: "A newer revision is ready.",
        blockedTitle: "Update blocked",
        blockedSummary: "The selected revision could not be applied to this checkout.",
        blockedWaiting: "Blocked \xB7 waiting for active work \xB7 {target}",
        waitingForIdle: "Waiting for active work"
      },
      dialog: {
        disconnected: "The Gateway disconnected during the update. This page reconnects on its own. If it stays disconnected, run `openclaw triage` on the Gateway host to open a local coding agent for diagnosis and repair.",
        restarting: "The Gateway is restarting. This page disconnects and reconnects on its own. If it stays disconnected, run `openclaw triage` on the Gateway host to open a local coding agent for diagnosis and repair."
      },
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
    agentChip: $r,
    agentScope: Vr,
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
      deleteSessionStale: 'Gateway connection replaced before "{session}" was deleted. Try again.',
      deleteSessionsStale: "Gateway connection replaced before {count} sessions were deleted. Try again.",
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
      ...Kr,
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
      lanes: {
        lane: "Lane",
        active: "Active",
        queued: "Queued",
        blocked: "Blocked"
      },
      overlay: {
        title: "System busyness",
        eyebrow: "Live diagnostics",
        move: "Move system busyness with arrow keys, or drag",
        minimize: "Minimize system busyness",
        expand: "Expand system busyness",
        lanes: "Lanes",
        status: "Event loop / status",
        activeRuns: "Active runs",
        events: "Events",
        cpu: "CPU",
        memory: "Memory",
        delayP99: "Delay p99"
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
      watcherApprovalScope: "Approval applies to this saved watcher. Source changes or reactivation may require approval again.",
      watcherSandboxSummary: "Runs in your sandbox after you leave this chat, until stopped. Restarts automatically after interruptions.",
      watcherGatewaySummary: "Runs on the Gateway after you leave this chat, until stopped. Restarts automatically after interruptions.",
      watcherSummary: "Runs after you leave this chat, until stopped. Restarts automatically after interruptions.",
      startWatcher: "Start watching",
      saveWatcher: "Save watcher change",
      cancelWatcher: "Cancel",
      scope: {
        standingGrant: 'Always allow runs this exact command for "{automation}" without asking, until revoked (revocable)',
        standingGrantDays: 'Always allow runs this exact command for "{automation}" without asking, for {count} days (revocable)',
        messageSend: "Sends to {count} recipient(s) via {target}",
        payment: "Pays {amount} {currency} to {target}",
        externalPost: "Posts externally to {target}"
      },
      expiresIn: "expires in {time}",
      expired: "expired",
      execApprovalNeeded: "Exec approval needed",
      runCommand: "Run this command?",
      pluginApprovalNeeded: "Plugin approval needed",
      requestedBySession: "Approval requested by session {session}",
      pending: "{count} pending",
      otherPending: "Other pending requests",
      reviewRequest: "Review approval from {agent}: {command}",
      decisionRequest: "{decision}: {command}",
      agentPendingOne: "{count} pending approval",
      agentPending: "{count} pending approvals",
      allowOnce: "Allow once",
      alwaysAllow: "Always allow",
      alwaysAllowHere: "Always allow here",
      allowAlwaysUnavailable: "Allow Always is unavailable for this command.",
      reviewOnly: "Review only. Sign in with approval access to record a decision.",
      deny: "Deny",
      details: "Details",
      labels: {
        host: "Host",
        session: "Session",
        cwd: "CWD",
        directory: "Directory",
        resolved: "Resolved",
        security: "Security",
        ask: "Ask"
      }
    },
    approvalPage: {},
    agentTools: {},
    skillGroups: {
      workspace: "Workspace Skills",
      learned: "Learned Skills",
      builtIn: "Built-in Skills",
      installed: "Installed Skills",
      extra: "Extra Skills",
      other: "Other Skills"
    },
    skillsPage: {},
    skillStatus: {
      bundled: "bundled",
      eligible: "eligible",
      blocked: "blocked",
      disabled: "disabled",
      blockedAllowlist: "blocked by allowlist",
      blockedAgentFilter: "blocked by agent filter"
    },
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
    subtitles: {
      device: "App settings and capabilities on this Mac.",
      devicePermissions: "Manage macOS access, location, and computer presence.",
      agentsHome: "Who is on your team and what they are doing",
      agents: "Workspaces, tools, identities.",
      activity: "Recent sessions across people using this gateway.",
      meetings: "Meeting notes and transcripts across this gateway.",
      apps: "Companion apps for phone, watch, desktop, and browser.",
      portals: "Live previews from agent-run applications.",
      approvals: "Recent exec, plugin, and system-agent approvals.",
      workboard: "Agent work queue and session handoff.",
      worktrees: "Isolated agent task checkouts and recovery snapshots.",
      channels: "Channels and settings.",
      connection: "Gateway endpoint, credentials, and handshake status.",
      sessions: "Active sessions and defaults.",
      systems: "Machines and desktops.",
      usage: "API usage and costs.",
      cron: "Scheduled tasks and recurring agent runs.",
      skills: "Manage your agent skills",
      plugins: "Extend your Claw with tools",
      skillWorkshop: "Skills your agent learned, recent changes, and undo.",
      devices: "Paired devices, pairing approvals, and exec bindings.",
      claws: "Explore and add official Claws.",
      cloudWorkers: "Repository snapshots and machines for cloud sessions.",
      chat: "Gateway chat for quick interventions.",
      dashboards: "Tasks with saved dashboards.",
      custodian: "System setup and care.",
      config: "Legacy settings route; opens Appearance.",
      profile: "Your display name, avatar, and identity on this gateway.",
      communications: "Messages, text-to-speech, and meeting capture settings.",
      appearance: "Theme and UI settings.",
      lobsterdex: "Every lobster palette that has visited this browser.",
      automation: "Commands, hooks, automations, and plugins.",
      mcp: "MCP servers, auth, tools, and diagnostics.",
      memory: "Memory engine, search, and dreaming.",
      search: "Choose how agents search the web and check provider health.",
      talk: "Realtime voice: provider, model, and speaker voice.",
      infrastructure: "Gateway, browser, node host, discovery, and ACP settings.",
      labs: "Experimental agent and tool capabilities.",
      updates: "Release channel, automatic updates, and current update status.",
      about: "Control UI and connected Gateway build identity.",
      aiAgents: "Global agent defaults: skills, tools, and session.",
      modelSetup: "Connect a verified AI model",
      modelProviders: "Default models, behavior, provider access, usage, and cost.",
      memoryImport: "Bring Codex and Claude Code memory into an agent workspace.",
      notifications: "Browser push notifications from your gateway.",
      security: "Gateway auth, exec policy, tool profile, and approvals.",
      advanced: "Every remaining config section, plus the raw file editor.",
      debug: "Snapshots, events, RPC.",
      logs: "Live gateway logs.",
      plugin: "Plugin-provided panel."
    },
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
        title: "Bring your assistant memory with you",
        body: "OpenClaw found memory from other coding assistants. Import it into your agent workspace?",
        plannedCount: "{count} ready to import",
        alreadyImported: "Already imported: {count}",
        sourceUnavailable: "Source path unavailable",
        import: "Import",
        skip: "Skip",
        reviewDetails: "Review details",
        importingProvider: "Importing\u2026",
        providerResult: "Migrated {migrated}, skipped {skipped}",
        providerIncomplete: "Migrated {migrated}, skipped {skipped}, {errors} failed, {conflicts} conflicts",
        providerError: "Import failed: {error}",
        connectionChanged: "Skipped: the Gateway connection changed during the import",
        unknownError: "Request failed",
        doneTitle: "Memory import finished",
        doneBody: "Migrated {migrated}, skipped {skipped}. You can continue setting up OpenClaw."
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
      context: "Working on: {context}",
      contextOff: "Work context off",
      removeContext: "Remove work context",
      includeContext: "Include work context",
      selection: "Selected text",
      attachSelection: "Attach selected text",
      removeSelection: "Remove selected text"
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
        groupTitle: "Parallel tasks",
        defaultPhase: "Unphased",
        progress: "{complete} of {total}",
        active: "{running} running \xB7 {queued} queued \xB7 {failed} failed or stopped",
        finished: "{done} completed \xB7 {failed} failed or stopped",
        completed: "{done} completed",
        failedOrStopped: "Failed or stopped",
        childOutcome: "Child runs finished. Check the conversation for the final response.",
        childOutcomeProcessing: "Child runs finished. The parent is processing their results.",
        details: "Child details",
        detailsUnavailable: "Child details are unavailable. Counts include all accepted workers.",
        otherGroups: "{count} more active groups"
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
      label: "Session dashboard",
      tabsLabel: "Dashboard tabs",
      moreTabs: "More dashboard tabs",
      gridLabel: "Dashboard widgets",
      emptyTitle: "A clear board, ready for work",
      emptyHint: "Your agent can pin widgets here \u2014 try asking for a status card.",
      actionFailed: "The dashboard change could not be saved.",
      actionInProgress: "Another dashboard change is still being saved.",
      announcement: {
        moved: "Moved {title}.",
        resized: "Resized {title}.",
        removed: "Removed {title}.",
        granted: "Widget access allowed.",
        rejected: "Widget access rejected."
      },
      widget: {
        cellLabel: "Dashboard widget: {title}. Use arrow keys to navigate. Hold Alt and press an arrow key to move it.",
        moveHandle: "Move {title}",
        resizeHandle: "Resize {title}",
        menuLabel: "Widget options",
        moveToTab: "Move to tab",
        noOtherTabs: "No other tabs",
        resize: "Resize",
        autoHeight: "Auto height",
        remove: "Delete",
        kindMcp: "MCP",
        kindHtml: "HTML",
        kindPlugin: "Plugin",
        kindReport: "Report",
        kindWebsite: "Website",
        kindBrowserDashboard: "Browser dashboard",
        pluginLoading: "Loading plugin widget\u2026",
        disabledPlugin: "Widget from disabled plugin {pluginId}"
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
      clawhub: {
        retryStatus: "Status unavailable \xB7 Retry",
        viewDetails: "View details"
      },
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
      turnElapsed: "Total time since your message, including subagent waits",
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
        unknownCommand: "Unknown command: `{command}`",
        options: "Options: {options}.",
        sessionUnavailable: "Session capability is unavailable",
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
      sendShortcut: "Send shortcut",
      sendShortcutHint: "Desktop only. On mobile, Enter adds a new line; use the Send button to send.",
      sendShortcutEnter: "Enter",
      sendShortcutModifierEnter: "\u2318/Ctrl+Enter",
      followUpMode: "Follow-ups while the agent is working",
      followUpModeQueue: "Queue until the run ends",
      followUpModeServer: "Server default ({mode})",
      followUpModeLoading: "loading\u2026",
      followUpModeSteer: "Steer into the active run",
      followUpModeOverriding: "Overriding server default ({mode})",
      followUpModeReset: "Reset to server default",
      catalogOpenTarget: "Open external sessions in",
      catalogOpenTargetViewer: "OpenClaw viewer",
      catalogOpenTargetTerminal: "Terminal",
      catalogOutputTruncated: "[Output truncated]",
      onboardingDisabled: "Disabled during setup",
      commandPaletteTitle: "Search or jump to\u2026 (\u2318K)",
      openCommandPalette: "Command palette",
      updating: "Updating\u2026",
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
        updateMacAndGateway: "Update Mac app + Gateway",
        updateGateway: "Update Gateway",
        serverUpdatedTitle: "Server updated",
        serverUpdatedRefresh: "Refresh for full capabilities",
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
        hiddenSessionSections: "Hidden session sections",
        showSessionSection: "Show",
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
    languages: {
      en: "English",
      zhCN: "\u7B80\u4F53\u4E2D\u6587 (Simplified Chinese)",
      zhTW: "\u7E41\u9AD4\u4E2D\u6587 (Traditional Chinese)",
      ptBR: "Portugu\xEAs (Brazilian Portuguese)",
      de: "Deutsch (German)",
      es: "Espa\xF1ol (Spanish)",
      jaJP: "\u65E5\u672C\u8A9E (Japanese)",
      ko: "\uD55C\uAD6D\uC5B4 (Korean)",
      fr: "Fran\xE7ais (French)",
      hi: "\u0939\u093F\u0928\u094D\u0926\u0940 (Hindi)",
      ar: "\u0627\u0644\u0639\u0631\u0628\u064A\u0629 (Arabic)",
      it: "Italiano (Italian)",
      tr: "T\xFCrk\xE7e (Turkish)",
      uk: "\u0423\u043A\u0440\u0430\u0457\u043D\u0441\u044C\u043A\u0430 (Ukrainian)",
      id: "Bahasa Indonesia (Indonesian)",
      pl: "Polski (Polish)",
      th: "\u0E44\u0E17\u0E22 (Thai)",
      vi: "Ti\u1EBFng Vi\u1EC7t (Vietnamese)",
      nl: "Nederlands (Dutch)",
      fa: "\u0641\u0627\u0631\u0633\u06CC (Persian)",
      ru: "\u0420\u0443\u0441\u0441\u043A\u0438\u0439 (Russian)",
      sv: "Svenska (Swedish)"
    },
    // Navigation and in-chat secret requests render before the Secrets page loads.
    secretsStore: {
      allowedHosts: "Allowed hosts",
      allowedHostsPlaceholder: "api.example.com",
      protectedSecret: "Protected secret",
      agentReadable: "Agent-readable environment",
      hint: "Choose protected, write-only secrets or intentionally agent-readable Gateway environment values."
    },
    cron: {
      adminRequired: "Browsing only. Automation changes require operator.admin access.",
      tabs: {},
      list: {},
      suggestions: {},
      stats: {},
      detail: {},
      actions: {},
      // Shared cron actions report outcomes before the automation page loads.
      runNotStarted: {
        notDue: "This automation is not due yet.",
        alreadyRunning: "This automation is already running.",
        recoveryPending: "Scheduler recovery is still in progress.",
        invalidSpec: "This automation has an invalid schedule or payload.",
        stopped: "The scheduler is stopped.",
        unknown: "This automation could not be started."
      },
      jobs: {},
      runs: {},
      form: {},
      jobState: {},
      runEntry: {},
      errors: {
        nameRequired: "Name is required.",
        activeHoursTime: "Enter HH:MM (24:00 is allowed only for the end).",
        activeHoursTimezone: "Enter a valid IANA timezone, local, or user.",
        scheduleAtInvalid: "Enter a valid date/time.",
        everyAmountInvalid: "Interval must be greater than 0.",
        triggerIntervalTooShort: "Condition-triggered automations must run at least every 30 seconds.",
        cronExprRequired: "Cron expression is required.",
        staggerAmountInvalid: "Stagger must be greater than 0.",
        triggerScriptRequired: "Trigger script is required when the condition trigger is enabled.",
        triggerScriptPayloadUnsupported: "Script payloads cannot use condition triggers because both own the same saved state.",
        triggerScheduleUnsupported: "Condition triggers require an interval, cron, or stream schedule.",
        systemTextRequired: "System text is required.",
        agentMessageRequired: "Agent message is required.",
        timeoutInvalid: "If set, timeout must be 0 or greater (0 disables this timeout).",
        deliveryModeRequired: "Choose a delivery mode explicitly, or run openclaw doctor --fix to repair legacy settings.",
        webhookUrlRequired: "Webhook URL is required.",
        webhookUrlInvalid: "Webhook URL must be a valid http(s):// URL without embedded credentials.",
        invalidRunTime: "Invalid run time.",
        invalidIntervalAmount: "Invalid interval amount.",
        cronExprRequiredShort: "Cron expression required.",
        invalidStaggerAmount: "Invalid stagger amount.",
        systemEventTextRequired: "System event text required.",
        agentMessageRequiredShort: "Agent message required.",
        nameRequiredShort: "Name required."
      }
    },
    linkReader: {
      loadingPreview: "Loading preview\u2026",
      title: "Link reader",
      urlPlaceholder: "Supported link URL"
    }
  };
});

// octogee/app/openclaw-islands/i18n.ts
var Yr = E(() => {
  En();
});

// openclaw/ui/src/lib/chat/browser-tab-preview.ts
N();
Xe();

// openclaw/ui/src/lib/chat/tool-cards.ts
lt();

// openclaw/packages/net-policy/src/url-protocol.ts
function ni(e) {
  return e instanceof URL ? e : URL.parse(e);
}
function ut(e) {
  let n = ni(e);
  return n?.protocol === "http:" || n?.protocol === "https:";
}

// openclaw/ui/src/lib/chat/tool-cards.ts
Y();
N();
W();
ke();

// openclaw/src/agents/tool-display-call.ts
N();

// openclaw/src/chat/canvas-render.ts
Y();
se();
N();
W();

// openclaw/src/shared/text/code-regions.ts
Y();

// openclaw/packages/markdown-core/src/reasoning-tag-parser.ts
Y();
var Ct = [
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
], Mu = new Set(Ct);

// openclaw/src/chat/canvas-render.ts
function ii(e) {
  let n = P(e?.viewId);
  if (!n || n.length > 128)
    return;
  let t = P(e?.serverName), o = P(e?.toolName), r = P(e?.uiResourceUri), i = P(e?.toolCallId), a = P(e?.originSessionKey), c = e?.resultMetaState === "unavailable" ? "unavailable" : void 0;
  return !!(t && t.length <= 256 && o && o.length <= 256 && r?.startsWith("ui://") && r.length <= 2048 && i && i.length <= 512) ? {
    viewId: n,
    serverName: t,
    toolName: o,
    uiResourceUri: r,
    toolCallId: i,
    ...a && a.length <= 512 ? { originSessionKey: a } : {},
    ...c ? { resultMetaState: c } : {}
  } : { viewId: n };
}
function si(e) {
  return typeof e == "number" && Number.isFinite(e) && e >= 160 ? Math.min(Math.trunc(e), 1200) : void 0;
}
function Et(e) {
  return typeof e == "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/u.test(e);
}
function _t(e) {
  let n = L(e);
  if (!n || P(n?.kind)?.trim().toLowerCase() !== "canvas")
    return;
  let o = L(n.presentation), r = L(n.view), i = L(n.source), a = ii(L(n.mcpApp)), c = a?.viewId, p = P(o?.target) ?? P(n?.target) ?? "assistant_message";
  if (p !== "assistant_message" && p !== "node_panel")
    return;
  let g = P(o?.title) ?? P(r?.title), m = si(
    ie(o?.preferred_height) ?? ie(o?.preferredHeight) ?? ie(r?.preferred_height) ?? ie(r?.preferredHeight)
  ), y = P(o?.class_name) ?? P(o?.className), l = P(o?.style), u = P(o?.sandbox), h = P(r?.url) ?? P(r?.entryUrl), f = P(r?.id) ?? P(r?.docId), b = P(r?.boardWidgetName), w = Et(b) ? b : void 0, R = {
    kind: "canvas",
    surface: p,
    render: "url",
    ...g ? { title: g } : {},
    ...m ? { preferredHeight: m } : {},
    ...u === "strict" || u === "scripts" ? { sandbox: u } : {},
    ...a ? { mcpApp: a } : {}
  };
  if (c && f === c)
    return { ...R, viewId: f };
  let k = h ?? (P(i?.type)?.trim().toLowerCase() === "url" ? P(i?.url) : void 0);
  if (k)
    return {
      ...R,
      url: k,
      ...h && f ? { viewId: f } : {},
      ...y ? { className: y } : {},
      ...l ? { style: l } : {},
      ...h && w ? { boardWidgetName: w } : {}
    };
}
function At(e) {
  let n = L(e);
  return _t(n?.mcpAppPreview);
}
function It(e) {
  let n = e ? ce(e) : void 0;
  return _t(n);
}

// openclaw/src/chat/tool-content.ts
on();
W();
var ai = [
  "id",
  "tool_call_id",
  "toolCallId",
  "tool_use_id",
  "toolUseId"
];
function vt(e) {
  return typeof e == "string" ? e.toLowerCase() : "";
}
function sn(e) {
  let n = vt(e);
  return n === "toolcall" || n === "tool_call" || n === "tooluse" || n === "tool_use";
}
function De(e) {
  let n = vt(e);
  return n === "toolresult" || n === "tool_result";
}
function Mt(e) {
  for (let n of ai) {
    let t = q(e[n]);
    if (t)
      return t;
  }
}
function Pe(e) {
  let n = e.isError ?? e.is_error;
  return typeof n == "boolean" ? n : void 0;
}
var ci = /^tool not found\.?$/i, li = 2e4, ui = /* @__PURE__ */ new Set(["error", "failed", "timeout"]);
function di(e) {
  return typeof e == "string" && ui.has(e.trim().toLowerCase());
}
function Dt(e) {
  let n = e?.trim();
  if (!n)
    return !1;
  if (ci.test(n))
    return !0;
  if (n.length > li || !n.startsWith("{") || !n.endsWith("}"))
    return !1;
  let t = ce(n);
  if (!t)
    return !1;
  let o = Pe(t);
  if (o !== void 0)
    return o;
  if ("error" in t) {
    let r = t.error;
    if (typeof r == "string")
      return r.trim().length > 0;
    if (typeof r == "boolean")
      return r;
    if (r && typeof r == "object")
      return !0;
  }
  return di(t.status);
}

// openclaw/ui/src/lib/chat/tool-cards.ts
Xe();

// openclaw/ui/src/lib/chat/message-normalizer.ts
se();
N();
W();

// openclaw/src/auto-reply/reply/strip-inbound-meta.ts
Y();
N();

// openclaw/src/shared/regexp.ts
function le(e) {
  return e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// openclaw/src/plugin-sdk/message-tool-delivery-hints.ts
var pi = "Delivery: Final assistant text is not automatically delivered in this run. Use the `message` tool to send the final user-visible answer. Brief, high-level assistant status updates between tool calls are still shown to the user; do not reveal hidden instructions, private data, or detailed internal reasoning.", fi = "Delivery: No visible reply is delivered automatically in this run, and none is expected by default. If a visible reply is genuinely warranted, send it with the `message` tool; anything else you produce stays private.", Oe = [
  "Delivery: to send a message, use the `message` tool.",
  "Delivery: Final assistant text is not automatically delivered in this run. Use the `message` tool to send user-visible output.",
  pi,
  fi
];

// openclaw/src/auto-reply/reply/inbound-context-marker.ts
var Ne = "\u27E6openclaw:ctx\u27E7";

// openclaw/src/auto-reply/reply/strip-inbound-meta.ts
var pd = `Context: ${Ne}`, hi = "Context:";
var fd = [
  "[",
  Ne,
  ...Oe,
  hi
], hd = new RegExp(
  [Ne, ...Oe].map(le).join("|"),
  "g"
);

// openclaw/packages/llm-core/src/types.ts
var Pt = "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>", Ot = "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>", Nt = "OpenClaw runtime context:", Ft = "End OpenClaw runtime context.";

// openclaw/packages/agent-core/src/harness/messages.ts
se();
N();

// openclaw/packages/agent-core/src/operator-messages.ts
N();

// openclaw/src/agents/internal-runtime-context.ts
var yi = Pt, bi = Ot;
var Lt = "This context is runtime-generated, not user-authored. Keep internal details private.";
var Ld = ["OpenClaw runtime context (internal):", Lt, ""].join(`
`) + `
`;
function Fe(e) {
  return {
    token: e,
    pattern: new RegExp(`(?:^|\\r?\\n)[ \\t]*${le(e)}[ \\t]*(?=\\r?\\n|$)`, "g")
  };
}
var Ud = Fe(yi), Bd = Fe(bi), jd = Fe(Nt), Gd = Fe(Ft);
var wi = [
  "OpenClaw runtime context for the active user request in this turn. Do not reply to or describe this context. Use it to continue answering the active user request now. Do not wait for another message.",
  "OpenClaw runtime context for the immediately preceding user message.",
  "OpenClaw runtime event."
], ki = new RegExp(
  wi.flatMap((e) => {
    let n = e.split(". ");
    return n.map((t, o) => n.slice(o).join(". "));
  }).map((e) => e.split(/\s+/).map(le).join("\\s+")).join("|")
), Ri = new RegExp(
  Lt.split(/\s+/).map(le).join("\\s+")
), qd = new RegExp(
  `^[ \\t]*(?:${ki.source})\\s+${Ri.source}[ \\t]*(?:\\r?\\n|$)`,
  "gm"
);

// openclaw/src/chat/message-client-source.ts
N();
W();
ke();

// openclaw/src/chat/work-context.ts
N();
ke();

// openclaw/packages/markdown-core/src/image-spans.ts
Y();

// openclaw/node_modules/.pnpm/mdurl@2.1.0/node_modules/mdurl/index.mjs
var an = {};
On(an, {
  decode: () => Re,
  encode: () => ee,
  format: () => he,
  parse: () => xe
});

// openclaw/node_modules/.pnpm/mdurl@2.1.0/node_modules/mdurl/lib/decode.mjs
var Ut = {};
function Ci(e) {
  let n = Ut[e];
  if (n)
    return n;
  n = Ut[e] = [];
  for (let t = 0; t < 128; t++) {
    let o = String.fromCharCode(t);
    n.push(o);
  }
  for (let t = 0; t < e.length; t++) {
    let o = e.charCodeAt(t);
    n[o] = "%" + ("0" + o.toString(16).toUpperCase()).slice(-2);
  }
  return n;
}
function Le(e, n) {
  typeof n != "string" && (n = Le.defaultChars);
  let t = Ci(n);
  return e.replace(/(%[a-f0-9]{2})+/gi, function(o) {
    let r = "";
    for (let i = 0, a = o.length; i < a; i += 3) {
      let c = parseInt(o.slice(i + 1, i + 3), 16);
      if (c < 128) {
        r += t[c];
        continue;
      }
      if ((c & 224) === 192 && i + 3 < a) {
        let d = parseInt(o.slice(i + 4, i + 6), 16);
        if ((d & 192) === 128) {
          let p = c << 6 & 1984 | d & 63;
          p < 128 ? r += "\uFFFD\uFFFD" : r += String.fromCharCode(p), i += 3;
          continue;
        }
      }
      if ((c & 240) === 224 && i + 6 < a) {
        let d = parseInt(o.slice(i + 4, i + 6), 16), p = parseInt(o.slice(i + 7, i + 9), 16);
        if ((d & 192) === 128 && (p & 192) === 128) {
          let g = c << 12 & 61440 | d << 6 & 4032 | p & 63;
          g < 2048 || g >= 55296 && g <= 57343 ? r += "\uFFFD\uFFFD\uFFFD" : r += String.fromCharCode(g), i += 6;
          continue;
        }
      }
      if ((c & 248) === 240 && i + 9 < a) {
        let d = parseInt(o.slice(i + 4, i + 6), 16), p = parseInt(o.slice(i + 7, i + 9), 16), g = parseInt(o.slice(i + 10, i + 12), 16);
        if ((d & 192) === 128 && (p & 192) === 128 && (g & 192) === 128) {
          let m = c << 18 & 1835008 | d << 12 & 258048 | p << 6 & 4032 | g & 63;
          m < 65536 || m > 1114111 ? r += "\uFFFD\uFFFD\uFFFD\uFFFD" : (m -= 65536, r += String.fromCharCode(55296 + (m >> 10), 56320 + (m & 1023))), i += 9;
          continue;
        }
      }
      r += "\uFFFD";
    }
    return r;
  });
}
Le.defaultChars = ";/?:@&=+$,#";
Le.componentChars = "";
var Re = Le;

// openclaw/node_modules/.pnpm/mdurl@2.1.0/node_modules/mdurl/lib/encode.mjs
var Bt = {};
function Ti(e) {
  let n = Bt[e];
  if (n)
    return n;
  n = Bt[e] = [];
  for (let t = 0; t < 128; t++) {
    let o = String.fromCharCode(t);
    /^[0-9a-z]$/i.test(o) ? n.push(o) : n.push("%" + ("0" + t.toString(16).toUpperCase()).slice(-2));
  }
  for (let t = 0; t < e.length; t++)
    n[e.charCodeAt(t)] = e[t];
  return n;
}
function Ue(e, n, t) {
  typeof n != "string" && (t = n, n = Ue.defaultChars), typeof t > "u" && (t = !0);
  let o = Ti(n), r = "";
  for (let i = 0, a = e.length; i < a; i++) {
    let c = e.charCodeAt(i);
    if (t && c === 37 && i + 2 < a && /^[0-9a-f]{2}$/i.test(e.slice(i + 1, i + 3))) {
      r += e.slice(i, i + 3), i += 2;
      continue;
    }
    if (c < 128) {
      r += o[c];
      continue;
    }
    if (c >= 55296 && c <= 57343) {
      if (c >= 55296 && c <= 56319 && i + 1 < a) {
        let d = e.charCodeAt(i + 1);
        if (d >= 56320 && d <= 57343) {
          r += encodeURIComponent(e[i] + e[i + 1]), i++;
          continue;
        }
      }
      r += "%EF%BF%BD";
      continue;
    }
    r += encodeURIComponent(e[i]);
  }
  return r;
}
Ue.defaultChars = ";/?:@&=+$,-_.!~*'()#";
Ue.componentChars = "-_.!~*'()";
var ee = Ue;

// openclaw/node_modules/.pnpm/mdurl@2.1.0/node_modules/mdurl/lib/format.mjs
function he(e) {
  let n = "";
  return n += e.protocol || "", n += e.slashes ? "//" : "", n += e.auth ? e.auth + "@" : "", e.hostname && e.hostname.indexOf(":") !== -1 ? n += "[" + e.hostname + "]" : n += e.hostname || "", n += e.port ? ":" + e.port : "", n += e.pathname || "", n += e.search || "", n += e.hash || "", n;
}

// openclaw/node_modules/.pnpm/mdurl@2.1.0/node_modules/mdurl/lib/parse.mjs
function Be() {
  this.protocol = null, this.slashes = null, this.auth = null, this.port = null, this.hostname = null, this.hash = null, this.search = null, this.pathname = null;
}
var Si = /^([a-z0-9.+-]+:)/i, Ei = /:[0-9]*$/, _i = /^(\/\/?(?!\/)[^\?\s]*)(\?[^\s]*)?$/, Ai = ["<", ">", '"', "`", " ", "\r", `
`, "	"], Ii = ["{", "}", "|", "\\", "^", "`"].concat(Ai), vi = ["'"].concat(Ii), jt = ["%", "/", "?", ";", "#"].concat(vi), Gt = ["/", "?", "#"], Mi = 255, qt = /^[+a-z0-9A-Z_-]{0,63}$/, Di = /^([+a-z0-9A-Z_-]{0,63})(.*)$/, Wt = {
  javascript: !0,
  "javascript:": !0
}, zt = {
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
function Pi(e, n) {
  if (e && e instanceof Be) return e;
  let t = new Be();
  return t.parse(e, n), t;
}
Be.prototype.parse = function(e, n) {
  let t, o, r, i = e;
  if (i = i.trim(), !n && e.split("#").length === 1) {
    let p = _i.exec(i);
    if (p)
      return this.pathname = p[1], p[2] && (this.search = p[2]), this;
  }
  let a = Si.exec(i);
  if (a && (a = a[0], t = a.toLowerCase(), this.protocol = a, i = i.substr(a.length)), (n || a || i.match(/^\/\/[^@\/]+@[^@\/]+/)) && (r = i.substr(0, 2) === "//", r && !(a && Wt[a]) && (i = i.substr(2), this.slashes = !0)), !Wt[a] && (r || a && !zt[a])) {
    let p = -1;
    for (let u = 0; u < Gt.length; u++)
      o = i.indexOf(Gt[u]), o !== -1 && (p === -1 || o < p) && (p = o);
    let g, m;
    p === -1 ? m = i.lastIndexOf("@") : m = i.lastIndexOf("@", p), m !== -1 && (g = i.slice(0, m), i = i.slice(m + 1), this.auth = g), p = -1;
    for (let u = 0; u < jt.length; u++)
      o = i.indexOf(jt[u]), o !== -1 && (p === -1 || o < p) && (p = o);
    p === -1 && (p = i.length), i[p - 1] === ":" && p--;
    let y = i.slice(0, p);
    i = i.slice(p), this.parseHost(y), this.hostname = this.hostname || "";
    let l = this.hostname[0] === "[" && this.hostname[this.hostname.length - 1] === "]";
    if (!l) {
      let u = this.hostname.split(/\./);
      for (let h = 0, f = u.length; h < f; h++) {
        let b = u[h];
        if (b && !b.match(qt)) {
          let w = "";
          for (let R = 0, k = b.length; R < k; R++)
            b.charCodeAt(R) > 127 ? w += "x" : w += b[R];
          if (!w.match(qt)) {
            let R = u.slice(0, h), k = u.slice(h + 1), x = b.match(Di);
            x && (R.push(x[1]), k.unshift(x[2])), k.length && (i = k.join(".") + i), this.hostname = R.join(".");
            break;
          }
        }
      }
    }
    this.hostname.length > Mi && (this.hostname = ""), l && (this.hostname = this.hostname.substr(1, this.hostname.length - 2));
  }
  let c = i.indexOf("#");
  c !== -1 && (this.hash = i.substr(c), i = i.slice(0, c));
  let d = i.indexOf("?");
  return d !== -1 && (this.search = i.substr(d), i = i.slice(0, d)), i && (this.pathname = i), zt[t] && this.hostname && !this.pathname && (this.pathname = ""), this;
};
Be.prototype.parseHost = function(e) {
  let n = Ei.exec(e);
  n && (n = n[0], n !== ":" && (this.port = n.substr(1)), e = e.substr(0, e.length - n.length)), e && (this.hostname = e);
};
var xe = Pi;

// openclaw/node_modules/.pnpm/uc.micro@3.0.0/node_modules/uc.micro/build/index.mjs
var pn = {};
On(pn, {
  Any: () => cn,
  Cc: () => ln,
  Cf: () => Oi,
  P: () => Ce,
  S: () => un,
  Z: () => dn
});
var cn = /[\0-\uD7FF\uE000-\uFFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/, ln = /[\0-\x1F\x7F-\x9F]/, Oi = /[\xAD\u0600-\u0605\u061C\u06DD\u070F\u0890\u0891\u08E2\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFFF9-\uFFFB]|\uD804[\uDCBD\uDCCD]|\uD80D[\uDC30-\uDC3F]|\uD82F[\uDCA0-\uDCA3]|\uD834[\uDD73-\uDD7A]|\uDB40[\uDC01\uDC20-\uDC7F]/, Ce = /[!-#%-\*,-\/:;\?@\[-\]_\{\}\xA1\xA7\xAB\xB6\xB7\xBB\xBF\u037E\u0387\u055A-\u055F\u0589\u058A\u05BE\u05C0\u05C3\u05C6\u05F3\u05F4\u0609\u060A\u060C\u060D\u061B\u061D-\u061F\u066A-\u066D\u06D4\u0700-\u070D\u07F7-\u07F9\u0830-\u083E\u085E\u0964\u0965\u0970\u09FD\u0A76\u0AF0\u0C77\u0C84\u0DF4\u0E4F\u0E5A\u0E5B\u0F04-\u0F12\u0F14\u0F3A-\u0F3D\u0F85\u0FD0-\u0FD4\u0FD9\u0FDA\u104A-\u104F\u10FB\u1360-\u1368\u1400\u166E\u169B\u169C\u16EB-\u16ED\u1735\u1736\u17D4-\u17D6\u17D8-\u17DA\u1800-\u180A\u1944\u1945\u1A1E\u1A1F\u1AA0-\u1AA6\u1AA8-\u1AAD\u1B4E\u1B4F\u1B5A-\u1B60\u1B7D-\u1B7F\u1BFC-\u1BFF\u1C3B-\u1C3F\u1C7E\u1C7F\u1CC0-\u1CC7\u1CD3\u2010-\u2027\u2030-\u2043\u2045-\u2051\u2053-\u205E\u207D\u207E\u208D\u208E\u2308-\u230B\u2329\u232A\u2768-\u2775\u27C5\u27C6\u27E6-\u27EF\u2983-\u2998\u29D8-\u29DB\u29FC\u29FD\u2CF9-\u2CFC\u2CFE\u2CFF\u2D70\u2E00-\u2E2E\u2E30-\u2E4F\u2E52-\u2E5D\u3001-\u3003\u3008-\u3011\u3014-\u301F\u3030\u303D\u30A0\u30FB\uA4FE\uA4FF\uA60D-\uA60F\uA673\uA67E\uA6F2-\uA6F7\uA874-\uA877\uA8CE\uA8CF\uA8F8-\uA8FA\uA8FC\uA92E\uA92F\uA95F\uA9C1-\uA9CD\uA9DE\uA9DF\uAA5C-\uAA5F\uAADE\uAADF\uAAF0\uAAF1\uABEB\uFD3E\uFD3F\uFE10-\uFE19\uFE30-\uFE52\uFE54-\uFE61\uFE63\uFE68\uFE6A\uFE6B\uFF01-\uFF03\uFF05-\uFF0A\uFF0C-\uFF0F\uFF1A\uFF1B\uFF1F\uFF20\uFF3B-\uFF3D\uFF3F\uFF5B\uFF5D\uFF5F-\uFF65]|\uD800[\uDD00-\uDD02\uDF9F\uDFD0]|\uD801\uDD6F|\uD802[\uDC57\uDD1F\uDD3F\uDE50-\uDE58\uDE7F\uDEF0-\uDEF6\uDF39-\uDF3F\uDF99-\uDF9C]|\uD803[\uDD6E\uDEAD\uDED0\uDF55-\uDF59\uDF86-\uDF89]|\uD804[\uDC47-\uDC4D\uDCBB\uDCBC\uDCBE-\uDCC1\uDD40-\uDD43\uDD74\uDD75\uDDC5-\uDDC8\uDDCD\uDDDB\uDDDD-\uDDDF\uDE38-\uDE3D\uDEA9\uDFD4\uDFD5\uDFD7\uDFD8]|\uD805[\uDC4B-\uDC4F\uDC5A\uDC5B\uDC5D\uDCC6\uDDC1-\uDDD7\uDE41-\uDE43\uDE60-\uDE6C\uDEB9\uDF3C-\uDF3E]|\uD806[\uDC3B\uDD44-\uDD46\uDDE2\uDE3F-\uDE46\uDE9A-\uDE9C\uDE9E-\uDEA2\uDF00-\uDF09\uDFE1]|\uD807[\uDC41-\uDC45\uDC70\uDC71\uDEF7\uDEF8\uDF43-\uDF4F\uDFFF]|\uD809[\uDC70-\uDC74]|\uD80B[\uDFF1\uDFF2]|\uD81A[\uDE6E\uDE6F\uDEF5\uDF37-\uDF3B\uDF44]|\uD81B[\uDD6D-\uDD6F\uDE97-\uDE9A\uDFE2]|\uD82F\uDC9F|\uD836[\uDE87-\uDE8B]|\uD839\uDDFF|\uD83A[\uDD5E\uDD5F]/, un = /[\$\+<->\^`\|~\xA2-\xA6\xA8\xA9\xAC\xAE-\xB1\xB4\xB8\xD7\xF7\u02C2-\u02C5\u02D2-\u02DF\u02E5-\u02EB\u02ED\u02EF-\u02FF\u0375\u0384\u0385\u03F6\u0482\u058D-\u058F\u0606-\u0608\u060B\u060E\u060F\u06DE\u06E9\u06FD\u06FE\u07F6\u07FE\u07FF\u0888\u09F2\u09F3\u09FA\u09FB\u0AF1\u0B70\u0BF3-\u0BFA\u0C7F\u0D4F\u0D79\u0E3F\u0F01-\u0F03\u0F13\u0F15-\u0F17\u0F1A-\u0F1F\u0F34\u0F36\u0F38\u0FBE-\u0FC5\u0FC7-\u0FCC\u0FCE\u0FCF\u0FD5-\u0FD8\u109E\u109F\u1390-\u1399\u166D\u17DB\u1940\u19DE-\u19FF\u1B61-\u1B6A\u1B74-\u1B7C\u1FBD\u1FBF-\u1FC1\u1FCD-\u1FCF\u1FDD-\u1FDF\u1FED-\u1FEF\u1FFD\u1FFE\u2044\u2052\u207A-\u207C\u208A-\u208C\u20A0-\u20C1\u2100\u2101\u2103-\u2106\u2108\u2109\u2114\u2116-\u2118\u211E-\u2123\u2125\u2127\u2129\u212E\u213A\u213B\u2140-\u2144\u214A-\u214D\u214F\u218A\u218B\u2190-\u2307\u230C-\u2328\u232B-\u2429\u2440-\u244A\u249C-\u24E9\u2500-\u2767\u2794-\u27C4\u27C7-\u27E5\u27F0-\u2982\u2999-\u29D7\u29DC-\u29FB\u29FE-\u2B73\u2B76-\u2BFF\u2CE5-\u2CEA\u2E50\u2E51\u2E80-\u2E99\u2E9B-\u2EF3\u2F00-\u2FD5\u2FF0-\u2FFF\u3004\u3012\u3013\u3020\u3036\u3037\u303E\u303F\u309B\u309C\u3190\u3191\u3196-\u319F\u31C0-\u31E5\u31EF\u3200-\u321E\u322A-\u3247\u3250\u3260-\u327F\u328A-\u32B0\u32C0-\u33FF\u4DC0-\u4DFF\uA490-\uA4C6\uA700-\uA716\uA720\uA721\uA789\uA78A\uA828-\uA82B\uA836-\uA839\uAA77-\uAA79\uAB5B\uAB6A\uAB6B\uFB29\uFBB2-\uFBD2\uFD40-\uFD4F\uFD90\uFD91\uFDC8-\uFDCF\uFDFC-\uFDFF\uFE62\uFE64-\uFE66\uFE69\uFF04\uFF0B\uFF1C-\uFF1E\uFF3E\uFF40\uFF5C\uFF5E\uFFE0-\uFFE6\uFFE8-\uFFEE\uFFFC\uFFFD]|\uD800[\uDD37-\uDD3F\uDD79-\uDD89\uDD8C-\uDD8E\uDD90-\uDD9C\uDDA0\uDDD0-\uDDFC]|\uD802[\uDC77\uDC78\uDEC8]|\uD803[\uDD8E\uDD8F\uDED1-\uDED8]|\uD805\uDF3F|\uD807[\uDFD5-\uDFF1]|\uD81A[\uDF3C-\uDF3F\uDF45]|\uD82F\uDC9C|\uD833[\uDC00-\uDCEF\uDCFA-\uDCFC\uDD00-\uDEB3\uDEBA-\uDED0\uDEE0-\uDEF0\uDF50-\uDFC3]|\uD834[\uDC00-\uDCF5\uDD00-\uDD26\uDD29-\uDD64\uDD6A-\uDD6C\uDD83\uDD84\uDD8C-\uDDA9\uDDAE-\uDDEA\uDE00-\uDE41\uDE45\uDF00-\uDF56]|\uD835[\uDEC1\uDEDB\uDEFB\uDF15\uDF35\uDF4F\uDF6F\uDF89\uDFA9\uDFC3]|\uD836[\uDC00-\uDDFF\uDE37-\uDE3A\uDE6D-\uDE74\uDE76-\uDE83\uDE85\uDE86]|\uD838[\uDD4F\uDEFF]|\uD83B[\uDCAC\uDCB0\uDD2E\uDEF0\uDEF1]|\uD83C[\uDC00-\uDC2B\uDC30-\uDC93\uDCA0-\uDCAE\uDCB1-\uDCBF\uDCC1-\uDCCF\uDCD1-\uDCF5\uDD0D-\uDDAD\uDDE6-\uDE02\uDE10-\uDE3B\uDE40-\uDE48\uDE50\uDE51\uDE60-\uDE65\uDF00-\uDFFF]|\uD83D[\uDC00-\uDED8\uDEDC-\uDEEC\uDEF0-\uDEFC\uDF00-\uDFD9\uDFE0-\uDFEB\uDFF0]|\uD83E[\uDC00-\uDC0B\uDC10-\uDC47\uDC50-\uDC59\uDC60-\uDC87\uDC90-\uDCAD\uDCB0-\uDCBB\uDCC0\uDCC1\uDCD0-\uDCD8\uDD00-\uDE57\uDE60-\uDE6D\uDE70-\uDE7C\uDE80-\uDE8A\uDE8E-\uDEC6\uDEC8\uDECD-\uDEDC\uDEDF-\uDEEA\uDEEF-\uDEF8\uDF00-\uDF92\uDF94-\uDFEF\uDFFA]/, dn = /[ \xA0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/;

// openclaw/node_modules/.pnpm/entities@8.1.0/node_modules/entities/dist/decode-codepoint.js
var Ni = [
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
function Fi(e) {
  return e === 0 || e >= 55296 && e <= 57343 || e > 1114111;
}
function Ht(e) {
  return Fi(e) ? 65533 : e >= 128 && e <= 159 && Ni[e - 128] || e;
}
function $t(e) {
  return e - 1 >>> 0 < 127 || e - 160 >>> 0 < 55136 ? String.fromCharCode(e) : String.fromCodePoint(Ht(e));
}

// openclaw/node_modules/.pnpm/entities@8.1.0/node_modules/entities/dist/internal/decode-shared.js
var K = /* @__PURE__ */ (() => {
  let e = new Uint8Array(127), n = 0;
  for (let t = 33; t <= 126; t++)
    t !== 34 && t !== 36 && t !== 92 && (e[t] = n++);
  return e;
})();
function Vt(e, n, t, o, r, i) {
  let c = e.length, d = i * 90, p = 0, g = () => {
    let S = K[e.charCodeAt(p++)];
    return S < i ? S : S * 91 - d + K[e.charCodeAt(p++)];
  }, m = t - o, y = t + r, l = new Int32Array(y);
  l.fill(-1, o, i), l.fill(-1, i + m, y);
  let u = new Int32Array(y), h = new Int32Array(y);
  function f(S, O) {
    let I = 0, A = O, G = O + S;
    for (; A < G; ) {
      let H = K[e.charCodeAt(p++)];
      if (H < 89)
        I += H, l[A++] = I;
      else if (H === 89) {
        let $ = K[e.charCodeAt(p++)] + 2;
        for (; $--; )
          l[A++] = ++I;
      } else {
        let $ = K[e.charCodeAt(p++)];
        I += 89 + // eslint-disable-next-line unicorn/prefer-minimal-ternary -- branches read a different number of side-effecting input bytes
        ($ < 90 ? $ * 91 + K[e.charCodeAt(p++)] : K[e.charCodeAt(p++)] * 8281 + K[e.charCodeAt(p++)] * 91 + K[e.charCodeAt(p++)]), l[A++] = I;
      }
    }
  }
  f(o, 0), f(m, i);
  let b = new Int32Array(r * 2), w = 0, R = 0;
  function k(S, O) {
    for (let I = 0; I < S; I++) {
      let A = O + I, G = g(), H = g();
      b[R * 2] = G, b[R * 2 + 1] = H, R += 1, u[A] = w;
      let $ = (l[G] < 0 ? h[G] : 1) + (l[H] < 0 ? h[H] : 1);
      h[A] = $, w += $;
    }
  }
  k(r - i + o, i + m), k(i - o, o);
  let x = new Uint16Array(w), C = 0;
  for (let S = 0; S < R; S++)
    for (let O = 0; O < 2; O++) {
      let I = b[S * 2 + O], A = l[I];
      if (A < 0) {
        let G = u[I], H = G + h[I];
        for (; G < H; )
          x[C++] = x[G++];
      } else
        x[C++] = A;
    }
  let M = new Uint16Array(n), v = 0;
  for (; p < c; ) {
    let S = K[e.charCodeAt(p++)];
    S >= i && (S = S * 91 - d + K[e.charCodeAt(p++)]);
    let O = l[S];
    if (O < 0) {
      let I = u[S], A = I + h[S];
      for (; I < A; )
        M[v++] = x[I++];
    } else
      M[v++] = O;
  }
  return M;
}

// openclaw/node_modules/.pnpm/entities@8.1.0/node_modules/entities/dist/generated/decode-data-html.js
var Kt = /* @__PURE__ */ Vt("!}.&u%}'&}*'~!6*)%&,~!J~!J~%L~y<~!R,~~%Lu~~#GD~~#|)1#%}^%}2%+#.##%##%}&%##%'#%##&%#%#'%#&#%#&#'#%%#&#%##%#)%''%&%#%#'%#%%#%%}%%%#%#&(23#%%#&-%0%('1#(##%#'##+%'*.:1}#%#6-+(%'%%#%%%}#L'2351&('%}&/N'(0(/*-%(%%}#'+&T%7.2}#&%&#%#36/5##%&%%#&#%%#))2%%##%&&'0~!#*+&'%1~!%).'3q?&%'1~!.##%6(~!+%%%(Gw'rT~!E#<nA%#jZ~!H%(~!42##~!*31&~!G%U~#)5~#`3~!J~!Z~%]~%Y~%C~!q~!u~#kz~%#~!6'~!D~!U~!?~#T~!c%~!G#'~%7|~!G~!J~!G&~#pb~(Df}#%}*&}#%##%##%##&#-}&'#'&%#.++}%mI,#,@&(}*%}*'%&##&#%##%}&0}#.},U},%}+%}&%}#%##&}B%(}(%}+%)})%##%#&}&%##%&}<%}>%#%&}*%}(%}9%}/%})%}*%}*%}?&}&%}3%}&*#%})%#%#)}#&#-#+*%E%%'%'#%}#*V##&##I}#&&##%&%#&&Qf%%))w/0+&%#(#.%-''''++++7}>%4'',##1,#%#&%##&#'##&#*#9)%&%}#*}%,#+P(%A&%#'&##wSD',9E00#y#@}(+}&%&>~!#~!X}#*}(&&}(&}(,%}%&#+&}#&}I%#%}%)#(},'%#*}4%%#%}(''}#/##(##),%-##%%)#&}(.}&%#&}%%}*&#%},&&}&%}#%*'#%})%}D&}&%}-&}6&#&}-,%}#%})-(~+`~,=?~I9'9%~!,#%})%})%}@%}?%}(~!?~#<~#pP~#BG~#=1#%K+~#?#~%;)~#A~#mF1~#A'~'X%'~#lR~#N~'N~#r~#m#-~#i'?%#'%~#B%##%,%#~#_%#0%~#]732~,w~2+#:&#%&'0%&>%}#>##F+)#%&&#(+_}4&}-%}(&}@&}O7Fdf0@+/v4}&WU##&/0#&'('B#%}.%}'+#%}#%%&#&%#%##+#&#)#6#'#.},%}c%},%#%##%&#&%#&~#>'*-.%##%##%}#%%}%'~#)D1}#%*&~#_%%'(~#S2%'.}#~#=##*'*-%}&'%'##&&~'E%.#&~#M4}%%##&'%#~#O1##%&#'+~#<B%##%%'%+~#;#@%}#&%#&&%#(~#H1}'%'##&&~#?A}&'~#D#%32}'&&&&~#[}'(#%}'~#;C})&}%%#%~#=&%,3}%'(#%%~#^'#&&)#%'~#Y%-~#d-%'~#^%%&#&&&}#~#b~2t*&'~&(~&@~0%~e~3}%*''0})&}+~!9##-}#%-hD*)1fC#%/&/fB#40~!+#)*4~!+~!K'&:~!/*7~!.#~!H~!L':~%x&~!H#~!*~%1~!I#~!+A~#p'~!F~~#-#~,,(~.Z~!V~%;'B'mq-W~!N~%I%#&&#&}#%},%%}'%}+X#%}#&}(%}'%}<%}#%}%%'}'%}:~![)9@~%>~#UA%-%##&~!C%~!-.9:~!1~!-^2/:a~!y,D*J#-5)/4~%23,~#G~!L1~!0X3`~!2+~!!0-~&E~!W~!o,>Y&]~%cZx_&~#O*9#A#'#+I'%#)~!0B*-5A+-((F&*M#)(-7-5+'-3a5Vi~!Y~!?+[)%3),ERHm~!+:D,VG.+)?fB%%*(%)'(#&80%1'8`K8?`+'Z#&O&'H5#*9)A%%5&3))0%39+.*7#()&&*=4@**L)<'_&*+..;(#*+)./&0#3)%')-8(4ixD(&.}%,('aI:,)%,k2231T)I'#/-W7,/'Q#.'Y24+h')37</31&83##&0#),H(?'&?/1##%#&&#%''-%&&&#(&''&#.-'%#%%(,')*'&#&#'##%(%(#%('#&##%%%%('%#%#%%#%#&%##h>w+v<ayvyvcg.uuhKr}g/v|g>u9i[~>g5uI~=RvdwEg;v/g;uk!!TTSx]@RT!U!#!@VBRUU!'UTe-d0c`e&gSdicedFcrdTaqb.kYcAohdYd@a3e+d}dMdtd.aJ#bqcK`dle/e.e'dwdPdodddjbEb}ogd^ofdpduc6j?l%d{drdqc)d7bacOdQ%T#Y)X.sR[yH>6Vyv3[xwLu>vo'!*.[yBacahoj>6Rew3[xqdZa#!a&#^(X-[yG>6Vyu3[xvg3sEr|g.u/Ri9db0T#^(Xa)!-[y;>6Vylg4wKs{JwNZt3@3r=c4Z([xlg;wKt!cpq's@v7A'*a(a+!-a#[y<3Dt?3Dt'>6Vym3[xmg9rxsNJwLZt4~?r?db1T#`-!(Xa,!0[yS>6Vz%NuQs.g4wKtnJwNZtS@3r>c4Z([y%g;wKtrdga8!a(!#&T*Y-Xa#!a0<or[yc3Dtq>6Vz43[y3JwNZtf@3s!Ju}!%Dti:pm3c_%X#tjB5pkd6q!r]u?voC'*-a.a2!0a&a+[yI3DtI3Ds~3DtH>6Vyw3[xx;:s#~<5pKJwNZtE@3r~d`a)!a2T#a.(!+U.X1[yT3Dt`3Dtv>6Vz&3[y&g9rxwzcxstPu.<rAJwLZtT~?r@dZa%!a.&^*Za(/Reu[ya>6Vz23[y1g3sEr}wkg{NuQRg{ci(U#5@b`~,cg#U(2WnH5wugcRh7dX#T(Y,a'Ta!!a,[yZ<]mj>6Vz,3[y+Pv#5ReZKu+=,%!H}7ABwkaS?Rh:BcW(X#<]mrj:ubv/ARekdg%!(!a.*Ta(Y.X1!#sP>Rl*Dt6[y>>6Vyo3Wf*jOvuumvuRgRJuq*!:9<B@bX~3jVv&v@s@5Re[d/rQt{uAvo&a&a*)a2!,0Wf!3Dt0=Bs'>6Re}3[xy~<5s%JwJZt1~Gs)c;&!#2sJkNuXvzq7rxu,Re8dka4!a8(aEZ+a@Y.X1Xa)[yd=Bs(3DtP>6Vz53[y4cX#X&Re:avRe9~<5s&JwJZtQ~Gs*i^rzvdRg+Jv{%!2sbB@bX}kdga,!Za?&^*T1/!a'Dt+[y6>6Vyf3Wf%g/u;s4hGu6?Rh-JvZ,!c%#&RoX54Rivj7uyvf8RgTKvZB%*!2sGh<vu5Rgq<=C::9bb~#dZ#T&Ta6Y.X*Dt>[y93Wf)coZ(T,6VyifluvRgC@95@B@bX~/hFu34cC#T,k/unq8w8Q5RkUklwQuzunq8w8Q5Rk8d/rJu?v8w9)-&!a0a;a&aIWejg3sEr/h1s<DtDJvyZqY5aws3Jvy!&Wei~Hr1:au5@Bag>23E~5c:Z&bX};kKv?w&unuVu5Rjc;>bs)#~@:Rh.=ay<a]C;b`}Vd6s/t{uAvoaxa()!a,a7%-a#a2Dt,[yF2Wo[>6Vyt3[xuNuPRi&NuPwpi#RoWh?vf8Ri%Jv]!%Ri:KvxD!.'2WeAjZu`q9rxu,Re7woeAg-unLq(qA_/*2Wg_g3u5q^9:4E}/jTrxrzv=Wkkd~0UX#^^Xa-a1a5T&a=U1a'*aEa]!a*aPaA-adok[y54Rn>;:p3~Dp5g9rpsFNvZqjg3uJp4~<5p0Pw;5qlJwNZt*@3p1Pw:5p/Ou!5p2JvG'!6Vye=<qnJvh_[xhg3v,Rh3kOwOw-sDuev/Re^dha[a%!%!a+#Ta7)-5TaCaO!aka!a)sf[yb2>Rl!9ARiq5E}Qg=ucRkBE|oJrJ_@Wk~@Wk{JrJ_@Wk|@WkyJrJ_@Wk}@WkzJvO_[y2g-vMRmiKuYC!)&>Ri;>Ri<@3RkNc](X#@9Rk=g5vuRmhKvDB!+'=]meg3u4Rmgd)#Y'Vz3CARmfd`a+!%T'!+#Ta1Ta6TaM-sTDt9[yA9sYd'%Y#s[[xpj:ueunaXRgEjRq,v-vuqdd2'`#6Rev<32@5>:2<E}5xIo9a*X#Y(;5RePJvD_g>vyRgNj8w)v8<wggs:RgXiZt|vjx,hSq3ah!-(~@:Ro/Ou!5RhWj^v(pyw8unRhUdx-UY#^Ua.a3a70!)%UX1TaDa)'omRiRRhE[y:3Dsz=Br,>6Vyj3[xkg6ruwjcqsrPw;5r*Ku]D'Zt-@3r(~?r.i[vwv]dU1a--U#`a4(g/vsRhPOu!5RhLj:rmu9Wo!~@:wdh@g/vsRiTjXuvvNr}:RhBj^v(pyw8unRn]dz1UYa'a+^Y(!aETZalaRY.Ta?a4[yDJw1!#qLsW>6Vyrfzq-pLflpwRe|Js>%!Dt@3Dt&Jvy_[xs~HrnjMuwpsw'RecKu+D#'!t<~Grl~?rjg5u-x,gwp{ah!-(~@:Rg~Ou!5Rh'jXuvvNr}:Rh#cW#X/c;&!#2sLi[v7u7RgpJv)(!iLrxu,Re6j7v@s@5Se[e7d`aW!Za(a`T.a#!a3!&aDa-!9)Dt_=6s+3[x~~DR|h~DS6avhGun5RkZj3w)v-]mkKunB!&*]kb97R|i<ARk<c:Z(6Vy}Juh'!wziMRoS:F|vkLuauJv5vtvQRh1d='T+Y#VyO~DR|jcF#T'7R|g97R|kJv3'!ay<Rj,Jvh&!:ReXcsa6*a+#a#_aIRf9aLRf?c,Z&Rf5Rf7c.Z&Rf;Rf>cQ#%T'p-Rf8Rf=ct#%'(*!,p,Rf4p+Rf6Rf:Rf<d~'Ua%U*^UYa(!a,-!#a4YaTalaEX0a8a<Weo3Dt/3Dsx=Br93Wen~Dr;~<5p<JwNZt2@3p=Pw:5p;Ou!5r3c7&!#:p>3Ds}KvGB)_6Vyk2sM=<r7x'eovA(!hFu1ARf}cV#X&@r5j6rvwQa^Rf3c=Za'wkghJv__g;unRggA53B9=b^}%j6uduo5Jq;!(hIv%2Re`Ou4ARe_e%a#^^^Xa&!a*a2!&a6YaP!*ad!#a:aE/5Rn?[y@>6Vyp;:pE~DrY~<5pBJwNZt8@3pCh=rt3rWPw:5pAJup_[xoNuPpF9c!#'45pD5ARn)d8#X'X*3@rU72s]h>v<<sSjJpqvewOJq/(!hNw'5ReBk0s2u3w/w'5ReE5@Jq.!a+JQ!&WeU23d(#Y&RjG5]jBk!u7w&u0udARjEe#+^^^Ub#!a2/a`Z(agT1!a-a;|@TaG!aS[yV=Re~fow'RguNuPRe?bz#'>RoUWeL>:Cbb|?JwPZtVg6ruRmzJvD'!6Vz(g/vmRh~Jvy_[y(g9voRgyx*cy(#2>Ri2B9b]~9kIw9u7rluJu3Rg]dI#a%UY'@=p%CAx.gQZ&RhwwygtRm{x5g_Z'+ABqR9Woa=Bp&dV#^*Xa'!&@o{g4v]Rk;Jv{!%Rk[wkkiA5RkiwwfUB=x,fUuqC&*!>RfTg8v0RfV~ARfSd;rJsAuAv9wR'ae+/aO!a@aza/a#[yQ@Wg!2Wemg3sEr0JvB_g>uvReWg2v+Re=KupB_+[y!2AbY~-~Hr2AJwD!(h<~El>h<~El?Kun@+_:9b`}Kg-v/Ri3g;vtwyk_9]k_d=&T#*U.6qh@Ab`|K9:H|CJv[!&3Dtex'fDwC%!Rf[9WlMd[(^X,!a%Z06Vz!@WgBg=v~Rgvg,QRe@awd,#Y+jTv|Q~EfWj]uNr|~FRfXdy#Y&^Ua%!aO.!(a)Ua;=!a@aKap!a-,a!Ta]a[rSa]p?[y82sK=Bq~;:p:~<5p8Pw:5p7d'#Y'Wf(;RnRi[u4w&RgJJvG'!6Vyh=<r#ijuuv/sIKuYD'ZtG@3p9~Gr&d2#`(g<vtRgFj`u5w&rqpxRf2CJuY!+:wfnTOu!5Rg}jNs1ucv&RfwJvA!&3@q|BDcC#T,k/unq8w8Q5RkTklwQuzunq8w8Q5Rk9dga#!a'!a=#a0!:+Tb*b@aO.a4!aba8aFJv^}?!VyR~Dr<g;u%Rn.~<5p[x'e`wNZtR@3p]Pw:5pZhNvjBp.woe_g5u-r4JwF!%DtO3:ooc7&!#:p^3DtpLuGw(!+%)Dtk6Vz#2sd=<r8d'#Y([y#<x3gJt`w@!)%}MRiowzikRij=]ilxAf3,U(#B2Rf#g0v-Rm[ck{`U#]giKv3>)!&6Ri154s,KuGB_%@r68r:dJ|t`#X(9<E|u2@H|rx3gJu?w'!+'1Nu7Reg4=H~+9<wxgY95Rm]xLggZ-`(X}U2:Ri4h<uOawRmsJv__5@bb{jbV~3dka#a'a]!,#a+U=a>b6a3b%!/aKa/)!arwve^VyJ;:pR~DpTg3uJpS~<5pOPw;5qmPw:5pNOu!5pQJvG'!6Vyx=<qoJvA!{~Jup!%@qk7Rn/KvyD!}''[xz;>wkh'?Rh,x8gyt`w5D!&),(SgyccRgztJ@3pPB5p#d'(Y#<]mmifubw&RgoJvE&!82s^JvF&!8Rf,ADb]~;x=h'rNu]vK!,%'*0RnORh)4Rh*AqQg-vaRnNg;wHwkh'ba~4cE#Ta*x3gctyw@'!+%RnFRnD<4Rn@hFvK5RnCxWg[#`&a0Ua()`1Rm75Rg[c]%X#qi8Rg^NvdRj>BwzgZauwji7Rm6A4wgg]d1#&(*,.0a#Rm;Rm<Rm=Rm>Rm?Rm@RmARmBe%#^^^Xaea?aC/b+(,!a+a#!a/!>a&Ta<aKbD!2wphBRnk[yPw}hE|.=Br-3Dtm>6Vy~g6urRf.x,hPrNav!%'RnqRo%Ro#Nu;q[Pw;5r+JwNZtM@3r)d'#Y'Weh;xChL#`&RnmRnoKu}>%(!Rne~Bs-;2wjcussJv+'!aYSO}6@B<5?ba~8LrNvj!.%*ROwungw~ng~:9;Ri^>wtnig;wHRnixDh@|(UZ.x1h@|)!#:2<H|*xHn]#-UX'3Ro)z=iT}6ARns=Bwsn_wpnaRncw]aR(#UXa&Ua*a/=]iPd'#Y&Ro'WnXf{QRm2hNvj]nZd`'T~&1`{|`#9b]{}c:'!#Wl{>@=be}]?cl{{U#:5Abb}Jds#^YaF!a*b4a#a3aPa>&Tb!bH!*a_!Eau?/a&RjY<]gj>6Vz*;:pe~DrZg,QRj1JwNZtX@wihspcJvZ&!VyX9WmOJu|!|N2WmHJvh&!]ht~Bpbcn&T(!#RmQ<s7Nu;padH#X'`+WmJ@>RmKCARhnKup=!)&Wf+:RhqNuPpf9c!#'45pd5AwghpARn(Ls@w!%,)!RmP@Wfe<E|IJva!&WmNg8vsRmLd`*.`#Y'Xa!axRn*]hrA8Rhug5s@rXg8u!RmMd8#X'X*3@rV72smdI*#UY&RmICARho~GsgxVgd)Ta'U-Y&Xa!T#RnEWnA@Wffg1uDRi0hFvK5RnBxGnG&#`%owp)@wsf+bX}Ze-*1!a*^^^Ua|!#a.aq&Ya2!a>.a6!a:aO`aJDtL[y`@Wg#>6Vz12@wzoYRoZNuPRi!NuPRhzg=ucRi,@=b`{Yg=ucRi-ACJvB!&Sh[ebSh]ebi`wUuFRm4Jw2_[y0JvB!.<Ju(!&SoG}6Shd}6<Ju(!&SoH}6She}6Kur@._g5vHRieJvx!{L2G{Kx6gd'T#?Rh82Wi5cZ#X(g1w)Rm5dW-Y(Ta#!a)!#aYa=wnfE=su2>>bU{0j9udv:<svj8uQv-7RgHdE%#^'sq9sp=>Bb_{TJv`!&g/r|snj6v(us5d,#Y(56H}[978H}]Jw5!&g1rushJvB!+j;v{u5?zDhd}6}bj;v{u5?zDhe}6}ce*#`(^^^a[aea!=!a6a*aoXb1a.!aAbL!b>,b'aL!aV@Wf|2Wlg3[y/JwNZt^@3piPw:5pgJunZou3@rsJva&!Vy_g<v~Rm#JvG'!6Vz0=<r{Ju{%!:pj@WfsiXuJu3Rm:JvZ&!WfA~Bph@c4Z&Dtwax5rubx(#:awRk1@d,#Y&RfjRfid1#,Y(@Wfp2Wlrg5s@ryKu[@!,'=]ig9wlk?Rk>g5u-rqJvy'!@9RkQcH(T#=>Ri~@<wkj(Wj(KuZB*!&<7rw@9RkRcH(T#=>Ri}@<wkj)Wj)dg(Ta2Xa9X#`-!a*CARhg@@=I}d9x;c~#X%so=<sj>2@@=aybb}XjWv0Q~EfEj3vLv;<d,#Y(56H}`978H}_dgaPaFa'a/!#a3Y0a_a;a|!1(a7-[yE3[xt;:pJNvZrrg3uJrvJwNZt=@3pIh=rt3rxPw:5pGOu!5rpJvG'!6Vys=<rz@c4Z&Dt(ax5rtJvZ!&~BpH@wsfNg-vaRlNci*U#=<wei<F}a5@Jq.!a*JQ!%@qZ23d(#Y&RjH5]jCk!u7w&u0udARjFd/prq=tyvpaEa(a:.!a1aZ(@@=I}:9wpd%=<sX55w_h}@@=I{t=ay<aU@@=I}T=ay<2@@=I})?C9:9au@9Cb]}DP~=x-fAZ(2Wl1=ay<aU@@=I}>5@d##Y+jTv|vV~EfFj]uNpn~FRfGdgaK!Z2&!a8a-Tb({E!acTbM*!a(DtY[yYd'%Y#sl[y*hHvh>Re5x2c{Z}.j4uCvcawRiMd+#X+_x&d!},<5RkX;2Hzw@x,gavfB-!{CcF&T#Roe;RodwWbBg5urRgaKvHC*_6Vz+<4opieuew&Rmq@d]&Y)X,T#X0Rh}<BqP=4qS9:ReMg/ujReNJw0!/<Jui%!bd{kawwnemRelAxUa?a3#*.&UX(Ya+a/RhvRnQ<o}9Wmtd-#Y&RgSRmw9;Rmxay=Rmyg-vaRmuxEhSrNu,v-voC!%(aR.a(a7+1Ro1>Ro5CE{A9b]{@;5x#eO{:g;urRi+KrNA!%(Ro3>Ro79;Ri_Ku@>{;&!x%gX|{KunA_+g5QRj/g3u5Rj#g>uERj%wio/xRhS&!,!#^1U}wba{8>>@=be}qC@:D5ba{7Ku+A&!}x?ba}t>>@=be}se(aA^^^Uat!b0#{pa+awUazbGa#aLb9bgaWac'a5TbS=Br!d1#`%scp_Jvl!#rT>Re0JvX&!VyN=H{Fcm#U&:pY=ReaJv2&!]h0=]nUJvG'!6Vy|=<r%JrM_=]h2@Wlud'#)U'Wf'b]{i=]h/Jvh!&~BpWg=v]RnMx+ny#'Nu;pVwjnu=]nwxJnx,T#`&Reqwjnt=]nvieu9vrRjLLuYwP(#+!th@wih5pX~Gr'g5v/Rh4KunA'!-CARnP@wwiN:Rm_9x'cvw>!|l=<saKvAA!0&3@q}>w^e1bp#&Re2Re3BDx7gH#T|f5H|eKuZ>!%(:qNAH{]Jv6!+3B2B9=b^{X<5<B92:E{ZLvhwA(a;a%!igQuyRmad+#Y}m@3Rh5d8#X'X*:AqUAHzmaxwbh<aXRnVcF}RT#Nw&cj#U(BWnug/vsRntdka)(a3+.Zb7aYYan1!bVa@Xa}[y^@b[{G=H{+hFu73Rj&Pv#5ReQcK%T#sig1v{Rj'Ku+D#'!t]~Grm~?rkKuMB!01d5#`'Vy.ta3Dtu~Hroc8#'{^45s85AwZbP&!#Rn!wghxWn#KvEA!)&2RlA2RlBx:h|#(T,=]j09Wobz>x]z/@awRoTd+#Y(az]hFhCrm4d,#Y+jTv|Q~EfMj]uNr|~FRfOdCa!Xa9_X#@<plJvf!%b`{(9;Rgwc;.!#2x7cw#T|UDb]|T5Ju={(!=@E{&Jv)&!Ab`{'awJvf!~*>>@=be{#KuY>!+&4Ezyi[ugv&RjIdea+T)#UXa&T-T&a!Rh9auRmW=]kLg5vuRn+g3u4Rn-Ow6ARn,hHus5xNk?#UX(U~)/g8v0RkD~AwkkF?Ri.OuNBwkkA?Ri/d|a2`a*^UYa.!aBTZaTa'Xa;!(!2!-a#b2[yC>6Vyq3[xr2Wi?g1rusVh%s?DtF~<5rbJs;%!DtBfswKtCj[uvuSsEu3RgVx3o:u+wN'*Zt;@3rd~Grh~?rfg8w)Lq)qE&-a%!>bI|`jWv0vV~EfCjTv|vV~Ef@j]uNpn~FRfBcK#T']gWNu7x,k7q4ai(0!hHv8<RhmkMu9vrsBuev/RhlCJvB!,g<v{wchh~@:Rhji[vrv{wchi~@:RhkdS&a5UY#Ta!RgPwwiI5BwciI~@:Rh`x'iJvj'!5]iJPu8Bwch]~@:Rhach)U#h3rp]gLh@t|Ax,hTq3ah!-(~@:Ro0Ou!5RhXj^v(pyw8unRhVd|)`,^UYas!a?/a2Z'a^Ta{Tb7Ta(a#!a,Wf&9sZ3DtAadamov=Bqt3[xig8vsRm~>waiL2b`{QJv*_Ouv2qgj<v]v2BqfdR'X*X#Y-@3qr~Gqv~?p6hHv-]glPup5Lq+q?_%*b_{qF{n9b^{rOu4ARhpKvCD!+&~Bqp:5Dbb}nwoiKl&unuTuBv]v+ueunaXRf0=Jvh!0nKufu8v1w&w7q%w&uHrz:Rgnj5w,uxDJq/(!hNw'5ReCk0s2u3w/w'5ReFd>Za&!*UaA=<wkgsRnSJv^!%Refifw3vyRgOKu_B'!,<]gkiiu:w&Rh<=C@a^<B57@2F{[<B5@aW:=3away9A5aW=<B=C@a^<B57@2F{Ie-#`(^^^bCara.b8aza6!/bZ,!adTbnTbOb+aFaS!aAT9@Wf~2Wli3Dtl2@d,#Y&RfnRfmJwJZtN~GqyJva&!VyMg<v~Rm%iXuJu3Rm9Jv[_=]ih9wlkDRkCd1#`(@Wg>2Wls3cH#T(@<Rj*=>Ri|b~'#23s9h<~El.d'#Y&Dtxi^rzvdRl#d*#U%(o|B2s`hJwSaxRmDKv4B&!1:Rmdd5#`'Vx}to~Hq{x'f1v3(!BA5ba|bJv_&!Wfug1v]ReIdO+U/Y#&G}-8wze=Rh{g1v]ReHg/uQRf/by#)ibQwERl/cH#T(@<Rj+=>Ri{cNu+vlax-!(#a0qa9<Rii2;;bU{H;x<i=&X#Rk`<4wwi=C9H~8xAI(Y#<azRi@45wXI<B9;5bb~7dL(X#Xa(+!aL6Vy{g5QqOau:5au2@ay547EzbxOcU(UX-T#Ta#:Cbb|A?wjh/b_|SOw6ARgtihr}u7Rhy<d1#T)X1@@=I|~=ay<2@@=aybb}Sj3vLv;<d,#Y(56H}A978H}@dGpvs@uAu`vcw9*!aFa+ai%(b!aXa8.a?a[ozWey=sU2@G}Nch&U#Rf_WexKu+D#'!t:~Gr`~?r^j]uNr|~FRg*j^psurwJt|RmcKv)@&!)7Rkv~Br[@wxfO:Rl3co#U'6Rezj_q#vIuavjRltwzeyh@vr5JqD0!>aY?C9:9au@9Cb]}9cl#U*5;5<H||jbuus1ucv&Rfvg1v~d/pppzqFr^a--a~!aMat1(hFv;Wiz@@=Izoj5uuv-7Rix~Cw`fk2WlVcZ#X,k)u3vWs@u2]ktg;wEx'fBq(_2Wg/jTv|vV~EfoJv]!15x'hzqG!(P~EfU~CRl_j6v(us5x4i-#T(2WmZ?C2F|d>Kq<aj1!*jTqIsBv=Wl`~Cw`fi2WlWj`v0u*~>RlR=c>Z,k#u3vWs@u2]kr<c1Z+jTqIsBv=Wla~Cw`fm2WlXdmb3!a{(arZa`bkTa%TbQTa-a9+c'!aM!/[yL=Bqug.w'RifhFvyDRj.g>vgwyk^9]k^Jv3_@WfbAARkhJw2_[x|JvB_wkoIRoKwkoJRoLd'(Y#<]gm=<9<H|yd'%_X#skDtb3awwqkgNulRkgdB#^',9:p'hJwSaxRmEBwVb8@4=H|qLu+w50&!)@3qs~?pU>Awwn;;Rn=c:Z'ARn<=<qwKvC@!/&~BqqJv6!&]eVb^z^xRge'/a%+^`#Sge}6<4Rn3=]n0Pw2>Rn8Jw0!&>Rn:>Rn6cY#a7+!a&=<wkaNw~h3z_c5Z{=wjh#=]nLKv^D!&)Vyz=bW|swYb<WetcG#T(2wxa@qVx@gD#Y&b^|V5JwG&!5bb|pg/w&RgD@x=kHs=uAvn!a%%/'+RmSRh694Ro`g-vaRmRhHv-]mlxCcS#`&ba~.5cD#Ta)P~=d,#Y(56H{>978H{Dd_#{2^Y%_+qbbb{6g3sERhsbU{?dfa.,`a(Xa<!aiX#(55RiG54RiHcI#T'WiU3RiVNvdwtfcRlKNvdd,#Y&RlHRlExQgf.1*^T'X#Sgf}6Wn4=]hfPrk>Rn7Jw0!&>Rn5>Rn9Lunw?&a2!,5<oq@@wqfdRlJj5Q~=d,#Y(~ARfcOuN]fdDKw;ay(}i!547E}j?cI#T(@5bV}iCbV}hdv(^^Tb?a40,b##Tbo!a*bR!a<b|a/!aKai!aU[yK=]o^g:v>ReGJwPZtK<7Rh+h<~El,Pv#5ReR@awwxjCg,ulRjDJv6&!]j!z?aQeeg>w=Sh<eeJw;!&axEzOg,Qosc!#*:wkeJ]eJ>x'h-u(!%Ro.w~h.zPdNZ(X,Ya![x{;9ReY;wkgxRiF:x?ap#Y&RmUg<s2Rkod]+UY0TZ'!a&A9sw<=bczLNvuw{gqzNhJwSaxRmCKuLay!#&s_Rf-55b^{uJvZa!!c%#(55Ri654wmiu5RiuawLu,vp!+}^%b_}Y9;wkgxba}o>A9:=b^}zKuh=a''!3awRk3c*'!#aHRk6c+Z&Rk5Rk4Jv)&!awRjSawd9*`#0?C2@EzMj8u<uJ5RmbjQrquJu3x,k>uq@_+=ayb^|W~ARkEOuN]k@7dhzV^X/X&a-#zRzSb`zXcJzTT#2WkVKvDBzW!%FzY9;5bbzWjQrquJu3Jw3%!b`zU=ayb^zQd:#X(T-a!6Vyywxh}=b]{Jg=u1RiAdGp~qHtzv!w(wA+a+a;<!aJaYai'anasb(=azRmV:Cbb{MLq2vb!%')RjuRjrRjtRjqx3jnqCw3!%')Rk(Rk+Rk&Rk)Lq2vb!%')Rj{RjxRjzRjwLq2vb!%')RjsRjpRjfRjex3jcqCw3!%')Rk'Rk*RjkRjl9<CbbzfOu4ARhxLq2vb!%')RjyRjvRjhRjgx=joq*uKvb!%')+-Rk.Rk%Rj~Rk-Rk#Rj}x=jdq*uKvb!%')+-Rk,Rk!Rj|RjmRjjRjidAq&qKs@uAv8Aa.'*-a@a&0!aM@a5[y73Dsy3Ds|3Dt):wxgI2sHJwJZt.~Gqxwsf0ikrzt}Rl0Jvy_[xj~HqzKv_A|D!&WfP8axRoVcf,U#k(v]v+ueunaXRf1Ju}'!g8u#Ri=jQw!sCunLprq>!,')~<5qeGzq9F{W=c##%s5au:5aU3CBE|;d4#X(D!a&6Vygx(b;#(=]ed?C2F{N<capoq2r[a&!aPa9,'Pw;5s:@@=I|,55w_h|@@=IzcP~=x'fCqB_2Wl2>aU@@=I|1OuNBc1Z+jTqIsBv=Wlc~Cw`fl2WlZ~AcTa%!Z+jTqIsBv=Wlb~Cw`fh2WlYk+uNqJsBv=WlSg,u3dca3#UXaMYa)TaB-=cM|7T#<bI}l5@B932:aV2G{BOuNBJq:|M!5Ezt=<B=C@a^<B57@2F{v>cB{/T#=ay<bI{3Jv6!a.6BKq0ah&+!5E}HP~Ef{978BaU@@=Iza<7d#.Y#978BaU@@=IzH~AJq0!(@@=IzG978BaU@@=IzFe,aU*Y&^^^bvJb,b:bFad!a,c2Ta>aL.bo6!a#CbTa'T#Re{2Wlh2@G{yg6t~Ro_NvdRfticuRQRllJv3&!x&c|zs@Jw3!%RflwpfkRlpKuL;%(!Re<@G|C2GzdhIvuBwgjAg-u0RjAKQB%!(GzZ@G|5NuuRl7d='T+Y#Vy[g<v~Rm!==G|>JvA!)@wma=]m1ifuaw&RmnLs@vT'!|/+[y,g:v>ReTJw1!#qX=x!eC{bLu+wT&)ZtZauq_~Graci&U#F|89:r_Lupvq!.)&2RlG8RfaC=x!eF{_h?rpWlmd&'!#X|&]k::xJey#`'T|+<E|&2@H|%dE#(^,g;u.RiEg6vjRiC9xCkA{O|zY#g=ucRmXKs0@!&*@G|m@awRknJuh!,3d(}gY}eJvj!%Rm):Jw3!%Rm+Rm-Ls0w(&!a(a#@b[|6cZ#X'7RkxWgAOu4ARn'dH'U#Y*Vz-Wm'CARm}d]*#a%^a*T'aK!a<9bV{PC=p*Jw4!&SgxcbB5r]idw(wBRmF7xFkt#&`(Rm/Rm8E|!JuY_9:Rl5=wrgr2:bbxd@xXfB(a*#T+!.X0X1Ta/a'T&RlDRfL>RlyARl9b[z[>RfZ:RlL:RfRwlg/ARl;9;RlxKv,A/!%7s69<74=BA5ba{-8Bde#`a<XaKYa1,a'P~=wxfB2bZ}}?C972@@=I}r8@55B9;5bb}G978B2@@=aybb}3j3vLv;<Jw3&!>Rfk=ayb^}4~Ad1#`*@@=aybb{w2@>==<bbz]dx+UY#^UaF!a9!bB'Ya1.!ajXa#%olRhD[y=3Dt#Ov5BrHKuMB%!(Rf^Wep~HrJwkiQjKr|~FRg)Ku+D#'!t5~GrF~?rDdV)UY,Z/_7RkuG{<~BrBg,rlsO:235B@bX}|d?a1!#`(6Vyn5@d##Y+jTv|vV~EfIj]uNpn~FRfH7Lq2vb1!a9-978BaU@@=Iz9978BbU}#~AJq0!(@@=Iz8978BaU@@=Iz7~AJQ|}!978BbU}!JvkaK!AdUa21-U#`a+(g/vsRn~Ou!5RPj:rmu9WhOjXuvvNr}:RhAj^v(pyw8unRn[kPr}p|u7vwv]RiSBd;pppzq@qHQa?(b.!a.a`@.|xa(hFv;Wiyj5uuv-7Riw~Cw`fg2WlU978BbU|wOuNBJqG!(P~EfD~CRlQcZ#X,k)u3vWs@u2]ksg;wEx'f@q1_2Wg.j]uNpn~FRfqJv]!15x'h{qG!(@@=IzK~CRl^j6v(us5x4i,#T(2WmY?C2F{1>Kq<aj1!*jTqIsBv=Wld~Cw`fj2Wl[j`v0u*~>RlT=c>Z,k#u3vWs@u2]kq<c1Z+jTqIsBv=Wle~Cw`fn2Wl]dn1#c(a(b^a2!b/bAT(bj!aDa7bu,a_a{c0!2T0g:v>ReD2@G{42@G{5~DpM~<5rc=Bx6i>{RT#RnI@zCx]y]z:2Jv[!zr5Awyk]9]k]dD(Y+X#6Vz.g=wKtgwhaCwgmTWj2Lu,w%_+/[y-B;b^xeg3u3Rj-2@bX{*KrJ<!+'@Wg(g?QRlC@Jv`!%b[zIwsfII}8JQ_@w|kW|=Jv(%!AqcOuNBJvEzh!bYzjLs@wP#(0!oy@>RkdJwMZtc3Dtd@BcG#T'9bWxg2@2Fznd*#Y+;2x'c}w<zizixNgwa#Z'U+!/!a'!a+w~g~z6wcn{Rn}wcnzRn|5Rh%=]nJg5vuRmvNvdRlvcprJu}w*az*a#!%.a.'Bot9qT]kj@Wg'ay2Gzv@Jv`!%b[zEwsfHI}1;ck#Ux`<Cbbx_Lu+w!a&0*!wko*wwo,So,}6Juqxf!E}PigQuyRm`d3(`#8>Rn%:A5B;bZ~%KvhCa!a2!x>k7#Uxb@b{#xaRk7Jw0!)>wwhlShl}6>wwhmShm}6CJvB!.x'hhvj{!!5Bwkhhbaz}x'hivjz~!5Bwkhibaz|xEhTrNu,v-vpD!a%&/)a3a.,%Ro2t[CE{)@3re9b]{%wjo09:rgc:Z&Ro6=<riifuaw&RmoKrNA!%(Ro4>Ro89;Ri`dSaL'UYzxZb)7Rka3xRhT&!,!#^1U}vbaz{>>@=be}yC@:D5bazzKu+A&!}{?ba}y>>@=be}wxBh[t`u~vJvr!%a!a()a,a0a4RoC=]o;Ju(!%RoGRhdwjh`=]oAg>w#Ro?g5vuRo=NvdRl|Ku]C.!&;RoEJvB!%RoORoMBx'h[v+_?w~h`}~5?w~hd~!xKh]oiptu-utv.vp!#%&a30a@a'a+(a/aOp(o~p!RoDJu(!%RoHRhewjha=]oBNvdRl}g>w#Ro@g5vuRo>c[#X']o<CauRoRAd-#Y':RkpauRoQKu]C.!&;RoFJvB!%RoNRoPBx'h]v+_?w~ha}t5?w~he}ue!/UbhYacXaW^Tc&a;b:a-c/#b&aja1(!cL+!bKbt!bmcRc9aIc?8[yW3Dtt94Rg`Jv}!&SiRMzBhEebShEMNuPRe>x7gL#TzuwjirRipc<Z&>on;>z=h-MSh.Mwqczx'a7vj&!>Re4@=ResJt__NuPRi*NuPRi)j]uNr|~FRfzKrJ>_+@Wfy@Wf]2WocKrJ<!+'@Wg%g/QRl@@Jv`!&awRl<wsfFIzgLu(w*!.*&ShBMwvhIRhI9;RhNx1hK'!#Sn]Mx1hK~0!#:2<H~7cNu+w7D*'1ZtW>Rn1~?rOc:Z&Rn2=<rQ<7wjh&=BSnLMc]#X(6Vz)w[b=a!U#9wzgMc3#&(RgMRitRis<x,gKt`ax!&+SioM=BSilMc3#&(RgKRinRimKurB,!&SiQMzBhDebShDM6BJQ!(P~Efx978B2@@=I}WLrJw!!,a*&@G}O@9wkibRid@@x'fKwC!&SlDMSfLMjUv~Q~EfKKv3@a+!(hFv-]mpx/hYZ(C5RiWz<o/MwkhY?So/M@x,gbvfB*&!SgEM:SoeeehFu3:Rgbda(,^TZa)X/7Sg[eb:2RgI~BrMC@wgkc:wwkcRerx3h(uUvK!&*,SnOM4Sh*MArRg;wHRh(x=h;rJvPwI!a4',a'0@Wg&=BSh/Mg>w=Rh=g3w*wwgGRgGcW(X#;Sg}M2Gzk@Jv`!&awRl=wsfGIz`dKZ*T'Y-:RhR7RhQg5u-p`j6v(us5d,#Y+~Awkia?RicOuNBwkibba}Ld6p~tyu_vbAa'a+!a/'a3aEa8a!>Sh,ebJv{!&Sh@ebSaReb9;SgwebNuPRi(NvdRl)NuPRi'hHu^<Rm^Jvv_@Wl(g;u1Si/ebKu'B&!*Sh?eb@Wl'z@aPeb95Si.ebcpputyvjB)!,&a+0a%ShAMWeK@G}C@WfJ9;RhMwvhH9w{ia}ix,hJvRA1(!zAn[MRhHx1hJ~*!#hFv(BSn[MBJQ!(@@=I~'978B2@@=I}2db.Ua<'X}+T#a0XaG2G}E;wkg|wuh!Rh!x,hZu,@)!&So0MVy)C5RiXACJvB!&5RiY5RiZg8w)cG}*T#2@bU}=KsA>(!a.3wkhZba~(x,h^u(A!&(SoCMRhb5Bz=h[eb?w~hb~6x,h_u(A!&(SoDMRhc5Bz=h]eb?w~hc~6e)aA1T#T,^^^c-bMb&blcPaP(a/!0!bA=b5c@a(!bfbrc#2afwmhARnjwchORnp2Wlf3DtsNvdRl-2@wpa<]m0bx(#:awRk2@Jw3!%RfhwpfgRlnKQB%!(G{V@G|'NuuRl6d='T+Y#VyUg<v~Rl~==G|<Jv+'!aYShC}6@B<5?ba~8@Jw3'!g2QRljhLrpWlOd+#Y'g.w'rIg>w*wgj@g-u0Rj@Lu+wT&)ZtUauq]~GrGci&U#F|39:rELrNvj!.%*RhCwunfw~nf~:9;Ri]>wtnhg;wHRnhx3hDs@v~!/+'@Wfr@9RkSNu&Rlo=@<5GzoKs0@_+@Wl+@awRkmJuh!-3d(}pY#qWJvj!%Rm(:Jw3!%Rm,Rm*de&!1U-U#`)Re;@G|.@9Ri82@wjfvRlq=@<5GzpLvOvr!).&2RlF8Rf`C=x!eE{.Jw3_g2QRlkhLrpWlPde(!#U{s,UXa*Ta'[y'g:v>ReS;x0PZ&RnlRnn~HrKJw1}f!=x!eB|2w]aP(#Xa&a*Ta.Ua2a7=]iOd'#Y&Ro&WnWg;u.RiDg6vjRiBNvdRlzhNvj]nYJuW_2Wm3x)kFze{9d])!a.!,Y01!#&aC!a3RndC=ox~BrC@2b^{pg,rlse7x'ksuq!%Rm.E{xidw(wBRmGx9o+)X#wwo-So-}69:Rl4@xSf@a#XZ'X)X,Ta(/ARl8b[xc>RfY:RlI:RfQwlg.ARl:9;Rlwdn'#^XafaQa1X1TaHTa)@b[{zcZ#X'7RkwWg@Ou4ARn&x)kG#{,g7u/RkGdH'U#Y*Vz'Wm&CARm|bx#(A]gUbUzJj9Q~=d,#Y(56H}l978H{U7d,0#U*2>ABb_xZ978BbU{e~AJQ{g!978BbU{hxMh?ad{oUYZ.x1h?{l!#:2<H{mx3n[t{vl!,&a%3Ro(z=iS}6ARnr=Bwsn^wvn`Rnbd`*T}B0!#^X'BG{c9b]{a>>@=be}F?JvS!&BG{d7BG}(Bde#`a1X,Ya@!a'P~=wxf@2bZ}I56B2@@=aybb}08@55B9;5bb}<j3vLv;<Jw3&!>Rfg=ayb^}&OuNBKuLA!)a!P~=x#fD{f2@>==<bbzl?C972@@=Ix^d6rSu,v7w*C(0a)a6#B+a%!sQ[y?3Dt%3[xn~<5rLOu!5p@Ku+D#'!t7~GrP~?rNKvlaya7'!h+v-5qMg=t|cd,U#5AAaa5Abb{S@52B5@a[@52B5Gx[iXueu;d<#`a(!/549C;ag>23ExY5@Dah89b^~689Jv)!~2b[~1Lv'w(%*!a#bX|aPrmawRe]keu7uhv-q6rxu,q`xTo]/a5aU!bNaDXbi!b-!ao!b<bwA!#5@B932:aV2G|:d-)Y#hJrL>RhG<7@C5<H|_=Cau:5aj5@B932:bJ|ng>vIbs)#?C2F|9jPv0w.vISh-MKvUaz(.!9ABbb|[5;5<H|Eg>unwfh;9:4E|YjQsBt|vjx'hYq3!(?C2F|J:2<BaY?C2F|GOu!5x,g|p{ah!-(?C2F|c9:4E|OjXuvvNr}:Rh&i[w*t|cd+U#jJvsu)vsSn~Mkfrmu9p}u7vwv]So!McW#Xa!ax5@A5aY:5;5<H|>kJv~vYrquJu3x4ib#T)2@SmZM?C2F|Bj:rmu9@xPhI(a*a#U#`a3-5Abb|L~@:RhK9:4E|0@52B5G|#C::aY?C2F|-:2<BaY?C2F|.5Jvk!a)javYrquJu3x4ia#T)2@SmYM?C2F|HAxPhH(!a#U#`a*-5Abb|4~@:RhJ9:4E|R@52B5G|F:2<BaY?C2F|Sc^#Xa2j=Qq5CJvB!-g<v{z;hhM?C2F|Zi[vrv{z;hiM?C2F|XKsA>!a)-g<v{z;h[eb?C2F|]i[vrv{z;h]eb?C2F|^iZu.vix,hZq3ah!.(?C2F|QOu!5ShXM:2<BaY?C2F|P", 13494, 2713, 49, 25, 61);

// openclaw/node_modules/.pnpm/entities@8.1.0/node_modules/entities/dist/internal/bin-trie-flags.js
var U;
(function(e) {
  e[e.VALUE_LENGTH = 49152] = "VALUE_LENGTH", e[e.FLAG13 = 8192] = "FLAG13", e[e.BRANCH_LENGTH = 8064] = "BRANCH_LENGTH", e[e.JUMP_TABLE = 127] = "JUMP_TABLE", e[e.VALUE_MASK = 8191] = "VALUE_MASK";
})(U || (U = {}));

// openclaw/node_modules/.pnpm/entities@8.1.0/node_modules/entities/dist/decode.js
var z;
(function(e) {
  e[e.AMP = 38] = "AMP", e[e.NUM = 35] = "NUM", e[e.SEMI = 59] = "SEMI", e[e.EQUALS = 61] = "EQUALS", e[e.ZERO = 48] = "ZERO", e[e.NINE = 57] = "NINE", e[e.LOWER_A = 97] = "LOWER_A", e[e.LOWER_X = 120] = "LOWER_X";
})(z || (z = {}));
var je = 32, Xt = 21, Li = 2097151, fn = 2047, Zt = 0;
function Ui(e) {
  let n = e >>> Xt;
  return n === fn ? Zt : n;
}
function Qt(e) {
  return e - z.ZERO >>> 0 <= 9;
}
function Bi(e) {
  return (e | je) - z.LOWER_A >>> 0 <= 5;
}
function er(e) {
  return (e | je) - z.LOWER_A >>> 0 <= 25;
}
function ji(e) {
  return e === z.EQUALS || er(e) || Qt(e);
}
var Jt;
(function(e) {
  e[e.EntityStart = 0] = "EntityStart", e[e.NumericStart = 1] = "NumericStart", e[e.NumericDecimal = 2] = "NumericDecimal", e[e.NumericHex = 3] = "NumericHex", e[e.NamedEntity = 4] = "NamedEntity";
})(Jt || (Jt = {}));
var hn;
(function(e) {
  e[e.Legacy = 0] = "Legacy", e[e.Strict = 1] = "Strict", e[e.Attribute = 2] = "Attribute";
})(hn || (hn = {}));
function Gi(e, n, t, o) {
  let r = (n & U.BRANCH_LENGTH) >> 7, i = n & U.JUMP_TABLE;
  if (i) {
    if (r === 0)
      return o === i ? t : -1;
    let d = o - i;
    if (d >>> 0 >= r)
      return -1;
    let p = e[t + d];
    return p === 0 ? -1 : t + r + p - 1 & 65535;
  }
  if (r === 0)
    return -1;
  let a = r + 1 >> 1, c = t + a + r;
  for (let d = 0; d < r; d++) {
    let g = e[t + (d >> 1)] >> ((d & 1) << 3) & 255;
    if (g === o) {
      let m = t + a + d;
      return c + e[m] & 65535;
    }
    if (g > o)
      return -1;
  }
  return -1;
}
function Yt(e, n, t) {
  return t === 1 ? String.fromCharCode(e[n] & U.VALUE_MASK) : t === 2 ? String.fromCharCode(e[n + 1]) : String.fromCharCode(e[n + 1], e[n + 2]);
}
function qi(e, n, t) {
  let o = n + 1, r = 0, i = o;
  if (o < t && (e.charCodeAt(o) | je) === z.LOWER_X)
    for (o += 1, i = o; o < t; ) {
      let c = e.charCodeAt(o);
      if (Qt(c))
        r = r * 16 + (c - z.ZERO);
      else if (Bi(c))
        r = r * 16 + ((c | je) - z.LOWER_A + 10);
      else
        break;
      o += 1;
    }
  else
    for (; o < t; ) {
      let c = e.charCodeAt(o) - z.ZERO;
      if (c >>> 0 > 9)
        break;
      r = r * 10 + c, o += 1;
    }
  if (o === i)
    return 0;
  o < t && e.charCodeAt(o) === z.SEMI && (o += 1), r > 1114111 && (r = 1114112);
  let a = o - n;
  return a >= fn && (Zt = a, a = fn), a << Xt | r;
}
function Wi(e, n, t) {
  let o = Kt, r = e.indexOf("&");
  if (r < 0)
    return e;
  let i = e.length, a = 0, c = "", d = o[0], p = d & U.JUMP_TABLE, g = (d & U.BRANCH_LENGTH) >> 7;
  do {
    let m = r + 1, y = e.charCodeAt(m), l, u;
    if (y === z.NUM) {
      let h = qi(e, m, i);
      l = Ui(h), n && l > 0 && e.charCodeAt(m + l - 1) !== z.SEMI && (l = 0), u = l === 0 ? "" : $t(h & Li);
    } else if (er(y)) {
      l = 0, u = "";
      let h = y - p, f;
      if (h >>> 0 < g) {
        let x = o[1 + h];
        f = x === 0 ? -1 : g + x & 65535;
      } else
        f = -1;
      let b = 0, w = 0, R = f < 0 ? 0 : o[f], k = m + 1;
      e: for (; k < i; ) {
        for (
          ;
          // Value-less, non-run node with a nonzero jump offset.
          (R & (U.VALUE_LENGTH | U.FLAG13)) === 0 && (R & U.JUMP_TABLE) !== 0;
        ) {
          let v = R & U.JUMP_TABLE, S = (R & U.BRANCH_LENGTH) >> 7;
          if (S === 0) {
            if (e.charCodeAt(k) !== v)
              break e;
            f += 1;
          } else {
            let O = e.charCodeAt(k) - v;
            if (O >>> 0 >= S)
              break e;
            let I = o[f + 1 + O];
            if (I === 0)
              break e;
            f = f + S + I & 65535;
          }
          if (R = o[f], k += 1, k >= i)
            break e;
        }
        if ((R & (U.VALUE_LENGTH | U.FLAG13)) === U.FLAG13) {
          let v = (R & U.BRANCH_LENGTH) >> 7;
          if (e.charCodeAt(k) !== (R & U.JUMP_TABLE))
            break;
          k += 1;
          let S = v - 1, O = f + 1, I = 0;
          for (; I + 1 < S; I += 2) {
            let A = o[O];
            if (e.charCodeAt(k) !== (A & 255) || (k += 1, e.charCodeAt(k) !== (A >> 8 & 255)))
              break e;
            k += 1, O += 1;
          }
          if (I < S) {
            if (e.charCodeAt(k) !== (o[O] & 255))
              break;
            k += 1;
          }
          f += 1 + (v >> 1), R = o[f];
          continue;
        }
        let x = R >>> 14, C = e.charCodeAt(k);
        if (x !== 0) {
          if (C === z.SEMI) {
            l = k - m + 1, u = x === 1 ? String.fromCharCode(R & U.VALUE_MASK) : Yt(o, f, x);
            break;
          }
          if (!n && (R & U.FLAG13) === 0 && (l = k - m, b = f, w = x), x === 1)
            break;
        }
        let M = Gi(o, R, f + (x || 1), C);
        if (M < 0)
          break;
        f = M, R = o[f], k += 1;
      }
      if (u === "") {
        let x = R >>> 14;
        x !== 0 && !n && (R & U.FLAG13) === 0 && (l = k - m, b = f, w = x), l > 0 && (u = Yt(o, b, w));
      }
    } else
      l = 0, u = "";
    l === 0 || t && y !== z.NUM && e.charCodeAt(m + l - 1) !== z.SEMI && m + l < i && ji(e.charCodeAt(m + l)) ? r = m : (a < r && (c += e.slice(a, r)), c += u, r = a = m + l), e.charCodeAt(r) !== z.AMP && (r = e.indexOf("&", r));
  } while (r >= 0);
  return c + e.slice(a);
}
function Ge(e) {
  return Wi(e, !0, !1);
}

// openclaw/node_modules/.pnpm/entities@8.1.0/node_modules/entities/dist/index.js
var nr;
(function(e) {
  e[e.XML = 0] = "XML", e[e.HTML = 1] = "HTML";
})(nr || (nr = {}));
var tr;
(function(e) {
  e[e.UTF8 = 0] = "UTF8", e[e.ASCII = 1] = "ASCII", e[e.Extensive = 2] = "Extensive", e[e.Attribute = 3] = "Attribute", e[e.Text = 4] = "Text";
})(tr || (tr = {}));

// openclaw/node_modules/.pnpm/linkify-it@6.1.0/node_modules/linkify-it/build/index.mjs
var Hi = class {
  src_Any = cn.source;
  src_Cc = ln.source;
  src_Z = dn.source;
  src_P = Ce.source;
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
    let o = this.escapeRE(e), r = this.escapeRE(n), i = `(?:(?!${this.src_ZCc}|${o}|${r}).)`, a = `${o}${i}{0,1000}${r}`;
    for (let c = 2; c <= t; c++) a = `${o}(?:${i}|${a}){0,1000}${r}`;
    return a;
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
    let o = t.re.get_http_validator();
    o.lastIndex = n;
    let r = o.exec(e);
    return r ? r[0].length : 0;
  },
  normalize: (e, n) => n.normalize(e)
}, $i = {
  "http:": gn,
  "https:": gn,
  "ftp:": gn,
  "//": {
    validate: function(e, n, t) {
      let o = t.re.get_relative_proto_validator();
      o.lastIndex = n;
      let r = o.exec(e);
      return r ? n >= 3 && e[n - 3] === ":" || n >= 3 && e[n - 3] === "/" ? 0 : r[0].length : 0;
    },
    normalize: (e, n) => n.normalize(e)
  },
  "mailto:": {
    validate: function(e, n, t) {
      let o = t.re.get_mailto_validator();
      o.lastIndex = n;
      let r = o.exec(e);
      return r ? r[0].length : 0;
    },
    normalize: (e, n) => n.normalize(e)
  }
}, Vi = "a:cdefgilmnoqrstuwxz|b:abdefghijmnorstvwyz|c:acdfghiklmnoruvwxyz|d:ejkmoz|e:cegrstu|f:ijkmor|g:abdefghilmnpqrstuwy|h:kmnrtu|i:delmnoqrst|j:emop|k:eghimnprwyz|l:abcikrstuvy|m:acdeghklmnopqrstuvwxyz|n:acefgilopruz|o:m|p:aefghklmnrstwy|q:a|r:eosuw|s:abcdeghijklmnortuvxyz|t:cdfghjklmnortvwz|u:agksyz|v:aceginu|w:fs|y:et|z:amw", Ki = "biz|com|edu|gov|net|org|pro|web|xxx|aero|asia|coop|info|museum|name|shop|\u0440\u0444";
function Ji() {
  let e = Ki.split("|");
  return Vi.split("|").forEach((n) => {
    let t = n.indexOf(":"), o = n.slice(0, t);
    for (let r of n.slice(t + 1)) e.push(o + r);
  }), e;
}
var Yi = {
  fuzzyLink: !1,
  fuzzyEmail: !0,
  fuzzyIP: !1,
  "---": !1,
  tlds: Ji(),
  urlAuth: !1,
  maxLength: 1e4
}, rr = class {
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
  constructor(e, n, t, o) {
    let r = e.slice(t, o);
    this.schema = n.toLowerCase(), this.index = t, this.lastIndex = o, this.raw = r, this.text = r, this.url = r;
  }
}, or = class {
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
      ...Yi,
      ...t
    }, this.__schemas__ = { ...$i }, this.re = n || new Hi(), this.re.set({
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
        normalize: (o, r) => r.normalize(o),
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
      let o = this.re.get_fuzzy_mail_host_search(), r = this.re.get_mail_name_validator();
      for (o.lastIndex = 0; (n = o.exec(e)) !== null; ) {
        let i = e.slice(Math.max(0, n.index - 65), n.index);
        if (r.test(i)) return !0;
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
    let n = [], t = this.re.get_schema_search(), o, r, i, a, c, d, p = !1, g = !1, m = !1, y = 0;
    if (!e.length) return null;
    for (t.lastIndex = 0, this.__opts__.fuzzyLink && this.__schemas__["http:"] && (o = this.re.get_fuzzy_link_search(), o.lastIndex = 0), this.__opts__.fuzzyEmail && this.__schemas__["mailto:"] && (r = this.re.get_fuzzy_mail_host_search(), r.lastIndex = 0, i = this.re.get_mail_name_validator()); ; ) {
      let l = Math.max(y - 1, 0);
      if (r && i && !m && (!c || c.index < y))
        for (r.lastIndex < l && (r.lastIndex = l); ; ) {
          let w = r.exec(e);
          if (!w) {
            m = !0, c = void 0;
            break;
          }
          let R = i.exec(e.slice(Math.max(0, w.index - 65), w.index));
          if (R) {
            if (c = {
              schema: "mailto:",
              index: w.index - R[1].length,
              lastIndex: w.index + w[0].length
            }, c.index >= y) break;
            r.lastIndex < l && (r.lastIndex = l);
          }
        }
      if (o && !g && (!a || a.index < y))
        for (o.lastIndex < l && (o.lastIndex = l); ; ) {
          let w = o.exec(e);
          if (!w) {
            g = !0, a = void 0;
            break;
          }
          if (a = {
            schema: "",
            index: w.index + w[1].length,
            lastIndex: w.index + w[0].length
          }, a.index >= y) break;
          o.lastIndex < l && (o.lastIndex = l);
        }
      let u = c;
      (!u || a && (a.index < u.index || a.index === u.index && a.lastIndex > u.lastIndex)) && (u = a);
      let h;
      if (!p) for (; ; ) {
        if (!d) {
          t.lastIndex < l && (t.lastIndex = l);
          let k = t.exec(e);
          if (!k) {
            p = !0;
            break;
          }
          d = {
            schema: k[2],
            index: k.index + k[1].length,
            lastIndex: k.index + k[0].length
          };
        }
        if (d.index < y) {
          d = void 0;
          continue;
        }
        if (u && d.index > u.index) break;
        let w = d;
        d = void 0;
        let R = this.testSchemaAt(e, w.schema, w.lastIndex);
        if (R) {
          h = {
            schema: w.schema,
            index: w.index,
            lastIndex: w.lastIndex + R
          };
          break;
        }
      }
      let f = h;
      if ((!f || c && (c.index < f.index || c.index === f.index && c.lastIndex > f.lastIndex)) && (f = c), (!f || a && (a.index < f.index || a.index === f.index && a.lastIndex > f.lastIndex)) && (f = a), !f) break;
      f === c ? c = void 0 : f === a && (a = void 0);
      let b = new rr(e, f.schema, f.index, f.lastIndex);
      b.schema ? this.__schemas__[b.schema].normalize(b, this) : this.normalize(b), n.push(b), y = f.lastIndex;
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
    let o = new rr(e, n[2], n.index + n[1].length, n.index + n[0].length + t);
    return this.__schemas__[o.schema].normalize(o, this), o;
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

// openclaw/node_modules/.pnpm/markdown-it@15.0.2/node_modules/markdown-it/dist/markdown-it.mjs
var xn = Nn(pr(), 1);
var fr = Object.defineProperty, Sr = (e, n) => {
  let t = {};
  for (var o in e) fr(t, o, {
    get: e[o],
    enumerable: !0
  });
  return n || fr(t, Symbol.toStringTag, { value: "Module" }), t;
}, as = /* @__PURE__ */ Sr({
  arrayReplaceAt: () => cs,
  asciiTrim: () => He,
  callable: () => Er,
  escapeHtml: () => te,
  escapeRE: () => bs,
  fromCodePoint: () => Te,
  isMdAsciiPunct: () => _e,
  isPunctChar: () => Ar,
  isPunctCharCode: () => Ee,
  isSpace: () => F,
  isValidEntityCode: () => Cn,
  isWhiteSpace: () => Se,
  lib: () => ws,
  normalizeReference: () => ze,
  unescapeAll: () => ge,
  unescapeMd: () => ps
});
function Er(e) {
  let n = function(...t) {
    return Reflect.construct(e, t, new.target && new.target !== n ? new.target : e);
  };
  return Object.defineProperty(n, "name", { value: e.name }), Object.setPrototypeOf(n, e), n.prototype = e.prototype, n;
}
function cs(e, n, t) {
  return [].concat(e.slice(0, n), t, e.slice(n + 1));
}
function Cn(e) {
  return !(e >= 55296 && e <= 57343 || e >= 64976 && e <= 65007 || (e & 65535) === 65535 || (e & 65535) === 65534 || e >= 0 && e <= 8 || e === 11 || e >= 14 && e <= 31 || e >= 127 && e <= 159 || e > 1114111);
}
function Te(e) {
  if (e > 65535) {
    e -= 65536;
    let n = 55296 + (e >> 10), t = 56320 + (e & 1023);
    return String.fromCharCode(n, t);
  }
  return String.fromCharCode(e);
}
var _r = /\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, ls = new RegExp(`${_r.source}|${/&([a-z#][a-z0-9]{1,31});/gi.source}`, "gi"), us = /^#((?:x[a-f0-9]{1,8}|[0-9]{1,8}))$/i;
function ds(e, n) {
  if (n.charCodeAt(0) === 35 && us.test(n)) {
    let o = n[1].toLowerCase() === "x" ? parseInt(n.slice(2), 16) : parseInt(n.slice(1), 10);
    return Cn(o) ? Te(o) : e;
  }
  let t = Ge(e);
  return t !== e ? t : e;
}
function ps(e) {
  return e.indexOf("\\") < 0 ? e : e.replace(_r, "$1");
}
function ge(e) {
  return e.indexOf("\\") < 0 && e.indexOf("&") < 0 ? e : e.replace(ls, function(n, t, o) {
    return t || ds(n, o);
  });
}
var fs = /[&<>"]/, hs = /[&<>"]/g, gs = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;"
};
function ms(e) {
  return gs[e];
}
function te(e) {
  return fs.test(e) ? e.replace(hs, ms) : e;
}
var ys = /[.?*+^$[\]\\(){}|-]/g;
function bs(e) {
  return e.replace(ys, "\\$&");
}
function F(e) {
  switch (e) {
    case 9:
    case 32:
      return !0;
  }
  return !1;
}
function Se(e) {
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
function Ar(e) {
  return Ce.test(e) || un.test(e);
}
function Ee(e) {
  return Ar(Te(e));
}
function _e(e) {
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
function ze(e) {
  return e = e.trim().replace(/\s+/g, " "), e.toLowerCase().toUpperCase();
}
function hr(e) {
  return e === 32 || e === 9 || e === 10 || e === 13;
}
function He(e) {
  let n = 0;
  for (; n < e.length && hr(e.charCodeAt(n)); n++) ;
  let t = e.length - 1;
  for (; t >= n && hr(e.charCodeAt(t)); t--) ;
  return e.slice(n, t + 1);
}
var ws = {
  mdurl: an,
  ucmicro: pn
};
function ks(e, n, t) {
  let o, r, i, a, c = e.posMax, d = e.pos;
  for (e.pos = n + 1, o = 1; e.pos < c; ) {
    if (i = e.src.charCodeAt(e.pos), i === 93 && (o--, o === 0)) {
      r = !0;
      break;
    }
    if (a = e.pos, e.md.inline.skipToken(e), i === 91) {
      if (a === e.pos - 1) o++;
      else if (t)
        return e.pos = d, -1;
    }
  }
  let p = -1;
  return r && (p = e.pos), e.pos = d, p;
}
function Rs(e, n, t) {
  let o, r = n, i = {
    ok: !1,
    pos: 0,
    str: ""
  };
  if (e.charCodeAt(r) === 60) {
    for (r++; r < t; ) {
      if (o = e.charCodeAt(r), o === 10 || o === 60) return i;
      if (o === 62)
        return i.pos = r + 1, i.str = ge(e.slice(n + 1, r)), i.ok = !0, i;
      if (o === 92 && r + 1 < t) {
        r += 2;
        continue;
      }
      r++;
    }
    return i;
  }
  let a = 0;
  for (; r < t && (o = e.charCodeAt(r), !(o === 32 || o < 32 || o === 127)); ) {
    if (o === 92 && r + 1 < t) {
      if (e.charCodeAt(r + 1) === 32) {
        r++;
        continue;
      }
      r += 2;
      continue;
    }
    if (o === 40 && (a++, a > 32))
      return i;
    if (o === 41) {
      if (a === 0) break;
      a--;
    }
    r++;
  }
  return n === r || a !== 0 || (i.str = ge(e.slice(n, r)), i.pos = r, i.ok = !0), i;
}
function xs(e, n, t, o) {
  let r, i = n, a = {
    ok: !1,
    can_continue: !1,
    pos: 0,
    str: "",
    marker: 0
  };
  if (o)
    a.str = o.str, a.marker = o.marker;
  else {
    if (i >= t) return a;
    let c = e.charCodeAt(i);
    if (c !== 34 && c !== 39 && c !== 40) return a;
    n++, i++, c === 40 && (c = 41), a.marker = c;
  }
  for (; i < t; ) {
    if (r = e.charCodeAt(i), r === a.marker)
      return a.pos = i + 1, a.str += ge(e.slice(n, i)), a.ok = !0, a;
    if (r === 40 && a.marker === 41) return a;
    r === 92 && i + 1 < t && i++, i++;
  }
  return a.can_continue = !0, a.str += ge(e.slice(n, i)), a;
}
var Cs = /* @__PURE__ */ Sr({
  parseLinkDestination: () => Rs,
  parseLinkLabel: () => ks,
  parseLinkTitle: () => xs
});
function Ae(e) {
  "@babel/helpers - typeof";
  return Ae = typeof Symbol == "function" && typeof Symbol.iterator == "symbol" ? function(n) {
    return typeof n;
  } : function(n) {
    return n && typeof Symbol == "function" && n.constructor === Symbol && n !== Symbol.prototype ? "symbol" : typeof n;
  }, Ae(e);
}
function Ts(e, n) {
  if (Ae(e) != "object" || !e) return e;
  var t = e[Symbol.toPrimitive];
  if (t !== void 0) {
    var o = t.call(e, n || "default");
    if (Ae(o) != "object") return o;
    throw new TypeError("@@toPrimitive must return a primitive value.");
  }
  return (n === "string" ? String : Number)(e);
}
function Ss(e) {
  var n = Ts(e, "string");
  return Ae(n) == "symbol" ? n : n + "";
}
function T(e, n, t) {
  return (n = Ss(n)) in e ? Object.defineProperty(e, n, {
    value: t,
    enumerable: !0,
    configurable: !0,
    writable: !0
  }) : e[n] = t, e;
}
var de = class {
  constructor(e, n, t) {
    T(
      this,
      /**
      * Source map info. Format: `[ line_begin, line_end ]`
      */
      "map",
      null
    ), T(
      this,
      /**
      * nesting level, the same as `state.level`
      */
      "level",
      0
    ), T(
      this,
      /**
      * An array of child nodes (inline and img tokens)
      */
      "children",
      null
    ), T(
      this,
      /**
      * In a case of self-closing tag (code, html, fence, etc.),
      * it has contents of this tag.
      */
      "content",
      ""
    ), T(
      this,
      /**
      * '*' or '_' for emphasis, fence string for fence, etc.
      */
      "markup",
      ""
    ), T(
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
    ), T(
      this,
      /**
      * True for block-level tokens, false for inline tokens.
      * Used in renderer to calculate line breaks
      */
      "block",
      !1
    ), T(
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
    for (let t = 0, o = n.length; t < o; t++) if (n[t][0] === e) return t;
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
    let t = this.attrIndex(e), o = [e, n];
    t < 0 ? this.attrPush(o) : this.attrs[t] = o;
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
    T(
      this,
      /** @internal */
      "__rules__",
      []
    ), T(
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
    let o = this.__find__(e);
    if (o === -1) throw new Error(`Parser rule not found: ${e}`);
    this.__rules__[o].fn = n, this.__rules__[o].alt = t.alt || [], this.__cache__ = null;
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
  before(e, n, t, o = {}) {
    let r = this.__find__(e);
    if (r === -1) throw new Error(`Parser rule not found: ${e}`);
    this.__rules__.splice(r, 0, {
      name: n,
      enabled: !0,
      fn: t,
      alt: o.alt || []
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
  after(e, n, t, o = {}) {
    let r = this.__find__(e);
    if (r === -1) throw new Error(`Parser rule not found: ${e}`);
    this.__rules__.splice(r + 1, 0, {
      name: n,
      enabled: !0,
      fn: t,
      alt: o.alt || []
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
    return e.forEach((o) => {
      let r = this.__find__(o);
      if (r < 0) {
        if (n) return;
        throw new Error(`Rules manager: invalid rule name ${o}`);
      }
      this.__rules__[r].enabled = !0, t.push(o);
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
    return e.forEach((o) => {
      let r = this.__find__(o);
      if (r < 0) {
        if (n) return;
        throw new Error(`Rules manager: invalid rule name ${o}`);
      }
      this.__rules__[r].enabled = !1, t.push(o);
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
}, Z = {};
Z.code_inline = function(e, n, t, o, r) {
  let i = e[n];
  return `<code${r.renderAttrs(i)}>${te(i.content)}</code>`;
};
Z.code_block = function(e, n, t, o, r) {
  let i = e[n];
  return `<pre${r.renderAttrs(i)}><code>${te(e[n].content)}</code></pre>
`;
};
Z.fence = function(e, n, t, o, r) {
  let i = e[n], a = i.info ? ge(i.info).trim() : "", c = "", d = "";
  if (a) {
    let g = a.split(/(\s+)/g);
    c = g[0], d = g.slice(2).join("");
  }
  let p;
  if (t.highlight ? p = t.highlight(i.content, c, d) || te(i.content) : p = te(i.content), p.indexOf("<pre") === 0) return p + `
`;
  if (a) {
    let g = i.attrIndex("class"), m = i.attrs ? i.attrs.slice() : [];
    g < 0 ? m.push(["class", `${t.langPrefix}${c}`]) : (m[g] = [m[g][0], m[g][1]], m[g][1] += ` ${t.langPrefix}${c}`);
    let y = { attrs: m };
    return `<pre><code${r.renderAttrs(y)}>${p}</code></pre>
`;
  }
  return `<pre><code${r.renderAttrs(i)}>${p}</code></pre>
`;
};
Z.image = function(e, n, t, o, r) {
  let i = e[n];
  return i.attrs[i.attrIndex("alt")][1] = r.renderInlineAsText(i.children, t, o), r.renderToken(e, n, t);
};
Z.hardbreak = function(e, n, t) {
  return t.xhtmlOut ? `<br />
` : `<br>
`;
};
Z.softbreak = function(e, n, t) {
  return t.breaks ? t.xhtmlOut ? `<br />
` : `<br>
` : `
`;
};
Z.text = function(e, n) {
  return te(e[n].content);
};
Z.html_block = function(e, n) {
  return e[n].content;
};
Z.html_inline = function(e, n) {
  return e[n].content;
};
var Ir = class {
  constructor() {
    T(
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
      Object.assign({}, Z)
    );
  }
  /**
  * Render token attributes to string.
  */
  renderAttrs(e) {
    let n, t, o;
    if (!e.attrs) return "";
    for (o = "", n = 0, t = e.attrs.length; n < t; n++) o += ` ${te(e.attrs[n][0])}="${te(String(e.attrs[n][1]))}"`;
    return o;
  }
  /**
  * Default token renderer. Can be overriden by custom function
  * in {@link Renderer.rules}.
  */
  renderToken(e, n, t) {
    let o = e[n], r = "";
    if (o.hidden) return "";
    let i = n - 1;
    for (; i >= 0 && e[i].hidden && e[i].nesting === 0; ) i--;
    o.block && o.nesting !== -1 && i >= 0 && e[i].hidden && e[i].nesting === -1 && (r += `
`), r += (o.nesting === -1 ? "</" : "<") + o.tag, r += this.renderAttrs(o), o.nesting === 0 && t.xhtmlOut && (r += " /");
    let a = !1;
    if (o.block && (a = !0, o.nesting === 1)) {
      let c = n + 1;
      for (; c < e.length && e[c].hidden && e[c].nesting === 0; ) c++;
      if (c < e.length) {
        let d = e[c];
        (d.type === "inline" || d.hidden || d.nesting === -1 && d.tag === o.tag) && (a = !1);
      }
    }
    return r += a ? `>
` : ">", r;
  }
  /**
  * The same as {@link Renderer.render}, but for single token of `inline` type.
  */
  renderInline(e, n, t) {
    let o = "", r = this.rules;
    for (let i = 0, a = e.length; i < a; i++) {
      let c = e[i].type;
      typeof r[c] < "u" ? o += r[c](e, i, n, t, this) : o += this.renderToken(e, i, n);
    }
    return o;
  }
  /**
  * Special kludge for image `alt` attributes to conform CommonMark spec.
  * Don't try to use it! Spec requires to show `alt` content with stripped markup,
  * instead of simple escaping.
  */
  renderInlineAsText(e, n, t) {
    let o = "";
    for (let r = 0, i = e.length; r < i; r++) switch (e[r].type) {
      case "text":
      case "code_inline":
        o += e[r].content;
        break;
      case "image":
        o += this.renderInlineAsText(e[r].children, n, t);
        break;
      case "html_inline":
      case "html_block":
        o += e[r].content;
        break;
      case "softbreak":
      case "hardbreak":
        o += `
`;
    }
    return o;
  }
  /**
  * Takes token stream and generates HTML. Probably, you will never need to call
  * this method directly.
  */
  render(e, n, t) {
    let o = "", r = this.rules;
    for (let i = 0, a = e.length; i < a; i++) {
      let c = e[i].type;
      c === "inline" ? o += this.renderInline(e[i].children, n, t) : typeof r[c] < "u" ? o += r[c](e, i, n, t, this) : o += this.renderToken(e, i, n);
    }
    return o;
  }
}, vr = class {
  constructor(e, n, t) {
    T(this, "tokens", []), T(this, "inlineMode", !1), T(this, "Token", de), this.src = e, this.env = t, this.md = n;
  }
}, Es = /\r\n?/g, _s = /\0/g;
function As(e) {
  let n;
  n = e.src.replace(Es, `
`), n = n.replace(_s, "\uFFFD"), e.src = n;
}
function Is(e) {
  let n;
  e.inlineMode ? (n = new e.Token("inline", "", 0), n.content = e.src, n.map = [0, 1], n.children = [], e.tokens.push(n)) : e.md.block.parse(e.src, e.md, e.env, e.tokens);
}
function vs(e) {
  let n = e.tokens, t = 0;
  for (let o = 0; o < n.length; o++)
    n[o].type !== "reference_definition" && (o !== t && (n[t] = n[o]), t++);
  n.length !== t && (n.length = t);
}
function Ms(e) {
  let n = e.tokens;
  for (let t = 0, o = n.length; t < o; t++) {
    let r = n[t];
    r.type === "inline" && e.md.inline.parse(r.content, e.md, e.env, r.children);
  }
}
function Ds(e) {
  return /^<a[>\s]/i.test(e);
}
function Ps(e) {
  return /^<\/a\s*>/i.test(e);
}
function Os(e) {
  let n = e.tokens;
  if (e.md.options.linkify)
    for (let t = 0, o = n.length; t < o; t++) {
      if (n[t].type !== "inline" || !e.md.linkify.test(n[t].content)) continue;
      let r = n[t].children, i = [], a = 0;
      for (let c = r.length - 1; c >= 0; c--) {
        let d = r[c];
        if (d.type === "link_close") {
          for (c--; r[c].level !== d.level && r[c].type !== "link_open"; ) c--;
          continue;
        }
        if (d.type === "html_inline" && (Ds(d.content) && a > 0 && a--, Ps(d.content) && a++), !(a > 0) && d.type === "text" && e.md.linkify.test(d.content)) {
          let p = d.content, g = e.md.linkify.match(p), m = [], y = d.level, l = 0;
          g.length > 0 && g[0].index === 0 && c > 0 && r[c - 1].type === "text_special" && (g = g.slice(1));
          for (let u = 0; u < g.length; u++) {
            let h = g[u].url, f = e.md.normalizeLink(h);
            if (!e.md.validateLink(f)) continue;
            let b = g[u].text;
            g[u].schema ? g[u].schema === "mailto:" && !/^mailto:/i.test(b) ? b = e.md.normalizeLinkText(`mailto:${b}`).replace(/^mailto:/, "") : b = e.md.normalizeLinkText(b) : b = e.md.normalizeLinkText(`http://${b}`).replace(/^http:\/\//, "");
            let w = g[u].index;
            if (w > l) {
              let C = new e.Token("text", "", 0);
              C.content = p.slice(l, w), C.level = y, m.push(C);
            }
            let R = new e.Token("link_open", "a", 1);
            R.attrs = [["href", f]], R.level = y++, R.markup = "linkify", R.info = "auto", m.push(R);
            let k = new e.Token("text", "", 0);
            k.content = b, k.level = y, m.push(k);
            let x = new e.Token("link_close", "a", -1);
            x.level = --y, x.markup = "linkify", x.info = "auto", m.push(x), l = g[u].lastIndex;
          }
          if (l < p.length) {
            let u = new e.Token("text", "", 0);
            u.content = p.slice(l), u.level = y, m.push(u);
          }
          i.push({
            index: c,
            nodes: m
          });
        }
      }
      if (i.length > 0) {
        let c = r.length;
        for (let m of i) c += m.nodes.length - 1;
        let d = new Array(c), p = 0, g = 0;
        i.reverse();
        for (let m = 0; m < r.length; m++) {
          let y = i[p];
          if (y?.index === m) {
            for (let l of y.nodes) d[g++] = l;
            p++;
          } else d[g++] = r[m];
        }
        n[t].children = d;
      }
    }
}
var Mr = /\+-|\.\.|\?\?\?\?|!!!!|,,|--/, Ns = /\((c|tm|r)\)/i, Fs = /\((c|tm|r)\)/gi, Ls = {
  c: "\xA9",
  r: "\xAE",
  tm: "\u2122"
};
function Us(e, n) {
  return Ls[n.toLowerCase()];
}
function Bs(e) {
  let n = 0;
  for (let t = e.length - 1; t >= 0; t--) {
    let o = e[t];
    o.type === "text" && !n && (o.content = o.content.replace(Fs, Us)), o.type === "link_open" && o.info === "auto" && n--, o.type === "link_close" && o.info === "auto" && n++;
  }
}
function js(e) {
  let n = 0;
  for (let t = e.length - 1; t >= 0; t--) {
    let o = e[t];
    o.type === "text" && !n && Mr.test(o.content) && (o.content = o.content.replace(/\+-/g, "\xB1").replace(/\.{2,}/g, "\u2026").replace(/([?!])…/g, "$1..").replace(/([?!]){4,}/g, "$1$1$1").replace(/,{2,}/g, ",").replace(/(^|[^-])---(?=[^-]|$)/gm, "$1\u2014").replace(/(^|\s)--(?=\s|$)/gm, "$1\u2013").replace(/(^|[^-\s])--(?=[^-\s]|$)/gm, "$1\u2013")), o.type === "link_open" && o.info === "auto" && n--, o.type === "link_close" && o.info === "auto" && n++;
  }
}
function Gs(e) {
  let n;
  if (e.md.options.typographer)
    for (n = e.tokens.length - 1; n >= 0; n--)
      e.tokens[n].type === "inline" && (Ns.test(e.tokens[n].content) && Bs(e.tokens[n].children), Mr.test(e.tokens[n].content) && js(e.tokens[n].children));
}
var qs = /['"]/, gr = /['"]/g, mr = "\u2019", Ws = 1e3;
function yr(e, n, t) {
  for (; e.length > t; ) {
    let o = e.pop();
    o.isSingleQuote ? n.single = o.prevSameQuoteIdx : n.double = o.prevSameQuoteIdx;
  }
}
function qe(e, n, t, o) {
  e[n] || (e[n] = []), e[n].push({
    pos: t,
    ch: o
  });
}
function zs(e, n) {
  let t = "", o = 0;
  n.sort((r, i) => r.pos - i.pos);
  for (let r = 0; r < n.length; r++) {
    let i = n[r];
    t += e.slice(o, i.pos) + i.ch, o = i.pos + 1;
  }
  return t + e.slice(o);
}
function Hs(e, n) {
  let t, o = [], r = {
    single: -1,
    double: -1
  }, i = {};
  for (let a = 0; a < e.length; a++) {
    let c = e[a], d = e[a].level;
    for (t = o.length - 1; t >= 0 && !(o[t].level <= d); t--) ;
    if (yr(o, r, t + 1), c.type !== "text") continue;
    let p = c.content, g = 0, m = p.length;
    e: for (; g < m; ) {
      gr.lastIndex = g;
      let y = gr.exec(p);
      if (!y) break;
      let l = !0, u = !0;
      g = y.index + 1;
      let h = y[0] === "'", f = 32;
      if (y.index - 1 >= 0) f = p.charCodeAt(y.index - 1);
      else for (t = a - 1; t >= 0 && !(e[t].type === "softbreak" || e[t].type === "hardbreak"); t--)
        if (e[t].content) {
          f = e[t].content.charCodeAt(e[t].content.length - 1);
          break;
        }
      let b = 32;
      if (g < m) b = p.charCodeAt(g);
      else for (t = a + 1; t < e.length && !(e[t].type === "softbreak" || e[t].type === "hardbreak"); t++)
        if (e[t].content) {
          b = e[t].content.charCodeAt(0);
          break;
        }
      let w = _e(f) || Ee(f), R = _e(b) || Ee(b), k = Se(f), x = Se(b);
      if (x ? l = !1 : R && (k || w || (l = !1)), k ? u = !1 : w && (x || R || (u = !1)), b === 34 && y[0] === '"' && f >= 48 && f <= 57 && (u = l = !1), l && u && (l = w, u = R), !l && !u) {
        h && qe(i, a, y.index, mr);
        continue;
      }
      if (u && (t = h ? r.single : r.double, t >= 0 && o[t].level === d)) {
        let C = o[t], M, v;
        h ? (M = n.md.options.quotes[2], v = n.md.options.quotes[3]) : (M = n.md.options.quotes[0], v = n.md.options.quotes[1]), qe(i, a, y.index, v), qe(i, C.tokenIdx, C.contentPos, M), yr(o, r, t);
        continue e;
      }
      if (l) {
        if (o.length >= Ws) return;
        o.push({
          tokenIdx: a,
          contentPos: y.index,
          isSingleQuote: h,
          level: d,
          prevSameQuoteIdx: h ? r.single : r.double
        }), h ? r.single = o.length - 1 : r.double = o.length - 1;
      } else u && h && qe(i, a, y.index, mr);
    }
  }
  Object.keys(i).forEach(function(a) {
    let c = Number(a);
    e[c].content = zs(e[c].content, i[a]);
  });
}
function $s(e) {
  if (e.md.options.typographer)
    for (let n = e.tokens.length - 1; n >= 0; n--)
      e.tokens[n].type !== "inline" || !qs.test(e.tokens[n].content) || Hs(e.tokens[n].children, e);
}
function Vs(e) {
  let n, t, o = e.length;
  for (n = 0; n < o; n++) e[n].type === "text_special" && (e[n].type = "text");
  for (n = t = 0; n < o; n++) e[n].type === "text" && n + 1 < o && e[n + 1].type === "text" ? e[n + 1].content = e[n].content + e[n + 1].content : (n !== t && (e[t] = e[n]), t++);
  n !== t && (e.length = t);
}
function Ks(e) {
  let n, t, o = e.tokens, r = o.length;
  for (let i = 0; i < r; i++) {
    if (o[i].type !== "inline") continue;
    let a = o[i].children, c = a.length;
    for (n = 0; n < c; n++)
      a[n].type === "text_special" && (a[n].type = "text"), a[n].children && Vs(a[n].children);
    for (n = t = 0; n < c; n++) a[n].type === "text" && n + 1 < c && a[n + 1].type === "text" ? a[n + 1].content = a[n].content + a[n + 1].content : (n !== t && (a[t] = a[n]), t++);
    n !== t && (a.length = t);
  }
}
var bn = [
  ["normalize", As],
  ["block", Is],
  ["strip_references", vs],
  ["inline", Ms],
  ["linkify", Os],
  ["replacements", Gs],
  ["smartquotes", $s],
  ["text_join", Ks]
], Dr = class {
  constructor() {
    T(
      this,
      /**
      * {@link Ruler} instance. Keep configuration of core rules.
      */
      "ruler",
      new Ie()
    ), T(this, "State", vr);
    for (let e = 0; e < bn.length; e++) this.ruler.push(bn[e][0], bn[e][1]);
  }
  /**
  * Executes core chain rules.
  */
  process(e) {
    let n = this.ruler.getRules("");
    for (let t = 0, o = n.length; t < o; t++) n[t](e);
  }
}, Pr = class {
  constructor(e, n, t, o) {
    T(this, "bMarks", []), T(this, "eMarks", []), T(this, "tShift", []), T(this, "sCount", []), T(this, "bsCount", []), T(this, "blkIndent", 0), T(this, "line", 0), T(this, "lineMax", 0), T(this, "tight", !1), T(this, "listIndent", -1), T(this, "parentType", "root"), T(this, "level", 0), T(this, "Token", de), this.src = e, this.md = n, this.env = t, this.tokens = o;
    let r = this.src;
    for (let i = 0, a = 0, c = 0, d = 0, p = r.length, g = !1; a < p; a++) {
      let m = r.charCodeAt(a);
      if (!g) if (F(m)) {
        c++, m === 9 ? d += 4 - d % 4 : d++;
        continue;
      } else g = !0;
      (m === 10 || a === p - 1) && (m !== 10 && a++, this.bMarks.push(i), this.eMarks.push(a), this.tShift.push(c), this.sCount.push(d), this.bsCount.push(0), g = !1, c = 0, d = 0, i = a + 1);
    }
    this.bMarks.push(r.length), this.eMarks.push(r.length), this.tShift.push(0), this.sCount.push(0), this.bsCount.push(0), this.lineMax = this.bMarks.length - 1;
  }
  push(e, n, t) {
    let o = new de(e, n, t);
    return o.block = !0, t < 0 && this.level--, o.level = this.level, t > 0 && this.level++, this.tokens.push(o), o;
  }
  isEmpty(e) {
    return this.bMarks[e] + this.tShift[e] >= this.eMarks[e];
  }
  skipEmptyLines(e) {
    for (let n = this.lineMax; e < n && !(this.bMarks[e] + this.tShift[e] < this.eMarks[e]); e++) ;
    return e;
  }
  skipSpaces(e) {
    for (let n = this.src.length; e < n && F(this.src.charCodeAt(e)); e++) ;
    return e;
  }
  skipSpacesBack(e, n) {
    if (e <= n) return e;
    for (; e > n; ) if (!F(this.src.charCodeAt(--e))) return e + 1;
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
  getLines(e, n, t, o) {
    if (e >= n) return "";
    let r = new Array(n - e);
    for (let i = 0, a = e; a < n; a++, i++) {
      let c = 0, d = this.bMarks[a], p = d, g;
      for (a + 1 < n || o ? g = this.eMarks[a] + 1 : g = this.eMarks[a]; p < g && c < t; ) {
        let m = this.src.charCodeAt(p);
        if (F(m)) m === 9 ? c += 4 - (c + this.bsCount[a]) % 4 : c++;
        else if (p - d < this.tShift[a]) c++;
        else break;
        p++;
      }
      c > t ? r[i] = new Array(c - t + 1).join(" ") + this.src.slice(p, g) : r[i] = this.src.slice(p, g);
    }
    return r.join("");
  }
}, Js = 65536;
function wn(e, n) {
  let t = e.bMarks[n] + e.tShift[n], o = e.eMarks[n];
  return e.src.slice(t, o);
}
function br(e) {
  let n = [], t = e.length, o = 0, r = e.charCodeAt(o), i = !1, a = 0, c = "";
  for (; o < t; )
    r === 124 && (i ? (c += e.substring(a, o - 1), a = o) : (n.push(c + e.substring(a, o)), c = "", a = o + 1)), i = r === 92, o++, r = e.charCodeAt(o);
  return n.push(c + e.substring(a)), n;
}
function Ys(e, n, t, o) {
  if (n + 2 > t) return !1;
  let r = n + 1;
  if (e.sCount[r] < e.blkIndent || e.sCount[r] - e.blkIndent >= 4) return !1;
  let i = e.bMarks[r] + e.tShift[r];
  if (i >= e.eMarks[r]) return !1;
  let a = e.src.charCodeAt(i++);
  if (a !== 124 && a !== 45 && a !== 58 || i >= e.eMarks[r]) return !1;
  let c = e.src.charCodeAt(i++);
  if (c !== 124 && c !== 45 && c !== 58 && !F(c) || a === 45 && F(c)) return !1;
  for (; i < e.eMarks[r]; ) {
    let k = e.src.charCodeAt(i);
    if (k !== 124 && k !== 45 && k !== 58 && !F(k)) return !1;
    i++;
  }
  let d = wn(e, n + 1), p = d.split("|"), g = [];
  for (let k = 0; k < p.length; k++) {
    let x = p[k].trim();
    if (!x) {
      if (k === 0 || k === p.length - 1) continue;
      return !1;
    }
    if (!/^:?-+:?$/.test(x)) return !1;
    x.charCodeAt(x.length - 1) === 58 ? g.push(x.charCodeAt(0) === 58 ? "center" : "right") : x.charCodeAt(0) === 58 ? g.push("left") : g.push("");
  }
  if (d = wn(e, n).trim(), d.indexOf("|") === -1 || e.sCount[n] - e.blkIndent >= 4) return !1;
  p = br(d), p.length && p[0] === "" && p.shift(), p.length && p[p.length - 1] === "" && p.pop();
  let m = p.length;
  if (m === 0 || m !== g.length) return !1;
  if (o) return !0;
  let y = e.parentType;
  e.parentType = "table";
  let l = e.md.block.ruler.getRules("blockquote"), u = e.push("table_open", "table", 1), h = [n, 0];
  u.map = h;
  let f = e.push("thead_open", "thead", 1);
  f.map = [n, n + 1];
  let b = e.push("tr_open", "tr", 1);
  b.map = [n, n + 1];
  for (let k = 0; k < p.length; k++) {
    let x = e.push("th_open", "th", 1);
    g[k] && (x.attrs = [["style", `text-align:${g[k]}`]]);
    let C = e.push("inline", "", 0);
    C.content = p[k].trim(), C.children = [], e.push("th_close", "th", -1);
  }
  e.push("tr_close", "tr", -1), e.push("thead_close", "thead", -1);
  let w, R = 0;
  for (r = n + 2; r < t && !(e.sCount[r] < e.blkIndent); r++) {
    let k = !1;
    for (let C = 0, M = l.length; C < M; C++) if (l[C](e, r, t, !0)) {
      k = !0;
      break;
    }
    if (k || (d = wn(e, r).trim(), !d) || e.sCount[r] - e.blkIndent >= 4 || (p = br(d), p.length && p[0] === "" && p.shift(), p.length && p[p.length - 1] === "" && p.pop(), R += m - p.length, R > Js)) break;
    if (r === n + 2) {
      let C = e.push("tbody_open", "tbody", 1);
      C.map = w = [n + 2, 0];
    }
    let x = e.push("tr_open", "tr", 1);
    x.map = [r, r + 1];
    for (let C = 0; C < m; C++) {
      let M = e.push("td_open", "td", 1);
      g[C] && (M.attrs = [["style", `text-align:${g[C]}`]]);
      let v = e.push("inline", "", 0);
      v.content = p[C] ? p[C].trim() : "", v.children = [], e.push("td_close", "td", -1);
    }
    e.push("tr_close", "tr", -1);
  }
  return w && (e.push("tbody_close", "tbody", -1), w[1] = r), e.push("table_close", "table", -1), h[1] = r, e.parentType = y, e.line = r, !0;
}
function Xs(e, n, t) {
  if (e.sCount[n] - e.blkIndent < 4) return !1;
  let o = n + 1, r = o;
  for (; o < t; ) {
    if (e.isEmpty(o)) {
      o++;
      continue;
    }
    if (e.sCount[o] - e.blkIndent >= 4) {
      o++, r = o;
      continue;
    }
    break;
  }
  e.line = r;
  let i = e.push("code_block", "code", 0);
  return i.content = e.getLines(n, r, 4 + e.blkIndent, !1) + `
`, i.map = [n, e.line], !0;
}
function Zs(e, n, t, o) {
  let r = e.bMarks[n] + e.tShift[n], i = e.eMarks[n];
  if (e.sCount[n] - e.blkIndent >= 4 || r + 3 > i) return !1;
  let a = e.src.charCodeAt(r);
  if (a !== 126 && a !== 96) return !1;
  let c = r;
  r = e.skipChars(r, a);
  let d = r - c;
  if (d < 3) return !1;
  let p = e.src.slice(c, r), g = e.src.slice(r, i);
  if (a === 96 && g.indexOf(String.fromCharCode(a)) >= 0)
    return !1;
  if (o) return !0;
  let m = n, y = !1;
  for (; m++, !(m >= t || (r = c = e.bMarks[m] + e.tShift[m], i = e.eMarks[m], r < i && e.sCount[m] < e.blkIndent)); )
    if (e.src.charCodeAt(r) === a && !(e.sCount[m] - e.blkIndent >= 4) && (r = e.skipChars(r, a), !(r - c < d) && (r = e.skipSpaces(r), !(r < i)))) {
      y = !0;
      break;
    }
  d = e.sCount[n], e.line = m + (y ? 1 : 0);
  let l = e.push("fence", "code", 0);
  return l.info = g, l.content = e.getLines(n + 1, m, d, !0), l.markup = p, l.map = [n, e.line], !0;
}
function Qs(e, n, t, o) {
  let r = e.bMarks[n] + e.tShift[n], i = e.eMarks[n], a = e.lineMax;
  if (e.sCount[n] - e.blkIndent >= 4 || e.src.charCodeAt(r) !== 62) return !1;
  if (o) return !0;
  let c = [], d = [], p = [], g = [], m = e.md.block.ruler.getRules("blockquote"), y = e.parentType;
  e.parentType = "blockquote";
  let l = !1, u;
  for (u = n; u < t; u++) {
    let R = e.sCount[u] < e.blkIndent;
    if (r = e.bMarks[u] + e.tShift[u], i = e.eMarks[u], r >= i) break;
    if (e.src.charCodeAt(r++) === 62 && !R) {
      let x = e.sCount[u] + 1, C, M;
      e.src.charCodeAt(r) === 32 ? (r++, x++, M = !1, C = !0) : e.src.charCodeAt(r) === 9 ? (C = !0, (e.bsCount[u] + x) % 4 === 3 ? (r++, x++, M = !1) : M = !0) : C = !1;
      let v = x;
      for (c.push(e.bMarks[u]), e.bMarks[u] = r; r < i; ) {
        let S = e.src.charCodeAt(r);
        if (F(S)) S === 9 ? v += 4 - (v + e.bsCount[u] + (M ? 1 : 0)) % 4 : v++;
        else break;
        r++;
      }
      l = r >= i, d.push(e.bsCount[u]), e.bsCount[u] = e.sCount[u] + 1 + (C ? 1 : 0), p.push(e.sCount[u]), e.sCount[u] = v - x, g.push(e.tShift[u]), e.tShift[u] = r - e.bMarks[u];
      continue;
    }
    if (l) break;
    let k = !1;
    for (let x = 0, C = m.length; x < C; x++) if (m[x](e, u, t, !0)) {
      k = !0;
      break;
    }
    if (k) {
      e.lineMax = u, e.blkIndent !== 0 && (c.push(e.bMarks[u]), d.push(e.bsCount[u]), g.push(e.tShift[u]), p.push(e.sCount[u]), e.sCount[u] -= e.blkIndent);
      break;
    }
    c.push(e.bMarks[u]), d.push(e.bsCount[u]), g.push(e.tShift[u]), p.push(e.sCount[u]), e.sCount[u] = -1;
  }
  let h = e.blkIndent;
  e.blkIndent = 0;
  let f = e.push("blockquote_open", "blockquote", 1);
  f.markup = ">";
  let b = [n, 0];
  f.map = b, e.md.block.tokenize(e, n, u);
  let w = e.push("blockquote_close", "blockquote", -1);
  w.markup = ">", e.lineMax = a, e.parentType = y, b[1] = e.line;
  for (let R = 0; R < g.length; R++)
    e.bMarks[R + n] = c[R], e.tShift[R + n] = g[R], e.sCount[R + n] = p[R], e.bsCount[R + n] = d[R];
  return e.blkIndent = h, !0;
}
function ea(e, n, t, o) {
  let r = e.eMarks[n];
  if (e.sCount[n] - e.blkIndent >= 4) return !1;
  let i = e.bMarks[n] + e.tShift[n], a = e.src.charCodeAt(i++);
  if (a !== 42 && a !== 45 && a !== 95) return !1;
  let c = 1;
  for (; i < r; ) {
    let p = e.src.charCodeAt(i++);
    if (p !== a && !F(p)) return !1;
    p === a && c++;
  }
  if (c < 3) return !1;
  if (o) return !0;
  e.line = n + 1;
  let d = e.push("hr", "hr", 0);
  return d.map = [n, e.line], d.markup = Array(c + 1).join(String.fromCharCode(a)), !0;
}
function wr(e, n) {
  let t = e.eMarks[n], o = e.bMarks[n] + e.tShift[n], r = e.src.charCodeAt(o++);
  return r !== 42 && r !== 45 && r !== 43 || o < t && !F(e.src.charCodeAt(o)) ? -1 : o;
}
function kr(e, n) {
  let t = e.bMarks[n] + e.tShift[n], o = e.eMarks[n], r = t;
  if (r + 1 >= o) return -1;
  let i = e.src.charCodeAt(r++);
  if (i < 48 || i > 57) return -1;
  for (; ; ) {
    if (r >= o) return -1;
    if (i = e.src.charCodeAt(r++), i >= 48 && i <= 57) {
      if (r - t >= 10) return -1;
      continue;
    }
    if (i === 41 || i === 46) break;
    return -1;
  }
  return r < o && (i = e.src.charCodeAt(r), !F(i)) ? -1 : r;
}
function na(e, n) {
  let t = e.level + 2;
  for (let o = n + 2, r = e.tokens.length - 2; o < r; o++) e.tokens[o].level === t && e.tokens[o].type === "paragraph_open" && (e.tokens[o + 2].hidden = !0, e.tokens[o].hidden = !0, o += 2);
}
function ta(e, n, t, o) {
  let r, i, a, c, d = n, p = !0;
  if (e.sCount[d] - e.blkIndent >= 4 || e.listIndent >= 0 && e.sCount[d] - e.listIndent >= 4 && e.sCount[d] < e.blkIndent) return !1;
  let g = !1;
  o && e.parentType === "paragraph" && e.sCount[d] >= e.blkIndent && (g = !0);
  let m, y, l;
  if ((l = kr(e, d)) >= 0) {
    if (m = !0, a = e.bMarks[d] + e.tShift[d], y = Number(e.src.slice(a, l - 1)), g && y !== 1) return !1;
  } else if ((l = wr(e, d)) >= 0) m = !1;
  else return !1;
  if (g && e.skipSpaces(l) >= e.eMarks[d])
    return !1;
  if (o) return !0;
  let u = e.src.charCodeAt(l - 1), h = e.tokens.length;
  m ? (c = e.push("ordered_list_open", "ol", 1), y !== 1 && (c.attrs = [["start", y]])) : c = e.push("bullet_list_open", "ul", 1);
  let f = [d, 0];
  c.map = f, c.markup = String.fromCharCode(u);
  let b = !1, w = e.md.block.ruler.getRules("list"), R = e.parentType;
  for (e.parentType = "list"; d < t; ) {
    i = l, r = e.eMarks[d];
    let k = e.sCount[d] + l - (e.bMarks[d] + e.tShift[d]), x = k;
    for (; i < r; ) {
      let $ = e.src.charCodeAt(i);
      if ($ === 9) x += 4 - (x + e.bsCount[d]) % 4;
      else if ($ === 32) x++;
      else break;
      i++;
    }
    let C = i, M;
    C >= r ? M = 1 : M = x - k, M > 4 && (M = 1);
    let v = k + M;
    c = e.push("list_item_open", "li", 1), c.markup = String.fromCharCode(u);
    let S = [d, 0];
    c.map = S, m && (c.info = e.src.slice(a, l - 1));
    let O = e.tight, I = e.tShift[d], A = e.sCount[d], G = e.listIndent;
    if (e.listIndent = e.blkIndent, e.blkIndent = v, e.tight = !0, e.tShift[d] = C - e.bMarks[d], e.sCount[d] = x, C >= r && e.isEmpty(d + 1) ? e.line = Math.min(e.line + 2, t) : e.md.block.tokenize(e, d, t), (!e.tight || b) && (p = !1), b = e.line - d > 1 && e.isEmpty(e.line - 1), e.blkIndent = e.listIndent, e.listIndent = G, e.tShift[d] = I, e.sCount[d] = A, e.tight = O, c = e.push("list_item_close", "li", -1), c.markup = String.fromCharCode(u), d = e.line, S[1] = d, d >= t || e.sCount[d] < e.blkIndent || e.sCount[d] - e.blkIndent >= 4) break;
    let H = !1;
    for (let $ = 0, Ve = w.length; $ < Ve; $++) if (w[$](e, d, t, !0)) {
      H = !0;
      break;
    }
    if (H) break;
    if (m) {
      if (l = kr(e, d), l < 0) break;
      a = e.bMarks[d] + e.tShift[d];
    } else if (l = wr(e, d), l < 0) break;
    if (u !== e.src.charCodeAt(l - 1)) break;
  }
  return m ? c = e.push("ordered_list_close", "ol", -1) : c = e.push("bullet_list_close", "ul", -1), c.markup = String.fromCharCode(u), f[1] = d, e.line = d, e.parentType = R, p && na(e, h), !0;
}
function ra(e, n, t, o) {
  let r = e.bMarks[n] + e.tShift[n], i = e.eMarks[n], a = n + 1;
  if (e.sCount[n] - e.blkIndent >= 4 || e.src.charCodeAt(r) !== 91) return !1;
  function c(k) {
    let x = e.lineMax;
    if (k >= x || e.isEmpty(k)) return null;
    let C = !1;
    if (e.sCount[k] - e.blkIndent > 3 && (C = !0), e.sCount[k] < 0 && (C = !0), !C) {
      let S = e.md.block.ruler.getRules("reference"), O = e.parentType;
      e.parentType = "reference";
      let I = !1;
      for (let A = 0, G = S.length; A < G; A++) if (S[A](e, k, x, !0)) {
        I = !0;
        break;
      }
      if (e.parentType = O, I) return null;
    }
    let M = e.bMarks[k] + e.tShift[k], v = e.eMarks[k];
    return e.src.slice(M, v + 1);
  }
  let d = e.src.slice(r, i + 1);
  i = d.length;
  let p = -1;
  for (r = 1; r < i; r++) {
    let k = d.charCodeAt(r);
    if (k === 91) return !1;
    if (k === 93) {
      p = r;
      break;
    } else if (k === 10) {
      let x = c(a);
      x !== null && (d += x, i = d.length, a++);
    } else if (k === 92 && (r++, r < i && d.charCodeAt(r) === 10)) {
      let x = c(a);
      x !== null && (d += x, i = d.length, a++);
    }
  }
  if (p < 0 || d.charCodeAt(p + 1) !== 58) return !1;
  for (r = p + 2; r < i; r++) {
    let k = d.charCodeAt(r);
    if (k === 10) {
      let x = c(a);
      x !== null && (d += x, i = d.length, a++);
    } else if (!F(k))
      break;
  }
  let g = e.md.helpers.parseLinkDestination(d, r, i);
  if (!g.ok) return !1;
  let m = e.md.normalizeLink(g.str);
  if (!e.md.validateLink(m)) return !1;
  r = g.pos;
  let y = r, l = a, u = r;
  for (; r < i; r++) {
    let k = d.charCodeAt(r);
    if (k === 10) {
      let x = c(a);
      x !== null && (d += x, i = d.length, a++);
    } else if (!F(k))
      break;
  }
  let h = e.md.helpers.parseLinkTitle(d, r, i);
  for (; h.can_continue; ) {
    let k = c(a);
    if (k === null) break;
    d += k, r = i, i = d.length, a++, h = e.md.helpers.parseLinkTitle(d, r, i, h);
  }
  let f;
  for (r < i && u !== r && h.ok ? (f = h.str, r = h.pos) : (f = "", r = y, a = l); r < i && F(d.charCodeAt(r)); )
    r++;
  if (r < i && d.charCodeAt(r) !== 10 && f)
    for (f = "", r = y, a = l; r < i && F(d.charCodeAt(r)); )
      r++;
  if (r < i && d.charCodeAt(r) !== 10) return !1;
  let b = ze(d.slice(1, p));
  if (!b) return !1;
  if (o) return !0;
  typeof e.env.references > "u" && (e.env.references = {}), typeof e.env.references[b] > "u" && (e.env.references[b] = {
    title: f,
    href: m
  });
  let w = e.push("reference_definition", "", 0);
  w.map = [n, a], w.hidden = !0;
  let R = /* @__PURE__ */ Object.create(null);
  return R.label = b, w.meta = R, e.line = a, !0;
}
var oa = [
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
], Or = `<[A-Za-z][A-Za-z0-9\\-]*(?:\\s+[a-zA-Z_:][a-zA-Z0-9:._-]*(?:\\s*=\\s*(?:[^"'=<>\`\\x00-\\x20]+|'[^']*'|"[^"]*"))?)*\\s*\\/?>`, Nr = "<\\/[A-Za-z][A-Za-z0-9\\-]*\\s*>", ia = new RegExp(`^(?:${Or}|${Nr}|<!---?>|<!--(?:[^-]|-[^-]|--[^>])*-->|<[?][\\s\\S]*?[?]>|<![A-Za-z][^>]*>|<!\\[CDATA\\[[\\s\\S]*?\\]\\]>)`), sa = new RegExp(`^(?:${Or}|${Nr})`), ue = [
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
    new RegExp(`^</?(${oa.join("|")})(?=(\\s|/?>|$))`, "i"),
    /^$/,
    !0
  ],
  [
    new RegExp(`${sa.source}\\s*$`),
    /^$/,
    !1
  ]
];
function aa(e, n, t, o) {
  let r = e.bMarks[n] + e.tShift[n], i = e.eMarks[n];
  if (e.sCount[n] - e.blkIndent >= 4 || !e.md.options.html || e.src.charCodeAt(r) !== 60) return !1;
  let a = e.src.slice(r, i), c = 0;
  for (; c < ue.length && !ue[c][0].test(a); c++) ;
  if (c === ue.length) return !1;
  if (o) return ue[c][2];
  let d = n + 1, p = ue[c][1].test("");
  if (!ue[c][1].test(a)) {
    for (; d < t && !(e.sCount[d] < e.blkIndent && (p || !e.isEmpty(d))); d++)
      if (r = e.bMarks[d] + e.tShift[d], i = e.eMarks[d], a = e.src.slice(r, i), ue[c][1].test(a)) {
        a.length !== 0 && d++;
        break;
      }
  }
  e.line = d;
  let g = e.push("html_block", "", 0);
  return g.map = [n, d], g.content = e.getLines(n, d, e.blkIndent, !0), !0;
}
function ca(e, n, t, o) {
  let r = e.bMarks[n] + e.tShift[n], i = e.eMarks[n];
  if (e.sCount[n] - e.blkIndent >= 4) return !1;
  let a = e.src.charCodeAt(r);
  if (a !== 35 || r >= i) return !1;
  let c = 1;
  for (a = e.src.charCodeAt(++r); a === 35 && r < i && c <= 6; )
    c++, a = e.src.charCodeAt(++r);
  if (c > 6 || r < i && !F(a)) return !1;
  if (o) return !0;
  i = e.skipSpacesBack(i, r);
  let d = e.skipCharsBack(i, 35, r);
  d > r && F(e.src.charCodeAt(d - 1)) && (i = d), e.line = n + 1;
  let p = e.push("heading_open", `h${c}`, 1);
  p.markup = "########".slice(0, c), p.map = [n, e.line];
  let g = e.push("inline", "", 0);
  g.content = He(e.src.slice(r, i)), g.map = [n, e.line], g.children = [];
  let m = e.push("heading_close", `h${c}`, -1);
  return m.markup = "########".slice(0, c), !0;
}
function la(e, n, t) {
  let o = e.md.block.ruler.getRules("paragraph");
  if (e.sCount[n] - e.blkIndent >= 4) return !1;
  let r = e.parentType;
  e.parentType = "paragraph";
  let i = 0, a, c = n + 1;
  for (; c < t && !e.isEmpty(c); c++) {
    if (e.sCount[c] - e.blkIndent > 3) continue;
    if (e.sCount[c] >= e.blkIndent) {
      let l = e.bMarks[c] + e.tShift[c], u = e.eMarks[c];
      if (l < u && (a = e.src.charCodeAt(l), (a === 45 || a === 61) && (l = e.skipChars(l, a), l = e.skipSpaces(l), l >= u))) {
        i = a === 61 ? 1 : 2;
        break;
      }
    }
    if (e.sCount[c] < 0) continue;
    let y = !1;
    for (let l = 0, u = o.length; l < u; l++) if (o[l](e, c, t, !0)) {
      y = !0;
      break;
    }
    if (y) break;
  }
  if (!i)
    return e.parentType = r, !1;
  let d = He(e.getLines(n, c, e.blkIndent, !1));
  e.line = c + 1;
  let p = e.push("heading_open", `h${i}`, 1);
  p.markup = String.fromCharCode(a), p.map = [n, e.line];
  let g = e.push("inline", "", 0);
  g.content = d, g.map = [n, e.line - 1], g.children = [];
  let m = e.push("heading_close", `h${i}`, -1);
  return m.markup = String.fromCharCode(a), e.parentType = r, !0;
}
function ua(e, n, t) {
  let o = e.md.block.ruler.getRules("paragraph"), r = e.parentType, i = n + 1;
  for (e.parentType = "paragraph"; i < t && !e.isEmpty(i); i++) {
    if (e.sCount[i] - e.blkIndent > 3 || e.sCount[i] < 0) continue;
    let p = !1;
    for (let g = 0, m = o.length; g < m; g++) if (o[g](e, i, t, !0)) {
      p = !0;
      break;
    }
    if (p) break;
  }
  let a = He(e.getLines(n, i, e.blkIndent, !1));
  e.line = i;
  let c = e.push("paragraph_open", "p", 1);
  c.map = [n, e.line];
  let d = e.push("inline", "", 0);
  return d.content = a, d.map = [n, e.line], d.children = [], e.push("paragraph_close", "p", -1), e.parentType = r, !0;
}
var We = [
  [
    "table",
    Ys,
    ["paragraph", "reference"]
  ],
  ["code", Xs],
  [
    "fence",
    Zs,
    [
      "paragraph",
      "reference",
      "blockquote",
      "list"
    ]
  ],
  [
    "blockquote",
    Qs,
    [
      "paragraph",
      "reference",
      "blockquote",
      "list"
    ]
  ],
  [
    "hr",
    ea,
    [
      "paragraph",
      "reference",
      "blockquote",
      "list"
    ]
  ],
  [
    "list",
    ta,
    [
      "paragraph",
      "reference",
      "blockquote"
    ]
  ],
  ["reference", ra],
  [
    "html_block",
    aa,
    [
      "paragraph",
      "reference",
      "blockquote"
    ]
  ],
  [
    "heading",
    ca,
    [
      "paragraph",
      "reference",
      "blockquote"
    ]
  ],
  ["lheading", la],
  ["paragraph", ua]
], Fr = class {
  constructor() {
    T(
      this,
      /**
      * {@link Ruler} instance. Keep configuration of block rules.
      */
      "ruler",
      new Ie()
    ), T(this, "State", Pr);
    for (let e = 0; e < We.length; e++) this.ruler.push(We[e][0], We[e][1], { alt: (We[e][2] || []).slice() });
  }
  tokenize(e, n, t) {
    let o = this.ruler.getRules(""), r = o.length, i = e.md.options.maxNesting, a = n, c = !1;
    for (; a < t && (e.line = a = e.skipEmptyLines(a), !(a >= t || e.sCount[a] < e.blkIndent)); ) {
      if (e.level >= i) {
        e.line = t;
        break;
      }
      let d = e.line, p = !1;
      for (let g = 0; g < r; g++)
        if (p = o[g](e, a, t, !1), p) {
          if (d >= e.line) throw new Error("block rule didn't increment state.line");
          break;
        }
      if (!p) throw new Error("none of the block rules matched");
      e.tight = !c, e.isEmpty(e.line - 1) && (c = !0), a = e.line, a < t && e.isEmpty(a) && (c = !0, a++, e.line = a);
    }
  }
  /**
  * Process input string and push block tokens into `outTokens`
  */
  parse(e, n, t, o) {
    if (!e) return;
    let r = new this.State(e, n, t, o);
    this.tokenize(r, r.line, r.lineMax);
  }
}, Lr = class {
  constructor(e, n, t, o) {
    T(this, "pos", 0), T(this, "level", 0), T(this, "pending", ""), T(this, "pendingLevel", 0), T(this, "cache", {}), T(this, "backticks", {}), T(this, "backticksScanned", !1), T(this, "linkLevel", 0), T(this, "delimiters", []), T(this, "_prev_delimiters", []), T(this, "Token", de), this.src = e, this.env = t, this.md = n, this.tokens = o, this.tokens_meta = Array(o.length), this.posMax = this.src.length;
  }
  pushPending() {
    let e = new de("text", "", 0);
    return e.content = this.pending, e.level = this.pendingLevel, this.tokens.push(e), this.pending = "", e;
  }
  push(e, n, t) {
    this.pending && this.pushPending();
    let o = new de(e, n, t), r;
    return t < 0 && (this.level--, this.delimiters = this._prev_delimiters.pop()), o.level = this.level, t > 0 && (this.level++, this._prev_delimiters.push(this.delimiters), this.delimiters = [], r = { delimiters: this.delimiters }), this.pendingLevel = this.level, this.tokens.push(o), this.tokens_meta.push(r), o;
  }
  scanDelims(e, n) {
    let t = this.posMax, o = this.src.charCodeAt(e), r;
    if (e === 0) r = 32;
    else if (e === 1)
      r = this.src.charCodeAt(0), (r & 63488) === 55296 && (r = 65533);
    else if (r = this.src.charCodeAt(e - 1), (r & 64512) === 56320) {
      let u = this.src.charCodeAt(e - 2);
      r = (u & 64512) === 55296 ? 65536 + (u - 55296 << 10) + (r - 56320) : 65533;
    } else (r & 64512) === 55296 && (r = 65533);
    let i = e;
    for (; i < t && this.src.charCodeAt(i) === o; ) i++;
    let a = i - e, c = i < t ? this.src.charCodeAt(i) : 32;
    if ((c & 64512) === 55296) {
      let u = this.src.charCodeAt(i + 1);
      c = (u & 64512) === 56320 ? 65536 + (c - 55296 << 10) + (u - 56320) : 65533;
    } else (c & 64512) === 56320 && (c = 65533);
    let d = _e(r) || Ee(r), p = _e(c) || Ee(c), g = Se(r), m = Se(c), y = !m && (!p || g || d), l = !g && (!d || m || p);
    return {
      can_open: y && (n || !l || d),
      can_close: l && (n || !y || p),
      length: a
    };
  }
};
function da(e) {
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
function pa(e, n) {
  let t = e.pos;
  for (; t < e.posMax && !da(e.src.charCodeAt(t)); ) t++;
  return t === e.pos ? !1 : (n || (e.pending += e.src.slice(e.pos, t)), e.pos = t, !0);
}
function fa(e) {
  return e >= 65 && e <= 90 || e >= 97 && e <= 122;
}
function ha(e) {
  return e >= 65 && e <= 90 || e >= 97 && e <= 122 || e >= 48 && e <= 57 || e === 43 || e === 45 || e === 46;
}
function ga(e, n) {
  if (!e.md.options.linkify || e.linkLevel > 0) return !1;
  let t = e.pos, o = e.posMax;
  if (t + 3 > o || e.src.charCodeAt(t) !== 58 || e.src.charCodeAt(t + 1) !== 47 || e.src.charCodeAt(t + 2) !== 47) return !1;
  let r = t - Math.min(10, e.pending.length, t), i = t;
  for (; i > r && ha(e.src.charCodeAt(i - 1)); ) i--;
  if (i === t || !fa(e.src.charCodeAt(i))) return !1;
  let a = t - i, c = e.md.linkify.matchAtStart(e.src.slice(i));
  if (!c) return !1;
  let d = c.url;
  if (d.length <= a) return !1;
  let p = d.length;
  for (; p > 0 && d.charCodeAt(p - 1) === 42; ) p--;
  p !== d.length && (d = d.slice(0, p));
  let g = e.md.normalizeLink(d);
  if (!e.md.validateLink(g)) return !1;
  if (!n) {
    e.pending = e.pending.slice(0, -a);
    let m = e.push("link_open", "a", 1);
    m.attrs = [["href", g]], m.markup = "linkify", m.info = "auto";
    let y = e.push("text", "", 0);
    y.content = e.md.normalizeLinkText(d);
    let l = e.push("link_close", "a", -1);
    l.markup = "linkify", l.info = "auto";
  }
  return e.pos += d.length - a, !0;
}
function ma(e, n) {
  let t = e.pos;
  if (e.src.charCodeAt(t) !== 10) return !1;
  let o = e.pending.length - 1, r = e.posMax;
  if (!n) if (o >= 0 && e.pending.charCodeAt(o) === 32) if (o >= 1 && e.pending.charCodeAt(o - 1) === 32) {
    let i = o - 1;
    for (; i >= 1 && e.pending.charCodeAt(i - 1) === 32; ) i--;
    e.pending = e.pending.slice(0, i), e.push("hardbreak", "br", 0);
  } else
    e.pending = e.pending.slice(0, -1), e.push("softbreak", "br", 0);
  else e.push("softbreak", "br", 0);
  for (t++; t < r && F(e.src.charCodeAt(t)); ) t++;
  return e.pos = t, !0;
}
var Tn = [];
for (let e = 0; e < 256; e++) Tn.push(0);
"\\!\"#$%&'()*+,./:;<=>?@[]^_`{|}~-".split("").forEach(function(e) {
  Tn[e.charCodeAt(0)] = 1;
});
function ya(e, n) {
  let t = e.pos, o = e.posMax;
  if (e.src.charCodeAt(t) !== 92 || (t++, t >= o)) return !1;
  let r = e.src.charCodeAt(t);
  if (r === 10) {
    for (n || e.push("hardbreak", "br", 0), t++; t < o && (r = e.src.charCodeAt(t), !!F(r)); )
      t++;
    return e.pos = t, !0;
  }
  if (r === 32) {
    if (!n) {
      let c = e.push("text_special", "", 0);
      c.content = "\\", c.markup = "\\", c.info = "escape";
    }
    return e.pos = t, !0;
  }
  let i = e.src[t];
  if (r >= 55296 && r <= 56319 && t + 1 < o) {
    let c = e.src.charCodeAt(t + 1);
    c >= 56320 && c <= 57343 && (i += e.src[t + 1], t++);
  }
  let a = "\\" + i;
  if (!n) {
    let c = e.push("text_special", "", 0);
    r < 256 && Tn[r] !== 0 ? c.content = i : c.content = a, c.markup = a, c.info = "escape";
  }
  return e.pos = t + 1, !0;
}
function ba(e) {
  let n = {}, t = 0;
  for (; (t = e.indexOf("`", t)) !== -1; ) {
    let o = t;
    for (; e.charCodeAt(++t) === 96; ) ;
    n[t - o] = o;
  }
  return n;
}
function wa(e, n) {
  var t;
  let o = e.pos;
  if (e.src.charCodeAt(o) !== 96) return !1;
  let r = e.posMax, i = o + 1;
  for (; i < r && e.src.charCodeAt(i) === 96; ) i++;
  let a = e.src.slice(o, i), c = a.length;
  if (e.backticksScanned || (e.backticks = ba(e.src), e.backticksScanned = !0), ((t = e.backticks[c]) !== null && t !== void 0 ? t : -1) >= i) {
    let d = i, p;
    for (; (p = e.src.indexOf("`", d)) !== -1 && p < r; ) {
      for (d = p + 1; e.src.charCodeAt(d) === 96; ) d++;
      if (d > r) break;
      if (d - p === c) {
        if (!n) {
          let g = e.push("code_inline", "code", 0);
          g.markup = a;
          let m = e.src.slice(i, p).replace(/\n/g, " ");
          m.startsWith(" ") && m.endsWith(" ") && /[^ ]/.test(m) && (m = m.slice(1, -1)), g.content = m;
        }
        return e.pos = d, !0;
      }
    }
  }
  return n || (e.pending += a), e.pos = i, !0;
}
function ka(e, n) {
  let t = e.pos, o = e.src.charCodeAt(t);
  if (n || o !== 126) return !1;
  let r = e.scanDelims(e.pos, !0), i = r.length, a = String.fromCharCode(o);
  if (i < 2) return !1;
  let c;
  i % 2 && (c = e.push("text", "", 0), c.content = a, i--);
  for (let d = 0; d < i; d += 2)
    c = e.push("text", "", 0), c.content = a + a, e.delimiters.push({
      marker: o,
      length: 0,
      token: e.tokens.length - 1,
      end: -1,
      open: r.can_open,
      close: r.can_close
    });
  return e.pos += r.length, !0;
}
function Rr(e, n) {
  let t, o = [], r = n.length;
  for (let i = 0; i < r; i++) {
    let a = n[i];
    if (a.marker !== 126 || a.end === -1) continue;
    let c = n[a.end];
    t = e.tokens[a.token], t.type = "s_open", t.tag = "s", t.nesting = 1, t.markup = "~~", t.content = "", t = e.tokens[c.token], t.type = "s_close", t.tag = "s", t.nesting = -1, t.markup = "~~", t.content = "", e.tokens[c.token - 1].type === "text" && e.tokens[c.token - 1].content === "~" && o.push(c.token - 1);
  }
  for (; o.length; ) {
    let i = o.pop(), a = i + 1;
    for (; a < e.tokens.length && e.tokens[a].type === "s_close"; ) a++;
    a--, i !== a && (t = e.tokens[a], e.tokens[a] = e.tokens[i], e.tokens[i] = t);
  }
}
function Ra(e) {
  let n = e.tokens_meta, t = e.tokens_meta.length;
  Rr(e, e.delimiters);
  for (let r = 0; r < t; r++) {
    var o;
    let i = (o = n[r]) === null || o === void 0 ? void 0 : o.delimiters;
    i && Rr(e, i);
  }
}
var Ur = {
  tokenize: ka,
  postProcess: Ra
};
function xa(e, n) {
  let t = e.pos, o = e.src.charCodeAt(t);
  if (n || o !== 95 && o !== 42) return !1;
  let r = e.scanDelims(e.pos, o === 42);
  for (let i = 0; i < r.length; i++) {
    let a = e.push("text", "", 0);
    a.content = String.fromCharCode(o), e.delimiters.push({
      marker: o,
      length: r.length,
      token: e.tokens.length - 1,
      end: -1,
      open: r.can_open,
      close: r.can_close
    });
  }
  return e.pos += r.length, !0;
}
function xr(e, n) {
  let t = n.length;
  for (let o = t - 1; o >= 0; o--) {
    let r = n[o];
    if (r.marker !== 95 && r.marker !== 42 || r.end === -1) continue;
    let i = n[r.end], a = o > 0 && n[o - 1].end === r.end + 1 && n[o - 1].marker === r.marker && n[o - 1].token === r.token - 1 && n[r.end + 1].token === i.token + 1, c = String.fromCharCode(r.marker), d = e.tokens[r.token];
    d.type = a ? "strong_open" : "em_open", d.tag = a ? "strong" : "em", d.nesting = 1, d.markup = a ? c + c : c, d.content = "";
    let p = e.tokens[i.token];
    p.type = a ? "strong_close" : "em_close", p.tag = a ? "strong" : "em", p.nesting = -1, p.markup = a ? c + c : c, p.content = "", a && (e.tokens[n[o - 1].token].content = "", e.tokens[n[r.end + 1].token].content = "", o--);
  }
}
function Ca(e) {
  let n = e.tokens_meta, t = e.tokens_meta.length;
  xr(e, e.delimiters);
  for (let r = 0; r < t; r++) {
    var o;
    let i = (o = n[r]) === null || o === void 0 ? void 0 : o.delimiters;
    i && xr(e, i);
  }
}
var Br = {
  tokenize: xa,
  postProcess: Ca
};
function Ta(e, n) {
  let t, o, r, i, a = "", c = "", d = e.pos, p = !0;
  if (e.src.charCodeAt(e.pos) !== 91) return !1;
  let g = e.pos, m = e.posMax, y = e.pos + 1, l = e.md.helpers.parseLinkLabel(e, e.pos, !0);
  if (l < 0) return !1;
  let u = l + 1;
  if (u < m && e.src.charCodeAt(u) === 40) {
    for (p = !1, u++; u < m && (t = e.src.charCodeAt(u), !(!F(t) && t !== 10)); u++)
      ;
    if (u >= m) return !1;
    if (d = u, r = e.md.helpers.parseLinkDestination(e.src, u, e.posMax), r.ok) {
      for (a = e.md.normalizeLink(r.str), e.md.validateLink(a) ? u = r.pos : a = "", d = u; u < m && (t = e.src.charCodeAt(u), !(!F(t) && t !== 10)); u++)
        ;
      if (r = e.md.helpers.parseLinkTitle(e.src, u, e.posMax), u < m && d !== u && r.ok)
        for (c = r.str, u = r.pos; u < m && (t = e.src.charCodeAt(u), !(!F(t) && t !== 10)); u++)
          ;
    }
    (u >= m || e.src.charCodeAt(u) !== 41) && (p = !0), u++;
  }
  if (p) {
    if (typeof e.env.references > "u") return !1;
    if (u < m && e.src.charCodeAt(u) === 91 ? (d = u + 1, u = e.md.helpers.parseLinkLabel(e, u), u >= 0 ? o = e.src.slice(d, u++) : u = l + 1) : u = l + 1, o || (o = e.src.slice(y, l)), o = ze(o), i = e.env.references[o], !i)
      return e.pos = g, !1;
    a = i.href, c = i.title;
  }
  if (!n) {
    e.pos = y, e.posMax = l;
    let h = e.push("link_open", "a", 1), f = [["href", a]];
    if (h.attrs = f, c && f.push(["title", c]), o) {
      let b = /* @__PURE__ */ Object.create(null);
      b.label = o, h.meta = b;
    }
    e.linkLevel++, e.md.inline.tokenize(e), e.linkLevel--, e.push("link_close", "a", -1);
  }
  return e.pos = u, e.posMax = m, !0;
}
function Sa(e, n) {
  let t, o, r, i, a, c, d, p, g = "", m = e.pos, y = e.posMax;
  if (e.src.charCodeAt(e.pos) !== 33 || e.src.charCodeAt(e.pos + 1) !== 91) return !1;
  let l = e.pos + 2, u = e.md.helpers.parseLinkLabel(e, e.pos + 1, !1);
  if (u < 0) return !1;
  if (i = u + 1, i < y && e.src.charCodeAt(i) === 40) {
    for (i++; i < y && (t = e.src.charCodeAt(i), !(!F(t) && t !== 10)); i++)
      ;
    if (i >= y) return !1;
    for (p = i, c = e.md.helpers.parseLinkDestination(e.src, i, e.posMax), c.ok && (g = e.md.normalizeLink(c.str), e.md.validateLink(g) ? i = c.pos : g = ""), p = i; i < y && (t = e.src.charCodeAt(i), !(!F(t) && t !== 10)); i++)
      ;
    if (c = e.md.helpers.parseLinkTitle(e.src, i, e.posMax), i < y && p !== i && c.ok)
      for (d = c.str, i = c.pos; i < y && (t = e.src.charCodeAt(i), !(!F(t) && t !== 10)); i++)
        ;
    else d = "";
    if (i >= y || e.src.charCodeAt(i) !== 41)
      return e.pos = m, !1;
    i++;
  } else {
    if (typeof e.env.references > "u") return !1;
    if (i < y && e.src.charCodeAt(i) === 91 ? (p = i + 1, i = e.md.helpers.parseLinkLabel(e, i), i >= 0 ? r = e.src.slice(p, i++) : i = u + 1) : i = u + 1, r || (r = e.src.slice(l, u)), r = ze(r), a = e.env.references[r], !a)
      return e.pos = m, !1;
    g = a.href, d = a.title;
  }
  if (!n) {
    o = e.src.slice(l, u);
    let h = [];
    e.md.inline.parse(o, e.md, e.env, h);
    let f = e.push("image", "img", 0), b = [["src", g], ["alt", ""]];
    if (f.attrs = b, f.children = h, f.content = o, d && b.push(["title", d]), r) {
      let w = /* @__PURE__ */ Object.create(null);
      w.label = r, f.meta = w;
    }
  }
  return e.pos = i, e.posMax = y, !0;
}
var Ea = /^([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)$/, _a = /^([a-zA-Z][a-zA-Z0-9+.-]{1,31}):([^<>\x00-\x20]*)$/;
function Aa(e, n) {
  let t = e.pos;
  if (e.src.charCodeAt(t) !== 60) return !1;
  let o = e.pos, r = e.posMax;
  for (; ; ) {
    if (++t >= r) return !1;
    let a = e.src.charCodeAt(t);
    if (a === 60) return !1;
    if (a === 62) break;
  }
  let i = e.src.slice(o + 1, t);
  if (_a.test(i)) {
    let a = e.md.normalizeLink(i);
    if (!e.md.validateLink(a)) return !1;
    if (!n) {
      let c = e.push("link_open", "a", 1);
      c.attrs = [["href", a]], c.markup = "autolink", c.info = "auto";
      let d = e.push("text", "", 0);
      d.content = e.md.normalizeLinkText(i);
      let p = e.push("link_close", "a", -1);
      p.markup = "autolink", p.info = "auto";
    }
    return e.pos += i.length + 2, !0;
  }
  if (Ea.test(i)) {
    let a = e.md.normalizeLink(`mailto:${i}`);
    if (!e.md.validateLink(a)) return !1;
    if (!n) {
      let c = e.push("link_open", "a", 1);
      c.attrs = [["href", a]], c.markup = "autolink", c.info = "auto";
      let d = e.push("text", "", 0);
      d.content = e.md.normalizeLinkText(i);
      let p = e.push("link_close", "a", -1);
      p.markup = "autolink", p.info = "auto";
    }
    return e.pos += i.length + 2, !0;
  }
  return !1;
}
function Ia(e) {
  return /^<a[>\s]/i.test(e);
}
function va(e) {
  return /^<\/a\s*>/i.test(e);
}
function Ma(e) {
  let n = e | 32;
  return n >= 97 && n <= 122;
}
function Da(e, n) {
  if (!e.md.options.html) return !1;
  let t = e.posMax, o = e.pos;
  if (e.src.charCodeAt(o) !== 60 || o + 2 >= t) return !1;
  let r = e.src.charCodeAt(o + 1);
  if (r !== 33 && r !== 63 && r !== 47 && !Ma(r)) return !1;
  let i = e.src.slice(o).match(ia);
  if (!i) return !1;
  if (!n) {
    let a = e.push("html_inline", "", 0);
    a.content = i[0], Ia(a.content) && e.linkLevel++, va(a.content) && e.linkLevel--;
  }
  return e.pos += i[0].length, !0;
}
var Pa = /^&#((?:x[a-f0-9]{1,6}|[0-9]{1,7}));/i, Oa = /^&([a-z][a-z0-9]{1,31});/i;
function Na(e, n) {
  let t = e.pos, o = e.posMax;
  if (e.src.charCodeAt(t) !== 38 || t + 1 >= o) return !1;
  if (e.src.charCodeAt(t + 1) === 35) {
    let r = e.src.slice(t).match(Pa);
    if (r) {
      if (!n) {
        let i = r[1][0].toLowerCase() === "x" ? parseInt(r[1].slice(1), 16) : parseInt(r[1], 10), a = e.push("text_special", "", 0);
        a.content = Cn(i) ? Te(i) : Te(65533), a.markup = r[0], a.info = "entity";
      }
      return e.pos += r[0].length, !0;
    }
  } else {
    let r = e.src.slice(t).match(Oa);
    if (r) {
      let i = Ge(r[0]);
      if (i !== r[0]) {
        if (!n) {
          let a = e.push("text_special", "", 0);
          a.content = i, a.markup = r[0], a.info = "entity";
        }
        return e.pos += r[0].length, !0;
      }
    }
  }
  return !1;
}
function Cr(e) {
  let n = {}, t = e.length;
  if (!t) return;
  let o = 0, r = -2, i = [];
  for (let a = 0; a < t; a++) {
    let c = e[a];
    if (i.push(0), (e[o].marker !== c.marker || r !== c.token - 1) && (o = a), r = c.token, c.length = c.length || 0, !c.close) continue;
    n.hasOwnProperty(c.marker) || (n[c.marker] = [
      -1,
      -1,
      -1,
      -1,
      -1,
      -1
    ]);
    let d = n[c.marker][(c.open ? 3 : 0) + c.length % 3], p = o - i[o] - 1, g = p;
    for (; p > d; p -= i[p] + 1) {
      let m = e[p];
      if (m.marker === c.marker && m.open && m.end < 0) {
        let y = !1;
        if ((m.close || c.open) && (m.length + c.length) % 3 === 0 && (m.length % 3 !== 0 || c.length % 3 !== 0) && (y = !0), !y) {
          let l = p > 0 && !e[p - 1].open ? i[p - 1] + 1 : 0;
          i[a] = a - p + l, i[p] = l, c.open = !1, m.end = a, m.close = !1, g = -1, r = -2;
          break;
        }
      }
    }
    g !== -1 && (n[c.marker][(c.open ? 3 : 0) + (c.length || 0) % 3] = g);
  }
}
function Fa(e) {
  let n = e.tokens_meta, t = e.tokens_meta.length;
  Cr(e.delimiters);
  for (let r = 0; r < t; r++) {
    var o;
    let i = (o = n[r]) === null || o === void 0 ? void 0 : o.delimiters;
    i && Cr(i);
  }
}
function La(e) {
  let n, t, o = 0, r = e.tokens, i = e.tokens.length;
  for (n = t = 0; n < i; n++)
    r[n].nesting < 0 && o--, r[n].level = o, r[n].nesting > 0 && o++, r[n].type === "text" && n + 1 < i && r[n + 1].type === "text" ? r[n + 1].content = r[n].content + r[n + 1].content : (n !== t && (r[t] = r[n]), t++);
  n !== t && (r.length = t);
}
var kn = [
  ["text", pa],
  ["linkify", ga],
  ["newline", ma],
  ["escape", ya],
  ["backticks", wa],
  ["strikethrough", Ur.tokenize],
  ["emphasis", Br.tokenize],
  ["link", Ta],
  ["image", Sa],
  ["autolink", Aa],
  ["html_inline", Da],
  ["entity", Na]
], Rn = [
  ["balance_pairs", Fa],
  ["strikethrough", Ur.postProcess],
  ["emphasis", Br.postProcess],
  ["fragments_join", La]
], jr = class {
  constructor() {
    T(
      this,
      /**
      * {@link Ruler} instance. Keep configuration of inline rules.
      */
      "ruler",
      new Ie()
    ), T(
      this,
      /**
      * {@link Ruler} instance. Second ruler used for post-processing
      * (e.g. in emphasis-like rules).
      */
      "ruler2",
      new Ie()
    ), T(this, "State", Lr);
    for (let e = 0; e < kn.length; e++) this.ruler.push(kn[e][0], kn[e][1]);
    for (let e = 0; e < Rn.length; e++) this.ruler2.push(Rn[e][0], Rn[e][1]);
  }
  skipToken(e) {
    let n = e.pos, t = this.ruler.getRules(""), o = t.length, r = e.md.options.maxNesting, i = e.cache;
    if (typeof i[n] < "u") {
      e.pos = i[n];
      return;
    }
    let a = !1;
    if (e.level < r) {
      for (let c = 0; c < o; c++)
        if (e.level++, a = t[c](e, !0), e.level--, a) {
          if (n >= e.pos) throw new Error("inline rule didn't increment state.pos");
          break;
        }
    } else e.pos = e.posMax;
    a || e.pos++, i[n] = e.pos;
  }
  tokenize(e) {
    let n = this.ruler.getRules(""), t = n.length, o = e.posMax, r = e.md.options.maxNesting;
    for (; e.pos < o; ) {
      let i = e.pos, a = !1;
      if (e.level < r) {
        for (let c = 0; c < t; c++)
          if (a = n[c](e, !1), a) {
            if (i >= e.pos) throw new Error("inline rule didn't increment state.pos");
            break;
          }
      }
      if (a) {
        if (e.pos >= o) break;
        continue;
      }
      e.pending += e.src[e.pos++];
    }
    e.pending && e.pushPending();
  }
  /**
  * Process input string and push inline tokens into `outTokens`
  */
  parse(e, n, t, o) {
    let r = new this.State(e, n, t, o);
    this.tokenize(r);
    let i = this.ruler2.getRules(""), a = i.length;
    for (let c = 0; c < a; c++) i[c](r);
  }
}, Ua = {
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
}, Ba = /^(vbscript|javascript|file|data):/, ja = /^data:image\/(gif|png|jpeg|webp);/, Tr = [
  "http:",
  "https:",
  "mailto:"
], Q = class {
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
    return Ba.test(n) ? ja.test(n) : !0;
  }
  /**
  * Function used to encode link url to a machine-readable format,
  * which includes url-encoding, punycode, etc.
  */
  normalizeLink(e) {
    let n = xe(e, !0);
    if (n.hostname && (!n.protocol || Tr.indexOf(n.protocol) >= 0))
      try {
        n.hostname = xn.default.toASCII(n.hostname);
      } catch {
      }
    return n.auth && (n.auth = ee(n.auth)), n.hostname && (n.hostname = ee(n.hostname)), n.pathname && (n.pathname = ee(n.pathname)), n.search && (n.search = ee(n.search)), n.hash && (n.hash = ee(n.hash)), he(n);
  }
  /**
  * Function used to decode link url to a human-readable format`
  */
  normalizeLinkText(e) {
    let n = xe(e, !0);
    if (n.hostname && (!n.protocol || Tr.indexOf(n.protocol) >= 0))
      try {
        n.hostname = xn.default.toUnicode(n.hostname);
      } catch {
      }
    return Re(he(n), Re.defaultChars + "%");
  }
  constructor(...e) {
    T(
      this,
      /**
      * Instance of {@link ParserInline}. You may need it to add new rules when
      * writing plugins. For simple rules control use {@link MarkdownIt.disable}
      * and {@link MarkdownIt.enable}.
      */
      "inline",
      new jr()
    ), T(
      this,
      /**
      * Instance of {@link ParserBlock}. You may need it to add new rules when
      * writing plugins. For simple rules control use {@link MarkdownIt.disable}
      * and {@link MarkdownIt.enable}.
      */
      "block",
      new Fr()
    ), T(
      this,
      /**
      * Instance of {@link ParserCore} chain executor. You may need it to add new
      * rules when writing plugins. For simple rules control use
      * {@link MarkdownIt.disable} and {@link MarkdownIt.enable}.
      */
      "core",
      new Dr()
    ), T(
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
      new Ir()
    ), T(
      this,
      /**
      * [linkify-it](https://github.com/markdown-it/linkify-it) instance.
      * Used by [linkify](https://github.com/markdown-it/markdown-it/blob/master/src/rules_core/linkify.ts)
      * rule.
      */
      "linkify",
      new or()
    ), T(
      this,
      /**
      * Assorted utility functions, useful to write plugins. See details
      * [here](https://github.com/markdown-it/markdown-it/blob/master/src/common/utils.ts).
      */
      "utils",
      as
    ), T(
      this,
      /**
      * Link components parser functions, useful to write plugins. See details
      * [here](https://github.com/markdown-it/markdown-it/blob/master/src/helpers).
      */
      "helpers",
      Object.assign({}, Cs)
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
      let r = e;
      if (n = Ua[r], !n) throw new Error(`Wrong 'markdown-it' preset "${r}", check name`);
    } else n = e;
    if (!n) throw new Error("Wrong `markdown-it` preset, can't be empty");
    n.options && (this.options = { ...n.options });
    let t = n.components;
    if (t) {
      var o;
      [
        "core",
        "block",
        "inline"
      ].forEach((i) => {
        var a;
        let c = (a = t[i]) === null || a === void 0 ? void 0 : a.rules;
        c && this[i].ruler.enableOnly(c);
      });
      let r = (o = t.inline) === null || o === void 0 ? void 0 : o.rules2;
      r && this.inline.ruler2.enableOnly(r);
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
    ].forEach((r) => {
      t = t.concat(this[r].ruler.enable(e, !0));
    }), t = t.concat(this.inline.ruler2.enable(e, !0));
    let o = e.filter((r) => t.indexOf(r) < 0);
    if (o.length && !n) throw new Error(`MarkdownIt. Failed to enable unknown rule(s): ${o}`);
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
    ].forEach((r) => {
      t = t.concat(this[r].ruler.disable(e, !0));
    }), t = t.concat(this.inline.ruler2.disable(e, !0));
    let o = e.filter((r) => t.indexOf(r) < 0);
    if (o.length && !n) throw new Error(`MarkdownIt. Failed to disable unknown rule(s): ${o}`);
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
T(Q, "Token", de);
T(Q, "Ruler", Ie);
T(Q, "Renderer", Ir);
T(Q, "ParserCore", Dr);
T(Q, "StateCore", vr);
T(Q, "ParserBlock", Fr);
T(Q, "StateBlock", Pr);
T(Q, "ParserInline", jr);
T(Q, "StateInline", Lr);
var Ga = Er(Q);

// openclaw/packages/net-policy/src/ip.ts
W();
var Wr = Nn(qr(), 1);
var ef = [Wr.default.IPv4.parse("198.18.0.0"), 15];

// openclaw/src/media/parse-output.ts
Y();

// openclaw/src/utils/directive-tags.ts
Y();
nn();
W();

// openclaw/src/shared/text/text-projection.ts
Y();

// openclaw/packages/markdown-core/src/fences.ts
var Wa = /(?:^|\n)( {0,3})(`{3,}|~{3,})([^\r\n\u2028\u2029]*)\r?(?=\n|$)/g, tf = new RegExp(Wa, "gy");

// openclaw/packages/tool-call-repair/src/grammar.ts
var mf = new TextEncoder();

// openclaw/src/shared/clawhub-recommendations.ts
N();
var zr = [
  "type",
  "id",
  "name",
  "description",
  "iconUrl",
  "installed",
  "official",
  "kind"
], sh = /* @__PURE__ */ new Set([...zr, "pluginId"]), ah = /* @__PURE__ */ new Set([...zr, "registry", "skillRef"]);

// openclaw/ui/src/lib/chat/imported-message-display.ts
N();

// openclaw/ui/src/lib/chat/message-normalizer-attachments.ts
se();
N();

// openclaw/ui/src/lib/chat/sender-label.ts
N();
W();

// openclaw/ui/src/lib/chat/message-normalizer.ts
function Sn(e) {
  return De(L(e)?.role);
}

// openclaw/ui/src/lib/chat/tool-call-diff.ts
N();
function Hr(e) {
  let n = oe(e), t = n?.added, o = n?.removed;
  return typeof t == "number" && Number.isInteger(t) && t >= 0 && typeof o == "number" && Number.isInteger(o) && o >= 0 ? { added: t, removed: o } : void 0;
}

// openclaw/ui/src/lib/chat/tool-call-grouping.ts
N();

// openclaw/src/agents/agent-activity-presentation.ts
N();
W();

// openclaw/src/session-cards/progress-card-input.ts
N();

// openclaw/src/agents/agent-activity-presentation.ts
function pe(e, n) {
  return n.map((t) => [t, e]);
}
var pg = new Map([
  // A launched subagent is a worker, not one more operation of the launcher.
  ...pe("subagents", ["sessions_spawn"]),
  ...pe("commands", ["exec", "bash", "shell", "run_command", "run_terminal_cmd"]),
  ...pe("reads", ["read", "read_file", "readfile", "notebookread", "notebook_read"]),
  ...pe("edits", [
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
  ...pe("writes", ["write", "write_file", "create_file"]),
  ...pe("searches", [
    "grep",
    "glob",
    "find",
    "ls",
    "list",
    "codebase_search",
    "web_search"
  ]),
  ...pe("fetches", ["web_fetch", "webfetch", "fetch"])
]);

// openclaw/ui/src/lib/chat/tool-call-grouping.ts
Yr();

// openclaw/ui/src/i18n/locales/en-chat-tool-labels.ts
En();
var Xr = {
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
}, Zr = Object.assign(
  () => {
    let { activity: e, review: n, verbs: t, ...o } = Xr.chat.toolCards;
    Object.assign(me.chat.toolCards, o), Object.assign(me.chat.toolCards.activity, e), Object.assign(me.chat.toolCards.review, n), Object.assign(me.chat.toolCards.verbs, t);
  },
  { catalog: Xr }
);

// openclaw/ui/src/lib/protocol-validators.generated/activity.js
function re(e) {
  let n = 0, t = 0, o = 0;
  for (; t < e.length; ) {
    let r = e.charCodeAt(t++) >> 10;
    n += +((o << 8 | r) !== 13879), o = r;
  }
  return n;
}
var {
  isAgentActivityItem: Qr,
  isSessionObserverDigest: wg,
  isSessionNarrationEvent: kg,
  isSessionReactionEvent: Rg
} = (() => {
  let e = [
    new RegExp(
      "(^itemId$|^phase$|^kind$|^title$|^status$|^name$|^meta$|^commandBearing$|^toolCallId$|^unpairedCall$|^startedAt$|^endedAt$|^error$|^summary$|^progressText$|^suppressChannelProgress$|^hideFromChannelProgress$|^approvalId$|^approvalSlug$)",
      "u"
    ),
    new RegExp(
      "(^sessionKey$|^agentId$|^sessionId$|^lifecycleRevision$|^runId$|^revision$|^updatedAt$|^headline$|^assessment$|^health$|^planProgress$)",
      "u"
    ),
    new RegExp("(^completed$|^total$)", "u"),
    new RegExp("(^sessionKey$|^agentId$|^runId$|^text$)", "u"),
    new RegExp(
      "(^sessionKey$|^agentId$|^sessionId$|^messageId$|^emoji$|^action$|^actor$|^reactions$)",
      "u"
    ),
    new RegExp("(^type$|^id$|^label$|^avatarUrl$|^identity$)", "u"),
    new RegExp("(^type$|^id$)", "u"),
    new RegExp("(^type$|^id$)", "u"),
    new RegExp("(^type$|^pluginId$|^domain$|^idKind$|^id$)", "u"),
    new RegExp("(^type$|^pluginId$|^accountId$|^senderKind$|^id$)", "u"),
    new RegExp("(^type$|^actorType$|^source$|^id$)", "u"),
    new RegExp("(^emoji$|^count$|^identities$)", "u"),
    new RegExp("(^id$|^label$)", "u")
  ], n = (s) => t(s), t = (s) => typeof s == "object" && s !== null && !Array.isArray(s) && "itemId" in s && "phase" in s && "kind" in s && "title" in s && Object.getOwnPropertyNames(s).every(
    (_, V) => e[0].test(_) || o(s[_])
  ) && r(s.itemId) && i(s.phase) && p(s.kind) && p(s.title) && (s.status === void 0 || !("status" in s) || g(s.status)) && (s.name === void 0 || !("name" in s) || p(s.name)) && (s.meta === void 0 || !("meta" in s) || p(s.meta)) && (s.commandBearing === void 0 || !("commandBearing" in s) || f(s.commandBearing)) && (s.toolCallId === void 0 || !("toolCallId" in s) || p(s.toolCallId)) && (s.unpairedCall === void 0 || !("unpairedCall" in s) || f(s.unpairedCall)) && (s.startedAt === void 0 || !("startedAt" in s) || b(s.startedAt)) && (s.endedAt === void 0 || !("endedAt" in s) || b(s.endedAt)) && (s.error === void 0 || !("error" in s) || p(s.error)) && (s.summary === void 0 || !("summary" in s) || p(s.summary)) && (s.progressText === void 0 || !("progressText" in s) || p(s.progressText)) && (s.suppressChannelProgress === void 0 || !("suppressChannelProgress" in s) || f(s.suppressChannelProgress)) && (s.hideFromChannelProgress === void 0 || !("hideFromChannelProgress" in s) || f(s.hideFromChannelProgress)) && (s.approvalId === void 0 || !("approvalId" in s) || p(s.approvalId)) && (s.approvalSlug === void 0 || !("approvalSlug" in s) || p(s.approvalSlug)), o = (s) => !1, r = (s) => typeof s == "string" && (s.length >= 2 || s.length >= 1 && re(s) >= 1), i = (s) => a(s) || c(s) || d(s), a = (s) => typeof s == "string" && s === "start", c = (s) => typeof s == "string" && s === "update", d = (s) => typeof s == "string" && s === "end", p = (s) => typeof s == "string", g = (s) => m(s) || y(s) || l(s) || u(s) || h(s), m = (s) => typeof s == "string" && s === "running", y = (s) => typeof s == "string" && s === "completed", l = (s) => typeof s == "string" && s === "failed", u = (s) => typeof s == "string" && s === "blocked", h = (s) => typeof s == "string" && s === "skipped", f = (s) => typeof s == "boolean", b = (s) => Number.isFinite(s), w = (s) => R(s), R = (s) => typeof s == "object" && s !== null && !Array.isArray(s) && "sessionKey" in s && "revision" in s && "updatedAt" in s && "headline" in s && "health" in s && Object.getOwnPropertyNames(s).every(
    (_, V) => e[1].test(_) || o(s[_])
  ) && r(s.sessionKey) && (s.agentId === void 0 || !("agentId" in s) || r(s.agentId)) && (s.sessionId === void 0 || !("sessionId" in s) || r(s.sessionId)) && (s.lifecycleRevision === void 0 || !("lifecycleRevision" in s) || r(s.lifecycleRevision)) && (s.runId === void 0 || !("runId" in s) || r(s.runId)) && k(s.revision) && x(s.updatedAt) && C(s.headline) && (s.assessment === void 0 || !("assessment" in s) || M(s.assessment)) && v(s.health) && (s.planProgress === void 0 || !("planProgress" in s) || $(s.planProgress)), k = (s) => Number.isInteger(s) && (!(Number.isFinite(s) || typeof s == "bigint") || s >= 1), x = (s) => Number.isInteger(s) && (!(Number.isFinite(s) || typeof s == "bigint") || s >= 0), C = (s) => typeof s == "string" && (s.length >= 2 || s.length >= 1 && re(s) >= 1) && (s.length <= 120 || s.length <= 240 && re(s) <= 120), M = (s) => typeof s == "string" && (s.length >= 2 || s.length >= 1 && re(s) >= 1) && (s.length <= 320 || s.length <= 640 && re(s) <= 320), v = (s) => S(s) || O(s) || I(s) || A(s) || G(s) || H(s) || l(s), S = (s) => typeof s == "string" && s === "on-track", O = (s) => typeof s == "string" && s === "grinding", I = (s) => typeof s == "string" && s === "stuck", A = (s) => typeof s == "string" && s === "waiting-on-user", G = (s) => typeof s == "string" && s === "wrapping-up", H = (s) => typeof s == "string" && s === "done", $ = (s) => typeof s == "object" && s !== null && !Array.isArray(s) && "completed" in s && "total" in s && Object.getOwnPropertyNames(s).every(
    (_, V) => e[2].test(_) || o(s[_])
  ) && x(s.completed) && x(s.total), Ve = (s) => po(s), po = (s) => typeof s == "object" && s !== null && !Array.isArray(s) && "sessionKey" in s && "runId" in s && "text" in s && Object.getOwnPropertyNames(s).every(
    (_, V) => e[3].test(_) || o(s[_])
  ) && r(s.sessionKey) && (s.agentId === void 0 || !("agentId" in s) || r(s.agentId)) && r(s.runId) && fo(s.text), fo = (s) => typeof s == "string" && (s.length <= 16384 || s.length <= 32768 && re(s) <= 16384), ho = (s) => go(s), go = (s) => typeof s == "object" && s !== null && !Array.isArray(s) && "sessionKey" in s && "agentId" in s && "sessionId" in s && "messageId" in s && "emoji" in s && "action" in s && "actor" in s && "reactions" in s && Object.getOwnPropertyNames(s).every(
    (_, V) => e[4].test(_) || o(s[_])
  ) && r(s.sessionKey) && r(s.agentId) && r(s.sessionId) && r(s.messageId) && An(s.emoji) && mo(s.action) && wo(s.actor) && Fo(s.reactions), An = (s) => typeof s == "string" && (s.length >= 2 || s.length >= 1 && re(s) >= 1) && (s.length <= 32 || s.length <= 64 && re(s) <= 32), mo = (s) => yo(s) || bo(s), yo = (s) => typeof s == "string" && s === "added", bo = (s) => typeof s == "string" && s === "removed", wo = (s) => typeof s == "object" && s !== null && !Array.isArray(s) && "type" in s && "id" in s && Object.getOwnPropertyNames(s).every(
    (_, V) => e[5].test(_) || o(s[_])
  ) && ko(s.type) && r(s.id) && (s.label === void 0 || !("label" in s) || r(s.label)) && (s.avatarUrl === void 0 || !("avatarUrl" in s) || r(s.avatarUrl)) && (s.identity === void 0 || !("identity" in s) || xo(s.identity)), ko = (s) => In(s) || vn(s) || Ro(s), In = (s) => typeof s == "string" && s === "human", vn = (s) => typeof s == "string" && s === "agent", Ro = (s) => typeof s == "string" && s === "system", xo = (s) => Co(s) || So(s) || Eo(s) || Ao(s) || Po(s), Co = (s) => typeof s == "object" && s !== null && !Array.isArray(s) && "type" in s && "id" in s && Object.getOwnPropertyNames(s).every(
    (_, V) => e[6].test(_) || o(s[_])
  ) && To(s.type) && r(s.id), To = (s) => typeof s == "string" && s === "profile", So = (s) => typeof s == "object" && s !== null && !Array.isArray(s) && "type" in s && "id" in s && Object.getOwnPropertyNames(s).every(
    (_, V) => e[7].test(_) || o(s[_])
  ) && vn(s.type) && r(s.id), Eo = (s) => typeof s == "object" && s !== null && !Array.isArray(s) && "type" in s && "pluginId" in s && "domain" in s && "idKind" in s && "id" in s && Object.getOwnPropertyNames(s).every(
    (_, V) => e[8].test(_) || o(s[_])
  ) && _o(s.type) && r(s.pluginId) && r(s.domain) && r(s.idKind) && r(s.id), _o = (s) => typeof s == "string" && s === "remote", Ao = (s) => typeof s == "object" && s !== null && !Array.isArray(s) && "type" in s && "pluginId" in s && "accountId" in s && "senderKind" in s && "id" in s && Object.getOwnPropertyNames(s).every(
    (_, V) => e[9].test(_) || o(s[_])
  ) && Io(s.type) && Mn(s.pluginId) && Mn(s.accountId) && vo(s.senderKind) && r(s.id), Io = (s) => typeof s == "string" && s === "observation", Mn = (s) => r(s) || Dn(s), Dn = (s) => s === null, vo = (s) => In(s) || Mo(s) || Do(s), Mo = (s) => typeof s == "string" && s === "bot", Do = (s) => typeof s == "string" && s === "unknown", Po = (s) => typeof s == "object" && s !== null && !Array.isArray(s) && "type" in s && "actorType" in s && "source" in s && "id" in s && Object.getOwnPropertyNames(s).every(
    (_, V) => e[10].test(_) || o(s[_])
  ) && Oo(s.type) && p(s.actorType) && No(s.source) && p(s.id), Oo = (s) => typeof s == "string" && s === "legacy", No = (s) => p(s) || Dn(s), Fo = (s) => Array.isArray(s) && s.every((_, V) => Lo(_)), Lo = (s) => typeof s == "object" && s !== null && !Array.isArray(s) && "emoji" in s && "count" in s && "identities" in s && Object.getOwnPropertyNames(s).every(
    (_, V) => e[11].test(_) || o(s[_])
  ) && An(s.emoji) && k(s.count) && Uo(s.identities), Uo = (s) => Array.isArray(s) && s.every((_, V) => Bo(_)) && s.length >= 1, Bo = (s) => typeof s == "object" && s !== null && !Array.isArray(s) && "id" in s && Object.getOwnPropertyNames(s).every(
    (_, V) => e[12].test(_) || o(s[_])
  ) && r(s.id) && (s.label === void 0 || !("label" in s) || p(s.label));
  return {
    isAgentActivityItem: (s) => n(s),
    isSessionObserverDigest: (s) => w(s),
    isSessionNarrationEvent: (s) => Ve(s),
    isSessionReactionEvent: (s) => ho(s)
  };
})();

// openclaw/ui/src/lib/chat/tool-call-grouping.ts
Zr();
function eo(e) {
  let n = L(e)?.activity;
  return Array.isArray(n) ? n.filter(Qr) : [];
}

// openclaw/ui/src/lib/chat/tool-cards.ts
function Va(e) {
  return P(e.messageId) ?? P(B(e.__openclaw)?.id);
}
function no(e) {
  let n = B(B(e)?.__openclaw), t = B(n?.toolOutput);
  return (t?.source === "provider-response" || t?.source === "execution") && t.modelInput === "unverified" ? {
    source: t.source,
    modelInput: t.modelInput,
    ...t.outcome === "unknown" ? { outcome: "unknown" } : {},
    ...t.captureTruncated === !0 ? { captureTruncated: !0 } : {}
  } : void 0;
}
function Ka(e) {
  return Array.isArray(e) ? e.filter((n) => oe(n) !== null) : [];
}
function Ja(e) {
  if (typeof e != "string")
    return e;
  let n = e.trim();
  return n.startsWith("{") || n.startsWith("[") ? rn(n) ?? e : e;
}
function Ya(e) {
  if (typeof e.text == "string")
    return e.text;
  if (typeof e.content == "string")
    return e.content;
  if (Array.isArray(e.content)) {
    let n = e.content.flatMap((t) => {
      let o = oe(t)?.text;
      return typeof o == "string" ? [o] : [];
    });
    if (n.length > 0)
      return n.join(`
`);
  }
}
function Xa(...e) {
  for (let n of e) {
    let t = oe(n), o = t?.exitCode ?? t?.exit_code;
    if (typeof o == "number" && Number.isInteger(o))
      return o;
  }
}
function so(e) {
  if (e.activity)
    return e.activity.status === "skipped";
  let n = oe(e.details);
  return (e.live !== !0 || e.completed === !0) && n?.status === "skipped" && n.deniedReason === "steering";
}
function to(e) {
  if (so(e))
    return !1;
  if (e.activity)
    return e.activity.status === "failed";
  let n = e.live !== !0 || e.completed === !0;
  return e.isError ?? (n && Dt(e.outputText));
}
function ao(e, n) {
  if (so(e))
    return "skipped";
  if (e.toolOutput?.outcome === "unknown")
    return to(e) ? "failed" : "unknown";
  if (e.activity) {
    let { status: t, phase: o } = e.activity;
    return t === "failed" || t === "blocked" ? t : t === "completed" ? "succeeded" : n === !0 && e.live === !0 && (t === "running" || o !== "end" && e.completed !== !0) ? "running" : "unknown";
  }
  return to(e) ? "failed" : n === !0 && e.live === !0 && e.completed !== !0 ? "running" : e.completed === !0 || e.live !== !0 && e.outputText !== void 0 ? "succeeded" : "unknown";
}
function Za(e) {
  let n = It(e);
  return n?.surface === "assistant_message" ? { ...n, surface: "assistant_message" } : void 0;
}
function Qa(e, n, t) {
  let o = At(e), r = o?.surface === "assistant_message" ? { ...o, surface: "assistant_message" } : Za(n);
  if (r)
    return { preview: { ...r, surface: "assistant_message" } };
  let i = B(B(e)?.browserTab), a = Fn(i);
  if (t !== "browser" || !i || !a)
    return {};
  let c = typeof i.url == "string" ? we(i.url, 2048) : "";
  return {
    browserTab: a,
    preview: ut(c) ? {
      kind: "browser-tab",
      ...a,
      url: c,
      ...typeof i.title == "string" ? { title: we(i.title, 512) } : {}
    } : void 0
  };
}
function ro(e, n) {
  return Mt(e) ?? q(e.callId) ?? q(n.toolCallId) ?? q(n.tool_call_id) ?? q(n.toolUseId) ?? q(n.tool_use_id);
}
function _n(e, n) {
  return q(e.name) ?? q(n.toolName) ?? q(n.tool_name) ?? "tool";
}
function ec(e) {
  if (e != null)
    return typeof e == "string" ? e : JSON.stringify(e, null, 2);
}
var nc = 0;
function tc(e) {
  return sn(e.type) || typeof e.name == "string" && (e.arguments != null || e.args != null || e.input != null);
}
function oo(e) {
  let n = e, t = typeof n.role == "string" ? n.role.toLowerCase() : "", o = Sn(e) || t === "tool" || t === "function" || typeof n.toolName == "string" || typeof n.tool_name == "string", r = Ka(n.content), i = Pe(n), a = n.__openclawToolStreamLive === !0, c = Hr(n.__openclawToolStreamDiffStat), d = [], p = /* @__PURE__ */ new WeakSet(), g = Va(n), m = Qe(n)?.runId ?? P(n.runId), y = (h, f, b = !1) => {
    let w = Ya(h), R = h.details ?? n.details, k = B(h.__openclaw), x = Pe(h) ?? i, C = Xa(
      h,
      R,
      w ? ce(w.trim()) : void 0,
      b ? void 0 : n
    );
    return {
      outputText: w,
      resultMessageId: !b && k && Object.hasOwn(k, "id") ? P(k.id) : g,
      outputTruncated: (k && Object.hasOwn(k, "truncated") ? k : B(n.__openclaw))?.truncated === !0,
      toolOutput: no(h) ?? no(n),
      ...R !== void 0 ? { details: R } : {},
      ...x !== void 0 ? { isError: x } : {},
      ...C !== void 0 ? { exitCode: C } : {},
      ...Qa(R, w, f)
    };
  };
  for (let h = 0; h < r.length; h++) {
    let f = r[h] ?? {}, b = tc(f);
    if (!b && !De(f.type))
      continue;
    let w = P(f.runId) ?? m, R = P(f.parentToolCallId), k = ro(f, n), x = _n(f, n), C = {
      id: k ?? `${x}:${h}`,
      ...k ? { callId: k } : {},
      ...w ? { runId: w } : {},
      ...R ? { parentToolCallId: R } : {},
      name: x,
      messageId: g
    }, M = f.details ?? n.details;
    if (b) {
      let A = Ja(f.arguments ?? f.args ?? f.input);
      d.push({
        ...C,
        args: A,
        inputText: ec(A),
        ...M !== void 0 ? { details: M } : {},
        ...a ? {
          live: !0,
          completed: n.__openclawToolStreamResultReceived === !0 || n.__openclawToolStreamItemEnded === !0
        } : {},
        ...c ? { liveDiffStat: c } : {}
      });
      continue;
    }
    let v = d.find((A) => A.id === C.id) ?? d.find(
      (A) => (
        // Same-name fallback belongs to legacy blocks missing an explicit identity.
        (!k || !A.callId) && A.name === x && A.outputText === void 0 && !p.has(A)
      )
    ), S = o ? _n({}, n) : void 0, O = S && S !== "browser" ? S : v?.name ?? S ?? x, I = y(f, O);
    if (v) {
      p.add(v), v.callId ??= k, v.runId ??= w, v.parentToolCallId ??= R, a || (v.completed = !0), Object.assign(v, I, {
        preview: I.preview,
        browserTab: I.browserTab
      });
      continue;
    }
    d.push({
      ...C,
      completed: !0,
      ...I
    });
  }
  if (o && d.length === 0) {
    let h = typeof n.toolName == "string" && n.toolName || typeof n.tool_name == "string" && n.tool_name || "tool", f = ro({}, n);
    d.push({
      id: f ?? `${_n({}, n)}:0`,
      ...f ? { callId: f } : {},
      ...m ? { runId: m } : {},
      name: h,
      completed: Sn(e) || t === "tool" || t === "function",
      messageId: g,
      ...y(n, h, !0)
    });
  }
  let l = new Map(
    eo(e).filter((h) => !h.suppressChannelProgress).map((h) => [h.toolCallId ?? h.itemId, h])
  ), u;
  for (let [h, f] of d.entries()) {
    let b = f.callId ? l.get(f.callId) : void 0;
    b && (f.activity = b), !(!f.browserTab || f.callId || f.messageId) && (u ??= ++nc, f.previewRevision = `${u}:${h}`);
  }
  return d;
}
var io = /* @__PURE__ */ new WeakMap();
function co(e) {
  if (!e || typeof e != "object")
    return oo(e);
  let n = io.get(e);
  if (n)
    return n;
  let t = oo(e);
  return io.set(e, t), t;
}

// openclaw/ui/src/lib/chat/browser-tab-preview.ts
function rc(e) {
  return e.callId ?? e.messageId ?? e.previewRevision;
}
var lo = /* @__PURE__ */ new WeakMap();
function uo(e, n) {
  let t = lo.get(e);
  if (t?.toolMessages === n)
    return t.latest;
  let o = /* @__PURE__ */ new Map();
  for (let r of [e, n])
    for (let i of r)
      if (J(i))
        for (let a of co(i)) {
          let c = rc(a);
          if (a.browserTab && c && ao(a, !1) === "succeeded") {
            let d = Ln(a.browserTab);
            o.delete(d), o.set(d, { tab: a.browserTab, revision: c });
          }
        }
  return lo.set(e, { toolMessages: n, latest: o }), o;
}

// octogee/app/openclaw-browser/resources.ts
function Xg(e, n) {
  return [...uo(e, []).values()].filter((o) => o.tab.target === "host" && o.tab.profile === n).at(-1) ?? null;
}
export {
  Xg as latestNativeBrowserTab
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
  (*! markdown-it 15.0.2 https://github.com/markdown-it/markdown-it @license MIT *)
*/

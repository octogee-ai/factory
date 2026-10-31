// @ts-nocheck
var io = Object.create;
var We = Object.defineProperty;
var so = Object.getOwnPropertyDescriptor;
var ao = Object.getOwnPropertyNames;
var co = Object.getPrototypeOf, lo = Object.prototype.hasOwnProperty;
var S = (e, t, n) => () => {
  if (n) throw n[0];
  try {
    return e && (t = e(e = 0)), t;
  } catch (r) {
    throw n = [r], r;
  }
};
var Tt = (e, t) => () => {
  try {
    return t || e((t = { exports: {} }).exports, t), t.exports;
  } catch (n) {
    throw t = 0, n;
  }
}, Et = (e, t) => {
  for (var n in t)
    We(e, n, { get: t[n], enumerable: !0 });
}, uo = (e, t, n, r) => {
  if (t && typeof t == "object" || typeof t == "function")
    for (let o of ao(t))
      !lo.call(e, o) && o !== n && We(e, o, { get: () => t[o], enumerable: !(r = so(t, o)) || r.enumerable });
  return e;
};
var It = (e, t, n) => (n = e != null ? io(co(e)) : {}, uo(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  t || !e || !e.__esModule ? We(n, "default", { value: e, enumerable: !0 }) : n,
  e
));

// openclaw/packages/normalization-core/src/record-coerce.ts
function $(e) {
  return e !== null && typeof e == "object" && !Array.isArray(e);
}
function F(e) {
  return $(e) ? e : void 0;
}
function L(e) {
  return $(e) ? e : null;
}
function $e(e) {
  return e && typeof e == "object" ? e : void 0;
}
function ee(e) {
  return $e(e) ?? null;
}
var D = S(() => {
});

// openclaw/ui/src/components/browser/browser-target.ts
function Ve(e, t = 128) {
  return typeof e == "string" && e.length > 0 && e.length <= t && e.trim() === e;
}
function St(e) {
  let t = L(e);
  if (!Ve(t?.targetId) || !Ve(t.profile))
    return;
  let n = { targetId: t.targetId, profile: t.profile };
  if (t.target === "host" && t.node === void 0)
    return { ...n, target: "host" };
  if (t.target === "node" && Ve(t.node, 256))
    return { ...n, target: "node", node: t.node };
}
function At(e) {
  return JSON.stringify([e.target, e.node, e.profile, e.targetId]);
}
var Ke = S(() => {
  D();
});

// openclaw/packages/gateway-client/src/device-auth.ts
var vt = S(() => {
});

// openclaw/packages/gateway-client/src/chat-stream-message.ts
var Mt = S(() => {
  D();
});

// openclaw/packages/gateway-client/src/chat-stream-projection.ts
var Dt = S(() => {
  D();
});

// openclaw/packages/normalization-core/src/string-coerce.ts
function j(e) {
  if (typeof e != "string")
    return null;
  let t = e.trim();
  return t || null;
}
function G(e) {
  return j(e) ?? void 0;
}
function M(e) {
  return typeof e == "string" && e.trim() ? e : void 0;
}
var H = S(() => {
});

// openclaw/packages/normalization-core/src/number-coercion.ts
function te(e) {
  return typeof e == "number" && Number.isFinite(e) ? e : void 0;
}
var po, Za, ne = S(() => {
  H();
  po = 2147e6, Za = Math.floor(po / 1e3);
});

// openclaw/packages/normalization-core/src/string-normalization.ts
var Se = S(() => {
  H();
});

// openclaw/packages/gateway-protocol/src/connect-error-details.ts
var E, sc, ac, Je = S(() => {
  ne();
  Se();
  E = {
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
  }, sc = /* @__PURE__ */ new Map([
    ["token_missing", E.AUTH_TOKEN_MISSING],
    ["token_mismatch", E.AUTH_TOKEN_MISMATCH],
    ["token_missing_config", E.AUTH_TOKEN_NOT_CONFIGURED],
    ["password_missing", E.AUTH_PASSWORD_MISSING],
    ["password_mismatch", E.AUTH_PASSWORD_MISMATCH],
    ["password_missing_config", E.AUTH_PASSWORD_NOT_CONFIGURED],
    ["bootstrap_token_invalid", E.AUTH_BOOTSTRAP_TOKEN_INVALID],
    ["tailscale_user_missing", E.AUTH_TAILSCALE_IDENTITY_MISSING],
    ["tailscale_proxy_missing", E.AUTH_TAILSCALE_PROXY_MISSING],
    ["tailscale_whois_failed", E.AUTH_TAILSCALE_WHOIS_FAILED],
    ["tailscale_user_mismatch", E.AUTH_TAILSCALE_IDENTITY_MISMATCH],
    ["rate_limited", E.AUTH_RATE_LIMITED],
    ["device_token_mismatch", E.AUTH_DEVICE_TOKEN_MISMATCH],
    ["scope_mismatch", E.AUTH_SCOPE_MISMATCH],
    [void 0, E.AUTH_REQUIRED]
  ]), ac = /* @__PURE__ */ new Map([
    ["device-id-mismatch", E.DEVICE_AUTH_DEVICE_ID_MISMATCH],
    ["device-signature-stale", E.DEVICE_AUTH_SIGNATURE_EXPIRED],
    ["device-nonce-missing", E.DEVICE_AUTH_NONCE_REQUIRED],
    ["device-nonce-mismatch", E.DEVICE_AUTH_NONCE_MISMATCH],
    ["device-signature", E.DEVICE_AUTH_SIGNATURE_INVALID],
    ["device-public-key", E.DEVICE_AUTH_PUBLIC_KEY_INVALID]
  ]);
});

// openclaw/packages/gateway-client/src/connect-auth.ts
var Pt = S(() => {
  H();
});

// openclaw/packages/gateway-client/src/browser-device-auth.ts
var Ot = S(() => {
});

// openclaw/packages/gateway-client/src/gateway-origin-scope.ts
var Nt = S(() => {
});

// openclaw/packages/gateway-client/src/model-catalog-connect.ts
var Ft = S(() => {
});

// openclaw/packages/normalization-core/src/error-coercion.ts
var ho, Ut, Bt, Lt, Ye = S(() => {
  ho = /* @__PURE__ */ Symbol.for(
    "openclaw.provider-auth-persistence-error"
  ), Lt = class extends (Bt = AggregateError, Ut = ho, Bt) {
    constructor(n, r, { cause: o }) {
      super([r, o], n, { cause: o });
      this[Ut] = !0;
      this.persistenceError = r, this.cleanupError = o;
    }
  };
});

// openclaw/packages/retry/src/index.ts
function Ae(e, t, n, r) {
  return typeof e != "number" || !Number.isFinite(e) ? t : Math.min(
    Math.max(e, n ?? Number.NEGATIVE_INFINITY),
    r ?? Number.POSITIVE_INFINITY
  );
}
function he(e) {
  let t = e === Number.POSITIVE_INFINITY ? 2147e6 : Number.isFinite(e) ? e : 0;
  return Math.min(Math.max(Math.round(t), 0), 2147e6);
}
function mo(e = jt, t) {
  let n = Math.max(1, Math.round(Ae(t?.attempts, e.attempts))), r = he(
    Ae(t?.minDelayMs, e.minDelayMs, 0)
  ), o = Math.max(
    r,
    he(Ae(t?.maxDelayMs, e.maxDelayMs, 0))
  ), i = t?.jitter, s = e.jitter;
  return {
    attempts: n,
    minDelayMs: r,
    maxDelayMs: o,
    jitter: i === "full" ? i : typeof i == "number" && Number.isFinite(i) ? Math.min(Math.max(i, 0), 1) : s
  };
}
function yo(e, t, n, r) {
  if (t === "full")
    return n === "symmetric" ? Math.max(0, Math.round(e * (0.5 + r() * 0.5))) : Math.max(0, Math.ceil(e * (1 + r())));
  if (t <= 0)
    return n === "positive" ? Math.ceil(e) : e;
  let o = r(), i = n === "positive" ? o * t : (o * 2 - 1) * t, s = e * (1 + i);
  return Math.max(0, n === "positive" ? Math.ceil(s) : Math.round(s));
}
function bo(e, t = "Non-Error thrown") {
  if (e instanceof Error)
    return e;
  if (typeof e == "string")
    return new Error(e);
  let n = new Error(t, { cause: e });
  return (typeof e == "object" && e !== null || typeof e == "function") && Object.assign(n, e), n;
}
function wo(e = {}) {
  let t = e.sleep ?? go, n = e.random ?? Math.random, r = e.createFailure ?? ((o) => bo(o.at(-1) ?? new Error("Retry failed")));
  return async function(i, s = 3, a = 300) {
    let u = [], d = typeof s == "number", f = typeof s == "number" ? { attempts: s } : s, g = mo(jt, f), y = g.attempts, c = g.minDelayMs, l = g.maxDelayMs > 0 ? g.maxDelayMs : Number.POSITIVE_INFINITY, b = f.retryAfterMaxDelayMs === void 0 ? l : Math.max(
      c,
      he(Ae(f.retryAfterMaxDelayMs, l, 0))
    ), p = f.random ?? n, m = f.sleep ?? t, h = f.shouldRetry ?? (() => !0);
    for (let w = 1; w <= y; w += 1)
      try {
        return await i();
      } catch (R) {
        if (u.push(R), w >= y || e.shouldRetry?.(R) === !1 || !h(R, w))
          break;
        if (d) {
          await t(he(a * 2 ** (w - 1)));
          continue;
        }
        let C = {
          attempt: w,
          maxAttempts: y,
          err: R,
          label: f.label
        }, x = f.retryAfterMs?.(R), _ = typeof x == "number" && Number.isFinite(x), A = typeof f.delayMs == "function" ? f.delayMs(C) : f.delayMs, T = A === void 0 ? void 0 : he(A), v = _ ? Math.max(x, c) : T === void 0 ? c * 2 ** (w - 1) : Math.max(T, c), I = _ ? b : l, P = Math.min(v, I), B = _ && (x ?? 0) <= I, N = g.jitter === "full" && !_ || B;
        P = yo(
          P,
          g.jitter,
          N ? "positive" : "symmetric",
          p
        ), P = Math.min(Math.max(P, c), I), await f.onRetry?.({ ...C, delayMs: P }), P > 0 && await m(P);
      }
    throw r(u);
  };
}
var jt, go, gc, Gt = S(() => {
  jt = {
    attempts: 3,
    minDelayMs: 300,
    maxDelayMs: 3e4,
    jitter: 0
  }, go = async (e) => {
    let t = e;
    do {
      let n = Math.min(t, 2147e6);
      await new Promise((r) => {
        setTimeout(r, n);
      }), t -= n;
    } while (t > 0);
  };
  gc = wo();
});

// openclaw/packages/gateway-protocol/src/startup-unavailable.ts
var Ht = S(() => {
});

// openclaw/packages/gateway-client/src/protocol-client.ts
var Sc, qt = S(() => {
  Ye();
  D();
  Se();
  Gt();
  Sc = Object.freeze({ closeCode: 1008, closeReason: "connect failed" });
});

// openclaw/packages/gateway-client/src/reconnect-policy.ts
var Pc, zt = S(() => {
  Je();
  Pc = /* @__PURE__ */ new Set([
    E.AUTH_TOKEN_MISSING,
    E.AUTH_BOOTSTRAP_TOKEN_INVALID,
    E.AUTH_PASSWORD_MISSING,
    E.AUTH_PASSWORD_MISMATCH,
    E.AUTH_RATE_LIMITED,
    E.AUTH_DEVICE_TOKEN_MISMATCH,
    E.AUTH_SCOPE_MISMATCH,
    E.AUTH_IDENTITY_HEADER_REQUIRED,
    E.AUTH_VERIFIED_USER_REQUIRED,
    E.CONTROL_UI_BUILD_MISMATCH,
    E.PAIRING_REQUIRED,
    E.PAIRING_REJECTED,
    E.PAIRING_EXPIRED,
    E.CONTROL_UI_DEVICE_IDENTITY_REQUIRED,
    E.DEVICE_IDENTITY_REQUIRED
  ]);
});

// openclaw/packages/normalization-core/src/stable-stringify.ts
var Wt = S(() => {
});

// openclaw/packages/gateway-protocol/src/gateway-error-details.ts
var $t = S(() => {
});

// openclaw/packages/gateway-client/src/session-projection-message-identity.ts
function Vt(e) {
  return typeof e == "number" && Number.isSafeInteger(e) && e > 0 ? e : null;
}
function Kt(e, t) {
  let n = L(L(e)?.__openclaw);
  return Vt(n?.seq) ?? Vt(t?.messageSeq);
}
function ge(e) {
  let t = j(e);
  return t?.endsWith(":user") ? t.slice(0, -5) || null : t;
}
function Xe(e, t) {
  let n = L(e), r = j(n?.role)?.toLowerCase();
  if (!n || !r)
    return null;
  let o = L(n.__openclaw), i = j(o?.importedFrom), s = j(o?.cliSessionId), a = j(o?.externalId), u = L(o?.transcriptPosition), d = j(u?.source), g = !(d !== null && d.length <= 128 && typeof u?.rawSeq == "number" && Number.isSafeInteger(u.rawSeq) && u.rawSeq >= 0) && !!(i || s || a), y = j(o?.idempotencyKey) ?? j(n.idempotencyKey) ?? j(t?.idempotencyKey) ?? j(t?.clientRunId), c = ge(y), l = ge(t?.runId), b = ge(o?.runId), p = ge(
    L(n.openclawStreamFallback)?.runId
  ), m = j(o?.mirrorOrigin) !== null, h = r === "assistant" && j(n.api)?.toLowerCase() === "cli", w = h && c?.startsWith("cli-assistant:") ? j(c.slice(14)) : c, R = r === "assistant" ? b ?? l ?? p ?? (h || !m ? w : null) : b ?? w ?? l;
  return {
    role: r,
    id: j(o?.id) ?? j(t?.messageId),
    sequence: Kt(e, t),
    idempotencyKey: y,
    sendId: r === "user" ? c ?? R : null,
    runId: R,
    isImported: g,
    // Imported IDs belong to their provider and CLI session, never the native ID namespace.
    externalSource: g && i && s && a ? JSON.stringify([i, s, a]) : null
  };
}
var Jt = S(() => {
  D();
  H();
});

// openclaw/packages/gateway-client/src/session-projection.ts
var Yt = S(() => {
  D();
  H();
  Jt();
});

// openclaw/packages/normalization-core/src/result.ts
var Xt = S(() => {
});

// openclaw/packages/normalization-core/src/agent-id.ts
var Zt = S(() => {
  Xt();
});

// openclaw/packages/normalization-core/src/uuid.ts
var Qt = S(() => {
});

// openclaw/packages/gateway-client/src/session-subscriptions.ts
var en = S(() => {
  Zt();
  Qt();
});

// openclaw/packages/gateway-protocol/src/client-info.ts
var Ro, xo, ol, il, tn = S(() => {
  H();
  Ro = {
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
  }, xo = {
    WEBCHAT: "webchat",
    CLI: "cli",
    UI: "ui",
    BACKEND: "backend",
    NODE: "node",
    WORKER: "worker",
    PROBE: "probe",
    TEST: "test"
  }, ol = new Map(
    Object.values(Ro).map((e) => [e, e])
  ), il = new Map(
    Object.values(xo).map((e) => [e, e])
  );
});

// openclaw/packages/gateway-protocol/src/session-row-deltas.ts
var nn = S(() => {
});

// openclaw/packages/gateway-protocol/src/version.ts
var rn = S(() => {
});

// openclaw/packages/gateway-client/src/browser.ts
var on = S(() => {
  vt();
  Mt();
  Dt();
  Ot();
  Nt();
  Pt();
  Ft();
  qt();
  zt();
  Yt();
  en();
  tn();
  Je();
  $t();
  nn();
  Ht();
  rn();
});

// openclaw/packages/normalization-core/src/utf16-slice.ts
function an(e) {
  return e >= 55296 && e <= 56319;
}
function cn(e) {
  return e >= 56320 && e <= 57343;
}
function ko(e, t, n) {
  let r = e.length, o = t < 0 ? Math.max(r + t, 0) : Math.min(t, r), i = n === void 0 ? r : n < 0 ? Math.max(r + n, 0) : Math.min(n, r);
  if (i <= o)
    return "";
  if (o > 0 && o < r) {
    let s = e.charCodeAt(o);
    cn(s) && an(e.charCodeAt(o - 1)) && (o += 1);
  }
  if (i > 0 && i < r) {
    let s = e.charCodeAt(i - 1);
    an(s) && cn(e.charCodeAt(i)) && (i -= 1);
  }
  return e.slice(o, i);
}
function ce(e, t) {
  let n = Math.max(0, Math.floor(t));
  return e.length <= n ? e : ko(e, 0, n);
}
var le = S(() => {
});

// openclaw/node_modules/.pnpm/punycode.js@2.3.1/node_modules/punycode.js/punycode.js
var Xn = Tt((rp, Yn) => {
  "use strict";
  var mi = /^xn--/, yi = /[^\0-\x7F]/, bi = /[\x2E\u3002\uFF0E\uFF61]/g, wi = {
    overflow: "Overflow: input needs wider integers to process",
    "not-basic": "Illegal input >= 0x80 (not a basic code point)",
    "invalid-input": "Invalid input"
  }, pt = 35, V = Math.floor, ft = String.fromCharCode;
  function X(e) {
    throw new RangeError(wi[e]);
  }
  function Ri(e, t) {
    let n = [], r = e.length;
    for (; r--; )
      n[r] = t(e[r]);
    return n;
  }
  function Wn(e, t) {
    let n = e.split("@"), r = "";
    n.length > 1 && (r = n[0] + "@", e = n[1]), e = e.replace(bi, ".");
    let o = e.split("."), i = Ri(o, t).join(".");
    return r + i;
  }
  function $n(e) {
    let t = [], n = 0, r = e.length;
    for (; n < r; ) {
      let o = e.charCodeAt(n++);
      if (o >= 55296 && o <= 56319 && n < r) {
        let i = e.charCodeAt(n++);
        (i & 64512) == 56320 ? t.push(((o & 1023) << 10) + (i & 1023) + 65536) : (t.push(o), n--);
      } else
        t.push(o);
    }
    return t;
  }
  var xi = (e) => String.fromCodePoint(...e), Ci = function(e) {
    return e >= 48 && e < 58 ? 26 + (e - 48) : e >= 65 && e < 91 ? e - 65 : e >= 97 && e < 123 ? e - 97 : 36;
  }, zn = function(e, t) {
    return e + 22 + 75 * (e < 26) - ((t != 0) << 5);
  }, Vn = function(e, t, n) {
    let r = 0;
    for (e = n ? V(e / 700) : e >> 1, e += V(e / t); e > pt * 26 >> 1; r += 36)
      e = V(e / pt);
    return V(r + (pt + 1) * e / (e + 38));
  }, Kn = function(e) {
    let t = [], n = e.length, r = 0, o = 128, i = 72, s = e.lastIndexOf("-");
    s < 0 && (s = 0);
    for (let a = 0; a < s; ++a)
      e.charCodeAt(a) >= 128 && X("not-basic"), t.push(e.charCodeAt(a));
    for (let a = s > 0 ? s + 1 : 0; a < n; ) {
      let u = r;
      for (let f = 1, g = 36; ; g += 36) {
        a >= n && X("invalid-input");
        let y = Ci(e.charCodeAt(a++));
        y >= 36 && X("invalid-input"), y > V((2147483647 - r) / f) && X("overflow"), r += y * f;
        let c = g <= i ? 1 : g >= i + 26 ? 26 : g - i;
        if (y < c)
          break;
        let l = 36 - c;
        f > V(2147483647 / l) && X("overflow"), f *= l;
      }
      let d = t.length + 1;
      i = Vn(r - u, d, u == 0), V(r / d) > 2147483647 - o && X("overflow"), o += V(r / d), r %= d, t.splice(r++, 0, o);
    }
    return String.fromCodePoint(...t);
  }, Jn = function(e) {
    let t = [];
    e = $n(e);
    let n = e.length, r = 128, o = 0, i = 72;
    for (let u of e)
      u < 128 && t.push(ft(u));
    let s = t.length, a = s;
    for (s && t.push("-"); a < n; ) {
      let u = 2147483647;
      for (let f of e)
        f >= r && f < u && (u = f);
      let d = a + 1;
      u - r > V((2147483647 - o) / d) && X("overflow"), o += (u - r) * d, r = u;
      for (let f of e)
        if (f < r && ++o > 2147483647 && X("overflow"), f === r) {
          let g = o;
          for (let y = 36; ; y += 36) {
            let c = y <= i ? 1 : y >= i + 26 ? 26 : y - i;
            if (g < c)
              break;
            let l = g - c, b = 36 - c;
            t.push(
              ft(zn(c + l % b, 0))
            ), g = V(l / b);
          }
          t.push(ft(zn(g, 0))), i = Vn(o, d, a === s), o = 0, ++a;
        }
      ++o, ++r;
    }
    return t.join("");
  }, ki = function(e) {
    return Wn(e, function(t) {
      return mi.test(t) ? Kn(t.slice(4).toLowerCase()) : t;
    });
  }, _i = function(e) {
    return Wn(e, function(t) {
      return yi.test(t) ? "xn--" + Jn(t) : t;
    });
  }, Ti = {
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
      decode: $n,
      encode: xi
    },
    decode: Kn,
    encode: Jn,
    toASCII: _i,
    toUnicode: ki
  };
  Yn.exports = Ti;
});

// openclaw/node_modules/.pnpm/ipaddr.js@2.5.0/node_modules/ipaddr.js/lib/ipaddr.js
var Ar = Tt((Sr, qe) => {
  (function(e) {
    "use strict";
    let t = "(0?\\d+|0x[a-f0-9]+)", n = {
      fourOctet: new RegExp(`^${t}\\.${t}\\.${t}\\.${t}$`, "i"),
      threeOctet: new RegExp(`^${t}\\.${t}\\.${t}$`, "i"),
      twoOctet: new RegExp(`^${t}\\.${t}$`, "i"),
      longValue: new RegExp(`^${t}$`, "i")
    }, r = new RegExp("^0[0-7]+$", "i"), o = new RegExp("^0x[a-f0-9]+$", "i"), i = "%[0-9a-z]{1,}", s = "(?:[0-9a-f]+::?)+", a = {
      zoneIndex: new RegExp(i, "i"),
      native: new RegExp(`^(::)?(${s})?([0-9a-f]+)?(::)?(${i})?$`, "i"),
      deprecatedTransitional: new RegExp(`^(?:::)(${t}\\.${t}\\.${t}\\.${t}(${i})?)$`, "i"),
      transitional: new RegExp(`^((?:${s})|(?:::)(?:${s})?)${t}\\.${t}\\.${t}\\.${t}(${i})?$`, "i")
    };
    function u(c, l) {
      if (c.indexOf("::") !== c.lastIndexOf("::"))
        return null;
      let b = 0, p = -1, m = (c.match(a.zoneIndex) || [])[0], h, w;
      for (m && (m = m.substring(1), c = c.replace(/%.+$/, "")); (p = c.indexOf(":", p + 1)) >= 0; )
        b++;
      if (c.substr(0, 2) === "::" && b--, c.substr(-2, 2) === "::" && b--, b >= l)
        return null;
      for (w = l - b, h = ":"; w--; )
        h += "0:";
      return c = c.replace("::", h), c[0] === ":" && (c = c.slice(1)), c[c.length - 1] === ":" && (c = c.slice(0, -1)), l = (function() {
        let R = c.split(":"), C = [];
        for (let x = 0; x < R.length; x++)
          C.push(R[x].length > 4 ? NaN : parseInt(R[x], 16));
        return C;
      })(), {
        parts: l,
        zoneId: m
      };
    }
    function d(c, l, b, p) {
      if (c.length !== l.length)
        throw new Error("ipaddr: cannot match CIDR for objects with different lengths");
      let m = 0, h;
      for (; p > 0; ) {
        if (h = b - p, h < 0 && (h = 0), c[m] >> h !== l[m] >> h)
          return !1;
        p -= b, m += 1;
      }
      return !0;
    }
    function f(c) {
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
    let y = {};
    y.IPv4 = (function() {
      function c(l) {
        if (l.length !== 4)
          throw new Error("ipaddr: ipv4 octet count should be 4");
        let b, p;
        for (b = 0; b < l.length; b++)
          if (p = l[b], !(0 <= p && p <= 255))
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
      }, c.prototype.match = function(l, b) {
        let p;
        if (b === void 0 && (p = l, l = p[0], b = p[1]), l.kind() !== "ipv4")
          throw new Error("ipaddr: cannot match ipv4 address with non-ipv4 one");
        return d(this.octets, l.octets, 8, b);
      }, c.prototype.prefixLengthFromSubnetMask = function() {
        let l = 0, b = !1, p = {
          0: 8,
          128: 7,
          192: 6,
          224: 5,
          240: 4,
          248: 3,
          252: 2,
          254: 1,
          255: 0
        }, m, h, w;
        for (m = 3; m >= 0; m -= 1)
          if (h = this.octets[m], h in p) {
            if (w = p[h], b && w !== 0)
              return null;
            w !== 8 && (b = !0), l += w;
          } else
            return null;
        return 32 - l;
      }, c.prototype.range = function() {
        return y.subnetMatch(this, this.SpecialRanges);
      }, c.prototype.toByteArray = function() {
        return this.octets.slice(0);
      }, c.prototype.toIPv4MappedAddress = function() {
        return y.IPv6.parse(`::ffff:${this.toString()}`);
      }, c.prototype.toNormalizedString = function() {
        return this.toString();
      }, c.prototype.toString = function() {
        return this.octets.join(".");
      }, c;
    })(), y.IPv4.broadcastAddressFromCIDR = function(c) {
      try {
        let l = this.parseCIDR(c), b = l[0].toByteArray(), p = this.subnetMaskFromPrefixLength(l[1]).toByteArray(), m = [], h = 0;
        for (; h < 4; )
          m.push(parseInt(b[h], 10) | parseInt(p[h], 10) ^ 255), h++;
        return new this(m);
      } catch (l) {
        throw new Error("ipaddr: the address does not have IPv4 CIDR format", { cause: l });
      }
    }, y.IPv4.isIPv4 = function(c) {
      return this.parser(c) !== null;
    }, y.IPv4.isValid = function(c) {
      try {
        return new this(this.parser(c)), !0;
      } catch {
        return !1;
      }
    }, y.IPv4.isValidCIDR = function(c) {
      try {
        return this.parseCIDR(c), !0;
      } catch {
        return !1;
      }
    }, y.IPv4.isValidFourPartDecimal = function(c) {
      return !!(y.IPv4.isValid(c) && c.match(/^(0|[1-9]\d*)(\.(0|[1-9]\d*)){3}$/));
    }, y.IPv4.isValidCIDRFourPartDecimal = function(c) {
      let l = c.match(/^(.+)\/(\d+)$/);
      return !y.IPv4.isValidCIDR(c) || !l ? !1 : y.IPv4.isValidFourPartDecimal(l[1]);
    }, y.IPv4.networkAddressFromCIDR = function(c) {
      let l, b, p, m, h;
      try {
        for (l = this.parseCIDR(c), p = l[0].toByteArray(), h = this.subnetMaskFromPrefixLength(l[1]).toByteArray(), m = [], b = 0; b < 4; )
          m.push(parseInt(p[b], 10) & parseInt(h[b], 10)), b++;
        return new this(m);
      } catch (w) {
        throw new Error("ipaddr: the address does not have IPv4 CIDR format", { cause: w });
      }
    }, y.IPv4.parse = function(c) {
      let l = this.parser(c);
      if (l === null)
        throw new Error("ipaddr: string is not formatted like an IPv4 Address");
      return new this(l);
    }, y.IPv4.parseCIDR = function(c) {
      let l;
      if (l = c.match(/^(.+)\/(\d+)$/)) {
        let b = parseInt(l[2]);
        if (b >= 0 && b <= 32) {
          let p = [this.parse(l[1]), b];
          return Object.defineProperty(p, "toString", {
            value: function() {
              return this.join("/");
            }
          }), p;
        }
      }
      throw new Error("ipaddr: string is not formatted like an IPv4 CIDR range");
    }, y.IPv4.parser = function(c) {
      let l, b, p;
      if (l = c.match(n.fourOctet))
        return (function() {
          let m = l.slice(1, 6), h = [];
          for (let w = 0; w < m.length; w++)
            b = m[w], h.push(f(b));
          return h;
        })();
      if (l = c.match(n.longValue)) {
        if (p = f(l[1]), p > 4294967295 || p < 0)
          throw new Error("ipaddr: address outside defined range");
        return (function() {
          let m = [], h;
          for (h = 0; h <= 24; h += 8)
            m.push(p >> h & 255);
          return m;
        })().reverse();
      } else return (l = c.match(n.twoOctet)) ? (function() {
        let m = l.slice(1, 4), h = [];
        if (p = f(m[1]), p > 16777215 || p < 0)
          throw new Error("ipaddr: address outside defined range");
        return h.push(f(m[0])), h.push(p >> 16 & 255), h.push(p >> 8 & 255), h.push(p & 255), h;
      })() : (l = c.match(n.threeOctet)) ? (function() {
        let m = l.slice(1, 5), h = [];
        if (p = f(m[2]), p > 65535 || p < 0)
          throw new Error("ipaddr: address outside defined range");
        return h.push(f(m[0])), h.push(f(m[1])), h.push(p >> 8 & 255), h.push(p & 255), h;
      })() : null;
    }, y.IPv4.subnetMaskFromPrefixLength = function(c) {
      if (c = parseInt(c), Number.isNaN(c) || c < 0 || c > 32)
        throw new Error("ipaddr: invalid IPv4 prefix length");
      let l = [0, 0, 0, 0], b = 0, p = Math.floor(c / 8);
      for (; b < p; )
        l[b] = 255, b++;
      return p < 4 && (l[p] = Math.pow(2, c % 8) - 1 << 8 - c % 8), new this(l);
    }, y.IPv6 = (function() {
      function c(l, b) {
        let p, m;
        if (l.length === 16)
          for (this.parts = [], p = 0; p <= 14; p += 2)
            this.parts.push(l[p] << 8 | l[p + 1]);
        else if (l.length === 8)
          this.parts = l;
        else
          throw new Error("ipaddr: ipv6 part count should be 8 or 16");
        for (p = 0; p < this.parts.length; p++)
          if (m = this.parts[p], !(0 <= m && m <= 65535))
            throw new Error("ipaddr: ipv6 part should fit in 16 bits");
        b && (this.zoneId = b);
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
      }, c.prototype.match = function(l, b) {
        let p;
        if (b === void 0 && (p = l, l = p[0], b = p[1]), l.kind() !== "ipv6")
          throw new Error("ipaddr: cannot match ipv6 address with non-ipv6 one");
        return d(this.parts, l.parts, 16, b);
      }, c.prototype.prefixLengthFromSubnetMask = function() {
        let l = 0, b = !1, p = {
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
        }, m, h;
        for (let w = 7; w >= 0; w -= 1)
          if (m = this.parts[w], m in p) {
            if (h = p[m], b && h !== 0)
              return null;
            h !== 16 && (b = !0), l += h;
          } else
            return null;
        return 128 - l;
      }, c.prototype.range = function() {
        return y.subnetMatch(this, this.SpecialRanges);
      }, c.prototype.toByteArray = function() {
        let l, b = [], p = this.parts;
        for (let m = 0; m < p.length; m++)
          l = p[m], b.push(l >> 8), b.push(l & 255);
        return b;
      }, c.prototype.toFixedLengthString = function() {
        let l = (function() {
          let p = [];
          for (let m = 0; m < this.parts.length; m++)
            p.push(g(this.parts[m].toString(16), 4));
          return p;
        }).call(this).join(":"), b = "";
        return this.zoneId && (b = `%${this.zoneId}`), l + b;
      }, c.prototype.toIPv4Address = function() {
        if (!this.isIPv4MappedAddress())
          throw new Error("ipaddr: trying to convert a generic ipv6 address to ipv4");
        let l = this.parts.slice(-2), b = l[0], p = l[1];
        return new y.IPv4([b >> 8, b & 255, p >> 8, p & 255]);
      }, c.prototype.toNormalizedString = function() {
        let l = (function() {
          let p = [];
          for (let m = 0; m < this.parts.length; m++)
            p.push(this.parts[m].toString(16));
          return p;
        }).call(this).join(":"), b = "";
        return this.zoneId && (b = `%${this.zoneId}`), l + b;
      }, c.prototype.toRFC5952String = function() {
        let l = /((^|:)(0(:|$)){2,})/g, b = "";
        this.zoneId && (b = `%${this.zoneId}`);
        let p = this.toNormalizedString(), m = p.slice(0, p.length - b.length), h = 0, w = -1, R = -1, C;
        for (; C = l.exec(m); ) {
          let x = (C[0].match(/0/g) || []).length;
          x > R && (R = x, h = C.index, w = C[0].length);
        }
        return w < 0 ? m + b : `${m.substring(0, h)}::${m.substring(h + w)}${b}`;
      }, c.prototype.toString = function() {
        return this.toRFC5952String();
      }, c;
    })(), y.IPv6.broadcastAddressFromCIDR = function(c) {
      try {
        let l = this.parseCIDR(c), b = l[0].toByteArray(), p = this.subnetMaskFromPrefixLength(l[1]).toByteArray(), m = [], h = 0;
        for (; h < 16; )
          m.push(parseInt(b[h], 10) | parseInt(p[h], 10) ^ 255), h++;
        return new this(m);
      } catch (l) {
        throw new Error("ipaddr: the address does not have IPv6 CIDR format", { cause: l });
      }
    }, y.IPv6.isIPv6 = function(c) {
      return this.parser(c) !== null;
    }, y.IPv6.isValid = function(c) {
      if (typeof c == "string" && c.indexOf(":") === -1)
        return !1;
      try {
        let l = this.parser(c);
        return new this(l.parts, l.zoneId), !0;
      } catch {
        return !1;
      }
    }, y.IPv6.isValidCIDR = function(c) {
      if (typeof c == "string" && c.indexOf(":") === -1)
        return !1;
      try {
        return this.parseCIDR(c), !0;
      } catch {
        return !1;
      }
    }, y.IPv6.networkAddressFromCIDR = function(c) {
      let l, b, p, m, h;
      try {
        for (l = this.parseCIDR(c), p = l[0].toByteArray(), h = this.subnetMaskFromPrefixLength(l[1]).toByteArray(), m = [], b = 0; b < 16; )
          m.push(parseInt(p[b], 10) & parseInt(h[b], 10)), b++;
        return new this(m);
      } catch (w) {
        throw new Error("ipaddr: the address does not have IPv6 CIDR format", { cause: w });
      }
    }, y.IPv6.parse = function(c) {
      let l = this.parser(c);
      if (l === null)
        throw new Error("ipaddr: string is not formatted like an IPv6 Address");
      return new this(l.parts, l.zoneId);
    }, y.IPv6.parseCIDR = function(c) {
      let l, b, p;
      if ((b = c.match(/^(.+)\/(\d+)$/)) && (l = parseInt(b[2]), l >= 0 && l <= 128))
        return p = [this.parse(b[1]), l], Object.defineProperty(p, "toString", {
          value: function() {
            return this.join("/");
          }
        }), p;
      throw new Error("ipaddr: string is not formatted like an IPv6 CIDR range");
    }, y.IPv6.parser = function(c) {
      let l, b, p, m, h, w;
      if (p = c.match(a.deprecatedTransitional))
        return this.parser(`::ffff:${p[1]}`);
      if (a.native.test(c))
        return u(c, 8);
      if ((p = c.match(a.transitional)) && (w = p[6] || "", l = p[1], p[1].endsWith("::") || (l = l.slice(0, -1)), l = u(l + w, 6), l && l.parts)) {
        for (h = [
          parseInt(p[2]),
          parseInt(p[3]),
          parseInt(p[4]),
          parseInt(p[5])
        ], b = 0; b < h.length; b++)
          if (m = h[b], !(0 <= m && m <= 255))
            return null;
        return l.parts.push(h[0] << 8 | h[1]), l.parts.push(h[2] << 8 | h[3]), {
          parts: l.parts,
          zoneId: l.zoneId
        };
      }
      return null;
    }, y.IPv6.subnetMaskFromPrefixLength = function(c) {
      if (c = parseInt(c), Number.isNaN(c) || c < 0 || c > 128)
        throw new Error("ipaddr: invalid IPv6 prefix length");
      let l = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], b = 0, p = Math.floor(c / 8);
      for (; b < p; )
        l[b] = 255, b++;
      return p < 16 && (l[p] = Math.pow(2, c % 8) - 1 << 8 - c % 8), new this(l);
    }, y.fromByteArray = function(c) {
      let l = c.length;
      if (l === 4)
        return new y.IPv4(c);
      if (l === 16)
        return new y.IPv6(c);
      throw new Error("ipaddr: the binary input is neither an IPv6 nor IPv4 address");
    }, y.isValid = function(c) {
      return y.IPv6.isValid(c) || y.IPv4.isValid(c);
    }, y.isValidCIDR = function(c) {
      return y.IPv6.isValidCIDR(c) || y.IPv4.isValidCIDR(c);
    }, y.parse = function(c) {
      if (y.IPv6.isValid(c))
        return y.IPv6.parse(c);
      if (y.IPv4.isValid(c))
        return y.IPv4.parse(c);
      throw new Error("ipaddr: the address has neither IPv6 nor IPv4 format");
    }, y.parseCIDR = function(c) {
      try {
        return y.IPv6.parseCIDR(c);
      } catch {
        try {
          return y.IPv4.parseCIDR(c);
        } catch (l) {
          throw new Error("ipaddr: the address has neither IPv6 nor IPv4 CIDR format", { cause: l });
        }
      }
    }, y.process = function(c) {
      let l = this.parse(c);
      return l.kind() === "ipv6" && l.isIPv4MappedAddress() ? l.toIPv4Address() : l;
    }, y.subnetMatch = function(c, l, b) {
      let p, m, h, w;
      b == null && (b = "unicast");
      for (m in l)
        if (Object.prototype.hasOwnProperty.call(l, m)) {
          for (h = l[m], h[0] && !(h[0] instanceof Array) && (h = [h]), p = 0; p < h.length; p++)
            if (w = h[p], c.kind() === w[0].kind() && c.match.apply(c, w))
              return m;
        }
      return b;
    }, typeof qe < "u" && qe.exports ? qe.exports = y : e.ipaddr = y;
  })(Sr);
});

// openclaw/ui/src/i18n/locales/en-agents.ts
var Pr, Or, Nr, Fr = S(() => {
  Pr = {
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
  }, Or = {
    label: "Agent",
    allAgents: "All agents"
  }, Nr = {
    pinToSwitcher: "Pin to switcher",
    unpinFromSwitcher: "Unpin from switcher"
  };
});

// openclaw/ui/src/i18n/locales/en.ts
var aa, fe, kt = S(() => {
  Fr();
  aa = {
    pluginUi: {
      retryView: "Retry plugin view",
      inlineLoading: "Loading plugin view\u2026",
      inlineUnavailable: "This view is unavailable. Check that its plugin is installed, enabled, and allowed for your account. Reload the conversation after installing or updating the plugin.",
      dashboardTitle: "Session dashboard",
      customPluginsDisabled: "Custom plugin UI is off",
      customPluginsEnableHint: "Disabled by the Gateway configuration. An administrator can enable native plugin UI.",
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
      resizeMessageWidth: "Resize message width",
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
      runtime: {},
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
      bootDraftRecovery: "Copy the draft below before clearing it and reloading.",
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
    agentChip: Pr,
    agentScope: Or,
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
      snoozeTomorrow: "Tomorrow",
      user: "User",
      assistant: "Assistant",
      opensAsDashboard: "Opens as dashboard",
      approvalNeeded: "Approval needed",
      messageNeedsAttention: "{count} message needs attention",
      messagesNeedAttention: "{count} messages need attention",
      unsentDraft: "Unsent draft",
      noArchivedSessions: "No archived sessions.",
      status: "Status",
      all: "All",
      snoozed: "Snoozed",
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
      runErrorTimedOut: "Timed out",
      runErrorUnknown: "Unknown error",
      attentionRequired: "Session needs attention",
      openSession: "Open session",
      provider: "Provider",
      lastActive: "Last active {time}",
      activeRun: "Active run",
      backgroundWorkRunning: "Background work running",
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
      ...Nr,
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
      reviewOnly: "You don\u2019t have permission to approve.",
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
        configReadOnly: "Gateway configuration is read-only.",
        configReadOnlyHint: "To make changes, update the configuration file or deployment settings for this Gateway.",
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
      templates: "Templates",
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
      menu: {
        label: "Actions for {name}",
        pin: "Pin to sidebar",
        unpin: "Unpin from sidebar",
        openNewTab: "Open activity in new tab",
        copyLink: "Copy activity link"
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
      providerUsage: {},
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
      waitingOnSessions: "Waiting on {count} sessions",
      sessionsNeedInputOne: "1 needs your input",
      sessionsNeedInput: "{count} need your input",
      sessionsPaused: "{count} paused",
      sessionPausedNote: "{name} is paused",
      sessionsPausedNote: "{count} sessions are paused",
      handoffResumed: "Resumed \xB7 {duration} Later",
      handoffSessionsOne: "1 Session",
      handoffSessions: "{count} Sessions",
      handoffSessionStatus: {
        attention: "Needs your input",
        paused: "Paused",
        running: "Running",
        failed: "Failed",
        stopped: "Stopped",
        done: "Done"
      },
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
        waitingForTurn: "Waiting for turn to start",
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
        scrollToLatest: "Scroll to latest",
        skipToComposer: "Skip to message composer"
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
      systemNotice: {
        guardian: {},
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
  }, fe = aa;
});

// octogee/app/openclaw-islands/i18n.ts
var Lr = S(() => {
  kt();
});

// openclaw/ui/src/lib/chat/browser-tab-preview.ts
D();
Ke();

// openclaw/ui/src/lib/chat/tool-cards.ts
on();

// openclaw/packages/net-policy/src/url-protocol.ts
function Co(e) {
  return e instanceof URL ? e : URL.parse(e);
}
function sn(e) {
  let t = Co(e);
  return t?.protocol === "http:" || t?.protocol === "https:";
}

// openclaw/packages/normalization-core/src/cjk-chars.ts
var Ze = [
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
], vl = new RegExp(
  `[${Ze.flatMap(
    (e) => e.map(([t, n]) => `\\u{${t.toString(16)}}-\\u{${n.toString(16)}}`)
  ).join("")}]`,
  "u"
), Ml = (() => {
  let e = Math.max(
    ...Ze.flatMap((n) => n.map(([, r]) => r))
  ), t = new Uint8Array(e + 1);
  for (let [n, r] of Ze.entries())
    for (let [o, i] of r)
      t.fill(n + 1, o, i + 1);
  return t;
})();

// openclaw/packages/normalization-core/src/index.ts
Ye();

// openclaw/packages/normalization-core/src/json-coercion.ts
D();
function Qe(e) {
  try {
    return JSON.parse(e);
  } catch {
    return;
  }
}
function re(e) {
  return /^[\t\n\r ]*\{/.test(e) ? F(Qe(e)) : void 0;
}

// openclaw/packages/normalization-core/src/index.ts
ne();
D();
Wt();
H();
Se();
le();

// openclaw/ui/src/lib/chat/tool-cards.ts
D();
H();
le();

// openclaw/src/agents/tool-display-call.ts
D();

// openclaw/src/chat/canvas-render.ts
ne();
D();
H();
function _o(e) {
  let t = M(e?.viewId);
  if (!t || t.length > 128)
    return;
  let n = M(e?.serverName), r = M(e?.toolName), o = M(e?.uiResourceUri), i = M(e?.toolCallId), s = M(e?.originSessionKey), a = e?.resultMetaState === "unavailable" ? "unavailable" : void 0;
  return !!(n && n.length <= 256 && r && r.length <= 256 && o?.startsWith("ui://") && o.length <= 2048 && i && i.length <= 512) ? {
    viewId: t,
    serverName: n,
    toolName: r,
    uiResourceUri: o,
    toolCallId: i,
    ...s && s.length <= 512 ? { originSessionKey: s } : {},
    ...a ? { resultMetaState: a } : {}
  } : { viewId: t };
}
function To(e) {
  return typeof e == "number" && Number.isFinite(e) && e >= 160 ? Math.min(Math.trunc(e), 1200) : void 0;
}
function un(e) {
  return typeof e == "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/u.test(e);
}
function dn(e) {
  let t = F(e);
  if (!t || M(t?.kind)?.trim().toLowerCase() !== "canvas")
    return;
  let r = F(t.presentation), o = F(t.view), i = F(t.source), s = _o(F(t.mcpApp)), a = s?.viewId, d = M(r?.target) ?? M(t?.target) ?? "assistant_message";
  if (d !== "assistant_message" && d !== "node_panel")
    return;
  let f = M(r?.title) ?? M(o?.title), g = To(
    te(r?.preferred_height) ?? te(r?.preferredHeight) ?? te(o?.preferred_height) ?? te(o?.preferredHeight)
  ), y = M(r?.class_name) ?? M(r?.className), c = M(r?.style), l = M(r?.sandbox), b = M(o?.url) ?? M(o?.entryUrl), p = M(o?.id) ?? M(o?.docId), m = M(o?.boardWidgetName), h = un(m) ? m : void 0, w = {
    kind: "canvas",
    surface: d,
    render: "url",
    ...f ? { title: f } : {},
    ...g ? { preferredHeight: g } : {},
    ...l === "strict" || l === "scripts" ? { sandbox: l } : {},
    ...s ? { mcpApp: s } : {}
  };
  if (a && p === a)
    return { ...w, viewId: p };
  let R = b ?? (M(i?.type)?.trim().toLowerCase() === "url" ? M(i?.url) : void 0);
  if (R)
    return {
      ...w,
      url: R,
      ...b && p ? { viewId: p } : {},
      ...y ? { className: y } : {},
      ...c ? { style: c } : {},
      ...b && h ? { boardWidgetName: h } : {}
    };
}
function pn(e) {
  let t = F(e);
  return dn(t?.mcpAppPreview);
}
function fn(e) {
  let t = e ? re(e) : void 0;
  return dn(t);
}

// openclaw/src/chat/tool-content.ts
H();
var Eo = [
  "id",
  "tool_call_id",
  "toolCallId",
  "tool_use_id",
  "toolUseId"
];
function hn(e) {
  return typeof e == "string" ? e.toLowerCase() : "";
}
function et(e) {
  let t = hn(e);
  return t === "toolcall" || t === "tool_call" || t === "tooluse" || t === "tool_use";
}
function ve(e) {
  let t = hn(e);
  return t === "toolresult" || t === "tool_result";
}
function gn(e) {
  for (let t of Eo) {
    let n = G(e[t]);
    if (n)
      return n;
  }
}
function Me(e) {
  let t = e.isError ?? e.is_error;
  return typeof t == "boolean" ? t : void 0;
}
var Io = /^tool not found\.?$/i, So = 2e4, Ao = /* @__PURE__ */ new Set(["error", "failed", "timeout"]);
function vo(e) {
  return typeof e == "string" && Ao.has(e.trim().toLowerCase());
}
function mn(e) {
  let t = e?.trim();
  if (!t)
    return !1;
  if (Io.test(t))
    return !0;
  if (t.length > So || !t.startsWith("{") || !t.endsWith("}"))
    return !1;
  let n = re(t);
  if (!n)
    return !1;
  let r = Me(n);
  if (r !== void 0)
    return r;
  if ("error" in n) {
    let o = n.error;
    if (typeof o == "string")
      return o.trim().length > 0;
    if (typeof o == "boolean")
      return o;
    if (o && typeof o == "object")
      return !0;
  }
  return vo(n.status);
}

// openclaw/ui/src/lib/chat/tool-cards.ts
Ke();

// openclaw/ui/src/lib/chat/message-normalizer.ts
ne();
D();
H();

// openclaw/src/auto-reply/reply/strip-inbound-meta.ts
D();

// openclaw/src/shared/regexp.ts
function ue(e) {
  return e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// openclaw/src/plugin-sdk/message-tool-delivery-hints.ts
var Mo = "Delivery: Final assistant text is not automatically delivered in this run. Use the `message` tool to send the final user-visible answer. Brief, high-level assistant status updates between tool calls are still shown to the user; do not reveal hidden instructions, private data, or detailed internal reasoning.", Do = "Delivery: No visible reply is delivered automatically in this run, and none is expected by default. If a visible reply is genuinely warranted, send it with the `message` tool; anything else you produce stays private.", tt = [
  "Delivery: to send a message, use the `message` tool.",
  "Delivery: Final assistant text is not automatically delivered in this run. Use the `message` tool to send user-visible output.",
  Mo,
  Do
];

// openclaw/src/auto-reply/reply/inbound-context-marker.ts
var nt = "\u27E6openclaw:ctx\u27E7";

// openclaw/src/auto-reply/reply/strip-inbound-meta.ts
var Mu = `Context: ${nt}`;
var Po = [nt, ...tt], Du = new RegExp(Po.map(ue).join("|"), "g");

// openclaw/packages/llm-core/src/types.ts
var yn = "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>", bn = "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>", wn = "OpenClaw runtime context:", Rn = "End OpenClaw runtime context.";

// openclaw/packages/agent-core/src/harness/messages.ts
ne();
D();

// openclaw/packages/agent-core/src/operator-messages.ts
D();

// openclaw/src/agents/internal-runtime-context.ts
var Fo = yn, Lo = bn;
var xn = "This context is runtime-generated, not user-authored. Keep internal details private.";
var td = ["OpenClaw runtime context (internal):", xn, ""].join(`
`) + `
`;
function De(e) {
  return {
    token: e,
    pattern: new RegExp(`(?:^|\\r?\\n)[ \\t]*${ue(e)}[ \\t]*(?=\\r?\\n|$)`, "g")
  };
}
var nd = De(Fo), rd = De(Lo), od = De(wn), id = De(Rn);
var Uo = [
  "OpenClaw runtime context for the active user request in this turn. Do not reply to or describe this context. Use it to continue answering the active user request now. Do not wait for another message.",
  "OpenClaw runtime context for the immediately preceding user message.",
  "OpenClaw runtime event."
], Bo = new RegExp(
  Uo.flatMap((e) => {
    let t = e.split(". ");
    return t.map((n, r) => t.slice(r).join(". "));
  }).map((e) => e.split(/\s+/).map(ue).join("\\s+")).join("|")
), jo = new RegExp(
  xn.split(/\s+/).map(ue).join("\\s+")
), sd = new RegExp(
  `^[ \\t]*(?:${Bo.source})\\s+${jo.source}[ \\t]*(?:\\r?\\n|$)`,
  "gm"
);

// openclaw/src/chat/message-client-source.ts
D();
H();
le();

// openclaw/src/chat/session-catalog-display.ts
D();
le();

// openclaw/src/chat/work-context.ts
D();
le();

// openclaw/node_modules/.pnpm/mdurl@2.1.0/node_modules/mdurl/index.mjs
var rt = {};
Et(rt, {
  decode: () => be,
  encode: () => Y,
  format: () => de,
  parse: () => we
});

// openclaw/node_modules/.pnpm/mdurl@2.1.0/node_modules/mdurl/lib/decode.mjs
var kn = {};
function Ho(e) {
  let t = kn[e];
  if (t)
    return t;
  t = kn[e] = [];
  for (let n = 0; n < 128; n++) {
    let r = String.fromCharCode(n);
    t.push(r);
  }
  for (let n = 0; n < e.length; n++) {
    let r = e.charCodeAt(n);
    t[r] = "%" + ("0" + r.toString(16).toUpperCase()).slice(-2);
  }
  return t;
}
function Pe(e, t) {
  typeof t != "string" && (t = Pe.defaultChars);
  let n = Ho(t);
  return e.replace(/(%[a-f0-9]{2})+/gi, function(r) {
    let o = "";
    for (let i = 0, s = r.length; i < s; i += 3) {
      let a = parseInt(r.slice(i + 1, i + 3), 16);
      if (a < 128) {
        o += n[a];
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
          let f = a << 12 & 61440 | u << 6 & 4032 | d & 63;
          f < 2048 || f >= 55296 && f <= 57343 ? o += "\uFFFD\uFFFD\uFFFD" : o += String.fromCharCode(f), i += 6;
          continue;
        }
      }
      if ((a & 248) === 240 && i + 9 < s) {
        let u = parseInt(r.slice(i + 4, i + 6), 16), d = parseInt(r.slice(i + 7, i + 9), 16), f = parseInt(r.slice(i + 10, i + 12), 16);
        if ((u & 192) === 128 && (d & 192) === 128 && (f & 192) === 128) {
          let g = a << 18 & 1835008 | u << 12 & 258048 | d << 6 & 4032 | f & 63;
          g < 65536 || g > 1114111 ? o += "\uFFFD\uFFFD\uFFFD\uFFFD" : (g -= 65536, o += String.fromCharCode(55296 + (g >> 10), 56320 + (g & 1023))), i += 9;
          continue;
        }
      }
      o += "\uFFFD";
    }
    return o;
  });
}
Pe.defaultChars = ";/?:@&=+$,#";
Pe.componentChars = "";
var be = Pe;

// openclaw/node_modules/.pnpm/mdurl@2.1.0/node_modules/mdurl/lib/encode.mjs
var _n = {};
function qo(e) {
  let t = _n[e];
  if (t)
    return t;
  t = _n[e] = [];
  for (let n = 0; n < 128; n++) {
    let r = String.fromCharCode(n);
    /^[0-9a-z]$/i.test(r) ? t.push(r) : t.push("%" + ("0" + n.toString(16).toUpperCase()).slice(-2));
  }
  for (let n = 0; n < e.length; n++)
    t[e.charCodeAt(n)] = e[n];
  return t;
}
function Oe(e, t, n) {
  typeof t != "string" && (n = t, t = Oe.defaultChars), typeof n > "u" && (n = !0);
  let r = qo(t), o = "";
  for (let i = 0, s = e.length; i < s; i++) {
    let a = e.charCodeAt(i);
    if (n && a === 37 && i + 2 < s && /^[0-9a-f]{2}$/i.test(e.slice(i + 1, i + 3))) {
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
Oe.defaultChars = ";/?:@&=+$,-_.!~*'()#";
Oe.componentChars = "-_.!~*'()";
var Y = Oe;

// openclaw/node_modules/.pnpm/mdurl@2.1.0/node_modules/mdurl/lib/format.mjs
function de(e) {
  let t = "";
  return t += e.protocol || "", t += e.slashes ? "//" : "", t += e.auth ? e.auth + "@" : "", e.hostname && e.hostname.indexOf(":") !== -1 ? t += "[" + e.hostname + "]" : t += e.hostname || "", t += e.port ? ":" + e.port : "", t += e.pathname || "", t += e.search || "", t += e.hash || "", t;
}

// openclaw/node_modules/.pnpm/mdurl@2.1.0/node_modules/mdurl/lib/parse.mjs
function Ne() {
  this.protocol = null, this.slashes = null, this.auth = null, this.port = null, this.hostname = null, this.hash = null, this.search = null, this.pathname = null;
}
var zo = /^([a-z0-9.+-]+:)/i, Wo = /:[0-9]*$/, $o = /^(\/\/?(?!\/)[^\?\s]*)(\?[^\s]*)?$/, Vo = ["<", ">", '"', "`", " ", "\r", `
`, "	"], Ko = ["{", "}", "|", "\\", "^", "`"].concat(Vo), Jo = ["'"].concat(Ko), Tn = ["%", "/", "?", ";", "#"].concat(Jo), En = ["/", "?", "#"], Yo = 255, In = /^[+a-z0-9A-Z_-]{0,63}$/, Xo = /^([+a-z0-9A-Z_-]{0,63})(.*)$/, Sn = {
  javascript: !0,
  "javascript:": !0
}, An = {
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
function Zo(e, t) {
  if (e && e instanceof Ne) return e;
  let n = new Ne();
  return n.parse(e, t), n;
}
Ne.prototype.parse = function(e, t) {
  let n, r, o, i = e;
  if (i = i.trim(), !t && e.split("#").length === 1) {
    let d = $o.exec(i);
    if (d)
      return this.pathname = d[1], d[2] && (this.search = d[2]), this;
  }
  let s = zo.exec(i);
  if (s && (s = s[0], n = s.toLowerCase(), this.protocol = s, i = i.substr(s.length)), (t || s || i.match(/^\/\/[^@\/]+@[^@\/]+/)) && (o = i.substr(0, 2) === "//", o && !(s && Sn[s]) && (i = i.substr(2), this.slashes = !0)), !Sn[s] && (o || s && !An[s])) {
    let d = -1;
    for (let l = 0; l < En.length; l++)
      r = i.indexOf(En[l]), r !== -1 && (d === -1 || r < d) && (d = r);
    let f, g;
    d === -1 ? g = i.lastIndexOf("@") : g = i.lastIndexOf("@", d), g !== -1 && (f = i.slice(0, g), i = i.slice(g + 1), this.auth = f), d = -1;
    for (let l = 0; l < Tn.length; l++)
      r = i.indexOf(Tn[l]), r !== -1 && (d === -1 || r < d) && (d = r);
    d === -1 && (d = i.length), i[d - 1] === ":" && d--;
    let y = i.slice(0, d);
    i = i.slice(d), this.parseHost(y), this.hostname = this.hostname || "";
    let c = this.hostname[0] === "[" && this.hostname[this.hostname.length - 1] === "]";
    if (!c) {
      let l = this.hostname.split(/\./);
      for (let b = 0, p = l.length; b < p; b++) {
        let m = l[b];
        if (m && !m.match(In)) {
          let h = "";
          for (let w = 0, R = m.length; w < R; w++)
            m.charCodeAt(w) > 127 ? h += "x" : h += m[w];
          if (!h.match(In)) {
            let w = l.slice(0, b), R = l.slice(b + 1), C = m.match(Xo);
            C && (w.push(C[1]), R.unshift(C[2])), R.length && (i = R.join(".") + i), this.hostname = w.join(".");
            break;
          }
        }
      }
    }
    this.hostname.length > Yo && (this.hostname = ""), c && (this.hostname = this.hostname.substr(1, this.hostname.length - 2));
  }
  let a = i.indexOf("#");
  a !== -1 && (this.hash = i.substr(a), i = i.slice(0, a));
  let u = i.indexOf("?");
  return u !== -1 && (this.search = i.substr(u), i = i.slice(0, u)), i && (this.pathname = i), An[n] && this.hostname && !this.pathname && (this.pathname = ""), this;
};
Ne.prototype.parseHost = function(e) {
  let t = Wo.exec(e);
  t && (t = t[0], t !== ":" && (this.port = t.substr(1)), e = e.substr(0, e.length - t.length)), e && (this.hostname = e);
};
var we = Zo;

// openclaw/node_modules/.pnpm/uc.micro@3.0.0/node_modules/uc.micro/build/index.mjs
var ct = {};
Et(ct, {
  Any: () => ot,
  Cc: () => it,
  Cf: () => Qo,
  P: () => Re,
  S: () => st,
  Z: () => at
});
var ot = /[\0-\uD7FF\uE000-\uFFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/, it = /[\0-\x1F\x7F-\x9F]/, Qo = /[\xAD\u0600-\u0605\u061C\u06DD\u070F\u0890\u0891\u08E2\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFFF9-\uFFFB]|\uD804[\uDCBD\uDCCD]|\uD80D[\uDC30-\uDC3F]|\uD82F[\uDCA0-\uDCA3]|\uD834[\uDD73-\uDD7A]|\uDB40[\uDC01\uDC20-\uDC7F]/, Re = /[!-#%-\*,-\/:;\?@\[-\]_\{\}\xA1\xA7\xAB\xB6\xB7\xBB\xBF\u037E\u0387\u055A-\u055F\u0589\u058A\u05BE\u05C0\u05C3\u05C6\u05F3\u05F4\u0609\u060A\u060C\u060D\u061B\u061D-\u061F\u066A-\u066D\u06D4\u0700-\u070D\u07F7-\u07F9\u0830-\u083E\u085E\u0964\u0965\u0970\u09FD\u0A76\u0AF0\u0C77\u0C84\u0DF4\u0E4F\u0E5A\u0E5B\u0F04-\u0F12\u0F14\u0F3A-\u0F3D\u0F85\u0FD0-\u0FD4\u0FD9\u0FDA\u104A-\u104F\u10FB\u1360-\u1368\u1400\u166E\u169B\u169C\u16EB-\u16ED\u1735\u1736\u17D4-\u17D6\u17D8-\u17DA\u1800-\u180A\u1944\u1945\u1A1E\u1A1F\u1AA0-\u1AA6\u1AA8-\u1AAD\u1B4E\u1B4F\u1B5A-\u1B60\u1B7D-\u1B7F\u1BFC-\u1BFF\u1C3B-\u1C3F\u1C7E\u1C7F\u1CC0-\u1CC7\u1CD3\u2010-\u2027\u2030-\u2043\u2045-\u2051\u2053-\u205E\u207D\u207E\u208D\u208E\u2308-\u230B\u2329\u232A\u2768-\u2775\u27C5\u27C6\u27E6-\u27EF\u2983-\u2998\u29D8-\u29DB\u29FC\u29FD\u2CF9-\u2CFC\u2CFE\u2CFF\u2D70\u2E00-\u2E2E\u2E30-\u2E4F\u2E52-\u2E5D\u3001-\u3003\u3008-\u3011\u3014-\u301F\u3030\u303D\u30A0\u30FB\uA4FE\uA4FF\uA60D-\uA60F\uA673\uA67E\uA6F2-\uA6F7\uA874-\uA877\uA8CE\uA8CF\uA8F8-\uA8FA\uA8FC\uA92E\uA92F\uA95F\uA9C1-\uA9CD\uA9DE\uA9DF\uAA5C-\uAA5F\uAADE\uAADF\uAAF0\uAAF1\uABEB\uFD3E\uFD3F\uFE10-\uFE19\uFE30-\uFE52\uFE54-\uFE61\uFE63\uFE68\uFE6A\uFE6B\uFF01-\uFF03\uFF05-\uFF0A\uFF0C-\uFF0F\uFF1A\uFF1B\uFF1F\uFF20\uFF3B-\uFF3D\uFF3F\uFF5B\uFF5D\uFF5F-\uFF65]|\uD800[\uDD00-\uDD02\uDF9F\uDFD0]|\uD801\uDD6F|\uD802[\uDC57\uDD1F\uDD3F\uDE50-\uDE58\uDE7F\uDEF0-\uDEF6\uDF39-\uDF3F\uDF99-\uDF9C]|\uD803[\uDD6E\uDEAD\uDED0\uDF55-\uDF59\uDF86-\uDF89]|\uD804[\uDC47-\uDC4D\uDCBB\uDCBC\uDCBE-\uDCC1\uDD40-\uDD43\uDD74\uDD75\uDDC5-\uDDC8\uDDCD\uDDDB\uDDDD-\uDDDF\uDE38-\uDE3D\uDEA9\uDFD4\uDFD5\uDFD7\uDFD8]|\uD805[\uDC4B-\uDC4F\uDC5A\uDC5B\uDC5D\uDCC6\uDDC1-\uDDD7\uDE41-\uDE43\uDE60-\uDE6C\uDEB9\uDF3C-\uDF3E]|\uD806[\uDC3B\uDD44-\uDD46\uDDE2\uDE3F-\uDE46\uDE9A-\uDE9C\uDE9E-\uDEA2\uDF00-\uDF09\uDFE1]|\uD807[\uDC41-\uDC45\uDC70\uDC71\uDEF7\uDEF8\uDF43-\uDF4F\uDFFF]|\uD809[\uDC70-\uDC74]|\uD80B[\uDFF1\uDFF2]|\uD81A[\uDE6E\uDE6F\uDEF5\uDF37-\uDF3B\uDF44]|\uD81B[\uDD6D-\uDD6F\uDE97-\uDE9A\uDFE2]|\uD82F\uDC9F|\uD836[\uDE87-\uDE8B]|\uD839\uDDFF|\uD83A[\uDD5E\uDD5F]/, st = /[\$\+<->\^`\|~\xA2-\xA6\xA8\xA9\xAC\xAE-\xB1\xB4\xB8\xD7\xF7\u02C2-\u02C5\u02D2-\u02DF\u02E5-\u02EB\u02ED\u02EF-\u02FF\u0375\u0384\u0385\u03F6\u0482\u058D-\u058F\u0606-\u0608\u060B\u060E\u060F\u06DE\u06E9\u06FD\u06FE\u07F6\u07FE\u07FF\u0888\u09F2\u09F3\u09FA\u09FB\u0AF1\u0B70\u0BF3-\u0BFA\u0C7F\u0D4F\u0D79\u0E3F\u0F01-\u0F03\u0F13\u0F15-\u0F17\u0F1A-\u0F1F\u0F34\u0F36\u0F38\u0FBE-\u0FC5\u0FC7-\u0FCC\u0FCE\u0FCF\u0FD5-\u0FD8\u109E\u109F\u1390-\u1399\u166D\u17DB\u1940\u19DE-\u19FF\u1B61-\u1B6A\u1B74-\u1B7C\u1FBD\u1FBF-\u1FC1\u1FCD-\u1FCF\u1FDD-\u1FDF\u1FED-\u1FEF\u1FFD\u1FFE\u2044\u2052\u207A-\u207C\u208A-\u208C\u20A0-\u20C1\u2100\u2101\u2103-\u2106\u2108\u2109\u2114\u2116-\u2118\u211E-\u2123\u2125\u2127\u2129\u212E\u213A\u213B\u2140-\u2144\u214A-\u214D\u214F\u218A\u218B\u2190-\u2307\u230C-\u2328\u232B-\u2429\u2440-\u244A\u249C-\u24E9\u2500-\u2767\u2794-\u27C4\u27C7-\u27E5\u27F0-\u2982\u2999-\u29D7\u29DC-\u29FB\u29FE-\u2B73\u2B76-\u2BFF\u2CE5-\u2CEA\u2E50\u2E51\u2E80-\u2E99\u2E9B-\u2EF3\u2F00-\u2FD5\u2FF0-\u2FFF\u3004\u3012\u3013\u3020\u3036\u3037\u303E\u303F\u309B\u309C\u3190\u3191\u3196-\u319F\u31C0-\u31E5\u31EF\u3200-\u321E\u322A-\u3247\u3250\u3260-\u327F\u328A-\u32B0\u32C0-\u33FF\u4DC0-\u4DFF\uA490-\uA4C6\uA700-\uA716\uA720\uA721\uA789\uA78A\uA828-\uA82B\uA836-\uA839\uAA77-\uAA79\uAB5B\uAB6A\uAB6B\uFB29\uFBB2-\uFBD2\uFD40-\uFD4F\uFD90\uFD91\uFDC8-\uFDCF\uFDFC-\uFDFF\uFE62\uFE64-\uFE66\uFE69\uFF04\uFF0B\uFF1C-\uFF1E\uFF3E\uFF40\uFF5C\uFF5E\uFFE0-\uFFE6\uFFE8-\uFFEE\uFFFC\uFFFD]|\uD800[\uDD37-\uDD3F\uDD79-\uDD89\uDD8C-\uDD8E\uDD90-\uDD9C\uDDA0\uDDD0-\uDDFC]|\uD802[\uDC77\uDC78\uDEC8]|\uD803[\uDD8E\uDD8F\uDED1-\uDED8]|\uD805\uDF3F|\uD807[\uDFD5-\uDFF1]|\uD81A[\uDF3C-\uDF3F\uDF45]|\uD82F\uDC9C|\uD833[\uDC00-\uDCEF\uDCFA-\uDCFC\uDD00-\uDEB3\uDEBA-\uDED0\uDEE0-\uDEF0\uDF50-\uDFC3]|\uD834[\uDC00-\uDCF5\uDD00-\uDD26\uDD29-\uDD64\uDD6A-\uDD6C\uDD83\uDD84\uDD8C-\uDDA9\uDDAE-\uDDEA\uDE00-\uDE41\uDE45\uDF00-\uDF56]|\uD835[\uDEC1\uDEDB\uDEFB\uDF15\uDF35\uDF4F\uDF6F\uDF89\uDFA9\uDFC3]|\uD836[\uDC00-\uDDFF\uDE37-\uDE3A\uDE6D-\uDE74\uDE76-\uDE83\uDE85\uDE86]|\uD838[\uDD4F\uDEFF]|\uD83B[\uDCAC\uDCB0\uDD2E\uDEF0\uDEF1]|\uD83C[\uDC00-\uDC2B\uDC30-\uDC93\uDCA0-\uDCAE\uDCB1-\uDCBF\uDCC1-\uDCCF\uDCD1-\uDCF5\uDD0D-\uDDAD\uDDE6-\uDE02\uDE10-\uDE3B\uDE40-\uDE48\uDE50\uDE51\uDE60-\uDE65\uDF00-\uDFFF]|\uD83D[\uDC00-\uDED8\uDEDC-\uDEEC\uDEF0-\uDEFC\uDF00-\uDFD9\uDFE0-\uDFEB\uDFF0]|\uD83E[\uDC00-\uDC0B\uDC10-\uDC47\uDC50-\uDC59\uDC60-\uDC87\uDC90-\uDCAD\uDCB0-\uDCBB\uDCC0\uDCC1\uDCD0-\uDCD8\uDD00-\uDE57\uDE60-\uDE6D\uDE70-\uDE7C\uDE80-\uDE8A\uDE8E-\uDEC6\uDEC8\uDECD-\uDEDC\uDEDF-\uDEEA\uDEEF-\uDEF8\uDF00-\uDF92\uDF94-\uDFEF\uDFFA]/, at = /[ \xA0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/;

// openclaw/node_modules/.pnpm/entities@8.1.0/node_modules/entities/dist/decode-codepoint.js
var ei = [
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
function ti(e) {
  return e === 0 || e >= 55296 && e <= 57343 || e > 1114111;
}
function vn(e) {
  return ti(e) ? 65533 : e >= 128 && e <= 159 && ei[e - 128] || e;
}
function Mn(e) {
  return e - 1 >>> 0 < 127 || e - 160 >>> 0 < 55136 ? String.fromCharCode(e) : String.fromCodePoint(vn(e));
}

// openclaw/node_modules/.pnpm/entities@8.1.0/node_modules/entities/dist/internal/decode-shared.js
var W = /* @__PURE__ */ (() => {
  let e = new Uint8Array(127), t = 0;
  for (let n = 33; n <= 126; n++)
    n !== 34 && n !== 36 && n !== 92 && (e[n] = t++);
  return e;
})();
function Dn(e, t, n, r, o, i) {
  let a = e.length, u = i * 90, d = 0, f = () => {
    let T = W[e.charCodeAt(d++)];
    return T < i ? T : T * 91 - u + W[e.charCodeAt(d++)];
  }, g = n - r, y = n + o, c = new Int32Array(y);
  c.fill(-1, r, i), c.fill(-1, i + g, y);
  let l = new Int32Array(y), b = new Int32Array(y);
  function p(T, v) {
    let I = 0, P = v, B = v + T;
    for (; P < B; ) {
      let N = W[e.charCodeAt(d++)];
      if (N < 89)
        I += N, c[P++] = I;
      else if (N === 89) {
        let z = W[e.charCodeAt(d++)] + 2;
        for (; z--; )
          c[P++] = ++I;
      } else {
        let z = W[e.charCodeAt(d++)];
        I += 89 + // eslint-disable-next-line unicorn/prefer-minimal-ternary -- branches read a different number of side-effecting input bytes
        (z < 90 ? z * 91 + W[e.charCodeAt(d++)] : W[e.charCodeAt(d++)] * 8281 + W[e.charCodeAt(d++)] * 91 + W[e.charCodeAt(d++)]), c[P++] = I;
      }
    }
  }
  p(r, 0), p(g, i);
  let m = new Int32Array(o * 2), h = 0, w = 0;
  function R(T, v) {
    for (let I = 0; I < T; I++) {
      let P = v + I, B = f(), N = f();
      m[w * 2] = B, m[w * 2 + 1] = N, w += 1, l[P] = h;
      let z = (c[B] < 0 ? b[B] : 1) + (c[N] < 0 ? b[N] : 1);
      b[P] = z, h += z;
    }
  }
  R(o - i + r, i + g), R(i - r, r);
  let C = new Uint16Array(h), x = 0;
  for (let T = 0; T < w; T++)
    for (let v = 0; v < 2; v++) {
      let I = m[T * 2 + v], P = c[I];
      if (P < 0) {
        let B = l[I], N = B + b[I];
        for (; B < N; )
          C[x++] = C[B++];
      } else
        C[x++] = P;
    }
  let _ = new Uint16Array(t), A = 0;
  for (; d < a; ) {
    let T = W[e.charCodeAt(d++)];
    T >= i && (T = T * 91 - u + W[e.charCodeAt(d++)]);
    let v = c[T];
    if (v < 0) {
      let I = l[T], P = I + b[T];
      for (; I < P; )
        _[A++] = C[I++];
    } else
      _[A++] = v;
  }
  return _;
}

// openclaw/node_modules/.pnpm/entities@8.1.0/node_modules/entities/dist/generated/decode-data-html.js
var Pn = /* @__PURE__ */ Dn("!}.&u%}'&}*'~!6*)%&,~!J~!J~%L~y<~!R,~~%Lu~~#GD~~#|)1#%}^%}2%+#.##%##%}&%##%'#%##&%#%#'%#&#%#&#'#%%#&#%##%#)%''%&%#%#'%#%%#%%}%%%#%#&(23#%%#&-%0%('1#(##%#'##+%'*.:1}#%#6-+(%'%%#%%%}#L'2351&('%}&/N'(0(/*-%(%%}#'+&T%7.2}#&%&#%#36/5##%&%%#&#%%#))2%%##%&&'0~!#*+&'%1~!%).'3q?&%'1~!.##%6(~!+%%%(Gw'rT~!E#<nA%#jZ~!H%(~!42##~!*31&~!G%U~#)5~#`3~!J~!Z~%]~%Y~%C~!q~!u~#kz~%#~!6'~!D~!U~!?~#T~!c%~!G#'~%7|~!G~!J~!G&~#pb~(Df}#%}*&}#%##%##%##&#-}&'#'&%#.++}%mI,#,@&(}*%}*'%&##&#%##%}&0}#.},U},%}+%}&%}#%##&}B%(}(%}+%)})%##%#&}&%##%&}<%}>%#%&}*%}(%}9%}/%})%}*%}*%}?&}&%}3%}&*#%})%#%#)}#&#-#+*%E%%'%'#%}#*V##&##I}#&&##%&%#&&Qf%%))w/0+&%#(#.%-''''++++7}>%4'',##1,#%#&%##&#'##&#*#9)%&%}#*}%,#+P(%A&%#'&##wSD',9E00#y#@}(+}&%&>~!#~!X}#*}(&&}(&}(,%}%&#+&}#&}I%#%}%)#(},'%#*}4%%#%}(''}#/##(##),%-##%%)#&}(.}&%#&}%%}*&#%},&&}&%}#%*'#%})%}D&}&%}-&}6&#&}-,%}#%})-(~+`~,=?~I9'9%~!,#%})%})%}@%}?%}(~!?~#<~#pP~#BG~#=1#%K+~#?#~%;)~#A~#mF1~#A'~'X%'~#lR~#N~'N~#r~#m#-~#i'?%#'%~#B%##%,%#~#_%#0%~#]732~,w~2+#:&#%&'0%&>%}#>##F+)#%&&#(+_}4&}-%}(&}@&}O7Fdf0@+/v4}&WU##&/0#&'('B#%}.%}'+#%}#%%&#&%#%##+#&#)#6#'#.},%}c%},%#%##%&#&%#&~#>'*-.%##%##%}#%%}%'~#)D1}#%*&~#_%%'(~#S2%'.}#~#=##*'*-%}&'%'##&&~'E%.#&~#M4}%%##&'%#~#O1##%&#'+~#<B%##%%'%+~#;#@%}#&%#&&%#(~#H1}'%'##&&~#?A}&'~#D#%32}'&&&&~#[}'(#%}'~#;C})&}%%#%~#=&%,3}%'(#%%~#^'#&&)#%'~#Y%-~#d-%'~#^%%&#&&&}#~#b~2t*&'~&(~&@~0%~e~3}%*''0})&}+~!9##-}#%-hD*)1fC#%/&/fB#40~!+#)*4~!+~!K'&:~!/*7~!.#~!H~!L':~%x&~!H#~!*~%1~!I#~!+A~#p'~!F~~#-#~,,(~.Z~!V~%;'B'mq-W~!N~%I%#&&#&}#%},%%}'%}+X#%}#&}(%}'%}<%}#%}%%'}'%}:~![)9@~%>~#UA%-%##&~!C%~!-.9:~!1~!-^2/:a~!y,D*J#-5)/4~%23,~#G~!L1~!0X3`~!2+~!!0-~&E~!W~!o,>Y&]~%cZx_&~#O*9#A#'#+I'%#)~!0B*-5A+-((F&*M#)(-7-5+'-3a5Vi~!Y~!?+[)%3),ERHm~!+:D,VG.+)?fB%%*(%)'(#&80%1'8`K8?`+'Z#&O&'H5#*9)A%%5&3))0%39+.*7#()&&*=4@**L)<'_&*+..;(#*+)./&0#3)%')-8(4ixD(&.}%,('aI:,)%,k2231T)I'#/-W7,/'Q#.'Y24+h')37</31&83##&0#),H(?'&?/1##%#&&#%''-%&&&#(&''&#.-'%#%%(,')*'&#&#'##%(%(#%('#&##%%%%('%#%#%%#%#&%##h>w+v<ayvyvcg.uuhKr}g/v|g>u9i[~>g5uI~=RvdwEg;v/g;uk!!TTSx]@RT!U!#!@VBRUU!'UTe-d0c`e&gSdicedFcrdTaqb.kYcAohdYd@a3e+d}dMdtd.aJ#bqcK`dle/e.e'dwdPdodddjbEb}ogd^ofdpduc6j?l%d{drdqc)d7bacOdQ%T#Y)X.sR[yH>6Vyv3[xwLu>vo'!*.[yBacahoj>6Rew3[xqdZa#!a&#^(X-[yG>6Vyu3[xvg3sEr|g.u/Ri9db0T#^(Xa)!-[y;>6Vylg4wKs{JwNZt3@3r=c4Z([xlg;wKt!cpq's@v7A'*a(a+!-a#[y<3Dt?3Dt'>6Vym3[xmg9rxsNJwLZt4~?r?db1T#`-!(Xa,!0[yS>6Vz%NuQs.g4wKtnJwNZtS@3r>c4Z([y%g;wKtrdga8!a(!#&T*Y-Xa#!a0<or[yc3Dtq>6Vz43[y3JwNZtf@3s!Ju}!%Dti:pm3c_%X#tjB5pkd6q!r]u?voC'*-a.a2!0a&a+[yI3DtI3Ds~3DtH>6Vyw3[xx;:s#~<5pKJwNZtE@3r~d`a)!a2T#a.(!+U.X1[yT3Dt`3Dtv>6Vz&3[y&g9rxwzcxstPu.<rAJwLZtT~?r@dZa%!a.&^*Za(/Reu[ya>6Vz23[y1g3sEr}wkg{NuQRg{ci(U#5@b`~,cg#U(2WnH5wugcRh7dX#T(Y,a'Ta!!a,[yZ<]mj>6Vz,3[y+Pv#5ReZKu+=,%!H}7ABwkaS?Rh:BcW(X#<]mrj:ubv/ARekdg%!(!a.*Ta(Y.X1!#sP>Rl*Dt6[y>>6Vyo3Wf*jOvuumvuRgRJuq*!:9<B@bX~3jVv&v@s@5Re[d/rQt{uAvo&a&a*)a2!,0Wf!3Dt0=Bs'>6Re}3[xy~<5s%JwJZt1~Gs)c;&!#2sJkNuXvzq7rxu,Re8dka4!a8(aEZ+a@Y.X1Xa)[yd=Bs(3DtP>6Vz53[y4cX#X&Re:avRe9~<5s&JwJZtQ~Gs*i^rzvdRg+Jv{%!2sbB@bX}kdga,!Za?&^*T1/!a'Dt+[y6>6Vyf3Wf%g/u;s4hGu6?Rh-JvZ,!c%#&RoX54Rivj7uyvf8RgTKvZB%*!2sGh<vu5Rgq<=C::9bb~#dZ#T&Ta6Y.X*Dt>[y93Wf)coZ(T,6VyifluvRgC@95@B@bX~/hFu34cC#T,k/unq8w8Q5RkUklwQuzunq8w8Q5Rk8d/rJu?v8w9)-&!a0a;a&aIWejg3sEr/h1s<DtDJvyZqY5aws3Jvy!&Wei~Hr1:au5@Bag>23E~5c:Z&bX};kKv?w&unuVu5Rjc;>bs)#~@:Rh.=ay<a]C;b`}Vd6s/t{uAvoaxa()!a,a7%-a#a2Dt,[yF2Wo[>6Vyt3[xuNuPRi&NuPwpi#RoWh?vf8Ri%Jv]!%Ri:KvxD!.'2WeAjZu`q9rxu,Re7woeAg-unLq(qA_/*2Wg_g3u5q^9:4E}/jTrxrzv=Wkkd~0UX#^^Xa-a1a5T&a=U1a'*aEa]!a*aPaA-adok[y54Rn>;:p3~Dp5g9rpsFNvZqjg3uJp4~<5p0Pw;5qlJwNZt*@3p1Pw:5p/Ou!5p2JvG'!6Vye=<qnJvh_[xhg3v,Rh3kOwOw-sDuev/Re^dha[a%!%!a+#Ta7)-5TaCaO!aka!a)sf[yb2>Rl!9ARiq5E}Qg=ucRkBE|oJrJ_@Wk~@Wk{JrJ_@Wk|@WkyJrJ_@Wk}@WkzJvO_[y2g-vMRmiKuYC!)&>Ri;>Ri<@3RkNc](X#@9Rk=g5vuRmhKvDB!+'=]meg3u4Rmgd)#Y'Vz3CARmfd`a+!%T'!+#Ta1Ta6TaM-sTDt9[yA9sYd'%Y#s[[xpj:ueunaXRgEjRq,v-vuqdd2'`#6Rev<32@5>:2<E}5xIo9a*X#Y(;5RePJvD_g>vyRgNj8w)v8<wggs:RgXiZt|vjx,hSq3ah!-(~@:Ro/Ou!5RhWj^v(pyw8unRhUdx-UY#^Ua.a3a70!)%UX1TaDa)'omRiRRhE[y:3Dsz=Br,>6Vyj3[xkg6ruwjcqsrPw;5r*Ku]D'Zt-@3r(~?r.i[vwv]dU1a--U#`a4(g/vsRhPOu!5RhLj:rmu9Wo!~@:wdh@g/vsRiTjXuvvNr}:RhBj^v(pyw8unRn]dz1UYa'a+^Y(!aETZalaRY.Ta?a4[yDJw1!#qLsW>6Vyrfzq-pLflpwRe|Js>%!Dt@3Dt&Jvy_[xs~HrnjMuwpsw'RecKu+D#'!t<~Grl~?rjg5u-x,gwp{ah!-(~@:Rg~Ou!5Rh'jXuvvNr}:Rh#cW#X/c;&!#2sLi[v7u7RgpJv)(!iLrxu,Re6j7v@s@5Se[e7d`aW!Za(a`T.a#!a3!&aDa-!9)Dt_=6s+3[x~~DR|h~DS6avhGun5RkZj3w)v-]mkKunB!&*]kb97R|i<ARk<c:Z(6Vy}Juh'!wziMRoS:F|vkLuauJv5vtvQRh1d='T+Y#VyO~DR|jcF#T'7R|g97R|kJv3'!ay<Rj,Jvh&!:ReXcsa6*a+#a#_aIRf9aLRf?c,Z&Rf5Rf7c.Z&Rf;Rf>cQ#%T'p-Rf8Rf=ct#%'(*!,p,Rf4p+Rf6Rf:Rf<d~'Ua%U*^UYa(!a,-!#a4YaTalaEX0a8a<Weo3Dt/3Dsx=Br93Wen~Dr;~<5p<JwNZt2@3p=Pw:5p;Ou!5r3c7&!#:p>3Ds}KvGB)_6Vyk2sM=<r7x'eovA(!hFu1ARf}cV#X&@r5j6rvwQa^Rf3c=Za'wkghJv__g;unRggA53B9=b^}%j6uduo5Jq;!(hIv%2Re`Ou4ARe_e%a#^^^Xa&!a*a2!&a6YaP!*ad!#a:aE/5Rn?[y@>6Vyp;:pE~DrY~<5pBJwNZt8@3pCh=rt3rWPw:5pAJup_[xoNuPpF9c!#'45pD5ARn)d8#X'X*3@rU72s]h>v<<sSjJpqvewOJq/(!hNw'5ReBk0s2u3w/w'5ReE5@Jq.!a+JQ!&WeU23d(#Y&RjG5]jBk!u7w&u0udARjEe#+^^^Ub#!a2/a`Z(agT1!a-a;|@TaG!aS[yV=Re~fow'RguNuPRe?bz#'>RoUWeL>:Cbb|?JwPZtVg6ruRmzJvD'!6Vz(g/vmRh~Jvy_[y(g9voRgyx*cy(#2>Ri2B9b]~9kIw9u7rluJu3Rg]dI#a%UY'@=p%CAx.gQZ&RhwwygtRm{x5g_Z'+ABqR9Woa=Bp&dV#^*Xa'!&@o{g4v]Rk;Jv{!%Rk[wkkiA5RkiwwfUB=x,fUuqC&*!>RfTg8v0RfV~ARfSd;rJsAuAv9wR'ae+/aO!a@aza/a#[yQ@Wg!2Wemg3sEr0JvB_g>uvReWg2v+Re=KupB_+[y!2AbY~-~Hr2AJwD!(h<~El>h<~El?Kun@+_:9b`}Kg-v/Ri3g;vtwyk_9]k_d=&T#*U.6qh@Ab`|K9:H|CJv[!&3Dtex'fDwC%!Rf[9WlMd[(^X,!a%Z06Vz!@WgBg=v~Rgvg,QRe@awd,#Y+jTv|Q~EfWj]uNr|~FRfXdy#Y&^Ua%!aO.!(a)Ua;=!a@aKap!a-,a!Ta]a[rSa]p?[y82sK=Bq~;:p:~<5p8Pw:5p7d'#Y'Wf(;RnRi[u4w&RgJJvG'!6Vyh=<r#ijuuv/sIKuYD'ZtG@3p9~Gr&d2#`(g<vtRgFj`u5w&rqpxRf2CJuY!+:wfnTOu!5Rg}jNs1ucv&RfwJvA!&3@q|BDcC#T,k/unq8w8Q5RkTklwQuzunq8w8Q5Rk9dga#!a'!a=#a0!:+Tb*b@aO.a4!aba8aFJv^}?!VyR~Dr<g;u%Rn.~<5p[x'e`wNZtR@3p]Pw:5pZhNvjBp.woe_g5u-r4JwF!%DtO3:ooc7&!#:p^3DtpLuGw(!+%)Dtk6Vz#2sd=<r8d'#Y([y#<x3gJt`w@!)%}MRiowzikRij=]ilxAf3,U(#B2Rf#g0v-Rm[ck{`U#]giKv3>)!&6Ri154s,KuGB_%@r68r:dJ|t`#X(9<E|u2@H|rx3gJu?w'!+'1Nu7Reg4=H~+9<wxgY95Rm]xLggZ-`(X}U2:Ri4h<uOawRmsJv__5@bb{jbV~3dka#a'a]!,#a+U=a>b6a3b%!/aKa/)!arwve^VyJ;:pR~DpTg3uJpS~<5pOPw;5qmPw:5pNOu!5pQJvG'!6Vyx=<qoJvA!{~Jup!%@qk7Rn/KvyD!}''[xz;>wkh'?Rh,x8gyt`w5D!&),(SgyccRgztJ@3pPB5p#d'(Y#<]mmifubw&RgoJvE&!82s^JvF&!8Rf,ADb]~;x=h'rNu]vK!,%'*0RnORh)4Rh*AqQg-vaRnNg;wHwkh'ba~4cE#Ta*x3gctyw@'!+%RnFRnD<4Rn@hFvK5RnCxWg[#`&a0Ua()`1Rm75Rg[c]%X#qi8Rg^NvdRj>BwzgZauwji7Rm6A4wgg]d1#&(*,.0a#Rm;Rm<Rm=Rm>Rm?Rm@RmARmBe%#^^^Xaea?aC/b+(,!a+a#!a/!>a&Ta<aKbD!2wphBRnk[yPw}hE|.=Br-3Dtm>6Vy~g6urRf.x,hPrNav!%'RnqRo%Ro#Nu;q[Pw;5r+JwNZtM@3r)d'#Y'Weh;xChL#`&RnmRnoKu}>%(!Rne~Bs-;2wjcussJv+'!aYSO}6@B<5?ba~8LrNvj!.%*ROwungw~ng~:9;Ri^>wtnig;wHRnixDh@|(UZ.x1h@|)!#:2<H|*xHn]#-UX'3Ro)z=iT}6ARns=Bwsn_wpnaRncw]aR(#UXa&Ua*a/=]iPd'#Y&Ro'WnXf{QRm2hNvj]nZd`'T~&1`{|`#9b]{}c:'!#Wl{>@=be}]?cl{{U#:5Abb}Jds#^YaF!a*b4a#a3aPa>&Tb!bH!*a_!Eau?/a&RjY<]gj>6Vz*;:pe~DrZg,QRj1JwNZtX@wihspcJvZ&!VyX9WmOJu|!|N2WmHJvh&!]ht~Bpbcn&T(!#RmQ<s7Nu;padH#X'`+WmJ@>RmKCARhnKup=!)&Wf+:RhqNuPpf9c!#'45pd5AwghpARn(Ls@w!%,)!RmP@Wfe<E|IJva!&WmNg8vsRmLd`*.`#Y'Xa!axRn*]hrA8Rhug5s@rXg8u!RmMd8#X'X*3@rV72smdI*#UY&RmICARho~GsgxVgd)Ta'U-Y&Xa!T#RnEWnA@Wffg1uDRi0hFvK5RnBxGnG&#`%owp)@wsf+bX}Ze-*1!a*^^^Ua|!#a.aq&Ya2!a>.a6!a:aO`aJDtL[y`@Wg#>6Vz12@wzoYRoZNuPRi!NuPRhzg=ucRi,@=b`{Yg=ucRi-ACJvB!&Sh[ebSh]ebi`wUuFRm4Jw2_[y0JvB!.<Ju(!&SoG}6Shd}6<Ju(!&SoH}6She}6Kur@._g5vHRieJvx!{L2G{Kx6gd'T#?Rh82Wi5cZ#X(g1w)Rm5dW-Y(Ta#!a)!#aYa=wnfE=su2>>bU{0j9udv:<svj8uQv-7RgHdE%#^'sq9sp=>Bb_{TJv`!&g/r|snj6v(us5d,#Y(56H}[978H}]Jw5!&g1rushJvB!+j;v{u5?zDhd}6}bj;v{u5?zDhe}6}ce*#`(^^^a[aea!=!a6a*aoXb1a.!aAbL!b>,b'aL!aV@Wf|2Wlg3[y/JwNZt^@3piPw:5pgJunZou3@rsJva&!Vy_g<v~Rm#JvG'!6Vz0=<r{Ju{%!:pj@WfsiXuJu3Rm:JvZ&!WfA~Bph@c4Z&Dtwax5rubx(#:awRk1@d,#Y&RfjRfid1#,Y(@Wfp2Wlrg5s@ryKu[@!,'=]ig9wlk?Rk>g5u-rqJvy'!@9RkQcH(T#=>Ri~@<wkj(Wj(KuZB*!&<7rw@9RkRcH(T#=>Ri}@<wkj)Wj)dg(Ta2Xa9X#`-!a*CARhg@@=I}d9x;c~#X%so=<sj>2@@=aybb}XjWv0Q~EfEj3vLv;<d,#Y(56H}`978H}_dgaPaFa'a/!#a3Y0a_a;a|!1(a7-[yE3[xt;:pJNvZrrg3uJrvJwNZt=@3pIh=rt3rxPw:5pGOu!5rpJvG'!6Vys=<rz@c4Z&Dt(ax5rtJvZ!&~BpH@wsfNg-vaRlNci*U#=<wei<F}a5@Jq.!a*JQ!%@qZ23d(#Y&RjH5]jCk!u7w&u0udARjFd/prq=tyvpaEa(a:.!a1aZ(@@=I}:9wpd%=<sX55w_h}@@=I{t=ay<aU@@=I}T=ay<2@@=I})?C9:9au@9Cb]}DP~=x-fAZ(2Wl1=ay<aU@@=I}>5@d##Y+jTv|vV~EfFj]uNpn~FRfGdgaK!Z2&!a8a-Tb({E!acTbM*!a(DtY[yYd'%Y#sl[y*hHvh>Re5x2c{Z}.j4uCvcawRiMd+#X+_x&d!},<5RkX;2Hzw@x,gavfB-!{CcF&T#Roe;RodwWbBg5urRgaKvHC*_6Vz+<4opieuew&Rmq@d]&Y)X,T#X0Rh}<BqP=4qS9:ReMg/ujReNJw0!/<Jui%!bd{kawwnemRelAxUa?a3#*.&UX(Ya+a/RhvRnQ<o}9Wmtd-#Y&RgSRmw9;Rmxay=Rmyg-vaRmuxEhSrNu,v-voC!%(aR.a(a7+1Ro1>Ro5CE{A9b]{@;5x#eO{:g;urRi+KrNA!%(Ro3>Ro79;Ri_Ku@>{;&!x%gX|{KunA_+g5QRj/g3u5Rj#g>uERj%wio/xRhS&!,!#^1U}wba{8>>@=be}qC@:D5ba{7Ku+A&!}x?ba}t>>@=be}se(aA^^^Uat!b0#{pa+awUazbGa#aLb9bgaWac'a5TbS=Br!d1#`%scp_Jvl!#rT>Re0JvX&!VyN=H{Fcm#U&:pY=ReaJv2&!]h0=]nUJvG'!6Vy|=<r%JrM_=]h2@Wlud'#)U'Wf'b]{i=]h/Jvh!&~BpWg=v]RnMx+ny#'Nu;pVwjnu=]nwxJnx,T#`&Reqwjnt=]nvieu9vrRjLLuYwP(#+!th@wih5pX~Gr'g5v/Rh4KunA'!-CARnP@wwiN:Rm_9x'cvw>!|l=<saKvAA!0&3@q}>w^e1bp#&Re2Re3BDx7gH#T|f5H|eKuZ>!%(:qNAH{]Jv6!+3B2B9=b^{X<5<B92:E{ZLvhwA(a;a%!igQuyRmad+#Y}m@3Rh5d8#X'X*:AqUAHzmaxwbh<aXRnVcF}RT#Nw&cj#U(BWnug/vsRntdka)(a3+.Zb7aYYan1!bVa@Xa}[y^@b[{G=H{+hFu73Rj&Pv#5ReQcK%T#sig1v{Rj'Ku+D#'!t]~Grm~?rkKuMB!01d5#`'Vy.ta3Dtu~Hroc8#'{^45s85AwZbP&!#Rn!wghxWn#KvEA!)&2RlA2RlBx:h|#(T,=]j09Wobz>x]z/@awRoTd+#Y(az]hFhCrm4d,#Y+jTv|Q~EfMj]uNr|~FRfOdCa!Xa9_X#@<plJvf!%b`{(9;Rgwc;.!#2x7cw#T|UDb]|T5Ju={(!=@E{&Jv)&!Ab`{'awJvf!~*>>@=be{#KuY>!+&4Ezyi[ugv&RjIdea+T)#UXa&T-T&a!Rh9auRmW=]kLg5vuRn+g3u4Rn-Ow6ARn,hHus5xNk?#UX(U~)/g8v0RkD~AwkkF?Ri.OuNBwkkA?Ri/d|a2`a*^UYa.!aBTZaTa'Xa;!(!2!-a#b2[yC>6Vyq3[xr2Wi?g1rusVh%s?DtF~<5rbJs;%!DtBfswKtCj[uvuSsEu3RgVx3o:u+wN'*Zt;@3rd~Grh~?rfg8w)Lq)qE&-a%!>bI|`jWv0vV~EfCjTv|vV~Ef@j]uNpn~FRfBcK#T']gWNu7x,k7q4ai(0!hHv8<RhmkMu9vrsBuev/RhlCJvB!,g<v{wchh~@:Rhji[vrv{wchi~@:RhkdS&a5UY#Ta!RgPwwiI5BwciI~@:Rh`x'iJvj'!5]iJPu8Bwch]~@:Rhach)U#h3rp]gLh@t|Ax,hTq3ah!-(~@:Ro0Ou!5RhXj^v(pyw8unRhVd|)`,^UYas!a?/a2Z'a^Ta{Tb7Ta(a#!a,Wf&9sZ3DtAadamov=Bqt3[xig8vsRm~>waiL2b`{QJv*_Ouv2qgj<v]v2BqfdR'X*X#Y-@3qr~Gqv~?p6hHv-]glPup5Lq+q?_%*b_{qF{n9b^{rOu4ARhpKvCD!+&~Bqp:5Dbb}nwoiKl&unuTuBv]v+ueunaXRf0=Jvh!0nKufu8v1w&w7q%w&uHrz:Rgnj5w,uxDJq/(!hNw'5ReCk0s2u3w/w'5ReFd>Za&!*UaA=<wkgsRnSJv^!%Refifw3vyRgOKu_B'!,<]gkiiu:w&Rh<=C@a^<B57@2F{[<B5@aW:=3away9A5aW=<B=C@a^<B57@2F{Ie-#`(^^^bCara.b8aza6!/bZ,!adTbnTbOb+aFaS!aAT9@Wf~2Wli3Dtl2@d,#Y&RfnRfmJwJZtN~GqyJva&!VyMg<v~Rm%iXuJu3Rm9Jv[_=]ih9wlkDRkCd1#`(@Wg>2Wls3cH#T(@<Rj*=>Ri|b~'#23s9h<~El.d'#Y&Dtxi^rzvdRl#d*#U%(o|B2s`hJwSaxRmDKv4B&!1:Rmdd5#`'Vx}to~Hq{x'f1v3(!BA5ba|bJv_&!Wfug1v]ReIdO+U/Y#&G}-8wze=Rh{g1v]ReHg/uQRf/by#)ibQwERl/cH#T(@<Rj+=>Ri{cNu+vlax-!(#a0qa9<Rii2;;bU{H;x<i=&X#Rk`<4wwi=C9H~8xAI(Y#<azRi@45wXI<B9;5bb~7dL(X#Xa(+!aL6Vy{g5QqOau:5au2@ay547EzbxOcU(UX-T#Ta#:Cbb|A?wjh/b_|SOw6ARgtihr}u7Rhy<d1#T)X1@@=I|~=ay<2@@=aybb}Sj3vLv;<d,#Y(56H}A978H}@dGpvs@uAu`vcw9*!aFa+ai%(b!aXa8.a?a[ozWey=sU2@G}Nch&U#Rf_WexKu+D#'!t:~Gr`~?r^j]uNr|~FRg*j^psurwJt|RmcKv)@&!)7Rkv~Br[@wxfO:Rl3co#U'6Rezj_q#vIuavjRltwzeyh@vr5JqD0!>aY?C9:9au@9Cb]}9cl#U*5;5<H||jbuus1ucv&Rfvg1v~d/pppzqFr^a--a~!aMat1(hFv;Wiz@@=Izoj5uuv-7Rix~Cw`fk2WlVcZ#X,k)u3vWs@u2]ktg;wEx'fBq(_2Wg/jTv|vV~EfoJv]!15x'hzqG!(P~EfU~CRl_j6v(us5x4i-#T(2WmZ?C2F|d>Kq<aj1!*jTqIsBv=Wl`~Cw`fi2WlWj`v0u*~>RlR=c>Z,k#u3vWs@u2]kr<c1Z+jTqIsBv=Wla~Cw`fm2WlXdmb3!a{(arZa`bkTa%TbQTa-a9+c'!aM!/[yL=Bqug.w'RifhFvyDRj.g>vgwyk^9]k^Jv3_@WfbAARkhJw2_[x|JvB_wkoIRoKwkoJRoLd'(Y#<]gm=<9<H|yd'%_X#skDtb3awwqkgNulRkgdB#^',9:p'hJwSaxRmEBwVb8@4=H|qLu+w50&!)@3qs~?pU>Awwn;;Rn=c:Z'ARn<=<qwKvC@!/&~BqqJv6!&]eVb^z^xRge'/a%+^`#Sge}6<4Rn3=]n0Pw2>Rn8Jw0!&>Rn:>Rn6cY#a7+!a&=<wkaNw~h3z_c5Z{=wjh#=]nLKv^D!&)Vyz=bW|swYb<WetcG#T(2wxa@qVx@gD#Y&b^|V5JwG&!5bb|pg/w&RgD@x=kHs=uAvn!a%%/'+RmSRh694Ro`g-vaRmRhHv-]mlxCcS#`&ba~.5cD#Ta)P~=d,#Y(56H{>978H{Dd_#{2^Y%_+qbbb{6g3sERhsbU{?dfa.,`a(Xa<!aiX#(55RiG54RiHcI#T'WiU3RiVNvdwtfcRlKNvdd,#Y&RlHRlExQgf.1*^T'X#Sgf}6Wn4=]hfPrk>Rn7Jw0!&>Rn5>Rn9Lunw?&a2!,5<oq@@wqfdRlJj5Q~=d,#Y(~ARfcOuN]fdDKw;ay(}i!547E}j?cI#T(@5bV}iCbV}hdv(^^Tb?a40,b##Tbo!a*bR!a<b|a/!aKai!aU[yK=]o^g:v>ReGJwPZtK<7Rh+h<~El,Pv#5ReR@awwxjCg,ulRjDJv6&!]j!z?aQeeg>w=Sh<eeJw;!&axEzOg,Qosc!#*:wkeJ]eJ>x'h-u(!%Ro.w~h.zPdNZ(X,Ya![x{;9ReY;wkgxRiF:x?ap#Y&RmUg<s2Rkod]+UY0TZ'!a&A9sw<=bczLNvuw{gqzNhJwSaxRmCKuLay!#&s_Rf-55b^{uJvZa!!c%#(55Ri654wmiu5RiuawLu,vp!+}^%b_}Y9;wkgxba}o>A9:=b^}zKuh=a''!3awRk3c*'!#aHRk6c+Z&Rk5Rk4Jv)&!awRjSawd9*`#0?C2@EzMj8u<uJ5RmbjQrquJu3x,k>uq@_+=ayb^|W~ARkEOuN]k@7dhzV^X/X&a-#zRzSb`zXcJzTT#2WkVKvDBzW!%FzY9;5bbzWjQrquJu3Jw3%!b`zU=ayb^zQd:#X(T-a!6Vyywxh}=b]{Jg=u1RiAdGp~qHtzv!w(wA+a+a;<!aJaYai'anasb(=azRmV:Cbb{MLq2vb!%')RjuRjrRjtRjqx3jnqCw3!%')Rk(Rk+Rk&Rk)Lq2vb!%')Rj{RjxRjzRjwLq2vb!%')RjsRjpRjfRjex3jcqCw3!%')Rk'Rk*RjkRjl9<CbbzfOu4ARhxLq2vb!%')RjyRjvRjhRjgx=joq*uKvb!%')+-Rk.Rk%Rj~Rk-Rk#Rj}x=jdq*uKvb!%')+-Rk,Rk!Rj|RjmRjjRjidAq&qKs@uAv8Aa.'*-a@a&0!aM@a5[y73Dsy3Ds|3Dt):wxgI2sHJwJZt.~Gqxwsf0ikrzt}Rl0Jvy_[xj~HqzKv_A|D!&WfP8axRoVcf,U#k(v]v+ueunaXRf1Ju}'!g8u#Ri=jQw!sCunLprq>!,')~<5qeGzq9F{W=c##%s5au:5aU3CBE|;d4#X(D!a&6Vygx(b;#(=]ed?C2F{N<capoq2r[a&!aPa9,'Pw;5s:@@=I|,55w_h|@@=IzcP~=x'fCqB_2Wl2>aU@@=I|1OuNBc1Z+jTqIsBv=Wlc~Cw`fl2WlZ~AcTa%!Z+jTqIsBv=Wlb~Cw`fh2WlYk+uNqJsBv=WlSg,u3dca3#UXaMYa)TaB-=cM|7T#<bI}l5@B932:aV2G{BOuNBJq:|M!5Ezt=<B=C@a^<B57@2F{v>cB{/T#=ay<bI{3Jv6!a.6BKq0ah&+!5E}HP~Ef{978BaU@@=Iza<7d#.Y#978BaU@@=IzH~AJq0!(@@=IzG978BaU@@=IzFe,aU*Y&^^^bvJb,b:bFad!a,c2Ta>aL.bo6!a#CbTa'T#Re{2Wlh2@G{yg6t~Ro_NvdRfticuRQRllJv3&!x&c|zs@Jw3!%RflwpfkRlpKuL;%(!Re<@G|C2GzdhIvuBwgjAg-u0RjAKQB%!(GzZ@G|5NuuRl7d='T+Y#Vy[g<v~Rm!==G|>JvA!)@wma=]m1ifuaw&RmnLs@vT'!|/+[y,g:v>ReTJw1!#qX=x!eC{bLu+wT&)ZtZauq_~Graci&U#F|89:r_Lupvq!.)&2RlG8RfaC=x!eF{_h?rpWlmd&'!#X|&]k::xJey#`'T|+<E|&2@H|%dE#(^,g;u.RiEg6vjRiC9xCkA{O|zY#g=ucRmXKs0@!&*@G|m@awRknJuh!,3d(}gY}eJvj!%Rm):Jw3!%Rm+Rm-Ls0w(&!a(a#@b[|6cZ#X'7RkxWgAOu4ARn'dH'U#Y*Vz-Wm'CARm}d]*#a%^a*T'aK!a<9bV{PC=p*Jw4!&SgxcbB5r]idw(wBRmF7xFkt#&`(Rm/Rm8E|!JuY_9:Rl5=wrgr2:bbxd@xXfB(a*#T+!.X0X1Ta/a'T&RlDRfL>RlyARl9b[z[>RfZ:RlL:RfRwlg/ARl;9;RlxKv,A/!%7s69<74=BA5ba{-8Bde#`a<XaKYa1,a'P~=wxfB2bZ}}?C972@@=I}r8@55B9;5bb}G978B2@@=aybb}3j3vLv;<Jw3&!>Rfk=ayb^}4~Ad1#`*@@=aybb{w2@>==<bbz]dx+UY#^UaF!a9!bB'Ya1.!ajXa#%olRhD[y=3Dt#Ov5BrHKuMB%!(Rf^Wep~HrJwkiQjKr|~FRg)Ku+D#'!t5~GrF~?rDdV)UY,Z/_7RkuG{<~BrBg,rlsO:235B@bX}|d?a1!#`(6Vyn5@d##Y+jTv|vV~EfIj]uNpn~FRfH7Lq2vb1!a9-978BaU@@=Iz9978BbU}#~AJq0!(@@=Iz8978BaU@@=Iz7~AJQ|}!978BbU}!JvkaK!AdUa21-U#`a+(g/vsRn~Ou!5RPj:rmu9WhOjXuvvNr}:RhAj^v(pyw8unRn[kPr}p|u7vwv]RiSBd;pppzq@qHQa?(b.!a.a`@.|xa(hFv;Wiyj5uuv-7Riw~Cw`fg2WlU978BbU|wOuNBJqG!(P~EfD~CRlQcZ#X,k)u3vWs@u2]ksg;wEx'f@q1_2Wg.j]uNpn~FRfqJv]!15x'h{qG!(@@=IzK~CRl^j6v(us5x4i,#T(2WmY?C2F{1>Kq<aj1!*jTqIsBv=Wld~Cw`fj2Wl[j`v0u*~>RlT=c>Z,k#u3vWs@u2]kq<c1Z+jTqIsBv=Wle~Cw`fn2Wl]dn1#c(a(b^a2!b/bAT(bj!aDa7bu,a_a{c0!2T0g:v>ReD2@G{42@G{5~DpM~<5rc=Bx6i>{RT#RnI@zCx]y]z:2Jv[!zr5Awyk]9]k]dD(Y+X#6Vz.g=wKtgwhaCwgmTWj2Lu,w%_+/[y-B;b^xeg3u3Rj-2@bX{*KrJ<!+'@Wg(g?QRlC@Jv`!%b[zIwsfII}8JQ_@w|kW|=Jv(%!AqcOuNBJvEzh!bYzjLs@wP#(0!oy@>RkdJwMZtc3Dtd@BcG#T'9bWxg2@2Fznd*#Y+;2x'c}w<zizixNgwa#Z'U+!/!a'!a+w~g~z6wcn{Rn}wcnzRn|5Rh%=]nJg5vuRmvNvdRlvcprJu}w*az*a#!%.a.'Bot9qT]kj@Wg'ay2Gzv@Jv`!%b[zEwsfHI}1;ck#Ux`<Cbbx_Lu+w!a&0*!wko*wwo,So,}6Juqxf!E}PigQuyRm`d3(`#8>Rn%:A5B;bZ~%KvhCa!a2!x>k7#Uxb@b{#xaRk7Jw0!)>wwhlShl}6>wwhmShm}6CJvB!.x'hhvj{!!5Bwkhhbaz}x'hivjz~!5Bwkhibaz|xEhTrNu,v-vpD!a%&/)a3a.,%Ro2t[CE{)@3re9b]{%wjo09:rgc:Z&Ro6=<riifuaw&RmoKrNA!%(Ro4>Ro89;Ri`dSaL'UYzxZb)7Rka3xRhT&!,!#^1U}vbaz{>>@=be}yC@:D5bazzKu+A&!}{?ba}y>>@=be}wxBh[t`u~vJvr!%a!a()a,a0a4RoC=]o;Ju(!%RoGRhdwjh`=]oAg>w#Ro?g5vuRo=NvdRl|Ku]C.!&;RoEJvB!%RoORoMBx'h[v+_?w~h`}~5?w~hd~!xKh]oiptu-utv.vp!#%&a30a@a'a+(a/aOp(o~p!RoDJu(!%RoHRhewjha=]oBNvdRl}g>w#Ro@g5vuRo>c[#X']o<CauRoRAd-#Y':RkpauRoQKu]C.!&;RoFJvB!%RoNRoPBx'h]v+_?w~ha}t5?w~he}ue!/UbhYacXaW^Tc&a;b:a-c/#b&aja1(!cL+!bKbt!bmcRc9aIc?8[yW3Dtt94Rg`Jv}!&SiRMzBhEebShEMNuPRe>x7gL#TzuwjirRipc<Z&>on;>z=h-MSh.Mwqczx'a7vj&!>Re4@=ResJt__NuPRi*NuPRi)j]uNr|~FRfzKrJ>_+@Wfy@Wf]2WocKrJ<!+'@Wg%g/QRl@@Jv`!&awRl<wsfFIzgLu(w*!.*&ShBMwvhIRhI9;RhNx1hK'!#Sn]Mx1hK~0!#:2<H~7cNu+w7D*'1ZtW>Rn1~?rOc:Z&Rn2=<rQ<7wjh&=BSnLMc]#X(6Vz)w[b=a!U#9wzgMc3#&(RgMRitRis<x,gKt`ax!&+SioM=BSilMc3#&(RgKRinRimKurB,!&SiQMzBhDebShDM6BJQ!(P~Efx978B2@@=I}WLrJw!!,a*&@G}O@9wkibRid@@x'fKwC!&SlDMSfLMjUv~Q~EfKKv3@a+!(hFv-]mpx/hYZ(C5RiWz<o/MwkhY?So/M@x,gbvfB*&!SgEM:SoeeehFu3:Rgbda(,^TZa)X/7Sg[eb:2RgI~BrMC@wgkc:wwkcRerx3h(uUvK!&*,SnOM4Sh*MArRg;wHRh(x=h;rJvPwI!a4',a'0@Wg&=BSh/Mg>w=Rh=g3w*wwgGRgGcW(X#;Sg}M2Gzk@Jv`!&awRl=wsfGIz`dKZ*T'Y-:RhR7RhQg5u-p`j6v(us5d,#Y+~Awkia?RicOuNBwkibba}Ld6p~tyu_vbAa'a+!a/'a3aEa8a!>Sh,ebJv{!&Sh@ebSaReb9;SgwebNuPRi(NvdRl)NuPRi'hHu^<Rm^Jvv_@Wl(g;u1Si/ebKu'B&!*Sh?eb@Wl'z@aPeb95Si.ebcpputyvjB)!,&a+0a%ShAMWeK@G}C@WfJ9;RhMwvhH9w{ia}ix,hJvRA1(!zAn[MRhHx1hJ~*!#hFv(BSn[MBJQ!(@@=I~'978B2@@=I}2db.Ua<'X}+T#a0XaG2G}E;wkg|wuh!Rh!x,hZu,@)!&So0MVy)C5RiXACJvB!&5RiY5RiZg8w)cG}*T#2@bU}=KsA>(!a.3wkhZba~(x,h^u(A!&(SoCMRhb5Bz=h[eb?w~hb~6x,h_u(A!&(SoDMRhc5Bz=h]eb?w~hc~6e)aA1T#T,^^^c-bMb&blcPaP(a/!0!bA=b5c@a(!bfbrc#2afwmhARnjwchORnp2Wlf3DtsNvdRl-2@wpa<]m0bx(#:awRk2@Jw3!%RfhwpfgRlnKQB%!(G{V@G|'NuuRl6d='T+Y#VyUg<v~Rl~==G|<Jv+'!aYShC}6@B<5?ba~8@Jw3'!g2QRljhLrpWlOd+#Y'g.w'rIg>w*wgj@g-u0Rj@Lu+wT&)ZtUauq]~GrGci&U#F|39:rELrNvj!.%*RhCwunfw~nf~:9;Ri]>wtnhg;wHRnhx3hDs@v~!/+'@Wfr@9RkSNu&Rlo=@<5GzoKs0@_+@Wl+@awRkmJuh!-3d(}pY#qWJvj!%Rm(:Jw3!%Rm,Rm*de&!1U-U#`)Re;@G|.@9Ri82@wjfvRlq=@<5GzpLvOvr!).&2RlF8Rf`C=x!eE{.Jw3_g2QRlkhLrpWlPde(!#U{s,UXa*Ta'[y'g:v>ReS;x0PZ&RnlRnn~HrKJw1}f!=x!eB|2w]aP(#Xa&a*Ta.Ua2a7=]iOd'#Y&Ro&WnWg;u.RiDg6vjRiBNvdRlzhNvj]nYJuW_2Wm3x)kFze{9d])!a.!,Y01!#&aC!a3RndC=ox~BrC@2b^{pg,rlse7x'ksuq!%Rm.E{xidw(wBRmGx9o+)X#wwo-So-}69:Rl4@xSf@a#XZ'X)X,Ta(/ARl8b[xc>RfY:RlI:RfQwlg.ARl:9;Rlwdn'#^XafaQa1X1TaHTa)@b[{zcZ#X'7RkwWg@Ou4ARn&x)kG#{,g7u/RkGdH'U#Y*Vz'Wm&CARm|bx#(A]gUbUzJj9Q~=d,#Y(56H}l978H{U7d,0#U*2>ABb_xZ978BbU{e~AJQ{g!978BbU{hxMh?ad{oUYZ.x1h?{l!#:2<H{mx3n[t{vl!,&a%3Ro(z=iS}6ARnr=Bwsn^wvn`Rnbd`*T}B0!#^X'BG{c9b]{a>>@=be}F?JvS!&BG{d7BG}(Bde#`a1X,Ya@!a'P~=wxf@2bZ}I56B2@@=aybb}08@55B9;5bb}<j3vLv;<Jw3&!>Rfg=ayb^}&OuNBKuLA!)a!P~=x#fD{f2@>==<bbzl?C972@@=Ix^d6rSu,v7w*C(0a)a6#B+a%!sQ[y?3Dt%3[xn~<5rLOu!5p@Ku+D#'!t7~GrP~?rNKvlaya7'!h+v-5qMg=t|cd,U#5AAaa5Abb{S@52B5@a[@52B5Gx[iXueu;d<#`a(!/549C;ag>23ExY5@Dah89b^~689Jv)!~2b[~1Lv'w(%*!a#bX|aPrmawRe]keu7uhv-q6rxu,q`xTo]/a5aU!bNaDXbi!b-!ao!b<bwA!#5@B932:aV2G|:d-)Y#hJrL>RhG<7@C5<H|_=Cau:5aj5@B932:bJ|ng>vIbs)#?C2F|9jPv0w.vISh-MKvUaz(.!9ABbb|[5;5<H|Eg>unwfh;9:4E|YjQsBt|vjx'hYq3!(?C2F|J:2<BaY?C2F|GOu!5x,g|p{ah!-(?C2F|c9:4E|OjXuvvNr}:Rh&i[w*t|cd+U#jJvsu)vsSn~Mkfrmu9p}u7vwv]So!McW#Xa!ax5@A5aY:5;5<H|>kJv~vYrquJu3x4ib#T)2@SmZM?C2F|Bj:rmu9@xPhI(a*a#U#`a3-5Abb|L~@:RhK9:4E|0@52B5G|#C::aY?C2F|-:2<BaY?C2F|.5Jvk!a)javYrquJu3x4ia#T)2@SmYM?C2F|HAxPhH(!a#U#`a*-5Abb|4~@:RhJ9:4E|R@52B5G|F:2<BaY?C2F|Sc^#Xa2j=Qq5CJvB!-g<v{z;hhM?C2F|Zi[vrv{z;hiM?C2F|XKsA>!a)-g<v{z;h[eb?C2F|]i[vrv{z;h]eb?C2F|^iZu.vix,hZq3ah!.(?C2F|QOu!5ShXM:2<BaY?C2F|P", 13494, 2713, 49, 25, 61);

// openclaw/node_modules/.pnpm/entities@8.1.0/node_modules/entities/dist/internal/bin-trie-flags.js
var U;
(function(e) {
  e[e.VALUE_LENGTH = 49152] = "VALUE_LENGTH", e[e.FLAG13 = 8192] = "FLAG13", e[e.BRANCH_LENGTH = 8064] = "BRANCH_LENGTH", e[e.JUMP_TABLE = 127] = "JUMP_TABLE", e[e.VALUE_MASK = 8191] = "VALUE_MASK";
})(U || (U = {}));

// openclaw/node_modules/.pnpm/entities@8.1.0/node_modules/entities/dist/decode.js
var q;
(function(e) {
  e[e.AMP = 38] = "AMP", e[e.NUM = 35] = "NUM", e[e.SEMI = 59] = "SEMI", e[e.EQUALS = 61] = "EQUALS", e[e.ZERO = 48] = "ZERO", e[e.NINE = 57] = "NINE", e[e.LOWER_A = 97] = "LOWER_A", e[e.LOWER_X = 120] = "LOWER_X";
})(q || (q = {}));
var Fe = 32, Fn = 21, ni = 2097151, lt = 2047, Ln = 0;
function ri(e) {
  let t = e >>> Fn;
  return t === lt ? Ln : t;
}
function Un(e) {
  return e - q.ZERO >>> 0 <= 9;
}
function oi(e) {
  return (e | Fe) - q.LOWER_A >>> 0 <= 5;
}
function Bn(e) {
  return (e | Fe) - q.LOWER_A >>> 0 <= 25;
}
function ii(e) {
  return e === q.EQUALS || Bn(e) || Un(e);
}
var On;
(function(e) {
  e[e.EntityStart = 0] = "EntityStart", e[e.NumericStart = 1] = "NumericStart", e[e.NumericDecimal = 2] = "NumericDecimal", e[e.NumericHex = 3] = "NumericHex", e[e.NamedEntity = 4] = "NamedEntity";
})(On || (On = {}));
var ut;
(function(e) {
  e[e.Legacy = 0] = "Legacy", e[e.Strict = 1] = "Strict", e[e.Attribute = 2] = "Attribute";
})(ut || (ut = {}));
function si(e, t, n, r) {
  let o = (t & U.BRANCH_LENGTH) >> 7, i = t & U.JUMP_TABLE;
  if (i) {
    if (o === 0)
      return r === i ? n : -1;
    let u = r - i;
    if (u >>> 0 >= o)
      return -1;
    let d = e[n + u];
    return d === 0 ? -1 : n + o + d - 1 & 65535;
  }
  if (o === 0)
    return -1;
  let s = o + 1 >> 1, a = n + s + o;
  for (let u = 0; u < o; u++) {
    let f = e[n + (u >> 1)] >> ((u & 1) << 3) & 255;
    if (f === r) {
      let g = n + s + u;
      return a + e[g] & 65535;
    }
    if (f > r)
      return -1;
  }
  return -1;
}
function Nn(e, t, n) {
  return n === 1 ? String.fromCharCode(e[t] & U.VALUE_MASK) : n === 2 ? String.fromCharCode(e[t + 1]) : String.fromCharCode(e[t + 1], e[t + 2]);
}
function ai(e, t, n) {
  let r = t + 1, o = 0, i = r;
  if (r < n && (e.charCodeAt(r) | Fe) === q.LOWER_X)
    for (r += 1, i = r; r < n; ) {
      let a = e.charCodeAt(r);
      if (Un(a))
        o = o * 16 + (a - q.ZERO);
      else if (oi(a))
        o = o * 16 + ((a | Fe) - q.LOWER_A + 10);
      else
        break;
      r += 1;
    }
  else
    for (; r < n; ) {
      let a = e.charCodeAt(r) - q.ZERO;
      if (a >>> 0 > 9)
        break;
      o = o * 10 + a, r += 1;
    }
  if (r === i)
    return 0;
  r < n && e.charCodeAt(r) === q.SEMI && (r += 1), o > 1114111 && (o = 1114112);
  let s = r - t;
  return s >= lt && (Ln = s, s = lt), s << Fn | o;
}
function ci(e, t, n) {
  let r = Pn, o = e.indexOf("&");
  if (o < 0)
    return e;
  let i = e.length, s = 0, a = "", u = r[0], d = u & U.JUMP_TABLE, f = (u & U.BRANCH_LENGTH) >> 7;
  do {
    let g = o + 1, y = e.charCodeAt(g), c, l;
    if (y === q.NUM) {
      let b = ai(e, g, i);
      c = ri(b), t && c > 0 && e.charCodeAt(g + c - 1) !== q.SEMI && (c = 0), l = c === 0 ? "" : Mn(b & ni);
    } else if (Bn(y)) {
      c = 0, l = "";
      let b = y - d, p;
      if (b >>> 0 < f) {
        let C = r[1 + b];
        p = C === 0 ? -1 : f + C & 65535;
      } else
        p = -1;
      let m = 0, h = 0, w = p < 0 ? 0 : r[p], R = g + 1;
      e: for (; R < i; ) {
        for (
          ;
          // Value-less, non-run node with a nonzero jump offset.
          (w & (U.VALUE_LENGTH | U.FLAG13)) === 0 && (w & U.JUMP_TABLE) !== 0;
        ) {
          let A = w & U.JUMP_TABLE, T = (w & U.BRANCH_LENGTH) >> 7;
          if (T === 0) {
            if (e.charCodeAt(R) !== A)
              break e;
            p += 1;
          } else {
            let v = e.charCodeAt(R) - A;
            if (v >>> 0 >= T)
              break e;
            let I = r[p + 1 + v];
            if (I === 0)
              break e;
            p = p + T + I & 65535;
          }
          if (w = r[p], R += 1, R >= i)
            break e;
        }
        if ((w & (U.VALUE_LENGTH | U.FLAG13)) === U.FLAG13) {
          let A = (w & U.BRANCH_LENGTH) >> 7;
          if (e.charCodeAt(R) !== (w & U.JUMP_TABLE))
            break;
          R += 1;
          let T = A - 1, v = p + 1, I = 0;
          for (; I + 1 < T; I += 2) {
            let P = r[v];
            if (e.charCodeAt(R) !== (P & 255) || (R += 1, e.charCodeAt(R) !== (P >> 8 & 255)))
              break e;
            R += 1, v += 1;
          }
          if (I < T) {
            if (e.charCodeAt(R) !== (r[v] & 255))
              break;
            R += 1;
          }
          p += 1 + (A >> 1), w = r[p];
          continue;
        }
        let C = w >>> 14, x = e.charCodeAt(R);
        if (C !== 0) {
          if (x === q.SEMI) {
            c = R - g + 1, l = C === 1 ? String.fromCharCode(w & U.VALUE_MASK) : Nn(r, p, C);
            break;
          }
          if (!t && (w & U.FLAG13) === 0 && (c = R - g, m = p, h = C), C === 1)
            break;
        }
        let _ = si(r, w, p + (C || 1), x);
        if (_ < 0)
          break;
        p = _, w = r[p], R += 1;
      }
      if (l === "") {
        let C = w >>> 14;
        C !== 0 && !t && (w & U.FLAG13) === 0 && (c = R - g, m = p, h = C), c > 0 && (l = Nn(r, m, h));
      }
    } else
      c = 0, l = "";
    c === 0 || n && y !== q.NUM && e.charCodeAt(g + c - 1) !== q.SEMI && g + c < i && ii(e.charCodeAt(g + c)) ? o = g : (s < o && (a += e.slice(s, o)), a += l, o = s = g + c), e.charCodeAt(o) !== q.AMP && (o = e.indexOf("&", o));
  } while (o >= 0);
  return a + e.slice(s);
}
function Le(e) {
  return ci(e, !0, !1);
}

// openclaw/node_modules/.pnpm/entities@8.1.0/node_modules/entities/dist/index.js
var jn;
(function(e) {
  e[e.XML = 0] = "XML", e[e.HTML = 1] = "HTML";
})(jn || (jn = {}));
var Gn;
(function(e) {
  e[e.UTF8 = 0] = "UTF8", e[e.ASCII = 1] = "ASCII", e[e.Extensive = 2] = "Extensive", e[e.Attribute = 3] = "Attribute", e[e.Text = 4] = "Text";
})(Gn || (Gn = {}));

// openclaw/node_modules/.pnpm/linkify-it@6.1.0/node_modules/linkify-it/build/index.mjs
var ui = class {
  src_Any = ot.source;
  src_Cc = it.source;
  src_Z = at.source;
  src_P = Re.source;
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
  nestedPairRE(e, t, n = 4) {
    let r = this.escapeRE(e), o = this.escapeRE(t), i = `(?:(?!${this.src_ZCc}|${r}|${o}).)`, s = `${r}${i}{0,1000}${o}`;
    for (let a = 2; a <= n; a++) s = `${r}(?:${i}|${s}){0,1000}${o}`;
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
    let e = "[0-9A-Fa-f]{1,4}", t = `(?:(?:${e}:${e})|${this.get_ipv4_addr().source})`;
    return this.cache.src_ip6_addr ??= new RegExp(`(?:(?:${e}:){6}${t}|::(?:${e}:){5}${t}|(?:${e})?::(?:${e}:){4}${t}|(?:(?:${e}:){0,1}${e})?::(?:${e}:){3}${t}|(?:(?:${e}:){0,2}${e})?::(?:${e}:){2}${t}|(?:(?:${e}:){0,3}${e})?::${e}:${t}|(?:(?:${e}:){0,4}${e})?::${t}|(?:(?:${e}:){0,5}${e})?::${e}|(?:(?:${e}:){0,6}${e})?::)`);
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
}, dt = {
  validate: (e, t, n) => {
    let r = n.re.get_http_validator();
    r.lastIndex = t;
    let o = r.exec(e);
    return o ? o[0].length : 0;
  },
  normalize: (e, t) => t.normalize(e)
}, di = {
  "http:": dt,
  "https:": dt,
  "ftp:": dt,
  "//": {
    validate: function(e, t, n) {
      let r = n.re.get_relative_proto_validator();
      r.lastIndex = t;
      let o = r.exec(e);
      return o ? t >= 3 && e[t - 3] === ":" || t >= 3 && e[t - 3] === "/" ? 0 : o[0].length : 0;
    },
    normalize: (e, t) => t.normalize(e)
  },
  "mailto:": {
    validate: function(e, t, n) {
      let r = n.re.get_mailto_validator();
      r.lastIndex = t;
      let o = r.exec(e);
      return o ? o[0].length : 0;
    },
    normalize: (e, t) => t.normalize(e)
  }
}, pi = "a:cdefgilmnoqrstuwxz|b:abdefghijmnorstvwyz|c:acdfghiklmnoruvwxyz|d:ejkmoz|e:cegrstu|f:ijkmor|g:abdefghilmnpqrstuwy|h:kmnrtu|i:delmnoqrst|j:emop|k:eghimnprwyz|l:abcikrstuvy|m:acdeghklmnopqrstuvwxyz|n:acefgilopruz|o:m|p:aefghklmnrstwy|q:a|r:eosuw|s:abcdeghijklmnortuvxyz|t:cdfghjklmnortvwz|u:agksyz|v:aceginu|w:fs|y:et|z:amw", fi = "biz|com|edu|gov|net|org|pro|web|xxx|aero|asia|coop|info|museum|name|shop|\u0440\u0444";
function hi() {
  let e = fi.split("|");
  return pi.split("|").forEach((t) => {
    let n = t.indexOf(":"), r = t.slice(0, n);
    for (let o of t.slice(n + 1)) e.push(r + o);
  }), e;
}
var gi = {
  fuzzyLink: !1,
  fuzzyEmail: !0,
  fuzzyIP: !1,
  "---": !1,
  tlds: hi(),
  urlAuth: !1,
  maxLength: 1e4
}, Hn = class {
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
  constructor(e, t, n, r) {
    let o = e.slice(n, r);
    this.schema = t.toLowerCase(), this.index = n, this.lastIndex = r, this.raw = o, this.text = o, this.url = o;
  }
}, qn = class {
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
    let { rebuilder: t, ...n } = e;
    this.__opts__ = {
      ...gi,
      ...n
    }, this.__schemas__ = { ...di }, this.re = t || new ui(), this.re.set({
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
  add(e, t = null) {
    if (!t) delete this.__schemas__[e];
    else {
      let n = {
        normalize: (r, o) => o.normalize(r),
        ...t
      };
      this.__schemas__[e] = n;
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
    let t, n;
    for (n = this.re.get_schema_search(), n.lastIndex = 0; (t = n.exec(e)) !== null; ) if (this.testSchemaAt(e, t[2], n.lastIndex)) return !0;
    if (this.__opts__.fuzzyLink && this.__schemas__["http:"] && (n = this.re.get_fuzzy_link_search(), n.lastIndex = 0, n.exec(e) !== null))
      return !0;
    if (this.__opts__.fuzzyEmail && this.__schemas__["mailto:"] && e.indexOf("@") >= 0) {
      let r = this.re.get_fuzzy_mail_host_search(), o = this.re.get_mail_name_validator();
      for (r.lastIndex = 0; (t = r.exec(e)) !== null; ) {
        let i = e.slice(Math.max(0, t.index - 65), t.index);
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
  testSchemaAt(e, t, n) {
    return this.__schemas__[t.toLowerCase()] ? this.__schemas__[t.toLowerCase()].validate(e.slice(0, n + this.__opts__.maxLength), n, this) : 0;
  }
  /**
  * Returns array of found link descriptions or `null` on fail. We strongly
  * recommend to use {@link LinkifyIt.test} first, for best speed.
  *
  * @param text Text to scan.
  */
  match(e) {
    let t = [], n = this.re.get_schema_search(), r, o, i, s, a, u, d = !1, f = !1, g = !1, y = 0;
    if (!e.length) return null;
    for (n.lastIndex = 0, this.__opts__.fuzzyLink && this.__schemas__["http:"] && (r = this.re.get_fuzzy_link_search(), r.lastIndex = 0), this.__opts__.fuzzyEmail && this.__schemas__["mailto:"] && (o = this.re.get_fuzzy_mail_host_search(), o.lastIndex = 0, i = this.re.get_mail_name_validator()); ; ) {
      let c = Math.max(y - 1, 0);
      if (o && i && !g && (!a || a.index < y))
        for (o.lastIndex < c && (o.lastIndex = c); ; ) {
          let h = o.exec(e);
          if (!h) {
            g = !0, a = void 0;
            break;
          }
          let w = i.exec(e.slice(Math.max(0, h.index - 65), h.index));
          if (w) {
            if (a = {
              schema: "mailto:",
              index: h.index - w[1].length,
              lastIndex: h.index + h[0].length
            }, a.index >= y) break;
            o.lastIndex < c && (o.lastIndex = c);
          }
        }
      if (r && !f && (!s || s.index < y))
        for (r.lastIndex < c && (r.lastIndex = c); ; ) {
          let h = r.exec(e);
          if (!h) {
            f = !0, s = void 0;
            break;
          }
          if (s = {
            schema: "",
            index: h.index + h[1].length,
            lastIndex: h.index + h[0].length
          }, s.index >= y) break;
          r.lastIndex < c && (r.lastIndex = c);
        }
      let l = a;
      (!l || s && (s.index < l.index || s.index === l.index && s.lastIndex > l.lastIndex)) && (l = s);
      let b;
      if (!d) for (; ; ) {
        if (!u) {
          n.lastIndex < c && (n.lastIndex = c);
          let R = n.exec(e);
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
        if (u.index < y) {
          u = void 0;
          continue;
        }
        if (l && u.index > l.index) break;
        let h = u;
        u = void 0;
        let w = this.testSchemaAt(e, h.schema, h.lastIndex);
        if (w) {
          b = {
            schema: h.schema,
            index: h.index,
            lastIndex: h.lastIndex + w
          };
          break;
        }
      }
      let p = b;
      if ((!p || a && (a.index < p.index || a.index === p.index && a.lastIndex > p.lastIndex)) && (p = a), (!p || s && (s.index < p.index || s.index === p.index && s.lastIndex > p.lastIndex)) && (p = s), !p) break;
      p === a ? a = void 0 : p === s && (s = void 0);
      let m = new Hn(e, p.schema, p.index, p.lastIndex);
      m.schema ? this.__schemas__[m.schema].normalize(m, this) : this.normalize(m), t.push(m), y = p.lastIndex;
    }
    return t.length ? t : null;
  }
  /**
  * Returns fully-formed (not fuzzy) link if it starts at the beginning
  * of the string, and null otherwise.
  *
  * @param text Text to scan.
  */
  matchAtStart(e) {
    if (!e.length) return null;
    let t = this.re.get_schema_at_start().exec(e);
    if (!t) return null;
    let n = this.testSchemaAt(e, t[2], t[0].length);
    if (!n) return null;
    let r = new Hn(e, t[2], t.index + t[1].length, t.index + t[0].length + n);
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
  tlds(e, t = !1) {
    return e = Array.isArray(e) ? e : [e], t ? this.__opts__.tlds = this.__opts__.tlds.concat(e) : this.__opts__.tlds = e, this.re.set({
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
var wt = It(Xn(), 1);
var Zn = Object.defineProperty, ur = (e, t) => {
  let n = {};
  for (var r in e) Zn(n, r, {
    get: e[r],
    enumerable: !0
  });
  return t || Zn(n, Symbol.toStringTag, { value: "Module" }), n;
}, Ei = /* @__PURE__ */ ur({
  arrayReplaceAt: () => Ii,
  asciiTrim: () => He,
  callable: () => dr,
  escapeHtml: () => Z,
  escapeRE: () => Li,
  fromCodePoint: () => Ce,
  isMdAsciiPunct: () => Te,
  isPunctChar: () => fr,
  isPunctCharCode: () => _e,
  isSpace: () => O,
  isValidEntityCode: () => Rt,
  isWhiteSpace: () => ke,
  lib: () => Ui,
  normalizeReference: () => Ge,
  unescapeAll: () => pe,
  unescapeMd: () => Mi
});
function dr(e) {
  let t = function(...n) {
    return Reflect.construct(e, n, new.target && new.target !== t ? new.target : e);
  };
  return Object.defineProperty(t, "name", { value: e.name }), Object.setPrototypeOf(t, e), t.prototype = e.prototype, t;
}
function Ii(e, t, n) {
  return [].concat(e.slice(0, t), n, e.slice(t + 1));
}
function Rt(e) {
  return !(e >= 55296 && e <= 57343 || e >= 64976 && e <= 65007 || (e & 65535) === 65535 || (e & 65535) === 65534 || e >= 0 && e <= 8 || e === 11 || e >= 14 && e <= 31 || e >= 127 && e <= 159 || e > 1114111);
}
function Ce(e) {
  if (e > 65535) {
    e -= 65536;
    let t = 55296 + (e >> 10), n = 56320 + (e & 1023);
    return String.fromCharCode(t, n);
  }
  return String.fromCharCode(e);
}
var pr = /\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, Si = new RegExp(`${pr.source}|${/&([a-z#][a-z0-9]{1,31});/gi.source}`, "gi"), Ai = /^#((?:x[a-f0-9]{1,8}|[0-9]{1,8}))$/i;
function vi(e, t) {
  if (t.charCodeAt(0) === 35 && Ai.test(t)) {
    let r = t[1].toLowerCase() === "x" ? parseInt(t.slice(2), 16) : parseInt(t.slice(1), 10);
    return Rt(r) ? Ce(r) : e;
  }
  let n = Le(e);
  return n !== e ? n : e;
}
function Mi(e) {
  return e.indexOf("\\") < 0 ? e : e.replace(pr, "$1");
}
function pe(e) {
  return e.indexOf("\\") < 0 && e.indexOf("&") < 0 ? e : e.replace(Si, function(t, n, r) {
    return n || vi(t, r);
  });
}
var Di = /[&<>"]/, Pi = /[&<>"]/g, Oi = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;"
};
function Ni(e) {
  return Oi[e];
}
function Z(e) {
  return Di.test(e) ? e.replace(Pi, Ni) : e;
}
var Fi = /[.?*+^$[\]\\(){}|-]/g;
function Li(e) {
  return e.replace(Fi, "\\$&");
}
function O(e) {
  switch (e) {
    case 9:
    case 32:
      return !0;
  }
  return !1;
}
function ke(e) {
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
function fr(e) {
  return Re.test(e) || st.test(e);
}
function _e(e) {
  return fr(Ce(e));
}
function Te(e) {
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
function Ge(e) {
  return e = e.trim().replace(/\s+/g, " "), e.toLowerCase().toUpperCase();
}
function Qn(e) {
  return e === 32 || e === 9 || e === 10 || e === 13;
}
function He(e) {
  let t = 0;
  for (; t < e.length && Qn(e.charCodeAt(t)); t++) ;
  let n = e.length - 1;
  for (; n >= t && Qn(e.charCodeAt(n)); n--) ;
  return e.slice(t, n + 1);
}
var Ui = {
  mdurl: rt,
  ucmicro: ct
};
function Bi(e, t, n) {
  let r, o, i, s, a = e.posMax, u = e.pos;
  for (e.pos = t + 1, r = 1; e.pos < a; ) {
    if (i = e.src.charCodeAt(e.pos), i === 93 && (r--, r === 0)) {
      o = !0;
      break;
    }
    if (s = e.pos, e.md.inline.skipToken(e), i === 91) {
      if (s === e.pos - 1) r++;
      else if (n)
        return e.pos = u, -1;
    }
  }
  let d = -1;
  return o && (d = e.pos), e.pos = u, d;
}
function ji(e, t, n) {
  let r, o = t, i = {
    ok: !1,
    pos: 0,
    str: ""
  };
  if (e.charCodeAt(o) === 60) {
    for (o++; o < n; ) {
      if (r = e.charCodeAt(o), r === 10 || r === 60) return i;
      if (r === 62)
        return i.pos = o + 1, i.str = pe(e.slice(t + 1, o)), i.ok = !0, i;
      if (r === 92 && o + 1 < n) {
        o += 2;
        continue;
      }
      o++;
    }
    return i;
  }
  let s = 0;
  for (; o < n && (r = e.charCodeAt(o), !(r === 32 || r < 32 || r === 127)); ) {
    if (r === 92 && o + 1 < n) {
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
  return t === o || s !== 0 || (i.str = pe(e.slice(t, o)), i.pos = o, i.ok = !0), i;
}
function Gi(e, t, n, r) {
  let o, i = t, s = {
    ok: !1,
    can_continue: !1,
    pos: 0,
    str: "",
    marker: 0
  };
  if (r)
    s.str = r.str, s.marker = r.marker;
  else {
    if (i >= n) return s;
    let a = e.charCodeAt(i);
    if (a !== 34 && a !== 39 && a !== 40) return s;
    t++, i++, a === 40 && (a = 41), s.marker = a;
  }
  for (; i < n; ) {
    if (o = e.charCodeAt(i), o === s.marker)
      return s.pos = i + 1, s.str += pe(e.slice(t, i)), s.ok = !0, s;
    if (o === 40 && s.marker === 41) return s;
    o === 92 && i + 1 < n && i++, i++;
  }
  return s.can_continue = !0, s.str += pe(e.slice(t, i)), s;
}
var Hi = /* @__PURE__ */ ur({
  parseLinkDestination: () => ji,
  parseLinkLabel: () => Bi,
  parseLinkTitle: () => Gi
});
function Ee(e) {
  "@babel/helpers - typeof";
  return Ee = typeof Symbol == "function" && typeof Symbol.iterator == "symbol" ? function(t) {
    return typeof t;
  } : function(t) {
    return t && typeof Symbol == "function" && t.constructor === Symbol && t !== Symbol.prototype ? "symbol" : typeof t;
  }, Ee(e);
}
function qi(e, t) {
  if (Ee(e) != "object" || !e) return e;
  var n = e[Symbol.toPrimitive];
  if (n !== void 0) {
    var r = n.call(e, t || "default");
    if (Ee(r) != "object") return r;
    throw new TypeError("@@toPrimitive must return a primitive value.");
  }
  return (t === "string" ? String : Number)(e);
}
function zi(e) {
  var t = qi(e, "string");
  return Ee(t) == "symbol" ? t : t + "";
}
function k(e, t, n) {
  return (t = zi(t)) in e ? Object.defineProperty(e, t, {
    value: n,
    enumerable: !0,
    configurable: !0,
    writable: !0
  }) : e[t] = n, e;
}
var ie = class {
  constructor(e, t, n) {
    k(
      this,
      /**
      * Source map info. Format: `[ line_begin, line_end ]`
      */
      "map",
      null
    ), k(
      this,
      /**
      * nesting level, the same as `state.level`
      */
      "level",
      0
    ), k(
      this,
      /**
      * An array of child nodes (inline and img tokens)
      */
      "children",
      null
    ), k(
      this,
      /**
      * In a case of self-closing tag (code, html, fence, etc.),
      * it has contents of this tag.
      */
      "content",
      ""
    ), k(
      this,
      /**
      * '*' or '_' for emphasis, fence string for fence, etc.
      */
      "markup",
      ""
    ), k(
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
    ), k(
      this,
      /**
      * True for block-level tokens, false for inline tokens.
      * Used in renderer to calculate line breaks
      */
      "block",
      !1
    ), k(
      this,
      /**
      * If it's true, ignore this element when rendering. Used for tight lists
      * to hide paragraphs.
      */
      "hidden",
      !1
    ), this.type = e, this.tag = t, this.attrs = null, this.nesting = n, this.meta = null;
  }
  /**
  * Search attribute index by name.
  */
  attrIndex(e) {
    if (!this.attrs) return -1;
    let t = this.attrs;
    for (let n = 0, r = t.length; n < r; n++) if (t[n][0] === e) return n;
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
  attrSet(e, t) {
    let n = this.attrIndex(e), r = [e, t];
    n < 0 ? this.attrPush(r) : this.attrs[n] = r;
  }
  /**
  * Get the value of attribute `name`, or null if it does not exist.
  */
  attrGet(e) {
    let t = this.attrIndex(e), n = null;
    return t >= 0 && (n = this.attrs[t][1]), n;
  }
  /**
  * Join value to existing attribute via space. Or create new attribute if not
  * exists. Useful to operate with token classes.
  */
  attrJoin(e, t) {
    let n = this.attrIndex(e);
    n < 0 ? this.attrPush([e, t]) : this.attrs[n][1] = `${this.attrs[n][1]} ${t}`;
  }
}, Ie = class {
  constructor() {
    k(
      this,
      /** @internal */
      "__rules__",
      []
    ), k(
      this,
      /** @internal */
      "__cache__",
      null
    );
  }
  /** @internal */
  __find__(e) {
    for (let t = 0; t < this.__rules__.length; t++) if (this.__rules__[t].name === e) return t;
    return -1;
  }
  /** @internal */
  __compile__() {
    let e = /* @__PURE__ */ new Set();
    this.__rules__.forEach((t) => {
      t.enabled && t.alt.forEach((n) => {
        n && e.add(n);
      });
    }), this.__cache__ = /* @__PURE__ */ Object.create(null), this.__cache__[""] = [], this.__rules__.forEach((t) => {
      t.enabled && this.__cache__[""].push(t.fn);
    }), e.forEach((t) => {
      this.__cache__[t] = [], this.__rules__.forEach((n) => {
        n.enabled && n.alt.indexOf(t) >= 0 && this.__cache__[t].push(n.fn);
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
  at(e, t, n = {}) {
    let r = this.__find__(e);
    if (r === -1) throw new Error(`Parser rule not found: ${e}`);
    this.__rules__[r].fn = t, this.__rules__[r].alt = n.alt || [], this.__cache__ = null;
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
  before(e, t, n, r = {}) {
    let o = this.__find__(e);
    if (o === -1) throw new Error(`Parser rule not found: ${e}`);
    this.__rules__.splice(o, 0, {
      name: t,
      enabled: !0,
      fn: n,
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
  after(e, t, n, r = {}) {
    let o = this.__find__(e);
    if (o === -1) throw new Error(`Parser rule not found: ${e}`);
    this.__rules__.splice(o + 1, 0, {
      name: t,
      enabled: !0,
      fn: n,
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
  push(e, t, n = {}) {
    this.__rules__.push({
      name: e,
      enabled: !0,
      fn: t,
      alt: n.alt || []
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
  enable(e, t = !1) {
    Array.isArray(e) || (e = [e]);
    let n = [];
    return e.forEach((r) => {
      let o = this.__find__(r);
      if (o < 0) {
        if (t) return;
        throw new Error(`Rules manager: invalid rule name ${r}`);
      }
      this.__rules__[o].enabled = !0, n.push(r);
    }), this.__cache__ = null, n;
  }
  /**
  * Enable rules with given names, and disable everything else. If any rule name
  * not found - throw Error. Errors can be disabled by second param.
  *
  * See also {@link Ruler.disable}, {@link Ruler.enable}.
  */
  enableOnly(e, t = !1) {
    Array.isArray(e) || (e = [e]), this.__rules__.forEach((n) => {
      n.enabled = !1;
    }), this.enable(e, t);
  }
  /**
  * Disable rules with given names. If any rule name not found - throw Error.
  * Errors can be disabled by second param.
  *
  * See also {@link Ruler.enable}, {@link Ruler.enableOnly}.
  *
  * Returns list of found rule names (if no exception happened).
  */
  disable(e, t = !1) {
    Array.isArray(e) || (e = [e]);
    let n = [];
    return e.forEach((r) => {
      let o = this.__find__(r);
      if (o < 0) {
        if (t) return;
        throw new Error(`Rules manager: invalid rule name ${r}`);
      }
      this.__rules__[o].enabled = !1, n.push(r);
    }), this.__cache__ = null, n;
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
}, K = {};
K.code_inline = function(e, t, n, r, o) {
  let i = e[t];
  return `<code${o.renderAttrs(i)}>${Z(i.content)}</code>`;
};
K.code_block = function(e, t, n, r, o) {
  let i = e[t];
  return `<pre${o.renderAttrs(i)}><code>${Z(e[t].content)}</code></pre>
`;
};
K.fence = function(e, t, n, r, o) {
  let i = e[t], s = i.info ? pe(i.info).trim() : "", a = "", u = "";
  if (s) {
    let f = s.split(/(\s+)/g);
    a = f[0], u = f.slice(2).join("");
  }
  let d;
  if (n.highlight ? d = n.highlight(i.content, a, u) || Z(i.content) : d = Z(i.content), d.indexOf("<pre") === 0) return d + `
`;
  if (s) {
    let f = i.attrIndex("class"), g = i.attrs ? i.attrs.slice() : [];
    f < 0 ? g.push(["class", `${n.langPrefix}${a}`]) : (g[f] = [g[f][0], g[f][1]], g[f][1] += ` ${n.langPrefix}${a}`);
    let y = { attrs: g };
    return `<pre><code${o.renderAttrs(y)}>${d}</code></pre>
`;
  }
  return `<pre><code${o.renderAttrs(i)}>${d}</code></pre>
`;
};
K.image = function(e, t, n, r, o) {
  let i = e[t];
  return i.attrs[i.attrIndex("alt")][1] = o.renderInlineAsText(i.children, n, r), o.renderToken(e, t, n);
};
K.hardbreak = function(e, t, n) {
  return n.xhtmlOut ? `<br />
` : `<br>
`;
};
K.softbreak = function(e, t, n) {
  return n.breaks ? n.xhtmlOut ? `<br />
` : `<br>
` : `
`;
};
K.text = function(e, t) {
  return Z(e[t].content);
};
K.html_block = function(e, t) {
  return e[t].content;
};
K.html_inline = function(e, t) {
  return e[t].content;
};
var hr = class {
  constructor() {
    k(
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
      Object.assign({}, K)
    );
  }
  /**
  * Render token attributes to string.
  */
  renderAttrs(e) {
    let t, n, r;
    if (!e.attrs) return "";
    for (r = "", t = 0, n = e.attrs.length; t < n; t++) r += ` ${Z(e.attrs[t][0])}="${Z(String(e.attrs[t][1]))}"`;
    return r;
  }
  /**
  * Default token renderer. Can be overriden by custom function
  * in {@link Renderer.rules}.
  */
  renderToken(e, t, n) {
    let r = e[t], o = "";
    if (r.hidden) return "";
    let i = t - 1;
    for (; i >= 0 && e[i].hidden && e[i].nesting === 0; ) i--;
    r.block && r.nesting !== -1 && i >= 0 && e[i].hidden && e[i].nesting === -1 && (o += `
`), o += (r.nesting === -1 ? "</" : "<") + r.tag, o += this.renderAttrs(r), r.nesting === 0 && n.xhtmlOut && (o += " /");
    let s = !1;
    if (r.block && (s = !0, r.nesting === 1)) {
      let a = t + 1;
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
  renderInline(e, t, n) {
    let r = "", o = this.rules;
    for (let i = 0, s = e.length; i < s; i++) {
      let a = e[i].type;
      typeof o[a] < "u" ? r += o[a](e, i, t, n, this) : r += this.renderToken(e, i, t);
    }
    return r;
  }
  /**
  * Special kludge for image `alt` attributes to conform CommonMark spec.
  * Don't try to use it! Spec requires to show `alt` content with stripped markup,
  * instead of simple escaping.
  */
  renderInlineAsText(e, t, n) {
    let r = "";
    for (let o = 0, i = e.length; o < i; o++) switch (e[o].type) {
      case "text":
      case "code_inline":
        r += e[o].content;
        break;
      case "image":
        r += this.renderInlineAsText(e[o].children, t, n);
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
  render(e, t, n) {
    let r = "", o = this.rules;
    for (let i = 0, s = e.length; i < s; i++) {
      let a = e[i].type;
      a === "inline" ? r += this.renderInline(e[i].children, t, n) : typeof o[a] < "u" ? r += o[a](e, i, t, n, this) : r += this.renderToken(e, i, t);
    }
    return r;
  }
}, gr = class {
  constructor(e, t, n) {
    k(this, "tokens", []), k(this, "inlineMode", !1), k(this, "Token", ie), this.src = e, this.env = n, this.md = t;
  }
}, Wi = /\r\n?/g, $i = /\0/g;
function Vi(e) {
  let t;
  t = e.src.replace(Wi, `
`), t = t.replace($i, "\uFFFD"), e.src = t;
}
function Ki(e) {
  let t;
  e.inlineMode ? (t = new e.Token("inline", "", 0), t.content = e.src, t.map = [0, 1], t.children = [], e.tokens.push(t)) : e.md.block.parse(e.src, e.md, e.env, e.tokens);
}
function Ji(e) {
  let t = e.tokens, n = 0;
  for (let r = 0; r < t.length; r++)
    t[r].type !== "reference_definition" && (r !== n && (t[n] = t[r]), n++);
  t.length !== n && (t.length = n);
}
function Yi(e) {
  let t = e.tokens;
  for (let n = 0, r = t.length; n < r; n++) {
    let o = t[n];
    o.type === "inline" && e.md.inline.parse(o.content, e.md, e.env, o.children);
  }
}
function Xi(e) {
  return /^<a[>\s]/i.test(e);
}
function Zi(e) {
  return /^<\/a\s*>/i.test(e);
}
function Qi(e) {
  let t = e.tokens;
  if (e.md.options.linkify)
    for (let n = 0, r = t.length; n < r; n++) {
      if (t[n].type !== "inline" || !e.md.linkify.test(t[n].content)) continue;
      let o = t[n].children, i = [], s = 0;
      for (let a = o.length - 1; a >= 0; a--) {
        let u = o[a];
        if (u.type === "link_close") {
          for (a--; o[a].level !== u.level && o[a].type !== "link_open"; ) a--;
          continue;
        }
        if (u.type === "html_inline" && (Xi(u.content) && s > 0 && s--, Zi(u.content) && s++), !(s > 0) && u.type === "text" && e.md.linkify.test(u.content)) {
          let d = u.content, f = e.md.linkify.match(d), g = [], y = u.level, c = 0;
          f.length > 0 && f[0].index === 0 && a > 0 && o[a - 1].type === "text_special" && (f = f.slice(1));
          for (let l = 0; l < f.length; l++) {
            let b = f[l].url, p = e.md.normalizeLink(b);
            if (!e.md.validateLink(p)) continue;
            let m = f[l].text;
            f[l].schema ? f[l].schema === "mailto:" && !/^mailto:/i.test(m) ? m = e.md.normalizeLinkText(`mailto:${m}`).replace(/^mailto:/, "") : m = e.md.normalizeLinkText(m) : m = e.md.normalizeLinkText(`http://${m}`).replace(/^http:\/\//, "");
            let h = f[l].index;
            if (h > c) {
              let x = new e.Token("text", "", 0);
              x.content = d.slice(c, h), x.level = y, g.push(x);
            }
            let w = new e.Token("link_open", "a", 1);
            w.attrs = [["href", p]], w.level = y++, w.markup = "linkify", w.info = "auto", g.push(w);
            let R = new e.Token("text", "", 0);
            R.content = m, R.level = y, g.push(R);
            let C = new e.Token("link_close", "a", -1);
            C.level = --y, C.markup = "linkify", C.info = "auto", g.push(C), c = f[l].lastIndex;
          }
          if (c < d.length) {
            let l = new e.Token("text", "", 0);
            l.content = d.slice(c), l.level = y, g.push(l);
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
        let u = new Array(a), d = 0, f = 0;
        i.reverse();
        for (let g = 0; g < o.length; g++) {
          let y = i[d];
          if (y?.index === g) {
            for (let c of y.nodes) u[f++] = c;
            d++;
          } else u[f++] = o[g];
        }
        t[n].children = u;
      }
    }
}
var mr = /\+-|\.\.|\?\?\?\?|!!!!|,,|--/, es = /\((c|tm|r)\)/i, ts = /\((c|tm|r)\)/gi, ns = {
  c: "\xA9",
  r: "\xAE",
  tm: "\u2122"
};
function rs(e, t) {
  return ns[t.toLowerCase()];
}
function os(e) {
  let t = 0;
  for (let n = e.length - 1; n >= 0; n--) {
    let r = e[n];
    r.type === "text" && !t && (r.content = r.content.replace(ts, rs)), r.type === "link_open" && r.info === "auto" && t--, r.type === "link_close" && r.info === "auto" && t++;
  }
}
function is(e) {
  let t = 0;
  for (let n = e.length - 1; n >= 0; n--) {
    let r = e[n];
    r.type === "text" && !t && mr.test(r.content) && (r.content = r.content.replace(/\+-/g, "\xB1").replace(/\.{2,}/g, "\u2026").replace(/([?!])…/g, "$1..").replace(/([?!]){4,}/g, "$1$1$1").replace(/,{2,}/g, ",").replace(/(^|[^-])---(?=[^-]|$)/gm, "$1\u2014").replace(/(^|\s)--(?=\s|$)/gm, "$1\u2013").replace(/(^|[^-\s])--(?=[^-\s]|$)/gm, "$1\u2013")), r.type === "link_open" && r.info === "auto" && t--, r.type === "link_close" && r.info === "auto" && t++;
  }
}
function ss(e) {
  let t;
  if (e.md.options.typographer)
    for (t = e.tokens.length - 1; t >= 0; t--)
      e.tokens[t].type === "inline" && (es.test(e.tokens[t].content) && os(e.tokens[t].children), mr.test(e.tokens[t].content) && is(e.tokens[t].children));
}
var as = /['"]/, er = /['"]/g, tr = "\u2019", cs = 1e3;
function nr(e, t, n) {
  for (; e.length > n; ) {
    let r = e.pop();
    r.isSingleQuote ? t.single = r.prevSameQuoteIdx : t.double = r.prevSameQuoteIdx;
  }
}
function Ue(e, t, n, r) {
  e[t] || (e[t] = []), e[t].push({
    pos: n,
    ch: r
  });
}
function ls(e, t) {
  let n = "", r = 0;
  t.sort((o, i) => o.pos - i.pos);
  for (let o = 0; o < t.length; o++) {
    let i = t[o];
    n += e.slice(r, i.pos) + i.ch, r = i.pos + 1;
  }
  return n + e.slice(r);
}
function us(e, t) {
  let n, r = [], o = {
    single: -1,
    double: -1
  }, i = {};
  for (let s = 0; s < e.length; s++) {
    let a = e[s], u = e[s].level;
    for (n = r.length - 1; n >= 0 && !(r[n].level <= u); n--) ;
    if (nr(r, o, n + 1), a.type !== "text") continue;
    let d = a.content, f = 0, g = d.length;
    e: for (; f < g; ) {
      er.lastIndex = f;
      let y = er.exec(d);
      if (!y) break;
      let c = !0, l = !0;
      f = y.index + 1;
      let b = y[0] === "'", p = 32;
      if (y.index - 1 >= 0) p = d.charCodeAt(y.index - 1);
      else for (n = s - 1; n >= 0 && !(e[n].type === "softbreak" || e[n].type === "hardbreak"); n--)
        if (e[n].content) {
          p = e[n].content.charCodeAt(e[n].content.length - 1);
          break;
        }
      let m = 32;
      if (f < g) m = d.charCodeAt(f);
      else for (n = s + 1; n < e.length && !(e[n].type === "softbreak" || e[n].type === "hardbreak"); n++)
        if (e[n].content) {
          m = e[n].content.charCodeAt(0);
          break;
        }
      let h = Te(p) || _e(p), w = Te(m) || _e(m), R = ke(p), C = ke(m);
      if (C ? c = !1 : w && (R || h || (c = !1)), R ? l = !1 : h && (C || w || (l = !1)), m === 34 && y[0] === '"' && p >= 48 && p <= 57 && (l = c = !1), c && l && (c = h, l = w), !c && !l) {
        b && Ue(i, s, y.index, tr);
        continue;
      }
      if (l && (n = b ? o.single : o.double, n >= 0 && r[n].level === u)) {
        let x = r[n], _, A;
        b ? (_ = t.md.options.quotes[2], A = t.md.options.quotes[3]) : (_ = t.md.options.quotes[0], A = t.md.options.quotes[1]), Ue(i, s, y.index, A), Ue(i, x.tokenIdx, x.contentPos, _), nr(r, o, n);
        continue e;
      }
      if (c) {
        if (r.length >= cs) return;
        r.push({
          tokenIdx: s,
          contentPos: y.index,
          isSingleQuote: b,
          level: u,
          prevSameQuoteIdx: b ? o.single : o.double
        }), b ? o.single = r.length - 1 : o.double = r.length - 1;
      } else l && b && Ue(i, s, y.index, tr);
    }
  }
  Object.keys(i).forEach(function(s) {
    let a = Number(s);
    e[a].content = ls(e[a].content, i[s]);
  });
}
function ds(e) {
  if (e.md.options.typographer)
    for (let t = e.tokens.length - 1; t >= 0; t--)
      e.tokens[t].type !== "inline" || !as.test(e.tokens[t].content) || us(e.tokens[t].children, e);
}
function ps(e) {
  let t, n, r = e.length;
  for (t = 0; t < r; t++) e[t].type === "text_special" && (e[t].type = "text");
  for (t = n = 0; t < r; t++) e[t].type === "text" && t + 1 < r && e[t + 1].type === "text" ? e[t + 1].content = e[t].content + e[t + 1].content : (t !== n && (e[n] = e[t]), n++);
  t !== n && (e.length = n);
}
function fs(e) {
  let t, n, r = e.tokens, o = r.length;
  for (let i = 0; i < o; i++) {
    if (r[i].type !== "inline") continue;
    let s = r[i].children, a = s.length;
    for (t = 0; t < a; t++)
      s[t].type === "text_special" && (s[t].type = "text"), s[t].children && ps(s[t].children);
    for (t = n = 0; t < a; t++) s[t].type === "text" && t + 1 < a && s[t + 1].type === "text" ? s[t + 1].content = s[t].content + s[t + 1].content : (t !== n && (s[n] = s[t]), n++);
    t !== n && (s.length = n);
  }
}
var ht = [
  ["normalize", Vi],
  ["block", Ki],
  ["strip_references", Ji],
  ["inline", Yi],
  ["linkify", Qi],
  ["replacements", ss],
  ["smartquotes", ds],
  ["text_join", fs]
], yr = class {
  constructor() {
    k(
      this,
      /**
      * {@link Ruler} instance. Keep configuration of core rules.
      */
      "ruler",
      new Ie()
    ), k(this, "State", gr);
    for (let e = 0; e < ht.length; e++) this.ruler.push(ht[e][0], ht[e][1]);
  }
  /**
  * Executes core chain rules.
  */
  process(e) {
    let t = this.ruler.getRules("");
    for (let n = 0, r = t.length; n < r; n++) t[n](e);
  }
}, br = class {
  constructor(e, t, n, r) {
    k(this, "bMarks", []), k(this, "eMarks", []), k(this, "tShift", []), k(this, "sCount", []), k(this, "bsCount", []), k(this, "blkIndent", 0), k(this, "line", 0), k(this, "lineMax", 0), k(this, "tight", !1), k(this, "listIndent", -1), k(this, "parentType", "root"), k(this, "level", 0), k(this, "Token", ie), this.src = e, this.md = t, this.env = n, this.tokens = r;
    let o = this.src;
    for (let i = 0, s = 0, a = 0, u = 0, d = o.length, f = !1; s < d; s++) {
      let g = o.charCodeAt(s);
      if (!f)
        if (O(g)) {
          a++, g === 9 ? u += 4 - u % 4 : u++;
          continue;
        } else f = !0;
      (g === 10 || s === d - 1) && (g !== 10 && s++, this.bMarks.push(i), this.eMarks.push(s), this.tShift.push(a), this.sCount.push(u), this.bsCount.push(0), f = !1, a = 0, u = 0, i = s + 1);
    }
    this.bMarks.push(o.length), this.eMarks.push(o.length), this.tShift.push(0), this.sCount.push(0), this.bsCount.push(0), this.lineMax = this.bMarks.length - 1;
  }
  push(e, t, n) {
    let r = new ie(e, t, n);
    return r.block = !0, n < 0 && this.level--, r.level = this.level, n > 0 && this.level++, this.tokens.push(r), r;
  }
  isEmpty(e) {
    return this.bMarks[e] + this.tShift[e] >= this.eMarks[e];
  }
  skipEmptyLines(e) {
    for (let t = this.lineMax; e < t && !(this.bMarks[e] + this.tShift[e] < this.eMarks[e]); e++) ;
    return e;
  }
  skipSpaces(e) {
    for (let t = this.src.length; e < t && O(this.src.charCodeAt(e)); e++) ;
    return e;
  }
  skipSpacesBack(e, t) {
    if (e <= t) return e;
    for (; e > t; ) if (!O(this.src.charCodeAt(--e))) return e + 1;
    return e;
  }
  skipChars(e, t) {
    for (let n = this.src.length; e < n && this.src.charCodeAt(e) === t; e++) ;
    return e;
  }
  skipCharsBack(e, t, n) {
    if (e <= n) return e;
    for (; e > n; ) if (t !== this.src.charCodeAt(--e)) return e + 1;
    return e;
  }
  getLines(e, t, n, r) {
    if (e >= t) return "";
    let o = new Array(t - e);
    for (let i = 0, s = e; s < t; s++, i++) {
      let a = 0, u = this.bMarks[s], d = u, f;
      for (s + 1 < t || r ? f = this.eMarks[s] + 1 : f = this.eMarks[s]; d < f && a < n; ) {
        let g = this.src.charCodeAt(d);
        if (O(g))
          g === 9 ? a += 4 - (a + this.bsCount[s]) % 4 : a++;
        else if (d - u < this.tShift[s]) a++;
        else break;
        d++;
      }
      a > n ? o[i] = new Array(a - n + 1).join(" ") + this.src.slice(d, f) : o[i] = this.src.slice(d, f);
    }
    return o.join("");
  }
}, hs = 65536;
function gt(e, t) {
  let n = e.bMarks[t] + e.tShift[t], r = e.eMarks[t];
  return e.src.slice(n, r);
}
function rr(e) {
  let t = [], n = e.length, r = 0, o = e.charCodeAt(r), i = !1, s = 0, a = "";
  for (; r < n; )
    o === 124 && (i ? (a += e.substring(s, r - 1), s = r) : (t.push(a + e.substring(s, r)), a = "", s = r + 1)), i = o === 92, r++, o = e.charCodeAt(r);
  return t.push(a + e.substring(s)), t;
}
function gs(e, t, n, r) {
  if (t + 2 > n) return !1;
  let o = t + 1;
  if (e.sCount[o] < e.blkIndent || e.sCount[o] - e.blkIndent >= 4) return !1;
  let i = e.bMarks[o] + e.tShift[o];
  if (i >= e.eMarks[o]) return !1;
  let s = e.src.charCodeAt(i++);
  if (s !== 124 && s !== 45 && s !== 58 || i >= e.eMarks[o]) return !1;
  let a = e.src.charCodeAt(i++);
  if (a !== 124 && a !== 45 && a !== 58 && !O(a) || s === 45 && O(a)) return !1;
  for (; i < e.eMarks[o]; ) {
    let R = e.src.charCodeAt(i);
    if (R !== 124 && R !== 45 && R !== 58 && !O(R)) return !1;
    i++;
  }
  let u = gt(e, t + 1), d = u.split("|"), f = [];
  for (let R = 0; R < d.length; R++) {
    let C = d[R].trim();
    if (!C) {
      if (R === 0 || R === d.length - 1) continue;
      return !1;
    }
    if (!/^:?-+:?$/.test(C)) return !1;
    C.charCodeAt(C.length - 1) === 58 ? f.push(C.charCodeAt(0) === 58 ? "center" : "right") : C.charCodeAt(0) === 58 ? f.push("left") : f.push("");
  }
  if (u = gt(e, t).trim(), u.indexOf("|") === -1 || e.sCount[t] - e.blkIndent >= 4) return !1;
  d = rr(u), d.length && d[0] === "" && d.shift(), d.length && d[d.length - 1] === "" && d.pop();
  let g = d.length;
  if (g === 0 || g !== f.length) return !1;
  if (r) return !0;
  let y = e.parentType;
  e.parentType = "table";
  let c = e.md.block.ruler.getRules("blockquote"), l = e.push("table_open", "table", 1), b = [t, 0];
  l.map = b;
  let p = e.push("thead_open", "thead", 1);
  p.map = [t, t + 1];
  let m = e.push("tr_open", "tr", 1);
  m.map = [t, t + 1];
  for (let R = 0; R < d.length; R++) {
    let C = e.push("th_open", "th", 1);
    f[R] && (C.attrs = [["style", `text-align:${f[R]}`]]);
    let x = e.push("inline", "", 0);
    x.content = d[R].trim(), x.children = [], e.push("th_close", "th", -1);
  }
  e.push("tr_close", "tr", -1), e.push("thead_close", "thead", -1);
  let h, w = 0;
  for (o = t + 2; o < n && !(e.sCount[o] < e.blkIndent); o++) {
    let R = !1;
    for (let x = 0, _ = c.length; x < _; x++) if (c[x](e, o, n, !0)) {
      R = !0;
      break;
    }
    if (R || (u = gt(e, o).trim(), !u) || e.sCount[o] - e.blkIndent >= 4 || (d = rr(u), d.length && d[0] === "" && d.shift(), d.length && d[d.length - 1] === "" && d.pop(), w += g - d.length, w > hs)) break;
    if (o === t + 2) {
      let x = e.push("tbody_open", "tbody", 1);
      x.map = h = [t + 2, 0];
    }
    let C = e.push("tr_open", "tr", 1);
    C.map = [o, o + 1];
    for (let x = 0; x < g; x++) {
      let _ = e.push("td_open", "td", 1);
      f[x] && (_.attrs = [["style", `text-align:${f[x]}`]]);
      let A = e.push("inline", "", 0);
      A.content = d[x] ? d[x].trim() : "", A.children = [], e.push("td_close", "td", -1);
    }
    e.push("tr_close", "tr", -1);
  }
  return h && (e.push("tbody_close", "tbody", -1), h[1] = o), e.push("table_close", "table", -1), b[1] = o, e.parentType = y, e.line = o, !0;
}
function ms(e, t, n) {
  if (e.sCount[t] - e.blkIndent < 4) return !1;
  let r = t + 1, o = r;
  for (; r < n; ) {
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
  return i.content = e.getLines(t, o, 4 + e.blkIndent, !1) + `
`, i.map = [t, e.line], !0;
}
function ys(e, t, n, r) {
  let o = e.bMarks[t] + e.tShift[t], i = e.eMarks[t];
  if (e.sCount[t] - e.blkIndent >= 4 || o + 3 > i) return !1;
  let s = e.src.charCodeAt(o);
  if (s !== 126 && s !== 96) return !1;
  let a = o;
  o = e.skipChars(o, s);
  let u = o - a;
  if (u < 3) return !1;
  let d = e.src.slice(a, o), f = e.src.slice(o, i);
  if (s === 96 && f.indexOf(String.fromCharCode(s)) >= 0)
    return !1;
  if (r) return !0;
  let g = t, y = !1;
  for (; g++, !(g >= n || (o = a = e.bMarks[g] + e.tShift[g], i = e.eMarks[g], o < i && e.sCount[g] < e.blkIndent)); )
    if (e.src.charCodeAt(o) === s && !(e.sCount[g] - e.blkIndent >= 4) && (o = e.skipChars(o, s), !(o - a < u) && (o = e.skipSpaces(o), !(o < i)))) {
      y = !0;
      break;
    }
  u = e.sCount[t], e.line = g + (y ? 1 : 0);
  let c = e.push("fence", "code", 0);
  return c.info = f, c.content = e.getLines(t + 1, g, u, !0), c.markup = d, c.map = [t, e.line], !0;
}
function bs(e, t, n, r) {
  let o = e.bMarks[t] + e.tShift[t], i = e.eMarks[t], s = e.lineMax;
  if (e.sCount[t] - e.blkIndent >= 4 || e.src.charCodeAt(o) !== 62) return !1;
  if (r) return !0;
  let a = [], u = [], d = [], f = [], g = e.md.block.ruler.getRules("blockquote"), y = e.parentType;
  e.parentType = "blockquote";
  let c = !1, l;
  for (l = t; l < n; l++) {
    let w = e.sCount[l] < e.blkIndent;
    if (o = e.bMarks[l] + e.tShift[l], i = e.eMarks[l], o >= i) break;
    if (e.src.charCodeAt(o++) === 62 && !w) {
      let C = e.sCount[l] + 1, x, _;
      e.src.charCodeAt(o) === 32 ? (o++, C++, _ = !1, x = !0) : e.src.charCodeAt(o) === 9 ? (x = !0, (e.bsCount[l] + C) % 4 === 3 ? (o++, C++, _ = !1) : _ = !0) : x = !1;
      let A = C;
      for (a.push(e.bMarks[l]), e.bMarks[l] = o; o < i; ) {
        let T = e.src.charCodeAt(o);
        if (O(T))
          T === 9 ? A += 4 - (A + e.bsCount[l] + (_ ? 1 : 0)) % 4 : A++;
        else break;
        o++;
      }
      c = o >= i, u.push(e.bsCount[l]), e.bsCount[l] = e.sCount[l] + 1 + (x ? 1 : 0), d.push(e.sCount[l]), e.sCount[l] = A - C, f.push(e.tShift[l]), e.tShift[l] = o - e.bMarks[l];
      continue;
    }
    if (c) break;
    let R = !1;
    for (let C = 0, x = g.length; C < x; C++) if (g[C](e, l, n, !0)) {
      R = !0;
      break;
    }
    if (R) {
      e.lineMax = l, e.blkIndent !== 0 && (a.push(e.bMarks[l]), u.push(e.bsCount[l]), f.push(e.tShift[l]), d.push(e.sCount[l]), e.sCount[l] -= e.blkIndent);
      break;
    }
    a.push(e.bMarks[l]), u.push(e.bsCount[l]), f.push(e.tShift[l]), d.push(e.sCount[l]), e.sCount[l] = -1;
  }
  let b = e.blkIndent;
  e.blkIndent = 0;
  let p = e.push("blockquote_open", "blockquote", 1);
  p.markup = ">";
  let m = [t, 0];
  p.map = m, e.md.block.tokenize(e, t, l);
  let h = e.push("blockquote_close", "blockquote", -1);
  h.markup = ">", e.lineMax = s, e.parentType = y, m[1] = e.line;
  for (let w = 0; w < f.length; w++)
    e.bMarks[w + t] = a[w], e.tShift[w + t] = f[w], e.sCount[w + t] = d[w], e.bsCount[w + t] = u[w];
  return e.blkIndent = b, !0;
}
function ws(e, t, n, r) {
  let o = e.eMarks[t];
  if (e.sCount[t] - e.blkIndent >= 4) return !1;
  let i = e.bMarks[t] + e.tShift[t], s = e.src.charCodeAt(i++);
  if (s !== 42 && s !== 45 && s !== 95) return !1;
  let a = 1;
  for (; i < o; ) {
    let d = e.src.charCodeAt(i++);
    if (d !== s && !O(d)) return !1;
    d === s && a++;
  }
  if (a < 3) return !1;
  if (r) return !0;
  e.line = t + 1;
  let u = e.push("hr", "hr", 0);
  return u.map = [t, e.line], u.markup = Array(a + 1).join(String.fromCharCode(s)), !0;
}
function or(e, t) {
  let n = e.eMarks[t], r = e.bMarks[t] + e.tShift[t], o = e.src.charCodeAt(r++);
  return o !== 42 && o !== 45 && o !== 43 || r < n && !O(e.src.charCodeAt(r)) ? -1 : r;
}
function ir(e, t) {
  let n = e.bMarks[t] + e.tShift[t], r = e.eMarks[t], o = n;
  if (o + 1 >= r) return -1;
  let i = e.src.charCodeAt(o++);
  if (i < 48 || i > 57) return -1;
  for (; ; ) {
    if (o >= r) return -1;
    if (i = e.src.charCodeAt(o++), i >= 48 && i <= 57) {
      if (o - n >= 10) return -1;
      continue;
    }
    if (i === 41 || i === 46) break;
    return -1;
  }
  return o < r && (i = e.src.charCodeAt(o), !O(i)) ? -1 : o;
}
function Rs(e, t) {
  let n = e.level + 2;
  for (let r = t + 2, o = e.tokens.length - 2; r < o; r++) e.tokens[r].level === n && e.tokens[r].type === "paragraph_open" && (e.tokens[r + 2].hidden = !0, e.tokens[r].hidden = !0, r += 2);
}
function xs(e, t, n, r) {
  let o, i, s, a, u = t, d = !0;
  if (e.sCount[u] - e.blkIndent >= 4 || e.listIndent >= 0 && e.sCount[u] - e.listIndent >= 4 && e.sCount[u] < e.blkIndent) return !1;
  let f = !1;
  r && e.parentType === "paragraph" && e.sCount[u] >= e.blkIndent && (f = !0);
  let g, y, c;
  if ((c = ir(e, u)) >= 0) {
    if (g = !0, s = e.bMarks[u] + e.tShift[u], y = Number(e.src.slice(s, c - 1)), f && y !== 1) return !1;
  } else if ((c = or(e, u)) >= 0) g = !1;
  else return !1;
  if (f && e.skipSpaces(c) >= e.eMarks[u])
    return !1;
  if (r) return !0;
  let l = e.src.charCodeAt(c - 1), b = e.tokens.length;
  g ? (a = e.push("ordered_list_open", "ol", 1), y !== 1 && (a.attrs = [["start", y]])) : a = e.push("bullet_list_open", "ul", 1);
  let p = [u, 0];
  a.map = p, a.markup = String.fromCharCode(l);
  let m = !1, h = e.md.block.ruler.getRules("list"), w = e.parentType;
  for (e.parentType = "list"; u < n; ) {
    i = c, o = e.eMarks[u];
    let R = e.sCount[u] + c - (e.bMarks[u] + e.tShift[u]), C = R;
    for (; i < o; ) {
      let z = e.src.charCodeAt(i);
      if (z === 9) C += 4 - (C + e.bsCount[u]) % 4;
      else if (z === 32) C++;
      else break;
      i++;
    }
    let x = i, _;
    x >= o ? _ = 1 : _ = C - R, _ > 4 && (_ = 1);
    let A = R + _;
    a = e.push("list_item_open", "li", 1), a.markup = String.fromCharCode(l);
    let T = [u, 0];
    a.map = T, g && (a.info = e.src.slice(s, c - 1));
    let v = e.tight, I = e.tShift[u], P = e.sCount[u], B = e.listIndent;
    if (e.listIndent = e.blkIndent, e.blkIndent = A, e.tight = !0, e.tShift[u] = x - e.bMarks[u], e.sCount[u] = C, x >= o && e.isEmpty(u + 1) ? e.line = Math.min(e.line + 2, n) : e.md.block.tokenize(e, u, n), (!e.tight || m) && (d = !1), m = e.line - u > 1 && e.isEmpty(e.line - 1), e.blkIndent = e.listIndent, e.listIndent = B, e.tShift[u] = I, e.sCount[u] = P, e.tight = v, a = e.push("list_item_close", "li", -1), a.markup = String.fromCharCode(l), u = e.line, T[1] = u, u >= n || e.sCount[u] < e.blkIndent || e.sCount[u] - e.blkIndent >= 4) break;
    let N = !1;
    for (let z = 0, oo = h.length; z < oo; z++) if (h[z](e, u, n, !0)) {
      N = !0;
      break;
    }
    if (N) break;
    if (g) {
      if (c = ir(e, u), c < 0) break;
      s = e.bMarks[u] + e.tShift[u];
    } else if (c = or(e, u), c < 0) break;
    if (l !== e.src.charCodeAt(c - 1)) break;
  }
  return g ? a = e.push("ordered_list_close", "ol", -1) : a = e.push("bullet_list_close", "ul", -1), a.markup = String.fromCharCode(l), p[1] = u, e.line = u, e.parentType = w, d && Rs(e, b), !0;
}
var mt = 999;
function Cs(e) {
  let t = e.length;
  for (let n = 0; n < e.length - 1; n++) {
    let r = e.charCodeAt(n);
    if (r < 55296 || r > 56319) continue;
    let o = e.charCodeAt(n + 1);
    o >= 56320 && o <= 57343 && (t--, n++);
  }
  return t;
}
function xe(e, t) {
  return Math.min(e.eMarks[t] + 1, e.src.length);
}
function Be(e, t) {
  let n = e.lineMax;
  if (t >= n || e.isEmpty(t)) return -1;
  let r = !1;
  if (e.sCount[t] - e.blkIndent > 3 && (r = !0), e.sCount[t] < 0 && (r = !0), !r) {
    let o = e.md.block.ruler.getRules("reference"), i = e.parentType;
    e.parentType = "reference";
    let s = !1;
    for (let a = 0, u = o.length; a < u; a++) if (o[a](e, t, n, !0)) {
      s = !0;
      break;
    }
    if (e.parentType = i, s) return -1;
  }
  return e.bMarks[t] + e.tShift[t];
}
function ks(e, t, n, r) {
  let o = e.src, i = e.bMarks[t] + e.tShift[t], s = t + 1;
  if (e.sCount[t] - e.blkIndent >= 4 || o.charCodeAt(i) !== 91) return !1;
  let a = xe(e, t), u = "", d = -1, f = ++i;
  for (; i < a; ) {
    if (u.length + i - f > mt * 2) return !1;
    let x = o.charCodeAt(i);
    if (x === 91) return !1;
    if (x === 93) {
      d = i;
      break;
    }
    if (x === 92 && (x = o.charCodeAt(++i)), x === 10 && i < a) {
      let _ = Be(e, s);
      if (_ < 0) return !1;
      u += o.slice(f, a), i = f = _, a = xe(e, s++);
      continue;
    }
    i++;
  }
  if (d < 0 || o.charCodeAt(d + 1) !== 58 || (u += o.slice(f, d), u.length > mt && Cs(u) > mt)) return !1;
  for (i = d + 2; i < a; ) {
    let x = o.charCodeAt(i);
    if (x === 10) {
      let _ = Be(e, s);
      if (_ < 0) break;
      i = _, a = xe(e, s++);
    } else if (O(x)) i++;
    else break;
  }
  let g = e.md.helpers.parseLinkDestination(o, i, a);
  if (!g.ok) return !1;
  let y = e.md.normalizeLink(g.str);
  if (!e.md.validateLink(y)) return !1;
  i = g.pos;
  let c = i, l = a, b = s;
  for (; i < a; ) {
    let x = o.charCodeAt(i);
    if (x === 10) {
      let _ = Be(e, s);
      if (_ < 0) break;
      i = _, a = xe(e, s++);
    } else if (O(x)) i++;
    else break;
  }
  let p = i, m = e.md.helpers.parseLinkTitle(o, i, a);
  for (; m.can_continue; ) {
    let x = Be(e, s);
    if (x < 0) break;
    i = x, a = xe(e, s++), m = e.md.helpers.parseLinkTitle(o, i, a, m);
  }
  let h;
  for (p !== c && m.ok ? (h = m.str, i = m.pos) : (h = "", i = c, a = l, s = b); i < a && O(o.charCodeAt(i)); )
    i++;
  if (i < a && o.charCodeAt(i) !== 10 && h)
    for (h = "", i = c, a = l, s = b; i < a && O(o.charCodeAt(i)); )
      i++;
  if (i < a && o.charCodeAt(i) !== 10) return !1;
  let w = Ge(u);
  if (!w) return !1;
  if (r) return !0;
  typeof e.env.references > "u" && (e.env.references = {}), typeof e.env.references[w] > "u" && (e.env.references[w] = {
    title: h,
    href: y
  });
  let R = e.push("reference_definition", "", 0);
  R.map = [t, s], R.hidden = !0;
  let C = /* @__PURE__ */ Object.create(null);
  return C.label = w, R.meta = C, e.line = s, !0;
}
var _s = [
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
], wr = `<[A-Za-z][A-Za-z0-9\\-]*(?:\\s+[a-zA-Z_:][a-zA-Z0-9:._-]*(?:\\s*=\\s*(?:[^"'=<>\`\\x00-\\x20]+|'[^']*'|"[^"]*"))?)*\\s*\\/?>`, Rr = "<\\/[A-Za-z][A-Za-z0-9\\-]*\\s*>";
new RegExp(`^(?:${wr}|${Rr}|<!---?>|<!--(?:[^-]|-[^-]|--[^>])*-->|<[?][\\s\\S]*?[?]>|<![A-Za-z][^>]*>|<!\\[CDATA\\[[\\s\\S]*?\\]\\]>)`);
var xr = new RegExp(`^(?:${wr}|${Rr})`), oe = [
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
    new RegExp(`^</?(${_s.join("|")})(?=(\\s|/?>|$))`, "i"),
    /^$/,
    !0
  ],
  [
    new RegExp(`${xr.source}\\s*$`),
    /^$/,
    !1
  ]
];
function Ts(e, t, n, r) {
  let o = e.bMarks[t] + e.tShift[t], i = e.eMarks[t];
  if (e.sCount[t] - e.blkIndent >= 4 || !e.md.options.html || e.src.charCodeAt(o) !== 60) return !1;
  let s = e.src.slice(o, i), a = 0;
  for (; a < oe.length && !oe[a][0].test(s); a++) ;
  if (a === oe.length) return !1;
  if (r) return oe[a][2];
  let u = t + 1, d = oe[a][1].test("");
  if (!oe[a][1].test(s)) {
    for (; u < n && !(e.sCount[u] < e.blkIndent && (d || !e.isEmpty(u))); u++)
      if (o = e.bMarks[u] + e.tShift[u], i = e.eMarks[u], s = e.src.slice(o, i), oe[a][1].test(s)) {
        s.length !== 0 && u++;
        break;
      }
  }
  e.line = u;
  let f = e.push("html_block", "", 0);
  return f.map = [t, u], f.content = e.getLines(t, u, e.blkIndent, !0), !0;
}
function Es(e, t, n, r) {
  let o = e.bMarks[t] + e.tShift[t], i = e.eMarks[t];
  if (e.sCount[t] - e.blkIndent >= 4) return !1;
  let s = e.src.charCodeAt(o);
  if (s !== 35 || o >= i) return !1;
  let a = 1;
  for (s = e.src.charCodeAt(++o); s === 35 && o < i && a <= 6; )
    a++, s = e.src.charCodeAt(++o);
  if (a > 6 || o < i && !O(s)) return !1;
  if (r) return !0;
  i = e.skipSpacesBack(i, o);
  let u = e.skipCharsBack(i, 35, o);
  u > o && O(e.src.charCodeAt(u - 1)) && (i = u), e.line = t + 1;
  let d = e.push("heading_open", `h${a}`, 1);
  d.markup = "########".slice(0, a), d.map = [t, e.line];
  let f = e.push("inline", "", 0);
  f.content = He(e.src.slice(o, i)), f.map = [t, e.line], f.children = [];
  let g = e.push("heading_close", `h${a}`, -1);
  return g.markup = "########".slice(0, a), !0;
}
function Is(e, t, n) {
  let r = e.md.block.ruler.getRules("paragraph");
  if (e.sCount[t] - e.blkIndent >= 4) return !1;
  let o = e.parentType;
  e.parentType = "paragraph";
  let i = 0, s, a = t + 1;
  for (; a < n && !e.isEmpty(a); a++) {
    if (e.sCount[a] - e.blkIndent > 3) continue;
    if (e.sCount[a] >= e.blkIndent) {
      let c = e.bMarks[a] + e.tShift[a], l = e.eMarks[a];
      if (c < l && (s = e.src.charCodeAt(c), (s === 45 || s === 61) && (c = e.skipChars(c, s), c = e.skipSpaces(c), c >= l))) {
        i = s === 61 ? 1 : 2;
        break;
      }
    }
    if (e.sCount[a] < 0) continue;
    let y = !1;
    for (let c = 0, l = r.length; c < l; c++) if (r[c](e, a, n, !0)) {
      y = !0;
      break;
    }
    if (y) break;
  }
  if (!i)
    return e.parentType = o, !1;
  let u = He(e.getLines(t, a, e.blkIndent, !1));
  e.line = a + 1;
  let d = e.push("heading_open", `h${i}`, 1);
  d.markup = String.fromCharCode(s), d.map = [t, e.line];
  let f = e.push("inline", "", 0);
  f.content = u, f.map = [t, e.line - 1], f.children = [];
  let g = e.push("heading_close", `h${i}`, -1);
  return g.markup = String.fromCharCode(s), e.parentType = o, !0;
}
function Ss(e, t, n) {
  let r = e.md.block.ruler.getRules("paragraph"), o = e.parentType, i = t + 1;
  for (e.parentType = "paragraph"; i < n && !e.isEmpty(i); i++) {
    if (e.sCount[i] - e.blkIndent > 3 || e.sCount[i] < 0) continue;
    let d = !1;
    for (let f = 0, g = r.length; f < g; f++) if (r[f](e, i, n, !0)) {
      d = !0;
      break;
    }
    if (d) break;
  }
  let s = He(e.getLines(t, i, e.blkIndent, !1));
  e.line = i;
  let a = e.push("paragraph_open", "p", 1);
  a.map = [t, e.line];
  let u = e.push("inline", "", 0);
  return u.content = s, u.map = [t, e.line], u.children = [], e.push("paragraph_close", "p", -1), e.parentType = o, !0;
}
var je = [
  [
    "table",
    gs,
    ["paragraph", "reference"]
  ],
  ["code", ms],
  [
    "fence",
    ys,
    [
      "paragraph",
      "reference",
      "blockquote",
      "list"
    ]
  ],
  [
    "blockquote",
    bs,
    [
      "paragraph",
      "reference",
      "blockquote",
      "list"
    ]
  ],
  [
    "hr",
    ws,
    [
      "paragraph",
      "reference",
      "blockquote",
      "list"
    ]
  ],
  [
    "list",
    xs,
    [
      "paragraph",
      "reference",
      "blockquote"
    ]
  ],
  ["reference", ks],
  [
    "html_block",
    Ts,
    [
      "paragraph",
      "reference",
      "blockquote"
    ]
  ],
  [
    "heading",
    Es,
    [
      "paragraph",
      "reference",
      "blockquote"
    ]
  ],
  ["lheading", Is],
  ["paragraph", Ss]
], Cr = class {
  constructor() {
    k(
      this,
      /**
      * {@link Ruler} instance. Keep configuration of block rules.
      */
      "ruler",
      new Ie()
    ), k(this, "State", br);
    for (let e = 0; e < je.length; e++) this.ruler.push(je[e][0], je[e][1], { alt: (je[e][2] || []).slice() });
  }
  tokenize(e, t, n) {
    let r = this.ruler.getRules(""), o = r.length, i = e.md.options.maxNesting, s = t, a = !1;
    for (; s < n && (e.line = s = e.skipEmptyLines(s), !(s >= n || e.sCount[s] < e.blkIndent)); ) {
      if (e.level >= i) {
        e.line = n;
        break;
      }
      let u = e.line, d = !1;
      for (let f = 0; f < o; f++)
        if (d = r[f](e, s, n, !1), d) {
          if (u >= e.line) throw new Error("block rule didn't increment state.line");
          break;
        }
      if (!d) throw new Error("none of the block rules matched");
      e.tight = !a, e.isEmpty(e.line - 1) && (a = !0), s = e.line, s < n && e.isEmpty(s) && (a = !0, s++, e.line = s);
    }
  }
  /**
  * Process input string and push block tokens into `outTokens`
  */
  parse(e, t, n, r) {
    if (!e) return;
    let o = new this.State(e, t, n, r);
    this.tokenize(o, o.line, o.lineMax);
  }
}, kr = class {
  constructor(e, t, n, r) {
    k(this, "pos", 0), k(this, "level", 0), k(this, "pending", ""), k(this, "pendingLevel", 0), k(this, "cache", {}), k(this, "backticks", {}), k(this, "backticksScanned", !1), k(this, "skipHtmlSpecial", !1), k(this, "linkLevel", 0), k(this, "delimiters", []), k(this, "_prev_delimiters", []), k(this, "Token", ie), this.src = e, this.env = n, this.md = t, this.tokens = r, this.tokens_meta = Array(r.length), this.posMax = this.src.length;
  }
  pushPending() {
    let e = new ie("text", "", 0);
    return e.content = this.pending, e.level = this.pendingLevel, this.tokens.push(e), this.pending = "", e;
  }
  push(e, t, n) {
    this.pending && this.pushPending();
    let r = new ie(e, t, n), o;
    return n < 0 && (this.level--, this.delimiters = this._prev_delimiters.pop()), r.level = this.level, n > 0 && (this.level++, this._prev_delimiters.push(this.delimiters), this.delimiters = [], o = { delimiters: this.delimiters }), this.pendingLevel = this.level, this.tokens.push(r), this.tokens_meta.push(o), r;
  }
  scanDelims(e, t) {
    let n = this.posMax, r = this.src.charCodeAt(e), o;
    if (e === 0) o = 32;
    else if (e === 1)
      o = this.src.charCodeAt(0), (o & 63488) === 55296 && (o = 65533);
    else if (o = this.src.charCodeAt(e - 1), (o & 64512) === 56320) {
      let l = this.src.charCodeAt(e - 2);
      o = (l & 64512) === 55296 ? 65536 + (l - 55296 << 10) + (o - 56320) : 65533;
    } else (o & 64512) === 55296 && (o = 65533);
    let i = e;
    for (; i < n && this.src.charCodeAt(i) === r; ) i++;
    let s = i - e, a = i < n ? this.src.charCodeAt(i) : 32;
    if ((a & 64512) === 55296) {
      let l = this.src.charCodeAt(i + 1);
      a = (l & 64512) === 56320 ? 65536 + (a - 55296 << 10) + (l - 56320) : 65533;
    } else (a & 64512) === 56320 && (a = 65533);
    let u = Te(o) || _e(o), d = Te(a) || _e(a), f = ke(o), g = ke(a), y = !g && (!d || f || u), c = !f && (!u || g || d);
    return {
      can_open: y && (t || !c || u),
      can_close: c && (t || !y || d),
      length: s
    };
  }
};
function As(e) {
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
function vs(e, t) {
  let n = e.pos;
  for (; n < e.posMax && !As(e.src.charCodeAt(n)); ) n++;
  return n === e.pos ? !1 : (t || (e.pending += e.src.slice(e.pos, n)), e.pos = n, !0);
}
function Ms(e) {
  return e >= 65 && e <= 90 || e >= 97 && e <= 122;
}
function Ds(e) {
  return e >= 65 && e <= 90 || e >= 97 && e <= 122 || e >= 48 && e <= 57 || e === 43 || e === 45 || e === 46;
}
function Ps(e, t) {
  if (!e.md.options.linkify || e.linkLevel > 0) return !1;
  let n = e.pos, r = e.posMax;
  if (n + 3 > r || e.src.charCodeAt(n) !== 58 || e.src.charCodeAt(n + 1) !== 47 || e.src.charCodeAt(n + 2) !== 47) return !1;
  let o = n - Math.min(10, e.pending.length, n), i = n;
  for (; i > o && Ds(e.src.charCodeAt(i - 1)); ) i--;
  if (i === n || !Ms(e.src.charCodeAt(i))) return !1;
  let s = n - i, a = e.md.linkify.matchAtStart(e.src.slice(i));
  if (!a) return !1;
  let u = a.url;
  if (u.length <= s) return !1;
  let d = u.length;
  for (; d > 0 && u.charCodeAt(d - 1) === 42; ) d--;
  d !== u.length && (u = u.slice(0, d));
  let f = e.md.normalizeLink(u);
  if (!e.md.validateLink(f)) return !1;
  if (!t) {
    e.pending = e.pending.slice(0, -s);
    let g = e.push("link_open", "a", 1);
    g.attrs = [["href", f]], g.markup = "linkify", g.info = "auto";
    let y = e.push("text", "", 0);
    y.content = e.md.normalizeLinkText(u);
    let c = e.push("link_close", "a", -1);
    c.markup = "linkify", c.info = "auto";
  }
  return e.pos += u.length - s, !0;
}
function Os(e, t) {
  let n = e.pos;
  if (e.src.charCodeAt(n) !== 10) return !1;
  let r = e.pending.length - 1, o = e.posMax;
  if (!t)
    if (r >= 0 && e.pending.charCodeAt(r) === 32)
      if (r >= 1 && e.pending.charCodeAt(r - 1) === 32) {
        let i = r - 1;
        for (; i >= 1 && e.pending.charCodeAt(i - 1) === 32; ) i--;
        e.pending = e.pending.slice(0, i), e.push("hardbreak", "br", 0);
      } else
        e.pending = e.pending.slice(0, -1), e.push("softbreak", "br", 0);
    else e.push("softbreak", "br", 0);
  for (n++; n < o && O(e.src.charCodeAt(n)); ) n++;
  return e.pos = n, !0;
}
var xt = [];
for (let e = 0; e < 256; e++) xt.push(0);
"\\!\"#$%&'()*+,./:;<=>?@[]^_`{|}~-".split("").forEach(function(e) {
  xt[e.charCodeAt(0)] = 1;
});
function Ns(e, t) {
  let n = e.pos, r = e.posMax;
  if (e.src.charCodeAt(n) !== 92 || (n++, n >= r)) return !1;
  let o = e.src.charCodeAt(n);
  if (o === 10) {
    for (t || e.push("hardbreak", "br", 0), n++; n < r && (o = e.src.charCodeAt(n), !!O(o)); )
      n++;
    return e.pos = n, !0;
  }
  if (o === 32) {
    if (!t) {
      let a = e.push("text_special", "", 0);
      a.content = "\\", a.markup = "\\", a.info = "escape";
    }
    return e.pos = n, !0;
  }
  let i = e.src[n];
  if (o >= 55296 && o <= 56319 && n + 1 < r) {
    let a = e.src.charCodeAt(n + 1);
    a >= 56320 && a <= 57343 && (i += e.src[n + 1], n++);
  }
  let s = "\\" + i;
  if (!t) {
    let a = e.push("text_special", "", 0);
    o < 256 && xt[o] !== 0 ? a.content = i : a.content = s, a.markup = s, a.info = "escape";
  }
  return e.pos = n + 1, !0;
}
function Fs(e) {
  let t = {}, n = 0;
  for (; (n = e.indexOf("`", n)) !== -1; ) {
    let r = n;
    for (; e.charCodeAt(++n) === 96; ) ;
    t[n - r] = r;
  }
  return t;
}
function Ls(e, t) {
  var n;
  let r = e.pos;
  if (e.src.charCodeAt(r) !== 96) return !1;
  let o = e.posMax, i = r + 1;
  for (; i < o && e.src.charCodeAt(i) === 96; ) i++;
  let s = e.src.slice(r, i), a = s.length;
  if (e.backticksScanned || (e.backticks = Fs(e.src), e.backticksScanned = !0), ((n = e.backticks[a]) !== null && n !== void 0 ? n : -1) >= i) {
    let u = i, d;
    for (; (d = e.src.indexOf("`", u)) !== -1 && d < o; ) {
      for (u = d + 1; e.src.charCodeAt(u) === 96; ) u++;
      if (u > o) break;
      if (u - d === a) {
        if (!t) {
          let f = e.push("code_inline", "code", 0);
          f.markup = s;
          let g = e.src.slice(i, d).replace(/\n/g, " ");
          g.startsWith(" ") && g.endsWith(" ") && /[^ ]/.test(g) && (g = g.slice(1, -1)), f.content = g;
        }
        return e.pos = u, !0;
      }
    }
  }
  return t || (e.pending += s), e.pos = i, !0;
}
function Us(e, t) {
  let n = e.pos, r = e.src.charCodeAt(n);
  if (t || r !== 126) return !1;
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
function sr(e, t) {
  let n, r = [], o = t.length;
  for (let i = 0; i < o; i++) {
    let s = t[i];
    if (s.marker !== 126 || s.end === -1) continue;
    let a = t[s.end];
    n = e.tokens[s.token], n.type = "s_open", n.tag = "s", n.nesting = 1, n.markup = "~~", n.content = "", n = e.tokens[a.token], n.type = "s_close", n.tag = "s", n.nesting = -1, n.markup = "~~", n.content = "", e.tokens[a.token - 1].type === "text" && e.tokens[a.token - 1].content === "~" && r.push(a.token - 1);
  }
  for (; r.length; ) {
    let i = r.pop(), s = i + 1;
    for (; s < e.tokens.length && e.tokens[s].type === "s_close"; ) s++;
    s--, i !== s && (n = e.tokens[s], e.tokens[s] = e.tokens[i], e.tokens[i] = n);
  }
}
function Bs(e) {
  let t = e.tokens_meta, n = e.tokens_meta.length;
  sr(e, e.delimiters);
  for (let o = 0; o < n; o++) {
    var r;
    let i = (r = t[o]) === null || r === void 0 ? void 0 : r.delimiters;
    i && sr(e, i);
  }
}
var _r = {
  tokenize: Us,
  postProcess: Bs
};
function js(e, t) {
  let n = e.pos, r = e.src.charCodeAt(n);
  if (t || r !== 95 && r !== 42) return !1;
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
function ar(e, t) {
  let n = t.length;
  for (let r = n - 1; r >= 0; r--) {
    let o = t[r];
    if (o.marker !== 95 && o.marker !== 42 || o.end === -1) continue;
    let i = t[o.end], s = r > 0 && t[r - 1].end === o.end + 1 && t[r - 1].marker === o.marker && t[r - 1].token === o.token - 1 && t[o.end + 1].token === i.token + 1, a = String.fromCharCode(o.marker), u = e.tokens[o.token];
    u.type = s ? "strong_open" : "em_open", u.tag = s ? "strong" : "em", u.nesting = 1, u.markup = s ? a + a : a, u.content = "";
    let d = e.tokens[i.token];
    d.type = s ? "strong_close" : "em_close", d.tag = s ? "strong" : "em", d.nesting = -1, d.markup = s ? a + a : a, d.content = "", s && (e.tokens[t[r - 1].token].content = "", e.tokens[t[o.end + 1].token].content = "", r--);
  }
}
function Gs(e) {
  let t = e.tokens_meta, n = e.tokens_meta.length;
  ar(e, e.delimiters);
  for (let o = 0; o < n; o++) {
    var r;
    let i = (r = t[o]) === null || r === void 0 ? void 0 : r.delimiters;
    i && ar(e, i);
  }
}
var Tr = {
  tokenize: js,
  postProcess: Gs
};
function Hs(e, t) {
  let n, r, o, i, s = "", a = "", u = e.pos, d = !0;
  if (e.src.charCodeAt(e.pos) !== 91) return !1;
  let f = e.pos, g = e.posMax, y = e.pos + 1, c = e.md.helpers.parseLinkLabel(e, e.pos, !0);
  if (c < 0) return !1;
  let l = c + 1;
  if (l < g && e.src.charCodeAt(l) === 40) {
    for (d = !1, l++; l < g && (n = e.src.charCodeAt(l), !(!O(n) && n !== 10)); l++)
      ;
    if (l >= g) return !1;
    if (u = l, o = e.md.helpers.parseLinkDestination(e.src, l, e.posMax), o.ok) {
      for (s = e.md.normalizeLink(o.str), e.md.validateLink(s) ? l = o.pos : s = "", u = l; l < g && (n = e.src.charCodeAt(l), !(!O(n) && n !== 10)); l++)
        ;
      if (o = e.md.helpers.parseLinkTitle(e.src, l, e.posMax), l < g && u !== l && o.ok)
        for (a = o.str, l = o.pos; l < g && (n = e.src.charCodeAt(l), !(!O(n) && n !== 10)); l++)
          ;
    }
    (l >= g || e.src.charCodeAt(l) !== 41) && (d = !0), l++;
  }
  if (d) {
    if (typeof e.env.references > "u") return !1;
    if (l < g && e.src.charCodeAt(l) === 91 ? (u = l + 1, l = e.md.helpers.parseLinkLabel(e, l), l >= 0 ? r = e.src.slice(u, l++) : l = c + 1) : l = c + 1, r || (r = e.src.slice(y, c)), r = Ge(r), i = e.env.references[r], !i)
      return e.pos = f, !1;
    s = i.href, a = i.title;
  }
  if (!t) {
    e.pos = y, e.posMax = c;
    let b = e.push("link_open", "a", 1), p = [["href", s]];
    if (b.attrs = p, a && p.push(["title", a]), r) {
      let m = /* @__PURE__ */ Object.create(null);
      m.label = r, b.meta = m;
    }
    e.linkLevel++, e.md.inline.tokenize(e), e.linkLevel--, e.push("link_close", "a", -1);
  }
  return e.pos = l, e.posMax = g, !0;
}
function qs(e, t) {
  let n, r, o, i, s, a, u, d, f = "", g = e.pos, y = e.posMax;
  if (e.src.charCodeAt(e.pos) !== 33 || e.src.charCodeAt(e.pos + 1) !== 91) return !1;
  let c = e.pos + 2, l = e.md.helpers.parseLinkLabel(e, e.pos + 1, !1);
  if (l < 0) return !1;
  if (i = l + 1, i < y && e.src.charCodeAt(i) === 40) {
    for (i++; i < y && (n = e.src.charCodeAt(i), !(!O(n) && n !== 10)); i++)
      ;
    if (i >= y) return !1;
    for (d = i, a = e.md.helpers.parseLinkDestination(e.src, i, e.posMax), a.ok && (f = e.md.normalizeLink(a.str), e.md.validateLink(f) ? i = a.pos : f = ""), d = i; i < y && (n = e.src.charCodeAt(i), !(!O(n) && n !== 10)); i++)
      ;
    if (a = e.md.helpers.parseLinkTitle(e.src, i, e.posMax), i < y && d !== i && a.ok)
      for (u = a.str, i = a.pos; i < y && (n = e.src.charCodeAt(i), !(!O(n) && n !== 10)); i++)
        ;
    else u = "";
    if (i >= y || e.src.charCodeAt(i) !== 41)
      return e.pos = g, !1;
    i++;
  } else {
    if (typeof e.env.references > "u") return !1;
    if (i < y && e.src.charCodeAt(i) === 91 ? (d = i + 1, i = e.md.helpers.parseLinkLabel(e, i), i >= 0 ? o = e.src.slice(d, i++) : i = l + 1) : i = l + 1, o || (o = e.src.slice(c, l)), o = Ge(o), s = e.env.references[o], !s)
      return e.pos = g, !1;
    f = s.href, u = s.title;
  }
  if (!t) {
    r = e.src.slice(c, l);
    let b = [];
    e.md.inline.parse(r, e.md, e.env, b);
    let p = e.push("image", "img", 0), m = [["src", f], ["alt", ""]];
    if (p.attrs = m, p.children = b, p.content = r, u && m.push(["title", u]), o) {
      let h = /* @__PURE__ */ Object.create(null);
      h.label = o, p.meta = h;
    }
  }
  return e.pos = i, e.posMax = y, !0;
}
var zs = /^([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)$/, Ws = /^([a-zA-Z][a-zA-Z0-9+.-]{1,31}):([^<>\x00-\x20]*)$/;
function $s(e, t) {
  let n = e.pos;
  if (e.src.charCodeAt(n) !== 60) return !1;
  let r = e.pos, o = e.posMax;
  for (; ; ) {
    if (++n >= o) return !1;
    let s = e.src.charCodeAt(n);
    if (s === 60) return !1;
    if (s === 62) break;
  }
  let i = e.src.slice(r + 1, n);
  if (Ws.test(i)) {
    let s = e.md.normalizeLink(i);
    if (!e.md.validateLink(s)) return !1;
    if (!t) {
      let a = e.push("link_open", "a", 1);
      a.attrs = [["href", s]], a.markup = "autolink", a.info = "auto";
      let u = e.push("text", "", 0);
      u.content = e.md.normalizeLinkText(i);
      let d = e.push("link_close", "a", -1);
      d.markup = "autolink", d.info = "auto";
    }
    return e.pos += i.length + 2, !0;
  }
  if (zs.test(i)) {
    let s = e.md.normalizeLink(`mailto:${i}`);
    if (!e.md.validateLink(s)) return !1;
    if (!t) {
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
function Vs(e) {
  return /^<a[>\s]/i.test(e);
}
function Ks(e) {
  return /^<\/a\s*>/i.test(e);
}
function Er(e) {
  let t = e | 32;
  return t >= 97 && t <= 122;
}
function Js(e, t) {
  let n = e.src, r, o;
  if (n.startsWith("<!--", t)) {
    if (n.startsWith(">", t + 4)) return t + 5;
    if (n.startsWith("->", t + 4)) return t + 6;
    r = t + 4, o = "-->";
  } else if (n.startsWith("<![CDATA[", t))
    r = t + 9, o = "]]>";
  else if (n.charCodeAt(t + 1) === 63)
    r = t + 2, o = "?>";
  else if (Er(n.charCodeAt(t + 2)))
    r = t + 3, o = ">";
  else return -1;
  if (e.skipHtmlSpecial) return -1;
  let i = n.indexOf(o, r);
  return i < 0 ? (e.skipHtmlSpecial = !0, -1) : i + o.length;
}
function Ys(e, t) {
  if (!e.md.options.html) return !1;
  let n = e.posMax, r = e.pos;
  if (e.src.charCodeAt(r) !== 60 || r + 2 >= n) return !1;
  let o, i = e.src.charCodeAt(r + 1);
  if (i === 33 || i === 63) o = Js(e, r);
  else if (i === 47 || Er(i)) {
    let s = e.src.slice(r).match(xr);
    o = s ? r + s[0].length : -1;
  } else return !1;
  if (o < 0) return !1;
  if (!t) {
    let s = e.push("html_inline", "", 0);
    s.content = e.src.slice(r, o), Vs(s.content) && e.linkLevel++, Ks(s.content) && e.linkLevel--;
  }
  return e.pos = o, !0;
}
var Xs = /^&#((?:x[a-f0-9]{1,6}|[0-9]{1,7}));/i, Zs = /^&([a-z][a-z0-9]{1,31});/i;
function Qs(e, t) {
  let n = e.pos, r = e.posMax;
  if (e.src.charCodeAt(n) !== 38 || n + 1 >= r) return !1;
  if (e.src.charCodeAt(n + 1) === 35) {
    let o = e.src.slice(n).match(Xs);
    if (o) {
      if (!t) {
        let i = o[1][0].toLowerCase() === "x" ? parseInt(o[1].slice(1), 16) : parseInt(o[1], 10), s = e.push("text_special", "", 0);
        s.content = Rt(i) ? Ce(i) : Ce(65533), s.markup = o[0], s.info = "entity";
      }
      return e.pos += o[0].length, !0;
    }
  } else {
    let o = e.src.slice(n).match(Zs);
    if (o) {
      let i = Le(o[0]);
      if (i !== o[0]) {
        if (!t) {
          let s = e.push("text_special", "", 0);
          s.content = i, s.markup = o[0], s.info = "entity";
        }
        return e.pos += o[0].length, !0;
      }
    }
  }
  return !1;
}
function cr(e) {
  let t = {}, n = e.length;
  if (!n) return;
  let r = 0, o = -2, i = [];
  for (let s = 0; s < n; s++) {
    let a = e[s];
    if (i.push(0), (e[r].marker !== a.marker || o !== a.token - 1) && (r = s), o = a.token, a.length = a.length || 0, !a.close) continue;
    t.hasOwnProperty(a.marker) || (t[a.marker] = [
      -1,
      -1,
      -1,
      -1,
      -1,
      -1
    ]);
    let u = t[a.marker][(a.open ? 3 : 0) + a.length % 3], d = r - i[r] - 1, f = d;
    for (; d > u; d -= i[d] + 1) {
      let g = e[d];
      if (g.marker === a.marker && g.open && g.end < 0) {
        let y = !1;
        if ((g.close || a.open) && (g.length + a.length) % 3 === 0 && (g.length % 3 !== 0 || a.length % 3 !== 0) && (y = !0), !y) {
          let c = d > 0 && !e[d - 1].open ? i[d - 1] + 1 : 0;
          i[s] = s - d + c, i[d] = c, a.open = !1, g.end = s, g.close = !1, f = -1, o = -2;
          break;
        }
      }
    }
    f !== -1 && (t[a.marker][(a.open ? 3 : 0) + (a.length || 0) % 3] = f);
  }
}
function ea(e) {
  let t = e.tokens_meta, n = e.tokens_meta.length;
  cr(e.delimiters);
  for (let o = 0; o < n; o++) {
    var r;
    let i = (r = t[o]) === null || r === void 0 ? void 0 : r.delimiters;
    i && cr(i);
  }
}
function ta(e) {
  let t, n, r = 0, o = e.tokens, i = e.tokens.length;
  for (t = n = 0; t < i; t++)
    o[t].nesting < 0 && r--, o[t].level = r, o[t].nesting > 0 && r++, o[t].type === "text" && t + 1 < i && o[t + 1].type === "text" ? o[t + 1].content = o[t].content + o[t + 1].content : (t !== n && (o[n] = o[t]), n++);
  t !== n && (o.length = n);
}
var yt = [
  ["text", vs],
  ["linkify", Ps],
  ["newline", Os],
  ["escape", Ns],
  ["backticks", Ls],
  ["strikethrough", _r.tokenize],
  ["emphasis", Tr.tokenize],
  ["link", Hs],
  ["image", qs],
  ["autolink", $s],
  ["html_inline", Ys],
  ["entity", Qs]
], bt = [
  ["balance_pairs", ea],
  ["strikethrough", _r.postProcess],
  ["emphasis", Tr.postProcess],
  ["fragments_join", ta]
], Ir = class {
  constructor() {
    k(
      this,
      /**
      * {@link Ruler} instance. Keep configuration of inline rules.
      */
      "ruler",
      new Ie()
    ), k(
      this,
      /**
      * {@link Ruler} instance. Second ruler used for post-processing
      * (e.g. in emphasis-like rules).
      */
      "ruler2",
      new Ie()
    ), k(this, "State", kr);
    for (let e = 0; e < yt.length; e++) this.ruler.push(yt[e][0], yt[e][1]);
    for (let e = 0; e < bt.length; e++) this.ruler2.push(bt[e][0], bt[e][1]);
  }
  skipToken(e) {
    let t = e.pos, n = this.ruler.getRules(""), r = n.length, o = e.md.options.maxNesting, i = e.cache;
    if (typeof i[t] < "u") {
      e.pos = i[t];
      return;
    }
    let s = !1;
    if (e.level < o) {
      for (let a = 0; a < r; a++)
        if (e.level++, s = n[a](e, !0), e.level--, s) {
          if (t >= e.pos) throw new Error("inline rule didn't increment state.pos");
          break;
        }
    } else e.pos = e.posMax;
    s || e.pos++, i[t] = e.pos;
  }
  tokenize(e) {
    let t = this.ruler.getRules(""), n = t.length, r = e.posMax, o = e.md.options.maxNesting;
    for (; e.pos < r; ) {
      let i = e.pos, s = !1;
      if (e.level < o) {
        for (let a = 0; a < n; a++)
          if (s = t[a](e, !1), s) {
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
  parse(e, t, n, r) {
    let o = new this.State(e, t, n, r);
    this.tokenize(o);
    let i = this.ruler2.getRules(""), s = i.length;
    for (let a = 0; a < s; a++) i[a](o);
  }
}, na = {
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
}, ra = /^(vbscript|javascript|file|data):/, oa = /^data:image\/(gif|png|jpeg|webp);/, lr = [
  "http:",
  "https:",
  "mailto:"
], J = class {
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
    let t = e.trim().toLowerCase();
    return ra.test(t) ? oa.test(t) : !0;
  }
  /**
  * Function used to encode link url to a machine-readable format,
  * which includes url-encoding, punycode, etc.
  */
  normalizeLink(e) {
    let t = we(e, !0);
    if (t.hostname && (!t.protocol || lr.indexOf(t.protocol) >= 0))
      try {
        t.hostname = wt.default.toASCII(t.hostname);
      } catch {
      }
    return t.auth && (t.auth = Y(t.auth)), t.hostname && (t.hostname = Y(t.hostname)), t.pathname && (t.pathname = Y(t.pathname)), t.search && (t.search = Y(t.search)), t.hash && (t.hash = Y(t.hash)), de(t);
  }
  /**
  * Function used to decode link url to a human-readable format`
  */
  normalizeLinkText(e) {
    let t = we(e, !0);
    if (t.hostname && (!t.protocol || lr.indexOf(t.protocol) >= 0))
      try {
        t.hostname = wt.default.toUnicode(t.hostname);
      } catch {
      }
    return be(de(t), be.defaultChars + "%");
  }
  constructor(...e) {
    k(
      this,
      /**
      * Instance of {@link ParserInline}. You may need it to add new rules when
      * writing plugins. For simple rules control use {@link MarkdownIt.disable}
      * and {@link MarkdownIt.enable}.
      */
      "inline",
      new Ir()
    ), k(
      this,
      /**
      * Instance of {@link ParserBlock}. You may need it to add new rules when
      * writing plugins. For simple rules control use {@link MarkdownIt.disable}
      * and {@link MarkdownIt.enable}.
      */
      "block",
      new Cr()
    ), k(
      this,
      /**
      * Instance of {@link ParserCore} chain executor. You may need it to add new
      * rules when writing plugins. For simple rules control use
      * {@link MarkdownIt.disable} and {@link MarkdownIt.enable}.
      */
      "core",
      new yr()
    ), k(
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
      new hr()
    ), k(
      this,
      /**
      * [linkify-it](https://github.com/markdown-it/linkify-it) instance.
      * Used by [linkify](https://github.com/markdown-it/markdown-it/blob/master/src/rules_core/linkify.ts)
      * rule.
      */
      "linkify",
      new qn()
    ), k(
      this,
      /**
      * Assorted utility functions, useful to write plugins. See details
      * [here](https://github.com/markdown-it/markdown-it/blob/master/src/common/utils.ts).
      */
      "utils",
      Ei
    ), k(
      this,
      /**
      * Link components parser functions, useful to write plugins. See details
      * [here](https://github.com/markdown-it/markdown-it/blob/master/src/helpers).
      */
      "helpers",
      Object.assign({}, Hi)
    );
    let [t, n] = e;
    typeof t == "string" ? (this.configure(t), n && this.set(n)) : (this.configure("default"), this.set(t || {}));
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
    let t;
    if (typeof e == "string") {
      let o = e;
      if (t = na[o], !t) throw new Error(`Wrong 'markdown-it' preset "${o}", check name`);
    } else t = e;
    if (!t) throw new Error("Wrong `markdown-it` preset, can't be empty");
    t.options && (this.options = { ...t.options });
    let n = t.components;
    if (n) {
      var r;
      [
        "core",
        "block",
        "inline"
      ].forEach((i) => {
        var s;
        let a = (s = n[i]) === null || s === void 0 ? void 0 : s.rules;
        a && this[i].ruler.enableOnly(a);
      });
      let o = (r = n.inline) === null || r === void 0 ? void 0 : r.rules2;
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
  enable(e, t = !1) {
    let n = [];
    Array.isArray(e) || (e = [e]), [
      "core",
      "block",
      "inline"
    ].forEach((o) => {
      n = n.concat(this[o].ruler.enable(e, !0));
    }), n = n.concat(this.inline.ruler2.enable(e, !0));
    let r = e.filter((o) => n.indexOf(o) < 0);
    if (r.length && !t) throw new Error(`MarkdownIt. Failed to enable unknown rule(s): ${r}`);
    return this;
  }
  /**
  * The same as {@link MarkdownIt.enable}, but turn specified rules off.
  */
  disable(e, t = !1) {
    let n = [];
    Array.isArray(e) || (e = [e]), [
      "core",
      "block",
      "inline"
    ].forEach((o) => {
      n = n.concat(this[o].ruler.disable(e, !0));
    }), n = n.concat(this.inline.ruler2.disable(e, !0));
    let r = e.filter((o) => n.indexOf(o) < 0);
    if (r.length && !t) throw new Error(`MarkdownIt. Failed to disable unknown rule(s): ${r}`);
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
  use(e, ...t) {
    return e.apply(e, [this, ...t]), this;
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
  parse(e, t) {
    if (typeof e != "string") throw new Error("Input data should be a String");
    let n = new this.core.State(e, this, t);
    return this.core.process(n), n.tokens;
  }
  /**
  * Render markdown string into html. It does all magic for you :).
  *
  * `env` can be used to inject additional metadata (`{}` by default).
  * But you will not need it with high probability. See also comment
  * in {@link MarkdownIt.parse}.
  */
  render(e, t = {}) {
    return this.renderer.render(this.parse(e, t), this.options, t);
  }
  /**
  * The same as {@link MarkdownIt.parse} but skip all block rules. It returns
  * the block tokens list with the single `inline` element, containing parsed
  * inline tokens in `children` property. Also updates `env` object.
  */
  parseInline(e, t) {
    let n = new this.core.State(e, this, t);
    return n.inlineMode = !0, this.core.process(n), n.tokens;
  }
  /**
  * Similar to {@link MarkdownIt.render} but for single paragraph content.
  * Result will NOT be wrapped into `<p>` tags.
  */
  renderInline(e, t = {}) {
    return this.renderer.render(this.parseInline(e, t), this.options, t);
  }
};
k(J, "Token", ie);
k(J, "Ruler", Ie);
k(J, "Renderer", hr);
k(J, "ParserCore", yr);
k(J, "StateCore", gr);
k(J, "ParserBlock", Cr);
k(J, "StateBlock", br);
k(J, "ParserInline", Ir);
k(J, "StateInline", kr);
var ia = dr(J);

// openclaw/packages/net-policy/src/ip.ts
H();
var vr = It(Ar(), 1);
var xp = [vr.default.IPv4.parse("198.18.0.0"), 15];

// openclaw/src/utils/directive-tags-batch.ts
H();

// openclaw/packages/tool-call-repair/src/grammar.ts
var Tp = new TextEncoder();

// openclaw/src/shared/clawhub-recommendations.ts
D();
var Mr = [
  "type",
  "id",
  "name",
  "description",
  "iconUrl",
  "installed",
  "official",
  "kind"
], gf = /* @__PURE__ */ new Set([...Mr, "pluginId"]), mf = /* @__PURE__ */ new Set([...Mr, "registry", "skillRef"]);

// openclaw/src/shared/plugin-inline-view.ts
D();
var wf = 16 * 1024;

// openclaw/ui/src/lib/chat/message-normalizer-attachments.ts
ne();
D();

// openclaw/ui/src/lib/chat/sender-label.ts
D();
H();

// openclaw/ui/src/lib/chat/message-normalizer.ts
function Ct(e) {
  return ve(F(e)?.role);
}

// openclaw/ui/src/lib/chat/tool-call-diff.ts
D();
function Dr(e) {
  let t = ee(e), n = t?.added, r = t?.removed;
  return typeof n == "number" && Number.isInteger(n) && n >= 0 && typeof r == "number" && Number.isInteger(r) && r >= 0 ? { added: n, removed: r } : void 0;
}

// openclaw/ui/src/lib/chat/tool-call-grouping.ts
D();

// openclaw/src/agents/agent-activity-presentation.ts
D();
H();

// openclaw/src/session-cards/progress-card-input.ts
D();

// openclaw/src/agents/agent-activity-presentation.ts
function se(e, t) {
  return t.map((n) => [n, e]);
}
var Th = new Map([
  // A launched subagent is a worker, not one more operation of the launcher.
  ...se("subagents", ["sessions_spawn"]),
  ...se("commands", ["exec", "bash", "shell", "run_command", "run_terminal_cmd"]),
  ...se("reads", ["read", "read_file", "readfile", "notebookread", "notebook_read"]),
  ...se("edits", [
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
  ...se("writes", ["write", "write_file", "create_file"]),
  ...se("searches", [
    "grep",
    "glob",
    "find",
    "ls",
    "list",
    "codebase_search",
    "web_search"
  ]),
  ...se("fetches", ["web_fetch", "webfetch", "fetch"])
]);

// openclaw/ui/src/lib/chat/tool-call-grouping.ts
Lr();

// openclaw/ui/src/i18n/locales/en-chat-tool-labels.ts
kt();
var Ur = {
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
}, Br = Object.assign(
  () => {
    let { activity: e, review: t, verbs: n, ...r } = Ur.chat.toolCards;
    Object.assign(fe.chat.toolCards, r), Object.assign(fe.chat.toolCards.activity, e), Object.assign(fe.chat.toolCards.review, t), Object.assign(fe.chat.toolCards.verbs, n);
  },
  { catalog: Ur }
);

// openclaw/ui/src/lib/protocol-validators.generated/activity.js
function ae(e) {
  let t = 0, n = 0, r = 0;
  for (; n < e.length; ) {
    let o = e.charCodeAt(n++) >> 10;
    t += +((r << 8 | o) !== 13879), r = o;
  }
  return t;
}
var qr = [
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
], ca = (e) => la(e), la = (e) => typeof e == "object" && e !== null && !Array.isArray(e) && "itemId" in e && "phase" in e && "kind" in e && "title" in e && Object.getOwnPropertyNames(e).every(
  (t, n) => qr[0].test(t) || zr(e[t])
) && (e.delegation === void 0 || !("delegation" in e) || ua(e.delegation)) && Ra(e.itemId) && xa(e.phase) && Gr(e.kind) && Gr(e.title) && (e.status === void 0 || !("status" in e) || Ta(e.status)) && (e.name === void 0 || !("name" in e) || Q(e.name)) && (e.meta === void 0 || !("meta" in e) || Q(e.meta)) && (e.commandBearing === void 0 || !("commandBearing" in e) || ze(e.commandBearing)) && (e.toolCallId === void 0 || !("toolCallId" in e) || Q(e.toolCallId)) && (e.unpairedCall === void 0 || !("unpairedCall" in e) || ze(e.unpairedCall)) && (e.startedAt === void 0 || !("startedAt" in e) || Hr(e.startedAt)) && (e.endedAt === void 0 || !("endedAt" in e) || Hr(e.endedAt)) && (e.error === void 0 || !("error" in e) || Q(e.error)) && (e.summary === void 0 || !("summary" in e) || Q(e.summary)) && (e.progressText === void 0 || !("progressText" in e) || Q(e.progressText)) && (e.suppressChannelProgress === void 0 || !("suppressChannelProgress" in e) || ze(e.suppressChannelProgress)) && (e.hideFromChannelProgress === void 0 || !("hideFromChannelProgress" in e) || ze(e.hideFromChannelProgress)) && (e.approvalId === void 0 || !("approvalId" in e) || Q(e.approvalId)) && (e.approvalSlug === void 0 || !("approvalSlug" in e) || Q(e.approvalSlug)), zr = (e) => !1, ua = (e) => Array.isArray(e) && e.every((t, n) => da(t)) && e.length <= 32, da = (e) => typeof e == "object" && e !== null && !Array.isArray(e) && "runId" in e && "childSessionKey" in e && "status" in e && Object.getOwnPropertyNames(e).every(
  (t, n) => qr[1].test(t) || zr(e[t])
) && pa(e.runId) && fa(e.childSessionKey) && (e.label === void 0 || !("label" in e) || jr(e.label)) && (e.groupId === void 0 || !("groupId" in e) || jr(e.groupId)) && (e.runtimeMs === void 0 || !("runtimeMs" in e) || ha(e.runtimeMs)) && ga(e.status), pa = (e) => typeof e == "string" && (e.length >= 2 || e.length >= 1 && ae(e) >= 1) && (e.length <= 256 || e.length <= 512 && ae(e) <= 256), fa = (e) => typeof e == "string" && (e.length >= 2 || e.length >= 1 && ae(e) >= 1) && (e.length <= 1024 || e.length <= 2048 && ae(e) <= 1024), jr = (e) => typeof e == "string" && (e.length >= 2 || e.length >= 1 && ae(e) >= 1) && (e.length <= 512 || e.length <= 1024 && ae(e) <= 512), ha = (e) => Number.isFinite(e) && e >= 0 && e <= 9007199254740991, ga = (e) => ma(e) || ya(e) || Wr(e) || ba(e) || wa(e), ma = (e) => typeof e == "string" && e === "accepted", ya = (e) => typeof e == "string" && e === "done", Wr = (e) => typeof e == "string" && e === "failed", ba = (e) => typeof e == "string" && e === "killed", wa = (e) => typeof e == "string" && e === "timeout", Ra = (e) => typeof e == "string" && (e.length >= 2 || e.length >= 1 && ae(e) >= 1), xa = (e) => Ca(e) || ka(e) || _a(e), Ca = (e) => typeof e == "string" && e === "start", ka = (e) => typeof e == "string" && e === "update", _a = (e) => typeof e == "string" && e === "end", Gr = (e) => typeof e == "string", Ta = (e) => Ea(e) || Ia(e) || Wr(e) || Sa(e) || Aa(e), Ea = (e) => typeof e == "string" && e === "running", Ia = (e) => typeof e == "string" && e === "completed", Sa = (e) => typeof e == "string" && e === "blocked", Aa = (e) => typeof e == "string" && e === "skipped", Q = (e) => typeof e == "string", ze = (e) => typeof e == "boolean", Hr = (e) => Number.isFinite(e);
var $r = (e) => ca(e);

// openclaw/ui/src/lib/chat/tool-call-grouping.ts
Br();
function Vr(e) {
  let t = F(e)?.activity;
  return Array.isArray(t) ? t.filter($r) : [];
}

// openclaw/ui/src/lib/chat/tool-cards.ts
function va(e) {
  return M(e.messageId) ?? M(L(e.__openclaw)?.id);
}
function Kr(e) {
  let t = L(L(e)?.__openclaw), n = L(t?.toolOutput);
  return (n?.source === "provider-response" || n?.source === "execution") && n.modelInput === "unverified" ? {
    source: n.source,
    modelInput: n.modelInput,
    ...n.outcome === "unknown" ? { outcome: "unknown" } : {},
    ...n.captureTruncated === !0 ? { captureTruncated: !0 } : {}
  } : void 0;
}
function Ma(e) {
  return Array.isArray(e) ? e.filter((t) => ee(t) !== null) : [];
}
function Da(e) {
  if (typeof e != "string")
    return e;
  let t = e.trim();
  return t.startsWith("{") || t.startsWith("[") ? Qe(t) ?? e : e;
}
function Pa(e) {
  if (typeof e.text == "string")
    return e.text;
  if (typeof e.content == "string")
    return e.content;
  if (Array.isArray(e.content)) {
    let t = e.content.flatMap((n) => {
      let r = ee(n)?.text;
      return typeof r == "string" ? [r] : [];
    });
    if (t.length > 0)
      return t.join(`
`);
  }
}
function Oa(...e) {
  for (let t of e) {
    let n = ee(t), r = n?.exitCode ?? n?.exit_code;
    if (typeof r == "number" && Number.isInteger(r))
      return r;
  }
}
function Qr(e) {
  if (e.activity)
    return e.activity.status === "skipped";
  let t = ee(e.details);
  return (e.live !== !0 || e.completed === !0) && t?.status === "skipped" && t.deniedReason === "steering";
}
function Jr(e) {
  if (Qr(e))
    return !1;
  if (e.activity)
    return e.activity.status === "failed";
  let t = e.live !== !0 || e.completed === !0;
  return e.isError ?? (t && mn(e.outputText));
}
function eo(e, t) {
  if (Qr(e))
    return "skipped";
  if (e.toolOutput?.outcome === "unknown")
    return Jr(e) ? "failed" : "unknown";
  if (e.activity?.unpairedCall)
    return t === !0 && e.live === !0 && e.completed !== !0 ? "running" : "unrecorded";
  if (e.activity) {
    let { status: n, phase: r } = e.activity;
    return n === "failed" || n === "blocked" ? n : n === "completed" ? "succeeded" : t === !0 && e.live === !0 && (n === "running" || r !== "end" && e.completed !== !0) ? "running" : "unknown";
  }
  return Jr(e) ? "failed" : t === !0 && e.live === !0 && e.completed !== !0 ? "running" : e.completed === !0 || e.live !== !0 && e.outputText !== void 0 ? "succeeded" : "unrecorded";
}
function Na(e) {
  let t = fn(e);
  return t?.surface === "assistant_message" ? { ...t, surface: "assistant_message" } : void 0;
}
function Fa(e, t, n) {
  let r = pn(e), o = r?.surface === "assistant_message" ? { ...r, surface: "assistant_message" } : Na(t);
  if (o)
    return { preview: { ...o, surface: "assistant_message" } };
  let i = L(L(e)?.browserTab), s = St(i);
  if (n !== "browser" || !i || !s)
    return {};
  let a = typeof i.url == "string" ? ce(i.url, 2048) : "";
  return {
    browserTab: s,
    preview: sn(a) ? {
      kind: "browser-tab",
      ...s,
      url: a,
      ...typeof i.title == "string" ? { title: ce(i.title, 512) } : {}
    } : void 0
  };
}
function Yr(e, t) {
  return gn(e) ?? G(e.callId) ?? G(t.toolCallId) ?? G(t.tool_call_id) ?? G(t.toolUseId) ?? G(t.tool_use_id);
}
function _t(e, t) {
  return G(e.name) ?? G(t.toolName) ?? G(t.tool_name) ?? "tool";
}
function La(e) {
  if (e != null)
    return typeof e == "string" ? e : JSON.stringify(e, null, 2);
}
var Ua = 0;
function Ba(e) {
  return et(e.type) || typeof e.name == "string" && (e.arguments != null || e.args != null || e.input != null);
}
function Xr(e) {
  let t = e, n = L(t.__openclaw), r = n?.catalogSource === !0, o = typeof t.role == "string" ? t.role.toLowerCase() : "", i = Ct(e) || o === "tool" || o === "function" || typeof t.toolName == "string" || typeof t.tool_name == "string", s = Ma(t.content), a = Me(t), u = t.__openclawToolStreamLive === !0, d = Dr(t.__openclawToolStreamDiffStat), f = [], g = /* @__PURE__ */ new WeakSet(), y = va(t), c = Xe(t)?.runId ?? M(t.runId), l = (m, h, w = !1) => {
    let R = Pa(m), C = m.details ?? t.details, x = L(m.__openclaw), _ = Me(m) ?? a ?? (r ? !1 : void 0), A = Oa(
      m,
      C,
      !r && R ? re(R.trim()) : void 0,
      w ? void 0 : t
    );
    return {
      outputText: R,
      ...r && x?.catalogTruncated === !0 ? { catalogTruncated: !0 } : {},
      resultMessageId: r ? void 0 : !w && x && Object.hasOwn(x, "id") ? M(x.id) : y,
      outputTruncated: (x && Object.hasOwn(x, "truncated") ? x : L(t.__openclaw))?.truncated === !0,
      toolOutput: Kr(m) ?? Kr(t),
      ...C !== void 0 ? { details: C } : {},
      ..._ !== void 0 ? { isError: _ } : {},
      ...A !== void 0 ? { exitCode: A } : {},
      ...r ? {} : Fa(C, R, h)
    };
  };
  for (let m = 0; m < s.length; m++) {
    let h = s[m] ?? {}, w = Ba(h);
    if (!w && !ve(h.type))
      continue;
    let R = M(h.runId) ?? c, C = M(h.parentToolCallId), x = Yr(h, t), _ = _t(h, t), A = {
      id: x ?? `${_}:${m}`,
      ...x ? { callId: x } : {},
      ...R ? { runId: R } : {},
      ...C ? { parentToolCallId: C } : {},
      name: _,
      messageId: y
    }, T = h.details ?? t.details;
    if (w) {
      let N = Da(h.arguments ?? h.args ?? h.input);
      f.push({
        ...A,
        args: N,
        inputText: La(N),
        ...T !== void 0 ? { details: T } : {},
        ...u ? {
          live: !0,
          completed: t.__openclawToolStreamResultReceived === !0 || t.__openclawToolStreamItemEnded === !0
        } : {},
        ...d ? { liveDiffStat: d } : {}
      });
      continue;
    }
    let v = f.find((N) => N.id === A.id) ?? f.find(
      (N) => (
        // Same-name fallback belongs to legacy blocks missing an explicit identity.
        (!x || !N.callId) && N.name === _ && N.outputText === void 0 && !g.has(N)
      )
    ), I = i ? _t({}, t) : void 0, P = I && I !== "browser" ? I : v?.name ?? I ?? _, B = l(h, P);
    if (v) {
      g.add(v), v.callId ??= x, v.runId ??= R, v.parentToolCallId ??= C, u || (v.completed = !0), Object.assign(v, B, {
        preview: B.preview,
        browserTab: B.browserTab
      });
      continue;
    }
    f.push({
      ...A,
      completed: !0,
      ...B
    });
  }
  if (i && f.length === 0) {
    let m = typeof t.toolName == "string" && t.toolName || typeof t.tool_name == "string" && t.tool_name || "tool", h = Yr({}, t);
    f.push({
      id: h ?? `${_t({}, t)}:0`,
      ...h ? { callId: h } : {},
      ...c ? { runId: c } : {},
      name: m,
      completed: Ct(e) || o === "tool" || o === "function",
      messageId: y,
      ...l(t, m, !0)
    });
  }
  let b = new Map(
    Vr(e).filter((m) => !m.suppressChannelProgress).map((m) => [m.toolCallId ?? m.itemId, m])
  ), p;
  for (let [m, h] of f.entries()) {
    r && n?.catalogTruncated === !0 && (h.catalogTruncated = !0);
    let w = h.callId ? b.get(h.callId) : void 0;
    w && (h.activity = w), !(!h.browserTab || h.callId || h.messageId) && (p ??= ++Ua, h.previewRevision = `${p}:${m}`);
  }
  return f;
}
var Zr = /* @__PURE__ */ new WeakMap();
function to(e) {
  if (!e || typeof e != "object")
    return Xr(e);
  let t = Zr.get(e);
  if (t)
    return t;
  let n = Xr(e);
  return Zr.set(e, n), n;
}

// openclaw/ui/src/lib/chat/browser-tab-preview.ts
function ja(e) {
  return e.callId ?? e.messageId ?? e.previewRevision;
}
var no = /* @__PURE__ */ new WeakMap();
function ro(e, t) {
  let n = no.get(e);
  if (n?.toolMessages === t)
    return n.latest;
  let r = /* @__PURE__ */ new Map();
  for (let o of [e, t])
    for (let i of o)
      if ($(i))
        for (let s of to(i)) {
          let a = ja(s);
          if (s.browserTab && a && eo(s, !1) === "succeeded") {
            let u = At(s.browserTab);
            r.delete(u), r.set(u, { tab: s.browserTab, revision: a });
          }
        }
  return no.set(e, { toolMessages: t, latest: r }), r;
}

// octogee/app/openclaw-browser/resources.ts
function ag(e, t) {
  return [...ro(e, []).values()].filter((r) => r.tab.target === "host" && r.tab.profile === t).at(-1) ?? null;
}
export {
  ag as latestNativeBrowserTab
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
